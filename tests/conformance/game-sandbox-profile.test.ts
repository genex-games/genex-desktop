/**
 * The Seatbelt profiles a C++ · raylib game runs under on a Mac, and what they do to a real
 * process. The pure rows hold the generated text to the measured allow-lists on every platform:
 * deny by default, exec of the bundle's own executable only, no fork, writes only in `state/`,
 * reads only of the system and the bundle, no network, no way out of the process group, and
 * Apple's OpenGL unreadable. An embedded run (Live) is the headless box plus IOSurface and its one
 * frames service, which the host names and passes as the `FRAMES` parameter. The darwin rows start
 * `tests/cpp/sandbox_probe.c` through the real `ProcessSandbox.spawnGame` under each final profile
 * and ask it, over the protocol pipe, what it can reach.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it, type TestContext } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  NATIVE_FRAMES_SERVICE_PREFIX,
  NATIVE_STUDIO_AI_ON,
  NativeEnv,
  NativeError,
  NativeRefusal,
  NativeRunMode,
} from "../../src/shared/native-contract.ts";
import {
  GameProfileParam,
  type GameProfileValues,
  gameProfileDefines,
  gameSandboxProfile,
  prepareGameLaunch,
  SANDBOX_EXEC,
} from "../../src/substrate/game-sandbox-profile.ts";
import { type GameChild, ProcessSandbox } from "../../src/substrate/spawn.ts";
import {
  type DenyLogSource,
  MeasureError,
  MeasureRefusal,
  measureScenario,
  parseDenials,
  plainRun,
  pondHeadless,
  RuleVerdict,
  ruleFor,
  type Scenario,
  sandboxedRun,
  withoutAtom,
  withRules,
} from "../../scripts/spike/rust-wgpu/seatbelt-measure.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { buildProbe, macClang, macClangSkip, type ProbeRunDir, probePipe, probeRunDir } from "../helpers/macho.ts";
import { buildPond, HEADLESS_EXECUTABLE } from "../helpers/rust-pond-binary.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { metalRequired } from "../helpers/gpu-games.ts";

/**
 * The headless profile, rule for rule, as measured on macOS 26.6.2 (M4 Max). Flipped (M1.13):
 * `hw.pagesize_compat` joins it, approved as R1 (M0a.10 approval.md) for Rust std.
 */
const HEADLESS = [
  "(version 1)",
  '(deny default (with message (param "RUN_TAG")))',
  '(allow process-exec (literal (param "EXE")))',
  '(allow sysctl-read (sysctl-name "hw.ephemeral_storage") (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu") (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.perflevel0.logicalcpu") (sysctl-name "hw.perflevel1.logicalcpu") (sysctl-name "kern.bootargs") (sysctl-name "kern.iossupportversion") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.osvariant_status") (sysctl-name "security.mac.lockdown_mode_state") (sysctl-name "sysctl.proc_translated"))',
  '(allow file-read* (literal "/") (subpath "/System/Library") (subpath (param "BUNDLE")))',
  '(allow file-read* file-write* (subpath (param "STATE")))',
  '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient"))',
  '(allow mach-lookup (global-name "com.apple.MTLCompilerService") (global-name "com.apple.audio.AudioComponentRegistrar") (global-name "com.apple.audio.audiohald"))',
  '(deny file-read* (subpath "/System/Library/Extensions/AppleMetalOpenGLRenderer.bundle") (subpath "/System/Library/Frameworks/OpenGL.framework"))',
  "(deny syscall-unix (syscall-number 147 82))",
  "(deny network*)",
];

/**
 * The windowed profile: the headless rules plus what an AppKit window with a Metal layer needs.
 * Flipped (M1.13): `hw.pagesize_compat` (R2), `com.apple.CARenderServer` (R3) and
 * `com.apple.windowmanager.server` (R4) join it, approved in M0a.10 approval.md.
 */
const WINDOWED = [
  "(version 1)",
  '(deny default (with message (param "RUN_TAG")))',
  '(allow process-exec (literal (param "EXE")))',
  '(allow sysctl-read (sysctl-name "hw.ephemeral_storage") (sysctl-name "hw.logicalcpu_max") (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu") (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.perflevel0.logicalcpu") (sysctl-name "hw.perflevel1.logicalcpu") (sysctl-name "hw.physicalcpu_max") (sysctl-name "kern.bootargs") (sysctl-name "kern.hv_vmm_present") (sysctl-name "kern.iossupportversion") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.willshutdown") (sysctl-name "security.mac.lockdown_mode_state") (sysctl-name "sysctl.proc_translated"))',
  '(allow file-read* (literal "/") (subpath "/System/Library") (subpath (param "BUNDLE")) (literal "/usr/lib/libobjc-trampolines.dylib"))',
  '(allow file-read* file-write* (subpath (param "STATE")))',
  '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient") (iokit-user-client-class "IOSurfaceRootUserClient"))',
  '(allow mach-lookup (global-name "com.apple.MTLCompilerService") (global-name "com.apple.audio.AudioComponentRegistrar") (global-name "com.apple.audio.audiohald") (global-name "com.apple.windowserver.active") (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.CARenderServer") (global-name "com.apple.windowmanager.server"))',
  '(deny file-read* (subpath "/System/Library/Extensions/AppleMetalOpenGLRenderer.bundle") (subpath "/System/Library/Frameworks/OpenGL.framework"))',
  "(deny syscall-unix (syscall-number 147 82))",
  "(deny network*)",
];

/**
 * The embedded profile (Live): the headless rules plus the IOSurface user client the frames ring is
 * made with, and exactly one more Mach service, the run's own frames service, named by the `FRAMES`
 * parameter (the spike's `genex-game-headless-frames.sb`).
 */
const EMBEDDED = HEADLESS.map((rule) => {
  if (rule.startsWith("(allow iokit-open"))
    return '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient") (iokit-user-client-class "IOSurfaceRootUserClient"))';
  if (rule.startsWith("(allow mach-lookup")) return rule.replace(/\)$/, ' (global-name (param "FRAMES")))');
  return rule;
});

