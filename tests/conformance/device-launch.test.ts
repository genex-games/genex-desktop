/**
 * The person's launch of a game's packaged phone build on a Simulator, an emulator or a phone
 * (`studio:native.launchDevice`, M3.8). Containment stage 1: a device run is outside
 * ProcessSandbox, so only the person starts one from Studio's window. These rows drive the real
 * registrar over stand-ins for `xcrun simctl` and `adb` (shell scripts that log their arguments,
 * or an injected exec), so no Simulator, emulator or phone is ever reached:
 *
 * - a fixture profile refuses the channel before its handler runs;
 * - no harness method reaches it: an agent-side call cannot start a launch;
 * - only a package the host admitted is launched (the phone exports admit theirs into the host's
 *   phone package store): none admitted, a package whose bytes are not the admitted ones, or one reached through a
 *   link (an escape out of the host's package folder) is refused before any device tool runs, and
 *   so is a device id, a request or a game the host does not take; the device tool installs a
 *   private copy of the verified bytes, never the package's own path;
 * - a launch that ran records a persisted `device_launch` event with the device, the build's
 *   digest and the outcome.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, link, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  type AdmittedPackages,
  DEVICE_PACKAGE,
  type DeviceTools,
  packageDigest,
  phonePackageDir,
  phonePackageStore,
} from "../../src/main/core/device-launch.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerNativeIpc } from "../../src/main/ipc/native.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import {
  DeviceKind,
  type DeviceLaunchResult,
  DeviceLaunchOutcome,
  type DeviceTarget,
} from "../../src/shared/device-launch.ts";
import { BuildTarget, type GameProject, GameStack } from "../../src/shared/game-project.ts";
import { NativeRefusal } from "../../src/shared/native-contract.ts";
import { encode, LineCodec, type RpcResponse } from "../../src/shared/protocol.ts";
import { execXcode, type XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import { HarnessHost } from "../../src/substrate/harness-host.ts";
import type { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult<unknown>>;

const studio = { sender: "studio-webcontents", senderFrame: "studio-main-frame" };
const isStudioUi = (event: IpcSender) => event.sender === studio.sender && event.senderFrame === studio.senderFrame;
const CHANNEL = "studio:native.launchDevice";
const AT = "2026-10-07T03:00:00.000Z";
const BUNDLE_ID = "games.genex.game.0123456789ab";
const SIM_UDID = "8A1B2C3D-0000-4000-8000-00000000A1B2";
const POSIX = process.platform !== "win32";
const IOS_SIMULATOR_APP = DEVICE_PACKAGE[BuildTarget.Ios][DeviceKind.Simulator];
const ANDROID_APK = DEVICE_PACKAGE[BuildTarget.Android][DeviceKind.Emulator];

/** A Rust game with both phone destinations, in a temp library. */
function rustGame(
  root: string,
  targets: readonly BuildTarget[] = [BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android],
) {
  return {
    name: "pond",
    dir: path.join(root, "games", "pond"),
    title: "Pond",
    createdAt: AT,
    pathLabel: "~/AI Games/pond",
    library: true,
    shape: { kind: "studio" },
    built: false,
    destinations: { stack: GameStack.RustWgpu, targets },
  } as unknown as GameProject;
}

interface Rig {
  root: string;
  /** The host's own phone package folder the rig's admissions point at. */
  exports: string;
  /** The digests the admission recorded, by `<target>/<device>`. */
  admitted: Map<string, string>;
  recorded: unknown[];
  invoke(payload: unknown): Promise<IpcResult<unknown>>;
}

const admittedKey = (target: DeviceTarget, device: DeviceKind) => `${target}/${device}`;

