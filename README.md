# dsh-token-economizer

Experience-driven cost control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
**micro-skills**, **evidence-based tool pruning**, and a **failure-loop guard**, with
local-only metrics that never invent a saving.

This is an independent TypeScript port of the deterministic mechanisms in Microsoft's
[TokenEconomizer](https://github.com/microsoft/TokenEconomizer) (Apache-2.0, pinned
commit `7042ea89`). See [docs/UPSTREAM.md](docs/UPSTREAM.md) for exactly what is ported,
what is adapted to the Harness, and what is deliberately not ported.

**Project status (v0.1.0):** a functional, tested core of the three mechanisms,
not a 1:1 port of the whole upstream product. The remaining fidelity gaps and
the review protocol are documented in [REVIEW.md](REVIEW.md). If you are
reviewing this repository, read that file first: the acceptance criterion is
fidelity to the pinned upstream commit, not a general redesign.

* No fork of DSH, no patched system packages, no MCP transport, no external server.
* Runs in the Web UI, the TUI/CLI, and headless runs. All state is plain JSON/JSONL
  under `$DSH_HOME/token-economizer/`.
* Fails open and is fully reversible: disabling the plugin restores the original tool
  surface and stops every injection.

## What it does

| Mechanism | Learning signal | What it can change (ACTIVE only) | Default |
| --- | --- | --- | --- |
| Micro-skills | Repeated commands, repairs and file conventions across sessions in one repository | One attributed prompt block with confirmed facts | measured in SHADOW |
| Tool pruning | Tool schemas present vs. tools actually called across sessions | Hides evidenced, unused, non-protected tools for that project; the work surface, controls, `skill` and `web_*` stay | recorded in SHADOW |
| Failure-loop guard | Repeated failing tool calls, edit churn (including edits through Bash), stagnation | At most **one** bounded redirect per turn, delivered with `steer` inside it (`followup` fallback) | detected in SHADOW |

Modes:

* **OFF** — no observation, no files touched (data is kept).
* **SHADOW** (default) — everything is measured and shown, nothing is injected, hidden
  or redirected; the paid judge is never called.
* **ACTIVE** — applies only the mechanisms you enable individually:

  ```bash
  /economizer mode active
  # then, per mechanism:
  /economizer config microskillsInject true
  /economizer config toolpruneMode automatic
  /economizer config loopguardIntervene true
  ```

## Install

From a local checkout:

```bash
cd /path/to/dsh-token-economizer
npm install --no-audit --no-fund
npm run build

dsh plugin --profile web add file:/absolute/path/to/dsh-token-economizer
```

`cordis.patch.yml` is the bundle patch DSH reads through
`package.json#dsh.bundle.patch`. It inserts one host plugin entry
(`token-economizer`, empty config) into the selected profile; it does not patch
DSH core, another plugin, or the workspace. Removing the package removes that
insert, which is why uninstall is reversible.

From GitHub (the compiled `lib/` and `client/` are committed, so no build step
is needed):

```bash
dsh plugin --profile web add github:triagmas/dsh-token-economizer
# for a reproducible install, pin the commit:
# dsh plugin --profile web add github:triagmas/dsh-token-economizer#<sha>
```

Restart the Web UI (host plugins mount at boot). Then:

```bash
/economizer status        # what is on, what was measured
/economizer on            # switch to SHADOW
/economizer mode active   # apply enabled mechanisms
/economizer report        # measured vs estimated, per mechanism
```

Full details, tarball install and uninstall: [docs/INSTALLATION.md](docs/INSTALLATION.md).
Requirements: DSH `>=0.2.0 <0.3.0`, Node.js 22+.

## Web UI

Settings → **Token economizer** (five tabs, English and Russian):

* **Overview** — mode, measurement totals, mechanism counters, budget and honest notes, with a compact six-column metric table.
* **Micro-skills** — confirmed facts, pending candidates, confirm/reject/clear.
* **Tools** — compact usage summary, calls/evidence, status and restore, pruning mode; protected names collapse into one summary line.
* **Loop guard** — incidents, judge usage, redirect history.
* **Settings** — every configuration field in collapsible groups, with inline help, validation, changed markers and a sticky save bar.

The same data is served under the authenticated `/api/token-economizer/*` channel; the
client bundle has no build step and uses only `react` from the Harness module loader.

**Long-lived sessions.** The Web UI keeps one agent alive across many turns; DSH fires
`agent/created` once, not once per turn. Consequently the knowledge block is frozen at
that session's first prompt, and a newly eligible automatic tool hide waits in
`tools.json.autoPending` until a **new** session starts (or the host restarts). This is
deliberate: changing the prompt or the tool catalog mid-session invalidates the provider
cache and can break an in-flight tool call. Close and reopen the session (or restart the
host) to pick up both changes; `/economizer status` shows what is still pending.

## CLI

```text
/economizer status | on | off | mode shadow|active | report
/economizer skills list | skills review | skills clear
/economizer tools status | tools restore <name> | tools restore --all
/economizer loops history
/economizer config [key] [value]
```

`/economizer on` means SHADOW; applying changes always requires `mode active`.

## Measurement honesty

* Raw token counts are provider-reported and never re-derived.
* **Effective tokens** are the cache-aware fresh-input equivalent; the figure is `null`
  when any contributing model has no weight entry, never a partial sum.
* **USD** is computed only from your explicit `priceTable`; otherwise the UI says
  "unavailable" and names the unpriced models. Savings are labelled **estimates**
  computed from measured text sizes, never presented as a measured percentage.
* Subagent usage is attributed to the root session exactly once; when it cannot be
  attributed, the UI reports it as unobserved instead of dropping it.
