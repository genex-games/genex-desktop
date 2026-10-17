/**
 * check-part on a C++ part: the builder's gate reads the part's C++ in its own copy of
 * the game, refuses it without the game's module, where C++ can't compile, or with changes outside
 * the part's folder, then compiles the copy with UnrealBuildTool (a stand-in here) and names each
 * compile error at its file and line. A compile longer than check-part's wait is answered as still
 * compiling and picked up by the next call; run-part never compiles.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { createLoopTools, LoopToolName } from "../../src/plugins/unreal/loop-tools.ts";
import { CHECK_ANSWER_BY_MS } from "../../src/plugins/unreal/part-compile.ts";
import { unrealPython } from "../../src/plugins/unreal/python-check.ts";
import { CompileFailure, type CompileOptions, type CompileResult } from "../../src/plugins/unreal/ubt.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MODULE = "Rush";
const PART = {
  title: "Bike camera",
  goal: "The camera rides the bike.",
  cpp: ["BikeCamera"],
  blueprints: [{ name: "BP_BikeCamera", parent: "BikeCamera" }],
};
const HEADER =
  'UCLASS()\nclass RUSH_API ABikeCamera : public AActor\n{\n\tGENERATED_BODY()\n};\n#include "BikeCamera.generated.h"\n';
const OK: CompileResult = { ok: true, seconds: 10, errors: [], summary: "RushEditor built in 10 s.", retryable: false };
const BROKEN: CompileResult = {
  ok: false,
  seconds: 8,
  errors: [
    {
      file: "Source/Rush/Parts/Bike/BikeCamera.cpp",
      line: 3,
      column: 5,
      message: "use of undeclared identifier 'FStrin'; did you mean 'FString'?",
    },
  ],
  summary: "RushEditor didn't build (OtherCompilationError): 1 error.",
  failure: CompileFailure.Failed,
  retryable: false,
};

/** The game folder with its module (Blueprint-only when `module` is false), the part's files and its C++. */
async function writeGame(dir: string, module = true) {
  const unreal = path.join(dir, "unreal");
  const part = path.join(unreal, "parts", "Bike");
  const cpp = path.join(unreal, "Source", MODULE, "Parts", "Bike");
  await mkdir(part, { recursive: true });
  await mkdir(cpp, { recursive: true });
  const modules = module ? { Modules: [{ Name: MODULE, Type: "Runtime" }] } : {};
  await writeFile(path.join(unreal, "Rush.uproject"), JSON.stringify({ FileVersion: 3, ...modules }));
  await writeFile(path.join(unreal, "Source", MODULE, "Rush.Build.cs"), "public class Rush : ModuleRules {}\n");
  await writeFile(path.join(part, "part.json"), JSON.stringify(PART));
  await writeFile(path.join(part, "test.json"), JSON.stringify({ steps: [{ shot: "bike" }] }));
  await writeFile(path.join(part, "apply.py"), "genex.save()\n");
  await writeFile(path.join(cpp, "BikeCamera.h"), HEADER);
  await writeFile(path.join(cpp, "BikeCamera.cpp"), '#include "BikeCamera.h"\n');
}

type Options = {
  platform?: NodeJS.Platform;
  xcode?: XcodeState;
  module?: boolean;
  /** Runs while Xcode is probed: a slow probe moves the clock, a watcher looks for apply.py's check. */
  probing?: (clock: { at: number }) => Promise<void>;
};

/** The Xcode app the stand-in probe finds. */
const XCODE_APP = "/Applications/Xcode-26.2.app";

