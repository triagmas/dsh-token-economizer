/**
 * The per-repository envelope: how long a turn that ended well usually runs.
 *
 * Port of `tokeneconomizer/loopguard/envelope.py` (Microsoft TokenEconomizer, Apache-2.0,
 * commit 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0).
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit 7042ea8.
 *
 * HOST ADAPTATION: upstream stores the tracker in a repository state store under a lock. Here
 * the tracker is pure and the caller passes/keeps a plain JSON snapshot (`EnvelopeSnapshot`),
 * so this module never touches `src/storage` and stays testable without the Harness.
 */
import {
  pyRound,
  scaledThresholds,
  type LoopLevel,
  type ThresholdOverrides,
  type Thresholds,
} from './rules.js'
import type { SpiralSnapshot } from './state.js'

/**
 * Linear-interpolated p-th percentile of xs (0<=p<=100); xs need not be sorted
 * (`_percentile`, envelope.py:14).
 */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const n = sorted.length
  if (n === 1) return Number(sorted[0])
  const i = (p / 100.0) * (n - 1)
  const lo = Math.floor(i)
  const frac = i - lo
  if (lo + 1 >= n) return Number(sorted[n - 1])
  return (sorted[lo] as number) + frac * ((sorted[lo + 1] as number) - (sorted[lo] as number))
}

/** Python `round(v)` then `int(...)`, as in upstream's `_clamp`. */
function clampInt(value: number, lo: number, hi: number): number {
  return Math.trunc(pyRound(Math.max(lo, Math.min(hi, value))))
}

/** The persisted envelope tracker (`envelope.json` shape + the tracker's level). */
export interface EnvelopeSnapshot {
  level?: string
  resolved_turns?: number[]
  resolved_snaps?: SpiralSnapshot[]
}

export interface EnvelopeTrackerOptions {
  /** `margin or base["envelope_margin"]` (0 falls back, as upstream). */
  margin?: number | null
  /** `pct if not None else base["envelope_pct"]`. */
  pct?: number | null
  /** `min_samples if not None else base["envelope_min_samples"]`. */
  minSamples?: number | null
  level?: LoopLevel
  /** Pre-registered scalar that bypasses the warm-up. */
  frozenEnvelope?: number | null
}

/** What `recordTurn` needs from a finished turn (`TurnGuard` satisfies it). */
export interface TurnRecordLike {
  readonly cumTurns: number
  resolvedProxy(stoppedNormally?: boolean): boolean
  readonly whole: { snapshot(): SpiralSnapshot }
}

/** Recent ended-green turns kept for the percentile (`ENVELOPE_HISTORY`). */
export const ENVELOPE_HISTORY = 500

/** Overrides that shape the envelope itself; the rest pin the thresholds it returns. */
const _ENVELOPE_KEYS = new Set(['envelope_margin', 'envelope_pct', 'envelope_min_samples'])

/**
 * Per-repo resolved-turn envelope AND runtime-learned detection thresholds
 * (`EnvelopeTracker`, envelope.py:30).
 *
 * Envelope: `margin` x the p<pct> of turn-counts among RESOLVED tasks seen so far. A
 * PERCENTILE (default p90), not the max, so one very-long resolve does not disable the guard
 * for every normal spiral below it. None until >=min_samples resolved tasks exist, unless a
 * frozen envelope is set.
 *
 * Thresholds: derived from the SAME resolved-task history, so the guard adapts to the
 * agent/repo's actual turn scale. Turn-scale gates scale DOWN to the learned distribution;
 * signal gates keep the level-scaled base as a FLOOR. Fed only by resolved tasks: a task's own
 * outcome can only gate FUTURE tasks.
 */
export class EnvelopeTracker {
  level: LoopLevel
  baseThr: Thresholds
  margin: number
  pct: number
  minSamples: number
  frozenEnvelope: number | null
  /** All RESOLVED tasks' turn counts (for the percentile). */
  resolvedTurns: number[]
  /** Per-resolved-task `SpiralState.snapshot()` (for the learned signal gates). */
  resolvedSnaps: SpiralSnapshot[]

  constructor(options: EnvelopeTrackerOptions = {}) {
    this.level = options.level ?? 'default'
    this.baseThr = scaledThresholds(this.level)
    this.margin = options.margin || this.baseThr.envelope_margin
    this.pct = options.pct !== undefined && options.pct !== null ? options.pct : this.baseThr.envelope_pct
    this.minSamples =
      options.minSamples !== undefined && options.minSamples !== null
        ? options.minSamples
        : this.baseThr.envelope_min_samples
    this.frozenEnvelope = options.frozenEnvelope ?? null
    this.resolvedTurns = []
    this.resolvedSnaps = []
  }

  /** Record a completed task; only RESOLVED tasks feed the baseline (`update`, envelope.py:72). */
  update(turns: number, resolved: boolean, snapshot?: SpiralSnapshot | null): void {
    if (resolved && turns) {
      this.resolvedTurns.push(turns)
      if (snapshot) this.resolvedSnaps.push(snapshot)
    }
  }

  /** `margin * p<pct>` of resolved turns, or the frozen envelope during warm-up. */
  get envelope(): number | null {
    if (this.resolvedTurns.length < this.minSamples) return this.frozenEnvelope
    const p = percentile(this.resolvedTurns, this.pct)
    return (p ?? 0) * this.margin
  }

