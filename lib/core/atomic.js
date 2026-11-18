/**
 * Durable local I/O: atomic JSON, append-only JSONL with rotation, and a
 * cross-process lock for concurrent Harness sessions.
 *
 * Every write is fail-open at the call site: the caller logs a warning and
 * keeps the agent running. No function here throws for a missing file.
 */
import { appendFile, open, readFile, readdir, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const RECLAIM_RECORD_TTL_MS = LOCK_STALE_MS * 4;
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
 * Reclaim a stale lock through an append-only election log. Every contender
 * appends one record and, when it stops participating, one completion marker.
 * The first record in the log whose owner is still alive is the only contender
 * allowed to remove the stale main lock. A dead record is ignored rather than
 * deleted, so recovery never unlinks a path that another process may reuse.
 *
 * O_APPEND gives the log a total order: a record appended later is always after
 * an earlier record, even when filesystem timestamps collide. The log is never
 * truncated or rotated because removing a live owner's record would admit a
 * second owner. Entries are small and stale reclamation is rare.
 */
async function reclaimStaleLock(lockPath) {
    const token = randomBytes(8).toString('hex');
    const logPath = `${lockPath}.reclaim.log`;
    // The leading newline isolates a partial tail left by a crash. Records carry
    // a kind and a terminator, so an incomplete record is never reinterpreted as
    // a completed one.
    const identity = (await processStartIdentity(process.pid)) ?? '-';
    await appendFile(logPath, `\nR ${process.pid} ${identity} ${Date.now()} ${token} ok\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    try {
        if ((await firstLiveReclaimToken(logPath)) !== token)
            return false;
        // Re-check under the election: another owner may have replaced the lock
        // between the caller's isStale() call and this point.
        if (await isStale(lockPath))
            await unlink(lockPath).catch(() => undefined);
        return true;
    }
    finally {
        // A completion marker lets the next contender proceed. If this process
        // dies instead, the record is ignored once its PID is gone.
        await appendFile(logPath, `\nD ${process.pid} ${identity} ${Date.now()} ${token} ok\n`, {
            encoding: 'utf8',
            mode: 0o600,
        }).catch(() => undefined);
    }
}
/** First live, unfinished record in append order. */
async function firstLiveReclaimToken(logPath) {
    let text;
    try {
        text = await readFile(logPath, 'utf8');
    }
    catch {
        return undefined;
    }
    const lines = text.split('\n');
    // Ignore a partial tail left by a crash or an interrupted append.
    if (lines[lines.length - 1] !== '')
        lines.pop();
    const records = [];
    const finished = new Set();
    for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        // R/D <pid> <starttime> <createdAt> <token> ok
        if (fields.length !== 6 || fields[5] !== 'ok')
            continue;
        const token = fields[4];
        if (fields[0] === 'D') {
            finished.add(token);
            continue;
        }
        if (fields[0] !== 'R')
            continue;
        const pid = Number(fields[1]);
        const createdAt = Number(fields[3]);
        if (Number.isFinite(pid) && pid > 0) {
            records.push({ pid, identity: fields[2], createdAt, token });
        }
    }
    for (const record of records) {
        if (finished.has(record.token))
            continue;
        if (!isProcessAlive(record.pid))
            continue;
        if (record.identity !== '-') {
            const currentIdentity = await processStartIdentity(record.pid);
            // A reused PID has a different start time. If /proc is momentarily
            // unavailable, keep the conservative PID-based answer.
            if (currentIdentity !== undefined && currentIdentity !== record.identity)
                continue;
        }
        else if (Number.isFinite(record.createdAt) &&
            Date.now() - record.createdAt > RECLAIM_RECORD_TTL_MS) {
            // Without /proc there is no process-start identity. Bound the block so a
            // reused PID cannot hold the log forever; the TTL is four stale windows.
            continue;
        }
        return record.token;
    }
    return undefined;
}
/**
 * Linux process start time in clock ticks since boot. Together with the PID it
 * identifies an incarnation, so a reused PID does not inherit an old record.
 * Returns undefined on platforms without /proc.
 */
async function processStartIdentity(pid) {
    try {
        const text = await readFile(`/proc/${pid}/stat`, 'utf8');
        const close = text.lastIndexOf(')');
        if (close < 0)
            return undefined;
        // Fields after comm: field 3 is index 0, so starttime (field 22) is 19.
        const value = text.slice(close + 2).trim().split(/\s+/)[19];
        return value && /^\d+$/.test(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the process exists but belongs to someone else.
        return error.code === 'EPERM';
    }
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
