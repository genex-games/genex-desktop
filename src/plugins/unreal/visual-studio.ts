/**
 * Microsoft's C++ tools for Unreal on Windows. Unreal builds C++ there with Microsoft's compiler
 * (MSVC) and the Windows SDK, which Visual Studio or its free Build Tools install; Do it for me on
 * the setup card installs the Build Tools (`epic-install.ts`). Each status asks where they stand, so
 * the card notices an install by itself.
 *
 * Every probe is a folder or file read, or Microsoft's own `vswhere.exe` or Windows' `reg.exe` by its
 * full path with an argument array, never a shell, and none of them prompts. The compiler versions and
 * the Windows SDK an engine builds with come from its own `Engine/Config/Windows/Windows_SDK.json`, as
 * UnrealBuildTool reads them: a toolset at least `MinimumVisualCppVersion` and outside
 * `BannedVisualCppVersions`, and an SDK from `MinVersion` to `MaxVersion`. A toolset's version is
 * its x64 `cl.exe`'s own product version, as UnrealBuildTool judges those two by: Microsoft's updates
 * raise it in place and leave the folder's name as it was (the folder names only the
 * `PreferredVisualCppVersions` family, which Genex doesn't judge by). Every Win64 editor build
 * also needs a .NET Framework SDK (4.6 or later): the engine's SwarmInterface module refuses the whole
 * build without one, and UnrealBuildTool finds it only through the registry's `NETFXSDK` keys.
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject, readRegularFile } from "../../substrate/fsx.ts";

/** Where Microsoft's C++ tools stand for Unreal on this computer. Wire values: cpp-status reads them. */
export const VisualStudioState = {
  /** Not Windows: Unreal builds C++ without Visual Studio there. */
  NotApplicable: "not-applicable",
  /** No C++ compiler, or no Windows SDK, that the engine builds with. */
  Missing: "missing",
  /** A C++ compiler is installed, but every one is older than the engine builds with, or one it refuses. */
  Outdated: "outdated",
  Ready: "ready",
} as const;
export type VisualStudioState = (typeof VisualStudioState)[keyof typeof VisualStudioState];

/** What Do it for me runs to fix a state: a new Build Tools install, or the installed one changed. */
export const BuildToolsPlan = {
  /** No Build Tools of this release yet: Microsoft's installer installs them. */
  Install: "install",
  /** Build Tools are there without the C++ tools or the SDK: the installer adds them. */
  Modify: "modify",
  /** Build Tools are there with a compiler the engine refuses: the installer updates them. */
  Update: "update",
} as const;
export type BuildToolsPlan = (typeof BuildToolsPlan)[keyof typeof BuildToolsPlan];

/** Where Microsoft's C++ tools stand, as status hands it to the card and cpp-status. */
export type VisualStudioStatus = {
  state: VisualStudioState;
  /** The newest compiler the engine builds with ("14.44.35211"); null without one. */
  toolset: string | null;
  /** Whether a Windows SDK the engine builds with is installed. */
  windowsSdk: boolean;
  /** Whether a .NET Framework SDK UnrealBuildTool accepts is installed. */
  netFxSdk: boolean;
  /** What Do it for me runs to make it ready; absent once ready or off Windows. */
  plan?: BuildToolsPlan;
  /** The Build Tools install the plan changes (Modify, Update); absent for a new install. */
  installPath?: string;
  /** That install's release channel, which Modify names; absent when vswhere didn't say. */
  channelId?: string;
};

/** One installed Visual Studio product, as vswhere lists it; `channelId` when it names one Genex can pass on. */
export type VisualStudioInstance = {
  installationPath: string;
  productId: string;
  installationVersion: string;
  channelId?: string;
};

/** The compiler and SDK versions an engine builds with; versions are dotted numbers. */
export type MsvcRules = {
  minimumToolset: string;
  /** Inclusive ranges of compilers the engine refuses. */
  bannedToolsets: Array<{ min: string; max: string }>;
  sdkMin: string;
  sdkMax: string;
};

/** Each question Genex asks the computer; tests stand in for it. */
export type VisualStudioProbes = {
  instances: () => Promise<VisualStudioInstance[]>;
  /** The versions of an instance's compilers that have their x64 cl.exe, as cl.exe names them. */
  toolsets: (installationPath: string) => Promise<string[]>;
  /** The Windows SDK versions installed with their headers. */
  sdks: () => Promise<string[]>;
  /** The .NET Framework SDK versions the registry names an install folder for. */
  netFxSdks: () => Promise<string[]>;
  rules: (engineDirectory: string) => Promise<MsvcRules | null>;
};

