/**
 * `TurnGuard`: the loop guard for one prompt-turn, one tool call at a time.
 *
 * Port of `tokeneconomizer/loopguard/turn.py` (Microsoft TokenEconomizer, Apache-2.0,
 * commit 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0).
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit 7042ea8.
 *
 * Upstream persists the guard between one hook process per call; here a `TurnGuard` is a
 * plain object the engine can serialize (`toDict`) and restore after a restart.
 *
 * Edits made through the shell are counted too (`shell-edits.ts`, a port of
 * `loopguard/shell_edits.py`): a `sed -i`, a redirect, an inline Python write or a patch is an
 * edit even though no edit tool ran.
 */
import { DEFAULT_THRESHOLDS, assessAbort, formatFixed0, isStuck, nudgeText, } from './rules.js';
import { foldShellEdits, shellEditTargets, shellRevertTargets, } from './shell-edits.js';
import { TEST_RUN_RE, canonTool, errMatch, spiralStateFromDict, spiralStateToDict, SpiralState, } from './state.js';
const _SLOTS = [
    'turns',
    'edit_counts',
    'edit_order',
    'error_outputs',
    'test_runs',
    'fail_sigs',
    'repeated_fail_sigs',
    'recent',
];
/**
 * What counts as running the project's own checks, across ecosystems (`VERIFY_RE`,
 * turn.py:37-52). Broader than `state.TEST_RUN_RE`; used ONLY for the ended-green proxy.
 *
 * JavaScript has no inline `(?-i:...)` flag group (Node 22), and upstream's Ruby alternative
 * scopes case-sensitivity around a `ruby` invocation's options. The Ruby alternative is
 * therefore a separate, case-sensitive expression below with explicit character classes for
 * the parts upstream matches case-insensitively. The pattern is otherwise verbatim.
 */
const _VERIFY_MAIN_SRC = String.raw `(?:^|[\s;&|(])(?:(?:~?/)?(?:[\w.\-]+/)*python\d?(?:\.\d+)?\s+)?` +
    String.raw `(?:~?/)?(?:[\w.\-]+/)*(?:pytest|py\.test|tox|nox|python\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest)|` +
    String.raw `manage\.py\s+test|runtests(?:\.py)?|jest|vitest|mocha|ava|playwright\s+test|` +
    String.raw `(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+(?:test|nextest)|` +
    String.raw `(?:mvn|mvnw|\./mvnw)\s+(?:\S+\s+)*test|(?:gradle|gradlew|\./gradlew)\s+(?:\S+\s+)*test|` +
    String.raw `make\s+(?:test|check)|ctest|rspec|phpunit|dotnet\s+test|swift\s+test|mix\s+test|` +
    String.raw `rake(?:\s+\w+=\S*)*\s+(?:test|spec)(?::[\w:]+)?|rails\s+test(?::[\w:]+)?|` +
    String.raw `deno\s+test|node\s+--test|bazel\s+test|(?:\./)?bin/test)(?![\w.\-/])`;
const _VERIFY_RUBY_SRC = String.raw `(?:^|[\s;&|(])(?:(?:~?/)?(?:[\w.\-]+/)*[Pp][Yy][Tt][Hh][Oo][Nn]\d?(?:\.\d+)?\s+)?` +
    String.raw `(?:~?/)?(?:[\w.\-]+/)*[Rr][Uu][Bb][Yy]` +
    String.raw `(?:\s+(?:-(?:I|r)(?:\S+|\s+[^\s\-]\S*)|-C\s*\S+|-W[0-2]?(?::\S+)?|` +
    String.raw `--[\w\-]+(?:=\S+)?|-[abdf-zABDF-Z]+))*\s+` +
    String.raw `(?:[\w.\-~]*/)*(?:[Tt][Ee][Ss][Tt]_[\w.\-]*|[\w.\-]*_(?:[Tt][Ee][Ss][Tt]|[Ss][Pp][Ee][Cc]))\.[Rr][Bb]` +
    String.raw `(?![\w.\-/])`;
