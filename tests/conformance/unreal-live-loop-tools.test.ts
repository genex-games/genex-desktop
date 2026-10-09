/**
 * The Unreal plugin's tools for the live builder's checkpoint: `play-check` queues a play of the
 * game with the board's checks, refusing any bad check before anything is queued; `save-all` saves
 * the editor's work; `log-errors` reads the editor log's new error lines since an offset, without
 * Unreal's and Genex's own noise, across a restarted log; `update-helper` updates the project's
 * Genex editor helper only while Unreal is closed; `editor-state` says where the project's helper
 * stands. The editor and the helper update are stand-ins; the logs, projects and helpers are real
 * files.
 */
import assert from "node:assert/strict";
import { appendFile, cp, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext, PluginHookContext } from "../../src/plugin-sdk/index.d.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { CppEditorTool } from "../../src/plugins/unreal/cpp-tools.ts";
import { editorLogPath } from "../../src/plugins/unreal/editor-log.ts";
import type { ProcessEnv } from "../../src/plugins/unreal/editor-reopen.ts";
import type { EditorRestart } from "../../src/plugins/unreal/editor-restart.ts";
import { LoopTool, PartRunState, type PlayCheckResult } from "../../src/plugins/unreal/editor-queue.ts";
import {
  type AnyLoopTool,
  createLoopTools,
  HeroShotTool,
  LeadLoopToolName,
  LiveLoopToolName,
  LoopEditorTool,
  LoopToolName,
  MomentToolName,
} from "../../src/plugins/unreal/loop-tools.ts";
import { type MomentOps, OPEN_FOR_RUN_MAX_MS, openForRun } from "../../src/plugins/unreal/editor-moments.ts";
import { ReopenState } from "../../src/plugins/unreal/editor-reopen.ts";
import { MOMENT_WORDS } from "../../src/plugins/unreal/hook-answers.ts";
import { encodePng, type RgbImage } from "../../src/plugins/unreal/tone.ts";
import { type HelperUpdate, HelperState, type SetupEnv, type SetupOptions } from "../../src/plugins/unreal/setup.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CrashLog, crashLog, playable } from "../helpers/unreal-editor-stand-in.ts";

const NAME = "DirtTrack";
/** This project's editor process, and another process the listing always holds. */
const EDITOR_PID = 9100;
const EDITOR_EXEC = "/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor";
const LAUNCHD = { pid: 1, exec: "/sbin/launchd", args: "/sbin/launchd" };
/** How long the stand-in Unreal takes to answer once Genex opened it. */
const OPEN_TAKES_MS = 70_000;
/** The most lines log-errors names, and how long each may be. */
const MAX_LINES = 40;
const MAX_CHARS = 300;

type Options = {
  /** Whether this game's Unreal answers. */
  answering?: boolean;
  /**
   * Whether this project's editor process runs (as it does whenever Unreal answers, unless set);
   * null when the computer's processes can't be listed, so nobody can tell.
   */
  running?: boolean | null;
  /** When (on the stand-in's clock) a busy Unreal answers again. */
  answersAt?: number;
  unlinked?: boolean;
  /** The editor's answer to save_all. */
  save?: () => unknown;
  /** The stand-in helper update's answer. */
  update?: () => HelperUpdate;
  /** The editor's answer to editor_activity, in place of the stand-in's. */
  activity?: () => unknown;
  /** The build toolset's answers (its hero cameras and stills), by tool. */
  build?: (tool: AnyLoopTool, args: Record<string, unknown>) => Promise<unknown>;
  /** An Unreal Genex opens whose process runs but never answers. */
  neverAnswersOpened?: boolean;
};

function fakeEnv(home: string): SetupEnv {
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
 * This computer's Unreal as the tools see it: whether it answers (a busy or opening one once its
 * time comes) and runs, its processes as `ps` lists them, and quitting and opening it, each
 * recorded in `events`.
 */
