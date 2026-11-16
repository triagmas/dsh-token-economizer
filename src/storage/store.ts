/**
 * Local persistence.
 *
 * Layout under `<DSH_HOME>/token-economizer/`:
 *
 *   install.json                      schema version + install metadata
 *   errors.log                        redacted plugin diagnostics
 *   projects/<projectId>/project.json workspace identity
 *   projects/<projectId>/skills.json  lifecycle rows (micro-skills)
 *   projects/<projectId>/tools.json   per-tool usage statistics
 *   projects/<projectId>/metrics.jsonl usage/tool/loop rows (rotated)
 *   projects/<projectId>/loops.jsonl  loop incidents (rotated)
 *
 * Every business file carries `schemaVersion`; a newer-than-supported version
 * fails closed for that file (the mechanism is disabled and the situation is
 * reported) instead of silently discarding the user's data.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendJsonl,
  ensureDir,
  nowIso,
  readJsonl,
  readJsonSafe,
  rotateJsonl,
  withFileLock,
  writeJsonAtomic,
  writeJsonlAtomic,
} from '../core/atomic.js'
import { canonicalPath, dataRoot, projectIdForRoot, projectDir } from '../core/paths.js'
import type { LoopIncident, MetricRecord, ProjectMeta, StoredFact, ToolStat, UsageCounts } from '../core/types.js'
import type { EnvelopeSnapshot } from '../loopguard/envelope.js'

export const SCHEMA_VERSION = 1
export const SUPPORTED_MAX_VERSION = 1

export interface SkillsFile {
  schemaVersion: number
  taskIndex: number
  facts: StoredFact[]
  /** Task (= finished session) index assigned to each session, so turns share one task. */
  sessionTasks?: Record<string, number>
  updatedAt: string | null
  /** Last block rendered by the engine, persisted so a restart can inject immediately. */
  lastBlock?: string
  lastBlockTokens?: number
  lastBlockIds?: string[]
}

export interface ToolsFile {
  schemaVersion: number
  tools: Record<string, ToolStat>
  pruned: string[]
  /** New automatic hides held until a later session (upstream `auto_pending`). */
  autoPending?: { items: string[]; since: string } | null
  /** Last observed project activity, used by the quiet-period gate. */
  lastActivityAt?: string | null
  lastAuditTask: number
  updatedAt: string | null
}

export interface InstallFile {
  schemaVersion: number
  pluginVersion: string
  installedAt: string
  lastSeenDshVersion: string | null
}

export const EMPTY_SKILLS: SkillsFile = {
  schemaVersion: SCHEMA_VERSION,
  taskIndex: 0,
  facts: [],
  sessionTasks: {},
  updatedAt: null,
  lastBlock: '',
  lastBlockTokens: 0,
  lastBlockIds: [],
}
export const EMPTY_TOOLS: ToolsFile = {
  schemaVersion: SCHEMA_VERSION,
  tools: {},
  pruned: [],
  autoPending: null,
  lastActivityAt: null,
  lastAuditTask: -1,
  updatedAt: null,
}

function migrateSkills(file: SkillsFile): SkillsFile {
  if (file.schemaVersion > SUPPORTED_MAX_VERSION) {
    throw new Error(`token-economizer: skills.json schema ${file.schemaVersion} is newer than supported ${SUPPORTED_MAX_VERSION}`)
  }
  return { ...file, schemaVersion: SCHEMA_VERSION }
}

function migrateTools(file: ToolsFile): ToolsFile {
  if (file.schemaVersion > SUPPORTED_MAX_VERSION) {
    throw new Error(`token-economizer: tools.json schema ${file.schemaVersion} is newer than supported ${SUPPORTED_MAX_VERSION}`)
  }
  // Rows written by older releases predate `unusedPrompts`. Upstream's
  // `prompt_streaks or streaks` migration treated each unused session as one
  // prompt, so preserve that evidence here instead of inventing a zero. New
  // rows always carry an explicit counter, which is authoritative: an
  // autonomous-only session must not become prompt evidence.
  for (const stat of Object.values(file.tools ?? {})) {
    if (!stat) continue
    const row = stat as { unusedPrompts?: number; unusedSessions?: number }
    if (!Number.isFinite(row.unusedPrompts) || (row.unusedPrompts ?? 0) < 0) {
      const sessions = Number.isFinite(row.unusedSessions) && (row.unusedSessions ?? 0) > 0 ? Math.floor(row.unusedSessions!) : 0
      row.unusedPrompts = sessions
    }
  }
  return { ...file, schemaVersion: SCHEMA_VERSION }
}

