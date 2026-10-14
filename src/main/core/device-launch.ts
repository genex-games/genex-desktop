/**
 * The person's launch of a game's packaged phone build on the iOS Simulator, an Android emulator
 * or a phone (`studio:native.launchDevice`, M3.8). Containment stage 1: a Simulator app, an
 * emulator guest and a phone all run agent-written code outside ProcessSandbox, so the one way
 * to start one is this host action the person takes from Studio's window. No harness method
 * reaches it, the tools run from the main process (never on a sandboxed PATH), and every launch
 * that got as far as a request the host takes is recorded as a persisted `device_launch` event
 * with the device, the build's digest and the outcome (docs/tool-permissions.md "Devices and
 * emulators").
 *
 * The packaged build is only one the host produced and admitted: it is read from the host's own
 * phone package folder (`AdmittedPackages.root`, under no writable root an agent process has,
 * never the exports folder an agent may write) at {@link DEVICE_PACKAGE}, without following a
 * link: every folder on the way and every file inside an `.app` must be the folder's own, and an
 * APK must have one name only. Its SHA-256 must equal the digest the admission recorded
 * (`not-an-executable` otherwise). The verified bytes are then copied into a private folder of the
 * launch's own, digested again there, and that copy is what the device tool installs, so a rename
 * between the check and the install changes nothing; the copy is removed afterwards. The packages
 * come from the phone exports ({@link phonePackageStore}): an iPhone Simulator app or an Android
 * dev APK is copied from the export's host-only staging, before it is swapped into the exports
 * folder, with its digest. An iPhone device build is not admitted (an IPA is the person's to
 * install), so a launch on an iPhone refuses `unsupported` before any device tool runs, as does a
 * launch of a game with no admitted package.
 *
 * The tools: `xcrun simctl` for the Simulator, `xcrun devicectl` for an iPhone, `adb` for an
 * emulator or an Android phone (the person's own SDK; the store keeps no platform-tools). Each
 * runs through `execFile`, never a shell; the one argument that reaches a device's shell (adb's
 * `monkey` package name) is a checked bundle id, quoted.
 */
