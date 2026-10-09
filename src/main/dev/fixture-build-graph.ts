/**
 * The `build-graph` fixture: two runs of a sword in ice for the Builds graph to draw. The same runs
 * with the worker records a director's builders write today (`chat-workers` seeds them in a game
 * of their own) draw as trees.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import type { EventData } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun, gradientShot, type Rgb, roundShotDir } from "./fixture-kit.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { WorkerEnd, WorkerIsolation } from "../../shared/workers.ts";

const SKY: Rgb = [168, 196, 222];
const SNOW: Rgb = [226, 232, 238];
const ICE: Rgb = [140, 190, 214];
const ROCK: Rgb = [92, 104, 120];
const DUSK: Rgb = [58, 70, 104];

const LAND = { facetId: "land", facetTitle: "Frozen landscape" } as const;
const SHORE = "Natural shore: snow drifts creep onto the ice with no hard seam";
const MOUNTAIN =
  "Tall mountain: a tall, readable mountain behind the sword — a blue-grey mass with rock ribs and snow couloirs";
const GOAL =
  "A single atmospheric 3D scene: a sword stuck in ice. The hero is one high-detail sword plunged into a block of ice on a frozen lake; around it a quiet frozen landscape with snow drifts, frozen rocks and distant misty cliffs.";

/** The two runs: a finished run, and a run still running. */
const LOOP_RUNS = [
  ["fixture-graph-run", false],
  ["fixture-graph-live", true],
] as const;

/** One run: its run id, its events so far, and where it keeps its captures. */
interface LoopRun {
  runId: string;
  run: ReturnType<typeof fixtureRun>;
  runsRoot: string;
}

/**
 * Two runs of a sword in ice, shaped like the one a tester read "never judged" on: a single
 * session the lead merged, a helper whose tries at one step fold into one node (some kept, a
 * mountain undone four times and stopped), a round nobody judged that the lead merged anyway,
 * and a second run still running, its judges looking at a try.
 */
export async function seedBuildGraph(
  core: StudioCore,
  project: string,
  threadId: string,
  { builderRecords = false }: { builderRecords?: boolean } = {},
): Promise<void> {
  for (const [runId, live] of LOOP_RUNS) {
    const loopRun: LoopRun = { runId, run: fixtureRun({ runId, project }), runsRoot: core.layout.runs };
    const events = await firstHalf(loopRun);
    events.push(...(live ? await stillRunning(loopRun) : await finished(loopRun)));
    await writeDirectorShots(path.join(core.layout.runs, runId, "director"), runId);
    await core.append(builderRecords ? events.flatMap((data) => withBuilderRecords(loopRun, data)) : events, threadId);
  }
}

/** How a builder's close-out is recorded, by the state its `director_worker` gives. */
const BUILDER_END: Readonly<Record<string, WorkerEnd>> = {
  done: WorkerEnd.Done,
  failed: WorkerEnd.Failed,
  stopped: WorkerEnd.Stopped,
};

/**
 * What a director writes today that these runs' records lack: the start saying its builders write
 * worker records (the run's `autopilot_started` is replaced), and beside a builder's
 * `director_worker` (`director-pool.ts`) the builder's start when it starts, its end at its close-out.
 */
function withBuilderRecords(loopRun: LoopRun, data: EventData): EventData[] {
  const record = customRecord(data);
  if (record?.event_type === CustomEvent.AutopilotStarted)
    return [loopRun.run(CustomEvent.AutopilotStarted, { ...record.payload, workerRecords: true })];
  return [data, ...builderRecord(loopRun, data)];
}

/** The worker record a director writes beside a builder's `director_worker`. */
function builderRecord(loopRun: LoopRun, data: EventData): EventData[] {
  const record = customRecord(data);
  if (record?.event_type !== CustomEvent.DirectorWorker) return [];
  const { workerId, title, state, stoppedBecause } = record.payload;
  if (typeof workerId !== "string" || typeof title !== "string") return [];
  if (state === "running")
    return [loopRun.run(CustomEvent.WorkerStarted, { workerId, title, isolation: WorkerIsolation.Copy, task: title })];
  const end = typeof state === "string" ? BUILDER_END[state] : undefined;
  if (!end) return [];
  const why = typeof stoppedBecause === "string" ? { stoppedBecause } : {};
  // Every builder of these runs that finished made commits of its own, which the lead integrated.
  const handedBack = end === WorkerEnd.Done ? { delivered: true } : {};
  return [loopRun.run(CustomEvent.WorkerFinished, { workerId, title, state: end, ...why, ...handedBack })];
}

