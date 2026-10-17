/**
 * Genex's identity for a run's workers (`appIdentity`): the run's game folder and what it holds, the
 * first thing every builder, base builder, Unreal worker and pool worker of the run is told.
 */
import { CoreFact, type FactRef } from "../folder-facts.ts";
import { appIdentity } from "../project-prompts.ts";

/** The game a director builds when its run found no facts: a web game at the folder's root. */
export const WEB_AT_ROOT: readonly FactRef[] = [{ id: CoreFact.WebGame, path: "." }];

/** The game an Unreal lead and its workers build when nothing else is known: an Unreal project at the folder's root. */
export const UNREAL_AT_ROOT: readonly FactRef[] = [{ id: CoreFact.UnrealProject, path: "." }];

/** The folder a brief names: the last two parts of the game's folder, else the run's project. */
export function folderLabelOf(dir: string | null | undefined, project: string | null | undefined): string {
  return dir ? dir.split("/").slice(-2).join("/") : String(project ?? "");
}

/** What a run's identity is read from: its run record, its game folder and what that folder holds. */
export interface RunIdentitySource {
  run: { project?: string | null };
  projectDir?: string | null;
  gameFacts?: readonly FactRef[] | null;
}

/** Genex's identity for a director's run: its game folder and what it holds (a web game at its root when nothing was found). */
export function runIdentity({ run, projectDir = null, gameFacts = null }: RunIdentitySource): string {
  return appIdentity({ folderLabel: folderLabelOf(projectDir, run.project), facts: gameFacts ?? WEB_AT_ROOT });
}

/** A brief that opens with Genex's identity; a brief with no identity to carry is left as it is. */
export function withIdentity(identity: string | null | undefined, text: string): string {
  return identity ? `${identity}\n\n${text}` : text;
}
