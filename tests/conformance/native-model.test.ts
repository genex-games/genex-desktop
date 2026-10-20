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
  installPercent,
  opensPage,
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
} from "../../src/shared/play-native.ts";

const HOST: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "15.0" };

const build = (overrides: Partial<NativeBuild> = {}): NativeBuild => ({
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
  });

  it("opens its page only for a game with no web build", () => {
    assert.equal(opensPage(game()), true);
    assert.equal(opensPage(game([build()], true)), false);
    assert.equal(opensPage({}), false);
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
    assert.deepEqual(cardBadge(game(), installs({ installed: [installed()] })), { kind: CardBadge.Installed });
    assert.deepEqual(cardBadge(game(), installs({ installed: [installed("1.2")] })), {
      kind: CardBadge.Update,
      bytes: 1_200,
    });
    assert.deepEqual(
      cardBadge(game([build()], true), installs({ installed: [installed()] })),
      { kind: CardBadge.Installed },
      "a web game's Mac app installed here says so",
    );
  });

  it("reads a download's percent whole and never past 100", () => {
    assert.equal(installPercent(progress(InstallPhase.Downloading, { receivedBytes: 0 })), 0);
    assert.equal(installPercent(progress(InstallPhase.Downloading, { receivedBytes: 1_199 })), 99);
    assert.equal(installPercent(progress(InstallPhase.Downloading, { receivedBytes: 5_000 })), 100);
    assert.equal(installPercent(progress(InstallPhase.Downloading, { totalBytes: 0 })), 0);
  });
});
