/**
 * The native run card over Live, pure: what it says about a C++ game's own window in each state,
 * which buttons it offers, and why a run ended or was refused. A Mac run keeps Play on Mac's words;
 * a Windows or Linux run (the host's own destination there) names its window and never the Mac.
 * `NativeRunCard.tsx` renders it; the conformance tests hold it without a DOM.
 */
import { type BuildProblem, BuildProblemCode } from "../../../shared/build-problem.ts";
import { BuildTarget } from "../../../shared/game-project.ts";
import { DestinationBadge } from "../../../shared/game-targets.ts";
import { NativeRefusal, NativeRunMode, NativeRunState, type NativeRunStatus } from "../../../shared/native-contract.ts";
import { DESTINATION_WORDS, NATIVE_WORDS } from "../../words.ts";
import { problemReason, troubleWords } from "./build-trouble.ts";

/** The card's buttons, each its `data-stage-native-action`. Never rename a value. */
export const NativeCardAction = {
  Stop: "stop",
  /** Play on Mac again, after a window that ran ended. */
  Restart: "restart",
  /** Bring to front: raise the game's window over the others. */
  Front: "front",
  /** The Mac build could not start for want of tools: open the Toolchain sheet for the Mac. */
  InstallTools: "install-tools",
  /** The Mac build's tools were set up by an older Genex: open the Toolchain sheet to set them up again. */
  SetUpTools: "set-up-tools",
  /** The Mac build's tools are installed but their first build was never prepared: open the sheet to finish. */
  FinishSetUp: "finish-set-up",
  /** Play on Mac again, after a build that failed or a run Genex refused: no window ever opened. */
  TryAgain: "try-again",
} as const;
export type NativeCardAction = (typeof NativeCardAction)[keyof typeof NativeCardAction];

/** What the card shows for one run. */
export interface NativeCardView {
  state: NativeRunState;
  /** What the card is about: the game playing (on a Mac), or its window; its destination when no window opened. */
  heading: string;
  /** Where the run stands, in words. */
  title: string;
  /** Why it ended or was refused (a failed build in its destination's words); null while it runs or once it stopped as asked. */
  detail: string | null;
  /** Its buttons, in order. */
  actions: NativeCardAction[];
  /** The Mac build's problem, when the build failed and the lane said why: the build strip shows it. */
  problem: BuildProblem | null;
  /** Something is under way (building, starting, stopping): the card says so and waits. */
  busy: boolean;
  /**
   * Whether Details holds the game's last stderr: only when it says why the game ended badly (a
   * crash, a kill, a refusal with no build problem), never after a Stop the person asked for.
   */
  log: boolean;
}

const { Stop, Restart, Front, InstallTools, SetUpTools, FinishSetUp, TryAgain } = NativeCardAction;

/** The buttons of a run that is still on its way, or running. Ended runs offer Restart or Try again. */
const LIVE_ACTIONS: Partial<Record<NativeRunState, NativeCardAction[]>> = {
  [NativeRunState.Building]: [Stop],
  [NativeRunState.Admitting]: [Stop],
  [NativeRunState.Starting]: [Stop],
  [NativeRunState.Ready]: [Front, Stop],
  [NativeRunState.Paused]: [Front, Stop],
  [NativeRunState.Stopping]: [],
};

/** States that are under way: the card waits for the next one. */
const BUSY: ReadonlySet<NativeRunState> = new Set([
  NativeRunState.Building,
  NativeRunState.Admitting,
  NativeRunState.Starting,
  NativeRunState.Stopping,
]);

/** Whether the run was refused because its Mac build failed. */
const buildFailed = (status: NativeRunStatus): boolean => status.refusal === NativeRefusal.BuildFailed;

/**
 * Why the build failed, in the card's words: a typed reason's own sentence (a gate refusal with the
 * gate's reason), else "fix the error" in the Mac's own words (Play on Mac again) or its
 * destination's. Never the build strip's sentences about Live's page (the last working build on
 * show, packages to install): no native build is on show, and a C++ game has no packages.
 */
function buildFailedWords(status: NativeRunStatus): string {
  const { problem, target } = status;
  const typed = problem !== null && problemReason(problem) !== BuildProblemCode.CommandFailed;
  if (typed) return troubleWords(problem);
  return target === BuildTarget.Mac ? NATIVE_WORDS.buildFailed : NATIVE_WORDS.buildFailedFor(target);
}

