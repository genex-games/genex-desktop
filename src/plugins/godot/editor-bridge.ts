/**
 * Asking the person's own Godot editor to save or reload, through the Genex addon's editor plugin
 * (`addon/genex/editor_bridge.gd`). Both sides meet in the project's `.godot/genex/` folder, Godot's
 * own cache (never shared, never in a save point): the editor writes a heartbeat there each second,
 * Genex leaves an ask as `ask-<id>.json`, and the editor answers it as `answer-<id>.json`. Every file
 * appears whole (written beside, then renamed); nothing is written through a link. No editor, or an
 * editor whose heartbeat stopped, is asked nothing.
 *
 * The same folder carries play-time AI while a scene plays in that editor (`godotAiChannel`): the
 * game's `genex_ai.gd` leaves each `ai` line as `ai-in-<rid>.json`, Studio takes them out, beats
 * `ai-relay.json` so the game knows it is relayed, and hands the answers back as `ai-out-<order>.json`.
 */
import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { PLAY_AI_MAX_LINE_CHARS, type PlayAiOutgoing } from "../../shared/play-protocol.ts";
import { readRegularFile, writeFileNoFollow } from "../../substrate/fsx.ts";

/** The bridge's folder in a project. */
export const BRIDGE_FOLDER = ".godot/genex";
const HEARTBEAT = "editor.json";
const ASK_PREFIX = "ask-";
const ANSWER_PREFIX = "answer-";
const PARTIAL_SUFFIX = ".partial";
/** A heartbeat older than this is an editor that closed or stopped answering. */
export const HEARTBEAT_FRESH_MS = 5 * SECOND_MS;
/** How long an ask waits for the editor's answer. */
export const ANSWER_WAIT_MS = 15 * SECOND_MS;
/** How often an ask looks for the answer. */
const ANSWER_POLL_MS = 100;
/** An ask's id: as many random bytes, in hex. */
const ASK_ID_BYTES = 8;
/** A line the game queued for Studio: `ai-in-<rid>.json`, the rid as Play Protocol bounds it. */
const AI_IN = /^ai-in-([A-Za-z0-9_-]{8,100})\.json$/;
/** An answer Studio hands the game: `ai-out-<order>.json`, the order sorting as they were given. */
const AI_OUT_PREFIX = "ai-out-";
/** Studio's beat while it relays a playing game's AI, which the game reads before it queues a line. */
export const AI_RELAY_BEAT = "ai-relay.json";
/** The most lines one pull takes out; the rest wait for the next. */
export const AI_PULL_MAX_FILES = 8;
/** The largest line file read: a Play Protocol line's characters, each up to three UTF-8 bytes. */
const AI_LINE_MAX_BYTES = 3 * PLAY_AI_MAX_LINE_CHARS;
/** The digits of an answer's order: its clock reading and its count, zero-padded so names sort. */
const AI_OUT_STAMP_DIGITS = 15;
const AI_OUT_COUNT_DIGITS = 6;

/** What Genex asks the editor: save everything open, or reload what changed on disk. */
export const EditorOp = { Save: "save", Reload: "reload" } as const;
export type EditorOp = (typeof EditorOp)[keyof typeof EditorOp];

/** The editor's heartbeat: when it beat, whether the person plays a scene, and their unsaved scripts. */
export type Heartbeat = { at: number; playing: boolean; unsavedScripts: number };

/** The time an ask runs on; tests hand in their own. */
export type BridgeClock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const count = (value: unknown): number => (Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0);

/** The bridge folder, or null when it or `.godot` is a link or isn't a folder. */
async function bridgeFolder(project: string): Promise<string | null> {
  for (const part of [".godot", BRIDGE_FOLDER]) {
    const info = await lstat(path.join(project, part)).catch(() => null);
    if (!info?.isDirectory()) return null;
  }
  return path.join(project, BRIDGE_FOLDER);
}

/** A JSON file of the bridge, or null when it is missing, a link or not JSON. */
async function readBridgeFile(file: string): Promise<unknown> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** The editor that has the project open now, by a heartbeat fresher than {@link HEARTBEAT_FRESH_MS}; null without one. */
export async function liveEditor(project: string, clock: BridgeClock): Promise<Heartbeat | null> {
  const folder = await bridgeFolder(project);
  const beat = folder ? await readBridgeFile(path.join(folder, HEARTBEAT)) : null;
  if (!isRecord(beat) || typeof beat.at !== "number") return null;
  if (Math.abs(clock.now() - beat.at) > HEARTBEAT_FRESH_MS) return null;
  return { at: beat.at, playing: beat.playing === true, unsavedScripts: count(beat.unsavedScripts) };
}

