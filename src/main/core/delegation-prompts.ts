/**
 * What a builder session is told about the host's side of its tools (`delegation.ts`): the plugins it
 * is handed, in its system text, and Genex's notices of what happened outside it, facts only. Model-facing.
 */
import { CallCutOff, PluginAccountState } from "../../shared/plugins.ts";
import type { CutOffCall } from "./cut-off-calls.ts";
import type { SilentConnector } from "../../substrate/mcp/registry.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type JobRecord, JobState, JobStopper } from "../../shared/jobs.ts";

/** How long a plugin's name and its description may run in a brief before each is cut at a word. */
const PLUGIN_NAME_CHARS = 80;
const PLUGIN_DESCRIPTION_CHARS = 200;

/** A plugin a session is handed, as its brief names it. */
export interface HandedPlugin {
  /** Its id, which its tools' names start with (`<id>__<tool>`). */
  id: string;
  name: string;
  description: string;
  /** Whether the session is handed tools named with its id; a plugin of hooks, panels or connectors alone has none. */
  tools: boolean;
  /** Its account's state as the session began (`PluginRegistry.accountState`); absent for a plugin that declares none. */
  account?: PluginAccountState;
}

/** Whether a handed plugin declares an account the person has not connected yet: its tools that need it fail until they do. */
const accountNotSetUp = (plugin: HandedPlugin): boolean =>
  plugin.account !== undefined && plugin.account !== PluginAccountState.Unlocked;

/** Why a call was cut off, and what a session hears of the plugins it is handed. */
const MESSAGE = {
  handedHead: "Plugins turned on for this session (a plugin's tools are named <id>__<tool>):",
  notSetUp: "Not set up yet: the person still has to connect its account on its page.",
  cutOffWhy: {
    [CallCutOff.HarnessEnded]: "Genex's loop ended while it ran",
    [CallCutOff.PluginEnded]: "its plugin stopped while it ran",
    [CallCutOff.AppLost]: "the app it drives went away while it ran",
    [CallCutOff.TurnEnded]:
      "made after your turn had ended; its \"user doesn't want to take this action\" answer was Genex's, not the person's",
  } satisfies Record<CallCutOff, string>,
} as const;

/** A connector that gave a session no tools, as the studio's log says it. */
export function silentConnectorLog(connector: SilentConnector): string {
  return `connector ${connector.name} gave no tools: ${connector.why ?? "it listed none"}`;
}

/** A plugin author's text on one line: each run of whitespace one space, cut at a word past `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const word = cut.lastIndexOf(" ");
  return `${word > 0 ? cut.slice(0, word) : cut}…`;
}

/**
 * A handed plugin as a brief names it: its name, the prefix of its tools when it has any, what it
 * does, and that it is not set up yet while its account is not connected.
 */
function pluginWords(plugin: HandedPlugin): string {
  const prefix = plugin.tools ? ` (${plugin.id}__ tools)` : "";
  const setUp = accountNotSetUp(plugin) ? ` ${MESSAGE.notSetUp}` : "";
  return `${oneLine(plugin.name, PLUGIN_NAME_CHARS)}${prefix}: ${oneLine(plugin.description, PLUGIN_DESCRIPTION_CHARS)}${setUp}`;
}

/**
 * Beside a host-tool session's plugin guidance: each plugin it is handed on a line of its own, by
 * name, the prefix of its tools and what it does, so it knows every plugin that is on, including
 * one with no skill to explain it, and tells the person about an account still to connect instead
 * of calling tools that fail. Empty when it is handed none.
 */
export function handedPluginsNote(plugins: readonly HandedPlugin[]): string {
  if (!plugins.length) return "";
  return [MESSAGE.handedHead, ...plugins.map((plugin) => `- ${pluginWords(plugin)}`)].join("\n");
}

/**
 * Genex's notice to a thread's next delegated session after plugin or connector calls of its thread
 * were cut off before they answered: Genex never sends them again, and whether they took effect is
 * unknown. Empty when nothing was cut off.
 */
export function cutOffNotice(calls: readonly CutOffCall[]): string {
  if (!calls.length) return "";
  const named = calls.map((c) => `${c.tool}${c.args ? ` ${c.args}` : ""} (${MESSAGE.cutOffWhy[c.reason]})`);
  return `Genex cut these calls off before they answered, so whether they took effect is unknown: ${named.join("; ")}.`;
}

/** How an ended job reads in the jobs notice, by how it ended. */
const JOB_ENDED_WORDS = {
  [JobState.Succeeded]: "finished",
  [JobState.Failed]: "failed",
  [JobState.Stopped]: "was stopped",
  [JobState.TimedOut]: "was stopped at its time limit",
  [JobState.Interrupted]: "was stopped when Genex closed",
} as const satisfies Record<Exclude<JobState, typeof JobState.Running>, string>;

/** One ended job in the jobs notice: its title, id, command, how it ended (by whom) and after how long. */
function endedJobWords(job: JobRecord): string {
  const state = job.state === JobState.Running ? JobState.Interrupted : job.state;
  const exit = typeof job.exitCode === "number" ? ` (exit ${job.exitCode})` : "";
  const ms = Date.parse(job.endedAt ?? "") - Date.parse(job.startedAt);
  const after = Number.isFinite(ms) ? ` after ${Math.max(0, Math.round(ms / MINUTE_MS))} min` : "";
  const by = job.stoppedBy === JobStopper.Person ? " by the person" : "";
  return `${job.title} (${job.id}, \`${job.command}\`) ${JOB_ENDED_WORDS[state]}${by}${exit}${after}`;
}

/**
 * Genex's notice to the chat's own session of its jobs that ended since it was last told; those
 * still running are `job_list`'s to say. Empty when none ended.
 */
export function jobNotice(ended: readonly JobRecord[]): string {
  return ended.length ? `Your jobs that ended: ${ended.map(endedJobWords).join("; ")}.` : "";
}

/**
 * Genex's line to a session that shows its plan by ending its turn (`plansByTurn`) once the person
 * approved it: the same session goes on in the mode they chose, which its engine is set to
 * (plan-approval.ts). Words the person sent the plan back with go as theirs, as they wrote them.
 */
export function planApprovedNote(): string {
  return "The person approved your plan.";
}