/** Python `VERIFY_RE.match` semantics: the pattern must match at the start. */
const _VERIFY_MAIN_RE = new RegExp(`^(?:${_VERIFY_MAIN_SRC})`, 'i');
const _VERIFY_RUBY_RE = new RegExp(`^(?:${_VERIFY_RUBY_SRC})`);
/** Does `text` run a project check (`VERIFY_RE.match`)? */
function verifyMatch(text) {
    return _VERIFY_MAIN_RE.test(text) || _VERIFY_RUBY_RE.test(text);
}
/** Exported for tests and the adapter's own "is this a verification run?" check. */
export { _VERIFY_MAIN_SRC as VERIFY_MAIN_SOURCE, _VERIFY_RUBY_SRC as VERIFY_RUBY_SOURCE };
const _SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const _QUOTED_RE = /'[^']*'|"(?:\\.|[^"\\])*"/g;
const _SEP_RE = /(&&|\|\||\|&|(?<!>)\||;|\n)/;
// A runner asked for its help, version or test list, not to run the tests.
const _NOT_A_RUN_RE = /\s(?:-h|--help|--version|--collect-only|--co|--list\S*)(?!\S)/;
// What may precede the command itself: `FOO=1 timeout 60 npm test`, `env -u VAR`, `npx jest`.
const _PREFIX_RE = /^\s*(?:(?:\w+=\S*|time|nohup|command|nice(?:\s+(?:-n\s*|--adjustment=)?[-+]?\d+)?|env(?:\s+(?:(?:-[uC]|--unset|--chdir)(?:=|\s*)[^\s-]\S*|-[-\w]*))*|timeout(?:\s+(?:-\S+|[A-Z]+|\d\S*))+|(?:(?:uv|poetry|pipenv|pdm|hatch|rye)\s+run|npx|bunx|(?:npm|pnpm|yarn)\s+(?:exec|dlx)|bundle\s+exec|xvfb-run)(?:\s+-\S+)*|dotenv(?:\s+(?!--(?:\s|$))\S+)*\s+--)\s+)*/;
// What only reports on the run before it: `echo "exit=$?"`, `true`, `exit 0`.
const _REPORT_RE = /^\s*(?:echo|printf|true|:|exit)(?:\s|$)/;
const _HEREDOC_START = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/;
const _RANK = { own: 0, hidden: 1, mixed: 2 };
function pathBasename(word) {
    const parts = word.split('/');
    return parts[parts.length - 1] ?? '';
}
/** Python `str.strip()` (Unicode whitespace) for the heredoc tag comparison. */
function stripText(text) {
    return text.replace(/^\s+|\s+$/g, '');
}
/**
 * `shell_edits._split_heredocs`: the command's shell text without heredoc bodies, plus the
 * bodies. A heredoc's lines are input, not commands.
 */
function splitHeredocs(cmd) {
    const shell = [];
    const bodies = [];
    let tag = null;
    let body = [];
    for (const line of cmd.split('\n')) {
        if (tag !== null) {
            if (stripText(line) === tag) {
                bodies.push(body.join('\n'));
                tag = null;
                body = [];
            }
            else {
                body.push(line);
            }
            continue;
        }
        shell.push(line);
        const m = _HEREDOC_START.exec(line);
        if (m)
            tag = m[2] ?? null;
    }
    if (tag !== null)
        bodies.push(body.join('\n'));
    return { shell: shell.join('\n'), bodies };
}
/**
 * POSIX `shlex.split` (Python stdlib), used only to notice a `bash -lc '<script>'` wrapper.
 * Returns null on unbalanced quotes (upstream catches `ValueError` and ignores the wrapper).
 */
function shlexSplit(text) {
    const out = [];
    let cur = '';
    let has = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            if (has) {
                out.push(cur);
                cur = '';
                has = false;
            }
            i += 1;
        }
        else if (ch === "'") {
            const end = text.indexOf("'", i + 1);
            if (end < 0)
                return null;
            cur += text.slice(i + 1, end);
            has = true;
            i = end + 1;
        }
        else if (ch === '"') {
            i += 1;
            let closed = false;
            while (i < text.length) {
                const c = text[i];
                if (c === '"') {
                    closed = true;
                    i += 1;
                    break;
                }
                if (c === '\\' && i + 1 < text.length) {
                    const n = text[i + 1];
                    if (n === '"' || n === '\\' || n === '$' || n === '`') {
                        cur += n;
                        i += 2;
                        continue;
                    }
                    if (n === '\n') {
                        i += 2;
                        continue;
                    }
                }
                cur += c;
                i += 1;
            }
            if (!closed)
                return null;
            has = true;
        }
        else if (ch === '\\') {
            if (i + 1 >= text.length)
                return null;
            cur += text[i + 1];
            has = true;
            i += 2;
        }
        else {
            cur += ch;
            has = true;
            i += 1;
        }
    }
    if (has)
        out.push(cur);
    return out;
}
/**
 * `_pieces` (turn.py:84): `cmd` as its commands and the separators between them, with quoted
 * text masked and heredoc bodies left out, plus whether it sets `pipefail`. A command recorded
 * as `bash -lc '<script>'` (Codex) is split by its script.
 */
