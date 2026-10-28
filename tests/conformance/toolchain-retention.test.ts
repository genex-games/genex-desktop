/**
 * Per-stack locks, adoption of an existing raylib store and lock retention
 * (`src/substrate/toolchain-store/{lock,retention}.ts`, `ToolchainService.prune`): the Rust lock
 * lives beside raylib's `current-lock.json` without touching it, an existing store is read in
 * place, and a game recorded on an older Rust lock keeps locating its sysroot after a lock bump
 * while the sweep keeps it; only a lock no game references is swept.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { rustPayloadDir, shippedGenexRelease, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import { ToolchainService } from "../../src/main/core/toolchains.ts";
import { PreviewService } from "../../src/main/core/previews.ts";
import { type CoreInternals, idleWork, unservedPreviews } from "../../src/main/core/internals.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { RustFlavour } from "../../src/main/rust-manifest.ts";
import { fixtureRustWebOutput, seedFixtureRustStore } from "../../src/main/dev/fixture-rust.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import {
  LOCK_FILE_OF_STACK,
  ToolchainHost,
  ToolchainId,
  type ToolchainLock,
  ToolchainPruneRefusal,
} from "../../src/shared/toolchain.ts";
import { readReceipts } from "../../src/substrate/toolchain-store/install.ts";
import { componentFolder, locateStackComponents } from "../../src/substrate/toolchain-store/locate.ts";
import {
  CURRENT_LOCK_FILE,
  isStoreLockFile,
  LOCK_RECORDS_FOLDER,
  lockOf,
  readCurrentLock,
  readRecordedLock,
  writeCurrentLock,
} from "../../src/substrate/toolchain-store/lock.ts";
import { lockForGame, retainedLocks, stackOfLock } from "../../src/substrate/toolchain-store/retention.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32" ? { skip: "symlink rows need POSIX links" } : {};

/** The component ids a v1 Studio (before Rust games) knows: what it reads from a store. */
const V1_IDS: readonly string[] = [
  "cmake",
  "ninja",
  "emsdk",
  "zig",
  "llvm-mingw",
  "raylib",
  "angle-macos",
  "angle-windows",
  "angle-linux",
  "linux-sysroot",
];

const sha12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** One installed component, as an install leaves it: its folder and a receipt naming its pin. */
async function installed(store: string, id: ToolchainId, version: string): Promise<{ version: string; sha12: string }> {
  const pin = { version, sha12: sha12(`${id}@${version}`) };
  const folder = componentFolder(store, id, pin);
  await mkdir(folder, { recursive: true });
  const receipt = {
    id,
    version,
    sha256: `${pin.sha12}${"0".repeat(52)}`,
    sha12: pin.sha12,
    bytes: 1,
    host: ToolchainHost.MacArm64,
    target: null,
    source: "archive",
    installedAt: "2026-10-06T00:00:00.000Z",
  };
  // A v1 Studio writes its receipts pretty-printed with a trailing newline.
  await writeFile(path.join(folder, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return pin;
}

/** A raylib store exactly as a v1 Studio leaves it: receipts, its prewarmed lock folder and `current-lock.json`. */
async function v1Store(): Promise<{ store: string; lock: ToolchainLock; lockBytes: Buffer }> {
  const store = path.join(await tmpDir("toolchain-retention-"), "toolchains");
  const entries: ToolchainLock["entries"] = {};
  for (const [id, version] of [
    [ToolchainId.Cmake, "4.4.3"],
    [ToolchainId.Ninja, "1.13.2"],
    [ToolchainId.RaylibSource, "6.0"],
  ] as const)
    entries[id] = await installed(store, id, version);
  const lock = lockOf(entries);
  await mkdir(path.join(store, "locks", lock.digest.slice(0, 12)), { recursive: true });
  await writeFile(path.join(store, "locks", lock.digest.slice(0, 12), "prewarm.json"), "{}\n");
  // What v1's `writeCurrentLock` wrote: `atomicWriteJson`, two-space JSON and a newline.
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(path.join(store, CURRENT_LOCK_FILE), lockBytes);
  return { store, lock, lockBytes };
}

/**
 * A Rust lock over a sysroot of `version` and everything a browser build needs, its components
 * installed; the web tools and the vendored set stay at one version across a bump.
 */
async function rustLock(store: string, version: string): Promise<ToolchainLock> {
  return lockOf({
    [ToolchainId.Rust]: await installed(store, ToolchainId.Rust, version),
    [ToolchainId.RustStdWasm]: await installed(store, ToolchainId.RustStdWasm, version),
    [ToolchainId.WasmBindgen]: await installed(store, ToolchainId.WasmBindgen, "0.2.129"),
    [ToolchainId.Binaryen]: await installed(store, ToolchainId.Binaryen, "133"),
    [ToolchainId.RustVendor]: await installed(store, ToolchainId.RustVendor, "0.1.0"),
  });
}

/** The base record a probed Rust lock folder holds (`rust-base.json`). */
function baseRecord(lock: ToolchainLock) {
  const vendor = { sha256: "0".repeat(64), files: 0, bytes: 0 };
  return { schema: 1, lock: lock.digest, triples: ["aarch64-apple-darwin"], vendor, at: "2026-10-25T00:00:00.000Z" };
}

/** Writes `lock`'s probed base into its lock folder, as an install leaves it. */
async function probedBase(store: string, lock: ToolchainLock): Promise<void> {
  const folder = path.join(store, "locks", lock.digest.slice(0, 12));
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "rust-base.json"), JSON.stringify(baseRecord(lock)));
}

