import assert from 'node:assert/strict'
import test from 'node:test'
import { createEconomizerCommand } from '../lib/plugin/commands.js'

const status = {
  ok: true,
  plugin: { name: 'dsh-token-economizer', version: '0.1.0', dshVersion: '0.2.2', compatibility: { ok: true, version: '0.2.2', testedRange: '>=0.2.0 <0.3.0', reason: 'ok' } },
  mode: 'shadow',
  effective: { microskills: true, toolprune: true, loopguard: true, subagents: true, judge: false },
  project: { id: 'p1', root: '/work/alpha' },
  storage: { root: '/home/u/.dsh/token-economizer', projectDir: '/home/u/.dsh/token-economizer/projects/p1', schemaVersion: 1, bytes: 1200 },
  totals: {
    modelRequests: 12,
    inputTokens: 13_000,
    outputTokens: 2_000,
    cacheReadTokens: 1_500,
    cacheWriteTokens: 200,
    effectiveTokens: 7_500,
    costUsd: null,
    costUnavailableModels: ['deepseek-chat'],
    estimatedSavingsTokens: 3_400,
    estimatedSavingsUsd: null,
    overheadTokens: 900,
    unobservedSessions: 1,
  },
  mechanisms: {
    microskills: { injectedFacts: 3, pendingCandidates: 2, tokensPerRequest: 180 },
    toolprune: { hiddenTools: 4, savedTokensPerRequest: 950 },
    loopguard: { incidents: 2, redirects: 1, judgeCalls: 2, judgeTokens: 500 },
  },
  budget: { sessionTokens: 4_200, sessionLimit: 30_000, turnTokens: 800, overheadTokens: 120 },
  notes: ['Raw token counts come from the provider.'],
}

const skills = {
  ok: true,
  project: { id: 'p1', root: '/work/alpha' },
  confirmed: [
    { id: 'f1', kind: 'env', text: 'Use pnpm, not npm.', status: 'confirmed', confirmations: 3, sessionsSeen: 2, createdAt: null, updatedAt: null, lastSeenAt: null, source: 'extractor', sensitive: false },
  ],
  candidates: [
    { id: 'f2', kind: 'test', text: 'Run vitest before commit.', status: 'candidate', confirmations: 1, sessionsSeen: 1, createdAt: null, updatedAt: null, lastSeenAt: null, source: 'extractor', sensitive: false },
  ],
  retired: [],
  meta: { maxFacts: 12, maxTokens: 700, retireDays: 90, injectionEnabled: false, totalTokens: 20 },
}

const tools = {
  ok: true,
  project: { id: 'p1', root: '/work/alpha' },
  mode: 'observe',
  enabled: true,
  entries: [
    { name: 'read', descriptionTokens: 20, calls: 10, sessions: 3, errors: 0, lastUsedAt: null, lastAvailableAt: null, status: 'active', reason: 'used recently', evidence: { sessions: 3, calls: 10, sessionsRequired: 3, callsRequired: 3 } },
    { name: 'browser', descriptionTokens: 300, calls: 0, sessions: 0, errors: 0, lastUsedAt: null, lastAvailableAt: null, status: 'hidden', reason: 'never used', evidence: { sessions: 0, calls: 0, sessionsRequired: 3, callsRequired: 3 } },
  ],
  hidden: ['browser'],
  protected: ['read', 'write', 'bash'],
  estimatedHiddenTokens: 300,
  lastAuditAt: null,
  notes: ['Statistics are per project and per tool name.'],
}

const loops = {
  ok: true,
  project: { id: 'p1', root: '/work/alpha' },
  incidents: [
    {
      id: 'i1',
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 's1',
      rootSessionId: 's1',
      projectId: 'p1',
      turn: 7,
      step: 4,
      kind: 'judge-stuck@0.82',
      repeats: 5,
      judge: 'stuck',
      confidence: 0.82,
      intervention: 'nudge',
      nudge: 'Run the failing test first.',
      outcome: 'progress',
      detail: { turns: 21, errorOutputs: 7, editChurn: 5, distinctEditFiles: 3, stagnation: 0.4 },
    },
  ],
  summary: { total: 1, redirected: 1, recovered: 1, judgeCalls: 1, judgeTokens: 300, budgetExhausted: 0 },
  config: { enabled: true, intervene: false, confidence: 0.7, maxInterventions: 1, level: 'default' },
}

const settings = {
  ok: true,
  config: { mode: 'shadow', microskillsInject: false },
  defaults: { mode: 'shadow', microskillsInject: false },
  fields: [
    { key: 'mode', type: 'enum', group: 'general', options: ['off', 'shadow', 'active'] },
    { key: 'microskillsInject', type: 'boolean', group: 'microskills' },
    { key: 'maxFacts', type: 'number', group: 'microskills', min: 1, max: 50 },
  ],
  compatibility: status.plugin.compatibility,
  writable: true,
  revision: 3,
  notes: [],
}

