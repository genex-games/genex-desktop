/**
 * The `genex` release cut (M2.18, `scripts/toolchains/rust-release.ts`): a cut packs the reviewed
 * vendored tree into a reproducible archive, names it by a durable Genex release URL and writes the
 * Rust locks and release-manifest inputs it makes; publication stays the owner's step. The rows run
 * over a small synthetic vendored tree and workspace, never cargo: the real cut is the CLI's.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";
import { rustStoreInputs } from "../../scripts/release-manifest.mjs";
import {
  bumpWorkspace,
  copyPackageSources,
  cutRelease,
  GenexSource,
  pinRelease,
  type ReleaseRecord,
  ReleaseRefusal,
  ReleaseRefused,
  releaseAssetUrl,
  resolveGenex,
  vendorCrate,
  workspaceVersion,
  writeReleaseInventory,
} from "../../scripts/toolchains/rust-release.ts";
import { GameStack } from "../../src/shared/game-project.ts";
import { LOCK_FILE_OF_STACK, ToolchainHost, ToolchainId, ToolchainInstallPhase } from "../../src/shared/toolchain.ts";
import type { RunResult } from "../../src/substrate/spawn.ts";
import type { InstallDeps } from "../../src/substrate/toolchain-store/install.ts";
import { isToolchainLock } from "../../src/substrate/toolchain-store/lock.ts";
import { isReleaseUrl, rustManifestOf } from "../../src/substrate/toolchain-store/manifest.ts";
import { installRustVendor } from "../../src/substrate/toolchain-store/rust-install.ts";
import rustRecipe from "../../src/substrate/toolchain-store/rust-recipe.json" with { type: "json" };
import { tmpDir } from "../helpers/tmp.ts";

const VERSION = "0.1.0";
const NEXT = "0.2.0";
const VENDOR_FILE = "rust-vendor.tar.gz";
const execFileAsync = promisify(execFile);

/** A workspace manifest in the shape `native/genex-rust/Cargo.toml` has. */
const workspaceManifest = (version: string) =>
  [
    "[workspace]",
    'members = ["crates/genex", "crates/genex-core", "examples/*"]',
    "",
    "[workspace.package]",
    `version = "${version}"`,
    'edition = "2024"',
    "",
    "[workspace.dependencies]",
    `genex = { path = "crates/genex", version = "${version}" }`,
    `genex-core = { path = "crates/genex-core", version = "${version}" }`,
    'serde = { version = "0.1.0", default-features = false }',
    "",
  ].join("\n");

/** A version-4 lock: two workspace crates, an example at its own version and a registry crate at 0.1.0. */
const workspaceLock = (genex: string, core = genex) =>
  [
    "version = 4",
    "",
    "[[package]]",
    'name = "genex"',
    `version = "${genex}"`,
    "dependencies = [",
    ' "genex-core",',
    "]",
    "",
    "[[package]]",
    'name = "genex-core"',
    `version = "${core}"`,
    "",
    "[[package]]",
    'name = "pond"',
    'version = "0.0.0"',
    "",
    "[[package]]",
    'name = "serde"',
    'version = "0.1.0"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    `checksum = "${"0".repeat(64)}"`,
    "",
  ].join("\n");

interface Fixture {
  root: string;
  tree: string;
  workspace: string;
  inventory: string;
  out: string;
}

/** A vendored tree of two plain crates (genex packaged among them), a workspace and its reviewed inventory. */
async function fixture(version = VERSION): Promise<Fixture> {
  const root = await tmpDir("rust-release-");
  const tree = path.join(root, "vendor");
  for (const crate of [`genex-${version}`, "serde-0.1.0"]) {
    await mkdir(path.join(tree, crate, "src"), { recursive: true });
    await writeFile(path.join(tree, crate, "Cargo.toml"), `[package]\nname = "${crate}"\n`);
    await writeFile(path.join(tree, crate, "src", "lib.rs"), "pub fn f() {}\n");
    await writeFile(path.join(tree, crate, ".cargo-checksum.json"), '{"files":{},"package":"0"}');
  }
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "Cargo.toml"), workspaceManifest(version));
  await writeFile(path.join(workspace, "Cargo.lock"), workspaceLock(version));
  const inventory = path.join(root, "rust-inventory.json");
  await writeReleaseInventory(tree, workspace, inventory);
  return { root, tree, workspace, inventory, out: path.join(root, "out") };
}

