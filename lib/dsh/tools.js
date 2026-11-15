/**
 * Adapter over the Harness tool registry.
 *
 * Two jobs only: describe the visible tool catalog (name + model-facing token
 * cost) and apply a computed deny set to one agent scope. Policy, evidence and
 * mode decisions live in `src/toolprune`; this file is the DSH boundary.
 */
/** Rough token estimate (4 UTF-8 bytes per token), matching upstream's estimate. */
export function estimateTokens(text) {
    return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}
/** Describe one definition as the model sees it. */
export function catalogTool(definition) {
    const name = typeof definition.name === 'string' ? definition.name : '';
    if (!name)
        return null;
    const description = typeof definition.description === 'string' ? definition.description : '';
    let parameters = '';
    try {
        parameters = JSON.stringify(definition.parameters ?? {});
    }
    catch {
        parameters = '';
    }
    return { name, description, descriptionTokens: estimateTokens(`${name}${description}${parameters}`) };
}
/** Snapshot builder with a short TTL so large registries are not serialized on every step. */
export class ToolCatalog {
    tools;
    ttlMs;
    cached = null;
    now;
    constructor(tools, ttlMs = 5_000, now = Date.now) {
        this.tools = tools;
        this.ttlMs = ttlMs;
        this.now = now;
    }
    /** Full catalog for the global scope (or a specific agent scope). */
    snapshot(scope) {
        if (scope === undefined) {
            const at = this.now();
            if (this.cached && at - this.cached.at < this.ttlMs)
                return this.cached.tools;
            const tools = this.read(undefined);
            this.cached = { at, tools };
            return tools;
        }
        return this.read(scope);
    }
    /** Names visible in the global catalog. */
    names() {
        return this.snapshot().map((tool) => tool.name);
    }
    /** Total estimated definition tokens in the global catalog. */
    totalTokens() {
        return this.snapshot().reduce((sum, tool) => sum + tool.descriptionTokens, 0);
    }
    /** Invalidate after a dynamic registration change. */
    invalidate() {
        this.cached = null;
    }
    read(scope) {
        let definitions;
        try {
            definitions = this.tools.definitions(scope);
        }
        catch {
            return [];
        }
        const result = [];
        for (const definition of definitions) {
            const tool = catalogTool(definition);
            if (tool)
                result.push(tool);
        }
        return result.sort((left, right) => left.name.localeCompare(right.name));
    }
}
/**
 * Apply a deny set to one agent scope.
 *
 * Unknown names are filtered first because the Harness rejects a restriction
 * that mentions them. An empty effective set returns a no-op disposer, which
 * keeps repeated per-step reconciliation cheap and idempotent.
 */
export function applyToolRestriction(agent, deny, knownNames) {
    const known = new Set(knownNames);
    const effective = [...new Set(deny)].filter((name) => known.has(name)).sort();
    if (effective.length === 0)
        return { applied: [], dispose: () => { } };
    const dispose = agent.ctx.tools.restrict({ deny: effective });
    return { applied: effective, dispose };
}
