import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// A bundled plugin ships to every person with its version as the only signal that it changed: an
// installed copy at the same version is never replaced. So a plugin under src/plugins/<id>/ whose
// files differ from a base ref (committed, staged, unstaged or untracked) must carry a higher
// MAJOR.MINOR.PATCH version in its plugin.json than it had there. A plugin the base lacks is new and
// passes; a plugin the tree removed is not checked. Git runs through execFile with an argument list
// (never a shell), and a ref is checked before git ever sees it.

/** Where bundled plugins live, relative to the repository root. */
const PLUGINS_DIR = "src/plugins";
/** The bases tried, in order, when none is given: where the branch left them. */
const DEFAULT_BASES = ["origin/dev", "origin/main"] as const;
/** The longest ref name accepted; git's own refs and object names are far shorter. */
const MAX_REF_LENGTH = 256;
/** The longest version string read; longer ones are refused without being echoed. */
const MAX_VERSION_LENGTH = 32;
/** The largest plugin.json read. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** How many characters of a hostile value a report line may quote. */
const QUOTE_LENGTH = 40;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const PRERELEASE = /^\d+\.\d+\.\d+[-+]/;

/** The check's outcome: whether it passed, and the lines to print either way. */
export interface PluginVersionReport {
  ok: boolean;
  lines: string[];
}

/** What a run may be told: the base ref to compare against (default: the merge-base with origin/dev). */
export interface PluginVersionOptions {
  base?: string;
}

type Version = readonly [number, number, number];
type VersionRead = { version: Version } | { problem: string };

const git = (root: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

const tryGit = (root: string, args: string[]): string | undefined => {
  try {
    return git(root, args);
  } catch {
    return undefined;
  }
};

const quote = (value: string) =>
  JSON.stringify(value.length > QUOTE_LENGTH ? `${value.slice(0, QUOTE_LENGTH)}…` : value);

/** Why a ref given on the command line is refused before git sees it, or undefined when it may be asked about. */
function refProblem(ref: string): string | undefined {
  if (ref === "") return "the base ref is empty";
  if (ref.length > MAX_REF_LENGTH) return "the base ref is too long";
  if (ref.startsWith("-")) return `the base ref ${quote(ref)} looks like an option`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\u0000-\u001f\u007f]/.test(ref)) return "the base ref holds a control character";
  return undefined;
}

/** The commit a given ref names, or why it is refused. */
function resolveGivenBase(root: string, ref: string): { commit: string } | { problem: string } {
  const problem = refProblem(ref);
  if (problem) return { problem };
  const commit = tryGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (!commit?.trim()) return { problem: `the base ref ${quote(ref)} is not a commit` };
  return { commit: commit.trim() };
}

/** The base commit to compare with, or the report that ends the check before it starts. */
function resolveBase(root: string, ref: string | undefined): { base: string } | { report: PluginVersionReport } {
  if (ref === undefined) {
    const found = defaultBase(root);
    if (found) return { base: found };
    const skipped = `Plugin versions: no base (${DEFAULT_BASES.join(" or ")}) to compare with; skipped`;
    return { report: { ok: true, lines: [skipped] } };
  }
  const given = resolveGivenBase(root, ref);
  if ("problem" in given) return { report: { ok: false, lines: [`Plugin versions: ${given.problem}`] } };
  return { base: given.commit };
}

/** The merge-base of HEAD with the first default base the repository has, or undefined. */
function defaultBase(root: string): string | undefined {
  for (const ref of DEFAULT_BASES) {
    const base = tryGit(root, ["merge-base", "HEAD", ref])?.trim();
    if (base) return base;
  }
  return undefined;
}

const nulList = (text: string | undefined) => (text ?? "").split("\0").filter(Boolean);

/** The plugin ids whose files differ between the base and the working tree, untracked files included. */
function changedPlugins(root: string, base: string): Set<string> {
  const scope = ["--", `${PLUGINS_DIR}/`];
  const files = [
    ...nulList(git(root, ["diff", "--name-only", "-z", "--no-renames", base, ...scope])),
    ...nulList(git(root, ["ls-files", "-z", "--others", "--exclude-standard", ...scope])),
  ];
  const ids = new Set<string>();
  for (const file of files) {
    const id = file.slice(PLUGINS_DIR.length + 1).split("/")[0];
    if (id) ids.add(id);
  }
  return ids;
}

