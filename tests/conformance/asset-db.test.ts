import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import {
  type AssetLockFacts,
  AssetLockState,
  assetOriginOf,
  hashAssetEntries,
  hashGameFile,
  parseAssetLock,
  readAssetLock,
  refreshAssetLock,
  resolveAssetLock,
  serializeAssetLock,
  withDerived,
} from "../../src/main/asset-db.ts";
import { walkGameAssets } from "../../src/main/game-assets.ts";
import {
  ASSET_LOCK_FILE,
  ASSET_LOCK_VERSION,
  AssetLicence,
  type AssetLock,
  type AssetLockDerived,
  AssetOrigin,
  ImportIssueCode,
} from "../../src/shared/asset-db.ts";
import { BakeKind } from "../../src/shared/native-contract.ts";

/** Creating a link needs a privilege a Windows runner may lack. */
const LINKS = { skip: process.platform === "win32" && "symlinks need a privilege on Windows" };
const ROOT = path.resolve(import.meta.dirname, "../..");
/** The template game's lock must stay this small (C-4 acceptance). */
const TEMPLATE_LOCK_MAX_BYTES = 2048;

/** Ids from a counter, so two runs of a test mint the same ones. */
function counterIds(prefix = "a"): () => string {
  let next = 0;
  return () => `${prefix}${(next++).toString(16).padStart(15, "0")}`;
}

async function game(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("asset-db-");
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body);
  }
  return dir;
}

/** What the build lane would hand the lock: every walked file, hashed. */
async function factsOf(dir: string): Promise<AssetLockFacts[]> {
  const walk = await walkGameAssets(dir);
  return hashAssetEntries(dir, walk.entries);
}

const lockText = (dir: string): Promise<string> => readFile(path.join(dir, ASSET_LOCK_FILE), "utf8");
const idOf = (lock: AssetLock, file: string): string | undefined => lock.entries.find((e) => e.path === file)?.id;

describe("asset-db: stable ids", () => {
  it("a rename keeps the id through sha256", async () => {
    const dir = await game({ "assets/rock.glb": "rock-bytes", "assets/tree.png": "tree-bytes" });
    const first = await refreshAssetLock(dir, await factsOf(dir));
    const rock = idOf(first.lock, "assets/rock.glb");
    const tree = idOf(first.lock, "assets/tree.png");
    assert.ok(rock && tree && rock !== tree);

    await mkdir(path.join(dir, "assets/props"));
    await rename(path.join(dir, "assets/rock.glb"), path.join(dir, "assets/props/rock.glb"));
    const second = await refreshAssetLock(dir, await factsOf(dir));
    assert.equal(idOf(second.lock, "assets/props/rock.glb"), rock);
    assert.equal(idOf(second.lock, "assets/rock.glb"), undefined);
    assert.equal(idOf(second.lock, "assets/tree.png"), tree);
    assert.deepEqual(second.issues, []);
  });

  it("an edit in place keeps the id; a copy beside a kept file gets a new one", async () => {
    const dir = await game({ "assets/rock.glb": "rock-bytes" });
    const first = await refreshAssetLock(dir, await factsOf(dir));
    const rock = idOf(first.lock, "assets/rock.glb");

    await writeFile(path.join(dir, "assets/rock.glb"), "rock-bytes-v2");
    await writeFile(path.join(dir, "assets/rock-copy.glb"), "rock-bytes-v2");
    const second = await refreshAssetLock(dir, await factsOf(dir));
    assert.equal(idOf(second.lock, "assets/rock.glb"), rock);
    const copy = idOf(second.lock, "assets/rock-copy.glb");
    assert.ok(copy && copy !== rock);
  });

  it("deps name ids, and provenance the import step omits carries over", async () => {
    const dir = await game({ "assets/ship.obj": "v 0 0 0", "assets/ship.png": "png-bytes" });
    const facts = await factsOf(dir);
    const withOrigin = facts.map((fact) =>
      fact.path === "assets/ship.obj"
        ? {
            ...fact,
            origin: AssetOrigin.Cc0,
            licence: AssetLicence.Cc0,
            deps: ["assets/ship.png", "assets/gone.png", "assets/ship.png"],
          }
        : fact,
    );
    const first = await refreshAssetLock(dir, withOrigin);
    const ship = first.lock.entries.find((e) => e.path === "assets/ship.obj");
    assert.deepEqual(ship?.deps, [idOf(first.lock, "assets/ship.png")]);
    assert.equal(ship?.origin, AssetOrigin.Cc0);

    const second = await refreshAssetLock(dir, facts);
    const again = second.lock.entries.find((e) => e.path === "assets/ship.obj");
    assert.equal(again?.origin, AssetOrigin.Cc0);
    assert.equal(again?.licence, AssetLicence.Cc0);
    assert.deepEqual(again?.deps, ship?.deps);
    assert.equal(second.lock.entries.find((e) => e.path === "assets/ship.png")?.origin, AssetOrigin.Person);
  });

  it("maps the inventory's source to an origin and licence", () => {
    assert.deepEqual(assetOriginOf("genex"), { origin: AssetOrigin.Genex, licence: AssetLicence.Generated });
    assert.deepEqual(assetOriginOf("blender"), { origin: AssetOrigin.Blender, licence: AssetLicence.Generated });
    assert.deepEqual(assetOriginOf("imported"), { origin: AssetOrigin.Person, licence: AssetLicence.Unknown });
    assert.deepEqual(assetOriginOf("some-plugin"), { origin: AssetOrigin.Delivered, licence: AssetLicence.Unknown });
  });
});

