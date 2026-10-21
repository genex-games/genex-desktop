/**
 * The Rust build lane's bake step (game systems NAV-14b, `src/main/rust-bake.ts`): a dev build's
 * advertised bakes run in a headless session and land in the stage's `out/assets/baked/<kind>/<name>`
 * and the profile cache keyed by the input digest, never in the game folder; an unchanged rebuild
 * spawns nothing; hostile names and linked folders write nothing; the lock records `derived` rows.
 *
 * The session is a fake that writes what the game would into the run's `state/bakes/` and answers
 * as genex-studio's `bakeAssets` does (size and FNV-1a 64). The lane rows drive `RustBuilds` over a
 * stub cargo, as `rust-build.test.ts` does. The real game's side is `crates/genex/tests/nav_bake.rs`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { AssetLockState, hashAssetEntries, readAssetLock, refreshAssetLock } from "../../src/main/asset-db.ts";
import { walkGameAssets } from "../../src/main/game-assets.ts";
import {
  BAKE_CACHE_FOLDER,
  BAKED_ASSETS_FOLDER,
  type BakeSession,
  type BakeRuns,
  BakeRefusal,
  BakeSource,
  bakeCacheFolder,
  bakeInputDigest,
  bakeInSession,
  nativeBakeSessions,
  placeCachedBakes,
  recordBakesInLock,
  type RustBakeOptions,
} from "../../src/main/rust-bake.ts";
import {
  lastAdmitted,
  RustBuilds,
  type RustBuildSandbox,
  type RustStaged,
  type RustToolchain,
} from "../../src/main/rust-build.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { BuildTarget, GameStack, ProjectKind, type ProjectShape } from "../../src/shared/game-project.ts";
import {
  BakeKind,
  NativeBackend,
  NativeGpuTier,
  type NativeBakeRef,
  NativeOp,
  NativeOpError,
  NativeRunMode,
  parseNativeCapabilityReceipt,
} from "../../src/shared/native-contract.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { fnv1a64Hex, NativeOpRefusedError } from "../../src/substrate/native-game-port.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import type { XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LOCK_DIGEST = "0123456789abcdef".repeat(4);
const NAVMESH = Buffer.from("GXNV navmesh bytes for the market");
const SOURCE_WITH_BAKE = 'fn main() { game.nav_bake("market", |_gfx| input()); }\n';
const SKIP_ON_WINDOWS = process.platform === "win32" ? "the stub cargo is a POSIX shell script" : false;

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const exists = async (file: string): Promise<boolean> => (await lstat(file).catch(() => null)) !== null;

/** Every file below `dir` (links listed, not followed), `/`-separated. */
async function listTree(dir: string, rel = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listTree(dir, child)));
    else files.push(child);
  }
  return files.sort();
}

/** A stage as the stager leaves it: a manifest, the sources and one asset. */
async function stageOf(parent: string, source = SOURCE_WITH_BAKE): Promise<string> {
  const stage = path.join(parent, "bin.stage");
  await mkdir(path.join(stage, "src"), { recursive: true });
  await mkdir(path.join(stage, "assets"), { recursive: true });
  await writeFile(path.join(stage, "Cargo.toml"), '[package]\nname = "game"\n');
  await writeFile(path.join(stage, "src", "main.rs"), source);
  await writeFile(path.join(stage, "assets", "floor.glb"), "floor");
  return stage;
}

/** What one fake session saw. */
interface SessionLog {
  opened: number;
  asked: NativeBakeRef[];
  closed: number;
}

/**
 * A session whose game advertises `bakes` and answers each the way genex-studio does: the output
 * written into `<state>/bakes/<kind>/<name>`, answered with its size and FNV-1a 64. `answer`
 * overrides one bake's behaviour.
 */
function fakeSession(
  parent: string,
  bakes: readonly unknown[],
  answer: (ref: NativeBakeRef, state: string) => Promise<unknown> = writeLikeTheGame(NAVMESH),
) {
  const log: SessionLog = { opened: 0, asked: [], closed: 0 };
  const state = path.join(parent, `run-${Math.random().toString(16).slice(2)}`, "state");
  const open = async (): Promise<BakeSession> => {
    log.opened += 1;
    await mkdir(state, { recursive: true });
    return {
      bakes,
      state,
      bake: async (ref) => {
        log.asked.push(ref);
        return await answer(ref, state);
      },
      close: async () => {
        log.closed += 1;
      },
    };
  };
  return { open, log, state };
}

