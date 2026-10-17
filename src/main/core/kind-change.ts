/**
 * A plugin tool that changes what a game is: one whose manifest declares `makes` (the facts it
 * makes in the game's folder, a new project of a kind or a port). It never runs while a run of the
 * game is going; otherwise the game is snapshotted first (the way back), and once the call made one
 * of its kinds, the web game it took the place of is recorded as the game's `portedFrom` (the web
 * files stay in the folder as the reference, no longer as a kind; every other fact keeps counting),
 * the scaffold its plugin names for the tool as the game's `scaffold` (whose rules keep finding the
 * facts it made), and the session is told to end its reply: the turn ends and Genex continues the
 * same session with the tools for the new kind.
 */
import { errorMessage } from "../../shared/errors.ts";
import { SnapshotScope } from "../../shared/event-log.ts";
import { CoreFact, hasFact, type ProjectFact, type ScaffoldRecord } from "../../shared/project-facts.ts";
import { UiEvent } from "../../shared/ui-events.ts";
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

/** The facts a plugin tool makes in its game's folder (`makes`), by the name a session calls it; empty for any other. */
export function madeBy(core: Pick<StudioCore, "plugins">, name: string): readonly string[] {
  const named = pluginToolName(name);
  if (!named) return [];
  const manifest = core.plugins.list().find((p) => p.manifest.id === named.pluginId)?.manifest;
  return manifest?.tools.find((t) => t.name === named.tool)?.makes ?? [];
}

/**
 * Before a call that makes `makes` in `project`'s folder: refused (an answer, never a throw) while a
 * run of the game is going, and nothing is taken; else a game snapshot and the game's raw facts.
 */
export async function beforeKindChange(
  core: StudioCore,
  project: string,
  tool: string,
  makes: readonly string[],
): Promise<KindChange | KindChangeRefused> {
  const running = (await core.pluginServices.runningGames?.()) ?? [];
  if (running.some((game) => game.project === project))
    return { refused: KindChangeRefusal.RunGoing, message: KIND_CHANGE_MESSAGE.runGoing(tool) };
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
