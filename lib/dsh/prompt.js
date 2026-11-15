const CONTEXT_ORDER = 300;
/**
 * Register the knowledge context for this plugin's lifetime.
 *
 * The provider is evaluated at every assembly and admission refresh, so a mode
 * or fact change is picked up without re-registering. `interpolate: false`
 * keeps literal `{{...}}` and `$` sequences from user text untouched.
 */
export function registerKnowledgeContext(systemPrompt, source, config, logger) {
    return systemPrompt.context({
        name: 'token-economizer/knowledge',
        order: CONTEXT_ORDER,
        required: true,
        interpolate: false,
        text: (assembly) => {
            try {
                const resolved = config();
                if (!resolved.microskillsEnabled || !resolved.microskillsInject)
                    return '';
                if (resolved.mode === 'off')
                    return '';
                return source.render(assembly.agent);
            }
            catch (error) {
                logger?.warn(`token-economizer: knowledge context failed: ${error instanceof Error ? error.message : String(error)}`);
                return '';
            }
        },
    });
}
