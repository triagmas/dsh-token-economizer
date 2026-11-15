# Architecture

`dsh-token-economizer` is a DeepSeek Harness (DSH) plugin that reduces tokens the
model actually consumes and measures what happened. It is one independent
Cordis bundle: a Host half (`lib/`, Node) and a WebUI half (`client/` plus
`locale/`). There is no separate server, no MCP transport, no cloud service, and
no modification of the Harness installation.

## Layers

```
┌───────────────────────────────────────────────────────────────────────┐
│ 4. Management UI            /economizer command · DSH Settings section │
├───────────────────────────────────────────────────────────────────────┤
│ 3. Persistence & metrics    <DSH_HOME>/token-economizer/**             │
├───────────────────────────────────────────────────────────────────────┤
│ 2. Economizer engines       micro-skills · tool pruning · loop guard   │
│                             (TypeScript ports of Microsoft algorithms) │
├───────────────────────────────────────────────────────────────────────┤
│ 1. DSH adapter              session/event fold · agent lifecycle ·    │
│                             tool registry · prompt context · LLM judge │
└───────────────────────────────────────────────────────────────────────┘
```

### 1. DSH adapter (`src/dsh/`)

| Module | Responsibility |
| --- | --- |
| `session-observer.ts` | Bounded, exception-safe fold over `session/event`. Pairs `tool/call` with `tool/result`, accumulates provider `usage` from `assistant/message`, resolves subagent lineage and workspace root, and emits one `TurnSummary` per finished turn. |
| `tools.ts` | Reads the visible tool catalog (`tools.definitions()`) with model-facing token estimates and applies a deny set through `agent.ctx.tools.restrict({ deny })`. |
| `prompt.ts` | Registers the learned-knowledge contribution as a *prompt context* (durable user-role snapshot), never as system policy. The text callback may run per request, so the rendered block is frozen per session. |
| `judge.ts` | Optional one-shot model call over `ctx.llm.stream()` with hard timeout, output cap, recursion guard, and usage accounting. |
| `version.ts` | Reads `$DSH_INSTALL_DIR/package.json` and gates on the tested DSH range. |

The adapter never writes to the session log, never edits Harness files, and
never blocks agent execution: every callback is bounded and fail-open.

### 2. Engines (`src/microskills/`, `src/toolprune/`, `src/loopguard/`)

