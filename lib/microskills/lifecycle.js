// ---- lifecycle knobs (the validated replay constants) ---------------------------------
/** `K_PROMOTE`: confirmations (drifted, where drift applies) to promote -> ACTIVE. */
export const K_PROMOTE = 3;
/** `GAMMA`: recency decay per task-ago. */
export const GAMMA = 0.8;
/** `LAMBDA`: contradiction weight (asymmetry: fail toward retirement). */
export const LAMBDA = 5.0;
/** `SCORE_FLOOR`: retire ACTIVE when recency score < floor. */
export const SCORE_FLOOR = 0.0;
/** `HARD_KILL`: high-stakes fact: single clean contradiction retires now. */
export const HARD_KILL = true;
/** `FIRE_GATE`: inject only if firing rate on this repository >= 40%. */
export const FIRE_GATE = 0.4;
/** `FIRE_MIN_N`: ... measured over at least this many exercised tasks. */
export const FIRE_MIN_N = 4;
/**
 * Derived, not an upstream constant: the number of tasks after which a confirmation's weight
 * has halved (`GAMMA ** n = 0.5`). Exported for the UI, which explains decay in plain terms.
 */
export const HALF_LIFE_TASKS = Math.log(0.5) / Math.log(GAMMA);
/** One fact's state machine (`lifecycle.py:Lifecycle`). */
export class Lifecycle {
    key;
    high;
    /** Promotion needs confirmations on different files. */
    drift;
    kPromote;
    state = 'CANDIDATE';
    /** `[(task_idx, [edited_files])]` */
    confirms = [];
    /** `[task_idx]` */
    contradicts = [];
    /** Tasks where the waste occurred (fired). */
    fireNum = 0;
    /** Tasks where the fact was exercised. */
    fireDen = 0;
    promotedAt = null;
    retiredAt = null;
    constructor(key, high, drift = true, options = {}) {
        this.key = key;
        this.high = high;
        this.drift = drift;
        this.kPromote = options.kPromote ?? K_PROMOTE;
    }
    /** Confirmations on tasks that edited (at least partly) different files, in order. */
    driftedConfirms() {
        if (!this.drift)
            return this.confirms.length;
        const kept = [];
        for (const [index, files] of this.confirms) {
            const set = new Set(files);
            if (set.size === 0 || kept.every(([, other]) => [...set].every((file) => !other.has(file)))) {
                kept.push([index, set]);
            }
        }
        return kept.length;
    }
    /** Recency-weighted confirmations minus LAMBDA-weighted contradictions. */
    score(now) {
        let score = 0;
        for (const [index] of this.confirms)
            score += Math.pow(GAMMA, now - index);
        let contradictions = 0;
        for (const index of this.contradicts)
            contradictions += Math.pow(GAMMA, now - index);
        return score - LAMBDA * contradictions;
    }
    firingRate() {
        return this.fireDen > 0 ? this.fireNum / this.fireDen : 0;
    }
    /** ACTIVE and clears the firing gate -> goes into the rendered manual. */
    injectable() {
        return this.state === 'ACTIVE' && this.fireDen >= FIRE_MIN_N && this.firingRate() >= FIRE_GATE;
    }
    update(now, verdict, fired, exercised, files) {
        if (exercised) {
            this.fireDen += 1;
            if (fired)
                this.fireNum += 1;
        }
        if (verdict === 'confirm') {
            this.confirms.push([now, [...files].sort()]);
        }
        else if (verdict === 'contradict') {
            this.contradicts.push(now);
        }
        if (this.state === 'CANDIDATE') {
            if (this.driftedConfirms() >= this.kPromote) {
                this.state = 'ACTIVE';
                this.promotedAt = now;
            }
        }
        else if (this.state === 'ACTIVE') {
            const hard = this.high && verdict === 'contradict' && HARD_KILL;
            if (hard || this.score(now) < SCORE_FLOOR) {
                this.state = 'RETIRED';
                this.retiredAt = now;
            }
        }
    }
    toDict() {
        return {
            key: this.key,
            high: this.high,
            drift: this.drift,
            state: this.state,
            confirms: this.confirms.map(([index, files]) => [index, [...files]]),
            contradicts: [...this.contradicts],
            fire_num: this.fireNum,
            fire_den: this.fireDen,
            promoted_at: this.promotedAt,
            retired_at: this.retiredAt,
        };
    }
    static fromDict(dict, options = {}) {
        const life = new Lifecycle(String(dict.key ?? ''), Boolean(dict.high), dict.drift === undefined ? true : Boolean(dict.drift), options);
        if (dict.state)
            life.state = dict.state;
        life.confirms = (dict.confirms ?? []).map(([index, files]) => [Number(index), [...(files ?? [])]]);
        life.contradicts = [...(dict.contradicts ?? [])].map(Number);
        life.fireNum = Number(dict.fire_num ?? 0);
        life.fireDen = Number(dict.fire_den ?? 0);
        life.promotedAt = dict.promoted_at ?? null;
        life.retiredAt = dict.retired_at ?? null;
        return life;
    }
}
/**
 * One task's evidence folded into a fact (`lifecycle.Lifecycle.update`, plus the optional
 * CANDIDATE hard-kill from `envfacts.fold`). Returns the verdict actually applied.
 */
