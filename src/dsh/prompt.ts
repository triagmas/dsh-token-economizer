/**
 * Model-facing knowledge injection.
 *
 * Confirmed project facts are shipped as a dynamic prompt *context*, not as a
 * system-policy section: the Harness materializes registered contexts into a
 * durable user-role snapshot, so the model treats them as information rather
 * than instructions it must obey. The text is always attributed to the Token
 * Economizer and never contains tool output, prompts, or secrets.
 */
import type { ResolvedConfig } from '../config/schema.js'

/** The subset of the Harness system-prompt service used here. */
export interface SystemPromptService {
  context(context: {
    name: string
    order: number
    text: string | ((context: { agent?: unknown }) => string)
    interpolate?: boolean
    required?: boolean
  }): () => void
}

const CONTEXT_ORDER = 300

export interface KnowledgeSource {
  /** Render the current confirmed-fact block for one agent, or '' when nothing applies. */
  render(agent: unknown): string
}

/**
 * Register the knowledge context for this plugin's lifetime.
 *
 * The provider is evaluated at every assembly and admission refresh, so a mode
 * or fact change is picked up without re-registering. `interpolate: false`
 * keeps literal `{{...}}` and `$` sequences from user text untouched.
 */
export function registerKnowledgeContext(
  systemPrompt: SystemPromptService,
  source: KnowledgeSource,
  config: () => ResolvedConfig,
  logger?: { warn(message: string): void },
): () => void {
  return systemPrompt.context({
    name: 'token-economizer/knowledge',
    order: CONTEXT_ORDER,
    required: true,
    interpolate: false,
    text: (assembly) => {
      try {
        const resolved = config()
        if (!resolved.microskillsEnabled || !resolved.microskillsInject) return ''
        if (resolved.mode === 'off') return ''
        return source.render(assembly.agent)
      } catch (error) {
        logger?.warn(`token-economizer: knowledge context failed: ${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  })
}
