/**
 * What the open Loop's lead reads: its brief (who it is, the goal, its time, the folder and what it
 * holds, its workers, its finish, what wakes it), how its Loop works, and its tools' answers. Engine
 * neutral: a project's own words come from its facts, its plugins and its skills, never from here.
 * Model-facing: the lead reads them as written.
 */
import type { WorkerType } from "../../../types/host-api.d.ts";
import { type HookHeldBy, HookHold, holdOf } from "../../hooks.ts";
import { resumeHeldWords, runHeldWords } from "../held-words.ts";
import { FACT_ROOT, type FactRef, type FolderHolds } from "../../folder-facts.ts";
import { CLAIM_BEFORE_END_MINUTES } from "../../finish-check.ts";
import { PICTURE_OUTRANKS_FILES, stopRuleWords } from "../../finish-check-prompts.ts";
import { GAPS_FIRST_MIN_MS } from "../../finish-remaining.ts";
import { JUDGE_PLAY_TOOL } from "../../judge-play-prompts.ts";
import type { JudgeRef } from "../../engine-judges.ts";
import { ENGINE_JUDGE_WORDS } from "../../engine-judges-prompts.ts";
import { appIdentity } from "../../project-prompts.ts";
import { MINUTE_MS, minutes } from "../../time.ts";
import { JobTool } from "../../jobs/contract.ts";
import { WorkerTool } from "../../workers/contract.ts";
import { DirectorTool } from "../tool-specs.ts";
import { REASON_WORDS } from "../wake-prompts.ts";
import { WakeCause, type WakeReason, WrapCause } from "../wake-schedule.ts";
import { OPEN_TURN_MS, OpenTool, type OpenSavePoint } from "./contract.ts";

/** How many references the brief names at most. */
const MAX_REFERENCES = 12;
/** How many save points (a run of autosaves counts as one) a message names at most; the rest are counted. */
const MAX_SAVE_POINTS_NAMED = 8;

/** A run of save points as a message names it: one of the lead's, or autosaves in a row. */
type NamedPoint = { point: OpenSavePoint; count: number };

/** The save points with each run of autosaves in a row as one (named by its last). */
function savePointRuns(points: readonly OpenSavePoint[]): NamedPoint[] {
  const runs: NamedPoint[] = [];
  for (const point of points) {
    const last = runs.at(-1);
    if (last && point.auto && last.point.auto) runs[runs.length - 1] = { point, count: last.count + 1 };
    else runs.push({ point, count: 1 });
  }
  return runs;
}

/**
 * The save points a message names, oldest first: all of them when few; else the latest, and the
 * lead's own before it, up to `MAX_SAVE_POINTS_NAMED`, with how many more there are.
 */
function namedSavePoints(points: readonly OpenSavePoint[], name: (point: OpenSavePoint) => string): string {
  const runs = savePointRuns(points);
  const latest = runs.at(-1);
  const own = runs.filter((run) => !run.point.auto && run !== latest).slice(-(MAX_SAVE_POINTS_NAMED - 1));
  const shown = runs.length <= MAX_SAVE_POINTS_NAMED ? runs : runs.filter((run) => run === latest || own.includes(run));
  const named = shown.map((run) => (run.count > 1 ? `${name(run.point)} ×${run.count}` : name(run.point)));
  const hidden = points.length - shown.reduce((sum, run) => sum + run.count, 0);
  return hidden > 0 ? `${named.join("; ")}; and ${hidden} earlier` : named.join("; ");
}

/** What the brief is made of: the run as it starts, and what the folder and its plugins said. */
export interface OpenBriefFacts {
  goal: string;
  folder: string;
  /** The folder as Genex's identity names it (`folderLabelOf`). */
  folderLabel: string;
  facts: readonly FactRef[];
  /** What the folder holds when it has no facts (new, notes), as the game lists it. */
  holds: FolderHolds | null;
  /** Lines the lead carries in: what the project's plugins said at the start, what an earlier session left. */
  carried: readonly string[];
  /** Files under the folder's `references/`, by their path in the folder. */
  references: readonly string[];
  workerTypes: readonly WorkerType[];
  /** Whether a plugin saves the project's app before Genex's checkpoint (`checkpoint.before`). */
  appSaved: boolean;
  /** Whether a plugin restarts the project's app (`restore.*`): the lead is offered `restart`. */
  restart: boolean;
  /** Whether a restart also rebuilds the game's C++ (a project with an Unreal project in it). */
  cppRestart: boolean;
  /** Whether the studio plays the game in its engine's editor, so the lead is offered `judge_play`. */
  judge: boolean;
  /** The judges the game's engine plugin declares for it, which play after each turn that keeps a save point. */
  judges?: readonly JudgeRef[];
  savePoints: readonly OpenSavePoint[];
  now: number;
  softDeadline: number;
  finalDeadline: number;
  /** The Loop runs until a reviewer accepts its finish (within its hours), not for its hours. */
  untilFinish: boolean;
  /** The workspace's skills that reach this project (their text without front matter). */
  skills: readonly string[];
}

