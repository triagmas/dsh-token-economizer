/**
 * Host entry for `dsh-token-economizer`.
 *
 * The only file that touches Harness services. Everything it learns arrives as
 * session events, everything it changes goes through an explicit, reversible
 * Harness API:
 *
 *  - micro-skills  -> one dynamic prompt context (attributed, read-only text)
 *  - tool pruning  -> `agent.ctx.tools.restrict({ deny })` with an exact disposer
 *  - loop guard    -> an extra user-role turn carrying a bounded redirect
 *  - memory        -> JSON files under `$DSH_HOME/token-economizer/`
 *
 * Failure policy: every callback is fail-open. A thrown plugin error must never
 * stop a turn, hide a tool irreversibly, or break session persistence.
 */
import { randomUUID } from 'node:crypto';
import { findRepoRoot } from './core/paths.js';
import { REDIRECT_MESSAGE_SOURCE } from './core/types.js';
import { Store } from './storage/store.js';
import { checkCompatibility, detectDshVersion } from './dsh/version.js';
import { ModelJudge } from './dsh/judge.js';
import { SessionObserver } from './dsh/session-observer.js';
import { ToolCatalog, applyToolRestriction } from './dsh/tools.js';
import { createEconomizerCommand } from './plugin/commands.js';
import { EconomizerService } from './plugin/service.js';
import { registerRoutes } from './http/routes.js';
import { resolveConfig, Config } from './config/schema.js';
export { Config };
export const name = 'token-economizer';
export const version = '0.1.0';
const LOG_PREFIX = 'token-economizer:';
function warn(logger, message) {
    try {
        logger?.warn(`${LOG_PREFIX} ${message}`);
    }
    catch {
        /* logging must never throw */
    }
}
function info(logger, message) {
    try {
        logger?.info?.(`${LOG_PREFIX} ${message}`);
    }
    catch {
        /* ignore */
    }
}
/** A user-role message carrying the plugin's own attribution. */
function redirectMessage(text) {
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', generatedBy: REDIRECT_MESSAGE_SOURCE },
    };
}
/** Read one session id from an agent, tolerating older shapes. */
function sessionIdOf(agent) {
    const id = agent.session?.id;
    return typeof id === 'string' ? id : '';
}
/** Root workspace for an agent session, inherited from the parent when absent. */
function rootOf(agent, roots) {
    const header = agent.session?.header;
    if (header?.cwd) {
        try {
            return findRepoRoot(header.cwd).root;
        }
        catch {
            /* fall through */
        }
    }
    const parent = typeof header?.parentSession === 'string' ? header.parentSession : '';
    if (parent)
        return roots.get(parent) ?? null;
    return null;
}
/**
 * Plugin application. Async because the storage root is created and opened here;
 * the Harness awaits it before serving turns.
 */
