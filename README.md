# pi-opencode-go-usage

[![npm version](https://img.shields.io/npm/v/pi-opencode-go-usage?color=cb0000)](https://www.npmjs.com/package/pi-opencode-go-usage) [![pi package](https://img.shields.io/badge/pi-package-7a5cff)](https://pi.dev/packages/pi-opencode-go-usage) [![license MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**[简体中文](README.zh-CN.md) · English**

Track OpenCode Go usage limits — **rolling 5-hour, weekly, and monthly** — in-session
with a live status bar and a `/opencode-go` report widget.
![Status bar showing OpenCode Go usage](assets/pi-opencode-go-usage.png)

```
Status bar:  Go 5h 62% · wk 31% · mo 44%

Report widget:
  OpenCode Go Usage
  Workspace: wrk_xxxxxxxxxxxxxxxxxxxxxxxx
  Rolling 5h ██████░░░░  62% · 1h 12m
  Weekly     ███░░░░░░░  31% · 3d 4h
  Monthly    ████░░░░░░  44% · 12d 0h
  Updated 2:32:05 PM  (time format follows your locale)
```

## Why this exists

The `/console/<wrk_…>/go` screen is a client-side app, so its HTML carries no
numbers. It loads them from the console JSON API:

```
GET https://opencode.ai/console/api/go/status     (x-org-id: wrk_…)
-> { access: { meters: {
      fiveHour: { resetsAt, limitMicroCents, usedMicroCents },
      week:     { resetsAt, limitMicroCents, usedMicroCents },
      month:    { limitMicroCents, usedMicroCents } } } }
```

This extension calls that endpoint with your browser session cookie and derives
the three percentages (`used / limit`; the money fields are micro-cents, i.e.
1e-8 dollars) plus reset countdowns. It reports **percentages and countdowns
only** — it does not spend screen space on dollar figures.

## Install

```bash
pi install npm:pi-opencode-go-usage   # Pi (recommended)
# or
omp plugin install github:Dakai/pi-opencode-go-usage
# or, for local dev:
omp plugin link /path/to/pi-opencode-go-usage
```

Then restart the session (or `/reload`).

## Connect

You need two things from your signed-in opencode.ai account:

1. **Workspace ID** — the `wrk_…` segment in the address bar:
   `opencode.ai/console/`**`wrk_…`**`/go`
2. **Session cookie** — on that page press F12 → Application → Cookies →
   `https://opencode.ai` → the `__Host-console_session` row → copy its Value
   (it is `HttpOnly`, so `document.cookie` will not show it).

Either set env vars (recommended — keeps the cookie out of session history):

```bash
export OPENCODE_GO_WORKSPACE_ID=wrk_…
export OPENCODE_GO_AUTH_COOKIE='…'
```

or use the slash command (persists to `~/.omp/agent/opencode-go-usage.json`, mode 0600):

```
/opencode-go --connect wrk_… <session-cookie-value>
```

Bare values are sent as `__Host-console_session=<value>`. To send a different
cookie name, or several at once, pass a full cookie pair: `name=value; name2=value2`.

Env vars **take precedence** over the saved file: while they are set, `--connect` /
`--cookie` save but have no effect (the command warns when it detects this). Unset
them, or export the new value. `OPENCODE_GO_CONFIG_PATH` overrides where the file
lives (default `~/.omp/agent/opencode-go-usage.json`).

## Commands

| Command                                 | Effect                                                        |
| --------------------------------------- | ------------------------------------------------------------- |
| `/opencode-go`                          | Fetch and show the report widget                              |
| `/opencode-go --connect <wrk> <cookie>` | Save both, fetch, show                                        |
| `/opencode-go --workspace <id>`         | Save workspace id only                                        |
| `/opencode-go --cookie <value>`         | Save cookie only                                              |
| `/opencode-go --disconnect`             | Forget both                                                   |
| `/opencode-go --refresh`                | Fetch again now                                               |
| `/opencode-go --compact [on\|off]`      | Toggle compact status bar (`Go: 5h 0% · wk 2% · mo 2%`)       |
| `/opencode-go --json`                   | Export report to `~/.omp/agent/opencode-go-usage-report.json` |

Usage refreshes automatically every 5 minutes.

## Failure modes

| Status text                           | Meaning                        | Fix                           |
| ------------------------------------- | ------------------------------ | ----------------------------- |
| `Session expired`                     | The console session lapsed     | Reconnect with a fresh cookie |
| `No Go subscription on this workspace`| The console reports no Go plan | Check the workspace           |
| `Console API response unrecognised`   | The console API changed shape  | Update the parser             |
| `Network error` / `Request timed out` | Transient                      | Retry                         |

## Security

This is an authenticated read of your own usage figures, using a browser session
cookie stored in a `0600`-mode file (or in env vars). It reports only what the
console already shows; an API change will break it, and it will say so instead
of showing a confident zero.

## License

MIT
