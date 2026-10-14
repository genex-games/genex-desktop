/**
 * A crate registry with no network for the crate request flow (extension ladder level 4): each
 * fixture crate is packed into a `.crate` (a gzipped ustar archive, as `cargo package` writes one)
 * and listed in a sparse-index file (`index/<name>`, one JSON line per version, crates.io's shape)
 * with its sha256, so `directoryCrateIndex` and `directoryCrateDownload` read it as they would a
 * local mirror. The crates cover every typed outcome: a build script, a proc macro, an advisory,
 * a copyleft licence, a banned crate, an unaudited crate (added, with its notice), a second version
 * of a locked crate, a yanked version, a checksum the bytes do not match and an archive that climbs
 * out of its folder. Six carry real crates' names and versions so the real cargo-deny over the
 * pinned RustSec snapshot judges them as the built-in rules do: `smallvec 1.6.0` (a vulnerability),
 * `lru 0.12.0` (unsound), `plutonium 0.5.0` (an informational notice), `paste 1.0.15`
 * (unmaintained: passes), `humantime 2.1.0` (a withdrawn advisory: passes) and `glow 0.13.0` (a GL
 * backend the policy bans). `wrapper` brings in `copyleft`, so a dependency's licence refuses it;
 * the `*licence` crates hide a licence from the host's manifest reader or point `license-file`
 * somewhere else ({@link HOSTILE_LICENCE_CRATES}).
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CrateAuditSource } from "../../../src/shared/crate-requests.ts";

/** One dependency row of a fixture crate's index entry. */
export interface FixtureDep {
  name: string;
  req: string;
  optional?: boolean;
  kind?: "normal" | "build" | "dev";
  features?: string[];
}

/** One fixture crate version: its index facts and the files its archive holds. */
export interface FixtureCrate {
  name: string;
  version: string;
  license: string | null;
  deps?: FixtureDep[];
  features?: Record<string, string[]>;
  yanked?: boolean;
  buildScript?: boolean;
  procMacro?: boolean;
  /** The index lists a sha256 the archive's bytes do not have. */
  wrongChecksum?: boolean;
  /** The archive holds an entry that climbs out of the crate's folder. */
  climbing?: boolean;
  /** `[package]` lines naming the licence in place of `license = "<license>"` (a hostile spelling). */
  licenceLines?: string[];
  /** More files under the crate's folder: a path and its text. */
  files?: Array<[string, string]>;
  /** Symbolic links under the crate's folder: a path and its target. */
  links?: Array<[string, string]>;
}

