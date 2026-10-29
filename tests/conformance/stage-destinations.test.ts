/**
 * A C++ · raylib game on the stage (`src/renderer/panels/stage/destinations.ts`): what each
 * destination's badge says on every host, which of the game's builds are running as
 * `build.progress` counts them, when a badge says Build failed (only Live's own build problem, never
 * a stopped build or a build Live did not ask for), what Live shows for a game without Browser,
 * and why Play on Mac cannot open. The strip and the card are `.tsx` the conformance runner cannot
 * load; `run-cpp-web-ui.mjs` drives them in the app.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BadgeFacts,
  BadgeState,
  destinationBadges,
  hasGameBox,
  LiveCard,
  liveBuildFailure,
  liveCard,
  liveCardWords,
  liveNeedsTools,
  laneRuns,
  NO_RUNS,
  nativeRunFailure,
  playOnMacReason,
  playOnMacRefusal,
  playOnMacShown,
  showsBuildBanner,
  type StagedGame,
  stagePhase,
  ToolsNeed,
  toolsNeeds,
} from "../../src/renderer/panels/stage/destinations.ts";
import {
  reconciledProblem,
  TroubleAction,
  troubleAction,
  troubleWords,
} from "../../src/renderer/panels/stage/build-trouble.ts";
import { liveRetryDue, sheetView } from "../../src/renderer/panels/toolchain-view.ts";
import { BUILD_PROBLEM_WORDS, DESTINATION_WORDS, NATIVE_WORDS } from "../../src/renderer/words.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { type BuildProblem, BuildPhase, BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import {
  BUILD_TARGETS,
  BuildTarget,
  GameStack,
  liveEmbedsStack,
  playsInOwnWindow,
  ProjectKind,
} from "../../src/shared/game-project.ts";
import { DestinationBadge, TargetRefusal } from "../../src/shared/game-targets.ts";
import {
  type DestinationCheck,
  NativeBackend,
  NativeRefusal,
  NativeRunMode,
  type NativeRunStatus,
  NativeRunState,
} from "../../src/shared/native-contract.ts";
import {
  PrewarmState,
  REQUIRED_COMPONENTS,
  ToolchainHost,
  type ToolchainInstallJob,
  ToolchainInstallPhase,
  type ToolchainStatus,
} from "../../src/shared/toolchain.ts";
import type { UiEventMap } from "../../src/shared/ui-events.ts";

const { Web, Mac, Windows, Linux, Ios } = BuildTarget;
const PROJECT = "pong-cpp";

/** One `build.progress` event, as the lane emits it for `project`. */
function progress(
  target: BuildTarget,
  phase: BuildPhase,
  project = PROJECT,
  purpose: CppBuildPurpose = CppBuildPurpose.Live,
): UiEventMap["build.progress"] {
  return { project, target, purpose, phase, at: 0 };
}

/** A build problem as the live folder's build writes it (`#reportBuild`). */
function problem(fields: Partial<BuildProblem> = {}): BuildProblem {
  return {
    project: PROJECT,
    command: "cmake --build",
    code: 1,
    lines: [],
    needsInstall: false,
    install: null,
    skippedScripts: null,
    showingLastBuild: false,
    at: "2026-10-01T00:00:00.000Z",
    reason: BuildProblemCode.CommandFailed,
    target: Web,
    ...fields,
  };
}

/** A raylib game built for `targets`. */
function raylib(targets: readonly BuildTarget[]) {
  return { shape: { kind: ProjectKind.RaylibCpp }, destinations: { stack: GameStack.RaylibCpp, targets } };
}

/** A Rust · wgpu game built for `targets`. */
function rust(targets: readonly BuildTarget[]) {
  return { shape: { kind: ProjectKind.RustWgpu }, destinations: { stack: GameStack.RustWgpu, targets } };
}

/** The badges of a game built for all four destinations, standing (nothing building, nothing failed). */
function standing(host: StudioPlatform | null, gameBox: boolean) {
  const badges = destinationBadges(BUILD_TARGETS, { host, gameBox, runs: NO_RUNS, failed: null });
  return Object.fromEntries(badges.map((badge) => [badge.target, { state: badge.state, why: badge.why }]));
}

/** A desktop destination with no build: this version builds the browser and Mac versions only. */
const NOT_BUILT = { state: BadgeState.NotBuilt, why: DESTINATION_WORDS.notBuiltWhy };
const IN_LIVE = { state: BadgeState.InLive, why: null };
const OWN_WINDOW = { state: BadgeState.OwnWindow, why: null };
const MAC_NEEDS_A_MAC = { state: BadgeState.MacBuildsNeedAMac, why: null };

