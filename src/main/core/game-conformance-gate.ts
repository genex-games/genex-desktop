/**
 * The conformance gate of an ejected game (extension ladder level 5): once the person ejected a
 * Rust game's engine into its folder, nothing but the game conformance suite vouches for what it
 * builds, so its Live, capture and export need a green conformance run on the very build they
 * would use, its build digest. A game on the store's engine passes the gate with no run.
 *
 * Whether a game is ejected is the person's record in the profile (`rust-eject.ts`
 * `EngineEjections`), never the game's own `genex.toml`: the build links a fork only where the two
 * agree, so a game an agent edited after its build cannot slip past the gate. The runs are the
 * `conformance_run` events only the host writes (the harness's `game.conformance`; a harness
 * append of one is refused, `harness-events.ts`), keyed by build digest. The latest run on a digest
 * is the one that counts: a red run after a green one on the same build closes the gate again. Its
 * call lines: Live's and an agent's run in `native-prepare.ts` (the build the run would start), and
 * every export in `native-export-run.ts` (the game's current Mac judging build, whatever the
 * destination: a web or phone export of an ejected game is vouched for by the Mac build the suite
 * judged, which links the same forked sources). The suite's own runs pass.
 *
 * Not judged yet: Live's ring is reported `unavailable` by every caller until the frames-host probe
 * lands, so a green run on a Mac says nothing about the ring (recorded as an open item of M7).
 */
import type { EventEnvelope } from "../../shared/event-log.ts";
import {
  type ConformanceRunPayload,
  conformancePassed,
  conformanceRunOf,
  ExtensionRefusal,
} from "../../shared/game-conformance.ts";
import { CppBuildPurpose } from "../../shared/build-problem.ts";
import { BuildTarget, destinationsOf, type GameProject, isCompiledStack, stackOf } from "../../shared/game-project.ts";
import { NATIVE_MAC_EXECUTABLES, NativeRunMode } from "../../shared/native-contract.ts";
import type { GameBuildLanes } from "../game-build.ts";
import type { ToolchainService } from "./toolchains.ts";

const MESSAGE = {
  required: (project: string, digest: string | null) =>
    digest === null
      ? `${project} runs its own engine: build it, then pass the conformance suite before Live, capture or export`
      : `${project} runs its own engine: build ${digest.slice(0, 12)} has no passing conformance run`,
} as const;

/** What the gate answers: open, or `conformance-required` with what is missing. */
export type ConformanceGateResult =
  | { ok: true }
  | { ok: false; refusal: typeof ExtensionRefusal.ConformanceRequired; detail: string };

/** What the gate judges: the game, whether it is ejected, the build it would use and the recorded runs. */
export interface ConformanceGateInput {
  project: string;
  ejected: boolean;
  /** The admitted build's SHA-256, or null when there is none yet. */
  buildDigest: string | null;
  /** Every `conformance_run` payload recorded, oldest first. */
  runs: readonly ConformanceRunPayload[];
}

/** Whether a run is green: its checks say so (recomputed, never only its `passed` flag). */
function green(run: ConformanceRunPayload): boolean {
  return run.passed === true && Array.isArray(run.checks) && conformancePassed(run.checks);
}

/**
 * The gate over the recorded runs: open for a game on the store's engine; for an ejected game, open
 * only when the latest run of this project on this build digest is green.
 */
export function conformanceGate(input: ConformanceGateInput): ConformanceGateResult {
  if (!input.ejected) return { ok: true };
  const digest = input.buildDigest;
  const latest =
    digest === null
      ? undefined
      : input.runs.filter((run) => run.project === input.project && run.buildDigest === digest).at(-1);
  if (latest !== undefined && green(latest)) return { ok: true };
  return { ok: false, refusal: ExtensionRefusal.ConformanceRequired, detail: MESSAGE.required(input.project, digest) };
}

/** The `conformance_run` payloads in `events`, oldest first. */
export function conformanceRunsIn(events: readonly EventEnvelope[]): ConformanceRunPayload[] {
  return events.flatMap((event) => {
    const run = conformanceRunOf(event.data);
    return run ? [run] : [];
  });
}

/** The release the person ejected `project`'s engine from, as the profile records it; null: Studio's engine. */
export type EjectedFrom = (project: string) => Promise<string | null>;

/** What {@link checkConformanceGate} reads: the game, its build digest, the person's eject and the recorded runs. */
export interface ConformanceGateDeps {
  project: string;
  buildDigest: string | null;
  ejectedFrom: EjectedFrom;
  runs: () => Promise<readonly ConformanceRunPayload[]>;
}

/** The gate for a game: the runs are read only for a game the person ejected. */
export async function checkConformanceGate(deps: ConformanceGateDeps): Promise<ConformanceGateResult> {
  const ejected = (await deps.ejectedFrom(deps.project)) !== null;
  const runs = ejected ? await deps.runs() : [];
  return conformanceGate({ project: deps.project, ejected, buildDigest: deps.buildDigest, runs });
}

/** The recorded runs of a core's event store: every thread's `conformance_run` events, oldest first. */
export function storeConformanceRuns(store: {
  listAllSince(after?: string): Promise<{ events: EventEnvelope[] }>;
}): () => Promise<ConformanceRunPayload[]> {
  return async () => conformanceRunsIn((await store.listAllSince()).events);
}

/** What the export gate reaches: the build-lane seam, the game's lock, the person's eject and the recorded runs. */
export interface ExportConformanceDeps {
  gameBuilds: Pick<GameBuildLanes, "ensure">;
  toolchains: Pick<ToolchainService, "currentLock">;
  ejectedFrom: EjectedFrom;
  runs: () => Promise<readonly ConformanceRunPayload[]>;
}

/**
 * The digest a run of `game` would start on the Mac: the headless executable of its current
 * judging build (the build Live and `game.conformance` run), or null when it does not build.
 */
export async function macRunDigest(
  deps: Pick<ExportConformanceDeps, "gameBuilds" | "toolchains">,
  game: GameProject,
): Promise<string | null> {
  const stack = stackOf(game.shape);
  if (!isCompiledStack(stack)) return null;
  const lock = await deps.toolchains.currentLock(stack, game.name);
  const asked = { project: game.name, dir: game.dir, shape: game.shape, destinations: destinationsOf(game), lock };
  const { outcome } = await deps.gameBuilds.ensure(asked, BuildTarget.Mac, CppBuildPurpose.Judging);
  if (!outcome?.ok) return null;
  const exe = NATIVE_MAC_EXECUTABLES[NativeRunMode.Headless];
  return outcome.rust?.receipt?.outputs.find((file) => file.path === exe)?.sha256 ?? null;
}

/**
 * The gate before an export: open for a game on the store's engine (nothing is built for it);
 * for an ejected game, its current Mac build must have a green conformance run, whatever the
 * destination, because that build is what the suite judged.
 */
export async function exportConformanceGate(
  deps: ExportConformanceDeps,
  game: GameProject,
): Promise<ConformanceGateResult> {
  if ((await deps.ejectedFrom(game.name)) === null) return { ok: true };
  const buildDigest = await macRunDigest(deps, game);
  return conformanceGate({ project: game.name, ejected: true, buildDigest, runs: await deps.runs() });
}
