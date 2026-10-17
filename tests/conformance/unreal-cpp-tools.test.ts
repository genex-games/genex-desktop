/**
 * C++ parts on the editor's side. `landPartCpp` brings a part's own C++ folder from a
 * builder's copy into the game's project before the editor queue hot-reloads it: plain headers
 * and sources only, that one folder replaced, nothing else touched, and a hostile folder (a link,
 * a file outside, another kind of file) copies nothing. The runner's `cpp-status` says whether this
 * computer compiles C++, the game's module and how adding it goes; `add-cpp-module` adds the module
 * in the background: saves the editor's work, quits Unreal, writes the module, builds it and opens
 * Unreal again, and on any failure says why and reopens an editor it closed. Unreal, UBT and time
 * are stand-ins; the module's files are written for real.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CppAddState as SeedCppAddState, readCppStatus } from "../../src/harness-seed/loop/unreal/cpp.ts";
import type { PluginContext, PluginHookContext } from "../../src/plugin-sdk/index.d.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { CppAddState, CppEditorTool, landPartCpp } from "../../src/plugins/unreal/cpp-tools.ts";
import { PortBlockedError } from "../../src/plugins/unreal/editor-log.ts";
import { LoopTool, type PartCode, PartRunState } from "../../src/plugins/unreal/editor-queue.ts";
import {
  type AnyLoopTool,
  createLoopTools,
  LiveLoopToolName,
  LoopToolName,
} from "../../src/plugins/unreal/loop-tools.ts";
import { CompileFailure, type CompileOptions, type CompileResult } from "../../src/plugins/unreal/ubt.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MODULE = "Rush";
const XCODE_APP = "/Applications/Xcode-26.2.app";
const BUILT: CompileResult = {
  ok: true,
  seconds: 31,
  errors: [],
  summary: "RushEditor built in 31 s.",
  retryable: false,
};
const BROKEN: CompileResult = {
  ok: false,
  seconds: 9,
  errors: [{ file: "Source/Rush/Rush.cpp", line: 3, column: 1, message: "unknown type name 'FStrin'" }],
  summary: "RushEditor didn't build (OtherCompilationError): 1 error.",
  failure: CompileFailure.Failed,
  retryable: false,
};
/** The Genex editor helper's answer once everything is saved. */
const SAVED = { saved: true, dirty: [], ms: 40 };
/** How long the stand-in Unreal takes to close after the quit, and to answer after it opens (8 s and 24 s). */
const QUIT_TAKES_MS = 8_000;
const OPEN_TAKES_MS = 24_000;
/** What add-cpp-module may wait at most for Unreal to close, and to answer once it opens. */
const QUIT_LIMIT_MS = 90_000;
const OPEN_LIMIT_MS = 300_000;
/** A stand-in Unreal that never gets there. */
const NEVER = Number.POSITIVE_INFINITY;
/** The game's own port for Epic's server. */
const GAME_PORT = 18_118;

/** Every file under `folder` with its text, by `/`-separated path; links and folders by their kind. */
async function treeOf(folder: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  const entries = await readdir(folder, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(folder, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) tree[key] = "link";
    else if (entry.isFile()) tree[key] = await readFile(full, "utf8");
    else tree[key] = entry.isDirectory() ? "folder" : "other";
  }
  return tree;
}

