/**
 * What a project that isn't a game is, as the sidebar shows it beside its name: while the project
 * holds a fact the scaffold's rules found, the app's word for that fact ("Unreal plugin") or else the
 * scaffold's label; otherwise the word of the kind it holds when it holds no game ("Blender assets").
 * A game, and a project with no kind yet, show nothing. Pure: the listed game in, a label or null out.
 */
import type { GameProject } from "../shared/game-project.ts";
import { FactSource } from "../shared/project-facts.ts";
import { PROJECT_KIND_WORDS } from "./words.ts";

const KIND_WORDS: Readonly<Record<string, string>> = PROJECT_KIND_WORDS;

/** The label beside a project's name, or null for a game and for a project with no kind yet. */
export function projectKindLabel(game: Pick<GameProject, "facts" | "scaffold">): string | null {
  const facts = game.facts ?? [];
  const scaffolded = facts.find((fact) => fact.source === FactSource.Scaffold);
  // studio.json keeps the label in the words it was made in; a fact the app names reads in the app's language.
  if (game.scaffold && scaffolded) {
    const word = Object.hasOwn(KIND_WORDS, scaffolded.id) ? KIND_WORDS[scaffolded.id] : undefined;
    return word ?? game.scaffold.label;
  }
  if (facts.length === 0 || facts.some((fact) => !Object.hasOwn(KIND_WORDS, fact.id))) return null;
  return KIND_WORDS[facts[0]?.id ?? ""] ?? null;
}
