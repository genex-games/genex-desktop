/**
 * The game conformance suite (M7.0) over real game processes: the `rust-game` fixture's fd-3 game
 * (`tests/fixtures/rust-fd3-stub-game.mjs`) passes every check it can run here, and each
 * nonconforming double (`tests/fixtures/rust-nonconforming/`) fails exactly the named check with its
 * typed code: a game missing a verb, one whose second seeded run differs, one reporting a wrong
 * capture digest, one that ignores Stop and one that leaves a child running. The Live ring is
 * `unavailable` off a Mac and with no frames host, never a pass; on a Mac a ring's frames are judged
 * by their seq and generation. Each game is spawned the way `spawnGame` starts one (fd 3, a process
 * group of its own, the studio's variables only) and stopped the way the registry stops a run.
 * `render-presets` and `render-extensions` are `unavailable` for a game whose receipt does not
 * advertise `renderSettings` (every double here but the render doubles, as every C++ and pre-RQ0 Rust
 * game), counted green with the typed problem `render-settings-unsupported`; a game that advertises the
 * verb must pass both: every preset and the emulated phone classes (TAA, AO and exposure on) capture
 * non-blank and settled twice with one digest, the verb round-trips, `volatile.render` is in shape and
 * names what was set, low and high keep one look, two cold boots capture on one pinned profile, no
 * custom pass is refused and `degraded` names only reasons the receipt allows.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ConformanceDeps,
  type ConformanceLaunch,
  type LiveRingObservation,
  LIVE_FRAMES_WANTED,
  registryLauncher,
  runGameConformance,
  stopGameChild,
} from "../../src/main/core/game-conformance.ts";
import {
  judgeColdBoots,
  LOOK_HUE_TOLERANCE_DEG,
  LOOK_LUMA_TOLERANCE,
  lookProblem,
} from "../../src/main/core/game-conformance-render.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { CustomEvent, type CustomEventData, customEventData } from "../../src/shared/custom-events.ts";
import {
  CONFORMANCE_CHECKS,
  conformancePassed,
  conformanceRunOf,
  engineEjectedOf,
  gameTrustOf,
  ConformanceCheck,
  type ConformanceCheckResult,
  ConformanceOutcome,
  ConformanceProblem,
  type GameConformanceReport,
} from "../../src/shared/game-conformance.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import {
  NATIVE_RENDER_SETTINGS_API_VERSION,
  NativeError,
  NativeOp,
  NativeOpError,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import type { NativeRunsHost, NativeStartRequest } from "../../src/main/core/native-runs.ts";
import type { PixelStats } from "../../src/shared/preview-contract.ts";
import {
  CaptureExposure,
  type CaptureProvenance,
  DeviceClass,
  QualityPreset,
  SettingsSource,
} from "../../src/shared/render-quality.ts";
import { conformanceRpc } from "../../src/main/harness-rpc/conformance.ts";
import { tools as seedGameTools } from "../../src/harness-seed/tools/game-tools.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { NativeGamePort, NativeOpRefusedError } from "../../src/substrate/native-game-port.ts";
import type { GameChild, GameExit } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_GAME = path.join(REPO, "tests", "fixtures", "rust-fd3-stub-game.mjs");
const DOUBLE = path.join(REPO, "tests", "fixtures", "rust-nonconforming", "game.mjs");
const NONCE = "game-conformance-nonce";
const DIGEST = "d".repeat(64);
/** The admitted build the runs carry in each capture's provenance. */
const BUILD = { stack: GameStack.RustWgpu, target: BuildTarget.Mac, digest: DIGEST, lock: "1".repeat(64) };
const SKIP_ON_WINDOWS = process.platform === "win32" ? "process groups and fd 3 are POSIX" : false;
/** Two launches of a game that ignores Stop each wait out the quit and terminate graces. */
const ROW_TIMEOUT_MS = MINUTE_MS;

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

const leftovers: Array<() => void> = [];
after(() => {
  for (const kill of leftovers) kill();
});

/** A started game: its process and its protocol port. */
interface Started {
  child: GameChild;
  port: NativeGamePort;
  stateDir: string;
}

/** Starts `script` (with `args`) as `spawnGame` would: fd 3, its own group, the studio's variables. */
async function startScript(script: string, args: readonly string[]): Promise<Started> {
  const scratch = await realpath(await tmpDir("game-conformance-"));
  const stateDir = path.join(scratch, "state");
  await mkdir(stateDir, { recursive: true });
  const proc = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    cwd: scratch,
    env: { GENEX_STUDIO_FD: "3", GENEX_STUDIO_NONCE: NONCE, GENEX_STATE_DIR: stateDir, HOME: scratch },
  });
  const exited = new Promise<GameExit>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  await once(proc, "spawn");
  proc.on("error", () => {});
  const { pid, stdout, stderr } = proc;
  const fd3 = proc.stdio[3];
  if (!(fd3 instanceof Duplex) || pid === undefined || !stdout || !stderr) throw new Error("no protocol pipe");
  const kill = (signal: NodeJS.Signals) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  leftovers.push(() => kill("SIGKILL"));
  const child: GameChild = { pid, fd3, stdout, stderr, exited, kill };
  const port = new NativeGamePort({
    child,
    nonce: NONCE,
    mode: NativeRunMode.Headless,
    stateDir,
    timers: REAL_TIMERS,
    encodeJpeg: async () => Buffer.from("jpeg"),
    build: BUILD,
  });
  await port.ready();
  return { child, port, stateDir };
}

/** Starts `script` for the suite, stopped the way the registry stops a run. */
async function launchScript(script: string, args: readonly string[]): Promise<ConformanceLaunch> {
  const { child, port, stateDir } = await startScript(script, args);
  return { port, pid: child.pid, stateDir, buildDigest: DIGEST, stop: () => stopGameChild(child, port) };
}

/** The suite on `script` here, with the processes it saw below each game recorded. */
async function suiteOn(
  script: string,
  args: readonly string[] = [],
  extra: Partial<ConformanceDeps> = {},
): Promise<{ report: GameConformanceReport; seen: number[] }> {
  const seen: number[] = [];
  const { descendants } = await import("../../src/substrate/plugins/native-process.ts");
  const report = await runGameConformance(
    {
      launch: () => launchScript(script, args),
      platform: "linux",
      now: () => Date.now(),
      descendants: async (pid) => {
        const found = await descendants(pid);
        seen.push(...found);
        return found;
      },
      ...extra,
    },
    { project: "ferris", target: BuildTarget.Mac },
  );
  return { report, seen };
}

