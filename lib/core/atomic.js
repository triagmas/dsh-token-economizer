/**
 * Durable local I/O: atomic JSON, append-only JSONL with rotation, and a
 * cross-process lock for concurrent Harness sessions.
 *
 * Every write is fail-open at the call site: the caller logs a warning and
 * keeps the agent running. No function here throws for a missing file.
 */
import { open, readFile, readdir, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
                await unlink(lockPath).catch(() => undefined);
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
async function isStale(lockPath) {
    try {
        const text = await readFile(lockPath, 'utf8');
        const [pidText, createdText] = text.trim().split(/\s+/);
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
        const created = Number(createdText);
        return !Number.isFinite(created) || Date.now() - created > LOCK_STALE_MS;
    }
    catch {
        return true;
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
