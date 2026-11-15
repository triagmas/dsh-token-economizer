# Live checks on a GitHub installation

These are acceptance runs for the shipped plugin. The first run installed
`followup-hardening` from GitHub and exercised the three mechanisms plus the Web UI's
launch-token authorization. The second run installed `main` after the merge and closed
the remaining gap: it inspected the **model-visible tool list** of a fourth session, then
repeated the check on the shipped default thresholds.

## Environment

| Item | Redirect/Web run | Hiding run |
| --- | --- | --- |
| Date | 2026-11-15 (Asia/Vladivostok) | 2026-11-15 (Asia/Vladivostok) |
| Node / DSH | `v22.23.2` / `0.2.2-rc.3` | `v22.23.2` / `0.2.2-rc.3` |
| Installed spec | `github:triagmas/dsh-token-economizer#followup-hardening` | `github:triagmas/dsh-token-economizer#main` |
| Resolved commit | `128801eae85cd9c4ab4ab67064ecf72819ca4aac` | `809313db9ba03198c2995eaae719be772517e9b9` |
| Isolated home | `.dsh-gh` | `.dsh-hide` (low) and `.dsh-hide-default` (defaults) |
| Model route | `dsh-opencode-go` / `deepseek-v4.1-flash` / `high` | same |
| Test config | active, all three mechanisms, low pruning thresholds | low: `1/1/1`, quiet `0`; defaults: `10/2/5`, quiet `60` |

The low pruning thresholds are a test setting, not the shipped defaults. They make one
session enough evidence so a three-session run can prove the automatic hide path quickly.
The shipped defaults are `toolpruneEvidence=10`, `toolpruneMinSessions=2`,
`toolpruneSessions=5`, `toolpruneQuietMinutes=60`, `toolpruneReauditEvery=0`.

`DSH_HOME` lived on the NTFS workspace mount, which reports mode `777` for every file and
cannot be changed with `chmod`. For the Web run the credentials provider correctly
refused that file, so the profile was pointed at `/tmp/dsh-creds.yaml` (mode `600`)
through the profile patch. This is a mount limitation, not a plugin requirement. The
hiding run used an environment API key and no credentials file.

## Install

```bash
export DSH_HOME="$PWD/.dsh-gh"
dsh plugin --profile headless add github:triagmas/dsh-token-economizer#followup-hardening
dsh plugin --profile web      add github:triagmas/dsh-token-economizer#followup-hardening

export DSH_HOME="$PWD/.dsh-hide"
dsh plugin --profile headless add github:triagmas/dsh-token-economizer#main
```

Both profiles resolved the codeload tarball; the second run's
`profiles/headless/pnpm-lock.yaml` pinned
`https://codeload.github.com/triagmas/dsh-token-economizer/tar.gz/809313db9ba03198c2995eaae719be772517e9b9`.
The installed `lib/toolprune/policy.js` contains the added `web_` prefix, so the hiding
run exercised the GitHub artifact, not a workspace symlink.

## Headless: three pruning sessions and the fourth tool list

Three separate headless sessions, each one human prompt with no tool calls:

```bash
dsh --profile headless "Reply with exactly: LOW_1_OK. Do not call any tools."
dsh --profile headless "Reply with exactly: LOW_2_OK. Do not call any tools."
dsh --profile headless "Reply with exactly: LOW_3_OK. Do not call any tools."
```

Observed after the third session:

* all three printed their marker and exited `0`;
* `tools.json` tracked **29** catalog tools and `unusedPrompts` reached **3** on every row;
* `tools.json.pruned` contained **18** evidenced tools:
  `create_goal`, `exit_plan_mode`, `get_goal`, `job_kill`, `job_list`, `job_output`,
  `list_agents`, `send_message`, `subagent`, `subagent_fork`, `team_task_create`,
  `team_task_get`, `team_task_list`, `team_task_update`, `todo_write`, `update_goal`,
  `wait_agent`, `workflow`;
* `skill`, `web_fetch` and `web_search` were **not** in `pruned`, even though they were
  never called: the new capability protection held. `web_search` is not registered by
  this headless preset, so it does not appear in the request header either;
* `autoPending` was `null`: the evidenced set was already in `pruned` with the zero
  quiet window.

A fourth headless session was then started with the same profile and prompt
`LOW_4_OK`. DSH records the exact provider request header in the session log, so the
model-visible surface was read from `request/header` → `data.header.tools` (not inferred
from a chat answer):

| Session | Model-visible tools | Notes |
| --- | --- | --- |
| 1 | 23 | before any automatic hide |
| 2 | 10 | 13 previously visible, pruned names gone |
| 3 | 10 | same |
| 4 | 10 | same |

The fourth list was exactly:

```text
bash, edit, glob, grep, read, read_image, skill, web_fetch, working_directory, write
```

The 13 names that disappeared from the list were all in `pruned`:
`create_goal`, `get_goal`, `job_kill`, `job_list`, `job_output`, `list_agents`,
`send_message`, `subagent`, `subagent_fork`, `todo_write`, `update_goal`, `wait_agent`,
`workflow`. The other five pruned names (`exit_plan_mode` and the four `team_task_*`
tools) were never exposed by this headless preset, so their absence is not evidence
either way. Crucially, **no name from `tools.json.pruned` appears in the fourth request
header**, while the protected `skill` and `web_fetch` remain visible. The earlier
`21`-tool observation predates this protection and has been superseded.

