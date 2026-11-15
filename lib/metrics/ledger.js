import { effectiveTokens, hasBreakdown, resolveModel, weightsFor, } from '../pricing/weights.js';
import { foldUsage } from '../storage/store.js';
/** Label used when a metric row carries usage but no model id at all. */
export const UNKNOWN_MODEL = '(unknown)';
/** Reports never run away on a corrupt metrics file; folding is bounded by the caller. */
const MAX_REPORT_ROWS = 1_000_000;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isRate(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
export function parsePriceTable(text) {
    const source = typeof text === 'string' ? text.trim() : '';
    if (!source)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch (error) {
        throw new Error(`token-economizer: price table is not valid JSON (${error.message})`);
    }
    if (!isRecord(parsed)) {
        throw new Error('token-economizer: price table must be a JSON object keyed by "provider/model"');
    }
    const table = {};
    for (const [rawKey, rawEntry] of Object.entries(parsed)) {
        const key = rawKey.trim();
        if (!key)
            throw new Error('token-economizer: price table contains an empty model key');
        if (!isRecord(rawEntry)) {
            throw new Error(`token-economizer: price entry for ${JSON.stringify(key)} must be an object`);
        }
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
            if (!isRate(rawEntry[field])) {
                throw new Error(`token-economizer: price entry for ${JSON.stringify(key)} needs a non-negative finite "${field}" rate`);
            }
        }
        table[key] = {
            input: rawEntry.input,
            output: rawEntry.output,
            cacheRead: rawEntry.cacheRead,
            cacheWrite: rawEntry.cacheWrite,
        };
    }
    return table;
}
/** Read one usage part from either the camelCase contract or an upstream snake_case row. */
function usagePart(usage, camel, snake) {
    const record = usage;
    const value = record[camel] ?? record[snake];
    return num(value);
}
/**
 * Measured USD cost of one usage record at one price entry.
 *
 * `reasoningTokens` is a subset of `outputTokens` in the Harness's `TokenUsage`
 * (dsh-token-meter rejects reasoning > output), so it is already inside the output
 * charge and is not added again. The table has a single cache-write rate; the 1-hour
 * split only affects the effective-token weighting, not this table.
 */
export function costFor(usage, price) {
    const input = usagePart(usage, 'inputTokens', 'input_tokens');
    const output = usagePart(usage, 'outputTokens', 'output_tokens');
    const cacheRead = usagePart(usage, 'cacheReadTokens', 'cache_read_input_tokens');
    const cacheWrite = usagePart(usage, 'cacheWriteTokens', 'cache_creation_input_tokens');
    return ((input * num(price.input) +
        output * num(price.output) +
        cacheRead * num(price.cacheRead) +
        cacheWrite * num(price.cacheWrite)) /
        1_000_000);
}
/** True when the record actually accounts for any tokens. */
function hasAnyUsage(usage) {
    if (!usage)
        return false;
    const parts = [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'reasoningTokens',
    ];
    for (const key of parts)
        if (num(usage[key]) > 0)
            return true;
    return num(usage.totalTokens) > 0;
}
/** Human-facing model identity used in report diagnostics. */
export function modelLabel(record) {
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model)
        return UNKNOWN_MODEL;
    const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
    return provider ? `${provider}/${model}` : model;
}
/** Price-table keys to try for one row, most specific first. */
function priceCandidates(record) {
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model)
        return [];
    const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
    const keys = [];
    if (provider)
        keys.push(`${provider}/${model}`);
    keys.push(model);
    const tail = resolveModel({ model, provider });
    if (tail) {
        if (provider)
            keys.push(`${provider}/${tail}`);
        if (tail !== model)
            keys.push(tail);
    }
    return [...new Set(keys)];
}
function findPrice(record, table) {
    for (const key of priceCandidates(record)) {
        const price = table[key];
        if (price)
            return price;
    }
    return null;
}
/** Caller-supplied, evidence-backed savings. `null` when the caller did not measure it. */
function measurableSaving(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;
    return Math.max(0, value);
}
function largestSkillBlock(rows) {
    let max = 0;
    for (const row of rows) {
        if (!row || row.kind !== 'skills')
            continue;
        if (typeof row.skillTokens === 'number' && Number.isFinite(row.skillTokens)) {
            max = Math.max(max, row.skillTokens);
        }
    }
    return max;
}
/**
 * Fold metric rows into one `UsageReport`.
 *
 * `rows` are expected to be the project's raw `MetricRecord[]`. The caller filters by
 * scope (`summarizeSession` / `summarizeProject` do it for you) and supplies the price
 * table; this function performs no I/O.
 */
