/**
 * A compiled game (C++ · raylib or Rust · wgpu) on the stage, pure: what each destination's badge says on this host (with
 * its latest check), which of the game's builds are running, when a badge may say Build failed or
 * that its tools need installing or setting up, what Live shows for a game without Browser, why
 * Play on Mac cannot open and when Live offers to show the Mac build itself (Web | Native).
 * `StageStrip.tsx`, `DestinationBadges.tsx` and `PreviewPanel.tsx` render it; the conformance tests
 * hold it without a DOM.
 */
import { StudioPlatform } from "../../../shared/boot.ts";
import { type BuildProblem, BuildPhase, BuildProblemCode, CppBuildPurpose } from "../../../shared/build-problem.ts";
import {
  BuildTarget,
  type CompiledStack,
  destinationsOf,
  GameStack,
  type GameDestinations,
  liveEmbedsStack,
  playsInOwnWindow,
  type ProjectShape,
  stackOf,
} from "../../../shared/game-project.ts";
import { DestinationBadge, runRefusal, TargetRefusal } from "../../../shared/game-targets.ts";
import {
  type DestinationCheck,
  NativeRefusal,
  NativeRunState,
  type NativeRunStatus,
} from "../../../shared/native-contract.ts";
import type { ToolchainStatus } from "../../../shared/toolchain.ts";
import { missingForStack } from "../toolchain-view.ts";
import type { UiEventMap } from "../../../shared/ui-events.ts";
import { DESTINATION_WORDS, NATIVE_WORDS } from "../../words.ts";

/** The badge and card words only the stage uses. */
const MESSAGE = {
  inLive: "In Live",
  ownWindow: "Plays in its own window",
  needsTools: "Needs tools",
  needsSetUp: "Needs set-up",
  /** Live's card for a game none of whose destinations runs on this computer: one line each, as the shared empty state holds. */
  noBrowserBuild: "This game has no browser build",
  notRunHere: "Its destinations can’t run on this computer.",
} as const;

/** What a badge's `data-destination-state` reports: the badge vocabulary, and the standings only the stage names. */
export const BadgeState = {
  ...DestinationBadge,
  InLive: "in-live",
  OwnWindow: "own-window",
  /** Live's build could not start: a tool it needs is not installed (the strip offers the sheet). */
  NeedsTools: "needs-tools",
  /** Its tools are installed, but their first build is not prepared (or was prepared by an older Genex). */
  NeedsSetUp: "needs-set-up",
  MacBuildsNeedAMac: TargetRefusal.MacBuildsNeedAMac,
} as const;
export type BadgeState = (typeof BadgeState)[keyof typeof BadgeState];

/**
 * The hosts on which this build of Genex has a game box to run the host's own OS build in: the
 * Mac, whose Seatbelt game profile runs a game's Mac build in its own window. One fact, so the
 * badges, Play on Mac and Live's card never disagree.
 */
const GAME_BOX_HOSTS: readonly StudioPlatform[] = Object.freeze([StudioPlatform.Mac]);

/** Whether this build of Genex has a game box for `host`'s own OS. */
export function hasGameBox(host: StudioPlatform | null): boolean {
  return host !== null && GAME_BOX_HOSTS.includes(host);
}

/** How many builds of each destination the lane is running for the game on the stage, as `build.progress` counts them. */
export type LaneRuns = Readonly<Partial<Record<BuildTarget, number>>>;

/** Nothing building. */
export const NO_RUNS: LaneRuns = Object.freeze({});

const runsOf = (runs: LaneRuns, target: BuildTarget): number => runs[target] ?? 0;

/**
 * `runs` after one `build.progress` event for the game on the stage. Configure starts a build, Done
 * and Failed end one, and a Build seen without its Configure (the strip opened mid-build) counts
 * one. Counting, not keeping the latest phase, is what keeps a newer build Building when an older
 * one's end arrives after it started. Another game's events, a judging or export build of this one,
 * a printed line and an end with nothing running change nothing: the same object comes back, so
 * the strip does not redraw.
 */
