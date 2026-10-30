/**
 * What a Loop's lead reads when it is woken (wake.ts): why, its time, the person's words verbatim,
 * what happened, the workers, the integration's last health check, and how the message ends. Also the
 * first message's rules and a fresh session's opening. Model-facing: the lead reads it as written.
 */
import { shortSha } from "../git.ts";
import { clip, clipMarked } from "../text.ts";
import { minutes } from "../time.ts";
import { LEAD_FRESH_START } from "./lead-session-prompts.ts";
import { NoteKind, WakeCause, type WakeReason, WrapCause } from "./wake-schedule.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;

/** The digest's news, at most this many lines. */
export const DIGEST_MAX_LINES = 40;
/** A fresh session is told the log's last this many lines. */
export const FRESH_LOG_LINES = 20;
/** …and the lead's last this many notes. */
export const FRESH_NOTES = 5;
/** The person's words a message carries: the newest this many, each cut at this. */
export const USER_SAYS_MAX = 20;
export const USER_SAYS_CHARS = 2_000;
/** One line of news, at most. */
const HAPPENED_CHARS = 400;

/** Why the lead was woken, in the header's words. */
export const REASON_WORDS = {
  [NoteKind.WorkerEnded]: "a worker ended",
  [NoteKind.JobEnded]: "a job of the run ended",
  [NoteKind.WorkerAsks]: "a worker asks the person something",
  [NoteKind.AppCrashed]: "the project's app stopped",
  [NoteKind.AppStopping]: "the project's app stopped answering",
  [WakeCause.UserMessage]: "the user spoke",
  [WakeCause.FinishRequested]: "the user asked to finish",
  [WakeCause.News]: "news",
  [WakeCause.WrapUp]: "the working time is over",
  [WakeCause.IdleAsk]: "nothing is running",
  [WakeCause.TurnCap]: "your turn reached its cap",
  [WakeCause.CarryOn]: "your turn ended; carry on",
} as const satisfies Record<WakeReason, string>;

/** One worker as the web digest names it. */
export interface DigestWorker {
  id: string;
  title: string;
  state: string;
  verdict?: string | null;
}

/** What one wake of a web game's lead says, read from the run at the moment of the wake. */
export interface DigestFacts {
  now: number;
  reasons: readonly WakeReason[];
  /** A heading of its own (a resumed run's first message), in place of the reasons. */
  heading?: string;
  userSays: readonly string[];
  finishNew: boolean;
  happened: readonly string[];
  softDeadline: number;
  finalDeadline: number;
  wrapping: boolean;
  integrationHead: string | null;
  integrationHealthy: boolean | null;
  workers: readonly DigestWorker[];
  closing: string;
}

/** The one line a finish request adds to the person's part of a message. */
const FINISH_ASKED =
  "THE USER ASKED TO FINISH: no new workers. Bring in what is ready and call finish; the wrap-up starts when this turn ends.";

/** A clock time as the digest says it. */
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/**
 * What the user said, word for word and oldest first — bounded: the newest `USER_SAYS_MAX` messages,
 * each cut at `USER_SAYS_CHARS`, and how many earlier ones are not shown.
 */
export function userSaysBlock(userSays: readonly string[]): string {
  const shown = userSays.slice(-USER_SAYS_MAX);
  const hidden = userSays.length - shown.length;
  return [
    "THE USER SAYS (verbatim, oldest first):",
    ...(hidden ? [`- (${hidden} earlier messages not shown)`] : []),
    ...shown.map((text) => `- ${clipMarked(text, USER_SAYS_CHARS)}`),
  ].join("\n");
}

/** The run's news since the lead last read it: the newest lines, and how many older ones were left out. */
function happenedSection(happened: readonly string[]): string {
  if (!happened.length) return "";
  const shown = happened.slice(-DIGEST_MAX_LINES);
  const hidden = happened.length - shown.length;
  return [
    "WHAT HAPPENED:",
    ...(hidden ? [`- (${hidden} earlier lines not shown)`] : []),
    ...shown.map((line) => `- ${clip(line, HAPPENED_CHARS)}`),
  ].join("\n");
}

/** The health check's last word on the integration head. */
function healthWords(healthy: boolean | null): string {
  if (healthy === true) return "passed its last health check";
  if (healthy === false) return "failed its last health check";
  return "not checked yet";
}

/** Where the run stands: its time, the integration head, the workers. */
function standsSection(facts: DigestFacts): string {
  const { now, softDeadline, finalDeadline, wrapping } = facts;
  const time = wrapping
    ? `- time: wrapping up — ${minutes(finalDeadline - now)} minutes left, until ${utc(finalDeadline)}`
    : `- time: ${minutes(softDeadline - now)} working minutes left, until ${utc(softDeadline)}`;
  const head = facts.integrationHead
    ? `- integration: ${shortSha(facts.integrationHead)}, ${healthWords(facts.integrationHealthy)}`
    : "- integration: nothing committed yet";
  const workers = facts.workers.map(
    (w) => `- worker ${w.id} "${w.title}": ${w.state}${w.verdict ? ` (marked ${w.verdict})` : ""}`,
  );
  return ["WHERE THE RUN STANDS:", time, head, ...workers].join("\n");
}