/** The game's side of `bakeAssets`: `bytes` written into the run's state, the reply as genex-studio sends it. */
function writeLikeTheGame(bytes: Uint8Array) {
  return async (ref: NativeBakeRef, state: string) => {
    const folder = path.join(state, "bakes", ref.kind);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, ref.name), bytes);
    return { kind: ref.kind, name: ref.name, bytes: bytes.length, digest: fnv1a64Hex(bytes) };
  };
}

/** A fresh out, cache and stage under one test folder. */
async function layout(source?: string) {
  const parent = await tmpDir("rust-bake-");
  const out = path.join(parent, "bin.out");
  await mkdir(out);
  const stage = await stageOf(parent, source);
  const cache = path.join(parent, "cache", "game");
  const input = await bakeInputDigest(stage, LOCK_DIGEST);
  return { parent, out, stage, cache, input };
}

const NAV_MARKET: NativeBakeRef = { kind: BakeKind.Nav, name: "market" };

describe("rust-bake: the receipt advertises a dev build's bakes", () => {
  const receipt = {
    tier: NativeGpuTier.Core,
    backend: NativeBackend.Metal,
    adapter: "Apple M4 Max",
    nativeEnhanced: [],
    extensionApi: 1,
    customPassApi: 1,
  };

  it("keeps `bakes` (the host dropped it, so no build step could know what to ask)", () => {
    const parsed = parseNativeCapabilityReceipt({
      ...receipt,
      bakes: [NAV_MARKET, { kind: BakeKind.Nav, name: "roof" }],
    });
    assert.deepEqual(parsed?.bakes, [NAV_MARKET, { kind: BakeKind.Nav, name: "roof" }]);
    assert.equal(parseNativeCapabilityReceipt(receipt)?.bakes, undefined, "a receipt without bakes has none");
  });

  it("refuses a receipt whose bakes are out of shape: a hostile name, an unknown kind, a repeat", () => {
    for (const bakes of [
      [{ kind: BakeKind.Nav, name: "../escape" }],
      [{ kind: "shader", name: "market" }],
      [NAV_MARKET, NAV_MARKET],
      "market",
    ]) {
      assert.equal(parseNativeCapabilityReceipt({ ...receipt, bakes }), null, JSON.stringify(bakes));
    }
  });

  it("names the game's bake refusals in the op-error vocabulary", () => {
    assert.equal(NativeOpError.UnknownBake, "unknown-bake");
    assert.equal(NativeOpError.BakeTooLarge, "bake-too-large");
    assert.equal(NativeOp.BakeAssets, "bakeAssets");
  });
});

describe("rust-bake: the input digest", () => {
  it("changes with a source, an asset or the toolchain lock, never with the host-written manifest", async () => {
    const { stage, input } = await layout();
    await writeFile(path.join(stage, "Cargo.toml"), '[package]\nname = "game"\n[features]\nstudio = []\n');
    await writeFile(path.join(stage, "Cargo.lock"), "version = 4\n");
    assert.equal(await bakeInputDigest(stage, LOCK_DIGEST), input, "manifest and lock are the host's");
    assert.notEqual(await bakeInputDigest(stage, "f".repeat(64)), input, "another toolchain lock");
    await writeFile(path.join(stage, "assets", "floor.glb"), "a wider floor");
    const afterAsset = await bakeInputDigest(stage, LOCK_DIGEST);
    assert.notEqual(afterAsset, input, "an asset edit");
    await writeFile(path.join(stage, "src", "main.rs"), `${SOURCE_WITH_BAKE}// edit\n`);
    assert.notEqual(await bakeInputDigest(stage, LOCK_DIGEST), afterAsset, "a source edit");
  });
});

