/**
 * Reading an Unreal crash for the editor queue: when a part's C++ crashes the editor as play starts,
 * the queue's job must not stay "playing" while every call to the dead editor times out. The
 * project's own log names the crash: Epic's critical-error banner, the signal and the call stack.
 * The log is a crash log in Unreal 5.8's shape, with the project's path standing in.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CrashSignal,
  crashReportIn,
  editorLogPath,
  readEditorLog,
  startCrashCheck,
} from "../../src/plugins/unreal/editor-log.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CrashLog, crashLog } from "../helpers/unreal-editor-stand-in.ts";

const fixture = crashLog;
const openLog = (project: string) => crashLog(CrashLog.Open, project);

const MODULE = "DirtTrack";
/** The top eight frames of the crash's call stack, as the queue names them. */
const CRASH_FRAMES = [
  "UEPushModelPrivate::MarkPropertyDirty(UObject const*, UEPushModelPrivate::FNetPushObjectId, int)",
  "USceneComponent::SetupAttachment(USceneComponent*, FName)",
  "AMyGameMode::MakeBike(APawn*)",
  "AMyGameMode::SpawnDefaultPawnAtTransform_Implementation(AController*, UE::Math::TTransform<double> const&)",
  "AGameModeBase::SpawnDefaultPawnFor_Implementation(AController*, AActor*)",
  "AGameModeBase::RestartPlayerAtPlayerStart(AController*, AActor*)",
  "AGameModeBase::RestartPlayer(AController*)",
  "AGameModeBase::HandleStartingNewPlayer_Implementation(APlayerController*)",
];

