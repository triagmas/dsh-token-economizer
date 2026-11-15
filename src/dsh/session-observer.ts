/**
 * Session event folding for the Token Economizer.
 *
 * The Harness Session log is the single source of truth. This observer is a
 * pure, bounded fold over `session/event`: it pairs tool calls with results,
 * accumulates provider-reported usage, identifies subagent lineage, and emits
 * one immutable `TurnSummary` per finished turn. It performs no I/O and never
 * throws into the Harness event dispatch.
 */
import { findRepoRoot } from '../core/paths.js'
import { DEFAULT_REDACTION, sanitizeText } from '../core/redact.js'
import { addUsage, EMPTY_USAGE, REDIRECT_MESSAGE_SOURCE, type ModelCallRecord, type ToolCallRecord, type UsageCounts } from '../core/types.js'
import { toUsageCounts } from './judge.js'

/** Model-facing tool metadata captured once per session. */
export interface ObservedToolDescriptor {
  name: string
  descriptionTokens: number
}

/** Identity and per-session totals observed by the fold. */
export interface ObservedSession {
  readonly sessionId: string
  readonly rootSessionId: string
  readonly parentSessionId: string | null
  readonly delegationDepth: number
  readonly isSubagent: boolean
  readonly cwd: string | null
  readonly projectRoot: string | null
  readonly startedAt: string
  readonly availableTools: readonly ObservedToolDescriptor[]
  readonly usage: UsageCounts
  readonly modelRequests: number
  readonly toolCalls: number
  readonly failedToolCalls: number
}

/** One finished turn, handed to the runtime for extraction, metrics and guarding. */
export interface TurnSummary {
  readonly session: ObservedSession
  readonly turn: number
  readonly startedAt: string | null
  readonly endedAt: string
  readonly calls: readonly ToolCallRecord[]
  readonly modelCalls: readonly ModelCallRecord[]
  readonly usage: UsageCounts
  readonly failedToolCalls: number
  readonly assistantText: string
  readonly partial: boolean
  /**
   * True only when the turn carried a direct human prompt (`user/message` with
   * `source.kind === 'user'` and no redirect marker). Scheduled deliveries,
   * goal rounds, runtime context, and the loop guard's own followup are not
   * user-initiated; subagents are excluded separately.
   */
  readonly userInitiated: boolean
}

export interface ObserverHooks {
  /** Lightweight global catalog snapshot; called once per non-subagent session. */
  availableTools(): readonly ObservedToolDescriptor[]
  onSession(session: ObservedSession): void
  onTurnStart(session: ObservedSession, turn: number): void
  onToolResult(session: ObservedSession, record: ToolCallRecord): void
  onAssistantText(session: ObservedSession, text: string, turn: number, step: number): void
  onModelCall(session: ObservedSession, call: ModelCallRecord): void
  onTurnEnd(summary: TurnSummary): void
}

interface PendingCall {
  name: string
  argumentsText: string
  args: Record<string, unknown>
  turn: number
  step: number
  at: number
}

interface SessionState {
  session: ObservedSession
  pending: Map<string, PendingCall>
  calls: ToolCallRecord[]
  modelCalls: ModelCallRecord[]
  assistantText: string
  turn: number
  step: number
  turnStartAt: string | null
  turnStarted: boolean
  turnUserInitiated: boolean
  usage: UsageCounts
  failedToolCalls: number
  modelRequests: number
  toolCalls: number
  droppedCalls: number
}

const MAX_SESSIONS = 200
const MAX_CALLS_PER_TURN = 300
const MAX_PENDING_CALLS = 1000
const MAX_TOOL_OUTPUT_BYTES = 2_000
const MAX_ASSISTANT_TEXT_BYTES = 4_000

/**
 * DSH's bash tool appends `[exit code: N]` to the result text and leaves
 * `message.isError` false for an ordinary non-zero exit. The marker is the
 * outcome signal the loop guard needs; `isError` alone misses every failed
 * shell command in a live session.
 */
const DSH_EXIT_CODE_RE = /\[exit code:\s*(\d+)\]\s*$/m

function toolResultIsError(message: Record<string, unknown>, rawOutput: string, toolName: string): boolean {
  if (message.isError === true) return true
  // Only the shell tool appends this marker; arbitrary tool text must not look like an exit.
  if (toolName !== 'bash') return false
  const match = DSH_EXIT_CODE_RE.exec(rawOutput)
  return match !== null && Number(match[1]) !== 0
}

/** Cheap, bounded shape checks so an unknown event never crashes the fold. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text)
    } else if (record.type === 'image') {
      parts.push('[image]')
    } else if (record.type === 'reasoning' && typeof record.text === 'string') {
      // Reasoning text is model-private; keep a marker only.
      parts.push('[reasoning]')
    }
  }
  return parts.join('\n')
}

/** Tool names whose calls modify workspace files (used for write detection). */
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'str_replace', 'create', 'apply_patch', 'multiedit', 'notebook_edit'])

