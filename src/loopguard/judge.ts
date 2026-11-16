/**
 * The loop guard's two optional paid calls: a stuck judge and a redirect writer.
 *
 * Port of `tokeneconomizer/loopguard/judge.py` (Microsoft TokenEconomizer, Apache-2.0,
 * commit 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0).
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit 7042ea8.
 *
 * Both read the same leakage-safe digest of the agent's recent actions (`SpiralState` `recentDigest`:
 * commands, searches, edited file basenames, error signatures -- never file contents or the
 * task text).
 *
 * HOST ADAPTATION: upstream receives `(raw_text, usage)` from a synchronous runner and charges
 * effective tokens to the session ledger. Here the caller injects an async
 * `callModel(system, user, maxTokens, signal)` and owns timeout/abort and token accounting, so
 * this module performs no HTTP/LLM call itself. It fails open: any runner error becomes an
 * ambiguous verdict, never a thrown error.
 */

/** Without a judge call the caller treats the verdict as ambiguous (upstream `None`). */
export type StuckVerdict = boolean | null

/** The parsed judge output (`{stuck, confidence, reason}`). */
export interface JudgeVerdict {
  /** true = stuck, false = productive, null = ambiguous / no usable answer. */
  stuck: StuckVerdict
  /** 0.0-1.0, clamped. */
  confidence: number
  /** Short leakage-safe justification. */
  reason: string
}

/** A gated verdict: `stuck` AND confidence at/above the caller's threshold. */
export interface JudgeEvaluation extends JudgeVerdict {
  /** True when this verdict is confident enough to drive intervention. */
  gated: boolean
}

/**
 * Injected model call. The caller owns the provider, token accounting, and (importantly) the
 * timeout: it should abort `signal` and/or reject after its configured budget.
 */
export type LoopModelCall = (
  system: string,
  user: string,
  maxTokens: number,
  signal: AbortSignal,
) => Promise<string>

export interface JudgeCallOptions {
  /** Maximum output tokens requested from the model. */
  maxTokens?: number
  /** Aborted by the caller's timeout. */
  signal?: AbortSignal
}

/** Default completion budget for the JSON verdict. */
export const JUDGE_MAX_TOKENS = 220
/** Default completion budget for the plain-text redirect. */
export const NUDGE_MAX_TOKENS = 200
/** Upstream caps a written redirect at 1200 characters. */
export const NUDGE_MAX_CHARS = 1200

/** `STUCK_JUDGE_SYSTEM` (judge.py:15-27), verbatim. */
export const STUCK_JUDGE_SYSTEM: string =
  'You monitor an AI coding agent that is partway through ONE task in a software repo. ' +
  'A cheap heuristic flagged its recent process as a possible UNPRODUCTIVE LOOP. Read ' +
  'the leakage-safe digest of its RECENT actions and judge whether it is genuinely ' +
  'STUCK — repeating the same kind of edit/test/failure with no progress toward green ' +
  'tests, unlikely to recover if it keeps going the same way — versus still making ' +
  'real progress (changing failures, narrowing the problem, exploring new hypotheses).\n\n' +
  "Judge ONLY the workflow from the digest; do NOT infer the task's solution or which " +
  'lines to change. Favor SPARING (stuck=false) when there is any sign of progress; ' +
  'only return stuck=true with high confidence for a clear, repetitive dead-end.\n' +
  'Return ONLY a JSON object: {"stuck": bool, "confidence": <0.0-1.0>, ' +
  '"reason": "<short leakage-safe justification>"}.'

/** `NUDGE_WRITER_SYSTEM` (judge.py:66-80), verbatim. */
export const NUDGE_WRITER_SYSTEM: string =
  'An AI coding agent is stuck in a REPETITIVE, UNPRODUCTIVE loop partway through one ' +
  'task in a software repo. You are given a leakage-safe digest of its RECENT ACTIONS ' +
  'only (tool names, shell commands, searched patterns, edited file BASENAMES, and ' +
  'error SIGNATURES — never file contents or the task description). Write a SHORT ' +
  'redirect (2-4 sentences) addressed to the agent that: (1) names the specific ' +
  'repetitive pattern you actually see in the digest (e.g. re-editing the same file, ' +
  're-running the same test to the same failure); (2) proposes a MATERIALLY DIFFERENT ' +
  'next step (a different file/root-cause to consider, re-reading the failing test\'s ' +
  'expectation, verifying a new hypothesis before editing again).\n' +
  'HARD CONSTRAINTS: Do NOT tell it to stop, give up, or reduce effort — only redirect. ' +
  "Do NOT infer the task's solution, name specific line numbers to change, or reference " +
  'any code/identifier you cannot see in the digest. Output ONLY the redirect as plain ' +
  'text — no preamble, no JSON, no headings.'