/** Both runs alike: the start, three rounds of the landscape and four merges. */
async function firstHalf(loopRun: LoopRun): Promise<EventData[]> {
  const { runId, run } = loopRun;
  return [
    run(CustomEvent.RunStarted, {
      goal: GOAL,
      engine: EngineId.ClaudeCode,
      model: FIXTURE_MODEL,
      reference: { name: "Skyrim frozen tundra, the Master Sword pedestal", kind: "direction" },
      budgets: { wallClockMs: 3_600_000 },
    }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 3, facets: [] }),
    worker(loopRun, "sword", "Sword, ice and light", "single", "running"),
    worker(loopRun, "land", "Frozen landscape", "loop", "running"),
    worker(loopRun, "sky", "Sky and fog", "loop", "running"),
    run(CustomEvent.FacetBuildStarted, { facetId: "sky", facetTitle: "Sky and fog", iteration: 1 }),
    ...(await round(loopRun, { n: 1, winner: "challenger", from: SKY, to: SNOW })),
    merge(loopRun, "land", `${runId}-h1`),
    ...(await round(loopRun, {
      n: 2,
      winner: "challenger",
      move: "Snowfall: gentle snow that drifts through the light",
      milestoneId: "snow",
      from: SKY,
      to: ICE,
    })),
    ...(await round(loopRun, {
      n: 3,
      winner: "challenger",
      move: "Layered depth: pines and cliffs fading into fog",
      milestoneId: "depth",
      from: ICE,
      to: ROCK,
    })),
    merge(loopRun, "land", `${runId}-h2`),
    worker(loopRun, "sword", "Sword, ice and light", "single", "done"),
    merge(loopRun, "sword", `${runId}-h3`),
    run(CustomEvent.IntegrationHealth, { head: `${runId}-h3`, ok: true, problems: [] }),
    merge(loopRun, "sky", `${runId}-h4`),
  ];
}

/** The finished run: the shore kept on its fourth try, the mountain undone four times and stopped. */
async function finished(loopRun: LoopRun): Promise<EventData[]> {
  const { runId, run } = loopRun;
  const shore = { move: SHORE, milestoneId: "shore" };
  const mountain = { move: MOUNTAIN, milestoneId: "mountain" };
  return [
    ...(await round(loopRun, { n: 4, winner: "incumbent", ...shore, from: ICE, to: SNOW })),
    ...(await round(loopRun, { n: 5, winner: "incumbent", ...shore, from: ICE, to: SNOW })),
    ...(await round(loopRun, { n: 6, winner: "incumbent", ...shore, from: ICE, to: SNOW })),
    ...(await round(loopRun, { n: 7, winner: "challenger", ...shore, from: SNOW, to: ICE })),
    merge(loopRun, "land", `${runId}-h5`),
    ...(await round(loopRun, { n: 8, winner: "incumbent", ...mountain, from: DUSK, to: ROCK })),
    ...(await round(loopRun, { n: 9, winner: "incumbent", ...mountain, from: DUSK, to: ROCK })),
    ...(await round(loopRun, { n: 10, winner: "incumbent", ...mountain, from: DUSK, to: ROCK })),
    ...(await round(loopRun, { n: 11, winner: "incumbent", ...mountain, from: ROCK, to: DUSK })),
    mountainMove(loopRun, 12),
    run(CustomEvent.FacetBuildStarted, { ...LAND, iteration: 12 }),
    run(CustomEvent.FacetIteration, {
      ...LAND,
      iteration: 12,
      winner: null,
      satisfied: false,
      verdictSource: "stopped",
      reason: "stopped by the director: the loop kept re-judging the already-delivered mountain move",
      shots: [],
      flags: [],
      diffs: {},
    }),
    run(CustomEvent.DirectorWorker, {
      workerId: "land",
      title: "Frozen landscape",
      mode: "loop",
      state: "stopped",
      stoppedBecause: "stopped by the director: landscape is done and integrated",
    }),
    worker(loopRun, "sky", "Sky and fog", "loop", "done"),
    run(CustomEvent.RunFinished, {
      mode: "director",
      landed: true,
      integrationHead: `${runId}-h5`,
      baseCommit: `${runId}-base`,
      stoppedBecause: "the director finished the run",
      executionStatus: ExecutionStatus.Completed,
      summary:
        "A single silent, mythic 3D scene: a legendary longsword plunged point-down into a faceted, translucent block of ice on a frozen lake, with snow drifts, pines fading into fog and falling snow. The tall mountain behind the sword never read clearly and was left out.",
      landingResult: {
        verified: false,
        how: "health",
        line: "Made live after a health check. No judge compared it with the game you had.",
      },
    }),
  ];
}

