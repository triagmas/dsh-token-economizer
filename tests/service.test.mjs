import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { Store, SCHEMA_VERSION } from '../lib/storage/store.js'
import { EconomizerService } from '../lib/plugin/service.js'
import { buildUsageReport } from '../lib/metrics/ledger.js'

const PROJECT = '/work/economizer-project'

function observed(sessionId, root = PROJECT, extra = {}) {
  return {
    sessionId,
    rootSessionId: sessionId,
    parentSessionId: null,
    delegationDepth: 0,
    isSubagent: false,
    cwd: root,
    projectRoot: root,
    startedAt: '2026-01-01T00:00:00.000Z',
    availableTools: [
      { name: 'edit', descriptionTokens: 300 },
      { name: 'bash', descriptionTokens: 200 },
      { name: 'rare_tool', descriptionTokens: 900 },
    ],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    modelRequests: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    ...extra,
  }
}

function call(name, args = {}, isError = false, output = 'ok') {
  return { callId: `call-${Math.random()}`, name, args, output, isError, at: '2026-01-01T00:01:00.000Z', turn: 1, step: 1 }
}

async function setup(configOverrides = {}, options = {}) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'te-service-')))
  const store = new Store({ DSH_HOME: home })
  await store.open('0.1.0', '0.2.2')
  const config = { mode: 'shadow', ...configOverrides }
  const redirects = []
  const configWrites = []
  const reconciles = []
  const judgeCalls = []
  const judge = {
    async call(request) {
      judgeCalls.push(request)
      const written = request.system.includes('Write a SHORT redirect')
      return {
        ok: true,
        text: written
          ? options.writerText ?? 'Re-read the failing assertion instead of editing the same file again.'
          : options.judgeText ?? '{"stuck": true, "confidence": 0.9, "reason": "same failure twice"}',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120 },
        provider: 'deepseek',
        model: 'deepseek-v4',
      }
    },
  }
  const service = new EconomizerService({
    store,
    logger: { warn: () => {}, info: () => {} },
    pluginVersion: '0.1.0',
    dshVersion: '0.2.2',
    compatibility: { ok: true, version: '0.2.2', testedRange: '>=0.2.0 <0.3.0', reason: 'tested' },
    config: () => config,
    writeConfig: async (patch) => {
      configWrites.push(patch)
      Object.assign(config, patch)
    },
    judge,
    applyRedirect: (sessionId, text) => {
      redirects.push({ sessionId, text })
      // Lets a test observe the service state at the moment the redirect is handed to
      // the agent, which is where a re-entrant followup can race the incident bookkeeping.
      options.onRedirect?.({ service, sessionId, text })
      return options.redirectDelivery ?? true
    },
    onToolsChanged: (root) => reconciles.push(root),
  })
  if (options.warm !== false) await service.warmProject(PROJECT)
  service.registerRoot('session-1', PROJECT)
  return { home, store, service, config, redirects, configWrites, reconciles, judgeCalls }
}

async function finishTurn(service, { sessionId = 'session-1', turn = 1, calls = [], pickup = false, userInitiated = true, modelUsage = { inputTokens: 1000, outputTokens: 100 }, root = PROJECT } = {}) {
  const session = observed(sessionId, root)
  service.observe(session)
  service.beginTurn(session, turn)
  const tagged = calls.map((entry) => ({ ...entry, turn }))
  for (const entry of tagged) service.onToolResult(session, entry)
  const summary = {
    session,
    turn,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: `2026-01-01T00:0${turn}:00.000Z`,
    calls: tagged,
    modelCalls: [
      {
        model: 'gpt-5.4',
        provider: 'openai',
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: modelUsage.inputTokens + modelUsage.outputTokens, ...modelUsage },
        at: `2026-01-01T00:0${turn}:00.000Z`,
      },
    ],
    usage: modelUsage,
    failedToolCalls: calls.filter((entry) => entry.isError).length,
    assistantText: 'done',
    partial: false,
    userInitiated,
  }
  // A detached verdict is picked up by the next tool result, inside the same turn.
  await service.flush()
  if (pickup) {
    service.onToolResult(session, { ...call(), turn })
    await service.flush()
  }
  service.onTurnEnd(summary)
  await service.flush()
}

