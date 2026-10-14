/**
 * The third-party notices a build ships. Every npm package bundled into the app's JavaScript or
 * compiled into its stylesheet keeps its own license files under `dist/resources/third-party`,
 * listed in NOTICE.md. A package that ships no license file must have a section in
 * THIRD-PARTY-NOTICES.md (shipped as PROJECT-SOURCES.md), and every library three.js vendors in
 * `examples/jsm/libs` must be listed there too. A gap stops the build, before anything is written.
 * The Rust · wgpu asset importer's WebAssembly decoders and the egui fonts the Rust HUD compiles in
 * are held to the same page (`assertImportDecodersListed`, `assertEguiFontsListed`), and so are the
 * Rust games' own inputs: every crate the shipped lock line resolves from the registry
 * (`assertRustCratesListed`) and the toolchain runtime every Rust game links
 * (`assertRustToolchainRuntimeListed`, the parts in `RUST_TOOLCHAIN_RUNTIME`).
 */
import fs from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** The heading of THIRD-PARTY-NOTICES.md's table of three.js's vendored libraries. */
const THREE_LIBS_HEADING = "## three.js add-on libraries";
/** The heading of THIRD-PARTY-NOTICES.md's table of the Rust asset importer's decoders. */
const IMPORT_DECODERS_HEADING = "## Asset importer decoders";
/** The heading of THIRD-PARTY-NOTICES.md's section on the Rust runtime's crates. */
const RUST_CRATES_HEADING = "## Rust runtime crates";
/** The crate that compiles egui's default fonts into the Rust HUD. */
const EGUI_FONTS_CRATE = "epaint_default_fonts";
/** The heading of THIRD-PARTY-NOTICES.md's table of what the Rust toolchain links into every game. */
const RUST_TOOLCHAIN_HEADING = "## Rust toolchain runtime";
/** How a Cargo.lock names a package from crates.io. */
const REGISTRY_SOURCE = "registry+";

/**
 * What the pinned toolchains link into a Rust game besides its crates, and the software Vulkan a
 * Linux export ships beside it: the destinations each part reaches and its licence, as
 * THIRD-PARTY-NOTICES.md's toolchain runtime table must state them. Every part a destination's
 * export notices carry (`RUST_NOTICE_ROWS` in `src/substrate/rust-notices.ts`) is here. System
 * libraries a destination's OS provides (libSystem, libgcc_s, the Windows UCRT, Bionic) are not
 * shipped and not listed.
 */
export const RUST_TOOLCHAIN_RUNTIME = [
  { name: "std", destinations: "every destination", license: "MIT OR Apache-2.0" },
  { name: "compiler_builtins", destinations: "every destination", license: "MIT OR Apache-2.0" },
  { name: "compiler-rt", destinations: "every destination", license: "Apache-2.0 WITH LLVM-exception" },
  { name: "libunwind", destinations: "Windows, Android", license: "Apache-2.0 WITH LLVM-exception" },
  { name: "mingw-w64-crt", destinations: "Windows", license: "ZPL-2.1" },
  { name: "winpthreads", destinations: "Windows", license: "MIT" },
  { name: "zig-runtime", destinations: "Linux", license: "MIT" },
  { name: "swiftshader", destinations: "Linux", license: "Apache-2.0" },
  { name: "vulkan-loader", destinations: "Linux", license: "Apache-2.0" },
];

/** The installed package a file belongs to: the nearest named, versioned package.json above it. */
export function packageOf(root, input) {
  const modules = path.join(root, "node_modules") + path.sep;
  for (let dir = path.dirname(path.resolve(root, input)); dir.startsWith(modules); dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (pkg.name && pkg.version) return { dir, pkg };
  }
  return null;
}

/** A package's own license and notice files. */
export function noticeFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(file) && fs.statSync(path.join(dir, file)).isFile());
}

/**
 * The packages a stylesheet imports by name (`@import "tailwindcss";`), as the package.json each
 * resolves to; relative imports are the app's own files. The Tailwind CLI, not esbuild, compiles
 * these into the shipped theme.css, so the JavaScript bundle's inputs never name them.
 */
export function stylesheetPackages(css) {
  const manifests = [];
  for (const [, specifier] of css.matchAll(/^\s*@import\s+["']([^"']+)["']/gm)) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    manifests.push(`node_modules/${name}/package.json`);
  }
  return manifests;
}

