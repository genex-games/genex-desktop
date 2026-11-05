/**
 * What a game's folder holds, as the app lists it (`facts` on every `game.list` descriptor): a copy
 * of the app's `shared/project-facts.ts` vocabulary and reads, held equal to it by
 * `seed-contracts.test.ts`. A fact says what is there (`unreal-project` at the root, `web-game` in
 * `site/`); a folder with no facts and nothing of its own has no kind yet, and its first message
 * decides.
 */
import type { Host } from "../types/harness.d.ts";
import type { GameProject, ProjectFact } from "../types/host-api.d.ts";
import { isEngineGame } from "./engine-game.ts";
import { type EngineId, engineOfGame, GameEngine } from "./game-engine.ts";
import { HostMethod } from "./host-methods.ts";

/** Fact ids Genex itself knows; a plugin's `detect` may add others. Written in records: never rename a value. */
export const CoreFact = {
  WebGame: "web-game",
  UnrealProject: "unreal-project",
  UnrealPlugin: "unreal-plugin",
  GodotProject: "godot-project",
  UnityProject: "unity-project",
  RobloxProject: "roblox-project",
  BlenderAssets: "blender-assets",
} as const;
export type CoreFact = (typeof CoreFact)[keyof typeof CoreFact];

/**
 * The starters Genex writes itself into a folder with no kind yet (`game.start`, `game.scaffold`'s
 * `kind`): the app's `ProjectStarter`. Wire values: never rename one.
 */
export const ProjectStarter = { Web: "web" } as const;
export type ProjectStarter = (typeof ProjectStarter)[keyof typeof ProjectStarter];

/**
 * Genex's own project tools, by the name a session calls them: the app's `ProjectTool`. A local
 * model gets them as harness tools (`tools/game-tools.ts`). Called by name: never rename a value.
 */
export const ProjectTool = {
  StartWebGame: "start_web_game",
  PluginsFind: "plugins_find",
  PluginsSuggest: "plugins_suggest",
  /** Checks a plugin folder the agent wrote in the project, in place; installs nothing. The chat's own session's. */
  PluginCheck: "plugin_check",
  /** Plays the game folder's own newest app for this computer, for the person (an Unreal game's). The chat's own session's. */
  PlayBuild: "play_build",
} as const;
export type ProjectTool = (typeof ProjectTool)[keyof typeof ProjectTool];

/** The root of a game, as a fact's path spells it. */
export const FACT_ROOT = ".";

/** The start of a fact's source when an enabled plugin's `detect` found it (the app's `pluginFactSource`). */
export const PLUGIN_FACT_SOURCE_PREFIX = "plugin:";

/** A fact as these reads take it: what and where. */
export type FactRef = Pick<ProjectFact, "id" | "path">;

/**
 * What a folder with no facts holds besides Genex's bookkeeping (`holds` on a descriptor): the app's
 * `FolderHolds`. Only `nothing` and `notes` have no kind yet. Wire values: never rename one.
 */
export const FolderHolds = {
  Nothing: "nothing",
  Notes: "notes",
  OwnFiles: "own-files",
  Unreadable: "unreadable",
} as const;
export type FolderHolds = (typeof FolderHolds)[keyof typeof FolderHolds];

/**
 * A game descriptor as these reads take it (a brief's own view of the game, whose facts carry no
 * source, included); one from a host that predates facts carries none.
 */
export type FactsOfDescriptor =
  | (Partial<Pick<GameProject, "engine" | "web">> & {
      facts?: readonly FactRef[] | undefined;
      holds?: FolderHolds | null | undefined;
    })
  | null
  | undefined;

const ROOT = FACT_ROOT;

/**
 * The facts an engine stands for when a caller names the engine and not the facts (an older
 * caller): its project at the game's root. The engines of the older vocabulary by their facts (the
 * app's `factsOfEngine`); any other engine, whose declared fact only the app knows, by its own id,
 * so it is never read as a web game.
 */
export function factsOfEngine(engine: EngineId): FactRef[] {
  const id = ENGINE_FACT.get(engine) ?? (isEngineGame(engine) ? engine : CoreFact.WebGame);
  return [{ id, path: ROOT }];
}

