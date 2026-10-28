/**
 * What makes a game's source a game, by its files: a Genex game's record or a page at its root,
 * packages that build it, or an engine's project near the top. A README, ignore rules or a publish's
 * bookkeeping alone are no game: that is the source of a game whose creator never shared its
 * project. Remix asks it of a copy it made (`holdsGame`), and Play of a source on Genex before it
 * offers Remix at all (`remix-ready.ts`).
 */

/** How many folders may sit above an engine project's marking file (`unity/ProjectSettings/…` has two). */
export const ENGINE_PROJECT_DEPTH = 3;

/**
 * A file that marks an engine's project in its folder: Godot's, Unreal's, a Roblox place, or Rojo's
 * project file (Roblox's games kept as files).
 */
const isEngineMark = (name: string): boolean =>
  name === "project.godot" ||
  name.endsWith(".uproject") ||
  name.endsWith(".rbxl") ||
  name.endsWith(".rbxlx") ||
  name === "default.project.json";

/** Whether `paths` (a source's files, `/` between parts) hold a game's mark: its root record or page, or an engine's project. */
export function marksGame(paths: readonly string[]): boolean {
  for (const file of paths) {
    if (file === "studio.json" || file === "index.html") return true;
    const parts = file.split("/");
    if (parts.slice(0, -1).some((part) => part.startsWith(".") || part === "node_modules")) continue;
    const name = parts.at(-1) ?? "";
    const folders = parts.length - 1;
    if (isEngineMark(name) && folders < ENGINE_PROJECT_DEPTH) return true;
    if (file.endsWith("ProjectSettings/ProjectVersion.txt") && folders <= ENGINE_PROJECT_DEPTH) return true;
  }
  return false;
}

/** Whether a package.json's text names scripts: a game built with npm runs something. */
export function packageRuns(text: string | null): boolean {
  if (!text) return false;
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown } | null)?.scripts;
    return typeof scripts === "object" && scripts !== null && Object.keys(scripts).length > 0;
  } catch {
    return false;
  }
}

/** Whether a source with these files holds a game; `packageJson` is its root package.json's text, when it has one. */
export function sourceHoldsGame(paths: readonly string[], packageJson: string | null): boolean {
  return marksGame(paths) || packageRuns(packageJson);
}
