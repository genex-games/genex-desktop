/**
 * Installing Unity for the person, from the Unity setup card. Unity Hub comes from Unity's own
 * download, is checked to be signed by Unity Technologies before it is copied into Applications,
 * and then installs the editor through its own command line (`Unity Hub -- --headless install`),
 * started on its own so it goes on while Genex restarts; its output is kept in the plugin's storage
 * and read back for the card's progress. Signing in stays the person's: Genex only opens Hub. Do it
 * for me runs every step in order and waits for the person's sign-in between them; Stop ends
 * whichever step runs (Hub's download and copy, its listing of releases, its install) and starts
 * none after it. The install is known by its process only while that process is Unity Hub; once
 * Genex sees it ended, its record says so, so a process that later gets its id is never taken for
 * it nor signalled.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, open, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import {
  APP_COPY_MS,
  AppInstallError,
  AppInstallProblem,
  type AppRunner,
  downloadFile,
  placeApp,
} from "../../substrate/app-install.ts";
import { atomicWriteJson, readJsonIfExists } from "../../substrate/fsx.ts";
import { type EditorsEnv, compareVersions, findHub } from "./editors.ts";
import { getUnityLaunch, type Launch } from "./editor-launch.ts";
import { hasLicense, type InstallJob, JobKind, JobState, readFacts, UNITY_SIZE_GB } from "./setup-steps.ts";

/** Unity's own download of Hub for each Mac processor. */
const HUB_DMG: Record<string, string> = {
  arm64: "https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup-arm64.dmg",
  x64: "https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup-x64.dmg",
};
/** Unity Technologies' Apple team: the only signer whose Hub Genex installs. */
export const UNITY_TEAM_ID = "9QW8UQUTAA";
/** The app inside Hub's disk image, and Hub's program inside the app. */
const HUB_APP = "Unity Hub.app";
const HUB_PROGRAM = path.posix.join("Contents", "MacOS", "Unity Hub");
/** The end of Hub's program path as the computer lists its process, wherever Hub is. */
const HUB_PROCESS = path.posix.join(HUB_APP, HUB_PROGRAM);
/** The Unity release line Genex's Unity work was measured on; its newest final release is installed. */
export const INSTALL_LINE = "6000.3";
/** The plugin storage folder holding the install's record, its output and Hub's download. */
const SETUP_FOLDER = "unity-setup";
const EDITOR_RECORD = "editor.json";
const EDITOR_LOG = "editor-install.log";
/** How long Hub may take to list Unity's releases, and the most of its output read. */
const RELEASES_MS = 2 * MINUTE_MS;
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
/** How much of the install's output is read back for its progress. */
const LOG_TAIL_BYTES = 64 * 1024;
/** How long Do it for me waits for the person to sign in, and how often it looks. */
const SIGN_IN_WAIT_MS = 30 * MINUTE_MS;
const SIGN_IN_POLL_MS = 3 * SECOND_MS;
const GIGABYTE = 1024 * 1024 * 1024;
/** A Mac's own program that lists processes, and how long it may take. */
const PS = "/bin/ps";
const PS_MS = 10 * SECOND_MS;

/** What the card and its buttons say to the person, in the language of the moment they say it. */
const MESSAGE = {
  Download: (why: string) => t("Couldn't download Unity Hub ({why}). Check your connection, then try again.", { why }),
  NotUnity: () => t("This Unity Hub isn't signed by Unity, so Genex didn't install it."),
  Copy: (why: string) => t("Couldn't put Unity Hub in Applications ({why}).", { why }),
  NoHub: () => t("Get Unity Hub first."),
  List: (why: string) => t("Unity Hub couldn't list the Unity versions to install ({why}).", { why }),
  NoRelease: () => t("Unity Hub listed no Unity 6 to install. Open Unity Hub and install Unity 6 from Installs."),
  Space: (free: number) =>
    t("Unity 6 needs about {size} GB; {free} GB is free. Free up space, then try again.", {
      size: UNITY_SIZE_GB,
      free: free.toFixed(1),
    }),
  YouStopped: () => t("You stopped it. Try again when you want Unity."),
  Elsewhere: (version: string) =>
    t(
      "Unity Hub says it installed Unity {version}, but not where Genex looks for editors. Open Unity Hub, Installs, and check where it went.",
      { version },
    ),
  Stopped: (line: string) =>
    line
      ? t("Unity's install stopped: {line}. Try again, or install it in Unity Hub.", { line })
      : t("Unity's install stopped. Try again, or install it in Unity Hub."),
  OnlyMac: () => t("Genex installs Unity Hub on a Mac only: get it from Unity's page."),
} as const;

