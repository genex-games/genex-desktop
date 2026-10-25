/** Unity's computer target, scoped to the bound project and the editor's existing Pipeline server. */
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  ENGINE_PLAY_VIEW,
  EnginePlayRefusal,
  type EnginePlayRefused,
  EnginePlayTool,
} from "../../shared/engine-play.ts";
import { isJsonObject } from "../../substrate/fsx.ts";
import { agentPlayFolder, agentPlayMarker, agentPlaying, type AgentPlayMarker } from "./agent-play.ts";
import {
  FLUSH_INPUT_CODE,
  inputButtonsCode,
  mouseMotionCode,
  PlayCode,
  restoreBackgroundCode,
} from "./computer-play-code.ts";
import { parsePlayInput } from "./computer-play-input.ts";
import {
  editorStatus,
  type EditorStatus,
  type PipelineDeps,
  PipelineProblem,
  PLAY_STOPPED,
  runCommand,
} from "./pipeline.ts";
import { findUnityProject } from "./project-folder.ts";

const PLAY_START_MS = MINUTE_MS;
const INPUT_WAIT_MS = 30 * SECOND_MS;
const CLEANUP_MS = 5 * SECOND_MS;
const POLL_MS = SECOND_MS / 20;
const PlayMode = { Playing: "playing", Paused: "paused" } as const;
const Command = {
  Play: "editor_play",
  Stop: "editor_stop",
  Pause: "editor_pause",
  Capture: "capture_game_view",
  Eval: "eval",
} as const;

const MESSAGE = {
  NoProject: "This game has no Unity project. Open or create its Unity project first.",
  NoEditor: "This game's Unity editor is not open or does not answer. Call unity__open-editor, then try again.",
  Busy: "Unity is busy compiling or reloading scripts. Try again once it is ready.",
  NotPlaying: "No play is running in Unity. Look again to start one.",
  PersonPlaying: "The person is playing in Unity. A fresh play waits until they stop.",
  ClockStopped: "Unity's game clock did not advance. Resume Play mode and check Time.timeScale before trying again.",
} as const;

interface Session {
  started: boolean;
  initiallyPaused: boolean;
  pauseChanged: boolean;
  background?: boolean;
}
interface PlayDeps {
  pipeline: PipelineDeps;
  now: () => Date;
}
interface Play {
  deps: PlayDeps;
  sessions: Map<string, Session>;
}
interface Place {
  root: string;
  game: string;
  storage: string;
  signal: AbortSignal;
  marker: AgentPlayMarker;
}
const keyOf = (at: Place) => `${at.storage}\u0000${at.game}`;
const refused = (code: EnginePlayRefusal, message: string): EnginePlayRefused => ({ refused: code, message });
const isPlaying = (status: EditorStatus) => status.playMode === PlayMode.Playing || status.playMode === PlayMode.Paused;
const cleanupPlace = (play: Play, at: Place): Place => ({ ...at, signal: play.deps.pipeline.timeout(CLEANUP_MS) });

/** Checks command-specific arguments before locating a project or sending any editor commands. */
function validate(tool: EnginePlayTool, args: Record<string, unknown>): void {
  if (tool === EnginePlayTool.Input) parsePlayInput(args);
  if (tool === EnginePlayTool.Open && args.fresh !== undefined && typeof args.fresh !== "boolean")
    throw new Error("fresh must be a boolean.");
  if (tool === EnginePlayTool.Pause && typeof args.paused !== "boolean") throw new Error("paused must be a boolean.");
}

/** Pipeline input commands wrap their own PascalCase success inside the successful HTTP envelope. */
function resultOf(result: unknown): unknown {
  if (!isJsonObject(result)) return result;
  if (result.Success === false || result.success === false) {
    const detail = result.Error ?? result.errorDetails ?? result.error;
    throw new Error(typeof detail === "string" ? detail : "Unity rejected the play command.");
  }
  return result.success === true && Object.hasOwn(result, "result") ? result.result : result;
}