/** The MIT licence's text, which cargo-deny identifies (a fixture's `LICENSE` under MIT holds it). */
export const MIT_TEXT = `MIT License

Copyright (c) Fixture Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * Crates whose licence the host's manifest reader must refuse before any checker runs: a GPL
 * expression it cannot read (a literal string, an escape) beside an MIT `license-file`, and a
 * `license-file` outside the crate's folder (a sibling's, an absolute path) or through a link.
 */
export const HOSTILE_LICENCE_CRATES: readonly FixtureCrate[] = [
  {
    name: "litlicence",
    version: "1.0.0",
    license: null,
    licenceLines: ["license = 'GPL-3.0-only'", 'license-file = "LICENSE-MIT"'],
    files: [["LICENSE-MIT", MIT_TEXT]],
  },
  {
    name: "esclicence",
    version: "1.0.0",
    license: null,
    licenceLines: ['license = "GPL\\u002D3.0-only"', 'license-file = "LICENSE-MIT"'],
    files: [["LICENSE-MIT", MIT_TEXT]],
  },
  {
    name: "siblicence",
    version: "1.0.0",
    license: null,
    licenceLines: ['license-file = "../tidy-1.0.0/LICENSE"'],
    deps: [{ name: "tidy", req: "^1.0" }],
  },
  {
    name: "abslicence",
    version: "1.0.0",
    license: null,
    licenceLines: ['license-file = "/etc/hosts"'],
  },
  {
    name: "linklicence",
    version: "1.0.0",
    license: null,
    licenceLines: ['license-file = "LICENSE-LINK"'],
    files: [["LICENSE-MIT", MIT_TEXT]],
    links: [["LICENSE-LINK", "LICENSE-MIT"]],
  },
];

/** The crates the store's lock line already vendors in these fixtures: one fastrand 2. */
export const FIXTURE_BASE_LOCK = [{ name: "fastrand", version: "2.5.0" }] as const;

/** Every crate the fixture registry serves. */
export const FIXTURE_CRATES: readonly FixtureCrate[] = [
  { name: "tidy", version: "1.0.0", license: "MIT" },
  { name: "tidy", version: "1.0.1", license: "MIT", yanked: true },
  {
    name: "outer",
    version: "0.4.0",
    license: "MIT OR Apache-2.0",
    deps: [
      { name: "tidy", req: "^1.0" },
      { name: "helper", req: "^0.1", optional: true },
      { name: "devonly", req: "^9", kind: "dev" },
    ],
    features: { default: [], extra: ["dep:helper"] },
  },
  { name: "helper", version: "0.1.0", license: "MIT" },
  {
    name: "featured",
    version: "0.1.0",
    license: "MIT",
    deps: [{ name: "outer", req: "^0.4", features: ["extra"] }],
  },
  { name: "buildy", version: "0.2.0", license: "MIT", buildScript: true },
  { name: "macroish", version: "0.1.0", license: "MIT", procMacro: true },
  { name: "leaky", version: "0.3.0", license: "MIT" },
  { name: "copyleft", version: "1.0.0", license: "GPL-3.0-only" },
  { name: "unlicensed", version: "1.0.0", license: null },
  { name: "fresh", version: "0.1.0", license: "MIT" },
  { name: "twin", version: "0.1.0", license: "MIT", deps: [{ name: "fastrand", req: "^1.9" }] },
  { name: "sharer", version: "0.1.0", license: "MIT", deps: [{ name: "fastrand", req: "^2.0" }] },
  { name: "oldie", version: "0.1.0", license: "MIT", yanked: true },
  { name: "wrongsum", version: "0.1.0", license: "MIT", wrongChecksum: true },
  { name: "climber", version: "0.1.0", license: "MIT", climbing: true },
  { name: "smallvec", version: "1.6.0", license: "MIT OR Apache-2.0" },
  { name: "paste", version: "1.0.15", license: "MIT OR Apache-2.0" },
  { name: "humantime", version: "2.1.0", license: "MIT OR Apache-2.0" },
  { name: "glow", version: "0.13.0", license: "MIT OR Apache-2.0 OR Zlib" },
  { name: "lru", version: "0.12.0", license: "MIT" },
  { name: "plutonium", version: "0.5.0", license: "MIT" },
  { name: "wrapper", version: "0.1.0", license: "MIT", deps: [{ name: "copyleft", req: "^1.0" }] },
  ...HOSTILE_LICENCE_CRATES,
];

/** The crates one trusted source's audit list covers in the fixtures: all but `fresh`, and only Mozilla's is installed. */
export const FIXTURE_AUDITS = {
  [CrateAuditSource.Mozilla]: FIXTURE_CRATES.filter((crate) => crate.name !== "fresh").map(({ name, version }) => ({
    name,
    version,
  })),
};

/**
 * The fixtures' advisory snapshot, shaped as RustSec's entries are: `leaky` before 0.3.1, and the
 * real database's entries for the real-named crates (a vulnerability, unsound ones, an
 * informational notice, an unmaintained notice, a withdrawn one).
 */
export const FIXTURE_ADVISORIES = [
  { id: "RUSTSEC-0000-0001", name: "leaky", patched: [">=0.3.1"] },
  { id: "RUSTSEC-2021-0003", name: "smallvec", patched: [">=0.6.14, <1.0.0", ">=1.6.1"] },
  { id: "RUSTSEC-2024-0436", name: "paste", patched: [], informational: "unmaintained" },
  { id: "RUSTSEC-2025-0014", name: "humantime", patched: [], informational: "unmaintained", withdrawn: true },
  { id: "RUSTSEC-2026-0002", name: "lru", patched: [">= 0.16.3"], unaffected: ["< 0.9.0"], informational: "unsound" },
  { id: "RUSTSEC-2026-0253", name: "lru", patched: [">= 0.18.2"], informational: "unsound" },
  { id: "RUSTSEC-2020-0011", name: "plutonium", patched: [], informational: "notice" },
] as const;

const BLOCK = 512;

/** One ustar header for a regular file of `size` bytes at `name`, or a symbolic link to `link`. */
function tarHeader(name: string, size: number, link: string | null = null): Buffer {
  const header = Buffer.alloc(BLOCK);
  const put = (text: string, at: number, width: number) => header.write(text.slice(0, width), at, width, "utf8");
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("        ", 148, 8);
  put(link === null ? "0" : "2", 156, 1);
  if (link !== null) put(link, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

/** A gzipped ustar archive of `files` (path → text), in the order given, then `links` (path → target). */
export function packTarGz(
  files: ReadonlyArray<readonly [string, string]>,
  links: ReadonlyArray<readonly [string, string]> = [],
): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of files) {
    const body = Buffer.from(text, "utf8");
    parts.push(tarHeader(name, body.length), body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  for (const [name, target] of links) parts.push(tarHeader(name, 0, target));
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

/** The normalized `Cargo.toml` a fixture crate's archive holds, as `cargo package` writes one. */
function cargoToml(crate: FixtureCrate): string {
  const lines = [
    "# THIS FILE IS AUTOMATICALLY GENERATED BY CARGO",
    "[package]",
    'edition = "2021"',
    `name = "${crate.name}"`,
    `version = "${crate.version}"`,
    `build = ${crate.buildScript ? '"build.rs"' : "false"}`,
    `description = """`,
    `A fixture crate.`,
    `"""`,
  ];
  if (crate.license !== null) lines.push(`license = "${crate.license}"`);
  lines.push(...(crate.licenceLines ?? []));
  lines.push("", "[lib]", `name = "${crate.name}"`, 'path = "src/lib.rs"');
  if (crate.procMacro) lines.push("proc-macro = true");
  for (const dep of crate.deps ?? []) {
    if (dep.kind === "dev") continue;
    const table = dep.kind === "build" ? "build-dependencies" : "dependencies";
    lines.push("", `[${table}.${dep.name}]`, `version = "${dep.req}"`);
    if (dep.optional) lines.push("optional = true");
  }
  return `${lines.join("\n")}\n`;
}

/** The files a fixture crate's archive holds, under `<name>-<version>/`. */
function crateFiles(crate: FixtureCrate): Array<[string, string]> {
  const top = `${crate.name}-${crate.version}`;
  const files: Array<[string, string]> = [
    [`${top}/Cargo.toml`, cargoToml(crate)],
    [`${top}/src/lib.rs`, `//! ${crate.name}\npub fn value() -> u32 {\n    7\n}\n`],
  ];
  if (crate.license === "MIT") files.push([`${top}/LICENSE`, MIT_TEXT]);
  else if (crate.license !== null) files.push([`${top}/LICENSE`, `${crate.license} licence text of ${crate.name}\n`]);
  for (const [rel, text] of crate.files ?? []) files.push([`${top}/${rel}`, text]);
  if (crate.buildScript) files.push([`${top}/build.rs`, "fn main() {}\n"]);
  if (crate.climbing) files.push([`${top}/../../escaped.txt`, "out\n"]);
  return files;
}

