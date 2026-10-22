/**
 * A fake Mac for the Godot plugin: Godot apps where the test puts them (each binary an empty file
 * whose version the fake answers), a runner that records every Godot job and answers it with
 * Godot's recorded words (`tests/fixtures/godot-cli/`), and the plugin's backend over both in an
 * open Genex game, with the host calls it makes recorded. A fake Windows PC too: Godot's
 * executables where the test puts them, and the backend on it with the real Windows runner over a
 * host whose sandbox jobs and pinned-runtime install the test plays. Nothing here starts Godot.
 */
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { crc32, deflateRawSync } from "node:zlib";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import {
  PLUGIN_SANDBOX_MAX_RUNNING,
  type PluginRuntimeInstall,
  type PluginSandboxJob,
  type PluginSandboxRunArgs,
} from "../../src/shared/plugins.ts";
import { createGodotBackend } from "../../src/plugins/godot/backend.ts";
import type { EditorEnv, Launch } from "../../src/plugins/godot/editor.ts";
import { BRIDGE_FOLDER } from "../../src/plugins/godot/editor-bridge.ts";
import type { GodotEnv } from "../../src/plugins/godot/find-godot.ts";
import type { GodotInstallDeps } from "../../src/plugins/godot/godot-setup.ts";
import type { ColyseusRelease } from "../../src/plugins/godot/multiplayer.ts";
import {
  type GodotCall,
  GodotJob,
  type GodotResult,
  type GodotRunner,
  windowsRunner,
} from "../../src/plugins/godot/godot-run.ts";
import { tmpDir } from "./tmp.ts";

/** The shipped scripts and templates, read where the source keeps them. */
export const SCRIPTS = path.resolve("src/plugins/godot/scripts");
export const TEMPLATES = path.resolve("src/plugins/godot/templates");
export const ADDON = path.resolve("src/plugins/godot/addon/genex");
/** Genex multiplayer as the plugin ships it: its addon, the SDK's bridge (its licenses a fixture's) and the Colyseus license. */
export const MULTIPLAYER = {
  addon: path.resolve("src/plugins/godot/addon/genex_multiplayer"),
  bridge: path.resolve("node_modules/@genex-ai/multiplayer/dist/bridge.global.js"),
  bridgeLicenses: path.resolve("tests/fixtures/godot-multiplayer/genex-multiplayer-bridge.LICENSES.md"),
  license: path.resolve("src/plugins/godot/multiplayer/COLYSEUS-LICENSE"),
};
/** Godot 4.6.1's own version line. */
export const GODOT_461 = "4.6.1.stable.official.14d19694e";
/** A one-pixel PNG, as a capture saves it. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Godot's recorded words, by fixture name. */
export const godotOutput = (name: string) => readFile(path.resolve("tests/fixtures/godot-cli", name), "utf8");

/** One Godot job as the runner was asked for it: the binary and the call. */
export type RanJob = { binary: string; call: GodotCall };

/** How the fake answers a job: its words, or its words and the stills it saves; else a quiet success. */
export type JobAnswers = Partial<Record<GodotJob, string | ((call: GodotCall) => Promise<string>)>>;

