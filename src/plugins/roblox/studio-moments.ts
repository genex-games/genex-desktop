/**
 * What the Roblox plugin's handlers do at Genex's moments (`context.hook`), over the Studio
 * operations the backend hands them for one game (`MomentOps`), on the injected clock:
 *
 * - `save-place` (`checkpoint.before`, also before each chat message; `restore.before`): the
 *   script sync's pending file changes go to Studio first, then the Genex helper exports what
 *   changed of the place into `.genex/place/`, so Genex's git checkpoint holds the place beside the
 *   scripts. Before a restore it names others in a Team Create place, whose edits go back too.
 * - `load-place` (`restore.after`): the helper loads the restored export, then the scripts are
 *   reconciled with the restored `src/`; with Studio not connected, `pending-load.json` waits for
 *   the helper's next connection.
 * - `studio-state` (`health`): the helper is connected and answers a ping within
 *   {@link STUDIO_PING_MS}, and Studio's MCP server lists that Studio. No answer: a dialog may be
 *   open in Studio.
 * - `studio-crash-note` (`crash`): asks the person to reopen Studio; never closes or kills it.
 * - `team-note` (`turn.start`): who else is in the place, when that changed.
 * - `hero-shots` (`checkpoint.after`, the viewport observer): Studio's viewport picture.
 * - `open-for-run` (`run.prepare`): Studio connected for the place, opening the place when it isn't.
 * - `studio-activity` (the lock's probe): the person's activity the helper reported in the last
 *   {@link PERSON_ACTIVE_MS}, the agent's own work (`agent-marks.ts`) discounted.
 *
 * Answers and their words are `hook-answers.ts`'s. Git stays Genex's: nothing here snapshots or
 * restores files. Deadlines are never lengthened: each step's longest path is a constant below
 * Genex's ceiling for its moment.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type HookAnswer, type HookContext, HookEvent } from "../../shared/plugin-hooks.ts";
import { type AgentMarks, agentsAt } from "./agent-marks.ts";
import { type HelperAsk, HelperLinkError, HelperLinkFailure } from "./helper-link.ts";
import { HelperErrorCode, HelperMessage } from "./helper-protocol.ts";
import {
  inRun,
  type LoadRead,
  loadAnswer,
  PlaceLoad,
  PlaceSave,
  RunStart,
  type SaveRead,
  type StartRead,
  StudioHealth,
  saveAnswer,
  startAnswer,
  healthAnswer,
  shotsAnswer,
  teamAnswer,
} from "./hook-answers.ts";
import {
  clearPendingLoad,
  clearPendingScripts,
  exportPlace,
  loadPlace,
  PLACE_EXPORT_MAX_MS,
  PLACE_FOLDER,
  PLACE_LOAD_MAX_MS,
  readManifest,
  SAVE_POINT_FILE_MAX_BYTES,
  writePendingLoad,
  writePendingScripts,
} from "./place-files.ts";
import type { ReconcileOptions } from "./script-sync.ts";

/** How long a sign of the person's work in Studio counts: the helper notes it at most every 2 s and says "stopped" after 10 s of quiet. */
export const PERSON_ACTIVE_MS = 15 * SECOND_MS;
/** How long the helper has to answer a ping before Studio counts as not answering. */
export const STUDIO_PING_MS = 5 * SECOND_MS;
/** How long Studio's MCP server has to list its Studios. */
export const STUDIO_LIST_MS = 5 * SECOND_MS;
/** How long asking whether Studio's process runs may take (`pgrep` or `tasklist`). */
const RUNNING_CHECK_MS = 5 * SECOND_MS;
/** How long an open Studio's helper may stay unconnected for the game before health says the place isn't open: it retries every 30 s at most. */
export const RECONNECT_WAIT_MS = 45 * SECOND_MS;
/** How long the script sync's pending file changes may take to reach Studio before an export. */
export const FLUSH_MAX_MS = 2 * SECOND_MS;
/** A run's save point and the save before a restore may wait longer than a chat message for a full export. */
export const RUN_EXPORT_MAX_MS = 2 * MINUTE_MS;
/** How long the helper has to say who else is in the place. */
export const TEAM_ASK_MS = 3 * SECOND_MS;
/** How long a load waits for the scripts to be reconciled; the reconcile goes on after it. */
export const REAPPLY_WAIT_MS = MINUTE_MS;
/** How long Studio has to take the viewport's picture. */
export const HERO_SHOT_MS = 15 * SECOND_MS;
/** What an observer's call keeps free after the picture: keeping it and the answer's trip. */
const OBSERVE_MARGIN_MS = 3 * SECOND_MS;
/** How long a run's start waits for the place it opened to connect, asking this often. */
export const OPEN_WAIT_MS = 3 * MINUTE_MS;
export const OPEN_POLL_MS = 2 * SECOND_MS;
/** How long opening the place may take (the command line, or bringing Studio forward). */
const OPEN_CALL_MS = 30 * SECOND_MS;

