/**
 * Cache-aware effective-cost weighting for token accounting.
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0.
 * Upstream sources:
 *   - `tokeneconomizer/pricing.py` (`MODEL_WEIGHTS`, `WEIGHTS_CLAUDE`,
 *     `resolve_model`, `weights_for`, `has_breakdown`, `effective_tokens`,
 *     `approx_tokens`, `cache_write_1h_tokens`).
 *   - `tokeneconomizer/ledger.py` (the one cost definition the mechanisms share).
 *
 * `tokens_total` (= prompt_tokens + completion_tokens, summed over every model call)
 * counts EVERY token at full weight. In an agent loop the conversation is re-sent each
 * turn, so ~90%+ of `tokens_total` is `cache_read_input_tokens` — re-read context that
 * the provider bills at a small fraction of fresh input. Reporting raw `tokens_total`
 * therefore (a) OVERSTATES the cost of cheap cached re-reads and (b) UNDERSTATES the
 * cost of expensive output tokens. This biases A/B comparisons: a method that mainly
 * prunes cached re-reads looks better than its real-$ effect, while one that adds output
 * / fresh-input (e.g. error-retry loops, negative transfer) looks cheaper than it is.
 *
 * `effectiveTokens()` reweights the per-task token breakdown into fresh-input-token
 * EQUIVALENTS using real price ratios, so cost A/Bs reflect real spend. Ratios are keyed
 * on the exact BILLED MODEL ID (`weightsFor` -> `MODEL_WEIGHTS`), because families are
 * NOT uniform — e.g. gpt-5.6-sol bills output 6x + cache_write 1.25x, gpt-5.3-codex
 * output 8x + cache_write 0x, Claude output 5x + cache_write 1.25x. The table is a
 * snapshot of the providers' published per-model prices; a billed id with no entry is
 * reported as UNKNOWN (`null`, see `weightsFor`) rather than silently mispriced.
 *
 *     model id (example)              input  cache_read  cache_write  output
 *     claude-* (Opus/Sonnet/Haiku)     1.00     0.10        1.25        5.00
 *     gpt-5.6-sol (codex default)      1.00     0.10        1.25        6.00
 *     gpt-5.3-codex                    1.00     0.0971      0.00        8.00
 *     gpt-5-codex (OpenAI direct)      1.00     0.10        1.00        8.00
 *
 * Anthropic bills a cache write by its lifetime: 1.25x for the 5-minute cache, 2x for
 * the 1-hour one. A row that says how many of its cache-write tokens went to the 1-hour
 * cache (`cacheWrite1hTokens`, or the upstream `cache_creation_1h_input_tokens`) has
 * those priced at the table's `cacheWrite1h`; a table without that entry, or a row
 * without the field, prices every cache-write token at `cacheWrite` as before.
 *
 * Claude's cache-hit price is not uniform either: Anthropic bills a cache hit at 0.1x
 * input, but at 0.05x on Opus 5.5 and Sonnet 5.5 and at 0.025x on Fable and Mythos 5.1
 * and 5.2 (`_CLAUDE_CACHE_READ`). Cache hits are 90% or more of an agent session's
 * tokens, so a wrong ratio moves the whole figure.
 *
 * Callers may override with an explicit `effectiveTokens(rec, weights)`.
 * When the per-task breakdown is absent (older runs), `effectiveTokens()` falls back to
 * `tokensTotal` at full weight so nothing crashes — call `hasBreakdown()` to detect this.
 *
 * DSH note: `UsageCounts.reasoningTokens` is a SUBSET of `outputTokens` in the Harness's
 * own `TokenUsage` (dsh-token-meter rejects `reasoningTokens > outputTokens`), so it is
 * deliberately not weighted again here; doing so would double-bill reasoning output.
 */

/** Fresh-input-token-equivalent weight table for one billed model id (input := 1). */
export interface ModelWeights {
  input: number
  cacheRead: number
  cacheWrite: number
  /** Price of the part of `cacheWrite` written to Anthropic's 1-hour cache. */
  cacheWrite1h?: number
  output: number
}

/**
 * A token-bearing record. Accepts the plugin's `UsageCounts` shape and the upstream
 * Python rows' snake_case keys, so parity vectors and imported metrics both work.
 */
export interface PricingRecord {
  model?: string | null
  provider?: string | null
  /** Upstream billing agent id; only used for `AGENT_DEFAULT_MODEL`. */
  agent?: string | null

  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  cacheWrite1hTokens?: number | null
  reasoningTokens?: number | null
  totalTokens?: number | null

