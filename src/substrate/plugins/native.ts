import { constants } from "node:fs";
import {
  access as accessFile,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  NativeJobState,
  NativeRuntimeState,
  PluginService,
  RuntimeArchive,
  runtimePinFor,
  type PluginManifest,
  type PluginBinding,
  type PluginNativeJob,
  type PluginNativeRuntime,
  type PluginNativeStatus,
  type PluginNativeResult,
  type PluginRuntimeInstall,
  type PluginRuntimePin,
} from "../../shared/plugins.ts";
import { StudioPlatform } from "../../shared/boot.ts";
import { InstallPhase } from "../../shared/model-install.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { assertRelativePath, containedReal, isInside } from "../paths.ts";
import { download, DownloadStatus } from "../bonsai/download.ts";
import { atomicWriteJson, openNoFollow } from "../fsx.ts";
import {
  NativeEndReason,
  type NativeJobSandbox,
  type NativeProcessRequest,
  type NativeProcessResult,
  runNativeProcess,
  runSandboxedNativeProcess,
  runtimeRoot,
} from "./native-process.ts";
import { candidatePaths, hostCandidateDeps } from "./native-candidates.ts";
import { insideWindowsPath } from "../windows-sandbox.ts";
import { SandboxLaunchCode, SandboxLaunchError } from "../sandbox-unavailable.ts";
import { credentialHomes } from "../credential-homes.ts";
import { errorMessage } from "../../shared/errors.ts";

const exec = promisify(execFile);
/**
 * How long a version probe may take. A program's first start after it was unpacked or after a
 * restart is slow where antivirus scans it: Blender 5.2.1's `--version` took 15.8 s cold on a
 * 4-core Windows 11 VM with Defender (then 0.2 s), so 8 s read a good Blender as broken.
 */
const VERSION_PROBE_TIMEOUT_MS = 30 * SECOND_MS;
/** The first probe of a runtime Genex just unpacked, which every one of its files is scanned for. */
const FRESH_RUNTIME_PROBE_TIMEOUT_MS = 2 * MINUTE_MS;
const VERSION_PROBE_MAX_BUFFER = 16000;
const DISK_RESERVE_BYTES = 256 * 1024 ** 2;
const HDIUTIL_TIMEOUT_MS = 30 * SECOND_MS;
const TAR_LIST_TIMEOUT_MS = 30 * SECOND_MS;
const TAR_LIST_MAX_BUFFER = 4 * 1024 ** 2;
/** A pinned Windows Blender is a zip of about 7,500 files; Defender scans each one as it lands. */
const TAR_EXTRACT_TIMEOUT_MS = 10 * MINUTE_MS;
/** A Studio native job id: a UUID, so it names a folder and never a path. */
const idPattern = /^[a-f0-9-]{36}$/;
/** A runtime's version as its probe reads it: x.y.z, or x.y (read as x.y.0: Godot names a first release 4.3). */
const SEMVER = /^\d+\.\d+(\.\d+)?$/;
/** The environment a runtime's version probe runs with: nothing of Studio's. */
const PROBE_ENV = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
/** On Windows, only where Windows is: a program cannot start its DLLs without `SystemRoot`. */
const windowsProbeEnv = () => ({ SystemRoot: process.env.SystemRoot ?? "C:\\Windows" });
/** The archiver every pinned runtime is unpacked with: the system's own tar (bsdtar on Windows, which reads zip too). */
const tarProgram = () =>
  process.platform === StudioPlatform.Windows
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "/usr/bin/tar";
/** This computer, as a pinned download names the one it is for (`NativePlatform`). */
const hostPlatform = () => `${process.platform}-${process.arch}`;
/** Input path segments a job may never be handed: dotfiles, dependencies, agent instructions and key material. */
const PROTECTED_INPUT_SEGMENTS = ["node_modules", "AGENTS.md", "CLAUDE.md"];
const SECRET_NAME = /^(credentials|secrets|id_rsa|id_ed25519)(\.|$)/i;
const KEY_FILE = /\.(pem|key|p12|pfx|keystore)$/i;
/** Install phases after which nothing is running any more. */
const FINISHED_INSTALL_PHASES = new Set<string>([
  InstallPhase.Ready,
  InstallPhase.Failed,
  InstallPhase.Cancelled,
  InstallPhase.Interrupted,
]);

/** What an emitted native record is: an install's progress or a job's state. Also persisted in the install record. */
const NativeEventKind = { RuntimeInstall: "runtime-install", NativeJob: "native-job" } as const;