export function laneRuns(runs: LaneRuns, event: UiEventMap["build.progress"], project: string): LaneRuns {
  const liveBuild = event.project === project && event.purpose === CppBuildPurpose.Live;
  if (!liveBuild || event.line !== undefined) return runs;
  const now = runsOf(runs, event.target);
  const next = nextCount(now, event.phase);
  return next === now ? runs : { ...runs, [event.target]: next };
}

/** A destination's running builds after `phase`. */
function nextCount(now: number, phase: BuildPhase): number {
  if (phase === BuildPhase.Configure) return now + 1;
  if (phase === BuildPhase.Build) return Math.max(now, 1);
  return Math.max(now - 1, 0);
}

/**
 * The destination Live's own build failed for, or null. Only the live folder's build writes the
 * stage's build problem (`#reportBuild`), so a judging build in a worktree never reaches it; a
 * stopped build (composer Stop, a newer build) and Live declining to build a page for a game
 * without Browser are not failures. `build.progress` cannot tell a stopped build from a failed
 * one, which is why a badge never says Build failed from it.
 */
export function liveBuildFailure(problem: BuildProblem | null): BuildTarget | null {
  if (!problem?.target) return null;
  return problem.reason && NOT_A_FAILURE.has(problem.reason) ? null : problem.target;
}

/**
 * Live's problems that are no failure of the game's build: a stopped build, Live declining to build
 * a page for a game without Browser, a build that never ran for want of tools (it needs tools,
 * {@link liveNeedsTools}), for a part with no download yet, or on a computer that builds no C++ game yet.
 */
const NOT_A_FAILURE: ReadonlySet<BuildProblemCode> = new Set([
  BuildProblemCode.Cancelled,
  BuildProblemCode.NotADestination,
  BuildProblemCode.ToolchainMissing,
  BuildProblemCode.ToolchainStale,
  BuildProblemCode.ToolchainUnprepared,
  BuildProblemCode.ToolchainNotHosted,
  BuildProblemCode.UnsupportedHost,
]);

/** What a destination's tools need before it builds: a download, or set-up of tools already installed. */
export const ToolsNeed = {
  Install: "install",
  SetUp: "set-up",
} as const;
export type ToolsNeed = (typeof ToolsNeed)[keyof typeof ToolsNeed];

/** Problems the Toolchain sheet fixes, and what each needs: tools to install, or to set up (again). */
const TOOLS_NEED: Partial<Record<BuildProblemCode, ToolsNeed>> = {
  [BuildProblemCode.ToolchainMissing]: ToolsNeed.Install,
  [BuildProblemCode.ToolchainStale]: ToolsNeed.SetUp,
  [BuildProblemCode.ToolchainUnprepared]: ToolsNeed.SetUp,
};

/** What `problem`'s tools need, when the Toolchain sheet is its fix. */
const toolsNeedOf = (problem: BuildProblem | null): ToolsNeed | null =>
  (problem?.reason && TOOLS_NEED[problem.reason]) || null;

/** The destination Live's build could not start for because a tool it needs is not installed or set up, or null. */
export function liveNeedsTools(problem: BuildProblem | null): BuildTarget | null {
  return toolsNeedOf(problem) ? (problem?.target ?? null) : null;
}

/**
 * What the store's status says `target`'s tools need, or undefined where it has no word (it names
 * no prewarm for a destination this computer does not build, or before a lock exists): tools when
 * a component is missing (the sheet says which have no download yet), set-up when every component
 * is in and its first build is unprepared or stale, null when they are ready.
 */
function statusNeed(
  status: ToolchainStatus | null,
  target: BuildTarget,
  stack: CompiledStack,
): ToolsNeed | null | undefined {
  if (!status || !statusSpeaksFor(status, target, stack)) return undefined;
  const { components, prewarm } = missingForStack(status, [target], stack);
  if (components.length > 0) return ToolsNeed.Install;
  return prewarm.includes(target) ? ToolsNeed.SetUp : null;
}

/**
 * Whether the store's status has a word for `target` of a `stack` game: raylib's names a prewarm
 * per destination it builds; a Rust game's speaks once the host reported the Rust lock (absent
 * from an older host, `null` before the first Rust setup).
 */
function statusSpeaksFor(status: ToolchainStatus, target: BuildTarget, stack: CompiledStack): boolean {
  if (stack === GameStack.RaylibCpp) return status.prewarm?.[target] !== undefined;
  return status.stackLocks !== undefined && Object.hasOwn(status.stackLocks, stack);
}

