/**
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0, `tokeneconomizer/microskills/lifecycle.py`.
 *
 * The lifecycle every learned fact goes through, whoever proposed it.
 *
 * A fact is a CANDIDATE until it is confirmed on K_PROMOTE tasks -- tasks that edited
 * different files, for a fact about the code (stable across the repository's history, not one
 * task's coincidence); any K_PROMOTE tasks, for a fact about the environment, which does not
 * change with the files a task edits (`drift: false`). It is then ACTIVE until a
 * recency-weighted score, with contradictions weighted LAMBDA times a confirmation, falls
 * below the floor -- or at once, for a high-stakes fact, on one clean contradiction. An ACTIVE
 * fact is injected only while it clears the FIRING GATE: the waste it prevents occurred (or,
 * once injected, kept being prevented) on at least FIRE_GATE of the tasks that exercised it.
 *
 * This module also maps a `Lifecycle` to/from the shared `StoredFact` row so the caller can
 * persist the earned counters without knowing anything about the state machine.
 */
import type { FactState, StoredFact } from '../core/types.js'

// ---- lifecycle knobs (the validated replay constants) ---------------------------------
/** `K_PROMOTE`: confirmations (drifted, where drift applies) to promote -> ACTIVE. */
export const K_PROMOTE = 3
/** `GAMMA`: recency decay per task-ago. */
export const GAMMA = 0.8
/** `LAMBDA`: contradiction weight (asymmetry: fail toward retirement). */
export const LAMBDA = 5.0
/** `SCORE_FLOOR`: retire ACTIVE when recency score < floor. */
export const SCORE_FLOOR = 0.0
/** `HARD_KILL`: high-stakes fact: single clean contradiction retires now. */
export const HARD_KILL = true
/** `FIRE_GATE`: inject only if firing rate on this repository >= 40%. */
export const FIRE_GATE = 0.4
/** `FIRE_MIN_N`: ... measured over at least this many exercised tasks. */
export const FIRE_MIN_N = 4

/**
 * Derived, not an upstream constant: the number of tasks after which a confirmation's weight
 * has halved (`GAMMA ** n = 0.5`). Exported for the UI, which explains decay in plain terms.
 */
export const HALF_LIFE_TASKS = Math.log(0.5) / Math.log(GAMMA)

export type Verdict = 'confirm' | 'contradict' | null

export interface LifecycleOptions {
  /**
   * Confirmation count that promotes a CANDIDATE. Upstream `K_PROMOTE` (3); the plugin passes
   * the user's `microskillsMinConfirmations` when it is set, so a user who asks for 2
   * confirmations gets 2.
   */
  readonly kPromote?: number
}

export interface LifecycleDict {
  key: string
  high: boolean
  drift: boolean
  state: FactState
  confirms: Array<[number, string[]]>
  contradicts: number[]
  fire_num: number
  fire_den: number
  promoted_at: number | null
  retired_at: number | null
}

/** One fact's state machine (`lifecycle.py:Lifecycle`). */
export class Lifecycle {
  readonly key: string
  readonly high: boolean
  /** Promotion needs confirmations on different files. */
  readonly drift: boolean
  readonly kPromote: number
  state: FactState = 'CANDIDATE'
  /** `[(task_idx, [edited_files])]` */
  confirms: Array<[number, string[]]> = []
  /**
   * Session id for each entry of `confirms`, parallel to it. Upstream folds one finished
   * session at a time; a caller that re-folds the same session (several turns) must not count
   * it twice. Kept out of `toDict()` so the upstream lifecycle parity stays exact.
   */
  sessionConfirms: string[] = []
  /** `[task_idx]` */
  contradicts: number[] = []
  /** Tasks where the waste occurred (fired). */
  fireNum = 0
  /** Tasks where the fact was exercised. */
  fireDen = 0
  promotedAt: number | null = null
  retiredAt: number | null = null

  constructor(key: string, high: boolean, drift = true, options: LifecycleOptions = {}) {
    this.key = key
    this.high = high
    this.drift = drift
    this.kPromote = options.kPromote ?? K_PROMOTE
  }