function standInComputer(
  options: Options,
  now: () => number,
  where: { home: string; project: string; events: string[] },
) {
  const answering = options.answering ?? true;
  const state = {
    answering,
    running: options.running === undefined ? answering : options.running,
    answersAt: options.answersAt,
  };
  const answers = () => {
    if (state.answersAt !== undefined && now() >= state.answersAt)
      Object.assign(state, { answering: true, running: true, answersAt: undefined });
    return state.answering;
  };
  const restart: EditorRestart = {
    editors: async () => (state.running ? 1 : 0),
    quit: async () => {
      where.events.push("quit");
      Object.assign(state, { answering: false, running: false });
    },
    open: async () => {
      where.events.push("open");
      Object.assign(state, {
        running: true,
        answersAt: options.neverAnswersOpened ? undefined : now() + OPEN_TAKES_MS,
      });
    },
  };
  const processes: ProcessEnv = {
    home: where.home,
    // A listing always holds some process: an empty one means it couldn't be read.
    list: async () => {
      if (state.running === null) return [];
      const own = { pid: EDITOR_PID, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${where.project}` };
      return [LAUNCHD, ...(state.running ? [own] : [])];
    },
    signal: (pid) => {
      if (pid !== EDITOR_PID || !state.running) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      Object.assign(state, { answering: false, running: false });
    },
  };
  return { state, answers, restart, processes };
}

/** A game linked to a project, its log in a home of its own, a shipped helper, and the Loop's tools over a stand-in editor. */
async function liveWorld(options: Options = {}) {
  const root = await realpath(await tmpDir("studio-unreal-live-tools-"));
  const home = path.join(root, "home");
  const game = path.join(root, "AI Games", "dirt-track");
  const project = path.join(game, "unreal", `${NAME}.uproject`);
  const storage = path.join(root, "storage");
  const shipped = path.join(root, "shipped", "GenexEditorHelper");
  await mkdir(path.dirname(project), { recursive: true });
  await mkdir(storage, { recursive: true });
  await writeFile(project, JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" }));
  await mkdir(path.join(shipped, "Content", "Python", "genex_build"), { recursive: true });
  await writeFile(
    path.join(shipped, "GenexEditorHelper.uplugin"),
    JSON.stringify({ Version: 5, VersionName: "0.5.0" }),
  );
  await writeFile(path.join(shipped, "Content", "Python", "genex_build", "tools.py"), "# build tools\n");
  const log = editorLogPath({ file: project, directory: path.dirname(project) }, home, "darwin");
  await mkdir(path.dirname(log), { recursive: true });
  await writeFile(log, await crashLog(CrashLog.Open, project));

  const calls: Array<[AnyLoopTool, Record<string, unknown>]> = [];
  const updates: Array<[string, SetupOptions]> = [];
  /** What happened to Unreal, in order: quit, opened, the helper updated. */
  const events: string[] = [];
  const editor = playable();
  const unreal = standInComputer(options, editor.deps.now, { home, project, events });
  const { state } = unreal;
  const setup = (folder: string): SetupOptions => ({ env: fakeEnv(home), helper: shipped, storage: folder });
  const tools = createLoopTools({
    platform: "darwin",
    home,
    setup,
    engine: async () => ({ version: "5.8", directory: path.join(root, "engine") }),
    project: async () => (options.unlinked ? undefined : project),
    xcode: async () => ({ state: XcodeState.Ready }),
    editorCall: async (_storage, _game, tool, args) => {
      calls.push([tool, args]);
      if (tool === LoopEditorTool.ExportReference) throw new Error("not in these tests");
      if (tool === CppEditorTool.SaveAll) return options.save ? options.save() : { saved: true, dirty: [], ms: 640 };
      if (tool === LoopTool.EditorActivity && options.activity) return options.activity();
      if (Object.values(HeroShotTool).includes(tool as HeroShotTool)) return options.build?.(tool, args);
      const answer = await editor.editor.port.call(tool as LoopTool, args);
      if (tool !== LoopTool.CapturePlay) return answer;
      // The queue reads the shot the editor wrote from the project's own Saved folder.
      const shot = path.join(path.dirname(project), "Saved", "Genex", "captures", `${args.name}.png`);
      await mkdir(path.dirname(shot), { recursive: true });
      await writeFile(shot, "PNG");
      return { queued: true, file: shot };
    },
    editorAnswers: async () => unreal.answers(),
    updateHelper: async (file, given) => {
      updates.push([file, given]);
      events.push("update");
      return options.update?.() ?? { from: "0.4.0", to: "0.5.0", kept: [] };
    },
    restart: unreal.restart,
    processes: unreal.processes,
    now: editor.deps.now,
    sleep: editor.deps.sleep,
  });
  const context: PluginContext = {
    project: "dirt-track",
    directory: game,
    signal: new AbortController().signal,
    callId: 1,
    host: (async () => storage) as never,
  };
  const call = (name: string, args: Record<string, unknown> = {}, hook?: PluginHookContext) =>
    tools.call(name as LoopToolName, args, hook ? { ...context, hook } : context, storage);
  return { root, home, game, project, storage, shipped, log, calls, updates, events, state, editor, call, tools };
}

type World = Awaited<ReturnType<typeof liveWorld>>;
type LogErrors = { offset: number; lines: string[]; more: number; rotated: boolean };

const logErrors = async (w: World, since?: number) =>
  (await w.call(LiveLoopToolName.LogErrors, since === undefined ? {} : { since })) as LogErrors;

/** A log line as Unreal writes it, stamped with its time and frame. */
const stamped = (frame: number, line: string) =>
  `[2026.01.01-13.00.${String(frame % 60).padStart(2, "0")}:000][${frame}]${line}`;

describe("play-check", () => {
  it("queues a play of the game with the board's checks, answers its id at once, and part-result reads it", async () => {
    const w = await liveWorld();
    const checks = {
      "feature:track:0": { tag: "genex:track", exists: true },
      "feature:track:1": { player: "routeProgressM", atLeast: 150 },
    };
    const queued = (await w.call(LiveLoopToolName.PlayCheck, { checks })) as { id: string };
    assert.match(queued.id, /play-check/);
    let run: { state: string; part: string; result?: PlayCheckResult; error?: string } | undefined;
    for (let i = 0; i < 5000; i++) {
      run = (await w.call(LoopToolName.PartResult, { id: queued.id })) as typeof run;
      if (run?.state === PartRunState.Done || run?.state === PartRunState.Failed) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(run?.state, PartRunState.Done, run?.error);
    assert.equal(run?.part, "play-check");
    assert.deepEqual(
      run?.result?.checks.map((c) => [c.id, c.passed]),
      [
        ["feature:track:0", true],
        ["feature:track:1", true],
      ],
    );
    assert.equal(run?.result?.frames.length, 4);
    assert.equal(
      w.calls.some(([tool]) => tool === LoopTool.ApplyPart),
      false,
      "nothing is applied",
    );
  });

  const hostile: Array<[string, unknown, RegExp]> = [
    ["no checks at all", undefined, /checks/],
    ["checks as JSON text", '{"feature:a:0":{"tag":"genex:a","exists":true}}', /checks/],
    ["checks as a list", [{ tag: "genex:a", exists: true }], /checks/],
    ["checks as null", null, /checks/],
    [
      "an actor check (a part's, not the board's)",
      { "feature:a:0": { actor: "Lantern_0", exists: true } },
      /feature:a:0/,
    ],
    ["a tag that isn't a genex: tag", { "feature:a:0": { tag: "terrain", exists: true } }, /feature:a:0/],
    ["a tag check with another key", { "feature:a:0": { tag: "genex:a", exists: true, why: "x" } }, /feature:a:0/],
    ["a player check without a bound", { "feature:a:0": { player: "speedKmh" } }, /feature:a:0/],
    ["a player check bound by text", { "feature:a:0": { player: "speedKmh", atLeast: "20" } }, /feature:a:0/],
    ["a check that is text", { "feature:a:0": "genex:a" }, /feature:a:0/],
    ["a board id too long", { [`feature:${"a".repeat(96)}:0`]: { tag: "genex:a", exists: true } }, /board id/],
    ["a board id with a space", { "feature:a b:0": { tag: "genex:a", exists: true } }, /board id/],
    ["a board id with a newline", { "feature:a\n:0": { tag: "genex:a", exists: true } }, /board id/],
    ["an empty board id", { "": { tag: "genex:a", exists: true } }, /board id/],
    [
      "more than 40 checks",
      Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`feature:a:${i}`, { tag: "genex:a", exists: true }])),
      /at most 40/,
    ],
  ];
  for (const [label, checks, why] of hostile) {
    it(`refuses ${label}, queuing nothing and calling no editor tool`, async () => {
      const w = await liveWorld();
      const args = checks === undefined ? {} : { checks };
      await assert.rejects(w.call(LiveLoopToolName.PlayCheck, args), why);
      assert.deepEqual(w.calls, []);
      await assert.rejects(w.call(LoopToolName.PartResult, { id: "dirt-track-play-check-1" }), /no part run/);
    });
  }

  it("names every bad check in one refusal", async () => {
    const w = await liveWorld();
    const checks = {
      "feature:a:0": { tag: "terrain", exists: true },
      "feature:a:1": { tag: "genex:a", exists: true },
      "feature:b:0": { player: "speedKmh" },
    };
    await assert.rejects(w.call(LiveLoopToolName.PlayCheck, { checks }), (error: Error) => {
      assert.match(error.message, /feature:a:0/);
      assert.match(error.message, /feature:b:0/);
      assert.doesNotMatch(error.message, /feature:a:1/);
      return true;
    });
  });
});

describe("save-all", () => {
  it("saves the editor's work and answers the helper's report", async () => {
    const w = await liveWorld();
    assert.deepEqual(await w.call(LiveLoopToolName.SaveAll), { saved: true, dirty: [], ms: 640 });
    assert.deepEqual(w.calls, [
      [LoopTool.PlayState, {}],
      [CppEditorTool.SaveAll, {}],
    ]);
  });

  it("stops a play session the builder left running, waits for it to end, then saves", async () => {
    const box: { world?: World } = {};
    const refused = { error: "A play session is running; stop it first (stop_play)." };
    const w = await liveWorld({
      save: () => (box.world?.editor.editor.state.pie ? refused : { saved: true, dirty: [], ms: 640 }),
    });
    box.world = w;
    w.editor.editor.state.pie = true;
    assert.deepEqual(await w.call(LiveLoopToolName.SaveAll), { saved: true, dirty: [], ms: 640 });
    const tools = w.calls.map(([tool]) => tool);
    const stopped = tools.indexOf(LoopTool.StopPlay);
    assert.ok(stopped >= 0 && stopped < tools.indexOf(CppEditorTool.SaveAll), tools.join(", "));
  });

  it("throws the helper's refusal during play", async () => {
    const w = await liveWorld({ save: () => ({ error: "A play session is running; stop it before saving." }) });
    await assert.rejects(w.call(LiveLoopToolName.SaveAll), /play session is running/);
  });

  it("throws when what the editor answered isn't the helper's report", async () => {
    const w = await liveWorld({ save: () => "Traceback (most recent call last)" });
    await assert.rejects(w.call(LiveLoopToolName.SaveAll), /didn't answer/);
  });

  it("throws, calling nothing, when Unreal doesn't answer", async () => {
    const w = await liveWorld({ answering: false });
    await assert.rejects(w.call(LiveLoopToolName.SaveAll), /isn't answering/);
    assert.deepEqual(w.calls, []);
  });
});

/** Error lines an editor writes while a step is saved and played, with Unreal's and Genex's own noise among them. */
const STEP_LOG = [
  stamped(
    100,
    "LogBlueprint: Error: [AssetLog] /Game/Track/BP_Track.BP_Track: [Compiler] Accessed None reading Spline",
  ),
  stamped(
    101,
    "LogBlueprint: Error: [AssetLog] /Game/Track/BP_Track.BP_Track: [Compiler] Accessed None reading Spline",
  ),
  stamped(102, "LogPython: Error: Traceback (most recent call last):"),
  stamped(
    103,
    'LogPython: Error:   File "/Users/owner/AI Games/dirt-track/unreal/Content/Python/genex_build/tools.py", line 42, in track_terrain',
  ),
  stamped(104, "LogHttpConnection: Error: errors.com.epicgames.httpserver.socket_send_failure"),
  stamped(
    105,
    "LogModelContextProtocol: Error: Unknown session id 'ab12' for 'notifications/initialized'; client should reinitialize",
  ),
  stamped(106, "LogToolsetRegistry: Error: Toolset 'ObjectTools' not found"),
  stamped(107, "LogEOSMessageService: Error: Unable to find port."),
  stamped(108, "LogClass: Error: ByteProperty FStepSettings::TraceChannel is not initialized properly"),
  stamped(109, "LogTemp: Error test: UE::UnifiedErrorTest::Empty: [Empty error]"),
  stamped(110, "LogAudioMixerAudioUnit: Warning: Error querying Sample Rate: 2003332927"),
  stamped(111, "LogOutputDevice: Error: Ensure condition failed: Bike != nullptr"),
  stamped(112, "LogOutputDevice: Error: [Callstack] 0x0e3e90f0 libUnrealEditor-Engine.dylib!USceneComponent::Tick()"),
  stamped(113, "LogOutputDevice: Error: "),
  stamped(114, "LogScript: Fatal: Script call stack: BP_Track.ReceiveTick"),
].join("\n");

/** What log-errors names of {@link STEP_LOG}: each error once, without its stamp, the owner's path cut to its file. */
const STEP_ERRORS = [
  "LogBlueprint: Error: [AssetLog] /Game/Track/BP_Track.BP_Track: [Compiler] Accessed None reading Spline",
  "LogPython: Error: Traceback (most recent call last):",
  'LogPython: Error: File "tools.py", line 42, in track_terrain',
  "LogOutputDevice: Error: Ensure condition failed: Bike != nullptr",
  "LogScript: Fatal: Script call stack: BP_Track.ReceiveTick",
];

describe("log-errors", () => {
  it("answers where the log ends now, and no lines, without since", async () => {
    const w = await liveWorld();
    const size = (await readFile(w.log)).length;
    assert.deepEqual(await logErrors(w), { offset: size, lines: [], more: 0, rotated: false });
  });

  it("names the error lines written since the offset, once each, without noise, stamps or the owner's paths", async () => {
    const w = await liveWorld();
    await appendFile(w.log, `${stamped(90, "LogBlueprint: Error: an error from before the step")}\n`);
    const { offset } = await logErrors(w);
    await appendFile(w.log, `${STEP_LOG}\n`);
    const read = await logErrors(w, offset);
    assert.deepEqual(read.lines, STEP_ERRORS);
    assert.equal(read.more, 0);
    assert.equal(read.rotated, false);
    assert.equal(read.offset, (await readFile(w.log)).length);
    assert.doesNotMatch(read.lines.join("\n"), /\/Users|AI Games|owner/);
    assert.deepEqual(await logErrors(w, read.offset), { offset: read.offset, lines: [], more: 0, rotated: false });
  });

  it("leaves a line Unreal is still writing for the next read", async () => {
    const w = await liveWorld();
    const { offset } = await logErrors(w);
    await appendFile(w.log, `${stamped(1, "LogBlueprint: Error: first")}\n${stamped(2, "LogBlueprint: Error: sec")}`);
    const first = await logErrors(w, offset);
    assert.deepEqual(first.lines, ["LogBlueprint: Error: first"]);
    await appendFile(w.log, "ond\n");
    assert.deepEqual((await logErrors(w, first.offset)).lines, ["LogBlueprint: Error: second"]);
  });

  it("names at most 40 lines of at most 300 characters, and counts the rest", async () => {
    const w = await liveWorld();
    const { offset } = await logErrors(w);
    const lines = Array.from({ length: 45 }, (_, i) => stamped(i, `LogBlueprint: Error: ${i} ${"x".repeat(400)}`));
    await appendFile(w.log, `${lines.join("\n")}\n`);
    const read = await logErrors(w, offset);
    assert.equal(read.lines.length, MAX_LINES);
    assert.equal(read.more, 5);
    for (const line of read.lines) assert.ok(line.length <= MAX_CHARS, `${line.length} characters`);
  });

  it("reads a restarted Unreal's new log from its start, as rotated", async () => {
    const w = await liveWorld();
    await appendFile(w.log, `${STEP_LOG}\n`);
    const { offset } = await logErrors(w);
    // Unreal keeps the old log as a backup and starts a new one: a new file at the same path.
    await rename(w.log, `${w.log.replace(/\.log$/, "")}-backup-2026.01.01-13.10.00.log`);
    const fresh = `${await crashLog(CrashLog.Open, w.project)}${stamped(5, "LogBlueprint: Error: after the restart")}\n`;
    await writeFile(w.log, fresh + "x".repeat(offset));
    const read = await logErrors(w, offset);
    assert.equal(read.rotated, true, "longer than the offset, yet another log");
    assert.deepEqual(read.lines, ["LogBlueprint: Error: after the restart"]);
  });

  it("reads the log from its start, as rotated, when the offset is past its end", async () => {
    const w = await liveWorld();
    await appendFile(w.log, `${stamped(5, "LogBlueprint: Error: in a short new log")}\n`);
    const read = await logErrors(w, 10_000_000);
    assert.equal(read.rotated, true);
    assert.deepEqual(read.lines, ["LogBlueprint: Error: in a short new log"]);
  });

  const unreadable: Array<[string, (w: World) => Promise<void>]> = [
    [
      "a link to another log",
      async (w) => {
        const other = path.join(w.root, "elsewhere.log");
        await writeFile(other, `${await crashLog(CrashLog.Open, w.project)}${STEP_LOG}\n`);
        await rename(w.log, `${w.log}.old`);
        await symlink(other, w.log);
      },
    ],
    [
      "another project's log",
      async (w) => {
        await writeFile(w.log, `${await crashLog(CrashLog.Open, "/Users/owner/Other/Other.uproject")}${STEP_LOG}\n`);
      },
    ],
    ["a missing log", async (w) => rename(w.log, `${w.log}.gone`)],
    [
      "a folder where the log goes",
      async (w) => {
        await rename(w.log, `${w.log}.gone`);
        await mkdir(w.log);
      },
    ],
  ];
  for (const [label, make] of unreadable) {
    it(`names nothing from ${label}`, async () => {
      const w = await liveWorld();
      await make(w);
      assert.deepEqual(await logErrors(w), { offset: 0, lines: [], more: 0, rotated: false });
      assert.deepEqual((await logErrors(w, 0)).lines, []);
    });
  }

  const badSince: unknown[] = [-1, 1.5, "12", Number.POSITIVE_INFINITY, 2 ** 60, null, true, { offset: 3 }];
  for (const since of badSince) {
    it(`refuses since ${typeof since === "number" ? since : JSON.stringify(since)}`, async () => {
      const w = await liveWorld();
      await assert.rejects(w.call(LiveLoopToolName.LogErrors, { since }), /since/);
    });
  }

  it("refuses a game without a linked project", async () => {
    const w = await liveWorld({ unlinked: true });
    await assert.rejects(logErrors(w), /isn't linked to an Unreal project/);
  });
});

describe("update-helper", () => {
  it("updates the project's helper while Unreal is closed, and answers what changed", async () => {
    const w = await liveWorld({
      answering: false,
      update: () => ({ from: "0.4.0", to: "0.5.0", kept: ["Plugins/GenexEditorHelper/Content/Python/x.py.mine"] }),
    });
    assert.deepEqual(await w.call(LiveLoopToolName.UpdateHelper), {
      from: "0.4.0",
      to: "0.5.0",
      kept: ["Plugins/GenexEditorHelper/Content/Python/x.py.mine"],
    });
    assert.equal(w.updates.length, 1);
    const [file, options] = w.updates[0] ?? [];
    assert.equal(file, w.project);
    assert.deepEqual([options?.helper, options?.storage], [w.shipped, w.storage]);
  });

  it("refuses, updating nothing, while this game's Unreal answers", async () => {
    const w = await liveWorld({ answering: true });
    await assert.rejects(w.call(LiveLoopToolName.UpdateHelper), /Unreal is open/);
    assert.deepEqual(w.updates, []);
  });

  it("refuses a game without a linked project", async () => {
    const w = await liveWorld({ answering: false, unlinked: true });
    await assert.rejects(w.call(LiveLoopToolName.UpdateHelper), /isn't linked to an Unreal project/);
    assert.deepEqual(w.updates, []);
  });
});

describe("editor-state names where the project's helper stands", () => {
  const helperIn = (w: World) => path.join(path.dirname(w.project), "Plugins", "GenexEditorHelper");
  const cases: Array<[string, (w: World) => Promise<void>, string]> = [
    ["missing", async () => {}, HelperState.Missing],
    ["the shipped one", (w) => cp(w.shipped, helperIn(w), { recursive: true }), HelperState.Current],
    [
      "an older one",
      async (w) => {
        await cp(w.shipped, helperIn(w), { recursive: true });
        await writeFile(path.join(helperIn(w), "GenexEditorHelper.uplugin"), JSON.stringify({ Version: 4 }));
      },
      HelperState.Outdated,
    ],
  ];
  for (const [label, make, helper] of cases) {
    it(`reads ${helper} for ${label}`, async () => {
      const w = await liveWorld();
      await make(w);
      const state = (await w.call(LoopToolName.EditorState)) as { helper: string | null; answering: boolean };
      assert.equal(state.helper, helper);
      assert.equal(state.answering, true);
    });
  }

  it("reads null for a game without a linked project", async () => {
    const w = await liveWorld({ unlinked: true });
    assert.equal(((await w.call(LoopToolName.EditorState)) as { helper: unknown }).helper, null);
  });
});

describe("editor-activity", () => {
  it("answers whether a play session runs and how many packages are unsaved", async () => {
    const w = await liveWorld({
      activity: () => ({ camera: [0, 0, 0], selection: [], dirty: ["/Game/Maps/Hall", "/Game/Kit/SM_Rib"], pie: true }),
    });
    assert.deepEqual(await w.call(LeadLoopToolName.EditorActivity), {
      personActive: true,
      unsaved: 2,
      pie: true,
      dirty: 2,
    });
  });

  it("answers that nobody uses it and nothing is unsaved, calling nothing, when no editor of the game runs", async () => {
    const w = await liveWorld({ answering: false });
    assert.deepEqual(await w.call(LeadLoopToolName.EditorActivity), {
      personActive: false,
      unsaved: 0,
      pie: false,
      dirty: 0,
    });
    assert.deepEqual(w.calls, []);
  });

  it("throws, calling nothing, when Unreal runs but doesn't answer, or nobody can tell whether it runs", async () => {
    for (const running of [true, null]) {
      const w = await liveWorld({ answering: false, running });
      await assert.rejects(w.call(LeadLoopToolName.EditorActivity), /isn't answering/, String(running));
      assert.deepEqual(w.calls, []);
    }
  });

  const odd: Array<[string, unknown]> = [
    ["a traceback", "Traceback (most recent call last)"],
    ["no play state", { dirty: [] }],
    ["a count for dirty", { dirty: 3, pie: false }],
    ["a refusal", { error: "The editor is busy." }],
  ];
  for (const [label, answer] of odd)
    it(`throws when the editor answers ${label}, so nobody reads it as idle`, async () => {
      const w = await liveWorld({ activity: () => answer });
      await assert.rejects(w.call(LeadLoopToolName.EditorActivity));
    });
});

/** A small picture: a dark frame with a bright band, as a PNG. */
function picture(): Buffer {
  const image: RgbImage = { width: 64, height: 36, rgb: new Uint8Array(64 * 36 * 3) };
  for (let i = 0; i < image.rgb.length; i += 1) image.rgb[i] = Math.floor(i / 3) % 64 < 16 ? 220 : 12;
  return encodePng(image);
}

/** A level with these hero cameras whose stills land in `folder` (the project's captures folder unless a test moves them). */
async function heroWorld(cameras: string[], where?: (w: World, camera: string) => Promise<string>) {
  const box: { world?: World } = {};
  const w = await liveWorld({
    build: async (tool, args) => {
      const world = box.world as World;
      if (tool === HeroShotTool.ShotCameras) return { cameras };
      const camera = String(args.camera);
      const file = where
        ? await where(world, camera)
        : path.join(path.dirname(world.project), "Saved", "Genex", "captures", `shot-${camera}.png`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, picture());
      return { queued: true, file, camera, width: args.width, height: args.height, delayS: args.delay_s };
    },
  });
  box.world = w;
  return w;
}

type HeroShots = { shots: Array<{ name: string; file: string; data: string; tone: Record<string, number> }> };

describe("hero-shots", () => {
  it("captures each hero camera with the prefix, up to max, as PNG data with its tone numbers", async () => {
    const w = await heroWorld(["GX_Shot_Atrium", "GX_Shot_Hall", "GX_Shot_Roof", "SomeCamera"]);
    const answer = (await w.call(LeadLoopToolName.HeroShots, { prefix: "GX_Shot_", max: 2 })) as HeroShots;
    assert.deepEqual(
      answer.shots.map((shot) => shot.name),
      ["GX_Shot_Atrium", "GX_Shot_Hall"],
    );
    const [first] = answer.shots;
    assert.equal(Buffer.from(first?.data ?? "", "base64").equals(picture()), true, "the PNG as it landed");
    assert.equal(typeof first?.tone.p2, "number");
    assert.equal(typeof first?.tone.farStd, "number");
    const asked = w.calls.filter(([tool]) => tool === HeroShotTool.CaptureShot).map(([, args]) => args.camera);
    assert.deepEqual(asked, ["GX_Shot_Atrium", "GX_Shot_Hall"], "one still per camera, no more than max");
  });

  it("answers no shots, capturing nothing, for a level without hero cameras", async () => {
    const w = await heroWorld([]);
    assert.deepEqual(await w.call(LeadLoopToolName.HeroShots, { prefix: "GX_Shot_", max: 4 }), { shots: [] });
    assert.equal(w.calls.filter(([tool]) => tool === HeroShotTool.CaptureShot).length, 0);
  });

  it("refuses a bad prefix or max, asking the editor nothing", async () => {
    const w = await heroWorld(["GX_Shot_Hall"]);
    const bad: Array<Record<string, unknown>> = [
      { prefix: "", max: 2 },
      { prefix: "../GX", max: 2 },
      { prefix: "GX_Shot_", max: 0 },
      { prefix: "GX_Shot_", max: 2.5 },
      { prefix: "GX_Shot_", max: 99 },
      { prefix: "GX_Shot_", max: "4" },
    ];
    for (const args of bad) await assert.rejects(w.call(LeadLoopToolName.HeroShots, args), JSON.stringify(args));
    assert.deepEqual(w.calls, []);
  });

  it("reads no still from outside the project's captures folder", async () => {
    const outside: Array<[string, (w: World, camera: string) => Promise<string>]> = [
      ["another folder", async (w, camera) => path.join(w.root, "elsewhere", `${camera}.png`)],
      [
        "a path that climbs out",
        async (w, camera) =>
          path.join(path.dirname(w.project), "Saved", "Genex", "captures", "..", "..", `${camera}.png`),
      ],
      [
        "a captures folder that is a link",
        async (w, camera) => {
          const real = path.join(w.root, "real-captures");
          await mkdir(real, { recursive: true });
          const link = path.join(path.dirname(w.project), "Saved", "Genex", "captures");
          await mkdir(path.dirname(link), { recursive: true });
          await symlink(real, link).catch(() => {});
          return path.join(link, `${camera}.png`);
        },
      ],
    ];
    for (const [label, where] of outside) {
      const w = await heroWorld(["GX_Shot_Hall"], where);
      const answer = (await w.call(LeadLoopToolName.HeroShots, { prefix: "GX_Shot_", max: 4 })) as HeroShots;
      assert.deepEqual(answer.shots, [], label);
    }
  });
});

describe("the live tools beside the part tools", () => {
  it("are tools of the Loop's, called by name", async () => {
    const w = await liveWorld();
    for (const name of Object.values(LiveLoopToolName)) assert.ok(w.tools.has(name), name);
    for (const name of Object.values(LeadLoopToolName)) assert.ok(w.tools.has(name), name);
    for (const name of Object.values(LoopToolName)) assert.ok(w.tools.has(name), name);
    assert.equal(w.tools.has("apply-part"), false);
  });
});

/** A run's moment and a chat's, as Genex tells a handler. */
const IN_RUN = { runId: "run-7", label: "Hall lit" } as const;
const IN_CHAT = { label: "Hall lit" } as const;
const atRun = (on: PluginHookContext["on"]): PluginHookContext => ({ on, ...IN_RUN });
const atChat = (on: PluginHookContext["on"]): PluginHookContext => ({ on, ...IN_CHAT });
/** The editor's answer to editor_activity with these packages unsaved. */
const unsaved =
  (...dirty: string[]) =>
  () => ({ camera: [0, 0, 0], selection: [], dirty, pie: false });
const savedTool = (w: World) => w.calls.filter(([tool]) => tool === CppEditorTool.SaveAll).length;

/** A run's save point: saved, or blocked with why. */
async function saveAtRunCheckpoint() {
  const before = atRun(HookEvent.CheckpointBefore);
  const saved = await liveWorld({ activity: unsaved("/Game/Maps/Hall") });
  assert.deepEqual(await saved.call(LiveLoopToolName.SaveAll, {}, before), {});
  assert.equal(savedTool(saved), 1, "the editor saved its work");

  const playing = await liveWorld();
  playing.editor.editor.state.pie = true;
  const refused = (await playing.call(LiveLoopToolName.SaveAll, {}, before)) as { block?: string };
  assert.match(refused.block ?? "", /playing in the editor: stop the play session first/);
  assert.equal(savedTool(playing), 0, "a play session is never ended to save");

  const closed = await liveWorld({ answering: false });
  assert.deepEqual(await closed.call(LiveLoopToolName.SaveAll, {}, before), {
    block: "Unreal doesn't answer, so nothing was saved.",
  });

  const unknown = await liveWorld({ activity: () => ({ dirty: 3 }) });
  const cantTell = (await unknown.call(LiveLoopToolName.SaveAll, {}, before)) as { block?: string };
  assert.match(cantTell.block ?? "", /can't tell whether the game is playing/);
  assert.equal(savedTool(unknown), 0);

  const left = await liveWorld({
    activity: unsaved("/Game/Maps/Hall"),
    save: () => ({ saved: false, dirty: ["/Game/Maps/Hall"], ms: 300 }),
  });
  const notSaved = (await left.call(LiveLoopToolName.SaveAll, {}, before)) as { block?: string };
  assert.match(notSaved.block ?? "", /left 1 assets unsaved \(\/Game\/Maps\/Hall\)\. No save point was made/);
}

/** A chat's checkpoint: a note of what was saved, blocked only by a play. */
async function saveAtChatCheckpoint() {
  const before = atChat(HookEvent.CheckpointBefore);
  const two = await liveWorld({ activity: unsaved("/Game/Maps/Hall", "/Game/Kit/SM_Rib") });
  assert.deepEqual(await two.call(LiveLoopToolName.SaveAll, {}, before), {
    note: "Saved 2 unsaved files in Unreal.",
  });

  const clean = await liveWorld();
  assert.deepEqual(await clean.call(LiveLoopToolName.SaveAll, {}, before), { note: "Unreal had nothing unsaved." });
  assert.equal(savedTool(clean), 0, "nothing unsaved, nothing to save");

  const closed = await liveWorld({ answering: false });
  const unknown = (await closed.call(LiveLoopToolName.SaveAll, {}, before)) as { note?: string; block?: string };
  assert.match(unknown.note ?? "", /couldn't tell whether the game is playing in Unreal, so nothing was saved there/);
  assert.equal(unknown.block, undefined);

  const left = await liveWorld({
    activity: unsaved("/Game/Maps/Hall"),
    save: () => ({ saved: false, dirty: ["/Game/Maps/Hall"], ms: 300 }),
  });
  const partly = (await left.call(LiveLoopToolName.SaveAll, {}, before)) as { note?: string; block?: string };
  assert.match(partly.note ?? "", /1 file stayed unsaved in Unreal \(\/Game\/Maps\/Hall\)/);
  assert.equal(partly.block, undefined);

  const playing = await liveWorld();
  playing.editor.editor.state.pie = true;
  const refused = (await playing.call(LiveLoopToolName.SaveAll, {}, before)) as { block?: string };
  assert.match(refused.block ?? "", /playing in the Unreal editor, so nothing was saved and no snapshot was taken/);
}

describe("at Genex's moments", () => {
  it(
    "save-all at a run's checkpoint blocks on a play, an editor that doesn't answer, or work left unsaved, and is silent when it saved",
    saveAtRunCheckpoint,
  );

  it(
    "save-all at a chat's checkpoint notes what it saved or couldn't, and blocks only on a play",
    saveAtChatCheckpoint,
  );

  it("save-all before a restore saves nothing of an editor that isn't running, and waits while one is busy", async () => {
    for (const hook of [atRun(HookEvent.RestoreBefore), atChat(HookEvent.RestoreBefore)]) {
      const gone = await liveWorld({ answering: false, running: false });
      assert.deepEqual(await gone.call(LiveLoopToolName.SaveAll, {}, hook), {});
      assert.deepEqual(gone.calls, [], "nothing to save in an editor that isn't there");
    }

    const busy = await liveWorld({ answering: false, running: true, answersAt: 40_000 });
    assert.deepEqual(await busy.call(LiveLoopToolName.SaveAll, {}, atRun(HookEvent.RestoreBefore)), {});
    assert.equal(savedTool(busy), 1, "saved once it answered again");
    assert.ok(busy.editor.deps.now() >= 40_000, "it waited for the busy editor");

    const stuck = await liveWorld({ answering: false, running: true });
    const stayed = (await stuck.call(LiveLoopToolName.SaveAll, {}, atRun(HookEvent.RestoreBefore))) as {
      block?: string;
    };
    assert.match(
      stayed.block ?? "",
      /Genex couldn't save Unreal's work \(Unreal stayed busy and answered nothing\), so it left Unreal open/,
    );
    assert.ok(stuck.editor.deps.now() >= 5 * 60_000, "it waited five minutes first");
    assert.equal(savedTool(stuck), 0);

    const failing = await liveWorld({ save: () => ({ error: "The package is read-only." }) });
    const failed = (await failing.call(LiveLoopToolName.SaveAll, {}, atChat(HookEvent.RestoreBefore))) as {
      block?: string;
    };
    assert.match(failed.block ?? "", /Genex couldn't save Unreal's work \(The package is read-only\.\)/);
  });

  it("log-errors marks where the log ends at a run's start and notes only the new errors at each checkpoint", async () => {
    const w = await liveWorld();
    await appendFile(w.log, `${stamped(90, "LogBlueprint: Error: an error from before the run")}\n`);
    assert.deepEqual(await w.call(LiveLoopToolName.LogErrors, {}, atRun(HookEvent.RunPrepare)), {});
    await appendFile(w.log, `${STEP_LOG}\n`);
    const first = (await w.call(LiveLoopToolName.LogErrors, {}, atRun(HookEvent.CheckpointBefore))) as {
      note?: string;
    };
    assert.match(first.note ?? "", /Unreal's log has 5 new errors since the last save point/);
    assert.ok(first.note?.includes(STEP_ERRORS[0] ?? "?"), first.note);
    assert.doesNotMatch(first.note ?? "", /from before the run/);
    assert.deepEqual(
      await w.call(LiveLoopToolName.LogErrors, {}, atRun(HookEvent.CheckpointBefore)),
      {},
      "nothing new",
    );

    const chat = await liveWorld();
    await appendFile(chat.log, `${STEP_LOG}\n`);
    assert.deepEqual(
      await chat.call(LiveLoopToolName.LogErrors, {}, atChat(HookEvent.CheckpointBefore)),
      {},
      "without a mark, the log is read from now",
    );
    await appendFile(chat.log, `${stamped(200, "LogScript: Fatal: Script call stack: BP_Gate.ReceiveTick")}\n`);
    const next = (await chat.call(LiveLoopToolName.LogErrors, {}, atChat(HookEvent.CheckpointBefore))) as {
      note?: string;
    };
    assert.match(next.note ?? "", /1 new error/);
    assert.match(next.note ?? "", /BP_Gate\.ReceiveTick/);
  });

  it("hero-shots at a checkpoint answers its stills as images with their tone, prefix and max by default", async () => {
    const cameras = Array.from({ length: 10 }, (_, i) => `GX_Shot_${String(i).padStart(2, "0")}`);
    const w = await heroWorld(["Other_Camera", ...cameras]);
    const answer = (await w.call(LeadLoopToolName.HeroShots, {}, atRun(HookEvent.CheckpointAfter))) as {
      images?: Array<{ name: string; data: string; measures?: Record<string, number> }>;
    };
    assert.deepEqual(
      answer.images?.map((image) => image.name),
      cameras.slice(0, 8),
      "the GX_Shot_ cameras, eight at most",
    );
    const [first] = answer.images ?? [];
    assert.equal(Buffer.from(first?.data ?? "", "base64").equals(picture()), true);
    assert.equal(typeof first?.measures?.p2, "number");
    assert.equal(typeof first?.measures?.farStd, "number");
    assert.deepEqual(Object.keys(answer), ["images"], "pictures only: no block and no note");

    const direct = (await w.call(LeadLoopToolName.HeroShots, {})) as HeroShots;
    assert.equal(direct.shots.length, 8, "a direct call takes the same defaults");
  });

  it("hero-shots at a chat's checkpoint takes no stills: only a run's save points have thumbnails", async () => {
    const w = await heroWorld(["GX_Shot_00", "GX_Shot_01"]);
    assert.deepEqual(await w.call(LeadLoopToolName.HeroShots, {}, atChat(HookEvent.CheckpointAfter)), {});
    assert.deepEqual(w.calls, [], "the editor was asked for no camera and no still");
  });
});

/** The project's own Genex editor helper folder. */
const helperOf = (w: World) => path.join(path.dirname(w.project), "Plugins", "GenexEditorHelper");
/** The template's facts the editor exported for the project, as the Loop reads them. */
const factsOf = (w: World) => path.join(path.dirname(w.project), "Saved", "Genex", "project.json");

describe("open-for-run", () => {
  it("opens a closed Unreal, updates an outdated helper once its process exits, exports a missing reference, and blocks without a helper", async () => {
    const prepare = atRun(HookEvent.RunPrepare);
    const closed = await liveWorld({ answering: false, running: false });
    await cp(closed.shipped, helperOf(closed), { recursive: true });
    await mkdir(path.dirname(factsOf(closed)), { recursive: true });
    await writeFile(factsOf(closed), JSON.stringify({ blueprints: [] }));
    assert.deepEqual(await closed.call(MomentToolName.OpenForRun, {}, prepare), {});
    assert.deepEqual(closed.events, ["open"], "opened, nothing updated");
    assert.equal(closed.state.answering, true, "it waited until Unreal answered");
    assert.ok(closed.editor.deps.now() >= OPEN_TAKES_MS);
    assert.equal(
      closed.calls.some(([tool]) => tool === LoopEditorTool.ExportReference),
      false,
      "the facts were there",
    );

    const outdated = await liveWorld();
    await cp(outdated.shipped, helperOf(outdated), { recursive: true });
    await writeFile(path.join(helperOf(outdated), "GenexEditorHelper.uplugin"), JSON.stringify({ Version: 4 }));
    const updated = (await outdated.call(MomentToolName.OpenForRun, {}, prepare)) as { note?: string };
    assert.match(updated.note ?? "", /Updated this game's Genex editor helper to 0\.5\.0/);
    assert.deepEqual(outdated.events, ["quit", "update", "open"], "saved, closed, updated while closed, reopened");
    assert.equal(savedTool(outdated), 1, "its work was saved before Unreal was closed");
    assert.equal(outdated.state.answering, true);
    assert.ok(
      outdated.calls.some(([tool]) => tool === LoopEditorTool.ExportReference),
      "a project that never exported its facts has them exported",
    );

    const missing = await liveWorld();
    const blocked = (await missing.call(MomentToolName.OpenForRun, {}, prepare)) as { block?: string };
    assert.match(blocked.block ?? "", /no Genex editor helper/);
    assert.deepEqual(missing.events, []);
  });

  /** A world whose project has the plugin's helper at an older version. */
  async function outdatedWorld(options: Options) {
    const w = await liveWorld(options);
    await cp(w.shipped, helperOf(w), { recursive: true });
    await writeFile(path.join(helperOf(w), "GenexEditorHelper.uplugin"), JSON.stringify({ Version: 4 }));
    return w;
  }

  it("an outdated helper whose save leaves work unsaved stays as it was, Unreal open, and the run goes on with a note", async () => {
    const w = await outdatedWorld({ save: () => ({ saved: true, dirty: ["/Game/Maps/Track"], ms: 10 }) });
    const answer = (await w.call(MomentToolName.OpenForRun, {}, atRun(HookEvent.RunPrepare))) as Record<string, string>;
    assert.equal(answer.block, undefined, "the run goes on");
    assert.match(
      answer.note ?? "",
      /helper couldn't be updated \(.*\/Game\/Maps\/Track.* left Unreal open\); the Loop goes on/,
    );
    assert.deepEqual(w.events, [], "nothing was closed or updated");
    assert.equal(w.state.answering, true, "Unreal is still open");
  });

  it("a helper update that throws is a note: Unreal is opened again and the run goes on", async () => {
    const w = await outdatedWorld({
      update: () => {
        throw new Error("the disk is full");
      },
    });
    const answer = (await w.call(MomentToolName.OpenForRun, {}, atRun(HookEvent.RunPrepare))) as Record<string, string>;
    assert.equal(answer.block, undefined);
    assert.match(answer.note ?? "", /helper couldn't be updated \(the disk is full\); the Loop goes on/);
    assert.deepEqual(w.events, ["quit", "update", "open"], "closed, the update tried, reopened");
    assert.equal(w.state.answering, true);
  });

  it("an Unreal that never answers once opened blocks the run's start with its reopen's own failure, within its ceiling", async () => {
    const w = await liveWorld({ answering: false, running: false, neverAnswersOpened: true });
    await cp(w.shipped, helperOf(w), { recursive: true });
    const answer = (await w.call(MomentToolName.OpenForRun, {}, atRun(HookEvent.RunPrepare))) as { block?: string };
    // The reopen job gives up after its own five minutes, before the step's six-minute wait would.
    assert.match(
      answer.block ?? "",
      /^Unreal couldn't be reopened \(reopening Unreal failed: Genex reopened the game's project, but Unreal didn't answer within 5 minutes/,
    );
    assert.deepEqual(w.events, ["open"]);
    assert.ok(w.editor.deps.now() >= 5 * 60_000, "it waited minutes on the stand-in's clock");
    assert.ok(w.editor.deps.now() < OPEN_FOR_RUN_MAX_MS, "and answered before the step's longest start");
  });
});

describe("open-for-run's own wait for a reopened Unreal (editor-moments.ts)", () => {
  /** A gone Unreal whose reopen goes as `reopening` says, on a clock its own waits move. */
  function goneUnreal(reopen: () => Promise<unknown>, reopening: () => { state: ReopenState; error?: string }) {
    let now = 0;
    const ops = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      signal: new AbortController().signal,
      answers: async () => false,
      running: async () => false,
      reopen,
      state: async () => ({ answering: false, running: false, reopening: reopening(), helper: HelperState.Current }),
    } as unknown as MomentOps;
    return { ops, now: () => now };
  }

  it("a reopen still under way after six minutes blocks the start: Unreal didn't answer in time", async () => {
    const { ops, now } = goneUnreal(
      async () => ({ started: true }),
      () => ({ state: ReopenState.Reopening }),
    );
    const answer = await openForRun(ops);
    assert.equal(answer.block, MOMENT_WORDS.NotOpened(MOMENT_WORDS.OpenTimedOut(6)));
    assert.ok(now() >= 6 * 60_000, "it waited its six minutes");
  });

  it("a reopen that fails blocks the start with its error", async () => {
    const { ops } = goneUnreal(
      async () => ({ started: true }),
      () => ({ state: ReopenState.Failed, error: "the project is locked" }),
    );
    const answer = await openForRun(ops);
    assert.equal(answer.block, MOMENT_WORDS.NotOpened(MOMENT_WORDS.ReopenFailed("the project is locked")));
  });

  it("a reopen that can't start blocks the start with why", async () => {
    const { ops } = goneUnreal(
      async () => {
        throw new Error("no Unreal 5.8 on this computer");
      },
      () => ({ state: ReopenState.Idle }),
    );
    const answer = await openForRun(ops);
    assert.equal(answer.block, MOMENT_WORDS.NotOpened("no Unreal 5.8 on this computer"));
  });
});
