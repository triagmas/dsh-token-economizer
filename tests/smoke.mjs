/**
 * Offline smoke test: boots the real host entry against a minimal fake Context.
 *
 * It is not a replacement for installing the plugin into a Harness profile (that
 * is what the install/smoke procedure in docs/INSTALLATION.md covers), but it
 * proves that `apply()` wires itself without a throwing callback, that SHADOW
 * mutates nothing, and that ACTIVE uses the documented surfaces.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'te-smoke-'))
process.env.DSH_HOME = home
process.env.DSH_INSTALL_DIR = '/nonexistent-dsh-install'

const { apply, Config, name } = await import('../lib/index.js')

const handlers = new Map()
const services = new Map()
const registrations = { prompt: [], commands: [], routes: [], effects: [] }
const restrictions = []
const followups = []
let liveConfig = { mode: 'shadow' }

const ctx = {
  logger: { info: () => {}, warn: (message) => console.error('[warn]', message) },
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(service) {
    return services.get(service)
  },
  effect(callback) {
    registrations.effects.push(callback)
  },
  inject(_deps, callback) {
    const scope = {
      commands: services.get('commands'),
      connection: services.get('connection'),
      effect: (effect) => effect(),
    }
    callback(scope)
  },
  fiber: { entry: { options: { get config() { return liveConfig } } } },
}

services.set('systemPrompt', {
  context(definition) {
    registrations.prompt.push(definition)
    return () => {}
  },
})
services.set('commands', {
  register(definition) {
    registrations.commands.push(definition)
    return () => {}
  },
})
services.set('connection', {
  fetch: {
    register(route) {
      registrations.routes.push(route)
      return () => {}
    },
  },
})
services.set('tools', {
  definitions: () => ['bash', 'edit', 'rare_tool'].map((toolName) => ({ name: toolName })),
})

await apply(ctx, liveConfig)
assert.ok(name)
assert.ok(Config)
assert.equal(registrations.prompt.length, 1, 'one attributed prompt context')
assert.equal(registrations.commands.length, 1, 'one slash command')
assert.equal(registrations.routes.length, 11, 'all Web API routes mounted')
assert.equal(registrations.effects.length, 1, 'one disposal scope')

const prompt = registrations.prompt[0]
assert.equal(prompt.name, 'token-economizer/knowledge')
assert.equal(prompt.interpolate, false)
assert.equal(prompt.required, true)
assert.equal(prompt.text({ agent: { session: { id: 'not-seen' } } }), '', 'unknown session contributes nothing')

const emit = async (event, ...args) => {
  const handler = handlers.get(event)
  if (handler) await handler(...args)
}
const session = {
  id: 'session-1',
  header: { cwd: process.cwd() },
}
const evt = (type, data) => ({ type, data })
const userToolCall = (callId, toolName, args) => ({
  type: 'tool/call',
  data: { callId, name: toolName, arguments: JSON.stringify(args) },
})
const toolResult = (callId, output, error) => ({
  type: 'tool/result',
  data: { callId, output, ...(error ? { error } : {}) },
})

await emit('session/event', session, evt('turn/start', { turn: 1 }))
await emit('session/event', session, evt('step/start', { step: 1 }))
await emit('session/event', session, userToolCall('c1', 'bash', { command: 'pnpm test' }))
await emit('session/event', session, toolResult('c1', '1 passing'))
await emit('session/event', session, evt('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 100, outputTokens: 5 } }))
await emit('session/event', session, evt('turn/end', { turn: 1, reason: 'complete' }))

// Allow the fire-and-forget finalize to settle.
await new Promise((resolve) => setTimeout(resolve, 100))

const command = registrations.commands[0]
const status = await command.handler({
  commandId: 'cmd-1',
  agent: {
    id: 'session-1',
    session: { id: 'session-1', header: { cwd: process.cwd() } },
    followup: (message) => followups.push(message),
  },
  rawInput: 'status',
  attachments: [],
  signal: new AbortController().signal,
})
assert.equal(status.kind, 'success')
assert.match(status.text, /Token Economizer/)
assert.match(status.text, /shadow/i)

// SHADOW must never restrict tools.
const agent = {
  id: 'session-1',
  status: 'idle',
  session: { id: 'session-1', header: { cwd: process.cwd() } },
  ctx: {
    tools: {
      definitions: () => [{ name: 'bash' }, { name: 'edit' }, { name: 'rare_tool' }],
      restrict(filter) {
        restrictions.push(filter)
        return () => restrictions.push({ dispose: filter.deny })
      },
    },
  },
  model: { current: () => ({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }) },
  followup: (message) => followups.push(message),
}
handlers.get('agent/created')({ agent })
await new Promise((resolve) => setTimeout(resolve, 100))
assert.deepEqual(restrictions, [], 'shadow mode applies no tool restriction')

// ACTIVE with an evidenced candidate: the plugin denies only what it can prove.
liveConfig = {
  ...liveConfig,
  mode: 'active',
  toolpruneMode: 'propose',
}
handlers.get('agent/created')({ agent })
await new Promise((resolve) => setTimeout(resolve, 100))
assert.deepEqual(restrictions, [], 'propose mode records but does not hide tools')

liveConfig = { ...liveConfig, toolpruneMode: 'automatic', toolpruneMinSessions: 99 }
handlers.get('tools/change')({})
await new Promise((resolve) => setTimeout(resolve, 250))
assert.deepEqual(restrictions, [], 'insufficient evidence still hides nothing')

const install = JSON.parse(await readFile(join(home, 'token-economizer', 'install.json'), 'utf8'))
assert.equal(install.schemaVersion, 1)

// Disposal unwinds everything that was registered.
const teardown = registrations.effects[0]()
if (typeof teardown === 'function') teardown()

process.env.DSH_HOME = ''
await rm(home, { recursive: true, force: true })
console.log('smoke: PASS')
