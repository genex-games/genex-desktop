/**
 * This Mac's apps as Launch Services knows them (`lsappinfo`): the app in front, and the app a
 * process belongs to, in milliseconds. The desktop driver's own app listing walks every installed
 * app and takes seconds, which every guarded click and keystroke would wait for. Where no window
 * the driver lists is under a point (the menu bar, an open menu), macOS's accessibility hit test
 * names the app a click there reaches.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import type { DesktopApp } from "./desktop-driver.ts";

/** How long one lookup may take. */
const LOOKUP_TIMEOUT_MS = 2 * SECOND_MS;
/** How many processes' apps are remembered: a pid names one process for its whole life. */
const MAX_REMEMBERED = 500;

/** A `"key"="value"` or `"pid"=N` line of `lsappinfo info -only …`. */
const FIELD = /^"([^"]+)"=(?:"([^"]*)"|(\d+))$/;
/**
 * The lines of the readable form macOS 27 answers with whatever `-only` asks (the app's name heading
 * its block, its bundle id, its pid), each read as the key of the `-only` form.
 */
const READABLE_FIELDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^"([^"]*)" ASN:/, "LSDisplayName"],
  [/^bundleID="([^"]*)"/, "CFBundleIdentifier"],
  [/^pid = (\d+)/, "pid"],
];

/** The app in an `lsappinfo info` answer, in either form; null when it names none. */
export function parseAppInfo(text: string): DesktopApp | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const match = FIELD.exec(trimmed);
    if (match?.[1]) fields.set(match[1], match[2] ?? match[3] ?? "");
    for (const [pattern, key] of READABLE_FIELDS) {
      const value = pattern.exec(trimmed)?.[1];
      if (value !== undefined) fields.set(key, value);
    }
  }
  const pid = Number(fields.get("pid"));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { name: fields.get("LSDisplayName") ?? "", bundleId: fields.get("CFBundleIdentifier") || null, pid };
}

/** Where a lookup's answer comes from: `lsappinfo` itself, or a test's stand-in. */
export type AppInfoRunner = (args: string[]) => Promise<string>;

const lsappinfo: AppInfoRunner = async (args) =>
  (await promisify(execFile)("lsappinfo", args, { timeout: LOOKUP_TIMEOUT_MS })).stdout;

/**
 * macOS's accessibility hit test, as JavaScript for Automation: the pid owning the element at a
 * screen point (in points from the main display's top left), or nothing. It runs in Genex's own
 * responsibility chain, under Genex's Accessibility grant.
 */
const HIT_TEST_SCRIPT = `ObjC.import("ApplicationServices");
function run(argv) {
  const element = Ref();
  const at = $.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), Number(argv[0]), Number(argv[1]), element);
  if (at !== 0) return "";
  const pid = Ref();
  return $.AXUIElementGetPid(element[0], pid) === 0 ? String(pid[0]) : "";
}`;

/** The pid in a hit test's answer; null when it names none. */
export function parseHitPid(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 0 ? pid : null;
}

/** Where a hit test's pid comes from: macOS itself, or a test's stand-in. */
export type HitTestRunner = (x: number, y: number) => Promise<number | null>;

const axHitTest: HitTestRunner = async (x, y) => {
  const args = ["-l", "JavaScript", "-e", HIT_TEST_SCRIPT, String(x), String(y)];
  return parseHitPid((await promisify(execFile)("/usr/bin/osascript", args, { timeout: LOOKUP_TIMEOUT_MS })).stdout);
};

/** This Mac's apps: the one in front, the one a process belongs to (remembered per pid), and the pid at a point. */
export function macApps(run: AppInfoRunner = lsappinfo, hitTest: HitTestRunner = axHitTest) {
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
    /** The pid macOS's hit test names at a screen point; null when it names none or cannot say. */
    pidAt: (x: number, y: number): Promise<number | null> => hitTest(x, y).catch(() => null),
  };
}

/** This Mac's app lookups. */
export type MacApps = ReturnType<typeof macApps>;