const cut = (f: Fixture, extra: { releaseBase?: string; out?: string } = {}) =>
  cutRelease({
    tree: f.tree,
    workspace: f.workspace,
    inventory: f.inventory,
    out: f.out,
    recipe: rustRecipe,
    ...extra,
  });

/** The refusal code a promise rejects with, or "no refusal". */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReleaseRefused) return error.code;
    if (error instanceof Error && "code" in error) return String(error.code);
    throw error;
  }
  return "no refusal";
}

const listing = async (dir: string) => (existsSync(dir) ? (await readdir(dir)).sort() : []);

/** The committed recipe, written where a pin may rewrite it. */
async function recipeCopy(root: string): Promise<string> {
  const file = path.join(root, "rust-recipe.json");
  await writeFile(file, `${JSON.stringify(rustRecipe, null, 2)}\n`);
  return file;
}

test("a cut whose vendored tree digest differs from the inventory is refused, and writes nothing", async () => {
  const f = await fixture();
  await writeFile(path.join(f.tree, "serde-0.1.0", "src", "lib.rs"), "pub fn f() { /* changed */ }\n");
  assert.equal(await refusalOf(cut(f)), ReleaseRefusal.TreeMismatch);
  assert.deepEqual(await listing(f.out), [], "a refused cut leaves no archive, lock or record");
});

test("an inventory without a recorded release refuses the cut until it is rewritten", async () => {
  const f = await fixture();
  const inventory = JSON.parse(await readFile(f.inventory, "utf8")) as Record<string, unknown>;
  delete inventory.release;
  await writeFile(f.inventory, JSON.stringify(inventory));
  assert.equal(await refusalOf(cut(f)), ReleaseRefusal.NoRelease);
  assert.deepEqual(await listing(f.out), []);
});

test("the lock's genex version is the workspace version, on every host the recipe pins", async () => {
  const f = await fixture();
  const record = await cut(f);
  assert.equal(record.genex, await workspaceVersion(f.workspace));
  const hosts = Object.keys(record.locks).sort();
  assert.deepEqual(hosts, [ToolchainHost.MacArm64, ToolchainHost.LinuxX64].sort());
  for (const host of hosts) {
    const file = path.join(f.out, "locks", host, LOCK_FILE_OF_STACK[GameStack.RustWgpu]);
    const lock: unknown = JSON.parse(await readFile(file, "utf8"));
    assert.ok(isToolchainLock(lock), `${host}'s lock is well formed`);
    assert.equal(lock.entries[ToolchainId.RustVendor]?.version, VERSION);
    assert.equal(lock.entries[ToolchainId.Rust]?.version, "1.99.0");
    assert.deepEqual(record.locks[host]?.lock, lock);
    for (const component of record.locks[host]?.components ?? [])
      for (const url of component.urls) assert.ok(isReleaseUrl(component.id, url), `${url} is a durable release URL`);
  }
});

test("a workspace whose lock disagrees with its version, or with the reviewed release, is refused", async () => {
  const lockBehind = await fixture();
  await writeFile(path.join(lockBehind.workspace, "Cargo.lock"), workspaceLock(VERSION, "0.0.9"));
  assert.equal(await refusalOf(cut(lockBehind)), ReleaseRefusal.VersionMismatch);
  assert.deepEqual(await listing(lockBehind.out), []);

  const bumpedAfterReview = await fixture();
  await writeFile(path.join(bumpedAfterReview.workspace, "Cargo.toml"), workspaceManifest(NEXT));
  await writeFile(path.join(bumpedAfterReview.workspace, "Cargo.lock"), workspaceLock(NEXT));
  assert.equal(await refusalOf(cut(bumpedAfterReview)), ReleaseRefusal.VersionMismatch);
  assert.deepEqual(await listing(bumpedAfterReview.out), []);
});