/** The game and two builders' copies of it, with a stand-in UBT the test answers by hand. */
async function world(options: Options = {}) {
  const root = await realpath(await tmpDir("studio-loop-cpp-"));
  const game = path.join(root, "game");
  const copies = [path.join(root, "copy-a"), path.join(root, "copy-b")];
  for (const dir of [game, ...copies]) await writeGame(dir, options.module ?? true);
  const storage = path.join(root, "storage");
  await mkdir(storage, { recursive: true });
  const compiles: CompileOptions[] = [];
  const answers: Array<(result: CompileResult) => void> = [];
  const xcodeAsked: Array<string | undefined> = [];
  const waits = { elapsed: false };
  /** check-part's waits for a compile: how long, and whether each was told to stop. */
  const sleeps: Array<{ ms: number; signal: AbortSignal | undefined }> = [];
  const clock = { at: 0 };
  const tools = createLoopTools({
    platform: options.platform ?? "darwin",
    engine: async () => ({ version: "5.8", directory: path.join(root, "engine") }),
    project: async () => path.join(game, "unreal", "Rush.uproject"),
    xcode: async (engineDir) => {
      xcodeAsked.push(engineDir);
      await options.probing?.(clock);
      return { state: options.xcode ?? XcodeState.Ready, app: XCODE_APP };
    },
    compile: (compile) => {
      compiles.push(compile);
      return new Promise((resolve) => answers.push(resolve));
    },
    editorCall: async () => ({ ok: true }),
    editorAnswers: async () => true,
    // These tests never add a C++ module, so Unreal is never quit or opened.
    restart: { editors: async () => 0, quit: async () => {}, open: async () => {} },
    now: () => clock.at,
    // check-part's wait: over at once when the test says so, else never within the test.
    sleep: (ms, signal) => {
      sleeps.push({ ms, signal });
      return new Promise((resolve) => (waits.elapsed ? setImmediate(resolve) : setTimeout(resolve, ms).unref()));
    },
  });
  const context = (directory: string): PluginContext => ({
    project: "rush",
    directory,
    signal: new AbortController().signal,
    callId: 1,
    host: (async () => storage) as never,
  });
  const check = (directory: string) =>
    tools.call(LoopToolName.CheckPart, { part: "Bike" }, context(directory), storage).then(String);
  /** Answers the compile started `at`th once it has started. */
  const answer = async (at: number, result: CompileResult) => {
    for (let i = 0; i < 500 && !answers[at]; i++) await sleep(10);
    answers[at]?.(result);
  };
  return { root, game, copies, storage, compiles, xcodeAsked, waits, sleeps, clock, tools, context, check, answer };
}

