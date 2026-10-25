/**
 * Open, quit and get Unreal, and the Unreal toolbar button. Every launch goes through the opener
 * the backend is given, as a command and an argument array (never a shell string), so these tests
 * read the exact command and nothing starts: not Unreal, not Epic's launcher, not a browser. Open
 * in Unreal works like double-clicking the project (the user's own editor, the engine the project
 * names); Quit is Unreal's normal quit, which asks about unsaved work; Get Unreal opens Epic's
 * launcher or Epic's download page, a constant. The toolbar's status is cheap: no folder scans,
 * one handshake on the chosen project's own port.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { PluginScalar, PluginToolbarStatus } from "../../src/plugin-sdk/index.d.ts";
import { createUnrealBackend } from "../../src/plugins/unreal/backend.ts";
import {
  type EditorLog,
  editorLogPath,
  PortBlockedError,
  portBlockedIn,
  readEditorLog,
} from "../../src/plugins/unreal/editor-log.ts";
import { SetupStorage } from "../../src/plugins/unreal/editor-port.ts";
import { answersOrBlocked } from "../../src/plugins/unreal/editor-status.ts";
import {
  findLauncher,
  getUnreal,
  getUnrealLaunch,
  type Launch,
  LaunchErrorCode,
  launcherPaths,
  openEditorLaunch,
  quitEditorLaunch,
  readStarting,
  systemOpener,
} from "../../src/plugins/unreal/editor-launch.ts";
import { hotLibraryLoaded } from "../../src/plugins/unreal/cpp-module.ts";
import {
  crashReporterHolds,
  editorHoldsLog,
  heldProjectNames,
  namesInLsof,
} from "../../src/plugins/unreal/editor-holds.ts";
import {
  type Engine,
  HelperState,
  inspectProject,
  type Runner,
  type SetupEnv,
  SetupErrorCode,
  systemEditorLog,
} from "../../src/plugins/unreal/setup.ts";
import type { CompileOptions, CompileResult } from "../../src/plugins/unreal/ubt.ts";
import { type XcodeStatus, XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { toolbarStatusFrom } from "../../src/shared/plugin-toolbar.ts";
import { createEngineLinks } from "../../src/substrate/plugins/engine-links.ts";
import { ENGINES as ENGINE_CATALOG } from "../helpers/engines.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GIB = 1024 ** 3;
const HELPER = path.resolve("src/plugins/unreal/GenexEditorHelper");
const LINKS = process.platform === "win32" && "links need privileges on Windows";
/** Where this machine's Unreal writes a project's log: fixtures of a platform-neutral read put it there. */
const HOST = process.platform;
/** Who holds a log is asked of lsof on a Mac only; Windows paths can't stand in for a Mac's. */
const MAC_LSOF = process.platform === "win32" && "lsof and ~/Library/Logs are a Mac's; Windows asks no one";
const START = Date.UTC(2026, 9, 4, 9, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DOWNLOAD = "https://www.unrealengine.com/download";
/** The grey tone: the Unreal button's dot for every state but Starting (amber) and Ready (green). */
const MUTED = "info";
/** Sent only while the editor runs; the `tell` compiles inside `run script`, so a closed Unreal never starts. */
const QUIT_SCRIPT = [
  'if application id "com.epicgames.UnrealEditor" is running then',
  'run script "ignoring application responses\ntell application id \\"com.epicgames.UnrealEditor\\" to quit\nend ignoring"',
  "end if",
];
/** Epic's 5.8 and the unsupported 5.7, as the launcher lists them. */
const ENGINES: Array<[string, string]> = [
  ["UE_5.8", "5.8.3-58210709+++UE5+Release-5.8-Mac"],
  ["UE_5.7", "5.7.1-48512491+++UE5+Release-5.7-Mac"],
];
const READY_XCODE: XcodeStatus = {
  state: XcodeState.Ready,
  app: "/Applications/Xcode.app",
  version: "26.2",
  commandLineTools: true,
  supported: null,
  command: null,
};
const MAC_QUIT: Launch = {
  command: "/usr/bin/osascript",
  args: QUIT_SCRIPT.flatMap((line) => ["-e", line]),
  detached: false,
};

const uproject = (engine: string) =>
  `${JSON.stringify({ FileVersion: 3, EngineAssociation: engine, Category: "", Description: "" }, null, "\t")}\n`;

async function project(parent: string, name: string, engine = "5.8") {
  const file = path.join(parent, name, `${name}.uproject`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, uproject(engine));
  return file;
}

/** Every file and link under `dir` with a hash of its bytes: a no-side-effect witness. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) out[key] = "link";
    else if (entry.isFile())
      out[key] = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
  }
  return out;
}

/** Where a fake engine folder keeps its editor app, composed the Mac way even on the Windows runner. */
const editorAppOf = (root: string, folder: string) =>
  path.posix.join(path.join(root, "Engines", folder), "Engine", "Binaries", "Mac", "UnrealEditor.app");

/** Epic's launcher list in a fake home, naming fake engine folders, each with its editor app unless told not to. */
async function fakeEngines(root: string, home: string, engines: Array<[string, string]>, editorApp: boolean) {
  for (const [folder] of engines) {
    await mkdir(path.join(root, "Engines", folder), { recursive: true });
    if (editorApp) await mkdir(editorAppOf(root, folder), { recursive: true });
  }
  const epic = path.join(home, "Library", "Application Support", "Epic", "UnrealEngineLauncher");
  await mkdir(epic, { recursive: true });
  await writeFile(
    path.join(epic, "LauncherInstalled.dat"),
    JSON.stringify({
      InstallationList: engines.map(([folder, version]) => ({
        InstallLocation: path.join(root, "Engines", folder),
        AppVersion: version,
        AppName: folder,
      })),
    }),
  );
}

/** A computer whose editor runs and answers as the test says, counting what a status touches. */
function fakeComputer(home: string, platform: NodeJS.Platform) {
  const live: {
    running: boolean;
    answering: boolean;
    failOpen: boolean;
    /** How many editors run; unset means one while `running`. */
    editors?: number;
    /** An error the opener rejects with, as execFile does for a program that exits non-zero. */
    openError?: Error;
    /** Ports another app listens on. */
    listening: Set<number>;
    /** Ports Unreal's crash reporter holds after a crash (they listen too). */
    crashReporter?: Set<number>;
    /** What the shown project's own Unreal log says, if it has one. */
    log?: EditorLog;
    /** What other projects' own logs say, by their real `.uproject`; a project not named here has `log`. */
    logs?: Record<string, EditorLog>;
    /** The projects whose own logs a running editor holds open, by name. */
    held?: string[];
    /** The project the answering editor has open, when it is not the one asked about. */
    serving?: string;
    /** Where Xcode stands; Ready unless a test says otherwise. */
    xcode?: XcodeStatus;
  } = { running: false, answering: false, failOpen: false, listening: new Set() };
  const logsRead: string[] = [];
  /** The port each log read was for: a log is read for its project's own port. */
  const logPorts: Array<number | undefined> = [];
  const asked: number[] = [];
  const touched = { scans: 0, xcode: 0, disk: 0 };
  const env: SetupEnv = {
    home,
    platform,
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => live.running,
    editorCount: async () => live.editors ?? (live.running ? 1 : 0),
    editorLog: async (project) => {
      logsRead.push(project.file);
      logPorts.push(project.port);
      return live.logs?.[project.file] ?? live.log;
    },
    heldProjects: async () => live.held ?? [],
    portListening: async (port) => live.listening.has(port),
    crashReporterHolds: async (port) => live.crashReporter?.has(port) ?? false,
    editorAnswers: async (port, project) => {
      asked.push(port);
      return live.answering && (live.serving === undefined || live.serving === project);
    },
    xcode: async () => {
      touched.xcode++;
      return live.xcode ?? READY_XCODE;
    },
    freeBytes: async () => {
      touched.disk++;
      return 200 * GIB;
    },
    totalMemory: () => 32 * GIB,
  };
  return { env, live, asked, touched, logsRead, logPorts };
}

/**
 * A fake computer: Epic's launcher list with 5.8 (and the unsupported 5.7), each with its editor
 * app, a project Drift, the plugin's storage, an Applications folder, a clock and an editor whose
 * running and answering the test sets. The opener only records what it was asked to start.
 */
async function launchFixture(
  options: { engines?: Array<[string, string]>; editorApp?: boolean; platform?: NodeJS.Platform } = {},
) {
  const root = await realpath(await tmpDir("studio-unreal-launch-"));
  const home = path.join(root, "home");
  const storage = path.join(root, "storage");
  const applications = path.join(root, "Applications");
  await mkdir(applications, { recursive: true });
  await fakeEngines(root, home, options.engines ?? ENGINES, options.editorApp !== false);
  const drift = await project(path.join(root, "Projects"), "Drift");
  const computer = fakeComputer(home, options.platform ?? "darwin");
  const launched: Launch[] = [];
  /** What a build, a game snapshot and a launch did, in order. */
  const events: string[] = [];
  /** Each build's options; `outcome.build` is what it answers (built unless a test says otherwise). */
  const compiles: CompileOptions[] = [];
  /** The helper's state as each game snapshot found it. */
  const snapshots: HelperState[] = [];
  /** `runs`: the games whose Loop is going, as the host's `game.engine.runs` answers; unset, the host refuses it like an older one. */
  const outcome: {
    build?: CompileResult;
    snapshotError?: Error;
    onLaunch?: () => void;
    runs?: Array<{ game: string; title: string; project: string }>;
  } = {};
  let clock = START;
  /** A quit editor's sockets hold the project's port until `heldUntil` on the clock; each port checked is kept. */
  const ports = { heldUntil: 0, checked: [] as number[] };
  const backend = createUnrealBackend({
    env: computer.env,
    helper: HELPER,
    projects: async () => {
      computer.touched.scans++;
      return path.join(home, "Documents", "Unreal Projects");
    },
    launch: {
      open: async (launch) => {
        if (computer.live.failOpen) throw new Error("open: LSOpenURLsWithRole() failed with error -10810");
        if (computer.live.openError) throw computer.live.openError;
        events.push("launch");
        launched.push(launch);
        outcome.onLaunch?.();
      },
      build: async (options) => {
        events.push("build");
        compiles.push(options);
        return (
          outcome.build ?? {
            ok: true,
            seconds: 31,
            errors: [],
            summary: "DriftEditor built in 31 s.",
            retryable: false,
          }
        );
      },
      applications,
      now: () => clock,
      portWait: {
        free: async (port) => {
          ports.checked.push(port);
          return clock >= ports.heldUntil;
        },
        sleep: async (ms) => {
          clock += ms;
        },
      },
    },
  });
  const helperNow = async () => (await inspectProject(drift, { env: computer.env, helper: HELPER, storage })).helper;
  const context = {
    signal: new AbortController().signal,
    callId: 1,
    host: (async (method: string) => {
      if (method === "storage.root") return storage;
      if (method === "game.engine.runs" && outcome.runs) return outcome.runs;
      if (method !== "game.snapshot") throw new Error(`unexpected host call ${method}`);
      events.push("snapshot");
      snapshots.push(await helperNow());
      if (outcome.snapshotError) throw outcome.snapshotError;
      return { snapshotId: `snapshot-${snapshots.length}` };
    }) as never,
  };
  // biome-ignore lint/suspicious/noExplicitAny: action results are the panel's JSON
  const act = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const run = backend.action?.(name, args, context);
    if (!run) throw new Error("the backend has no actions");
    return run;
  };
  const toolbar = async () => (await act("toolbar-status")) as PluginToolbarStatus;
  const review = async (name: string, args: Record<string, unknown>) => backend.review?.(name, args, context);
  const tick = (ms: number) => {
    clock += ms;
  };
  const app = (folder: string) => editorAppOf(root, folder);
  // A game as the host keeps it: its folder, and its link made and undone by the host's own link service.
  const gameDir = (game: string) => path.join(root, "games", game);
  const links = createEngineLinks({
    root: () => storage,
    gameDir,
    append: async () => {},
    changed: () => {},
    gameThread: async (game) => `thread-of-${game}`,
    now: () => new Date(clock),
    catalog: () => ENGINE_CATALOG,
  });
  const gameBinding = (game: string) => ({ project: game, directory: gameDir(game) });
  const linkGame = async (game: string, file: string) => {
    await mkdir(gameDir(game), { recursive: true });
    return links.link("unreal", gameBinding(game), { project: file });
  };
  const unlinkGame = (game: string, linkedAt: string) => links.undo("unreal", game, linkedAt);
  /** What the button says while `game` is open. */
  const toolbarOf = async (game: string) =>
    (await backend.action?.("toolbar-status", {}, { ...context, ...gameBinding(game) })) as PluginToolbarStatus;
  /** An action pressed while `game` is open, as the stage and the panel in a game send it. */
  // biome-ignore lint/suspicious/noExplicitAny: action results are the panel's JSON
  const actIn = async (game: string, name: string, args: Record<string, unknown> = {}): Promise<any> =>
    backend.action?.(name, args, { ...context, ...gameBinding(game) });
  /** A Loop tool the runner calls for `game`. */
  const toolIn = async (game: string, name: string, args: Record<string, PluginScalar> = {}): Promise<unknown> =>
    backend.tool?.(name, args, { ...context, ...gameBinding(game) });
  return {
    root,
    home,
    storage,
    applications,
    app,
    drift,
    ...computer,
    launched,
    ports,
    act,
    toolbar,
    review,
    tick,
    linkGame,
    unlinkGame,
    toolbarOf,
    actIn,
    toolIn,
    events,
    compiles,
    snapshots,
    outcome,
    helperNow,
  };
}

type Fixture = Awaited<ReturnType<typeof launchFixture>>;

const macOpen = (f: Fixture, file: string, engine = "UE_5.8"): Launch => ({
  command: "/usr/bin/open",
  args: ["-n", "-a", f.app(engine), "--args", file],
  detached: false,
});

