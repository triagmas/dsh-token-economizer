# Compatibility

## Tested matrix

| Component | Version | Status |
| --- | --- | --- |
| DeepSeek Harness | `0.2.2-rc.3` | tested host + WebUI |
| Node.js | `22.23.2` (DSH runtime) | tested |
| Profile | `web` | tested |
| Surfaces | CLI command, WebUI settings section, headless plugin load | tested |
| OS | Linux (WSL2) | tested |

`src/dsh/version.ts` defines the accepted range `>=0.2.0 <0.3.0`. The version
is read from `$DSH_INSTALL_DIR/package.json`; if it cannot be read the plugin
logs a warning and continues (fail-open), and the status view says the version
is unknown. A version outside the range is a hard load error with a clear
message, because silently running against an untested API is worse than not
loading.

## APIs used (public DSH surface)

| Capability | API | Used for | Behaviour if absent |
| --- | --- | --- | --- |
| Plugin entry | `export function apply(ctx, config)`, `export const inject`, `export const Config` | host plugin | plugin fails to load (normal Cordis contract) |
| Bundle install | `package.json#dsh.bundle.patch`, `cordis.patch.yml` | profile registration | normal Plugin Manager error |
| Client entry | `package.json#dsh.client`, `./client`, `window.__ModuleLoader__` | WebUI | UI section absent; host works |
| Settings slot | `ctx.slots.inject('settings.section', …)` | settings page | UI section absent; host works |
| Locale | `ctx.locale.register(ns, {en, ru})` | EN/RU | falls back to English keys |
| HTTP routes | `ctx.inject(['connection'], scope => scope.connection.fetch.register({...}))`; `get()` is not used because plugins can apply before the service exists | UI data | UI shows HTTP 404; CLI works |
| Commands | `ctx.commands.register({name, handler})` | `/economizer` | only the UI remains |
| Session events | `ctx.on('session/event', …)` | observe turns | no measurements, mechanisms idle |
| Agent lifecycle | `ctx.on('agent/created' | 'agent/disposed', …)` | per-agent wiring | no injection/pruning, observation still works |
| Prompt context | `systemPrompt.context({name, order, text})` | knowledge block | injection disabled, warning logged |
| Tool catalog | `ctx.tools.definitions(scope?)` | pruning statistics | pruning disabled, warning logged |
| Tool restriction | `agent.ctx.tools.restrict({deny})` | hide tools | pruning disabled, warning logged |
| Loop redirect | `agent.steer(message)` deferred one macrotask, recorded as `steer`; `agent.followup` fallback recorded as `followup-degraded` | one redirect per turn; steer lands inside the turn before `turn/end`, followup after it | no redirects, guard still measures |
| LLM | `ctx.llm.stream(options)` | judge only in ACTIVE with `loopguardEnabled` + `loopguardIntervene` + `loopguardJudge` and budget | judge disabled, guard uses deterministic rules only |
| Config | `ctx.get('configEditor').edit(entry, fn)` | persist settings | settings read-only; `/economizer config set` fails |

Every optional capability is feature-detected at runtime. The plugin never
imports a DSH package as an npm dependency; it relies on ambient types and the
Host's service container, so patch releases inside `0.2.x` do not break
installation.

## Known limitations

* **WebUI requires the DSH client plugin platform** (`platform: web`). Headless
  and CLI use the Host half only.
* **Long-lived Web sessions keep their starting prompt and tool surface.** DSH
  fires `agent/created` once per session, not per turn. A newly eligible
  automatic hide waits in `tools.json.autoPending` for the next session (or host
  restart), and the knowledge block is frozen at the first prompt after the
  project warms. Close/reopen the session to apply both; the status view reports
  pending hides.
* **JS-only client bundle**: `client/index.js` is plain JavaScript loaded through
  `window.__ModuleLoader__`; it is not a separately built Vite application.
* **Judge quality depends on the session model.** With `judgeProvider`/
  `judgeModel` empty, the judge uses the session route. Providers that omit
  usage produce no judge-token accounting for that call; the incident records
  `tokens: 0` and a note, never a guess.
* **Effective tokens** require a known model id present in the upstream weight
  table. Unknown models show `n/a` rather than a fabricated ratio.
* **USD cost** requires a user-supplied `priceTable`; upstream ships weights,
  not prices.
* **Python parity tests are optional** and skipped when Python or the vendored
  checkout is missing. The shipped plugin never requires Python.
* **Windows/macOS** are expected to work (Node-only code, atomic rename
  semantics) but were not exercised in this review; only Linux/WSL2 is marked
  tested.

## Verification evidence (this checkout)

```text
node --test tests/*.test.mjs       232 tests, 232 pass, 0 fail
node --test tests/parity/*.test.mjs 43 tests,  43 pass, 0 fail
node tests/smoke.mjs               PASS (host entry, fake Context)
node benchmark/run.mjs             deterministic, offline, PASS
test_drive (isolated DSH_HOME)     install/config/uninstall PASS; boot smoke skipped
GitHub install (fresh DSH_HOME)    headless 3 sessions + stuck session PASS
dsh --profile web                  launch-token auth PASS (401 / 303 / 200)
```

The GitHub-install run exercised the installed artifact, not this checkout: three
headless sessions, a stuck session with `delivery: "steer"`, and an authenticated Web
status route (`mode: "active"`, all mechanisms effective). The full evidence and the
remaining gaps are in [LIVE-CHECK.md](LIVE-CHECK.md). Browser rendering and a Web-chat
session were not exercised; the client bundle passes `node --check` and the settings API
contract is covered by the route tests.

## Upgrade procedure

1. Read the DSH release notes for changes to session events, the tool registry,
   prompt contexts, or the command contract.
2. Run `npm run typecheck && npm test`.
3. Install into a scratch profile first, run one session in shadow mode, and
   compare `/economizer report` with the provider's usage page.
4. Update the tested matrix in this file when the range changes.