/** The plugin ids the base commit has a folder for. */
function pluginsAt(root: string, base: string): Set<string> {
  // A base without src/plugins has no plugins: every plugin in the tree is new.
  return new Set(nulList(tryGit(root, ["ls-tree", "-z", "-d", "--name-only", `${base}:${PLUGINS_DIR}`])));
}

/** A version read from plugin.json's text, or why it can't be used. */
function parseVersion(text: string): VersionRead {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { problem: "plugin.json is not valid JSON" };
  }
  const isRecord = typeof manifest === "object" && manifest !== null && !Array.isArray(manifest);
  const version = isRecord ? (manifest as Record<string, unknown>).version : undefined;
  if (typeof version !== "string") return { problem: "plugin.json has no version string" };
  if (version.length > MAX_VERSION_LENGTH) return { problem: "plugin.json's version is too long" };
  if (PRERELEASE.test(version)) return { problem: `prerelease versions are refused (${quote(version)})` };
  const parts = SEMVER.exec(version);
  const numbers: Version | undefined = parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : undefined;
  if (!numbers?.every(Number.isSafeInteger)) return { problem: `version ${quote(version)} is not MAJOR.MINOR.PATCH` };
  return { version: numbers };
}

/** The tree's version of a plugin, read only from a real folder and a real file inside the repository. */
function treeVersion(root: string, id: string): VersionRead | "removed" {
  const dir = path.join(root, PLUGINS_DIR, id);
  const folder = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!folder) return "removed";
  if (folder.isSymbolicLink()) return { problem: "the plugin folder is a link; a bundled plugin is a real folder" };
  if (!folder.isDirectory()) return { problem: "the plugin is not a folder" };
  const file = path.join(dir, "plugin.json");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { problem: "plugin.json is missing" };
  if (!stat.isFile()) return { problem: "plugin.json is not a plain file" };
  if (stat.size > MAX_MANIFEST_BYTES) return { problem: "plugin.json is too large" };
  return parseVersion(fs.readFileSync(file, "utf8"));
}

const show = (version: Version) => version.join(".");

function above(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The report line for one changed plugin, or undefined when it passes. */
function checkPlugin(root: string, base: string, id: string, atBase: boolean): string | undefined {
  const where = `${PLUGINS_DIR}/${id}`;
  const tree = treeVersion(root, id);
  if (tree === "removed") return undefined;
  if ("problem" in tree) return `${where}: ${tree.problem}`;
  if (!atBase) return undefined;
  const baseText = tryGit(root, ["show", `${base}:${where}/plugin.json`]);
  const before = baseText === undefined ? undefined : parseVersion(baseText);
  if (!before || "problem" in before) return undefined;
  if (above(tree.version, before.version)) return undefined;
  return `${where}: changed, but its version ${show(tree.version)} is not above ${show(before.version)} at ${base.slice(0, 12)}; raise "version" in plugin.json`;
}

/**
 * Check every bundled plugin that changed against the base. Returns whether all passed and the lines
 * to print: a refusal per plugin, a refused base, or a skip line when no base can be found.
 */
export function checkPluginVersions(root: string, options: PluginVersionOptions = {}): PluginVersionReport {
  const resolved = resolveBase(root, options.base);
  if ("report" in resolved) return resolved.report;
  const { base } = resolved;
  const atBase = pluginsAt(root, base);
  const changed = [...changedPlugins(root, base)].sort();
  const refusals = changed.flatMap((id) => checkPlugin(root, base, id, atBase.has(id)) ?? []);
  if (refusals.length) return { ok: false, lines: refusals };
  return { ok: true, lines: [`Plugin versions: ${changed.length} changed plugin(s), each with a higher version`] };
}

/** The base given as `--base <ref>` or `--base=<ref>`, if any. */
function baseArgument(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("--base");
  if (at >= 0) return argv[at + 1] ?? "";
  return argv.find((arg) => arg.startsWith("--base="))?.slice("--base=".length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = checkPluginVersions(process.cwd(), { base: baseArgument(process.argv.slice(2)) });
  if (report.ok) console.log(report.lines.join("\n"));
  else {
    console.error(report.lines.join("\n"));
    process.exitCode = 1;
  }
}
