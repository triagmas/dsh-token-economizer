/**
 * Durable local I/O: atomic JSON, append-only JSONL with rotation, and a
 * cross-process lock for concurrent Harness sessions.
 *
 * Every write is fail-open at the call site: the caller logs a warning and
 * keeps the agent running. No function here throws for a missing file.
 */
import { link, open, readFile, readdir, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
/** Create a directory tree when missing. */
export async function ensureDir(path) {
    await mkdir(path, { recursive: true });
}
/** Write JSON atomically (temp file in the same directory, then rename). */
export async function writeJsonAtomic(path, value) {
    await ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    try {
        await rename(tmp, path);
    }
    catch (error) {
        // Windows cannot always replace an open destination; retry once after unlink.
        await unlink(path).catch(() => undefined);
        try {
            await rename(tmp, path);
        }
        catch (inner) {
            await unlink(tmp).catch(() => undefined);
            throw inner;
        }
    }
}
/**
 * Write JSONL atomically: one JSON object per line, or an empty file for no rows.
 * Compaction must never leave a pretty-printed JSON array in a `.jsonl` file.
 */
export async function writeJsonlAtomic(path, rows) {
    await ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const text = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    try {
        await rename(tmp, path);
    }
    catch (error) {
        // Windows cannot always replace an open destination; retry once after unlink.
        await unlink(path).catch(() => undefined);
        try {
            await rename(tmp, path);
        }
        catch (inner) {
            await unlink(tmp).catch(() => undefined);
            throw inner;
        }
    }
}
/**
 * Move an unreadable JSON file aside before any later save replaces it.
 *
 * The caller still gets its defaults, so a damaged file never blocks the agent,
 * but the original bytes remain available for inspection. Failure to move the
 * file is ignored: quarantine is evidence preservation, not a precondition.
 */
async function quarantineCorrupt(path) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${path}.corrupt-${stamp}`;
    try {
        await rename(path, target);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        // A same-millisecond collision should not leave the corrupt file in place.
        await rename(path, `${target}-${process.pid}`).catch(() => undefined);
    }
}
/** Read JSON, returning `fallback` for a missing file or after quarantining a corrupt one. */
export async function readJsonSafe(path, fallback) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch {
        return fallback;
    }
    if (text.trim() === '') {
        await quarantineCorrupt(path);
        return fallback;
    }
    try {
        const parsed = JSON.parse(text);
        return parsed ?? fallback;
    }
    catch {
        await quarantineCorrupt(path);
        return fallback;
    }
}
/** Append rows to a JSONL file, rotating the previous generation when oversized. */
export async function appendJsonl(path, rows, maxBytes) {
    if (rows.length === 0)
        return;
    await ensureDir(dirname(path));
    try {
        const info = await stat(path);
        if (maxBytes > 0 && info.size > maxBytes)
            await rotateJsonl(path);
    }
    catch {
        /* first write */
    }
    const text = rows.map((row) => JSON.stringify(row)).join('\n');
    await appendFileCompat(path, `${text}\n`);
}
/** Append text with a single open/close pair (fs.promises.appendFile is enough). */
async function appendFileCompat(path, text) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, text, { encoding: 'utf8', mode: 0o600 });
}
/** Rotate `file` to `file.1`, replacing any previous generation. */
export async function rotateJsonl(path) {
    const rotated = `${path}.1`;
    await unlink(rotated).catch(() => undefined);
    await rename(path, rotated).catch(() => undefined);
}
/** Read at most `maxLines` complete JSONL rows (newest last) without loading huge files. */
export async function readJsonl(path, maxLines = 5000) {
    try {
        const text = await readFile(path, 'utf8');
        const lines = text.split('\n').filter((line) => line.trim() !== '');
        const selected = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
        const rows = [];
        for (const line of selected) {
            try {
                rows.push(JSON.parse(line));
            }
            catch {
                /* a torn tail line is skipped, never fatal */
            }
        }
        return rows;
    }
    catch {
        return [];
    }
}
/** List files in a directory, returning an empty list on failure. */
export async function listFiles(dir) {
    try {
        return (await readdir(dir)).sort();
    }
    catch {
        return [];
    }
}
/**
 * Run `fn` while holding `<target>.lock` exclusively.
 *
 * A lock is reclaimed only when its owner is gone (or when an unparseable lock
 * is old enough); a live process is never evicted just because it holds the
 * lock for a long time. The lock file carries a per-acquisition token so the
 * releasing owner cannot unlink a successor's lock.
 */
export async function withFileLock(target, fn) {
    const lockPath = `${target}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const token = randomBytes(8).toString('hex');
    let handle;
    await ensureDir(dirname(lockPath));
    while (handle === undefined) {
        try {
            handle = await open(lockPath, 'wx', 0o600);
            await handle.writeFile(`${process.pid} ${Date.now()} ${token}\n`, 'utf8');
        }
        catch (error) {
            const code = error.code;
            if (code !== 'EEXIST')
                throw error;
            if (await isStale(lockPath)) {
                if (!(await reclaimStaleLock(lockPath))) {
                    if (Date.now() >= deadline)
                        throw new Error(`token-economizer: lock timeout on ${lockPath}`);
                    await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
                }
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`token-economizer: lock timeout on ${lockPath}`);
            await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
        }
    }
    try {
        return await fn();
    }
    finally {
        await handle.close().catch(() => undefined);
        try {
            const current = await readFile(lockPath, 'utf8');
            if (current.trim().split(/\s+/)[2] === token)
                await unlink(lockPath).catch(() => undefined);
        }
        catch {
            // Another process already reclaimed or removed the lock.
        }
    }
}
/**
 * Reclaim a stale lock with a per-contender intent file. Each contender writes
 * an immutable, uniquely named record; the live record with the oldest
 * creation time is the only one allowed to remove the stale main lock. A dead
 * intent is ignored rather than deleted, so recovery never has to unlink a
 * path that another live process may have reused.
 *
 * The election order is the intent's filesystem `ctimeNs`, captured after the
 * hard link is made: a record linked later sorts after one linked earlier,
 * even within the same millisecond. The temporary file is kept until the intent
 * is removed, because unlinking it would change the inode's ctime.
 */