/** The longest `save-place` before a chat message's checkpoint: the flush, then the incremental export. */
export const SAVE_PLACE_CHAT_MAX_MS = FLUSH_MAX_MS + PLACE_EXPORT_MAX_MS;
/** The longest `save-place` at a run's save point. */
export const SAVE_PLACE_RUN_MAX_MS = FLUSH_MAX_MS + RUN_EXPORT_MAX_MS;
/** The longest `save-place` before a restore: who else is in the place, the flush, the export. */
export const SAVE_PLACE_RESTORE_MAX_MS = TEAM_ASK_MS + FLUSH_MAX_MS + RUN_EXPORT_MAX_MS;
/** The longest `load-place`: the load, then the wait for the scripts. */
export const LOAD_PLACE_MAX_MS = PLACE_LOAD_MAX_MS + REAPPLY_WAIT_MS;
/** The longest `studio-state`: whether Studio runs, the ping, then the listing. */
export const STUDIO_STATE_MAX_MS = RUNNING_CHECK_MS + STUDIO_PING_MS + STUDIO_LIST_MS;
/** The longest `open-for-run`: Studio opened, the wait for the connection and its last ask, the ping. */
export const OPEN_FOR_RUN_MAX_MS = RUNNING_CHECK_MS + OPEN_CALL_MS + OPEN_WAIT_MS + OPEN_POLL_MS + STUDIO_PING_MS;
/** The longest `team-note`. */
export const TEAM_NOTE_MAX_MS = TEAM_ASK_MS;
/** The longest `hero-shots`. */
export const HERO_SHOTS_MAX_MS = HERO_SHOT_MS;

/** What the backend hears from each game's helper, unasked: the person's activity and who else is in the place. */
export interface StudioWatch {
  /** The helper said the person is (or stopped) working in Studio. */
  activity(game: string, editing: boolean): void;
  /** The helper said who else is in the place. */
  team(game: string, others: string[]): void;
  /** When the helper reported the person's work within the last {@link PERSON_ACTIVE_MS}. */
  seen(game: string): number[];
  /** Who else is in the place, when the helper said. */
  others(game: string): string[] | undefined;
  /** Who the last Team Create note named, and noting it. */
  noted(game: string): string[] | undefined;
  note(game: string, others: string[]): void;
  /** Since when the game's helper has been seen unconnected (now, the first time); forgotten once it connects. */
  unboundSince(game: string): number;
  connected(game: string): void;
}

/** The backend's watch of every game, on its clock. */
export function createStudioWatch(now: () => number): StudioWatch {
  const seen = new Map<string, number[]>();
  const others = new Map<string, string[]>();
  const noted = new Map<string, string[]>();
  const unbound = new Map<string, number>();
  const recent = (game: string) => (seen.get(game) ?? []).filter((at) => now() - at <= PERSON_ACTIVE_MS);
  return {
    activity(game, editing) {
      seen.set(game, editing ? [...recent(game), now()] : []);
    },
    team: (game, list) => void others.set(game, [...list]),
    seen: recent,
    others: (game) => others.get(game),
    noted: (game) => noted.get(game),
    note: (game, list) => void noted.set(game, [...list]),
    unboundSince(game) {
      const since = unbound.get(game) ?? now();
      unbound.set(game, since);
      return since;
    },
    connected: (game) => void unbound.delete(game),
  };
}

