import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoutes, registerRoutes } from '../lib/http/routes.js'
import { API_PREFIX } from '../lib/http/contract.js'

function fakeApi(overrides = {}) {
  const calls = []
  const base = {
    config: () => ({ mode: 'shadow' }),
    status: (input) => { calls.push(['status', input]); return { ok: true, status: true } },
    overview: () => ({ ok: true, overview: true }),
    skills: () => ({ ok: true, skills: true }),
    tools: () => ({ ok: true, tools: true }),
    loops: () => ({ ok: true, loops: true }),
    settings: () => ({ ok: true, config: {}, fields: [] }),
    projects: () => ({ ok: true, projects: [] }),
    skillsAction: async (payload) => { calls.push(['skillsAction', payload]); return { changed: 1, data: { ok: true } } },
    toolsAction: async (payload) => { calls.push(['toolsAction', payload]); return { changed: 1, data: { ok: true } } },
    loopsAction: async (payload) => { calls.push(['loopsAction', payload]); return { changed: 1, data: { ok: true } } },
    updateSettings: async (patch) => { calls.push(['updateSettings', patch]); return { ok: true, config: patch } },
    setMode: async (mode) => { calls.push(['setMode', mode]); return mode },
  }
  return { api: { ...base, ...overrides }, calls }
}

function routeMap(api) {
  return new Map(createRoutes(api).map((route) => [route.path, route]))
}

test('every documented route is registered exactly once', () => {
  const { api } = fakeApi()
  const routes = createRoutes(api)
  const paths = routes.map((route) => route.path)
  assert.equal(new Set(paths).size, paths.length)
  for (const suffix of ['/status', '/overview', '/skills', '/tools', '/loops', '/settings', '/projects', '/skills/action', '/tools/action', '/loops/action', '/mode']) {
    assert.ok(paths.includes(`${API_PREFIX}${suffix}`), suffix)
  }
  for (const route of routes) {
    assert.match(route.path, /^\/api\//, 'routes live below the authenticated /api channel')
    assert.ok(route.methods.length > 0)
    // The Host Connection builds a stream body unless this is set; a GET with a
    // body is a TypeError at the Request constructor, so every route is buffered.
    assert.equal(route.requestBody, 'buffered', route.path)
  }
})

test('GET status forwards the project scope hints', async () => {
  const { api, calls } = fakeApi()
  const routes = routeMap(api)
  const response = await routes.get(`${API_PREFIX}/status`).fetch(
    new Request(`http://localhost${API_PREFIX}/status?sessionId=s-1&cwd=%2Fwork%2Falpha`),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: true, status: true })
  assert.deepEqual(calls[0], ['status', { sessionId: 's-1', cwd: '/work/alpha' }])
})

test('POST bodies are parsed and validated', async () => {
  const { api, calls } = fakeApi()
  const routes = routeMap(api)
  const response = await routes.get(`${API_PREFIX}/skills/action`).fetch(
    new Request(`http://localhost${API_PREFIX}/skills/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'confirm', ids: ['fact-1'], sessionId: 's-1' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal((await response.json()).changed, 1)
  assert.deepEqual(calls[0], ['skillsAction', { action: 'confirm', ids: ['fact-1'] }])
})

test('invalid actions, modes and missing ids are rejected with stable codes', async () => {
  const { api } = fakeApi()
  const routes = routeMap(api)
  const cases = [
    ['/skills/action', { action: 'destroy' }, 'BAD_REQUEST'],
    ['/skills/action', { action: 'confirm' }, 'BAD_REQUEST'],
    ['/tools/action', { action: 'restore' }, 'BAD_REQUEST'],
    ['/tools/action', { action: 'setMode', mode: 'yolo' }, 'BAD_REQUEST'],
    ['/loops/action', { action: 'nope' }, 'BAD_REQUEST'],
    ['/mode', { mode: 'loud' }, 'BAD_REQUEST'],
  ]
  for (const [path, body, code] of cases) {
    const response = await routes.get(`${API_PREFIX}${path}`).fetch(
      new Request(`http://localhost${API_PREFIX}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`)
    const parsed = await response.json()
    assert.equal(parsed.ok, false)
    assert.equal(parsed.error.code, code)
  }
})

test('malformed JSON and oversized bodies are rejected without reaching the service', async () => {
  const { api, calls } = fakeApi()
  const routes = routeMap(api)
  const malformed = await routes.get(`${API_PREFIX}/settings`).fetch(
    new Request(`http://localhost${API_PREFIX}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }),
  )
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'BAD_REQUEST')

  const huge = await routes.get(`${API_PREFIX}/settings`).fetch(
    new Request(`http://localhost${API_PREFIX}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(300_000),
    }),
  )
  assert.ok(huge.status === 413 || huge.status === 400)
  assert.equal(calls.length, 0)
})

