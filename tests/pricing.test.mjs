/**
 * Unit tests for `src/pricing/weights.ts` and `src/metrics/ledger.ts`.
 *
 * Run after a build:  node --test tests/pricing.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_DEFAULT_MODEL,
  MODEL_WEIGHTS,
  WEIGHTS_CLAUDE,
  approxTokens,
  cacheWrite1hTokens,
  effectiveTokens,
  hasBreakdown,
  resolveModel,
  weightsFor,
} from '../lib/pricing/weights.js'
import {
  UNKNOWN_MODEL,
  buildUsageReport,
  costFor,
  modelLabel,
  parsePriceTable,
  summarizeProject,
  summarizeSession,
} from '../lib/metrics/ledger.js'

const BASE = {
  inputTokens: 1000,
  cacheReadTokens: 10000,
  cacheWriteTokens: 1000,
  outputTokens: 500,
}

function closeTo(actual, expected, epsilon = 1e-9, message) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    message ?? `expected ${actual} to be within ${epsilon} of ${expected}`,
  )
}

test('the upstream model table is present with exact per-model ratios', () => {
  assert.ok(Object.keys(MODEL_WEIGHTS).length >= 25)
  assert.deepEqual(MODEL_WEIGHTS['claude-haiku-4-5'], {
    input: 1,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 5,
    cacheWrite1h: 2,
  })
  assert.equal(MODEL_WEIGHTS['gpt-5.3-codex'].cacheRead, 0.0971)
  assert.equal(MODEL_WEIGHTS['gpt-5.3-codex'].cacheWrite, 0)
  assert.equal(MODEL_WEIGHTS['gpt-5.6-sol'].output, 6)
  assert.equal(MODEL_WEIGHTS['gpt-5.6-terra'].cacheWrite, 1.248)
  assert.equal(WEIGHTS_CLAUDE.output, 5)
  assert.equal(AGENT_DEFAULT_MODEL.codex, 'gpt-5.6-sol')
})

test('resolveModel strips router routing and falls back to the agent default', () => {
  assert.equal(resolveModel({ model: 'gpt-5.3-codex' }), 'gpt-5.3-codex')
  assert.equal(resolveModel({ model: 'openrouter/anthropic/claude-haiku-4.5' }), 'claude-haiku-4.5')
  assert.equal(resolveModel({ agent: 'codex' }), 'gpt-5.6-sol')
  assert.equal(resolveModel({ agent: 'CODEX' }), 'gpt-5.6-sol')
  assert.equal(resolveModel({ agent: 'codex', model: 'gpt-5.4' }), 'gpt-5.4')
  assert.equal(resolveModel({ agent: 'claude' }), null)
  assert.equal(resolveModel({}), null)
  assert.equal(resolveModel(null), null)
})

test('weightsFor is exact per id and null for unknown models', () => {
  assert.deepEqual(weightsFor({ model: 'gpt-5.3-codex' }), MODEL_WEIGHTS['gpt-5.3-codex'])
  // A dotted router id resolves through the Claude family curve.
  const dotted = weightsFor({ model: 'claude-opus-4.8' })
  assert.equal(dotted.cacheRead, 0.1)
  assert.equal(dotted.cacheWrite1h, 2)
  const router = weightsFor({ model: 'openrouter/anthropic/claude-haiku-4.5' })
  assert.equal(router.cacheWrite, 1.25)

  assert.equal(weightsFor({ model: 'deepseek-v4.1-flash' }), null, 'unknown models are never priced at 1.0')
  assert.equal(weightsFor({ model: '' }), null)
  assert.equal(weightsFor({ agent: 'claude' }), null)
  assert.equal(weightsFor(null), null)
})

test('hasBreakdown distinguishes a token breakdown from a legacy total', () => {
  assert.equal(hasBreakdown({ inputTokens: 0 }), true)
  assert.equal(hasBreakdown({ input_tokens: 12 }), true)
  assert.equal(hasBreakdown({ tokens_total: 99 }), false)
  assert.equal(hasBreakdown({ inputTokens: null }), false)
  assert.equal(hasBreakdown({}), false)
  assert.equal(hasBreakdown(null), false)
})

test('effectiveTokens applies the cache-aware weights (upstream formula)', () => {
  // 1000*1 + 10000*0.1 + 1000*1.25 + 500*5
  assert.equal(effectiveTokens({ model: 'claude-haiku-4-5', ...BASE }), 5750)

  // The 1-hour share is weighted at 2.0 instead of 1.25.
  assert.equal(cacheWrite1hTokens({ ...BASE, cacheWrite1hTokens: 400 }), 400)
  assert.equal(effectiveTokens({ model: 'claude-haiku-4-5', ...BASE, cacheWrite1hTokens: 400 }), 6050)
  assert.equal(
    effectiveTokens({
      model: 'claude-haiku-4-5',
      ...BASE,
      cache_creation: { ephemeral_1h_input_tokens: 1000 },
    }),
    6500,
    'a fully 1-hour cache write: 1000*1 + 10000*0.1 + 1000*2 + 500*5',
  )

  // A model whose cache writes are free.
  assert.equal(effectiveTokens({ model: 'gpt-5.3-codex', ...BASE }), 5971)
  // Claude family overrides for cache hits.
  assert.equal(effectiveTokens({ model: 'claude-sonnet-5.5', ...BASE }), 5250)
  assert.equal(effectiveTokens({ model: 'claude-fable-5-1', ...BASE }), 5000)
  // Dotted + routed ids use the same curve.
  assert.equal(effectiveTokens({ model: 'claude-opus-4.8', ...BASE }), 5750)
  assert.equal(effectiveTokens({ model: 'openrouter/anthropic/claude-haiku-4.5', ...BASE }), 5750)

  // Explicit weights win (escape hatch for callers that know the model's prices).
  assert.equal(effectiveTokens({ model: 'unknown', ...BASE }, WEIGHTS_CLAUDE), 5750)
  // Explicit null means "model unknown".
  assert.equal(effectiveTokens({ model: 'claude-haiku-4-5', ...BASE }, null), null)
})

test('effectiveTokens reports unknown models instead of guessing', () => {
  assert.equal(effectiveTokens({ model: 'mystery-model', ...BASE }), null)
  assert.equal(effectiveTokens({ ...BASE }), null, 'no model id is genuine evidence debt')
  // Legacy totals still price, because no breakdown was recorded to misprice.
  assert.equal(effectiveTokens({ model: 'mystery-model', tokens_total: 12345 }), 12345)
  assert.equal(effectiveTokens({ tokens_total: 'nope' }), 0)
  assert.equal(effectiveTokens({}), 0)
  // Snake_case rows (upstream parity vectors) work unchanged.
  assert.equal(
    effectiveTokens({
      model: 'claude-haiku-4-5',
      input_tokens: 1000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 1000,
      output_tokens: 500,
    }),
    5750,
  )
})

test('cacheWrite1hTokens clamps to the cache-write total and reads both key styles', () => {
  assert.equal(cacheWrite1hTokens({ ...BASE, cacheWrite1hTokens: 1500 }), 1000)
  assert.equal(cacheWrite1hTokens({ ...BASE, cacheWrite1hTokens: -5 }), 0)
  assert.equal(cacheWrite1hTokens({ ...BASE, cacheCreation: { ephemeral_1h_input_tokens: 250 } }), 250)
  assert.equal(cacheWrite1hTokens({ ...BASE, cache_creation: { ephemeral_1h_input_tokens: 250 } }), 250)
  assert.equal(cacheWrite1hTokens({ ...BASE }), 0)
  assert.equal(cacheWrite1hTokens(null), 0)
})

test('approxTokens follows the Python len-based estimate', () => {
  assert.equal(approxTokens('abcd'), 1)
  assert.equal(approxTokens('abcde'), 1)
  assert.equal(approxTokens('a'.repeat(8)), 2)
  assert.equal(approxTokens(''), 1) // max(1, ...), like upstream
  assert.equal(approxTokens('😀😀😀😀😀'), 1, 'code points, not UTF-16 units')
})

test('parsePriceTable accepts the documented shape and rejects broken tables', () => {
  const table = parsePriceTable(
    JSON.stringify({
      'openai/gpt-5.3-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      'anthropic/claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    }),
  )
  assert.equal(table['openai/gpt-5.3-codex'].output, 10)
  assert.deepEqual(parsePriceTable(''), {})
  assert.deepEqual(parsePriceTable('  \n '), {})

  assert.throws(() => parsePriceTable('{nope'), /not valid JSON/)
  assert.throws(() => parsePriceTable('[]'), /must be a JSON object/)
  assert.throws(() => parsePriceTable('null'), /must be a JSON object/)
  assert.throws(() => parsePriceTable('{"": {"input":1,"output":1,"cacheRead":1,"cacheWrite":1}}'), /empty model key/)
  assert.throws(
    () => parsePriceTable('{"m": {"input":1,"output":1,"cacheRead":1}}'),
    /needs a non-negative finite "cacheWrite"/,
  )
  assert.throws(
    () => parsePriceTable('{"m": {"input":1,"output":1,"cacheRead":1,"cacheWrite":-1}}'),
    /non-negative finite/,
  )
  assert.throws(
    () => parsePriceTable('{"m": {"input":1,"output":1,"cacheRead":1,"cacheWrite":"x"}}'),
    /non-negative finite/,
  )
  assert.throws(() => parsePriceTable('{"m": 3}'), /must be an object/)
})

test('costFor prices exactly per million and ignores the reasoning subset', () => {
  const price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
  // 100*1 + 50*5 + 1000*0.1 + 200*1.25 = 700 -> $0.0007
  closeTo(costFor({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200, reasoningTokens: 20 }, price), 0.0007)
  // Snake_case works too (upstream rows).
  closeTo(costFor({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, price), 0.0007)
  assert.equal(costFor({}, price), 0)
})

/** One `MetricRecord` skeleton with the fields `foldUsage` cares about. */
function record(overrides) {
  return {
    schemaVersion: 1,
    at: '2026-01-01T00:00:00.000Z',
    sessionId: 's1',
    rootSessionId: 's1',
    delegationDepth: 0,
    isSubagent: false,
    projectId: 'p1',
    kind: 'model',
    ...overrides,
  }
}