describe("Open in Unreal", () => {
  it("opens the project as a new editor of the engine it names, by command and argument array", async () => {
    const f = await launchFixture();
    const opened = await f.act("open-editor", { project: f.drift });
    assert.deepEqual(f.launched, [macOpen(f, f.drift)]);
    assert.deepEqual(opened, { project: f.drift, launched: true, at: START });
  });

  it("a name with spaces, quotes and shell characters reaches Unreal as one argument, unchanged", {
    skip: process.platform === "win32" && "Windows file names can't hold quotes",
  }, async () => {
    const f = await launchFixture();
    const odd = await project(path.join(f.root, "Projects $(touch pwned)"), `Drift "Racer"; echo $HOME`);
    await f.act("open-editor", { project: odd });
    assert.deepEqual(f.launched, [macOpen(f, odd)]);
  });

  it("Windows starts the engine's UnrealEditor.exe with the project, detached", () => {
    const engine: Engine = {
      version: "5.8",
      build: "5.8.3",
      directory: "C:\\Program Files\\Epic Games\\UE_5.8",
      supported: true,
    };
    const file = "C:\\Users\\Ann\\OneDrive\\Documents\\Unreal Projects\\Drift Racer\\Drift Racer.uproject";
    assert.deepEqual(openEditorLaunch(engine, file, "win32"), {
      command: "C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe",
      args: [file],
      detached: true,
    });
    assert.deepEqual(
      openEditorLaunch({ ...engine, directory: "/Users/Shared/Epic Games/UE_5.8" }, "/p/D.uproject", "darwin"),
      {
        command: "/usr/bin/open",
        args: [
          "-n",
          "-a",
          "/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app",
          "--args",
          "/p/D.uproject",
        ],
        detached: false,
      },
    );
  });
});

describe("Open in Unreal while it starts", () => {
  it("remembers when it opened which project, so the toolbar shows Starting with the time since", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    assert.deepEqual(await f.toolbar(), {
      badge: "Starting",
      tone: "warn",
      dot: true,
      title: "Opening Drift in Unreal… 0:00",
    });
    f.live.running = true;
    f.tick(2 * MINUTE + 10 * SECOND);
    assert.deepEqual(await f.toolbar(), {
      badge: "Starting",
      tone: "warn",
      dot: true,
      title: "Opening Drift in Unreal… 2:10",
    });
    const status = await f.act("status");
    assert.deepEqual([status.connection, status.opening], ["starting", { at: START, elapsedMs: 130 * SECOND }]);
    f.live.answering = true;
    assert.deepEqual(await f.toolbar(), { badge: "Ready", tone: "ok", dot: true, title: "Connected to Drift." });
    assert.deepEqual([(await f.act("status")).connection, (await f.act("status")).opening], ["ready", null]);
  });

  it("once the project Genex opened has answered, Starting no longer counts while another editor runs", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.live.running = true;
    f.tick(45 * SECOND);
    f.live.answering = true;
    assert.equal((await f.act("status")).next, "connected");
    // The user switches Unreal to another project: an editor still runs, Drift no longer answers and its log closed.
    f.live.answering = false;
    f.tick(3 * MINUTE);
    const status = await f.act("status");
    assert.deepEqual([status.connection, status.next, status.opening], ["not-open", "open-when-free", null]);
    assert.deepEqual(await f.toolbar(), {
      badge: "Not open",
      tone: "info",
      dot: true,
      title: "Drift isn't open in Unreal.",
    });
    assert.equal((await f.act("open-editor", { project: f.drift })).launched, true);
  });

  it("the toolbar alone also retires Starting once the project answered, removing nothing else", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.live.running = true;
    f.tick(45 * SECOND);
    f.live.answering = true;
    const before = await tree(f.root);
    assert.equal((await f.toolbar()).badge, "Ready");
    const after = await tree(f.root);
    assert.deepEqual(
      Object.keys(before).filter((file) => !(file in after)),
      ["storage/starting.json"],
      "only its own Starting record goes",
    );
    // Drift is still open in Unreal (its own log is), but went silent.
    f.live.answering = false;
    f.live.log = ownLog(4 * MINUTE, { loaded: true });
    f.tick(3 * MINUTE);
    assert.deepEqual(await f.toolbar(), {
      badge: "Not open",
      tone: "info",
      dot: true,
      title: "Unreal is open, but Drift isn't answering.",
    });
  });

  it("opening makes the project the chosen one, which the toolbar and the bridge try first", async () => {
    const f = await launchFixture();
    const other = await project(path.join(f.root, "Projects"), "Other");
    await f.act("setup", { project: other });
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: other });
    assert.match((await f.toolbar()).title ?? "", /Other/);
  });

  it("a second press while Unreal starts or answers launches nothing more", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.live.running = true;
    f.tick(10 * SECOND);
    assert.deepEqual(await f.act("open-editor", { project: f.drift }), {
      project: f.drift,
      launched: false,
      at: START,
    });
    f.live.answering = true;
    f.tick(30 * MINUTE);
    assert.equal((await f.act("open-editor", { project: f.drift })).launched, false);
    f.live.answering = false;
    f.live.running = false;
    assert.equal((await f.act("open-editor", { project: f.drift })).launched, true, "closed again: it opens");
    assert.equal(f.launched.length, 2);
  });

  it("a launch that fails says why and leaves no Starting behind", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    const witness = await tree(f.storage);
    f.live.failOpen = true;
    await assert.rejects(f.act("open-editor", { project: f.drift }), /-10810/);
    assert.deepEqual(await tree(f.storage), witness);
    assert.equal((await f.toolbar()).badge, "Not open");
  });
});

/** Projects Open in Unreal must refuse, launching nothing and writing nothing. */
const refusedOpens: Array<{
  name: string;
  code: string;
  links?: boolean;
  fixture?: Parameters<typeof launchFixture>[0];
  arrange: (f: Fixture) => Promise<unknown>;
}> = [
  { name: "no project", code: SetupErrorCode.NotProjectFile, arrange: async () => "" },
  {
    // Unreal opens a project named on its command line in place, with no Convert prompt: setup switches it first.
    name: "a project made with 5.7, which only a confirmed setup switches to 5.8",
    code: LaunchErrorCode.NeedsSetup,
    arrange: async (f) => project(path.join(f.root, "Projects"), "Cave", "5.7"),
  },
  { name: "a project that is not text", code: SetupErrorCode.NotProjectFile, arrange: async () => 42 },
  { name: "a relative path", code: SetupErrorCode.NotProjectFile, arrange: async () => "Drift/Drift.uproject" },
  {
    name: "a relative path that reads like an Unreal option",
    code: SetupErrorCode.NotProjectFile,
    arrange: async () => "-ExecCmds=quit.uproject",
  },
  {
    name: "a file that is not a .uproject",
    code: SetupErrorCode.NotProjectFile,
    arrange: async (f) => path.join(path.dirname(f.drift), "Drift.txt"),
  },
  {
    name: "a .uproject that does not exist",
    code: SetupErrorCode.NoProject,
    arrange: async (f) => path.join(f.root, "Projects", "Gone", "Gone.uproject"),
  },
  {
    name: "a path with a NUL byte",
    code: SetupErrorCode.NoProject,
    arrange: async (f) => `${f.drift}\0.uproject`,
  },
  {
    name: "a folder named like a project",
    code: SetupErrorCode.NoProject,
    arrange: async (f) => {
      const folder = path.join(f.root, "Projects", "Hollow", "Hollow.uproject");
      await mkdir(folder, { recursive: true });
      return folder;
    },
  },
  {
    name: "a .uproject that links to a project elsewhere",
    code: SetupErrorCode.NoProject,
    links: true,
    arrange: async (f) => {
      const elsewhere = await project(path.join(f.root, "Elsewhere"), "Victim");
      const link = path.join(f.root, "Projects", "Lure.uproject");
      await symlink(elsewhere, link);
      return link;
    },
  },
  {
    name: "a .uproject that is not JSON",
    code: SetupErrorCode.BadProjectFile,
    arrange: async (f) => {
      await writeFile(f.drift, "{ not json");
      return f.drift;
    },
  },
  {
    name: "a project for an engine that isn't installed",
    code: LaunchErrorCode.EngineMissing,
    arrange: async (f) => project(path.join(f.root, "Projects"), "Future", "5.9"),
  },
  {
    name: "a project for an engine built from source",
    code: LaunchErrorCode.CustomEngine,
    arrange: async (f) => project(path.join(f.root, "Projects"), "Source", "{6F2A1E0B-41C8-4B0E-9C3A-2E8B6A1D7F90}"),
  },
  {
    name: "a computer with only an older engine",
    code: LaunchErrorCode.NoEngine,
    fixture: { engines: [["UE_5.7", "5.7.1-48512491+++UE5+Release-5.7-Mac"]] },
    arrange: async (f) => f.drift,
  },
  {
    name: "an engine whose editor app is missing",
    code: LaunchErrorCode.EditorMissing,
    fixture: { editorApp: false },
    arrange: async (f) => f.drift,
  },
  {
    name: "an engine whose editor app is a link to another app",
    code: LaunchErrorCode.EditorMissing,
    links: true,
    fixture: { editorApp: false },
    arrange: async (f) => {
      const other = path.join(f.root, "Other.app");
      await mkdir(other, { recursive: true });
      await mkdir(path.dirname(f.app("UE_5.8")), { recursive: true });
      await symlink(other, f.app("UE_5.8"));
      return f.drift;
    },
  },
];

describe("Open in Unreal refuses, launching and writing nothing,", () => {
  for (const row of refusedOpens)
    it(`for ${row.name}`, { skip: row.links ? LINKS : false }, async () => {
      const f = await launchFixture(row.fixture);
      const target = await row.arrange(f);
      const witness = await tree(f.root);
      await assert.rejects(f.act("open-editor", { project: target }), (error: { code?: string }) => {
        assert.equal(error.code, row.code);
        return true;
      });
      assert.deepEqual(f.launched, []);
      assert.deepEqual(await tree(f.root), witness);
    });
});

describe("Quit Unreal", () => {
  it("asks the running editor to quit the normal way, without waiting on its save prompt", async () => {
    const f = await launchFixture();
    f.live.running = true;
    assert.deepEqual(await f.act("quit-editor"), { quitting: true });
    assert.deepEqual(f.launched, [MAC_QUIT]);
  });

  it("does nothing when Unreal isn't running", async () => {
    const f = await launchFixture();
    assert.deepEqual(await f.act("quit-editor"), { quitting: false });
    assert.deepEqual(f.launched, []);
  });

  it("never forces, whatever the panel sends", async () => {
    const f = await launchFixture();
    f.live.running = true;
    await f.act("quit-editor", { force: true, pid: 1, signal: "SIGKILL", command: "kill -9 1" });
    assert.deepEqual(f.launched, [MAC_QUIT]);
  });

  it("a quit ends Starting: the toolbar says Not open while Unreal closes", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.live.running = true;
    await f.act("quit-editor", { project: f.drift });
    assert.equal((await f.toolbar()).badge, "Not open");
  });

  it("with two editors open, refuses to guess which to quit: nothing is sent and Starting stays", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.live.running = true;
    f.live.editors = 2;
    f.launched.length = 0;
    const witness = await tree(f.storage);
    await assert.rejects(f.act("quit-editor", { project: f.drift }), { code: "several-editors" });
    assert.deepEqual(f.launched, []);
    assert.deepEqual(await tree(f.storage), witness);
    assert.equal((await f.act("status", { project: f.drift })).editor.editors, 2, "the panel learns how many run");
  });

  it("a quit leaves another project's Starting record alone, and a quit naming no project clears none", async () => {
    const f = await launchFixture();
    const other = await project(path.join(f.root, "Projects"), "Other");
    await f.act("setup", { project: other });
    await f.act("open-editor", { project: other });
    f.live.running = true;
    f.launched.length = 0;
    await f.act("quit-editor", { project: f.drift });
    assert.deepEqual(f.launched, [MAC_QUIT]);
    assert.equal(JSON.parse(await readFile(path.join(f.storage, "starting.json"), "utf8")).project, other);
    await f.act("quit-editor");
    assert.equal(JSON.parse(await readFile(path.join(f.storage, "starting.json"), "utf8")).project, other);
  });

  it("a quit Unreal refuses answers in plain words and still forgets this project's Starting", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.live.running = true;
    f.live.openError = Object.assign(new Error("Command failed: taskkill /IM UnrealEditor.exe"), { code: 1 });
    await assert.rejects(f.act("quit-editor", { project: f.drift }), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, "not-quit");
      assert.doesNotMatch(error.message ?? "", /Command failed/);
      return true;
    });
    await assert.rejects(access(path.join(f.storage, "starting.json")));
  });

  it("a Windows editor that is already gone (taskkill's 128) is not an error", async () => {
    const f = await launchFixture({ platform: "win32" });
    f.live.running = true;
    f.live.openError = Object.assign(new Error("Command failed: taskkill"), { code: 128 });
    assert.deepEqual(await f.act("quit-editor", { project: f.drift }), { quitting: false });
  });

  it("on Windows it asks UnrealEditor.exe to close with taskkill, never /F", async () => {
    const f = await launchFixture({ platform: "win32" });
    f.live.running = true;
    await f.act("quit-editor", { force: true });
    const taskkill = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const windows: Launch = { command: taskkill, args: ["/IM", "UnrealEditor.exe"], detached: false };
    assert.deepEqual(f.launched, [windows]);
    assert.deepEqual(quitEditorLaunch("win32", { SystemRoot: "D:\\Windows" }), {
      ...windows,
      command: "D:\\Windows\\System32\\taskkill.exe",
    });
    assert.deepEqual(quitEditorLaunch("darwin"), MAC_QUIT);
  });
});

