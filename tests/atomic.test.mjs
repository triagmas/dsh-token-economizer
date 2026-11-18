import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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


test('recovers a reclaim guard left by a dead owner', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-dead-guard-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  const guardPath = `${lockPath}.reclaim`
  try {
    await writeFile(lockPath, '2147483647 0 old\n')
    // A SIGKILL between guard creation and cleanup leaves exactly this:
    // a guard naming a PID that no longer exists.
    await writeFile(guardPath, '2147483647 0 dead\n')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    let entered = false
    await withFileLock(target, async () => {
      entered = true
    })

    assert.equal(entered, true, 'the next owner must recover a dead guard')
    await assert.rejects(access(guardPath), 'the recovered guard must be gone')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recovers an empty reclaim guard after the stale age', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-empty-guard-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  const guardPath = `${lockPath}.reclaim`
  try {
    await writeFile(lockPath, '2147483647 0 old\n')
    await writeFile(guardPath, '')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    await utimes(guardPath, old, old)

    let entered = false
    await withFileLock(target, async () => {
      entered = true
    })

    assert.equal(entered, true, 'an old unparseable guard must be recoverable')
    await assert.rejects(access(guardPath), 'the recovered guard must be gone')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('does not reclaim a fresh empty guard', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-fresh-guard-'))
  const target = join(dir, 'state.json')
  const lockPath = `${target}.lock`
  const guardPath = `${lockPath}.reclaim`
  try {
    await writeFile(lockPath, '2147483647 0 old\n')
    await writeFile(guardPath, '')
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
    const enteredEarly = entered
    const outcome = await attempt
    assert.equal(enteredEarly, false, 'a fresh guard must not be recovered')
    assert.ok(outcome instanceof Error, 'the contender must time out')
    assert.equal(await readFile(guardPath, 'utf8'), '', 'the guard must stay in place')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('recovers a dead guard without admitting two owners', { timeout: 30_000 }, async () => {
  const rounds = 5
  const contenders = 100
  let overlaps = 0
  let rejected = 0
  for (let round = 0; round < rounds; round++) {
    const dir = await mkdtemp(join(tmpdir(), 'te-dead-guard-race-'))
    const target = join(dir, 'state.json')
    const lockPath = `${target}.lock`
    try {
      await writeFile(lockPath, '2147483647 0 old\n')
      await writeFile(`${lockPath}.reclaim`, '2147483647 0 dead\n')
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
  assert.equal(overlaps, 0, 'dead-guard recovery must not admit two owners')
  assert.equal(rejected, 0, 'every contender must eventually acquire the lock')
})


test('recovers an old empty guard without admitting two owners', { timeout: 30_000 }, async () => {
  const rounds = 5
  const contenders = 100
  let overlaps = 0
  let rejected = 0
  for (let round = 0; round < rounds; round++) {
    const dir = await mkdtemp(join(tmpdir(), 'te-empty-guard-race-'))
    const target = join(dir, 'state.json')
    const lockPath = `${target}.lock`
    const guardPath = `${lockPath}.reclaim`
    try {
      await writeFile(lockPath, '2147483647 0 old\n')
      await writeFile(guardPath, '')
      const old = new Date(Date.now() - 60_000)
      await utimes(lockPath, old, old)
      await utimes(guardPath, old, old)
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
  assert.equal(overlaps, 0, 'old-empty-guard recovery must not admit two owners')
  assert.equal(rejected, 0, 'every contender must eventually acquire the lock')
})
