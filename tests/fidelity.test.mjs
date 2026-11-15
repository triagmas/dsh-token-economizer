import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { Store } from '../lib/storage/store.js'
import { EconomizerService } from '../lib/plugin/service.js'
import { MicroskillsEngine } from '../lib/microskills/index.js'
import { renderStoredBlock } from '../lib/microskills/index.js'
import { resolveConfig } from '../lib/config/schema.js'
import { DEFAULT_REDACTION } from '../lib/core/redact.js'

const PROJECT = '/work/economizer-project'
const AT = '2026-01-01T00:00:00.000Z'

function observed(sessionId, extra = {}) {
  return {
    sessionId,
    rootSessionId: extra.rootSessionId ?? sessionId,
    parentSessionId: extra.parentSessionId ?? null,
    delegationDepth: extra.delegationDepth ?? 0,
    isSubagent: extra.isSubagent ?? false,
    cwd: PROJECT,
    projectRoot: PROJECT,
    startedAt: AT,
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

let seq = 0
function call(name = 'bash', args = { command: 'pnpm test' }, isError = false, output = 'ok') {
  seq += 1
  return { callId: `fidelity-${seq}`, name, args, output, isError, at: AT, turn: 1, step: 1 }
}

async function setup(configOverrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'te-fidelity-'))
  const store = new Store({ DSH_HOME: home })
  await store.open('0.1.0', '0.2.2')
  const config = { mode: 'shadow', ...configOverrides }
  const redirects = []
  const judgeCalls = []
  const judge = {
    async call(request) {
      judgeCalls.push(request)
      const writer = request.system.includes('Write a SHORT redirect')
      return {
        ok: true,
        text: writer
          ? 'Re-read the failing assertion instead of editing the same file again.'
          : '{"stuck": true, "confidence": 0.9, "reason": "same failure twice"}',
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
    writeConfig: async (patch) => Object.assign(config, patch),
    judge,
    applyRedirect: (sessionId, text) => {
      redirects.push({ sessionId, text })
      return true
    },
    onToolsChanged: () => {},
  })
  await service.warmProject(PROJECT)
  service.registerRoot('session-1', PROJECT)
  service.registerRoot('session-2', PROJECT)
  service.registerRoot('child-1', PROJECT)
  return { home, store, service, config, redirects, judgeCalls }
}

async function endTurn(service, { sessionId = 'session-1', turn = 1, calls = [], extra = {} } = {}) {
  const session = observed(sessionId, extra)
  service.observe(session)
  service.beginTurn(session, turn)
  for (const entry of calls) service.onToolResult(session, entry)
  service.onTurnEnd({
    session,
    turn,
    startedAt: AT,
    endedAt: `2026-01-01T00:${String(turn).padStart(2, '0')}:00.000Z`,
    calls,
    modelCalls: [{
      model: 'gpt-5.4',
      provider: 'openai',
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1100 },
      at: AT,
    }],
    usage: { inputTokens: 1000, outputTokens: 100 },
    failedToolCalls: calls.filter((entry) => entry.isError).length,
    assistantText: 'done',
    partial: false,
  })
  await service.flush()
}

function failingBatch(count) {
  return Array.from({ length: count }, () =>
    call('bash', { command: 'pnpm test' }, true, 'FAILED tests/test_app.py::test_add - AssertionError: 1 != 2'),
  )
}

async function finishOnly(service, session, turn, calls = []) {
  service.onTurnEnd({
    session,
    turn,
    startedAt: AT,
    endedAt: `2026-01-01T00:${String(turn).padStart(2, '0')}:00.000Z`,
    calls,
    modelCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    failedToolCalls: calls.filter((entry) => entry.isError).length,
    assistantText: 'done',
    partial: false,
  })
  await service.flush()
}