/** A play script argument's value (`key=value` after `--`), or "". */
export const playArg = (call: GodotCall, key: string) =>
  call.args
    .slice(call.args.indexOf("--") + 1)
    .find((arg) => arg.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? "";

/**
 * The play script's answer to a capture: at each frame `shots=` names, a PNG of every camera named
 * (or the first only, for a recording's frame), saved where `out=` says, and Godot's line for each.
 */
export function capturing(cameras: readonly string[]) {
  return async (call: GodotCall) => {
    const prefix = playArg(call, "out");
    const lines: string[] = [];
    for (const shot of playArg(call, "shots").split(";").filter(Boolean)) {
      const [frame = "0", mode = "all"] = shot.split(":");
      const shooting = mode === "first" ? cameras.slice(0, 1) : cameras;
      for (const [index, camera] of shooting.entries()) {
        const file = `${prefix}-${frame}-${index}.png`;
        await writeFile(file, PNG_BYTES);
        lines.push(`GENEX_SHOT ${camera} ${frame} ${file}`);
      }
    }
    return [...lines, `GENEX_PLAYED ${playArg(call, "frames")}`].join("\n");
  };
}

/** A runner that records each job and answers from `answers`; `ended` marks every answer timed out. */
export function recordingRunner(answers: JobAnswers = {}, ended: Partial<GodotResult> = {}) {
  const jobs: RanJob[] = [];
  const run: GodotRunner = async (binary, call) => {
    jobs.push({ binary, call });
    const answer = answers[call.job];
    const output = typeof answer === "function" ? await answer(call) : (answer ?? "");
    return { output, timedOut: false, cancelled: false, ...ended };
  };
  return { run, jobs };
}

/** A Godot app on the fake Mac: its folder, its binary (an empty file) and the version it answers. */
async function placeApp(folder: string, name: string) {
  const binary = path.join(folder, name, "Contents", "MacOS", "Godot");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "");
  return realpath(binary);
}

/** Apps to place: where (`applications`, `home-applications`, `downloads`) and the version each answers. */
export type FakeApp = {
  where: "applications" | "home-applications" | "downloads";
  name: string;
  version: string | null;
};

/** A fake Mac with the apps named; `pathDirs` and `binaries` the test may add to. */
export async function fakeMac(
  apps: readonly FakeApp[] = [{ where: "applications", name: "Godot.app", version: GODOT_461 }],
) {
  const root = await realpath(await tmpDir("studio-godot-"));
  const home = path.join(root, "home");
  const applications = path.join(root, "Applications");
  const folders = {
    applications,
    "home-applications": path.join(home, "Applications"),
    downloads: path.join(home, "Downloads"),
  };
  const versions = new Map<string, string | null>();
  for (const app of apps) versions.set(await placeApp(folders[app.where], app.name), app.version);
  const env: GodotEnv = {
    platform: "darwin",
    home,
    pathDirs: [],
    applications,
    binaries: [],
    programFiles: [],
    dataHome: path.join(home, "Library", "Application Support"),
    version: async (binary) => versions.get(binary) ?? null,
    userTemp: async () => path.join(root, "user-temp"),
  };
  return { root, home, env, versions };
}

/** Godot's Windows build where a test puts it: `where` from the fake PC's root, and the version it answers. */
export type FakeExe = { where: string; version: string | null };

/**
 * A fake Windows PC (its folders made under a temporary root): Program Files and Program Files
 * (x86), a home with Downloads, and Godot executables where the test puts them (each an empty file
 * whose version the fake answers). Genex's own install sits in its data folder in the home.
 */
export async function fakeWindows(exes: readonly FakeExe[] = []) {
  const root = await realpath(await tmpDir("studio-godot-win-"));
  const home = path.join(root, "Users", "Ada");
  const programFiles = [path.join(root, "Program Files"), path.join(root, "Program Files (x86)")];
  const own = path.join(home, "AppData", "Roaming", "Genex", "native-runtimes", "godot", "godot");
  for (const folder of [home, ...programFiles]) await mkdir(folder, { recursive: true });
  const versions = new Map<string, string | null>();
  const place = async ({ where, version }: FakeExe) => {
    const binary = path.join(root, where);
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "");
    versions.set(await realpath(binary), version);
    return realpath(binary);
  };
  for (const exe of exes) await place(exe);
  const env: GodotEnv = {
    platform: "win32",
    home,
    pathDirs: [],
    applications: path.join(root, "Applications"),
    binaries: [],
    programFiles,
    dataHome: path.join(home, "AppData", "Roaming"),
    version: async (binary) => versions.get(binary) ?? null,
    userTemp: async () => null,
  };
  return { root, home, own, env, versions, place };
}

