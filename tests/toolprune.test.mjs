/**
 * Unit tests for the tool-pruning port (`src/toolprune/`).
 *
 * Run after a build:  node --test tests/toolprune.test.mjs
 * The tests import the compiled `lib/` output, matching the package's ESM runtime.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INAPPLICABLE_TOOLS,
  MIN_CATALOG_TO_PRUNE,
  PROTECTED_PREFIXES,
  PROTECTED_TOOLS,
  activeToolRows,
  computeDenySet,
  evaluateCandidate,
  hasEverBeenUsed,
  isAllowlisted,
  isProtectedName,
  isToolInactive,
  markPruned,
  newToolStat,
  observeToolAvailability,
  observedSessions,
  proposedCandidates,
  reauditDue,
  recordToolCall,
  restoreTool,
  snapshot,
  unmarkPruned,
} from '../lib/toolprune/index.js'

/** A `ToolsFile` as `EMPTY_TOOLS` defines it (rebuilt locally: no storage import needed). */
function emptyTools() {
  return { schemaVersion: 1, tools: {}, pruned: [], lastAuditTask: -1, updatedAt: null }
}

/** Minimal ResolvedConfig shape used by the policy (runtime config schema is not imported). */
function config(overrides = {}) {
  return {
    mode: 'shadow',
    toolpruneEnabled: true,
    toolpruneMode: 'observe',
    toolpruneEvidence: 3,
    toolpruneMinSessions: 3,
    toolpruneReauditEvery: 25,
    toolpruneAllowlist: [],
    ...overrides,
  }
}

/** Observe `names` once per session, indices 0..n-1. */
function observeSessions(file, sessions, protectedTools = [], allowlist = []) {
  sessions.forEach((names, index) => observeToolAvailability(file, index, names, protectedTools, allowlist))
  return file
}

test('newToolStat creates a pristine, project-scoped row with a token estimate', () => {
  const stat = newToolStat('demo', { description: 'x'.repeat(40), protected: false })
  assert.equal(stat.name, 'demo')
  assert.equal(stat.descriptionTokens, 10) // approxTokens: floor(40 / 4)
  assert.equal(stat.calls, 0)
  assert.equal(stat.sessionsAvailable, 0)
  assert.equal(stat.unusedSessions, 0)
  assert.equal(stat.lastUsedAt, null)
  assert.equal(stat.lastUsedSeq, null)
  assert.equal(stat.pruned, false)
  assert.equal(stat.pruneReason, null)
  assert.equal(stat.scoped, true)
  assert.equal(newToolStat('read').protected, false) // caller-supplied flag only
})

test('observeToolAvailability folds sessions, registers unknown tools, and is idempotent per task', () => {
  const file = emptyTools()
  const catalog = ['read', { name: 'glob', descriptionTokens: 120 }, 'brand_new_tool']

  observeToolAvailability(file, 0, catalog)
  observeToolAvailability(file, 0, catalog) // repeat for the same task: no double count
  assert.equal(file.tools.read.sessionsAvailable, 1)
  assert.equal(file.tools.read.unusedSessions, 1)
  assert.equal(file.tools.brand_new_tool.name, 'brand_new_tool') // dynamic registration
  assert.equal(file.tools.glob.descriptionTokens, 120)

  // read is used in session 0; its unused streak resets and never grows again.
  recordToolCall(file, 'read', true, 1, '2026-01-01T00:00:00.000Z', 's1')
  observeToolAvailability(file, 1, catalog)
  observeToolAvailability(file, 2, catalog)

  assert.equal(file.tools.read.sessionsAvailable, 3)
  assert.equal(file.tools.read.unusedSessions, 0)
  assert.equal(file.tools.glob.unusedSessions, 3)
  assert.equal(file.tools.glob.sessionsAvailable, 3)
  assert.equal(observedSessions(file), 3)
})

