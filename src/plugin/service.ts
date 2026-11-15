/**
 * Economizer runtime and read/act service.
 *
 * This module owns the mutable runtime state that cannot be re-derived from disk
 * (live sessions, per-agent bindings, loop-guard instances, judge budgets) and
 * implements the {@link EconomizerApi} used by the command and the HTTP routes.
 *
 * It is deliberately free of DSH imports: the Host entry (`src/index.ts`) feeds
 * it session events and applies the mutations it asks for (tool restrictions,
 * redirects, prompt contexts). That keeps every algorithm testable without a
 * Harness and makes every Harness dependency visible in one file.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { canonicalPath, projectIdForRoot, requireAbsolute } from '../core/paths.js'
import type {
  LoopIncident,
  MetricRecord,
  Mode,
  ProjectMeta,
  StoredFact,
  UsageCounts,
  EMPTY_USAGE,
} from '../core/types.js'
import { EMPTY_USAGE as ZERO, addUsage } from '../core/types.js'
import { CONFIG_DEFAULTS, resolveConfig, type ResolvedConfig } from '../config/schema.js'
import { DEFAULT_REDACTION } from '../core/redact.js'
import { SCHEMA_VERSION, Store, type ProjectStore, type SkillsFile } from '../storage/store.js'
import { buildUsageReport, parsePriceTable, type PriceTable } from '../metrics/ledger.js'
import {
  PROTECTED_TOOLS,
  appliedDenySet,
  allowlistMatches,
  computeDenySet,
  evaluateCandidate,
  observeToolAvailability,
  observedSessions,
  recordUnusedPrompts,
  unusedPromptsFor,
  recordToolCall,
  restoreTool,
  reauditDue,
  markPruned,
  unmarkPruned,
  snapshot,
  type ToolAvailability,
} from '../toolprune/index.js'
import { MicroskillsEngine, renderStoredBlock } from '../microskills/index.js'
import { ENV_STATE_PREFIX, isEnvFactRow } from '../microskills/envfacts.js'
import { LoopGuardEngine, type LoopDecision } from '../loopguard/index.js'
import type { EnvelopeSnapshot } from '../loopguard/envelope.js'
import type { ObservedSession, TurnSummary } from '../dsh/session-observer.js'
import type { ToolCallRecord } from '../core/types.js'
import type {
  WireCompatibility,
  WireConfigField,
  WireConfigGroup,
  WireConfigType,
  WireFact,
  WireLoops,
  WireMetricPoint,
  WireMode,
  WireOverview,
  WirePruneMode,
  WireProject,
  WireProjects,
  WireSettings,
  WireSkills,
  WireStatus,
  WireTool,
  WireTools,
} from '../http/contract.js'
import type {
  ActionOutcome,
  EconomizerApi,
  LoopsActionPayload,
  ProjectScopeInput,
  SkillsActionPayload,
  ToolsActionPayload,
} from './service-api.js'

export type RedirectDelivery =
  | boolean
  | { ok: boolean; delivery?: 'steer' | 'followup-degraded' | 'failed' }

export interface Logger {
  info?(message: string): void
  warn(message: string): void
  debug?(message: string): void
}

/** The subset of the judge client the service needs. */
export interface JudgeRunner {
  call(options: {
    system: string
    userText: string
    maxTokens: number
    timeoutMs: number
    signal?: AbortSignal
    sessionRoute?: { provider?: string; model?: string }
  }): Promise<{ ok: boolean; text: string; usage: UsageCounts; provider?: string | null; model?: string | null; error?: string }>
}

export interface ServiceOptions {
  store: Store
  logger: Logger
  pluginVersion: string
  dshVersion: string | null
  compatibility: WireCompatibility
  /** Live raw config object (Cordis volatile refs); resolved on every read. */
  config(): Record<string, unknown>
  /** Persist a configuration patch through the Host config editor. */
  writeConfig?(patch: Record<string, unknown>): Promise<void>
  judge?: JudgeRunner | null
  /** Deliver a loop redirect into the agent bound to this session. */
  applyRedirect?(sessionId: string, text: string): RedirectDelivery | Promise<RedirectDelivery>
  /** Ask the Host to re-reconcile tool restrictions for a project ('' = every project). */
  onToolsChanged?(projectRoot: string): void
  revision?: number | string | null
}

interface ProjectRuntime {
  root: string
  store: ProjectStore
  block: string
  blockTokens: number
  blockIds: string[]
  lastAuditTask: number
  /** The next reconcile after a re-audit must show the full catalog once. */
  reauditPending: boolean
  /** Learned loop-guard envelope for this repository (persisted in loopguard.json). */
  envelope: EnvelopeSnapshot | null
}

const EMPTY_COUNTS: UsageCounts = { ...ZERO }

/** Upstream `fold.py::PENDING_MAX_S`: apply a pending hide after this long even if active. */
const PENDING_MAX_MS = 24 * 60 * 60 * 1000

function emptyUsage(): UsageCounts {
  return { ...EMPTY_COUNTS }
}

function isUsageEmpty(usage: UsageCounts): boolean {
  return usage.inputTokens === 0 && usage.outputTokens === 0 && usage.totalTokens === 0
}