import { createHash } from "node:crypto";
import { access, constants, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import {
  DeviceKind,
  type DeviceLaunchRequest,
  type DeviceLaunchResult,
  DeviceLaunchOutcome,
  type DeviceTarget,
} from "../../shared/device-launch.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { BuildTarget, type GameProject, destinationsOf } from "../../shared/game-project.ts";
import { NativeRefusal } from "../../shared/native-contract.ts";
import { isBundleId } from "../../substrate/native-bundle.ts";
import { shellQuote } from "../../substrate/shell-quote.ts";
import { type XcodeExec, execXcode } from "../../substrate/toolchain-store/locate.ts";
import { digestTreeEntry, walkTree } from "../../substrate/workspace-digest.ts";

/** How long listing the devices may take. */
export const DEVICE_LIST_TIMEOUT_MS = 30 * SECOND_MS;
/** How long an install may take: a large app onto a cold Simulator or over USB. */
export const DEVICE_INSTALL_TIMEOUT_MS = 5 * MINUTE_MS;
/** How long starting the installed game may take. */
export const DEVICE_START_TIMEOUT_MS = MINUTE_MS;
/** The longest device id a launch takes (a Simulator UDID is 36, an adb serial far shorter). */
const DEVICE_ID_MAX = 128;
/** A device id: a UDID, an adb serial or `host:port`; never an option, a space or a shell word. */
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** The prefix adb gives every emulator's serial, and no phone's. */
const EMULATOR_SERIAL = "emulator-";
/** The selected developer folder; asked before `xcrun`, whose shim can open Apple's installer. */
const XCODE_SELECT = "/usr/bin/xcode-select";
const XCRUN = "/usr/bin/xcrun";

/**
 * The phone export folder's suffix on the game's name under the exports root, as the export
 * names it (`EXPORT_SUFFIX` in `native-export-run.ts`).
 */
const PHONE_EXPORT_SUFFIX = { [BuildTarget.Ios]: ".ios", [BuildTarget.Android]: ".android" } as const satisfies Record<
  DeviceTarget,
  string
>;

/**
 * Where the packaged build each launch installs sits inside the phone export folder; null where
 * the device does not run the destination (an iOS app on an Android emulator).
 */
export const DEVICE_PACKAGE = {
  [BuildTarget.Ios]: {
    [DeviceKind.Simulator]: ["simulator", "Game.app"],
    [DeviceKind.Phone]: ["device", "Game.app"],
    [DeviceKind.Emulator]: null,
  },
  [BuildTarget.Android]: {
    [DeviceKind.Emulator]: ["Game.apk"],
    [DeviceKind.Phone]: ["Game.apk"],
    [DeviceKind.Simulator]: null,
  },
} as const satisfies Record<DeviceTarget, Record<DeviceKind, readonly string[] | null>>;

/** The host programs a launch runs, each resolved when it is needed; null where this host has none. */
export interface DeviceTools {
  exec: XcodeExec;
  /** `xcrun` once Xcode is selected; null without it or off a Mac. */
  xcrun(): Promise<string | null>;
  /** The person's `adb`; null without an Android SDK. */
  adb(): Promise<string | null>;
}

/**
 * The phone packages the host produced and admitted: the host's own folder they sit in (under no
 * writable root) and the digest each admission recorded, by game, destination and device.
 */
export interface AdmittedPackages {
  root: string;
  digestOf(project: string, target: DeviceTarget, device: DeviceKind): Promise<string | null>;
}

/** What a launch reaches: this host, the admitted packages, the game's bundle id and the device tools. */
export interface DeviceLaunchDeps {
  host: NodeJS.Platform;
  /** The admitted phone packages; null until the export lane packages phones (every launch refused). */
  packages: AdmittedPackages | null;
  bundleIdFor(project: string): Promise<string>;
  tools: DeviceTools;
  /** When the launch ended, ISO 8601. */
  at(): string;
}

/** The admission receipt beside a game's phone packages: each device kind's digest. */
const ADMITTED_RECEIPT = "admitted.json";

/** The phone package store: admitted packages, and how an export adds one. */
export interface PhonePackageStore extends AdmittedPackages {
  /**
   * Copy `staged` (a phone export's package, still in the host's own staging) into the store as
   * the package `devices` install for `project`'s `target`, replacing what was admitted for it
   * before, and record the copy's digest for each device kind.
   */
  admit(project: string, target: DeviceTarget, devices: readonly DeviceKind[], staged: string): Promise<void>;
}

/** The digest a receipt's text records for `device`; null for anything else (a malformed receipt too). */
function receiptDigest(text: string, device: DeviceKind): string | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const digest: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, device) : null;
  return typeof digest === "string" ? digest : null;
}

/**
 * The host's own store of admitted phone packages under `root` (`layout.phonePackages`: under no
 * writable root an agent process has). A game's packages for one destination are replaced as a
 * whole folder: copied into a fresh folder beside it, digested there, then renamed into place.
 */
