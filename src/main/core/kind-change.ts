/**
 * A plugin tool that changes what a game is: one whose manifest declares `makes` (the facts it
 * makes in the game's folder, a new project of a kind or a port). It never runs while a run of the
 * game is going; otherwise the game is snapshotted first (the way back), and once the call made one
 * of its kinds, the web game it took the place of is recorded as the game's `portedFrom` (the web
 * files stay in the folder as the reference, no longer as a kind; every other fact keeps counting),
 * the scaffold its plugin names for the tool as the game's `scaffold` (whose rules keep finding the
 * facts it made), and the session is told to end its reply: the turn ends and Genex continues the
 * same session with the tools for the new kind. A call that only links the game to a project it
 * already holds (its tool's `links`) changes nothing about what the game is, so a run going on never
 * stops it, and it runs as any call does.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import { SnapshotScope } from "../../shared/event-log.ts";
import type { PluginManifestTool } from "../../shared/plugins.ts";
import { CoreFact, hasFact, type ProjectFact, type ScaffoldRecord } from "../../shared/project-facts.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { projectFileOf } from "../../substrate/game-engine-binding.ts";
import { isBelow } from "../../substrate/paths.ts";
import type { StudioCore } from "../studio-core.ts";
import { KIND_CHANGE_MESSAGE } from "./kind-change-prompts.ts";

/** Why a kind-changing call was refused, as its answer names it. Wire values: never rename one. */
export const KindChangeRefusal = { RunGoing: "run_going" } as const;
export type KindChangeRefusal = (typeof KindChangeRefusal)[keyof typeof KindChangeRefusal];

/**
 * A kind-changing call under way: its game, the facts its tool makes, the game's facts before it,
 * and the scaffold its plugin names for the tool (recorded once the call made one of its kinds).
 */
export interface KindChange {
  project: string;
  tool: string;
  makes: readonly string[];
  before: ProjectFact[];
  scaffold?: ScaffoldRecord;
}

/** The answer of a kind-changing call that did not run. */
export interface KindChangeRefused {
  refused: KindChangeRefusal;
  message: string;
}

/** A plugin tool's name a session calls it by (`<plugin>__<tool>`), taken apart; null for any other. */
function pluginToolName(name: string): { pluginId: string; tool: string } | null {
  const split = name.indexOf("__");
  return split > 0 ? { pluginId: name.slice(0, split), tool: name.slice(split + 2) } : null;
}

/** A plugin tool as its manifest declares it, by the name a session calls it; undefined for any other. */
function manifestTool(core: Pick<StudioCore, "plugins">, name: string): PluginManifestTool | undefined {
  const named = pluginToolName(name);
  if (!named) return undefined;
  const manifest = core.plugins.list().find((p) => p.manifest.id === named.pluginId)?.manifest;
  return manifest?.tools.find((t) => t.name === named.tool);
}

/** The facts a plugin tool makes in its game's folder (`makes`), by the name a session calls it; empty for any other. */
export function madeBy(core: Pick<StudioCore, "plugins">, name: string): readonly string[] {
  return manifestTool(core, name)?.makes ?? [];
}

/**
 * Before a call that makes `makes` in `project`'s folder: refused (an answer, never a throw) while a
 * run of the game is going, and nothing is taken, unless the call only links the game to a project
 * it already holds (`linksHeldProject`): then null, and it runs as any call. Otherwise a game
 * snapshot and the game's raw facts.
 */
export async function beforeKindChange(
  core: StudioCore,
  project: string,
  tool: string,
  makes: readonly string[],
  args: Readonly<Record<string, unknown>> = {},
): Promise<KindChange | KindChangeRefused | null> {
  const running = (await core.pluginServices.runningGames?.()) ?? [];
  if (running.some((game) => game.project === project)) {
    if (await linksHeldProject(core, project, tool, args)) return null;
    const links = manifestTool(core, tool)?.links !== undefined;
    return { refused: KindChangeRefusal.RunGoing, message: KIND_CHANGE_MESSAGE.runGoing(tool, links) };
  }
  await core.snapshot(SnapshotScope.Game, KIND_CHANGE_MESSAGE.snapshotReason(tool), project);
  const named = pluginToolName(tool);
  const scaffold = named ? core.plugins.scaffoldOf(named.pluginId, named.tool) : undefined;
  // Read with the same rules the after-read uses: a kind only the scaffold's rules find counts as
  // made only when it appeared during the call, never when its files were already there.
  const before = await core.games.rawFactsOf(project, scaffold);
  return { project, tool, makes, before, ...(scaffold ? { scaffold } : {}) };
}

