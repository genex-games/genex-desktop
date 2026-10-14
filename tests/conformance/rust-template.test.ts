/**
 * The Rust · wgpu starter project (`src/game-template-rust/`) and the vendored crate set it builds
 * against (`scripts/toolchains/rust-vendor.ts`, `scripts/toolchains/rust-inventory.json`).
 *
 * The template: a copy of it is a Rust game (`RUST_SHAPE`, `validateRustDir`), a created game gets
 * its title escaped for each file, the entry carries the FACET WIRING block the seed's union merge
 * accepts, the facade reference agents copy from shows that same block, the web shell is the
 * runtime's own, nothing cargo reads ships in it (the host writes the manifest and the lock), and
 * it typechecks against the `genex` facade under the pinned sysroot with a facet wired, through
 * the lane's clippy gate. That last row needs the installed toolchain
 * (`scripts/spike/rust-wgpu/setup-toolchain.sh`): it skips without it, and
 * `GENEX_REQUIRE_SPIKE_TOOLCHAIN=1` turns the skip into a failure.
 *
 * The vendored set: every build script, proc macro and non-source file in it is listed in the
 * committed inventory, so a new one fails until a person reviews it; the archive packs the same
 * tree into the same bytes; links, FIFOs and GL backend crates are refused with nothing written.
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { verifyWiringMerge, WIRING_START } from "../../src/harness-seed/loop/merge.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { GameStack } from "../../src/shared/game-project.ts";
import { ExposureMode, FormFactor, QualityPreset, Tonemapper } from "../../src/shared/render-quality.ts";
import { parseGenexToml } from "../../src/substrate/genex-toml.ts";
import { validateRustDir } from "../../src/substrate/game-validation.ts";
import { detectProjectShape, GameWorkspaces, RUST_SHAPE } from "../../src/substrate/game-workspace.ts";
import {
  checkVendor,
  type Inventory,
  packArchive,
  scanVendor,
  VendorRefusal,
  writeInventory,
} from "../../scripts/toolchains/rust-vendor.ts";
import { compilesPastFailedGate, workflowSteps } from "../../scripts/toolchains/rust-gate-workflow.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const FACADE = path.join(REPO, "native", "genex-rust", "crates", "genex");
const WORKSPACE_LOCK = path.join(REPO, "native", "genex-rust", "Cargo.lock");
const NATIVE_SHELL = path.join(REPO, "native", "genex-rust", "web", "shell.html");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const RUST_VENDOR = path.join(REPO, "scripts", "toolchains", "rust-vendor.ts");
const COMMITTED_INVENTORY = path.join(REPO, "scripts", "toolchains", "rust-inventory.json");
const SPIKE_DIR = path.join(REPO, ".studio-dev", "spike-toolchain");
const SPIKE_CARGO = path.join(SPIKE_DIR, "sysroot", "bin", "cargo");
const TYPECHECK_TIMEOUT_MS = 20 * MINUTE_MS;
const TITLE_PLACEHOLDER = "__GAME_TITLE__";
const template = (rel: string) => readFileSync(path.join(TEMPLATE, rel), "utf8");

/** What every Rust game's page offers once its module answers studio_call (the C++ shell's verbs and shapes). */
const PAGE_CONTRACT = [
  "version",
  "seed",
  "start",
  "pause",
  "step",
  "state",
  "input",
  "debugCamera",
  "cameras",
  "eyes",
  "demos",
  "demo",
  "injectInput",
  "eye",
  "player",
  "audio",
  // The renderer's quality on the page, as the native verb (pass-1 gate: Web had none).
  "renderSettings",
] as const;

