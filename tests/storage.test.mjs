import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Store, SCHEMA_VERSION } from '../lib/storage/store.js'
import { projectIdForRoot } from '../lib/core/paths.js'

async function workspace() {
  return mkdtemp(join(tmpdir(), 'te-store-'))
}

test('store opens once and preserves install metadata across opens', async () => {
  const root = await workspace()
  try {
    const env = { DSH_HOME: root }
    const first = new Store(env)
    const install = await first.open('0.1.0', '0.2.2')
    assert.equal(install.schemaVersion, SCHEMA_VERSION)
    assert.equal(install.pluginVersion, '0.1.0')
    assert.equal(install.lastSeenDshVersion, '0.2.2')
    const installedAt = install.installedAt

    const second = new Store(env)
    const again = await second.open('0.2.0', '0.2.3')
    assert.equal(again.installedAt, installedAt, 'reinstall keeps installedAt')
    assert.equal(again.pluginVersion, '0.1.0', 'existing install record is not overwritten by version bump')
    assert.equal(again.lastSeenDshVersion, '0.2.3')
    assert.ok(existsSync(join(root, 'token-economizer', 'install.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project store persists skills and tools atomically and isolates projects', async () => {
  const root = await workspace()
  try {
    const store = new Store({ DSH_HOME: root })
    await store.open('0.1.0', '0.2.2')
    const projectRoot = join(root, 'work', 'alpha')
    await mkdir(projectRoot, { recursive: true })
    const project = await store.project(projectRoot)
    assert.equal(project.meta.root, projectRoot)
    assert.equal(project.meta.projectId, projectIdForRoot(projectRoot))

    await project.updateSkills((file) => {
      file.facts.push({
        id: 'fact-1',
        key: 'package-manager:pnpm',
        kind: 'env',
        text: 'Use pnpm in this repository.',
        high: false,
        drift: false,
        state: 'CANDIDATE',
        confirms: [[1, []]],
        contradicts: [],
        fireNum: 0,
        fireDen: 0,
        promotedAt: null,
        retiredAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: null,
        enabled: true,
        source: { sessionId: 'session-1', turn: 1, evidence: ['observed pnpm usage'] },
      })
      file.taskIndex = 1
    })
    const reloaded = await new Store({ DSH_HOME: root }).project(projectRoot)
    const skills = await reloaded.loadSkills()
    assert.equal(skills.facts.length, 1)
    assert.equal(skills.facts[0].text, 'Use pnpm in this repository.')
    assert.equal(skills.taskIndex, 1)

    const otherRoot = join(root, 'work', 'beta')
    await mkdir(otherRoot, { recursive: true })
    const other = await store.project(otherRoot)
    assert.notEqual(other.meta.projectId, project.meta.projectId)
    assert.equal((await other.loadSkills()).facts.length, 0, 'projects do not share facts')

    const parsed = JSON.parse(await readFile(join(project.dir, 'skills.json'), 'utf8'))
    assert.equal(parsed.schemaVersion, SCHEMA_VERSION)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy tool rows migrate session evidence to prompts, while explicit zero stays zero', async () => {
  const root = await workspace()
  try {
    const store = new Store({ DSH_HOME: root })
    await store.open('0.1.0', '0.2.2')
    const projectRoot = join(root, 'work', 'legacy')
    await mkdir(projectRoot, { recursive: true })
    const project = await store.project(projectRoot)
    await writeFile(
      join(project.dir, 'tools.json'),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        tools: {
          legacy_tool: { name: 'legacy_tool', calls: 0, unusedSessions: 4 },
          autonomous_tool: { name: 'autonomous_tool', calls: 0, unusedSessions: 3, unusedPrompts: 0 },
        },
        pruned: [],
        lastAuditTask: -1,
        updatedAt: null,
      }),
    )

    const tools = await project.loadTools()
    assert.equal(tools.tools.legacy_tool.unusedPrompts, 4, 'pre-counter rows keep their session evidence')
    assert.equal(tools.tools.autonomous_tool.unusedPrompts, 0, 'an explicit counter is authoritative')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a newer schema fails closed instead of discarding data', async () => {
  const root = await workspace()
  try {
    const store = new Store({ DSH_HOME: root })
    await store.open('0.1.0', '0.2.2')
    const projectRoot = join(root, 'work', 'gamma')
    await mkdir(projectRoot, { recursive: true })
    const project = await store.project(projectRoot)
    await writeFile(
      join(project.dir, 'skills.json'),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, taskIndex: 0, facts: [], updatedAt: null }),
    )
    const fresh = await new Store({ DSH_HOME: root }).project(projectRoot)
    await assert.rejects(() => fresh.loadSkills(), /newer than supported/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('metrics and loop rows append and read back in order, with rotation', async () => {
  const root = await workspace()
  try {
    const store = new Store({ DSH_HOME: root })
    await store.open('0.1.0', '0.2.2')
    const projectRoot = join(root, 'work', 'delta')
    await mkdir(projectRoot, { recursive: true })
    const project = await store.project(projectRoot)

    for (let index = 0; index < 5; index += 1) {
      await project.appendMetric({
        schemaVersion: SCHEMA_VERSION,
        at: `2026-01-01T00:00:0${index}.000Z`,
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        delegationDepth: 0,
        isSubagent: false,
        projectId: project.meta.projectId,
        kind: 'model',
        model: 'deepseek-v4',
        provider: 'deepseek',
        usage: { inputTokens: index, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: index + 1 },
      })
    }
    const rows = await project.readMetrics()
    assert.equal(rows.length, 5)
    assert.equal(rows[4].usage?.inputTokens, 4)

    await project.appendLoop({
      id: 'loop-1',
      at: '2026-01-01T00:01:00.000Z',
      agentId: 'session-1',
      sessionId: 'session-1',
      rootSessionId: 'session-1',
      projectId: project.meta.projectId,
      kind: 'stagnation',
      repeats: 3,
      turn: 3,
      step: 2,
      judge: 'not-run',
      confidence: null,
      intervention: 'none',
      nudge: null,
      outcome: 'unknown',
      detail: { reason: 'test' },
    })

    const loops = await project.readLoops()
    assert.equal(loops.length, 1)
    assert.equal(loops[0].id, 'loop-1')
    assert.ok(existsSync(project.metricsPath))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('maintenance compacts metrics to one JSON object per line', async () => {
  const root = await workspace()
  try {
    const store = new Store({ DSH_HOME: root })
    await store.open('0.1.0', '0.2.2')
    const projectRoot = join(root, 'work', 'compact')
    await mkdir(projectRoot, { recursive: true })
    const project = await store.project(projectRoot)
    const oldAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const newAt = new Date().toISOString()
    await project.appendMetrics([
      { schemaVersion: SCHEMA_VERSION, at: oldAt, kind: 'model' },
      { schemaVersion: SCHEMA_VERSION, at: oldAt, kind: 'tool' },
      { schemaVersion: SCHEMA_VERSION, at: newAt, kind: 'turn-end' },
    ], 0)

    await project.maintenance(1, 1_000_000)

    const rows = await project.readMetrics()
    assert.deepEqual(rows.map((row) => row.kind), ['turn-end'], 'old rows are retained only in the rotated file')
    const text = await readFile(project.metricsPath, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    assert.equal(lines.length, 1, 'compacted file is JSONL, not a pretty-printed array')
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
    assert.equal(existsSync(`${project.metricsPath}.compact`), false, 'no .compact file is left behind')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('maintenance leaves an all-recent metrics file byte-for-byte unchanged', async () => {
  const root = await workspace()
  try {
    const store = new Store({ DSH_HOME: root })
    await store.open('0.1.0', '0.2.2')
    const projectRoot = join(root, 'work', 'recent')
    await mkdir(projectRoot, { recursive: true })
    const project = await store.project(projectRoot)
    const at = new Date().toISOString()
    await project.appendMetrics([
      { schemaVersion: SCHEMA_VERSION, at, kind: 'model' },
      { schemaVersion: SCHEMA_VERSION, at, kind: 'turn-end' },
    ], 0)
    const before = await readFile(project.metricsPath, 'utf8')

    await project.maintenance(30, 1_000_000)

    const after = await readFile(project.metricsPath, 'utf8')
    assert.equal(after, before, 'no rewrite when nothing expired')
    assert.equal((await project.readMetrics()).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('metrics can be appended after a JSONL compaction', async () => {
  const root = await workspace()
  try {
    const store = new Store({ DSH_HOME: root })
    await store.open('0.1.0', '0.2.2')
    const projectRoot = join(root, 'work', 'append-after')
    await mkdir(projectRoot, { recursive: true })
    const project = await store.project(projectRoot)
    const oldAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const newAt = new Date().toISOString()
    await project.appendMetrics([
      { schemaVersion: SCHEMA_VERSION, at: oldAt, kind: 'model' },
      { schemaVersion: SCHEMA_VERSION, at: newAt, kind: 'turn-end' },
    ], 0)
    await project.maintenance(1, 1_000_000)

    await project.appendMetric({ schemaVersion: SCHEMA_VERSION, at: new Date().toISOString(), kind: 'tool' }, 0)

    const rows = await project.readMetrics()
    assert.deepEqual(rows.map((row) => row.kind), ['turn-end', 'tool'])
    const lines = (await readFile(project.metricsPath, 'utf8')).split('\n').filter((line) => line.trim() !== '')
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('clearLoops writes an empty JSONL file, not a JSON array', async () => {
  const root = await workspace()
  try {
    const store = new Store({ DSH_HOME: root })
    await store.open('0.1.0', '0.2.2')
    const projectRoot = join(root, 'work', 'clear-loops')
    await mkdir(projectRoot, { recursive: true })
    const project = await store.project(projectRoot)
    await project.appendLoop({
      id: 'loop-clear', at: new Date().toISOString(), agentId: 's', sessionId: 's', rootSessionId: 's',
      projectId: project.meta.projectId, kind: 'stagnation', repeats: 1, turn: 1, step: 1,
      judge: 'not-run', confidence: null, intervention: 'none', nudge: null, outcome: 'unknown', detail: {},
    }, 0)

    await project.clearLoops()

    assert.equal(await readFile(project.loopsPath, 'utf8'), '')
    assert.deepEqual(await project.readLoops(), [])
    await project.appendLoop({
      id: 'loop-after', at: new Date().toISOString(), agentId: 's', sessionId: 's', rootSessionId: 's',
      projectId: project.meta.projectId, kind: 'stagnation', repeats: 1, turn: 2, step: 2,
      judge: 'not-run', confidence: null, intervention: 'none', nudge: null, outcome: 'unknown', detail: {},
    }, 0)
    assert.equal((await project.readLoops()).length, 1, 'the empty file is still appendable JSONL')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
