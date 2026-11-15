# Benchmark

The benchmark is **deterministic, offline and free**: it exercises the shipped
TypeScript implementations with synthetic inputs and writes machine-readable results to
`benchmark/out/results.json` (plus a Markdown table in `benchmark/out/results.md`).

```bash
npm run build
npm run benchmark
```

It does not call a model and does not depend on provider pricing. Two kinds of numbers
are reported and kept separate:

1. **Measured** — sizes computed from the shipped renderers (tool-schema token estimates,
   the actual injected block, judge call counts, redirect decisions).
2. **Assumptions** — stated constants used only to express the scale of a saving
   (tokens a rediscovery or a stuck turn would cost). They are not model output and are
   not presented as a measured percentage.

## Assumptions

| Constant | Value | Why |
| --- | --- | --- |
| Tokens per byte | 1/4 | The same estimate the plugin uses for schema sizes |
| Rediscovery cost per fact | 1200 tokens | A conservative cost of re-deriving one project convention by exploration |
| Failed tool turn | 2500 tokens | A failing tool round-trip including the model's next attempt |
| Judge call | 120 tokens | Fixed fake verdict in this benchmark; the real judge is bounded and optional |

## Recorded result (this checkout)

Machine: Node `v22.23.2`, DSH `0.2.2-rc.2`. Generated `2026-11-14T04:54:02.461Z`.

| Metric | Value |
| --- | --- |
| Tool catalog | 30 tools / 8 475 schema tokens |
| Evidenced candidates | 21 tools |
| Tools hidden (automatic mode) | 21 |
| Schema tokens avoided per request | ~6 006 (70.9% of the catalog) |
| Protected tools hidden | none (`protectedNeverHidden: true`) |
| Confirmed facts | 12 |
| Injected block | 134 tokens (536 bytes) |
| Same facts under a 4-fact / 120-token cap | 4 facts / 50 tokens |
| Assumed rediscovery cost averted | 14 400 tokens |
| Break-even requests for the injection | 108 |
| Loop detected after | 8 tool calls (4 edit/test pairs) |
| Judge calls / tokens for that detection | 1 / 120 (assumed) |
| Redirects per turn | at most 1, and it never stops the agent |
| Cost with no price table | `unavailable` (no invented number) |
| Cost with explicit table for the model | `$0.02` |

The tool-pruning figure is large because the synthetic catalog is deliberately
adversarial: 21 unused tools with rich schemas, all past the configured evidence
threshold. A real catalog is smaller and more often used; the plugin's value there is
proportional to the schema mass it can prove unused, which is why the UI reports the
measured token mass rather than a percentage of dollars.

## What each section proves

* **Tool pruning** — `snapshot`, `evaluateCandidate`, `proposedCandidates` and
  `computeDenySet` run on the shipped policy; protected names are never proposed even
  when the row is stale, and no tool is invented into the deny set.
* **Micro-skills** — the block is produced by the same canonical renderer the Host uses
  for injection, so its size is the real prompt overhead. The cap behaviour is measured
  with a second configuration, not asserted.
* **Loop guard** — a warm envelope plus a repeated failing command triggers one judge
  call, one redirect decision, and the engine never returns a stop or abort action.
* **Pricing** — an unknown model yields `costUsd: null`; adding the user's own price
  table yields a number. Effective tokens require a known weight entry.

## Reproducibility

`benchmark/out/` is generated, not committed (`benchmark/out` is git-ignored). Re-running
on the same Node version produces the same counts; only `generatedAt` and timings change.
The loop-guard timing (`elapsedMs`) is informational, not a performance claim.
