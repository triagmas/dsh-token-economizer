# Upstream attribution and parity

The deterministic algorithms in this plugin are ports of
**Microsoft TokenEconomizer**.

* Repository: <https://github.com/microsoft/TokenEconomizer>
* Vendored revision: `7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0`
* License: Apache License 2.0 (see `LICENSE` and `NOTICE`)
* Upstream location in this workspace (not shipped): `.upstream/TokenEconomizer`

No upstream code is executed at runtime. The Harness plugin is pure
TypeScript/JavaScript and requires only Node.js. Python is needed exclusively
for the optional parity tests in `tests/parity/`, which compare this port with
the pinned upstream Python modules.

## File mapping

| Upstream (Python) | This plugin (TypeScript) | Notes |
| --- | --- | --- |
| `tokeneconomizer/microskills/observe.py` | `src/microskills/observe.ts` | Vocabulary, error classes, network/form error sets |
| `tokeneconomizer/microskills/envfacts.py` | `src/microskills/envfacts.ts` | Env-fact folding, lint, distiller caps |
| `tokeneconomizer/microskills/lifecycle.py` | `src/microskills/lifecycle.ts` | Score floor, promotion, hard kill, fire gate |
| `tokeneconomizer/microskills/distiller.py` | `src/microskills/distiller.ts` | Digest, detector, extractor, proposer system prompt |
| `tokeneconomizer/toolprune/tools.py` | `src/toolprune/policy.ts` | Protected/inapplicable sets, eligibility |
| `tokeneconomizer/toolprune/stage.py` | `src/toolprune/index.ts` | Stage behaviour and audit cadence |
| `tokeneconomizer/loopguard/rules.py` | `src/loopguard/rules.ts` | Thresholds, spiral levels, gates, nudge text |
| `tokeneconomizer/loopguard/state.py` | `src/loopguard/state.ts` | Spiral state machine |
| `tokeneconomizer/loopguard/turn.py` | `src/loopguard/turn.ts` | Turn guard, runner verdict, status regexes |
| `tokeneconomizer/loopguard/judge.py` | `src/loopguard/judge.ts` | Judge and nudge-writer prompts |
| `tokeneconomizer/loopguard/shell_edits.py` | `src/loopguard/shell-edits.ts` | Edits made through Bash (`sed -i`, redirects, inline Python, patches) |
| `tokeneconomizer/loopguard/envelope.py` | `src/loopguard/envelope.ts` | Envelope/cost tracker |
| `tokeneconomizer/pricing.py` | `src/pricing/weights.ts` | Cache-aware model weights (no USD prices upstream) |

## Tool-pruning evidence and high-risk tools

The plugin-layer original (`tokeneconomizer/plugin/fold.py::enough_evidence`) decides
`(sessions >= toolprune_min_sessions and prompts >= toolprune_evidence) or sessions >=
toolprune_sessions`. `prompt_streaks` counts the prompts of every session in which a
never-used tool was available. This port counts one prompt per completed
**user-initiated** DSH turn in `unusedPrompts`, keeps `unusedSessions` for the session
floor, and implements the same predicate in `src/toolprune/policy.ts::enoughEvidence`.

A turn is user-initiated only when it carries a `user/message` whose `source.kind` is
`user` and which is not this plugin's own loop-guard redirect (marked with
`source.generatedBy = "token-economizer-redirect"`). Scheduled deliveries
(`source.kind = "schedule"`), goal continuation rounds (`"goal"`), runtime/context
injections, and other synthetic user-role messages do not advance `unusedPrompts`.
Subagent turns are skipped regardless (and workflow `agent()` children are subagents);
a workflow tool call itself runs inside the caller's user turn and adds no prompt of its
own. Rows migrated from releases without `unusedPrompts` inherit their
`unusedSessions` count, matching upstream's `prompt_streaks or streaks` migration;
after that the explicit counter is authoritative, so an autonomous-only session cannot
become prompt evidence.

The original multiplies both thresholds by `live_adapter.HIGH_RISK_FACTOR` for a
host-declared high-risk capability class. DSH has no equivalent capability manifest, so
the multiplier is **not ported**: every tool is evaluated as normal-risk. This is
conservative for hiding (a high-risk tool needs more evidence upstream, so this port may
hide it earlier), but it cannot remove the work surface, controls, or a tool that was ever
called. Recorded here as a deliberate gap, not an equivalence.

## Task means finished session

Upstream folds one finished *session* as one task. This port used to advance the task index
on every turn and to count every turn as a new confirmation. That let two turns of one
session promote a fact and shifted recency decay. The index now belongs to the session
(`sessionTasks` in `skills.json`), so repeated turns reuse it. The adapter suppresses a
second confirmation of the same key for that task; the ported `Lifecycle` itself has no
session concept, matching upstream.

## Deliberate deviations

1. **No Python runtime.** Upstream is a Python library with provider adapters;
   this plugin runs inside the Harness Node process.
