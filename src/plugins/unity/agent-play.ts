/**
 * Which Play mode is the agent's own. The editor lock gives way to the person while they play in
 * Unity (`editor-activity`, its probe), but the agent enters Play mode too: the editor connector
 * forwards its `editor_play`. So while a play the agent started runs, the connector keeps a marker
 * (`agent-play.json {startedAt}`) in its own folder, the game's folder in the plugin's storage
 * (`<storage>/mcp/<game>`, the manifest's `cwd: storage:project`), written before the command
 * reaches the editor and removed on the agent's `editor_stop`. The backend reads it there: the
 * lock's probe notes each time it sees that play still running (`seenAt`), a marker neither written
 * nor seen within {@link AGENT_PLAY_MAX_MS} is not believed (a connector that died without removing
 * it), and the probe forgets one once it sees the editor play nothing, unless no probe saw that play
 * running yet and it was asked for within {@link PLAY_START_GRACE_MS}. A play the agent starts any other way (a script that enters
 * Play mode) counts as the person's.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../../substrate/fsx.ts";

/** The marker's file in the connector's folder. */
const AGENT_PLAY_FILE = "agent-play.json";
/** The folder in the plugin's storage holding one connector folder per game. */
const CONNECTORS_FOLDER = "mcp";
/** How long a marker is believed after the play was last asked for or seen running: a dead connector leaves one behind. */
export const AGENT_PLAY_MAX_MS = 30 * MINUTE_MS;
/** How long after the agent asked for Play an editor that plays nothing may still be starting it: entering Play reloads the scripts first. */
export const PLAY_START_GRACE_MS = 30 * SECOND_MS;
/** A game id as Genex names a game's folder: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** What the connector tells of the agent's own play: it started, it stopped. */
export interface AgentPlayMarker {
  started(): Promise<void>;
  stopped(): Promise<void>;
}

/** A connector with no game of its own marks nothing. */
export const NO_AGENT_PLAY: AgentPlayMarker = { started: async () => {}, stopped: async () => {} };

/** The marker a game's connector keeps in its own folder. */
export function agentPlayMarker(folder: string, now: () => number = Date.now): AgentPlayMarker {
  const file = path.join(folder, AGENT_PLAY_FILE);
  return {
    started: async () => {
      await mkdir(folder, { recursive: true });
      await atomicWriteJson(file, { startedAt: now() });
    },
    stopped: () => rm(file, { force: true }),
  };
}

/** Where a game's connector keeps its marker, or null for an id that names no game. */
export const agentPlayFolder = (storage: string, game: string): string | null =>
  GAME_ID.test(game) ? path.join(storage, CONNECTORS_FOLDER, game) : null;

const markerFile = (storage: string, game: string): string | null => {
  const folder = agentPlayFolder(storage, game);
  return folder ? path.join(folder, AGENT_PLAY_FILE) : null;
};

/** The marker's times: asked for, and last seen running by a probe (null until one did); null where there is none. */
async function readMarker(storage: string, game: string): Promise<{ startedAt: number; seenAt: number | null } | null> {
  const file = markerFile(storage, game);
  const marker = file ? await readJsonIfExists<unknown>(file).catch(() => null) : null;
  if (!isJsonObject(marker) || typeof marker.startedAt !== "number") return null;
  const seenAt = typeof marker.seenAt === "number" ? marker.seenAt : null;
  return { startedAt: marker.startedAt, seenAt };
}

/** Whether the agent's own play runs for this game: a marker written, or its play seen, within the last half hour. */
export async function agentPlaying(storage: string, game: string, now: number): Promise<boolean> {
  const marker = await readMarker(storage, game);
  if (!marker || marker.startedAt > now) return false;
  return now - Math.max(marker.startedAt, Math.min(marker.seenAt ?? marker.startedAt, now)) < AGENT_PLAY_MAX_MS;
}

/**
 * Whether the agent asked for its play so recently, and no probe saw it running yet, that an editor
 * playing nothing may still be starting it.
 */
export async function agentPlayStarting(storage: string, game: string, now: number): Promise<boolean> {
  const marker = await readMarker(storage, game);
  if (!marker || marker.seenAt !== null) return false;
  return marker.startedAt <= now && now - marker.startedAt < PLAY_START_GRACE_MS;
}

/** Notes that the agent's play was seen still running, so a long play stays the agent's. */
export async function sawAgentPlay(storage: string, game: string, now: number): Promise<void> {
  const file = markerFile(storage, game);
  const marker = await readMarker(storage, game);
  if (file && marker) await atomicWriteJson(file, { startedAt: marker.startedAt, seenAt: now });
}

/** Forgets the agent's play for this game: the probe saw the editor play nothing. */
export async function forgetAgentPlay(storage: string, game: string): Promise<void> {
  const file = markerFile(storage, game);
  if (file) await rm(file, { force: true });
}
