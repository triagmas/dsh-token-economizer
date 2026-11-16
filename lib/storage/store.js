/**
 * Local persistence.
 *
 * Layout under `<DSH_HOME>/token-economizer/`:
 *
 *   install.json                      schema version + install metadata
 *   errors.log                        redacted plugin diagnostics
 *   projects/<projectId>/project.json workspace identity
 *   projects/<projectId>/skills.json  lifecycle rows (micro-skills)
 *   projects/<projectId>/tools.json   per-tool usage statistics
 *   projects/<projectId>/metrics.jsonl usage/tool/loop rows (rotated)
 *   projects/<projectId>/loops.jsonl  loop incidents (rotated)
 *
 * Every business file carries `schemaVersion`; a newer-than-supported version
 * fails closed for that file (the mechanism is disabled and the situation is
 * reported) instead of silently discarding the user's data.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { appendJsonl, ensureDir, nowIso, readJsonl, readJsonSafe, rotateJsonl, withFileLock, writeJsonAtomic, writeJsonlAtomic, } from '../core/atomic.js';
import { canonicalPath, dataRoot, projectIdForRoot, projectDir } from '../core/paths.js';
export const SCHEMA_VERSION = 1;
export const SUPPORTED_MAX_VERSION = 1;
export const EMPTY_SKILLS = {
    schemaVersion: SCHEMA_VERSION,
    taskIndex: 0,
    facts: [],
    sessionTasks: {},
    updatedAt: null,
    lastBlock: '',
    lastBlockTokens: 0,
    lastBlockIds: [],
};
export const EMPTY_TOOLS = {
    schemaVersion: SCHEMA_VERSION,
    tools: {},
    pruned: [],
    autoPending: null,
    lastActivityAt: null,
    lastAuditTask: -1,
    updatedAt: null,
};
function migrateSkills(file) {
    if (file.schemaVersion > SUPPORTED_MAX_VERSION) {
        throw new Error(`token-economizer: skills.json schema ${file.schemaVersion} is newer than supported ${SUPPORTED_MAX_VERSION}`);
    }
    return { ...file, schemaVersion: SCHEMA_VERSION };
}
function migrateTools(file) {
    if (file.schemaVersion > SUPPORTED_MAX_VERSION) {
        throw new Error(`token-economizer: tools.json schema ${file.schemaVersion} is newer than supported ${SUPPORTED_MAX_VERSION}`);
    }
    // Rows written by older releases predate `unusedPrompts`. Upstream's
    // `prompt_streaks or streaks` migration treated each unused session as one
    // prompt, so preserve that evidence here instead of inventing a zero. New
    // rows always carry an explicit counter, which is authoritative: an
    // autonomous-only session must not become prompt evidence.
    for (const stat of Object.values(file.tools ?? {})) {
        if (!stat)
            continue;
        const row = stat;
        if (!Number.isFinite(row.unusedPrompts) || (row.unusedPrompts ?? 0) < 0) {
            const sessions = Number.isFinite(row.unusedSessions) && (row.unusedSessions ?? 0) > 0 ? Math.floor(row.unusedSessions) : 0;
            row.unusedPrompts = sessions;
        }
    }
    return { ...file, schemaVersion: SCHEMA_VERSION };
}
/** Order async operations on one project (single process) and across processes via file locks. */
class Mutex {
    tail = Promise.resolve();
    run(fn) {
        const next = this.tail.then(fn, fn);
        this.tail = next.catch(() => undefined);
        return next;
    }
}
/** One workspace's store. */
export class ProjectStore {
    meta;
    dir;
    skillsMutex = new Mutex();
    toolsMutex = new Mutex();
    skillsCache = null;
    toolsCache = null;
    loopguardCache;
    constructor(meta, root, env = process.env) {
        this.meta = meta;
        this.dir = projectDir(meta.projectId, env);
        void root;
    }
    path(name) {
        return join(this.dir, name);
    }
    get metricsPath() {
        return this.path('metrics.jsonl');
    }
    get loopsPath() {
        return this.path('loops.jsonl');
    }
    get loopguardPath() {
        return this.path('loopguard.json');
    }
    async readSkillsFile() {
        const raw = await readJsonSafe(this.path('skills.json'), structuredClone(EMPTY_SKILLS));
        const file = migrateSkills({ ...EMPTY_SKILLS, ...raw, schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION });
        file.facts = Array.isArray(file.facts) ? file.facts : [];
        return file;
    }
    async loadSkills() {
        if (this.skillsCache)
            return this.skillsCache;
        const file = await this.readSkillsFile();
        this.skillsCache = file;
        return file;
    }
    async saveSkills(file) {
        await writeJsonAtomic(this.path('skills.json'), file);
        this.skillsCache = file;
    }
    /** Serialize a read-modify-write cycle on skills.json (in-process + cross-process). */
    async updateSkills(fn) {
        return this.skillsMutex.run(async () => {
            return withFileLock(this.path('skills.json'), async () => {
                // Another process may have written while this instance held a stale cache.
                const file = await this.readSkillsFile();
                const result = await fn(file);
                file.updatedAt = nowIso();
                await this.saveSkills(file);
                return result;
            });
        });
    }
    async readToolsFile() {
        const raw = await readJsonSafe(this.path('tools.json'), structuredClone(EMPTY_TOOLS));
        const file = migrateTools({ ...EMPTY_TOOLS, ...raw, schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION });
        file.tools = file.tools && typeof file.tools === 'object' ? file.tools : {};
        file.pruned = Array.isArray(file.pruned) ? file.pruned : [];
        return file;
    }
    async loadTools() {
        if (this.toolsCache)
            return this.toolsCache;
        const file = await this.readToolsFile();
        this.toolsCache = file;
        return file;
    }
    async saveTools(file) {
        await writeJsonAtomic(this.path('tools.json'), file);
        this.toolsCache = file;
    }
    async updateTools(fn) {
        return this.toolsMutex.run(async () => {
            return withFileLock(this.path('tools.json'), async () => {
                const file = await this.readToolsFile();
                const result = await fn(file);
                file.updatedAt = nowIso();
                await this.saveTools(file);
                return result;
            });
        });
    }
    /** The learned envelope for this repository, or null when nothing has been learned. */
    async loadLoopguard() {
        if (this.loopguardCache !== undefined)
            return this.loopguardCache;
        const raw = await readJsonSafe(this.loopguardPath, null);
        this.loopguardCache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
        return this.loopguardCache;
    }
    async saveLoopguard(snapshot) {
        this.loopguardCache = snapshot;
        await writeJsonAtomic(this.loopguardPath, snapshot);
    }
    async appendMetric(record, maxBytes) {
        await appendJsonl(this.metricsPath, [record], maxBytes);
    }
    /** Append several rows in one write (one turn produces many rows). */
    async appendMetrics(records, maxBytes) {
        if (!records.length)
            return;
        await appendJsonl(this.metricsPath, records, maxBytes);
    }
    /** Remove every recorded loop incident for this project. */
    async clearLoops() {
        await writeJsonlAtomic(this.loopsPath, []);
    }
    async appendLoop(incident, maxBytes) {
        await appendJsonl(this.loopsPath, [incident], maxBytes);
    }
    async readMetrics(maxRows = 20_000) {
        const rows = await readJsonl(this.metricsPath, maxRows);
        return rows.filter((row) => typeof row === 'object' && row !== null && 'kind' in row);
    }
    async readLoops(maxRows = 1_000) {
        const rows = await readJsonl(this.loopsPath, maxRows);
        return rows.filter((row) => typeof row === 'object' && row !== null && 'kind' in row);
    }
    /** Increment and return the project task index (one task = one finished turn). */
    async nextTaskIndex(sessionId) {
        return this.updateSkills((file) => {
            if (sessionId) {
                const known = file.sessionTasks?.[sessionId];
                if (Number.isInteger(known))
                    return Number(known);
                const index = file.taskIndex;
                file.taskIndex = index + 1;
                if (!file.sessionTasks)
                    file.sessionTasks = {};
                file.sessionTasks[sessionId] = index;
                // Bounded: a very old session id only costs a duplicate task index on a late turn.
                const keys = Object.keys(file.sessionTasks);
                if (keys.length > 512)
                    delete file.sessionTasks[keys[0]];
                return index;
            }
            const index = file.taskIndex;
            file.taskIndex = index + 1;
            return index;
        });
    }
    /** Delete metric rows older than the retention window; rotate oversized files. */
    async maintenance(retentionDays, maxBytes) {
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const rows = await this.readMetrics(1_000_000);
        const kept = rows.filter((row) => {
            const time = Date.parse(row.at ?? '');
            return !Number.isFinite(time) || time >= cutoff;
        });
        if (kept.length !== rows.length) {
            // One JSON object per line, written beside the target and renamed atomically.
            await writeJsonlAtomic(this.metricsPath, kept);
        }
        try {
            const info = await stat(this.metricsPath);
            if (info.size > maxBytes)
                await rotateJsonl(this.metricsPath);
        }
        catch {
            /* no metrics yet */
        }
    }
}
/** Process-wide storage facade. */
export class Store {
    root;
    env;
    cache = new Map();
    install = null;
    constructor(env = process.env) {
        this.env = env;
        this.root = dataRoot(env);
    }
    get projectsRoot() {
        return join(this.root, 'projects');
    }
    /** Create directories and read/write install metadata. */
    async open(pluginVersion, dshVersion) {
        await ensureDir(this.root);
        await ensureDir(this.projectsRoot);
        const path = join(this.root, 'install.json');
        const existing = await readJsonSafe(path, null);
        const install = existing
            ? { ...existing, lastSeenDshVersion: dshVersion ?? existing.lastSeenDshVersion }
            : {
                schemaVersion: SCHEMA_VERSION,
                pluginVersion,
                installedAt: nowIso(),
                lastSeenDshVersion: dshVersion,
            };
        if (install.schemaVersion > SUPPORTED_MAX_VERSION) {
            throw new Error(`token-economizer: data directory schema ${install.schemaVersion} is newer than supported ${SUPPORTED_MAX_VERSION}`);
        }
        install.schemaVersion = SCHEMA_VERSION;
        install.lastSeenDshVersion = dshVersion ?? install.lastSeenDshVersion;
        await writeJsonAtomic(path, install);
        this.install = install;
        return install;
    }
    /** Open (or return cached) project store for a workspace root. */
    async project(root) {
        const canonical = canonicalPath(root);
        const projectId = projectIdForRoot(canonical);
        const cached = this.cache.get(projectId);
        if (cached)
            return cached;
        const { existsSync } = await import('node:fs');
        const { findRepoRoot } = await import('../core/paths.js');
        const repo = existsSync(join(canonical, '.git')) ? { root: canonical, git: true } : findRepoRoot(canonical);
        const dir = projectDir(projectId, this.env);
        await ensureDir(dir);
        const metaPath = join(dir, 'project.json');
        const existing = await readJsonSafe(metaPath, null);
        const meta = existing
            ? { ...existing, root: canonical, updatedAt: nowIso() }
            : {
                schemaVersion: SCHEMA_VERSION,
                projectId,
                root: canonical,
                name: canonical.split(/[\\/]/).filter(Boolean).pop() ?? canonical,
                git: repo.git,
                gitCommonDir: 'gitCommonDir' in repo ? repo.gitCommonDir : undefined,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
        await writeJsonAtomic(metaPath, meta);
        const store = new ProjectStore(meta, canonical, this.env);
        this.cache.set(projectId, store);
        return store;
    }
    /** List project metadata for the UI, newest first. */
    async listProjects() {
        const names = await readdir(this.projectsRoot).catch(() => []);
        const result = [];
        for (const name of names.sort()) {
            const meta = await readJsonSafe(join(this.projectsRoot, name, 'project.json'), null);
            if (meta)
                result.push(meta);
        }
        result.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        return result;
    }
    /** Append a redacted diagnostic line to the plugin error log. */
    async logError(line) {
        await ensureDir(this.root);
        const stamp = nowIso();
        await appendJsonl(join(this.root, 'errors.log'), [{ at: stamp, line }], 1_048_576);
    }
    get installInfo() {
        return this.install;
    }
}
/** Fold raw metric rows into usage totals (used by reports and tests). */
export function foldUsage(rows) {
    const zero = () => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
    });
    const usage = zero();
    const pluginUsage = zero();
    const sessions = new Set();
    let modelRequests = 0;
    let toolCalls = 0;
    let failedToolCalls = 0;
    let loopInterventions = 0;
    let prunedTools = 0;
    let activeSkills = 0;
    let firstSeenAt = null;
    let updatedAt = null;
    for (const row of rows) {
        if (!row || typeof row !== 'object')
            continue;
        if (row.sessionId)
            sessions.add(row.sessionId);
        if (row.at) {
            if (!firstSeenAt || row.at < firstSeenAt)
                firstSeenAt = row.at;
            if (!updatedAt || row.at > updatedAt)
                updatedAt = row.at;
        }
        if (row.usage)
            for (const key of Object.keys(usage))
                usage[key] += row.usage[key] ?? 0;
        if (row.pluginUsage) {
            for (const key of Object.keys(pluginUsage))
                pluginUsage[key] += row.pluginUsage[key] ?? 0;
        }
        if (row.kind === 'model')
            modelRequests += 1;
        if (row.kind === 'tool') {
            toolCalls += 1;
            if (row.toolOk === false)
                failedToolCalls += 1;
        }
        if (row.kind === 'loop' && row.loop && row.loop.intervention !== 'none')
            loopInterventions += 1;
        if (row.kind === 'skills') {
            activeSkills = Math.max(activeSkills, row.skillsApplied ?? 0);
            prunedTools = Math.max(prunedTools, row.toolsPruned ?? 0);
        }
    }
    return {
        usage,
        pluginUsage,
        modelRequests,
        toolCalls,
        failedToolCalls,
        loopInterventions,
        prunedTools,
        activeSkills,
        sessions: sessions.size,
        firstSeenAt,
        updatedAt,
    };
}
