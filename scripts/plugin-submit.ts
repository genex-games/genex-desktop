/**
 * Write a community release into a clone of the plugin catalog (genex-games/genex-plugins), ready
 * to commit and open as a pull request.
 *
 *     npm run plugin:submit -- <prebuilt-directory> --catalog <catalog-clone> --repo <owner/repo>
 *       --sha <source-commit> --category <category> [--subdir <folder>] [--docs-url <https URL>]
 *       [--min-studio-version <x.y.z>] [--artifact <file>]
 *
 * It packs the package (as `plugin:pack` does), writes `records/<id>/<version>.json`, points the
 * index entry at that release, and checks the catalog the way its CI will. The artifact is written
 * outside the catalog: it is attached to the plugin's GitHub release, and a maintainer uploads it
 * after review. Nothing is run, uploaded or pushed.
 */
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../src/shared/errors.ts";
import { PLUGIN_CATEGORIES, type PluginCategory, type PluginIndex, PluginTier } from "../src/shared/plugins.ts";
import { assertRelativePath, isInside } from "../src/substrate/paths.ts";
import { pathExists } from "../src/substrate/fsx.ts";
import { CATALOG_ARTIFACT_BASE_URL, STUDIO_CATALOG_POLICY } from "../src/substrate/plugins/marketplace.ts";
import { type CatalogSource, catalogEntry, packEnvelope, SCAFFOLD_PUBLISHER } from "../src/substrate/plugins/pack.ts";
import { checkArtifact, checkCatalog } from "../marketplace/template/scripts/check-catalog.mjs";

const USAGE = [
  "Usage: npm run plugin:submit -- <prebuilt-directory> --catalog <catalog-clone> --repo <owner/repo>",
  "  --sha <40-hex source commit> --category <assets|publishing|tools|analytics|other>",
  "  [--subdir <folder>] [--docs-url <https URL>] [--min-studio-version <x.y.z>] [--artifact <file>]",
].join("\n");
const FLAGS = [
  "--catalog",
  "--repo",
  "--sha",
  "--category",
  "--subdir",
  "--docs-url",
  "--min-studio-version",
  "--artifact",
];
const REPO = /^[-\w.]+\/[-\w.]+$/;
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** The positional directory and each `--flag value`; an unknown flag or a flag with no value is a usage error. */
function parseArgs(argv: string[]): { directory: string; catalog: string; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (!FLAGS.includes(arg) || value === undefined || value.startsWith("--")) fail(USAGE);
    flags.set(arg, value);
    i++;
  }
  const [directory] = positional;
  const catalog = flags.get("--catalog");
  if (!directory || positional.length > 1 || !catalog) fail(USAGE);
  return { directory, catalog, flags };
}

const isCategory = (value: string): value is PluginCategory => (PLUGIN_CATEGORIES as readonly string[]).includes(value);

/** Where the release's source is and how it is filed, every value checked the way the catalog checks it. */
function sourceFrom(flags: Map<string, string>): CatalogSource {
  const repo = flags.get("--repo") ?? "";
  const sha = (flags.get("--sha") ?? "").toLowerCase();
  const category = flags.get("--category") ?? "";
  if (!REPO.test(repo)) fail(`--repo must be owner/repo: "${repo}"`);
  if (!SHA.test(sha)) fail(`--sha must be the full 40-character source commit: "${sha}"`);
  if (!isCategory(category)) fail(`--category must be one of ${PLUGIN_CATEGORIES.join(", ")}: "${category}"`);
  const source: CatalogSource = { category, tier: PluginTier.Community, repo, sha };
  const subdir = flags.get("--subdir");
  if (subdir) source.subdir = assertRelativePath(subdir);
  const docsUrl = flags.get("--docs-url");
  if (docsUrl) {
    if (!URL.canParse(docsUrl) || new URL(docsUrl).protocol !== "https:") fail(`--docs-url must be an HTTPS URL`);
    source.docsUrl = docsUrl;
  }
  const minimum = flags.get("--min-studio-version");
  if (minimum) {
    if (!VERSION.test(minimum)) fail(`--min-studio-version must be x.y.z: "${minimum}"`);
    source.minStudioVersion = minimum;
  }
  return source;
}

