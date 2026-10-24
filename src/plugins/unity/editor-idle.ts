/**
 * Closing a Unity editor Genex opened for a run once nobody uses it. Unity holds gigabytes of
 * memory for as long as it runs, and an editor a run opened is otherwise left open for good. Only
 * that editor is ever closed, and only when all of these hold:
 *
 * - Genex itself opened it at the run's start (`open-for-run`); one already open was the person's.
 * - The run ended (`run.end`), and no other run started on it since.
 * - The plugin's {@link CLOSE_IDLE_SETTING} is on (it is unless the person turned it off).
 * - For {@link IDLE_CLOSE_MS} no agent sent the editor a command through the connector, which marks
 *   each one it sends ({@link agentUseMarker}).
 * - The person never took it over: it was never seen as the app in front, and its undo history did
 *   not move between two looks with no agent command between them. One taken over is never closed.
 * - It is not playing, compiling or reloading, its main thread answers, no open scene has unsaved
 *   work, and its assets save cleanly first.
 *
 * The backend looks every {@link IDLE_LOOK_MS} once a run ended ({@link closeIdleEditors}); each
 * game's record (`launched/<game>.json` in the plugin's storage) is forgotten as soon as one of
 * these can no longer hold.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../../substrate/fsx.ts";
import { agentPlayFolder } from "./agent-play.ts";
import { type EditorDeps, editorCommand, editorRuns, endEditor, openScenes, saveWork } from "./editor-life.ts";
import { editorStatus, PLAY_STOPPED } from "./pipeline.ts";

/** How long an editor Genex opened for a run sits unused after it before Genex closes it. */
export const IDLE_CLOSE_MS = 15 * MINUTE_MS;
/** How often the backend looks at the editors it may close. */
export const IDLE_LOOK_MS = 30 * SECOND_MS;
/** The plugin's setting that turns the closing on or off, as its manifest declares it. Wire value. */
export const CLOSE_IDLE_SETTING = "close-idle-editor";
/** The folder in the plugin's storage holding a record per game whose editor Genex opened for a run. */
const LAUNCHED_FOLDER = "launched";
/** The file the editor connector touches, in its own folder, each time it sends the editor a command. */
const AGENT_USE_FILE = "agent-used.json";
/** A game id as Genex names a game's record: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const JSON_EXTENSION = ".json";

/** The Pipeline command a look runs. Wire value: Pipeline's own. */
const Command = { Eval: "eval" } as const;

/** The C# a look runs: whether Unity is the app in front, and where its undo history stands. */
const LOOK_CODE =
  "return new { active = UnityEditorInternal.InternalEditorUtility.isApplicationActive, undo = UnityEditor.Undo.GetCurrentGroup() };";

/** A game's record: the project Genex opened, when its run ended, and what the last look saw. */
interface Launched {
  root: string;
  endedAt?: number;
  /** The undo group and the time of the last look, once one was taken after the run. */
  undo?: number;
  lookedAt?: number;
}

/** What a look reaches: the editor, the computer's processes and the clock. */
export interface IdleDeps extends EditorDeps {
  now: () => Date;
}

const recordFile = (storage: string, game: string): string | null =>
  GAME_ID.test(game) ? path.join(storage, LAUNCHED_FOLDER, `${game}${JSON_EXTENSION}`) : null;

async function readLaunched(storage: string, game: string): Promise<Launched | undefined> {
  const file = recordFile(storage, game);
  const record = file ? await readJsonIfExists<unknown>(file).catch(() => null) : null;
  if (!isJsonObject(record) || typeof record.root !== "string") return undefined;
  const number = (value: unknown) => (typeof value === "number" ? value : undefined);
  return {
    root: record.root,
    endedAt: number(record.endedAt),
    undo: number(record.undo),
    lookedAt: number(record.lookedAt),
  };
}

async function writeLaunched(storage: string, game: string, record: Launched): Promise<void> {
  const file = recordFile(storage, game);
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteJson(file, record);
}

async function forgetLaunched(storage: string, game: string): Promise<void> {
  const file = recordFile(storage, game);
  if (file) await rm(file, { force: true });
}

/** Remembers that Genex opened the game's editor for a run, which then goes on. */
export const rememberLaunch = (storage: string, game: string, root: string): Promise<void> =>
  writeLaunched(storage, game, { root });

/** A run starts on an editor already open: one Genex opened for an earlier run is in use again. */
export async function runGoesOn(storage: string, game: string, root: string): Promise<void> {
  const record = await readLaunched(storage, game);
  if (record?.root === root) await writeLaunched(storage, game, { root });
}

/** The run ended: its editor's idle time starts now, unless the person turned closing off. */
export async function runEnded(storage: string, game: string, now: number, closeIdle: boolean): Promise<void> {
  const record = await readLaunched(storage, game);
  if (!record) return;
  if (!closeIdle) return forgetLaunched(storage, game);
  await writeLaunched(storage, game, { root: record.root, endedAt: now });
}

