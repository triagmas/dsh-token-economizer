/**
 * Host HTTP routes for the WebUI.
 *
 * Routes live under the shared DSH Connection `/api` channel: there is no extra
 * web server, no port, and no unauthenticated surface. Every route here is
 * owner-authenticated by the Harness transport and returns `no-store` JSON.
 * The browser never passes a filesystem path that is used directly; an optional
 * `cwd` hint only selects among paths the Host already tracks as project roots.
 */
import { API_PREFIX, type WireMode } from './contract.js'
import type { EconomizerApi, ProjectScopeInput } from '../plugin/service-api.js'

const MAX_BODY_BYTES = 256 * 1024

interface FetchRequestLike {
  url: string
  method: string
  headers: { get(name: string): string | null }
  body?: unknown
}

interface ConnectionLike {
  fetch: {
    register(route: {
      path: string
      methods: string[]
      requestBody?: 'buffered'
      fetch(request: FetchRequestLike): Promise<Response>
    }): () => void
  }
}

/**
 * The slice of a Cordis context this module needs. `inject` defers work until the
 * named service exists, which matters because plugins can apply before the Host
 * has activated `connection`; `get()` alone would silently mount nothing.
 */
export interface InjectableContext {
  inject(deps: string[], callback: (scope: InjectScope) => void): void
}

export interface InjectScope {
  connection?: ConnectionLike
  effect(fn: () => (() => void) | void, label?: string): void
}

export interface RouteLogger {
  warn(message: string): void
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function failure(code: string, message: string, status = 400): Response {
  return json({ ok: false, error: { code, message } }, status)
}

async function readBody(request: FetchRequestLike): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Request body is too large.'), { code: 'BAD_REQUEST', status: 413 })
  }
  const raw = request.body
  if (raw === undefined || raw === null) return {}
  let text: string
  if (typeof raw === 'string') text = raw
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw)
  else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(raw))
  else if (typeof (raw as { getReader?: unknown }).getReader === 'function') {
    text = await readStream(raw as ReadableStream<Uint8Array>)
  } else return {}
  if (text.length > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Request body is too large.'), { code: 'BAD_REQUEST', status: 413 })
  }
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Request body must be a JSON object.')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message === 'Request body must be a JSON object.') throw error
    throw Object.assign(new Error('Request body must be valid JSON.'), { code: 'BAD_REQUEST', status: 400 })
  }
}

/** Read a web ReadableStream body, refusing anything above the byte cap. */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw Object.assign(new Error('Request body is too large.'), { code: 'BAD_REQUEST', status: 413 })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

function scopeOf(url: URL, body?: Record<string, unknown>): ProjectScopeInput {
  const sessionId = stringOr(body?.sessionId, url.searchParams.get('sessionId'))
  const cwd = stringOr(body?.cwd, url.searchParams.get('cwd'))
  return { sessionId, cwd }
}

function stringOr(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function idsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  return ids.length > 0 ? ids : undefined
}

function isMode(value: unknown): value is WireMode {
  return value === 'off' || value === 'shadow' || value === 'active'
}

/** Reject a cross-origin request and any POST that is not JSON before it reaches the service. */
function guardRequest(request: FetchRequestLike): Response | null {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method === 'POST') {
    const contentType = request.headers.get('content-type') ?? ''
    const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (mediaType !== 'application/json') {
      return failure('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415)
    }
  }
  const origin = request.headers.get('origin')
  if (origin !== null) {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return failure('FORBIDDEN', 'Cross-origin request rejected.', 403)
    }
    let requestHost: string
    try {
      requestHost = new URL(request.url).host
    } catch {
      return failure('FORBIDDEN', 'Cross-origin request rejected.', 403)
    }
    if (originHost !== requestHost) return failure('FORBIDDEN', 'Cross-origin request rejected.', 403)
  }
  return null
}

