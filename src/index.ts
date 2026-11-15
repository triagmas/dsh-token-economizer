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
import { randomUUID } from 'node:crypto'

import { findRepoRoot } from './core/paths.js'
import { Store } from './storage/store.js'
import { checkCompatibility, detectDshVersion } from './dsh/version.js'
import { ModelJudge } from './dsh/judge.js'
import { SessionObserver, type TurnSummary } from './dsh/session-observer.js'
import { ToolCatalog, applyToolRestriction } from './dsh/tools.js'
import { createEconomizerCommand } from './plugin/commands.js'
import { EconomizerService } from './plugin/service.js'
import { registerRoutes } from './http/routes.js'
import { resolveConfig, Config } from './config/schema.js'

export { Config }

export const name = 'token-economizer'
export const version = '0.1.0'

type AnyRecord = Record<string, unknown>

interface InjectedScope {
  commands: { register(definition: unknown): () => void }
  effect(fn: () => (() => void) | void, label?: string): void
}

interface LoggerLike {
  info?(message: string): void
  warn(message: string): void
  debug?(message: string): void
}

interface ServicesLike {
  on(event: string, listener: (...args: unknown[]) => void): () => void
  get(name: string): unknown
  effect(callback: () => void | (() => void)): void
  inject?(names: string[], callback: (child: ServicesLike) => void): void
  logger?: LoggerLike
  fiber?: { entry?: { options?: { config?: AnyRecord } } }
}

interface AgentSessionLike {
  id?: string
  header?: { cwd?: string; parentSession?: string; origin?: string; delegationDepth?: number }
}

interface AgentLike {
  session: AgentSessionLike
  ctx: { tools: { definitions(scope?: unknown): readonly { name?: unknown }[]; restrict(filter: { deny: string[] }): () => void } }
  model?: { current?(): { provider?: string; model?: string } | undefined }
  followup?(message: unknown): void
  status?: string
}

interface Binding {
  agent: AgentLike
  sessionId: string
  root: string | null
  deny: string[]
  disposeTools: (() => void) | null
}

const LOG_PREFIX = 'token-economizer:'

function warn(logger: LoggerLike | undefined, message: string): void {
  try {
    logger?.warn(`${LOG_PREFIX} ${message}`)
  } catch {
    /* logging must never throw */
  }
}

function info(logger: LoggerLike | undefined, message: string): void {
  try {
    logger?.info?.(`${LOG_PREFIX} ${message}`)
  } catch {
    /* ignore */
  }
}

