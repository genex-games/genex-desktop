/**
 * The Rust · wgpu payload's packaging and release plumbing (M2.16): what a release's provenance
 * records about the Rust store's inputs, what `build.mjs` ships into resources, and what the
 * packaged smoke refuses in a package. The packaged app itself is driven by
 * `tests/e2e/run-packaged-smoke.mjs`; these rows hold its checks and the provenance to their rules.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { platformProvenance, rustStoreInputs, TOOLCHAIN_LOCK_INPUTS } from "../../scripts/release-manifest.mjs";
import { RUST_PAYLOAD, rustPayloadChecks, shipRustPayload } from "../../scripts/rust-payload.ts";
import { ToolchainId } from "../../src/shared/toolchain.ts";
import { isReleaseUrl } from "../../src/substrate/toolchain-store/manifest.ts";
import rustRecipe from "../../src/substrate/toolchain-store/rust-recipe.json" with { type: "json" };
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
/** The shipped crate policy's bytes: the only ones a build ships or a package may carry. */
const SHIPPED_POLICY = await readFile(path.join(repo, "native", "genex-rust", "crate-policy.json"));
/** Where a cut vendored crate set is published: a Genex release asset (what M2.18 adds to the recipe). */
const VENDOR_URL = "https://github.com/genex-games/genex-desktop/releases/download/genex-rust-0.1.0/rust-vendor.tar.xz";

interface RecipeArchive {
  url: string;
  bytes: number;
  sha256: string | null;
}
interface Recipe {
  entries: Array<{ id: string; archives: RecipeArchive[] } & Record<string, unknown>>;
}

/** A copy of the real recipe, so a row can change one pin. */
const recipeCopy = (): Recipe => structuredClone(rustRecipe) as Recipe;

/** A copy of the real recipe with `change` applied to the first archive of its first entry. */
function recipeWith(change: Partial<RecipeArchive>): Recipe {
  const copy = recipeCopy();
  const first = copy.entries[0]?.archives[0];
  if (!first) throw new Error("the recipe has no archive");
  Object.assign(first, change);
  return copy;
}

/** The real recipe plus a cut vendored crate set at `url`. */
function recipeWithVendor(url = VENDOR_URL): Recipe {
  const copy = recipeCopy();
  copy.entries.push({
    id: ToolchainId.RustVendor,
    version: "0.1.0",
    host: null,
    target: null,
    licence: "MIT OR Apache-2.0",
    archives: [
      { url, bytes: 1234, sha256: sha("vendor"), format: "tar.xz", strip: 0, into: "vendor" } as RecipeArchive,
    ],
  });
  return copy;
}