async function command(
  play: Play,
  at: Place,
  name: string,
  parameters: Record<string, unknown> = {},
): Promise<unknown> {
  const answer = await runCommand(at.root, { command: name, parameters }, play.deps.pipeline, {
    signal: at.signal,
    waitMs: 0,
  });
  if (!answer.ok) throw new Error(`Unity ${name}: ${answer.detail ?? answer.problem}.`);
  return resultOf(answer.result);
}

const evaluate = (play: Play, at: Place, code: string) => command(play, at, Command.Eval, { code });

async function status(play: Play, at: Place): Promise<EditorStatus | EnginePlayRefused> {
  const answer = await editorStatus(at.root, play.deps.pipeline, { signal: at.signal });
  if (!answer.ok) {
    const busy = answer.problem === PipelineProblem.Busy;
    return refused(busy ? EnginePlayRefusal.Busy : EnginePlayRefusal.NoEditor, busy ? MESSAGE.Busy : MESSAGE.NoEditor);
  }
  if (answer.result.compiling || answer.result.reloading) return refused(EnginePlayRefusal.Busy, MESSAGE.Busy);
  return answer.result;
}

async function running(play: Play, at: Place): Promise<EditorStatus | EnginePlayRefused> {
  const look = await status(play, at);
  if ("refused" in look) return look;
  if (isPlaying(look)) return look;
  await at.marker.stopped();
  play.sessions.delete(keyOf(at));
  return refused(EnginePlayRefusal.NotPlaying, MESSAGE.NotPlaying);
}

/** Entering and leaving play can reload the domain and temporarily remove Pipeline's descriptor. */
async function waitForMode(play: Play, at: Place, playing: boolean): Promise<void> {
  const deadline = play.deps.pipeline.now() + PLAY_START_MS;
  do {
    const look = await status(play, at);
    if (!("refused" in look)) {
      const reached = playing ? isPlaying(look) : look.playMode === PLAY_STOPPED;
      if (reached) return;
    }
    await play.deps.pipeline.sleep(POLL_MS, at.signal);
  } while (play.deps.pipeline.now() < deadline);
  throw new Error(`Unity did not ${playing ? "enter" : "leave"} Play mode before the wait ended.`);
}

async function stop(play: Play, at: Place): Promise<void> {
  await command(play, at, Command.Stop);
  await waitForMode(play, at, false);
  await at.marker.stopped();
}

async function available(play: Play, at: Place): Promise<void> {
  const input = await evaluate(play, at, PlayCode.InputAvailable);
  if (isJsonObject(input) && input.available === true) return;
  const reason = isJsonObject(input) ? input.reason : undefined;
  throw new Error(typeof reason === "string" ? reason : "Unity could not confirm that the Input System is active.");
}

/** Records the original background setting before a write whose reply might be lost. */
async function setBackground(play: Play, at: Place, session: Session): Promise<void> {
  if (session.background !== undefined) return;
  const previous = await evaluate(play, at, PlayCode.Background);
  if (typeof previous !== "boolean") throw new Error("Unity did not report its background play setting.");
  session.background = previous;
  // Save the original before changing it: an applied write can lose its reply.
  if (!previous) await evaluate(play, at, restoreBackgroundCode(true));
}

