/**
 * Compiling a game's C++ on a real Windows: the engine's Build.bat is a stand-in batch file run
 * through Windows' own cmd.exe, so the quoting of folders with spaces, `&` and brackets, the small
 * environment, an MSVC error read from cmd's CRLF output and a stop that ends the whole tree are
 * Windows' own. Elsewhere these cases skip: unreal-ubt.test.ts holds the same rules with a stand-in
 * runner on every computer.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { CompileFailure, compileEditor } from "../../src/plugins/unreal/ubt.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SKIP = process.platform !== "win32" && "cmd.exe and Build.bat are Windows'";
const MODULE = "GxCpp";
/** Folder names a person's own folders hold, which cmd.exe keeps whole only inside quotes. */
const ENGINE_FOLDER = "Epic Games & (tests)";
const GAME_FOLDER = "rush & co (2)";
/** How soon a stopped build has ended with its tree; the stand-in alone waits a minute. */
const STOPPED_WITHIN_MS = 20 * SECOND_MS;
const STOP_AFTER_MS = 2 * SECOND_MS;

/** An engine whose Build.bat is `script`, and a game's project, both under awkward folder names. */
async function world(script: (batchDir: string) => string) {
  const root = await tmpDir("ubt-win-");
  const engineDir = path.join(root, ENGINE_FOLDER, "UE_5.8");
  const batchDir = path.join(engineDir, "Engine", "Build", "BatchFiles");
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "Build.bat"), script(batchDir).split("\n").join("\r\n"));
  const unreal = path.join(root, GAME_FOLDER, "unreal");
  await mkdir(unreal, { recursive: true });
  const projectFile = path.join(unreal, `${MODULE}.uproject`);
  await writeFile(projectFile, "{}");
  return { engineDir, batchDir, unreal, projectFile };
}

describe("compiling on Windows through cmd.exe", { skip: SKIP }, () => {
  it("Build.bat gets the target, Win64 and the project whole, and an environment without Genex's secrets", async () => {
    const w = await world(() =>
      [
        "@echo off",
        '>"%~dp0args.txt" echo %*',
        '>"%~dp0env.txt" echo [%ANTHROPIC_API_KEY%] [%GENEX_PROFILE%] [%SystemRoot%]',
        "echo Result: Succeeded",
        "exit /b 0",
      ].join("\n"),
    );
    const env = { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test", GENEX_PROFILE: "dev" };
    const result = await compileEditor({ engineDir: w.engineDir, projectFile: w.projectFile, module: MODULE, env });
    assert.equal(result.ok, true, result.summary);
    const args = (await readFile(path.join(w.batchDir, "args.txt"), "utf8")).trim();
    assert.equal(
      args,
      `${MODULE}Editor Win64 Development -Project="${w.projectFile}" -NoMutex -NoUBA -NoHotReloadFromIDE`,
    );
    const seen = (await readFile(path.join(w.batchDir, "env.txt"), "utf8")).trim();
    assert.equal(
      seen,
      `[] [] [${process.env.SystemRoot}]`,
      "secrets and Genex's settings stay out; Windows' folders stay in",
    );
  });

  it("an MSVC error in cmd's output is its file relative to the project, its line and its message", async () => {
    const w = await world(() => ["@echo off", 'type "%~dp0out.txt"', "exit /b 6"].join("\n"));
    const source = path.join(w.unreal, "Source", MODULE, "Parts", "Sword", "GxSword.cpp");
    const out = [
      "Building GxCppEditor...",
      `${source}(12): error C2065: 'Damge': undeclared identifier`,
      "Result: Failed (OtherCompilationError)",
      "",
    ].join("\r\n");
    await writeFile(path.join(w.batchDir, "out.txt"), out);
    const result = await compileEditor({ engineDir: w.engineDir, projectFile: w.projectFile, module: MODULE });
    assert.equal(result.failure, CompileFailure.Failed, result.summary);
    assert.deepEqual(
      result.errors.map((e) => [e.file, e.line, e.message]),
      [["Source/GxCpp/Parts/Sword/GxSword.cpp", 12, "C2065: 'Damge': undeclared identifier"]],
    );
    assert.ok(!JSON.stringify(result).includes(GAME_FOLDER), "no path of the PC reaches the agent");
  });

  it("a stopped build ends with Build.bat's whole tree, long before the build would have", async () => {
    const w = await world(() =>
      ["@echo off", "echo Building...", "ping -n 60 127.0.0.1 >nul", "echo Result: Succeeded"].join("\n"),
    );
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), STOP_AFTER_MS);
    const result = await compileEditor({
      engineDir: w.engineDir,
      projectFile: w.projectFile,
      module: MODULE,
      signal: stop.signal,
    });
    assert.equal(result.failure, CompileFailure.Aborted, result.summary);
    assert.ok(Date.now() - started < STOPPED_WITHIN_MS, "cmd.exe and its ping ended with the stop");
  });
});
