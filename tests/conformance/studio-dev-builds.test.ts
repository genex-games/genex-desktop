import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pruneUnusedBuilds } from "../../scripts/studio-dev/builds.ts";
import { HOUR_MS, MINUTE_MS } from "../../src/shared/duration.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const OLD = NOW - 2 * HOUR_MS;
const FRESH = NOW - 5 * MINUTE_MS;
const id = (n: number) => `b-0000000${n}-0000-4000-8000-000000000000`;

/** A `.studio-dev` folder with the given builds (aged as asked) and profile records. */
async function devFolder(builds: Record<string, number>, records: Record<string, string> = {}) {
  const root = await tmpDir("studio-dev-builds-");
  for (const [name, mtime] of Object.entries(builds)) {
    const dir = path.join(root, "builds", name);
    fs.mkdirSync(path.join(dir, "main"), { recursive: true });
    fs.writeFileSync(path.join(dir, "main", "main.mjs"), "");
    fs.utimesSync(dir, mtime / 1000, mtime / 1000);
  }
  fs.mkdirSync(path.join(root, "profiles"), { recursive: true });
  for (const [file, text] of Object.entries(records)) {
    fs.mkdirSync(path.dirname(path.join(root, "profiles", file)), { recursive: true });
    fs.writeFileSync(path.join(root, "profiles", file), text);
  }
  return root;
}

const names = (root: string) => fs.readdirSync(path.join(root, "builds")).sort();
const record = (buildId: string) => JSON.stringify({ version: 1, buildId });

test("a launch removes the builds no profile names once they are an hour old, and keeps the rest", async () => {
  const root = await devFolder(
    { [id(1)]: OLD, [id(2)]: OLD, [id(3)]: OLD, [id(4)]: FRESH, "not-a-build": OLD },
    { "live/launch.json": record(id(1)), "other/attempt.json": record(id(2)) },
  );
  assert.deepEqual(pruneUnusedBuilds(root, NOW), [id(3)]);
  // Named by a launch record, named by an attempt, still being made, and not a build at all.
  assert.deepEqual(names(root), [id(1), id(2), id(4), "not-a-build"].sort());
});

test("a link named like a build is never followed, and an unreadable profile record stops the prune", async (t) => {
  const outside = await tmpDir("studio-dev-builds-outside-");
  fs.writeFileSync(path.join(outside, "keep"), "x");
  const link = (root: string) => fs.symlinkSync(outside, path.join(root, "builds", id(5)));
  const cases: Array<[string, Record<string, string>, (root: string) => void, string[]]> = [
    ["a link named like a build", {}, link, [id(3)]],
    ["a profile record that is not JSON", { "broken/launch.json": "{" }, () => {}, []],
    ["a profile record of another version", { "broken/launch.json": '{"version":2}' }, () => {}, []],
    ["a profile record naming no build", { "broken/attempt.json": '{"version":1}' }, () => {}, [id(3)]],
  ];
  for (const [name, records, arrange, expected] of cases)
    await t.test(name, async () => {
      const root = await devFolder({ [id(3)]: OLD }, records);
      arrange(root);
      const before = names(root);
      assert.deepEqual(pruneUnusedBuilds(root, NOW), expected);
      assert.deepEqual(
        names(root),
        before.filter((n) => !expected.includes(n)),
      );
      assert.deepEqual(fs.readdirSync(outside), ["keep"]);
    });
});

/** The pids `lsof` finds with a file open anywhere under `dir`: what a disk cleanup asks before it removes a build. */
function holders(dir: string): string[] {
  const lsof = spawnSync("lsof", ["-t", "+D", dir], { encoding: "utf8" });
  if (lsof.error) throw lsof.error;
  return lsof.stdout.split("\n").filter(Boolean);
}

const NO_LSOF = spawnSync("lsof", ["-v"]).error ? "this machine has no lsof to ask" : false;

test("a running app's build shows as in use to lsof, and stops once the app exits", { skip: NO_LSOF }, async () => {
  const root = await devFolder({ [id(6)]: OLD });
  const build = path.join(root, "builds", id(6));
  fs.writeFileSync(path.join(build, "build.json"), "{}");
  const holdBuild = new URL("../../scripts/studio-dev/builds.ts", import.meta.url).href;
  // The app reads its build's files once and closes them, so before the hold nothing showed it in use.
  const app = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { holdBuild } = await import(${JSON.stringify(holdBuild)}); holdBuild(process.argv[1]); console.log("held"); setInterval(() => {}, 1000);`,
      build,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = once(app, "exit");
  try {
    const first = await Promise.race([once(app.stdout, "data").then(() => "held"), exited.then(() => "exited")]);
    assert.equal(first, "held", "the app exited before it held its build");
    assert.deepEqual(holders(build), [String(app.pid)]);
  } finally {
    app.kill();
  }
  await exited;
  assert.deepEqual(holders(build), []);
});
