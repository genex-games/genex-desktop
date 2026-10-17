/**
 * Which Play mode is the agent's own. The editor lock gives way to the person while they play in
 * Unity (`editor-activity`, its probe), but the agent enters Play mode too: the editor connector
 * forwards its `editor_play`. So while a play the agent started runs, the connector keeps a marker
 * (`agent-play.json {startedAt}`) in its own folder, the game's folder in the plugin's storage
 * (`<storage>/mcp/<game>`, the manifest's `cwd: storage:project`), and removes it on the agent's
 * `editor_stop`. The backend reads it there; a marker older than {@link AGENT_PLAY_MAX_MS} is not
 * believed (a connector that died without removing it), and the probe forgets one once it sees the
 * editor play nothing. A play the agent starts any other way (a script that enters Play mode)
 * counts as the person's.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../../substrate/fsx.ts";

/** The marker's file in the connector's folder. */
const AGENT_PLAY_FILE = "agent-play.json";
/** The folder in the plugin's storage holding one connector folder per game. */
const CONNECTORS_FOLDER = "mcp";
/** How long a marker is believed: no agent play lasts longer, and a dead connector leaves one behind. */
export const AGENT_PLAY_MAX_MS = 30 * MINUTE_MS;
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

/** Whether the agent's own play runs for this game: a marker written within the last half hour. */
export async function agentPlaying(storage: string, game: string, now: number): Promise<boolean> {
  const file = markerFile(storage, game);
  const marker = file ? await readJsonIfExists<unknown>(file).catch(() => null) : null;
  const startedAt = isJsonObject(marker) ? marker.startedAt : undefined;
  return typeof startedAt === "number" && startedAt <= now && now - startedAt < AGENT_PLAY_MAX_MS;
}

/** Forgets the agent's play for this game: the probe saw the editor play nothing. */
export async function forgetAgentPlay(storage: string, game: string): Promise<void> {
  const file = markerFile(storage, game);
  if (file) await rm(file, { force: true });
}
