/**
 * Set up runs the srt-win.exe the build ships. Inside a package it sits in app.asar's unpacked
 * twin, because Windows cannot start a file from inside the archive; the translation must touch
 * only the archive segment itself. Set up does what the held problem needs: srt-win's install,
 * turning the Secondary Logon service back on, or both, each behind its own approval.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { SandboxProblemCode, StudioPlatform, type SandboxProblem, WindowsSetupNeed } from "../../src/shared/boot.ts";
import { ServiceStartType } from "../../src/substrate/windows-logon-service.ts";
import {
  installWindowsSandbox,
  srtWinPath,
  unpackedPath,
  type WindowsSetupSteps,
} from "../../src/substrate/windows-sandbox-setup.ts";

/** A Windows setup problem with `needs`; none given is the problem srt-win's typed refusal makes. */
function problem(needs?: WindowsSetupNeed[]): SandboxProblem {
  return {
    code: SandboxProblemCode.NotProvisioned,
    platform: StudioPlatform.Windows,
    missingTools: [],
    installCommands: [],
    details: [],
    ...(needs ? { windowsNeeds: needs } : {}),
  };
}

/** Set up's steps as recorders: the service's start type now, and each step's answer. */
function steps(options: { startType?: ServiceStartType | null; enable?: { cancelled: boolean } | Error } = {}) {
  const ran: string[] = [];
  const recorded: WindowsSetupSteps = {
    logonServiceStartType: async () => {
      ran.push("read");
      return options.startType === undefined ? ServiceStartType.Disabled : options.startType;
    },
    enableLogonService: async () => {
      ran.push("enable");
      if (options.enable instanceof Error) throw options.enable;
      return options.enable ?? { cancelled: false };
    },
    installSandbox: async () => {
      ran.push("install");
      return { cancelled: false };
    },
  };
  return { steps: recorded, ran };
}

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

test("Set up installs the sandbox alone when that is all it needs, or when the problem does not say", async () => {
  for (const held of [problem(), problem([WindowsSetupNeed.Sandbox])]) {
    const run = steps();
    assert.deepEqual(await installWindowsSandbox(held, run.steps), { cancelled: false });
    assert.deepEqual(run.ran, ["install"]);
  }
});

test("Set up turns the Secondary Logon service back on, and installs nothing a set-up PC has", async () => {
  const run = steps();
  assert.deepEqual(await installWindowsSandbox(problem([WindowsSetupNeed.LogonService]), run.steps), {
    cancelled: false,
  });
  assert.deepEqual(run.ran, ["read", "enable"]);
});

test("Set up does both in one go, the service first", async () => {
  const run = steps();
  const both = problem([WindowsSetupNeed.Sandbox, WindowsSetupNeed.LogonService]);
  assert.deepEqual(await installWindowsSandbox(both, run.steps), { cancelled: false });
  assert.deepEqual(run.ran, ["read", "enable", "install"]);
});

test("a service already back on (an earlier approval, or by hand) is not asked for again", async () => {
  for (const startType of [ServiceStartType.Demand, ServiceStartType.Auto]) {
    const run = steps({ startType });
    const both = problem([WindowsSetupNeed.Sandbox, WindowsSetupNeed.LogonService]);
    await installWindowsSandbox(both, run.steps);
    assert.deepEqual(run.ran, ["read", "install"], startType);
  }
  // A start type `sc` cannot read now is turned on as the problem asked.
  const unread = steps({ startType: null });
  await installWindowsSandbox(problem([WindowsSetupNeed.LogonService]), unread.steps);
  assert.deepEqual(unread.ran, ["read", "enable"]);
});

test("a dismissed approval for the service is a cancelled Set up that installs nothing", async () => {
  const run = steps({ enable: { cancelled: true } });
  const both = problem([WindowsSetupNeed.Sandbox, WindowsSetupNeed.LogonService]);
  assert.deepEqual(await installWindowsSandbox(both, run.steps), { cancelled: true });
  assert.deepEqual(run.ran, ["read", "enable"]);
});

test("a service Windows would not turn on fails Set up with its words", async () => {
  const run = steps({ enable: new Error("could not turn on seclogon (sc exited 5)") });
  await assert.rejects(installWindowsSandbox(problem([WindowsSetupNeed.LogonService]), run.steps), /exited 5/);
});