/**
 * The record of an editor install Genex started: the version, the program's id and when; an
 * install that could not start keeps -1 and whether Hub's own window may still get past it; one
 * seen ended (or stopped) is never looked for by its id again.
 */
type EditorRecord = {
  version: string;
  pid: number;
  startedAt: string;
  inHub?: true;
  stopped?: true;
  ended?: true;
};

/** What the installer reaches besides the files: the network, programs, processes, disks and the clock. */
export interface InstallDeps {
  env: EditorsEnv;
  /** This Mac's processor as Unity names it: arm64 or x64. */
  arch: string;
  fetch: typeof fetch;
  /** Runs a program and answers what it printed, and on its error stream; rejects when it fails. */
  run: AppRunner;
  /** Starts a program on its own, its output into `log`, and answers its process id. */
  start: (command: string, args: string[], log: string) => Promise<number>;
  /** The program a running process runs, as the computer lists it; undefined once it is gone. */
  programOf: (pid: number) => Promise<string | undefined>;
  /** Sends a signal to a process, or to its group with a negative id; a gone one is no error. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  freeBytes: (folder: string) => Promise<number>;
  open: (launch: Launch) => Promise<void>;
  now: () => Date;
  sleep: (ms: number) => Promise<unknown>;
}

const folderIn = (storage: string) => path.join(storage, SETUP_FOLDER);

/** The newest final release of the line Genex was measured on, else the newest final Unity 6. */
export function chooseRelease(versions: readonly string[]): string | undefined {
  const finals = versions.filter((version) => /^6\d{3}\.\d+\.\d+f\d+$/.test(version)).sort(compareVersions);
  return finals.find((version) => version.startsWith(`${INSTALL_LINE}.`)) ?? finals[0];
}

/** Hub's last line once every task of an install went through. */
const HUB_DONE = /all tasks completed successfully/i;
/** A terminal escape Hub prints to redraw its progress, and a log line of Hub's own Chromium. */
const TERMINAL_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
const CHROMIUM_LOG = /^\[\d+:\d+\/\d+\.\d+:/;
/** One of Hub's progress lines: `[Unity (6000.3.26f1)] downloading 12.00%`, or `installing...` with none. */
const PROGRESS = /\]\s+([a-z]+)(?:\s+(\d{1,3}(?:\.\d+)?)\s?%|\s*[a-z ]*\.\.\.)/i;

/**
 * The versions in Hub's `editors --releases --json` answer, which may print other lines around it,
 * Chromium's own log lines (in square brackets) among them.
 */
export function releasesIn(output: string): string[] {
  const text = output
    .split(/\r?\n/)
    .filter((line) => !CHROMIUM_LOG.test(line.trim()))
    .join("\n");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const list: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => (item as { version?: unknown })?.version)
      .filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/**
 * How far an install got from Hub's output: its phase and percentage from its last progress line
 * (a bare percentage when it prints no phase), and its last line of its own for a stop, past the
 * terminal escapes and Chromium's log lines Hub prints between.
 */
export function progressIn(log: string): { percent?: number; phase?: string; last: string } {
  const lines = log
    .replace(TERMINAL_ESCAPE, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line && !CHROMIUM_LOG.test(line));
  const last = (lines.at(-1) ?? "").slice(0, 200);
  const progress = lines.map((line) => PROGRESS.exec(line)).findLast((match) => match !== null);
  if (progress) {
    const phase = (progress[1] ?? "").toLowerCase();
    return progress[2] === undefined ? { phase, last } : { percent: Number(progress[2]), phase, last };
  }
  const percent = [...log.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)]
    .map((match) => Number(match[1]))
    .findLast((v) => v <= 100);
  return { ...(percent !== undefined ? { percent } : {}), last };
}

/** Hub's own program inside its app. */
const hubProgram = (hub: string) => path.posix.join(hub, HUB_PROGRAM);

/**
 * One installer's state: its programs, its storage, Hub's install or the wait for the person's
 * sign-in (kept in memory), and Do it for me while it runs.
 */
interface Installing {
  deps: InstallDeps;
  storage: () => Promise<string>;
  hubJob: InstallJob | null;
  driving: Promise<void> | null;
  /** Stops Hub's download when the person presses Stop; a new one for each Do it for me. */
  stop: AbortController;
}

