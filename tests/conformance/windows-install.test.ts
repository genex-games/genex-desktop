/**
 * The Windows install hooks main runs before anything else: Squirrel's `--squirrel-*` launches
 * create or remove the shortcuts through Squirrel's own Update.exe and then exit without opening a
 * window, and the app user model id that ties notifications to the Start menu entry.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  APP_USER_MODEL_ID,
  appUserModelId,
  installedWorkingDir,
  runSquirrelStep,
  SquirrelEvent,
  squirrelStartup,
} from "../../src/main/windows-install.ts";

const require = createRequire(import.meta.url);
const EXE = "C:\\Users\\ada\\AppData\\Local\\genex\\app-0.1.0\\genex.exe";
const UPDATE_EXE = "C:\\Users\\ada\\AppData\\Local\\genex\\Update.exe";

test("each Squirrel launch maps to its Update.exe step; other launches and other platforms have none", () => {
  // Only an uninstall takes back the sandbox's entries Genex keeps between launches.
  const cases = [
    { argv: [EXE, SquirrelEvent.Install, "0.1.0"], args: ["--createShortcut", "genex.exe"], takeBack: false },
    { argv: [EXE, SquirrelEvent.Updated, "0.1.1"], args: ["--createShortcut", "genex.exe"], takeBack: false },
    { argv: [EXE, SquirrelEvent.Uninstall, "0.1.1"], args: ["--removeShortcut", "genex.exe"], takeBack: true },
    { argv: [EXE, SquirrelEvent.Obsolete, "0.1.0"], args: [], takeBack: false },
  ];
  for (const { argv, args, takeBack } of cases) {
    const expected = { updateExe: UPDATE_EXE, args, takeBackSandbox: takeBack };
    assert.deepEqual(squirrelStartup("win32", argv, EXE), expected, argv[1]);
  }
  assert.equal(squirrelStartup("win32", [EXE], EXE), null);
  assert.equal(squirrelStartup("win32", [EXE, "--squirrel-firstrun"], EXE), null, "the first run opens the app");
  assert.equal(squirrelStartup("darwin", ["/Applications/Genex.app/genex", SquirrelEvent.Install], EXE), null);
});

test("the app user model id is Genex's own outside a Squirrel install; inside one Electron sets Squirrel's", () => {
  assert.equal(
    appUserModelId("win32", EXE, () => false),
    APP_USER_MODEL_ID,
  );
  assert.equal(
    appUserModelId("win32", EXE, (file) => file === UPDATE_EXE),
    null,
  );
  assert.equal(
    appUserModelId("darwin", "/Applications/Genex.app/Contents/MacOS/genex", () => false),
    null,
  );
  assert.equal(
    appUserModelId("linux", "/opt/genex/genex", () => false),
    null,
  );
});

test("the app user model id is the bundle id the packages are signed under", () => {
  const { APP_BUNDLE_ID } = require("../../scripts/package-signing.cjs") as { APP_BUNDLE_ID: string };
  assert.equal(APP_USER_MODEL_ID, APP_BUNDLE_ID);
});

/** A fake `spawn` whose child exits, fails to start or never ends, as `outcome` says. */
function fakeSpawn(outcome: "exit" | "error" | "hang") {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const spawn = (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    if (outcome === "exit") queueMicrotask(() => child.emit("exit", 0));
    if (outcome === "error") queueMicrotask(() => child.emit("error", new Error("ENOENT")));
    return child;
  };
  return { spawn, calls };
}

test("a Squirrel step runs Update.exe and settles whether it exits, fails to start or hangs", async () => {
  for (const outcome of ["exit", "error", "hang"] as const) {
    const fake = fakeSpawn(outcome);
    await runSquirrelStep({ updateExe: UPDATE_EXE, args: ["--createShortcut", "genex.exe"] }, fake.spawn, 5);
    assert.deepEqual(fake.calls, [{ file: UPDATE_EXE, args: ["--createShortcut", "genex.exe"] }], outcome);
  }
  const none = fakeSpawn("exit");
  await runSquirrelStep({ updateExe: UPDATE_EXE, args: [] }, none.spawn, 5);
  assert.deepEqual(none.calls, [], "an obsolete copy only exits");
});

test("a packaged Windows app works from its install folder, wherever it was started; elsewhere the launch's folder stays", () => {
  assert.equal(installedWorkingDir("win32", EXE, true), "C:\\Users\\ada\\AppData\\Local\\genex\\app-0.1.0");
  assert.equal(installedWorkingDir("win32", EXE, false), null, "a development build keeps its checkout");
  assert.equal(installedWorkingDir("darwin", "/Applications/Genex.app/Contents/MacOS/genex", true), null);
});
