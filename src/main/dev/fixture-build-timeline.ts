/**
 * The `build-timeline` fixture: a web game's Loop still going in the game folder, as every Loop
 * works, whose lead kept four save points, for the Builds graph's line, its compares and the game's
 * Assets tab during a run.
 *
 * - Save point 1 after the shop sign merged, 2 after the engine sounds (no picture changed: its
 *   checkpoint's picture is 1's to the byte), 3 after a repainted sign (the same file delivered again,
 *   its kept picture from the same view), 4 the lead's own night street.
 * - Thirteen workers: a reader that started before the first save point, the four merged ones, a
 *   track the lead did not use, five paint schemes off save point 2 (not used or stopped; three fold
 *   behind "+3 workers"), and two still at work off save point 4.
 * - The shop's props worker made a paint can, a price tag, the paint can again and a lamp: three
 *   asset cards under it, the paint can's with two versions. The unused track left its map in its
 *   copy, a ghost card under it.
 * - The person asked with a picture of a street at dusk. After save point 2 nothing was at work, so the
 *   Loop paused, and the chat went on with it for the person's next message and its picture of a
 *   blue sign: You asked is that ask, with that picture alone, though the game keeps both in
 *   `references/`.
 * - The sign and the sounds are delivered into the game folder: the Assets tab lists them in the game.
 * - Before it, a finished web Loop an earlier Genex ran, in Build history: a horn worker merged into
 *   Build 1 (its horn made twice, one sound card with two versions), the lead's own Build 2 checked at
 *   the finish, landed.
 *
 * Written after the app has started ({@link seedBuildTimeline}): the start closes every run an
 * earlier app left open, so a Loop written before it would read as stopped.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData, customRecord } from "../../shared/custom-events.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import type { AssetDeliveredPayload } from "../../shared/game-assets.ts";
import { LoopProfile } from "../../shared/project-facts.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../shared/workers.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun, gradientShot, type Rgb } from "./fixture-kit.ts";

const RUN = "fixture-timeline-run";
const ASK = "Build a street racer with a shop to buy paint for the car.";
/** The person's next message, sent while the Loop was paused, and the words the chat went on with it in. */
const GO_ON = "Make the shop sign blue, like this one.";
const WENT_ON_WITH = "Repaint the shop sign blue, as in the person's picture, and go on with the shop.";
const DONE_RUN = "fixture-timeline-done";
const DONE_ASK = "Give the car a horn, and a garage to park it in.";
const DONE_HEADS = ["e5", "f6"].map((seed) => seed.repeat(20));
const SIGN = "assets/genex/shop-sign.png";
const ENGINE = "assets/genex/engine-loop.wav";
const HORN_FILE = "assets/genex/horn.wav";
/** The lead's four save points, in order: their number and what each kept. */
const SAVE_POINTS = [
  { n: 1, label: "Shop sign", summary: "the red sign hangs over the paint shop" },
  { n: 2, label: "Engine sounds", summary: "the car hums and the tyres squeal" },
  { n: 3, label: "Blue sign", summary: "the sign repainted blue" },
  { n: 4, label: "Night street", summary: "the street at night" },
] as const;
const [SHOP_SIGN, ENGINE_SOUNDS, BLUE_SIGN, NIGHT_STREET] = SAVE_POINTS;

const SKY: Rgb = [150, 190, 230];
const ROAD: Rgb = [70, 74, 86];
const DUSK: Rgb = [228, 140, 90];
const NIGHT: Rgb = [14, 14, 18];
const RED: Rgb = [200, 60, 50];
const BLUE: Rgb = [50, 110, 210];
const CREAM: Rgb = [240, 226, 200];
const GREEN: Rgb = [60, 150, 90];

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
const PROPS = W("w12", "Paint the shop's props");

/** One asset a worker asked Genex for: its job, the file it landed as, what it was asked, and its picture's colours. */
interface Made {
  id: string;
  file: string;
  prompt: string;
  colours?: readonly [Rgb, Rgb];
}

/** What the props worker made, in turn: a paint can, a price tag, the paint can again (green now), a lamp. */
const PROP_JOBS: readonly Made[] = [
  { id: "job-can-1", file: "assets/genex/paint-can.png", prompt: "Paint can", colours: [RED, CREAM] },
  { id: "job-tag", file: "assets/genex/price-tag.png", prompt: "Price tag", colours: [CREAM, ROAD] },
  { id: "job-can-2", file: "assets/genex/paint-can.png", prompt: "Paint can", colours: [GREEN, CREAM] },
  { id: "job-lamp", file: "assets/genex/shop-lamp.png", prompt: "Shop lamp", colours: [DUSK, NIGHT] },
];
/** What the track worker the lead did not use left in its copy. */
const TRACK_MAP: Made = {
  id: "job-track-map",
  file: "assets/genex/track-map.png",
  prompt: "Track map",
  colours: [ROAD, SKY],
};
/** The finished Loop's horn, made twice: one sound, two versions. */
const HORN_JOBS: readonly Made[] = [
  { id: "job-horn-1", file: HORN_FILE, prompt: "Two-tone horn" },
  { id: "job-horn-2", file: HORN_FILE, prompt: "Two-tone horn" },
];

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
  /** the kept picture of each pictured job the workers asked for, by its job */
  made: Map<string, string>;
}