describe("Get Unreal Engine", () => {
  it("opens Epic's launcher when it is installed", async () => {
    const f = await launchFixture();
    const launcher = path.posix.join(f.applications, "Epic Games Launcher.app");
    await mkdir(launcher);
    assert.deepEqual(await f.act("get-unreal"), { opened: "launcher" });
    assert.deepEqual(f.launched, [{ command: "/usr/bin/open", args: ["-a", launcher], detached: false }]);
  });

  it("opens Epic's download page when the launcher isn't there", async () => {
    const f = await launchFixture();
    assert.deepEqual(await f.act("get-unreal"), { opened: "download" });
    assert.deepEqual(f.launched, [{ command: "/usr/bin/open", args: [DOWNLOAD], detached: false }]);
  });

  for (const [name, arrange] of [
    ["a launcher that is a plain file", (launcher: string) => writeFile(launcher, "not an app")],
    [
      "a launcher that links to another app",
      async (launcher: string) => {
        const other = path.join(path.dirname(path.dirname(launcher)), "Other.app");
        await mkdir(other);
        await symlink(other, launcher);
      },
    ],
  ] as const)
    it(`opens the download page instead of ${name}`, { skip: LINKS }, async () => {
      const f = await launchFixture();
      await arrange(path.join(f.applications, "Epic Games Launcher.app"));
      await f.act("get-unreal");
      assert.deepEqual(f.launched, [{ command: "/usr/bin/open", args: [DOWNLOAD], detached: false }]);
    });

  it("the panel can't change what opens", async () => {
    const f = await launchFixture();
    await f.act("get-unreal", { url: "https://evil.example/download", app: "/System/Applications/Calculator.app" });
    assert.deepEqual(f.launched, [{ command: "/usr/bin/open", args: [DOWNLOAD], detached: false }]);
  });

  it("on Windows it starts the launcher from Program Files, then Program Files (x86), else the download page", () => {
    const at = (programs: string, folder: string) =>
      `${programs}\\Epic Games\\Launcher\\Portal\\Binaries\\${folder}\\EpicGamesLauncher.exe`;
    const [programs, x86] = ["C:\\Program Files", "C:\\Program Files (x86)"];
    const win64 = at(x86, "Win64");
    assert.deepEqual(
      launcherPaths("win32", { applications: x86, programFiles: programs }),
      [at(programs, "Win64"), at(programs, "Win32"), win64, at(x86, "Win32")],
      "Epic's 64-bit launcher installs in Program Files; the older one went to Program Files (x86)",
    );
    assert.deepEqual(launcherPaths("win32", { applications: x86 }), [win64, at(x86, "Win32")]);
    assert.deepEqual(launcherPaths("darwin", { applications: "/Applications" }), [
      "/Applications/Epic Games Launcher.app",
    ]);
    assert.deepEqual(getUnrealLaunch("win32", win64), { command: win64, args: [], detached: true });
    assert.deepEqual(getUnrealLaunch("win32", undefined, { SystemRoot: "D:\\Windows" }), {
      command: "D:\\Windows\\explorer.exe",
      args: [DOWNLOAD],
      detached: true,
    });
  });

  it("on Windows it finds and starts Epic's 64-bit launcher in Program Files", {
    skip: process.platform !== "win32" && "Windows paths name a PC's own folders",
  }, async () => {
    const root = await realpath(await tmpDir("studio-unreal-launcher-"));
    const [programs, x86] = [path.join(root, "Program Files"), path.join(root, "Program Files (x86)")];
    const launcher = path.join(
      programs,
      "Epic Games",
      "Launcher",
      "Portal",
      "Binaries",
      "Win64",
      "EpicGamesLauncher.exe",
    );
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, "MZ");
    await mkdir(x86, { recursive: true });
    const launched: Launch[] = [];
    const launch = { open: async (l: Launch) => void launched.push(l), now: () => START };
    assert.equal(await findLauncher("win32", { applications: x86, programFiles: programs }), launcher);
    assert.equal(await findLauncher("win32", { applications: x86 }), undefined, "Program Files (x86) alone misses it");
    assert.deepEqual(await getUnreal({ platform: "win32" }, { ...launch, applications: x86, programFiles: programs }), {
      opened: "launcher",
    });
    assert.deepEqual(launched, [{ command: launcher, args: [], detached: true }]);
  });
});

describe("The Unreal toolbar button", () => {
  it("is declared on the stage strip of Unreal games only, with Unreal's glyph, opens the setup panel and asks a status action that needs no confirmation", async () => {
    const manifest = validateManifest(JSON.parse(await readFile("src/plugins/unreal/plugin.json", "utf8")));
    assert.deepEqual(manifest.toolbar, [
      {
        id: "editor",
        label: "Unreal",
        ariaLabel: "Unreal Editor",
        icon: "unreal",
        facts: ["unreal-project", "unreal-plugin"],
        target: { kind: "panel", id: "setup" },
        status: "toolbar-status",
      },
    ]);
    for (const name of ["toolbar-status", "open-editor", "quit-editor", "get-unreal"]) {
      const action = manifest.actions.find((a) => a.name === name);
      assert.ok(action, `${name} is declared`);
      assert.equal(action?.confirmation, undefined, `${name} runs without Studio's confirmation`);
    }
  });

  it("says Set up, Not open, Starting or Ready, as dots whose words the toolbar keeps as they are", async () => {
    const f = await launchFixture();
    const states: PluginToolbarStatus[] = [await f.toolbar()];
    await f.act("setup", { project: f.drift });
    states.push(await f.toolbar());
    await f.act("open-editor", { project: f.drift });
    states.push(await f.toolbar());
    f.live.running = true;
    f.live.answering = true;
    states.push(await f.toolbar());
    assert.deepEqual(states, [
      { badge: "Not set up", tone: "info", dot: true, title: "Set up an Unreal project for Genex." },
      { badge: "Not open", tone: "info", dot: true, title: "Drift isn't open in Unreal." },
      { badge: "Starting", tone: "warn", dot: true, title: "Opening Drift in Unreal… 0:00" },
      { badge: "Ready", tone: "ok", dot: true, title: "Connected to Drift." },
    ]);
    for (const state of states) assert.deepEqual(toolbarStatusFrom(state), state, "nothing is clipped or dropped");
  });

  it("another project's editor answering on this project's port is never Ready", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.answering = true;
    f.live.serving = path.join(f.root, "Projects", "Other", "Other.uproject");
    assert.notEqual((await f.toolbar()).badge, "Ready");
    assert.notEqual((await f.act("status", { project: f.drift })).next, "connected");
    f.live.serving = f.drift;
    assert.equal((await f.toolbar()).badge, "Ready", "its own editor is");
  });

  it("an answer on the project's port with no Unreal running is never Ready", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    f.live.answering = true;
    assert.deepEqual(await f.toolbar(), {
      badge: "Not open",
      tone: "info",
      dot: true,
      title: "Drift isn't open in Unreal.",
    });
    const status = await f.act("status");
    assert.deepEqual([status.connection, status.next], ["not-open", "open"]);
  });

  it("Starting gives way to Not open after the launch grace with no editor, and after the starting window", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.tick(30 * SECOND);
    assert.deepEqual(await f.toolbar(), {
      badge: "Not open",
      tone: "info",
      dot: true,
      title: "Drift isn't open in Unreal.",
    });
    // An editor runs, but Drift's own log never opened: Unreal has another project.
    f.live.running = true;
    f.tick(25 * MINUTE);
    assert.deepEqual(await f.toolbar(), {
      badge: "Not open",
      tone: "info",
      dot: true,
      title: "Drift isn't open in Unreal.",
    });
  });

  it("names a chosen project that isn't set up yet", async () => {
    const f = await launchFixture();
    await f.act("status", { project: f.drift });
    assert.deepEqual(await f.toolbar(), {
      badge: "Not set up",
      tone: "info",
      dot: true,
      title: "Set up Drift for Genex.",
    });
  });

  it("draws Ready green, Starting amber and every other state grey, each as a dot", async () => {
    const f = await launchFixture();
    const states: PluginToolbarStatus[] = [await f.toolbar(), await f.toolbarOf("valley")];
    await f.act("setup", { project: f.drift });
    await f.linkGame("valley", f.drift);
    states.push(await f.toolbarOf("valley"));
    await f.act("open-editor", { project: f.drift });
    states.push(await f.toolbarOf("valley"));
    f.live.running = true;
    states.push(await f.toolbarOf("valley"));
    f.live.answering = true;
    states.push(await f.toolbarOf("valley"));
    assert.deepEqual(
      states.map((s) => [s.badge, s.tone, s.dot]),
      [
        ["Not set up", MUTED, true],
        [undefined, MUTED, undefined],
        ["Not open", MUTED, true],
        ["Starting", "warn", true],
        ["Starting", "warn", true],
        ["Ready", "ok", true],
      ],
    );
  });

  it("is cheap: no folder scan, no disk or Xcode check, one handshake on the chosen port, no writes", async () => {
    const f = await launchFixture();
    const set = await f.act("setup", { project: f.drift });
    f.live.answering = true;
    Object.assign(f.touched, { scans: 0, xcode: 0, disk: 0 });
    f.asked.length = 0;
    const witness = await tree(f.root);
    await f.toolbar();
    assert.deepEqual(f.asked, [set.port]);
    assert.deepEqual(f.touched, { scans: 0, xcode: 0, disk: 0 });
    assert.deepEqual(await tree(f.root), witness);
  });
});

/** Where a game stands for the Unreal button: it is its own, whatever other games or the panel chose. */
describe("The Unreal toolbar button for the open game", () => {
  /** A web game's button: no badge on every web game, only the title saying it can start one. */
  const ADD = { tone: MUTED, title: "Make this game in Unreal" } as const;

  it("offers to make a game with no Unreal link in Unreal, never the last project another game chose", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    assert.deepEqual(await f.toolbarOf("lantern"), ADD);
    assert.equal((await f.toolbar()).badge, "Not open", "with no game open it still reports the chosen project");
  });

  it("reports a linked game's own project, not the one chosen in the panel", async () => {
    const f = await launchFixture();
    const other = await project(path.join(f.root, "Projects"), "Other");
    await f.act("setup", { project: f.drift });
    await f.act("setup", { project: other });
    await f.linkGame("valley", f.drift);
    assert.deepEqual(await f.toolbarOf("valley"), {
      badge: "Not open",
      tone: MUTED,
      dot: true,
      title: "Drift isn't open in Unreal.",
    });
    assert.match((await f.toolbar()).title ?? "", /Other/, "the panel's choice is still Other");
    assert.deepEqual(await f.toolbarOf("lantern"), ADD, "and a game with no link is not Other's");
  });

  it("follows the linked project through Starting and Ready, and ignores another project's start", async () => {
    const f = await launchFixture();
    const other = await project(path.join(f.root, "Projects"), "Other");
    await f.act("setup", { project: f.drift });
    await f.act("setup", { project: other });
    await f.linkGame("valley", other);
    await f.act("open-editor", { project: f.drift });
    assert.equal((await f.toolbarOf("valley")).title, "Other isn't open in Unreal.", "Drift's start is not Other's");
    await f.act("open-editor", { project: other });
    assert.equal((await f.toolbarOf("valley")).title, "Opening Other in Unreal… 0:00");
    f.live.running = true;
    f.live.answering = true;
    f.live.serving = other;
    assert.deepEqual(await f.toolbarOf("valley"), {
      badge: "Ready",
      tone: "ok",
      dot: true,
      title: "Connected to Other.",
    });
  });

  it("says Set up, naming the project, for a game linked to one that isn't set up", async () => {
    const f = await launchFixture();
    await f.linkGame("valley", f.drift);
    assert.deepEqual(await f.toolbarOf("valley"), {
      badge: "Not set up",
      tone: MUTED,
      dot: true,
      title: "Set up Drift for Genex.",
    });
  });

  it("goes back to Add when the link is undone", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    const link = await f.linkGame("valley", f.drift);
    assert.equal((await f.toolbarOf("valley")).badge, "Not open");
    await f.unlinkGame("valley", link.linkedAt);
    assert.deepEqual(await f.toolbarOf("valley"), ADD);
  });

  it("is as cheap as the panel's button: one handshake on the game's own port, no writes", async () => {
    const f = await launchFixture();
    const set = await f.act("setup", { project: f.drift });
    await f.linkGame("valley", f.drift);
    f.live.answering = true;
    Object.assign(f.touched, { scans: 0, xcode: 0, disk: 0 });
    f.asked.length = 0;
    const witness = await tree(f.root);
    await f.toolbarOf("valley");
    assert.deepEqual(f.asked, [set.port]);
    assert.deepEqual(f.touched, { scans: 0, xcode: 0, disk: 0 });
    assert.deepEqual(await tree(f.root), witness);
  });
});

/** Link records the toolbar must not trust: each leaves the game without a link, and Unreal unasked. */
const hostileLinks: Array<{ name: string; links?: boolean; game?: string; arrange: (f: Fixture) => Promise<void> }> = [
  {
    name: "a link file that is a symlink to a valid record elsewhere",
    links: true,
    arrange: async (f) => {
      const record = { kind: "unreal", project: f.drift, linkedAt: new Date(START).toISOString() };
      await writeFile(path.join(f.root, "elsewhere.json"), JSON.stringify(record));
      await mkdir(path.join(f.storage, "links"), { recursive: true });
      await symlink(path.join(f.root, "elsewhere.json"), path.join(f.storage, "links", "valley.json"));
    },
  },
  {
    name: "a link to a project file that has since gone",
    arrange: async (f) => {
      await f.linkGame("valley", f.drift);
      await rm(f.drift);
    },
  },
  {
    name: "a link to a project that is a symlink to the real one",
    links: true,
    arrange: async (f) => {
      const alias = path.join(f.root, "Projects", "Alias.uproject");
      await symlink(f.drift, alias);
      await writeLink(f, JSON.stringify({ kind: "unreal", project: alias }));
    },
  },
  {
    name: "a link to a folder named like a project",
    arrange: async (f) => {
      const folder = path.join(f.root, "Projects", "Folder.uproject");
      await mkdir(folder, { recursive: true });
      await writeLink(f, JSON.stringify({ kind: "unreal", project: folder }));
    },
  },
  ...[
    ["a link file that isn't JSON", "{ linked"],
    ["a link file that is a list", "[]"],
    ["a link of another engine", JSON.stringify({ kind: "unity", project: "DRIFT" })],
    ["a link to a relative path", JSON.stringify({ kind: "unreal", project: "Drift/Drift.uproject" })],
    ["a link to a file that isn't a project", JSON.stringify({ kind: "unreal", project: "DRIFT.txt" })],
  ].map(([name, body]) => ({
    name,
    arrange: async (f: Fixture) => writeLink(f, body.replace("DRIFT", f.drift.replace(/\.uproject$/, ""))),
  })),
  {
    name: "a game id that climbs out of the links folder to a valid record",
    game: "../decoy",
    arrange: async (f) => {
      await writeFile(path.join(f.storage, "decoy.json"), JSON.stringify({ kind: "unreal", project: f.drift }));
    },
  },
];

/** Writes the open game's link record as the plugin's storage would hold it, by hand. */
async function writeLink(f: Fixture, body: string, game = "valley") {
  await mkdir(path.join(f.storage, "links"), { recursive: true });
  await writeFile(path.join(f.storage, "links", `${game}.json`), body);
}

