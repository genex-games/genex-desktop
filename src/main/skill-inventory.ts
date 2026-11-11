import path from "node:path";
import { readdir, readFile, lstat, realpath } from "node:fs/promises";

/** The largest skill file the inventory reads, in bytes. */
const SKILL_FILE_MAX_BYTES = 256 * 1024;
/** A skill file's extension, and the one SkillOpt gives the archived best copy beside it. */
const SKILL_EXTENSION = ".md";
const ARCHIVED_SKILL_EXTENSION = ".best.md";

/** An active skill's file name: markdown, and not an archived SkillOpt copy. */
function isActiveSkillName(name: string): boolean {
  return name.endsWith(SKILL_EXTENSION) && !name.endsWith(ARCHIVED_SKILL_EXTENSION);
}

/** Read only Studio-owned active skills, never provider homes or archived SkillOpt copies. */
export async function studioSkills(
  workspace: string,
): Promise<Array<{ name: string; text: string; description: string }>> {
  const parent = await realpath(workspace).catch(() => null);
  if (!parent) return [];
  const dir = path.join(parent, "skills");
  const root = await realpath(dir).catch(() => null);
  if (!root || root !== dir) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !isActiveSkillName(entry.name)) continue;
    const file = path.join(root, entry.name);
    const info = await lstat(file);
    if (info.size > SKILL_FILE_MAX_BYTES || (await realpath(file)) !== file) continue;
    const text = await readFile(file, "utf8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const field = (key: string) =>
      new RegExp(`^${key}:\\s*(.*)$`, "m")
        .exec(front)?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, "");
    const name = field("name") ?? entry.name.slice(0, -SKILL_EXTENSION.length);
    result.push({ name, description: field("description") ?? "", text });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