/** Order async operations on one project (single process) and across processes via file locks. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next as Promise<T>
  }
}

/** One workspace's store. */
export class ProjectStore {
  readonly meta: ProjectMeta
  readonly dir: string
  private readonly skillsMutex = new Mutex()
  private readonly toolsMutex = new Mutex()
  private skillsCache: SkillsFile | null = null
  private toolsCache: ToolsFile | null = null
  private loopguardCache: EnvelopeSnapshot | null | undefined

  constructor(meta: ProjectMeta, root: string, env: NodeJS.ProcessEnv = process.env) {
    this.meta = meta
    this.dir = projectDir(meta.projectId, env)
    void root
  }

  private path(name: string): string {
    return join(this.dir, name)
  }

  get metricsPath(): string {
    return this.path('metrics.jsonl')
  }

  get loopsPath(): string {
    return this.path('loops.jsonl')
  }

  get loopguardPath(): string {
    return this.path('loopguard.json')
  }

  async loadSkills(): Promise<SkillsFile> {
    if (this.skillsCache) return this.skillsCache
    const raw = await readJsonSafe<SkillsFile>(this.path('skills.json'), structuredClone(EMPTY_SKILLS))
    const file = migrateSkills({ ...EMPTY_SKILLS, ...raw, schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION })
    file.facts = Array.isArray(file.facts) ? file.facts : []
    this.skillsCache = file
    return file
  }

  async saveSkills(file: SkillsFile): Promise<void> {
    this.skillsCache = file
    await writeJsonAtomic(this.path('skills.json'), file)
  }

  /** Serialize a read-modify-write cycle on skills.json (in-process + cross-process). */
  async updateSkills<T>(fn: (file: SkillsFile) => Promise<T> | T): Promise<T> {
    return this.skillsMutex.run(async () => {
      const file = await this.loadSkills()
      return withFileLock(this.path('skills.json'), async () => {
        const result = await fn(file)
        file.updatedAt = nowIso()
        await this.saveSkills(file)
        return result
      })
    })
  }

  async loadTools(): Promise<ToolsFile> {
    if (this.toolsCache) return this.toolsCache
    const raw = await readJsonSafe<ToolsFile>(this.path('tools.json'), structuredClone(EMPTY_TOOLS))
    const file = migrateTools({ ...EMPTY_TOOLS, ...raw, schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION })
    file.tools = file.tools && typeof file.tools === 'object' ? file.tools : {}
    file.pruned = Array.isArray(file.pruned) ? file.pruned : []
    this.toolsCache = file
    return file
  }

  async saveTools(file: ToolsFile): Promise<void> {
    this.toolsCache = file
    await writeJsonAtomic(this.path('tools.json'), file)
  }

  async updateTools<T>(fn: (file: ToolsFile) => Promise<T> | T): Promise<T> {
    return this.toolsMutex.run(async () => {
      const file = await this.loadTools()
      return withFileLock(this.path('tools.json'), async () => {
        const result = await fn(file)
        file.updatedAt = nowIso()
        await this.saveTools(file)
        return result
      })
    })
  }

  /** The learned envelope for this repository, or null when nothing has been learned. */
  async loadLoopguard(): Promise<EnvelopeSnapshot | null> {
    if (this.loopguardCache !== undefined) return this.loopguardCache
    const raw = await readJsonSafe<EnvelopeSnapshot | null>(this.loopguardPath, null)
    this.loopguardCache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    return this.loopguardCache
  }

  async saveLoopguard(snapshot: EnvelopeSnapshot): Promise<void> {
    this.loopguardCache = snapshot
    await writeJsonAtomic(this.loopguardPath, snapshot)
  }

  async appendMetric(record: MetricRecord, maxBytes: number): Promise<void> {
    await appendJsonl(this.metricsPath, [record], maxBytes)
  }

