/**
 * What `scripts/physics-wasm.ts` ships beside the `@genex-ai/physics` module besides code: the
 * third-party notices of every crate compiled into it, and the check that the module holds no
 * absolute path of the machine that built it.
 *
 * - `crateClosure` walks `cargo metadata` (filtered to wasm32) from the binding crate along normal
 *   dependencies only (build and dev dependencies are not linked in) and keeps the third-party
 *   crates (a workspace member has no `source`).
 * - `noticesMarkdown` writes one table of every crate, its version and licence expression, then each
 *   distinct licence or notice text once with the crates that ship it. A crate whose source carries
 *   no licence file is listed under the text of the licence its expression names (Apache-2.0 for
 *   rapier3d and parry3d), with its authors and repository as the attribution.
 * - `localPathsIn` finds absolute home or build folders in the module's bytes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The files a crate's source names its licence or notices in. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright)/i;
/** An absolute user folder on a Mac or Linux host: `/Users/<name>/` or `/home/<name>/`. */
const HOME_FOLDER = /\/(?:Users|home)\/[^/\0\s"]+\//g;
/** The licence a crate without a licence file is listed under, by preference among its expression's ids. */
const FALLBACK_LICENCES = ["Apache-2.0", "MIT", "Zlib"] as const;

/** One crate of `cargo metadata`'s `packages`, the fields used here. */
export interface MetadataPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  authors: string[];
  repository: string | null;
  source: string | null;
  manifest_path: string;
}

/** `cargo metadata --format-version 1`, the fields used here. */
export interface Metadata {
  packages: MetadataPackage[];
  resolve: { nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
}

/** A licence or notice text a crate ships. */
export interface LicenceText {
  file: string;
  text: string;
}

/** A third-party crate compiled into the module, with what its source says about its licence. */
export interface NoticeCrate {
  name: string;
  version: string;
  license: string;
  authors: string[];
  repository: string;
  texts: LicenceText[];
}

/** The third-party crates `root` links in (normal dependencies, transitively), sorted by name and version. */
export function crateClosure(metadata: Metadata, root: string): MetadataPackage[] {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const start = metadata.packages.find((pkg) => pkg.name === root && pkg.source === null);
  if (start === undefined) throw new Error(`physics-wasm: ${root} is not a workspace member`);
  const seen = new Set([start.id]);
  const queue = [start.id];
  while (queue.length > 0) {
    const node = nodes.get(queue.shift() ?? "");
    for (const dep of node?.deps ?? []) {
      const normal = dep.dep_kinds.some((kind) => kind.kind === null);
      if (normal && !seen.has(dep.pkg)) {
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  const linked = [...seen].map((id) => packages.get(id)).filter((pkg): pkg is MetadataPackage => pkg !== undefined);
  return linked
    .filter((pkg) => pkg.source !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** A crate's licence and notice files, read from its source folder, sorted by file name. */
export function crateTexts(pkg: MetadataPackage): LicenceText[] {
  const dir = path.dirname(pkg.manifest_path);
  return readdirSync(dir)
    .filter((file) => LICENCE_FILE.test(file) && statSync(path.join(dir, file)).isFile())
    .sort()
    .map((file) => ({ file, text: readFileSync(path.join(dir, file), "utf8") }));
}

/** The crate as the notices list it. */
export function noticeCrate(pkg: MetadataPackage, texts: LicenceText[]): NoticeCrate {
  return {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? "(none declared)",
    authors: pkg.authors,
    repository: pkg.repository ?? "",
    texts,
  };
}

/** The licence id a crate without files is listed under: the first of `FALLBACK_LICENCES` its expression names. */
function fallbackLicence(expression: string): string | undefined {
  const ids = expression.split(/[\s()/]+|\bOR\b|\bAND\b/).filter((id) => id !== "");
  return FALLBACK_LICENCES.find((id) => ids.includes(id));
}

/** Each distinct text with the crates (`name version: file`) that ship it, in first-seen order. */
function groupTexts(crates: NoticeCrate[], canonical: Map<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const add = (text: string, who: string) => groups.set(text, [...(groups.get(text) ?? []), who]);
  for (const crate of crates) {
    for (const { file, text } of crate.texts) add(text, `${crate.name} ${crate.version}: ${file}`);
    if (crate.texts.length > 0) continue;
    const id = fallbackLicence(crate.license);
    const text = id === undefined ? undefined : canonical.get(id);
    if (text !== undefined) add(text, `${crate.name} ${crate.version}: no licence file in its source; ${id} applies`);
  }
  return groups;
}

/** A fence longer than any backtick run in `text`, so the text shows verbatim. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(longest + 1);
}

/**
 * The THIRD-PARTY-NOTICES.md text: every crate in a table, then each distinct text once. `canonical`
 * maps a licence id to its text, for crates whose source ships none.
 */
export function noticesMarkdown(crates: NoticeCrate[], canonical: Map<string, string>): string {
  const rows = crates.map((crate) => {
    const authors = crate.authors.length > 0 ? crate.authors.join(", ") : "(see repository)";
    return `| ${crate.name} | ${crate.version} | ${crate.license} | ${authors.replaceAll("|", "\\|")} | ${crate.repository} |`;
  });
  const sections = [...groupTexts(crates, canonical)].map(([text, users], index) => {
    const fence = fenceFor(text);
    return [
      `## Text ${index + 1}`,
      "",
      "Shipped by:",
      "",
      ...users.map((who) => `- ${who}`),
      "",
      fence,
      text.trimEnd(),
      fence,
      "",
    ].join("\n");
  });
  return [
    "# Third-party notices",
    "",
    "The WebAssembly module of @genex-ai/physics (`wasm/genex_physics_wasm_bg.wasm`) contains compiled code of",
    "these crates. Each is used under the licence named, or under one of the licences its expression offers;",
    "their licence and notice texts follow, each distinct text once. Generated by `scripts/physics-wasm.ts`.",
    "",
    "| Crate | Version | Licence | Authors | Repository |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...sections,
  ].join("\n");
}

/** The most common text of `file` names matching `pattern` among `crates`: a licence's canonical text. */
export function commonText(crates: NoticeCrate[], pattern: RegExp): string | undefined {
  const counts = new Map<string, number>();
  for (const crate of crates) {
    for (const { file, text } of crate.texts) {
      if (pattern.test(file)) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Every absolute path of `needles`, or any home folder, that `bytes` hold, sorted and once each. */
export function localPathsIn(bytes: Uint8Array, needles: readonly string[]): string[] {
  const text = Buffer.from(bytes).toString("latin1");
  const found = new Set<string>();
  for (const needle of needles) {
    if (needle !== "" && text.includes(needle)) found.add(needle);
  }
  for (const match of text.matchAll(HOME_FOLDER)) found.add(match[0]);
  return [...found].sort();
}
