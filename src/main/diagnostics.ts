/**
 * Settings → "Copy diagnostics": one plain-text report a user can paste into a bug report. It names
 * the app, runtime and OS versions, where the studio keeps its data, each provider's status (with
 * its coding CLI), and the newest lines of `studio.log`. The whole text goes through the log's
 * scrubber, so no credential, email address or home folder leaves the Mac in it.
 */
import type { EngineDescriptor } from "../shared/engine-descriptor.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { settleWithin } from "./app-lifecycle.ts";
import { scrubForLog } from "./logs.ts";

/** How many log lines the report carries. */
export const DIAGNOSTICS_LOG_LINES = 100;
/** A provider check that takes longer than this is reported as unavailable. */
export const DIAGNOSTICS_ENGINE_TIMEOUT_MS = 5_000;

type EngineSummary = Pick<EngineDescriptor, "id" | "label" | "status"> & { account?: EngineDescriptor["account"] };

export interface DiagnosticsSources {
  app: { name: string; version: string; packaged: boolean };
  versions: { electron?: string; chrome?: string; node?: string };
  os: { platform: string; arch: string; release: string };
  paths: { userData: string; gamesRoot: string; log: string };
  home: string;
  performance?: unknown;
  /** The harness calls the host is servicing now, oldest first (`HarnessHost.pendingRpcs`). */
  harnessCalls?: Array<{ method: string; ageMs: number }>;
  engines(): Promise<EngineSummary[]>;
  logTail(count: number): string[];
}

export interface Diagnostics extends Omit<DiagnosticsSources, "engines" | "logTail"> {
  /** `null` when the check failed or did not answer in time. */
  engines: EngineSummary[] | null;
  logTail: string[];
}

export async function gatherDiagnostics(
  sources: DiagnosticsSources,
  { timeoutMs = DIAGNOSTICS_ENGINE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Diagnostics> {
  const { engines, logTail, ...rest } = sources;
  let tail: string[] = [];
  try {
    tail = logTail(DIAGNOSTICS_LOG_LINES);
  } catch {
    /* an unreadable log still leaves the rest */
  }
  return { ...rest, engines: await settleWithin(Promise.resolve().then(engines), timeoutMs, null), logTail: tail };
}

function engineLine({ label, status, account }: EngineSummary): string {
  const parts = [`${label}: ${status.code}${status.detail ? ` (${status.detail})` : ""}`];
  if (account?.cli) parts.push(`CLI ${account.cli.state}${account.cli.version ? ` ${account.cli.version}` : ""}`);
  if (account?.source) parts.push(`login ${account.source}`);
  return parts.join("; ");
}

/** What the harness is waiting on the host for: a call that has run for minutes is where a run stalls. */
function harnessCallLines(calls: Array<{ method: string; ageMs: number }>): string[] {
  const lines = calls.map((call) => `  ${call.method} for ${Math.round(call.ageMs / SECOND_MS)} s`);
  return ["Harness calls in flight", ...(lines.length ? lines : ["  none"]), ""];
}

export function diagnosticsText(report: Diagnostics): string {
  const { app, versions, os, paths } = report;
  const lines = [
    `${app.name} ${app.version} (${app.packaged ? "packaged" : "development"})`,
    `Electron ${versions.electron ?? "?"}, Chrome ${versions.chrome ?? "?"}, Node ${versions.node ?? "?"}`,
    `${os.platform} ${os.release} ${os.arch}`,
    "",
    "Paths",
    `  Data: ${paths.userData}`,
    `  Games: ${paths.gamesRoot}`,
    `  Log: ${paths.log}`,
    "",
    ...(report.performance ? ["Performance", JSON.stringify(report.performance), ""] : []),
    "Providers",
    ...(report.engines ? report.engines.map((engine) => `  ${engineLine(engine)}`) : ["  unavailable"]),
    "",
    ...(report.harnessCalls ? harnessCallLines(report.harnessCalls) : []),
    `Recent log (${report.logTail.length} lines)`,
    ...report.logTail.map((line) => `  ${line}`),
  ];
  return scrubForLog(lines.join("\n"), report.home);
}
