/**
 * `LoopGuardEngine`: the per-session façade over the ported TokenEconomizer loop guard.
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit 7042ea8
 * (upstream commit 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0).
 *
 * Upstream architecture (`plugin/controller.py`):
 *   - a `TurnGuard` is reset at `user_prompt` and folded after each tool call;
 *   - `loopguard.thresholds(tracker)` learns this repository's normal turn length;
 *   - the paid judge is only wired once the repository HAS an envelope;
 *   - the plugin pins `gate_over_envelope=False` and `gate_min_turns >= min_turns`;
 *   - at most `loopguard_nudges` redirects per turn, then the abort verdict is delivered as a
 *     NOTICE -- the plugin never stops the agent.
 *
 * This engine makes the same decisions but NEVER returns a stop/abort action: `decide()` yields
 * only `none` or `redirect`. A caller in an observing mode rejects the redirect; a caller in
 * the active mode applies it. Everything here is free unless `decide()` reaches the paid judge,
 * which is optional, injected, timeout-bound and fail-open.
 *
 * HOST ADAPTATION: DSH gives structured `ToolCallRecord`s, so `onToolCall` feeds the guard
 * directly instead of replaying transcript JSONL. `onAssistantText` is recorded for adapter
 * context/reporting only -- upstream's guard deliberately never reads assistant prose, and it
 * never influences a decision here. Envelope persistence is a plain JSON snapshot held by the
 * caller, not a repository state store.
 */
import { randomUUID } from 'node:crypto'

import type { LoopIncident, ToolCallRecord } from '../core/types.js'
import {
  assessAbort,
  formatFixed0,
  gateForJudge,
  isStuck,
  nudgeText,
  type LoopLevel,
  type ThresholdOverrides,
  type Thresholds,
} from './rules.js'
import { SpiralState, type SpiralSnapshot } from './state.js'
import {
  TurnGuard,
  backstopTurnsFor,
  type TurnGuardDict,
  type TurnSummary,
} from './turn.js'
import {
  EnvelopeTracker,
  loadEnvelope,
  saveEnvelope,
  thresholds as learnedThresholds,
  type EnvelopeSnapshot,
} from './envelope.js'
import {
  JUDGE_MAX_TOKENS,
  evaluateWithJudge,
  writeRedirect,
  type JudgeVerdict,
  type LoopModelCall,
} from './judge.js'

/** The loop-guard fields of the shared `ResolvedConfig` (structural, no config import). */
export interface LoopGuardSettings {
  loopguardLevel: LoopLevel
  loopguardConfidence: number
  loopguardMaxInterventions: number
  loopguardJudgeTimeoutMs: number
  loopguardNudgeMaxTokens: number
  loopguardJudge: boolean
  loopguardIntervene: boolean
}

/**
 * Defaults mirrored from `src/config/schema.ts` (which is owned elsewhere). Repeating them
 * structurally keeps this module importable without the config stack's dependencies.
 */
export const DEFAULT_LOOPGUARD_SETTINGS: LoopGuardSettings = {
  loopguardLevel: 'default',
  loopguardConfidence: 0.7,
  loopguardMaxInterventions: 1,
  loopguardJudgeTimeoutMs: 20000,
  loopguardNudgeMaxTokens: 120,
  loopguardJudge: true,
  loopguardIntervene: false,
}

export function resolveLoopGuardSettings(
  settings?: Partial<LoopGuardSettings> | null,
): LoopGuardSettings {
  return { ...DEFAULT_LOOPGUARD_SETTINGS, ...(settings ?? {}) }
}

export interface LoopGuardEngineOptions {
  agentId: string
  sessionId: string
  /** Defaults to `sessionId` when the session is its own root. */
  rootSessionId?: string
  projectId: string
  config?: Partial<LoopGuardSettings> | null
  /** Paid stuck judge. Omit to run the free heuristic fallback only. */
  judgeFn?: LoopModelCall | null
  /** Paid redirect writer. Omit to use `rules.nudgeText`'s count template. */
  nudgeWriterFn?: LoopModelCall | null
  /** The adapter's judge budget/throttle check. Called immediately before a judge call. */
  canJudge?: (() => boolean) | null
  /** Persisted per-repository envelope (`EnvelopeSnapshot`). */
  envelopeSnapshot?: EnvelopeSnapshot | null
  /** Clock (epoch milliseconds), injectable for tests. */
  now?: () => number
  /** Output-token budget for the judge reply. */
  judgeMaxTokens?: number
  /** The run's turn cap, if known: makes the hard backstop reachable under the cap. */
  maxTurns?: number | null
}

