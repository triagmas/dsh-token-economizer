# Independent review brief

This file exists so an external reviewer and the maintainer judge the same thing.
The owner's goal is **a faithful port of Microsoft TokenEconomizer into a DSH
plugin**, not a general redesign of the plugin or a new product.

## What is being reviewed

* Upstream: <https://github.com/microsoft/TokenEconomizer>
* Pinned revision: `7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0`
* License: Apache-2.0. The vendored checkout under `.upstream/` is intentionally
  not published; the reviewer can fetch the pinned commit directly.
* This repository: an independent TypeScript/JavaScript DSH plugin. It does not
  fork DSH, patch installed packages, run an external service, or require Python
  outside the optional parity tests.

## Owner constraints

These are acceptance constraints, not preferences:

1. No DSH fork and no edits to DSH core, system files, or installed sources.
2. Install through the normal DSH plugin manager; public DSH APIs only.
3. CLI, Web UI, and headless use must keep working.
4. No MCP, no external server, no cloud, no paid infrastructure by default.
5. No CI is required for this repository.
6. Fail-open behavior and complete disable/uninstall safety are mandatory.
7. SHADOW must remain measurement-only; ACTIVE applies only explicitly enabled
   mechanisms.
8. Fidelity to the pinned upstream implementation outranks code-style
   preferences and feature ideas. The upstream research is treated as
   authoritative.

## Current fidelity at v0.1.0

Ported and covered by tests:

* deterministic micro-skills lifecycle, env-facts, redaction, profile rendering,
  injection block and retirement;
* evidence-based tool pruning, protected work/safety surface, persistence,
  durable restore, periodic re-audit;
* loop-guard rules, spiral detection, shell-edit detection, judge prompts,
  bounded redirect, confidence gate, persisted envelope;
* local pricing/metrics views and the DSH-native adapter/UI.

Deliberately not ported, or still incomplete:

* automatic paid micro-skills proposer (prompts and parsing exist, no model call);
* LLM tool-pruning judge and glob protection patterns;
* loop-guard `stop` mode and a separate notice channel (DSH exposes
  `followup`/`steer`, not an upstream-style notice API);
* per-threshold pinning;
* upstream product surface: repository map, history import, `repos`, `doctor`,
  `probe`, `fold`, Codex capability controller, provider adapters.

Known maintainer gaps before calling this a complete parity release:

* `restore` is a durable per-project allowlist, but the UI has no inverse
  "enable automatic pruning again" action yet;
* the live Web UI has not been re-verified after the last host reinstall (unit,
  route, client and smoke tests passed);
* the paid proposer and LLM tool judge are intentionally opt-in gaps, not hidden
  behavior.

## How to review

1. Compare behavior with the pinned upstream file named in
   `docs/UPSTREAM.md`, and cite that file and revision in every finding.
2. Classify each finding as one of:
   * **fidelity bug** — differs from upstream behavior;
   * **integration bug** — breaks DSH, persistence, safety, or a documented
     constraint;
   * **scope request** — a feature upstream has but this port deliberately does
     not;
   * **style preference**.
3. Do not propose replacing deterministic upstream algorithms with an LLM call
   by default. That is a paid, opt-in design decision, not a silent fix.
4. Do not propose changes that violate the owner constraints above, even if
   they would make the code cleaner.
5. For each finding, state the expected upstream behavior, the observed
   behavior, and the smallest repair that preserves the port.
6. Run the checks in `README.md` and `docs/COMPATIBILITY.md`. A finding that
   cannot be reproduced with a command or a test should be marked as such.

## Verification commands

```bash
npm run build
npm test
node --test tests/parity/*.test.mjs
node tests/smoke.mjs
npm run benchmark
```

Parity tests are skipped cleanly when Python or the generated vectors are
absent; that is expected for a Node-only checkout.

## What this review is not

It is not a request to turn this into a multi-agent product, a hosted service, a
marketplace listing, or a general refactor. The three mechanisms and their DSH
integration are the scope.