describe("an Unreal crash in the editor's log", () => {
  it("reads the crash: SIGSEGV, the stack's top eight functions, the game's own frame first", async () => {
    const lines = [...(await fixture(CrashLog.PlayStart)).split("\n"), ...(await fixture(CrashLog.Crash)).split("\n")];
    assert.deepEqual(crashReportIn(lines, MODULE), {
      signal: "SIGSEGV",
      frames: CRASH_FRAMES,
      cause: "SIGSEGV",
      at: "AMyGameMode::MakeBike(APawn*)",
    });
  });

  it("finds the game's frame by its hot-reloaded module even when the module isn't known", async () => {
    const report = crashReportIn((await fixture(CrashLog.Crash)).split("\n"));
    assert.equal(report?.at, "AMyGameMode::MakeBike(APawn*)");
  });

  it("names the top frame when no frame is the game's", () => {
    const lines = [
      "[2026.01.01-12.18.52:461][380]LogMac: === Critical error: ===",
      "SIGBUS: bus error",
      "",
      "[2026.01.01-12.18.52:461][380]LogMac: 0x0e3e90f0 libUnrealEditor-Engine.dylib!UWorld::Tick(ELevelTick, float)   [UnknownFile]) ",
      "0x04e011d8 UnrealEditor!FEngineLoop::Tick()   [UnknownFile]) ",
    ];
    assert.deepEqual(crashReportIn(lines, MODULE), {
      signal: "SIGBUS",
      frames: ["UWorld::Tick(ELevelTick, float)", "FEngineLoop::Tick()"],
      cause: "SIGBUS",
      at: "UWorld::Tick(ELevelTick, float)",
    });
  });

  it("reads Windows' exception and an assert, and keeps no path or address in a frame", () => {
    const windows = [
      "[2026.01.01-12.00.44:629][262]LogWindows: Error: === Critical error: ===",
      "LogWindows: Error: ",
      "LogWindows: Error: Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000000",
      "LogWindows: Error: [Callstack] 0x00007ffd12345678 UnrealEditor-DirtTrack.dll!AMyGameMode::MakeBike() [C:\\Users\\owner\\AI Games\\dirt-track\\unreal\\Source\\DirtTrack\\Parts\\Bike\\BikeGameMode.cpp:42]",
      "LogWindows: Error: [Callstack] 0x00007ffd12345999 UnrealEditor-Engine.dll!UWorld::Tick() []",
    ];
    assert.deepEqual(crashReportIn(windows, MODULE), {
      signal: "EXCEPTION_ACCESS_VIOLATION",
      frames: ["AMyGameMode::MakeBike()", "UWorld::Tick()"],
      cause: "EXCEPTION_ACCESS_VIOLATION",
      at: "AMyGameMode::MakeBike()",
    });
    const source = "[File:/Users/owner/AI Games/dirt-track/unreal/Source/DirtTrack/BikeRig.cpp] [Line: 12]";
    const assertion = [
      `[2026.01.01-12.00.44:628][262]LogMac: Error: appError called: Assertion failed: Rig != nullptr ${source} `,
      "[2026.01.01-12.00.44:629][262]LogMac: Error: === Critical error: ===",
      "LogMac: Error: ",
      `LogMac: Error: Assertion failed: Rig != nullptr ${source} `,
      "LogMac: Error: [Callstack] 0x0000000123456789 libUnrealEditor-DirtTrack.dylib!UBikeRig::Mount() [/Users/owner/AI Games/dirt-track/unreal/Source/DirtTrack/BikeRig.cpp:12]",
    ];
    const report = crashReportIn(assertion, MODULE);
    assert.deepEqual(report, {
      signal: CrashSignal.Assert,
      frames: ["UBikeRig::Mount()"],
      cause: "Assertion failed: Rig != nullptr",
      at: "UBikeRig::Mount()",
    });
    assert.doesNotMatch(JSON.stringify(report), /\/Users|C:\\|0x0/, "no path or address of the owner's machine");
  });

  it("sees no crash in lines that only mention errors, a handled ensure or the banner's words", async () => {
    const quiet = [
      ...(await fixture(CrashLog.Open)).split("\n"),
      ...(await fixture(CrashLog.PlayStart)).split("\n"),
      "[2026.01.01-12.00.44:629][262]LogOutputDevice: Error: === Handled ensure: ===",
      "[2026.01.01-12.00.44:629][262]LogTemp: Warning: Critical error in my game",
      "LogTemp: Display: === Critical error: === is how Unreal opens a crash report",
      "[2026.01.01-12.00.44:629][262]LogBlueprintUserMessages: [BP_Car_C_0] SIGSEGV: a string a game printed",
    ];
    assert.equal(crashReportIn(quiet, MODULE), undefined);
  });
});

/** A project in a home of its own, its editor's log as Unreal writes it there, and the editor's process. */
async function world(options: { name?: string; folder?: string } = {}) {
  const home = await tmpDir("studio-unreal-crash-check-");
  const directory = path.join(home, options.folder ?? path.join("AI Games", "dirt-track", "unreal"));
  const project = path.join(directory, `${options.name ?? MODULE}.uproject`);
  const file = editorLogPath({ file: project, directory }, home, "darwin");
  await mkdir(path.dirname(file), { recursive: true });
  const editor = { running: true };
  const probe = { running: async () => editor.running, module: MODULE };
  return { home, project, file, editor, probe };
}