/** The judge's role in a decision. Mirrors `LoopIncident['judge']`. */
export type LoopJudgeState = LoopIncident['judge']

/** The single decision shape the caller applies. There is deliberately no stop/abort action. */
export interface LoopDecision {
  /** `redirect` asks the caller to inject `nudge`; `none` means leave the agent alone. */
  action: 'none' | 'redirect'
  /** Stable machine-readable reason (`gate-closed`, `judge-stuck@0.71:...`, `cum-backstop:...`). */
  reason: string
  /** Bounded redirect text (bounded by `loopguardNudgeMaxTokens`); null for `none`. */
  nudge: string | null
  /** True only when this decision must actually be applied (active mode + a redirect). */
  apply: boolean
  judge: LoopJudgeState
  /** Judge confidence when a judge ran; null otherwise. */
  confidence: number | null
  /** Serializable incident record for the session log. */
  incident: LoopIncident
}

/** The free gate's state, for adapters that want to show it without paying for a decision. */
export interface LoopGuardGate {
  open: boolean
  reason: string
  turns: number
  errorOutputs: number
  repeatedFailSigs: number
  stagnation: number
  envelope: number | null
  backstopTurns: number | null
  backstopTripped: boolean
}

/** Crash-safe snapshot of one session's guard (`restoreState` accepts this). */
export interface LoopGuardSessionState {
  version: 1
  turn: number
  step: number
  seenCalls: number
  assistantTexts: number
  lastAssistantChars: number
  lastToolAt: number | null
  pending: boolean
  turnEnded: boolean
  guard: TurnGuardDict
}

export interface LoopGuardTurnEnd {
  summary: TurnSummary
  envelope: number | null
}

class LoopGuardTimeoutError extends Error {
  constructor() {
    super('loopguard-timeout')
    this.name = 'LoopGuardTimeoutError'
  }
}

function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new LoopGuardTimeoutError())
    }, Math.max(1, timeoutMs))
    run(controller.signal).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Bound a redirect without cutting a word: `loopguardNudgeMaxTokens` ~= 4 chars/token. */
export function boundNudge(text: string, maxTokens: number): string {
  const maxChars = Math.max(40, Math.floor(Math.max(1, maxTokens) * 4))
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const cut = trimmed.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace >= Math.floor(maxChars * 0.6) ? cut.slice(0, lastSpace) : cut).trim()
}

function judgeErrorReason(verdict: JudgeVerdict): boolean {
  return verdict.stuck === null && verdict.reason.startsWith('runner-error')
}

/**
 * One loop guard per agent session. All state is this instance's; the caller serializes it with
 * `stateSnapshot()`/`restoreState()` and the envelope with `envelopeSnapshot()`.
 */
export class LoopGuardEngine {
  readonly agentId: string
  readonly sessionId: string
  readonly rootSessionId: string
  readonly projectId: string
  readonly settings: LoopGuardSettings

  private readonly judgeFn: LoopModelCall | null
  private readonly nudgeWriterFn: LoopModelCall | null
  private readonly canJudgeFn: (() => boolean) | null
  private readonly nowFn: () => number
  private readonly judgeMaxTokens: number
  private readonly maxTurns: number | null

  private tracker: EnvelopeTracker
  private guard: TurnGuard
  private turn = 0
  private step = 0
  private pending = false
  private turnEnded = false
  private envelopeRecorded = false
  private seenCalls = 0
  private assistantTexts = 0
  private lastAssistantChars = 0
  private lastToolAt: number | null = null

