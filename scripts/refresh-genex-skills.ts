/**
 * Refresh the Genex skills Studio vendors into `src/plugins/genex/skills` (developer-run only:
 * nothing is fetched at runtime or in CI).
 *
 * Each skill's `SKILL.md` is its Studio-written `PREFACE.md`, then a fixed upstream marker, then the
 * upstream bytes unchanged; a card's `references/*.md` are copied unchanged. The cards come from the
 * pinned `@genex-ai/cli-demo` in node_modules (MIT); the `genex` skill is https://genex.games/SKILL.md,
 * read from `--skill-md <file>`, fetched with `--fetch`, or kept from the current vendored copy.
 * The CLI's MIT license is copied beside them as `LICENSE-cards`, so every build carries it.
 * `vendor.json` records the versions and each upstream part's sha256, which
 * `tests/conformance/genex-skills-vendor.test.ts` holds to the pin. Each card's `references` in
 * plugin.json is rewritten to the references just vendored, so a reference the CLI adds or drops
 * needs no hand edit; a card the manifest never declared still fails the refresh.
 *
 * A card a CLI release not yet on npm changed can be vendored ahead of the pin from that CLI's
 * source (`--ahead-from <apps/cli> --ahead <card,…> --ahead-source <label>`): its files record that
 * version and a note to re-vendor them, and later refreshes keep them as they are until the pin
 * reaches that version, when they come from the published CLI again.
 *
 *   npm run genex:skills -- [--skill-md <file> | --fetch] [--ahead-from <dir> --ahead <cards> --ahead-source <label>]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isFileSkill, type PluginFileSkill, type PluginManifest } from "../src/shared/plugins.ts";

/** The skill vendored from https://genex.games/SKILL.md. */
export const GENEX_SKILL = "genex";
/** Where the `genex` skill comes from. */
export const SKILL_MD_URL = "https://genex.games/SKILL.md";
/** The CLI's platform cards Studio vendors, by folder name under `templates/skills`. */
export const GENEX_CARDS = [
  "genex-threejs-multiplayer",
  "genex-threejs-embed-auth",
  "genex-llm-in-games",
  "genex-tool-llm",
  "genex-monetization",
  "genex-items",
  "genex-tool-publish",
  "genex-cover",
  "genex-updates",
  "genex-tool-model",
  "genex-tool-character",
  "genex-tool-texture",
  "genex-tool-audio",
  "genex-tool-image",
] as const;
/** Skills Studio writes itself beside the vendored ones: never fetched, never in `vendor.json`. */
export const STUDIO_SKILLS: readonly string[] = ["plugin-author"];
/** The CLI's own license, copied beside the cards so every build of the payload carries it. */
export const CARDS_LICENSE = "LICENSE-cards";
const CLI_PACKAGE = "@genex-ai/cli-demo";
const SKILLS_DIR = "src/plugins/genex/skills";
const MANIFEST = "src/plugins/genex/plugin.json";
/** The folder, beside the package root, the plugin's skill files are declared under. */
const PACKAGE_SKILLS = "skills";
const SKILL_FILE = "SKILL.md";
const PREFACE_FILE = "PREFACE.md";
const REFERENCES = "references";
const MARKER = /^<!-- upstream (\S+) v(\S+) sha256 ([0-9a-f]{64}) -->\n/m;