/** True when a tool call is expected to modify files. */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name.toLowerCase())
}

/** Extract a path argument from a write-like tool call. */
export function pathArgument(args: Record<string, unknown>): string | null {
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** Fold session events into turn summaries. */
export class SessionObserver {
  private readonly hooks: ObserverHooks
  private readonly states = new Map<string, SessionState>()
  private readonly order: string[] = []
  private readonly now: () => number

  constructor(hooks: ObserverHooks, now: () => number = Date.now) {
    this.hooks = hooks
    this.now = now
  }

  /** Handle one committed session event. Exception-safe by design. */
  handle(session: unknown, event: unknown): void {
    try {
      const sessionRecord = asRecord(session)
      const sessionId = typeof sessionRecord.id === 'string' ? sessionRecord.id : ''
      if (!sessionId) return
      const eventRecord = asRecord(event)
      const type = typeof eventRecord.type === 'string' ? eventRecord.type : ''
      const data = asRecord(eventRecord.data)
      const at = typeof eventRecord.time === 'number' ? eventRecord.time : this.now()

      if (type === 'session/disposed') {
        this.finish(sessionId, at)
        this.states.delete(sessionId)
        const index = this.order.indexOf(sessionId)
        if (index >= 0) this.order.splice(index, 1)
        return
      }

      let state: SessionState | undefined = this.states.get(sessionId)
      if (!state) {
        const created = this.createState(sessionRecord, at)
        if (!created) return
        state = created
      }

      switch (type) {
        case 'turn/start': {
          state.turn = numberOr(data.turn, state.turn)
          state.turnStarted = true
          state.turnStartAt = new Date(at).toISOString()
          // DSH emits the prompt either before or after turn/start. Do not clear the flag
          // here: the only reset belongs to finish(), so both orders keep the prompt.
          this.hooks.onTurnStart(state.session, state.turn)
          break
        }
        case 'user/message': {
          const source = asRecord(data.source)
          if (source.kind !== 'user' || source.generatedBy === REDIRECT_MESSAGE_SOURCE) break
          state.turnUserInitiated = true
          break
        }
        case 'step/start': {
          state.step = numberOr(data.step, state.step)
          break
        }
        case 'tool/call': {
          const callId = typeof data.callId === 'string' ? data.callId : ''
          const name = typeof data.name === 'string' ? data.name : ''
          if (!callId || !name) break
          if (state.pending.size >= MAX_PENDING_CALLS) {
            const oldest = state.pending.keys().next().value
            if (typeof oldest === 'string') state.pending.delete(oldest)
          }
          const argumentsText = typeof data.arguments === 'string' ? data.arguments : ''
          state.pending.set(callId, {
            name,
            argumentsText,
            args: parseArguments(argumentsText),
            turn: numberOr(data.turn, state.turn),
            step: numberOr(data.step, state.step),
            at,
          })
          break
        }
        case 'tool/result': {
          const message = asRecord(data.message)
          const source = asRecord(message.source)
          const callId = typeof source.callId === 'string' ? source.callId : ''
          const pending = callId ? state.pending.get(callId) : undefined
          if (!pending) break // resumed history: no accepted call to pair with
          state.pending.delete(callId)
          const rawOutput = textOfContent(message.content)
          const output = sanitizeText(rawOutput, {
            ...DEFAULT_REDACTION,
            maxTextBytes: MAX_TOOL_OUTPUT_BYTES,
          })
          const record: ToolCallRecord = {
            callId,
            name: pending.name,
            argumentsText: pending.argumentsText.slice(0, 4_000),
            args: pending.args,
            output,
            isError: toolResultIsError(message, rawOutput, pending.name),
            turn: numberOr(data.turn, pending.turn),
            step: numberOr(data.step, pending.step),
            at,
          }
          state.toolCalls += 1
          if (record.isError) {
            state.failedToolCalls += 1
            state.failedToolCalls = Math.max(state.failedToolCalls, 0)
          }
          if (state.calls.length < MAX_CALLS_PER_TURN) state.calls.push(record)
          else state.droppedCalls += 1
          this.hooks.onToolResult(state.session, record)
          break
        }
        case 'assistant/message': {
          const message = asRecord(data.message)
          const source = asRecord(message.source)
          const usage = data.usage ? toUsageCounts(data.usage as Record<string, unknown>) : { ...EMPTY_USAGE }
          state.usage = addUsage(state.usage, usage)
          state.modelRequests += 1
          const text = textOfContent(message.content)
          if (text) {
            state.assistantText = sanitizeText(`${state.assistantText}\n${text}`.trim(), {
              ...DEFAULT_REDACTION,
              maxTextBytes: MAX_ASSISTANT_TEXT_BYTES,
            })
            this.hooks.onAssistantText(state.session, text, numberOr(data.turn, state.turn), numberOr(data.step, state.step))
          }
          const call: ModelCallRecord = {
            turn: numberOr(data.turn, state.turn),
            step: numberOr(data.step, state.step),
            provider: typeof source.provider === 'string' ? source.provider : undefined,
            model: typeof source.model === 'string' ? source.model : undefined,
            usage,
            at,
          }
          if (state.modelCalls.length < MAX_CALLS_PER_TURN) state.modelCalls.push(call)
          this.hooks.onModelCall(state.session, call)
          break
        }
        case 'assistant/attempt': {
          // A settled failed/retried attempt carries no surface message; count
          // it so "model requests" reflects real work, without inventing usage.
          state.modelRequests += 1
          break
        }
        case 'turn/end': {
          this.finish(sessionId, at)
          break
        }
        default:
          break
      }
    } catch {
      // The observer is an optimization layer: it must never disturb the log feed.
    }
  }

  /** Flush any buffered turn for a session that is going away. */
  flush(): void {
    for (const sessionId of [...this.states.keys()]) this.finish(sessionId, this.now())
  }

  private finish(sessionId: string, at: number): void {
    const state = this.states.get(sessionId)
    if (!state) return
    const hasData = state.calls.length > 0 || state.modelCalls.length > 0 || state.assistantText !== ''
    if (!hasData && !state.turnStarted) return
    const summary: TurnSummary = {
      session: {
        ...state.session,
        usage: state.usage,
        modelRequests: state.modelRequests,
        toolCalls: state.toolCalls,
        failedToolCalls: state.failedToolCalls,
      },
      turn: state.turn,
      startedAt: state.turnStartAt,
      endedAt: new Date(at).toISOString(),
      calls: [...state.calls],
      modelCalls: [...state.modelCalls],
      usage: state.usage,
      failedToolCalls: state.failedToolCalls,
      assistantText: state.assistantText,
      partial: !state.turnStarted,
      userInitiated: state.turnUserInitiated,
    }
    state.calls = []
    state.modelCalls = []
    state.assistantText = ''
    state.usage = { ...EMPTY_USAGE }
    state.failedToolCalls = 0
    state.modelRequests = 0
    state.toolCalls = 0
    state.turnStarted = false
    state.turnStartAt = null
    state.turnUserInitiated = false
    state.droppedCalls = 0
    try {
      this.hooks.onTurnEnd(summary)
    } catch {
      /* fail-open */
    }
  }

  private createState(sessionRecord: Record<string, unknown>, at: number): SessionState | null {
    const sessionId = typeof sessionRecord.id === 'string' ? sessionRecord.id : ''
    if (!sessionId) return null
    const header = asRecord(sessionRecord.header)
    const parent = typeof header.parentSession === 'string' ? header.parentSession : null
    const depth = numberOr(header.delegationDepth, parent ? 1 : 0)
    const isSubagent = header.origin === 'subagent' || depth > 0
    const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null
    const projectRoot = cwd ? findRepoRoot(cwd).root : null
    const parentState = parent ? this.states.get(parent) : undefined
    const rootSessionId = parentState?.session.rootSessionId ?? parent ?? sessionId
    const availableTools: readonly ObservedToolDescriptor[] = isSubagent ? [] : (this.hooks.availableTools?.() ?? [])
    const session: ObservedSession = {
      sessionId,
      rootSessionId,
      parentSessionId: parent,
      delegationDepth: depth,
      isSubagent,
      cwd,
      projectRoot,
      startedAt: new Date(at).toISOString(),
      availableTools,
      usage: { ...EMPTY_USAGE },
      modelRequests: 0,
      toolCalls: 0,
      failedToolCalls: 0,
    }
    const state: SessionState = {
      session,
      pending: new Map(),
      calls: [],
      modelCalls: [],
      assistantText: '',
      turn: 0,
      step: 0,
      turnStartAt: null,
      turnStarted: false,
      turnUserInitiated: false,
      usage: { ...EMPTY_USAGE },
      failedToolCalls: 0,
      modelRequests: 0,
      toolCalls: 0,
      droppedCalls: 0,
    }
    this.states.set(sessionId, state)
    this.order.push(sessionId)
    while (this.order.length > MAX_SESSIONS) {
      const evicted = this.order.shift()
      if (evicted) this.states.delete(evicted)
    }
    try {
      this.hooks.onSession(session)
    } catch {
      /* fail-open */
    }
    return state
  }

  /** Test/diagnostics helper: number of tracked live sessions. */
  get trackedSessions(): number {
    return this.states.size
  }

  /** Snapshot for diagnostics (no mutable references). */
  describe(): Array<{ sessionId: string; turn: number; calls: number; subagent: boolean }> {
    return [...this.states.values()].map((state) => ({
      sessionId: state.session.sessionId,
      turn: state.turn,
      calls: state.calls.length,
      subagent: state.session.isSubagent,
    }))
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseArguments(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