  constructor(options: LoopGuardEngineOptions) {
    this.agentId = options.agentId
    this.sessionId = options.sessionId
    this.rootSessionId = options.rootSessionId ?? options.sessionId
    this.projectId = options.projectId
    this.settings = resolveLoopGuardSettings(options.config)
    this.judgeFn = options.judgeFn ?? null
    this.nudgeWriterFn = options.nudgeWriterFn ?? null
    this.canJudgeFn = options.canJudge ?? null
    this.nowFn = options.now ?? (() => Date.now())
    this.judgeMaxTokens = options.judgeMaxTokens ?? JUDGE_MAX_TOKENS
    this.maxTurns = options.maxTurns ?? null
    this.tracker = loadEnvelope(options.envelopeSnapshot ?? null, this.settings.loopguardLevel)
    this.guard = new TurnGuard({ turnKey: `${this.sessionId}:${this.turn}` })
  }

  /** The learned per-repository envelope, or null during cold start. */
  get envelope(): number | null {
    return this.tracker.envelope
  }

  /** The tracker, exposed read-only for adapters/reporting. */
  get envelopeTracker(): EnvelopeTracker {
    return this.tracker
  }

  /**
   * Reset the per-turn guard. Upstream also closed an unfinished turn as not-stopped-normally
   * here; such a turn feeds no envelope sample, so there is nothing else to do.
   */
  onTurnStart(turn: number, _at?: number): void {
    this.turn = turn
    this.step = 0
    this.pending = false
    this.turnEnded = false
    this.envelopeRecorded = false
    this.assistantTexts = 0
    this.lastAssistantChars = 0
    this.guard = new TurnGuard({ turnKey: `${this.sessionId}:${turn}` })
  }

  /**
   * Measure one completed tool call. `isError` is the host's outcome signal; for shell/edit
   * calls it corresponds to upstream's exit status (`1`/`0`), and for other tools it marks a
   * tool-level failure.
   */
  onToolCall(record: ToolCallRecord): void {
    if (record.turn !== this.turn) {
      // The host moved to a new turn without an explicit onTurnStart: start one here so each
      // turn owns a fresh guard. The skipped turn would have ended not-stopped-normally, which
      // feeds no envelope sample, so nothing is lost.
      this.onTurnStart(record.turn)
    }
    this.turn = record.turn
    this.step = record.step
    this.guard.observe(record.name, record.args, record.output, record.isError ? 1 : 0)
    this.pending = true
    this.seenCalls += 1
    this.lastToolAt = record.at
  }

  /**
   * Record assistant prose for reporting only. Upstream's guard never reads it; it must not
   * change any decision (leakage discipline), and it does not.
   */
  onAssistantText(text: string | null | undefined): void {
    this.assistantTexts += 1
    this.lastAssistantChars = (text ?? '').length
  }

  /** Advance the step counter; no guard decision is made at a step boundary. */
  onStepEnd(step?: number, _at?: number): void {
    if (typeof step === 'number') this.step = step
  }

  /**
   * Close the turn and feed the envelope. Upstream records a sample only for turns that ended
   * green; `resolvedProxy` already enforces that, so a not-stopped-normally turn adds nothing.
   */
  onTurnEnd(options: { stoppedNormally?: boolean; at?: number } = {}): LoopGuardTurnEnd {
    const stoppedNormally = options.stoppedNormally ?? true
    const summary = this.guard.summary(stoppedNormally)
    if (!this.envelopeRecorded && this.guard.cumTurns > 0 && stoppedNormally) {
      this.tracker.update(
        this.guard.cumTurns,
        this.guard.resolvedProxy(stoppedNormally),
        this.guard.whole.snapshot(),
      )
      this.envelopeRecorded = true
    }
    this.turnEnded = true
    this.pending = false
    return { summary, envelope: this.tracker.envelope }
  }

  /** Reset just the per-turn guard (keeps the envelope and the turn number). */
  resetTurn(): void {
    this.guard = new TurnGuard({ turnKey: `${this.sessionId}:${this.turn}` })
    this.step = 0
    this.pending = false
    this.turnEnded = false
    this.envelopeRecorded = false
  }

