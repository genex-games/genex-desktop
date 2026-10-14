/**
 * A GPU hang for real (darwin, Apple silicon). The looping-shader fixture (`tests/fixtures/rust-gpu-hang`,
 * one custom post pass that spins every pixel ~4 billion times) is built through the cargo env helper
 * in a scratch workspace beside the genex one, prepared by the real `prepareNativeRun` over the pond's
 * injected deps, started headless by the real `spawnGame` under the game profile and spoken to by the
 * real port and registry on the real clock.
 *
 * Measured on Apple silicon (M3.1): the looping frame never reaches a host deadline. macOS's GPU
 * watchdog ends its command buffer first, so `ready` comes ~7 s late and captures then answer at
 * once, blank. The host's kill path is therefore proven on the same binary frozen in its wait (its
 * group stopped, as a game blocked on a GPU that never answers looks from outside): its capture
 * misses the deadline, the host SIGKILLs the group and the run ends killed `gpu-hang` inside the
 * deadline and the reap margin. The second row holds that the looping shader never wedges a run.
 *
 * Needs the spike toolchain; `GENEX_REQUIRE_METAL=1` turns its absence into a failure. The owner's
 * compositor surviving the hang is checked by eye (owner gate), not here.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import { NativeRuns } from "../../src/main/core/native-runs.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  NATIVE_CALL_TIMEOUT_MS,
  NATIVE_REAP_MARGIN_MS,
  NATIVE_STOP_BUDGET_MS,
  NativeError,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import { POND_PROJECT, needsPond, pondGame, pondPrepareDeps } from "../helpers/rust-pond-binary.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const FIXTURE = path.join(REPO, "tests", "fixtures", "rust-gpu-hang");
const GENEX_CRATE = path.join(REPO, "native", "genex-rust", "crates", "genex");
const GENEX_LOCK = path.join(REPO, "native", "genex-rust", "Cargo.lock");
const CARGO_TARGET = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
/** A cold build compiles the facade's whole graph; the run itself is seconds. */
const SUITE_TIMEOUT_MS = 30 * MINUTE_MS;
const BUILD_TIMEOUT_MS = 25 * MINUTE_MS;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** What the real clock may add to the deadline and the margin: the event loop and a busy machine. */
const SLACK_MS = 3000;

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/**
 * Builds the fixture in a scratch workspace (its manifest names the genex crate by path; the genex
 * lock is copied so every crate resolves to its pinned, vendored version, offline) and copies the
 * binary to `out/game-headless`, as the Rust lane's Mac output names it.
 */
