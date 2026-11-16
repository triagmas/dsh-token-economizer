/**
 * `/economizer` command surface.
 *
 * The command is deliberately explicit: `on` enables observation (shadow),
 * while applying changes requires `mode active` or an individual mechanism
 * switch. Destructive review actions print what will happen and require an id.
 */
import type { CommandInvocation, CommandResult } from './command-types.js'
import type { EconomizerApi, ProjectScopeInput } from './service-api.js'

const HELP = [
  'Usage: /economizer <command>',
  '',
  '  status                     current mode, project, counters and compatibility',
  '  on | off                   enable in shadow (ACTIVE is kept) or turn the plugin off',
  '  mode shadow|active|off     select the operating mode (active applies changes)',
  '  report                     detailed token and mechanism report',
  '',
  '  skills list                confirmed facts and pending candidates',
  '  skills review              review pending candidates with ids',
  '  skills confirm <id>        promote one reviewed candidate',
  '  skills reject <id>         discard one candidate',
  '  skills clear               discard every pending candidate',
  '',
  '  tools status               hidden tools and pruning mode',
  '  tools restore [name]       restore one tool, or every hidden tool',
  '  tools mode observe|propose|automatic',
  '',
  '  loops history [n]          recent loop-guard incidents (default 10)',
  '  config                     resolved configuration as JSON',
  '  config set <key>=<value>   persist one configuration value',
].join('\n')

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

function error(text: string): CommandResult {
  return { kind: 'error', text }
}

function scope(agent: CommandInvocation['agent']): ProjectScopeInput {
  const header = (agent.session as { header?: { cwd?: unknown } }).header
  const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
  return { sessionId: String(agent.id), cwd }
}