  /** The effective thresholds, mirroring the controller's pinned wiring. */
  effectiveThresholds(): Thresholds {
    const overrides: ThresholdOverrides = {}
    // A person's confidence setting wins over the learned/level value, but the shipped
    // default must not overwrite the aggressive/conservative presets.
    if (this.settings.loopguardConfidence !== 0.7) {
      overrides.judge_confidence = this.settings.loopguardConfidence
    }
    const thr = learnedThresholds(this.tracker, overrides)
    // plugin/controller.py pins these so the guard cannot fire on envelope overrun alone and
    // cannot run its cheap gate before the strict "stuck" duration.
    thr.gate_over_envelope = false
    thr.gate_min_turns = Math.max(thr.gate_min_turns, thr.min_turns)
    return thr
  }

  /**
   * TIER-0, free: is the recent trace worth a paid judge at all? Never calls a model.
   */
  gate(): LoopGuardGate {
    const thr = this.effectiveThresholds()
    const env = this.tracker.envelope
    const st = this.guard.st
    const trouble = gateForJudge(st, thr)
    const overEnvelope = env !== null && st.turns >= env && thr.gate_over_envelope !== false
    const backstop = backstopTurnsFor(thr, env)
    return {
      open: trouble || overEnvelope,
      reason: trouble || overEnvelope ? (trouble ? 'trouble-signs' : 'over-envelope') : 'gate-closed',
      turns: st.turns,
      errorOutputs: st.errorOutputs,
      repeatedFailSigs: st.repeatedFailSigs,
      stagnation: st.stagnation,
      envelope: env,
      backstopTurns: backstop,
      backstopTripped: backstop !== null && this.guard.cumTurns >= backstop && isStuck(st, thr),
    }
  }

  /**
   * Decide whether to redirect. Free unless it reaches the paid judge. Never throws: a judge
   * error, timeout, or missing budget is an explicit `{action: 'none'}` (fail-open).
   */
  async decide(): Promise<LoopDecision> {
    if (!this.pending) {
      return this.none('no-observation', 'not-run', null, {})
    }
    this.pending = false
    const thr = this.effectiveThresholds()
    const env = this.tracker.envelope
    const st = this.guard.st
    const detail = this.baseDetail(thr, env)

    // HARD BACKSTOP, before any paid judge (upstream `assess_abort` order).
    const backstop = backstopTurnsFor(thr, env)
    if (backstop !== null && this.guard.cumTurns >= backstop && isStuck(st, thr)) {
      const reason = `cum-backstop:${this.guard.cumTurns}>=${formatFixed0(backstop)}t`
      return this.interveneOrNone(reason, 'not-run', null, { ...detail, backstop: true })
    }

    // FREE gate before the judge.
    const gateOpen =
      gateForJudge(st, thr) || (env !== null && st.turns >= env && thr.gate_over_envelope !== false)
    if (!gateOpen) {
      return this.none('gate-closed', 'not-run', null, detail)
    }

    const judgeConfigured = this.settings.loopguardJudge && this.judgeFn !== null
    const judgeAllowedHere = judgeConfigured && env !== null
    if (judgeAllowedHere) {
      // The adapter's budget/throttle check: never call a paid judge when it says no.
      let budgetOk = true
      try {
        budgetOk = this.canJudgeFn ? this.canJudgeFn() !== false : true
      } catch {
        budgetOk = false
      }
      if (!budgetOk) {
        return this.none('judge-budget-exhausted', 'skipped', null, detail)
      }
      if (!this.guard.judgeDue()) {
        // Wired judge, but its sampling gap has not elapsed: upstream treats that as
        // "judge-throttled" and does NOT fall through to the heuristic.
        return this.none('judge-throttled', 'skipped', null, detail)
      }
      this.guard.markJudgeCalled()
      const digest = this.guard.liveDigest(st.recentDigest({ envelope: env }))
      let verdict: JudgeVerdict
      try {
        verdict = await runWithTimeout(
          (signal) =>
            evaluateWithJudge(this.judgeFn, digest, thr.judge_confidence, {
              maxTokens: this.judgeMaxTokens,
              signal,
            }),
          this.settings.loopguardJudgeTimeoutMs,
        )
      } catch (error) {
        // Fail open: a timeout or a runner failure is never a redirect.
        const reason =
          error instanceof LoopGuardTimeoutError ? 'judge-timeout' : 'judge-error'
        this.guard.applyJudgeBackoff(null)
        return this.none(reason, 'error', null, { ...detail, judgeError: String(error) })
      }

      if (judgeErrorReason(verdict)) {
        this.guard.applyJudgeBackoff(null)
        return this.none('judge-error', 'error', null, {
          ...detail,
          judgeReason: verdict.reason,
        })
      }
      if (verdict.stuck === true && verdict.confidence >= thr.judge_confidence) {
        const reason = `judge-stuck@${verdict.confidence.toFixed(2)}:${verdict.reason.slice(0, 60)}`
        return this.interveneOrNone(reason, 'stuck', verdict.confidence, {
          ...detail,
          judgeReason: verdict.reason,
        })
      }
      if (verdict.stuck === false) {
        return this.none('judge-productive', 'not-stuck', verdict.confidence, {
          ...detail,
          judgeReason: verdict.reason,
        })
      }
      if (
        thr.nudge_on_ambiguous &&
        env !== null &&
        st.turns >= env
      ) {
        return this.interveneOrNone(
          'ambiguous-past-envelope',
          'ambiguous',
          verdict.confidence,
          { ...detail, judgeReason: verdict.reason },
        )
      }
      return this.none('judge-ambiguous-spared', 'ambiguous', verdict.confidence, {
        ...detail,
        judgeReason: verdict.reason,
      })
    }

    // No judge wired (or no envelope yet): upstream's strict heuristic fallback.
    const assessment = assessAbort(st, env, null, thr)
    if (!assessment.abort) {
      return this.none(assessment.reason, 'not-run', null, detail)
    }
    return this.interveneOrNone(`envelope:${assessment.reason}`, 'not-run', null, detail)
  }

