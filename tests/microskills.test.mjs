/**
 * Unit suite for the micro-skills port (always runs; the parity suite needs the pinned
 * upstream checkout and skips without it).
 *
 * Run with: node --test tests/microskills.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import * as O from '../lib/microskills/observe.js'
import * as L from '../lib/microskills/lifecycle.js'
import * as E from '../lib/microskills/envfacts.js'
import * as D from '../lib/microskills/distiller.js'
import { MicroskillsEngine } from '../lib/microskills/index.js'
import { DEFAULT_REDACTION, sanitizeText } from '../lib/core/redact.js'

// ---------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------

const AT = '2026-01-01T00:00:00.000Z'

function call(command, output, extras = {}) {
  return {
    callId: extras.callId ?? `c-${command}`,
    name: extras.name ?? 'Bash',
    argumentsText: JSON.stringify(extras.args ?? { command }),
    args: extras.args ?? { command },
    output,
    isError: extras.isError ?? false,
    turn: extras.turn ?? 1,
    step: 0,
    at: AT,
  }
}

function windowOf(calls, taskIndex = 0, extra = {}) {
  return {
    projectId: 'example/repo',
    sessionId: 's-1',
    turn: taskIndex + 1,
    calls,
    writes: [],
    failures: [],
    editedFiles: [],
    taskIndex,
    at: `2026-01-0${taskIndex + 1}T00:00:00.000Z`,
    ...extra,
  }
}

function config(overrides = {}) {
  return {
    microskillsEnabled: true,
    microskillsInject: false,
    microskillsProfile: 'envfacts',
    microskillsMaxFacts: 12,
    microskillsMaxTokens: 700,
    microskillsMinConfirmations: 2,
    microskillsRetireDays: 90,
    mode: 'shadow',
    ...overrides,
  }
}

function candidate(overrides = {}) {
  return {
    key: 'npm-test',
    text: 'Canonical test is `npm test`.',
    kind: 'test',
    high: false,
    drift: false,
    fired: true,
    exercised: true,
    files: ['src/a.ts'],
    evidence: ['3 passing'],
    sourceSessionId: 's-1',
    sourceTurn: 1,
    ...overrides,
  }
}

function newEngine() {
  return new MicroskillsEngine()
}

/** A stored row whose state machine has already been driven `updates` times. */
function factRow(key, text, updates, options = {}) {
  const life = new L.Lifecycle(key, options.high ?? false, options.drift ?? false, {
    kPromote: options.kPromote ?? 2,
  })
  updates.forEach(([verdict, fired, files], index) => {
    life.update(index, verdict, fired, true, files ?? [])
  })
  return L.storedFactFromLifecycle(life, {
    id: options.id ?? `fact_${key.replace(/\W+/g, '_')}`,
    text,
    kind: options.kind ?? 'workflow',
    createdAt: AT,
    updatedAt: options.updatedAt ?? AT,
    source: { sessionId: 's-1', turn: 1, evidence: options.evidence ?? [] },
    enabled: options.enabled ?? true,
  })
}

function promotedRow(key, text, options = {}) {
  const row = factRow(key, text, [
    ['confirm', true],
    ['confirm', true],
    ['confirm', true],
    ['confirm', true],
  ], options)
  assert.equal(row.state, 'ACTIVE', `fixture row ${key} should be ACTIVE`)
  return row
}

// ---------------------------------------------------------------------------------------
// observe: normalization
// ---------------------------------------------------------------------------------------

test('observe: shell wrappers, env assignments and rtk prefixes are unwrapped', () => {
  assert.equal(O.unwrap('/bin/bash -lc "python -m pytest -q"'), 'python -m pytest -q')
  assert.equal(O.unwrap("/bin/bash -lc 'cd tests && python runtests.py'"), 'cd tests && python runtests.py')
  // Upstream `unwrap` only strips a wrapper around a *plain* quoted body: a payload that
  // needed escaping, or a non-`bash` wrapper, is left exactly as typed (parity: `unwrap`).
  assert.equal(O.unwrap('bash -lc "echo \\"hi\\""'), 'bash -lc "echo \\"hi\\""')
  assert.equal(O.unwrap('sh -c \'npm run build\''), "sh -c 'npm run build'")
  assert.equal(O.unwrap('  cd /repo && make test  '), '  cd /repo && make test  ')
  assert.equal(O.stripRtkPrefix('rtk proxy python -m pytest'), 'python -m pytest')
  assert.equal(O.stripRtkPrefix('rtk pytest'), 'pytest')
  assert.equal(O.stripRtkPrefix('rtkproxy pytest'), 'rtkproxy pytest')

  assert.equal(O.stripEnvAssignments('FOO=1 BAR=2 python -m pytest'), 'python -m pytest')
  assert.equal(O.stripEnvAssignments('python -m pytest'), 'python -m pytest')
  assert.equal(O.hasEnvAssignment('FOO=1 python x.py'), true)
  assert.equal(O.hasEnvAssignment('python x.py'), false)

  assert.equal(O.normalizeCommand('  /bin/bash -lc "FOO=1 pytest -q"  '), 'pytest -q')
})