describe("The Unreal toolbar never trusts", () => {
  for (const row of hostileLinks)
    it(`${row.name}: the game has no link`, { skip: row.links ? LINKS : false }, async () => {
      const f = await launchFixture();
      await f.act("setup", { project: f.drift });
      await row.arrange(f);
      f.live.running = true;
      f.live.answering = true;
      f.asked.length = 0;
      const witness = await tree(f.root);
      assert.deepEqual(await f.toolbarOf(row.game ?? "valley"), { tone: MUTED, title: "Make this game in Unreal" });
      assert.deepEqual(f.asked, [], "no editor is asked about a project the game isn't linked to");
      assert.deepEqual(await tree(f.root), witness, "and nothing is written");
    });
});

/** Storage the toolbar must not trust: each row says what the badge must stay. */
const hostileToolbar: Array<{ name: string; badge: string; links?: boolean; arrange: (f: Fixture) => Promise<void> }> =
  [
    ...[80, 70_000, "18001", 18_000.5].map((port) => ({
      name: `a setup record with the port ${JSON.stringify(port)}`,
      badge: "Not set up",
      arrange: async (f: Fixture) => {
        await mkdir(path.join(f.storage, "setup", "x"), { recursive: true });
        await writeFile(path.join(f.storage, "setup", "x", "record.json"), JSON.stringify({ project: f.drift, port }));
        await writeFile(path.join(f.storage, "chosen.json"), JSON.stringify({ project: f.drift }));
      },
    })),
    {
      name: "a Starting record for another project",
      badge: "Not open",
      arrange: async (f) => {
        await f.act("setup", { project: f.drift });
        await writeFile(
          path.join(f.storage, "starting.json"),
          JSON.stringify({ project: path.join(f.root, "Projects", "Other", "Other.uproject"), at: START }),
        );
      },
    },
    {
      name: "a Starting record from the future",
      badge: "Not open",
      arrange: async (f) => {
        await f.act("setup", { project: f.drift });
        await writeFile(
          path.join(f.storage, "starting.json"),
          JSON.stringify({ project: f.drift, at: START + MINUTE }),
        );
      },
    },
    {
      name: "a Starting record that isn't JSON",
      badge: "Not open",
      arrange: async (f) => {
        await f.act("setup", { project: f.drift });
        await writeFile(path.join(f.storage, "starting.json"), "{ starting");
      },
    },
    {
      name: "a Starting record that links to one elsewhere",
      badge: "Not open",
      links: true,
      arrange: async (f) => {
        await f.act("setup", { project: f.drift });
        await writeFile(path.join(f.root, "starting.json"), JSON.stringify({ project: f.drift, at: START }));
        await symlink(path.join(f.root, "starting.json"), path.join(f.storage, "starting.json"));
      },
    },
  ];

describe("The toolbar never trusts", () => {
  for (const row of hostileToolbar)
    it(`${row.name}`, { skip: row.links ? LINKS : false }, async () => {
      const f = await launchFixture();
      await row.arrange(f);
      f.live.running = true;
      f.asked.length = 0;
      const witness = await tree(f.root);
      assert.equal((await f.toolbar()).badge, row.badge);
      assert.ok(
        f.asked.every((port) => port >= 18_000 && port <= 18_999),
        "only a port from Genex's own block is asked",
      );
      assert.deepEqual(await tree(f.root), witness);
    });
});

/**
 * The panel shows one primary button: status names it as `next`, so the panel never works out
 * from several fields at once what the user should do now.
 */
describe("The Unreal panel's next step", () => {
  /** One situation of the shown project, and the step status names for it. */
  const situations: Array<{
    name: string;
    engines?: Array<[string, string]>;
    made?: string;
    setUp?: boolean;
    opened?: boolean;
    running?: boolean;
    answering?: boolean;
    /** The shown project's own log is open: Unreal has this very project open. */
    own?: boolean;
    next: string;
  }> = [
    { name: "no supported Unreal: get it", engines: [ENGINES[1]], next: "get-unreal" },
    { name: "a project that isn't set up, Unreal closed: set it up", next: "set-up" },
    {
      name: "a project that isn't set up while Unreal has another project open: set it up",
      running: true,
      next: "set-up",
    },
    {
      name: "a project that isn't set up while Unreal has it open: quit Unreal first",
      running: true,
      own: true,
      next: "quit-first",
    },
    { name: "made with 5.7, Unreal closed: set it up, which switches it to 5.8", made: "5.7", next: "set-up" },
    {
      name: "not set up, opened by Genex and still starting: starting, not quit-first",
      opened: true,
      running: true,
      next: "starting",
    },
    {
      name: "made with 5.7 while Unreal has another project open: set it up",
      made: "5.7",
      running: true,
      next: "set-up",
    },
    {
      name: "made with 5.7 while Unreal has it open: quit Unreal first",
      made: "5.7",
      running: true,
      own: true,
      next: "quit-first",
    },
    { name: "set up, Unreal closed: open it", setUp: true, next: "open" },
    { name: "set up and just opened by Genex: starting", setUp: true, opened: true, next: "starting" },
    { name: "set up and answering: connected", setUp: true, running: true, answering: true, next: "connected" },
    {
      name: "set up, an answer on its port but no Unreal running: not connected, open it",
      setUp: true,
      answering: true,
      next: "open",
    },
    {
      name: "set up, Unreal open with another project (its own log not open): open it once Unreal is free, no restart",
      setUp: true,
      running: true,
      next: "open-when-free",
    },
    {
      name: "set up, Unreal open with this project (its own log still open) but not answering: quit and reopen",
      setUp: true,
      running: true,
      own: true,
      next: "not-answering",
    },
  ];

  /** Drift's own log as Unreal writes it while loading, opened `ago` before the fixture's clock. */
  const loadingLog = (f: Fixture, ago: number, change: Partial<EditorLog> = {}): EditorLog => ({
    open: true,
    openedAt: START - ago,
    mtime: START - 10 * SECOND,
    mcpStarted: false,
    loaded: false,
    ...change,
  });

  it("set up, opened outside Genex and still loading by its own log: starting, timed from the log", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.log = loadingLog(f, 90 * SECOND);
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.opening], ["starting", { at: START - 90 * SECOND, elapsedMs: 90 * SECOND }]);
    assert.deepEqual(await f.toolbar(), {
      badge: "Starting",
      tone: "warn",
      dot: true,
      title: "Opening Drift in Unreal… 1:30",
    });
  });

  for (const [name, change, next] of [
    ["closed, so Unreal has another project: open it once Unreal is free", { open: false }, "open-when-free"],
    ["gone quiet and long open: not answering", { mtime: START - 10 * MINUTE }, "not-answering"],
  ] as const)
    it(`set up, Unreal open, this project's log ${name}`, async () => {
      const f = await launchFixture();
      await f.act("setup", { project: f.drift });
      f.live.running = true;
      f.live.log = loadingLog(f, 30 * MINUTE, change);
      assert.equal((await f.act("status", { project: f.drift })).next, next);
      assert.equal((await f.toolbar()).badge, "Not open");
    });

  it("reads the project's log only while an editor runs and the project doesn't answer", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("status", { project: f.drift });
    await f.toolbar();
    f.live.running = true;
    f.live.answering = true;
    await f.act("status", { project: f.drift });
    await f.toolbar();
    assert.deepEqual(f.logsRead, []);
  });
  for (const s of situations)
    it(s.name, async () => {
      const f = await launchFixture({ engines: s.engines });
      const file = s.made ? await project(path.join(f.root, "Projects"), "Cave", s.made) : f.drift;
      if (s.setUp) await f.act("setup", { project: file });
      if (s.opened) await f.act("open-editor", { project: file });
      f.live.running = s.running === true;
      f.live.answering = s.answering === true;
      if (s.own)
        f.live.log = { open: true, openedAt: START - HOUR, mtime: START - MINUTE, mcpStarted: false, loaded: true };
      const status = await f.act("status", { project: file });
      assert.deepEqual(
        [status.next, status.projectOpen],
        [s.next, s.own === true || (s.answering === true && s.running === true)],
      );
    });

  it("says plainly when the shown project's helper is outdated or its engine is missing", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    const tools = path.join(path.dirname(f.drift), "Plugins/GenexEditorHelper/Content/Python/genex_play/tools.py");
    await writeFile(tools, "# an older helper\n");
    const outdated = await f.act("status", { project: f.drift });
    assert.deepEqual([outdated.helperOutdated, outdated.engineMissing], [true, false]);
    const later = await project(path.join(f.root, "Projects"), "Later", "5.9");
    const missing = await f.act("status", { project: later });
    assert.deepEqual([missing.helperOutdated, missing.engineMissing], [false, true]);
  });

  it("set up, Unreal closed, another app on its port: set it up again, which moves the port", async () => {
    const f = await launchFixture();
    const set = await f.act("setup", { project: f.drift });
    f.live.listening.add(set.port);
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.portTaken], ["set-up", true]);
    const moved = await f.act("setup", { project: f.drift });
    assert.notEqual(moved.port, set.port);
    assert.equal((await f.act("status", { project: f.drift })).next, "open");
  });

  // A crashed editor's crash reporter keeps the project's port: Unreal crashed, which setup would not fix.
  it("set up, Unreal closed, its crash reporter on the port: Unreal crashed, never sent to setup", async () => {
    const f = await launchFixture();
    const set = await f.act("setup", { project: f.drift });
    f.live.listening.add(set.port);
    f.live.crashReporter = new Set([set.port]);
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.portTaken], ["crashed", false]);
    f.live.listening.delete(set.port);
    f.live.crashReporter.clear();
    assert.equal((await f.act("status", { project: f.drift })).next, "open", "the report closed: open it again");
  });

  it("set up, Unreal reopened while its crash reporter holds the port: Unreal crashed, not a blocked port", async () => {
    const f = await launchFixture();
    const set = await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.log = ownLog(25 * SECOND, { openedAt: START + 5 * SECOND, portBlocked: true });
    f.live.crashReporter = new Set([set.port]);
    assert.equal((await f.act("status", { project: f.drift })).next, "crashed");
  });

  it("set up, Unreal running with another project and its port held: opens once Unreal is free, never sent to setup", async () => {
    const f = await launchFixture();
    const set = await f.act("setup", { project: f.drift });
    f.live.listening.add(set.port);
    f.live.running = true;
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.portTaken], ["open-when-free", false]);
  });

  it("set up, Unreal running, this project's log never closed and nobody can tell whether an editor holds it: never offers a restart", async () => {
    // Restart quits the editor; one that may hold another project is never quit from here.
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.log = {
      open: true,
      openUnsure: true,
      openedAt: START - HOUR,
      mtime: START - MINUTE,
      mcpStarted: false,
      loaded: true,
    };
    const status = await f.act("status", { project: f.drift });
    assert.equal(status.next, "open-when-free");
  });

  it("with nothing found or named, the next step is choosing a game", async () => {
    const f = await launchFixture();
    const status = await f.act("status");
    assert.deepEqual([status.project, status.next], [undefined, "choose"]);
  });

  it("says whether the shown project is the user's choice or only the most recent one", async () => {
    const f = await launchFixture();
    const found = await project(path.join(f.home, "Documents", "Unreal Projects"), "Found");
    const first = await f.act("status");
    assert.deepEqual([first.project?.name, first.chosen], ["Found", false], "the most recent, not chosen yet");
    assert.equal((await f.act("status", { project: found })).chosen, true, "named by the panel");
    assert.equal((await f.act("status")).chosen, true, "remembered as the choice");
  });

  it("the New game form names where games are saved as folders from home", async () => {
    const f = await launchFixture();
    const offer = await f.act("templates");
    assert.deepEqual(offer.place, ["Documents", "Unreal Projects"]);
  });
});

/** Drift's own log while it loads, opened `ago` before the clock; `loaded` once Unreal says it finished. */
const ownLog = (ago: number, change: Partial<EditorLog> = {}): EditorLog => ({
  open: true,
  openedAt: START - ago,
  mtime: START - 10 * SECOND,
  mcpStarted: false,
  loaded: false,
  ...change,
});

/** Writes Unreal's Recent Projects list for 5.8 with `[file, LastOpenTime]` pairs, as Epic writes them. */
async function recentList(f: Fixture, entries: Array<[string, string]>) {
  const dir = path.join(
    f.home,
    "Library",
    "Application Support",
    "Epic",
    "UnrealEngine",
    "5.8",
    "Saved",
    "Config",
    "MacEditor",
  );
  await mkdir(dir, { recursive: true });
  const lines = entries.map(([file, at]) => `RecentlyOpenedProjectFiles=(ProjectName="${file}",LastOpenTime=${at})`);
  await writeFile(path.join(dir, "EditorSettings.ini"), ["[/Script/UnrealEd.EditorSettings]", ...lines, ""].join("\n"));
}

/** Epic's LastOpenTime spelling (UTC) of a time in ms. */
const epicTime = (ms: number) => {
  const d = new Date(ms).toISOString();
  return `${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}-${d.slice(11, 13)}.${d.slice(14, 16)}.${d.slice(17, 19)}`;
};

const toolHelper = (f: Fixture) =>
  path.join(path.dirname(f.drift), "Plugins/GenexEditorHelper/Content/Python/genex_play/tools.py");

describe("A project made with an older Unreal", () => {
  it("never loops: setup switches it to 5.8 under Studio's confirmation, then it opens", async () => {
    const f = await launchFixture();
    const cave = await project(path.join(f.root, "Projects"), "Cave", "5.7");
    assert.equal((await f.act("status", { project: cave })).next, "set-up");
    await assert.rejects(f.act("open-editor", { project: cave }));
    assert.deepEqual(f.launched, []);
    assert.match((await f.review("setup", { project: cave }))?.detail ?? "", /from Unreal 5\.7 to 5\.8/);
    await f.act("setup", { project: cave });
    assert.equal(JSON.parse(await readFile(cave, "utf8")).EngineAssociation, "5.8");
    assert.equal((await f.act("status", { project: cave })).next, "open");
    await f.act("open-editor", { project: cave });
    assert.equal(f.launched.length, 1);
  });

  it("undo puts its own Unreal version back", async () => {
    const f = await launchFixture();
    const cave = await project(path.join(f.root, "Projects"), "Cave", "5.7");
    await f.act("setup", { project: cave });
    await f.act("undo-setup", { project: cave });
    assert.equal(JSON.parse(await readFile(cave, "utf8")).EngineAssociation, "5.7");
  });

  it("a project of a source-built engine keeps its association", async () => {
    const f = await launchFixture();
    const custom = await project(path.join(f.root, "Projects"), "Custom", "{8D4F2C1A-0000-0000-0000-000000000000}");
    await f.act("setup", { project: custom });
    assert.equal(
      JSON.parse(await readFile(custom, "utf8")).EngineAssociation,
      "{8D4F2C1A-0000-0000-0000-000000000000}",
    );
  });
});

