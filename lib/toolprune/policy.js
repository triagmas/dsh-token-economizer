import { allowlistMatches } from './glob.js';
/**
 * The work surface, ported from upstream `PROTECTED_TOOLS` (Copilot, Codex and
 * Claude Code tool names), extended with the DSH file/shell/analysis surface and the
 * tools a person needs to answer, publish or manage the Harness. These tools are NEVER
 * auto-pruned; they are still tracked so the Tools page can report their real usage.
 *
 * Deliberately NOT protected: orchestration and optional capability tools (`subagent`,
 * `workflow`, `schedule_*`, `session_*`, `job_*`, `web_*`, goal tools, skills, worktrees,
 * UI renderers). Upstream prunes exactly this class of tools after evidence, and hiding
 * them is reversible from the Tools tab. Protecting them all made automatic pruning a
 * no-op on a stock DSH profile; see docs/UPSTREAM.md.
 *
 * Upstream: `tokeneconomizer/toolprune/tools.py` :: `PROTECTED_TOOLS` — "Tools that
 * must always stay available regardless of usage (the real work surface)."
 */
export const PROTECTED_TOOLS = new Set([
    // --- upstream: Copilot CLI / generic work surface ---
    'bash',
    'view',
    'grep',
    'glob',
    'edit',
    'create',
    'str_replace',
    'read_bash',
    'stop_bash',
    'list_bash',
    'read_file',
    // --- upstream: Codex native work surface (fixed; neither schema is removable) ---
    'shell',
    'apply_patch',
    // --- upstream: Claude Code work-surface names ---
    'Bash',
    'Edit',
    'Write',
    'Read',
    'Grep',
    'Glob',
    'MultiEdit',
    // --- DSH work surface ---
    'read',
    'read_image',
    'write',
    'lint',
    'dsh_read',
    'dsh_write',
    'working_directory',
    // --- DSH safety / user-facing controls ---
    'ask_user_question',
    'present',
    'plugin_manager',
]);
/**
 * DSH tool families protected by prefix. `lint_*` and `codegraph_*` are analysis/read
 * surfaces; `terminal_*` owns long-lived processes whose loss would strand running work.
 */
export const PROTECTED_PREFIXES = Object.freeze(['lint_', 'codegraph_', 'terminal_']);
/** True when a tool name is on the never-auto-prune work/orchestration surface. */
export function isProtectedName(name) {
    if (typeof name !== 'string')
        return false;
    return PROTECTED_TOOLS.has(name) || PROTECTED_PREFIXES.some((prefix) => name.startsWith(prefix));
}
/**
 * Upstream `INAPPLICABLE_TOOLS`: tools that cannot help a single sealed/headless task by
 * construction (sub-agent orchestration, scheduling, session memory, interactive
 * questions). Ported for parity and reported to the UI as context.
 *
 * This list is NOT a pruning input: upstream never drops a tool merely because it is
 * "inapplicable" — the evidence threshold still has to be met, and nothing here is
 * denied automatically. The optional instruction-aware tool judge that consumes it
 * upstream (`judge_tools_for_task`, a paid LLM call) is out of scope for this port.
 */
export const INAPPLICABLE_TOOLS = new Set([
    'task',
    'list_agents',
    'read_agent',
    'write_agent',
    'sql',
    'session_store_sql',
    'manage_schedule',
    'skill',
    'fetch_copilot_cli_documentation',
    'store_memory',
    'vote_memory',
    'ask_user',
    'Agent',
    'Workflow',
    'TaskCreate',
    'TaskUpdate',
    'TaskGet',
    'TaskList',
    'TaskOutput',
    'TaskStop',
    'ScheduleWakeup',
    'CronCreate',
    'CronDelete',
    'CronList',
    'EnterPlanMode',
    'ExitPlanMode',
    'EnterWorktree',
    'ExitWorktree',
    'Skill',
    'NotebookEdit',
    'AskUserQuestion',
]);
/**
 * Grace: never deny a catalog this small.
 *
 * Upstream has no single catalog-size constant, so this threshold is justified from two
 * upstream invariants:
 *   * `stage.py` refuses to draw conclusions from an empty catalog ("evidence pruning
 *     can drop NOTHING");
 *   * `codex.py` keeps a retained floor (`CORE_CAPABILITIES`, `RETAINED_CAPABILITIES`)
 *     and demotes at most `MAX_DEMOTIONS_PER_TASK` = 2 packages at a time. A catalog of
 *     <= 2 tools could be entirely denied by one audit, which the upstream floor rules
 *     out. Three tools require at least one survivor under the two-demotion cap.
 */