describe("stage destination badges", () => {
  // Flipped (wave 1 said no host has a game box): the Seatbelt game profile is the Mac's game box.
  it("the Mac has a game box; Windows, Linux and an unknown host do not yet", () => {
    assert.equal(hasGameBox(StudioPlatform.Mac), true);
    for (const host of [StudioPlatform.Windows, StudioPlatform.Linux, null])
      assert.equal(hasGameBox(host), false, String(host));
  });

  it("on a Mac, the badges, Play on Mac and Live's card agree that a Mac game plays in its own window", () => {
    const host = StudioPlatform.Mac;
    const gameBox = hasGameBox(host);
    const [mac] = destinationBadges([Mac], { host, gameBox, runs: NO_RUNS, failed: null });
    assert.equal(mac?.state, BadgeState.OwnWindow);
    assert.equal(playOnMacShown([Mac], host), true);
    assert.equal(playOnMacRefusal([Mac], gameBox), null, "Play on Mac is enabled");
    assert.equal(playOnMacReason(playOnMacRefusal([Mac], gameBox)), null, "and needs no reason");
    assert.equal(liveCard(raylib([Mac]), host, gameBox), LiveCard.OwnWindow);
    assert.equal(liveCard(raylib([Web, Mac]), host, gameBox), null, "a game with Browser keeps Live's page");
  });

  it("on a Mac without a game box: Browser is in Live, and no desktop destination claims a build", () => {
    assert.deepEqual(standing(StudioPlatform.Mac, false), {
      [Web]: IN_LIVE,
      [Mac]: NOT_BUILT,
      [Windows]: NOT_BUILT,
      [Linux]: NOT_BUILT,
    });
  });

  it("on a Mac with a game box, the Mac build plays in its own window and the others claim no build", () => {
    assert.deepEqual(standing(StudioPlatform.Mac, true), {
      [Web]: IN_LIVE,
      [Mac]: OWN_WINDOW,
      [Windows]: NOT_BUILT,
      [Linux]: NOT_BUILT,
    });
  });

  it("off a Mac, the Mac build is refused outright, and the host's own OS plays only with its game box", () => {
    assert.deepEqual(standing(StudioPlatform.Linux, false), {
      [Web]: IN_LIVE,
      [Mac]: MAC_NEEDS_A_MAC,
      [Windows]: NOT_BUILT,
      [Linux]: NOT_BUILT,
    });
    assert.deepEqual(standing(StudioPlatform.Windows, true), {
      [Web]: IN_LIVE,
      [Mac]: MAC_NEEDS_A_MAC,
      [Windows]: OWN_WINDOW,
      [Linux]: NOT_BUILT,
    });
  });

  it("an unknown host promises no desktop build", () => {
    for (const gameBox of [false, true])
      assert.deepEqual(standing(null, gameBox), {
        [Web]: IN_LIVE,
        [Mac]: NOT_BUILT,
        [Windows]: NOT_BUILT,
        [Linux]: NOT_BUILT,
      });
  });

  it("a build Live could not start for want of tools says Needs tools, out loud, and is no failure", () => {
    const missing = problem({ reason: BuildProblemCode.ToolchainMissing });
    const [web] = destinationBadges([Web], {
      host: StudioPlatform.Mac,
      gameBox: false,
      runs: NO_RUNS,
      failed: liveBuildFailure(missing),
      needsTools: liveNeedsTools(missing),
    });
    assert.deepEqual([web?.state, web?.loud], [BadgeState.NeedsTools, true]);
    assert.equal(stagePhase(NO_RUNS, liveBuildFailure(missing)), null, "the strip does not say failed");
  });

  it("badges keep the game's own order and say which one they are", () => {
    const badges = destinationBadges([Linux, Web], {
      host: StudioPlatform.Mac,
      gameBox: false,
      runs: NO_RUNS,
      failed: null,
    });
    assert.deepEqual(
      badges.map((badge) => [badge.target, badge.label]),
      [
        [Linux, DESTINATION_WORDS.label[Linux]],
        [Web, DESTINATION_WORDS.label[Web]],
      ],
    );
  });

  it("a running build says Building and a failed one Build failed, both out loud; a new build outranks the last failure", () => {
    const badge = (runs: typeof NO_RUNS, failed: BuildTarget | null) => {
      const [web] = destinationBadges([Web], { host: StudioPlatform.Mac, gameBox: false, runs, failed });
      assert.ok(web);
      return { state: web.state, text: web.text, loud: web.loud };
    };
    const building = laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure), PROJECT);
    assert.deepEqual(badge(building, null), {
      state: BadgeState.Building,
      text: DESTINATION_WORDS.badge[DestinationBadge.Building],
      loud: true,
    });
    assert.deepEqual(badge(NO_RUNS, Web), {
      state: BadgeState.Failed,
      text: DESTINATION_WORDS.badge[DestinationBadge.Failed],
      loud: true,
    });
    assert.equal(badge(building, Web).state, BadgeState.Building);
    assert.deepEqual(badge(NO_RUNS, null), { state: BadgeState.InLive, text: "In Live", loud: false });
    assert.equal(badge(NO_RUNS, Mac).state, BadgeState.InLive, "another destination's failure is not this one's");
  });
});

