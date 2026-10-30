/**
 * The `computer` tool on a game played in its engine's editor: the target is the
 * game's engine plugin's play tools (`editor-play-target.ts`, `shared/engine-play.ts`). It is
 * offered only where one enabled plugin holds the game's engine link or explicitly scopes every
 * play tool to its facts: to the chat's own session ({@link editorPlayTools}), and to any session the studio
 * hands a computer for that game ({@link editorPlayComputer}). Nothing starts until the agent first
 * uses it, and the session's end lets go of the play it started. A play that can reach the live
 * game's saved data says so in the first answer after it opens.
 */
import path from "node:path";
import { ScreenRole } from "../../shared/agent-screen.ts";
import type { TargetCapabilities } from "../../shared/computer-target.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { ENGINE_PLAY_TOOLS, EnginePlayTool, editorCapabilities } from "../../shared/engine-play.ts";
import type { LiveToolResult } from "../../shared/engine-requests.ts";
import { type EngineBinding, isEngineGame } from "../../shared/game-engine.ts";
import type { GameProject } from "../../shared/game-project.ts";
import { type PluginBinding, PluginCapability, type PluginManifest, PluginToolAudience } from "../../shared/plugins.ts";
import { type GameKind, scopeReaches } from "../../shared/project-facts.ts";
import { readEngineBinding } from "../../substrate/game-engine-binding.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { type ComputerGrant, type ComputerTools, computerTools } from "./computer-tools.ts";
import { EDITOR_PLAY_PROMPTS } from "./editor-play-session-prompts.ts";
import { safePathSegment } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";

/** Where the chat's editor sessions keep their frames and traces, one folder per chat, under scratch. */
const FRAMES_FOLDER = "editor-play";

/** Allow the editor lock and backend cleanup to finish after the session is cancelled, within a bound. */
const CLEANUP_TIMEOUT_MS = 10 * SECOND_MS;

/** Who the plugin's calls are recorded as when the session names no engine of its own. */
const STUDIO_ENGINE = "studio";

const MESSAGE = {
  noWindow: "a game played in its editor has no browser window",
} as const;

/** The game a session's editor computer is for, and the session's own thread, engine and end where it has them. */
export interface EditorPlayGame {
  project: string;
  /** The game's folder. */
  directory: string;
  threadId?: string;
  engineId?: string;
  signal?: AbortSignal;
}

/** The chat's own session the editor computer is for. */
export interface EditorPlayPlace extends EditorPlayGame {
  threadId: string;
  engineId: string;
  signal: AbortSignal;
}

/** The engine plugin that plays a game in its editor, and what its declaration says that play can do. */
export interface EditorPlayPlugin {
  id: string;
  caps: TargetCapabilities;
}

/**
 * Whether a plugin provides every harness play tool, explicitly scoped to the game when given.
 * An engine plugin holding the game's link plays it by that link and needs no fact scope.
 */
function hasPlayTools(manifest: PluginManifest, game?: GameKind): boolean {
  return ENGINE_PLAY_TOOLS.every((name) => {
    const tool = manifest.tools.find((entry) => entry.name === name && entry.audience === PluginToolAudience.Harness);
    if (!tool) return false;
    if (!game) return true;
    return Boolean(tool.facts?.length) && scopeReaches(tool.facts, game);
  });
}

/** Whether an engine plugin holds the game's current engine link: the one its studio.json mirrors, of the same engine. */
async function holdsLink(
  core: StudioCore,
  manifest: PluginManifest,
  bound: EngineBinding,
  game: Pick<PluginBinding, "project" | "directory">,
): Promise<boolean> {
  if (!manifest.capabilities.includes(PluginCapability.GameEngine)) return false;
  const link = await core.engineLinks.read(manifest.id, game).catch(() => null);
  return link?.project === bound.project && link.kind === bound.kind;
}

/**
 * The one enabled plugin that plays this game in its editor, with the capabilities its
 * `engine.play` declares: the engine plugin holding the game's current engine link,
 * or, for a game with no link, the plugin that scopes all six harness play tools to the game's
 * facts. Ambiguity, an unavailable link owner and a game with no known facts leave editor play
 * unavailable (null), as for a web game.
 */