/** The catalog's policy and index, read before anything is written. */
async function readCatalog(catalog: string): Promise<{ official: Record<string, unknown>; index: PluginIndex }> {
  const read = async (name: string) => JSON.parse(await readFile(path.join(catalog, name), "utf8"));
  const [policy, index] = await Promise.all([read("policy.json"), read("index.json")]).catch(() =>
    fail(`${catalog} is not a catalog clone: it needs policy.json and index.json`),
  );
  return { official: policy?.official ?? {}, index };
}

const parsed = parseArgs(process.argv.slice(2));
const { flags } = parsed;
const source = sourceFrom(flags);
const catalog = path.resolve(parsed.catalog);
const root = path.resolve(parsed.directory);
const { official, index } = await readCatalog(catalog);
const packed = await packEnvelope(root).catch((e: unknown) => fail(errorMessage(e)));
const { manifest } = packed;
const reserved = Object.hasOwn(official, manifest.id) || Object.hasOwn(STUDIO_CATALOG_POLICY.official, manifest.id);
if (reserved) fail(`"${manifest.id}" is an official id; community plugins need their own id`);
if (manifest.publisher === SCAFFOLD_PUBLISHER)
  fail(`Set "publisher" in plugin.json to your name first: it owns every later release of "${manifest.id}"`);

const artifact = path.resolve(
  flags.get("--artifact") ?? path.join(path.dirname(catalog), `${manifest.id}-${manifest.version}.json`),
);
if (isInside(catalog, artifact) || isInside(root, artifact))
  fail("The artifact must be written outside the catalog and the plugin package (--artifact)");
const recordName = `records/${manifest.id}/${manifest.version}.json`;
const recordFile = path.join(catalog, recordName);
if (await pathExists(recordFile))
  fail(`${recordName} is already released; a change needs a higher version in plugin.json`);

const entry = catalogEntry(packed, source, CATALOG_ARTIFACT_BASE_URL);
// The catalog as it was, so the check below compares history and ownership the way CI does.
const previous = await mkdtemp(path.join(os.tmpdir(), "plugin-submit-"));
const indexFile = path.join(catalog, "index.json");
const before = await readFile(indexFile);
try {
  for (const name of ["policy.json", "index.json", "records"])
    if (await pathExists(path.join(catalog, name)))
      await cp(path.join(catalog, name), path.join(previous, name), { recursive: true });
  await mkdir(path.dirname(recordFile), { recursive: true });
  await writeFile(recordFile, `${JSON.stringify(entry, null, 2)}\n`, { flag: "wx" });
  const plugins = index.plugins.some((p) => p.id === entry.id)
    ? index.plugins.map((p) => (p.id === entry.id ? entry : p))
    : [...index.plugins, entry];
  await writeFile(
    indexFile,
    `${JSON.stringify({ ...index, updatedAt: new Date().toISOString(), plugins }, null, 2)}\n`,
  );
  await checkCatalog({ root: catalog, previous, policyRoot: previous });
  await checkArtifact(entry, packed.bytes);
} catch (e) {
  await rm(recordFile, { force: true });
  await writeFile(indexFile, before);
  fail(`The catalog check refused this release; nothing was kept: ${errorMessage(e)}`);
} finally {
  await rm(previous, { recursive: true, force: true });
}
await writeFile(artifact, packed.bytes);

process.stdout.write(
  [
    `Wrote ${recordName} and updated index.json in ${catalog}`,
    `Artifact: ${artifact}`,
    `sha256:   ${packed.sha256}`,
    "",
    "Next:",
    `  1. Attach ${path.basename(artifact)} to the GitHub release of ${source.repo} for ${manifest.version}`,
    `     (the release at commit ${source.sha}).`,
    `  2. Commit ${recordName} and index.json on a branch of your fork and open a pull request`,
    "     against genex-games/genex-plugins main.",
    "  3. Fill in the template: the release asset link, license, contact, capabilities and evidence.",
    'A maintainer reviews the package and uploads the artifact; CI\'s "Artifacts published" step waits for that.',
    "",
  ].join("\n"),
);