test('recordToolCall tracks successes/failures, last use and distinct sessions', () => {
  const file = emptyTools()
  recordToolCall(file, 'shell', true, 1, '2026-01-01T00:00:00.000Z', 's1')
  recordToolCall(file, 'shell', false, 2, '2026-01-01T00:00:01.000Z', 's1')
  recordToolCall(file, 'shell', true, 3, '2026-01-01T00:00:02.000Z', 's2')

  const stat = file.tools.shell
  assert.equal(stat.calls, 3)
  assert.equal(stat.successes, 2)
  assert.equal(stat.failures, 1)
  assert.equal(stat.sessions, 2)
  assert.equal(stat.lastUsedSeq, 3)
  assert.equal(stat.lastUsedAt, '2026-01-01T00:00:02.000Z')
  assert.equal(hasEverBeenUsed(stat), true)

  // Without a session id, a sequence restart marks a new session bucket.
  const file2 = emptyTools()
  recordToolCall(file2, 'grep', true, 5, null)
  recordToolCall(file2, 'grep', true, 6, null)
  recordToolCall(file2, 'grep', true, 1, null) // new session, seq restarted
  assert.equal(file2.tools.grep.sessions, 2)

  // A call for a tool never seen in a catalog still creates a row.
  const file3 = emptyTools()
  recordToolCall(file3, 'late_registration', true, 1, null)
  assert.equal(file3.tools.late_registration.calls, 1)
  assert.equal(recordToolCall(file3, '   ', true, 1, null), null)
})

test('disappearing tools are kept and marked inactive; reappearing tools resume', () => {
  const file = emptyTools()
  observeSessions(file, [['read', 'glob', 'retired_tool'], ['read', 'glob']])

  const retired = file.tools.retired_tool
  assert.ok(retired, 'row kept after leaving the catalog')
  assert.equal(isToolInactive(retired), true)
  assert.equal(retired.sessionsAvailable, 1, 'no availability counted while absent')
  assert.equal(activeToolRows(file).some((stat) => stat.name === 'retired_tool'), false)

  observeToolAvailability(file, 2, ['read', 'glob', 'retired_tool'])
  assert.equal(isToolInactive(file.tools.retired_tool), false)
  assert.equal(file.tools.retired_tool.sessionsAvailable, 2)
  assert.equal(file.tools.retired_tool.unusedSessions, 2)
})

test('an empty catalog is not an observation: nothing is marked inactive', () => {
  const file = emptyTools()
  observeSessions(file, [['read', 'glob', 'unused_tool']])
  const before = JSON.stringify(file)

  const result = observeToolAvailability(file, 9, [])
  assert.equal(result.catalogSize, 0)
  assert.equal(result.markedInactive, 0)
  assert.equal(JSON.stringify(file), before)
})

test('candidate detection honors the evidence and minimum-session thresholds', () => {
  const names = ['read', 'glob', 'other_tool', 'unused_tool']
  const file = emptyTools()
  observeSessions(file, [names, names])

  const propose = config({ toolpruneMode: 'propose', toolpruneEvidence: 3, toolpruneMinSessions: 3 })
  assert.deepEqual(proposedCandidates(file, propose), [], 'only two observations so far')

  observeToolAvailability(file, 2, names)
  assert.deepEqual(
    proposedCandidates(file, propose),
    ['other_tool', 'unused_tool'],
    'available but never called for 3 sessions; protected read/glob excluded',
  )

  const tooMuchEvidence = config({ toolpruneMode: 'propose', toolpruneEvidence: 4, toolpruneMinSessions: 3 })
  assert.deepEqual(proposedCandidates(file, tooMuchEvidence), [], 'evidence threshold not reached')

  const tooManySessions = config({ toolpruneMode: 'propose', toolpruneEvidence: 1, toolpruneMinSessions: 4 })
  assert.deepEqual(proposedCandidates(file, tooManySessions), [], 'minimum observed sessions not reached')
})