/** The four save points' checkpoint pictures and the two signs' kept pictures, written under the run's folder. */
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
  const made = new Map<string, string>();
  for (const job of [...PROP_JOBS, TRACK_MAP]) {
    if (!job.colours) continue;
    const file = path.join(runDir, "deliveries", `${job.id}.png`);
    await fs.writeFile(file, gradientShot(...job.colours));
    made.set(job.id, file);
  }
  return { builds, signs, made };
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

/**
 * What the Loops wrote into the game folder itself: the sign, the sounds and the props, each file
 * as its newest delivery left it, and the finished Loop's horn.
 */
async function writeGameFiles(core: StudioCore, project: string): Promise<void> {
  const game = core.games.dirFor(project);
  await fs.mkdir(path.join(game, "assets", "genex"), { recursive: true });
  await fs.writeFile(path.join(game, SIGN), gradientShot(BLUE, CREAM));
  await fs.writeFile(path.join(game, ENGINE), engineLoop());
  await fs.writeFile(path.join(game, HORN_FILE), engineLoop());
  for (const job of PROP_JOBS)
    if (job.colours) await fs.writeFile(path.join(game, job.file), gradientShot(...job.colours));
}

/** Where a delivery landed: the game folder, or (a worker the lead did not use) only its own copy. */
type Workspace = NonNullable<AssetDeliveredPayload["workspace"]>;

/** A delivery, as the host records it: the files, where they landed, and its kept picture. */
function delivered(
  run: Scoped,
  project: string,
  worker: Worker,
  job: { id: string; file: string; picture?: string },
  workspace: Workspace = "game",
) {
  const kind = job.file.endsWith(".wav") ? "audio" : "image";
  return run(CustomEvent.AssetDelivered, {
    project,
    source: "genex",
    pluginId: "genex",
    jobId: job.id,
    files: [{ file: job.file, bytes: 1, kind }],
    at: new Date().toISOString(),
    workspace,
    facetId: worker.id,
    ...(job.picture ? { picture: job.picture } : {}),
  });
}

/** A worker asking Genex for one asset, as the host records the call: asked, delivered, come back. */
function madeByCall(
  run: Scoped,
  project: string,
  worker: Worker,
  job: Made & { picture?: string },
  workspace: Workspace = "game",
): EventData[] {
  const callId = `call-${job.id}`;
  return [
    run(CustomEvent.PluginToolStarted, {
      callId,
      pluginId: "genex",
      pluginName: "Genex",
      tool: "asset",
      facetId: worker.id,
      args: `operation=${job.file.endsWith(".wav") ? "sound" : "image"} prompt=${job.prompt}`,
    }),
    delivered(run, project, worker, job, workspace),
    run(CustomEvent.PluginTool, { callId, facetId: worker.id, ok: true, jobId: job.id, files: [job.file] }),
  ];
}

/** The lead's own row on the graph, as the Loop writes it (open/graph.ts). */
const LEAD_ROW = { workerId: "lead", title: "Lead", mode: "single" } as const;
/** The verdict source a save point's round carries (the seed's `SAVE_POINT_VERDICT_SOURCE`). */
const SAVE_POINT_SOURCE = "lead";

/** A save point of the lead, with its checkpoint's picture, as the Loop records it: a kept round of the lead's row and its merge into the folder. */
function savePoint(
  run: Scoped,
  project: string,
  { n, label, summary }: (typeof SAVE_POINTS)[number],
  pictures: Pictures,
): EventData[] {
  const snapshot = `fixture-save-${n}`;
  return [
    run(CustomEvent.FacetIteration, {
      facetId: LEAD_ROW.workerId,
      facetTitle: LEAD_ROW.title,
      iteration: n,
      winner: "challenger",
      verdictSource: SAVE_POINT_SOURCE,
      reason: summary,
      satisfied: false,
      summary,
      label,
      snapshot,
      shots: [{ camera: "view", path: pictures.builds[n - 1] }],
      auto: false,
      move: { what: `${label}: ${summary}`, delivered: true },
    }),
    run(CustomEvent.IntegrationMerge, {
      project,
      facetId: LEAD_ROW.workerId,
      round: n,
      iteration: n,
      snapshot,
      conflict: false,
    }),
  ];
}

/** The props worker's four jobs, each with its kept picture. */
const propsMade = (run: Scoped, project: string, pictures: Pictures): EventData[] =>
  PROP_JOBS.flatMap((job) => madeByCall(run, project, PROPS, { ...job, picture: pictures.made.get(job.id) }));

