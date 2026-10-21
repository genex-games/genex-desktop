/**
 * Live's hot reload of a Rust game's assets (game systems C-19a, `src/main/asset-watch.ts`).
 *
 * New behaviour (no swap existed: an asset change to a shown Live game reloaded through a full
 * rebuild). The watcher gathers a burst of changes into one batch after 150 ms and lights Reload;
 * Reload re-plans the whole `assets/` folder against the copy the running game reads, so a change
 * the watcher missed is still found, places only the changed files by atomic rename and names
 * them in one `reloadAssets`, with no build of any kind. A change outside `assets/`, a removed
 * file, a file that needs the import step or too many files answer `rebuild` and place nothing.
 * Hostile names and links (in the game folder and in the served copy) are never read through,
 * and nothing is written through them.
 */
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ASSET_WATCH_DEBOUNCE_MS,
  changeBatcher,
  classifyGamePath,
  type FolderWatch,
  GameChangeKind,
  type GameChanges,
  LiveAssets,
  type LiveAssetsDeps,
  placeSwap,
  planAssetSwap,
  recordWebSwap,
  type ShownGame,
  webSwapRefusal,
} from "../../src/main/asset-watch.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { LiveAssetsOutcome, LiveAssetsRebuild } from "../../src/shared/live-assets.ts";
import { NATIVE_RELOAD_FILES_MAX, type NativeReloadFile, type NativeTimers } from "../../src/shared/native-contract.ts";
import { fnv1a64Hex } from "../../src/substrate/native-game-port.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A clock the test moves by hand. */
function fakeTimers(): NativeTimers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++;
      due.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") due.delete(handle);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        due.delete(id);
        timer.run();
      }
    },
    pending: () => due.size,
  };
}

/** A folder made read-only by a test gets its owner's write bit back, so the temp tree can go. */
async function unlockTree(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlockTree(path.join(dir, entry.name));
  }
}
async function lockTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await lockTree(full);
    else await chmod(full, 0o444);
  }
  await chmod(dir, 0o555);
}

/** Writes `files` (path → bytes) under `root`, folders made. */
async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

/** A game folder and the copy its running build reads, both holding `files` under `assets/`. */
async function gameAndServed(files: Record<string, string | Buffer>): Promise<{ game: string; served: string }> {
  const root = await tmpDir("asset-watch-");
  const game = path.join(root, "game");
  const served = path.join(root, "served", "assets");
  await writeTree(path.join(game, "assets"), files);
  await writeTree(served, files);
  return { game, served };
}

describe("classifyGamePath", () => {
  const rows: Array<[string, ReturnType<typeof classifyGamePath>]> = [
    ["assets/textures/bark.png", { kind: GameChangeKind.Asset, path: "textures/bark.png" }],
    ["assets\\models\\ship.glb", { kind: GameChangeKind.Asset, path: "models/ship.glb" }],
    ["genex-assets.lock", { kind: GameChangeKind.Lock }],
    ["genex.toml", { kind: GameChangeKind.Source }],
    ["src/main.rs", { kind: GameChangeKind.Source }],
    ["assets", null],
    [".git/index", null],
    [".studio/crashes/one.json", null],
    ["target/debug/game", null],
    ["", null],
  ];
  for (const [rel, expected] of rows) {
    it(`${JSON.stringify(rel)} is ${JSON.stringify(expected)}`, () =>
      assert.deepEqual(classifyGamePath(rel), expected));
  }
});

describe("changeBatcher", () => {
  it("gathers a burst into one batch once it settles, each name once, a rename's two names included", () => {
    const timers = fakeTimers();
    const batches: GameChanges[] = [];
    const batcher = changeBatcher(timers, (changes) => batches.push(changes));
    batcher.note("assets/textures/bark.png");
    timers.advance(ASSET_WATCH_DEBOUNCE_MS - 1);
    batcher.note("assets/textures/.bark.png.tmp");
    batcher.note("assets/textures/bark.png");
    timers.advance(ASSET_WATCH_DEBOUNCE_MS - 1);
    assert.equal(batches.length, 0, "a burst still writing is not a batch yet");
    timers.advance(1);
    assert.deepEqual(batches, [
      { assets: ["textures/.bark.png.tmp", "textures/bark.png"], source: false, rescan: false },
    ]);
  });

  it("a code change marks the batch source; a name it cannot read asks for a rescan; ignored names arm nothing", () => {
    const timers = fakeTimers();
    const batches: GameChanges[] = [];
    const batcher = changeBatcher(timers, (changes) => batches.push(changes));
    batcher.note(".git/index");
    assert.equal(timers.pending(), 0);
    batcher.note("src/main.rs");
    batcher.note(null);
    timers.advance(ASSET_WATCH_DEBOUNCE_MS);
    assert.deepEqual(batches, [{ assets: [], source: true, rescan: true }]);
    batcher.dispose();
  });
});

