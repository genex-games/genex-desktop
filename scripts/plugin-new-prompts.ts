/** The notes `plugin:new` leaves for the author's coding agent, as the scaffold's AGENTS.md. */
import { PLUGIN_GUIDE_URL } from "../src/shared/plugins.ts";
import { PLUGIN_ID } from "../src/shared/plugin-id.ts";

/** AGENTS.md for a scaffolded plugin: what the package is, the rules that fail validation, and how to check and ship it. */
export function scaffoldAgentsGuide(id: string, name: string): string {
  return `# ${name}: notes for coding agents

This folder is a Genex plugin package: \`plugin.json\` declares it, \`backend.mjs\` runs its tools
and actions, \`panel.html\` is its settings panel. The full contract is the plugin guide:
${PLUGIN_GUIDE_URL}

The host API is typed in \`plugin-sdk/index.d.ts\`. Check the backend against it with
\`tsc -p jsconfig.json\` or your editor; nothing from Genex's source is imported.

## Rules that fail validation

- Ids (the plugin, its tools, actions, settings, panels, skills and toolbar buttons) match
  \`${PLUGIN_ID.source}\`: \`get-scene\`, not \`get_scene\`.
- Agents call your tools as \`<plugin>__<tool>\`, here \`${id}__greet\`. Name them that way in skill text.
- \`activate\` has no side effects: no file writes, network or host calls. Genex loads it to probe the package.
- Declare every capability the backend uses, and only those; list every host it contacts in
  \`network.hosts\`. Plugins run as trusted code on the user's computer: ask for the least you need,
  and never take credentials as tool parameters.
- Panels are self-contained HTML: inline scripts and styles, no \`http(s)://\` URLs.
- Tools and ordinary actions time out after 190 seconds.
- Set \`publisher\` to your name before the first release, and raise \`version\` for every release:
  a released version never changes.

## Check, run and ship (from a Genex checkout, on Node 24)

- \`npm run plugin:doctor -- <this folder>\` runs the validator, the scan and a probe load. Fix every error.
- In Genex: Plugins → Add → Load local plugin…, then the plugin's page → More (…) → Watch folder
  to reload on every save.
- \`npm run plugin:pack -- <this folder> <file outside it>\` writes the release artifact.
- \`npm run plugin:submit -- <this folder> --catalog <clone of genex-games/genex-plugins> --repo <owner/repo>
  --sha <commit> --category <category>\` writes the catalog record to propose for review.

\`AGENTS.md\`, \`jsconfig.json\` and \`plugin-sdk/\` are for authoring; packing leaves them out.
`;
}
