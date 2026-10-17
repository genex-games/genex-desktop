/**
 * How Genex runs Godot: each job is a value (its arguments, what it may read and write, its
 * deadline), and one runner starts it in the macOS sandbox Genex's native jobs use
 * (`runNativeProcess`). There Godot gets a private home (so a game's `user://` files and Godot's own
 * caches stay out of the person's), no network, writes only to the project and the job's own
 * folders, and its whole process group is stopped at its deadline or the turn's Stop. A deadline is
 * a must: a script that awaits a frame that never draws (a headless capture) would wait forever.
 * Tests hand in their own runner and never start Godot.
 */
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { NativeEndReason, runNativeProcess } from "../../substrate/plugins/native-process.ts";
import { type KeyPress, keysArg, PLAY_FPS, type ShotAt, shotsArg } from "./play-input.ts";

/** The jobs Genex runs Godot for. Never rename a value: records name them. */
export const GodotJob = {
  Import: "import",
  Check: "check",
  Run: "run",
  Capture: "capture",
  Play: "play",
  Reference: "reference",
  Export: "export",
} as const;
export type GodotJob = (typeof GodotJob)[keyof typeof GodotJob];

/** Genex's own GDScript, shipped beside the backend in `scripts/`. */
export const GodotScript = { Check: "genex_check.gd", Play: "genex_play.gd" } as const;

/** An import of a big project's assets can take minutes the first time; later ones are quick. */
const IMPORT_TIMEOUT_MS = 5 * MINUTE_MS;
const CHECK_TIMEOUT_MS = 2 * MINUTE_MS;
const REFERENCE_TIMEOUT_MS = 2 * MINUTE_MS;
/** A run's own seconds play at a fixed 60 frames each, faster than real time headless; this covers its start and a slow game. */
const RUN_START_MS = 30 * SECOND_MS;
const RUN_SECOND_BUDGET_MS = 3 * SECOND_MS;
/** The frames a run plays each second of its game time (the play script's own rate). */
export const RUN_FPS = PLAY_FPS;
/** The longest a run plays and the default, in game seconds. */
export const MAX_RUN_SECONDS = 60;
export const DEFAULT_RUN_SECONDS = 5;
/** The size of a still, and where its window opens: off every screen, so it never covers the person's work. */
const STILL_SIZE = "1280x720";
const OFF_SCREEN = "-10000,-10000";
/** The most of Godot's output one job keeps, from its end. */
const OUTPUT_BYTES = 200_000;
const SCRATCH_PREFIX = "genex-godot-";
/** The private home the sandbox makes in a job's scratch folder (`runNativeProcess`). */
const HOME_FOLDER = "home";

const MESSAGE = {
  MacOnly: "Genex runs Godot on a Mac only for now.",
} as const;

/** One job: Godot's arguments, the folder it runs in, what it may read and write, and its deadline. */
export type GodotCall = {
  job: GodotJob;
  args: string[];
  cwd: string;
  reads: string[];
  writes: string[];
  timeoutMs: number;
  /** A job that draws (a still) needs the GPU and a window. */
  gpu: boolean;
  /** Files written under names that only start so (a program's own temporary names), as real absolute paths. */
  writePrefixes?: string[];
  /** Folders linked into the job's private home (`at`, relative to it), read-only: the person's export templates. */
  homeLinks?: ReadonlyArray<{ at: string; to: string }>;
};

/** What a job printed (errors first, then the rest), and how it ended. */
export type GodotResult = { output: string; timedOut: boolean; cancelled: boolean };

/** Starts one job with a Godot binary; the signal stops it. */
export type GodotRunner = (binary: string, call: GodotCall, signal: AbortSignal) => Promise<GodotResult>;

/** An import: Godot reads the project's assets and scripts into `.godot/`, which a check and a run need first. */
export function importCall(project: string): GodotCall {
  return {
    job: GodotJob.Import,
    args: ["--headless", "--path", project, "--import"],
    cwd: project,
    reads: [],
    writes: [project],
    timeoutMs: IMPORT_TIMEOUT_MS,
    gpu: false,
  };
}

/** A check: Genex's check script loads every script, scene and resource, so Godot names each problem. */
export function checkCall(project: string, scripts: string): GodotCall {
  return {
    job: GodotJob.Check,
    args: ["--headless", "--path", project, "-s", path.join(scripts, GodotScript.Check)],
    cwd: project,
    reads: [scripts],
    writes: [project],
    timeoutMs: CHECK_TIMEOUT_MS,
    gpu: false,
  };
}

