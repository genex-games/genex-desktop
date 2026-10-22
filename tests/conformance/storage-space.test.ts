/**
 * Freeing space: Genex's own folders measured and deleted one child at a time, never through a
 * link, and which shown builds' copies and finished runs' folders a clean-up deletes or keeps.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { link, mkdir, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { StorageSpaceService } from "../../src/main/core/storage-space.ts";
import type { OutcomeView } from "../../src/shared/run-summary.ts";
import { freeableBytes, StorageKind, type StorageSpace } from "../../src/shared/storage-space.ts";
import { git } from "../../src/substrate/snapshots.ts";
import { diskBytes, ownedFolders, removeOwnedFolder } from "../../src/substrate/storage-folders.ts";
import { freedWords, freeSpaceWords, freeUpWords, STORAGE_WORDS } from "../../src/renderer/words.ts";
import { tmpDir } from "../helpers/tmp.ts";

const KB = 1024;
const GB = 1024 ** 3;
const HOUR_AGO = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

/** A folder holding one file of `bytes` random bytes, made with its parents. */
async function filled(dir: string, bytes = 64 * KB): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "data.bin"), randomBytes(bytes));
  return dir;
}

/** Every name under `dir`, sorted; none for a folder that is gone. */
const names = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [])).sort();

describe("Genex's own folders on disk", () => {
  it("counts a file with two names once and never follows a link", async () => {
    const root = await tmpDir("storage-measure-");
    const dir = await filled(path.join(root, "copy"));
    const alone = await diskBytes(dir);
    await link(path.join(dir, "data.bin"), path.join(dir, "again.bin"));
    const outside = await filled(path.join(root, "outside"), 512 * KB);
    await symlink(outside, path.join(dir, "linked"));
    const measured = await diskBytes(dir);
    assert.ok(measured >= alone, `${measured} >= ${alone}`);
    assert.ok(measured < alone + 16 * KB, "neither the second name nor the link's target counted");
  });

  it("deletes a folder under an owned root and says how much space it took", async () => {
    const root = await tmpDir("storage-remove-");
    const dir = await filled(path.join(root, "show", "game-a"));
    const outside = await filled(path.join(await tmpDir("storage-outside-"), "keep"));
    await symlink(outside, path.join(dir, "linked"));
    const size = await diskBytes(dir);
    assert.deepEqual(
      (await ownedFolders(root, ["show"])).map((folder) => folder.name),
      ["game-a"],
    );
    assert.equal(await removeOwnedFolder(root, ["show"], "game-a"), size);
    assert.deepEqual(await names(path.join(root, "show")), []);
    assert.deepEqual(await names(outside), ["data.bin"], "the link's target is untouched");
  });

  it("deletes nothing through a link, a file, a path or a root that is a link", async () => {
    const root = await tmpDir("storage-hostile-");
    const outsideRoot = await tmpDir("storage-hostile-outside-");
    const outside = await filled(path.join(outsideRoot, "victim"));
    await filled(path.join(outsideRoot, "victim", "inner"));
    const show = path.join(root, "show");
    await filled(path.join(show, "real"));
    await symlink(outside, path.join(show, "linked"));
    await writeFile(path.join(show, "file.txt"), "x");
    await symlink(outsideRoot, path.join(root, "runs"));
    const table: Array<[label: string, parts: string[], name: string]> = [
      ["a link to a folder outside", ["show"], "linked"],
      ["a file", ["show"], "file.txt"],
      ["the parent", ["show"], ".."],
      ["the root itself", ["show"], "."],
      ["no name", ["show"], ""],
      ["a path below", ["show"], "real/data.bin"],
      ["a path out", ["show"], "../show/real"],
      ["a missing folder", ["show"], "missing"],
      ["a folder under a root that is a link", ["runs"], "victim"],
    ];
    for (const [label, parts, name] of table) assert.equal(await removeOwnedFolder(root, parts, name), 0, label);
    assert.deepEqual(await names(show), ["file.txt", "linked", "real"], "the owned root is as it was");
    assert.deepEqual(await names(outside), ["data.bin", "inner"], "the outside folder is untouched");
    assert.deepEqual(await ownedFolders(root, ["runs"]), [], "a root reached through a link lists nothing");
    assert.deepEqual(
      (await ownedFolders(root, ["show"])).map((folder) => folder.name),
      ["real"],
      "a link and a file are not folders of the root",
    );
  });
});

/** A finished, paused or running build of a game, as Activity lists it. */
interface Run {
  project: string;
  runId: string;
  state: OutcomeView["state"];
}

const outcome = (state: OutcomeView["state"]): OutcomeView => ({
  state,
  delivered: "none",
  verification: "incomplete",
});

