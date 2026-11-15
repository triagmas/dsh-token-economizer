/**
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0, `tokeneconomizer/microskills/envfacts.py`.
 *
 * What a session's failures say about THIS repository's environment, learned without a model.
 * The facts are the ones a person would state after a day in the checkout -- how its tests
 * have to be invoked, which variable its imports need, which host refuses connections -- and
 * they are rendered into a block prefixed to the next session's task text.
 *
 * Nothing here is paid: `opt_tokens` is 0.0 by construction (`EnvFactsDistiller` accepts no
 * runner and no model). The structural difference from upstream is that upstream reads a
 * transcript path and calls `observe_task` itself; this port takes the `ObservedTask` digest
 * the caller already computed from in-memory calls, so it never touches the filesystem.
 */
import type { FactKind, StoredFact } from '../core/types.js'
import {
  DEFAULT_VOCAB,
  NETWORK_ERRORS,
  formFailed,
  formWorked,
  isBare,
  labelRule,
  type ErrorClass,
  type Observation,
  type ObservedTask,
  type Vocabulary,
} from './observe.js'
import { Lifecycle, type LifecycleOptions, type Verdict } from './lifecycle.js'

/** `STATE_SUBDIR` (upstream persistence directory; the plugin stores rows instead). */
export const STATE_SUBDIR = 'envfacts_state'
/** `MAX_FACTS`: at most this many facts in the block. */
export const MAX_FACTS = 4
/** `MAX_TOKENS`: ~4 chars per token; the whole block, header included. */
export const MAX_TOKENS = 150
/** `HEADER`, verbatim. */
export const HEADER = '# environment facts learned from earlier tasks in this checkout'
/** `GENERIC_HEADER` (the plugin's): a person's work comes in sessions, not tasks. */
export const GENERIC_HEADER =
  '# environment facts learned from earlier sessions in this repository'

/** `CONTRADICT_STREAK`: FormRepair consecutive contradicted tasks before one counts. */
export const CONTRADICT_STREAK = 2