function tokens(value: number): string {
  if (!Number.isFinite(value)) return 'n/a'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)}k`
  return String(Math.round(value))
}

function money(value: number | null): string {
  return value === null ? 'unavailable (no price table entry)' : `$${value.toFixed(4)} (estimate)`
}

export interface CommandDeps {
  api: EconomizerApi
  logger?: { warn(message: string): void }
}

/** Build the command definition. */
export function createEconomizerCommand(deps: CommandDeps) {
  const { api } = deps
  return {
    name: 'economizer',
    description: 'Token Economizer status, modes, micro-skills, tool pruning and loop-guard history.',
    input: { hint: 'status | on | off | mode active | skills review | tools status | loops history | config' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const raw = invocation.rawInput.trim()
      const [command = 'status', ...rest] = raw.split(/\s+/).filter(Boolean)
      const input = scope(invocation.agent)
      try {
        switch (command.toLowerCase()) {
          case 'status':
            return success(await renderStatus(api, input))
          case 'on': {
            const current = await api.config()
            if (current.mode === 'active') {
              return success('Token Economizer is already ON in ACTIVE mode. "/economizer on" does not downgrade it; use "/economizer mode shadow" to stop applying changes.')
            }
            await api.updateSettings({ mode: 'shadow' })
            return success('Token Economizer is ON in shadow mode: it observes and reports but does not change prompts or tools.\nUse "/economizer mode active" to apply optimizations.')
          }
          case 'off': {
            await api.updateSettings({ mode: 'off' })
            return success('Token Economizer is OFF. Nothing is observed, injected or hidden. Stored facts and statistics are kept.')
          }
          case 'mode':
            return await modeCommand(api, rest[0])
          case 'report':
            return success(await renderReport(api, input))
          case 'skills':
            return await skillsCommand(api, input, rest)
          case 'tools':
            return await toolsCommand(api, input, rest)
          case 'loops':
            return success(await renderLoops(api, input, rest))
          case 'config':
            return await configCommand(api, rest)
          case 'help':
          case '--help':
          case '-h':
            return success(HELP)
          default:
            return error(`Unknown command "${command}".\n\n${HELP}`)
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        deps.logger?.warn(`token-economizer: command failed: ${message}`)
        return error(`Token Economizer command failed: ${message}`)
      }
    },
  }

  async function renderStatus(apiRef: EconomizerApi, inputScope: ProjectScopeInput): Promise<string> {
    const status = await apiRef.status(inputScope)
    const lines = [
      `Token Economizer ${status.plugin.version} — mode: ${status.mode.toUpperCase()}`,
      status.plugin.compatibility.ok ? '' : `Compatibility: ${status.plugin.compatibility.reason}`,
      status.project ? `Project: ${status.project.root}` : 'Project: unknown for this session (no workspace root observed yet)',
      '',
      `Micro-skills: ${status.mechanisms.microskills.injectedFacts} injected fact(s), ${status.mechanisms.microskills.pendingCandidates} pending candidate(s), ${tokens(status.mechanisms.microskills.tokensPerRequest)} tokens/request`,
      `Tool pruning: ${status.mechanisms.toolprune.hiddenTools} hidden tool(s), ~${tokens(status.mechanisms.toolprune.savedTokensPerRequest)} tokens/request saved (estimate)`,
      `Loop guard: ${status.mechanisms.loopguard.incidents} incident(s), ${status.mechanisms.loopguard.redirects} redirect(s), ${status.mechanisms.loopguard.judgeCalls} judge call(s)`,
      '',
      `Observed requests: ${status.totals.modelRequests}; input ${tokens(status.totals.inputTokens)}, output ${tokens(status.totals.outputTokens)}, effective ${status.totals.effectiveTokens === null ? 'n/a' : tokens(status.totals.effectiveTokens)}`,
      `Estimated savings: ${tokens(status.totals.estimatedSavingsTokens)} tokens, ${money(status.totals.estimatedSavingsUsd)} — estimates only`,
      `Cost: ${money(status.totals.costUsd)}${status.totals.costUnavailableModels.length ? `; unpriced models: ${status.totals.costUnavailableModels.join(', ')}` : ''}`,
    ].filter((line) => line !== '')
    if (!status.effective.microskills && !status.effective.toolprune && !status.effective.loopguard) {
      lines.push('', 'No mechanism is applying changes in the current mode.')
    }
    for (const note of status.notes) lines.push(`Note: ${note}`)
    return lines.join('\n')
  }

  async function renderReport(apiRef: EconomizerApi, inputScope: ProjectScopeInput): Promise<string> {
    const overview = await apiRef.overview(inputScope)
    const skills = overview.status.mechanisms.microskills
    const pruning = overview.status.mechanisms.toolprune
    const guard = overview.status.mechanisms.loopguard
    const lines = [
      'Token Economizer report',
      '=======================',
      `Mode: ${overview.status.mode}`,
      `Project: ${overview.status.project?.root ?? 'unknown'}`,
      `Sessions observed: ${overview.sessions.observed}; subagent sessions: ${overview.sessions.subagentSessions}; unattributed usage: ${overview.sessions.unobserved}`,
      '',
      'Measured (provider-reported):',
      `  requests ${overview.status.totals.modelRequests}, input ${tokens(overview.status.totals.inputTokens)}, output ${tokens(overview.status.totals.outputTokens)}, cache read ${tokens(overview.status.totals.cacheReadTokens)}, cache write ${tokens(overview.status.totals.cacheWriteTokens)}`,
      '',
      'Estimated:',
      `  effective tokens ${overview.status.totals.effectiveTokens === null ? 'unavailable (unknown model)' : tokens(overview.status.totals.effectiveTokens)}`,
      `  cost ${money(overview.status.totals.costUsd)}`,
      `  savings ${tokens(overview.status.totals.estimatedSavingsTokens)} tokens / ${money(overview.status.totals.estimatedSavingsUsd)}`,
      '',
      'Mechanisms:',
      `  micro-skills: ${skills.injectedFacts} confirmed injected, ${skills.pendingCandidates} pending, ${tokens(skills.tokensPerRequest)} tokens/request`,
      `  tool pruning: ${pruning.hiddenTools} hidden, ${tokens(pruning.savedTokensPerRequest)} tokens/request saved (estimate)`,
      `  loop guard: ${guard.incidents} incidents, ${guard.redirects} redirects, ${guard.judgeCalls} judge calls (${tokens(guard.judgeTokens)} tokens, counted as overhead)`,
      `  overhead: ${tokens(overview.status.totals.overheadTokens)} tokens`,
      '',
      'Measurement notes:',
      ...(overview.measurement.length ? overview.measurement.map((line) => `  - ${line}`) : ['  - none']),
    ]
    return lines.join('\n')
  }

  async function skillsCommand(apiRef: EconomizerApi, inputScope: ProjectScopeInput, rest: string[]): Promise<CommandResult> {
    const action = (rest[0] ?? 'list').toLowerCase()
    if (action === 'list' || action === 'review') {
      const data = await apiRef.skills(inputScope)
      const lines = [
        `Micro-skills — ${data.project?.root ?? 'project unknown'}`,
        `Injection: ${data.meta.injectionEnabled ? 'on' : 'off'}; token budget ${data.meta.totalTokens}/${data.meta.maxTokens}; max facts ${data.meta.maxFacts}`,
        '',
        `Confirmed (${data.confirmed.length}):`,
        ...(data.confirmed.length ? data.confirmed.map((fact) => `  ${fact.id}  [${fact.kind}] ${oneLine(fact.text)} (${fact.confirmations} confirmations, ${fact.sessionsSeen} sessions)`) : ['  none']),
        '',
        `Pending candidates (${data.candidates.length}):`,
        ...(data.candidates.length ? data.candidates.map((fact) => `  ${fact.id}  [${fact.kind}] ${oneLine(fact.text)} (${fact.confirmations} confirmation(s))`) : ['  none']),
      ]
      if (data.retired.length) lines.push('', `Retired: ${data.retired.length}`)
      if (action === 'review' && data.candidates.length) {
        lines.push('', 'Confirm only facts you have verified: /economizer skills confirm <id>; discard with skills reject <id>.')
      }
      if (!data.confirmed.length && !data.candidates.length) lines.push('', 'No facts yet. Facts are extracted from repeated, verified failures and their resolutions.')
      return success(lines.join('\n'))
    }
    if (action === 'confirm' || action === 'reject') {
      const id = rest[1]
      if (!id) return error(`Usage: /economizer skills ${action} <id>`)
      const outcome = await apiRef.skillsAction({ action, ids: [id] }, inputScope)
      if (outcome.changed === 0) return error(`No pending candidate with id "${id}".`)
      return success(`Candidate ${id} ${action === 'confirm' ? 'confirmed and eligible for injection' : 'rejected and removed'}.`)
    }
    if (action === 'clear') {
      const outcome = await apiRef.skillsAction({ action: 'clearCandidates' }, inputScope)
      return success(`Removed ${outcome.changed} pending candidate(s). Confirmed facts were kept.`)
    }
    return error('Usage: /economizer skills list|review|confirm <id>|reject <id>|clear')
  }

  async function toolsCommand(apiRef: EconomizerApi, inputScope: ProjectScopeInput, rest: string[]): Promise<CommandResult> {
    const action = (rest[0] ?? 'status').toLowerCase()
    if (action === 'status') {
      const data = await apiRef.tools(inputScope)
      const lines = [
        `Tool pruning — mode ${data.mode}${data.enabled ? '' : ' (disabled)'}`,
        `Project: ${data.project?.root ?? 'unknown'}`,
        `Mode behaviour: observe = statistics only; propose = report candidates, no restriction; automatic = hide eligible tools.`,
        `Hidden (${data.hidden.length}): ${data.hidden.join(', ') || 'none'}`,
        `Protected: ${data.protected.join(', ') || 'none'}`,
        `Estimated hidden definition tokens per request: ${tokens(data.estimatedHiddenTokens)} (estimate)`,
        '',
        ...data.entries.map((tool) => `  ${tool.status === 'hidden' ? '-' : ' '} ${tool.name.padEnd(24)} calls ${String(tool.calls).padStart(4)}  sessions ${String(tool.sessions).padStart(3)}  errors ${String(tool.errors).padStart(3)}  ${tool.status}`),
      ]
      for (const note of data.notes) lines.push(`Note: ${note}`)
      return success(lines.join('\n'))
    }
    if (action === 'restore') {
      const name = rest[1]
      const outcome = await apiRef.toolsAction(name ? { action: 'restore', names: [name] } : { action: 'restoreAll' }, inputScope)
      if (outcome.changed === 0) return error(name ? `Tool "${name}" is not currently hidden.` : 'No tools are hidden.')
      return success(name ? `Restored ${name}.` : `Restored ${outcome.changed} hidden tool(s).`)
    }
    if (action === 'mode') {
      const mode = rest[1]
      if (mode !== 'observe' && mode !== 'propose' && mode !== 'automatic') {
        return error('Usage: /economizer tools mode observe|propose|automatic')
      }
      await apiRef.toolsAction({ action: 'setMode', mode }, inputScope)
      return success(`Tool pruning mode set to ${mode}.`)
    }
    return error('Usage: /economizer tools status|restore [name]|mode <mode>')
  }

  async function renderLoops(apiRef: EconomizerApi, inputScope: ProjectScopeInput, rest: string[]): Promise<string> {
    const requested = Number(rest[1] ?? rest[0] ?? 10)
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 100) : 10
    const data = await apiRef.loops(inputScope)
    const lines = [
      `Loop guard — ${data.summary.total} incident(s), ${data.summary.redirected} redirect(s), ${data.summary.recovered} recovery(ies), ${data.summary.judgeCalls} judge call(s)`,
      `Judge tokens counted as overhead: ${tokens(data.summary.judgeTokens)}; budget-exhausted decisions: ${data.summary.budgetExhausted}`,
      '',
    ]
    if (!data.incidents.length) {
      lines.push('No incidents recorded for this project.')
      return lines.join('\n')
    }
    for (const incident of [...data.incidents].slice(-limit).reverse()) {
      const detail = incident.detail
      lines.push(
        `${incident.at}  turn ${incident.turn}  ${incident.kind}  judge ${incident.judge}${incident.confidence === null ? '' : ` (confidence ${incident.confidence.toFixed(2)})`}  intervention ${incident.intervention}  outcome ${incident.outcome}`,
        `  signals: turns ${num(detail.turns)}, failures ${num(detail.errorOutputs)}, repeat signatures ${incident.repeats}, edit churn ${num(detail.editChurn)}, distinct files ${num(detail.distinctEditFiles)}, stagnation ${num(detail.stagnation)}`,
      )
      if (incident.nudge) lines.push(`  redirect: ${oneLine(incident.nudge)}`)
    }
    return lines.join('\n')
  }

  async function modeCommand(apiRef: EconomizerApi, mode: string | undefined): Promise<CommandResult> {
    if (mode !== 'off' && mode !== 'shadow' && mode !== 'active') {
      return error('Usage: /economizer mode shadow|active|off\n  shadow = observe only (default); active = apply configured optimizations; off = do nothing.')
    }
    const applied = await apiRef.setMode(mode)
    const detail = applied === 'active'
      ? 'Active mode applies only mechanisms whose individual switches are enabled.'
      : applied === 'shadow'
        ? 'Shadow mode observes and reports; it never changes prompts, tools or turns and never calls the judge.'
        : 'Off mode records nothing new; stored facts and statistics are kept.'
    return success(`Token Economizer mode: ${applied.toUpperCase()}\n${detail}`)
  }

  async function configCommand(apiRef: EconomizerApi, rest: string[]): Promise<CommandResult> {
    if ((rest[0] ?? '').toLowerCase() !== 'set') {
      const current = await apiRef.settings()
      return success(JSON.stringify(current.config, null, 2))
    }
    const assignment = rest.slice(1).join(' ')
    const index = assignment.indexOf('=')
    if (index <= 0) return error('Usage: /economizer config set <key>=<value>')
    const key = assignment.slice(0, index).trim()
    const rawValue = assignment.slice(index + 1).trim()
    const settings = await apiRef.settings()
    const field = settings.fields.find((entry) => entry.key === key)
    if (!field) return error(`Unknown configuration key "${key}". Run /economizer config to list the resolved values.`)
    const value = parseValue(field.type, rawValue)
    if (value === undefined) return error(`Value "${rawValue}" is not valid for ${key} (${field.type}).`)
    await apiRef.updateSettings({ [key]: value })
    return success(`${key}=${JSON.stringify(value)} saved. Volatile fields apply immediately.`)
  }

  function parseValue(type: string, raw: string): unknown {
    if (type === 'boolean') {
      if (raw === 'true' || raw === 'on' || raw === '1') return true
      if (raw === 'false' || raw === 'off' || raw === '0') return false
      return undefined
    }
    if (type === 'number') {
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    if (type === 'array') {
      return raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    }
    return raw
  }
}

function num(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'n/a'
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat
}
