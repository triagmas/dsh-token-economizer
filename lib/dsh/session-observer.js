/**
 * Session event folding for the Token Economizer.
 *
 * The Harness Session log is the single source of truth. This observer is a
 * pure, bounded fold over `session/event`: it pairs tool calls with results,
 * accumulates provider-reported usage, identifies subagent lineage, and emits
 * one immutable `TurnSummary` per finished turn. It performs no I/O and never
 * throws into the Harness event dispatch.
 */
import { findRepoRoot } from '../core/paths.js';
import { DEFAULT_REDACTION, sanitizeText } from '../core/redact.js';
import { addUsage, EMPTY_USAGE } from '../core/types.js';
import { toUsageCounts } from './judge.js';
const MAX_SESSIONS = 200;
const MAX_CALLS_PER_TURN = 300;
const MAX_PENDING_CALLS = 1000;
const MAX_TOOL_OUTPUT_BYTES = 2_000;
const MAX_ASSISTANT_TEXT_BYTES = 4_000;
/** Cheap, bounded shape checks so an unknown event never crashes the fold. */
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
function textOfContent(content) {
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        const record = asRecord(block);
        if (record.type === 'text' && typeof record.text === 'string') {
            parts.push(record.text);
        }
        else if (record.type === 'image') {
            parts.push('[image]');
        }
        else if (record.type === 'reasoning' && typeof record.text === 'string') {
            // Reasoning text is model-private; keep a marker only.
            parts.push('[reasoning]');
        }
    }
    return parts.join('\n');
}
/** Tool names whose calls modify workspace files (used for write detection). */
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'str_replace', 'create', 'apply_patch', 'multiedit', 'notebook_edit']);
/** True when a tool call is expected to modify files. */
export function isWriteTool(name) {
    return WRITE_TOOL_NAMES.has(name.toLowerCase());
}
/** Extract a path argument from a write-like tool call. */
export function pathArgument(args) {
    for (const key of ['path', 'file_path', 'filePath', 'filename', 'file']) {
        const value = args[key];
        if (typeof value === 'string' && value.trim() !== '')
            return value;
    }
    return null;
}
/** Fold session events into turn summaries. */
export class SessionObserver {
    hooks;
    states = new Map();
    order = [];
    now;
    constructor(hooks, now = Date.now) {
        this.hooks = hooks;
        this.now = now;
    }
    /** Handle one committed session event. Exception-safe by design. */
    handle(session, event) {
        try {
            const sessionRecord = asRecord(session);
            const sessionId = typeof sessionRecord.id === 'string' ? sessionRecord.id : '';
            if (!sessionId)
                return;
            const eventRecord = asRecord(event);
            const type = typeof eventRecord.type === 'string' ? eventRecord.type : '';
            const data = asRecord(eventRecord.data);
            const at = typeof eventRecord.time === 'number' ? eventRecord.time : this.now();
            if (type === 'session/disposed') {
                this.finish(sessionId, at);
                this.states.delete(sessionId);
                const index = this.order.indexOf(sessionId);
                if (index >= 0)
                    this.order.splice(index, 1);
                return;
            }
            let state = this.states.get(sessionId);
            if (!state) {
                const created = this.createState(sessionRecord, at);
                if (!created)
                    return;
                state = created;
            }
            switch (type) {
                case 'turn/start': {
                    state.turn = numberOr(data.turn, state.turn);
                    state.turnStarted = true;
                    state.turnStartAt = new Date(at).toISOString();
                    this.hooks.onTurnStart(state.session, state.turn);
                    break;
                }
                case 'step/start': {
                    state.step = numberOr(data.step, state.step);
                    break;
                }
                case 'tool/call': {
                    const callId = typeof data.callId === 'string' ? data.callId : '';
                    const name = typeof data.name === 'string' ? data.name : '';
                    if (!callId || !name)
                        break;
                    if (state.pending.size >= MAX_PENDING_CALLS) {
                        const oldest = state.pending.keys().next().value;
                        if (typeof oldest === 'string')
                            state.pending.delete(oldest);
                    }
                    const argumentsText = typeof data.arguments === 'string' ? data.arguments : '';
                    state.pending.set(callId, {
                        name,
                        argumentsText,
                        args: parseArguments(argumentsText),
                        turn: numberOr(data.turn, state.turn),
                        step: numberOr(data.step, state.step),
                        at,
                    });
                    break;
                }
                case 'tool/result': {
                    const message = asRecord(data.message);
                    const source = asRecord(message.source);
                    const callId = typeof source.callId === 'string' ? source.callId : '';
                    const pending = callId ? state.pending.get(callId) : undefined;
                    if (!pending)
                        break; // resumed history: no accepted call to pair with
                    state.pending.delete(callId);
                    const output = sanitizeText(textOfContent(message.content), {
                        ...DEFAULT_REDACTION,
                        maxTextBytes: MAX_TOOL_OUTPUT_BYTES,
                    });
                    const record = {
                        callId,
                        name: pending.name,
                        argumentsText: pending.argumentsText.slice(0, 4_000),
                        args: pending.args,
                        output,
                        isError: message.isError === true,
                        turn: numberOr(data.turn, pending.turn),
                        step: numberOr(data.step, pending.step),
                        at,
                    };
                    state.toolCalls += 1;
                    if (record.isError) {
                        state.failedToolCalls += 1;
                        state.failedToolCalls = Math.max(state.failedToolCalls, 0);
                    }
                    if (state.calls.length < MAX_CALLS_PER_TURN)
                        state.calls.push(record);
                    else
                        state.droppedCalls += 1;
                    this.hooks.onToolResult(state.session, record);
                    break;
                }
                case 'assistant/message': {
                    const message = asRecord(data.message);
                    const source = asRecord(message.source);
                    const usage = data.usage ? toUsageCounts(data.usage) : { ...EMPTY_USAGE };
                    state.usage = addUsage(state.usage, usage);
                    state.modelRequests += 1;
                    const text = textOfContent(message.content);
                    if (text) {
                        state.assistantText = sanitizeText(`${state.assistantText}\n${text}`.trim(), {
                            ...DEFAULT_REDACTION,
                            maxTextBytes: MAX_ASSISTANT_TEXT_BYTES,
                        });
                        this.hooks.onAssistantText(state.session, text, numberOr(data.turn, state.turn), numberOr(data.step, state.step));
                    }
                    const call = {
                        turn: numberOr(data.turn, state.turn),
                        step: numberOr(data.step, state.step),
                        provider: typeof source.provider === 'string' ? source.provider : undefined,
                        model: typeof source.model === 'string' ? source.model : undefined,
                        usage,
                        at,
                    };
                    if (state.modelCalls.length < MAX_CALLS_PER_TURN)
                        state.modelCalls.push(call);
                    this.hooks.onModelCall(state.session, call);
                    break;
                }
                case 'assistant/attempt': {
                    // A settled failed/retried attempt carries no surface message; count
                    // it so "model requests" reflects real work, without inventing usage.
                    state.modelRequests += 1;
                    break;
                }
                case 'turn/end': {
                    this.finish(sessionId, at);
                    break;
                }
                default:
                    break;
            }
        }
        catch {
            // The observer is an optimization layer: it must never disturb the log feed.
        }
    }
    /** Flush any buffered turn for a session that is going away. */
    flush() {
        for (const sessionId of [...this.states.keys()])
            this.finish(sessionId, this.now());
    }
    finish(sessionId, at) {
        const state = this.states.get(sessionId);
        if (!state)
            return;
        const hasData = state.calls.length > 0 || state.modelCalls.length > 0 || state.assistantText !== '';
        if (!hasData && !state.turnStarted)
            return;
        const summary = {
            session: {
                ...state.session,
                usage: state.usage,
                modelRequests: state.modelRequests,
                toolCalls: state.toolCalls,
                failedToolCalls: state.failedToolCalls,
            },
            turn: state.turn,
            startedAt: state.turnStartAt,
            endedAt: new Date(at).toISOString(),
            calls: [...state.calls],
            modelCalls: [...state.modelCalls],
            usage: state.usage,
            failedToolCalls: state.failedToolCalls,
            assistantText: state.assistantText,
            partial: !state.turnStarted,
        };
        state.calls = [];
        state.modelCalls = [];
        state.assistantText = '';
        state.usage = { ...EMPTY_USAGE };
        state.failedToolCalls = 0;
        state.modelRequests = 0;
        state.toolCalls = 0;
        state.turnStarted = false;
        state.turnStartAt = null;
        state.droppedCalls = 0;
        try {
            this.hooks.onTurnEnd(summary);
        }
        catch {
            /* fail-open */
        }
    }
    createState(sessionRecord, at) {
        const sessionId = typeof sessionRecord.id === 'string' ? sessionRecord.id : '';
        if (!sessionId)
            return null;
        const header = asRecord(sessionRecord.header);
        const parent = typeof header.parentSession === 'string' ? header.parentSession : null;
        const depth = numberOr(header.delegationDepth, parent ? 1 : 0);
        const isSubagent = header.origin === 'subagent' || depth > 0;
        const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null;
        const projectRoot = cwd ? findRepoRoot(cwd).root : null;
        const parentState = parent ? this.states.get(parent) : undefined;
        const rootSessionId = parentState?.session.rootSessionId ?? parent ?? sessionId;
        const availableTools = isSubagent ? [] : (this.hooks.availableTools?.() ?? []);
        const session = {
            sessionId,
            rootSessionId,
            parentSessionId: parent,
            delegationDepth: depth,
            isSubagent,
            cwd,
            projectRoot,
            startedAt: new Date(at).toISOString(),
            availableTools,
            usage: { ...EMPTY_USAGE },
            modelRequests: 0,
            toolCalls: 0,
            failedToolCalls: 0,
        };
        const state = {
            session,
            pending: new Map(),
            calls: [],
            modelCalls: [],
            assistantText: '',
            turn: 0,
            step: 0,
            turnStartAt: null,
            turnStarted: false,
            usage: { ...EMPTY_USAGE },
            failedToolCalls: 0,
            modelRequests: 0,
            toolCalls: 0,
            droppedCalls: 0,
        };
        this.states.set(sessionId, state);
        this.order.push(sessionId);
        while (this.order.length > MAX_SESSIONS) {
            const evicted = this.order.shift();
            if (evicted)
                this.states.delete(evicted);
        }
        try {
            this.hooks.onSession(session);
        }
        catch {
            /* fail-open */
        }
        return state;
    }
    /** Test/diagnostics helper: number of tracked live sessions. */
    get trackedSessions() {
        return this.states.size;
    }
    /** Snapshot for diagnostics (no mutable references). */
    describe() {
        return [...this.states.values()].map((state) => ({
            sessionId: state.session.sessionId,
            turn: state.turn,
            calls: state.calls.length,
            subagent: state.session.isSubagent,
        }));
    }
}
function numberOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function parseArguments(text) {
    if (!text.trim())
        return {};
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
    catch {
        return {};
    }
}