/**
 * What each of `targets` needs from the Toolchain sheet. The store's status is the truth where it
 * has a word (a build problem may predate the install that fixed it); elsewhere, a build problem's
 * typed word for its own destination (Live's, or the Mac run's). A destination whose tools are
 * ready is absent.
 */
export function toolsNeeds(
  targets: readonly BuildTarget[],
  facts: {
    problems: ReadonlyArray<BuildProblem | null>;
    status: ToolchainStatus | null;
    /** The game's stack; C++ · raylib unless said. */
    stack?: CompiledStack;
  },
): Partial<Record<BuildTarget, ToolsNeed>> {
  const stack = facts.stack ?? GameStack.RaylibCpp;
  const fromProblems: Partial<Record<BuildTarget, ToolsNeed>> = {};
  for (const problem of facts.problems) {
    const need = toolsNeedOf(problem);
    if (need && problem?.target) fromProblems[problem.target] ??= need;
  }
  const needs: Partial<Record<BuildTarget, ToolsNeed>> = {};
  for (const target of targets) {
    const said = statusNeed(facts.status, target, stack);
    const need = said === undefined ? fromProblems[target] : said;
    if (need) needs[target] = need;
  }
  return needs;
}

/**
 * The destination a person's Mac run (window or Live's) failed to build, or null: its build failed
 * for its code, not for want of tools nor because it was stopped.
 */
export function nativeRunFailure(status: NativeRunStatus | null): BuildTarget | null {
  if (status?.refusal !== NativeRefusal.BuildFailed) return null;
  const reason = status.problem?.reason;
  return reason && NOT_A_FAILURE.has(reason) ? null : status.target;
}

/** The strip's `data-stage-build-phase`: building while any build runs, failed when Live's own build did, else nothing. */
export function stagePhase(runs: LaneRuns, failed: BuildTarget | null): BuildPhase | null {
  if (Object.values(runs).some((count) => (count ?? 0) > 0)) return BuildPhase.Build;
  return failed ? BuildPhase.Failed : null;
}

/** One destination's badge. */
export interface DestinationBadgeView {
  target: BuildTarget;
  label: string;
  state: BadgeState;
  /** Its phase, or where it stands on this host. */
  text: string;
  /** The refusal behind "not run here", when the words alone do not say why. */
  why: string | null;
  /** A build running or failed: the strip says it beside the label, not only in the tooltip. */
  loud: boolean;
}

/** What the badges are read from. */
export interface BadgeFacts {
  /** The game's latest destination checks (`GameProject.nativeChecks`): what the lane last learned of each desktop build. */
  checks?: StagedGame["nativeChecks"];
  host: StudioPlatform | null;
  /** {@link hasGameBox} for the host. */
  gameBox: boolean;
  runs: LaneRuns;
  /** {@link liveBuildFailure} of the stage's build problem. */
  failed: BuildTarget | null;
  /** {@link liveNeedsTools} of the stage's build problem. */
  needsTools?: BuildTarget | null;
  /** {@link toolsNeeds}: what each destination's tools need, from the build problems and the store. */
  tools?: Partial<Record<BuildTarget, ToolsNeed>>;
  /** {@link nativeRunFailure}: the destination the person's Mac run failed to build. */
  runFailed?: BuildTarget | null;
  /**
   * The game's stack: a running build names its build stage, and a game with no window of its own
   * (a Rust game) has its host's build shown by Live. Absent, the badges say what they always said.
   */
  stack?: CompiledStack;
  /**
   * Where Live's embedded run of the game's Mac build stands (a game with no window of its own);
   * null or absent when Live has not run it this session.
   */
  macRun?: NativeRunState | null;
}

type Standing = Pick<DestinationBadgeView, "state" | "text" | "why">;

const OWN_WINDOW: Standing = { state: BadgeState.OwnWindow, text: MESSAGE.ownWindow, why: null };

/** A host build Live shows itself (Web | Native), for a game with no window of its own. */
const IN_LIVE_NATIVE: Standing = { state: BadgeState.InLive, text: DESTINATION_WORDS.inLiveNative, why: null };