/** The fact each engine of the older vocabulary stands for (the app's `ENGINE_FACT`). */
const ENGINE_FACT: ReadonlyMap<string, string> = new Map<GameEngine, string>([
  [GameEngine.Web, CoreFact.WebGame],
  [GameEngine.Unreal, CoreFact.UnrealProject],
  [GameEngine.Godot, CoreFact.GodotProject],
]);

/**
 * The facts of a game descriptor: the ones it carries. One from a host that predates facts reads by
 * its older fields: a link is its engine's project at the root (`factsOfEngine`), a folder that
 * said it holds no web game has none, and anything else (no descriptor at all included) is a web
 * game at the root.
 */
export function factsOfGame(game: FactsOfDescriptor): FactRef[] {
  if (Array.isArray(game?.facts)) return game.facts.map(({ id, path }) => ({ id, path }));
  const engine = engineOfGame(game);
  if (isEngineGame(engine)) return factsOfEngine(engine);
  if (game?.web === false) return [];
  return [{ id: CoreFact.WebGame, path: ROOT }];
}

/** Whether the facts hold `id` (at `path`, when one is named). */
export function hasFact(facts: readonly FactRef[], id: string, path?: string): boolean {
  return facts.some((fact) => fact.id === id && (path === undefined || fact.path === path));
}

/**
 * Whether the game is of a kind Genex can't name: the descriptor carries no facts, and its folder
 * holds files of its own no rule knows, or could not be read. It is never handed a starter.
 */
export function kindUnknown(game: FactsOfDescriptor): boolean {
  if (!Array.isArray(game?.facts) || game.facts.length > 0) return false;
  return game.holds === FolderHolds.OwnFiles || game.holds === FolderHolds.Unreadable;
}

/**
 * Whether the game has no kind yet: the descriptor itself carries no facts and its folder nothing of
 * its own (an older descriptor never is, and one with no `holds` is read by its facts alone).
 */
export function kindPending(game: FactsOfDescriptor): boolean {
  return Array.isArray(game?.facts) && game.facts.length === 0 && !kindUnknown(game);
}

/**
 * The facts a game is served by: its facts; a web game at its root while it has no kind yet
 * (`kindPending`); none for a folder of a kind Genex can't name (`kindUnknown`) or an older one that
 * said it holds no web game, neither of which is ever served as a web game.
 */
export function servedFactsOf(game: FactsOfDescriptor): FactRef[] {
  const facts = factsOfGame(game);
  if (facts.length > 0) return facts;
  return kindPending(game) ? [{ id: CoreFact.WebGame, path: ROOT }] : [];
}

/**
 * The served facts as one comparable key (each `id@path`, sorted): two descriptors with the same key
 * are the same kind of project, so a turn between them changed nothing a session's tools follow.
 */
export function servedFactsKey(game: FactsOfDescriptor): string {
  return servedFactsOf(game)
    .map((fact) => `${fact.id}@${fact.path}`)
    .sort()
    .join("\n");
}

/** How a game runs, as its studio.json declares it: the app's `TargetRuntime` a game may name (held to it by seed-contracts). */
export const GameRuntime = { Browser: "browser", Bridge: "bridge" } as const;
export type GameRuntime = (typeof GameRuntime)[keyof typeof GameRuntime];

/**
 * Whether the game is its own process Genex starts and plays through the Play Protocol: its
 * studio.json declares the bridge runtime and a play command (a Godot game Genex set up does).
 */
export function playsThroughBridge(game: Pick<GameProject, "shape"> | null | undefined): boolean {
  return game?.shape?.runtime === GameRuntime.Bridge && Boolean(game.shape.play);
}

/**
 * Whether briefs, tools and senses serve the game as a web game: it holds one at its root, or it has
 * no kind yet (served as a web game until its first message decides), as the app's `servedFacts`. A
 * folder of a kind Genex can't name never is.
 */
export function servedAsWeb(game: FactsOfDescriptor): boolean {
  return hasFact(servedFactsOf(game), CoreFact.WebGame, ROOT);
}