function pieces(cmd) {
    let text = cmd;
    const parts = shlexSplit(cmd);
    if (parts !== null &&
        parts.length >= 3 &&
        _SHELLS.has(pathBasename(parts[0] ?? '')) &&
        (parts[1] ?? '').startsWith('-') &&
        (parts[1] ?? '').includes('c')) {
        text = parts[2];
    }
    text = splitHeredocs(text).shell;
    const masked = text.replace(_QUOTED_RE, 'Q').replace(/[(){}]/g, ' ');
    const ps = masked.split(_SEP_RE);
    while (ps.length > 1 && !(ps[ps.length - 1] ?? '').trim())
        ps.splice(-2, 2);
    return { pieces: ps, pipefail: text.includes('pipefail') };
}
// Commands whose own failure does not matter to the loop guard: they read, move about, set up
// or report. A later command may take over the exit status from one of them.
const _QUIET_HEADS = new Set([
    'cat', 'head', 'tail', 'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column',
    'ls', 'tree', 'pwd', 'stat', 'file', 'du', 'which', 'type', 'whereis', 'grep', 'egrep',
    'fgrep', 'rg', 'ag', 'jq', 'find', 'echo', 'printf', 'true', ':', 'cd', 'pushd', 'popd',
    'export', 'source', '.', 'set', 'sed', 'git',
]);
const _GIT_READS = new Set([
    'show', 'diff', 'log', 'status', 'grep', 'ls-files', 'blame', 'rev-parse', 'branch',
]);
function quiet(stage) {
    const words = (stage.trim() + ' ').replace(_PREFIX_RE, '').split(/\s+/).filter((w) => w !== '');
    if (words.length === 0)
        return true;
    const head = pathBasename(words[0]);
    if (!_QUIET_HEADS.has(head))
        return false;
    if (head === 'git')
        return words.length > 1 && _GIT_READS.has(words[1]);
    if (head === 'sed') {
        // `sed -i` edits.
        return !words.slice(1).some((w) => /^(?:-[a-zA-Z]*i|--in-place)/.test(w));
    }
    if (head === 'find') {
        const dangerous = new Set(['-delete', '-exec', '-execdir', '-ok']);
        return !words.slice(1).some((w) => dangerous.has(w));
    }
    return true;
}
/**
 * `exit_status_covers` (turn.py:131): does `cmd`'s exit status say whether the work it ran
 * failed? No when one command that does work could have failed unseen (a pipe, `||`, `;`).
 */
export function exitStatusCovers(cmd) {
    if (typeof cmd !== 'string' || !cmd.trim())
        return false;
    const { pieces: ps, pipefail } = pieces(cmd);
    for (let i = 0; i + 1 < ps.length; i += 2) {
        const sep = ps[i + 1];
        if (sep === '&&' || (pipefail && (sep === '|' || sep === '|&')))
            continue;
        if (!quiet(ps[i]))
            return false;
    }
    return true;
}
/**
 * `status_of_tests` (turn.py:150): what `cmd`'s exit status says of the test runs in it.
 * `own` when it is theirs, `hidden` when a pipe/`||`/mere report replaced it, `mixed` when
 * other commands' output is in the result too, null when it runs none.
 */
