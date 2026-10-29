/**
 * The engine editors main relays play-time AI for (`editor-relays.ts`): each library game's Godot or
 * Unity project, found by its facts and reached by its real path inside the game's folder. The
 * folder is agent-writable, so a project that leads out of it (a `..`, an absolute path, a link) is
 * never relayed. Unreal's editor is reached through its plugin's own port record, which main does
 * not read, so an Unreal game is not relayed here.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectFact } from "../../shared/project-facts.ts";
import { CoreFact } from "../../shared/project-facts.ts";
import { isInside } from "../../substrate/paths.ts";
import type { EditorAiChannel } from "./bridge-editor.ts";
import type { EditorAiTarget } from "./editor-relays.ts";

/** A library game as the relays read it. */
export interface EditorAiLibraryGame {
  name: string;
  title: string;
  dir: string;
  facts: readonly Pick<ProjectFact, "id" | "path">[];
}

/** The channel of each engine whose editor main can reach, over the engine project's real folder. */
export interface EditorAiChannels<C = EditorAiChannel> {
  godot(dir: string): C;
  unity(dir: string): C;
}

/** The facts whose project main relays for, and the channel each takes. */
const RELAYED = {
  [CoreFact.GodotProject]: "godot",
  [CoreFact.UnityProject]: "unity",
} as const satisfies Partial<Record<CoreFact, keyof EditorAiChannels>>;

const isRelayed = (id: string): id is keyof typeof RELAYED => Object.hasOwn(RELAYED, id);

/** The project folder a fact names, by its real path, when it is the game's folder or inside it; else null. */
async function projectFolder(gameDir: string, where: string): Promise<string | null> {
  if (path.isAbsolute(where) || where.includes("\0") || where.split(/[\\/]/).includes("..")) return null;
  const base = await realpath(gameDir).catch(() => null);
  const real = base ? await realpath(path.join(base, where)).catch(() => null) : null;
  if (!base || !real || !isInside(base, real)) return null;
  return (await stat(real).catch(() => null))?.isDirectory() ? real : null;
}

/** The editors to relay for `games`, each project once. */
export async function editorAiTargets<C = EditorAiChannel>(
  games: readonly EditorAiLibraryGame[],
  channels: EditorAiChannels<C>,
): Promise<Array<Omit<EditorAiTarget, "channel"> & { channel: C }>> {
  const targets: Array<Omit<EditorAiTarget, "channel"> & { channel: C }> = [];
  const seen = new Set<string>();
  for (const game of games) {
    for (const fact of game.facts) {
      if (!isRelayed(fact.id)) continue;
      const dir = await projectFolder(game.dir, fact.path);
      const key = dir ? `${fact.id}:${dir}` : null;
      if (!dir || !key || seen.has(key)) continue;
      seen.add(key);
      targets.push({
        key,
        game: { name: game.name, title: game.title },
        cwd: dir,
        channel: channels[RELAYED[fact.id]](dir),
      });
    }
  }
  return targets;
}