/** The Studio operations a moment uses, for one game; each may throw unless it says otherwise. */
export interface MomentOps {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<unknown>;
  signal: AbortSignal;
  /** On a Mac, where the agent can look at Studio with `app_look`. */
  mac: boolean;
  game: string;
  /** The game's folder; undefined when Genex hasn't said it. */
  folder: string | undefined;
  /** Whether Studio is installed and Genex has set it up. */
  setUp(): Promise<boolean>;
  /** Whether the game builds in a Roblox place. */
  linked(): Promise<boolean>;
  /** Whether the game's helper is connected now. */
  bound(): boolean;
  /** Whether Studio's process runs; false when that can't be told. */
  running(): Promise<boolean>;
  /** Whether Genex opened Studio a moment ago. */
  starting(): Promise<boolean>;
  /** The game's helper, asked through the link. */
  ask: HelperAsk;
  /** Whether Studio's MCP server lists the game's Studio within `timeoutMs`. */
  listed(timeoutMs: number): Promise<boolean>;
  /** Sends the script sync's pending file changes to Studio, within `timeoutMs`. */
  flush(timeoutMs: number): Promise<void>;
  /** Reconciles Studio's scripts with the folder's `src/` (after a restore the restored files win); whether it ran to its end. */
  reapply(options?: ReconcileOptions): Promise<boolean>;
  /** Opens the game's place in Studio, or brings it forward. */
  open(): Promise<{ opened: boolean; message: string }>;
  /** The game's place as the chat names it. */
  placeName(): Promise<string>;
  /** Studio's viewport picture, base64; null when it couldn't be taken. */
  shot(timeoutMs: number): Promise<{ data: string } | null>;
  /** The agent's own marks, as believed now. */
  marks(): Promise<AgentMarks>;
  /** Runs Genex's own changes in Studio with the agent's busy mark around them, so they never read as the person's. */
  asAgent<T>(work: () => Promise<T>): Promise<T>;
  watch: StudioWatch;
}

/** Waits `ms` unless the call was stopped; whether it may go on. */
async function paused(ops: MomentOps, ms: number): Promise<boolean> {
  if (ops.signal.aborted) return false;
  await ops.sleep(ms, ops.signal).catch(() => undefined);
  return !ops.signal.aborted;
}

const MESSAGE = { Stopped: "Genex stopped waiting before the place was saved" } as const;

/** Waits for `work` at most `ms` on the moment's clock; the work goes on after. Never throws. */
async function within(ops: MomentOps, work: Promise<unknown>, ms: number): Promise<void> {
  const waited = new AbortController();
  await Promise.race([work.catch(() => undefined), ops.sleep(ms, waited.signal).catch(() => undefined)]);
  waited.abort();
}

/** Whether the helper answered with its own `unsupported`: this Studio can't do it at all. */
const unsupported = (error: unknown) =>
  error instanceof HelperLinkError &&
  error.code === HelperLinkFailure.Answered &&
  error.helperCode === HelperErrorCode.Unsupported;

const notBound = (error: unknown) => error instanceof HelperLinkError && error.code === HelperLinkFailure.NotBound;

/** A part's file as the host's save points name it. */
const partFile = (name: string) => [...PLACE_FOLDER, name].join("/");

/** How long the export may take at this moment: a chat message's short wait, or a run's and a restore's longer one. */
function exportLimit(hook: HookContext): number {
  return hook.on === HookEvent.RestoreBefore || inRun(hook) ? RUN_EXPORT_MAX_MS : PLACE_EXPORT_MAX_MS;
}

/** The place saved into the game folder: the scripts flushed to Studio first, then the export. */
async function savePlace(ops: MomentOps, exportMs: number): Promise<SaveRead> {
  if (!(await ops.linked())) return { outcome: PlaceSave.NotLinked };
  if (!ops.folder || !ops.bound()) return { outcome: PlaceSave.NotConnected };
  // A file change still on its way to Studio would leave the export older than the scripts.
  await within(ops, ops.flush(FLUSH_MAX_MS), FLUSH_MAX_MS);
  // Stopped (the host's step limit passed): its snapshot may be taken now, so nothing lands after it.
  if (ops.signal.aborted) return { outcome: PlaceSave.Failed, why: MESSAGE.Stopped };
  try {
    const exported = await exportPlace(ops.ask, ops.folder, { timeoutMs: exportMs, signal: ops.signal });
    const large = exported.parts.filter((part) => part.bytes > SAVE_POINT_FILE_MAX_BYTES).map((part) => part.name);
    return { outcome: PlaceSave.Saved, written: exported.written.length, large: large.map(partFile) };
  } catch (error) {
    if (notBound(error)) return { outcome: PlaceSave.NotConnected };
    const why = errorMessage(error);
    return unsupported(error) ? { outcome: PlaceSave.Unsupported, why } : { outcome: PlaceSave.Failed, why };
  }
}