/** A web game's lead's wake message: why it was woken, the person's words, the news, where the run stands, the closing. */
export function wakeDigest(facts: DigestFacts): string {
  const header =
    facts.heading ?? `WOKEN AT ${utc(facts.now)} — ${facts.reasons.map((r) => REASON_WORDS[r] ?? r).join("; ")}`;
  const said = [facts.userSays.length ? userSaysBlock(facts.userSays) : "", facts.finishNew ? FINISH_ASKED : ""]
    .filter(Boolean)
    .join("\n");
  return [header, said, happenedSection(facts.happened), standsSection(facts), facts.closing]
    .filter(Boolean)
    .join("\n\n");
}

/** What was said and what happened while the lead waited out its engine's limit, or nothing. */
export function sinceThen({
  userSays,
  happened,
}: {
  userSays: readonly string[];
  happened: readonly string[];
}): string {
  if (!userSays.length && !happened.length) return "";
  return [
    "SINCE THEN:",
    ...(userSays.length ? [userSaysBlock(userSays)] : []),
    ...(happened.length ? ["WHAT HAPPENED:", ...happened.map((line) => `- ${clip(line, HAPPENED_CHARS)}`)] : []),
  ].join("\n");
}

/** The closing of an ordinary wake. */
export function carryOn(): string {
  return "Act on it, and end your turn when you are done; Genex wakes you when something happens.";
}

/** The closing when the lead's last turn ended with nothing running: asked once, what next. */
export function idleAsk({ minutesLeft }: { minutesLeft: number }): string {
  return `Nothing is running and ${minutesLeft} working minutes remain. Go on with the work, or call finish if the goal is reached. If you end this turn with nothing running, the wrap-up starts.`;
}

/** Why a wrap-up that is not the deadline's started. */
const WRAP_LEADS = {
  [WrapCause.Deadline]: "",
  [WrapCause.Idle]: "Nothing was running and your last turn started nothing, so the wrap-up starts now.",
  [WrapCause.Failed]: "Your last turn failed, so the wrap-up starts now.",
  [WrapCause.Finish]: "The user asked to finish, so the wrap-up starts now.",
} as const satisfies Record<WrapCause, string>;

/** The wrap-up prompt, with why it started when that was not the deadline. */
export function wrapLead(cause: WrapCause, wrapUp: string): string {
  const lead = WRAP_LEADS[cause];
  return lead ? `${lead}\n${wrapUp}` : wrapUp;
}

/** Why a fresh session carries the run, in the words its first line gives (`freshStart`). */
export const SESSION_LOST_WHY = {
  resumeFailed: "the session could not be resumed",
  contextFull: "its context was full",
  contextOverflowed: "its context overflowed",
  /** A later turn found no session to resume: the one before it ended without one. */
  noSession: "no session was left to resume",
} as const;

/** What a fresh session is told when the lead's own was lost: the brief, the rules, its notes, the run and the news. */
export function freshStart({
  why,
  brief,
  rules,
  notes,
  recent,
  digest,
}: {
  why: string;
  brief: string;
  rules: string;
  notes: readonly string[];
  recent: readonly string[];
  digest: string;
}): string {
  return [
    LEAD_FRESH_START(why),
    brief,
    rules,
    [`YOUR NOTES (the last ${FRESH_NOTES}):`, ...(notes.length ? notes.map((n) => `- ${n}`) : ["- none"])].join("\n"),
    [
      `THE RUN SO FAR (the log's last ${FRESH_LOG_LINES} lines):`,
      ...(recent.length ? recent.map((line) => `- ${clip(line, HAPPENED_CHARS)}`) : ["- nothing yet"]),
    ].join("\n"),
    digest,
  ].join("\n\n");
}

/** How a web game's Loop works, said once in the first message (and again in a fresh one). */
export function wakeRules(): string {
  return [
    "HOW THIS LOOP WORKS:",
    "- worker_start answers at once; workers work in the background while you go on. To wait for one, call worker_wait or end your turn.",
    "- Genex wakes you in this same session when something happens — the user speaks or asks to finish, a worker ends or asks the person something, the working time ends. Each message opens with what happened.",
    "- The user outranks everything else: answer them in the chat and act on what they ask. An ask to finish is wrap_up first, quoting their words; a question alone stops nothing.",
    "- End a turn with nothing running and Genex asks once what next; end the next one idle too and the wrap-up starts.",
  ].join("\n");
}