describe("rust-bake: a session bakes into the stage and the cache", () => {
  it("writes each advertised bake to out/assets/baked/<kind>/<name> and the cache, then closes the session", async () => {
    const { out, stage, cache, input } = await layout();
    const session = fakeSession(path.dirname(out), [NAV_MARKET]);
    const report = await bakeInSession({ out, stage, input, cache, open: session.open });
    assert.equal(report.source, BakeSource.Session);
    assert.deepEqual(report.refused, []);
    assert.deepEqual(
      report.baked.map(({ kind, name, bytes }) => ({ kind, name, bytes })),
      [{ kind: BakeKind.Nav, name: "market", bytes: NAVMESH.length }],
    );
    assert.deepEqual(await readFile(path.join(out, "assets", BAKED_ASSETS_FOLDER, "nav", "market")), NAVMESH);
    assert.deepEqual(await readFile(path.join(cache, input, "nav", "market")), NAVMESH);
    assert.equal(report.baked[0]?.sha256, sha256(NAVMESH));
    assert.deepEqual(session.log, { opened: 1, asked: [NAV_MARKET], closed: 1 });
  });

  it("an unchanged rebuild spawns no bake: the cache's entry is placed and no session opens", async () => {
    const { parent, out, stage, cache, input } = await layout();
    const first = fakeSession(parent, [NAV_MARKET]);
    await bakeInSession({ out, stage, input, cache, open: first.open });
    const again = path.join(parent, "second.out");
    await mkdir(again);
    const second = fakeSession(parent, [NAV_MARKET]);
    const report = await bakeInSession({ out: again, stage, input, cache, open: second.open });
    assert.equal(report.source, BakeSource.Cache);
    assert.equal(report.spawned, false);
    assert.equal(second.log.opened, 0, "no session for an input the cache holds");
    assert.deepEqual(await readFile(path.join(again, "assets", BAKED_ASSETS_FOLDER, "nav", "market")), NAVMESH);
  });

  it("a changed input bakes again; a game that registers no bake spawns nothing", async () => {
    const { parent, out, stage, cache, input } = await layout();
    await bakeInSession({ out, stage, input, cache, open: fakeSession(parent, [NAV_MARKET]).open });
    await writeFile(path.join(stage, "assets", "floor.glb"), "a wider floor");
    const changed = await bakeInputDigest(stage, LOCK_DIGEST);
    const rebake = fakeSession(parent, [NAV_MARKET]);
    await bakeInSession({ out, stage, input: changed, cache, open: rebake.open });
    assert.equal(rebake.log.opened, 1);

    const plain = await layout("fn main() {}\n");
    const quiet = fakeSession(plain.parent, [NAV_MARKET]);
    const report = await bakeInSession({ ...plain, open: quiet.open });
    assert.equal(report.source, BakeSource.None);
    assert.equal(quiet.log.opened, 0);
    assert.equal((await bakeInSession({ ...plain, open: quiet.open })).source, BakeSource.Cache, "recorded as empty");
  });

  it("places a cache entry only whole: a tampered file is a miss with nothing placed", async () => {
    const { parent, out, stage, cache, input } = await layout();
    await bakeInSession({ out, stage, input, cache, open: fakeSession(parent, [NAV_MARKET]).open });
    await writeFile(path.join(cache, input, "nav", "market"), "tampered");
    const fresh = path.join(parent, "fresh.out");
    await mkdir(fresh);
    assert.equal(await placeCachedBakes(fresh, cache, input), null);
    assert.deepEqual(await listTree(fresh), []);
  });

  it("keeps the game's own refusal code and records no cache entry, so the next build asks again", async () => {
    const { parent, out, stage, cache, input } = await layout();
    const refusing = fakeSession(parent, [NAV_MARKET], async () => {
      throw new NativeOpRefusedError(NativeOp.BakeAssets, NativeOpError.UnknownBake);
    });
    const report = await bakeInSession({ out, stage, input, cache, open: refusing.open });
    assert.deepEqual(report.refused, [{ kind: BakeKind.Nav, name: "market", code: NativeOpError.UnknownBake }]);
    assert.equal(await exists(path.join(cache, input, "bakes.json")), false);
    assert.equal(refusing.log.closed, 1);
    const retry = fakeSession(parent, [NAV_MARKET]);
    await bakeInSession({ out, stage, input, cache, open: retry.open });
    assert.equal(retry.log.opened, 1);
  });

  it("refuses an output whose size or digest is not the reply's, and a reply about another bake", async () => {
    const { parent, out, stage, cache, input } = await layout();
    const lying = fakeSession(parent, [NAV_MARKET], async (ref, state) => {
      const reply = (await writeLikeTheGame(NAVMESH)(ref, state)) as Record<string, unknown>;
      return { ...reply, digest: "0".repeat(16) };
    });
    const mismatch = await bakeInSession({ out, stage, input, cache, open: lying.open });
    assert.deepEqual(
      mismatch.refused.map((r) => r.code),
      [BakeRefusal.OutputMismatch],
    );
    const other = fakeSession(parent, [NAV_MARKET], async () => ({
      kind: "nav",
      name: "roof",
      bytes: 1,
      digest: "0".repeat(16),
    }));
    const wrong = await bakeInSession({ out, stage, input, cache, open: other.open });
    assert.deepEqual(
      wrong.refused.map((r) => r.code),
      [BakeRefusal.ReplyInvalid],
    );
    assert.deepEqual(await listTree(out), [], "nothing reached the stage");
  });
});