describe("check-part on a C++ part", () => {
  it("compiles the builder's copy of the game and passes C++ that compiles", async () => {
    const w = await world();
    const copy = w.copies[0] ?? "";
    const checked = w.check(copy);
    await w.answer(0, OK);
    assert.match(await checked, /^Bike passes/);
    assert.equal(w.compiles.length, 1);
    assert.equal(w.compiles[0]?.projectFile, path.join(copy, "unreal", "Rush.uproject"));
    assert.equal(w.compiles[0]?.module, MODULE);
    assert.equal(w.compiles[0]?.engineDir, path.join(w.root, "engine"));
  });

  it("names each compile error at its file and line, relative to the copy", async () => {
    const w = await world();
    const checked = w.check(w.copies[0] ?? "");
    await w.answer(0, BROKEN);
    const answer = await checked;
    assert.match(answer, /1 problem/);
    assert.match(
      answer,
      /- unreal\/Source\/Rush\/Parts\/Bike\/BikeCamera\.cpp:3: use of undeclared identifier 'FStrin'; did you mean 'FString'\?/,
    );
  });

  it("answers still compiling past its wait, and the next call picks up the compile's result", async () => {
    const w = await world();
    const copy = w.copies[0] ?? "";
    w.waits.elapsed = true;
    const first = await w.check(copy);
    assert.match(first, /1 problem/);
    assert.match(first, /still compiling/);
    assert.match(first, /check-part again/);
    await w.answer(0, BROKEN);
    assert.match(await w.check(copy), /FStrin/);
    assert.match(await w.check(copy), /FStrin/, "the same C++ keeps its result");
    assert.equal(w.compiles.length, 1, "one compile for the same C++");
  });

  it("compiles again when the part's C++ changed", async () => {
    const w = await world();
    const copy = w.copies[0] ?? "";
    const first = w.check(copy);
    await w.answer(0, BROKEN);
    await first;
    const cpp = path.join(copy, "unreal", "Source", MODULE, "Parts", "Bike", "BikeCamera.cpp");
    await writeFile(cpp, '#include "BikeCamera.h"\n// fixed\n');
    const second = w.check(copy);
    await w.answer(1, OK);
    assert.match(await second, /^Bike passes/);
    assert.equal(w.compiles.length, 2);
  });

  it("hands UnrealBuildTool the Xcode app the probe found, for its sandbox", async () => {
    const w = await world();
    const checked = w.check(w.copies[0] ?? "");
    await w.answer(0, OK);
    await checked;
    assert.equal(w.compiles[0]?.xcodeApp, XCODE_APP);
  });

  it("waits for the compile only as long as the call has left, and stops waiting once it answers", async () => {
    const w = await world({
      probing: async (clock) => {
        clock.at = 100 * SECOND_MS;
      },
    });
    const checked = w.check(w.copies[0] ?? "");
    await w.answer(0, OK);
    assert.match(await checked, /^Bike passes/);
    assert.deepEqual(
      w.sleeps.map((s) => s.ms),
      [CHECK_ANSWER_BY_MS - 100 * SECOND_MS],
    );
    assert.equal(w.sleeps[0]?.signal?.aborted, true, "the wait's timer was told to stop");
  });

  it("answers still compiling at once when the checks before it used up the call's time", async () => {
    const w = await world({
      probing: async (clock) => {
        clock.at = CHECK_ANSWER_BY_MS + SECOND_MS;
      },
    });
    const copy = w.copies[0] ?? "";
    assert.match(await w.check(copy), /still compiling/);
    assert.ok(
      w.sleeps.every((s) => s.ms === 0),
      JSON.stringify(w.sleeps.map((s) => s.ms)),
    );
    await w.answer(0, BROKEN);
    assert.match(await w.check(copy), /FStrin/, "the next call takes the compile's result");
    assert.equal(w.compiles.length, 1);
  });

  it("never compiles in the game's own folder: there the editor compiles the C++", async () => {
    const w = await world();
    const unverified = (answer: string) => Number(/^Bike passes \((\d+) not verified yet/.exec(answer)?.[1] ?? 0);
    // A compile here would answer "still compiling" at once rather than wait.
    w.waits.elapsed = true;
    const inGame = await w.check(w.game);
    assert.equal(w.compiles.length, 0);
    w.waits.elapsed = false;
    const inCopy = w.check(w.copies[0] ?? "");
    await w.answer(0, OK);
    assert.equal(unverified(inGame), unverified(await inCopy) + 1, `${inGame}: its C++ is the one more`);
  });

  it("never answers one builder's copy with another's compile errors", async () => {
    const w = await world();
    const [a = "", b = ""] = w.copies;
    const checkedA = w.check(a);
    await w.answer(0, BROKEN);
    assert.match(await checkedA, /FStrin/);
    const checkedB = w.check(b);
    await w.answer(1, OK);
    assert.match(await checkedB, /^Bike passes/);
    assert.deepEqual(
      w.compiles.map((c) => c.projectFile),
      [path.join(a, "unreal", "Rush.uproject"), path.join(b, "unreal", "Rush.uproject")],
    );
  });
});

describe("check-part refusing C++ before it compiles", () => {
  it("refuses without compiling: no module, no Mac, Xcode not ready, or a change outside the part", async () => {
    const rows: Array<[string, Options, (copy: string) => Promise<unknown>, RegExp]> = [
      ["a Blueprint game", { module: false }, async () => {}, /no C\+\+ module yet/],
      ["not a Mac", { platform: "linux" }, async () => {}, /Mac/],
      ["Xcode not ready", { xcode: XcodeState.NotSelected }, async () => {}, /Xcode/],
      [
        "the module's rules changed",
        {},
        (copy) => writeFile(path.join(copy, "unreal", "Source", MODULE, "Rush.Build.cs"), "// edited\n"),
        /Rush\.Build\.cs: changed outside/,
      ],
      [
        "the .uproject changed",
        {},
        (copy) =>
          writeFile(
            path.join(copy, "unreal", "Rush.uproject"),
            JSON.stringify({ FileVersion: 3, Modules: [{ Name: MODULE, Type: "Runtime" }], PreBuildSteps: {} }),
          ),
        /unreal\/Rush\.uproject: changed outside/,
      ],
      [
        "a plugin the copy added",
        {},
        async (copy) => {
          await mkdir(path.join(copy, "unreal", "Plugins", "Planted"), { recursive: true });
          await writeFile(path.join(copy, "unreal", "Plugins", "Planted", "Planted.uplugin"), "{}");
        },
        /unreal\/Plugins\/Planted\/Planted\.uplugin: changed outside/,
      ],
      [
        "a class no header declares",
        {},
        (copy) =>
          writeFile(path.join(copy, "unreal", "Source", MODULE, "Parts", "Bike", "BikeCamera.h"), "// nothing\n"),
        /RUSH_API ABikeCamera/,
      ],
    ];
    for (const [label, options, plant, problem] of rows) {
      const w = await world(options);
      const copy = w.copies[0] ?? "";
      await plant(copy);
      const answer = await w.check(copy);
      assert.match(answer, problem, label);
      assert.equal(w.compiles.length, 0, `${label}: nothing compiled`);
    }
  });

  it("a Blueprint-only part never asks for Xcode or compiles", async () => {
    const w = await world();
    const copy = w.copies[0] ?? "";
    const part = path.join(copy, "unreal", "parts", "Bike");
    await writeFile(
      path.join(part, "part.json"),
      JSON.stringify({ ...PART, cpp: [], blueprints: [{ name: "BP_BikeCamera", base: "Actor" }] }),
    );
    await writeFile(
      path.join(copy, "unreal", "Source", MODULE, "Parts", "Bike", "BikeCamera.h"),
      "// left from an earlier try\n",
    );
    const answer = await w.check(copy);
    assert.match(answer, /cpp lists no class/);
    assert.equal(w.compiles.length, 0);
    assert.deepEqual(w.xcodeAsked, []);
  });

  it("run-part checks the C++ in the game but never compiles", async () => {
    const w = await world();
    const run = w.tools.call(LoopToolName.RunPart, { part: "Bike" }, w.context(w.game), w.storage);
    await run.catch(() => undefined);
    assert.equal(w.compiles.length, 0);
  });

  const posixOnly = process.platform === "win32" ? "the stand-in for Unreal's Python is a shell script" : false;
  it("hands apply.py's check the game's module and every part's C++ classes", { skip: posixOnly }, async () => {
    const w = await world();
    const copy = w.copies[0] ?? "";
    const python = unrealPython(path.join(w.root, "engine"), "darwin");
    const asked = path.join(w.root, "python-request.json");
    await mkdir(path.dirname(python), { recursive: true });
    await writeFile(python, `#!/bin/sh\ncat > "${asked}"\necho "[]"\n`);
    await chmod(python, 0o755);
    const other = path.join(copy, "unreal", "parts", "Lap");
    await mkdir(other);
    await writeFile(
      path.join(other, "part.json"),
      JSON.stringify({ title: "Lap", goal: "", cpp: ["LapTimer"], blueprints: [] }),
    );
    const checked = w.check(copy);
    await w.answer(0, OK);
    await checked;
    const request = JSON.parse(await readFile(asked, "utf8"));
    assert.equal(request.cpp?.module, MODULE);
    assert.deepEqual([...(request.cpp?.classes ?? [])].sort(), ["BikeCamera", "LapTimer"]);
  });

  it("checks apply.py while Xcode is probed, not after", { skip: posixOnly }, async () => {
    const seen = { python: false };
    let started = "";
    const w = await world({
      probing: async () => {
        for (let i = 0; i < 200 && !seen.python; i++) {
          seen.python = existsSync(started);
          await sleep(10);
        }
      },
    });
    started = path.join(w.root, "python-started");
    const python = unrealPython(path.join(w.root, "engine"), "darwin");
    await mkdir(path.dirname(python), { recursive: true });
    await writeFile(python, `#!/bin/sh\ntouch "${started}"\ncat > /dev/null\necho "[]"\n`);
    await chmod(python, 0o755);
    const checked = w.check(w.copies[0] ?? "");
    await w.answer(0, OK);
    await checked;
    assert.equal(seen.python, true, "apply.py's check started while the probe ran");
  });
});