export function foldLifecycle(life, now, verdict, fired, exercised, files, options = {}) {
    life.update(now, verdict, fired, exercised, files);
    if (options.hardKillCandidates && verdict === 'contradict' && life.high && life.state === 'CANDIDATE') {
        life.state = 'RETIRED';
        life.retiredAt = now;
    }
    return verdict;
}
/** True for a row that may be injected (`State ACTIVE`, enabled, firing gate cleared). */
export function isInjectableRow(row) {
    if (row.state !== 'ACTIVE' || row.enabled === false)
        return false;
    const den = row.fireDen ?? 0;
    const num = row.fireNum ?? 0;
    return den >= FIRE_MIN_N && (den > 0 ? num / den : 0) >= FIRE_GATE;
}
/** Rebuild the lifecycle of a stored row. */
export function lifecycleFromStored(row, options = {}) {
    const life = new Lifecycle(row.key, Boolean(row.high), Boolean(row.drift), options);
    life.state = row.state;
    life.confirms = (row.confirms ?? []).map(([index, files]) => [Number(index), [...(files ?? [])]]);
    life.contradicts = [...(row.contradicts ?? [])].map(Number);
    life.fireNum = Number(row.fireNum ?? 0);
    life.fireDen = Number(row.fireDen ?? 0);
    life.promotedAt = row.promotedAt ?? null;
    life.retiredAt = row.retiredAt ?? null;
    return life;
}
/** Write a lifecycle back onto a row in place (the caller owns the row's text/source). */
export function applyLifecycleToStored(row, life) {
    row.key = life.key;
    row.high = life.high;
    row.drift = life.drift;
    row.state = life.state;
    row.confirms = life.confirms.map(([index, files]) => [index, [...files]]);
    row.contradicts = [...life.contradicts];
    row.fireNum = life.fireNum;
    row.fireDen = life.fireDen;
    row.promotedAt = life.promotedAt;
    row.retiredAt = life.retiredAt;
    return row;
}
/** Build a fresh `StoredFact` from a lifecycle and its metadata. */
export function storedFactFromLifecycle(life, meta) {
    return {
        id: meta.id,
        key: life.key,
        text: meta.text,
        kind: meta.kind,
        high: life.high,
        drift: life.drift,
        state: life.state,
        confirms: life.confirms.map(([index, files]) => [index, [...files]]),
        contradicts: [...life.contradicts],
        fireNum: life.fireNum,
        fireDen: life.fireDen,
        promotedAt: life.promotedAt,
        retiredAt: life.retiredAt,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        lastUsedAt: meta.lastUsedAt ?? null,
        enabled: meta.enabled ?? true,
        source: meta.source ?? { sessionId: '', turn: 0, evidence: [] },
    };
}