describe("The panel's status while Unreal loads", () => {
  it("a loaded editor that still doesn't answer is not starting, even just after Genex opened it", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.tick(2 * MINUTE);
    f.live.running = true;
    f.live.log = ownLog(2 * MINUTE - 1, { loaded: true, openedAt: START + SECOND });
    assert.equal((await f.act("status", { project: f.drift })).next, "not-answering");
    assert.equal((await f.toolbar()).badge, "Not open");
  });

  it("Genex opened it 25 minutes ago and its log still loads: starting", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.tick(25 * MINUTE);
    f.live.running = true;
    f.live.log = { ...ownLog(0), openedAt: START + SECOND, mtime: START + 25 * MINUTE - 20 * SECOND };
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.opening?.at], ["starting", START]);
  });
});

describe("A set-up project with an older Genex editor helper", () => {
  const situations: Array<{
    name: string;
    running?: boolean;
    answering?: boolean;
    opened?: boolean;
    /** Its own log is still open: Unreal has this very project open. */
    own?: boolean;
    next: string;
  }> = [
    { name: "Unreal closed: open it, which updates the helper first", next: "open" },
    { name: "running and answering: connected", running: true, answering: true, next: "connected" },
    { name: "running with it open, not answering: not answering", running: true, own: true, next: "not-answering" },
    { name: "opened by Genex and starting: starting", opened: true, running: true, next: "starting" },
  ];
  for (const s of situations)
    it(s.name, async () => {
      const f = await launchFixture();
      await f.act("setup", { project: f.drift });
      // Opened before this Genex shipped a newer helper: Open itself would have updated it.
      if (s.opened) await f.act("open-editor", { project: f.drift });
      await writeFile(toolHelper(f), "# an older helper\n");
      f.live.running = s.running === true;
      f.live.answering = s.answering === true;
      if (s.own) f.live.log = ownLog(HOUR, { loaded: true });
      const status = await f.act("status", { project: f.drift });
      assert.deepEqual([status.next, status.helperOutdated], [s.next, true]);
    });
});

describe("The game a project belongs to", () => {
  it("says whether a Genex game builds in the shown project, so the panel can say where to type", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    assert.equal((await f.act("status", { project: f.drift })).owned, false, "no game uses Drift yet");
    await f.linkGame("drift-day", f.drift);
    assert.equal((await f.act("status", { project: f.drift })).owned, true);
    const rally = await project(path.join(f.root, "Projects"), "Rally");
    assert.equal((await f.act("status", { project: rally })).owned, false, "another project");
  });
});

describe("Unreal has another set-up project open", () => {
  /** Drift and Rally both set up; Rally's editor runs and answers, Drift is the one shown. */
  async function twoProjects() {
    const f = await launchFixture();
    const rally = await project(path.join(f.root, "Projects"), "Rally");
    await f.act("setup", { project: rally });
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.answering = true;
    f.live.serving = rally;
    return { f, rally };
  }

  it("offers one switch to the shown project, naming the one Unreal has open", async () => {
    const { f, rally } = await twoProjects();
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.openProject], ["switch", { name: "Rally", file: rally }]);
  });

  it("names the game whose Loop uses Unreal, so the panel offers no quit", async () => {
    const { f, rally } = await twoProjects();
    assert.equal((await f.act("status", { project: f.drift })).busyRun, null, "an older host names no run");
    f.outcome.runs = [{ game: "rally-night", title: "Rally Night", project: rally }];
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.busyRun], ["switch", { title: "Rally Night", project: rally, here: false }]);
    assert.equal((await f.actIn("rally-night", "status")).busyRun?.here, true, "the open game's own Loop");
    f.live.running = false;
    f.live.answering = false;
    assert.equal((await f.act("status", { project: f.drift })).busyRun, null, "no editor runs: nothing to keep open");
  });

  it("with no other set-up project answering and its own log not open, it opens once Unreal is free", async () => {
    const { f } = await twoProjects();
    f.live.answering = false;
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.openProject], ["open-when-free", null]);
  });

  it("asks other projects' ports only while the shown one runs unanswered, and only Genex's recorded ports", async () => {
    const { f, rally } = await twoProjects();
    const ports = {
      drift: (await f.act("status", { project: f.drift })).port,
      rally: (await f.act("status", { project: rally })).port,
    };
    const asks = async () => {
      f.asked.length = 0;
      await f.act("status", { project: f.drift });
      return [...f.asked].sort();
    };
    assert.deepEqual(await asks(), [ports.drift, ports.rally].sort(), "running, unanswered: Rally is asked too");
    f.live.running = false;
    assert.deepEqual(await asks(), [ports.drift], "Unreal closed");
    f.live.running = true;
    f.live.serving = undefined;
    assert.deepEqual(await asks(), [ports.drift], "the shown project answers");
    f.live.serving = rally;
    f.live.log = ownLog(30 * SECOND);
    assert.deepEqual(await asks(), [ports.drift], "the shown project is still loading");
  });

  it("never asks a project whose record lost its port to one outside Genex's block, and writes nothing", async () => {
    const { f, rally } = await twoProjects();
    const records = path.join(f.storage, "setup");
    for (const key of await readdir(records)) {
      const file = path.join(records, key, "record.json");
      const record = JSON.parse(await readFile(file, "utf8"));
      if (record.project === rally) await writeFile(file, JSON.stringify({ ...record, port: 8000 }));
    }
    const witness = await tree(f.root);
    f.asked.length = 0;
    const status = await f.act("status", { project: f.drift });
    assert.equal(status.next, "open-when-free");
    assert.ok(!f.asked.includes(8000));
    assert.deepEqual(await tree(f.root), witness);
  });
});

describe("Unreal has a project open that isn't the shown one", () => {
  it("never offers to restart Unreal for a set-up project it doesn't have open, and names what it has", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.held = ["Harbor"];
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.projectOpen, status.holder], ["open-when-free", false, "Harbor"]);
  });

  it("names nothing when the computer can't tell which project Unreal has open", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.holder], ["open-when-free", null]);
  });

  it("names the project Unreal has open beside one it only sets up, never the shown one itself", async () => {
    const f = await launchFixture();
    f.live.running = true;
    f.live.held = ["Drift", "Harbor"];
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.holder], ["set-up", "Harbor"]);
    f.live.log = ownLog(HOUR, { loaded: true });
    const open = await f.act("status", { project: f.drift });
    assert.deepEqual([open.next, open.holder], ["quit-first", null], "Unreal has Drift itself open");
  });

  it("names the other set-up project that answers first, without asking which logs are held", async () => {
    const f = await launchFixture();
    const rally = await project(path.join(f.root, "Projects"), "Rally");
    await f.act("setup", { project: rally });
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.answering = true;
    f.live.serving = rally;
    f.live.held = ["Harbor"];
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.holder], ["switch", "Rally"]);
  });
});

describe("A Loop counts as using Unreal", () => {
  it("only while its own project is the one Unreal has open", async () => {
    const f = await launchFixture();
    const projects = path.join(f.root, "Projects");
    const [rally, harbor] = [await project(projects, "Rally"), await project(projects, "Harbor")];
    for (const file of [rally, harbor, f.drift]) await f.act("setup", { project: file });
    f.live.running = true;
    f.live.answering = true;
    f.live.serving = rally;
    const busy = async (runs: Array<{ game: string; title: string; project: string }>) => {
      f.outcome.runs = runs;
      return (await f.act("status", { project: f.drift })).busyRun;
    };
    const driftDay = { game: "drift-day", title: "Drift Day", project: f.drift };
    const harborNight = { game: "harbor-night", title: "Harbor Night", project: harbor };
    const rallyNight = { game: "rally-night", title: "Rally Night", project: rally };
    assert.equal(await busy([driftDay]), null, "Drift's Loop, but Unreal has Rally open");
    assert.equal(await busy([harborNight]), null, "Harbor's Loop, Harbor neither answering nor in its log");
    assert.deepEqual(await busy([harborNight, rallyNight]), { title: "Rally Night", project: rally, here: false });
    f.live.logs = { [harbor]: ownLog(30 * SECOND) };
    assert.deepEqual(
      await busy([harborNight]),
      { title: "Harbor Night", project: harbor, here: false },
      "Harbor still loading by its own log",
    );
    assert.equal(
      (await f.act("status", { project: f.drift })).next,
      "switch",
      "Rally answers, so switching is offered",
    );
  });
});

describe("The panel's disk note", () => {
  const rows: Array<{ name: string; engines: Array<[string, string]>; free: number; low: boolean; need: number }> = [
    { name: "no Unreal, 30 GB free: warns with the install budget", engines: [], free: 30, low: true, need: 65 },
    { name: "no Unreal, 64 GB free: warns", engines: [], free: 64, low: true, need: 65 },
    { name: "no Unreal, 70 GB free: fine", engines: [], free: 70, low: false, need: 65 },
    { name: "only 5.7, 30 GB free: warns", engines: [ENGINES[1]], free: 30, low: true, need: 65 },
    { name: "5.8 installed, 30 GB free: fine", engines: ENGINES, free: 30, low: false, need: 20 },
    { name: "5.8 installed, 12 GB free: warns with the project need", engines: ENGINES, free: 12, low: true, need: 20 },
  ];
  for (const row of rows)
    it(row.name, async () => {
      const f = await launchFixture({ engines: row.engines });
      f.env.freeBytes = async () => row.free * GIB;
      const status = await f.act("status", { project: f.drift });
      assert.deepEqual(
        [status.lowDisk, status.diskNeedBytes / GIB, status.installBytes / GIB],
        [row.low, row.need, 45],
      );
    });
});

describe("The Get Unreal view knows whether Epic's launcher is installed", () => {
  const rows: Array<{ name: string; launcher: boolean; links?: boolean; arrange: (app: string) => Promise<unknown> }> =
    [
      { name: "no launcher", launcher: false, arrange: async () => undefined },
      { name: "the launcher app", launcher: true, arrange: (app) => mkdir(app) },
      { name: "a plain file named like it", launcher: false, arrange: (app) => writeFile(app, "not an app") },
      {
        name: "a link to another app",
        launcher: false,
        links: true,
        arrange: async (app) => {
          const other = path.join(path.dirname(path.dirname(app)), "Other.app");
          await mkdir(other);
          await symlink(other, app);
        },
      },
    ];
  for (const row of rows)
    it(`${row.name}: launcher ${row.launcher}`, { skip: row.links ? LINKS : false }, async () => {
      const f = await launchFixture({ engines: [ENGINES[1]] });
      await row.arrange(path.join(f.applications, "Epic Games Launcher.app"));
      assert.equal((await f.act("status", { project: f.drift })).launcher, row.launcher);
      assert.deepEqual(f.launched, []);
    });

  it("with Unreal 5.8 it isn't asked", async () => {
    const f = await launchFixture();
    assert.equal((await f.act("status", { project: f.drift })).launcher, null);
  });
});

describe("The first start", () => {
  it("a project Unreal has never opened: first start", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    assert.equal((await f.act("status", { project: f.drift })).firstStart, true);
  });

  it("a project in Unreal's recent list before the launch: not the first start", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await recentList(f, [[f.drift, epicTime(START - 60 * MINUTE)]]);
    assert.equal((await f.act("status", { project: f.drift })).firstStart, false);
    await f.act("open-editor", { project: f.drift });
    f.live.running = true;
    assert.equal((await f.act("status", { project: f.drift })).firstStart, false);
  });

  it("Genex opened it and Unreal listed it during this start: still the first start", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.tick(14 * SECOND);
    f.live.running = true;
    await recentList(f, [[f.drift, epicTime(START + 14 * SECOND)]]);
    assert.equal((await f.act("status", { project: f.drift })).firstStart, true);
  });
});

/** Unreal's own log for Drift, written the way the editor writes it: a BOM, then local time. */
const UNREAL_LOG = (project: string, tail: string) =>
  [
    "\uFEFFLog file open, 01/01/26 12:00:00",
    "LogInit: Display: Running engine for game: Drift",
    `LogCsvProfiler: Display: Metadata set : commandline="" ${project}""`,
    "LogShaderCompilers: Display: Compiling shaders",
    tail,
  ].join("\n");