/** Runs a program to its end with execFile's options; tests record instead. */
export type VisualStudioRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>;

/** Windows' Program Files (x86), where Visual Studio's installer and the Windows Kits are, and Windows' reg.exe. */
export type VisualStudioFolders = { programFilesX86: string; regExe?: string };

/** Microsoft's link to the Visual Studio 2022 Build Tools installer, which redirects to the current release. */
export const BUILD_TOOLS_URL = "https://aka.ms/vs/17/release/vs_BuildTools.exe";
/** The hosts the installer may come from, matched exactly: Microsoft's link service and its download host. */
export const BUILD_TOOLS_HOSTS: ReadonlySet<string> = new Set(["aka.ms", "download.visualstudio.microsoft.com"]);
/** The release channel the Build Tools above install from, which the installer's modify names. */
export const BUILD_TOOLS_CHANNEL = "VisualStudio.17.Release";
/** The Build Tools' product id, as vswhere names it. */
export const BUILD_TOOLS_PRODUCT = "Microsoft.VisualStudio.Product.BuildTools";
/**
 * What Unreal needs of the Build Tools: the C++ workload, its x64 compiler, the Windows SDK the
 * engine's own Windows_SDK.json names as its main version and the .NET Framework SDK every editor
 * build reads.
 */
export const BUILD_TOOLS_COMPONENTS = [
  "Microsoft.VisualStudio.Workload.VCTools",
  "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  "Microsoft.VisualStudio.Component.Windows11SDK.22621",
  "Microsoft.Net.Component.4.8.SDK",
] as const;

/** Visual Studio 2022's first version number; Build Tools of another release are another product line. */
const BUILD_TOOLS_MAJOR = "17";
const VSWHERE = ["Microsoft Visual Studio", "Installer", "vswhere.exe"] as const;
const MSVC_FOLDER = ["VC", "Tools", "MSVC"] as const;
/** The x64 compiler inside a toolset's folder: UnrealBuildTool builds Win64 with it. */
const X64_COMPILER = ["bin", "Hostx64", "x64", "cl.exe"] as const;
const SDK_INCLUDE = ["Windows Kits", "10", "Include"] as const;
/** The headers an SDK version's Include folder holds once installed (a leftover folder has none). */
const SDK_HEADERS = "um";
const TOOLSET_VERSION = /^\d+\.\d+\.\d+$/;
/** A Visual Studio 2022 release channel as vswhere names it: VisualStudio.17.Release, or an LTSC one. */
const CHANNEL_ID = /^VisualStudio\.17\.[A-Za-z0-9.]+$/;
const SDK_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
/** VS_FIXEDFILEINFO's signature, 0xFEEF04BD as it lies in a Windows program, which starts its version block. */
const FIXED_FILE_INFO = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
/** That block's own version, which the signature's other matches in a program lack. */
const FIXED_FILE_INFO_VERSION = 0x00010000;
/** Where the block's product version lies: after its signature, its own version and the file version. */
const PRODUCT_VERSION_AT = 16;
/** The block up to the product version's two halves, 32 bits each. */
const FIXED_FILE_INFO_BYTES = 24;
/** An x64 cl.exe is under a megabyte; a bigger file is not one to read whole. */
const COMPILER_MAX_BYTES = 16 * 1024 * 1024;
/** The oldest .NET Framework SDK UnrealBuildTool accepts. */
const NETFX_MINIMUM = "4.6";
/** Where the registry keeps .NET Framework SDKs, 32-bit view first, as UnrealBuildTool looks. */
const NETFX_KEYS = [
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\NETFXSDK",
  "HKLM\\SOFTWARE\\Microsoft\\Microsoft SDKs\\NETFXSDK",
] as const;
/** The value UnrealBuildTool reads from each version's key. */
const NETFX_VALUE = "KitsInstallationFolder";
/** A key's line in `reg query /s` output, which the values under it follow. */
const REGISTRY_KEY_LINE = /^HKEY_/i;
/** A version's own key: `…\NETFXSDK\4.8`, not one of its subkeys. */
const NETFX_KEY_LINE = /\\NETFXSDK\\(?<version>\d+(?:\.\d+)*)\s*$/i;
/** Its install folder, a non-empty string value. */
const NETFX_FOLDER_LINE = /^\s+KitsInstallationFolder\s+REG_(?:EXPAND_)?SZ\s+\S/i;
const REG_EXE = "C:\\Windows\\System32\\reg.exe";
const VERSION = /^\d+(\.\d+)*$/;
/** A banned range as Windows_SDK.json writes it: "14.40.0-14.43.99999". */
const VERSION_RANGE = /^(\d+(?:\.\d+)*)-(\d+(?:\.\d+)*)$/;
/** vswhere answers at once; a hung one must not hold the card's status. */
const COMMAND_TIMEOUT_MS = 10 * SECOND_MS;
/** vswhere's JSON for a few instances is a few kilobytes. */
const VSWHERE_MAX_BYTES = 1024 * 1024;
/** Windows_SDK.json is a few kilobytes. */
const WINDOWS_SDK_MAX_BYTES = 64 * 1024;

