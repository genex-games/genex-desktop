/**
 * What a chat build of a game with an Unreal project is told (chat-session.ts `buildContractorBrief`).
 * The game lives in the user's open Unreal Editor and its project, and is built through the Unreal
 * tools: never as a web page (no page contract, no seeded randomness), and never through file or exec
 * bridges between the folder and the editor. It also holds the question a new project's brief asks first while an
 * engine plugin is on: the web or that engine (`engineChoiceRule`).
 */
import type { PluginKindOffer } from "../types/host-api.d.ts";
import { ProjectTool } from "./folder-facts.ts";
import { askUser } from "./interview-question.ts";
import { toolCall } from "./model-roles.ts";

/** The Unreal editor connector's tools, as the Unreal plugin's skill describes them: briefs name the connector, not its tools. */
const UNREAL_CONNECTOR = "the Unreal editor connector's tools, as the Unreal plugin's skill describes";

/**
 * The Unreal plugin's tool that makes a game's Unreal project inside its folder, as the host serves
 * it (`<plugin>__<tool>`). Kept for an older copy of a module that imports it: no current module
 * offers Unreal by this name, since every kind on offer comes from the host's `kinds`.
 */
export const UNREAL_NEW_GAME_TOOL = "unreal__new-game";

/**
 * Whether the host's plugin tools offer a new Unreal game. Kept for an older copy of a module that
 * imports it (a chat turn kept from before); no current module calls it.
 */
export function offersUnrealGame(tools: ReadonlyArray<{ name?: unknown }> | null | undefined): boolean {
  return Array.isArray(tools) && tools.some((tool) => tool?.name === UNREAL_NEW_GAME_TOOL);
}

/** How strongly a kind is the one its plugin's card offers: its readiness answered, then a tool that asks it, then any. */
function offerRank(kind: PluginKindOffer): number {
  if (kind.ready !== undefined) return 2;
  return kind.asksReady === true ? 1 : 0;
}

/** The card's name for a kind: its scaffold's label, else its plugin's name. */
const kindName = (kind: PluginKindOffer): string =>
  typeof kind.label === "string" && kind.label.trim() ? kind.label.trim() : kind.name;

/**
 * The kinds the question card offers: one per scaffold the host lists (each its own kind), and for a
 * plugin with no scaffolds one only: the one whose plugin answered its readiness or, when the answer
 * was late, whose tool asks it (its new-game tool), else the plugin's first.
 */
function offeredKinds(kinds: readonly PluginKindOffer[]): PluginKindOffer[] {
  const byKind = new Map<string, PluginKindOffer>();
  for (const kind of kinds) {
    const key = typeof kind.scaffold === "string" ? `${kind.plugin}/${kind.scaffold}` : kind.plugin;
    const known = byKind.get(key);
    if (!known || offerRank(kind) > offerRank(known)) byKind.set(key, kind);
  }
  return [...byKind.values()];
}

/**
 * How the card offers one kind: by its plugin's own words when it gave a readiness note, else by
 * its kind tool; a kind its plugin says isn't ready yet is never made: the person finishes its setup
 * from the plugin's button first (one rule for every plugin). A plugin's readiness words describe
 * its first kind, so a later kind of the same plugin (`laterKind`) is offered by its own tool.
 */
function kindLine(engine: string | undefined, kind: PluginKindOffer, laterKind = false): string {
  const tool = toolCall(engine, kind.tool);
  const name = kindName(kind);
  const made = `When the answer (or the request) is ${name}, call ${tool}: it makes the game's ${name} project in this folder; then build it with that plugin's tools.`;
  const note = !laterKind && typeof kind.note === "string" && kind.note.trim() ? kind.note.trim() : null;
  if (kind.ready === false)
    return [
      note,
      `If the user picks ${name}, don't call ${tool}: tell them to finish its setup from the ${kind.name} button above the game and send a message once it's done.`,
    ]
      .filter(Boolean)
      .join(" ");
  if (!note) return made;
  // The plugin's words name its tool as the host serves it; this session may spell it otherwise.
  return tool === kind.tool ? note : `${note} In this session, call ${kind.tool} as ${tool}.`;
}

/**
 * The first rule of a new game's brief while engine plugins offer kinds: which kind it builds is the
 * user's one question before the first build, unless the ask already names it (one it doesn't
 * offer goes through `plugins_find` instead); each kind is named
 * by its scaffold's label when its plugin declares scaffolds ("Unreal game"). The web answer starts
 * Genex's web starter (`start_web_game`); each kind on offer (`kinds`, from the host, each with its
 * plugin's readiness) through its own kind tool, as its line says. A kind that makes no game (`game:
 * false`, an Unreal plugin project) is never an option: it is made when the request asks for it. No
 * game on offer: no question. `_unreal` is read no more: kept so an older caller's call still fits.
 */