export const MIN_CATALOG_TO_PRUNE = 3;
/** Upstream `codex.py` :: `RECENT_WINDOW` — how many recent exposures are considered. */
export const RECENT_USE_WINDOW = 3;
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/** True when the tool vanished from the current catalog (kept, never denied). */
export function isToolInactive(stat) {
    return Boolean(stat && stat.inactive === true);
}
/** Rows still present in the current session catalog. */
export function activeToolRows(file) {
    if (!file || !file.tools)
        return [];
    return Object.values(file.tools).filter((stat) => Boolean(stat) && typeof stat.name === 'string' && !isToolInactive(stat));
}
/**
 * Number of sessions in which the catalog is known to have been observed.
 *
 * Approximated from the largest `sessionsAvailable` among still-registered tools: every
 * catalog observation increments every available tool, so the longest-lived row has seen
 * every session in which it was registered. (See the DEVIATION note in the file header.)
 */
export function observedSessions(file) {
    let max = 0;
    for (const stat of activeToolRows(file)) {
        if (isFiniteNumber(stat.sessionsAvailable))
            max = Math.max(max, stat.sessionsAvailable);
    }
    return max;
}
/** True when the configuration says this tool must never be pruned (name or pattern). */
export function isAllowlisted(name, config) {
    return allowlistMatches(name, config.toolpruneAllowlist);
}
/** True when the tool has ever been called (upstream `used_tools`; a single use protects). */
export function hasEverBeenUsed(stat) {
    return stat.calls > 0 || stat.successes > 0;
}
/**
 * Upstream `plugin/fold.py::enough_evidence`:
 * `(sessions >= min_sessions and prompts >= evidence) or sessions >= sessions_shortcut`.
 *
 * The high-risk multiplier (`HIGH_RISK_FACTOR`) is intentionally absent: DSH has no
 * ported high-risk capability class. Non-finite counters are treated as zero.
 */
export function enoughEvidence(counts, config) {
    const sessions = isFiniteNumber(counts?.sessions) && counts.sessions > 0 ? Math.floor(counts.sessions) : 0;
    const prompts = isFiniteNumber(counts?.prompts) && counts.prompts > 0 ? Math.floor(counts.prompts) : 0;
    const minSessions = isFiniteNumber(config?.toolpruneMinSessions) ? config.toolpruneMinSessions : 0;
    const evidence = isFiniteNumber(config?.toolpruneEvidence) ? config.toolpruneEvidence : Number.POSITIVE_INFINITY;
    const shortcut = isFiniteNumber(config?.toolpruneSessions) ? config.toolpruneSessions : Number.POSITIVE_INFINITY;
    return (sessions >= minSessions && prompts >= evidence) || sessions >= shortcut;
}
/**
 * Prompt evidence for a row. `unusedPrompts` is authoritative once present. Storage
 * migrates rows written before the counter existed from their unused-session count,
 * matching upstream's `prompt_streaks or streaks` migration. Counting every unused
 * session again here would turn scheduled/goal-only sessions into prompt evidence.
 */
export function unusedPromptsFor(stat) {
    const prompts = stat.unusedPrompts;
    if (isFiniteNumber(prompts) && prompts >= 0)
        return prompts;
    return isFiniteNumber(stat.unusedSessions) && stat.unusedSessions > 0 ? stat.unusedSessions : 0;
}
/** Build the catalog facts one audit needs. */
export function snapshot(file, context = {}) {
    const catalog = activeToolRows(file);
    return {
        catalogSize: catalog.length,
        observedSessions: isFiniteNumber(context.observedSessions) && context.observedSessions >= 0
            ? Math.floor(context.observedSessions)
            : observedSessions(file),
        reaudit: context.reaudit === true,
    };
}
/**
 * Decide whether one tool is a pruning candidate under the current evidence.
 *
 * Order of the guards (first hit wins):
 *   disabled -> mode-disabled -> reaudit -> pruned -> inactive -> protected -> allowlisted
 *   -> used -> catalog-too-small -> insufficient-sessions -> insufficient-evidence
 *   -> candidate.
 *
 * This function does not mutate anything. Allowlist/protected checks read the
 * configuration and the built-in work surface, so a stale `allowlisted` flag on the row
 * cannot override a newly added allowlist entry.
 */
