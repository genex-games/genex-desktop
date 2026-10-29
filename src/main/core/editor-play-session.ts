/**
 * The `computer` tool on a game played in its engine's editor: the target is the
 * game's engine plugin's play tools (`editor-play-target.ts`, `shared/engine-play.ts`). It is
 * offered only where one enabled plugin holds the game's engine link or explicitly scopes every
 * play tool to its facts: to the chat's own session ({@link editorPlayTools}), and to any session the studio
 * hands a computer for that game, a judge's or a playtester's ({@link editorPlayComputer}). Nothing
 * starts until the agent first uses it, and the session's end lets go of the play it started.
 *
 * The engine plugin may declare judges (`PluginJudge`): a judge's grant names one, and its play opens
 * the judge's players, runs its probe once right after opening (through the plugin's tool call,
 * which holds the play's locks), and opens the judge's first answer with what the probe measured
 * and its pictures. A play that can reach the live game's saved data says so in that answer too.
 */
import path from "node:path";
import { ScreenRole } from "../../shared/agent-screen.ts";
import type { TargetCapabilities } from "../../shared/computer-target.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { ENGINE_PLAY_TOOLS, EnginePlayTool, editorCapabilities, playersArg } from "../../shared/engine-play.ts";
import type { LiveToolResult } from "../../shared/engine-requests.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type EngineBinding, isEngineGame } from "../../shared/game-engine.ts";
import type { GameProject } from "../../shared/game-project.ts";
import {
  type JudgeRef,
  judgesFor,
  type PluginBinding,
  PluginCapability,
  type PluginJudge,
  type PluginManifest,
  PluginToolAudience,
} from "../../shared/plugins.ts";
import { type GameKind, scopeReaches } from "../../shared/project-facts.ts";
import { readEngineBinding } from "../../substrate/game-engine-binding.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { type ComputerGrant, type ComputerTools, computerTools } from "./computer-tools.ts";
import { keepCaptures } from "./connector-record.ts";
import { EDITOR_PLAY_PROMPTS } from "./editor-play-session-prompts.ts";
import { keepProbePictures } from "./judge-probe-pictures.ts";
import { safePathSegment } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";

/** Where the chat's editor sessions keep their frames and traces, one folder per chat, under scratch. */
const FRAMES_FOLDER = "editor-play";

/** Allow the editor lock and backend cleanup to finish after the session is cancelled, within a bound. */
const CLEANUP_TIMEOUT_MS = 10 * SECOND_MS;

/** Who the plugin's calls are recorded as when the session names no engine of its own (a judge's, a playtester's). */
const STUDIO_ENGINE = "studio";

/** The most pictures a judge's probe brings into its first answer, and the most characters of its note. */
const MAX_PROBE_PICTURES = 8;
const MAX_PROBE_NOTE_CHARS = 2_000;

/** The play-open parameter that asks for a play started over (`editor-play-target.ts` sends it). */
const FRESH_ARG = "fresh";