async function open(play: Play, at: Place, args: Record<string, unknown>) {
  const look = await status(play, at);
  if ("refused" in look) return look;
  const key = keyOf(at);
  const known = play.sessions.get(key);
  const owned = await agentPlaying(at.storage, at.game, play.deps.now().getTime());
  if (args.fresh && isPlaying(look) && !owned) return refused(EnginePlayRefusal.PersonPlaying, MESSAGE.PersonPlaying);
  await available(play, at);
  const restart = args.fresh === true && isPlaying(look);
  if (restart) await stop(play, at);
  const joined = !restart && isPlaying(look);
  const continuing = known && known.started === owned;
  const resumed = continuing
    ? known
    : { started: owned, initiallyPaused: look.playMode === PlayMode.Paused, pauseChanged: false };
  const session: Session = joined ? resumed : { started: true, initiallyPaused: false, pauseChanged: false };
  play.sessions.set(key, session);
  try {
    if (!joined) {
      await at.marker.started();
      await command(play, at, Command.Play);
      await waitForMode(play, at, true);
    }
    await setBackground(play, at, session);
    return { ...ENGINE_PLAY_VIEW, joined };
  } catch (error) {
    await close(play, cleanupPlace(play, at)).catch(() => undefined);
    throw error;
  }
}

async function state(play: Play, at: Place) {
  const look = await running(play, at);
  if ("refused" in look) return look;
  return evaluate(play, at, PlayCode.State);
}

async function clock(play: Play, at: Place): Promise<{ gameSeconds: number; frame: number }> {
  const value = await evaluate(play, at, PlayCode.State);
  const gameSeconds = isJsonObject(value) ? value.gameSeconds : undefined;
  const frame = isJsonObject(value) ? value.frame : undefined;
  if (typeof gameSeconds !== "number" || typeof frame !== "number")
    throw new Error("Unity returned no usable game clock.");
  if (!Number.isFinite(gameSeconds) || !Number.isFinite(frame)) throw new Error("Unity returned no usable game clock.");
  return { gameSeconds, frame };
}

/** Waits on Unity's scaled game time, with a separate wall-clock bound for a paused or stalled game. */
async function playFor(play: Play, at: Place, seconds: number): Promise<number> {
  const start = await clock(play, at);
  const deadline = play.deps.pipeline.now() + INPUT_WAIT_MS;
  do {
    await play.deps.pipeline.sleep(POLL_MS, at.signal);
    const current = await clock(play, at);
    if (current.gameSeconds - start.gameSeconds >= seconds && current.frame > start.frame) return current.gameSeconds;
    if (current.gameSeconds < start.gameSeconds) throw new Error("Unity's play restarted while input was held.");
  } while (play.deps.pipeline.now() < deadline);
  throw new Error(MESSAGE.ClockStopped);
}

async function releaseInput(play: Play, at: Place, keys: string[], buttons: string[]) {
  const cleanup = cleanupPlace(play, at);
  await evaluate(play, cleanup, inputButtonsCode(keys, buttons, false));
  const look = await status(play, cleanup);
  if (!("refused" in look) && look.playMode === PlayMode.Playing) {
    await playFor(play, cleanup, 0);
    return;
  }
  await evaluate(play, cleanup, FLUSH_INPUT_CODE);
}

async function input(play: Play, at: Place, args: Record<string, unknown>) {
  const parsed = parsePlayInput(args);
  const unknown = parsed.keys.filter((key) => key.name === null).map((key) => key.code);
  if (unknown.length) return refused(EnginePlayRefusal.UnknownKey, `Unity has no key for ${unknown.join(", ")}.`);
  const look = await running(play, at);
  if ("refused" in look) return look;
  if (look.playMode === PlayMode.Paused) throw new Error(MESSAGE.ClockStopped);
  const { dx, dy, wheel } = parsed;
  const needsInput = parsed.keys.length > 0 || dx !== 0 || dy !== 0 || wheel !== 0;
  if (needsInput) await available(play, at);
  if (dx || dy || wheel) {
    await evaluate(play, at, mouseMotionCode(dx, dy, wheel));
    // Let the aim reach a player frame before a button is pressed at that aim.
    await playFor(play, at, POLL_MS / SECOND_MS);
  }
  const keys = parsed.keys.flatMap((key) => (!key.button && key.name ? [key.name] : []));
  const buttons = parsed.keys.flatMap((key) => (key.button ? [key.button] : []));
  const hasButtons = keys.length > 0 || buttons.length > 0;
  try {
    if (hasButtons) await evaluate(play, at, inputButtonsCode(keys, buttons, true));
    const gameSeconds = await playFor(play, at, parsed.seconds);
    return { held: parsed.keys.map((key) => key.name), gameSeconds };
  } finally {
    // A lost response may still have queued the press; release independently of cancellation.
    if (hasButtons) await releaseInput(play, at, keys, buttons);
  }
}