/** Build the exact route table; exported for tests without a live Harness. */
export function createRoutes(api: EconomizerApi): Array<{
  path: string
  methods: string[]
  requestBody?: 'buffered'
  fetch(request: FetchRequestLike): Promise<Response>
}> {
  const route = (
    path: string,
    methods: string[],
    handler: (url: URL, request: FetchRequestLike) => Promise<Response>,
    buffered = true,
  ) => ({
    path: `${API_PREFIX}${path}`,
    methods,
    ...(buffered ? { requestBody: 'buffered' as const } : {}),
    async fetch(request: FetchRequestLike): Promise<Response> {
      try {
        const blocked = guardRequest(request)
        if (blocked) return blocked
        return await handler(new URL(request.url), request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = isCoded(error) ? error.code : 'INTERNAL'
        const status = isCoded(error) && typeof error.status === 'number' ? error.status : 500
        return failure(code, message, status)
      }
    },
  })

  return [
    route('/status', ['GET'], async (url) => json(await api.status(scopeOf(url)))),
    route('/overview', ['GET'], async (url) => json(await api.overview(scopeOf(url)))),
    route('/skills', ['GET'], async (url) => json(await api.skills(scopeOf(url)))),
    route('/tools', ['GET'], async (url) => json(await api.tools(scopeOf(url)))),
    route('/loops', ['GET'], async (url) => json(await api.loops(scopeOf(url)))),

    route('/projects', ['GET'], async () => json(await api.projects())),
    route(
      '/skills/action',
      ['POST'],
      async (url, request) => {
        const body = await readBody(request)
        const action = body.action
        if (action !== 'confirm' && action !== 'reject' && action !== 'delete' && action !== 'clearCandidates') {
          return failure('BAD_REQUEST', 'Unknown micro-skills action.')
        }
        if (action !== 'clearCandidates' && !idsOf(body.ids)) {
          return failure('BAD_REQUEST', 'This action requires ids.')
        }
        const outcome = await api.skillsAction({ action, ids: idsOf(body.ids) }, scopeOf(url, body))
        return json({ ok: true, changed: outcome.changed, skills: outcome.data })
      },
      true,
    ),
    route(
      '/tools/action',
      ['POST'],
      async (url, request) => {
        const body = await readBody(request)
        const action = body.action
        if (action !== 'restore' && action !== 'restoreAll' && action !== 'setMode') {
          return failure('BAD_REQUEST', 'Unknown tools action.')
        }
        if (action === 'restore' && !idsOf(body.names)) return failure('BAD_REQUEST', 'restore requires names.')
        const mode = body.mode
        if (action === 'setMode' && (mode !== 'observe' && mode !== 'propose' && mode !== 'automatic')) {
          return failure('BAD_REQUEST', 'setMode requires a valid mode.')
        }
        const outcome = await api.toolsAction(
          { action, names: idsOf(body.names), mode: action === 'setMode' ? (mode as 'observe' | 'propose' | 'automatic') : undefined },
          scopeOf(url, body),
        )
        return json({ ok: true, changed: outcome.changed, tools: outcome.data })
      },
      true,
    ),
    route(
      '/loops/action',
      ['POST'],
      async (url, request) => {
        const body = await readBody(request)
        if (body.action !== 'clear') return failure('BAD_REQUEST', 'Unknown loop action.')
        const outcome = await api.loopsAction({ action: 'clear' }, scopeOf(url, body))
        return json({ ok: true, changed: outcome.changed, loops: outcome.data })
      },
      true,
    ),
    route(
      '/settings',
      ['GET', 'POST'],
      async (_url, request) => {
        if ((request.method ?? 'GET').toUpperCase() === 'GET') return json(await api.settings())
        const body = await readBody(request)
        const patch = body.patch
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          return failure('BAD_REQUEST', 'patch must be an object.')
        }
        return json(await api.updateSettings(patch as Record<string, unknown>))
      },
      true,
    ),
    route(
      '/mode',
      ['POST'],
      async (_url, request) => {
        const body = await readBody(request)
        if (!isMode(body.mode)) return failure('BAD_REQUEST', 'mode must be off, shadow, or active.')
        const mode = await api.setMode(body.mode)
        return json({ ok: true, mode })
      },
      true,
    ),
  ]
}

function isCoded(error: unknown): error is { code: string; status?: number } {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
}

/** Register every route once the Connection service exists. */
export function registerRoutes(
  ctx: InjectableContext,
  api: EconomizerApi,
  logger?: RouteLogger,
): void {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection
    if (!connection?.fetch?.register) {
      logger?.warn('connection.fetch is unavailable; Web settings API not mounted')
      return
    }
    for (const route of createRoutes(api)) {
      try {
        scope.effect(() => connection.fetch.register(route), `token-economizer: ${route.path}`)
      } catch (error) {
        logger?.warn(
          `HTTP route ${route.path} registration failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  })
}
