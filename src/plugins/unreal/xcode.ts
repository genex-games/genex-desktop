/**
 * Xcode for Unreal on a Mac. It is recommended to every Mac user of the Unreal plugin: without it
 * Genex works in Blueprints only, since Unreal builds C++ with Xcode. Each status asks where Xcode
 * stands, so the panel notices an install, a first launch or a new selection by itself.
 *
 * Every probe is a file read or a program by its full path with an argument array, never a shell,
 * never sudo, and none of them prompts: `xcode-select -p` only prints the selected folder, and
 * Xcode's own `xcodebuild`, pointed at that Xcode by DEVELOPER_DIR, only reports whether its first
 * launch and licence are done. Apple's `/usr/bin` stubs, which can offer to install the Command
 * Line Tools, are never run. The Xcode versions an engine builds with come from its own
 * `Engine/Config/Apple/Apple_SDK.json`.
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import type { Launch } from "./editor-launch.ts";

/** Where Xcode stands for Unreal on this computer. Wire values: the panel reads them. */
export const XcodeState = {
  /** Not a Mac: Unreal builds without Xcode there. */
  NotApplicable: "not-applicable",
  /** No Xcode app; Apple's Command Line Tools may be there (`commandLineTools`). */
  Missing: "missing",
  /** Xcode is installed, but the selected developer folder is another one; the fix is `command`. */
  NotSelected: "not-selected",
  /** Xcode's first launch or its licence is still to do: opening Xcode once does both. */
  FirstLaunch: "first-launch",
  /** Xcode's version is outside the range the engine builds with. */
  Unsupported: "unsupported",
  Ready: "ready",
} as const;
export type XcodeState = (typeof XcodeState)[keyof typeof XcodeState];

/** The Xcode versions an engine builds with, both inclusive. */
export type XcodeRange = { min: string; max: string };

/** Where Xcode stands, as status hands it to the panel. */
export type XcodeStatus = {
  state: XcodeState;
  /** The Xcode app Genex judged: the selected one, else the first in Applications; null without one. */
  app: string | null;
  /** That app's version as its Info.plist names it ("26.2"); null without one. */
  version: string | null;
  /** Whether Apple's Command Line Tools are installed. */
  commandLineTools: boolean;
  /** The engine's range as the panel says it ("15.2" to "27.9"); null without a supported engine. */
  supported: XcodeRange | null;
  /**
   * Unsupported because it is newer than the engine builds with: the App Store offers only the
   * newest Xcode, so the fix is an older one from Apple's developer downloads beside it. Absent
   * means not too new.
   */
  tooNew?: boolean;
  /** NotSelected's fix: the one command the user runs in Terminal, which asks for their password. */
  command: string | null;
};

/** What the probes found; the state follows from these alone. */
export type XcodeFacts = {
  platform: NodeJS.Platform;
  /** The developer folder `xcode-select -p` names while it is there; null when none is. */
  selected: string | null;
  /** The Xcode app judged, from {@link chooseXcodeApp}. */
  app: string | null;
  version: string | null;
  firstLaunchDone: boolean;
  licenseAccepted: boolean;
  commandLineTools: boolean;
  range: XcodeRange | null;
};

/** Each question Genex asks the computer about Xcode; tests stand in for the computer. */
export type XcodeProbes = {
  selected: () => Promise<string | null>;
  /** The Xcode apps in Applications, by full path, Xcode.app first. */
  apps: () => Promise<string[]>;
  version: (app: string) => Promise<string | null>;
  firstLaunchDone: (app: string) => Promise<boolean>;
  licenseAccepted: (app: string) => Promise<boolean>;
  commandLineTools: () => Promise<boolean>;
  range: (engineDirectory: string) => Promise<XcodeRange | null>;
};

/** Runs a program to its end with execFile's options; tests record instead. */
export type XcodeRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

/** Where a Mac keeps its apps and Apple's Command Line Tools; tests hand in a fake Mac's. */
export type XcodeFolders = { applications: string; commandLineTools: string };

const SYSTEM_FOLDERS: XcodeFolders = {
  applications: "/Applications",
  commandLineTools: "/Library/Developer/CommandLineTools",
};
const XCODE_SELECT = "/usr/bin/xcode-select";
const MAC_OPEN = "/usr/bin/open";
/**
 * Apple's developer downloads, searched for Xcode: where an older Xcode comes from when the
 * installed one is too new for the engine (the App Store offers only the newest). The person signs
 * in there themselves; Genex only opens the page.
 */
