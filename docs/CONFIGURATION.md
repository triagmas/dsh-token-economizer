# Configuration

Every field is a DSH volatile configuration option: changes apply immediately
without restarting the Harness. Configure through the Plugin Manager's settings
page, `/economizer config set <key>=<value>`, or the plugin's Settings tab.

## Modes

| Key | Default | Values | Meaning |
| --- | --- | --- | --- |
| `mode` | `shadow` | `off`, `shadow`, `active` | Global switch. `shadow` observes and reports only; `active` applies mechanisms that are individually enabled. |

## Micro-skills

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `microskillsEnabled` | `true` | boolean | Learn project facts from finished sessions. |
| `microskillsInject` | `false` | boolean | Send confirmed facts to the model (ACTIVE only). |
| `microskillsProfile` | `envfacts` | `envfacts`, `distiller`, `envfacts+distiller` | `envfacts` is local and LLM-free; `distiller` uses the optional proposer (costs tokens); combined runs both. |
| `microskillsMaxFacts` | `4` | 0–50 | Maximum facts in the injected block. |
| `microskillsMaxTokens` | `150` | 0–4000 | Token budget of the injected block (~4 bytes per token). |
| `microskillsMinConfirmations` | `3` | 1–10 | Independent confirmations before a candidate becomes active. |
| `microskillsRetireDays` | `0` | 0–3650 | Retire facts not exercised for this long; `0` disables retirement. |

## Tool pruning

| Key | Default | Values | Meaning |
| --- | --- | --- | --- |
| `toolpruneEnabled` | `true` | boolean | Track tool usage per project. |
| `toolpruneMode` | `observe` | `disabled`, `observe`, `propose`, `automatic` | `observe` records only; `propose` reports candidates; `automatic` hides eligible tools (ACTIVE only). |
| `toolpruneEvidence` | `10` | 1–100 | Prompts (completed turns) where a tool was available but unused before it qualifies. |
| `toolpruneMinSessions` | `2` | 1–100 | Minimum observed sessions the prompt evidence must be spread over. |
| `toolpruneSessions` | `5` | 1–100 | Sessions shortcut: hide an unused tool even when its prompt count is lower. |
| `toolpruneQuietMinutes` | `60` | 0–10080 | Project inactivity before new automatic hides apply at the next session. `0` applies them at the next session immediately. |
| `toolpruneReauditEvery` | `0` | 0–1000 | Re-read the catalog every N tasks; `0` disables periodic re-audit. |
| `toolpruneAllowlist` | `[]` | string[] | Tool names that are never hidden. |

Protected tools from upstream are always kept: shell/read/write/edit/patch,
search, planning and delegation essentials. The Settings tab shows the effective
list.

## Loop guard

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `loopguardEnabled` | `true` | boolean | Detect repeated failures and stalls. |
| `loopguardIntervene` | `false` | boolean | Inject a redirect (ACTIVE only; never stops the agent). |
| `loopguardLevel` | `default` | `conservative`, `default`, `aggressive` | Threshold preset. |
| `loopguardJudge` | `true` | boolean | Allow one capped judge call per candidate; a *stuck* verdict may also spend one capped writer call for the redirect. |
| `loopguardConfidence` | `0.7` | 0.5–1 | Minimum judge confidence to redirect. |
| `loopguardMaxInterventions` | `1` | 0–5 | Maximum redirects per turn. |
| `loopguardJudgeTimeoutMs` | `20000` | 1000–120000 | Hard judge timeout; on expiry the guard does nothing. |
| `loopguardNudgeMaxTokens` | `120` | 20–1000 | Maximum redirect message length, whether written by the model or built from the template. |

## Subagents

| Key | Default | Meaning |
| --- | --- | --- |
| `subagentsEnabled` | `true` | Attribute subagent sessions to the root session once; when off, subagent sessions are ignored. |

## Model, budget, privacy

| Key | Default | Meaning |
| --- | --- | --- |
| `judgeProvider` | `""` | Judge provider override; empty inherits the session route. |
| `judgeModel` | `""` | Judge model override; empty inherits the session route. |
| `maxOverheadTokensPerTurn` | `4000` | Hard budget for all economizer model overhead in a turn (`0` disables extra calls). |
| `maxOverheadTokensPerSession` | `30000` | Hard budget per session. |
| `storeEvidence` | `true` | Keep short redacted evidence with facts. |
| `retentionDays` | `180` | Delete metrics older than this. |
| `maxMetricsBytes` | `4194304` | Rotate a project's metrics file above this size. |
| `priceTable` | `""` | JSON price overrides for cost reporting. |
| `debug` | `false` | Verbose diagnostics in `errors.log`. |

### Price table format

```json
{
  "deepseek/deepseek-chat": { "input": 0.27, "output": 1.1, "cacheRead": 0.07, "cacheWrite": 0.27 }
}
```

Prices are USD per **million** tokens. Without an entry for every observed
model the UI reports cost as unavailable and lists the unpriced models; it never
guesses a price. Effective-token weights are separate, model-specific, and come
from the pinned upstream `pricing.py` port (`src/pricing/weights.ts`).

## CLI

```
/economizer status
/economizer on | off
/economizer mode shadow|active|off
/economizer report
/economizer skills list|review|confirm <id>|reject <id>|clear
/economizer tools status|restore [name]|mode observe|propose|automatic
/economizer loops history [n]
/economizer config
/economizer config set <key>=<value>
```

`on` enables SHADOW observation. Applying changes requires `mode active` plus
the relevant mechanism switch; this is intentional.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | Data root; storage goes to `$DSH_HOME/token-economizer/`. |
| `DSH_INSTALL_DIR` | auto-detected | Used only to read the DSH version for compatibility reporting. |
