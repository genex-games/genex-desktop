/**
 * The words of Genex's worker pool: the brief a worker starts from (Genex's identity first), the
 * one line a lead's brief says about workers, and every answer the six worker tools give the lead.
 */
import { CoreFact, type FactRef, type FolderHolds, ProjectTool } from "../folder-facts.ts";
import { appIdentity } from "../project-prompts.ts";
import { MAX_WORKERS_AT_ONCE, WorkerIsolation, WorkerTool } from "./contract.ts";

/** The one line a lead's brief says about its workers, the same on every engine. */
export const WORKERS_BRIEF_LINE =
  "You can start workers (worker_start): readers in place, writers in their own copy that you merge with worker_mark, or one writer in place. Up to eight at once; they follow this chat's permission mode.";

/** What a worker may do about Genex's plugins: look, and tell the lead; the card is the lead's to show. */
const WORKER_PLUGIN_SEARCH = `To look for a Genex plugin, call ${ProjectTool.PluginsFind} and say in your report what it found; only the lead shows the person a plugin's card.`;

/**
 * What a worker of a project with a game engine's editor reads: the editor is the lead's, and
 * Genex hands a worker none of its tools.
 */
const WORKER_NO_EDITOR =
  "The game engine's editor is the lead's alone: you have none of its tools. Change the project through its files.";

/** The kinds of project a game engine's editor works on. */
const ENGINE_PROJECTS: ReadonlySet<string> = new Set([
  CoreFact.UnrealProject,
  CoreFact.UnityProject,
  CoreFact.GodotProject,
]);

/** Whether a project holds a game engine's project, whose editor its lead drives. */
const holdsEngine = (facts: readonly FactRef[]): boolean => facts.some((fact) => ENGINE_PROJECTS.has(fact.id));

/** What a worker's brief is made from. */
export interface WorkerBriefParts {
  /** Who runs it: Genex, the project's folder and what it holds. */
  identity: { folderLabel: string; facts: readonly FactRef[]; holds?: FolderHolds | null };
  task: string;
  isolation: WorkerIsolation;
  research: boolean;
  /** The kind of worker a plugin declares: its description. */
  typeDescription: string | null;
  /** Game paths the lead names as its starting point. */
  inputs: readonly string[];
}

/** Where a worker works and what it may touch, by how it stands in the project. */
const WHERE: Record<WorkerIsolation, string> = {
  [WorkerIsolation.Read]:
    "You work in the project's folder itself and only read: change no file. Report what you found when you finish.",
  [WorkerIsolation.Copy]:
    "You work in a copy of the project made for you: change files there freely. Your changes are committed when you finish, and the lead merges them; never commit or merge yourself.",
  [WorkerIsolation.Lock]:
    "You work in the project's folder itself and are its one writer besides the lead: change only what your task needs. The lead reviews what you changed.",
};

/** The brief a worker starts from: Genex's identity, its task, where it works, what it may touch and how it hands back. */
export function workerBrief(parts: WorkerBriefParts): string {
  const lines = [
    appIdentity({ ...parts.identity, holds: parts.identity.holds ?? null }),
    "",
    "You are a worker: the lead of this chat started you for one task, and only the lead reads what you say.",
    ...(parts.typeDescription ? [`Your kind of work: ${parts.typeDescription}`] : []),
    "",
    `Your task:\n${parts.task}`,
    "",
    WHERE[parts.isolation],
    ...(holdsEngine(parts.identity.facts) ? [WORKER_NO_EDITOR] : []),
    ...(parts.inputs.length ? [`Start from these files: ${parts.inputs.join(", ")}.`] : []),
    parts.research
      ? "You may search and read the web for this task."
      : "Work from the project and your own knowledge; the web is not part of this task.",
    WORKER_PLUGIN_SEARCH,
    "Never start workers of your own. Hand back by finishing: end with a short report of what you did and what is left.",
  ];
  return lines.join("\n");
}