const XCODE_DOWNLOADS_URL = "https://developer.apple.com/download/all/?q=Xcode";
const PLUTIL = "/usr/bin/plutil";
const XCODE_APP = "Xcode.app";
/** Xcode.app and its betas and side-by-side copies: Xcode-beta.app, Xcode_15.4.app. */
const XCODE_APP_NAME = /^Xcode[^/]*\.app$/i;
/** An app's developer folder, as `xcode-select -p` names it. */
const DEVELOPER_FOLDER = /^(.+\.app)\/Contents\/Developer\/?$/;
const VERSION = /^\d+(\.\d+)*$/;
/** Characters a path may hold and still be pasted into Terminal as it is. */
const PLAIN_ARGUMENT = /^[\w./-]+$/;
/** Each probe returns at once; a hung one must not hold the panel's status. */
const COMMAND_TIMEOUT_MS = 5 * SECOND_MS;
/** Apple_SDK.json is a couple of kilobytes. */
const APPLE_SDK_MAX_BYTES = 64 * 1024;

const run: XcodeRunner = promisify(execFile);

const developerFolder = (app: string) => path.join(app, "Contents", "Developer");

/** The Xcode app whose developer folder `xcode-select -p` names; null for the Command Line Tools or none. */
export function selectedXcodeApp(selected: string | null): string | null {
  return DEVELOPER_FOLDER.exec(selected ?? "")?.[1] ?? null;
}

/** The Xcode Unreal would build with: the selected one, else the first in Applications. */
export function chooseXcodeApp(selected: string | null, apps: readonly string[]): string | null {
  return selectedXcodeApp(selected) ?? apps[0] ?? null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A version as people say it: "15.2.0" is "15.2", "26.1.1" stays. */
function shortVersion(version: string): string {
  const parts = version.split(".");
  while (parts.length > 2 && parts.at(-1) === "0") parts.pop();
  return parts.join(".");
}

/** Whether the engine builds with this Xcode; an unknown version or range never refuses it. */
function inRange(version: string | null, range: XcodeRange | null): boolean {
  if (version === null || range === null) return true;
  return compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) <= 0;
}

/** Whether this Xcode is newer than the engine builds with; an unknown version or range never is. */
function aboveRange(version: string | null, range: XcodeRange | null): boolean {
  return version !== null && range !== null && compareVersions(version, range.max) > 0;
}

/**
 * The app's path as Terminal reads it: single-quoted when it holds anything but plain characters.
 * The same rule as `substrate/spawn.ts`'s shellQuote, which the plugin's bundle can't import.
 */
function terminalArgument(text: string): string {
  return PLAIN_ARGUMENT.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The one command that selects `app` for every build, Unreal's included. */
const selectCommand = (app: string) => `sudo xcode-select -s ${terminalArgument(app)}`;

/**
 * The state, in the order the user fixes it: get Xcode, get one the engine builds with, select it,
 * then open it once.
 */
function stateOf(facts: XcodeFacts): XcodeState {
  if (facts.platform !== "darwin") return XcodeState.NotApplicable;
  if (facts.app === null) return XcodeState.Missing;
  if (!inRange(facts.version, facts.range)) return XcodeState.Unsupported;
  if (selectedXcodeApp(facts.selected) !== facts.app) return XcodeState.NotSelected;
  if (!(facts.firstLaunchDone && facts.licenseAccepted)) return XcodeState.FirstLaunch;
  return XcodeState.Ready;
}

/** Opens Apple's developer downloads in the browser, for an Xcode older than the installed one. */
export const xcodeDownloadsLaunch = (): Launch => ({ command: MAC_OPEN, args: [XCODE_DOWNLOADS_URL], detached: false });

/** Where Xcode stands, from what the probes found. */
export function xcodeStatus(facts: XcodeFacts): XcodeStatus {
  const state = stateOf(facts);
  const { range } = facts;
  return {
    state,
    app: facts.app,
    version: facts.version,
    commandLineTools: facts.commandLineTools,
    supported: range ? { min: shortVersion(range.min), max: shortVersion(range.max) } : null,
    tooNew: state === XcodeState.Unsupported && aboveRange(facts.version, range),
    command: state === XcodeState.NotSelected && facts.app !== null ? selectCommand(facts.app) : null,
  };
}

/** The Xcode range in an engine's Apple_SDK.json (plain JSON with `//` comment keys); null without one. */
export function parseAppleSdk(text: string): XcodeRange | null {
  try {
    const json: unknown = JSON.parse(text);
    if (!isJsonObject(json)) return null;
    const { MinVersion: min, MaxVersion: max } = json;
    const versions = typeof min === "string" && typeof max === "string" && VERSION.test(min) && VERSION.test(max);
    return versions ? { min, max } : null;
  } catch {
    return null;
  }
}

/** The Xcode range of the engine installed at `engineDirectory`; null without its Apple_SDK.json. */
export async function engineXcodeRange(engineDirectory: string): Promise<XcodeRange | null> {
  const file = path.join(engineDirectory, "Engine", "Config", "Apple", "Apple_SDK.json");
  const bytes = await readRegularFile(file, APPLE_SDK_MAX_BYTES).catch(() => null);
  return bytes ? parseAppleSdk(bytes.toString("utf8")) : null;
}

async function isFolder(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null))?.isDirectory() ?? false;
}

/** Xcode.app first, then its betas and copies by name. */
const byXcodeFirst = (a: string, b: string) => Number(b === XCODE_APP) - Number(a === XCODE_APP) || (a < b ? -1 : 1);