/** Every path under `root` (`/`-separated), so "left as it was" and "removed" are checked whole. */
async function tree(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  return (await readdir(root, { recursive: true })).map((rel) => rel.split(path.sep).join("/")).sort();
}

/** A service over a real store; nothing it is given here runs a command or a download. */
function service(store: string): ToolchainService {
  return new ToolchainService({
    store,
    host: ToolchainHost.MacArm64,
    emit: () => {},
    run: async () => {
      throw new Error("no command runs in these rows");
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    probeClt: async () => ({ present: true, version: "16.0" }),
  });
}

describe("per-stack current locks", () => {
  it("a Rust lock goes to its own file and leaves raylib's current-lock.json byte for byte", async () => {
    const { store, lock, lockBytes } = await v1Store();
    const rust = await rustLock(store, "1.99.0");
    await writeCurrentLock(store, rust, GameStack.RustWgpu);
    assert.deepEqual(await readFile(path.join(store, CURRENT_LOCK_FILE)), lockBytes);
    assert.equal(LOCK_FILE_OF_STACK[GameStack.RustWgpu], "current-lock.rust-wgpu.json");
    assert.deepEqual(await readCurrentLock(store, GameStack.RustWgpu), rust);
    assert.deepEqual(await readCurrentLock(store), lock, "raylib's lock is still the default reader's");
    assert.equal(await readCurrentLock(store, GameStack.RaylibCpp).then((found) => found?.digest), lock.digest);
  });

  it("a raylib lock write never touches the Rust lock file", async () => {
    const { store, lock } = await v1Store();
    const rust = await rustLock(store, "1.99.0");
    await writeCurrentLock(store, rust, GameStack.RustWgpu);
    const rustFile = path.join(store, LOCK_FILE_OF_STACK[GameStack.RustWgpu]);
    const before = await readFile(rustFile);
    await writeCurrentLock(store, lock);
    assert.deepEqual(await readFile(rustFile), before);
  });

  const hostile: Array<{ name: string; file: (store: string, outside: string) => Promise<string> }> = [
    { name: "the Rust lock file itself", file: async (store) => path.join(store, "current-lock.rust-wgpu.json") },
    {
      name: "the Rust lock file spelled with .. segments",
      file: async (store) => path.join(store, "locks", "..", "current-lock.rust-wgpu.json"),
    },
    {
      name: "a link to the Rust lock file",
      file: async (store, outside) => {
        const at = path.join(outside, "lock.json");
        await symlink(path.join(store, "current-lock.rust-wgpu.json"), at);
        return at;
      },
    },
    {
      name: "a hard link of the Rust lock file",
      file: async (store, outside) => {
        const at = path.join(outside, "hard.json");
        await link(path.join(store, "current-lock.rust-wgpu.json"), at);
        return at;
      },
    },
    {
      name: "the Rust lock file through a linked store folder",
      file: async (store, outside) => {
        const at = path.join(outside, "store-link");
        await symlink(store, at);
        return path.join(at, "current-lock.rust-wgpu.json");
      },
    },
  ];
  for (const row of hostile) {
    it(`a worktree lock file that is ${row.name} is the store's own`, POSIX_ONLY, async () => {
      const { store } = await v1Store();
      await writeCurrentLock(store, await rustLock(store, "1.99.0"), GameStack.RustWgpu);
      const outside = path.join(path.dirname(store), "worktree");
      await mkdir(outside, { recursive: true });
      const before = await tree(store);
      assert.equal(await isStoreLockFile(store, await row.file(store, outside)), true);
      assert.deepEqual(await tree(store), before, "asking wrote nothing");
    });
  }

  it("a worktree's own lock file beside the store is not the store's", async () => {
    const { store } = await v1Store();
    assert.equal(await isStoreLockFile(store, path.join(path.dirname(store), "worktree-lock.json")), false);
  });
});

describe("an existing raylib store is adopted in place", () => {
  it("reads its lock, receipts and lock folder as they are, and a downgraded Studio still reads them", async () => {
    const { store, lock, lockBytes } = await v1Store();
    const v1Paths = await tree(store);
    const receipts = await readReceipts(store);
    const tools = service(store);
    const status = await tools.status();
    assert.equal(status.lock?.digest, lock.digest);
    assert.deepEqual(status.installed.map((item) => item.id).sort(), ["cmake", "ninja", "raylib"]);
    await writeCurrentLock(store, await rustLock(store, "1.99.0"), GameStack.RustWgpu);
    // A v1 Studio reads current-lock.json, `<id>/<version>-<sha12>/receipt.json` and `locks/`: all still there.
    for (const rel of v1Paths) assert.ok(existsSync(path.join(store, ...rel.split("/"))), rel);
    assert.deepEqual(await readFile(path.join(store, CURRENT_LOCK_FILE)), lockBytes);
    const raylib = JSON.parse(lockBytes.toString("utf8")) as ToolchainLock;
    for (const id of Object.keys(raylib.entries)) assert.ok(V1_IDS.includes(id), `${id} is an id a v1 Studio knows`);
    assert.deepEqual(
      (await readReceipts(store)).filter((receipt) => V1_IDS.includes(receipt.id)),
      receipts,
      "the raylib receipts read back unchanged",
    );
  });

  it("the current raylib lock reads back by its digest with no record written yet", async () => {
    const { store, lock } = await v1Store();
    assert.equal(existsSync(path.join(store, LOCK_RECORDS_FOLDER)), false);
    assert.deepEqual(await readRecordedLock(store, lock.digest), lock);
  });
});

describe("a game whose recorded Rust lock's toolchain is gone builds on the current lock (LK)", () => {
  /** A store whose Rust lock moved from 1.99.0 (`old`, still recorded) to 1.100.0 (`next`), both installed. */
  async function moved(): Promise<{ store: string; old: ToolchainLock; next: ToolchainLock }> {
    const { store } = await v1Store();
    const old = await rustLock(store, "1.99.0");
    await writeCurrentLock(store, old, GameStack.RustWgpu);
    await probedBase(store, old);
    const next = await rustLock(store, "1.100.0");
    await writeCurrentLock(store, next, GameStack.RustWgpu);
    await probedBase(store, next);
    return { store, old, next };
  }

  /** The service over `store` with a library recording `recorded` for every game. */
  function recording(store: string, recorded: unknown): ToolchainService {
    return new ToolchainService({
      store,
      host: ToolchainHost.MacArm64,
      emit: () => {},
      run: async () => {
        throw new Error("no command runs in these rows");
      },
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      probeClt: async () => ({ present: true, version: "16.0" }),
      recordedLock: async () => recorded,
    });
  }

  it("the old lock's folder removed (its record kept): the game builds on the current lock, never toolchain-missing", async () => {
    const { store, old, next } = await moved();
    await rm(path.join(store, "locks", old.digest.slice(0, 12)), { recursive: true, force: true });
    assert.deepEqual(await readRecordedLock(store, old.digest), old, "the record is still there");
    assert.deepEqual(await recording(store, old.digest).currentLock(GameStack.RustWgpu, "ferris"), next);
    assert.deepEqual(await lockForGame(store, GameStack.RustWgpu, old.digest), next);
  });

  it("the old lock's base unprobed or for another lock: the current lock", async () => {
    const { store, old, next } = await moved();
    const base = path.join(store, "locks", old.digest.slice(0, 12), "rust-base.json");
    await writeFile(base, "{}\n");
    assert.deepEqual(await recording(store, old.digest).currentLock(GameStack.RustWgpu, "ferris"), next);
    await writeFile(base, JSON.stringify({ ...baseRecord(next) }));
    assert.deepEqual(await recording(store, old.digest).currentLock(GameStack.RustWgpu, "ferris"), next);
  });

  it("the old lock still installed: the game keeps building on it (the lock is the person's to move)", async () => {
    const { store, old } = await moved();
    assert.deepEqual(await recording(store, old.digest).currentLock(GameStack.RustWgpu, "ferris"), old);
    assert.deepEqual(await lockForGame(store, GameStack.RustWgpu, old.digest), old);
  });
});

describe("lock retention across a Rust lock bump", () => {
  /** A store whose Rust lock moved from 1.99.0 (`old`) to 1.100.0 (`next`). */
  async function bumped(): Promise<{ store: string; old: ToolchainLock; next: ToolchainLock; raylib: ToolchainLock }> {
    const { store, lock: raylib } = await v1Store();
    const old = await rustLock(store, "1.99.0");
    await writeCurrentLock(store, old, GameStack.RustWgpu);
    // An installed lock's folder holds its probed base: what a game recorded on it builds on.
    await probedBase(store, old);
    const next = await rustLock(store, "1.100.0");
    await writeCurrentLock(store, next, GameStack.RustWgpu);
    return { store, old, next, raylib };
  }

  it("a game recorded on the old lock still builds on it and locates its sysroot", async () => {
    const { store, old, next } = await bumped();
    assert.equal((await readCurrentLock(store, GameStack.RustWgpu))?.digest, next.digest);
    assert.deepEqual(await lockForGame(store, GameStack.RustWgpu, old.digest), old);
    assert.deepEqual(await service(store).lockForGame(GameStack.RustWgpu, old.digest), old);
    const found = await locateStackComponents(store, old, GameStack.RustWgpu, [BuildTarget.Web]);
    assert.ok(found.ok, "the old sysroot is located");
    assert.match(found.components.get(ToolchainId.Rust)?.folder ?? "", /rust[/\\]1\.99\.0-[0-9a-f]{12}$/);
  });

  it("a new game, or one whose record is unreadable, builds on the current lock", async () => {
    const { store, next } = await bumped();
    assert.deepEqual(await lockForGame(store, GameStack.RustWgpu, undefined), next);
    assert.deepEqual(await lockForGame(store, GameStack.RustWgpu, "f".repeat(64)), next);
    assert.deepEqual(await lockForGame(store, GameStack.RustWgpu, "../current-lock"), next);
  });

  it("a raylib lock is never a Rust game's lock", async () => {
    const { store, raylib, next } = await bumped();
    assert.equal(stackOfLock(raylib), GameStack.RaylibCpp);
    assert.deepEqual(await lockForGame(store, GameStack.RustWgpu, raylib.digest), next);
  });

  it("the sweep keeps the old lock while a game references it", async () => {
    const { store, old, next, raylib } = await bumped();
    const result = await service(store).prune([old.digest, raylib.digest]);
    assert.equal(result.refused, undefined);
    assert.equal(result.removed, 0);
    for (const lock of [old, next])
      assert.ok((await locateStackComponents(store, lock, GameStack.RustWgpu, [BuildTarget.Web])).ok);
    assert.deepEqual(await readRecordedLock(store, old.digest), old);
    assert.ok(existsSync(path.join(store, "locks", old.digest.slice(0, 12))));
  });

  it("once no game references the old lock, the sweep removes its components, folder and record only", async () => {
    const { store, old, next, raylib } = await bumped();
    const result = await service(store).prune([next.digest]);
    assert.equal(result.refused, undefined);
    const oldRust = old.entries[ToolchainId.Rust];
    assert.ok(oldRust);
    assert.equal(existsSync(componentFolder(store, ToolchainId.Rust, oldRust)), false);
    assert.equal(existsSync(path.join(store, "locks", old.digest.slice(0, 12))), false);
    assert.equal(await readRecordedLock(store, old.digest), null);
    assert.ok((await locateStackComponents(store, next, GameStack.RustWgpu, [BuildTarget.Web])).ok);
    assert.deepEqual(await readCurrentLock(store), raylib, "raylib's current lock and its folder stay");
    assert.ok(existsSync(path.join(store, "locks", raylib.digest.slice(0, 12))));
  });

  it("a Rust game's lock, recorded by the library after its build, keeps the old lock through the bump's sweep", async () => {
    const { store, old, next } = await bumped();
    const { core } = await coreLite({ gamesRoot: await tmpDir("retention-rust-games-") });
    await core.games.scaffold("ferris", { title: "Ferris", stack: GameStack.RustWgpu, targets: [BuildTarget.Web] });
    await core.games.writeNativeLock("ferris", old.digest);
    const result = await service(store).prune(await core.games.nativeLocks());
    assert.equal(result.refused, undefined);
    assert.deepEqual(await readRecordedLock(store, old.digest), old, "the record the game names stays");
    assert.ok((await locateStackComponents(store, old, GameStack.RustWgpu, [BuildTarget.Web])).ok);
    assert.deepEqual(await service(store).lockForGame(GameStack.RustWgpu, old.digest), old, "it still builds on it");
    assert.deepEqual(await readCurrentLock(store, GameStack.RustWgpu), next);
  });

  it("a game on a lock the store cannot read back stops the sweep", async () => {
    const { store, old } = await bumped();
    const before = await tree(store);
    const unknown = await service(store).prune([old.digest, "a".repeat(64)]);
    assert.equal(unknown.refused, ToolchainPruneRefusal.UnknownGameLock);
    assert.deepEqual(await tree(store), before);
  });

  it("a tampered record is no record: the game's lock is unknown and nothing is swept", async () => {
    const { store, old, next } = await bumped();
    const record = path.join(store, LOCK_RECORDS_FOLDER, `${old.digest}.json`);
    await writeFile(record, `${JSON.stringify({ ...next, digest: old.digest }, null, 2)}\n`);
    assert.equal(await readRecordedLock(store, old.digest), null);
    const before = await tree(store);
    const result = await service(store).prune([old.digest]);
    assert.equal(result.refused, ToolchainPruneRefusal.UnknownGameLock);
    assert.deepEqual(await tree(store), before);
  });

  it("a record named for one lock and holding another is refused", async () => {
    const { store, old, next } = await bumped();
    await rm(path.join(store, LOCK_RECORDS_FOLDER, `${old.digest}.json`));
    await writeFile(path.join(store, LOCK_RECORDS_FOLDER, `${old.digest}.json`), JSON.stringify(next));
    assert.equal(await readRecordedLock(store, old.digest), null);
  });

  it("retainedLocks: no current lock, no game list, and an unreadable game lock each keep everything", async () => {
    const { store, old, next } = await bumped();
    const recorded = (digest: string) => readRecordedLock(store, digest);
    assert.equal(await retainedLocks([], [], recorded), ToolchainPruneRefusal.NoLock);
    assert.equal(await retainedLocks([next], undefined, recorded), ToolchainPruneRefusal.UnknownGameLock);
    assert.equal(await retainedLocks([next], ["b".repeat(64)], recorded), ToolchainPruneRefusal.UnknownGameLock);
    const kept = await retainedLocks([next], [old.digest, next.digest], recorded);
    assert.ok(Array.isArray(kept));
    assert.deepEqual(kept.map((lock) => lock.digest).sort(), [old.digest, next.digest].sort());
  });

  it(
    "a record is a plain file only the host writes: one replaced by a link reads as no record",
    POSIX_ONLY,
    async () => {
      const { store, old } = await bumped();
      const record = path.join(store, LOCK_RECORDS_FOLDER, `${old.digest}.json`);
      const elsewhere = path.join(path.dirname(store), "planted.json");
      await writeFile(elsewhere, await readFile(record));
      await rm(record);
      await symlink(elsewhere, record);
      assert.ok((await lstat(record)).isSymbolicLink());
      assert.equal(await readRecordedLock(store, old.digest), null);
    },
  );
});

describe("an app update moves the Rust lock on: a game built on the old lock keeps building on it (M6.4)", () => {
  const SKIP_UNLESS_MAC =
    process.platform === "darwin" ? {} : { skip: "the fixture's Rust Mac build is the Mac lane's" };
  const GAME = "ferris-update";
  /** The lock the update ships: the old one with a newer Rust pinned, whose parts were never downloaded here. */
  const nextOf = (old: ToolchainLock): ToolchainLock =>
    lockOf({ ...old.entries, [ToolchainId.Rust]: { version: "1.100.0", sha12: sha12("rust@1.100.0") } });

  /** A core whose fixture Rust store (lock N) built `GAME` once, so the library records lock N. */
  async function builtOnOldLock() {
    const lite = await coreLite({ developmentStacks: true });
    const { core } = lite;
    await core.games.scaffold(GAME, { title: "Ferris", stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] });
    const old = await seedFixtureRustStore(core.layout.toolchains, { webOutput: fixtureRustWebOutput() });
    assert.ok(old, "the stub Rust store seeded the profile's store");
    const call = (method: string, params: unknown) =>
      (lite.api() as unknown as Record<string, (p: unknown) => Promise<Record<string, unknown>>>)[method](params);
    const first = await call("native.build", { project: GAME, target: BuildTarget.Mac });
    assert.equal(first.ok, true, JSON.stringify(first.problem));
    assert.equal((await core.games.presentation(GAME)).native?.lock, old.digest, "the build recorded lock N");
    return { core, old, call };
  }

  it(
    "after the update and its sweep, the game builds offline on lock N, and a new game would use N+1",
    SKIP_UNLESS_MAC,
    async () => {
      const { core, old, call } = await builtOnOldLock();
      const next = nextOf(old);
      await writeCurrentLock(core.layout.toolchains, next, GameStack.RustWgpu);
      const swept = await core.toolchains.prune(await core.games.nativeLocks());
      assert.equal(swept.refused, undefined);
      assert.deepEqual(await readRecordedLock(core.layout.toolchains, old.digest), old, "lock N is kept");
      const rebuilt = await call("native.build", { project: GAME, target: BuildTarget.Mac });
      assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.problem));
      assert.equal(rebuilt.lock, old.digest.slice(0, 12), "built on the lock the game recorded");
      assert.deepEqual(await core.toolchains.currentLock(GameStack.RustWgpu), next);
    },
  );

  it(
    "a sweep told no game holds lock N removes it, and the game's next build is refused (the acceptance's negative control)",
    SKIP_UNLESS_MAC,
    async () => {
      const { core, old, call } = await builtOnOldLock();
      await writeCurrentLock(core.layout.toolchains, nextOf(old), GameStack.RustWgpu);
      const swept = await core.toolchains.prune([]);
      assert.equal(swept.refused, undefined);
      assert.equal(await readRecordedLock(core.layout.toolchains, old.digest), null, "lock N was swept");
      const rebuilt = await call("native.build", { project: GAME, target: BuildTarget.Mac });
      assert.equal(rebuilt.ok, false, "nothing builds a game whose lock was swept while it was offline");
    },
  );
});