/** A headless run of a scene (the main scene when `scene` is empty) for `seconds` of game time at a fixed frame rate. */
export function runCall(project: string, scene: string, seconds: number): GodotCall {
  return {
    job: GodotJob.Run,
    args: [
      "--headless",
      "--path",
      project,
      "--fixed-fps",
      String(RUN_FPS),
      "--quit-after",
      String(seconds * RUN_FPS),
      ...(scene ? ["--scene", scene] : []),
    ],
    cwd: project,
    reads: [],
    writes: [project],
    timeoutMs: RUN_START_MS + seconds * RUN_SECOND_BUDGET_MS,
    gpu: false,
  };
}

/**
 * A play of a scene (the main scene when `scene` is empty) through Genex's play script: `frames` at
 * 60 a second, `keys` pressed on their timeline, and `shots` saved as `<out>-<frame>-<n>.png`. With
 * stills it draws, in a window off every screen; without, it runs headless. `hero` lets the game's
 * own project settings move its hero shot (`genex/shot_seconds`, `genex/shot_keys`).
 */
export type PlayRequest = {
  scene: string;
  frames: number;
  keys: readonly KeyPress[];
  shots: readonly ShotAt[];
  out: string | null;
  most: number;
  hero: boolean;
};

/** The play script's arguments for a request, each one `key=value`. */
function playArgs(request: PlayRequest): string[] {
  return [
    `scene=${request.scene}`,
    `frames=${request.frames}`,
    `keys=${keysArg(request.keys)}`,
    `shots=${shotsArg(request.shots)}`,
    ...(request.out ? [`out=${request.out}`] : []),
    `most=${request.most}`,
    ...(request.hero ? ["hero=1"] : []),
  ];
}

/** A play job: drawn with stills to take, headless without. */
export function playCall(project: string, scripts: string, request: PlayRequest): GodotCall {
  const draws = request.out !== null && request.shots.length > 0;
  const window = draws ? ["--position", OFF_SCREEN, "--resolution", STILL_SIZE, "--disable-vsync"] : ["--headless"];
  const seconds = request.frames / PLAY_FPS;
  return {
    job: draws ? GodotJob.Capture : GodotJob.Play,
    args: [
      ...window,
      "--path",
      project,
      "--fixed-fps",
      String(PLAY_FPS),
      "-s",
      path.join(scripts, GodotScript.Play),
      "--",
      ...playArgs(request),
    ],
    cwd: project,
    reads: [scripts],
    writes: [project, ...(draws && request.out ? [path.dirname(request.out)] : [])],
    timeoutMs: RUN_START_MS + Math.ceil(seconds) * RUN_SECOND_BUDGET_MS,
    gpu: draws,
  };
}

/** Godot's class reference as XML (`<folder>/doc/classes/*.xml`, its modules' beside), for one version. */
export function referenceCall(folder: string): GodotCall {
  return {
    job: GodotJob.Reference,
    args: ["--headless", "--doctool", folder],
    cwd: folder,
    reads: [],
    writes: [folder],
    timeoutMs: REFERENCE_TIMEOUT_MS,
    gpu: false,
  };
}

/** The job's home (`<scratch>/home`, as the sandbox makes it) with each link in place before Godot starts. */
async function linkIntoHome(scratch: string, links: NonNullable<GodotCall["homeLinks"]>): Promise<void> {
  for (const { at, to } of links) {
    const where = path.join(scratch, HOME_FOLDER, at);
    await mkdir(path.dirname(where), { recursive: true });
    await symlink(to, where);
  }
}

/** The runner Genex uses: each job in the native-job sandbox, in a scratch folder removed after it. */
export function confinedRunner(platform: NodeJS.Platform = process.platform): GodotRunner {
  return async (binary, call, signal) => {
    if (platform !== "darwin") throw new Error(MESSAGE.MacOnly);
    const scratch = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
    try {
      await linkIntoHome(scratch, call.homeLinks ?? []);
      const ended = await runNativeProcess({
        binary,
        args: call.args,
        cwd: call.cwd,
        scratch,
        reads: call.reads,
        writes: call.writes,
        ...(call.writePrefixes ? { writePrefixes: call.writePrefixes } : {}),
        denyRead: [],
        gpu: call.gpu,
        signal,
        timeoutMs: call.timeoutMs,
        maxOutputBytes: OUTPUT_BYTES,
      });
      return {
        output: `${ended.stderr}\n${ended.stdout}`,
        timedOut: ended.reason === NativeEndReason.Timeout,
        cancelled: ended.reason === NativeEndReason.Cancelled,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