describe("A project's own Unreal log", () => {
  async function logFixture(text: string | Buffer) {
    const root = await realpath(await tmpDir("studio-unreal-log-"));
    const project = path.join(root, "Projects", "Drift", "Drift.uproject");
    const file = editorLogPath({ file: project, directory: path.dirname(project) }, path.join(root, "home"), HOST);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    return { root, project, file };
  }

  it("lives where Unreal writes it: ~/Library/Logs on a Mac, the project's Saved/Logs on Windows", () => {
    const project = { file: "/Games/Drift/Drift.uproject", directory: "/Games/Drift" };
    assert.equal(
      editorLogPath(project, "/Users/ann", "darwin"),
      "/Users/ann/Library/Logs/Unreal Engine/DriftEditor/Drift.log",
    );
    assert.equal(
      editorLogPath(
        { file: "C:\\Games\\Drift\\Drift.uproject", directory: "C:\\Games\\Drift" },
        "C:\\Users\\ann",
        "win32",
      ),
      "C:\\Games\\Drift\\Saved\\Logs\\Drift.log",
    );
  });

  it("says when the editor opened, whether it is still open, and whether Epic's server started", async () => {
    const loading = await logFixture("");
    await writeFile(
      loading.file,
      UNREAL_LOG(loading.project, "LogModelContextProtocol: Starting MCP server on port 18642"),
    );
    const read = await readEditorLog(loading.file, loading.project);
    assert.deepEqual(
      [read?.open, read?.openedAt, read?.mcpStarted],
      [true, new Date(2026, 0, 1, 12, 0, 0).getTime(), true],
    );
    const closed = await logFixture("");
    await writeFile(
      closed.file,
      UNREAL_LOG(closed.project, "[2026.01.01-12.00.44:628][262]Log file closed, 01/01/26 12:00:44\n"),
    );
    assert.equal((await readEditorLog(closed.file, closed.project))?.open, false);
  });

  it("reads only a bounded head and tail of a large log", async () => {
    const f = await logFixture("");
    const middle = "LogStreaming: Display: still loading\n".repeat(20_000);
    await writeFile(
      f.file,
      UNREAL_LOG(f.project, `${middle}LogModelContextProtocol: Starting MCP server on port 18642`),
    );
    assert.equal((await readEditorLog(f.file, f.project))?.mcpStarted, true);
  });

  it("says when Unreal finished loading, even when that line is far from both ends of the log", async () => {
    const f = await logFixture("");
    const lines = "LogStreaming: Display: still loading\n".repeat(20_000);
    await writeFile(f.file, UNREAL_LOG(f.project, lines));
    assert.equal((await readEditorLog(f.file, f.project))?.loaded, false);
    const done = "LogLoad: (Engine Initialization) Total time: 44.12 seconds\n";
    await writeFile(f.file, UNREAL_LOG(f.project, `${lines}${done}${lines}`));
    assert.equal((await readEditorLog(f.file, f.project))?.loaded, true);
  });

  const hostileLogs: Array<{
    name: string;
    links?: boolean;
    arrange: (f: Awaited<ReturnType<typeof logFixture>>) => Promise<void>;
  }> = [
    {
      name: "a log that links to another project's log",
      links: true,
      arrange: async (f) => {
        const other = path.join(f.root, "other.log");
        await writeFile(other, UNREAL_LOG(f.project, ""));
        await rm(f.file);
        await symlink(other, f.file);
      },
    },
    { name: "a garbled head", arrange: async (f) => writeFile(f.file, Buffer.alloc(64 * 1024, 0xff)) },
    {
      name: "a commandline naming another project",
      arrange: async (f) => writeFile(f.file, UNREAL_LOG(path.join(f.root, "Other", "Other.uproject"), "")),
    },
    {
      name: "a commandline naming a project whose path only starts like this one",
      arrange: async (f) => writeFile(f.file, UNREAL_LOG(`${f.project}.bak`, "")),
    },
    {
      name: "a folder where the log should be",
      arrange: async (f) => {
        await rm(f.file);
        await mkdir(f.file);
      },
    },
  ];
  for (const row of hostileLogs)
    it(`reads nothing from ${row.name}, and writes nothing`, { skip: row.links ? LINKS : false }, async () => {
      const f = await logFixture(UNREAL_LOG("", ""));
      await row.arrange(f);
      const witness = await tree(f.root);
      assert.equal(await readEditorLog(f.file, f.project), undefined);
      assert.deepEqual(await tree(f.root), witness);
    });

  it("says Epic's server couldn't listen on the project's own port, wherever that line is in the log", async () => {
    const f = await logFixture("");
    const lines = "LogStreaming: Display: still loading\n".repeat(20_000);
    const failed = `[2026.01.01-12.10.00:123][  0]${EPIC_BIND_FAILED}18118\n`;
    await writeFile(f.file, UNREAL_LOG(f.project, `${lines}${failed}${lines}`));
    assert.equal((await readEditorLog(f.file, f.project, 18118))?.portBlocked, true);
    assert.equal((await readEditorLog(f.file, f.project, 18119))?.portBlocked, false, "another port's failure");
    assert.equal((await readEditorLog(f.file, f.project))?.portBlocked, false, "no port asked about");
    const bound = await logFixture("");
    await writeFile(
      bound.file,
      UNREAL_LOG(bound.project, "LogModelContextProtocol: Starting MCP server on port 18118"),
    );
    assert.equal((await readEditorLog(bound.file, bound.project, 18118))?.portBlocked, false);
  });
});

/** Epic's HTTP server's line when it can't listen on an address, up to the port. */
const EPIC_BIND_FAILED = "LogHttpListener: Error: HttpListener unable to bind to 127.0.0.1:";

describe("Epic's line for a port its server couldn't listen on", () => {
  /** Log lines and whether each says Epic's server couldn't listen on port 18118. */
  const lines: Array<[string, boolean]> = [
    [`${EPIC_BIND_FAILED}18118`, true],
    [`[2026.01.01-12.10.00:123][  0]${EPIC_BIND_FAILED}18118`, true],
    [`[2026.01.01-12.10.00:123][  0]${EPIC_BIND_FAILED}18118  `, true],
    [`${EPIC_BIND_FAILED}18119`, false],
    [`${EPIC_BIND_FAILED}181180`, false],
    [`${EPIC_BIND_FAILED}1811`, false],
    [`${EPIC_BIND_FAILED}018118`, false],
    [`${EPIC_BIND_FAILED}18118x`, false],
    [`${EPIC_BIND_FAILED}-18118`, false],
    [`${EPIC_BIND_FAILED}`, false],
    [`${EPIC_BIND_FAILED}99999999999999999999`, false],
    [`${EPIC_BIND_FAILED}18118 (retrying)`, false],
    ["LogHttpListener: Error: HttpListener unable to bind to 0.0.0.0:18118", false],
    ["LogHttpListener: Warning: HttpListener unable to bind to 127.0.0.1:18118", false],
    ["LogPython: Error: HttpListener unable to bind to 127.0.0.1:18118", false],
    [`LogTemp: Display: ${EPIC_BIND_FAILED}18118`, false],
    ["", false],
  ];
  for (const [line, blocked] of lines)
    it(`${blocked ? "recognises" : "ignores"} ${JSON.stringify(line)}`, () => {
      assert.equal(portBlockedIn([line], 18118), blocked);
    });

  it("is about the project's own port only", () => {
    assert.equal(portBlockedIn([`${EPIC_BIND_FAILED}18118`], 18119), false);
    assert.equal(portBlockedIn(["LogInit: Display: starting", `${EPIC_BIND_FAILED}18118`], 18118), true);
  });
});

/** What the stand-in lsof answers: its output, or how it fails (exit 1 is lsof's "not open"). */
type LsofAnswer = { stdout?: string; stderr?: string; exit?: number; error?: string; killed?: boolean };

/** An lsof stand-in that answers `answer` and records each call; nothing runs. */
function lsofStandIn(answer: LsofAnswer) {
  const calls: Array<[string, readonly string[]]> = [];
  const runner: Runner = async (file, args) => {
    calls.push([file, args]);
    if (answer.error) throw Object.assign(new Error(`spawn ${file} ${answer.error}`), { code: answer.error });
    if (answer.killed)
      throw Object.assign(new Error("timed out"), { killed: true, code: null, stdout: "", stderr: "" });
    if (answer.exit)
      throw Object.assign(new Error(`Command failed: ${file}`), {
        code: answer.exit,
        stdout: answer.stdout ?? "",
        stderr: answer.stderr ?? "",
      });
    return { stdout: answer.stdout ?? "" };
  };
  return { runner, calls };
}

const LSOF = "/usr/sbin/lsof";
/** lsof's question about one log: pids only, the editor's own process by its whole name, the file after `--`. */
const lsofAboutLog = (file: string) => [LSOF, ["-w", "-t", "-a", "-c", "/^UnrealEditor$/", "--", file]];

describe("A project's log no editor holds", () => {
  /** Drift's log as Unreal leaves it: never closed (an editor that crashed), or closed. */
  async function leftLog(closed: boolean) {
    const root = await realpath(await tmpDir("studio-unreal-stale-"));
    const home = path.join(root, "home");
    const project = path.join(root, "Projects", "Drift", "Drift.uproject");
    const file = editorLogPath({ file: project, directory: path.dirname(project) }, home, "darwin");
    await mkdir(path.dirname(file), { recursive: true });
    const close = closed ? "[2026.01.01-12.00.44:628][262]Log file closed, 01/01/26 12:00:44\n" : "";
    await writeFile(file, UNREAL_LOG(project, `LogLoad: (Engine Initialization) Total time: 44.12 seconds\n${close}`));
    return { root, home, project, file };
  }

  const rows: Array<{
    name: string;
    closed?: boolean;
    lsof: LsofAnswer;
    open: boolean;
    unsure: boolean;
    asks: boolean;
  }> = [
    { name: "an editor holds it: open", lsof: { stdout: "96814\n" }, open: true, unsure: false, asks: true },
    {
      name: "no editor holds it (a crash days ago, another editor running now): not open",
      lsof: { exit: 1 },
      open: false,
      unsure: false,
      asks: true,
    },
    {
      name: "lsof isn't there: it can't tell, so open as the log says, and unsure",
      lsof: { error: "ENOENT" },
      open: true,
      unsure: true,
      asks: true,
    },
    {
      name: "lsof complains: it can't tell, so open as the log says, and unsure",
      lsof: { exit: 1, stderr: "lsof: can't get PID list" },
      open: true,
      unsure: true,
      asks: true,
    },
    { name: "lsof runs out of time: it can't tell", lsof: { killed: true }, open: true, unsure: true, asks: true },
    { name: "lsof fails some other way: it can't tell", lsof: { exit: 2 }, open: true, unsure: true, asks: true },
    {
      name: "a log that says it closed: not open, and lsof isn't asked",
      closed: true,
      lsof: { stdout: "96814\n" },
      open: false,
      unsure: false,
      asks: false,
    },
  ];
  for (const row of rows)
    it(`${row.name}, and writes nothing`, { skip: MAC_LSOF }, async () => {
      const f = await leftLog(row.closed === true);
      const { runner, calls } = lsofStandIn(row.lsof);
      const witness = await tree(f.root);
      const log = await systemEditorLog(
        f.home,
        "darwin",
        runner,
      )({ file: f.project, directory: path.dirname(f.project) });
      assert.equal(log?.open, row.open);
      assert.equal(log?.openUnsure === true, row.unsure);
      assert.deepEqual(calls, row.asks ? [lsofAboutLog(f.file)] : []);
      assert.deepEqual(await tree(f.root), witness);
    });

  it("asks lsof only on a Mac", async () => {
    const { runner, calls } = lsofStandIn({ exit: 1 });
    assert.equal(editorHoldsLog("win32", runner), undefined);
    assert.equal(editorHoldsLog("linux", runner), undefined);
    assert.equal(
      await editorHoldsLog("darwin", runner)?.("/Users/ann/Library/Logs/Unreal Engine/DriftEditor/Drift.log"),
      false,
    );
    assert.equal(calls.length, 1);
  });
});

describe("The projects Unreal has open, by the logs its editors hold", () => {
  async function logsHome() {
    const root = await realpath(await tmpDir("studio-unreal-held-"));
    const home = path.join(root, "home");
    const logs = path.join(home, "Library", "Logs", "Unreal Engine");
    for (const name of ["Drift", "Harbor"]) {
      await mkdir(path.join(logs, `${name}Editor`), { recursive: true });
      await writeFile(path.join(logs, `${name}Editor`, `${name}.log`), UNREAL_LOG(`/p/${name}.uproject`, ""));
    }
    // Unreal's own folders that are no project's, and a folder that is a link elsewhere.
    await mkdir(path.join(logs, "Editor"), { recursive: true });
    await mkdir(path.join(logs, "CrashReportClient"), { recursive: true });
    await mkdir(path.join(root, "elsewhere", "LinkedEditor"), { recursive: true });
    if (process.platform !== "win32")
      await symlink(path.join(root, "elsewhere", "LinkedEditor"), path.join(logs, "LinkedEditor"));
    return { root, home, logs };
  }

  it("names each project whose own log an editor holds, asking about every project log at once", {
    skip: MAC_LSOF,
  }, async () => {
    const f = await logsHome();
    const harbor = path.join(f.logs, "HarborEditor", "Harbor.log");
    const { runner, calls } = lsofStandIn({ exit: 1, stdout: `p96814\nf5\nn${harbor}\n` });
    const witness = await tree(f.root);
    assert.deepEqual(await heldProjectNames("darwin", runner, f.home), ["Harbor"]);
    assert.deepEqual(calls, [
      [
        LSOF,
        ["-w", "-Fn", "-a", "-c", "/^UnrealEditor$/", "--", path.join(f.logs, "DriftEditor", "Drift.log"), harbor],
      ],
    ]);
    assert.deepEqual(await tree(f.root), witness);
  });

  it("asks nothing off a Mac", async () => {
    const f = await logsHome();
    const { runner, calls } = lsofStandIn({ stdout: "p1\n" });
    assert.deepEqual(await heldProjectNames("win32", runner, f.home), []);
    assert.deepEqual(calls, []);
  });

  it("never asks lsof about no files, which would list every file the editor has open", async () => {
    const root = await realpath(await tmpDir("studio-unreal-held-none-"));
    const { runner, calls } = lsofStandIn({ stdout: "p1\nn/anything\n" });
    assert.deepEqual(await heldProjectNames("darwin", runner, path.join(root, "home")), []);
    assert.deepEqual(calls, []);
  });

  it("names nothing when lsof can't answer", async () => {
    const f = await logsHome();
    for (const answer of [{ error: "ENOENT" }, { killed: true }, { exit: 2 }])
      assert.deepEqual(
        await heldProjectNames("darwin", lsofStandIn(answer).runner, f.home),
        [],
        JSON.stringify(answer),
      );
  });

  const named: Array<[string, string[]]> = [
    ["n/Users/ann/Library/Logs/Unreal Engine/HarborEditor/Harbor.log", ["Harbor"]],
    ["n/Users/J\\xc3\\xbcrgen/Library/Logs/Unreal Engine/HarborEditor/Harbor.log", ["Harbor"]],
    ["n/Users/ann/Library/Logs/Unreal Engine/HarborEditor/Harbor-backup-2026.01.01-12.00.00.log", []],
    ["n/Users/ann/Library/Logs/Unreal Engine/HarborEditor/Other.log", []],
    ["n/Users/ann/Library/Logs/Unreal Engine/Editor/.log", []],
    ["p96814", []],
    ["", []],
  ];
  for (const [line, names] of named)
    it(`reads ${JSON.stringify(line)} as ${JSON.stringify(names)}`, () => {
      assert.deepEqual(namesInLsof(`${line}\n`), names);
    });
});