async function reclaimStaleLock(lockPath) {
    const intent = await createReclaimIntent(lockPath);
    if (intent === undefined)
        return false;
    try {
        const intents = await listLiveReclaimIntents(lockPath);
        if (intents[0]?.path !== intent.path)
            return false;
        // Re-check under the election: another owner may have replaced the lock
        // between the caller's isStale() call and this point.
        if (await isStale(lockPath))
            await unlink(lockPath).catch(() => undefined);
        return true;
    }
    finally {
        await removeReclaimIntent(intent);
    }
}
/** Create an immutable intent with a complete record; no empty write window. */
async function createReclaimIntent(lockPath) {
    const token = randomBytes(8).toString('hex');
    const path = `${lockPath}.reclaim.${process.pid}.${token}`;
    const tempPath = `${path}.tmp`;
    const createdAt = Date.now();
    try {
        await writeFile(tempPath, `${process.pid} ${createdAt} ${token}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        try {
            await link(tempPath, path);
        }
        catch (error) {
            await unlink(tempPath).catch(() => undefined);
            if (error.code !== 'EEXIST')
                throw error;
            return undefined;
        }
    }
    catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
    }
    let createdAtNs = 0n;
    try {
        createdAtNs = (await stat(path, { bigint: true })).ctimeNs;
    }
    catch {
        // Fall back below; the intent is already published.
    }
    if (createdAtNs <= 0n)
        createdAtNs = BigInt(createdAt) * 1000000n;
    return { path, tempPath, pid: process.pid, createdAtNs, token };
}
async function removeReclaimIntent(intent) {
    try {
        const current = await readFile(intent.path, 'utf8');
        if (current.trim().split(/\s+/)[2] === intent.token)
            await unlink(intent.path).catch(() => undefined);
    }
    catch {
        // Already gone; unique names have no replacement to protect.
    }
    finally {
        // Removing the temp link only after the intent is gone keeps its ctime
        // stable while it participates in elections.
        await unlink(intent.tempPath).catch(() => undefined);
    }
}
/** Live intents ordered oldest first; dead and unparseable-old records are ignored. */
async function listLiveReclaimIntents(lockPath) {
    const dir = dirname(lockPath);
    const prefix = `${basename(lockPath)}.reclaim.`;
    let names;
    try {
        names = await readdir(dir);
    }
    catch {
        return [];
    }
    const intents = await Promise.all(names
        .filter((name) => name.startsWith(prefix) && !name.endsWith('.tmp'))
        .map(async (name) => {
        const path = join(dir, name);
        let text;
        try {
            text = await readFile(path, 'utf8');
        }
        catch {
            return undefined;
        }
        const [pidText, createdText, tokenText] = text.trim().split(/\s+/);
        const pid = Number(pidText);
        const token = tokenText ?? name;
        let createdAtNs = 0n;
        try {
            createdAtNs = (await stat(path, { bigint: true })).ctimeNs;
        }
        catch {
            return undefined;
        }
        if (createdAtNs <= 0n) {
            const contentCreatedAt = Number(createdText);
            if (!Number.isFinite(contentCreatedAt) || contentCreatedAt <= 0) {
                try {
                    createdAtNs = BigInt(Math.round((await stat(path)).mtimeMs)) * 1000000n;
                }
                catch {
                    return undefined;
                }
            }
            else {
                createdAtNs = BigInt(contentCreatedAt) * 1000000n;
            }
        }
        let live = false;
        if (Number.isFinite(pid) && pid > 0) {
            try {
                process.kill(pid, 0);
                live = true;
            }
            catch (error) {
                // EPERM means the process exists but belongs to someone else.
                live = error.code === 'EPERM';
            }
        }
        else {
            try {
                const info = await stat(path);
                live = Date.now() - info.mtimeMs <= LOCK_STALE_MS;
            }
            catch {
                return undefined;
            }
        }
        if (!live)
            return undefined;
        return { path, tempPath: `${path}.tmp`, pid: Number.isFinite(pid) ? pid : 0, createdAtNs, token };
    }));
    return intents
        .filter((intent) => intent !== undefined)
        .sort((a, b) => {
        if (a.createdAtNs < b.createdAtNs)
            return -1;
        if (a.createdAtNs > b.createdAtNs)
            return 1;
        return a.token.localeCompare(b.token) || a.pid - b.pid;
    });
}
async function isStale(lockPath) {
    try {
        const text = await readFile(lockPath, 'utf8');
        const pidText = text.trim().split(/\s+/)[0];
        const pid = Number(pidText);
        if (Number.isFinite(pid) && pid > 0) {
            try {
                process.kill(pid, 0);
                return false;
            }
            catch (error) {
                const code = error.code;
                // EPERM means the process exists but belongs to someone else.
                if (code === 'EPERM')
                    return false;
                // The owner is gone; its lock can be reclaimed immediately.
                return true;
            }
        }
        // A freshly opened lock is empty for a moment before its owner writes the
        // PID. Treat an unparseable lock as stale only after the mtime threshold.
        const info = await stat(lockPath);
        return Date.now() - info.mtimeMs > LOCK_STALE_MS;
    }
    catch {
        // A missing lock is not stale evidence: another contender may have
        // removed it and already created a replacement. Treat it as "retry".
        return false;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Current ISO timestamp. */
export function nowIso() {
    return new Date().toISOString();
}
/** Join path segments (re-exported to keep engine code free of `node:path` noise). */
export function joinPath(...segments) {
    return join(...segments);
}
