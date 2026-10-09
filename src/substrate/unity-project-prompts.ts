/** Instructions added only when a Unity project has no instructions of its own. */
export const UNITY_PROJECT_RULES = `# Unity project

This is an existing Unity source project. Open it in Unity Editor with the Genex Unity package and use the Unity plugin's skills and tools to inspect it.

- Preserve Assets/, Packages/, ProjectSettings/ and every asset's .meta file and GUID.
- Keep existing scenes, prefabs, render pipeline and input system. Inspect the project before changing them.
- Edit scenes, components and prefabs through the Unity Editor bridge with Undo, then save deliberately.
- After changing C# files, wait for compilation and inspect compiler diagnostics. Run the relevant EditMode or PlayMode tests and verify the Game view.
- Use the Editor bridge for play mode, screenshots, asset imports and builds. Browser templates and npm builds do not run this project.
- Ask before destructive project changes or installing packages. The bridge runs with the Unity Editor's user permissions.
- Keep generated outputs and build evidence separate from Assets/ sources. Never commit Library/, Temp/, Obj/, Logs/ or UserSettings/.
`;

/** Initial notes for a native Unity project, without browser entry or contract instructions. */
export function unityProjectNotes(title: string): string {
  return `# ${title}\n\nThis folder contains a Unity source project. Genex preserves its scenes, scripts and package manifest.\n\nOpen this project in Unity Editor and enable the Genex Unity bridge before editing, playing, testing or building. Structural validation alone does not establish Editor readiness or successful script compilation.\n`;
}