async function warm(service, sessionId = 'session-1', extra = {}) {
  for (let turn = 1; turn <= 5; turn += 1) {
    await endTurn(service, { sessionId, turn, extra, calls: Array.from({ length: 30 }, () => call()) })
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}

// T-a: the guard decides in-turn and requests one followup, recorded at the turn boundary.
test('T-a loop guard requests one followup redirect and records it', async () => {
  const env = await setup({ mode: 'active', loopguardIntervene: true, loopguardJudge: true })
  try {
    await warm(env.service)
    const session = observed('session-1')
    env.service.observe(session)
    env.service.beginTurn(session, 6)
    for (const entry of failingBatch(22)) env.service.onToolResult(session, { ...entry, turn: 6 })

    // The judge is detached; drain it, then the next tool result picks up the verdict,
    // exactly like upstream's held PostToolUse decision.
    await env.service.flush()
    env.service.onToolResult(session, { ...failingBatch(1)[0], turn: 6 })
    assert.ok(
      await waitFor(() => env.redirects.length > 0, 1000),
      'the followup request must be recorded before the turn-end boundary',
    )
    assert.ok(env.judgeCalls.length > 0, 'the judge was consulted')
    assert.equal(env.redirects.length, 1, 'at most one redirect per turn')

    env.service.onTurnEnd({
      session,
      turn: 6,
      startedAt: AT,
      endedAt: '2026-01-01T00:06:00.000Z',
      calls: failingBatch(23).map((entry) => ({ ...entry, turn: 6 })),
      modelCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      failedToolCalls: 23,
      assistantText: 'done',
      partial: false,
    })
    assert.equal(env.redirects.length, 1, 'no second redirect after the turn ends')
    await env.service.flush()
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

// T-b: a new hide is pending, not applied to the running session.
test('T-b tool pruning applies a new hide to the next session, never the current one', async () => {
  const env = await setup({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneMinSessions: 1,
    toolpruneEvidence: 1,
    toolpruneSessions: 5,
    toolpruneQuietMinutes: 0,
  })
  try {
    await endTurn(env.service, { turn: 1, calls: [call('edit', { path: '/work/economizer-project/a.ts' })] })
    assert.deepEqual(
      await env.service.denySetForSession('session-1'),
      [],
      'the current session keeps its tool catalog',
    )

    // A new agent session is created before its first turn: that is what applies pending.
    env.service.registerRoot('session-2', PROJECT)
    await env.service.beginSession('session-2', PROJECT)
    await endTurn(env.service, {
      sessionId: 'session-2',
      turn: 1,
      calls: [call('edit', { path: '/work/economizer-project/a.ts' })],
    })
    assert.ok(
      (await env.service.denySetForSession('session-2')).includes('rare_tool'),
      'a new session gets the pending hide',
    )
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

// T-c: upstream enough_evidence, including the sessions shortcut and the sub-threshold case.
test('T-c enough_evidence uses prompts, min sessions and the sessions shortcut', async () => {
  const { enoughEvidence } = await import('../lib/toolprune/policy.js')
  assert.equal(typeof enoughEvidence, 'function', 'policy exports the upstream evidence predicate')
  const cfg = { toolpruneEvidence: 10, toolpruneMinSessions: 2, toolpruneSessions: 5 }

  assert.equal(enoughEvidence({ sessions: 2, prompts: 20 }, cfg), true, '(2 sessions, 20 prompts) hides')
  assert.equal(enoughEvidence({ sessions: 5, prompts: 0 }, cfg), true, '(5 sessions, 0 prompts) hides')
  assert.equal(enoughEvidence({ sessions: 2, prompts: 9 }, cfg), false, '(2 sessions, 9 prompts) stays')
})

// T-d: the adapter suppresses a repeated session; the ported lifecycle itself has no sessions.
test('T-d the adapter filter keeps one session from confirming twice', async () => {
  const engine = new MicroskillsEngine()
  const config = resolveConfig({
    mode: 'shadow',
    microskillsEnabled: true,
    microskillsProfile: 'distiller',
    microskillsMinConfirmations: 2,
    microskillsMaxFacts: 12,
    microskillsMaxTokens: 700,
  })
  const candidate = {
    key: 'same-session-fact',
    text: 'The canonical test command is `pnpm test`.',
    kind: 'workflow',
    high: false,
    drift: false,
    fired: true,
    exercised: true,
    files: [],
    evidence: ['pnpm test passed'],
    sourceSessionId: 's-1',
    sourceTurn: 1,
  }
  const window = (sessionId, taskIndex) => ({
    projectId: 'example/repo', sessionId, turn: taskIndex + 1, calls: [], writes: [], failures: [],
    editedFiles: [], taskIndex, at: AT,
  })
  const confirmed = new Map()
  const run = (sessionId, taskIndex, facts) => engine.run({
    window: window(sessionId, taskIndex),
    facts,
    config,
    policy: DEFAULT_REDACTION,
    proposed: [candidate],
    verdictFilter: (key, verdict) => {
      if (verdict !== 'confirm') return verdict
      const seen = confirmed.get(sessionId) ?? new Set()
      if (seen.has(key)) return null
      seen.add(key)
      confirmed.set(sessionId, seen)
      return verdict
    },
  }).facts

  let facts = []
  facts = run('s-1', 0, facts)
  facts = run('s-1', 1, facts)
  assert.equal(facts[0].state, 'CANDIDATE', 'two confirms in one session are not two sessions')
  assert.equal(facts[0].confirms.length, 1, 'the duplicate session confirmation is not stored')

  facts = run('s-2', 2, facts)
  assert.equal(facts[0].state, 'ACTIVE', 'three sessions do promote at k=2')
})

// T-d service: the adapter, not the ported lifecycle, keeps one session's repeated turn
// from becoming a second confirmation.
test('T-d service: a second turn in one session does not confirm the env fact twice', async () => {
  const env = await setup({
    microskillsEnabled: true,
    microskillsProfile: 'envfacts',
    microskillsMinConfirmations: 2,
    microskillsMaxFacts: 12,
    microskillsMaxTokens: 700,
  })
  try {
    const calls = [
      call('bash', { command: 'python runtests.py' }, true, "ModuleNotFoundError: No module named 'app'"),
      call('bash', { command: 'cd src && python runtests.py' }, false, 'Ran 3 tests in 0.01s\nOK'),
    ]
    await endTurn(env.service, { turn: 1, calls })
    await endTurn(env.service, { turn: 2, calls: calls.map((entry) => ({ ...entry, turn: 2 })) })
    const project = await env.store.project(PROJECT)
    const skills = await project.loadSkills()
    const fact = skills.facts.find((row) => row.id.startsWith('form_repair:'))
    assert.ok(fact, 'the repaired test form became an environment fact')
    assert.equal(fact.confirms.length, 1, 'one session contributes one confirmation')
    assert.equal(fact.state, 'CANDIDATE', 'two turns in one session do not reach k=2')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

// T-e: the port must obey the upstream block caps.
test('T-e the injected block is capped at 4 facts and 150 tokens', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `fact_cap_${index}`,
    key: `cap-${index}`,
    text: `Environment fact number ${index}: the repository test command is pnpm test.`,
    kind: 'workflow',
    high: false,
    drift: false,
    state: 'ACTIVE',
    confirms: [[index, []]],
    contradicts: [],
    fireNum: 5,
    fireDen: 5,
    promotedAt: index,
    retiredAt: null,
    createdAt: AT,
    updatedAt: AT,
    lastUsedAt: null,
    enabled: true,
    source: { sessionId: 's-1', turn: 1, evidence: [] },
  }))
  const config = resolveConfig({ microskillsProfile: 'distiller' })
  const rendered = renderStoredBlock(rows, config, DEFAULT_REDACTION, 'example/repo')
  assert.ok(rendered.ids.length <= 4, `expected at most 4 facts, got ${rendered.ids.length}`)
  assert.ok(rendered.tokens <= 150, `expected at most 150 tokens, got ${rendered.tokens}`)
  assert.ok(rendered.ids.length > 0, 'the cap must not suppress a valid block')
})

// T-f: a subagent is attributed, but never guarded.
test('T-f subagent loop guard makes no redirect and no judge call', async () => {
  const env = await setup({ mode: 'active', loopguardIntervene: true, loopguardJudge: true, subagentsEnabled: true })
  try {
    const extra = { isSubagent: true, rootSessionId: 'root-1', parentSessionId: 'root-1', delegationDepth: 1 }
    await warm(env.service, 'child-1', extra)
    const session = observed('child-1', extra)
    env.service.observe(session)
    env.service.beginTurn(session, 6)
    for (const entry of failingBatch(22)) env.service.onToolResult(session, { ...entry, turn: 6 })
    await env.service.flush()
    env.service.onToolResult(session, failingBatch(1)[0])
    await finishOnly(env.service, session, 6, failingBatch(23))
    assert.equal(env.redirects.length, 0, 'subagents never receive a redirect')
    assert.equal(env.judgeCalls.length, 0, 'subagents never spend a judge call')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})

// T-g: no paid judge when redirects are disabled.
test('T-g loopguardIntervene=false never calls the judge', async () => {
  const env = await setup({ mode: 'active', loopguardIntervene: false, loopguardJudge: true })
  try {
    await warm(env.service)
    const session = observed('session-1')
    env.service.observe(session)
    env.service.beginTurn(session, 6)
    for (const entry of failingBatch(22)) env.service.onToolResult(session, { ...entry, turn: 6 })
    await env.service.flush()
    await finishOnly(env.service, session, 6, failingBatch(22))
    assert.equal(env.judgeCalls.length, 0, 'redirects are off, so the paid judge is off too')
    assert.equal(env.redirects.length, 0)
    const status = await env.service.status({ sessionId: 'session-1' })
    assert.equal(status.effective.loopguard, false, 'status must not advertise intervention that is off')
    assert.equal(status.effective.judge, false, 'status must not advertise a judge that cannot run')
    assert.ok(status.notes.some((note) => note.includes('observing only')), 'the status note explains the disabled redirect')
  } finally {
    await rm(env.home, { recursive: true, force: true })
  }
})
