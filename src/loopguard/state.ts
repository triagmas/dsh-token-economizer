/**
 * What the loop guard reads off a trajectory: a per-call fold of its failure-loop signals.
 *
 * Port of `tokeneconomizer/loopguard/state.py` (Microsoft TokenEconomizer, Apache-2.0,
 * commit 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0).
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit 7042ea8.
 *
 * HOST ADAPTATION: upstream consumes streamed transcript JSONL lines (`completed_calls`) from
 * Copilot/Codex/Claude Code. The DSH adapter already has a structured `ToolCallRecord`, so the
 * engine folds that directly; `completedCalls` is still ported for replaying saved transcripts
 * (and for parity).
 */
import { createHash } from 'node:crypto'

import { formatFixed0, pyRound, type DigestOptions, type SpiralSignals } from './rules.js'

/** An output that RAN code to verify behavior (`TEST_RUN_RE`, state.py:17). */
export const TEST_RUN_RE = new RegExp(
  String.raw`(runtests(\.py)?|\bpytest\b|py\.test|manage\.py\s+test|python\s+-m\s+unittest|` +
    String.raw`\btox\b|\bnox\b|\btrial\b|python\d?\s+-c\b)`,
  'i',
)

/**
 * `ERR_RE` (state.py:20). The upstream pattern is compiled with IGNORECASE | MULTILINE and
 * ends with an inline case-SENSITIVE group `^(?-i:--- FAIL: |FAIL\t|FAIL$)`. JavaScript has no
 * `(?-i:...)` (regexp modifiers are not available in Node 22), so the case-sensitive tail is a
 * second expression and `errMatch`/`errSearchLine` search both. Same language, same matches.
 */
export const ERR_RE = new RegExp(
  String.raw`Traceback \(most recent call last\)|\b\w*Error\b|\bFAILED\b|\bassert\b|` +
    String.raw`Exception|errors during collection|` +
    String.raw`^# fail [1-9]|^not ok \d|\b[1-9]\d* (?:failing|failures?)\b|Failures: [1-9]`,
  'im',
)

/** The case-sensitive tail of upstream `ERR_RE` (`^(?-i:--- FAIL: |FAIL\t|FAIL$)`). */
export const ERR_CASE_RE = /^(?:--- FAIL: |FAIL\t|FAIL$)/m

const _EDIT_TOOLS = new Set(['edit', 'str_replace', 'create'])

/** Tools whose output is file CONTENT, not the outcome of running anything (state.py:31). */
const _CONTENT_TOOLS = new Set(['view', 'grep', 'glob'])

/** `_TOOL_CANON` (state.py:38): agent-specific tool names -> copilot-style canonical names. */
const _TOOL_CANON: Record<string, string> = {
  bash: 'bash',
  shell: 'bash',
  read: 'view',
  view: 'view',
  grep: 'grep',
  glob: 'glob',
  edit: 'edit',
  multiedit: 'edit',
  str_replace: 'edit',
  apply_patch: 'edit',
  write: 'create',
  create: 'create',
}

/** `canon_tool` (state.py:49). Unknown names pass through unchanged. */
export function canonTool(name?: string | null): string {
  const raw = name ?? ''
  return _TOOL_CANON[raw.toLowerCase()] ?? (raw || '?')
}

/** `_failure_sig`'s normalization (state.py:137): drop addresses, numbers and paths. */
const _SIG_NORM_RE = /0x[0-9a-f]+|[\p{Nd}]+|\/\S+/gu

/** Python `str.splitlines()` separators (the JS `\n` split alone misses `\r`, `\x85`, ...). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
}

/** Does one line carry an error/failure marker (Python `ERR_RE.search`)? */
export function errSearchLine(line: string): boolean {
  return ERR_RE.test(line) || ERR_CASE_RE.test(line)
}

/** Does a result text carry an error/failure marker (Python `ERR_RE.search`)? */
export function errMatch(text: string | null | undefined): boolean {
  if (!text) return false
  return ERR_RE.test(text) || ERR_CASE_RE.test(text)
}

