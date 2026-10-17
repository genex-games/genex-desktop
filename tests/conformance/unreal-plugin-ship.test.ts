/**
 * Shipping an Unreal plugin with the Unreal plugin's tools: `plugin-build` saves the person's work,
 * closes the open editor, builds the host project and its plugin as a background job and opens
 * Unreal again after a good build; `plugin-test` runs the plugin's automation tests headless as a
 * job and keeps a summary; `plugin-package` runs BuildPlugin in UnrealBuildTool's sandbox as a job and
 * keeps a note of the package; `plugin-status` says how each stands and lists the proof a finish can
 * name, by paths inside the game. One job runs at a time per project, and stopping one (or the
 * backend stopping) ends its whole process group. Unreal, UBT, UAT and the editor are stand-ins;
 * only one case starts a real program (a shell), to see its process group end.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import {
  automationArgs,
  type ProgramOutcome,
  type RunProgram,
  systemRunProgram,
} from "../../src/plugins/unreal/automation-tests.ts";
import { CppEditorTool } from "../../src/plugins/unreal/cpp-tools.ts";
import { ReopenState } from "../../src/plugins/unreal/editor-reopen.ts";
import { createLoopTools, LoopToolName } from "../../src/plugins/unreal/loop-tools.ts";
import { ShipState, ShipToolName } from "../../src/plugins/unreal/plugin-ship.ts";
import { type BuildSandboxRequest, prepareBuildSandbox } from "../../src/plugins/unreal/ubt-sandbox.ts";
import {
  CompileFailure,
  type CompileOptions,
  type CompileResult,
  type PrepareSandbox,
  type RunCommand,
} from "../../src/plugins/unreal/ubt.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { tree } from "../helpers/unreal-fake-engine.ts";

const PLUGIN = "LevelTools";
const HOST = "LevelToolsHost";
const XCODE_APP = "/Applications/Xcode-26.2.app";
const BUILT: CompileResult = {
  ok: true,
  seconds: 40,
  errors: [],
  summary: "LevelToolsHostEditor built in 40 s.",
  retryable: false,
};
const BROKEN: CompileResult = {
  ok: false,
  seconds: 7,
  errors: [
    {
      file: "Plugins/LevelTools/Source/LevelTools/Private/LevelTools.cpp",
      line: 9,
      column: 2,
      message: "use of undeclared identifier 'FSlateIcn'",
    },
  ],
  summary: "LevelToolsHostEditor didn't build (OtherCompilationError): 1 error.",
  failure: CompileFailure.Failed,
  retryable: false,
};
const SAVED = { saved: true, dirty: [], ms: 30 };
/** How long the stand-in Unreal takes to close after the quit, and to answer after it opens. */
const QUIT_TAKES_MS = 6_000;
const OPEN_TAKES_MS = 20_000;
const SEPARATE_LINKS = process.platform === "win32" && "links need privileges on Windows";
const PROCESS_GROUPS = process.platform === "win32" && "process groups are POSIX";
/** How long a forked backend may take to import itself and start its job (a slow CI runner included). */
const BACKEND_START_MS = 20_000;

/** Automation's report: two passes and a failure with its error. */
const REPORT = {
  succeeded: 2,
  failed: 1,
  notRun: 0,
  tests: [
    { testDisplayName: "Opens", fullTestPath: "LevelTools.Window.Opens", state: "Success", entries: [] },
    { testDisplayName: "Lists", fullTestPath: "LevelTools.Window.Lists", state: "Success", entries: [] },
    {
      testDisplayName: "Snaps",
      fullTestPath: "LevelTools.Grid.Snaps",
      state: "Fail",
      entries: [
        { event: { type: "Error", message: "Expected 16, got 15" } },
        { event: { type: "Info", message: "ran" } },
      ],
    },
  ],
};

type Options = {
  /** Unreal open on the game when the test starts (default), or closed. */
  open?: boolean;
  compile?: (options: CompileOptions) => Promise<CompileResult> | CompileResult;
  runProgram?: RunProgram;
  runCommand?: RunCommand;
  /** More plugins under Plugins/ besides LevelTools and the Genex editor helper. */
  plugins?: string[];
  /** A wait for Unreal to close, once it was asked to quit, goes on until this settles. */
  quitGate?: Promise<void>;
  /** The host project has its own C++ module (default), or none yet. */
  module?: boolean;
};