/** A wasm module double with `names` exported; studio_call answers each op's argument back as its result. */
function genexModule(names: readonly string[]) {
  const calls: Array<[string, unknown]> = [];
  const all: Record<string, (...args: unknown[]) => unknown> = {
    studio_call: (op, arg) => {
      const parsed: unknown = JSON.parse(String(arg));
      calls.push([String(op), parsed]);
      return JSON.stringify({ id: null, ok: true, op, result: parsed });
    },
    studio_capture: () => Promise.resolve({ width: 1, height: 1, bgra: new Uint8Array(4) }),
    studio_self_test: () => Promise.resolve("{}"),
  };
  return { calls, exports: Object.fromEntries(names.map((name) => [name, all[name]])) };
}

/**
 * The `window.__studio` a shell binds for a module with `exports`: its script runs as the page
 * would in a browser without WebGPU (boot stops at the unsupported page), then binds the module.
 */
function boundStudio(html: string, exports: Record<string, unknown>): Record<string, unknown> {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  // The page's boot runs on (no WebGPU here) and draws its card after the row: a stub element
  // takes every DOM call a card makes, so that late work cannot throw outside the row.
  const element = () => ({
    hidden: false,
    textContent: "",
    classList: { add() {} },
    addEventListener() {},
    setAttribute() {},
    append() {},
    replaceChildren() {},
  });
  const page: Record<string, unknown> = {
    navigator: {},
    document: { getElementById: element, querySelector: element, createElement: element, body: element() },
    location: { search: "" },
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
  };
  page.window = page;
  const context = vm.createContext(page);
  // A classic script, so its top-level functions are the page's: `bindStudio` among them.
  vm.runInContext(script, context);
  (page.bindStudio as (game: unknown) => void)(exports);
  return page.__studio as Record<string, unknown>;
}

/** Skip without the installed toolchain, unless the run requires it. */
function needsToolchain(): { skip?: string } {
  if (existsSync(SPIKE_CARGO)) return {};
  if (process.env.GENEX_REQUIRE_SPIKE_TOOLCHAIN === "1") {
    throw new Error(`GENEX_REQUIRE_SPIKE_TOOLCHAIN=1: no Rust toolchain at ${SPIKE_CARGO}`);
  }
  return { skip: "not run: the pinned Rust toolchain is not installed" };
}

/** Every file under `dir`, `/`-separated and sorted. */
async function filesUnder(dir: string, rel = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesUnder(dir, child)));
    else files.push(child);
  }
  return files.sort();
}

/** A library over the real templates, with Rust creation open. */
async function library() {
  const base = await tmpDir("studio-rust-template-");
  const vendorDir = path.join(base, "vendor");
  await mkdir(vendorDir, { recursive: true });
  await writeFile(path.join(vendorDir, "three.module.js"), "export const REVISION = '0';\n");
  return new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.join(REPO, "src", "game-template"),
    rustTemplateDir: TEMPLATE,
    rustCreation: true,
    vendorDir,
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
    platform: "darwin",
  });
}

/** A facet as a worker writes it: its own state, wired from main's FACET WIRING block. */
const FISHING_FACET = [
  "//! A facet as a worker writes it: its own state, wired from main's FACET WIRING block.",
  "use genex::prelude::*;",
  "",
  "#[derive(Default)]",
  "pub struct Fishing { pub casts: u32 }",
  "",
  "pub fn wire(game: &mut Game<super::World>) {",
  "    game.facet_state::<Fishing>();",
  "    game.on_update(|sim, ctx| if ctx.keys.pressed(Key::Space) { sim.facets.get_mut::<Fishing>().casts += 1; });",
  '    game.probe("fishing", |sim| json!({ "casts": sim.facets.get::<Fishing>().casts }));',
  "}",
  "",
].join("\n");

/** What the host writes from genex.toml (M2.2): one binary on the facade, never a game's own manifest. */
const HOST_MANIFEST = [
  "[package]",
  'name = "game"',
  'version = "0.0.0"',
  'edition = "2024"',
  "publish = false",
  "",
  "[dependencies]",
  `genex = { path = ${JSON.stringify(FACADE)} }`,
  "",
  "[workspace]",
  "",
].join("\n");