/** The native registrar over a fake core whose library holds `game`, with the device tools given. */
async function rig(options: {
  tools: DeviceTools;
  fixture?: boolean;
  host?: NodeJS.Platform;
  targets?: readonly BuildTarget[];
  /** False: no admitted packages at all, as a host with no phone export yet. */
  packages?: boolean;
  /** The admitted packages to launch from instead of the rig's own map (the host's phone package store). */
  store?: AdmittedPackages;
}): Promise<Rig> {
  const root = await tmpDir("device-launch-");
  const exports = path.join(root, "phone-packages");
  await mkdir(exports, { recursive: true });
  const admitted = new Map<string, string>();
  const packages: AdmittedPackages = {
    root: exports,
    digestOf: async (_project, target, device) => admitted.get(admittedKey(target, device)) ?? null,
  };
  const game = rustGame(root, options.targets);
  const recorded: unknown[] = [];
  const core = {
    nativeRuns: { onStatus: () => () => {} },
    games: { list: async () => [game], bundleIdFor: async () => BUNDLE_ID },
    assertProjectAllowed: async () => {},
    layout: { exports },
    async append(batch: unknown[]) {
      recorded.push(...batch);
      return "event-id";
    },
  } as unknown as Parameters<typeof registerNativeIpc>[1];
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener as Listener) },
    { fixture: options.fixture === true, isStudioUi },
  );
  registerNativeIpc(handle, core, {
    now: () => Date.parse(AT),
    device: {
      tools: options.tools,
      host: options.host ?? StudioPlatform.Mac,
      packages: options.packages === false ? null : (options.store ?? packages),
    },
  });
  const listener = listeners.get(CHANNEL);
  assert.ok(listener, `${CHANNEL} is not registered`);
  return { root, exports, admitted, recorded, invoke: (payload) => listener(studio, payload) };
}