const CLAUDE_PRICE = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
const GPT_PRICE = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }

test('buildUsageReport folds rows, prices known models, and labels estimates', () => {
  const rows = [
    record({
      at: '2026-01-01T00:00:00.000Z',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200, reasoningTokens: 20, totalTokens: 1370 },
    }),
    record({
      at: '2026-01-01T00:01:00.000Z',
      provider: 'openai',
      model: 'gpt-5.3-codex',
      usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 300 },
    }),
    record({ at: '2026-01-01T00:02:00.000Z', kind: 'tool', tool: 'read', toolOk: false }),
    record({
      at: '2026-01-01T00:03:00.000Z',
      kind: 'skills',
      skillsApplied: 2,
      skillTokens: 300,
      toolsPruned: 2,
    }),
  ]
  const prices = { 'anthropic/claude-haiku-4-5': CLAUDE_PRICE, 'openai/gpt-5.3-codex': GPT_PRICE }
  const report = buildUsageReport(rows, {
    scope: 'project',
    projectId: 'p1',
    prices,
    prunedTools: [
      { name: 'old_a', descriptionTokens: 120 },
      { name: 'old_b', descriptionTokens: 80 },
    ],
  })

  assert.equal(report.scope, 'project')
  assert.equal(report.projectId, 'p1')
  assert.equal(report.sessions, 1)
  assert.equal(report.modelRequests, 2)
  assert.equal(report.toolCalls, 1)
  assert.equal(report.failedToolCalls, 1)
  assert.equal(report.activeSkills, 2)
  assert.equal(report.usage.inputTokens, 300)
  assert.equal(report.usage.outputTokens, 150)
  assert.equal(report.usage.reasoningTokens, 20)
  // 700 (claude: 100 + 100 + 250 + 250) + 1000 (gpt-5.3-codex: 200 + 100*8)
  assert.equal(report.effectiveTokens, 1700)
  closeTo(report.costUsd, 0.0007 + (200 * 1.25 + 100 * 10) / 1_000_000)
  assert.deepEqual(report.costUnavailableModels, [])
  assert.equal(report.prunedTools, 2)
  assert.equal(report.injectedSkillTokens, 300)
  assert.deepEqual(report.estimated, {
    prunedToolTokensPerRequest: 200,
    microskillWasteAvoidedTokens: null,
    loopWasteAvoidedTokens: null,
  })
  assert.equal(report.firstSeenAt, '2026-01-01T00:00:00.000Z')
  assert.equal(report.updatedAt, '2026-01-01T00:03:00.000Z')
})

