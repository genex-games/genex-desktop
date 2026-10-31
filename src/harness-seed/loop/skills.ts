/**
 * Skills.
 *
 * A skill is a markdown file with YAML-ish frontmatter (`name`, `description`). The index (name +
 * description) is injected into every prompt; bodies are fetched on demand by the `read_skill`
 * tool.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** A skill file as parsed: its frontmatter, its body and the text it came from. */
export interface ParsedSkill {
  name: string;
  description: string;
  frontmatter: Record<string, string>;
  body: string;
  raw: string;
}

/** A skill in the workspace: parsed, and where it lives. */
export interface Skill extends ParsedSkill {
  file: string;
  slug: string;
}

export async function loadSkills(workspace: string): Promise<Skill[]> {
  const dir = path.join(workspace, "skills");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    // `<slug>.best.md` is an archive copy an earlier version kept of a skill — history, not a
    // second live skill: loading it would double the skill in the prompt.
    if (entry.name.endsWith(".best.md")) continue;
    const file = path.join(dir, entry.name);
    const text = await readFile(file, "utf8");
    skills.push({ ...parseSkill(text), file, slug: entry.name.replace(/\.md$/, "") });
  }
  return skills.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function parseSkill(text: string): ParsedSkill {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta: Record<string, string> = {};
  let body = text;
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1]!.split("\n")) {
      const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
    }
  }
  return {
    name: meta.name ?? "unnamed",
    description: meta.description ?? "",
    frontmatter: meta,
    body: body.trim(),
    raw: text,
  };
}

export function formatSkillIndex(skills: ReadonlyArray<Pick<Skill, "name" | "slug" | "description">>): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- **${skill.name}** (${skill.slug}): ${skill.description}`);
  return [
    "## Your skills",
    "Reference notes you may read with `read_skill` when one helps; none is required.",
    ...lines,
  ].join("\n");
}
