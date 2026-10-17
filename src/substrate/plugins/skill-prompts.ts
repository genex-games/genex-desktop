/** What a builder's brief says about a plugin's file skills, which it reads on demand. */
import { PLUGIN_SKILL_TOOL, type PluginFileSkill } from "../../shared/plugins.ts";

/**
 * The brief's one line for a file skill: its summary and exactly how to read the whole of it.
 * `where` follows its name when it applies only in part of the folder (" (for site/)").
 */
export function fileSkillIndexLine(plugin: string, skill: PluginFileSkill, where = ""): string {
  const call = `${plugin}__${PLUGIN_SKILL_TOOL} ${JSON.stringify({ name: skill.name })}`;
  return `[${plugin}/${skill.name}]${where} ${skill.summary} Read it with ${call} before that work.`;
}
