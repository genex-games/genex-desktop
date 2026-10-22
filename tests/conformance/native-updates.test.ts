/**
 * Newer builds of installed games are told once per version: a game whose catalog page offers this
 * computer a newer build than the installed one gets one notice, a restart does not ring again, a
 * newer version still does, and a game the catalog cannot be read for is passed over.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkNativeUpdates, type NativeUpdate } from "../../src/main/play/native-updates.ts";
import type { PlayGameDetail } from "../../src/shared/play.ts";
import {
  type InstalledGame,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  NativePlatform,
} from "../../src/shared/play-native.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HOST: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "15.0" };

const installed = (slug: string, version: string): InstalledGame => ({
  slug,
  title: slug,
  coverUrl: null,
  version,
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  bytes: 1,
  installedAt: "2026-10-19T00:00:00.000Z",
  lastPlayedAt: null,
});

const build = (version: string): NativeBuild => ({
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  version,
  sizeBytes: 120,
  installedBytes: 140,
  sha256: "a".repeat(64),
  url: `https://builds.genex.invalid/x/${version}/mac.zip`,
  entry: "X.app",
  publishedAt: "2026-10-19T00:00:00.000Z",
});

const page = (slug: string, version: string): PlayGameDetail => ({
  id: slug,
  slug,
  title: `${slug} title`,
  description: "",
  coverUrl: null,
  clipUrl: null,
  multiplayer: false,
  plays: 0,
  online: null,
  author: { id: null, name: "", imageUrl: null },
  remixable: false,
  assetKind: null,
  native: { web: false, engine: null, builds: [build(version)] },
  likes: 0,
  liked: false,
  comments: 0,
  shots: [],
  updatedAt: null,
});

describe("newer builds of installed games", () => {
  it("tells a newer build once per version, and a newer one again", async () => {
    const root = await tmpDir("native-updates-");
    const catalog: Record<string, string> = { "puck-rush": "1.3", frigate: "1.1" };
    const told: NativeUpdate[] = [];
    const check = () =>
      checkNativeUpdates({
        root,
        host: HOST,
        installed: async () => [installed("puck-rush", "1.2"), installed("frigate", "1.1")],
        game: async (slug) => page(slug, catalog[slug] ?? ""),
        tell: (update) => void told.push(update),
      });
    await check();
    assert.deepEqual(told, [{ slug: "puck-rush", title: "puck-rush title", version: "1.3", sizeBytes: 120 }]);
    await check();
    assert.equal(told.length, 1, "the same version is not told again");
    catalog["puck-rush"] = "1.4";
    await check();
    assert.deepEqual(
      told.map((update) => update.version),
      ["1.3", "1.4"],
    );
  });

  it("passes over a game the catalog cannot be read for, and one with no build for this computer", async () => {
    const root = await tmpDir("native-updates-");
    const told: NativeUpdate[] = [];
    await checkNativeUpdates({
      root,
      host: HOST,
      installed: async () => [installed("gone", "1.0"), installed("windows-now", "1.0")],
      game: async (slug) => {
        if (slug === "gone") throw new Error("404");
        const windows = { ...build("2.0"), platform: NativePlatform.Windows, arch: NativeArch.X64, entry: "X.exe" };
        return { ...page(slug, "2.0"), native: { web: false, engine: null, builds: [windows] } };
      },
      tell: (update) => void told.push(update),
    });
    assert.deepEqual(told, []);
  });
});