/**
 * A normalized hash signature of a failing output (`_failure_sig`, state.py:124). Numbers,
 * addresses and paths are dropped so two runs failing the SAME way hash identically. Never
 * exposes the content: a hash only.
 */
export function failureSignature(text: string | null | undefined): string | null {
  if (!text) return null
  let first: string | null = null
  for (const line of splitLines(text)) {
    if (errSearchLine(line)) {
      first = line
      break
    }
  }
  if (first === null) return null
  const norm = first.replace(_SIG_NORM_RE, '')
  return createHash('md5').update(norm.trim(), 'utf8').digest('hex').slice(0, 10)
}

/** `basename` (state.py:118): last path component in either separator. */
export function basename(path?: string | null): string {
  if (!path) return path ?? ''
  return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').slice(-1)[0] ?? ''
}

/** One completed tool call, in the shape `state`/`turn` fold. */
export interface CompletedToolCall {
  name: string
  args: Record<string, unknown>
  result: string
}

interface PendingCall {
  name: string
  args: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * `completed_calls` (state.py:53): schema-agnostic fold of ONE streamed JSONL line into the
 * completed `(name, args, result)` calls finished on that line. Supports the Codex
 * `exec --json` schema, the Copilot CLI stream and Claude Code's stream-json. `pend` is a
 * caller-owned map carried across lines to pair a start/tool_use with its later
 * complete/tool_result. Unpaired results fall back to name `'?'`.
 */
export function completedCalls(
  line: string,
  pend: Map<string, PendingCall>,
): CompletedToolCall[] {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return []
  }
  if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) return []
  const record = ev as Record<string, unknown>
  const t = record.type
  const out: CompletedToolCall[] = []

  // ---- Codex exec --json schema ----
  if (t === 'item.completed') {
    const item = asRecord(record.item)
    const kind = item.type
    if (kind === 'command_execution') {
      out.push({
        name: 'bash',
        args: { command: asString(item.command) },
        result: asString(item.aggregated_output),
      })
    } else if (kind === 'file_change') {
      const changes = asArray(item.changes)
      const paths: string[] = []
      for (const change of changes) {
        const c = asRecord(change)
        if (typeof c.path === 'string' && c.path) paths.push(c.path)
      }
      out.push({
        name: 'edit',
        args: {
          path: paths[0] ?? '',
          paths,
          changes,
        },
        result: '',
      })
    }
    return out
  }

  // ---- Copilot schema ----
  if (t === 'tool.execution_start') {
    const d = asRecord(record.data)
    const id = d.toolCallId
    if (id !== undefined) {
      pend.set(String(id), { name: asString(d.toolName), args: asRecord(d.arguments) })
    }
    return out
  }
  if (t === 'tool.execution_complete') {
    const d = asRecord(record.data)
    const info = pend.get(String(d.toolCallId)) ?? { name: '?', args: {} }
    pend.delete(String(d.toolCallId))
    const res = asRecord(d.result)
    const content = res.content
    out.push({
      name: canonTool(info.name),
      args: info.args,
      result: typeof content === 'string' ? content : '',
    })
    return out
  }

  // ---- Claude Code stream-json schema ----
  if (t === 'assistant') {
    for (const block of asArray(asRecord(record.message).content)) {
      const b = asRecord(block)
      if (b.type === 'tool_use' && b.id !== undefined) {
        pend.set(String(b.id), { name: asString(b.name), args: asRecord(b.input) })
      }
    }
    return out
  }
  if (t === 'user') {
    for (const block of asArray(asRecord(record.message).content)) {
      const b = asRecord(block)
      if (b.type !== 'tool_result') continue
      const key = String(b.tool_use_id)
      const info = pend.get(key) ?? { name: '?', args: {} }
      pend.delete(key)
      let content = b.content
      if (Array.isArray(content)) {
        content = content
          .map((x) => asString(asRecord(x).text))
          .filter((x) => x !== '')
          .join('\n')
      }
      out.push({
        name: canonTool(info.name),
        args: info.args,
        result: typeof content === 'string' ? content : '',
      })
    }
    return out
  }
  return out
}

