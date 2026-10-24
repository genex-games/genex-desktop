/**
 * A plugin's sandbox jobs (`sandbox.run`, `sandbox.result`, `sandbox.stop`): the host starts a long
 * job of an engine plugin (the Unreal plugin's package on Windows) in Genex's ProcessSandbox, answers
 * its id at once and owns it until it ends, its plugin stops it, or the plugin stops, is turned off
 * or is removed. What each job hands ProcessSandbox is asserted here: the command line, the folders
 * it writes (inside the bound game) and the ones it reads. That on Windows a confinement is not a
 * per-job fence is the sandbox's own residual risk (docs/windows-sandbox.md), not asserted here.
 * ProcessSandbox is a recording stand-in; a hostile request starts nothing and leaves nothing behind.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  PLUGIN_SANDBOX_MAX_TIMEOUT_MS,
  PLUGIN_SANDBOX_OUTPUT_CHARS,
  PluginService,
  SandboxJobState,
} from "../../src/shared/plugins.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import { COMMAND_LINE_ENV, PluginSandboxJobs } from "../../src/substrate/plugins/sandbox-jobs.ts";
import { copyOfExample, installLocalOn, personAllowsLocalTools, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PACKAGE_MS = 45 * 60 * 1000;
const LINKS = process.platform === "win32" && "links need privileges on Windows";
const QUOTE_IN_NAME = process.platform === "win32" && "Windows names can't hold a quote";

/** ProcessSandbox's `run`, recorded: each run ends when the test finishes it or its signal aborts. */
function fakeSandbox() {
  const runs: Array<{ request: RunRequest; finish(result: Partial<RunResult>): void }> = [];
  const run = (request: RunRequest) =>
    new Promise<RunResult>((resolve) => {
      const finish = (result: Partial<RunResult>) =>
        resolve({
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          truncated: false,
          sandboxed: true,
          command: request.command,
          cwd: request.cwd,
          ...result,
        });
      request.signal?.addEventListener("abort", () => finish({ code: null, signal: "SIGKILL" }), { once: true });
      runs.push({ request, finish });
    });
  return { runs, run };
}