  /** Confirmations on tasks that edited (at least partly) different files, in order. */
  driftedConfirms(): number {
    if (!this.drift) return this.uniqueConfirmCount()
    const kept: Array<[number, Set<string>]> = []
    for (const [index, files] of this.confirms) {
      const set = new Set(files)
      if (set.size === 0 || kept.every(([, other]) => [...set].every((file) => !other.has(file)))) {
        kept.push([index, set])
      }
    }
    return kept.length
  }

  /** One confirmation per session, even if a caller folded the same session twice. */
  private uniqueConfirmCount(): number {
    const seen = new Set<string>()
    let count = 0
    for (let i = 0; i < this.confirms.length; i += 1) {
      const session = this.sessionConfirms[i] ?? ''
      if (session) {
        if (seen.has(session)) continue
        seen.add(session)
      }
      count += 1
    }
    return count
  }

  /** Recency-weighted confirmations minus LAMBDA-weighted contradictions. */
  score(now: number): number {
    let score = 0
    for (const [index] of this.confirms) score += Math.pow(GAMMA, now - index)
    let contradictions = 0
    for (const index of this.contradicts) contradictions += Math.pow(GAMMA, now - index)
    return score - LAMBDA * contradictions
  }

  firingRate(): number {
    return this.fireDen > 0 ? this.fireNum / this.fireDen : 0
  }

  /** ACTIVE and clears the firing gate -> goes into the rendered manual. */
  injectable(): boolean {
    return this.state === 'ACTIVE' && this.fireDen >= FIRE_MIN_N && this.firingRate() >= FIRE_GATE
  }

  update(
    now: number,
    verdict: Verdict,
    fired: boolean,
    exercised: boolean,
    files: Iterable<string>,
    sessionId = '',
  ): void {
    if (exercised) {
      this.fireDen += 1
      if (fired) this.fireNum += 1
    }
    if (verdict === 'confirm') {
      // A session is one piece of evidence per fact: several turns in the same session must
      // not promote a CANDIDATE (upstream folds a finished session once).
      if (!sessionId || !this.sessionConfirms.includes(sessionId)) {
        this.confirms.push([now, [...files].sort()])
        this.sessionConfirms.push(sessionId)
      }
    } else if (verdict === 'contradict') {
      this.contradicts.push(now)
    }
    if (this.state === 'CANDIDATE') {
      if (this.driftedConfirms() >= this.kPromote) {
        this.state = 'ACTIVE'
        this.promotedAt = now
      }
    } else if (this.state === 'ACTIVE') {
      const hard = this.high && verdict === 'contradict' && HARD_KILL
      if (hard || this.score(now) < SCORE_FLOOR) {
        this.state = 'RETIRED'
        this.retiredAt = now
      }
    }
  }

  toDict(): LifecycleDict {
    return {
      key: this.key,
      high: this.high,
      drift: this.drift,
      state: this.state,
      confirms: this.confirms.map(([index, files]) => [index, [...files]] as [number, string[]]),
      contradicts: [...this.contradicts],
      fire_num: this.fireNum,
      fire_den: this.fireDen,
      promoted_at: this.promotedAt,
      retired_at: this.retiredAt,
    }
  }

  static fromDict(dict: LifecycleDict | (Partial<LifecycleDict> & { key?: string }), options: LifecycleOptions = {}): Lifecycle {
    const life = new Lifecycle(
      String(dict.key ?? ''),
      Boolean(dict.high),
      dict.drift === undefined ? true : Boolean(dict.drift),
      options,
    )
    if (dict.state) life.state = dict.state as FactState
    life.confirms = (dict.confirms ?? []).map(([index, files]) => [Number(index), [...(files ?? [])]] as [number, string[]])
    life.contradicts = [...(dict.contradicts ?? [])].map(Number)
    life.fireNum = Number(dict.fire_num ?? 0)
    life.fireDen = Number(dict.fire_den ?? 0)
    life.promotedAt = dict.promoted_at ?? null
    life.retiredAt = dict.retired_at ?? null
    return life
  }
}

