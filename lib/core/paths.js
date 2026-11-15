/**
 * Local filesystem layout and project identity.
 *
 * All plugin data lives under `<DSH_HOME>/token-economizer`; nothing is written
 * into the user's repository unless the user explicitly exports it. Project
 * identity is derived from the canonical workspace root, never from a display
 * name, so two checkouts with the same basename cannot share knowledge.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
/** Resolve the DeepSeek Harness home using the documented precedence. */
export function resolveDshHome(env = process.env) {
    const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
    if (configured)
        return resolve(expandTilde(configured));
    return join(homedir(), '.dsh');
}
/** Expand a leading `~` using the operating-system home directory. */
export function expandTilde(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return join(homedir(), path.slice(2));
    return path;
}
/** Root data directory for this plugin. */
export function dataRoot(env = process.env) {
    return join(resolveDshHome(env), 'token-economizer');
}
/** Directory holding one project's store. */
export function projectDir(projectId, env = process.env) {
    return join(dataRoot(env), 'projects', projectId);
}
/** Plugin-wide error log (secrets redacted before the write). */
export function errorLogPath(env = process.env) {
    return join(dataRoot(env), 'errors.log');
}
/** Stable, collision-resistant identity for a workspace root. */
export function projectIdForRoot(root) {
    const canonical = canonicalPath(root);
    const slug = basename(canonical)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    return `${slug || 'project'}-${digest}`;
}
/** Canonicalize an existing path; fall back to a resolved absolute path. */
export function canonicalPath(path) {
    const absolute = resolve(expandTilde(path));
    try {
        return realpathSync.native(absolute);
    }
    catch {
        return absolute;
    }
}
/**
 * Find the repository root above a working directory.
 * A `.git` directory or file (worktree/submodule) marks the root. Without Git
 * the workspace directory itself is the root, so non-Git projects work too.
 */
export function findRepoRoot(cwd) {
    const start = canonicalPath(cwd);
    let current = start;
    for (let depth = 0; depth < 64; depth += 1) {
        const dotGit = join(current, '.git');
        if (existsSync(dotGit)) {
            try {
                const stat = statSync(dotGit);
                if (stat.isDirectory())
                    return { root: current, git: true, gitCommonDir: dotGit };
                if (stat.isFile()) {
                    // `gitdir: /path/to/common-dir` for worktrees and submodules.
                    return { root: current, git: true };
                }
            }
            catch {
                /* unreadable .git falls through to the workspace root */
            }
        }
        const parent = dirname(current);
        if (parent === current || parent.endsWith(`${sep}`) === false && parent === '')
            break;
        if (parent === current)
            break;
        current = parent;
    }
    return { root: start, git: false };
}
/** True when `child` is inside `parent` (both canonical). */
export function isInside(parent, child) {
    const p = canonicalPath(parent);
    const c = canonicalPath(child);
    return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}
/** Resolve an absolute path, rejecting relative or empty input. */
export function requireAbsolute(path) {
    if (typeof path !== 'string' || path.trim() === '')
        return undefined;
    return isAbsolute(path) ? path : undefined;
}