/** An editor that records what it opens and answers the process list it is given, on a Mac unless a test names another computer. */
export function recordingEditor(lines: string[] = [], platform: NodeJS.Platform = "darwin") {
  const opened: Launch[] = [];
  const clock = { at: Date.UTC(2026, 9, 14, 12) };
  let standIn: (() => Promise<void>) | null = null;
  const editor: EditorEnv = {
    platform,
    open: async (launch) => {
      opened.push(launch);
    },
    commandLines: async () => lines,
    now: () => clock.at,
    sleep: async (ms) => {
      clock.at += ms;
      await standIn?.();
    },
  };
  /** The editor plugin's turn each time the backend waits: it answers what was asked meanwhile. */
  const answerWith = (turn: () => Promise<void>) => {
    standIn = turn;
  };
  return { editor, opened, lines, clock, answerWith };
}

/**
 * The Genex addon's editor plugin in `project`, as a test plays it on the fixture's clock: a
 * heartbeat now (`beat` writes another), and each ask answered by `answer` (null leaves it
 * unanswered), the ops asked kept in order.
 */
export async function editorStandIn(
  recorded: ReturnType<typeof recordingEditor>,
  project: string,
  answer: (op: string) => object | null,
) {
  const folder = path.join(project, BRIDGE_FOLDER);
  await mkdir(folder, { recursive: true });
  const asked: string[] = [];
  const beat = (fields: object = {}) =>
    writeFile(
      path.join(folder, "editor.json"),
      JSON.stringify({ at: recorded.clock.at, playing: false, unsavedScripts: 0, ...fields }),
    );
  await beat();
  recorded.answerWith(async () => {
    for (const name of await readdir(folder)) {
      const id = /^ask-([0-9a-f]+)\.json$/.exec(name)?.[1];
      if (!id) continue;
      const { op } = JSON.parse(await readFile(path.join(folder, name), "utf8"));
      await rm(path.join(folder, name));
      asked.push(op);
      const said = answer(op);
      if (said) await writeFile(path.join(folder, `answer-${id}.json`), JSON.stringify(said));
    }
  });
  return { folder, asked, beat };
}

/** A host call made by the backend: its method and arguments. */
export type HostCall = { method: string; args: unknown };

/**
 * The backend on a fake Mac in an open game (`valley`, its folder `game/`), or outside any game
 * with `game: null`; the host keeps storage in `storage/` and makes a game `made/` when asked.
 */
export async function godotBackendFixture(
  options: {
    apps?: FakeApp[];
    answers?: JobAnswers;
    game?: string | null;
    editorLines?: string[];
    install?: GodotInstallDeps;
    release?: ColyseusRelease;
    /** The computer the backend believes it is on; a Mac unless a test names another. */
    platform?: NodeJS.Platform;
    /** The clock a call's budget is read on; the wall clock unless a test holds it. */
    now?: () => number;
  } = {},
) {
  const mac = await fakeMac(options.apps);
  const storage = path.join(mac.root, "storage");
  const gameDir = path.join(mac.root, "game");
  const made = path.join(mac.root, "made");
  await mkdir(storage, { recursive: true });
  await mkdir(gameDir, { recursive: true });
  const runner = recordingRunner(options.answers);
  const recorded = recordingEditor(options.editorLines, options.platform);
  const backend = createGodotBackend({
    env: options.platform ? { ...mac.env, platform: options.platform } : mac.env,
    editor: recorded.editor,
    run: runner.run,
    scripts: SCRIPTS,
    templates: TEMPLATES,
    addon: ADDON,
    multiplayer: { ...MULTIPLAYER, ...(options.release ? { release: options.release } : {}) },
    install: options.install ?? offlineInstall(mac.root),
    ...(options.now ? { now: options.now } : {}),
  });
  const hostCalls: HostCall[] = [];
  /** The game's engine link as the host keeps it (`game.engine.link` / `game.engine.read`). */
  let link: { kind: string; project: string; name: string; linkedAt: string } | null = null;
  const host = (async (method: string, args?: unknown) => {
    hostCalls.push({ method, args });
    if (method === "storage.root") return storage;
    if (method === "game.engine.read") return link;
    if (method === "game.engine.steps") return true;
    if (method === "game.engine.link") {
      const project = typeof args === "object" && args !== null && "project" in args ? String(args.project) : "";
      link = { kind: "godot", project, name: path.basename(path.dirname(project)), linkedAt: "2026-10-15T00:00:00Z" };
      return link;
    }
    if (method === "game.create") {
      await mkdir(made, { recursive: true });
      return { project: "made-game", directory: made };
    }
    throw new Error(`unexpected host call ${method}`);
  }) as PluginContext["host"];
  const inGame = options.game !== null;
  const context = (more: Partial<PluginContext> = {}): PluginContext => ({
    ...(inGame ? { project: options.game ?? "valley", directory: gameDir } : {}),
    signal: new AbortController().signal,
    callId: 1,
    host,
    ...more,
  });
  return { ...mac, storage, gameDir, made, backend, runner, jobs: runner.jobs, editor: recorded, hostCalls, context };
}