async function buildHang(scratch: string): Promise<string> {
  const workspace = path.join(scratch, "rust-gpu-hang");
  await cp(FIXTURE, workspace, { recursive: true });
  const manifest = (await readFile(path.join(workspace, "Cargo.toml.in"), "utf8")).replace(
    `path = "@GENEX@"`,
    `path = ${JSON.stringify(GENEX_CRATE)}`,
  );
  await writeFile(path.join(workspace, "Cargo.toml"), manifest);
  await copyFile(GENEX_LOCK, path.join(workspace, "Cargo.lock"));
  await execFileAsync(process.execPath, [RUST_ENV, "--", "cargo", "build", "--bin", "rust-gpu-hang", "--offline"], {
    env: { ...process.env, CARGO_TARGET_DIR: CARGO_TARGET, GENEX_RUST_WORKSPACE: workspace },
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const out = path.join(scratch, "builds", "out");
  await mkdir(out, { recursive: true });
  const exe = path.join(out, "game-headless");
  await copyFile(path.join(CARGO_TARGET, "debug", "rust-gpu-hang"), exe);
  await chmod(exe, 0o755);
  return out;
}

/** How long a row waits for the run's last status after the refusal, and how often it looks. */
const END_WAIT_MS = 5000;
const END_POLL_MS = 10;

describe("a looping shader under the real game box", { ...needsPond(), timeout: SUITE_TIMEOUT_MS }, () => {
  let sandbox: ProcessSandbox | undefined;
  let runs: NativeRuns | undefined;
  let root = "";
  const statuses: NativeRunStatus[] = [];

  before(async () => {
    const scratch = await realpath(await tmpDir("rust-gpu-hang-real-"));
    root = path.join(scratch, "native-runs");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const out = await buildHang(scratch);
    const box = await ProcessSandbox.create({
      writableRoots: [],
      scratchDir: path.join(scratch, "scratch"),
      secretPaths: [],
      enabled: false,
      nativeRunsRoot: root,
    });
    sandbox = box;
    const { deps } = pondPrepareDeps({
      root,
      out,
      game: pondGame(path.join(scratch, "games", POND_PROJECT)),
      gameBox: () => box.gameBoxAvailable(),
    });
    runs = new NativeRuns({
      root,
      prepare: (request, signal) => prepareNativeRun(deps, request, signal),
      spawn: (request) => box.spawnGame(request),
      connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async (bgra) => Buffer.from(bgra) }),
      emit: (event) => {
        if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
      },
      timers: REAL_TIMERS,
    });
  });

  /** The run's last status once it ended (or the last one there is after `END_WAIT_MS`). */
  async function endedStatus(runId: string): Promise<NativeRunStatus | undefined> {
    const last = () => statuses.filter((status) => status.runId === runId).at(-1);
    for (let waited = 0; waited < END_WAIT_MS && !last()?.endedAt; waited += END_POLL_MS) await sleep(END_POLL_MS);
    return last();
  }

  after(async () => {
    await runs?.stopAll();
    await sandbox?.dispose();
  });

  /** Starts the fixture headless, as an agent's run starts, and answers the run and its pid. */
  async function startHang() {
    const registry = runs ?? assert.fail("the rig did not start");
    const run = await registry.start({ project: POND_PROJECT, target: BuildTarget.Mac, mode: NativeRunMode.Headless });
    const pid = run.status.pid ?? assert.fail("no pid");
    assert.equal(run.status.state, NativeRunState.Ready);
    return { registry, run, pid };
  }

  it("a game frozen in its GPU wait (its group stopped) owing a capture is killed gpu-hang inside the deadline and the margin, nothing left running", async () => {
    const { run, pid } = await startHang();
    // As a game whose capture waits on a GPU that never answers looks from outside: nothing runs.
    process.kill(-pid, "SIGSTOP");
    const from = Date.now();
    const refusal = await run.port.screenshotWithStats().then(
      () => "answered",
      (error: unknown) => (error instanceof NativeError ? error.refusal : String(error)),
    );
    assert.equal(refusal, NativeRefusal.GpuHang);
    const ended = await endedStatus(run.status.runId);
    assert.deepEqual([ended?.state, ended?.refusal], [NativeRunState.Killed, NativeRefusal.GpuHang]);
    assert.equal(ended?.exit?.signal, "SIGKILL", "reaped by the kernel after the group's SIGKILL");
    const took = Date.parse(ended?.endedAt ?? "") - from;
    assert.ok(took <= NATIVE_CALL_TIMEOUT_MS + NATIVE_REAP_MARGIN_MS + SLACK_MS, `ended ${took} ms after the capture`);
    assert.equal(running(pid), false, "nothing left running");
    // The run dir is removed right after the run's last status.
    for (let waited = 0; waited < END_WAIT_MS && (await readdir(root)).length > 0; waited += END_POLL_MS)
      await sleep(END_POLL_MS);
    assert.deepEqual(await readdir(root), [], "the run dir is gone");
  });

  // Re-plan (M3.1 memo): genex-render reads the command buffer's status after its poll and refuses
  // the capture; wgpu-hal 30's Metal fence takes a command buffer in error for a completed one, so
  // the frame comes back blank today. CONTRACT.md names the gap; this row stays open until then.
  it.todo(
    "a frame the macOS GPU watchdog ended is refused gpu-hang or device-lost, never answered blank (CONTRACT.md capture)",
  );

  /**
   * On a Mac the looping shader never reaches a host deadline: macOS's GPU watchdog ends the
   * command buffer first (the first frame holds `ready` back ~7 s, then captures answer at once,
   * blank). Either way the run is never wedged: every call answers inside its deadline or the host
   * kills the game `gpu-hang`, and Stop ends it inside the budget.
   */
  it("the looping shader never wedges the run: the GPU watchdog or the host's deadline ends the frame, and Stop ends the game inside the budget", async () => {
    const { registry, run, pid } = await startHang();
    const from = Date.now();
    const answered = await run.port.screenshotWithStats().then(
      () => "answered",
      (error: unknown) => (error instanceof NativeError ? error.refusal : String(error)),
    );
    const took = Date.now() - from;
    // This row holds only that nothing wedges: an answered (blank) frame is the open todo above.
    assert.ok(
      [NativeRefusal.GpuHang, "answered"].includes(answered),
      `the capture settled (answered or refused gpu-hang), never anything else: ${answered}`,
    );
    assert.ok(took <= NATIVE_CALL_TIMEOUT_MS + SLACK_MS, `settled ${took} ms after it was asked`);
    const stopFrom = Date.now();
    await registry.stop(run.status.runId);
    assert.ok(Date.now() - stopFrom <= NATIVE_STOP_BUDGET_MS + SLACK_MS, "Stop ended it inside the budget");
    assert.equal(running(pid), false, "nothing left running");
  });
});