describe("asset-db: a lock someone edited", () => {
  it("a hand-edited lock is rewritten from the files and reports lock-edited", async () => {
    const dir = await game({ "assets/rock.glb": "rock-bytes", "assets/tree.png": "tree-bytes" });
    const first = await refreshAssetLock(dir, await factsOf(dir));
    const clean = await lockText(dir);

    const edited = clean.replace(`"licence": "${AssetLicence.Unknown}"`, `"licence": "${AssetLicence.Cc0}"`);
    assert.notEqual(edited, clean);
    await writeFile(path.join(dir, ASSET_LOCK_FILE), edited);
    assert.equal((await readAssetLock(dir)).state, AssetLockState.Edited);

    const second = await refreshAssetLock(dir, await factsOf(dir));
    assert.deepEqual(second.issues, [{ code: ImportIssueCode.LockEdited }]);
    assert.equal(second.written, true);
    assert.equal(await lockText(dir), clean, "rewritten from the files, ids kept where path and digest match");
    assert.equal(idOf(second.lock, "assets/rock.glb"), idOf(first.lock, "assets/rock.glb"));
  });

  it("an edited lock passes no id on through a rename and drops its derived rows", async () => {
    const dir = await game({ "assets/rock.glb": "rock-bytes" });
    const first = await refreshAssetLock(dir, await factsOf(dir));
    const rock = idOf(first.lock, "assets/rock.glb") ?? "";
    const baked = withDerived(first.lock, navRow([rock]));
    await writeFile(path.join(dir, ASSET_LOCK_FILE), serializeAssetLock(baked).replace(rock, "ffffffffffffffff"));
    await mkdir(path.join(dir, "assets/props"));
    await rename(path.join(dir, "assets/rock.glb"), path.join(dir, "assets/props/rock.glb"));

    const second = await refreshAssetLock(dir, await factsOf(dir));
    assert.deepEqual(second.issues, [{ code: ImportIssueCode.LockEdited }]);
    const moved = idOf(second.lock, "assets/props/rock.glb");
    assert.ok(moved && moved !== "ffffffffffffffff" && moved !== rock);
    assert.deepEqual(second.lock.derived, []);
  });

  it(
    "a lock that is not JSON, or a link, is rewritten and reports lock-edited; the link's target is untouched",
    LINKS,
    async () => {
      const dir = await game({ "assets/rock.glb": "rock-bytes" });
      await writeFile(path.join(dir, ASSET_LOCK_FILE), "{ not json");
      const garbled = await refreshAssetLock(dir, await factsOf(dir));
      assert.deepEqual(garbled.issues, [{ code: ImportIssueCode.LockEdited }]);
      assert.equal(parseAssetLock(await lockText(dir)).state, AssetLockState.Trusted);

      const outside = await game({ "target.lock": serializeAssetLock(garbled.lock) });
      const target = path.join(outside, "target.lock");
      const before = await readFile(target, "utf8");
      await rename(path.join(dir, ASSET_LOCK_FILE), path.join(dir, "old.lock"));
      await symlink(target, path.join(dir, ASSET_LOCK_FILE));
      assert.equal((await readAssetLock(dir)).state, AssetLockState.Edited);
      const linked = await refreshAssetLock(dir, await factsOf(dir));
      assert.deepEqual(linked.issues, [{ code: ImportIssueCode.LockEdited }]);
      assert.equal(await readFile(target, "utf8"), before, "never written through the link");
      assert.ok((await stat(path.join(dir, ASSET_LOCK_FILE))).isFile());
    },
  );

  it("a lock of another version is rewritten without keeping its ids", async () => {
    const dir = await game({ "assets/rock.glb": "rock-bytes" });
    const facts = await factsOf(dir);
    const foreign = JSON.stringify({
      version: ASSET_LOCK_VERSION + 1,
      entries: [{ id: "0123456789abcdef", path: "assets/rock.glb", sha256: facts[0]?.sha256 }],
    });
    await writeFile(path.join(dir, ASSET_LOCK_FILE), foreign);
    assert.equal((await readAssetLock(dir)).state, AssetLockState.OtherVersion);
    const next = await refreshAssetLock(dir, facts);
    assert.deepEqual(next.issues, []);
    assert.notEqual(idOf(next.lock, "assets/rock.glb"), "0123456789abcdef");
    assert.equal(JSON.parse(await lockText(dir)).version, ASSET_LOCK_VERSION);
  });
});