describe("rust-bake: impostor atlases (LOD-23)", () => {
  it("a game that registers only an impostor bake opens a session; its atlas lands in out/assets/baked/impostor", async () => {
    const source =
      'fn main() { game.impostor_bake(|gfx| gfx.assets().model("oak.glb").with_impostor(Impostor::hemi())); }\n';
    const { parent, out, stage, cache, input } = await layout(source);
    const atlas: NativeBakeRef = { kind: BakeKind.Impostor, name: "edde49b302d8b9e8-high" };
    const session = fakeSession(parent, [atlas]);
    const report = await bakeInSession({ out, stage, input, cache, open: session.open });
    assert.equal(session.log.opened, 1, "the registration scan sees impostor_bake");
    assert.deepEqual(report.refused, []);
    assert.deepEqual(
      report.baked.map(({ kind, name }) => ({ kind, name })),
      [atlas],
    );
    assert.deepEqual(await readFile(path.join(out, "assets", BAKED_ASSETS_FOLDER, "impostor", atlas.name)), NAVMESH);
  });
});

describe("rust-bake: hostile names and folders write nothing", () => {
  const HOSTILE_NAMES = ["..", "../escape", "/etc/passwd", "a\\b", "a\u0000b", ".hidden", "Market", "", "a".repeat(65)];

  for (const name of HOSTILE_NAMES) {
    it(`refuses the advertised name ${JSON.stringify(name.slice(0, 12))} before asking, with no file written`, async () => {
      const { parent, out, stage, cache, input } = await layout();
      const session = fakeSession(parent, [{ kind: BakeKind.Nav, name }]);
      const report = await bakeInSession({ out, stage, input, cache, open: session.open });
      assert.deepEqual(
        report.refused.map((r) => r.code),
        [BakeRefusal.UnsafeName],
      );
      assert.deepEqual(session.log.asked, [], "the game is never asked");
      assert.deepEqual(await listTree(out), []);
      assert.equal(await exists(path.join(cache, input)), false);
    });
  }

  it("refuses an unknown kind before asking", async () => {
    const { parent, out, stage, cache, input } = await layout();
    const session = fakeSession(parent, [{ kind: "shader", name: "market" }]);
    const report = await bakeInSession({ out, stage, input, cache, open: session.open });
    assert.deepEqual(
      report.refused.map((r) => r.code),
      [BakeRefusal.UnsafeName],
    );
    assert.deepEqual(session.log.asked, []);
  });

  it("a linked stage folder (out/assets/baked) is refused and nothing is written through it", async () => {
    const { parent, out, stage, cache, input } = await layout();
    const elsewhere = path.join(parent, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(path.join(out, "assets"));
    await symlink(elsewhere, path.join(out, "assets", BAKED_ASSETS_FOLDER));
    const session = fakeSession(parent, [NAV_MARKET]);
    const report = await bakeInSession({ out, stage, input, cache, open: session.open });
    assert.deepEqual(
      report.refused.map((r) => r.code),
      [BakeRefusal.UnsafeFolder],
    );
    assert.deepEqual(await listTree(elsewhere), [], "nothing through the link");
  });

  it("a linked state folder in the run (state/bakes/nav) is refused: the output is not read through it", async () => {
    const { parent, out, stage, cache, input } = await layout();
    const secret = path.join(parent, "secret");
    await mkdir(secret);
    await writeFile(path.join(secret, "market"), NAVMESH);
    const session = fakeSession(parent, [NAV_MARKET], async (ref, state) => {
      await mkdir(path.join(state, "bakes"), { recursive: true });
      await symlink(secret, path.join(state, "bakes", ref.kind));
      return { kind: ref.kind, name: ref.name, bytes: NAVMESH.length, digest: fnv1a64Hex(NAVMESH) };
    });
    const report = await bakeInSession({ out, stage, input, cache, open: session.open });
    assert.deepEqual(
      report.refused.map((r) => r.code),
      [BakeRefusal.OutputUnreadable],
    );
    assert.deepEqual(await listTree(out), []);
  });

  it("a linked output file in the run is refused", async () => {
    const { parent, out, stage, cache, input } = await layout();
    const secret = path.join(parent, "secret-file");
    await writeFile(secret, NAVMESH);
    const session = fakeSession(parent, [NAV_MARKET], async (ref, state) => {
      await mkdir(path.join(state, "bakes", ref.kind), { recursive: true });
      await symlink(secret, path.join(state, "bakes", ref.kind, ref.name));
      return { kind: ref.kind, name: ref.name, bytes: NAVMESH.length, digest: fnv1a64Hex(NAVMESH) };
    });
    const report = await bakeInSession({ out, stage, input, cache, open: session.open });
    assert.deepEqual(
      report.refused.map((r) => r.code),
      [BakeRefusal.OutputUnreadable],
    );
  });
});

describe("rust-bake: lock derived rows (C-4)", () => {
  it("records each bake in a trusted lock, and leaves a missing lock missing", async () => {
    const dir = await tmpDir("rust-bake-lock-");
    await mkdir(path.join(dir, "assets"), { recursive: true });
    await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Game"\n');
    await writeFile(path.join(dir, "assets", "floor.glb"), "floor");
    const baked = [
      {
        kind: BakeKind.Nav,
        name: "market",
        sha256: sha256(NAVMESH),
        bytes: NAVMESH.length,
        digest: fnv1a64Hex(NAVMESH),
      },
    ];
    assert.equal(await recordBakesInLock(dir, baked, "a".repeat(64)), false, "no lock: nothing written");
    const walk = await walkGameAssets(dir);
    await refreshAssetLock(dir, await hashAssetEntries(dir, walk.entries));
    assert.equal(await recordBakesInLock(dir, baked, "a".repeat(64)), true);
    const read = await readAssetLock(dir);
    assert.equal(read.state, AssetLockState.Trusted);
    assert.deepEqual(
      read.derived.map(({ kind, name, params, sha256: sum, bytes }) => ({ kind, name, params, sum, bytes })),
      [{ kind: BakeKind.Nav, name: "market", params: "a".repeat(64), sum: sha256(NAVMESH), bytes: NAVMESH.length }],
    );
    assert.deepEqual(read.derived[0]?.inputs, read.entries.map((entry) => entry.id).sort());
    assert.equal(await recordBakesInLock(dir, baked, "a".repeat(64)), false, "unchanged: not rewritten");
  });
});

// ---- The lane: RustBuilds over a stub cargo ----

const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: LOCK_DIGEST,
};
const RUST_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.rs",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RustWgpu,
  serve: ".",
};
const LOCK_FILE = [
  "version = 4",
  "",
  "[[package]]",
  'name = "game"',
  'version = "0.0.0"',
  'dependencies = ["genex"]',
  "",
  "[[package]]",
  'name = "genex"',
  'version = "0.1.0"',
  "",
].join("\n");
const RUSTC_VV =
  "rustc 1.99.0 (1d4e1a2b3 2026-09-17)\nbinary: rustc\ncommit-hash: 1d4e1a2b3c4d5e6f\ncommit-date: 2026-09-17\nhost: aarch64-apple-darwin\nrelease: 1.99.0\nLLVM version: 21.1.2";