/** One fact as the brief names it: its id, and where in the folder it was found. */
const factLine = (fact: FactRef): string =>
  `${fact.id} ${fact.path === FACT_ROOT ? "at the folder's root" : `in ${fact.path}`}`;

/**
 * The brief's time paragraph: how long the Loop runs (its hours are a soft cap: a reviewer's yes ends
 * it sooner, a short grace follows them), and how much working time is left.
 */
function timeWords(facts: OpenBriefFacts): string {
  const hours = Math.max(1, Math.round((facts.softDeadline - facts.now) / (60 * MINUTE_MS)));
  const span = facts.untilFinish
    ? `until a reviewer accepts your finish, at most ${hours} hours`
    : `for up to ${hours} hours: use them to make the project better, and call finish as soon as the goal is reached`;
  const left = Math.max(0, minutes(facts.softDeadline - facts.now));
  return `TIME: this Loop runs ${span}. You have about ${left} minutes of working time left. Genex tells you shortly before the time is up and when it is: then start nothing new, bring in finished worker work, make sure the project runs, keep a save point, and call finish only if the goal is reached.`;
}

/** The project paragraph: what the folder holds, what its plugins said, its references and save points. */
function projectWords(facts: OpenBriefFacts): string[] {
  const holds = facts.facts.length ? facts.facts.map(factLine).join("; ") : "nothing Genex recognises yet";
  const lines = [`THE PROJECT holds: ${holds}.`];
  if (facts.carried.length)
    lines.push(["WHAT GENEX AND THE PROJECT'S PLUGINS SAID:", ...facts.carried.map((line) => `- ${line}`)].join("\n"));
  if (facts.references.length)
    lines.push(`REFERENCES the person left in the folder: ${facts.references.slice(0, MAX_REFERENCES).join(", ")}.`);
  if (facts.savePoints.length) {
    const named = namedSavePoints(
      facts.savePoints,
      (point) => `"${point.label}"${point.summary ? ` (${point.summary})` : ""}`,
    );
    lines.push(`SAVE POINTS kept so far: ${named}.`);
  }
  return lines;
}

/** The workers paragraph, with the kinds of worker the project's plugins declare. */
function workerWords(types: readonly WorkerType[]): string {
  const kinds = types.length
    ? ` Kinds of worker the project's plugins declare: ${types.map((type) => `${type.id} (${type.description})`).join("; ")}.`
    : "";
  return `WORKERS: ${WorkerTool.Start} hands one task to a worker in the background: a reader looks in place (isolation read), a writer works in its own copy of the folder that you merge with ${WorkerTool.Mark} (isolation copy), and one writer at a time may work in place under a lock (isolation lock). Each sees only its task; mark each finished worker used or rejected.${kinds}`;
}

/** The save points paragraph: `save_point`, `rewind`, and `restart` when a plugin restarts the project's app. */
function savePointWords(facts: Pick<OpenBriefFacts, "restart" | "cppRestart" | "judge" | "judges">): string {
  const lines = [
    `SAVE POINTS: ${OpenTool.SavePoint} keeps the folder as it is now in Genex's checkpoint (the project's plugins save their apps first); keep one after each step that works. ${OpenTool.Rewind} with a save point's label goes back to it when your turn ends.`,
  ];
  if (facts.restart)
    lines.push(`${OpenTool.Restart} closes and reopens the project's app when your turn ends; no file changes.`);
  if (facts.restart && facts.cppRestart) lines.push("After changing the game's C++ source, call restart: it rebuilds.");
  if (facts.judge)
    lines.push(
      `${JUDGE_PLAY_TOOL}: a blind judge plays the game and answers one yes/no; ask it before you claim a mechanic works.`,
    );
  if (facts.judge && facts.judges?.length) lines.push(ENGINE_JUDGE_WORDS.briefRounds(facts.judges));
  return lines.join(" ");
}

