/**
 * The brief's words for a game linked to a Godot project (`studio.json` `engine`, kind `godot`):
 * the project's folder, which may lie outside the game's, is where its scenes and scripts change,
 * and the game's notes stay in its workspace. Unreal's own words are in `unreal-prompts.ts`.
 */

/** The folder of a linked project file (its `project.godot`). */
export function projectFolderOf(projectFile: string): string {
  const cut = Math.max(projectFile.lastIndexOf("/"), projectFile.lastIndexOf("\\"));
  return cut > 0 ? projectFile.slice(0, cut) : projectFile;
}

/** Where a linked Godot game's work happens, in place of the workspace rule. */
export function godotWorkspaceRule(projectFile: string): string {
  return `The game's work happens in its Godot project in \`${projectFolderOf(projectFile)}/\` (res:// is that folder) and in this workspace's notes: never in another copy of this game, in another game's folder or in another Godot project, and a path the user named is a stills folder to look at, not a parent to walk. When the user asks about something elsewhere on their computer (another folder, their Downloads, their disk), that is the ask: what you may reach is your session's permissions, not this brief.`;
}

/** The brief's closing line for a linked Godot game: where its work lands, and the folder of its notes. */
export function godotWorkHere(projectFile: string, folderLabel: string): string {
  const notes = folderLabel ? `this workspace (folder \`${folderLabel}\`)` : "this workspace";
  return `The game's work lands in its Godot project in \`${projectFolderOf(projectFile)}/\`; its notes stay in ${notes}.`;
}