const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith(";"));
const allows = (text: string) => lines(text).filter((line) => line.startsWith("(allow"));

/** Every literal path an allow rule names (parameters are the run's own folders). */
function allowedPaths(text: string): string[] {
  return allows(text).flatMap((line) =>
    [...line.matchAll(/\((?:literal|subpath) "([^"]*)"\)/g)].map((m) => m[1] ?? ""),
  );
}

/** Every Mach service an allow rule names. */
function allowedServices(text: string): string[] {
  return allows(text).flatMap((line) => [...line.matchAll(/\(global-name "([^"]*)"\)/g)].map((m) => m[1] ?? ""));
}

const headless = () => gameSandboxProfile({ mode: NativeRunMode.Headless });
const windowed = () => gameSandboxProfile({ mode: NativeRunMode.Window });
const embedded = () => gameSandboxProfile({ mode: NativeRunMode.Embedded });

describe("the game profiles' text", () => {
  it("is the measured headless allow-list, rule for rule", () => {
    assert.deepEqual(lines(headless()), HEADLESS);
  });

  it("is the measured windowed allow-list, rule for rule", () => {
    assert.deepEqual(lines(windowed()), WINDOWED);
  });

  for (const [name, text] of [
    ["headless", headless],
    ["windowed", windowed],
    ["embedded", embedded],
  ] as const) {
    it(`${name}: denies by default with the run's tag, starts only the literal EXE and never forks`, () => {
      const rules = lines(text());
      assert.equal(rules[1], '(deny default (with message (param "RUN_TAG")))');
      const execs = rules.filter((line) => line.includes("process-exec"));
      assert.deepEqual(execs, ['(allow process-exec (literal (param "EXE")))']);
      assert.ok(!rules.some((line) => line.includes("process-fork")), "no process-fork allow");
      assert.ok(!rules.some((line) => line.includes("(allow default")), "nothing allowed wholesale");
    });

    it(`${name}: writes only STATE`, () => {
      const writes = allows(text()).filter((line) => line.includes("file-write"));
      assert.deepEqual(writes, ['(allow file-read* file-write* (subpath (param "STATE")))']);
    });

    it(`${name}: reads no /usr/local, home, game folder, scratch, store or /tmp`, () => {
      const paths = allowedPaths(text());
      const expected =
        name === "windowed" ? ["/", "/System/Library", "/usr/lib/libobjc-trampolines.dylib"] : ["/", "/System/Library"];
      assert.deepEqual(paths, expected);
      for (const denied of ["/usr/local", os.homedir(), "/tmp", "/private/tmp", "/var", "/Users", "/Library"]) {
        assert.ok(!paths.some((allowed) => allowed !== "/" && `${denied}/`.startsWith(`${allowed}/`)), denied);
      }
    });

    it(`${name}: Apple's OpenGL is unreadable, after every allow; setsid/setpgid and the network are denied`, () => {
      const rules = lines(text());
      const openGl = rules.findIndex((line) => line.includes("OpenGL.framework"));
      assert.ok(openGl > 0, "the OpenGL file deny is there");
      assert.match(rules[openGl] ?? "", /^\(deny file-read\* /);
      assert.match(rules[openGl] ?? "", /AppleMetalOpenGLRenderer\.bundle/);
      const lastAllow = rules.map((line) => line.startsWith("(allow")).lastIndexOf(true);
      assert.ok(openGl > lastAllow, "no allow comes after the OpenGL deny");
      assert.ok(rules.includes("(deny syscall-unix (syscall-number 147 82))"));
      assert.ok(rules.includes("(deny network*)"));
      assert.ok(!rules.some((line) => line.startsWith("(allow network")));
    });

    it(`${name}: reaches no pasteboard, screen capture, app launching, AppleEvents, cvmsServ or tsm`, () => {
      const services = allowedServices(text());
      for (const refused of [
        "com.apple.pasteboard.1",
        "com.apple.ScreenCapture",
        "com.apple.lsd.open",
        "com.apple.coreservices.appleevents",
        "com.apple.cvmsServ",
        "com.apple.tsm.uiserver",
        "com.apple.dock.server",
      ]) {
        assert.ok(!services.includes(refused), refused);
      }
      assert.ok(!lines(text()).some((line) => line.includes("appleevent")), "no AppleEvent rule");
    });
  }

  it("headless reaches no WindowServer, LaunchServices, IOSurface or objc trampolines; windowed adds exactly those", () => {
    const extras = [
      "com.apple.windowserver.active",
      "com.apple.coreservices.launchservicesd",
      "com.apple.CARenderServer",
      "com.apple.windowmanager.server",
    ];
    assert.deepEqual(
      allowedServices(windowed()).filter((service) => !allowedServices(headless()).includes(service)),
      extras,
    );
    for (const extra of [...extras, "IOSurfaceRootUserClient", "libobjc-trampolines"]) {
      assert.ok(!headless().includes(extra), `headless: ${extra}`);
      assert.ok(windowed().includes(extra), `windowed: ${extra}`);
    }
  });

  it("refuses a mode it has no profile for", () => {
    assert.throws(
      () => gameSandboxProfile({ mode: "fullscreen" as NativeRunMode }),
      (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.Unsupported,
    );
  });
});

describe("the embedded profile's text", () => {
  it("is the measured embedded allow-list, rule for rule", () => {
    assert.deepEqual(lines(embedded()), EMBEDDED);
  });

  it("the embedded profile has no WindowServer and exactly one extra mach-lookup, the FRAMES parameter, plus IOSurfaceRootUserClient", () => {
    const text = embedded();
    assert.deepEqual(allowedServices(text), allowedServices(headless()), "no named service beyond the headless ones");
    const lookups = allows(text).filter((line) => line.startsWith("(allow mach-lookup"));
    assert.equal(lookups.length, 1);
    assert.equal([...(lookups[0] ?? "").matchAll(/\(global-name \(param "([^"]*)"\)\)/g)].length, 1);
    assert.match(lookups[0] ?? "", /\(global-name \(param "FRAMES"\)\)\)$/);
    for (const absent of [
      "com.apple.windowserver.active",
      "com.apple.coreservices.launchservicesd",
      "com.apple.CARenderServer",
      "com.apple.windowmanager.server",
      "libobjc-trampolines",
    ])
      assert.ok(!text.includes(absent), absent);
    assert.ok(text.includes('(iokit-user-client-class "IOSurfaceRootUserClient")'));
    assert.ok(!headless().includes('(param "FRAMES")') && !windowed().includes('(param "FRAMES")'));
  });
});

describe("the game profile's -D parameters", () => {
  const runDir = "/runs/0123456789abcdef";
  const good: GameProfileValues = {
    [GameProfileParam.RunTag]: "genex-game-0123456789abcdef",
    [GameProfileParam.Exe]: `${runDir}/bundle/Game.app/Contents/MacOS/game`,
    [GameProfileParam.Bundle]: `${runDir}/bundle`,
    [GameProfileParam.State]: `${runDir}/state`,
  };

  it("are -D NAME=value pairs in a fixed order", () => {
    assert.deepEqual(gameProfileDefines(good, runDir), [
      "-D",
      `RUN_TAG=${good.RUN_TAG}`,
      "-D",
      `EXE=${good.EXE}`,
      "-D",
      `BUNDLE=${good.BUNDLE}`,
      "-D",
      `STATE=${good.STATE}`,
    ]);
  });

  const hostile: Array<[string, Partial<GameProfileValues>]> = [
    ["a quote in a path", { [GameProfileParam.State]: `${runDir}/sta"te` }],
    ["a newline in a path", { [GameProfileParam.Exe]: `${runDir}/bundle/game\n(allow default)` }],
    ["a NUL in a path", { [GameProfileParam.Bundle]: `${runDir}/bundle\0` }],
    ["a relative path", { [GameProfileParam.State]: "state" }],
    ["a path outside the run dir", { [GameProfileParam.State]: "/Users/someone" }],
    ["the run dir itself", { [GameProfileParam.Bundle]: runDir }],
    ["a path climbing out", { [GameProfileParam.Exe]: `${runDir}/bundle/../../other/game` }],
    ["a sibling run dir sharing the prefix", { [GameProfileParam.State]: `${runDir}0/state` }],
    ["an exe outside the bundle", { [GameProfileParam.Exe]: `${runDir}/state/game` }],
    [
      "a bundle that is not the run dir's bundle folder",
      {
        [GameProfileParam.Bundle]: `${runDir}/other`,
        [GameProfileParam.Exe]: `${runDir}/other/Game.app/Contents/MacOS/game`,
      },
    ],
    ["a state that is not the run dir's state folder", { [GameProfileParam.State]: `${runDir}/state/deeper` }],
    ["a state inside the bundle", { [GameProfileParam.State]: `${runDir}/bundle/state` }],
    ["a run tag with a quote", { [GameProfileParam.RunTag]: 'tag"' }],
    ["an empty run tag", { [GameProfileParam.RunTag]: "" }],
  ];
  for (const [name, patch] of hostile) {
    it(`refuses ${name}`, () => {
      assert.throws(
        () => gameProfileDefines({ ...good, ...patch }, runDir),
        (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.Unsupported,
      );
    });
  }

  it("without a run dir, take the bundle's parent only for a bundle folder with its state beside it", () => {
    assert.deepEqual(gameProfileDefines(good), gameProfileDefines(good, runDir));
    const elsewhere: GameProfileValues = {
      [GameProfileParam.RunTag]: "genex-game-0123456789abcdef",
      [GameProfileParam.Exe]: "/Users/me/x/game",
      [GameProfileParam.Bundle]: "/Users/me/x",
      [GameProfileParam.State]: "/Users/me/y",
    };
    const besideBundle = { ...good, [GameProfileParam.State]: "/runs/state" };
    for (const values of [elsewhere, besideBundle]) {
      assert.throws(
        () => gameProfileDefines(values),
        (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.Unsupported,
        JSON.stringify(values),
      );
    }
  });
});

/** The frames service a run may look up: the prefix and the run's own id. */
const framesOf = (runId: string) => `${NATIVE_FRAMES_SERVICE_PREFIX}${runId}`;
/** Another run's id, for a service name that is not this run's. */
const OTHER_RUN = "fedcba9876543210";

/** FRAMES values and modes a game profile must refuse, for a run whose id is `runId`. */
function hostileFrames(runId: string): Array<{ name: string; mode: NativeRunMode; frames: string | undefined }> {
  return [
    { name: "another run's frames service", mode: NativeRunMode.Embedded, frames: framesOf(OTHER_RUN) },
    { name: "the prefix alone", mode: NativeRunMode.Embedded, frames: NATIVE_FRAMES_SERVICE_PREFIX },
    { name: "a quote", mode: NativeRunMode.Embedded, frames: `${framesOf(runId)}"` },
    { name: "a newline", mode: NativeRunMode.Embedded, frames: `${framesOf(runId)}\n(allow default)` },
    {
      name: "200 characters",
      mode: NativeRunMode.Embedded,
      frames: `${NATIVE_FRAMES_SERVICE_PREFIX}${"a".repeat(200 - NATIVE_FRAMES_SERVICE_PREFIX.length)}`,
    },
    { name: "FRAMES on a window run", mode: NativeRunMode.Window, frames: framesOf(runId) },
    { name: "FRAMES on a headless run", mode: NativeRunMode.Headless, frames: framesOf(runId) },
    { name: "an empty FRAMES on a window run", mode: NativeRunMode.Window, frames: "" },
    { name: "no FRAMES on an embedded run", mode: NativeRunMode.Embedded, frames: undefined },
  ];
}

const refusedUnsupported = (error: unknown) =>
  error instanceof NativeError && error.refusal === NativeRefusal.Unsupported;

describe("an embedded run's FRAMES parameter", () => {
  const runId = "0123456789abcdef";
  const runDir = `/runs/${runId}`;
  const good: GameProfileValues = {
    [GameProfileParam.RunTag]: `genex-game-${runId}`,
    [GameProfileParam.Exe]: `${runDir}/bundle/Game.app/Contents/MacOS/game`,
    [GameProfileParam.Bundle]: `${runDir}/bundle`,
    [GameProfileParam.State]: `${runDir}/state`,
  };

  it("is passed last as -D FRAMES=<the run's own frames service>, never spliced into the text", () => {
    const frames = framesOf(runId);
    assert.deepEqual(
      gameProfileDefines({ ...good, [GameProfileParam.Frames]: frames }, runDir, NativeRunMode.Embedded),
      [...gameProfileDefines(good, runDir), "-D", `FRAMES=${frames}`],
    );
    assert.ok(!embedded().includes(runId) && !embedded().includes(NATIVE_FRAMES_SERVICE_PREFIX));
  });

  for (const row of hostileFrames(runId)) {
    it(`refuses ${row.name}`, () => {
      const values = row.frames === undefined ? good : { ...good, [GameProfileParam.Frames]: row.frames };
      assert.throws(() => gameProfileDefines(values, runDir, row.mode), refusedUnsupported);
    });
  }
});

/**
 * `spawnGame` with a frames service: only an embedded run names one, and only its own. A refused
 * request writes no profile, makes no HOME and starts nothing (the stand-in would leave a marker).
 */
describe("ProcessSandbox.spawnGame and the frames service", {
  skip: process.platform === "win32" && "POSIX paths",
}, () => {
  async function gameBox() {
    const base = await tmpDir("game-frames-box-");
    const runs = path.join(base, "native-runs");
    await mkdir(runs, { mode: 0o700 });
    const box = await ProcessSandbox.create({
      writableRoots: [],
      scratchDir: path.join(base, "scratch"),
      secretPaths: [],
      enabled: false,
      platform: StudioPlatform.Mac,
      nativeRunsRoot: runs,
    });
    after(() => box.dispose());
    return { base, runs, box };
  }

  async function standIn(runs: string, runId = "0123456789abcdef") {
    const runDir = path.join(runs, runId);
    const bundle = path.join(runDir, "bundle");
    const exe = path.join(bundle, "Game.app", "Contents", "MacOS", "game");
    const state = path.join(runDir, "state");
    await mkdir(path.dirname(exe), { recursive: true });
    await mkdir(state);
    await writeFile(exe, '#!/bin/sh\ntouch "$GENEX_STATE_DIR/started"\n', { mode: 0o755 });
    return { runId, runDir, bundle, exe, state, nonce: "a1b2c3d4" };
  }

  /** Every entry under `dir` with a file's bytes and a link's target: what a refusal leaves as it was. */
  async function tree(dir: string): Promise<string[]> {
    const listed: string[] = [];
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath, entry.name);
      const info = await lstat(full);
      let what = "/";
      if (info.isSymbolicLink()) what = `-> ${await readlink(full)}`;
      else if (info.isFile()) what = await readFile(full, "utf8");
      listed.push(`${path.relative(dir, full)} ${what}`);
    }
    return listed.sort();
  }

  for (const row of hostileFrames("0123456789abcdef")) {
    it(`refuses ${row.name}, writing and starting nothing`, async () => {
      const { base, runs, box } = await gameBox();
      const good = await standIn(runs);
      const request = { ...good, mode: row.mode, ...(row.frames === undefined ? {} : { frames: row.frames }) };
      const before = await tree(base);
      await assert.rejects(box.spawnGame(request), refusedUnsupported);
      assert.deepEqual(await tree(base), before);
    });
  }

  it("an embedded launch gets the profile, -D FRAMES and GENEX_FRAMES_SERVICE; a window launch gets neither", async () => {
    const { runs } = await gameBox();
    const run = await standIn(runs);
    const frames = framesOf(run.runId);
    const launch = await prepareGameLaunch({ ...run, mode: NativeRunMode.Embedded, frames }, runs);
    assert.deepEqual(launch.args.slice(-5), [
      "-D",
      `FRAMES=${frames}`,
      "-f",
      path.join(await realpath(run.runDir), "profile.sb"),
      await realpath(run.exe),
    ]);
    assert.equal(launch.env[NativeEnv.FramesService], frames);
    assert.equal(await readFile(path.join(run.runDir, "profile.sb"), "utf8"), embedded());
    const windowRun = await standIn(runs, "00112233445566778899");
    const windowLaunch = await prepareGameLaunch({ ...windowRun, mode: NativeRunMode.Window }, runs);
    assert.ok(!(NativeEnv.FramesService in windowLaunch.env), "no frames service outside an embedded run");
    assert.ok(!windowLaunch.args.some((arg) => arg.startsWith("FRAMES=")));
  });

  it("a launch gets GENEX_STUDIO_AI=1 only for a run whose play-time AI the studio answers", async () => {
    const { runs } = await gameBox();
    const run = await standIn(runs);
    const answered = await prepareGameLaunch({ ...run, mode: NativeRunMode.Headless, ai: true }, runs);
    assert.equal(answered.env[NativeEnv.StudioAi], NATIVE_STUDIO_AI_ON);
    const otherRun = await standIn(runs, "00112233445566778899");
    const plain = await prepareGameLaunch({ ...otherRun, mode: NativeRunMode.Headless }, runs);
    assert.ok(!(NativeEnv.StudioAi in plain.env), "no AI variable for a run nobody answers");
  });
});

/**
 * The final profiles on this Mac, through the real `spawnGame`. Each row starts the probe in a
 * fresh run directory under the profile for its mode and asks it what it can reach.
 */
describe("a game under the final profiles (darwin)", { skip: macClangSkip() }, () => {
  let probe: string;
  let base: string;
  let runs: string;
  let sandbox: ProcessSandbox;
  /** Files beside the run that a game must never read: the game folder, scratch and the store. */
  let siblings: string[];

  before(async () => {
    // Real paths: a game is handed real ones (GENEX_STATE_DIR), and a link on the way (`/var`)
    // would be refused by the profile for its own sake, proving nothing about the rule asked.
    base = await realpath(await tmpDir("game-profile-"));
    runs = path.join(base, "native-runs");
    await mkdir(runs, { mode: 0o700 });
    probe = await buildProbe(base);
    siblings = [];
    for (const [folder, file] of [
      ["games/pong", "studio.json"],
      ["scratch", "build.log"],
      ["toolchains", "current-lock.json"],
      ["personal", ".zshrc"],
    ] as const) {
      await mkdir(path.join(base, folder), { recursive: true });
      await writeFile(path.join(base, folder, file), "{}");
      siblings.push(path.join(base, folder, file));
    }
    sandbox = await ProcessSandbox.create({
      writableRoots: [],
      scratchDir: path.join(base, "agent-scratch"),
      secretPaths: [],
      enabled: false,
      nativeRunsRoot: runs,
    });
  });
  after(() => sandbox.dispose());

  async function start(
    mode: NativeRunMode,
  ): Promise<{ child: GameChild; run: ProbeRunDir; ask: (c: string) => Promise<Record<string, unknown>> }> {
    const run = await probeRunDir(runs, probe);
    const frames = mode === NativeRunMode.Embedded ? { frames: framesOf(run.runId) } : {};
    const child = await sandbox.spawnGame({ ...run, mode, nonce: "a1b2c3d4", ...frames });
    const pipe = probePipe(child.fd3);
    return { child, run, ask: (command) => pipe.ask(command) };
  }

  async function quit(child: GameChild, ask: (c: string) => Promise<unknown>): Promise<void> {
    void ask("exit 0").catch(() => {});
    const exited = await child.exited;
    assert.deepEqual(exited, { code: 0, signal: null });
  }

  const EPERM = 1;

  /**
   * Whether this host has the AGX driver the measured game profile allows and a usable Metal
   * device. A virtual GPU can work plainly but needs another, unmeasured IOKit client: those
   * rows are reported and skipped. A physical Apple Silicon Mac runs them, and
   * GENEX_REQUIRE_TOOLCHAINS=1 or GENEX_REQUIRE_METAL=1 makes a missing device a failure.
   */
  let hostMetal: Promise<boolean> | null = null;
  const METAL_REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1" || metalRequired();
  async function metalOrSkip(t: TestContext): Promise<boolean> {
    hostMetal ??= Promise.all([
      askUnled("metal", null),
      promisify(execFile)("/usr/sbin/ioreg", ["-r", "-c", "AGXAccelerator", "-d", "1"]),
    ]).then(([answer, registry]) => {
      const agx = registry.stdout.includes("<class AGXAccelerator");
      t.diagnostic(`plain Metal: ${JSON.stringify(answer)}; measured AGX driver: ${agx}`);
      return agx && answer.device === true && answer.msl === true;
    });
    if (await hostMetal) return true;
    assert.ok(!METAL_REQUIRED, "this host lacks usable Metal with the measured AGX driver, and Metal is required here");
    t.skip("not run: no usable Metal with the measured AGX driver; virtual-GPU profiles are unaccepted");
    return false;
  }

  it("headless: fd 3 echoes, state is writable, and nothing outside it is", { timeout: 60_000 }, async () => {
    const { child, run, ask } = await start(NativeRunMode.Headless);
    assert.deepEqual(await ask("echo hello over fd 3"), { echo: "hello over fd 3" });
    assert.deepEqual(await ask(`write ${path.join(run.state, "save.dat")}`), { write: 0 });
    assert.deepEqual(await ask(`read ${run.exe}`), { read: 0 }, "the bundle is readable");
    for (const outside of [
      path.join(run.runDir, "escape.txt"),
      path.join(run.bundle, "escape.txt"),
      path.join(await realpath(os.tmpdir()), "genex-game-escape.txt"),
      path.join(base, "games", "pong", "escape.txt"),
    ]) {
      assert.deepEqual(await ask(`write ${outside}`), { write: EPERM }, outside);
    }
    await quit(child, ask);
    assert.deepEqual(await readdir(run.state), ["home", "save.dat"]);
  });

  it("headless: the game folder, scratch and the store are unreadable", { timeout: 60_000 }, async () => {
    const { child, ask } = await start(NativeRunMode.Headless);
    for (const sibling of siblings) assert.deepEqual(await ask(`read ${sibling}`), { read: EPERM }, sibling);
    await quit(child, ask);
  });

  it("headless: no UDP connect, no fork", { timeout: 60_000 }, async () => {
    const { child, ask } = await start(NativeRunMode.Headless);
    assert.deepEqual(await ask("udp"), { udp: EPERM });
    assert.deepEqual(await ask("fork"), { fork: EPERM });
    await quit(child, ask);
  });

  // C1, characterization: M0b.2 measured the game box already refusing all of this (agent
  // commands were the open side). A connect is refused by the profile whether or not anything
  // listens, so no stand-in is needed.
  for (const mode of [NativeRunMode.Headless, NativeRunMode.Window])
    it(`${mode}: no adb server or emulator port on loopback, and no adb key home (C1)`, {
      timeout: 60_000,
    }, async () => {
      const { child, ask } = await start(mode);
      for (const port of [5037, 5554, 5555, 5585])
        assert.deepEqual(await ask(`tcp ${port}`), { tcp: EPERM }, `${port}`);
      for (const home of [path.join(os.homedir(), ".android"), path.join(os.homedir(), ".android", "adbkey")]) {
        const answer = await ask(`read ${home}`);
        if (existsSync(home)) assert.deepEqual(answer, { read: EPERM }, home);
        else assert.notEqual(answer.read, 0, home);
      }
      await quit(child, ask);
    });

  /**
   * One probe command answered by a probe started without `detached`: plainly, or under `profile`
   * through `sandbox-exec`. `spawnGame`'s child leads its own session, where setsid and setpgid fail
   * by POSIX rule whatever a profile says, so the syscall rule is proved on a child that is not a
   * leader: there both succeed unless a rule denies them.
   */
  async function askUnled(command: string, profile: string | null): Promise<Record<string, unknown>> {
    const run = await probeRunDir(runs, probe);
    const exe = await realpath(run.exe);
    let file = exe;
    let args: string[] = [];
    if (profile !== null) {
      const at = path.join(run.runDir, "profile.sb");
      await writeFile(at, profile, { mode: 0o600 });
      const values: GameProfileValues = {
        [GameProfileParam.RunTag]: `genex-game-${run.runId}`,
        [GameProfileParam.Exe]: exe,
        [GameProfileParam.Bundle]: await realpath(run.bundle),
        [GameProfileParam.State]: await realpath(run.state),
      };
      file = SANDBOX_EXEC;
      args = [...gameProfileDefines(values, await realpath(run.runDir)), "-f", at, exe];
    }
    const child = spawn(file, args, {
      cwd: run.state,
      env: { [NativeEnv.StudioFd]: "3" },
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    const pipe = child.stdio[3];
    assert.ok(pipe && "write" in pipe, "fd 3 is a pipe");
    const { ask } = probePipe(pipe as Parameters<typeof probePipe>[0]);
    const answer = await ask(command);
    void ask("exit 0").catch(() => {});
    await exited;
    return answer;
  }

  /** The headless profile without its `syscall-unix` rule: what proves that rule, not `deny default`, refuses them. */
  const withoutSyscallRule = (mode: NativeRunMode) =>
    gameSandboxProfile({ mode })
      .split("\n")
      .filter((line) => !line.startsWith("(deny syscall-unix"))
      .join("\n");

  it("setsid and setpgid succeed for a child that leads nothing, plainly and under the profile without its syscall rule", {
    timeout: 60_000,
  }, async () => {
    for (const profile of [null, withoutSyscallRule(NativeRunMode.Headless)]) {
      const where = profile === null ? "plain" : "profile without the rule";
      assert.deepEqual(await askUnled("setsid", profile), { setsid: 0 }, where);
      assert.deepEqual(await askUnled("setpgid", profile), { setpgid: 0 }, where);
    }
  });

  it("the final profiles refuse setsid and setpgid to a child that leads nothing", { timeout: 60_000 }, async () => {
    for (const mode of [NativeRunMode.Headless, NativeRunMode.Window]) {
      const profile = gameSandboxProfile({ mode });
      assert.deepEqual(await askUnled("setsid", profile), { setsid: EPERM }, mode);
      assert.deepEqual(await askUnled("setpgid", profile), { setpgid: EPERM }, mode);
    }
  });

  it("headless: Metal compiles a shader, Apple's OpenGL does not", { timeout: 60_000 }, async (t) => {
    if (!(await metalOrSkip(t))) return;
    const { child, ask } = await start(NativeRunMode.Headless);
    assert.deepEqual(await ask("metal"), { device: true, msl: true });
    assert.deepEqual(await ask("cgl"), { cgl: false });
    await quit(child, ask);
  });

  it("windowed: Metal still compiles and OpenGL still does not", { timeout: 60_000 }, async (t) => {
    if (!(await metalOrSkip(t))) return;
    const { child, ask } = await start(NativeRunMode.Window);
    assert.deepEqual(await ask("metal"), { device: true, msl: true });
    assert.deepEqual(await ask("cgl"), { cgl: false });
    assert.deepEqual(await ask("udp"), { udp: EPERM });
    await quit(child, ask);
  });

  it("the WindowServer is out of reach headless and in reach windowed; the refused services stay refused", {
    timeout: 60_000,
  }, async () => {
    const windowServer = "lookup com.apple.windowserver.active";
    const headlessRun = await start(NativeRunMode.Headless);
    assert.notEqual((await headlessRun.ask(windowServer)).lookup, 0);
    const windowRun = await start(NativeRunMode.Window);
    assert.equal((await windowRun.ask(windowServer)).lookup, 0);
    for (const refused of [
      "com.apple.pasteboard.1",
      "com.apple.lsd.open",
      "com.apple.cvmsServ",
      "com.apple.dock.server",
    ]) {
      for (const run of [headlessRun, windowRun])
        assert.notEqual((await run.ask(`lookup ${refused}`)).lookup, 0, refused);
    }
    await quit(headlessRun.child, headlessRun.ask);
    await quit(windowRun.child, windowRun.ask);
  });

  /**
   * The approved Rust rules (M1.13, approval.md R1-R4) reach exactly their names: Core Animation's
   * render server and WindowManager only from the windowed profile; every service and path the
   * measurement saw and left denied stays denied in both.
   */
  it("R3 and R4 reach only their own services, windowed only; what the measurement left denied stays denied", {
    timeout: 60_000,
  }, async () => {
    const headlessRun = await start(NativeRunMode.Headless);
    const windowRun = await start(NativeRunMode.Window);
    for (const approved of ["com.apple.CARenderServer", "com.apple.windowmanager.server"]) {
      assert.notEqual((await headlessRun.ask(`lookup ${approved}`)).lookup, 0, `headless: ${approved}`);
      assert.equal((await windowRun.ask(`lookup ${approved}`)).lookup, 0, `windowed: ${approved}`);
    }
    for (const unapproved of [
      "com.apple.system.opendirectoryd.libinfo",
      "com.apple.system.notification_center",
      "com.apple.analyticsd",
      "com.apple.diagnosticd",
    ]) {
      for (const run of [headlessRun, windowRun])
        assert.notEqual((await run.ask(`lookup ${unapproved}`)).lookup, 0, unapproved);
    }
    for (const path of ["/Library/Preferences/.GlobalPreferences.plist", "/etc/hosts"]) {
      for (const run of [headlessRun, windowRun])
        assert.deepEqual(await run.ask(`read ${path}`), { read: EPERM }, path);
    }
    await quit(headlessRun.child, headlessRun.ask);
    await quit(windowRun.child, windowRun.ask);
  });

  /**
   * An embedded run reaches no WindowServer. Its own frames service is a name the profile lets it
   * look up (nobody checked it in here, so launchd answers 1102, unknown); another run's is refused
   * by the profile (1100, not privileged), whether or not it exists.
   */
  it("embedded: Metal, no WindowServer, its own frames name allowed and another run's refused", {
    timeout: 60_000,
  }, async (t) => {
    if (!(await metalOrSkip(t))) return;
    const BOOTSTRAP_NOT_PRIVILEGED = 1100;
    const BOOTSTRAP_UNKNOWN_SERVICE = 1102;
    const { child, run, ask } = await start(NativeRunMode.Embedded);
    assert.deepEqual(await ask("metal"), { device: true, msl: true });
    assert.deepEqual(await ask("cgl"), { cgl: false });
    assert.notEqual((await ask("lookup com.apple.windowserver.active")).lookup, 0);
    assert.equal((await ask(`lookup ${framesOf(run.runId)}`)).lookup, BOOTSTRAP_UNKNOWN_SERVICE);
    assert.equal((await ask(`lookup ${framesOf(OTHER_RUN)}`)).lookup, BOOTSTRAP_NOT_PRIVILEGED);
    await quit(child, ask);
  });

  /**
   * IME (`com.apple.tsm.uiserver`) and gamepads (IOHID) are not in the measured text. They are
   * probed and reported; the profile adds neither unless a row here shows one needed.
   */
  it("IME and gamepads are probed and reported: both stay out of the final profiles", {
    timeout: 60_000,
  }, async (t) => {
    for (const mode of [NativeRunMode.Headless, NativeRunMode.Window]) {
      const { child, ask } = await start(mode);
      const tsm = await ask("lookup com.apple.tsm.uiserver");
      const hid = await ask("hid");
      t.diagnostic(`${mode}: tsm.uiserver lookup ${String(tsm.lookup)}; IOHIDManagerOpen ${JSON.stringify(hid)}`);
      assert.notEqual(tsm.lookup, 0, `${mode}: the IME server stays out of reach`);
      await quit(child, ask);
    }
  });
});

/**
 * M0a.10a: the Seatbelt measurement of the Rust pond. The pure rows hold the measurement script's
 * reading of the deny log and the rules it may propose; the darwin rows record (not fix) that the
 * pond's headless self-test does not run under the v1 headless profile, and that a measurement
 * whose deny log is empty refuses typed instead of proposing nothing. M1.13 flips the recorded
 * row when it adds the rules the owner approved at M0a.10.
 */
describe("the Seatbelt measurement's reading of a deny log (M0a.10a)", () => {
  const PID = 4242;
  const TAG = "genex-game-0123456789abcdef";

  it("keeps the run's own reports, by pid or by its tag, once each, in order", () => {
    const messages = [
      `Sandbox: game(${PID}) deny(1) sysctl-read hw.pagesize_compat\n${TAG}`,
      "Sandbox: other(7) deny(1) mach-lookup com.apple.logd\nsomeone-else",
      `3 duplicate reports for Sandbox: game(${PID}) deny(1) sysctl-read hw.pagesize_compat`,
      `Sandbox: sandbox-exec(99) deny(1) file-read-metadata /Library/Application Support/x y\n${TAG}`,
      `Sandbox: game(${PID}) deny(1) mach-lookup com.apple.system.opendirectoryd.libinfo`,
      "not a sandbox report",
    ];
    assert.deepEqual(parseDenials(messages, PID, TAG), [
      { operation: "sysctl-read", target: "hw.pagesize_compat" },
      { operation: "file-read-metadata", target: "/Library/Application Support/x y" },
      { operation: "mach-lookup", target: "com.apple.system.opendirectoryd.libinfo" },
    ]);
  });

  it("proposes the narrowest rule for one named thing", () => {
    const rows = [
      [
        { operation: "sysctl-read", target: "hw.pagesize_compat" },
        '(allow sysctl-read (sysctl-name "hw.pagesize_compat"))',
      ],
      [{ operation: "mach-lookup", target: "com.apple.logd" }, '(allow mach-lookup (global-name "com.apple.logd"))'],
      [
        { operation: "file-read-data", target: '/System/Library/a "b"' },
        '(allow file-read-data (literal "/System/Library/a \\"b\\""))',
      ],
      [
        { operation: "iokit-open", target: "AGXDeviceUserClient" },
        '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient"))',
      ],
    ] as const;
    for (const [denial, rule] of rows)
      assert.deepEqual(ruleFor(denial), { verdict: RuleVerdict.Proposable, rule, denial });
  });

  it("never proposes what the game profile refuses by design, and nothing it cannot narrow", () => {
    const refused = [
      { operation: "network-outbound", target: "/private/var/run/mDNSResponder" },
      { operation: "process-exec*", target: "/bin/sh" },
      { operation: "process-fork", target: "" },
      { operation: "file-write-create", target: "/Users/someone/.zshrc" },
      { operation: "file-read-data", target: "/System/Library/Frameworks/OpenGL.framework/OpenGL" },
      { operation: "mach-lookup", target: "com.apple.pasteboard.1" },
      { operation: "file-read-data", target: path.join(os.homedir(), ".ssh", "id_ed25519") },
      { operation: "file-read-data", target: path.join(os.homedir(), "Library", "Keychains", "login.keychain-db") },
      { operation: "file-read-metadata", target: path.join(os.homedir(), "Library", "Safari", "History.db") },
      { operation: "file-read-data", target: "/private/var/db/TCC/TCC.db" },
      { operation: "file-read-data", target: "/Systemish/Library/x" },
      { operation: "mach-lookup", target: "com.apple.SecurityServer" },
      { operation: "mach-lookup", target: "com.apple.securityd.xpc" },
      { operation: "mach-lookup", target: "com.apple.tccd" },
      { operation: "mach-lookup", target: "com.apple.tccd.system" },
      { operation: "mach-lookup", target: "com.apple.trustd.agent" },
      { operation: "iokit-open", target: "IOHIDLibUserClient" },
      { operation: "iokit-open-user-client", target: "IOHIDParamUserClient" },
      { operation: "iokit-open", target: "AppleKeyStoreUserClient" },
    ];
    for (const denial of refused) assert.equal(ruleFor(denial).verdict, RuleVerdict.RefusedByPolicy, denial.operation);
    for (const denial of [
      { operation: "signal", target: "" },
      { operation: "sysctl-read", target: "" },
    ]) {
      assert.deepEqual(ruleFor(denial), { verdict: RuleVerdict.Unmappable, rule: "", denial });
    }
  });

  it("adds rules after the v1 allows and before its closing denies", () => {
    const rule = '(allow sysctl-read (sysctl-name "hw.pagesize_compat"))';
    const text = lines(withRules(headless(), [rule]));
    const at = text.indexOf(rule);
    assert.ok(at > text.findLastIndex((line, index) => index !== at && line.startsWith("(allow")));
    assert.ok(at < text.findIndex((line) => line.includes("OpenGL.framework")));
    assert.deepEqual(
      text.filter((line) => line !== rule),
      HEADLESS,
    );
  });

  it("removing a v1 filter never leaves an allow without one (that would grant the operation wholesale)", () => {
    const without = lines(withoutAtom(headless(), '(iokit-user-client-class "AGXDeviceUserClient")'));
    assert.ok(!without.some((line) => line.startsWith("(allow iokit-open")), "the emptied allow is dropped whole");
    assert.equal(without.length, HEADLESS.length - 1);
    const lookups = lines(withoutAtom(headless(), '(global-name "com.apple.MTLCompilerService")')).find((line) =>
      line.startsWith("(allow mach-lookup"),
    );
    assert.equal(
      lookups,
      '(allow mach-lookup (global-name "com.apple.audio.AudioComponentRegistrar") (global-name "com.apple.audio.audiohald"))',
    );
  });
});

/** A deny log that never reports anything: the measurement must notice it measured nothing. */
const SILENT_LOG: DenyLogSource = { open: async () => ({ close: async () => [] }) };

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SPIKE_CARGO = path.join(REPO_ROOT, ".studio-dev", "spike-toolchain", "sysroot", "bin", "cargo");
const POND_TICKS = 60;

/** Skips without the spike toolchain, unless GENEX_REQUIRE_SPIKE_TOOLCHAIN=1 makes that a failure. */
function spikeToolchainSkip(): string | false {
  if (process.platform !== "darwin") return "not run: Seatbelt is the Mac's";
  if (existsSync(SPIKE_CARGO)) return false;
  if (process.env.GENEX_REQUIRE_SPIKE_TOOLCHAIN === "1") throw new Error(`no spike toolchain at ${SPIKE_CARGO}`);
  return "not run: the spike toolchain is not installed";
}

describe("the Seatbelt measurement under the real profile (darwin, M0a.10a)", { skip: macClangSkip() }, () => {
  let runsRoot: string;
  /** A program that does nothing and exits 0: it runs under the v1 headless profile. */
  let idle: string;
  before(async () => {
    const base = await realpath(await tmpDir("seatbelt-measure-"));
    runsRoot = path.join(base, "native-runs");
    await mkdir(runsRoot, { mode: 0o700 });
    await writeFile(path.join(base, "idle.c"), "int main(void) { return 0; }\n");
    idle = path.join(base, "idle");
    await macClang(["-O1", "-mmacosx-version-min=13.0", path.join(base, "idle.c"), "-o", idle]);
  });

  it("refuses typed when the v1 run's deny log is empty: nothing was measured", { timeout: MINUTE_MS }, async () => {
    const scenario: Scenario = {
      id: "true",
      mode: NativeRunMode.Headless,
      program: idle,
      args: () => [],
      judge: async (run) => ({ ok: run.code === 0, fingerprint: "", detail: `exit ${run.code}` }),
    };
    await assert.rejects(
      measureScenario(scenario, { log: SILENT_LOG, runsRoot }),
      (error: unknown) => error instanceof MeasureError && error.code === MeasureRefusal.DenyLogEmpty,
    );
  });

  describe("the Rust pond under the game's profile (M1.13)", { skip: spikeToolchainSkip() }, () => {
    let pond: string;
    before(async () => {
      // The shared helper's build: the dev flavour every other pond row builds, copied at once into
      // this row's own folder. A second feature set built into the shared target would replace the
      // `debug/pond` the other rows copy or run while they read it. With arguments the binary runs
      // its self-test in either flavour (the studio flavour serves the host only without them).
      const out = await buildPond(path.join(await realpath(await tmpDir("seatbelt-pond-")), "out"));
      pond = path.join(out, HEADLESS_EXECUTABLE);
    });

    // Flipped (M1.13): with R1 (`hw.pagesize_compat`) the pond no longer aborts before main; its
    // headless self-test record under the profile matches its plain run.
    it("the pond's headless self-test runs under the game's headless profile as it does plainly", {
      timeout: 2 * MINUTE_MS,
    }, async (t) => {
      const scenario = pondHeadless(pond, POND_TICKS);
      const reference = await plainRun(scenario, runsRoot);
      const required = metalRequired() || process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
      if (!reference.ok) {
        assert.ok(!required, `the pond self-test fails with no profile: ${reference.detail}`);
        t.skip(`not run: the pond self-test fails with no profile here (${reference.detail})`);
        return;
      }
      const v1 = await sandboxedRun(scenario, (profile) => profile, { log: SILENT_LOG, runsRoot }, "v1", []);
      t.diagnostic(`under the profile: ${v1.judgement.detail}`);
      assert.equal(v1.judgement.ok, true, v1.judgement.detail);
      assert.equal(v1.judgement.fingerprint, reference.fingerprint, "the same self-test record as the plain run");
    });
  });
});