const MESSAGE = {
  OutputIsLink: "Job output is a link, not a regular file",
  OutputNotRegular: "Job output is not a regular file",
  OutputHardLinked: "Job output is hard-linked to another file",
  OutputChanged: "Job output changed while it was being delivered",
  LinkOutside: (link: string) => `Runtime link ${link} leads outside the runtime`,
  UnsupportedVersion: "The runtime did not report a supported version.",
  TooOld: (label: string, version: string, minimum: string) => `${label} ${version}; requires ${minimum} or newer.`,
  Found: (label: string, version: string) => `${label} ${version} found`,
  ProbeFailed: "Runtime probe failed. Recheck this installation.",
  Missing: (label: string, installable: boolean) =>
    `${label} is not installed. ${installable ? "Download its pinned runtime from plugin setup." : "Install it using the plugin publisher’s guidance."}`,
  UndeclaredRuntime: "Undeclared runtime",
  InstallInterrupted: "Installation was interrupted. Retry to reuse verified download bytes.",
  CancelNeedsAction: "Only a user setup action can cancel runtime installation",
  UnknownRuntimeOperation: "Unknown runtime operation",
  InstallNeedsAction: "Runtime installation requires its trusted setup action",
  InvalidJobId: "Invalid job id",
  JobInterrupted: "Studio or plugin closed before job completion. Inspect existing files; the job was not replayed.",
  NeedsProject: "A native job requires an authorized project",
  UndeclaredRecipe: "Undeclared job recipe",
  UnexpectedInputs: "Unexpected native job inputs",
  ProtectedInput: "Protected native input",
  InputCrossesLink: "Native input crosses a symbolic link",
  InputNotFile: "Native input must be a file",
  InvalidValue: (key: string) => `Invalid job value: ${key}`,
  InputChanged: "Native input changed during staging",
  OutputTooLarge: (total: number, limit: number) =>
    `Native job output is ${total} bytes; the declared aggregate size limit is ${limit} bytes, including renders. Original inputs were preserved.`,
  NoOutput: "Runtime exited successfully but produced no declared output",
  SandboxNotStarted: "Genex's sandbox has not started yet. Try again in a moment.",
  NoPinHere: (label: string) =>
    `Genex has no download of ${label} for this computer. Install it yourself, then check again.`,
  NotGrantedYet: (folder: string) =>
    `Genex is still giving its sandbox access to ${folder}. Try again once the agents' current work has finished, or restart Genex.`,
  NoSpace: "Not enough space for the pinned runtime and staging copy",
  UnsafeArchive: "Unsafe runtime archive",
} as const;

/** Whether `version` is at least `minimum`, comparing major, minor and patch. */
const versionAtLeast = (version: string, minimum: string) => {
  const parts = (text: string) => [...text.split(".").map(Number), 0, 0, 0].slice(0, 3);
  const a = parts(version),
    b = parts(minimum);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return Number(a[i]) > Number(b[i]);
  }
  return true;
};
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
/** An archive entry that would land outside the folder it is unpacked in: absolute, a drive, a parent, or a Windows separator. */
const isUnsafeArchiveEntry = (name: string) =>
  name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\\") || name.split("/").includes("..");
/** A path segment a native job must never see: a dotfile, dependencies, an agent file or key material. */
const isProtectedInputSegment = (segment: string) =>
  segment.startsWith(".") ||
  PROTECTED_INPUT_SEGMENTS.includes(segment) ||
  SECRET_NAME.test(segment) ||
  KEY_FILE.test(segment);

/**
 * The folder a Windows runtime runs from when it lies in the person's profile, which the sandbox
 * user reads only once granted; null for one outside it (or off Windows).
 */
function profileRuntimeRoot(binary: string): string | null {
  if (process.platform !== StudioPlatform.Windows) return null;
  const folder = runtimeRoot(binary);
  return insideWindowsPath(os.homedir(), folder) ? folder : null;
}

/** The state a finished native process leaves its job in. */
function jobStateFor(result: { code: number | null; reason: string }): NativeJobState {
  if (result.reason === NativeEndReason.Cancelled) return NativeJobState.Cancelled;
  return result.code === 0 ? NativeJobState.Completed : NativeJobState.Failed;
}

/**
 * Deliver one declared job output from the unsandboxed main process without following a link:
 * the file must be a regular, singly linked file inside `outputDir`, opened with O_NOFOLLOW and
 * checked by device and inode against what was inspected, so a job racing a symlink or a hard
 * link into place cannot have Studio copy something the sandbox denied it. Returns its size.
 */
export async function copyDeclaredOutput(outputDir: string, file: string, dest: string): Promise<number> {
  assertRelativePath(file);
  const info = await lstat(path.join(outputDir, file));
  if (info.isSymbolicLink()) throw new Error(MESSAGE.OutputIsLink);
  if (!info.isFile()) throw new Error(MESSAGE.OutputNotRegular);
  if (info.nlink !== 1) throw new Error(MESSAGE.OutputHardLinked);
  const handle = await openNoFollow(await containedReal(outputDir, file), constants.O_RDONLY);
  try {
    const opened = await handle.stat(),
      now = await stat(await containedReal(outputDir, file));
    const sameAsInspected = opened.dev === info.dev && opened.ino === info.ino;
    const stillThere = now.dev === opened.dev && now.ino === opened.ino;
    const unchanged = opened.isFile() && opened.nlink === 1 && sameAsInspected && stillThere;
    if (!unchanged) throw new Error(MESSAGE.OutputChanged);
    const destination = await open(dest, "wx", 0o644);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) await destination.writeFile(chunk);
    } finally {
      await destination.close();
    }
    return opened.size;
  } finally {
    await handle.close();
  }
}
/**
 * Copy an unpacked runtime (an `.app` from a mounted image) keeping its links as written, so a
 * framework's `Versions/Current -> A` still resolves once the image is detached. A link that is
 * absolute or leads outside the copy is refused rather than left pointing into the mount.
 */