/**
 * A studio's folders over two listed games and one that is no longer listed: each run's pictures
 * and copies, shown builds' copies (old, fresh, served), and the runs Activity lists newest first.
 */
async function studio(runs: Run[]) {
  const userData = await tmpDir("storage-studio-");
  const layout = { scratch: path.join(userData, "scratch"), runs: path.join(userData, "runs") };
  const dirs: Record<string, string> = {};
  for (const game of ["g", "h"]) {
    dirs[game] = path.join(userData, "games", game);
    await mkdir(dirs[game], { recursive: true });
    await git(dirs[game], ["init", "-q", "-b", "main"]);
  }
  for (const { runId } of runs) {
    await filled(path.join(layout.runs, runId, "facet_build", "self", "iter_001"));
    await filled(path.join(layout.scratch, "autopilot", runId, "w1"));
  }
  const show = path.join(layout.scratch, "show");
  const shown = {
    old: await filled(path.join(show, "g-0123456789ab-01234567")),
    fresh: await filled(path.join(show, "g-0123456789ab-89abcdef")),
    served: await filled(path.join(show, "g-ba9876543210-01234567")),
    older: await filled(path.join(show, "g")),
    other: await filled(path.join(show, "h-0123456789ab-01234567")),
    gone: await filled(path.join(show, "gone-0123456789ab-01234567")),
  };
  for (const dir of [shown.old, shown.served, shown.older, shown.other, shown.gone])
    await utimes(dir, HOUR_AGO(), HOUR_AGO());
  const activeRunIds = new Set<string>();
  const activeDelegations = new Map<string, { project: string }>();
  const servedRoots = new Map([["live", { project: "g", root: shown.served, entry: undefined, loaded: null }]]);
  const core = {
    layout,
    games: { list: async () => [{ name: "g" }, { name: "h" }], dirFor: (game: string) => dirs[game] },
    assertProjectAllowed: async () => {},
    activityItems: async () =>
      runs.map(({ project, runId, state }) => ({ project, runId, runOutcome: outcome(state), at: "" })),
  };
  const internals = {
    activeDelegations,
    activeRunIds,
    servedRoots,
    rewind: { checkpoints: { exclusive: <T>(_dir: string, work: () => Promise<T>) => work() } },
  };
  const storage = new StorageSpaceService(core as never, internals as never);
  return { layout, shown, show, activeRunIds, activeDelegations, storage };
}

/** Runs newest first: each game's first finished one is its newest build. */
const RUNS: Run[] = [
  { project: "g", runId: "run_g_paused", state: "paused" },
  { project: "g", runId: "run_g_new", state: "finished" },
  { project: "g", runId: "run_g_old", state: "failed" },
  { project: "h", runId: "run_h_new", state: "finished" },
  { project: "h", runId: "run_h_old", state: "cancelled" },
  { project: "gone", runId: "run_gone_new", state: "finished" },
  { project: "gone", runId: "run_gone_old", state: "finished" },
];

