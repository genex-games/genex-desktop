/**
 * What a session is told about the project it works in, from the folder's facts (`folder-facts.ts`):
 * who runs it (Genex, the folder, what it holds, what a plugin means here), and, for the local
 * engine's own prompt, how a folder with no kind yet picks one. Genex's line when a turn changed
 * what the project is says that fact alone (`factsReadyNotice`). A web game's or a kind-pending
 * folder's words never name an engine: the person's first message decides.
 */
import type { PluginKindOffer } from "../types/host-api.d.ts";
import { CoreFact, type FactRef, FolderHolds, ProjectTool } from "./folder-facts.ts";
import { toolCall } from "./model-roles.ts";
import { pluginWebBuilds, WEB_BUILD_WORDS } from "./web-build.ts";

/** The root of a game, as a fact's path spells it. */
const ROOT = ".";

/** Each kind Genex knows by name ("the … in `site/`"). */
const FACT_NAMES = {
  [CoreFact.WebGame]: "web game",
  [CoreFact.UnrealProject]: "Unreal Engine project",
  [CoreFact.UnrealPlugin]: "Unreal Engine plugin",
  [CoreFact.GodotProject]: "Godot project",
  [CoreFact.UnityProject]: "Unity project",
  [CoreFact.RobloxProject]: "Roblox place",
  [CoreFact.BlenderAssets]: "Blender files",
} as const satisfies Record<CoreFact, string>;

/** Each kind Genex knows, in words a brief can say ("it holds …"). */
export const FACT_WORDS = {
  [CoreFact.WebGame]: "a web game",
  [CoreFact.UnrealProject]: "an Unreal Engine project",
  [CoreFact.UnrealPlugin]: "an Unreal Engine plugin (a .uplugin), the engine's own kind of plugin, not a Genex plugin",
  [CoreFact.GodotProject]: "a Godot project",
  [CoreFact.UnityProject]: "a Unity project",
  [CoreFact.RobloxProject]: "a Roblox place",
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
  // A plugin's web build is one thing in its folder: the web page, named as the build it is.
  const builds = pluginWebBuilds(facts);
  return facts
    .filter((fact) => !builds.has(fact.path) || fact.id === CoreFact.WebGame)
    .map((fact) =>
      builds.has(fact.path)
        ? `${WEB_BUILD_WORDS} ${whereWords(fact.path)}`
        : `${factWords(fact.id)} ${whereWords(fact.path)}`,
    )
    .join(", ");
}

/**
 * Who runs the session, the first thing every brief says: Genex, the desktop app the chat runs in; the
 * project's folder and what it holds (`holds`: what a folder with no facts holds; `facts` left out, as
 * in a chat session's system text, which outlives a change of kind: not said); that Genex shows a web
 * game itself; and that a plugin here is a Genex plugin, never an engine's own plugins or add-ons.
 */
export function appIdentity({
  folderLabel,
  facts,
  holds = null,
}: {
  folderLabel: string;
  facts?: readonly FactRef[];
  holds?: FolderHolds | null;
}): string {
  const folder = folderLabel ? `the folder \`${folderLabel}\`` : "this game's folder";
  const held = facts ? `; it holds ${holdsWords(facts, holds)}` : "";
  return `You are working inside Genex, the desktop app this chat runs in. This project is ${folder}${held}. Genex shows a web game in its own Live view beside this chat: never start a server for the person to open. In Genex, a plugin means a Genex plugin (Plugins in the sidebar), which adds tools and know-how; an engine's own plugins and add-ons are files in the project, not Genex plugins.`;
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

/** A kind on offer by name: its scaffold's label (two scaffolds of one plugin are two kinds), else its plugin's name. */
const offerName = (kind: PluginKindOffer): string =>
  typeof kind.label === "string" && kind.label.trim() ? kind.label.trim() : kind.name;

/**
 * The local engine's first rule for a folder with no kind yet (`holds`: nothing, or notes to read
 * first), on every message until it has one: web is the default through `start_web_game`, each kind
 * on offer is made by its own tool when the request names it, and an engine Genex has no plugin on
 * for goes through `plugins_find`.
 */
export function pendingKindRule(
  engine: string | undefined,
  kinds?: readonly PluginKindOffer[] | null,
  holds?: FolderHolds | null,
): string[] {
  const offered = kinds ?? [];
  const start = toolCall(engine, ProjectTool.StartWebGame);
  return [
    `${newProjectWords(holds)} For a game that plays in Genex as a web page, ${start} writes a starter page; it is one option, not a requirement.`,
    ...offered.map((kind) => {
      const name = offerName(kind);
      return `When the request names ${name}, call ${toolCall(engine, kind.tool)}: it makes the game's ${name} project in this folder; then build it with that plugin's tools.`;
    }),
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
 * Genex's line to the chat's own session when its turn changed what the project is (a port, a link,
 * or project files it wrote), as that session goes on with the tools for the new kind: the kind now
 * and, when its app isn't ready, why. Facts only: what to do with them is the session's.
 */
export function factsReadyNotice(facts: readonly FactRef[], notReady?: string): string {
  const holds = `This project now holds ${holdsWords(facts)}; your tools changed to fit it.`;
  return notReady ? `${holds} Its app isn't ready yet: ${notReady}` : holds;
}

/** The chat's own tools a kind-first line names, as the session is handed them: the build's start and the question card. */
export interface KindFirstTools {
  launch: string;
  ask: string;
}

/**
 * Genex's line to the chat's own session when it started a build on a project with no kind yet
 * while a plugin on offers one (`kinds`): the build waits for the kind, which the person's request
 * picks (each kind by the tool that makes it, a web page by `start_web_game`, the question card when
 * the request doesn't say), and is then started again.
 */
export function kindFirstNotice(
  engine: string | undefined,
  kinds: readonly PluginKindOffer[],
  tools: KindFirstTools,
): string {
  const offered = kinds.map((kind) => `${offerName(kind)}: ${toolCall(engine, kind.tool)}`);
  const web = `a game that plays in Genex as a web page: ${toolCall(engine, ProjectTool.StartWebGame)}`;
  return [
    "The build did not start: this project has no kind yet, and a build runs on the kind it is made in.",
    `Make it first, as the person's request says: ${[...offered, web].join("; ")}.`,
    `When their words don't say which, ask them with ${toolCall(engine, tools.ask)} and end your reply.`,
    `Once it has its kind, call ${toolCall(engine, tools.launch)} again.`,
  ].join(" ");
}