describe("a destination's latest check", () => {
  const LOCK = "0123456789ab";
  const AT = "2026-10-01T00:00:00.000Z";
  /** A check as the lane records it in the library (`GameProject.nativeChecks`). */
  const checked = (badge: DestinationBadge, refusal?: NativeRefusal): DestinationCheck =>
    refusal ? { badge, lock: LOCK, at: AT, refusal } : { badge, lock: LOCK, at: AT };
  /** The badges of a game built for all four destinations, with `checks`, nothing building. */
  const withChecks = (
    host: StudioPlatform | null,
    gameBox: boolean,
    checks: StagedGame["nativeChecks"],
    facts: Partial<BadgeFacts> = {},
  ) =>
    Object.fromEntries(
      destinationBadges(BUILD_TARGETS, { host, gameBox, runs: NO_RUNS, failed: null, checks, ...facts }).map(
        (badge) => [badge.target, badge],
      ),
    );

  it("a Windows build checked on a Mac is Built, not run on this Mac, with why it was not run", () => {
    const badges = withChecks(StudioPlatform.Mac, true, { [Windows]: checked(DestinationBadge.NotRunHere) });
    assert.deepEqual(
      { state: badges[Windows]?.state, text: badges[Windows]?.text, why: badges[Windows]?.why },
      {
        state: BadgeState.NotRunHere,
        text: DESTINATION_WORDS.notRunHereOn(StudioPlatform.Mac),
        why: DESTINATION_WORDS.notRunHereWhy,
      },
    );
    assert.equal(badges[Windows]?.text, "Built, not run on this Mac");
    assert.equal(badges[Windows]?.loud, false, "a standing, said in the tooltip");
    assert.equal(badges[Linux]?.state, BadgeState.NotBuilt, "a check names only its own destination");
  });

  it("a Linux build the gate refused says Build failed, out loud, with the refusal's words", () => {
    const badges = withChecks(StudioPlatform.Mac, true, {
      [Linux]: checked(DestinationBadge.Failed, NativeRefusal.ImportsLibGl),
    });
    const linux = badges[Linux];
    assert.deepEqual(
      { state: linux?.state, text: linux?.text, why: linux?.why, loud: linux?.loud },
      {
        state: BadgeState.Failed,
        text: DESTINATION_WORDS.badge[DestinationBadge.Failed],
        why: NATIVE_WORDS.refusal[NativeRefusal.ImportsLibGl],
        loud: true,
      },
    );
    const plain = withChecks(StudioPlatform.Mac, true, { [Linux]: checked(DestinationBadge.Failed) });
    assert.deepEqual([plain[Linux]?.state, plain[Linux]?.why], [BadgeState.Failed, null], "no refusal, no reason");
  });

  it("missing build tools do not erase the latest cross-destination check", () => {
    const badges = withChecks(
      StudioPlatform.Mac,
      true,
      {
        [Windows]: checked(DestinationBadge.NotRunHere),
        [Linux]: checked(DestinationBadge.Failed, NativeRefusal.ImportsLibGl),
        [Mac]: checked(DestinationBadge.Built),
      },
      { tools: { [Windows]: ToolsNeed.Install, [Linux]: ToolsNeed.Install, [Mac]: ToolsNeed.Install } },
    );
    assert.equal(badges[Windows]?.state, BadgeState.NotRunHere);
    assert.equal(badges[Linux]?.state, BadgeState.Failed);
    assert.equal(badges[Linux]?.why, NATIVE_WORDS.refusal[NativeRefusal.ImportsLibGl]);
    assert.equal(badges[Mac]?.state, BadgeState.NeedsTools, "playing here still requires the local tools");
    const unchecked = withChecks(StudioPlatform.Mac, true, {}, { tools: { [Linux]: ToolsNeed.Install } });
    assert.equal(unchecked[Linux]?.state, BadgeState.NeedsTools);
  });

  it("no check is Not built yet, with the new reason", () => {
    for (const checks of [undefined, {}]) {
      const badges = withChecks(StudioPlatform.Mac, true, checks);
      for (const target of [Windows, Linux])
        assert.deepEqual(
          { state: badges[target]?.state, text: badges[target]?.text, why: badges[target]?.why },
          {
            state: BadgeState.NotBuilt,
            text: DESTINATION_WORDS.badge[DestinationBadge.NotBuilt],
            why: DESTINATION_WORDS.notBuiltWhy,
          },
          target,
        );
    }
  });

  it("a running build and Live's own failure outrank a check", () => {
    const checks = {
      [Windows]: checked(DestinationBadge.NotRunHere),
      [Linux]: checked(DestinationBadge.Failed, NativeRefusal.ImportsLibGl),
    };
    const building = laneRuns(NO_RUNS, progress(Linux, BuildPhase.Configure), PROJECT);
    const badges = withChecks(StudioPlatform.Mac, true, checks, { runs: building, failed: Windows });
    assert.deepEqual([badges[Linux]?.state, badges[Linux]?.why], [BadgeState.Building, null], "a new build");
    assert.deepEqual([badges[Windows]?.state, badges[Windows]?.why], [BadgeState.Failed, null]);
  });

  it("on a Linux computer with a game box, a Linux build checked Built plays in its own window", () => {
    const own = withChecks(StudioPlatform.Linux, true, { [Linux]: checked(DestinationBadge.Built) });
    assert.deepEqual({ state: own[Linux]?.state, why: own[Linux]?.why }, OWN_WINDOW);
    assert.deepEqual({ state: own[Mac]?.state, why: own[Mac]?.why }, MAC_NEEDS_A_MAC);
    const windows = withChecks(StudioPlatform.Linux, true, { [Windows]: checked(DestinationBadge.NotRunHere) });
    assert.equal(windows[Windows]?.text, DESTINATION_WORDS.notRunHereOn(StudioPlatform.Linux));
  });

  it("a build checked Built where this version has no game box yet says Built and why it does not run", () => {
    const badges = withChecks(StudioPlatform.Linux, false, { [Linux]: checked(DestinationBadge.Built) });
    assert.deepEqual(
      { state: badges[Linux]?.state, text: badges[Linux]?.text, why: badges[Linux]?.why },
      {
        state: BadgeState.Built,
        text: DESTINATION_WORDS.badge[DestinationBadge.Built],
        why: DESTINATION_WORDS.refusal[TargetRefusal.NoGameBox],
      },
    );
  });

  it("a badge the lane never records (building, not built) changes nothing; an unknown host names no computer", () => {
    for (const badge of [DestinationBadge.Building, DestinationBadge.NotBuilt]) {
      const badges = withChecks(StudioPlatform.Mac, true, { [Windows]: checked(badge) });
      assert.equal(badges[Windows]?.state, BadgeState.NotBuilt, badge);
    }
    const unknownHost = withChecks(null, false, { [Windows]: checked(DestinationBadge.NotRunHere) });
    assert.equal(unknownHost[Windows]?.text, DESTINATION_WORDS.badge[DestinationBadge.NotRunHere]);
  });
});

