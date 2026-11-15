/**
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0, `tokeneconomizer/microskills/observe.py`.
 *
 * What a finished task shows about its environment: classified command segments and
 * outcomes. Each shell command is split into segments, and each segment is classified by
 * INTENT (run the interpreter, run the tests, use the package tool, fetch from a host,
 * probe the VCS) and FORM (how it was spelled). Its outcome is read off the output as an
 * environmental error class (`module_missing`, `command_missing`, ...) or a sign that tests
 * ran. Nothing here names a path, a repository or a harness: the words that name intents are
 * a `Vocabulary` the domain supplies.
 *
 * Host-specific pieces of the upstream module are deliberately left to the caller:
 *  - transcript parsing (`load_trajectory`, `call_cwds`) is replaced by the in-memory
 *    `ToolCallRecord[]` the Harness already hands us;
 *  - `repository_top()` needs the filesystem, so `classifyCommand` takes the repository
 *    root/top as explicit inputs instead of probing the disk;
 *  - `strip_rtk_prefix` is reproduced locally from `tokeneconomizer/trace/calls.py`
 *    (one regex) so this module imports no token-economizer code.
 */
import { sep as pathSep } from 'node:path';
function vocabulary(init) {
    return Object.freeze({
        name: init.name,
        interpreters: new Set(init.interpreters),
        canonicalInterpreter: init.canonicalInterpreter,
        runnerHeads: new Set(init.runnerHeads),
        runnerScripts: Object.freeze([...(init.runnerScripts ?? [])]),
        runnerModules: new Set(init.runnerModules ?? []),
        packageTools: new Set(init.packageTools),
        fetchHeads: new Set(init.fetchHeads ?? ['curl', 'wget']),
        envProbeHeads: new Set(init.envProbeHeads ?? ['which', 'command', 'type', 'whereis']),
        taskHeads: new Set(init.taskHeads ?? ['make', 'npm', 'yarn', 'pnpm', 'cargo', 'go']),
        buildHeads: new Set(init.buildHeads ?? []),
        generic: init.generic ?? false,
    });
}
/** `PYTHON_GIT`, verbatim from observe.py. */
export const PYTHON_GIT = vocabulary({
    name: 'python-git',
    interpreters: ['python', 'python2', 'python3', 'pypy', 'pypy3'],
    canonicalInterpreter: 'python',
    runnerHeads: ['pytest', 'py.test', 'tox', 'nox', 'nosetests', 'trial'],
    runnerScripts: ['runtests.py', 'bin/test', 'bin/doctest', 'manage.py'],
    runnerModules: ['pytest', 'unittest', 'nose', 'django', 'tox', 'nox'],
    packageTools: ['pip', 'pip3', 'conda', 'mamba', 'poetry', 'pipenv', 'uv', 'apt', 'apt-get'],
});
/** `NODE_WEB`, verbatim from observe.py. */
export const NODE_WEB = vocabulary({
    name: 'node-web',
    interpreters: ['node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node'],
    canonicalInterpreter: 'node',
    runnerHeads: ['jest', 'vitest', 'mocha', 'playwright', 'cypress', 'ava', 'karma'],
    runnerScripts: [],
    runnerModules: [],
    packageTools: ['npm', 'yarn', 'pnpm', 'corepack', 'apt', 'apt-get'],
});
/** `GENERIC`: every ecosystem at once, since a repository a person works in may mix them. */
export const GENERIC = vocabulary({
    name: 'generic',
    interpreters: [
        ...PYTHON_GIT.interpreters,
        ...NODE_WEB.interpreters,
        'ruby',
        'perl',
        'php',
        'Rscript',
        'julia',
        'lua',
        'elixir',
    ],
    canonicalInterpreter: 'python',
    runnerHeads: [
        ...PYTHON_GIT.runnerHeads,
        ...NODE_WEB.runnerHeads,
        'rspec',
        'phpunit',
        'ctest',
        'bats',
    ],
    runnerScripts: PYTHON_GIT.runnerScripts,
    runnerModules: PYTHON_GIT.runnerModules,
    packageTools: [
        ...PYTHON_GIT.packageTools,
        ...NODE_WEB.packageTools,
        'gem',
        'bundle',
        'composer',
        'cargo',
        'go',
        'mvn',
        'gradle',
        'dotnet',
        'brew',
        'rustup',
        'pyenv',
        'nvm',
        'asdf',
    ],
    taskHeads: ['make', 'npm', 'yarn', 'pnpm', 'cargo', 'go', 'mvn', 'gradle', 'gradlew', 'dotnet', 'mix', 'swift', 'rake'],
    buildHeads: [
        'make',
        'cmake',
        'ninja',
        'bazel',
        'tsc',
        'eslint',
        'prettier',
        'ruff',
        'flake8',
        'pylint',
        'mypy',
        'pyright',
        'black',
        'isort',
        'golangci-lint',
        'gcc',
        'g++',
        'clang',
        'javac',
        'webpack',
        'vite',
        'pre-commit',
        'shellcheck',
    ],
    generic: true,
});
/** Upstream `DEFAULT_VOCAB = PYTHON_GIT`. */
export const DEFAULT_VOCAB = PYTHON_GIT;
/** `<tool> build`, `npm run lint`, ...: what a generic reading counts as building or checking. */
export const BUILD_SUBS = new Set([
    'build',
    'check',
    'compile',
    'lint',
    'vet',
    'typecheck',
    'type-check',
    'clippy',
    'package',
    'verify',
    'fmt',
    'format',
]);
const RUN_SCRIPT_HEADS = new Set(['npm', 'yarn', 'pnpm', 'bun']);
export const GIT_FETCH_SUBS = new Set(['fetch', 'clone', 'pull', 'ls-remote']);
export const GIT_PROBE_SUBS = new Set([
    'remote',
    'branch',
    'tag',
    'fsck',
    'stash',
    'show-ref',
    'for-each-ref',
]);
const PREFIX_HEADS = new Set(['sudo', 'env', 'time', 'exec', 'nice', 'nohup', 'timeout']);
export const PASSTHROUGH_HEADS = new Set([
    'cd',
    'echo',
    'head',
    'tail',
    'cat',
    'sort',
    'uniq',
    'tee',
    'true',
    'printf',
    'less',
    'more',
]);
// --------------------------------------------------------------------------------------
// regexes (kept verbatim from observe.py; Python inline flags become JS flags)
// --------------------------------------------------------------------------------------
const ACTIVATE_RE = /^(?:source|\.)\s+\S*activate\s+([\w.-]+)\s*$/;
const CD_RE = /^cd\s+(['"]?)([^\s;&|'"]+)\1\s*$/;
const CD_FAILED_RE = /\bcd: [^\n]*: (?:No such file or directory|Not a directory)/;
const CONDA_ACTIVATE_RE = /^(?:conda|mamba)\s+activate\s+([\w.-]+)\s*$/;
const CONDA_RUN_RE = /^(?:conda|mamba)\s+run\s+(?:--no-capture-output\s+|--live-stream\s+)*(?:-n|--name)\s+([\w.-]+)\s+/;
const TOOL_RUN_RE = /^(poetry|pipenv|uv|npx|bundle|yarn|pnpm)\s+(?:run|exec)\s+/;
const NPX_RE = /^npx\s+(?:(?:--yes|-y|--no-install|--no)\s+)*/;
const TOOL_LAUNCH_RE = /^(uvx|uv\s+tool\s+run|pipx\s+run)\s+/;
const INTERP_VERSIONED_RE = /^(?:python|node)\d(?:\.\d+)?$/;
const ENV_ASSIGN_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/;
const ASSIGN_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAP_RE = /^\/bin\/(?:ba)?sh\s+-l?c\s+(.*)$/s;
const HEREDOC_RE = /(?<!<)<<(?!<)-?\s*['"]?(\w+)['"]?[^\n]*\n.*?\n\s*\1\b/s;
const URL_HOST_RE = /https?:\/\/([^/\s'"`]+)/g;
// Error classes an ENVIRONMENT produces (as opposed to the code under test). Order matters:
// the first match names the class.
export const ERROR_CLASSES = [
    ['module_missing', /ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND/i],
    ['command_missing', /command not found|: not found\b|is not recognized/i],
    // The interpreter started, but the script it was told to run is not where it looked:
    // `python runtests.py` outside the directory that has it.
    ['script_missing', /can't open file .*No such file or directory/i],
    ['permission_denied', /Permission denied|EACCES/i],
    ['usage_error', /^usage:|unrecognized arguments|no such option|error: argument|unknown option/im],
    [
        'connection_refused',
        /Connection refused|Failed to connect to|couldn't connect to|Could not connect|ECONNREFUSED/i,
    ],
    [
        'name_resolution',
        /Could not resolve host|Temporary failure in name resolution|Name or service not known|getaddrinfo|nodename nor servname|ENOTFOUND/i,
    ],
    [
        'unreachable',
        /Network is unreachable|No route to host|Connection timed out|Operation timed out|timed out after|ETIMEDOUT/i,
    ],
];
/** `NETWORK_ERRORS`, verbatim from observe.py. */
export const NETWORK_ERRORS = new Set([
    'connection_refused',
    'name_resolution',
    'unreachable',
]);
// The command a "not found" line names: `bash: ruff: command not found`, `/bin/sh: 1: ruff:
// not found`, `zsh: command not found: ruff`, `'ruff' is not recognized ...`.
const NOT_FOUND_NAME_RE = /([^\s:'"]+):\s+(?:command\s+)?not found\b(?!:)|command not found:\s+(\S+)|'([^']+)' is not recognized/i;
/** `FORM_ERRORS`, verbatim from observe.py. */
export const FORM_ERRORS = new Set([
    'module_missing',
    'command_missing',
    'script_missing',
    'usage_error',
    'permission_denied',
]);
// What "the probe returned something" looks like, per VCS probe kind. Deliberately narrow
// patterns so the output of an unrelated segment in a compound command cannot masquerade as
// a hit.
const PROBE_HIT = {
    remote: /^\S+\s+\S+\s+\((?:fetch|push)\)\s*$/m,
    branch: /^\s*remotes\/\S+/m,
    tag: /^v?\d+(?:\.\d+)+(?:[a-z]+\d*|\.post\d+|-\S+)?\s*$/m,
    fsck: /^(?:unreachable|dangling)\s+(?:commit|tree|blob|tag)\s+[0-9a-f]{7,}/m,
    stash: /^stash@\{\d+\}/m,
    refs: /^[0-9a-f]{7,}\s+refs\//m,
};
// --------------------------------------------------------------------------------------
// observations
// --------------------------------------------------------------------------------------
/** Strip an agent's `/bin/bash -lc "<cmd>"` wrapper, if present. */
export function unwrap(command) {
    const cmd = command ?? '';
    const m = WRAP_RE.exec(cmd.trim());
    if (!m)
        return cmd;
    let inner = (m[1] ?? '').trim();
    if (inner.length >= 2 && inner[0] === inner[inner.length - 1] && (inner[0] === '"' || inner[0] === "'")) {
        const quote = inner[0];
        inner = inner.slice(1, -1);
        if (quote === '"') {
            inner = inner.replaceAll('\\"', '"').replaceAll('\\$', '$').replaceAll('\\\\', '\\');
        }
    }
    return inner;
}
/**
 * Split a shell command into simple segments on && || ; | and newlines, outside quotes.
 * Heredoc bodies are elided first so their contents are never mistaken for commands.
 */
export function segments(command) {
    const cmd = HEREDOC_RE.test(command ?? '')
        ? (command ?? '').replace(HEREDOC_RE, (whole) => `${whole.split('\n', 1)[0] ?? ''} <heredoc>`)
        : (command ?? '');
    const out = [];
    let buf = [];
    let quote = null;
    let i = 0;
    while (i < cmd.length) {
        const c = cmd[i];
        if (quote) {
            buf.push(c);
            if (c === quote) {
                quote = null;
            }
            else if (c === '\\' && i + 1 < cmd.length) {
                buf.push(cmd[i + 1]);
                i += 1;
            }
        }
        else if (c === '"' || c === "'") {
            quote = c;
            buf.push(c);
        }
        else if (c === '\n' || c === ';' || c === '|' || (c === '&' && cmd.slice(i, i + 2) === '&&')) {
            out.push(buf.join(''));
            buf = [];
            if (cmd.slice(i, i + 2) === '&&' || cmd.slice(i, i + 2) === '||')
                i += 1;
        }
        else {
            buf.push(c);
        }
        i += 1;
    }
    out.push(buf.join(''));
    const cleaned = [];
    for (const raw of out) {
        if (!raw.trim())
            continue;
        const stripped = raw.trim().replace(/^[()]+/, '').replace(/[()]+$/, '').trim();
        if (stripped)
            cleaned.push(stripped);
    }
    return cleaned;
}
function tokens(segment) {
    return segment.split(/\s+/).filter(Boolean);
}
/** `rtk pytest -q` -> `pytest -q`; anything else unchanged (`trace/calls.py:strip_rtk_prefix`). */
const RTK_PREFIX_RE = /^rtk\s+(?:proxy\s+)?(?=\S)/;
export function stripRtkPrefix(command) {
    return (command ?? '').replace(/^\s+/, '').replace(RTK_PREFIX_RE, '');
}
/** Remove leading `VAR=value` assignments from one command segment. */
export function stripEnvAssignments(segment) {
    return (segment ?? '').replace(ENV_ASSIGN_RE, '').trim();
}
/**
 * Normalization shared by every classifier: unwrap the shell wrapper, remove leading
 * `VAR=value` assignments, strip an `rtk` prefix, and remove assignments that sat in front
 * of `rtk`. This is the per-segment normalization `classify_command` applies, lifted to a
 * whole command string; it is exported because callers and the parity harness need one
 * canonical spelling.
 */
export function normalizeCommand(command) {
    const typed = unwrap(command ?? '').trim();
    const assigned = stripEnvAssignments(typed);
    const unwrapped = stripRtkPrefix(assigned).trim();
    return stripEnvAssignments(unwrapped);
}
/** True when the (already unwrapped) command carried a leading `VAR=value`. */
export function hasEnvAssignment(command) {
    const typed = (command ?? '').trim();
    return stripEnvAssignments(typed) !== typed;
}
const DRIVE_RE = /^\/([A-Za-z])(?=\/|$)|^([A-Za-z]):(?=\/|$)/;
const WINDOWS = pathSep === '\\';
/** `p` with forward slashes and a Windows drive spelled `c:` (only meaningful on Windows). */
function shellPath(p) {
    let out = WINDOWS ? p.replace(/\\/g, '/') : p;
    if (WINDOWS) {
        const m = DRIVE_RE.exec(out);
        if (m)
            out = `${(m[1] ?? m[2] ?? '').toLowerCase()}:${out.slice(m[0].length)}`;
    }
    return out;
}
function shellIsAbsolute(p) {
    return p.startsWith('/') || (WINDOWS && /^[a-z]:(\/|$)/.test(p));
}
/** A faithful `posixpath.normpath` for the subset `_cd_target` needs. */
function posixNorm(p) {
    if (p === '')
        return '.';
    const absolute = p.startsWith('/');
    const out = [];
    for (const part of p.split('/')) {
        if (part === '' || part === '.')
            continue;
        if (part === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..')
                out.pop();
            else if (!absolute)
                out.push('..');
        }
        else {
            out.push(part);
        }
    }
    const joined = out.join('/');
    if (absolute)
        return joined ? `/${joined}` : '/';
    return joined || '.';
}
function posixJoin(a, b) {
    if (b.startsWith('/'))
        return posixNorm(b);
    if (!a)
        return posixNorm(b);
    return posixNorm(`${a.replace(/\/+$/, '')}/${b}`);
}
/** A faithful `posixpath.relpath`; returns null where Python raises ValueError. */
function posixRelpath(path, start) {
    const normalizedPath = posixNorm(path);
    const normalizedStart = posixNorm(start);
    const pathAbsolute = normalizedPath.startsWith('/');
    const startAbsolute = normalizedStart.startsWith('/');
    if (pathAbsolute !== startAbsolute)
        return null;
    const pathParts = normalizedPath.split('/').filter((part, index) => !(index === 0 && pathAbsolute) && part !== '');
    const startParts = normalizedStart.split('/').filter((part, index) => !(index === 0 && startAbsolute) && part !== '');
    let common = 0;
    while (common < pathParts.length && common < startParts.length && pathParts[common] === startParts[common]) {
        common += 1;
    }
    const rel = [];
    for (let j = common; j < startParts.length; j += 1)
        rel.push('..');
    rel.push(...pathParts.slice(common));
    return rel.length === 0 ? '.' : rel.join('/');
}
/**
 * Where `cd target` from `cur` lands, relative to the directory the session started in
 * ("" for that directory itself); null when it leaves it or cannot be told (`~`, `$VAR`,
 * `-`, an absolute path with no known start). Port of observe.py `_cd_target`.
 */
export function cdTarget(cur, target, root = null, top = null) {
    if (!target || '~$-'.includes(target[0]))
        return null;
    const targetPath = shellPath(target);
    const curPath = shellPath(cur ?? '.');
    let rel;
    if (shellIsAbsolute(targetPath)) {
        if (!root)
            return null;
        rel = posixRelpath(posixNorm(targetPath), posixNorm(shellPath(root)));
        if (rel === null)
            return null;
    }
    else {
        rel = posixNorm(posixJoin(curPath, targetPath));
    }
    if (rel === '.')
        return '';
    if (rel === '..' || rel.startsWith('../')) {
        if (!(top && root))
            return null;
        const at = posixNorm(posixJoin(shellPath(root), rel));
        return at === posixNorm(shellPath(top)) ? '' : null;
    }
    return rel;
}
export class Observation {
    call;
    intent;
    form;
    head;
    prefix;
    segment;
    hosts;
    probe;
    outcome = null;
    labels = [];
    labelErr = false;
    loaded = false;
    testsRan = false;
    /** Typed with `VAR=value` before it, which its form leaves out. */
    env = false;
    /**
     * The "command not found" line names this command, not one it started (`make` running a
     * recipe whose `cc` is missing prints `/bin/sh: 1: cc: not found`).
     */
    notFound = false;
    constructor(call, intent, form, head, prefix, segment, hosts = [], probe = null) {
        this.call = call;
        this.intent = intent;
        this.form = form;
        this.head = head;
        this.prefix = prefix;
        this.segment = segment;
        this.hosts = hosts;
        this.probe = probe;
    }
    toString() {
        return `Obs(${this.intent},${JSON.stringify(this.form)},${this.outcome})`;
    }
}
function baseName(path) {
    const normalized = (path ?? '').replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(index + 1) : normalized;
}
function baseOfHead(head) {
    return head.includes('/') ? head.slice(head.lastIndexOf('/') + 1) : head;
}
function lstripDots(path) {
    return path.replace(/^[./]+/, '');
}
function runnerScript(rest, vocab) {
    for (const token of rest) {
        if (token.startsWith('-'))
            continue;
        for (const script of vocab.runnerScripts) {
            if (token === script || token.endsWith(`/${script}`) || token.endsWith(script)) {
                return token.startsWith('./') ? lstripDots(token) : token;
            }
        }
        return null;
    }
    return null;
}
function probeKind(sub, args) {
    const seen = new Set(args);
    if (sub === 'remote')
        return 'remote';
    if (sub === 'branch' && ['-a', '-r', '--all', '--remotes', '-ar', '-ra'].some((flag) => seen.has(flag))) {
        return 'branch';
    }
    if (sub === 'tag' && seen.has('--contains'))
        return 'tag';
    if (sub === 'fsck')
        return 'fsck';
    if (sub === 'stash' && args.length === 1 && args[0] === 'list')
        return 'stash';
    if (sub === 'show-ref' || sub === 'for-each-ref')
        return 'refs';
    return null;
}
function hostNames(body) {
    return [...body.matchAll(URL_HOST_RE)].map((match) => match[1] ?? '');
}
function classifyOne(head, base, rest, body, prefix, segment, call, vocab) {
    const form = (expr) => (prefix ? `${prefix} ${expr}`.trim() : expr);
    if (vocab.interpreters.has(base) || INTERP_VERSIONED_RE.test(base)) {
        if (rest.length > 0 && rest.every((token) => ['--version', '-V', '-VV', '-v'].includes(token))) {
            return new Observation(call, 'probe_env', form(head), head, prefix, segment);
        }
        if (rest.includes('-m')) {
            const moduleIndex = rest.indexOf('-m') + 1;
            const module = moduleIndex < rest.length ? rest[moduleIndex] : '';
            if (vocab.runnerModules.has(module)) {
                return new Observation(call, 'run_tests', form(`${head} -m ${module}`), head, prefix, segment);
            }
            // `python -m mypy` runs the checker itself, not the interpreter.
            if (vocab.generic && vocab.buildHeads.has(module)) {
                return new Observation(call, 'run_build', form(`${head} -m ${module}`), head, prefix, segment);
            }
        }
        const script = runnerScript(rest, vocab);
        if (script && (script !== 'manage.py' || rest.includes('test'))) {
            return new Observation(call, 'run_tests', form(`${head} ${script}`), head, prefix, segment);
        }
        return new Observation(call, 'run_interpreter', form(head), head, prefix, segment);
    }
    if (vocab.runnerHeads.has(base)) {
        return new Observation(call, 'run_tests', form(head), head, prefix, segment);
    }
    for (const script of vocab.runnerScripts) {
        if (head === script || head.endsWith(`/${script}`) || head === `./${script}`) {
            if (script === 'manage.py' && !rest.includes('test'))
                break;
            // A script run through its shebang is the interpreter running it; spell the form that
            // way so `./tests/runtests.py` and `python tests/runtests.py` pool.
            return new Observation(call, 'run_tests', form(`${vocab.canonicalInterpreter} ${lstripDots(head)}`), head, prefix, segment);
        }
    }
    if (vocab.taskHeads.has(base) && rest.length > 0 && rest[0] === 'test') {
        return new Observation(call, 'run_tests', form(`${base} test`), head, prefix, segment);
    }
    if (vocab.generic) {
        if (RUN_SCRIPT_HEADS.has(base) && rest.length > 1 && rest[0] === 'run') {
            const script = rest[1];
            const kind = script.split(':')[0] ?? '';
            if (kind === 'test') {
                return new Observation(call, 'run_tests', form(`${base} run ${script}`), head, prefix, segment);
            }
            if (BUILD_SUBS.has(kind)) {
                return new Observation(call, 'run_build', form(`${base} run ${script}`), head, prefix, segment);
            }
        }
        if (vocab.taskHeads.has(base) && rest.length > 0 && BUILD_SUBS.has(rest[0])) {
            return new Observation(call, 'run_build', form(`${base} ${rest[0]}`), head, prefix, segment);
        }
        if (vocab.buildHeads.has(base)) {
            return new Observation(call, 'run_build', form(base), head, prefix, segment);
        }
    }
    if (vocab.envProbeHeads.has(base)) {
        return new Observation(call, 'probe_env', form(base), head, prefix, segment);
    }
    if (vocab.fetchHeads.has(base)) {
        return new Observation(call, 'fetch_remote', form(base), head, prefix, segment, hostNames(body));
    }
    if (base === 'git' && rest.length > 0) {
        const sub = rest[0];
        if (GIT_FETCH_SUBS.has(sub)) {
            return new Observation(call, 'fetch_remote', form(`git ${sub}`), head, prefix, segment, hostNames(body));
        }
        if (GIT_PROBE_SUBS.has(sub)) {
            const kind = probeKind(sub, rest.slice(1));
            if (kind) {
                return new Observation(call, 'probe_vcs_refs', form(`git ${sub}`), head, prefix, segment, [], kind);
            }
        }
        return null;
    }
    if (vocab.packageTools.has(base)) {
        if (base.startsWith('pip') || base.startsWith('npm') || base.startsWith('yarn') || base.startsWith('pnpm')) {
            if (rest.length > 0 && ['install', 'download', 'add', 'ci'].includes(rest[0])) {
                const hosts = hostNames(body);
                return new Observation(call, 'fetch_remote', form(`${base} ${rest[0]}`), head, prefix, segment, hosts);
            }
        }
        return new Observation(call, 'package_tool', form(base), head, prefix, segment);
    }
    return null;
}
/** Observations for one shell command (possibly compound), as `classify_command` returns them. */
export function classifyCommand(command, options = {}) {
    const vocab = options.vocab ?? DEFAULT_VOCAB;
    const callIndex = options.callIndex ?? 0;
    const root = options.root ?? null;
    const top = options.top ?? null;
    const observations = [];
    let carried = '';
    let here = options.cwd ?? '';
    let cd = here ? `cd ${here} &&` : '';
    for (const segment of segments(unwrap(command ?? ''))) {
        // Transparent wrappers first: `K=V rtk pytest`, `rtk K=V pytest` and `rtk proxy pytest`
        // are all a pytest run.
        const typed = segment.trim();
        let seg = stripEnvAssignments(typed);
        let assigned = seg !== typed;
        const unwrapped = stripRtkPrefix(seg).trim();
        seg = stripEnvAssignments(unwrapped);
        assigned = assigned || seg !== unwrapped;
        if (!seg)
            continue;
        // A directory change is part of how the rest of the command runs: `cd tests && python
        // runtests.py` works where a bare `python runtests.py` does not, so it is carried into
        // the forms that follow, as an activation is.
        const cdMatch = CD_RE.exec(seg);
        if (cdMatch) {
            const there = here !== null ? cdTarget(here, cdMatch[2] ?? '', root, top) : null;
            if (there === null) {
                here = null;
                cd = `cd ${cdMatch[2] ?? ''} &&`;
            }
            else {
                here = there;
                cd = there ? `cd ${there} &&` : '';
            }
            continue;
        }
        const activation = ACTIVATE_RE.exec(seg) ?? CONDA_ACTIVATE_RE.exec(seg);
        if (activation) {
            // `conda activate X`, `mamba activate X` and `source .../activate X` all become one
            // activation form; a mamba activation is spelled `conda activate X` as upstream does.
            const head = seg.startsWith('conda') || seg.startsWith('mamba') ? 'conda' : 'source';
            carried = `${head} activate ${activation[1] ?? ''} &&`;
            continue;
        }
        let prefix = [cd, carried].filter(Boolean).join(' ');
        let body = seg;
        const condaRun = CONDA_RUN_RE.exec(body);
        if (condaRun) {
            prefix = `${prefix ? `${prefix} ` : ''}conda run -n ${condaRun[1] ?? ''}`;
            body = body.slice(condaRun[0].length);
        }
        const toolRun = TOOL_RUN_RE.exec(body);
        if (toolRun) {
            prefix = `${prefix ? `${prefix} ` : ''}${toolRun[1] ?? ''} run`;
            body = body.slice(toolRun[0].length);
        }
        else {
            const npx = NPX_RE.exec(body);
            if (npx && npx[0].length > 0) {
                prefix = `${prefix ? `${prefix} ` : ''}npx`;
                body = body.slice(npx[0].length);
            }
            else if (vocab.generic) {
                const launch = TOOL_LAUNCH_RE.exec(body);
                if (launch) {
                    const launcher = (launch[1] ?? '').startsWith('pipx') ? 'pipx run' : 'uvx';
                    prefix = `${prefix ? `${prefix} ` : ''}${launcher}`;
                    body = body.slice(launch[0].length);
                }
            }
        }
        let toks = tokens(body);
        while (toks.length > 0 && (PREFIX_HEADS.has(toks[0]) || ASSIGN_TOKEN_RE.test(toks[0]))) {
            if (ASSIGN_TOKEN_RE.test(toks[0])) {
                // `env VAR=value cmd`
                assigned = true;
                toks = toks.slice(1);
            }
            else {
                toks = toks[0] === 'timeout' ? toks.slice(2) : toks.slice(1);
            }
        }
        if (toks.length === 0)
            continue;
        const head = toks[0];
        const observation = classifyOne(head, baseOfHead(head), toks.slice(1), body, prefix, seg, callIndex, vocab);
        if (observation) {
            observation.env = assigned;
            observations.push(observation);
        }
    }
    return observations;
}
/** First environmental error class in `output`, or null (`observe.py:error_class`). */
export function errorClass(output) {
    const text = output ?? '';
    for (const [name, pattern] of ERROR_CLASSES) {
        if (pattern.test(text))
            return name;
    }
    return null;
}
/** First `exit code[:= ]N` hint in `output`, or null (`observe.py:_exit_code_hint`). */
export function exitCodeHint(output) {
    const m = /\bexit\s+code[:=\s]+(\d+)/i.exec(output ?? '');
    return m ? Number(m[1]) : null;
}
// The runner could not load a test label: the module, file or name it names does not resolve.
// Read off the output rather than the exit code -- agents pipe test runs through `| tail`.
const LABEL_ERR_RE = /Failed to import test module|unittest\.loader\._FailedTest|ERROR: (?:file or directory )?not found|no tests ran|module '[\w.]+' has no attribute/i;
const NO_MODULE_RE = /No module named ['"]?([\w.]+)/;
/** Did the runner fail to load one of these labels? (`observe.py:_label_failed`). */
export function labelFailed(labels, output) {
    const out = output ?? '';
    if (LABEL_ERR_RE.test(out))
        return true;
    const heads = new Set(labels.map((label) => label.split(/[./:]/)[0] ?? ''));
    for (const match of out.matchAll(new RegExp(NO_MODULE_RE.source, 'g'))) {
        const root = (match[1] ?? '').split('.')[0] ?? '';
        if (heads.has(root))
            return true;
    }
    return false;
}
// ... and positive evidence that it loaded: tests actually ran. Output an agent filtered
// away (`| grep FAILED`, a silent run) proves nothing either way.
const LOADED_RE = /\bRan [1-9]\d* tests?\b|\b[1-9]\d* (?:passed|failed|passing|failing)\b|\bcollected [1-9]\d* items?\b/;
// Other runners' summaries, for the generic reading: Go's `ok  pkg 0.01s` and `--- PASS`,
// Rust's `test result:`, RSpec's `3 examples, 0 failures`, .NET's `Passed!`, Maven's `Tests run: 3`.
const LOADED_GENERIC_RE = /^ok\s+\S+\s+[\d.]+s\b|^--- (?:PASS|FAIL)\b|\btest result: (?:ok|FAILED)\b|\b[1-9]\d* examples?, \d+ failures?\b|\b(?:Passed|Failed)!\s+-|\bTests run: [1-9]\d*/m;
// Code asking for an environment variable by name, and the ways a command sets one.
const ENV_NEED_RE = /environment variable\s+['"`]?([A-Z][A-Z0-9_]{2,})/;
const ENV_PREFIX_RE = /(?:^|[\s;&(])(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(['"]?)([\w.\-/:]+)\2/;
const ENV_INCODE_RE = /os\.environ(?:\.setdefault\(\s*|\[\s*)['"]([A-Z][A-Z0-9_]{2,})['"]\s*(?:,|\]\s*=)\s*['"]([\w.\-/:]+)['"]/;
const FAILED_RE = /Traceback \(most recent call last\)|^\w*Error\b|\b[Ee]xit [Cc]ode[:=\s]+[1-9]/m;
const LABEL_TOKEN_RE = /^[A-Za-z_][\w.\-/]*(?:::[\w.\-[\]]+)*$/;
/**
 * The test labels a runner observation was given: positional arguments after the runner's own
 * token that look like a module, a path or a test id (`observe.py:_test_labels`).
 */
export function testLabels(observation) {
    const toks = tokens(observation.segment);
    const formTokens = observation.form.split(/\s+/).filter(Boolean);
    const last = formTokens.length > 0 ? formTokens[formTokens.length - 1] : '';
    let start = toks.length;
    for (let i = 0; i < toks.length; i += 1) {
        const token = toks[i];
        if (token === last || lstripDots(token) === last || token.endsWith(`/${last}`)) {
            start = i + 1;
            break;
        }
    }
    const out = [];
    let skip = false;
    let prev = '';
    for (const token of toks.slice(start)) {
        if (skip) {
            skip = false;
            prev = token;
            continue;
        }
        if (['>', '>>', '2>', '<', '|'].includes(token) ||
            token.startsWith('2>') ||
            token.startsWith('>') ||
            token.startsWith('<') ||
            token.startsWith('|')) {
            skip = ['>', '>>', '2>', '<'].includes(token);
            prev = token;
            continue;
        }
        const structured = ['.', '::', '/'].some((c) => token.includes(c));
        const afterOption = prev.startsWith('-') && !prev.includes('=');
        if (!token.startsWith('-') && LABEL_TOKEN_RE.test(token) && (structured || !afterOption)) {
            out.push(token);
        }
        prev = token;
    }
    return out;
}
/**
 * ("sep", "::") or ("strip", prefix) when label `b` is label `a` rewritten into the shape the
 * runner loads, else null (`observe.py:label_rule`).
 */
export function labelRule(a, b) {
    if (a.includes('::') && !b.includes('::')) {
        const dotted = a.replaceAll('::', '.');
        if (b === dotted || dotted.startsWith(`${b}.`) || b.startsWith(`${dotted}.`)) {
            return ['sep', '::'];
        }
    }
    for (const sep of ['.', '/']) {
        if (!a.includes(sep))
            continue;
        const prefix = `${a.split(sep)[0] ?? ''}${sep}`;
        const rest = a.slice(prefix.length);
        if (rest && !b.startsWith(prefix) && (b === rest || rest.startsWith(`${b}${sep}`) || b.startsWith(`${rest}${sep}`))) {
            return ['strip', prefix];
        }
    }
    return null;
}
/**
 * What one call says about environment variables: those its output asks for, and those its
 * command sets (inline, exported or in the code it runs). `observe.py:_env_calls`.
 */
export function envCalls(command, output, success, call = 0) {
    const sets = {};
    for (const match of (command ?? '').matchAll(new RegExp(ENV_PREFIX_RE.source, 'g'))) {
        sets[match[1]] = match[3];
    }
    for (const match of (command ?? '').matchAll(new RegExp(ENV_INCODE_RE.source, 'g'))) {
        sets[match[1]] = match[2];
    }
    const need = [...new Set([...(output ?? '').matchAll(new RegExp(ENV_NEED_RE.source, 'g'))].map((m) => m[1]))].sort();
    return { need, sets, ok: Boolean(success) && !FAILED_RE.test(output ?? ''), call };
}
/**
 * Did this run show that the way the command was CALLED fails here? Not when the runner
 * started and rejected what it was given (`observe.py:form_failed`).
 */
export function formFailed(observation) {
    if (observation.outcome === null || !FORM_ERRORS.has(observation.outcome) || observation.labelErr) {
        return false;
    }
    return !(observation.intent === 'run_tests' && observation.outcome === 'usage_error');
}
/**
 * Did this run show the form works? A test run must show tests running (`observe.py:form_worked`).
 */
export function formWorked(observation) {
    return observation.outcome === 'ran' && (observation.intent !== 'run_tests' || observation.testsRan);
}
/** A form with no activation prefix and no explicit path is 'bare' (`observe.py:is_bare`). */
export function isBare(form) {
    const head = form ? (form.split(/\s+/)[0] ?? '') : '';
    return (!head.includes('/') &&
        !form.includes(' activate ') &&
        !form.includes(' run ') &&
        !form.startsWith('conda run') &&
        !form.startsWith('poetry run') &&
        !form.startsWith('pipenv run') &&
        !form.startsWith('uv run') &&
        !form.startsWith('npx ') &&
        !form.startsWith('uvx '));
}
/** Port of distiller.py `_command_failed`, used by the digests and the engine's signals. */
const EXIT_CODE_RE = /\bexit(?:ed with)?(?: code| status)?[:=\s]+(\d+)/i;
const MISSING_CMD_RE = /command not found|: not found\b|is not recognized as/i;
const MISSING_DEP_RE = /ModuleNotFoundError|No module named|ImportError|Cannot find module|ERR_MODULE_NOT_FOUND|cannot find package|could not find (?:package|crate|module|gem)|unresolved import|cannot load such file|undefined reference to|fatal error: [^\n]*: No such file/i;
const FAILED_OUT_RE = /Traceback \(most recent call last\)|^\w*Error\b/m;
/** True when the output shows the command failed (`distiller.py:_command_failed`). */
export function commandFailed(output) {
    const out = output ?? '';
    const m = EXIT_CODE_RE.exec(out);
    if (m)
        return Number(m[1]) !== 0;
    return MISSING_CMD_RE.test(out) || MISSING_DEP_RE.test(out) || FAILED_OUT_RE.test(out);
}
function errorLine(output, error) {
    const out = output ?? '';
    const entry = ERROR_CLASSES.find(([name]) => name === error);
    if (!entry)
        return '';
    const m = entry[1].exec(out);
    if (!m)
        return '';
    const start = out.lastIndexOf('\n', m.index) + 1;
    const end = out.indexOf('\n', m.index + m[0].length);
    return out.slice(start, end >= 0 ? end : undefined);
}
function notFoundName(line) {
    const m = NOT_FOUND_NAME_RE.exec(line ?? '');
    if (!m)
        return '';
    const group = m.slice(1).find((value) => Boolean(value));
    return baseName(group ?? '');
}
/** True when the output of a probe shows the probe returned something (`observe.py:_PROBE_HIT`). */
export function probeHit(kind, output) {
    return (PROBE_HIT[kind] ?? PROBE_HIT.remote).test(output ?? '');
}
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'create', 'str_replace_editor']);
function callToolName(call) {
    return (call.name ?? '').toLowerCase();
}
function callPath(args) {
    const value = args.file_path ?? args.path;
    return typeof value === 'string' ? value : '';
}
/** Every file an edit tool wrote, by basename, whatever its language (`lifecycle.py:edited_files`). */
export function editedFiles(calls) {
    const files = new Set();
    for (const call of calls) {
        const tool = callToolName(call);
        if (EDIT_TOOLS.has(tool)) {
            const path = callPath(call.args);
            if (path)
                files.add(baseName(path));
        }
        else if (tool === 'apply_patch') {
            const paths = call.args.paths;
            if (Array.isArray(paths)) {
                for (const path of paths) {
                    if (typeof path === 'string')
                        files.add(baseName(path));
                }
            }
        }
    }
    return files;
}
/** Python files only (`lifecycle.py:edited_pyfiles`, the experiments' narrower reading). */
export function editedPyFiles(calls) {
    const files = new Set();
    for (const call of calls) {
        const tool = callToolName(call);
        if (EDIT_TOOLS.has(tool)) {
            const path = callPath(call.args);
            if (path.endsWith('.py'))
                files.add(baseName(path));
        }
        else if (tool === 'apply_patch') {
            const paths = call.args.paths;
            if (Array.isArray(paths)) {
                for (const path of paths) {
                    if (typeof path === 'string' && path.endsWith('.py'))
                        files.add(baseName(path));
                }
            }
        }
    }
    return files;
}
/** Sorted edited basenames, the shape a `FactCandidate.files` list uses. */
export function editedPaths(calls) {
    return [...editedFiles(calls)].sort();
}
/** `[(cmd, out)]` for shell calls (`distiller.py:bash_cmds`). */
export function bashCommands(calls) {
    const out = [];
    for (const call of calls) {
        const tool = callToolName(call);
        if (tool === 'bash' || tool === 'shell' || tool === 'stop_bash') {
            const command = (call.args.command ?? call.args.cmd ?? '');
            out.push({ command: typeof command === 'string' ? command : '', output: call.output ?? '' });
        }
    }
    return out;
}
const TARGET_INTENTS = new Set([
    'run_interpreter',
    'run_tests',
    'run_build',
    'package_tool',
    'fetch_remote',
]);
/**
 * Per-task digest: observations with outcomes, the edited files, the call count
 * (`observe.py:observe_task`).
 *
 * Outcome attribution inside a compound command is heuristic and conservative, exactly as
 * upstream: an infrastructure error is attributed to the segment whose executable the error
 * names, else to the last relevant segment; a call that succeeded marks every relevant
 * segment as having run; a failed call with no infrastructure error marks only the first
 * relevant segment as having run and leaves the others unknown (an `&&` chain may not have
 * reached them).
 *
 * The transcript path of the upstream signature is replaced by the calls themselves; the
 * caller passes `cwds` when its agent's shell keeps its directory between calls.
 */
export function observeTask(calls, options = {}) {
    const vocab = options.vocab ?? DEFAULT_VOCAB;
    const cwds = options.cwds;
    const root = options.root ?? (cwds ? (cwds.find((value) => Boolean(value)) ?? null) : null);
    const top = options.top ?? null;
    const observations = [];
    const envCallsOut = [];
    let nCalls = 0;
    calls.forEach((call, index) => {
        nCalls += 1;
        const tool = callToolName(call);
        if (tool !== 'shell' && tool !== 'bash' && tool !== 'stop_bash')
            return;
        const rawCommand = (call.args.command ?? call.args.cmd ?? '');
        const command = typeof rawCommand === 'string' ? rawCommand : '';
        const output = call.output ?? '';
        if (CD_FAILED_RE.test(output))
            return; // stopped at its `cd`: nothing after it ran
        let here = '';
        const callCwd = cwds && index < cwds.length ? (cwds[index] ?? null) : null;
        if (root && callCwd) {
            here = cdTarget('', callCwd, root, top);
        }
        const obs = here === null
            ? // Started outside the session's directory: its own `cd`s are taken as typed.
                classifyCommand(command, { callIndex: index, vocab })
            : classifyCommand(command, { callIndex: index, vocab, cwd: here, root, top });
        if (vocab.generic || command.includes('python') || command.includes('=')) {
            const hint = exitCodeHint(output);
            const success = hint === null ? !call.isError : hint === 0;
            const env = envCalls(command, output, success, index);
            if (env.need.length > 0 || Object.keys(env.sets).length > 0)
                envCallsOut.push(env);
        }
        if (obs.length === 0)
            return;
        for (const observation of obs) {
            if (observation.intent !== 'run_tests')
                continue;
            const labels = testLabels(observation);
            observation.labels = labels;
            observation.labelErr = labels.length > 0 && labelFailed(labels, output);
            observation.testsRan = LOADED_RE.test(output) || (vocab.generic && LOADED_GENERIC_RE.test(output));
            observation.loaded = labels.length > 0 && !observation.labelErr && observation.testsRan;
        }
        // Pass-through segments (a leading `cd`, a trailing `| head`, an `echo ---` separator)
        // neither add evidence nor pollute the output, so they do not break a call's homogeneity;
        // filters that rewrite content (grep, sed, awk, wc) do.
        const commandSegments = segments(unwrap(command));
        const relevant = commandSegments.filter((segment) => {
            const head = (tokens(segment)[0] ?? '').replace(/\\/g, '/');
            return !PASSTHROUGH_HEADS.has(baseName(head));
        });
        const intents = new Set(obs.map((observation) => observation.intent));
        const homogeneous = relevant.length === obs.length && intents.size === 1;
        const hint = exitCodeHint(output);
        const success = hint === null ? !call.isError : hint === 0;
        const err = errorClass(output);
        if (err !== null && (FORM_ERRORS.has(err) || NETWORK_ERRORS.has(err))) {
            let targets = obs.filter((observation) => TARGET_INTENTS.has(observation.intent));
            let named = targets.filter((observation) => (observation.head && output.includes(observation.head)) ||
                (observation.head && errorLine(output, err).includes(baseOfHead(observation.head))));
            if (NETWORK_ERRORS.has(err)) {
                const fetchTargets = targets.filter((observation) => observation.intent === 'fetch_remote');
                named = fetchTargets.filter((observation) => observation.hosts.length === 0 || observation.hosts.some((host) => output.includes(host)));
                if (named.length === 0)
                    named = fetchTargets;
            }
            const chosen = named.length > 0 ? named : success ? [] : targets.slice(-1);
            const missing = err === 'command_missing' ? notFoundName(errorLine(output, err)) : '';
            for (const observation of chosen) {
                observation.outcome = err;
                observation.notFound = Boolean(missing) && baseOfHead(observation.head) === missing;
            }
            if (success) {
                for (const observation of obs) {
                    if (observation.outcome === null)
                        observation.outcome = 'ran';
                }
            }
        }
        else if (success) {
            for (const observation of obs)
                observation.outcome = 'ran';
        }
        else {
            let first = true;
            for (const observation of obs) {
                if (TARGET_INTENTS.has(observation.intent)) {
                    observation.outcome = first ? 'ran' : null;
                    first = false;
                }
                else {
                    observation.outcome = observation.intent !== 'probe_vcs_refs' ? 'ran' : null;
                }
            }
        }
        for (const observation of obs) {
            if (observation.intent === 'probe_vcs_refs') {
                // Judged only when every segment of the call is a probe: another segment's output (a
                // `git describe`, a `sed`) would otherwise be read as the probe's.
                if (!homogeneous) {
                    observation.outcome = null;
                }
                else if (observation.probe) {
                    observation.outcome = probeHit(observation.probe, output) ? 'hit' : success ? 'empty' : null;
                }
            }
            if (observation.intent === 'fetch_remote' && observation.outcome === 'ran') {
                // Reachability needs a homogeneous call that exited 0 with real output and no network
                // error; a compound command's exit code and output belong to its last segment.
                if (!homogeneous || !success || !output.trim() || (err !== null && NETWORK_ERRORS.has(err))) {
                    observation.outcome = null;
                }
            }
        }
        observations.push(...obs);
    });
    let edited;
    if (options.edited)
        edited = [...options.edited].sort();
    else
        edited = [...(vocab.generic ? editedFiles(calls) : editedPyFiles(calls))].sort();
    return { obs: observations, edited, nCalls, env: envCallsOut };
}
export function detectVocabulary(signals = {}) {
    const pythonExt = /\.pyi?$/;
    const nodeExt = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
    let python = 0;
    let node = 0;
    for (const file of signals.files ?? []) {
        const path = String(file).toLowerCase();
        if (pythonExt.test(path))
            python += 1;
        else if (nodeExt.test(path))
            node += 1;
    }
    for (const command of signals.commands ?? []) {
        const text = String(command);
        if (/\b(?:python[0-9.]*|pytest|py\.test|pip[0-9]*|poetry|pipenv|tox|nox)\b/.test(text))
            python += 1;
        if (/\b(?:node|nodejs|npm|npx|pnpm|yarn|bun|jest|vitest|mocha|tsc|eslint)\b/.test(text))
            node += 1;
    }
    if (python > node)
        return PYTHON_GIT;
    if (node > python)
        return NODE_WEB;
    return GENERIC;
}
/** One classified observation as plain data (used by the parity harness and the engine). */
export function observationData(observation, callIndex = observation.call) {
    return {
        call: callIndex,
        intent: observation.intent,
        form: observation.form,
        head: observation.head,
        prefix: observation.prefix,
        segment: observation.segment,
        env: observation.env,
        hosts: [...observation.hosts],
        probe: observation.probe,
    };
}