// Words that would turn a fact into completion or verification advice.
const LINT_RE = /\b(skip|no need|don'?t|do not|stop|done|completed?|finish(?:ed)?|verify|verification|instead of (?:running|testing))\b/i

/** `_ERROR_PHRASE`, verbatim. */
export const ERROR_PHRASE: Readonly<Record<string, string>> = {
  module_missing: 'ModuleNotFoundError',
  command_missing: 'command not found',
  script_missing: 'a file-not-found error',
  usage_error: 'a usage error',
  permission_denied: 'permission denied',
}

export type EnvFactFamily =
  | 'form_repair'
  | 'arg_repair'
  | 'env_value'
  | 'absent_tool'
  | 'boundary'
  | 'empty_probe'

export type EnvParams = Record<string, unknown>

/** One learned environment fact (`envfacts.py:EnvFact`). */
export class EnvFact {
  readonly id: string
  readonly family: EnvFactFamily
  params: EnvParams
  /** `drift=False`: an environment fact holds whatever files a session edits. */
  readonly life: Lifecycle

  constructor(id: string, family: EnvFactFamily, high: boolean, params: EnvParams = {}, options: LifecycleOptions = {}) {
    this.id = id
    this.family = family
    this.params = params
    this.life = new Lifecycle(id, high, false, options)
  }

  get state(): string {
    return this.life.state
  }

  injectable(): boolean {
    return this.life.injectable()
  }

  firingRate(): number {
    return this.life.firingRate()
  }

  /** The sentence this fact contributes to the block; "" when it claims nothing. */
  claim(): string {
    const p = this.params
    if (this.family === 'form_repair') {
      const b = this.workingForm()
      if (b === null) return ''
      const e = (this.best('error_counts') as string | null) ?? 'module_missing'
      return `${usage(p.a as string)} fails here with ${ERROR_PHRASE[e] ?? e}; ${usage(b)} works.`
    }
    if (this.family === 'boundary') {
      const counts = (p.hosts as Record<string, number> | undefined) ?? {}
      const hosts = mostCommon(counts, 3)
      return `Outbound connections to ${joinPhrases(hosts)} are refused here; nothing can be fetched from them.`
    }
    if (this.family === 'arg_repair') {
      if (p.kind === 'sep') {
        return `${usage(p.form as string, '')} takes dotted test labels (\`module.Class.test\`, not \`module::Class::test\`).`
      }
      const examples = (p.examples as Record<string, number> | undefined) ?? {}
      const pairs = Object.keys(examples).length > 0 ? Object.keys(examples).map((key) => splitFirst(key)) : [['x', 'x'] as [string, string]]
      const [a, b] = pairs.reduce((bestPair, pair) => (pair[0].length < bestPair[0].length ? pair : bestPair))
      return `${usage(p.form as string, '')} takes test labels without the \`${String(p.param)}\` prefix (\`${b}\`, not \`${a}\`).`
    }
    if (this.family === 'env_value') {
      const good = (this.best('good') as string | null) ?? ''
      const bad = Object.keys((p.bad as Record<string, number> | undefined) ?? {})
        .sort()
        .filter((value) => value !== good)
        .slice(0, 1)
      return (
        `Code that imports the project needs \`${String(p.var)}\` set here: ` +
        `\`${String(p.var)}=${good}\` works` +
        (bad.length > 0 ? `, \`${bad[0]}\` does not.` : '.')
      )
    }
    if (this.family === 'absent_tool') {
      return `\`${String(p.tool)} …\` fails here with command not found, and no other way to run it has worked.`
    }
    if (this.family === 'empty_probe') {
      return 'This checkout has no git remote and no branches, tags or unreachable objects beyond HEAD; its history ends at the checked-out commit.'
    }
    return ''
  }

  /** The most frequent key of a counted map, or null (`EnvFact._best`). */
  best(key: string): string | null {
    const counts = (this.params[key] as Record<string, number> | undefined) ?? {}
    return mostCommon(counts, 1)[0] ?? null
  }

  /**
   * The form a FormRepair names: the one with the best record (times it worked as typed less
   * times it failed), among those that leave the shell where it is whenever one of them has a
   * good record at all. Null when no form has.
   */
  workingForm(): string | null {
    const counts = (this.params.b_counts as Record<string, number> | undefined) ?? {}
    const failed = (this.params.b_fails as Record<string, number> | undefined) ?? {}
    const net: Record<string, number> = {}
    for (const [form, n] of Object.entries(counts)) {
      const bad = failed[form] ?? 0
      if (n > bad) net[form] = n - bad
    }
    const entries = Object.entries(net)
    const poolEntries = entries.filter(([form]) => !movesShell(form))
    const pool = poolEntries.length > 0 ? poolEntries : entries
    if (pool.length === 0) return null
    let bestForm = pool[0] as [string, number]
    for (const entry of pool.slice(1)) {
      const [, netBest] = bestForm
      const [form, netForm] = entry
      if (netForm > netBest || (netForm === netBest && (counts[form] ?? 0) > (counts[bestForm[0]] ?? 0))) {
        bestForm = entry
      }
    }
    return bestForm[0]
  }
}

function splitFirst(text: string): [string, string] {
  const index = text.indexOf(' ')
  return index < 0 ? [text, ''] : [text.slice(0, index), text.slice(index + 1)]
}

function mostCommon(counts: Record<string, number>, limit: number): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key)
}

/** `_usage`: a form as a claim shows it; a form that moves the shell is shown as a subshell. */
export function usage(form: string, args = ' …'): string {
  return movesShell(form) ? `\`(${form}${args})\`` : `\`${form}${args}\``
}

/** `_moves_shell`. */
export function movesShell(form: string): boolean {
  return form.startsWith('cd ') && form.includes(' && ')
}

/** `_root`: the part of a working form that carries the environment. */
export function rootOf(form: string): string {
  if (form.includes(' && ')) return form.split(' && ', 1)[0] as string
  if (['conda run', 'poetry run', 'pipenv run', 'uv run', 'npx'].some((prefix) => form.startsWith(prefix))) {
    return form.split(/\s+/).slice(0, 3).join(' ')
  }
  const head = form.split(/\s+/)[0] ?? ''
  return head.includes('/') ? head.slice(0, head.lastIndexOf('/')) : head
}