/** The template's sources in `crate` with the fishing facet wired, under the host's manifest and the workspace lock. */
async function stageTemplateCrate(crate: string): Promise<void> {
  await cp(path.join(TEMPLATE, "src"), path.join(crate, "src"), { recursive: true });
  await mkdir(path.join(crate, "src", "facets"), { recursive: true });
  await writeFile(path.join(crate, "src", "facets", "fishing.rs"), FISHING_FACET);
  const lines = (await readFile(path.join(crate, "src", "main.rs"), "utf8")).split("\n");
  const open = lines.findIndex((line) => WIRING_START.test(line));
  const indent = /^\s*/.exec(lines[open] ?? "")?.[0] ?? "";
  lines.splice(
    open + 1,
    0,
    `${indent}#[path = "facets/fishing.rs"] mod fishing;`,
    `${indent}fishing::wire(&mut game);`,
  );
  await writeFile(path.join(crate, "src", "main.rs"), lines.join("\n"));
  await writeFile(path.join(crate, "Cargo.toml"), HOST_MANIFEST);
  await writeFile(path.join(crate, "Cargo.lock"), readFileSync(WORKSPACE_LOCK));
}

describe("the Rust template is a Rust · wgpu game the studio can build on", () => {
  it("a plain copy of it is detected as Rust · wgpu and passes the static check", async () => {
    const copy = path.join(await tmpDir("studio-rust-copy-"), "game");
    await cp(TEMPLATE, copy, { recursive: true });
    assert.deepEqual(await detectProjectShape(copy), RUST_SHAPE);
    const validation = await validateRustDir(copy, RUST_SHAPE);
    assert.deepEqual(validation.problems, []);
    assert.equal(validation.ok, true);
  });

  it("a created game gets its title escaped for TOML, the Rust literal and the page, and no placeholder stays", async () => {
    const games = await library();
    const title = 'Fish "n" \\ Chips <3';
    const game = await games.create(title, { stack: GameStack.RustWgpu });
    assert.deepEqual(game.shape, RUST_SHAPE);
    const read = (rel: string) => readFile(path.join(game.dir, rel), "utf8");
    assert.match(await read("genex.toml"), /^title = "Fish \\"n\\" \\\\ Chips <3"$/m);
    assert.ok((await read("src/main.rs")).includes('.title("Fish \\"n\\" \\\\ Chips <3")'));
    assert.ok((await read("web/shell.html")).includes("<title>Fish &quot;n&quot; \\ Chips &lt;3</title>"));
    for (const rel of await filesUnder(game.dir)) {
      if (rel.startsWith(".git/")) continue;
      const text = await readFile(path.join(game.dir, rel), "utf8");
      assert.ok(!text.includes(TITLE_PLACEHOLDER), `${rel} still carries ${TITLE_PLACEHOLDER}`);
    }
    const validation = await validateRustDir(game.dir, RUST_SHAPE);
    assert.deepEqual(validation.problems, []);
  });

  it("src/main.rs carries a FACET WIRING block the union merge accepts as it is", () => {
    // Where the block sits (inside main, before genex::install) is proven by the typecheck row,
    // which wires a facet into it and builds the crate through the lane's clippy gate.
    const main = template("src/main.rs");
    const merged = verifyWiringMerge(main);
    assert.equal(merged.ok, true);
    assert.equal(merged.text, main, "the template's own block has nothing to deduplicate");
  });

  it("docs/GENEX_API.md shows a wiring block the union merge accepts", () => {
    const fence = /```rust\n([\s\S]*?)```/g;
    const wiring = [...template("docs/GENEX_API.md").matchAll(fence)]
      .map((match) => match[1] ?? "")
      .find((block) => block.split("\n").some((line) => WIRING_START.test(line)));
    assert.ok(wiring !== undefined, "the reference shows a FACET WIRING block");
    assert.equal(verifyWiringMerge(wiring).ok, true);
  });

  it("web/shell.html binds the page contract for the module's exports, without the runtime spike's extras", () => {
    const every = genexModule(["studio_call", "studio_capture", "studio_self_test"]);
    const game = boundStudio(template("web/shell.html"), every.exports);
    assert.deepEqual(Object.keys(game).sort(), [...PAGE_CONTRACT, "capture"].sort());
    assert.equal((game.seed as (n: number) => unknown)(5), 5, "a verb goes through studio_call");
    assert.deepEqual(every.calls, [["seed", { seed: 5 }]]);
    const spike = boundStudio(readFileSync(NATIVE_SHELL, "utf8"), every.exports);
    assert.deepEqual(Object.keys(spike).sort(), [...PAGE_CONTRACT, "capture", "captureRaw", "selfTest"].sort());
  });

  it("web/shell.html binds capture only with studio_capture, and no verb without studio_call", () => {
    const shell = template("web/shell.html");
    const noCapture = boundStudio(shell, genexModule(["studio_call"]).exports);
    assert.deepEqual(Object.keys(noCapture).sort(), [...PAGE_CONTRACT].sort());
    assert.deepEqual(Object.keys(boundStudio(shell, genexModule([]).exports)), ["version"]);
    assert.ok(shell.includes(`<title>${TITLE_PLACEHOLDER}</title>`), "the title is the scaffold's placeholder");
  });

  it("ships nothing cargo reads: the host writes the manifest, the lock and the configuration", async () => {
    const files = await filesUnder(TEMPLATE);
    const cargoInputs = files.filter((rel) =>
      /(^|\/)(Cargo\.toml|Cargo\.lock|build\.rs|rust-toolchain(\.toml)?|\.cargo\/.*|clippy\.toml|deny\.toml)$/.test(
        rel,
      ),
    );
    // `unsafe` is the lane's clippy gate's to refuse (`-F unsafe_code`, the typecheck row below).
    assert.deepEqual(cargoInputs, []);
  });
});