/** One worker's line in a status: its id, title, isolation, state and minutes, and what follows. */
export interface StatusLine {
  id: string;
  title: string;
  isolation: string;
  state: string;
  minutes: number;
  extra: string;
}

/** Every answer the worker tools give the lead. */
export const POOL_WORDS = {
  started: (id: string, isolation: string) =>
    `Started ${id} (${isolation}). Use ${WorkerTool.Wait} or ${WorkerTool.Status} to hear from it; other work can go on meanwhile.`,
  tooMany: (running: number) =>
    `Not started: ${running} workers are running, and at most ${MAX_WORKERS_AT_ONCE} run at once. Wait for one to finish (${WorkerTool.Wait}), or stop one (${WorkerTool.Stop}).`,
  noTask: "Not started: give the worker a title and a task (everything it needs; it sees nothing else).",
  noIsolation: `Not started: say how it stands in the project: isolation read (in place, reads only), copy (writes in its own copy) or lock (the one writer in place).`,
  unknownType: (type: string, known: readonly string[]) =>
    `Not started: no plugin that is on declares the worker type ${type}. ${known.length ? `Known types: ${known.join(", ")}.` : "No plugin that is on declares any; start a worker with no type."}`,
  lockBusy: (id: string) =>
    `Not started: ${id} is writing in place now, and only one writer works in place at a time. Wait for it, start this one in its own copy (isolation copy), or as a reader.`,
  badInput: (input: string) =>
    `Not started: ${JSON.stringify(input)} is not a path inside the project. Name inputs as paths relative to the project's folder.`,
  copyTooLarge: (host: string) =>
    `${host} Start it again with isolation lock (the one writer in place) or as a reader (isolation read).`,
  noCopy: (why: string) => `Not started: Genex could not make the worker's copy: ${why}`,
  unknown: (id: string) => `No worker ${id} in this chat.`,
  none: "No workers yet in this chat.",
  status: (line: StatusLine) =>
    `${line.id} · ${line.title} · ${line.isolation} · ${line.state} · ${line.minutes} min${line.extra ? ` · ${line.extra}` : ""}`,
  waiting: (question: string) =>
    `waiting for the person: ${question}. Stop it, or work around it; other workers keep going.`,
  ready: (id: string) => `its work is ready: ${WorkerTool.Mark} ${id} used to merge it, or rejected to drop it`,
  nothingChanged: "it changed nothing",
  marked: (verdict: string) => `marked ${verdict}`,
  failedWith: (why: string) => `failed: ${why}`,
  hostRefused: (why: string) => `Genex did not start it: ${why}`,
  turnEnded: "the chat turn that started it ended",
  runEnded: "the run that started it ended",
  stoppedBy: (why: string) => `stopped: ${why}`,
  stoppedByLead: "stopped by the lead",
  steered: (id: string) => `${id} reads this now.`,
  steerQueued: (id: string) => `${id} reads this when it goes on.`,
  notRunning: (id: string, state: string) => `${id} is not running (${state}).`,
  stopped: (id: string) => `Stopped ${id}. A copy's work so far is kept for ${WorkerTool.Mark}.`,
  noText: "Say what the worker should hear.",
  badVerdict: `Say verdict used (merge its work) or rejected (drop it).`,
  stillRunning: (id: string) => `${id} is still running: wait for it, or stop it first.`,
  alreadyMarked: (id: string, verdict: string) => `${id} is already marked ${verdict}; a verdict stands once given.`,
  inGameAlready: (id: string) =>
    `${id} wrote in place and finished: its work is in your folder already. To take it out, change those files yourself, or start a worker on it.`,
  markedOnly: (id: string, verdict: string) =>
    `Marked ${id} ${verdict}; it wrote in place, so there is nothing to merge.`,
  rejected: (id: string) => `Rejected ${id}: its copy is dropped.`,
  merged: (id: string) => `Merged ${id}'s work into your folder.`,
  nothingToMerge: (id: string) => `Marked ${id} used; it changed nothing, so there was nothing to merge.`,
  conflict: (id: string, files: readonly string[]) =>
    `Not merged: ${id}'s work conflicts with yours in ${files.join(", ") || "files git did not name"}. The merge was undone. Resolve them yourself in your folder, or start a worker on it.`,
  dirty: (id: string, files: readonly string[]) =>
    `Not merged: you have changes in ${files.join(", ")} that ${id}'s work also changes. Commit or put them aside, resolve them yourself in your folder, or start a worker on it.`,
  mergeFailed: (id: string, why: string) => `Not merged: git refused ${id}'s work: ${why}`,
  claudeFolder: (id: string, files: readonly string[]) =>
    `Not merged: ${id}'s work changes Claude Code's own folder (${files.join(", ")}), which a session in the game would load as its settings and hooks; no worker's work brings that into the game. Mark it rejected, or redo the rest without those files.`,
  unchecked: (id: string) =>
    `Not merged: git could not list what ${id}'s work changes, so Genex cannot check it leaves Claude Code's own folder alone. Try again, or mark it rejected.`,
  workCommit: (id: string, title: string) => `worker ${id}: ${title}`,
  mergeMessage: (id: string, title: string) => `worker ${id}: ${title}`,
  snapshotReason: (id: string) => `before worker ${id}`,
  noWorkersForTurn: "No workers for this turn: the chat turn that started them has ended.",
  unknownTool: (name: string) => `Unknown worker tool ${name}.`,
} as const;

