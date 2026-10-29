/**
 * The stand-in for a game built in an engine: a real Mac app the fixture launch's native games and
 * the native launch tests install and run. It is built from source on this Mac (never committed),
 * signed ad-hoc, for one processor or both, and named as its spec says.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { buildFixtureApp, canBuildFixtureApp } from "../../src/main/dev/fixture-native-app.ts";
import { tmpDir } from "../helpers/tmp.ts";

const exec = promisify(execFile);
const SKIP = (await canBuildFixtureApp()) ? false : "needs a Mac with the Xcode toolchain";

const plist = async (app: string, key: string) =>
  (
    await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path.join(app, "Contents/Info.plist")])
  ).stdout.trim();

describe("the fixture game app", { skip: SKIP }, () => {
  it("is a signed universal app bundle named as its spec says, built once per program", async () => {
    const root = await tmpDir("fixture-app-");
    const cache = path.join(root, "cache");
    const spec = { title: "Dust Runners", bundleId: "games.genex.fixture.dust-runners", hue: 28, version: "1.3" };
    const app = await buildFixtureApp({ ...spec, arch: "universal" }, root, cache);
    assert.equal(app, path.join(root, "Dust Runners.app"));
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    const archs = (await exec("/usr/bin/lipo", ["-archs", path.join(app, "Contents/MacOS/FixtureGame")])).stdout;
    assert.deepEqual(archs.trim().split(/\s+/).sort(), ["arm64", "x86_64"]);
    assert.equal(await plist(app, "CFBundleIdentifier"), spec.bundleId);
    assert.equal(await plist(app, "CFBundleName"), spec.title);
    assert.equal(await plist(app, "CFBundleShortVersionString"), spec.version);
    const again = await buildFixtureApp({ ...spec, title: "Iron Tide", arch: "universal" }, root, cache);
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", again]);
    const programs = (await readdir(cache)).filter((name) => !name.startsWith("."));
    assert.equal(programs.length, 1, "the second app reuses the compiled program");
  });

  it("is built for one processor when asked", async () => {
    const root = await tmpDir("fixture-app-");
    const app = await buildFixtureApp(
      { title: "Puck Rush", bundleId: "games.genex.fixture.puck-rush", hue: 6, version: "1", arch: "arm64" },
      root,
      path.join(root, "cache"),
    );
    const archs = (await exec("/usr/bin/lipo", ["-archs", path.join(app, "Contents/MacOS/FixtureGame")])).stdout;
    assert.equal(archs.trim(), "arm64");
  });
});