const byCheck = (report: GameConformanceReport, check: ConformanceCheck): ConformanceCheckResult => {
  const found = report.checks.find((each) => each.check === check);
  assert.ok(found, `${check} is reported`);
  return found;
};

/** The outcome and code of every check, in run order. */
const verdicts = (report: GameConformanceReport) =>
  report.checks.map(({ check, outcome, code }) => [check, outcome, code]);

/** The renderer's checks: judged only for a game whose receipt advertises `renderSettings`. */
const RENDER_CHECKS: ReadonlySet<ConformanceCheck> = new Set([
  ConformanceCheck.RenderPresets,
  ConformanceCheck.RenderExtensions,
]);

/**
 * The verdict a double gets on a check it does not fail: the Live ring is unavailable (not a Mac
 * here), and the renderer's checks are unavailable with `render-settings-unsupported` unless the
 * double's receipt advertises `renderSettings`; every other check passes.
 */
function cleanVerdict(
  check: ConformanceCheck,
  servesRenderSettings = false,
): [ConformanceCheck, ConformanceOutcome, ConformanceProblem | null] {
  if (check === ConformanceCheck.LiveRing)
    return [check, ConformanceOutcome.Unavailable, ConformanceProblem.LiveNotMac];
  if (RENDER_CHECKS.has(check) && !servesRenderSettings)
    return [check, ConformanceOutcome.Unavailable, ConformanceProblem.RenderSettingsUnsupported];
  return [check, ConformanceOutcome.Pass, null];
}

/**
 * Every check passes but those `failing` names, each failing with its code; the Live ring is
 * unavailable (not a Mac here). `servesRenderSettings`: the game's receipt advertises
 * `renderSettings`, so the renderer's checks are judged.
 */
function expectFailing(
  report: GameConformanceReport,
  failing: Partial<Record<ConformanceCheck, ConformanceProblem>>,
  servesRenderSettings = false,
): void {
  const expected = CONFORMANCE_CHECKS.map((check) => {
    const code = failing[check];
    return code === undefined ? cleanVerdict(check, servesRenderSettings) : [check, ConformanceOutcome.Fail, code];
  });
  assert.deepEqual(verdicts(report), expected, JSON.stringify(report.checks));
  assert.equal(report.passed, false);
}

/** Every check passes but `failing`, which fails with `code` (see {@link expectFailing}). */
function expectOnly(
  report: GameConformanceReport,
  failing: ConformanceCheck,
  code: ConformanceProblem,
  servesRenderSettings = false,
): void {
  expectFailing(report, { [failing]: code }, servesRenderSettings);
}

describe("the conformance suite over real game processes", {
  skip: SKIP_ON_WINDOWS,
  timeout: ROW_TIMEOUT_MS * 6,
}, () => {
  it("the rust-game fixture's game passes every check it can run here; the Live ring is unavailable off a Mac", async () => {
    const { report } = await suiteOn(FIXTURE_GAME);
    // Flipped (RQ0.0): render-presets joins the suite, unavailable for a receipt without renderSettings.
    const expected = CONFORMANCE_CHECKS.map((check) => cleanVerdict(check));
    assert.deepEqual(verdicts(report), expected, JSON.stringify(report.checks));
    assert.equal(report.passed, true, "only Live's ring and an unsupported render-presets may be unavailable");
    assert.equal(report.buildDigest, DIGEST);
    assert.equal(report.target, BuildTarget.Mac);
  });

  it("a game missing a verb fails `verbs` with verb-missing, naming the verb", async () => {
    const { report } = await suiteOn(DOUBLE, ["missing-verb"]);
    expectOnly(report, ConformanceCheck.Verbs, ConformanceProblem.VerbMissing);
    assert.match(byCheck(report, ConformanceCheck.Verbs).detail ?? "", /^timing: /);
  });

  it("a game whose second seeded run differs fails `seed-determinism` with nondeterministic", async () => {
    const { report } = await suiteOn(DOUBLE, ["nondeterministic"]);
    expectOnly(report, ConformanceCheck.SeedDeterminism, ConformanceProblem.Nondeterministic);
    assert.match(byCheck(report, ConformanceCheck.SeedDeterminism).detail ?? "", /^checksum: /);
  });

  it("a game reporting a wrong capture digest fails `capture-digest` with capture-digest", async () => {
    const { report } = await suiteOn(DOUBLE, ["wrong-digest"]);
    expectOnly(report, ConformanceCheck.CaptureDigest, ConformanceProblem.CaptureDigest);
  });

  it("a game that ignores Stop fails `stop-reap` with stop-ignored, and nothing it started is left", async () => {
    const { report, seen } = await suiteOn(DOUBLE, ["ignores-stop"]);
    expectOnly(report, ConformanceCheck.StopReap, ConformanceProblem.StopIgnored);
    assert.ok(seen.length > 0, "the game's helper was seen below it");
    assert.deepEqual(seen.filter(running), [], "the studio's Stop ended every listed descendant");
  });

  it("a game that leaves a child running after quit fails `stop-reap` with orphan; the suite ends the orphan", async () => {
    const { report, seen } = await suiteOn(DOUBLE, ["orphan-child"]);
    expectOnly(report, ConformanceCheck.StopReap, ConformanceProblem.Orphan);
    assert.ok(seen.length > 0, "the game's helper was seen below it");
    assert.deepEqual(seen.filter(running), [], "nothing is left running after the suite");
  });
});

/**
 * A launch of the conforming double whose `ready` advertises `renderSettings` (as a Rust game built
 * after RQ0.7 does) and whose `renderSettings` answers as `answer` says: the double itself answers
 * `unknown-op`, `refuse` makes the port see the game refuse it with that code.
 */
async function advertisingLaunch(refuse: string | null): Promise<ConformanceLaunch> {
  const started = await launchScript(FIXTURE_GAME, []);
  const { port } = started;
  const ready = await port.ready();
  const receipt = ready.receipt;
  assert.ok(receipt, "the double is a protocol 2 game with a receipt");
  const advertised = { ...ready, receipt: { ...receipt, renderSettingsApi: NATIVE_RENDER_SETTINGS_API_VERSION } };
  return {
    ...started,
    port: {
      ready: async () => advertised,
      screenshotWithStats: (...args) => port.screenshotWithStats(...args),
      call: (op, arg) =>
        op === NativeOp.RenderSettings && refuse !== null
          ? Promise.reject(new NativeOpRefusedError(op, refuse))
          : port.call(op, arg),
    },
  };
}