export async function copyRuntimeTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        if (path.isAbsolute(target) || !isInside(destination, path.resolve(dir, target)))
          throw new Error(MESSAGE.LinkOutside(path.relative(destination, full)));
      } else if (entry.isDirectory()) await walk(full);
    }
  };
  if ((await lstat(destination)).isDirectory()) await walk(destination);
}
export interface NativeInvocation {
  method: string;
  name: string;
  signal: AbortSignal;
}
type Emit = (event: unknown) => void;
/** How a call reaches a plugin's backend: a person's setup action, or an agent's tool. */
const Invocation = { Action: "action", Tool: "tool" } as const;

/** Whether one of `entries` is named `name` and asks the person first. */
const confirmedEntry = (entries: ReadonlyArray<{ name: string; confirmation?: string }>, name: string) =>
  entries.some((entry) => entry.name === name && Boolean(entry.confirmation));

/**
 * Whether the person confirmed this install: their own setup action, or an agent's tool of the same
 * name whose card they answered (a tool with a `confirmation` asks before it runs). Either way the
 * download is the manifest's pinned one: no call chooses a binary or a URL.
 */
function installConfirmed(
  manifest: PluginManifest,
  install: { action: string },
  invocation: Pick<NativeInvocation, "method" | "name">,
): boolean {
  if (invocation.name !== install.action) return false;
  if (invocation.method === Invocation.Tool) return confirmedEntry(manifest.tools, install.action);
  return invocation.method === Invocation.Action && confirmedEntry(manifest.actions, install.action);
}
type RuntimeInstall = PluginRuntimePin;

/** The pinned download for this computer the person confirmed; refused without a confirmed action, or with no download here. */
function confirmedPin(
  manifest: PluginManifest,
  runtime: PluginNativeRuntime,
  invocation: Pick<NativeInvocation, "method" | "name">,
  platform: string,
): RuntimeInstall {
  const pins = [...(runtime.install ? [runtime.install] : []), ...(runtime.installs ?? [])];
  if (!pins.some((pin) => installConfirmed(manifest, pin, invocation))) throw new Error(MESSAGE.InstallNeedsAction);
  const install = runtimePinFor(runtime, platform);
  if (!install) throw new Error(MESSAGE.NoPinHere(runtime.label));
  if (!installConfirmed(manifest, install, invocation)) throw new Error(MESSAGE.InstallNeedsAction);
  return install;
}
/**
 * The folders one native job works in: its record's folder, and where it stages inputs, writes
 * outputs and keeps scratch (under the record's folder, or on Windows under the granted work folder).
 */
interface JobDirs {
  id: string;
  jobDir: string;
  output: string;
  scratch: string;
  inputDir: string;
  /** Windows: where the plugin's own files the job reads are copied, since its package is not granted. */
  packageDir?: string;
}

/** Only declared inputs and values, as objects. */
function hasOnlyDeclaredArguments(recipe: PluginNativeJob, args: any): boolean {
  const bothObjects = [args.inputs, args.values].every((part) => Boolean(part) && typeof part === "object");
  if (!bothObjects) return false;
  const undeclaredInput = Object.keys(args.inputs).some((k) => !recipe.inputs.includes(k));
  const undeclaredValue = Object.keys(args.values).some((k) => !Object.hasOwn(recipe.values, k));
  return !undeclaredInput && !undeclaredValue;
}

/** Each declared input, resolved inside the game and refused when protected, linked or not a file. */
async function resolveInputs(
  recipe: PluginNativeJob,
  requested: Record<string, string>,
  binding: PluginBinding,
): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {};
  for (const key of recipe.inputs) {
    const input = requested[key];
    assertRelativePath(input);
    if (input.split("/").some(isProtectedInputSegment)) throw new Error(MESSAGE.ProtectedInput);
    const resolved = await containedReal(binding.directory, input);
    if (resolved !== path.join(await realpath(binding.directory), input)) throw new Error(MESSAGE.InputCrossesLink);
    if (!(await stat(resolved)).isFile()) throw new Error(MESSAGE.InputNotFile);
    inputs[key] = resolved;
  }
  return inputs;
}

/** A job value is text within the rule's length that matches its pattern. */
function valueFitsRule(rule: PluginNativeJob["values"][string], value: unknown): boolean {
  if (typeof value !== "string" || value.length > rule.maxLength) return false;
  return new RegExp(rule.pattern).test(value);
}

function validateValues(recipe: PluginNativeJob, values: Record<string, unknown>): void {
  for (const [key, rule] of Object.entries(recipe.values)) {
    const value = values[key];
    if (!valueFitsRule(rule, value)) throw new Error(MESSAGE.InvalidValue(key));
  }
}

/**
 * Copy one declared input into the job, hashing it on the way. The source is opened without
 * following links and must still be the file that was resolved.
 */
