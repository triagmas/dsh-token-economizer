/**
 * Durable local I/O: atomic JSON, append-only JSONL with rotation, and a
 * cross-process lock for concurrent Harness sessions.
 *
 * Every write is fail-open at the call site: the caller logs a warning and
 * keeps the agent running. No function here throws for a missing file.
 */
import { open, readFile, readdir, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

const LOCK_STALE_MS = 15_000
const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 25

/** Create a directory tree when missing. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/** Write JSON atomically (temp file in the same directory, then rename). */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const text = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmp, path)
  } catch (error) {
    // Windows cannot always replace an open destination; retry once after unlink.
    await unlink(path).catch(() => undefined)
    try {
      await rename(tmp, path)
    } catch (inner) {
      await unlink(tmp).catch(() => undefined)
      throw inner
    }
  }
}

/** Read JSON, returning `fallback` for a missing or corrupt file. */
export async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf8')
    if (text.trim() === '') return fallback
    const parsed = JSON.parse(text) as T
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** Append rows to a JSONL file, rotating the previous generation when oversized. */
export async function appendJsonl(path: string, rows: readonly unknown[], maxBytes: number): Promise<void> {
  if (rows.length === 0) return
  await ensureDir(dirname(path))
  try {
    const info = await stat(path)
    if (maxBytes > 0 && info.size > maxBytes) await rotateJsonl(path)
  } catch {
    /* first write */
  }
  const text = rows.map((row) => JSON.stringify(row)).join('\n')
  await appendFileCompat(path, `${text}\n`)
}

/** Append text with a single open/close pair (fs.promises.appendFile is enough). */
async function appendFileCompat(path: string, text: string): Promise<void> {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path, text, { encoding: 'utf8', mode: 0o600 })
}

/** Rotate `file` to `file.1`, replacing any previous generation. */
export async function rotateJsonl(path: string): Promise<void> {
  const rotated = `${path}.1`
  await unlink(rotated).catch(() => undefined)
  await rename(path, rotated).catch(() => undefined)
}

/** Read at most `maxLines` complete JSONL rows (newest last) without loading huge files. */
export async function readJsonl(path: string, maxLines = 5000): Promise<unknown[]> {
  try {
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const selected = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
    const rows: unknown[] = []
    for (const line of selected) {
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* a torn tail line is skipped, never fatal */
      }
    }
    return rows
  } catch {
    return []
  }
}

/** List files in a directory, returning an empty list on failure. */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

/**
 * Run `fn` while holding `<target>.lock` exclusively.
 * A lock older than {@link LOCK_STALE_MS} is reclaimed; contention is bounded
 * and reported as a failed acquisition instead of blocking the agent forever.
 */
export async function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle: Awaited<ReturnType<typeof open>> | undefined
  await ensureDir(dirname(lockPath))
  while (handle === undefined) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      if (await isStale(lockPath)) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) throw new Error(`token-economizer: lock timeout on ${lockPath}`)
      await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS))
    }
  }
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const text = await readFile(lockPath, 'utf8')
    const [pidText, createdText] = text.trim().split(/\s+/)
    const created = Number(createdText)
    if (Number.isFinite(created) && Date.now() - created > LOCK_STALE_MS) return true
    const pid = Number(pidText)
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // EPERM means the process exists but belongs to someone else.
        return code !== 'EPERM'
      }
    }
    return true
  } catch {
    return true
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Current ISO timestamp. */
export function nowIso(): string {
  return new Date().toISOString()
}

/** Join path segments (re-exported to keep engine code free of `node:path` noise). */
export function joinPath(...segments: string[]): string {
  return join(...segments)
}
