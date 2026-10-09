/**
 * What a session is told about the project it works in, from the folder's facts (`folder-facts.ts`):
 * who runs it (Genex, the folder, what it holds, what a plugin means here), how a folder with no
 * kind yet picks one, and a line for a kind Genex has no rules of its own for. A web game's or a
 * kind-pending folder's words never name an engine: the person's first message decides.
 */
import type { PluginKindOffer } from "../types/host-api.d.ts";
import { CoreFact, type FactRef, FolderHolds, ProjectTool } from "./folder-facts.ts";
import { toolCall } from "./model-roles.ts";
// A kept older `unreal-prompts.ts` exports only what it did: new names live here, never there.
import { engineChoiceRule, UNREAL_NEW_GAME_TOOL } from "./unreal-prompts.ts";

/** The root of a game, as a fact's path spells it. */
const ROOT = ".";

/** Each kind Genex knows by name ("the … in `site/`"). */
const FACT_NAMES = {
  [CoreFact.WebGame]: "web game",
  [CoreFact.UnrealProject]: "Unreal Engine project",
  [CoreFact.UnrealPlugin]: "Unreal Engine plugin",
  [CoreFact.GodotProject]: "Godot project",
  [CoreFact.UnityProject]: "Unity project",
  [CoreFact.BlenderAssets]: "Blender files",
} as const satisfies Record<CoreFact, string>;

/** Each kind Genex knows, in words a brief can say ("it holds …"). */
export const FACT_WORDS = {
  [CoreFact.WebGame]: "a web game",
  [CoreFact.UnrealProject]: "an Unreal Engine project",
  [CoreFact.UnrealPlugin]: "an Unreal Engine plugin (a .uplugin), the engine's own kind of plugin, not a Genex plugin",
  [CoreFact.GodotProject]: "a Godot project",
  [CoreFact.UnityProject]: "a Unity project",
  [CoreFact.BlenderAssets]: "Blender files",
} as const satisfies Record<CoreFact, string>;

/** A kind in words: Genex's own, or a plugin's by its id. */
export function factWords(id: string): string {
  return (FACT_WORDS as Record<string, string>)[id] ?? `a project of the kind \`${id}\` (known by a Genex plugin)`;
}

/** A kind by name: Genex's own, or a plugin's by its id. */
function factName(id: string): string {
  return (FACT_NAMES as Record<string, string>)[id] ?? `\`${id}\` project`;
}

/**
 * What a rule of one kind starts with when the folder holds more than one: the kind and its folder
 * ("For the web game in `site/`: "). A kind at the root needs none.
 */
export function factPrefix(fact: FactRef): string {
  return fact.path === ROOT ? "" : `For the ${factName(fact.id)} in \`${fact.path}/\`: `;
}

/** Where in the folder a fact is: its root, or a folder inside it. */
function whereWords(path: string): string {
  return path === ROOT ? "at its root" : `in \`${path}/\``;
}

/** What a folder with no facts holds, in words, by `holds`. */
const NO_FACT_WORDS = {
  [FolderHolds.Nothing]: "nothing yet: its kind is not picked yet, and the person's request picks it",
  [FolderHolds.Notes]: "notes but no game yet: its kind is not picked yet, and the person's request picks it",
  [FolderHolds.OwnFiles]: "files of its own of a kind Genex has no rules for",
  [FolderHolds.Unreadable]: "nothing Genex could read: its folder could not be read",
} as const satisfies Record<FolderHolds, string>;

/** What the folder holds, in words: each kind and where, or what a folder with no facts holds. */
function holdsWords(facts: readonly FactRef[], holds?: FolderHolds | null): string {
  if (facts.length === 0) return NO_FACT_WORDS[holds ?? FolderHolds.Nothing];
  return facts.map((fact) => `${factWords(fact.id)} ${whereWords(fact.path)}`).join(", ");
}

/**
 * Who runs the session, the first thing every brief says: Genex, the Mac app the chat runs in; the
 * project's folder and what it holds (`holds`: what a folder with no facts holds); that Genex shows a
 * web game itself; and that a plugin here is a Genex plugin, never an engine's own plugins or add-ons.
 */
export function appIdentity({
  folderLabel,
  facts,
  holds = null,
}: {
  folderLabel: string;
  facts: readonly FactRef[];
  holds?: FolderHolds | null;
}): string {
  const folder = folderLabel ? `the folder \`${folderLabel}\`` : "this game's folder";
  return `You are working inside Genex, the Mac app this chat runs in. This project is ${folder}; it holds ${holdsWords(facts, holds)}. Genex shows a web game in its own Live view beside this chat: never start a server for the person to open. In Genex, a plugin means a Genex plugin (Plugins in the sidebar), which adds tools and know-how; an engine's own plugins and add-ons are files in the project, not Genex plugins.`;
}

/** How a session finds a plugin for what the request names, and never turns one on itself. */
function findRule(engine: string | undefined, beyond: string): string {
  return `If the request names an engine or tool ${beyond}, call ${toolCall(engine, ProjectTool.PluginsFind)} with what it names and follow its answer; never turn a plugin on yourself.`;
}

/** How a new project's first rule opens, by what its folder holds: nothing, or notes to read first. */
function newProjectWords(holds: FolderHolds | null | undefined): string {
  if (holds === FolderHolds.Notes)
    return "This project is new: its folder holds notes but no game yet, so read them first. Your first step decides what it becomes.";
  return "This project is new and empty: your first step decides what it becomes.";
}