describe("asset-db: byte-identical locks", () => {
  it("two imports of one tree write byte-identical locks", async () => {
    const dir = await game({ "assets/b.glb": "b", "assets/a.png": "a", "public/assets/c.ogg": "c" });
    const facts = await factsOf(dir);
    const first = await refreshAssetLock(dir, facts);
    assert.equal(first.written, true);
    const text = await lockText(dir);
    const second = await refreshAssetLock(dir, [...facts].reverse());
    assert.equal(second.written, false);
    assert.equal(await lockText(dir), text);
    assert.deepEqual(
      first.lock.entries.map((e) => e.path),
      ["assets/a.png", "assets/b.glb", "public/assets/c.ogg"],
    );
  });

  it("fresh imports in any fact order serialize the same, ids drawn in path order", async () => {
    const dir = await game({ "assets/b.glb": "b", "assets/a.png": "a" });
    const facts = await factsOf(dir);
    const missing = parseAssetLock(null);
    const one = resolveAssetLock(missing, facts, { newId: counterIds() });
    const two = resolveAssetLock(missing, [...facts].reverse(), { newId: counterIds() });
    assert.equal(serializeAssetLock(one.lock), serializeAssetLock(two.lock));
    assert.equal(idOf(one.lock, "assets/a.png"), "a000000000000000");
  });

  it("a checkout that turned the lock's line ends to CRLF still trusts it", async () => {
    const dir = await game({ "assets/rock.glb": "rock-bytes" });
    await refreshAssetLock(dir, await factsOf(dir));
    const crlf = (await lockText(dir)).replaceAll("\n", "\r\n");
    assert.equal(parseAssetLock(crlf).state, AssetLockState.Trusted);
  });

  it("the template game's lock stays under 2 KB and is versioned", async () => {
    const dir = await tmpDir("asset-db-template-");
    await cp(path.join(ROOT, "src/game-template-rust"), dir, { recursive: true });
    const result = await refreshAssetLock(dir, await factsOf(dir));
    const bytes = (await stat(path.join(dir, ASSET_LOCK_FILE))).size;
    assert.ok(bytes < TEMPLATE_LOCK_MAX_BYTES, `template lock is ${bytes} bytes`);
    assert.equal(result.lock.version, ASSET_LOCK_VERSION);
    assert.equal(JSON.parse(await lockText(dir)).version, ASSET_LOCK_VERSION);
  });
});