describe("the preview's web build of a Rust game builds on the game's own lock (M6 review)", () => {
  const RETAINED = { digest: "a".repeat(64), entries: {} } as unknown as ToolchainLock;

  /** A preview service over one game, recording the lock its web build asks the lanes for and the lock lookups. */
  function previewOf(game: GameProject) {
    const asked: Array<ToolchainLock | null | undefined> = [];
    const looked: Array<{ stack: string; project?: string }> = [];
    const core = {
      games: { list: async () => [game], dirFor: () => game.dir },
      toolchains: {
        currentLock: async (stack: string, project?: string) => {
          looked.push({ stack, ...(project === undefined ? {} : { project }) });
          return RETAINED;
        },
      },
      emit: () => {},
    } as unknown as StudioCore;
    const state = {
      ...idleWork(),
      ...unservedPreviews(),
      buildProblems: new Map(),
      gameBuilds: {
        ensure: async (asks: GameBuildGame) => {
          asked.push(asks.lock);
          return { stack: GameStack.RustWgpu, target: BuildTarget.Web, refusal: null, outcome: undefined };
        },
      },
    } as unknown as CoreInternals;
    const port = { note: () => {} } as unknown as PreviewPort;
    return { service: new PreviewService(core, state), port, asked, looked };
  }

  const pond = (kind: ProjectKind, stack: GameStack): GameProject =>
    ({
      name: "pond",
      dir: "/games/pond",
      shape: { kind, entry: "index.html", main: "src/main.rs", build: null, install: null, own: false, serve: "." },
      destinations: { stack, targets: [BuildTarget.Web, BuildTarget.Mac] },
    }) as unknown as GameProject;

  for (const fallback of [true, false]) {
    it(`a Rust game's ${fallback ? "Live" : "judging"} preview asks for the lock the game recorded, never the store's current one`, async () => {
      const { service, port, asked, looked } = previewOf(pond(ProjectKind.RustWgpu, GameStack.RustWgpu));
      await service.servedEntry("pond", null, undefined, port, { fallback });
      assert.deepEqual(looked, [{ stack: GameStack.RustWgpu, project: "pond" }]);
      assert.deepEqual(asked, [RETAINED]);
    });
  }

  it("a raylib game's preview leaves its lock to the lane (raylib's current lock, as always)", async () => {
    const { service, port, asked, looked } = previewOf(pond(ProjectKind.RaylibCpp, GameStack.RaylibCpp));
    await service.servedEntry("pond", null, undefined, port);
    assert.deepEqual(looked, []);
    assert.deepEqual(asked, [null]);
  });
});