test('an unpriced or unknown model makes the cost/report null and names the model', () => {
  const rows = [
    record({ provider: 'anthropic', model: 'claude-haiku-4-5', usage: { inputTokens: 100, totalTokens: 100 } }),
    record({ at: '2026-01-01T00:01:00.000Z', provider: 'openai', model: 'mystery-model', usage: { inputTokens: 10, totalTokens: 10 } }),
  ]
  const partial = buildUsageReport(rows, { prices: { 'anthropic/claude-haiku-4-5': CLAUDE_PRICE } })
  assert.equal(partial.costUsd, null)
  assert.deepEqual(partial.costUnavailableModels, ['openai/mystery-model'])
  assert.equal(partial.effectiveTokens, null, 'unknown model also makes effective tokens unknown')

  const priced = buildUsageReport(rows, {
    prices: { 'anthropic/claude-haiku-4-5': CLAUDE_PRICE, 'openai/mystery-model': CLAUDE_PRICE },
  })
  assert.notEqual(priced.costUsd, null, 'the user can price a model the built-in table does not know')
  assert.equal(priced.effectiveTokens, null, 'pricing a model does not make its token weights known')

  const noModel = buildUsageReport([record({ usage: { inputTokens: 5, totalTokens: 5 } })])
  assert.equal(noModel.costUsd, null)
  assert.deepEqual(noModel.costUnavailableModels, [UNKNOWN_MODEL])
  assert.equal(modelLabel({}), UNKNOWN_MODEL)
  assert.equal(modelLabel({ provider: 'openai', model: 'gpt-5' }), 'openai/gpt-5')

  // A legacy total needs no weights, but an unknown model still makes it unverifiable.
  assert.equal(
    buildUsageReport([record({ model: 'mystery-model', usage: { totalTokens: 12345 } })]).effectiveTokens,
    null,
  )
  assert.equal(
    buildUsageReport([record({ model: 'claude-haiku-4-5', usage: { totalTokens: 12345 } })]).effectiveTokens,
    12345,
  )
})