describe("the lane's running builds", () => {
  it("Configure starts a build and Done ends it; the strip says build while one runs", () => {
    const started = laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure), PROJECT);
    assert.equal(stagePhase(started, null), BuildPhase.Build);
    const compiling = laneRuns(started, progress(Web, BuildPhase.Build), PROJECT);
    assert.equal(compiling, started, "Build after its Configure is the same build: no redraw");
    const done = laneRuns(compiling, progress(Web, BuildPhase.Done), PROJECT);
    assert.equal(stagePhase(done, null), null);
  });

  it("a judging or an export build of the game on the stage is not Live's: nothing shows Building", () => {
    for (const purpose of [CppBuildPurpose.Judging, CppBuildPurpose.Export]) {
      const judged = laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure, PROJECT, purpose), PROJECT);
      assert.equal(judged, NO_RUNS, purpose);
      assert.equal(stagePhase(judged, null), null, purpose);
    }
    const live = laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure), PROJECT);
    const judgedEnd = laneRuns(live, progress(Web, BuildPhase.Done, PROJECT, CppBuildPurpose.Judging), PROJECT);
    assert.equal(stagePhase(judgedEnd, null), BuildPhase.Build, "a judging build's end does not end Live's");
  });

  it("another game's events, and a printed line, change nothing", () => {
    assert.equal(laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure, "other"), PROJECT), NO_RUNS);
    const running = laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure), PROJECT);
    assert.equal(
      laneRuns(running, { ...progress(Web, BuildPhase.Configure), line: "-- Configuring done" }, PROJECT),
      running,
    );
    assert.equal(
      laneRuns(running, { ...progress(Web, BuildPhase.Done), line: "ninja: no work to do." }, PROJECT),
      running,
    );
  });

  it("a strip that opened mid-build counts the build it sees compiling, once", () => {
    const seen = laneRuns(NO_RUNS, progress(Mac, BuildPhase.Build), PROJECT);
    assert.equal(stagePhase(seen, null), BuildPhase.Build);
    assert.equal(stagePhase(laneRuns(seen, progress(Mac, BuildPhase.Done), PROJECT), null), null);
  });

  it("an end with no build running (a refusal before Configure, or one the strip never saw start) leaves the runs as they were", () => {
    assert.equal(laneRuns(NO_RUNS, progress(Web, BuildPhase.Failed), PROJECT), NO_RUNS);
    assert.equal(laneRuns(NO_RUNS, progress(Web, BuildPhase.Done), PROJECT), NO_RUNS);
  });

  it("an older build's Failed arriving after a newer build's Configure keeps the badge Building", () => {
    let runs = laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure), PROJECT);
    runs = laneRuns(runs, progress(Web, BuildPhase.Configure), PROJECT);
    runs = laneRuns(runs, progress(Web, BuildPhase.Failed), PROJECT);
    const [web] = destinationBadges([Web], { host: StudioPlatform.Mac, gameBox: false, runs, failed: null });
    assert.equal(web?.state, BadgeState.Building);
    runs = laneRuns(runs, progress(Web, BuildPhase.Done), PROJECT);
    assert.equal(stagePhase(runs, null), null);
  });

  it("a Failed from a build Live did not ask for (a judging build in a worktree) never makes a badge say Build failed", () => {
    let runs = laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure), PROJECT);
    runs = laneRuns(runs, progress(Web, BuildPhase.Failed), PROJECT);
    // A worktree's build problem belongs to its run: the live folder's problem stays null.
    const [web] = destinationBadges([Web], {
      host: StudioPlatform.Mac,
      gameBox: false,
      runs,
      failed: liveBuildFailure(null),
    });
    assert.equal(web?.state, BadgeState.InLive);
    assert.equal(stagePhase(runs, liveBuildFailure(null)), null);
  });
});