const xcode: XcodeExec = async (file) =>
  file.endsWith("xcode-select")
    ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
    : { code: 0, stdout: "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk\n", stderr: "" };

const shellWord = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** A stub cargo: writes the lock, passes clippy, and builds a shell script as the game. */
function stubCargo(): string {
  const artifact =
    '{"reason":"compiler-artifact","package_id":"path+file://STAGE#game@0.0.0","manifest_path":"MANIFEST",' +
    '"target":{"kind":["bin"],"crate_types":["bin"],"name":"game"},"filenames":["EXE"],"executable":"EXE","fresh":false}';
  return `#!/bin/sh
sub=$1
shift
manifest=""
prev=""
for a in "$@"; do
  if [ "$prev" = --manifest-path ]; then manifest=$a; fi
  prev=$a
done
case "$sub" in
  generate-lockfile) printf '%s' ${shellWord(LOCK_FILE)} > "$(dirname "$manifest")/Cargo.lock" ;;
  clippy) echo '{"reason":"build-finished","success":true}' ;;
  build)
    exe="$CARGO_TARGET_DIR/aarch64-apple-darwin/debug/game-5d41402abc"
    mkdir -p "$(dirname "$exe")"
    printf '#!/bin/sh\\necho game\\n' > "$exe"
    chmod +x "$exe"
    echo '${artifact}' | sed -e "s#STAGE#$(dirname "$manifest")#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
esac
exit 0
`;
}

