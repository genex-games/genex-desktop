/**
 * The `build-timeline` fixture: a Loop still going whose integration head grew through four builds,
 * for the Builds graph's build line, its compares and the game's Assets tab during a run.
 *
 * - Build 1 merges the shop sign, Build 2 the engine sounds (a merge that changed no picture: its
 *   screenshot is Build 1's to the byte), Build 3 a repainted sign (the same file delivered again,
 *   its kept picture from the same view), Build 4 the main agent's own changes, which drew a blank
 *   screen.
 * - Twelve workers: a reader that started before the first build, the three merged ones, a track
 *   the lead did not use, five paint schemes off Build 2 (not used or stopped; three fold behind
 *   "+3 workers"), and two still at work off Build 4.
 * - The sign and the sounds are only in the run's integration worktree: the Assets tab lists them as
 *   in the running build.
 * - Before it, a finished Loop in Build history: a horn worker merged into Build 1, the lead's own
 *   Build 2 checked at the finish, landed; no save points, so its lead rests on Build 2's picture.
 *
 * Written after the app has started ({@link seedBuildTimeline}): the start closes every run an
 * earlier app left open, so a Loop written before it would read as stopped.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData, customRecord } from "../../shared/custom-events.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { HealthFinding } from "../../shared/preview-contract.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../shared/workers.ts";
import { git } from "../../substrate/snapshots.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun, gradientShot, type Rgb } from "./fixture-kit.ts";

const RUN = "fixture-timeline-run";
const ASK = "Build a street racer with a shop to buy paint for the car.";
const DONE_RUN = "fixture-timeline-done";
const DONE_ASK = "Give the car a horn, and a garage to park it in.";
const DONE_HEADS = ["e5", "f6"].map((seed) => seed.repeat(20));
const SIGN = "assets/genex/shop-sign.png";
const ENGINE = "assets/genex/engine-loop.wav";
const HEADS = ["a1", "b2", "c3", "d4"].map((seed) => seed.repeat(20));

const SKY: Rgb = [150, 190, 230];
const ROAD: Rgb = [70, 74, 86];
const DUSK: Rgb = [228, 140, 90];
const NIGHT: Rgb = [14, 14, 18];
const RED: Rgb = [200, 60, 50];
const BLUE: Rgb = [50, 110, 210];
const CREAM: Rgb = [240, 226, 200];

/** The sample rate and length of the engine loop the fixture writes. */
const WAV_RATE = 8000;
const WAV_SECONDS = 1;
const ENGINE_HZ = 110;

/** One worker of the fixture: its bare pool id, title and task. */
interface Worker {
  id: string;
  title: string;
}

const W = (id: string, title: string): Worker => ({ id, title });
const READER = W("w0", "Study the shop");
const SIGN_PAINTER = W("w1", "Paint the shop sign");
const SOUNDS = W("w2", "Engine and tyre sounds");
const TRACK = W("w3", "Build the street track");
const SCHEMES = ["Flame", "Chrome", "Neon", "Camo", "Pearl"].map((name, n) => W(`w${4 + n}`, `${name} paint scheme`));
const REPAINT = W("w9", "Repaint the shop sign");
const DRIFT = W("w10", "Tune the drift");
const SMOKE = W("w11", "Add tyre smoke");
const HORN = W("w1", "Horn sound");

type Scoped = ReturnType<typeof fixtureRun>;

const started = (run: Scoped, worker: Worker, isolation: WorkerIsolation = WorkerIsolation.Copy) =>
  run(CustomEvent.WorkerStarted, {
    workerId: poolWorkerId(worker.id),
    title: worker.title,
    isolation,
    task: `${worker.title}.`,
  });
const ended = (run: Scoped, worker: Worker, state: WorkerEnd, summary: string) =>
  run(CustomEvent.WorkerFinished, {
    workerId: poolWorkerId(worker.id),
    title: worker.title,
    state,
    summary,
    delivered: state === WorkerEnd.Done,
  });
const verdict = (run: Scoped, worker: Worker, used: boolean, note: string | null = null) =>
  run(CustomEvent.WorkerFinished, {
    workerId: poolWorkerId(worker.id),
    title: worker.title,
    verdict: used ? WorkerVerdict.Used : WorkerVerdict.Rejected,
    ...(used ? { merged: true } : { note }),
  });

/** Where the fixture keeps its pictures: the run's folder, as the host keeps them. */
interface Pictures {
  builds: string[];
  signs: string[];
}

