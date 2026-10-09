/**
 * Reopening Unreal after it crashed: the editor died testing a C++ part, its crash reporter stayed
 * open, and the hot reload had pointed `UnrealEditor.modules` at a library holding the crashing
 * class. The runner's `reopen-editor` ends what is left of this project's editor (the normal quit
 * when it is the only editor, then a terminate, then a kill) and its crash reporter, never another
 * project's process; builds the game's module with UnrealBuildTool; opens the project and waits
 * until it answers. `editor-state` says whether Unreal answers, whether this project's editor
 * process runs (a busy editor that doesn't answer is not a crashed one) and how reopening goes. The
 * computer's processes, UBT, Unreal and time are stand-ins; the crash folders and their logs are
 * real files.
 */
import assert from "node:assert/strict";
import { cp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext, PluginHookContext } from "../../src/plugin-sdk/index.d.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { rememberAnswers } from "../../src/plugins/unreal/editor-port.ts";
import { ReopenState } from "../../src/plugins/unreal/editor-reopen.ts";
import { EditorHealth, type HealthRead, healthAnswer } from "../../src/plugins/unreal/hook-answers.ts";
import { createLoopTools, LiveLoopToolName, LoopToolName } from "../../src/plugins/unreal/loop-tools.ts";
import { HelperState, type SetupEnv } from "../../src/plugins/unreal/setup.ts";
import { CompileFailure, type CompileOptions, type CompileResult } from "../../src/plugins/unreal/ubt.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CrashLog, crashLog } from "../helpers/unreal-editor-stand-in.ts";

const NAME = "TowerClimb";
const XCODE_APP = "/Applications/Xcode-26.2.app";
const ENGINE_BINARIES = "/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac";
const EDITOR_EXEC = `${ENGINE_BINARIES}/UnrealEditor.app/Contents/MacOS/UnrealEditor`;
const REPORTER_EXEC = `${ENGINE_BINARIES}/CrashReportClientEditor.app/Contents/MacOS/CrashReportClientEditor`;
const OUR_CRASH = `CrashReport-UE-${NAME}-pid-7821-BDDEA226714BE9478866A78C62169369`;
const OTHER_CRASH = "CrashReport-UE-OtherGame-pid-55271-687DAAC28E4F4AF0172ECCA076672964";
const BUILT: CompileResult = { ok: true, seconds: 41, errors: [], summary: "built", retryable: false };
const BROKEN: CompileResult = {
  ok: false,
  seconds: 9,
  errors: [
    {
      file: "Source/TowerClimb/Parts/Bike/BikeGameMode.cpp",
      line: 42,
      column: 5,
      message: "use of undeclared identifier 'Bike'",
    },
  ],
  summary: "TowerClimbEditor didn't build (OtherCompilationError): 1 error.",
  failure: CompileFailure.Failed,
  retryable: false,
};
/** The game's port, as the setup's answer memory keys it. */
const PORT = 32_101;
/** How long the stand-in Unreal takes to answer once opened, and the most reopen-editor waits for it. */
const OPEN_TAKES_MS = 70_000;
const OPEN_LIMIT_MS = 300_000;
const NEVER = Number.POSITIVE_INFINITY;

/** One process as the job lists it: its id, its executable, and its arguments with the executable first. */
type Row = { pid: number; exec: string; args: string };
/** How a stand-in process takes the quit and each signal: it ends, or it ignores it. */
type Stubborn = { quit?: boolean; SIGTERM?: boolean; SIGKILL?: boolean };

type Options = {
  /** The game's C++ module, or none (a Blueprint project). */
  module?: boolean;
  /** Whether this game's Unreal answers when the job is asked for. */
  answering?: boolean;
  openTakes?: number;
  compile?: (options: CompileOptions) => CompileResult;
  xcode?: XcodeState;
  unlinked?: boolean;
  /** Processes the stand-in computer runs, besides the ones a test adds. */
  rows?: (w: Paths) => Row[];
  stubborn?: Record<number, Stubborn>;
  /** Whether Unreal's answers go through the setup's memory of the last good answer, as in the app. */
  remembered?: boolean;
  /** The computer the tools run on: a Mac lists its processes, elsewhere only the editors are counted. */
  platform?: NodeJS.Platform;
  /** Whether the project holds an older Genex editor helper than the plugin ships. */
  outdatedHelper?: boolean;
};

type Paths = { home: string; project: string; crashes: string; ours: string; other: string; elsewhere: string };