/** What a run's lead hears of its pool's workers, beside the workers of its own method. */
export const RUN_POOL_WORDS = {
  /** A worker of the run's pool ended: the line that wakes the lead with the rest of its news. */
  ended: (id: string, title: string, state: string) =>
    `worker ${id}: ${title} ${state}; ${WorkerTool.Status} ${id} says what it found.`,
  /** The web method builds in copies: no writer works in the game folder itself. */
  noLock: `Not started: this run builds in copies, never in the game folder itself. Start it with isolation copy (the default: a builder in its own worktree), or isolation read for a reader in place.`,
  /** The heading of the run pool's workers in a status that lists every worker. */
  readers: "Workers from the shared pool:",
  /** One of the run's own workers waits on the person: the line that wakes the lead (`worker <id>` opens it). */
  waiting: (id: string, question: string) =>
    `worker ${id} is waiting for the person: ${question}. Stop it (${WorkerTool.Stop}), or work around it; the other workers keep going.`,
} as const;

/** What `worker_mark` answers a director about one of its builders. */
export const DIRECTOR_MARK_WORDS = {
  unknown: (id: string) => `no worker "${id}"`,
  badVerdict: `Say verdict used (integrate its last accepted commit) or rejected (its news stops).`,
  stillRunning: (id: string) => `worker ${id} is still running: stop it first (${WorkerTool.Stop}), then reject it.`,
  rejected: (id: string) =>
    `Rejected ${id}: no digest or ${WorkerTool.Wait} names it again. Its commits stay on its ref.`,
  inGameAlready: (id: string) =>
    `worker ${id}'s work is already in the game (integrated), so it cannot be rejected. To take something of it out, change it in your worktree.`,
  rejectedCard: (id: string, note: string | null) => `director rejected worker ${id}${note ? `: ${note}` : ""}`,
  rejectedPlain: (title: string) => `set aside the builder's work on ${title}`,
} as const;

/**
 * A conflict worker as the chat and the Builds graph name it: the work it fits in, in plain
 * words. Its title for the lead names the git step, which the person never reads.
 */
export const FIT_IN_WORDS = {
  title: (title: string) => `Fit ${title} in with the rest of the game`,
  someWork: "Fit the latest work in with the rest of the game",
} as const;