/** Settles a background job: yields until `done` says so. */
async function until(done: () => Promise<boolean>) {
  for (let i = 0; i < 20_000; i++) {
    if (await done()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("never settled");
}

/** The ReportExportPath an automation run was handed. */
const reportDirOf = (args: readonly string[]) =>
  (args.find((arg) => arg.startsWith("-ReportExportPath=")) ?? "").slice("-ReportExportPath=".length);
/** One `-Name=value` argument's value. */
const argOf = (args: readonly string[], name: string) =>
  (args.find((arg) => arg.startsWith(`-${name}=`)) ?? "").slice(name.length + 2);

/** A host project with its plugin and the Genex editor helper, in a game, open in a stand-in Unreal, through the plugin's tools. */
async function shipWorld(options: Options = {}) {
  const root = await realpath(await tmpDir("studio-plugin-ship-"));
  const game = path.join(root, "game");
  const unreal = path.join(game, "unreal");
  const storage = path.join(root, "storage");
  const engineDir = path.join(root, "engine");
  const outside = path.join(root, "outside");
  const scratch = path.join(root, "scratch");
  const projectFile = path.join(unreal, `${HOST}.uproject`);
  for (const dir of [storage, engineDir, outside, scratch]) await mkdir(dir, { recursive: true });
  const descriptor = (name: string) =>
    `${JSON.stringify({ FileVersion: 3, VersionName: "1.2", FriendlyName: name }, null, "\t")}\n`;
  for (const name of [PLUGIN, "GenexEditorHelper", ...(options.plugins ?? [])]) {
    await mkdir(path.join(unreal, "Plugins", name), { recursive: true });
    await writeFile(path.join(unreal, "Plugins", name, `${name}.uplugin`), descriptor(name));
  }
  await writeFile(
    projectFile,
    `${JSON.stringify({ FileVersion: 3, ...(options.module === false ? {} : { Modules: [{ Name: HOST, Type: "Runtime" }] }), Plugins: [{ Name: PLUGIN, Enabled: true }] }, null, "\t")}\n`,
  );
  const events: string[] = [];
  const compiles: CompileOptions[] = [];
  const programs: Array<{ file: string; args: readonly string[]; signal: AbortSignal }> = [];
  const commands: Array<{ file: string; args: readonly string[]; env: Record<string, string>; signal: AbortSignal }> =
    [];
  const sandboxes: BuildSandboxRequest[] = [];
  const clock = { at: 0 };
  const open = options.open ?? true;
  const editor = {
    running: open,
    answering: open,
    quitAt: undefined as number | undefined,
    openAt: undefined as number | undefined,
  };
  const settle = () => {
    if (editor.quitAt !== undefined && clock.at >= editor.quitAt + QUIT_TAKES_MS)
      Object.assign(editor, { running: false, answering: false, quitAt: undefined });
    if (editor.openAt !== undefined && clock.at >= editor.openAt + OPEN_TAKES_MS)
      Object.assign(editor, { running: true, answering: true, openAt: undefined });
  };
  const runProgram: RunProgram =
    options.runProgram ??
    (async (file, args, { signal }) => {
      programs.push({ file, args, signal });
      await writeFile(path.join(reportDirOf(args), "index.json"), `﻿${JSON.stringify(REPORT)}`);
      return { code: 0, output: "Automation Test Queue Empty", timedOut: false };
    });
  const prepareSandbox: PrepareSandbox = async (request) => {
    sandboxes.push(request);
    return {
      profile: path.join(scratch, "ubt.sb"),
      env: { HOME: path.join(scratch, "home") },
      cwd: scratch,
      dispose: async () => {},
    };
  };
  const runCommand: RunCommand =
    options.runCommand ??
    (async (file, args, { signal, sandbox }) => {
      commands.push({ file, args, env: sandbox.env, signal });
      const packaged = argOf(args, "Package");
      await mkdir(path.join(packaged, "Binaries", "Mac"), { recursive: true });
      await writeFile(path.join(packaged, `${PLUGIN}.uplugin`), descriptor(PLUGIN));
      await writeFile(path.join(packaged, "Binaries", "Mac", "UnrealEditor-LevelTools.dylib"), "x".repeat(2048));
      return {
        code: 0,
        output: "Building plugin...\nBUILD SUCCESSFUL\nAutomationTool exiting with ExitCode=0 (Success)\n",
      };
    });
  const stopped = new AbortController();
  const deps = {
    platform: "darwin" as const,
    engine: async () => ({ version: "5.8", directory: engineDir }),
    project: async () => projectFile,
    xcode: async () => ({ state: XcodeState.Ready, app: XCODE_APP }),
    compile: async (compile: CompileOptions) => {
      events.push("compile");
      compiles.push(compile);
      assert.equal(editor.running, false, "UBT builds the host only with Unreal closed");
      return options.compile ? options.compile(compile) : BUILT;
    },
    runProgram: async (...call: Parameters<RunProgram>) => {
      events.push("test");
      return runProgram(...call);
    },
    runCommand: async (...call: Parameters<RunCommand>) => {
      events.push("package");
      return runCommand(...call);
    },
    prepareSandbox,
    stopped: stopped.signal,
    editorCall: async (_storage: string, _game: string, tool: string) => {
      events.push(tool);
      if (tool === CppEditorTool.SaveAll) return SAVED;
      throw new Error(`no stand-in for ${tool}`);
    },
    editorAnswers: async () => {
      settle();
      return editor.answering;
    },
    restart: {
      editors: async () => {
        settle();
        return editor.running ? 1 : 0;
      },
      quit: async (_storage: string, project: string) => {
        events.push(`quit ${path.basename(project)}`);
        editor.quitAt = clock.at;
        editor.answering = false;
      },
      open: async (_storage: string, project: string) => {
        events.push(`open ${path.basename(project)}`);
        editor.running = true;
        editor.openAt = clock.at;
      },
    },
    now: () => clock.at,
    sleep: async (ms: number) => {
      // A wait for Unreal to close goes on until the test lets it.
      if (editor.quitAt !== undefined) await options.quitGate;
      clock.at += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  const context: PluginContext = {
    project: "level-tools",
    directory: game,
    signal: new AbortController().signal,
    callId: 1,
    host: (async () => storage) as never,
  };
  const toolsOf = () => createLoopTools(deps as never);
  let tools = toolsOf();
  const call = (name: string, args: Record<string, unknown> = {}) => tools.call(name as never, args, context, storage);
  /** A call whose own signal (the person's Stop, the host's ceiling) is `signal`. */
  const callWith = (name: string, args: Record<string, unknown>, signal: AbortSignal) =>
    tools.call(name as never, args, { ...context, signal }, storage);
  type Status = {
    plugin: string;
    build: { state: string; error?: string; seconds?: number };
    test: {
      state: string;
      passed?: number;
      failed?: number;
      notRun?: number;
      failures?: unknown[];
      report?: string;
      line?: string;
      error?: string;
    };
    package: { state: string; package?: string; note?: string; error?: string; line?: string };
    proof: string[];
  };
  const status = async (args: Record<string, unknown> = {}) => (await call(ShipToolName.PluginStatus, args)) as Status;
  /** The status once `kind`'s job no longer runs. */
  const settled = async (kind: "build" | "test" | "package") => {
    await until(async () => (await status())[kind].state !== ShipState.Running);
    return status();
  };
  /** A backend started again: no job in memory, only what is on disk. */
  const restart = () => {
    tools = toolsOf();
  };
  return {
    root,
    game,
    unreal,
    outside,
    engineDir,
    scratch,
    projectFile,
    editor,
    events,
    compiles,
    programs,
    commands,
    sandboxes,
    stopped,
    call,
    callWith,
    status,
    settled,
    restart,
  };
}

describe("plugin-build", () => {
  it("plugin-build saves and closes the open editor, then builds the host and its plugin as a job and opens it again", async () => {
    const w = await shipWorld();
    assert.deepEqual(await w.call(ShipToolName.PluginBuild), { started: true });
    assert.deepEqual(
      w.events.slice(0, 2),
      [CppEditorTool.SaveAll, `quit ${HOST}.uproject`],
      "the call saves and closes Unreal",
    );
    const done = await w.settled("build");
    assert.equal(done.build.state, ShipState.Done);
    assert.deepEqual(w.events, [CppEditorTool.SaveAll, `quit ${HOST}.uproject`, "compile", `open ${HOST}.uproject`]);
    const [compiled] = w.compiles;
    assert.equal(compiled?.module, HOST, "the host's editor target, which builds its plugins too");
    assert.equal(compiled?.projectFile, w.projectFile);
    assert.equal(compiled?.xcodeApp, XCODE_APP);
    assert.ok(w.editor.answering, "Unreal answers again");

    const failing = await shipWorld({ compile: () => BROKEN });
    await failing.call(ShipToolName.PluginBuild, { plugin: PLUGIN });
    const failed = await failing.settled("build");
    assert.equal(failed.build.state, ShipState.Failed);
    assert.match(failed.build.error ?? "", /LevelTools\.cpp:9: use of undeclared identifier/);
    assert.match(failed.build.error ?? "", /Unreal stays closed/);
    assert.deepEqual(failing.events.slice(-1), ["compile"], "Unreal isn't opened after a failed build");
    assert.equal(failing.editor.running, false);
  });
});

describe("plugin-test", () => {
  it("plugin-test runs the plugin's tests headless as a job and reports passes and failures", async () => {
    const w = await shipWorld();
    const tests = path.join(w.unreal, "Saved", "Genex", "Tests", PLUGIN);
    await mkdir(tests, { recursive: true });
    await writeFile(path.join(tests, "stale.json"), "{}");
    assert.deepEqual(await w.call(ShipToolName.PluginTest), { started: true, filter: PLUGIN });
    const done = await w.settled("test");
    assert.equal(done.test.state, ShipState.Done);
    assert.deepEqual([done.test.passed, done.test.failed, done.test.notRun], [2, 1, 0]);
    assert.deepEqual(done.test.failures, [{ name: "LevelTools.Grid.Snaps", messages: ["Expected 16, got 15"] }]);
    assert.equal(done.test.report, `unreal/Saved/Genex/Tests/${PLUGIN}/summary.md`);
    const [run] = w.programs;
    assert.equal(run?.file, path.join(w.engineDir, "Engine", "Binaries", "Mac", "UnrealEditor-Cmd"));
    assert.deepEqual(run?.args, automationArgs(w.projectFile, PLUGIN, tests));
    for (const arg of [
      "-ExecCmds=Automation RunTests LevelTools",
      "-nullrhi",
      "-unattended",
      `-ReportExportPath=${tests}`,
    ])
      assert.ok(run?.args.includes(arg), arg);
    assert.ok(!existsSync(path.join(tests, "stale.json")), "the report folder starts empty");
    const summary = await readFile(path.join(tests, "summary.md"), "utf8");
    assert.match(summary, /2 passed, 1 failed, 0 not run/);
    assert.match(summary, /LevelTools\.Grid\.Snaps: Expected 16, got 15/);
    assert.equal(w.editor.running, true, "the tests run beside the open editor");

    // Without a report, the lines Automation printed are read.
    const printed = await shipWorld({
      runProgram: async () => ({
        code: 0,
        output: [
          "LogAutomationController: Display: Test Completed. Result={Success} Name={Opens} Path={LevelTools.Window.Opens}",
          "LogAutomationController: Display: Test Completed. Result={Fail} Name={Snaps} Path={LevelTools.Grid.Snaps}",
        ].join("\n"),
        timedOut: false,
      }),
    });
    await printed.call(ShipToolName.PluginTest, { filter: "LevelTools.Window" });
    const read = await printed.settled("test");
    assert.deepEqual([read.test.passed, read.test.failed], [1, 1]);
    assert.deepEqual(read.test.failures, [{ name: "LevelTools.Grid.Snaps", messages: [] }]);
  });

  it("no automation tests matched is said, with where to write them", async () => {
    const w = await shipWorld({
      runProgram: async (_file, args) => {
        await writeFile(
          path.join(reportDirOf(args), "index.json"),
          JSON.stringify({ succeeded: 0, failed: 0, notRun: 0, tests: [] }),
        );
        return { code: 0, output: "No automation tests matched", timedOut: false };
      },
    });
    await w.call(ShipToolName.PluginTest);
    const done = await w.settled("test");
    const words =
      "no tests matched LevelTools: write them under Source/LevelTools/Private/Tests/ with names starting LevelTools.";
    assert.equal(done.test.line, words);
    const summary = await readFile(path.join(w.unreal, "Saved", "Genex", "Tests", PLUGIN, "summary.md"), "utf8");
    assert.ok(summary.includes(words), summary);
  });
});

describe("plugin-package", () => {
  it("plugin-package runs BuildPlugin in the build sandbox and reports the package path", async () => {
    const w = await shipWorld();
    assert.deepEqual(await w.call(ShipToolName.PluginPackage), { started: true });
    const done = await w.settled("package");
    assert.equal(done.package.state, ShipState.Done, done.package.error);
    const packageDir = path.join(w.unreal, "Saved", "Genex", "Packages", PLUGIN);
    const [run] = w.commands;
    assert.equal(run?.file, path.join(w.engineDir, "Engine", "Build", "BatchFiles", "RunUAT.sh"));
    assert.deepEqual(run?.args, [
      "BuildPlugin",
      `-Plugin=${path.join(w.unreal, "Plugins", PLUGIN, `${PLUGIN}.uplugin`)}`,
      `-Package=${packageDir}`,
      "-TargetPlatforms=Mac",
      "-NoP4",
    ]);
    assert.equal(run?.env.uebp_LogFolder, path.join(w.scratch, "uat-logs"), "UAT logs in the sandbox's scratch");
    assert.deepEqual(w.sandboxes, [
      { projectDir: w.unreal, engineDir: w.engineDir, xcodeApp: XCODE_APP, extraWrites: [packageDir] },
    ]);
    assert.equal(done.package.package, `unreal/Saved/Genex/Packages/${PLUGIN}`);
    assert.equal(done.package.note, `unreal/Saved/Genex/Packages/${PLUGIN}.md`);
    const note = await readFile(path.join(w.unreal, "Saved", "Genex", "Packages", `${PLUGIN}.md`), "utf8");
    assert.match(note, /unreal\/Saved\/Genex\/Packages\/LevelTools/);
    assert.match(note, /Version: 1\.2/);
    assert.match(note, /2 files/);
    assert.match(note, /Platforms: Mac/);
    assert.doesNotMatch(note, new RegExp(w.root.replaceAll("/", "\\/")), "no absolute path");

    // The proof a finish can name: the test summary and the package note, and the window's picture once kept.
    await w.call(ShipToolName.PluginTest);
    await w.settled("test");
    const shots = path.join(w.unreal, "Saved", "Genex", "Shots");
    await mkdir(shots, { recursive: true });
    await writeFile(path.join(shots, `${PLUGIN}-window.jpg`), "jpeg");
    const proof = [
      `unreal/Saved/Genex/Tests/${PLUGIN}/summary.md`,
      `unreal/Saved/Genex/Packages/${PLUGIN}.md`,
      `unreal/Saved/Genex/Shots/${PLUGIN}-window.jpg`,
    ];
    assert.deepEqual((await w.status()).proof, proof);
    w.restart();
    const after = await w.status();
    assert.deepEqual(after.proof, proof, "a backend started again reads the notes from disk");
    assert.equal(after.test.report, proof[0]);
    assert.equal(after.package.note, proof[1]);

    // The sandbox opens the package folder for writing only when it is a real folder in the project.
    const home = path.join(w.root, "home");
    await mkdir(home);
    const prepared = await prepareBuildSandbox({
      projectDir: w.unreal,
      engineDir: w.engineDir,
      xcodeApp: null,
      home,
      extraWrites: [packageDir],
    });
    try {
      assert.ok((await readFile(prepared.profile, "utf8")).includes(`(subpath "${packageDir}")`));
    } finally {
      await prepared.dispose();
    }
    await assert.rejects(
      prepareBuildSandbox({
        projectDir: w.unreal,
        engineDir: w.engineDir,
        xcodeApp: null,
        home,
        extraWrites: [w.outside],
      }),
    );

    const failing = await shipWorld({
      runCommand: async () => ({
        code: 1,
        output: "ERROR: Unable to find plugin dependency 'Paper2D'\nBUILD FAILED\n",
      }),
    });
    await failing.call(ShipToolName.PluginPackage, { plugin: PLUGIN });
    const failed = await failing.settled("package");
    assert.equal(failed.package.state, ShipState.Failed);
    assert.match(failed.package.error ?? "", /Paper2D/);
    const failedNote = await readFile(path.join(failing.unreal, "Saved", "Genex", "Packages", `${PLUGIN}.md`), "utf8");
    assert.match(failedNote, /Paper2D/);
  });
});

describe("the plugin's jobs", () => {
  /** A stand-in program that runs until its signal ends it, recording that it was ended. */
  function holding(ended: string[], name: string) {
    let started = false;
    const run = async (signal: AbortSignal): Promise<ProgramOutcome> => {
      started = true;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      ended.push(name);
      return { code: null, output: "", timedOut: false };
    };
    return { run, started: () => started };
  }

  it("one job at a time per project", async () => {
    const ended: string[] = [];
    const test = holding(ended, "test");
    const w = await shipWorld({ runProgram: (_file, _args, { signal }) => test.run(signal) });
    await w.call(ShipToolName.PluginTest);
    await until(async () => test.started());
    assert.deepEqual(
      await w.call(ShipToolName.PluginTest),
      { started: true, filter: PLUGIN },
      "asked again, the same job",
    );
    await assert.rejects(w.call(ShipToolName.PluginPackage), /tests are running/);
    await assert.rejects(w.call(ShipToolName.PluginBuild), /tests are running/);
    assert.deepEqual(
      w.events.filter((event) => event !== "test"),
      [],
      "nothing else started, and Unreal wasn't touched",
    );
    assert.equal(w.events.filter((event) => event === "test").length, 1, "one test run");
    await w.call(ShipToolName.PluginTest, { stop: true });
  });

  it("stop ends a running job's process group, and so does the backend stopping", {
    skip: PROCESS_GROUPS,
  }, async () => {
    const ended: string[] = [];
    const test = holding(ended, "test");
    const w = await shipWorld({
      runProgram: (_file, _args, { signal }) => test.run(signal),
      runCommand: async (_file, _args, { signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        ended.push("package");
        return { code: null, output: "" };
      },
    });
    await w.call(ShipToolName.PluginTest);
    await until(async () => test.started());
    assert.deepEqual(await w.call(ShipToolName.PluginTest, { stop: true }), { stopped: true });
    assert.equal((await w.settled("test")).test.state, ShipState.Stopped);
    assert.deepEqual(await w.call(ShipToolName.PluginTest, { stop: true }), { stopped: false }, "nothing runs now");
    await w.call(ShipToolName.PluginPackage);
    await until(async () => w.commands.length > 0 || w.events.includes("package"));
    w.stopped.abort();
    assert.equal((await w.settled("package")).package.state, ShipState.Stopped);
    assert.deepEqual(ended, ["test", "package"]);

    // The product's runner ends the program and everything it started.
    const root = await realpath(await tmpDir("studio-run-program-"));
    const pidFile = path.join(root, "child.pid");
    const stop = new AbortController();
    const program = systemRunProgram("/bin/sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], {
      signal: stop.signal,
      timeoutMs: 60_000,
    });
    await until(async () => existsSync(pidFile) && (await readFile(pidFile, "utf8")).trim() !== "");
    const child = Number((await readFile(pidFile, "utf8")).trim());
    stop.abort();
    await program;
    for (let i = 0; i < 100 && running(child); i++) await pause(20);
    assert.equal(running(child), false, "the shell's own child ended with it");
  });

  it("a hostile plugin name or test filter starts nothing", { skip: SEPARATE_LINKS }, async () => {
    type Row = [
      string,
      string,
      Record<string, unknown>,
      ((w: Awaited<ReturnType<typeof shipWorld>>) => Promise<void>)?,
    ];
    const rows: Row[] = [
      ...[
        "../LevelTools",
        "Level/Tools",
        "Plugins/LevelTools",
        "GenexEditorHelper",
        "Nope",
        "",
        "A".repeat(65),
        "Level Tools",
      ].map((plugin): Row => [`the plugin ${JSON.stringify(plugin)}`, ShipToolName.PluginBuild, { plugin }]),
      ["a plugin name that isn't text", ShipToolName.PluginPackage, { plugin: 42 }],
      [
        "a plugin folder that is a link out of the project",
        ShipToolName.PluginTest,
        { plugin: "Linked" },
        async (w) => {
          await writeFile(path.join(w.outside, "Linked.uplugin"), "{}");
          await symlink(w.outside, path.join(w.unreal, "Plugins", "Linked"));
        },
      ],
      ...["a b", "x;y", "../x", "", "a".repeat(81), "LevelTools*", "-ExecCmds=Quit"].map(
        (filter): Row => [`the filter ${JSON.stringify(filter)}`, ShipToolName.PluginTest, { filter }],
      ),
      ["a filter that isn't text", ShipToolName.PluginTest, { filter: 7 }],
      [
        "a Saved folder that is a link out of the project",
        ShipToolName.PluginTest,
        {},
        (w) => symlink(w.outside, path.join(w.unreal, "Saved")),
      ],
      [
        "a package folder on the way that is a link out",
        ShipToolName.PluginPackage,
        {},
        async (w) => {
          await mkdir(path.join(w.unreal, "Saved", "Genex"), { recursive: true });
          await symlink(w.outside, path.join(w.unreal, "Saved", "Genex", "Packages"));
        },
      ],
    ];
    for (const [label, tool, args, arrange] of rows) {
      const w = await shipWorld();
      await arrange?.(w);
      const before = await tree(w.unreal);
      const outsideBefore = await tree(w.outside);
      await assert.rejects(w.call(tool, args), label);
      assert.deepEqual(w.events, [], `${label}: nothing ran and Unreal wasn't touched`);
      assert.deepEqual(await tree(w.unreal), before, `${label}: the project is unchanged`);
      assert.deepEqual(await tree(w.outside), outsideBefore, `${label}: nothing outside changed`);
    }
    const several = await shipWorld({ plugins: ["Snap"] });
    await assert.rejects(several.call(ShipToolName.PluginTest), /LevelTools, Snap/, "several plugins: name one");
    assert.deepEqual(several.events, []);
  });
});

/** A gate a test opens itself. */
function gate() {
  let open: () => void = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open };
}

describe("the plugin's jobs, close together", () => {
  it("a build is Genex's own restart from before it quits Unreal, and a job asked meanwhile starts nothing", async () => {
    const quit = gate();
    const w = await shipWorld({ quitGate: quit.shut });
    const building = w.call(ShipToolName.PluginBuild);
    await until(async () => w.events.includes(`quit ${HOST}.uproject`));
    const state = (await w.call(LoopToolName.EditorState)) as { reopening: { state: string } };
    assert.equal(state.reopening.state, ReopenState.Reopening, "the health look reads Genex's own restart");
    await assert.rejects(w.call(ShipToolName.PluginTest), /the plugin is building/);
    quit.open();
    assert.deepEqual(await building, { started: true });
    assert.equal((await w.settled("build")).build.state, ShipState.Done);
    assert.ok(!w.events.includes("test"), "no tests ran");
    assert.ok(w.editor.answering, "and Unreal is open again");
  });

  it("two calls close together start one job; a test and a package asked together start one", async () => {
    const ended: string[] = [];
    let runs = 0;
    const w = await shipWorld({
      runProgram: async (_file, _args, { signal }) => {
        runs += 1;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        ended.push("test");
        return { code: null, output: "", timedOut: false };
      },
    });
    const both = await Promise.all([w.call(ShipToolName.PluginTest), w.call(ShipToolName.PluginTest)]);
    assert.deepEqual(both, [
      { started: true, filter: PLUGIN },
      { started: true, filter: PLUGIN },
    ]);
    await until(async () => runs > 0);
    await pause(20);
    assert.equal(runs, 1, "one test run");
    assert.deepEqual(await w.call(ShipToolName.PluginTest, { stop: true }), { stopped: true });
    assert.equal((await w.settled("test")).test.state, ShipState.Stopped);
    assert.deepEqual(ended, ["test"], "and stop ended it");

    const v = await shipWorld();
    const asked = await Promise.allSettled([v.call(ShipToolName.PluginTest), v.call(ShipToolName.PluginPackage)]);
    assert.deepEqual(
      asked.map((answer) => answer.status).sort(),
      ["fulfilled", "rejected"],
      "whichever comes second is refused while the first runs",
    );
    await until(async () => v.programs.length + v.commands.length > 0);
    await pause(20);
    assert.equal(v.programs.length + v.commands.length, 1, "one job started");
  });

  it("a plugin build is refused while Genex reopens the project's Unreal", async () => {
    const compiled = gate();
    let compiles = 0;
    const w = await shipWorld({
      open: false,
      compile: async () => {
        compiles += 1;
        await compiled.shut;
        return BUILT;
      },
    });
    assert.deepEqual(await w.call(LoopToolName.ReopenEditor), { started: true });
    await until(async () => compiles > 0);
    await assert.rejects(w.call(ShipToolName.PluginBuild), /restarting Unreal/);
    compiled.open();
    assert.equal(compiles, 1, "one build of the project at a time");
  });

  it("a plugin build is refused while Genex adds the project's C++ module", async () => {
    const compiled = gate();
    let compiles = 0;
    const w = await shipWorld({
      module: false,
      compile: async () => {
        compiles += 1;
        await compiled.shut;
        return BUILT;
      },
    });
    assert.deepEqual(await w.call(LoopToolName.AddCppModule), { started: true });
    await until(async () => compiles > 0);
    const quits = w.events.filter((event) => event.startsWith("quit")).length;
    await assert.rejects(w.call(ShipToolName.PluginBuild), /restarting Unreal/);
    compiled.open();
    assert.equal(compiles, 1, "one build of the project at a time");
    assert.equal(w.events.filter((event) => event.startsWith("quit")).length, quits, "Unreal was not quit again");
  });

  it("a build call stopped while Unreal closes builds nothing and opens Unreal again", async () => {
    const quit = gate();
    const w = await shipWorld({ quitGate: quit.shut });
    const stop = new AbortController();
    const building = w.callWith(ShipToolName.PluginBuild, {}, stop.signal);
    await until(async () => w.events.includes(`quit ${HOST}.uproject`));
    stop.abort();
    quit.open();
    await assert.rejects(building, /Stopped/);
    await until(async () => w.events.includes(`open ${HOST}.uproject`));
    assert.ok(!w.events.includes("compile"), "nothing was built");
    assert.equal((await w.status()).build.state, ShipState.Idle);

    const early = await shipWorld();
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(early.callWith(ShipToolName.PluginBuild, {}, stopped.signal), /Stopped/);
    assert.deepEqual(early.events, [], "a call stopped before it began touches nothing");
    const tests = path.join(early.unreal, "Saved", "Genex", "Tests", PLUGIN);
    await mkdir(tests, { recursive: true });
    await writeFile(path.join(tests, "summary.md"), "the last run");
    await assert.rejects(early.callWith(ShipToolName.PluginTest, {}, stopped.signal), /Stopped/);
    await assert.rejects(early.callWith(ShipToolName.PluginPackage, {}, stopped.signal), /Stopped/);
    assert.equal(await readFile(path.join(tests, "summary.md"), "utf8"), "the last run", "the last summary is kept");
    assert.deepEqual(early.events, []);
  });
});

describe("what a job leaves", () => {
  it("a headless editor that exits before the tests finish is a failed run, never proof", async () => {
    const crashed = await shipWorld({
      runProgram: async () => ({
        code: null,
        output: [
          "LogAutomationController: Display: Test Completed. Result={Success} Name={Opens} Path={LevelTools.Window.Opens}",
          "LogAutomationController: Display: Test Completed. Result={Success} Name={Lists} Path={LevelTools.Window.Lists}",
          "LogCore: Error: Unhandled Exception: SIGSEGV",
        ].join("\n"),
        timedOut: false,
      }),
    });
    await crashed.call(ShipToolName.PluginTest);
    const after = await crashed.settled("test");
    assert.equal(after.test.state, ShipState.Failed);
    assert.match(after.test.error ?? "", /exited/);
    assert.match(after.test.error ?? "", /2 passed/, "the partial counts");
    assert.match(after.test.error ?? "", /SIGSEGV/, "and its last lines");
    assert.deepEqual(after.proof, [], "never listed as proof");

    const refused = await shipWorld({ runProgram: async () => ({ code: 1, output: "", timedOut: false }) });
    await refused.call(ShipToolName.PluginTest);
    const failed = await refused.settled("test");
    assert.equal(failed.test.state, ShipState.Failed);
    assert.match(failed.test.error ?? "", /exited with code 1/);
    assert.doesNotMatch(failed.test.error ?? "", /no tests matched/, "never read as tests to write");
    assert.deepEqual(failed.proof, []);
  });

  it("no absolute path of the computer reaches an agent from a test run's output or report", async () => {
    const home = "/Users/someone/Library/Logs/DiagnosticReports";
    const crashed = await shipWorld({
      runProgram: async () => ({
        code: null,
        output: [
          `LogCore: Error: Unhandled Exception: SIGSEGV at ${home}/UnrealEditor-Cmd.crash`,
          "LogCore: Error: in /Users/someone/Unreal/Engine/Source/Runtime/Core/Private/Misc/Assert.cpp:12",
        ].join("\n"),
        timedOut: false,
      }),
    });
    await crashed.call(ShipToolName.PluginTest);
    const after = await crashed.settled("test");
    const summary = await readFile(path.join(crashed.unreal, "Saved", "Genex", "Tests", PLUGIN, "summary.md"), "utf8");
    for (const said of [JSON.stringify(after), summary]) {
      assert.doesNotMatch(said, /\/Users\//, "no home path");
      assert.match(said, /UnrealEditor-Cmd\.crash/, "the file's base name stays");
    }

    const failing = await shipWorld({
      runProgram: async (_file, args) => {
        const inProject = path.join(path.dirname(reportDirOf(args)), "..", "..", "..", "Plugins", PLUGIN, "Source");
        const report = {
          tests: [
            {
              fullTestPath: "LevelTools.Grid.Snaps",
              state: "Fail",
              entries: [
                {
                  event: {
                    type: "Error",
                    message: `Expected 16 at ${path.resolve(inProject)}/Grid.cpp, see ${home}/a.log`,
                  },
                },
              ],
            },
          ],
        };
        await writeFile(path.join(reportDirOf(args), "index.json"), JSON.stringify(report));
        return { code: 1, output: "", timedOut: false };
      },
    });
    await failing.call(ShipToolName.PluginTest);
    const done = await failing.settled("test");
    const written = await readFile(path.join(failing.unreal, "Saved", "Genex", "Tests", PLUGIN, "summary.md"), "utf8");
    for (const said of [JSON.stringify(done), written]) {
      assert.ok(!said.includes(failing.root), "no path of the project's folder");
      assert.doesNotMatch(said, /\/Users\//, "no home path");
      assert.match(said, /Plugins\/LevelTools\/Source\/Grid\.cpp/, "a file in the project, relative");
    }
  });

  it("a package's note is never written through a link swapped in during the job, and a FIFO descriptor never hangs it", {
    skip: SEPARATE_LINKS,
  }, async () => {
    const swapped = await shipWorld({
      runCommand: async (_file, args) => {
        const packaged = argOf(args, "Package");
        await mkdir(packaged, { recursive: true });
        const packages = path.dirname(packaged);
        await rm(packages, { recursive: true });
        await symlink(swapped.outside, packages);
        return { code: 0, output: "BUILD SUCCESSFUL\n" };
      },
    });
    await swapped.call(ShipToolName.PluginPackage);
    const after = await swapped.settled("package");
    assert.equal(after.package.state, ShipState.Failed);
    assert.deepEqual(await readdir(swapped.outside), [], "nothing written outside the project");

    const fifo = await shipWorld({
      runCommand: async (_file, args) => {
        const packaged = argOf(args, "Package");
        await mkdir(packaged, { recursive: true });
        execFileSync("mkfifo", [path.join(packaged, `${PLUGIN}.uplugin`)]);
        return { code: 0, output: "BUILD SUCCESSFUL\n" };
      },
    });
    await fifo.call(ShipToolName.PluginPackage);
    const packaged = await fifo.settled("package");
    assert.equal(packaged.package.state, ShipState.Done, "the descriptor is skipped, not read");
  });

  it("a new package run takes the last package's note out of the proof", async () => {
    const held = gate();
    let packages = 0;
    const w = await shipWorld({
      runCommand: async (_file, args) => {
        packages += 1;
        if (packages > 1) await held.shut;
        const packaged = argOf(args, "Package");
        await mkdir(packaged, { recursive: true });
        await writeFile(path.join(packaged, `${PLUGIN}.uplugin`), "{}");
        return { code: 0, output: "BUILD SUCCESSFUL\n" };
      },
    });
    const note = `unreal/Saved/Genex/Packages/${PLUGIN}.md`;
    await w.call(ShipToolName.PluginPackage);
    assert.deepEqual((await w.settled("package")).proof, [note]);
    await w.call(ShipToolName.PluginPackage);
    await until(async () => packages > 1);
    const during = await w.status();
    assert.equal(during.package.state, ShipState.Running);
    assert.deepEqual(during.proof, [], "the last note isn't proof of a package being made");
    assert.ok(!existsSync(path.join(w.game, note)), "and it is gone with the package it described");
    w.restart();
    assert.deepEqual((await w.status()).proof, [], "nor after a restart");
    held.open();
  });
});

describe("a host with two plugins", () => {
  it("status, start and stop name the plugin's own job, never the other plugin's", async () => {
    const held = gate();
    const w = await shipWorld({
      plugins: ["Beta"],
      runProgram: async (_file, args, { signal }) => {
        w.programs.push({ file: "", args, signal });
        await Promise.race([held.shut, new Promise((resolve) => signal.addEventListener("abort", resolve))]);
        await writeFile(path.join(reportDirOf(args), "index.json"), JSON.stringify(REPORT));
        return { code: 0, output: "", timedOut: false };
      },
    });
    assert.deepEqual(await w.call(ShipToolName.PluginTest, { plugin: PLUGIN }), { started: true, filter: PLUGIN });
    await until(async () => w.programs.length > 0);
    await assert.rejects(w.call(ShipToolName.PluginTest, { plugin: "Beta" }), /one job at a time/);
    assert.equal((await w.status({ plugin: "Beta" })).test.state, ShipState.Idle, "Beta's tests never ran");
    assert.deepEqual(await w.call(ShipToolName.PluginTest, { plugin: "Beta", stop: true }), { stopped: false });
    assert.equal(
      (await w.status({ plugin: PLUGIN })).test.state,
      ShipState.Running,
      "and its stop left LevelTools' run",
    );
    held.open();
    await until(async () => (await w.status({ plugin: PLUGIN })).test.state !== ShipState.Running);
    const beta = await w.status({ plugin: "Beta" });
    assert.equal(beta.test.state, ShipState.Idle);
    assert.equal(beta.test.report, undefined, "LevelTools' summary is never Beta's");
    assert.deepEqual(beta.proof, []);
    assert.equal((await w.status({ plugin: PLUGIN })).test.state, ShipState.Done);
  });
});

describe("when Genex stops the backend", () => {
  const BACKEND = path.resolve("src/plugins/unreal/backend.ts");
  const RUNNER = path.resolve("src/plugins/unreal/automation-tests.ts");

  /** A backend stand-in: Genex's stop signal, and a job's program that starts a child of its own and waits. */
  async function backendWithJob(root: string) {
    const pidFile = path.join(root, "child.pid");
    const script = path.join(root, "backend-job.mjs");
    await writeFile(
      script,
      [
        `import { backendStopped } from ${JSON.stringify(pathToFileURL(BACKEND).href)};`,
        `import { systemRunProgram } from ${JSON.stringify(pathToFileURL(RUNNER).href)};`,
        "const signal = backendStopped();",
        `void systemRunProgram("/bin/sh", ["-c", ${JSON.stringify(`sleep 30 & echo $! > "${pidFile}"; wait`)}], { signal, timeoutMs: 60000 });`,
      ].join("\n"),
    );
    const child = fork(script, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const written = async () => existsSync(pidFile) && (await readFile(pidFile, "utf8")).trim() !== "";
    // A fresh Node process imports the whole backend before its job starts: wait in real time, not turns.
    for (const end = Date.now() + BACKEND_START_MS; !(await written()); await pause(20)) {
      if (Date.now() < end) continue;
      child.kill("SIGKILL");
      throw new Error(`the backend's job never started its child within ${BACKEND_START_MS} ms`);
    }
    return { child, grandchild: Number((await readFile(pidFile, "utf8")).trim()) };
  }
  const exited = (child: ChildProcess) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));

  for (const [label, stop] of [
    ["quits it (SIGTERM)", (child: ChildProcess) => child.kill("SIGTERM")],
    ["drops its channel", (child: ChildProcess) => child.disconnect()],
  ] as const) {
    it(`a job's whole process group ends when Genex ${label}, and the backend exits`, {
      skip: PROCESS_GROUPS,
      timeout: 30_000,
    }, async () => {
      const root = await realpath(await tmpDir("studio-backend-stop-"));
      const { child, grandchild } = await backendWithJob(root);
      assert.ok(running(grandchild), "the job's own child runs");
      stop(child);
      await exited(child);
      for (let i = 0; i < 100 && running(grandchild); i++) await pause(20);
      assert.equal(running(grandchild), false, "the job's child ended with the backend");
    });
  }
});