  // Upstream snake_case aliases (`tokeneconomizer/pricing.py` row keys).
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation_1h_input_tokens?: number | null
  /** An Anthropic `usage` object as it arrives (`cache_creation.ephemeral_1h_input_tokens`). */
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null
  cacheCreation?: { ephemeral_1h_input_tokens?: number | null } | null
  tokens_total?: number | null
}

/**
 * Per-model-id price ratios (fresh-input-token equivalents; input := 1.0).
 *
 * Pricing MUST match the exact model id that was billed — model families are NOT
 * uniform (e.g. gpt-5.6-sol bills output 6x + cache_write 1.25x, while gpt-5.3-codex
 * bills output 8x + cache_write 0x). So we key on the concrete model id, not a family
 * heuristic, and report a missing id as unknown (see `weightsFor`).
 *
 * Source: the providers' published per-model prices, snapshot 2026-07-27 (upstream
 * `MODEL_WEIGHTS`); ratios = price / input_price. Update the table when a provider
 * changes its prices.
 *
 * NB (verified upstream): codex-cli 0.145.0's built-in DEFAULT model is `gpt-5.6-sol`
 * (the resolved id is recorded in codex's session rollout file, not in its --json
 * transcript). So an unpinned `codex` run bills sol.
 */
export const MODEL_WEIGHTS: Readonly<Record<string, ModelWeights>> = Object.freeze({
  // --- per-model price snapshot (2026-07-27) ------------------------------
  'claude-haiku-4-5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0, cacheWrite1h: 2.0 },
  'claude-opus-4-6': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0, cacheWrite1h: 2.0 },
  'claude-opus-4-7': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0, cacheWrite1h: 2.0 },
  'claude-opus-4-8': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0, cacheWrite1h: 2.0 },
  'claude-opus-5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0, cacheWrite1h: 2.0 },
  'claude-sonnet-4-5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0, cacheWrite1h: 2.0 },
  'claude-sonnet-4-6': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0, cacheWrite1h: 2.0 },
  'claude-sonnet-5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0, cacheWrite1h: 2.0 },
  'gemini-2.5-pro': { input: 1.0, cacheRead: 0.096, cacheWrite: 0.0, output: 8.0 },
  'gemini-3-flash-preview': { input: 1.0, cacheRead: 0.1, cacheWrite: 0.0, output: 6.0 },
  'gemini-3.1-pro-preview': { input: 1.0, cacheRead: 0.1, cacheWrite: 0.0, output: 6.0 },
  'gemini-3.5-flash': { input: 1.0, cacheRead: 0.1, cacheWrite: 0.0, output: 6.0 },
  'gemini-3.6-flash': { input: 1.0, cacheRead: 0.1, cacheWrite: 0.0, output: 5.0 },
  'gpt-5-mini': { input: 1.0, cacheRead: 0.08, cacheWrite: 0.0, output: 8.0 },
  'gpt-5.3-codex': { input: 1.0, cacheRead: 0.0971, cacheWrite: 0.0, output: 8.0 },
  'gpt-5.4': { input: 1.0, cacheRead: 0.1, cacheWrite: 0.0, output: 6.0 },
  'gpt-5.4-mini': { input: 1.0, cacheRead: 0.0933, cacheWrite: 0.0, output: 6.0 },
  'gpt-5.5': { input: 1.0, cacheRead: 0.1, cacheWrite: 0.0, output: 6.0 },
  'gpt-5.6-luna': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 6.0 },
  'gpt-5.6-sol': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 6.0 },
  'gpt-5.6-terra': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.248, output: 6.0 },
  'mai-code-1-flash-picker': { input: 1.0, cacheRead: 0.0933, cacheWrite: 0.0, output: 6.0 },
  // --- OpenAI-direct-only ids (public per-1M pricing; not in copilot catalog) ----
  // gpt-5/5.1 & *-codex: $1.25 in / $0.125 cached / $10 out  => cr 0.10, out 8.0
  'gpt-5': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.0, output: 8.0 },
  'gpt-5.1': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.0, output: 8.0 },
  'gpt-5-codex': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.0, output: 8.0 },
  'gpt-5.1-codex': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.0, output: 8.0 },
  'gpt-5.1-codex-max': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.0, output: 8.0 },
  'gpt-5.2-codex': { input: 1.0, cacheRead: 0.1, cacheWrite: 1.0, output: 8.0 },
  // codex-mini-latest: $1.50 in / $0.375 cached / $6.00 out  => cr 0.25, out 4.0
  'codex-mini-latest': { input: 1.0, cacheRead: 0.25, cacheWrite: 1.0, output: 4.0 },
})

