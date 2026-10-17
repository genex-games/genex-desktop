/**
 * The skills a Loop's brief reads: the seed skills whose facts reach the folder. A skill names the
 * facts it serves in its front matter (`facts: web-game`); the web method (the director's playbook,
 * the facet decomposition) serves web games only, so a Loop that works in place on any other project
 * never carries it.
 *
 * A module of its own: `skills.ts` is one an agent may have kept from before, and a kept copy exports
 * only what it did then.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CoreFact, type FactsOfDescriptor, LoopProfile, loopProfileOf, servedFactsOf } from "./folder-facts.ts";
import { loadSkills, parseSkill, type ParsedSkill } from "./skills.ts";

/** A skill's front matter, as its first lines spell it: what a brief leaves out. */
const FRONT_MATTER = /^---[\s\S]*?---\n?/;

/** A skill that reaches a Loop: its slug, the facts it serves and its text without its front matter. */
export interface LoopSkill {
  slug: string;
  facts: string[];
  text: string;
}

/**
 * The facts a skill serves: its front matter's comma-separated `facts`. Every seed skill before
 * facts was the web method's, so one that names none (a copy kept from then) serves web games.
 */
export function skillFacts(skill: Pick<ParsedSkill, "frontmatter">): string[] {
  const named = (skill.frontmatter.facts ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return named.length > 0 ? named : [CoreFact.WebGame];
}

/**
 * The fact ids a Loop on the game works by: those it is served by. A Loop that works in place (one
 * on a project that isn't a web game) takes no web method, even where a web site is served in it.
 */
function loopFacts(game: FactsOfDescriptor): string[] {
  const served = servedFactsOf(game).map((fact) => fact.id);
  if (loopProfileOf(game) === LoopProfile.Web) return served;
  return served.filter((id) => id !== CoreFact.WebGame);
}

/** Whether a skill reaches a Loop on the game: one of the facts it serves is one the Loop works by. */
function reaches(skill: Pick<ParsedSkill, "frontmatter">, game: FactsOfDescriptor): boolean {
  const facts = loopFacts(game);
  return skillFacts(skill).some((id) => facts.includes(id));
}

/** The workspace's skills that reach a Loop on the game, each without its front matter. */
export async function loopSkills(workspace: string, game: FactsOfDescriptor): Promise<LoopSkill[]> {
  const skills = await loadSkills(workspace);
  return skills
    .filter((skill) => reaches(skill, game))
    .map((skill) => ({ slug: skill.slug, facts: skillFacts(skill), text: skill.raw.replace(FRONT_MATTER, "") }));
}

/** One skill's text without its front matter when it reaches a Loop on the game; "" when not, or when it can't be read. */
export async function loopSkill(workspace: string, slug: string, game: FactsOfDescriptor): Promise<string> {
  try {
    const text = await readFile(path.join(workspace, "skills", `${slug}.md`), "utf8");
    return reaches(parseSkill(text), game) ? text.replace(FRONT_MATTER, "") : "";
  } catch {
    return "";
  }
}
