# AGENTS.md

`pi-opencode-go-usage` is a pi/omp extension plugin that tracks OpenCode Go usage limits
(rolling 5h / weekly / monthly) in-session.

## What it does

OpenCode publishes no usage API. The `/workspace/<wrk_…>/go` page serialises its numbers
into the delivered HTML (`rollingUsage:$R[12]={status:"ok",resetInSec:17400,usagePercent:42}`).
The extension fetches that page with the user's browser `auth` cookie and parses the three
percentages + reset times. It reports percentages and countdowns only — the page carries no
dollar amounts.

## Build / test / lint

No build step: omp loads the `.ts` extension directly via its Bun-based loader.

```bash
bun test                 # run the parser/formatter/factory tests (test/parse.test.ts)
bun -e '...'             # ad-hoc probes (see examples below)
```

TypeScript is transpiled at load by omp; there is no tsc/lint pipeline. `import type { ExtensionAPI }`
from `@earendil-works/pi-coding-agent` is type-only and erased at runtime — it resolves at load time
from `~/.omp/plugins/node_modules` when omp loads the plugin.

## Layout

- `extensions/opencode-go-usage.ts` — the whole extension: fetch/parse, config persistence,
  status bar, `/opencode-go` command, periodic refresh.
- `package.json` — `omp.extensions` / `pi.extensions` manifest pointing at the extension entry.
- `test/parse.test.ts` — unit + wiring smoke tests.

## Conventions

- Single extension file; no build, no runtime deps. Bun globals (`fetch`, `setInterval`,
  `AbortController`) and `node:*` builtins only.
- Pure logic (`parseWorkspaceHtml`, `fetchUsage`, `bar`, `countdown`) is exported from the
  extension module so tests import it without running the factory.
- Credentials: `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` env vars (preferred), or
  `/opencode-go --connect` which persists to `~/.omp/agent/opencode-go-usage.json` (mode 0600).
- Fetch failures are typed: `noCredentials` / `timeout` / `network` / `unauthorized` /
  `http` / `noPayload`. `unauthorized` = cookie expired, `noPayload` = page redesign.

## Testing a live fetch

```bash
bun -e 'import { fetchUsage } from "./extensions/opencode-go-usage.ts";
fetchUsage("<wrk_…>", "auth=<cookie>").then(console.log, e => console.log(e.kind));'
```

## Install

```bash
omp plugin link /path/to/pi-opencode-go-usage   # local dev
omp plugin install github:Dakai/pi-opencode-go-usage   # from this repo
```