export function buildUsageReport(rows, options = {}) {
    const input = (Array.isArray(rows) ? rows : []).slice(0, MAX_REPORT_ROWS);
    const folded = foldUsage(input);
    const prices = options.prices ?? {};
    let effective = 0;
    let cost = 0;
    let costKnown = true;
    const unavailableModels = new Set();
    for (const row of input) {
        if (!row || typeof row !== 'object' || !hasAnyUsage(row.usage))
            continue;
        const label = modelLabel(row);
        if (effective !== null) {
            const record = {
                model: row.model ?? null,
                provider: row.provider ?? null,
                ...row.usage,
            };
            const value = hasBreakdown(record)
                ? effectiveTokens(record)
                : // A legacy total needs no weights, but an UNKNOWN model still makes the number
                    // unverifiable: report "not measurable" rather than a total dressed up as cost.
                    weightsFor(record)
                        ? num(row.usage.totalTokens)
                        : null;
            if (value === null)
                effective = null;
            else
                effective += value;
        }
        const price = findPrice(row, prices);
        if (!price) {
            costKnown = false;
            const keys = priceCandidates(row);
            unavailableModels.add(keys[0] ?? label);
        }
        else {
            cost += costFor(row.usage, price);
        }
    }
    let prunedToolTokens = 0;
    if (typeof options.prunedToolTokensPerRequest === 'number' && Number.isFinite(options.prunedToolTokensPerRequest)) {
        prunedToolTokens = Math.max(0, options.prunedToolTokensPerRequest);
    }
    else if (Array.isArray(options.prunedTools)) {
        for (const tool of options.prunedTools) {
            if (tool && typeof tool.descriptionTokens === 'number' && Number.isFinite(tool.descriptionTokens)) {
                prunedToolTokens += Math.max(0, tool.descriptionTokens);
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
        injectedSkillTokens: typeof options.injectedSkillTokens === 'number' && Number.isFinite(options.injectedSkillTokens)
            ? Math.max(0, options.injectedSkillTokens)
            : largestSkillBlock(input),
        estimated: {
            prunedToolTokensPerRequest: prunedToolTokens,
            microskillWasteAvoidedTokens: measurableSaving(options.microskillWasteAvoidedTokens),
            loopWasteAvoidedTokens: measurableSaving(options.loopWasteAvoidedTokens),
        },
        firstSeenAt: folded.firstSeenAt,
        updatedAt: folded.updatedAt,
    };
}
/**
 * Report for one session (`MetricRecord.sessionId`), including its subagent rows only if
 * they were recorded under the same session id.
 */
export function summarizeSession(rows, sessionId, options = {}) {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const filtered = (Array.isArray(rows) ? rows : []).filter((row) => row && row.sessionId === id);
    const projectId = options.projectId ?? filtered[0]?.projectId ?? null;
    return buildUsageReport(filtered, { ...options, scope: 'session', sessionId: id, projectId });
}
/** Report for one project (`MetricRecord.projectId`), across every recorded session. */
export function summarizeProject(rows, projectId, options = {}) {
    const id = typeof projectId === 'string' ? projectId : '';
    const filtered = (Array.isArray(rows) ? rows : []).filter((row) => row && row.projectId === id);
    return buildUsageReport(filtered, { ...options, scope: 'project', projectId: id });
}