// A crashed editor's crash reporter inherits its sockets and keeps the project's port until it is closed.
describe("Unreal's crash reporter holding a project's port", () => {
  const ASK = [LSOF, ["-w", "-n", "-P", "-t", "-a", "-c", "CrashRep", "-iTCP:18090", "-sTCP:LISTEN"]];

  it("is asked of lsof by the reporter's name and the port, listening only", async () => {
    const { runner, calls } = lsofStandIn({ stdout: "37769\n" });
    assert.equal(await crashReporterHolds(18090, "darwin", runner), true);
    assert.deepEqual(calls, [ASK]);
  });

  it("is false when lsof finds no reporter there, and unknown when lsof can't answer", async () => {
    assert.equal(await crashReporterHolds(18090, "darwin", lsofStandIn({ exit: 1 }).runner), false);
    for (const answer of [{ error: "ENOENT" }, { killed: true }, { exit: 2 }])
      assert.equal(
        await crashReporterHolds(18090, "darwin", lsofStandIn(answer).runner),
        undefined,
        JSON.stringify(answer),
      );
  });

  it("asks nothing off a Mac, or for a port Unreal can't use", async () => {
    const { runner, calls } = lsofStandIn({ stdout: "1\n" });
    assert.equal(await crashReporterHolds(18090, "win32", runner), undefined);
    for (const port of [0, -1, 1.5, 70_000, Number.NaN])
      assert.equal(await crashReporterHolds(port, "darwin", runner), undefined, String(port));
    assert.deepEqual(calls, []);
  });
});

describe("A project's log naming it in another spelling", () => {
  /** Drift's real project, its open log naming `named(f)`, and a project Other beside it. */
  async function spelled(named: (f: { root: string; project: string; other: string }) => Promise<string>) {
    const root = await realpath(await tmpDir("studio-unreal-spelling-"));
    const project = path.join(root, "Projects", "Drift", "Drift.uproject");
    const other = path.join(root, "Projects", "Other", "Other.uproject");
    for (const file of [project, other]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{}\n");
    }
    const file = editorLogPath({ file: project, directory: path.dirname(project) }, path.join(root, "home"), HOST);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, UNREAL_LOG(await named({ root, project, other }), ""));
    return { root, project, file };
  }

  const rows: Array<{
    name: string;
    named: Parameters<typeof spelled>[0];
    ours: boolean;
    links?: boolean;
    caseless?: boolean;
  }> = [
    { name: "as it is", named: async (f) => f.project, ours: true },
    {
      name: "through a link to its folder's parent",
      links: true,
      named: async (f) => {
        await symlink(path.join(f.root, "Projects"), path.join(f.root, "Linked"));
        return path.join(f.root, "Linked", "Drift", "Drift.uproject");
      },
      ours: true,
    },
    {
      name: "in another case",
      caseless: true,
      named: async (f) => path.join(f.root, "projects", "drift", "DRIFT.uproject"),
      ours: true,
    },
    { name: "another project", named: async (f) => f.other, ours: false },
    {
      name: "a link named like it that leads to another project",
      links: true,
      named: async (f) => {
        await mkdir(path.join(f.root, "Links", "Drift"), { recursive: true });
        await symlink(f.other, path.join(f.root, "Links", "Drift", "Drift.uproject"));
        return path.join(f.root, "Links", "Drift", "Drift.uproject");
      },
      ours: false,
    },
    {
      name: "a project that isn't there",
      named: async (f) => path.join(f.root, "Gone", "Drift.uproject"),
      ours: false,
    },
  ];
  for (const row of rows)
    it(`${row.ours ? "is" : "isn't"} its log when it names ${row.name}, and writes nothing`, {
      skip: row.links ? LINKS : false,
    }, async () => {
      const f = await spelled(row.named);
      if (row.caseless && !(await caseInsensitive(f.root))) return;
      const witness = await tree(f.root);
      assert.equal((await readEditorLog(f.file, f.project))?.open === true, row.ours);
      assert.deepEqual(await tree(f.root), witness);
    });
});

/** Whether the folder's file system ignores case, as macOS and Windows do by default. */
async function caseInsensitive(dir: string): Promise<boolean> {
  const probe = path.join(dir, "CaseProbe.txt");
  await writeFile(probe, "x");
  return access(path.join(dir, "caseprobe.txt")).then(
    () => true,
    () => false,
  );
}

describe("Open in Unreal right after Unreal quit", () => {
  it("waits until the project's own port is free, then opens", async () => {
    const f = await launchFixture();
    const { port } = await f.act("setup", { project: f.drift });
    f.ports.heldUntil = START + 20 * SECOND;
    const opened = await f.act("open-editor", { project: f.drift });
    assert.deepEqual(opened, { project: f.drift, launched: true, at: START + 20 * SECOND });
    assert.equal(f.launched.length, 1);
    assert.ok(f.ports.checked.length > 1, "it asked again while the port was held");
    assert.deepEqual(new Set(f.ports.checked), new Set([port]), "only the project's own port is asked");
    f.live.running = true;
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.busyPort], ["starting", null]);
  });

  it("gives up after the wait and still opens; status says the port was still held", async () => {
    const f = await launchFixture();
    const { port } = await f.act("setup", { project: f.drift });
    f.ports.heldUntil = Number.POSITIVE_INFINITY;
    const opened = await f.act("open-editor", { project: f.drift });
    assert.equal(opened.launched, true);
    assert.equal(f.launched.length, 1, "Unreal may still manage, so it opens");
    const waited = opened.at - START;
    assert.ok(waited >= 45 * SECOND && waited <= 46 * SECOND, `waited ${waited} ms`);
    f.live.running = true;
    const starting = await f.act("status", { project: f.drift });
    assert.deepEqual([starting.next, starting.busyPort], ["starting", port]);
    f.tick(2 * MINUTE);
    f.live.log = ownLog(2 * MINUTE, { loaded: true, openedAt: opened.at + SECOND });
    const silent = await f.act("status", { project: f.drift });
    assert.deepEqual([silent.next, silent.busyPort], ["not-answering", port]);
    f.live.answering = true;
    assert.equal((await f.act("status", { project: f.drift })).busyPort, null, "it answered after all");
  });

  it("an editor that already answers or is still starting is not waited for", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.ports.checked.length = 0;
    f.ports.heldUntil = Number.POSITIVE_INFINITY;
    f.live.running = true;
    assert.equal((await f.act("open-editor", { project: f.drift })).launched, false);
    f.live.answering = true;
    assert.equal((await f.act("open-editor", { project: f.drift })).launched, false);
    assert.deepEqual(f.ports.checked, []);
  });

  it("a project with no port of Genex's (not set up) opens at once, asking no port", async () => {
    const f = await launchFixture();
    f.ports.heldUntil = Number.POSITIVE_INFINITY;
    const opened = await f.act("open-editor", { project: f.drift });
    assert.deepEqual([opened.launched, opened.at], [true, START]);
    assert.deepEqual(f.ports.checked, []);
  });

  it("a launch that fails after the wait leaves no Starting behind", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    const witness = await tree(f.storage);
    f.ports.heldUntil = Number.POSITIVE_INFINITY;
    f.live.failOpen = true;
    await assert.rejects(f.act("open-editor", { project: f.drift }), /-10810/);
    assert.deepEqual(await tree(f.storage), witness);
  });
});

describe("Unreal couldn't open Genex's connection", () => {
  it("the project's own log says its port couldn't be bound: the panel says so and offers Quit, never Starting", async () => {
    const f = await launchFixture();
    const { port } = await f.act("setup", { project: f.drift });
    await f.act("open-editor", { project: f.drift });
    f.tick(30 * SECOND);
    f.live.running = true;
    f.live.log = ownLog(25 * SECOND, { openedAt: START + 5 * SECOND, portBlocked: true });
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.connection, status.opening], ["port-blocked", "not-open", null]);
    assert.deepEqual(await f.toolbar(), {
      badge: "Not open",
      tone: "info",
      dot: true,
      title: "Unreal couldn't use the port Genex gave Drift. Quit Unreal and open it again from the Unreal button.",
    });
    assert.deepEqual(new Set(f.logPorts), new Set([port]), "the log is read for the project's own port");
  });

  it("a log that doesn't say so leaves the step as it was", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.log = ownLog(30 * MINUTE, { loaded: true, portBlocked: false });
    assert.equal((await f.act("status", { project: f.drift })).next, "not-answering");
    f.live.log = ownLog(30 * MINUTE, { open: false, portBlocked: true });
    assert.equal(
      (await f.act("status", { project: f.drift })).next,
      "open-when-free",
      "a closed log is not this run: Unreal has another project open",
    );
  });

  it("with two editors open the panel says so and offers no Quit to guess with", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    f.live.running = true;
    f.live.editors = 2;
    f.live.log = ownLog(MINUTE, { loaded: true, portBlocked: true });
    const status = await f.act("status", { project: f.drift });
    assert.deepEqual([status.next, status.editor.editors], ["port-blocked", 2]);
  });
});

describe("Waiting for a game's editor to answer", () => {
  const drift = { project: "/Games/Drift/Drift.uproject", name: "Drift", port: 18118 };
  const log = (change: Partial<EditorLog>): EditorLog => ({
    open: true,
    openedAt: START,
    mtime: START,
    mcpStarted: true,
    loaded: true,
    portBlocked: false,
    ...change,
  });
  /** A computer whose editor answers as told and whose log for Drift says what the row gives. */
  const computerWith = (answering: boolean, editorLog: EditorLog | undefined) => {
    const { env } = fakeComputer("/Users/ann", "darwin");
    const read: Array<{ file: string; port?: number }> = [];
    return {
      read,
      env: {
        ...env,
        editorAnswers: async () => answering,
        editorLog: async (project: { file: string; directory: string; port?: number }) => {
          read.push({ file: project.file, port: project.port });
          return editorLog;
        },
      },
    };
  };

  it("answers yes once it answers, without reading its log", async () => {
    const c = computerWith(true, log({ portBlocked: true }));
    assert.equal(await answersOrBlocked(c.env, drift), true);
    assert.deepEqual(c.read, []);
  });

  for (const [name, editorLog] of [
    ["no log", undefined],
    ["a log that bound its port", log({})],
    ["a closed log that couldn't", log({ open: false, portBlocked: true })],
  ] as const)
    it(`keeps waiting with ${name}`, async () => {
      const c = computerWith(false, editorLog);
      assert.equal(await answersOrBlocked(c.env, drift), false);
    });

  it("ends the wait at once when its own open log says Epic's server couldn't bind its port", async () => {
    const c = computerWith(false, log({ portBlocked: true }));
    const failure = await answersOrBlocked(c.env, drift).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof PortBlockedError);
    assert.equal(failure.port, 18118);
    assert.match(failure.message, /port 18118/);
    assert.deepEqual(c.read, [{ file: drift.project, port: 18118 }]);
  });
});

describe("The system opener", () => {
  const program = "require('node:fs').writeFileSync(process.argv.at(-1), JSON.stringify(process.argv.slice(1, -1)))";

  it("passes arguments to the program as they are, with no shell to read them", async () => {
    const root = await tmpDir("studio-unreal-opener-");
    const marker = path.join(root, "args.json");
    const pwned = path.join(root, "pwned");
    const args = [`$(touch ${pwned})`, `; touch ${pwned}`, `"quoted" 'single' \`tick\``, "--args"];
    await systemOpener({ command: process.execPath, args: ["-e", program, ...args, marker], detached: false });
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), args);
    await assert.rejects(access(pwned));
  });

  it("starts a detached program and returns without waiting for it", async () => {
    const root = await tmpDir("studio-unreal-opener-");
    const marker = path.join(root, "args.json");
    await systemOpener({ command: process.execPath, args: ["-e", program, "detached", marker], detached: true });
    for (
      let i = 0;
      i < 100 &&
      !(await access(marker).then(
        () => true,
        () => false,
      ));
      i++
    )
      await sleep(50);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), ["detached"]);
  });

  it("hides the console of a program it waits for, and never hides an app that stays", async () => {
    const seen: Array<{ how: string; options: { windowsHide?: boolean } }> = [];
    const runners = {
      execFile: async (_file: string, _args: readonly string[], options: { windowsHide?: boolean }) => {
        seen.push({ how: "execFile", options });
        return { stdout: "" };
      },
      spawn: (_file: string, _args: readonly string[], options: { windowsHide?: boolean }) => {
        seen.push({ how: "spawn", options });
        return {
          once: (event: string, listener: () => void) => (event === "spawn" ? listener() : undefined),
          unref() {},
        };
      },
    };
    await systemOpener({ command: "C:\\Windows\\System32\\taskkill.exe", args: [], detached: false }, runners);
    await systemOpener({ command: "C:\\Unreal\\UnrealEditor.exe", args: [], detached: true }, runners);
    assert.equal(seen[0]?.options.windowsHide, true, "taskkill's console never flashes");
    assert.equal(seen[1]?.options.windowsHide, undefined, "Unreal, the launcher and Explorer open their windows");
  });

  it("reports a program that can't start, attached or detached", async () => {
    const root = await tmpDir("studio-unreal-opener-");
    const missing = path.join(root, "no-such-program");
    await assert.rejects(systemOpener({ command: missing, args: [], detached: false }));
    await assert.rejects(systemOpener({ command: missing, args: [], detached: true }));
  });
});

/** The helper file the older Genex wrote differently; the user never touched it, so the update replaces it. */
const MINE_OF_TOOLS = "Plugins/GenexEditorHelper/Content/Python/genex_play/tools.py.mine";

