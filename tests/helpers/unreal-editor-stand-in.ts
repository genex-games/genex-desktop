/**
 * A stand-in for the user's Unreal Editor as the Unreal plugin's editor queue reaches it: it records
 * every tool call and answers like the Genex editor helper, with Unreal's background throttle on by
 * default. Shared by the queue's own suite (`conformance/unreal-editor-queue.test.ts`) and the
 * incident register (`harness-incidents.test.ts`). `crashableEditor` gives it a real log and a
 * process that can crash, with a crash log in Unreal 5.8's shape.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { editorLogPath, startCrashCheck } from "../../src/plugins/unreal/editor-log.ts";
import {
  createEditorQueue,
  type EditorPort,
  LoopTool,
  PartRunState,
  type QueueDeps,
} from "../../src/plugins/unreal/editor-queue.ts";
import { parsePartTest } from "../../src/plugins/unreal/part-test.ts";
import { tmpDir } from "./tmp.ts";

/** A tool the queue called, its arguments and the call's own timeout, if it set one. */
export type Call = [string, Record<string, unknown>, number?];

/**
 * Every parameter of the Genex editor helper's tools: Unreal's schema marks each one required, even
 * those with a Python default, so a call without one fails in the real editor.
 */
const PARAMETERS: Partial<Record<string, string[]>> = {
  [LoopTool.ApplyPart]: ["script", "part"],
  [LoopTool.Hold]: ["name", "x", "y", "seconds"],
  [LoopTool.CapturePlay]: ["name", "width", "height"],
  [LoopTool.GameState]: ["part"],
  [LoopTool.ProbeCharacters]: ["part"],
  [LoopTool.ProbeView]: [],
  [LoopTool.GetProperties]: ["instance", "properties"],
  [LoopTool.SetProperties]: ["instance", "values"],
  [LoopTool.RecompileModule]: ["module", "classes"],
  [LoopTool.Settle]: ["seconds"],
  [LoopTool.DriveRoute]: ["seconds", "throttle", "steer"],
  [LoopTool.ProbeRoute]: [],
  [LoopTool.PlayerState]: [],
  [LoopTool.Mouse]: ["dx", "dy", "wheel"],
  [LoopTool.Pause]: ["paused"],
};

/** Unreal's background throttle, where Epic's ObjectTools read and write it. */
const SETTINGS = "/Script/UnrealEd.Default__EditorPerformanceSettings";
export const THROTTLE = "bThrottleCPUWhenNotForeground";
/** The console variable that says whether the editor ray-traces. */
const RAY_TRACING = "r.RayTracing";

/** Like the Genex editor helper, a probe answers only during play and refuses otherwise. */
const NO_PLAY = { error: "No play session is running; start one first." };