test('protected tools, allowlist, and ever-used tools are never candidates', () => {
  const file = emptyTools()
  const names = ['read', 'lint_diagnostics', 'other_tool', 'another_tool']
  observeSessions(file, [names, names, names], [], ['other_tool', 'another_tool'])

  const propose = config({ toolpruneMode: 'propose' })
  assert.deepEqual(proposedCandidates(file, propose), [])
  assert.equal(file.tools.read.protected, true, 'work surface flagged while tracked')
  assert.equal(file.tools.lint_diagnostics.protected, true, 'prefix family is protected')
  assert.equal(file.tools.other_tool.allowlisted, true)
  assert.equal(isProtectedName('terminal_open'), true)
  assert.equal(isProtectedName('codegraph_explore'), true)
  assert.equal(isProtectedName('job_output'), false)
  assert.equal(isProtectedName('schedule_create'), false)
  assert.equal(isProtectedName('read_image'), true)
  assert.equal(isProtectedName('not_a_real_tool'), false)
  assert.ok(PROTECTED_TOOLS.size > 20)
  assert.ok(PROTECTED_PREFIXES.includes('lint_'))
  assert.ok(INAPPLICABLE_TOOLS.has('AskUserQuestion'))

  // A single (even failed) use permanently protects a tool.
  const used = emptyTools()
  const usedNames = ['read', 'glob', 'unused_tool', 'other_tool']
  observeSessions(used, [usedNames, usedNames, usedNames])
  recordToolCall(used, 'unused_tool', false, 1, null)
  assert.deepEqual(proposedCandidates(used, propose), ['other_tool'])

  const allow = config({ toolpruneMode: 'propose', toolpruneAllowlist: ['other_tool'] })
  assert.deepEqual(proposedCandidates(used, allow), [])
})

test('a small catalog gets no pruning decision (grace)', () => {
  const file = emptyTools()
  const names = ['read', 'unused_tool']
  observeSessions(file, [names, names, names])
  assert.equal(snapshot(file).catalogSize, 2)
  assert.ok(snapshot(file).catalogSize < MIN_CATALOG_TO_PRUNE)
  const propose = config({ toolpruneMode: 'propose', toolpruneEvidence: 1, toolpruneMinSessions: 1 })
  assert.deepEqual(proposedCandidates(file, propose), [])
  const automatic = config({ toolpruneMode: 'automatic', toolpruneEvidence: 1, toolpruneMinSessions: 1 })
  assert.deepEqual(computeDenySet(file, automatic), [])
})

test('mode gating: only automatic produces a deny set', () => {
  const file = emptyTools()
  const names = ['read', 'glob', 'unused_tool', 'other_tool']
  observeSessions(file, [names, names, names])
  const base = { toolpruneEvidence: 1, toolpruneMinSessions: 1 }

  assert.deepEqual(computeDenySet(file, config({ ...base, toolpruneMode: 'disabled' })), [])
  assert.deepEqual(computeDenySet(file, config({ ...base, toolpruneMode: 'observe' })), [])
  assert.deepEqual(computeDenySet(file, config({ ...base, toolpruneMode: 'propose' })), [])
  assert.deepEqual(computeDenySet(file, config({ ...base, toolpruneMode: 'automatic' })), [
    'other_tool',
    'unused_tool',
  ])
  assert.deepEqual(
    computeDenySet(file, config({ ...base, toolpruneMode: 'automatic', toolpruneEnabled: false })),
    [],
    'toolpruneEnabled=false overrides automatic',
  )
  // `mode` is the caller's gate: this function deliberately answers the hypothetical in SHADOW.
  assert.deepEqual(
    computeDenySet(file, config({ ...base, toolpruneMode: 'automatic', mode: 'shadow' })).length,
    2,
  )

  const observeMode = config({ ...base, toolpruneMode: 'observe' })
  assert.deepEqual(proposedCandidates(file, observeMode), [], 'observe surfaces nothing')
  const proposeMode = config({ ...base, toolpruneMode: 'propose' })
  assert.deepEqual(proposedCandidates(file, proposeMode), ['other_tool', 'unused_tool'])
  assert.deepEqual(proposedCandidates(file, config({ ...base, toolpruneMode: 'automatic' })).length, 2)
})

