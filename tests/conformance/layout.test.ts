/**
 * Where the studio keeps its own state (`layoutFor`): the Rust build lane's folders sit beside the
 * C++ lane's, under the profile's own data and under no folder an agent process may write, and a
 * toolchain prewarm may write neither.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { layoutFor, prewarmDenyWrites, type StudioLayout } from "../../src/main/core/layout.ts";
import { isInside } from "../../src/substrate/paths.ts";

/** The folders the studio's sandbox lets an agent process write (`StudioCore.#createSandbox` plus its scratch). */
function writableRoots(layout: StudioLayout): string[] {
  return [layout.workspaces, layout.runs, layout.exports, layout.gamesRoot, layout.scratch, layout.harnessWs];
}

/** Profiles a person can really have: spaces, a quote, a dev profile under the repository. */
const USER_DATA = [
  "/Users/me/Library/Application Support/Genex",
  "/Users/me/Library/Application Support/Genex Dev/profiles/it's mine",
  "/repo/.studio-dev/profiles/live-1/userData",
];

describe("the studio layout's build lane folders", () => {
  for (const userData of USER_DATA) {
    it(`keeps the Rust builds beside the C++ builds, under no writable root (${JSON.stringify(userData)})`, () => {
      const layout = layoutFor(userData);
      assert.equal(layout.rustBuilds, path.join(userData, "rust-builds"));
      assert.equal(path.dirname(layout.rustBuilds), path.dirname(layout.cppBuilds));
      assert.notEqual(layout.rustBuilds, layout.cppBuilds);
      for (const root of writableRoots(layout)) {
        assert.ok(!isInside(root, layout.rustBuilds), `${layout.rustBuilds} is under ${root}`);
        assert.ok(!isInside(layout.rustBuilds, root), `${root} is under ${layout.rustBuilds}`);
      }
      for (const [name, folder] of Object.entries(layout)) {
        if (name === "rustBuilds") continue;
        assert.ok(!isInside(folder, layout.rustBuilds), `rustBuilds sits inside ${name}`);
        assert.ok(!isInside(layout.rustBuilds, folder), `${name} sits inside rustBuilds`);
      }
    });
  }

  it("denies a toolchain prewarm both lanes' build folders", () => {
    const layout = layoutFor(USER_DATA[0] ?? "");
    const denied = prewarmDenyWrites(layout);
    assert.ok(denied.includes(layout.cppBuilds));
    assert.ok(denied.includes(layout.rustBuilds));
  });
});