/** Godot 4.7.2's own version line, as the Windows build says it. */
export const GODOT_472 = "4.7.2.stable.official.ed1daf0bf";
/** Where the host keeps Genex's own Godot on the fake PC, from its root. */
export const OWN_GODOT = "Users/Ada/AppData/Roaming/Genex/native-runtimes/godot/godot/Godot_v4.7.2-stable_win64.exe";

/** How the fake host's sandbox ends a job: what Godot printed, its exit code, or another end. */
export type SandboxEnd = Partial<Pick<PluginSandboxJob, "state" | "exitCode" | "stdout" | "stderr" | "reason">>;

/**
 * The backend on a fake Windows PC in an open game (`valley`, its folder `game/`), running Godot's
 * jobs through the real Windows runner. The host plays the rest: the sandbox jobs (`sandbox.run`,
 * each answered by `sandbox` from its request, read once while running, `sandbox.stop` recorded,
 * refused as busy past the host's limit of jobs at once, the most at once kept in `peak`),
 * and the pinned Godot (`runtime.detect` finds it once `runtime.install` placed it, or the test
 * did; `runtime.installation` answers `record`).
 */
export async function godotWindowsFixture(
  options: {
    exes?: FakeExe[];
    /** Whether Genex's own Godot is already in place. */
    installed?: boolean;
    sandbox?: (request: PluginSandboxRunArgs) => Promise<SandboxEnd> | SandboxEnd;
    editorLines?: string[];
    /** A Godot project the game is linked to (its `project.godot`), as the host keeps the link. */
    linked?: string;
    /** How many reads of a job's record say it still runs; one unless a test holds jobs longer. */
    runningReads?: number;
    /**
     * The sandbox user's `rd` of a stage (the runner's removal job), when a test stands in for one
     * Windows holds or for a link swapped in while it runs; removes the stage, never following a link, unless given.
     */
    remove?: (stage: string) => Promise<void>;
    /** Godot's templates archive as the network serves it (`templatesArchive`); offline unless given. */
    templates?: typeof fetch;
  } = {},
) {
  const pc = await fakeWindows(options.exes);
  const storage = path.join(pc.root, "storage");
  const gameDir = path.join(pc.root, "Users", "Ada", "AI Games", "Valley");
  await mkdir(storage, { recursive: true });
  await mkdir(gameDir, { recursive: true });
  const own = { binary: options.installed ? await pc.place({ where: OWN_GODOT, version: GODOT_472 }) : null };
  const runtime: { record: PluginRuntimeInstall | null; install: () => Promise<void> } = {
    record: null,
    install: async () => {
      own.binary = await pc.place({ where: OWN_GODOT, version: GODOT_472 });
      runtime.record = { runtime: "godot", phase: "ready", completed: 1, total: 1, active: false, updatedAt: "" };
    },
  };
  const requests: PluginSandboxRunArgs[] = [];
  /** The removal jobs, apart from Godot's own. */
  const removals: PluginSandboxRunArgs[] = [];
  const stopped: string[] = [];
  const peak = { running: 0, most: 0 };
  const jobs = new Map<string, { reads: number; ended: boolean; end: PluginSandboxJob }>();
  const recorded = recordingEditor(options.editorLines, "win32");
  const backend = createGodotBackend({
    env: pc.env,
    editor: recorded.editor,
    // Each wait for a job's record lets the event loop turn, as a real pause does, so other calls go on meanwhile.
    run: windowsRunner(() => setImmediate(), WINDOWS_CMD),
    scripts: SCRIPTS,
    templates: TEMPLATES,
    addon: ADDON,
    multiplayer: MULTIPLAYER,
    install: { ...offlineInstall(pc.root), ...(options.templates ? { fetch: options.templates } : {}) },
  });
  const hostCalls: HostCall[] = [];
  const sandboxRun = async (request: PluginSandboxRunArgs) => {
    if (peak.running >= PLUGIN_SANDBOX_MAX_RUNNING) throw new Error("This plugin already runs 2 sandbox jobs");
    peak.running += 1;
    peak.most = Math.max(peak.most, peak.running);
    const removed = removalOf(request);
    if (removed !== null) {
      removals.push(request);
      const id = `removal-${removals.length}`;
      const code = await (options.remove ?? removeUnfollowed)(removed).then(
        () => 0,
        () => 1,
      );
      jobs.set(id, { reads: 0, ended: false, end: { id, state: "exited", exitCode: code, stdout: "", stderr: "" } });
      return { id };
    }
    requests.push(request);
    const id = `job-${requests.length}`;
    const end = { state: "exited", exitCode: 0, stdout: "", stderr: "", ...(await options.sandbox?.(request)) };
    jobs.set(id, { reads: 0, ended: false, end: { id, ...end } as PluginSandboxJob });
    return { id };
  };
  const sandboxResult = (id: string): PluginSandboxJob | null => {
    const job = jobs.get(id);
    if (!job) return null;
    job.reads += 1;
    const record = stopped.includes(id) ? { ...job.end, state: "stopped" as const } : job.end;
    if (job.reads <= (options.runningReads ?? 1) || record.state === "running") return { id, state: "running" };
    if (!job.ended) peak.running -= 1;
    job.ended = true;
    return record;
  };
  const idOf = (args: unknown) => String((args as { id?: unknown })?.id);
  const host = (async (method: string, args?: unknown) => {
    hostCalls.push({ method, args });
    if (method === "storage.root") return storage;
    if (method === "game.engine.read")
      return options.linked ? { kind: "godot", project: options.linked, name: "linked", linkedAt: "" } : null;
    if (method === "game.engine.steps") return true;
    if (method === "runtime.detect") return own.binary ? { state: "ready", path: own.binary } : { state: "missing" };
    if (method === "runtime.install") return runtime.install();
    if (method === "runtime.installation") return runtime.record;
    if (method === "runtime.cancelInstall") return true;
    if (method === "sandbox.run") return sandboxRun(args as PluginSandboxRunArgs);
    if (method === "sandbox.result") return sandboxResult(idOf(args));
    if (method === "sandbox.stop") {
      stopped.push(idOf(args));
      return { stopped: true };
    }
    throw new Error(`unexpected host call ${method}`);
  }) as PluginContext["host"];
  const context = (more: Partial<PluginContext> = {}): PluginContext => ({
    project: "valley",
    directory: gameDir,
    signal: new AbortController().signal,
    callId: 1,
    host,
    ...more,
  });
  return {
    ...pc,
    storage,
    gameDir,
    own,
    runtime,
    backend,
    requests,
    removals,
    stopped,
    peak,
    editor: recorded,
    hostCalls,
    context,
  };
}