describe("a build on a retained lock stages the genex release that lock vendored (M6.4)", () => {
  /** A Rust lock whose vendored crate set is genex release `vendor` (a published release pins it by the genex version). */
  const lockVendoring = (vendor: string): ToolchainLock =>
    lockOf({
      [ToolchainId.Rust]: { version: "1.99.0", sha12: sha12("rust@1.99.0") },
      [ToolchainId.RustVendor]: { version: vendor, sha12: sha12(`rust-vendor@${vendor}`) },
    });

  /** The `genex = …` line `shippedRustStage` writes for a scaffolded game built on `lock`. */
  async function stagedGenex(lock: ToolchainLock): Promise<string | undefined> {
    const { core, resources } = await coreLite({ developmentStacks: true });
    await core.games.scaffold("ferris-pin", { title: "Ferris", stack: GameStack.RustWgpu, targets: [BuildTarget.Web] });
    const game = (await core.games.list()).find((listed) => listed.name === "ferris-pin");
    assert.ok(game);
    const into = path.join(await tmpDir("retention-stage-"), "stage");
    const stage = shippedRustStage(rustPayloadDir(resources));
    const staged = await stage({ project: game.name, dir: game.dir }, into, BuildTarget.Mac, RustFlavour.Export, lock);
    assert.equal(staged.ok, true, JSON.stringify(staged));
    const manifest = await readFile(path.join(into, "Cargo.toml"), "utf8");
    return manifest.split("\n").find((line) => line.startsWith("genex = "));
  }

  it("pins the release the lock's vendored set is, not the newer one the updated app ships", async () => {
    // Flipped (release R-2): the template switches nav, streaming and animation off, so the line keeps its other defaults.
    // Flipped again (gate GR): audio is off too, so physics is the one default kept.
    // Flipped again (shared physics P4): the deprecated physics-raw follows physics.
    assert.equal(
      await stagedGenex(lockVendoring("0.0.9")),
      'genex = { version = "=0.0.9", default-features = false, features = ["physics", "physics-raw"] }',
    );
  });

  it("a development vendored set (a pre-release version) stages the app's shipped release, as before", async () => {
    const shipped = await shippedGenexRelease(rustPayloadDir((await coreLite({ init: false })).resources));
    assert.ok(shipped);
    // Flipped (release R-2, again at gate GR and shared physics P4): the template's switches write the facade line
    // with its kept defaults, the deprecated physics-raw after physics.
    assert.equal(
      await stagedGenex(lockVendoring("0.0.0-dev")),
      `genex = { version = "=${shipped}", default-features = false, features = ["physics", "physics-raw"] }`,
    );
  });
});