/** One sparse-index line for a fixture crate. */
function indexLine(crate: FixtureCrate, cksum: string): string {
  const deps = (crate.deps ?? []).map((dep) => ({
    name: dep.name,
    req: dep.req,
    features: dep.features ?? [],
    optional: dep.optional ?? false,
    default_features: true,
    target: null,
    kind: dep.kind ?? "normal",
  }));
  return JSON.stringify({
    name: crate.name,
    vers: crate.version,
    deps,
    cksum,
    features: crate.features ?? {},
    yanked: crate.yanked ?? false,
  });
}

/** Writes the fixture registry under `root` (`index/`, `crates/`) and answers its root. */
export async function writeFixtureRegistry(root: string, crates: readonly FixtureCrate[] = FIXTURE_CRATES) {
  await mkdir(path.join(root, "index"), { recursive: true });
  await mkdir(path.join(root, "crates"), { recursive: true });
  const lines = new Map<string, string[]>();
  for (const crate of crates) {
    const top = `${crate.name}-${crate.version}`;
    const archive = packTarGz(
      crateFiles(crate),
      (crate.links ?? []).map(([rel, target]) => [`${top}/${rel}`, target] as const),
    );
    const sha = createHash("sha256").update(archive).digest("hex");
    const cksum = crate.wrongChecksum ? createHash("sha256").update("not these bytes").digest("hex") : sha;
    await writeFile(path.join(root, "crates", `${crate.name}-${crate.version}.crate`), archive);
    lines.set(crate.name, [...(lines.get(crate.name) ?? []), indexLine(crate, cksum)]);
  }
  for (const [name, entries] of lines) await writeFile(path.join(root, "index", name), `${entries.join("\n")}\n`);
  return root;
}
