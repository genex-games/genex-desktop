/**
 * How the Roblox plugin's handlers answer at Genex's moments (`context.hook`): the pure builders of
 * `{block, note, pending, images}` and their words, which the person and the lead read as written.
 * A run (`hook.runId`) and a chat answer by different policies:
 *
 * | Handler at its moment | In a run | In a chat |
 * |---|---|---|
 * | `save-place` at `checkpoint.before` | Studio not connected, or the export failed: block; saved: nothing | a note of what was saved or why not |
 * | `save-place` at `restore.before` | the export failed: block (nothing goes back); others in the place: a note | same |
 * | `load-place` at `restore.after` | loaded: nothing; Studio closed, no export, or a failed load: a note | same |
 * | `studio-state` at `health` | answers: nothing; starting, connecting, silent (a dialog may be open) or unlisted: pending; gone, not open, no place or not set up: block | same |
 * | `studio-crash-note` at `crash` | a note asking the person to reopen Studio | same |
 * | `team-note` at `turn.start` | a note when the others in the place changed | same |
 * | `hero-shots` at `checkpoint.after` | the viewport's picture | nothing |
 * | `open-for-run` at `run.prepare` | Studio connected for the place: nothing (opened now: a note); otherwise block with the step | — |
 * | `studio-activity` as the lock's probe | the person's activity in Studio, the agent's own discounted | same |
 *
 * Helper refusals that say Studio has no way to export a place (`unsupported`) never block: the
 * save point then holds the scripts only, and the note says so.
 */
import type { HookAnswer, HookContext } from "../../shared/plugin-hooks.ts";
import { HookEvent } from "../../shared/plugin-hooks.ts";

/** How many names a note lists before "and N more". */
const NAMED = 3;
/** The picture of Studio's viewport, as a moment hands it back. */
const VIEWPORT_IMAGE = "viewport";

/** How a save of the place went. Never rename a value. */
export const PlaceSave = {
  /** The game builds in no Roblox place. */
  NotLinked: "not-linked",
  /** No Genex helper in Studio is connected for the game. */
  NotConnected: "not-connected",
  Saved: "saved",
  /** Studio has no way to export the place: the scripts alone are saved. */
  Unsupported: "unsupported",
  Failed: "failed",
} as const;
export type PlaceSave = (typeof PlaceSave)[keyof typeof PlaceSave];

/** A save of the place, read: what it wrote and which parts save points leave out, or why not. */
export type SaveRead =
  | { outcome: typeof PlaceSave.NotLinked | typeof PlaceSave.NotConnected }
  | { outcome: typeof PlaceSave.Saved; written: number; large: readonly string[] }
  | { outcome: typeof PlaceSave.Unsupported | typeof PlaceSave.Failed; why: string };

/** How a load of the place went. Never rename a value. */
export const PlaceLoad = {
  NotLinked: "not-linked",
  Loaded: "loaded",
  /** Studio wasn't reachable: the load waits for the helper's next connection. */
  Pending: "pending",
  /** The folder holds no export: the scripts alone went back. */
  NoExport: "no-export",
  Failed: "failed",
} as const;
export type PlaceLoad = (typeof PlaceLoad)[keyof typeof PlaceLoad];

/** A load of the place, read. */
export type LoadRead =
  | {
      outcome:
        | typeof PlaceLoad.NotLinked
        | typeof PlaceLoad.Loaded
        | typeof PlaceLoad.Pending
        | typeof PlaceLoad.NoExport;
    }
  | { outcome: typeof PlaceLoad.Failed; why: string };

/** Where the game's Studio stands for a health check. Never rename a value. */
export const StudioHealth = {
  Answers: "answers",
  /** Genex opened Studio a moment ago. */
  Starting: "starting",
  /** Studio runs; its helper hasn't connected for the game yet, within the reconnect wait. */
  Connecting: "connecting",
  /** The helper is connected but didn't answer a ping in time. */
  Silent: "silent",
  /** The helper answers, but Studio's MCP server doesn't list this Studio. */
  Unlisted: "unlisted",
  /** Studio isn't running. */
  Gone: "gone",
  /** Studio runs, but the game's place stayed unconnected past the reconnect wait. */
  NotOpen: "not-open",
  NoPlace: "no-place",
  NotSetUp: "not-set-up",
} as const;
export type StudioHealth = (typeof StudioHealth)[keyof typeof StudioHealth];

