/**
 * Shared value types for the Token Economizer.
 *
 * Everything in this file is plain JSON-serializable data: the same shapes are
 * written to the local store, sent through the plugin's HTTP API, and used by
 * the unit tests. Keep it free of DSH/Cordis imports so the engine can be
 * tested without a Harness.
 */

/** Global optimization mode. */
export type Mode = 'off' | 'shadow' | 'active'

/** Tool-pruning sub-mode; `mode: active` must also be set for `automatic`. */
export type PruneMode = 'disabled' | 'observe' | 'propose' | 'automatic'

/** One model call's token accounting (counts are disjoint, like DSH TokenUsage). */
export interface UsageCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Exact provider total when available, else the sum of the disjoint parts. */
  totalTokens: number
}

export const EMPTY_USAGE: Readonly<UsageCounts> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
})

/** Add two usage records field by field. */
export function addUsage(a: UsageCounts, b: UsageCounts): UsageCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

/** One accepted tool call, as observed from the session log. */
export interface ToolCallRecord {
  readonly callId: string
  readonly name: string
  /** Raw JSON argument text exactly as the model produced it. */
  readonly argumentsText: string
  /** Parsed arguments, or an empty object when the text is not a JSON object. */
  readonly args: Record<string, unknown>
  /** Bounded, redacted result text used by the loop guard and the extractor. */
  readonly output: string
  readonly isError: boolean
  readonly turn: number
  readonly step: number
  /** Epoch milliseconds when the result was observed. */
  readonly at: number
}

/** A model-visible request recorded by the Harness for one step. */
export interface ModelCallRecord {
  readonly turn: number
  readonly step: number
  readonly provider?: string
  readonly model?: string
  readonly usage?: UsageCounts
  readonly at: number
}

/** Per-session observation folded from `session/event`. */
export interface SessionObservation {
  readonly sessionId: string
  readonly rootSessionId: string
  readonly parentSessionId?: string
  readonly delegationDepth: number
  readonly projectId: string
  readonly cwd?: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly isSubagent: boolean
  readonly partial: boolean
  readonly modelRequests: number
  readonly toolCalls: number
  readonly failedToolCalls: number
  readonly usage: UsageCounts
  /** Tool names observed available for this session (first seen set). */
  readonly availableTools: readonly string[]
}

/** Lifecycle state of a learned fact, ported from upstream `microskills/lifecycle.py`. */
export type FactState = 'CANDIDATE' | 'ACTIVE' | 'RETIRED'

/** Category vocabulary used by the upstream distiller and environment-fact layer. */
export type FactKind =
  | 'run'
  | 'test'
  | 'build'
  | 'lint'
  | 'structure'
  | 'dependency'
  | 'environment'
  | 'workflow'
  | 'error'

/** A fact proposed by the extraction layer for one finished task. */
export interface FactCandidate {
  /** Stable identity used for de-duplication across tasks. */
  readonly key: string
  /** One-line fact, already redacted and lint-checked. */
  readonly text: string
  readonly kind: FactKind
  /** High-stakes facts retire on one clean contradiction (upstream HARD_KILL). */
  readonly high: boolean
  /** Promotion needs confirmations on different edited files. */
  readonly drift: boolean
  /** The waste this fact prevents occurred in this task. */
  readonly fired: boolean
  /** The fact was exercised in this task. */
  readonly exercised: boolean
  /** Basenames of files edited in this task. */
  readonly files: readonly string[]
  /** Bounded, redacted evidence snippets (never raw tool output). */
  readonly evidence: readonly string[]
  /** Session the fact was learned from. */
  readonly sourceSessionId: string
  readonly sourceTurn: number
}

/** One lifecycle row persisted in `microskills.json`. */
export interface StoredFact {
  id: string
  key: string
  text: string
  kind: FactKind
  high: boolean
  drift: boolean
  state: FactState
  /** `[task index, edited file basenames]` confirmations (`lifecycle.py` confirms). */
  confirms: Array<[number, string[]]>
  contradicts: number[]
  fireNum: number
  fireDen: number
  promotedAt: number | null
  retiredAt: number | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  /** User switch from the Micro-skills page; a disabled fact is never injected. */
  enabled: boolean
  source: {
    sessionId: string
    turn: number
    evidence: string[]
  }
}