/** Downloads Hub's disk image into the storage, counting bytes for the card. */
async function download(state: Installing, file: string): Promise<void> {
  const url = HUB_DMG[state.deps.arch] ?? HUB_DMG.x64 ?? "";
  const job: InstallJob = { kind: JobKind.Hub, state: JobState.Running, done: 0 };
  state.hubJob = job;
  await downloadFile(state.deps.fetch, url, file, {
    signal: state.stop.signal,
    onBytes: (done, total) => {
      job.done = done;
      if (total) job.total = total;
    },
  }).catch((error: unknown) => {
    throw new Error(MESSAGE.Download(errorMessage(error)));
  });
}

/** Mounts the image, checks Unity signed its Hub, copies it into Applications and unmounts; a Stop ends it between steps. */
async function copyIn(deps: InstallDeps, image: string, mount: string, signal: AbortSignal): Promise<void> {
  const attach = ["attach", "-nobrowse", "-readonly", "-quiet", "-mountpoint", mount, image];
  await deps.run("/usr/bin/hdiutil", attach, APP_COPY_MS, signal);
  try {
    const trash = path.join(deps.env.home, ".Trash");
    const place = { applications: deps.env.applications, name: HUB_APP, team: UNITY_TEAM_ID, trash };
    await placeApp(deps.run, path.join(mount, HUB_APP), place, signal).catch((error: unknown) => {
      const notSigned = error instanceof AppInstallError && error.problem === AppInstallProblem.NotSigned;
      throw new Error(notSigned ? MESSAGE.NotUnity() : MESSAGE.Copy(errorMessage(error)));
    });
  } finally {
    await deps.run("/usr/bin/hdiutil", ["detach", "-quiet", mount], APP_COPY_MS).catch(() => undefined);
  }
}

/** Gets Unity Hub: on a Mac Genex installs it; elsewhere Unity's page opens. */
async function getHub(state: Installing): Promise<void> {
  const { deps } = state;
  if (await findHub(deps.env)) return;
  if (deps.env.platform !== "darwin") {
    await deps.open(getUnityLaunch(deps.env.platform, undefined));
    throw new Error(MESSAGE.OnlyMac());
  }
  const folder = folderIn(await state.storage());
  await mkdir(folder, { recursive: true });
  const image = path.join(folder, "UnityHubSetup.dmg");
  const mount = path.join(folder, "mount");
  state.hubJob = { kind: JobKind.Hub, state: JobState.Running };
  try {
    await download(state, image);
    await mkdir(mount, { recursive: true });
    await copyIn(deps, image, mount, state.stop.signal);
    state.hubJob = null;
  } catch (error) {
    // A download the person stopped keeps Stop's own words.
    if (!state.stop.signal.aborted)
      state.hubJob = { kind: JobKind.Hub, state: JobState.Failed, why: errorMessage(error) };
    throw error;
  } finally {
    await rm(image, { force: true });
  }
}

/** Whether the install a record names still runs: its process is still Unity Hub, and it was never seen ended. */
async function installRuns(deps: InstallDeps, record: EditorRecord): Promise<boolean> {
  if (record.stopped || record.ended || record.pid <= 0) return false;
  return (await deps.programOf(record.pid))?.endsWith(`/${HUB_PROCESS}`) === true;
}

/**
 * The editor install Genex started, as the card reads it: running, stopped, or none. An install
 * seen ended is recorded so, and its record is dropped once Unity is there.
 */
async function editorJob(state: Installing): Promise<InstallJob | null> {
  const folder = folderIn(await state.storage());
  const file = path.join(folder, EDITOR_RECORD);
  const record = await readJsonIfExists<EditorRecord>(file).catch(() => null);
  if (!record?.version || !Number.isInteger(record.pid)) return null;
  const { percent, phase, last } = progressIn(await tailOf(path.join(folder, EDITOR_LOG)));
  const job = {
    kind: JobKind.Editor,
    version: record.version,
    ...(percent !== undefined ? { percent } : {}),
    ...(phase ? { phase } : {}),
  };
  if (record.stopped) return { ...job, state: JobState.Failed, why: MESSAGE.YouStopped(), stopped: true };
  if (await installRuns(state.deps, record)) return { ...job, state: JobState.Running };
  if (record.pid > 0 && !record.ended) await atomicWriteJson(file, { ...record, ended: true }).catch(() => undefined);
  if ((await readFacts(state.deps.env, null)).editor) {
    await rm(file, { force: true });
    return null;
  }
  // An install that never started keeps its own words; one Hub ran and lost, Hub's window may finish.
  if (record.pid < 0) return { ...job, state: JobState.Failed, why: last, ...(record.inHub ? { inHub: true } : {}) };
  const why = HUB_DONE.test(last) ? MESSAGE.Elsewhere(record.version) : MESSAGE.Stopped(last);
  return { ...job, state: JobState.Failed, why, inHub: true };
}

