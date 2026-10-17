/**
 * Asking the person's own Godot editor to save or reload, through the Genex addon's editor plugin
 * (`addon/genex/editor_bridge.gd`). Both sides meet in the project's `.godot/genex/` folder, Godot's
 * own cache (never shared, never in a save point): the editor writes a heartbeat there each second,
 * Genex leaves an ask as `ask-<id>.json`, and the editor answers it as `answer-<id>.json`. Every file
 * appears whole (written beside, then renamed); nothing is written through a link. No editor, or an
 * editor whose heartbeat stopped, is asked nothing.
 */
import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { writeFileNoFollow } from "../../substrate/fsx.ts";

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
