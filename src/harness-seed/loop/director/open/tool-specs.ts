/**
 * The open lead's tools as its engine sees them: the director's `note` and `wrap_up` (read from its
 * list by name, so their words stay one), a `run_status` of its own under the director's name (what `openStatus`
 * answers, none of the web method's branch or boards), Genex's six worker tools with the kinds of worker the
 * project's plugins declare, its save points (`save_point`, `rewind`, and `restart` where a plugin
 * restarts the project's app), a `pause` for what only the person can do, and a `finish` of its own:
 * a claim a reviewer checks, with no landing.
 */
import type { LiveToolSpec, WorkerType } from "../../../types/host-api.d.ts";
import { secondOpinionSpec } from "../../second-opinion.ts";
import { workerTools } from "../../workers/specs.ts";
import { DirectorTool, NOTE_SPEC, WRAP_UP_SPEC } from "../tool-specs.ts";
import { MAX_SAVE_POINT_LABEL, OpenTool } from "./contract.ts";

/** One string property of a tool's schema. */
const text = (description: string) => ({ type: "string", description });

/** The open lead's `finish`: a claim on its word, or after a review it asks for; it closes the Loop in place. */
const OPEN_FINISH: LiveToolSpec = {
  name: DirectorTool.Finish,
  description:
    "Close the Loop with your summary: your word closes it. With review=yes a reviewer who did none of the work reads the project in its folder, your proof and Genex's captures first: its yes closes the Loop, its no comes back with its reasons and decides nothing. Call it with nothing else in the same turn.",
  parameters: {
    type: "object",
    properties: {
      summary: text("What the project holds now and what you checked: the person's report."),
      remaining: text("What is not done or not right yet, one item per line, for the person's report."),
      review: text("yes asks a reviewer for a second opinion before the Loop closes (default no)."),
      proof: text(
        "Comma-separated paths in the project's folder that show the goal is reached (a test report, a picture, a log).",
      ),
    },
    required: ["summary"],
  },
};

/** `save_point`: Genex's checkpoint of the folder now, under the lead's label. */
const SAVE_POINT: LiveToolSpec = {
  name: OpenTool.SavePoint,
  description:
    "Keep the project's folder as it is now in Genex's checkpoint: the project's plugins save their apps first, and their notes and pictures come back. rewind goes back to one.",
  parameters: {
    type: "object",
    properties: {
      label: text(`A few words naming what works now (at most ${MAX_SAVE_POINT_LABEL} characters).`),
      summary: text("What this save point holds, in one sentence."),
      shows: text("Optional: the path in the project's folder of a picture (PNG or JPEG) for this save point."),
    },
    required: ["label"],
  },
};

/** `rewind`: back to a save point, when the turn ends. */
const REWIND: LiveToolSpec = {
  name: OpenTool.Rewind,
  description:
    "Go back to one of your save points when this turn ends: Genex restores the folder (the project's plugins close and reopen their apps around it). Work since that save point leaves the folder.",
  parameters: {
    type: "object",
    properties: { label: text("The save point's label.") },
    required: ["label"],
  },
};

/** `restart`: the project's app closed and reopened, when the turn ends; no file changes. */
const RESTART: LiveToolSpec = {
  name: OpenTool.Restart,
  description:
    "Close and reopen the project's app when this turn ends (its plugin's restore steps, with no file changed): after changes the app only reads when it opens.",
  parameters: { type: "object", properties: { why: text("Why it needs a restart, in a few words.") } },
};

/** `pause`: the Loop pauses with the lead's words for the person, once its turn ends. */
const PAUSE: LiveToolSpec = {
  name: OpenTool.Pause,
  description:
    "Pause the Loop when the goal needs what only the person can do: a tool, editor or app the work needs is gone or can't run here and nothing you can call brings it back, or it needs an install or a sign-in. Never for a card waiting for their answer: only the call that asked waits. Genex pauses the Loop when this turn ends, with your words as the reason the person reads; their Resume wakes you. Don't spend the Loop's time on work that can't reach the project while such a block lasts.",
  parameters: {
    type: "object",
    properties: {
      why: text("What stops the goal and what the person should do, in two plain sentences."),
    },
    required: ["why"],
  },
};

/** The open lead's `run_status`: what `openStatus` answers, under the director's wire name. */
const OPEN_STATUS: LiveToolSpec = {
  name: DirectorTool.RunStatus,
  description:
    "The Loop's time left, your save points, your workers and the run's jobs, what the project's folder holds, and how often its app stopped. Read it when the wake message is stale.",
  parameters: { type: "object", properties: {} },
};

/**
 * The open lead's tools, with `worker_start` naming the kinds of worker on offer and how many may run
 * at once (`workers`, when the pool knows it), `restart` only when `restart`, and the second opinion
 * (`judge`) on pictures the lead names.
 */
export function openTools(
  types: readonly WorkerType[] = [],
  { restart = false, workers }: { restart?: boolean; workers?: number } = {},
): LiveToolSpec[] {
  const saves = restart ? [SAVE_POINT, REWIND, RESTART] : [SAVE_POINT, REWIND];
  const shared = [NOTE_SPEC, WRAP_UP_SPEC];
  return [...shared, OPEN_STATUS, ...workerTools(types, workers), ...saves, secondOpinionSpec(), PAUSE, OPEN_FINISH];
}
