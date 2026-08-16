# pi-opencode-go-usage

Track OpenCode Go usage limits — **rolling 5-hour, weekly, and monthly** — in-session
with a live status bar and a `/opencode-go` report widget.

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

OpenCode publishes **no usage API** and serves no `/api/*`. The
`/workspace/<wrk_…>/go` screen is a SolidStart app that serialises the resolved
values straight into the delivered HTML:

```
rollingUsage:$R[12]={status:"ok",resetInSec:17400,usagePercent:42}
```

This extension fetches that page with your browser `auth` cookie and reads the
three percentages + reset times out of the markup. It reports **percentages and
countdowns only** — the page carries no dollar amounts, so neither does this.

## Install

```bash
omp plugin install github:dakai/pi-opencode-go-usage    # adjust to your fork
# or, for local dev:
omp plugin link /path/to/pi-opencode-go-usage
```

Then restart the session (or `/reload`).

## Connect

You need two things from your signed-in opencode.ai workspace:

1. **Workspace ID** — the `wrk_…` segment in the address bar:
   `opencode.ai/workspace/`**`wrk_…`**`/go`
2. **`auth` cookie value** — on that page press F12 → Application → Cookies →
   `https://opencode.ai` → the `auth` row → copy its Value.

Either set env vars (recommended — keeps the cookie out of session history):

```bash
export OPENCODE_GO_WORKSPACE_ID=wrk_…
export OPENCODE_GO_AUTH_COOKIE='…'
```

or use the slash command (persists to `~/.omp/agent/opencode-go-usage.json`, mode 0600):

```
/opencode-go --connect wrk_… <auth-cookie-value>
```

## Commands

| Command                                 | Effect                                                        |
| --------------------------------------- | ------------------------------------------------------------- |
| `/opencode-go`                          | Fetch and show the report widget                              |
| `/opencode-go --connect <wrk> <cookie>` | Save both, fetch, show                                        |
| `/opencode-go --workspace <id>`         | Save workspace id only                                        |
| `/opencode-go --cookie <value>`         | Save cookie only                                              |
| `/opencode-go --disconnect`             | Forget both                                                   |
| `/opencode-go --refresh`                | Fetch again now                                               |
| `/opencode-go --json`                   | Export report to `~/.omp/agent/opencode-go-usage-report.json` |

Usage refreshes automatically every 5 minutes.

## Failure modes

| Status text                           | Meaning                    | Fix                           |
| ------------------------------------- | -------------------------- | ----------------------------- |
| `Cookie expired`                      | The `auth` session lapsed  | Reconnect with a fresh cookie |
| `Page carried no usage data`          | opencode.ai markup changed | Update the parser             |
| `Network error` / `Request timed out` | Transient                  | Retry                         |

## Security

This is a scrape authenticated by a browser session cookie, stored in a
`0600`-mode file (or in env vars). It reports only the percentages opencode.ai
already shows; a redesign of the page will break it, and it will say so instead
of showing a confident zero.

## License

MIT
