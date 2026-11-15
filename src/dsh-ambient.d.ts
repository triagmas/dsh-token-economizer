/**
 * Ambient declarations for the three DeepSeek Harness packages this plugin
 * imports at runtime. They are resolved from the running Harness installation
 * (the profile exposes them), so the plugin does not declare them as npm
 * dependencies and never bundles a second copy.
 */
declare module '@deepseek-ai/schemastery' {
  interface SchemaInstance {
    (data?: unknown, options?: unknown): any
    default(value: unknown): SchemaInstance
    description(text: string): SchemaInstance
    min(value: number): SchemaInstance
    max(value: number): SchemaInstance
    step(value: number): SchemaInstance
    hidden(value?: boolean): SchemaInstance
    disabled(value?: boolean): SchemaInstance
    role(text: string, extra?: unknown): SchemaInstance
    extra(key: string, value: unknown): SchemaInstance
    volatile(): SchemaInstance
  }
  interface SchemaFactory {
    string(): SchemaInstance
    number(): SchemaInstance
    boolean(): SchemaInstance
    array(inner: SchemaInstance | string | number | boolean): SchemaInstance
    dict(inner: SchemaInstance | string | number | boolean): SchemaInstance
    union(list: readonly unknown[]): SchemaInstance
    const(value: string | number | boolean): SchemaInstance
    object(dict: Record<string, SchemaInstance | string | number | boolean>): SchemaInstance
    any(): SchemaInstance
  }
  const z: SchemaFactory
  export default z
  export { z }
}

declare module '@deepseek-ai/dsh-llm' {
  export interface TokenUsage {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  export function createUserMessage(input: {
    content: Array<{ type: 'text'; text: string }>
    source?: { kind: string } & Record<string, unknown>
  }): any
}
