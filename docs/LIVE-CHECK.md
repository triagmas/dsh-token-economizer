# Live check on a GitHub installation

This is the acceptance run for the hardening branch. It installs the plugin the way a
user would — from GitHub, not from this checkout — into a fresh `DSH_HOME`, and exercises
the three mechanisms plus the Web UI's launch-token authorization. It records exactly
what was observed and, at the end, what was **not** verified.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-11-15 (Asia/Vladivostok) |
| Node | `v22.23.2` |
| DSH | `0.2.2-rc.3` |
| Installed spec | `github:triagmas/dsh-token-economizer#followup-hardening` |
| Resolved commit | `128801eae85cd9c4ab4ab67064ecf72819ca4aac` (from `pnpm-lock.yaml`) |
| Isolated home | `/mnt/f/_deepseek/Plugins/dsh-token-economizer/.dsh-gh` |
| Project | `/mnt/f/_deepseek/Plugins/dsh-token-economizer/.dsh-gh/project` |
| Model route | `dsh-opencode-go` / `deepseek-v4.1-flash` / `high` |
| Test config | `mode=active`, all three mechanisms on, `toolpruneEvidence=1`, `toolpruneMinSessions=1`, `toolpruneSessions=1`, `toolpruneQuietMinutes=0`, `loopguardLevel=aggressive` |

The low pruning thresholds are a test setting, not the shipped defaults. They make one
session enough evidence so the three-session run can prove the automatic hide path inside
a short check. The shipped defaults remain `toolpruneEvidence=10`,
`toolpruneMinSessions=2`, `toolpruneSessions=5`.

`DSH_HOME` lived on the NTFS workspace mount, which reports mode `777` for every file and
cannot be changed with `chmod`. The credentials provider correctly refused that file, so
the Web profile was pointed at `/tmp/dsh-creds.yaml` (mode `600`) through the profile
patch. This is a mount limitation, not a plugin requirement.

## Install

```bash
export DSH_HOME="$PWD/.dsh-gh"
dsh plugin --profile headless add github:triagmas/dsh-token-economizer#followup-hardening
dsh plugin --profile web      add github:triagmas/dsh-token-economizer#followup-hardening
```

Both profiles resolved the same codeload tarball;
`profiles/headless/pnpm-lock.yaml` pinned
`https://codeload.github.com/triagmas/dsh-token-economizer/tar.gz/128801eae85cd9c4ab4ab67064ecf72819ca4aac`.
The installed `lib/index.js` contains the `steer` path and the `agent/disposed` cleanup,
so the run exercised the GitHub artifact, not a workspace symlink.

## Headless: three pruning sessions

Three separate headless sessions, each one human prompt with no tool calls:

```bash
dsh --profile headless "Reply with exactly: SESSION_1_OK. Do not call any tools."
dsh --profile headless "Reply with exactly: SESSION_2_OK. Do not call any tools."
dsh --profile headless "Reply with exactly: SESSION_3_OK. Do not call any tools."
```

Observed:

* all three printed `SESSION_1_OK`, `SESSION_2_OK`, `SESSION_3_OK` and exited `0`;
* `unusedPrompts` reached **3** for all 29 catalog tools;
* `tools.json.pruned` contained **21** evidenced tools
  (`create_goal`, `exit_plan_mode`, `get_goal`, `job_*`, `list_agents`,
  `send_message`, `skill`, `subagent*`, `team_task_*`, `todo_write`,
  `update_goal`, `wait_agent`, `web_fetch`, `web_search`, `workflow`);
* the file/shell/analysis surface (`bash`, `read`, `write`, `edit`, `glob`, `grep`,
  `read_image`) stayed out of the deny set;
* `autoPending` was absent: the evidenced set was already in `pruned` with the zero
  quiet window. No fourth session was run to observe the model-facing tool list.

The live event log also confirmed the order that the observer must tolerate:
`turn/start` at sequence 4 and the human `user/message` at sequence 8 in **all three**
sessions. `unusedPrompts` still advanced to 3, so the prompt is retained across either
order.

## Headless: stuck session and steer delivery

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
the ordering only proves it was accepted before `turn/end`.

## Web UI startup and authorization

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

* **No browser rendering check.** Authorization was verified with HTTP requests and a
  cookie jar, not with a browser. The settings page visually rendering, the overview
  numbers after a live Web conversation, and client-side interactions were not observed.
* **No Web UI model session.** The Web profile booted and authenticated, but no message
  was sent from the browser, so Web session creation, streaming, and the plugin's
  per-session UI were not exercised end to end.
* **No live `followup` fallback.** Steer succeeded, so the fallback path was covered only
  by unit tests. A host that lacks `agent.steer` or rejects it was not run live.
* **No visual confirmation that the fourth session's tool list is smaller.** The hide set
  was verified in `tools.json` (`pruned` has 21 entries), and the policy is covered by
  tests, but the model-facing tool list of a subsequent session was not inspected.
* **No micro-skills injection on real facts.** The isolated project had no confirmed
  facts; the knowledge-block behavior is covered by unit tests, not by a live prompt with
  a non-empty block.
* **One model run, not a distribution.** The judge verdict is model output; the observed
  confidence and wording are a single sample.
* **No npm-published artifact.** The install used the Git branch tarball; the npm package
  and a tagged release were not published or tested.
* **No Windows-native harness run.** The isolated home was on an NTFS mount but DSH ran
  under Linux; the mount's `777` mode was worked around with a `/tmp` credential file.
  Windows-native behavior, where DSH skips the POSIX mode check, was not exercised.
* **No public/remote deployment.** The listener was loopback-only with plain HTTP; TLS,
  a non-loopback bind, and a trusted proxy were not exercised.

## Cleanup

The run used its own `.dsh-gh` home and `/tmp/dsh-creds.yaml`; neither is part of the
repository. The Web server was stopped after the checks, and the temporary credential
file was removed.
