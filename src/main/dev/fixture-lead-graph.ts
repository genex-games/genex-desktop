/**
 * The `lead-graph` fixture: two runs of the Unreal Loop's lead for the Builds graph to draw, in the
 * records the seed's `loop/unreal/lead-graph.ts` writes. The lead's milestones are columns, each
 * save point a round it kept itself, its sub-agents parts with their asset cards (a Blender model
 * used in a save, a texture delivered and waiting, a cast that failed), and the critic's advice on a
 * round. One run finished; the other still runs, a milestone and a sub-agent at work.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CustomEvent } from "../../shared/custom-events.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun, gradientShot, type Rgb, roundShotDir } from "./fixture-kit.ts";

const SLATE: Rgb = [46, 52, 60];
const FOG: Rgb = [150, 160, 172];
const EMBER: Rgb = [196, 112, 64];
const STEEL: Rgb = [120, 128, 140];

const GOAL =
  "A lighthouse keeper on a stormy coast, a katana at hand: wet stone, a sweeping beam, warm windows, fog over the water.";

/** The two runs: a finished one, then one still running (the graph shows the latest). */
const RUNS = [
  ["fixture-lead-done", false],
  ["fixture-lead-live", true],
] as const;

/** The verdict source and the merge stage the lead's records carry (the seed's `VerdictSource.Lead`, `MergeStage.Editor`). */
const LEAD_SOURCE = "lead";
const EDITOR_STAGE = "editor";

/** One run: its id, its records and where it keeps its captures. */
interface LeadRun {
  runId: string;
  run: ReturnType<typeof fixtureRun>;
  runsRoot: string;
}

/** Seeds both runs once: a profile reused after its first start keeps them. */
export async function seedLeadGraph(core: StudioCore, project: string, threadId: string): Promise<void> {
  const seeded = (await core.store.listEvents(threadId)).some(
    (e) => e.data.type === EventKind.Custom && (e.data.payload as { runId?: string })?.runId === RUNS[0][0],
  );
  if (seeded) return;
  for (const [runId, live] of RUNS) {
    const lead: LeadRun = { runId, run: fixtureRun({ runId, project }), runsRoot: core.layout.runs };
    const events = [...(await opening(lead)), ...(live ? stillRunning(lead) : await finished(lead))];
    await core.append(events, threadId);
  }
}

/** A column or a sub-agent as the graph's worker record. */
function worker(lead: LeadRun, workerId: string, title: string, state: string, extra: Record<string, unknown> = {}) {
  return lead.run(CustomEvent.DirectorWorker, { workerId, title, mode: "single", state, ...extra });
}

/** A part's work merged into the game folder, under a save point's snapshot. */
function merge(lead: LeadRun, facetId: string, round: number, snapshot: string): EventData {
  return lead.run(CustomEvent.IntegrationMerge, {
    facetId,
    round,
    iteration: round,
    snapshot,
    conflict: false,
    stage: EDITOR_STAGE,
  });
}

/** One save point: its round (the lead kept it itself), its hero shots and its merge. */
async function savePoint(
  lead: LeadRun,
  part: { id: string; title: string },
  spec: { round: number; label: string; summary: string; from: Rgb; to: Rgb },
): Promise<EventData[]> {
  const snapshot = `${lead.runId}-${part.id}-${spec.round}`;
  return [
    lead.run(CustomEvent.FacetIteration, {
      facetId: part.id,
      facetTitle: part.title,
      iteration: spec.round,
      winner: "challenger",
      verdictSource: LEAD_SOURCE,
      reason: spec.summary,
      satisfied: false,
      summary: spec.summary,
      label: spec.label,
      snapshot,
      shots: await heroShots(lead, part.id, spec.round, spec.from, spec.to),
      logErrors: [],
      auto: false,
      move: { what: `${spec.label}: ${spec.summary}`, delivered: true },
    }),
    merge(lead, part.id, spec.round, snapshot),
  ];
}

/** A save point's two hero cameras, written the way the run's stills are kept. */
async function heroShots(lead: LeadRun, facetId: string, round: number, from: Rgb, to: Rgb) {
  const dir = roundShotDir(lead.runsRoot, lead.runId, facetId, round);
  await fs.mkdir(dir, { recursive: true });
  const vista = path.join(dir, "c1_GX_Shot_Vista.jpg");
  const hero = path.join(dir, "c2_GX_Shot_Hero.jpg");
  await fs.writeFile(vista, gradientShot(from, to));
  await fs.writeFile(hero, gradientShot(to, from));
  return [
    { camera: "GX_Shot_Vista", path: vista, tone: null },
    { camera: "GX_Shot_Hero", path: hero, tone: null },
  ];
}

