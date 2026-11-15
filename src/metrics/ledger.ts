/**
 * The one honest cost definition the plugin publishes.
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0.
 * Upstream sources:
 *   - `tokeneconomizer/ledger.py` — one cost definition for every mechanism:
 *     `task_cost(t) = effective_exec(t) + overhead(t)`, with every mechanism's
 *     paid overhead charged to the same account as the work it hopes to save.
 *   - `tokeneconomizer/pricing.py` — cache-aware `effective_tokens` and the
 *     per-model weight table, re-exported through `pricing/weights.ts`.
 *
 * This module folds a project's `metrics.jsonl` rows into the `UsageReport` the
 * settings page and CLI render. It obeys three honesty rules:
 *
 *   1. Raw token totals are not a cost. `effectiveTokens` is the cache-aware
 *      fresh-input-equivalent figure from `pricing/weights.ts`; when ANY contributing
 *      model is unknown it is `null`, never a partial or guessed number.
 *   2. USD is measured only from the user's own price table. If a contributing model
 *      has no entry, `costUsd` is `null` and `costUnavailableModels` names every missing
 *      id. There is no fallback price list and no "savings" invented by subtraction.
 *   3. The `estimated` block is explicitly an estimate. Pruned tool schema tokens are
 *      the sum of the pruned rows' description-token estimates (one copy per request,
 *      no recurrence multiplier). Micro-skill and loop savings stay `null` unless the
 *      caller supplies a number derived from measured evidence; this module never
 *      derives one from wishful arithmetic.
 */
import type { MetricRecord, ToolStat, UsageCounts, UsageReport } from '../core/types.js'
import {
  effectiveTokens,
  hasBreakdown,
  resolveModel,
  weightsFor,
  type PricingRecord,
} from '../pricing/weights.js'
import { foldUsage } from '../storage/store.js'

/** USD price per MILLION tokens for one `provider/model` route. */
export interface PriceEntry {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** User-supplied price table, keyed by `provider/model` (a bare model id also works). */
export type PriceTable = Record<string, PriceEntry>

/** Label used when a metric row carries usage but no model id at all. */
export const UNKNOWN_MODEL = '(unknown)'

/** Reports never run away on a corrupt metrics file; folding is bounded by the caller. */
const MAX_REPORT_ROWS = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Parse and validate the optional JSON price table from configuration.
 *
 * Shape (USD per million tokens):
 *
 *     {"provider/model": {"input": 1, "output": 4, "cacheRead": 0.1, "cacheWrite": 1.25}}
 *
 * An empty/whitespace string means "no prices configured" and returns `{}`. Anything
 * else must be a JSON object whose entries carry all four non-negative finite rates;
 * a malformed table throws instead of silently pricing part of a session at zero.
 */
export function parsePriceTable(text: string): PriceTable {
  const source = typeof text === 'string' ? text.trim() : ''
  if (!source) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`token-economizer: price table is not valid JSON (${(error as Error).message})`)
  }
  if (!isRecord(parsed)) {
    throw new Error('token-economizer: price table must be a JSON object keyed by "provider/model"')
  }
  const table: PriceTable = {}
  for (const [rawKey, rawEntry] of Object.entries(parsed)) {
    const key = rawKey.trim()
    if (!key) throw new Error('token-economizer: price table contains an empty model key')
    if (!isRecord(rawEntry)) {
      throw new Error(`token-economizer: price entry for ${JSON.stringify(key)} must be an object`)
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      if (!isRate(rawEntry[field])) {
        throw new Error(
          `token-economizer: price entry for ${JSON.stringify(key)} needs a non-negative finite "${field}" rate`,
        )
      }
    }
    table[key] = {
      input: rawEntry.input as number,
      output: rawEntry.output as number,
      cacheRead: rawEntry.cacheRead as number,
      cacheWrite: rawEntry.cacheWrite as number,
    }
  }
  return table
}

/** Read one usage part from either the camelCase contract or an upstream snake_case row. */
function usagePart(
  usage: Partial<UsageCounts> | PricingRecord,
  camel: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens',
  snake: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens',
): number {
  const record = usage as Record<string, unknown>
  const value = record[camel] ?? record[snake]
  return num(value)
}

