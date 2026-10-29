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
 *   npm run genex:skills -- [--skill-md <file> | --fetch]
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
}

function parseArgs(argv: string[], root: string): Options {
  const options: Options = { root, fetch: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fetch") options.fetch = true;
    else if (argv[i] === "--skill-md") options.skillMd = argv[++i];
    else throw new Error(`Unknown argument ${argv[i]}; use --skill-md <file> or --fetch`);
  }
  if (options.fetch && options.skillMd) throw new Error("Pass --skill-md or --fetch, not both");
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

/** Write one skill's SKILL.md from its preface and the upstream text, and record the upstream part. */
async function vendorSkill(v: Vendoring, skill: string, source: string, version: string, upstream: string) {
  const dir = path.join(v.skills, skill);
  const preface = await readFile(path.join(dir, PREFACE_FILE), "utf8");
  await writeFile(path.join(dir, SKILL_FILE), vendoredSkill(preface, source, version, upstream));
  v.files[`${skill}/${SKILL_FILE}`] = { source, sha256: sha256(upstream), bytes: Buffer.byteLength(upstream) };
}

/** Vendor one CLI card: its SKILL.md behind the preface, and its references unchanged. */
async function vendorCard(v: Vendoring, cards: string, card: string) {
  const from = path.join(cards, card);
  const source = `${CLI_PACKAGE}/templates/skills/${card}`;
  await vendorSkill(
    v,
    card,
    `${source}/${SKILL_FILE}`,
    v.cliVersion,
    await readFile(path.join(from, SKILL_FILE), "utf8"),
  );
  await rm(path.join(v.skills, card, REFERENCES), { recursive: true, force: true });
  for (const reference of await cardReferences(from)) {
    const text = await readFile(path.join(from, reference), "utf8");
    await mkdir(path.dirname(path.join(v.skills, card, reference)), { recursive: true });
    await writeFile(path.join(v.skills, card, reference), text);
    v.files[`${card}/${reference}`] = {
      source: `${source}/${reference}`,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
    };
  }
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
  const skillMd = await upstreamSkillMd(options);
  const skillMdVersion = frontMatterVersion(skillMd);
  await vendorSkill(v, GENEX_SKILL, SKILL_MD_URL, skillMdVersion, skillMd);
  for (const card of GENEX_CARDS) await vendorCard(v, path.join(cli, "templates", "skills"), card);
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
