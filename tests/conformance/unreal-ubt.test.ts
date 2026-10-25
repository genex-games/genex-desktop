/**
 * Builders compile their C++ parts with UnrealBuildTool in their own copy of the game: the
 * editor target, `-NoMutex -NoUBA`, at most two compiles at once (a full build peaks near 6 GB), a
 * deadline that ends the whole process tree, and clang's first line per error with the file
 * relative to the project, so no absolute path of the user's machine reaches an agent. The logs
 * here are real UBT output (paths anonymized); no UBT runs in these tests.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it, type TestContext } from "node:test";
import {
  type CompileError,
  CompileFailure,
  type CompileOptions,
  type CompileResult,
  canCompileCpp,
  compileEditor,
  MAX_PARALLEL_COMPILES,
  type PrepareSandbox,
  type RunCommand,
  systemRunCommand,
} from "../../src/plugins/unreal/ubt.ts";
import {
  type BuildSandbox,
  type BuildSandboxRequest,
  prepareBuildSandbox,
} from "../../src/plugins/unreal/ubt-sandbox.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "unreal-ubt");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");

/**
 * A hang guard for the queue's cases, which take milliseconds and wait on what happened, never on
 * a clock: a queue that never hands a slot on fails the case instead of holding the file open.
 */
const CASE_TIMEOUT_MS = 30_000;

const ENGINE = "/Users/Shared/Epic Games/UE_5.8";
const PROJECT = "/Users/me/Games/rush/unreal/GxCpp.uproject";
const BUILD_SH = `${ENGINE}/Engine/Build/BatchFiles/Mac/Build.sh`;

/** A runner that answers with `output` at once and records what it was asked to run. */
function answering(output: string, code: number | null = 0) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: RunCommand = async (file, args) => {
    calls.push({ file, args });
    return { code, output };
  };
  return { run, calls };
}

/** A clock that moves `step` ms on each read. */
function clock(step: number) {
  let now = 0;
  return () => {
    now += step;
    return now;
  };
}

/**
 * A sandbox made at once, for tests about what UBT answers and how compiles queue: making a real
 * one is file work whose timing they don't measure (its own tests are below and in
 * unreal-ubt-sandbox.test.ts).
 */