describe("planAssetSwap (the whole folder against the served copy)", () => {
  it("an unchanged folder plans nothing; a changed texture and a changed level plan exactly those", async () => {
    const { game, served } = await gameAndServed({ "textures/bark.png": "old bark", "levels/one.json": "{}" });
    assert.deepEqual(await planAssetSwap(game, served), { ok: true, files: [] });
    await writeTree(path.join(game, "assets"), { "textures/bark.png": "new bark", "levels/one.json": '{"a":1}' });
    const plan = await planAssetSwap(game, served);
    assert.ok(plan.ok);
    assert.deepEqual(
      plan.files.map(({ path: rel, digest, texture }) => ({ rel, digest, texture })),
      [
        { rel: "levels/one.json", digest: fnv1a64Hex(Buffer.from('{"a":1}')), texture: false },
        { rel: "textures/bark.png", digest: fnv1a64Hex(Buffer.from("new bark")), texture: true },
      ],
    );
  });

  it("a change the watcher never reported is found all the same (Reload re-plans the whole folder)", async () => {
    const { game, served } = await gameAndServed({ "sounds/hit.ogg": "OggS old" });
    await writeTree(path.join(game, "assets"), { "sounds/hit.ogg": "OggS new" });
    const plan = await planAssetSwap(game, served, new Set());
    assert.ok(plan.ok && plan.files.length === 1 && plan.files[0]?.path === "sounds/hit.ogg");
  });

  const rebuilds: Array<{
    name: string;
    files: Record<string, string>;
    edit: Record<string, string>;
    touched: string[];
    reason: LiveAssetsRebuild;
  }> = [
    {
      name: "a changed KTX2 (its families are the import step's)",
      files: { "t/a.ktx2": "old" },
      edit: { "t/a.ktx2": "new" },
      touched: [],
      reason: LiveAssetsRebuild.Import,
    },
    {
      name: "a touched GLB (the import step rewrites it)",
      files: { "m/ship.glb": "glTF" },
      edit: {},
      touched: ["m/ship.glb"],
      reason: LiveAssetsRebuild.Import,
    },
    {
      name: "a touched OBJ (converted to a GLB)",
      files: { "m/rock.obj": "v 0 0 0" },
      edit: {},
      touched: ["m/rock.obj"],
      reason: LiveAssetsRebuild.Import,
    },
    {
      name: "a touched file that is gone",
      files: { "levels/one.json": "{}" },
      edit: {},
      touched: ["levels/gone.json"],
      reason: LiveAssetsRebuild.Removed,
    },
  ];
  for (const row of rebuilds) {
    it(`${row.name} answers ${row.reason}`, async () => {
      const { game, served } = await gameAndServed(row.files);
      await writeTree(path.join(game, "assets"), row.edit);
      assert.deepEqual(await planAssetSwap(game, served, new Set(row.touched)), { ok: false, reason: row.reason });
    });
  }

  it(`more than ${NATIVE_RELOAD_FILES_MAX} changed files answer too-many`, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= NATIVE_RELOAD_FILES_MAX; i++) files[`levels/l${i}.json`] = String(i);
    const { game, served } = await gameAndServed({});
    await writeTree(path.join(game, "assets"), files);
    assert.deepEqual(await planAssetSwap(game, served), { ok: false, reason: LiveAssetsRebuild.TooMany });
  });

  it("hostile names and links in the game folder are never read: nothing is planned from them", async () => {
    const { game, served } = await gameAndServed({ "levels/one.json": "{}" });
    const outside = path.join(path.dirname(game), "secret.json");
    await writeFile(outside, "the person's secret");
    await symlink(outside, path.join(game, "assets", "levels", "linked.json"));
    await symlink(path.dirname(outside), path.join(game, "assets", "linked-folder"));
    await writeTree(path.join(game, "assets"), { "bad name!.json": "x", "levels/ok.json": "{}" });
    const plan = await planAssetSwap(game, served);
    assert.ok(plan.ok);
    assert.deepEqual(
      plan.files.map((file) => file.path),
      ["levels/ok.json"],
    );
  });
});

