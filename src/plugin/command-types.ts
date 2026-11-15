/**
 * Minimal structural types for the Harness command registry.
 *
 * Kept local instead of importing `@deepseek-ai/dsh-commands` so the compiled
 * plugin has no runtime or type dependency on a package that may move between
 * DSH 0.2.x patch releases. The shapes mirror the 0.2.2 command contract.
 */
export interface CommandSessionLike {
  header?: { cwd?: unknown }
}

export interface CommandAgentLike {
  id: string
  session: CommandSessionLike
}

export interface CommandInvocation {
  agent: CommandAgentLike
  rawInput: string
  signal?: AbortSignal
}

export type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

export interface CommandDefinition {
  name: string
  description: string
  input?: { hint: string }
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>
}

export interface CommandsService {
  register(definition: CommandDefinition): () => void
}
