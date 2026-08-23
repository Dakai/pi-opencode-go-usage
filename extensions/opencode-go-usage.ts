/**
 * OpenCode Go Usage Tracker (pi/omp extension)
 *
 * Shows OpenCode Go usage limits — rolling 5-hour, weekly, and monthly — in a
 * live status bar and a `/opencode-go` report widget.
 *
 * Core: opencode.ai publishes no usage API and serves no `/api/*`. The
 * `/workspace/<wrk_…>/go` screen is a SolidStart app that serialises the
 * resolved values into the delivered HTML:
 *
 *     rollingUsage:$R[12]={status:"ok",resetInSec:17400,usagePercent:42}
 *
 * So this extension fetches that page with your browser `auth` cookie and
 * reads the three percentages + reset times out of the markup. It reports
 * percentages and countdowns only — the page carries no dollar amounts.
 *
 * UI: mirrors pi-opencode-usage — a status bar after each refresh plus a
 * `/opencode-go` slash command with subcommands for setup and export.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type MeterKind = "five_hour" | "calendar_week" | "product_period";

interface UsageMeter {
 kind: MeterKind;
 /** 0-100, clamped. */
 percent: number;
 /** ISO timestamp of rollover, or null when the window is not open. */
 resetsAt: string | null;
 status: "ok" | "error" | "unknown";
}

interface Config {
 workspaceId?: string;
 authCookie?: string;
}

type FetchFailure =
 | { kind: "noCredentials" }
 | { kind: "timeout" }
 | { kind: "network"; detail: string }
 | { kind: "unauthorized" }
 | { kind: "http"; status: number }
 | { kind: "noPayload"; sawLogin: boolean };

const WINDOW_KEYS: { key: string; kind: MeterKind }[] = [
 { key: "rollingUsage", kind: "five_hour" },
 { key: "weeklyUsage", kind: "calendar_week" },
 { key: "monthlyUsage", kind: "product_period" },
];

const METER_LABEL: Record<MeterKind, string> = {
 five_hour: "Rolling 5h",
 calendar_week: "Weekly",
 product_period: "Monthly",
};

const METER_SHORT: Record<MeterKind, string> = {
 five_hour: "5h",
 calendar_week: "wk",
 product_period: "mo",
};

const CONFIG_PATH = join(homedir(), ".omp", "agent", "opencode-go-usage.json");
const DEFAULT_ORIGIN = "https://opencode.ai";
const REFRESH_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
 "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Config persistence (0600 file; cookie is a credential)
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<Config> {
 try {
  return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as Config;
 } catch {
  return {};
 }
}