describe("render-presets and render-extensions", { skip: SKIP_ON_WINDOWS, timeout: ROW_TIMEOUT_MS * 2 }, () => {
  it("a receipt advertising renderSettings whose game answers it `unavailable` is red", async () => {
    const report = await runGameConformance(
      { launch: () => advertisingLaunch(NativeOpError.Unavailable), platform: "linux", now: () => Date.now() },
      { project: "pond", target: BuildTarget.Mac },
    );
    // Flipped (RX.1): render-extensions joins the suite and cannot set a preset either.
    expectFailing(report, {
      [ConformanceCheck.RenderPresets]: ConformanceProblem.VerbFailed,
      [ConformanceCheck.RenderExtensions]: ConformanceProblem.VerbFailed,
    });
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /^renderSettings: /);
    assert.match(byCheck(report, ConformanceCheck.RenderExtensions).detail ?? "", /^renderSettings: /);
  });

  it("a receipt advertising renderSettings whose game does not know the verb fails both with verb-missing", async () => {
    const report = await runGameConformance(
      { launch: () => advertisingLaunch(null), platform: "linux", now: () => Date.now() },
      { project: "pond", target: BuildTarget.Mac },
    );
    // Flipped (RX.1): render-extensions joins the suite.
    expectFailing(report, {
      [ConformanceCheck.RenderPresets]: ConformanceProblem.VerbMissing,
      [ConformanceCheck.RenderExtensions]: ConformanceProblem.VerbMissing,
    });
  });
});

/** The conforming double that serves `renderSettings`, with `defect` when named. */
const RENDER_DOUBLE_ARGS = (defect: string | null) => [defect ?? "render-settings"];

/** One renderSettings call the suite sent, and the order of the calls. */
type SettingsCall = {
  set?: { preset?: string | null; deviceClass?: string | null; features?: Record<string, boolean> | null };
};

/** The switches render-presets turns on for each emulated phone class: the temporal features. */
const TEMPORAL_ON = { taa: true, ao: true, exposure: true };

/** The suite on the render double with `defect` (none: the conforming one). */
const renderRun = (defect: string | null) =>
  runGameConformance(
    { launch: () => launchScript(DOUBLE, RENDER_DOUBLE_ARGS(defect)), platform: "linux", now: () => Date.now() },
    { project: "pond", target: BuildTarget.Mac },
  );

describe("render-presets over a game that serves renderSettings", {
  skip: SKIP_ON_WINDOWS,
  timeout: ROW_TIMEOUT_MS * 2,
}, () => {
  const run = renderRun;

  it("a game that renders every preset and the emulated phones is green: render-presets and render-extensions pass", async () => {
    const report = await run(null);
    const expected = CONFORMANCE_CHECKS.map((check) => cleanVerdict(check, true));
    assert.deepEqual(verdicts(report), expected, JSON.stringify(report.checks));
    assert.equal(report.passed, true);
  });

  it("a game whose low-preset capture is blank fails render-presets, naming the preset", async () => {
    const report = await run("render-blank-low");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.VerbInvalid, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /low.*blank/);
  });

  it("a game whose two captures of one state differ fails render-presets with nondeterministic", async () => {
    const report = await run("render-flaky");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.Nondeterministic, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /^low: /);
  });

  it("a game whose volatile.render does not name the preset it was set to fails render-presets", async () => {
    const report = await run("render-unnamed");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.VerbInvalid, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /volatile\.render/);
  });

  it("a game that answers a preset other than the one asked fails render-presets", async () => {
    const report = await run("render-keeps-preset");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.VerbInvalid, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /asked low/);
  });

  it("a game that refuses an emulated mobile class fails both renderer checks with verb-failed", async () => {
    const report = await run("render-refuses-class");
    // Flipped (RX.1): render-extensions emulates mobile-mid too, and is refused the same way.
    expectFailing(
      report,
      {
        [ConformanceCheck.RenderPresets]: ConformanceProblem.VerbFailed,
        [ConformanceCheck.RenderExtensions]: ConformanceProblem.VerbFailed,
      },
      true,
    );
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /^renderSettings: /);
  });

  it("a game whose ultra capture is nondeterministic fails render-presets with nondeterministic, naming ultra", async () => {
    const report = await run("render-ultra-flaky");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.Nondeterministic, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /^ultra: /);
  });

  it("a game whose volatile.render carries no preset fails render-presets with render-status-invalid", async () => {
    const report = await run("render-no-preset");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.RenderStatusInvalid, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /^low: /);
  });

  it("a verb that answers what was set but ignores it fails render-presets: the round trip names the preset it kept", async () => {
    const report = await run("render-ignores-set");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.VerbInvalid, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /^low: .*round trip.*high/);
  });

  it("a game whose low capture is far darker than high's fails render-presets with look-inconsistent", async () => {
    const report = await run("render-dark-low");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.LookInconsistent, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /luminance/);
  });

  it("a game whose mobile-low capture is blank the way that phone draws by default fails render-presets, naming mobile-low", async () => {
    const report = await run("render-blank-phone-default");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.VerbInvalid, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /^mobile-low: the capture is blank/);
  });

  it("a game that ignores the feature switches it is sent fails render-presets with verb-invalid, naming the switch", async () => {
    const report = await run("render-ignores-features");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.VerbInvalid, true);
    assert.match(
      byCheck(report, ConformanceCheck.RenderPresets).detail ?? "",
      /^mobile-high \(temporal\): exposure was switched on, but the drawn frame has it off/,
    );
  });

  it("a game whose Live frame lands a settings change a few steps later (pipeline-change-deferred until then) is green: the suite waits for each change to land", async () => {
    const report = await run("render-lags-change");
    const expected = CONFORMANCE_CHECKS.map((check) => cleanVerdict(check, true));
    assert.deepEqual(verdicts(report), expected, JSON.stringify(report.checks));
    assert.equal(report.passed, true);
  });

  it("a game whose settings change never lands fails render-presets with verb-invalid at its first case, within the wait's deadline", async () => {
    // The suite's clock runs a thousand times the wall clock, so the wait's deadline passes in moments.
    const started = Date.now();
    const fast = () => started + (Date.now() - started) * 1000;
    const report = await runGameConformance(
      {
        launch: () => launchScript(DOUBLE, RENDER_DOUBLE_ARGS("render-never-lands")),
        platform: "linux",
        now: fast,
        sleep: (ms) => sleep(ms / 1000),
      },
      { project: "pond", target: BuildTarget.Mac },
    );
    const presets = byCheck(report, ConformanceCheck.RenderPresets);
    assert.equal(presets.outcome, ConformanceOutcome.Fail, JSON.stringify(report.checks));
    assert.equal(presets.code, ConformanceProblem.VerbInvalid);
    assert.match(presets.detail ?? "", /^low: the drawn frame still holds the settings before the change/);
  });

  it("a game whose captures follow a per-boot calibration fails render-presets with capture-unpinned", async () => {
    const report = await run("render-unpinned");
    expectOnly(report, ConformanceCheck.RenderPresets, ConformanceProblem.CaptureUnpinned, true);
    assert.match(byCheck(report, ConformanceCheck.RenderPresets).detail ?? "", /cold boots/);
  });
});

