/**
 * The self test and the smoke park their shown window off the visible desktop so capturePage has a
 * real compositor surface without taking over the screen. Windows' native occlusion tracking marks
 * such a window as hidden and stops requestAnimationFrame, so a game in it stood at frame 0 on the
 * Windows runner ("a scaffolded game animates without anyone calling start(): frame 0 -> 0").
 * Test launches on Windows turn occlusion tracking off; a normal launch never changes it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  linuxSecretStorageSwitches,
  quitsWhenLastWindowCloses,
  testLaunchChromiumSwitches,
} from "../../src/main/dev/launch-flags.ts";

test("a Windows test launch turns off native occlusion tracking for its parked window", () => {
  assert.deepEqual(testLaunchChromiumSwitches({ platform: "win32", testLaunch: true }), [
    ["disable-features", "CalculateNativeWinOcclusion"],
  ]);
});

test("normal launches and other platforms add no Chromium switch", () => {
  assert.deepEqual(testLaunchChromiumSwitches({ platform: "win32", testLaunch: false }), []);
  assert.deepEqual(testLaunchChromiumSwitches({ platform: "darwin", testLaunch: true }), []);
  assert.deepEqual(testLaunchChromiumSwitches({ platform: "linux", testLaunch: true }), []);
});

// Off macOS closing the last window quits the app. The self test destroys its window before it
// prints its report, so on the Windows runner the app went through a normal quit and exited 0
// with no report ("e2e: no report was produced (exit 0)"). A test launch's runner decides when it exits.
test("closing the last window quits a normal launch off macOS, never a test launch", () => {
  assert.equal(quitsWhenLastWindowCloses({ platform: "win32", testLaunch: false }), true);
  assert.equal(quitsWhenLastWindowCloses({ platform: "linux", testLaunch: false }), true);
  assert.equal(quitsWhenLastWindowCloses({ platform: "darwin", testLaunch: false }), false);
  assert.equal(quitsWhenLastWindowCloses({ platform: "win32", testLaunch: true }), false);
  assert.equal(quitsWhenLastWindowCloses({ platform: "linux", testLaunch: true }), false);
});

// Electron 43 picks `basic_text` (a public key) on desktops Chromium does not recognise, such as
// Hyprland, and the secret store refuses it. Genex asks for the Secret Service there, and leaves
// KDE to KWallet. KDE is detected the way Chromium's `GetDesktopEnvironment` does.
const SECRET_SERVICE: [string, string][] = [["password-store", "gnome-libsecret"]];
const linuxCases: { name: string; env: Record<string, string>; expected: [string, string][] }[] = [
  { name: "no desktop variables", env: {}, expected: SECRET_SERVICE },
  { name: "Hyprland", env: { XDG_CURRENT_DESKTOP: "Hyprland" }, expected: SECRET_SERVICE },
  {
    name: "Hyprland with KDE_SESSION_VERSION alone, which is not KDE",
    env: { XDG_CURRENT_DESKTOP: "Hyprland", KDE_SESSION_VERSION: "6" },
    expected: SECRET_SERVICE,
  },
  { name: "XDG_CURRENT_DESKTOP=KDE", env: { XDG_CURRENT_DESKTOP: "KDE" }, expected: [] },
  { name: "KDE listed after an unknown desktop", env: { XDG_CURRENT_DESKTOP: "Hyprland:KDE" }, expected: [] },
  {
    name: "GNOME listed before KDE, which Chromium resolves first",
    env: { XDG_CURRENT_DESKTOP: "GNOME:KDE" },
    expected: SECRET_SERVICE,
  },
  { name: "Plasma is not a Chromium desktop name", env: { XDG_CURRENT_DESKTOP: "Plasma" }, expected: SECRET_SERVICE },
  { name: "DESKTOP_SESSION=kde-plasma", env: { DESKTOP_SESSION: "kde-plasma" }, expected: [] },
  { name: "DESKTOP_SESSION=kde4", env: { DESKTOP_SESSION: "kde4" }, expected: [] },
  {
    name: "DESKTOP_SESSION=kde with a session version",
    env: { DESKTOP_SESSION: "kde", KDE_SESSION_VERSION: "5" },
    expected: [],
  },
  {
    name: "DESKTOP_SESSION=kde without a session version (KDE3)",
    env: { DESKTOP_SESSION: "kde" },
    expected: SECRET_SERVICE,
  },
  { name: "DESKTOP_SESSION=gnome", env: { DESKTOP_SESSION: "gnome" }, expected: SECRET_SERVICE },
  {
    name: "KDE_FULL_SESSION with a session version",
    env: { KDE_FULL_SESSION: "true", KDE_SESSION_VERSION: "6" },
    expected: [],
  },
  { name: "KDE_FULL_SESSION alone (KDE3)", env: { KDE_FULL_SESSION: "true" }, expected: SECRET_SERVICE },
  {
    name: "GNOME_DESKTOP_SESSION_ID before KDE_FULL_SESSION",
    env: { GNOME_DESKTOP_SESSION_ID: "this-is-deprecated", KDE_FULL_SESSION: "true", KDE_SESSION_VERSION: "6" },
    expected: SECRET_SERVICE,
  },
];

for (const { name, env, expected } of linuxCases) {
  test(`Linux secret storage: ${name}`, () => {
    assert.deepEqual(linuxSecretStorageSwitches({ platform: "linux", env, hasPasswordStoreSwitch: false }), expected);
  });
}

test("an explicit password-store switch and other platforms keep Chromium's own choice", () => {
  const env = { XDG_CURRENT_DESKTOP: "Hyprland" };
  assert.deepEqual(linuxSecretStorageSwitches({ platform: "linux", env, hasPasswordStoreSwitch: true }), []);
  assert.deepEqual(linuxSecretStorageSwitches({ platform: "darwin", env, hasPasswordStoreSwitch: false }), []);
  assert.deepEqual(linuxSecretStorageSwitches({ platform: "win32", env, hasPasswordStoreSwitch: false }), []);
});