export function phonePackageStore(root: string): PhonePackageStore {
  return {
    root,
    async digestOf(project, target, device) {
      const receipt = path.join(phonePackageDir(root, project, target), ADMITTED_RECEIPT);
      const info = await lstat(receipt).catch(() => null);
      if (!info?.isFile()) return null;
      return receiptDigest(await readFile(receipt, "utf8").catch(() => ""), device);
    },
    async admit(project, target, devices, staged) {
      const [first] = devices;
      const parts = first === undefined ? null : DEVICE_PACKAGE[target][first];
      if (!parts) throw new DeviceRequestError(MESSAGE.badRequest);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const fresh = await mkdtemp(path.join(root, `.${project}-`));
      try {
        const into = path.join(fresh, ...parts);
        await mkdir(path.dirname(into), { recursive: true });
        await cp(staged, into, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
        const digest = await packageDigest(into, target);
        const receipt = Object.fromEntries(devices.map((device) => [device, digest]));
        await writeFile(path.join(fresh, ADMITTED_RECEIPT), JSON.stringify(receipt), { flag: "wx" });
        const dir = phonePackageDir(root, project, target);
        await rm(dir, { recursive: true, force: true });
        await rename(fresh, dir);
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
    },
  };
}

/** Why a request was not taken: it never reaches a device and is not recorded. */
export class DeviceRequestError extends Error {}

const MESSAGE = {
  badRequest: "That is not a launch on a Simulator, emulator or phone.",
  badDeviceId: "That device name is not one Studio can pass to the device tools.",
  badBundleId: "This game has no app identifier a device can start.",
} as const;

/** The phone package folder of `project` for `target` under the admitted packages' `root`. */
export function phonePackageDir(root: string, project: string, target: DeviceTarget): string {
  return path.join(root, `${project}${PHONE_EXPORT_SUFFIX[target]}`);
}

function isDeviceTarget(value: unknown): value is DeviceTarget {
  return value === BuildTarget.Ios || value === BuildTarget.Android;
}

function isDeviceKind(value: unknown): value is DeviceKind {
  return Object.values<unknown>(DeviceKind).includes(value);
}

/** Whether `value` is a device id the tools can be handed as one argument. */
function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && value.length <= DEVICE_ID_MAX && DEVICE_ID.test(value);
}

/** The renderer's request, checked field by field; throws {@link DeviceRequestError} for anything else. */
export function parseDeviceLaunchRequest(value: unknown): DeviceLaunchRequest {
  if (typeof value !== "object" || value === null) throw new DeviceRequestError(MESSAGE.badRequest);
  const target: unknown = Reflect.get(value, "target");
  const device: unknown = Reflect.get(value, "device");
  if (!isDeviceTarget(target) || !isDeviceKind(device)) throw new DeviceRequestError(MESSAGE.badRequest);
  if (!Object.hasOwn(value, "deviceId")) return { target, device };
  const deviceId: unknown = Reflect.get(value, "deviceId");
  if (!isDeviceId(deviceId)) throw new DeviceRequestError(MESSAGE.badDeviceId);
  return { target, device, deviceId };
}

/** A launch that stopped short of a device, or the packaged build it installs. */
type Packaged = { ok: true; path: string; digest: string } | { ok: false; refusal: NativeRefusal };

/** A link anywhere on the packaged build's way, or a second name for one of its files. */
class LinkedPackage extends Error {
  readonly refusal: NativeRefusal;
  constructor(refusal: NativeRefusal) {
    super(refusal);
    this.refusal = refusal;
  }
}

/** The entry at `at` without following a link, or null when there is none; throws on a link. */
async function ownEntry(at: string) {
  const info = await lstat(at).catch(() => null);
  if (info?.isSymbolicLink()) throw new LinkedPackage(NativeRefusal.Symlink);
  return info;
}

/** A package's digest as the record names it: an `.app` folder's tree digest, an APK's SHA-256. */
export async function packageDigest(at: string, target: DeviceTarget): Promise<string> {
  if (target === BuildTarget.Ios) return appDigest(at);
  const info = await lstat(at);
  return apkDigest(at, info.nlink);
}

/** The digest of an `.app` folder: every file by its path and content; a link inside refuses it. */
async function appDigest(app: string): Promise<string> {
  const hash = createHash("sha256");
  await walkTree(app, new Set(), async (rel, abs) => {
    await ownEntry(abs);
    await digestTreeEntry(hash, rel, abs);
  });
  return hash.digest("hex");
}

/** The digest of an APK, which must have no other name: a hard link could be swapped from outside. */
async function apkDigest(apk: string, links: number): Promise<string> {
  if (links > 1) throw new LinkedPackage(NativeRefusal.HardLink);
  return createHash("sha256")
    .update(await readFile(apk))
    .digest("hex");
}

/**
 * The packaged build `parts` names inside the phone package folder, walked from the packages root
 * one name at a time without following a link, and its digest; `unsupported` when it is not there.
 */
async function packagedBuild(packageDir: string, parts: readonly string[], target: DeviceTarget): Promise<Packaged> {
  try {
    const steps = parts.map((_, index) => path.join(packageDir, ...parts.slice(0, index + 1)));
    for (const at of [packageDir, ...steps]) {
      if (!(await ownEntry(at))) return { ok: false, refusal: NativeRefusal.Unsupported };
    }
    const at = steps.at(-1) ?? packageDir;
    const info = await lstat(at);
    const isApp = target === BuildTarget.Ios;
    const shaped = isApp ? info.isDirectory() : info.isFile();
    if (!shaped) return { ok: false, refusal: NativeRefusal.Unsupported };
    const digest = isApp ? await appDigest(at) : await apkDigest(at, info.nlink);
    return { ok: true, path: at, digest };
  } catch (error) {
    if (error instanceof LinkedPackage) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

/** One device a tool listed, and whether it is an emulator. */
interface ListedDevice {
  id: string;
  emulator: boolean;
}

/** The booted Simulators `simctl list devices booted --json` names. */
function bootedSimulators(stdout: string): ListedDevice[] {
  const parsed: unknown = JSON.parse(stdout);
  const runtimes: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "devices") : null;
  if (typeof runtimes !== "object" || runtimes === null) return [];
  const booted: ListedDevice[] = [];
  for (const devices of Object.values(runtimes)) {
    if (!Array.isArray(devices)) continue;
    for (const device of devices) {
      const udid: unknown = device?.udid;
      if (device?.state === "Booted" && isDeviceId(udid)) booted.push({ id: udid, emulator: true });
    }
  }
  return booted;
}

/** The devices `adb devices` lists as ready (`device`), an emulator by its serial. */
function adbDevices(stdout: string): ListedDevice[] {
  const ready: ListedDevice[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (state === "device" && isDeviceId(serial))
      ready.push({ id: serial, emulator: serial.startsWith(EMULATOR_SERIAL) });
  }
  return ready;
}

/** The physical iOS devices `devicectl list devices --json-output` wrote. */
function devicectlDevices(json: string): ListedDevice[] {
  const parsed: unknown = JSON.parse(json);
  const result: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "result") : null;
  const devices: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "devices") : null;
  if (!Array.isArray(devices)) return [];
  return devices
    .filter((device) => device?.hardwareProperties?.platform === "iOS" && isDeviceId(device?.identifier))
    .map((device) => ({ id: String(device.identifier), emulator: false }));
}