export function engineChoiceRule(
  engine: string | undefined,
  _unreal?: unknown,
  kinds?: readonly PluginKindOffer[] | null,
): string {
  const offered = offeredKinds(kinds ?? []);
  const games = offered.filter((kind) => kind.game !== false);
  const others = offered.filter((kind) => kind.game === false).map((kind) => askedForLine(engine, kind));
  if (games.length === 0) return others.join(" ");
  const ask = toolCall(engine, askUser.name);
  const names = games.map((kind) => `"${kindName(kind)}"`);
  const web = `When it is the web, call ${toolCall(engine, ProjectTool.StartWebGame)} first, then build it here on its starter as the rules below say.`;
  const later = (kind: PluginKindOffer, at: number) => games.findIndex((first) => first.plugin === kind.plugin) < at;
  // A request for an engine none of these options covers is looked for, never asked web or these.
  const find = `When the request names another engine or tool, don't ask this question: call ${toolCall(engine, ProjectTool.PluginsFind)} with what it names and follow its answer, and never turn a plugin on yourself.`;
  return [
    `FIRST, THE ENGINE: the user has engine plugins on, so this new game can be built for the web, here, or with ${names.join(" or ")}. ${find} Unless the request already names one of these, ask the user that one question with ${ask} before you build anything, with the options "Web: plays right here in Genex" and ${names.join(", ")} (each worded as its line below says), and end your reply.`,
    ...games.map((kind, at) => kindLine(engine, kind, later(kind, at))),
    web,
    ...others,
  ].join(" ");
}

/** A kind that makes no game, never a question's option: its tool, when the request asks for it. */
function askedForLine(engine: string | undefined, kind: PluginKindOffer): string {
  const name = kindName(kind);
  const article = /^[aeiou]/i.test(name) ? "an" : "a";
  return `When the request asks for ${article} ${name}, call ${toolCall(engine, kind.tool)}: it makes the ${name} project in this folder; then build it with that plugin's tools.`;
}

/** The project as a brief names it: its file, the folder it was found in, or what it is when neither is known. */
function projectWords(project: string | null | undefined, found?: string): string {
  if (project) return `\`${project}\``;
  if (found) return found === "." ? "in this game's folder" : `in \`${found}/\``;
  return "linked to this game";
}

/**
 * The rules that describe an Unreal game, in place of the web template's: where it is built,
 * where its changes land, how Blueprint text is written, and the bridges never to build. It names
 * no tool, so `_engine` (kept for its callers) changes nothing. A session that also writes files of its own in the
 * game folder (the Unreal Loop's lead: ART.md, build scripts, deliveries) is told `ownFiles`, and
 * never that the folder holds only notes. A project found in the folder but not linked (`found`, the
 * folder it was found in) is not built through the Unreal tools at all: until the plugin links it
 * (its skill names the tool, which sets the project up when it isn't), those tools work on the
 * project chosen in the Unreal panel, which can be another game's (`unlinkedUnrealRules`).
 */
export function unrealRules(
  _engine: string | undefined,
  project: string | null | undefined,
  { ownFiles = false, found }: { ownFiles?: boolean; found?: string } = {},
): string[] {
  const notes = ownFiles
    ? "Keep NOTES.md in this game folder current with what you built in Unreal and why."
    : "This Genex game folder holds only the game's notes: keep NOTES.md in it current with what you built in Unreal and why.";
  if (!project && found !== undefined) return unlinkedUnrealRules(found, notes);
  return [
    `This game is built in Unreal Engine, in the user's open Unreal Editor, through ${UNREAL_CONNECTOR}: find a toolset, read its tools and input schemas, then run them.`,
    `Your changes land in the Unreal project ${projectWords(project, found)}. ${notes}`,
    "Before you write Blueprint text, look up every node it uses through the Unreal tools — its exact name and pins — and never write a node from memory.",
    "Never build file watchers, polling scripts or exec bridges between this folder and Unreal: the Unreal tools are the way in.",
  ];
}

/**
 * The rules of an Unreal project in the folder that is not linked to the game: until the plugin
 * links it, the Unreal tools work on the project chosen in the Unreal panel (which can be another
 * game's), so none of them is called before; the work goes on with the project's files. The
 * harness names no plugin tool here: the plugin's skill says which one links it.
 */
function unlinkedUnrealRules(found: string, notes: string): string[] {
  return [
    `This folder holds an Unreal Engine project ${projectWords(null, found)} that is not linked to this game yet. Until it is, the Unreal tools (${UNREAL_CONNECTOR}) work on the project chosen in Genex's Unreal panel, which can be another game's: never call them before this folder's project is linked to this game (the Unreal plugin's skill names the tool that links it, and that tool sets the project up for Genex when it isn't). Until then, work with the project's files.`,
    notes,
    "Never build file watchers, polling scripts or exec bridges between this folder and Unreal: the Unreal tools are the way in once the project is linked.",
  ];
}

/** Where an Unreal game's work happens, in place of the web brief's "this workspace" rule. */
export function unrealWorkspaceRule(project: string | null | undefined, found?: string): string {
  return `The game's work happens in its Unreal project ${projectWords(project, found)} and in this workspace's notes: never in another copy of this game, in another game's folder or in another Unreal project, and a path the user named is a stills folder to look at, not a parent to walk. When the user asks about something elsewhere on their computer (another folder, their Downloads, their disk), that is the ask: what you may reach is your session's permissions, not this brief.`;
}

/** The brief's closing line for an Unreal game: where its work lands, and the folder of its notes. */
export function unrealWorkHere(project: string | null | undefined, folderLabel: string, found?: string): string {
  const notes = folderLabel ? `this workspace (folder \`${folderLabel}\`)` : "this workspace";
  // An unlinked project is worked on through its files, not the tools (`unlinkedUnrealRules`).
  const through = project || found === undefined ? " through the Unreal tools" : "";
  return `The game's work lands in its Unreal project ${projectWords(project, found)}${through}; its notes stay in ${notes}.`;
}