/** The Loop up to its second save point: the reader, the sign, the sounds and the props; a track the lead did not use. */
function firstBuilds(run: Scoped, project: string, pictures: Pictures): EventData[] {
  return [
    run(CustomEvent.RunStarted, { goal: ASK, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, {
      director: true,
      maxParallel: 8,
      facets: [],
      workerRecords: true,
      liveChat: true,
      profile: LoopProfile.Open,
    }),
    run(CustomEvent.DirectorWorker, { ...LEAD_ROW, state: "running" }),
    started(run, READER, WorkerIsolation.Read),
    started(run, SIGN_PAINTER),
    ended(run, READER, WorkerEnd.Done, "The shop needs a sign and a paint menu."),
    delivered(run, project, SIGN_PAINTER, { id: "job-sign-1", file: SIGN, picture: pictures.signs[0] }),
    ended(run, SIGN_PAINTER, WorkerEnd.Done, "Painted a red shop sign."),
    verdict(run, SIGN_PAINTER, true),
    ...savePoint(run, project, SHOP_SIGN, pictures),
    started(run, SOUNDS),
    started(run, TRACK),
    started(run, PROPS),
    delivered(run, project, SOUNDS, { id: "job-engine", file: ENGINE }),
    ended(run, SOUNDS, WorkerEnd.Done, "Made an engine loop."),
    verdict(run, SOUNDS, true),
    ...propsMade(run, project, pictures),
    ended(run, PROPS, WorkerEnd.Done, "Painted a paint can, a price tag and a lamp."),
    verdict(run, PROPS, true),
    ...savePoint(run, project, ENGINE_SOUNDS, pictures),
    ...madeByCall(run, project, TRACK, { ...TRACK_MAP, picture: pictures.made.get(TRACK_MAP.id) }, "build"),
    ended(run, TRACK, WorkerEnd.Done, "Built a street track."),
    verdict(run, TRACK, false, "The track cut through the shop."),
  ];
}

/** A message the person sent with one picture, as a send keeps it: the picture in the game's `references/`. */
interface SentPicture {
  messageId: string;
  text: string;
  label: string;
  from: Rgb;
  to: Rgb;
}

const FIRST_ASK: SentPicture = {
  messageId: "fixture-timeline-ask",
  text: ASK,
  label: "Street at dusk",
  from: DUSK,
  to: ROAD,
};
const GOING_ON: SentPicture = {
  messageId: "fixture-timeline-go-on",
  text: GO_ON,
  label: "Blue sign",
  from: BLUE,
  to: CREAM,
};

/** The person's message, its picture kept for the chat and saved in the game, queued, begun and answered. */
async function sentWithPicture(
  core: StudioCore,
  project: string,
  threadId: string,
  sent: SentPicture,
): Promise<EventData[]> {
  const { messageId, text } = sent;
  const still = { label: sent.label, mimeType: "image/png", data: gradientShot(sent.from, sent.to).toString("base64") };
  const attachmentsArtifact = `message_attachments_${messageId}`;
  await core.store.writeArtifact(threadId, attachmentsArtifact, { stills: [still] });
  await core.saveReferenceFrames(project, [still]);
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: text }] },
    customEventData(CustomEvent.CoordinatorMessageQueued, {
      messageId,
      action: { text, attachmentsArtifact, imageCount: 1 },
    }),
    customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId }),
    // Its turn ended once it started (or went on with) the build: a restart does not answer it again.
    customEventData(CustomEvent.CoordinatorMessageHandled, { messageId }),
  ];
}

/**
 * Nothing at work after save point 2: the Loop paused for the person's next word, and the chat went
 * on with it (`resume_run`: its words on the run, then the run's start again).
 */
function wentOn(run: Scoped, goingOn: EventData[]): EventData[] {
  return [
    run(CustomEvent.RunFinished, { victory: false, landed: false, executionStatus: ExecutionStatus.Paused }),
    ...goingOn,
    run(CustomEvent.RunSteering, { text: WENT_ON_WITH, sourceMessageId: GOING_ON.messageId }),
    run(CustomEvent.RunStarted, { goal: ASK, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL, resumed: true }),
  ];
}

/** Five paint schemes off save point 2, the repainted sign (save point 3), the lead's own night street (4), two at work. */
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
    verdict(run, REPAINT, true),
    ...savePoint(run, project, BLUE_SIGN, pictures),
    ...savePoint(run, project, NIGHT_STREET, pictures),
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
    ...HORN_JOBS.flatMap((job) => madeByCall(run, project, HORN, job)),
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
  await writeGameFiles(core, project);
  const run = fixtureRun({ runId: RUN, project });
  const asked = await sentWithPicture(core, project, threadId, FIRST_ASK);
  const goingOn = await sentWithPicture(core, project, threadId, GOING_ON);
  await core.append(
    [
      ...finishedLoop(project, donePictures),
      ...asked,
      ...firstBuilds(run, project, pictures),
      ...wentOn(run, goingOn),
      ...laterBuilds(run, project, pictures),
    ],
    threadId,
  );
}
