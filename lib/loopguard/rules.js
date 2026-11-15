/**
 * When a trajectory counts as stuck, and what to do about it.
 *
 * Port of `tokeneconomizer/loopguard/rules.py` (Microsoft TokenEconomizer, Apache-2.0,
 * commit 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0).
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit 7042ea8.
 *
 * Three tiers, cheapest first:
 *   - `gateForJudge` -- free, every call: is the recent trace worth a paid look at all?
 *   - a paid judge   -- optional, only when the gate is open;
 *   - `isStuck`      -- the strict heuristic decision used when no judge is wired.
 *
 * `assessAbort` runs the cascade against a per-repository envelope with a hard backstop the
 * judge cannot veto. `nudgeText` is the redirect the guard sends: it mirrors only the agent's
 * own actions, carries no outside knowledge, and never tells it to stop.
 */
/**
 * Verbatim `DEFAULT_THRESHOLDS` (rules.py:20-43). Calibrated so a productive-but-hard task
 * (high activity, but changing failures) is spared.
 */
export const DEFAULT_THRESHOLDS = {
    min_turns: 20,
    edit_churn: 4,
    distinct_edit_files: 3,
    error_outputs: 6,
    stagnation: 0.2,
    envelope_margin: 1.25,
    envelope_pct: 90,
    envelope_min_samples: 5,
    judge_confidence: 0.7,
    backstop_mult: 2.5,
    gate_min_turns: 18,
    gate_error_outputs: 8,
};
/**
 * Verbatim `SPIRAL_LEVELS` (rules.py:53-66). `default` is empty: it reproduces
 * `DEFAULT_THRESHOLDS` exactly.
 */
export const SPIRAL_LEVELS = {
    conservative: {
        judge_confidence: 0.85,
        envelope_margin: 1.5,
        backstop_mult: 3.5,
        stagnation: 0.3,
        gate_min_turns: 24,
        min_turns: 28,
        edit_churn: 5,
        error_outputs: 8,
        envelope_min_samples: 7,
    },
    default: {},
    aggressive: {
        judge_confidence: 0.55,
        envelope_margin: 1.0,
        backstop_mult: 1.8,
        stagnation: 0.12,
        gate_min_turns: 12,
        min_turns: 14,
        edit_churn: 3,
        error_outputs: 4,
        envelope_min_samples: 3,
        nudge_on_ambiguous: true,
    },
};
/** Python-style round-half-to-even (used for the upstream `round()`/`:.0f` formatting). */
export function pyRound(value, digits = 0) {
    const factor = 10 ** digits;
    const scaled = value * factor;
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    let rounded;
    if (diff > 0.5)
        rounded = floor + 1;
    else if (diff < 0.5)
        rounded = floor;
    else
        rounded = floor % 2 === 0 ? floor : floor + 1;
    return digits === 0 ? rounded : rounded / factor;
}
/** Upstream `f"{x:.0f}"` (round-half-to-even, not JavaScript's `toFixed`). */
export function formatFixed0(value) {
    return String(pyRound(value));
}
function thresholdsOrDefault(thr) {
    // Upstream `thr or DEFAULT_THRESHOLDS`: an empty dict falls back to the defaults.
    if (!thr || Object.keys(thr).length === 0)
        return DEFAULT_THRESHOLDS;
    return thr;
}
/**
 * `scaled_thresholds` (rules.py:69): `DEFAULT_THRESHOLDS` overlaid with the named level's
 * overrides. Unknown level falls back to `default` (verbatim defaults).
 */
export function scaledThresholds(level = 'default') {
    const preset = SPIRAL_LEVELS[level];
    const overrides = preset ?? SPIRAL_LEVELS.default;
    return { ...DEFAULT_THRESHOLDS, ...overrides };
}
/**
 * TIER-0 (`gate_for_judge`, rules.py:78): cheap, free trigger deciding whether the recent
 * trace is worth elevating to the paid judge. Permissive: a repeated identical failure OR a
 * high error density, after the loop has had time to form.
 */
export function gateForJudge(state, thr) {
    const t = thresholdsOrDefault(thr);
    if (state.turns < t.gate_min_turns)
        return false;
    return state.repeatedFailSigs >= 1 || state.errorOutputs >= t.gate_error_outputs;
}
/**
 * Strict heuristic classifier (`is_stuck`, rules.py:93) -- the DECISION used only in the
 * no-judge fallback. Requires duration AND churn/scatter AND repetition.
 */
