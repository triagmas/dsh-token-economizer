/**
 * Loop-guard behaviour tests (compiled port).
 *
 * Run after building the plugin:
 *   node --test tests/loopguard.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LOOPGUARD_SETTINGS,
  LoopGuardEngine,
  EnvelopeTracker,
  TurnGuard,
  SpiralState,
  assessAbort,
  baseThresholds,
  boundNudge,
  gateForJudge,
  isStuck,
  loadEnvelope,
  parseJudgeReply,
  parseNudgeReply,
  percentile,
  recordTurn,
  runnerVerdict,
  saveEnvelope,
  scaledThresholds,
  stateFromDict,
  stateToDict,
  statusOfTests,
  thresholds,
} from '../lib/loopguard/index.js'

const FAIL =
  'FAILED tests/test_app.py::test_add - AssertionError: 1 != 2\n1 failed in 0.05s'
const PASS = '2 passed in 0.03s'

let seq = 0

function feeder(engine, turn) {
  let step = 0
  return (name, args, output = '', isError = false) => {
    step += 1
    seq += 1
    engine.onToolCall({
      callId: `call-${seq}`,
      name,
      argumentsText: JSON.stringify(args),
      args,
      output,
      isError,
      turn,
      step,
      at: 1_700_000_000_000 + seq,
    })
  }
}

function makeEngine(config = {}, options = {}) {
  return new LoopGuardEngine({
    agentId: 'agent-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    config: { ...DEFAULT_LOOPGUARD_SETTINGS, ...config },
    envelopeSnapshot: { resolved_turns: [10, 10, 10, 10, 10] },
    ...options,
  })
}

function feedSpiral(engine, pairs, feed = feeder(engine, 1)) {
  for (let i = 0; i < pairs; i += 1) {
    feed('edit', { file_path: 'app/core.py' }, '', false)
    feed('bash', { command: 'pytest -q' }, FAIL, true)
  }
  return feed
}

function judgeReplies(replies) {
  const calls = []
  const judgeFn = async (_system, _user, _maxTokens, _signal) => {
    calls.push(Date.now())
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
    if (reply instanceof Error) throw reply
    return reply
  }
  judgeFn.calls = calls
  return judgeFn
}

test('repeat signatures and stagnation are measured from outputs', () => {
  const st = new SpiralState()
  st.update('bash', { command: 'pytest -q' }, FAIL, true)
  st.update('bash', { command: 'pytest -q' }, FAIL, true)
  st.update('bash', { command: 'pytest -q' }, PASS, false)
  assert.equal(st.turns, 3)
  assert.equal(st.errorOutputs, 2)
  assert.equal(st.testRuns, 3)
  assert.equal(st.repeatedFailSigs, 1)
  assert.equal(st.stagnation, 0.5)
  assert.equal(st.failSigs.size, 1)
})

test('a productive hard task is not flagged', () => {
  const st = new SpiralState()
  st.update('edit', { file_path: 'a.py' })
  st.update('edit', { file_path: 'b.py' })
  const failures = [
    'FAILED test_alpha - AssertionError',
    'FAILED test_beta - AssertionError',
    'FAILED test_gamma - AssertionError',
    'FAILED test_delta - AssertionError',
    'FAILED test_epsilon - AssertionError',
    'FAILED test_zeta - AssertionError',
    'FAILED test_eta - AssertionError',
    'FAILED test_theta - AssertionError',
    'FAILED test_iota - AssertionError',
    'FAILED test_kappa - AssertionError',
    'FAILED test_lambda - AssertionError',
    'FAILED test_mu - AssertionError',
  ]
  for (const failure of failures) st.update('bash', { command: 'pytest -q' }, failure, true)
  for (let i = 0; i < 6; i += 1) st.update('bash', { command: 'pytest -q' }, PASS, false)
  assert.equal(st.turns, 20)
  assert.equal(st.editChurn, 1)
  assert.equal(st.distinctEditFiles, 2)
  assert.equal(st.errorOutputs, 12)
  assert.equal(st.repeatedFailSigs, 0)
  assert.equal(isStuck(st), false)
  assert.equal(assessAbort(st, 12.5, null).abort, false)
})

test('churn plus errors plus stagnation is flagged', () => {
  const st = new SpiralState()
  for (let i = 0; i < 4; i += 1) st.update('edit', { file_path: 'app/core.py' })
  for (let i = 0; i < 8; i += 1) st.update('bash', { command: 'pytest -q' }, FAIL, true)
  for (let i = 0; i < 8; i += 1) st.update('bash', { command: 'pytest -q' }, PASS, false)
  assert.equal(st.turns, 20)
  assert.equal(st.editChurn, 4)
  assert.equal(st.distinctEditFiles, 1)
  assert.equal(st.errorOutputs, 8)
  assert.equal(st.repeatedFailSigs, 7)
  assert.equal(isStuck(st), true)
})

test('the free gate opens before any judge call; closed gate never calls the judge', async () => {
  const judgeFn = judgeReplies(['{"stuck": true, "confidence": 0.9, "reason": "loop"}'])
  const engine = makeEngine({}, { judgeFn })
  const feed = feeder(engine, 1)
  feed('edit', { file_path: 'app/core.py' })
  const decision = await engine.decide()
  assert.equal(engine.gate().open, false)
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'gate-closed')
  assert.equal(decision.judge, 'not-run')
  assert.equal(judgeFn.calls.length, 0)
  assert.equal(decision.apply, false)
})

test('judge confidence gate: 0.69 spares, 0.71 redirects', async () => {
  const low = makeEngine({}, {
    judgeFn: judgeReplies(['{"stuck": true, "confidence": 0.69, "reason": "maybe"}']),
  })
  feedSpiral(low, 4)
  const spared = await low.decide()
  assert.equal(spared.action, 'none')
  assert.equal(spared.judge, 'ambiguous')
  assert.equal(spared.confidence, 0.69)
  assert.equal(spared.nudge, null)

  const high = makeEngine({}, {
    judgeFn: judgeReplies(['{"stuck": true, "confidence": 0.71, "reason": "same failure"}']),
  })
  feedSpiral(high, 4)
  const redirected = await high.decide()
  assert.equal(redirected.action, 'redirect')
  assert.equal(redirected.judge, 'stuck')
  assert.equal(redirected.confidence, 0.71)
  assert.match(redirected.nudge, /MATERIALLY DIFFERENT/)
  // Intervene is off by default: the decision is reported but not applied.
  assert.equal(redirected.apply, false)
})

test('active mode marks a redirect as applicable (modes enforced by the caller)', async () => {
  const engine = makeEngine(
    { loopguardIntervene: true },
    { judgeFn: judgeReplies(['{"stuck": true, "confidence": 0.8, "reason": "loop"}']) },
  )
  feedSpiral(engine, 4)
  const decision = await engine.decide()
  assert.equal(decision.action, 'redirect')
  assert.equal(decision.apply, true)
})

test('judge timeout fails open (never a redirect)', async () => {
  const engine = makeEngine(
    { loopguardJudgeTimeoutMs: 25 },
    { judgeFn: () => new Promise(() => {}) },
  )
  feedSpiral(engine, 4)
  const started = Date.now()
  const decision = await engine.decide()
  assert.ok(Date.now() - started >= 20)
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'judge-timeout')
  assert.equal(decision.judge, 'error')
  assert.equal(decision.nudge, null)
})

test('judge error fails open (never a redirect)', async () => {
  const engine = makeEngine({}, { judgeFn: judgeReplies([new Error('runner down')]) })
  feedSpiral(engine, 4)
  const decision = await engine.decide()
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'judge-error')
  assert.equal(decision.judge, 'error')
})

test('the judge is not called when loopguardJudge is false', async () => {
  const judgeFn = judgeReplies(['{"stuck": true, "confidence": 0.9, "reason": "loop"}'])
  const engine = makeEngine({ loopguardJudge: false }, { judgeFn })
  feedSpiral(engine, 4)
  const decision = await engine.decide()
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'not-stuck')
  assert.equal(judgeFn.calls.length, 0)
})

test('the judge is not called when canJudge() refuses', async () => {
  const judgeFn = judgeReplies(['{"stuck": true, "confidence": 0.9, "reason": "loop"}'])
  const engine = makeEngine({}, { judgeFn, canJudge: () => false })
  feedSpiral(engine, 4)
  const decision = await engine.decide()
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'judge-budget-exhausted')
  assert.equal(judgeFn.calls.length, 0)
})

test('at most one redirect per turn; the second verdict is a notice, never a stop', async () => {
  const judgeFn = judgeReplies(['{"stuck": true, "confidence": 0.8, "reason": "loop"}'])
  const engine = makeEngine({}, { judgeFn })
  const feed = feedSpiral(engine, 4)

  const first = await engine.decide()
  assert.equal(first.action, 'redirect')
  const firstNudges = engine.stateSnapshot().guard.nudges_done
  assert.equal(firstNudges, 1)

  feedSpiral(engine, 4, feed)
  const second = await engine.decide()
  assert.equal(second.action, 'none')
  assert.equal(second.judge, 'stuck')
  assert.equal(second.incident.intervention, 'notice')
  assert.equal(second.incident.detail.wouldAbort, true)
  assert.equal(engine.stateSnapshot().guard.nudges_done, 1)
  assert.notEqual(second.action, 'abort')
  assert.equal('stop' in second, false)
})

test('a zero intervention budget never stops: the verdict becomes a notice', async () => {
  const engine = makeEngine({ loopguardMaxInterventions: 0 }, {
    judgeFn: judgeReplies(['{"stuck": true, "confidence": 0.9, "reason": "loop"}']),
  })
  feedSpiral(engine, 4)
  const decision = await engine.decide()
  assert.equal(decision.action, 'none')
  assert.equal(decision.incident.intervention, 'notice')
  assert.equal(decision.apply, false)
})

test('without a judge the strict heuristic fallback still redirects (measurement-only mode)', async () => {
  const engine = makeEngine({ loopguardJudge: false })
  feedSpiral(engine, 10)
  const decision = await engine.decide()
  assert.equal(decision.action, 'redirect')
  assert.equal(decision.judge, 'not-run')
  assert.match(decision.reason, /^envelope:/)
  assert.ok(decision.nudge.length > 0)
})

test('a redirect written by the model is bounded by loopguardNudgeMaxTokens', async () => {
  const engine = makeEngine(
    { loopguardNudgeMaxTokens: 20 },
    {
      judgeFn: judgeReplies(['{"stuck": true, "confidence": 0.9, "reason": "loop"}']),
      nudgeWriterFn: async () => `${'word '.repeat(200)}tail`,
    },
  )
  feedSpiral(engine, 4)
  const decision = await engine.decide()
  assert.equal(decision.action, 'redirect')
  assert.ok(decision.nudge.length <= 80, `nudge length ${decision.nudge.length}`)
  assert.ok(decision.nudge.startsWith('word'))
  assert.equal(boundNudge('a'.repeat(500), 10).length, 40)
})

test('the heuristic fallback never pays for a written redirect', async () => {
  let writerCalls = 0
  const engine = makeEngine(
    { loopguardJudge: false },
    {
      nudgeWriterFn: async () => {
        writerCalls += 1
        return 'written by a model'
      },
    },
  )
  feedSpiral(engine, 10)
  const decision = await engine.decide()
  assert.equal(decision.action, 'redirect')
  assert.equal(decision.judge, 'not-run')
  assert.equal(writerCalls, 0, 'only a stuck judge verdict pays for a writer')
  assert.ok(decision.nudge.length > 0)
})

test('envelope percentile learning and cold start', () => {
  assert.equal(percentile([], 90), null)
  assert.equal(percentile([7], 90), 7)
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 90) - 3.7) < 1e-9)

  const tracker = new EnvelopeTracker()
  for (let i = 0; i < 4; i += 1) tracker.update(10, true, { turns: 10 })
  assert.equal(tracker.envelope, null, 'cold start: not enough resolved turns')
  tracker.update(10, true, { turns: 10 })
  assert.equal(tracker.envelope, 12.5, 'p90(10)*1.25')

  tracker.update(99, false)
  assert.equal(tracker.resolvedTurns.length, 5, 'unresolved turns never feed the envelope')

  const frozen = new EnvelopeTracker({ frozenEnvelope: 17 })
  assert.equal(frozen.envelope, 17)
})

test('learned thresholds adapt to the resolved distribution', () => {
  const tracker = loadEnvelope({
    resolved_turns: [10, 10, 10, 10, 10],
    resolved_snaps: Array.from({ length: 5 }, () => ({
      turns: 10,
      edit_churn: 9,
      distinct_edit_files: 3,
      error_outputs: 4,
      test_runs: 4,
      stagnation: 0.5,
      repeated_fail_sigs: 2,
    })),
  })
  const thr = thresholds(tracker)
  assert.equal(thr.gate_min_turns, 6)
  assert.equal(thr.min_turns, 8)
  assert.equal(thr.edit_churn, 10)
  assert.equal(thr.backstop_turns, 12.5 * 2.5)
  assert.deepEqual(baseThresholds('default'), scaledThresholds('default'))

  // save/load round-trip
  const snapshot = saveEnvelope(tracker)
  const reloaded = loadEnvelope(snapshot)
  assert.deepEqual(saveEnvelope(reloaded), snapshot)
})

test('recordTurn feeds only ended-green turns, from the whole turn', () => {
  const guard = new TurnGuard({ turnKey: 't:1' })
  guard.fold('bash', { command: 'pytest -q' }, PASS, 0)
  const tracker = recordTurn(null, guard)
  assert.deepEqual(tracker.resolvedTurns, [1])
  assert.equal(tracker.resolvedSnaps[0].turns, 1)

  const unfinished = new TurnGuard({ turnKey: 't:2' })
  unfinished.fold('bash', { command: 'pytest -q' }, PASS, 0)
  const other = recordTurn(null, unfinished, { stoppedNormally: false })
  assert.deepEqual(other.resolvedTurns, [])

  const failing = new TurnGuard({ turnKey: 't:3' })
  failing.fold('edit', { path: 'a.py' }, '')
  failing.fold('bash', { command: 'pytest -q' }, FAIL, 1)
  assert.deepEqual(recordTurn(null, failing).resolvedTurns, [])
})

test('onTurnStart resets the per-turn guard (and nothing of the envelope)', () => {
  const engine = makeEngine()
  const feed = feeder(engine, 1)
  feed('edit', { file_path: 'a.py' })
  feed('bash', { command: 'pytest -q' }, PASS, false)
  assert.equal(engine.turnGuard.st.turns, 2)
  assert.equal(engine.turnGuard.cumTurns, 2)

  engine.onTurnStart(2)
  assert.equal(engine.turnGuard.st.turns, 0)
  assert.equal(engine.turnGuard.cumTurns, 0)
  assert.equal(engine.stateSnapshot().guard.turn_key, 'session-1:2')
  assert.equal(engine.envelope, 12.5)
})

test('stateSnapshot/restoreState round-trip the whole turn guard', async () => {
  const engine = makeEngine()
  const feed = feeder(engine, 3)
  feed('edit', { file_path: 'app/core.py' })
  feed('bash', { command: 'pytest -q' }, FAIL, true)
  engine.onAssistantText('trying a different approach')
  engine.onStepEnd(2)

  const snapshot = JSON.parse(JSON.stringify(engine.stateSnapshot()))
  const restored = makeEngine()
  restored.restoreState(snapshot)
  assert.deepEqual(restored.turnGuard.toDict(), engine.turnGuard.toDict())
  assert.deepEqual(restored.stateSnapshot(), snapshot)
  assert.equal(restored.stateSnapshot().guard.turn_key, 'session-1:3')
  assert.equal(restored.stateSnapshot().assistantTexts, 1)

  // Its behaviour continues from the restored fold.
  const decision = await restored.decide()
  assert.equal(typeof decision.reason, 'string')
})

test('stateToDict/stateFromDict round-trip', () => {
  const st = new SpiralState()
  st.update('edit', { file_path: 'app/core.py' })
  st.update('bash', { command: 'pytest -q' }, FAIL, true)
  const dict = stateToDict(st)
  const back = stateFromDict(JSON.parse(JSON.stringify(dict)))
  assert.deepEqual(stateToDict(back), dict)
  assert.deepEqual(back.snapshot(), st.snapshot())
})

test('decisions and incidents are JSON-serializable', async () => {
  const engine = makeEngine({}, {
    judgeFn: judgeReplies(['{"stuck": true, "confidence": 0.9, "reason": "loop"}']),
  })
  feedSpiral(engine, 4)
  const decision = await engine.decide()
  const parsed = JSON.parse(JSON.stringify(decision))
  assert.deepEqual(parsed, decision)
  assert.deepEqual(Object.keys(decision).sort(), [
    'action', 'apply', 'confidence', 'incident', 'judge', 'nudge', 'reason',
  ])
  assert.deepEqual(Object.keys(decision.incident).sort(), [
    'agentId', 'at', 'confidence', 'detail', 'id', 'intervention', 'judge', 'kind',
    'nudge', 'outcome', 'projectId', 'repeats', 'rootSessionId', 'sessionId', 'step', 'turn',
  ])
  assert.equal(typeof decision.incident.id, 'string')
  assert.match(decision.incident.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(decision.incident.agentId, 'agent-1')
  assert.equal(decision.incident.sessionId, 'session-1')
  assert.equal(decision.incident.projectId, 'project-1')
  assert.equal(decision.incident.outcome, 'unknown')
  assert.ok(['none', 'redirect'].includes(decision.action))
})

test('no observation means no decision and no judge cost', async () => {
  const judgeFn = judgeReplies(['{"stuck": true, "confidence": 0.9, "reason": "loop"}'])
  const engine = makeEngine({}, { judgeFn })
  const decision = await engine.decide()
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'no-observation')
  assert.equal(judgeFn.calls.length, 0)
})

test('runner verdict and test-run status regexes behave', () => {
  assert.equal(runnerVerdict('1 failed, 2 passed in 0.12s'), true)
  assert.equal(runnerVerdict('3 passed in 0.10s'), false)
  assert.equal(runnerVerdict('# fail 0'), false)
  assert.equal(runnerVerdict('no summary'), null)
  assert.equal(statusOfTests('pytest -q'), 'own')
  assert.equal(statusOfTests('pytest -q | tail -5'), 'hidden')
  assert.equal(statusOfTests('pytest -q; git diff'), 'mixed')
  assert.equal(statusOfTests('cd web; npx vitest run'), 'own')
  assert.equal(statusOfTests('echo hi'), null)
  assert.equal(gateForJudge({ turns: 3, repeatedFailSigs: 5, errorOutputs: 99 }), false)
})

test('judge and writer parsers are strict and bounded', () => {
  assert.deepEqual(parseJudgeReply('not json'), { stuck: null, confidence: 0, reason: '' })
  assert.deepEqual(parseJudgeReply('x {"stuck": false, "confidence": 2, "reason": "ok"} y'), {
    stuck: false,
    confidence: 1,
    reason: 'ok',
  })
  // Strict booleans: Python bool() would read the string "false" as stuck.
  assert.equal(parseJudgeReply('{"stuck": "false"}').stuck, null)
  assert.equal(parseJudgeReply('{"stuck": 1}').stuck, null)
  assert.equal(parseJudgeReply('{"stuck": "true"}').stuck, null)
  assert.equal(parseJudgeReply('{"stuck": null, "confidence": -3}').confidence, 0)
  assert.equal(parseJudgeReply('{"stuck": true, "reason": "' + 'x'.repeat(500) + '"}').reason.length, 160)
  assert.equal(parseNudgeReply('  hello  '), 'hello')
  assert.equal(parseNudgeReply('x'.repeat(5000)).length, 1200)
  assert.equal(parseNudgeReply('   '), '')
})

test('a level preset owns judge confidence unless the operator changes the default', () => {
  const aggressive = makeEngine({ loopguardLevel: 'aggressive', loopguardConfidence: 0.7 })
  assert.equal(aggressive.effectiveThresholds().judge_confidence, scaledThresholds('aggressive').judge_confidence)
  const conservative = makeEngine({ loopguardLevel: 'conservative', loopguardConfidence: 0.7 })
  assert.equal(conservative.effectiveThresholds().judge_confidence, scaledThresholds('conservative').judge_confidence)
  const custom = makeEngine({ loopguardLevel: 'aggressive', loopguardConfidence: 0.9 })
  assert.equal(custom.effectiveThresholds().judge_confidence, 0.9)
})