/** Yields until `done` holds. */
async function until(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 10_000; i++) {
    if (await done()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("never settled");
}

/** A game with an Unreal project and its package folder, an engine with RunUAT.bat, and the jobs on a stand-in sandbox. */
async function world(options: { platform?: NodeJS.Platform; gameName?: string } = {}) {
  const root = await realpath(await tmpDir("studio-sandbox-jobs-"));
  const game = path.join(root, options.gameName ?? "My Game & Co^1 (it's)");
  const unreal = path.join(game, "unreal");
  const packageDir = path.join(unreal, "Saved", "Genex", "Packages", "LevelTools");
  const pluginFile = path.join(unreal, "Plugins", "LevelTools", "LevelTools.uplugin");
  const engine = path.join(root, "engine");
  const bat = path.join(engine, "Engine", "Build", "BatchFiles", "RunUAT.bat");
  const outside = path.join(root, "outside");
  const scratch = path.join(root, "scratch");
  for (const dir of [packageDir, path.dirname(pluginFile), path.dirname(bat), outside, scratch])
    await mkdir(dir, { recursive: true });
  await writeFile(bat, "@echo off\r\n");
  await writeFile(pluginFile, "{}");
  await writeFile(path.join(outside, "RunUAT.bat"), "@echo off\r\n");
  const sandbox = fakeSandbox();
  const jobs = new PluginSandboxJobs({
    run: sandbox.run,
    scratch,
    platform: options.platform ?? "win32",
    env: { SystemRoot: "C:\\Windows" },
  });
  const binding = { project: "level-tools", directory: game };
  const request = (over: Record<string, unknown> = {}) => ({
    program: bat,
    args: ["BuildPlugin", `-Plugin=${pluginFile}`, `-Package=${packageDir}`, "-TargetPlatforms=Win64", "-NoP4"],
    reads: [engine, unreal],
    writes: [packageDir],
    scratchEnv: ["uebp_LogFolder"],
    timeoutMs: PACKAGE_MS,
    ...over,
  });
  /** `sandbox.run` for `plugin`, bound to the game unless `bound` is null. */
  const run = (args: unknown, plugin = "unreal", bound: typeof binding | null = binding) =>
    jobs.call(plugin, PluginService.SandboxRun, args, bound ?? undefined) as Promise<{ id: string }>;
  const result = (id: string, plugin = "unreal") => jobs.call(plugin, PluginService.SandboxResult, { id }, binding);
  const stop = (id: string, plugin = "unreal") => jobs.call(plugin, PluginService.SandboxStop, { id }, binding);
  return {
    root,
    game,
    unreal,
    packageDir,
    pluginFile,
    engine,
    bat,
    outside,
    scratch,
    sandbox,
    jobs,
    binding,
    request,
    run,
    result,
    stop,
  };
}

describe("sandbox.run", () => {
  it("runs a Windows command script through cmd.exe in ProcessSandbox, its whole line quoted by Genex", async () => {
    const w = await world();
    const { id } = await w.run(w.request());
    assert.match(id, /^[0-9a-f-]{36}$/);
    const [only] = w.sandbox.runs;
    assert.ok(only, "the job reached ProcessSandbox");
    const { request } = only;
    assert.equal(request.command, `'C:/Windows/System32/cmd.exe' /d /v:off /s /c %${COMMAND_LINE_ENV}%`);
    assert.equal(
      request.env?.[COMMAND_LINE_ENV],
      `"${w.bat}" BuildPlugin -Plugin="${w.pluginFile}" -Package="${w.packageDir}" -TargetPlatforms=Win64 -NoP4`,
      "every path quoted whole, so &, ^, ( and spaces stay in it",
    );
    const jobDir = path.join(w.scratch, id);
    assert.equal(request.cwd, jobDir);
    assert.equal(request.env?.uebp_LogFolder, path.join(jobDir, "uebp_LogFolder"));
    assert.ok((await readdir(jobDir)).includes("uebp_LogFolder"), "the scratch variable's folder is made");
    assert.equal(request.timeoutMs, PACKAGE_MS);
    assert.equal(request.maxOutputBytes, PLUGIN_SANDBOX_OUTPUT_CHARS);
    assert.ok(request.signal, "the host can end it");
    assert.equal(await w.result(id).then((job) => (job as { state: string }).state), SandboxJobState.Running);
    only.finish({ code: 0, stdout: "BUILD SUCCESSFUL\n" });
    await until(async () => ((await w.result(id)) as { state: string }).state !== SandboxJobState.Running);
    assert.deepEqual(await w.result(id), {
      id,
      state: SandboxJobState.Exited,
      exitCode: 0,
      stdout: "BUILD SUCCESSFUL\n",
      stderr: "",
      truncated: false,
      seconds: 0,
    });
    assert.deepEqual(await readdir(w.scratch), [], "the job's scratch goes with it");
  });

  it("asks ProcessSandbox for the package folder and the job's scratch, and nothing broader", async () => {
    const w = await world();
    const { id } = await w.run(w.request());
    const { request } = w.sandbox.runs[0] ?? assert.fail("no run");
    const jobDir = path.join(w.scratch, id);
    assert.deepEqual(request.confine, { write: [w.packageDir], tmp: path.join(jobDir, "tmp") });
    // srt-win refuses a per-command grant: the engine is read with the sandbox user's own rights.
    assert.equal(request.policy, undefined, "no read or network grant on Windows");
    assert.deepEqual(Object.keys(request).sort(), [
      "command",
      "confine",
      "cwd",
      "env",
      "keepOutput",
      "label",
      "maxOutputBytes",
      "signal",
      "timeoutMs",
    ]);
    assert.deepEqual(Object.keys(request.env ?? {}).sort(), [COMMAND_LINE_ENV, "uebp_LogFolder"]);

    const mac = await world({ platform: "darwin" });
    await mac.run(mac.request());
    const { request: there } = mac.sandbox.runs[0] ?? assert.fail("no run");
    assert.deepEqual(there.policy, { allowRead: [mac.engine, mac.unreal] }, "elsewhere the reads are granted per run");
    assert.deepEqual(there.confine?.write, [mac.packageDir]);
    assert.equal(
      there.command,
      [
        mac.bat,
        "BuildPlugin",
        `-Plugin=${mac.pluginFile}`,
        `-Package=${mac.packageDir}`,
        "-TargetPlatforms=Win64",
        "-NoP4",
      ]
        .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
        .join(" "),
    );
  });

  it("caps a job's deadline at PLUGIN_SANDBOX_MAX_TIMEOUT_MS, which covers a 45-minute package", async () => {
    const w = await world();
    assert.ok(PLUGIN_SANDBOX_MAX_TIMEOUT_MS >= PACKAGE_MS);
    await w.run(w.request({ timeoutMs: PLUGIN_SANDBOX_MAX_TIMEOUT_MS }));
    assert.equal(w.sandbox.runs[0]?.request.timeoutMs, PLUGIN_SANDBOX_MAX_TIMEOUT_MS);
    for (const timeoutMs of [PLUGIN_SANDBOX_MAX_TIMEOUT_MS + 1, 999, 1500.5, "60000", undefined])
      await assert.rejects(w.run(w.request({ timeoutMs })), /deadline/, String(timeoutMs));
    assert.equal(w.sandbox.runs.length, 1, "a refused deadline starts nothing");
  });

  it("refuses a hostile request, starting nothing and leaving nothing behind", async (t) => {
    const w = await world();
    const linked = path.join(w.unreal, "Saved", "Linked");
    if (!LINKS) await symlink(w.outside, linked);
    const percent = path.join(w.unreal, "Saved", "100%");
    const bang = path.join(w.unreal, "Saved", "Hi!");
    await mkdir(percent, { recursive: true });
    await mkdir(bang, { recursive: true });
    const rows: Array<[string, unknown, "unbound"?]> = [
      ["a folder written outside the game", w.request({ writes: [w.outside] })],
      ["the game folder itself written", w.request({ writes: [w.game] })],
      ["a written folder that is missing", w.request({ writes: [path.join(w.unreal, "Nope")] })],
      ["a relative written folder", w.request({ writes: ["Saved/Genex"] })],
      ["a written folder on a network share", w.request({ writes: ["\\\\server\\share\\pkg"] })],
      ["a read folder on a network share", w.request({ reads: ["\\\\server\\share\\UE_5.6"] })],
      ["a device path read", w.request({ reads: ["\\\\?\\C:\\UE"] })],
      ["a program outside every read folder", w.request({ program: path.join(w.outside, "RunUAT.bat") })],
      ["a program on a network share", w.request({ program: "\\\\server\\share\\RunUAT.bat" })],
      ["an argument with a quote", w.request({ args: ['-Plugin=a"b'] })],
      ["an argument with %", w.request({ args: ["-Package=%USERPROFILE%"] })],
      ["an argument with !", w.request({ args: ["-Package=!x!"] })],
      ["an argument with a line break", w.request({ args: ["BuildPlugin\r\ncalc"] })],
      ["a value ending in a backslash", w.request({ args: ["-Package=C:\\out dir\\"] })],
      ["a package folder whose path holds %", w.request({ writes: [percent], args: [`-Package=${percent}`] })],
      ["a package folder whose path holds !", w.request({ writes: [bang], args: [`-Package=${bang}`] })],
      ["an unknown key", w.request({ shell: true })],
      ["a reserved variable", w.request({ env: { PATH: "C:\\evil" } })],
      ["the command line's own variable", w.request({ env: { [COMMAND_LINE_ENV]: "calc" } })],
      ["COMSPEC in another case", w.request({ env: { ComSpec: "C:\\evil.exe" } })],
      ["a scratch variable that isn't a name", w.request({ scratchEnv: ["a=b"] })],
      ["no game", w.request(), "unbound"],
      ["not an object", "RunUAT.bat BuildPlugin"],
    ];
    if (!LINKS) rows.push(["a written folder that is a link out", w.request({ writes: [linked] })]);
    for (const [name, args, unbound] of rows)
      await t.test(name, async () => {
        await assert.rejects(w.run(args, "unreal", unbound ? null : w.binding));
        assert.equal(w.sandbox.runs.length, 0, "nothing started");
        assert.deepEqual(await readdir(w.scratch), [], "no scratch left");
      });
    assert.deepEqual(await readdir(w.outside), ["RunUAT.bat"], "nothing written outside");
  });

  it("refuses a game whose folder holds a quote: cmd.exe's quoting can't carry one", {
    skip: QUOTE_IN_NAME,
  }, async () => {
    const w = await world({ gameName: 'Say "hi"' });
    await assert.rejects(w.run(w.request()));
    assert.equal(w.sandbox.runs.length, 0);
  });

  it("holds at most two running jobs per plugin", async () => {
    const w = await world();
    await w.run(w.request());
    await w.run(w.request());
    await assert.rejects(w.run(w.request()), /already runs 2/);
    assert.equal(w.sandbox.runs.length, 2);
    await w.run(w.request(), "other-engine");
    assert.equal(w.sandbox.runs.length, 3, "another plugin's jobs count apart");
  });
});

describe("sandbox.result and sandbox.stop", () => {
  it("a job ends at its deadline, by its plugin's stop, or by failing to start; another plugin can't see or stop it", async () => {
    const w = await world();
    const late = await w.run(w.request());
    w.sandbox.runs[0]?.finish({ code: null, timedOut: true, stdout: "half" });
    await until(async () => ((await w.result(late.id)) as { state: string }).state === SandboxJobState.TimedOut);

    const held = await w.run(w.request());
    assert.equal(await w.result(held.id, "other-engine"), null, "another plugin's job is unknown to it");
    assert.deepEqual(await w.stop(held.id, "other-engine"), { stopped: false });
    assert.equal(w.sandbox.runs[1]?.request.signal?.aborted, false);
    assert.deepEqual(await w.stop(held.id), { stopped: true });
    assert.equal(w.sandbox.runs[1]?.request.signal?.aborted, true, "its process tree is ended");
    assert.equal(((await w.result(held.id)) as { state: string }).state, SandboxJobState.Stopped);
    assert.deepEqual(await w.stop(held.id), { stopped: false }, "an ended job stops once");
    assert.equal(await w.result("not-a-job"), null);

    const broken = new PluginSandboxJobs({
      run: async () => {
        throw Object.assign(new Error(`spawn ${w.bat} ENOENT`), { code: "ENOENT" });
      },
      scratch: w.scratch,
      platform: "win32",
      env: {},
    });
    const { id } = (await broken.call("unreal", PluginService.SandboxRun, w.request(), w.binding)) as { id: string };
    await until(
      async () =>
        ((await broken.call("unreal", PluginService.SandboxResult, { id }, w.binding)) as { state: string }).state !==
        SandboxJobState.Running,
    );
    const failed = (await broken.call("unreal", PluginService.SandboxResult, { id }, w.binding)) as {
      state: string;
      reason: string;
    };
    assert.equal(failed.state, SandboxJobState.Failed);
    assert.equal(failed.reason, "ENOENT", "only the error's code: its message names a path");
  });

  it("stopAll ends every running job of one plugin (it stopped or was turned off), and no other plugin's", async () => {
    const w = await world();
    const a = await w.run(w.request());
    const b = await w.run(w.request());
    const other = await w.run(w.request(), "other-engine");
    await w.jobs.stopAll("unreal");
    assert.deepEqual(
      w.sandbox.runs.map((run) => run.request.signal?.aborted),
      [true, true, false],
    );
    for (const id of [a.id, b.id])
      assert.equal(((await w.result(id)) as { state: string }).state, SandboxJobState.Stopped);
    assert.equal(((await w.result(other.id, "other-engine")) as { state: string }).state, SandboxJobState.Running);
    await w.jobs.stopAll();
    assert.equal(w.sandbox.runs[2]?.request.signal?.aborted, true, "the core stopping ends them all");
  });
});

describe("a long job's output", () => {
  const POSIX_ONLY = process.platform === "win32" && "a POSIX shell script; Windows runs plugin-sandbox-jobs-windows";

  it("keeps the last PLUGIN_SANDBOX_OUTPUT_CHARS of each stream, so a long log's verdict survives", {
    skip: POSIX_ONLY,
  }, async (t) => {
    const w = await world({ platform: process.platform });
    // Unconfined: what is kept of the output is ProcessSandbox's capture, the same with or without srt.
    const sandbox = await ProcessSandbox.create({
      writableRoots: [w.game],
      scratchDir: path.join(w.root, "sandbox"),
      secretPaths: [],
      enabled: false,
    });
    t.after(() => sandbox.dispose());
    let ran: ReturnType<typeof sandbox.run> | undefined;
    const jobs = new PluginSandboxJobs({
      run: (request) => {
        ran = sandbox.run(request);
        return ran;
      },
      scratch: w.scratch,
    });
    const script = path.join(w.engine, "uat.sh");
    const flood = PLUGIN_SANDBOX_OUTPUT_CHARS + 1024 * 1024;
    await writeFile(
      script,
      `#!/bin/sh\nhead -c ${flood} /dev/zero | tr '\\0' x\necho\necho BUILD SUCCESSFUL\nhead -c ${flood} /dev/zero | tr '\\0' y >&2\necho 'ERROR: last words' >&2\n`,
    );
    await chmod(script, 0o755);
    const request = { program: script, args: [], reads: [w.engine], writes: [w.packageDir], timeoutMs: 60_000 };
    const { id } = (await jobs.call("unreal", PluginService.SandboxRun, request, w.binding)) as { id: string };
    const read = () => jobs.call("unreal", PluginService.SandboxResult, { id }, w.binding);
    // The flood is a real process that takes as long as it takes: wait for it to end, then for the
    // job to record how it ended, never for a count of turns while it still writes.
    await ran;
    await until(async () => ((await read()) as { state: string }).state !== SandboxJobState.Running);
    const job = (await read()) as { state: string; stdout: string; stderr: string; truncated: boolean };
    assert.equal(job.state, SandboxJobState.Exited);
    assert.equal(job.truncated, true);
    assert.equal(job.stdout.length, PLUGIN_SANDBOX_OUTPUT_CHARS);
    assert.ok(job.stdout.endsWith("x\nBUILD SUCCESSFUL\n"), `the verdict is kept: ${job.stdout.slice(-40)}`);
    assert.equal(job.stderr.length, PLUGIN_SANDBOX_OUTPUT_CHARS);
    assert.ok(job.stderr.endsWith("yERROR: last words\n"), "stderr keeps its tail too");
  });
});

describe("the registry's sandbox jobs", () => {
  /** A local engine plugin whose `start` tool hands its request to `sandbox.run`, on a registry with the jobs on a stand-in sandbox. */
  async function registryWorld(capabilities: string[]) {
    const w = await world();
    const dir = await copyOfExample(w.root, "engine-plugin", (m) => {
      m.apiVersion = 3;
      m.id = "engine-plugin";
      m.capabilities = capabilities;
      m.tools = [
        {
          name: "start",
          description: "Start a sandbox job.",
          parameters: { type: "object", properties: { request: { type: "object" } }, required: ["request"] },
        },
      ];
      m.skills = [];
      m.toolbar = [];
      m.panels = [];
      m.actions = [];
    });
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {async tool(n,a,c){return c.host('sandbox.run', a.request);}};}",
    );
    const seeds = path.join(w.root, "seeds");
    await mkdir(seeds);
    const registry = new PluginRegistry(path.join(w.root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
    registry.sandboxJobs = w.jobs;
    await registry.init();
    await installLocalOn(registry, dir, capabilities);
    personAllowsLocalTools(registry);
    registry.consent = async () => ({ approved: true, by: "user" });
    return { ...w, registry };
  }

  it("a plugin turned off mid-job has its jobs ended with their process trees", async (t) => {
    const w = await registryWorld(["settings", "game-engine"]);
    t.after(() => w.registry.cancel());
    const { id } = (await w.registry.tool("engine-plugin__start", { request: w.request() }, w.binding)) as {
      id: string;
    };
    assert.equal(w.sandbox.runs.length, 1);
    assert.equal(w.sandbox.runs[0]?.request.signal?.aborted, false, "the job outlives the call that started it");
    await w.registry.setEnabled("engine-plugin", false);
    await until(() => w.sandbox.runs[0]?.request.signal?.aborted === true);
    assert.equal(((await w.result(id, "engine-plugin")) as { state: string }).state, SandboxJobState.Stopped);
  });

  it("a plugin without game-engine is refused before anything starts", async (t) => {
    const w = await registryWorld(["settings"]);
    t.after(() => w.registry.cancel());
    await assert.rejects(
      w.registry.tool("engine-plugin__start", { request: w.request() }, w.binding),
      /capability denied/,
    );
    assert.equal(w.sandbox.runs.length, 0);
  });
});