export function evaluateCandidate(stat, config, facts) {
    if (!config.toolpruneEnabled)
        return { candidate: false, reason: 'disabled' };
    if (config.toolpruneMode === 'disabled')
        return { candidate: false, reason: 'mode-disabled' };
    if (facts.reaudit)
        return { candidate: false, reason: 'reaudit' };
    if (stat.restored)
        return { candidate: false, reason: 'restored' };
    if (stat.pruned)
        return { candidate: false, reason: 'pruned' };
    if (isToolInactive(stat))
        return { candidate: false, reason: 'inactive' };
    if (stat.protected || isProtectedName(stat.name))
        return { candidate: false, reason: 'protected' };
    if (stat.allowlisted || isAllowlisted(stat.name, config))
        return { candidate: false, reason: 'allowlisted' };
    if (stat.restored)
        return { candidate: false, reason: 'restored' };
    // Upstream: a tool that was ever seen in use is never proposed again.
    if (hasEverBeenUsed(stat))
        return { candidate: false, reason: 'used' };
    const catalogSize = facts.catalogSize;
    if (!isFiniteNumber(catalogSize) || catalogSize < MIN_CATALOG_TO_PRUNE) {
        return { candidate: false, reason: 'catalog-too-small' };
    }
    if (!isFiniteNumber(facts.observedSessions) || facts.observedSessions < config.toolpruneMinSessions) {
        return { candidate: false, reason: 'insufficient-sessions' };
    }
    const sessions = isFiniteNumber(stat.unusedSessions) ? stat.unusedSessions : 0;
    if (!enoughEvidence({ sessions, prompts: unusedPromptsFor(stat) }, config)) {
        return { candidate: false, reason: 'insufficient-evidence' };
    }
    return { candidate: true, reason: 'candidate' };
}
/**
 * Tools the `propose` (and `automatic`) modes would surface to the user: evidence
 * candidates that are neither already pruned nor on any protected/allowlisted surface.
 * Sorted for stable UI/tests. `disabled`/`observe` surface nothing; a re-audit task
 * surfaces nothing (upstream reloads the full catalog on that task).
 */