  /**
   * The detector threshold dict (`thresholds`, envelope.py:90). Starts from the level-scaled
   * base and, once enough resolved tasks exist, overrides the learned keys. Pass `maxTurns`
   * (the run's turn cap) to make the hard backstop REACHABLE under the cap.
   */
  thresholds(maxTurns?: number | null): Thresholds {
    const base = this.baseThr
    const thr: Thresholds = { ...base }
    const env = this.envelope
    if (env !== null) {
      let bt = env * thr.backstop_mult
      if (maxTurns) bt = Math.min(bt, 0.9 * maxTurns)
      thr.backstop_turns = bt
    }
    if (this.resolvedTurns.length < this.minSamples) return thr

    // Turn-scale gates: relative to the learned resolved-turn distribution.
    const p90t = percentile(this.resolvedTurns, 90) ?? 0
    thr.gate_min_turns = clampInt(0.6 * p90t, 6, base.gate_min_turns)
    thr.min_turns = clampInt(0.6 * p90t, 8, base.min_turns)

    // Signal gates: just above the resolved band's p90, never below the base floor.
    if (this.resolvedSnaps.length > 0) {
      const sig = (key: keyof SpiralSnapshot): number[] =>
        this.resolvedSnaps.map((s) => Number(s[key] ?? 0) || 0)
      thr.edit_churn = Math.max(
        base.edit_churn,
        Math.ceil((percentile(sig('edit_churn'), 90) ?? 0) + 1),
      )
      thr.distinct_edit_files = Math.max(
        base.distinct_edit_files,
        Math.ceil((percentile(sig('distinct_edit_files'), 90) ?? 0) + 1),
      )
      thr.error_outputs = Math.max(
        base.error_outputs,
        Math.ceil((percentile(sig('error_outputs'), 90) ?? 0) + 1),
      )
      thr.gate_error_outputs = Math.max(base.gate_error_outputs, thr.error_outputs)
      thr.stagnation = Math.max(
        base.stagnation,
        pyRound(percentile(sig('stagnation'), 90) ?? 0, 3),
      )
    }
    return thr
  }
}

function optionsFromOverrides(overrides?: ThresholdOverrides | null): EnvelopeTrackerOptions {
  const ov = overrides ?? {}
  return {
    margin: ov.envelope_margin,
    pct: ov.envelope_pct,
    minSamples: ov.envelope_min_samples,
  }
}

/**
 * Rebuild a tracker from its plain JSON snapshot (`load_envelope`, envelope.py:157). No store
 * access: the caller reads/writes the snapshot itself.
 */
export function loadEnvelope(
  data?: EnvelopeSnapshot | null,
  level: LoopLevel = 'default',
  overrides?: ThresholdOverrides | null,
): EnvelopeTracker {
  const d = data ?? {}
  const tracker = new EnvelopeTracker({ ...optionsFromOverrides(overrides), level })
  tracker.resolvedTurns = (d.resolved_turns ?? [])
    .filter((x) => typeof x === 'number' && x > 0)
    .map((x) => Math.trunc(x))
  tracker.resolvedSnaps = (d.resolved_snaps ?? []).filter(
    (s): s is SpiralSnapshot => typeof s === 'object' && s !== null && !Array.isArray(s),
  )
  return tracker
}

/** The plain JSON snapshot to persist (`save_envelope`, envelope.py:187). */
export function saveEnvelope(tracker: EnvelopeTracker): EnvelopeSnapshot {
  return {
    level: tracker.level,
    resolved_turns: tracker.resolvedTurns.slice(-ENVELOPE_HISTORY),
    resolved_snaps: tracker.resolvedSnaps.slice(-ENVELOPE_HISTORY),
  }
}

/**
 * The thresholds a turn is checked against (`thresholds`, envelope.py:167): the preset, what
 * this repository's history learned on top of it, then a person's pinned values, which win.
 */
export function thresholds(
  tracker: EnvelopeTracker,
  overrides?: ThresholdOverrides | null,
): Thresholds {
  const thr = tracker.thresholds(null)
  const ov = overrides ?? {}
  for (const [key, value] of Object.entries(ov) as [keyof Thresholds, number | boolean][]) {
    if (!_ENVELOPE_KEYS.has(key) && value !== undefined) {
      // Pinned values are plain numbers/booleans on the same keys.
      ;(thr as unknown as Record<string, unknown>)[key] = value
    }
  }
  if (ov.backstop_mult !== undefined && tracker.envelope !== null) {
    thr.backstop_turns = tracker.envelope * (thr.backstop_mult as number)
  }
  return thr
}

/** The thresholds before any learning (`base_thresholds`, envelope.py:179). */
export function baseThresholds(
  level: LoopLevel = 'default',
  overrides?: ThresholdOverrides | null,
): Thresholds {
  return { ...scaledThresholds(level), ...(overrides ?? {}) }
}

/**
 * Fold a finished turn into the envelope (`record_turn`, envelope.py:194). Only turns that
 * ended green feed it; the snapshot is of the WHOLE turn. Returns the updated tracker; the
 * caller persists `saveEnvelope(tracker)`.
 */
export function recordTurn(
  data: EnvelopeSnapshot | null | undefined,
  guard: TurnRecordLike,
  options: {
    level?: LoopLevel
    stoppedNormally?: boolean
    overrides?: ThresholdOverrides | null
  } = {},
): EnvelopeTracker {
  const tracker = loadEnvelope(data, options.level ?? 'default', options.overrides)
  const stoppedNormally = options.stoppedNormally ?? true
  tracker.update(guard.cumTurns, guard.resolvedProxy(stoppedNormally), guard.whole.snapshot())
  return tracker
}
