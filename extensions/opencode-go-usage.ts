/**
 * OpenCode Go Usage Tracker (pi/omp extension)
 *
 * Shows OpenCode Go usage limits — rolling 5-hour, weekly, and monthly — in a
 * live status bar and a `/opencode-go` report widget.
 *
 * Core: the `/console/<wrk_…>/go` screen is a client-side app, so the HTML
 * carries no numbers. It loads them from the console JSON API:
 *
 *     GET /console/api/go/status           (x-org-id: wrk_…)
 *     -> { access: { meters: {
 *            fiveHour: {resetsAt, limitMicroCents, usedMicroCents},
 *            week:     {resetsAt, limitMicroCents, usedMicroCents},
 *            month:    {limitMicroCents, usedMicroCents} } } }
 *
 * So this extension calls that endpoint with your browser session cookie and
 * derives the three percentages (used/limit; micro-cents are 1e-8 dollars)
 * plus reset countdowns. It reports percentages and countdowns only.
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
}

interface Config {
 workspaceId?: string;
 authCookie?: string;
 compact?: boolean;
}

type FetchFailure =
 | { kind: "noCredentials" }
 | { kind: "timeout" }
 | { kind: "network"; detail: string }
 | { kind: "unauthorized" }
 | { kind: "http"; status: number }
 | { kind: "noSubscription" }
 | { kind: "noPayload" };

const WINDOW_KEYS: { key: string; kind: MeterKind }[] = [
 { key: "fiveHour", kind: "five_hour" },
 { key: "week", kind: "calendar_week" },
 { key: "month", kind: "product_period" },
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

const DEFAULT_ORIGIN = "https://opencode.ai";
/** Console session cookie; browsers on https use the `__Host-` prefixed name. */
const DEFAULT_COOKIE_NAME = "__Host-console_session";
const REFRESH_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
 "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Config persistence (0600 file; cookie is a credential)
// ---------------------------------------------------------------------------

/** Resolved per call so tests can redirect it away from the real home. */
function configPath(): string {
 return (
  process.env.OPENCODE_GO_CONFIG_PATH ?? join(homedir(), ".omp", "agent", "opencode-go-usage.json")
 );
}

async function loadConfig(): Promise<Config> {
 const path = configPath();
 try {
  return JSON.parse(await fs.readFile(path, "utf8")) as Config;
 } catch {
  return {};
 }
}

