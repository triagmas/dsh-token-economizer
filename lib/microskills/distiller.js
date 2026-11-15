/**
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0, `tokeneconomizer/microskills/distiller.py`.
 *
 * The paid proposer's PURE half: the compact digest each finished task contributes, the
 * detector/extractor DSL the host evaluates without a model, the authored-fact type, and the
 * proposer prompt plus its parser. The paid call itself is deliberately not made here: this
 * port exposes `buildProposerPrompt` and `parsePayload` so the caller (which owns the model
 * runner and the ledger) decides when to spend, and `Distiller.admit` keeps the host-side
 * grounding and revision rules for whatever that call returns.
 *
 * Adaptation notes (also documented in `DEVIATIONS.md`):
 *  - upstream reads an agent transcript path (`load_calls`, `call_cwds`, `CONVERSATION`); this
 *    port takes the in-memory calls the Harness already has, so `buildDigest` never touches
 *    the filesystem.
 *  - `_relative` writes the home directory as `~` via `os.path.expanduser("~")`; the caller may
 *    pass `home`, else `node:os` `homedir()` is used. That is the module's only environment
 *    read, and it only affects prompt whitespace, never a decision.
 */
import { homedir } from 'node:os';
import { bashCommands as observeBashCommands, commandFailed, editedFiles, editedPyFiles, } from './observe.js';
import { Lifecycle } from './lifecycle.js';
// ---- proposer cadence / caps / gates ---------------------------------------
/** `PROPOSE_EVERY`: one proposer call per this many tasks. */
export const PROPOSE_EVERY = 8;
/** `WINDOW`: digests handed to the proposer per tick (rolling). */
export const WINDOW = 8;
/** `MAX_CANDS`: cap facts emitted per tick. */
export const MAX_CANDS = 4;
/** `MIN_CITE`: a candidate must cite >= this many confirming task-ids. */
export const MIN_CITE = 2;
/** `MAX_EXTRACTORS`: cap authored features. */
export const MAX_EXTRACTORS = 12;
/** `RAW_SAMPLE`: raw excerpts shown on an abstaining tick. */
export const RAW_SAMPLE = 3;
/** `ABSTAIN_GATE`: tick is "abstaining" if >= this frac of window cmds are unseen. */
export const ABSTAIN_GATE = 0.5;
/** `STATE_SUBDIR` (upstream persistence directory; the plugin stores rows instead). */
export const STATE_SUBDIR = 'manual_state';
/** `BLOB_CAP`: characters of a saved digest's raw commands. */
export const BLOB_CAP = 20_000;
// ---- regexes ---------------------------------------------------------------
export const PYTEST_RE = /-m\s+pytest|\bpytest\b|\bpy\.test\b/;
export const REPRO_RE = /python[0-9.]*\s+-c|\/tmp\/\S*\.py|reproduce|repro/;
export const BADARG_RE = /unrecognized arguments|no such option|usage:|error: argument/;
/** `CHECK_RE`: build/test/lint/type-check commands across ecosystems. */
export const CHECK_RE = /\b(?:pytest|py\.test|tox|nox|unittest|runtests\.py|jest|vitest|mocha|rspec|phpunit|ctest|tsc|eslint|prettier|ruff|flake8|pylint|mypy|pyright|golangci-lint|cmake|ninja|bazel)\b|(?:^|[\s;&|(])make\b|\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck)\b|\b(?:cargo|go|mvn|gradle|gradlew|dotnet|mix|swift)\s+(?:test|build|check|vet|clippy|compile|package|verify)\b/;
/** `TEST_RE`. */
export const TEST_RE = /\b(?:pytest|py\.test|tox|nox|unittest|runtests\.py|jest|vitest|mocha|rspec|phpunit|ctest)\b|\b(?:make|npm|yarn|pnpm|bun|cargo|go|mvn|gradle|gradlew|dotnet|mix|swift|rake)\s+(?:run\s+)?test\b/;
/** `MISSING_CMD_RE`. */
export const MISSING_CMD_RE = /command not found|: not found\b|is not recognized as/i;
/** `MISSING_DEP_RE`. */
export const MISSING_DEP_RE = /ModuleNotFoundError|No module named|ImportError|Cannot find module|ERR_MODULE_NOT_FOUND|cannot find package|could not find (?:package|crate|module|gem)|unresolved import|cannot load such file|undefined reference to|fatal error: [^\n]*: No such file/i;
/** `BAD_USAGE_RE`. */
export const BAD_USAGE_RE = /^usage:|unrecognized arguments?|no such option|unknown (?:option|flag|command)|invalid option|unexpected argument|error: argument/im;
const EXIT_RE = /\bexit(?:ed with)?(?: code| status)?[:=\s]+(\d+)/i;
const FAILED_OUT_RE = /Traceback \(most recent call last\)|^\w*Error\b/m;
const ERROR_LINE_RE = /\b(?:error|failed|failure|fatal|exception|traceback|cannot|not found|denied|refused|panic)\b/i;
/** Ordered `(command, output)` pairs from the shell calls among `calls` (`bash_cmds`). */
export function bashCmds(calls) {
    return observeBashCommands(calls).map((entry) => [entry.command, entry.output]);
}
/** `_command_failed`, re-exported so the digest and the engine share one reading. */
export { commandFailed };
/** `_templates`: dedup command shapes, dropping long path/arg tails. */
export function templates(cmds, cap = 12) {
    const seen = new Set();
    const out = [];
    for (const raw of cmds) {
        const c = (raw ?? '').trim();
        if (!c)
            continue;
        let head = c.replace(/\s+/g, ' ').slice(0, 80);
        head = head.replace(/\/testbed\/\S+/g, '<path>');
        if (!seen.has(head)) {
            seen.add(head);
            out.push(head);
        }
        if (out.length >= cap)
            break;
    }
    return out;
}
/** `proposer_view`: the token-cheap projection shown to the LLM (drops raw blobs). */
export function proposerView(digest) {
    const view = {};
    for (const [key, value] of Object.entries(digest)) {
        if (!key.startsWith('_'))
            view[key] = value;
    }
    return view;
}
function splitLines(text) {
    return (text ?? '').split(/\r?\n/);
}
/**
 * A command or error line with the repository's own paths made relative and the home
 * directory written `~` (`_relative`).
 */