describe("render-extensions over a game that serves renderSettings", {
  skip: SKIP_ON_WINDOWS,
  timeout: ROW_TIMEOUT_MS * 2,
}, () => {
  const run = renderRun;

  it("a game whose in-world pass is refused (gpu-pass-invalid) after a switch to ultra fails render-extensions", async () => {
    const report = await run("render-pass-refused");
    expectOnly(report, ConformanceCheck.RenderExtensions, ConformanceProblem.CustomPassRefused, true);
    assert.match(byCheck(report, ConformanceCheck.RenderExtensions).detail ?? "", /^ultra: halo .*gpu-pass-invalid/);
  });

  it("a game whose Level-2 material is refused after a switch to ultra fails render-extensions with extension-refused", async () => {
    const report = await run("render-extension-refused");
    expectOnly(report, ConformanceCheck.RenderExtensions, ConformanceProblem.ExtensionRefused, true);
    assert.match(
      byCheck(report, ConformanceCheck.RenderExtensions).detail ?? "",
      /^ultra: shaders\/glow\.wgsl \(material\) is refused: wgsl-too-large/,
    );
  });

  it("a game degraded for a v1 pass its v2-only receipt does not serve fails render-extensions with degrade-not-allowed", async () => {
    const report = await run("render-v1-degrade");
    expectOnly(report, ConformanceCheck.RenderExtensions, ConformanceProblem.DegradeNotAllowed, true);
    assert.match(byCheck(report, ConformanceCheck.RenderExtensions).detail ?? "", /custom-pass-v1-in-world/);
  });

  it("walks the presets, mobile-mid and mobile-low for render-extensions, then each preset, each phone class as it ships and each phone class with TAA, AO and exposure on for render-presets, giving the settings back after each", async () => {
    const sent: SettingsCall[] = [];
    const launch = async (): Promise<ConformanceLaunch> => {
      const started = await launchScript(DOUBLE, RENDER_DOUBLE_ARGS(null));
      const { port } = started;
      return {
        ...started,
        port: {
          ready: () => port.ready(),
          screenshotWithStats: (...args) => port.screenshotWithStats(...args),
          call: (op, arg) => {
            if (op === NativeOp.RenderSettings) sent.push(arg as SettingsCall);
            return port.call(op, arg);
          },
        },
      };
    };
    const report = await runGameConformance(
      { launch, platform: "linux", now: () => Date.now() },
      { project: "pond", target: BuildTarget.Mac },
    );
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    const changes = sent.filter((call) => call.set !== undefined);
    assert.deepEqual(
      changes.map((call) => call.set),
      // Flipped (RX.1): render-extensions walks its own cases first; render-presets then emulates every
      // phone class with the temporal features on; each restore also gives the verb's switches back.
      // Flipped (RX review): render-extensions adds mobile-low, and render-presets emulates each phone
      // class as it ships (no switches) before the temporal walk.
      [
        { preset: "low" },
        { preset: "medium" },
        { preset: "high" },
        { preset: "ultra" },
        { preset: "auto", deviceClass: "mobile-mid" },
        { preset: "auto", deviceClass: "mobile-low" },
        // Flipped (RQ0 review): the restore clears the verb's preset (null) instead of setting `auto`,
        // which outranked the game's [render] preset and the person's saved choice.
        { preset: null, deviceClass: null, features: null },
        { preset: "low" },
        { preset: "medium" },
        { preset: "high" },
        { preset: "ultra" },
        { preset: "auto", deviceClass: "mobile-high" },
        { preset: "auto", deviceClass: "mobile-mid" },
        { preset: "auto", deviceClass: "mobile-low" },
        { preset: "auto", deviceClass: "mobile-high", features: TEMPORAL_ON },
        { preset: "auto", deviceClass: "mobile-mid", features: TEMPORAL_ON },
        { preset: "auto", deviceClass: "mobile-low", features: TEMPORAL_ON },
        { preset: null, deviceClass: null, features: null },
      ],
    );
    const roundTrips = sent.filter((call) => call.set === undefined);
    assert.equal(roundTrips.length, 10, "render-presets reads the settings back after each of its ten changes");
  });
});