const run: VisualStudioRunner = promisify(execFile);

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const newestFirst = (a: string, b: string) => compareVersions(b, a);

/** Whether `version` is in the inclusive range. */
const within = (version: string, min: string, max: string) =>
  compareVersions(version, min) >= 0 && compareVersions(version, max) <= 0;

/** Whether the engine builds with this compiler; without the engine's rules, any compiler counts. */
export function toolsetAccepted(version: string, rules: MsvcRules | null): boolean {
  if (rules === null) return true;
  if (compareVersions(version, rules.minimumToolset) < 0) return false;
  return !rules.bannedToolsets.some((range) => within(version, range.min, range.max));
}

/** Whether the engine builds with this Windows SDK; without the engine's rules, any Windows 10 SDK counts. */
export function sdkAccepted(version: string, rules: MsvcRules | null): boolean {
  return rules === null || within(version, rules.sdkMin, rules.sdkMax);
}

/** The banned ranges Windows_SDK.json lists; a malformed entry is left out. */
function bannedRanges(value: unknown): MsvcRules["bannedToolsets"] {
  if (!Array.isArray(value)) return [];
  const ranges: MsvcRules["bannedToolsets"] = [];
  for (const entry of value) {
    const match = typeof entry === "string" ? VERSION_RANGE.exec(entry) : null;
    if (match?.[1] && match[2]) ranges.push({ min: match[1], max: match[2] });
  }
  return ranges;
}

const versionField = (value: unknown) => (typeof value === "string" && VERSION.test(value) ? value : null);

/** The rules in an engine's Windows_SDK.json (plain JSON with `//` comment keys); null without them. */
export function parseWindowsSdk(text: string): MsvcRules | null {
  try {
    const json: unknown = JSON.parse(text);
    if (!isJsonObject(json)) return null;
    const minimumToolset = versionField(json.MinimumVisualCppVersion);
    const sdkMin = versionField(json.MinVersion);
    const sdkMax = versionField(json.MaxVersion);
    if (minimumToolset === null || sdkMin === null || sdkMax === null) return null;
    return { minimumToolset, bannedToolsets: bannedRanges(json.BannedVisualCppVersions), sdkMin, sdkMax };
  } catch {
    return null;
  }
}

/** The rules of the engine installed at `engineDirectory`; null without its Windows_SDK.json. */
export async function engineMsvcRules(engineDirectory: string): Promise<MsvcRules | null> {
  const file = path.join(engineDirectory, "Engine", "Config", "Windows", "Windows_SDK.json");
  const bytes = await readRegularFile(file, WINDOWS_SDK_MAX_BYTES).catch(() => null);
  return bytes ? parseWindowsSdk(bytes.toString("utf8")) : null;
}

/**
 * The .NET Framework SDK versions in `reg query <key> /s /v KitsInstallationFolder` output whose key
 * names an install folder, as UnrealBuildTool reads them; anything else is left out.
 */
export function parseNetFxSdks(output: string): string[] {
  const versions = new Set<string>();
  let current: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (REGISTRY_KEY_LINE.test(line)) current = NETFX_KEY_LINE.exec(line)?.groups?.version;
    else if (current && NETFX_FOLDER_LINE.test(line)) versions.add(current);
  }
  return [...versions].sort(newestFirst);
}

/** Whether UnrealBuildTool builds with this .NET Framework SDK. */
export const netFxSdkAccepted = (version: string) => compareVersions(version, NETFX_MINIMUM) >= 0;