/** A stand-in editor: records every call and answers like the Genex editor helper would. */
export function standIn(overrides: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {}) {
  const calls: Call[] = [];
  // Unreal's default: an editor in the background throttles itself.
  const state = {
    answering: true,
    pie: false,
    activity: 0,
    throttle: true,
    throttleAtPlay: undefined as unknown,
    rayTracing: false,
    paused: false,
  };
  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
    [LoopTool.ApplyPart]: () => ({
      ok: true,
      ms: 900,
      output: "",
      assets: ["/Game/Parts/Lantern/BP_Lantern"],
      actors: ["Lantern_0"],
    }),
    [LoopTool.StartPlay]: () => {
      state.pie = true;
      state.throttleAtPlay = state.throttle;
      return true;
    },
    [LoopTool.Hold]: (a) => ({ held: a.name, seconds: a.seconds }),
    [LoopTool.Mouse]: (a) => (state.pie ? { moved: [a.dx, a.dy], wheel: a.wheel } : NO_PLAY),
    [LoopTool.Pause]: (a) => {
      if (!state.pie) return NO_PLAY;
      state.paused = Boolean(a.paused);
      return { paused: state.paused };
    },
    [LoopTool.CapturePlay]: (a) => ({ queued: true, file: `/p/Saved/Genex/captures/${a.name}.png` }),
    [LoopTool.GameState]: () => ({ pie: true, player: { speedKmh: 12 }, actors: [{ label: "Lantern_0" }] }),
    [LoopTool.StopPlay]: () => {
      state.pie = false;
      state.paused = false;
      return { stopping: true, released: 0 };
    },
    [LoopTool.PlayState]: () => ({ pie: state.pie }),
    [LoopTool.EditorActivity]: () => ({ camera: [0, 0, state.activity], selection: [], dirty: [], pie: state.pie }),
    [LoopTool.ProbeCharacters]: (a) =>
      state.pie ? { pawns: [{ label: "Car_0", gapCm: 0 }], more: 0, part: a.part } : NO_PLAY,
    [LoopTool.ProbeView]: () => (state.pie ? { meshes: [{ component: "Handlebar", clipping: false }] } : NO_PLAY),
    // Like the helper: a hot reload is refused during play, and a good one names the reload.
    [LoopTool.RecompileModule]: () =>
      state.pie
        ? { error: "A play session is running, and hot reload during play is not allowed; stop it first (stop_play)." }
        : { ok: true, compiled: true, ms: 13_700, missing: [], log: ["LogHotReload: Recompiling module Rush..."] },
    // The editor's port hands the answer's JSON text over parsed.
    [LoopTool.GetProperties]: (a) =>
      a.instance === SETTINGS && Array.isArray(a.properties) && a.properties.includes(THROTTLE)
        ? { [THROTTLE]: state.throttle }
        : { error: "No such property." },
    // Epic's SearchCVars lists every console variable whose name holds the one asked.
    [LoopTool.SearchCVars]: (a) =>
      a.name === RAY_TRACING
        ? {
            [RAY_TRACING]: { help: "Enables ray tracing.", value: state.rayTracing ? 1 : 0 },
            "r.RayTracing.PSOCacheSize": { help: "Pipelines kept.", value: 50 },
          }
        : {},
    [LoopTool.SetProperties]: (a) => {
      const values = JSON.parse(String(a.values)) as Record<string, unknown>;
      if (a.instance !== SETTINGS || typeof values[THROTTLE] !== "boolean") return false;
      state.throttle = values[THROTTLE];
      return true;
    },
    ...overrides,
  };
  const port: EditorPort = {
    answering: async () => state.answering,
    call: async (tool, args, timeoutMs) => {
      calls.push(timeoutMs === undefined ? [tool, args] : [tool, args, timeoutMs]);
      const missing = (PARAMETERS[tool] ?? []).filter((name) => !(name in args));
      if (missing.length) throw new Error(`${tool} is missing ${missing.join(", ")}`);
      const answer = answers[tool];
      if (!answer) throw new Error(`no stand-in for ${tool}`);
      return answer(args);
    },
  };
  return { port, calls, state };
}

/**
 * The queue's dependencies over `port`: a clock that moves only when the queue waits (`slept` records
 * each wait), the shot files that are ready, and `landCpp` for a C++ part's copy.
 */
export function deps(
  port: EditorPort,
  files = new Set<string>(["/p/Saved/Genex/captures/walk.png"]),
  landCpp: QueueDeps["landCpp"] = async () => {
    throw new Error("a part without C++ is never copied");
  },
): QueueDeps & {
  slept: number[];
} {
  const slept: number[] = [];
  let clock = 0;
  return {
    slept,
    landCpp,
    editor: () => port,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
      // A real turn of the event loop, so a test can change the editor while the queue waits.
      await new Promise((resolve) => setImmediate(resolve));
    },
    fileReady: async (file) => files.has(file),
    readShot: async (file) => `png:${file}`,
  };
}

/** A part's play test: hold an input, take the shot `walk`, expect the lantern and a fast player. */
export const TEST = (() => {
  const parsed = parsePartTest({
    warmupSeconds: 2,
    steps: [
      { hold: "MoveForward", seconds: 1 },
      { shot: "walk" },
      { expect: { actor: "Lantern_0", exists: true } },
      { expect: { player: "speedKmh", atLeast: 50 } },
    ],
  });
  assert.ok(parsed.ok);
  return parsed.test;
})();