describe("the look and the pinned profile, judged on their own", () => {
  /** A frame's statistics with `meanLuma` and all its saturated hue in one 30° bin (or none: grey). */
  const frameStats = (meanLuma: number, hueBin: number | null): PixelStats => ({
    width: 8,
    height: 8,
    sampled: 64,
    meanLuma,
    litFraction: 1,
    hueHistogram: Array.from({ length: 12 }, (_, bin) => (bin === hueBin ? 1 : 0)),
  });

  it("keeps one look within the luminance and hue tolerances, and names what moved beyond them", () => {
    assert.equal(lookProblem(frameStats(120, 1), frameStats(120 + LOOK_LUMA_TOLERANCE, 1)), null);
    assert.match(lookProblem(frameStats(100, 1), frameStats(100 + LOOK_LUMA_TOLERANCE + 1, 1)) ?? "", /luminance/);
    // Adjacent 30° bins sit one bin apart: more than the hue tolerance.
    assert.ok(30 > LOOK_HUE_TOLERANCE_DEG);
    assert.match(lookProblem(frameStats(120, 1), frameStats(120, 2)) ?? "", /hue/);
    assert.match(lookProblem(frameStats(120, 11), frameStats(120, 1)) ?? "", /hue/, "the short way round the circle");
    assert.equal(lookProblem(frameStats(120, 11), frameStats(120, 11)), null);
    assert.equal(lookProblem(frameStats(120, null), frameStats(120, 4)), null, "a grey frame has no hue to compare");
  });

  const walk: ConformanceCheckResult = {
    check: ConformanceCheck.RenderPresets,
    outcome: ConformanceOutcome.Pass,
    code: null,
    detail: null,
  };
  const pinned: CaptureProvenance = {
    preset: QualityPreset.High,
    deviceClass: DeviceClass.DesktopHigh,
    settingsSource: SettingsSource.ReferenceClass,
    scale: 1,
    settleFrames: 8,
    historyReset: true,
    exposure: CaptureExposure.Instant,
  };
  const cold = (digest: string, render: CaptureProvenance | null = pinned, checksum = "c1") => ({
    checksum,
    digest,
    render,
  });
  const verdict = (judged: ConformanceCheckResult) => [judged.outcome, judged.code];

  it("two cold boots on one pinned profile and one digest keep the walk's pass", () => {
    assert.deepEqual(verdict(judgeColdBoots(walk, cold("aa"), cold("aa"))), [ConformanceOutcome.Pass, null]);
    assert.deepEqual(
      verdict(judgeColdBoots(walk, cold("aa"), null)),
      [ConformanceOutcome.Pass, null],
      "no second boot",
    );
    assert.deepEqual(
      verdict(judgeColdBoots(walk, cold("aa"), cold("bb", pinned, "c2"))),
      [ConformanceOutcome.Pass, null],
      "two states may capture two digests",
    );
  });

  it("a capture without provenance, on the verb's settings, on other settings or another digest of one state is capture-unpinned", () => {
    const unpinned = [ConformanceOutcome.Fail, ConformanceProblem.CaptureUnpinned];
    const verbSettings = { ...pinned, settingsSource: SettingsSource.Verb };
    assert.deepEqual(verdict(judgeColdBoots(walk, cold("aa", null), cold("aa"))), unpinned);
    assert.deepEqual(verdict(judgeColdBoots(walk, cold("aa", verbSettings), cold("aa", verbSettings))), unpinned);
    assert.deepEqual(verdict(judgeColdBoots(walk, cold("aa"), cold("aa", { ...pinned, scale: 0.75 }))), unpinned);
    assert.deepEqual(verdict(judgeColdBoots(walk, cold("aa"), cold("bb"))), unpinned);
  });

  it("a walk that already failed keeps its own failure", () => {
    const red = { ...walk, outcome: ConformanceOutcome.Fail, code: ConformanceProblem.VerbInvalid };
    assert.deepEqual(verdict(judgeColdBoots(red, cold("aa", null), cold("bb"))), [
      ConformanceOutcome.Fail,
      ConformanceProblem.VerbInvalid,
    ]);
  });
});

describe("conformancePassed: which `unavailable` counts green", () => {
  const all = (overrides: Partial<Record<ConformanceCheck, ConformanceCheckResult>>): ConformanceCheckResult[] =>
    CONFORMANCE_CHECKS.map(
      (check) => overrides[check] ?? { check, outcome: ConformanceOutcome.Pass, code: null, detail: null },
    );
  const unavailable = (check: ConformanceCheck, code: ConformanceProblem | null): ConformanceCheckResult => ({
    check,
    outcome: ConformanceOutcome.Unavailable,
    code,
    detail: null,
  });

  it("a pre-RQ0 game (no renderSettings in its receipt) is green with render-presets unavailable and render-settings-unsupported", () => {
    const checks = all({
      [ConformanceCheck.RenderPresets]: unavailable(
        ConformanceCheck.RenderPresets,
        ConformanceProblem.RenderSettingsUnsupported,
      ),
      [ConformanceCheck.LiveRing]: unavailable(ConformanceCheck.LiveRing, ConformanceProblem.LiveNotMac),
    });
    assert.equal(conformancePassed(checks), true);
  });

  it("render-extensions counts green unavailable with render-settings-unsupported only, as render-presets does", () => {
    const unsupported = all({
      [ConformanceCheck.RenderExtensions]: unavailable(
        ConformanceCheck.RenderExtensions,
        ConformanceProblem.RenderSettingsUnsupported,
      ),
    });
    assert.equal(conformancePassed(unsupported), true);
    for (const code of [null, ConformanceProblem.TargetUnsupported, ConformanceProblem.CustomPassRefused]) {
      const checks = all({ [ConformanceCheck.RenderExtensions]: unavailable(ConformanceCheck.RenderExtensions, code) });
      assert.equal(conformancePassed(checks), false, String(code));
    }
    const withoutRow = all({}).filter((result) => result.check !== ConformanceCheck.RenderExtensions);
    assert.equal(conformancePassed(withoutRow), false, "a run from before the row (no render-extensions) is red");
  });

  it("render-presets unavailable for any other reason, or missing, is red; any other check unavailable is red", () => {
    for (const code of [null, ConformanceProblem.TargetUnsupported, ConformanceProblem.VerbFailed]) {
      const checks = all({ [ConformanceCheck.RenderPresets]: unavailable(ConformanceCheck.RenderPresets, code) });
      assert.equal(conformancePassed(checks), false, String(code));
    }
    const withoutRow = all({}).filter((result) => result.check !== ConformanceCheck.RenderPresets);
    assert.equal(conformancePassed(withoutRow), false, "a run without the row");
    const verbs = unavailable(ConformanceCheck.Verbs, ConformanceProblem.RenderSettingsUnsupported);
    assert.equal(conformancePassed(all({ [ConformanceCheck.Verbs]: verbs })), false, "only render-presets takes it");
  });
});

describe("the suite judges one build", { skip: SKIP_ON_WINDOWS, timeout: ROW_TIMEOUT_MS }, () => {
  it("two runs on different builds fail seed-determinism build-changed, whatever they computed", async () => {
    let launched = 0;
    const launch = async (): Promise<ConformanceLaunch> => {
      launched += 1;
      const started = await launchScript(FIXTURE_GAME, []);
      return { ...started, buildDigest: launched === 1 ? DIGEST : "e".repeat(64) };
    };
    const report = await runGameConformance(
      { launch, platform: "linux", now: () => Date.now() },
      { project: "pond", target: BuildTarget.Mac },
    );
    expectOnly(report, ConformanceCheck.SeedDeterminism, ConformanceProblem.BuildChanged);
    assert.equal(report.buildDigest, DIGEST, "the report is keyed by the first run's build");
  });

  it("a game the port killed for an invalid reply fails verbs/verb-invalid; its own Stop is not judged", async () => {
    const { report } = await suiteOn(DOUBLE, ["invalid-reply"]);
    const verbs = byCheck(report, ConformanceCheck.Verbs);
    assert.deepEqual([verbs.outcome, verbs.code], [ConformanceOutcome.Fail, ConformanceProblem.VerbInvalid]);
    assert.equal(byCheck(report, ConformanceCheck.StopReap).outcome, ConformanceOutcome.Pass);
  });
});