/**
 * The open lead's brief: Genex's identity first (a fresh session reads this brief alone), then that
 * it is this chat's own session leading a Loop in the project's own folder, with the goal whole, its
 * time, what the folder holds, its workers, its finish and how it is woken.
 */
export function openBrief(facts: OpenBriefFacts): string {
  return [
    appIdentity({ folderLabel: facts.folderLabel, facts: facts.facts, holds: facts.holds }),
    `YOU LEAD THIS LOOP. You are this chat's own session, and you lead a Loop on the project in ${facts.folder}: you build it yourself, in place, in the project's own folder. Genex took a snapshot of the folder before the Loop began.`,
    `THE GOAL: ${facts.goal}`,
    timeWords(facts),
    ...projectWords(facts),
    workerWords(facts.workerTypes),
    savePointWords(facts),
    "JOBS AND LOOKS: run a long command as a job and keep working while it runs; look at any window of the project's app with app_look, when the chat offers them.",
    `BLOCKED: when the goal needs what only the person can do (a tool, editor or app the work needs is gone or can't run here and nothing you can call brings it back, an install, a permission, a sign-in), call ${OpenTool.Pause} with what they should do. While such a block lasts, never fill the Loop's time with work that can't reach the project.`,
    `FINISH: when the goal is reached, call finish with a summary, what remains (everything you know is not done or not right yet) and proof: the files in the folder that show it (a test report, a close-up picture, a log). A reviewer who did none of the work checks it; ${stopRuleWords(facts.untilFinish)} While something remains and more than ${minutes(GAPS_FIRST_MIN_MS)} minutes are left, no reviewer reads the claim: you work on what remains first. ${PICTURE_OUTRANKS_FILES}`,
    ...(facts.appSaved ? [] : ["SAVING: Genex's save points keep the files on disk only: save inside the app first."]),
    ...(facts.skills.length ? [["SKILLS FOR THIS PROJECT:", ...facts.skills].join("\n\n")] : []),
  ].join("\n\n");
}

/** How the open Loop works, said once in the lead's first message. */
export function openWakeRules({ heartbeatMinutes }: { heartbeatMinutes: number }): string {
  return [
    "HOW THIS LOOP WORKS — ONE DECISION PER TURN:",
    `- Act, then end your turn; a turn lasts at most ${minutes(OPEN_TURN_MS)} minutes, and one cut there goes on at once. Between your turns nothing of yours runs; your workers and jobs keep working.`,
    `- Genex wakes you in this same session when something happens — the person speaks or asks to finish, a worker ends or asks, a job ends, the project's app stops — and every ${heartbeatMinutes} minutes while workers run. News that comes while you work reaches you mid-turn when your session can take it in, otherwise when your turn ends: a long turn hears late.`,
    `- The person outranks the goal: answer them in the chat, directly and briefly, and act on what they ask. An ask to stop or finish the Loop is ${DirectorTool.WrapUp} first, quoting their words; a question alone stops no worker.`,
    `- Each wake opens with what happened. Use ${WorkerTool.Wait} only when you need a worker's answer within this turn.`,
  ].join("\n");
}

/**
 * Why an open Loop didn't start, for the person: Genex's own hold in their words (which say to start
 * it again, or for a resumed Loop, which stays paused, to press Resume), a plugin's block with its
 * reason and what to do next.
 */
export function openStartHeld(blocked: { reason: string } & HookHeldBy, resumed = false): string {
  const genexHold = resumed ? resumeHeldWords(blocked) : null;
  if (genexHold) return genexHold;
  if (holdOf(blocked)) return runHeldWords(blocked);
  const then = resumed ? "Then press Resume: the Loop stays paused." : "Then start the Loop again.";
  return `The Loop didn't start: a plugin of this project held it back: ${blocked.reason} ${then}`;
}

