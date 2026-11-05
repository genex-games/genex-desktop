/**
 * The one tool list of every Loop's lead, as its engine sees it: `note` and `wrap_up`, `run_status`
 * (what `openStatus` answers), Genex's six worker tools with the kinds of worker the project's plugins
 * declare, its save points (`save_point`, `rewind`, and `restart` where a plugin restarts the
 * project's app), a second opinion (`judge`), a `pause` for what only the person can do, and `finish`:
 * a claim, on the lead's word or after a review it asks for.
 */
import type { LiveToolSpec, WorkerType } from "../../../types/host-api.d.ts";
import { secondOpinionSpec } from "../../second-opinion.ts";
import { workerTools } from "../../workers/specs.ts";
import { DirectorTool, NOTE_SPEC, WRAP_UP_SPEC } from "../tool-specs.ts";
import { MAX_SAVE_POINT_LABEL, OpenTool } from "./contract.ts";

/** One string property of a tool's schema. */
const text = (description: string) => ({ type: "string", description });

/** The lead's `finish`: a claim on its word, or after a review it asks for; it closes the Loop in place. */
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

/** What `save_point` keeps where no plugin saves the project's app before the checkpoint. */
const FILES_ONLY =
  "No plugin saves this project's app: the checkpoint keeps the files on disk only, so save inside the app first.";

/** `save_point`: Genex's checkpoint of the folder now, under the lead's label. */
const SAVE_POINT: LiveToolSpec = {
  name: OpenTool.SavePoint,
  description:
    "Keep the project's folder as it is now in Genex's checkpoint: the project's plugins save their apps first, and their notes and pictures come back. rewind goes back to one.",
  parameters: {
    type: "object",
    properties: {
      label: text(
        `A few words naming what the player gets now: the person sees it as a done step on the Building card (at most ${MAX_SAVE_POINT_LABEL} characters).`,
      ),
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

/** What `restart` does too on a project with an Unreal project in it. */
const RESTART_REBUILDS = "It rebuilds the game's C++ source as the app reopens.";

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
    "Pause the Loop when the goal needs what only the person can do: a tool, editor or app the work needs is gone or can't run here and nothing you can call brings it back, or it needs their password, a system permission prompt or a payment. When you have the desktop tool, an install or a click in a launcher, a store or an installer is yours, never a reason to pause. Never for a card waiting for their answer: only the call that asked waits. Genex pauses the Loop when this turn ends, with your words as the reason the person reads; their Resume wakes you. Don't spend the Loop on work that can't reach the project while such a block lasts.",
  parameters: {
    type: "object",
    properties: {
      why: text("What stops the goal and what the person should do, in two plain sentences."),
    },
    required: ["why"],
  },
};

/** The lead's `run_status`: what `openStatus` answers. */
const OPEN_STATUS: LiveToolSpec = {
  name: DirectorTool.RunStatus,
  description:
    "Your save points, your workers and the run's jobs, what the project's folder holds, and how often its app stopped.",
  parameters: { type: "object", properties: {} },
};

/** What the project makes of the lead's save points: whether a plugin saves its app first, restarts it, and rebuilds its C++. */
interface OpenProject {
  restart?: boolean;
  workers?: number;
  /** A plugin saves the project's app before Genex's checkpoint (`checkpoint.before`). */
  appSaved?: boolean;
  /** A restart rebuilds the game's C++ too (a project with an Unreal project in it). */
  cppRestart?: boolean;
}

/** A tool with a sentence after its own description. */
const saying = (tool: LiveToolSpec, more: string): LiveToolSpec => ({
  ...tool,
  description: `${tool.description} ${more}`,
});

/**
 * The lead's tools on every project, with `worker_start` naming the kinds of worker on offer and how many may run
 * at once (`workers`, when the pool knows it), `save_point` saying it keeps only the files where no
 * plugin saves the app, `restart` only when `restart` (saying it rebuilds C++ where it does), and the
 * second opinion (`judge`) on pictures the lead names.
 */
export function openTools(
  types: readonly WorkerType[] = [],
  { restart = false, workers, appSaved = true, cppRestart = false }: OpenProject = {},
): LiveToolSpec[] {
  const savePoint = appSaved ? SAVE_POINT : saying(SAVE_POINT, FILES_ONLY);
  const restartTool = cppRestart ? saying(RESTART, RESTART_REBUILDS) : RESTART;
  const saves = restart ? [savePoint, REWIND, restartTool] : [savePoint, REWIND];
  const shared = [NOTE_SPEC, WRAP_UP_SPEC];
  return [...shared, OPEN_STATUS, ...workerTools(types, workers), ...saves, secondOpinionSpec(), PAUSE, OPEN_FINISH];
}