/** Who else is in the place: what the helper last said, else asked now; null when it can't say. */
async function othersIn(ops: MomentOps): Promise<string[] | null> {
  if (!ops.bound()) return null;
  const known = ops.watch.others(ops.game);
  if (known) return known;
  try {
    const answer = await ops.ask(HelperMessage.Team, {}, { timeoutMs: TEAM_ASK_MS });
    ops.watch.team(ops.game, answer.others);
    return answer.others;
  } catch {
    return null;
  }
}

/** `save-place` at a checkpoint or before a restore. */
export async function savePlaceAt(ops: MomentOps, hook: HookContext): Promise<HookAnswer> {
  const restoring = hook.on === HookEvent.RestoreBefore;
  const others = restoring ? ((await othersIn(ops)) ?? []) : [];
  return saveAnswer(await savePlace(ops, exportLimit(hook)), hook, others);
}

/**
 * Reconciles the restored scripts, the restored files winning, waiting at most
 * {@link REAPPLY_WAIT_MS} (the reconcile goes on after); its wait is cleared only once it ran to
 * its end, so one that failed is still a restore at the next connection. Never throws.
 */
async function reapplyWithin(ops: MomentOps, folder: string): Promise<void> {
  const reapplied = ops.reapply({ restored: true }).then(async (ran) => {
    if (ran) await clearPendingScripts(folder);
  });
  await within(ops, reapplied, REAPPLY_WAIT_MS);
}

/**
 * The restored export loaded into Studio, or left for the helper's next connection. Git put back
 * `src/` and the scripts' record together, so whatever happens to the load, the restored scripts
 * must win over Studio's newer ones: their reconcile runs now, or waits (`pending-scripts.json`)
 * for the next connection, never as an ordinary reconcile that would copy Studio's back.
 */
async function loadRestored(ops: MomentOps, folder: string): Promise<LoadRead> {
  await writePendingScripts(folder, ops.now());
  const exported = await readManifest(folder);
  if (!ops.bound()) {
    if (!exported) return { outcome: PlaceLoad.NoExport };
    await writePendingLoad(folder, ops.now());
    return { outcome: PlaceLoad.Pending };
  }
  if (!exported) {
    await ops.asAgent(() => reapplyWithin(ops, folder));
    return { outcome: PlaceLoad.NoExport };
  }
  try {
    await ops.asAgent(() => loadPlace(ops.ask, folder, { timeoutMs: PLACE_LOAD_MAX_MS }));
  } catch (error) {
    if (notBound(error)) {
      await writePendingLoad(folder, ops.now());
      return { outcome: PlaceLoad.Pending };
    }
    await ops.asAgent(() => reapplyWithin(ops, folder));
    return { outcome: PlaceLoad.Failed, why: errorMessage(error) };
  }
  await clearPendingLoad(folder);
  await ops.asAgent(() => reapplyWithin(ops, folder));
  return { outcome: PlaceLoad.Loaded };
}

/** `load-place` after a restore: never blocks, and a Stop never cuts it (`restore.after` outlives it). */
export async function loadPlaceAt(ops: MomentOps): Promise<HookAnswer> {
  if (!(await ops.linked()) || !ops.folder) return {};
  try {
    return loadAnswer(await loadRestored(ops, ops.folder));
  } catch (error) {
    return loadAnswer({ outcome: PlaceLoad.Failed, why: errorMessage(error) });
  }
}

/** Whether the connected helper answers a ping within {@link STUDIO_PING_MS}. */
async function pings(ops: MomentOps): Promise<boolean> {
  try {
    await ops.ask(HelperMessage.Activity, {}, { timeoutMs: STUDIO_PING_MS });
    return true;
  } catch {
    return false;
  }
}

/** Where an unconnected game's Studio stands: starting, gone, or open without the place (after the reconnect wait). */
async function unconnected(ops: MomentOps): Promise<StudioHealth> {
  if (await ops.starting().catch(() => false)) return StudioHealth.Starting;
  if (!(await ops.running().catch(() => false))) return StudioHealth.Gone;
  const since = ops.watch.unboundSince(ops.game);
  return ops.now() - since < RECONNECT_WAIT_MS ? StudioHealth.Connecting : StudioHealth.NotOpen;
}