const MESSAGE = {
  noWindow: "a game played in its editor has no browser window",
  unknownJudge: (id: string) => `No judge named "${id}" plays this game in its editor.`,
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

/** The engine plugin that plays a game in its editor, what its declaration says that play can do, and its judges. */
export interface EditorPlayPlugin {
  id: string;
  caps: TargetCapabilities;
  /** Whether its play-open can start the play over (declares `fresh`), as a judge's or a playtester's play asks. */
  restarts: boolean;
  /** Every judge the plugin declares; {@link gameJudges} keeps those that reach a game. */
  judges: PluginJudge[];
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

/** Whether the plugin's harness play-open declares `fresh`: it can start a play over instead of joining it. */
function canRestart(manifest: PluginManifest): boolean {
  const open = manifest.tools.find(
    (entry) => entry.name === EnginePlayTool.Open && entry.audience === PluginToolAudience.Harness,
  );
  return Boolean(open?.parameters.properties[FRESH_ARG]);
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
 * `engine.play` declares and its judges: the engine plugin holding the game's current engine link,
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
  return {
    id: only.id,
    caps: editorCapabilities(only.engine?.play),
    restarts: canRestart(only),
    judges: only.judges ?? [],
  };
}

/** The plugin that plays this game in its editor and the judges that reach it by its facts; null for a game not played there. */
export async function gameJudges(
  core: StudioCore,
  project: string,
): Promise<{ plugin: EditorPlayPlugin; judges: PluginJudge[] } | null> {
  const plugin = await editorPlayPlugin(core, project).catch(() => null);
  if (!plugin) return null;
  const facts = await core.games.factsOf(project).catch(() => []);
  return { plugin, judges: judgesFor(plugin.judges, { facts }) };
}

/** The judges that play this game in its editor, by id and label; none for a game not played there. */
export async function gameJudgeRefs(core: StudioCore, project: string): Promise<JudgeRef[]> {
  return ((await gameJudges(core, project))?.judges ?? []).map(({ id, label }) => ({ id, label }));
}

/** A judge of this game by id, with the plugin that declares it; refused in plain words when the game has none of that id. */
export async function gameJudge(
  core: StudioCore,
  project: string,
  id: string,
): Promise<{ plugin: EditorPlayPlugin; judge: PluginJudge }> {
  const found = await gameJudges(core, project);
  const judge = found?.judges.find((entry) => entry.id === id);
  if (!found || !judge) throw new Error(MESSAGE.unknownJudge(id));
  return { plugin: found.plugin, judge };
}

/** A judge's brief as its session reads it, beside the rubric. */
export async function judgeBriefText(core: StudioCore, pluginId: string, judge: PluginJudge): Promise<string> {
  return EDITOR_PLAY_PROMPTS.brief(judge.label, await core.plugins.judgeBrief(pluginId, judge.id));
}

/**
 * The games as the harness's `game.list` describes them: each engine game an engine plugin plays in
 * its editor marked `editorPlay`, with the judges that reach it. A web game, or one no plugin that is
 * on plays, has neither.
 */
export async function withEditorPlay(core: StudioCore, games: readonly GameProject[]): Promise<GameProject[]> {
  return Promise.all(
    games.map(async (game) => {
      if (!isEngineGame(game.engine?.kind)) return game;
      const found = await gameJudges(core, game.name);
      if (!found) return game;
      const judges = found.judges.map(({ id, label }) => ({ id, label }));
      return { ...game, editorPlay: true, ...(judges.length ? { judges } : {}) };
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

/** What opens the first answer after the play opens: notes, and the probe's pictures. */
interface Opening {
  notes: string[];
  images: Array<{ mimeType: string; data: string; label?: string }>;
  /** The probe's pictures as the game's captures keep them (game-relative). */
  kept: string[];
}

/** A probe's answer, read field by field: a note and pictures, nothing else. */
function probeAnswer(answer: unknown): Pick<Opening, "images"> & { note: string } {
  const record = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
  const note = typeof record.note === "string" ? record.note.slice(0, MAX_PROBE_NOTE_CHARS) : "";
  const raw = Array.isArray(record.images) ? record.images : [];
  const images = raw
    .filter(
      (image): image is { mimeType: string; data: string; label?: unknown } =>
        typeof image?.data === "string" && typeof image?.mimeType === "string",
    )
    .slice(0, MAX_PROBE_PICTURES)
    .map(({ mimeType, data, label }) => ({ mimeType, data, ...(typeof label === "string" ? { label } : {}) }));
  return { note, images };
}

/** The answer with the opening's notes after its text and its pictures after its own. */
function withOpening(answer: LiveToolResult, opening: Opening): LiveToolResult {
  const own = typeof answer === "string" ? { text: answer } : answer;
  const text = [own.text, ...opening.notes].filter(Boolean).join("\n");
  const images = [...(own.images ?? []), ...opening.images];
  return { ...own, text, ...(images.length ? { images } : {}) };
}

/** Whether the open's answer says the play reaches the live game's saved data. */
const reachesLiveData = (opened: unknown): boolean =>
  typeof opened === "object" && opened !== null && Reflect.get(opened, "liveData") === true;

/**
 * The editor computer for a session's `grant` (its role, goal and pacing, and the judge it plays as),
 * its frames in `outDir` and its screen `session`; null where no engine plugin plays the game in its
 * editor. A judge the game does not have is refused. `brief` puts the judge's brief in its first
 * answer, for a session whose rubric the host does not write (the harness's own loop).
 */
export async function editorPlayComputer(
  core: StudioCore,
  x: Pick<CoreInternals, "previews" | "pluginTools">,
  game: EditorPlayGame,
  use: { grant: ComputerGrant; outDir: string; session: SessionPort; brief?: boolean },
): Promise<ComputerTools | null> {
  const plays = await editorPlayPlugin(core, game.project).catch(() => null);
  if (!plays) return null;
  const judge = use.grant.judge ? (await gameJudge(core, game.project, use.grant.judge)).judge : null;
  const plugin = plays.id;
  const binding: PluginBinding = {
    project: game.project,
    directory: game.directory,
    ...(game.threadId ? { threadId: game.threadId } : {}),
  };
  // Each call takes the editor lock its tool needs, the person first, as any harness step does.
  const invoke = (tool: string, args: Record<string, unknown>) => {
    // The cancelled session must still reach the backend to let go of its keys and stop its play.
    const signal = tool === EnginePlayTool.Close ? AbortSignal.timeout(CLEANUP_TIMEOUT_MS) : game.signal;
    return x.pluginTools.invokePluginTool(`${plugin}__${tool}`, args, binding, signal, {
      engine: game.engineId ?? STUDIO_ENGINE,
      caller: PluginToolAudience.Harness,
    });
  };
  const call = (tool: EnginePlayTool, args: Record<string, unknown>) => invoke(tool, args);
  const players = playersArg(judge?.players ?? use.grant.players);
  let opening: Opening | null = null;
  const afterOpen = async (opened: unknown) => {
    const next: Opening = { notes: [], images: [], kept: [] };
    if (use.brief && judge) next.notes.push(await judgeBriefText(core, plugin, judge));
    if (reachesLiveData(opened)) next.notes.push(EDITOR_PLAY_PROMPTS.liveData);
    if (judge?.probe) await probe(judge, judge.probe, next);
    opening = next;
  };
  // The judge's probe, once, through the plugin's own tool call (which holds the play's locks).
  const probe = async (as: PluginJudge, tool: string, into: Opening) => {
    try {
      const measured = probeAnswer(await invoke(tool, players && players > 1 ? { players } : {}));
      if (measured.note) into.notes.push(EDITOR_PLAY_PROMPTS.probed(as.label, measured.note));
      into.images.push(...measured.images);
      into.kept.push(...(await keepCaptures(game.directory, measured.images).catch(() => [])));
    } catch (error) {
      into.notes.push(EDITOR_PLAY_PROMPTS.probeFailed(as.label, errorMessage(error)));
    }
  };
  // The grant's players (or its judge's), as many as the engine declares at most (the source holds it to that).
  const editor = { call, caps: plays.caps, players, restarts: plays.restarts, afterOpen };
  const tools = computerTools(x.previews, use.grant, game.directory, use.outDir, use.session, { editor });
  // The first answer after the play opened carries what opened with it; its pictures go with its trace.
  const onLiveTool: ComputerTools["onLiveTool"] = async (name, args) => {
    const answer = await tools.onLiveTool(name, args);
    const opened = opening;
    if (!opened) return answer;
    opening = null;
    const trace = tools.trace().path;
    if (trace) keepProbePictures(trace, opened.kept);
    return withOpening(answer, opened);
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