/** How a run's start found Studio. Never rename a value. */
export const RunStart = {
  Ready: "ready",
  /** Genex opened the place now, and its helper connected. */
  Opened: "opened",
  NotSetUp: "not-set-up",
  NoPlace: "no-place",
  /** The helper is connected but doesn't answer: a dialog may be open. */
  Silent: "silent",
  NotConnected: "not-connected",
  OpenFailed: "open-failed",
  Stopped: "stopped",
} as const;
export type RunStart = (typeof RunStart)[keyof typeof RunStart];

/** A run's start, read. */
export type StartRead =
  | { outcome: Exclude<RunStart, typeof RunStart.Opened | typeof RunStart.OpenFailed | typeof RunStart.NotConnected> }
  | { outcome: typeof RunStart.Opened; place: string }
  | { outcome: typeof RunStart.NotConnected; minutes: number }
  | { outcome: typeof RunStart.OpenFailed; why: string };

/** Names as a note lists them: the first few, then how many more. */
function names(list: readonly string[]): string {
  const shown = list.slice(0, NAMED).join(", ");
  return list.length > NAMED ? `${shown} and ${list.length - NAMED} more` : shown;
}

/** A failure's message, ending as a sentence does. */
function sentence(why: string): string {
  const text = why.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The words of every answer. The person and the lead read them as written. */
export const MOMENT_WORDS = {
  // A run's save point (the lead's `save_point` says "No save point: <reason>").
  NotConnectedRun:
    "Roblox Studio isn't connected for this game, so its place couldn't be saved. Open the place in Studio, then save again.",
  NotSavedRun: (why: string) => `Roblox Studio's place couldn't be saved: ${sentence(why)} Try again in a moment.`,
  // A chat's checkpoint.
  NotConnectedChat: "Roblox Studio isn't connected for this game, so this checkpoint holds the scripts only.",
  NotSavedChat: (why: string) =>
    `Roblox Studio's place wasn't saved (${why.trim()}), so this checkpoint holds the scripts only.`,
  Saved: (written: number) => `Saved Roblox Studio's place (${written} ${written === 1 ? "part" : "parts"} changed).`,
  ScriptsOnly: (why: string) =>
    `This Studio can't export its place (${why.trim()}), so save points hold the scripts only and Rewind brings back the scripts alone.`,
  LeftOut: (large: readonly string[]) =>
    `${names(large)} ${large.length === 1 ? "is" : "are"} larger than 50 MB, so save points leave ${large.length === 1 ? "it" : "them"} out and Rewind can't bring ${large.length === 1 ? "it" : "them"} back.`,
  // A restore.
  RestoreNotSaved: (why: string) =>
    `Genex couldn't save Roblox Studio's place first (${why.trim()}), so nothing went back. Try again in a moment.`,
  TeamRewind: (others: readonly string[]) =>
    `Others are in this place in Team Create (${names(others)}): going back also undoes their edits since then.`,
  Pending:
    "Roblox Studio isn't connected for this game, so its place goes back the next time Studio opens it; the scripts went back now.",
  NoExport: "This save point holds no saved place, so only the scripts went back.",
  LoadFailed: (why: string) =>
    `Roblox Studio couldn't load the saved place (${why.trim()}); the scripts went back, and the place stays as Studio has it.`,
  // Health.
  Starting: "Roblox Studio is starting; this chat goes on by itself when it answers.",
  Connecting: "Roblox Studio is open; waiting for the Genex helper in Studio to connect for this game.",
  DialogMayBeOpen: "Roblox Studio isn't answering; a dialog may be open in Studio.",
  LookHint: "Look at Studio with app_look (look only) to see what it asks, and tell the person; never click it.",
  Unlisted: "Roblox Studio's MCP server doesn't list this game's Studio yet.",
  Gone: "Roblox Studio isn't running: it crashed or was closed.",
  NotOpen: "Roblox Studio is open, but not with this game's place.",
  NoPlace: "This game isn't linked to a Roblox place. Choose one in the Roblox Studio panel.",
  NotSetUp: "Roblox Studio isn't set up for Genex yet. Finish the steps in the Roblox Studio panel.",
  // A crash.
  Crash:
    "Roblox Studio closed for this game. Reopen it with Open Studio in the Roblox Studio panel; Genex never closes or force-quits Studio.",
  // Team Create.
  Others: (others: readonly string[]) => `Also in this place in Team Create: ${names(others)}.`,
  Alone: "Nobody else is in this place in Team Create now.",
  // A run's start.
  Opened: (place: string) => `Opened ${place} in Roblox Studio for the Loop.`,
  NotConnected: (minutes: number) =>
    `Roblox Studio didn't connect for this game within ${minutes} minutes. Open its place in Studio, then start again.`,
  OpenFailed: (why: string) => `Roblox Studio couldn't be opened: ${sentence(why)}`,
  Stopped: "The run was stopped before Roblox Studio connected.",
} as const;

/** Whether a moment is part of a run (the runner's save points and restarts), not a chat's. */
export const inRun = (hook: HookContext | undefined): boolean => Boolean(hook?.runId);

/** Notes joined into one, or no note at all. */
function withNotes(answer: HookAnswer, ...notes: Array<string | undefined>): HookAnswer {
  const text = [answer.note, ...notes].filter(Boolean).join(" ");
  return text ? { ...answer, note: text } : answer;
}

/** What large parts add to an answer. */
const leftOut = (large: readonly string[]) => (large.length ? MOMENT_WORDS.LeftOut(large) : undefined);

/** A run's save point: blocked unless the place was saved (or can't ever be exported here). */
function runSave(read: SaveRead): HookAnswer {
  switch (read.outcome) {
    case PlaceSave.NotConnected:
      return { block: MOMENT_WORDS.NotConnectedRun };
    case PlaceSave.Failed:
      return { block: MOMENT_WORDS.NotSavedRun(read.why) };
    case PlaceSave.Unsupported:
      return { note: MOMENT_WORDS.ScriptsOnly(read.why) };
    case PlaceSave.Saved:
      return withNotes({}, leftOut(read.large));
    default:
      return {};
  }
}

/** A chat's checkpoint: never blocked; a note of what was saved or why not. */
function chatSave(read: SaveRead): HookAnswer {
  switch (read.outcome) {
    case PlaceSave.NotConnected:
      return { note: MOMENT_WORDS.NotConnectedChat };
    case PlaceSave.Failed:
      return { note: MOMENT_WORDS.NotSavedChat(read.why) };
    case PlaceSave.Unsupported:
      return { note: MOMENT_WORDS.ScriptsOnly(read.why) };
    case PlaceSave.Saved:
      return withNotes({}, read.written > 0 ? MOMENT_WORDS.Saved(read.written) : undefined, leftOut(read.large));
    default:
      return {};
  }
}

/** Before a restore: a failed save keeps everything as it is; others in the place are named. */
function restoreSave(read: SaveRead, others: readonly string[]): HookAnswer {
  const team = others.length ? MOMENT_WORDS.TeamRewind(others) : undefined;
  if (read.outcome === PlaceSave.Failed) return withNotes({ block: MOMENT_WORDS.RestoreNotSaved(read.why) }, team);
  if (read.outcome === PlaceSave.Unsupported) return withNotes({ note: MOMENT_WORDS.ScriptsOnly(read.why) }, team);
  if (read.outcome === PlaceSave.Saved) return withNotes({}, leftOut(read.large), team);
  return withNotes({}, team);
}

/** `save-place`'s answer: before a restore, or at a checkpoint by the run's or the chat's policy. */
export function saveAnswer(read: SaveRead, hook: HookContext, others: readonly string[] = []): HookAnswer {
  if (hook.on === HookEvent.RestoreBefore) return restoreSave(read, others);
  return inRun(hook) ? runSave(read) : chatSave(read);
}

/** `load-place`'s answer after a restore: quiet once loaded; anything else is a note (a restore's after step never blocks). */
export function loadAnswer(read: LoadRead): HookAnswer {
  switch (read.outcome) {
    case PlaceLoad.Pending:
      return { note: MOMENT_WORDS.Pending };
    case PlaceLoad.NoExport:
      return { note: MOMENT_WORDS.NoExport };
    case PlaceLoad.Failed:
      return { note: MOMENT_WORDS.LoadFailed(read.why) };
    default:
      return {};
  }
}

/** `studio-state`'s answer at `health`: quiet while Studio answers, pending while it may yet, blocked once it can't. */
export function healthAnswer(health: StudioHealth, mac: boolean): HookAnswer {
  switch (health) {
    case StudioHealth.Answers:
      return {};
    case StudioHealth.Starting:
      return { pending: MOMENT_WORDS.Starting };
    case StudioHealth.Connecting:
      return { pending: MOMENT_WORDS.Connecting };
    case StudioHealth.Silent: {
      // Only a Mac has app_look; the hint is for the agent reading why Studio waits.
      const words = mac ? `${MOMENT_WORDS.DialogMayBeOpen} ${MOMENT_WORDS.LookHint}` : MOMENT_WORDS.DialogMayBeOpen;
      return { pending: words, note: words };
    }
    case StudioHealth.Unlisted:
      return { pending: MOMENT_WORDS.Unlisted };
    case StudioHealth.Gone:
      return { block: MOMENT_WORDS.Gone };
    case StudioHealth.NotOpen:
      return { block: MOMENT_WORDS.NotOpen };
    case StudioHealth.NoPlace:
      return { block: MOMENT_WORDS.NoPlace };
    default:
      return { block: MOMENT_WORDS.NotSetUp };
  }
}

/** `studio-crash-note`'s answer: the person reopens Studio. Genex never closes or kills it. */
export const crashAnswer = (): HookAnswer => ({ note: MOMENT_WORDS.Crash });

/** Whether two lists of names hold the same people. */
const samePeople = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((name, index) => name === [...b].sort()[index]);

/**
 * `team-note`'s answer at a turn's start: who else is in the place, once each time that changes
 * (nobody the first time says nothing); unknown says nothing.
 */
export function teamAnswer(others: readonly string[] | null, before: readonly string[] | undefined): HookAnswer {
  if (others === null || samePeople(others, before ?? [])) return {};
  return { note: others.length ? MOMENT_WORDS.Others(others) : MOMENT_WORDS.Alone };
}

/** `open-for-run`'s answer at a run's start. */
export function startAnswer(read: StartRead, mac: boolean): HookAnswer {
  switch (read.outcome) {
    case RunStart.Ready:
      return {};
    case RunStart.Opened:
      return { note: MOMENT_WORDS.Opened(read.place) };
    case RunStart.NotSetUp:
      return { block: MOMENT_WORDS.NotSetUp };
    case RunStart.NoPlace:
      return { block: MOMENT_WORDS.NoPlace };
    case RunStart.Silent:
      return { block: mac ? `${MOMENT_WORDS.DialogMayBeOpen} ${MOMENT_WORDS.LookHint}` : MOMENT_WORDS.DialogMayBeOpen };
    case RunStart.NotConnected:
      return { block: MOMENT_WORDS.NotConnected(read.minutes) };
    case RunStart.OpenFailed:
      return { block: MOMENT_WORDS.OpenFailed(read.why) };
    default:
      return { block: MOMENT_WORDS.Stopped };
  }
}

/** The viewport's picture as a moment's image; nothing when none was taken. */
export function shotsAnswer(shot: { data: string } | null): HookAnswer {
  return shot ? { images: [{ name: VIEWPORT_IMAGE, data: shot.data }] } : {};
}

/** The Studio lock's probe: whether the person is working in Studio. Nothing unsaved is ever claimed: Studio doesn't say. */
export const probeAnswer = (personActive: boolean) => ({ personActive });