/** Keeps an install that could not start as a stopped one, with why, for the card; then refuses with it. */
async function failEditor(deps: InstallDeps, folder: string, why: string, inHub = false): Promise<never> {
  const record: EditorRecord = { version: "6", pid: -1, startedAt: deps.now().toISOString() };
  await atomicWriteJson(path.join(folder, EDITOR_RECORD), inHub ? { ...record, inHub: true } : record);
  await writeFile(path.join(folder, EDITOR_LOG), why);
  throw new Error(why);
}

/** Refuses with Stop's own words once the person pressed Stop. */
function unlessStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(MESSAGE.YouStopped());
}

/**
 * Asks Hub for its releases and starts installing the chosen one on its own; answers the record
 * kept. A Stop ends the listing and starts nothing; one that came while the install started ends it.
 */
async function startEditor(deps: InstallDeps, hub: string, folder: string, signal: AbortSignal): Promise<void> {
  const arch = archOf(deps.arch);
  const listing = ["--", "--headless", "editors", "--releases", "--json", "--architecture", arch];
  const listed = await deps.run(hubProgram(hub), listing, RELEASES_MS, signal).catch((error: unknown) => {
    unlessStopped(signal);
    return failEditor(deps, folder, MESSAGE.List(errorMessage(error)), true);
  });
  unlessStopped(signal);
  const version = chooseRelease(releasesIn(listed.out));
  if (!version) return failEditor(deps, folder, MESSAGE.NoRelease(), true);
  const args = ["--", "--headless", "install", "--version", version, "--architecture", arch];
  const pid = await deps.start(hubProgram(hub), args, path.join(folder, EDITOR_LOG));
  const record: EditorRecord = { version, pid, startedAt: deps.now().toISOString() };
  await atomicWriteJson(path.join(folder, EDITOR_RECORD), record);
  if (!signal.aborted) return;
  deps.kill(-pid, "SIGTERM");
  await atomicWriteJson(path.join(folder, EDITOR_RECORD), { ...record, stopped: true });
}

/**
 * Starts Hub installing the newest Unity 6 of Genex's line, once there is room for it. The card
 * shows it started at once, while Hub still lists its releases (up to a minute).
 */
async function installEditor(state: Installing): Promise<void> {
  const { deps } = state;
  const hub = await findHub(deps.env);
  if (!hub) throw new Error(MESSAGE.NoHub());
  if ((await editorJob(state))?.state === JobState.Running) return;
  const folder = folderIn(await state.storage());
  await mkdir(folder, { recursive: true });
  const free = (await deps.freeBytes(deps.env.applications)) / GIGABYTE;
  if (free < UNITY_SIZE_GB) await failEditor(deps, folder, MESSAGE.Space(free));
  state.hubJob = { kind: JobKind.Editor, state: JobState.Running };
  try {
    await startEditor(deps, hub, folder, state.stop.signal);
  } finally {
    if (state.hubJob?.state === JobState.Running) state.hubJob = null;
  }
}

/** Waits for the person to sign in to Hub, up to half an hour. */
async function signedIn(deps: InstallDeps, stop: AbortSignal): Promise<boolean> {
  const ends = deps.now().getTime() + SIGN_IN_WAIT_MS;
  while (deps.now().getTime() < ends && !stop.aborted) {
    if (await hasLicense(deps.env)) return true;
    await deps.sleep(SIGN_IN_POLL_MS);
  }
  return false;
}

/** Opens Unity Hub for the person, where they sign in. */
async function openHub(deps: InstallDeps): Promise<void> {
  const hub = await findHub(deps.env);
  if (!hub) throw new Error(MESSAGE.NoHub());
  await deps.open(getUnityLaunch(deps.env.platform, hub));
}

/** Do it for me: Hub, then the person's sign-in, then the editor. */
async function drive(state: Installing): Promise<void> {
  const { deps } = state;
  await getHub(state);
  if (state.stop.signal.aborted) return;
  if (!(await hasLicense(deps.env))) {
    await openHub(deps);
    state.hubJob = { kind: JobKind.SignIn, state: JobState.Running };
    const inTime = await signedIn(deps, state.stop.signal).finally(() => {
      if (state.hubJob?.kind === JobKind.SignIn) state.hubJob = null;
    });
    if (!inTime) return;
  }
  if (state.stop.signal.aborted) return;
  if (!(await readFacts(deps.env, null)).editor) await installEditor(state);
}