describe("freeing space", () => {
  it("in one game deletes its older builds and old shown copies, and keeps the rest", async () => {
    const { layout, shown, show, storage } = await studio(RUNS);
    const pictures = await diskBytes(path.join(layout.runs, "run_g_old"));
    const copies =
      (await diskBytes(path.join(layout.scratch, "autopilot", "run_g_old"))) +
      (await diskBytes(shown.old)) +
      (await diskBytes(shown.older));
    const space = await storage.space("g");
    assert.equal(space.bytes[StorageKind.Pictures], pictures);
    assert.equal(space.bytes[StorageKind.Copies], copies);
    assert.equal(freeableBytes(space), pictures + copies + space.bytes[StorageKind.History]);

    const freed = await storage.free("g");
    assert.ok(freed.freedBytes >= pictures + copies, `${freed.freedBytes}`);
    assert.deepEqual(freed.skipped, []);
    const all = RUNS.map((run) => run.runId).filter((runId) => runId !== "run_g_old");
    assert.deepEqual(await names(layout.runs), [...all].sort(), "only g's older build's pictures went");
    assert.deepEqual(await names(path.join(layout.scratch, "autopilot")), [...all].sort());
    assert.deepEqual(
      await names(show),
      [shown.fresh, shown.served, shown.other, shown.gone].map((dir) => path.basename(dir)).sort(),
      "the copy Live serves, a fresh one and other games' stay",
    );
    assert.equal(freeableBytes(await storage.space("g")), 0, "nothing is left to free");
  });

  it("in every game leaves a working game alone and names it, and clears what unlisted games left", async () => {
    const { layout, shown, show, activeDelegations, storage } = await studio(RUNS);
    activeDelegations.set("d1", { project: "h" });
    const hOld = await diskBytes(path.join(layout.runs, "run_h_old"));
    const goneOld = await diskBytes(path.join(layout.runs, "run_gone_old"));
    const gOld = await diskBytes(path.join(layout.runs, "run_g_old"));
    assert.equal((await storage.space()).bytes[StorageKind.Pictures], gOld + goneOld, "a working game counts nothing");
    assert.equal(freeableBytes(await storage.space("h")), 0);

    const freed = await storage.free();
    assert.deepEqual(freed.skipped, ["h"]);
    const left = ["run_g_new", "run_g_paused", "run_gone_new", "run_h_new", "run_h_old"];
    assert.deepEqual(await names(layout.runs), left);
    assert.deepEqual(await names(path.join(layout.scratch, "autopilot")), left);
    assert.deepEqual(
      await names(show),
      [shown.fresh, shown.served, shown.other].map((dir) => path.basename(dir)).sort(),
      "the working game's copy stays; the unlisted game's goes",
    );
    assert.ok((await stat(path.join(layout.runs, "run_h_old"))).isDirectory());
    activeDelegations.clear();
    assert.equal((await storage.space()).bytes[StorageKind.Pictures], hOld, "once h stops, its older build counts");
  });

  it("refuses in a game that is working and deletes nothing", async () => {
    const { layout, show, activeRunIds, storage } = await studio(RUNS);
    const before = [await names(layout.runs), await names(show)];
    activeRunIds.add("run_g_paused");
    await assert.rejects(storage.free("g"), /Wait for this game's work to finish/);
    activeRunIds.clear();
    activeRunIds.add("run_untied");
    await assert.rejects(storage.free("g"), /Wait for this game's work to finish/, "a run no record ties to a game");
    assert.deepEqual([await names(layout.runs), await names(show)], before);
  });

  it("keeps a run that is still going even when its record says it finished", async () => {
    const { layout, activeRunIds, storage } = await studio([
      { project: "h", runId: "run_h_newest", state: "finished" },
      ...RUNS,
    ]);
    activeRunIds.add("run_h_new");
    await storage.free("g");
    assert.ok((await names(layout.runs)).includes("run_h_new"));
    activeRunIds.clear();
    await storage.free("h");
    assert.deepEqual(
      (await names(layout.runs)).filter((name) => name.startsWith("run_h")),
      ["run_h_newest"],
      "once it ends, only the newest stays",
    );
  });

  it("keeps a game's newest finished build when failed or stopped runs came after it", async () => {
    const { layout, storage } = await studio([
      { project: "g", runId: "run_g_stopped", state: "cancelled" },
      { project: "g", runId: "run_g_broken", state: "failed" },
      { project: "g", runId: "run_g_build", state: "finished" },
      { project: "g", runId: "run_g_older_build", state: "finished" },
    ]);
    await storage.free("g");
    assert.deepEqual(await names(layout.runs), ["run_g_build"], "the newest build stays; the runs after it go");
    assert.deepEqual(await names(path.join(layout.scratch, "autopilot")), ["run_g_build"]);
  });
});

describe("the words for freeing space", () => {
  const space = (copies: number, pictures = 0, history = 0): StorageSpace => ({
    bytes: { [StorageKind.Copies]: copies, [StorageKind.Pictures]: pictures, [StorageKind.History]: history },
  });

  it("the button says how much it frees, or that there is nothing to", () => {
    assert.equal(freeUpWords(space(2 * GB, 1.5 * GB, 0.5 * GB)), "Free up 4 GB");
    assert.equal(freeUpWords(space(0)), STORAGE_WORDS.nothing);
  });

  it("say what goes and what stays, for one game or all", () => {
    assert.match(
      freeSpaceWords(space(GB, 0.2 * GB), "Racing"),
      /^Older builds of Racing and Rewind copies take 1\.2\u00a0GB\. The game,/,
    );
    assert.match(
      freeSpaceWords(space(GB)),
      /^Older builds and Rewind copies take 1\u00a0GB\. Your games, save points, paused builds/,
    );
  });

  it("the notice says what was freed and which working games were left alone", () => {
    const titles = (game: string) => (game === "racing" ? "Racing" : game);
    assert.equal(freedWords({ freedBytes: 1.2 * GB, skipped: [] }), "Freed 1.2 GB.");
    assert.equal(freedWords({ freedBytes: 0, skipped: [] }), STORAGE_WORDS.freedNothing);
    assert.equal(
      freedWords({ freedBytes: 3 * GB, skipped: ["racing"] }, titles),
      "Freed 3 GB. Left Racing alone while it works.",
    );
    assert.equal(
      freedWords({ freedBytes: 3 * GB, skipped: ["racing", "doom"] }, titles),
      "Freed 3 GB. Left 2 games alone while they work.",
    );
  });
});
