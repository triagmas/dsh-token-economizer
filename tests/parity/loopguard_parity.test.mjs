/**
 * Parity: the TypeScript loop-guard port vs. the pinned upstream TokenEconomizer.
 *
 * The vectors are generated from the real Python package by
 * `generate_loopguard_vectors.py`; this test replays them against the compiled port. If the
 * vector file has not been generated the test skips (it is generated output, not a fixture to
 * hand-edit).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_THRESHOLDS,
  SPIRAL_LEVELS,
  scaledThresholds,
  assessAbort,
  gateForJudge,
  isStuck,
  nudgeText,
  parseJudgeReply,
  SpiralState,
  TurnGuard,
  basename,
  canonTool,
  failureSignature,
  runnerVerdict,
  statusOfTests,
  exitStatusCovers,
} from '../../lib/loopguard/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectorPath = join(here, 'loopguard_vectors.json')
const hasVectors = existsSync(vectorPath)
const vectors = hasVectors ? JSON.parse(readFileSync(vectorPath, 'utf8')) : null

function fakeState(stateVector) {
  return {
    turns: stateVector.turns ?? 0,
    editChurn: stateVector.edit_churn ?? 0,
    distinctEditFiles: stateVector.distinct_edit_files ?? 0,
    errorOutputs: stateVector.error_outputs ?? 0,
    testRuns: stateVector.test_runs ?? 0,
    repeatedFailSigs: stateVector.repeated_fail_sigs ?? 0,
    stagnation: stateVector.stagnation ?? 0,
    editCounts: new Map(Object.entries(stateVector.edit_counts ?? {})),
    recentDigest: () => 'DIGEST',
  }
}

test('parity vectors exist and match the pinned commit', { skip: !hasVectors }, () => {
  assert.equal(vectors.upstream_commit, '7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0')
})

test('thresholds match upstream (defaults, levels, scaled)', { skip: !hasVectors }, () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, vectors.thresholds.default)
  for (const [level, expected] of Object.entries(vectors.thresholds.levels)) {
    assert.deepEqual(SPIRAL_LEVELS[level], expected, `level ${level}`)
  }
  for (const [level, expected] of Object.entries(vectors.thresholds.scaled)) {
    assert.deepEqual(scaledThresholds(level), expected, `scaled ${level}`)
  }
})

test('gate_for_judge matches upstream', { skip: !hasVectors }, () => {
  for (const [i, c] of vectors.gate_for_judge.entries()) {
    assert.equal(gateForJudge(fakeState(c.state)), c.expected, `gate case ${i}`)
  }
})

test('is_stuck matches upstream (productive hard task is spared)', { skip: !hasVectors }, () => {
  for (const [i, c] of vectors.is_stuck.entries()) {
    assert.equal(isStuck(fakeState(c.state)), c.expected, `stuck case ${i}`)
  }
})

test('assess_abort cascade matches upstream', { skip: !hasVectors }, () => {
  const judges = {
    high: () => ({ stuck: true, confidence: 0.72, reason: 'same failure repeating' }),
    low: () => ({ stuck: true, confidence: 0.69, reason: 'maybe' }),
    productive: () => ({ stuck: false, confidence: 0.9, reason: 'narrowing the failure' }),
    raises: () => {
      throw new Error('runner down')
    },
  }
  for (const c of vectors.assess_abort) {
    const thr = c.thresholds === 'default' ? scaledThresholds('default') : scaledThresholds(c.thresholds)
    const judge = c.judge ? judges[c.judge] : null
    const actual = assessAbort(fakeState(c.state), c.envelope, judge, thr)
    assert.deepEqual(actual, c.expected, c.label)
  }
})

test('judge reply typing is excluded from the parity vectors', { skip: !hasVectors }, () => {
  // The vectors feed typed verdicts straight into assessAbort. Raw judge JSON is not a
  // parity surface: upstream applies Python bool(), which would read "false" as stuck.
  // This port requires a real boolean and treats every other type as ambiguous.
  assert.equal(parseJudgeReply('{"stuck": "false"}').stuck, null)
  assert.equal(parseJudgeReply('{"stuck": 1}').stuck, null)
  assert.equal(parseJudgeReply('{"stuck": true}').stuck, true)
})

test('nudge_text matches upstream', { skip: !hasVectors }, () => {
  assert.equal(nudgeText(fakeState(vectors.nudge_text.state)), vectors.nudge_text.expected)
})

test('runner_verdict matches upstream', { skip: !hasVectors }, () => {
  for (const c of vectors.runner_verdict) {
    assert.equal(runnerVerdict(c.text), c.expected, c.text)
  }
})

test('status_of_tests matches upstream', { skip: !hasVectors }, () => {
  for (const c of vectors.status_of_tests) {
    assert.equal(statusOfTests(c.cmd), c.expected, c.cmd)
  }
})

test('exit_status_covers matches upstream', { skip: !hasVectors }, () => {
  for (const c of vectors.exit_status_covers) {
    assert.equal(exitStatusCovers(c.cmd), c.expected, c.cmd)
  }
})

test('SpiralState fold, snapshot, dict and digest match upstream', { skip: !hasVectors }, () => {
  const st = new SpiralState()
  for (const update of vectors.state.updates) {
    st.update(update.name, update.args, update.result, update.failed)
  }
  assert.deepEqual(st.snapshot(), vectors.state.snapshot)
  assert.deepEqual(
    {
      turns: st.turns,
      edit_counts: Object.fromEntries(st.editCounts),
      edit_order: st.editOrder,
      error_outputs: st.errorOutputs,
      test_runs: st.testRuns,
      fail_sigs: Object.fromEntries(st.failSigs),
      repeated_fail_sigs: st.repeatedFailSigs,
      recent: st.recent,
    },
    vectors.state.dict,
  )
  assert.equal(st.recentDigest({ n: 24, envelope: 12 }), vectors.state.digest_envelope_12)
  assert.equal(st.recentDigest({ n: 24 }), vectors.state.digest_no_envelope)
})

test('failure signatures, canon and basename match upstream', { skip: !hasVectors }, () => {
  for (const c of vectors.state.failure_signatures) {
    assert.equal(failureSignature(c.text), c.expected, c.text)
  }
  for (const c of vectors.state.canon) {
    assert.equal(canonTool(c.name), c.expected, c.name)
  }
  for (const [input, expected] of Object.entries(vectors.state.basename)) {
    assert.equal(basename(input), expected, input)
  }
})

test('TurnGuard transitions match upstream call by call', { skip: !hasVectors }, () => {
  const t = vectors.transitions
  const thr = scaledThresholds(t.thresholds)
  const guard = new TurnGuard({ turnKey: t.turn_key })
  for (const [i, call] of t.calls.entries()) {
    const decision = guard.fold(call.name, call.args, call.result, call.exit_code, {
      envelope: t.envelope,
      thr,
      judge: null,
      nudgeBudget: 1,
    })
    let nudge = null
    if (decision && decision.action === 'nudge') {
      nudge = guard.nudgeBody(t.envelope)
      guard.afterNudge()
    }
    const expected = t.steps[i]
    assert.deepEqual(
      decision ? { action: decision.action, reason: decision.reason } : null,
      expected.decision ? { action: expected.decision[0], reason: expected.decision[1] } : null,
      `decision at call ${i}`,
    )
    assert.equal(nudge, expected.nudge, `nudge at call ${i}`)
    assert.deepEqual(guard.toDict(), expected.dict, `dict at call ${i}`)
  }
  assert.deepEqual(guard.summary(), t.summary)
})

test('parity vector file is regenerable (generator present)', () => {
  assert.ok(existsSync(join(here, 'generate_loopguard_vectors.py')))
})