// ── through the native run registry, as the harness's `game.conformance` runs it ───────────────

/**
 * A registry over doubles: `start` spawns the game and answers its run, `stop` stops it the way the
 * registry does and announces the run's last status (killed when its group had to be signalled).
 */
function scriptedRuns(script: string, args: readonly string[]): NativeRunsHost {
  const runs = new Map<string, Started & { status: NativeRunStatus }>();
  const listeners = new Set<(run: NativeRunStatus) => void>();
  const stopping = new Set<string>();
  const unused = async () => {
    throw new Error("not used by the conformance suite");
  };
  return {
    start: async (request) => {
      const started = await startScript(script, args);
      const runId = `run-${runs.size + 1}`;
      const status: NativeRunStatus = {
        project: request.project,
        runId,
        target: request.target,
        state: NativeRunState.Ready,
        mode: request.mode,
        pid: started.child.pid,
        backend: null,
        refusal: null,
        problem: null,
        exit: null,
        owner: request.owner ?? null,
        startedAt: new Date(0).toISOString(),
        endedAt: null,
      };
      runs.set(runId, { ...started, status });
      // A game that ends before Stop is asked: killed by the port (a signal), else crashed, as the registry says.
      void started.child.exited.then((exit) => {
        if (stopping.has(runId)) return;
        const state = exit.signal ? NativeRunState.Killed : NativeRunState.Crashed;
        for (const listener of listeners) listener({ ...status, state, exit });
      });
      return { status, port: started.port };
    },
    stop: async (runId) => {
      const run = runs.get(runId);
      assert.ok(run, runId);
      stopping.add(runId);
      const { escalated } = await stopGameChild(run.child, run.port);
      const exit = await run.child.exited;
      const state = escalated ? NativeRunState.Killed : NativeRunState.Stopped;
      for (const listener of listeners) listener({ ...run.status, state, exit });
    },
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stopAll: unused,
    stopAgentRuns: unused,
    stopProject: unused,
    stopMode: unused,
    stopOwnedBy: unused,
    state: () => null,
    portOf: () => null,
    front: unused,
    sweepOrphans: unused,
    onFocus: () => () => {},
    embed: unused,
    reembed: unused,
    resize: () => false,
    input: unused,
    showEmbedded: () => {},
    kill: () => {},
  };
}

/**
 * `runs` whose notices reach their listeners only once Stop is asked: the registry noticed a game
 * the port had already ended late (its reap waited on a loaded machine), so its last status still
 * says the run is going when the suite stops it.
 */
function lateReapNotices(runs: NativeRunsHost): NativeRunsHost {
  const held: Array<() => void> = [];
  let stopAsked = false;
  return {
    ...runs,
    onStatus: (listener) =>
      runs.onStatus((status) => {
        if (stopAsked) listener(status);
        else held.push(() => listener(status));
      }),
    stop: async (runId) => {
      stopAsked = true;
      for (const deliver of held.splice(0)) deliver();
      await runs.stop(runId);
    },
  };
}

/** The suite through `registryLauncher` over `scriptedRuns` (or `wrap` of it). */
async function registrySuite(
  script: string,
  args: readonly string[] = [],
  wrap: (runs: NativeRunsHost) => NativeRunsHost = (runs) => runs,
): Promise<GameConformanceReport> {
  const request = { project: "pond", target: BuildTarget.Mac, mode: NativeRunMode.Headless, owner: "harness:1" };
  const runs = wrap(scriptedRuns(script, args));
  return await runGameConformance(
    { launch: registryLauncher(runs, request), platform: "linux", now: () => Date.now() },
    { project: "pond", target: BuildTarget.Mac },
  );
}

describe("the suite through the native run registry", { skip: SKIP_ON_WINDOWS, timeout: ROW_TIMEOUT_MS * 2 }, () => {
  it("judges the conforming game green, the digest from its captures' provenance and the capture read by the port", async () => {
    const report = await registrySuite(FIXTURE_GAME);
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    assert.equal(report.buildDigest, DIGEST, "the admitted build the run carries");
  });

  it("a run the registry had to kill fails stop-reap with stop-ignored", async () => {
    const report = await registrySuite(DOUBLE, ["ignores-stop"]);
    expectOnly(report, ConformanceCheck.StopReap, ConformanceProblem.StopIgnored);
  });

  it("a game the port killed for an invalid reply fails verbs/verb-invalid, never stop-reap/stop-ignored", async () => {
    const report = await registrySuite(DOUBLE, ["invalid-reply"]);
    const verbs = byCheck(report, ConformanceCheck.Verbs);
    assert.deepEqual([verbs.outcome, verbs.code], [ConformanceOutcome.Fail, ConformanceProblem.VerbInvalid]);
    const stop = byCheck(report, ConformanceCheck.StopReap);
    assert.deepEqual([stop.outcome, stop.code], [ConformanceOutcome.Pass, null], "a Stop never sent is not judged");
  });

  it("a game the port killed is never judged stop-ignored, even when the registry notices its reap after Stop", async () => {
    const report = await registrySuite(DOUBLE, ["invalid-reply"], lateReapNotices);
    const verbs = byCheck(report, ConformanceCheck.Verbs);
    assert.deepEqual([verbs.outcome, verbs.code], [ConformanceOutcome.Fail, ConformanceProblem.VerbInvalid]);
    const stop = byCheck(report, ConformanceCheck.StopReap);
    assert.deepEqual([stop.outcome, stop.code], [ConformanceOutcome.Pass, null], "the port ended it: no Stop to judge");
  });

  it("a wrong capture digest is caught by the port's own read: capture-digest", async () => {
    const report = await registrySuite(DOUBLE, ["wrong-digest"]);
    expectOnly(report, ConformanceCheck.CaptureDigest, ConformanceProblem.CaptureDigest);
  });
});

// ── the harness method: game.conformance (harness-rpc/conformance.ts) ──────────────────────────