/** A host build Live ran this session and no longer shows: built, a choice of Native away. */
const BUILT_FOR_LIVE: Standing = {
  state: BadgeState.Built,
  text: DESTINATION_WORDS.badge[DestinationBadge.Built],
  why: DESTINATION_WORDS.nativeBuiltWhy,
};

/** A host build Live has not made yet: choosing Native builds it. */
const NOT_BUILT_FOR_LIVE: Standing = {
  state: BadgeState.NotBuilt,
  text: DESTINATION_WORDS.badge[DestinationBadge.NotBuilt],
  why: DESTINATION_WORDS.nativeNotBuiltWhy,
};

/** Embedded run states in which Live draws the Mac build, or is about to. */
const DRAWN_IN_LIVE: ReadonlySet<NativeRunState> = new Set([
  NativeRunState.Admitting,
  NativeRunState.Starting,
  NativeRunState.Ready,
  NativeRunState.Paused,
]);

/** Embedded run states that leave a Mac build behind: it built and ran, then ended. */
const LEFT_BUILT: ReadonlySet<NativeRunState> = new Set([
  NativeRunState.Stopping,
  NativeRunState.Stopped,
  NativeRunState.Crashed,
  NativeRunState.Killed,
]);

/** Where Live stands with a host build it shows itself: drawing it, it built earlier, or none yet. */
function inLiveStanding(macRun: NativeRunState | null | undefined): Standing {
  if (macRun && DRAWN_IN_LIVE.has(macRun)) return IN_LIVE_NATIVE;
  return macRun && LEFT_BUILT.has(macRun) ? BUILT_FOR_LIVE : NOT_BUILT_FOR_LIVE;
}

/**
 * Where a build this host runs plays: in its own window, or, for a game with none (a Rust game),
 * in Live, which says In Live only while it draws that build.
 */
function runsHere(facts: Pick<BadgeFacts, "stack" | "macRun">): Standing {
  const { stack } = facts;
  return stack && !playsInOwnWindow(stack) ? inLiveStanding(facts.macRun) : OWN_WINDOW;
}

/** The badges a check may carry that say something of their own; the lane never records Building or NotBuilt. */
const CHECK_SAYS: ReadonlySet<DestinationBadge> = new Set([
  DestinationBadge.Built,
  DestinationBadge.Failed,
  DestinationBadge.NotRunHere,
  DestinationBadge.CiPassed,
  DestinationBadge.VerifiedInVm,
]);

/** The words of a check's badge, said the stage's way. */
function checkWords(check: DestinationCheck, host: StudioPlatform | null): Standing {
  const { badge } = check;
  if (badge === DestinationBadge.NotRunHere) {
    const text = host ? DESTINATION_WORDS.notRunHereOn(host) : DESTINATION_WORDS.badge[badge];
    return { state: BadgeState.NotRunHere, text, why: DESTINATION_WORDS.notRunHereWhy };
  }
  const why = badge === DestinationBadge.Failed && check.refusal ? NATIVE_WORDS.refusal[check.refusal] : null;
  return { state: badge, text: DESTINATION_WORDS.badge[badge], why };
}

/**
 * What a desktop destination's latest check says on this host, or null when it says nothing of its
 * own. A build the gate admitted that this host runs plays in its own window; one this version has
 * no game box for says Built and why it does not run; a refused build says Build failed with the
 * gate's refusal; a cross-build says it was built, not run here.
 */
function checkStanding(
  check: DestinationCheck | undefined,
  refusal: TargetRefusal | null,
  facts: Pick<BadgeFacts, "host" | "stack" | "macRun">,
): Standing | null {
  const { host } = facts;
  if (!check || !CHECK_SAYS.has(check.badge)) return null;
  if (check.badge !== DestinationBadge.Built) return checkWords(check, host);
  if (refusal === null) return runsHere(facts);
  return { ...checkWords(check, host), why: DESTINATION_WORDS.refusal[refusal] };
}

/**
 * Where a destination stands on this host when nothing is building: Browser is Live's, a Mac game
 * is built on a Mac, a destination's latest check says how its build went, the host's own OS build
 * plays in its own window through a game box, and any other desktop destination says it is not
 * built yet.
 */
