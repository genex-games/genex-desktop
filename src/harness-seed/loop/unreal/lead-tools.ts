/**
 * The Unreal lead's run tools, as its engine sees them (`LEAD_TOOLS`, flat string properties — both
 * bridges) and as the harness answers them: the studio's `director_tool` dispatch forwards each call
 * to the handler the run registers under its id (director/tool-specs.ts `directors`). `run_status`
 * and `note` are the director's own; the worker tools are Genex's one worker model (lead-workers.ts:
 * typed workers are agents.ts's, generic ones the run's shared pool's), the critic critic.ts's, and a
 * save point save-point.ts's. A rewind and a rebuild wait for the end of the lead's turn.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LiveToolSpec } from "../../types/host-api.d.ts";
import { hasText } from "../text.ts";
import { minutes } from "../time.ts";
import { agentStatus } from "./agents.ts";
import { askCritic } from "./critic.ts";
import { requiredText } from "./critic-prompts.ts";
import {
  AGENT_PART_PREFIX,
  AgentVerdict,
  LEAD_PART,
  type LeadMilestone,
  LeadTool,
  MAX_AGENT_WAIT_S,
  MAX_RUNNING_AGENTS,
} from "./lead-contract.ts";
import { milestoneColumn, tellUser } from "./lead-graph.ts";
import { type Lead, milestoneNow, requiredNow, saveLead } from "./lead-journal.ts";
import { LEAD_TOOL_WORDS, RUN_STATUS } from "./lead-prompts.ts";
import { workerTools } from "./lead-workers.ts";
import { savePoint } from "./save-point.ts";

/** A milestone's id as its graph column takes it: a short lowercase slug. */
const MILESTONE_ID_CHARS = 40;
/** How many save points `run_status` names, newest last. */
const STATUS_SAVE_POINTS = 8;

/** A string argument. */
const text = (description: string) => ({ type: "string", description });

