/**
 * Per-project tool-usage statistics for tool pruning.
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0.
 * Upstream sources:
 *   - `tokeneconomizer/toolprune/stage.py` :: `ToolingStage.after_task` accrues
 *     `catalog_tools`, `used_tools` and `tool_unused_streaks` every task, even when
 *     pruning is off ("the evidence accrues every session").
 *   - `tokeneconomizer/toolprune/tools.py` :: `PROTECTED_TOOLS` is the work surface.
 *   - `tokeneconomizer/toolprune/codex.py` :: `inspect_usage` counts attempted,
 *     completed and failed uses per capability.
 *   - `tokeneconomizer/pricing.py` :: `approx_tokens` for the description estimate.
 *
 * DSH observes sessions (not sealed benchmark tasks), so the shared `ToolStat` row
 * folds upstream's per-task "loaded but unused streak" into `unusedSessions`: the number
 * of observed sessions in which the tool was available in the catalog but never called.
 * Upstream also permanently protects a tool the first time it is used (`used_tools`),
 * which the pruning policy mirrors by never pruning a row with `calls > 0`; the streak
 * therefore only ever matters for tools that were never called.
 *
 * The shared `ToolStat` contract has no "currently registered" flag, but the task
 * requires disappearing tools to be kept AND marked. Rows carry two documented,
 * forward-compatible extension fields that older readers ignore:
 *   - `inactive`: the tool vanished from the session catalog (kept for history/UI, and
 *     never proposed for pruning because it cannot be denied when it is not offered);
 *   - `observedAtTask`: idempotence guard so one session is counted once.
 * `lastCallSession` is the third extension field and only supports distinct-session
 * counting for `ToolStat.sessions`.
 */
import { approxTokens } from '../pricing/weights.js';
import { isProtectedName, isToolInactive } from './policy.js';
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function nonNegative(value, fallback = 0) {
    return isFiniteNumber(value) && value >= 0 ? value : fallback;
}
function descriptionTokensFor(option) {
    if (isFiniteNumber(option.descriptionTokens) && option.descriptionTokens >= 0) {
        return Math.trunc(option.descriptionTokens);
    }
    const text = typeof option.description === 'string' ? option.description : '';
    return text.length > 0 ? approxTokens(text) : 0;
}
/** Create an empty, never-used row for one tool. */
export function newToolStat(name, options = {}) {
    return {
        name,
        descriptionTokens: descriptionTokensFor(options),
        calls: 0,
        successes: 0,
        failures: 0,
        sessions: 0,
        sessionsAvailable: 0,
        unusedSessions: 0,
        unusedPrompts: 0,
        lastUsedAt: null,
        lastUsedSeq: null,
        pruned: false,
        pruneReason: null,
        protected: options.protected === true,
        allowlisted: options.allowlisted === true,
        scoped: options.scoped !== false,
    };
}
/** Normalize the accepted catalog entry shapes into a descriptor. */
function toDescriptor(entry) {
    if (typeof entry === 'string') {
        const name = entry.trim();
        return name ? { name } : null;
    }
    if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
        const name = entry.name.trim();
        return name ? { ...entry, name } : null;
    }
    return null;
}
function asSet(values) {
    const set = new Set();
    if (values)
        for (const value of values)
            if (typeof value === 'string' && value.trim())
                set.add(value.trim());
    return set;
}
/**
 * Fold one catalog observation into the project's tool rows.
 *
 * Call once per observed session (or per task window), using the same
 * `projectTaskIndex` for repeat calls about that session: counters are counted once per
 * index. Names that are new become rows (dynamic tool registrations). Previously known
 * tools missing from the catalog are kept and marked `inactive`; a tool that reappears
 * is marked active again and resumes counting.
 *
 * An EMPTY catalog is treated as "not observed" (returns early and marks nothing
 * inactive): upstream `ToolingStage.after_task` refuses to draw conclusions from an
 * empty parse ("evidence pruning can drop NOTHING"), and mass-deactivating every row on
 * one unparsable session would silently erase the evidence.
 *
 * The function is pure with respect to I/O: it mutates the passed `ToolsFile` and never
 * writes or reads the store.
 */