export interface FoldOptions extends LifecycleOptions {
  /**
   * Retire a CANDIDATE high-stakes fact on a clean contradiction, as envfacts.fold does. The
   * upstream `Lifecycle.update` itself only hard-kills ACTIVE facts; the environment-fact
   * layer adds the candidate rule, so it stays opt-in here.
   */
  readonly hardKillCandidates?: boolean
}

/**
 * One task's evidence folded into a fact (`lifecycle.Lifecycle.update`, plus the optional
 * CANDIDATE hard-kill from `envfacts.fold`). Returns the verdict actually applied.
 */
export function foldLifecycle(
  life: Lifecycle,
  now: number,
  verdict: Verdict,
  fired: boolean,
  exercised: boolean,
  files: Iterable<string>,
  options: FoldOptions = {},
  sessionId = '',
): Verdict {
  life.update(now, verdict, fired, exercised, files, sessionId)
  if (options.hardKillCandidates && verdict === 'contradict' && life.high && life.state === 'CANDIDATE') {
    life.state = 'RETIRED'
    life.retiredAt = now
  }
  return verdict
}

/** True for a row that may be injected (`State ACTIVE`, enabled, firing gate cleared). */
export function isInjectableRow(row: Pick<StoredFact, 'state' | 'enabled' | 'fireNum' | 'fireDen'>): boolean {
  if (row.state !== 'ACTIVE' || row.enabled === false) return false
  const den = row.fireDen ?? 0
  const num = row.fireNum ?? 0
  return den >= FIRE_MIN_N && (den > 0 ? num / den : 0) >= FIRE_GATE
}

/** Rebuild the lifecycle of a stored row. */
export function lifecycleFromStored(row: StoredFact, options: LifecycleOptions = {}): Lifecycle {
  const life = new Lifecycle(row.key, Boolean(row.high), Boolean(row.drift), options)
  life.state = row.state
  life.confirms = (row.confirms ?? []).map(([index, files]) => [Number(index), [...(files ?? [])]] as [number, string[]])
  life.sessionConfirms = (row.confirmSessions ?? []).slice(0, life.confirms.length)
  life.contradicts = [...(row.contradicts ?? [])].map(Number)
  life.fireNum = Number(row.fireNum ?? 0)
  life.fireDen = Number(row.fireDen ?? 0)
  life.promotedAt = row.promotedAt ?? null
  life.retiredAt = row.retiredAt ?? null
  return life
}

/** Write a lifecycle back onto a row in place (the caller owns the row's text/source). */
export function applyLifecycleToStored(row: StoredFact, life: Lifecycle): StoredFact {
  row.key = life.key
  row.high = life.high
  row.drift = life.drift
  row.state = life.state
  row.confirms = life.confirms.map(([index, files]) => [index, [...files]] as [number, string[]])
  if (life.sessionConfirms.some(Boolean)) row.confirmSessions = [...life.sessionConfirms]
  else delete row.confirmSessions
  row.contradicts = [...life.contradicts]
  row.fireNum = life.fireNum
  row.fireDen = life.fireDen
  row.promotedAt = life.promotedAt
  row.retiredAt = life.retiredAt
  return row
}

/** Everything a new row needs that is not part of the lifecycle itself. */
export interface StoredFactMeta {
  readonly id: string
  readonly text: string
  readonly kind: StoredFact['kind']
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastUsedAt?: string | null
  readonly enabled?: boolean
  readonly source?: StoredFact['source']
}

/** Build a fresh `StoredFact` from a lifecycle and its metadata. */
export function storedFactFromLifecycle(life: Lifecycle, meta: StoredFactMeta): StoredFact {
  return {
    id: meta.id,
    key: life.key,
    text: meta.text,
    kind: meta.kind,
    high: life.high,
    drift: life.drift,
    state: life.state,
    confirms: life.confirms.map(([index, files]) => [index, [...files]] as [number, string[]]),
    ...(life.sessionConfirms.some(Boolean) ? { confirmSessions: [...life.sessionConfirms] } : {}),
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
  }
}