/** The instances in vswhere's JSON that are whole installs at an absolute path; anything else is left out. */
export function parseInstances(stdout: string): VisualStudioInstance[] {
  try {
    const json: unknown = JSON.parse(stdout);
    if (!Array.isArray(json)) return [];
    return json.flatMap((entry: unknown) => {
      if (!isJsonObject(entry)) return [];
      const { installationPath, productId, installationVersion, channelId } = entry;
      const usable =
        typeof installationPath === "string" &&
        path.win32.isAbsolute(installationPath) &&
        typeof productId === "string" &&
        typeof installationVersion === "string";
      if (!usable) return [];
      const channel = typeof channelId === "string" && CHANNEL_ID.test(channelId) ? { channelId } : {};
      return [{ installationPath, productId, installationVersion, ...channel }];
    });
  } catch {
    return [];
  }
}

async function isFolder(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null))?.isDirectory() ?? false;
}

async function isFile(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null))?.isFile() ?? false;
}

/**
 * The product version a Windows program's version block names, as UnrealBuildTool reads cl.exe's
 * (ProductMajorPart.ProductMinorPart.ProductBuildPart, "14.44.35229"; its file version says 19.44);
 * null without a block, or with one whose major part is 0, where UnrealBuildTool takes the folder's.
 */
export function productVersionOf(program: Buffer): string | null {
  for (let at = program.indexOf(FIXED_FILE_INFO); at >= 0; at = program.indexOf(FIXED_FILE_INFO, at + 1)) {
    if (at + FIXED_FILE_INFO_BYTES > program.length) return null;
    if (program.readUInt32LE(at + 4) !== FIXED_FILE_INFO_VERSION) continue;
    const high = program.readUInt32LE(at + PRODUCT_VERSION_AT);
    const low = program.readUInt32LE(at + PRODUCT_VERSION_AT + 4);
    if (high >>> 16 === 0) return null;
    return `${high >>> 16}.${high & 0xffff}.${low >>> 16}`;
  }
  return null;
}

/** A toolset's version: its cl.exe's own product version, or the folder's name when the file names none. */
async function compilerVersion(compiler: string, folderName: string): Promise<string> {
  const program = await readRegularFile(compiler, COMPILER_MAX_BYTES).catch(() => null);
  return (program && productVersionOf(program)) ?? folderName;
}

/** The names in a folder that match `shape`, kept when `keep` says so. */
async function versionsIn(folder: string, shape: RegExp, keep: (name: string) => Promise<boolean>) {
  const names = (await readdir(folder).catch(() => [])).filter((name) => shape.test(name));
  const kept: string[] = [];
  for (const name of names) if (await keep(name)) kept.push(name);
  return kept.sort(newestFirst);
}

/** Microsoft's vswhere.exe, where Visual Studio's installer puts it. */
export const vswherePath = (folders: VisualStudioFolders) => path.win32.join(folders.programFilesX86, ...VSWHERE);

/** This computer's probes; `runner` and `folders` let a test stand in for Windows. */
export function systemVisualStudioProbes(
  folders: VisualStudioFolders,
  runner: VisualStudioRunner = run,
): VisualStudioProbes {
  const options = { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: VSWHERE_MAX_BYTES };
  const include = path.join(folders.programFilesX86, ...SDK_INCLUDE);
  return {
    instances: async () => {
      const args = ["-products", "*", "-format", "json", "-utf8", "-nologo"];
      const answer = await runner(vswherePath(folders), args, options).catch(() => null);
      return answer ? parseInstances(answer.stdout) : [];
    },
    toolsets: async (installationPath) => {
      const msvc = path.join(installationPath, ...MSVC_FOLDER);
      const compiler = (name: string) => path.join(msvc, name, ...X64_COMPILER);
      const folders = await versionsIn(msvc, TOOLSET_VERSION, (name) => isFile(compiler(name)));
      const versions = await Promise.all(folders.map((name) => compilerVersion(compiler(name), name)));
      return [...new Set(versions)].sort(newestFirst);
    },
    sdks: () => versionsIn(include, SDK_VERSION, (name) => isFolder(path.join(include, name, SDK_HEADERS))),
    netFxSdks: async () => {
      const regExe = folders.regExe ?? REG_EXE;
      const answers = await Promise.all(
        NETFX_KEYS.map((key) => runner(regExe, ["query", key, "/s", "/v", NETFX_VALUE], options).catch(() => null)),
      );
      return [...new Set(answers.flatMap((answer) => (answer ? parseNetFxSdks(answer.stdout) : [])))].sort(newestFirst);
    },
    rules: engineMsvcRules,
  };
}

/** The Build Tools install of the release Genex installs, which a plan changes in place. */
const buildToolsOf = (instances: readonly VisualStudioInstance[]) =>
  instances.find(
    (instance) =>
      instance.productId === BUILD_TOOLS_PRODUCT && instance.installationVersion.split(".")[0] === BUILD_TOOLS_MAJOR,
  );