/**
 * Billed model id for an agent when a row does NOT pin one (`rec.model` empty).
 * Upstream maps codex to its built-in default, `gpt-5.6-sol`.
 */
export const AGENT_DEFAULT_MODEL: Readonly<Record<string, string>> = Object.freeze({
  codex: 'gpt-5.6-sol',
})

/**
 * Claude-family price ratios (Opus/Sonnet/Haiku share them, except the cache-hit ratio
 * of a few models: see `_CLAUDE_CACHE_READ`). Also the value of the back-compat
 * `WEIGHTS` alias.
 */
export const WEIGHTS_CLAUDE: ModelWeights = Object.freeze({
  input: 1.0, // input_tokens = fresh/uncached prompt tokens
  cacheRead: 0.1, // cache_read_input_tokens
  cacheWrite: 1.25, // cache_creation_input_tokens (the 5-minute cache)
  cacheWrite1h: 2.0, // the part written to the 1-hour cache
  output: 5.0, // output_tokens (completion)
})

/** Back-compat alias: modules written against `pricing.WEIGHTS` mean the Claude curve. */
export const WEIGHTS: ModelWeights = WEIGHTS_CLAUDE

/**
 * Claude models whose cache hits are not billed at 0.1x input (Anthropic's price list;
 * upstream `_CLAUDE_CACHE_READ`). Matched on the id with dots as dashes, so a router's
 * `claude-sonnet-5.5` and a dated snapshot match too.
 */
const CLAUDE_CACHE_READ: ReadonlyArray<readonly [RegExp, number]> = Object.freeze([
  [/claude-(opus|sonnet)-5-5\b/, 0.05] as const,
  [/claude-(fable|mythos)-5-[12]\b/, 0.025] as const,
])

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** First numeric value among the given keys; `undefined`/`null`/NaN are skipped. */
function firstNumber(record: PricingRecord | null | undefined, ...keys: Array<keyof PricingRecord>): number {
  if (!record || typeof record !== 'object') return 0
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key]
    if (isFiniteNumber(value)) return value
  }
  return 0
}

/** The Claude curve for a lower-cased claude-* id, with the model's own cache-hit ratio. */
function claudeWeights(key: string): ModelWeights {
  const name = key.replaceAll('.', '-')
  for (const [pattern, cacheRead] of CLAUDE_CACHE_READ) {
    if (pattern.test(name)) return { ...WEIGHTS_CLAUDE, cacheRead }
  }
  return WEIGHTS_CLAUDE
}

/**
 * The billed model id for a row: its explicit `model`, else the agent's default billed
 * model (`AGENT_DEFAULT_MODEL`), else `null`.
 *
 * A router's `provider/model` id names a ROUTE, not a price: Copilot's BYOK through a
 * router such as OpenRouter bills `anthropic/claude-haiku-4.5`, whose price is the
 * tail's. Stripping it here is safe because no MODEL_WEIGHTS key contains a slash.
 */
export function resolveModel(record: PricingRecord | null | undefined): string | null {
  if (!record || typeof record !== 'object') return null
  const explicit = typeof record.model === 'string' ? record.model.trim() : ''
  if (explicit) {
    return explicit.includes('/') ? explicit.slice(explicit.lastIndexOf('/') + 1) : explicit
  }
  const agent = typeof record.agent === 'string' ? record.agent.trim().toLowerCase() : ''
  if (!agent) return null
  return AGENT_DEFAULT_MODEL[agent] ?? null
}

/**
 * Pick the fresh-input-equivalent weight table for a row by its BILLED MODEL ID.
 *
 * Resolution (pricing must match the model id):
 *   * resolve the billed id (`resolveModel`) — explicit `model`, else agent default;
 *   * id in `MODEL_WEIGHTS`       -> that model's exact ratios;
 *   * id is a `claude-*` variant  -> Claude curve (covers dotted ids like claude-opus-4.8
 *                                     not in the catalog snapshot), with the model's own
 *                                     cache-hit ratio where it differs;
 *   * id present but UNPRICED     -> `null` (unknown). Upstream raises ValueError here;
 *                                     returning `null` lets the ledger report the unknown
 *                                     model instead of crashing the observer;
 *   * no resolvable id at all     -> `null` (unknown).
 *
 * DEVIATION from upstream: `pricing.weights_for` falls back to the Claude curve when a
 * row names no model, for byte-identical legacy benchmark rows. DSH always knows the
 * session's model route, so an unpinned row is genuine evidence debt; silently pricing
 * it at Claude's ratios (or at 1.0) would misprice every DeepSeek/other-provider token.
 * Callers that want the legacy curve can pass `WEIGHTS_CLAUDE` explicitly to
 * `effectiveTokens`.
 */