async function stageInput(source: string, relative: string, staged: string, binding: PluginBinding): Promise<string> {
  const hash = createHash("sha256");
  const handle = await openNoFollow(source, constants.O_RDONLY);
  try {
    const opened = await handle.stat(),
      current = await stat(await containedReal(binding.directory, relative));
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino)
      throw new Error(MESSAGE.InputChanged);
    const destination = await open(staged, "wx", 0o600);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        await destination.writeFile(chunk);
      }
    } finally {
      await destination.close();
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** A file of the plugin's package the job reads: in place, or copied into `packageDir` when the job cannot read the package. */
async function packageFile(directory: string, name: string, packageDir: string | undefined): Promise<string> {
  const source = await containedReal(directory, name);
  if (!packageDir) return source;
  const copy = path.join(packageDir, name);
  await mkdir(path.dirname(copy), { recursive: true });
  await copyFile(source, copy);
  return copy;
}

/** The runtime's argv: literal arguments, package files, staged inputs, output paths and checked values. */
async function jobArgv(
  recipe: PluginNativeJob,
  directory: string,
  inputs: Record<string, string>,
  dirs: Pick<JobDirs, "output" | "packageDir">,
  values: Record<string, string>,
): Promise<string[]> {
  const argv: string[] = [];
  for (const arg of recipe.args) {
    if (typeof arg === "string") argv.push(arg);
    else if (arg.source === "package") argv.push(await packageFile(directory, arg.name, dirs.packageDir));
    else if (arg.source === "input") argv.push(inputs[arg.name]);
    else if (arg.source === "output") argv.push(path.join(dirs.output, arg.name));
    else argv.push(values[arg.name]);
  }
  return argv;
}

/** Record which declared outputs exist as regular files, refusing a total past the declared limit. */
async function collectOutputs(recipe: PluginNativeJob, output: string, record: PluginNativeResult): Promise<void> {
  let total = 0;
  for (const file of recipe.outputs) {
    const info = await lstat(path.join(output, file)).catch((e: NodeJS.ErrnoException) => {
      if (isMissing(e)) return null;
      throw e;
    });
    if (!info) continue;
    await containedReal(output, file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(MESSAGE.OutputNotRegular);
    total += info.size;
    record.files.push(file);
  }
  if (total > recipe.maxAssetBytes) throw new Error(MESSAGE.OutputTooLarge(total, recipe.maxAssetBytes));
}

/** Copy only the declared outputs into a delivery folder and point the record at it. */
async function deliverOutputs(jobDir: string, output: string, record: PluginNativeResult): Promise<void> {
  // Never deliver undeclared files written by the script alongside its intended outputs.
  const delivery = path.join(jobDir, "delivery");
  await mkdir(delivery);
  for (const file of record.files) {
    const dest = path.join(delivery, file);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyDeclaredOutput(output, file, dest);
  }
  record.output = delivery;
}

/**
 * One runtime install's progress record: every change is emitted and written in order. `flush`
 * waits for the writes and fails when one failed; `settle` only waits.
 */
function installRecorder(runtime: PluginNativeRuntime, total: number, jobFile: string, emit: Emit) {
  let update = Promise.resolve();
  let writeFailure: unknown;
  let record: PluginRuntimeInstall = {
    runtime: runtime.id,
    phase: InstallPhase.Preflight,
    completed: 0,
    total,
    active: true,
    updatedAt: new Date().toISOString(),
  };
  const progress = (phase: PluginRuntimeInstall["phase"], extra: Partial<PluginRuntimeInstall> = {}) => {
    record = {
      ...record,
      ...extra,
      phase,
      active: !FINISHED_INSTALL_PHASES.has(phase),
      updatedAt: new Date().toISOString(),
    };
    const event = { kind: NativeEventKind.RuntimeInstall, ...record };
    emit(event);
    update = update
      .then(() => atomicWriteJson(jobFile, event))
      .catch((e) => {
        writeFailure = e;
      });
  };
  const settle = () => update;
  const flush = async () => {
    await update;
    if (writeFailure) throw writeFailure;
  };
  return { progress, settle, flush };
}

/** Where a runtime install's staged, active and previous copies live, and what it has done so far. */
interface RuntimeSwap {
  stage: string;
  destination: string;
  previous: string;
  mount?: string;
  activated: boolean;
  hadPrevious: boolean;
}

/** Move the staged runtime into place, keeping the previous one to restore if anything later fails. */
async function activateRuntime(swap: RuntimeSwap): Promise<void> {
  await rm(swap.previous, { recursive: true, force: true });
  await rename(swap.destination, swap.previous)
    .then(() => {
      swap.hadPrevious = true;
    })
    .catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  try {
    await rename(swap.stage, swap.destination);
    swap.activated = true;
  } catch (e) {
    if (swap.hadPrevious) await rename(swap.previous, swap.destination);
    throw e;
  }
}

/** Unpack a pinned disk image: mount it, copy the entry, detach before the probe. */
async function extractDmg(
  install: RuntimeInstall,
  archive: string,
  downloads: string,
  swap: RuntimeSwap,
  signal: AbortSignal,
) {
  const mount = path.join(downloads, `mount-${randomUUID()}`);
  swap.mount = mount;
  await mkdir(mount);
  await exec("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-quiet", "-mountpoint", mount, archive], {
    signal,
    timeout: HDIUTIL_TIMEOUT_MS,
  });
  const source = await containedReal(mount, install.entry);
  await copyRuntimeTree(source, path.join(swap.stage, install.entry));
  // Detach before the probe: a runtime that still reaches into the image fails here, not later.
  await exec("/usr/bin/hdiutil", ["detach", "-quiet", mount], { timeout: HDIUTIL_TIMEOUT_MS });
  await rm(mount, { recursive: true, force: true });
  swap.mount = undefined;
}

/**
 * Unpack a pinned tarball or zip after refusing absolute, drive, parent-relative or backslashed
 * entries. The system's tar reads both (on Windows it is bsdtar, which reads zip as it reads tar).
 */
async function extractArchive(archive: string, stage: string, signal: AbortSignal) {
  const listing = await exec(tarProgram(), ["-tf", archive], {
    signal,
    timeout: TAR_LIST_TIMEOUT_MS,
    maxBuffer: TAR_LIST_MAX_BUFFER,
    windowsHide: true,
  });
  if (listing.stdout.split(/\r?\n/).some(isUnsafeArchiveEntry)) throw new Error(MESSAGE.UnsafeArchive);
  await exec(tarProgram(), ["-xf", archive, "-C", stage], {
    signal,
    timeout: TAR_EXTRACT_TIMEOUT_MS,
    windowsHide: true,
  });
}

/**
 * Windows: where native jobs work and pinned runtimes live, two folders the process sandbox is
 * granted when it starts (srt-win changes grants only while no sandboxed command runs, and agents
 * keep commands running), and the sandbox every job runs in. Records and deliveries stay in the
 * plugin's storage, which no sandboxed process may write.
 */
export interface WindowsNativeHost {
  /** The process sandbox, once it has started. */
  sandbox(): NativeJobSandbox | null;
  /** One folder per job: its staged inputs, outputs and scratch. */
  work: string;
  /** One folder per plugin: its pinned runtimes. */
  runtimes: string;
}

/** What the service reads beside a call: a plugin's settings (`setting:` candidates), and Windows's job host. */
export interface NativeServiceOptions {
  settings?: (pluginId: string) => Promise<Record<string, unknown>>;
  windows?: WindowsNativeHost;
  /** This computer as a pin names it (`win32-x64`); the host's own when left out. */
  platform?: string;
}

/** Whose runtime is detected: the plugin, by its id, and its settings. */
export interface RuntimeOwner {
  pluginId?: string;
  settings?: Record<string, unknown>;
}

/** Reusable host-owned runtime and job service. Plugin code remains trusted executable code;
 * only declared managed jobs get this filesystem/network confinement. */
export class PluginNativeServices {
  readonly studioData: string;
  readonly protectedPaths: string[];
  readonly #options: NativeServiceOptions;
  #installing = new Map<string, Promise<PluginNativeStatus>>();
  #installControllers = new Map<string, AbortController>();
  #active = new Set<string>();
  constructor(studioData: string, protectedPaths: string[], options: NativeServiceOptions = {}) {
    this.studioData = studioData;
    this.protectedPaths = protectedPaths;
    this.#options = options;
  }
  get #platform(): string {
    return this.#options.platform ?? hostPlatform();
  }
  /** The folder a plugin's pinned runtimes are installed in: Windows's granted folder, else its storage. */
  #runtimesFolder(root: string, pluginId: string | undefined): string {
    const windows = this.#options.windows;
    return windows && pluginId ? path.join(windows.runtimes, pluginId) : path.join(root, "runtimes");
  }
  /** Who owns `manifest`'s runtimes, with the settings its `setting:` candidates read. */
  async #owner(manifest: PluginManifest): Promise<RuntimeOwner> {
    const settings = (await this.#options.settings?.(manifest.id).catch(() => ({}))) ?? {};
    return { pluginId: manifest.id, settings };
  }
  /** Probe one candidate binary: ready, or why not. Undefined when it does not exist. */
  async #probe(
    runtime: PluginNativeRuntime,
    candidate: string,
    timeout = VERSION_PROBE_TIMEOUT_MS,
  ): Promise<PluginNativeStatus | undefined> {
    try {
      await accessFile(candidate, constants.X_OK);
      const binary = await realpath(candidate);
      const result = await exec(binary, runtime.version.args, {
        timeout,
        maxBuffer: VERSION_PROBE_MAX_BUFFER,
        env: process.platform === StudioPlatform.Windows ? windowsProbeEnv() : PROBE_ENV,
        windowsHide: true,
      });
      const version = new RegExp(runtime.version.pattern).exec(result.stdout)?.[1];
      if (!version || !SEMVER.test(version))
        return { state: NativeRuntimeState.Failed, path: binary, detail: MESSAGE.UnsupportedVersion };
      if (!versionAtLeast(version, runtime.version.minimum))
        return {
          state: NativeRuntimeState.Incompatible,
          path: binary,
          version,
          detail: MESSAGE.TooOld(runtime.label, version, runtime.version.minimum),
        };
      return { state: NativeRuntimeState.Ready, path: binary, version, detail: MESSAGE.Found(runtime.label, version) };
    } catch (e) {
      if (isMissing(e)) return undefined;
      return { state: NativeRuntimeState.Failed, path: candidate, detail: MESSAGE.ProbeFailed };
    }
  }
  /** Every path to probe for `runtime`, in order: its declared candidates, then Genex's own pinned copy. */
  async #candidates(runtime: PluginNativeRuntime, root: string, owner: RuntimeOwner): Promise<string[]> {
    const deps = hostCandidateDeps({ studio: this.studioData, storage: root, settings: owner.settings ?? {} });
    const declared = await Promise.all(runtime.candidates.map((c) => candidatePaths(c, deps)));
    const pin = runtimePinFor(runtime, this.#platform);
    const pinned = pin ? [path.join(this.#runtimesFolder(root, owner.pluginId), runtime.id, pin.executable)] : [];
    return [...declared.flat(), ...pinned];
  }
  async detect(runtime: PluginNativeRuntime, root: string, owner: RuntimeOwner = {}): Promise<PluginNativeStatus> {
    const pin = runtimePinFor(runtime, this.#platform);
    const download = pin ? { download: { action: pin.action, url: pin.url, bytes: pin.bytes } } : {};
    let incompatible: PluginNativeStatus | undefined;
    for (const candidate of await this.#candidates(runtime, root, owner)) {
      const status = await this.#probe(runtime, candidate);
      if (status?.state === NativeRuntimeState.Ready) return { ...status, ...download };
      if (status) incompatible = status;
    }
    const missing = { state: NativeRuntimeState.Missing, detail: MESSAGE.Missing(runtime.label, !!pin) };
    return { ...(incompatible ?? missing), ...download };
  }
  async call(
    manifest: PluginManifest,
    directory: string,
    root: string,
    method: string,
    args: any,
    binding: PluginBinding | undefined,
    invocation: NativeInvocation,
    emit: Emit,
  ): Promise<unknown> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (method.startsWith("runtime.")) return this.#runtimeCall(manifest, root, method, args, invocation, emit);
    const jobs = path.join(root, "native-jobs");
    await mkdir(jobs, { recursive: true, mode: 0o700 });
    if (method === PluginService.NativeJobs || method === PluginService.NativeResult)
      return this.#readJobs(jobs, method, args, binding);
    if (method !== PluginService.NativeRun || !binding) throw new Error(MESSAGE.NeedsProject);
    return this.#run(manifest, directory, root, jobs, args, binding, invocation, emit);
  }
  async #runtimeCall(
    manifest: PluginManifest,
    root: string,
    method: string,
    args: any,
    invocation: NativeInvocation,
    emit: Emit,
  ): Promise<unknown> {
    const runtime = manifest.nativeRuntimes?.find((r) => r.id === args?.runtime);
    if (!runtime) throw new Error(MESSAGE.UndeclaredRuntime);
    const owner = await this.#owner(manifest);
    if (method === PluginService.RuntimeDetect) return this.#detectAndGrant(runtime, root, owner);
    const key = path.join(root, runtime.id);
    if (method === PluginService.RuntimeInstallation) return this.#installation(root, runtime, key);
    if (method === PluginService.RuntimeCancelInstall) {
      if (invocation.method !== Invocation.Action) throw new Error(MESSAGE.CancelNeedsAction);
      this.#installControllers.get(key)?.abort();
      return true;
    }
    if (method !== PluginService.RuntimeInstall) throw new Error(MESSAGE.UnknownRuntimeOperation);
    const install = confirmedPin(manifest, runtime, invocation, this.#platform);
    const byAgent = invocation.method === Invocation.Tool;
    if (!this.#installing.has(key)) {
      const controller = new AbortController();
      // An agent's call answers once the download starts, so its deadline never cuts the download short.
      const signal = byAgent ? controller.signal : AbortSignal.any([invocation.signal, controller.signal]);
      this.#installControllers.set(key, controller);
      this.#installing.set(
        key,
        this.#install(runtime, install, root, owner, signal, emit).finally(() => {
          this.#installing.delete(key);
          this.#installControllers.delete(key);
        }),
      );
    }
    const installing = this.#installing.get(key);
    if (!byAgent) return installing;
    // The install record says how it ended (`runtime.installation`), so nobody waits on it here.
    installing?.catch(() => {});
    return { started: true };
  }
  /** The last install record; one still marked active with no install running here was interrupted. */
  async #installation(root: string, runtime: PluginNativeRuntime, key: string) {
    const job = JSON.parse(
      await readFile(path.join(root, `runtime-install-${runtime.id}.json`), "utf8").catch(
        (e: NodeJS.ErrnoException) => {
          if (isMissing(e)) return "null";
          throw e;
        },
      ),
    ) as PluginRuntimeInstall | null;
    if (!job?.active || this.#installing.has(key)) return job;
    return { ...job, active: false, phase: InstallPhase.Interrupted, error: MESSAGE.InstallInterrupted };
  }
  async #readJobs(jobs: string, method: string, args: any, binding: PluginBinding | undefined) {
    const single = method === PluginService.NativeResult;
    if (single && !idPattern.test(args?.id)) throw new Error(MESSAGE.InvalidJobId);
    const ids = single ? [args.id] : (await readdir(jobs)).filter((id) => idPattern.test(id));
    const results: PluginNativeResult[] = [];
    for (const id of ids) {
      const job = JSON.parse(
        await readFile(path.join(jobs, id, "job.json"), "utf8").catch(() => "null"),
      ) as PluginNativeResult | null;
      if (!job) continue;
      if (binding && job.project !== binding.project) continue;
      if (job.state === NativeJobState.Running && !this.#active.has(id)) {
        job.state = NativeJobState.Interrupted;
        job.reason = MESSAGE.JobInterrupted;
      }
      results.push(job);
    }
    return single ? (results[0] ?? null) : results;
  }
  /** Check a job request, stage its inputs and run it confined; the record says how it ended. */
  async #run(
    manifest: PluginManifest,
    directory: string,
    root: string,
    jobs: string,
    args: any,
    binding: PluginBinding,
    invocation: NativeInvocation,
    emit: Emit,
  ): Promise<PluginNativeResult> {
    const recipe = manifest.nativeJobs?.find((j) => j.id === args?.job),
      runtime = manifest.nativeRuntimes?.find((r) => r.id === recipe?.runtime);
    if (!recipe || !runtime) throw new Error(MESSAGE.UndeclaredRecipe);
    if (!hasOnlyDeclaredArguments(recipe, args)) throw new Error(MESSAGE.UnexpectedInputs);
    const inputs = await resolveInputs(recipe, args.inputs, binding);
    validateValues(recipe, args.values);
    const status = await this.detect(runtime, root, await this.#owner(manifest));
    if (status.state !== NativeRuntimeState.Ready || !status.path) throw new Error(status.detail);
    invocation.signal.throwIfAborted();
    const dirs = await this.#jobDirs(jobs, randomUUID());
    const { id, jobDir } = dirs;
    // A script gets only the explicitly declared input files. Reading the entire project would
    // also grant Python access to nested .env/private keys and race newly created secret files.
    const inputIdentities: NonNullable<PluginNativeResult["inputs"]> = {};
    for (const key of recipe.inputs) {
      const staged = path.join(dirs.inputDir, key + path.extname(inputs[key]));
      const sha256 = await stageInput(inputs[key], args.inputs[key], staged, binding);
      inputIdentities[key] = { file: args.inputs[key], sha256 };
      inputs[key] = staged;
    }
    const record: PluginNativeResult = {
      inputs: inputIdentities,
      id,
      recipe: recipe.id,
      runtime: runtime.id,
      version: status.version,
      state: NativeJobState.Running,
      project: binding.project,
      output: dirs.output,
      files: [],
      createdAt: new Date().toISOString(),
    };
    const save = async () => {
      await atomicWriteJson(path.join(jobDir, "job.json"), record);
      emit({ kind: NativeEventKind.NativeJob, ...record });
    };
    const argv = await jobArgv(recipe, directory, inputs, dirs, args.values);
    await save();
    this.#active.add(id);
    try {
      await this.#execute(recipe, status.path, argv, directory, root, dirs, record, invocation);
    } catch (e) {
      record.state = invocation.signal.aborted ? NativeJobState.Cancelled : NativeJobState.Failed;
      record.reason = errorMessage(e);
    } finally {
      this.#active.delete(id);
      record.finishedAt = new Date().toISOString();
      await save();
    }
    return record;
  }
  /** A new job's folders, made: under its record's folder, or on Windows its work under the granted work folder. */
  async #jobDirs(jobs: string, id: string): Promise<JobDirs> {
    const jobDir = path.join(jobs, id);
    const windows = this.#options.windows;
    const work = windows ? path.join(windows.work, id) : jobDir;
    const dirs: JobDirs = {
      id,
      jobDir,
      output: path.join(work, "output"),
      scratch: path.join(work, "scratch"),
      inputDir: path.join(work, "inputs"),
      ...(windows ? { packageDir: path.join(work, "package") } : {}),
    };
    await mkdir(jobDir, { recursive: true });
    await mkdir(dirs.output, { recursive: true });
    await mkdir(dirs.scratch, { recursive: true });
    await mkdir(dirs.inputDir);
    return dirs;
  }
  /**
   * `detect`, and on Windows let the sandbox user read a ready runtime that lives in the person's
   * profile (a per-user install, a file they chose): srt-win applies a new grant only while no
   * sandboxed command runs, so it is asked for as soon as the runtime is found, not when a job starts.
   */
  async #detectAndGrant(runtime: PluginNativeRuntime, root: string, owner: RuntimeOwner): Promise<PluginNativeStatus> {
    const status = await this.detect(runtime, root, owner);
    const folder = status.state === NativeRuntimeState.Ready && status.path ? profileRuntimeRoot(status.path) : null;
    if (folder) this.#options.windows?.sandbox()?.allowRead(folder);
    return status;
  }
  /** Run the confined process, then collect and deliver its declared outputs into the record. */
  async #execute(
    recipe: PluginNativeJob,
    binary: string,
    argv: string[],
    directory: string,
    root: string,
    dirs: JobDirs,
    record: PluginNativeResult,
    invocation: NativeInvocation,
  ): Promise<void> {
    const binaryRoot = runtimeRoot(binary);
    const request = {
      binary,
      binaryRoot,
      args: argv,
      cwd: dirs.inputDir,
      scratch: dirs.scratch,
      reads: [binaryRoot, directory, dirs.inputDir],
      writes: [dirs.output],
      denyRead: [
        ...this.protectedPaths,
        path.join(root, "credentials"),
        ...credentialHomes(),
        path.join(os.homedir(), ".genex"),
      ],
      gpu: recipe.gpu,
      signal: invocation.signal,
      timeoutMs: recipe.timeoutMs,
      maxOutputBytes: recipe.maxOutputBytes,
    };
    const result = this.#options.windows
      ? await this.#runOnWindows(this.#options.windows, request)
      : await runNativeProcess(request);
    record.stdout = result.stdout;
    record.stderr = result.stderr;
    record.exitCode = result.code;
    record.reason = result.reason;
    record.state = jobStateFor(result);
    await collectOutputs(recipe, dirs.output, record);
    if (record.state !== NativeJobState.Completed) return;
    if (!record.files.length) throw new Error(MESSAGE.NoOutput);
    await deliverOutputs(dirs.jobDir, dirs.output, record);
  }
  /**
   * A job in Windows's process sandbox. Its work folder is granted to the sandbox when it starts;
   * the runtime's own folder needs a grant only inside the person's profile (Program Files and the
   * Store's folders are readable by every user, and a grant there would need an administrator).
   */
  async #runOnWindows(windows: WindowsNativeHost, request: NativeProcessRequest): Promise<NativeProcessResult> {
    const sandbox = windows.sandbox();
    if (!sandbox) throw new Error(MESSAGE.SandboxNotStarted);
    const folder = profileRuntimeRoot(request.binary);
    if (folder) sandbox.allowRead(folder);
    try {
      return await runSandboxedNativeProcess(sandbox, { ...request, reads: folder ? [folder] : [] });
    } catch (e) {
      if (folder && e instanceof SandboxLaunchError && e.code === SandboxLaunchCode.NotGranted)
        throw new Error(MESSAGE.NotGrantedYet(folder), { cause: e });
      throw e;
    }
  }
  async #install(
    runtime: PluginNativeRuntime,
    install: RuntimeInstall,
    root: string,
    owner: RuntimeOwner,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<PluginNativeStatus> {
    const downloads = path.join(root, "runtime-downloads");
    const recorder = installRecorder(
      runtime,
      install.bytes,
      path.join(root, `runtime-install-${runtime.id}.json`),
      emit,
    );
    const runtimes = this.#runtimesFolder(root, owner.pluginId);
    const destination = path.join(runtimes, runtime.id);
    const swap: RuntimeSwap = {
      stage: path.join(runtimes, `${runtime.id}.staging-${randomUUID()}`),
      destination,
      previous: `${destination}.previous`,
      activated: false,
      hadPrevious: false,
    };
    try {
      recorder.progress(InstallPhase.Preflight);
      await recorder.flush();
      await mkdir(downloads, { recursive: true });
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize < install.bytes + install.unpackedBytes + DISK_RESERVE_BYTES)
        throw new Error(MESSAGE.NoSpace);
      signal.throwIfAborted();
      const archive = await download(
        {
          name: path.basename(new URL(install.url).pathname),
          url: install.url,
          bytes: install.bytes,
          sha256: install.sha256,
        },
        downloads,
        signal,
        (p) =>
          recorder.progress(
            p.status === DownloadStatus.Downloading ? InstallPhase.Downloading : InstallPhase.Verifying,
            {
              completed: p.completed,
              total: p.total,
            },
          ),
      );
      await recorder.flush();
      await mkdir(swap.stage, { recursive: true });
      recorder.progress(InstallPhase.Extracting);
      if (install.format === RuntimeArchive.Dmg) await extractDmg(install, archive, downloads, swap, signal);
      else await extractArchive(archive, swap.stage, signal);
      signal.throwIfAborted();
      await this.#verifyStaged(runtime, install, swap.stage);
      await activateRuntime(swap);
      recorder.progress(InstallPhase.Ready);
      await recorder.flush();
      return this.#detectAndGrant(runtime, root, owner);
    } catch (e) {
      // Failure to durably record activation must not leave a newly installed runtime
      // behind a failed job. Keep the previous verified installation available.
      if (swap.activated) {
        await rename(swap.destination, swap.stage);
        if (swap.hadPrevious) await rename(swap.previous, swap.destination);
      }
      recorder.progress(signal.aborted ? InstallPhase.Cancelled : InstallPhase.Failed, { error: errorMessage(e) });
      await recorder.settle();
      throw e;
    } finally {
      if (swap.mount) {
        await exec("/usr/bin/hdiutil", ["detach", "-quiet", swap.mount], { timeout: HDIUTIL_TIMEOUT_MS }).catch(
          () => {},
        );
        await rm(swap.mount, { recursive: true, force: true });
      }
      await rm(swap.stage, { recursive: true, force: true });
    }
  }
  /** The staged copy has its executable and notices, and its binary reports a supported version. */
  async #verifyStaged(runtime: PluginNativeRuntime, install: RuntimeInstall, stage: string) {
    await containedReal(stage, install.executable);
    for (const notice of install.notices) await containedReal(stage, notice);
    const probe = await this.#probe(runtime, path.join(stage, install.executable), FRESH_RUNTIME_PROBE_TIMEOUT_MS);
    if (probe?.state !== NativeRuntimeState.Ready)
      throw new Error(probe?.detail ?? MESSAGE.Missing(runtime.label, false));
  }
}
