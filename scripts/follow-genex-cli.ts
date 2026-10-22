/**
 * Follow the Genex CLI: when npm's `latest` `@genex-ai/cli-demo` is newer than the pin Studio ships,
 * make the same bump a person made by hand in #90 so the plugin's tools reach desktop users without
 * waiting for someone to notice. Run by `.github/workflows/genex-cli-follow.yml`.
 *
 *   node scripts/follow-genex-cli.ts --check   prints `pinned=`, `latest=`, `behind=` lines
 *   node scripts/follow-genex-cli.ts --apply   pins latest, refreshes the vendored skills, bumps the
 *                                               plugin's patch version and the version mentions
 *
 * Every rewrite of a version mention must match at least once: a file whose wording moved fails the
 * run with its name instead of opening a pull request that silently leaves the old version behind.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeManifest } from "./refresh-genex-skills.ts";

const run = promisify(execFile);

const CLI_PACKAGE = "@genex-ai/cli-demo";
const MANIFEST = "src/plugins/genex/plugin.json";
/** The registry document whose `dist-tags.latest` is what users get from `npx`. */
const REGISTRY_URL = `https://registry.npmjs.org/${CLI_PACKAGE}`;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** One version mention outside package.json and the vendored skills, rewritten on every bump. */
export interface VersionMention {
  file: string;
  /** The text around the version; `{v}` marks where it goes. */
  pattern: string;
  /** Whether the mention names the CLI version or the plugin version. */
  of: "cli" | "plugin";
}

/** Where the last hand bump (#90) changed a version by hand. */
export const VERSION_MENTIONS: readonly VersionMention[] = [
  { file: "THIRD-PARTY-NOTICES.md", pattern: "`@genex-ai/cli-demo` {v} `templates/skills`", of: "cli" },
  { file: "THIRD-PARTY-NOTICES.md", pattern: "https://genex.games/SKILL.md (v{v})", of: "cli" },
  { file: "tests/conformance/genex-plugin-cli.test.ts", pattern: '.version, "{v}")', of: "cli" },
];

function parts(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Not a plain x.y.z version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate` is a strictly newer plain x.y.z version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The plugin's next patch version: a bundled plugin reaches a profile only through a version bump. */
export function nextPatch(version: string): string {
  const [major, minor, patch] = parts(version);
  return `${major}.${minor}.${patch + 1}`;
}

/** Replace every occurrence of a mention's old text; throws when the old text is gone. */
export function rewriteMention(text: string, mention: VersionMention, from: string, to: string): string {
  const before = mention.pattern.replace("{v}", from);
  if (!text.includes(before)) throw new Error(`${mention.file}: no longer contains ${JSON.stringify(before)}`);
  return text.split(before).join(mention.pattern.replace("{v}", to));
}

async function readJson(root: string, file: string) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

async function latestOnNpm(): Promise<string> {
  const response = await fetch(REGISTRY_URL, { headers: { accept: "application/vnd.npm.install-v1+json" } });
  if (!response.ok) throw new Error(`${REGISTRY_URL} answered ${response.status}`);
  const body = await response.json();
  const latest = body?.["dist-tags"]?.latest;
  if (typeof latest !== "string") throw new Error(`${REGISTRY_URL} has no dist-tags.latest`);
  return latest;
}

async function pinned(root: string): Promise<string> {
  return (await readJson(root, "package.json")).dependencies[CLI_PACKAGE];
}

async function check(root: string): Promise<void> {
  const current = await pinned(root);
  const latest = await latestOnNpm();
  console.log(`pinned=${current}\nlatest=${latest}\nbehind=${isNewer(latest, current)}`);
}

async function apply(root: string): Promise<void> {
  const fromCli = await pinned(root);
  const toCli = await latestOnNpm();
  if (!isNewer(toCli, fromCli)) throw new Error(`Already on ${fromCli}; npm latest is ${toCli}`);
  // --save-exact keeps the exact pin #90 relies on; --ignore-scripts skips Electron's download.
  await run("npm", ["install", "--save-exact", "--ignore-scripts", `${CLI_PACKAGE}@${toCli}`], { cwd: root });
  // The refresh rewrites the cards' references in plugin.json, so the manifest is read after it.
  await run("npm", ["run", "--silent", "genex:skills", "--", "--fetch"], { cwd: root });

  const manifest = await readJson(root, MANIFEST);
  const fromPlugin: string = manifest.version;
  const toPlugin = nextPatch(fromPlugin);
  manifest.version = toPlugin;
  await writeManifest(root, path.join(root, MANIFEST), manifest);
  for (const mention of VERSION_MENTIONS) {
    const file = path.join(root, mention.file);
    const [from, to] = mention.of === "cli" ? [fromCli, toCli] : [fromPlugin, toPlugin];
    await writeFile(file, rewriteMention(await readFile(file, "utf8"), mention, from, to));
  }
  console.log(`cli=${toCli}\nplugin=${toPlugin}\nfrom_cli=${fromCli}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mode = process.argv[2];
  if (mode === "--check") await check(root);
  else if (mode === "--apply") await apply(root);
  else throw new Error("Use --check or --apply");
}