describe("the Rust template's genex.toml asks for the renderer's look and quality", () => {
  it("parses a [render] table for desktops and phones on the device's own preset", () => {
    const parsed = parseGenexToml(template("genex.toml"));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const render = parsed.manifest.render;
    assert.ok(render, "the template declares [render]");
    assert.deepEqual(render.formFactors, [FormFactor.Desktop, FormFactor.Mobile]);
    assert.equal(render.preset, QualityPreset.Auto);
    assert.deepEqual(render.classes, {}, "the device classes keep their own quality");
  });

  it("opts into the filmic look explicitly: AgX (punchy) with auto exposure", () => {
    const parsed = parseGenexToml(template("genex.toml"));
    assert.ok(parsed.ok && parsed.manifest.render, JSON.stringify(parsed));
    const { look } = parsed.manifest.render;
    assert.equal(look.tonemapper, Tonemapper.AgxPunchy);
    assert.equal(look.exposure, ExposureMode.Auto);
  });

  it("a created game keeps the template's [render] table", async () => {
    const games = await library();
    const game = await games.create("Render", { stack: GameStack.RustWgpu });
    const parsed = parseGenexToml(await readFile(path.join(game.dir, "genex.toml"), "utf8"));
    assert.ok(parsed.ok && parsed.manifest.render, JSON.stringify(parsed));
    assert.equal(parsed.manifest.render.look.tonemapper, Tonemapper.AgxPunchy);
  });
});