  /** The persisted envelope snapshot (`saveEnvelope`). */
  envelopeSnapshot(): EnvelopeSnapshot {
    return saveEnvelope(this.tracker)
  }

  /** Restore a previously persisted envelope snapshot. */
  setEnvelopeSnapshot(data?: EnvelopeSnapshot | null): void {
    this.tracker = loadEnvelope(data ?? null, this.settings.loopguardLevel)
  }

  /**
   * Serialize this session's guard. Envelope state is separate (`envelopeSnapshot`), matching
   * upstream's split between `TurnGuard.to_dict()` and `envelope.json`.
   */
  stateSnapshot(): LoopGuardSessionState {
    return {
      version: 1,
      turn: this.turn,
      step: this.step,
      seenCalls: this.seenCalls,
      assistantTexts: this.assistantTexts,
      lastAssistantChars: this.lastAssistantChars,
      lastToolAt: this.lastToolAt,
      pending: this.pending,
      turnEnded: this.turnEnded,
      guard: this.guard.toDict(),
    }
  }

  /**
   * Restore a session snapshot after a restart. Defensive: malformed/missing fields fall back
   * to an empty guard rather than throwing, so recovery never blocks the host.
   */
  restoreState(data: unknown): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      this.resetTurn()
      return
    }
    const record = data as Partial<LoopGuardSessionState> & Record<string, unknown>
    this.turn = finiteNumber(record.turn, 0)
    this.step = finiteNumber(record.step, 0)
    this.seenCalls = finiteNumber(record.seenCalls, 0)
    this.assistantTexts = finiteNumber(record.assistantTexts, 0)
    this.lastAssistantChars = finiteNumber(record.lastAssistantChars, 0)
    this.lastToolAt =
      typeof record.lastToolAt === 'number' && Number.isFinite(record.lastToolAt)
        ? record.lastToolAt
        : null
    this.pending = record.pending === true
    this.turnEnded = record.turnEnded === true
    this.envelopeRecorded = this.turnEnded
    const guard = record.guard
    this.guard =
      typeof guard === 'object' && guard !== null && !Array.isArray(guard)
        ? new TurnGuard({ data: guard as Partial<TurnGuardDict> })
        : new TurnGuard({ turnKey: `${this.sessionId}:${this.turn}` })
  }

  /** The current per-turn guard (read-only use; the engine owns mutation). */
  get turnGuard(): TurnGuard {
    return this.guard
  }

  // ---- decision construction ------------------------------------------------------
  private baseDetail(thr: Thresholds, envelope: number | null): LoopIncident['detail'] {
    const st = this.guard.st
    return {
      turns: st.turns,
      cumTurns: this.guard.cumTurns,
      editChurn: st.editChurn,
      distinctEditFiles: st.distinctEditFiles,
      errorOutputs: st.errorOutputs,
      repeatedFailSigs: st.repeatedFailSigs,
      stagnation: st.stagnation,
      testRuns: st.testRuns,
      minTurns: thr.min_turns,
      gateMinTurns: thr.gate_min_turns,
      judgeConfidence: thr.judge_confidence,
      maxInterventions: Math.max(0, Math.floor(this.settings.loopguardMaxInterventions)),
      nudgesDone: this.guard.nudgesDone,
      envelope,
      backstopTurns: backstopTurnsFor(thr, envelope),
    }
  }

  /** Incidents are always serializable: the session log must survive a restart. */
  private incident(
    kind: string,
    judge: LoopJudgeState,
    confidence: number | null,
    intervention: LoopIncident['intervention'],
    nudge: string | null,
    detail: LoopIncident['detail'],
  ): LoopIncident {
    return {
      id: randomUUID(),
      at: new Date(this.nowFn()).toISOString(),
      agentId: this.agentId,
      sessionId: this.sessionId,
      rootSessionId: this.rootSessionId,
      projectId: this.projectId,
      kind,
      repeats: this.guard.st.repeatedFailSigs,
      turn: this.turn,
      step: this.step,
      judge,
      confidence,
      intervention,
      nudge,
      outcome: 'unknown',
      detail,
    }
  }

  private none(
    reason: string,
    judge: LoopJudgeState,
    confidence: number | null,
    detail: LoopIncident['detail'],
    intervention: LoopIncident['intervention'] = 'none',
  ): LoopDecision {
    return {
      action: 'none',
      reason,
      nudge: null,
      apply: false,
      judge,
      confidence,
      incident: this.incident(reason.split(':')[0] ?? reason, judge, confidence, intervention, null, detail),
    }
  }

  /**
   * A redirect, subject to `loopguardMaxInterventions`. When the budget is spent the caller gets
   * `action: 'none'` with an incident marked `notice` -- upstream's abort verdict delivered as a
   * notice; it is never a stop and `apply` is always false.
   */
  private async interveneOrNone(
    reason: string,
    judge: LoopJudgeState,
    confidence: number | null,
    detail: LoopIncident['detail'],
  ): Promise<LoopDecision> {
    const budget = Math.max(0, Math.floor(this.settings.loopguardMaxInterventions))
    if (budget <= 0 || this.guard.nudgesDone >= budget) {
      return this.none(reason, judge, confidence, { ...detail, wouldAbort: true }, 'notice')
    }
    return this.redirect(reason, judge, confidence, detail)
  }

  private async redirect(
    reason: string,
    judge: LoopJudgeState,
    confidence: number | null,
    detail: LoopIncident['detail'],
  ): Promise<LoopDecision> {
    const envelope = this.tracker.envelope
    const st = this.guard.st
    let text = ''
    if (this.nudgeWriterFn && envelope !== null && judge === 'stuck') {
      const digest = this.guard.liveDigest(st.recentDigest({ envelope }))
      try {
        const written = await runWithTimeout(
          (signal) =>
            writeRedirect(this.nudgeWriterFn, digest, {
              maxTokens: this.settings.loopguardNudgeMaxTokens,
              signal,
            }),
          this.settings.loopguardJudgeTimeoutMs,
        )
        text = written.text
      } catch {
        text = ''
      }
    }
    if (!text) text = nudgeText(st)
    const nudge = boundNudge(text, this.settings.loopguardNudgeMaxTokens)

    // Record the segment verdict and open the agent's fair re-assessment window.
    this.guard.stop('nudge', reason, envelope)
    this.guard.afterNudge()

    const incident = this.incident(
      'redirect',
      judge,
      confidence,
      'nudge',
      nudge,
      { ...detail, nudgesDone: this.guard.nudgesDone },
    )
    return {
      action: 'redirect',
      reason,
      nudge,
      apply: this.settings.loopguardIntervene,
      judge,
      confidence,
      incident,
    }
  }
}

export * from './rules.js'
export * from './state.js'
export * from './turn.js'
export * from './shell-edits.js'
export * from './judge.js'
export * from './envelope.js'