/**
 * Why the run ended or was refused, or nothing when it runs or stopped as asked. A computer with
 * no usable game box says which (`box`), over the refusal's own words.
 */
function detailOf(status: NativeRunStatus): string | null {
  if (buildFailed(status)) return buildFailedWords(status);
  if (status.box) return NATIVE_WORDS.box[status.box];
  if (status.refusal) return NATIVE_WORDS.refusal[status.refusal];
  if (status.state === NativeRunState.Crashed)
    return NATIVE_WORDS.crashed(status.exit?.code ?? null, status.exit?.signal ?? null);
  return status.state === NativeRunState.Killed ? NATIVE_WORDS.killed : null;
}

/**
 * A failed Mac build's buttons, by why it failed: the sheet's fix for missing, stale or unprepared
 * tools then Try again, nothing for a part Genex has published no download of, else Try again.
 */
const BUILD_FAILED_ACTIONS: Partial<Record<BuildProblemCode, NativeCardAction[]>> = {
  [BuildProblemCode.ToolchainMissing]: [InstallTools, TryAgain],
  [BuildProblemCode.ToolchainStale]: [SetUpTools, TryAgain],
  [BuildProblemCode.ToolchainUnprepared]: [FinishSetUp, TryAgain],
  [BuildProblemCode.ToolchainNotHosted]: [],
};

/** An ended run's buttons: Restart for a window that ran; Try again (after any tools fix) for one that never opened. */
function endedActions(status: NativeRunStatus): NativeCardAction[] {
  if (status.state !== NativeRunState.Refused) return [Restart];
  const reason = buildFailed(status) && status.problem ? problemReason(status.problem) : null;
  return (reason && BUILD_FAILED_ACTIONS[reason]) ?? [TryAgain];
}

/** Each desktop destination's window, as the card names it: "Mac window", "Windows window", "Linux window". */
const WINDOW_TITLE: Partial<Record<BuildTarget, string>> = NATIVE_WORDS.windowTitle;

/**
 * What the card is about. On a Mac: the game playing, the window that ran, or Play on Mac when no
 * window opened. A Windows or Linux run names its window, or its destination when none opened.
 */
function headingOf(status: NativeRunStatus, live: boolean): string {
  const { state, target } = status;
  const refused = state === NativeRunState.Refused;
  if (target !== BuildTarget.Mac)
    return refused ? DESTINATION_WORDS.label[target] : (WINDOW_TITLE[target] ?? NATIVE_WORDS.ended);
  if (live) return NATIVE_WORDS.title;
  return refused ? DESTINATION_WORDS.playOnMac : NATIVE_WORDS.ended;
}

/**
 * Where the run stands, in words. A failed build says so in the Mac's words on a Mac; elsewhere the
 * card's detail names the destination, under "Genex didn't start this build". A Windows or Linux
 * build is "Building", never "Building for Mac".
 */
function titleOf(status: NativeRunStatus): string {
  const { state, target } = status;
  const onMac = target === BuildTarget.Mac;
  if (buildFailed(status) && onMac) return NATIVE_WORDS.refusal[NativeRefusal.BuildFailed];
  if (state === NativeRunState.Building && !onMac) return DESTINATION_WORDS.badge[DestinationBadge.Building];
  return NATIVE_WORDS.state[state];
}

/** Ended states whose stderr says why: a crash or a kill (a refusal with no build problem too). */
const LOGGED: ReadonlySet<NativeRunState> = new Set([NativeRunState.Crashed, NativeRunState.Killed]);

/** The card for the person's window run, or null when there is none to show. */
export function nativeCardView(status: NativeRunStatus | null): NativeCardView | null {
  if (!status || status.mode !== NativeRunMode.Window) return null;
  const { state } = status;
  const live = LIVE_ACTIONS[state];
  const problem = buildFailed(status) ? status.problem : null;
  const refusedWithoutProblem = state === NativeRunState.Refused && problem === null;
  return {
    state,
    heading: headingOf(status, live !== undefined),
    title: titleOf(status),
    detail: detailOf(status),
    actions: live ?? endedActions(status),
    problem,
    busy: BUSY.has(state),
    log: LOGGED.has(state) || refusedWithoutProblem,
  };
}
