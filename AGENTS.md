# AGENTS.md

`pi-opencode-go-usage` is a pi/omp extension plugin that tracks OpenCode Go usage limits
(rolling 5h / weekly / monthly) in-session.

## What it does

OpenCode publishes no usage API of its own, but the `/console/<wrk_…>/go` screen is a
client-side app that loads its numbers from the console JSON API:

```
GET https://opencode.ai/console/api/go/status      header: x-org-id: wrk_…
-> { access: { meters: {
      fiveHour: { resetsAt, limitMicroCents, usedMicroCents },
      week:     { resetsAt, limitMicroCents, usedMicroCents },
      month:    { limitMicroCents, usedMicroCents } } } }
```

The extension calls that endpoint with the user's `__Host-console_session` cookie and
derives the three percentages (`used / limit`; money fields are micro-cents = 1e-8
dollars) plus reset countdowns. It reports percentages and countdowns only. `fiveHour`
and `week` carry their own `resetsAt`; `month` has no window, so its reset is the paid
period end `access.endsAt` — the value the console page renders for "Monthly usage".

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
- Pure logic (`parseGoStatus`, `fetchUsage`, `bar`, `countdown`) is exported from the
  extension module so tests import it without running the factory.
- Credentials: `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` env vars (preferred), or
  `/opencode-go --connect` which persists to `~/.omp/agent/opencode-go-usage.json` (mode 0600),
  overridable with `OPENCODE_GO_CONFIG_PATH` (the test suite uses this so it never writes the
  real file). Env vars win over the saved file, so `--connect`/`--cookie`/`--disconnect` warn
  when they are being shadowed. The cookie may be a bare value (sent as
  `__Host-console_session=<value>`) or a full `name=value; name2=value2` string.
- Fetch failures are typed: `noCredentials` / `timeout` / `network` / `unauthorized` /
  `http` / `noSubscription` / `noPayload`. `unauthorized` = session expired,
  `noSubscription` = the console reports no Go plan on that workspace,
  `noPayload` = the console API changed shape.

## Testing a live fetch

```bash
bun -e 'import { fetchUsage } from "./extensions/opencode-go-usage.ts";
fetchUsage("<wrk_…>", "<session-cookie>").then(console.log, e => console.log(e.kind));'
```

## Install

```bash
omp plugin link /path/to/pi-opencode-go-usage   # local dev
omp plugin install github:Dakai/pi-opencode-go-usage   # from this repo
```