/**
 * Measured USD cost of one usage record at one price entry.
 *
 * `reasoningTokens` is a subset of `outputTokens` in the Harness's `TokenUsage`
 * (dsh-token-meter rejects reasoning > output), so it is already inside the output
 * charge and is not added again. The table has a single cache-write rate; the 1-hour
 * split only affects the effective-token weighting, not this table.
 */
export function costFor(
  usage: Partial<UsageCounts> | PricingRecord,
  price: PriceEntry,
): number {
  const input = usagePart(usage, 'inputTokens', 'input_tokens')
  const output = usagePart(usage, 'outputTokens', 'output_tokens')
  const cacheRead = usagePart(usage, 'cacheReadTokens', 'cache_read_input_tokens')
  const cacheWrite = usagePart(usage, 'cacheWriteTokens', 'cache_creation_input_tokens')
  return (
    (input * num(price.input) +
      output * num(price.output) +
      cacheRead * num(price.cacheRead) +
      cacheWrite * num(price.cacheWrite)) /
    1_000_000
  )
}

/** True when the record actually accounts for any tokens. */
function hasAnyUsage(usage: UsageCounts | undefined): usage is UsageCounts {
  if (!usage) return false
  const parts: Array<keyof UsageCounts> = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ]
  for (const key of parts) if (num(usage[key]) > 0) return true
  return num(usage.totalTokens) > 0
}

/** Human-facing model identity used in report diagnostics. */
export function modelLabel(record: Pick<MetricRecord, 'model' | 'provider'>): string {
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (!model) return UNKNOWN_MODEL
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  return provider ? `${provider}/${model}` : model
}

/** Price-table keys to try for one row, most specific first. */
function priceCandidates(record: Pick<MetricRecord, 'model' | 'provider'>): string[] {
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (!model) return []
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const keys: string[] = []
  if (provider) keys.push(`${provider}/${model}`)
  keys.push(model)
  const tail = resolveModel({ model, provider })
  if (tail) {
    if (provider) keys.push(`${provider}/${tail}`)
    if (tail !== model) keys.push(tail)
  }
  return [...new Set(keys)]
}

function findPrice(record: Pick<MetricRecord, 'model' | 'provider'>, table: PriceTable): PriceEntry | null {
  for (const key of priceCandidates(record)) {
    const price = table[key]
    if (price) return price
  }
  return null
}

/** Caller-supplied, evidence-backed savings. `null` when the caller did not measure it. */
function measurableSaving(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, value)
}

/** Options accepted by `buildUsageReport`, `summarizeSession` and `summarizeProject`. */
export interface ReportOptions {
  scope?: UsageReport['scope']
  projectId?: string | null
  sessionId?: string | null
  /** Parsed price table (`parsePriceTable(config.priceTable)`). */
  prices?: PriceTable | null
  /** Rows for tools currently pruned, used for the labeled per-request estimate. */
  prunedTools?: readonly Pick<ToolStat, 'name' | 'descriptionTokens'>[]
  /** Explicit estimate override; wins over `prunedTools` when both are supplied. */
  prunedToolTokensPerRequest?: number
  /** Measured micro-skill waste avoided, if the caller has evidence for it. */
  microskillWasteAvoidedTokens?: number | null
  /** Measured loop waste avoided, if the caller has evidence for it. */
  loopWasteAvoidedTokens?: number | null
  /** Token size of the injected micro-skill block (else the largest recorded block). */
  injectedSkillTokens?: number
}

function largestSkillBlock(rows: readonly MetricRecord[]): number {
  let max = 0
  for (const row of rows) {
    if (!row || row.kind !== 'skills') continue
    if (typeof row.skillTokens === 'number' && Number.isFinite(row.skillTokens)) {
      max = Math.max(max, row.skillTokens)
    }
  }
  return max
}

/**
 * Fold metric rows into one `UsageReport`.
 *
 * `rows` are expected to be the project's raw `MetricRecord[]`. The caller filters by
 * scope (`summarizeSession` / `summarizeProject` do it for you) and supplies the price
 * table; this function performs no I/O.
 */
