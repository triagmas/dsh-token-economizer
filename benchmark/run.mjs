#!/usr/bin/env node
/**
 * Reproducible benchmark for the three mechanisms.
 *
 * It measures the plugin's own deterministic work (schema text, rendered
 * injection text, guard decisions) plus explicitly-labelled assumptions about
 * what those artefacts would otherwise cost. It does NOT call a model, so it is
 * free and deterministic; no number here depends on provider pricing or luck.
 *
 *   node benchmark/run.mjs            # prints a table, writes benchmark/out/
 *
 * Inputs are synthetic but the code paths are the shipped implementations.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

const root = new URL('../', import.meta.url).pathname
const { Store } = await import(join(root, 'lib/storage/store.js'))
const { EconomizerService } = await import(join(root, 'lib/plugin/service.js'))
const { resolveConfig } = await import(join(root, 'lib/config/schema.js'))
const { buildUsageReport, parsePriceTable } = await import(join(root, 'lib/metrics/ledger.js'))
const { newToolStat } = await import(join(root, 'lib/toolprune/stats.js'))
const { evaluateCandidate, proposedCandidates, computeDenySet, snapshot } = await import(
  join(root, 'lib/toolprune/policy.js')
)
const { LoopGuardEngine } = await import(join(root, 'lib/loopguard/index.js'))

const results = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  assumptions: {
    tokensPerByte: 1 / 4,
    rediscoveryTokensPerFact: 1200,
    failedToolTurnTokens: 2500,
    judgeTokensPerCall: 120,
    note:
      'Mechanism sizes are measured from the shipped renderers. The rediscovery and failed-turn ' +
      'figures are stated assumptions used only to express the size of a saving; they are not measured model output.',
  },
}

const tokenEstimate = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
const round = (value) => Math.round(value * 1000) / 1000

// ---------------------------------------------------------------- tool pruning
function synthTool(index) {
  const names = ['edit', 'bash', 'read', 'grep', 'glob', 'write', 'lint', 'test']
  return names[index % names.length] + (index >= names.length ? `_${Math.floor(index / names.length)}` : '')
}

function benchmarkToolPruning() {
  const total = 30
  const used = new Set(['edit', 'bash', 'read', 'grep'])
  const descriptionTokens = (index) => 60 + ((index * 137) % 420)
  const file = { schemaVersion: 1, taskIndex: 6, tools: {}, pruned: [], lastAuditTask: 0, updatedAt: null }
  for (let index = 0; index < total; index += 1) {
    const name = synthTool(index)
    const stat = newToolStat(name, { descriptionTokens: descriptionTokens(index) })
    const isUsed = used.has(name)
    stat.sessions = 6
    stat.sessionsAvailable = 6
    stat.unusedSessions = isUsed ? 0 : 6
    stat.calls = isUsed ? 5 : 0
    stat.successes = isUsed ? 5 : 0
    stat.failures = 0
    stat.lastUsedAt = isUsed ? '2026-01-01T00:00:00.000Z' : null
    stat.lastUsedSeq = isUsed ? 1 : null
    file.tools[name] = stat
  }
  const config = resolveConfig({
    mode: 'active',
    toolpruneMode: 'automatic',
    toolpruneEvidence: 3,
    toolpruneMinSessions: 3,
    toolpruneReauditEvery: 25,
  })
  const facts = snapshot(file, { observedSessions: 6 })
  const candidates = proposedCandidates(file, config, facts)
  const deny = computeDenySet(file, config, { observedSessions: 6 })
  const catalogTokens = Object.values(file.tools).reduce((sum, row) => sum + row.descriptionTokens, 0)
  const hiddenTokens = deny.reduce((sum, name) => sum + (file.tools[name]?.descriptionTokens ?? 0), 0)
  const reasons = {}
  for (const row of Object.values(file.tools)) {
    const decision = evaluateCandidate(row, config, facts)
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1
  }
  return {
    catalogTools: total,
    catalogTokens,
    candidateTools: candidates.length,
    hiddenTools: deny.length,
    hiddenTokens,
    hiddenPercentOfCatalog: round((hiddenTokens / catalogTokens) * 100),
    reasons,
    protectedNeverHidden: ['lint_', 'codegraph_', 'terminal_'].every((prefix) => !deny.some((name) => name.startsWith(prefix))),
  }
}

// -------------------------------------------------------------- micro-skills
function envFactRow(index, text) {
  return {
    id: `env-fact-${index}`,
    key: `env-${index}`,
    kind: 'command',
    text,
    high: false,
    drift: false,
    state: 'ACTIVE',
    confirms: [
      [1, []],
      [2, []],
      [3, []],
    ],
    contradicts: [],
    fireNum: 8,
    fireDen: 10,
    promotedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    lastUsedAt: '2026-01-03T00:00:00.000Z',
    enabled: true,
    source: { sessionId: 's', turn: 1, evidence: ['observed'] },
  }
}

async function benchmarkMicroskills() {
  const home = await mkdtemp(join(tmpdir(), 'te-bench-'))
  try {
    const projectRoot = join(home, 'repo')
    await mkdir(projectRoot, { recursive: true })
    const store = new Store({ DSH_HOME: home })
    await store.open('0.1.0', '0.2.2')
    const project = await store.project(projectRoot)
    const claims = [
      'Run tests with pnpm test in this repository.',
      'Lint with pnpm lint before committing.',
      'Build with pnpm build.',
      'The package manager is pnpm (pnpm-lock.yaml).',
      'Python tooling runs through uv.',
      'Use pytest -q for the test suite.',
      'Format with ruff format.',
      'The default branch is main.',
      'CI runs on Node 22.',
      'Generated files live under dist/.',
      'Secrets belong in .env.local, never in git.',
      'Integration tests require the TEST_DATABASE_URL variable.',
    ]
    await project.updateSkills((file) => {
      file.taskIndex = 4
      file.facts = claims.map((text, index) => envFactRow(index, text))
    })
    const config = { mode: 'active', microskillsEnabled: true, microskillsInject: true, microskillsProfile: 'distiller', microskillsMaxFacts: 12, microskillsMaxTokens: 700 }
    const service = new EconomizerService({
      store,
      logger: { warn: () => {}, info: () => {} },
      pluginVersion: '0.1.0',
      dshVersion: '0.2.2',
      compatibility: { ok: true, version: '0.2.2', testedRange: '>=0.2.0 <0.3.0', reason: 'benchmark' },
      config: () => config,
      judge: null,
      applyRedirect: () => false,
      onToolsChanged: () => {},
    })
    service.registerRoot('session-1', projectRoot)
    await service.warmProject(projectRoot)
    const block = service.knowledgeForSession('session-1')
    const blockTokens = tokenEstimate(block)
    const capped = resolveConfig({ ...config, microskillsMaxFacts: 4, microskillsMaxTokens: 120 })
    const cappedService = new EconomizerService({
      store,
      logger: { warn: () => {}, info: () => {} },
      pluginVersion: '0.1.0',
      dshVersion: '0.2.2',
      compatibility: { ok: true, version: '0.2.2', testedRange: '>=0.2.0 <0.3.0', reason: 'benchmark' },
      config: () => capped,
      judge: null,
      applyRedirect: () => false,
      onToolsChanged: () => {},
    })
    cappedService.registerRoot('session-2', projectRoot)
    await cappedService.warmProject(projectRoot)
    const cappedBlock = cappedService.knowledgeForSession('session-2')
    await service.dispose()
    await cappedService.dispose()

    return {
      factsAvailable: claims.length,
      factsInjected: block.split('\n').filter((line) => line.startsWith('- ')).length,
      blockTokens,
      blockBytes: Buffer.byteLength(block, 'utf8'),
      cappedBlockTokens: tokenEstimate(cappedBlock),
      cappedFacts: cappedBlock.split('\n').filter((line) => line.startsWith('- ')).length,
      // One copy per request while the session runs; the comparison is explicit.
      overheadPerRequest: blockTokens,
      assumedRediscoveryTokensAverted: claims.length * results.assumptions.rediscoveryTokensPerFact,
      breakEvenRequests: Math.ceil(
        (claims.length * results.assumptions.rediscoveryTokensPerFact) / Math.max(1, blockTokens),
      ),
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ----------------------------------------------------------------- loop guard
async function benchmarkLoopGuard() {
  const config = resolveConfig({
    mode: 'active',
    loopguardEnabled: true,
    loopguardIntervene: true,
    loopguardJudge: true,
    loopguardJudgeConfidence: 0.7,
    loopguardMaxInterventions: 1,
  })
  let judgeCalls = 0
  const judgeFn = async () => {
    judgeCalls += 1
    return JSON.stringify({ stuck: true, confidence: 0.92, reason: 'the same failing command repeats without new evidence' })
  }
  const engine = new LoopGuardEngine({
    agentId: 'bench',
    sessionId: 'bench',
    rootSessionId: 'bench',
    projectId: 'bench',
    config,
    judgeFn,
    nudgeWriterFn: () => 'Stop repeating the same failing command; read the error and change the approach.',
    // A warm envelope keeps the benchmark focused on loop detection, not cold-start delay.
    envelopeSnapshot: { resolved_turns: [10, 10, 10, 10, 10] },
  })
  const started = performance.now()
  let seq = 0
  const feed = (name, args, output, isError, step) => {
    seq += 1
    engine.onToolCall({
      callId: `c-${seq}`,
      name,
      argumentsText: JSON.stringify(args),
      args,
      output,
      isError,
      turn: 1,
      step,
      at: 1_700_000_000_000 + seq,
    })
  }
  let detectedAtCall = null
  let detection = null
  engine.onTurnStart(1)
  let step = 0
  for (let pair = 1; pair <= 10 && !detection; pair += 1) {
    step += 1
    feed('edit', { file_path: 'src/app.ts' }, '', false, step)
    step += 1
    feed('bash', { command: 'pnpm test' }, 'FAIL tests/unit.test.ts - expected 2, received 3\n1 failed in 0.05s', true, step)
    engine.onStepEnd()
    const decision = await engine.decide()
    if (decision.action === 'redirect') {
      detectedAtCall = pair * 2
      detection = {
        reason: decision.reason,
        judge: decision.judge,
        confidence: decision.confidence,
        nudge: decision.nudge ? tokenEstimate(decision.nudge) : 0,
        apply: decision.apply,
      }
    }
  }
  engine.onTurnEnd()
  const elapsed = performance.now() - started
  return {
    toolCallsSimulated: seq,
    detectedAfterToolCalls: detectedAtCall,
    detection,
    judgeCalls,
    judgeTokens: judgeCalls * results.assumptions.judgeTokensPerCall,
    elapsedMs: round(elapsed),
    neverStopsAgent: true,
    envelope: 'warm snapshot {resolved_turns:[10,10,10,10,10]}',
  }
}

// ------------------------------------------------------------------- pricing
function benchmarkPricing() {
  const rows = [
    {
      schemaVersion: 1,
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 's',
      rootSessionId: 's',
      delegationDepth: 0,
      isSubagent: false,
      projectId: 'p',
      kind: 'model',
      model: 'deepseek-v4.1-flash',
      provider: 'deepseek',
      usage: { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 180_000, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 202_000 },
    },
  ]
  const unknown = buildUsageReport(rows, { scope: 'project', projectId: 'p' })
  const prices = parsePriceTable(
    JSON.stringify({
      'deepseek/deepseek-v4.1-flash': { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
    }),
  )
  const priced = buildUsageReport(rows, { scope: 'project', projectId: 'p', prices })
  return {
    rawTokens: unknown.usage.totalTokens,
    effectiveTokens: unknown.effectiveTokens,
    costWithoutTable: unknown.costUsd,
    unavailableModels: unknown.costUnavailableModels,
    costWithTableUsd: priced.costUsd === null ? null : round(priced.costUsd),
    note: 'No price is invented: without the user table the answer is "unavailable". Effective tokens need a known weight entry.',
  }
}

const toolPruning = benchmarkToolPruning()
const microskills = await benchmarkMicroskills()
const loopguard = await benchmarkLoopGuard()
const pricing = benchmarkPricing()

results.results = { toolPruning, microskills, loopguard, pricing }

const outDir = join(root, 'benchmark/out')
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n')

const lines = [
  '# dsh-token-economizer benchmark',
  '',
  `Generated: ${results.generatedAt} (Node ${results.node})`,
  '',
  '| Metric | Value |',
  '| --- | --- |',
  `| Tool catalog size | ${toolPruning.catalogTools} tools / ${toolPruning.catalogTokens} tokens |`,
  `| Tools hidden after evidence | ${toolPruning.hiddenTools} (${toolPruning.hiddenPercentOfCatalog}% of catalog tokens) |`,
  `| Token saving per request from pruning | ~${toolPruning.hiddenTokens} |`,
  `| Protected tools kept | ${toolPruning.protectedNeverHidden ? 'yes' : 'NO'} |`,
  `| Facts injected (cap 12) | ${microskills.factsInjected} of ${microskills.factsAvailable} |`,
  `| Injection block | ${microskills.blockTokens} tokens (${microskills.blockBytes} bytes) |`,
  `| Injection block under a 4-fact / 120-token cap | ${microskills.cappedFacts} facts / ${microskills.cappedBlockTokens} tokens |`,
  `| Assumed rediscovery tokens averted | ${microskills.assumedRediscoveryTokensAverted} |`,
  `| Loop detected after tool calls | ${loopguard.detectedAfterToolCalls} of ${loopguard.toolCallsSimulated} |`,
  `| Judge calls / tokens for detection | ${loopguard.judgeCalls} / ${loopguard.judgeTokens} |`,
  `| Cost shown without user price table | ${pricing.costWithoutTable === null ? 'unavailable' : pricing.costWithoutTable} |`,
  `| Cost with explicit table | ${pricing.costWithTableUsd === null ? 'unavailable' : '$' + pricing.costWithTableUsd} |`,
  '',
  'Assumptions (stated, not measured model output):',
  `- Tokens estimated at bytes/4.`,
  `- A rediscovered fact would cost ~${results.assumptions.rediscoveryTokensPerFact} tokens; a stuck turn ~${results.assumptions.failedToolTurnTokens}.`,
  `- The fake judge returns a fixed verdict and costs ${results.assumptions.judgeTokensPerCall} tokens per call.`,
]
await writeFile(join(outDir, 'results.md'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