export function relativeText(text, roots = [], home = null) {
    let out = text ?? '';
    for (const root of roots) {
        if (!root)
            continue;
        out = out.split(`${root}/`).join('').split(root).join('.');
    }
    out = out.replace(/^cd \.\s*(?:&&|;)\s*/, '');
    const h = home ?? homedir();
    return h && h !== '/' ? out.split(h).join('~') : out;
}
/**
 * The first line of a failing output that names the failure, normalized so two sessions that
 * fail the same way read the same: paths, numbers and addresses masked (`error_signature`).
 */
export function errorSignature(output, roots = [], home = null) {
    for (const rawLine of splitLines(output ?? '')) {
        if (!ERROR_LINE_RE.test(rawLine) && !MISSING_CMD_RE.test(rawLine))
            continue;
        let s = relativeText(rawLine.trim(), roots, home);
        s = s.replace(/0x[0-9a-fA-F]+/g, '<hex>');
        s = s.replace(/(?<![\w.~])\/[^\s'"`:,)]+/g, '<path>');
        s = s.replace(/\b\d+\b/g, 'N');
        return s.split(/\s+/).filter(Boolean).join(' ').slice(0, 120);
    }
    return '';
}
/** `build_digest`: one finished task as the proposer sees it. */
export function buildDigest(calls, options = {}) {
    if (options.generic)
        return buildGenericDigest(calls, options);
    const cmds = bashCmds(calls);
    const cmdBlob = cmds.map(([command]) => command).join('\n');
    const outBlob = cmds.map(([, output]) => output).join('\n');
    const testCmds = cmds
        .filter(([command]) => PYTEST_RE.test(command) || /runtests\.py|unittest|nosetests|tox/.test(command))
        .map(([command]) => command);
    const repro = cmds.some(([command]) => REPRO_RE.test(command) && !PYTEST_RE.test(command));
    return {
        iid: options.iid ?? '',
        resolved: options.resolved === undefined || options.resolved === null ? null : Boolean(options.resolved),
        edited_files: [...editedPyFiles(calls)].sort(),
        n_cmds: cmds.length,
        cmd_templates: templates(cmds.map(([command]) => command)),
        test_invocations: templates(testCmds).slice(0, 6),
        repro_written: repro,
        importerror: /ImportError|ModuleNotFoundError|No module named/.test(outBlob),
        badarg: BADARG_RE.test(outBlob),
        _cmd_blob: cmdBlob,
        _out_blob: outBlob,
    };
}
/** `build_generic_digest`: any language or toolchain (`Vocabulary.generic`). */
export function buildGenericDigest(calls, options = {}) {
    const cmds = bashCmds(calls);
    const start = options.startCwd ?? null;
    const roots = options.roots !== undefined
        ? [...options.roots]
        : [...new Set([start, options.top ?? null].filter((root) => Boolean(root)))].sort((a, b) => b.length - a.length);
    const outBlob = cmds.map(([, output]) => output).join('\n');
    const failed = [];
    const seen = new Set();
    for (const [command, output] of cmds) {
        if (!commandFailed(output))
            continue;
        const relative = relativeText(command, roots, options.home ?? null);
        const row = [templates([relative], 1)[0] ?? '', errorSignature(output, roots, options.home ?? null)];
        const key = JSON.stringify(row);
        if (seen.has(key))
            continue;
        seen.add(key);
        failed.push({ cmd: row[0], error: row[1] });
    }
    return {
        iid: options.iid ?? '',
        resolved: options.resolved === undefined || options.resolved === null ? null : Boolean(options.resolved),
        edited_files: [...editedFiles(calls)].sort(),
        n_cmds: cmds.length,
        cmd_templates: templates(cmds.map(([command]) => relativeText(command, roots, options.home ?? null))),
        check_commands: templates(cmds.filter(([command]) => CHECK_RE.test(command)).map(([command]) => relativeText(command, roots, options.home ?? null))).slice(0, 6),
        failed_commands: failed.slice(0, 6),
        missing_command: MISSING_CMD_RE.test(outBlob),
        missing_dependency: MISSING_DEP_RE.test(outBlob),
        bad_usage: BAD_USAGE_RE.test(outBlob),
        _ran_tests: cmds.some(([command]) => TEST_RE.test(command)),
        _cmd_blob: cmds.map(([command]) => command).join('\n'),
        _out_blob: outBlob,
    };
}
function present(digest, key) {
    return Object.prototype.hasOwnProperty.call(digest, key);
}
/** `PREDICATES`, with Python's `dg.get(key, fallback)` presence semantics preserved. */
export const PREDICATES = {
    repro_written: (digest) => Boolean(digest.repro_written),
    importerror: (digest) => (present(digest, 'importerror') ? Boolean(digest.importerror) : Boolean(digest.missing_dependency)),
    badarg: (digest) => (present(digest, 'badarg') ? Boolean(digest.badarg) : Boolean(digest.bad_usage)),
    ran_tests: (digest) => Boolean(digest.test_invocations && digest.test_invocations.length > 0) || Boolean(digest._ran_tests),
    ran_checks: (digest) => Boolean(digest.check_commands && digest.check_commands.length > 0) ||
        Boolean(digest.test_invocations && digest.test_invocations.length > 0),
    command_failed: (digest) => Boolean(digest.failed_commands && digest.failed_commands.length > 0),
    missing_command: (digest) => Boolean(digest.missing_command),
    missing_dependency: (digest) => present(digest, 'missing_dependency') ? Boolean(digest.missing_dependency) : Boolean(digest.importerror),
    bad_usage: (digest) => (present(digest, 'bad_usage') ? Boolean(digest.bad_usage) : Boolean(digest.badarg)),
    edited: (digest) => Boolean(digest.edited_files && digest.edited_files.length > 0),
};
/** `GENERIC_PREDICATES`, verbatim (and in the upstream order). */
export const GENERIC_PREDICATES = [
    'ran_checks',
    'ran_tests',
    'command_failed',
    'missing_command',
    'missing_dependency',
    'bad_usage',
    'edited',
];
/**
 * Compile a Python-flavoured pattern, translating a leading inline-flag group
 * (`(?i)`, `(?m)`, `(?s)`, combinations) into JS flags. Returns null for an invalid one.
 */
export function compilePattern(pattern) {
    if (!pattern)
        return null;
    let source = pattern;
    let flags = '';
    const inline = /^\(\?([imsx]+)\)/.exec(source);
    if (inline) {
        const letters = inline[1] ?? '';
        // `x` (verbose) has no JS equivalent: leave it out rather than corrupt the pattern.
        flags = [...new Set(letters.split('').filter((letter) => 'ims'.includes(letter)))].join('');
        source = source.slice(inline[0].length);
    }
    try {
        return new RegExp(source, flags);
    }
    catch {
        return null;
    }
}
/** `Detector`: scope/fired name a built-in predicate or a regex over commands. */
export class Detector {
    scope;
    confirm;
    contra;
    fired;
    raw;
    constructor(spec = {}) {
        this.scope = String(spec.scope ?? '');
        this.confirm = compilePattern(spec.confirm);
        this.contra = compilePattern(spec.contradict);
        this.fired = String(spec.fired ?? spec.scope ?? '');
        this.raw = spec;
    }
    cmdBlob(digest) {
        return String(digest._cmd_blob ?? '');
    }
    exercised(digest) {
        const predicate = PREDICATES[this.scope];
        if (predicate)
            return Boolean(predicate(digest));
        const pattern = compilePattern(this.scope);
        return Boolean(pattern && pattern.test(this.cmdBlob(digest)));
    }
    firedNow(digest) {
        const predicate = PREDICATES[this.fired];
        if (predicate)
            return Boolean(predicate(digest));
        const pattern = compilePattern(this.fired);
        return Boolean(pattern && pattern.test(this.cmdBlob(digest)));
    }
    verdict(digest) {
        const exercised = this.exercised(digest);
        if (!exercised)
            return [null, false, false];
        const blob = `${this.cmdBlob(digest)}\n${String(digest._out_blob ?? '')}`;
        if (this.contra && this.contra.test(blob))
            return ['contradict', true, true];
        if (this.confirm && this.confirm.test(blob))
            return ['confirm', this.firedNow(digest), true];
        return [null, this.firedNow(digest), true];
    }
}
/** `DetectorV3Scope`: scope/fired may name an authored feature, a predicate or a regex. */
export class DetectorV3Scope extends Detector {
    features;
    constructor(spec = {}, features = {}) {
        super(spec);
        this.features = features;
    }
    lookup(name, digest) {
        if (Object.prototype.hasOwnProperty.call(this.features, name))
            return Boolean(this.features[name]);
        const predicate = PREDICATES[name];
        if (predicate)
            return Boolean(predicate(digest));
        const pattern = compilePattern(name);
        return Boolean(pattern && pattern.test(this.cmdBlob(digest)));
    }
    exercised(digest) {
        return this.lookup(this.scope, digest);
    }
    firedNow(digest) {
        return this.lookup(this.fired, digest);
    }
}
/** An authored extractor: a raw-event predicate -> named feature. */
export class Extractor {
    name;
    kind;
    rx;
    spec;
    constructor(spec) {
        this.name = String(spec.name ?? '');
        this.kind = String(spec.kind ?? 'cmd_regex');
        this.rx = compilePattern(spec.pattern);
        this.spec = spec;
    }
    compute(cmds) {
        if (this.rx === null)
            return this.kind === 'cmd_count' ? 0 : false;
        if (this.kind === 'out_regex')
            return cmds.some(([, output]) => Boolean(this.rx?.test(output)));
        if (this.kind === 'cmd_count')
            return cmds.filter(([command]) => Boolean(this.rx?.test(command))).length;
        return cmds.some(([command]) => Boolean(this.rx?.test(command)));
    }
    toDict() {
        return this.spec;
    }
}
/** An authored fact: payload plus the validated lifecycle. */
export class Fact {
    id;
    claim;
    injection;
    high;
    detector;
    spec;
    life;
    constructor(spec, options = {}) {
        this.id = String(spec.id ?? '');
        this.claim = String(spec.claim ?? spec.id ?? '');
        this.injection = String(spec.injection ?? this.claim);
        this.high = Boolean(spec.high_stakes ?? false);
        this.detector = new Detector(spec.detector ?? {});
        this.spec = spec;
        this.life = new Lifecycle(this.id, this.high, true, options);
    }
    get state() {
        return this.life.state;
    }
    injectable() {
        return this.life.injectable();
    }
    firingRate() {
        return this.life.firingRate();
    }
    /** Fold one finished-task digest in. The detector is rebuilt against that task's features. */
    observe(now, digest, files) {
        const detector = new DetectorV3Scope(this.spec.detector ?? {}, digest.features ?? {});
        const [verdict, fired, exercised] = detector.verdict(digest);
        this.life.update(now, verdict, fired, exercised, files);
        return [verdict, fired, exercised];
    }
    toDict() {
        return { spec: this.spec, life: this.life.toDict() };
    }
    static fromDict(dict, options = {}) {
        const fact = new Fact(dict.spec ?? {}, options);
        if (dict.life) {
            const life = Lifecycle.fromDict(dict.life, options);
            fact.life.state = life.state;
            fact.life.confirms = life.confirms;
            fact.life.contradicts = life.contradicts;
            fact.life.fireNum = life.fireNum;
            fact.life.fireDen = life.fireDen;
            fact.life.promotedAt = life.promotedAt;
            fact.life.retiredAt = life.retiredAt;
        }
        return fact;
    }
}
/** The `FactKind` an authored fact is presented as (the shared union's vocabulary). */
export function factKind(spec) {
    const declared = String(spec.kind ?? '');
    const allowed = ['run', 'test', 'build', 'lint', 'structure', 'dependency', 'environment', 'workflow', 'error'];
    if (allowed.includes(declared))
        return declared;
    return 'workflow';
}
// ---- proposer prompt (facts + extractors + revisable contradiction) --------
const PROPOSER_HEAD = 'You mine a DURABLE, REPO-SPECIFIC operating manual for a coding agent from a ' +
    'window of finished-task digests in ONE repository. Each digest lists edited ' +
    'files, command templates, test invocations, and boolean flags — NOT raw logs.\n\n' +
    'Emit facts that a FUTURE task in this repo would want stated up front to avoid ' +
    'wasted commands: the canonical test invocation, whether a repro is redundant, a ' +
    'required env var, a build/reinstall step that\'s needed (or NOT needed), a lint/' +
    'format hook that reformats, etc. Do NOT emit task-specific fixes or which lines ' +
    'to change — only durable interface facts true across tasks.\n\n';
/** `PROPOSER_SYSTEM`, transcribed verbatim. */
export const PROPOSER_SYSTEM = PROPOSER_HEAD +
    'For EACH fact return an object with:\n' +
    '  id          short kebab slug\n' +
    '  claim       one sentence, what is true about this repo\n' +
    '  injection   the exact line to inject into the agent prefix. State it as a ' +
    'DECLARATIVE fact about the repo (where things are, what the canonical command is). ' +
    'NEVER phrase it as a prohibition on exploration or tool use — do NOT tell the agent ' +
    'to avoid `find`/`grep`/searching/reading, or to skip discovering files. A prior ' +
    'that suppresses exploration silently breaks later tasks on a growing codebase where ' +
    'the agent must discover accreted files. State what is true; never forbid a tool.\n' +
    '  high_stakes true if a wrong belief would break the run (test cmd, build step)\n' +
    '  detector    {scope, confirm, contradict?, fired?} where scope is a python ' +
    'regex over the command string (or one of: repro_written, importerror, badarg, ' +
    'ran_tests) selecting tasks where the fact is RELEVANT; confirm is a regex whose ' +
    'match in commands+output means the fact HELD this task; contradict (optional) a ' +
    'regex meaning the fact was FALSE this task; fired (optional) a predicate/regex ' +
    'meaning the waste the fact prevents actually occurred.\n' +
    '  cite        list of >=2 iids from the window where confirm matches (grounding)\n\n' +
    `Return ONLY a JSON list of <=${MAX_CANDS} such objects. Be conservative: a fact you cannot ` +
    'ground with a working detector + 2 citations is worse than no fact.' +
    '\n\nADDITIONALLY: if a durable repo fact would need evidence NOT present in ' +
    'the digest flags, first author an EXTRACTOR that surfaces it, then reference the ' +
    "extractor's feature name as your detector scope/fired. Extractors are cheap " +
    'host-run predicates over raw commands/outputs.\n' +
    'Return a JSON OBJECT: {"extractors": [{name, kind, pattern}], "facts": [...]}\n' +
    '  extractor.kind in {cmd_regex, out_regex, cmd_count}; pattern is a python regex.\n' +
    "  A fact's detector.scope/fired may name any extractor you define here or a " +
    'built-in (repro_written, importerror, badarg, ran_tests).' +
    '\n\nREVISION: the CONTRADICTION condition of an existing note may be corrected — ' +
    'and nothing else. Re-emit a note with the SAME id and the SAME ' +
    'claim/injection/high_stakes and the SAME detector.scope/detector.confirm/detector.fired, ' +
    'changing ONLY detector.contradict, to fix or tighten the regex that marks the fact ' +
    'FALSE this task. The note KEEPS its earned firing history and the new condition applies ' +
    'going forward. Re-emitting an id while changing any other field is rejected; extractors ' +
    'remain append-only.';
// The plugin's: any language or toolchain, with tests one topic among several.
const GENERIC_HEAD = 'You mine a DURABLE, REPO-SPECIFIC operating manual for a coding agent from a ' +
    'window of finished-session digests in ONE repository, whatever its language and ' +
    'toolchain. Each digest lists the files edited, command templates (paths relative to ' +
    'the repository), the build, test and lint commands run, the commands that failed ' +
    'with a normalized error line, and boolean flags — NOT raw logs or file contents. ' +
    '(Each session is called a task below.)\n\n' +
    'Emit facts that a FUTURE session in this repository would want stated up front to ' +
    'avoid wasted commands: how to build, run or check it here and the exact invocation ' +
    'that works; the toolchain (interpreter, package manager, compiler, version manager) ' +
    'and how it is reached; a setup, install, code-generation or rebuild step that is ' +
    'needed (or NOT needed); an environment variable, service or working directory a ' +
    'command needs; where generated, configured or vendored files live; a command that ' +
    'fails here and the variant that works; a hook or formatter that rewrites files. ' +
    'Tests are one such topic, not the focus. Do NOT emit task-specific fixes or which ' +
    'lines to change — only durable facts true across sessions.\n\n';
/** `PROPOSER_SYSTEM_GENERIC`, built the way upstream builds it. */
export const PROPOSER_SYSTEM_GENERIC = (GENERIC_HEAD + PROPOSER_SYSTEM.slice(PROPOSER_HEAD.length)).split('repro_written, importerror, badarg, ran_tests').join(GENERIC_PREDICATES.join(', '));
/**
 * `build_proposer_prompt`. `existing` maps each fact id to its claim (ids alone are accepted).
 * The generic prompt shows the claims so a held fact is not authored again under a new id.
 */
export function buildProposerPrompt(repo, window, existing, existingFeats, options = {}) {
    const view = window.map((digest) => proposerView(digest));
    const generic = options.generic ?? false;
    const existingMap = Array.isArray(existing)
        ? Object.fromEntries(existing.map((id) => [id, '']))
        : { ...existing };
    const knownIds = Object.keys(existingMap).sort();
    let known;
    if (generic) {
        known =
            '\n\nExisting facts, as `id: claim` (do NOT restate or paraphrase one under a ' +
                'NEW id; re-emit an id with ONLY detector.contradict changed to revise its ' +
                'contradiction condition, else use a NEW id for a fact not listed here):\n' +
                (knownIds.map((id) => (existingMap[id] ? `  - ${id}: ${existingMap[id]}` : `  - ${id}`)).join('\n') ||
                    '(none)');
    }
    else {
        known =
            '\n\nExisting fact ids (re-emit an id with ONLY detector.contradict changed to ' +
                'revise its contradiction condition, else use a NEW id):\n' +
                (knownIds.join(', ') || '(none)');
    }
    const feats = [...existingFeats].sort();
    let prompt = (generic ? PROPOSER_SYSTEM_GENERIC : PROPOSER_SYSTEM) +
        `\n\nRepo: ${repo}` +
        known +
        '\n\nExisting feature names:\n' +
        (feats.join(', ') || '(none)') +
        '\n\nTask digests (chronological):\n' +
        JSON.stringify(view, null, 1);
    const excerpts = options.rawExcerpts ?? [];
    if (excerpts.length > 0) {
        prompt +=
            '\n\nRAW command excerpts from recent tasks the current extractors did ' +
                'NOT cover (author extractors to reach these if they hide a durable ' +
                'fact):\n' +
                excerpts.map((command) => `  $ ${command}`).join('\n');
    }
    const external = options.external ?? [];
    if (external.length > 0) {
        prompt +=
            '\n\nFacts ALREADY injected before every task by a separate layer (do NOT ' +
                'restate or paraphrase them; author only facts beyond these):\n' +
                external.map((claim) => `  - ${claim}`).join('\n');
    }
    prompt += '\n\nReturn the JSON object {extractors, facts}:';
    return prompt;
}
/** `parse_payload`: the JSON object a proposer returned, split into extractors and facts. */
export function parsePayload(raw) {
    const text = raw ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start)
        return [[], []];
    let obj;
    try {
        obj = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return [[], []];
    }
    const asObjects = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
    // Python truthiness: an empty `detector: {}` is falsy, so such a fact is dropped upstream.
    const nonEmpty = (value) => typeof value === 'string' ? value.length > 0
        : value !== null && typeof value === 'object' ? Object.keys(value).length > 0
            : Boolean(value);
    const extractors = asObjects(obj.extractors).filter((entry) => nonEmpty(entry.name) && nonEmpty(entry.pattern));
    const facts = asObjects(obj.facts).filter((entry) => nonEmpty(entry.id) && nonEmpty(entry.detector));
    return [extractors, facts];
}
/** Stable `json.dumps(..., sort_keys=True)` equivalent, for the frozen revision surface. */
export function stableJson(value) {
    const sortValue = (item) => {
        if (Array.isArray(item))
            return item.map(sortValue);
        if (item && typeof item === 'object') {
            const out = {};
            for (const key of Object.keys(item).sort()) {
                out[key] = sortValue(item[key]);
            }
            return out;
        }
        return item;
    };
    return JSON.stringify(sortValue(value));
}
/**
 * The host-side half of the paid distiller: a rolling window of digests, the detector-checked
 * facts, and the admission/revision rules. `admit` is what a caller does with `parsePayload`'s
 * output; `proposerPrompt` builds the prompt a caller may spend on. Nothing here calls a model.
 */
export class Distiller {
    repo;
    generic;
    externalFacts;
    options;
    now = 0;
    facts = new Map();
    window = [];
    extractors = new Map();
    rawWindow = [];
    optTokens = 0;
    lastPropose = -1;
    constructor(repo, options = {}) {
        this.repo = repo;
        this.generic = Boolean(options.vocab?.generic);
        this.externalFacts = options.externalFacts ?? null;
        this.options = options.kPromote === undefined ? {} : { kPromote: options.kPromote };
    }
    featurize(digest, cmds) {
        const features = {};
        for (const [name, extractor] of this.extractors) {
            try {
                features[name] = extractor.compute(cmds);
            }
            catch {
                features[name] = false;
            }
        }
        digest.features = features;
        return digest;
    }
    sensed(command) {
        return this.generic ? CHECK_RE.test(command) : PYTEST_RE.test(command) || REPRO_RE.test(command);
    }
    /** Fraction of commands matched by some extractor or built-in test/repro sense. */
    coverage(cmds) {
        if (cmds.length === 0)
            return 1;
        let seen = 0;
        for (const [command] of cmds) {
            const hit = this.sensed(command) ||
                [...this.extractors.values()].some((extractor) => Boolean(extractor.rx && extractor.rx.test(command)));
            if (hit)
                seen += 1;
        }
        return seen / cmds.length;
    }
    /** Uncovered command templates from the raw window, for extractor authoring. */
    abstainingExcerpts() {
        const out = [];
        for (const cmds of this.rawWindow.slice(-WINDOW)) {
            for (const [command] of cmds) {
                if (this.sensed(command))
                    continue;
                if ([...this.extractors.values()].some((extractor) => Boolean(extractor.rx && extractor.rx.test(command))))
                    continue;
                const text = command.replace(/\s+/g, ' ').trim().slice(0, 100);
                if (text && !out.includes(text))
                    out.push(text);
            }
        }
        return out.slice(0, RAW_SAMPLE * 4);
    }
    /** Is the current window "abstaining" (few commands read by any sense)? */
    abstaining() {
        const cov = this.rawWindow.slice(-WINDOW).map((cmds) => this.coverage(cmds));
        return cov.length > 0 && cov.reduce((sum, value) => sum + value, 0) / cov.length < ABSTAIN_GATE;
    }
    /** The prompt the caller may spend on (upstream `_maybe_propose`'s input). */
    proposerPrompt() {
        if (this.window.length === 0)
            return null;
        const excerpts = this.abstaining() ? this.abstainingExcerpts().slice(0, RAW_SAMPLE) : [];
        const external = this.externalFacts ? this.externalFacts() : [];
        return buildProposerPrompt(this.repo, this.window, Object.fromEntries([...this.facts].map(([id, fact]) => [id, fact.claim])), [...this.extractors.keys()], { rawExcerpts: excerpts, external, generic: this.generic });
    }
    /** `_admit_extractor`: append-only, retro-featurizing the window. */
    admitExtractor(spec) {
        const name = String(spec.name ?? '');
        if (this.extractors.has(name) || this.extractors.size >= MAX_EXTRACTORS)
            return false;
        const extractor = new Extractor(spec);
        if (extractor.rx === null)
            return false;
        this.extractors.set(extractor.name, extractor);
        for (const digest of this.window) {
            const cmds = reparseCmds(digest);
            digest.features = { ...(digest.features ?? {}), [extractor.name]: extractor.compute(cmds) };
        }
        return true;
    }
    /** #window cites whose confirm fires under the current features. */
    ground(spec) {
        let hits = 0;
        for (const iid of spec.cite ?? []) {
            const digest = this.window.find((item) => item.iid === iid);
            if (!digest)
                continue;
            const detector = new DetectorV3Scope(spec.detector ?? {}, digest.features ?? {});
            const [verdict] = detector.verdict(digest);
            if (verdict === 'confirm')
                hits += 1;
        }
        return hits;
    }
    buildFact(spec) {
        const fact = new Fact(spec, this.options);
        this.window.forEach((digest, index) => {
            fact.observe(this.now - this.window.length + index, digest, new Set(digest.edited_files));
        });
        return fact;
    }
    /** Everything about a note except `detector.contradict` (the append-only surface). */
    frozenView(spec) {
        const detector = { ...(spec.detector ?? {}) };
        delete detector.contradict;
        return {
            claim: spec.claim ?? null,
            injection: spec.injection ?? null,
            high_stakes: Boolean(spec.high_stakes ?? false),
            detector: stableJson(detector),
        };
    }
    /** `_admit`: a new id is appended (if grounded), an existing id may revise only its
     * contradiction condition and keeps its earned lifecycle. */
    admit(spec) {
        const id = String(spec.id ?? '');
        if (!this.facts.has(id)) {
            const hits = this.ground(spec);
            if (hits < MIN_CITE)
                return [false, `grounding-fail(${hits}/${MIN_CITE})`];
            if (spec.rev === undefined)
                spec.rev = 1;
            this.facts.set(id, this.buildFact(spec));
            return [true, 'admitted'];
        }
        const old = this.facts.get(id);
        if (stableJson(this.frozenView(spec)) !== stableJson(this.frozenView(old.spec))) {
            return [false, 'revise-not-contradict-only'];
        }
        const detector = (spec.detector ?? {});
        const newContra = detector.contradict;
        if (newContra && compilePattern(newContra) === null)
            return [false, 'revise-bad-regex'];
        const oldDetector = (old.spec.detector ?? {});
        if (newContra === oldDetector.contradict)
            return [false, 'revise-noop'];
        // confirm/scope unchanged => still grounded; contradict only ever RETIRES => mutate in
        // place, KEEP the earned lifecycle, apply going forward.
        if (!old.spec.detector)
            old.spec.detector = {};
        old.spec.detector.contradict = newContra;
        old.spec.rev = Number(old.spec.rev ?? 1) + 1;
        return [true, 'revised-contradict'];
    }
    /** Fold one finished task, then advance the clock (upstream `Distiller.update`). */
    update(calls, options = {}) {
        const cmds = bashCmds(calls);
        const digest = buildDigest(calls, { ...options, generic: this.generic });
        this.featurize(digest, cmds);
        this.rawWindow.push(cmds);
        if (this.rawWindow.length > WINDOW)
            this.rawWindow = this.rawWindow.slice(-WINDOW);
        const files = new Set(digest.edited_files);
        for (const fact of this.facts.values())
            fact.observe(this.now, digest, files);
        this.window.push(digest);
        if (this.window.length > WINDOW)
            this.window = this.window.slice(-WINDOW);
        this.now += 1;
    }
    /** Firing-gated manual for the NEXT task; "" when nothing qualifies yet (`render`). */
    render() {
        const lines = [...this.facts.values()].filter((fact) => fact.injectable()).map((fact) => fact.injection);
        if (lines.length === 0)
            return '';
        const name = this.repo.replace(/\\/g, '/').split('/').slice(-1)[0] ?? '';
        const head = `# repo operating manual (${name}) ` +
            (this.generic ? '— learned from earlier sessions in this repository' : '— learned from prior tasks in this repo');
        return `${head}\n${lines.map((line) => `- ${line}`).join('\n')}\n`;
    }
    debugRow() {
        const row = {};
        for (const [id, fact] of this.facts) {
            row[id] = {
                state: fact.state,
                fire: `${fact.life.fireNum}/${fact.life.fireDen}`,
                rate: Math.round(fact.firingRate() * 100) / 100,
                inject: fact.injectable(),
                claim: fact.claim.slice(0, 60),
            };
        }
        row._extractors = [...this.extractors.keys()].sort();
        for (const [id, fact] of this.facts) {
            if (row[id] && typeof row[id] === 'object')
                row[id].rev = fact.spec.rev ?? 1;
        }
        return row;
    }
}
/** `_reparse_cmds`: recover `(cmd, out)` pairs from a digest's stashed blobs. */
export function reparseCmds(digest) {
    const cmds = String(digest._cmd_blob ?? '').split('\n');
    const output = String(digest._out_blob ?? '');
    return cmds.map((command, index) => [command, index === 0 ? output : '']);
}
