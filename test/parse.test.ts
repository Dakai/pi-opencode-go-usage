import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bar, countdown, fetchUsage, parseGoStatus } from "../extensions/opencode-go-usage";
import opencodeGoUsage from "../extensions/opencode-go-usage";

// Shape of GET /console/api/go/status: micro-cents are bigints, so they arrive
// as JSON strings; `month` carries no rolling window.
const FIXTURE = {
  subscriberUserID: "usr_01ABC",
  cancelAtPeriodEnd: false,
  renewalPending: false,
  access: {
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    meters: {
      fiveHour: {
        startsAt: "2026-09-19T10:00:00.000Z",
        resetsAt: "2026-09-19T15:00:00.000Z",
        limitMicroCents: "1200000000",
        usedMicroCents: "744000000",
      },
      week: {
        startsAt: "2026-09-14T00:00:00.000Z",
        resetsAt: "2026-09-21T00:00:00.000Z",
        limitMicroCents: 8000000000,
        usedMicroCents: 2480000000,
      },
      month: { limitMicroCents: "20000000000", usedMicroCents: "8800000000" },
    },
  },
};

test("parseGoStatus maps the three console windows", () => {
  const meters = parseGoStatus(FIXTURE);
  expect(meters.map((m) => m.kind)).toEqual(["five_hour", "calendar_week", "product_period"]);
  const [five, week, month] = meters;
  expect(five.percent).toBe(62);
  expect(five.resetsAt).toBe("2026-09-19T15:00:00.000Z");
  // Numeric and string micro-cent encodings both count.
  expect(week.percent).toBe(31);
  // Each window keeps its own reset when it has one (~/meters.week.resetsAt).
  expect(week.resetsAt).toBe("2026-09-21T00:00:00.000Z");
  expect(month.percent).toBe(44);
  // The month meter has no window: the console shows the paid period end.
  expect(month.resetsAt).toBe("2026-10-01T00:00:00.000Z");
});

test("parseGoStatus leaves the month reset null without a period end", () => {
  const meters = parseGoStatus({
    access: {
      meters: { month: { limitMicroCents: "20000000000", usedMicroCents: "8800000000" } },
    },
  });
  expect(meters).toEqual([{ kind: "product_period", percent: 44, resetsAt: null }]);
});

test("parseGoStatus always lands on a finite percentage", () => {
  const meters = parseGoStatus({
    access: { meters: { fiveHour: { limitMicroCents: "0", usedMicroCents: "500" } } },
  });
  expect(meters).toHaveLength(1);
  expect(meters[0].percent).toBe(0);
  expect(Number.isFinite(meters[0].percent)).toBe(true);
  expect(meters[0].resetsAt).toBeNull();
});

test("parseGoStatus reports nothing for payloads without meter windows", () => {
  expect(parseGoStatus(null)).toEqual([]);
  expect(parseGoStatus({})).toEqual([]);
  expect(parseGoStatus({ access: {} })).toEqual([]);
  expect(parseGoStatus({ access: { meters: { fiveHour: { unlimited: true } } } })).toEqual([]);
});