/** `SpiralState.snapshot()` (state.py:238): the compact summary the envelope learns from. */
export interface SpiralSnapshot {
  turns: number
  edit_churn: number
  distinct_edit_files: number
  error_outputs: number
  test_runs: number
  stagnation: number
  repeated_fail_sigs: number
}

/** JSON form of the whole fold (upstream `__slots__` serialized; state.py:144 + turn.py:227). */
export interface SpiralStateDict {
  turns: number
  edit_counts: Record<string, number>
  edit_order: string[]
  error_outputs: number
  test_runs: number
  fail_sigs: Record<string, number>
  repeated_fail_sigs: number
  recent: string[]
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * Compact, incremental fold of one trajectory's spiral signals (`SpiralState`, state.py:141).
 *
 * The Maps (rather than plain objects) preserve insertion order exactly like a Python dict, so
 * `nudgeText`'s "busiest file" tie-break and the edit order are faithful.
 */
export class SpiralState implements SpiralSignals {
  turns = 0
  /** basename -> #edits */
  editCounts = new Map<string, number>()
  /** Ordered basenames of edit targets. */
  editOrder: string[] = []
  /** Tool outputs carrying an error/failure marker. */
  errorOutputs = 0
  /** Code-execution verification steps. */
  testRuns = 0
  /** Failure signature -> count. */
  failSigs = new Map<string, number>()
  /** # of failing outputs that REPEAT an earlier signature. */
  repeatedFailSigs = 0
  /** Leakage-safe rolling log of recent actions (process only, never content). */
  recent: string[] = []

  get editChurn(): number {
    let max = 0
    for (const count of this.editCounts.values()) if (count > max) max = count
    return max
  }

  get distinctEditFiles(): number {
    return this.editCounts.size
  }

  get stagnation(): number {
    let total = 0
    for (const count of this.failSigs.values()) total += count
    return total ? this.repeatedFailSigs / total : 0
  }

  /**
   * `SpiralState.update` (state.py:174). Fold one completed tool call into the state.
   *
   * `failed` is what the agent reported about the call -- `true` for a non-zero exit or a tool
   * error, `false` for success, `null` when it did not say -- and decides whether its output
   * can be a failing one: a call known to have succeeded is not, a content tool only when the
   * tool itself failed, and otherwise the output's own markers decide.
   */
  update(
    toolName: string | null | undefined,
    args: Record<string, unknown> | null | undefined,
    resultText: string | null | undefined,
    failed: boolean | null = null,
  ): void {
    this.turns += 1
    const a = asRecord(args)
    const tool = canonTool(toolName)
    let action = tool || '?'
    if (_EDIT_TOOLS.has(tool)) {
      const b = basename(firstString(a, ['path', 'filePath', 'file_path']))
      if (b) {
        this.editOrder.push(b)
        this.editCounts.set(b, (this.editCounts.get(b) ?? 0) + 1)
        action = `edit ${b}`
      }
    }
    const cmd = tool === 'bash' ? asString(a.command) : ''
    if (cmd) {
      const short = cmd.trim().replace(/\s+/g, ' ').slice(0, 90)
      action = `$ ${short}`
      if (TEST_RUN_RE.test(cmd)) this.testRuns += 1
    } else if (tool === 'grep' || tool === 'glob') {
      action = `${tool} ${asString(a.pattern).slice(0, 40)}`
    } else if (tool === 'view') {
      action = `view ${basename(firstString(a, ['path', 'file_path']))}`
    }
    const result = resultText ?? ''
    let fail: string | null = null
    const canFail = _CONTENT_TOOLS.has(tool) ? failed === true : failed !== false
    if (result && canFail && errMatch(result)) {
      this.errorOutputs += 1
      const sig = failureSignature(result)
      if (sig) {
        fail = sig
        if (this.failSigs.has(sig)) this.repeatedFailSigs += 1
        this.failSigs.set(sig, (this.failSigs.get(sig) ?? 0) + 1)
      }
    }
    // Rolling leakage-safe action log: tool name / command / search / error SIGNATURE only.
    const tag = fail ? `  [err#${fail}]` : ''
    this.recent.push(`${String(this.turns).padStart(3, ' ')}: ${action}${tag}`)
    if (this.recent.length > 40) this.recent = this.recent.slice(-40)
  }