/** An exec that logs every call and answers from `answer` (a booted Simulator and one emulator by default). */
function fakeExec(
  answer: (file: string, args: readonly string[]) => { code: number; stdout: string } | null = () => null,
) {
  const calls: string[][] = [];
  const exec: XcodeExec = async (file, args) => {
    calls.push([path.basename(file), ...args]);
    const given = answer(file, args);
    if (given) return { ...given, stderr: "" };
    if (args.includes("list")) return { code: 0, stdout: simctlList([SIM_UDID]), stderr: "" };
    if (args[0] === "devices")
      return { code: 0, stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const tools: DeviceTools = { exec, xcrun: async () => "/usr/bin/xcrun", adb: async () => "/sdk/platform-tools/adb" };
  return { calls, tools };
}

/** `simctl list devices booted --json` naming `udids` as booted iPhones. */
function simctlList(udids: readonly string[]): string {
  const devices = udids.map((udid) => ({ udid, name: "iPhone 17", state: "Booted", isAvailable: true }));
  return JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": devices } });
}

/** Writes the packaged build a launch of `target` on `device` installs, under a package folder. */
async function packageBuild(exports: string, target: DeviceTarget, device: DeviceKind): Promise<string> {
  const parts = DEVICE_PACKAGE[target][device];
  assert.ok(parts, `${target} on ${device} has a package`);
  const at = path.join(phonePackageDir(exports, "pond", target), ...parts);
  if (target === BuildTarget.Android) {
    await mkdir(path.dirname(at), { recursive: true });
    await writeFile(at, "PK\u0003\u0004 apk bytes");
    return at;
  }
  await mkdir(path.join(at, "Contents"), { recursive: true });
  await writeFile(path.join(at, "game"), "Ïúíþ arm64");
  await writeFile(path.join(at, "Info.plist"), "<plist/>");
  return at;
}

/** Packages the build in the rig's host folder and records its admission, as the export lane will. */
async function admittedBuild(launch: Rig, target: DeviceTarget, device: DeviceKind): Promise<string> {
  const at = await packageBuild(launch.exports, target, device);
  launch.admitted.set(admittedKey(target, device), await packageDigest(at, target));
  return at;
}

function launchRequest(target: DeviceTarget, device: DeviceKind, deviceId?: string) {
  return { project: "pond", request: deviceId === undefined ? { target, device } : { target, device, deviceId } };
}

function answered(reply: IpcResult<unknown>): DeviceLaunchResult {
  assert.ok(reply.ok, JSON.stringify(reply));
  return reply.value as DeviceLaunchResult;
}

/** The one `device_launch` record the rig holds. */
function onlyRecord(recorded: readonly unknown[]): Record<string, unknown> {
  assert.equal(recorded.length, 1, JSON.stringify(recorded));
  const record = recorded[0] as { type: string; event_type: string; payload: Record<string, unknown> };
  assert.equal(record.type, "custom");
  assert.equal(record.event_type, CustomEvent.DeviceLaunch);
  return record.payload;
}

/** A stand-in tool: a shell script that logs its arguments one call a line and prints an answer's file for `match`. */
async function standIn(dir: string, name: string, log: string, answers: Record<string, string>): Promise<string> {
  const file = path.join(dir, name);
  const entries = Object.entries(answers);
  for (const [index, [, stdout]] of entries.entries()) await writeFile(path.join(dir, `${name}-${index}.out`), stdout);
  const cases = entries
    .map(([match], index) => `  *"${match}"*) cat '${path.join(dir, `${name}-${index}.out`)}' ;;`)
    .join("\n");
  await writeFile(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n${cases}\n  *) ;;\nesac\nexit 0\n`);
  await chmod(file, 0o755);
  return file;
}

test("a fixture profile refuses a device launch before its handler: no tool runs and nothing is recorded", async () => {
  const { calls, tools } = fakeExec();
  const fixture = await rig({ tools, fixture: true });
  await packageBuild(fixture.exports, BuildTarget.Ios, DeviceKind.Simulator);
  const reply = await fixture.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator));
  assert.equal(reply.ok, false);
  assert.match(String((reply as { error: string }).error), /^unsupported-in-fixture/);
  assert.deepEqual(calls, []);
  assert.deepEqual(fixture.recorded, []);
});

test("no harness method reaches a device launch: an agent-side call is refused and starts nothing", async () => {
  const { api, core } = await coreLite({ init: false });
  // The same core also serves the person's launch, over device tools that log every call and an
  // admitted package: were any agent-side call to reach it, a tool would run and a record land.
  const { calls, tools } = fakeExec();
  const recorded: unknown[] = [];
  const append = core.append.bind(core);
  core.append = async (batch: Parameters<typeof core.append>[0]) => {
    recorded.push(...batch.filter((entry) => JSON.stringify(entry).includes(CustomEvent.DeviceLaunch)));
    return append(batch);
  };
  const launchRig = await rig({ tools });
  await admittedBuild(launchRig, BuildTarget.Ios, DeviceKind.Simulator);
  const methods = Object.keys(api());
  for (const name of [CHANNEL, "native.launchDevice", "device.launch", "simulator.launch"])
    assert.ok(!methods.includes(name), name);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    kill(signal: string) {
      setImmediate(() => child.emit("exit", null, signal));
      return true;
    },
  });
  const sandbox = { spawnLongLived: async () => ({ child, sandboxed: false }) } as unknown as ProcessSandbox;
  const host = new HarnessHost({
    workspace: "/nowhere",
    bootstrap: "/nowhere/bootstrap.mjs",
    execPath: process.execPath,
    sandbox,
    api: api(),
    updatesDir: "/nowhere/updates",
    platform: StudioPlatform.Linux,
  });
  const answers = new Map<number, (response: RpcResponse) => void>();
  const codec = new LineCodec();
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    for (const message of codec.push<{ kind: string; id: number }>(chunk))
      if (message.kind === "rpc-result") answers.get(message.id)?.(message as RpcResponse);
  });
  const started = host.start();
  child.stdout.write(encode({ kind: "ready", harnessVersion: "test", capabilities: [] }));
  await started;
  try {
    const request = { project: "pond", request: { target: "ios", device: "simulator" } };
    let id = 0;
    for (const method of [CHANNEL, "native.launchDevice", "nativeLaunchDevice"]) {
      id++;
      const answer = new Promise<RpcResponse>((resolve) => answers.set(id, resolve));
      child.stdout.write(encode({ kind: "rpc", id, method, params: request }));
      const response = await answer;
      assert.ok("error" in response && response.error, `${method} answered ${JSON.stringify(response)}`);
    }
    assert.deepEqual(calls, [], "no device tool ran");
    assert.deepEqual(recorded, [], "no device_launch was recorded by the core");
    assert.deepEqual(launchRig.recorded, [], "nor by the person's launch channel");
  } finally {
    await host.stop(50);
  }
});

test("a packaged build reached through a link is refused before simctl or adb runs, and recorded", async () => {
  // Each row plants the build the launch would install somewhere outside its export folder (or a
  // link inside it) and asks for the launch: the refusal comes before any device tool is asked.
  const rows: Array<{
    name: string;
    target: DeviceTarget;
    device: DeviceKind;
    plant(rig: Rig): Promise<void>;
    refusal: NativeRefusal;
  }> = [
    {
      name: "the game's export folder is a link out",
      target: BuildTarget.Ios,
      device: DeviceKind.Simulator,
      refusal: NativeRefusal.Symlink,
      async plant({ root, exports }) {
        const outside = path.join(root, "outside");
        await packageBuild(outside, BuildTarget.Ios, DeviceKind.Simulator);
        await symlink(
          phonePackageDir(outside, "pond", BuildTarget.Ios),
          phonePackageDir(exports, "pond", BuildTarget.Ios),
        );
      },
    },
    {
      name: "the app is a link out",
      target: BuildTarget.Ios,
      device: DeviceKind.Simulator,
      refusal: NativeRefusal.Symlink,
      async plant({ root, exports }) {
        const outside = await packageBuild(path.join(root, "outside"), BuildTarget.Ios, DeviceKind.Simulator);
        const at = path.join(phonePackageDir(exports, "pond", BuildTarget.Ios), ...IOS_SIMULATOR_APP);
        await mkdir(path.dirname(at), { recursive: true });
        await symlink(outside, at);
      },
    },
    {
      name: "a folder between the export folder and the app is a link out",
      target: BuildTarget.Ios,
      device: DeviceKind.Simulator,
      refusal: NativeRefusal.Symlink,
      async plant({ root, exports }) {
        const outside = await packageBuild(path.join(root, "outside"), BuildTarget.Ios, DeviceKind.Simulator);
        await mkdir(phonePackageDir(exports, "pond", BuildTarget.Ios), { recursive: true });
        const [between] = IOS_SIMULATOR_APP;
        await symlink(path.dirname(outside), path.join(phonePackageDir(exports, "pond", BuildTarget.Ios), between));
      },
    },
    {
      name: "a file inside the app is a link out",
      target: BuildTarget.Ios,
      device: DeviceKind.Simulator,
      refusal: NativeRefusal.Symlink,
      async plant({ exports }) {
        const app = await packageBuild(exports, BuildTarget.Ios, DeviceKind.Simulator);
        await symlink("/etc/hosts", path.join(app, "Contents", "hosts"));
      },
    },
    {
      name: "the APK is a link out",
      target: BuildTarget.Android,
      device: DeviceKind.Emulator,
      refusal: NativeRefusal.Symlink,
      async plant({ root, exports }) {
        const outside = await packageBuild(path.join(root, "outside"), BuildTarget.Android, DeviceKind.Emulator);
        const at = path.join(phonePackageDir(exports, "pond", BuildTarget.Android), ...ANDROID_APK);
        await mkdir(path.dirname(at), { recursive: true });
        await symlink(outside, at);
      },
    },
    {
      name: "the APK is a hard link to a file outside",
      target: BuildTarget.Android,
      device: DeviceKind.Emulator,
      refusal: NativeRefusal.HardLink,
      async plant({ root, exports }) {
        const outside = await packageBuild(path.join(root, "outside"), BuildTarget.Android, DeviceKind.Emulator);
        const at = path.join(phonePackageDir(exports, "pond", BuildTarget.Android), ...ANDROID_APK);
        await mkdir(path.dirname(at), { recursive: true });
        await link(outside, at);
      },
    },
    {
      name: "no packaged build exists yet",
      target: BuildTarget.Ios,
      device: DeviceKind.Simulator,
      refusal: NativeRefusal.Unsupported,
      async plant() {},
    },
  ];
  for (const row of rows) {
    if (!POSIX) continue;
    const { calls, tools } = fakeExec();
    const launch = await rig({ tools });
    // An admission on record, so the walk to the package is what refuses.
    launch.admitted.set(admittedKey(row.target, row.device), "0".repeat(64));
    await row.plant(launch);
    const result = answered(await launch.invoke(launchRequest(row.target, row.device)));
    assert.deepEqual(
      [result.outcome, result.refusal, result.buildDigest, result.deviceId],
      [DeviceLaunchOutcome.Refused, row.refusal, null, null],
      row.name,
    );
    assert.deepEqual(calls, [], `${row.name}: no device tool ran`);
    assert.deepEqual(onlyRecord(launch.recorded), { project: "pond", ...result }, row.name);
  }
});

test("a device id, a request or a game the host does not take is refused before any device tool runs", async () => {
  const { calls, tools } = fakeExec();
  const launch = await rig({ tools });
  await admittedBuild(launch, BuildTarget.Ios, DeviceKind.Simulator);
  // Malformed: an error, never a launch, and nothing recorded.
  const malformed: unknown[] = [
    undefined,
    { project: "pond" },
    { project: "pond", request: null },
    { project: "pond", request: { target: "mac", device: "simulator" } },
    { project: "pond", request: { target: "ios", device: "laptop" } },
    { project: "../pond", request: { target: "ios", device: "simulator" } },
    { project: "nope", request: { target: "ios", device: "simulator" } },
    ...["", "-s", "--help", "a b", "a;reboot", "a\nb", "$(id)", "x".repeat(200), 5, null].map((deviceId) => ({
      project: "pond",
      request: { target: "ios", device: "simulator", deviceId },
    })),
  ];
  for (const payload of malformed) {
    const reply = await launch.invoke(payload);
    assert.equal(reply.ok, false, JSON.stringify(payload));
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(launch.recorded, []);
  // Typed refusals, recorded: a destination the game does not name, a device that does not run
  // that destination, and an iOS launch off a Mac.
  const refusals: Array<{
    host?: NodeJS.Platform;
    targets?: BuildTarget[];
    target: DeviceTarget;
    device: DeviceKind;
    refusal: NativeRefusal;
  }> = [
    {
      targets: [BuildTarget.Web, BuildTarget.Mac],
      target: BuildTarget.Ios,
      device: DeviceKind.Simulator,
      refusal: NativeRefusal.NotADestination,
    },
    { target: BuildTarget.Android, device: DeviceKind.Simulator, refusal: NativeRefusal.NotRunnableHere },
    { target: BuildTarget.Ios, device: DeviceKind.Emulator, refusal: NativeRefusal.NotRunnableHere },
    {
      host: StudioPlatform.Linux,
      target: BuildTarget.Ios,
      device: DeviceKind.Simulator,
      refusal: NativeRefusal.NotRunnableHere,
    },
  ];
  for (const row of refusals) {
    const quiet = fakeExec();
    const typed = await rig({ tools: quiet.tools, host: row.host, targets: row.targets });
    const result = answered(await typed.invoke(launchRequest(row.target, row.device)));
    assert.deepEqual([result.outcome, result.refusal], [DeviceLaunchOutcome.Refused, row.refusal], JSON.stringify(row));
    assert.deepEqual(quiet.calls, [], JSON.stringify(row));
    assert.equal(onlyRecord(typed.recorded).refusal, row.refusal);
  }
  // Without the tool on this host: refused, nothing ran.
  const noAdb = await rig({ tools: { ...tools, adb: async () => null } });
  await admittedBuild(noAdb, BuildTarget.Android, DeviceKind.Emulator);
  const missing = answered(await noAdb.invoke(launchRequest(BuildTarget.Android, DeviceKind.Emulator)));
  assert.deepEqual([missing.outcome, missing.refusal], [DeviceLaunchOutcome.Refused, NativeRefusal.NotRunnableHere]);
  assert.deepEqual(calls, []);
});

test("a Simulator launch installs and starts the packaged app through simctl and records device_launch", {
  skip: !POSIX,
}, async () => {
  const bin = await tmpDir("device-launch-bin-");
  const log = path.join(bin, "calls.log");
  const xcrun = await standIn(bin, "xcrun", log, { "simctl list": simctlList([SIM_UDID]) });
  const tools: DeviceTools = { exec: execXcode, xcrun: async () => xcrun, adb: async () => null };
  const launch = await rig({ tools });
  const app = await admittedBuild(launch, BuildTarget.Ios, DeviceKind.Simulator);
  const result = answered(await launch.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator)));
  assert.equal(result.outcome, DeviceLaunchOutcome.Launched);
  assert.deepEqual(
    [result.target, result.device, result.deviceId, result.refusal, result.at],
    [BuildTarget.Ios, DeviceKind.Simulator, SIM_UDID, null, AT],
  );
  assert.match(result.buildDigest ?? "", /^[0-9a-f]{64}$/);
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.equal(lines[0], "simctl list devices booted --json");
  assert.equal(lines[2], `simctl launch ${SIM_UDID} ${BUNDLE_ID}`);
  // The install names a private copy of the verified bytes, never the package's own path.
  const installed = lines[1]?.replace(`simctl install ${SIM_UDID} `, "") ?? "";
  assert.match(installed, /genex-device-launch-[^/]+\/Game\.app$/);
  assert.notEqual(installed, app);
  assert.equal(
    await lstat(installed).then(
      () => true,
      () => false,
    ),
    false,
    "the copy is gone after the launch",
  );
  assert.equal(result.buildDigest, launch.admitted.get(admittedKey(BuildTarget.Ios, DeviceKind.Simulator)));
  assert.deepEqual(onlyRecord(launch.recorded), { project: "pond", ...result });
  const again = answered(await launch.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator, SIM_UDID)));
  assert.equal(again.buildDigest, result.buildDigest);
  // Bytes changed after the admission are not the admitted build: refused, nothing installed.
  await writeFile(path.join(app, "game"), "changed");
  const before = (await readFile(log, "utf8")).trim().split("\n").length;
  const changed = answered(await launch.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator)));
  assert.deepEqual([changed.outcome, changed.refusal], [DeviceLaunchOutcome.Refused, NativeRefusal.NotAnExecutable]);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, before, "no device tool ran");
});

test("with no admitted phone package every launch is refused before any tool runs", async () => {
  const { calls, tools } = fakeExec();
  const none = await rig({ tools, packages: false });
  // A package an agent could have written into the exports folder is never read.
  await packageBuild(path.join(none.root, "exports"), BuildTarget.Ios, DeviceKind.Simulator);
  await packageBuild(none.exports, BuildTarget.Android, DeviceKind.Emulator);
  for (const [target, device] of [
    [BuildTarget.Ios, DeviceKind.Simulator],
    [BuildTarget.Android, DeviceKind.Emulator],
  ] as const) {
    const result = answered(await none.invoke(launchRequest(target, device)));
    assert.deepEqual(
      [result.outcome, result.refusal, result.buildDigest],
      [DeviceLaunchOutcome.Refused, NativeRefusal.Unsupported, null],
    );
  }
  assert.deepEqual(calls, []);
  // Admissions exist, but not for this package: the same refusal.
  const unadmitted = await rig({ tools });
  await packageBuild(unadmitted.exports, BuildTarget.Ios, DeviceKind.Simulator);
  const result = answered(await unadmitted.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator)));
  assert.deepEqual([result.outcome, result.refusal], [DeviceLaunchOutcome.Refused, NativeRefusal.Unsupported]);
  assert.deepEqual(calls, []);
});

test("an export's admitted package is what a launch installs: the store copies it and records its digest", async () => {
  const { calls, tools } = fakeExec();
  const staging = await tmpDir("device-launch-staging-");
  const store = phonePackageStore(path.join(staging, "phone-packages"));
  const launch = await rig({ tools, store });
  // Nothing exported yet: refused before any tool runs.
  const before = answered(await launch.invoke(launchRequest(BuildTarget.Android, DeviceKind.Emulator)));
  assert.deepEqual([before.outcome, before.refusal], [DeviceLaunchOutcome.Refused, NativeRefusal.Unsupported]);
  assert.deepEqual(calls, []);
  // The Android export admits its dev APK (from staging) for an emulator and a phone.
  const apk = path.join(staging, "pond-debug.apk");
  await writeFile(apk, "PK\u0003\u0004 dev apk");
  await store.admit("pond", BuildTarget.Android, [DeviceKind.Emulator, DeviceKind.Phone], apk);
  await writeFile(apk, "changed in staging after the admission");
  const launched = answered(await launch.invoke(launchRequest(BuildTarget.Android, DeviceKind.Emulator)));
  assert.equal(launched.outcome, DeviceLaunchOutcome.Launched);
  const copy = path.join(phonePackageDir(store.root, "pond", BuildTarget.Android), ...ANDROID_APK);
  assert.equal(
    launched.buildDigest,
    await packageDigest(copy, BuildTarget.Android),
    "the store's copy, not the staged file",
  );
  assert.equal(await store.digestOf("pond", BuildTarget.Android, DeviceKind.Phone), launched.buildDigest);
  // The iPhone export admits a Simulator app for the Simulator only; a launch on an iPhone stays refused.
  const app = path.join(staging, "Pond.app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "game"), "Ïúíþ arm64");
  await store.admit("pond", BuildTarget.Ios, [DeviceKind.Simulator], app);
  const simulator = answered(await launch.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator)));
  assert.equal(simulator.outcome, DeviceLaunchOutcome.Launched);
  const phone = answered(await launch.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Phone)));
  assert.deepEqual([phone.outcome, phone.refusal], [DeviceLaunchOutcome.Refused, NativeRefusal.Unsupported]);
});

test("the store admits no package that holds a link, and keeps what it admitted before", { skip: !POSIX }, async () => {
  const staging = await tmpDir("device-launch-staging-");
  const store = phonePackageStore(path.join(staging, "phone-packages"));
  const app = path.join(staging, "Pond.app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "game"), "first");
  await store.admit("pond", BuildTarget.Ios, [DeviceKind.Simulator], app);
  const first = await store.digestOf("pond", BuildTarget.Ios, DeviceKind.Simulator);
  assert.match(first ?? "", /^[0-9a-f]{64}$/);
  await symlink("/etc/hosts", path.join(app, "hosts"));
  await assert.rejects(store.admit("pond", BuildTarget.Ios, [DeviceKind.Simulator], app));
  assert.equal(
    await store.digestOf("pond", BuildTarget.Ios, DeviceKind.Simulator),
    first,
    "the earlier admission stands",
  );
  // A receipt that is not the store's own answers nothing.
  await writeFile(path.join(phonePackageDir(store.root, "pond", BuildTarget.Ios), "admitted.json"), "{not json");
  assert.equal(await store.digestOf("pond", BuildTarget.Ios, DeviceKind.Simulator), null);
});

test("an emulator launch installs and starts the packaged APK through adb and records device_launch", {
  skip: !POSIX,
}, async () => {
  const bin = await tmpDir("device-launch-bin-");
  const log = path.join(bin, "calls.log");
  const adb = await standIn(bin, "adb", log, {
    devices: "List of devices attached\nemulator-5554\tdevice\nR58M123ABC\tdevice\n",
  });
  const tools: DeviceTools = { exec: execXcode, xcrun: async () => null, adb: async () => adb };
  const launch = await rig({ tools });
  const apk = await admittedBuild(launch, BuildTarget.Android, DeviceKind.Emulator);
  const result = answered(await launch.invoke(launchRequest(BuildTarget.Android, DeviceKind.Emulator)));
  assert.deepEqual(
    [result.outcome, result.deviceId, result.refusal],
    [DeviceLaunchOutcome.Launched, "emulator-5554", null],
  );
  assert.match(result.buildDigest ?? "", /^[0-9a-f]{64}$/);
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.equal(lines[0], "devices");
  assert.match(lines[1] ?? "", /^-s emulator-5554 install -r \S*genex-device-launch-[^/]+\/Game\.apk$/);
  assert.ok(!(lines[1] ?? "").endsWith(` ${apk}`), "a private copy, never the package's own path");
  assert.equal(lines[2], `-s emulator-5554 shell monkey -p '${BUNDLE_ID}' -c android.intent.category.LAUNCHER 1`);
  assert.deepEqual(onlyRecord(launch.recorded), { project: "pond", ...result });
});

test("which device: the only one there is, the one named, or a refusal; a failed install is recorded as failed", async () => {
  const two = fakeExec((_file, args) =>
    args.includes("list") ? { code: 0, stdout: simctlList([SIM_UDID, "11111111-2222-4333-8444-555555555555"]) } : null,
  );
  const several = await rig({ tools: two.tools });
  await admittedBuild(several, BuildTarget.Ios, DeviceKind.Simulator);
  const ambiguous = answered(await several.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator)));
  assert.deepEqual(
    [ambiguous.outcome, ambiguous.refusal],
    [DeviceLaunchOutcome.Refused, NativeRefusal.NotRunnableHere],
  );
  const unknown = answered(await several.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator, "NOT-BOOTED")));
  assert.deepEqual([unknown.outcome, unknown.refusal], [DeviceLaunchOutcome.Refused, NativeRefusal.NotRunnableHere]);
  const named = answered(await several.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator, SIM_UDID)));
  assert.deepEqual([named.outcome, named.deviceId], [DeviceLaunchOutcome.Launched, SIM_UDID]);
  // Only listing ran for the refusals: nothing was installed on a device the person did not pick.
  const installs = two.calls.filter((call) => call.includes("install"));
  assert.deepEqual(installs, [["xcrun", "simctl", "install", SIM_UDID, installs[0]?.[4] ?? ""]]);

  // A phone is never an emulator: adb's emulator serials are the emulator's alone.
  const phoneOnly = fakeExec((_file, args) =>
    args[0] === "devices"
      ? { code: 0, stdout: "List of devices attached\nR58M123ABC\tdevice\nemulator-5556\toffline\n" }
      : null,
  );
  const phones = await rig({ tools: phoneOnly.tools });
  await admittedBuild(phones, BuildTarget.Android, DeviceKind.Emulator);
  phones.admitted.set(
    admittedKey(BuildTarget.Android, DeviceKind.Phone),
    phones.admitted.get(admittedKey(BuildTarget.Android, DeviceKind.Emulator)) ?? "",
  );
  const noEmulator = answered(await phones.invoke(launchRequest(BuildTarget.Android, DeviceKind.Emulator)));
  assert.deepEqual(
    [noEmulator.outcome, noEmulator.refusal],
    [DeviceLaunchOutcome.Refused, NativeRefusal.NotRunnableHere],
  );
  const phone = answered(await phones.invoke(launchRequest(BuildTarget.Android, DeviceKind.Phone)));
  assert.deepEqual([phone.outcome, phone.deviceId], [DeviceLaunchOutcome.Launched, "R58M123ABC"]);

  const broken = fakeExec((_file, args) => (args.includes("install") ? { code: 1, stdout: "" } : null));
  const failing = await rig({ tools: broken.tools });
  await admittedBuild(failing, BuildTarget.Ios, DeviceKind.Simulator);
  const failed = answered(await failing.invoke(launchRequest(BuildTarget.Ios, DeviceKind.Simulator)));
  assert.deepEqual([failed.outcome, failed.deviceId, failed.refusal], [DeviceLaunchOutcome.Failed, SIM_UDID, null]);
  assert.match(failed.buildDigest ?? "", /^[0-9a-f]{64}$/);
  assert.ok(!broken.calls.some((call) => call.includes("launch")), "nothing started after a failed install");
  assert.equal(onlyRecord(failing.recorded).outcome, DeviceLaunchOutcome.Failed);
});