export function observeToolAvailability(file, projectTaskIndex, names, protectedTools = [], allowlist = [], sessionId) {
    const descriptors = new Map();
    for (const entry of names ?? []) {
        const descriptor = toDescriptor(entry);
        if (descriptor && !descriptors.has(descriptor.name))
            descriptors.set(descriptor.name, descriptor);
    }
    const result = {
        catalogSize: descriptors.size,
        added: 0,
        updated: 0,
        markedInactive: 0,
    };
    if (descriptors.size === 0)
        return result;
    const taskIndex = isFiniteNumber(projectTaskIndex) && projectTaskIndex >= 0 ? projectTaskIndex : 0;
    const sessionKey = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
    const protectedSet = asSet(protectedTools);
    const allowlistSet = asSet(allowlist);
    // A tool that vanished from the catalog is kept but marked, never silently deleted.
    for (const [name, stat] of Object.entries(file.tools)) {
        if (descriptors.has(name))
            continue;
        if (isToolInactive(stat))
            continue;
        stat.inactive = true;
        result.markedInactive += 1;
    }
    for (const [name, descriptor] of descriptors) {
        let stat = file.tools[name];
        if (!stat) {
            stat = newToolStat(name, {
                descriptionTokens: descriptionTokensFor(descriptor),
                protected: isProtectedName(name) || protectedSet.has(name),
                allowlisted: allowlistSet.has(name),
            });
            file.tools[name] = stat;
            result.added += 1;
        }
        // Flags are cheap to refresh and keep the UI honest even when configuration changed.
        stat.name = name;
        stat.protected = isProtectedName(name) || protectedSet.has(name);
        stat.allowlisted = allowlistSet.has(name);
        if (descriptor.descriptionTokens !== undefined || descriptor.description !== undefined) {
            const tokens = descriptionTokensFor(descriptor);
            if (tokens > 0)
                stat.descriptionTokens = tokens;
        }
        // Reappeared after an absence: active again, and this observation counts.
        stat.inactive = false;
        if (sessionKey !== null) {
            if (stat.observedSession === sessionKey)
                continue;
            stat.observedSession = sessionKey;
        }
        else if (stat.observedAtTask === taskIndex) {
            continue;
        }
        stat.observedAtTask = taskIndex;
        stat.sessionsAvailable += 1;
        if (stat.calls === 0)
            stat.unusedSessions += 1;
        result.updated += 1;
    }
    return result;
}
function toIso(value) {
    if (value === null || value === undefined)
        return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
/**
 * Count one completed turn (prompt) for every available tool that has never been called.
 * Upstream `fold.py` adds the session's prompt count to `prompt_streaks` only when the
 * tool's unused streak advanced; DSH turns are the prompt unit here. `taskIndex` keeps a
 * repeated finish callback for one turn from counting twice.
 *
 * The argument is the catalog observed for the turn. A tool that disappeared is ignored;
 * a tool that was called in this turn already had `unusedPrompts` reset by
 * `recordToolCall`. Returns the number of rows advanced.
 */
export function recordUnusedPrompts(file, names, taskIndex) {
    const task = isFiniteNumber(taskIndex) && taskIndex >= 0 ? taskIndex : 0;
    let advanced = 0;
    const seen = new Set();
    for (const entry of names ?? []) {
        const descriptor = toDescriptor(entry);
        if (!descriptor || seen.has(descriptor.name))
            continue;
        seen.add(descriptor.name);
        const stat = file.tools[descriptor.name];
        if (!stat || isToolInactive(stat) || stat.calls > 0)
            continue;
        if (stat.unusedAtTask === task)
            continue;
        stat.unusedAtTask = task;
        stat.unusedPrompts = nonNegative(stat.unusedPrompts) + 1;
        advanced += 1;
    }
    return advanced;
}
/**
 * Record one observed tool call (success or failure).
 *
 * Upstream `ToolingStage.after_task` folds the task's used-tool names into `used_tools`
 * and resets that tool's unused streak. Here the call counters and `lastUsedAt/Seq` do
 * the same job: a row with `calls > 0` is permanently protected by the pruning policy.
 *
 * `sessionId` is optional. When it is given, `stat.sessions` counts distinct consecutive
 * sessions in which a call was observed (a per-tool session id is remembered in the
 * documented `lastCallSession` extension field). When it is omitted, a call that arrives
 * after the sequence restarted (`seq <= lastUsedSeq`) starts a new session bucket; a
 * session without a sequence cannot be distinguished and is counted once.
 *
 * Returns the updated row, or `null` for an empty tool name. A call for an unseen tool
 * creates a row: a tool can be registered dynamically after the catalog was observed.
 */
export function recordToolCall(file, name, ok, seq, timestamp = null, sessionId = null) {
    const tool = typeof name === 'string' ? name.trim() : '';
    if (!tool)
        return null;
    let stat = file.tools[tool];
    if (!stat) {
        stat = newToolStat(tool, { protected: isProtectedName(tool) });
        file.tools[tool] = stat;
    }
    const previousCalls = stat.calls;
    const previousSeq = stat.lastUsedSeq;
    const previousSession = stat.lastCallSession;
    const nextSeq = isFiniteNumber(seq) ? seq : null;
    stat.calls = previousCalls + 1;
    if (ok)
        stat.successes += 1;
    else
        stat.failures += 1;
    stat.inactive = false;
    // Upstream `after_task` resets a loaded-but-unused streak as soon as the tool is used;
    // a used row therefore reports zero unused sessions (and is protected anyway).
    stat.unusedSessions = 0;
    // Upstream resets `prompt_streaks[t] = 0` as soon as the tool is used, even once.
    stat.unusedPrompts = 0;
    const iso = toIso(timestamp);
    if (iso)
        stat.lastUsedAt = iso;
    const session = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
    if (session) {
        if (previousSession !== session) {
            stat.sessions += 1;
            stat.lastCallSession = session;
        }
    }
    else if (stat.sessions === 0 || (previousSeq !== null && nextSeq !== null && nextSeq <= previousSeq)) {
        stat.sessions += 1;
    }
    if (nextSeq !== null)
        stat.lastUsedSeq = nextSeq;
    return stat;
}