/** `_join`: `a`, `a and b`, `a, b and c`. */
export function joinPhrases(items: readonly string[]): string {
  if (items.length === 0) return 'the hosts it tried'
  if (items.length === 1) return items[0] as string
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`
}

/** `lint_ok`: false when the text would turn a fact into completion or verification advice. */
export function lintOk(text: string): boolean {
  return !LINT_RE.test(text ?? '')
}

const RUN_WORDS: ReadonlySet<string> = new Set([
  'run',
  'npx',
  'uv',
  'uvx',
  'pipx',
  'poetry',
  'pipenv',
  'conda',
  '-m',
  'python',
  'python3',
])

/** `_repairs`: can `form` stand in for the failing `aForm`? */
export function repairs(form: string, aForm: string, intent: string): boolean {
  if (form === aForm) return false
  if (intent === 'run_build') {
    const a = new Set(form.split(/\s+/))
    const b = new Set(aForm.split(/\s+/))
    const shared = [...a].filter((word) => b.has(word) && !RUN_WORDS.has(word))
    return shared.length > 0
  }
  return intent === 'run_tests' || !isBare(form)
}

/** `_tool_of`: the executable a form runs, by its last word. */
export function toolOf(form: string): string {
  const words = form.split(/\s+/).filter(Boolean)
  const last = words.length > 0 ? (words[words.length - 1] as string) : ''
  return last.includes('/') ? last.slice(last.lastIndexOf('/') + 1) : last
}

/** `typed_ok`: the form worked exactly as typed (no `VAR=value` before it). */
export function typedOk(observation: Observation): boolean {
  return formWorked(observation) && !observation.env
}

/**
 * Fold one task's verdict into a fact (`envfacts.py:fold`). Two adjustments to the shared
 * state machine: a high-stakes CANDIDATE retires at once on a contradiction, and a FormRepair
 * contradiction only counts after `CONTRADICT_STREAK` consecutive exercised tasks said so.
 */
export function fold(
  fact: EnvFact,
  now: number,
  verdict: Verdict,
  fired: boolean,
  exercised: boolean,
  files: Iterable<string>,
  sessionId = '',
): Verdict {
  let applied = verdict
  if (fact.family === 'form_repair' && exercised) {
    const streak = Number(fact.params.contra_streak ?? 0)
    const next = applied === 'contradict' ? streak + 1 : 0
    fact.params.contra_streak = next
    if (applied === 'contradict' && next < CONTRADICT_STREAK) applied = null
  }
  fact.life.update(now, applied, fired, exercised, files, sessionId)
  if (applied === 'contradict' && fact.life.high && fact.life.state === 'CANDIDATE') {
    fact.life.state = 'RETIRED'
    fact.life.retiredAt = now
  }
  return applied
}

export interface EnvFactsOptions extends LifecycleOptions {
  readonly vocab?: Vocabulary
  /** Upstream `max_facts or MAX_FACTS`. */
  readonly maxFacts?: number
  /** Upstream `max_tokens or MAX_TOKENS`. */
  readonly maxTokens?: number
  /** The task counter `now` starts at (upstream starts at 0 and increments per update). */
  readonly now?: number
}

export interface EnvUpdateOptions {
  readonly iid?: string
  readonly resolved?: boolean | null
  /** Override the edited-file list from the digest. */
  readonly edited?: Iterable<string>
  /** The finished session being folded; repeated folds of one session count once. */
  readonly sessionId?: string
}

export interface EnvTaskDigest {
  readonly iid: string
  readonly resolved: boolean | null
  readonly injected: string[]
  readonly verdicts: Record<string, [Verdict, boolean, boolean]>
  readonly n_calls: number
}

/**
 * Learns and injects environment facts over a repository's task stream (`EnvFactsDistiller`).
 *
 * Interface parity with the upstream distiller: `render()` gives the block for the NEXT task
 * ("" if none), `update(digest)` folds one finished task, `injectedIds()`/`seedInjected(ids)`
 * carry what was actually injected across a process boundary, and `injectableClaims()` is
 * what a paid proposer stacked on top is told not to restate.
 */
export class EnvFactsDistiller {
  readonly maxFacts: number
  readonly maxTokens: number
  readonly vocab: Vocabulary
  readonly options: LifecycleOptions
  /** The monotonic task counter (`now`); the engine sets it to the window's task index. */
  now: number
  readonly facts: Map<string, EnvFact> = new Map()
  /** Invariant: LLM-free. */
  readonly optTokens = 0
  /** Fact ids rendered for the task now running. */
  lastInjected: Set<string> = new Set()
  /** The most recent per-task verdicts (telemetry). */
  lastDigest: EnvTaskDigest | null = null
  /** Session currently being folded; every fact in this pass shares it. */
  private sessionId = ''

  constructor(options: EnvFactsOptions = {}) {
    this.maxFacts = options.maxFacts || MAX_FACTS
    this.maxTokens = options.maxTokens || MAX_TOKENS
    this.vocab = options.vocab ?? DEFAULT_VOCAB
    this.options = options.kPromote === undefined ? {} : { kPromote: options.kPromote }
    this.now = options.now ?? 0
  }

  // ---- render --------------------------------------------------------------------
  get header(): string {
    return this.vocab.generic ? GENERIC_HEADER : HEADER
  }

  /** The block for the next task, "" when no fact is injectable; sets `lastInjected`. */
  render(): string {
    const chosen = this.select()
    this.lastInjected = new Set(chosen.map((fact) => fact.id))
    if (chosen.length === 0) return ''
    const lines = [this.header, ...this.mergedLines(chosen).map((text) => `- ${text}`)]
    return `${lines.join('\n')}\n`
  }

  /** The ids the last `render` chose, sorted (what the next session is given). */
  injectedIds(): string[] {
    return [...this.lastInjected].sort()
  }

  /** Say which facts the task about to be folded was actually given. */
  seedInjected(ids: Iterable<string> | null | undefined): void {
    this.lastInjected = new Set([...(ids ?? [])].filter((id) => this.facts.has(id)))
  }

  /** The claims that would be injected now, one string each (no header). */
  injectableClaims(): string[] {
    return this.select().map((fact) => fact.claim())
  }

  /** The injectable facts, ordered as upstream `_select` orders them. */
  select(): EnvFact[] {
    const candidates = [...this.facts.values()].filter(
      (fact) => fact.injectable() && Boolean(fact.claim()) && lintOk(fact.claim()),
    )
    const priority: Record<string, number> = {
      form_repair: 0,
      arg_repair: 1,
      env_value: 2,
      absent_tool: 3,
      empty_probe: 4,
      boundary: 5,
    }
    candidates.sort((a, b) => {
      const pa = priority[a.family] ?? 9
      const pb = priority[b.family] ?? 9
      if (pa !== pb) return pa - pb
      const ia = a.params.intent === 'run_interpreter' ? 0 : 1
      const ib = b.params.intent === 'run_interpreter' ? 0 : 1
      if (ia !== ib) return ia - ib
      return b.firingRate() - a.firingRate()
    })
    const chosen: EnvFact[] = []
    for (const fact of candidates) {
      const trial = [...chosen, fact]
      if (trial.length > this.maxFacts) break
      const text = `${this.header}\n${this.mergedLines(trial).map((line) => `- ${line}`).join('\n')}`
      if (text.length > this.maxTokens * 4) continue
      chosen.push(fact)
    }
    return chosen
  }

  /**
   * FormRepair facts whose working forms share a root (the same activation prefix or the same
   * directory) collapse into one line: they are one environment fact.
   */
  mergedLines(facts: readonly EnvFact[]): string[] {
    const lines: string[] = []
    const groups = new Map<string, EnvFact[]>()
    for (const fact of facts) {
      if (fact.family === 'form_repair') {
        const key = rootOf(fact.workingForm() ?? '')
        const group = groups.get(key)
        if (group) group.push(fact)
        else groups.set(key, [fact])
      } else {
        lines.push(fact.claim())
      }
    }
    for (const group of groups.values()) {
      if (group.length === 1) {
        lines.unshift((group[0] as EnvFact).claim())
        continue
      }
      const aForms = joinPhrases(group.map((fact) => usage(fact.params.a as string)))
      const errs = [
        ...new Set(
          group
            .map((fact) => ERROR_PHRASE[(fact.best('error_counts') as string | null) ?? ''] ?? '')
            .filter((phrase) => phrase !== ''),
        ),
      ].sort()
      const bs = [...new Set(group.map((fact) => usage(fact.workingForm() as string)))].sort()
      lines.unshift(
        `${aForms} fail here (${errs.length > 0 ? errs.join(', ') : 'environment error'}); ` +
          `${joinPhrases(bs)} ${bs.length === 1 ? 'works' : 'work'}.`,
      )
    }
    return lines
  }

  // ---- update --------------------------------------------------------------------
  /**
   * Fold one finished task's digest into the facts. Upstream's `update(transcript_path, ...)`
   * takes a path and observes it; here the digest is the caller's, so this stays pure.
   */
  update(digest: ObservedTask, options: EnvUpdateOptions = {}): void {
    this.sessionId = options.sessionId ?? ''
    const obs = digest.obs
    const files = new Set(options.edited ?? digest.edited)
    const injected = new Set(this.lastInjected)
    const verdicts: Record<string, [Verdict, boolean, boolean]> = {}

    const byIntent = new Map<string, Observation[]>()
    for (const observation of obs) {
      const list = byIntent.get(observation.intent)
      if (list) list.push(observation)
      else byIntent.set(observation.intent, [observation])
    }

    // ---- FormRepair: discover candidates, then fold every fact ----
    for (const intent of ['run_interpreter', 'run_tests', 'run_build', 'package_tool']) {
      const seq = byIntent.get(intent) ?? []
      // A test run that failed because its LABEL did not load says nothing about the way the
      // runner was called (Django reports a bad label as a ModuleNotFoundError).
      let fails = seq.filter((observation) => formFailed(observation))
      if (intent !== 'run_tests' && intent !== 'run_build') {
        fails = fails.filter((observation) => isBare(observation.form))
      }
      for (const a of fails) {
        if (!seq.some((observation) => typedOk(observation) && observation.call > a.call && repairs(observation.form, a.form, intent))) {
          continue
        }
        const fid = `form_repair:${intent}:${a.form}`
        let fact = this.facts.get(fid)
        if (!fact) {
          fact = new EnvFact(fid, 'form_repair', false, {
            intent,
            a: a.form,
            b_counts: {},
            error_counts: {},
          })
          this.facts.set(fid, fact)
        }
        const errorCounts = fact.params.error_counts as Record<string, number>
        const outcome = String(a.outcome)
        errorCounts[outcome] = (errorCounts[outcome] ?? 0) + 1
      }
      // A session is one piece of evidence per form.
      const ok = new Set(seq.filter((observation) => typedOk(observation)).map((observation) => observation.form))
      const failed = new Set(
        seq
          .filter((observation) => formFailed(observation) && !observation.env)
          .map((observation) => observation.form),
      )
      for (const form of ok) failed.delete(form)
      for (const fact of this.facts.values()) {
        if (fact.family !== 'form_repair' || fact.params.intent !== intent) continue
        const bCounts = fact.params.b_counts as Record<string, number>
        for (const form of ok) {
          if (repairs(form, fact.params.a as string, intent)) {
            bCounts[form] = (bCounts[form] ?? 0) + 1
          }
        }
        const bFails = (fact.params.b_fails as Record<string, number> | undefined) ?? ((fact.params.b_fails = {}) as Record<string, number>)
        for (const form of failed) {
          if (form in bCounts) bFails[form] = (bFails[form] ?? 0) + 1
        }
      }
    }
    for (const fact of [...this.facts.values()].filter((item) => item.family === 'form_repair')) {
      const intent = fact.params.intent as string
      const aForm = fact.params.a as string
      const seq = byIntent.get(intent) ?? []
      const exercised = seq.length > 0
      const aFailed = seq.some((observation) => observation.form === aForm && formFailed(observation))
      const bForms = new Set(Object.keys(fact.params.b_counts as Record<string, number>))
      const bRan =
        seq.some((observation) => bForms.has(observation.form) && formWorked(observation)) ||
        seq.some((observation) => formWorked(observation) && !isBare(observation.form) && repairs(observation.form, aForm, intent))
      const aRunnerOk = (byIntent.get(intent === 'run_build' ? 'run_build' : 'run_tests') ?? []).some(
        (observation) => observation.form === aForm && formWorked(observation),
      )
      const fired = aFailed || (injected.has(fact.id) && bRan && !aFailed)
      let verdict: Verdict
      if (aFailed || (bRan && !aRunnerOk)) verdict = 'confirm'
      else if (aRunnerOk) verdict = 'contradict'
      else verdict = null
      fold(fact, this.now, verdict, fired, exercised, files, this.sessionId)
      verdicts[fact.id] = [verdict, fired, exercised]
    }

    // ---- AbsentTool: a bare tool that is not installed and has no working form here ----
    if (this.vocab.generic) {
      const repaired = new Set(
        [...this.facts.values()]
          .filter((fact) => fact.family === 'form_repair' && fact.workingForm() !== null)
          .map((fact) => fact.params.a as string),
      )
      const missing = new Map<string, string>()
      for (const observation of obs) {
        if (
          (observation.intent === 'run_build' || observation.intent === 'run_tests' || observation.intent === 'package_tool') &&
          observation.outcome === 'command_missing' &&
          observation.notFound &&
          isBare(observation.form) &&
          !observation.form.includes(' ') &&
          !repaired.has(observation.form)
        ) {
          if (!missing.has(observation.form)) missing.set(observation.form, observation.intent)
        }
      }
      const worked = new Set(obs.filter((observation) => formWorked(observation)).map((observation) => toolOf(observation.form)))
      for (const [tool, intent] of missing) {
        if (worked.has(tool)) continue
        const fid = `absent_tool:${tool}`
        if (!this.facts.has(fid)) {
          this.facts.set(fid, new EnvFact(fid, 'absent_tool', true, { tool, intent }))
        }
      }
      for (const fact of [...this.facts.values()].filter((item) => item.family === 'absent_tool')) {
        const tool = fact.params.tool as string
        const seen = obs.filter((observation) => toolOf(observation.form) === tool)
        const contradicted = repaired.has(tool) || seen.some((observation) => formWorked(observation))
        const missingNow = seen.some(
          (observation) =>
            observation.outcome === 'command_missing' &&
            observation.notFound &&
            observation.form === tool &&
            isBare(observation.form),
        )
        // Injected, it counts a session only when that session ran another check of the same
        // kind: one that never needed the tool says nothing about it.
        const prevented =
          injected.has(fact.id) &&
          !contradicted &&
          obs.some((observation) => observation.intent === fact.params.intent)
        const fired = missingNow || prevented
        const exercised = fired || contradicted
        const verdict: Verdict = contradicted ? 'contradict' : fired ? 'confirm' : null
        fold(fact, this.now, verdict, fired, exercised, files, this.sessionId)
        verdicts[fact.id] = [verdict, fired, exercised]
      }
    }

    // ---- ArgRepair: labels the runner loads only in another shape ----
    const runs = (byIntent.get('run_tests') ?? []).filter((observation) => observation.labels.length > 0)
    for (let i = 0; i < runs.length; i += 1) {
      const aObs = runs[i] as Observation
      if (!aObs.labelErr) continue
      for (const a of aObs.labels) {
        for (const bObs of runs.slice(i + 1)) {
          if (bObs.form !== aObs.form || !bObs.loaded) continue
          let rule: readonly [string, string] | null = null
          for (const b of bObs.labels) {
            rule = labelRule(a, b)
            if (rule) break
          }
          if (!rule) continue
          const b = bObs.labels.find((label) => {
            const candidate = labelRule(a, label)
            return candidate !== null && candidate[0] === rule?.[0] && candidate[1] === rule?.[1]
          }) as string
          const fid = `arg_repair:${aObs.form}:${rule[0]}:${rule[1]}`
          let fact = this.facts.get(fid)
          if (!fact) {
            fact = new EnvFact(fid, 'arg_repair', false, {
              form: aObs.form,
              kind: rule[0],
              param: rule[1],
              examples: {},
            })
            this.facts.set(fid, fact)
          }
          const examples = fact.params.examples as Record<string, number>
          const key = `${a} ${b}`
          examples[key] = (examples[key] ?? 0) + 1
          break
        }
      }
    }
    for (const fact of [...this.facts.values()].filter((item) => item.family === 'arg_repair')) {
      const mine = runs.filter((observation) => observation.form === fact.params.form)
      const kind = fact.params.kind as string
      const param = fact.params.param as string
      const isBad = kind === 'sep' ? (label: string) => label.includes('::') : (label: string) => label.startsWith(param)
      const badFailed = mine.some((observation) => observation.labelErr && observation.labels.some(isBad))
      const badLoaded = mine.some((observation) => observation.loaded && observation.labels.some(isBad))
      const goodLoaded = mine.some((observation) => observation.loaded && observation.labels.some((label) => !isBad(label)))
      const exercised = mine.length > 0
      const fired = badFailed || (injected.has(fact.id) && goodLoaded && !badFailed)
      let verdict: Verdict
      if (badLoaded) verdict = 'contradict'
      else if (badFailed || goodLoaded) verdict = 'confirm'
      else verdict = null
      fold(fact, this.now, verdict, fired, exercised, files, this.sessionId)
      verdicts[fact.id] = [verdict, fired, exercised]
    }

    // ---- EnvValue: a variable the code asks for, and the value that satisfied it ----
    const env = digest.env
    for (let i = 0; i < env.length; i += 1) {
      const current = env[i] as ObservedTask['env'][number]
      for (const variable of current.need) {
        const later = env.slice(i + 1).filter((entry) => variable in entry.sets)
        const good = later.filter((entry) => entry.ok && !entry.need.includes(variable)).map((entry) => entry.sets[variable] as string)
        if (good.length === 0) continue
        const fid = `env_value:${variable}`
        let fact = this.facts.get(fid)
        if (!fact) {
          fact = new EnvFact(fid, 'env_value', false, { var: variable, good: {}, bad: {} })
          this.facts.set(fid, fact)
        }
        const goodCounts = fact.params.good as Record<string, number>
        const bestValue = good[0] as string
        goodCounts[bestValue] = (goodCounts[bestValue] ?? 0) + 1
        const badCounts = fact.params.bad as Record<string, number>
        for (const entry of later) {
          if (!entry.ok && entry.sets[variable] !== bestValue) {
            const value = entry.sets[variable] as string
            badCounts[value] = (badCounts[value] ?? 0) + 1
          }
        }
      }
    }
    for (const fact of [...this.facts.values()].filter((item) => item.family === 'env_value')) {
      const variable = fact.params.var as string
      const good = fact.best('good') as string
      const asked = env.some((entry) => entry.need.includes(variable))
      const goodOk = env.some((entry) => entry.sets[variable] === good && entry.ok)
      const goodFailed = env.some((entry) => entry.sets[variable] === good && entry.need.includes(variable))
      const exercised = asked || env.some((entry) => variable in entry.sets)
      const fired = asked || (injected.has(fact.id) && goodOk)
      let verdict: Verdict
      if (goodFailed) verdict = 'contradict'
      else if (goodOk) verdict = 'confirm'
      else verdict = null
      fold(fact, this.now, verdict, fired, exercised, files, this.sessionId)
      verdicts[fact.id] = [verdict, fired, exercised]
    }

    // ---- Boundary: hosts refused ----
    const fetches = byIntent.get('fetch_remote') ?? []
    const failedHosts: Record<string, number> = {}
    for (const observation of fetches) {
      if (!NETWORK_ERRORS.has(observation.outcome as ErrorClass)) continue
      for (const host of observation.hosts) failedHosts[host] = (failedHosts[host] ?? 0) + 1
    }
    const okHosts = new Set(fetches.filter((observation) => observation.outcome === 'ran').flatMap((observation) => observation.hosts))
    const fid = 'boundary:fetch_remote'
    let boundary = this.facts.get(fid)
    if (!boundary && Object.keys(failedHosts).length > 0) {
      boundary = new EnvFact(fid, 'boundary', true, { hosts: {} })
      this.facts.set(fid, boundary)
    }
    if (boundary) {
      const hosts = boundary.params.hosts as Record<string, number>
      for (const [host, count] of Object.entries(failedHosts)) hosts[host] = (hosts[host] ?? 0) + count
      const known = new Set(Object.keys(hosts))
      const exercised = fetches.some((observation) => observation.hosts.length > 0)
      const fired = Object.keys(failedHosts).length > 0
      const contradicted = [...okHosts].some((host) => known.has(host))
      let verdict: Verdict
      if (contradicted) verdict = 'contradict'
      else if (fired) verdict = 'confirm'
      else verdict = null
      fold(boundary, this.now, verdict, fired, exercised, files, this.sessionId)
      verdicts[fid] = [verdict, fired, exercised]
    }

    // ---- EmptyProbe: refs beyond the checkout ----
    const probes = (byIntent.get('probe_vcs_refs') ?? []).filter(
      (observation) => observation.outcome === 'hit' || observation.outcome === 'empty',
    )
    const probeId = 'empty_probe:vcs_refs'
    let probeFact = this.facts.get(probeId)
    if (!probeFact && probes.length > 0) {
      probeFact = new EnvFact(probeId, 'empty_probe', true, { kinds: {} })
      this.facts.set(probeId, probeFact)
    }
    if (probeFact) {
      const kinds = probeFact.params.kinds as Record<string, number>
      for (const observation of probes) {
        const kind = String(observation.probe)
        kinds[kind] = (kinds[kind] ?? 0) + 1
      }
      const exercised = probes.length > 0
      const fired = exercised
      let verdict: Verdict
      if (probes.some((observation) => observation.outcome === 'hit')) verdict = 'contradict'
      else if (probes.length > 0) verdict = 'confirm'
      else verdict = null
      fold(probeFact, this.now, verdict, fired, exercised, files, this.sessionId)
      verdicts[probeId] = [verdict, fired, exercised]
    }

    this.lastDigest = {
      iid: options.iid ?? '',
      resolved: options.resolved ?? null,
      injected: [...injected].sort(),
      verdicts,
      n_calls: digest.nCalls,
    }
    this.lastInjected = new Set()
    this.now += 1
  }

  // ---- telemetry ---------------------------------------------------------------
  debugRow(): Record<string, unknown> {
    const row: Record<string, unknown> = {}
    for (const [key, fact] of this.facts) {
      row[key] = {
        state: fact.state,
        fire: `${fact.life.fireNum}/${fact.life.fireDen}`,
        rate: Math.round(fact.firingRate() * 100) / 100,
        inject: fact.injectable(),
        claim: fact.claim().slice(0, 120),
        family: fact.family,
      }
    }
    row._profile = 'envfacts'
    row._vocab = this.vocab.name
    if (this.lastDigest) row._task = this.lastDigest
    return row
  }
}

// --------------------------------------------------------------------------------------
// persistence into the shared `StoredFact` rows
// --------------------------------------------------------------------------------------
//
// The shared contract has no per-fact parameter slot, but an environment fact is its
// parameters (which form failed, which host refused, which variable's value worked). They are
// persisted as one prefixed JSON entry in `source.evidence`; the human-readable evidence
// snippets follow it. This is a documented deviation from upstream, which serializes
// `EnvFact.to_dict()` into `envfacts_state/<repo>.json`.

export const ENV_STATE_PREFIX = 'envfacts-state:'

/** The `FactKind` a family is presented as (the shared union has no environment family). */
export function envFactKind(family: EnvFactFamily): FactKind {
  if (family === 'form_repair') return 'run'
  if (family === 'arg_repair') return 'test'
  if (family === 'absent_tool') return 'dependency'
  if (family === 'empty_probe') return 'structure'
  return 'environment'
}

export interface EnvStoredMeta {
  readonly createdAt: string
  readonly updatedAt?: string
  readonly lastUsedAt?: string | null
  readonly enabled?: boolean
  readonly sessionId?: string
  readonly turn?: number
}

/** Serialize one fact to a `StoredFact` row (stable, deterministic key order). */
export function envFactToStored(fact: EnvFact, meta: EnvStoredMeta): StoredFact {
  const state = JSON.stringify({ family: fact.family, params: fact.params })
  return {
    id: fact.id,
    key: fact.id,
    text: fact.claim(),
    kind: envFactKind(fact.family),
    high: fact.life.high,
    drift: false,
    state: fact.life.state,
    confirms: fact.life.confirms.map(([index, files]) => [index, [...files]] as [number, string[]]),
    ...(fact.life.sessionConfirms.some(Boolean) ? { confirmSessions: [...fact.life.sessionConfirms] } : {}),
    contradicts: [...fact.life.contradicts],
    fireNum: fact.life.fireNum,
    fireDen: fact.life.fireDen,
    promotedAt: fact.life.promotedAt,
    retiredAt: fact.life.retiredAt,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt ?? meta.createdAt,
    lastUsedAt: meta.lastUsedAt ?? null,
    enabled: meta.enabled ?? true,
    source: {
      sessionId: meta.sessionId ?? '',
      turn: meta.turn ?? 0,
      evidence: [`${ENV_STATE_PREFIX}${state}`, fact.claim()],
    },
  }
}

/** True when a stored row was written by the environment-fact layer. */
export function isEnvFactRow(row: Pick<StoredFact, 'source'>): boolean {
  return (row.source?.evidence ?? []).some((entry) => entry.startsWith(ENV_STATE_PREFIX))
}

/** Rebuild a fact from a stored row; null when the row is not an environment fact. */
export function envFactFromStored(row: StoredFact, options: LifecycleOptions = {}): EnvFact | null {
  const entry = (row.source?.evidence ?? []).find((item) => item.startsWith(ENV_STATE_PREFIX))
  if (!entry) return null
  let parsed: { family?: string; params?: EnvParams }
  try {
    parsed = JSON.parse(entry.slice(ENV_STATE_PREFIX.length)) as { family?: string; params?: EnvParams }
  } catch {
    return null
  }
  if (!parsed.family) return null
  const fact = new EnvFact(row.key, parsed.family as EnvFactFamily, Boolean(row.high), parsed.params ?? {}, options)
  fact.life.state = row.state
  fact.life.confirms = (row.confirms ?? []).map(([index, files]) => [Number(index), [...(files ?? [])]] as [number, string[]])
  fact.life.sessionConfirms = (row.confirmSessions ?? []).slice(0, fact.life.confirms.length)
  fact.life.contradicts = [...(row.contradicts ?? [])].map(Number)
  fact.life.fireNum = Number(row.fireNum ?? 0)
  fact.life.fireDen = Number(row.fireDen ?? 0)
  fact.life.promotedAt = row.promotedAt ?? null
  fact.life.retiredAt = row.retiredAt ?? null
  return fact
}