/** This Mac's probes; `runner`, `env` and `folders` let a test stand in for it. */
export function systemXcodeProbes(
  runner: XcodeRunner = run,
  env: NodeJS.ProcessEnv = process.env,
  folders: XcodeFolders = SYSTEM_FOLDERS,
): XcodeProbes {
  const options = { timeout: COMMAND_TIMEOUT_MS, env };
  /** Xcode's own xcodebuild about itself; it exits 0 when done and 69 while the step is still to do. */
  const xcodebuildPasses = async (app: string, args: string[]) => {
    const developer = developerFolder(app);
    const xcodebuild = path.join(developer, "usr", "bin", "xcodebuild");
    const answer = await runner(xcodebuild, args, { ...options, env: { ...env, DEVELOPER_DIR: developer } }).catch(
      () => null,
    );
    return answer !== null;
  };
  return {
    selected: async () => {
      const answer = await runner(XCODE_SELECT, ["-p"], options).catch(() => null);
      const folder = answer?.stdout.trim() ?? "";
      return folder !== "" && (await isFolder(folder)) ? folder : null;
    },
    apps: async () => {
      const names = (await readdir(folders.applications).catch(() => [])).filter((name) => XCODE_APP_NAME.test(name));
      const apps: string[] = [];
      for (const name of names.sort(byXcodeFirst))
        if (await isFolder(path.join(folders.applications, name))) apps.push(path.join(folders.applications, name));
      return apps;
    },
    version: async (app) => {
      const plist = path.join(app, "Contents", "Info.plist");
      const answer = await runner(
        PLUTIL,
        ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist],
        options,
      ).catch(() => null);
      const version = answer?.stdout.trim() ?? "";
      return VERSION.test(version) ? version : null;
    },
    firstLaunchDone: (app) => xcodebuildPasses(app, ["-checkFirstLaunchStatus"]),
    licenseAccepted: (app) => xcodebuildPasses(app, ["-license", "check"]),
    commandLineTools: () => isFolder(folders.commandLineTools),
    range: engineXcodeRange,
  };
}

/**
 * The Xcode to judge and its version: the chosen one, unless the engine can't build with it and
 * another installed Xcode it can is there (Xcode 28 selected, Xcode_27 beside it): that one is the
 * one to select. Other apps' versions are read only then.
 */
async function judgedApp(
  probes: XcodeProbes,
  chosen: string,
  apps: readonly string[],
  range: XcodeRange | null,
): Promise<{ app: string; version: string | null }> {
  const version = await probes.version(chosen);
  if (inRange(version, range)) return { app: chosen, version };
  for (const other of apps.filter((app) => app !== chosen)) {
    const otherVersion = await probes.version(other);
    if (otherVersion !== null && inRange(otherVersion, range)) return { app: other, version: otherVersion };
  }
  return { app: chosen, version };
}

/** Where Xcode stands for the engine installed at `engineDirectory` (none: no range to judge by). */
export type XcodeCheck = (engineDirectory: string | undefined) => Promise<XcodeStatus>;

const NO_XCODE = { selected: null, app: null, version: null, firstLaunchDone: false, licenseAccepted: false };

/**
 * Asks the probes on each call, so a change shows on the next status. A first launch and licence
 * once done stay done for that Xcode and version, so xcodebuild is asked again only for a new one.
 */
export function xcodeChecker(platform: NodeJS.Platform, probes: XcodeProbes): XcodeCheck {
  const done = new Set<string>();
  const setUp = async (app: string, version: string | null) => {
    const key = version === null ? undefined : `${app}\n${version}`;
    if (key !== undefined && done.has(key)) return { firstLaunchDone: true, licenseAccepted: true };
    const [firstLaunchDone, licenseAccepted] = await Promise.all([
      probes.firstLaunchDone(app),
      probes.licenseAccepted(app),
    ]);
    if (key !== undefined && firstLaunchDone && licenseAccepted) done.add(key);
    return { firstLaunchDone, licenseAccepted };
  };
  return async (engineDirectory) => {
    if (platform !== "darwin") return xcodeStatus({ ...NO_XCODE, platform, commandLineTools: false, range: null });
    const [selected, apps, commandLineTools, range] = await Promise.all([
      probes.selected(),
      probes.apps(),
      probes.commandLineTools(),
      engineDirectory === undefined ? null : probes.range(engineDirectory),
    ]);
    const chosen = chooseXcodeApp(selected, apps);
    if (chosen === null) return xcodeStatus({ ...NO_XCODE, platform, selected, commandLineTools, range });
    const { app, version } = await judgedApp(probes, chosen, apps, range);
    return xcodeStatus({ platform, selected, app, version, commandLineTools, range, ...(await setUp(app, version)) });
  };
}

/** This computer's Xcode check. */
export const systemXcodeCheck = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): XcodeCheck =>
  xcodeChecker(platform, systemXcodeProbes(run, env));