/** Whether THIRD-PARTY-NOTICES.md gives a package its own section: a heading naming it exactly. */
function hasNoticeSection(markdown, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{2,3} (?:.*[\\s(])?${escaped}(?:[\\s)].*)?$`, "m").test(markdown);
}

/** The bundled packages, sorted by name, each with the license files it ships. */
function bundledPackages(root, inputs) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.includes("node_modules/")) continue;
    const found = packageOf(root, input);
    if (found) packages.set(found.dir, found.pkg);
  }
  return [...packages]
    .map(([dir, pkg]) => ({ dir, pkg, notices: noticeFiles(dir) }))
    .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

/**
 * Writes `dist/resources/third-party`: NOTICE.md, each bundled package's license files, the
 * project's copied-source notices and the root license. Refuses, writing nothing, when a bundled
 * package ships no license file and THIRD-PARTY-NOTICES.md has no section for it.
 */
export async function writeBundledNotices({ root, dist, inputs }) {
  const projectNotices = fs.readFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
  const packages = bundledPackages(root, inputs);
  const unlicensed = packages
    .filter(({ pkg, notices }) => notices.length === 0 && !hasNoticeSection(projectNotices, pkg.name))
    .map(({ pkg }) => `${pkg.name} ${pkg.version}`);
  if (unlicensed.length > 0) {
    throw new Error(
      `Bundled packages ship no license file and THIRD-PARTY-NOTICES.md has no section for them: ${unlicensed.join(", ")}`,
    );
  }
  const destination = path.join(dist, "resources", "third-party");
  await mkdir(destination, { recursive: true });
  const lines = [
    "# Bundled third-party software",
    "",
    "Generated from the bundle input packages. External runtime packages retain their notices in node_modules; Electron includes its own notices.",
    "",
  ];
  for (const { dir, pkg, notices } of packages) {
    const license = typeof pkg.license === "string" ? pkg.license : "license metadata not reported";
    const where = notices.length ? notices.join(", ") : "notice in PROJECT-SOURCES.md";
    lines.push(`- ${pkg.name} ${pkg.version}: ${license}; ${where}`);
    const folder = path.join(destination, `${pkg.name.replaceAll("/", "_")}@${pkg.version}`);
    if (notices.length) await mkdir(folder, { recursive: true });
    for (const file of notices) await cp(path.join(dir, file), path.join(folder, file));
  }
  await cp(path.join(root, "src/renderer/ui/GENEX-SOURCES.md"), path.join(destination, "Genex-SOURCES.md"));
  await cp(path.join(root, "THIRD-PARTY-NOTICES.md"), path.join(destination, "PROJECT-SOURCES.md"));
  await cp(path.join(root, "LICENSE"), path.join(dist, "resources", "LICENSE"));
  lines.push("- Copied project sources: PROJECT-SOURCES.md. Studio's own license: ../LICENSE.");
  lines.push("- Vendored Genex UI: Genex-SOURCES.md. Font OFL notices accompany renderer/fonts.");
  await writeFile(path.join(destination, "NOTICE.md"), `${lines.join("\n")}\n`);
}

/** The text under `heading`, up to the next `## ` heading; empty when the heading is absent. */
function sectionOf(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start === -1) return "";
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The table rows of a section, each as its backticked first-column name and the whole row. */
function tableRows(section) {
  return [...section.matchAll(/^\|\s*`([^`]+)`.*$/gm)].map(([row, name]) => ({ name, row }));
}

/** Whether a listed name (a file, or a folder ending in `/`) covers `file`. */
function covers(name, file) {
  return name.endsWith("/") ? file.startsWith(name) : file === name;
}

/** The backticked file or folder names in the first column of the three.js libraries table. */
function listedThreeLibs(markdown) {
  return tableRows(sectionOf(markdown, THREE_LIBS_HEADING)).map(({ name }) => name);
}

/**
 * Throws, naming them, when files in three.js's `examples/jsm/libs` have no row in
 * THIRD-PARTY-NOTICES.md's three.js libraries table. A row names a file, or a folder ending in `/`.
 */
export function assertThreeLibsListed(libsDir, markdown) {
  const listed = listedThreeLibs(markdown);
  const covered = (file) => listed.some((name) => covers(name, file));
  const files = fs.readdirSync(libsDir, { recursive: true }).map((file) => String(file).split(path.sep).join("/"));
  const missing = files.filter((file) => fs.statSync(path.join(libsDir, file)).isFile() && !covered(file));
  if (missing.length > 0) {
    throw new Error(
      `three.js libraries missing from THIRD-PARTY-NOTICES.md ("${THREE_LIBS_HEADING}"): ${missing.join(", ")}`,
    );
  }
}

/**
 * Throws, naming them, when a decoder the Rust asset importer copies (`IMPORT_DECODERS` in
 * `src/substrate/asset-import/decoders.ts`: name → files under `three/`, upstream, licence) has a
 * file without a row in THIRD-PARTY-NOTICES.md's importer table that names its upstream and licence.
 */
export function assertImportDecodersListed(decoders, markdown) {
  const rows = tableRows(sectionOf(markdown, IMPORT_DECODERS_HEADING));
  const listed = (record, file) =>
    rows.some(({ name, row }) => covers(name, file) && row.includes(record.upstream) && row.includes(record.license));
  const missing = Object.entries(decoders)
    .filter(([, record]) => record.files.some((file) => !listed(record, file)))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `asset importer decoders missing from THIRD-PARTY-NOTICES.md ("${IMPORT_DECODERS_HEADING}"): ${missing.join(", ")}`,
    );
  }
}

/**
 * Throws, naming them, when a part of {@link RUST_TOOLCHAIN_RUNTIME} has no row in
 * THIRD-PARTY-NOTICES.md's toolchain runtime table stating its destinations and its licence.
 */
export function assertRustToolchainRuntimeListed(markdown, parts = RUST_TOOLCHAIN_RUNTIME) {
  const rows = tableRows(sectionOf(markdown, RUST_TOOLCHAIN_HEADING));
  const listed = (part) =>
    rows.some(({ name, row }) => name === part.name && row.includes(part.destinations) && row.includes(part.license));
  const missing = parts.filter((part) => !listed(part)).map((part) => part.name);
  if (missing.length > 0) {
    throw new Error(`missing from THIRD-PARTY-NOTICES.md ("${RUST_TOOLCHAIN_HEADING}"): ${missing.join(", ")}`);
  }
}

/** The packages a Cargo.lock resolves from the registry, as `{ name, version }` (path packages are the workspace's own). */
function registryPackages(cargoLock) {
  const packages = [];
  for (const block of cargoLock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (key) => new RegExp(`^${key} = "([^"]*)"`, "m").exec(block)?.[1] ?? null;
    const [name, version, source] = [field("name"), field("version"), field("source")];
    if (name && version && source?.startsWith(REGISTRY_SOURCE)) packages.push({ name, version });
  }
  return packages;
}

