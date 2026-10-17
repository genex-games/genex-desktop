/**
 * This Mac's apps as Launch Services knows them (`lsappinfo`): the app in front, and the app a
 * process belongs to, in milliseconds. The desktop driver's own app listing walks every installed
 * app and takes seconds, which every guarded click and keystroke would wait for.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import type { DesktopApp } from "./desktop-driver.ts";

/** How long one lookup may take. */
const LOOKUP_TIMEOUT_MS = 2 * SECOND_MS;
/** How many processes' apps are remembered: a pid names one process for its whole life. */
const MAX_REMEMBERED = 500;

/** A `"key"="value"` or `"pid"=N` line of `lsappinfo info`. */
const FIELD = /^"([^"]+)"=(?:"([^"]*)"|(\d+))$/;

/** The app in an `lsappinfo info` answer; null when it names none. */
export function parseAppInfo(text: string): DesktopApp | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = FIELD.exec(line.trim());
    if (match?.[1]) fields.set(match[1], match[2] ?? match[3] ?? "");
  }
  const pid = Number(fields.get("pid"));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { name: fields.get("LSDisplayName") ?? "", bundleId: fields.get("CFBundleIdentifier") || null, pid };
}

/** Where a lookup's answer comes from: `lsappinfo` itself, or a test's stand-in. */
export type AppInfoRunner = (args: string[]) => Promise<string>;

const lsappinfo: AppInfoRunner = async (args) =>
  (await promisify(execFile)("lsappinfo", args, { timeout: LOOKUP_TIMEOUT_MS })).stdout;

/** This Mac's apps: the one in front, and the one a process belongs to (remembered per pid). */
export function macApps(run: AppInfoRunner = lsappinfo) {
  const known = new Map<number, DesktopApp | null>();
  const info = async (who: string) =>
    parseAppInfo(await run(["info", "-only", "bundleid", "-only", "name", "-only", "pid", who]));
  return {
    front: async (): Promise<DesktopApp | null> => {
      const asn = (await run(["front"])).trim();
      return asn ? info(asn) : null;
    },
    byPid: async (pid: number): Promise<DesktopApp | null> => {
      if (known.has(pid)) return known.get(pid) ?? null;
      const app = await info(`pid:${pid}`);
      if (known.size >= MAX_REMEMBERED) known.delete(known.keys().next().value as number);
      known.set(pid, app);
      return app;
    },
  };
}

/** This Mac's app lookups. */
export type MacApps = ReturnType<typeof macApps>;