export function statusOfTests(cmd) {
    if (typeof cmd !== 'string')
        return null;
    const { pieces: ps, pipefail } = pieces(cmd);
    let found = null;
    for (let i = 0; i < ps.length; i += 2) {
        const stage = ps[i];
        const stripped = stage.trim() + ' ';
        const prefixed = _PREFIX_RE.test(stripped) ? stripped.replace(_PREFIX_RE, '') : stripped;
        if (!verifyMatch(prefixed) || _NOT_A_RUN_RE.test(stage))
            continue;
        let status = 'own';
        for (let j = i + 1; j + 1 < ps.length; j += 2) {
            const sep = ps[j];
            const then = ps[j + 1];
            if (sep === '&&' || (pipefail && (sep === '|' || sep === '|&')))
                continue;
            if (sep === '|' || sep === '|&' || sep === '||') {
                status = 'hidden';
                break;
            }
            if (!_REPORT_RE.test(then)) {
                status = 'mixed';
                break;
            }
            status = 'hidden';
        }
        if (found === null || (_RANK[status] ?? 0) > (_RANK[found] ?? 0))
            found = status;
    }
    return found;
}
// A test runner's summary of its run (`_RUN_FAILED_RE`, turn.py:181).
const _RUN_FAILED_RE = new RegExp([
    String.raw `\b[1-9]\d* (?:failed|errors?)\b.*\bin \d+(?:\.\d+)?s\b`,
    String.raw `^FAILED \((?:failures|errors)=`,
    String.raw `^tests finished:.*\b[1-9]\d* (?:failed|exceptions?)\b`,
    String.raw `^# fail [1-9]`,
    String.raw `^Tests:.*\b[1-9]\d* failed\b`,
    String.raw `^\s*Tests\s+[1-9]\d* failed\b`,
    String.raw `^\s*[1-9]\d* failing\b`,
    String.raw `^\s*[1-9]\d* failed\s*$`,
    String.raw `^(?:--- FAIL: |FAIL\t|FAIL$)`,
    String.raw `^test result: FAILED`,
    String.raw `\b\d+ examples?, [1-9]\d* failures?\b`,
    String.raw `^\d+ (?:runs|tests), \d+ assertions, (?:[1-9]\d* failures, \d+ errors|\d+ failures, [1-9]\d* errors)\b`,
    String.raw `Tests run: \d+, Failures: (?:[1-9]|0, Errors: [1-9])`,
    String.raw `BUILD FAIL(?:URE|ED)`,
].join('|'), 'm');
// A test runner's passing summary (`_RUN_PASSED_RE`, turn.py:198).
const _RUN_PASSED_RE = new RegExp([
    String.raw `\b\d+ passed\b.*\bin \d+(?:\.\d+)?s\b`,
    String.raw `^OK(?: \(.*\))?\s*$`,
    String.raw `^tests finished: \d+ passed`,
    String.raw `^# fail 0\b`,
    String.raw `^Tests:\s+\d+ passed`,
    String.raw `^\s*Tests\s+\d+ passed`,
    String.raw `^\s*\d+ passing\b`,
    String.raw `^\s*\d+ passed \(\d+(?:\.\d+)?(?:ms|s|m|h)\)`,
    String.raw `^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))`,
    String.raw `^test result: ok\.`,
    String.raw `\b\d+ examples?, 0 failures\b`,
    String.raw `^\d+ (?:runs|tests), \d+ assertions, 0 failures, 0 errors\b`,
    String.raw `BUILD SUCCESS`,
].join('|'), 'm');
/**
 * `runner_verdict` (turn.py:214): true when a runner summary says its run failed, false when
 * one says it passed (and none failed), null when `text` holds no summary.
 */
export function runnerVerdict(text) {
    if (!text)
        return null;
    if (_RUN_FAILED_RE.test(text))
        return true;
    return _RUN_PASSED_RE.test(text) ? false : null;
}
const _EDIT = new Set(['edit', 'create']);
/** Upstream `state_to_dict` (turn.py:227). */
export function stateToDict(state) {
    return spiralStateToDict(state);
}
/** Upstream `state_from_dict` (turn.py:231). */
export function stateFromDict(data) {
    return spiralStateFromDict(data);
}
/** `backstop_mult * envelope` (or a learned `backstop_turns`), null when neither exists. */
export function backstopTurnsFor(thr, envelope) {
    if (typeof thr.backstop_turns === 'number')
        return thr.backstop_turns;
    if (envelope !== null && envelope !== undefined)
        return envelope * thr.backstop_mult;
    return null;
}
function isBackgroundJudge(judge) {
    return (judge !== null &&
        judge !== undefined &&
        typeof judge.poll === 'function' &&
        typeof judge.start === 'function');
}
/**
 * The loop guard for one prompt-turn, persisted between hook calls via `toDict` (`TurnGuard`,
 * turn.py:239).
 */
