/**
 * Dev builds (`.studio-dev/builds/b-<uuid>`) are made by every `studio:dev start` and were never
 * removed: a live gate found eight orphan builds (about 216 MB each) on a full disk with no way to
 * tell them from the ones profiles still launch. `studio:dev -- builds` lists each build with the
 * profiles that reference it; `--prune` removes only orphans. The hostile rows hold that nothing a
 * profile references, nothing young, nothing named otherwise and nothing behind a link is removed.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { parseStudioDevArgs } from "../../scripts/studio-dev/args.ts";
import { BUILD_PRUNE_GRACE_MS, listDevBuilds, pruneDevBuilds } from "../../scripts/studio-dev/builds.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32" ? { skip: "the link rows are POSIX-only" } : {};
const NOW = Date.parse("2026-10-08T12:00:00Z");
const OLD = new Date(NOW - 2 * BUILD_PRUNE_GRACE_MS);
const id = (n: number) => `b-${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

/** A dev root with one build per row: old unless `young`, `bytes` long. */
async function devRoot() {
  const root = await realpath(await tmpDir("studio-dev-builds-"));
  for (const d of ["builds", "profiles"]) await mkdir(path.join(root, d));
  const build = async (name: string, options: { young?: boolean; bytes?: number } = {}) => {
    const dir = path.join(root, "builds", name);
    await mkdir(path.join(dir, "main"), { recursive: true });
    await writeFile(path.join(dir, "main", "main.mjs"), "x".repeat(options.bytes ?? 10));
    if (!options.young) await utimes(dir, OLD, OLD);
  };
  const profile = async (name: string, files: Record<string, unknown>) => {
    const dir = path.join(root, "profiles", name);
    await mkdir(dir, { recursive: true });
    for (const [file, value] of Object.entries(files))
      await writeFile(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  return { root, build, profile };
}

describe("studio:dev builds: the dev builds and the profiles that launch them", () => {
  it("parses `builds` and `builds --prune` without a profile", () => {
    assert.deepEqual(parseStudioDevArgs(["builds"]), { command: "builds", profile: "", reuse: false });
    assert.deepEqual(parseStudioDevArgs(["builds", "--prune"]), {
      command: "builds",
      profile: "",
      reuse: false,
      prune: true,
    });
  });

  it("lists each build with its referencing profiles and counts only orphans as reclaimable", async () => {
    const r = await devRoot();
    await r.build(id(1), { bytes: 100 });
    await r.build(id(2), { bytes: 7 });
    await r.profile("live", { "launch.json": { version: 1, buildId: id(1) } });
    const listed = listDevBuilds(r.root, NOW);
    assert.deepEqual(
      listed.builds.map((b) => [b.buildId, b.referencedBy, b.orphan]),
      [
        [id(1), ["live"], false],
        [id(2), [], true],
      ],
    );
    assert.equal(listed.reclaimableBytes, 7);
  });

  it("removes only old, unreferenced b-<uuid> builds", POSIX_ONLY, async () => {
    const r = await devRoot();
    const outside = path.join(r.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep");
    await r.build(id(1));
    await r.build(id(2));
    await r.build(id(3), { young: true });
    await r.build(id(4));
    await r.build(id(5));
    await r.build("m1-4-check");
    await symlink(outside, path.join(r.root, "builds", id(6)));
    await r.profile("by-launch", { "launch.json": { version: 1, buildId: id(1) } });
    await r.profile("by-attempt", { "attempt.json": { version: 1, buildId: id(2), pid: 1 } });
    await r.profile("by-controller", { "controller.json": { version: 1, buildId: id(5) } });
    await symlink(path.join(r.root, "profiles", "by-launch"), path.join(r.root, "profiles", "linked"));
    const pruned = pruneDevBuilds(r.root, NOW);
    assert.deepEqual(pruned.removed, [id(4)], "only the old orphan");
    assert.equal(pruned.bytes, 10);
    const kept = (name: string) => existsSync(path.join(r.root, "builds", name));
    for (const name of [id(1), id(2), id(3), id(5), "m1-4-check", id(6)]) assert.ok(kept(name), name);
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep", "a link is never followed");
  });

  it("refuses to prune anything while a profile's launch record is unreadable", async () => {
    const r = await devRoot();
    await r.build(id(1));
    await r.profile("broken", { "launch.json": "{not json" });
    assert.throws(() => pruneDevBuilds(r.root, NOW), /broken/);
    assert.ok(existsSync(path.join(r.root, "builds", id(1))));
  });
});