async function shot(play: Play, at: Place) {
  const look = await running(play, at);
  if ("refused" in look) return look;
  const value = await command(play, at, Command.Capture, {
    ...ENGINE_PLAY_VIEW,
    source: "screen",
    include_inline_image: true,
  });
  const picture =
    isJsonObject(value) && value.encoding === "png" && typeof value.base64 === "string" && value.base64.length > 0;
  if (!picture) throw new Error("Unity returned no PNG of the Game view.");
  return { png: value.base64, width: value.width, height: value.height };
}

async function pause(play: Play, at: Place, args: Record<string, unknown>) {
  const look = await running(play, at);
  if ("refused" in look) return look;
  const paused = args.paused === true;
  if ((look.playMode === PlayMode.Paused) !== paused) {
    const session = play.sessions.get(keyOf(at));
    if (session) session.pauseChanged = true;
    // A lost reply can still have toggled pause, so close must restore it after an uncertain result too.
    await command(play, at, Command.Pause);
  }
  return { paused };
}

async function close(play: Play, at: Place) {
  const key = keyOf(at);
  const session = play.sessions.get(key);
  if (!session) return { closed: false };
  const cleanup = cleanupPlace(play, at);
  const look = await status(play, cleanup);
  if ("refused" in look) throw new Error(look.message);
  const ownsPlay = session.started && (await agentPlaying(at.storage, at.game, play.deps.now().getTime()));
  if (ownsPlay) {
    if (isPlaying(look)) await stop(play, cleanup);
    else await at.marker.stopped();
  } else if (!session.started) {
    const restorePause =
      session.pauseChanged && isPlaying(look) && (look.playMode === PlayMode.Paused) !== session.initiallyPaused;
    if (restorePause) await command(play, cleanup, Command.Pause);
    if (session.background !== undefined) await evaluate(play, cleanup, restoreBackgroundCode(session.background));
  }
  play.sessions.delete(key);
  return { closed: true };
}

const handlers = {
  [EnginePlayTool.Open]: open,
  [EnginePlayTool.Input]: input,
  [EnginePlayTool.Shot]: shot,
  [EnginePlayTool.State]: state,
  [EnginePlayTool.Pause]: pause,
  [EnginePlayTool.Close]: close,
} satisfies Record<EnginePlayTool, (play: Play, at: Place, args: Record<string, unknown>) => Promise<unknown>>;

/** One backend's play sessions, recovered from the shared ownership marker after a backend restart. */
export function createComputerPlay(deps: PlayDeps) {
  const play: Play = { deps, sessions: new Map() };
  return async (tool: EnginePlayTool, args: Record<string, unknown>, context: PluginContext, storage: string) => {
    validate(tool, args);
    if (tool !== EnginePlayTool.Close) context.signal.throwIfAborted();
    const game = context.project;
    const folder = game ? agentPlayFolder(storage, game) : null;
    const project = context.directory ? await findUnityProject(context.directory) : undefined;
    if (!folder || !game || !project) throw new Error(MESSAGE.NoProject);
    const marker = agentPlayMarker(folder, () => deps.now().getTime());
    const signal =
      tool === EnginePlayTool.Input
        ? AbortSignal.any([context.signal, deps.pipeline.timeout(INPUT_WAIT_MS)])
        : context.signal;
    const at = { root: project.root, game, storage, signal, marker };
    return handlers[tool](play, at, args);
  };
}