/**
 * The first rule for a folder with no kind yet (`holds`: nothing, or notes to read first), on every
 * message until it has one. With engine plugins' kinds on offer (`kinds`) and the question card
 * bridged (`asked`): the engine question, whose web answer starts the web starter. Otherwise web is
 * the default through `start_web_game`, each kind on offer is made by its own tool when the request
 * names it, and an engine Genex has no plugin on for goes through `plugins_find`.
 */
export function pendingKindRule(
  engine: string | undefined,
  kinds?: readonly PluginKindOffer[] | null,
  unreal?: unknown,
  holds?: FolderHolds | null,
  asked = true,
): string[] {
  const offered = kinds ?? [];
  if (asked && offered.length > 0)
    return [engineChoiceRule(engine, unreal, offered), findRule(engine, "none of those options covers")];
  const start = toolCall(engine, ProjectTool.StartWebGame);
  return [
    `${newProjectWords(holds)} For a game that plays in Genex (the default when the request names no engine), call ${start} first, then build on its starter.`,
    ...offered.map(
      (kind) =>
        `When the request names ${kind.name}, call ${toolCall(engine, kind.tool)}: it makes the game's ${kind.name} project in this folder; then build it with that plugin's tools.`,
    ),
    findRule(engine, offered.length > 0 ? "none of those plugins covers" : "Genex has no plugin on for"),
  ];
}

/**
 * For a kind Genex has no rules or plugin on of its own for: look for a Genex plugin first and
 * suggest it, offer to write one when there is none, and go on with the project's own files and the
 * shell only on the person's word, as `plugins_find`'s own answer says. `what` is what `plugins_find`
 * is called with.
 */
export function pluginFirstRule(engine: string | undefined, what: string): string {
  const find = toolCall(engine, ProjectTool.PluginsFind);
  const suggest = toolCall(engine, ProjectTool.PluginsSuggest);
  return `Before you build, call ${find} with ${what} and follow its answer: when a plugin it names is on, use its tools; when it names one to suggest, call ${suggest} and end your reply there. When ${find} finds none, offer to write a Genex plugin for it, or to go on without one. Work with the project's own files and tools from the shell only once the person has said to go on without a plugin (in this chat, now or earlier). Never turn a plugin on yourself.`;
}

/**
 * The rule of a kind Genex has no rules of its own for (a Godot or Unity project, Blender files, an
 * Unreal Engine plugin, a plugin's kind): what it is, and that it is built with its own files and
 * tools, not as a web page.
 */
export function factLine(fact: FactRef): string {
  return `This folder holds ${factWords(fact.id)} ${whereWords(fact.path)}: build it with its own files and tools from the shell, never as a web page, and say plainly what you could not run or look at.`;
}

/** Whether a fact is one of Genex's own kinds (the core table), not one an enabled plugin detected. */
const isCoreFact = (id: string) => (Object.values(CoreFact) as string[]).includes(id);

/**
 * The rules of a kind Genex has no rules of its own for: for one of Genex's own kinds, a plugin is
 * looked for first (`pluginFirstRule`); one an enabled plugin detected has that plugin on already.
 */
export function ownKindRules(engine: string | undefined, fact: FactRef): string[] {
  if (!isCoreFact(fact.id)) return [factLine(fact)];
  return [pluginFirstRule(engine, `the fact "${fact.id}"`), factLine(fact)];
}

/**
 * The rules of a folder with no facts that is no new project (`kindUnknown`): one of its own files of
 * a kind Genex has no rules for is looked through first and never handed a web starter, and a plugin
 * is looked for; one Genex could not read is checked and said.
 */
export function unknownKindRules(engine: string | undefined, holds: FolderHolds | null | undefined): string[] {
  if (holds === FolderHolds.Unreadable)
    return [
      "Genex could not read this project's folder: before anything else, check that it is there and that you can read it, and tell the person plainly if you can't.",
    ];
  return [
    "This folder holds files of its own of a kind Genex has no rules for: look through them first to learn what the project is and how it runs, and never write a web starter or a web page into it unless the person asks for one.",
    pluginFirstRule(engine, "what the project is"),
  ];
}

/**
 * The Unreal plugin's kind offer as a host that listed no `kinds` once stood for it. Kept for an older
 * copy of a module that imports it: no current module reads it, since every kind on offer, with its
 * readiness, comes from the host's `kinds`.
 */
export const UNREAL_KIND: PluginKindOffer = {
  plugin: "unreal",
  name: "Unreal Engine",
  tool: UNREAL_NEW_GAME_TOOL,
  makes: [CoreFact.UnrealProject],
};

/**
 * The rules of an Unreal project while the Unreal plugin is off: the plugin is suggested first
 * (`pluginFirstRule`); this session has no Unreal tools, works with the project's files and the shell
 * on the person's word, and Genex cannot save inside the editor before a checkpoint. The person may
 * turn the plugin on; the session never does.
 */
export function unrealWithoutPlugin(engine: string | undefined): string[] {
  return [
    pluginFirstRule(engine, '"Unreal"'),
    "This is an Unreal Engine project, and Genex's Unreal plugin is off, so this session has no Unreal tools: on the person's word, work with the project's files and the shell (UnrealBuildTool, UnrealEditor-Cmd), never as a web page.",
    "Genex can't save inside the editor before a checkpoint while the plugin is off: when the editor is open, save there yourself or ask the person to save first, so a checkpoint holds the work.",
  ];
}

/**
 * What the chat's own session is told when its turn changed what the project is (a port, or files
 * it wrote): the project's kind now, and to go on with what it said it would build first, with the
 * tools this new turn hands it.
 */
export function factsReadyPrompt(facts: readonly FactRef[]): string {
  return `The project now holds ${holdsWords(facts)}; your tools fit it now. Go on with what you said you would build first, look at the result, then tell the user what you made and what to try.`;
}
