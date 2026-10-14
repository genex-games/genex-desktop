/**
 * Harness RPC: the game conformance suite (extension ladder, M7.0). Read-only for the game: it
 * builds the game's current Mac build (or the playable worktree `root` names, checked by
 * `assertHarnessRoot`) through the native run registry, starts and stops its own headless runs
 * owned by this harness, and records the report as a `conformance_run` event keyed by the build
 * digest. Live's ring is the person's view, never borrowed: it reports `unavailable` here.
 */
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { CONFORMANCE_SEED, type GameConformanceReport } from "../../shared/game-conformance.ts";
import { GameStack, stackOf } from "../../shared/game-project.ts";
import { hostOf, hostTarget } from "../../shared/game-targets.ts";
import { type HarnessHostHandlers, type HarnessParams, HostMethod } from "../../shared/harness-api.ts";
import { NativeError, NativeRefusal, NativeRunMode } from "../../shared/native-contract.ts";
import { registryLauncher, runGameConformance } from "../core/game-conformance.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

const MESSAGE = {
  notRust: (project: string) => `"${project}" is not a Rust · wgpu game: the conformance suite judges Rust builds`,
  noHost: "this host builds no native game",
  badSeed: "game.conformance: seed must be a whole number from 0 to 2^32 - 1",
} as const;

/** The largest seed a game takes (`u32`). */
const SEED_MAX = 2 ** 32 - 1;

/** The seed both determinism runs start from: the caller's, checked, or the suite's own. */
function checkedSeed(seed: unknown): number {
  if (seed === undefined || seed === null) return CONFORMANCE_SEED;
  const whole = typeof seed === "number" && Number.isSafeInteger(seed) && seed >= 0 && seed <= SEED_MAX;
  if (!whole) throw new Error(MESSAGE.badSeed);
  return seed;
}

/** Runs the suite on the game's current build and records it. */
async function conformance(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.GameConformance>,
): Promise<GameConformanceReport> {
  const root = await x.assertHarnessRoot(p.project, p.root ?? null);
  const seed = checkedSeed(p.seed);
  const game = (await core.games.list()).find((listed) => listed.name === p.project);
  if (!game || stackOf(game.shape) !== GameStack.RustWgpu)
    throw new NativeError(NativeRefusal.NotADestination, MESSAGE.notRust(p.project));
  const host = hostOf(process.platform);
  if (!host) throw new NativeError(NativeRefusal.NoGameBox, MESSAGE.noHost);
  const target = hostTarget(host);
  const launch = registryLauncher(core.nativeRuns, {
    project: p.project,
    target,
    mode: NativeRunMode.Headless,
    owner: `harness:${x.harnessBoot}`,
    conformance: true,
    ...(root ? { root } : {}),
  });
  const report = await runGameConformance(
    { launch, platform: process.platform, now: () => Date.now(), liveRing: null },
    { project: p.project, target, demo: p.demo ?? null, seed },
  );
  const { project, buildDigest, passed, checks } = report;
  const recorded = customEventData(CustomEvent.ConformanceRun, { project, target, buildDigest, passed, checks });
  await core.append([recorded], p.threadId ?? undefined);
  return report;
}

/** The conformance method: its params' path fields are checked by `HARNESS_PARAM_SCHEMAS` before it runs. */
export function conformanceRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.GameConformance]: async (p) => conformance(core, x, p),
  } satisfies Partial<HarnessHostHandlers>;
}