describe("placeSwap (into the read-only copy the game reads)", () => {
  it("replaces each file by rename, keeps the copy read-only, and drops a texture's old family files", async () => {
    const { game, served } = await gameAndServed({ "textures/bark.png": "old bark" });
    await writeTree(served, { "textures/bark.bc.ktx2": "old bc", "textures/bark.astc.ktx2": "old astc" });
    await lockTree(path.dirname(served));
    try {
      await writeTree(path.join(game, "assets"), { "textures/bark.png": "new bark", "levels/new.json": "{}" });
      const plan = await planAssetSwap(game, served);
      assert.ok(plan.ok);
      await placeSwap(served, plan.files);
      assert.equal(await readFile(path.join(served, "textures", "bark.png"), "utf8"), "new bark");
      assert.equal(await readFile(path.join(served, "levels", "new.json"), "utf8"), "{}");
      assert.deepEqual(await readdir(path.join(served, "textures")), ["bark.png"], "the old families are gone");
      assert.equal((await lstat(path.join(served, "textures"))).mode & 0o777, 0o555, "the folder is read-only again");
      assert.equal((await lstat(path.join(served, "textures", "bark.png"))).mode & 0o777, 0o444);
    } finally {
      await unlockTree(path.dirname(served));
    }
  });

  it("refuses a served copy that is a link, or a link inside it, and writes nothing through either", async () => {
    const root = await tmpDir("asset-watch-hostile-");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(root, "served"));
    const file = {
      path: "levels/one.json",
      bytes: Buffer.from("{}"),
      digest: fnv1a64Hex(Buffer.from("{}")),
      texture: false,
    };
    await assert.rejects(placeSwap(path.join(root, "served"), [file]));
    assert.deepEqual(await readdir(elsewhere), []);
    const real = path.join(root, "real");
    await mkdir(real);
    await symlink(elsewhere, path.join(real, "levels"));
    await assert.rejects(placeSwap(real, [file]));
    assert.deepEqual(await readdir(elsewhere), [], "nothing was written through the linked folder");
  });
});

describe("the web page's copy", () => {
  /** A served web build: `<bin>.out` with its map and admitted record. */
  async function webBuild(rows: object[], files: Record<string, string>): Promise<string> {
    const root = path.join(await tmpDir("asset-watch-web-"), "web-0123456789ab.out");
    await mkdir(root, { recursive: true });
    await writeTree(path.join(root, "assets"), files);
    await writeFile(path.join(root, "assets.json"), JSON.stringify({ version: 2, files: rows }));
    await writeFile(`${root.slice(0, -4)}.admitted`, JSON.stringify([{ path: "assets.json", sha256: "0", bytes: 1 }]));
    return root;
  }
  const level = (text: string) => ({
    path: "levels/one.json",
    bytes: text.length,
    fnv1a64: fnv1a64Hex(Buffer.from(text)),
  });
  const swap = (text: string) => ({
    path: "levels/one.json",
    bytes: Buffer.from(text),
    digest: fnv1a64Hex(Buffer.from(text)),
    texture: false,
  });

  it("a planned whole file is swappable; its map row and the admitted record take the new length and digests", async () => {
    const root = await webBuild([level("{}")], { "levels/one.json": "{}" });
    assert.equal(await webSwapRefusal(root, [swap('{"b":2}')]), null);
    await recordWebSwap(root, [swap('{"b":2}')]);
    const map = JSON.parse(await readFile(path.join(root, "assets.json"), "utf8"));
    assert.deepEqual(map.files, [level('{"b":2}')]);
    const admitted = JSON.parse(await readFile(`${root.slice(0, -4)}.admitted`, "utf8"));
    assert.deepEqual(
      admitted.map((row: { path: string; bytes: number }) => [row.path, row.bytes]),
      [
        ["assets.json", (await readFile(path.join(root, "assets.json"))).length],
        ["assets/levels/one.json", 7],
      ],
    );
  });

  it("a file the map does not plan, a ranged file or a texture with families needs the import step", async () => {
    const root = await webBuild(
      [
        { ...level("{}"), path: "t/bark.png" },
        { path: "t/bark.bc.ktx2", bytes: 1, fnv1a64: "0", family: "bc", of: "t/bark.png" },
        { path: "t/far.ktx2", bytes: 1, fnv1a64: "0", group: "stream", ranges: [] },
      ],
      {},
    );
    for (const rel of ["levels/unplanned.json", "t/far.ktx2", "t/bark.png"]) {
      assert.equal(await webSwapRefusal(root, [{ ...swap("x"), path: rel }]), LiveAssetsRebuild.Import, rel);
    }
  });
});