export function weightsFor(record: PricingRecord | null | undefined): ModelWeights | null {
  const modelId = resolveModel(record)
  if (!modelId) return null
  const key = modelId.toLowerCase()
  if (key in MODEL_WEIGHTS) return MODEL_WEIGHTS[key]
  if (key.includes('claude')) return claudeWeights(key)
  return null
}

/**
 * True when the record carries the per-task token breakdown needed for cache-aware
 * weighting (i.e. `input_tokens` is populated). Mirrors upstream `has_breakdown`.
 */
export function hasBreakdown(record: PricingRecord | null | undefined): boolean {
  if (!record || typeof record !== 'object') return false
  const value = record.inputTokens ?? record.input_tokens
  return value !== null && value !== undefined
}

/**
 * How many of a usage breakdown's cache-write tokens went to the 1-hour cache.
 *
 * Reads `cacheWrite1hTokens`, else the flat `cache_creation_1h_input_tokens` a session
 * reader records, else the `cacheCreation.ephemeral_1h_input_tokens` of an Anthropic
 * `usage` object as it arrives. Never more than the cache-write total, of which it is a
 * part; 0 when neither says.
 */
export function cacheWrite1hTokens(record: PricingRecord | null | undefined): number {
  if (!record || typeof record !== 'object') return 0
  let value: unknown = record.cacheWrite1hTokens ?? record.cache_creation_1h_input_tokens
  if (value === null || value === undefined) {
    const split = record.cacheCreation ?? record.cache_creation
    if (split && typeof split === 'object') value = split.ephemeral_1h_input_tokens
  }
  const total = firstNumber(record, 'cacheWriteTokens', 'cache_creation_input_tokens')
  if (!isFiniteNumber(value)) return 0
  const count = Math.trunc(value)
  return Math.max(0, Math.min(count, total))
}

/**
 * Cache-aware effective cost of one task, in fresh-input-token equivalents.
 *
 * Uses the token breakdown (input / cache_read / cache_creation / output) when present,
 * with the 1-hour share of the cache writes at its own price where the row and the
 * weight table both name it; otherwise falls back to `tokens_total` at full weight
 * (legacy rows). The weight table is chosen per row (`weightsFor`) from its model unless
 * an explicit `weights=` is passed.
 *
 * Returns `null` when a breakdown exists but the billed model is unknown (upstream
 * raises here; the plugin reports "not measurable" instead of inventing a number).
 * Returns 0 when neither breakdown nor total exists. `weights === null` explicitly
 * marks the model unknown.
 */
export function effectiveTokens(record: PricingRecord | null | undefined, weights?: ModelWeights | null): number | null {
  const chosen = weights === undefined ? weightsFor(record) : weights
  if (hasBreakdown(record)) {
    if (!chosen) return null
    const input = firstNumber(record, 'inputTokens', 'input_tokens')
    const cacheRead = firstNumber(record, 'cacheReadTokens', 'cache_read_input_tokens')
    const cacheWrite = firstNumber(record, 'cacheWriteTokens', 'cache_creation_input_tokens')
    const output = firstNumber(record, 'outputTokens', 'output_tokens')
    const cacheWrite1h = cacheWrite1hTokens(record)
    const oneHourWeight = chosen.cacheWrite1h ?? chosen.cacheWrite
    return (
      input * chosen.input +
      cacheRead * chosen.cacheRead +
      (cacheWrite - cacheWrite1h) * chosen.cacheWrite +
      cacheWrite1h * oneHourWeight +
      output * chosen.output
    )
  }
  const total = record?.totalTokens ?? record?.tokens_total
  return isFiniteNumber(total) ? total : 0
}

/**
 * A character-count estimate of a text's tokens (~4 characters each).
 * Upstream `approx_tokens`; code points are counted so astral characters match Python's
 * `len()` rather than JavaScript's UTF-16 length.
 */
export function approxTokens(text: string): number {
  const codePoints = Array.from(typeof text === 'string' ? text : '').length
  return Math.max(1, Math.floor(codePoints / 4))
}

// --- Upstream-spelled aliases (parity consumers, ported Python names) ---------
export const resolve_model = resolveModel
export const weights_for = weightsFor
export const has_breakdown = hasBreakdown
export const effective_tokens = effectiveTokens
export const approx_tokens = approxTokens
export const cache_write_1h_tokens = cacheWrite1hTokens
