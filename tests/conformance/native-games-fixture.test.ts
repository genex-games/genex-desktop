/**
 * The native-games fixture on this Mac: its stand-in apps are built and zipped into the profile, the
 * fixture catalog then states each archive's real size and checksum, its made-up build host serves
 * them (a range too) and nothing else, and a fresh profile starts with Frigate installed and Puck
 * Rush one version behind the catalog.
 */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { canBuildFixtureApp } from "../../src/main/dev/fixture-native-app.ts";
import { findNativeBuilds } from "../../src/main/core/native-builds.ts";
import { prepareNativeGamesFixture } from "../../src/main/dev/fixture-native-games.ts";
import { fixtureNativeFetch } from "../../src/main/dev/fixture-native.ts";
import { fixtureNativeGames, fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { playGallery } from "../../src/main/play/gallery.ts";
import { nativeInstalls } from "../../src/main/play/native-installs.ts";
import { runTool } from "../../src/main/play/native-unpack.ts";
import { buildHostsFor } from "../../src/main/play/gallery.ts";
import { NativeArch, type NativeHost, NativePlatform } from "../../src/shared/play-native.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SKIP = (await canBuildFixtureApp()) ? false : "needs a Mac with the Xcode toolchain";
const THIS_MAC: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "15.0" };

describe("the native-games fixture", { skip: SKIP }, () => {
  it("serves real archives the catalog states, starts with Frigate installed and Puck Rush behind, and builds the library game for the Mac", async () => {
    const profile = await realpath(await tmpDir("native-games-fixture-"));
    const gallery = playGallery({
      request: fixturePlayRequest,
      token: async () => undefined,
      now: Date.now,
      localImages: true,
    });
    const root = path.join(profile, "installed-games");
    const libraryGame = path.join(profile, "games", "fixture-game");
    await prepareNativeGamesFixture({
      dir: path.join(profile, "fixture-native"),
      root,
      host: THIS_MAC,
      games: fixtureNativeGames(),
      page: (slug) => gallery.game(slug),
      libraryGame: { dir: libraryGame, title: "Fixture Game" },
    });
    const built = (await findNativeBuilds(libraryGame)).map((build) => [build.platform, build.arch, build.entry]);
    assert.deepEqual(built, [[NativePlatform.Mac, NativeArch.Universal, "Builds/Mac/Fixture Game.app"]]);
    const dust = (await gallery.game("dust-runners")).native?.builds[0];
    assert.ok(dust, "Dust Runners has a Mac build");
    const archive = await fixtureNativeFetch(dust.url);
    const bytes = new Uint8Array(await archive.arrayBuffer());
    assert.equal(bytes.length, dust.sizeBytes, "the catalog states the archive's real size");
    const tail = await fixtureNativeFetch(dust.url, { headers: { Range: `bytes=${bytes.length - 10}-` } });
    assert.equal(tail.status, 206);
    assert.equal((await tail.arrayBuffer()).byteLength, 10);
    assert.equal((await fixtureNativeFetch("https://builds.genex.invalid/nothing.zip")).status, 404);
    const installs = nativeInstalls({
      root,
      host: THIS_MAC,
      hosts: buildHostsFor(true),
      game: (slug) => gallery.game(slug),
      fetch: fixtureNativeFetch,
      run: runTool,
      now: Date.now,
      publish: () => undefined,
    });
    const installed = (await installs.state()).installed.map((game) => [game.slug, game.version]);
    assert.deepEqual(installed.sort(), [
      ["frigate", "1.1"],
      ["puck-rush", "1.2"],
    ]);
    const catalog = (await gallery.game("puck-rush")).native?.builds[0]?.version;
    assert.equal(catalog, "1.3", "an update waits for Puck Rush");
  });
});
