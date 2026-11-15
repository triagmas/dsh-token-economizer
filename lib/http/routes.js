/**
 * Host HTTP routes for the WebUI.
 *
 * Routes live under the shared DSH Connection `/api` channel: there is no extra
 * web server, no port, and no unauthenticated surface. Every route here is
 * owner-authenticated by the Harness transport and returns `no-store` JSON.
 * The browser never passes a filesystem path that is used directly; an optional
 * `cwd` hint only selects among paths the Host already tracks as project roots.
 */
import { API_PREFIX } from './contract.js';
const MAX_BODY_BYTES = 256 * 1024;
function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
        },
    });
}
function failure(code, message, status = 400) {
    return json({ ok: false, error: { code, message } }, status);
}
async function readBody(request) {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw Object.assign(new Error('Request body is too large.'), { code: 'BAD_REQUEST', status: 413 });
    }
    const raw = request.body;
    if (raw === undefined || raw === null)
        return {};
    let text;
    if (typeof raw === 'string')
        text = raw;
    else if (raw instanceof Uint8Array)
        text = new TextDecoder().decode(raw);
    else if (raw instanceof ArrayBuffer)
        text = new TextDecoder().decode(new Uint8Array(raw));
    else if (typeof raw.getReader === 'function') {
        text = await readStream(raw);
    }
    else
        return {};
    if (text.length > MAX_BODY_BYTES) {
        throw Object.assign(new Error('Request body is too large.'), { code: 'BAD_REQUEST', status: 413 });
    }
    if (!text.trim())
        return {};
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('Request body must be a JSON object.');
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof Error && error.message === 'Request body must be a JSON object.')
            throw error;
        throw Object.assign(new Error('Request body must be valid JSON.'), { code: 'BAD_REQUEST', status: 400 });
    }
}
/** Read a web ReadableStream body, refusing anything above the byte cap. */
async function readStream(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
                await reader.cancel().catch(() => { });
                throw Object.assign(new Error('Request body is too large.'), { code: 'BAD_REQUEST', status: 413 });
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
function scopeOf(url, body) {
    const sessionId = stringOr(body?.sessionId, url.searchParams.get('sessionId'));
    const cwd = stringOr(body?.cwd, url.searchParams.get('cwd'));
    return { sessionId, cwd };
}
function stringOr(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
    }
    return undefined;
}
function idsOf(value) {
    if (!Array.isArray(value))
        return undefined;
    const ids = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
    return ids.length > 0 ? ids : undefined;
}
function isMode(value) {
    return value === 'off' || value === 'shadow' || value === 'active';
}
/** Build the exact route table; exported for tests without a live Harness. */
export function createRoutes(api) {
    const route = (path, methods, handler, buffered = true) => ({
        path: `${API_PREFIX}${path}`,
        methods,
        ...(buffered ? { requestBody: 'buffered' } : {}),
        async fetch(request) {
            try {
                return await handler(new URL(request.url), request);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const code = isCoded(error) ? error.code : 'INTERNAL';
                const status = isCoded(error) && typeof error.status === 'number' ? error.status : 500;
                return failure(code, message, status);
            }
        },
    });
    return [
        route('/status', ['GET'], async (url) => json(await api.status(scopeOf(url)))),
        route('/overview', ['GET'], async (url) => json(await api.overview(scopeOf(url)))),
        route('/skills', ['GET'], async (url) => json(await api.skills(scopeOf(url)))),
        route('/tools', ['GET'], async (url) => json(await api.tools(scopeOf(url)))),
        route('/loops', ['GET'], async (url) => json(await api.loops(scopeOf(url)))),
        route('/projects', ['GET'], async () => json(await api.projects())),
        route('/skills/action', ['POST'], async (url, request) => {
            const body = await readBody(request);
            const action = body.action;
            if (action !== 'confirm' && action !== 'reject' && action !== 'delete' && action !== 'clearCandidates') {
                return failure('BAD_REQUEST', 'Unknown micro-skills action.');
            }
            if (action !== 'clearCandidates' && !idsOf(body.ids)) {
                return failure('BAD_REQUEST', 'This action requires ids.');
            }
            const outcome = await api.skillsAction({ action, ids: idsOf(body.ids) }, scopeOf(url, body));
            return json({ ok: true, changed: outcome.changed, skills: outcome.data });
        }, true),
        route('/tools/action', ['POST'], async (url, request) => {
            const body = await readBody(request);
            const action = body.action;
            if (action !== 'restore' && action !== 'restoreAll' && action !== 'setMode') {
                return failure('BAD_REQUEST', 'Unknown tools action.');
            }
            if (action === 'restore' && !idsOf(body.names))
                return failure('BAD_REQUEST', 'restore requires names.');
            const mode = body.mode;
            if (action === 'setMode' && (mode !== 'observe' && mode !== 'propose' && mode !== 'automatic')) {
                return failure('BAD_REQUEST', 'setMode requires a valid mode.');
            }
            const outcome = await api.toolsAction({ action, names: idsOf(body.names), mode: action === 'setMode' ? mode : undefined }, scopeOf(url, body));
            return json({ ok: true, changed: outcome.changed, tools: outcome.data });
        }, true),
        route('/loops/action', ['POST'], async (url, request) => {
            const body = await readBody(request);
            if (body.action !== 'clear')
                return failure('BAD_REQUEST', 'Unknown loop action.');
            const outcome = await api.loopsAction({ action: 'clear' }, scopeOf(url, body));
            return json({ ok: true, changed: outcome.changed, loops: outcome.data });
        }, true),
        route('/settings', ['GET', 'POST'], async (_url, request) => {
            if ((request.method ?? 'GET').toUpperCase() === 'GET')
                return json(await api.settings());
            const body = await readBody(request);
            const patch = body.patch;
            if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
                return failure('BAD_REQUEST', 'patch must be an object.');
            }
            return json(await api.updateSettings(patch));
        }, true),
        route('/mode', ['POST'], async (_url, request) => {
            const body = await readBody(request);
            if (!isMode(body.mode))
                return failure('BAD_REQUEST', 'mode must be off, shadow, or active.');
            const mode = await api.setMode(body.mode);
            return json({ ok: true, mode });
        }, true),
    ];
}
function isCoded(error) {
    return typeof error === 'object' && error !== null && typeof error.code === 'string';
}
/** Register every route once the Connection service exists. */
export function registerRoutes(ctx, api, logger) {
    ctx.inject(['connection'], (scope) => {
        const connection = scope.connection;
        if (!connection?.fetch?.register) {
            logger?.warn('connection.fetch is unavailable; Web settings API not mounted');
            return;
        }
        for (const route of createRoutes(api)) {
            try {
                scope.effect(() => connection.fetch.register(route), `token-economizer: ${route.path}`);
            }
            catch (error) {
                logger?.warn(`HTTP route ${route.path} registration failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    });
}