test('mode changes and settings patches reach the service', async () => {
  const { api, calls } = fakeApi()
  const routes = routeMap(api)
  const mode = await routes.get(`${API_PREFIX}/mode`).fetch(
    new Request(`http://localhost${API_PREFIX}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'active' }),
    }),
  )
  assert.deepEqual(await mode.json(), { ok: true, mode: 'active' })

  const settings = await routes.get(`${API_PREFIX}/settings`).fetch(
    new Request(`http://localhost${API_PREFIX}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { microskillsInject: true } }),
    }),
  )
  assert.equal(settings.status, 200)
  assert.deepEqual(calls, [
    ['setMode', 'active'],
    ['updateSettings', { microskillsInject: true }],
  ])
})

test('route mounting waits for the Connection service instead of racing apply', () => {
  const { api } = fakeApi()
  let pending
  const ctx = {
    inject(deps, callback) {
      pending = { deps, callback }
    },
  }
  registerRoutes(ctx, api)
  assert.deepEqual(pending.deps, ['connection'])

  const registered = []
  const effects = []
  pending.callback({
    connection: {
      fetch: {
        register(route) {
          registered.push(route)
          return () => {}
        },
      },
    },
    effect(fn, label) {
      effects.push(label)
      fn()
    },
  })

  assert.equal(registered.length, createRoutes(api).length)
  assert.ok(registered.every((route) => route.path.startsWith(API_PREFIX)))
  assert.ok(effects.every((label) => label.startsWith('token-economizer: /api/token-economizer')))
})

test('a missing Connection service is reported, not thrown', () => {
  const warnings = []
  let pending
  const ctx = { inject(_deps, callback) { pending = callback } }
  registerRoutes(ctx, fakeApi().api, { warn: (message) => warnings.push(message) })
  pending({ effect() {} })
  assert.match(warnings[0], /connection\.fetch is unavailable/)
})


test('POST requires application/json', async () => {
  const { api, calls } = fakeApi()
  const routes = routeMap(api)
  for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
    const headers = contentType ? { 'content-type': contentType } : {}
    const response = await routes.get(`${API_PREFIX}/mode`).fetch(
      new Request(`http://localhost${API_PREFIX}/mode`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'active' }),
      }),
    )
    assert.equal(response.status, 415, String(contentType))
    assert.equal((await response.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE')
  }
  assert.equal(calls.length, 0)
})

test('POST accepts application/json with a charset parameter', async () => {
  const { api } = fakeApi()
  const response = await routeMap(api).get(`${API_PREFIX}/mode`).fetch(
    new Request(`http://localhost${API_PREFIX}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'Application/JSON; charset=UTF-8' },
      body: JSON.stringify({ mode: 'active' }),
    }),
  )
  assert.equal(response.status, 200)
})

test('a foreign Origin is rejected with 403', async () => {
  const { api, calls } = fakeApi()
  const routes = routeMap(api)
  const post = await routes.get(`${API_PREFIX}/mode`).fetch(
    new Request(`http://localhost${API_PREFIX}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ mode: 'active' }),
    }),
  )
  assert.equal(post.status, 403)
  assert.equal((await post.json()).error.code, 'FORBIDDEN')

  const get = await routes.get(`${API_PREFIX}/status`).fetch(
    new Request(`http://localhost${API_PREFIX}/status`, { headers: { origin: 'https://evil.example' } }),
  )
  assert.equal(get.status, 403)
  assert.equal(calls.length, 0)
})

test('a same-origin Origin is allowed', async () => {
  const { api } = fakeApi()
  const response = await routeMap(api).get(`${API_PREFIX}/mode`).fetch(
    new Request(`http://localhost${API_PREFIX}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ mode: 'active' }),
    }),
  )
  assert.equal(response.status, 200)
})
