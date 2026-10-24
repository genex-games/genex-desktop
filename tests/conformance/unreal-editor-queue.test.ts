/**
 * The editor queue: the one visible editor takes one part at a time — apply it, play its test,
 * take play shots, stop play — and hands back what it saw. It waits while Unreal doesn't answer
 * (a crash, a restart) and while the person works in the editor, and it always stops a play session
 * it started. A C++ part's code is copied into the game and hot-reloaded before anything is
 * applied. Time and the editor are stand-ins here.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { landPartCpp } from "../../src/plugins/unreal/cpp-tools.ts";
import {
  createEditorQueue,
  LoopTool,
  type PartCode,
  PartProbe,
  PartRunFailure,
  PartRunState,
  type PlayCheckJob,
  type PlayCheckResult,
  PlayCheckShot,
  type QueueDeps,
} from "../../src/plugins/unreal/editor-queue.ts";
import { parsePartTest } from "../../src/plugins/unreal/part-test.ts";
import { tmpDir } from "../helpers/tmp.ts";
import {
  crashableEditor,
  deps,
  never,
  playable,
  runLantern,
  sequence,
  settled,
  standIn,
  TEST,
  THROTTLE,
  written,
} from "../helpers/unreal-editor-stand-in.ts";

/** What the queue's copy of a C++ part is recorded as, in order with the editor's calls. */
const COPY = "copy";