/** `request` run by /bin/sh, uncontained (the lane's sandbox is `rust-build.test.ts`'s subject). */
async function runShell(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut: false,
        truncated: false,
        sandboxed: false,
        command: request.command,
        cwd: request.cwd,
      }),
    );
  });
}

/** Copies the game's src/ and assets/ into the stage and writes a manifest, as M2.2's stager does. */
async function stage(game: { dir: string }, into: string): Promise<RustStaged> {
  for (const folder of ["src", "assets"]) {
    await mkdir(path.join(into, folder), { recursive: true });
    for (const name of await readdir(path.join(game.dir, folder))) {
      const from = path.join(game.dir, folder, name);
      if ((await stat(from)).isFile()) await writeFile(path.join(into, folder, name), await readFile(from));
    }
  }
  const manifest =
    '[package]\nname = "game"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\ngenex = "=0.1.0"\n';
  await writeFile(path.join(into, "Cargo.toml"), manifest);
  return { ok: true, dependencies: ["genex"], nativeFeatures: [] };
}

/** A Rust lane over the stub toolchain with the bake step, its cache in `parent/cache/<project>`. */
async function bakingLane(parent: string, open: RustBakeOptions["open"], opensFor?: RustBakeOptions["opensFor"]) {
  const bin = path.join(parent, "toolchain", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "cargo"), stubCargo(), { mode: 0o755 });
  await writeFile(path.join(bin, "rustc"), `#!/bin/sh\nprintf '%s\\n' ${shellWord(RUSTC_VV)}\n`, { mode: 0o755 });
  const vendor = path.join(parent, "toolchain", "vendor");
  await mkdir(vendor, { recursive: true });
  const conf = path.join(parent, "toolchain", "clippy");
  await mkdir(conf, { recursive: true });
  await writeFile(path.join(conf, "clippy.toml"), "disallowed-types = []\n");
  const toolchain: RustToolchain = { bin, vendor, clippyConf: conf, reads: [path.join(parent, "toolchain")] };
  const sandbox = async (): Promise<RustBuildSandbox> => ({ run: runShell, dispose: async () => {} });
  return new RustBuilds({
    root: path.join(parent, "rust-builds"),
    sandbox,
    locate: async () => ({ ok: true, toolchain }),
    currentLock: async () => LOCK,
    stage,
    emit: () => {},
    platform: "darwin",
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    exec: xcode,
    bakes: {
      cache: (project) => path.join(parent, "cache", project),
      ...(open ? { open } : {}),
      ...(opensFor ? { opensFor } : {}),
    },
  });
}

/** A Rust game that registers a nav bake, with one asset. */
async function bakingGame(parent: string): Promise<GameBuildGame> {
  const dir = path.join(parent, "game");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Game"\n');
  await writeFile(path.join(dir, "src", "main.rs"), SOURCE_WITH_BAKE);
  await writeFile(path.join(dir, "assets", "floor.txt"), "floor");
  const destinations = { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] };
  return { project: "game", dir, shape: { ...RUST_SHAPE }, destinations };
}