function makeApi() {
  const updates = []
  const skillActions = []
  const toolActions = []
  const api = {
    config: () => settings.config,
    status: () => status,
    overview: () => ({ ok: true, status, sessions: { observed: 2, subagentSessions: 1, attributedRoots: 1, unobserved: 1 }, recent: [], loops: { incidents: 2, lastIncidentAt: null }, measurement: ['Cost needs prices.'] }),
    skills: () => skills,
    tools: () => tools,
    loops: () => loops,
    settings: () => settings,
    projects: () => ({ ok: true, projects: [], storageRoot: '/home/u/.dsh/token-economizer' }),
    skillsAction: async (payload) => { skillActions.push(payload); return { changed: 1, data: skills } },
    toolsAction: async (payload) => { toolActions.push(payload); return { changed: 1, data: tools } },
    loopsAction: async () => ({ changed: 1, data: loops }),
    updateSettings: async (patch) => { updates.push(patch); return { ...settings, config: { ...settings.config, ...patch } } },
    setMode: async (mode) => mode,
    updates,
    skillActions,
    toolActions,
  }
  return api
}

function invoke(command, rawInput) {
  const agent = { id: 's1', session: { header: { cwd: '/work/alpha' } } }
  return command.handler({ agent, rawInput })
}

test('status reports mode, project, estimates and cost honesty', async () => {
  const api = makeApi()
  const command = createEconomizerCommand({ api })
  const result = await invoke(command, 'status')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /mode: SHADOW/)
  assert.match(result.text, /\/work\/alpha/)
  assert.match(result.text, /estimates only/)
  assert.match(result.text, /unavailable \(no price table entry\)/)
})

test('on selects shadow, off selects off, mode active is explicit', async () => {
  const api = makeApi()
  const command = createEconomizerCommand({ api })
  assert.match((await invoke(command, 'on')).text, /shadow mode/)
  assert.match((await invoke(command, 'off')).text, /OFF/)
  assert.equal(api.updates[0].mode, 'shadow')
  assert.equal(api.updates[1].mode, 'off')
  const active = await invoke(command, 'mode active')
  assert.match(active.text, /ACTIVE/)
  assert.match(active.text, /individual switches/)
})

test('mode rejects unknown values and help is available', async () => {
  const command = createEconomizerCommand({ api: makeApi() })
  assert.equal((await invoke(command, 'mode turbo')).kind, 'error')
  assert.match((await invoke(command, 'help')).text, /Usage: \/economizer/)
})

test('skills list marks injection state and review explains confirmation', async () => {
  const command = createEconomizerCommand({ api: makeApi() })
  const list = await invoke(command, 'skills list')
  assert.match(list.text, /Injection: off/)
  assert.match(list.text, /f1/)
  assert.match(list.text, /f2/)
  const review = await invoke(command, 'skills review')
  assert.match(review.text, /Confirm only facts you have verified/)
})

test('skills confirm requires an id and reports the change', async () => {
  const api = makeApi()
  const command = createEconomizerCommand({ api })
  assert.equal((await invoke(command, 'skills confirm')).kind, 'error')
  const confirmed = await invoke(command, 'skills confirm f2')
  assert.equal(confirmed.kind, 'success')
  assert.deepEqual(api.skillActions, [{ action: 'confirm', ids: ['f2'] }])
})

test('tools status shows hidden tools; restore all works; invalid mode fails', async () => {
  const api = makeApi()
  const command = createEconomizerCommand({ api })
  const state = await invoke(command, 'tools status')
  assert.match(state.text, /Hidden \(1\): browser/)
  assert.match(state.text, /observe = statistics only/)
  const restored = await invoke(command, 'tools restore')
  assert.equal(restored.kind, 'success')
  assert.deepEqual(api.toolActions[0], { action: 'restoreAll' })
  assert.equal((await invoke(command, 'tools mode chaos')).kind, 'error')
})

test('loops history renders signals, judge and redirect text', async () => {
  const command = createEconomizerCommand({ api: makeApi() })
  const history = await invoke(command, 'loops history 5')
  assert.match(history.text, /turn 7/)
  assert.match(history.text, /judge stuck/)
  assert.match(history.text, /confidence 0.82/)
  assert.match(history.text, /Run the failing test first/)
})

test('config prints resolved values and persists valid typed values', async () => {
  const api = makeApi()
  const command = createEconomizerCommand({ api })
  const printed = await invoke(command, 'config')
  assert.match(printed.text, /"mode": "shadow"/)
  await invoke(command, 'config set microskillsInject=true')
  assert.deepEqual(api.updates.at(-1), { microskillsInject: true })
  await invoke(command, 'config set maxFacts=6')
  assert.deepEqual(api.updates.at(-1), { maxFacts: 6 })
  assert.equal((await invoke(command, 'config set unknown=1')).kind, 'error')
  assert.equal((await invoke(command, 'config set microskillsInject=maybe')).kind, 'error')
})

test('on never downgrades an active configuration to shadow', async () => {
  const api = makeApi()
  api.config = () => ({ ...settings.config, mode: 'active' })
  const command = createEconomizerCommand({ api })
  const result = await invoke(command, 'on')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /ACTIVE/)
  assert.doesNotMatch(result.text, /is ON in shadow/)
  assert.equal(api.updates.length, 0, 'an explicit active choice is not rewritten by on')
})
