/**
 * The plugin-author skill the Genex plugin carries, read the way an agent reads it (`genex__skill`, page
 * by page) and its example plugin written where the skill says: each fenced block that follows a line
 * naming a file under `genex-plugins/`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginBinding, PluginSkillPage } from "../../src/shared/plugins.ts";
import type { PluginRegistry } from "../../src/substrate/plugins/registry.ts";

/** The skill's name and the files it lists, as the Genex plugin declares them. */
export const PLUGIN_AUTHOR = {
  skill: "plugin-author",
  tool: "genex__skill",
  references: [
    "skills/plugin-author/references/manifest.md",
    "skills/plugin-author/references/backend.md",
    "skills/plugin-author/references/skill.md",
  ],
} as const;

/** A file named on its own line, then the fenced block that holds it. */
const EXAMPLE_FILE = /`(genex-plugins\/[^`\s]+)`[^\n]*\n\n?```[a-z]*\n([\s\S]*?)\n```/g;

/** The whole text of one skill file (the skill's own with no `file`), read page by page. */
export async function readSkill(registry: PluginRegistry, binding: PluginBinding, file?: string): Promise<string> {
  let text = "";
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const args = { name: PLUGIN_AUTHOR.skill, offset, ...(file ? { file } : {}) };
    const page = (await registry.tool(PLUGIN_AUTHOR.tool, args, binding)) as PluginSkillPage;
    text += page.text;
    offset = page.nextOffset;
  }
  return text;
}

/** Each file the text writes: its path under the project and its body. */
export function exampleFiles(text: string): Array<{ file: string; body: string }> {
  return [...text.matchAll(EXAMPLE_FILE)].map((match) => ({ file: match[1] ?? "", body: `${match[2] ?? ""}\n` }));
}

/**
 * The skill's example plugin, written into `project` as the skill says: every file its references
 * name. Answers the plugin's folder and the files written, relative to `project`.
 */
export async function writeSkillExample(
  registry: PluginRegistry,
  binding: PluginBinding,
  project: string,
): Promise<{ folder: string; files: string[] }> {
  const files: string[] = [];
  for (const reference of PLUGIN_AUTHOR.references) {
    for (const { file, body } of exampleFiles(await readSkill(registry, binding, reference))) {
      await mkdir(path.dirname(path.join(project, file)), { recursive: true });
      await writeFile(path.join(project, file), body);
      files.push(file);
    }
  }
  const folders = [...new Set(files.map((file) => file.split("/").slice(0, 2).join("/")))];
  if (folders.length !== 1 || !folders[0]) throw new Error(`The example writes ${folders.length} plugin folders`);
  return { folder: folders[0], files };
}