2. **No network or provider SDK.** The judge uses the Harness LLM route, so no
   API key, base URL, or cloud dependency is introduced. Upstream's model
   weights contain no USD prices; this plugin adds an *optional* user-supplied
   price table and otherwise reports cost as unavailable.
3. **Harness-native surfaces.** Micro-skills are injected as durable prompt
   context (not system instructions); tool pruning uses
   `agent.ctx.tools.restrict()`. The loop guard decides inside `onToolResult`
   but delivers at most one redirect per turn through the public
   `agent.steer(message)`, recorded as `steer`. DSH schedules a steer for the
   next model step; in the live `0.2.2-rc.3` run the redirect `user/message`
   appeared before `turn/end` (after the model's last step, so consumption can
   slip to the next step). This is closer to upstream's in-turn nudge but is
   still a queued message, not an injection into the running model call. If
   `steer` is unavailable or throws, the adapter falls back to
   `agent.followup(message)`, recorded as `followup-degraded` and delivered
   after the turn. `agent.inject()` is not used. DSH rejects either call while
   the tool-result append is still being published, so the adapter queues it one
   macrotask later; the `steer`/`followup-degraded`/`failed` result is recorded
   only after the real call returns, and every rejection is logged, never
   thrown. The redirect never stops the agent. It is written by the configured
   model only after a confident *stuck* verdict and only when both
   `loopguardIntervene` and `loopguardJudge` are on; every other path uses the
   deterministic count template. Subagents are never judged or redirected.
   DSH may evaluate the prompt context text for every model request; once the
   project runtime is warm, the plugin freezes the rendered block at the
   session's first lookup (including a genuinely empty block), as upstream
   renders per session. A lookup that races the asynchronous warm-up is not
   cached: it returns empty for that assembly and lets a later assembly see the
   project block, instead of pinning the session to a false empty prompt.
4. **No auto-update.** Upstream is vendored at a fixed revision. See below.
5. **Explicit opt-in gates (operator-safety deviation).** The plugin starts in
   SHADOW and never applies a mechanism merely because `mode` is ACTIVE: each
   of `microskillsInject`, `toolpruneMode=automatic`, and
   `loopguardIntervene` must be enabled separately. Upstream's library
   mechanisms can be invoked directly by their caller; this port adds the
   gates so a mis-set mode cannot rewrite a prompt, hide tools, or insert a
   redirect without a second deliberate switch. This is not an upstream
   equivalence and is recorded here as a deviation.
6. **Not ported, by scope.** The following upstream components are deliberately
   absent rather than silently emulated:
   * `microskills`: the paid proposer is not called automatically (its digest,
     extractor and prompts are ported; the caller may pass proposed facts).
     `envfacts` is LLM-free; `distiller` renders confirmed/manual facts and
     builds the proposer prompt, so it does not invent facts without a caller;
   * `toolprune`: the per-task LLM tool judge, Codex capability controller,
     explicit `refresh-catalog`/`measure`/`apply-pending` actions; this port
     uses evidence pruning, name/glob protection (`toolpruneAllowlist` accepts
     `*`, `**` and `?`) and DSH-native `tools.restrict()`. Prompt evidence is
     the upstream `fold.py::enough_evidence` predicate: `unusedPrompts` advances
     once per completed **human-initiated turn** (scheduled, goal, injected and
     loop-guard-redirect messages do not count), while `unusedSessions` supplies
     the session floor; a tool is eligible when
     `(unusedSessions >= toolpruneMinSessions and unusedPrompts >=
     toolpruneEvidence) or unusedSessions >= toolpruneSessions`. The hidden set
     is persisted in `tools.json` and an explicit restore is durable per
     project. Periodic full-catalog re-audit exists but is **off by default**
     (`toolpruneReauditEvery=0`); setting it to N reloads the full catalog for
     one task every N audit tasks instead of pruning. Orchestration/optional
     execution tools are prunable; the work surface and human-control tools stay
     protected. **Deviation:** this port also protects `skill` and the `web_*`
     family even though upstream's class-based policy would prune them, because
     losing skill loading or network access is a capability regression rather
     than schema savings;
   * `loopguard`: the `stop` mode and per-threshold pinning; the envelope IS
     persisted per project in `loopguard.json` and restored before the first
     decision (unlike an earlier version of this port, which rebuilt it per
     process);
   * plugin product surface: repository maps, history import, `repos`, `doctor`,
     `probe`, and `fold` commands, and non-DSH agent adapters.
   This is a DSH plugin for the three mechanisms, not a line-for-line port of
   the upstream multi-agent product.

## Upstream changes after the pinned revision

The vendored checkout was fetched on 2026-11-16. `origin/main` had advanced from
the pinned `7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0` to
`583fff78bf504b59d542f953c31e87d01d02ab42` (plus merge commits listed by
`git log 7042ea8..origin/main`). **The pin did not move:** the parity vectors and
the file headers still describe `7042ea8`, and everything below is an explicit
post-pin review, not an upstream-equivalence claim.

