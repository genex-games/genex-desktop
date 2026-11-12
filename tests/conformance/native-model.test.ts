/**
 * What Play draws for a native game, from the catalog, this computer's installs and the games being
 * played: the game page's one primary block and its card's badge. A game being played wins over
 * everything; an install under way over a failure; a failure over what is installed; and what is
 * installed against the catalog's build decides between Install, Play, Update and Elsewhere.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CardBadge,
  cardBadge,
  GamePhase,
  gameStanding,
  InstallLine,
  installLine,
  installPercent,
  opensPage,
  WebPlay,
  webPlayOn,
} from "../../src/renderer/play/native-model.ts";
import {
  type InstalledGame,
  InstallFailure,
  InstallPhase,
  type InstallProgress,
  LaunchFailure,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  type NativeInstalls,
  NativePlatform,
  type NativeSession,
  NativeSessionPhase,
  WhyNotHere,
  type ZipBuild,
} from "../../src/shared/play-native.ts";
import { NATIVE_WORDS, nativeHereWords, notHereWords } from "../../src/renderer/words.ts";

const HOST: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "15.0" };

const build = (overrides: Partial<ZipBuild> = {}): ZipBuild => ({
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  version: "1.3",
  sizeBytes: 1_200,
  installedBytes: 1_400,
  sha256: "a".repeat(64),
  url: "https://builds.genex.invalid/dust-runners/1.3/mac.zip",
  entry: "Dust Runners.app",
  publishedAt: "2026-10-18T00:00:00.000Z",
  ...overrides,
});

const game = (builds: NativeBuild[] = [build()], web = false) => ({
  slug: "dust-runners",
  native: { web, engine: "unity", builds },
});

const installed = (version = "1.3"): InstalledGame => ({
  slug: "dust-runners",
  title: "Dust Runners",
  coverUrl: null,
  version,
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  bytes: 1_400,
  installedAt: "2026-10-19T00:00:00.000Z",
  lastPlayedAt: null,
});

const progress = (phase: InstallProgress["phase"], overrides: Partial<InstallProgress> = {}): InstallProgress => ({
  slug: "dust-runners",
  version: "1.3",
  phase,
  receivedBytes: 456,
  totalBytes: 1_200,
  bytesPerSecond: 38 * 1024 ** 2,
  etaMs: 120_000,
  failure: null,
  ...overrides,
});

const session = (phase: NativeSession["phase"], failure: NativeSession["failure"] = null): NativeSession => ({
  slug: "dust-runners",
  phase,
  startedAt: "2026-10-20T00:00:00.000Z",
  failure,
});

const installs = (parts: Partial<NativeInstalls> = {}): NativeInstalls => ({
  installed: [],
  progress: [],
  host: HOST,
  ...parts,
});

describe("a native game's page", () => {
  it("offers Install, then Play once installed, and Update when the catalog has a newer build", () => {
    assert.equal(gameStanding(game(), installs(), []).phase, GamePhase.Install);
    assert.equal(gameStanding(game(), installs({ installed: [installed()] }), []).phase, GamePhase.Ready);
    const behind = gameStanding(game(), installs({ installed: [installed("1.2")] }), []);
    assert.equal(behind.phase, GamePhase.Update);
    assert.equal(behind.installed?.version, "1.2");
    assert.equal(behind.build?.version, "1.3");
  });

  it("shows an install under way, and a failed one with its reason until it is tried again", () => {
    for (const phase of [InstallPhase.Queued, InstallPhase.Downloading, InstallPhase.Verifying, InstallPhase.Unpacking])
      assert.equal(gameStanding(game(), installs({ progress: [progress(phase)] }), []).phase, GamePhase.Installing);
    const failed = gameStanding(
      game(),
      installs({ progress: [progress(InstallPhase.Failed, { failure: InstallFailure.NoSpace })] }),
      [],
    );
    assert.equal(failed.phase, GamePhase.Failed);
    assert.deepEqual(failed.failure, { install: InstallFailure.NoSpace });
  });

  it("shows a game being played over anything else, and one that failed to start as a failure", () => {
    const playing = installs({ installed: [installed("1.2")], progress: [progress(InstallPhase.Downloading)] });
    assert.equal(gameStanding(game(), playing, [session(NativeSessionPhase.Starting)]).phase, GamePhase.Playing);
    assert.equal(gameStanding(game(), playing, [session(NativeSessionPhase.Running)]).phase, GamePhase.Playing);
    const quit = gameStanding(game(), installs({ installed: [installed()] }), [
      session(NativeSessionPhase.Failed, LaunchFailure.QuitEarly),
    ]);
    assert.equal(quit.phase, GamePhase.Failed);
    assert.deepEqual(quit.failure, { launch: LaunchFailure.QuitEarly });
  });

  it("says where it plays instead when this computer has no build, and plays what is installed anyway", () => {
    const windowsOnly = game([build({ platform: NativePlatform.Windows, arch: NativeArch.X64, entry: "Dust.exe" })]);
    assert.equal(gameStanding(windowsOnly, installs(), []).phase, GamePhase.Elsewhere);
    assert.equal(gameStanding(game(), installs({ host: null }), []).phase, GamePhase.Elsewhere, "no native games here");
    assert.equal(gameStanding(windowsOnly, installs({ installed: [installed()] }), []).phase, GamePhase.Ready);
    assert.deepEqual(gameStanding(windowsOnly, installs(), []).notHere, { why: WhyNotHere.NoBuild });
    assert.equal(gameStanding(game(), installs(), []).notHere, null, "it installs here");
    assert.equal(gameStanding(game(), installs({ host: null }), []).notHere, null, "nothing to say before main has");
  });

  it("offers a Windows PC its own build to install, beside a Mac one", () => {
    const windows = installs({
      host: { platform: NativePlatform.Windows, arch: NativeArch.X64, osVersion: "10.0.26100" },
    });
    const windowsBuild = build({ platform: NativePlatform.Windows, arch: NativeArch.X64, entry: "Dust.exe" });
    const standing = gameStanding(game([build(), windowsBuild]), windows, []);
    assert.equal(standing.build, windowsBuild);
    assert.equal(standing.phase, GamePhase.Install);
    assert.equal(standing.notHere, null);
  });

  it("says plainly why it can't install here, in place of Install", () => {
    const WINDOWS = NativePlatform.Windows;
    const MAC = NativePlatform.Mac;
    const LINUX = NativePlatform.Linux;
    assert.deepEqual(notHereWords({ why: WhyNotHere.System, elsewhere: [MAC] }, [MAC, WINDOWS], WINDOWS), {
      title: "Can’t play on Windows",
      line: "Genex can only run it on Mac.",
    });
    assert.deepEqual(notHereWords({ why: WhyNotHere.System, elsewhere: [] }, [WINDOWS], WINDOWS), {
      title: "Can’t play on Windows",
      line: "Genex can’t run downloaded games on Windows.",
    });
    assert.deepEqual(notHereWords({ why: WhyNotHere.NoBuild }, [WINDOWS], MAC), {
      title: "Only on Windows",
      line: "There’s no Mac version of this game yet.",
    });
    assert.deepEqual(notHereWords({ why: WhyNotHere.OldSystem, minOs: "15.4" }, [MAC], MAC), {
      title: "Not for this Mac",
      line: "It needs macOS 15.4 or later.",
    });
    assert.equal(notHereWords({ why: WhyNotHere.AppleSilicon }, [MAC], MAC).line, "It needs a Mac with Apple silicon.");
    assert.equal(notHereWords({ why: WhyNotHere.Rosetta }, [MAC], MAC).line, "It needs Rosetta to run on this Mac.");
    assert.deepEqual(notHereWords({ why: WhyNotHere.Processor }, [LINUX], LINUX), {
      title: "Not for this computer",
      line: "It’s made for a different processor.",
    });
  });

  it("opens its page for a game with an app to install, with a web build too or not; a web game plays at once", () => {
    assert.equal(opensPage(game()), true);
    assert.equal(opensPage(game([build()], true)), true, "its page offers the browser and the app");
    assert.equal(opensPage(game([], false)), true, "no web build: the page says where it stands");
    assert.equal(opensPage(game([], true)), false);
    assert.equal(opensPage({}), false);
  });

  it("offers a game's web build beside its app: first while the app isn't installed, second once it is", () => {
    const both = game([build()], true);
    const on = (parts: Partial<NativeInstalls> = {}, sessions: NativeSession[] = []) =>
      webPlayOn(both, gameStanding(both, installs(parts), sessions));
    assert.equal(on(), WebPlay.First);
    assert.equal(on({ installed: [installed()] }), WebPlay.Second);
    // No app for this computer: the browser is the one way to play.
    const windowsOnly = game([build({ platform: NativePlatform.Windows, arch: NativeArch.X64 })], true);
    assert.equal(webPlayOn(windowsOnly, gameStanding(windowsOnly, installs(), [])), WebPlay.Only);
    // While the app is on its way, running, out of date or failed, the block is the app's alone.
    assert.equal(on({ progress: [progress(InstallPhase.Downloading)] }), WebPlay.None);
    assert.equal(on({ installed: [installed("1.2")] }), WebPlay.None);
    assert.equal(on({ installed: [installed()] }, [session(NativeSessionPhase.Running)]), WebPlay.None);
    assert.equal(on({ progress: [progress(InstallPhase.Failed, { failure: InstallFailure.NoSpace })] }), WebPlay.None);
    // A game with no web build has nothing to play in a browser.
    const appOnly = game();
    assert.equal(webPlayOn(appOnly, gameStanding(appOnly, installs(), [])), WebPlay.None);
  });
});

describe("a native game's card", () => {
  it("shows its systems' marks while not installed, nothing new for a web game", () => {
    const both = game([build(), build({ platform: NativePlatform.Windows, arch: NativeArch.X64, entry: "Dust.exe" })]);
    assert.deepEqual(cardBadge(both, installs()), {
      kind: CardBadge.Platforms,
      platforms: [NativePlatform.Mac, NativePlatform.Windows],
    });
    assert.equal(cardBadge(game([build()], true), installs()), null);
    assert.equal(cardBadge({ slug: "lost-cathedral" }, installs()), null);
  });

  it("shows a download's progress and time left, On this Mac once installed, and an update's size", () => {
    assert.deepEqual(cardBadge(game(), installs({ progress: [progress(InstallPhase.Downloading)] })), {
      kind: CardBadge.Downloading,
      percent: 38,
      etaMs: 120_000,
    });
    assert.deepEqual(cardBadge(game(), installs({ installed: [installed()] })), {
      kind: CardBadge.Installed,
      platform: NativePlatform.Mac,
    });
    assert.deepEqual(cardBadge(game(), installs({ installed: [installed("1.2")] })), {
      kind: CardBadge.Update,
      bytes: 1_200,
    });
    assert.deepEqual(
      cardBadge(game([build()], true), installs({ installed: [installed()] })),
      { kind: CardBadge.Installed, platform: NativePlatform.Mac },
      "a web game's Mac app installed here says so",
    );
  });

  it("names this Mac on a Mac, and this computer on Linux", () => {
    const linux = installs({ host: { platform: NativePlatform.Linux, arch: NativeArch.X64, osVersion: "6.8.0" } });
    assert.equal(gameStanding(game(), installs(), []).here, NativePlatform.Mac);
    assert.equal(gameStanding(game(), linux, []).here, NativePlatform.Linux);
    for (const platform of ["", "darwin", NativePlatform.Mac])
      assert.equal(nativeHereWords(platform).installedHere, "On this Mac", platform || "before main has said");
    for (const platform of ["linux", NativePlatform.Linux]) {
      const here = nativeHereWords(platform);
      assert.equal(here.installedHere, "On this computer");
      assert.equal(here.readyToPlay, "Ready to play on this computer.");
      assert.equal(NATIVE_WORDS.installFailed[InstallFailure.NotOffered]("", here), here.notOffered);
    }
  });

  it("says how an install is going: the speed in the bar, the time left under it, then each step by name", () => {
    const view = (phase: InstallProgress["phase"], overrides: Partial<InstallProgress> = {}) =>
      installLine(progress(phase, overrides));
    const line = (phase: InstallProgress["phase"], overrides: Partial<InstallProgress> = {}) =>
      NATIVE_WORDS.installLine(view(phase, overrides));
    const left = (phase: InstallProgress["phase"], overrides: Partial<InstallProgress> = {}) =>
      NATIVE_WORDS.installTimeLeft(view(phase, overrides));
    assert.deepEqual(view(InstallPhase.Downloading), {
      line: InstallLine.Downloading,
      percent: 38,
      bytesPerSecond: 38 * 1024 ** 2,
      minutesLeft: 2,
    });
    assert.equal(line(InstallPhase.Downloading), "Installing… 38 MB/s");
    assert.equal(left(InstallPhase.Downloading), "about 2 min left");
    assert.equal(left(InstallPhase.Downloading, { etaMs: 61_000 }), "about 2 min left");
    assert.equal(left(InstallPhase.Downloading, { etaMs: 40_000 }), "under a minute left");
    for (const unknown of [{ bytesPerSecond: null }, { etaMs: null }, { bytesPerSecond: 0 }]) {
      assert.equal(line(InstallPhase.Downloading, unknown), "Installing…", "no speed is said until known");
      assert.equal(left(InstallPhase.Downloading, unknown), null, "no time is said until known");
    }
    assert.equal(line(InstallPhase.Queued), "Waiting for another install…");
    assert.equal(line(InstallPhase.Verifying), "Verifying…");
    assert.equal(line(InstallPhase.Unpacking), "Unpacking…");
    for (const step of [InstallPhase.Queued, InstallPhase.Verifying, InstallPhase.Unpacking])
      assert.equal(left(step), null, "a step has no time left");
    assert.equal(NATIVE_WORDS.installLine(installLine(undefined)), "Installing…");
  });

  it("reads a download's percent whole and never past 100", () => {
    assert.equal(installPercent(progress(InstallPhase.Downloading, { receivedBytes: 0 })), 0);
    assert.equal(installPercent(progress(InstallPhase.Downloading, { receivedBytes: 1_199 })), 99);
    assert.equal(installPercent(progress(InstallPhase.Downloading, { receivedBytes: 5_000 })), 100);
    assert.equal(installPercent(progress(InstallPhase.Downloading, { totalBytes: 0 })), 0);
  });
});