describe("Live's own build failure", () => {
  it("names the destination Live's build failed for", () => {
    assert.equal(liveBuildFailure(problem()), Web);
    assert.equal(liveBuildFailure(problem({ reason: BuildProblemCode.TimedOut })), Web);
    assert.equal(liveBuildFailure(problem({ reason: undefined })), Web, "a problem from before reasons is a failure");
    assert.equal(stagePhase(NO_RUNS, Web), BuildPhase.Failed);
  });

  it("a stopped build (composer Stop, a newer build) is not a failure, and the badge stays as it stood", () => {
    const cancelled = liveBuildFailure(problem({ reason: BuildProblemCode.Cancelled }));
    assert.equal(cancelled, null);
    const [web] = destinationBadges([Web], {
      host: StudioPlatform.Mac,
      gameBox: false,
      runs: NO_RUNS,
      failed: cancelled,
    });
    assert.equal(web?.state, BadgeState.InLive);
  });

  it("tools set up by an older Genex need tools too, and a part with no download yet is no failure", () => {
    const stale = problem({ reason: BuildProblemCode.ToolchainStale, target: Mac });
    assert.deepEqual([liveBuildFailure(stale), liveNeedsTools(stale)], [null, Mac]);
    const notHosted = problem({ reason: BuildProblemCode.ToolchainNotHosted, target: Mac });
    assert.equal(liveBuildFailure(notHosted), null);
  });

  it("a build that never ran for want of tools, or on a computer that builds no C++ game yet, is no failure", () => {
    const missing = problem({ reason: BuildProblemCode.ToolchainMissing, target: Mac });
    assert.equal(liveBuildFailure(missing), null);
    assert.equal(liveNeedsTools(missing), Mac);
    const unsupported = problem({ reason: BuildProblemCode.UnsupportedHost });
    assert.equal(liveBuildFailure(unsupported), null);
    assert.equal(liveNeedsTools(unsupported), null, "installing tools would not help there");
    assert.equal(liveNeedsTools(problem()), null);
  });

  it("Live declining to build a page for a game without Browser is not a failure; no problem, or none with a target, names nothing", () => {
    assert.equal(liveBuildFailure(problem({ reason: BuildProblemCode.NotADestination })), null);
    assert.equal(liveBuildFailure(null), null);
    assert.equal(liveBuildFailure(problem({ target: undefined })), null);
  });
});