  /** Append several rows in one write (one turn produces many rows). */
  async appendMetrics(records: readonly MetricRecord[], maxBytes: number): Promise<void> {
    if (!records.length) return
    await appendJsonl(this.metricsPath, records, maxBytes)
  }

  /** Remove every recorded loop incident for this project. */
  async clearLoops(): Promise<void> {
    await writeJsonlAtomic(this.loopsPath, [])
  }

  async appendLoop(incident: LoopIncident, maxBytes: number): Promise<void> {
    await appendJsonl(this.loopsPath, [incident], maxBytes)
  }

  async readMetrics(maxRows = 20_000): Promise<MetricRecord[]> {
    const rows = await readJsonl(this.metricsPath, maxRows)
    return rows.filter((row): row is MetricRecord => typeof row === 'object' && row !== null && 'kind' in row)
  }

  async readLoops(maxRows = 1_000): Promise<LoopIncident[]> {
    const rows = await readJsonl(this.loopsPath, maxRows)
    return rows.filter((row): row is LoopIncident => typeof row === 'object' && row !== null && 'kind' in row)
  }

  /** Increment and return the project task index (one task = one finished turn). */
  async nextTaskIndex(sessionId?: string): Promise<number> {
    return this.updateSkills((file) => {
      if (sessionId) {
        const known = file.sessionTasks?.[sessionId]
        if (Number.isInteger(known)) return Number(known)
        const index = file.taskIndex
        file.taskIndex = index + 1
        if (!file.sessionTasks) file.sessionTasks = {}
        file.sessionTasks[sessionId] = index
        // Bounded: a very old session id only costs a duplicate task index on a late turn.
        const keys = Object.keys(file.sessionTasks)
        if (keys.length > 512) delete file.sessionTasks[keys[0] as string]
        return index
      }
      const index = file.taskIndex
      file.taskIndex = index + 1
      return index
    })
  }

  /** Delete metric rows older than the retention window; rotate oversized files. */
  async maintenance(retentionDays: number, maxBytes: number): Promise<void> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const rows = await this.readMetrics(1_000_000)
    const kept = rows.filter((row) => {
      const time = Date.parse(row.at ?? '')
      return !Number.isFinite(time) || time >= cutoff
    })
    if (kept.length !== rows.length) {
      // One JSON object per line, written beside the target and renamed atomically.
      await writeJsonlAtomic(this.metricsPath, kept)
    }
    try {
      const info = await stat(this.metricsPath)
      if (info.size > maxBytes) await rotateJsonl(this.metricsPath)
    } catch {
      /* no metrics yet */
    }
  }
}