async function saveConfig(config: Config): Promise<void> {
 const tmp = `${CONFIG_PATH}.tmp`;
 await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
 await fs.rename(tmp, CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// Fetch + parse (ported from otoneko1102.opencode-go-usage-checker src/workspace.ts)
// ---------------------------------------------------------------------------

function workspaceUrl(workspaceId: string, origin = DEFAULT_ORIGIN): string {
 return `${origin.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/go`;
}

function cookieHeader(authCookie: string): string {
 const trimmed = authCookie.trim().replace(/;$/, "");
 return /^auth=/.test(trimmed) ? trimmed : `auth=${trimmed}`;
}

function scriptBodies(html: string): string {
 const bodies: string[] = [];
 for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
  bodies.push(m[1]);
 }
 return bodies.join("\n");
}

function findObjectBody(html: string, key: string): string | null {
 const pattern = new RegExp(`${key}\\s*(?::\\s*\\$R\\[\\d+\\]\\s*)?=\\s*\\{([^{}]*)\\}`);
 return pattern.exec(html)?.[1] ?? null;
}

function readNumber(body: string, field: string): number | null {
 const m = new RegExp(`${field}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(body);
 if (!m) return null;
 const v = Number(m[1]);
 return Number.isFinite(v) ? v : null;
}

function readStatus(body: string): UsageMeter["status"] {
 const v = /status\s*:\s*"([^"]*)"/.exec(body)?.[1];
 return v === "ok" || v === "error" ? v : "unknown";
}

export function parseWorkspaceHtml(html: string, now = Date.now()): UsageMeter[] {
 const meters: UsageMeter[] = [];
 const haystack = scriptBodies(html) || html;
 for (const { key, kind } of WINDOW_KEYS) {
  const body = findObjectBody(haystack, key);
  if (body === null) continue;
  const percent = readNumber(body, "usagePercent");
  if (percent === null) continue;
  const resetInSec = readNumber(body, "resetInSec") ?? readNumber(body, "resetsInSeconds");
  meters.push({
   kind,
   percent: Math.min(100, Math.max(0, percent)),
   resetsAt:
    resetInSec !== null && resetInSec > 0
     ? new Date(now + resetInSec * 1000).toISOString()
     : null,
   status: readStatus(body),
  });
 }
 return meters;
}

export async function fetchUsage(
 workspaceId: string,
 authCookie: string,
 origin = DEFAULT_ORIGIN,
): Promise<UsageMeter[]> {
 if (!workspaceId.trim() || !authCookie.trim()) {
  throw { kind: "noCredentials" } as FetchFailure;
 }
 const url = workspaceUrl(workspaceId.trim(), origin);
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
 let response: Response;
 try {
  response = await fetch(url, {
   headers: {
    Cookie: cookieHeader(authCookie),
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml",
   },
   signal: controller.signal,
   redirect: "manual",
  });
 } catch (err) {
  if (err instanceof Error && err.name === "AbortError") {
   throw { kind: "timeout" } as FetchFailure;
  }
  throw {
   kind: "network",
   detail: err instanceof Error ? err.message : String(err),
  } as FetchFailure;
 } finally {
  clearTimeout(timer);
 }
 if (response.status >= 300 && response.status < 400) {
  const location = response.headers.get("location") ?? "";
  if (/auth|login|sign-?in/i.test(location)) throw { kind: "unauthorized" } as FetchFailure;
  throw { kind: "http", status: response.status } as FetchFailure;
 }
 if (response.status === 401 || response.status === 403) {
  throw { kind: "unauthorized" } as FetchFailure;
 }
 if (!response.ok) throw { kind: "http", status: response.status } as FetchFailure;
 const html = await response.text();
 const meters = parseWorkspaceHtml(html);
 if (meters.length === 0) {
  const sawLogin = /\/auth\/authorize|sign\s?in to opencode/i.test(html);
  throw { kind: "noPayload", sawLogin } as FetchFailure;
 }
 return meters;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function bar(percent: number, width = 10): string {
 const clamped = Math.min(100, Math.max(0, percent));
 const filled = Math.round((clamped / 100) * width);
 return "█".repeat(filled) + "░".repeat(width - filled);
}

export function countdown(resetsAt: string | null, now = Date.now()): string | null {
 if (!resetsAt) return null;
 const target = Date.parse(resetsAt);
 if (!Number.isFinite(target)) return null;
 const ms = target - now;
 if (ms <= 0) return "resets now";
 const totalMinutes = Math.floor(ms / 60_000);
 const days = Math.floor(totalMinutes / (60 * 24));
 const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
 const minutes = totalMinutes % 60;
 if (days > 0) return `${days}d ${hours}h`;
 if (hours > 0) return `${hours}h ${minutes}m`;
 return `${minutes}m`;
}

function describeFailure(f: FetchFailure): string {
 switch (f.kind) {
  case "noCredentials":
   return "Not connected. Run /opencode-go --connect <wrk_…> <auth-cookie>";
  case "timeout":
   return "Request timed out";
  case "network":
   return `Network error: ${f.detail}`;
  case "unauthorized":
   return "Cookie expired — reconnect with a fresh auth cookie";
  case "http":
   return `HTTP ${f.status}`;
  case "noPayload":
   return f.sawLogin
    ? "Cookie expired (login page served)"
    : "Page carried no usage data — opencode.ai markup may have changed";
 }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

interface UiCtx {
 hasUI: boolean;
 ui: {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
 };
}

export default function opencodeGoUsage(pi: ExtensionAPI): void {
 let config: Config = {};
 let meters: UsageMeter[] = [];
 let lastError: string | null = null;
 let lastFetchedAt = 0;
 let timer: ReturnType<typeof setInterval> | undefined;

 const resolvedCreds = (): { workspaceId: string; authCookie: string } | null => {
  const workspaceId = (process.env.OPENCODE_GO_WORKSPACE_ID ?? config.workspaceId ?? "").trim();
  const authCookie = (process.env.OPENCODE_GO_AUTH_COOKIE ?? config.authCookie ?? "").trim();
  return workspaceId && authCookie ? { workspaceId, authCookie } : null;
 };

 const fmtUpdate = (ts: number): string => {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  let tz: string;
  try {
   tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
  } catch {
   tz = "local";
  }
  return `update ${time} (${tz})`;
 };

 const renderStatus = (ctx: UiCtx): void => {
  if (!ctx.hasUI) return;
  const creds = resolvedCreds();
  if (!creds) {
   ctx.ui.setStatus("opencode-go", "OpenCode Go: not connected (/opencode-go --connect)");
   return;
  }
  if (lastError) {
   ctx.ui.setStatus("opencode-go", `OpenCode Go: ${lastError}`);
   return;
  }
  if (meters.length === 0) {
   ctx.ui.setStatus("opencode-go", "OpenCode Go: loading…");
   return;
  }
  const parts = meters.map((m) => {
   const cd = countdown(m.resetsAt);
   return `${METER_SHORT[m.kind]} ${m.percent}%${cd ? ` (${cd})` : ""}`;
  });
  let text = `OpenCode Go: ${parts.join(" · ")}`;
  if (lastFetchedAt) text += ` · ${fmtUpdate(lastFetchedAt)}`;
  ctx.ui.setStatus("opencode-go", text);
 };

 const renderReport = (ctx: UiCtx): void => {
  if (!ctx.hasUI) return;
  const creds = resolvedCreds();
  const lines: string[] = ["OpenCode Go Usage"];
  if (!creds) {
   lines.push("Not connected.");
   lines.push("Run /opencode-go --connect <wrk_…> <auth-cookie>");
   lines.push("Or set OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE");
   ctx.ui.setWidget("opencode-go", lines, { placement: "aboveEditor" });
   return;
  }
  lines.push(`Workspace: ${creds.workspaceId}`);
  if (lastError) {
   lines.push(`Error: ${lastError}`);
  } else if (meters.length === 0) {
   lines.push("Loading…");
  } else {
   for (const m of meters) {
    const cd = countdown(m.resetsAt);
    lines.push(`${METER_LABEL[m.kind].padEnd(10)} ${bar(m.percent, 10)}  ${m.percent}%${cd ? ` · ${cd}` : ""}`);
   }
  }
  if (lastFetchedAt) lines.push(fmtUpdate(lastFetchedAt));
  ctx.ui.setWidget("opencode-go", lines, { placement: "aboveEditor" });
 };

 const refresh = async (ctx: UiCtx): Promise<void> => {
  const creds = resolvedCreds();
  if (!creds) {
   meters = [];
   lastError = null;
   renderStatus(ctx);
   return;
  }
  try {
   meters = await fetchUsage(creds.workspaceId, creds.authCookie, DEFAULT_ORIGIN);
   lastError = null;
   lastFetchedAt = Date.now();
  } catch (err) {
   meters = [];
   lastError = describeFailure(err as FetchFailure);
  }
  renderStatus(ctx);
 };

 pi.on("session_start", async (_event, ctx) => {
  config = await loadConfig();
  if (timer) {
   clearInterval(timer);
   timer = undefined;
  }
  if (ctx.hasUI && resolvedCreds()) ctx.ui.notify("OpenCode Go usage tracker loaded", "info");
  // Fire-and-forget: don't block session startup on a network round-trip.
  void refresh(ctx);
  // Plain setInterval with the callback body fully wrapped so a throw cannot
  // escape and tear down the session.
  timer = setInterval(() => {
   void refresh(ctx).catch(() => { });
  }, REFRESH_SECONDS * 1000);
 });

 pi.on("session_shutdown", () => {
  if (timer) {
   clearInterval(timer);
   timer = undefined;
  }
 });

 pi.registerCommand("opencode-go", {
  description:
   "Show OpenCode Go usage. Subcommands: --connect <wrk> <cookie> | --workspace <id> | --cookie <v> | --disconnect | --refresh | --json",
  handler: async (args, ctx) => {
   const tokens = args.trim().split(/\s+/).filter(Boolean);
   const sub = tokens[0];
   const rest = tokens.slice(1);

   if (sub === "--connect" || sub === "--setup") {
    const workspaceId = rest[0];
    const cookie = rest.slice(1).join(" ");
    if (!workspaceId || !cookie) {
     ctx.ui.notify("Usage: /opencode-go --connect <wrk_…> <auth-cookie>", "warning");
     return;
    }
    config.workspaceId = workspaceId.trim();
    config.authCookie = cookie.trim();
    await saveConfig(config);
    ctx.ui.notify("Saved. Fetching usage…", "info");
    await refresh(ctx);
    renderReport(ctx);
    return;
   }

   if (sub === "--workspace") {
    if (!rest[0]) {
     ctx.ui.notify("Usage: /opencode-go --workspace <wrk_…>", "warning");
     return;
    }
    config.workspaceId = rest[0].trim();
    await saveConfig(config);
    ctx.ui.notify(`Workspace set to ${config.workspaceId}`, "info");
    return;
   }

   if (sub === "--cookie") {
    const cookie = rest.join(" ");
    if (!cookie) {
     ctx.ui.notify("Usage: /opencode-go --cookie <auth-cookie>", "warning");
     return;
    }
    config.authCookie = cookie.trim();
    await saveConfig(config);
    ctx.ui.notify("Cookie saved", "info");
    return;
   }

   if (sub === "--disconnect") {
    delete config.workspaceId;
    delete config.authCookie;
    await saveConfig(config);
    meters = [];
    lastError = null;
    renderStatus(ctx);
    ctx.ui.setWidget("opencode-go", undefined);
    ctx.ui.notify("Disconnected", "info");
    return;
   }

   if (sub === "--refresh") {
    await refresh(ctx);
    renderReport(ctx);
    return;
   }

   if (sub === "--json") {
    await refresh(ctx);
    const report = {
     workspaceId: resolvedCreds()?.workspaceId ?? null,
     fetchedAt: lastFetchedAt ? new Date(lastFetchedAt).toISOString() : null,
     error: lastError,
     meters,
    };
    const outPath = join(homedir(), ".omp", "agent", "opencode-go-usage-report.json");
    try {
     const tmp = `${outPath}.tmp`;
     await fs.writeFile(tmp, JSON.stringify(report, null, 2), "utf8");
     await fs.rename(tmp, outPath);
     ctx.ui.notify(`JSON report written to ${outPath}`, "info");
    } catch {
     ctx.ui.notify("Failed to write JSON report", "error");
    }
    return;
   }

   await refresh(ctx);
   renderReport(ctx);
  },
 });
}
