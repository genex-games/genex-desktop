/**
 * What the Roblox plugin tells about the agent's own work in Studio, so the Studio lock's probe can
 * tell the agent's edits from the person's. Both marks live in the game's connection folder
 * (`<plugin storage>/mcp/<game>`):
 *
 * - `agent-busy.json`: while a write the agent asked for runs (`execute_luau`, or a tool Genex has
 *   no class for), the connection keeps `{since}`, then `{since, until}` once the last overlapping
 *   write ended. What Studio reports between `since` and {@link AGENT_TRAIL_MS} after `until` is
 *   the agent's: Studio records its own `execute_luau` runs as edits.
 * - `agent-play.json`: `{since}` while a play test the agent started runs (the play tools), removed
 *   when it ends. What Studio reports during it is the agent's.
 *
 * A mark older than {@link AGENT_MARK_MAX_MS}, or dated in the future, is not believed: the call
 * that wrote it died. Writing a mark never fails a call; reading one never throws.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { BindingState, isGameId, readBinding } from "./studio-binding.ts";

/** The busy mark's name in the connection's folder. */
export const AGENT_BUSY_FILE = "agent-busy.json";
/** The play mark's name in the connection's folder. */
export const AGENT_PLAY_FILE = "agent-play.json";
/** How long a mark is believed: no write the agent asks for, and no play test, runs half an hour. */
export const AGENT_MARK_MAX_MS = 30 * MINUTE_MS;
/** How long after the agent's last write ended Studio's reports of it may still arrive (the helper notes every 2 s). */
export const AGENT_TRAIL_MS = 3 * SECOND_MS;
/** Where the host runs each game's connection inside the plugin's storage. */
const CONNECTIONS_FOLDER = "mcp";
/** The largest mark read. */
const MAX_MARK_BYTES = 1024;

/** The busy mark: when the agent's writes began, and when the last one ended. */
export interface AgentBusy {
  since: number;
  until?: number;
}

/** The play mark: when the agent's play test began. */
export interface AgentPlay {
  since: number;
}

/** The marks Genex believes now. */
export interface AgentMarks {
  busy?: AgentBusy;
  play?: AgentPlay;
}

/** The game's connection folder in the plugin's storage, or undefined for a name that isn't a game id. */
export function agentFolder(storage: string, game: string): string | undefined {
  return isGameId(game) ? path.join(storage, CONNECTIONS_FOLDER, game) : undefined;
}

/** Runs the agent's writes with the busy mark kept around them. */
export interface BusyMarker {
  around<T>(write: () => Promise<T>): Promise<T>;
}

async function writeMark(folder: string, name: string, value: AgentBusy | AgentPlay): Promise<void> {
  await mkdir(folder, { recursive: true }).catch(() => undefined);
  await atomicWriteJson(path.join(folder, name), value).catch(() => undefined);
}

/** A busy mark kept in `folder`, stamped by `now`; overlapping writes share one mark. */
export function agentBusyMarker(folder: string, now: () => number): BusyMarker {
  let running = 0;
  let since = 0;
  return {
    async around(write) {
      if (running++ === 0) {
        since = now();
        await writeMark(folder, AGENT_BUSY_FILE, { since });
      }
      try {
        return await write();
      } finally {
        if (--running === 0) await writeMark(folder, AGENT_BUSY_FILE, { since, until: now() });
      }
    },
  };
}

/** The connection folders of the games whose binding names Studio `studioId` at `now`. */
async function boundTo(storage: string, studioId: string, now: number): Promise<string[]> {
  const games = await readdir(path.join(storage, CONNECTIONS_FOLDER)).catch(() => [] as string[]);
  const folders: string[] = [];
  for (const game of games.filter(isGameId)) {
    const folder = path.join(storage, CONNECTIONS_FOLDER, game);
    const read = await readBinding(folder, now);
    if (read.state === BindingState.Bound && read.binding.studioId === studioId) folders.push(folder);
  }
  return folders;
}

/**
 * Runs Genex's own read in Studio `studioId` with the busy mark of every game bound to that Studio:
 * Studio records an `execute_luau` run as an edit, and that game's helper would report it as the person's.
 */
export async function asAgentInStudio<T>(
  storage: string,
  studioId: string,
  now: () => number,
  work: () => Promise<T>,
): Promise<T> {
  const folders = await boundTo(storage, studioId, now());
  const marked = folders.reduce<() => Promise<T>>(
    (inner, folder) => () => agentBusyMarker(folder, now).around(inner),
    work,
  );
  return marked();
}

/** Marks the agent's play test as started now. */
export function markAgentPlay(folder: string, now: number): Promise<void> {
  return writeMark(folder, AGENT_PLAY_FILE, { since: now });
}

/** Removes the play mark: the agent's play test ended. */
export async function clearAgentPlay(folder: string): Promise<void> {
  await rm(path.join(folder, AGENT_PLAY_FILE), { force: true }).catch(() => undefined);
}

const isStamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** A mark's fields, read only as a small plain file, never through a link; null when it says nothing. */
async function readMark(folder: string, name: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(
      (await readRegularFile(path.join(folder, name), MAX_MARK_BYTES)).toString("utf8"),
    );
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a mark's time is one Genex believes at `now`: not in the future, not past the max age. */
const believed = (stamp: number, now: number) => stamp <= now && now - stamp <= AGENT_MARK_MAX_MS;

/** The busy mark, when believed: a finished one by its end, one still running by its start. */
function busyOf(mark: Record<string, unknown> | null, now: number): AgentBusy | undefined {
  if (!mark || !isStamp(mark.since)) return undefined;
  if (mark.until === undefined) return believed(mark.since, now) ? { since: mark.since } : undefined;
  if (!isStamp(mark.until) || mark.until < mark.since || !believed(mark.until, now)) return undefined;
  return { since: mark.since, until: mark.until };
}

/** The marks in the game's connection folder that Genex believes at `now`. */
export async function readAgentMarks(folder: string, now: number): Promise<AgentMarks> {
  const marks: AgentMarks = {};
  const busy = busyOf(await readMark(folder, AGENT_BUSY_FILE), now);
  if (busy) marks.busy = busy;
  const play = await readMark(folder, AGENT_PLAY_FILE);
  if (play && isStamp(play.since) && believed(play.since, now)) marks.play = { since: play.since };
  return marks;
}

/** Whether something Studio reported at `at` was the agent's own work, by the marks read at `now`. */
export function agentsAt(marks: AgentMarks, at: number, now: number): boolean {
  if (marks.play && at >= marks.play.since) return true;
  const busy = marks.busy;
  if (!busy) return false;
  return at >= busy.since && at <= (busy.until ?? now) + AGENT_TRAIL_MS;
}