/** The engine's own crash folder under the user's home. */
const crashFolder = (home: string) =>
  path.join(home, "Library", "Application Support", "Epic", "UnrealEngine", "5.8", "Saved", "Crashes");

/** A crash folder Unreal wrote: its copy of the editor's log, naming the project it had open. */
async function crashReport(folder: string, name: string, project: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${name}.log`), await crashLog(CrashLog.Open, project));
  await writeFile(path.join(folder, "CrashContext.runtime-xml"), "<FGenericCrashContext/>");
}

/** A crashed game's world: its project and crash reports, a stand-in computer, Unreal and UBT, through the Loop's tools. */
/** The crashed game's files: its project (with its module unless `module` is false), its crash report and another project's. */
async function reopenFiles(module: boolean) {
  const root = await realpath(await tmpDir("studio-unreal-reopen-"));
  const home = path.join(root, "home");
  const unreal = path.join(root, "AI Games", "tower-climb", "unreal");
  const project = path.join(unreal, `${NAME}.uproject`);
  const storage = path.join(root, "storage");
  const crashes = crashFolder(home);
  const paths: Paths = {
    home,
    project,
    crashes,
    ours: path.join(crashes, OUR_CRASH),
    other: path.join(crashes, OTHER_CRASH),
    elsewhere: path.join(root, "Elsewhere", `${NAME}.uproject`),
  };
  await mkdir(unreal, { recursive: true });
  await mkdir(storage, { recursive: true });
  const modules = module ? { Modules: [{ Name: NAME, Type: "Runtime" }] } : {};
  await writeFile(project, JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8", ...modules }));
  await crashReport(paths.ours, NAME, project);
  await crashReport(paths.other, "OtherGame", "/Users/owner/Documents/Unreal Projects/OtherGame/OtherGame.uproject");
  return { root, unreal, storage, paths };
}

/** `editor-state`'s answer, as the tests read it. */
type EditorState = {
  answering: boolean;
  running: boolean | null;
  reopening: { state: string; error?: string; seconds?: number };
  helper: string | null;
};

async function reopenWorld(options: Options = {}) {
  const { root, unreal, storage, paths } = await reopenFiles(options.module !== false);
  const { home, project } = paths;
  const events: string[] = [];
  const signals: Array<[number, string]> = [];
  const clock = { at: 0 };
  const state = { answering: options.answering ?? false, openAt: undefined as number | undefined };
  const openTakes = options.openTakes ?? OPEN_TAKES_MS;
  const rows: Row[] = [{ pid: 7900, exec: REPORTER_EXEC, args: `${REPORTER_EXEC} "${paths.ours}/" -Unattended` }];
  rows.push(...(options.rows?.(paths) ?? []));
  const stubborn = options.stubborn ?? {};
  const isEditor = (row: Row) => path.basename(row.exec) === "UnrealEditor";
  const settle = () => {
    if (state.openAt === undefined || clock.at < state.openAt + openTakes) return;
    state.answering = true;
    state.openAt = undefined;
  };
  const end = (pid: number, how: keyof Stubborn) => {
    if (stubborn[pid]?.[how]) return;
    const at = rows.findIndex((row) => row.pid === pid);
    const ended = at >= 0 ? rows.splice(at, 1) : [];
    // An editor that ends stops answering.
    if (ended.some(isEditor)) state.answering = false;
  };
  const asked = async () => {
    settle();
    return state.answering;
  };
  const remembered = rememberAnswers(asked, () => clock.at);
  const helper = options.outdatedHelper ? await helperUpdates(root, paths, events, rows) : {};

  const tools = createLoopTools({
    ...helper,
    platform: options.platform ?? "darwin",
    engine: async () => ({ version: "5.8", directory: path.join(root, "engine") }),
    project: async () => (options.unlinked ? undefined : project),
    xcode: async () => ({ state: options.xcode ?? XcodeState.Ready, app: XCODE_APP }),
    compile: async (compile) => {
      events.push("compile");
      assert.equal(compile.projectFile, project);
      assert.equal(compile.module, NAME);
      assert.equal(compile.xcodeApp, XCODE_APP);
      assert.ok(!rows.some((row) => row.pid === 7900), "UBT builds after the crash reporter ended");
      return options.compile ? options.compile(compile) : BUILT;
    },
    editorCall: async (_storage, _game, tool) => {
      throw new Error(`no stand-in for ${tool}`);
    },
    editorAnswers: () => (options.remembered ? remembered(PORT, project) : asked()),
    restart: {
      editors: async () => rows.filter(isEditor).length,
      quit: async (_storage, file) => {
        events.push(`quit ${path.basename(file)}`);
        for (const row of rows.filter(isEditor)) end(row.pid, "quit");
      },
      forget: async (_storage, file) => {
        events.push(`forget ${path.basename(file)}`);
      },
      open: async (_storage, file) => {
        events.push(`open ${path.basename(file)}`);
        rows.push({ pid: 9100, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${file}` });
        state.openAt = clock.at;
      },
    },
    processes: {
      home,
      list: async () => rows.map((row) => ({ ...row })),
      signal: (pid, signal) => {
        if (!rows.some((row) => row.pid === pid)) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        signals.push([pid, signal]);
        end(pid, signal as keyof Stubborn);
      },
    },
    now: () => clock.at,
    sleep: async (ms) => {
      clock.at += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const context: PluginContext = {
    project: "tower-climb",
    directory: path.dirname(unreal),
    signal: new AbortController().signal,
    callId: 1,
    host: (async () => storage) as never,
  };
  const editorState = async () => (await tools.call(LoopToolName.EditorState, {}, context, storage)) as EditorState;
  const reopen = () => tools.call(LoopToolName.ReopenEditor, {}, context, storage);
  const endEditor = () => tools.call(LiveLoopToolName.EndEditor, {}, context, storage);
  /** The job's end, once it no longer reopens. */
  const reopened = async () => {
    for (let i = 0; i < 20_000; i++) {
      const now = await editorState();
      if (now.reopening.state !== ReopenState.Reopening) return now;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("never settled");
  };
  /** A tool called at one of Genex's moments. */
  const atMoment = (name: string, hook: PluginHookContext) =>
    tools.call(name as LoopToolName, {}, { ...context, hook }, storage);
  return { paths, rows, events, signals, clock, state, reopen, reopened, editorState, endEditor, atMoment };
}

/** A setup env for the project's helper: this stand-in computer, where nothing else runs. */
function setupEnv(home: string): SetupEnv {
  return {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => false,
    portListening: async () => false,
    editorAnswers: async () => false,
    xcode: async () => ({ state: XcodeState.Ready }) as never,
    freeBytes: async () => 0,
    totalMemory: () => 0,
  };
}

/**
 * The tools' setup with the plugin's shipped helper, and an older copy of it in the project, and a
 * stand-in update that records itself and finds no editor of the project running.
 */
async function helperUpdates(root: string, paths: Paths, events: string[], rows: Row[]) {
  const shipped = await olderHelper(root, paths.project);
  return {
    setup: (folder: string) => ({ env: setupEnv(paths.home), helper: shipped, storage: folder }),
    updateHelper: async () => {
      events.push("update-helper");
      const running = rows.some(
        (row) => path.basename(row.exec) === "UnrealEditor" && row.args.includes(paths.project),
      );
      assert.ok(!running, "Unreal is closed");
      return { from: "0.4.0", to: "0.5.0", kept: [] };
    },
  };
}

/** The plugin's shipped helper, and an older copy of it in the project; the shipped folder. */
async function olderHelper(root: string, project: string): Promise<string> {
  const shipped = path.join(root, "shipped", "GenexEditorHelper");
  await mkdir(path.join(shipped, "Content", "Python"), { recursive: true });
  await writeFile(
    path.join(shipped, "GenexEditorHelper.uplugin"),
    JSON.stringify({ Version: 5, VersionName: "0.5.0" }),
  );
  await writeFile(path.join(shipped, "Content", "Python", "tools.py"), "# tools\n");
  const own = path.join(path.dirname(project), "Plugins", "GenexEditorHelper");
  await cp(shipped, own, { recursive: true });
  await writeFile(path.join(own, "GenexEditorHelper.uplugin"), JSON.stringify({ Version: 4, VersionName: "0.4.0" }));
  return shipped;
}

describe("reopen-editor", () => {
  it("answers that Unreal answers, and touches nothing, when it already does", async () => {
    const w = await reopenWorld({ answering: true });
    assert.deepEqual(await w.reopen(), { answering: true });
    assert.deepEqual(w.events, []);
    assert.deepEqual(w.signals, []);
    assert.deepEqual(await w.editorState(), {
      answering: true,
      running: false,
      reopening: { state: ReopenState.Idle },
      helper: HelperState.Missing,
    });
  });

  it("ends this project's crash reporter, builds the game's module, opens the project and waits until it answers", async () => {
    const w = await reopenWorld({
      rows: (p) => [
        { pid: 5001, exec: REPORTER_EXEC, args: `${REPORTER_EXEC} "${p.other}/" -Unattended` },
        {
          pid: 5002,
          exec: EDITOR_EXEC,
          args: `${EDITOR_EXEC} /Users/owner/Documents/Unreal Projects/OtherGame/OtherGame.uproject`,
        },
      ],
    });
    assert.deepEqual(await w.reopen(), { started: true });
    assert.deepEqual(await w.editorState(), {
      answering: false,
      running: false,
      reopening: { state: ReopenState.Reopening },
      helper: HelperState.Missing,
    });
    const end = await w.reopened();
    assert.equal(end.reopening.state, ReopenState.Done, end.reopening.error);
    assert.equal(end.answering, true);
    assert.equal(end.reopening.seconds, Math.round(w.clock.at / 1000));
    assert.deepEqual(w.signals, [[7900, "SIGTERM"]], "only this project's crash reporter");
    assert.deepEqual(
      w.events,
      ["compile", `forget ${NAME}.uproject`, `open ${NAME}.uproject`],
      "built before it opens, Genex's stale opening record dropped; no quit: no editor of its own ran",
    );
    assert.deepEqual(
      w.rows.map((row) => row.pid).sort(),
      [5001, 5002, 9100],
      "the other project's reporter and editor are left as they were",
    );
    assert.ok(w.clock.at >= OPEN_TAKES_MS, "it waited for the project to answer");
  });

  it("asks a hung editor of this project to quit when it is the only editor, then terminates and kills it", async () => {
    const w = await reopenWorld({
      rows: (p) => [{ pid: 8000, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` }],
      stubborn: { 8000: { quit: true, SIGTERM: true } },
    });
    await w.reopen();
    const end = await w.reopened();
    assert.equal(end.reopening.state, ReopenState.Done, end.reopening.error);
    assert.deepEqual(w.events, [
      `quit ${NAME}.uproject`,
      "compile",
      `forget ${NAME}.uproject`,
      `open ${NAME}.uproject`,
    ]);
    assert.deepEqual(
      w.signals.filter(([pid]) => pid === 8000),
      [
        [8000, "SIGTERM"],
        [8000, "SIGKILL"],
      ],
    );
  });

  it("never sends the normal quit while another project's editor runs: it would reach that one", async () => {
    const w = await reopenWorld({
      rows: (p) => [
        { pid: 8000, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` },
        {
          pid: 5002,
          exec: EDITOR_EXEC,
          args: `${EDITOR_EXEC} /Users/owner/Documents/Unreal Projects/OtherGame/OtherGame.uproject`,
        },
      ],
    });
    await w.reopen();
    assert.equal((await w.reopened()).reopening.state, ReopenState.Done);
    assert.ok(!w.events.some((event) => event.startsWith("quit")), w.events.join(", "));
    assert.deepEqual(w.signals.map(([pid]) => pid).sort(), [7900, 8000]);
    assert.ok(
      w.rows.some((row) => row.pid === 5002),
      "the other project's editor still runs",
    );
  });
});

describe("reopen-editor ends only this project's processes", () => {
  /** Processes that only look like this project's: each is left running. */
  const hostile: Array<[string, (p: Paths) => Promise<Row>]> = [
    ["another project's crash reporter", async (p) => reporter(`"${p.other}/"`)],
    [
      "a crash folder of this project's name whose log names a project elsewhere",
      async (p) => {
        const folder = path.join(p.crashes, `CrashReport-UE-${NAME}-pid-1234-0123456789ABCDEF`);
        await crashReport(folder, NAME, p.elsewhere);
        return reporter(`"${folder}/"`);
      },
    ],
    [
      "a crash folder outside Unreal's crash folders",
      async (p) => {
        const folder = path.join(p.home, "Downloads", OUR_CRASH);
        await crashReport(folder, NAME, p.project);
        return reporter(`"${folder}/"`);
      },
    ],
    [
      "a crash folder that is a link to this project's",
      async (p) => {
        const folder = path.join(p.crashes, `CrashReport-UE-${NAME}-pid-4321-FEDCBA9876543210`);
        await symlink(p.ours, folder);
        return reporter(`"${folder}/"`);
      },
    ],
    ["a path that runs on past this project's crash folder", async (p) => reporter(`${p.ours}/../${OTHER_CRASH}/`)],
    ["a name that runs on past this project's crash folder", async (p) => reporter(`${p.ours}-old/`)],
    [
      "a program that isn't the crash reporter, naming this project's crash folder",
      async (p) => ({ pid: 6000, exec: "/usr/bin/less", args: `/usr/bin/less ${p.ours}/${NAME}.log` }),
    ],
    [
      "an editor of a project of the same name elsewhere",
      async (p) => ({ pid: 6000, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.elsewhere}` }),
    ],
    [
      "an editor whose argument only begins with this project's file",
      async (p) => ({ pid: 6000, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}.bak` }),
    ],
    [
      "a program that isn't Unreal, naming this project's file",
      async (p) => ({ pid: 6000, exec: "/usr/bin/vim", args: `/usr/bin/vim ${p.project}` }),
    ],
    [
      "a shell whose arguments name Unreal and this project",
      async (p) => ({ pid: 6000, exec: "/bin/zsh", args: `/bin/zsh -c ${EDITOR_EXEC} ${p.project}` }),
    ],
  ];
  for (const [label, make] of hostile) {
    it(`leaves ${label} running`, { skip: process.platform === "win32" && "links need privileges" }, async () => {
      const w = await reopenWorld();
      const made = await make(w.paths);
      w.rows.push(made);
      await w.reopen();
      assert.equal((await w.reopened()).reopening.state, ReopenState.Done);
      assert.deepEqual(w.signals, [[7900, "SIGTERM"]], "only this project's own crash reporter");
      assert.ok(w.rows.includes(made), "still running");
    });
  }
});

