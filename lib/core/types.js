/**
 * Shared value types for the Token Economizer.
 *
 * Everything in this file is plain JSON-serializable data: the same shapes are
 * written to the local store, sent through the plugin's HTTP API, and used by
 * the unit tests. Keep it free of DSH/Cordis imports so the engine can be
 * tested without a Harness.
 */
export const EMPTY_USAGE = Object.freeze({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
});
/** Add two usage records field by field. */
export function addUsage(a, b) {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
        totalTokens: a.totalTokens + b.totalTokens,
    };
}