/** The handler over a fake core: a library with one Rust and one three.js game, the scripted registry and the event log. */
function conformanceHandler(script: string, args: readonly string[] = []) {
  const starts: NativeStartRequest[] = [];
  const appended: Array<{ events: CustomEventData[]; threadId: string | undefined }> = [];
  const runs = scriptedRuns(script, args);
  const rust = { name: "pond", shape: { kind: ProjectKind.RustWgpu } };
  const web = { name: "garden", shape: { kind: ProjectKind.StudioTemplate } };
  const core = {
    games: { list: async () => [rust, web] },
    nativeRuns: {
      ...runs,
      start: async (request: NativeStartRequest) => {
        starts.push(request);
        return await runs.start(request);
      },
    },
    append: async (events: CustomEventData[], threadId?: string) => {
      appended.push({ events, threadId });
    },
  };
  const internals = {
    harnessBoot: 7,
    assertHarnessRoot: async (_project: string, root: string | null) => (root ? `/real${root}` : null),
  };
  const handler = conformanceRpc(core as never, internals as never)[HostMethod.GameConformance];
  return { handler, starts, appended };
}

describe("the game.conformance harness method", { skip: SKIP_ON_WINDOWS, timeout: ROW_TIMEOUT_MS }, () => {
  it("refuses a seed that is not a u32 and a game that is not Rust, starting nothing", async () => {
    const { handler, starts, appended } = conformanceHandler(FIXTURE_GAME);
    for (const seed of [-1, 1.5, 2 ** 32, Number.NaN, "7"])
      await assert.rejects(handler({ project: "pond", seed } as never), /seed must be a whole number/, String(seed));
    await assert.rejects(handler({ project: "garden" }), (error: unknown) => {
      assert.ok(error instanceof NativeError);
      assert.equal(error.refusal, NativeRefusal.NotADestination);
      return true;
    });
    assert.deepEqual(starts, []);
    assert.deepEqual(appended, []);
  });

  it("runs as the suite (conformance: true, owned by this harness, on the checked root) and records the report's digest on the thread", async () => {
    const { handler, starts, appended } = conformanceHandler(FIXTURE_GAME);
    const report = await handler({ project: "pond", root: "/wt/pond", threadId: "thread-9" });
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    assert.ok(starts.length >= 2, "two runs for determinism");
    for (const start of starts) {
      assert.equal(start.conformance, true, "only this handler sets it");
      assert.equal(start.owner, "harness:7");
      assert.equal(start.root, "/real/wt/pond", "the root assertHarnessRoot answered");
      assert.equal(start.mode, NativeRunMode.Headless);
    }
    assert.equal(appended.length, 1);
    const [recorded] = appended;
    assert.equal(recorded?.threadId, "thread-9");
    const event = recorded?.events[0];
    assert.ok(event);
    const run = conformanceRunOf(event);
    assert.deepEqual(run, {
      project: "pond",
      target: report.target,
      buildDigest: DIGEST,
      passed: report.passed,
      checks: report.checks,
    });
  });
});

/** The seed's check_conformance tool over a recorded call. */
describe("the check_conformance seed tool", () => {
  it("asks game.conformance for the pinned game, its worktree root and demo, and maps the report to ok and lines", async () => {
    const tool = seedGameTools.find((each) => each.name === "check_conformance");
    assert.ok(tool);
    const asked: unknown[] = [];
    const checks = CONFORMANCE_CHECKS.map((check) => ({
      check,
      outcome: check === ConformanceCheck.StopReap ? ConformanceOutcome.Fail : ConformanceOutcome.Pass,
      code: check === ConformanceCheck.StopReap ? ConformanceProblem.StopIgnored : null,
      detail: null,
    }));
    const ctx = {
      project: "pond",
      call: async (method: string, params: unknown) => {
        asked.push({ method, params });
        return { project: "pond", buildDigest: DIGEST, passed: false, checks };
      },
    };
    const outcome = (await tool.execute({ root: "/wt/pond", demo: "walk" }, ctx as never)) as {
      ok: boolean;
      content: string;
    };
    assert.deepEqual(asked, [
      { method: HostMethod.GameConformance, params: { project: "pond", root: "/wt/pond", demo: "walk" } },
    ]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.content, new RegExp(`^Conformance failed on build ${DIGEST.slice(0, 12)}\\.`));
    assert.match(outcome.content, /- stop-reap: fail \(stop-ignored\)/);
    const elsewhere = (await tool.execute({ project: "cove" }, ctx as never)) as { ok: boolean };
    assert.equal(elsewhere.ok, false, "a pinned chat never judges another game");
    assert.equal(asked.length, 1);
  });
});

// ── the Live ring, the web target and a game that never starts (no game process) ──────────────

/** A launch that never starts: every check of a run fails launch-failed, and the ring is judged alone. */
const NO_GAME: ConformanceDeps["launch"] = async () => {
  throw new Error("no build here");
};

const frames = (count: number, generation = 2) =>
  Array.from({ length: count }, (_, index) => ({ seq: index + 1, generation }));

async function ringVerdict(
  platform: NodeJS.Platform,
  observation: LiveRingObservation | null,
): Promise<{ result: ConformanceCheckResult; observed: number }> {
  let observed = 0;
  const liveRing = observation
    ? {
        observe: async () => {
          observed += 1;
          return observation;
        },
      }
    : null;
  const report = await runGameConformance(
    { launch: NO_GAME, platform, now: () => 0, liveRing },
    { project: "ferris", target: BuildTarget.Mac },
  );
  return { result: byCheck(report, ConformanceCheck.LiveRing), observed };
}

describe("the Live ring check", () => {
  const good: LiveRingObservation = { available: true, generation: 2, frames: frames(LIVE_FRAMES_WANTED) };

  it("is unavailable off a Mac, never a pass, and never watches a ring there", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const { result, observed } = await ringVerdict(platform, good);
      assert.deepEqual([result.outcome, result.code], [ConformanceOutcome.Unavailable, ConformanceProblem.LiveNotMac]);
      assert.equal(observed, 0, platform);
    }
  });

  it("is unavailable on a Mac with no frames host, or when the host says the ring cannot be watched", async () => {
    const none = await ringVerdict("darwin", null);
    assert.deepEqual(
      [none.result.outcome, none.result.code],
      [ConformanceOutcome.Unavailable, ConformanceProblem.LiveNoFramesHost],
    );
    const refused = await ringVerdict("darwin", { available: false, code: ConformanceProblem.LiveNoFramesHost });
    assert.equal(refused.result.outcome, ConformanceOutcome.Unavailable);
  });

  it("passes on a Mac when enough frames arrive with a rising seq on the ring's generation", async () => {
    const { result } = await ringVerdict("darwin", good);
    assert.deepEqual([result.outcome, result.code], [ConformanceOutcome.Pass, null]);
  });

  it("fails a short ring, a seq that does not rise and a frame of another generation with their codes", async () => {
    const rows: Array<[string, LiveRingObservation, ConformanceProblem]> = [
      ["too few", { available: true, generation: 2, frames: frames(3) }, ConformanceProblem.RingNoFrames],
      [
        "a repeated seq",
        { available: true, generation: 2, frames: [...frames(LIVE_FRAMES_WANTED), { seq: 5, generation: 2 }] },
        ConformanceProblem.RingSeq,
      ],
      [
        "another generation",
        { available: true, generation: 2, frames: [...frames(LIVE_FRAMES_WANTED), { seq: 99, generation: 1 }] },
        ConformanceProblem.RingGeneration,
      ],
      [
        "no generation",
        { available: true, generation: 0, frames: frames(LIVE_FRAMES_WANTED, 0) },
        ConformanceProblem.RingGeneration,
      ],
    ];
    for (const [what, observation, code] of rows) {
      const { result } = await ringVerdict("darwin", observation);
      assert.deepEqual([result.outcome, result.code], [ConformanceOutcome.Fail, code], what);
    }
  });
});