test("fetchUsage asks the console API for this workspace and parses the answer", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const meters = await fetchUsage("wrk_01TEST", "Fe26.2**opaque");
    expect(calls[0].url).toBe("https://opencode.ai/console/api/go/status");
    expect(calls[0].headers["x-org-id"]).toBe("wrk_01TEST");
    expect(calls[0].headers.Cookie).toBe("__Host-console_session=Fe26.2**opaque");
    expect(meters.map((m) => m.percent)).toEqual([62, 31, 44]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchUsage surfaces an expired session and an unsubscribed workspace", async () => {
  const realFetch = globalThis.fetch;
  const respond = (body: string | null, status = 200) => {
    globalThis.fetch = (async () =>
      new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  };
  try {
    respond(JSON.stringify({ _tag: "Unauthorized" }), 401);
    await expect(fetchUsage("wrk_01TEST", "stale")).rejects.toMatchObject({ kind: "unauthorized" });
    respond("null");
    await expect(fetchUsage("wrk_01TEST", "fresh")).rejects.toMatchObject({ kind: "noSubscription" });
    respond(JSON.stringify({ access: {} }));
    await expect(fetchUsage("wrk_01TEST", "fresh")).rejects.toMatchObject({ kind: "noPayload" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("countdown formats", () => {
  const now = Date.parse("2026-08-16T00:00:00Z");
  expect(countdown(new Date(now + 1_200_000).toISOString(), now)).toBe("20m");
  expect(countdown(new Date(now + 4_320_000).toISOString(), now)).toBe("1h 12m");
  expect(countdown(new Date(now + 273_600_000).toISOString(), now)).toBe("3d 4h");
  expect(countdown(null, now)).toBeNull();
});

test("bar", () => {
  expect(bar(62, 10)).toBe("██████░░░░");
  expect(bar(0, 10)).toBe("░░░░░░░░░░");
  expect(bar(100, 10)).toBe("██████████");
  expect(bar(150, 10)).toBe("██████████");
});

function mockPi() {
  const handlers: Record<string, Array<(...a: unknown[]) => unknown>> = {};
  const state: { command?: { name: string; options: Record<string, unknown> } } = {};
  const pi = {
    on(event: string, fn: (...a: unknown[]) => unknown) {
      (handlers[event] ??= []).push(fn);
    },
    registerCommand(name: string, options: Record<string, unknown>) {
      state.command = { name, options };
    },
  };
  return { pi, handlers, state };
}

test("factory registers lifecycle handlers and the slash command", () => {
  const { pi, handlers, state } = mockPi();
  opencodeGoUsage(pi as never);
  expect(handlers["session_start"]?.length).toBe(1);
  expect(handlers["session_shutdown"]?.length).toBe(1);
  expect(state.command?.name).toBe("opencode-go");
});

test("command handler renders 'not connected' without credentials", async () => {
  delete process.env.OPENCODE_GO_WORKSPACE_ID;
  delete process.env.OPENCODE_GO_AUTH_COOKIE;
  const { pi, state } = mockPi();
  opencodeGoUsage(pi as never);
  const widgets: string[][] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (k: string, t: string | undefined) => statuses.push([k, t]),
      setWidget: (_k: string, c: string[] | undefined) => { if (c) widgets.push(c); },
      notify: () => { },
    },
  };
  await (state.command!.options.handler as (a: string, c: unknown) => Promise<void>)("", ctx);
  expect(widgets[0][0]).toBe("OpenCode Go Usage");
  expect(widgets[0].join("\n")).toContain("Not connected");
  expect(statuses[0][1]).toContain("not connected");
});

test("saving credentials warns while env vars shadow them", async () => {
  const { pi, state } = mockPi();
  opencodeGoUsage(pi as never);
  const notices: Array<[string, string | undefined]> = [];
  const ctx = {
    hasUI: true,
    ui: { setStatus: () => { }, setWidget: () => { }, notify: (m: string, t?: string) => notices.push([m, t]) },
  };
  const run = (args: string) =>
    (state.command!.options.handler as (a: string, c: unknown) => Promise<void>)(args, ctx);

  // Never let a test touch ~/.omp/agent/opencode-go-usage.json.
  const dir = await mkdtemp(join(tmpdir(), "opencode-go-usage-test-"));
  const configFile = join(dir, "opencode-go-usage.json");
  process.env.OPENCODE_GO_CONFIG_PATH = configFile;
  process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_env";
  process.env.OPENCODE_GO_AUTH_COOKIE = "env-cookie";
  try {
    await run("--cookie fresh-cookie");
    // The save landed in the scratch file…
    expect(JSON.parse(await readFile(configFile, "utf8")).authCookie).toBe("fresh-cookie");
    // …but the env value wins at read time, so the user is told.
    expect(notices.some(([m, t]) => t === "warning" && m.includes("OPENCODE_GO_AUTH_COOKIE"))).toBe(true);

    notices.length = 0;
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    process.env.OPENCODE_GO_AUTH_COOKIE = "fresh-cookie";
    await run("--cookie fresh-cookie");
    expect(notices.some(([, t]) => t === "warning")).toBe(false);
  } finally {
    delete process.env.OPENCODE_GO_CONFIG_PATH;
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
  }
});