## Headless: shipped defaults do not hide after one session

The same `main` artifact was installed into a second clean home and configured with
`mode: active`, `toolpruneMode: automatic` and **no threshold overrides**, so the schema
defaults `10/2/5` applied (confirmed in `src/config/schema.ts` /
`lib/config/schema.js`). One headless session in a clean project state produced:

* `tools.json.pruned` = `[]`, `autoPending` = `null`, 29 tools tracked;
* `unusedPrompts` = **1** per tool;
* the request header exposed **23** tools, byte-for-byte the same set as low session 1;
* marker `DEFAULT_1_OK`, exit `0`.

That is the expected result: one prompt is below both the `10` prompt floor and the `2`
session floor, so nothing is hidden and the full catalog stays in the request.

## Headless: stuck session and steer delivery (128801e)

The envelope was seeded with
`{"level":"aggressive","resolved_turns":[1,1,1],"resolved_snaps":[]}` to bound the
learning phase, then one session was asked to run ten identical failing commands:

```bash
sh -c 'echo "Error: boom" >&2; exit 1'
```

Observed:

* the guard fired at step **9**, with `errorOutputs: 8`, `repeatedFailSigs: 7`,
  `stagnation: 0.875`, judge `stuck`, confidence `0.98`;
* the redirect `user/message` was at sequence **90** and `turn/end` at sequence **102**:
  the steer landed **inside the turn**, before the end event;
* `loops.jsonl` recorded exactly one `redirect` with `delivery: "steer"`;
* the learned envelope was persisted: `resolved_turns` became `[1,1,1,12]` with
  `error_outputs: 10`, so `dispose()` did not lose it;
* the agent did not stop; after the redirect it produced a normal final answer and the
  session exited `0`.

This is the live evidence behind the steer-by-default behavior. It does **not** prove
that the running model step consumed the message: DSH queued it for the next step, and
the ordering only proves it was accepted before `turn/end`. It was observed on
`128801e`; the later commits only touched the header comment, one warning string, and the
protected-tool set.

## Web UI startup and authorization (128801e)

```bash
DSH_HOME="$PWD/.dsh-gh" dsh --profile web --no-open --port 3091
```

Startup printed a tokenized URL on `http://127.0.0.1:3091/`. The token was then used
exactly as a browser would use it:

| Request | Result |
| --- | --- |
| `GET /` without cookie | `401 Unauthorized` |
| `GET /api/token-economizer/status` without cookie | `401 Unauthorized` |
| `GET /?token=…` | `303 See Other`, `Set-Cookie: dsh-auth-…; HttpOnly; SameSite=Strict; Max-Age=2592000` |
| `GET /` with the cookie | `200 OK`, 41 822-byte app shell |
| `GET /api/token-economizer/status?cwd=…` with the cookie | `200 OK`, plugin `0.1.0`, DSH `0.2.2-rc.3`, compatibility OK, `mode: "active"`, all three mechanisms effective |

The status response also reported the isolated storage root and the active project, so
the plugin was loaded inside the GitHub-installed Web profile and its authenticated route
worked. No live model chat was created through the Web UI in this check.

## Not verified

These are gaps, not passes:

* **Only the headless preset's catalog was probed.** `ask_user_question`, `present`,
  `plugin_manager`, `web_search`, `lint_*`, `codegraph_*` and `terminal_*` are not
  registered in this headless profile, so the fourth-session header cannot prove they
  stay visible. It does prove that `skill` and `web_fetch` stay visible and that every
  pruned name disappears.
* **No browser rendering check.** Authorization was verified with HTTP requests and a
  cookie jar, not with a browser. The settings page visually rendering, the overview
  numbers after a live Web conversation, and client-side interactions were not observed.
* **No Web UI model session.** The Web profile booted and authenticated, but no message
  was sent from the browser, so Web session creation, streaming, and the plugin's
  per-session UI were not exercised end to end.
* **No live `followup` fallback.** Steer succeeded, so the fallback path was covered only
  by unit tests. A host that lacks `agent.steer` or rejects it was not run live.
* **No micro-skills injection on real facts.** The isolated project had no confirmed
  facts; the knowledge-block behavior is covered by unit tests, not by a live prompt with
  a non-empty block.
* **One model run, not a distribution.** The judge verdict is model output; the observed
  confidence and wording are a single sample.
* **No npm-published artifact.** The install used the Git branch tarball; the npm package
  and a tagged release were not published or tested.
* **No Windows-native harness run.** The isolated home was on an NTFS mount but DSH ran
  under Linux; the mount's `777` mode was worked around with a `/tmp` credential file for
  the Web run. Windows-native behavior, where DSH skips the POSIX mode check, was not
  exercised.
* **No public/remote deployment.** The listener was loopback-only with plain HTTP; TLS,
  a non-loopback bind, and a trusted proxy were not exercised.

## Cleanup

The runs used their own `.dsh-gh`, `.dsh-hide` and `.dsh-hide-default` homes and a
`/tmp/dsh-creds.yaml` for the Web run; none is part of the repository. The Web server was
stopped after the checks and the temporary homes and credential file were removed.
