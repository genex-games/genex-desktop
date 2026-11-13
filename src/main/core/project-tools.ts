/**
 * Genex's own project tools (`ProjectTool`), handed by seat (`ProjectToolSeat`): `start_web_game`
 * writes the web starter into a game with no kind yet; `plugins_find` looks for a Genex plugin and
 * `plugins_suggest` shows the person a card to turn one on; `plugin_check` checks a plugin the agent
 * wrote in the game, installing nothing (`plugin-check.ts`); `show_design` says how to write a page of
 * the game's design board and opens the Design tab on one (`design-board.ts`). They sit beside the cover tool in delegation
 * (`delegation.ts`); the harness's `game.start`, `plugins.find` and `plugins.suggest` do the same
 * for a local model.
 */
import type { LiveToolResult, LiveToolSpec } from "../../shared/engine-requests.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { noteWords } from "../../shared/design-board.ts";
import type { GameProject } from "../../shared/game-project.ts";
import { PluginCallBlocker, PluginSourceKind } from "../../shared/plugins.ts";
import { CoreFact, type GameKind, kindPending, ProjectStarter } from "../../shared/project-facts.ts";
import {
  type PluginsFindAnswer,
  type PluginsSuggestAnswer,
  ProjectTool,
  type StartHeldInPlan,
} from "../../shared/project-tools.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { StudioCore } from "../studio-core.ts";
import type { CoreInternals } from "./internals.ts";
import { SHOW_DESIGN_ANSWER, SHOW_DESIGN_TOOL } from "./design-board-prompts.ts";
import { findPlugins, type PluginQuery, suggestable } from "./plugin-finder.ts";
import { checkPluginFolder } from "./plugin-check.ts";
import {
  PLAY_BUILD_ANSWER,
  PLAY_BUILD_TOOL,
  PLUGIN_CHECK_TOOL,
  PLUGINS_FIND_TOOL,
  PLUGINS_SUGGEST_ANSWER,
  PLUGINS_SUGGEST_TOOL,
  PROJECT_TOOL_ANSWER,
  START_WEB_GAME_TOOL,
} from "./project-tools-prompts.ts";

/** The longest search and reason a session may send, in characters; the rest is cut. */
const MAX_QUERY_CHARS = 200;
const MAX_REASON_CHARS = 400;

/** Why a project tool call is refused outright. */
const MESSAGE = {
  unknownTool: (name: string) => `Unknown tool: ${name}`,
} as const;

/** Where a project tool call comes from: its game and the chat its cards show in (the host's finding, never a thread the harness names). */
export interface ProjectToolCall {
  project: string;
  threadId?: string | undefined;
  /** The calling session was handed `plugin_check`, so `plugins_find` may tell it to check a plugin. */
  canCheck?: boolean;
}

/** Where a session sits, which says which of Genex's project tools it is handed (`projectTools`). */
export const ProjectToolSeat = {
  /** The chat's own session: every project tool, the plugin check included. */
  Chat: "chat",
  /** A run's lead: the plugin search and the plugin card, shown in the chat it answers. */
  Lead: "lead",
  /** A worker the host seated: the plugin search only; the card is the lead's to show. */
  Worker: "worker",
  /** A Loop's reviewer (`HarnessDelegateParams.reviewer`): no project tool; it only reads and looks (`app_look`). */
  Reviewer: "reviewer",
  /** Every other session (a builder of a classic run, a judge, a scout): none. */
  None: "none",
} as const;
export type ProjectToolSeat = (typeof ProjectToolSeat)[keyof typeof ProjectToolSeat];

/**
 * The project tools a session is handed, by its seat: the chat's own gets the web starter while its
 * game has no kind yet (never for a folder of its own files of a kind Genex can't name), the plugin
 * search, card and check and the design board; a lead the search and the card (it works in its
 * build's own folder, which the board does not read); a worker the search; anyone else (a reviewer
 * included) nothing.
 */