/** The queued run `id` once it is done or failed. */
export async function settled(queue: ReturnType<typeof createEditorQueue>, id: string) {
  for (let i = 0; i < 5000; i++) {
    const run = queue.status(id);
    if (run && (run.state === PartRunState.Done || run.state === PartRunState.Failed)) return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("never settled");
}

/** The tools the queue called, in order, without its polling. */
export const sequence = (calls: Call[]) =>
  calls.map(([tool]) => tool).filter((tool) => tool !== LoopTool.EditorActivity && tool !== LoopTool.PlayState);

/** The throttle values the queue wrote, in order. */
export const written = (calls: Call[]) =>
  calls
    .filter(([tool]) => tool === LoopTool.SetProperties)
    .map(([, args]) => (JSON.parse(String(args.values)) as Record<string, unknown>)[THROTTLE]);

/** Runs the Lantern part through a queue over `port` (an editor on `platform`) until it settles. */
export async function runLantern(port: EditorPort, platform?: NodeJS.Platform) {
  const queue = createEditorQueue({ ...deps(port), ...(platform ? { platform } : {}) });
  return settled(queue, queue.enqueue({ game: "valley", part: "Lantern", script: "/s", test: TEST }));
}

/** How a {@link playable} game plays: its clock, its pawn's settle, its route and its drive. */
export type PlayOptions = {
  /** Game seconds per second on the queue's clock: a loaded editor plays at a fraction of real time. */
  rate?: number;
  /** The frame rate play_state reports. */
  fps?: number;
  /** The game seconds the pawn takes to come to rest; null keeps it moving. */
  settleAfter?: number | null;
  /** Whether the game has a `GenexRoute`, and how many metres along it the pawn gets each game second. */
  route?: boolean;
  metresPerSecond?: number;
  /** False: an older helper whose play_state and player_state carry no game clock, settle or drive. */
  clock?: boolean;
};

/** A capture as the stand-in took it: the shot's name and the game's clock then. */
export type Capture = { name: string; gameSeconds: number };

/** The tag checks' actors in the stand-in's play world: the track a feature built, and a part's lantern. */
const PLAY_WORLD_ACTORS = [
  { label: "Track_0", tags: ["genex:track"] },
  { label: "Lantern_0", tags: [] },
];

/**
 * A stand-in editor that plays a game on a game clock of its own, tied to the queue's clock by
 * `rate`, as the Genex editor helper 0.5 does: play_state reads the clock and the frame rate,
 * settle and drive_route start at once and player_state reads how they go, probe_route measures
 * the pawn against the route, game_state lists the `genex:`-tagged actors with their tags, and
 * every capture records the game's clock. `overrides` replace any answer.
 */
export function playable(
  options: PlayOptions = {},
  overrides: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {},
) {
  const { rate = 1, fps = 40, settleAfter = 1.4, route = true, metresPerSecond = 10, clock = true } = options;
  const files = new Set<string>();
  const captures: Capture[] = [];
  const game = {
    startedAt: undefined as number | undefined,
    settle: undefined as { from: number; seconds: number } | undefined,
    drive: undefined as { from: number; seconds: number } | undefined,
  };
  let now = () => 0;
  const seconds = () => (game.startedAt === undefined ? 0 : ((now() - game.startedAt) / 1000) * rate);
  const settleState = () => {
    if (!game.settle) return null;
    const elapsed = seconds() - game.settle.from;
    if (settleAfter !== null && elapsed >= settleAfter)
      return { state: "settled", gameSeconds: settleAfter, speedCmS: 3 };
    if (elapsed >= game.settle.seconds) return { state: "unsettled", gameSeconds: game.settle.seconds, speedCmS: 140 };
    return { state: "watching", gameSeconds: elapsed, speedCmS: 140 };
  };
  const driveState = () => {
    if (!game.drive) return null;
    const driven = Math.min(seconds() - game.drive.from, game.drive.seconds);
    const state = driven >= game.drive.seconds ? "done" : "driving";
    return { state, gameSeconds: driven, progressM: route ? driven * metresPerSecond : null, route };
  };
  const player = () => ({
    pawn: "OffroadCar_0",
    location: [0, 0, 20],
    rotation: [0, 0, 0],
    speedKmh: game.drive ? 36 : 0,
    held: [],
    ...(clock
      ? {
          gameSeconds: seconds(),
          fps,
          routeProgressM: driveState()?.progressM ?? null,
          settle: settleState(),
          drive: driveState(),
        }
      : {}),
  });
  const playing = () => editor.state.pie;
  const editor = standIn({
    [LoopTool.StartPlay]: () => {
      editor.state.pie = true;
      editor.state.throttleAtPlay = editor.state.throttle;
      game.startedAt = now();
      return true;
    },
    [LoopTool.PlayState]: () => (clock && playing() ? { pie: true, gameSeconds: seconds(), fps } : { pie: playing() }),
    [LoopTool.Settle]: (a) => {
      if (!playing()) return { error: "No play session is running." };
      game.settle = { from: seconds(), seconds: Number(a.seconds) };
      return { watching: true, seconds: a.seconds };
    },
    [LoopTool.DriveRoute]: (a) => {
      if (!playing()) return { error: "No play session is running." };
      game.drive = { from: seconds(), seconds: Number(a.seconds) };
      return { driving: true, seconds: a.seconds, route };
    },
    [LoopTool.PlayerState]: () => (playing() ? player() : { error: "No play session is running." }),
    [LoopTool.ProbeRoute]: () =>
      route
        ? { route: true, facingDeg: 4.2, offRouteCm: 30, progressM: 0.3, lengthM: 420 }
        : { route: false, facingDeg: null, offRouteCm: null, progressM: null, lengthM: null },
    [LoopTool.GameState]: () => ({ pie: playing(), player: player(), actors: PLAY_WORLD_ACTORS, more: 0 }),
    [LoopTool.CapturePlay]: (a) => {
      const file = `/p/Saved/Genex/captures/${a.name}.png`;
      captures.push({ name: String(a.name), gameSeconds: seconds() });
      files.add(file);
      return { queued: true, file };
    },
    ...overrides,
  });
  const d = deps(editor.port, files);
  now = d.now;
  return { editor, deps: d, captures, game, seconds };
}

/**
 * A crash log in Unreal 5.8's shape, by part: the editor opening the project (with an "Error test"
 * and an "Error querying" line), play starting, and the crash a part's C++ caused (Epic's
 * critical-error banner, SIGSEGV and the call stack, the shutdown).
 */
export const CrashLog = { Open: "editor-open.txt", PlayStart: "play-start.txt", Crash: "crash.txt" } as const;
export type CrashLog = (typeof CrashLog)[keyof typeof CrashLog];

const CRASH_FOLDER = path.join(import.meta.dirname, "..", "fixtures", "unreal-crash");
/** Where the project's path stands in the log. */
const PROJECT_PLACEHOLDER = "{{PROJECT}}";

/** One part of the crash log; the opening names `project` on Unreal's command line. */
export async function crashLog(part: CrashLog, project = ""): Promise<string> {
  return (await readFile(path.join(CRASH_FOLDER, part), "utf8")).replace(PROJECT_PLACEHOLDER, project);
}

/** The log's game module, whose hot-reloaded library holds the crashing class. */
export const CRASH_MODULE = "DirtTrack";

/**
 * Gives `port` the crash watch the backend gives the real editor's: the project's own log, written
 * for real in a home of its own (the folder has a space, as `~/AI Games` does), and whether its
 * process runs (`unreal.running`). `crash()` writes the log's play start and crash and ends the
 * process; `unreal.checks` counts the watch's looks.
 */
export async function crashableEditor(port: EditorPort) {
  const home = await tmpDir("studio-unreal-queue-crash-");
  const directory = path.join(home, "AI Games", "dirt-track", "unreal");
  const project = path.join(directory, `${CRASH_MODULE}.uproject`);
  const file = editorLogPath({ file: project, directory }, home, "darwin");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await crashLog(CrashLog.Open, project));
  const unreal = { running: true, checks: 0 };
  port.watchCrash = async () => {
    const check = await startCrashCheck(file, project, {
      running: async () => unreal.running,
      module: CRASH_MODULE,
    });
    return async () => {
      unreal.checks++;
      return check();
    };
  };
  const write = (text: string) => appendFile(file, text);
  const crash = async () => {
    await write(await crashLog(CrashLog.PlayStart));
    await write(await crashLog(CrashLog.Crash));
    unreal.running = false;
  };
  return { unreal, file, write, crash };
}

/** An answer a crashed editor never gives. */
export const never = () => new Promise<never>(() => {});