describe("Live for a game without Browser", () => {
  it("a Three.js game, a raylib game with Browser, and no game at all show Live as ever", () => {
    assert.equal(liveCard(null, StudioPlatform.Mac, false), null);
    assert.equal(liveCard({ shape: { kind: ProjectKind.StudioTemplate } }, StudioPlatform.Mac, false), null);
    assert.equal(liveCard(raylib([Web, Mac]), StudioPlatform.Mac, true), null);
    assert.equal(
      liveCard({ shape: { kind: ProjectKind.RaylibCpp } }, StudioPlatform.Mac, false),
      null,
      "no destinations recorded means Browser",
    );
  });

  it("says its own window only when one of its destinations runs on this host", () => {
    assert.equal(liveCard(raylib([Mac]), StudioPlatform.Mac, true), LiveCard.OwnWindow);
    assert.equal(liveCard(raylib([Linux]), StudioPlatform.Linux, true), LiveCard.OwnWindow);
    assert.equal(liveCard(raylib([Mac, Windows]), StudioPlatform.Mac, true), LiveCard.OwnWindow);
  });

  it("otherwise says why it does not run on this computer: no game box yet, a cross-build, a Mac game off a Mac, an unknown host", () => {
    assert.equal(liveCard(raylib([Mac]), StudioPlatform.Mac, false), LiveCard.NoGameBox);
    assert.equal(liveCard(raylib([Windows, Linux]), StudioPlatform.Mac, true), LiveCard.NotRunHere);
    assert.equal(liveCard(raylib([Mac]), StudioPlatform.Linux, true), LiveCard.NotRunHere);
    assert.equal(liveCard(raylib([Mac, Linux]), StudioPlatform.Windows, true), LiveCard.NotRunHere);
    assert.equal(liveCard(raylib([Mac]), null, true), LiveCard.NotRunHere);
  });

  it("the own-window card is the shared words; the others never promise a window, nor claim builds", () => {
    assert.deepEqual(liveCardWords(LiveCard.OwnWindow), DESTINATION_WORDS.liveStatusCard);
    for (const card of [LiveCard.NoGameBox, LiveCard.NotRunHere]) {
      const other = liveCardWords(card);
      assert.notDeepEqual(other, DESTINATION_WORDS.liveStatusCard);
      assert.doesNotMatch(`${other.title} ${other.body}`, /own window|its builds/i, card);
    }
    assert.equal(
      liveCardWords(LiveCard.NoGameBox).body,
      DESTINATION_WORDS.refusal[TargetRefusal.NoGameBox],
      "the card gives the reason the Mac badge's game box gives",
    );
  });

  it("Live embeds every compiled stack's Mac build; only raylib's plays in its own window", () => {
    assert.equal(liveEmbedsStack(GameStack.RaylibCpp), true);
    assert.equal(liveEmbedsStack(GameStack.RustWgpu), true);
    assert.equal(liveEmbedsStack(GameStack.ThreeJs), false);
    assert.equal(playsInOwnWindow(GameStack.RaylibCpp), true);
    assert.equal(playsInOwnWindow(GameStack.RustWgpu), false, "its studio mode serves headless: no window would show");
    assert.equal(playsInOwnWindow(GameStack.ThreeJs), false);
  });

  // Flipped (FIX-LIVE): liveCard answered null for every Rust game, so a Mac-only Rust game left
  // Live blank with no card; it now says Live shows its Mac build, and never promises a window.
  it("a Mac-only Rust game on a Mac with a game box plays its Mac build in Live, never in its own window", () => {
    assert.equal(liveCard(rust([Mac]), StudioPlatform.Mac, true), LiveCard.MacInLive);
    assert.equal(liveCard(rust([Mac, Ios]), StudioPlatform.Mac, true), LiveCard.MacInLive);
    assert.equal(liveCard(rust([Web, Mac]), StudioPlatform.Mac, true), null, "a game with Browser keeps Live's page");
    assert.equal(liveCard(rust([Mac]), StudioPlatform.Mac, false), LiveCard.NoGameBox);
    assert.equal(liveCard(rust([Mac]), StudioPlatform.Windows, true), LiveCard.NotRunHere);
    assert.equal(
      liveCard(rust([Windows]), StudioPlatform.Windows, true),
      LiveCard.NotRunHere,
      "no Rust run off the Mac",
    );
    const words = liveCardWords(LiveCard.MacInLive);
    assert.deepEqual(words, DESTINATION_WORDS.liveMacCard);
    assert.doesNotMatch(`${words.title} ${words.body}`, /own window/i);
    assert.deepEqual(liveCardWords(LiveCard.MacInLive, { windowShown: true }), words);
  });

  it("beside the native run card, Live's own-window card keeps its title and stops telling the person to play it there", () => {
    const beside = liveCardWords(LiveCard.OwnWindow, { windowShown: true });
    assert.deepEqual(beside, { title: DESTINATION_WORDS.liveStatusCard.title, body: null });
    assert.deepEqual(liveCardWords(LiveCard.OwnWindow, { windowShown: false }), DESTINATION_WORDS.liveStatusCard);
    for (const card of [LiveCard.NoGameBox, LiveCard.NotRunHere])
      assert.deepEqual(liveCardWords(card, { windowShown: true }), liveCardWords(card), card);
  });

  it("Live's expected not-a-destination is no banner while the card says where the game stands; real trouble still is", () => {
    const notADestination = problem({ reason: BuildProblemCode.NotADestination });
    assert.equal(showsBuildBanner(notADestination, LiveCard.NotRunHere), false);
    assert.equal(showsBuildBanner(notADestination, LiveCard.OwnWindow), false);
    assert.equal(showsBuildBanner(notADestination, null), true);
    assert.equal(showsBuildBanner(problem(), LiveCard.NotRunHere), true);
    assert.equal(showsBuildBanner(null, null), false);
  });

  it("while Live shows the Mac build (Native), the browser page's failed build is no banner over it; a Mac one still is", () => {
    const webFailed = problem({ reason: BuildProblemCode.CommandFailed, target: Web });
    const pageFailed = problem({ reason: BuildProblemCode.CommandFailed, target: undefined });
    const macFailed = problem({ reason: BuildProblemCode.CommandFailed, target: Mac });
    assert.equal(showsBuildBanner(webFailed, null, NO_RUNS, { native: true }), false, "Browser's build, Native shown");
    assert.equal(
      showsBuildBanner(pageFailed, null, NO_RUNS, { native: true }),
      false,
      "the page's build, Native shown",
    );
    assert.equal(showsBuildBanner(macFailed, null, NO_RUNS, { native: true }), true, "the Mac build Native shows");
    assert.equal(showsBuildBanner(webFailed, null, NO_RUNS, { native: false }), true, "Web shown");
    assert.equal(showsBuildBanner(webFailed, null, NO_RUNS), true, "Web is the default view");
  });
});

describe("Play on Mac", () => {
  it("shows only on a Mac, for a game with Mac among its destinations", () => {
    assert.equal(playOnMacShown([Web, Mac], StudioPlatform.Mac), true);
    assert.equal(playOnMacShown([Web], StudioPlatform.Mac), false, "a Browser-only game never plays on a Mac");
    assert.equal(playOnMacShown([Web, Mac], StudioPlatform.Linux), false);
    assert.equal(playOnMacShown([Mac], null), false);
  });

  // Flipped (wave 1 said no host has a game box, so a Mac game was refused no-game-box on a Mac).
  it("a game without Mac is not a destination; with Mac it opens wherever there is a game box, as on a Mac", () => {
    assert.equal(playOnMacRefusal([Web], false), TargetRefusal.NotADestination);
    assert.equal(playOnMacRefusal([Web, Windows], true), TargetRefusal.NotADestination);
    assert.equal(playOnMacRefusal([Web, Mac], false), TargetRefusal.NoGameBox);
    assert.equal(playOnMacRefusal([Mac], hasGameBox(StudioPlatform.Mac)), null);
    assert.equal(playOnMacRefusal([Mac], true), null);
  });

  it("its reason says which: this version cannot run it yet, or the game has no Mac build", () => {
    assert.equal(playOnMacReason(TargetRefusal.NoGameBox), DESTINATION_WORDS.refusal[TargetRefusal.NoGameBox]);
    assert.equal(playOnMacReason(TargetRefusal.NotADestination), DESTINATION_WORDS.playOnMacUnavailable);
    assert.doesNotMatch(DESTINATION_WORDS.playOnMacUnavailable, /needs a Mac/, "it shows on a Mac only");
    assert.equal(playOnMacReason(null), null);
  });
});