const instantSandbox: PrepareSandbox = async () => ({
  profile: "/stand-in/ubt.sb",
  env: { HOME: "/stand-in/home", TMPDIR: "/stand-in/tmp/", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
  cwd: "/stand-in",
  dispose: async () => {},
});

const options = (overrides: Partial<CompileOptions> = {}): CompileOptions => ({
  engineDir: ENGINE,
  projectFile: PROJECT,
  module: "GxCpp",
  platform: "darwin",
  prepareSandbox: instantSandbox,
  ...overrides,
});

/** No absolute path of the user's machine in anything an agent reads. */
function assertNoAbsolutePaths(result: CompileResult) {
  const text = JSON.stringify(result);
  for (const leak of ["/Users/", "/Applications/", "/private/", "/var/"])
    assert.ok(!text.includes(leak), `no ${leak} in ${text}`);
}

describe("compiling a game's editor target with UnrealBuildTool", () => {
  it("runs the engine's Build.sh for <Module>Editor on the project, without UBT's global lock or its accelerator", async () => {
    const { run, calls } = answering(await fixture("first.log"));
    await compileEditor(options({ run }));
    assert.deepEqual(calls, [
      {
        file: BUILD_SH,
        args: ["GxCppEditor", "Mac", "Development", `-Project=${PROJECT}`, "-NoMutex", "-NoUBA"],
      },
    ]);
  });

  it("runs Build.sh in a sandbox of its own, which is gone once the build ends", async () => {
    const requests: BuildSandboxRequest[] = [];
    const seen: Array<{ sandbox: BuildSandbox; profileThere: boolean }> = [];
    const prepareSandbox = async (request: BuildSandboxRequest) => {
      requests.push(request);
      return prepareBuildSandbox({ ...request, projectDir: await tmpDir("studio-ubt-project-") });
    };
    const run: RunCommand = async (_file, _args, { sandbox }) => {
      seen.push({ sandbox, profileThere: existsSync(sandbox.profile) });
      return { code: 0, output: await fixture("first.log") };
    };
    const result = await compileEditor(options({ run, prepareSandbox, xcodeApp: "/Applications/Xcode.app" }));
    assert.equal(result.ok, true);
    assert.deepEqual(requests, [
      { projectDir: path.dirname(PROJECT), engineDir: ENGINE, xcodeApp: "/Applications/Xcode.app" },
    ]);
    const [{ sandbox, profileThere } = { sandbox: undefined, profileThere: false }] = seen;
    assert.ok(profileThere, "the profile is there while UBT runs");
    assert.deepEqual(Object.keys(sandbox?.env ?? {}).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
    assert.ok(!existsSync(sandbox?.cwd ?? ""), "the build's scratch is removed");
  });

  it("a sandbox that can't be made is a typed failure, and nothing runs", async () => {
    const { run, calls } = answering(await fixture("first.log"));
    const prepareSandbox = async () => {
      throw new Error("The project folder holds the home folder, so it can't be confined.");
    };
    const result = await compileEditor(options({ run, prepareSandbox }));
    assert.equal(result.failure, CompileFailure.NotStarted);
    assert.equal(calls.length, 0);
  });

  it("a full first build succeeds", async () => {
    const { run } = answering(await fixture("first.log"));
    const result = await compileEditor(options({ run, now: clock(15_250) }));
    assert.equal(result.ok, true);
    assert.equal(result.failure, undefined);
    assert.equal(result.retryable, false);
    assert.deepEqual(result.errors, []);
    assert.equal(result.seconds, 15.3);
    assert.match(result.summary, /GxCppEditor/);
    assertNoAbsolutePaths(result);
  });

  it("an incremental build succeeds", async () => {
    const { run } = answering(await fixture("builder-inc.log"));
    const result = await compileEditor(options({ run }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("success comes from UBT's result line, not the exit code (Build.sh exits 0 on some failures)", async () => {
    const failed = answering(await fixture("builder-err.log"), 0);
    assert.equal((await compileEditor(options({ run: failed.run }))).ok, false);
    const succeeded = answering(await fixture("builder-inc.log"), 6);
    assert.equal((await compileEditor(options({ run: succeeded.run }))).ok, true);
  });

  it("another build holding UBT's lock is a retryable failure, not an error in the code", async () => {
    const { run } = answering(await fixture("conflicting-instance.log"));
    const result = await compileEditor(options({ run, projectFile: "/Users/me/Games/rush-b/unreal/GxCpp.uproject" }));
    assert.equal(result.ok, false);
    assert.equal(result.failure, CompileFailure.Conflicting);
    assert.equal(result.retryable, true);
    assert.deepEqual(result.errors, []);
    assertNoAbsolutePaths(result);
  });
});

/** The project of the real logs recorded from a module Genex added to a copy of a C++ project (GxCheck). */
const CHECK = { projectFile: "/Users/me/Games/check/unreal/Gx-Check.uproject", module: "GxCheck" };

/** A failed build mixing every kind of error line UBT, clang, UnrealHeaderTool and ld print. */
const MIXED_LOG = [
  "Building GxCppEditor...",
  "/Users/me/Games/rush/unreal/Source/GxCpp/Parts/Hud/GxHud.h(14): Error: Unrecognized type 'FStrin' - type must be a UCLASS, USTRUCT, UENUM, or global delegate.",
  `${ENGINE}/Engine/Source/Runtime/Core/Public/Containers/Array.h:120:5: error: static assertion failed due to requirement 'false'`,
  "/Users/other/Elsewhere/Shared.cpp:3:1: fatal error: 'Missing.h' file not found",
  "/Users/me/Games/rush/unreal/Source/GxCpp/Parts/Lap/GxLapTimer.cpp:9:3: warning: unused variable 'x' [-Wunused-variable]",
  "ERROR: Could not find definition for module 'Foo', (referenced via /Users/me/Games/rush/unreal/Source/GxCpp/GxCpp.Build.cs)",
  "  ERROR: /Users/me/Games/rush/unreal/Source/GxCpp/GxCpp.Build.cs(9,61): error CS1002: ; expected",
  "[3/3] Link [Apple] libUnrealEditor-GxCpp.dylib",
  "ld: warning: ignoring duplicate libraries: '-lc++'",
  "Undefined symbols for architecture arm64:",
  '  "AGxProbe::GetBoostedSpeed() const", referenced from:',
  "      vtable for AGxProbe in Module.GxCpp.cpp.o",
  '  "UGxLap::StaticClass()", referenced from:',
  "      AGxProbe::BeginPlay() in GxProbe.cpp.o",
  "ld: symbol(s) not found for architecture arm64",
  "clang++: error: linker command failed with exit code 1 (use -v to see invocation)",
  "",
  "Result: Failed (OtherCompilationError)",
].join("\n");

/** What an error in a file outside the project and the engine says instead of its text. */
const FOREIGN =
  "an error in a file outside the game and the engine; a part's C++ includes only the engine's and the game's own headers.";

/** The errors {@link MIXED_LOG} reports, in order, with no absolute path left. */
const MIXED_ERRORS: CompileError[] = [
  {
    file: "Source/GxCpp/Parts/Hud/GxHud.h",
    line: 14,
    column: 0,
    message: "Unrecognized type 'FStrin' - type must be a UCLASS, USTRUCT, UENUM, or global delegate.",
  },
  { file: "Array.h", line: 120, column: 5, message: "static assertion failed due to requirement 'false'" },
  // A file in neither the project nor the engine: where it is, never what it says.
  { file: "Shared.cpp", line: 3, column: 1, message: FOREIGN },
  {
    file: "",
    line: 0,
    column: 0,
    message: "Could not find definition for module 'Foo', (referenced via Source/GxCpp/GxCpp.Build.cs)",
  },
  { file: "Source/GxCpp/GxCpp.Build.cs", line: 9, column: 61, message: "CS1002: ; expected" },
  {
    file: "",
    line: 0,
    column: 0,
    message:
      "Undefined symbol: AGxProbe::GetBoostedSpeed() const, referenced from vtable for AGxProbe in Module.GxCpp.cpp.o",
  },
  {
    file: "",
    line: 0,
    column: 0,
    message: "Undefined symbol: UGxLap::StaticClass(), referenced from AGxProbe::BeginPlay() in GxProbe.cpp.o",
  },
  { file: "", line: 0, column: 0, message: "symbol(s) not found for architecture arm64" },
  {
    file: "",
    line: 0,
    column: 0,
    message: "linker command failed with exit code 1 (use -v to see invocation)",
  },
];

describe("reading UBT's errors", () => {
  it("a compile error is clang's first line, at its file relative to the project", async () => {
    const { run } = answering(await fixture("builder-err.log"));
    const result = await compileEditor(options({ run }));
    assert.equal(result.ok, false);
    assert.equal(result.failure, CompileFailure.Failed);
    assert.equal(result.retryable, false);
    assert.deepEqual(result.errors, [
      {
        file: "Source/GxCpp/Parts/Lap/GxLapTimer.cpp",
        line: 6,
        column: 9,
        message: "use of undeclared identifier 'FStrin'; did you mean 'FString'?",
      },
    ]);
    assert.match(result.summary, /1 error/);
    assertNoAbsolutePaths(result);
  });

  it("an undefined symbol names what uses it, beside ld's and clang's own lines", async () => {
    const { run } = answering(await fixture("builder-link.log"));
    const result = await compileEditor(options({ run, ...CHECK }));
    assert.equal(result.failure, CompileFailure.Failed);
    assert.deepEqual(
      result.errors.map((e) => e.message),
      [
        "Undefined symbol: AGxProbe::MissingBoost() const, referenced from AGxProbe::GetBoostedSpeed() const in GxProbe.cpp.o",
        "symbol(s) not found for architecture arm64",
        "linker command failed with exit code 1 (use -v to see invocation)",
      ],
    );
    assert.ok(result.errors.every((e) => e.file === "" && e.line === 0));
    assertNoAbsolutePaths(result);
  });

  it("a rules error UBT prints without a marker is still named: the line before its result", async () => {
    const { run } = answering(await fixture("rules-missing-module.log"));
    const result = await compileEditor(options({ run, ...CHECK }));
    assert.equal(result.failure, CompileFailure.Failed);
    assert.match(result.summary, /RulesError/);
    assert.deepEqual(result.errors, [
      {
        file: "",
        line: 0,
        column: 0,
        message:
          "Could not find definition for module 'NoSuchModule', (referenced via GxCheckEditor -> GxCheck.Build.cs)",
      },
    ]);
  });

  it("a Build.cs that doesn't compile names its line, and only that", async () => {
    const { run } = answering(await fixture("rules-syntax.log"));
    const result = await compileEditor(options({ run, ...CHECK }));
    assert.deepEqual(result.errors, [
      { file: "Source/GxCheck/GxCheck.Build.cs", line: 8, column: 180, message: "CS1002: ; expected" },
    ]);
    assertNoAbsolutePaths(result);
  });

  it("reads linker, UnrealHeaderTool, UBT and engine-header errors, and never leaks a path", async () => {
    const { run } = answering(MIXED_LOG);
    const result = await compileEditor(options({ run }));
    assert.deepEqual(result.errors, MIXED_ERRORS);
    assertNoAbsolutePaths(result);
  });

  it("never passes on the text of an error in a file outside the project and the engine", async () => {
    const text = "unknown type name 'STANDIN_TOKEN_TEXT'";
    const rows: Array<[string, string, string]> = [
      ["a file in the home folder", `/Users/me/.ssh/id_stand_in:1:1: error: ${text}`, "id_stand_in"],
      ["a system file", `/etc/stand-in.conf:2:5: error: ${text}`, "stand-in.conf"],
      [
        "a path that climbs out of the project",
        `/Users/me/Games/rush/unreal/Source/GxCpp/../../../../.aws/stand-in:3:1: error: ${text}`,
        "stand-in",
      ],
      ["UnrealHeaderTool's form", `/Users/me/notes/stand-in.h(4): Error: ${text}`, "stand-in.h"],
    ];
    for (const [label, line, file] of rows) {
      const log = [line, "Result: Failed (OtherCompilationError)"].join("\n");
      const result = await compileEditor(options({ run: answering(log).run }));
      assert.deepEqual(
        result.errors.map((e) => [e.file, e.message]),
        [[file, FOREIGN]],
        label,
      );
      assert.ok(!JSON.stringify(result).includes("STANDIN_TOKEN_TEXT"), label);
    }
  });

  it("keeps an error's text in the project and in the engine", async () => {
    const log = [
      "/Users/me/Games/rush/unreal/Source/GxCpp/Parts/Bike/Bike.cpp:3:1: error: in the project",
      `${ENGINE}/Engine/Source/Runtime/Core/Public/Templates/Casts.h:9:2: error: in the engine`,
      "Result: Failed (OtherCompilationError)",
    ].join("\n");
    const result = await compileEditor(options({ run: answering(log).run }));
    assert.deepEqual(
      result.errors.map((e) => [e.file, e.message]),
      [
        ["Source/GxCpp/Parts/Bike/Bike.cpp", "in the project"],
        ["Casts.h", "in the engine"],
      ],
    );
  });

  it("keeps at most 20 errors, each message at most 300 characters, each error once", async () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `/Users/me/Games/rush/unreal/Source/GxCpp/A.cpp:${i + 1}:1: error: ${"x".repeat(400)}`,
    );
    const log = [...lines, lines[0], "Result: Failed (OtherCompilationError)"].join("\n");
    const result = await compileEditor(options({ run: answering(log).run }));
    assert.equal(result.errors.length, 20);
    assert.ok(result.errors.every((e) => e.message.length <= 300));
    assert.deepEqual(
      result.errors.map((e) => e.line),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it("a build that ends without UBT's result line failed", async () => {
    const result = await compileEditor(options({ run: answering("Setting up bundled DotNet SDK\n", 1).run }));
    assert.equal(result.ok, false);
    assert.equal(result.failure, CompileFailure.Failed);
    assertNoAbsolutePaths(result);
  });
});

describe("when UBT doesn't run", () => {
  it("a Build.sh that can't start is a typed failure without its path", async () => {
    const run: RunCommand = async () => {
      throw Object.assign(new Error(`spawn ${BUILD_SH} ENOENT`), { code: "ENOENT" });
    };
    const result = await compileEditor(options({ run }));
    assert.equal(result.ok, false);
    assert.equal(result.failure, CompileFailure.NotStarted);
    assertNoAbsolutePaths(result);
  });

  it("is a typed failure off a Mac, without running anything", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const { run, calls } = answering(await fixture("first.log"));
      const result = await compileEditor(options({ run, platform }));
      assert.equal(result.ok, false);
      assert.equal(result.failure, CompileFailure.Unsupported);
      assert.equal(calls.length, 0, platform);
    }
  });

  it("refuses a module, project or engine it can't trust, without running anything", async () => {
    const rows: Array<[string, Partial<CompileOptions>]> = [
      ["a module that is an option", { module: "-Clean" }],
      ["a module with a path", { module: "../GxCpp" }],
      ["an empty module", { module: "" }],
      ["a module with a space", { module: "Gx Cpp" }],
      ["a module that is a C++ keyword", { module: "class" }],
      ["a module that clashes with the C# rules", { module: "System" }],
      ["a relative project", { projectFile: "rush/unreal/GxCpp.uproject" }],
      ["a project that isn't a .uproject", { projectFile: "/Users/me/Games/rush/unreal/GxCpp.json" }],
      ["a relative engine folder", { engineDir: "UE_5.8" }],
    ];
    for (const [label, overrides] of rows) {
      const { run, calls } = answering(await fixture("first.log"));
      const result = await compileEditor(options({ run, ...overrides }));
      assert.equal(result.failure, CompileFailure.Invalid, label);
      assert.equal(calls.length, 0, label);
      assertNoAbsolutePaths(result);
    }
  });
});

/**
 * Compiles on one runner whose runs wait until the test lets each one finish. A compile reads its
 * own clock first as it leaves the queue (its seconds don't count the wait), so `begun` is the
 * order the queue handed out slots. `started` is the order runs reached UBT: each compile reads
 * its project's folder first, so two that take free slots together start either way round. A run
 * let finish before it started finishes as soon as it starts. Whatever still waits when the test
 * ends is let finish and awaited, so a failed check can't keep the process-wide slots busy for
 * the next test, or hold the file open until the compile deadline.
 */
function gated(t: TestContext, output: string) {
  const begun: string[] = [];
  const started: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const finishes = new Map<string, () => void>();
  const released = new Set<string>();
  const compiles: Array<Promise<CompileResult>> = [];
  const waiters: Array<() => void> = [];
  let ending = false;
  const changed = () => {
    for (const wake of waiters.splice(0)) wake();
  };
  const run: RunCommand = (_file, args, { signal }) => {
    const target = args[0] ?? "";
    started.push(target);
    signals.set(target, signal);
    changed();
    return new Promise((resolve) => {
      const finish = () => resolve({ code: 0, output });
      finishes.set(target, finish);
      if (signal.aborted) resolve({ code: null, output: "" });
      if (ending || released.has(target)) finish();
      signal.addEventListener("abort", () => resolve({ code: null, output: "" }), { once: true });
    });
  };
  const clock = (target: string) => () => {
    if (!begun.includes(target)) {
      begun.push(target);
      changed();
    }
    return 0;
  };
  const until = async (seen: string[], count: number) => {
    while (seen.length < count) await new Promise<void>((wake) => waiters.push(wake));
  };
  t.after(async () => {
    ending = true;
    for (const finish of finishes.values()) finish();
    await Promise.allSettled(compiles);
  });
  return {
    begun,
    started,
    signals,
    /** Starts compiling `module` on this runner. */
    compile(module: string, overrides: Partial<CompileOptions> = {}) {
      const target = `${module}Editor`;
      const compile = compileEditor(options({ module, run, now: clock(target), ...overrides }));
      compiles.push(compile);
      return compile;
    },
    /** Lets `module`'s run finish, now or as soon as it starts. */
    release(module: string) {
      released.add(`${module}Editor`);
      finishes.get(`${module}Editor`)?.();
    },
    /** Resolves once `count` compiles have left the queue. */
    untilBegun: (count: number) => until(begun, count),
    /** Resolves once `count` runs have reached UBT. */
    untilStarted: (count: number) => until(started, count),
  };
}

describe("at most two compiles at once", () => {
  it("queues the rest in order and starts each when a slot frees", { timeout: CASE_TIMEOUT_MS }, async (t) => {
    assert.equal(MAX_PARALLEL_COMPILES, 2);
    const gate = gated(t, await fixture("builder-inc.log"));
    const compiles = ["A", "B", "C", "D"].map((module) => gate.compile(module));
    await gate.untilBegun(2);
    assert.deepEqual(gate.begun, ["AEditor", "BEditor"]);
    gate.release("B");
    await gate.untilBegun(3);
    assert.deepEqual(gate.begun, ["AEditor", "BEditor", "CEditor"]);
    gate.release("A");
    await gate.untilBegun(4);
    assert.deepEqual(gate.begun, ["AEditor", "BEditor", "CEditor", "DEditor"]);
    gate.release("C");
    gate.release("D");
    const results = await Promise.all(compiles);
    assert.ok(results.every((r) => r.ok));
  });

  it("a compile stopped while it waits leaves the queue without running, and its turn passes on", {
    timeout: CASE_TIMEOUT_MS,
  }, async (t) => {
    const gate = gated(t, await fixture("builder-inc.log"));
    const stop = new AbortController();
    const a = gate.compile("A");
    const b = gate.compile("B");
    const c = gate.compile("C", { signal: stop.signal });
    const d = gate.compile("D");
    await gate.untilBegun(2);
    stop.abort();
    const stopped = await c;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.failure, CompileFailure.Aborted);
    gate.release("A");
    await gate.untilBegun(3);
    assert.deepEqual(gate.begun, ["AEditor", "BEditor", "DEditor"]);
    gate.release("B");
    gate.release("D");
    await Promise.all([a, b, d]);
    assert.deepEqual([...gate.started].sort(), ["AEditor", "BEditor", "DEditor"], "C never ran");
  });

  it("a compile stopped while it runs is asked to end, frees its slot and says it was stopped", {
    timeout: CASE_TIMEOUT_MS,
  }, async (t) => {
    const gate = gated(t, await fixture("builder-inc.log"));
    const stop = new AbortController();
    const a = gate.compile("A", { signal: stop.signal });
    const b = gate.compile("B");
    const c = gate.compile("C");
    await gate.untilStarted(2);
    stop.abort();
    const stopped = await a;
    assert.equal(stopped.failure, CompileFailure.Aborted);
    assert.equal(gate.signals.get("AEditor")?.aborted, true);
    await gate.untilBegun(3);
    assert.deepEqual(gate.begun, ["AEditor", "BEditor", "CEditor"]);
    gate.release("B");
    gate.release("C");
    await Promise.all([b, c]);
  });
});

describe("a stop at the edges of a compile", () => {
  it("a compile stopped just as its slot is handed over never runs, and passes the slot on", {
    timeout: CASE_TIMEOUT_MS,
  }, async (t) => {
    const gate = gated(t, await fixture("builder-inc.log"));
    const stop = new AbortController();
    // The abort lands right when the slot is handed over: after its "abort" listener is removed.
    const remove = stop.signal.removeEventListener.bind(stop.signal);
    stop.signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => {
      remove(...args);
      stop.abort();
    };
    const a = gate.compile("A");
    const b = gate.compile("B");
    const c = gate.compile("C", { signal: stop.signal });
    const d = gate.compile("D");
    await gate.untilBegun(2);
    gate.release("A");
    const stopped = await c;
    assert.equal(stopped.failure, CompileFailure.Aborted);
    await gate.untilBegun(3);
    assert.deepEqual(gate.begun, ["AEditor", "BEditor", "DEditor"], "D got C's slot");
    gate.release("B");
    gate.release("D");
    await Promise.all([a, b, d]);
    assert.deepEqual([...gate.started].sort(), ["AEditor", "BEditor", "DEditor"], "C never spawned");
  });

  it("a stop that comes after UBT already succeeded keeps the success", async () => {
    const output = await fixture("builder-inc.log");
    const stop = new AbortController();
    const run: RunCommand = async () => {
      stop.abort();
      return { code: 0, output };
    };
    const result = await compileEditor(options({ run, signal: stop.signal }));
    assert.equal(result.ok, true);
    assert.equal(result.failure, undefined);
  });
});

describe("a compile stopped or late", () => {
  it("a compile already stopped never runs", async () => {
    const { run, calls } = answering(await fixture("first.log"));
    const result = await compileEditor(options({ run, signal: AbortSignal.abort() }));
    assert.equal(result.failure, CompileFailure.Aborted);
    assert.equal(calls.length, 0);
  });

  it("a compile past its deadline is ended and says so", async (t) => {
    const gate = gated(t, await fixture("builder-inc.log"));
    const result = await gate.compile("Slow", { timeoutMs: 20 });
    assert.equal(result.ok, false);
    assert.equal(result.failure, CompileFailure.TimedOut);
    assert.equal(result.retryable, false);
    assert.equal(gate.signals.get("SlowEditor")?.aborted, true, "the runner was told to end the build");
  });
});

/** The stand-in sandboxes the runner's tests made, removed once they ran. */
const standIns: Array<() => Promise<void>> = [];

/** A build sandbox for a stand-in project in a temp folder. */
async function standInSandbox() {
  const root = await tmpDir("studio-ubt-runner-");
  const sandbox = await prepareBuildSandbox({
    projectDir: path.join(root, "unreal"),
    engineDir: path.join(root, "engine"),
    xcodeApp: null,
  });
  standIns.push(sandbox.dispose);
  return sandbox;
}

describe("the system runner", { skip: process.platform === "darwin" ? false : "macOS's sandbox-exec" }, () => {
  after(async () => {
    for (const dispose of standIns) await dispose();
  });

  it("returns a program's stdout and stderr together, with its exit code", async () => {
    const outcome = await systemRunCommand("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 3"], {
      signal: new AbortController().signal,
      sandbox: await standInSandbox(),
    });
    assert.equal(outcome.code, 3);
    assert.match(outcome.output, /out/);
    assert.match(outcome.output, /err/);
  });

  it("ends the whole process tree when stopped", async () => {
    const stop = new AbortController();
    const sandbox = await standInSandbox();
    // The build writes only its own scratch, so the grandchild's id goes there.
    const pidFile = path.join(sandbox.env.TMPDIR ?? "", "grandchild.pid");
    const script = `sleep 30 & echo $! > "$1"; wait`;
    const outcome = systemRunCommand("/bin/sh", ["-c", script, "sh", pidFile], { signal: stop.signal, sandbox });
    let grandchild = 0;
    for (let i = 0; i < 100 && grandchild === 0; i++) {
      await sleep(20);
      grandchild = Number((await readFile(pidFile, "utf8").catch(() => "")).trim() || 0);
    }
    assert.ok(grandchild > 0 && running(grandchild), "the background sleep started");
    stop.abort();
    await outcome;
    for (let i = 0; i < 50 && running(grandchild); i++) await sleep(20);
    assert.equal(running(grandchild), false, "the grandchild is gone too");
  });
});

describe("whether C++ is possible", () => {
  it("needs a Mac with Xcode ready", () => {
    const rows: Array<[XcodeState, NodeJS.Platform, boolean]> = [
      [XcodeState.Ready, "darwin", true],
      [XcodeState.Missing, "darwin", false],
      [XcodeState.NotSelected, "darwin", false],
      [XcodeState.FirstLaunch, "darwin", false],
      [XcodeState.Unsupported, "darwin", false],
      [XcodeState.NotApplicable, "win32", false],
      [XcodeState.Ready, "linux", false],
    ];
    for (const [state, platform, ready] of rows)
      assert.equal(canCompileCpp({ state }, platform), ready, `${state} ${platform}`);
  });
});