describe("the editor queue", () => {
  it("applies a part, plays its test, takes its shots, checks what the game shows, and stops play", async () => {
    const editor = standIn();
    const queue = createEditorQueue(deps(editor.port));
    const id = queue.enqueue({
      game: "valley",
      part: "Lantern",
      script: "/g/unreal/parts/Lantern/apply.py",
      test: TEST,
    });
    const run = await settled(queue, id);
    assert.equal(run.state, PartRunState.Done);
    assert.deepEqual(
      editor.calls
        .map(([tool]) => tool)
        .filter((tool) => tool !== LoopTool.EditorActivity && tool !== LoopTool.PlayState),
      [
        LoopTool.ApplyPart,
        LoopTool.GetProperties,
        LoopTool.SearchCVars,
        LoopTool.SetProperties,
        LoopTool.StartPlay,
        LoopTool.Hold,
        LoopTool.CapturePlay,
        LoopTool.GameState,
        LoopTool.GameState,
        LoopTool.ProbeCharacters,
        LoopTool.ProbeView,
        LoopTool.StopPlay,
        LoopTool.SetProperties,
      ],
    );
    assert.deepEqual(run.result?.shots, [
      { name: "walk", file: "/p/Saved/Genex/captures/walk.png", data: "png:/p/Saved/Genex/captures/walk.png" },
    ]);
    assert.deepEqual(
      run.result?.checks.map((c) => c.passed),
      [true, false],
      "the actor is there; the player is slower than the test wanted",
    );
    assert.equal(editor.state.pie, false, "play is stopped");
  });

  it("probes every pawn and the player's view after the test steps, while still playing, and hands them back", async () => {
    const editor = standIn();
    const queue = createEditorQueue(deps(editor.port));
    const run = await settled(queue, queue.enqueue({ game: "valley", part: "Lantern", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Done);
    assert.deepEqual(run.result?.probes, {
      [PartProbe.Characters]: { pawns: [{ label: "Car_0", gapCm: 0 }], more: 0, part: "" },
      [PartProbe.View]: { meshes: [{ component: "Handlebar", clipping: false }] },
    });
  });

  it("records a probe that fails or refuses, and the part still finishes with play stopped", async () => {
    const editor = standIn({
      [LoopTool.ProbeCharacters]: () => {
        throw new Error("connection reset");
      },
      [LoopTool.ProbeView]: () => ({ error: "The probe could not read the play session.", detail: "AttributeError" }),
    });
    const queue = createEditorQueue(deps(editor.port));
    const run = await settled(queue, queue.enqueue({ game: "valley", part: "Lantern", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Done);
    assert.deepEqual(run.result?.probes, {
      [PartProbe.Characters]: { error: "connection reset" },
      [PartProbe.View]: { error: "The probe could not read the play session.", detail: "AttributeError" },
    });
    assert.equal(run.result?.shots.length, 1);
    assert.equal(editor.state.pie, false, "play is stopped");
  });

  it("fails a part whose script fails, without playing it", async () => {
    const editor = standIn({ [LoopTool.ApplyPart]: () => ({ ok: false, error: "NameError: x", traceback: "..." }) });
    const queue = createEditorQueue(deps(editor.port));
    const run = await settled(queue, queue.enqueue({ game: "valley", part: "Lantern", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Failed);
    assert.match(run.error ?? "", /NameError/);
    assert.equal(
      editor.calls.some(([tool]) => tool === LoopTool.StartPlay),
      false,
    );
  });

  it("stops play even when a step fails mid-test", async () => {
    const editor = standIn({
      [LoopTool.Hold]: () => {
        throw new Error("connection reset");
      },
    });
    const queue = createEditorQueue(deps(editor.port));
    const run = await settled(queue, queue.enqueue({ game: "valley", part: "Lantern", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Failed);
    assert.ok(editor.calls.some(([tool]) => tool === LoopTool.StopPlay));
  });

  it("waits while Unreal doesn't answer, then carries on", async () => {
    const editor = standIn();
    editor.state.answering = false;
    const d = deps(editor.port);
    const queue = createEditorQueue(d);
    const id = queue.enqueue({ game: "valley", part: "Lantern", script: "/s", test: TEST });
    for (let i = 0; i < 20 && queue.status(id)?.state !== PartRunState.Waiting; i++)
      await new Promise((r) => setImmediate(r));
    assert.equal(queue.status(id)?.waitingFor, "editor");
    editor.state.answering = true;
    assert.equal((await settled(queue, id)).state, PartRunState.Done);
  });

  it("waits while the person works in the editor", async () => {
    const editor = standIn();
    let reads = 0;
    const busy = standIn({
      [LoopTool.EditorActivity]: () => {
        reads++;
        // The camera moves on the first reads: the person is working; then it stays still.
        return { camera: [0, 0, reads < 4 ? reads : 9], selection: [], dirty: [], pie: false };
      },
    });
    const d = deps(busy.port);
    const queue = createEditorQueue(d);
    const run = await settled(queue, queue.enqueue({ game: "valley", part: "Lantern", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Done);
    assert.ok(reads >= 4, "it looked again until the editor was still");
    assert.equal(editor.calls.length, 0);
  });

  it("runs one part at a time, in order", async () => {
    const editor = standIn();
    const queue = createEditorQueue(deps(editor.port));
    const a = queue.enqueue({ game: "valley", part: "A", script: "/a", test: TEST });
    const b = queue.enqueue({ game: "valley", part: "B", script: "/b", test: TEST });
    await settled(queue, b);
    const applied = editor.calls.filter(([tool]) => tool === LoopTool.ApplyPart).map(([, args]) => args.part);
    assert.deepEqual(applied, ["A", "B"]);
    assert.equal(queue.status(a)?.state, PartRunState.Done);
  });
});

describe("the editor queue's play tests run unthrottled", () => {
  it("turns the editor's background throttle off before play starts and gives it back after play stops", async () => {
    const editor = standIn();
    const run = await runLantern(editor.port);
    assert.equal(run.state, PartRunState.Done);
    assert.equal(editor.state.throttleAtPlay, false, "a background editor would otherwise play at a few frames/s");
    assert.equal(editor.state.throttle, true, "the editor has its setting back");
    assert.deepEqual(written(editor.calls), [false, true]);
    const tools = sequence(editor.calls);
    assert.ok(tools.indexOf(LoopTool.SetProperties) < tools.indexOf(LoopTool.StartPlay), "lifted before play");
    assert.ok(tools.lastIndexOf(LoopTool.SetProperties) > tools.indexOf(LoopTool.StopPlay), "given back after play");
  });

  const failures: Array<[string, Partial<Record<string, (args: Record<string, unknown>) => unknown>>]> = [
    [
      "a step throws mid-test",
      {
        [LoopTool.Hold]: () => {
          throw new Error("connection reset");
        },
      },
    ],
    ["play never starts", { [LoopTool.StartPlay]: () => true }],
    [
      "a shot never appears",
      { [LoopTool.CapturePlay]: () => ({ queued: true, file: "/p/Saved/Genex/captures/missing.png" }) },
    ],
  ];
  for (const [when, overrides] of failures) {
    it(`gives the throttle back after stopping play when ${when}`, async () => {
      const editor = standIn(overrides);
      const run = await runLantern(editor.port);
      assert.equal(run.state, PartRunState.Failed);
      assert.equal(editor.state.throttle, true);
      assert.deepEqual(written(editor.calls), [false, true]);
      assert.deepEqual(sequence(editor.calls).slice(-2), [LoopTool.StopPlay, LoopTool.SetProperties]);
    });
  }

  // UE 5.8 on a Mac hangs the GPU rendering a ray-traced level at full speed behind another app.
  it("on a Mac, plays a ray-traced editor throttled, and lifts the throttle everywhere else", async () => {
    for (const [platform, lifted] of [
      ["darwin", false],
      ["linux", true],
      ["win32", true],
    ] as const) {
      const editor = standIn();
      editor.state.rayTracing = true;
      const run = await runLantern(editor.port, platform);
      assert.equal(run.state, PartRunState.Done, platform);
      assert.equal(editor.state.throttleAtPlay, !lifted, platform);
      assert.equal(editor.state.throttle, true, platform);
    }
  });

  it("on a Mac, lifts the throttle of an editor without ray tracing, and keeps it when the editor can't say", async () => {
    const plain = standIn();
    await runLantern(plain.port, "darwin");
    assert.equal(plain.state.throttleAtPlay, false, "no ray tracing: full speed");
    const silent = standIn({
      [LoopTool.SearchCVars]: () => {
        throw new Error("connection reset");
      },
    });
    const run = await runLantern(silent.port, "darwin");
    assert.equal(run.state, PartRunState.Done);
    assert.equal(silent.state.throttleAtPlay, true, "unknown: kept, as for ray tracing");
    assert.deepEqual(written(silent.calls), []);
  });

  it("leaves a throttle that is already off alone (the user's choice, or the bridge's own play session)", async () => {
    const editor = standIn();
    editor.state.throttle = false;
    const run = await runLantern(editor.port);
    assert.equal(run.state, PartRunState.Done);
    assert.deepEqual(written(editor.calls), []);
    assert.equal(editor.state.throttle, false);
  });

  const unreadable: Array<[string, () => unknown]> = [
    [
      "the read throws",
      () => {
        throw new Error("connection reset");
      },
    ],
    ["the read answers an error", () => ({ error: "No object at that path." })],
    ["the read answers text that is not JSON", () => "Traceback (most recent call last)"],
    ["the read answers JSON text that is not an object", () => "true"],
    ["the setting is not a boolean", () => ({ [THROTTLE]: "yes" })],
  ];
  for (const [when, read] of unreadable) {
    it(`plays the test anyway and writes nothing when ${when}`, async () => {
      const editor = standIn({ [LoopTool.GetProperties]: read });
      const run = await runLantern(editor.port);
      assert.equal(run.state, PartRunState.Done);
      assert.deepEqual(written(editor.calls), []);
      assert.equal(editor.state.throttle, true, "the setting is untouched");
      assert.equal(editor.state.pie, false, "play is stopped");
    });
  }

  it("plays the test when the editor refuses to turn the throttle off, and leaves it on", async () => {
    const editor = standIn({
      [LoopTool.SetProperties]: (a) => {
        const on = (JSON.parse(String(a.values)) as Record<string, unknown>)[THROTTLE];
        if (on === false) throw new Error("set_properties failed");
        editor.state.throttle = on === true;
        return true;
      },
    });
    const run = await runLantern(editor.port);
    assert.equal(run.state, PartRunState.Done);
    assert.equal(editor.state.throttleAtPlay, true);
    assert.equal(editor.state.throttle, true);
  });

  it("finishes the part when giving the throttle back fails", async () => {
    const editor = standIn({
      [LoopTool.SetProperties]: (a) => {
        const on = (JSON.parse(String(a.values)) as Record<string, unknown>)[THROTTLE];
        if (on === true) throw new Error("connection reset");
        editor.state.throttle = false;
        return true;
      },
    });
    const run = await runLantern(editor.port);
    assert.equal(run.state, PartRunState.Done);
    assert.equal(run.result?.shots.length, 1);
  });
});

/** A C++ part's code as run-part hands it over: the builder's copy, the game's project, its module and classes. */
const CODE: PartCode = {
  copy: "/copies/bike",
  project: "/g/unreal/Rush.uproject",
  module: "Rush",
  classes: ["BikeCamera", "BikeRig"],
};
/** Unreal's hot reload as the helper answers a compile error: the editor's log lines, absolute paths and all. */
const NOT_COMPILED = {
  ok: false,
  compiled: false,
  ms: 3_700,
  missing: [],
  log: [
    "LogHotReload: Recompiling module Rush...",
    "/Users/owner/AI Games/rush/unreal/Source/Rush/Parts/Bike/BikeCamera.cpp:5:3: error: unknown type name 'FStrin'; did you mean 'FString'?",
    "~/AI Games/rush/unreal/Source/Rush/Parts/Bike/BikeRig.h:9:1: error: expected ';' after class",
    "In file included from /Users/owner/Library/Engine/Source/Runtime/Core/Public/CoreMinimal.h:4:",
    "1 error generated.",
  ],
};
/** A hot reload takes well under a minute; the queue waits far longer than any. */
const MIN_RECOMPILE_TIMEOUT_MS = 300_000;

/** A queue whose copies are recorded in order with the editor's calls; `copy` stands in for the real one. */
function codeQueue(editor: ReturnType<typeof standIn>, copy: QueueDeps["landCpp"] = async () => {}) {
  return createEditorQueue(
    deps(editor.port, undefined, async (part, code) => {
      editor.calls.push([COPY, { part, ...code }]);
      await copy(part, code);
    }),
  );
}

async function runBike(editor: ReturnType<typeof standIn>, copy?: QueueDeps["landCpp"]) {
  const queue = codeQueue(editor, copy);
  return settled(queue, queue.enqueue({ game: "valley", part: "Bike", script: "/s", test: TEST, cpp: CODE }));
}

describe("a C++ part in the editor queue", () => {
  it("copies the part's code into the game and hot-reloads the module before applying and playing it", async () => {
    const editor = standIn();
    const run = await runBike(editor);
    assert.equal(run.state, PartRunState.Done, run.error);
    assert.deepEqual(sequence(editor.calls), [
      COPY,
      LoopTool.RecompileModule,
      LoopTool.ApplyPart,
      LoopTool.GetProperties,
      LoopTool.SearchCVars,
      LoopTool.SetProperties,
      LoopTool.StartPlay,
      LoopTool.Hold,
      LoopTool.CapturePlay,
      LoopTool.GameState,
      LoopTool.GameState,
      LoopTool.ProbeCharacters,
      LoopTool.ProbeView,
      LoopTool.StopPlay,
      LoopTool.SetProperties,
    ]);
    assert.deepEqual(editor.calls.find(([tool]) => tool === COPY)?.[1], { part: "Bike", ...CODE });
    const recompile = editor.calls.find(([tool]) => tool === LoopTool.RecompileModule);
    assert.deepEqual(recompile?.[1], { module: "Rush", classes: ["BikeCamera", "BikeRig"] });
    assert.ok((recompile?.[2] ?? 0) >= MIN_RECOMPILE_TIMEOUT_MS, "a hot reload waits at least five minutes");
    assert.deepEqual(written(editor.calls), [false, true], "the throttle is lifted around play only");
  });

  it("a part without C++ is neither copied nor recompiled", async () => {
    const editor = standIn();
    const run = await runLantern(editor.port);
    assert.equal(run.state, PartRunState.Done, run.error);
    assert.equal(
      editor.calls.some(([tool]) => tool === COPY || tool === LoopTool.RecompileModule),
      false,
    );
  });

  it("ends the part with the compiler's lines, paths from Source/ on, and applies nothing", async () => {
    const editor = standIn({ [LoopTool.RecompileModule]: () => NOT_COMPILED });
    const run = await runBike(editor);
    assert.equal(run.state, PartRunState.Failed);
    const error = run.error ?? "";
    assert.match(error, /didn't compile/);
    assert.ok(
      error.includes(
        "Source/Rush/Parts/Bike/BikeCamera.cpp:5:3: error: unknown type name 'FStrin'; did you mean 'FString'?",
      ),
      error,
    );
    assert.ok(error.includes("Source/Rush/Parts/Bike/BikeRig.h:9:1: error: expected ';' after class"), error);
    assert.doesNotMatch(error, /\/Users|~\/|AI Games|Library/, "no absolute path of the owner's machine");
    assert.deepEqual(sequence(editor.calls), [COPY, LoopTool.RecompileModule]);
    assert.equal(editor.state.throttle, true);
  });

  const failures: Array<[string, () => unknown, RegExp]> = [
    [
      "a class didn't load after the compile",
      () => ({ ok: false, compiled: true, ms: 14_000, missing: ["BikeRig"], log: [] }),
      /BikeRig/,
    ],
    [
      "the reload failed after the compile",
      () => ({
        ok: false,
        compiled: true,
        ms: 14_000,
        missing: [],
        log: ["LogHotReload: Error: Hot reload failed, the module could not be loaded."],
      }),
      /didn't load[\s\S]*Hot reload failed/,
    ],
    [
      "the editor refused the hot reload",
      () => ({ error: "A play session is running, and hot reload during play is not allowed; stop it first." }),
      /play session is running/,
    ],
    [
      "the call timed out",
      () => {
        throw new Error("Request timed out");
      },
      /timed out/,
    ],
    ["the answer isn't the helper's", () => "Traceback (most recent call last)", /didn't compile/],
  ];
  for (const [when, answer, why] of failures) {
    it(`ends the part without applying it when ${when}`, async () => {
      const editor = standIn({ [LoopTool.RecompileModule]: answer });
      const run = await runBike(editor);
      assert.equal(run.state, PartRunState.Failed);
      assert.match(run.error ?? "", why);
      assert.deepEqual(sequence(editor.calls), [COPY, LoopTool.RecompileModule]);
    });
  }

  it("ends the part before the hot reload when its code can't be copied in", async () => {
    const editor = standIn();
    const run = await runBike(editor, async () => {
      throw new Error("unreal/Source/Rush/Parts/Bike/BikeCamera.h is a link; nothing was copied.");
    });
    assert.equal(run.state, PartRunState.Failed);
    assert.match(run.error ?? "", /is a link; nothing was copied/);
    assert.deepEqual(sequence(editor.calls), [COPY]);
  });
});

/** Every file under `folder` with its text, by `/`-separated path; links by their target. */
async function treeOf(folder: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(folder, full).split(path.sep).join("/");
    if (entry.isFile()) tree[key] = await readFile(full, "utf8");
    else tree[key] = entry.isSymbolicLink() ? "link" : "folder";
  }
  return tree;
}

describe("a hostile C++ part folder in the editor queue", () => {
  /** A game with its module, a builder's copy holding the part's code, and a folder outside both. */
  async function world() {
    const root = await realpath(await tmpDir("studio-queue-cpp-"));
    const game = path.join(root, "game", "unreal");
    const copy = path.join(root, "copy");
    const outside = path.join(root, "outside");
    const source = path.join(copy, "unreal", "Source", "Rush", "Parts", "Bike");
    await mkdir(path.join(game, "Source", "Rush"), { recursive: true });
    await mkdir(source, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(game, "Rush.uproject"), '{"Modules":[{"Name":"Rush","Type":"Runtime"}]}');
    await writeFile(path.join(game, "Source", "Rush", "Rush.Build.cs"), "public class Rush : ModuleRules {}\n");
    await writeFile(path.join(source, "BikeCamera.cpp"), '#include "BikeCamera.h"\n');
    await writeFile(path.join(outside, "secret.h"), "// the owner's own file\n");
    const code: PartCode = { ...CODE, copy, project: path.join(game, "Rush.uproject") };
    return { game, source, outside, code };
  }

  const hostile: Array<[string, (w: Awaited<ReturnType<typeof world>>) => Promise<void>]> = [
    ["a header that is a link", (w) => symlink(path.join(w.outside, "secret.h"), path.join(w.source, "BikeCamera.h"))],
    [
      "the part's folder linked to a folder outside the game",
      async (w) => {
        await writeFile(path.join(w.outside, "BikeCamera.h"), "// outside\n");
        await rm(w.source, { recursive: true });
        await symlink(w.outside, w.source);
      },
    ],
    ["an Objective-C++ file", (w) => writeFile(path.join(w.source, "BikeCamera.mm"), "@interface Bike @end\n")],
  ];
  for (const [label, make] of hostile) {
    it(`copies nothing and never recompiles with ${label}`, async () => {
      const w = await world();
      await make(w);
      const before = await treeOf(w.game);
      const outsideBefore = await treeOf(w.outside);
      const editor = standIn();
      const queue = createEditorQueue(deps(editor.port, undefined, landPartCpp));
      const run = await settled(
        queue,
        queue.enqueue({ game: "valley", part: "Bike", script: "/s", test: TEST, cpp: w.code }),
      );
      assert.equal(run.state, PartRunState.Failed);
      assert.deepEqual(await treeOf(w.game), before, "the game's project is untouched");
      assert.deepEqual(await treeOf(w.outside), outsideBefore, "the folder outside is untouched");
      assert.equal(
        editor.calls.some(([tool]) => tool === LoopTool.RecompileModule || tool === LoopTool.ApplyPart),
        false,
      );
    });
  }
});

/** The part's error once Unreal crashed testing it: the agreed one line, naming the game's own frame. */
const CRASHED = "Unreal crashed while testing Bike: SIGSEGV in AMyGameMode::MakeBike(APawn*)";
/** The top of the crash's call stack, as `part-result` hands it on. */
const TOP_FRAMES = [
  "UEPushModelPrivate::MarkPropertyDirty(UObject const*, UEPushModelPrivate::FNetPushObjectId, int)",
  "USceneComponent::SetupAttachment(USceneComponent*, FName)",
  "AMyGameMode::MakeBike(APawn*)",
];
/** Every call to a crashed editor failed with this once its process was gone. */
const TIMED_OUT = "connect ETIMEDOUT 127.0.0.1:18118";
/** A crash found within this much of the queue's clock is found "at once": it looks every few seconds. */
const FOUND_WITHIN_MS = 6_000;

/**
 * A queue over a stand-in editor that crashes when `crashOn` is called (the call itself then hangs,
 * `hang`, or answers as usual), every later call failing as a crashed editor's do. `run` queues the
 * Bike part; `replace` puts a fresh editor in its place, as a reopened Unreal.
 */
async function crashWorld(crashOn: string, options: { hang?: boolean } = {}) {
  let crashedAt: number | undefined;
  const editor = standIn();
  const unreal = await crashableEditor(editor.port);
  let current = editor.port;
  const d = deps(editor.port);
  d.editor = () => current;
  const answer = editor.port.call;
  editor.port.call = async (tool, args, timeoutMs) => {
    if (crashedAt !== undefined) {
      editor.calls.push([tool, args]);
      throw new Error(TIMED_OUT);
    }
    if (tool !== crashOn) return answer(tool, args, timeoutMs);
    editor.calls.push([tool, args]);
    await unreal.crash();
    crashedAt = d.now();
    return options.hang ? never() : answer(tool, args, timeoutMs);
  };
  const queue = createEditorQueue(d);
  const run = (part = "Bike") => settled(queue, queue.enqueue({ game: "dirt-track", part, script: "/s", test: TEST }));
  const replace = (port: typeof current) => {
    current = port;
  };
  return { editor, unreal, run, replace, crashedAt: () => crashedAt };
}

describe("an editor that crashes while a part is in it", () => {
  it("ends the part at once as crashed when Unreal dies as play starts, with its signal and call stack", async () => {
    const w = await crashWorld(LoopTool.StartPlay);
    const run = await w.run();
    assert.equal(run.state, PartRunState.Failed);
    assert.equal(run.crashed, true);
    assert.equal(run.error, CRASHED);
    assert.equal(run.crash?.signal, "SIGSEGV");
    assert.deepEqual(run.crash?.frames.slice(0, 3), TOP_FRAMES);
    assert.equal(run.crash?.frames.length, 8, "at most eight frames");
    assert.equal(run.result, undefined);
    const after = sequence(w.editor.calls.slice(w.editor.calls.findIndex(([tool]) => tool === LoopTool.StartPlay) + 1));
    assert.ok(!after.includes(LoopTool.StopPlay), "a crashed editor is not asked to stop play");
    assert.ok(!after.includes(LoopTool.SetProperties), "nor given its throttle back: the setting died with it");
    assert.ok(run.updatedAt - (w.crashedAt() ?? 0) <= FOUND_WITHIN_MS, "not after the calls' own timeouts");
  });

  it("ends the part while the call that crashed Unreal never answers", async () => {
    const w = await crashWorld(LoopTool.StartPlay, { hang: true });
    const run = await w.run();
    assert.equal(run.state, PartRunState.Failed);
    assert.equal(run.error, CRASHED);
    assert.ok(run.updatedAt - (w.crashedAt() ?? 0) <= FOUND_WITHIN_MS);
  });

  it("ends a part whose script crashes Unreal while it applies, without playing it", async () => {
    const w = await crashWorld(LoopTool.ApplyPart, { hang: true });
    const run = await w.run();
    assert.equal(run.state, PartRunState.Failed);
    assert.equal(run.crashed, true);
    assert.equal(run.error, CRASHED);
    assert.equal(
      w.editor.calls.some(([tool]) => tool === LoopTool.StartPlay),
      false,
    );
  });
});

describe("an editor that only looks crashed, or crashed before the part", () => {
  it("ends the part as crashed when Unreal's process is gone without a crash in its log", async () => {
    const editor = standIn({ [LoopTool.StartPlay]: () => never() });
    const unreal = await crashableEditor(editor.port);
    const start = editor.port.call;
    editor.port.call = async (tool, args, timeoutMs) => {
      if (tool === LoopTool.StartPlay) unreal.unreal.running = false;
      return start(tool, args, timeoutMs);
    };
    const queue = createEditorQueue(deps(editor.port));
    const run = await settled(queue, queue.enqueue({ game: "dirt-track", part: "Bike", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Failed);
    assert.equal(run.crashed, true);
    assert.equal(run.crash?.signal, "exited");
    assert.deepEqual(run.crash?.frames, []);
    assert.match(run.error ?? "", /^Unreal crashed while testing Bike: .*process ended/);
  });

  it("finishes a part whose log only mentions errors while it plays, having looked for a crash", async () => {
    const editor = standIn();
    const unreal = await crashableEditor(editor.port);
    const hold = editor.port.call;
    editor.port.call = async (tool, args, timeoutMs) => {
      if (tool === LoopTool.Hold)
        await unreal.write(
          "[2026.01.01-12.18.53:000][381]LogTemp: Error test: UE::UnifiedErrorTest::Empty: [Empty error]\n" +
            "[2026.01.01-12.18.53:001][381]LogAudioMixerAudioUnit: Warning: Error querying Sample Rate: 2003332927\n",
        );
      return hold(tool, args, timeoutMs);
    };
    const queue = createEditorQueue(deps(editor.port));
    const run = await settled(queue, queue.enqueue({ game: "dirt-track", part: "Bike", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Done, run.error);
    assert.equal(run.crashed, undefined);
    assert.ok(unreal.unreal.checks > 0, "it looked");
    assert.equal(editor.state.pie, false, "play is stopped");
    assert.equal(editor.state.throttle, true, "the throttle is given back");
  });

  it("never blames a part for a crash that was in the log before it started", async () => {
    const editor = standIn();
    const unreal = await crashableEditor(editor.port);
    await unreal.crash();
    unreal.unreal.running = true;
    const queue = createEditorQueue(deps(editor.port));
    const run = await settled(queue, queue.enqueue({ game: "dirt-track", part: "Bike", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Done, run.error);
  });

  it("keeps a failure that isn't a crash as it was", async () => {
    const editor = standIn({ [LoopTool.ApplyPart]: () => ({ ok: false, error: "NameError: x" }) });
    await crashableEditor(editor.port);
    const queue = createEditorQueue(deps(editor.port));
    const run = await settled(queue, queue.enqueue({ game: "dirt-track", part: "Bike", script: "/s", test: TEST }));
    assert.equal(run.state, PartRunState.Failed);
    assert.equal(run.crashed, undefined);
    assert.match(run.error ?? "", /NameError/);
  });

  it("runs the next part after a crashed one once Unreal answers again", async () => {
    const w = await crashWorld(LoopTool.StartPlay);
    const first = await w.run();
    assert.equal(first.crashed, true);
    const reopened = standIn();
    await crashableEditor(reopened.port);
    w.replace(reopened.port);
    const next = await w.run("Stadium");
    assert.equal(next.state, PartRunState.Done, next.error);
    assert.equal(next.crashed, undefined);
  });
});

/** The checks a checkpoint asks of the play world, by their board ids. */
const CHECKS: PlayCheckJob["checks"] = {
  "feature:track:0": { tag: "genex:track", exists: true },
  "feature:jumps:0": { tag: "genex:jumps", exists: true },
  "feature:track:1": { player: "speedKmh", atLeast: 20 },
  "feature:track:2": { player: "routeProgressM", atLeast: 150 },
};
/** The owner wait a checkpoint gives the person in the editor: three minutes. */
const OWNER_WAIT_MS = 180_000;
/** The tools a play-check called, in order, without its polling of the game's clock. */
const played = (calls: Parameters<typeof sequence>[0]) =>
  sequence(calls).filter((tool) => tool !== LoopTool.PlayerState);

/** Queues a play-check over a playable stand-in and waits until it settles. */
async function playCheck(world: ReturnType<typeof playable>, job: Partial<PlayCheckJob> = {}) {
  const queue = createEditorQueue(world.deps);
  const id = queue.enqueuePlayCheck({ game: "dirt-track", checks: CHECKS, ownerWaitMs: OWNER_WAIT_MS, ...job });
  return settled(queue, id);
}

/** A finished play-check's result, read as the seed reads it. */
const resultOf = (run: { result?: unknown }) => run.result as PlayCheckResult;

describe("a play-check in the editor queue (the live builder's checkpoint)", () => {
  it("plays the game without applying anything: settle, spawn, a drive with four frames, ride, the checks, the probes", async () => {
    const world = playable();
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Done, run.error);
    assert.equal(run.part, "play-check");
    assert.deepEqual(played(world.editor.calls), [
      LoopTool.GetProperties,
      LoopTool.SearchCVars,
      LoopTool.SetProperties,
      LoopTool.StartPlay,
      LoopTool.Settle,
      LoopTool.ProbeCharacters,
      LoopTool.ProbeRoute,
      LoopTool.CapturePlay,
      LoopTool.DriveRoute,
      LoopTool.CapturePlay,
      LoopTool.CapturePlay,
      LoopTool.CapturePlay,
      LoopTool.CapturePlay,
      LoopTool.CapturePlay,
      LoopTool.GameState,
      LoopTool.ProbeCharacters,
      LoopTool.ProbeView,
      LoopTool.StopPlay,
      LoopTool.SetProperties,
    ]);
    const result = resultOf(run);
    assert.deepEqual(
      result.shots.map((s) => s.name),
      [PlayCheckShot.Spawn, PlayCheckShot.Ride],
    );
    assert.deepEqual(
      result.frames.map((s) => s.name),
      ["drive-1", "drive-2", "drive-3", "drive-4"],
    );
    assert.equal(result.shots[0]?.data, "png:/p/Saved/Genex/captures/spawn.png");
    assert.deepEqual(result.checks, [
      { id: "feature:track:0", check: CHECKS["feature:track:0"], passed: true, saw: true },
      { id: "feature:jumps:0", check: CHECKS["feature:jumps:0"], passed: false, saw: false },
      { id: "feature:track:1", check: CHECKS["feature:track:1"], passed: true, saw: 36 },
      { id: "feature:track:2", check: CHECKS["feature:track:2"], passed: true, saw: 200 },
    ]);
    assert.deepEqual(result.spawn.route, { route: true, facingDeg: 4.2, offRouteCm: 30, progressM: 0.3, lengthM: 420 });
    assert.deepEqual(result.spawn.characters, { pawns: [{ label: "Car_0", gapCm: 0 }], more: 0, part: "" });
    assert.deepEqual(result.settle, { settled: true, gameSeconds: 1.4, speedCmS: 3 });
    assert.deepEqual(result.drive, { route: true, gameSeconds: 20, progressM: 200 });
    assert.equal(result.fps, 40);
    assert.ok((result.gameSeconds ?? 0) >= 2 + 1.4 + 20, `the game's clock at the end: ${result.gameSeconds}`);
    assert.deepEqual(Object.keys(result.probes).sort(), [PartProbe.Characters, PartProbe.View]);
    assert.equal(world.editor.state.pie, false, "play is stopped");
    assert.equal(world.editor.state.throttleAtPlay, false, "it played unthrottled");
    assert.equal(world.editor.state.throttle, true, "and gave the throttle back");
    const settle = world.editor.calls.find(([tool]) => tool === LoopTool.Settle);
    assert.deepEqual(settle?.[1], { seconds: 8 });
    const drive = world.editor.calls.find(([tool]) => tool === LoopTool.DriveRoute);
    assert.deepEqual(drive?.[1], { seconds: 20, throttle: "Throttle", steer: "Steering" });
    const state = world.editor.calls.find(([tool]) => tool === LoopTool.GameState);
    assert.deepEqual(state?.[1], { part: "" }, "the checks read every genex:-tagged actor");
  });

  it("reads a tag check from the helper's count of every tagged actor, past the first 200 it lists", async () => {
    const scenery = Array.from({ length: 200 }, (_, i) => ({ label: `Post_${i}`, tags: ["genex:scenery"] }));
    const world = playable(
      {},
      {
        [LoopTool.GameState]: () => ({
          pie: true,
          player: null,
          actors: scenery,
          more: 51,
          tags: { "genex:scenery": 250, "genex:terrain": 1 },
        }),
      },
    );
    const checks = {
      "feature:terrain:0": { tag: "genex:terrain", exists: true },
      "feature:gone:0": { tag: "genex:gone", exists: false },
    };
    const run = await playCheck(world, { checks });
    assert.equal(run.state, PartRunState.Done, run.error);
    assert.deepEqual(resultOf(run).checks, [
      { id: "feature:terrain:0", check: checks["feature:terrain:0"], passed: true, saw: true },
      { id: "feature:gone:0", check: checks["feature:gone:0"], passed: true, saw: false },
    ]);
  });

  it("times its warm-up and the drive's frames in game seconds when Unreal plays at half speed", async () => {
    const world = playable({ rate: 0.5 });
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Done, run.error);
    const from = world.game.drive?.from ?? Number.NaN;
    assert.ok(from >= 2 + 1.4, `the drive starts after the warm-up and the settle, at ${from} game s`);
    const frames = world.captures.filter((c) => c.name.startsWith("drive-")).map((c) => c.gameSeconds - from);
    assert.equal(frames.length, 4);
    frames.forEach((at, i) => {
      assert.ok(at >= 4 * (i + 1) && at <= 4 * (i + 1) + 0.5, `frame ${i + 1} at ${at} game s into the drive`);
    });
    const ride = world.captures.find((c) => c.name === PlayCheckShot.Ride);
    assert.ok((ride?.gameSeconds ?? 0) - from >= 20, "the ride shot comes once the drive is done");
    assert.deepEqual(resultOf(run).drive, { route: true, gameSeconds: 20, progressM: 200 });
  });

  it("ends a drive Unreal plays too slowly to finish within its wall-clock cap, frames spread over it", async () => {
    const world = playable({ rate: 0.1 });
    const started = { at: 0 };
    const drive = world.editor.port.call;
    world.editor.port.call = async (tool, args, timeoutMs) => {
      if (tool === LoopTool.DriveRoute) started.at = world.deps.now();
      return drive(tool, args, timeoutMs);
    };
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Done, run.error);
    const result = resultOf(run);
    assert.equal(result.frames.length, 4);
    assert.ok(result.drive.gameSeconds < 20, `it drove ${result.drive.gameSeconds} game s`);
    const frames = world.captures.filter((c) => c.name.startsWith("drive-")).map((c) => c.gameSeconds);
    assert.equal(new Set(frames).size, 4, "each frame at its own moment, not four of one");
    const ride = world.editor.calls.findIndex(([tool, args]) => tool === LoopTool.CapturePlay && args.name === "ride");
    assert.ok(ride > 0);
    // 4 × 20 s + 10 s of the queue's clock at most, and a poll's worth.
    assert.ok(world.deps.now() - started.at <= 90_000 + 1_000 + 30_000, "the cap held");
  });

  it("records a pawn that never comes to rest as unsettled, and plays on", async () => {
    const world = playable({ settleAfter: null });
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Done, run.error);
    assert.deepEqual(resultOf(run).settle, { settled: false, gameSeconds: 8, speedCmS: 140 });
    assert.equal(resultOf(run).frames.length, 4);
  });

  it("drives on the throttle alone in a game without a route, and measures no progress", async () => {
    const world = playable({ route: false });
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Done, run.error);
    const result = resultOf(run);
    assert.deepEqual(result.drive, { route: false, gameSeconds: 20, progressM: null });
    assert.deepEqual(result.spawn.route, {
      route: false,
      facingDeg: null,
      offRouteCm: null,
      progressM: null,
      lengthM: null,
    });
    const progress = result.checks.find((c) => c.id === "feature:track:2");
    assert.deepEqual([progress?.passed, progress?.saw], [false, null], "an unmeasured progress never passes");
  });

  it("records a route probe that fails, and still finishes", async () => {
    const world = playable(
      {},
      {
        [LoopTool.ProbeRoute]: () => {
          throw new Error("connection reset");
        },
      },
    );
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Done, run.error);
    assert.deepEqual(resultOf(run).spawn.route, { error: "connection reset" });
  });

  it("fails a drive the helper refuses, stopping play and giving the throttle back", async () => {
    const world = playable({}, { [LoopTool.DriveRoute]: () => ({ error: "No GenexRoute and no Throttle action." }) });
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Failed);
    assert.match(run.error ?? "", /No GenexRoute and no Throttle action/);
    assert.equal(world.editor.state.pie, false);
    assert.equal(world.editor.state.throttle, true);
  });

  it("waits for the person in the editor at most the job's own owner wait, then fails as owner-busy", async () => {
    let reads = 0;
    const world = playable(
      {},
      {
        [LoopTool.EditorActivity]: () => {
          reads++;
          return { camera: [0, 0, reads], selection: [], dirty: [], pie: false };
        },
      },
    );
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Failed);
    assert.equal(run.failure, PartRunFailure.OwnerBusy);
    assert.ok(world.deps.now() <= OWNER_WAIT_MS + 3_000, `gave up after ${world.deps.now()} ms`);
    assert.equal(
      world.editor.calls.some(([tool]) => tool === LoopTool.StartPlay),
      false,
    );
  });

  it("fails as not-answering when Unreal never answers", async () => {
    const world = playable();
    world.editor.state.answering = false;
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Failed);
    assert.equal(run.failure, PartRunFailure.NotAnswering);
    assert.deepEqual(world.editor.calls, []);
  });

  it("ends as crashed, at once, when Unreal crashes during the drive", async () => {
    const world = playable();
    const unreal = await crashableEditor(world.editor.port);
    const answer = world.editor.port.call;
    let crashed = false;
    world.editor.port.call = async (tool, args, timeoutMs) => {
      if (crashed) throw new Error("connect ETIMEDOUT 127.0.0.1:18118");
      if (tool !== LoopTool.DriveRoute) return answer(tool, args, timeoutMs);
      await unreal.crash();
      crashed = true;
      return never();
    };
    const run = await playCheck(world);
    assert.equal(run.state, PartRunState.Failed);
    assert.equal(run.crashed, true);
    assert.equal(run.crash?.signal, "SIGSEGV");
    assert.equal(run.failure, undefined, "a crash is crashed, not a failure the checkpoint waits out");
  });

  it("waits its turn behind a part, one run in the editor at a time", async () => {
    const world = playable();
    const queue = createEditorQueue(world.deps);
    const part = queue.enqueue({ game: "dirt-track", part: "Lantern", script: "/s", test: TEST });
    const check = queue.enqueuePlayCheck({ game: "dirt-track", checks: {}, ownerWaitMs: OWNER_WAIT_MS });
    assert.equal((await settled(queue, check)).state, PartRunState.Done);
    assert.equal(queue.status(part)?.state, PartRunState.Done);
    const tools = sequence(world.editor.calls);
    assert.ok(tools.indexOf(LoopTool.StopPlay) < tools.indexOf(LoopTool.Settle), "the part's play ended first");
    assert.deepEqual(resultOf(await settled(queue, check)).checks, []);
  });
});

describe("a part's test in game seconds, with the live builder's steps", () => {
  it("plays settle, a drive and a tag check from test.json; the drive's frames are the part's shots", async () => {
    const parsed = parsePartTest({
      steps: [{ settle: 4 }, { drive: 6, frames: 2 }, { expect: { tag: "genex:track", exists: true } }],
    });
    assert.ok(parsed.ok);
    const world = playable();
    const queue = createEditorQueue(world.deps);
    const run = await settled(
      queue,
      queue.enqueue({ game: "dirt-track", part: "Track", script: "/s", test: parsed.test }),
    );
    assert.equal(run.state, PartRunState.Done, run.error);
    assert.deepEqual(
      run.result?.shots.map((s) => s.name),
      ["drive-1", "drive-2"],
    );
    assert.deepEqual(run.result?.checks, [{ check: { tag: "genex:track", exists: true }, passed: true, saw: true }]);
    const tagRead = world.editor.calls.find(([tool]) => tool === LoopTool.GameState);
    assert.deepEqual(tagRead?.[1], { part: "" }, "a tag check reads every genex:-tagged actor, not the part's");
  });

  it("holds and waits for game seconds in an editor that plays at a quarter of real time", async () => {
    const parsed = parsePartTest({
      warmupSeconds: 2,
      steps: [{ hold: "Throttle", seconds: 3 }, { wait: 1 }, { shot: "walk" }],
    });
    assert.ok(parsed.ok);
    const world = playable({ rate: 0.25 });
    const queue = createEditorQueue(world.deps);
    const run = await settled(
      queue,
      queue.enqueue({ game: "dirt-track", part: "Bike", script: "/s", test: parsed.test }),
    );
    assert.equal(run.state, PartRunState.Done, run.error);
    const walk = world.captures.find((c) => c.name === "walk");
    assert.ok((walk?.gameSeconds ?? 0) >= 2 + 3 + 1, `the shot after 6 game seconds, at ${walk?.gameSeconds}`);
  });
});