  /**
   * `recent_digest` (state.py:218): a compact, LEAKAGE-SAFE digest of the agent's RECENT
   * PROCESS for the trace-judge. `envelope` is passed as context so the judge can recognize an
   * abnormally-long trajectory as a likely dead end.
   */
  recentDigest(options: DigestOptions = {}): string {
    const n = options.n ?? 24
    const envelope = options.envelope ?? null
    let head =
      `turns=${this.turns} edit_churn=${this.editChurn} ` +
      `distinct_edit_files=${this.distinctEditFiles} ` +
      `error_outputs=${this.errorOutputs} test_runs=${this.testRuns} ` +
      `repeated_identical_failures=${this.repeatedFailSigs} ` +
      `stagnation=${this.stagnation.toFixed(2)}`
    if (envelope) {
      const ratio = envelope ? this.turns / envelope : 0
      head +=
        `\nrepo_context: tasks here usually RESOLVE within ~${formatFixed0(envelope)} ` +
        `turns; this trajectory is at ${this.turns} turns = ${ratio.toFixed(1)}x that ` +
        'typical length. Tests are still NOT green. A trajectory far past ' +
        'the typical resolved length with recurring failures is likely a ' +
        'dead-end loop, even if it touches many files.'
    }
    return `${head}\nRecent actions (oldest->newest):\n${this.recent.slice(-n).join('\n')}`
  }

  /** `SpiralState.snapshot` (state.py:238). */
  snapshot(): SpiralSnapshot {
    return {
      turns: this.turns,
      edit_churn: this.editChurn,
      distinct_edit_files: this.distinctEditFiles,
      error_outputs: this.errorOutputs,
      test_runs: this.testRuns,
      stagnation: pyRound(this.stagnation, 3),
      repeated_fail_sigs: this.repeatedFailSigs,
    }
  }
}

/** Serialize a state to its JSON form (upstream `state_to_dict`, turn.py:227). */
export function spiralStateToDict(state: SpiralState): SpiralStateDict {
  return {
    turns: state.turns,
    edit_counts: Object.fromEntries(state.editCounts),
    edit_order: [...state.editOrder],
    error_outputs: state.errorOutputs,
    test_runs: state.testRuns,
    fail_sigs: Object.fromEntries(state.failSigs),
    repeated_fail_sigs: state.repeatedFailSigs,
    recent: [...state.recent],
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function countMap(value: unknown): Map<string, number> {
  const out = new Map<string, number>()
  for (const [key, count] of Object.entries(asRecord(value))) {
    const n = numberOr(count, 0)
    if (n) out.set(key, n)
  }
  return out
}

/** Rebuild a state from its JSON form (upstream `state_from_dict`, turn.py:231). */
export function spiralStateFromDict(data?: SpiralStateDict | null): SpiralState {
  const st = new SpiralState()
  if (!data) return st
  st.turns = numberOr(data.turns, 0)
  st.editCounts = countMap(data.edit_counts)
  st.editOrder = asArray(data.edit_order).filter((x): x is string => typeof x === 'string')
  st.errorOutputs = numberOr(data.error_outputs, 0)
  st.testRuns = numberOr(data.test_runs, 0)
  st.failSigs = countMap(data.fail_sigs)
  st.repeatedFailSigs = numberOr(data.repeated_fail_sigs, 0)
  st.recent = asArray(data.recent).filter((x): x is string => typeof x === 'string')
  return st
}

/**
 * Fold a saved trajectory into its final state (`state_from_trajectory`, state.py:246),
 * without importing the trace layer: the caller supplies the already-parsed calls.
 */
export function stateFromCompletedCalls(
  calls: Iterable<{ name: string; args?: Record<string, unknown> | null; result?: string; ok?: boolean | null }>,
): SpiralState {
  const st = new SpiralState()
  for (const call of calls) {
    st.update(
      call.name,
      call.args ?? {},
      call.result ?? '',
      call.ok === undefined || call.ok === null ? null : !call.ok,
    )
  }
  return st
}