describe("a part's watch for its editor crashing", () => {
  it("reports the crash Unreal writes after the watch began, once its call stack is there", async () => {
    const w = await world();
    await writeFile(w.file, await openLog(w.project));
    const check = await startCrashCheck(w.file, w.project, w.probe);
    await appendFile(w.file, await fixture(CrashLog.PlayStart));
    assert.equal(await check(), undefined, "play started; nothing crashed");
    const crash = await fixture(CrashLog.Crash);
    const stack = crash.indexOf("[2026.01.01-12.18.52:461][380]LogMac: 0x0e3e90f0");
    await appendFile(w.file, crash.slice(0, stack));
    assert.equal(await check(), undefined, "the banner is there, its call stack not yet: one more look");
    await appendFile(w.file, crash.slice(stack));
    const report = await check();
    assert.equal(report?.signal, "SIGSEGV");
    assert.deepEqual(report?.frames, CRASH_FRAMES);
    assert.equal(report?.at, "AMyGameMode::MakeBike(APawn*)");
  });

  it("reports a banner whose call stack never comes on its next look", async () => {
    const w = await world();
    await writeFile(w.file, await openLog(w.project));
    const check = await startCrashCheck(w.file, w.project, w.probe);
    await appendFile(w.file, "[2026.01.01-12.18.52:461][380]LogMac: === Critical error: ===\nSIGSEGV: invalid\n\n");
    assert.equal(await check(), undefined);
    assert.deepEqual(await check(), { signal: "SIGSEGV", frames: [], cause: "SIGSEGV", at: undefined });
  });

  it("reports the banner at once when the editor's process is gone", async () => {
    const w = await world();
    await writeFile(w.file, await openLog(w.project));
    const check = await startCrashCheck(w.file, w.project, w.probe);
    await appendFile(w.file, "[2026.01.01-12.18.52:461][380]LogMac: === Critical error: ===\nSIGSEGV: invalid\n\n");
    w.editor.running = false;
    assert.equal((await check())?.signal, "SIGSEGV");
  });

  it("reports an editor whose process is gone twice in a row without a crash in its log", async () => {
    const w = await world();
    await writeFile(w.file, await openLog(w.project));
    const check = await startCrashCheck(w.file, w.project, w.probe);
    w.editor.running = false;
    assert.equal(await check(), undefined, "one look could be a probe that failed");
    w.editor.running = true;
    assert.equal(await check(), undefined, "it runs again: not gone");
    w.editor.running = false;
    assert.equal(await check(), undefined);
    const gone = await check();
    assert.equal(gone?.signal, CrashSignal.Exited);
    assert.deepEqual(gone?.frames, []);
    assert.match(gone?.cause ?? "", /process ended/);
  });

  it("never reports a crash that was in the log before the watch began", async () => {
    const w = await world();
    await writeFile(w.file, (await openLog(w.project)) + (await fixture(CrashLog.Crash)));
    const check = await startCrashCheck(w.file, w.project, w.probe);
    await appendFile(w.file, "[2026.01.01-12.19.24:000][  0]LogTemp: Display: still here\n");
    assert.equal(await check(), undefined);
    assert.equal(await check(), undefined);
  });

  it("reads a project whose path Unreal quotes on its command line (a folder name with a space)", async () => {
    const w = await world({ folder: path.join("AI Games", "dirt track", "unreal") });
    const quoted = await openLog(`"${w.project}"`);
    assert.ok(quoted.includes(`commandline="" "${w.project}"""`), "Unreal's own form for a path with spaces");
    await writeFile(w.file, quoted);
    assert.equal((await readEditorLog(w.file, w.project))?.open, true, "the log is this project's");
    const check = await startCrashCheck(w.file, w.project, w.probe);
    await appendFile(w.file, await fixture(CrashLog.Crash));
    assert.equal((await check())?.signal, "SIGSEGV");
  });
});

describe("a part's watch reads only its own project's log", () => {
  const unread: Array<[string, (w: Awaited<ReturnType<typeof world>>) => Promise<string>]> = [
    [
      "a log that links to the crashing one",
      async (w) => {
        const other = path.join(w.home, "other.log");
        await writeFile(other, await openLog(w.project));
        await symlink(other, w.file);
        return other;
      },
    ],
    [
      "the log of another project with the same name",
      async (w) => {
        await writeFile(w.file, await openLog("/Games/Elsewhere/DirtTrack.uproject"));
        return w.file;
      },
    ],
  ];
  for (const [label, arrange] of unread)
    it(`reads no crash from ${label}`, { skip: process.platform === "win32" && "links need privileges" }, async () => {
      const w = await world();
      const target = await arrange(w);
      const check = await startCrashCheck(w.file, w.project, w.probe);
      await appendFile(target, await fixture(CrashLog.Crash));
      assert.equal(await check(), undefined);
      assert.equal(await check(), undefined);
    });
});