describe("the suite's other outcomes", () => {
  it("a game that never starts fails every check it runs with launch-failed, and the report is red", async () => {
    const report = await runGameConformance(
      { launch: NO_GAME, platform: "linux", now: () => 0 },
      { project: "ferris", target: BuildTarget.Mac },
    );
    for (const result of report.checks) {
      if (result.check === ConformanceCheck.LiveRing) continue;
      assert.deepEqual([result.outcome, result.code], [ConformanceOutcome.Fail, ConformanceProblem.LaunchFailed]);
    }
    assert.equal(report.passed, false);
    assert.equal(report.buildDigest, null);
  });

  it("a web build is reported unavailable for every check without starting anything", async () => {
    let launched = 0;
    const report = await runGameConformance(
      {
        launch: async () => {
          launched += 1;
          throw new Error("unreachable");
        },
        platform: "darwin",
        now: () => 0,
      },
      { project: "ferris", target: BuildTarget.Web },
    );
    assert.equal(launched, 0);
    assert.equal(report.passed, false, "a build no check judged is never green");
    assert.deepEqual(
      report.checks.map(({ outcome, code }) => [outcome, code]),
      CONFORMANCE_CHECKS.map(() => [ConformanceOutcome.Unavailable, ConformanceProblem.TargetUnsupported]),
    );
  });
});

describe("the conformance records", () => {
  it("a conformance_run, engine_ejected or game_trust record reads back by its own reader, any other record as null", () => {
    const run = customEventData(CustomEvent.ConformanceRun, { project: "pond", buildDigest: DIGEST, passed: true });
    const ejected = customEventData(CustomEvent.EngineEjected, { project: "pond", ejected: true });
    const trust = customEventData(CustomEvent.GameTrust, { project: "pond", trusted: false });
    assert.deepEqual(conformanceRunOf(run), { project: "pond", buildDigest: DIGEST, passed: true });
    assert.deepEqual(engineEjectedOf(ejected), { project: "pond", ejected: true });
    assert.deepEqual(gameTrustOf(trust), { project: "pond", trusted: false });
    assert.equal(conformanceRunOf(trust), null);
    assert.equal(gameTrustOf(run), null);
    const bare: CustomEventData = { type: "custom", event_type: CustomEvent.ConformanceRun };
    assert.deepEqual(conformanceRunOf(bare), {}, "an old record with no payload");
  });
});

// ── `npm run conformance:game`: only the developer's own builds run unconfined ─────────────────

/** `scripts/game-conformance.ts` with `args`, its exit code and stderr; `env` over a bare environment. */
async function conformanceScript(args: readonly string[], env: Record<string, string>) {
  const script = path.join(REPO, "scripts", "game-conformance.ts");
  const proc = spawn(process.execPath, [script, ...args], {
    cwd: REPO,
    stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const [code] = (await once(proc, "exit")) as [number | null];
  return { code, stderr };
}

describe("the conformance script runs a game outside ProcessSandbox only when it is the developer's own build", {
  skip: SKIP_ON_WINDOWS,
  timeout: ROW_TIMEOUT_MS,
}, () => {
  it("refuses an executable outside the cargo target (or a link into it) without --unsandboxed, running nothing", async () => {
    const scratch = await realpath(await tmpDir("conformance-script-"));
    const target = path.join(scratch, "cargo-target");
    await mkdir(target, { recursive: true });
    const marker = path.join(scratch, "ran");
    const outside = path.join(scratch, "game");
    await writeFile(outside, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const linked = path.join(target, "game");
    await symlink(outside, linked);
    const env = { CARGO_TARGET_DIR: target };
    for (const game of [outside, linked]) {
      const { code, stderr } = await conformanceScript(["--game", game], env);
      assert.equal(code, 2, game);
      assert.match(stderr, /--unsandboxed/);
      assert.equal(existsSync(marker), false, `${game}: nothing ran`);
    }
    const inside = path.join(target, "debug-game");
    await writeFile(inside, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const own = await conformanceScript(["--game", inside], env);
    assert.equal(own.code, 1, "the developer's own build runs (and, being no game, is red)");
    assert.equal(existsSync(marker), true);
    await rm(marker);
    const asked = await conformanceScript(["--game", outside, "--unsandboxed"], env);
    assert.equal(asked.code, 1);
    assert.match(asked.stderr, /warning: running .* outside ProcessSandbox/);
    assert.equal(existsSync(marker), true, "--unsandboxed runs it, with a warning");
  });

  it("refuses a game folder outside this repository without --unsandboxed, staging and building nothing", async () => {
    const scratch = await realpath(await tmpDir("conformance-folder-"));
    const folder = path.join(scratch, "stranger-game");
    await mkdir(path.join(folder, "src"), { recursive: true });
    await writeFile(path.join(folder, "genex.toml"), '[game]\ntitle = "Stranger"\n');
    await writeFile(path.join(folder, "src", "main.rs"), 'fn main() { compile_error!("must not be built"); }\n');
    const staged = path.join(REPO, ".studio-dev", "conformance-builds");
    const stagedStranger = async () =>
      existsSync(staged) ? (await readdir(staged)).filter((name) => name.startsWith("conformance-stranger-game-")) : [];
    const { code, stderr } = await conformanceScript(["--game", folder], {});
    assert.equal(code, 2);
    assert.match(stderr, /--unsandboxed/);
    assert.doesNotMatch(stderr, /dev flavour/, "no build started");
    assert.deepEqual(await stagedStranger(), [], "nothing staged");
  });
});