/** Evidence kept for one row of the Tools page. */
export interface ToolStat {
  name: string
  descriptionTokens: number
  calls: number
  successes: number
  failures: number
  /** Distinct sessions where the tool was actually called. */
  sessions: number
  /** Distinct sessions where the tool was available (loaded / registered). */
  sessionsAvailable: number
  /** Available sessions in which it was never called — upstream "loaded but unused". */
  unusedSessions: number
  lastUsedAt: string | null
  lastUsedSeq: number | null
  pruned: boolean
  pruneReason: string | null
  protected: boolean
  allowlisted: boolean
  scoped: boolean
}

/** One detected failure loop. */
export interface LoopIncident {
  id: string
  at: string
  agentId: string
  sessionId: string
  rootSessionId: string
  projectId: string
  /** Cheap classifier reason, e.g. repeated signature or error density. */
  kind: string
  repeats: number
  turn: number
  step: number
  judge: 'not-run' | 'stuck' | 'ambiguous' | 'not-stuck' | 'skipped' | 'error'
  confidence: number | null
  intervention: 'none' | 'nudge' | 'notice'
  nudge: string | null
  /** Observed tool calls after the intervention, for honest outcome reporting. */
  outcome: 'unknown' | 'progress' | 'no-progress'
  detail: Record<string, string | number | boolean | null>
}

/** Aggregated report for one project or session. */
export interface UsageReport {
  scope: 'project' | 'session' | 'all'
  projectId: string | null
  sessionId: string | null
  sessions: number
  modelRequests: number
  toolCalls: number
  failedToolCalls: number
  loopInterventions: number
  prunedTools: number
  activeSkills: number
  usage: UsageCounts
  /** Upstream cache-aware fresh-input-equivalent tokens; null when the model is unknown. */
  effectiveTokens: number | null
  /** Measured USD cost, only when every contributing model has a known price. */
  costUsd: number | null
  costUnavailableModels: string[]
  /** Usage the economizer itself caused (judge calls). */
  pluginUsage: UsageCounts
  /** Token estimate of injected micro-skills. */
  injectedSkillTokens: number
  /** Estimated savings: always labeled as estimates, never as measured facts. */
  estimated: {
    prunedToolTokensPerRequest: number
    microskillWasteAvoidedTokens: number | null
    loopWasteAvoidedTokens: number | null
  }
  firstSeenAt: string | null
  updatedAt: string | null
}

/** Persisted per-project metadata. */
export interface ProjectMeta {
  schemaVersion: number
  projectId: string
  /** Canonical filesystem root of the workspace. */
  root: string
  /** Display name (basename of the root). */
  name: string
  git: boolean
  gitCommonDir?: string
  createdAt: string
  updatedAt: string
}

/** One record in `metrics.jsonl`: enough to re-derive reports after a restart. */
export interface MetricRecord {
  schemaVersion: number
  at: string
  sessionId: string
  rootSessionId: string
  parentSessionId?: string
  delegationDepth: number
  isSubagent: boolean
  projectId: string
  /** `model` | `tool` | `turn-end` | `loop` | `plugin` | `skills`. */
  kind: string
  model?: string
  provider?: string
  usage?: UsageCounts
  tool?: string
  toolOk?: boolean
  loop?: {
    kind: string
    intervention: string
    judge: string
    confidence: number | null
  }
  pluginUsage?: UsageCounts
  skillTokens?: number
  skillsApplied?: number
  toolsPruned?: number
}

/** Everything the engine needs to know about one task boundary. */
export interface TaskWindow {
  readonly projectId: string
  readonly sessionId: string
  readonly turn: number
  readonly calls: readonly ToolCallRecord[]
  readonly writes: readonly ToolCallRecord[]
  readonly failures: readonly ToolCallRecord[]
  readonly editedFiles: readonly string[]
  /** Task index within the project (monotonic, starting at 0). */
  readonly taskIndex: number
  readonly at: string
}

/** Redaction settings passed to every sanitizer. */
export interface RedactionPolicy {
  readonly redactSecrets: boolean
  readonly maxTextBytes: number
}