/** A whole file in the bridge folder: written beside, then renamed into place. */
async function writeWhole(folder: string, name: string, text: string): Promise<void> {
  const file = path.join(folder, name);
  await writeFileNoFollow(`${file}${PARTIAL_SUFFIX}`, text);
  await rename(`${file}${PARTIAL_SUFFIX}`, file);
}

/**
 * Asks the editor that has the project open to `op`, and answers what it said; null when no editor
 * has it open, or none answered within {@link ANSWER_WAIT_MS} (the ask is then taken back).
 */
export async function askEditor(
  project: string,
  op: EditorOp,
  clock: BridgeClock,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const folder = await bridgeFolder(project);
  if (!folder || !(await liveEditor(project, clock))) return null;
  const id = randomBytes(ASK_ID_BYTES).toString("hex");
  const ask = `${ASK_PREFIX}${id}.json`;
  const answer = path.join(folder, `${ANSWER_PREFIX}${id}.json`);
  await writeWhole(folder, ask, JSON.stringify({ op }));
  const until = clock.now() + ANSWER_WAIT_MS;
  while (clock.now() < until && !signal?.aborted) {
    const said = await readBridgeFile(answer);
    if (isRecord(said)) {
      await rm(answer, { force: true });
      return said;
    }
    await clock.sleep(ANSWER_POLL_MS, signal).catch(() => {});
  }
  await rm(path.join(folder, ask), { force: true });
  return null;
}

/** How many scripts the editor said it still holds unsaved. */
export const unsavedScriptsOf = (answer: Record<string, unknown>): number => count(answer.unsavedScripts);

/** A line file's content as JSON, or undefined: not a plain file of the folder, over the cap or not JSON. */
async function readLineFile(file: string): Promise<unknown> {
  const bytes = await readRegularFile(file, AI_LINE_MAX_BYTES).catch(() => null);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Takes one line file out of the folder: a plain file or a link (the link alone), never a folder. */
async function takeOut(file: string): Promise<void> {
  const info = await lstat(file).catch(() => null);
  if (info?.isFile() || info?.isSymbolicLink()) await rm(file, { force: true });
}

/** The lines queued in the folder, oldest first, at most {@link AI_PULL_MAX_FILES}, each taken out. */
async function takeLines(folder: string): Promise<unknown[]> {
  const names = (await readdir(folder)).filter((name) => AI_IN.test(name)).sort();
  const lines: unknown[] = [];
  for (const name of names.slice(0, AI_PULL_MAX_FILES)) {
    const file = path.join(folder, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() && !info?.isSymbolicLink()) continue;
    const line = info.isFile() ? await readLineFile(file) : undefined;
    await takeOut(file);
    // A line is the game's only when it names the rid its file does.
    if (isRecord(line) && !Array.isArray(line) && line.rid === AI_IN.exec(name)?.[1]) lines.push(line);
  }
  return lines;
}

/**
 * The play-time AI channel of the editor that has the Godot project at `project` open: Studio's
 * relay (`main/game-ai/bridge-editor.ts`) pulls the lines the playing game queued and pushes the
 * answers back. No play while no scene plays in an editor with a fresh heartbeat.
 */
export function godotAiChannel(project: string, clock: BridgeClock) {
  let count = 0;
  const outName = () => {
    count += 1;
    const stamp = String(Math.max(0, Math.floor(clock.now()))).padStart(AI_OUT_STAMP_DIGITS, "0");
    return `${AI_OUT_PREFIX}${stamp}-${String(count).padStart(AI_OUT_COUNT_DIGITS, "0")}.json`;
  };
  return {
    /** The lines the playing game queued since the last pull, taken out; null while no scene plays. */
    async pull(_signal: AbortSignal): Promise<unknown[] | null> {
      const folder = await bridgeFolder(project);
      const editor = folder ? await liveEditor(project, clock) : null;
      if (!folder || !editor?.playing) return null;
      await writeWhole(folder, AI_RELAY_BEAT, JSON.stringify({ at: clock.now() }));
      return takeLines(folder);
    },
    /** Hands the playing game its answers, each a whole file; false when the folder is not there to take them. */
    async push(items: readonly PlayAiOutgoing[], _signal: AbortSignal): Promise<boolean> {
      const folder = await bridgeFolder(project);
      if (!folder) return false;
      for (const item of items) await writeWhole(folder, outName(), JSON.stringify(item));
      return true;
    },
  };
}