/** What the open Loop's tools answer, and the words of its close. */
export const OPEN_WORDS = {
  stopped: "The Loop was stopped; end your turn.",
  unknownTool: (name: string) => `unknown tool: ${name}`,
  needsText: "note needs text",
  noted: "noted",
  finishUnderWay: "Your finish is already being checked; wait for its answer.",
  ending: "The Loop is already ending; end your turn.",
  /** A save point, a rewind, a restart or a finish once the Loop is paused (its app couldn't be brought back, or the lead paused it). */
  paused:
    "The Loop is paused: Genex couldn't bring the project's app back, or you paused it for the person. Nothing was kept or checked; end your turn.",
  needsWhy: `${OpenTool.Pause} needs why: what stops the goal and what the person should do.`,
  pausing:
    "The Loop pauses when this turn ends, with your words for the person. End your turn now with the same two sentences.",
  /** A claim while a worker writes in the folder in place: the reviewer would read a folder that keeps changing. */
  writerAtWork: (ids: readonly string[]) =>
    `A worker writes in the folder in place (${ids.join(", ")}), so a reviewer would read a folder that keeps changing: nothing was checked. Wait for it (${WorkerTool.Wait}) or stop it (${WorkerTool.Stop}), then claim the goal.`,
  /** A claim while a rewind or a restart the lead asked for still waits for the turn's end. */
  askFirst:
    "Your rewind or restart runs when this turn ends, so there is nothing to check yet: end your turn, then claim the goal in the next.",
  needsSummary: "finish needs a summary of what the project holds now.",
  accepted: "Accepted: the Loop is closed. End your turn with a one-paragraph summary for the person.",
  /** A yes whose close outlasts the lead's call: it goes on, and the lead changes nothing more. */
  acceptedClosing:
    "Accepted: the Loop is closing, and Genex keeps its last work now. Change nothing more; end your turn with a one-paragraph summary for the person.",
  /** Any other close that outlasts the lead's call. */
  closing:
    "The Loop is closing, and Genex keeps its last work now. Change nothing more; end your turn with a one-paragraph summary for the person.",
  personFinished:
    "The person asked the Loop to finish: it is closed. End your turn with a one-paragraph summary for the person.",
  noReviewer:
    "No engine here can hold a reviewer to check your claim, so the Loop closed without a yes. End your turn.",
  noTimeLeft:
    "The Loop's time ends too soon for a reviewer to check your claim, so it is not counted and the Loop closed. End your turn with a one-paragraph summary for the person.",
  needsLabel: `${OpenTool.SavePoint} needs a label: a few words naming what works now.`,
  /** A save point or a finish while Genex brings the project's app back: nothing is kept or checked. */
  recovering:
    "Genex is bringing the project's app back; nothing was kept or checked. Try again once it says the app is back.",
  saved: (label: string, notes: readonly string[], minutesLeft: number, shows: string | null = null) =>
    [
      `Saved save point "${label}".`,
      ...(notes.length ? [`The project's plugins said: ${notes.join(" ")}`] : []),
      ...(shows ? [shows] : []),
      `About ${minutesLeft} minutes of working time left.`,
    ].join(" "),
  notSaved: (why: string) => `No save point was made, and nothing was kept: ${clause(why)}.`,
  rewindLater: (label: string) =>
    `Genex goes back to save point "${label}" when this turn ends; end your turn when you are ready.`,
  noSuchPoint: (label: string, labels: readonly string[]) =>
    labels.length
      ? `There is no save point "${label}". The save points are: ${labels.map((one) => `"${one}"`).join(", ")}.`
      : `There is no save point "${label}": none was kept yet.`,
  restartLater: "Genex restarts the project's app when this turn ends; no file changes.",
} as const;

/** Words without the full stop they may end with, to go on in a sentence. */
function clause(words: string): string {
  return words.trim().replace(/[.]+$/, "");
}

/** What Genex itself held a save point, a restore or a restart back for, as the lead reads it, by its hold. */
const HELD_FOR_LEAD = {
  [HookHold.PersonFirst]: (app: string) => `the person is using ${app}; try again later`,
  [HookHold.CantTell]: (app: string) => `Genex couldn't tell whether the person was using ${app}; try again later`,
  [HookHold.Busy]: (app: string) => `something else was working in ${app}; try again later`,
  [HookHold.Plan]: () => "the chat is in Plan mode, so nothing changes until the plan is approved",
} as const satisfies Record<HookHold, (app: string) => string>;

/** Why something was held back, for the lead: Genex's own hold in its words, a step's block with its reason. */
export function heldForLead(held: { reason: string } & HookHeldBy): string {
  const hold = holdOf(held);
  return hold ? HELD_FOR_LEAD[hold.hold](hold.label ?? "the project's app") : held.reason;
}