describe("rust-bake: the build lane's step", { skip: SKIP_ON_WINDOWS }, () => {
  it("a dev build bakes into its admitted out/, never the game folder; an unchanged rebuild spawns no bake", async () => {
    const parent = await tmpDir("rust-bake-lane-");
    const runs: Array<Parameters<NonNullable<RustBakeOptions["open"]>>[0]> = [];
    const session = fakeSession(parent, [NAV_MARKET]);
    const builds = await bakingLane(parent, async (run) => {
      runs.push(run);
      return await session.open();
    });
    const game = await bakingGame(parent);
    const before = await listTree(game.dir);

    const first = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(first.ok, true, first.problem?.lines?.join("\n"));
    const out = first.output ?? "";
    assert.deepEqual(await readFile(path.join(out, "assets", BAKED_ASSETS_FOLDER, "nav", "market")), NAVMESH);
    assert.equal(session.log.opened, 1);
    // The session starts from the admitted build in flight: its out/, lock and admitted digests.
    assert.equal(runs[0]?.out, out);
    assert.equal(runs[0]?.lock.digest, LOCK_DIGEST);
    assert.ok(
      runs[0]?.outputs.some((file) => file.path === "game"),
      "the admitted executable is named",
    );
    assert.equal(await lastAdmitted(out.replace(/\.out$/, "")), out, "the baked out/ is the admitted one");
    const shipped = first.rust?.receipt?.outputs.map((file) => file.path) ?? [];
    assert.ok(shipped.includes("assets/baked/nav/market"), shipped.join(", "));
    assert.deepEqual(await listTree(game.dir), before, "nothing written in the game folder");

    const second = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(second.ok, true);
    assert.equal(session.log.opened, 1, "an unchanged rebuild spawns no bake");
    assert.deepEqual(
      await readFile(path.join(second.output ?? "", "assets", BAKED_ASSETS_FOLDER, "nav", "market")),
      NAVMESH,
    );
    assert.equal(await lastAdmitted((second.output ?? "").replace(/\.out$/, "")), second.output);

    await writeFile(path.join(game.dir, "assets", "floor.txt"), "a wider floor");
    await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(session.log.opened, 2, "a changed input bakes once more");
  });

  it("an export never opens a session, and takes the cache's bakes for the same input", async () => {
    const parent = await tmpDir("rust-bake-export-");
    const session = fakeSession(parent, [NAV_MARKET]);
    const builds = await bakingLane(parent, async () => await session.open());
    const game = await bakingGame(parent);
    const cold = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Export);
    assert.equal(cold.ok, true, cold.problem?.lines?.join("\n"));
    assert.equal(session.log.opened, 0, "an export cannot bake");
    assert.equal(await exists(path.join(cold.output ?? "", "assets", BAKED_ASSETS_FOLDER)), false);
    await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    const warm = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Export);
    assert.deepEqual(
      await readFile(path.join(warm.output ?? "", "assets", BAKED_ASSETS_FOLDER, "nav", "market")),
      NAVMESH,
    );
    assert.equal(session.log.opened, 1);
    await rm(path.join(parent, "cache"), { recursive: true, force: true });
  });
});

describe("rust-bake: a destination no headless run serves", { skip: SKIP_ON_WINDOWS }, () => {
  it("opens no session there and records no entry, so a destination that can bake still does", async () => {
    const parent = await tmpDir("rust-bake-opens-");
    const session = fakeSession(parent, [NAV_MARKET]);
    const open = async () => await session.open();
    const game = await bakingGame(parent);
    const refusing = await bakingLane(parent, open, () => false);
    const built = await refusing.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, built.problem?.lines?.join("\n"));
    assert.equal(session.log.opened, 0, "no session for a destination without a headless run");
    assert.equal(await exists(path.join(built.output ?? "", "assets", BAKED_ASSETS_FOLDER)), false);
    assert.deepEqual(await listTree(path.join(parent, "cache")), [], "no cache entry recorded");
    await writeFile(path.join(game.dir, "assets", "floor.txt"), "another floor");
    const serving = await bakingLane(parent, open, (target) => target === BuildTarget.Mac);
    await serving.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(session.log.opened, 1, "the destination a headless run serves bakes");
  });
});

// ---- The session: a headless run of the admitted dev build, through the native run registry ----

const RUN_ID = "0123456789ab";
const ADMITTED = [{ path: "game-headless", sha256: "c".repeat(64) }];

