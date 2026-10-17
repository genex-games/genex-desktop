/**
 * Stills of a Godot game: Genex's capture script plays a scene for a moment in a window off every
 * screen and saves what each camera in the `genex_shot` group sees (else the scene's own camera),
 * into a folder of the job's own that is removed once the pictures are read. They answer the
 * agent's `screenshot`, a run's save point (`checkpoint.after`) and the viewport observer the
 * reviewer and Live read.
 */
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import {
  HOOK_IMAGE_MAX_BYTES,
  HOOK_IMAGES_MAX,
  HOOK_RECORDING_MAX,
  type HookAnswer,
} from "../../shared/plugin-hooks.ts";
import { isInside } from "../../substrate/paths.ts";
import type { GodotInstall } from "./find-godot.ts";
import { type SavedShot, savedShots } from "./godot-output.ts";
import { type GodotRunner, type PlayRequest, playCall } from "./godot-run.ts";
import { type KeyPress, keysEnd, PLAY_FPS, ShotCameras, type ShotAt } from "./play-input.ts";

/** The most stills one capture takes: a moment's pictures are capped at Genex's, and an agent needs few. */
export const MAX_STILLS = Math.min(4, HOOK_IMAGES_MAX);
const STILLS_FOLDER = "stills";
const SHOT_PREFIX = "shot";
const PNG = "image/png";
/** A picture's name as Genex keeps it: plain characters, at most 80. */
const NAME_CHARS = 80;
const NOT_NAME = /[^A-Za-z0-9 ._-]+/g;

/** One still: its camera's name (a recording's frame names its moment too) and the PNG's bytes as base64. */
export type Still = { name: string; data: string };

/** What a capture needs: how Godot runs, Genex's scripts and the plugin's storage, where its folder goes. */
export type StillsDeps = { run: GodotRunner; scripts: string; storage: string };

/**
 * What to capture of a scene (the main scene when empty): every camera's still at `at` (a frame, or
 * null for none), a recording of the first camera at `recording`'s frames, after `keys` pressed on
 * their timeline; `hero` lets the game move its hero shot itself.
 */
export type StillsRequest = {
  scene: string;
  at: number | null;
  recording: readonly ShotAt[];
  keys: readonly KeyPress[];
  most: number;
  hero: boolean;
};

/** What a capture took: the stills, the recording's frames in order, and what Godot printed. */
export type Taken = { stills: Still[]; recording: Still[]; output: string };

/** A still's PNG, read only when it is a plain file inside the job's own folder and small enough to hand back. */
async function readStill(folder: string, file: string): Promise<string | null> {
  const real = await realpath(file).catch(() => null);
  if (!real || !isInside(folder, real)) return null;
  const found = await lstat(real).catch(() => null);
  if (!found?.isFile() || found.size > HOOK_IMAGE_MAX_BYTES) return null;
  return (await readFile(real)).toString("base64");
}

/** A picture's name as Genex keeps it: the camera's, and for a recording's frame its moment. */
function stillName(shot: SavedShot, recorded: boolean): string {
  const camera = shot.name.replace(NOT_NAME, "-").slice(0, NAME_CHARS) || "shot";
  return recorded ? `${camera}-${(shot.frame / PLAY_FPS).toFixed(1)}s` : camera;
}

/** The play a request asks for: its stills' frames, the recording's (never the stills' own), and long enough for both and the keys. */
function playOf(request: StillsRequest, out: string): PlayRequest {
  const stills = request.at === null ? [] : [{ frame: request.at, cameras: ShotCameras.All }];
  const recording = request.recording.filter((shot) => shot.frame !== request.at);
  const shots = [...stills, ...recording];
  const frames = Math.max(keysEnd(request.keys), ...shots.map((shot) => shot.frame + 1), 1);
  const most = Math.max(1, Math.min(MAX_STILLS, request.most));
  return { scene: request.scene, frames, keys: request.keys, shots, out, most, hero: request.hero };
}

/** Stills and a recording of a scene in the game's project, as the play script says it saved them. */
export async function takeStills(
  deps: StillsDeps,
  install: GodotInstall,
  project: string,
  request: StillsRequest,
  signal: AbortSignal,
): Promise<Taken> {
  const parent = path.join(deps.storage, STILLS_FOLDER);
  await mkdir(parent, { recursive: true });
  const folder = await realpath(await mkdtemp(path.join(parent, `${SHOT_PREFIX}-`)));
  try {
    const play = playOf(request, path.join(folder, SHOT_PREFIX));
    const { output } = await deps.run(install.binary, playCall(project, deps.scripts, play), signal);
    // Only the recording's own frames: one that fell on the stills' moment was dropped, and that moment's pictures are stills.
    const recordedFrames = new Set(
      play.shots.filter((shot) => shot.cameras === ShotCameras.First).map((shot) => shot.frame),
    );
    const taken: Taken = { stills: [], recording: [], output };
    for (const shot of savedShots(output)) {
      const recorded = recordedFrames.has(shot.frame);
      const data = await readStill(folder, shot.file);
      if (data) (recorded ? taken.recording : taken.stills).push({ name: stillName(shot, recorded), data });
    }
    taken.stills = taken.stills.slice(0, play.most);
    taken.recording = taken.recording.slice(0, HOOK_RECORDING_MAX);
    return taken;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** What was taken as a moment's or an observer's pictures (a recording only when asked); nothing when there are none. */
export function stillsAnswer(taken: Taken, withRecording = false): HookAnswer {
  const pictures = (stills: readonly Still[]) => stills.map(({ name, data }) => ({ name, data }));
  return {
    ...(taken.stills.length ? { images: pictures(taken.stills) } : {}),
    ...(withRecording && taken.recording.length ? { recording: pictures(taken.recording) } : {}),
  };
}

/** What was taken as the agent's answer: the pictures' names, and the pictures the model sees, recording last. */
export function stillsForAgent(taken: Taken) {
  const all = [...taken.stills, ...taken.recording];
  return {
    shots: all.map((still) => still.name),
    images: all.map((still) => ({ mimeType: PNG, data: still.data, label: still.name })),
  };
}
