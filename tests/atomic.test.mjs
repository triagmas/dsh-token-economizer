import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
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


test('does not reclaim a fresh unparseable lock', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-empty-lock-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  try {
    await writeFile(lockPath, '')
    let entered = false
    const attempt = withFileLock(target, async () => {
      entered = true
    }).then(
      () => 'acquired',
      (error) => error,
    )

    await sleep(300)
    const enteredEarly = entered
    const outcome = await attempt
    assert.equal(enteredEarly, false, 'fresh empty lock must not be treated as dead')
    assert.ok(outcome instanceof Error, 'second owner must time out instead of entering')

    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    await withFileLock(target, async () => {
      entered = true
    })
    assert.equal(entered, true, 'old unparseable lock is reclaimable')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('serializes stale-lock reclamation across contenders', { timeout: 30_000 }, async () => {
  const rounds = 5
  const contenders = 100
  let overlaps = 0
  let rejected = 0
  for (let round = 0; round < rounds; round++) {
    const dir = await mkdtemp(join(tmpdir(), 'te-reclaim-race-'))
    const target = join(dir, 'state.json')
    const lockPath = `${target}.lock`
    try {
      await writeFile(lockPath, '999999 0 old\n')
      const old = new Date(Date.now() - 60_000)
      await utimes(lockPath, old, old)
      let active = 0
      const tasks = Array.from({ length: contenders }, () =>
        withFileLock(target, async () => {
          active++
          if (active > 1) overlaps++
          await sleep(3)
          active--
        }),
      )
      const results = await Promise.allSettled(tasks)
      rejected += results.filter((result) => result.status === 'rejected').length
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  assert.equal(rejected, 0, 'every contender must eventually acquire the lock')
  assert.equal(overlaps, 0, 'stale-lock reclamation must not admit two owners')
})


test('ignores a reclaim intent left by a dead owner', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-dead-intent-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  const intentPath = `${lockPath}.reclaim.2147483647.dead`
  try {
    await writeFile(lockPath, '2147483647 0 old\n')
    // A SIGKILL leaves the intent behind; its PID no longer exists.
    await writeFile(intentPath, '2147483647 0 dead\n')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    let entered = false
    await withFileLock(target, async () => {
      entered = true
    })

    assert.equal(entered, true, 'a dead intent must not block or be resurrected')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ignores a legacy guard without deleting it', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-legacy-guard-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  const legacyGuard = `${lockPath}.reclaim`
  try {
    await writeFile(lockPath, '2147483647 0 old\n')
    // The previous protocol used this path. It is now inert, but must never be
    // deleted by recovery: a live old-version owner may still be using it.
    await writeFile(legacyGuard, '2147483647 0 dead\n')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    await utimes(legacyGuard, old, old)

    let entered = false
    await withFileLock(target, async () => {
      entered = true
    })

    assert.equal(entered, true, 'a dead legacy guard must not block')
    assert.equal(await readFile(legacyGuard, 'utf8'), '2147483647 0 dead\n', 'legacy guard must remain untouched')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('does not reclaim while an older live intent exists', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-live-intent-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  const intentPath = `${lockPath}.reclaim.${process.pid}.live`
  try {
    await writeFile(lockPath, '2147483647 0 old\n')
    const created = Date.now() - 60_000
    await writeFile(intentPath, `${process.pid} ${created} live\n`)
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    let entered = false
    const attempt = withFileLock(target, async () => {
      entered = true
    }).then(
      () => 'acquired',
      (error) => error,
    )
    await sleep(300)
    assert.equal(entered, false, 'a live older intent must block the newcomer')
    const outcome = await attempt
    assert.ok(outcome instanceof Error, 'the newcomer must time out')
    assert.equal(await readFile(intentPath, 'utf8'), `${process.pid} ${created} live\n`, 'a live intent must remain untouched')
    await unlink(intentPath)
    await withFileLock(target, async () => {
      entered = true
    })
    assert.equal(entered, true, 'removing the live intent must let the next owner in')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ignores a fresh empty intent but reclaims an old one', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-empty-intent-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  const intentPath = `${lockPath}.reclaim.999999.empty`
  try {
    await writeFile(lockPath, '2147483647 0 old\n')
    await writeFile(intentPath, '')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    let entered = false
    const attempt = withFileLock(target, async () => {
      entered = true
    }).then(
      () => 'acquired',
      (error) => error,
    )
    await sleep(300)
    assert.equal(entered, false, 'a fresh empty intent must block')
    const outcome = await attempt
    assert.ok(outcome instanceof Error, 'the newcomer must time out')

    await utimes(intentPath, old, old)
    await withFileLock(target, async () => {
      entered = true
    })
    assert.equal(entered, true, 'an old empty intent must be ignored')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ignores an old empty intent without admitting two owners', { timeout: 30_000 }, async () => {
  const rounds = 5
  const contenders = 100
  let overlaps = 0
  let rejected = 0
  for (let round = 0; round < rounds; round++) {
    const dir = await mkdtemp(join(tmpdir(), 'te-empty-intent-race-'))
    const target = join(dir, 'state.json')
    const lockPath = `${target}.lock`
    const intentPath = `${lockPath}.reclaim.999999.empty`
    try {
      await writeFile(lockPath, '2147483647 0 old\n')
      await writeFile(intentPath, '')
      const old = new Date(Date.now() - 60_000)
      await utimes(lockPath, old, old)
      await utimes(intentPath, old, old)
      let active = 0
      const tasks = Array.from({ length: contenders }, () =>
        withFileLock(target, async () => {
          active++
          if (active > 1) overlaps++
          await sleep(3)
          active--
        }),
      )
      const results = await Promise.allSettled(tasks)
      rejected += results.filter((result) => result.status === 'rejected').length
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  assert.equal(overlaps, 0, 'old-empty intent recovery must not admit two owners')
  assert.equal(rejected, 0, 'every contender must eventually acquire the lock')
})
