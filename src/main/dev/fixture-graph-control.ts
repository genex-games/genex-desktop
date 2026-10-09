import { setTimeout as sleep } from "node:timers/promises";
import { type AgentScreenFrame, type ScreenAct, ScreenDeed } from "../../shared/agent-screen.ts";
import { CustomEvent, customEvent, customEventData } from "../../shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../shared/event-log.ts";
import { DevProviders, FixtureName, gradientShot, type Rgb, SHOT } from "./fixture-kit.ts";
import { DevError, DevErrorCode, GraphFixtureAction } from "./protocol.ts";

const FRAME_COUNT = 20;
const FRAME_INTERVAL_MS = 16;
/** Worker frames come a little apart, so each reads as its own moment on the trail. */
const WORKER_FRAME_INTERVAL_MS = 250;
const RUN_ID = "performance-run";
const PROJECT = "fixture-game";

/** The fixed fixture stimulus needs only append and preview pushes; it cannot call arbitrary tools. */
export interface GraphFixtureHost {
  thread(): Promise<string>;
  events(thread: string): Promise<EventEnvelope[]>;
  append(events: EventData[], thread: string): Promise<unknown>;
  frame(frame: AgentScreenFrame): void;
  close(frame: AgentScreenFrame): void;
  changed(): void;
}

/** Mutate only the explicitly owned large graph fixture, with fixed synthetic payloads. */
export async function applyGraphFixture(
  identity: { providers: string; fixture?: string | null },
  action: GraphFixtureAction,
  host: GraphFixtureHost,
): Promise<{ action: GraphFixtureAction; count: number }> {
  if (identity.providers !== DevProviders.Fixture || identity.fixture !== FixtureName.LargeBuildGraph)
    throw new DevError(DevErrorCode.MissingPrerequisite, "requires the large-build-graph fixture");
  if (action === GraphFixtureAction.OtherProjectFrames) return otherProjectFrames(host);
  if (action === GraphFixtureAction.WorkerFrames) return workerAtWork(host);
  const thread = await host.thread();
  const events = await host.events(thread);
  const iteration =
    events.reduce((largest, event) => {
      const round = customEvent(event, CustomEvent.FacetIteration);
      return round?.runId === RUN_ID && round.facetId === "part-0" ? Math.max(largest, round.iteration ?? 0) : largest;
    }, 0) + 1;
  const payload = { runId: RUN_ID, project: PROJECT, facetId: "part-0", facetTitle: "Part 0", iteration };
  await host.append(
    [
      customEventData(CustomEvent.FacetMove, {
        ...payload,
        what: `Appended step ${iteration}`,
        milestoneId: `appended-${iteration}`,
        source: "milestone",
      }),
      customEventData(CustomEvent.FacetBuildStarted, payload),
      customEventData(CustomEvent.FacetIteration, { ...payload, winner: "challenger", satisfied: false }),
    ],
    thread,
  );
  host.changed();
  return { action, count: 3 };
}

/** The run a builder is at work in: a fresh one, since a launch settles every run no harness holds. */
const WORKER_RUN = { runId: "screens-run", facetId: "jump-pad", facetTitle: "Jump pad" } as const;

/**
 * A running run whose one part has a try in hand, and its builder at the screen: one frame per
 * deed, the cursor moving, the window left open so its node keeps showing it.
 */
async function workerAtWork(host: GraphFixtureHost) {
  const thread = await host.thread();
  const payload = { ...WORKER_RUN, project: PROJECT, iteration: 1 };
  await host.append(
    [
      customEventData(CustomEvent.RunStarted, { runId: WORKER_RUN.runId, project: PROJECT, goal: "Bounce higher" }),
      customEventData(CustomEvent.FacetMove, { ...payload, what: "Higher bounce", source: "milestone" }),
      customEventData(CustomEvent.FacetBuildStarted, payload),
    ],
    thread,
  );
  host.changed();
  return workerFrames(host);
}

/** What the builder does at its screen, in order, and the colours of each picture. */
const WORKER_ACTS: ReadonlyArray<{ act: ScreenAct; from: Rgb; to: Rgb }> = [
  { act: { deed: ScreenDeed.Load }, from: [142, 197, 232], to: [79, 127, 58] },
  { act: { deed: ScreenDeed.Click }, from: [142, 197, 232], to: [121, 180, 148] },
  { act: { deed: ScreenDeed.Press, keys: ["ArrowRight"] }, from: [240, 178, 122], to: [79, 127, 58] },
  { act: { deed: ScreenDeed.Look }, from: [36, 59, 74], to: [121, 180, 148] },
  { act: { deed: ScreenDeed.Press, keys: ["space"] }, from: [142, 197, 232], to: [240, 138, 60] },
];

/** The builder's frames, a little apart so each reads as its own moment on the trail. */
async function workerFrames(host: GraphFixtureHost) {
  const screen = {
    handle: "fixture-worker-screen",
    label: WORKER_RUN.facetTitle,
    project: PROJECT,
    runId: WORKER_RUN.runId,
    facetId: WORKER_RUN.facetId,
    role: "builder" as const,
    width: 960,
    height: 540,
    caption: null,
  };
  for (const [index, step] of WORKER_ACTS.entries()) {
    host.frame({
      ...screen,
      jpeg: gradientShot(step.from, step.to).toString("base64"),
      cursor: { x: 240 + index * 120, y: 200 + index * 40 },
      act: step.act,
      at: Date.now(),
    });
    await sleep(WORKER_FRAME_INTERVAL_MS);
  }
  return { action: GraphFixtureAction.WorkerFrames, count: WORKER_ACTS.length };
}

async function otherProjectFrames(host: GraphFixtureHost) {
  const frame: AgentScreenFrame = {
    handle: "fixture-unrelated-screen",
    label: "Unrelated fixture worker",
    project: "fixture-other-project",
    runId: null,
    facetId: null,
    role: "builder",
    jpeg: SHOT.toString("base64"),
    width: 160,
    height: 90,
    cursor: { x: 0, y: 0 },
    caption: null,
    at: 0,
  };
  try {
    for (let index = 0; index < FRAME_COUNT; index++) {
      host.frame({ ...frame, at: Date.now(), cursor: { x: index, y: index } });
      await sleep(FRAME_INTERVAL_MS);
    }
  } finally {
    host.close(frame);
  }
  return { action: GraphFixtureAction.OtherProjectFrames, count: FRAME_COUNT };
}