describe("Open in Unreal brings an older Genex editor helper up to date", () => {
  /** Drift set up, then its helper made older than the one this Genex ships. */
  async function olderHelper() {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await writeFile(toolHelper(f), "# an older helper\n");
    assert.equal(await f.helperNow(), HelperState.Outdated);
    return f;
  }

  it("in a game: a game snapshot first, then the update, then Unreal opens", async () => {
    const f = await olderHelper();
    await f.linkGame("valley", f.drift);
    const opened = await f.actIn("valley", "open-editor", { project: f.drift });
    assert.deepEqual(f.events, ["snapshot", "launch"]);
    assert.deepEqual(f.snapshots, [HelperState.Outdated], "the snapshot holds the helper as it was");
    assert.equal(await f.helperNow(), HelperState.Current);
    assert.deepEqual(f.launched, [macOpen(f, f.drift)]);
    // The older file's bytes are neither the shipped ones nor what setup wrote: kept beside the new one.
    assert.deepEqual(opened.helper?.kept, [MINE_OF_TOOLS]);
    assert.equal(await readFile(path.join(path.dirname(f.drift), MINE_OF_TOOLS), "utf8"), "# an older helper\n");
  });

  it("outside a game there is no game to snapshot first: the helper stays as it was, and Unreal opens", async () => {
    const f = await olderHelper();
    const witness = await tree(path.dirname(f.drift));
    await f.act("open-editor", { project: f.drift });
    assert.deepEqual([f.snapshots, f.events], [[], ["launch"]]);
    assert.equal(await f.helperNow(), HelperState.Outdated);
    assert.deepEqual(await tree(path.dirname(f.drift)), witness, "nothing in the project changed");
  });

  it("a project that isn't the open game's own: no snapshot of that game, and the helper stays as it was", async () => {
    const f = await olderHelper();
    const other = await project(path.join(f.root, "Projects"), "Rally");
    await f.act("setup", { project: other });
    await f.linkGame("valley", other);
    const witness = await tree(path.dirname(f.drift));
    await f.actIn("valley", "open-editor", { project: f.drift });
    assert.deepEqual([f.snapshots, f.events], [[], ["launch"]], "the open game's snapshot would not hold this project");
    assert.deepEqual(await tree(path.dirname(f.drift)), witness, "nothing in the project changed");
  });

  it("a game snapshot that fails leaves the helper as it was, and Unreal still opens", async () => {
    const f = await olderHelper();
    await f.linkGame("valley", f.drift);
    f.outcome.snapshotError = new Error("Genex couldn't take a snapshot of this game.");
    const witness = await tree(path.dirname(f.drift));
    await f.actIn("valley", "open-editor", { project: f.drift });
    assert.deepEqual(f.events, ["snapshot", "launch"]);
    assert.deepEqual(await tree(path.dirname(f.drift)), witness, "nothing in the project changed");
  });

  it("never while an Unreal editor runs: no snapshot, no update", async () => {
    const f = await olderHelper();
    f.live.running = true;
    const witness = await tree(path.dirname(f.drift));
    await f.actIn("valley", "open-editor", { project: f.drift });
    assert.deepEqual([f.snapshots, f.events], [[], ["launch"]]);
    assert.deepEqual(await tree(path.dirname(f.drift)), witness);
  });

  it("never on the Loop's restart of Unreal: no snapshot, no update", async () => {
    const f = await olderHelper();
    await f.linkGame("valley", f.drift);
    // The reopened editor answers once Unreal is launched, so the restart job ends at once.
    f.outcome.onLaunch = () => {
      f.live.running = true;
      f.live.answering = true;
    };
    const witness = await tree(path.dirname(f.drift));
    assert.deepEqual(await f.toolIn("valley", "reopen-editor"), { started: true });
    let state: { reopening: { state: string; error?: string } } | undefined;
    for (let tries = 0; tries < 100; tries++) {
      state = (await f.toolIn("valley", "editor-state")) as typeof state;
      if (state?.reopening.state !== "reopening") break;
      await sleep(20);
    }
    assert.equal(state?.reopening.state, "done", state?.reopening.error);
    assert.deepEqual([f.snapshots, f.events], [[], ["launch"]]);
    assert.deepEqual(await tree(path.dirname(f.drift)), witness);
  });
});

/** Epic's toolsets for games that setup adds to a project. */
const TOOLSETS = [
  "UMGToolSet",
  "NiagaraToolsets",
  "StateTreeToolset",
  "AIModuleToolset",
  "AnimationAssistantToolset",
  "PCGToolset",
  "PhysicsToolsets",
  "GameplayTagsToolset",
  "AutomationTestToolset",
];
const pluginNames = async (file: string): Promise<string[]> =>
  JSON.parse(await readFile(file, "utf8")).Plugins.map((p: { Name: string }) => p.Name);

/** Drift's .uproject with the plugins `keep` keeps. */
async function keepPlugins(file: string, keep: (name: string) => boolean) {
  const uproject = JSON.parse(await readFile(file, "utf8"));
  uproject.Plugins = uproject.Plugins.filter((p: { Name: string }) => keep(p.Name));
  await writeFile(file, `${JSON.stringify(uproject, null, "\t")}\n`);
}

describe("Open in Unreal adds Epic's toolsets to a project set up before them", () => {
  /** Drift set up, its toolsets taken out of it and of its setup record, as a Genex from before them left it. */
  async function setUpBefore() {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await keepPlugins(f.drift, (name) => !TOOLSETS.includes(name));
    const [key] = await readdir(path.join(f.storage, SetupStorage.Folder));
    const recordFile = path.join(f.storage, SetupStorage.Folder, key, SetupStorage.Record);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    record.uproject.added = record.uproject.added.filter((name: string) => !TOOLSETS.includes(name));
    await writeFile(recordFile, JSON.stringify(record));
    return f;
  }

  it("in its game: a game snapshot first, then the toolsets, then Unreal opens; the current helper stays", async () => {
    const f = await setUpBefore();
    await f.linkGame("valley", f.drift);
    const helper = await tree(path.join(path.dirname(f.drift), "Plugins"));
    await f.actIn("valley", "open-editor", { project: f.drift });
    assert.deepEqual(f.events, ["snapshot", "launch"]);
    assert.deepEqual(f.snapshots, [HelperState.Current]);
    const names = await pluginNames(f.drift);
    assert.deepEqual(names.slice(-TOOLSETS.length), TOOLSETS);
    assert.deepEqual(await tree(path.join(path.dirname(f.drift), "Plugins")), helper, "the helper is as it was");
  });

  it("never outside its game or while an Unreal editor runs: the .uproject stays as it was", async () => {
    const f = await setUpBefore();
    const witness = await readFile(f.drift, "utf8");
    await f.act("open-editor", { project: f.drift });
    await f.linkGame("valley", f.drift);
    f.live.running = true;
    await f.actIn("valley", "open-editor", { project: f.drift });
    assert.deepEqual(f.snapshots, []);
    assert.equal(await readFile(f.drift, "utf8"), witness);
  });

  it("never one Genex added that the user took out again: no snapshot, and the .uproject stays as it was", async () => {
    const f = await launchFixture();
    await f.act("setup", { project: f.drift });
    await keepPlugins(f.drift, (name) => name !== "NiagaraToolsets");
    const witness = await readFile(f.drift, "utf8");
    await f.linkGame("valley", f.drift);
    await f.actIn("valley", "open-editor", { project: f.drift });
    assert.deepEqual([f.snapshots, f.events], [[], ["launch"]]);
    assert.equal(await readFile(f.drift, "utf8"), witness);
  });
});

/** Drift as a C++ project with the module Drift. */
async function cppDrift(f: Fixture) {
  const json = { FileVersion: 3, EngineAssociation: "5.8", Modules: [{ Name: "Drift", Type: "Runtime" }] };
  await writeFile(f.drift, `${JSON.stringify(json, null, "\t")}\n`);
}

/** `Binaries/Mac/UnrealEditor.modules` as Unreal writes it, naming Drift's library. */
const modulesText = (library: unknown) =>
  `${JSON.stringify({ BuildId: "58210709", Modules: { Drift: library } }, null, "\t")}\n`;
const HOT = modulesText("libUnrealEditor-Drift-4543.dylib");

async function writeModules(f: Fixture, text: string) {
  const mac = path.join(path.dirname(f.drift), "Binaries", "Mac");
  await mkdir(mac, { recursive: true });
  await writeFile(path.join(mac, "UnrealEditor.modules"), text);
}

const FAILED_BUILD: CompileResult = {
  ok: false,
  seconds: 12,
  errors: [{ file: "Source/Drift/Bike.cpp", line: 12, column: 3, message: "use of undeclared identifier 'Speed'" }],
  summary: "DriftEditor didn't build (OtherCompilationError): 1 error.",
  failure: "failed",
  retryable: false,
};

describe("Open in Unreal after a hot reload", () => {
  it("builds the game's module with UnrealBuildTool first, so Unreal never loads the hot-reloaded library", async () => {
    const f = await launchFixture();
    await cppDrift(f);
    await writeModules(f, HOT);
    await f.act("open-editor", { project: f.drift });
    assert.deepEqual(f.events, ["build", "launch"]);
    assert.deepEqual(f.compiles, [
      {
        engineDir: path.join(f.root, "Engines", "UE_5.8"),
        projectFile: f.drift,
        module: "Drift",
        xcodeApp: READY_XCODE.app,
      },
    ]);
  });

  it("a failed build says why with its first errors, and opens nothing", async () => {
    const f = await launchFixture();
    await cppDrift(f);
    await writeModules(f, HOT);
    f.outcome.build = FAILED_BUILD;
    await assert.rejects(f.act("open-editor", { project: f.drift }), (error: Error & { code?: string }) => {
      assert.equal(error.code, LaunchErrorCode.NotBuilt);
      assert.match(error.message, /DriftEditor didn't build/);
      assert.match(error.message, /Source\/Drift\/Bike\.cpp:12: use of undeclared identifier 'Speed'/);
      return true;
    });
    assert.deepEqual([f.launched, f.events], [[], ["build"]]);
    assert.equal(await readStarting(f.storage), undefined, "no Starting is left behind");
  });

  it("a Mac whose Xcode can't build refuses with the same reason and opens nothing", async () => {
    const f = await launchFixture();
    await cppDrift(f);
    await writeModules(f, HOT);
    f.live.xcode = { ...READY_XCODE, state: XcodeState.Missing, app: null };
    await assert.rejects(f.act("open-editor", { project: f.drift }), { code: LaunchErrorCode.NotBuilt });
    assert.deepEqual([f.launched, f.compiles], [[], []]);
  });

  const unbuilt: Array<{ name: string; platform?: NodeJS.Platform; arrange: (f: Fixture) => Promise<void> }> = [
    { name: "a cold build's library", arrange: (f) => writeModules(f, modulesText("libUnrealEditor-Drift.dylib")) },
    { name: "a C++ project never built", arrange: async () => {} },
    {
      name: "a computer that isn't a Mac, where Unreal builds its own modules",
      platform: "linux",
      arrange: (f) => writeModules(f, HOT),
    },
  ];
  for (const row of unbuilt)
    it(`opens without building: ${row.name}`, async () => {
      const f = await launchFixture({ platform: row.platform });
      await cppDrift(f);
      await row.arrange(f);
      await f.act("open-editor", { project: f.drift });
      assert.deepEqual([f.compiles, f.launched.length], [[], 1]);
    });

  it("a Blueprint project opens without building, whatever its Binaries say", async () => {
    const f = await launchFixture();
    await writeModules(f, HOT);
    await f.act("open-editor", { project: f.drift });
    assert.deepEqual([f.compiles, f.launched.length], [[], 1]);
  });
});

/** Modules files that must read as no hot library: each opens Unreal at once, building nothing. */
const hostileModules: Array<{
  name: string;
  links?: boolean;
  arrange: (f: Fixture, outside: string) => Promise<void>;
}> = [
  {
    name: "a modules file that is a link to a hot one",
    links: true,
    arrange: async (f, outside) => {
      await writeFile(path.join(outside, "UnrealEditor.modules"), HOT);
      await mkdir(path.join(path.dirname(f.drift), "Binaries", "Mac"), { recursive: true });
      await symlink(
        path.join(outside, "UnrealEditor.modules"),
        path.join(path.dirname(f.drift), "Binaries", "Mac", "UnrealEditor.modules"),
      );
    },
  },
  {
    name: "a Mac folder that is a link to one holding a hot modules file",
    links: true,
    arrange: async (f, outside) => {
      await writeFile(path.join(outside, "UnrealEditor.modules"), HOT);
      await mkdir(path.join(path.dirname(f.drift), "Binaries"), { recursive: true });
      await symlink(outside, path.join(path.dirname(f.drift), "Binaries", "Mac"));
    },
  },
  {
    name: "a Binaries folder that is a link",
    links: true,
    arrange: async (f, outside) => {
      await mkdir(path.join(outside, "Mac"), { recursive: true });
      await writeFile(path.join(outside, "Mac", "UnrealEditor.modules"), HOT);
      await symlink(outside, path.join(path.dirname(f.drift), "Binaries"));
    },
  },
  {
    name: "an oversized modules file",
    arrange: (f) => writeModules(f, `${HOT.slice(0, -2)},\n\t"Padding": "${"x".repeat(2 * 1024 * 1024)}"\n}\n`),
  },
  { name: "a modules file that isn't JSON", arrange: (f) => writeModules(f, `${HOT.slice(0, -3)}`) },
  { name: "a JSON list", arrange: (f) => writeModules(f, JSON.stringify(["libUnrealEditor-Drift-4543.dylib"])) },
  {
    name: "Modules as a list",
    arrange: (f) => writeModules(f, JSON.stringify({ Modules: ["Drift", "libUnrealEditor-Drift-4543.dylib"] })),
  },
  { name: "a library that isn't a string", arrange: (f) => writeModules(f, modulesText(4543)) },
  {
    name: "a library with folders in its name",
    arrange: (f) => writeModules(f, modulesText("../../libUnrealEditor-Drift-4543.dylib")),
  },
  {
    name: "a library name with more after .dylib",
    arrange: (f) => writeModules(f, modulesText("libUnrealEditor-Drift-4543.dylib.old")),
  },
  {
    name: "a folder named like the modules file",
    arrange: async (f) => {
      await mkdir(path.join(path.dirname(f.drift), "Binaries", "Mac", "UnrealEditor.modules"), { recursive: true });
    },
  },
];

describe("A hot-reloaded library is never trusted from", () => {
  for (const row of hostileModules)
    it(row.name, { skip: row.links === true && LINKS }, async () => {
      const f = await launchFixture();
      await cppDrift(f);
      const outside = path.join(f.root, "outside");
      await mkdir(outside, { recursive: true });
      await row.arrange(f, outside);
      const witness = [await tree(path.dirname(f.drift)), await tree(outside)];
      assert.equal(await hotLibraryLoaded(f.drift, "Drift"), false);
      await f.act("open-editor", { project: f.drift });
      assert.deepEqual([f.compiles, f.launched.length], [[], 1], "nothing was built, and Unreal opened");
      assert.deepEqual([await tree(path.dirname(f.drift)), await tree(outside)], witness);
    });
});