test('a report with no usage is honestly zero, with no missing-price noise', () => {
  const report = buildUsageReport([])
  assert.equal(report.effectiveTokens, 0)
  assert.equal(report.costUsd, 0)
  assert.deepEqual(report.costUnavailableModels, [])
  assert.equal(report.sessions, 0)
  assert.equal(report.firstSeenAt, null)
  assert.equal(report.estimated.prunedToolTokensPerRequest, 0)
})

test('caller-measured savings pass through; absent evidence stays null', () => {
  const rows = [record({ provider: 'anthropic', model: 'claude-haiku-4-5', usage: { inputTokens: 100, totalTokens: 100 } })]
  const measured = buildUsageReport(rows, {
    prices: { 'anthropic/claude-haiku-4-5': CLAUDE_PRICE },
    prunedToolTokensPerRequest: 42,
    microskillWasteAvoidedTokens: 500,
    loopWasteAvoidedTokens: 250,
    injectedSkillTokens: 77,
  })
  assert.equal(measured.estimated.prunedToolTokensPerRequest, 42)
  assert.equal(measured.estimated.microskillWasteAvoidedTokens, 500)
  assert.equal(measured.estimated.loopWasteAvoidedTokens, 250)
  assert.equal(measured.injectedSkillTokens, 77)

  const unmeasured = buildUsageReport(rows, { microskillWasteAvoidedTokens: Number.NaN, loopWasteAvoidedTokens: -1 })
  assert.equal(unmeasured.estimated.microskillWasteAvoidedTokens, null)
  assert.equal(unmeasured.estimated.loopWasteAvoidedTokens, 0, 'measured non-negative clamp')
})

test('summarizeSession and summarizeProject filter exactly', () => {
  const rows = [
    record({ sessionId: 's1', projectId: 'p1', provider: 'anthropic', model: 'claude-haiku-4-5', usage: { inputTokens: 10, totalTokens: 10 } }),
    record({ at: '2026-01-01T00:01:00.000Z', sessionId: 's2', projectId: 'p1', provider: 'anthropic', model: 'claude-haiku-4-5', usage: { inputTokens: 20, totalTokens: 20 } }),
    record({ at: '2026-01-01T00:02:00.000Z', sessionId: 's3', projectId: 'p2', provider: 'anthropic', model: 'claude-haiku-4-5', usage: { inputTokens: 40, totalTokens: 40 } }),
  ]
  const session = summarizeSession(rows, 's2')
  assert.equal(session.scope, 'session')
  assert.equal(session.sessionId, 's2')
  assert.equal(session.projectId, 'p1')
  assert.equal(session.usage.inputTokens, 20)
  assert.equal(session.sessions, 1)

  const project = summarizeProject(rows, 'p1')
  assert.equal(project.scope, 'project')
  assert.equal(project.projectId, 'p1')
  assert.equal(project.usage.inputTokens, 30)
  assert.equal(project.sessions, 2)

  assert.equal(summarizeProject(rows, 'missing').usage.inputTokens, 0)
})