/** The four builds' screenshots and the two signs' kept pictures, written under the run's folder. */
async function writePictures(runsRoot: string): Promise<Pictures> {
  const runDir = path.join(runsRoot, RUN);
  await fs.mkdir(path.join(runDir, "director"), { recursive: true });
  await fs.mkdir(path.join(runDir, "deliveries"), { recursive: true });
  const street = gradientShot(SKY, ROAD);
  const shots = [street, street, gradientShot(DUSK, ROAD), gradientShot(NIGHT, NIGHT)];
  const builds = await Promise.all(
    shots.map(async (data, n) => {
      const file = path.join(runDir, "director", `build_${n + 1}.png`);
      await fs.writeFile(file, data);
      return file;
    }),
  );
  const signs = await Promise.all(
    [gradientShot(RED, CREAM), gradientShot(BLUE, CREAM)].map(async (data, n) => {
      const file = path.join(runDir, "deliveries", `job-sign-${n + 1}.png`);
      await fs.writeFile(file, data);
      return file;
    }),
  );
  return { builds, signs };
}

/** A second of a low engine hum: a real WAV, so the Assets tab draws its waveform. */
function engineLoop(): Buffer {
  const samples = WAV_RATE * WAV_SECONDS;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const hum =
      Math.sin((2 * Math.PI * ENGINE_HZ * i) / WAV_RATE) * 0.5 +
      Math.sin((4 * Math.PI * ENGINE_HZ * i) / WAV_RATE) * 0.2;
    data.writeInt16LE(Math.round(hum * 0x3fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(WAV_RATE, 24);
  header.writeUInt32LE(WAV_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The run's integration worktree of the game, holding what was merged into it and not landed yet. */
async function writeIntegration(core: StudioCore, project: string): Promise<void> {
  const game = core.games.dirFor(project);
  const integration = path.join(core.layout.scratch, "autopilot", RUN, "integration");
  await git(game, ["add", "-A"]);
  await git(game, ["commit", "-q", "--allow-empty", "-m", "fixture: before the Loop"]);
  await fs.mkdir(path.dirname(integration), { recursive: true });
  await git(game, ["worktree", "add", "-q", "--detach", integration]);
  await fs.mkdir(path.join(integration, "assets", "genex"), { recursive: true });
  await fs.writeFile(path.join(integration, SIGN), gradientShot(BLUE, CREAM));
  await fs.writeFile(path.join(integration, ENGINE), engineLoop());
}

/** A delivery into the run's build, as the host records it: the files, and its kept picture. */
function delivered(run: Scoped, project: string, worker: Worker, job: { id: string; file: string; picture?: string }) {
  const kind = job.file.endsWith(".wav") ? "audio" : "image";
  return run(CustomEvent.AssetDelivered, {
    project,
    source: "genex",
    pluginId: "genex",
    jobId: job.id,
    files: [{ file: job.file, bytes: 1, kind }],
    at: new Date().toISOString(),
    workspace: "build",
    facetId: worker.id,
    ...(job.picture ? { picture: job.picture } : {}),
  });
}

/** The integration head moving to build `n`, then its health check, as the seed's Loop records them. */
const checked = (run: Scoped, n: number, pictures: Pictures, extra: Record<string, unknown> = {}): EventData[] => [
  run(CustomEvent.DirectorProgress, { head: HEADS[n - 1] }),
  run(CustomEvent.IntegrationHealth, {
    head: HEADS[n - 1],
    ok: true,
    problems: [],
    findings: [],
    picture: pictures.builds[n - 1],
    ...extra,
  }),
];

/** The Loop up to its second build: the reader, the sign and the sounds; a track the lead did not use. */
function firstBuilds(run: Scoped, project: string, pictures: Pictures): EventData[] {
  return [
    run(CustomEvent.RunStarted, { goal: ASK, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 8, facets: [], workerRecords: true }),
    started(run, READER, WorkerIsolation.Read),
    started(run, SIGN_PAINTER),
    ended(run, READER, WorkerEnd.Done, "The shop needs a sign and a paint menu."),
    delivered(run, project, SIGN_PAINTER, { id: "job-sign-1", file: SIGN, picture: pictures.signs[0] }),
    ended(run, SIGN_PAINTER, WorkerEnd.Done, "Painted a red shop sign."),
    ...checked(run, 1, pictures, { worker: poolWorkerId(SIGN_PAINTER.id) }),
    verdict(run, SIGN_PAINTER, true),
    started(run, SOUNDS),
    started(run, TRACK),
    delivered(run, project, SOUNDS, { id: "job-engine", file: ENGINE }),
    ended(run, SOUNDS, WorkerEnd.Done, "Made an engine loop."),
    ...checked(run, 2, pictures, { worker: poolWorkerId(SOUNDS.id) }),
    verdict(run, SOUNDS, true),
    ended(run, TRACK, WorkerEnd.Done, "Built a street track."),
    verdict(run, TRACK, false, "The track cut through the shop."),
  ];
}

/** Five paint schemes off Build 2, the repainted sign (Build 3), the lead's blank Build 4, two at work. */
function laterBuilds(run: Scoped, project: string, pictures: Pictures): EventData[] {
  const schemes = SCHEMES.flatMap((worker, n) =>
    n % 2
      ? [started(run, worker), ended(run, worker, WorkerEnd.Stopped, "Stopped by the lead.")]
      : [
          started(run, worker),
          ended(run, worker, WorkerEnd.Done, `Tried the ${worker.title.toLowerCase()}.`),
          verdict(run, worker, false, "Not this look."),
        ],
  );
  return [
    ...schemes,
    started(run, REPAINT),
    delivered(run, project, REPAINT, { id: "job-sign-2", file: SIGN, picture: pictures.signs[1] }),
    ended(run, REPAINT, WorkerEnd.Done, "Repainted the sign blue."),
    ...checked(run, 3, pictures, { worker: poolWorkerId(REPAINT.id) }),
    verdict(run, REPAINT, true),
    ...checked(run, 4, pictures, {
      ok: false,
      problems: ["the page's frame is blank: one flat colour, nothing drawn"],
      findings: [HealthFinding.Blank],
    }),
    started(run, DRIFT),
    started(run, SMOKE),
  ];
}

/** The finished Loop's two builds' screenshots, under its own run folder: the horn's merge, then the garage. */
async function writeDonePictures(runsRoot: string): Promise<string[]> {
  const dir = path.join(runsRoot, DONE_RUN, "director");
  await fs.mkdir(dir, { recursive: true });
  return Promise.all(
    [gradientShot(SKY, ROAD), gradientShot(DUSK, ROAD)].map(async (data, n) => {
      const file = path.join(dir, `build_${n + 1}.png`);
      await fs.writeFile(file, data);
      return file;
    }),
  );
}

/** A Loop that finished before this one: a horn worker merged into Build 1, the lead's own garage in Build 2, landed. */
function finishedLoop(project: string, pictures: string[]): EventData[] {
  const run = fixtureRun({ runId: DONE_RUN, project });
  const check = (n: number, extra: Record<string, unknown> = {}) =>
    run(CustomEvent.IntegrationHealth, {
      head: DONE_HEADS[n - 1],
      ok: true,
      problems: [],
      findings: [],
      picture: pictures[n - 1],
      ...extra,
    });
  return [
    run(CustomEvent.RunStarted, { goal: DONE_ASK, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 8, facets: [], workerRecords: true }),
    started(run, HORN),
    ended(run, HORN, WorkerEnd.Done, "Made a two-tone horn."),
    run(CustomEvent.DirectorProgress, { head: DONE_HEADS[0] }),
    check(1, { worker: poolWorkerId(HORN.id) }),
    verdict(run, HORN, true),
    run(CustomEvent.DirectorProgress, { head: DONE_HEADS[1] }),
    check(2),
    run(CustomEvent.RunFinished, {
      victory: true,
      landed: true,
      integrationHead: DONE_HEADS[1],
      executionStatus: ExecutionStatus.Completed,
      summary: "The car honks, and a garage stands at the end of the street.",
    }),
  ];
}

/** Whether the fixture game's chat already holds the run. */
async function seeded(core: StudioCore, threadId: string): Promise<boolean> {
  return (await core.store.listEvents(threadId)).some((e) => customRecord(e.data)?.payload.runId === RUN);
}

/** Seeds the Loop once, after the app has started; a reused profile keeps it. */
export async function seedBuildTimeline(core: StudioCore, project: string, threadId: string): Promise<void> {
  if (await seeded(core, threadId)) return;
  const pictures = await writePictures(core.layout.runs);
  const donePictures = await writeDonePictures(core.layout.runs);
  await writeIntegration(core, project);
  const run = fixtureRun({ runId: RUN, project });
  const asked: EventData[] = [
    { type: EventKind.Messages, messages: [{ role: "user", content: ASK }] },
    customEventData(CustomEvent.CoordinatorMessageQueued, { messageId: "fixture-timeline-ask", action: { text: ASK } }),
    customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId: "fixture-timeline-ask" }),
  ];
  await core.append(
    [
      ...finishedLoop(project, donePictures),
      ...asked,
      ...firstBuilds(run, project, pictures),
      ...laterBuilds(run, project, pictures),
    ],
    threadId,
  );
}