/** The store with Browser's and the Mac's tools installed and locked, each destination's prewarm as given. */
function toolchain(
  prewarm: ToolchainStatus["prewarm"],
  installed: readonly BuildTarget[] = [Web, Mac],
): ToolchainStatus {
  const ids = [...new Set(installed.flatMap((target) => REQUIRED_COMPONENTS[target]))];
  return {
    host: ToolchainHost.MacArm64,
    clt: { present: true, version: "26.6" },
    installed: ids.map((id) => ({ id, version: "1", sha12: "abcdefabcdef", bytes: 1 })),
    lock: {
      version: 1,
      entries: Object.fromEntries(ids.map((id) => [id, { version: "1", sha12: "abcdefabcdef" }])),
      digest: "d",
    },
    job: null,
    storeBytes: 0,
    downloads: [],
    prewarm,
  };
}

/** The person's Mac window run of pong-cpp, refused because its Mac build failed for `reason`. */
function macRefused(reason: BuildProblemCode): NativeRunStatus {
  return {
    project: PROJECT,
    runId: "",
    target: Mac,
    state: NativeRunState.Refused,
    mode: NativeRunMode.Window,
    pid: null,
    backend: NativeBackend.MetalAngle,
    refusal: NativeRefusal.BuildFailed,
    problem: problem({ reason, target: Mac, showingLastBuild: true }),
    exit: null,
    owner: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: null,
  };
}

describe("tools installed but not set up (ACC-01)", () => {
  const unprepared = problem({ reason: BuildProblemCode.ToolchainUnprepared });
  const notPrepared = toolchain({ [Web]: PrewarmState.Missing, [Mac]: PrewarmState.Missing });

  it("toolchain-unprepared reads as needs set-up on the card, the strip and the Mac chip", () => {
    // The card above Live: the sentence the sheet says, and its Set up, never "aren't installed".
    assert.equal(troubleAction(unprepared), TroubleAction.FinishSetUp);
    assert.equal(troubleWords(unprepared), BUILD_PROBLEM_WORDS[BuildProblemCode.ToolchainUnprepared]);
    assert.doesNotMatch(troubleWords(unprepared), /aren’t installed/);
    assert.equal(liveBuildFailure(unprepared), null, "nothing failed: nothing was built");
    // The strip: Browser and the Mac both need set-up; the Mac never claims its own window meanwhile.
    const tools = toolsNeeds([Web, Mac], { problems: [unprepared], status: notPrepared });
    assert.deepEqual(tools, { [Web]: ToolsNeed.SetUp, [Mac]: ToolsNeed.SetUp });
    const badges = destinationBadges([Web, Mac], {
      host: StudioPlatform.Mac,
      gameBox: true,
      runs: NO_RUNS,
      failed: liveBuildFailure(unprepared),
      tools,
    });
    assert.deepEqual(
      badges.map((badge) => [badge.target, badge.state, badge.loud]),
      [
        [Web, BadgeState.NeedsSetUp, true],
        [Mac, BadgeState.NeedsSetUp, true],
      ],
    );
    assert.ok(
      badges.every((badge) => !/own window|Needs tools/.test(badge.text)),
      JSON.stringify(badges),
    );
  });

  it("the Mac chip reads the Mac's own prewarm even when Live's build says nothing about the Mac", () => {
    const macOnly = toolchain({ [Web]: PrewarmState.Ready, [Mac]: PrewarmState.Stale });
    assert.deepEqual(toolsNeeds([Web, Mac], { problems: [null], status: macOnly }), { [Mac]: ToolsNeed.SetUp });
    assert.deepEqual(
      toolsNeeds([Web, Mac], {
        problems: [],
        status: toolchain({ [Web]: PrewarmState.Ready, [Mac]: PrewarmState.Ready }),
      }),
      {},
    );
    assert.deepEqual(toolsNeeds([Web, Mac], { problems: [], status: null }), {}, "not read yet: the standing words");
    // A Mac component still missing needs tools (the sheet says whether it has a download yet).
    const noAngle = toolchain({ [Web]: PrewarmState.Ready, [Mac]: PrewarmState.Missing }, [Web]);
    assert.deepEqual(toolsNeeds([Web, Mac], { problems: [], status: noAngle }), { [Mac]: ToolsNeed.Install });
    const notBuiltHere = toolchain({ [Web]: PrewarmState.Ready, [Mac]: PrewarmState.Ready });
    assert.deepEqual(
      toolsNeeds([Web, Mac, Windows], { problems: [], status: notBuiltHere }),
      {},
      "a destination this computer does not build (no prewarm named) keeps its own words",
    );
    const missing = problem({ reason: BuildProblemCode.ToolchainMissing, target: Mac });
    assert.deepEqual(toolsNeeds([Web, Mac], { problems: [missing], status: null }), { [Mac]: ToolsNeed.Install });
    const allReady = toolchain({ [Web]: PrewarmState.Ready, [Mac]: PrewarmState.Ready });
    assert.deepEqual(
      toolsNeeds([Web, Mac], { problems: [missing], status: allReady }),
      {},
      "a problem older than the install that fixed it",
    );
    const noLock = { ...allReady, lock: null, prewarm: undefined };
    assert.deepEqual(
      toolsNeeds([Web, Mac], { problems: [missing], status: noLock }),
      { [Mac]: ToolsNeed.Install },
      "where the store has no word (no lock yet), the build problem's word stands",
    );
    const [, mac] = destinationBadges([Web, Mac], {
      host: StudioPlatform.Mac,
      gameBox: true,
      runs: NO_RUNS,
      failed: null,
      tools: { [Mac]: ToolsNeed.Install },
    });
    assert.equal(mac?.state, BadgeState.NeedsTools);
  });

  it("a lane that still says not installed, while the store has every tool and only the set-up is missing, reads as set-up", () => {
    const saidMissing = problem({ reason: BuildProblemCode.ToolchainMissing });
    const reconciled = reconciledProblem(saidMissing, notPrepared);
    assert.equal(reconciled.reason, BuildProblemCode.ToolchainUnprepared);
    assert.equal(troubleAction(reconciled), TroubleAction.FinishSetUp);
    const stale = reconciledProblem(saidMissing, toolchain({ [Web]: PrewarmState.Stale }));
    assert.equal(stale.reason, BuildProblemCode.ToolchainStale);
    const reallyMissing = reconciledProblem(saidMissing, toolchain({ [Mac]: PrewarmState.Ready }, [Mac]));
    assert.equal(reallyMissing, saidMissing, "a tool really missing stays Install tools");
    assert.equal(reconciledProblem(saidMissing, null), saidMissing, "the store not read yet: the lane's word");
    const compile = problem();
    assert.equal(reconciledProblem(compile, notPrepared), compile, "a compile error is never a tools problem");
  });
});