/** How one launch lists its devices and installs and starts the build on one. */
interface DeviceRoute {
  list(tool: string, exec: XcodeExec): Promise<ListedDevice[]>;
  install(id: string, build: string): string[];
  start(id: string, bundleId: string): string[];
}

/** `xcrun devicectl list devices`, which writes its JSON to a file of its own. */
async function listPhones(tool: string, exec: XcodeExec): Promise<ListedDevice[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "genex-devicectl-"));
  try {
    const out = path.join(dir, "devices.json");
    const listed = await exec(tool, ["devicectl", "list", "devices", "--json-output", out], {
      timeoutMs: DEVICE_LIST_TIMEOUT_MS,
    });
    if (listed.code !== 0) return [];
    return devicectlDevices(await readFile(out, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SIMCTL: DeviceRoute = {
  async list(tool, exec) {
    const listed = await exec(tool, ["simctl", "list", "devices", "booted", "--json"], {
      timeoutMs: DEVICE_LIST_TIMEOUT_MS,
    });
    return listed.code === 0 ? bootedSimulators(listed.stdout) : [];
  },
  install: (id, build) => ["simctl", "install", id, build],
  start: (id, bundleId) => ["simctl", "launch", id, bundleId],
};

const DEVICECTL: DeviceRoute = {
  list: listPhones,
  install: (id, build) => ["devicectl", "device", "install", "app", "--device", id, build],
  start: (id, bundleId) => ["devicectl", "device", "process", "launch", "--device", id, bundleId],
};

/** adb lists both kinds; a route keeps the kind the person asked for. */
function adbRoute(emulator: boolean): DeviceRoute {
  return {
    async list(tool, exec) {
      const listed = await exec(tool, ["devices"], { timeoutMs: DEVICE_LIST_TIMEOUT_MS });
      const ready = listed.code === 0 ? adbDevices(listed.stdout) : [];
      return ready.filter((device) => device.emulator === emulator);
    },
    install: (id, build) => ["-s", id, "install", "-r", build],
    // adb joins a `shell` command's words for the device's shell: the package name goes quoted.
    start: (id, bundleId) => [
      "-s",
      id,
      "shell",
      "monkey",
      "-p",
      shellQuote(bundleId),
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ],
  };
}

const ROUTES = {
  [BuildTarget.Ios]: { [DeviceKind.Simulator]: SIMCTL, [DeviceKind.Phone]: DEVICECTL, [DeviceKind.Emulator]: null },
  [BuildTarget.Android]: {
    [DeviceKind.Emulator]: adbRoute(true),
    [DeviceKind.Phone]: adbRoute(false),
    [DeviceKind.Simulator]: null,
  },
} as const satisfies Record<DeviceTarget, Record<DeviceKind, DeviceRoute | null>>;

/** The device the launch reaches: the one named when it is listed, else the only one there is. */
function chosenDevice(listed: readonly ListedDevice[], deviceId: string | undefined): string | null {
  if (deviceId !== undefined) return listed.some((device) => device.id === deviceId) ? deviceId : null;
  return listed.length === 1 ? (listed[0]?.id ?? null) : null;
}

/** The tool a launch of `target` runs, or null where this host has none. */
function toolFor(deps: DeviceLaunchDeps, target: DeviceTarget): Promise<string | null> {
  if (target === BuildTarget.Android) return deps.tools.adb();
  return deps.host === StudioPlatform.Mac ? deps.tools.xcrun() : Promise.resolve(null);
}

/**
 * Launch the game's packaged build for `request` on a device: checks first (the game names the
 * destination, the device runs it, the tool is here, the packaged build is its own), then the
 * device listing, the install and the start. Answers how it ended; the caller records it.
 * Throws {@link DeviceRequestError} only for a game with no usable bundle id.
 */
export async function launchOnDevice(
  deps: DeviceLaunchDeps,
  game: GameProject,
  request: DeviceLaunchRequest,
): Promise<DeviceLaunchResult> {
  const { target, device } = request;
  const ended = (fields: Partial<DeviceLaunchResult>): DeviceLaunchResult => ({
    outcome: DeviceLaunchOutcome.Refused,
    target,
    device,
    deviceId: null,
    buildDigest: null,
    refusal: null,
    ...fields,
    at: deps.at(),
  });
  const refused = (refusal: NativeRefusal) => ended({ refusal });
  if (!destinationsOf(game).targets.includes(target)) return refused(NativeRefusal.NotADestination);
  const route = ROUTES[target][device];
  const parts = DEVICE_PACKAGE[target][device];
  if (!route || !parts) return refused(NativeRefusal.NotRunnableHere);
  const tool = await toolFor(deps, target);
  if (!tool) return refused(NativeRefusal.NotRunnableHere);
  const { packages } = deps;
  if (!packages) return refused(NativeRefusal.Unsupported);
  const admitted = await packages.digestOf(game.name, target, request.device);
  if (!admitted) return refused(NativeRefusal.Unsupported);
  const build = await packagedBuild(phonePackageDir(packages.root, game.name, target), parts, target);
  if (!build.ok) return refused(build.refusal);
  if (build.digest !== admitted) return refused(NativeRefusal.NotAnExecutable);
  const bundleId = await deps.bundleIdFor(game.name);
  if (!isBundleId(bundleId)) throw new DeviceRequestError(MESSAGE.badBundleId);
  const id = chosenDevice(await route.list(tool, deps.tools.exec), request.deviceId);
  if (!id) return refused(NativeRefusal.NotRunnableHere);
  const copy = await privateCopy(build.path, target);
  try {
    if ((await packageDigest(copy.path, target).catch(() => null)) !== admitted)
      return refused(NativeRefusal.NotAnExecutable);
    return await installAndStart(deps, { tool, route, id, bundleId, copy: copy.path }, ended, admitted);
  } finally {
    await rm(copy.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** What an install needs once every check passed: the tool, its route, the device, the app id and the copy. */
interface Install {
  tool: string;
  route: DeviceRoute;
  id: string;
  bundleId: string;
  copy: string;
}

/** Install the private copy on the device and start the game; how it ended, with the device and the digest. */
async function installAndStart(
  deps: DeviceLaunchDeps,
  { tool, route, id, bundleId, copy }: Install,
  ended: (fields: Partial<DeviceLaunchResult>) => DeviceLaunchResult,
  digest: string,
): Promise<DeviceLaunchResult> {
  const reached = { deviceId: id, buildDigest: digest };
  const installed = await deps.tools.exec(tool, route.install(id, copy), { timeoutMs: DEVICE_INSTALL_TIMEOUT_MS });
  if (installed.code !== 0) return ended({ outcome: DeviceLaunchOutcome.Failed, ...reached });
  const started = await deps.tools.exec(tool, route.start(id, bundleId), { timeoutMs: DEVICE_START_TIMEOUT_MS });
  const outcome = started.code === 0 ? DeviceLaunchOutcome.Launched : DeviceLaunchOutcome.Failed;
  return ended({ outcome, ...reached });
}

/** The package copied into a private folder of the launch's own (0700, never a link followed), under its own name. */
async function privateCopy(source: string, target: DeviceTarget): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "genex-device-launch-"));
  const at = path.join(dir, path.basename(source));
  if (target === BuildTarget.Ios) await cp(source, at, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  else await cp(source, at, { errorOnExist: true });
  return { dir, path: at };
}

/** Whether `file` is a program this process may run. */
async function runnable(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** The Android SDK folders `adb` may sit under, in the order the person's own tools look. */
function sdkRoots(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string[] {
  const defaults: Record<string, string> = {
    [StudioPlatform.Mac]: path.join(home, "Library", "Android", "sdk"),
    [StudioPlatform.Linux]: path.join(home, "Android", "Sdk"),
    [StudioPlatform.Windows]: path.join(env.LOCALAPPDATA ?? home, "Android", "Sdk"),
  };
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, defaults[platform]];
  return roots.filter((root): root is string => typeof root === "string" && path.isAbsolute(root));
}

/** The person's `adb` under their Android SDK, or null. */
export async function locateAdb(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const name = platform === StudioPlatform.Windows ? "adb.exe" : "adb";
  for (const root of sdkRoots(env, home, platform)) {
    const adb = path.join(root, "platform-tools", name);
    if (await runnable(adb)) return adb;
  }
  return null;
}

/** `xcrun` once `xcode-select -p` names a developer folder, or null: never a shim that opens Apple's installer. */
async function selectedXcrun(exec: XcodeExec, platform: NodeJS.Platform): Promise<string | null> {
  if (platform !== StudioPlatform.Mac) return null;
  const selected = await exec(XCODE_SELECT, ["-p"], { timeoutMs: DEVICE_LIST_TIMEOUT_MS });
  return selected.code === 0 && selected.stdout.trim() !== "" ? XCRUN : null;
}

/** The device tools on this host: `execFile`, the selected Xcode's `xcrun`, the person's `adb`. */
export function hostDeviceTools(platform: NodeJS.Platform = process.platform): DeviceTools {
  return {
    exec: execXcode,
    xcrun: () => selectedXcrun(execXcode, platform),
    adb: () => locateAdb(process.env, os.homedir(), platform),
  };
}