test("a release URL outside the Genex release host is refused, at the cut and at the pin", async () => {
  const offHost = [
    "https://github.com/someone/genex-desktop/releases/download/",
    "https://github.com/genex-games/genex-desktop/releases/latest/download/",
    "https://github.com/genex-games/genex-desktop/actions/runs/1/artifacts/",
    "http://github.com/genex-games/genex-desktop/releases/download/",
    "https://user:token@github.com/genex-games/genex-desktop/releases/download/",
    "https://github.com/genex-games/genex-desktop/releases/download/../../../evil/",
    "not a url",
  ];
  for (const base of offHost) {
    const f = await fixture();
    assert.equal(await refusalOf(cut(f, { releaseBase: base })), ReleaseRefusal.OffHostUrl, base);
    assert.deepEqual(await listing(f.out), [], `nothing is written for ${base}`);
  }
  const f = await fixture();
  const record = await cut(f);
  const recipeFile = await recipeCopy(f.root);
  const before = await readFile(recipeFile, "utf8");
  const stray: ReleaseRecord = {
    ...record,
    recipeEntry: {
      ...record.recipeEntry,
      archives: record.recipeEntry.archives.map((archive) => ({ ...archive, url: "https://example.com/v.tar.gz" })),
    },
  };
  assert.equal(await refusalOf(pinRelease(recipeFile, stray)), ReleaseRefusal.OffHostUrl);
  assert.equal(await readFile(recipeFile, "utf8"), before, "a refused pin leaves the recipe as it was");
});

test("the release asset URL is the Genex release of the version", () => {
  const url = releaseAssetUrl(VERSION, VENDOR_FILE);
  assert.equal(url, "https://github.com/genex-games/genex-desktop/releases/download/genex-0.1.0/rust-vendor.tar.gz");
  assert.ok(isReleaseUrl(ToolchainId.RustVendor, url));
});

test("a dev build with no published release still resolves genex from the local workspace", async () => {
  const f = await fixture();
  const pinnedIds = rustManifestOf(rustRecipe).map((entry) => entry.id);
  assert.ok(!pinnedIds.includes(ToolchainId.RustVendor), "the committed recipe pins no genex release yet");
  const dev = await resolveGenex(rustRecipe, f.workspace, { dev: true });
  assert.deepEqual(dev, { source: GenexSource.Local, version: VERSION, workspace: f.workspace });
  assert.equal(await resolveGenex(rustRecipe, f.workspace, { dev: false }), null, "a product build has no release");

  const record = await cut(f);
  const recipeFile = await recipeCopy(f.root);
  await pinRelease(recipeFile, record);
  const pinned: unknown = JSON.parse(await readFile(recipeFile, "utf8"));
  const released = await resolveGenex(pinned, f.workspace, { dev: true });
  assert.equal(released?.source, GenexSource.Release, "once pinned, builds resolve the published release");
  await writeFile(path.join(f.workspace, "Cargo.toml"), workspaceManifest(NEXT));
  const ahead = await resolveGenex(pinned, f.workspace, { dev: true });
  assert.equal(ahead?.source, GenexSource.Local, "a workspace ahead of the published release builds locally");
  assert.equal(await resolveGenex(pinned, f.workspace, { dev: false }), null, "a product build never builds locally");
});

test("a pinned cut leaves the Rust store nothing unpinned and is what the release manifest records", async () => {
  const f = await fixture();
  const record = await cut(f);
  const recipeFile = await recipeCopy(f.root);
  await pinRelease(recipeFile, record);
  await pinRelease(recipeFile, record);
  const pinned: unknown = JSON.parse(await readFile(recipeFile, "utf8"));
  const store = rustStoreInputs(pinned);
  assert.deepEqual(store.unpinned, []);
  const vendorRows = store.inputs.filter((row: { id: string }) => row.id === ToolchainId.RustVendor);
  assert.equal(vendorRows.length, 1, "pinning twice keeps one vendored set");
  const inputs: unknown = JSON.parse(await readFile(path.join(f.out, "release-manifest-inputs.json"), "utf8"));
  assert.deepEqual(inputs, store, "the cut lists exactly the inputs the release manifest records once pinned");
});

