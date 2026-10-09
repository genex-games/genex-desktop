/**
 * Which play session is the agent's own. The editor lock gives way to the person while they play
 * in Unreal (`editor-activity`, its probe), but the agent starts play sessions too: the editor
 * connector forwards its `StartPIE`. So while a play the agent started runs, the connector keeps a
 * marker (`agent-play.json {startedAt}`) in its own folder, the game's folder in the plugin's
 * storage (`<storage>/mcp/<game>`, the manifest's `cwd: storage:project`), and removes it on the
 * agent's `StopPIE`, when the connector closes and when the editor goes away. The backend reads it
 * there; a marker older than {@link AGENT_PLAY_MAX_MS} is not believed (a connector that died
 * without removing it), and the lock's probe forgets one once it sees the editor play nothing (the
 * agent's play ended some other way: the person pressed Stop, or the game ended play).
 * Residuals: a play the person starts before any probe saw the agent's play end counts as the
 * agent's; a play the agent starts any other way than the connector's `StartPIE` (a script that
 * begins play) counts as the person's, so the agent's own editor calls, its stop of that play
 * included, wait for "the person" until the lock's wait runs out; and the person's edits outside
 * play are not seen at all.
 */
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject } from "../../substrate/fsx.ts";

/** The marker's name in the connector's folder. */
export const AGENT_PLAY_FILE = "agent-play.json";
/** How long a marker is believed: no agent's play test runs half an hour. */
export const AGENT_PLAY_MAX_MS = 30 * MINUTE_MS;
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
  /** The agent's play started. */
  started(): Promise<void>;
  /** The agent's play ended, the connector closed or the editor went away. */
  stopped(): Promise<void>;
};

/** A marker kept in the connector's own folder, stamped by `now`. */
export function agentPlayMarker(folder: string, now: () => number = Date.now): AgentPlayMarker {
  const file = path.join(folder, AGENT_PLAY_FILE);
  return {
    started: async () => {
      await mkdir(folder, { recursive: true }).catch(() => undefined);
      await atomicWriteJson(file, { startedAt: now() }).catch(() => undefined);
    },
    stopped: async () => {
      await rm(file, { force: true }).catch(() => undefined);
    },
  };
}

/** A connector that marks nothing: a bridge serving no game. */
export const NO_AGENT_PLAY: AgentPlayMarker = { started: async () => {}, stopped: async () => {} };

/** A marker's text read as JSON, or null when it is none. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Whether a play the agent started runs for `game` now: its connector's marker is a plain file,
 * started at most {@link AGENT_PLAY_MAX_MS} before `now` and not after it.
 */
export async function agentPlaying(storage: string, game: string, now: number): Promise<boolean> {
  const folder = agentPlayFolder(storage, game);
  if (!folder) return false;
  const file = path.join(folder, AGENT_PLAY_FILE);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_MARKER_BYTES) return false;
  const marker = await readFile(file, "utf8").then(parsed, () => null);
  const startedAt = isJsonObject(marker) ? marker.startedAt : undefined;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return false;
  const age = now - startedAt;
  return age >= 0 && age <= AGENT_PLAY_MAX_MS;
}

/**
 * Forgets the agent's play for `game` once the editor plays nothing: its marker goes when it was made
 * at or before `seenAt` (when the editor was asked), so a play the agent started since stays marked.
 * Never throws.
 */
export async function forgetAgentPlay(storage: string, game: string, seenAt: number): Promise<void> {
  const folder = agentPlayFolder(storage, game);
  if (!folder) return;
  const file = path.join(folder, AGENT_PLAY_FILE);
  const marker = await readFile(file, "utf8").then(parsed, () => null);
  const startedAt = isJsonObject(marker) ? marker.startedAt : undefined;
  const madeLater = typeof startedAt === "number" && startedAt > seenAt;
  if (!madeLater) await rm(file, { force: true }).catch(() => undefined);
}