Direct TypeScript ports of the deterministic parts of
[Microsoft TokenEconomizer](https://github.com/microsoft/TokenEconomizer). No
Python runtime is required; the upstream repository is vendored under
`.upstream/` for attribution and optional parity tests (see `UPSTREAM.md`).

* **Micro-skills** — turn a finished task into zero or more *project facts*:
  failing command → corrected command, resolved errors, environment facts, test
  and build commands. Candidates need independent confirmations, are
  deduplicated and superseded, capped by count and tokens, isolated per
  project, and redacted before storage.
* **Tool pruning** — per-project, per-tool usage statistics (available, called,
  errored), with availability counted once per session and prompt evidence once
  per human-initiated turn, plus the upstream protected work surface and
  explicit allowlists/restores. Modes: `observe` (statistics only),
  `propose` (report candidates), `automatic` (deny eligible tools). Every hidden
  tool is one `restrict()` call; a restore is durable in the project row and can
  be made from the UI or `/economizer tools restore`. Orchestration/optional
  execution tools are eligible; the file/shell/analysis surface, human controls,
  `skill` and `web_*` are not (the last two are a documented deviation).
  `toolpruneAllowlist` matches exact names or `*`/`**`/`?` patterns. A new
  automatic hide is held while the repository is active and applies in a later
  quiet session (default 60 minutes), or after 24 hours, so a live session keeps
  its cache and tool surface.
* **Loop guard** — repeated-failure and stagnation detection using upstream
  thresholds. Edits through Bash (`sed -i`, redirects, inline Python, patches)
  count as edits, so an agent that never calls an edit tool is not scored as
  untouched. At most one redirect per turn, delivered with `agent.steer` inside the
  current turn (one macrotask after the tool result; `agent.followup` is the fallback
  when steer is absent or rejects). Delivery is recorded only after the call returns:
  `steer`, `followup-degraded`, or `failed`. The guard decision is in-turn; the nudge is
  queued for the next model step, not injected into the running one. A judge confidence floor of `0.7`, no
  self-stop, no recursive judging, no judging of subagents, session/turn token
  budgets, fail-open. A confident *stuck* verdict lets the model write the
  redirect; every fallback uses the deterministic template.

### 3. Persistence (`src/storage/`, `src/core/`)

Everything lives under `<DSH_HOME>/token-economizer/` (never in the project
working tree, never in the DSH installation):

```
install.json                        schema version + install metadata
errors.log                          redacted diagnostics only
projects/<projectId>/project.json   canonical root, git flag, timestamps
projects/<projectId>/skills.json    fact lifecycle state
projects/<projectId>/tools.json     per-tool counters, hidden set, restores
projects/<projectId>/metrics.jsonl  per-turn usage/tool rows (rotated)
projects/<projectId>/loops.jsonl    loop incidents (rotated)
```

`projectId` is a slug plus a short SHA-256 of the canonical workspace root, so
two checkouts with the same directory name never share knowledge. Writes are
atomic (temp file + rename), JSONL files rotate at a configurable byte cap, and
every business file carries `schemaVersion`. A newer schema fails closed for
that mechanism instead of deleting or guessing at user data.

### 4. Management UI

* `/economizer` command: `status`, `on`, `off`, `mode`, `report`, `skills`,
  `tools`, `loops`, `config`.
* DSH Settings section (`settings.section`, id `token-economizer`) with five
  tabs: Overview, Micro-skills, Tools, Loop guard, Settings; English and
  Russian through the Client locale service.
* Host HTTP routes under `/api/token-economizer` on the authenticated DSH
  Connection channel (`no-store`, owner-only, bounded bodies). The browser
  passes a session id and, at most, a workspace path hint that is matched
  against known project roots.

## Modes and gating

| Mode | Observation | Facts stored | Prompt injection | Tool denial | Judge calls |
| --- | --- | --- | --- | --- | --- |
| `off` | no | no | no | no | no |
| `shadow` | yes | yes | no | no | no |
| `active` | yes | yes | only if `microskillsInject` | only if `toolpruneMode=automatic` | only if `loopguardIntervene` and budgets allow |

`shadow` is the default. Every mutating mechanism has its own switch, so
`active` never silently applies a mechanism the user did not enable. The judge
is never called in shadow mode.

## Turn lifecycle

1. `turn/start` resets the per-turn guard state and starts a metrics buffer.
2. `tool/call` / `tool/result` produce a `ToolCallRecord` (redacted, bounded) and
   feed both the pruning counters and the loop guard.
3. `assistant/message` adds provider usage. Effective tokens and cost are
   derived, not invented.
4. `turn/end` (or session disposal) finalizes: micro-skills extraction and the
   engine-rendered block, statistics update, one metrics row set, optional loop
   incident record, and the persisted loop-guard envelope.
5. Any judge call runs asynchronously with a timeout; its usage is counted as
   Token Economizer overhead. On timeout/error the guard does nothing.

## Failure model

The economizer is an optimization, never a dependency:

* every event callback is wrapped; a throw is logged, not propagated;
* the judge is optional and fail-open;
* persistence errors disable the affected mechanism and appear in the UI;
* unknown DSH versions are reported, not assumed;
* uninstall/disable leaves the Harness fully functional; data stays only under
  `DSH_HOME/token-economizer/` and can be deleted by the user.

## Measurement honesty

* Raw input/output/cache counts are provider-reported. When a provider omits
  usage, the row says so; numbers are never fabricated.
* "Effective tokens" applies the cache-aware weights from upstream
  `pricing.py` and is shown only when the model id is known.
* USD cost requires an explicit `priceTable` entry. Without it the UI shows
  "cost unavailable" and lists the unpriced models.
* Savings are always labelled estimates: hidden tool-definition tokens per
  request and injected-fact tokens per request are computed from the actual
  text, not from an assumed percentage.
* Subagent usage is attributed to the root session once. Sessions whose events
  the plugin never observed are reported as unattributed.

## Distribution and the bundle patch

`package.json#dsh.bundle.patch` points at `cordis.patch.yml`. DSH applies that
file when the package is installed into a profile: the `insert` list adds one
host plugin entry, `token-economizer`, with an empty config object. This is a
bundle manifest, not a code patch — it edits the profile's plugin table through
the supported installer, never the Harness checkout or another plugin. The
plugin's own defaults then apply; user settings are stored in the profile's
config, not in the YAML. Uninstall removes the inserted entry, so the change is
reversible.

`lib/` is the compiled host half (`tsc`); `client/index.js` is plain JavaScript
loaded by the Harness module loader and has no separate build. Because both are
committed for no-build installs, `npm run check:dist` compiles `src/` into a
temporary directory and compares every emitted `.js` with `lib/`, then
syntax-checks the client and verifies the two package pointers above.