export class TurnGuard {
    static JUDGE_BASE_GAP = 5;
    static JUDGE_MAX_GAP = 20;
    static JUDGE_STALE_S = 300;
    static NOT_GREEN = 'Tests are still NOT green.';
    turnKey;
    /** This segment; reset after a nudge. */
    st;
    /** The whole turn; never reset. */
    whole;
    cumTurns;
    segment;
    nudgesDone;
    aborted;
    abortDelivered;
    events;
    judgeLast;
    judgeGap;
    judgeCalls;
    judgeTokens;
    writerTokens;
    lastEdit;
    lastVerify;
    lastVerifyFailed;
    edits;
    verifications;
    judgePending;
    nudgeReady;
    held;
    constructor(init = {}) {
        const d = init.data ?? {};
        this.turnKey = d.turn_key ?? init.turnKey ?? '';
        this.st = stateFromDict(d.st);
        this.whole = stateFromDict(d.whole);
        this.cumTurns = d.cum_turns ?? 0;
        this.segment = d.segment ?? 0;
        this.nudgesDone = d.nudges_done ?? 0;
        this.aborted = d.aborted ?? false;
        this.abortDelivered = d.abort_delivered ?? false;
        this.events = Array.isArray(d.events) ? [...d.events] : [];
        this.judgeLast = d.judge_last ?? -999;
        this.judgeGap = d.judge_gap ?? TurnGuard.JUDGE_BASE_GAP;
        this.judgeCalls = d.judge_calls ?? 0;
        this.judgeTokens = d.judge_tokens ?? 0;
        this.writerTokens = d.writer_tokens ?? 0;
        this.lastEdit = d.last_edit ?? 0;
        this.lastVerify = d.last_verify ?? 0;
        this.lastVerifyFailed = d.last_verify_failed ?? false;
        this.edits = d.edits ?? 0;
        this.verifications = d.verifications ?? 0;
        this.judgePending = d.judge_pending ?? null;
        this.nudgeReady = d.nudge_ready ?? null;
        this.held = Array.isArray(d.held)
            ? { action: d.held[0], reason: d.held[1] }
            : null;
    }
    /** Upstream `to_dict` (turn.py:273). */
    toDict() {
        return {
            turn_key: this.turnKey,
            st: stateToDict(this.st),
            whole: stateToDict(this.whole),
            cum_turns: this.cumTurns,
            segment: this.segment,
            nudges_done: this.nudgesDone,
            aborted: this.aborted,
            abort_delivered: this.abortDelivered,
            events: this.events.slice(-20),
            judge_last: this.judgeLast,
            judge_gap: this.judgeGap,
            judge_calls: this.judgeCalls,
            judge_tokens: this.judgeTokens,
            writer_tokens: this.writerTokens,
            last_edit: this.lastEdit,
            last_verify: this.lastVerify,
            last_verify_failed: this.lastVerifyFailed,
            edits: this.edits,
            verifications: this.verifications,
            judge_pending: this.judgePending,
            nudge_ready: this.nudgeReady,
            held: this.held ? [this.held.action, this.held.reason] : null,
        };
    }
    // ---- outcome tracking for the ended-green proxy (turn.py:287) --------------------
    track(name, args, result, exitCode, shellEdits = []) {
        const canon = canonTool(name);
        if (_EDIT.has(canon)) {
            this.lastEdit = this.cumTurns;
            this.edits += 1;
            return;
        }
        const raw = canon === 'bash' ? args.command : undefined;
        const cmd = typeof raw === 'string' ? raw : null;
        const verifies = statusOfTests(cmd) !== null;
        if (shellEdits.length) {
            // `sed -i ... && pytest`: the edit comes first, so the run verifies it.
            this.lastEdit = this.cumTurns - (verifies ? 1 : 0);
            this.edits += 1;
        }
        if (verifies) {
            this.lastVerify = this.cumTurns;
            this.verifications += 1;
            if (exitCode !== null) {
                this.lastVerifyFailed = exitCode !== 0;
            }
            else {
                // No status, or one another command gave (a pipe): the output's markers decide.
                this.lastVerifyFailed = errMatch(result);
            }
        }
    }
    /**
     * `resolved_proxy` (turn.py:308): did this turn END GREEN? Green unless a verification after
     * the last edit failed.
     */
    resolvedProxy(stoppedNormally = true) {
        if (!stoppedNormally || this.aborted || this.cumTurns === 0)
            return false;
        return !(this.lastVerifyFailed && this.lastVerify > this.lastEdit);
    }
    // ---- what the judge is told (turn.py:319) ----------------------------------------
    verificationState() {
        if (!this.verifications)
            return 'No test or verification run has been seen in this turn.';
        const state = this.lastVerifyFailed ? 'failed' : 'passed';
        const since = this.lastEdit > this.lastVerify ? ' There have been edits since.' : '';
        return `The last verification run ${state}.${since}`;
    }
    /** Replace the static "not green" line with what this turn actually saw (turn.py:332). */
    liveDigest(digest) {
        return (digest ?? '').split(TurnGuard.NOT_GREEN).join(this.verificationState());
    }
    // ---- the judge, rate-limited with backoff (turn.py:335) -------------------------
    /** Upstream `_backoff`: a productive verdict widens the sampling gap. */
    applyJudgeBackoff(verdict) {
        if (verdict && verdict.stuck === false) {
            this.judgeGap = Math.min(TurnGuard.JUDGE_MAX_GAP, this.judgeGap + TurnGuard.JUDGE_BASE_GAP);
        }
        else {
            this.judgeGap = TurnGuard.JUDGE_BASE_GAP;
        }
    }
    /** Is the paid judge due under the sampling gap? */
    judgeDue() {
        return this.st.turns - this.judgeLast >= this.judgeGap;
    }
    /** Account for a judge call starting at the current segment length. */
    markJudgeCalled() {
        this.judgeLast = this.st.turns;
        this.judgeCalls += 1;
    }
    /** Upstream `_sampled` (turn.py:342). */
    sampledJudge(judge) {
        return (digest) => {
            if (!this.judgeDue())
                return null;
            this.markJudgeCalled();
            let v = null;
            try {
                v = judge(this.liveDigest(digest)) ?? null;
            }
            catch {
                v = null;
            }
            if (v)
                this.judgeTokens += Number(v._tokens ?? 0) || 0;
            this.applyJudgeBackoff(v);
            return v;
        };
    }
    /** Upstream `_background` (turn.py:358): a verdict whenever one has come back. */
    backgroundJudge(judge) {
        return (digest) => {
            const polled = judge.poll(this);
            if (polled.found) {
                this.judgePending = null;
                const v = polled.verdict;
                if (v)
                    this.nudgeReady = String(v._nudge ?? '').trim() || null;
                this.applyJudgeBackoff(v);
                return v ?? null;
            }
            if (this.judgePending) {
                const since = Number(this.judgePending.since ?? 0);
                if (Date.now() / 1000 - since < TurnGuard.JUDGE_STALE_S)
                    return null;
                this.judgePending = null;
            }
            if (!this.judgeDue())
                return null;
            this.markJudgeCalled();
            const job = judge.start(this, this.liveDigest(digest));
            if (job !== null && job !== undefined) {
                this.judgePending = { id: job, since: Date.now() / 1000, segment: this.segment };
            }
            return null;
        };
    }
    wireJudge(judge) {
        if (judge === null || judge === undefined)
            return null;
        if (isBackgroundJudge(judge))
            return this.backgroundJudge(judge);
        if (typeof judge === 'function')
            return this.sampledJudge(judge);
        return null;
    }
    // ---- one completed tool call (turn.py:385) --------------------------------------
    /**
     * Fold the measurement side of one completed call (`fold` steps 1-6, turn.py:392-419):
     * state, whole-turn state, the extra verification count, cumTurns and outcome tracking.
     * Split out so the async engine can pay for a judge only after this (free) fold.
     */
    observe(name, args, result, exitCode = null) {
        const a = args ?? {};
        const canon = canonTool(name);
        const raw = canon === 'bash' ? a.command : undefined;
        const cmd = typeof raw === 'string' ? raw : null;
        let shellEdits = cmd !== null ? shellEditTargets(cmd) : [];
        if (shellEdits.length) {
            // A file put back with `git checkout --` or `git restore` is an edit only when this
            // turn edited it: putting back what a dev server keeps regenerating is not churn.
            const reverted = new Set(cmd !== null ? shellRevertTargets(cmd) : []);
            shellEdits = shellEdits.filter((b) => !reverted.has(b) || Boolean(this.whole.editCounts.get(b)));
        }
        const status = statusOfTests(cmd);
        let code = exitCode;
        if (status === 'hidden' || status === 'mixed') {
            const verdict = runnerVerdict(result);
            if (verdict !== null)
                code = verdict ? 1 : 0;
            else if (status === 'hidden')
                code = null;
        }
        const failed = code === null ? null : code !== 0;
        const text = result ?? '';
        this.st.update(name, a, text, failed);
        this.whole.update(name, a, text, failed);
        if (status !== null && cmd !== null && !TEST_RUN_RE.test(cmd)) {
            // `SpiralState` counts the Python runners its thresholds were tuned on; the turn's other
            // test runs (`npx vitest`, `go test`) are verifications too.
            this.st.testRuns += 1;
            this.whole.testRuns += 1;
        }
        foldShellEdits(this.st, shellEdits);
        foldShellEdits(this.whole, shellEdits);
        this.cumTurns += 1;
        this.track(name, a, text, code, shellEdits);
    }
    /** Fold one call and return the decision; the sync upstream `fold` (turn.py:386). */
    fold(name, args, result, exitCode = null, options = {}) {
        const thr = options.thr ?? DEFAULT_THRESHOLDS;
        const envelope = options.envelope ?? null;
        const nudgeBudget = options.nudgeBudget ?? 1;
        this.observe(name, args, result, exitCode);
        if (this.aborted || this.held)
            return null;
        const backstop = backstopTurnsFor(thr, envelope);
        if (backstop !== null && this.cumTurns >= backstop && isStuck(this.st, thr)) {
            // The ladder is nudge, THEN stop. An unspent nudge goes first.
            const reason = `cum-backstop:${this.cumTurns}>=${formatFixed0(backstop)}t`;
            if (this.nudgesDone < nudgeBudget)
                return this.stop('nudge', reason, envelope);
            return this.stop('abort', reason, envelope);
        }
        const wired = this.wireJudge(options.judge);
        const assessment = assessAbort(this.st, envelope, wired, thr);
        if (!assessment.abort) {
            if (thr.nudge_on_ambiguous &&
                assessment.reason === 'judge-ambiguous-spared' &&
                this.nudgesDone < nudgeBudget) {
                return this.stop('nudge', 'ambiguous-past-envelope', envelope);
            }
            return null;
        }
        if (this.nudgesDone < nudgeBudget)
            return this.stop('nudge', assessment.reason, envelope);
        return this.stop('abort', assessment.reason, envelope);
    }
    /** Record a stop verdict (upstream `_stop`, turn.py:452). */
    stop(action, reason, envelope) {
        this.events.push({
            segment: this.segment,
            action,
            turn_in_segment: this.st.turns,
            cum_turns: this.cumTurns,
            envelope,
            reason,
            snapshot: this.st.snapshot(),
        });
        if (action === 'abort')
            this.aborted = true;
        return { action, reason };
    }
    /**
     * The redirect text (turn.py:461): one a background judge already wrote, else an LLM-written
     * one when a writer is wired, else the count template, which mirrors only the agent's own
     * actions.
     */
    nudgeBody(envelope = null, writer) {
        if (this.nudgeReady) {
            const text = this.nudgeReady;
            this.nudgeReady = null;
            return text;
        }
        if (writer) {
            let out;
            try {
                out = writer(this.liveDigest(this.st.recentDigest({ envelope })));
            }
            catch {
                out = null;
            }
            if (out) {
                this.writerTokens += Number(out._tokens ?? out.tokens ?? 0) || 0;
                const text = (out.text ?? '').trim();
                if (text)
                    return text;
            }
        }
        return nudgeText(this.st);
    }
    /** Start the post-nudge segment with a fresh state (turn.py:480). */
    afterNudge() {
        this.nudgesDone += 1;
        this.segment += 1;
        this.st = new SpiralState();
        this.judgeLast = -999;
        this.judgeGap = TurnGuard.JUDGE_BASE_GAP;
        this.judgePending = null;
        this.nudgeReady = null;
    }
    /** Upstream `summary` (turn.py:491). */
    summary(stoppedNormally = true) {
        return {
            turn_key: this.turnKey,
            tool_calls: this.cumTurns,
            nudges: this.nudgesDone,
            aborted: this.aborted,
            resolved_proxy: this.resolvedProxy(stoppedNormally),
            edits: this.edits,
            verifications: this.verifications,
            judge_tokens: this.judgeTokens,
            writer_tokens: this.writerTokens,
        };
    }
}
/** Exported for parity consumers that want the upstream slot list. */
export const TURN_GUARD_STATE_SLOTS = _SLOTS;