describe("the Rust template builds under the pinned sysroot", () => {
  it(
    "typechecks against the genex facade under the pinned sysroot, a facet wired, through the lane's clippy gate",
    needsToolchain(),
    async () => {
      const crate = await tmpDir("studio-rust-typecheck-");
      await stageTemplateCrate(crate);
      const { stderr } = await execFileAsync(
        process.execPath,
        [RUST_ENV, "--", "cargo", "clippy", "--offline", "--quiet", "--", "-D", "warnings", "-F", "unsafe_code"],
        {
          cwd: REPO,
          env: {
            ...process.env,
            GENEX_RUST_WORKSPACE: crate,
            CLIPPY_CONF_DIR: path.join(REPO, "native", "genex-rust"),
          },
          timeout: TYPECHECK_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      assert.doesNotMatch(stderr, /^(warning|error)/m, stderr);
    },
  );
});

/** A fixture crate folder: its Cargo.toml and files, relative paths to text. */
type CrateFiles = Record<string, string>;

const plainManifest = (name: string, version: string, extra = "") =>
  `[package]\nname = "${name}"\nversion = "${version}"\nedition = "2021"\nbuild = false\n${extra}`;

/** A small vendored tree: one plain crate, one with a declared build script, one proc macro, one with a static library. */
const FIXTURE_VENDOR: Record<string, CrateFiles> = {
  "plain-1.0.0": { "Cargo.toml": plainManifest("plain", "1.0.0"), "src/lib.rs": "pub fn f() {}\n" },
  "with-build-0.2.0": {
    "Cargo.toml": '[package]\nname = "with-build"\nversion = "0.2.0"\nbuild = "build.rs"\n',
    "build.rs": "fn main() {}\n",
    "src/lib.rs": "\n",
  },
  "derive-macro-1.4.0": {
    "Cargo.toml": `${plainManifest("derive-macro", "1.4.0")}\n[lib]\nname = "derive_macro"\nproc-macro = true\n`,
    "src/lib.rs": "\n",
  },
  "prebuilt-0.53.0": {
    "Cargo.toml": plainManifest("prebuilt", "0.53.0"),
    "lib/libprebuilt.a": "!<arch>\n\u0000\u0000binary",
    "src/lib.rs": "\n",
  },
};

/** The inventory that lists exactly what {@link FIXTURE_VENDOR} holds. */
const FIXTURE_INVENTORY: Inventory = {
  crates: {
    "derive-macro-1.4.0": { procMacro: true },
    "prebuilt-0.53.0": { nonSource: ["lib/libprebuilt.a"] },
    "with-build-0.2.0": { buildScript: "build.rs" },
  },
};

async function writeCrates(dir: string, crates: Record<string, CrateFiles>): Promise<void> {
  for (const [crate, files] of Object.entries(crates)) {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, crate, rel)), { recursive: true });
      await writeFile(path.join(dir, crate, rel), text);
    }
  }
}

