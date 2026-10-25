import { t } from "./i18n.ts";

/** Plain names for the harness's instruction files, for people who never read them; functions, as main loads this before its language. */
const SKILLS: Record<string, () => string> = {
  "facet-decomposition": () => t("how Harness plans a build"),
  director: () => t("how Harness leads a build"),
};

/** "Harness updated how it plans a build.": the chat's whole sentence for each named instruction file. */
const SKILLS_UPDATED: Record<string, () => string> = {
  "facet-decomposition": () => t("Harness updated how it plans a build."),
  director: () => t("Harness updated how it leads a build."),
};

/** An instruction file's name as the harness records it: "skills/director.md" is "director". */
const skillSlug = (skill: string | undefined): string => (skill ?? "").replace(/^skills\//, "").replace(/\.md$/, "");

const namedIn = (table: Record<string, () => string>, slug: string): (() => string) | undefined =>
  Object.hasOwn(table, slug) ? table[slug] : undefined;

export function skillWords(skill: string | undefined): string {
  const slug = skillSlug(skill);
  const named = namedIn(SKILLS, slug);
  if (named) return named();
  return slug
    ? t("Harness's {skill} instructions", { skill: slug.replace(/[-_]+/g, " ") })
    : t("Harness's instructions");
}

/** The chat's line when Harness changed one of its instruction files: "Harness updated how it plans a build." */
export function skillUpdatedWords(skill: string | undefined): string {
  const named = namedIn(SKILLS_UPDATED, skillSlug(skill));
  return named ? named() : t("Harness updated {skill}.", { skill: skillWords(skill) });
}

/** A proposal's own plain title when the proposer wrote one; older proposals name what they change. */
export function proposalTitle(proposal: { title?: string; skill?: string }): string {
  return proposal.title?.trim() || t("Change {skill}", { skill: skillWords(proposal.skill) });
}

export function changeTitle(change: { title?: string; skill?: string; file?: string }): string {
  return change.title?.trim() || t("Changed {skill}", { skill: skillWords(change.skill || change.file) });
}

/**
 * "3 games": an English count and noun. Kept for callers not yet translated; a translated
 * sentence writes its count as an ICU plural inside `t()` instead, since languages inflect nouns
 * by number differently.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
