# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use SemVer.

## [0.1.1] - 2026-11-16

### Fixed

- **Multibyte redaction is capped in one pass.** `capToBytes` now slices and
  backs up to a UTF-8 boundary instead of rescanning every prefix, so a large
  non-ASCII payload stays linear; the test asserts a bounded number of
  `Buffer.byteLength` calls and no replacement character.
- **Finished turns serialize both state files.** `finishTurn` now runs tool
  statistics and micro-skill lifecycle inside `ProjectStore.updateTools` and
  `updateSkills`. A cached read can no longer overwrite counters or facts
  written by another DSH process; regression tests force a stale cache and
  keep both values.
- **Inherited configuration keys are rejected.** `updateSettings` uses
  `Object.hasOwn` for both tables, so `constructor`, `toString` and
  `__proto__` fail as unknown keys. Numeric bounds in `resolveConfig` come from
  `CONFIG_FIELD_RULES`; a test keeps the rule table, schemastery schema and
  defaults in lockstep.

## [Unreleased]

### Fixed

- **A live lock owner is never evicted.** `isStale` checks the owning PID before
  the lock age, and a release token prevents a former owner from unlinking a
  successor's lock. Stale reclamation now runs through a short-lived guard;
  the guard is published by hard link with its complete owner record, and a
  dead guard is recovered by renaming and verifying the inode before removal,
  so recovery never unlinks a replacement guard. An empty or partial lock is
  reclaimed only after `stat.mtime` exceeds the 15-second stale threshold.
  Regression tests cover a 16-second live hold, a fresh empty lock, a fresh
  empty guard, a dead guard, an old empty guard, dead-guard contention,
  old-empty-guard contention, and 100 stale-lock contenders across five rounds.

### Upstream drift after the pinned revision

- Audited `7042ea8..583fff7` in the vendored checkout without moving the pin.
  The only change ported from that range is the `parse_payload` type-guard fix
  (upstream PR #198): non-string extractor/detector fields, a non-object
  detector, and a non-list `cite` are now rejected instead of reaching the
  regex compiler. The port's `compilePattern` remains the equivalent runtime
  guard, and a unit test covers the malformed shapes.
- Deliberately not ported from the same range: manual micro-skill
  forget/unforget (PR #160), atomic mechanism writes, transcript-loader type
  guards, shell-wrapper/multi-path patch/Python-flag loopguard changes,
  local-model (`fm`) routing, and new pricing rows. Reasons and per-file
  classification are in `docs/UPSTREAM.md`; the pin and parity vectors still
  describe `7042ea8`.

Fidelity fixes against Microsoft TokenEconomizer, pinned commit
`7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0`.

### Fixed

- **Tool-pruning evidence matches upstream `fold.py::enough_evidence`.** A
  never-used tool now needs either `toolpruneEvidence` prompts across at least
  `toolpruneMinSessions` sessions or `toolpruneSessions` sessions without prompt
  evidence. New defaults are `toolpruneEvidence=10`, `toolpruneMinSessions=2`
  and `toolpruneSessions=5`; the old default of three sessions alone hid tools
  too early.
- **New automatic hides wait for a quiet session.** `toolpruneQuietMinutes=60`
  holds a freshly computed deny set while the repository is active and applies
  it in a later session, or after 24 hours. A running session no longer changes
  its tool surface mid-turn; a manual restore or a mode change still applies
  immediately.
- **The loop guard steers the redirect inside the current turn.** A confirmed
  redirect is delivered with the public `agent.steer()` one macrotask after the
  tool result. Live DSH `0.2.2-rc.3` accepted it and emitted the redirect
  `user/message` before `turn/end`; if steer is unavailable or throws, the
  adapter falls back to `agent.followup()`, which arrives after the turn. The
  incident records `steer` or `followup-degraded` only after the real call
  returns, and a refusal is `failed` and is not counted. A redirect whose
  verdict does not arrive is reported as `still-stuck` at turn end; at most one
  redirect is delivered per turn. Subagents are never judged or redirected.
- **A non-zero bash exit is a failed tool call even when `message.isError` is
  false.** DSH appends `[exit code: N]` and keeps `isError: false` for an
  ordinary failing command; the observer now parses that marker so the loop
  guard sees the failure instead of a successful empty result.
- **`dispose()` drains queued turn finalizers before clearing guards.** A short
  headless run used to lose the learned envelope (and any delivered incident)
  because the turn end and dispose raced; the guard state is now flushed first.
- **The prompt survives either `turn/start` order in the live DSH log.** DSH
  can emit `turn/start` before `user/message`; clearing `turnUserInitiated` at
  `turn/start` dropped the prompt evidence. It is now reset only by `finish()`,
  so both observed orders count the human-initiated turn and `unusedPrompts`
  advances. Three live sessions produced `unusedPrompts: 3`.
- **Default micro-skill limits are more conservative.** `microskillsMinConfirmations=3`,
  `microskillsMaxFacts=4`, `microskillsMaxTokens=150`, `microskillsRetireDays=0`
  and `toolpruneReauditEvery=0`.
- **One finished session is one task.** The adapter suppresses a second
  confirmation of the same key in one finished session, and the task index
  follows the session, so repeated turns cannot promote a fact on their own or
  shift recency decay. The ported lifecycle has no session concept.
- **The knowledge block is frozen per session once the project is warm.** When
  DSH re-evaluates `systemPrompt.context.text(assembly)` on every request, the
  first lookup after warm-up is reused, including a genuinely empty block; a
  new session sees newer facts. A lookup that races the asynchronous warm-up
  is **not** cached (it starts `warmProject` and returns empty for that
  assembly), so the session is no longer pinned to a false empty block. The
  per-session cache is dropped on `agent/disposed`.
- **Only human-initiated turns count as tool-pruning prompts.** Scheduled
  deliveries, goal continuation rounds, injected context, and the loop guard's
  own redirect no longer advances `unusedPrompts`; subagents are
  already skipped. Rows written before the counter existed migrate from their
  unused-session count, so existing evidence is preserved.
- **Subagents are not loop-guarded.** `beginTurn`, `onToolResult` and
  `finishTurn` skip subagent sessions; the status view reports
  `loopguardIntervene=false` as "observing only" instead of implying redirects.
- **`toolpruneAllowlist` accepts glob patterns.** Exact names remain exact;
  `*`, `**` and `?` allow upstream-style protection such as `mcp__*`.
- **`skill` and `web_*` are never auto-hidden.** They were previously in the
  prunable optional-tool class, so a quiet project could lose skill loading or
  network access. They are now protected by name/prefix. This is a deliberate
  deviation from upstream's optional-tool policy; the existing deny set is
  slightly smaller, and the reason is recorded in `docs/UPSTREAM.md`.

### Added

- **Pinned evidence parity.** `tests/parity/generate_toolprune_vectors.py`
  generates 1105 vectors from upstream
  `tokeneconomizer/plugin/fold.py::enough_evidence`; the Node parity suite
  replays every pair. Vectors are committed, so running the Node suite needs no
  Python.
- **`npm run check:dist`.** Compiles `src/` into a temporary directory, compares
  every `.js` file with the committed `lib/`, and syntax-checks the source-only
  `client/index.js` plus the bundle manifest.
- **Fidelity regression tests T-a…T-g** covering loop-guard decisions, quiet
  pending hides, prompt evidence, one-session-one-task, frozen knowledge, and
  subagent/intervention status.