async function saveConfig(config: Config): Promise<void> {
 const path = configPath();
 const tmp = `${path}.tmp`;
 await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
 await fs.rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Fetch + parse (console JSON API)
// ---------------------------------------------------------------------------

function cookieHeader(authCookie: string): string {
 const trimmed = authCookie.trim().replace(/;$/, "");
 return trimmed.includes("=") ? trimmed : `${DEFAULT_COOKIE_NAME}=${trimmed}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
 return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Money fields arrive as JSON strings (the server models them as bigint). */
function toNumber(value: unknown): number | null {
 if (typeof value === "number") return Number.isFinite(value) ? value : null;
 if (typeof value === "string" && value.trim() !== "") {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
 }
 return null;
}

/**
 * Reads `access.meters` out of a `/console/api/go/status` payload. Returns an
 * empty array when the payload carries no meter windows — the caller reports
 * that as a changed API rather than as a confident zero.
 */
export function parseGoStatus(payload: unknown): UsageMeter[] {
 const meters = asRecord(asRecord(asRecord(payload)?.access)?.meters);
 if (!meters) return [];
 const result: UsageMeter[] = [];
 for (const { key, kind } of WINDOW_KEYS) {
  const window = asRecord(meters[key]);
  if (!window) continue;
  const used = toNumber(window.usedMicroCents);
  const limit = toNumber(window.limitMicroCents);
  if (used === null || limit === null) continue;
  // used share of the window limit, clamped to 0-100 and rounded to 0.1
  const percent = limit > 0 ? Math.round(Math.min(100, Math.max(0, (used / limit) * 100)) * 10) / 10 : 0;
  const resetsAtMs = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN;
  result.push({
   kind,
   percent,
   resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null,
  });
 }
 return result;
}

export async function fetchUsage(
 workspaceId: string,
 authCookie: string,
 origin = DEFAULT_ORIGIN,
): Promise<UsageMeter[]> {
 if (!workspaceId.trim() || !authCookie.trim()) {
  throw { kind: "noCredentials" } as FetchFailure;
 }
 const url = `${origin.replace(/\/+$/, "")}/console/api/go/status`;
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
 let response: Response;
 try {
  response = await fetch(url, {
   headers: {
    Cookie: cookieHeader(authCookie),
    // The console scopes every request to a workspace with this header.
    "x-org-id": workspaceId.trim(),
    "User-Agent": USER_AGENT,
    Accept: "application/json",
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
 const payload: unknown = await response.json().catch(() => undefined);
 if (payload === undefined || payload === null) {
  // A null body is the console's "no Go subscription here" answer.
  if (payload === null) throw { kind: "noSubscription" } as FetchFailure;
  throw { kind: "noPayload" } as FetchFailure;
 }
 if (asRecord(asRecord(payload)?.access) === null) {
  throw { kind: "noSubscription" } as FetchFailure;
 }
 const meters = parseGoStatus(payload);
 if (meters.length === 0) throw { kind: "noPayload" } as FetchFailure;
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
   return "Not connected. Run /opencode-go --connect <wrk_…> <console-cookie>";
  case "timeout":
   return "Request timed out";
  case "network":
   return `Network error: ${f.detail}`;
  case "unauthorized":
   return "Session expired — reconnect with a fresh console cookie";
  case "http":
   return `HTTP ${f.status}`;
  case "noSubscription":
   return "No Go subscription on this workspace";
  case "noPayload":
   return "Console API response unrecognised — opencode.ai may have changed its API";
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

 // Env credentials win over the saved ones, so a --connect/--disconnect can
 // silently do nothing while OPENCODE_GO_* is set. Surface that instead.
 const envOverrideWarning = (): string | null => {
  const envWorkspace = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const envCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  const overrides =
   (envWorkspace !== undefined && envWorkspace !== config.workspaceId) ||
   (envCookie !== undefined && envCookie !== config.authCookie);
  return overrides
   ? "OPENCODE_GO_WORKSPACE_ID / OPENCODE_GO_AUTH_COOKIE are set and take precedence over saved values — update or unset them"
   : null;
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
   if (config.compact) return `${METER_SHORT[m.kind]} ${m.percent}%`;
   const cd = countdown(m.resetsAt);
   return `${METER_SHORT[m.kind]} ${m.percent}%${cd ? ` (${cd})` : ""}`;
  });
  let text = `OpenCode Go: ${parts.join(" · ")}`;
  if (!config.compact && lastFetchedAt) text += ` · ${fmtUpdate(lastFetchedAt)}`;
  ctx.ui.setStatus("opencode-go", text);
 };

 const renderReport = (ctx: UiCtx): void => {
  if (!ctx.hasUI) return;
  const creds = resolvedCreds();
  const lines: string[] = ["OpenCode Go Usage"];
  if (!creds) {
   lines.push("Not connected.");
   lines.push("Run /opencode-go --connect <wrk_…> <console-cookie>");
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
   "Show OpenCode Go usage. Subcommands: --connect <wrk> <cookie> | --workspace <id> | --cookie <v> | --disconnect | --refresh | --compact [on|off] | --json",
  handler: async (args, ctx) => {
   const tokens = args.trim().split(/\s+/).filter(Boolean);
   const sub = tokens[0];
   const rest = tokens.slice(1);

   if (sub === "--connect" || sub === "--setup") {
    const workspaceId = rest[0];
    const cookie = rest.slice(1).join(" ");
    if (!workspaceId || !cookie) {
     ctx.ui.notify("Usage: /opencode-go --connect <wrk_…> <console-cookie>", "warning");
     return;
    }
    config.workspaceId = workspaceId.trim();
    config.authCookie = cookie.trim();
    await saveConfig(config);
    const envWarning = envOverrideWarning();
    if (envWarning) ctx.ui.notify(envWarning, "warning");
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
    const envWarning = envOverrideWarning();
    if (envWarning) ctx.ui.notify(envWarning, "warning");
    ctx.ui.notify(`Workspace set to ${config.workspaceId}`, "info");
    return;
   }

   if (sub === "--cookie") {
    const cookie = rest.join(" ");
    if (!cookie) {
     ctx.ui.notify("Usage: /opencode-go --cookie <console-cookie>", "warning");
     return;
    }
    config.authCookie = cookie.trim();
    await saveConfig(config);
    const envWarning = envOverrideWarning();
    if (envWarning) ctx.ui.notify(envWarning, "warning");
    ctx.ui.notify("Cookie saved", "info");
    return;
   }

   if (sub === "--disconnect") {
    const envWarning = envOverrideWarning();
    delete config.workspaceId;
    delete config.authCookie;
    await saveConfig(config);
    meters = [];
    lastError = null;
    renderStatus(ctx);
    ctx.ui.setWidget("opencode-go", undefined);
    if (envWarning) ctx.ui.notify(envWarning, "warning");
    ctx.ui.notify("Disconnected", "info");
   }

   if (sub === "--compact") {
    const arg = rest[0];
    config.compact = arg ? arg !== "off" && arg !== "false" : !config.compact;
    await saveConfig(config);
    renderStatus(ctx);
    ctx.ui.notify(`Compact mode ${config.compact ? "on" : "off"}`, "info");
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
