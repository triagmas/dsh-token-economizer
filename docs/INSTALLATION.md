# Installation

## Requirements

* DeepSeek Harness `>=0.2.0 <0.3.0` (developed and tested against `0.2.2-rc.3`)
* Node.js 22+ (the version DSH 0.2.x requires)
* An existing DSH profile with the Plugin Manager (the `web` profile is the
  default target)
* No Python, no Docker, no external service, no API key beyond the model
  provider you already use

## Install from a local checkout (recommended during review)

```bash
# 1. Build the bundle
cd /path/to/dsh-token-economizer
npm install --no-audit --no-fund
npm run build

# 2. Install into the desired profile
dsh plugin --profile web add file:/path/to/dsh-token-economizer

# 3. Restart or reload the Web UI, then check
/economizer status
```

The absolute path is required: `file:./relative` is resolved by the Plugin
Manager, not by your shell.

## Install from GitHub

The compiled `lib/` and `client/` are committed, so a GitHub install does not
need a build step:

```bash
dsh plugin --profile web add github:triagmas/dsh-token-economizer
# for production, pin the commit:
# dsh plugin --profile web add github:triagmas/dsh-token-economizer#<sha>
```

## Install from a tarball

```bash
cd /path/to/dsh-token-economizer
npm pack
dsh plugin --profile web add file:/path/to/dsh-token-economizer/dsh-token-economizer-0.1.0.tgz
```

The package must contain `lib/`, `client/`, `locale/`, `icon.svg`,
`cordis.patch.yml`, `package.json`, `LICENSE`, and `NOTICE`. `npm run build`
produces `lib/`; `client/`, `locale/`, and `icon.svg` are shipped as authored.

## Enable and configure

The bundle is enabled when installed. Then:

1. Open **Settings → Token Economizer** in the Web UI. The overview shows mode,
   project, and measured usage.
2. Keep `mode = shadow` to evaluate for a few sessions. Nothing changes the
   model context or the tool list in shadow mode.
3. When the statistics look sane, switch to `mode = active` and enable only the
   mechanisms you want:
   * `microskillsInject` — send confirmed project facts to the model;
   * `toolpruneMode = automatic` — hide tools proven unused in this project;
   * `loopguardIntervene` — allow one `steer` redirect inside a stalled turn (`followup` fallback).
4. Optionally set `priceTable` to get cost estimates; without it the UI reports
   cost as unavailable.

## Verify

```bash
/economizer status          # mode, project, counters, compatibility
/economizer report          # measured vs estimated numbers
/economizer skills list     # facts and candidates
/economizer tools status    # hidden tools and mode
/economizer loops history   # incidents
```

In the Web UI, **Settings → Token Economizer** must show five tabs. If the
section is missing, the client bundle did not load: reinstall and reload the
page (the host half can still be checked with `/economizer status`).

Data is written to `<DSH_HOME>/token-economizer/`. The first
`/economizer status` creates it.

### Verified in this checkout

```text
dsh plugin --profile web add file:<local-checkout>  -> ok
dsh --profile web --dump-config | grep token-economizer
  - id: token-economizer
    name: dsh-token-economizer
install smoke in an isolated DSH_HOME (test_drive):
  local path: install PASS, config patch effective PASS, uninstall PASS
  GitHub:     install PASS, config patch effective PASS, uninstall PASS
  (the last headless-boot stage was skipped in those drives)
```

The Web UI is served by a process that mounted its bundles at boot. After installing,
restart that process (or start DSH again) before expecting
**Settings → Token economizer** to appear; a page reload alone cannot mount a new host
plugin.

## Update

```bash
cd /path/to/dsh-token-economizer
git pull            # or replace the checkout
npm install --no-audit --no-fund
npm run build
dsh plugin --profile web add file:/path/to/dsh-token-economizer
```

Installing over an existing entry keeps `install.json` (including `installedAt`)
and migrates data files forward. A data schema newer than the plugin supports
disables that mechanism and is reported rather than deleted.

## Disable

Either:

* toggle the plugin off in the Plugin Manager, or
* `dsh plugin --profile web disable dsh-token-economizer`.

Disabling stops observation, HTTP routes, the settings section, and the
command. Tool restrictions are scoped to the agent that received them and
disappear with it; no Harness behavior depends on the plugin.

## Uninstall

```bash
dsh plugin --profile web remove dsh-token-economizer
```

Stored data stays in `<DSH_HOME>/token-economizer/`. Delete that directory to
remove it:

```bash
rm -rf "$DSH_HOME/token-economizer"
```

Uninstalling does not modify DSH, other plugins, other profiles, model
settings, or user files.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Unknown command: economizer` | plugin not enabled in this profile or host half failed to load | check the Plugin Manager entry and DSH logs; `dsh plugin --profile web list` |
| Settings section missing, command works | client bundle not served | reinstall, then reload the page; verify `client/index.js` is in the package |
| `token-economizer: DSH X is outside the tested range` | version gate | upgrade/downgrade DSH to a tested release; the plugin refuses to run on an untested major |
| Command says project unknown | session has no workspace root yet | run a workspace tool once, or open a session inside a project |
| Cost shows "unavailable" | no `priceTable` entry for the model | add prices; this is intentional, not a bug |
| Tools did not get hidden | `mode` not `active`, or `toolpruneMode` not `automatic` | check both switches; statistics need `toolpruneMinSessions` sessions |
| Facts are not injected | `mode` not `active`, `microskillsInject` off, or no confirmed facts | confirm facts with `/economizer skills confirm <id>` |

Diagnostics are written to `<DSH_HOME>/token-economizer/errors.log` (redacted).
Set `debug = true` for more detail.