describe("reopen-editor's build and wait", () => {
  it("fails with UnrealBuildTool's errors when the module doesn't build, and leaves Unreal closed", async () => {
    const w = await reopenWorld({ compile: () => BROKEN });
    await w.reopen();
    const end = await w.reopened();
    assert.equal(end.reopening.state, ReopenState.Failed);
    assert.match(end.reopening.error ?? "", /didn't build/);
    assert.ok(
      end.reopening.error?.includes(
        "Source/TowerClimb/Parts/Bike/BikeGameMode.cpp:42: use of undeclared identifier 'Bike'",
      ),
      end.reopening.error,
    );
    assert.deepEqual(w.events, ["compile"], "an editor would only ask to rebuild the modules");
  });

  it("opens a Blueprint project without building anything", async () => {
    const w = await reopenWorld({ module: false });
    await w.reopen();
    assert.equal((await w.reopened()).reopening.state, ReopenState.Done);
    assert.deepEqual(w.events, [`forget ${NAME}.uproject`, `open ${NAME}.uproject`]);
  });

  it("fails without building or opening when this Mac can't build the game's C++", async () => {
    const w = await reopenWorld({ xcode: XcodeState.FirstLaunch });
    await w.reopen();
    const end = await w.reopened();
    assert.equal(end.reopening.state, ReopenState.Failed);
    assert.match(end.reopening.error ?? "", /Xcode/);
    assert.deepEqual(w.events, []);
  });

  it("fails when Unreal doesn't answer within 5 minutes of opening", async () => {
    const w = await reopenWorld({ openTakes: NEVER });
    await w.reopen();
    const end = await w.reopened();
    assert.equal(end.reopening.state, ReopenState.Failed);
    assert.match(end.reopening.error ?? "", /answer/);
    assert.ok(w.clock.at >= OPEN_LIMIT_MS && w.clock.at < OPEN_LIMIT_MS + 60_000, `waited ${w.clock.at} ms`);
  });

  it("fails, building and opening nothing, when this project's processes outlive even a kill", async () => {
    const w = await reopenWorld({ stubborn: { 7900: { SIGTERM: true, SIGKILL: true } } });
    await w.reopen();
    const end = await w.reopened();
    assert.equal(end.reopening.state, ReopenState.Failed);
    assert.match(end.reopening.error ?? "", /didn't end/);
    assert.deepEqual(w.events, []);
  });

  it("runs one job at a time, and can be asked again once it ended", async () => {
    const w = await reopenWorld({ compile: () => BROKEN });
    assert.deepEqual(await w.reopen(), { started: true });
    assert.deepEqual(await w.reopen(), { started: true });
    assert.equal((await w.reopened()).reopening.state, ReopenState.Failed);
    assert.deepEqual(w.events, ["compile"]);
    assert.deepEqual(await w.reopen(), { started: true });
    assert.equal((await w.reopened()).reopening.state, ReopenState.Failed);
    assert.deepEqual(w.events, ["compile", "compile"]);
  });

  it("refuses a game without a linked project; editor-state says it doesn't answer", async () => {
    const w = await reopenWorld({ unlinked: true });
    await assert.rejects(w.reopen(), /isn't linked to an Unreal project/);
    assert.deepEqual(await w.editorState(), {
      answering: false,
      running: null,
      reopening: { state: ReopenState.Idle },
      helper: null,
    });
    assert.deepEqual(w.signals, []);
  });
});

describe("editor-state says whether this project's editor process runs", () => {
  it("reads a busy editor that doesn't answer as running, and a crashed one as not", async () => {
    const busy = await reopenWorld({
      rows: (p) => [{ pid: 8000, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` }],
    });
    assert.deepEqual([(await busy.editorState()).answering, (await busy.editorState()).running], [false, true]);
    const crashed = await reopenWorld({
      rows: () => [
        {
          pid: 5002,
          exec: EDITOR_EXEC,
          args: `${EDITOR_EXEC} /Users/owner/Documents/Unreal Projects/Other/Other.uproject`,
        },
      ],
    });
    assert.equal((await crashed.editorState()).running, false, "another project's editor is not this one");
  });

  it("can't say when the processes can't be listed, or off a Mac while any editor runs", async () => {
    const unlisted = await reopenWorld();
    unlisted.rows.splice(0, unlisted.rows.length);
    assert.equal((await unlisted.editorState()).running, null, "a listing with no process at all failed");
    const elsewhere = await reopenWorld({
      platform: "win32",
      rows: (p) => [{ pid: 8000, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` }],
    });
    assert.equal((await elsewhere.editorState()).running, null);
    const none = await reopenWorld({ platform: "win32" });
    assert.equal((await none.editorState()).running, false, "no editor at all runs");
  });
});

describe("end-editor (the live builder's cold restore)", () => {
  it("ends this project's editor, by the normal quit when it is the only one, and its crash reporter; nothing more", async () => {
    const w = await reopenWorld({
      answering: true,
      rows: (p) => [{ pid: 8000, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` }],
    });
    assert.deepEqual(await w.endEditor(), { ended: 2 });
    assert.deepEqual(w.events, [`quit ${NAME}.uproject`], "never built, never opened");
    assert.deepEqual(w.signals, [[7900, "SIGTERM"]], "the reporter outlived the quit");
    assert.deepEqual(w.rows, []);
  });

  it("answers that it ended nothing when nothing of this project's runs", async () => {
    const w = await reopenWorld({
      rows: () => [
        {
          pid: 5002,
          exec: EDITOR_EXEC,
          args: `${EDITOR_EXEC} /Users/owner/Documents/Unreal Projects/OtherGame/OtherGame.uproject`,
        },
      ],
    });
    w.rows.splice(
      w.rows.findIndex((row) => row.pid === 7900),
      1,
    );
    assert.deepEqual(await w.endEditor(), { ended: 0 });
    assert.deepEqual(w.signals, []);
    assert.deepEqual(w.events, []);
    assert.deepEqual(
      w.rows.map((row) => row.pid),
      [5002],
      "another project's editor runs on",
    );
  });

  it("throws when this project's processes outlive even a kill", async () => {
    const w = await reopenWorld({ stubborn: { 7900: { SIGTERM: true, SIGKILL: true } } });
    await assert.rejects(w.endEditor(), /didn't end/);
    assert.deepEqual(w.events, []);
  });

  it("answers only once the editor no longer answers: a reopen right after it starts a job, though Unreal answered moments before", async () => {
    const w = await reopenWorld({
      answering: true,
      remembered: true,
      rows: (p) => [{ pid: 8000, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` }],
    });
    // No crash reporter: the quit ends everything at once, well inside the answer's memory.
    w.rows.splice(
      w.rows.findIndex((row) => row.pid === 7900),
      1,
    );
    assert.equal((await w.editorState()).answering, true, "Unreal answers, and the answer is remembered");
    assert.deepEqual(await w.endEditor(), { ended: 1 });
    assert.deepEqual(await w.reopen(), { started: true }, "the remembered answer is never taken for an open editor");
    assert.equal((await w.reopened()).reopening.state, ReopenState.Done);
    assert.ok(w.events.includes(`open ${NAME}.uproject`), "Unreal was opened again");
  });

  it("throws when the game's Unreal still answers after it ended everything of the project's it could see", async () => {
    const w = await reopenWorld({ answering: true });
    await assert.rejects(w.endEditor(), /didn't end/);
  });

  it("refuses while a reopen job runs for the game, ending nothing", async () => {
    const w = await reopenWorld({ openTakes: NEVER });
    await w.reopen();
    const signalled = w.signals.length;
    await assert.rejects(w.endEditor(), /reopening/);
    assert.equal(w.signals.length, signalled);
  });

  it("refuses a game without a linked project", async () => {
    const w = await reopenWorld({ unlinked: true });
    await assert.rejects(w.endEditor(), /isn't linked to an Unreal project/);
    assert.deepEqual(w.signals, []);
  });
});

/** Unreal's crash reporter with `argument` after its executable. */
function reporter(argument: string): Row {
  return { pid: 6000, exec: REPORTER_EXEC, args: `${REPORTER_EXEC} ${argument} -Unattended` };
}

describe("at Genex's moments", () => {
  const health: PluginHookContext = { on: HookEvent.Health, runId: "run-7" };
  type Answer = { block?: string; pending?: string; note?: string };

  it("editor-state at health is pending while Unreal reopens or is busy, blocks once it is gone three times in a row, and is silent when it answers", async () => {
    const open = await reopenWorld({ answering: true });
    assert.deepEqual(await open.atMoment(LoopToolName.EditorState, health), {});

    const reopening = await reopenWorld({ openTakes: NEVER });
    await reopening.reopen();
    const waiting = (await reopening.atMoment(LoopToolName.EditorState, health)) as Answer;
    assert.match(waiting.pending ?? "", /reopening Unreal/);

    const busy = await reopenWorld({
      rows: (p) => [{ pid: 9200, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` }],
    });
    const working = (await busy.atMoment(LoopToolName.EditorState, health)) as Answer;
    assert.match(working.pending ?? "", /busy/);
    assert.equal(working.block, undefined, "a busy editor is no crash");

    const gone = await reopenWorld();
    const crashed = (await gone.atMoment(LoopToolName.EditorState, health)) as Answer;
    assert.match(crashed.block ?? "", /Unreal isn't running/);
    assert.ok(gone.clock.at >= 10_000, "asked three times, five seconds apart");
    assert.deepEqual(gone.events, [], "health only reads");

    const failed = await reopenWorld({ compile: () => BROKEN });
    await failed.reopen();
    await failed.reopened();
    const lost = (await failed.atMoment(LoopToolName.EditorState, health)) as Answer;
    assert.match(lost.block ?? "", /reopening Unreal failed: .*didn't build/);
  });

  it("editor-state's answer at health, in a run and in a chat: pending while Unreal may yet answer, blocked once it can't", () => {
    const chat: PluginHookContext = { on: HookEvent.Health };
    type Row = [string, HealthRead, PluginHookContext, keyof Answer, RegExp];
    const rows: Row[] = [
      ["opening, in a run", { health: EditorHealth.Starting, project: "Tower" }, health, "pending", /opening Tower/],
      ["opening, in a chat", { health: EditorHealth.Starting, project: "Tower" }, chat, "pending", /opening Tower/],
      [
        "its port blocked",
        { health: EditorHealth.PortBlocked, project: "Tower", error: "Port 8000 is taken by another app." },
        chat,
        "block",
        /Port 8000 is taken/,
      ],
      ["its port blocked, no reason", { health: EditorHealth.PortBlocked, project: "Tower" }, health, "block", /Tower/],
      ["no linked project, in a run", { health: EditorHealth.NoProject }, health, "block", /isn't linked/],
      [
        "no linked project, in a chat",
        { health: EditorHealth.NoProject },
        chat,
        "block",
        /Open it from the Unreal button/,
      ],
      [
        "processes that can't be listed",
        { health: EditorHealth.Unknown, project: "Tower" },
        health,
        "pending",
        /can't tell/,
      ],
      ["gone, in a run", { health: EditorHealth.Gone, project: "Tower" }, health, "block", /isn't running/],
      [
        "gone, in a chat",
        { health: EditorHealth.Gone, project: "Tower" },
        chat,
        "block",
        /didn't finish opening Tower/,
      ],
    ];
    for (const [name, read, hook, field, words] of rows) {
      const answer = healthAnswer(read, hook) as Answer;
      assert.deepEqual(Object.keys(answer), [field], name);
      assert.match(String(answer[field]), words, name);
    }
  });

  it("end-editor before a restore blocks when Unreal still answers after it ended everything", async () => {
    const w = await reopenWorld({ answering: true });
    const answer = (await w.atMoment(LiveLoopToolName.EndEditor, {
      on: HookEvent.RestoreBefore,
      runId: "run-7",
    })) as Answer;
    assert.match(answer.block ?? "", /Unreal couldn't be closed for the restore \(.*didn't end/);

    const closes = await reopenWorld({
      rows: (p) => [{ pid: 9200, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` }],
    });
    assert.deepEqual(await closes.atMoment(LiveLoopToolName.EndEditor, { on: HookEvent.RestoreBefore }), {});
  });

  it("a restore of a folder whose Unreal project isn't linked ends nothing and goes on, at every moment and for the person", async () => {
    for (const hook of [
      { on: HookEvent.RestoreBefore, forPerson: true },
      { on: HookEvent.RestoreBefore, runId: "run-7" },
      { on: HookEvent.RestoreBefore },
    ] as PluginHookContext[]) {
      const w = await reopenWorld({ unlinked: true });
      assert.deepEqual(await w.atMoment(LiveLoopToolName.SaveAll, hook), {}, JSON.stringify(hook));
      assert.deepEqual(await w.atMoment(LiveLoopToolName.EndEditor, hook), {}, JSON.stringify(hook));
      assert.deepEqual(await w.atMoment(LoopToolName.ReopenEditor, { ...hook, on: HookEvent.RestoreAfter }), {});
      assert.deepEqual(w.events, [], "nothing was quit, ended or opened");
      assert.deepEqual(w.signals, [], "no process was signalled");
      assert.equal(w.clock.at, 0, "no wait on an editor that can't exist");
    }
  });

  it("reopen-editor updates an outdated helper while Unreal is closed, before it opens it", async () => {
    const w = await reopenWorld({ outdatedHelper: true });
    assert.deepEqual(await w.atMoment(LoopToolName.ReopenEditor, { on: HookEvent.RestoreAfter, runId: "run-7" }), {});
    const end = await w.reopened();
    assert.equal(end.reopening.state, ReopenState.Done, end.reopening.error);
    assert.deepEqual(w.events, ["update-helper", "compile", `forget ${NAME}.uproject`, `open ${NAME}.uproject`]);

    const direct = await reopenWorld({ outdatedHelper: true });
    await direct.reopen();
    await direct.reopened();
    assert.equal(direct.events.includes("update-helper"), false, "a direct call only reopens, as before");
  });

  it("the person's Rewind reopens only an Unreal its restore closed: a closed one stays closed, its helper untouched", async () => {
    const before: PluginHookContext = { on: HookEvent.RestoreBefore, forPerson: true };
    const after: PluginHookContext = { on: HookEvent.RestoreAfter, forPerson: true };
    const closed = await reopenWorld({ outdatedHelper: true });
    assert.deepEqual(await closed.atMoment(LiveLoopToolName.EndEditor, before), {});
    assert.deepEqual(await closed.atMoment(LoopToolName.ReopenEditor, after), {});
    assert.equal((await closed.editorState()).reopening.state, ReopenState.Idle, "no reopen started");
    assert.deepEqual(closed.events, [], "Unreal was not opened, and its helper was not updated");

    const open = await reopenWorld({
      answering: true,
      rows: (p) => [{ pid: 9200, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${p.project}` }],
    });
    assert.deepEqual(await open.atMoment(LiveLoopToolName.EndEditor, before), {});
    assert.deepEqual(await open.atMoment(LoopToolName.ReopenEditor, after), {});
    assert.equal((await open.reopened()).reopening.state, ReopenState.Done);
    assert.ok(open.events.includes(`open ${NAME}.uproject`), "the Unreal the restore closed was opened again");

    const crashed = await reopenWorld();
    assert.deepEqual(await crashed.atMoment(LoopToolName.ReopenEditor, { on: HookEvent.Crash, runId: "run-7" }), {});
    await crashed.reopened();
    assert.ok(crashed.events.includes(`open ${NAME}.uproject`), "a crash still reopens Unreal");
  });
});