describe("LiveAssets (the watcher and Reload's swap)", () => {
  /** A watch the test fires by hand. */
  function handWatch(): FolderWatch & { fire(name: string | null): void; closed: number } {
    let listener: ((name: string | null) => void) | null = null;
    const watch = Object.assign(
      (_dir: string, on: (name: string | null) => void) => {
        listener = on;
        return { close: () => (watch.closed += 1) };
      },
      { fire: (name: string | null) => listener?.(name), closed: 0 },
    );
    return watch;
  }

  async function rig(files: Record<string, string | Buffer>, shown: Partial<ShownGame> = {}) {
    const { game, served } = await gameAndServed(files);
    const timers = fakeTimers();
    const watch = handWatch();
    const sent: NativeReloadFile[][] = [];
    const offers: string[] = [];
    const caughtUp: string[] = [];
    const game1: ShownGame = {
      assetsDir: served,
      webRoot: null,
      serves: async () => true,
      reload: async (named) => {
        sent.push(named);
        return { reloaded: named.map((file) => file.path), refused: [], pending: named.length };
      },
      ...shown,
    };
    const deps: LiveAssetsDeps = {
      gameDir: () => game,
      shown: (project) => (project === "forest" ? game1 : null),
      offer: (project) => offers.push(project),
      caughtUp: async (project) => {
        caughtUp.push(project);
      },
      timers,
      watch,
    };
    return { live: new LiveAssets(deps), game, served, timers, watch, sent, offers, caughtUp };
  }

  it("a shown Live game's changed 2k texture swaps in by one reloadAssets, under 1 s, with no build", async () => {
    // A 2048 x 2048 RGBA texture's worth of bytes: what the swap reads, compares and places.
    const old = Buffer.alloc(2048 * 2048 * 4, 1);
    const next = Buffer.alloc(2048 * 2048 * 4, 2);
    const t = await rig({ "textures/bark.png": old });
    t.live.liveLoaded("forest");
    await writeFile(path.join(t.game, "assets", "textures", "bark.png"), next);
    t.watch.fire("assets/textures/bark.png");
    t.timers.advance(ASSET_WATCH_DEBOUNCE_MS);
    assert.deepEqual(t.offers, ["forest"], "the batch lights Reload through Live's gate");
    const started = performance.now();
    const answer = await t.live.reload("forest");
    const elapsed = performance.now() - started;
    assert.deepEqual(answer, {
      outcome: LiveAssetsOutcome.Swapped,
      reason: null,
      reloaded: ["textures/bark.png"],
      pending: 1,
    });
    assert.deepEqual(t.sent, [[{ path: "textures/bark.png", digest: fnv1a64Hex(next) }]]);
    assert.ok((await readFile(path.join(t.served, "textures", "bark.png"))).equals(next));
    assert.deepEqual(t.caughtUp, ["forest"], "nothing waits for Reload any more");
    assert.ok(elapsed < SECOND_MS, `the swap took ${elapsed.toFixed(0)} ms`);
  });

  it("a code change since Live loaded answers source and places nothing; a new load clears it", async () => {
    const t = await rig({ "levels/one.json": "{}" });
    t.live.liveLoaded("forest");
    await writeFile(path.join(t.game, "assets", "levels", "one.json"), '{"x":1}');
    t.watch.fire("assets/levels/one.json");
    t.watch.fire("src/main.rs");
    t.timers.advance(ASSET_WATCH_DEBOUNCE_MS);
    assert.deepEqual(await t.live.reload("forest"), {
      outcome: LiveAssetsOutcome.Rebuild,
      reason: LiveAssetsRebuild.Source,
      reloaded: [],
      pending: 0,
    });
    assert.equal(await readFile(path.join(t.served, "levels", "one.json"), "utf8"), "{}");
    assert.equal(t.sent.length, 0);
    t.live.liveLoaded("forest");
    assert.equal(t.watch.closed, 1, "the old watch stopped");
    assert.equal((await t.live.reload("forest")).outcome, LiveAssetsOutcome.Swapped);
  });

  it("another game, a build that does not serve the op and an unchanged folder each answer their rebuild", async () => {
    const t = await rig({ "levels/one.json": "{}" });
    assert.equal((await t.live.reload("desert")).reason, LiveAssetsRebuild.NoRun);
    assert.equal((await t.live.reload("forest")).reason, LiveAssetsRebuild.Unchanged);
    const old = await rig({ "levels/one.json": "{}" }, { serves: async () => false });
    assert.equal((await old.live.reload("forest")).reason, LiveAssetsRebuild.NotServed);
  });

  it("a file the game refuses answers refused, and Live is not marked level with the folder", async () => {
    const t = await rig(
      { "levels/one.json": "{}" },
      {
        reload: async (named) => ({
          reloaded: [],
          refused: named.map((file) => ({ path: file.path, code: "missing" as const })),
          pending: 0,
        }),
      },
    );
    await writeFile(path.join(t.game, "assets", "levels", "one.json"), '{"x":1}');
    const answer = await t.live.reload("forest");
    assert.equal(answer.reason, LiveAssetsRebuild.Refused);
    assert.deepEqual(t.caughtUp, []);
  });
});