test("the same tree cuts byte-identical archives and records", async () => {
  const f = await fixture();
  const first = await cut(f, { out: path.join(f.root, "first") });
  const second = await cut(f, { out: path.join(f.root, "second") });
  assert.deepEqual(first, second);
  const bytes = async (dir: string) => readFile(path.join(f.root, dir, VENDOR_FILE));
  assert.ok((await bytes("first")).equals(await bytes("second")));
  const record = async (dir: string) => readFile(path.join(f.root, dir, "release.json"), "utf8");
  assert.equal(await record("first"), await record("second"));
});

/** Install deps whose fetch answers `url` from `file` and nothing else; no probe runs for the vendored set. */
function serving(url: string, file: string): InstallDeps {
  const run = async (): Promise<RunResult> => ({
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    sandboxed: true,
    command: "",
    cwd: "",
  });
  return {
    fetch: async (asked: string) => {
      if (asked !== url) return new Response("absent", { status: 404 });
      const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
      return new Response(body, { status: 200, headers: { "content-length": String(statSync(file).size) } });
    },
    run,
    freeBytes: async () => 1024 ** 4,
    onJob: () => {},
  };
}

test("the pinned cut installs through the store's own reader and holds its tree digest, long paths included", async () => {
  const f = await fixture();
  const deep = `${"deep/".repeat(30)}file.rs`;
  await mkdir(path.dirname(path.join(f.tree, "serde-0.1.0", deep)), { recursive: true });
  await writeFile(path.join(f.tree, "serde-0.1.0", deep), "// a path longer than ustar's 100 bytes\n");
  await writeReleaseInventory(f.tree, f.workspace, f.inventory);
  const record = await cut(f);
  const recipeFile = await recipeCopy(f.root);
  await pinRelease(recipeFile, record);
  const pinned: unknown = JSON.parse(await readFile(recipeFile, "utf8"));
  const entry = rustManifestOf(pinned).find((item) => item.id === ToolchainId.RustVendor);
  assert.ok(entry, "the pinned recipe holds the vendored set");
  const store = path.join(f.root, "store");
  await mkdir(store);
  const job = await installRustVendor(
    store,
    entry,
    record.recipeEntry.tree,
    serving(record.vendor.url, path.join(f.out, VENDOR_FILE)),
  );
  assert.equal(job.phase, ToolchainInstallPhase.Installed, job.problem ?? "installed");
});

test("a vendored tree holding a link is refused before anything is written", async () => {
  const rows: Array<{ name: string; plant: (tree: string, root: string) => Promise<void> }> = [
    {
      name: "a file linked out of the tree",
      plant: async (tree, root) => {
        await writeFile(path.join(root, "secret"), "outside\n");
        await symlink(path.join(root, "secret"), path.join(tree, "serde-0.1.0", "src", "secret.rs"));
      },
    },
    {
      name: "a crate folder that is a link",
      plant: async (tree, root) => {
        await mkdir(path.join(root, "elsewhere"), { recursive: true });
        await symlink(path.join(root, "elsewhere"), path.join(tree, "linked-0.1.0"));
      },
    },
  ];
  for (const row of rows) {
    const f = await fixture();
    await row.plant(f.tree, f.root);
    assert.notEqual(await refusalOf(cut(f)), "no refusal", row.name);
    assert.deepEqual(await listing(f.out), [], `${row.name}: nothing is written`);
  }
});

test("a bump moves the workspace and its lock's own crates, never a registry crate", () => {
  const { manifest, lock } = bumpWorkspace(workspaceManifest(VERSION), workspaceLock(VERSION), VERSION, NEXT);
  const expectedManifest = workspaceManifest(NEXT).replace(
    `serde = { version = "${NEXT}"`,
    'serde = { version = "0.1.0"',
  );
  assert.equal(manifest, expectedManifest);
  assert.match(lock, /name = "genex"\nversion = "0\.2\.0"/);
  assert.match(lock, /name = "genex-core"\nversion = "0\.2\.0"/);
  assert.match(lock, /name = "serde"\nversion = "0\.1\.0"/, "a registry crate at the old version stays");
  assert.match(lock, /name = "pond"\nversion = "0\.0\.0"/, "a member at its own version stays");
  const refused = [
    { name: "a version that is no semver", from: VERSION, to: "../x" },
    { name: "a from that is not the workspace's", from: "0.3.0", to: "0.4.0" },
  ];
  for (const row of refused)
    assert.throws(
      () => bumpWorkspace(workspaceManifest(VERSION), workspaceLock(VERSION), row.from, row.to),
      ReleaseRefused,
      row.name,
    );
});

