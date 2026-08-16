import { expect, test } from "bun:test";
import { bar, countdown, parseWorkspaceHtml } from "../extensions/opencode-go-usage";

const FIXTURE = `
<html><body>
<script>rollingUsage:$R[12]={status:"ok",resetInSec:17400,usagePercent:42}</script>
<script>weeklyUsage={status:"ok",resetsInSeconds:277200,usagePercent:31}</script>
<script>monthlyUsage:$R[4]={status:"ok",resetInSec:1036800,usagePercent:44}</script>
</body></html>
`;

test("parseWorkspaceHtml extracts all three windows", () => {
  const now = Date.parse("2026-08-16T00:00:00Z");
  const meters = parseWorkspaceHtml(FIXTURE, now);
  expect(meters.map((m) => m.kind).sort()).toEqual([
    "calendar_week",
    "five_hour",
    "product_period",
  ]);
  const five = meters.find((m) => m.kind === "five_hour")!;
  expect(five.percent).toBe(42);
  expect(five.resetsAt).toBe(new Date(now + 17400 * 1000).toISOString());
  expect(five.status).toBe("ok");
});

test("parseWorkspaceHtml ignores prose containing window names", () => {
  const html = `<p>monthlyUsage is described in the help text</p>`;
  expect(parseWorkspaceHtml(html)).toEqual([]);
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

import opencodeGoUsage from "../extensions/opencode-go-usage";

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
      notify: () => {},
    },
  };
  await (state.command!.options.handler as (a: string, c: unknown) => Promise<void>)("", ctx);
  expect(widgets[0][0]).toBe("OpenCode Go Usage");
  expect(widgets[0].join("\n")).toContain("Not connected");
  expect(statuses[0][1]).toContain("not connected");
});