function standing(target: BuildTarget, facts: BadgeFacts): Standing {
  if (target === BuildTarget.Web) return { state: BadgeState.InLive, text: MESSAGE.inLive, why: null };
  const { host, gameBox } = facts;
  const refusal = host ? runRefusal(host, target, { gameBox }) : TargetRefusal.NotRunnableHere;
  if (refusal === TargetRefusal.MacBuildsNeedAMac)
    return { state: BadgeState.MacBuildsNeedAMac, text: DESTINATION_WORDS.refusal[refusal], why: null };
  const checked = checkStanding(facts.checks?.[target], refusal, facts);
  if (checked) return checked;
  if (refusal === null) return runsHere(facts);
  return {
    state: BadgeState.NotBuilt,
    text: DESTINATION_WORDS.badge[DestinationBadge.NotBuilt],
    why: DESTINATION_WORDS.notBuiltWhy,
  };
}

/** The badge of a destination whose tools need the Toolchain sheet. */
const TOOLS_STANDING: Record<ToolsNeed, Standing> = {
  [ToolsNeed.Install]: { state: BadgeState.NeedsTools, text: MESSAGE.needsTools, why: null },
  [ToolsNeed.SetUp]: { state: BadgeState.NeedsSetUp, text: MESSAGE.needsSetUp, why: null },
};

/** Current build activity wins; missing tools cannot erase a recorded cross-destination check. */
function phaseOf(target: BuildTarget, facts: BadgeFacts): Standing | null {
  if (runsOf(facts.runs, target) > 0) {
    const why = facts.stack ? DESTINATION_WORDS.buildStage[facts.stack] : null;
    return { state: BadgeState.Building, text: DESTINATION_WORDS.badge[DestinationBadge.Building], why };
  }
  if (facts.failed === target || facts.runFailed === target)
    return { state: BadgeState.Failed, text: DESTINATION_WORDS.badge[DestinationBadge.Failed], why: null };
  const refusal = facts.host ? runRefusal(facts.host, target, { gameBox: facts.gameBox }) : null;
  const check = facts.checks?.[target];
  if (refusal === TargetRefusal.NotRunnableHere && check && CHECK_SAYS.has(check.badge)) return null;
  const need = facts.tools?.[target] ?? (facts.needsTools === target ? ToolsNeed.Install : null);
  return need ? TOOLS_STANDING[need] : null;
}

/**
 * One badge per destination, in the game's own order. A running build or Live's failure is said
 * beside the label, and so is a build its check says failed.
 */
export function destinationBadges(targets: readonly BuildTarget[], facts: BadgeFacts): DestinationBadgeView[] {
  return targets.map((target) => {
    const phase = phaseOf(target, facts);
    const words = phase ?? standing(target, facts);
    const loud = phase !== null || words.state === BadgeState.Failed;
    return { target, label: DESTINATION_WORDS.label[target], ...words, loud };
  });
}

/** What Live shows for a game without Browser: where it plays, or why it does not run here. */
export const LiveCard = {
  OwnWindow: "own-window",
  /** A game with no window of its own (a Rust game) whose Mac build Live shows in Native. */
  MacInLive: "mac-in-live",
  /** One of its destinations is this computer's own OS, which this version has no game box for yet. */
  NoGameBox: TargetRefusal.NoGameBox,
  NotRunHere: "not-run-here",
} as const;
export type LiveCard = (typeof LiveCard)[keyof typeof LiveCard];

/** A game as the stage knows it: its shape, the destinations it was made with, and their latest checks. */
export interface StagedGame {
  shape: Pick<ProjectShape, "kind">;
  destinations?: GameDestinations;
  /** What the lane last learned of each desktop build (`GameProject.nativeChecks`); absent when none. */
  nativeChecks?: Readonly<Partial<Record<BuildTarget, DestinationCheck>>>;
}

/**
 * Live's card for `game`, or null when Live can show its page (no game, a Three.js game, or a
 * compiled game with Browser). A raylib game says "its own window" only when one of its
 * destinations runs here; a game with no window of its own (a Rust game) says Live shows its Mac
 * build when that build runs on this Mac.
 */