/** A run registry that starts one headless run whose game advertises `receipt` and answers every `bakeAssets`. */
function fakeRuns(receipt: { bakes?: readonly unknown[] } | null, refuse: Error | null = null) {
  const log = { started: [] as unknown[], calls: [] as unknown[], stopped: [] as string[] };
  const runs: BakeRuns = {
    start: async (request) => {
      log.started.push(request);
      if (refuse) throw refuse;
      const call = async (op: string, arg: NativeBakeRef) => {
        log.calls.push({ op, arg });
        return { kind: arg.kind, name: arg.name, bytes: 0, digest: "0".repeat(16) };
      };
      return { status: { runId: RUN_ID, receipt }, port: { call } };
    },
    stop: async (runId) => {
      log.stopped.push(runId);
    },
  };
  return { runs, log };
}

describe("rust-bake: a dev build's session is a headless run of its admitted output", () => {
  const signal = new AbortController().signal;
  const run = { project: "game", target: BuildTarget.Mac, out: "/b/bin.out", signal, lock: LOCK, outputs: ADMITTED };

  it("starts a headless run of the prebuilt output, asks its port, reads its state and stops it once", async () => {
    const { runs, log } = fakeRuns({ bakes: [NAV_MARKET] });
    const sessions = nativeBakeSessions({ runs: () => runs, runsRoot: "/runs", targets: [BuildTarget.Mac] });
    const session = await sessions.open(run);
    assert.deepEqual(log.started, [
      {
        project: "game",
        target: BuildTarget.Mac,
        mode: NativeRunMode.Headless,
        prebuilt: { output: "/b/bin.out", lock: LOCK, admittedFiles: ADMITTED },
        signal,
      },
    ]);
    assert.deepEqual(session.bakes, [NAV_MARKET]);
    assert.equal(session.state, path.join("/runs", RUN_ID, "state"));
    await session.bake(NAV_MARKET);
    assert.deepEqual(log.calls, [{ op: NativeOp.BakeAssets, arg: NAV_MARKET }]);
    await session.close();
    await session.close();
    assert.deepEqual(log.stopped, [RUN_ID], "stopped once");
  });

  it("a receipt without bakes advertises none; a refused start rejects and leaves nothing running", async () => {
    const quiet = fakeRuns(null);
    const none = await nativeBakeSessions({ runs: () => quiet.runs, runsRoot: "/runs", targets: [] }).open(run);
    assert.deepEqual(none.bakes, []);
    const refused = fakeRuns({ bakes: [NAV_MARKET] }, new Error("build-failed"));
    const sessions = nativeBakeSessions({ runs: () => refused.runs, runsRoot: "/runs", targets: [BuildTarget.Mac] });
    await assert.rejects(sessions.open(run), /build-failed/);
    assert.deepEqual(refused.log.stopped, []);
  });

  it("opens only for the destinations a headless run serves", () => {
    const { runs } = fakeRuns(null);
    const sessions = nativeBakeSessions({ runs: () => runs, runsRoot: "/runs", targets: [BuildTarget.Mac] });
    assert.equal(sessions.opensFor(BuildTarget.Mac), true);
    for (const target of [
      BuildTarget.Web,
      BuildTarget.Windows,
      BuildTarget.Linux,
      BuildTarget.Ios,
      BuildTarget.Android,
    ])
      assert.equal(sessions.opensFor(target), false, target);
  });
});

describe("rust-bake: a project's cache folder", () => {
  const HOSTILE = ["..", "../escape", "/etc", "a\\b", "a\u0000b", "", ".", "game/../../x", "C:\\x"];

  it("is one folder below the import cache's bakes/ for every project name, hostile ones included", () => {
    const root = path.join("/profile", "asset-cache");
    const folders = new Set<string>();
    for (const project of ["game", ...HOSTILE]) {
      const folder = bakeCacheFolder(root, project);
      assert.equal(path.dirname(folder), path.join(root, BAKE_CACHE_FOLDER), JSON.stringify(project));
      assert.match(path.basename(folder), /^[0-9a-f]{32}$/, JSON.stringify(project));
      folders.add(folder);
    }
    assert.equal(folders.size, HOSTILE.length + 1, "each project its own folder");
    assert.equal(bakeCacheFolder(root, "game"), bakeCacheFolder(root, "game"), "stable");
  });
});