test("the provenance lists every Rust store input with its sha256 and a durable release URL", () => {
  const { inputs, unpinned } = rustStoreInputs(rustRecipe);
  const archives = rustRecipe.entries.flatMap((entry) => entry.archives);
  assert.equal(inputs.length, archives.length, "one row per pinned archive");
  for (const archive of archives) {
    const row = inputs.find((input) => input.url === archive.url);
    assert.ok(row, `${archive.url} is listed`);
    assert.equal(row.sha256, archive.sha256);
    assert.equal(row.bytes, archive.bytes);
  }
  for (const row of inputs) {
    assert.match(row.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.ok(isReleaseUrl(row.id, row.url), `${row.url} is ${row.id}'s release URL`);
  }
  assert.deepEqual(unpinned, [ToolchainId.RustVendor], "the vendored crate set is unpinned until the genex cut");

  const cut = rustStoreInputs(recipeWithVendor());
  assert.deepEqual(cut.unpinned, [], "a cut vendored set leaves nothing unpinned");
  assert.ok(cut.inputs.some((row) => row.id === ToolchainId.RustVendor && row.url === VENDOR_URL));
});

test("a Rust store input off its publisher's release host, or without a digest, is no provenance", () => {
  const refused: Array<[string, Recipe]> = [
    ["a CI artifact", recipeWith({ url: "https://github.com/genex-games/genex-desktop/actions/runs/1/artifacts/2" })],
    ["a climb out of the release path", recipeWith({ url: "https://static.rust-lang.org/dist/../rustup/x.tar.xz" })],
    ["plain http", recipeWith({ url: "http://static.rust-lang.org/dist/2026-10-01/rustc.tar.xz" })],
    ["a mirror", recipeWith({ url: "https://mirror.example/dist/2026-10-01/rustc.tar.xz" })],
    ["no digest", recipeWith({ sha256: null })],
    ["a short digest", recipeWith({ sha256: "abc" })],
    [
      "a release's moving latest link",
      recipeWithVendor("https://github.com/genex-games/genex-desktop/releases/latest/download/rust-vendor.tar.xz"),
    ],
  ];
  for (const [what, recipe] of refused) assert.throws(() => rustStoreInputs(recipe), Error, `${what} is refused`);
});

test("each platform's provenance carries the Rust store inputs and the toolchain digest covers the Rust lock", async () => {
  for (const rel of [
    "src/substrate/toolchain-store/rust-recipe.json",
    RUST_PAYLOAD.lock.source,
    RUST_PAYLOAD.policy.source,
  ])
    assert.ok(TOOLCHAIN_LOCK_INPUTS.includes(rel), `${rel} is a toolchain lock input`);
  const artifacts = [{ file: "Genex.zip", sha256: sha("zip") }];
  const manifest = await platformProvenance(repo, {
    source: "a".repeat(40),
    platform: "darwin",
    arch: "arm64",
    signed: false,
    artifacts,
  });
  assert.deepEqual(manifest.rustStore, rustStoreInputs(rustRecipe));
  assert.match(manifest.toolchainLockSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.lockfileSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.platform, "darwin");
  assert.deepEqual(manifest.artifacts, artifacts);
});

/** A repository holding a Rust template and a lock line, as `shipRustPayload` reads it. */
async function fixtureRepo(): Promise<string> {
  const root = await tmpDir("rust-payload-");
  const template = path.join(root, "src", RUST_PAYLOAD.template);
  await mkdir(path.join(template, "src"), { recursive: true });
  for (const rel of RUST_PAYLOAD.templateFiles) await writeFile(path.join(template, rel), `fixture ${rel}\n`);
  await mkdir(path.dirname(path.join(root, RUST_PAYLOAD.lock.source)), { recursive: true });
  await writeFile(path.join(root, RUST_PAYLOAD.lock.source), "version = 4\n");
  await writeFile(path.join(root, RUST_PAYLOAD.clippy.source), "disallowed-methods = []\n");
  await writeFile(path.join(root, RUST_PAYLOAD.policy.source), SHIPPED_POLICY);
  return root;
}

test("build ships the Rust template, the lock line and the lane's clippy.toml into resources, byte for byte, and no build output", async () => {
  const root = await fixtureRepo();
  const template = path.join(root, "src", RUST_PAYLOAD.template);
  await mkdir(path.join(template, "target", "debug"), { recursive: true });
  await writeFile(path.join(template, "target", "debug", "game"), "a built program");
  const resources = await tmpDir("rust-resources-");
  await shipRustPayload({ root, resources });
  for (const rel of RUST_PAYLOAD.templateFiles)
    assert.equal(await readFile(path.join(resources, RUST_PAYLOAD.template, rel), "utf8"), `fixture ${rel}\n`);
  assert.equal(await readFile(path.join(resources, RUST_PAYLOAD.lock.resource), "utf8"), "version = 4\n");
  assert.equal(await readFile(path.join(resources, RUST_PAYLOAD.clippy.resource), "utf8"), "disallowed-methods = []\n");
  assert.deepEqual(await readFile(path.join(resources, RUST_PAYLOAD.policy.resource)), SHIPPED_POLICY);
  assert.ok(!(await readdir(path.join(resources, RUST_PAYLOAD.template))).includes("target"), "no target/ ships");

  const unlocked = await fixtureRepo();
  await writeFile(path.join(unlocked, RUST_PAYLOAD.lock.source), "");
  await assert.rejects(shipRustPayload({ root: unlocked, resources: await tmpDir() }), /lock/);
  const untemplated = await fixtureRepo();
  await writeFile(path.join(untemplated, "src", RUST_PAYLOAD.template, "genex.toml"), "");
  await assert.rejects(shipRustPayload({ root: untemplated, resources: await tmpDir() }), /template/);
  const ungated = await fixtureRepo();
  await writeFile(path.join(ungated, RUST_PAYLOAD.clippy.source), "");
  await assert.rejects(shipRustPayload({ root: ungated, resources: await tmpDir() }), /determinism gate/);
  const unpoliced = await fixtureRepo();
  await rm(path.join(unpoliced, RUST_PAYLOAD.policy.source));
  await assert.rejects(shipRustPayload({ root: unpoliced, resources: await tmpDir() }), /crate policy/);
  const repoliced = await fixtureRepo();
  await writeFile(path.join(repoliced, RUST_PAYLOAD.policy.source), `${SHIPPED_POLICY.toString("utf8")} `);
  await assert.rejects(shipRustPayload({ root: repoliced, resources: await tmpDir() }), /crate policy/);
});

/** A package listing (asar and unpacked, `/`-rooted) that carries the Rust payload. */
function packagePayload(): string[] {
  const home = `/dist/resources/${RUST_PAYLOAD.template}`;
  return [
    "/dist",
    "/dist/resources",
    home,
    `${home}/src`,
    ...RUST_PAYLOAD.templateFiles.map((rel) => `${home}/${rel}`),
    `/dist/resources/${RUST_PAYLOAD.lock.resource}`,
    `/dist/resources/${RUST_PAYLOAD.policy.resource}`,
    // A folder that only shares a program's name is no program.
    "/node_modules/some-package/lib/cargo",
    "/node_modules/some-package/lib/cargo/index.js",
  ];
}

/** The packaged smoke's Rust checks over a package with `overrides`; the names of those that fail. */
function failing(overrides: Partial<Parameters<typeof rustPayloadChecks>[0]> = {}): string[] {
  const lock = Buffer.from("version = 4\n");
  const checks = rustPayloadChecks({
    entries: packagePayload(),
    shippedLock: lock,
    sourceLock: lock,
    shippedPolicy: SHIPPED_POLICY,
    mainBundle: rustRecipe.entries.flatMap((entry) => entry.archives.map((archive) => archive.sha256)).join("\n"),
    recipe: rustRecipe,
    ...overrides,
  });
  assert.ok(checks.length >= 4, "the template, lock, program and pin checks all run");
  return checks.filter((check) => !check.ok).map((check) => check.name);
}

test("the packaged smoke passes a package that carries the Rust payload and no compiler", () => {
  assert.deepEqual(failing(), []);
});

test("the packaged smoke fails a package without the Rust template or lock, or with a compiler program", () => {
  const withoutManifest = packagePayload().filter((entry) => !entry.endsWith("/genex.toml"));
  assert.match(failing({ entries: withoutManifest }).join(), /Rust · wgpu game template/);
  const withoutTemplate = packagePayload().filter((entry) => !entry.includes(RUST_PAYLOAD.template));
  assert.match(failing({ entries: withoutTemplate }).join(), /Rust · wgpu game template/);
  for (const program of [
    "/dist/resources/rust/bin/cargo",
    "/dist/resources/rust/bin/rustc",
    "/dist/resources/rust/bin/cargo.exe",
    "/node_modules/x/bin/RUSTC.EXE",
    "/node_modules/x/bin/cargo-clippy",
    "/node_modules/x/bin/clippy-driver",
    "/node_modules/x/bin/rust-lld",
    "/node_modules/x/bin/rustup",
    "/node_modules/x/bin/wasm-bindgen",
  ])
    assert.match(failing({ entries: [...packagePayload(), program] }).join(), /no Rust compiler/, program);
  assert.match(failing({ shippedLock: null }).join(), /lock line/);
  assert.match(failing({ shippedLock: Buffer.from("version = 3\n") }).join(), /lock line/);
  assert.match(failing({ mainBundle: "" }).join(), /Rust toolchain pins/);
  assert.match(failing({ shippedPolicy: null }).join(), /crate policy/);
  assert.match(failing({ shippedPolicy: Buffer.from("{}") }).join(), /crate policy/);
});