test('observe: segments split on real operators but not inside quotes or heredocs', () => {
  assert.deepEqual(O.segments('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(O.segments("echo 'a && b' && real"), ["echo 'a && b'", 'real'])
  // A redirection is part of the segment, not an operator (upstream `segments`).
  assert.deepEqual(O.segments('python -c "print(1)" 2>&1 | tail'), ['python -c "print(1)" 2>&1', 'tail'])
  assert.deepEqual(O.segments("cat <<'EOF'\nrm -rf /tmp/x\nEOF\nls"), ['cat <<\'EOF\' <heredoc>', 'ls'])
  assert.deepEqual(O.segments('cd /repo && python -m pytest -q tests | tail -5'), [
    'cd /repo',
    'python -m pytest -q tests',
    'tail -5',
  ])
})

test('observe: cd targets are resolved against the session root', () => {
  // Signature mirrors upstream `_cd_target(cur, target, root, top)`; the shell keeps its
  // directory between calls, so the target is resolved relative to `cur`.
  assert.equal(O.cdTarget('/repo', 'src', '/repo', '/repo'), '/repo/src')
  assert.equal(O.cdTarget(null, '/repo', '/repo', '/repo'), '')
  // Leaving the repository (or using a home shortcut) gives no usable path.
  assert.equal(O.cdTarget('/repo', '~', '/repo', '/repo'), null)
  assert.equal(O.cdTarget('/repo', '/tmp', '/repo', '/repo'), null)
})

// ---------------------------------------------------------------------------------------
// observe: classification
// ---------------------------------------------------------------------------------------

test('observe: command intents and forms match the upstream table', () => {
  const [pytest] = O.classifyCommand('pytest -q tests')
  assert.equal(pytest.intent, 'run_tests')
  assert.equal(pytest.form, 'pytest')

  // `classify_command` defaults to the Python/git vocabulary (upstream signature), so the
  // node/network vocabulary must be passed explicitly.
  const [lint] = O.classifyCommand('npm run lint', { vocab: O.GENERIC })
  assert.equal(lint.intent, 'run_build')
  assert.equal(lint.form, 'npm run lint')

  const [install] = O.classifyCommand('pip install -e .', { vocab: O.GENERIC })
  assert.equal(install.intent, 'fetch_remote')
  assert.equal(install.form, 'pip install')

  const [interp] = O.classifyCommand('python -c "print(1)"', { vocab: O.GENERIC })
  assert.equal(interp.intent, 'run_interpreter')
  assert.equal(interp.form, 'python')

  const [fetch] = O.classifyCommand('curl -sSf https://example.test', { vocab: O.GENERIC })
  assert.equal(fetch.intent, 'fetch_remote')

  // The generic vocabulary has no `git status` / `docker` intent: those commands carry no
  // observation at all (upstream table; parity vectors `classify`).
  assert.equal(O.classifyCommand('git status --short', { vocab: O.GENERIC }).length, 0)
  assert.equal(O.classifyCommand('docker build -t app .', { vocab: O.GENERIC }).length, 0)
  assert.equal(O.classifyCommand('').length, 0)
})

test('observe: cd is folded into the form of the command it prefixes', () => {
  const bare = O.classifyCommand('cd src && pytest -q', { vocab: O.GENERIC })
  assert.equal(bare.length, 1)
  assert.equal(bare[0].prefix, 'cd src &&')
  assert.equal(bare[0].form, 'cd src && pytest')

  // With the session cwd known, the directory is made absolute, as upstream does.
  const resolved = O.classifyCommand('cd src && pytest -q', { vocab: O.GENERIC, cwd: '/repo', root: '/repo' })
  assert.equal(resolved[0].form, 'cd /repo/src && pytest')
})

test('observe: error classes cover the failure vocabulary', () => {
  assert.equal(O.errorClass("bash: pytest: command not found"), 'command_missing')
  assert.equal(O.errorClass("ModuleNotFoundError: No module named 'yaml'"), 'module_missing')
  assert.equal(O.errorClass("python: can't open file 'x.py': [Errno 2] No such file or directory"), 'script_missing')
  assert.equal(O.errorClass('error: unrecognized arguments: -k foo'), 'usage_error')
  assert.equal(O.errorClass('Could not resolve host: example.test'), 'name_resolution')
  assert.equal(O.errorClass('Exit code: 2'), null)
  assert.equal(O.errorClass(''), null)

  assert.equal(O.exitCodeHint('exit code: 2'), 2)
  assert.equal(O.exitCodeHint('ok'), null)

  // Upstream `_command_failed` reads an explicit exit code, a known error class, or a
  // traceback; `error: boom` alone is not a failure signal.
  assert.equal(O.commandFailed(''), false)
  assert.equal(O.commandFailed('error: boom'), false)
  assert.equal(O.commandFailed('error: exit status 1'), true)
  assert.equal(O.commandFailed('make: not found'), true)
})

test('observe: edited paths come from write tools only', () => {
  const calls = [
    call('x', '', { name: 'Edit', args: { file_path: '/repo/src/a.ts' } }),
    call('x', '', { name: 'Bash', args: { command: 'touch /repo/b.ts' } }),
    call('x', '', { name: 'Write', args: { path: '/repo/c.ts' } }),
    call('x', '', { name: 'Read', args: { file_path: '/repo/d.ts' } }),
    call('x', '', { name: 'Edit', args: { file_path: '/repo/.env' } }),
  ]
  // Paths are made relative to the session root; sensitivity filtering happens in the
  // engine (the observation layer reports what was touched).
  assert.deepEqual(O.editedPaths(calls), ['.env', 'a.ts', 'c.ts'])
  assert.equal(O.editedPaths(calls).includes('b.ts'), false, 'a shell command is an observation, not an edit')
  assert.deepEqual(O.bashCommands(calls).map((entry) => entry.command), ['touch /repo/b.ts'])

  const shell = O.bashCommands([
    call('ls', 'x'),
    call('pwd', 'y', { args: { cmd: 'pwd' } }),
    call('read', 'z', { name: 'Read', args: { file_path: '/repo/a.ts' } }),
  ])
  assert.deepEqual(shell.map((entry) => entry.command), ['ls', 'pwd'])
})

test('observe: observations attribute outcomes and test runs', () => {
  const calls = [
    call('python runtests.py', "Traceback (most recent call last):\nModuleNotFoundError: No module named 'app'", { isError: true }),
    call('cd src && python runtests.py', 'Ran 3 tests in 0.01s\nOK'),
  ]
  const observed = O.observeTask(calls, { vocab: O.GENERIC })
  assert.equal(observed.obs.length, 2)
  assert.equal(observed.obs[0].outcome, 'module_missing')
  assert.equal(observed.obs[1].outcome, 'ran')
  assert.equal(observed.obs[1].prefix, 'cd src &&')
  assert.ok(observed.edited.length === 0)
  assert.equal(observed.nCalls, 2)
  assert.ok(Array.isArray(observed.env))

  const [test] = O.observeTask([call('python -m pytest -q', '3 passed')]).obs
  assert.equal(test.testsRan, true)
})

test('observe: vocabulary detection prefers the majority signal', () => {
  assert.equal(O.detectVocabulary({ files: ['a.py', 'b.py', 'c.ts'] }), O.PYTHON_GIT)
  assert.equal(O.detectVocabulary({ commands: ['npm test', 'npx tsc', 'vitest'] }), O.NODE_WEB)
  assert.equal(O.detectVocabulary({}), O.GENERIC)
  assert.equal(O.detectVocabulary({ files: ['a.py'], commands: ['npm test'] }), O.GENERIC)
})

// ---------------------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------------------

test('lifecycle: promotion needs distinct confirmations (drift)', () => {
  const drifting = new L.Lifecycle('k', false, true)
  for (let i = 0; i < 3; i += 1) drifting.update(i, 'confirm', false, true, ['a.ts'])
  assert.equal(drifting.state, 'CANDIDATE')
  assert.equal(drifting.driftedConfirms(), 1)

  const fresh = new L.Lifecycle('k', false, true)
  fresh.update(0, 'confirm', false, true, ['a.ts'])
  fresh.update(1, 'confirm', false, true, ['b.ts'])
  fresh.update(2, 'confirm', false, true, ['c.ts'])
  assert.equal(fresh.state, 'ACTIVE')
})

test('lifecycle: kPromote override comes from config', () => {
  const life = new L.Lifecycle('k', false, false, { kPromote: 2 })
  life.update(0, 'confirm', false, true, [])
  assert.equal(life.state, 'CANDIDATE')
  life.update(1, 'confirm', false, true, [])
  assert.equal(life.state, 'ACTIVE')
})

test('lifecycle: hard kill retires a high-stakes active fact on one contradiction', () => {
  const life = new L.Lifecycle('k', true, false, { kPromote: 2 })
  life.update(0, 'confirm', true, true, [])
  life.update(1, 'confirm', true, true, [])
  assert.equal(life.state, 'ACTIVE')
  life.update(2, 'contradict', false, true, [])
  assert.equal(life.state, 'RETIRED')
  assert.equal(life.injectable(), false)
})

test('lifecycle: soft facts retire through the score floor', () => {
  const life = new L.Lifecycle('k', false, false, { kPromote: 1 })
  life.update(0, 'confirm', true, true, [])
  assert.equal(life.state, 'ACTIVE')
  let retiredAt = -1
  for (let i = 1; i <= 12; i += 1) {
    life.update(i, 'contradict', false, true, [])
    if (life.state === 'RETIRED' && retiredAt < 0) retiredAt = i
  }
  assert.ok(retiredAt > 0)
  assert.equal(life.retiredAt, retiredAt)
  assert.equal(life.injectable(), false)
})

test('lifecycle: firing gate requires enough exercised tasks and a high enough rate', () => {
  const few = new L.Lifecycle('k', false, false, { kPromote: 1 })
  few.update(0, 'confirm', true, true, [])
  assert.equal(few.state, 'ACTIVE')
  assert.equal(few.injectable(), false, 'one exercised task is below FIRE_MIN_N')

  const rare = new L.Lifecycle('k', false, false, { kPromote: 1 })
  for (let i = 0; i < 4; i += 1) rare.update(i, 'confirm', i === 0, true, [])
  assert.equal(rare.firingRate(), 0.25)
  assert.equal(rare.injectable(), false)

  const often = new L.Lifecycle('k', false, false, { kPromote: 1 })
  for (let i = 0; i < 4; i += 1) often.update(i, 'confirm', i < 2, true, [])
  assert.equal(often.firingRate(), 0.5)
  assert.equal(often.injectable(), true)

  const unexercised = new L.Lifecycle('k', false, false, { kPromote: 1 })
  unexercised.update(0, 'confirm', true, false, [])
  assert.equal(unexercised.injectable(), false, 'a task that never exercised the fact proves nothing')
})

test('lifecycle: candidates are never injectable, retired rows stay retired', () => {
  const cand = new L.Lifecycle('k', false, false)
  assert.equal(cand.injectable(), false)
  assert.equal(L.isInjectableRow({ state: 'CANDIDATE', fireNum: 9, fireDen: 9, enabled: true }), false)
  assert.equal(L.isInjectableRow({ state: 'ACTIVE', fireNum: 9, fireDen: 9, enabled: false }), false)
  assert.equal(L.isInjectableRow({ state: 'ACTIVE', fireNum: 3, fireDen: 4, enabled: true }), true)
  assert.equal(L.isInjectableRow({ state: 'RETIRED', fireNum: 9, fireDen: 9, enabled: true }), false)
})

test('lifecycle: dictionary round trip preserves the state machine', () => {
  const life = new L.Lifecycle('k', true, true, { kPromote: 2 })
  life.update(0, 'confirm', true, true, ['a.py'])
  life.update(1, 'contradict', false, true, [])
  const restored = L.Lifecycle.fromDict(life.toDict(), { kPromote: 2 })
  assert.deepEqual(restored.toDict(), life.toDict())
  assert.equal(restored.score(3), life.score(3))
})

// ---------------------------------------------------------------------------------------
// environment facts
// ---------------------------------------------------------------------------------------

test('envfacts: lint rejects verification/completion advice and accepts facts', () => {
  assert.equal(E.lintOk('`pytest -q` works here.'), true)
  assert.equal(E.lintOk('You should run `pytest` to verify the fix.'), false)
  assert.equal(E.lintOk('no need to run the tests here'), false)
  assert.equal(E.lintOk('This one is done'), false)
  assert.equal(E.lintOk('Run the suite from the repository root'), true)
})

test('envfacts: form helpers mirror the upstream phrasing rules', () => {
  assert.equal(E.movesShell('cd tests && pytest'), true)
  assert.equal(E.movesShell('pytest'), false)
  assert.equal(E.usage('pytest'), '`pytest …`')
  assert.equal(E.usage('cd tests && pytest'), '`(cd tests && pytest …)`')
  assert.equal(E.rootOf('cd tests && pytest'), 'cd tests')
  assert.equal(E.rootOf('npx vitest run'), 'npx vitest run')
  assert.equal(E.rootOf('/usr/bin/python x.py'), '/usr/bin')
  assert.equal(E.joinPhrases([]), 'the hosts it tried')
  assert.equal(E.joinPhrases(['a']), 'a')
  assert.equal(E.joinPhrases(['a', 'b']), 'a and b')
  assert.equal(E.joinPhrases(['a', 'b', 'c']), 'a, b and c')
  assert.equal(E.toolOf('npx vitest run'), 'run')
  assert.equal(E.toolOf('/usr/local/bin/docker'), 'docker')
})

test('envfacts: a form repair is learned and promoted from observed tasks', () => {
  const distiller = new E.EnvFactsDistiller({ vocab: O.GENERIC, now: 0 })
  const calls = [
    call('python runtests.py', "ModuleNotFoundError: No module named 'app'", { isError: true }),
    call('cd src && python runtests.py', 'Ran 3 tests in 0.01s\nOK'),
  ]
  distiller.update(O.observeTask(calls, { vocab: O.GENERIC }))
  const facts = [...distiller.facts.values()]
  assert.equal(facts.length, 1)
  const fact = facts[0]
  assert.equal(fact.id.startsWith('form_repair:run_tests:'), true)
  assert.equal(fact.params.intent, 'run_tests')
  assert.equal(fact.params.a, 'python runtests.py')
  assert.equal(fact.params.b_counts['cd src && python runtests.py'], 1)
  assert.equal(fact.params.error_counts.module_missing, 1)
  assert.match(fact.claim(), /fails here with ModuleNotFoundError/)
  assert.equal(fact.injectable(), false, 'one task cannot clear the firing gate')
})

test('envfacts: high-stakes candidates die on the first contradiction', () => {
  const fact = new E.EnvFact('absent_tool:docker', 'absent_tool', true, { tool: 'docker' })
  E.fold(fact, 0, 'contradict', false, true, [])
  assert.equal(fact.life.state, 'RETIRED')
})

test('envfacts: lower-stakes contradictions need a streak', () => {
  const fact = new E.EnvFact('form_repair:run_tests:a', 'form_repair', false, {
    intent: 'run_tests',
    a: 'a',
    b_counts: { b: 2 },
    error_counts: {},
  })
  assert.equal(E.fold(fact, 0, 'contradict', true, true, []), null)
  assert.equal(fact.life.state, 'CANDIDATE')
  assert.equal(fact.params.contra_streak, 1)
  // The streak is NOT reset when the contradiction finally counts (upstream `fold`); the
  // next confirmation clears it.
  assert.equal(E.fold(fact, 1, 'contradict', true, true, []), 'contradict')
  assert.equal(fact.params.contra_streak, 2)
  assert.ok(fact.life.contradicts.length >= 1)
  assert.equal(E.fold(fact, 2, 'confirm', true, true, []), 'confirm')
  assert.equal(fact.params.contra_streak, 0)
})

test('envfacts: render enforces the fact and token caps and the exact headers', () => {
  const distiller = new E.EnvFactsDistiller({ vocab: O.GENERIC, maxFacts: 2, maxTokens: 60 })
  for (const id of ['absent_tool:a', 'absent_tool:b', 'absent_tool:c']) {
    const fact = new E.EnvFact(id, 'absent_tool', true, { tool: id.split(':')[1] })
    for (let i = 0; i < 4; i += 1) E.fold(fact, i, 'confirm', true, true, [])
    distiller.facts.set(fact.id, fact)
  }
  const rendered = distiller.render()
  assert.match(rendered, new RegExp(`^${E.GENERIC_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`))
  const lines = rendered.trimEnd().split('\n').slice(1)
  assert.equal(lines.length, 2)
  assert.ok(rendered.length <= 60 * 4)
  for (const line of lines) assert.match(line, /^- /)

  // An empty distiller renders "" -- the header only appears with at least one claim.
  assert.equal(new E.EnvFactsDistiller({ vocab: O.PYTHON_GIT }).render(), '')
  assert.equal(new E.EnvFactsDistiller({ vocab: O.PYTHON_GIT }).header, E.HEADER)
})

test('envfacts: stored rows round-trip the family state through evidence', () => {
  const fact = new E.EnvFact('env_value:APP_MODE', 'env_value', false, {
    var: 'APP_MODE',
    good: { prod: 2 },
    bad: { dev: 1 },
  })
  for (let i = 0; i < 3; i += 1) E.fold(fact, i, 'confirm', true, true, [])
  const row = E.envFactToStored(fact, { createdAt: AT, updatedAt: AT, sessionId: 's-1', turn: 1 })
  assert.equal(E.isEnvFactRow(row), true)
  assert.equal(row.state, fact.life.state)
  assert.equal(row.fireDen, 3)
  assert.equal(row.text, fact.claim())
  const back = E.envFactFromStored(row)
  assert.equal(back.id, fact.id)
  assert.equal(back.family, fact.family)
  assert.deepEqual(back.params, fact.params)
  assert.equal(back.life.state, fact.life.state)
  assert.equal(E.isEnvFactRow({ source: { evidence: ['unrelated'] } }), false)
})

// ---------------------------------------------------------------------------------------
// distiller
// ---------------------------------------------------------------------------------------

test('distiller: templates dedupe and truncate to 80 characters', () => {
  const long = `pytest ${'x'.repeat(200)}`
  const shapes = D.templates(['pytest -q tests', 'pytest -q tests', '  ', 'npm run build', long])
  assert.deepEqual(shapes, ['pytest -q tests', 'npm run build', long.slice(0, 80)])
  assert.equal(D.templates(['a', 'b'], 1).length, 1)
})

test('distiller: error signatures mask paths, numbers and hex', () => {
  const sig = D.errorSignature('Traceback (most recent call last):\n  File "/repo/app.py", line 3\nValueError at 0x7f')
  assert.equal(sig.includes('/repo/app.py'), false)
  assert.equal(sig.includes('0x7f'), false)
  assert.match(sig, /<path>|Traceback/)
  assert.equal(D.errorSignature('all good'), '')
})

test('distiller: the generic digest carries cross-ecosystem flags', () => {
  const calls = [
    call('npm run lint', 'ok'),
    call('make test', 'make: not found', { isError: true }),
    call('python -c "import yaml"', "ModuleNotFoundError: No module named 'yaml'", { isError: true }),
    call('deploy --flag', 'error: unrecognized arguments: --flag', { isError: true }),
    call('x', '', { name: 'Edit', args: { file_path: '/repo/src/a.ts' } }),
    call('x', '', { name: 'Edit', args: { file_path: '/repo/main.py' } }),
  ]
  const digest = D.buildGenericDigest(calls, { iid: 't1', resolved: true, startCwd: '/repo', top: '/repo' })
  assert.equal(digest.iid, 't1')
  assert.equal(digest.resolved, true)
  // Edited files are made relative to the start directory and sorted.
  assert.deepEqual(digest.edited_files, ['a.ts', 'main.py'])
  assert.equal(digest.n_cmds, 4)
  assert.deepEqual(digest.check_commands, ['npm run lint', 'make test'])
  assert.equal(digest.missing_command, true)
  assert.equal(digest.missing_dependency, true)
  assert.equal(digest.bad_usage, true)
  assert.equal(digest._ran_tests, true)
  assert.deepEqual(
    digest.failed_commands.map((row) => row.cmd),
    ['make test', 'python -c "import yaml"'],
  )
})

test('distiller: the python digest covers only python edits and repos', () => {
  const calls = [
    call('python -m pytest -q', '3 passed'),
    call('x', '', { name: 'Edit', args: { file_path: '/repo/main.py' } }),
    call('x', '', { name: 'Edit', args: { file_path: '/repo/src/a.ts' } }),
  ]
  const digest = D.buildDigest(calls, { iid: 't2', resolved: false, startCwd: '/repo', roots: ['/repo'], home: null })
  assert.deepEqual(digest.edited_files, ['main.py'])
  assert.equal(digest.resolved, false)
  assert.deepEqual(digest.test_invocations, ['python -m pytest -q'])
  assert.equal(digest.repro_written, false)
  assert.match(digest._cmd_blob, /pytest/)
})

test('distiller: proposer prompts are deterministic and carry the constraints', () => {
  const digest = D.buildGenericDigest([call('npm test', '3 passing')], {
    iid: 't1',
    resolved: true,
    startCwd: '/repo',
    top: '/repo',
  })
  const prompt = D.buildProposerPrompt('example/repo', [digest], { 'npm-test': 'Canonical is npm test' }, ['edited'], {
    rawExcerpts: ['docker build .'],
    external: ['Node 22 is installed.'],
    generic: true,
  })
  assert.equal(prompt, D.buildProposerPrompt('example/repo', [digest], { 'npm-test': 'Canonical is npm test' }, ['edited'], {
    rawExcerpts: ['docker build .'],
    external: ['Node 22 is installed.'],
    generic: true,
  }))
  assert.match(prompt, /example\/repo/)
  assert.match(prompt, /npm-test/)
  assert.match(prompt, /Node 22 is installed/)
  assert.match(prompt, /docker build/)
  assert.equal(prompt.includes('_cmd_blob'), false, 'raw blobs must not reach the prompt')
  assert.match(D.PROPOSER_SYSTEM, new RegExp(String(D.MAX_CANDS)))
  assert.match(D.PROPOSER_SYSTEM_GENERIC, new RegExp(String(D.MAX_CANDS)))
})

test('distiller: parse_payload extracts the first JSON object and filters malformed rows', () => {
  const [extractors, facts] = D.parsePayload(
    'noise {"extractors": [{"name": "docker", "pattern": "docker "}, {"name": "x"}],'
      + ' "facts": [{"id": "a", "detector": {"scope": "cmd_regex"}}, {"id": "b"}]} noise',
  )
  assert.deepEqual(extractors, [{ name: 'docker', pattern: 'docker ' }])
  assert.deepEqual(facts, [{ id: 'a', detector: { scope: 'cmd_regex' } }])
  assert.deepEqual(D.parsePayload('not json'), [[], []])
  assert.deepEqual(D.parsePayload('{"facts": []}'), [[], []])
})

test('distiller: detectors confirm, contradict and fire on the generic predicates', () => {
  const digest = D.buildGenericDigest([
    call('npm test', '3 passing'),
    call('npm run lint', 'ok'),
  ], { iid: 't1', resolved: true, startCwd: '/repo', top: '/repo' })

  const confirms = new D.DetectorV3Scope({ scope: 'ran_checks', confirm: 'npm test', fired: 'ran_checks' }, {})
  assert.deepEqual(confirms.verdict(digest), ['confirm', true, true])

  // `contradict` wins over `confirm` when both patterns match (upstream `Detector.verdict`).
  const contradicts = new D.DetectorV3Scope(
    { scope: 'ran_checks', confirm: 'npm test', contradict: 'npm run lint' },
    {},
  )
  assert.deepEqual(contradicts.verdict(digest), ['contradict', true, true])

  // A scope that does not match is not exercised, so no verdict.
  const silent = new D.DetectorV3Scope({ scope: 'cmd_regex', confirm: 'deploy --prod' }, {})
  assert.deepEqual(silent.verdict(digest), [null, false, false])

  // An authored feature only satisfies the scope; `fired` names the scope by default.
  const feature = new D.DetectorV3Scope({ scope: 'edited_cross_ecosystem' }, {
    edited_cross_ecosystem: true,
  })
  assert.deepEqual(feature.verdict(digest), [null, true, true])
})

test('distiller: extractors compile and evaluate', () => {
  // Extractor.compute takes the (command, output) pairs, not a digest (upstream signature).
  const cmds = D.bashCmds([call('docker build -t app .', 'error: no daemon')])
  const byCmd = new D.Extractor({ name: 'docker', kind: 'cmd_regex', pattern: 'docker build' })
  assert.equal(byCmd.compute(cmds), true)
  assert.equal(byCmd.toDict().name, 'docker')

  const byOut = new D.Extractor({ name: 'daemon', kind: 'out_regex', pattern: 'no daemon' })
  assert.equal(byOut.compute(cmds), true)

  const count = new D.Extractor({ name: 'many', kind: 'cmd_count', pattern: 'docker' })
  assert.equal(count.compute(cmds), 1)
  assert.equal(new D.Extractor({ name: 'bad', kind: 'cmd_regex', pattern: '(' }).compute(cmds), false)
  assert.equal(new D.Extractor({ name: 'bad', kind: 'cmd_count', pattern: '(' }).compute(cmds), 0)
})

test('distiller: grounding admits facts only with two distinct citations', () => {
  const distiller = new D.Distiller('example/repo', { vocab: O.GENERIC })
  distiller.update([call('npm run lint', 'ok')], { iid: 'i1', resolved: true, startCwd: '/repo' })
  distiller.update([call('npm run lint', 'ok')], { iid: 'i2', resolved: true, startCwd: '/repo' })

  const spec = {
    id: 'lint',
    claim: 'Lint is `npm run lint`.',
    detector: { scope: 'ran_checks', confirm: 'npm run lint' },
    cite: ['i1', 'i2'],
  }
  assert.equal(distiller.ground(spec), 2)
  assert.deepEqual(distiller.admit(spec), [true, 'admitted'])
  assert.equal(distiller.facts.get('lint').state, 'CANDIDATE')

  const oneCite = { ...spec, id: 'lint-one', cite: ['i1'] }
  assert.deepEqual(distiller.admit(oneCite), [false, 'grounding-fail(1/2)'])
})

// ---------------------------------------------------------------------------------------
// engine: environment facts
// ---------------------------------------------------------------------------------------

test('engine: an active env fact reaches the injected block and records usage', () => {
  const fact = new E.EnvFact('form_repair:run_tests:python runtests.py', 'form_repair', false, {
    intent: 'run_tests',
    a: 'python runtests.py',
    b_counts: { 'cd src && python runtests.py': 3 },
    error_counts: { module_missing: 2 },
  })
  for (let i = 0; i < 4; i += 1) E.fold(fact, i, 'confirm', true, true, [])
  const row = E.envFactToStored(fact, { createdAt: AT, updatedAt: AT, sessionId: 's-1', turn: 1 })

  const engine = newEngine()
  const result = engine.run({ window: windowOf([], 4), facts: [row], config: config(), policy: DEFAULT_REDACTION })
  assert.match(result.injectedBlock, /^# environment facts learned from earlier sessions in this repository\n/)
  assert.match(result.injectedBlock, /python runtests\.py/)
  assert.equal(result.injectedTokens, Math.ceil(result.injectedBlock.length / 4))
  assert.deepEqual(result.appliedFactIds, [row.id])
  assert.equal(result.facts[0].lastUsedAt, '2026-01-05T00:00:00.000Z')
  assert.equal(result.facts[0].id, row.id)
})

test('engine: only ACTIVE rows with a passing firing gate are injected', () => {
  const candidateRow = factRow('npm-test', 'Canonical test is `npm test`.', [['confirm', true]])
  const retiredRow = promotedRow('old-lint', 'Lint is `npm run lint`.', { high: true })
  const retired = L.Lifecycle.fromDict(retiredRow, { kPromote: 2 })
  retired.update(0, 'contradict', false, true, [])
  const killed = L.storedFactFromLifecycle(retired, {
    id: retiredRow.id,
    text: retiredRow.text,
    kind: retiredRow.kind,
    createdAt: AT,
    updatedAt: AT,
  })
  const disabledRow = promotedRow('disabled', 'Disabled fact.', { enabled: false })

  const result = newEngine().run({
    window: windowOf([], 1),
    facts: [candidateRow, killed, disabledRow],
    config: config({ microskillsProfile: 'distiller' }),
    policy: DEFAULT_REDACTION,
  })
  assert.equal(result.injectedBlock, '')
  assert.deepEqual(result.appliedFactIds, [])
})

test('engine: config 0 caps suppress injection entirely', () => {
  const row = promotedRow('npm-test', 'Canonical test is `npm test`.')
  const result = newEngine().run({
    window: windowOf([], 1),
    facts: [row],
    config: config({ microskillsProfile: 'distiller', microskillsMaxFacts: 0 }),
    policy: DEFAULT_REDACTION,
  })
  assert.equal(result.injectedBlock, '')
})

test('engine: disabled micro-skills change nothing and never inject', () => {
  const row = promotedRow('npm-test', 'Canonical test is `npm test`.')
  const before = JSON.stringify(row)
  const result = newEngine().run({
    window: windowOf([], 1),
    facts: [row],
    config: config({ microskillsEnabled: false }),
    policy: DEFAULT_REDACTION,
    proposed: [candidate()],
  })
  assert.equal(result.injectedBlock, '')
  assert.deepEqual(result.candidates, [])
  assert.equal(JSON.stringify(row), before, 'the input rows are not mutated')
  assert.equal(result.facts.length, 1)
})

// ---------------------------------------------------------------------------------------
// engine: distiller facts and lifecycle
// ---------------------------------------------------------------------------------------

function promoteThroughEngine(key, text, options = {}) {
  const engine = newEngine()
  let facts = []
  let result = null
  for (let index = 0; index < (options.runs ?? 4); index += 1) {
    result = engine.run({
      window: windowOf([], index, { sessionId: `s-${index + 1}` }),
      facts,
      config: config({
        microskillsProfile: 'distiller',
        microskillsMinConfirmations: options.minConfirmations ?? 2,
        microskillsMaxFacts: options.maxFacts ?? 12,
      }),
      policy: DEFAULT_REDACTION,
      proposed: [candidate({ key, text, ...(options.candidate ?? {}) })],
    })
    facts = result.facts
  }
  return { result, facts }
}

test('engine: distiller facts are promoted and rendered under a repo manual header', () => {
  const { result } = promoteThroughEngine('npm-test', 'Canonical test is `npm test`.')
  assert.match(
    result.injectedBlock,
    /^# repo operating manual \(repo\) — learned from earlier sessions in this repository\n/,
  )
  assert.match(result.injectedBlock, /- Canonical test is `npm test`\./)
  assert.equal(result.appliedFactIds.length, 1)
  const stored = result.facts.find((row) => row.key === 'npm-test')
  assert.equal(stored.state, 'ACTIVE')
  assert.equal(stored.fireDen, 4)
})

test('engine: an earlier environment task can supersede a manual fact', () => {
  // Same key, different text: newest wins and the older row is retired.
  const older = factRow('same-key', 'Old text.', [['confirm', true], ['confirm', true]])
  const newer = promotedRow('same-key', 'New text.')
  newer.updatedAt = '2026-02-01T00:00:00.000Z'
  const result = newEngine().run({
    window: windowOf([], 2),
    facts: [older, newer],
    config: config({ microskillsProfile: 'distiller' }),
    policy: DEFAULT_REDACTION,
  })
  const live = result.facts.filter((row) => row.state !== 'RETIRED')
  assert.equal(live.length, 1)
  assert.equal(live[0].text, 'New text.')
  assert.match(result.injectedBlock, /New text\./)
  assert.equal(result.injectedBlock.includes('Old text.'), false)
  assert.equal(result.facts.find((row) => row.id === older.id).state, 'RETIRED')
})

test('engine: repeated runs are deterministic and instances are independent', () => {
  const row = promotedRow('npm-test', 'Canonical test is `npm test`.')
  const input = {
    window: windowOf([], 3),
    facts: [row],
    config: config({ microskillsProfile: 'distiller' }),
    policy: DEFAULT_REDACTION,
    proposed: [candidate()],
  }
  const a = newEngine().run(input)
  const b = newEngine().run({ ...input, facts: [row] })
  assert.deepEqual(a, b)
  const again = newEngine().run(input)
  assert.deepEqual(a, again)
})

test('engine: proposer input is exposed as digest and prompt when the distiller is on', () => {
  const engine = newEngine()
  engine.run({
    window: windowOf([call('npm test', '3 passing')], 0),
    facts: [],
    config: config({ microskillsProfile: 'envfacts+distiller' }),
    policy: DEFAULT_REDACTION,
  })
  assert.ok(engine.lastProposer)
  assert.equal(engine.lastProposer.proposerDigest.iid.length > 0, true)
  assert.match(engine.lastProposer.proposerPrompt, /example\/repo/)
  assert.equal(engine.lastProposer.proposerPrompt.includes('_out_blob'), false)
})

test('engine: envfacts profile alone does not build a proposer prompt', () => {
  const engine = newEngine()
  engine.run({
    window: windowOf([call('npm test', '3 passing')], 0),
    facts: [],
    config: config({ microskillsProfile: 'envfacts' }),
    policy: DEFAULT_REDACTION,
  })
  // The extras object is always present, but without the distiller profile no digest is built.
  assert.deepEqual(engine.lastProposer, { proposerDigest: null, proposerPrompt: null })
})

// ---------------------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------------------

test('redaction: secrets in stored text never reach the injected block', () => {
  const secret = 'API_KEY=supersecret123'
  const row = promotedRow('leaky', `Deploy needs ${secret} and token=abcdef123456.`, {
    evidence: [`export ${secret}`],
  })
  const result = newEngine().run({
    window: windowOf([], 1),
    facts: [row],
    config: config({ microskillsProfile: 'distiller' }),
    policy: DEFAULT_REDACTION,
  })
  assert.equal(result.injectedBlock.includes('supersecret123'), false)
  assert.equal(result.injectedBlock.includes('abcdef123456'), false)
  assert.match(result.injectedBlock, /\[REDACTED\]/)
  for (const stored of result.facts) {
    assert.equal(JSON.stringify(stored.source).includes('supersecret123'), false)
  }
})

test('redaction: sensitive edited files are dropped from candidates', () => {
  const result = newEngine().run({
    window: windowOf([], 1),
    facts: [],
    config: config({ microskillsProfile: 'envfacts' }),
    policy: DEFAULT_REDACTION,
    proposed: [candidate({ files: ['.env', 'src/a.ts', 'keys/id_rsa'] })],
  })
  assert.equal(result.candidates.length, 1)
  // Candidate files are basenames: `.env`, `id_rsa` and other sensitive names are dropped.
  assert.deepEqual(result.candidates[0].files, ['a.ts'])
})

test('redaction: sanitizeText output agrees with what the engine stores', () => {
  const raw = 'token=abcdef123456'
  assert.equal(sanitizeText(raw, DEFAULT_REDACTION), 'token=[REDACTED]')
})

test('redaction: env fact claims never leak the file paths of evidence', () => {
  const fact = new E.EnvFact('form_repair:run_tests:a', 'form_repair', false, {
    intent: 'run_tests',
    a: 'a',
    b_counts: { b: 2 },
    error_counts: {},
  })
  for (let i = 0; i < 4; i += 1) E.fold(fact, i, 'confirm', true, true, ['/home/user/project/src/a.py'])
  const row = E.envFactToStored(fact, { createdAt: AT, sessionId: 's-1', turn: 1 })
  const result = newEngine().run({
    window: windowOf([], 1),
    facts: [row],
    config: config(),
    policy: DEFAULT_REDACTION,
  })
  assert.equal(result.injectedBlock.includes('/home/user'), false)
})

test('distiller: parse_payload enforces JSON types before admitting rows', () => {
  const [extractors, facts] = D.parsePayload(JSON.stringify({
    extractors: [
      { name: 'docker', pattern: 'docker ' },
      { name: 1, pattern: 'docker ' },
      { name: 'bad-pattern', pattern: 42 },
      { name: 'array-pattern', pattern: ['x'] },
    ],
    facts: [
      { id: 'good', detector: { scope: 'cmd_regex' }, cite: ['t1'] },
      { id: 'all-null', detector: { scope: null, fired: null, confirm: null, contradict: null } },
      { id: 1, detector: { scope: 'cmd_regex' } },
      { id: 'number-scope', detector: { scope: 1 } },
      { id: 'array-scope', detector: { scope: ['x'] } },
      { id: 'string-cite', detector: { scope: 'cmd_regex' }, cite: 't1' },
      { id: 'array-detector', detector: [] },
      { id: 'empty-detector', detector: {} },
    ],
  }))
  assert.deepEqual(extractors, [{ name: 'docker', pattern: 'docker ' }])
  assert.deepEqual(facts, [
    { id: 'good', detector: { scope: 'cmd_regex' }, cite: ['t1'] },
    { id: 'all-null', detector: { scope: null, fired: null, confirm: null, contradict: null } },
  ])
})