/** Upstream appends the digest and this close to the system prompt (`judge.py:40-41`). */
export function buildJudgeUserPrompt(digest: string): string {
  return `Recent process digest:\n${digest}\n\nReturn the JSON verdict:`
}

/** Upstream's writer prompt close (`judge.py:90-91`). */
export function buildNudgeUserPrompt(digest: string): string {
  return `Recent process digest:\n${digest}\n\nWrite the redirect:`
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal
}

/**
 * Strict parser for the judge's reply (`llm_stuck_judge`, judge.py:49-62).
 *
 * Upstream searches for `{.*}` (dotall, GREEDY -- the last closing brace wins), then reads the
 * object field by field; a malformed object leaves `{stuck: null, confidence: 0, reason: ""}`.
 * SAFETY DEVIATION: upstream applies Python's `bool()` to `stuck`, so the string "false" (or
 * the number `1`) would authorize an intervention. This parser accepts only a JSON boolean;
 * every other type is ambiguous (`null`), which fails open to the free heuristic/envelope path.
 */
export function parseJudgeReply(raw: string | null | undefined): JudgeVerdict {
  const verdict: JudgeVerdict = { stuck: null, confidence: 0, reason: '' }
  const text = raw ?? ''
  const match = text.match(/\{.*\}/s)
  if (!match) return verdict
  let obj: unknown
  try {
    obj = JSON.parse(match[0])
  } catch {
    return verdict
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return verdict
  const record = obj as Record<string, unknown>
  if (typeof record.stuck === 'boolean') verdict.stuck = record.stuck
  try {
    verdict.confidence = clamp01(Number(record.confidence ?? 0) || 0)
  } catch {
    verdict.confidence = 0
  }
  try {
    verdict.reason = String(record.reason ?? '').slice(0, 160)
  } catch {
    verdict.reason = ''
  }
  return verdict
}

/**
 * Strict parser for the redirect writer's reply (`llm_nudge_writer`, judge.py:96-102): plain
 * text, trimmed and capped at 1200 characters. Empty on a blank answer.
 */
export function parseNudgeReply(
  raw: string | null | undefined,
  maxChars = NUDGE_MAX_CHARS,
): string {
  const text = (raw ?? '').trim()
  if (!text) return ''
  return text.slice(0, Math.max(1, maxChars))
}

/**
 * The stuck judge (upstream `llm_stuck_judge`), with the model call injected.
 *
 * Returns an ambiguous verdict on a missing runner/digest or any runner error, which
 * `assessAbort` reads as "do not intervene" (upstream's `judge-throttled`).
 */
export async function judgeStuck(
  callModel: LoopModelCall | null | undefined,
  digest: string,
  options: JudgeCallOptions = {},
): Promise<JudgeVerdict> {
  if (!callModel || !digest) {
    return { stuck: null, confidence: 0, reason: 'no-runner' }
  }
  let raw: string
  try {
    raw = await callModel(
      STUCK_JUDGE_SYSTEM,
      buildJudgeUserPrompt(digest),
      options.maxTokens ?? JUDGE_MAX_TOKENS,
      options.signal ?? neverAbortedSignal(),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stuck: null, confidence: 0, reason: `runner-error:${message}`.slice(0, 60) }
  }
  return parseJudgeReply(raw)
}

/**
 * Ask the judge and apply the caller's confidence gate. Upstream keeps the gate in
 * `rules.assess_abort`; this convenience keeps it next to the verdict for direct callers.
 * Never throws: a runner failure is an ungated, ambiguous verdict.
 */
export async function evaluateWithJudge(
  judgeFn: LoopModelCall | null | undefined,
  digest: string,
  confidence: number,
  options: JudgeCallOptions = {},
): Promise<JudgeEvaluation> {
  const verdict = await judgeStuck(judgeFn, digest, options)
  return {
    ...verdict,
    gated: verdict.stuck === true && verdict.confidence >= confidence,
  }
}

/**
 * The redirect writer (upstream `llm_nudge_writer`), with the model call injected. Returns
 * `{text: ''}` on any failure so the caller falls back to `rules.nudgeText`.
 */
export async function writeRedirect(
  callModel: LoopModelCall | null | undefined,
  digest: string,
  options: JudgeCallOptions = {},
): Promise<{ text: string }> {
  if (!callModel || !digest) return { text: '' }
  let raw: string
  try {
    raw = await callModel(
      NUDGE_WRITER_SYSTEM,
      buildNudgeUserPrompt(digest),
      options.maxTokens ?? NUDGE_MAX_TOKENS,
      options.signal ?? neverAbortedSignal(),
    )
  } catch {
    return { text: '' }
  }
  return { text: parseNudgeReply(raw) }
}
