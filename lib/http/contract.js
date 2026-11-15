/**
 * Wire contract between the Host HTTP routes and the WebUI client.
 *
 * Both sides are local plugins in the same package, but the client is a plain
 * browser artifact that cannot import this module. Keep the JSON shapes here
 * authoritative and mirrored in `client/index.js`.
 *
 * All routes live under `/api/token-economizer`, are owner-authenticated by
 * DSH Connection, and return `{ ok: true, ... }` or
 * `{ ok: false, error: { code, message } }`.
 */
export const API_PREFIX = '/api/token-economizer';
/**
 * Route summary (all owner-authenticated, all `no-store`):
 *
 *   GET  /status?sessionId=&cwd=
 *   GET  /overview?sessionId=&cwd=
 *   GET  /skills?sessionId=&cwd=
 *   GET  /tools?sessionId=&cwd=
 *   GET  /loops?sessionId=&cwd=
 *   GET  /settings
 *   GET  /projects
 *   POST /skills/action   { action: 'confirm'|'reject'|'delete'|'clearCandidates', ids?: string[] }
 *   POST /tools/action    { action: 'restore'|'restoreAll'|'setMode', names?: string[], mode?: WirePruneMode }
 *   POST /loops/action    { action: 'clear' }
 *   POST /settings        { patch: Record<string, unknown> }
 *   POST /mode            { mode: WireMode }
 *
 * Errors use stable codes: BAD_REQUEST, UNKNOWN_PROJECT, FORBIDDEN_PATH,
 * NOT_WRITABLE, STORE_ERROR, INTERNAL.
 */
export const ERROR_CODES = [
    'BAD_REQUEST',
    'UNKNOWN_PROJECT',
    'FORBIDDEN_PATH',
    'NOT_WRITABLE',
    'STORE_ERROR',
    'INTERNAL',
];