/** Windows's command interpreter as the fake PC's runner names it. */
export const WINDOWS_CMD = "C:\\Windows\\System32\\cmd.exe";

/** The stage a removal job's `rd` line names, or null for any other job. */
function removalOf(request: PluginSandboxRunArgs): string | null {
  if (request.program !== WINDOWS_CMD) return null;
  const line = Object.values(request.env ?? {}).find((value) => value.startsWith("rd /s /q "));
  const quoted = line ? /^rd \/s \/q "(.+)"$/.exec(line) : null;
  return quoted?.[1] ?? null;
}

/** What `rd /s /q` does to a stage: removes it and all in it, removing a link it meets rather than what it points to. */
const removeUnfollowed = (stage: string) => rm(stage, { recursive: true, force: true });

/** A computer with no network and no programs to install with: nothing a test didn't give is reached. */
export function offlineInstall(root: string): GodotInstallDeps {
  return {
    fetch: async () => {
      throw new Error("offline");
    },
    run: async () => {
      throw new Error("no programs here");
    },
    applications: path.join(root, "Applications"),
    trash: path.join(root, ".Trash"),
  };
}

/** One file of a zip as `templatesArchive` packs it: deflated, its CRC-32 and sizes in its entries. */
type ZipFile = { name: string; data: Buffer; packed: Buffer; crc: number; local: number };

