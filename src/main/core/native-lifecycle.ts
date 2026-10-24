/**
 * When the studio ends native games: the moments the app, the composer and the harness reach, each
 * one call into the registry. A native game is stopped, never paused: a paused game with no window
 * to show it would outlive the reason it ran.
 *
 * - The studio window closed: every run, the person's Play window included.
 * - The studio page crashed: the runs drawn inside it (embedded); the Play window keeps running.
 *   Their frames stop at once, before the games are asked to quit (`NativeRuns.stop` pauses an
 *   embedded run's frames first), so no send waits on a renderer that is gone.
 * - Composer Stop: its own game's compiled builds in flight first (its copies' too), then that
 *   game's agent runs; other games' builds and runs, and the person's Play window, go on.
 * - The harness died: the runs its leases started.
 */
import { NativeRunMode } from "../../shared/native-contract.ts";
import type { NativeRunsHost } from "./native-runs.ts";

/** The studio window closed: every native run ends. */
export function nativeOnWindowClosed(runs: Pick<NativeRunsHost, "stopAll">): Promise<void> {
  return runs.stopAll();
}

/** The studio page is gone: the runs drawn inside it end, and their frames stop at once. */
export function nativeOnRendererGone(runs: Pick<NativeRunsHost, "stopMode">): Promise<void> {
  return runs.stopMode(NativeRunMode.Embedded);
}

/** Composer Stop in `project`'s chat: its builds in flight are cancelled at once, then its agent runs end. */
export async function nativeOnComposerStop(
  builds: { cancelGame(project: string): void },
  runs: Pick<NativeRunsHost, "stopProject">,
  project: string,
): Promise<void> {
  builds.cancelGame(project);
  await runs.stopProject(project, [NativeRunMode.Headless]);
}

/** The harness boot `owner` is gone: the runs its leases started end. */
export function nativeOnHarnessGone(runs: Pick<NativeRunsHost, "stopOwnedBy">, owner: string): Promise<void> {
  return runs.stopOwnedBy(owner);
}
