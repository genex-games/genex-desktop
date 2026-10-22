/**
 * A plugin's sandbox job on Windows through the **real** srt-win backend, no mocks: the Unreal
 * plugin's package line (`RunUAT.bat BuildPlugin … -TargetPlatforms=Win64`) goes through Git Bash
 * and `cmd.exe /d /v:off /s /c %GENEX_COMMAND_LINE%` to a stand-in `RunUAT.bat`, from an engine and
 * a game whose folder names hold a space, `&` and parentheses. The stand-in writes what it was
 * handed, its whole line (`%*`) and each parameter, into the package folder, and exits 0; the test
 * asserts every argument arrived whole. `plugin-sandbox-jobs.test.ts` asserts the request itself.
 *
 * Windows only, on a machine whose sandbox is provisioned (the Windows CI job does that and sets
 * GENEX_WINDOWS_SANDBOX=ready).
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { PluginService, SandboxJobState } from "../../src/shared/plugins.ts";
import { PluginSandboxJobs } from "../../src/substrate/plugins/sandbox-jobs.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Why this machine cannot run the suite, or false when it can. */
function skipReason(): string | false {
  if (process.platform !== "win32") return "Windows only: the srt-win backend and cmd.exe";
  if (process.env.GENEX_WINDOWS_SANDBOX !== "ready") return "needs a provisioned sandbox (GENEX_WINDOWS_SANDBOX=ready)";
  return false;
}
const SKIP = skipReason();

const JOB_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;
const POLL_MS = 250;

/** The stand-in RunUAT.bat: `%*`, then `%1..%n` one per line, into `%STUB_OUT%\args.txt`. */
const STUB_UAT = [
  "@echo off",
  'set "F=%STUB_OUT%\\args.txt"',
  '>"%F%" echo(ALL=%*',
  ":next",
  'if "%~1"=="" goto done',
  '>>"%F%" echo(ARG=%1',
  "shift",
  "goto next",
  ":done",
  "exit /b 0",
  "",
].join("\r\n");

let sandbox: ProcessSandbox;
let jobs: PluginSandboxJobs;
let engine: string;
let game: string;
let bat: string;
let pluginFile: string;
let packageDir: string;

before(async () => {
  if (SKIP) return;
  // Long names, as the app's own folders have: `os.tmpdir()` can be spelled with an 8.3 name.
  const root = realpathSync.native(await tmpDir("genex-plugin-jobs-win-"));
  engine = path.join(root, "UE 5.8 & Co (x)");
  game = path.join(root, "Game & Co (1)");
  bat = path.join(engine, "Engine", "Build", "BatchFiles", "RunUAT.bat");
  const unreal = path.join(game, "unreal");
  pluginFile = path.join(unreal, "Plugins", "LevelTools", "LevelTools.uplugin");
  packageDir = path.join(unreal, "Saved", "Genex", "Packages", "LevelTools");
  for (const dir of [path.dirname(bat), path.dirname(pluginFile), packageDir]) await mkdir(dir, { recursive: true });
  await writeFile(bat, STUB_UAT);
  await writeFile(pluginFile, "{}");
  const scratch = path.join(root, "scratch");
  sandbox = await ProcessSandbox.create({
    writableRoots: [game],
    scratchDir: scratch,
    secretPaths: [],
    readableRoots: [engine],
  });
  jobs = new PluginSandboxJobs({ run: (request) => sandbox.run(request), scratch: path.join(scratch, "plugin-jobs") });
});

after(async () => {
  if (SKIP) return;
  await jobs.stopAll();
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  await SandboxManager.reset();
});

/** A job's record once it is no longer running. */
async function ended(id: string, binding: { project: string; directory: string }) {
  for (;;) {
    const job = (await jobs.call("unreal", PluginService.SandboxResult, { id }, binding)) as {
      state: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      reason?: string;
    } | null;
    if (!job) throw new Error("the job was lost");
    if (job.state !== SandboxJobState.Running) return job;
    await sleep(POLL_MS);
  }
}

describe("plugin sandbox job on Windows", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("hands RunUAT.bat every argument whole through cmd.exe, paths with a space, & and ( ) included", async () => {
    const binding = { project: "level-tools", directory: game };
    const request = {
      program: bat,
      args: ["BuildPlugin", `-Plugin=${pluginFile}`, `-Package=${packageDir}`, "-TargetPlatforms=Win64", "-NoP4"],
      reads: [engine, path.join(game, "unreal")],
      writes: [packageDir],
      scratchEnv: ["uebp_LogFolder"],
      env: { STUB_OUT: packageDir },
      timeoutMs: JOB_TIMEOUT_MS,
    };
    const { id } = (await jobs.call("unreal", PluginService.SandboxRun, request, binding)) as { id: string };
    const job = await ended(id, binding);
    assert.equal(job.state, SandboxJobState.Exited, JSON.stringify(job));
    assert.equal(job.exitCode, 0, job.stderr);

    const lines = (await readFile(path.join(packageDir, "args.txt"), "utf8")).split("\r\n").filter(Boolean);
    assert.deepEqual(lines, [
      `ALL=BuildPlugin -Plugin="${pluginFile}" -Package="${packageDir}" -TargetPlatforms=Win64 -NoP4`,
      // A batch file's parameters also split at `=`: each quoted path still arrives as one.
      "ARG=BuildPlugin",
      "ARG=-Plugin",
      `ARG="${pluginFile}"`,
      "ARG=-Package",
      `ARG="${packageDir}"`,
      "ARG=-TargetPlatforms",
      "ARG=Win64",
      "ARG=-NoP4",
    ]);
  });
});
