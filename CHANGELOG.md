# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use SemVer.

## [Unreleased]

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
- **The loop guard decides during the tool result, not after the turn.** A
  confirmed loop redirect is queued with the public `agent.followup()` and
  recorded as `followup-degraded`; it arrives after the current turn.
  `agent.steer` is not used, so upstream's in-turn redirect is not
  achieved. A redirect whose verdict does not arrive is reported as
  `still-stuck` at turn end; at most one redirect is delivered per turn.
  Subagents are never judged or redirected.
- **Default micro-skill limits are more conservative.** `microskillsMinConfirmations=3`,
  `microskillsMaxFacts=4`, `microskillsMaxTokens=150`, `microskillsRetireDays=0`
  and `toolpruneReauditEvery=0`.
- **One finished session is one task.** The adapter suppresses a second
  confirmation of the same key in one finished session, and the task index
  follows the session, so repeated turns cannot promote a fact on their own or
  shift recency decay. The ported lifecycle has no session concept.
- **The knowledge block is frozen per session.** When DSH re-evaluates
  `systemPrompt.context.text(assembly)` on every request, the first lookup is
  reused, including an empty block and even before the project runtime is
  warm; a new session sees newer facts.
- **Only human-initiated turns count as tool-pruning prompts.** Scheduled
  deliveries, goal continuation rounds, injected context, and the loop guard's
  own followup redirect no longer advance `unusedPrompts`; subagents are
  already skipped. Rows written before the counter existed migrate from their
  unused-session count, so existing evidence is preserved.
- **Subagents are not loop-guarded.** `beginTurn`, `onToolResult` and
  `finishTurn` skip subagent sessions; the status view reports
  `loopguardIntervene=false` as "observing only" instead of implying redirects.
- **`toolpruneAllowlist` accepts glob patterns.** Exact names remain exact;
  `*`, `**` and `?` allow upstream-style protection such as `mcp__*`.

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