export async function editorPlayPlugin(core: StudioCore, project: string): Promise<EditorPlayPlugin | null> {
  const directory = core.games.dirFor(project);
  const bound = await readEngineBinding(directory, core.plugins.engines()).catch(() => undefined);
  const game = bound ? null : await core.games.kindOf(project).catch(() => null);
  if (!bound && !game?.facts.length) return null;
  const candidates: PluginManifest[] = [];
  const plugins = core.plugins
    .list()
    .filter(({ manifest }) => core.plugins.enabled(manifest.id) && hasPlayTools(manifest, game ?? undefined));
  for (const { manifest } of plugins) {
    if (bound && !(await holdsLink(core, manifest, bound, { project, directory }))) continue;
    candidates.push(manifest);
  }
  const [only] = candidates;
  if (candidates.length !== 1 || !only) return null;
  return { id: only.id, caps: editorCapabilities(only.engine?.play) };
}

/**
 * The games as the harness's `game.list` describes them: each engine game an engine plugin plays in
 * its editor marked `editorPlay`. A web game, or one no plugin that is on plays, is not.
 */
export async function withEditorPlay(core: StudioCore, games: readonly GameProject[]): Promise<GameProject[]> {
  return Promise.all(
    games.map(async (game) => {
      if (!isEngineGame(game.engine?.kind)) return game;
      const plays = await editorPlayPlugin(core, game.name).catch(() => null);
      return plays ? { ...game, editorPlay: true } : game;
    }),
  );
}

/** A session port with no window: it only names the session's screen. */
function windowless(handle: string): SessionPort {
  return {
    loaded: null,
    handle: () => handle,
    get: async () => {
      throw new Error(MESSAGE.noWindow);
    },
    release: async () => {},
  };
}

/** The answer with a note after its text. */
function withNote(answer: LiveToolResult, note: string): LiveToolResult {
  const own = typeof answer === "string" ? { text: answer } : answer;
  return { ...own, text: [own.text, note].filter(Boolean).join("\n") };
}

/** Whether the open's answer says the play reaches the live game's saved data. */
const reachesLiveData = (opened: unknown): boolean =>
  typeof opened === "object" && opened !== null && Reflect.get(opened, "liveData") === true;

/**
 * The editor computer for a session's `grant` (its role and build), its frames in `outDir` and its
 * screen `session`; null where no engine plugin plays the game in its editor.
 */
export async function editorPlayComputer(
  core: StudioCore,
  x: Pick<CoreInternals, "previews" | "pluginTools">,
  game: EditorPlayGame,
  use: { grant: ComputerGrant; outDir: string; session: SessionPort },
): Promise<ComputerTools | null> {
  const plays = await editorPlayPlugin(core, game.project).catch(() => null);
  if (!plays) return null;
  const plugin = plays.id;
  const binding: PluginBinding = {
    project: game.project,
    directory: game.directory,
    ...(game.threadId ? { threadId: game.threadId } : {}),
  };
  // Each call takes the editor lock its tool needs, the person first, as any harness step does.
  const call = (tool: EnginePlayTool, args: Record<string, unknown>) => {
    // The cancelled session must still reach the backend to let go of its keys and stop its play.
    const signal = tool === EnginePlayTool.Close ? AbortSignal.timeout(CLEANUP_TIMEOUT_MS) : game.signal;
    return x.pluginTools.invokePluginTool(`${plugin}__${tool}`, args, binding, signal, {
      engine: game.engineId ?? STUDIO_ENGINE,
      caller: PluginToolAudience.Harness,
    });
  };
  let opening: string | null = null;
  const afterOpen = async (opened: unknown) => {
    opening = reachesLiveData(opened) ? EDITOR_PLAY_PROMPTS.liveData : null;
  };
  const editor = { call, caps: plays.caps, afterOpen };
  const tools = computerTools(x.previews, use.grant, game.directory, use.outDir, use.session, { editor });
  // The first answer after the play opened carries what opened with it.
  const onLiveTool: ComputerTools["onLiveTool"] = async (name, args) => {
    const answer = await tools.onLiveTool(name, args);
    const note = opening;
    if (!note) return answer;
    opening = null;
    return withNote(answer, note);
  };
  return { ...tools, onLiveTool };
}

/** The editor computer for the chat's own session, or null where no engine plugin plays the game. */
export async function editorPlayTools(
  core: StudioCore,
  x: Pick<CoreInternals, "previews" | "pluginTools">,
  place: EditorPlayPlace,
): Promise<ComputerTools | null> {
  const handle = `${FRAMES_FOLDER}:${place.threadId}`;
  const outDir = path.join(core.layout.scratch, FRAMES_FOLDER, safePathSegment(place.threadId));
  // The chat's own session builds the game: it plays it as a builder plays a web game's window.
  const grant = { project: place.project, root: place.directory, role: ScreenRole.Builder, label: place.project };
  return editorPlayComputer(core, x, place, { grant, outDir, session: windowless(handle) });
}
