/**
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0, `tokeneconomizer/microskills/`
 * (`envfacts.py`, `lifecycle.py`, `distiller.py`, `stage.py`).
 *
 * `MicroskillsEngine` is the pure orchestrator the rest of the plugin calls once per finished
 * task: it turns the task window into learned facts, folds this task's evidence into their
 * lifecycles, and renders the block that the NEXT task may be prefixed with.
 *
 * What it does NOT do (each is deliberately the caller's):
 *  - any I/O. There is no filesystem, network or DSH/Cordis import: facts come in as
 *    `StoredFact` rows and go out the same way, and the caller persists them.
 *  - the paid proposer CALL. When the profile includes the distiller it builds the digest and
 *    the prompt (`lastProposerPrompt`) and folds whatever `proposed` facts the caller hands
 *    back; spending is the caller's decision.
 *  - `mode` / `microskillsInject` gating, project isolation, and schedule. The caller decides
 *    whether the returned block is used at all.
 *
 * Project isolation is the caller's responsibility: this engine only sees the `TaskWindow` and
 * rows it is given, holds no module-level mutable state, and keeps every fact scoped by key
 * within that input.
 */
import { createHash } from 'node:crypto';
import { isSensitivePath, sanitizeText } from '../core/redact.js';
import { GENERIC, observeTask, } from './observe.js';
import { EnvFactsDistiller, envFactFromStored, envFactKind, envFactToStored, isEnvFactRow, } from './envfacts.js';
import { applyLifecycleToStored, isInjectableRow, lifecycleFromStored, storedFactFromLifecycle, } from './lifecycle.js';
import { buildGenericDigest, buildProposerPrompt } from './distiller.js';
const PROFILE_ENV = new Set(['envfacts', 'envfacts+distiller']);
const PROFILE_DISTILLER = new Set(['distiller', 'envfacts+distiller']);
function cloneRow(row) {
    return structuredClone(row);
}
function baseName(path) {
    const normalized = path.replace(/\\/g, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
}
function factId(key) {
    return `fact_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}
function latestFirst(a, b) {
    if (a.updatedAt !== b.updatedAt)
        return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.createdAt !== b.createdAt)
        return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
}
/** Sanitize a fact's text and drop it when nothing is left. */
function safeText(text, policy) {
    return sanitizeText(text ?? '', policy).replace(/\s+/g, ' ').trim();
}
/**
 * The micro-skills orchestrator (`stage.ComposedDistiller`'s env-first, manual-on-top order,
 * without its I/O). One instance per call is fine; nothing is shared between runs.
 */
export class MicroskillsEngine {
    lastExtras = { proposerDigest: null, proposerPrompt: null };
    /** The proposer digest/prompt built by the last `run` (null when not applicable). */
    get lastProposer() {
        return this.lastExtras;
    }
    run(input) {
        const { window, config, policy } = input;
        const facts = input.facts.map(cloneRow);
        const empty = {
            candidates: [],
            facts,
            injectedBlock: '',
            injectedTokens: 0,
            appliedFactIds: [],
        };
        this.lastExtras = { proposerDigest: null, proposerPrompt: null };
        if (!config.microskillsEnabled)
            return empty;
        const profile = config.microskillsProfile;
        const envEnabled = PROFILE_ENV.has(profile);
        const distillerEnabled = PROFILE_DISTILLER.has(profile);
        // The plugin's reading is the generic one (`Vocabulary.generic`); callers may pass
        // `detectVocabulary`'s result when they know the repository's stack.
        const vocabulary = input.vocabulary ?? GENERIC;
        const edited = [...new Set(window.editedFiles.filter((path) => !isSensitivePath(path)).map((path) => baseName(path)))].sort();
        const digest = input.digest ??
            observeTask(window.calls, {
                vocab: vocabulary,
                edited,
            });
        const kPromote = config.microskillsMinConfirmations;
        const now = window.taskIndex;
        const at = window.at;
        const candidates = [];
        const source = { sessionId: window.sessionId, turn: window.turn };
        // ---- environment facts (LLM-free) ------------------------------------------------
        let envDistiller = null;
        if (envEnabled) {
            envDistiller = new EnvFactsDistiller({
                vocab: vocabulary,
                maxFacts: config.microskillsMaxFacts,
                maxTokens: config.microskillsMaxTokens,
                kPromote,
                now,
            });
            for (const row of facts) {
                if (row.enabled === false || !isEnvFactRow(row))
                    continue;
                const fact = envFactFromStored(row, { kPromote });
                if (fact)
                    envDistiller.facts.set(fact.id, fact);
            }
            envDistiller.seedInjected(input.injectedIds);
            envDistiller.update(digest, { resolved: null, edited });
            // Write the folded environment facts back into the rows.
            const byKey = new Map(facts.map((row, index) => [row.key, index]));
            for (const fact of envDistiller.facts.values()) {
                const text = safeText(fact.claim(), policy);
                if (!text)
                    continue;
                const index = byKey.get(fact.id);
                if (index === undefined) {
                    facts.push(envFactToStored(fact, { createdAt: at, updatedAt: at, ...source }));
                    byKey.set(fact.id, facts.length - 1);
                }
                else {
                    const row = facts[index];
                    applyLifecycleToStored(row, fact.life);
                    row.text = text;
                    row.updatedAt = at;
                    row.source = { ...row.source, sessionId: source.sessionId, turn: source.turn };
                }
                const [verdict, fired, exercised] = envDistiller.lastDigest?.verdicts[fact.id] ?? [null, false, false];
                candidates.push({
                    key: fact.id,
                    text,
                    kind: envFactKind(fact.family),
                    high: fact.life.high,
                    drift: false,
                    fired,
                    exercised,
                    files: [],
                    evidence: [text],
                    sourceSessionId: source.sessionId,
                    sourceTurn: source.turn,
                });
                void verdict;
            }
        }
        // ---- proposed (paid) facts --------------------------------------------------------
        const proposed = input.proposed ?? [];
        const verdicts = input.verdicts ?? {};
        for (const candidate of proposed) {
            const text = safeText(candidate.text, policy);
            if (!text)
                continue;
            const key = candidate.key;
            const index = facts.findIndex((row) => row.key === key && !isEnvFactRow(row));
            const verdict = verdicts[key] ?? 'confirm';
            let row;
            if (index === -1) {
                const seedRow = emptyRow(key, text, candidate, at, source);
                const life = lifecycleFromStored(seedRow, { kPromote });
                life.update(now, verdict, candidate.fired, candidate.exercised, candidate.files);
                row = storedFactFromLifecycle(life, {
                    id: factId(key),
                    text,
                    kind: candidate.kind,
                    createdAt: at,
                    updatedAt: at,
                    source: {
                        sessionId: source.sessionId,
                        turn: source.turn,
                        evidence: candidate.evidence.map((entry) => safeText(entry, policy)).filter(Boolean).slice(0, 3),
                    },
                });
                facts.push(row);
            }
            else {
                row = facts[index];
                const life = lifecycleFromStored(row, { kPromote });
                life.update(now, verdict, candidate.fired, candidate.exercised, candidate.files);
                applyLifecycleToStored(row, life);
                row.text = text;
                row.kind = candidate.kind;
                row.updatedAt = at;
                row.source = {
                    sessionId: source.sessionId,
                    turn: source.turn,
                    evidence: candidate.evidence.map((entry) => safeText(entry, policy)).filter(Boolean).slice(0, 3),
                };
            }
            candidates.push({
                key,
                text,
                kind: candidate.kind,
                high: candidate.high,
                drift: candidate.drift,
                fired: candidate.fired,
                exercised: candidate.exercised,
                files: candidate.files.filter((path) => !isSensitivePath(path)).map(baseName),
                evidence: candidate.evidence.map((entry) => safeText(entry, policy)).filter(Boolean).slice(0, 3),
                sourceSessionId: source.sessionId,
                sourceTurn: source.turn,
            });
        }
        // ---- dedupe / supersession by key: the newest live row wins ----------------------
        const live = new Map();
        for (const row of facts) {
            if (row.state === 'RETIRED' || row.enabled === false)
                continue;
            const previous = live.get(row.key);
            if (!previous) {
                live.set(row.key, row);
                continue;
            }
            const winner = latestFirst(row, previous) < 0 ? row : previous;
            const loser = winner === row ? previous : row;
            loser.state = 'RETIRED';
            loser.retiredAt = now;
            loser.updatedAt = at;
            live.set(row.key, winner);
        }
        // ---- the proposer's inputs (built, never spent) -----------------------------------
        if (distillerEnabled) {
            const proposerDigest = buildGenericDigest(window.calls, {
                iid: `${window.sessionId}:${window.turn}`,
                resolved: null,
            });
            const existing = {};
            for (const row of facts) {
                if (!isEnvFactRow(row))
                    existing[row.key] = row.text;
            }
            const prompt = buildProposerPrompt(input.repoName ?? window.projectId, [proposerDigest], existing, [], { generic: true });
            this.lastExtras = { proposerDigest, proposerPrompt: prompt };
        }
        // ---- render the block -------------------------------------------------------------
        const maxFacts = config.microskillsMaxFacts;
        const maxTokens = config.microskillsMaxTokens;
        const maxChars = maxTokens * 4;
        const rendered = this.renderBlock({
            facts,
            envDistiller,
            envEnabled,
            distillerEnabled,
            policy,
            maxFacts,
            maxChars,
            repoName: input.repoName ?? window.projectId,
        });
        if (rendered.block) {
            for (const id of rendered.appliedIds) {
                const row = facts.find((item) => item.id === id);
                if (row) {
                    row.lastUsedAt = at;
                    row.updatedAt = at;
                }
            }
        }
        // Evidence is persisted next to the fact, so it is re-sanitized on the way out too: rows
        // written by an older, less careful caller must not carry a secret back into the store.
        // Environment facts keep their state blob in `evidence[0]` (that is their serialization).
        const safeFacts = facts.map((row) => isEnvFactRow(row)
            ? row
            : {
                ...row,
                source: {
                    ...row.source,
                    evidence: row.source.evidence.map((entry) => safeText(entry, policy)).filter(Boolean),
                },
            });
        return {
            candidates,
            facts: safeFacts,
            injectedBlock: rendered.block,
            injectedTokens: rendered.block ? Math.ceil(rendered.block.length / 4) : 0,
            appliedFactIds: rendered.appliedIds,
        };
    }
    /**
     * Env block first (upstream `PrefixStage`), the manual on top; the combined block respects
     * `microskillsMaxFacts` and `microskillsMaxTokens` (~4 chars/token).
     */
    renderBlock(args) {
        const { envDistiller, policy, maxFacts, maxChars } = args;
        if (maxFacts === 0 || maxChars === 0)
            return { block: '', appliedIds: [] };
        let envChosen = [];
        let envLines = [];
        let envHeader = '';
        if (envDistiller && args.envEnabled) {
            envChosen = envDistiller.select();
            if (envChosen.length > 0) {
                envHeader = envDistiller.header;
                envLines = envDistiller.mergedLines(envChosen)
                    .map((text) => safeText(text, policy))
                    .filter(Boolean)
                    .map((text) => `- ${text}`);
                envDistiller.lastInjected = new Set(envChosen.map((fact) => fact.id));
            }
        }
        const envIds = envChosen.map((fact) => fact.id);
        let manualRows = [];
        if (args.distillerEnabled) {
            manualRows = args.facts
                .filter((row) => !isEnvFactRow(row) && isInjectableRow(row))
                .filter((row) => {
                const text = safeText(row.text, policy);
                return Boolean(text) && !/^\s*#/.test(text);
            })
                .sort((a, b) => {
                const rate = b.fireNum / Math.max(1, b.fireDen) - a.fireNum / Math.max(1, a.fireDen);
                return rate !== 0 ? rate : latestFirst(a, b);
            });
        }
        const manualHeader = `# repo operating manual (${baseName(args.repoName)}) — learned from earlier sessions in this repository`;
        const build = (envCount, manualCount) => {
            const parts = [];
            const ids = [];
            if (envCount > 0) {
                parts.push(envHeader, ...envLines.slice(0, envCount));
                ids.push(...envIds.slice(0, envCount));
            }
            if (manualCount > 0) {
                if (parts.length > 0)
                    parts.push('');
                parts.push(manualHeader);
                for (const row of manualRows.slice(0, manualCount)) {
                    parts.push(`- ${safeText(row.text, policy)}`);
                    ids.push(row.id);
                }
            }
            return { block: parts.length > 0 ? `${parts.join('\n')}\n` : '', appliedIds: ids };
        };
        // At most `maxFacts` facts in total, env facts first (they are the free layer).
        const manualBudget = Math.max(0, maxFacts - Math.min(envIds.length, maxFacts));
        let manualCount = Math.min(manualRows.length, manualBudget);
        let envCount = Math.min(envLines.length, envIds.length);
        let result = build(envCount, manualCount);
        while (result.block.length > maxChars && manualCount > 0) {
            manualCount -= 1;
            result = build(envCount, manualCount);
        }
        while (result.block.length > maxChars && envCount > 0) {
            envCount -= 1;
            result = build(envCount, manualCount);
        }
        if (result.block.length > maxChars)
            return { block: '', appliedIds: [] };
        return result;
    }
}
function emptyRow(key, text, candidate, at, source) {
    return {
        id: factId(key),
        key,
        text,
        kind: candidate.kind,
        high: candidate.high,
        drift: candidate.drift,
        state: 'CANDIDATE',
        confirms: [],
        contradicts: [],
        fireNum: 0,
        fireDen: 0,
        promotedAt: null,
        retiredAt: null,
        createdAt: at,
        updatedAt: at,
        lastUsedAt: null,
        enabled: true,
        source: { sessionId: source.sessionId, turn: source.turn, evidence: [] },
    };
}
/**
 * Render the persisted block without a task window: used by the UI preview and by the
 * host when a project is first opened. The engine's own renderer remains the authority
 * for what was actually injected at the end of a turn; this function applies the same
 * profile, ordering, headers and budgets to rows that are already on disk.
 */