export function proposedCandidates(file, config, context = {}) {
    if (!file || !config || !config.toolpruneEnabled)
        return [];
    if (config.toolpruneMode !== 'propose' && config.toolpruneMode !== 'automatic')
        return [];
    const facts = snapshot(file, context);
    if (facts.reaudit)
        return [];
    const names = [];
    for (const stat of activeToolRows(file)) {
        if (evaluateCandidate(stat, config, facts).candidate)
            names.push(stat.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
}
/** True when a row may still be denied (ignores its current `pruned` flag). */
function stillDeniable(stat, config) {
    if (isToolInactive(stat))
        return false;
    if (stat.protected || isProtectedName(stat.name))
        return false;
    if (stat.allowlisted || isAllowlisted(stat.name, config))
        return false;
    if (stat.restored)
        return false;
    if (hasEverBeenUsed(stat))
        return false;
    return true;
}
/**
 * The deny set the `automatic` mode should hand to the Harness.
 *
 * Returns `[]` unless `toolpruneMode === 'automatic'` AND `toolpruneEnabled` is true.
 * The caller MUST additionally require global `mode === 'active'` before applying it;
 * this function deliberately does not read `config.mode` so that SHADOW mode can still
 * ask "what would be denied" without acting.
 *
 * The set is the union of (a) rows already marked pruned that are still deniable and
 * (b) fresh evidence candidates. Only tools present in the CURRENT catalog can be
 * denied — a name that disappeared is never invented into the deny list, and a fresh
 * catalog observation that marked everything inactive therefore restores the surface.
 * Protected, allowlisted and ever-used rows are removed even if a stale `pruned` flag
 * remains. No per-audit cap is applied: upstream's evidence path excludes every tool
 * whose streak reached the threshold (`stage.py`), unlike Codex's gradual two-package
 * demotion.
 */
export function computeDenySet(file, config, context = {}) {
    if (!file || !config)
        return [];
    if (!config.toolpruneEnabled)
        return [];
    if (config.toolpruneMode !== 'automatic')
        return [];
    const facts = snapshot(file, context);
    if (facts.reaudit)
        return [];
    // Grace: a catalog that is too small or too young gets no pruning decision at all.
    if (facts.catalogSize < MIN_CATALOG_TO_PRUNE)
        return [];
    if (facts.observedSessions < config.toolpruneMinSessions)
        return [];
    const deny = new Set();
    const persisted = new Set(Array.isArray(file.pruned) ? file.pruned : []);
    for (const stat of activeToolRows(file)) {
        if (!stillDeniable(stat, config))
            continue;
        // Honor both the row flag and the persisted deny list: a reader may rebuild rows
        // from `pruned` without replaying `markPruned`.
        if (stat.pruned || persisted.has(stat.name))
            deny.add(stat.name);
        else if (evaluateCandidate(stat, config, facts).candidate)
            deny.add(stat.name);
    }
    return [...deny].sort((a, b) => a.localeCompare(b));
}
/**
 * The already-applied deny list only: persisted hides that are still deniable.
 * Unlike `computeDenySet`, this never evaluates fresh evidence; new candidates wait in
 * `autoPending` until a later session. Used by `denySetForSession` so the running
 * session's catalog cannot shrink mid-turn.
 */
export function appliedDenySet(file) {
    const deny = new Set();
    for (const name of Array.isArray(file.pruned) ? file.pruned : []) {
        const stat = file.tools[name];
        if (!stat || isToolInactive(stat) || stat.protected || isProtectedName(name))
            continue;
        if (hasEverBeenUsed(stat))
            continue;
        if (stat.restored)
            continue;
        deny.add(name);
    }
    return [...deny].sort((a, b) => a.localeCompare(b));
}
/**
 * Mark one tool pruned and add it to the persisted deny list.
 *
 * Refuses rows that are unknown, inactive, protected, allowlisted-by-row, or ever used:
 * the policy never invents a deny for a name that is not in the current catalog, and a
 * tool that was ever used stays available (upstream `used_tools`).
 */
export function markPruned(file, name, reason) {
    const tool = typeof name === 'string' ? name.trim() : '';
    if (!tool || !file || !file.tools)
        return false;
    const stat = file.tools[tool];
    if (!stat)
        return false;
    if (isToolInactive(stat) || stat.protected || isProtectedName(tool) || hasEverBeenUsed(stat))
        return false;
    if (stat.restored)
        return false;
    stat.pruned = true;
    stat.pruneReason = typeof reason === 'string' && reason ? reason : 'evidence';
    if (!Array.isArray(file.pruned))
        file.pruned = [];
    if (!file.pruned.includes(tool)) {
        file.pruned.push(tool);
        file.pruned.sort((a, b) => a.localeCompare(b));
    }
    return true;
}
/**
 * Clear a row's pruned flag and remove it from the persisted deny list, WITHOUT
 * resetting its evidence clock. Returns true when something changed.
 */
export function unmarkPruned(file, name) {
    const tool = typeof name === 'string' ? name.trim() : '';
    if (!tool || !file || !file.tools)
        return false;
    const stat = file.tools[tool];
    const listed = Array.isArray(file.pruned) && file.pruned.includes(tool);
    const changed = Boolean(stat && stat.pruned) || listed;
    if (!changed)
        return false;
    if (stat) {
        stat.pruned = false;
        stat.pruneReason = null;
    }
    if (listed)
        file.pruned = file.pruned.filter((item) => item !== tool);
    return true;
}
/**
 * User-facing restore. Clears the prune state and resets `unusedSessions`, so the tool
 * gets a fresh grace window and is not immediately re-proposed by the next audit.
 *
 * Upstream's fail-open recovery (`codex.py` :: `_choose_probe`, task hints) also restores
 * a package for at least one session after an explicit signal; the evidence clock reset
 * is this port's equivalent for a user override.
 */
export function restoreTool(file, name) {
    const tool = typeof name === 'string' ? name.trim() : '';
    if (!tool || !file || !file.tools)
        return false;
    const stat = file.tools[tool];
    if (!stat)
        return false;
    unmarkPruned(file, tool);
    stat.unusedSessions = 0;
    stat.unusedPrompts = 0;
    stat.restored = true;
    return true;
}
/**
 * Upstream `ToolingConfig.evidence_reaudit`: periodically reload the full catalog
 * instead of pruning (`i > 0 and i % evidence_reaudit == 0` in `stage.py`).
 *
 * `everyN <= 0` disables the periodic re-audit. `lastAuditTask` is `-1` when no audit
 * has happened yet (`EMPTY_TOOLS` in `storage/store.ts`), so the first audit lands on
 * task `everyN`, then every `everyN` tasks, matching upstream's modulo cadence. If a
 * caller skipped an audit, the next task triggers one instead of waiting for the next
 * multiple.
 */
export function reauditDue(lastAuditTask, currentTask, everyN) {
    if (!isFiniteNumber(everyN) || everyN <= 0)
        return false;
    if (!isFiniteNumber(currentTask) || currentTask <= 0)
        return false;
    if (!isFiniteNumber(lastAuditTask) || lastAuditTask < 0)
        return currentTask >= everyN;
    if (lastAuditTask >= currentTask)
        return false;
    return currentTask - lastAuditTask >= everyN;
}