/** What the probes found, judged; the state follows from these alone. */
export type VisualStudioFacts = {
  platform: NodeJS.Platform;
  instances: VisualStudioInstance[];
  /** Each instance's compilers, newest first, by its installation path. */
  toolsets: Map<string, string[]>;
  sdks: string[];
  /** The .NET Framework SDK versions installed. */
  netFxSdks: string[];
  rules: MsvcRules | null;
};

/**
 * The plan that makes the tools ready: change the Build Tools install when there is one, else install
 * them. Update only when that install's own compilers are the refused ones (another product's are
 * left to it); otherwise Modify adds the compiler and SDK it lacks.
 */
function planOf(
  facts: VisualStudioFacts,
  state: VisualStudioState,
): Pick<VisualStudioStatus, "plan" | "installPath" | "channelId"> {
  const buildTools = buildToolsOf(facts.instances);
  if (!buildTools) return { plan: BuildToolsPlan.Install };
  const own = facts.toolsets.get(buildTools.installationPath) ?? [];
  const outdated = state === VisualStudioState.Outdated && own.length > 0;
  const plan = outdated ? BuildToolsPlan.Update : BuildToolsPlan.Modify;
  const channel = buildTools.channelId ? { channelId: buildTools.channelId } : {};
  return { plan, installPath: buildTools.installationPath, ...channel };
}

/**
 * Where the tools stand: Ready with a compiler, a Windows SDK and a .NET Framework SDK the engine
 * builds with; Outdated when the only compilers are ones it refuses (and the Windows SDK is there),
 * whose update comes first; otherwise Missing.
 */
export function visualStudioStatus(facts: VisualStudioFacts): VisualStudioStatus {
  if (facts.platform !== "win32")
    return { state: VisualStudioState.NotApplicable, toolset: null, windowsSdk: false, netFxSdk: false };
  const all = [...facts.toolsets.values()].flat().sort(newestFirst);
  const toolset = all.find((version) => toolsetAccepted(version, facts.rules)) ?? null;
  const windowsSdk = facts.sdks.some((version) => sdkAccepted(version, facts.rules));
  const netFxSdk = facts.netFxSdks.some(netFxSdkAccepted);
  const found = { toolset, windowsSdk, netFxSdk };
  if (toolset !== null && windowsSdk && netFxSdk) return { state: VisualStudioState.Ready, ...found };
  const outdated = toolset === null && all.length > 0 && windowsSdk;
  const state = outdated ? VisualStudioState.Outdated : VisualStudioState.Missing;
  return { state, ...found, ...planOf(facts, state) };
}

/** Where the tools stand for the engine installed at `engineDirectory` (none: any compiler counts). */
export type VisualStudioCheck = (engineDirectory: string | undefined) => Promise<VisualStudioStatus>;

/** Asks the probes on each call, so an install shows on the next status. */
export function visualStudioChecker(platform: NodeJS.Platform, probes: VisualStudioProbes): VisualStudioCheck {
  return async (engineDirectory) => {
    if (platform !== "win32")
      return visualStudioStatus({ platform, instances: [], toolsets: new Map(), sdks: [], netFxSdks: [], rules: null });
    const [instances, sdks, netFxSdks, rules] = await Promise.all([
      probes.instances(),
      probes.sdks(),
      probes.netFxSdks(),
      engineDirectory === undefined ? null : probes.rules(engineDirectory),
    ]);
    const toolsets = new Map<string, string[]>();
    for (const instance of instances)
      toolsets.set(instance.installationPath, await probes.toolsets(instance.installationPath));
    return visualStudioStatus({ platform, instances, toolsets, sdks, netFxSdks, rules });
  };
}

/** This computer's check: off Windows it asks nothing. */
export const systemVisualStudioCheck = (platform: NodeJS.Platform, folders: VisualStudioFolders): VisualStudioCheck =>
  visualStudioChecker(platform, systemVisualStudioProbes(folders));

/** Whether Unreal can build C++ with Microsoft's tools here; off Windows, nothing to judge. */
export const visualStudioReady = (status: Pick<VisualStudioStatus, "state">) =>
  status.state === VisualStudioState.Ready;

/** Whether Microsoft's tools are known to be missing or refused here: never off Windows, or where nothing could tell. */
export const visualStudioLacking = (status: Pick<VisualStudioStatus, "state">) =>
  status.state === VisualStudioState.Missing || status.state === VisualStudioState.Outdated;