/** Whether `text` names `name version` as a whole word pair (the crate tables' spelling). */
function namesCrate(text, name, version) {
  const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${literal(name)}\`?\\s+${literal(version)}(?![\\w.+-])`).test(text);
}

/**
 * Throws, naming them, when a crate the Rust lock line resolves from the registry is not named at
 * its version in THIRD-PARTY-NOTICES.md's Rust runtime crates section.
 */
export function assertRustCratesListed(cargoLock, markdown) {
  const section = sectionOf(markdown, RUST_CRATES_HEADING);
  const missing = registryPackages(cargoLock)
    .filter(({ name, version }) => !namesCrate(section, name, version))
    .map(({ name, version }) => `${name} ${version}`);
  if (missing.length > 0) {
    throw new Error(
      `Rust crates missing from THIRD-PARTY-NOTICES.md ("${RUST_CRATES_HEADING}"): ${missing.join(", ")}`,
    );
  }
}

/** The version of `crate` a Cargo.lock resolves, or null when it resolves none. */
function lockedVersion(cargoLock, crate) {
  const match = new RegExp(`^name = "${crate}"\\r?\\nversion = "([^"]+)"`, "m").exec(cargoLock);
  return match ? match[1] : null;
}

/**
 * Throws when the Rust workspace's Cargo.lock resolves egui's default fonts crate at a version the
 * Rust runtime crates section of THIRD-PARTY-NOTICES.md does not name: the fonts' licences
 * (Ubuntu Font Licence, OFL, Bitstream Vera) are listed against that version.
 */
export function assertEguiFontsListed(cargoLock, markdown) {
  const version = lockedVersion(cargoLock, EGUI_FONTS_CRATE);
  if (version === null) return;
  const named = new RegExp(`${EGUI_FONTS_CRATE}\`?\\s+${version.replaceAll(".", "\\.")}(?![\\w.])`);
  if (!named.test(sectionOf(markdown, RUST_CRATES_HEADING))) {
    throw new Error(
      `egui fonts missing from THIRD-PARTY-NOTICES.md ("${RUST_CRATES_HEADING}"): ${EGUI_FONTS_CRATE} ${version}`,
    );
  }
}