export function renderStoredBlock(facts, config, policy, repoName = 'project') {
    if (!config.microskillsEnabled)
        return { block: '', tokens: 0, ids: [] };
    const maxFacts = config.microskillsMaxFacts;
    const maxChars = config.microskillsMaxTokens * 4;
    if (maxFacts === 0 || maxChars === 0)
        return { block: '', tokens: 0, ids: [] };
    const profile = config.microskillsProfile;
    const envEnabled = PROFILE_ENV.has(profile);
    const distillerEnabled = PROFILE_DISTILLER.has(profile);
    let envHeader = '';
    let envLines = [];
    let envIds = [];
    if (envEnabled) {
        const env = new EnvFactsDistiller({
            vocab: GENERIC,
            maxFacts,
            maxTokens: config.microskillsMaxTokens,
            kPromote: config.microskillsMinConfirmations,
            now: 0,
        });
        for (const row of facts) {
            if (row.enabled === false || !isEnvFactRow(row))
                continue;
            const fact = envFactFromStored(row, { kPromote: config.microskillsMinConfirmations });
            if (fact)
                env.facts.set(fact.id, fact);
        }
        const chosen = env.select();
        if (chosen.length > 0) {
            envHeader = env.header;
            envLines = env.mergedLines(chosen)
                .map((text) => safeText(text, policy))
                .filter(Boolean)
                .map((text) => `- ${text}`);
            envIds = chosen.map((fact) => fact.id);
        }
    }
    let manualRows = [];
    if (distillerEnabled) {
        manualRows = facts
            .filter((row) => !isEnvFactRow(row) && isInjectableRow(row))
            .filter((row) => {
            const text = safeText(row.text, policy);
            return Boolean(text) && !/^\s*#/.test(text);
        })
            .sort((a, b) => {
            const rate = b.fireNum / Math.max(1, b.fireDen) - a.fireNum / Math.max(1, a.fireDen);
            return rate !== 0 ? rate : latestFirst(a, b);
        });
    }
    const manualHeader = `# repo operating manual (${baseName(repoName)}) — learned from earlier sessions in this repository`;
    const build = (envCount, manualCount) => {
        const parts = [];
        const ids = [];
        if (envCount > 0) {
            parts.push(envHeader, ...envLines.slice(0, envCount));
            ids.push(...envIds.slice(0, envCount));
        }
        if (manualCount > 0) {
            if (parts.length > 0)
                parts.push('');
            parts.push(manualHeader);
            for (const row of manualRows.slice(0, manualCount)) {
                parts.push(`- ${safeText(row.text, policy)}`);
                ids.push(row.id);
            }
        }
        return { block: parts.length > 0 ? `${parts.join('\n')}\n` : '', ids };
    };
    const manualBudget = Math.max(0, maxFacts - Math.min(envIds.length, maxFacts));
    let manualCount = Math.min(manualRows.length, manualBudget);
    let envCount = Math.min(envLines.length, envIds.length);
    let result = build(envCount, manualCount);
    while (result.block.length > maxChars && manualCount > 0) {
        manualCount -= 1;
        result = build(envCount, manualCount);
    }
    while (result.block.length > maxChars && envCount > 0) {
        envCount -= 1;
        result = build(envCount, manualCount);
    }
    if (result.block.length > maxChars)
        return { block: '', tokens: 0, ids: [] };
    return {
        block: result.block,
        tokens: result.block ? Math.ceil(result.block.length / 4) : 0,
        ids: result.ids,
    };
}