/** The run tools the lead's session is offered, one per {@link LeadTool}. */
export const LEAD_TOOLS: LiveToolSpec[] = [
  {
    name: LeadTool.RunStatus,
    description:
      "Where the run stands: time left, the milestone, save points, workers and their states, credits spent.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: LeadTool.SavePoint,
    description:
      "Save after you have looked: Genex saves all in the editor, reads Unreal's new log errors, snapshots the game under this label and captures the hero cameras as thumbnails. Refused while the game plays. Answers the snapshot, the log errors and the thumbnails' tone numbers.",
    parameters: {
      type: "object",
      properties: {
        label: text("A short name for this save point, e.g. 'Atmosphere pass'."),
        summary: text("What the game holds now, in one line."),
      },
      required: ["label", "summary"],
    },
  },
  {
    name: LeadTool.Rewind,
    description:
      "Your own undo: when your turn ends, Genex closes Unreal, puts the game back to that save point and opens it again.",
    parameters: { type: "object", properties: { label: text("An earlier save point's label.") }, required: ["label"] },
  },
  {
    name: LeadTool.Milestone,
    description:
      "Name what you work on now; the Builds graph opens a column for it and your next save points land there.",
    parameters: {
      type: "object",
      properties: { id: text("A short slug."), title: text("What this milestone builds, in a few words.") },
      required: ["id", "title"],
    },
  },
  {
    name: LeadTool.WorkerStart,
    description: `Start a worker while you keep building. With a type (the kinds your brief lists, which the plugins that are on declare) it makes one thing in a copy of the game, at most ${MAX_RUNNING_AGENTS} at once, and delivers files and a manifest; Genex lands them and tells you. Without a type it is a worker from Genex's shared pool: isolation read (looks into the project), copy (writes in its own copy you merge with ${LeadTool.WorkerMark}) or lock (the one writer in place). Answers its id.`,
    parameters: {
      type: "object",
      properties: {
        title: text("What it makes, in a few words, without its kind: the graph shows it as 'Meshy: <title>'."),
        task: text("Its whole task: what to make, its size, style and pivot, and where it goes. It sees nothing else."),
        type: text("A worker type your brief lists; leave it out for a generic worker."),
        isolation: text("A generic worker only: read, copy or lock."),
        research: text("A generic worker only: yes lets it search the web (default no)."),
        inputs: text("Game-folder paths it should read, comma-separated (optional)."),
      },
      required: ["title", "task"],
    },
  },
  {
    name: LeadTool.WorkerStatus,
    description: "How one worker (or every one) is doing: state, time taken, and a typed worker's manifest when done.",
    parameters: { type: "object", properties: { id: text("The worker's id; leave it out for all.") } },
  },
  {
    name: LeadTool.WorkerWait,
    description: `Wait for one worker (or the first of them) to finish or to wait on the person, at most ${MAX_AGENT_WAIT_S} seconds.`,
    parameters: {
      type: "object",
      properties: {
        id: text("The worker's id; leave it out for the first to finish."),
        seconds: text(`How long, up to ${MAX_AGENT_WAIT_S}.`),
      },
      required: ["seconds"],
    },
  },
  {
    name: LeadTool.WorkerSteer,
    description:
      "Tell one generic worker something; it reads it now. A typed worker cannot be steered: stop it and start another.",
    parameters: {
      type: "object",
      properties: { id: text("The worker's id."), text: text("What it should hear.") },
      required: ["id", "text"],
    },
  },
  {
    name: LeadTool.WorkerStop,
    description:
      "Stop one worker. A typed worker's delivery whose manifest it wrote still lands; a generic worker's copy is kept for worker_mark.",
    parameters: {
      type: "object",
      properties: { id: text("The worker's id."), why: text("Why, in one line (optional).") },
      required: ["id"],
    },
  },
  {
    name: LeadTool.WorkerMark,
    description:
      "Say what you did with a worker's work, so its news stops repeating: a generic copy worker's used merges its copy.",
    parameters: {
      type: "object",
      properties: {
        id: text("The worker's id."),
        verdict: text(`One of ${Object.values(AgentVerdict).join(", ")}.`),
        note: text(
          "Why, in one line (optional). The person reads it in the chat beside the worker: plain words, no ids or tool names.",
        ),
      },
      required: ["id", "verdict"],
    },
  },
  {
    name: LeadTool.Critic,
    description:
      "Fresh eyes: a critic looks at your captures beside the references and ART.md and answers defects with fixes and one bold move. It advises; it never decides.",
    parameters: {
      type: "object",
      properties: {
        shots: text("Capture file names, comma-separated."),
        question: text("What you want judged (optional)."),
      },
      required: ["shots"],
    },
  },
  {
    name: LeadTool.RebuildUnreal,
    description:
      "Restart Unreal: when your turn ends, Genex saves, closes Unreal, builds the game's C++ (when it has any) and opens it again. After C++ changes in unreal/Source (never Live Coding), or when the editor renders differently from play (nearly black capture_shot frames while play looks right). End your turn soon after you ask.",
    parameters: { type: "object", properties: { reason: text("What changed, in one line.") }, required: ["reason"] },
  },
  {
    name: LeadTool.Note,
    description: "Leave the user a decision card in the run's feed: what you decided and why.",
    parameters: {
      type: "object",
      properties: {
        text: text("The card, in your own words."),
        plain: text("The same in one sentence for someone who has never seen a terminal."),
      },
      required: ["text"],
    },
  },
];

/** Where the run stands, as `run_status` and a handover say it. */
export function runStatusText(lead: Lead): string {
  const { journal } = lead;
  const left = minutes(Math.max(0, lead.softDeadline - lead.clock.now()));
  const labels = journal.savePoints.slice(-STATUS_SAVE_POINTS).map((point) => point.label);
  return [
    RUN_STATUS.Left(left),
    RUN_STATUS.Milestone(milestoneNow(journal).title),
    RUN_STATUS.SavePoints(labels),
    agentStatus(lead),
    RUN_STATUS.Credits(journal.credits.spent, journal.credits.cap),
    requiredText(requiredNow(journal)),
  ]
    .filter(Boolean)
    .join("\n");
}

/** A milestone id as the graph takes it: a lowercase slug that is neither the lead's own part nor a sub-agent's. */
function milestoneId(raw: string, count: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MILESTONE_ID_CHARS);
  const taken = !slug || slug === LEAD_PART || slug.startsWith(AGENT_PART_PREFIX);
  return taken ? `milestone-${count + 1}` : slug;
}