/**
 * Stop: ends Do it for me, Hub's download and Hub's install of the editor (its whole process group,
 * which Hub's helpers belong to), and keeps the install as one the person stopped, for Try again.
 */
async function stopAll(state: Installing): Promise<void> {
  state.stop.abort();
  const stopped: InstallJob = {
    kind: JobKind.Editor,
    state: JobState.Failed,
    why: MESSAGE.YouStopped(),
    stopped: true,
  };
  const folder = folderIn(await state.storage());
  const file = path.join(folder, EDITOR_RECORD);
  const record = await readJsonIfExists<EditorRecord>(file).catch(() => null);
  if (record && (await installRuns(state.deps, record))) {
    state.deps.kill(-record.pid, "SIGTERM");
    await atomicWriteJson(file, { ...record, stopped: true });
  }
  state.hubJob = state.hubJob?.kind === JobKind.Hub ? { ...stopped, kind: JobKind.Hub } : stopped;
  await state.driving?.catch(() => undefined);
}

/** The state for a step the person starts on its own: an earlier Stop stops nothing of it, unless Do it for me runs. */
function fresh(state: Installing): Installing {
  if (!state.driving) state.stop = new AbortController();
  return state;
}

/** The installer over one plugin storage: Hub's install in memory, the editor's on disk, and Do it for me. */
export function createInstaller(deps: InstallDeps, storage: () => Promise<string>) {
  const state: Installing = { deps, storage, hubJob: null, driving: null, stop: new AbortController() };
  return {
    /** The install the card shows: Hub's while it runs or after it stopped, else the editor's. */
    job: async (): Promise<InstallJob | null> => state.hubJob ?? (await editorJob(state)),
    getHub: () => getHub(fresh(state)),
    openHub: () => openHub(deps),
    installEditor: () => installEditor(fresh(state)),
    /** Starts Do it for me and answers at once; the card follows it, and a stop shows on its row. */
    stop: () => stopAll(state),
    setUp: (): void => {
      if (state.driving) return;
      state.stop = new AbortController();
      state.driving = drive(state)
        .catch((error: unknown) => {
          // A step that failed says so on its own row; anything else shows on the install's.
          state.hubJob ??= { kind: JobKind.Editor, state: JobState.Failed, why: errorMessage(error) };
        })
        .finally(() => {
          state.driving = null;
        });
    },
    /** Do it for me's run while it goes, for tests that wait it out. */
    running: (): Promise<void> | null => state.driving,
  };
}

export type Installer = ReturnType<typeof createInstaller>;

/** Unity's name for a processor in Hub's command line. */
const archOf = (arch: string) => (arch === "arm64" ? "arm64" : "x86_64");

/** The end of a file, or nothing when there is none. */
async function tailOf(file: string): Promise<string> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

const run = promisify(execFile);

/** This Mac's own network, programs, processes, disks and clock. */
export function systemInstallDeps(env: EditorsEnv, opener: (launch: Launch) => Promise<void>): InstallDeps {
  return {
    env,
    arch: process.arch === "arm64" ? "arm64" : "x64",
    fetch: globalThis.fetch,
    run: async (command, args, timeoutMs, signal) => {
      const options = { timeout: timeoutMs, maxBuffer: OUTPUT_MAX_BYTES, windowsHide: true, signal };
      const done = await run(command, args, options);
      return { out: done.stdout, err: done.stderr };
    },
    start: async (command, args, log) => {
      const out = await open(log, "w");
      const child = spawn(command, args, { detached: true, stdio: ["ignore", out.fd, out.fd], windowsHide: true });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }).finally(() => out.close());
      child.unref();
      return child.pid ?? -1;
    },
    programOf: async (pid) => {
      if (pid <= 0) return undefined;
      const listed = await run(PS, ["-ww", "-o", "comm=", "-p", String(pid)], { timeout: PS_MS }).catch(
        () => undefined,
      );
      return listed?.stdout.trim() || undefined;
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    },
    freeBytes: async (folder) => {
      const disk = await statfs(folder);
      return disk.bavail * disk.bsize;
    },
    open: opener,
    now: () => new Date(),
    sleep: (ms) => sleep(ms),
  };
}