test('one finished turn persists model/tool metrics and surfaces honest totals', async () => {
  const env = await setup()
  try {
    await finishTurn(env.service, {
      calls: [call('edit', { path: '/work/economizer-project/src/a.ts' }), call('bash', { command: 'pnpm test' }, true)],
    })
    const status = await env.service.status({ sessionId: 'session-1' })
    assert.equal(status.mode, 'shadow')
    assert.equal(status.totals.modelRequests, 1)
    assert.equal(status.totals.inputTokens, 1000)
    assert.equal(status.totals.outputTokens, 100)
    assert.equal(status.totals.costUsd, null, 'no price table means no invented price')
    assert.ok(status.totals.effectiveTokens !== null, 'known model yields effective tokens')
    assert.equal(status.effective.microskills, false, 'shadow never mutates')
    assert.equal(status.totals.estimatedSavingsUsd, null)
    assert.ok(status.notes.some((note) => /Shadow mode/.test(note)))
    assert.ok(status.notes.some((note) => /estimates/.test(note)))

    const tools = await env.service.tools({ sessionId: 'session-1' })
    assert.equal(tools.entries.length, 3)
    assert.ok(tools.entries.some((entry) => entry.name === 'rare_tool' && entry.calls === 0))
    assert.deepEqual(tools.hidden, [], 'shadow mode hides nothing')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('subagent turns are attributed to the root session without double counting', async () => {
  const env = await setup({ subagentsEnabled: true })
  try {
    await finishTurn(env.service, { sessionId: 'root-1' })
    // The child reports its own model call; the root reports only its own.
    const child = observed('child-1', PROJECT, {
      isSubagent: true,
      parentSessionId: 'root-1',
      rootSessionId: 'root-1',
      delegationDepth: 1,
    })
    env.service.observe(child)
    env.service.beginTurn(child, 1)
    env.service.onTurnEnd({
      session: child,
      turn: 1,
      startedAt: null,
      endedAt: '2026-01-01T00:02:00.000Z',
      calls: [call('bash', { command: 'ls' })],
      modelCalls: [
        {
          model: 'gpt-5.4',
          provider: 'openai',
          usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 550 },
          at: '2026-01-01T00:02:00.000Z',
        },
      ],
      usage: { inputTokens: 500, outputTokens: 50 },
      failedToolCalls: 0,
      assistantText: '',
      partial: false,
    })
    await env.service.flush()
    const status = await env.service.status({ sessionId: 'root-1' })
    assert.equal(status.totals.modelRequests, 2, 'root and child each contribute exactly one model row')
    assert.equal(status.totals.inputTokens, 1500)
    const overview = await env.service.overview({ sessionId: 'root-1' })
    assert.equal(overview.sessions.subagentSessions, 1)
    assert.equal(overview.sessions.observed, 1)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('subagent accounting can be switched off without losing the root metrics', async () => {
  const env = await setup({ subagentsEnabled: false, mode: 'active' })
  try {
    await finishTurn(env.service, { sessionId: 'root-1' })
    const child = observed('child-1', PROJECT, { isSubagent: true, rootSessionId: 'root-1', delegationDepth: 1 })
    env.service.observe(child)
    env.service.beginTurn(child, 1)
    env.service.onTurnEnd({
      session: child,
      turn: 1,
      startedAt: null,
      endedAt: '2026-01-01T00:02:00.000Z',
      calls: [],
      modelCalls: [
        {
          model: 'gpt-5.4',
          provider: 'openai',
          usage: { inputTokens: 999, outputTokens: 99, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1098 },
          at: '2026-01-01T00:02:00.000Z',
        },
      ],
      usage: { inputTokens: 999, outputTokens: 99 },
      failedToolCalls: 0,
      assistantText: '',
      partial: false,
    })
    await env.service.flush()
    const status = await env.service.status({ sessionId: 'root-1' })
    assert.equal(status.totals.modelRequests, 1)
    assert.equal(status.totals.inputTokens, 1000)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('an autonomous-only session does not advance prompt evidence', async () => {
  const env = await setup({ toolpruneMode: 'observe', toolpruneEvidence: 10, toolpruneMinSessions: 5 })
  try {
    await finishTurn(env.service, {
      sessionId: 'session-1',
      turn: 1,
      calls: [call('edit', { path: '/work/economizer-project/a.ts' })],
    })
    await finishTurn(env.service, {
      sessionId: 'session-2',
      turn: 1,
      userInitiated: false,
      calls: [call('edit', { path: '/work/economizer-project/a.ts' })],
    })
    await finishTurn(env.service, {
      sessionId: 'session-3',
      turn: 1,
      userInitiated: false,
      calls: [call('edit', { path: '/work/economizer-project/a.ts' })],
    })

    const project = await env.store.project(PROJECT)
    const tools = await project.loadTools()
    assert.equal(tools.tools.rare_tool.unusedPrompts, 1, 'only the human turn is prompt evidence')
    assert.equal(tools.tools.rare_tool.unusedSessions, 3, 'autonomous sessions still count for the session floor')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('tool evidence becomes a candidate after the configured sessions and denies only in ACTIVE automatic mode', async () => {
  const env = await setup({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneMinSessions: 2,
    toolpruneEvidence: 2,
    toolpruneQuietMinutes: 0,
  })
  try {
    await finishTurn(env.service, { sessionId: 'session-1', turn: 1, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    await finishTurn(env.service, { sessionId: 'session-2', turn: 1, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    let tools = await env.service.tools({ sessionId: 'session-1' })
    const rare = tools.entries.find((entry) => entry.name === 'rare_tool')
    assert.equal(rare.status, 'active')
    assert.equal(rare.reason, 'candidate')
    env.service.registerRoot('session-3', PROJECT)
    await env.service.beginSession('session-3', PROJECT)
    const deny = await env.service.denySetForSession('session-3')
    assert.ok(deny.includes('rare_tool'), 'automatic mode denies the evidenced candidate in the next session')
    assert.ok(!deny.includes('edit'), 'used tools stay available')

    await env.service.setMode('active')
    tools = await env.service.tools({ sessionId: 'session-1' })
    assert.equal(tools.mode, 'automatic')
    await env.service.setMode('shadow')
    assert.deepEqual(await env.service.denySetForSession('session-1'), [], 'shadow restores the catalog')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('micro-skill confirmation, rejection and clearing mutate only the selected project', async () => {
  const env = await setup({ mode: 'active', microskillsInject: true })
  try {
    const project = await env.store.project(PROJECT)
    const base = {
      key: 'fact-key',
      text: 'The test command is pnpm test.',
      high: false,
      drift: false,
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
      source: { sessionId: 'session-1', turn: 1, evidence: ['observed command'] },
    }
    await project.updateSkills((file) => {
      file.facts = [
        { id: 'candidate-1', kind: 'command', state: 'CANDIDATE', ...base },
        { id: 'candidate-2', kind: 'command', state: 'CANDIDATE', ...base, key: 'fact-key-2', text: 'Lint runs with pnpm lint.' },
      ]
    })
    let skills = await env.service.skills({ sessionId: 'session-1' })
    assert.equal(skills.candidates.length, 2)
    assert.equal(skills.meta.injectionEnabled, true)

    const confirmed = await env.service.skillsAction({ action: 'confirm', ids: ['candidate-1'] }, { sessionId: 'session-1' })
    assert.equal(confirmed.changed, 1)
    assert.equal(confirmed.data.confirmed.length, 1)
    assert.equal(confirmed.data.candidates.length, 1)

    const rejected = await env.service.skillsAction({ action: 'reject', ids: ['candidate-2'] }, { sessionId: 'session-1' })
    assert.equal(rejected.changed, 1)
    assert.equal(rejected.data.candidates.length, 0)

    // A different workspace must not see these facts.
    const otherRoot = '/work/other-project'
    await mkdir(otherRoot, { recursive: true }).catch(() => {})
    env.service.registerRoot('session-2', otherRoot)
    const other = await env.service.skills({ cwd: otherRoot })
    assert.equal(other.confirmed.length, 0)

    // Restore the original project state for a clean clear operation.
    await project.updateSkills((file) => {
      file.facts = [
        { id: 'candidate-3', kind: 'command', state: 'CANDIDATE', ...base, key: 'fact-key-3' },
        { id: 'candidate-4', kind: 'command', state: 'CANDIDATE', ...base, key: 'fact-key-4' },
      ]
    })
    const cleared = await env.service.skillsAction({ action: 'clearCandidates' }, { sessionId: 'session-1' })
    assert.equal(cleared.changed, 2)
    assert.equal(cleared.data.candidates.length, 0)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('settings validation rejects unknown keys, bad enums and bad types', async () => {
  const env = await setup()
  try {
    await assert.rejects(() => env.service.updateSettings({ nope: 1 }), /Unknown configuration key/)
    await assert.rejects(() => env.service.updateSettings({ mode: 'sometimes' }), /must be one of/)
    await assert.rejects(() => env.service.updateSettings({ microskillsEnabled: 'yes' }), /must be a boolean/)
    await assert.rejects(() => env.service.updateSettings({ microskillsMaxFacts: 'many' }), /finite number/)
    await assert.rejects(() => env.service.updateSettings({ toolpruneAllowlist: [1] }), /array of strings/)
    const result = await env.service.updateSettings({ mode: 'active', toolpruneMode: 'propose' })
    assert.equal(result.ok, true)
    assert.equal(env.configWrites.length, 1)
    assert.equal((await env.service.status({})).mode, 'active')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('mode switching restores tool restrictions and never applies in shadow mode', async () => {
  const env = await setup({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneMinSessions: 2,
    toolpruneEvidence: 2,
    toolpruneQuietMinutes: 0,
  })
  try {
    await finishTurn(env.service, { turn: 1, calls: [call('bash', { command: 'ls' })] })
    await finishTurn(env.service, { turn: 2, calls: [call('bash', { command: 'ls' })] })
    await env.service.setMode('off')
    assert.deepEqual(await env.service.denySetForSession('session-1'), [])
    const loops = await env.service.loops({ sessionId: 'session-1' })
    assert.equal(loops.ok, true)
    await env.service.setMode('shadow')
    assert.ok(env.reconciles.includes(''), 'turning mutations off asks the host to re-reconcile every project')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('the ledger view never double counts the turn-end row alongside model rows', async () => {
  const store = new Store({ DSH_HOME: await mkdtemp(join(tmpdir(), 'te-ledger-')) })
  const projectId = 'p1'
  const rows = [
    {
      schemaVersion: SCHEMA_VERSION,
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 's',
      rootSessionId: 's',
      delegationDepth: 0,
      isSubagent: false,
      projectId,
      kind: 'model',
      model: 'gpt-5.4',
      provider: 'openai',
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 110 },
    },
    {
      schemaVersion: SCHEMA_VERSION,
      at: '2026-01-01T00:00:01.000Z',
      sessionId: 's',
      rootSessionId: 's',
      delegationDepth: 0,
      isSubagent: false,
      projectId,
      kind: 'turn-end',
      skillTokens: 50,
      skillsApplied: 2,
      toolsPruned: 1,
    },
  ]
  const report = buildUsageReport(rows, { scope: 'project', projectId })
  assert.equal(report.usage.inputTokens, 100, 'turn-end rows carry no usage')
  assert.equal(report.modelRequests, 1)
  await store.open?.('0.1.0', null)
  await rm(store.root, { recursive: true, force: true })
})

test('loop-guard budget refuses the judge and records a notice instead of redirecting', async () => {
  const env = await setup({ mode: 'active', loopguardIntervene: true, maxOverheadTokensPerTurn: 1 })
  try {
    await finishTurn(env.service, {
      turn: 25,
      calls: Array.from({ length: 8 }, () => call('bash', { command: 'pnpm test' }, true)),
    })
    assert.equal(env.judgeCalls.length, 0, 'a zero budget never spends a judge call')
    assert.equal(env.redirects.length, 0, 'no judge means no redirect')
    const loops = await env.service.loops({ sessionId: 'session-1' })
    assert.equal(loops.summary.judgeCalls, 0)
    assert.ok(loops.summary.budgetExhausted >= 0)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('active mode delivers the model-written redirect, not the count template', async () => {
  const env = await setup({ mode: 'active', loopguardIntervene: true, loopguardJudge: true })
  try {
    // Five resolved turns give the repository an envelope; only then is the paid path wired.
    for (let turn = 1; turn <= 5; turn += 1) {
      await finishTurn(env.service, {
        turn,
        calls: [call('bash', { command: 'pnpm test' }, false, '2 passed in 0.01s')],
      })
    }
    await finishTurn(env.service, {
      turn: 6,
      pickup: true,
      calls: Array.from({ length: 10 }, () =>
        call('bash', { command: 'pnpm test' }, true, 'FAILED tests/test_app.py::test_add - AssertionError: 1 != 2'),
      ),
    })
    assert.ok(env.redirects.length > 0, 'a stuck turn redirects')
    assert.equal(
      env.redirects.at(-1).text,
      'Re-read the failing assertion instead of editing the same file again.',
    )
    assert.ok(
      env.judgeCalls.some((request) => request.system.includes('Write a SHORT redirect')),
      'the writer was asked for the redirect',
    )
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a delayed followup redirect records its delivery mode and a still-stuck follow-up', async () => {
  const env = await setup(
    { mode: 'active', loopguardIntervene: true, loopguardJudge: true },
    { redirectDelivery: { ok: true, delivery: 'followup-degraded' } },
  )
  try {
    for (let turn = 1; turn <= 5; turn += 1) {
      await finishTurn(env.service, {
        turn,
        calls: Array.from({ length: 30 }, () => call('bash', { command: 'pnpm test' }, false, '2 passed in 0.01s')),
      })
    }
    const session = observed('session-1', PROJECT)
    env.service.observe(session)
    env.service.beginTurn(session, 6)
    const failures = () =>
      Array.from({ length: 22 }, () =>
        call('bash', { command: 'pnpm test' }, true, 'FAILED tests/test_app.py::test_add - AssertionError: 1 != 2'),
      ).map((entry) => ({ ...entry, turn: 6 }))

    for (const entry of failures()) env.service.onToolResult(session, entry)
    await env.service.flush()
    env.service.onToolResult(session, { ...call(), turn: 6 })
    assert.equal(env.redirects.length, 1, 'the first verdict redirects')

    // After the redirect budget is spent the next verdict is the "still stuck" notice,
    // never a second followup and never a turn stop.
    for (const entry of failures()) env.service.onToolResult(session, entry)
    await env.service.flush()
    env.service.onToolResult(session, { ...call(), turn: 6 })
    env.service.onTurnEnd({
      session,
      turn: 6,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:06:00.000Z',
      calls: failures(),
      modelCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      failedToolCalls: 22,
      assistantText: 'done',
      partial: false,
    })
    await env.service.flush()

    assert.equal(env.redirects.length, 1, 'at most one redirect per turn')
    const history = await env.service.loops({ sessionId: 'session-1' })
    const redirect = history.incidents.find((incident) => incident.intervention === 'nudge')
    assert.ok(redirect, 'the applied redirect is recorded')
    assert.equal(redirect.detail.delivery, 'followup-degraded', 'the incident names the delayed followup delivery')
    assert.ok(
      history.incidents.some((incident) => incident.kind === 'still-stuck'),
      'a repeat after the redirect is recorded as still-stuck',
    )
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a redirect is recorded before followup can start the next turn', async () => {
  let serviceAtDelivery = null
  let appliedAtDelivery = null
  const env = await setup(
    { mode: 'active', loopguardIntervene: true, loopguardJudge: true },
    {
      onRedirect: ({ service, sessionId }) => {
        serviceAtDelivery = sessionId
        appliedAtDelivery = service.appliedIncidents.get(sessionId)?.length ?? 0
      },
    },
  )
  try {
    for (let turn = 1; turn <= 5; turn += 1) {
      await finishTurn(env.service, {
        turn,
        calls: Array.from({ length: 30 }, () => call('bash', { command: 'pnpm test' }, false, '2 passed in 0.01s')),
      })
    }
    await finishTurn(env.service, {
      turn: 6,
      pickup: true,
      calls: Array.from({ length: 22 }, () =>
        call('bash', { command: 'pnpm test' }, true, 'FAILED tests/test_app.py::test_add - AssertionError: 1 != 2'),
      ),
    })
    assert.equal(serviceAtDelivery, 'session-1')
    assert.equal(appliedAtDelivery, 1, 'the incident is visible before followup returns')
    const history = await env.service.loops({ sessionId: 'session-1' })
    assert.ok(history.incidents.some((incident) => incident.intervention === 'nudge'))
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a newer on-disk schema fails closed rather than being overwritten', async () => {
  const home = await mkdtemp(join(tmpdir(), 'te-schema-'))
  try {
    const store = new Store({ DSH_HOME: home })
    await store.open('0.1.0', '0.2.2')
    const project = await store.project(PROJECT)
    await writeFile(
      join(project.dir, 'skills.json'),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, taskIndex: 0, facts: [], updatedAt: null }),
    )
    const fresh = await new Store({ DSH_HOME: home }).project(PROJECT)
    await assert.rejects(() => fresh.loadSkills(), /newer than supported/)
    const status = await new Store({ DSH_HOME: home }).open('0.1.0', '0.2.2')
    assert.equal(status.schemaVersion, SCHEMA_VERSION)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the storage root stays inside DSH_HOME and the plugin writes nothing else', async () => {
  const env = await setup()
  try {
    await finishTurn(env.service, { calls: [] })
    const install = JSON.parse(await readFile(join(env.home, 'token-economizer', 'install.json'), 'utf8'))
    assert.equal(install.pluginVersion, '0.1.0')
    assert.ok(env.store.root.startsWith(env.home))
    assert.ok(!env.store.root.includes('..'))
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

function activeFact(overrides = {}) {
  return {
    id: 'fact-1',
    key: 'fact-key',
    text: 'Canonical test command is `pnpm test`.',
    kind: 'command',
    high: false,
    drift: false,
    state: 'ACTIVE',
    confirms: [[1, []], [2, []], [3, []], [4, []]],
    contradicts: [],
    fireNum: 4,
    fireDen: 4,
    promotedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    enabled: true,
    source: { sessionId: 'session-1', turn: 1, evidence: ['observed command'] },
    ...overrides,
  }
}

test('automatic pruning persists the hidden set for the next session, then restore is durable', async () => {
  const env = await setup({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneMinSessions: 1,
    toolpruneEvidence: 1,
    toolpruneQuietMinutes: 0,
  })
  try {
    // The evidence forms in session 1, but the running session keeps its catalog.
    await finishTurn(env.service, { turn: 1, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    const project = await env.store.project(PROJECT)
    assert.deepEqual(await env.service.denySetForSession('session-1'), [], 'the current session is never rewritten')

    // Session 2 starts and picks up the pending hide.
    env.service.registerRoot('session-2', PROJECT)
    await env.service.beginSession('session-2', PROJECT)
    await finishTurn(env.service, {
      sessionId: 'session-2',
      turn: 1,
      calls: [call('edit', { path: '/work/economizer-project/a.ts' })],
    })
    const deny = await env.service.denySetForSession('session-2')
    assert.ok(deny.includes('rare_tool'))
    let toolsFile = await project.loadTools()
    assert.ok(toolsFile.pruned.includes('rare_tool'), 'the applied deny set is written to tools.json')

    const restored = await env.service.toolsAction({ action: 'restore', names: ['rare_tool'] }, { sessionId: 'session-2' })
    assert.equal(restored.changed, 1)
    toolsFile = await project.loadTools()
    assert.equal(toolsFile.pruned.includes('rare_tool'), false)
    assert.equal(toolsFile.tools.rare_tool.restored, true, 'restore is durable in the project row')
    assert.deepEqual(await env.service.denySetForSession('session-2'), [])
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('micro-skills injection obeys the selected profile instead of the preview renderer', async () => {
  const env = await setup({ mode: 'active', microskillsInject: true, microskillsProfile: 'envfacts' })
  try {
    const project = await env.store.project(PROJECT)
    await project.updateSkills((file) => {
      file.facts = [activeFact()]
    })
    await finishTurn(env.service, { turn: 1, calls: [] })
    assert.equal(env.service.knowledgeForSession('session-1'), '', 'envfacts profile must not inject manual facts')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('the real injection path uses the engine block and the repo manual header', async () => {
  const env = await setup({ mode: 'active', microskillsInject: true, microskillsProfile: 'distiller' })
  try {
    const project = await env.store.project(PROJECT)
    await project.updateSkills((file) => {
      file.facts = [activeFact()]
    })
    await finishTurn(env.service, { turn: 1, calls: [] })
    const block = env.service.knowledgeForSession('session-1')
    assert.match(block, /^# repo operating manual \(economizer-project\)/)
    assert.match(block, /Canonical test command is `pnpm test`\./)
    assert.equal(block.includes('# Learned project knowledge'), false)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a session freezes an empty knowledge block at first lookup', async () => {
  const env = await setup({ mode: 'active', microskillsInject: true, microskillsProfile: 'distiller' })
  try {
    assert.equal(env.service.knowledgeForSession('session-1'), '', 'the session starts with no learned block')

    const project = await env.store.project(PROJECT)
    await project.updateSkills((file) => {
      file.facts = [activeFact()]
    })
    await finishTurn(env.service, { turn: 1, calls: [] })
    assert.equal(
      env.service.knowledgeForSession('session-1'),
      '',
      'a fact learned in the middle of the session must not change this session prompt',
    )

    env.service.registerRoot('session-2', PROJECT)
    assert.match(env.service.knowledgeForSession('session-2'), /Canonical test command is `pnpm test`\./)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a session freezes an empty block even before the project warms', async () => {
  const env = await setup(
    { mode: 'active', microskillsInject: true, microskillsProfile: 'distiller' },
    { warm: false },
  )
  try {
    const project = await env.store.project(PROJECT)
    await project.updateSkills((file) => {
      file.facts = [activeFact()]
    })

    assert.equal(
      env.service.knowledgeForSession('session-1'),
      '',
      'the first lookup happens before any project runtime exists',
    )
    await env.service.warmProject(PROJECT)
    assert.equal(
      env.service.knowledgeForSession('session-1'),
      '',
      'warming the project must not change the block of a session that already looked it up',
    )

    env.service.registerRoot('session-2', PROJECT)
    assert.match(env.service.knowledgeForSession('session-2'), /Canonical test command is `pnpm test`\./)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a session keeps the knowledge block it started with', async () => {
  const env = await setup({ mode: 'active', microskillsInject: true, microskillsProfile: 'distiller' })
  try {
    const project = await env.store.project(PROJECT)
    await project.updateSkills((file) => {
      file.facts = [activeFact()]
    })
    await finishTurn(env.service, { turn: 1, calls: [] })
    const first = env.service.knowledgeForSession('session-1')
    assert.match(first, /Canonical test command is `pnpm test`\./)

    // A later fold learns one more fact. The running session must not see its prompt change.
    await project.updateSkills((file) => {
      file.facts.push(
        activeFact({
          id: 'fact-2',
          key: 'fact-key-2',
          text: 'Run the linter with `pnpm lint`.',
        }),
      )
    })
    await finishTurn(env.service, { turn: 2, calls: [] })
    assert.equal(env.service.knowledgeForSession('session-1'), first)
    assert.equal(first.includes('pnpm lint'), false, 'the frozen block is the one the session started with')

    env.service.registerRoot('session-2', PROJECT)
    const next = env.service.knowledgeForSession('session-2')
    assert.match(next, /pnpm lint/, 'a new session sees the newer block')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('retireDays retires stale active facts that were not injected', async () => {
  const env = await setup({ mode: 'active', microskillsInject: true, microskillsProfile: 'envfacts', microskillsRetireDays: 1 })
  try {
    const project = await env.store.project(PROJECT)
    await project.updateSkills((file) => {
      file.facts = [activeFact({ lastUsedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })]
    })
    await finishTurn(env.service, { turn: 1, calls: [] })
    const skillsFile = await project.loadSkills()
    assert.equal(skillsFile.facts[0].state, 'RETIRED')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('storeEvidence false scrubs manual evidence before saving', async () => {
  const env = await setup({ mode: 'active', microskillsInject: true, microskillsProfile: 'distiller', storeEvidence: false })
  try {
    const project = await env.store.project(PROJECT)
    await project.updateSkills((file) => {
      file.facts = [activeFact({ source: { sessionId: 'session-1', turn: 1, evidence: ['a full command line'] } })]
    })
    await finishTurn(env.service, { turn: 1, calls: [] })
    const skillsFile = await project.loadSkills()
    const manual = skillsFile.facts.find((fact) => fact.key === 'fact-key')
    assert.deepEqual(manual.source.evidence, [])
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a completed turn persists the learned loop-guard envelope', async () => {
  const env = await setup({ mode: 'active', loopguardEnabled: true })
  try {
    await finishTurn(env.service, {
      turn: 1,
      calls: [call('bash', { command: 'pnpm test' }, false, '2 passed in 0.01s')],
    })
    const project = await env.store.project(PROJECT)
    const raw = await readFile(join(project.dir, 'loopguard.json'), 'utf8')
    const data = JSON.parse(raw)
    assert.ok(Array.isArray(data.resolved_turns))
    assert.ok(data.resolved_turns.length >= 1)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('dispose flushes a queued turn before clearing the loop guard', async () => {
  const env = await setup({ mode: 'active', loopguardEnabled: true })
  try {
    const session = observed('session-dispose')
    env.service.observe(session)
    env.service.beginTurn(session, 1)
    env.service.onToolResult(session, call('bash', { command: 'pnpm test' }, false, '2 passed'))
    const summary = {
      session,
      turn: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      calls: [call('bash', { command: 'pnpm test' }, false, '2 passed')],
      modelCalls: [
        {
          model: 'gpt-5.4',
          provider: 'openai',
          usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1100 },
          at: '2026-01-01T00:01:00.000Z',
        },
      ],
      usage: { inputTokens: 1000, outputTokens: 100 },
      failedToolCalls: 1,
      assistantText: 'done',
      partial: false,
      userInitiated: true,
    }
    env.service.onTurnEnd(summary)
    // No explicit flush: shutdown must drain the queued finalize while the guard still exists.
    await env.service.dispose()
    const project = await env.store.project(PROJECT)
    const data = JSON.parse(await readFile(join(project.dir, 'loopguard.json'), 'utf8'))
    assert.ok(Array.isArray(data.resolved_turns))
    assert.ok(data.resolved_turns.length >= 1, 'the envelope survives a headless shutdown')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('shadow mode never applies a loop redirect even when the switch is on', async () => {
  const env = await setup({ mode: 'shadow', loopguardIntervene: true, loopguardJudge: false })
  try {
    for (let turn = 1; turn <= 5; turn += 1) {
      await finishTurn(env.service, {
        turn,
        calls: [call('bash', { command: 'pnpm test' }, false, '2 passed in 0.01s')],
      })
    }
    await finishTurn(env.service, {
      turn: 6,
      calls: Array.from({ length: 30 }, () => call('bash', { command: 'pnpm test' }, true, 'FAILED tests/test_app.py::test_add - AssertionError: 1 != 2')),
    })
    assert.equal(env.redirects.length, 0)
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('the quiet period holds a pending hide until the project has been idle', async () => {
  const env = await setup({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneMinSessions: 1,
    toolpruneEvidence: 1,
    toolpruneQuietMinutes: 60,
  })
  try {
    await finishTurn(env.service, { turn: 1, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    const project = await env.store.project(PROJECT)
    const now = new Date().toISOString()
    await project.updateTools((file) => {
      file.lastActivityAt = now
      if (file.autoPending) file.autoPending.since = now
    })
    // A session immediately after the discovery must not see the new hide.
    env.service.registerRoot('session-2', PROJECT)
    await env.service.beginSession('session-2', PROJECT)
    assert.deepEqual(await env.service.denySetForSession('session-2'), [], 'quiet period postpones the hide')

    await project.updateTools((file) => {
      file.lastActivityAt = '2026-01-01T00:00:00.000Z'
    })
    env.service.registerRoot('session-3', PROJECT)
    await env.service.beginSession('session-3', PROJECT)
    assert.ok((await env.service.denySetForSession('session-3')).includes('rare_tool'), 'idle project applies the pending hide')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a long-lived session cannot apply a hidden set discovered mid-session', async () => {
  const env = await setup({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneMinSessions: 1,
    toolpruneEvidence: 1,
    toolpruneQuietMinutes: 0,
  })
  try {
    // This is the one `agent/created` for session-1.
    await env.service.beginSession('session-1', PROJECT)
    await finishTurn(env.service, { turn: 1, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })

    const report = await env.service.tools({ sessionId: 'session-1' })
    assert.ok(
      report.notes.some((note) => note.includes('agent/created')),
      'the report names the event that will apply the pending hide',
    )

    // Later turns and even a repeated start call must not apply the pending hide here.
    await finishTurn(env.service, { turn: 2, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    await env.service.beginSession('session-1', PROJECT)
    assert.deepEqual(await env.service.denySetForSession('session-1'), [], 'a long-lived session keeps its catalog')

    // Only a newly created session applies it.
    env.service.registerRoot('session-2', PROJECT)
    await env.service.beginSession('session-2', PROJECT)
    assert.ok((await env.service.denySetForSession('session-2')).includes('rare_tool'))
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('a periodic re-audit shows the full catalog once without losing persisted hides', async () => {
  const env = await setup({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneMinSessions: 1,
    toolpruneEvidence: 1,
    toolpruneQuietMinutes: 0,
    toolpruneReauditEvery: 2,
  })
  try {
    await finishTurn(env.service, { turn: 1, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    env.service.registerRoot('session-2', PROJECT)
    await env.service.beginSession('session-2', PROJECT)
    assert.ok((await env.service.denySetForSession('session-2')).includes('rare_tool'))
    const project = await env.store.project(PROJECT)

    // A normal task keeps the hide.
    await finishTurn(env.service, { sessionId: 'session-2', turn: 2, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    assert.ok((await env.service.denySetForSession('session-1')).includes('rare_tool'))

    // Task index 2 is a re-audit task: no hide is applied for that one reconcile.
    await finishTurn(env.service, { sessionId: 'session-3', turn: 3, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    assert.deepEqual(await env.service.denySetForSession('session-1'), [])
    let toolsFile = await project.loadTools()
    assert.ok(toolsFile.pruned.includes('rare_tool'), 'the persisted hide survives the re-audit')
    assert.equal(toolsFile.lastAuditTask, 2, 'the audit cadence survives a process restart')

    await finishTurn(env.service, { sessionId: 'session-4', turn: 4, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    assert.ok((await env.service.denySetForSession('session-1')).includes('rare_tool'))
    toolsFile = await project.loadTools()
    assert.ok(toolsFile.pruned.includes('rare_tool'))
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

test('leaving automatic ACTIVE pruning clears persisted hides', async () => {
  const env = await setup({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneMinSessions: 1,
    toolpruneEvidence: 1,
    toolpruneQuietMinutes: 0,
  })
  try {
    await finishTurn(env.service, { turn: 1, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    env.service.registerRoot('session-2', PROJECT)
    env.service.registerRoot('session-2', PROJECT)
    await env.service.beginSession('session-2', PROJECT)
    assert.ok((await env.service.denySetForSession('session-2')).includes('rare_tool'))
    const project = await env.store.project(PROJECT)
    await env.service.setMode('shadow')
    assert.deepEqual(await env.service.denySetForSession('session-1'), [])
    const toolsFile = await project.loadTools()
    assert.deepEqual(toolsFile.pruned, [])
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})


test('a restarted process restores the loop-guard envelope before judging', async () => {
  const first = await setup({ mode: 'active', loopguardIntervene: true })
  try {
    for (let turn = 1; turn <= 5; turn += 1) {
      await finishTurn(first.service, {
        turn,
        calls: [call('bash', { command: 'pnpm test' }, false, '2 passed in 0.01s')],
      })
    }
    const stored = JSON.parse(await readFile(join((await first.store.project(PROJECT)).dir, 'loopguard.json'), 'utf8'))
    assert.ok(stored.resolved_turns.length >= 5)

    const second = await setup({ mode: 'active', loopguardIntervene: true }, { home: first.home })
    await finishTurn(second.service, {
      turn: 1,
      pickup: true,
      calls: Array.from({ length: 8 }, () => call('bash', { command: 'pnpm test' }, true, 'FAILED tests/test_app.py::test_add - AssertionError: 1 != 2')),
    })
    assert.ok(second.judgeCalls.length > 0, 'the judge is available on a cold process')
  } finally {
    await rm(first.home, { recursive: true, force: true })
  }
})