export function projectTools(game: GameKind, seat: ProjectToolSeat): LiveToolSpec[] {
  if (seat === ProjectToolSeat.Worker) return [PLUGINS_FIND_TOOL];
  if (seat === ProjectToolSeat.Lead) return [PLUGINS_FIND_TOOL, PLUGINS_SUGGEST_TOOL];
  if (seat !== ProjectToolSeat.Chat) return [];
  const start = kindPending(game) ? [START_WEB_GAME_TOOL] : [];
  const play = playsItsApp(game) ? [PLAY_BUILD_TOOL] : [];
  return [...start, PLUGINS_FIND_TOOL, PLUGINS_SUGGEST_TOOL, PLUGIN_CHECK_TOOL, ...play, SHOW_DESIGN_TOOL];
}

/** Whether a game plays as the app its folder holds rather than as a page: an Unreal game. */
export const playsItsApp = (game: GameKind): boolean => game.facts.some((fact) => fact.id === CoreFact.UnrealProject);

/** One of Genex's project tools as a chat's session calls it, by name. */
export async function callProjectTool(
  core: StudioCore,
  x: CoreInternals,
  name: string,
  args: Record<string, unknown>,
  call: ProjectToolCall,
): Promise<LiveToolResult> {
  if (name === ProjectTool.PluginsFind) return JSON.stringify(await pluginsFind(core, args, call.canCheck === true));
  if (name === ProjectTool.PluginsSuggest) {
    const { canCheck: _canCheck, ...card } = call;
    return (await pluginsSuggest(core, { ...args, ...card })).message;
  }
  if (name === ProjectTool.PluginCheck)
    return JSON.stringify(await checkPluginFolder(core.games.dirFor(call.project), args, localPluginOn(core)));
  if (name === ProjectTool.StartWebGame) return startWebGame(core, x, call.project, call.threadId);
  if (name === ProjectTool.ShowDesign) return showDesign(core, args, call);
  if (name === ProjectTool.PlayBuild) {
    const { state, app } = await core.playGameBuild(call.project);
    return PLAY_BUILD_ANSWER[state](app ?? "");
  }
  throw new Error(MESSAGE.unknownTool(name));
}

/** A search's text field: a string, cut to its cap; anything else is no field at all. */
const queryText = (value: unknown, cap: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, cap) : undefined;

/** Whether a plugin id names a plugin loaded from a folder that is installed and on: loading it again keeps it on. */
const localPluginOn =
  (core: StudioCore) =>
  (id: string): boolean =>
    core.plugins
      .list()
      .some((p) => p.manifest.id === id && p.source === PluginSourceKind.Local && p.enabled && !p.removed);

/**
 * `plugins_find`: read-only, from the installed plugins and Genex's catalog only, so Plan mode lets
 * it run. Only a session handed `plugin_check` (`canCheck`) is told to check a plugin it writes.
 */
export async function pluginsFind(
  core: StudioCore,
  args: Record<string, unknown>,
  canCheck = false,
): Promise<PluginsFindAnswer> {
  const fact = queryText(args.fact, MAX_QUERY_CHARS);
  const text = queryText(args.text, MAX_QUERY_CHARS);
  const query: PluginQuery = { ...(fact ? { fact } : {}), ...(text ? { text } : {}) };
  return findPlugins(core.plugins.shown(), await core.plugins.catalog(), query, canCheck);
}

/** Whether `threadId` is a chat of `project`, the only place its card may show. */
async function chatOf(core: StudioCore, project: string, threadId: string): Promise<boolean> {
  const thread = (await core.store.listThreads()).find((record) => record.id === threadId);
  return thread?.metadata?.project === project;
}

/**
 * `plugins_suggest`: the turn-it-on card in the chat, for a plugin that is installed but off or in
 * Genex's catalog; anything else is refused and shows nothing. It writes no file and turns nothing
 * on, so Plan mode lets it run; the person's click on the card is the only way a plugin goes on.
 */
