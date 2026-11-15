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
never-used tool was available. This port counts one prompt per completed DSH turn in
`unusedPrompts`, keeps `unusedSessions` for the session floor, and implements the same
predicate in `src/toolprune/policy.ts::enoughEvidence`.

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
(`sessionTasks` in `skills.json`), so repeated turns reuse it, and a confirmation is counted
once per session id even if the same session is folded again.

## Deliberate deviations

1. **No Python runtime.** Upstream is a Python library with provider adapters;
   this plugin runs inside the Harness Node process.
2. **No network or provider SDK.** The judge uses the Harness LLM route, so no
   API key, base URL, or cloud dependency is introduced. Upstream's model
   weights contain no USD prices; this plugin adds an *optional* user-supplied
   price table and otherwise reports cost as unavailable.
3. **Harness-native surfaces.** Micro-skills are injected as durable prompt
   context (not system instructions), tool pruning uses
   `agent.ctx.tools.restrict()`, and the loop guard injects at most one redirect
   with `agent.followup()` — it never stops the agent. The redirect is written
   by the configured model only after a confident *stuck* verdict; every other
   path uses the deterministic count template.
4. **No auto-update.** Upstream is vendored at a fixed revision. See below.
5. **Not ported, by scope.** The following upstream components are deliberately
   absent rather than silently emulated:
   * `microskills`: the paid proposer is not called automatically (its digest,
     extractor and prompts are ported; the caller may pass proposed facts).
     `envfacts` is LLM-free; `distiller` renders confirmed/manual facts and
     builds the proposer prompt, so it does not invent facts without a caller;
   * `toolprune`: the per-task LLM tool judge, Codex capability controller,
     explicit `refresh-catalog`/`measure`/`apply-pending` actions, and glob
     protection patterns; this port uses evidence pruning plus exact-name
     protection and DSH-native `tools.restrict()`. Evidence is counted once per
     session, the hidden set is persisted in `tools.json`, an explicit restore
     is durable per project, and a periodic re-audit reloads the full catalog
     for one turn. Orchestration/optional tools are prunable; the work surface
     and human-control tools stay protected;
   * `loopguard`: the `stop` mode and per-threshold pinning; the envelope IS
     persisted per project in `loopguard.json` and restored before the first
     decision (unlike an earlier version of this port, which rebuilt it per
     process);
   * plugin product surface: repository maps, history import, `repos`, `doctor`,
     `probe`, and `fold` commands, and non-DSH agent adapters.
   This is a DSH plugin for the three mechanisms, not a line-for-line port of
   the upstream multi-agent product.

## Parity tests

`tests/parity/` contains generators that run the pinned upstream Python modules
and write JSON vectors, plus Node tests that assert the TypeScript port agrees.
They are skipped cleanly when Python or the vectors are absent, so the default
test suite never requires Python. To regenerate:

```bash
python3 tests/parity/generate_microskills_vectors.py
python3 tests/parity/generate_loopguard_vectors.py
python3 tests/parity/generate_pricing_vectors.py
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
