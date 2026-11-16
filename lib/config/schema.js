/**
 * Configuration schema for `dsh-token-economizer`.
 *
 * Every field is marked volatile so a settings change (CLI command, settings
 * page, or `/economizer config`) is applied immediately without restarting the
 * Harness. `mode` itself is volatile by design: switching SHADOW -> ACTIVE is a
 * policy action, not a structural change.
 *
 * Defaults are deliberately conservative: SHADOW mode, no context injection,
 * no tool denial, no paid judge call. ACTIVE and every mutating mechanism must
 * be switched on explicitly by the user.
 */
import z from '@deepseek-ai/schemastery';
const modeSchema = z.union([z.const('off'), z.const('shadow'), z.const('active')]);
const pruneSchema = z.union([
    z.const('disabled'),
    z.const('observe'),
    z.const('propose'),
    z.const('automatic'),
]);
const levelSchema = z.union([z.const('conservative'), z.const('default'), z.const('aggressive')]);
const profileSchema = z.union([
    z.const('envfacts'),
    z.const('distiller'),
    z.const('envfacts+distiller'),
]);
export const Config = z.object({
    mode: modeSchema
        .default('shadow')
        .description('OFF disables all mechanisms; SHADOW measures and proposes only; ACTIVE applies approved optimizations.')
        .volatile(),
    // --- Micro-skills -------------------------------------------------------
    microskillsEnabled: z.boolean()
        .default(true)
        .description('Learn reusable project knowledge (commands, checks, conventions) from finished tasks.')
        .volatile(),
    microskillsInject: z.boolean()
        .default(false)
        .description('Inject learned knowledge into the agent context. Applies only in ACTIVE mode.')
        .volatile(),
    microskillsProfile: profileSchema
        .default('envfacts')
        .description('envfacts uses the local, LLM-free extractor; distiller uses the paid proposer; envfacts+distiller combines both.')
        .volatile(),
    microskillsMaxFacts: z.number()
        .min(0)
        .max(50)
        .step(1)
        .default(4)
        .description('Maximum number of active facts kept in the injected block.')
        .volatile(),
    microskillsMaxTokens: z.number()
        .min(0)
        .max(4000)
        .step(50)
        .default(150)
        .description('Token budget of the injected knowledge block (~4 characters per token).')
        .volatile(),
    microskillsMinConfirmations: z.number()
        .min(1)
        .max(10)
        .step(1)
        .default(3)
        .description('Independent confirmations required before a candidate fact becomes active.')
        .volatile(),
    microskillsRetireDays: z.number()
        .min(0)
        .max(3650)
        .step(1)
        .default(0)
        .description('Retire an active fact that has not been exercised for this many days (0 disables retirement).')
        .volatile(),
    // --- Tool pruning -------------------------------------------------------
    toolpruneEnabled: z.boolean()
        .default(true)
        .description('Track per-project tool usage and prune demonstrably unused tools.')
        .volatile(),
    toolpruneMode: pruneSchema
        .default('observe')
        .description('observe records usage; propose surfaces candidates; automatic denies them (ACTIVE mode only).')
        .volatile(),
    toolpruneEvidence: z.number()
        .min(1)
        .max(100)
        .step(1)
        .default(10)
        .description('Prompts a tool must be available but unused before it becomes a pruning candidate.')
        .volatile(),
    toolpruneMinSessions: z.number()
        .min(1)
        .max(100)
        .step(1)
        .default(2)
        .description('Minimum observed sessions before prompt evidence can hide a tool.')
        .volatile(),
    toolpruneSessions: z.number()
        .min(1)
        .max(100)
        .step(1)
        .default(5)
        .description('Shortcut: hide an unused tool after this many sessions regardless of prompts.')
        .volatile(),
    toolpruneQuietMinutes: z.number()
        .min(0)
        .max(10080)
        .step(1)
        .default(60)
        .description('Wait this many minutes of project inactivity before applying new automatic hides (0 = next session immediately).')
        .volatile(),
    toolpruneReauditEvery: z.number()
        .min(0)
        .max(1000)
        .step(1)
        .default(0)
        .description('Reload the full tool catalog every N tasks (0 disables the periodic re-audit).')
        .volatile(),
    toolpruneAllowlist: z.array(z.string())
        .default([])
        .description('Tool names or glob patterns (*, **, ?) that must never be pruned.')
        .volatile(),
    // --- Failure-loop guard -------------------------------------------------
    loopguardEnabled: z.boolean()
        .default(true)
        .description('Detect repeated failing actions and stalled attempts.')
        .volatile(),
    loopguardIntervene: z.boolean()
        .default(false)
        .description('Inject a redirect message when a loop is confirmed (ACTIVE mode only, never stops the agent).')
        .volatile(),
    loopguardLevel: levelSchema
        .default('default')
        .description('Threshold preset: conservative, default, aggressive.')
        .volatile(),
    loopguardJudge: z.boolean()
        .default(true)
        .description('Allow one capped judge model call per candidate loop, using the session model route.')
        .volatile(),
    loopguardConfidence: z.number()
        .min(0.5)
        .max(1)
        .step(0.01)
        .default(0.7)
        .description('Minimum judge confidence required to redirect (Microsoft baseline: 0.7).')
        .volatile(),
    loopguardMaxInterventions: z.number()
        .min(0)
        .max(5)
        .step(1)
        .default(1)
        .description('Maximum automatic redirects per turn (Microsoft baseline: 1).')
        .volatile(),
    loopguardJudgeTimeoutMs: z.number()
        .min(1000)
        .max(120000)
        .step(1000)
        .default(20000)
        .description('Hard timeout for a judge call; on timeout the guard stays silent.')
        .volatile(),
    loopguardNudgeMaxTokens: z.number()
        .min(20)
        .max(1000)
        .step(10)
        .default(120)
        .description('Maximum length of the redirect message.')
        .volatile(),
    // --- Subagents ----------------------------------------------------------
    subagentsEnabled: z.boolean()
        .default(true)
        .description('Attribute subagent sessions to their parent without double counting. When off, subagents are ignored.')
        .volatile(),
    // --- Model, budget, privacy --------------------------------------------
    judgeProvider: z.string()
        .default('')
        .description('Provider id for the optional judge call; empty inherits the session model route.')
        .volatile(),
    judgeModel: z.string()
        .default('')
        .description('Model id for the optional judge call; empty inherits the session model route.')
        .volatile(),
    maxOverheadTokensPerTurn: z.number()
        .min(0)
        .max(200000)
        .step(100)
        .default(4000)
        .description('Hard budget for all Token Economizer model overhead in one turn (0 means no extra calls).')
        .volatile(),
    maxOverheadTokensPerSession: z.number()
        .min(0)
        .max(2000000)
        .step(1000)
        .default(30000)
        .description('Hard budget for all Token Economizer model overhead in one session.')
        .volatile(),
    storeEvidence: z.boolean()
        .default(true)
        .description('Store short redacted evidence snippets with learned facts. Raw prompts and tool output are never stored.')
        .volatile(),
    retentionDays: z.number()
        .min(1)
        .max(3650)
        .step(1)
        .default(180)
        .description('Delete project metrics older than this many days during maintenance.')
        .volatile(),
    maxMetricsBytes: z.number()
        .min(262144)
        .max(268435456)
        .step(262144)
        .default(4194304)
        .description('Rotate a project metrics file after it grows beyond this many bytes.')
        .volatile(),
    priceTable: z.string()
        .default('')
        .description('Optional JSON price overrides: {"provider/model":{"input":1,"output":4,"cacheRead":0.1,"cacheWrite":1.25}} in USD per million tokens.')
        .volatile(),
    debug: z.boolean()
        .default(false)
        .description('Write verbose diagnostics to the plugin error log.')
        .volatile(),
});
export const CONFIG_DEFAULTS = {
    mode: 'shadow',
    microskillsEnabled: true,
    microskillsInject: false,
    microskillsProfile: 'envfacts',
    microskillsMaxFacts: 4,
    microskillsMaxTokens: 150,
    microskillsMinConfirmations: 3,
    microskillsRetireDays: 0,
    toolpruneEnabled: true,
    toolpruneMode: 'observe',
    toolpruneEvidence: 10,
    toolpruneMinSessions: 2,
    toolpruneSessions: 5,
    toolpruneQuietMinutes: 60,
    toolpruneReauditEvery: 0,
    toolpruneAllowlist: [],
    loopguardEnabled: true,
    loopguardIntervene: false,
    loopguardLevel: 'default',
    loopguardJudge: true,
    loopguardConfidence: 0.7,
    loopguardMaxInterventions: 1,
    loopguardJudgeTimeoutMs: 20000,
    loopguardNudgeMaxTokens: 120,
    subagentsEnabled: true,
    judgeProvider: '',
    judgeModel: '',
    maxOverheadTokensPerTurn: 4000,
    maxOverheadTokensPerSession: 30000,
    storeEvidence: true,
    retentionDays: 180,
    maxMetricsBytes: 4194304,
    priceTable: '',
    debug: false,
};
export const CONFIG_FIELD_RULES = {
    mode: { type: 'enum', options: ['off', 'shadow', 'active'] },
    microskillsEnabled: { type: 'boolean' },
    microskillsInject: { type: 'boolean' },
    microskillsProfile: { type: 'enum', options: ['envfacts', 'distiller', 'envfacts+distiller'] },
    microskillsMaxFacts: { type: 'number', min: 0, max: 50, step: 1 },
    microskillsMaxTokens: { type: 'number', min: 0, max: 4000, step: 50 },
    microskillsMinConfirmations: { type: 'number', min: 1, max: 10, step: 1 },
    microskillsRetireDays: { type: 'number', min: 0, max: 3650, step: 1 },
    toolpruneEnabled: { type: 'boolean' },
    toolpruneMode: { type: 'enum', options: ['disabled', 'observe', 'propose', 'automatic'] },
    toolpruneEvidence: { type: 'number', min: 1, max: 100, step: 1 },
    toolpruneMinSessions: { type: 'number', min: 1, max: 100, step: 1 },
    toolpruneSessions: { type: 'number', min: 1, max: 100, step: 1 },
    toolpruneQuietMinutes: { type: 'number', min: 0, max: 10080, step: 1 },
    toolpruneReauditEvery: { type: 'number', min: 0, max: 1000, step: 1 },
    toolpruneAllowlist: { type: 'array' },
    loopguardEnabled: { type: 'boolean' },
    loopguardIntervene: { type: 'boolean' },
    loopguardLevel: { type: 'enum', options: ['conservative', 'default', 'aggressive'] },
    loopguardJudge: { type: 'boolean' },
    loopguardConfidence: { type: 'number', min: 0.5, max: 1, step: 0.01 },
    loopguardMaxInterventions: { type: 'number', min: 0, max: 5, step: 1 },
    loopguardJudgeTimeoutMs: { type: 'number', min: 1000, max: 120000, step: 1000 },
    loopguardNudgeMaxTokens: { type: 'number', min: 20, max: 1000, step: 10 },
    subagentsEnabled: { type: 'boolean' },
    judgeProvider: { type: 'string' },
    judgeModel: { type: 'string' },
    maxOverheadTokensPerTurn: { type: 'number', min: 0, max: 200000, step: 100 },
    maxOverheadTokensPerSession: { type: 'number', min: 0, max: 2000000, step: 1000 },
    storeEvidence: { type: 'boolean' },
    retentionDays: { type: 'number', min: 1, max: 3650, step: 1 },
    maxMetricsBytes: { type: 'number', min: 262144, max: 268435456, step: 262144 },
    priceTable: { type: 'string' },
    debug: { type: 'boolean' },
};
/** Unwrap a schemastery volatile reference (`{ get() }`) or pass a plain value through. */
export function unwrap(value) {
    if (typeof value === 'object' && value !== null && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
function bool(value, fallback) {
    const plain = unwrap(value);
    return typeof plain === 'boolean' ? plain : fallback;
}
function num(value, fallback, min, max) {
    const plain = unwrap(value);
    if (typeof plain !== 'number' || !Number.isFinite(plain))
        return fallback;
    return Math.min(max, Math.max(min, plain));
}
function str(value, fallback) {
    const plain = unwrap(value);
    return typeof plain === 'string' ? plain : fallback;
}
function oneOf(value, allowed, fallback) {
    const plain = unwrap(value);
    return allowed.includes(plain) ? plain : fallback;
}
/** Snapshot the live plugin config into the engine's plain-value contract. */
export function resolveConfig(raw) {
    const source = raw ?? {};
    const allowlist = unwrap(source.toolpruneAllowlist);
    return {
        mode: oneOf(source.mode, ['off', 'shadow', 'active'], CONFIG_DEFAULTS.mode),
        microskillsEnabled: bool(source.microskillsEnabled, CONFIG_DEFAULTS.microskillsEnabled),
        microskillsInject: bool(source.microskillsInject, CONFIG_DEFAULTS.microskillsInject),
        microskillsProfile: oneOf(source.microskillsProfile, ['envfacts', 'distiller', 'envfacts+distiller'], CONFIG_DEFAULTS.microskillsProfile),
        microskillsMaxFacts: num(source.microskillsMaxFacts, CONFIG_DEFAULTS.microskillsMaxFacts, 0, 50),
        microskillsMaxTokens: num(source.microskillsMaxTokens, CONFIG_DEFAULTS.microskillsMaxTokens, 0, 4000),
        microskillsMinConfirmations: num(source.microskillsMinConfirmations, CONFIG_DEFAULTS.microskillsMinConfirmations, 1, 10),
        microskillsRetireDays: num(source.microskillsRetireDays, CONFIG_DEFAULTS.microskillsRetireDays, 0, 3650),
        toolpruneEnabled: bool(source.toolpruneEnabled, CONFIG_DEFAULTS.toolpruneEnabled),
        toolpruneMode: oneOf(source.toolpruneMode, ['disabled', 'observe', 'propose', 'automatic'], CONFIG_DEFAULTS.toolpruneMode),
        toolpruneEvidence: num(source.toolpruneEvidence, CONFIG_DEFAULTS.toolpruneEvidence, 1, 100),
        toolpruneMinSessions: num(source.toolpruneMinSessions, CONFIG_DEFAULTS.toolpruneMinSessions, 1, 100),
        toolpruneSessions: num(source.toolpruneSessions, CONFIG_DEFAULTS.toolpruneSessions, 1, 100),
        toolpruneQuietMinutes: num(source.toolpruneQuietMinutes, CONFIG_DEFAULTS.toolpruneQuietMinutes, 0, 10080),
        toolpruneReauditEvery: num(source.toolpruneReauditEvery, CONFIG_DEFAULTS.toolpruneReauditEvery, 0, 1000),
        toolpruneAllowlist: Array.isArray(allowlist)
            ? allowlist.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
            : [],
        loopguardEnabled: bool(source.loopguardEnabled, CONFIG_DEFAULTS.loopguardEnabled),
        loopguardIntervene: bool(source.loopguardIntervene, CONFIG_DEFAULTS.loopguardIntervene),
        loopguardLevel: oneOf(source.loopguardLevel, ['conservative', 'default', 'aggressive'], CONFIG_DEFAULTS.loopguardLevel),
        loopguardJudge: bool(source.loopguardJudge, CONFIG_DEFAULTS.loopguardJudge),
        loopguardConfidence: num(source.loopguardConfidence, CONFIG_DEFAULTS.loopguardConfidence, 0.5, 1),
        loopguardMaxInterventions: num(source.loopguardMaxInterventions, CONFIG_DEFAULTS.loopguardMaxInterventions, 0, 5),
        loopguardJudgeTimeoutMs: num(source.loopguardJudgeTimeoutMs, CONFIG_DEFAULTS.loopguardJudgeTimeoutMs, 1000, 120000),
        loopguardNudgeMaxTokens: num(source.loopguardNudgeMaxTokens, CONFIG_DEFAULTS.loopguardNudgeMaxTokens, 20, 1000),
        subagentsEnabled: bool(source.subagentsEnabled, CONFIG_DEFAULTS.subagentsEnabled),
        judgeProvider: str(source.judgeProvider, CONFIG_DEFAULTS.judgeProvider).trim(),
        judgeModel: str(source.judgeModel, CONFIG_DEFAULTS.judgeModel).trim(),
        maxOverheadTokensPerTurn: num(source.maxOverheadTokensPerTurn, CONFIG_DEFAULTS.maxOverheadTokensPerTurn, 0, 200000),
        maxOverheadTokensPerSession: num(source.maxOverheadTokensPerSession, CONFIG_DEFAULTS.maxOverheadTokensPerSession, 0, 2000000),
        storeEvidence: bool(source.storeEvidence, CONFIG_DEFAULTS.storeEvidence),
        retentionDays: num(source.retentionDays, CONFIG_DEFAULTS.retentionDays, 1, 3650),
        maxMetricsBytes: num(source.maxMetricsBytes, CONFIG_DEFAULTS.maxMetricsBytes, 262144, 268435456),
        priceTable: str(source.priceTable, CONFIG_DEFAULTS.priceTable),
        debug: bool(source.debug, CONFIG_DEFAULTS.debug),
    };
}
/** True when a mechanism may mutate agent state (context, tools, redirects). */
export function isMutating(config) {
    return config.mode === 'active';
}
/** True when any measurement or proposal work is enabled. */
export function isEnabled(config) {
    return config.mode !== 'off';
}