/** The root of a game, as a fact's path spells it. */
const ROOT = ".";

/** The folder holding `file`, as a fact's path spells it: POSIX, relative to the game's `folder`, its root `.`. */
function factFolderOf(folder: string, file: string): string {
  return path.relative(folder, path.dirname(file)).split(path.sep).join("/") || ROOT;
}

/**
 * Whether the call only links `project` to a project the game already holds: its tool declares
 * `links`, and that argument is the absolute path of a project file of the plugin's engine (one that
 * keeps its projects in the game's folder) whose real path lies inside the game's real folder, where
 * the game's files already give the engine's kind. A path through a link, out of the folder,
 * relative or to anything else is no such call.
 */
async function linksHeldProject(
  core: StudioCore,
  project: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const parameter = manifestTool(core, tool)?.links;
  const file = parameter === undefined ? undefined : args[parameter];
  const pluginId = pluginToolName(tool)?.pluginId;
  const engine = pluginId === undefined ? undefined : core.plugins.engines().get(pluginId);
  if (typeof file !== "string" || !path.isAbsolute(file) || !engine?.projectInFolder) return false;
  const real = await projectFileOf(file, engine).catch(() => undefined);
  const folder = await realpath(core.games.dirFor(project)).catch(() => undefined);
  if (!real || !folder || !isBelow(folder, real)) return false;
  const facts = await core.games.rawFactsOf(project).catch(() => [] as ProjectFact[]);
  return hasFact(facts, engine.fact, factFolderOf(folder, real));
}

/**
 * The facts a port's made kinds take the place of: the web game the game was served as, at its root
 * (which covers every folder of the game, a linked project outside it included) or at a made fact's
 * own folder or one above it. Blender files, sub-projects and anything else keep counting.
 */
function replacedBy(made: readonly ProjectFact[], before: readonly ProjectFact[]): ProjectFact[] {
  const covers = (fact: ProjectFact) =>
    fact.path === ROOT || made.some((kind) => kind.path === fact.path || kind.path.startsWith(`${fact.path}/`));
  return before.filter((fact) => fact.id === CoreFact.WebGame && covers(fact));
}

/** Whether `value` is the answer of a refused kind-changing call. */
export const isRefused = (value: KindChange | KindChangeRefused): value is KindChangeRefused => "refused" in value;

/**
 * After the call answered: when it made one of its kinds, record what it replaced, tell the app the
 * game changed, and add the note that ends the session's reply to the answer (a text answer after
 * its words, an object's under `genex`). A call that made none of them answers as it did.
 */
export async function afterKindChange(core: StudioCore, change: KindChange, result: unknown): Promise<unknown> {
  const { project, makes, before, scaffold } = change;
  // A folder that can't be read now made nothing Genex can see: the call answers as it did. The
  // scaffold's rules count: a kind only they find (a plugin in its host's Plugins/) was made too.
  const after = await core.games.rawFactsOf(project, scaffold).catch(() => before);
  const made = after.filter((fact) => makes.includes(fact.id) && !hasFact(before, fact.id, fact.path));
  if (made.length === 0) return result;
  // The call already changed the folder: a record that cannot be written (a studio.json that does not
  // parse is the person's to fix, one that is a link is never written through) loses the reference,
  // never the call's answer.
  const replaced = replacedBy(made, before);
  await core.games.recordPort(project, replaced, scaffold).catch((error: unknown) => {
    core.options.onLog?.(
      `[core] could not record what ${change.tool} replaced in ${project}: ${errorMessage(error)}`,
      "stderr",
    );
  });
  core.emit(UiEvent.GameChanged, { project });
  return withNote(result, KIND_CHANGE_MESSAGE.changed(await core.games.factsOf(project)));
}

/** A tool's answer with Genex's note: after a text answer's words, else under `genex` beside the answer's own fields. */
function withNote(result: unknown, note: string): unknown {
  if (typeof result === "string") return result ? `${result}\n\n${note}` : note;
  if (result && typeof result === "object" && !Array.isArray(result))
    return { ...(result as Record<string, unknown>), genex: note };
  return { answer: result ?? null, genex: note };
}
