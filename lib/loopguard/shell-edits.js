/** `<<<` is a here-string: its word is the input itself, so no body follows. */
const HEREDOC_START = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/;
const OPS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '\n', '(', ')']);
/** Redirects that write their operand. */
const OUT = new Set(['>', '>>', '>|', '&>', '&>>']);
/** Input, heredoc tags, fd duplication. */
const SKIP_OPERAND = new Set(['<', '<<', '<<<', '<&', '>&', '<>']);
/** Redirect and `tee` targets count only when they look like source. */
const SOURCE_FILE = /\.(?:py|pyi|pyx|pxd|js|jsx|mjs|cjs|ts|tsx|rs|go|java|kt|kts|scala|c|cc|cpp|cxx|h|hh|hpp|rb|php|cs|swift|m|mm|sh|bash|zsh|lua|jl|ex|exs|erl|hs|ml|clj|sql|toml|ya?ml|json|cfg|ini|conf|md|rst|html?|css|scss|vue|svelte|xml|gradle|properties|in)$/i;
const PYTHON = /(?:^|[\s/;&|(])python\d?(?:\.\d+)?\b/;
const PY_OPEN_LIT = /open\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])([^'"]*)\3/g;
const PY_OPEN_VAR = /open\(\s*([A-Za-z_]\w*)\s*,\s*(['"])([^'"]*)\2/g;
const PY_WRITE_PATH_LIT = /(?:pathlib\.)?Path\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g;
const PY_WRITE_PATH_VAR = /\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(/g;
/** Codex's patch format, as `apply_patch <<'PATCH'` takes it on stdin. */
const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm;
const GIT_VALUE_OPTS = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--config-env',
    '--attr-source',
]);
const PUNCT = new Set(['(', ')', ';', '<', '>', '|', '&', '\n']);
const WHITESPACE = new Set([' ', '\t', '\r']);
function notScratch(path) {
    return Boolean(path) && !path.startsWith('/dev/') && !path.startsWith('/proc/') && !path.startsWith('/tmp/');
}
function unquote(token) {
    if (token.length >= 2) {
        const first = token[0];
        if ((first === "'" || first === '"') && token[token.length - 1] === first) {
            return token.slice(1, -1);
        }
    }
    return token;
}
function pathBasename(path) {
    const parts = path.split('/');
    return parts[parts.length - 1] ?? '';
}
/**
 * `shell_edits._split_heredocs`: the command's shell text without heredoc bodies, plus the
 * bodies. A heredoc's lines are input, not commands.
 */
export function splitHeredocs(cmd) {
    const shell = [];
    const bodies = [];
    let tag = null;
    let body = [];
    for (const line of cmd.split('\n')) {
        if (tag !== null) {
            if (line.trim() === tag) {
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
        const m = HEREDOC_START.exec(line);
        if (m)
            tag = m[2] ?? null;
    }
    if (tag !== null)
        bodies.push(body.join('\n'));
    return { shell: shell.join('\n'), bodies };
}
/**
 * Shell words and operators. Quotes stay on quoted words, so a quoted `'>'` or `'|'` is never
 * read as an operator. Returns null on unbalanced quotes (upstream `ValueError`).
 */
function tokenize(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (WHITESPACE.has(ch)) {
            i += 1;
            continue;
        }
        if (PUNCT.has(ch)) {
            let j = i;
            while (j < text.length && PUNCT.has(text[j]))
                j += 1;
            out.push(text.slice(i, j));
            i = j;
            continue;
        }
        let word = '';
        while (i < text.length) {
            const c = text[i];
            if (WHITESPACE.has(c) || PUNCT.has(c))
                break;
            if (c === "'" || c === '"') {
                const quote = c;
                let j = i + 1;
                while (j < text.length && text[j] !== quote) {
                    if (text[j] === '\\' && quote === '"' && j + 1 < text.length)
                        j += 2;
                    else
                        j += 1;
                }
                if (j >= text.length)
                    return null;
                word += text.slice(i, j + 1);
                i = j + 1;
                continue;
            }
            word += c;
            i += 1;
        }
        if (word)
            out.push(word);
    }
    return out;
}
/** Simple commands as word lists, plus the files their redirects write. */
function commandsOf(shell) {
    const streams = [];
    const whole = tokenize(shell);
    if (whole) {
        streams.push(whole);
    }
    else {
        // One bad line must not hide the others.
        for (const line of shell.split('\n')) {
            const lineTokens = tokenize(line);
            if (lineTokens)
                streams.push([...lineTokens, '\n']);
        }
    }
    const cmds = [];
    const writes = [];
    for (const toks of streams) {
        let cur = [];
        let i = 0;
        while (i < toks.length) {
            const t = toks[i];
            if (OPS.has(t)) {
                if (cur.length)
                    cmds.push(cur);
                cur = [];
            }
            else if (OUT.has(t) || SKIP_OPERAND.has(t)) {
                if (cur.length && /^\d+$/.test(cur[cur.length - 1]))
                    cur.pop();
                if (OUT.has(t) && i + 1 < toks.length && !OPS.has(toks[i + 1])) {
                    writes.push(unquote(toks[i + 1]));
                }
                i += 1;
            }
            else {
                cur.push(unquote(t));
            }
            i += 1;
        }
        if (cur.length)
            cmds.push(cur);
    }
    return { cmds, writes };
}
/**
 * File operands of an in-place editor (`sed -i`, `perl -pi`), or [] if not in place.
 * `scriptFlag` says where an option puts the script: "next" for the following word, "inline"
 * for the option itself.
 */
function inplaceFiles(tokens, inplaceFlag, scriptFlag) {
    if (!tokens.slice(1).some(inplaceFlag))
        return [];
    const files = [];
    let haveScript = false;
    let skip = false;
    for (const t of tokens.slice(1)) {
        if (skip) {
            skip = false;
            haveScript = true;
            continue;
        }
        if (!t || t.startsWith('-')) {
            const where = t ? scriptFlag(t) : null;
            if (where === 'next')
                skip = true;
            else if (where === 'inline')
                haveScript = true;
            continue;
        }
        if (!haveScript) {
            haveScript = true;
            continue;
        }
        files.push(t);
    }
    return files;
}
/**
 * Where a short-option cluster such as `-ne`, `-pe's/a/b/'` or `-i.bak` puts the script. A
 * letter in `stopLetters` takes the rest of the word as its own value (`-i.bak`).
 */
function shortScriptFlag(t, scriptLetters, stopLetters) {
    if (t.startsWith('--') || t.length < 2)
        return null;
    for (let i = 1; i < t.length; i += 1) {
        const c = t[i];
        if (stopLetters.includes(c))
            return null;
        if (scriptLetters.includes(c))
            return t.slice(i + 1) ? 'inline' : 'next';
    }
    return null;
}
function sedScriptFlag(t) {
    if (t === '--expression' || t === '--file')
        return 'next';
    if (t.startsWith('--expression=') || t.startsWith('--file='))
        return 'inline';
    return shortScriptFlag(t, 'ef', 'i');
}
function perlScriptFlag(t) {
    return shortScriptFlag(t, 'eE', 'iIMmxdDC');
}
/** Paths an inline Python script writes; "(script)" for a write whose path cannot be read. */
function pyWrites(text) {
    const out = [];
    for (const m of text.matchAll(PY_OPEN_LIT)) {
        if (setIntersects(m[4] ?? '', 'wax+'))
            out.push(m[2]);
    }
    const variables = [];
    for (const m of text.matchAll(PY_OPEN_VAR)) {
        if (setIntersects(m[3] ?? '', 'wax+'))
            variables.push(m[1]);
    }
    for (const m of text.matchAll(PY_WRITE_PATH_LIT))
        out.push(m[2]);
    for (const m of text.matchAll(PY_WRITE_PATH_VAR))
        variables.push(m[1]);
    for (const variable of [...new Set(variables)]) {
        const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const assigned = [
            ...text.matchAll(new RegExp(`\\b${escaped}\\s*=\\s*(?:(?:pathlib\\.)?Path\\(\\s*)?(['"])([^'"\\n]+)\\1`, 'g')),
        ];
        const loop = new RegExp(`\\bfor\\s+${escaped}\\s+in\\s+[\\[(]([^\\])]*)[\\])]`).exec(text);
        let paths = assigned.map((m) => m[2]);
        if (loop) {
            for (const m of (loop[1] ?? '').matchAll(/['"]([^'"\n]+)['"]/g))
                paths.push(m[1]);
        }
        out.push(...(paths.length ? paths : ['(script)']));
    }
    return out;
}
function setIntersects(value, chars) {
    for (const c of value)
        if (chars.includes(c))
            return true;
    return false;
}
/** The words of a git command from its subcommand on, past git's own options. */
function gitArgs(tokens) {
    if (pathBasename(tokens[0] ?? '') !== 'git')
        return [];
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
        i += GIT_VALUE_OPTS.has(tokens[i]) ? 2 : 1;
    }
    return tokens.slice(i);
}
/** Paths a `git checkout -- <path>` or `git restore <path>` puts back. */
function restored(tokens) {
    const args = gitArgs(tokens);
    if (args.length < 2 || (args[0] !== 'checkout' && args[0] !== 'restore'))
        return [];
    const rest = args.includes('--')
        ? args.slice(args.indexOf('--') + 1)
        : args[0] === 'restore'
            ? args.slice(1)
            : [];
    return rest.filter((t) => !t.startsWith('-'));
}
/** Each command with the `sudo`, `env`, `VAR=1` ... before it dropped. */
function bare(cmds) {
    const out = [];
    for (let tokens of cmds) {
        while (tokens.length &&
            (['sudo', 'command', 'env', 'time', 'nohup'].includes(tokens[0]) ||
                /^\w+=/.test(tokens[0]))) {
            tokens = tokens.slice(1);
        }
        if (tokens.length)
            out.push(tokens);
    }
    return out;
}
/**
 * Basenames of the files a shell command puts back with `git checkout --` or `git restore`.
 * The guard counts them as edits only for a file the turn already edited.
 */
export function shellRevertTargets(cmd) {
    if (typeof cmd !== 'string' || !cmd.trim())
        return [];
    const { shell } = splitHeredocs(cmd);
    const { cmds } = commandsOf(shell);
    const names = bare(cmds)
        .flatMap((tokens) => restored(tokens))
        .filter(notScratch)
        .map(pathBasename);
    return [...new Set(names.filter(Boolean))];
}
/** Basenames of the files a shell command writes, in order, without repeats. */
export function shellEditTargets(cmd) {
    if (typeof cmd !== 'string' || !cmd.trim())
        return [];
    const { shell, bodies } = splitHeredocs(cmd);
    const { cmds, writes } = commandsOf(shell);
    const found = writes.filter((w) => SOURCE_FILE.test(w));
    for (const tokens of bare(cmds)) {
        const head = pathBasename(tokens[0] ?? '');
        if (head === 'sed') {
            found.push(...inplaceFiles(tokens, (t) => /^(?:-[a-zA-Z]*i|--in-place)/.test(t), sedScriptFlag));
        }
        else if (head === 'perl') {
            found.push(...inplaceFiles(tokens, (t) => /^-[a-zA-Z]*i/.test(t), perlScriptFlag));
        }
        else if (head === 'tee') {
            found.push(...tokens.slice(1).filter((t) => !t.startsWith('-') && SOURCE_FILE.test(t)));
        }
        else if (head === 'apply_patch') {
            const patchText = [...bodies, tokens.slice(1).join(' ')].join('\n');
            const matches = [...patchText.matchAll(PATCH_FILE)].map((m) => m[1].trim());
            found.push(...(matches.length ? matches : ['(patch)']));
        }
        else if (head === 'patch' || gitArgs(tokens)[0] === 'apply') {
            found.push('(patch)');
        }
        else {
            found.push(...restored(tokens));
        }
    }
    if (PYTHON.test(shell))
        found.push(...pyWrites([shell, ...bodies].join('\n')));
    const names = found
        .filter((p) => p.startsWith('(') || notScratch(p))
        .map((p) => (p.startsWith('(') ? p : pathBasename(p)));
    return [...new Set(names.filter(Boolean))];
}
/** Count `names` as edits in a `SpiralState`, and say so in its action log. */
export function foldShellEdits(st, names) {
    for (const basename of names) {
        st.editOrder.push(basename);
        st.editCounts.set(basename, (st.editCounts.get(basename) ?? 0) + 1);
    }
    if (names.length && st.recent.length) {
        const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ', ...' : '');
        const last = st.recent.length - 1;
        st.recent[last] = `${st.recent[last]}  [edits ${shown}]`;
    }
}