/** The kinds of project a game engine's editor works on: a game that holds one is built and played in that engine. */
const ENGINE_PROJECTS: ReadonlySet<string> = new Set<string>([
  CoreFact.UnrealProject,
  CoreFact.UnityProject,
  CoreFact.GodotProject,
  CoreFact.RobloxProject,
]);

/** Whether the facts hold a game engine's project (`ENGINE_PROJECTS`), anywhere in the game's folder. */
export function holdsEngineProject(facts: readonly FactRef[]): boolean {
  return facts.some((fact) => ENGINE_PROJECTS.has(fact.id));
}

/**
 * Whether the game is an engine's game: it is linked to an engine's project, or its folder holds
 * one, whatever web page sits beside it (a web starter a port left as the reference, one written
 * before the engine was picked).
 */
export function engineGame(game: FactsOfDescriptor): boolean {
  return isEngineGame(engineOfGame(game)) || holdsEngineProject(factsOfGame(game));
}

/**
 * Whether a Loop's finish checks the game's page (loop/health-check.ts): a game served as a web game
 * that is no engine's game. An engine's game is seen in its engine, never as a blank page.
 */
export function pageChecked(game: FactsOfDescriptor): boolean {
  return servedAsWeb(game) && !engineGame(game);
}

/**
 * Whether a session in the game's folder gets Genex's eyes on it (the capture and computer tools over
 * a pooled window): a web game, or a folder served as one, is a page to capture and drive, and a game
 * that plays through the Play Protocol a process to start and drive the same way. An Unreal game is
 * seen in its editor, and any other kind in its own app.
 */
export function seenInWindow(game: (FactsOfDescriptor & Pick<GameProject, "shape">) | null | undefined): boolean {
  return servedAsWeb(game) || playsThroughBridge(game);
}

/**
 * How a Loop worked on its project: in place (`open`), as every Loop does. Persisted in
 * `autopilot_started.profile`, where the app also reads the history value an earlier Genex wrote
 * (`shared/project-facts.ts`): never rename a value.
 */
export const LoopProfile = { Open: "open" } as const;
export type LoopProfile = (typeof LoopProfile)[keyof typeof LoopProfile];

/** What a Loop says when its game is of a kind Genex can't name. */
const MESSAGE = {
  unknownKind: (project: string) =>
    `A Loop can't start on ${project} yet: its folder holds files of a kind Genex doesn't know. Say in the chat what the project is, or turn on a Genex plugin for it, then start the Loop again.`,
} as const;

/**
 * A Loop on a game with no kind yet starts it as a web game: it takes the web starter first. A game of a
 * kind Genex can't name is never handed one: the Loop stops with a sentence saying it needs a kind.
 * `games` is the library as the caller listed it; a game not in it (one the caller is about to make)
 * is left to its maker.
 */
export async function startWebIfPending(
  host: Pick<Host, "call">,
  project: string,
  games: readonly GameProject[],
): Promise<void> {
  const game = games.find((listed) => listed.name === project);
  if (kindUnknown(game)) throw new Error(MESSAGE.unknownKind(project));
  if (!kindPending(game)) return;
  await host.call(HostMethod.GameStart, { project, starter: ProjectStarter.Web });
}

/** What says whether the studio plays a game in its engine's editor: the host's word (`editorPlay`), and the game's facts. */
export type EditorPlayedGame = { editorPlay?: unknown; facts?: readonly FactRef[] | null | undefined };

/** Whether these facts hold an Unreal project, the one game an older host plays in its editor. */
const holdsUnreal = (facts: readonly FactRef[] | null | undefined): boolean =>
  (facts ?? []).some((fact) => fact.id === CoreFact.UnrealProject);

/**
 * Whether the studio plays a game in its engine's editor, where a judge can play it: as the host's
 * `game.list` says (`editorPlay`, set by the plugin that declares the game's engine and its play).
 * A host that never says (an older one), and a kept older caller that hands the facts alone, read
 * it by the facts: an Unreal game.
 */
export function playedInEditor(game: EditorPlayedGame | readonly FactRef[] | null | undefined): boolean {
  if (Array.isArray(game)) return holdsUnreal(game);
  const described = game as EditorPlayedGame | null | undefined;
  if (typeof described?.editorPlay === "boolean") return described.editorPlay;
  return holdsUnreal(described?.facts);
}