/** What the connector of one game notes as it sends the editor a command: the time, in its own folder. */
export function agentUseMarker(folder: string, now: () => number = Date.now): () => Promise<void> {
  return async () => {
    await mkdir(folder, { recursive: true });
    await atomicWriteJson(path.join(folder, AGENT_USE_FILE), { at: now() });
  };
}

/** When an agent last sent the game's editor a command, if one ever did. */
async function lastAgentUse(storage: string, game: string): Promise<number | undefined> {
  const folder = agentPlayFolder(storage, game);
  const marker = folder ? await readJsonIfExists<unknown>(path.join(folder, AGENT_USE_FILE)).catch(() => null) : null;
  return isJsonObject(marker) && typeof marker.at === "number" ? marker.at : undefined;
}

/** What a look at an idle editor came to. Wire values: tests read them. */
export const IdleLook = {
  /** Nothing to do yet: the run goes on, the editor can't say, or it has not sat long enough. */
  Waits: "waits",
  /** The editor is gone, or the person took it over: its record is forgotten. */
  Forgotten: "forgotten",
  /** Genex closed it. */
  Closed: "closed",
} as const;
export type IdleLook = (typeof IdleLook)[keyof typeof IdleLook];

/** The editor's own answer to {@link LOOK_CODE}, or undefined when it gave none. */
async function lookInside(root: string, deps: IdleDeps): Promise<{ active: boolean; undo: number } | undefined> {
  const answer = await editorCommand(root, deps, Command.Eval, { code: LOOK_CODE });
  if (!answer.ok || !isJsonObject(answer.result)) return undefined;
  const { active, undo } = answer.result;
  return typeof active === "boolean" && typeof undo === "number" ? { active, undo } : undefined;
}

/** Whether the editor is doing something of its own: playing, compiling or reloading its scripts. */
async function editorBusy(root: string, deps: IdleDeps): Promise<boolean> {
  const look = await editorStatus(root, deps.pipeline);
  if (!look.ok) return true;
  const playing = look.result.playMode !== "" && look.result.playMode !== PLAY_STOPPED;
  return playing || look.result.compiling || look.result.reloading;
}

/** Whether the person took the editor over since the last look: it is in front, or its undo history moved with no agent command between. */
function personTookIt(record: Launched, inside: { active: boolean; undo: number }, agentAt: number): boolean {
  if (inside.active) return true;
  const looked = record.undo !== undefined && record.lookedAt !== undefined;
  return looked && inside.undo !== record.undo && !(agentAt > (record.lookedAt ?? 0));
}

/** One game's editor: forgotten, left to wait, or closed, as the module's rules say. */
export async function lookAtIdle(storage: string, game: string, deps: IdleDeps): Promise<IdleLook> {
  const record = await readLaunched(storage, game);
  if (record?.endedAt === undefined) return IdleLook.Waits;
  const { root, endedAt } = record;
  if (!(await editorRuns(root, deps))) {
    await forgetLaunched(storage, game);
    return IdleLook.Forgotten;
  }
  if (await editorBusy(root, deps)) return IdleLook.Waits;
  const inside = await lookInside(root, deps);
  if (!inside) return IdleLook.Waits;
  const now = deps.now().getTime();
  const agentAt = (await lastAgentUse(storage, game)) ?? 0;
  if (personTookIt(record, inside, agentAt)) {
    await forgetLaunched(storage, game);
    return IdleLook.Forgotten;
  }
  await writeLaunched(storage, game, { root, endedAt, undo: inside.undo, lookedAt: now });
  return now - Math.max(endedAt, agentAt) < IDLE_CLOSE_MS ? IdleLook.Waits : closeIfClean(storage, game, root, deps);
}

/** Closes the editor when nothing in it is unsaved and its assets save; unsaved work is the person's, so the record goes. */
async function closeIfClean(storage: string, game: string, root: string, deps: IdleDeps): Promise<IdleLook> {
  const scenes = await openScenes(root, deps);
  if (!scenes.ok) return IdleLook.Waits;
  if (scenes.result.some((scene) => scene.dirty)) {
    await forgetLaunched(storage, game);
    return IdleLook.Forgotten;
  }
  const saved = await saveWork(root, deps);
  if (saved.trouble) return IdleLook.Waits;
  if (!(await endEditor(root, deps))) return IdleLook.Waits;
  await forgetLaunched(storage, game);
  return IdleLook.Closed;
}

/** Looks at every editor Genex opened for a run, one game at a time; answers what each look came to, by game. */
export async function closeIdleEditors(storage: string, deps: IdleDeps): Promise<Record<string, IdleLook>> {
  const names = await readdir(path.join(storage, LAUNCHED_FOLDER)).catch(() => [] as string[]);
  const looks: Record<string, IdleLook> = {};
  for (const name of names.filter((file) => file.endsWith(JSON_EXTENSION))) {
    const game = name.slice(0, -JSON_EXTENSION.length);
    looks[game] = await lookAtIdle(storage, game, deps).catch(() => IdleLook.Waits);
  }
  return looks;
}