/** What Genex did between the lead's turns and while it worked, as the lead's next message (or a steer) says it. */
export const OPEN_NEWS = {
  autosaved: (label: string) => `Your turn ended with unsaved work, so Genex saved it as save point "${label}".`,
  notAutosaved: (why: string) => `Your turn ended with unsaved work, and Genex couldn't keep it: ${clause(why)}.`,
  rewound: (label: string) => `Genex went back to save point "${label}" before this turn, as you asked.`,
  noRewind: (label: string, why: string) => `Genex couldn't go back to save point "${label}": ${clause(why)}.`,
  restarted: "Genex restarted the project's app before this turn, as you asked; no file changed.",
  noRestart: (why: string) => `Genex couldn't restart the project's app: ${clause(why)}.`,
  notAnswering: (why: string) => `The project's app didn't answer again: ${clause(why)}.`,
  /** Why nothing was kept or restored at a turn's end: a recovery under way. */
  bringingBack: "Genex is bringing the project's app back",
  askWaits:
    "Genex is bringing the project's app back, so the rewind or restart you asked for waits until a turn ends after it is back.",
  /** A rewind or restart asked for while a worker writes in the folder in place: it waits for that worker. */
  askWaitsForWriter: (ids: readonly string[]) =>
    `A worker writes in the folder in place (${ids.join(", ")}), so the rewind or restart you asked for waits until a turn ends after it is done (${WorkerTool.Wait} or ${WorkerTool.Stop}).`,
  /** No autosave while a worker writes in the folder in place: it would keep that worker's half-done files. */
  notAutosavedWriter: (ids: readonly string[]) =>
    `A worker writes in the folder in place (${ids.join(", ")}), so Genex kept no autosave of your turn: keep a ${OpenTool.SavePoint} once it is done.`,
  /** The writers in place Genex stopped before it took the folder back to a save point. */
  writersStopped: (ids: readonly string[]) =>
    `Genex stopped ${ids.join(", ")} first: it wrote in the folder in place, and the folder went back under it.`,
  /** Why a writer in place was stopped, as its end record says it. */
  writerStoppedWhy: "Genex stopped it while it brought back the project's app, which had stopped answering",
  /** Why a turn beside a job a writer in place left running counted for nothing, and what the lead can do. */
  leftoverJobs: (titles: readonly string[]) =>
    `A job a worker in place left running (${titles.join(", ")}) may still write in the game folder, so Genex can't tell your changes from its: keep a ${OpenTool.SavePoint} of your work, or stop the job with ${JobTool.Stop}.`,
  rewindDropped: (label: string) =>
    `Before the Loop paused you asked to go back to save point "${label}"; it paused first, so nothing went back. Ask again if you still want it.`,
  restartDropped:
    "Before the Loop paused you asked to restart the project's app; it paused first, so it wasn't restarted. Ask again if you still want it.",
  /** Said the moment Genex sees the project's app has stopped answering, before its recovery. */
  appStopping:
    "The project's app isn't answering: Genex is bringing it back now. Keep no save point and call no finish until it says the app is back.",
  appBack: (label: string | null) =>
    label
      ? `The project's app stopped, and Genex reopened it. Work since save point "${label}" may be lost: look before you go on.`
      : "The project's app stopped, and Genex reopened it. Work not yet saved in it may be lost: look before you go on.",
  wentBack: (label: string) =>
    `The project's app stopped and wouldn't reopen on the folder as it was, so Genex went back to save point "${label}". Work since it is gone from the folder.`,
  saveReminder: (minutesSince: number) =>
    `It has been ${minutesSince} minutes since your last save point: look at what works, then keep a ${OpenTool.SavePoint}.`,
  freshEyes: `No read-only worker has looked at the project for a while: one (${WorkerTool.Start} with isolation read) can look at it with fresh eyes.`,
} as const;

/** What one wake of the open lead says, read from the run at the moment of the wake. */
export interface OpenDigestFacts {
  reasons: readonly WakeReason[];
  /** The first message of a resumed Loop. */
  resumed: boolean;
  now: number;
  softDeadline: number;
  userSays: readonly string[];
  happened: readonly string[];
  carried: readonly string[];
  savePoints: readonly OpenSavePoint[];
  /** Workers and jobs at work now. */
  atWork: number;
  freshEyes: boolean;
  closing: string;
}

