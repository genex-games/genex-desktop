/** What Genex's own project tools say to a model: their descriptions and their answers. Model-facing text. */
import type { LiveToolSpec } from "../../shared/engine-requests.ts";
import { GENEX_PLUGIN_AUTHOR_SKILL, GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import { PLUGIN_SKILL_TOOL } from "../../shared/plugins.ts";
import { FindNext, ProjectTool } from "../../shared/project-tools.ts";

/** `start_web_game`: the web starter, written into a folder with no kind yet. Takes no parameters. */
export const START_WEB_GAME_TOOL: LiveToolSpec = {
  name: ProjectTool.StartWebGame,
  description:
    "Make this game a web game: Genex writes its three.js starter here, which Live shows beside the chat. Only while the folder has no kind yet.",
  parameters: { type: "object", properties: {} },
};

/** What a project tool answers. */
export const PROJECT_TOOL_ANSWER = {
  webStarted: "The web starter is in the folder; build on it.",
  inPlan:
    "The chat is in Plan mode, so the web starter was not written: it waits until the plan is approved. Put it in your plan instead.",
} as const;

/** What a Genex plugin is, told with every search: an engine's own plugins are not one. */
const GENEX_PLUGINS =
  "These are Genex plugins (Plugins in Genex's sidebar), which add tools and know-how to Genex. An engine's own plugins and add-ons are files in the project, not Genex plugins.";

/** `plugins_find`: read-only, so it runs in Plan mode too. */
export const PLUGINS_FIND_TOOL: LiveToolSpec = {
  name: ProjectTool.PluginsFind,
  description:
    "Find a Genex plugin for a kind of project or a tool the person named. Read-only: it lists the plugins that are on, those installed but off, and those in Genex's catalog, and says what to do next. Give `fact` (a kind of project, e.g. godot-project or unreal-project) or `text` (words such as an engine's name), or both.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "A kind of project, e.g. godot-project, unreal-project, blender-assets." },
      text: { type: "string", description: "Words to look for in a plugin's name or description, e.g. Unreal." },
    },
  },
};

/** `plugins_suggest`: shows the person a card; it never turns a plugin on. */
export const PLUGINS_SUGGEST_TOOL: LiveToolSpec = {
  name: ProjectTool.PluginsSuggest,
  description:
    "Show the person a card to turn on, or install, a Genex plugin that plugins_find listed as off or in the catalog. Only the person's click turns it on: end your reply after calling this.",
  parameters: {
    type: "object",
    properties: {
      plugin: { type: "string", description: "The plugin's id, as plugins_find listed it." },
      reason: {
        type: "string",
        description: "One sentence for the person: why this plugin helps with what they asked.",
      },
    },
    required: ["plugin", "reason"],
  },
};

/** What `plugins_find` says when nothing fits, before it says where the guide to writing one is. */
const NONE_FITS = `${GENEX_PLUGINS} None fits. You may offer to write one (a local Genex plugin the person loads and turns on in Plugins), or go on with your own tools (the project's files and the shell) once the person says so.`;

/** The note `plugins_find` answers with, by what it says to do next (with nothing found, while the Genex plugin is on). */
export const PLUGINS_FIND_NOTE = {
  [FindNext.Suggest]: `${GENEX_PLUGINS} To offer one that is off or not installed, call plugins_suggest with its id and why it helps, then end your reply: only the person turns a plugin on.`,
  [FindNext.Use]: `${GENEX_PLUGINS} The ones found are on already: use their tools; those for another kind of project arrive once the project is that kind.`,
  [FindNext.WritePlugin]: `${NONE_FITS} To write one, read ${GENEX_PLUGIN_ID}__${PLUGIN_SKILL_TOOL} ${JSON.stringify({ name: GENEX_PLUGIN_AUTHOR_SKILL })}, write the plugin in this project, check it with ${ProjectTool.PluginCheck}, and tell the person how to load it.`,
} as const satisfies Record<FindNext, string>;

/** `plugins_find`'s write-a-plugin note for a session with no `plugin_check` (a Loop's lead or worker, the local model): the chat checks it. */
export const PLUGINS_FIND_WRITE_UNCHECKED = `${NONE_FITS} To write one, read ${GENEX_PLUGIN_ID}__${PLUGIN_SKILL_TOOL} ${JSON.stringify({ name: GENEX_PLUGIN_AUTHOR_SKILL })} and write the plugin in this project. You can't check it yourself: tell the person it is ready, and that the chat checks it before they load it.`;

/** `plugins_find`'s note with nothing found while the Genex plugin, which carries the guide, is off. */
export const PLUGINS_FIND_GUIDE_OFF = `${NONE_FITS} The guide to writing one comes with the Genex plugin, which is off: to write one, first suggest turning it on with plugins_suggest ${JSON.stringify({ plugin: GENEX_PLUGIN_ID })}.`;

/** `plugin_check`: reads a folder in the project and installs nothing, so it runs in Plan mode too. */
export const PLUGIN_CHECK_TOOL: LiveToolSpec = {
  name: ProjectTool.PluginCheck,
  description:
    "Check a Genex plugin you wrote in this project before the person loads it: Genex reads its plugin.json, its files and its code as an install would, and installs nothing. It answers the plugin's id, tools, skills and sections and what the install-time scan reads in its code, or the first problem to fix. Only the person loads a plugin and turns it on.",
  parameters: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        description: "The plugin's folder, relative to the project, e.g. genex-plugins/sketch.",
      },
    },
    required: ["folder"],
  },
};

/** What `plugin_check` answers: the next step once a folder checks out, and each problem. */
export const PLUGIN_CHECK_ANSWER = {
  next: (folder: string) =>
    `It checks out. Tell the person, and end your reply there: "Plugins → Add → Load local plugin…, choose ${folder}. It starts off; turn it on there. It runs with your access; each of its tools asks before an agent runs it, and its own steps at Genex's moments don't ask."`,
  /** The next step for a folder of a local plugin the person has on: loading it again keeps it on. */
  nextWhileOn: (folder: string) =>
    `It checks out. Tell the person, and end your reply there: "Plugins → Add → Load local plugin…, choose ${folder}. It is on, so it stays on and its new code runs at once. It runs with your access; each of its tools asks again before an agent runs it, and its own steps at Genex's moments don't ask."`,
  badFolder:
    "Give folder as a path inside this project, relative to it (e.g. genex-plugins/sketch): no leading /, no .. and no backslash.",
  outside: (folder: string) => `${folder} is not a folder inside this project.`,
  notFolder: (folder: string) => `${folder} is not a folder.`,
  noManifest: (folder: string) => `${folder} has no plugin.json at its top.`,
  notJson: (folder: string) => `${folder}/plugin.json is not valid JSON.`,
} as const;

/** What `plugins_suggest` answers. */
export const PLUGINS_SUGGEST_ANSWER = {
  shown:
    "Shown to the person as a card. End your reply now, and don't ask them to tell you once it's on: turning it on continues this chat by itself. They may also tell you to go on without it.",
  refused: (plugin: string) =>
    `No card was shown: "${plugin}" is not a Genex plugin that is off or in Genex's catalog. Call plugins_find to see which are.`,
  noChat: "No card was shown: there is no chat to show it in.",
} as const;