test('markPruned/unmarkPruned/restoreTool manage the persisted deny list', () => {
  const file = emptyTools()
  const names = ['read', 'glob', 'unused_tool', 'other_tool']
  observeSessions(file, [names, names, names])
  const automatic = config({ toolpruneMode: 'automatic', toolpruneEvidence: 1, toolpruneMinSessions: 1 })

  assert.equal(markPruned(file, 'unused_tool', 'evidence: 3 unused sessions'), true)
  assert.equal(file.tools.unused_tool.pruned, true)
  assert.equal(file.tools.unused_tool.pruneReason, 'evidence: 3 unused sessions')
  assert.deepEqual(file.pruned, ['unused_tool'])
  assert.deepEqual(computeDenySet(file, automatic), ['other_tool', 'unused_tool'])

  assert.equal(markPruned(file, 'read', 'nope'), false, 'protected tool refused')
  assert.equal(markPruned(file, 'not_in_catalog', 'nope'), false, 'unknown name refused')
  assert.equal(file.pruned.includes('not_in_catalog'), false)

  assert.equal(unmarkPruned(file, 'unused_tool'), true)
  assert.equal(file.tools.unused_tool.pruned, false)
  assert.deepEqual(file.pruned, [])
  assert.equal(unmarkPruned(file, 'unused_tool'), false)

  // restore resets the evidence clock so the next audit cannot immediately re-prune.
  assert.equal(markPruned(file, 'other_tool', 'evidence'), true)
  assert.equal(restoreTool(file, 'other_tool'), true)
  assert.equal(file.tools.other_tool.unusedSessions, 0)
  assert.equal(file.tools.other_tool.restored, true)
  assert.deepEqual(computeDenySet(file, automatic), ['unused_tool'])
  for (let i = 3; i < 6; i += 1) observeToolAvailability(file, i, names)
  assert.deepEqual(computeDenySet(file, automatic), ['unused_tool'], 'an explicit restore is durable')
})

test('a persisted deny-list entry is honored even if the row flag is missing', () => {
  const file = emptyTools()
  const names = ['read', 'glob', 'unused_tool', 'other_tool']
  observeSessions(file, [names, names, names])
  const automatic = config({ toolpruneMode: 'automatic', toolpruneEvidence: 1, toolpruneMinSessions: 1 })

  file.pruned.push('unused_tool') // row.pruned stays false (rebuilt/partial state)
  file.pruned.push('read') // protected: the list cannot force the work surface away
  assert.deepEqual(computeDenySet(file, automatic), ['other_tool', 'unused_tool'])
})

test('deny set never invents names and drops inactive/protected stale prunes', () => {
  const file = emptyTools()
  const names = ['read', 'glob', 'unused_tool', 'other_tool']
  observeSessions(file, [names, names, names])
  const automatic = config({ toolpruneMode: 'automatic', toolpruneEvidence: 1, toolpruneMinSessions: 1 })

  // Stale persisted prune that is no longer offered by the catalog.
  file.pruned.push('ghost_tool')
  // Stale prune that is now allowlisted.
  file.pruned.push('other_tool')
  file.tools.other_tool.pruned = true
  const allow = config({ ...automatic, toolpruneAllowlist: ['other_tool'] })
  assert.deepEqual(computeDenySet(file, allow), ['unused_tool'])

  // A tool disappearing from the catalog is excluded even if it was pruned.
  markPruned(file, 'unused_tool', 'evidence')
  observeToolAvailability(file, 3, ['read', 'glob', 'other_tool'])
  assert.equal(isToolInactive(file.tools.unused_tool), true)
  assert.deepEqual(
    computeDenySet(file, { ...automatic, toolpruneAllowlist: [] }),
    ['other_tool'],
    'the disappeared tool leaves the deny set; the still-offered stale prune remains',
  )

  // ... and comes back when the tool reappears (evidence still stands).
  observeToolAvailability(file, 4, names)
  assert.deepEqual(computeDenySet(file, { ...automatic, toolpruneAllowlist: [] }), [
    'other_tool',
    'unused_tool',
  ])
})

test('reaudit tasks suppress pruning until the full catalog is reloaded', () => {
  const file = emptyTools()
  const names = ['read', 'glob', 'unused_tool', 'other_tool']
  observeSessions(file, [names, names, names])
  const automatic = config({ toolpruneMode: 'automatic', toolpruneEvidence: 1, toolpruneMinSessions: 1 })
  assert.deepEqual(computeDenySet(file, automatic, { reaudit: true }), [])
  assert.deepEqual(proposedCandidates(file, config({ ...automatic, toolpruneMode: 'propose' }), { reaudit: true }), [])
  assert.deepEqual(computeDenySet(file, automatic, { observedSessions: 0 }), [], 'minSessions still gates')
})