/** A `.crate` (a gzipped tar of `<name>/…`) holding `files`, as `cargo package` writes one. */
async function crateFile(root: string, name: string, files: Record<string, string>): Promise<string> {
  const stage = path.join(root, "stage");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(stage, name, rel)), { recursive: true });
    await writeFile(path.join(stage, name, rel), text);
  }
  const crate = path.join(root, `${name}.crate`);
  await execFileAsync("tar", ["-czf", crate, "-C", stage, name]);
  return crate;
}

test("a packaged genex crate that records the commit it came from is refused, so the reviewed tree never moves with HEAD", async () => {
  const root = await tmpDir("rust-release-crate-");
  const vendor = path.join(root, "vendor");
  await mkdir(vendor, { recursive: true });
  const plain = await crateFile(root, "genex-0.1.0", { "Cargo.toml": "[package]\n", "src/lib.rs": "" });
  await vendorCrate(vendor, plain);
  const checksum = JSON.parse(await readFile(path.join(vendor, "genex-0.1.0", ".cargo-checksum.json"), "utf8"));
  assert.deepEqual(Object.keys(checksum.files).sort(), ["Cargo.toml", "src/lib.rs"]);

  const bound = await crateFile(root, "genex-core-0.1.0", {
    "Cargo.toml": "[package]\n",
    ".cargo_vcs_info.json": '{"git":{"sha1":"b45f662a8bbba0e410aae9797d7dd703595b5e54"}}',
  });
  assert.equal(await refusalOf(vendorCrate(vendor, bound)), ReleaseRefusal.CommitBound);
  assert.deepEqual(await listing(vendor), ["genex-0.1.0"], "the commit-bound crate leaves nothing in the tree");
});

test("cargo packages genex from a copy of the workspace outside version control: the files git lists, never .git or target", async () => {
  const root = await tmpDir("rust-release-copy-");
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "crates", "genex", "src"), { recursive: true });
  await mkdir(path.join(workspace, "target", "debug"), { recursive: true });
  await writeFile(path.join(workspace, "Cargo.toml"), workspaceManifest(VERSION));
  await writeFile(path.join(workspace, "crates", "genex", "src", "lib.rs"), "pub fn f() {}\n");
  await writeFile(path.join(workspace, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(workspace, "ignored.txt"), "never packaged\n");
  await writeFile(path.join(workspace, "target", "debug", "junk"), "build output\n");
  const git = (...args: string[]) => execFileAsync("git", ["-C", workspace, ...args]);
  await git("init", "--quiet");
  await git("add", "Cargo.toml", ".gitignore");
  await writeFile(path.join(workspace, "untracked.rs"), "// a new file the working tree holds\n");

  const into = path.join(root, "copy");
  await copyPackageSources(workspace, into);
  const copied = async (dir: string, rel = ""): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) found.push(...(await copied(dir, child)));
      else found.push(child);
    }
    return found.sort();
  };
  assert.deepEqual(await copied(into), [".gitignore", "Cargo.toml", "crates/genex/src/lib.rs", "untracked.rs"]);
  assert.equal(await readFile(path.join(into, "Cargo.toml"), "utf8"), workspaceManifest(VERSION));

  const plain = path.join(root, "plain");
  await mkdir(path.join(plain, "src"), { recursive: true });
  await mkdir(path.join(plain, "target"), { recursive: true });
  await writeFile(path.join(plain, "Cargo.toml"), "[package]\n");
  await writeFile(path.join(plain, "src", "lib.rs"), "");
  await writeFile(path.join(plain, "target", "junk"), "");
  const plainInto = path.join(root, "plain-copy");
  await copyPackageSources(plain, plainInto);
  assert.deepEqual(
    await copied(plainInto),
    ["Cargo.toml", "src/lib.rs"],
    "a workspace outside git copies all but target",
  );
});