* The loop guard's judge calls are counted as plugin overhead, not as savings.

## Privacy

Only bounded, redacted evidence is stored: sanitized command lines, edited file paths,
short error snippets. Prompts and full tool outputs are never written. Secret-shaped
values, private-key blocks and sensitive paths are removed before anything reaches the
store or the judge. See [docs/SECURITY.md](docs/SECURITY.md).

## Configuration

All fields are documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md). The most
important ones:

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `shadow` | `off`, `shadow`, `active` |
| `microskillsInject` | `false` | Inject confirmed facts in ACTIVE |
| `toolpruneMode` | `observe` | `disabled`, `observe`, `propose`, `automatic` |
| `loopguardIntervene` | `false` | Queue one `steer` redirect per turn in ACTIVE (`followup` fallback) |
| `loopguardJudge` | `true` | Allow the optional paid judge and, after a *stuck* verdict, the redirect writer (never in SHADOW) |
| `priceTable` | `""` | JSON `{ "provider/model": {input, output, cacheRead, cacheWrite} }` |
| `subagentsEnabled` | `true` | Attribute subagent usage to the root session |

## Verification

Run locally (no network, no API key):

```bash
npm run build
npm test                 # unit + integration suites
node tests/smoke.mjs     # host-entry smoke against a fake Context
npm run benchmark        # deterministic mechanism benchmark
npm run check:dist       # committed lib/ matches a fresh build; client parses
```

Last recorded results in this checkout:

```text
unit/integration: 232 tests, 232 pass, 0 fail
parity (pinned Python upstream): 43 tests, 43 pass, 0 fail
smoke: PASS
install smoke (isolated DSH_HOME): local and GitHub install/patch/uninstall PASS; the GitHub profile booted headless and served the authenticated Web UI (see [docs/LIVE-CHECK.md](docs/LIVE-CHECK.md))
```

Benchmark summary (**schema-token counts and stated assumptions, not provider cost**; synthetic but shipped code paths; see [docs/BENCHMARK.md](docs/BENCHMARK.md)):

* 30-tool catalog: 21 evidenced tools hidden, ~70.9% of catalog schema tokens avoided per request.
* 12 confirmed facts: 134-token injection block, capped to 4 facts / 50 tokens under a small cap.
* Spiral: detected after 8 tool calls, one judge call, one redirect per turn, never a stop.
* Unknown model: cost **unavailable** without a price table, `$0.02` with an explicit table.

## Known limitations

* The paid LLM distiller ("proposer") is **not** called automatically. `envfacts` is
  deterministic; `distiller` renders facts you confirmed (or pass as candidates) and builds
  proposer prompts, but does not spend a model call. This keeps the plugin free by default.
* The tool-pruning LLM judge, catalog-refresh actions, repository map and history import
  are not ported. Tool pruning here is evidence-based, persists the hidden set in
  `tools.json`, supports a durable per-project restore, and uses the DSH-native
  `tools.restrict()` surface. Name/glob protection **is** supported:
  `toolpruneAllowlist` accepts exact names, `*`, `**` and `?` patterns such as `mcp__*`.
  The orchestration/optional execution tools (`subagent`, `workflow`, `schedule_*`,
  `job_*`, goal tools, UI renderers) are prunable; the file/shell/analysis work surface,
  the human-control tools, `skill` and the `web_*` family are not. Protecting `skill` and
  `web_*` is a deliberate deviation from upstream's optional-tool policy: losing skill
  loading or network access after a quiet period would be a capability regression, not
  just a schema saving. See [docs/UPSTREAM.md](docs/UPSTREAM.md).
* The redirect is written by the model only when the paid judge returns a confident
  *stuck* verdict; a heuristic-only or ambiguous verdict uses the deterministic
  count template rather than spending a second model call.
* **Redirect delivery is deferred by one macrotask.** DSH rejects a `steer`/`followup`
  issued while the tool-result append is still being published, so the adapter queues it
  with `setImmediate`. `agent.steer` is the default: it is scheduled for the next model
  step and, in the live `0.2.2-rc.3` run, the redirect `user/message` appeared before
  `turn/end` (after the model's last step, so it may only be consumed on the next step).
  If `steer` is unavailable or throws, the adapter falls back to `agent.followup`, which
  arrives after the current turn. The incident records `steer` or `followup-degraded`
  only after that call actually returns; a refusal is `failed` and is not counted. The
  guard decision itself is still made from in-turn tool evidence, and it never stops the
  agent.
* Shell edits are detected from Bash commands (`sed -i`, `perl -pi`, redirects and
  `tee`, inline Python writes, `patch`/`git apply`, `apply_patch`); a write whose
  target cannot be read counts as `(patch)` / `(script)`, as upstream does.
* A restored tool becomes a durable per-project allowlist entry. There is no inverse
  "enable automatic pruning again" UI action yet; the `restored` row is the source of truth.
* The loop-guard envelope is persisted per project in `loopguard.json` and restored before
  the first decision, so the judge and backstop do not need a fresh warm-up after a restart.
* Cold-start injection is rendered deterministically from the persisted fact rows, so a
  retired or cleared fact cannot reappear from a stale cached block; it is never recomputed
  from the full session log.

## Uninstall

```bash
dsh plugin --profile web remove dsh-token-economizer
```

The plugin never modifies other profiles or the Harness installation. Its data directory
is left intact so a reinstall keeps your confirmed facts; remove
`$DSH_HOME/token-economizer/` manually if you want a clean slate.

## License

Apache-2.0. Portions derived from Microsoft TokenEconomizer (Apache-2.0); see
[LICENSE](LICENSE) and [NOTICE](NOTICE).