export function isStuck(state, thr) {
    const t = thresholdsOrDefault(thr);
    if (state.turns < t.min_turns)
        return false;
    const churny = state.editChurn >= t.edit_churn || state.distinctEditFiles >= t.distinct_edit_files;
    const noisy = state.errorOutputs >= t.error_outputs;
    const repeating = state.stagnation >= t.stagnation;
    return churny && noisy && repeating;
}
/**
 * `assess_abort` (rules.py:109): decide whether to abort, trace-first, as a two-tier cascade.
 *
 * Hard backstop first (judge cannot veto), then gate -> judge, then the no-judge fallback
 * (`isStuck` + envelope). The judge is called only when the gate opens.
 */
export function assessAbort(state, envelope, judge, thr) {
    const t = thresholdsOrDefault(thr);
    // HARD BACKSTOP (checked BEFORE the judge).
    let backstopTurns = typeof t.backstop_turns === 'number' ? t.backstop_turns : null;
    if (backstopTurns === null && envelope !== null && envelope !== undefined) {
        backstopTurns = envelope * t.backstop_mult;
    }
    if (backstopTurns !== null && state.turns >= backstopTurns && isStuck(state, t)) {
        return {
            abort: true,
            reason: `backstop:${state.turns}>=${formatFixed0(backstopTurns)}turns stagnation=${state.stagnation.toFixed(2)}`,
        };
    }
    if (judge !== null && judge !== undefined) {
        // TWO-TIER: gate -> judge. The gate also opens when the trajectory is already PAST this
        // repository's typical resolved length, unless the plugin pins `gate_over_envelope` off.
        const overEnvelope = envelope !== null &&
            envelope !== undefined &&
            state.turns >= envelope &&
            t.gate_over_envelope !== false;
        if (!(gateForJudge(state, t) || overEnvelope)) {
            return { abort: false, reason: 'gate-closed' };
        }
        let v;
        try {
            v = judge(state.recentDigest({ envelope: envelope ?? null }));
        }
        catch {
            v = null;
        }
        if (!v)
            return { abort: false, reason: 'judge-throttled' };
        const conf = Number(v.confidence ?? 0) || 0;
        if (v.stuck && conf >= t.judge_confidence) {
            const reason = String(v.reason ?? '').slice(0, 60);
            return { abort: true, reason: `judge-stuck@${conf.toFixed(2)}:${reason}` };
        }
        if (v.stuck === false)
            return { abort: false, reason: 'judge-productive' };
        return { abort: false, reason: 'judge-ambiguous-spared' };
    }
    // FALLBACK (no judge): strict heuristic + envelope safety gate.
    if (!isStuck(state, t))
        return { abort: false, reason: 'not-stuck' };
    if (envelope !== null && envelope !== undefined && state.turns >= envelope) {
        return { abort: true, reason: `envelope:${state.turns}>=${formatFixed0(envelope)}` };
    }
    return { abort: false, reason: 'stuck-but-within-envelope' };
}
/**
 * `nudge_text` (rules.py:183): the redirect. Mirrors the agent's OWN repeated actions back at
 * it -- leakage-safe by construction -- and redirects effort, never stops it.
 */
export function nudgeText(state) {
    let busiest = 'one file';
    let best = -Infinity;
    let total = 0;
    for (const [name, count] of state.editCounts) {
        total += count;
        if (count > best) {
            best = count;
            busiest = name;
        }
    }
    return ('Process check (automated): so far you\'ve made ' +
        `${total} edits across ` +
        `${state.distinctEditFiles} file(s) (most to \`${busiest}\`) and run ` +
        `${state.testRuns} verification(s), and the same failure has recurred ` +
        `${state.repeatedFailSigs} time(s) without the tests going green. This ` +
        'looks like a repetitive loop. Do NOT stop — instead step back and try a ' +
        'MATERIALLY DIFFERENT hypothesis: re-read the failing test\'s expectation, ' +
        "consider a different file or root cause than the ones you've been editing, " +
        'and verify the new hypothesis directly before editing again.');
}