/** Where the game's Studio stands for a health check. */
async function healthOf(ops: MomentOps): Promise<StudioHealth> {
  if (!(await ops.setUp())) return StudioHealth.NotSetUp;
  if (!(await ops.linked())) return StudioHealth.NoPlace;
  if (!ops.bound()) return unconnected(ops);
  ops.watch.connected(ops.game);
  if (!(await pings(ops))) return StudioHealth.Silent;
  return (await ops.listed(STUDIO_LIST_MS).catch(() => false)) ? StudioHealth.Answers : StudioHealth.Unlisted;
}

/** `studio-state` at `health`. */
export async function studioStateAt(ops: MomentOps): Promise<HookAnswer> {
  return healthAnswer(await healthOf(ops), ops.mac);
}

/** `team-note` at a turn's start: who else is in the place, when that changed. */
export async function teamNoteAt(ops: MomentOps): Promise<HookAnswer> {
  const others = await othersIn(ops);
  const answer = teamAnswer(others, ops.watch.noted(ops.game));
  if (others) ops.watch.note(ops.game, others);
  return answer;
}

/** Studio's viewport picture within `ms`; none when the helper isn't connected or the picture failed. */
async function viewport(ops: MomentOps, ms: number): Promise<HookAnswer> {
  if (!ops.bound() || ms <= 0) return {};
  return shotsAnswer(await ops.shot(Math.min(ms, HERO_SHOT_MS)).catch(() => null));
}

/** `hero-shots` at a checkpoint: a run's save point keeps the viewport's picture; a chat's takes none. */
export async function heroShotsAt(ops: MomentOps, hook: HookContext): Promise<HookAnswer> {
  return inRun(hook) ? viewport(ops, HERO_SHOT_MS) : {};
}

/** `hero-shots` as the viewport observer: the picture within the time Genex gives, less what keeping it takes. */
export async function viewportStill(ops: MomentOps, withinMs: number): Promise<HookAnswer> {
  return viewport(ops, withinMs - OBSERVE_MARGIN_MS);
}

/** Waits until the game's helper connects, up to {@link OPEN_WAIT_MS}; whether it did. */
async function untilConnected(ops: MomentOps): Promise<boolean> {
  const ends = ops.now() + OPEN_WAIT_MS;
  while (!ops.bound()) {
    if (ops.now() >= ends || !(await paused(ops, OPEN_POLL_MS))) return ops.bound();
  }
  return true;
}

/** A run's start, read: Studio connected for the place, opened now when it wasn't. */
async function runStart(ops: MomentOps): Promise<StartRead> {
  if (!(await ops.setUp())) return { outcome: RunStart.NotSetUp };
  if (!(await ops.linked())) return { outcome: RunStart.NoPlace };
  if (ops.bound()) return { outcome: (await pings(ops)) ? RunStart.Ready : RunStart.Silent };
  if (ops.signal.aborted) return { outcome: RunStart.Stopped };
  let opened: { opened: boolean; message: string };
  try {
    opened = await ops.open();
  } catch (error) {
    return { outcome: RunStart.OpenFailed, why: errorMessage(error) };
  }
  if (!(await untilConnected(ops))) {
    if (ops.signal.aborted) return { outcome: RunStart.Stopped };
    if (!opened.opened && !(await ops.running().catch(() => false)))
      return { outcome: RunStart.OpenFailed, why: opened.message };
    return { outcome: RunStart.NotConnected, minutes: OPEN_WAIT_MS / MINUTE_MS };
  }
  if (!(await pings(ops))) return { outcome: RunStart.Silent };
  return { outcome: RunStart.Opened, place: await ops.placeName() };
}

/** `open-for-run` at a run's start. */
export async function openForRun(ops: MomentOps): Promise<HookAnswer> {
  return startAnswer(await runStart(ops), ops.mac);
}

/**
 * The Studio lock's probe: whether the person worked in Studio within {@link PERSON_ACTIVE_MS}, by
 * the helper's reports, leaving out what the agent's own marks cover. No helper connected: nobody.
 */
export async function personActive(ops: MomentOps): Promise<boolean> {
  const seen = ops.watch.seen(ops.game);
  if (!seen.length) return false;
  const now = ops.now();
  const marks = await ops.marks();
  return seen.some((at) => !agentsAt(marks, at, now));
}