| Upstream change | Behavioural? | Ported logic affected? | Decision |
| --- | --- | --- | --- |
| `microskills/distiller.py`: `parse_payload` type guards (`#198`) | Yes, malformed proposer JSON can no longer reach the regex compiler | Yes, `src/microskills/distiller.ts::parsePayload` | **Ported.** Strings are required for `name`, `pattern`, `id` and the four detector fields; `detector` must be a non-empty object and `cite` a list or absent. Unit test added; parity vectors remain pinned. |
| `microskills/distiller.py`: `_rx` rejects a non-string pattern (`#198`) | Yes, avoids a Python `TypeError` | Indirectly, the port's `compilePattern` is the equivalent | Not ported as a separate change. `parsePayload` now rejects non-string fields before they reach the compiler; malformed values already persisted in an older state file remain outside this scoped fix. |
| `microskills/distiller.py`: `load_calls` skips non-object JSON lines and requires a string tool-use id | Yes, hardening against a corrupt transcript | Yes, the port's transcript loader reads the same shape | Not ported; the port does not read agent transcripts (the DSH observer supplies calls), so there is no equivalent loader to harden. B3 was scoped to `parse_payload`. |
| `microskills/distiller.py`, `envfacts.py`, `lifecycle.py`, `stage.py`, `__init__.py`: manual forgetting (`#160`) and atomic mechanism writes | Yes, new user-facing feature plus durability | No shipped equivalent; this port has no `forget`/`unforget` command or forgotten-id admission rule | Not ported. Adding it would be a feature port, not a bug fix; recorded here and in `CHANGELOG.md`. |
| `microskills/distiller.py`, `envfacts.py`: `write_json_atomic` for mechanism state | Yes on Windows, avoids a half-written document | The port already writes its state through atomic helpers | Not ported; covered by the port's own storage layer. |
| `loopguard/shell_edits.py`: wrapper options (`sudo -u`, `env -u`, `timeout 60`, `nice -n`, ...) | Yes, fewer false shell-edit detections | Yes, `src/loopguard/shell-edits.ts` | Not ported; outside the B3 scope and needs its own loopguard parity vectors. |
| `loopguard/state.py`: multi-file patch `paths` are all counted | Yes, spiral edit tracking sees every patched file | Yes, `src/loopguard/state.ts` | Not ported; same reason. |
| `loopguard/turn.py`: Python interpreter flags before `-m pytest` / `runtests.py` | Yes, verification detection recognises more invocations | Yes, `src/loopguard/turn.ts` | Not ported; same reason. |
| `plugin/config.py`: `local_model`, `local_roles`, `local_judge_confidence` | Yes, new opt-in on-device judge/proposer route | No; DSH uses `ctx.llm.stream()` and has no local Apple FM route | Not ported. New configuration without a DSH capability is dead surface. |
| `plugin/controller.py`: launcher retry on `SessionStart`/`UserPromptSubmit`; local judge may run while the host CLI is paused | Yes, host-specific lifecycle/local-model behaviour | No; the DSH adapter has no launcher or CLI-session pause | Not ported. |
| `plugin/fold.py`: local proposer runner; `te microskills forget` command | Yes, host-specific proposer routing and a new CLI command | No shipped equivalent | Not ported; same feature-scope reason as `#160`. |
| `pricing.py`: new Gemini model rows | Yes for those model ids | The port has its own frozen pricing table | Not ported. Pricing is intentionally frozen in this review; new rows need their own source check and vectors. |
| `microskills/README.md`, `microskills/__init__.py` | No runtime behaviour | No | Documentation/export changes only. |

The upstream repository also added non-target files (Antigravity, CI, docs) in the
same range; they are outside the requested diff scope and are not analysed here.

## Parity tests

`tests/parity/` contains generators that run the pinned upstream Python modules
and write JSON vectors, plus Node tests that assert the TypeScript port agrees.
They are skipped cleanly when Python or the vectors are absent, so the default
test suite never requires Python. To regenerate:

```bash
python3 tests/parity/generate_microskills_vectors.py
python3 tests/parity/generate_loopguard_vectors.py
python3 tests/parity/generate_pricing_vectors.py
python3 tests/parity/generate_toolprune_vectors.py
node --test tests/parity/*.test.mjs
```

## Updating the vendored revision (manual, no automation)

This plugin does not auto-update itself or upstream. To move to a newer
upstream commit:

1. `git -C .upstream/TokenEconomizer fetch && git -C .upstream/TokenEconomizer checkout <sha>`
2. Re-read the changed upstream modules and port the behavioural delta.
3. Regenerate parity vectors and run the full test suite.
4. Update the pinned SHA in this file, `NOTICE`, and the header comments of the
   ported modules.
5. Record the change in `CHANGELOG.md`.

## Trademark and endorsement

This is an independent port, not published by or endorsed by Microsoft.
"Microsoft TokenEconomizer" refers to the upstream project. Apache-2.0
attribution is preserved in `LICENSE` and `NOTICE`.