/** `milestone`: the lead works on this now; an id it named before becomes current again, with its rounds. */
async function openMilestone(lead: Lead, args: AnyRecord): Promise<string> {
  if (!hasText(args.id) || !hasText(args.title)) return LEAD_TOOL_WORDS.NeedsMilestone;
  const { journal } = lead;
  const id = milestoneId(args.id, journal.milestones.length);
  const earlier = journal.milestones.find((m) => m.id === id);
  const milestone: LeadMilestone = earlier
    ? { ...earlier, title: args.title }
    : { id, title: args.title, startedAt: lead.clock.now(), rounds: 0 };
  journal.milestones = [...journal.milestones.filter((m) => m.id !== id), milestone];
  await milestoneColumn(lead, milestone).catch(() => {});
  await saveLead(lead);
  return LEAD_TOOL_WORDS.Milestone(milestone.title);
}

/** `rewind`: back to a save point when the turn ends, or the save points there are. */
async function askRewind(lead: Lead, args: AnyRecord): Promise<string> {
  const label = hasText(args.label) ? args.label.trim() : "";
  const known = lead.journal.savePoints.map((point) => point.label);
  if (!known.includes(label)) return LEAD_TOOL_WORDS.NoSavePoint(label, known);
  lead.journal.between.rewind = label;
  await saveLead(lead);
  return LEAD_TOOL_WORDS.Rewind(label);
}

/** `rebuild_unreal`: Unreal is rebuilt when the turn ends. */
async function askRebuild(lead: Lead, args: AnyRecord): Promise<string> {
  lead.journal.between.rebuild = true;
  await saveLead(lead);
  return LEAD_TOOL_WORDS.Rebuild(hasText(args.reason) ? args.reason : LEAD_TOOL_WORDS.NoReason);
}

/** `note`: a decision card on the run's feed. */
async function leaveNote(lead: Lead, args: AnyRecord): Promise<string> {
  if (hasText(args.text)) await tellUser(lead, args.text, hasText(args.plain) ? args.plain : args.text).catch(() => {});
  return LEAD_TOOL_WORDS.Noted;
}

/** `save_point`: the lead's own, named as it asked. */
function leadSavePoint(lead: Lead, args: AnyRecord): Promise<string> {
  const label = hasText(args.label)
    ? args.label.trim()
    : LEAD_TOOL_WORDS.DefaultLabel(lead.journal.savePoints.length + 1);
  return savePoint(lead, { label, summary: hasText(args.summary) ? args.summary : "", auto: false });
}

/** Each run tool's answer. */
function tools(lead: Lead): Record<LeadTool, (args: AnyRecord) => Promise<unknown>> {
  const workers = workerTools(lead);
  return {
    [LeadTool.RunStatus]: async () => runStatusText(lead),
    [LeadTool.SavePoint]: (args) => leadSavePoint(lead, args),
    [LeadTool.Rewind]: (args) => askRewind(lead, args),
    [LeadTool.Milestone]: (args) => openMilestone(lead, args),
    [LeadTool.WorkerStart]: workers[LeadTool.WorkerStart],
    [LeadTool.WorkerStatus]: workers[LeadTool.WorkerStatus],
    [LeadTool.WorkerWait]: workers[LeadTool.WorkerWait],
    [LeadTool.WorkerSteer]: workers[LeadTool.WorkerSteer],
    [LeadTool.WorkerStop]: workers[LeadTool.WorkerStop],
    [LeadTool.WorkerMark]: workers[LeadTool.WorkerMark],
    [LeadTool.Critic]: (args) => askCritic(lead, args),
    [LeadTool.RebuildUnreal]: (args) => askRebuild(lead, args),
    [LeadTool.Note]: (args) => leaveNote(lead, args),
  };
}

const LEAD_TOOL_NAMES: readonly string[] = Object.values(LeadTool);
const isLeadTool = (name: string): name is LeadTool => LEAD_TOOL_NAMES.includes(name);

/** The handler the studio's dispatch reaches for this run: one answer per run tool, a sentence for anything else. */
export function leadToolHandler(lead: Lead): (name: string, args: AnyRecord) => Promise<unknown> {
  const answers = tools(lead);
  return async (name, args) => (isLeadTool(name) ? answers[name](args ?? {}) : LEAD_TOOL_WORDS.UnknownTool(name));
}