/** The digest's first line: a resumed Loop, a turn its cap cut, or what woke the lead. */
function digestHeading(facts: OpenDigestFacts): string {
  if (facts.resumed) return "The Loop picks up where it paused; Genex kept its save points.";
  if (facts.reasons.includes(WakeCause.TurnCap))
    return `Your turn reached its ${minutes(OPEN_TURN_MS)} minutes; carry on where you were.`;
  if (facts.reasons.length === 1 && facts.reasons[0] === WakeCause.CarryOn)
    return "Your turn ended; go on with the next step.";
  const why = facts.reasons.map((reason) => REASON_WORDS[reason] ?? reason);
  return `Genex woke you: ${why.join("; ") || REASON_WORDS[WakeCause.News]}.`;
}

/** The digest's middle: news, what Genex did, the save points and the work at hand. */
function digestBody(facts: OpenDigestFacts): string[] {
  const lines: string[] = [];
  if (facts.happened.length) lines.push(["WHAT HAPPENED:", ...facts.happened.map((line) => `- ${line}`)].join("\n"));
  if (facts.carried.length) lines.push(["FROM GENEX:", ...facts.carried.map((line) => `- ${line}`)].join("\n"));
  if (facts.savePoints.length)
    lines.push(`SAVE POINTS: ${namedSavePoints(facts.savePoints, (point) => `"${point.label}"`)}.`);
  if (facts.atWork) lines.push(`${facts.atWork} workers or jobs at work; run_status lists them.`);
  if (facts.freshEyes) lines.push(OPEN_NEWS.freshEyes);
  return lines;
}

/**
 * The open lead's wake message: why it was woken, its time, the person's words first and verbatim,
 * the news (workers', jobs', the app's), what Genex did between turns, its save points, and how the
 * message ends (`openClosing`).
 */
export function openDigest(facts: OpenDigestFacts): string {
  const said = facts.userSays.length ? [["THE PERSON SAYS (their own words):", ...facts.userSays].join("\n")] : [];
  return [
    digestHeading(facts),
    `About ${Math.max(0, minutes(facts.softDeadline - facts.now))} minutes of working time left.`,
    ...said,
    ...digestBody(facts),
    facts.closing,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Why the open Loop wraps up, as its last turn's message opens: its time, or what ended it sooner. */
const WRAP_OPENING = {
  [WrapCause.Deadline]: "YOUR WORKING TIME IS OVER",
  [WrapCause.Idle]: "YOU WERE ASKED WHAT NEXT AND DID NOTHING, SO THE LOOP WRAPS UP",
  [WrapCause.Failed]: "YOUR LAST TURN FAILED, SO THE LOOP WRAPS UP",
  [WrapCause.Finish]: "THE PERSON ASKED THE LOOP TO FINISH",
} as const satisfies Record<WrapCause, string>;

/**
 * How the wrap-up's finish goes: a claim a reviewer checks, or — once the person asked to finish —
 * a close with no check (finish.ts `claimFinish`), so no claim is invited.
 */
const WRAP_FINISH = {
  claim: `Only if the goal is reached, call finish with your summary and proof, at least ${CLAIM_BEFORE_END_MINUTES} minutes before the end: a reviewer needs that long to check your claim.`,
  asked:
    "Then call finish with your summary: the person asked to finish, so the Loop closes as it stands, with no reviewer's check.",
} as const;

/** How an open wake message ends: the wrap-up (saying why), the question of what next, or carry on. */
export function openClosing(how: {
  wrapping: boolean;
  wrapCause?: WrapCause | null;
  idleAsk: boolean;
  minutesLeft: number;
}): string {
  if (how.wrapping) {
    const cause = how.wrapCause ?? WrapCause.Deadline;
    const finish = cause === WrapCause.Finish ? WRAP_FINISH.asked : WRAP_FINISH.claim;
    return `${WRAP_OPENING[cause]}: this is your last turn. Keep a last ${OpenTool.SavePoint} of what works, and end with honest words: what you built, and what remains or you did not test. ${finish}`;
  }
  if (how.idleAsk)
    return `Nothing of yours is at work. Decide what next: build on yourself, start workers, or call finish when the goal is reached. About ${how.minutesLeft} minutes of working time left.`;
  return "Carry on: act, then end your turn.";
}
