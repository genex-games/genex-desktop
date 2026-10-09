/**
 * Set up runs the srt-win.exe the build ships. Inside a package it sits in app.asar's unpacked
 * twin, because Windows cannot start a file from inside the archive; the translation must touch
 * only the archive segment itself.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { installWindowsSandbox, srtWinPath, unpackedPath } from "../../src/substrate/windows-sandbox-setup.ts";
import type { WindowsInstallResult } from "@anthropic-ai/sandbox-runtime";

const STATUS: WindowsInstallResult = {
  user: {
    provisioned: true,
    credPresent: true,
    sid: "test-sid",
    realUserSid: "host-sid",
    groupExists: true,
    inBuiltinUsers: true,
    inSandboxGroup: true,
    hiddenFromLogon: true,
  },
  wfp: { state: "installed", filters: 6 },
};

function installer(before: WindowsInstallResult, after = STATUS) {
  const calls: unknown[] = [];
  const runtime: NonNullable<Parameters<typeof installWindowsSandbox>[0]> = {
    resolveSrtWin: (config?: { path: string }) => ({ exe: config?.path ?? "test-helper", prependArgs: [] }),
    checkWindowsSandboxStatusAsync: async () => before,
    installWindowsSandboxAsync: async (options: unknown) => {
      calls.push(options);
      return after;
    },
    grantWindowsAcl: () => {},
    revokeWindowsAcl: () => [],
    verifyWindowsWfpEgress: async () => ({ target: "synthetic", stderr: "" }),
  };
  return { runtime, calls };
}

test("an existing account with inactive filters is repaired instead of retrying forever", async () => {
  const f = installer({ ...STATUS, wfp: { state: "cannot-read", filters: 0 } });
  let verifies = 0;
  f.runtime.verifyWindowsWfpEgress = async () => {
    if (verifies++ === 0) throw Object.assign(new Error("synthetic inactive fence"), { code: "wfp_fence_inactive" });
    return { target: "synthetic", stderr: "" };
  };
  assert.deepEqual(await installWindowsSandbox(f.runtime), { cancelled: false });
  assert.equal(f.calls.length, 1);
  assert.equal(verifies, 2);
});

test("a working sandbox is never reinstalled or has its password rotated", async () => {
  const f = installer(STATUS);
  assert.deepEqual(await installWindowsSandbox(f.runtime), { cancelled: false });
  assert.deepEqual(f.calls, []);
});

test("readiness probes grant only the shipped helper and always release their bootstrap grant", async () => {
  const f = installer(STATUS);
  const grants: unknown[] = [];
  let revokes = 0;
  f.runtime.grantWindowsAcl = (options) => {
    grants.push(options);
  };
  f.runtime.revokeWindowsAcl = () => {
    revokes++;
    return [];
  };
  await installWindowsSandbox(f.runtime);
  assert.deepEqual(grants, [
    {
      read: [await srtWinPath()],
      write: [],
      sandboxUserSid: STATUS.user.sid,
      srtWin: f.runtime.resolveSrtWin({ path: await srtWinPath() }),
    },
  ]);
  assert.equal(revokes, 1);
  assert.equal(f.calls.length, 0);
});

for (const failure of ["grant", "probe"] as const) {
  test(`a ${failure} failure releases partial bootstrap grants and does not silently reinstall`, async () => {
    const f = installer(STATUS);
    const error = new Error("synthetic readiness failure");
    let revokes = 0;
    if (failure === "grant")
      f.runtime.grantWindowsAcl = () => {
        throw error;
      };
    else
      f.runtime.verifyWindowsWfpEgress = async () => {
        throw error;
      };
    f.runtime.revokeWindowsAcl = () => {
      revokes++;
      return [];
    };
    await assert.rejects(installWindowsSandbox(f.runtime), (caught) => caught === error);
    assert.equal(revokes, 1);
    assert.equal(f.calls.length, 0);
  });
}

for (const after of [
  { ...STATUS, user: { ...STATUS.user, provisioned: false } },
  { ...STATUS, user: { ...STATUS.user, credPresent: false } },
  { ...STATUS, wfp: { state: "absent" as const, filters: 0 } },
]) {
  test("incomplete provisioning never reports install success", async () => {
    const f = installer({ ...STATUS, user: { ...STATUS.user, provisioned: false } }, after);
    await assert.rejects(installWindowsSandbox(f.runtime), /setup did not finish/);
  });
}

test("UAC cancellation remains retryable, and installs run only the shipped executable", async () => {
  const missing = { ...STATUS, user: { ...STATUS.user, provisioned: false } };
  const f = installer(missing, { ...missing, cancelled: true });
  assert.deepEqual(await installWindowsSandbox(f.runtime), { cancelled: true });
  assert.equal(f.calls.length, 1);
  assert.equal((f.calls[0] as { srtWin: { exe: string } }).srtWin.exe, await srtWinPath());
});

test("a path inside app.asar becomes its app.asar.unpacked twin; any other path is unchanged", () => {
  const win = "\\";
  const cases = [
    [
      "C:\\Users\\ada\\AppData\\Local\\genex\\app-0.1.0\\resources\\app.asar\\node_modules\\x\\srt-win.exe",
      "C:\\Users\\ada\\AppData\\Local\\genex\\app-0.1.0\\resources\\app.asar.unpacked\\node_modules\\x\\srt-win.exe",
    ],
    ["C:\\dev\\genex\\node_modules\\x\\srt-win.exe", "C:\\dev\\genex\\node_modules\\x\\srt-win.exe"],
    // Already unpacked, or a folder that only looks like the archive, stays as it is.
    ["C:\\a\\app.asar.unpacked\\x.exe", "C:\\a\\app.asar.unpacked\\x.exe"],
    ["C:\\a\\my-app.asar\\x.exe", "C:\\a\\my-app.asar\\x.exe"],
    ["C:\\a\\app.asarx\\x.exe", "C:\\a\\app.asarx\\x.exe"],
  ];
  for (const [from, to] of cases) assert.equal(unpackedPath(from, win), to, from);
  assert.equal(
    unpackedPath("/Applications/Genex.app/Contents/Resources/app.asar/x", "/"),
    "/Applications/Genex.app/Contents/Resources/app.asar.unpacked/x",
  );
});

test("outside a package the shipped srt-win.exe is sandbox-runtime's own vendored copy", async () => {
  const exe = await srtWinPath();
  assert.equal(path.basename(exe), "srt-win.exe");
  assert.ok(exe.includes(path.join("@anthropic-ai", "sandbox-runtime", "vendor", "srt-win")), exe);
});
