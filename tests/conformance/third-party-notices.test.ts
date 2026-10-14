/**
 * The build ships every third-party license it owes: each npm package bundled into the app's
 * JavaScript or compiled into its stylesheet keeps its own license files beside NOTICE.md, a
 * package that ships none must have its notice in THIRD-PARTY-NOTICES.md, and every library in
 * three.js's vendored `examples/jsm/libs` must be listed there. A gap stops the build instead of
 * shipping code without its license. Drives scripts/third-party-notices.mjs, which build.mjs calls.
 * The Rust · wgpu asset importer's WebAssembly decoders and the egui fonts the Rust HUD compiles in
 * are held to the same page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import {
  assertEguiFontsListed,
  assertImportDecodersListed,
  assertRustCratesListed,
  assertRustToolchainRuntimeListed,
  assertThreeLibsListed,
  RUST_TOOLCHAIN_RUNTIME,
  stylesheetPackages,
  writeBundledNotices,
} from "../../scripts/third-party-notices.mjs";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { IMPORT_DECODERS } from "../../src/substrate/asset-import/decoders.ts";
import { RUST_NOTICE_ROWS, RustRuntimePart } from "../../src/substrate/rust-notices.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

/** A project root with an installed package per entry: name → files beside its package.json. */
async function project(packages: Record<string, Record<string, string>>, notices = "# Third-party notices\n") {
  const root = await tmpDir("notices-");
  for (const [name, files] of Object.entries(packages)) {
    const dir = path.join(root, "node_modules", name);
    await mkdir(path.join(dir, "dist"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT" }));
    await writeFile(path.join(dir, "dist/index.js"), "export {};\n");
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(dir, file), text);
  }
  await writeFile(path.join(root, "THIRD-PARTY-NOTICES.md"), notices);
  await writeFile(path.join(root, "LICENSE"), "MIT License\n");
  await mkdir(path.join(root, "src/renderer/ui"), { recursive: true });
  await writeFile(path.join(root, "src/renderer/ui/GENEX-SOURCES.md"), "# Genex UI provenance\n");
  return { root, dist: path.join(root, "dist") };
}

test("a bundled package's own license files ship beside the notice list", async () => {
  const { root, dist } = await project({ "with-license": { LICENSE: "MIT License\nCopyright (c) Someone\n" } });
  await writeBundledNotices({ root, dist, inputs: ["node_modules/with-license/dist/index.js", "src/main.ts"] });
  const third = path.join(dist, "resources/third-party");
  assert.equal(
    await readFile(path.join(third, "with-license@1.0.0/LICENSE"), "utf8"),
    "MIT License\nCopyright (c) Someone\n",
  );
  assert.match(await readFile(path.join(third, "NOTICE.md"), "utf8"), /^- with-license 1\.0\.0: MIT; LICENSE$/m);
});

test("the packages a stylesheet imports by name are bundle inputs; its own files are not", () => {
  const css = [
    '@import "tailwindcss";',
    "@import '@xterm/xterm/css/xterm.css';",
    '@import "tw-animate-css";',
    '@import "./styles/icons.css";',
    '@import "../shared.css";',
  ].join("\n");
  assert.deepEqual(stylesheetPackages(css), [
    "node_modules/tailwindcss/package.json",
    "node_modules/@xterm/xterm/package.json",
    "node_modules/tw-animate-css/package.json",
  ]);
});

test("a package without a license file is listed against the section THIRD-PARTY-NOTICES.md gives it", async () => {
  const { root, dist } = await project(
    { "bare-package": {} },
    "# Third-party notices\n\n## bare-package 1.0.0\n\nMIT License\n",
  );
  await writeBundledNotices({ root, dist, inputs: ["node_modules/bare-package/dist/index.js"] });
  const list = await readFile(path.join(dist, "resources/third-party/NOTICE.md"), "utf8");
  assert.match(list, /^- bare-package 1\.0\.0: MIT; notice in PROJECT-SOURCES\.md$/m);
});

test("a package with neither a license file nor a notice section stops the build and writes nothing", async () => {
  const { root, dist } = await project({ "bare-package": {}, "with-license": { LICENSE: "MIT License\n" } });
  await assert.rejects(
    writeBundledNotices({
      root,
      dist,
      inputs: ["node_modules/with-license/dist/index.js", "node_modules/bare-package/dist/index.js"],
    }),
    (error: Error) => error.message.includes("bare-package") && !error.message.includes("with-license"),
  );
  assert.equal(existsSync(path.join(dist, "resources/third-party")), false);
});

test("a section heading only covers the package it names, not one whose name contains it", async () => {
  const { root, dist } = await project({ "bare-package-extra": {} }, "# Notices\n\n## bare-package 1.0.0\n");
  await assert.rejects(
    writeBundledNotices({ root, dist, inputs: ["node_modules/bare-package-extra/dist/index.js"] }),
    /bare-package-extra/,
  );
});

test("every library three.js vendors in examples/jsm/libs needs a row in the three.js libraries table", async () => {
  const libs = await tmpDir("three-libs-");
  await mkdir(path.join(libs, "draco/gltf"), { recursive: true });
  await writeFile(path.join(libs, "draco/gltf/draco_decoder.js"), "");
  await writeFile(path.join(libs, "tween.module.js"), "");
  await writeFile(path.join(libs, "brand-new.module.js"), "");
  const notices = [
    "## three.js add-on libraries",
    "",
    "| File | Project | License |",
    "| --- | --- | --- |",
    "| `draco/` | Draco | Apache-2.0 |",
    "| `tween.module.js` | tween.js | MIT |",
    "",
    "## Something else",
    "",
    "| `brand-new.module.js` | not this table | MIT |",
  ].join("\n");
  assert.throws(
    () => assertThreeLibsListed(libs, notices),
    (error: Error) => /brand-new\.module\.js/.test(error.message),
  );
  assert.doesNotThrow(() =>
    assertThreeLibsListed(
      libs,
      notices.replace("| `tween.module.js`", "| `brand-new.module.js` | New | MIT |\n| `tween.module.js`"),
    ),
  );
});

test("the installed three.js libraries and stylesheet packages are all covered today", async () => {
  const notices = await readFile(path.join(REPO, "THIRD-PARTY-NOTICES.md"), "utf8");
  assert.doesNotThrow(() => assertThreeLibsListed(path.join(REPO, "node_modules/three/examples/jsm/libs"), notices));
  const css = await readFile(path.join(REPO, "src/renderer/theme.css"), "utf8");
  for (const manifest of stylesheetPackages(css)) assert.ok(existsSync(path.join(REPO, manifest)), manifest);
});

/** A decoder table shaped like the importer's: one decoder per file list. */
const DECODERS = {
  basisu: {
    files: ["examples/jsm/libs/basis/basis_transcoder.js", "examples/jsm/libs/basis/basis_transcoder.wasm"],
    upstream: "https://github.com/BinomialLLC/basis_universal",
    license: "Apache-2.0",
  },
  meshopt: {
    files: ["examples/jsm/libs/meshopt_decoder.module.js"],
    upstream: "https://github.com/zeux/meshoptimizer",
    license: "MIT",
  },
};

const BASIS_ROW =
  "| `examples/jsm/libs/basis/` | [Basis Universal](https://github.com/BinomialLLC/basis_universal) | Apache-2.0 |";
const MESHOPT_ROW =
  "| `examples/jsm/libs/meshopt_decoder.module.js` | [meshoptimizer](https://github.com/zeux/meshoptimizer) | MIT |";

/** An importer table holding `rows`, followed by another section holding `after`. */
const importerSection = (rows: string[], after: string[] = []) =>
  [
    "## Asset importer decoders",
    "",
    "| File | Project | License |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "## Something else",
    "",
    ...after,
  ].join("\n");

test("every importer decoder needs a row naming its files, upstream and licence in the importer table", () => {
  assert.doesNotThrow(() => assertImportDecodersListed(DECODERS, importerSection([BASIS_ROW, MESHOPT_ROW])));
  const rows: Array<[string, string]> = [
    ["a decoder with no row", importerSection([BASIS_ROW])],
    ["a row in another section", importerSection([BASIS_ROW], [MESHOPT_ROW])],
    [
      "a row without the upstream",
      importerSection([BASIS_ROW, MESHOPT_ROW.replace("(https://github.com/zeux/meshoptimizer)", "")]),
    ],
    ["a row with another licence", importerSection([BASIS_ROW, MESHOPT_ROW.replace("| MIT |", "| BSD-3-Clause |")])],
    [
      "a folder row that does not hold the file",
      importerSection([BASIS_ROW, MESHOPT_ROW.replace("meshopt_decoder.module.js`", "meshopt/`")]),
    ],
  ];
  for (const [name, markdown] of rows) {
    assert.throws(
      () => assertImportDecodersListed(DECODERS, markdown),
      (error: Error) => error.message.includes("meshopt") && !error.message.includes("basisu"),
      name,
    );
  }
  assert.throws(() => assertImportDecodersListed(DECODERS, "# Third-party notices\n"), /basisu.*meshopt/);
});

/** A Cargo.lock that resolves `epaint_default_fonts` at `version`. */
const lockWith = (version: string) =>
  `[[package]]\nname = "egui"\nversion = "0.36.2"\n\n[[package]]\nname = "epaint_default_fonts"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`;

const RUST_SECTION = [
  "## Rust runtime crates",
  "",
  "- egui's default fonts, compiled into the HUD through `epaint_default_fonts` 0.36.2: Ubuntu Light.",
  "",
  "## Components under other terms",
  "",
  "- `epaint_default_fonts` 0.37.0 is named here, outside the Rust section.",
].join("\n");

test("the egui fonts the lock resolves are named, at that version, in the Rust runtime crates section", () => {
  assert.doesNotThrow(() => assertEguiFontsListed(lockWith("0.36.2"), RUST_SECTION));
  assert.throws(
    () => assertEguiFontsListed(lockWith("0.37.0"), RUST_SECTION),
    (error: Error) => error.message.includes("epaint_default_fonts 0.37.0"),
  );
  assert.throws(() => assertEguiFontsListed(lockWith("0.36.2"), "# Third-party notices\n"), /0\.36\.2/);
  assert.doesNotThrow(() => assertEguiFontsListed('[[package]]\nname = "egui"\nversion = "0.36.2"\n', ""));
});

test("the importer's decoders and the lock's egui fonts are covered today", async () => {
  const notices = await readFile(path.join(REPO, "THIRD-PARTY-NOTICES.md"), "utf8");
  assert.doesNotThrow(() => assertImportDecodersListed(IMPORT_DECODERS, notices));
  const lock = await readFile(path.join(REPO, "native/genex-rust/Cargo.lock"), "utf8");
  assert.doesNotThrow(() => assertEguiFontsListed(lock, notices));
});

/** A Cargo.lock: the workspace's own path package, then registry packages `name@version`. */
const registryLock = (...crates: string[]) =>
  [
    'version = 4\n\n[[package]]\nname = "genex"\nversion = "0.1.0"\n',
    ...crates.map((crate) => {
      const [name, version] = crate.split("@");
      return `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "00"\n`;
    }),
  ].join("\n");

const CRATES_SECTION = [
  "## Rust runtime crates",
  "",
  "| Licence (as the crate declares it) | Crates | Crates and versions |",
  "| --- | --- | --- |",
  "| MIT OR Apache-2.0 | 2 | glam 0.33.12, wgpu 30.0.1 |",
  "",
  "## Something else",
  "",
  "| MIT | 1 | serde 1.0.229 |",
].join("\n");

test("every crate the Rust lock resolves from the registry is named, at that version, in the Rust runtime crates section", () => {
  assert.doesNotThrow(() => assertRustCratesListed(registryLock("glam@0.33.12", "wgpu@30.0.1"), CRATES_SECTION));
  const rows: Array<[string, string, string]> = [
    ["a crate with no entry", registryLock("glam@0.33.12", "rapier3d@0.36.0"), "rapier3d 0.36.0"],
    ["a crate at another version", registryLock("glam@0.33.13"), "glam 0.33.13"],
    ["a crate named only outside the section", registryLock("serde@1.0.229"), "serde 1.0.229"],
  ];
  for (const [name, lock, missing] of rows) {
    assert.throws(
      () => assertRustCratesListed(lock, CRATES_SECTION),
      (error: Error) => error.message.includes(missing) && !error.message.includes("genex"),
      name,
    );
  }
});

/** The toolchain runtime table, holding `rows`. */
const toolchainSection = (rows: string[]) =>
  [
    "## Rust toolchain runtime",
    "",
    "| Component | Linked into | License |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "## Something else",
  ].join("\n");

test("the toolchain runtime every Rust game links is listed with the destinations it reaches and its licence", () => {
  const all = RUST_TOOLCHAIN_RUNTIME.map((part) => `| \`${part.name}\` | ${part.destinations} | ${part.license} |`);
  assert.doesNotThrow(() => assertRustToolchainRuntimeListed(toolchainSection(all)));
  const [first, ...rest] = all;
  assert.ok(first);
  assert.throws(() => assertRustToolchainRuntimeListed(toolchainSection(rest)), /Rust toolchain runtime/);
  const relicensed = first.replace(/\| [^|]+ \|$/, "| GPL-3.0 |");
  assert.throws(
    () => assertRustToolchainRuntimeListed(toolchainSection([relicensed, ...rest])),
    /Rust toolchain runtime/,
  );
  assert.throws(() => assertRustToolchainRuntimeListed("# Third-party notices\n"), /Rust toolchain runtime/);
});

/** How the toolchain runtime table's "Linked into" column names each destination. */
const DESTINATION: Record<string, string> = {
  [BuildTarget.Web]: "web",
  [BuildTarget.Mac]: "Mac",
  [BuildTarget.Windows]: "Windows",
  [BuildTarget.Linux]: "Linux",
  [BuildTarget.Ios]: "iOS",
  [BuildTarget.Android]: "Android",
} satisfies Record<BuildTarget, string>;

/** Parts the page covers in sections of their own: egui's fonts in the crates section, the decoders in theirs. */
const COVERED_ELSEWHERE: ReadonlySet<string> = new Set([RustRuntimePart.EguiFonts, RustRuntimePart.ImporterDecoders]);

test("every runtime part a Rust export's notices carry is in the toolchain runtime table, with that export's destination", () => {
  const listed = new Map(RUST_TOOLCHAIN_RUNTIME.map((part) => [part.name, part]));
  const unlisted: string[] = [];
  for (const [target, row] of Object.entries(RUST_NOTICE_ROWS)) {
    for (const { part } of row ?? []) {
      if (COVERED_ELSEWHERE.has(part)) continue;
      const entry = listed.get(part);
      const reaches =
        entry?.destinations === "every destination" || entry?.destinations.includes(DESTINATION[target] ?? target);
      if (!reaches) unlisted.push(`${part} (${target})`);
    }
  }
  assert.deepEqual(unlisted, []);
});

test("the Rust lock's crate closure and the toolchain runtime are covered today", async () => {
  const notices = await readFile(path.join(REPO, "THIRD-PARTY-NOTICES.md"), "utf8");
  const lock = await readFile(path.join(REPO, "native/genex-rust/Cargo.lock"), "utf8");
  assert.doesNotThrow(() => assertRustCratesListed(lock, notices));
  assert.doesNotThrow(() => assertRustToolchainRuntimeListed(notices));
});