function errorCode(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function groupOf(key: string): WireConfigGroup {
  if (key.startsWith('microskills')) return 'microskills'
  if (key.startsWith('toolprune')) return 'tools'
  if (key.startsWith('loopguard')) return 'loopguard'
  if (key.startsWith('subagents')) return 'subagents'
  if (key === 'judgeProvider' || key === 'judgeModel' || key.startsWith('maxOverhead')) return 'budget'
  if (key === 'storeEvidence' || key === 'retentionDays' || key === 'maxMetricsBytes' || key === 'debug') return 'storage'
  if (key === 'priceTable') return 'pricing'
  return 'general'
}

const ENUMS: Record<string, readonly string[]> = {
  mode: ['off', 'shadow', 'active'],
  toolpruneMode: ['disabled', 'observe', 'propose', 'automatic'],
  loopguardLevel: ['conservative', 'default', 'aggressive'],
  microskillsProfile: ['envfacts', 'distiller', 'envfacts+distiller'],
}

const ADVANCED = new Set([
  'judgeProvider',
  'judgeModel',
  'loopguardJudgeTimeoutMs',
  'loopguardNudgeMaxTokens',
  'maxMetricsBytes',
  'priceTable',
  'debug',
  'toolpruneReauditEvery',
  'retentionDays',
])

function fieldType(key: string, value: unknown): WireConfigType {
  if (key in ENUMS) return 'enum'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'array'
  return 'string'
}

function toolStatus(stat: { pruned: boolean; protected: boolean; allowlisted: boolean }): WireTool['status'] {
  if (stat.pruned) return 'hidden'
  if (stat.protected) return 'protected'
  if (stat.allowlisted) return 'allowlisted'
  return 'active'
}

function asWireMode(mode: Mode): WireMode {
  return mode
}

/** One Wait-free serial queue; catches so a failure never breaks the caller's chain. */
class Queue {
  private tail: Promise<void> = Promise.resolve()

  run(task: () => Promise<void>, logger: Logger): void {
    this.tail = this.tail
      .then(task)
      .catch((error: unknown) => {
        logger.warn(`token-economizer: background task failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  async drain(): Promise<void> {
    await this.tail
  }
}

/**
 * Runtime + API implementation.
 *
 * Reads are async because they may need the project files; the command and the
 * routes both await them. Writes are serialized per project by the store.
 */
export class EconomizerService implements EconomizerApi {
  private readonly options: ServiceOptions
  private readonly store: Store
  private readonly logger: Logger
  private readonly queue = new Queue()

  private readonly sessions = new Map<string, ObservedSession>()
  private readonly roots = new Map<string, string | null>()
  private readonly routes = new Map<string, { provider?: string; model?: string }>()
  private readonly projectRuntimes = new Map<string, ProjectRuntime>()
  private readonly guards = new Map<string, LoopGuardEngine>()
  private readonly judgeUsage = new Map<string, UsageCounts>()
  private readonly judgeTurnUsage = new Map<string, UsageCounts>()
  private readonly unobserved = new Set<string>()
  private readonly startedSessions = new Set<string>()
  private readonly judging = new Set<string>()
  private readonly decisionDirty = new Set<string>()
  private readonly pendingDecisions = new Map<string, { decision: LoopDecision; turn: number }>()
  private readonly redirectedTurns = new Map<string, number>()
  private readonly appliedIncidents = new Map<string, LoopIncident[]>()
  /** In-flight redirect deliveries; the turn boundary waits before writing incidents. */
  private readonly redirectDeliveries = new Set<Promise<void>>()
  /** Frozen knowledge block per session: DSH may re-evaluate `context.text(assembly)` per request. */
  private readonly sessionBlocks = new Map<string, string>()
  /** Sessions whose first lookup ran before the project was warm (debug log once). */
  private readonly coldLookups = new Set<string>()
  /** De-duplicate concurrent `warmProject` calls for the same root. */
  private readonly warming = new Map<string, Promise<void>>()
  private readonly inflight = new Set<Promise<unknown>>()

  constructor(options: ServiceOptions) {
    this.options = options
    this.store = options.store
    this.logger = options.logger
  }

  // ------------------------------------------------------------------ config

  config(): ResolvedConfig {
    try {
      return resolveConfig(this.options.config())
    } catch {
      return { ...CONFIG_DEFAULTS }
    }
  }

  private isOn(config = this.config()): boolean {
    return config.mode !== 'off'
  }

  private previewBlock(file: SkillsFile, config: ResolvedConfig, repoName = 'project'): { text: string; tokens: number; ids: string[] } {
    const rendered = renderStoredBlock(file.facts, config, DEFAULT_REDACTION, repoName)
    return { text: rendered.block, tokens: rendered.tokens, ids: rendered.ids }
  }

  // ---------------------------------------------------------- runtime input

  /** Register the workspace root known at agent creation, before any event arrives. */
  registerRoot(sessionId: string, root: string | null): void {
    if (sessionId) this.roots.set(sessionId, root)
  }

  /**
   * Handle `agent/created`: the ONLY event that may apply a pending automatic hide. The
   * call is idempotent, so a long-lived session cannot re-enter it. Applies the pending
   * list when the project has been quiet long enough (or the list is older than 24h),
   * otherwise leaves it for a later session. Upstream `fold.py` deliberately waits for a
   * later session so a running prompt cache is not invalidated.
   */
  async beginSession(sessionId: string, root: string | null = null): Promise<void> {
    if (!sessionId) return
    // The Host fires `agent/created` once per session. A repeated call for the same id
    // (a long-lived session, a retry) must not apply a pending hide to the running catalog.
    if (this.startedSessions.has(sessionId)) return
    const projectRoot = root ?? this.projectRootForSession(sessionId)
    if (!projectRoot) return
    const config = this.config()
    if (!this.isOn(config)) return
    const project = await this.store.project(projectRoot)
    const now = Date.now()
    let changed = false
    await project.updateTools((file) => {
      const automatic = config.toolpruneEnabled && config.toolpruneMode === 'automatic' && config.mode === 'active'
      const pending = file.autoPending
      if (pending && Array.isArray(pending.items) && pending.items.length) {
        if (!automatic) {
          file.autoPending = null
          changed = true
        } else {
          const last = Date.parse(file.lastActivityAt ?? '') || 0
          const since = Date.parse(pending.since ?? '') || now
          const quietMs = Math.max(0, config.toolpruneQuietMinutes) * 60_000
          const quiet = config.toolpruneQuietMinutes <= 0 || now - last >= quietMs
          const expired = now - since >= PENDING_MAX_MS
          if (quiet || expired) {
            for (const name of [...pending.items]) {
              if (markPruned(file, name, 'evidence')) changed = true
            }
            file.autoPending = null
            changed = true
          }
        }
      } else if (pending && !automatic) {
        file.autoPending = null
        changed = true
      }
      // Starting a session is activity; set it after the quiet check so a new session
      // does not erase the idle interval it was supposed to measure.
      file.lastActivityAt = new Date(now).toISOString()
    })
    this.startedSessions.add(sessionId)
    if (changed) this.options.onToolsChanged?.(projectRoot)
  }

  /** Remember the model route a session uses, for the optional judge. */
  setSessionRoute(sessionId: string, route: { provider?: string; model?: string } | undefined): void {
    if (!sessionId) return
    if (route && (route.provider || route.model)) this.routes.set(sessionId, route)
  }

  observe(session: ObservedSession): void {
    this.sessions.set(session.sessionId, session)
    if (!session.projectRoot) this.unobserved.add(session.sessionId)
    else this.unobserved.delete(session.sessionId)
  }

  beginTurn(session: ObservedSession, turn = 1): void {
    // A subagent inherits its root session's project; judging or redirecting it would
    // consume the root's budget and duplicate the guard. It gets no guard at all.
    if (session.isSubagent) return
    this.judgeTurnUsage.set(session.sessionId, emptyUsage())
    // A verdict from the previous turn must never leak into this one.
    this.pendingDecisions.delete(session.sessionId)
    const config = this.config()
    const projectRoot = session.projectRoot ?? this.roots.get(session.sessionId) ?? this.roots.get(session.rootSessionId) ?? null
    if (!this.isOn(config) || !config.loopguardEnabled) return
    if (!projectRoot) return
    const projectId = projectIdForRoot(projectRoot)
    const known = this.projectRuntimes.get(projectId)
    let engine = this.guards.get(session.sessionId)
    if (!engine) {
      engine = new LoopGuardEngine({
        envelopeSnapshot: known?.envelope ?? null,
        // Sessions are the stable identity available in the global session feed; the
        // agent id is not part of it (one session can outlive several agent turns).
        agentId: session.sessionId,
        sessionId: session.sessionId,
        rootSessionId: session.rootSessionId,
        projectId,
        config,
        judgeFn: this.judgeRunner(session.sessionId),
        nudgeWriterFn: this.nudgeWriter(session.sessionId),
        canJudge: () => this.canJudge(session.sessionId),
      })
      this.guards.set(session.sessionId, engine)
    }
    if (!known) {
      // Cold start: restore the repository envelope before the next decision. A failure
      // leaves the guard with the in-memory envelope only (fail-open).
      const created = engine
      void this.store
        .project(projectRoot)
        .then((project) => this.projectRuntime(project, this.config()))
        .then((runtime) => {
          if (this.guards.get(session.sessionId) === created) created.setEnvelopeSnapshot(runtime.envelope)
        })
        .catch((error: unknown) => this.logWarn('loopguard envelope load', error))
    }
    engine.onTurnStart(turn)
  }

  /**
   * Fold one tool result. The loop guard decides here, in the background, and a later tool
   * result picks the verdict up. That is the DSH equivalent of upstream's held `PostToolUse`
   * decision: the agent never waits for the paid judge inside the tool boundary.
   */
  onToolResult(session: ObservedSession, record: ToolCallRecord): void {
    if (session.isSubagent) return
    const guard = this.guards.get(session.sessionId)
    if (!guard) return
    guard.onToolCall(record)
    this.pickUpDecision(session.sessionId, guard)
    this.scheduleDecision(session.sessionId, guard)
  }

  /** Deliver a decision that was produced after an earlier tool result. */
  private pickUpDecision(sessionId: string, guard: LoopGuardEngine): void {
    const held = this.pendingDecisions.get(sessionId)
    if (!held) return
    const turn = guard.stateSnapshot().turn
    this.pendingDecisions.delete(sessionId)
    if (held.turn !== turn) return
    const decision = held.decision
    if (decision.action !== 'redirect') {
      const redirected = this.redirectedTurns.get(sessionId) === turn
      if (redirected && decision.incident.detail?.wouldAbort) {
        const incidents = this.appliedIncidents.get(sessionId) ?? []
        incidents.push({ ...decision.incident, kind: 'still-stuck', intervention: 'notice' })
        this.appliedIncidents.set(sessionId, incidents)
      }
      return
    }
    if (this.redirectedTurns.get(sessionId) === turn) return
    const config = this.config()
    if (config.mode !== 'active' || !config.loopguardIntervene || !decision.apply) return
    // Record the incident before handing the redirect to the agent. `followup` can start
    // the next turn synchronously, and that turn may finish and read `appliedIncidents`
    // before delivery settles; recording afterwards loses the incident entirely. The
    // delivery starts as `failed` and is upgraded only after steer/followup really returns.
    const incident: LoopIncident = {
      ...decision.incident,
      detail: { ...decision.incident.detail, delivery: 'failed' },
    }
    const incidents = this.appliedIncidents.get(sessionId) ?? []
    incidents.push(incident)
    this.appliedIncidents.set(sessionId, incidents)
    this.redirectedTurns.set(sessionId, turn)
    const delivery = (async () => {
      let delivered: RedirectDelivery = false
      try {
        delivered = await (this.options.applyRedirect?.(sessionId, decision.nudge ?? '') ?? false)
      } catch (error) {
        this.logWarn('loop redirect delivery', error)
        delivered = false
      }
      const ok = typeof delivered === 'boolean' ? delivered : delivered.ok
      if (!ok) {
        const remaining = incidents.filter((entry) => entry !== incident)
        if (remaining.length) this.appliedIncidents.set(sessionId, remaining)
        else this.appliedIncidents.delete(sessionId)
        if (this.redirectedTurns.get(sessionId) === turn) this.redirectedTurns.delete(sessionId)
        this.logger.info?.(`token-economizer: loop redirect delivery failed for ${sessionId}`)
        return
      }
      const mode = typeof delivered === 'boolean' ? 'followup-degraded' : (delivered.delivery ?? 'followup-degraded')
      incident.detail = { ...incident.detail, delivery: mode }
      this.logger.info?.(`token-economizer: loop redirect delivered (${mode}) for ${sessionId}`)
    })()
    const task = delivery.catch((error: unknown) => this.logWarn('loop redirect delivery', error))
    this.redirectDeliveries.add(task)
    void task.finally(() => this.redirectDeliveries.delete(task))
  }

  /** Start one detached decision per turn; the guard itself enforces its sampling gaps. */
  private scheduleDecision(sessionId: string, guard: LoopGuardEngine): void {
    if (this.pendingDecisions.has(sessionId)) return
    if (this.judging.has(sessionId)) {
      // Calls that arrived while the judge was thinking are folded into one later decision.
      this.decisionDirty.add(sessionId)
      return
    }
    const turn = guard.stateSnapshot().turn
    this.judging.add(sessionId)
    const task = guard
      .decide()
      .then((decision) => {
        const state = guard.stateSnapshot()
        if (state.turn !== turn || state.turnEnded) return
        // A plain "nothing to do" is not held: the next result may add evidence, and the
        // final decision must see the whole burst of calls, not only the first one.
        if (decision.action === 'redirect' || decision.incident.detail?.wouldAbort) {
          this.pendingDecisions.set(sessionId, { decision, turn })
        }
      })
      .catch((error: unknown) => this.logWarn('loop guard decision', error))
      .finally(() => {
        this.judging.delete(sessionId)
        if (this.decisionDirty.delete(sessionId) && !this.pendingDecisions.has(sessionId)) {
          this.scheduleDecision(sessionId, guard)
        }
      })
    this.inflight.add(task)
    void task.finally(() => this.inflight.delete(task))
  }

  onAssistantText(session: ObservedSession, text: string): void {
    this.guards.get(session.sessionId)?.onAssistantText(text)
  }

  /** Enqueue a finished turn; never throws at the caller. */
  onTurnEnd(summary: TurnSummary): void {
    const task = this.finishTurn(summary).catch((error: unknown) => this.logWarn('turn finalize', error))
    this.inflight.add(task)
    void task.finally(() => this.inflight.delete(task))
    this.queue.run(() => task.then(() => undefined), this.logger)
  }

  /** Wait for every queued turn finalize (tests, graceful shutdown). */
  async flush(): Promise<void> {
    // A detached decision can schedule its successor while we await it; drain until both
    // sets are empty so tests and graceful shutdown observe the settled state.
    while (this.inflight.size > 0 || this.redirectDeliveries.size > 0) {
      await Promise.allSettled([...this.inflight, ...this.redirectDeliveries])
      await this.queue.drain()
    }
    await this.queue.drain()
  }

  async dispose(): Promise<void> {
    // Finalize queued turns first: they read `guards` to record the learned envelope
    // and any delivered incidents. Clearing before `flush()` silently loses both, which
    // is exactly what a short-lived headless run exposes (turn end, then dispose).
    await this.flush()
    this.guards.clear()
    this.sessions.clear()
    this.startedSessions.clear()
    this.sessionBlocks.clear()
    this.coldLookups.clear()
    this.warming.clear()
  }

  private logWarn(where: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.logger.warn(`token-economizer: ${where} failed: ${message}`)
  }

  // ------------------------------------------------------------ turn finish

  private async finishTurn(summary: TurnSummary): Promise<void> {
    const config = this.config()
    if (!this.isOn(config)) return
    const session = summary.session
    if (session.isSubagent && !config.subagentsEnabled) return

    const parentRoot = this.sessions.get(session.rootSessionId)?.projectRoot ?? this.roots.get(session.rootSessionId) ?? null
    const root = session.projectRoot ?? parentRoot ?? this.roots.get(session.sessionId) ?? null
    if (!root) {
      this.unobserved.add(session.sessionId)
      return
    }
    const project = await this.store.project(root)
    const runtime = await this.projectRuntime(project, config)
    const at = summary.endedAt
    // A task is a finished session, not a turn: repeated turns share the session's index.
    const taskIndex = await project.nextTaskIndex(session.sessionId)

    // --- tool statistics -----------------------------------------------------
    const toolsFile = await project.loadTools()
    if (!session.isSubagent) {
      const descriptors: ToolAvailability[] = session.availableTools.map((tool) => ({
        name: tool.name,
        descriptionTokens: tool.descriptionTokens,
      }))
      observeToolAvailability(
        toolsFile,
        taskIndex,
        descriptors,
        [...PROTECTED_TOOLS],
        config.toolpruneAllowlist,
        session.sessionId,
      )
    }
    summary.calls.forEach((call, index) => {
      recordToolCall(toolsFile, call.name, !call.isError, index, call.at, session.sessionId)
    })
    // A prompt is a turn a human initiated. Scheduled deliveries, goal rounds,
    // injected context, and this plugin's own followup redirect are not
    // prompts; subagents are excluded separately. `undefined` keeps older
    // callers/tests user-initiated by default.
    if (!session.isSubagent && summary.userInitiated !== false) {
      recordUnusedPrompts(
        toolsFile,
        session.availableTools.map((tool) => ({ name: tool.name, descriptionTokens: tool.descriptionTokens })),
        taskIndex,
      )
    }
    toolsFile.lastActivityAt = at
    // New automatic hides are held for a later session; never applied to the turn that
    // discovered them. Existing `pruned` entries stay in force.
    if (!session.isSubagent && config.mode === 'active' && config.toolpruneEnabled && config.toolpruneMode === 'automatic') {
      const candidates = computeDenySet(toolsFile, config, { observedSessions: observedSessions(toolsFile) })
        .filter((name) => !toolsFile.pruned.includes(name))
      if (candidates.length) {
        const previous = toolsFile.autoPending
        const items = [...new Set([...(previous?.items ?? []), ...candidates])].sort((a, b) => a.localeCompare(b))
        toolsFile.autoPending = { items, since: previous?.since ?? at }
      }
    }
    await project.saveTools(toolsFile)

    // --- micro-skills -------------------------------------------------------
    let skillTokens = 0
    let skillsApplied = 0
    if (config.microskillsEnabled && !session.isSubagent) {
      const skillsFile = await project.loadSkills()
      const engine = new MicroskillsEngine()
      // Task index is one finished session. The lifecycle stays upstream-pure (it has no
      // session concept); this adapter suppresses a confirmation the session already made.
      const confirmedThisTask = new Set(
        skillsFile.facts
          .filter((row) => (row.confirms ?? []).some(([index]) => Number(index) === taskIndex))
          .map((row) => row.key),
      )
      const verdictFilter = (key: string, verdict: 'confirm' | 'contradict' | null): 'confirm' | 'contradict' | null =>
        verdict === 'confirm' && confirmedThisTask.has(key) ? null : verdict
      const result = engine.run({
        window: {
          projectId: project.meta.projectId,
          sessionId: session.sessionId,
          turn: summary.turn,
          calls: summary.calls,
          writes: summary.calls.filter((call) => isWriteCall(call)),
          failures: summary.calls.filter((call) => call.isError),
          editedFiles: editedFiles(summary.calls),
          taskIndex,
          at,
        },
        facts: skillsFile.facts,
        config,
        policy: DEFAULT_REDACTION,
        injectedIds: runtime.blockIds,
        repoName: project.meta.name,
        verdictFilter,
      })
      const injected = new Set(result.appliedFactIds)
      const retireDays = Math.max(0, config.microskillsRetireDays)
      const cutoff = Date.parse(at) - retireDays * 86_400_000
      if (retireDays > 0 && Number.isFinite(cutoff)) {
        for (const row of result.facts) {
          if (row.state !== 'ACTIVE' || row.enabled === false || isEnvFactRow(row) || injected.has(row.id)) continue
          const last = Date.parse(row.lastUsedAt ?? row.updatedAt ?? row.createdAt)
          if (Number.isFinite(last) && last < cutoff) {
            row.state = 'RETIRED'
            row.retiredAt = taskIndex
            row.updatedAt = at
          }
        }
      }
      if (!config.storeEvidence) {
        for (const row of result.facts) {
          if (isEnvFactRow(row)) continue
          row.source = { ...row.source, evidence: [] }
        }
      }
      skillsFile.facts = result.facts
      skillsFile.updatedAt = at
      skillsFile.lastBlock = result.injectedBlock
      skillsFile.lastBlockTokens = result.injectedTokens
      skillsFile.lastBlockIds = result.appliedFactIds
      await project.saveSkills(skillsFile)
      runtime.block = result.injectedBlock
      runtime.blockTokens = result.injectedTokens
      runtime.blockIds = result.appliedFactIds
      skillTokens = result.injectedTokens
      skillsApplied = result.appliedFactIds.length
      if (config.debug) {
        this.logger.info?.(`token-economizer: micro-skills ${result.appliedFactIds.length} fact(s), ${result.injectedTokens} token(s) for ${project.meta.projectId}`)
      }
    }

    // --- metrics ------------------------------------------------------------
    const base = {
      schemaVersion: SCHEMA_VERSION,
      at,
      sessionId: session.sessionId,
      rootSessionId: session.rootSessionId,
      parentSessionId: session.parentSessionId ?? undefined,
      delegationDepth: session.delegationDepth,
      isSubagent: session.isSubagent,
      projectId: project.meta.projectId,
    }
    const rows: MetricRecord[] = []
    for (const call of summary.modelCalls) {
      if (!call.usage) continue
      rows.push({
        ...base,
        kind: 'model',
        model: call.model,
        provider: call.provider,
        usage: call.usage,
      })
    }
    for (const call of summary.calls) {
      rows.push({ ...base, kind: 'tool', tool: call.name, toolOk: !call.isError })
    }
    rows.push({
      ...base,
      kind: 'turn-end',
      skillTokens,
      skillsApplied,
      toolsPruned: toolsFile.pruned.length,
    })

    // --- loop guard ---------------------------------------------------------
    const guard = this.guards.get(session.sessionId)
    if (guard && config.loopguardEnabled && !session.isSubagent) {
      // The verdict was produced by `onToolResult` and delivered when a later tool result
      // picked it up. Closing the turn only records what actually happened; it must never
      // deliver a post-turn follow-up (upstream's queued/undelivered distinction).
      guard.onTurnEnd({ stoppedNormally: true })
      const snapshot = guard.envelopeSnapshot()
      runtime.envelope = snapshot
      try {
        await project.saveLoopguard(snapshot)
      } catch (error) {
        this.logWarn('loopguard envelope save', error)
      }
      // A deferred steer/followup settles on the next macrotask. Do not write a stale
    // delivery mode (or drop a failed attempt) just because the turn ended first.
    while (this.redirectDeliveries.size > 0) {
      await Promise.allSettled([...this.redirectDeliveries])
    }
    const applied = this.appliedIncidents.get(session.sessionId) ?? []
      if (applied.length) this.appliedIncidents.delete(session.sessionId)
      for (const incident of applied) {
        try {
          await project.appendLoop(incident, config.maxMetricsBytes)
        } catch (error) {
          this.logWarn('loop incident write', error)
        }
        rows.push({
          ...base,
          kind: 'loop',
          loop: {
            kind: incident.kind,
            intervention: incident.intervention,
            judge: incident.judge,
            confidence: incident.confidence,
          },
        })
      }
      if (this.pendingDecisions.delete(session.sessionId)) {
        this.logger.debug?.(`token-economizer: undelivered loop verdict for ${session.sessionId}`)
      }
    }

    const judgeUsage = this.judgeTurnUsage.get(session.sessionId)
    if (judgeUsage && !isUsageEmpty(judgeUsage)) {
      rows.push({ ...base, kind: 'plugin', pluginUsage: judgeUsage })
    }

    try {
      await project.appendMetrics(rows, config.maxMetricsBytes)
    } catch (error) {
      this.logWarn('metrics write', error)
    }

    // --- periodic maintenance ----------------------------------------------
    if (taskIndex > 0 && taskIndex % 25 === 0) {
      project.maintenance(config.retentionDays, config.maxMetricsBytes).catch((error: unknown) => {
        this.logWarn('maintenance', error)
      })
    }

    // Periodic full-catalog re-audit: the next reconcile applies no hide, so the agent
    // sees every tool for one turn, then the existing persisted hides resume.
    if (config.toolpruneReauditEvery > 0 && reauditDue(runtime.lastAuditTask, taskIndex, config.toolpruneReauditEvery)) {
      runtime.lastAuditTask = taskIndex
      runtime.reauditPending = true
      try {
        // Persist the cadence: otherwise a restart repeats the full-catalog audit early.
        await project.updateTools((file) => {
          file.lastAuditTask = taskIndex
        })
      } catch (error) {
        this.logWarn('tool audit marker write', error)
      }
    }

    // Tool availability is intentionally not re-applied here for automatic pruning: a
    // new hide waits for a later session (upstream `denylist.apply` semantics).
  }

  private canJudge(sessionId: string): boolean {
    const config = this.config()
    if (config.mode !== 'active' || !config.loopguardIntervene || !config.loopguardJudge || !this.options.judge) return false
    if (config.maxOverheadTokensPerTurn <= 0 || config.maxOverheadTokensPerSession <= 0) return false
    const turn = this.judgeTurnUsage.get(sessionId) ?? emptyUsage()
    const session = this.judgeUsage.get(sessionId) ?? emptyUsage()
    return (
      turn.totalTokens < config.maxOverheadTokensPerTurn &&
      session.totalTokens < config.maxOverheadTokensPerSession
    )
  }

  /**
   * The paid redirect writer. It shares the judge's route, timeout and budget, and is only
   * asked for text after a confident stuck verdict (upstream `loop_judge.llm_nudge_writer`).
   */
  private nudgeWriter(
    sessionId: string,
  ): ((system: string, user: string, maxTokens: number, signal: AbortSignal) => Promise<string>) | null {
    if (!this.options.judge) return null
    return async (system, user, maxTokens, signal) => {
      const config = this.config()
      if (
        config.mode !== 'active' ||
        !config.loopguardEnabled ||
        !config.loopguardIntervene ||
        !config.loopguardJudge ||
        !this.canJudge(sessionId)
      ) {
        throw new Error('redirect writer disabled or over budget')
      }
      const runner = this.judgeRunner(sessionId)
      if (!runner) throw new Error('redirect writer has no model route')
      return runner(system, user, maxTokens, signal)
    }
  }

  private judgeRunner(sessionId: string): ((system: string, user: string, maxTokens: number, signal: AbortSignal) => Promise<string>) | null {
    const judge = this.options.judge
    if (!judge) return null
    return async (system, user, maxTokens, signal) => {
      const config = this.config()
      const result = await judge.call({
        system,
        userText: user,
        maxTokens,
        timeoutMs: config.loopguardJudgeTimeoutMs,
        signal,
        sessionRoute: this.routes.get(sessionId),
      })
      if (result.usage && !isUsageEmpty(result.usage)) {
        this.judgeUsage.set(sessionId, addUsage(this.judgeUsage.get(sessionId) ?? emptyUsage(), result.usage))
        this.judgeTurnUsage.set(sessionId, addUsage(this.judgeTurnUsage.get(sessionId) ?? emptyUsage(), result.usage))
      }
      if (!result.ok) throw new Error(result.error ?? 'judge failed')
      return result.text
    }
  }

  // --------------------------------------------------------- project helpers

  private async projectRuntime(project: ProjectStore, config: ResolvedConfig): Promise<ProjectRuntime> {
    const existing = this.projectRuntimes.get(project.meta.projectId)
    if (existing) return existing
    const skills = await project.loadSkills()
    const tools = await project.loadTools()
    const preview = this.previewBlock(skills, config, project.meta.name)
    // Render from the persisted fact rows, never from a stale cached block: a retired or
    // cleared fact must disappear even before the next finished turn rewrites the cache.
    const block = preview.text
    const envelope = await project.loadLoopguard()
    const runtime: ProjectRuntime = {
      root: project.meta.root,
      store: project,
      block,
      blockTokens: preview.tokens,
      blockIds: preview.ids,
      lastAuditTask: Number.isFinite(tools.lastAuditTask) ? tools.lastAuditTask : skills.taskIndex - 1,
      reauditPending: false,
      envelope,
    }
    this.projectRuntimes.set(project.meta.projectId, runtime)
    return runtime
  }

  private async resolve(input: ProjectScopeInput): Promise<{ project: ProjectStore; runtime: ProjectRuntime } | null> {
    const session = input.sessionId ? this.sessions.get(input.sessionId) : undefined
    let root = session?.projectRoot ?? null
    if (!root && session) {
      root =
        this.sessions.get(session.rootSessionId)?.projectRoot ??
        this.roots.get(session.rootSessionId) ??
        this.roots.get(session.sessionId) ??
        null
    }
    if (!root && input.sessionId) root = this.roots.get(input.sessionId) ?? null
    if (!root && input.cwd) {
      try {
        requireAbsolute(input.cwd)
        root = canonicalPath(input.cwd)
      } catch {
        root = null
      }
    }
    if (!root) return null
    const project = await this.store.project(root)
    const runtime = await this.projectRuntime(project, this.config())
    return { project, runtime }
  }

  /** Known project root for a session, for the Host's tool reconciliation. */
  projectRootForSession(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (session) {
      return (
        session.projectRoot ??
        this.sessions.get(session.rootSessionId)?.projectRoot ??
        this.roots.get(session.rootSessionId) ??
        this.roots.get(sessionId) ??
        null
      )
    }
    return this.roots.get(sessionId) ?? null
  }

  /**
   * Injection text for an agent ('' when disabled or nothing learned).
   *
   * The prompt contribution is a function DSH may call for every model request. Upstream
   * renders the block at session start and folds the session only after it ends, so a
   * session must keep the same text -- including the empty text -- for its whole life. The
   * first lookup freezes the project block for that session id; a later session picks up the
   * newer block.
   */
  knowledgeForSession(sessionId: string): string {
    const config = this.config()
    if (config.mode !== 'active' || !config.microskillsEnabled || !config.microskillsInject) return ''
    const root = this.projectRootForSession(sessionId)
    if (!root) return ''
    const frozen = this.sessionBlocks.get(sessionId)
    if (frozen !== undefined) {
      // A session that looked up the block before `warmProject` finished used to freeze
      // an empty string forever, even though the project block was non-empty. We no
      // longer cache that empty value (see below); this branch only diagnoses sessions
      // that were frozen by an older build or by a genuinely empty project at startup.
      const current = this.runtimeForRoot(root)
      if (frozen === '' && current && (current.block ?? '') !== '') {
        this.logger.debug?.(
          `token-economizer: session ${sessionId} froze an empty knowledge block before ${root} was warm; keeping it for prompt-cache consistency`,
        )
      }
      return frozen
    }
    const runtime = this.runtimeForRoot(root)
    if (!runtime) {
      // DSH evaluates this provider per assembly. Returning '' without caching lets the
      // next assembly pick up the block once the runtime is warm, instead of pinning the
      // session to an empty block because it raced `agent/created`'s warm-up.
      if (!this.coldLookups.has(sessionId)) {
        this.coldLookups.add(sessionId)
        this.logger.debug?.(
          `token-economizer: knowledge lookup for ${sessionId} ran before ${root} was warm; warming it now`,
        )
      }
      void this.warmProject(root).catch((error: unknown) => this.logWarn('project warm-up', error))
      return ''
    }
    // Freeze on the first lookup once the runtime exists -- including a genuinely empty
    // block. A later fold must not change this session's prompt; only a new session sees it.
    const block = runtime.block ?? ''
    this.sessionBlocks.set(sessionId, block)
    return block
  }

  /** Drop per-session prompt state when the Host disposes the agent. */
  forgetSession(sessionId: string): void {
    this.sessionBlocks.delete(sessionId)
    this.coldLookups.delete(sessionId)
  }

  private runtimeForRoot(root: string): ProjectRuntime | undefined {
    for (const runtime of this.projectRuntimes.values()) {
      if (runtime.root === root) return runtime
    }
    return undefined
  }

  /** Deny set (tool names) to apply for a session's project, already filtered by policy. */
  async denySetForSession(sessionId: string): Promise<string[]> {
    const config = this.config()
    const root = this.projectRootForSession(sessionId)
    if (!root) return []
    const project = await this.store.project(root)
    if (config.mode !== 'active' || !config.toolpruneEnabled || config.toolpruneMode !== 'automatic') {
      await this.clearPruned(project)
      return []
    }
    const runtime = await this.projectRuntime(project, config)
    const file = await project.loadTools()
    const reaudit = runtime.reauditPending === true
    runtime.reauditPending = false
    // Only hides that were applied at a session boundary are visible here. Fresh
    // evidence waits in `file.autoPending`; recomputing it mid-session would shrink the
    // catalog the running prompt cache was built against (upstream `denylist.py`).
    const deny = appliedDenySet(file)
    if (deny.length !== file.pruned.length) {
      file.pruned = deny
      await project.saveTools(file)
    }
    // A re-audit turn shows the full catalog once; the persisted hides resume on the
    // next reconcile.
    return reaudit ? [] : deny
  }

  /** Clear every persisted hide when mutations are off or not automatic. */
  private async clearPruned(project: ProjectStore): Promise<void> {
    const file = await project.loadTools()
    if (!file.pruned.length && !file.autoPending) return
    let changed = false
    for (const name of [...file.pruned]) changed = unmarkPruned(file, name) || changed
    if (file.autoPending) {
      file.autoPending = null
      changed = true
    }
    if (changed) await project.saveTools(file)
  }

  /** Load the persisted block for a project at session start. */
  async warmProject(root: string): Promise<void> {
    const running = this.warming.get(root)
    if (running) return running
    const task = (async () => {
      const project = await this.store.project(root)
      await this.projectRuntime(project, this.config())
    })()
    this.warming.set(root, task)
    try {
      await task
    } finally {
      if (this.warming.get(root) === task) this.warming.delete(root)
    }
  }

  // ------------------------------------------------------------------ reads

  async status(input: ProjectScopeInput): Promise<WireStatus> {
    const config = this.config()
    const resolved = await this.resolve(input)
    const project = resolved?.project ?? null
    const rows = project ? await project.readMetrics() : []
    const skills = project ? await project.loadSkills() : null
    const tools = project ? await project.loadTools() : null
    const loops = project ? await project.readLoops() : []
    const preview = skills ? this.previewBlock(skills, config, project?.meta.name ?? 'project') : { text: '', tokens: 0, ids: [] }
    const pruned = tools ? tools.pruned : []
    const prunedRows = tools
      ? pruned
          .map((name) => tools.tools[name])
          .filter((row): row is NonNullable<typeof row> => Boolean(row))
          .map((row) => ({ name: row.name, descriptionTokens: row.descriptionTokens }))
      : []
    const prices: PriceTable | null = parsePriceTable(config.priceTable)
    const report = buildUsageReport(rows, {
      scope: 'project',
      projectId: project?.meta.projectId ?? null,
      prices,
      prunedTools: prunedRows,
      injectedSkillTokens: preview.tokens,
    })
    const judgeRows = rows.filter((row) => row.kind === 'plugin' && row.pluginUsage)
    const judgeTokens = judgeRows.reduce((sum, row) => sum + (row.pluginUsage?.totalTokens ?? 0), 0)
    const judgeCalls = loops.filter((loop) => loop.judge !== 'not-run' && loop.judge !== 'skipped').length
    const redirects = loops.filter((loop) => loop.intervention === 'nudge').length
    const modelRequests = report.modelRequests
    const estimatedSavings = report.estimated.prunedToolTokensPerRequest * modelRequests
    const bytes = project ? await this.dirBytes(project.dir) : 0

    return {
      ok: true,
      plugin: {
        name: 'dsh-token-economizer',
        version: this.options.pluginVersion,
        dshVersion: this.options.dshVersion,
        compatibility: this.options.compatibility,
      },
      mode: asWireMode(config.mode),
      effective: {
        microskills: config.mode === 'active' && config.microskillsEnabled && config.microskillsInject,
        toolprune: config.mode === 'active' && config.toolpruneEnabled && config.toolpruneMode === 'automatic',
        loopguard: config.mode === 'active' && config.loopguardEnabled && config.loopguardIntervene,
        subagents: config.subagentsEnabled,
        judge:
          config.mode === 'active' &&
          config.loopguardEnabled &&
          config.loopguardIntervene &&
          config.loopguardJudge &&
          Boolean(this.options.judge) &&
          config.maxOverheadTokensPerTurn > 0 &&
          config.maxOverheadTokensPerSession > 0,
      },
      project: project ? { id: project.meta.projectId, root: project.meta.root } : null,
      storage: {
        root: this.store.root,
        projectDir: project?.dir ?? null,
        schemaVersion: SCHEMA_VERSION,
        bytes,
      },
      totals: {
        modelRequests,
        inputTokens: report.usage.inputTokens,
        outputTokens: report.usage.outputTokens,
        cacheReadTokens: report.usage.cacheReadTokens,
        cacheWriteTokens: report.usage.cacheWriteTokens,
        effectiveTokens: report.effectiveTokens,
        costUsd: report.costUsd,
        costUnavailableModels: report.costUnavailableModels,
        estimatedSavingsTokens: estimatedSavings,
        estimatedSavingsUsd: null,
        overheadTokens: report.pluginUsage.totalTokens || judgeTokens,
        unobservedSessions: this.unobserved.size,
      },
      mechanisms: {
        microskills: {
          injectedFacts: preview.ids.length,
          pendingCandidates: skills ? skills.facts.filter((fact) => fact.state === 'CANDIDATE').length : 0,
          tokensPerRequest: preview.tokens,
        },
        toolprune: {
          hiddenTools: pruned.length,
          savedTokensPerRequest: report.estimated.prunedToolTokensPerRequest,
        },
        loopguard: {
          incidents: loops.length,
          redirects,
          judgeCalls,
          judgeTokens,
        },
      },
      budget: {
        sessionTokens: report.pluginUsage.totalTokens || judgeTokens,
        sessionLimit: config.maxOverheadTokensPerSession,
        turnTokens: 0,
        overheadTokens: report.pluginUsage.totalTokens || judgeTokens,
      },
      notes: this.notes(config, report, Boolean(project)),
    }
  }

  async overview(input: ProjectScopeInput): Promise<WireOverview> {
    const status = await this.status(input)
    const resolved = await this.resolve(input)
    const rows = resolved ? await resolved.project.readMetrics() : []
    const loops = resolved ? await resolved.project.readLoops() : []
    const lastModelRows = rows.filter((row) => row.kind === 'model' && row.usage).slice(-20)
    const recent: WireMetricPoint[] = lastModelRows.map((row) => ({
      at: row.at,
      modelRequests: 1,
      inputTokens: row.usage?.inputTokens ?? 0,
      outputTokens: row.usage?.outputTokens ?? 0,
      effectiveTokens: null,
      costUsd: null,
      toolCalls: 0,
      toolErrors: 0,
    }))
    const sessions = new Set(rows.map((row) => row.rootSessionId))
    const subagents = rows.filter((row) => row.isSubagent)
    return {
      ok: true,
      status,
      sessions: {
        observed: sessions.size,
        subagentSessions: new Set(subagents.map((row) => row.sessionId)).size,
        attributedRoots: sessions.size,
        unobserved: this.unobserved.size,
      },
      recent,
      loops: {
        incidents: loops.length,
        lastIncidentAt: loops.length ? loops[loops.length - 1].at : null,
      },
      measurement: this.measurement(status),
    }
  }

  async skills(input: ProjectScopeInput): Promise<WireSkills> {
    const resolved = await this.resolve(input)
    const config = this.config()
    const project = resolved?.project ?? null
    const file = project ? await project.loadSkills() : null
    const facts = file?.facts ?? []
    const preview = file ? this.previewBlock(file, config, project?.meta.name ?? 'project') : { text: '', tokens: 0, ids: [] }
    const map = (fact: StoredFact): WireFact => ({
      id: fact.id,
      kind: fact.kind,
      text: fact.text,
      status: fact.state === 'ACTIVE' ? 'confirmed' : fact.state === 'CANDIDATE' ? 'candidate' : 'retired',
      confirmations: fact.confirms.length,
      sessionsSeen: new Set(fact.confirms.map((entry) => entry[0])).size,
      createdAt: fact.createdAt ?? null,
      updatedAt: fact.updatedAt ?? null,
      lastSeenAt: fact.lastUsedAt ?? fact.updatedAt ?? null,
      source: 'extractor',
      sensitive: isSensitiveText(fact.text),
    })
    return {
      ok: true,
      project: project ? { id: project.meta.projectId, root: project.meta.root } : null,
      confirmed: facts.filter((fact) => fact.state === 'ACTIVE').map(map),
      candidates: facts.filter((fact) => fact.state === 'CANDIDATE').map(map),
      retired: facts.filter((fact) => fact.state === 'RETIRED').map(map),
      meta: {
        maxFacts: config.microskillsMaxFacts,
        maxTokens: config.microskillsMaxTokens,
        retireDays: config.microskillsRetireDays,
        injectionEnabled: config.mode === 'active' && config.microskillsEnabled && config.microskillsInject,
        totalTokens: preview.tokens,
      },
    }
  }

  async tools(input: ProjectScopeInput): Promise<WireTools> {
    const resolved = await this.resolve(input)
    const config = this.config()
    const project = resolved?.project ?? null
    const file = project ? await project.loadTools() : null
    const notes: string[] = []
    const entries: WireTool[] = []
    let hiddenTokens = 0
    if (file) {
      const facts = snapshot(file, { observedSessions: observedSessions(file) })
      const rows = Object.values(file.tools).filter((row) => row && typeof row.name === 'string')
      rows.sort((a, b) => (b.calls - a.calls) || a.name.localeCompare(b.name))
      for (const row of rows) {
        const decision = evaluateCandidate(row, config, facts)
        const status = toolStatus({
          pruned: Boolean(row.pruned) || file.pruned.includes(row.name),
          protected: row.protected || PROTECTED_TOOLS.has(row.name),
          allowlisted:
            row.allowlisted ||
            allowlistMatches(row.name, config.toolpruneAllowlist) ||
            Boolean((row as { restored?: boolean }).restored),
        })
        if (status === 'hidden') hiddenTokens += row.descriptionTokens
        entries.push({
          name: row.name,
          descriptionTokens: row.descriptionTokens,
          calls: row.calls,
          sessions: row.sessions,
          errors: row.failures,
          lastUsedAt: row.lastUsedAt,
          lastAvailableAt: null,
          status,
          reason: decision.candidate ? 'candidate' : decision.reason,
          evidence: {
            sessions: row.sessionsAvailable,
            prompts: unusedPromptsFor(row),
            calls: row.calls,
            sessionsRequired: config.toolpruneMinSessions,
            promptsRequired: config.toolpruneEvidence,
            callsRequired: config.toolpruneEvidence,
            sessionsShortcut: config.toolpruneSessions,
          },
        })
      }
      if (!rows.length) notes.push('No tool statistics yet: they are recorded when a turn finishes.')
      if (config.toolpruneMode === 'observe') notes.push('Observe mode records statistics but never hides a tool.')
      if (config.toolpruneMode === 'propose') notes.push('Propose mode reports candidates without hiding them.')
      if (config.toolpruneMode === 'automatic' && config.mode !== 'active') {
        notes.push('Automatic mode only hides tools in ACTIVE mode.')
      }
      if (file.pruned.length) notes.push(`${file.pruned.length} tool(s) are currently hidden by policy.`)
      if (file.autoPending?.items?.length) {
        notes.push(
          `${file.autoPending.items.length} evidenced tool(s) will be applied on agent/created of a later session, after ${config.toolpruneQuietMinutes} min of quiet (or 24 h).`,
        )
      }
    }
    return {
      ok: true,
      project: project ? { id: project.meta.projectId, root: project.meta.root } : null,
      mode: config.toolpruneMode === 'disabled' ? 'observe' : config.toolpruneMode,
      enabled: config.toolpruneEnabled,
      entries,
      hidden: file?.pruned ?? [],
      protected: [...PROTECTED_TOOLS].sort(),
      estimatedHiddenTokens: hiddenTokens,
      lastAuditAt: null,
      notes,
    }
  }

  async loops(input: ProjectScopeInput): Promise<WireLoops> {
    const resolved = await this.resolve(input)
    const config = this.config()
    const project = resolved?.project ?? null
    const incidents = project ? await project.readLoops() : []
    const rows = project ? await project.readMetrics() : []
    const judgeTokens = rows
      .filter((row) => row.kind === 'plugin' && row.pluginUsage)
      .reduce((sum, row) => sum + (row.pluginUsage?.totalTokens ?? 0), 0)
    const judgeCalls = incidents.filter((incident) => incident.judge !== 'not-run' && incident.judge !== 'skipped').length
    const budgetExhausted = incidents.filter((incident) => {
      const reason = typeof incident.detail?.reason === 'string' ? incident.detail.reason : ''
      return reason.includes('budget')
    }).length
    return {
      ok: true,
      project: project ? { id: project.meta.projectId, root: project.meta.root } : null,
      incidents: incidents.map((incident) => ({
        id: incident.id,
        at: incident.at,
        sessionId: incident.sessionId,
        rootSessionId: incident.rootSessionId ?? incident.sessionId,
        projectId: incident.projectId ?? project?.meta.projectId ?? null,
        turn: incident.turn,
        step: incident.step,
        kind: incident.kind,
        repeats: incident.repeats,
        judge: incident.judge,
        confidence: incident.confidence,
        intervention: incident.intervention,
        nudge: incident.nudge,
        outcome: incident.outcome,
        detail: incident.detail ?? {},
      })),
      summary: {
        total: incidents.length,
        redirected: incidents.filter((incident) => incident.intervention === 'nudge').length,
        recovered: incidents.filter((incident) => incident.outcome === 'progress').length,
        judgeCalls,
        judgeTokens,
        budgetExhausted,
      },
      config: {
        enabled: config.loopguardEnabled,
        intervene: config.loopguardIntervene,
        confidence: config.loopguardConfidence,
        maxInterventions: config.loopguardMaxInterventions,
        level: config.loopguardLevel,
      },
    }
  }

  async settings(): Promise<WireSettings> {
    const config = this.config()
    const fields: WireConfigField[] = Object.keys(CONFIG_DEFAULTS).map((key) => {
      const value = (CONFIG_DEFAULTS as unknown as Record<string, unknown>)[key]
      const field: WireConfigField = {
        key,
        type: fieldType(key, value),
        group: groupOf(key),
      }
      const options = ENUMS[key]
      if (options) field.options = [...options]
      if (typeof value === 'number') {
        field.min = 0
        field.max = Number.MAX_SAFE_INTEGER
      }
      if (ADVANCED.has(key)) field.advanced = true
      return field
    })
    return {
      ok: true,
      config: config as unknown as Record<string, unknown>,
      defaults: { ...CONFIG_DEFAULTS } as unknown as Record<string, unknown>,
      fields,
      compatibility: this.options.compatibility,
      writable: Boolean(this.options.writeConfig),
      revision: this.options.revision ?? null,
      notes: [
        'Every field applies immediately; structural (non-volatile) changes would need a restart, but all fields here are volatile.',
        'Cost requires a price table; savings are estimates derived from measured text sizes.',
      ],
    }
  }

  async projects(): Promise<WireProjects> {
    const metas = await this.store.listProjects().catch(() => [] as ProjectMeta[])
    const projects: WireProject[] = []
    for (const meta of metas.slice(0, 50)) {
      let confirmed = 0
      let pending = 0
      let hidden = 0
      let lastActiveAt: string | null = meta.updatedAt ?? null
      try {
        const project = await this.store.project(meta.root)
        const skills = await project.loadSkills()
        confirmed = skills.facts.filter((fact) => fact.state === 'ACTIVE').length
        pending = skills.facts.filter((fact) => fact.state === 'CANDIDATE').length
        const tools = await project.loadTools()
        hidden = tools.pruned.length
        lastActiveAt = skills.updatedAt ?? tools.updatedAt ?? lastActiveAt
      } catch {
        /* unreadable project: list the metadata only */
      }
      projects.push({
        id: meta.projectId,
        root: meta.root,
        confirmedFacts: confirmed,
        pendingCandidates: pending,
        hiddenTools: hidden,
        lastActiveAt,
      })
    }
    return { ok: true, projects, storageRoot: this.store.root }
  }

  // ---------------------------------------------------------------- actions

  async skillsAction(payload: SkillsActionPayload, input: ProjectScopeInput): Promise<ActionOutcome<WireSkills>> {
    const resolved = await this.resolve(input)
    if (!resolved) throw errorCode('UNKNOWN_PROJECT', 'No project is bound to this session yet.')
    const project = resolved.project
    const ids = new Set((payload.ids ?? []).map((id) => id.trim()).filter(Boolean))
    if (payload.action !== 'clearCandidates' && ids.size === 0) {
      throw errorCode('BAD_REQUEST', 'This action requires at least one fact id.')
    }
    let changed = 0
    await project.updateSkills((file) => {
      const before = file.facts.length
      if (payload.action === 'clearCandidates') {
        file.facts = file.facts.filter((fact) => {
          if (fact.state === 'CANDIDATE') {
            changed += 1
            return false
          }
          return true
        })
      } else if (payload.action === 'confirm') {
        for (const fact of file.facts) {
          if (!ids.has(fact.id) || fact.state !== 'CANDIDATE') continue
          fact.state = 'ACTIVE'
          fact.enabled = true
          fact.promotedAt = file.taskIndex
          fact.updatedAt = new Date().toISOString()
          changed += 1
        }
      } else if (payload.action === 'reject' || payload.action === 'delete') {
        file.facts = file.facts.filter((fact) => !ids.has(fact.id) || ((changed += 1), false))
      }
      if (payload.action === 'reject' || payload.action === 'delete') {
        // changed was incremented in the filter above
      }
      file.updatedAt = new Date().toISOString()
      if (payload.action !== 'confirm') void before
    })
    await this.refreshBlock(project)
    this.options.onToolsChanged?.(resolved.runtime.root)
    return { changed, data: await this.skills(input) }
  }

  async toolsAction(payload: ToolsActionPayload, input: ProjectScopeInput): Promise<ActionOutcome<WireTools>> {
    if (payload.action === 'setMode') {
      const mode = payload.mode
      if (!mode) throw errorCode('BAD_REQUEST', 'setMode requires a mode.')
      await this.updateSettings({ toolpruneMode: mode })
      return { changed: 1, data: await this.tools(input) }
    }
    const resolved = await this.resolve(input)
    if (!resolved) throw errorCode('UNKNOWN_PROJECT', 'No project is bound to this session yet.')
    const project = resolved.project
    let changed = 0
    await project.updateTools((file) => {
      const pending = Array.isArray(file.autoPending?.items) ? file.autoPending.items : []
      const names = payload.action === 'restoreAll' ? [...new Set([...file.pruned, ...pending])] : payload.names ?? []
      for (const name of names) {
        if (restoreTool(file, name)) changed += 1
      }
      if (file.autoPending && names.length) {
        const keep = file.autoPending.items.filter((name) => !names.includes(name))
        file.autoPending = keep.length ? { ...file.autoPending, items: keep } : null
      }
      file.updatedAt = new Date().toISOString()
    })
    this.options.onToolsChanged?.(resolved.runtime.root)
    return { changed, data: await this.tools(input) }
  }

  async loopsAction(payload: LoopsActionPayload, input: ProjectScopeInput): Promise<ActionOutcome<WireLoops>> {
    if (payload.action !== 'clear') throw errorCode('BAD_REQUEST', 'Unknown loop action.')
    const resolved = await this.resolve(input)
    if (!resolved) throw errorCode('UNKNOWN_PROJECT', 'No project is bound to this session yet.')
    const incidents = await resolved.project.readLoops()
    await resolved.project.clearLoops()
    return { changed: incidents.length, data: await this.loops(input) }
  }

  async updateSettings(patch: Record<string, unknown>): Promise<WireSettings> {
    if (!this.options.writeConfig) throw errorCode('NOT_WRITABLE', 'Configuration cannot be written in this context.')
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw errorCode('BAD_REQUEST', 'patch must be an object.')
    }
    const validated: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in CONFIG_DEFAULTS)) throw errorCode('BAD_REQUEST', `Unknown configuration key "${key}".`)
      const expected = (CONFIG_DEFAULTS as unknown as Record<string, unknown>)[key]
      const options = ENUMS[key]
      if (options) {
        if (typeof value !== 'string' || !options.includes(value)) {
          throw errorCode('BAD_REQUEST', `${key} must be one of ${options.join(', ')}.`)
        }
      } else if (typeof expected === 'boolean') {
        if (typeof value !== 'boolean') throw errorCode('BAD_REQUEST', `${key} must be a boolean.`)
      } else if (typeof expected === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw errorCode('BAD_REQUEST', `${key} must be a finite number.`)
        }
      } else if (Array.isArray(expected)) {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
          throw errorCode('BAD_REQUEST', `${key} must be an array of strings.`)
        }
      } else if (typeof value !== 'string') {
        throw errorCode('BAD_REQUEST', `${key} must be a string.`)
      }
      validated[key] = value
    }
    await this.options.writeConfig(validated)
    if (validated.mode !== undefined && validated.mode !== 'active') {
      this.guards.clear()
      this.projectRuntimes.clear()
    }
    // Tool policy changes must take effect now, not after the next finished turn.
    if (
      validated.mode !== undefined ||
      validated.toolpruneMode !== undefined ||
      validated.toolpruneEnabled !== undefined ||
      validated.toolpruneAllowlist !== undefined
    ) {
      this.options.onToolsChanged?.('')
    }
    return this.settings()
  }

  async setMode(mode: WireMode): Promise<WireMode> {
    if (mode !== 'off' && mode !== 'shadow' && mode !== 'active') {
      throw errorCode('BAD_REQUEST', 'mode must be off, shadow, or active.')
    }
    await this.updateSettings({ mode })
    return mode
  }

  private async refreshBlock(project: ProjectStore): Promise<void> {
    const config = this.config()
    const skills = await project.loadSkills()
    const tools = await project.loadTools()
    const preview = this.previewBlock(skills, config, project.meta.name)
    const runtime = this.projectRuntimes.get(project.meta.projectId)
    if (!runtime) return
    runtime.block = preview.text
    runtime.blockTokens = preview.tokens
    runtime.blockIds = preview.ids
  }

  // ----------------------------------------------------------------- helpers

  private notes(config: ResolvedConfig, report: ReturnType<typeof buildUsageReport>, hasProject: boolean): string[] {
    const notes: string[] = []
    if (config.mode === 'shadow') {
      notes.push('Shadow mode: everything is measured, nothing is injected, hidden or redirected.')
    }
    if (config.mode === 'active' && !config.microskillsInject && !config.toolpruneEnabled) {
      notes.push('Active mode is on but no mutating mechanism is enabled.')
    }
    if (config.mode === 'active' && config.loopguardEnabled && !config.loopguardIntervene) {
      notes.push('Loop guard is observing only: loopguardIntervene is off, so no redirect is delivered and no judge call is spent.')
    }
    if (!hasProject) {
      notes.push('No workspace project is bound to this session yet; statistics appear after the first finished turn.')
    }
    if (report.costUsd === null && report.costUnavailableModels.length) {
      notes.push(`Cost unavailable: no price table entry for ${report.costUnavailableModels.join(', ')}.`)
    }
    if (this.unobserved.size) {
      notes.push(`${this.unobserved.size} session(s) had no workspace root and are not attributed to a project.`)
    }
    notes.push('Raw token counts are provider-reported. Savings are estimates computed from measured text sizes, never a measured percentage.')
    return notes
  }

  private measurement(status: WireStatus): string[] {
    const lines = [
      'Input, output and cache token counts are reported by the model provider for each request.',
      'Effective tokens use the cache-aware weights from the pinned upstream pricing table and are shown only for known models.',
    ]
    if (status.totals.costUsd === null) {
      lines.push('USD cost is unavailable because at least one observed model has no price-table entry. No price is guessed.')
    }
    lines.push(
      `Tool-definition savings are estimated at ${status.mechanisms.toolprune.savedTokensPerRequest} tokens per request across ${status.totals.modelRequests} observed request(s).`,
      'Micro-skill tokens are the measured size of the injected block; they are a cost, not a saving.',
      'Judge calls are counted as overhead and are bounded per turn and per session.',
    )
    return lines
  }

  private async dirBytes(dir: string): Promise<number> {
    try {
      const { readdir } = await import('node:fs/promises')
      const names = await readdir(dir)
      let total = 0
      for (const name of names) {
        try {
          const info = await stat(join(dir, name))
          if (info.isFile()) total += info.size
        } catch {
          /* file disappeared */
        }
      }
      return total
    } catch {
      return 0
    }
  }
}

function isSensitiveText(text: string): boolean {
  const value = String(text ?? '')
  if (!value.trim()) return true
  return /(?:api[_-]?key|secret|password|token)\s*[:=]/i.test(value) || value.includes(ENV_STATE_PREFIX)
}

function isWriteCall(call: ToolCallRecord): boolean {
  const name = call.name.toLowerCase()
  return name === 'edit' || name === 'multiedit' || name === 'write' || name === 'create' || name === 'apply_patch' || name === 'str_replace_editor'
}

function editedFiles(calls: readonly ToolCallRecord[]): string[] {
  const files = new Set<string>()
  for (const call of calls) {
    if (!isWriteCall(call)) continue
    const raw = call.args.file_path ?? call.args.path
    if (typeof raw === 'string' && raw.trim()) {
      const normalized = raw.replace(/\\/g, '/')
      files.add(normalized.slice(normalized.lastIndexOf('/') + 1))
    }
    const paths = call.args.paths
    if (Array.isArray(paths)) {
      for (const path of paths) {
        if (typeof path === 'string' && path.trim()) {
          const normalized = path.replace(/\\/g, '/')
          files.add(normalized.slice(normalized.lastIndexOf('/') + 1))
        }
      }
    }
  }
  return [...files].sort()
}