export function buildUsageReport(
  rows: readonly MetricRecord[],
  options: ReportOptions = {},
): UsageReport {
  const input = (Array.isArray(rows) ? rows : []).slice(0, MAX_REPORT_ROWS)
  const folded = foldUsage(input)
  const prices: PriceTable = options.prices ?? {}

  let effective: number | null = 0
  let cost = 0
  let costKnown = true
  const unavailableModels = new Set<string>()

  for (const row of input) {
    if (!row || typeof row !== 'object' || !hasAnyUsage(row.usage)) continue
    const label = modelLabel(row)
    if (effective !== null) {
      const record: PricingRecord = {
        model: row.model ?? null,
        provider: row.provider ?? null,
        ...row.usage,
      }
      const value = hasBreakdown(record)
        ? effectiveTokens(record)
        : // A legacy total needs no weights, but an UNKNOWN model still makes the number
          // unverifiable: report "not measurable" rather than a total dressed up as cost.
          weightsFor(record)
          ? num(row.usage.totalTokens)
          : null
      if (value === null) effective = null
      else effective += value
    }
    const price = findPrice(row, prices)
    if (!price) {
      costKnown = false
      const keys = priceCandidates(row)
      unavailableModels.add(keys[0] ?? label)
    } else {
      cost += costFor(row.usage, price)
    }
  }

  let prunedToolTokens = 0
  if (typeof options.prunedToolTokensPerRequest === 'number' && Number.isFinite(options.prunedToolTokensPerRequest)) {
    prunedToolTokens = Math.max(0, options.prunedToolTokensPerRequest)
  } else if (Array.isArray(options.prunedTools)) {
    for (const tool of options.prunedTools) {
      if (tool && typeof tool.descriptionTokens === 'number' && Number.isFinite(tool.descriptionTokens)) {
        prunedToolTokens += Math.max(0, tool.descriptionTokens)
      }
    }
  }

  return {
    scope: options.scope ?? 'all',
    projectId: options.projectId ?? null,
    sessionId: options.sessionId ?? null,
    sessions: folded.sessions,
    modelRequests: folded.modelRequests,
    toolCalls: folded.toolCalls,
    failedToolCalls: folded.failedToolCalls,
    loopInterventions: folded.loopInterventions,
    prunedTools: Array.isArray(options.prunedTools) ? options.prunedTools.length : folded.prunedTools,
    activeSkills: folded.activeSkills,
    usage: folded.usage,
    effectiveTokens: effective,
    costUsd: costKnown ? cost : null,
    costUnavailableModels: [...unavailableModels].sort((a, b) => a.localeCompare(b)),
    pluginUsage: folded.pluginUsage,
    injectedSkillTokens:
      typeof options.injectedSkillTokens === 'number' && Number.isFinite(options.injectedSkillTokens)
        ? Math.max(0, options.injectedSkillTokens)
        : largestSkillBlock(input),
    estimated: {
      prunedToolTokensPerRequest: prunedToolTokens,
      microskillWasteAvoidedTokens: measurableSaving(options.microskillWasteAvoidedTokens),
      loopWasteAvoidedTokens: measurableSaving(options.loopWasteAvoidedTokens),
    },
    firstSeenAt: folded.firstSeenAt,
    updatedAt: folded.updatedAt,
  }
}

/**
 * Report for one session (`MetricRecord.sessionId`), including its subagent rows only if
 * they were recorded under the same session id.
 */
export function summarizeSession(
  rows: readonly MetricRecord[],
  sessionId: string,
  options: ReportOptions = {},
): UsageReport {
  const id = typeof sessionId === 'string' ? sessionId : ''
  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => row && row.sessionId === id)
  const projectId = options.projectId ?? filtered[0]?.projectId ?? null
  return buildUsageReport(filtered, { ...options, scope: 'session', sessionId: id, projectId })
}

/** Report for one project (`MetricRecord.projectId`), across every recorded session. */
export function summarizeProject(
  rows: readonly MetricRecord[],
  projectId: string,
  options: ReportOptions = {},
): UsageReport {
  const id = typeof projectId === 'string' ? projectId : ''
  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => row && row.projectId === id)
  return buildUsageReport(filtered, { ...options, scope: 'project', projectId: id })
}