/** The live run: the mountain undone once, and a fifth try its judges are looking at. */
async function stillRunning(loopRun: LoopRun): Promise<EventData[]> {
  const { run } = loopRun;
  const events = [
    ...(await round(loopRun, {
      n: 4,
      winner: "incumbent",
      move: MOUNTAIN,
      milestoneId: "mountain",
      from: DUSK,
      to: ROCK,
    })),
    mountainMove(loopRun, 5),
    run(CustomEvent.FacetBuildStarted, { ...LAND, iteration: 5 }),
    run(CustomEvent.FacetLiveness, {
      ...LAND,
      iteration: 5,
      critic: "place",
      total: 12,
      max: 18,
      biggest: "extent",
    }),
  ];
  await shotOf(loopRun, 5, ROCK, DUSK);
  return events;
}

function worker(loopRun: LoopRun, workerId: string, title: string, mode: string, state: string): EventData {
  return loopRun.run(CustomEvent.DirectorWorker, { workerId, title, mode, state });
}

function merge(loopRun: LoopRun, facetId: string, head: string): EventData {
  return loopRun.run(CustomEvent.IntegrationMerge, { facetId, head, commit: head, conflict: false, stage: "director" });
}

function mountainMove(loopRun: LoopRun, iteration: number): EventData {
  return loopRun.run(CustomEvent.FacetMove, {
    ...LAND,
    iteration,
    what: MOUNTAIN,
    milestoneId: "mountain",
    source: "milestone",
    delivered: null,
    scale: null,
  });
}

/** Write one round's captures of the landscape, through two cameras, and name them the way the loop does. */
async function shotOf(loopRun: LoopRun, n: number, from: Rgb, to: Rgb) {
  const dir = roundShotDir(loopRun.runsRoot, loopRun.runId, LAND.facetId, n);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "c1_default.jpg");
  const chase = path.join(dir, "c2_chase.jpg");
  await fs.writeFile(file, gradientShot(from, to));
  await fs.writeFile(chase, gradientShot(to, from));
  return [
    { camera: "default", path: file },
    { camera: "chase", path: chase },
  ];
}

interface RoundSpec {
  n: number;
  winner: "challenger" | "incumbent";
  move?: string;
  milestoneId?: string;
  from: Rgb;
  to: Rgb;
}

/** One round of the landscape: the move it tried (if any), its build and its verdict. */
async function round(loopRun: LoopRun, spec: RoundSpec): Promise<EventData[]> {
  const { run } = loopRun;
  const { n, winner } = spec;
  const kept = winner === "challenger";
  const moved = spec.move
    ? [
        run(CustomEvent.FacetMove, {
          ...LAND,
          iteration: n,
          what: spec.move,
          milestoneId: spec.milestoneId ?? null,
          source: "milestone",
          delivered: null,
          scale: null,
        }),
      ]
    : [];
  return [
    ...moved,
    run(CustomEvent.FacetBuildStarted, { ...LAND, iteration: n }),
    run(CustomEvent.FacetIteration, {
      ...LAND,
      iteration: n,
      winner,
      satisfied: false,
      verdictSource: kept ? "checks" : "invisible",
      reason: kept ? "the checks it was given now pass" : "nothing visible changed",
      biggest_gap: kept
        ? ""
        : "There is still no single tall blue-grey mountain behind the sword that stands above the pines and reads clearly through the fog.",
      defects: kept ? [] : ["the mountain reads as a flat backdrop", "fog hides the ridge line"],
      unmeasured: [],
      scoreboard: roundScoreboard(kept),
      shots: await shotOf(loopRun, n, spec.from, spec.to),
      flags: [],
      diffs: {},
    }),
  ];
}

function roundScoreboard(kept: boolean) {
  const passing = kept ? 5 : 4;
  return {
    total: 5,
    passing,
    unmeasured: 0,
    plannedTotal: 5,
    plannedPassing: passing,
    plannedUnmeasured: 0,
    grownTotal: 0,
    flips: [],
    plannedFlips: [],
    regressions: [],
    results: [
      { id: "sword-reads-first", kind: "scene", weight: "identity", pass: true, reason: "" },
      { id: "snow-on-the-ground", kind: "scene", weight: "normal", pass: true, reason: "" },
    ],
  };
}

/** The lead's own looks: the base it started from and the build its judge saw. */
async function writeDirectorShots(director: string, runId: string): Promise<void> {
  const looks = [
    ["base", `${runId}-base`, [SKY, SKY]],
    ["judge_1", `${runId}-h5`, [SNOW, ICE]],
  ] as const;
  for (const [folder, head, colours] of looks) {
    const dir = path.join(director, folder);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "default.jpg");
    await fs.writeFile(file, gradientShot(colours[0], colours[1]));
    const shots = [{ camera: "default", path: file }];
    const verdict = folder === "base" ? { commit: head, shots } : { head, target: "integration", shots };
    await fs.writeFile(path.join(dir, "verdict.json"), JSON.stringify(verdict));
  }
}