export async function pluginsSuggest(
  core: StudioCore,
  args: Record<string, unknown> & ProjectToolCall,
): Promise<PluginsSuggestAnswer> {
  const plugin = suggestable(core.plugins.shown(), await core.plugins.catalog(), args.plugin);
  const named = String(args.plugin ?? "").slice(0, MAX_QUERY_CHARS);
  if (!plugin) return { shown: false, message: PLUGINS_SUGGEST_ANSWER.refused(named) };
  const { threadId } = args;
  const inChat = typeof threadId === "string" && threadId && (await chatOf(core, args.project, threadId));
  if (!inChat) return { shown: false, message: PLUGINS_SUGGEST_ANSWER.noChat };
  const payload = {
    pluginId: plugin.id,
    name: plugin.name,
    description: plugin.description,
    offer: plugin.offer,
    reason: queryText(args.reason, MAX_REASON_CHARS) ?? "",
    project: args.project,
  };
  await core.append([customEventData(CustomEvent.PluginSuggested, payload)], threadId);
  return { shown: true, message: PLUGINS_SUGGEST_ANSWER.shown };
}

/**
 * `show_design`: the design board's answer, and, for a page it showed from the game's own chat,
 * that page's card in the chat (`design_shown`): its file, its title and the agent's note. It
 * writes none of the game's files (`choose` keeps its offer in the board's own marks file, as the
 * person's moves are kept), so Plan mode lets it run.
 */
async function showDesign(core: StudioCore, args: Record<string, unknown>, call: ProjectToolCall): Promise<string> {
  const { threadId, project } = call;
  const said = await announceDesign(core, project, args);
  const namesNoPage = args.page === undefined || args.page === null || args.page === "";
  if (said.length > 0 && namesNoPage) return said.join("\n");
  const { answer, item } = await core.design.show(project, args.page, { note: args.note, spot: args.spot });
  const answers = [...said, answer].join("\n");
  if (!item || typeof threadId !== "string" || !threadId) return answers;
  if (!(await chatOf(core, project, threadId))) return answers;
  const card = { project, file: item.file, title: item.title || item.name, note: noteWords(args.note) };
  await core.append([customEventData(CustomEvent.DesignShown, card)], threadId);
  return answers;
}

/**
 * What a `show_design` call announces beside showing an artboard: the artboards offered to pick
 * among (`choose`) and the ones about to be made (`making`). The answer to each that was given.
 */
async function announceDesign(core: StudioCore, project: string, args: Record<string, unknown>): Promise<string[]> {
  const said: string[] = [];
  if (args.choose !== undefined) {
    const offered = await core.design.offer(project, args.choose);
    if (offered) said.push(SHOW_DESIGN_ANSWER.offered(offered));
  }
  const making = core.design.making(project, args.making);
  if (making.length > 0) said.push(SHOW_DESIGN_ANSWER.making(making));
  return said;
}

/** Write a starter into a game with no kind yet and tell the app its game changed. */
export async function startProject(core: StudioCore, project: string, starter: ProjectStarter): Promise<GameProject> {
  const game = await core.games.start(project, starter);
  core.emit(UiEvent.GameChanged, { project });
  return game;
}

/**
 * The Plan answer a start of `project`'s web starter gets while `threadId` is this game's chat and
 * that chat is in Plan mode; null otherwise. A thread of no chat, or another game's chat, lends no
 * Plan answer: the start then does what it does with no thread.
 */
export async function startHeldInPlan(
  core: StudioCore,
  x: CoreInternals,
  project: string,
  threadId: unknown,
): Promise<StartHeldInPlan | null> {
  if (typeof threadId !== "string" || !threadId) return null;
  if (!(await chatOf(core, project, threadId)) || !(await x.planning(threadId))) return null;
  return { blocker: PluginCallBlocker.PlanMode, message: PROJECT_TOOL_ANSWER.inPlan };
}

/**
 * `start_web_game` as the chat's own session calls it: a chat in Plan mode writes nothing (the
 * answer says the plan holds it), otherwise the web starter is written. A game that has a kind
 * already is refused by `games.start`.
 */
export async function startWebGame(
  core: StudioCore,
  x: CoreInternals,
  project: string,
  threadId: string | undefined,
): Promise<LiveToolResult> {
  const held = await startHeldInPlan(core, x, project, threadId);
  if (held) return JSON.stringify(held);
  await startProject(core, project, ProjectStarter.Web);
  return PROJECT_TOOL_ANSWER.webStarted;
}
