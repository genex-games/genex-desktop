/**
 * Where the open Loop's watch on the project's app lived, kept for copies of the Loop's modules an
 * agent kept from before, which import its names from here. The watch itself moved to
 * `app-look.ts` (SEED_MOVES), which this module passes on, and only informs: Genex never reopens,
 * restarts or compiles the app, never takes the folder back and never pauses the Loop for it. None
 * of the other names here reopens, restores or pauses anything either.
 *
 * The seed's own modules import nothing from here, so a copy of this module an agent kept from
 * before runs only under a caller it kept from before too.
 */
import type { HookHeldBy } from "../../hooks.ts";
import type { LoopRun } from "../loop-run.ts";
import type { OpenLoop } from "./contract.ts";
import { appStopped } from "./app-look.ts";

export { abortLead, healthWatch, settleRecovery } from "./app-look.ts";

/**
 * What came of the lead's rewind while the app was closed, as a `between.ts` from before tells it.
 * Kept for a `between.ts` an agent kept from before.
 */
export type Rewound = { held: HookHeldBy | null; restored: boolean; notBack: string | null };

/**
 * Whether the lead heard that the app stays closed for it: never, since Genex hands nothing over.
 * Kept for a `between.ts` an agent kept from before, which then keeps and restores as at any turn's end.
 */
export const heardAppDown = (_loopRun: LoopRun, _open: OpenLoop): boolean => false;

/** Kept for a `between.ts` an agent kept from before: Genex tries nothing after a lead's turn. */
export function reopenAfterTurn(_loopRun: LoopRun, _open: OpenLoop): Promise<void> {
  return Promise.resolve();
}

/** Kept for a `between.ts` an agent kept from before: a rewind's outcome is the lead's line alone. */
export function afterRewindWhileDown(_loopRun: LoopRun, _open: OpenLoop, _rewound: Rewound): Promise<void> {
  return Promise.resolve();
}

/**
 * A start whose app doesn't answer: the lead hears why, as from the watch. Kept for a `director.ts` an
 * agent kept from before: the seed's start looks at the app itself (`app-look.ts`).
 */
export function appDownAtStart(loopRun: LoopRun, why: string): Promise<void> {
  return appStopped(loopRun, loopRun.open, why);
}

/** Kept for a `director.ts` an agent kept from before: the watch says when the app answers again. */
export function appUpAtStart(_loopRun: LoopRun): void {}
