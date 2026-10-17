/**
 * `plugin_check`: a plugin folder the agent wrote in its project, read in place as an install would
 * read it (`inspectPackage`, then the install-time scan) and nothing more. It never reaches the
 * registry: only the person loads a plugin (Plugins → Add → Load local plugin…) and turns it on.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PluginManifest } from "../../shared/plugins.ts";
import type { PluginCheckAnswer } from "../../shared/project-tools.ts";
import { inspectPackage } from "../../substrate/plugins/manifest.ts";
import { scanPackage } from "../../substrate/plugins/scan.ts";
import { assertRelativePath, containedReal, relativizeWorkspace } from "../../substrate/paths.ts";
import { PLUGIN_CHECK_ANSWER } from "./project-tools-prompts.ts";

/** The manifest at the top of a plugin's folder. */
const MANIFEST_FILE = "plugin.json";
/** The longest folder path a check takes, in characters. */
const MAX_FOLDER_CHARS = 200;
/** The most scan findings an answer lists; the verdict counts them all. */
const MAX_FINDINGS = 12;
/** The parts of a manifest that say who the plugin is, never a section it adds. */
const IDENTITY = new Set(["apiVersion", "id", "version", "name", "publisher", "description", "icon", "backend"]);

/** A folder argument in the shape a project-relative path has, or null. */
function folderArg(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_FOLDER_CHARS) return null;
  try {
    return assertRelativePath(value);
  } catch {
    return null;
  }
}

/** The sections a manifest declares with something in them, in its own order (`capabilities` included). */
function sectionsOf(manifest: PluginManifest): string[] {
  return Object.entries(manifest)
    .filter(([key, value]) => !IDENTITY.has(key) && value !== undefined)
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : typeof value === "object"))
    .map(([key]) => key);
}

/** A failed read as the agent reads it: what was wrong, never a path outside the project. */
function problemOf(error: unknown, folder: string, gameDir: string): string {
  const missing = error as NodeJS.ErrnoException | undefined;
  if (missing?.code === "ENOENT" && path.basename(missing.path ?? "") === MANIFEST_FILE)
    return PLUGIN_CHECK_ANSWER.noManifest(folder);
  if (error instanceof SyntaxError) return PLUGIN_CHECK_ANSWER.notJson(folder);
  return relativizeWorkspace(error instanceof Error ? error.message : String(error), gameDir);
}

/** The plugin folder's real path inside the game, or the problem that refuses it. */
async function folderIn(gameDir: string, folder: string): Promise<{ dir: string } | { problem: string }> {
  try {
    const dir = await containedReal(gameDir, folder);
    return (await stat(dir)).isDirectory() ? { dir } : { problem: PLUGIN_CHECK_ANSWER.notFolder(folder) };
  } catch {
    return { problem: PLUGIN_CHECK_ANSWER.outside(folder) };
  }
}

/**
 * Check `args.folder`, relative to the game folder `gameDir`: it must be a real folder inside the
 * game once every link is followed, then its manifest, files and code are read as an install reads
 * them. Answers the plugin as Genex reads it, or the first problem; writes nothing anywhere.
 */
export async function checkPluginFolder(
  gameDir: string,
  args: Record<string, unknown>,
  isOn: (id: string) => boolean = () => false,
): Promise<PluginCheckAnswer> {
  const folder = folderArg(args.folder);
  if (!folder) return { ok: false, problem: PLUGIN_CHECK_ANSWER.badFolder };
  const game = await realpath(gameDir).catch(() => null);
  if (!game) return { ok: false, problem: PLUGIN_CHECK_ANSWER.outside(folder) };
  const found = await folderIn(game, folder);
  if ("problem" in found) return { ok: false, problem: found.problem };
  try {
    const manifest = await inspectPackage(found.dir);
    const scan = await scanPackage(found.dir, manifest);
    return {
      ok: true,
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      tools: manifest.tools.map((tool) => tool.name),
      skills: manifest.skills.map((skill) => skill.name),
      sections: sectionsOf(manifest),
      scan: {
        verdict: scan.verdict,
        findings: scan.findings.slice(0, MAX_FINDINGS).map(({ rule, severity, file, line }) => ({
          rule,
          severity,
          file,
          line,
        })),
      },
      next: isOn(manifest.id) ? PLUGIN_CHECK_ANSWER.nextWhileOn(folder) : PLUGIN_CHECK_ANSWER.next(folder),
    };
  } catch (error) {
    return { ok: false, problem: problemOf(error, folder, game) };
  }
}
