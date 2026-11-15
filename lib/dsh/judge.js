/**
 * One-shot judge model access.
 *
 * The judge uses the Harness's own LLM route (no separate API key, no external
 * server). Every constraint here exists to keep the judge optional and cheap:
 * hard timeout, output cap, no recursion, session/turn token budgets, and
 * fail-open on any error. Usage reported by the provider is returned to the
 * caller so it can be counted as Token Economizer overhead.
 */
import { randomUUID } from 'node:crypto';
import { addUsage, EMPTY_USAGE } from '../core/types.js';
/** Convert a provider `TokenUsage` into the plugin's disjoint counters. */
export function toUsageCounts(usage) {
    if (!usage || typeof usage !== 'object')
        return { ...EMPTY_USAGE };
    const input = numberOrZero(usage.inputTokens);
    const output = numberOrZero(usage.outputTokens);
    const cacheRead = numberOrZero(usage.cacheReadTokens);
    const cacheWrite = numberOrZero(usage.cacheWriteTokens);
    const reasoning = numberOrZero(usage.reasoningTokens);
    const total = numberOrZero(usage.totalTokens) || input + output + cacheRead + cacheWrite;
    return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: reasoning,
        totalTokens: total,
    };
}
function numberOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
/** A one-shot judge bound to a Harness LLM service. */
export class ModelJudge {
    deps;
    inFlight = false;
    constructor(deps) {
        this.deps = deps;
    }
    /** True when a judge call is currently running (recursion guard). */
    get busy() {
        return this.inFlight;
    }
    /**
     * Send one judge request. Never throws: every failure becomes
     * `{ ok: false }` so the caller can continue without the judge.
     */
    async call(request) {
        const started = Date.now();
        if (this.inFlight) {
            return failure('judge recursion refused', started);
        }
        const config = this.deps.config();
        if (!config.loopguardJudge)
            return failure('judge disabled by configuration', started);
        if (request.maxTokens <= 0)
            return failure('judge token budget exhausted', started);
        const route = this.resolveRoute(config, request.sessionRoute);
        if (!route)
            return failure('no model route available for the judge', started);
        this.inFlight = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1000, request.timeoutMs));
        const onParentAbort = () => controller.abort();
        if (request.signal) {
            if (request.signal.aborted)
                controller.abort();
            else
                request.signal.addEventListener('abort', onParentAbort, { once: true });
        }
        let usage = { ...EMPTY_USAGE };
        let text = '';
        try {
            const options = {
                provider: route.provider,
                model: route.model,
                system: request.system,
                maxTokens: request.maxTokens,
                signal: controller.signal,
                messages: [
                    {
                        role: 'user',
                        content: [{ type: 'text', text: request.userText }],
                    },
                ],
            };
            for await (const raw of this.deps.llm.stream(options)) {
                const chunk = raw;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                    text += chunk.text;
                    if (text.length > 200_000)
                        break;
                }
                else if (chunk.type === 'usage' && chunk.usage) {
                    usage = addUsage(usage, toUsageCounts(chunk.usage));
                }
            }
            if (controller.signal.aborted) {
                return {
                    ok: false,
                    text,
                    usage,
                    provider: route.provider,
                    model: route.model,
                    error: 'judge timed out or was cancelled',
                    durationMs: Date.now() - started,
                };
            }
            return {
                ok: true,
                text: text.trim(),
                usage,
                provider: route.provider,
                model: route.model,
                durationMs: Date.now() - started,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger?.warn(`token-economizer: judge call failed: ${message}`);
            return {
                ok: false,
                text,
                usage,
                provider: route.provider,
                model: route.model,
                error: message,
                durationMs: Date.now() - started,
            };
        }
        finally {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onParentAbort);
            this.inFlight = false;
        }
    }
    resolveRoute(config, sessionRoute) {
        const explicitProvider = config.judgeProvider.trim();
        const explicitModel = config.judgeModel.trim();
        if (explicitProvider && explicitModel)
            return { provider: explicitProvider, model: explicitModel };
        const inherited = sessionRoute ?? this.deps.sessionRoute?.();
        if (inherited?.provider && inherited.model) {
            return { provider: inherited.provider, model: inherited.model };
        }
        if (explicitProvider)
            return { provider: explicitProvider, model: inherited?.model ?? '' };
        if (explicitModel)
            return { provider: inherited?.provider ?? '', model: explicitModel };
        return null;
    }
}
function failure(message, started) {
    return {
        ok: false,
        text: '',
        usage: { ...EMPTY_USAGE },
        provider: null,
        model: null,
        error: message,
        durationMs: Date.now() - started,
    };
}
/** A stable, correlated id for one judge invocation (for diagnostics only). */
export function judgeCorrelationId() {
    return `judge-${randomUUID()}`;
}