test('evaluateCandidate explains every guard', () => {
  const facts = { catalogSize: 4, observedSessions: 3, reaudit: false }
  const stat = (overrides = {}) => ({ ...newToolStat('some_tool'), unusedSessions: 3, sessionsAvailable: 3, ...overrides })
  const automatic = config({ toolpruneMode: 'automatic' })

  assert.deepEqual(evaluateCandidate(stat(), automatic, facts), { candidate: true, reason: 'candidate' })
  assert.equal(evaluateCandidate(stat(), { ...automatic, toolpruneEnabled: false }, facts).reason, 'disabled')
  assert.equal(evaluateCandidate(stat(), config({ toolpruneMode: 'disabled' }), facts).reason, 'mode-disabled')
  assert.equal(evaluateCandidate(stat(), automatic, { ...facts, reaudit: true }).reason, 'reaudit')
  assert.equal(evaluateCandidate(stat({ pruned: true }), automatic, facts).reason, 'pruned')
  assert.equal(evaluateCandidate(stat({ inactive: true }), automatic, facts).reason, 'inactive')
  assert.equal(evaluateCandidate(stat({ name: 'bash' }), automatic, facts).reason, 'protected')
  assert.equal(evaluateCandidate(stat({ name: 'custom', allowlisted: true }), automatic, facts).reason, 'allowlisted')
  assert.equal(evaluateCandidate(stat({ calls: 1 }), automatic, facts).reason, 'used')
  assert.equal(evaluateCandidate(stat(), automatic, { ...facts, catalogSize: 2 }).reason, 'catalog-too-small')
  assert.equal(evaluateCandidate(stat(), automatic, { ...facts, observedSessions: 2 }).reason, 'insufficient-sessions')
  assert.equal(evaluateCandidate(stat({ unusedSessions: 2 }), automatic, facts).reason, 'insufficient-evidence')

  const allowlisted = config({ toolpruneMode: 'automatic', toolpruneAllowlist: ['some_tool'] })
  assert.equal(isAllowlisted('some_tool', allowlisted), true)
  assert.equal(evaluateCandidate(stat(), allowlisted, facts).reason, 'allowlisted')
})

test('reauditDue follows the upstream evidence_reaudit cadence', () => {
  assert.equal(reauditDue(-1, 24, 25), false)
  assert.equal(reauditDue(-1, 25, 25), true)
  assert.equal(reauditDue(25, 49, 25), false)
  assert.equal(reauditDue(25, 50, 25), true)
  assert.equal(reauditDue(50, 50, 25), false, 'already audited this task')
  assert.equal(reauditDue(25, 80, 25), true, 'a skipped audit fires on the next task')
  assert.equal(reauditDue(-1, 25, 0), false, '0 disables the periodic re-audit')
  assert.equal(reauditDue(-1, 0, 25), false)
})

test('snapshot accepts an explicit observed-session count', () => {
  const file = emptyTools()
  observeSessions(file, [['read', 'glob', 'unused_tool'], ['read', 'glob', 'unused_tool']])
  assert.equal(snapshot(file).observedSessions, 2)
  assert.equal(snapshot(file, { observedSessions: 7 }).observedSessions, 7)
  assert.equal(snapshot(file, { observedSessions: -3 }).observedSessions, 2, 'invalid override ignored')
})

test('session-id counting: repeated turns in one session advance the evidence once', () => {
  const file = emptyTools()
  const names = ['read', 'rare_tool']
  observeToolAvailability(file, 0, names, [], [], 'session-a')
  observeToolAvailability(file, 1, names, [], [], 'session-a')
  assert.equal(file.tools.rare_tool.sessionsAvailable, 1)
  assert.equal(file.tools.rare_tool.unusedSessions, 1)
  observeToolAvailability(file, 2, names, [], [], 'session-b')
  assert.equal(file.tools.rare_tool.sessionsAvailable, 2)
  assert.equal(file.tools.rare_tool.unusedSessions, 2)
})

test('orchestration and optional tools are prunable, the work surface and safety tools stay protected', () => {
  for (const name of ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'read_image', 'ask_user_question', 'present', 'plugin_manager']) {
    assert.equal(isProtectedName(name), true, `${name} must stay protected`)
  }
  for (const name of ['web_search', 'subagent', 'workflow', 'schedule_create', 'job_output', 'session_search', 'todo_write', 'skill', 'create_goal', 'render_ui']) {
    assert.equal(isProtectedName(name), false, `${name} must be prunable`)
  }
  assert.equal(isProtectedName('codegraph_explore'), true, 'analysis helpers stay protected')
  assert.equal(isProtectedName('terminal_open'), true, 'terminal lifecycle stays protected')
})