/** One vendored upstream file, keyed in `vendor.json` by its path under the skills folder. */
export interface VendoredFile {
  source: string;
  sha256: string;
  bytes: number;
  /** The CLI version a card vendored ahead of the pin came from; absent for the pinned CLI's. */
  version?: string;
  /** Why it is ahead of the pin, and to re-vendor it from the published CLI. */
  pending?: string;
}
/** `src/plugins/genex/skills/vendor.json`. */
export interface GenexSkillsVendor {
  cliVersion: string;
  skillMdVersion: string;
  url: string;
  files: Record<string, VendoredFile>;
  /** The cards' license, `LICENSE-cards`, as copied from the pinned CLI. */
  license?: VendoredFile;
}
/** A vendored `SKILL.md` taken apart at its marker. */
export interface VendoredSkill {
  preface: string;
  source: string;
  version: string;
  sha256: string;
  upstream: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Whether `version` is a release newer than `pinned` (plain MAJOR.MINOR.PATCH only). */
export function isAheadOf(version: string, pinned: string): boolean {
  const a = SEMVER.exec(version);
  const b = SEMVER.exec(pinned);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(a[i]) - Number(b[i]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** The marker line between a Studio preface and the upstream bytes. */
const marker = (source: string, version: string, upstream: string) =>
  `<!-- upstream ${source} v${version} sha256 ${sha256(upstream)} -->\n`;

/** A vendored `SKILL.md`: the preface, a blank line, the marker, then the upstream bytes unchanged. */
export function vendoredSkill(preface: string, source: string, version: string, upstream: string): string {
  return `${preface}\n${marker(source, version, upstream)}${upstream}`;
}

/** Split a vendored `SKILL.md` into its preface, its marker's fields and the upstream bytes. */
export function splitVendoredSkill(text: string): VendoredSkill {
  const match = MARKER.exec(text);
  if (!match) throw new Error("No upstream marker in a vendored SKILL.md");
  const [line, source = "", version = "", hash = ""] = match;
  const preface = text.slice(0, match.index).replace(/\n$/, "");
  return { preface, source, version, sha256: hash, upstream: text.slice(match.index + line.length) };
}

/** The `version:` line of a skill's front matter. */
function frontMatterVersion(text: string): string {
  const version = /^---\n[\s\S]*?^version: (\S+)$[\s\S]*?^---$/m.exec(text)?.[1];
  if (!version) throw new Error(`${SKILL_MD_URL} has no front-matter version`);
  return version;
}

interface Options {
  root: string;
  skillMd?: string;
  fetch: boolean;
  /** A CLI package's source folder (`apps/cli`) whose cards `ahead` are vendored ahead of the pin. */
  aheadFrom?: string;
  ahead: string[];
  /** How the record names where that CLI came from, without spaces (a repository, branch and folder). */
  aheadSource?: string;
}

/** The flags that take a value, and where each one goes. */
const VALUE_FLAGS: Record<string, (options: Options, value: string) => void> = {
  "--skill-md": (options, value) => {
    options.skillMd = value;
  },
  "--ahead-from": (options, value) => {
    options.aheadFrom = value;
  },
  "--ahead": (options, value) => {
    options.ahead = value.split(",").filter(Boolean);
  },
  "--ahead-source": (options, value) => {
    options.aheadSource = value;
  },
};

function parseArgs(argv: string[], root: string): Options {
  const options: Options = { root, fetch: false, ahead: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    const takes = VALUE_FLAGS[flag];
    if (flag === "--fetch") options.fetch = true;
    else if (takes) takes(options, argv[++i] ?? "");
    else
      throw new Error(
        `Unknown argument ${flag}; use --skill-md <file>, --fetch or --ahead-from/--ahead/--ahead-source`,
      );
  }
  if (options.fetch && options.skillMd) throw new Error("Pass --skill-md or --fetch, not both");
  const aheadAsked = options.aheadFrom !== undefined || options.ahead.length > 0;
  const aheadWhole =
    options.aheadFrom !== undefined && options.ahead.length > 0 && /^\S+$/.test(options.aheadSource ?? "");
  if (aheadAsked && !aheadWhole) throw new Error("Pass --ahead-from, --ahead and --ahead-source (no spaces) together");
  return options;
}

/** The upstream genex.games SKILL.md: from a file, fetched, or kept from the vendored copy. */
async function upstreamSkillMd(options: Options): Promise<string> {
  if (options.skillMd) return readFile(options.skillMd, "utf8");
  if (options.fetch) {
    const response = await fetch(SKILL_MD_URL);
    if (!response.ok) throw new Error(`${SKILL_MD_URL}: HTTP ${response.status}`);
    return response.text();
  }
  const current = path.join(options.root, SKILLS_DIR, GENEX_SKILL, SKILL_FILE);
  return splitVendoredSkill(await readFile(current, "utf8")).upstream;
}

/** A card's reference files, relative to the card, sorted. */
async function cardReferences(card: string): Promise<string[]> {
  const names = await readdir(path.join(card, REFERENCES)).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => `${REFERENCES}/${n}`);
}

interface Vendoring {
  skills: string;
  cliVersion: string;
  files: Record<string, VendoredFile>;
}

/** Where a card's upstream comes from: the pinned CLI, or a newer one ahead of the pin. */
interface CardOrigin {
  /** The folder holding the CLI's `templates/skills`. */
  cards: string;
  /** How the record names that folder. */
  source: string;
  version: string;
  /** For a card ahead of the pin: its version and the note to re-vendor it. */
  ahead?: Pick<VendoredFile, "version" | "pending">;
}

/** Write one skill's SKILL.md from its preface and the upstream text, and record the upstream part. */
async function vendorSkill(
  v: Vendoring,
  skill: string,
  source: string,
  version: string,
  upstream: string,
  ahead?: CardOrigin["ahead"],
) {
  const dir = path.join(v.skills, skill);
  const preface = await readFile(path.join(dir, PREFACE_FILE), "utf8");
  await writeFile(path.join(dir, SKILL_FILE), vendoredSkill(preface, source, version, upstream));
  v.files[`${skill}/${SKILL_FILE}`] = {
    source,
    sha256: sha256(upstream),
    bytes: Buffer.byteLength(upstream),
    ...ahead,
  };
}

/** Vendor one CLI card: its SKILL.md behind the preface, and its references unchanged. */
async function vendorCard(v: Vendoring, origin: CardOrigin, card: string) {
  const from = path.join(origin.cards, card);
  const source = `${origin.source}/templates/skills/${card}`;
  const upstream = await readFile(path.join(from, SKILL_FILE), "utf8");
  await vendorSkill(v, card, `${source}/${SKILL_FILE}`, origin.version, upstream, origin.ahead);
  await rm(path.join(v.skills, card, REFERENCES), { recursive: true, force: true });
  for (const reference of await cardReferences(from)) {
    const text = await readFile(path.join(from, reference), "utf8");
    await mkdir(path.dirname(path.join(v.skills, card, reference)), { recursive: true });
    await writeFile(path.join(v.skills, card, reference), text);
    v.files[`${card}/${reference}`] = {
      source: `${source}/${reference}`,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
      ...origin.ahead,
    };
  }
}

/**
 * Keep a card vendored ahead of the pin as it is: its upstream bytes and references from the
 * current copy, behind its preface as it reads now. False when it is not ahead of `cliVersion`.
 */
async function keepAheadCard(v: Vendoring, previous: GenexSkillsVendor | null, card: string): Promise<boolean> {
  const entry = previous?.files[`${card}/${SKILL_FILE}`];
  if (!previous || !entry?.version || !isAheadOf(entry.version, v.cliVersion)) return false;
  const current = splitVendoredSkill(await readFile(path.join(v.skills, card, SKILL_FILE), "utf8"));
  await vendorSkill(v, card, entry.source, entry.version, current.upstream, {
    version: entry.version,
    pending: entry.pending,
  });
  for (const [file, kept] of Object.entries(previous.files))
    if (file.startsWith(`${card}/${REFERENCES}/`)) v.files[file] = kept;
  return true;
}

/** The newer CLI the `--ahead` cards come from, checked to be ahead of the pin. */
async function aheadOrigin(options: Options, cliVersion: string): Promise<CardOrigin | null> {
  if (!options.aheadFrom) return null;
  const version: string = JSON.parse(await readFile(path.join(options.aheadFrom, "package.json"), "utf8")).version;
  if (!isAheadOf(version, cliVersion))
    throw new Error(
      `${options.aheadFrom} is ${version}, not ahead of the pinned ${cliVersion}: refresh without --ahead`,
    );
  const source = options.aheadSource ?? "";
  const pending = `CLI ${version} is not on npm yet: vendored from ${source}. Re-vendor from the published CLI (npm run genex:skills) once the package.json pin moves to ${version}.`;
  return { cards: path.join(options.aheadFrom, "templates", "skills"), source, version, ahead: { version, pending } };
}

/**
 * Where plugin.json's file skills disagree with what was vendored: a declared file or reference that
 * is not vendored, a vendored reference the skill does not list, or a vendored skill never declared.
 * Studio's own skills (`STUDIO_SKILLS`) are not vendored and are not compared.
 */
export function manifestDisagreements(manifest: Pick<PluginManifest, "skills">, vendored: string[]): string[] {
  const packaged = new Set(vendored.map((f) => `${PACKAGE_SKILLS}/${f}`));
  const problems: string[] = [];
  const declared = new Set<string>();
  for (const skill of manifest.skills.filter(isFileSkill)) {
    if (STUDIO_SKILLS.includes(skill.name)) continue;
    for (const file of [skill.file, ...(skill.references ?? [])]) {
      declared.add(file);
      if (!packaged.has(file)) problems.push(`${skill.name}: ${file} is declared but not vendored`);
    }
  }
  for (const file of packaged)
    if (!declared.has(file)) problems.push(`${file} is vendored but no skill in ${MANIFEST} declares it`);
  return problems;
}

/**
 * The manifest with each vendored skill's `references` set to the references vendored for it: the
 * ones it already declared keep their order, new ones follow sorted, and ones no longer vendored go.
 */
export function declareVendoredReferences<M extends Pick<PluginManifest, "skills">>(
  manifest: M,
  vendored: string[],
): M {
  const packaged = vendored.map((f) => `${PACKAGE_SKILLS}/${f}`);
  const skills = manifest.skills.map((skill) => {
    if (!isFileSkill(skill) || STUDIO_SKILLS.includes(skill.name)) return skill;
    const folder = `${path.posix.dirname(skill.file)}/${REFERENCES}/`;
    const now = packaged.filter((f) => f.startsWith(folder));
    const kept = (skill.references ?? []).filter((f) => now.includes(f));
    const references = [...kept, ...now.filter((f) => !kept.includes(f)).sort()];
    // Spread then assign keeps an existing `references` key where it was in the file.
    const next: PluginFileSkill = { ...skill, references };
    if (references.length === 0) delete next.references;
    return next;
  });
  return { ...manifest, skills };
}

/** Write a plugin.json the way the repository formats it (Biome, with the root's configuration). */
export async function writeManifest(root: string, file: string, manifest: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  // Biome's own launcher, run by this Node: `.bin/biome` is a `.cmd` shim on Windows.
  const biome = path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
  await promisify(execFile)(process.execPath, [biome, "format", "--write", `--config-path=${root}`, file]);
}

/** Vendor every Genex skill and write vendor.json; returns what plugin.json disagrees with. */
export async function refreshGenexSkills(options: Options): Promise<string[]> {
  const require = createRequire(path.join(options.root, "package.json"));
  const cli = path.dirname(require.resolve(`${CLI_PACKAGE}/package.json`));
  const cliVersion: string = JSON.parse(await readFile(path.join(cli, "package.json"), "utf8")).version;
  const v: Vendoring = { skills: path.join(options.root, SKILLS_DIR), cliVersion, files: {} };
  const previous: GenexSkillsVendor | null = JSON.parse(
    await readFile(path.join(v.skills, "vendor.json"), "utf8").catch(() => "null"),
  );
  const skillMd = await upstreamSkillMd(options);
  const skillMdVersion = frontMatterVersion(skillMd);
  await vendorSkill(v, GENEX_SKILL, SKILL_MD_URL, skillMdVersion, skillMd);
  const pinned: CardOrigin = { cards: path.join(cli, "templates", "skills"), source: CLI_PACKAGE, version: cliVersion };
  const ahead = await aheadOrigin(options, cliVersion);
  for (const card of GENEX_CARDS) {
    if (ahead && options.ahead.includes(card)) await vendorCard(v, ahead, card);
    else if (!(await keepAheadCard(v, previous, card))) await vendorCard(v, pinned, card);
  }
  const license = await readFile(path.join(cli, "LICENSE"), "utf8");
  await writeFile(path.join(v.skills, CARDS_LICENSE), license);
  const record: GenexSkillsVendor = {
    cliVersion,
    skillMdVersion,
    url: SKILL_MD_URL,
    files: v.files,
    license: { source: `${CLI_PACKAGE}/LICENSE`, sha256: sha256(license), bytes: Buffer.byteLength(license) },
  };
  await writeFile(path.join(v.skills, "vendor.json"), `${JSON.stringify(record, null, 2)}\n`);
  const manifestFile = path.join(options.root, MANIFEST);
  const manifest = declareVendoredReferences(JSON.parse(await readFile(manifestFile, "utf8")), Object.keys(v.files));
  await writeManifest(options.root, manifestFile, manifest);
  return manifestDisagreements(manifest, Object.keys(v.files));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = await refreshGenexSkills(parseArgs(process.argv.slice(2), root));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}