describe("Live once the Toolchain sheet is ready (ACC-02)", () => {
  const settingUp = toolchain({ [Web]: PrewarmState.Missing, [Mac]: PrewarmState.Missing });
  const ready = toolchain({ [Web]: PrewarmState.Ready, [Mac]: PrewarmState.Ready });

  it("builds again the moment the sheet reaches Ready, once, without waiting for the sheet to close", () => {
    const running: ToolchainInstallJob = {
      phase: ToolchainInstallPhase.Prewarming,
      entry: null,
      completed: 0,
      total: 0,
      startedAt: "2026-10-01T00:00:00.000Z",
    };
    assert.equal(liveRetryDue(sheetView(settingUp, null, [Web, Mac]), false), false, "not set up yet");
    assert.equal(liveRetryDue(sheetView(settingUp, running, [Web, Mac]), false), false, "still setting up");
    assert.equal(liveRetryDue(sheetView(ready, null, [Web, Mac]), false), true, "ready: build now");
    assert.equal(liveRetryDue(sheetView(ready, null, [Web, Mac]), true), false, "once per opening of the sheet");
    assert.equal(liveRetryDue(sheetView(null, null, [Web, Mac]), false), false, "status not read yet");
  });

  it("while Live builds again, the stale tools card is not shown; a compile error still is", () => {
    const building = laneRuns(NO_RUNS, progress(Web, BuildPhase.Configure), PROJECT);
    for (const reason of [
      BuildProblemCode.ToolchainMissing,
      BuildProblemCode.ToolchainStale,
      BuildProblemCode.ToolchainUnprepared,
    ]) {
      const stale = problem({ reason });
      assert.equal(showsBuildBanner(stale, null, NO_RUNS), true, `${reason}: shown while nothing builds`);
      assert.equal(showsBuildBanner(stale, null, building), false, `${reason}: hidden while Browser builds`);
    }
    const macBuilding = laneRuns(NO_RUNS, progress(Mac, BuildPhase.Configure), PROJECT);
    assert.equal(
      showsBuildBanner(problem({ reason: BuildProblemCode.ToolchainMissing }), null, macBuilding),
      true,
      "another destination's build says nothing about Browser's tools",
    );
    assert.equal(
      showsBuildBanner(problem(), null, building),
      true,
      "the last compile error stays until the build ends",
    );
  });
});

describe("the Mac chip when a Mac build failed (ACC-04)", () => {
  it("a failed Mac build marks the Mac chip failed, out loud; a tools refusal asks for tools, and nothing else is a failure", () => {
    assert.equal(nativeRunFailure(macRefused(BuildProblemCode.CommandFailed)), Mac);
    const [, mac] = destinationBadges([Web, Mac], {
      host: StudioPlatform.Mac,
      gameBox: true,
      runs: NO_RUNS,
      failed: null,
      runFailed: nativeRunFailure(macRefused(BuildProblemCode.CommandFailed)),
    });
    assert.deepEqual([mac?.state, mac?.loud], [BadgeState.Failed, true]);
    for (const reason of [
      BuildProblemCode.ToolchainMissing,
      BuildProblemCode.ToolchainStale,
      BuildProblemCode.ToolchainUnprepared,
      BuildProblemCode.Cancelled,
    ])
      assert.equal(nativeRunFailure(macRefused(reason)), null, reason);
    assert.deepEqual(
      toolsNeeds([Web, Mac], { problems: [macRefused(BuildProblemCode.ToolchainUnprepared).problem], status: null }),
      { [Mac]: ToolsNeed.SetUp },
    );
    assert.equal(nativeRunFailure(null), null);
    const running = {
      ...macRefused(BuildProblemCode.CommandFailed),
      state: NativeRunState.Ready,
      refusal: null,
      problem: null,
    };
    assert.equal(nativeRunFailure(running), null);
  });
});
