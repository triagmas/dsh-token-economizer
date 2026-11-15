/**
 * Pricing parity against the pinned upstream TokenEconomizer.
 *
 * `generate_pricing_vectors.py` runs the upstream Python `effective_tokens`, `weights_for`,
 * `has_breakdown` and `approx_tokens` over every model it knows plus the 1-hour-cache and
 * no-breakdown cases, and writes the expected values to `pricing_vectors.json`.
 *
 * This test replays every vector through the TypeScript port. It SKIPS (rather than fails)
 * when the generated JSON is absent, so a fresh checkout of the plugin still runs its unit
 * tests. Regenerate with:
 *
 *     python3 tests/parity/generate_pricing_vectors.py
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MODEL_WEIGHTS,
  approxTokens,
  effectiveTokens,
  hasBreakdown,
  weightsFor,
} from '../../lib/pricing/weights.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const VECTORS_PATH = join(HERE, 'pricing_vectors.json')

function loadVectors() {
  try {
    return JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.name === 'SyntaxError')) return null
    throw error
  }
}

const data = loadVectors()
const skip = data ? false : 'tests/parity/pricing_vectors.json missing; run generate_pricing_vectors.py'

function normalized(weights) {
  const out = {
    input: weights.input,
    cacheRead: weights.cacheRead,
    cacheWrite: weights.cacheWrite,
    output: weights.output,
  }
  if (typeof weights.cacheWrite1h === 'number') out.cacheWrite1h = weights.cacheWrite1h
  return out
}

function closeEnough(actual, expected) {
  return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected))
}

test('pricing vectors were generated from the pinned upstream commit', { skip }, () => {
  assert.equal(data.upstreamCommit, data.expectedCommit, 'the upstream checkout moved; regenerate the vectors')
  assert.equal(data.generatedBy, 'tests/parity/generate_pricing_vectors.py')
  assert.equal(data.vectorCount, data.vectors.length)
  assert.ok(data.vectors.length >= 100)
})

test('effective tokens match upstream for every model and usage shape', { skip }, () => {
  const failures = []
  for (const vector of data.vectors) {
    const record = { model: vector.model, ...vector.usage }
    const actual = effectiveTokens(record)
    if (actual === null || !closeEnough(actual, vector.expected.effectiveTokens)) {
      failures.push(
        `${vector.id}: expected ${vector.expected.effectiveTokens}, got ${actual}; usage=${JSON.stringify(vector.usage)}`,
      )
    }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${data.vectors.length} effective-token vectors differ`)
})

test('has_breakdown matches upstream for every usage shape', { skip }, () => {
  for (const vector of data.vectors) {
    assert.equal(
      hasBreakdown({ model: vector.model, ...vector.usage }),
      vector.expected.hasBreakdown,
      vector.id,
    )
  }
})

test('weight tables match upstream exactly (1-hour cache write included)', { skip }, () => {
  for (const vector of data.vectors) {
    const weights = weightsFor({ model: vector.model })
    assert.ok(weights, `${vector.id}: model must be priced`)
    assert.deepEqual(normalized(weights), vector.expected.weights, vector.id)
  }
})

test('the vector set covers every model in the TypeScript table', { skip }, () => {
  const covered = new Set(data.vectors.map((vector) => vector.model))
  const missing = Object.keys(MODEL_WEIGHTS).filter((model) => !covered.has(model))
  assert.deepEqual(missing, [], 'MODEL_WEIGHTS gained a model without regenerating parity vectors')
})

test('approx_tokens matches upstream code-point counting', { skip }, () => {
  for (const vector of data.approxVectors) {
    assert.equal(approxTokens(vector.text), vector.expected, JSON.stringify(vector.text))
  }
})

test('the intentional unknown-model deviation is documented by the vectors', { skip }, () => {
  const deviation = data.deviations.unknownModel
  assert.equal(deviation.upstreamRaises, true, 'upstream hard-fails an unpriced model')
  assert.equal(deviation.portEffectiveTokens, null)
  assert.equal(
    effectiveTokens({ model: deviation.model, input_tokens: 1200, output_tokens: 900 }),
    null,
    'the port reports "not measurable" instead of raising or mispricing',
  )
})
