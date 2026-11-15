/**
 * Wire contract between the Host HTTP routes and the WebUI client.
 *
 * Both sides are local plugins in the same package, but the client is a plain
 * browser artifact that cannot import this module. Keep the JSON shapes here
 * authoritative and mirrored in `client/index.js`.
 *
 * All routes live under `/api/token-economizer`, are owner-authenticated by
 * DSH Connection, and return `{ ok: true, ... }` or
 * `{ ok: false, error: { code, message } }`.
 */

export const API_PREFIX = '/api/token-economizer'

export type WireMode = 'off' | 'shadow' | 'active'
export type WirePruneMode = 'observe' | 'propose' | 'automatic'
export type WireFactStatus = 'candidate' | 'confirmed' | 'retired'
export type WireToolStatus = 'active' | 'hidden' | 'protected' | 'allowlisted'

export interface WireError {
  ok: false
  error: { code: string; message: string }
}

export interface WireCompatibility {
  ok: boolean
  version: string | null
  testedRange: string
  reason: string
}

export interface WireStatus {
  ok: true
  plugin: { name: string; version: string; dshVersion: string | null; compatibility: WireCompatibility }
  mode: WireMode
  effective: {
    microskills: boolean
    toolprune: boolean
    loopguard: boolean
    subagents: boolean
    judge: boolean
  }
  /** Project bound to the requested session, or null when the session is unknown. */
  project: { id: string; root: string } | null
  storage: { root: string; projectDir: string | null; schemaVersion: number; bytes: number }
  totals: {
    modelRequests: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    effectiveTokens: number | null
    /** Null when any observed model lacks a configured price. */
    costUsd: number | null
    costUnavailableModels: string[]
    /** Always an estimate, labelled as such in the UI. */
    estimatedSavingsTokens: number
    estimatedSavingsUsd: number | null
    overheadTokens: number
    unobservedSessions: number
  }
  mechanisms: {
    microskills: { injectedFacts: number; pendingCandidates: number; tokensPerRequest: number }
    toolprune: { hiddenTools: number; savedTokensPerRequest: number }
    loopguard: { incidents: number; redirects: number; judgeCalls: number; judgeTokens: number }
  }
  budget: { sessionTokens: number; sessionLimit: number; turnTokens: number; overheadTokens: number }
  notes: string[]
}

export interface WireMetricPoint {
  at: string
  modelRequests: number
  inputTokens: number
  outputTokens: number
  effectiveTokens: number | null
  costUsd: number | null
  toolCalls: number
  toolErrors: number
}

export interface WireOverview {
  ok: true
  status: WireStatus
  sessions: { observed: number; subagentSessions: number; attributedRoots: number; unobserved: number }
  recent: WireMetricPoint[]
  loops: { incidents: number; lastIncidentAt: string | null }
  /** Human-readable, non-numeric statements about what is and is not measured. */
  measurement: string[]
}

export interface WireFact {
  id: string
  kind: string
  text: string
  status: WireFactStatus
  confirmations: number
  sessionsSeen: number
  createdAt: string | null
  updatedAt: string | null
  lastSeenAt: string | null
  source: 'extractor' | 'manual' | 'imported'
  sensitive: boolean
}

export interface WireSkills {
  ok: true
  project: { id: string; root: string } | null
  confirmed: WireFact[]
  candidates: WireFact[]
  retired: WireFact[]
  meta: { maxFacts: number; maxTokens: number; retireDays: number; injectionEnabled: boolean; totalTokens: number }
}

export interface WireTool {
  name: string
  descriptionTokens: number
  calls: number
  sessions: number
  errors: number
  lastUsedAt: string | null
  lastAvailableAt: string | null
  status: WireToolStatus
  reason: string
  evidence: { sessions: number; calls: number; sessionsRequired: number; callsRequired: number }
}

export interface WireTools {
  ok: true
  project: { id: string; root: string } | null
  mode: WirePruneMode
  enabled: boolean
  entries: WireTool[]
  hidden: string[]
  protected: string[]
  estimatedHiddenTokens: number
  lastAuditAt: string | null
  notes: string[]
}

export interface WireLoopIncident {
  id: string
  at: string
  sessionId: string
  rootSessionId: string
  projectId: string | null
  turn: number
  step: number
  /** Cheap classifier reason, e.g. `judge-stuck@0.81` or `gate-closed`. */
  kind: string
  repeats: number
  judge: 'not-run' | 'stuck' | 'ambiguous' | 'not-stuck' | 'skipped' | 'error'
  confidence: number | null
  intervention: 'none' | 'nudge' | 'notice'
  nudge: string | null
  outcome: 'unknown' | 'progress' | 'no-progress'
  detail: Record<string, string | number | boolean | null>
}

export interface WireLoops {
  ok: true
  project: { id: string; root: string } | null
  incidents: WireLoopIncident[]
  summary: {
    total: number
    redirected: number
    recovered: number
    judgeCalls: number
    judgeTokens: number
    budgetExhausted: number
  }
  config: { enabled: boolean; intervene: boolean; confidence: number; maxInterventions: number; level: string }
}

export type WireConfigType = 'boolean' | 'number' | 'string' | 'enum' | 'array' | 'secret'
export type WireConfigGroup =
  | 'general'
  | 'microskills'
  | 'tools'
  | 'loopguard'
  | 'subagents'
  | 'budget'
  | 'storage'
  | 'pricing'

export interface WireConfigField {
  key: string
  type: WireConfigType
  group: WireConfigGroup
  options?: string[]
  min?: number
  max?: number
  advanced?: boolean
}

export interface WireSettings {
  ok: true
  config: Record<string, unknown>
  defaults: Record<string, unknown>
  fields: WireConfigField[]
  compatibility: WireCompatibility
  writable: boolean
  revision: number | string | null
  notes: string[]
}

export interface WireProject {
  id: string
  root: string
  confirmedFacts: number
  pendingCandidates: number
  hiddenTools: number
  lastActiveAt: string | null
}

export interface WireProjects {
  ok: true
  projects: WireProject[]
  storageRoot: string
}

/**
 * Route summary (all owner-authenticated, all `no-store`):
 *
 *   GET  /status?sessionId=&cwd=
 *   GET  /overview?sessionId=&cwd=
 *   GET  /skills?sessionId=&cwd=
 *   GET  /tools?sessionId=&cwd=
 *   GET  /loops?sessionId=&cwd=
 *   GET  /settings
 *   GET  /projects
 *   POST /skills/action   { action: 'confirm'|'reject'|'delete'|'clearCandidates', ids?: string[] }
 *   POST /tools/action    { action: 'restore'|'restoreAll'|'setMode', names?: string[], mode?: WirePruneMode }
 *   POST /loops/action    { action: 'clear' }
 *   POST /settings        { patch: Record<string, unknown> }
 *   POST /mode            { mode: WireMode }
 *
 * Errors use stable codes: BAD_REQUEST, UNKNOWN_PROJECT, FORBIDDEN_PATH,
 * NOT_WRITABLE, STORE_ERROR, INTERNAL.
 */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNKNOWN_PROJECT',
  'FORBIDDEN_PATH',
  'NOT_WRITABLE',
  'STORE_ERROR',
  'INTERNAL',
] as const