/**
 * Godot's templates archive as GitHub serves it, made of `files` (names inside the archive, such as
 * `templates/web_nothreads_release.zip`): a zip answering HEAD with its size and GET with the byte
 * range asked (206 and its Content-Range), every request kept in `asked` (`HEAD`, or the range).
 * `serve` stands in for a server that does otherwise: `ignoresRange` answers the whole archive
 * with 200 (each body it cancelled counted in `cancelled`), and `drops` requests fail first as a
 * network does. Each request's signal is kept in `signals`.
 */
export function templatesArchive(
  files: Record<string, Buffer | string>,
  serve: { ignoresRange?: boolean; drops?: number } = {},
) {
  const zipped: ZipFile[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = deflateRawSync(data);
    const file = { name, data, packed, crc: crc32(data), local: offset };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(file.crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(Buffer.byteLength(name), 26);
    parts.push(header, Buffer.from(name), packed);
    offset += header.length + Buffer.byteLength(name) + packed.length;
    zipped.push(file);
  }
  const directoryAt = offset;
  for (const file of zipped) {
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(file.crc, 16);
    entry.writeUInt32LE(file.packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(Buffer.byteLength(file.name), 28);
    entry.writeUInt32LE(file.local, 42);
    parts.push(entry, Buffer.from(file.name));
    offset += entry.length + Buffer.byteLength(file.name);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zipped.length, 8);
  end.writeUInt16LE(zipped.length, 10);
  end.writeUInt32LE(offset - directoryAt, 12);
  end.writeUInt32LE(directoryAt, 16);
  parts.push(end);
  const archive = Buffer.concat(parts);
  const asked: string[] = [];
  const urls: string[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const state = { cancelled: 0, drops: serve.drops ?? 0 };
  const whole = () =>
    new Response(
      new ReadableStream({
        pull: (controller) => controller.enqueue(new Uint8Array(archive)),
        cancel: () => {
          state.cancelled += 1;
        },
      }),
      { status: 200 },
    );
  const served = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(String(url));
    signals.push(init?.signal);
    if (state.drops > 0) {
      state.drops -= 1;
      asked.push("dropped");
      throw new TypeError("fetch failed");
    }
    if (init?.method === "HEAD") {
      asked.push("HEAD");
      return new Response(null, { headers: { "content-length": String(archive.length) } });
    }
    const wanted = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get("range") ?? "");
    asked.push(wanted?.[0] ?? "all");
    if (!wanted || serve.ignoresRange) return whole();
    const [from, to] = [Number(wanted[1]), Number(wanted[2])];
    const headers = { "content-range": `bytes ${from}-${to}/${archive.length}` };
    return new Response(archive.subarray(from, to + 1), { status: 206, headers });
  };
  return {
    fetch: served as typeof fetch,
    asked,
    urls,
    archive,
    signals,
    cancelled: () => state.cancelled,
  };
}
