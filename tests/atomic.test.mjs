import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { withFileLock } from '../lib/core/atomic.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(20)
  }
}

test('withFileLock does not steal a live lock after the stale age', { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-lock-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  try {
    let aStarted = false
    let aEndedAt = 0
    let bEnteredAt = 0

    const a = withFileLock(target, async () => {
      aStarted = true
      await sleep(16_000)
      aEndedAt = Date.now()
    })
    await waitFor(() => aStarted, 5_000, 'the first lock holder')

    // The second owner starts trying 15.2s later, while the first is still alive.
    const b = (async () => {
      await sleep(15_200)
      return withFileLock(target, async () => {
        bEnteredAt = Date.now()
        await sleep(2_000)
      })
    })()

    // Wait for the first owner to release, then let its finally run. If the
    // second owner entered earlier, the first owner's release must not unlink
    // the second owner's lock.
    await waitFor(() => aEndedAt > 0, 20_000, 'the first lock holder to release')
    await waitFor(() => bEnteredAt > 0, 5_000, 'the second lock owner')
    await sleep(150)
    let lockPresent = true
    try {
      await readFile(lockPath, 'utf8')
    } catch {
      lockPresent = false
    }

    const results = await Promise.allSettled([a, b])
    assert.equal(results[1].status, 'fulfilled', 'second owner must acquire after the first releases')
    assert.ok(bEnteredAt > 0, 'second owner entered its callback')
    assert.deepEqual(
      { enteredWhileAlive: bEnteredAt < aEndedAt, lockPresent },
      { enteredWhileAlive: false, lockPresent: true },
      'the first owner must neither be evicted nor unlink the second owner lock',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