/** A fixture vendored tree and an inventory file beside it. */
async function fixtureVendor(inventory: Inventory = FIXTURE_INVENTORY) {
  const base = await tmpDir("studio-rust-vendor-");
  const vendor = path.join(base, "vendor");
  await writeCrates(vendor, FIXTURE_VENDOR);
  const inventoryFile = path.join(base, "rust-inventory.json");
  await writeFile(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`);
  return { base, vendor, inventoryFile };
}

const refusedWith = (code: string, detail?: RegExp) => (error: unknown) => {
  const refused = error as { code?: unknown; message?: unknown };
  assert.equal(refused.code, code, String(refused.message));
  if (detail) assert.match(String(refused.message), detail);
  return true;
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The entries of a tar stream: each header's name (PAX `path` when present), size and mode, in order. */
function tarEntries(tar: Buffer): Array<{ name: string; size: number; mode: number; mtime: number; uid: number }> {
  const entries: Array<{ name: string; size: number; mode: number; mtime: number; uid: number }> = [];
  let pending: string | null = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (from: number, length: number) =>
      header
        .subarray(from, from + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === "x") pending = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? null;
    else {
      const prefix = field(345, 155);
      const name = pending ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      const octal = (from: number, length: number) => Number.parseInt(field(from, length).trim() || "0", 8);
      entries.push({ name, size, mode: octal(100, 8), mtime: octal(136, 12), uid: octal(108, 8) });
      pending = null;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Vendored crates holding something nobody reviewed, and what the refusal names. */
const UNREVIEWED: Array<{ name: string; crates: Record<string, CrateFiles>; detail: RegExp }> = [
  {
    name: "an unlisted build.rs found by its name (no build key)",
    crates: {
      "old-crate-0.1.0": {
        "Cargo.toml": '[package]\nname = "old-crate"\nversion = "0.1.0"\n',
        "build.rs": "fn main() {}\n",
      },
    },
    detail: /old-crate-0\.1\.0: build script build\.rs/,
  },
  {
    name: "an unlisted declared build script elsewhere",
    crates: {
      "moved-build-2.0.0": {
        "Cargo.toml": '[package]\nname = "moved-build"\nversion = "2.0.0"\nbuild = "src/build.rs"\n',
        "src/build.rs": "fn main() {}\n",
      },
    },
    detail: /moved-build-2\.0\.0: build script src\/build\.rs/,
  },
  {
    name: "an unlisted proc macro",
    crates: {
      "new-derive-0.1.0": { "Cargo.toml": `${plainManifest("new-derive", "0.1.0")}\n[lib]\nproc_macro = true\n` },
    },
    detail: /new-derive-0\.1\.0: proc macro/,
  },
  {
    name: "an unlisted binary file",
    crates: {
      "blob-1.0.0": { "Cargo.toml": plainManifest("blob", "1.0.0"), "data/table.bin": "\u0000\u0001\u0002" },
    },
    detail: /blob-1\.0\.0: non-source file data\/table\.bin/,
  },
  {
    name: "a new build script in a listed crate's next version",
    crates: { "with-build-0.3.0": FIXTURE_VENDOR["with-build-0.2.0"] ?? {} },
    detail: /with-build-0\.3\.0: build script build\.rs/,
  },
];

/** Entries in a vendored tree that are not plain folders or files. */
const HOSTILE: Array<{ name: string; plant: (vendor: string, outside: string) => Promise<void> }> = [
  {
    name: "a crate folder that is a link",
    plant: (vendor, outside) => symlink(outside, path.join(vendor, "linked-1.0.0")),
  },
  {
    name: "a file that is a link out of the tree",
    plant: (vendor, outside) =>
      symlink(path.join(outside, "secret.txt"), path.join(vendor, "plain-1.0.0", "src", "secret.rs")),
  },
  {
    name: "a FIFO in a crate",
    plant: async (vendor) => {
      const made = spawnSync("mkfifo", [path.join(vendor, "plain-1.0.0", "pipe")]);
      assert.equal(made.status, 0);
    },
  },
];

describe("the vendored set's inventory refuses what nobody reviewed", () => {
  it("passes a tree whose build scripts, proc macros and non-source files are all listed", async () => {
    const { vendor, inventoryFile } = await fixtureVendor();
    await checkVendor(vendor, inventoryFile);
    assert.deepEqual(await scanVendor(vendor), FIXTURE_INVENTORY.crates);
  });

  for (const row of UNREVIEWED) {
    it(`refuses ${row.name}, and writes nothing`, async () => {
      const { vendor, inventoryFile } = await fixtureVendor();
      await writeCrates(vendor, row.crates);
      const before = await readFile(inventoryFile);
      await assert.rejects(checkVendor(vendor, inventoryFile), refusedWith(VendorRefusal.InventoryNew, row.detail));
      assert.deepEqual(await readFile(inventoryFile), before);
    });
  }

  it("refuses an executable file nobody listed", { skip: process.platform === "win32" && "no exec bit" }, async () => {
    const { vendor, inventoryFile } = await fixtureVendor();
    await writeCrates(vendor, {
      "tool-1.0.0": { "Cargo.toml": plainManifest("tool", "1.0.0"), "gen.sh": "#!/bin/sh\n" },
    });
    await chmod(path.join(vendor, "tool-1.0.0", "gen.sh"), 0o755);
    await assert.rejects(
      checkVendor(vendor, inventoryFile),
      refusedWith(VendorRefusal.InventoryNew, /tool-1\.0\.0: non-source file gen\.sh/),
    );
  });

  it("refuses an entry for something the tree no longer holds", async () => {
    const { vendor, inventoryFile } = await fixtureVendor({
      crates: { ...FIXTURE_INVENTORY.crates, "gone-1.0.0": { buildScript: "build.rs" } },
    });
    await assert.rejects(checkVendor(vendor, inventoryFile), refusedWith(VendorRefusal.InventoryStale, /gone-1\.0\.0/));
  });

  it("refuses a GL backend crate: WebGPU core is the floor", async () => {
    const { vendor, inventoryFile } = await fixtureVendor();
    await writeCrates(vendor, { "glow-0.16.0": { "Cargo.toml": plainManifest("glow", "0.16.0") } });
    await assert.rejects(checkVendor(vendor, inventoryFile), refusedWith(VendorRefusal.GlCrate, /glow-0\.16\.0/));
  });

  for (const row of HOSTILE) {
    it(`refuses ${row.name} without following it, and writes no archive`, {
      skip: process.platform === "win32" && "POSIX links and FIFOs",
    }, async () => {
      const { base, vendor, inventoryFile } = await fixtureVendor();
      const outside = path.join(base, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "secret.txt"), "never packed\n");
      await row.plant(vendor, outside);
      await assert.rejects(checkVendor(vendor, inventoryFile), refusedWith(VendorRefusal.NotAPlainFile));
      const archive = path.join(base, "out", "vendor.tar.gz");
      await assert.rejects(packArchive(vendor, archive, "vendor"), refusedWith(VendorRefusal.NotAPlainFile));
      assert.equal(existsSync(path.join(base, "out")) ? (await readdir(path.join(base, "out"))).length : 0, 0);
    });
  }

  it("writes the inventory a reviewer commits: sorted, and only crates with something to review", async () => {
    const { vendor, inventoryFile } = await fixtureVendor({ crates: {} });
    await writeInventory(vendor, inventoryFile);
    const written = JSON.parse(await readFile(inventoryFile, "utf8")) as Inventory;
    assert.deepEqual(written.crates, FIXTURE_INVENTORY.crates);
    assert.deepEqual(Object.keys(written.crates), Object.keys(written.crates).sort());
    await checkVendor(vendor, inventoryFile);
  });

  it("packs the same tree into the same bytes: sorted entries under one root, zero owners and times, modes kept", async () => {
    const { base, vendor } = await fixtureVendor();
    const longName = `${"deep/".repeat(30)}file.rs`;
    await writeCrates(vendor, { "plain-1.0.0": { [longName]: "// a path longer than ustar's 100 bytes\n" } });
    const first = await packArchive(vendor, path.join(base, "a", "vendor.tar.gz"), "vendor");
    const second = await packArchive(vendor, path.join(base, "b", "vendor.tar.gz"), "vendor");
    const bytesA = await readFile(path.join(base, "a", "vendor.tar.gz"));
    const bytesB = await readFile(path.join(base, "b", "vendor.tar.gz"));
    assert.equal(sha256(bytesA), sha256(bytesB));
    assert.equal(first.sha256, sha256(bytesA));
    assert.equal(first.bytes, (await stat(path.join(base, "a", "vendor.tar.gz"))).size);
    assert.equal(second.files, first.files);
    const entries = tarEntries(gunzipSync(bytesA));
    const names = entries.map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort());
    assert.ok(names.every((name) => name.startsWith("vendor/")));
    assert.ok(names.includes(`vendor/plain-1.0.0/${longName}`), "a long path survives through a PAX header");
    assert.ok(entries.every((entry) => entry.mtime === 0 && entry.uid === 0));
    assert.equal(entries.length, first.files);
  });

  it("the CLI refuses with one typed line and exit 78", async () => {
    const { vendor } = await fixtureVendor();
    const inventory = path.join(await tmpDir("studio-rust-vendor-cli-"), "inventory.json");
    await writeFile(inventory, `${JSON.stringify({ crates: {} })}\n`);
    const run = spawnSync(process.execPath, [RUST_VENDOR, "check", "--vendor", vendor, "--inventory", inventory], {
      encoding: "utf8",
    });
    assert.equal(run.status, 78, run.stderr);
    const line = /^genex-rust-vendor-refusal: (.*)$/m.exec(run.stderr)?.[1] ?? "";
    assert.equal((JSON.parse(line) as { code: string }).code, VendorRefusal.InventoryNew);
  });

  it("the committed inventory lists exactly what the installed vendored set holds", needsToolchain(), async () => {
    await checkVendor(path.join(SPIKE_DIR, "vendor"), COMMITTED_INVENTORY);
  });
});

describe("the gate's CI job compiles nothing once the gate failed", () => {
  const WORKFLOW = path.join(REPO, ".github", "workflows", "rust-toolchain.yml");
  const JOB = "vendored-set";
  /** A vendored-set job of `steps`, each `[name, if, run]`. */
  const job = (steps: ReadonlyArray<readonly [string, string, string]>) =>
    [
      "jobs:",
      `  ${JOB}:`,
      "    runs-on: ubuntu-24.04",
      "    steps:",
      ...steps.flatMap(([name, condition, run]) => [
        `      - name: ${name}`,
        ...(condition ? [`        if: ${condition}`] : []),
        ...(run.includes("\n")
          ? ["        run: |", ...run.split("\n").map((line) => `          ${line}`)]
          : [`        run: ${run}`]),
      ]),
      "",
    ].join("\n");
  const INVENTORY = ["Inventory", "", "node scripts/toolchains/rust-vendor.ts check"] as const;
  const DENY = ["Deny", "", "node scripts/toolchains/rust-env.ts -- cargo deny check"] as const;
  const VET = ["Vet", "${{ !cancelled() }}", "node scripts/toolchains/rust-env.ts -- cargo vet --locked"] as const;
  const TEMPLATE_TESTS = ["Template", "", "node --test tests/conformance/rust-template.test.ts"] as const;

  it("the committed workflow holds: every compiling step runs only after the inventory and cargo-deny passed", () => {
    const text = readFileSync(WORKFLOW, "utf8");
    assert.ok(workflowSteps(text, JOB).length > 0, "the job is read");
    assert.deepEqual(compilesPastFailedGate(text, JOB), []);
  });

  const ROWS: ReadonlyArray<[string, string, string[]]> = [
    ["the gate, then a plain compile", job([INVENTORY, DENY, VET, TEMPLATE_TESTS]), []],
    [
      "a test run under if: !cancelled()",
      job([INVENTORY, DENY, ["Template", "${{ !cancelled() }}", TEMPLATE_TESTS[2]]]),
      ["Template"],
    ],
    [
      "a clippy under if: always()",
      job([INVENTORY, DENY, ["Clippy", "always()", "cargo clippy --offline"]]),
      ["Clippy"],
    ],
    [
      "a build in a block run under failure()",
      job([INVENTORY, ["Build", "failure()", "echo first\ncargo build -p pond"]]),
      ["Build"],
    ],
    ["a compile before the gate", job([["Early", "", "cargo test --workspace"], INVENTORY, DENY]), ["Early"]],
    ["a compile between the inventory and cargo-deny", job([INVENTORY, ["Mid", "", "cargo check"], DENY]), ["Mid"]],
  ];
  for (const [name, text, expected] of ROWS) {
    it(`reads ${name}`, () => {
      assert.deepEqual(compilesPastFailedGate(text, JOB), expected);
    });
  }
});