export function liveCard(game: StagedGame | null, host: StudioPlatform | null, gameBox: boolean): LiveCard | null {
  if (!game) return null;
  const stack = stackOf(game.shape);
  if (!liveEmbedsStack(stack)) return null;
  const { targets } = destinationsOf(game);
  if (targets.includes(BuildTarget.Web)) return null;
  const refusals = host === null ? [] : targets.map((target) => runRefusal(host, target, { gameBox }));
  const ownWindow = playsInOwnWindow(stack);
  if (ownWindow && refusals.includes(null)) return LiveCard.OwnWindow;
  if (!ownWindow && nativeToggleShown(targets, host, gameBox, null)) return LiveCard.MacInLive;
  return refusals.includes(TargetRefusal.NoGameBox) ? LiveCard.NoGameBox : LiveCard.NotRunHere;
}

/**
 * The card's title and sentence: the reason it gives is the one the badges' game box gives. Beside
 * the native run card (`windowShown`), the own-window card keeps its title and drops its sentence:
 * the run card already says how the window plays, and offers Restart once it ended.
 */
export function liveCardWords(
  card: LiveCard,
  options: { windowShown: boolean } = { windowShown: false },
): { title: string; body: string | null } {
  if (card === LiveCard.OwnWindow) {
    const { title } = DESTINATION_WORDS.liveStatusCard;
    return options.windowShown ? { title, body: null } : DESTINATION_WORDS.liveStatusCard;
  }
  if (card === LiveCard.MacInLive) return DESTINATION_WORDS.liveMacCard;
  const body = card === LiveCard.NoGameBox ? DESTINATION_WORDS.refusal[TargetRefusal.NoGameBox] : MESSAGE.notRunHere;
  return { title: MESSAGE.noBrowserBuild, body };
}

/**
 * Whether the build-problem strip shows `problem` above the stage. Live declining to build a page
 * for a game without Browser is not trouble: the card already says where the game stands. Tools
 * that were missing are old news while the build they held up runs again (`runs`). While Live shows
 * the Mac build (`view.native`), only the Mac build's trouble is about what is on the stage.
 */
export function showsBuildBanner(
  problem: BuildProblem | null,
  card: LiveCard | null,
  runs: LaneRuns = NO_RUNS,
  view: { native: boolean } = { native: false },
): boolean {
  if (!problem) return false;
  if (view.native && problem.target !== BuildTarget.Mac) return false;
  if (card !== null && problem.reason === BuildProblemCode.NotADestination) return false;
  const rebuilding = problem.target !== undefined && runsOf(runs, problem.target) > 0;
  return !(rebuilding && toolsNeedOf(problem) !== null);
}

/** Whether the strip shows Play on Mac: on a Mac, for a game with Mac among its destinations. */
export function playOnMacShown(targets: readonly BuildTarget[], host: StudioPlatform | null): boolean {
  return host === StudioPlatform.Mac && targets.includes(BuildTarget.Mac);
}

/** Why Play on Mac cannot open a game built for `targets` on this Mac, or null when it can. */
export function playOnMacRefusal(targets: readonly BuildTarget[], gameBox: boolean): TargetRefusal | null {
  if (!targets.includes(BuildTarget.Mac)) return TargetRefusal.NotADestination;
  return runRefusal(StudioPlatform.Mac, BuildTarget.Mac, { gameBox });
}

/**
 * Whether Live offers Web | Native: a game Play on Mac opens on this Mac, while this session has
 * not been told that Live cannot show a Mac build here (`blocked`: embed-unsupported, electron-untested).
 */
export function nativeToggleShown(
  targets: readonly BuildTarget[],
  host: StudioPlatform | null,
  gameBox: boolean,
  blocked: NativeRefusal | null,
): boolean {
  return blocked === null && playOnMacShown(targets, host) && playOnMacRefusal(targets, gameBox) === null;
}

/** Play on Mac's tooltip: this version cannot run it yet, or the game has no Mac build. */
export function playOnMacReason(refusal: TargetRefusal | null): string | null {
  if (refusal === null) return null;
  return refusal === TargetRefusal.NoGameBox
    ? DESTINATION_WORDS.refusal[refusal]
    : DESTINATION_WORDS.playOnMacUnavailable;
}