/** Process-wide storage facade. */
export class Store {
  readonly root: string
  readonly env: NodeJS.ProcessEnv
  private readonly cache = new Map<string, ProjectStore>()
  private install: InstallFile | null = null

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
    this.root = dataRoot(env)
  }

  get projectsRoot(): string {
    return join(this.root, 'projects')
  }

  /** Create directories and read/write install metadata. */
  async open(pluginVersion: string, dshVersion: string | null): Promise<InstallFile> {
    await ensureDir(this.root)
    await ensureDir(this.projectsRoot)
    const path = join(this.root, 'install.json')
    const existing = await readJsonSafe<InstallFile | null>(path, null)
    const install: InstallFile = existing
      ? { ...existing, lastSeenDshVersion: dshVersion ?? existing.lastSeenDshVersion }
      : {
          schemaVersion: SCHEMA_VERSION,
          pluginVersion,
          installedAt: nowIso(),
          lastSeenDshVersion: dshVersion,
        }
    if (install.schemaVersion > SUPPORTED_MAX_VERSION) {
      throw new Error(
        `token-economizer: data directory schema ${install.schemaVersion} is newer than supported ${SUPPORTED_MAX_VERSION}`,
      )
    }
    install.schemaVersion = SCHEMA_VERSION
    install.lastSeenDshVersion = dshVersion ?? install.lastSeenDshVersion
    await writeJsonAtomic(path, install)
    this.install = install
    return install
  }

  /** Open (or return cached) project store for a workspace root. */
  async project(root: string): Promise<ProjectStore> {
    const canonical = canonicalPath(root)
    const projectId = projectIdForRoot(canonical)
    const cached = this.cache.get(projectId)
    if (cached) return cached
    const { existsSync } = await import('node:fs')
    const { findRepoRoot } = await import('../core/paths.js')
    const repo = existsSync(join(canonical, '.git')) ? { root: canonical, git: true } : findRepoRoot(canonical)
    const dir = projectDir(projectId, this.env)
    await ensureDir(dir)
    const metaPath = join(dir, 'project.json')
    const existing = await readJsonSafe<ProjectMeta | null>(metaPath, null)
    const meta: ProjectMeta = existing
      ? { ...existing, root: canonical, updatedAt: nowIso() }
      : {
          schemaVersion: SCHEMA_VERSION,
          projectId,
          root: canonical,
          name: canonical.split(/[\\/]/).filter(Boolean).pop() ?? canonical,
          git: repo.git,
          gitCommonDir: 'gitCommonDir' in repo ? repo.gitCommonDir : undefined,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
    await writeJsonAtomic(metaPath, meta)
    const store = new ProjectStore(meta, canonical, this.env)
    this.cache.set(projectId, store)
    return store
  }

  /** List project metadata for the UI, newest first. */
  async listProjects(): Promise<ProjectMeta[]> {
    const names = await readdir(this.projectsRoot).catch(() => [] as string[])
    const result: ProjectMeta[] = []
    for (const name of names.sort()) {
      const meta = await readJsonSafe<ProjectMeta | null>(join(this.projectsRoot, name, 'project.json'), null)
      if (meta) result.push(meta)
    }
    result.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    return result
  }

  /** Append a redacted diagnostic line to the plugin error log. */
  async logError(line: string): Promise<void> {
    await ensureDir(this.root)
    const stamp = nowIso()
    await appendJsonl(join(this.root, 'errors.log'), [{ at: stamp, line }], 1_048_576)
  }

  get installInfo(): InstallFile | null {
    return this.install
  }
}

/** Fold raw metric rows into usage totals (used by reports and tests). */
export function foldUsage(rows: readonly MetricRecord[]): {
  usage: UsageCounts
  pluginUsage: UsageCounts
  modelRequests: number
  toolCalls: number
  failedToolCalls: number
  loopInterventions: number
  prunedTools: number
  activeSkills: number
  sessions: number
  firstSeenAt: string | null
  updatedAt: string | null
} {
  const zero = (): UsageCounts => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  })
  const usage = zero()
  const pluginUsage = zero()
  const sessions = new Set<string>()
  let modelRequests = 0
  let toolCalls = 0
  let failedToolCalls = 0
  let loopInterventions = 0
  let prunedTools = 0
  let activeSkills = 0
  let firstSeenAt: string | null = null
  let updatedAt: string | null = null
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (row.sessionId) sessions.add(row.sessionId)
    if (row.at) {
      if (!firstSeenAt || row.at < firstSeenAt) firstSeenAt = row.at
      if (!updatedAt || row.at > updatedAt) updatedAt = row.at
    }
    if (row.usage) for (const key of Object.keys(usage) as Array<keyof UsageCounts>) usage[key] += row.usage[key] ?? 0
    if (row.pluginUsage) {
      for (const key of Object.keys(pluginUsage) as Array<keyof UsageCounts>) pluginUsage[key] += row.pluginUsage[key] ?? 0
    }
    if (row.kind === 'model') modelRequests += 1
    if (row.kind === 'tool') {
      toolCalls += 1
      if (row.toolOk === false) failedToolCalls += 1
    }
    if (row.kind === 'loop' && row.loop && row.loop.intervention !== 'none') loopInterventions += 1
    if (row.kind === 'skills') {
      activeSkills = Math.max(activeSkills, row.skillsApplied ?? 0)
      prunedTools = Math.max(prunedTools, row.toolsPruned ?? 0)
    }
  }
  return {
    usage,
    pluginUsage,
    modelRequests,
    toolCalls,
    failedToolCalls,
    loopInterventions,
    prunedTools,
    activeSkills,
    sessions: sessions.size,
    firstSeenAt,
    updatedAt,
  }
}