/** A user-role message carrying the plugin's own attribution. */
function redirectMessage(text: string): AnyRecord {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Read one session id from an agent, tolerating older shapes. */
function sessionIdOf(agent: AgentLike): string {
  const id = agent.session?.id
  return typeof id === 'string' ? id : ''
}

/** Root workspace for an agent session, inherited from the parent when absent. */
function rootOf(agent: AgentLike, roots: Map<string, string | null>): string | null {
  const header = agent.session?.header
  if (header?.cwd) {
    try {
      return findRepoRoot(header.cwd).root
    } catch {
      /* fall through */
    }
  }
  const parent = typeof header?.parentSession === 'string' ? header.parentSession : ''
  if (parent) return roots.get(parent) ?? null
  return null
}

/**
 * Plugin application. Async because the storage root is created and opened here;
 * the Harness awaits it before serving turns.
 */
export async function apply(ctx: ServicesLike, config: AnyRecord = {}): Promise<void> {
  const logger = ctx.logger
  const dshVersion = detectDshVersion()
  const compatibility = checkCompatibility(dshVersion)
  if (!compatibility.ok) {
    warn(
      logger,
      `unsupported DSH version ${dshVersion} (tested ${compatibility.testedRange}); ` +
        'the plugin stays disabled. Install a compatible Harness release or remove the plugin.',
    )
    return
  }

  const store = new Store(process.env)
  await store.open(version, dshVersion)

  // Live configuration: volatile fields are refs resolved on every read.
  const rawConfig = (): AnyRecord => {
    try {
      const current = ctx.fiber?.entry?.options?.config
      if (current && typeof current === 'object') return current
    } catch {
      /* ignore */
    }
    return config
  }

  const writeConfig = async (patch: AnyRecord): Promise<void> => {
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor') as
      | { edit(entry: unknown, transform: (current: AnyRecord) => AnyRecord): Promise<unknown> }
      | undefined
    if (!entry || !editor?.edit) throw new Error('configuration is not writable in this context')
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
  }

  const llm = ctx.get('llm') as { stream(options: AnyRecord): AsyncIterable<unknown> } | undefined
  const judge =
    llm && typeof llm.stream === 'function'
      ? new ModelJudge({
          llm,
          config: () => resolveConfig(rawConfig()),
          logger: { warn: (message) => warn(logger, message), debug: () => undefined },
        })
      : null

  const bindings = new Map<string, Binding>()
  const bySession = new Map<string, Binding>()
  const roots = new Map<string, string | null>()
  let reconciling: ReturnType<typeof setTimeout> | null = null

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
      const binding = bySession.get(sessionId)
      if (!binding?.agent.followup) return false
      if (binding.agent.status === 'disposed') return false
      try {
        binding.agent.followup(redirectMessage(text))
        return true
      } catch (error) {
        warn(logger, `could not deliver a loop redirect: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    onToolsChanged: (root) => scheduleReconcile(root),
    revision: null,
  })

  const tools = ctx.get('tools') as
    | { definitions(scope?: unknown): readonly { name?: unknown; description?: unknown; parameters?: unknown }[] }
    | undefined
  const catalog = tools ? new ToolCatalog(tools as never) : null

  /** Recompute one binding's deny set and re-apply the restriction. */
  async function reconcile(binding: Binding): Promise<void> {
    const deny = await service.denySetForSession(binding.sessionId)
    if (sameList(deny, binding.deny)) return
    const known = binding.agent.ctx.tools.definitions(binding.agent).map((definition) => String(definition.name ?? ''))
    binding.disposeTools?.()
    binding.disposeTools = null
    const applied = applyToolRestriction(binding.agent as never, deny, known)
    if (applied.applied.length) binding.disposeTools = applied.dispose
    binding.deny = applied.applied
  }

  async function reconcileAll(): Promise<void> {
    for (const binding of bindings.values()) {
      try {
        await reconcile(binding)
      } catch (error) {
        warn(logger, `tool reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function scheduleReconcile(root: string): void {
    if (reconciling) return
    reconciling = setTimeout(() => {
      reconciling = null
      void reconcileAll()
    }, 150)
    // Do not keep the process alive for a cosmetic refresh.
    ;(reconciling as { unref?: () => void }).unref?.()
  }

  /** Register the prompt contribution once, globally; empty text contributes nothing. */
  const systemPrompt = ctx.get('systemPrompt') as
    | {
        context(context: {
          name: string
          order: number
          text: (assembly: { agent?: { session?: { id?: string } } }) => string
          interpolate?: boolean
          required?: boolean
        }): () => void
      }
    | undefined
  try {
    systemPrompt?.context({
      name: 'token-economizer/knowledge',
      order: 300,
      interpolate: false,
      required: true,
      text: (assembly) => {
        try {
          const sessionId = assembly?.agent?.session?.id
          return typeof sessionId === 'string' ? service.knowledgeForSession(sessionId) : ''
        } catch {
          return ''
        }
      },
    })
  } catch (error) {
    warn(logger, `prompt context registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const observer = new SessionObserver({
    availableTools: () => (catalog ? catalog.snapshot().map((tool) => ({ name: tool.name, descriptionTokens: tool.descriptionTokens })) : []),
    onSession: (session) => service.observe(session),
    onTurnStart: (session, turn) => service.beginTurn(session, turn),
    onToolResult: (session, record) => service.onToolResult(session, record),
    onAssistantText: (session, text) => service.onAssistantText(session, text),
    onModelCall: () => undefined,
    onTurnEnd: (summary: TurnSummary) => service.onTurnEnd(summary),
  })

  ctx.on('session/event', (session, event) => observer.handle(session, event))

  ctx.on('agent/created', async (payload) => {
    const agent = (payload as { agent?: AgentLike } | undefined)?.agent
    if (!agent) return
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    const root = rootOf(agent, roots)
    roots.set(sessionId, root)
    service.registerRoot(sessionId, root)
    try {
      const route = agent.model?.current?.()
      if (route) service.setSessionRoute(sessionId, { provider: route.provider, model: route.model })
      if (root) await service.warmProject(root)
    } catch (error) {
      warn(logger, `agent setup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const binding: Binding = { agent, sessionId, root, deny: [], disposeTools: null }
    bindings.set(sessionId, binding)
    bySession.set(sessionId, binding)
    void reconcile(binding).catch((error: unknown) => {
      warn(logger, `initial tool reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = (payload as { agent?: AgentLike } | undefined)?.agent
    if (!agent) return
    const sessionId = sessionIdOf(agent)
    const binding = bindings.get(sessionId)
    if (binding) {
      binding.disposeTools?.()
      binding.disposeTools = null
      bindings.delete(sessionId)
      bySession.delete(sessionId)
    }
    roots.delete(sessionId)
  })

  ctx.on('tools/change', () => {
    catalog?.invalidate()
    scheduleReconcile('')
  })

  // Defer service-dependent registration: a plugin can apply before the Host has
  // activated `commands` or `connection`, and `get()` would silently find nothing.
  const injectable = ctx as unknown as {
    inject(deps: string[], callback: (scope: InjectedScope) => void): void
  }

  const command = createEconomizerCommand({ api: service, logger: { warn: (message) => warn(logger, message) } })
  injectable.inject(['commands'], (scope) => {
    try {
      scope.effect(() => scope.commands.register(command), 'token-economizer: /economizer command')
    } catch (error) {
      warn(logger, `command registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // Web settings routes: mounted when the Connection service becomes available.
  try {
    registerRoutes(ctx as never, service, { warn: (message) => warn(logger, message) })
  } catch (error) {
    warn(logger, `HTTP route registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Dispose everything this plugin owns when its effect scope unwinds.
  ctx.effect(
    () => () => {
      if (reconciling) clearTimeout(reconciling)
      for (const binding of bindings.values()) {
        try {
          binding.disposeTools?.()
        } catch {
          /* ignore */
        }
      }
      bindings.clear()
      bySession.clear()
      void service.dispose()
    },
  )

  info(logger, `ready (mode ${resolveConfig(rawConfig()).mode}, dsh ${dshVersion ?? 'unknown'}, storage ${store.root})`)
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false
  return true
}
