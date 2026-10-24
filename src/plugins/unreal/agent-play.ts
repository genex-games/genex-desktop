/**
 * Which play session is the agent's own. The editor lock gives way to the person while they play
 * in Unreal (`editor-activity`, its probe), but the agent starts play sessions too: the editor
 * connector forwards its `StartPIE`. So while a play the agent started runs, the connector keeps a
 * marker (`agent-play.json {startedAt}`) in its own folder, the game's folder in the plugin's
 * storage (`<storage>/mcp/<game>`, the manifest's `cwd: storage:project`), written before its
 * `StartPIE` reaches the editor (a refused start gives back the mark there was), and removes it on
 * the agent's `StopPIE`, when the connector closes and when the editor goes away. The backend reads
 * it there: the lock's probe notes each time it sees that play running (`seenAt`), a marker neither
 * written nor seen within {@link AGENT_PLAY_MAX_MS} is not believed (a connector that died without
 * removing it), and the probe forgets one once it sees the editor play nothing (the agent's play
 * ended some other way: the person pressed Stop, or the game ended play), unless no probe has seen
 * that play yet and it was asked for within {@link PLAY_START_GRACE_MS} (Unreal begins play on a
 * later frame). Residuals: a play the person starts before any probe saw the agent's play end counts
 * as the agent's; a play the agent starts any other way than the connector's `StartPIE` (a script
 * that begins play) counts as the person's, so the agent's own editor calls, its stop of that play
 * included, wait for "the person" until the lock's wait runs out unless agents may use Unreal while
 * the person plays (`engine-agents.ts`); and the person's edits outside play are not seen at all.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";

/** The marker's name in the connector's folder. */
export const AGENT_PLAY_FILE = "agent-play.json";
/** How long a marker is believed after the play was last asked for or seen running: a dead connector leaves one behind. */
export const AGENT_PLAY_MAX_MS = 30 * MINUTE_MS;
/** How long after the agent asked for play an editor that plays nothing may still be beginning it. */
export const PLAY_START_GRACE_MS = 30 * SECOND_MS;
/** Where the host runs each game's connector inside the plugin's storage. */
const BRIDGES_FOLDER = "mcp";
/** A game id as Genex names a game's folder: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;
/** The largest marker read. */
const MAX_MARKER_BYTES = 1024;

/** The game's connector folder in the plugin's storage, or null for a name that isn't a plain folder name. */
export function agentPlayFolder(storage: string, game: string): string | null {
  return GAME_ID.test(game) ? path.join(storage, BRIDGES_FOLDER, game) : null;
}

/** What the editor connector tells about the agent's play. Neither ever throws. */
export type AgentPlayMarker = {
  /** The agent's play is starting: marked now, and the answer gives back the mark there was (a refused start). */
  started(): Promise<() => Promise<void>>;
  /** The agent's play ended, the connector closed or the editor went away. */
  stopped(): Promise<void>;
};

/** A marker kept in the connector's own folder, stamped by `now`. */
export function agentPlayMarker(folder: string, now: () => number = Date.now): AgentPlayMarker {
  const file = path.join(folder, AGENT_PLAY_FILE);
  return {
    started: async () => {
      const before = await readRegularFile(file, MAX_MARKER_BYTES).catch(() => null);
      await mkdir(folder, { recursive: true }).catch(() => undefined);
      await atomicWriteJson(file, { startedAt: now() }).catch(() => undefined);
      return async () => {
        if (before) await writeFile(file, before).catch(() => undefined);
        else await rm(file, { force: true }).catch(() => undefined);
      };
    },
    stopped: async () => {
      await rm(file, { force: true }).catch(() => undefined);
    },
  };
}

/** A connector that marks nothing: a bridge serving no game. */
export const NO_AGENT_PLAY: AgentPlayMarker = { started: async () => async () => {}, stopped: async () => {} };

/** A marker's text read as JSON, or null when it is none. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** When the agent's play was asked for, and when a probe last saw it running (null until one did). */
type Stamps = { startedAt: number; seenAt: number | null };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * What the marker says of the agent's play, or null when it says nothing Genex believes: read only
 * as a plain small file, never through a link and never blocking on a pipe.
 */
async function markerStamps(file: string): Promise<Stamps | null> {
  const marker = await readRegularFile(file, MAX_MARKER_BYTES).then(
    (bytes) => parsed(bytes.toString("utf8")),
    () => null,
  );
  if (!isJsonObject(marker) || !finite(marker.startedAt)) return null;
  return { startedAt: marker.startedAt, seenAt: finite(marker.seenAt) ? marker.seenAt : null };
}

/** The game's marker file, or null for a name that isn't a plain folder name. */
function markerFile(storage: string, game: string): string | null {
  const folder = agentPlayFolder(storage, game);
  return folder ? path.join(folder, AGENT_PLAY_FILE) : null;
}

/**
 * Whether a play the agent started runs for `game` now: its connector's marker is a plain file,
 * started at most {@link AGENT_PLAY_MAX_MS} before `now` and not after it.
 */
export async function agentPlaying(storage: string, game: string, now: number): Promise<boolean> {
  const file = markerFile(storage, game);
  const stamps = file ? await markerStamps(file) : null;
  if (!stamps || stamps.startedAt > now) return false;
  return now - Math.max(stamps.startedAt, Math.min(stamps.seenAt ?? stamps.startedAt, now)) <= AGENT_PLAY_MAX_MS;
}

/** Notes that the agent's play was seen running at `now`, so a long play stays the agent's. Never throws. */
export async function sawAgentPlay(storage: string, game: string, now: number): Promise<void> {
  const file = markerFile(storage, game);
  const stamps = file ? await markerStamps(file) : null;
  if (file && stamps) await atomicWriteJson(file, { startedAt: stamps.startedAt, seenAt: now }).catch(() => undefined);
}

/**
 * Forgets the agent's play for `game` once the editor plays nothing: its marker goes when it was made
 * at or before `seenAt` (when the editor was asked), so a play the agent started since stays marked,
 * and not while a play nobody saw running yet may still be beginning. Never throws.
 */
export async function forgetAgentPlay(storage: string, game: string, seenAt: number): Promise<void> {
  const file = markerFile(storage, game);
  if (!file) return;
  const stamps = await markerStamps(file);
  const madeLater = stamps !== null && stamps.startedAt > seenAt;
  // A play nobody saw running yet, asked for a moment ago, may still be beginning.
  const beginning = stamps?.seenAt === null && seenAt - stamps.startedAt < PLAY_START_GRACE_MS;
  // `rm` without `recursive` removes a link itself, never what it points at, and no folder.
  if (!madeLater && !beginning) await rm(file, { force: true }).catch(() => undefined);
}