/** A sub-agent's plugin job, as the host records a call attributed to the agent's part. */
async function agentJob(
  lead: LeadRun,
  part: string,
  job: { plugin: "genex" | "blender"; file: string; prompt: string },
) {
  const names = job.plugin === "genex" ? ["Genex Tools", "asset"] : ["Local Blender", "model"];
  const [pluginName = "", tool = ""] = names;
  const call = {
    callId: `${part}-call`,
    pluginId: job.plugin,
    pluginName,
    tool,
    toolName: `${job.plugin}__${tool}`,
    args: `prompt=${job.prompt}`,
    facetId: part,
    engine: EngineId.ClaudeCode,
    role: "builder",
  };
  const render = path.join(lead.runsRoot, lead.runId, "agents", `${part}.png`);
  await fs.mkdir(path.dirname(render), { recursive: true });
  await fs.writeFile(render, gradientShot(STEEL, EMBER));
  const at = "2026-10-06T10:20:00.000Z";
  return [
    lead.run(CustomEvent.PluginToolStarted, { ...call, at }),
    lead.run(CustomEvent.PluginTool, {
      ...call,
      at,
      ok: true,
      result: "{}",
      images: 0,
      durationMs: 4200,
      jobId: `${part}-job`,
      files: [job.file],
    }),
    lead.run(CustomEvent.AssetDelivered, {
      source: job.plugin,
      pluginId: job.plugin,
      jobId: `${part}-job`,
      files: [{ file: job.file, bytes: 204_800, kind: job.plugin === "genex" ? "image" : "model" }],
      at,
      render,
      facetId: part,
      workspace: "build",
    }),
  ];
}

const KATANA = { id: "agent-blender_model-1", title: "Blender: Katana" };
const CONCRETE = { id: "agent-texture-1", title: "Texture: Wet concrete" };
const GOBLIN = { id: "agent-genex_cast-1", title: "Meshy: Goblin" };
const LEAD = { id: "lead", title: "Lead" };
const ATMOSPHERE = { id: "lead-atmosphere", title: "Lead · Atmosphere" };
const COMBAT = { id: "lead-combat", title: "Lead · Katana combat" };

/** Both runs alike: the greybox saved as the lead, the atmosphere milestone, three sub-agents and the critic. */
async function opening(lead: LeadRun): Promise<EventData[]> {
  const { run } = lead;
  return [
    run(CustomEvent.RunStarted, {
      goal: GOAL,
      engine: EngineId.ClaudeCode,
      model: FIXTURE_MODEL,
      budgets: { wallClockMs: 10_800_000 },
    }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 3, facets: [] }),
    ...(await savePoint(lead, LEAD, {
      round: 1,
      label: "Greybox",
      summary: "the lighthouse blocked out in grey",
      from: SLATE,
      to: SLATE,
    })),
    worker(lead, ATMOSPHERE.id, ATMOSPHERE.title, "running"),
    worker(lead, KATANA.id, KATANA.title, "running"),
    worker(lead, CONCRETE.id, CONCRETE.title, "running"),
    ...(await agentJob(lead, KATANA.id, {
      plugin: "blender",
      file: "assets/agents/blender_model-1/katana.glb",
      prompt: "katana",
    })),
    ...(await agentJob(lead, CONCRETE.id, {
      plugin: "genex",
      file: "assets/agents/texture-1/concrete.png",
      prompt: "wet concrete",
    })),
    worker(lead, KATANA.id, KATANA.title, "done", { delivered: true }),
    worker(lead, CONCRETE.id, CONCRETE.title, "done", { delivered: true }),
    worker(lead, GOBLIN.id, GOBLIN.title, "running"),
    worker(lead, GOBLIN.id, GOBLIN.title, "failed", { stoppedBecause: "the model stopped before it delivered" }),
    ...(await savePoint(lead, ATMOSPHERE, {
      round: 1,
      label: "Fog and light",
      summary: "volumetric fog, one cold key light from the beam",
      from: FOG,
      to: SLATE,
    })),
    merge(lead, KATANA.id, 1, `${lead.runId}-${ATMOSPHERE.id}-1`),
    run(CustomEvent.DirectorVerdict, {
      advice: true,
      facetId: ATMOSPHERE.id,
      iteration: 1,
      at: "2026-10-06T10:40:00.000Z",
      defects: [
        { defect: "The far walls are as dark as the near ones", fix: "Lift the fog's far colour toward grey-blue" },
        { defect: "Nothing moves in the air", fix: "Add slow spray in the lighthouse beam" },
      ],
      boldMove: "Drop the camera to the rocks below the lighthouse and look straight up",
      gates: ["Light: yes — one cold key light from the beam", "Atmosphere: no — no depth by value yet"],
      shots: ["vista.png"],
    }),
    worker(lead, ATMOSPHERE.id, ATMOSPHERE.title, "done"),
    worker(lead, COMBAT.id, COMBAT.title, "running"),
  ];
}

/** The finished run: the katana in hand, saved, and the close. */
async function finished(lead: LeadRun): Promise<EventData[]> {
  const { run } = lead;
  return [
    ...(await savePoint(lead, COMBAT, {
      round: 1,
      label: "Katana in hand",
      summary: "the combo with the katana attached",
      from: EMBER,
      to: SLATE,
    })),
    worker(lead, COMBAT.id, COMBAT.title, "done"),
    run(CustomEvent.RunFinished, {
      mode: "director",
      landed: true,
      stoppedBecause: "time-up",
      executionStatus: ExecutionStatus.Completed,
      // The seed's own close sentence (`leadCloseSentence` in loop/unreal/lead-graph.ts), held to it by run-graph-lead.test.ts.
      summary:
        "3 save points; the last, Katana in hand: the combo with the katana attached. 2 sub-agents delivered, 1 used in the game; 1 didn't deliver.",
    }),
  ];
}

/** The live run: the combat milestone at work, and a sound sub-agent working beside it. */
function stillRunning(lead: LeadRun): EventData[] {
  return [worker(lead, "agent-sound-1", "Sound: Blade swings", "running")];
}