/** Settles a background job or a queued run: yields until `done` says so. */
async function until(done: () => Promise<boolean>) {
  for (let i = 0; i < 20_000; i++) {
    if (await done()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("never settled");
}

describe("landing a part's C++ in the game", () => {
  /** A game's project with its module and another part's code, a builder's copy holding Bike's code, a folder outside. */
  async function world() {
    const root = await realpath(await tmpDir("studio-land-cpp-"));
    const game = path.join(root, "game", "unreal");
    const copy = path.join(root, "copy");
    const outside = path.join(root, "outside");
    const source = path.join(copy, "unreal", "Source", MODULE, "Parts", "Bike");
    const landing = path.join(game, "Source", MODULE, "Parts", "Bike");
    await mkdir(path.join(game, "Source", MODULE, "Parts", "Lap"), { recursive: true });
    await mkdir(path.join(source, "Private"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(game, "Rush.uproject"), '{"Modules":[{"Name":"Rush","Type":"Runtime"}]}');
    await writeFile(path.join(game, "Source", MODULE, "Rush.Build.cs"), "public class Rush : ModuleRules {}\n");
    await writeFile(path.join(game, "Source", MODULE, "Parts", "Lap", "LapTimer.h"), "// Lap's own\n");
    await writeFile(path.join(source, "BikeCamera.h"), "UCLASS() class RUSH_API ABikeCamera : public AActor {};\n");
    await writeFile(path.join(source, "BikeCamera.cpp"), '#include "BikeCamera.h"\n');
    await writeFile(path.join(source, "Private", "BikeRig.cpp"), "// the rig\n");
    await writeFile(path.join(source, ".DS_Store"), "Finder");
    await writeFile(path.join(outside, "secret.h"), "// the owner's own file\n");
    const code: PartCode = { copy, project: path.join(game, "Rush.uproject"), module: MODULE, classes: ["BikeCamera"] };
    return { root, game, copy, outside, source, landing, code };
  }

  it("copies the part's headers and sources, one folder deep, into the game's Source and nothing else", async () => {
    const w = await world();
    const lap = await readFile(path.join(w.game, "Source", MODULE, "Parts", "Lap", "LapTimer.h"), "utf8");
    assert.deepEqual(await landPartCpp("Bike", w.code), ["BikeCamera.cpp", "BikeCamera.h", "Private/BikeRig.cpp"]);
    assert.deepEqual(await treeOf(w.landing), {
      "BikeCamera.cpp": '#include "BikeCamera.h"\n',
      "BikeCamera.h": "UCLASS() class RUSH_API ABikeCamera : public AActor {};\n",
      Private: "folder",
      "Private/BikeRig.cpp": "// the rig\n",
    });
    assert.equal(await readFile(path.join(w.game, "Source", MODULE, "Parts", "Lap", "LapTimer.h"), "utf8"), lap);
  });

  it("replaces the part's earlier files, so nothing stale is compiled", async () => {
    const w = await world();
    await mkdir(path.join(w.landing, "Old"), { recursive: true });
    await writeFile(path.join(w.landing, "BikeCamera.cpp"), "// the earlier try\n");
    await writeFile(path.join(w.landing, "Gone.cpp"), "// a class the part dropped\n");
    await writeFile(path.join(w.landing, "Old", "Gone.h"), "// gone too\n");
    await landPartCpp("Bike", w.code);
    assert.deepEqual(Object.keys(await treeOf(w.landing)).sort(), [
      "BikeCamera.cpp",
      "BikeCamera.h",
      "Private",
      "Private/BikeRig.cpp",
    ]);
    assert.equal(await readFile(path.join(w.landing, "BikeCamera.cpp"), "utf8"), '#include "BikeCamera.h"\n');
  });

  it("copies nothing when the copy is the game itself, and still refuses a hostile folder there", async () => {
    const w = await world();
    const game = path.dirname(w.game);
    await mkdir(w.landing, { recursive: true });
    await writeFile(path.join(w.landing, "BikeCamera.h"), "// in the game\n");
    const before = await treeOf(w.game);
    assert.deepEqual(await landPartCpp("Bike", { ...w.code, copy: game }), []);
    assert.deepEqual(await treeOf(w.game), before);
    await writeFile(path.join(w.landing, "Bike.mm"), "@interface Bike @end\n");
    await assert.rejects(landPartCpp("Bike", { ...w.code, copy: game }), /Bike\.mm/);
  });

  type World = Awaited<ReturnType<typeof world>>;
  const posix = process.platform !== "win32";
  const hostile: Array<[string, (w: World) => Promise<unknown>, { part?: string; code?: Partial<PartCode> }?]> = [
    ["no C++ folder in the copy", (w) => rm(w.source, { recursive: true })],
    [
      "a header that is a link to a file outside",
      (w) => symlink(path.join(w.outside, "secret.h"), path.join(w.source, "Link.h")),
    ],
    [
      "the part's folder linked to a folder outside",
      async (w) => {
        await rm(w.source, { recursive: true });
        await writeFile(path.join(w.outside, "Bike.h"), "// outside\n");
        await symlink(w.outside, w.source);
      },
    ],
    [
      "the copy's Source linked elsewhere",
      async (w) => {
        const real = path.join(w.root, "elsewhere-source");
        await rename(path.join(w.copy, "unreal", "Source"), real);
        await symlink(real, path.join(w.copy, "unreal", "Source"));
      },
    ],
    [
      "the copy's Parts folder linked elsewhere",
      async (w) => {
        const parts = path.dirname(w.source);
        const real = path.join(w.root, "elsewhere-parts");
        await rename(parts, real);
        await symlink(real, parts);
      },
    ],
    ["an Objective-C++ file", (w) => writeFile(path.join(w.source, "Bike.mm"), "@interface Bike @end\n")],
    ["a file that is neither a header nor a source", (w) => writeFile(path.join(w.source, "notes.txt"), "hi\n")],
    ["a file name C++ doesn't take", (w) => writeFile(path.join(w.source, "Bike-Camera.h"), "// dash\n")],
    [
      "a folder two deep",
      async (w) => {
        await mkdir(path.join(w.source, "Private", "Deep"), { recursive: true });
        await writeFile(path.join(w.source, "Private", "Deep", "Deep.h"), "// deep\n");
      },
    ],
    ["a subfolder that is a link", (w) => symlink(w.outside, path.join(w.source, "Public"))],
    [
      "more than 20 files",
      async (w) => {
        for (let i = 0; i < 20; i++) await writeFile(path.join(w.source, `Extra${i}.h`), "// extra\n");
      },
    ],
    ["a file over 200 KB", (w) => writeFile(path.join(w.source, "Huge.cpp"), `// ${"x".repeat(200 * 1024)}\n`)],
    [
      "the game's Source linked to a folder outside",
      async (w) => {
        const source = path.join(w.game, "Source");
        await rm(source, { recursive: true });
        await symlink(w.outside, source);
      },
    ],
    [
      "the game's part folder linked to a folder outside",
      async (w) => {
        await mkdir(path.dirname(w.landing), { recursive: true });
        await symlink(w.outside, w.landing);
      },
    ],
    [
      "the game's part folder holding a link",
      async (w) => {
        await mkdir(w.landing, { recursive: true });
        await symlink(path.join(w.outside, "secret.h"), path.join(w.landing, "BikeCamera.h"));
      },
    ],
    [
      "the game's part folder holding a file the part doesn't own",
      async (w) => {
        await mkdir(w.landing, { recursive: true });
        await writeFile(path.join(w.landing, "Bike.mm"), "@interface Bike @end\n");
      },
    ],
    [
      "a file where the game's Parts folder goes",
      async (w) => {
        await rm(path.dirname(w.landing), { recursive: true });
        await writeFile(path.dirname(w.landing), "not a folder\n");
      },
    ],
    ["a part name that is a path", async () => {}, { part: "../Lap" }],
    ["a module name that is a path", async () => {}, { code: { module: "../Rush" } }],
    ["a module name with a command", async () => {}, { code: { module: "Rush;rm" } }],
  ];
  if (posix)
    hostile.push([
      "a pipe named like a header",
      async (w) => {
        const made = spawnSync("mkfifo", [path.join(w.source, "Pipe.h")]);
        assert.equal(made.status, 0, String(made.stderr));
      },
    ]);
  for (const [label, make, input] of hostile) {
    it(`copies nothing with ${label}`, async () => {
      const w = await world();
      await make(w);
      const before = await treeOf(w.game);
      const outside = await treeOf(w.outside);
      await assert.rejects(landPartCpp(input?.part ?? "Bike", { ...w.code, ...input?.code }));
      assert.deepEqual(await treeOf(w.game), before, "the game's project is as it was");
      assert.deepEqual(await treeOf(w.outside), outside, "the folder outside is as it was");
    });
  }
});

type Editor = {
  /** Whether an editor process runs, and whether this game's answers. */
  running: boolean;
  answering: boolean;
  /** When a quit started, and when an open started; the stand-in gets there after its time. */
  quitAt?: number;
  openAt?: number;
  /** Its log says Epic's server couldn't listen on the game's port, so it never answers. */
  portBlocked?: boolean;
};
type Options = {
  platform?: NodeJS.Platform;
  xcode?: XcodeState;
  /** The project's own module, or none (a Blueprint project). */
  module?: boolean;
  /** Whether Unreal is open on this game when the test starts (default), or closed. */
  open?: boolean;
  quitTakes?: number;
  openTakes?: number;
  save?: () => unknown;
  compile?: (options: CompileOptions) => CompileResult;
  /** No linked project for the game. */
  unlinked?: boolean;
  /** Runs as Unreal is asked to quit. */
  onQuit?: () => Promise<unknown>;
  /** The reopened Unreal couldn't listen on the game's port: the old run's sockets still held it. */
  portBlockedOnOpen?: boolean;
  /** UBT's build goes on until this settles. */
  building?: Promise<unknown>;
};

/** A Blueprint game (or one with its module) open in a stand-in Unreal, through the Loop's tools. */
async function cppWorld(options: Options = {}) {
  const root = await realpath(await tmpDir("studio-cpp-tools-"));
  const game = path.join(root, "game");
  const unreal = path.join(game, "unreal");
  const storage = path.join(root, "storage");
  const engineDir = path.join(root, "engine");
  const projectFile = path.join(unreal, "Rush.uproject");
  await mkdir(unreal, { recursive: true });
  await mkdir(storage, { recursive: true });
  await mkdir(engineDir, { recursive: true });
  const modules = options.module ? { Modules: [{ Name: MODULE, Type: "Runtime", LoadingPhase: "Default" }] } : {};
  await writeFile(
    projectFile,
    `${JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8", ...modules }, null, "\t")}\n`,
  );
  const events: string[] = [];
  const compiles: CompileOptions[] = [];
  const clock = { at: 0 };
  const quitTakes = options.quitTakes ?? QUIT_TAKES_MS;
  const openTakes = options.openTakes ?? OPEN_TAKES_MS;
  const open = options.open ?? true;
  const editor: Editor = { running: open, answering: open };
  // The stand-in Unreal moves on with the clock: it closes after a quit, and answers after an open.
  const settle = () => {
    if (editor.quitAt !== undefined && clock.at >= editor.quitAt + quitTakes) {
      Object.assign(editor, { running: false, answering: false, quitAt: undefined });
    }
    if (editor.openAt !== undefined && clock.at >= editor.openAt + openTakes) {
      Object.assign(editor, { running: true, answering: true, openAt: undefined });
    }
  };
  const editorCall = async (_storage: string, _game: string, tool: AnyLoopTool, _args: Record<string, unknown>) => {
    events.push(tool);
    if (tool === CppEditorTool.SaveAll) return options.save ? options.save() : SAVED;
    throw new Error(`no stand-in for ${tool}`);
  };
  const tools = createLoopTools({
    platform: options.platform ?? "darwin",
    engine: async () => ({ version: "5.8", directory: engineDir }),
    project: async () => (options.unlinked ? undefined : projectFile),
    xcode: async () => ({ state: options.xcode ?? XcodeState.Ready, app: XCODE_APP }),
    compile: async (compile) => {
      events.push("compile");
      compiles.push(compile);
      assert.equal(editor.running, false, "UBT builds the game's module only with Unreal closed");
      await options.building;
      return options.compile ? options.compile(compile) : BUILT;
    },
    editorCall,
    editorAnswers: async () => {
      settle();
      if (editor.portBlocked) throw new PortBlockedError(GAME_PORT);
      return editor.answering;
    },
    restart: {
      editors: async () => {
        settle();
        return editor.running ? 1 : 0;
      },
      quit: async (_storage, project) => {
        events.push(`quit ${path.basename(project)}`);
        await options.onQuit?.();
        editor.quitAt = clock.at;
        editor.answering = false;
      },
      open: async (_storage, project) => {
        events.push(`open ${path.basename(project)}`);
        editor.running = true;
        if (options.portBlockedOnOpen) editor.portBlocked = true;
        else editor.openAt = clock.at;
      },
    },
    now: () => clock.at,
    sleep: async (ms) => {
      clock.at += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const context: PluginContext = {
    project: "rush",
    directory: game,
    signal: new AbortController().signal,
    callId: 1,
    host: (async () => storage) as never,
  };
  const status = async () =>
    (await tools.call(LoopToolName.CppStatus, {}, context, storage)) as {
      canCompile: boolean;
      xcode: string;
      platform: string;
      module: string | null;
      adding: { state: string; error?: string; seconds?: number };
    };
  const add = () => tools.call(LoopToolName.AddCppModule, {}, context, storage);
  /** The add job's end, once it is no longer adding. */
  const added = async () => {
    await until(async () => (await status()).adding.state !== CppAddState.Adding);
    return (await status()).adding;
  };
  /** A tool called at one of Genex's moments. */
  const atMoment = (name: string, hook: PluginHookContext) =>
    tools.call(name as LoopToolName, {}, { ...context, hook }, storage);
  return { root, game, unreal, projectFile, engineDir, events, compiles, clock, editor, status, add, added, atMoment };
}

describe("cpp-status", () => {
  it("says this Mac compiles C++, names no module for a Blueprint game, and that nothing is being added", async () => {
    const w = await cppWorld();
    const answer = await w.status();
    assert.deepEqual(answer, {
      canCompile: true,
      xcode: XcodeState.Ready,
      platform: "darwin",
      module: null,
      adding: { state: CppAddState.Idle },
    });
    assert.deepEqual(readCppStatus(answer), answer, "the Loop's runner reads it as it is");
    assert.deepEqual(SeedCppAddState, CppAddState, "the runner names the same states");
  });

  it("names the game's module once it has one", async () => {
    const w = await cppWorld({ module: true });
    assert.equal((await w.status()).module, MODULE);
  });

  const cannot: Array<[string, Options, string]> = [
    ["off a Mac", { platform: "win32", xcode: XcodeState.NotApplicable }, XcodeState.NotApplicable],
    ["before Xcode's first launch", { xcode: XcodeState.FirstLaunch }, XcodeState.FirstLaunch],
    ["without Xcode", { xcode: XcodeState.Missing }, XcodeState.Missing],
  ];
  for (const [when, options, xcode] of cannot) {
    it(`says no ${when}`, async () => {
      const answer = await (await cppWorld(options)).status();
      assert.equal(answer.canCompile, false);
      assert.equal(answer.xcode, xcode);
    });
  }

  it("names no module for a game without a linked project", async () => {
    assert.equal((await (await cppWorld({ unlinked: true })).status()).module, null);
  });
});

describe("add-cpp-module", () => {
  it("answers the module at once when the game has one, touching nothing", async () => {
    const w = await cppWorld({ module: true });
    const before = await treeOf(w.unreal);
    assert.deepEqual(await w.add(), { module: MODULE, already: true });
    assert.deepEqual(w.events, []);
    assert.deepEqual(await treeOf(w.unreal), before);
  });

  for (const [when, options] of [
    ["off a Mac", { platform: "win32", xcode: XcodeState.NotApplicable }],
    ["without a ready Xcode", { xcode: XcodeState.FirstLaunch }],
  ] as const) {
    it(`refuses ${when} and starts nothing`, async () => {
      const w = await cppWorld(options);
      const before = await treeOf(w.unreal);
      await assert.rejects(w.add(), /C\+\+/);
      assert.deepEqual(w.events, []);
      assert.deepEqual(await treeOf(w.unreal), before);
      assert.equal((await w.status()).adding.state, CppAddState.Idle);
    });
  }

  it("refuses a game without a linked project", async () => {
    await assert.rejects((await cppWorld({ unlinked: true })).add(), /project/);
  });

  it("answers started at once, then saves, quits Unreal, writes and builds the module, and opens Unreal again", async () => {
    const w = await cppWorld();
    assert.deepEqual(await w.add(), { started: true });
    assert.equal((await w.status()).adding.state, CppAddState.Adding);
    const end = await w.added();
    assert.equal(end.state, CppAddState.Done, end.error);
    assert.deepEqual(w.events, [CppEditorTool.SaveAll, "quit Rush.uproject", "compile", "open Rush.uproject"]);
    assert.equal(end.seconds, Math.round(w.clock.at / 1000));
    assert.ok(w.clock.at >= QUIT_TAKES_MS + OPEN_TAKES_MS, "it waited for Unreal to close and to answer again");
    assert.equal(w.editor.answering, true);
    assert.equal((await w.status()).module, MODULE);
    assert.ok(existsSync(path.join(w.unreal, "Source", MODULE, `${MODULE}.Build.cs`)));
    assert.deepEqual(
      w.compiles.map((c) => [c.engineDir, c.projectFile, c.module, c.xcodeApp]),
      [[w.engineDir, w.projectFile, MODULE, XCODE_APP]],
    );
    assert.deepEqual(await w.add(), { module: MODULE, already: true }, "a second call finds it");
  });

  it("restarts Unreal as Genex's own: a health look meanwhile is no crash, and the crash steps start no second editor or build", async () => {
    let built: (value?: unknown) => void = () => {};
    const w = await cppWorld({ building: new Promise((resolve) => (built = resolve)) });
    assert.deepEqual(await w.add(), { started: true });
    await until(async () => w.events.includes("compile"));
    assert.equal(w.editor.running, false, "Unreal is closed while the module builds");
    const health = (await w.atMoment(LoopToolName.EditorState, { on: HookEvent.Health, runId: "run-7" })) as {
      block?: string;
      pending?: string;
    };
    assert.equal(health.block, undefined, `no crash: ${health.block}`);
    assert.ok(health.pending, "it says Unreal is coming back");
    await w.atMoment(LoopToolName.ReopenEditor, { on: HookEvent.Crash, runId: "run-7" });
    // A rewind's restore steps meanwhile end nothing: Genex itself is restarting this Unreal.
    const ended = await w.atMoment(LiveLoopToolName.EndEditor, { on: HookEvent.RestoreBefore, runId: "run-7" }).then(
      (answer) => JSON.stringify(answer),
      (err: Error) => `refused: ${err.message}`,
    );
    assert.match(ended, /reopening this game's Unreal/, ended);
    built();
    assert.equal((await w.added()).state, CppAddState.Done);
    assert.deepEqual(w.events, [CppEditorTool.SaveAll, "quit Rush.uproject", "compile", "open Rush.uproject"]);
  });

  it("adds once when asked again while it is adding", async () => {
    const w = await cppWorld();
    assert.deepEqual(await w.add(), { started: true });
    assert.deepEqual(await w.add(), { started: true });
    assert.equal((await w.added()).state, CppAddState.Done);
    assert.deepEqual(
      w.events.filter((e) => e === "compile"),
      ["compile"],
    );
  });

  it("with Unreal closed, writes and builds the module without quitting anything, then opens Unreal", async () => {
    const w = await cppWorld({ open: false });
    await w.add();
    assert.equal((await w.added()).state, CppAddState.Done);
    assert.deepEqual(w.events, ["compile", "open Rush.uproject"]);
  });

  const unsaved: Array<[string, () => unknown]> = [
    ["the helper refuses", () => ({ error: "A play session is running; stop it first (stop_play)." })],
    [
      "the call fails",
      () => {
        throw new Error("Unreal isn't answering.");
      },
    ],
    ["work stays unsaved", () => ({ saved: false, dirty: ["/Game/Maps/Track"], ms: 30 })],
    ["the answer isn't the helper's", () => "Traceback (most recent call last)"],
  ];
  for (const [when, save] of unsaved) {
    it(`never quits Unreal when ${when}, and fails saying so`, async () => {
      const w = await cppWorld({ save });
      const before = await treeOf(w.unreal);
      await w.add();
      const end = await w.added();
      assert.equal(end.state, CppAddState.Failed);
      assert.match(end.error ?? "", /sav/);
      assert.deepEqual(w.events, [CppEditorTool.SaveAll]);
      assert.equal(w.editor.answering, true, "Unreal stays open");
      assert.deepEqual(await treeOf(w.unreal), before);
    });
  }

  it("waits at most 90 s for Unreal to close, then fails and writes nothing", async () => {
    const w = await cppWorld({ quitTakes: NEVER });
    const before = await treeOf(w.unreal);
    await w.add();
    const end = await w.added();
    assert.equal(end.state, CppAddState.Failed);
    assert.match(end.error ?? "", /close/);
    assert.ok(w.clock.at >= QUIT_LIMIT_MS && w.clock.at < QUIT_LIMIT_MS + 10_000, `waited ${w.clock.at} ms`);
    assert.deepEqual(w.events, [CppEditorTool.SaveAll, "quit Rush.uproject"]);
    assert.deepEqual(await treeOf(w.unreal), before);
  });

  it("quits nothing while another editor runs and this game's doesn't answer", async () => {
    const w = await cppWorld();
    w.editor.answering = false;
    const before = await treeOf(w.unreal);
    await w.add();
    const end = await w.added();
    assert.equal(end.state, CppAddState.Failed);
    assert.match(end.error ?? "", /Unreal/);
    assert.deepEqual(w.events, []);
    assert.deepEqual(await treeOf(w.unreal), before);
  });

  it("takes the module back out when it doesn't build, and opens Unreal again", async () => {
    const w = await cppWorld({ compile: () => BROKEN });
    const project = await readFile(w.projectFile, "utf8");
    const before = await treeOf(w.unreal);
    await w.add();
    const end = await w.added();
    assert.equal(end.state, CppAddState.Failed);
    assert.match(end.error ?? "", /didn't build/);
    assert.match(end.error ?? "", /FStrin/);
    assert.equal(await readFile(w.projectFile, "utf8"), project, "the project file is as it was");
    assert.deepEqual(await treeOf(w.unreal), before, "no module files are left");
    assert.deepEqual(w.events.slice(-1), ["open Rush.uproject"]);
    assert.equal(w.editor.answering, true);
  });

  it("refuses a project that can't take the module before touching Unreal", async () => {
    const w = await cppWorld();
    await mkdir(path.join(w.unreal, "Source", "Other"), { recursive: true });
    const before = await treeOf(w.unreal);
    await assert.rejects(w.add(), /already has the C\+\+ module Other/);
    assert.deepEqual(w.events, []);
    assert.deepEqual(await treeOf(w.unreal), before);
    assert.equal((await w.status()).adding.state, CppAddState.Idle);
  });

  it("fails with the refusal when the project changed while Unreal quit, writes nothing and opens Unreal again", async () => {
    let unreal = "";
    const w = await cppWorld({ onQuit: () => mkdir(path.join(unreal, "Source", "Other"), { recursive: true }) });
    unreal = w.unreal;
    await w.add();
    const end = await w.added();
    assert.equal(end.state, CppAddState.Failed);
    assert.match(end.error ?? "", /already has the C\+\+ module Other/);
    assert.equal(existsSync(path.join(w.unreal, "Source", MODULE)), false);
    assert.deepEqual(w.events, [CppEditorTool.SaveAll, "quit Rush.uproject", "open Rush.uproject"]);
    assert.equal(w.editor.answering, true);
  });

  it("fails when Unreal doesn't answer within 5 minutes of opening; the built module stays", async () => {
    const w = await cppWorld({ openTakes: NEVER });
    await w.add();
    const end = await w.added();
    assert.equal(end.state, CppAddState.Failed);
    assert.match(end.error ?? "", /answer/);
    const opened = QUIT_TAKES_MS + OPEN_LIMIT_MS;
    assert.ok(w.clock.at >= opened && w.clock.at < opened + 10_000, `waited ${w.clock.at} ms`);
    assert.equal((await w.status()).module, MODULE);
  });

  it("stops waiting at once when the reopened Unreal couldn't listen on the game's port", async () => {
    const w = await cppWorld({ portBlockedOnOpen: true });
    await w.add();
    const end = await w.added();
    assert.equal(end.state, CppAddState.Failed);
    assert.match(end.error ?? "", new RegExp(`port ${GAME_PORT}`));
    assert.ok(w.clock.at < QUIT_TAKES_MS + OPEN_TAKES_MS, `waited ${w.clock.at} ms, not the 5 minutes`);
    assert.equal((await w.status()).module, MODULE, "the built module stays");
  });

  it("can be tried again after a failure", async () => {
    let saves = 0;
    const w = await cppWorld({ save: () => (++saves === 1 ? { error: "busy" } : SAVED) });
    await w.add();
    assert.equal((await w.added()).state, CppAddState.Failed);
    assert.deepEqual(await w.add(), { started: true });
    assert.equal((await w.added()).state, CppAddState.Done);
  });
});

describe("run-part on a C++ part", () => {
  const PART = {
    title: "Bike camera",
    goal: "The camera rides the bike.",
    cpp: ["BikeCamera"],
    blueprints: [{ name: "BP_BikeCamera", parent: "BikeCamera" }],
  };
  const HEADER = "UCLASS()\nclass RUSH_API ABikeCamera : public AActor\n{\n\tGENERATED_BODY()\n};\n";

  /** The game with its module and Bike's files, a builder's copy of it, and a stand-in editor for the queue. */
  async function partWorld() {
    const root = await realpath(await tmpDir("studio-run-cpp-"));
    const storage = path.join(root, "storage");
    await mkdir(storage, { recursive: true });
    const write = async (dir: string) => {
      const unreal = path.join(dir, "unreal");
      const part = path.join(unreal, "parts", "Bike");
      const cpp = path.join(unreal, "Source", MODULE, "Parts", "Bike");
      await mkdir(part, { recursive: true });
      await mkdir(cpp, { recursive: true });
      await writeFile(
        path.join(unreal, "Rush.uproject"),
        JSON.stringify({ Modules: [{ Name: MODULE, Type: "Runtime" }] }),
      );
      await writeFile(path.join(unreal, "Source", MODULE, "Rush.Build.cs"), "public class Rush : ModuleRules {}\n");
      await writeFile(path.join(part, "part.json"), JSON.stringify(PART));
      await writeFile(path.join(part, "test.json"), JSON.stringify({ steps: [{ wait: 1 }] }));
      await writeFile(path.join(part, "apply.py"), "genex.save()\n");
      await writeFile(path.join(cpp, "BikeCamera.h"), HEADER);
      await writeFile(path.join(cpp, "BikeCamera.cpp"), '#include "BikeCamera.h"\n');
    };
    const game = path.join(root, "game");
    const copy = path.join(root, "copy");
    await write(game);
    await write(copy);
    const calls: Array<[AnyLoopTool, Record<string, unknown>, number | undefined]> = [];
    const state = { pie: false };
    const clock = { at: 0 };
    // The editor as the queue meets it: a hot reload that goes well, and a play session that starts and stops.
    const answers: Partial<Record<AnyLoopTool, () => unknown>> = {
      [LoopTool.RecompileModule]: () => ({ ok: true, compiled: true, ms: 13_700, missing: [], log: [] }),
      [LoopTool.ApplyPart]: () => ({ ok: true }),
      [LoopTool.StartPlay]: () => {
        state.pie = true;
        return true;
      },
      [LoopTool.StopPlay]: () => {
        state.pie = false;
        return { stopping: true };
      },
      [LoopTool.PlayState]: () => ({ pie: state.pie }),
      [LoopTool.EditorActivity]: () => ({ camera: [0], selection: [], dirty: [], pie: false }),
    };
    const tools = createLoopTools({
      platform: "darwin",
      engine: async () => ({ version: "5.8", directory: path.join(root, "engine") }),
      project: async () => path.join(game, "unreal", "Rush.uproject"),
      xcode: async () => ({ state: XcodeState.Ready, app: XCODE_APP }),
      compile: async () => {
        throw new Error("run-part never compiles");
      },
      editorCall: async (_storage, _game, tool, args, timeoutMs) => {
        calls.push([tool, args, timeoutMs]);
        return answers[tool]?.() ?? {};
      },
      editorAnswers: async () => true,
      restart: {
        editors: async () => 1,
        quit: async () => {},
        open: async () => {},
      },
      now: () => clock.at,
      sleep: async (ms) => {
        clock.at += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    const context = (directory: string): PluginContext => ({
      project: "rush",
      directory,
      signal: new AbortController().signal,
      callId: 1,
      host: (async () => storage) as never,
    });
    const run = async (directory: string) => {
      const queued = (await tools.call(LoopToolName.RunPart, { part: "Bike" }, context(directory), storage)) as {
        id: string;
      };
      let result: { state: string; error?: string } | undefined;
      await until(async () => {
        result = (await tools.call(LoopToolName.PartResult, { id: queued.id }, context(directory), storage)) as {
          state: string;
        };
        return result.state === PartRunState.Done || result.state === PartRunState.Failed;
      });
      return result;
    };
    return { game, copy, calls, run };
  }

  it("hot-reloads the game's module with the part's classes, waiting minutes, before applying the part", async () => {
    const w = await partWorld();
    const result = await w.run(w.game);
    assert.equal(result?.state, PartRunState.Done, result?.error);
    const tools = w.calls.map(([tool]) => tool);
    assert.ok(tools.indexOf(LoopTool.RecompileModule) < tools.indexOf(LoopTool.ApplyPart));
    const recompile = w.calls.find(([tool]) => tool === LoopTool.RecompileModule);
    assert.deepEqual(recompile?.[1], { module: MODULE, classes: ["BikeCamera"] });
    assert.ok((recompile?.[2] ?? 0) >= OPEN_LIMIT_MS, "a hot reload waits at least five minutes");
  });

  it("brings the part's code from a builder's copy into the game first", async () => {
    const w = await partWorld();
    const changed = '#include "BikeCamera.h"\n// the builder\'s change\n';
    await writeFile(path.join(w.copy, "unreal", "Source", MODULE, "Parts", "Bike", "BikeCamera.cpp"), changed);
    const result = await w.run(w.copy);
    assert.equal(result?.state, PartRunState.Done, result?.error);
    const landed = path.join(w.game, "unreal", "Source", MODULE, "Parts", "Bike", "BikeCamera.cpp");
    assert.equal(await readFile(landed, "utf8"), changed);
  });
});