describe("asset-db: hostile paths", () => {
  const HOSTILE = [
    { why: "absolute", path: "/etc/passwd" },
    { why: "climbs", path: "../outside/x.glb" },
    { why: "climbs inside", path: "assets/../../x.glb" },
    { why: "backslash", path: "assets\\x.glb" },
    { why: "dot segment", path: "./assets/x.glb" },
    { why: "empty", path: "" },
    { why: "control", path: "assets/x\u0000.glb" },
  ];

  it("hostile lock rows are ignored with no read, and their ids never pass to a file", async () => {
    const dir = await game({ "assets/rock.glb": "rock-bytes" });
    const facts = await factsOf(dir);
    const sha = facts[0]?.sha256 ?? "";
    const rows = HOSTILE.map((row, n) => ({ ...entry(`${n}`.padStart(16, "e"), row.path, sha) }));
    const planted: AssetLock = { version: ASSET_LOCK_VERSION, entries: rows, derived: [] };
    await writeFile(path.join(dir, ASSET_LOCK_FILE), serializeAssetLock(planted));
    const read = await readAssetLock(dir);
    assert.equal(read.state, AssetLockState.Trusted);
    assert.deepEqual(read.entries, []);
    assert.deepEqual(read.ignored.sort(), HOSTILE.map((row) => row.path).sort());

    const hashed: string[] = [];
    const spy = async (root: string, rel: string): Promise<string | null> => {
      hashed.push(rel);
      return hashGameFile(root, rel);
    };
    const walk = await walkGameAssets(dir);
    const next = await refreshAssetLock(dir, await hashAssetEntries(dir, walk.entries, spy));
    assert.deepEqual(hashed, ["assets/rock.glb"]);
    assert.deepEqual(
      next.lock.entries.map((e) => e.path),
      ["assets/rock.glb"],
    );
    assert.ok(!rows.some((row) => row.id === idOf(next.lock, "assets/rock.glb")));
  });

  it("a hostile output path or a malformed field on a row is dropped, the row kept", async () => {
    const dir = await game({ "assets/rock.glb": "rock-bytes" });
    const facts = await factsOf(dir);
    const row = {
      ...entry("0123456789abcdef", "assets/rock.glb", facts[0]?.sha256 ?? ""),
      origin: "pirate",
      outputs: [
        { file: "../../etc/passwd", sha256: "0".repeat(64), bytes: 1 },
        { file: "assets/rock.glb", sha256: "1".repeat(64), bytes: 10 },
      ],
    };
    const text = serializeAssetLock({
      version: ASSET_LOCK_VERSION,
      entries: [row],
      derived: [],
    } as unknown as AssetLock);
    const read = parseAssetLock(text);
    assert.equal(read.entries[0]?.origin, AssetOrigin.Person);
    assert.deepEqual(
      read.entries[0]?.outputs.map((o) => o.file),
      ["assets/rock.glb"],
    );
  });

  it("hashGameFile reads nothing through a link, out of the game, or that is not a file", LINKS, async () => {
    const outside = await game({ "secret.glb": "secret" });
    const dir = await game({ "assets/rock.glb": "rock-bytes" });
    await symlink(path.join(outside, "secret.glb"), path.join(dir, "assets/link.glb"));
    await symlink(outside, path.join(dir, "assets/linked-dir"));
    await mkdir(path.join(dir, "assets/folder.glb"));
    for (const rel of [
      "assets/link.glb",
      "assets/linked-dir/secret.glb",
      "assets/folder.glb",
      "../secret.glb",
      "/etc/passwd",
      "assets/missing.glb",
      ...HOSTILE.map((row) => row.path),
    ]) {
      assert.equal(await hashGameFile(dir, rel), null, rel);
    }
    assert.match((await hashGameFile(dir, "assets/rock.glb")) ?? "", /^[0-9a-f]{64}$/);
  });
});

describe("asset-db: derived rows", () => {
  it("records, replaces and sorts bakes; drops one whose input vanished", async () => {
    const dir = await game({ "assets/level.glb": "level", "assets/rock.glb": "rock" });
    const first = await refreshAssetLock(dir, await factsOf(dir));
    const level = idOf(first.lock, "assets/level.glb") ?? "";
    const rock = idOf(first.lock, "assets/rock.glb") ?? "";
    let lock = withDerived(first.lock, navRow([level]));
    lock = withDerived(lock, { ...navRow([rock]), kind: BakeKind.Impostor, name: "rock" });
    lock = withDerived(lock, { ...navRow([rock, level]), sha256: "2".repeat(64) });
    assert.deepEqual(
      lock.derived.map((d) => [d.kind, d.name, d.inputs, d.sha256]),
      [
        [BakeKind.Impostor, "rock", [rock], "1".repeat(64)],
        [BakeKind.Nav, "level", [level, rock].sort(), "2".repeat(64)],
      ],
    );
    assert.throws(() => withDerived(lock, navRow(["ffffffffffffffff"])));
    await writeFile(path.join(dir, ASSET_LOCK_FILE), serializeAssetLock(lock));

    const kept = await refreshAssetLock(dir, await factsOf(dir));
    assert.deepEqual(kept.lock.derived, lock.derived);

    await unlink(path.join(dir, "assets/rock.glb"));
    const after = await refreshAssetLock(dir, await factsOf(dir));
    assert.deepEqual(after.lock.derived, []);
  });
});

function entry(id: string, file: string, sha256: string) {
  return {
    id,
    path: file,
    sha256,
    kind: "model" as const,
    origin: AssetOrigin.Person,
    licence: AssetLicence.Unknown,
    settings: {},
    importer: "",
    deps: [],
    outputs: [],
    issues: [],
  };
}

function navRow(inputs: string[]): AssetLockDerived {
  return { kind: BakeKind.Nav, name: "level", inputs, params: "p".repeat(16), sha256: "1".repeat(64), bytes: 64 };
}