export async function apply(ctx, config = {}) {
    const logger = ctx.logger;
    const dshVersion = detectDshVersion();
    const compatibility = checkCompatibility(dshVersion);
    if (!compatibility.ok) {
        warn(logger, `unsupported DSH version ${dshVersion} (tested ${compatibility.testedRange}); ` +
            'the plugin stays disabled. Install a compatible Harness release or remove the plugin.');
        return;
    }
    const store = new Store(process.env);
    await store.open(version, dshVersion);
    // Live configuration: volatile fields are refs resolved on every read.
    const rawConfig = () => {
        try {
            const current = ctx.fiber?.entry?.options?.config;
            if (current && typeof current === 'object')
                return current;
        }
        catch {
            /* ignore */
        }
        return config;
    };
    const writeConfig = async (patch) => {
        const entry = ctx.fiber?.entry;
        const editor = ctx.get('configEditor');
        if (!entry || !editor?.edit)
            throw new Error('configuration is not writable in this context');
        await editor.edit(entry, (current) => ({ ...current, ...patch }));
    };
    const llm = ctx.get('llm');
    const judge = llm && typeof llm.stream === 'function'
        ? new ModelJudge({
            llm,
            config: () => resolveConfig(rawConfig()),
            logger: { warn: (message) => warn(logger, message), debug: () => undefined },
        })
        : null;
    const bindings = new Map();
    const bySession = new Map();
    const roots = new Map();
    let reconciling = null;
    const service = new EconomizerService({
        store,
        logger: { warn: (message) => warn(logger, message), info: (message) => info(logger, message) },
        pluginVersion: version,
        dshVersion,
        compatibility,
        config: rawConfig,
        writeConfig,
        judge,
        applyRedirect: (sessionId, text) => {
            const binding = bySession.get(sessionId);
            if (!binding)
                return { ok: false, delivery: 'failed' };
            if (binding.agent.status === 'disposed')
                return { ok: false, delivery: 'failed' };
            const message = redirectMessage(text);
            // DSH exposes `agent.steer`, but this port does not call it. `followup` queues
            // the redirect after the current turn, so the guard decision is in-turn but the
            // delivery is not.
            if (!binding.agent.followup)
                return { ok: false, delivery: 'failed' };
            // The guard runs while the host is publishing the tool-result append; calling
            // followup synchronously re-enters that publication and DSH rejects it. Defer one
            // macrotask so the append is complete, and report the queue as delivered.
            setImmediate(() => {
                try {
                    binding.agent.followup?.(message);
                }
                catch (error) {
                    warn(logger, `could not deliver a loop redirect: ${error instanceof Error ? error.message : String(error)}`);
                }
            });
            return { ok: true, delivery: 'followup-degraded' };
        },
        onToolsChanged: (root) => scheduleReconcile(root),
        revision: null,
    });
    const tools = ctx.get('tools');
    const catalog = tools ? new ToolCatalog(tools) : null;
    /** Recompute one binding's deny set and re-apply the restriction. */
    async function reconcile(binding) {
        const deny = await service.denySetForSession(binding.sessionId);
        if (sameList(deny, binding.deny))
            return;
        const known = binding.agent.ctx.tools.definitions(binding.agent).map((definition) => String(definition.name ?? ''));
        binding.disposeTools?.();
        binding.disposeTools = null;
        const applied = applyToolRestriction(binding.agent, deny, known);
        if (applied.applied.length)
            binding.disposeTools = applied.dispose;
        binding.deny = applied.applied;
    }
    async function reconcileAll() {
        for (const binding of bindings.values()) {
            try {
                await reconcile(binding);
            }
            catch (error) {
                warn(logger, `tool reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    function scheduleReconcile(root) {
        if (reconciling)
            return;
        reconciling = setTimeout(() => {
            reconciling = null;
            void reconcileAll();
        }, 150);
        reconciling.unref?.();
    }
    /** Register the prompt contribution once, globally; empty text contributes nothing. */
    const systemPrompt = ctx.get('systemPrompt');
    try {
        systemPrompt?.context({
            name: 'token-economizer/knowledge',
            order: 300,
            interpolate: false,
            required: true,
            text: (assembly) => {
                try {
                    const sessionId = assembly?.agent?.session?.id;
                    return typeof sessionId === 'string' ? service.knowledgeForSession(sessionId) : '';
                }
                catch {
                    return '';
                }
            },
        });
    }
    catch (error) {
        warn(logger, `prompt context registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const observer = new SessionObserver({
        availableTools: () => (catalog ? catalog.snapshot().map((tool) => ({ name: tool.name, descriptionTokens: tool.descriptionTokens })) : []),
        onSession: (session) => service.observe(session),
        onTurnStart: (session, turn) => service.beginTurn(session, turn),
        onToolResult: (session, record) => service.onToolResult(session, record),
        onAssistantText: (session, text) => service.onAssistantText(session, text),
        onModelCall: () => undefined,
        onTurnEnd: (summary) => service.onTurnEnd(summary),
    });
    ctx.on('session/event', (session, event) => observer.handle(session, event));
    ctx.on('agent/created', async (payload) => {
        const agent = payload?.agent;
        if (!agent)
            return;
        const sessionId = sessionIdOf(agent);
        if (!sessionId)
            return;
        const root = rootOf(agent, roots);
        roots.set(sessionId, root);
        service.registerRoot(sessionId, root);
        try {
            const route = agent.model?.current?.();
            if (route)
                service.setSessionRoute(sessionId, { provider: route.provider, model: route.model });
            if (root) {
                await service.warmProject(root);
                // `agent/created` is the only session-start event. Pending automatic hides are
                // applied here, before this new session's first catalog reconcile.
                await service.beginSession(sessionId, root);
            }
        }
        catch (error) {
            warn(logger, `agent setup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const binding = { agent, sessionId, root, deny: [], disposeTools: null };
        bindings.set(sessionId, binding);
        bySession.set(sessionId, binding);
        void reconcile(binding).catch((error) => {
            warn(logger, `initial tool reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
    ctx.on('agent/disposed', (payload) => {
        const agent = payload?.agent;
        if (!agent)
            return;
        const sessionId = sessionIdOf(agent);
        const binding = bindings.get(sessionId);
        if (binding) {
            binding.disposeTools?.();
            binding.disposeTools = null;
            bindings.delete(sessionId);
            bySession.delete(sessionId);
        }
        roots.delete(sessionId);
    });
    ctx.on('tools/change', () => {
        catalog?.invalidate();
        scheduleReconcile('');
    });
    // Defer service-dependent registration: a plugin can apply before the Host has
    // activated `commands` or `connection`, and `get()` would silently find nothing.
    const injectable = ctx;
    const command = createEconomizerCommand({ api: service, logger: { warn: (message) => warn(logger, message) } });
    injectable.inject(['commands'], (scope) => {
        try {
            scope.effect(() => scope.commands.register(command), 'token-economizer: /economizer command');
        }
        catch (error) {
            warn(logger, `command registration failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    // Web settings routes: mounted when the Connection service becomes available.
    try {
        registerRoutes(ctx, service, { warn: (message) => warn(logger, message) });
    }
    catch (error) {
        warn(logger, `HTTP route registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Dispose everything this plugin owns when its effect scope unwinds.
    ctx.effect(() => () => {
        if (reconciling)
            clearTimeout(reconciling);
        for (const binding of bindings.values()) {
            try {
                binding.disposeTools?.();
            }
            catch {
                /* ignore */
            }
        }
        bindings.clear();
        bySession.clear();
        void service.dispose();
    });
    info(logger, `ready (mode ${resolveConfig(rawConfig()).mode}, dsh ${dshVersion ?? 'unknown'}, storage ${store.root})`);
}
function sameList(left, right) {
    if (left.length !== right.length)
        return false;
    for (let index = 0; index < left.length; index += 1)
        if (left[index] !== right[index])
            return false;
    return true;
}
