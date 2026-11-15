import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { SessionObserver } from '../lib/dsh/session-observer.js'

function session(id, overrides = {}) {
  return { id, header: { version: 1, id, createdAt: '2026-01-01T00:00:00.000Z', ...overrides } }
}

function harness() {
  const summaries = []
  const toolResults = []
  const sessions = []
  const hooks = {
    availableTools: () => [{ name: 'read', descriptionTokens: 20 }],
    onSession: (observed) => sessions.push(observed),
    onTurnStart: () => {},
    onToolResult: (_observed, record) => toolResults.push(record),
    onAssistantText: () => {},
    onModelCall: () => {},
    onTurnEnd: (summary) => summaries.push(summary),
  }
  return { observer: new SessionObserver(hooks), summaries, toolResults, sessions }
}

test('pairs tool calls with results and accumulates provider usage per turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'te-observer-'))
  try {
    await mkdir(join(root, 'repo'), { recursive: true })
    const main = session('s-main', { cwd: join(root, 'repo') })
    const { observer, summaries, toolResults, sessions } = harness()

    observer.handle(main, { type: 'turn/start', time: 1_000, data: { turn: 1 } })
    observer.handle(main, {
      type: 'tool/call',
      time: 1_001,
      data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"src/index.ts"}' },
    })
    observer.handle(main, {
      type: 'tool/result',
      time: 1_010,
      data: {
        turn: 1,
        step: 1,
        message: { isError: false, source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'file body' }] },
      },
    })
    observer.handle(main, {
      type: 'assistant/message',
      time: 1_020,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5 },
        message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'Done.' }] },
      },
    })
    observer.handle(main, { type: 'turn/end', time: 1_030, data: { turn: 1, reason: 'completed' } })

    assert.equal(sessions.length, 1)
    assert.equal(toolResults.length, 1)
    assert.equal(toolResults[0].name, 'read')
    assert.equal(toolResults[0].output, 'file body')
    assert.equal(summaries.length, 1)
    const summary = summaries[0]
    assert.equal(summary.partial, false)
    assert.equal(summary.calls.length, 1)
    assert.equal(summary.modelCalls.length, 1)
    assert.equal(summary.modelCalls[0].model, 'deepseek-chat')
    assert.equal(summary.usage.inputTokens, 100)
    assert.equal(summary.usage.outputTokens, 20)
    assert.equal(summary.usage.cacheReadTokens, 40)
    assert.equal(summary.session.availableTools.length, 1)
    assert.equal(summary.endedAt, new Date(1_030).toISOString())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unmatched results and malformed events never throw or invent calls', async () => {
  const { observer, summaries, toolResults } = harness()
  const main = session('s-odd')
  observer.handle(main, { type: 'tool/result', time: 1, data: { message: { source: { callId: 'missing' }, content: [] } } })
  observer.handle(main, { type: 'unknown/future-event', time: 2, data: {} })
  observer.handle(main, null)
  observer.handle(null, {})
  observer.handle(main, { type: 'turn/end', time: 3, data: {} })
  assert.equal(toolResults.length, 0)
  assert.equal(summaries.length, 0, 'no invented turn without data')
})

test('subagent sessions inherit the root session and never add tool availability', async () => {
  const { observer, sessions } = harness()
  const main = session('s-root', { cwd: '/tmp/repo-main' })
  const child = session('s-child', { cwd: '/tmp/repo-main', parentSession: 's-root', origin: 'subagent', delegationDepth: 1 })
  const grandchild = session('s-grand', { cwd: '/tmp/repo-main', parentSession: 's-child', origin: 'subagent', delegationDepth: 2 })

  observer.handle(main, { type: 'turn/start', time: 1, data: { turn: 1 } })
  observer.handle(child, { type: 'turn/start', time: 2, data: { turn: 1 } })
  observer.handle(grandchild, { type: 'turn/start', time: 3, data: { turn: 1 } })

  const byId = Object.fromEntries(sessions.map((entry) => [entry.sessionId, entry]))
  assert.equal(byId['s-root'].rootSessionId, 's-root')
  assert.equal(byId['s-child'].rootSessionId, 's-root')
  assert.equal(byId['s-grand'].rootSessionId, 's-root', 'grandchild resolves to the root, not the parent')
  assert.equal(byId['s-child'].isSubagent, true)
  assert.equal(byId['s-child'].availableTools.length, 0, 'subagent availability is inherited, not counted twice')
})

test('tool output is redacted and bounded before it leaves the observer', async () => {
  const { observer, toolResults } = harness()
  const main = session('s-secret')
  observer.handle(main, { type: 'turn/start', time: 1, data: { turn: 1 } })
  observer.handle(main, { type: 'tool/call', time: 2, data: { callId: 'c9', name: 'bash', arguments: '{}' } })
  observer.handle(main, {
    type: 'tool/result',
    time: 3,
    data: {
      message: {
        isError: true,
        source: { callId: 'c9' },
        content: [{ type: 'text', text: `API key sk-abcdefghijklmnopqrstuvwxyz and ${'y'.repeat(10_000)}` }],
      },
    },
  })
  assert.equal(toolResults.length, 1)
  assert.doesNotMatch(toolResults[0].output, /sk-abcdefghijklmnopqrstuvwxyz/)
  assert.ok(Buffer.byteLength(toolResults[0].output, 'utf8') <= 2_040, 'bounded output plus the truncation marker')
  assert.equal(toolResults[0].isError, true)
})

test('flush emits a partial summary for an interrupted turn', async () => {
  const { observer, summaries } = harness()
  const main = session('s-interrupted')
  observer.handle(main, { type: 'assistant/message', time: 5, data: { usage: { inputTokens: 7, outputTokens: 3 }, message: { source: { model: 'm' }, content: [] } } })
  observer.flush()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].partial, true)
  assert.equal(summaries[0].usage.inputTokens, 7)
})
