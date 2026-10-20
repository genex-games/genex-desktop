/**
 * Words — the one place a harness word becomes a user word.
 *
 * The harness talks to itself in run ids, facet titles, verdict sources and tool names. None of
 * that is the user's language: they asked for a game, and the only questions they ever ask are
 * "is my game being worked on?" and "what happened to it?". Every label in the app that starts
 * life inside `src/harness-seed` passes through this module first, so the translation is written
 * once, tested once (tests/conformance/words.test.ts), and cannot drift between the titlebar,
 * the rail, the chat and the graph.
 *
 * Two rules hold this module together:
 *   1. It is pure — no React, no window, and no runtime imports but the shared run rules
 *      (`shared/run-state.ts`), which decide what a round's verdict *was* (this decides what it is
 *      called), the shared `plural`, and the vocabularies its tables are keyed by (the platform,
 *      how a chat's file opens, Claude Code's permission modes and their own names, an agent's
 *      screen deeds) and the time units it counts in. It is a lookup table.
 *   2. No output may carry an identifier. Run ids and commit shas belong behind "Details";
 *      `withoutIds` is the last gate every phrase passes through, so even a facet title the
 *      director invented with a sha in it comes out readable.
 */

import { InteractionObjective, InteractionSource } from "../shared/run-summary.ts";
import type { GameEngine } from "../shared/game-engine.ts";
import { WorkerStopCode } from "../shared/workers.ts";
import { type PackageManager, type SandboxProblemCode, type StartStep, StudioPlatform } from "../shared/boot.ts";
import { ChatFileOpen } from "../shared/chat-files.ts";
import { sizeWords } from "../shared/byte-size.ts";
import { homePath, pathLeaf } from "../shared/path-label.ts";
import { freeableBytes, StorageKind, type StorageFreed, type StorageSpace } from "../shared/storage-space.ts";
import { SkippedBy, type SkippedFile } from "../shared/chat-rewind.ts";
import { LiveBehindReason } from "../shared/live-behind.ts";
import { PlayCardAction, PlayCoverRefusal, PlayMobileSupport } from "../shared/play-manage.ts";
import { AutoResumeCause, type CustomEvent, type CustomPayload } from "../shared/custom-events.ts";
import { EngineFailureKind } from "../shared/engine-requests.ts";
import { LocalServerProblem } from "../shared/local-server.ts";
import { COMPUTER_SETTING_QUESTION, type GithubLookupProblem } from "../shared/plugins.ts";
import { computerControlOffered, desktopStopShortcut } from "../shared/computer-control.ts";
import type { GenexPublishPhase } from "../shared/genex.ts";
import { PlayCategory, PlayNote, PlayShelf, RemixStep } from "../shared/play.ts";
import { CreditKind } from "../shared/play-credits.ts";
import { PurchaseProblem } from "../shared/play-purchase.ts";
import { AvatarBody, AvatarEyes, AvatarGear, BlockState } from "../shared/avatar-recipe.ts";
import { HANDLE_LENGTH, HandleState } from "../shared/handle.ts";
import { MakingKind } from "../shared/asset-making.ts";
import { ShareMiss } from "../shared/asset-library.ts";
import { RoundOutcome, roundOutcome, stoppedSource } from "../shared/run-state.ts";
import type { OutcomeView, RunEvidence } from "../shared/run-summary.ts";
import { CoreFact, LoopProfile } from "../shared/project-facts.ts";
import {
  GrantKind,
  isPlanRequest,
  PERMISSION_MODE_WORDS,
  PermissionGranted,
  PermissionMode,
  type PermissionGrant,
  RuleScope,
  ToolPermissionBy,
  type ToolPermissionEvent,
  ToolPermissionState,
} from "../shared/permissions.ts";
import { RunSharingDeleteOutcome, type RunSharingDeleteResult } from "../shared/run-sharing.ts";
import type { ProviderBuilderUse } from "../shared/provider-skills.ts";
import type { FinishCheckState, IterationStatus } from "./run-graph.ts";
import type { LeadFace } from "./run-tree.ts";
import type { CommandState } from "./state/command-runs.ts";
import type { JobState } from "./panels/plugins/genex/genex-view.ts";
import { plural } from "../shared/skill-words.ts";
import { JUDGE_PLAY_TOOL_NAME } from "../shared/chat-judge.ts";
import {
  APP_LOOK_TOOL_NAME,
  AppLookAccessKind,
  JOB_PERMISSION_TOOL,
  JobState as BackgroundJobState,
  JobStopper,
  JobTool,
} from "../shared/jobs.ts";
import { type ScreenAct, ScreenDeed } from "../shared/agent-screen.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { type ConnectorStep, StepAction } from "./chat/connector-steps.ts";
import { MentionMiss } from "../shared/prompt-mention.ts";
import { AssetScope, LibraryKind } from "../shared/asset-library.ts";
import { KindChoice } from "./play/asset-tiles.ts";

export type ToolIcon = "think" | "write" | "run" | "read" | "see" | "game";

/** A status has two shapes: a sentence for the titlebar, and a chip for the narrow rail. */
export interface StatusWords {
  line: string;
  short: string;
}

/** How wide the rail chip may be before it is clipped — "Crash damage · round 3" fits. */
const SHORT_MAX = 24;
/** How much of a plugin's arguments a permission request quotes before it is clipped. */
const CONSENT_ARGS_MAX = 120;

const RUN_ID = /\brun_[0-9a-z]+/gi;
/**
 * Every sha the harness prints is already shortened — `head.slice(0, 10)`, `(69f573d)` in a note
 * — so a 12-character floor never fired. Seven characters is the shortest git prints, and the
 * two lookaheads (a digit and a hex letter) keep ordinary words like "defaced" and dates like
 * "20260908" out of the net.
 */
const COMMIT_SHA = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;
/** `refs/studio/runs/run_x/integration` — a whole git ref, which stripping the run id alone leaves as rubble. */
const GIT_REF = /\brefs\/[^\s)]+/gi;

/**
 * Strip the identifiers out of a phrase. The harness stamps run ids, commit shas and git refs
 * into free text (facet titles, stop reasons, the lead's own decisions), and a user reading
 * "run_fixture123456" learns nothing — so they are removed here rather than trusted not to appear.
 */
export function withoutIds(text: string): string {
  return text
    .replace(GIT_REF, "")
    .replace(RUN_ID, "")
    .replace(COMMIT_SHA, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*·\s*(?=·|$)/g, "")
    .replace(/^\s*[·—-]\s*/, "")
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Close a phrase the model wrote, so the sentence the card puts after it does not run into it.
 * A lead's plan summary and a refusal both arrive as free text with no promise of a full stop.
 */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function settle(words: StatusWords): StatusWords {
  return { line: withoutIds(words.line), short: clip(withoutIds(words.short), SHORT_MAX) };
}

/** Whole-status phrases: the chat's own work and the run stages that name no part. */
const PHRASES: Array<[RegExp, (match: RegExpMatchArray) => StatusWords]> = [
  [/^thinking$/i, () => ({ line: "Thinking", short: "Thinking" })],
  [/^compacting the conversation$/i, () => ({ line: "Compacting the conversation", short: "Compacting" })],
  [
    /^self-improving(?: · (.+))?$/i,
    (m) => ({ line: m[1] ? `Improving its own craft · ${m[1]}` : "Improving its own craft", short: "Improving" }),
  ],
  [/^planning facets$/i, () => ({ line: "Planning the parts", short: "Planning" })],
  [
    /^building the (?:shared base|starting point)$/i,
    () => ({ line: "Building the starting point", short: "Starting point" }),
  ],
  // The run's other first step: a game the user brought that the studio cannot see into yet.
  [/^making the game judgeable$/i, () => ({ line: "Connecting your game to the studio", short: "Connecting" })],
  [
    /^plan ready — waiting for steering$/i,
    () => ({ line: "The plan is ready — waiting for your go-ahead", short: "Plan ready" }),
  ],
  [/^integrating facets$/i, () => ({ line: "Putting the parts together", short: "Merging" })],
  [/^judging the merged build$/i, () => ({ line: "Reviewing the merged build", short: "Reviewing" })],
  [/^integration facet$/i, () => ({ line: "Working on the merged build", short: "Merging" })],
  [/^global verdict$/i, () => ({ line: "Deciding what this build is worth", short: "Deciding" })],
  [/^director judging (.+)$/i, (m) => ({ line: `The lead is reviewing ${m[1]}`, short: `Reviewing ${m[1]}` })],
  [/^director playtesting (.+)$/i, (m) => ({ line: `The lead is playing ${m[1]}`, short: `Playing ${m[1]}` })],
  [/^director finishing$/i, () => ({ line: "The lead is finishing the build", short: "Finishing" })],
  [/^director$/i, () => ({ line: "The lead is watching the workers", short: "The lead" })],
  // A Loop led in place: its lead builds in the project itself, often with no workers at all.
  [/^lead in place$/i, () => ({ line: "The lead is building in your project", short: "The lead" })],
  [/^lead in place finishing$/i, () => ({ line: "A second AI is looking at your game", short: "Final look" })],
  [/^iteration (\d+) — building$/i, (m) => ({ line: `Round ${m[1]} · building`, short: `Round ${m[1]}` })],
  [/^iteration (\d+) — judging blind$/i, (m) => ({ line: `Round ${m[1]} · reviewing`, short: `Round ${m[1]}` })],
  [
    /^rate limited — retrying in (\d+)s$/i,
    (m) => ({ line: `The model's rate limit is holding us up — trying again in ${m[1]}s`, short: "Waiting" }),
  ],
  [/^scouting the game$/i, () => ({ line: "Looking at the game as it is now", short: "Looking" })],
  [/^checking (.+) in the preview$/i, (m) => ({ line: `Checking ${m[1]} in the preview`, short: "Checking" })],
  [
    /^observation outage — retrying evidence in (\d+)s/i,
    (m) => ({ line: `The studio could not see the game — looking again in ${m[1]}s`, short: "Looking again" }),
  ],
  [
    /^(.+) is overloaded — waiting (\d+)s before retrying/i,
    (m) => ({ line: `${capitalise(m[1] ?? "")} is busy — trying again in ${m[2]}s`, short: "Waiting" }),
  ],
  // The chat's own two states, which name the engine to itself: the user reads the work, not the
  // tool doing it.
  [/^.+ interviewing for .+$/i, () => ({ line: "The studio is working out what to build", short: "Interviewing" })],
  [/^.+ building (.+)$/i, (m) => ({ line: `Building ${m[1]}`, short: "Building" })],
];

/** A builder's own status: "<part> — <what it is doing>". The part keeps its own title. */
const PART_PHRASES: Array<[RegExp, (part: string, match: RegExpMatchArray) => StatusWords]> = [
  [/^iteration (\d+)$/i, (part, m) => ({ line: `${part} · round ${m[1]}`, short: `${part} · round ${m[1]}` })],
  [/^spike on .+$/i, (part) => ({ line: `${part} · a focused fix for one check`, short: `${part} · fixing` })],
  [/^verifying$/i, (part) => ({ line: `${part} · checking the round`, short: `${part} · checking` })],
  [
    /^fixing review findings$/i,
    (part) => ({ line: `${part} · fixing what the review found`, short: `${part} · fixing` }),
  ],
  [
    /^reverting a regression$/i,
    (part) => ({ line: `${part} · undoing something that broke`, short: `${part} · undoing` }),
  ],
  [
    /^provider overloaded, retrying in (\d+)s$/i,
    (part, m) => ({ line: `${part} · the model is busy — trying again in ${m[1]}s`, short: `${part} · waiting` }),
  ],
  [
    /^judge overloaded, retrying verification in (\d+)s$/i,
    (part, m) => ({ line: `${part} · the reviewer is busy — trying again in ${m[1]}s`, short: `${part} · waiting` }),
  ],
  [
    /^waiting for its model provider \((.+)\)$/i,
    (part, m) => ({ line: `${part} · waiting for the model provider (${m[1]})`, short: `${part} · waiting` }),
  ],
];

/** The phases the harness hangs off a title with " — ": stripped when the title itself has a dash. */
const PHASE_SUFFIX =
  /\s+—\s+(iteration \d+|verifying|spike on .+|fixing review findings|reverting a regression|(?:provider|judge) overloaded.*|waiting for its model provider.*)$/i;

/**
 * Turn a harness status line into what the user reads. The harness prefixes almost every status
 * with `run <runId> ·`; that prefix is dropped, not shortened, because the old rail chip kept
 * exactly that segment and read "run run_mtrfu5…" for the whole run.
 */
export function statusWords(status: string): StatusWords {
  const raw = (status ?? "").trim();
  if (!raw || raw.toLowerCase() === "idle") return { line: "", short: "" };
  const rest = withoutRunPrefix(raw);
  if (!rest) return settle({ line: "The build is running", short: "Building" });
  // An unrecognised status still must not read "run": the run prefix was already dropped, so
  // the chip takes the first thing the harness actually named, clipped by `settle`.
  const unrecognised = { line: capitalise(rest), short: (rest.split("·")[0] ?? "").trim() || rest };
  return settle(phraseWords(rest) ?? partStatusWords(rest) ?? unrecognised);
}

/** The status with the harness's `run <runId> ·` segment dropped. */
function withoutRunPrefix(raw: string): string {
  const segments = raw
    .split("·")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const inRun = /^run(\s+\S+)?$/i.test(segments[0] ?? "");
  return (inRun ? segments.slice(1) : segments).join(" · ");
}

function phraseWords(rest: string): StatusWords | null {
  for (const [pattern, words] of PHRASES) {
    const match = rest.match(pattern);
    if (match) return words(match);
  }
  return null;
}

/**
 * A builder's status is `<title> — <phase>`, and a title the lead invented may hold a dash of
 * its own ("Crash damage — deformation — iteration 3"). Read the last dash first and keep that
 * reading only when what follows is a phase this module knows; otherwise fall back to the first
 * dash and strip a known phase off the end, so no title can carry "iteration 3" to the titlebar.
 */
function partStatusWords(rest: string): StatusWords | null {
  const lastDash = rest.match(/^(.+) — (.+)$/);
  const firstDash = rest.match(/^(.+?) — (.+)$/);
  for (const split of [lastDash, firstDash]) {
    const known = split ? knownPartPhase(split) : null;
    if (known) return known;
  }
  if (!firstDash) return null;
  const [, title = "", doing = ""] = firstDash;
  const plain = title.trim();
  const phase = doing.trim().replace(PHASE_SUFFIX, "").trim();
  return { line: phase ? `${plain} · ${phase}` : plain, short: plain };
}

function knownPartPhase([, title = "", doing = ""]: RegExpMatchArray): StatusWords | null {
  for (const [pattern, words] of PART_PHRASES) {
    const match = doing.trim().match(pattern);
    if (match) return words(title.trim(), match);
  }
  return null;
}

/**
 * The run a status line belongs to. The harness stamps `run <runId> · …` on almost every status;
 * nothing outside this module should know that grammar, but the stage does need the id itself to
 * tell "the run I am drawing" from "a run that has only just been asked for".
 */
export function runIdIn(status: string): string | null {
  return /^run (\S+)\b/.exec((status ?? "").trim())?.[1] ?? null;
}

/** Has the run been asked for but not yet drawn anything — no parts, no rounds, no build? */
export function isPlanning(status: string): boolean {
  return /^run \S+ · planning facets\b/i.test((status ?? "").trim());
}

// ── verdicts ──────────────────────────────────────────────────────────────────────────────

export interface Verdict {
  /** The harness's own winner field: "challenger" when the new round won. */
  winner?: string | null;
  satisfied?: boolean;
  /** The harness's `verdictSource`: how the decision was reached. */
  source?: string | null;
  /**
   * The round's own verdict record (`loop/verdict.ts`). Its `because` is written by the pass
   * that judged the build and already names what it measured — "2 checks that were failing now
   * pass" rather than "the checks it was given now pass". When one is there it wins; the mapping
   * below stays for every run recorded before the record existed.
   */
  record?: { because?: string | null } | null;
}

export interface VerdictWords {
  /** "kept" · "undone" · "done" — the word on the round. */
  word: string;
  /** The one sentence that says why, with no check ids in it. */
  because: string;
  /** word + because, for a single line. */
  label: string;
}

/** The harness calls the new build "challenger"; the user only ever hears "kept". */
export function isKept(winner: string | null | undefined): boolean {
  return roundOutcome({ winner }) === RoundOutcome.Accepted;
}

const UNDONE_BECAUSE: Record<string, string> = {
  invisible: "nothing visible changed",
  "taste-veto": "the reviewer preferred the round before",
  "no-move": "the step it was asked for was not delivered",
  unfixed: "the must-fix was not fixed",
  broken: "the build was broken",
  outage: "the model could not be reached",
  race: "the game had not finished loading when it was looked at",
};

/**
 * Does a line of prose report trouble? Only for the narration whose record carries nothing but
 * its prose — the lead's decisions, a builder's checkpoint note, a judge's sentence — until the
 * harness records a structured flag on them. Every other line's trouble is read from its record.
 */
export function soundsLikeTrouble(text: string): boolean {
  return /failed|error|could not|not delivered|stopped|unavailable|refused|broke again/i.test(text);
}

/** A round undone because its judge could not be reached, not because the build lost. */
export function judgeUnreachable(source: string | null | undefined): boolean {
  return source === "outage";
}

/**
 * A round the lead ended mid-build. Nobody judged it and nothing was thrown away — the
 * builder's work is kept on a branch — so it is neither kept nor undone, and it must never
 * wear the red of a build that broke.
 */
export function wasStopped(source: string | null | undefined): boolean {
  return stoppedSource(source);
}

/** The harness's verdict source for a save point the Unreal lead made itself (its `VerdictSource.Lead`). */
const LEAD_SAVE = "lead";

/**
 * A round the Unreal lead kept by saving it, after looking at its own captures: no reviewer judged
 * it and nothing compared it side by side, so it is never worded as a reviewer's verdict.
 */
export function savedByLead(source: string | null | undefined): boolean {
  return source === LEAD_SAVE;
}

/** How a save the lead made itself reads, beside the reviewers' verdicts. */
const LEAD_SAVE_WORDS: VerdictWords = {
  word: "saved",
  because: "the lead looked at its own captures and saved it",
  label: "saved — the lead looked at its own captures and saved it",
};

/**
 * "the judge", "no judges'", "the taste judge's": the role as a noun, after the word that makes it
 * one. A bare "judge it" is the verb and never matches.
 */
const JUDGE_NOUN = /\b(the|a|no|any|every|each|its|their)((?:\s+(?:taste|side-by-side|blind))?\s+)judge(s?)\b/gi;
/** The one participle a landing line uses for the role ("made live, not judged better"). */
const NOT_JUDGED_BETTER = /\bnot judged better\b/gi;

/**
 * A sentence the harness wrote, in the app's name for the reviewing role.
 *
 * The harness, its prompts and the models that read them call that role "judge" (`loop/judge.ts`,
 * `loop/verdict.ts`, `director/rules.ts`, `prompts/`), and that word stays there on purpose: it is
 * the models' vocabulary, and renaming it would change what they read. The app calls the same role
 * Reviewers (ModelMenu.tsx, and "reviewer" in every sentence it writes itself). So the harness's
 * sentences are reworded here, when they are shown, never at their source — which also keeps
 * runs logged before the rename reading the same. Do not "fix" the seed to say reviewer.
 */
export function reviewerWords(text: string): string {
  return text
    .replace(JUDGE_NOUN, (_, det: string, between: string, plural: string) => `${det}${between}reviewer${plural}`)
    .replace(NOT_JUDGED_BETTER, "not reviewed better");
}

/**
 * The sentence a verdict record wrote, ready for a card to print.
 *
 * `loop/verdict.ts` composes it out of the run's own material — a builder's title among it — so
 * it is model-authored text like any other and passes the same gate. Every surface that shows a
 * record's sentence (the Builds drawer, the round cards, the reviewers' sheet, the chat) reads it
 * through here rather than off the payload, in the app's role names (`reviewerWords`).
 */
export function verdictSentence(record: { because?: string | null } | null | undefined): string {
  return typeof record?.because === "string" ? reviewerWords(withoutIds(record.because)) : "";
}

/** Why an undone round was undone — the reason alone, for a card that already says "Undone". */
export function undoneBecause(source: string | null | undefined, record: Verdict["record"] = null): string {
  const written = verdictSentence(record);
  if (written) return bareReason(written);
  return UNDONE_BECAUSE[source ?? ""] ?? "it was not clearly better than the round before";
}

/**
 * A record's sentence starts with its own verdict word ("Kept: two checks…"), because it is
 * written to stand alone. A card that already says "kept" wants the rest of it.
 */
const OWN_WORD = /^(?:kept|undone|not judged|made live|nothing was made live)\s*[:—-]\s*/i;

/** One round's verdict in three shapes: the word, the reason, and the two joined. */
export function verdictWords(verdict: Verdict): VerdictWords {
  const written = verdictSentence(verdict.record);
  if (wasStopped(verdict.source)) {
    const because = written
      ? bareReason(written)
      : "the lead ended it before it was finished, so nobody reviewed it and the work it had done is kept";
    return { word: "stopped", because, label: written || `stopped — ${because}` };
  }
  if (savedByLead(verdict.source) && !written) return LEAD_SAVE_WORDS;
  // A round with no winner recorded was neither kept nor undone: nobody's verdict reached the log.
  const outcome = roundOutcome({ winner: verdict.winner, verdictSource: verdict.source });
  const word = verdictWord(verdict, outcome);
  if (written) return { word, because: bareReason(written), label: written };
  const because = unwrittenBecause(verdict, outcome);
  return { word, because, label: `${word} — ${because}` };
}

function verdictWord(verdict: Verdict, outcome: RoundOutcome): string {
  if (verdict.satisfied) return "done";
  if (outcome === RoundOutcome.Accepted) return "kept";
  return outcome === RoundOutcome.Rejected ? "undone" : "not reviewed";
}

/** Why, for a run from before the verdict record wrote its own sentence. */
function unwrittenBecause(verdict: Verdict, outcome: RoundOutcome): string {
  if (verdict.satisfied) return "the checks it was given pass and the reviewer agrees";
  if (outcome === RoundOutcome.Accepted)
    return verdict.source === "checks"
      ? "the checks it was given now pass, and no reviewer objected"
      : "the reviewer preferred it to the round before";
  return outcome === RoundOutcome.Rejected ? undoneBecause(verdict.source) : "no verdict was recorded for it";
}

/** A written sentence with its leading verdict word taken off, so a card can put its own in front. */
function bareReason(sentence: string): string {
  const rest = sentence.replace(OWN_WORD, "").replace(/\.$/, "");
  return rest ? rest.charAt(0).toLowerCase() + rest.slice(1) : sentence;
}

/** The wording every round carries — in the chat line, the graph card and the details table. */
export function verdictLabel(
  winner: string | null,
  satisfied: boolean,
  source: string | null,
  record: Verdict["record"] = null,
): string {
  return verdictWords({ winner, satisfied, source, record }).label;
}

/** The label of a round still being built when the run ended. */
export const ABANDONED_ROUND_LABEL = "not reviewed — the run ended first";

/** The label of a round still being built, naming the step or fix it was asked for when there is one. */
export function buildingRoundLabel(asked: string | null | undefined): string {
  return asked ? `building · move: ${asked}` : "building";
}

/**
 * What the side-by-side judge did with this round — the question users actually ask of it. The
 * statuses are `IterationStatus` values, typed but spelled out: this module imports no runtime
 * code from the graph that reads it.
 */
export function sideBySideWords(node: { status: IterationStatus; satisfied: boolean; source: string | null }): string {
  if (node.status === "building") return "";
  if (node.status === "stopped") return "Not reviewed — the lead stopped this round.";
  if (savedByLead(node.source)) return "Not reviewed — the lead saved it after looking at its own captures.";
  if (node.status === "unjudged") return "Not reviewed — no verdict was recorded for this round.";
  if (node.status === "rolled") {
    if (node.source === "taste-veto") return "The reviewer preferred the round before.";
    if (node.source === "no-move") return "Not asked — the step did not land.";
    return "Not needed — the round was undone on the checks.";
  }
  if (node.satisfied) return "The reviewer is satisfied with this part.";
  return node.source === "checks"
    ? "No objection to the new build."
    : "The reviewer preferred the new build to the round before.";
}

/**
 * Why the run ended. The harness writes this for itself — "land=no", "autopilot finished" —
 * so the few phrases that carry a decision are named here and everything else is at least
 * stripped of ids before it reaches a screen.
 */
export function stoppedWords(reason: string | null | undefined): string {
  let raw = (reason ?? "").trim();
  if (!raw) return "it finished";
  // A stopped builder's reason ends with the branch its work was left on. The user is told the
  // work was kept; the branch name is the harness's own bookkeeping.
  let kept = "";
  if (KEPT_ON_BRANCH.test(raw)) {
    raw = raw.replace(KEPT_ON_BRANCH, "").trim();
    kept = " — its work was kept";
  }
  // Every close composes "<why>; <what happened to the build>". Both halves carry a reason, and
  // matching the landing half anywhere in the string used to swallow the why with it.
  const landing = LANDING_CLAUSE.test(raw);
  const why = raw.replace(LANDING_CLAUSE, "").trim();
  const said = whyItEnded(why);
  if (said) return `${said}${kept}`;
  if (landing || /^(?:nothing was landed|land=no)\b/i.test(why)) return "nothing was made live";
  return `${withoutIds(why || raw)}${kept}`;
}

/** `…; nothing was landed (land=no)` — the landing half every close appends to its reason. */
const LANDING_CLAUSE = /;\s*(?:nothing was landed|the integration branch was landed)(?:\s*\([^)]*\))?\s*$/i;
/** `… — its work so far is kept on refs/studio/…/attempts/cars2/3-stopped` — not the user's business. */
const KEPT_ON_BRANCH = /\s*—\s*its work so far is kept on \S+\s*$/i;

/** The half of a close that says why the run (or a builder) ended, in the user's words. */
function whyItEnded(why: string): string | null {
  if (!why) return null;
  if (/^stopped by the user$/i.test(why)) return "you stopped it";
  if (/at the user.s request/i.test(why)) return "you asked it to wrap up";
  if (/^the director finished the run$/i.test(why)) return "the lead finished the build";
  // "stopped by the director: fixing the starting point" — the run's own words, minus the
  // job title. The lead stopping a builder is not the owner asking for anything.
  if (/^stopped by the director\b/i.test(why)) {
    const said = why.replace(/^stopped by the director\b[:\s—-]*/i, "").trim();
    return said ? `stopped by the lead — ${withoutIds(said)}` : "stopped by the lead";
  }
  if (/^autopilot finished$/i.test(why)) return "the build finished";
  // A lost provider paused it (harness provider-loss.ts `pauseEnding`): what to fix, never the provider's own words.
  if (/^the engine lost its sign-in\b/i.test(why))
    return "the model provider stopped accepting the account — sign in again, then Resume";
  if (/^the engine's provider stayed down\b/i.test(why))
    return "the model provider stayed down — Resume picks the build up";
  // The engine's own limit is the one ending a user can act on: it says when to come back.
  if (/usage cap|usage limit|session limit|rate limit/i.test(why))
    return "the engine hit its limit — the build can pick up again when it resets";
  if (/ran out of time/i.test(why)) return "it ran out of time";
  if (/session ended/i.test(why)) return "the engine's session ended early";
  if (/interrupted by restart|the studio restarted/i.test(why)) return "the studio restarted";
  // "facet budget exhausted", "wall-clock budget exhausted": a builder that reached the end of
  // the time it was given did not fail at anything.
  if (/budget exhausted/i.test(why)) return "it used up the time it was given";
  return null;
}

/**
 * Did this part simply reach the end of the time it was given? A part whose every round was kept
 * and which then ran out of budget is not a part in trouble, and must not wear the same orange as
 * one the lead stopped or the engine cut off.
 */
export function ranToItsEnd(reason: string | null | undefined): boolean {
  return /budget exhausted|settled|yielded/i.test(reason ?? "");
}

/** Was the run ended by the owner rather than by the lead, the clock or the engine? */
export function wasCancelled(reason: string | null | undefined): boolean {
  return /^stopped by the user\b/i.test((reason ?? "").trim());
}

/**
 * A run's outcome in words (`summaryOutcome` in shared/run-summary.ts), in the three places it is
 * said: `full` in the Builds view and its details, `chat` on the chat's outcome card (a stopped
 * build's card says so in its own line, and "incomplete" checks go unmentioned), and `card` on
 * the chat's collapsible outcome, which names checks either way.
 */
export function outcomeTitle(view: OutcomeView, variant: OutcomeVariant = "full"): string {
  const { state, delivered } = view;
  const full = variant === "full";
  const subject = full ? "Run" : "Build";
  const available = delivered === "available" && variant !== "chat" ? " · Integrated build available" : "";
  switch (state) {
    case "unknown":
      return full ? "Run status unavailable" : "Build status unavailable";
    case "failed":
      return `${subject} failed${available}`;
    case "cancelled":
      return cancelledTitle(variant, available);
    case "running":
      return delivered === "available" ? "Building · Earlier build available" : "Building";
    case "paused":
      return `${subject} paused${available}`;
    case "finished":
      return finishedTitle(view, variant);
  }
}

type OutcomeVariant = "full" | "chat" | "card";

function cancelledTitle(variant: OutcomeVariant, available: string): string {
  if (variant === "full") return `Run cancelled${available}`;
  return variant === "card" ? `Build stopped${available}` : "Build cancelled";
}

function finishedTitle({ delivered, verification, inPlace }: OutcomeView, variant: OutcomeVariant): string {
  const full = variant === "full";
  // A Loop led in the project's own folder kept its work there: no build is promised to play.
  if (inPlace) return full ? IN_PLACE_WORDS.finishedFull : IN_PLACE_WORDS.finished;
  if (delivered === "superseded")
    return full ? "Run finished · Newer integrated build not delivered" : "Newer integrated build not delivered";
  if (delivered !== "delivered") return full ? "Run finished · No build delivered" : "No new build";
  const attention = verification === "attention";
  if (full) return `Build delivered · ${attention ? "Checks need attention" : "Verification incomplete"}`;
  if (attention) return "Changes are live · Checks need attention";
  return variant === "card" ? "Changes are live · Checks incomplete" : "Changes are live";
}

/** How a Loop led in its project's own folder ends, wherever its run reads: its work is kept there, never promised as a build to play in Live. */
export const IN_PLACE_WORDS = {
  finished: "Changes are kept in your project",
  finishedFull: "Loop finished · Changes kept in your project",
  /** The result node's word and the run's line. */
  kept: "Kept in your project",
  headline: (after: string) => `Finished${after} · kept in your project`,
  because: "The Loop's work is kept in your project.",
  stoppedHeadline: (after: string) => `Stopped${after} · kept in your project`,
  stoppedBecause: "Stopped. What it built is kept in your project.",
} as const;

/** The morning's two sentences: what the run amounts to, and what became of the build. */
export interface LoopRunWords {
  /** "Finished after 21 rounds · live in your game" */
  headline: string;
  /** why it ended, or what happened to the build */
  because: string;
}

/**
 * How a finished run reads. The old screen decided this on `victory` — a flag the lead sets
 * only when it explicitly claims one — so a run that built, merged and landed a game read
 * "Stopped after 21 rounds". What the user actually cares about is whether the build reached
 * their game, which is `landed`, so that is what the headline says.
 */
export function loopRunWords(loopRun: {
  rounds: number;
  landed: boolean | null;
  stoppedBecause?: string | null;
  /** the run stopped where it can be picked up again — a plan limit, a quit, a crash */
  paused?: boolean;
  /** the provider failure that paused it (the close's `limit.kind`), when one did */
  pausedOn?: string | null;
  /**
   * Is there a merged build to play? The card offers Play only when the run left a head of its
   * own, so the sentence may only promise one under the same condition. Unknown counts as yes,
   * which is what an older log with no head recorded means.
   */
  hasBuild?: boolean;
  /**
   * The close's own sentence about landing ("made live, a judge preferred it" / "made live, not
   * judged better"). It is the one thing the user cannot see for themselves — whether anything
   * checked the build that is now their game — so it replaces the flat promise when it is there.
   */
  landing?: string | null;
  /** How the Loop worked on its project (`run_finished.profile`): `open` kept its work in the project's own folder. */
  profile?: string | null;
}): LoopRunWords {
  const rounds = Math.max(0, Math.trunc(loopRun.rounds || 0));
  const after = rounds ? ` after ${plural(rounds, "round")}` : "";
  const hasBuild = loopRun.hasBuild ?? true;
  const landing = reviewerWords(withoutIds((loopRun.landing ?? "").trim()));
  const why = stoppedWords(loopRun.stoppedBecause);
  if (loopRun.paused)
    return pausedLoopRunWords(after, wasCancelled(loopRun.stoppedBecause), pausedWhy(loopRun.pausedOn, why));
  const inPlace = loopRun.profile === LoopProfile.Open;
  if (wasCancelled(loopRun.stoppedBecause))
    return stoppedLoopRunWords(after, loopRun.landed === true, hasBuild, inPlace);
  if (loopRun.landed === true && inPlace)
    return { headline: IN_PLACE_WORDS.headline(after), because: IN_PLACE_WORDS.because };
  if (loopRun.landed === true) {
    return {
      headline: `Finished${after} · live in your game`,
      because: landing
        ? `${capitalise(landing)} — open Live to play it.`
        : "This build is your game now — open Live to play it.",
    };
  }
  if (loopRun.landed === false) {
    // Nothing merged: the old copy promised "kept and playable" over a card with no button at all.
    return hasBuild
      ? {
          headline: `Finished${after} · not made live yet`,
          because: `The build is kept and playable — ${fullStop(why)}`,
        }
      : { headline: `Finished${after} · nothing new`, because: `Your game is as you left it — ${fullStop(why)}` };
  }
  return { headline: `Finished${after}`, because: fullStop(capitalise(why)) };
}

/** Text that ends a sentence: a full stop added only when it has no end of its own (a close's reason may). */
function fullStop(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * Why a run its model provider paused stopped, and what brings it back, from the close's typed
 * kind (`run_finished.limit.kind`). A limit keeps the close's own words (`stoppedWords`).
 */
const PAUSED_ON_WORDS = {
  [EngineFailureKind.Auth]:
    "the model provider stopped accepting this account — sign in again (or ask your admin to turn access back on), then press Resume",
  [EngineFailureKind.Unavailable]: "the model provider stayed down — Resume picks the build up where it stopped",
} as const satisfies Partial<Record<EngineFailureKind, string>>;

/** The paused run's reason: the typed provider failure's words when there are some, else the close's. */
function pausedWhy(kind: string | null | undefined, why: string): string {
  return failureWords(PAUSED_ON_WORDS, kind) ?? why;
}

/** The words a table gives an engine failure kind, or null for a kind it does not name. */
function failureWords(table: Partial<Record<EngineFailureKind, string>>, kind: unknown): string | null {
  const known = Object.values(EngineFailureKind).find((value) => value === kind);
  return known ? (table[known] ?? null) : null;
}

/** Stop and pause are one thing to the owner: the work is kept and Resume sits beside this line. */
function pausedLoopRunWords(after: string, stopped: boolean, why: string): LoopRunWords {
  return {
    headline: `${stopped ? "Stopped" : "Paused"}${after}`,
    because: stopped
      ? "Stopped. Everything built so far is kept."
      : `${capitalise(why)}. Everything built so far is kept.`,
  };
}

/** A run the owner stopped: what reached the game, what is kept, or that nothing changed. */
function stoppedLoopRunWords(after: string, landed: boolean, hasBuild: boolean, inPlace: boolean): LoopRunWords {
  if (landed && inPlace)
    return { headline: IN_PLACE_WORDS.stoppedHeadline(after), because: IN_PLACE_WORDS.stoppedBecause };
  if (landed)
    return { headline: `Stopped${after} · live in your game`, because: "Stopped. What it built is in your game now." };
  if (hasBuild)
    return {
      headline: `Stopped${after} · the build so far is kept`,
      because: "Stopped. Everything built so far is kept.",
    };
  return { headline: `Stopped${after}`, because: "Stopped. Your game is as you left it." };
}

// ── when something refuses ────────────────────────────────────────────────────────────────

/**
 * The studio's own refusals, in the user's words. Every one of these is an ordinary morning —
 * a builder still working in the folder, an edit of the user's own sitting there, a build that
 * cannot merge cleanly — and each used to reach the toast as the sentence a developer wrote for
 * a log, with the git command's output still attached.
 */
const PROBLEMS: Array<[RegExp, string]> = [
  [/is not a commit hash|is not in ".*"'s history/i, "That build is not in this game's history any more."],
  [
    /(?:a contractor|a builder) is building in .* right now/i,
    "A worker is busy in your game folder right now — try again once it has finished.",
  ],
  [
    /uncommitted edits/i,
    "Your game folder has edits of its own, and the studio will not write over them — save or undo them, then try again.",
  ],
  [
    /conflicted with the game folder/i,
    "That build and your game folder changed the same things, so nothing was changed.",
  ],
];

/**
 * What went wrong, for a toast. Anything the studio itself phrased passes through with its ids
 * stripped and the raw tool output cut off; anything else at least never shows a sha.
 */
export function problemWords(err: unknown): string {
  const raw = errorText(err).trim();
  if (!raw) return "That didn't work, and nothing was changed.";
  for (const [pattern, said] of PROBLEMS) if (pattern.test(raw)) return said;
  // A trailing parenthetical is where the git or engine output is pasted; the sentence before it
  // is the studio's own.
  const plain = withoutIds(raw.replace(/\s*\([^()]{40,}\)\s*$/, "").trim());
  if (!plain) return "That didn't work, and nothing was changed.";
  return sentence(capitalise(plain));
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

// ── the checks ────────────────────────────────────────────────────────────────────────────

/**
 * What a round's checks came to. "1 of 10 checks" reads as nine failures; on the first real run
 * nine of them were checks nothing could measure, which is the difference between "the game is
 * wrong" and "the studio couldn't look". All three surfaces say it the same way.
 *
 * The counted checks are the ones the plan asked for. A judge that keeps naming what it still
 * dislikes grows its own questions beside them, and on that run they outnumbered the plan's —
 * a part whose work was passing read "1 of 10". They are counted separately, as notes, because
 * that is what they are: a judge's opinion of the build, not the job it was given.
 */
export interface CheckBoard {
  total?: number | null;
  passing?: number | null;
  unmeasured?: number | null;
  plannedTotal?: number | null;
  plannedPassing?: number | null;
  plannedUnmeasured?: number | null;
  grownTotal?: number | null;
}

export function checkCounts(board: CheckBoard | null | undefined): string {
  if (!board) return "No checks yet";
  const { total, passed, unmeasured, notes } = countedChecks(board);
  const failed = Math.max(0, total - passed - unmeasured);
  const parts: string[] = [];
  if (passed) parts.push(`Passed ${passed}`);
  if (failed) parts.push(`Failed ${failed}`);
  if (unmeasured) parts.push(`Couldn't measure ${unmeasured}`);
  if (notes) parts.push(plural(notes, "reviewer note"));
  if (!total && !notes) return "No checks yet";
  return parts.length ? parts.join(" · ") : "No checks yet";
}

const whole = (value: number | null | undefined): number => Math.max(0, Math.trunc(value ?? 0));

/** The plan's checks, counted; a run from before the split has no planned counts: everything it measured was a check. */
function countedChecks(board: CheckBoard): { total: number; passed: number; unmeasured: number; notes: number } {
  if (typeof board.plannedTotal !== "number")
    return { total: whole(board.total), passed: whole(board.passing), unmeasured: whole(board.unmeasured), notes: 0 };
  return {
    total: whole(board.plannedTotal),
    passed: whole(board.plannedPassing),
    unmeasured: whole(board.plannedUnmeasured),
    notes: whole(board.grownTotal),
  };
}

// ── the run, as it narrates itself ──────────────────────────────────────────────────────

/** Every per-round line names the part the lead named, and never the id underneath it. */
export interface PartRound {
  facetTitle?: string | null;
  facetId?: string | null;
  iteration?: number | null;
}

function partName(part: PartRound, fallback = "a part"): string {
  return withoutIds((part.facetTitle ?? "").trim()) || fallback;
}

/** "Crash damage · round 3" — the prefix every per-round line in the chat and the graph shares. */
export function partRoundWords(part: PartRound): string {
  const name = partName(part);
  return typeof part.iteration === "number" ? `${name} · round ${part.iteration}` : name;
}

/**
 * What the run is: the reference it was given, if it was given one, and which model judges it.
 *
 * The judge is named because it is the one role a saved preference can quietly get wrong — a
 * run was judged by the orchestrator's model and nothing said so. `judge` is the model's own
 * short name (model-roles' `roleName`); "default" is not a name a person can act on, so a run
 * whose critic is whatever the engine happens to use says nothing about it.
 */
export function runStartWords(
  reference: { name?: string | null; kind?: string | null } | null | undefined,
  judge: string | null = null,
): string {
  const name = withoutIds((reference?.name ?? "").trim());
  const named = name && name.toLowerCase() !== "unnamed" ? name : "";
  const who = withoutIds((judge ?? "").trim());
  const blind =
    who && !/^(default|same)$/i.test(who)
      ? `${who}, reviewing without being told which build is which, picks the winner`
      : "a reviewer that cannot see which is which picks the winner";
  const rule = `each round has to beat the one before, and ${blind}`;
  if (reference?.kind === "direction") return named ? `heading in the direction of "${named}" — ${rule}` : rule;
  return named ? `the bar for this build is "${named}" — ${rule}` : rule;
}

/** How the run is organised — the first thing the user reads after pressing send. */
export function autopilotStartWords(start: {
  facets?: Array<{ id?: string | null; title?: string | null; budgetShare?: number | null }> | null;
  maxParallel?: number | null;
  director?: boolean;
}): string {
  const hands = Math.max(1, Math.trunc(start.maxParallel ?? 1));
  if (start.director) {
    return `the lead is taking this build — it looks at your game first, puts up to ${plural(hands, "worker")} to work, checks what they make and puts it together`;
  }
  const facets = start.facets ?? [];
  const named = facets
    .map((facet) => {
      const title = withoutIds((facet?.title ?? "").trim()) || "a part";
      return typeof facet?.budgetShare === "number" ? `${title} ${Math.round(facet.budgetShare * 100)}%` : title;
    })
    .join(" · ");
  const pace = hands > 1 ? `up to ${hands} workers at once` : "one part at a time";
  return `this build is split into ${plural(facets.length, "part")}${named ? ` (${named})` : ""} — ${pace}, each reviewed on its own`;
}

/**
 * The lead's own decisions, which it writes for itself: job titles, ten-character shas, git refs
 * and the provider's raw exception text. This is the busiest line of the run, so it is the one
 * that most needs saying in the user's words. The raw text stays on the event for Details.
 */
export function decisionWords(decision: string): string {
  const raw = (decision ?? "").trim();
  if (!raw) return "a call was made without a reason";
  if (/\b(usage cap|usage limit|session limit|rate limit)\b/i.test(raw))
    return "the model provider stopped us — waiting for the limit to reset";
  const worker = raw.match(/^(?:the )?director started worker "([^"]*)" \(([^)]*)\):\s*([\s\S]*)$/i);
  if (worker) {
    const [, title = "", terms = "", rest = ""] = worker;
    const minutes = terms
      .split(",")
      .map((part) => part.trim())
      .find((part) => /\d+\s*min/i.test(part));
    const brief = withoutIds(rest.trim());
    return `the lead put a worker on "${withoutIds(title)}"${minutes ? ` for ${minutes}` : ""}${brief ? `: ${brief}` : ""}`;
  }
  const said = raw
    .replace(/\s*—?\s*kept unlanded on\b.*$/i, " — so nothing was made live")
    // "stopped worker post2" — the worker's id says nothing to the person reading it.
    .replace(/\bworker\s+[a-z][a-z0-9]*[0-9][a-z0-9._-]*/gi, "a worker")
    .replace(/\bthe director\b/gi, "the lead")
    .replace(/\bdirector\b/gi, "the lead")
    .replace(/\bthe integrated build\b/gi, "this build")
    .replace(/\bthe integration branch\b/gi, "this build")
    .replace(/\bdid not pass its health pass\b/gi, "did not run when it was checked")
    .replace(/\bhealth pass\b/gi, "check that it still runs")
    .replace(/\bthe harness\b/gi, "the studio")
    .replace(/\bthe planner\b/gi, "the studio")
    .replace(/\biterations\b/gi, "rounds")
    .replace(/\biteration\b/gi, "round");
  return reviewerWords(withoutIds(said));
}

/** The step a round was asked to make, and whether it arrived. */
export function moveWords(
  move: PartRound & { what?: string | null; delivered?: boolean | null; scale?: string | null },
): string {
  const what = withoutIds((move.what ?? "").trim());
  const scale = move.scale ? ` (${withoutIds(String(move.scale))})` : "";
  return `${partRoundWords(move)}: ${stepState(move.delivered)}${what ? ` — ${what}` : ""}${scale}`;
}

function stepState(delivered: boolean | null | undefined): string {
  if (delivered === true) return "the step landed";
  return delivered === false ? "the step did not land" : "asked for a step";
}

/** A must-fix the judge keeps naming, and what became of it. */
export function fixWords(
  fix: PartRound & {
    what?: string | null;
    delivered?: boolean | null;
    mandatory?: boolean | null;
    streak?: number | null;
  },
): string {
  const what = withoutIds((fix.what ?? "").trim());
  const streak = typeof fix.streak === "number" && fix.streak > 1 ? ` (named ${fix.streak} times now)` : "";
  return `${partRoundWords(fix)}: ${fixState(fix)}${what ? ` — ${what}` : ""}${streak}`;
}

function fixState(fix: { delivered?: boolean | null; mandatory?: boolean | null }): string {
  if (fix.delivered === true) return "fixed";
  if (fix.delivered === false) return "still there";
  return fix.mandatory ? "must be fixed — a round that leaves it cannot be kept" : "asked for a fix";
}

/**
 * How alive the game feels, out of the judge's own scale — or, for a game that is a screen
 * rather than a place (a board, a puzzle, a builder), how well that screen reads. The two
 * critics score different questions, so the user is told which one answered.
 */
export function livenessWords(
  alive: PartRound & {
    critic?: string | null;
    total?: number | null;
    max?: number | null;
    biggest?: string | null;
    summary?: string | null;
    grow?: string[] | null;
    polish?: string[] | null;
  },
): string {
  const question = alive.critic === "screen" ? "how well the screen reads" : "how alive it feels";
  const score =
    typeof alive.total === "number"
      ? ` ${alive.total}${typeof alive.max === "number" ? ` out of ${alive.max}` : ""}`
      : "";
  const weakest = alive.biggest ? ` · weakest: ${withoutIds(alive.biggest)}` : "";
  const summary = alive.summary ? ` — ${withoutIds(alive.summary)}` : "";
  const grow = alive.grow?.length ? ` · could grow: ${alive.grow.join(", ")}` : "";
  const polish = alive.polish?.length ? ` · could polish: ${alive.polish.join(", ")}` : "";
  return `${partRoundWords(alive)}: ${question}${score}${weakest}${summary}${grow}${polish}`;
}

/**
 * What took a round's model provider away (`facet_provider_outage.lost`, an engine failure kind):
 * the round waits for it, and the user reads why without the provider's own exception.
 */
const LOST_PROVIDER_WORDS = {
  [EngineFailureKind.Auth]: "stopped accepting the account",
  [EngineFailureKind.UsageLimit]: "hit your plan's usage cap",
  [EngineFailureKind.RateLimit]: "hit your plan's session limit",
  [EngineFailureKind.Unavailable]: "is down",
} as const satisfies Partial<Record<EngineFailureKind, string>>;

/** The provider is busy, or lost. The user needs the wait, never the exception text. */
export function outageWords(
  outage: PartRound & {
    phase?: string | null;
    minutes?: number | null;
    attempt?: number | null;
    /** The provider was lost, not busy (an engine failure kind): the round waits for it. */
    lost?: string | null;
  },
): string {
  const lost = failureWords(LOST_PROVIDER_WORDS, outage.lost);
  if (lost)
    return `${partName(outage, "this build")}: the model provider ${lost} — the round waits for it; nothing is counted against the build`;
  const minutes = Math.max(1, Math.trunc(outage.minutes ?? 1));
  return `${partName(outage, "this build")}: the model provider is busy — waiting ${minutes} min before trying again (attempt ${Math.max(1, Math.trunc(outage.attempt ?? 1))}); nothing is counted against the build`;
}

/** The modeller made something (AG-930) — or could not. */
export function modelWords(
  asset: PartRound & {
    name?: string | null;
    bytes?: number | null;
    ok?: boolean;
    error?: string | null;
    triangles?: number | null;
    polygons?: number | null;
  },
): string {
  const where = typeof asset.iteration === "number" ? partRoundWords(asset) : partName(asset, "the modeller");
  const name = withoutIds((asset.name ?? "").trim()) || "a model";
  if (!asset.ok) return `${where}: ${name} failed — ${withoutIds((asset.error ?? "unknown error").trim())}`;
  const size = kilobyteWords(asset.bytes ?? 0);
  return `${where}: modelled ${name} (${[size, modelShape(asset)].filter(Boolean).join(", ")})`;
}

const BYTES_PER_KB = 1024;

/** A size in whole kilobytes: "12 KB". */
export const kilobyteWords = (bytes: number): string => `${Math.round(bytes / BYTES_PER_KB)} KB`;

/** How many files a line about files too large to save names before "and N more". */
const SKIPPED_FILES_NAMED = 3;

/** A listed file a `checkpoint_skipped` record can be read for: its path and its size. */
function isSkippedFile(entry: unknown): entry is SkippedFile {
  const file = entry as Partial<SkippedFile> | null;
  return typeof file?.file === "string" && file.file !== "" && typeof file.bytes === "number" && file.bytes >= 0;
}

/**
 * Files too large to save, which Rewind cannot bring back, as the chat says it: left out by a
 * message's checkpoint, or left as they were by a rewind. Up to three names with their sizes, then
 * how many more. Null when the record names no file it can read.
 */
export function checkpointSkippedWords(skipped: CustomPayload<typeof CustomEvent.CheckpointSkipped>): string | null {
  const listed: unknown[] = Array.isArray(skipped.files) ? skipped.files : [];
  const files = listed.filter(isSkippedFile);
  if (!files.length) return null;
  const total = Math.max(files.length, typeof skipped.total === "number" ? skipped.total : 0);
  const shown = files.slice(0, SKIPPED_FILES_NAMED);
  const named = shown.map((file) => `${file.file.split("/").pop()} (${sizeWords(file.bytes)})`).join(", ");
  const which = total > shown.length ? `${named} and ${total - shown.length} more` : named;
  if (skipped.by !== SkippedBy.Rewind)
    return `Rewind can’t bring back ${plural(total, "file")} that ${total === 1 ? "is" : "are"} too large to save: ${which}.`;
  if (total === 1) return `This file was too large to save, so the rewind left it as it is: ${which}.`;
  return `These files were too large to save, so the rewind left them as they are: ${which}.`;
}

/** What the GPU draws for a model: its triangles when counted, else its polygons. */
function modelShape(asset: { triangles?: number | null; polygons?: number | null }): string {
  if (typeof asset.triangles === "number") return `${asset.triangles} triangles`;
  return typeof asset.polygons === "number" ? `${asset.polygons} polygons` : "";
}

/**
 * A plugin tool call, as a line in the chat. Studio writes one of these for every plugin call on
 * every engine path, so the user can see what a plugin was asked for, what came back, and how
 * long nothing happened — which used to be invisible on the delegated paths entirely.
 *
 * The plugin's own strings (its display name, its tool name, its error) go through `withoutIds`
 * like every other phrase the studio did not write: a plugin is as free as a model to stamp a
 * run id into its error text, and the user learns nothing from it.
 */
export interface PluginToolCallLine extends PartRound {
  pluginName?: string | null;
  /** the bare declared name (`asset`); `toolName` is the namespaced one the engine called */
  tool?: string | null;
  toolName?: string | null;
  /** absent while the call is still open — the started record has no outcome yet */
  ok?: boolean;
  error?: string | null;
  images?: number | null;
  files?: string[] | null;
}

/** `genex__asset` and `mcp__studio__genex__asset` both name the tool `asset`. */
function bareToolName(name: string): string {
  return withoutIds(name.trim())
    .replace(/^mcp__[^_]+__/i, "")
    .replace(/^[a-z0-9-]+__/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

export function pluginToolWords(call: PluginToolCallLine): string {
  const where = typeof call.iteration === "number" ? partRoundWords(call) : partName(call, "chat");
  const plugin = withoutIds((call.pluginName ?? "").trim()) || "a plugin";
  const tool = bareToolName(call.tool ?? call.toolName ?? "") || "a tool";
  // The failure first, because a failed call is the only one whose own words matter more than
  // the counts. `ok` is only absent on the started record, which has no outcome to report.
  if (call.ok === false)
    return `${where}: ${plugin} could not run ${tool} — ${withoutIds((call.error ?? "unknown error").trim())}`;
  if (call.ok !== true) return `${where}: ${plugin} is running ${tool}`;
  const files = Array.isArray(call.files) ? call.files.length : 0;
  const images = typeof call.images === "number" && call.images > 0 ? Math.trunc(call.images) : 0;
  const brought = [files ? plural(files, "file") : "", images ? plural(images, "image") : ""]
    .filter(Boolean)
    .join(", ");
  return `${where}: ${plugin} ran ${tool}${brought ? ` — ${brought}` : ""}`;
}

// ── connector steps ───────────────────────────────────────────────────────────────────────

/**
 * A connector or plugin as the chat names it in a work heading ("Worked in Unreal"): a bundled
 * plugin by its short name, any other by the name its record carries.
 */
const SOURCE_SHORT_NAMES: Readonly<Record<string, string>> = {
  unreal: "Unreal",
  blender: "Blender",
  genex: "Genex",
};

/** The name a step's plugin or connector goes by in the chat; the id only when nothing else names it. */
export function chatSourceName(source: { pluginId?: string | null; name?: string | null; id?: string | null }): string {
  const short = source.pluginId ? SOURCE_SHORT_NAMES[source.pluginId] : undefined;
  return short ?? (withoutIds((source.name ?? "").trim()) || withoutIds((source.id ?? "").trim()));
}

/** A step's three phrasings: the row once it ran, the live status while it runs, an error line's opening. */
interface StepPhrases {
  done: string;
  active: string;
  failed: string;
}

/** A shape a primitive tool adds, from its own name (`add_cube` → `cube`). */
const shapeOf = (tool: string): string => tool.replace(/^add_/, "").replace(/_/g, " ");

/** Three phrasings around one object, or around the words for "one of those" when the call named none. */
const about = (object: string | undefined, none: string, done: string, active: string, failed: string): StepPhrases => {
  const it = object ?? none;
  return { done: `${done} ${it}`, active: `${active} ${it}`, failed: `${failed} ${it}` };
};

const fixed = (done: string, active: string, failed: string): StepPhrases => ({ done, active, failed });

/** What each kind of step says, in the user's words (`chat/connector-steps.ts` decides the kind). */
const STEP_WORDS: Readonly<Record<StepAction, (step: ConnectorStep) => StepPhrases>> = {
  [StepAction.WroteBlueprint]: (s) =>
    s.object
      ? { done: `Wrote Blueprint ${s.object}`, active: `Writing ${s.object}`, failed: `Couldn't write ${s.object}` }
      : fixed("Wrote a Blueprint", "Writing a Blueprint", "Couldn't write a Blueprint"),
  [StepAction.MadeBlueprint]: (s) =>
    about(s.object, "a Blueprint", "Made Blueprint", "Making Blueprint", "Couldn't make Blueprint"),
  [StepAction.CompiledBlueprint]: (s) => about(s.object, "a Blueprint", "Compiled", "Compiling", "Couldn't compile"),
  [StepAction.ReadBlueprint]: (s) => about(s.object, "a Blueprint", "Read Blueprint", "Reading", "Couldn't read"),
  [StepAction.EditedBlueprint]: (s) => about(s.object, "a Blueprint", "Edited Blueprint", "Editing", "Couldn't edit"),
  [StepAction.LookedUpNodes]: () =>
    fixed("Looked up Blueprint nodes", "Looking up Blueprint nodes", "Couldn't look up Blueprint nodes"),
  [StepAction.ReadGuide]: () =>
    fixed("Read the Blueprint guide", "Reading the Blueprint guide", "Couldn't read the Blueprint guide"),
  [StepAction.Placed]: (s) => about(s.object, "an actor", "Placed", "Placing", "Couldn't place"),
  [StepAction.AddedShape]: (s) => about(`a ${shapeOf(s.tool)}`, "", "Added", "Adding", "Couldn't add"),
  [StepAction.Removed]: (s) => about(s.object, "an actor", "Removed", "Removing", "Couldn't remove"),
  [StepAction.Moved]: (s) => about(s.object, "an actor", "Moved", "Moving", "Couldn't move"),
  [StepAction.OpenedLevel]: (s) => about(s.object, "a level", "Opened level", "Opening", "Couldn't open"),
  [StepAction.LookedAtLevel]: () => fixed("Looked at the level", "Looking at the level", "Couldn't look at the level"),
  [StepAction.LookedUpAssets]: () =>
    fixed("Looked through the assets", "Looking through the assets", "Couldn't look through the assets"),
  [StepAction.SavedAssets]: (s) =>
    s.count
      ? fixed(`Saved ${plural(s.count, "asset")}`, `Saving ${plural(s.count, "asset")}`, "Couldn't save the assets")
      : fixed("Saved the assets", "Saving the assets", "Couldn't save the assets"),
  [StepAction.MadeMaterial]: (s) =>
    about(s.object, "a material", "Made material", "Making material", "Couldn't make material"),
  [StepAction.ImportedAsset]: (s) => about(s.object, "an asset", "Imported", "Importing", "Couldn't import"),
  [StepAction.RanScript]: (s) => about(s.object, "a script", "Ran", "Running", "Couldn't run"),
  [StepAction.Played]: () => fixed("Played the level", "Playing the level", "Couldn't play the level"),
  [StepAction.StoppedPlay]: () => fixed("Stopped play", "Stopping play", "Couldn't stop play"),
  [StepAction.CheckedPlay]: () => fixed("Checked whether play runs", "Checking play", "Couldn't check play"),
  [StepAction.Screenshot]: () => fixed("Took a screenshot", "Taking a screenshot", "Couldn't take a screenshot"),
  [StepAction.PlayShot]: () =>
    fixed("Took a play-view shot", "Taking a play-view shot", "Couldn't take a play-view shot"),
  [StepAction.HeroShot]: (s) =>
    about(s.object, "a hero camera", "Took a still from", "Taking a still from", "Couldn't take a still from"),
  [StepAction.MotionStrip]: () => fixed("Took a motion strip", "Taking a motion strip", "Couldn't take a motion strip"),
  [StepAction.ListedCameras]: () =>
    fixed("Listed the hero cameras", "Listing the hero cameras", "Couldn't list the hero cameras"),
  [StepAction.ViewportShot]: () =>
    fixed(
      "Took a screenshot of the level",
      "Taking a screenshot of the level",
      "Couldn't take a screenshot of the level",
    ),
  [StepAction.PictureOf]: (s) =>
    about(s.object, "an asset", "Took a picture of", "Taking a picture of", "Couldn't take a picture of"),
  [StepAction.ReadLog]: () => fixed("Read the editor log", "Reading the editor log", "Couldn't read the editor log"),
  [StepAction.HeldInput]: (s) => about(s.object, "an input", "Held", "Holding", "Couldn't hold"),
  [StepAction.LetGo]: () =>
    fixed("Let go of every input", "Letting go of every input", "Couldn't let go of every input"),
  [StepAction.ReadPlayer]: () =>
    fixed("Read the player's state", "Reading the player's state", "Couldn't read the player's state"),
  [StepAction.ReadControls]: () => fixed("Read the controls", "Reading the controls", "Couldn't read the controls"),
  [StepAction.AppliedPart]: (s) => about(s.object, "a part", "Applied part", "Applying part", "Couldn't apply part"),
  [StepAction.Retargeted]: () => fixed("Retargeted clips", "Retargeting clips", "Couldn't retarget clips"),
  [StepAction.Audited]: () => fixed("Audited the level", "Auditing the level", "Couldn't audit the level"),
  [StepAction.SetRoute]: () => fixed("Set the route", "Setting the route", "Couldn't set the route"),
  [StepAction.LaidTerrain]: () => fixed("Laid the terrain", "Laying the terrain", "Couldn't lay the terrain"),
  [StepAction.Settled]: () => fixed("Let the game settle", "Letting the game settle", "Couldn't let the game settle"),
  [StepAction.DroveRoute]: () => fixed("Drove the route", "Driving the route", "Couldn't drive the route"),
  [StepAction.MeasuredRoute]: () => fixed("Measured the route", "Measuring the route", "Couldn't measure the route"),
  [StepAction.CheckedProject]: () => fixed("Checked the project", "Checking the project", "Couldn't check the project"),
  [StepAction.ListedToolsets]: () => fixed("Listed the toolsets", "Listing the toolsets", "Couldn't list the toolsets"),
  [StepAction.ReadToolset]: (s) => {
    const it = s.object ? `the ${s.object} toolset` : "a toolset";
    return { done: `Read ${it}`, active: `Reading ${it}`, failed: `Couldn't read ${it}` };
  },
  [StepAction.Other]: (s) => fixed(`${s.toolset ?? ""} · ${s.tool}`, "", `${s.toolset ?? ""} · ${s.tool}`),
};

/** The icon a step's row carries: what kind of work it was. */
const STEP_ICONS: Readonly<Record<StepAction, ToolIcon>> = {
  [StepAction.WroteBlueprint]: "write",
  [StepAction.MadeBlueprint]: "write",
  [StepAction.CompiledBlueprint]: "write",
  [StepAction.EditedBlueprint]: "write",
  [StepAction.Placed]: "write",
  [StepAction.AddedShape]: "write",
  [StepAction.Removed]: "write",
  [StepAction.Moved]: "write",
  [StepAction.SavedAssets]: "write",
  [StepAction.MadeMaterial]: "write",
  [StepAction.ImportedAsset]: "write",
  [StepAction.AppliedPart]: "write",
  [StepAction.Retargeted]: "write",
  [StepAction.SetRoute]: "write",
  [StepAction.LaidTerrain]: "write",
  [StepAction.ReadBlueprint]: "read",
  [StepAction.LookedUpNodes]: "read",
  [StepAction.ReadGuide]: "read",
  [StepAction.LookedAtLevel]: "read",
  [StepAction.LookedUpAssets]: "read",
  [StepAction.ReadLog]: "read",
  [StepAction.ReadControls]: "read",
  [StepAction.ReadPlayer]: "read",
  [StepAction.ListedToolsets]: "read",
  [StepAction.ReadToolset]: "read",
  [StepAction.ListedCameras]: "read",
  [StepAction.Audited]: "read",
  [StepAction.MeasuredRoute]: "read",
  [StepAction.CheckedProject]: "read",
  [StepAction.Screenshot]: "see",
  [StepAction.PlayShot]: "see",
  [StepAction.ViewportShot]: "see",
  [StepAction.PictureOf]: "see",
  [StepAction.HeroShot]: "see",
  [StepAction.MotionStrip]: "see",
  [StepAction.Played]: "game",
  [StepAction.StoppedPlay]: "game",
  [StepAction.CheckedPlay]: "game",
  [StepAction.HeldInput]: "game",
  [StepAction.LetGo]: "game",
  [StepAction.Settled]: "game",
  [StepAction.DroveRoute]: "game",
  [StepAction.OpenedLevel]: "game",
  [StepAction.RanScript]: "run",
  [StepAction.Other]: "run",
};

/** What a connector is called when nothing names it. */
const A_CONNECTOR = "a connector";
/** How long a failed step's line may be before it is clipped: one line in a narrow chat. */
const FAILURE_LINE_MAX = 120;

/**
 * An error's first sentence, on one line: its first line (with the next when the first only
 * introduces it, ending in a colon), up to its first full stop. The whole text stays in the step's
 * detail, line by line; only this opening passes through `withoutIds`.
 */
export function firstSentence(error: string): string {
  const lines = error
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const [first = "", second] = lines;
  const head = first.endsWith(":") && second ? `${first} ${second}` : first;
  const stop = head.search(/[.!?]\s/);
  return withoutIds(stop >= 0 ? head.slice(0, stop + 1) : head);
}

/**
 * A connector step's row: what it did once it ran (a failure leads with what it could not do and
 * the error's first sentence, clipped to one line), and what it is doing while it runs, with where
 * ("Writing BP_Lamp in Unreal"). A tool the table does not know reads as its toolset and tool,
 * or its connector and tool.
 */
export function connectorStepWords(
  step: ConnectorStep,
  where: string,
  outcome: { ok?: boolean; error?: string | null } = {},
): { label: string; active: string; icon: ToolIcon } {
  const icon = STEP_ICONS[step.action];
  const named = step.action === StepAction.Other && !step.toolset ? { ...step, toolset: where } : step;
  const phrases = STEP_WORDS[named.action](named);
  const active = phrases.active
    ? `${phrases.active}${where ? ` in ${where}` : ""}`
    : `Working in ${where || A_CONNECTOR}`;
  if (outcome.ok !== false) return { label: phrases.done, active, icon };
  const why = firstSentence(outcome.error ?? "");
  return { label: clip(why ? `${phrases.failed}: ${why}` : phrases.failed, FAILURE_LINE_MAX), active, icon };
}

/** A connector's pictures in the chat: the work's play views and a row's own screenshots. */
export const CHAT_SHOT_WORDS = {
  /** A picture's tooltip, as a file the chat opens beside it says (`MAC_FILE_WORDS`). */
  opensBeside: "Opens beside the chat",
  playView: (n: number) => `Play view ${n}`,
  screenshot: "Screenshot",
} as const;

/** "Worked in Blender and Unreal · 3 steps": the plugins a work group ran in, and how many steps. */
export function workSummaryWords(sources: readonly string[], steps: number): string {
  const counted = plural(steps, "step");
  if (!sources.length) return `Worked on ${counted}`;
  const named = sources.length === 1 ? sources[0] : `${sources.slice(0, -1).join(", ")} and ${sources.at(-1)}`;
  return `Worked in ${named} · ${counted}`;
}

/** A part the harness stopped because two builds running could not be judged for the same reason. */
export function circuitBreakWords(part: PartRound & { reason?: string | null }): string {
  const why =
    withoutIds((part.reason ?? "").trim()) || "two builds in a row could not be reviewed, for the same reason";
  return `${partName(part)} stopped: ${why} — its work so far is kept`;
}

/** A check that could not be measured where it was pointed, re-aimed or dropped. */
export function checkReplanWords(part: PartRound & { action?: string | null; why?: string | null }): string {
  const why = part.why ? ` — ${withoutIds(part.why)}` : "";
  return `${partName(part)}: the studio ${replanWhat((part.action ?? "").toLowerCase())}${why}`;
}

function replanWhat(action: string): string {
  if (action.includes("drop")) return "dropped one of its checks";
  if (action.includes("repoint")) return "re-aimed one of its checks at another camera";
  return "changed one of its checks";
}

/** A builder that stopped to tell the studio something is wrong with the run itself. */
export function flagWords(part: PartRound & { what?: string | null }): string {
  return `${partName(part)} raised a problem with the build: ${withoutIds((part.what ?? "").trim())}`;
}

/**
 * The run's plan: what it is for, the parts it will hand out, and — only when the run is
 * actually holding for an answer — the one word that starts it. A lead writes its own summary
 * (`plan`); the programmed pipeline sends the parts alone. A plan nobody asked to review is a
 * card to read, not a question: the builders are already starting, and asking for a "go" that
 * changes nothing would be a promise the run does not keep.
 */
export function planReviewWords(plan: {
  facets?: Array<{ id?: string | null; title?: string | null }> | null;
  waitMinutes?: number | null;
  summary?: string | null;
  /** What kind of game the run decided this is (M4.5b) — the plan card's one other decision. */
  game?: { kind?: string | null } | null;
}): string {
  const parts = (plan.facets ?? []).map((facet) => withoutIds((facet?.title ?? "").trim())).filter(Boolean);
  const summary = withoutIds((plan.summary ?? "").trim());
  const named = parts.length ? ` — ${parts.join(" · ")}` : "";
  // The kind is written back into the game and decides the controls the studio drives before
  // every judgement and which critic reads the build. The window meant for objecting to the
  // plan used to show every part of it except that one.
  const kind = String(plan.game?.kind ?? "")
    .trim()
    .replace(/[^a-z-]/g, "");
  const declared = kind
    ? ` It treats this as a ${kind.replace(/-/g, " ")} game — that decides the controls it drives before every look, and who reviews it.`
    : "";
  const head = `${summary ? `${sentence(summary)}${parts.length ? ` The parts: ${parts.join(" · ")}.` : ""}` : `the plan is ready${named}.`}${declared}`;
  const waiting = Math.trunc(plan.waitMinutes ?? 0);
  return waiting > 0
    ? `${head} Say "go" to start it, or say what to change; it waits up to ${Math.max(1, waiting)} min.`
    : `${head} Say what to change and the workers will hear it.`;
}

/** A build that stopped where it can be picked up again, when no result card says so. */
export function pausedWords(): string {
  return "The build stopped. Everything built so far is kept.";
}

/** Why the studio resumed a build on its own (`run_auto_resumed`), as the chat says it. */
const AUTO_RESUMED_WORDS = {
  [AutoResumeCause.LimitReset]: "Resumed automatically after the limit reset",
  [AutoResumeCause.LoopRestart]: "Resumed automatically after Studio’s loop restarted",
  [AutoResumeCause.ProviderOutage]: "Resumed automatically to try the model provider again after its outage",
} as const satisfies Record<AutoResumeCause, string>;

/** The chat's line for a build the studio resumed on its own; a cause this version does not know still reads. */
export function autoResumedWords(cause: unknown): string {
  const known = Object.values(AutoResumeCause).find((value) => value === cause);
  return known ? AUTO_RESUMED_WORDS[known] : "Resumed automatically";
}

/** Settings → Harness: the switch for host auto-resume. */
export const AUTO_RESUME_SETTING_WORDS = {
  label: "Resume builds automatically",
  detail:
    "When a session limit resets, a while after a model provider’s outage, or when Studio’s loop restarts, a paused build picks up where it left off, up to twice per build. A build you stop stays stopped, and one paused on a sign-in waits for you.",
} as const;

/** Settings → Permissions: the switch that lets agents ask to control the person's computer. */
export const COMPUTER_CONTROL_SETTING_WORDS = {
  section: "Computer control",
  label: "Let agents control your computer",
} as const;

/** What the switch says on `platform`: how to stop it there and what it never touches, or where it runs. */
export function computerControlDetail(platform: string): string {
  const can = "With this on, an agent can click and type in the apps you allow.";
  if (!computerControlOffered(platform)) return `${can} macOS and Windows only.`;
  const stops = `Each chat session asks you first, and ${desktopStopShortcut(platform).keys} stops it.`;
  if (platform === StudioPlatform.Windows)
    return `${can} ${stops} It never uses password managers, Windows Settings, password prompts or Genex.`;
  return `${can} ${stops} Agents can look at an app’s window without it, never at password managers, System Settings, password prompts or Genex.`;
}

export function resumedWords(parts: number): string {
  const done = Math.max(0, Math.trunc(parts || 0));
  return `picking up where it left off${done ? ` — ${plural(done, "finished part")} kept` : ""}`;
}

/**
 * What the stage's Reload says while Live is behind (docs/product/builds-live.md). Nothing
 * changes Live while the person watches it, so the button that would bring the change names it.
 */
const LIVE_BEHIND_WORDS = {
  [LiveBehindReason.Changed]: "The game changed — reload to see it",
  [LiveBehindReason.Build]: "A new build is ready — reload to play it",
  [LiveBehindReason.Broken]: "This build turned out not to run — reload to go back to your game",
} as const satisfies Record<LiveBehindReason, string>;

/** Reload's tooltip while Live is behind; the builder's own note, when it left one, follows. */
export function liveBehindWords(reason: LiveBehindReason): string {
  return LIVE_BEHIND_WORDS[reason];
}

/** Reload's accessible name while Live is behind: the tooltip, note and all. */
export function liveBehindLabel(reason: LiveBehindReason, note: string | null): string {
  const words = liveBehindWords(reason);
  return note ? `${words}: ${note}` : words;
}

/** The stage strip's tabs, Play/Stop and full screen, as their tooltips and accessible names say them. */
export const STAGE_WORDS = {
  stop: "Stop game",
  stopping: "Stopping game",
  play: "Play game",
  starting: "Starting game",
  fullScreen: "Full screen",
  /** The view switcher's tabs; a folder with more than one Live view names each by what it shows. */
  tabs: { live: "Live", builds: "Builds", assets: "Assets", webGame: "Web game", unreal: "Unreal" },
} as const;

/** Live for a folder with no view of its own (Godot, Blender, files of its own): the latest pictures its runs kept. */
export const STILLS_WORDS = {
  /** Under the game's name while no run has kept a picture: one line, as the empty state's subtitle is. */
  none: "Pictures show here once a Loop takes them.",
  /** A picture's alt text: the capture's label and the picture's name. */
  picture: (label: string, name: string) => (name ? `${label}: ${name}` : label),
} as const;

/** A plugin's Live card (`panels/stage/PluginCardStage.tsx`): the words Studio draws around what the plugin says. */
export const PLUGIN_CARD_WORDS = {
  /** The shot's alt text: the game's name in play. */
  playShot: (game: string) => `${game} in play`,
  /** The line while the plugin is off or has not answered, under the game's name. */
  waiting: (plugin: string) => `Plays in ${plugin}.`,
} as const;

// ── an agent at its screen ────────────────────────────────────────────────────────────────

/** What an agent is doing at its screen, as its node says it while it happens. */
const SCREEN_DOING: Record<ScreenDeed, string> = {
  [ScreenDeed.Load]: "Opening the game",
  [ScreenDeed.Look]: "Looking around",
  [ScreenDeed.Click]: "Clicking",
  [ScreenDeed.Press]: "Pressing",
  [ScreenDeed.Type]: "Typing",
  [ScreenDeed.Drag]: "Dragging",
  [ScreenDeed.Move]: "Moving the mouse",
  [ScreenDeed.Scroll]: "Scrolling",
  [ScreenDeed.Wait]: "Watching",
  [ScreenDeed.Reload]: "Reloading",
};

/** The same deeds, done: the steps of a screen's trail. */
const SCREEN_DONE: Record<ScreenDeed, string> = {
  [ScreenDeed.Load]: "Opened",
  [ScreenDeed.Look]: "Looked",
  [ScreenDeed.Click]: "Clicked",
  [ScreenDeed.Press]: "Pressed",
  [ScreenDeed.Type]: "Typed",
  [ScreenDeed.Drag]: "Dragged",
  [ScreenDeed.Move]: "Moved",
  [ScreenDeed.Scroll]: "Scrolled",
  [ScreenDeed.Wait]: "Watched",
  [ScreenDeed.Reload]: "Reloaded",
};

/** A frame from a producer that predates deed codes: the agent is at its screen, doing something. */
const SCREEN_PLAYING = { doing: "Playing", done: "Played" } as const;

/** Keys a player reads differently from the name an agent gives them. */
const KEY_WORD: Record<string, string> = {
  arrowleft: "←",
  left: "←",
  arrowright: "→",
  right: "→",
  arrowup: "↑",
  up: "↑",
  arrowdown: "↓",
  down: "↓",
  " ": "Space",
  space: "Space",
  return: "Enter",
  enter: "Enter",
  escape: "Esc",
  esc: "Esc",
  backspace: "Delete",
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  super: "⌘",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "⌥",
  option: "⌥",
};

/** The keys a Windows or Linux keyboard names in words where the Mac's carries a glyph. */
const KEY_WORD_OFF_MAC: Record<string, string> = {
  cmd: "Win",
  command: "Win",
  meta: "Win",
  super: "Win",
  alt: "Alt",
  option: "Alt",
};

function keyWord(key: string, platform: string): string {
  const lower = key.toLowerCase();
  const offMac = platform !== "" && platform !== StudioPlatform.Mac;
  if (offMac && Object.hasOwn(KEY_WORD_OFF_MAC, lower)) return KEY_WORD_OFF_MAC[lower] ?? key;
  if (Object.hasOwn(KEY_WORD, lower)) return KEY_WORD[lower] ?? key;
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Keys as a player reads them: "space" is Space, "ArrowRight" is →, "shift+w" is Shift+W; "meta"
 * is ⌘ on the Mac (or before main answers) and Win elsewhere, "alt" ⌥ or Alt.
 */
export function keysWords(keys: readonly string[], platform = ""): string {
  return keys
    .flatMap((combo) => (combo === "+" ? [combo] : combo.split("+").filter(Boolean)))
    .map((key) => keyWord(key, platform))
    .join("+");
}

/** A deed and, for a press, its keys. */
function screenWords(
  act: ScreenAct | undefined,
  words: Record<ScreenDeed, string>,
  unknown: string,
  platform: string,
): string {
  if (!act || !Object.hasOwn(words, act.deed)) return unknown;
  const keys = act.deed === ScreenDeed.Press && act.keys?.length ? ` ${keysWords(act.keys, platform)}` : "";
  return `${words[act.deed]}${keys}`;
}

/** What an agent is doing at its screen, as its node says it: "Pressing Space", "Looking around". */
export const screenDoing = (act: ScreenAct | undefined, platform = ""): string =>
  screenWords(act, SCREEN_DOING, SCREEN_PLAYING.doing, platform);

/** The same, done, as a step of its trail says it: "Pressed →", "Opened". */
export const screenDone = (act: ScreenAct | undefined, platform = ""): string =>
  screenWords(act, SCREEN_DONE, SCREEN_PLAYING.done, platform);

/** A frame this recent is happening now. */
const SCREEN_NOW_MS = 2 * SECOND_MS;

/** A minute, in the seconds a running clock shows. */
const SECONDS_PER_MINUTE = MINUTE_MS / SECOND_MS;
/**
 * Between a clock's two parts: a no-break space. The status clock's figures are tabular, and the
 * house font's tabular set widens a plain space to a figure's width; this one keeps a word space's.
 */
const CLOCK_SPACE = "\u00a0";

/** "42s", "3m 5s", "2h 10m": a running clock, as short as the time allows, and nothing under a second. */
export function clockWords(ms: number): string {
  const seconds = Math.floor(ms / SECOND_MS);
  if (ms < SECOND_MS) return "";
  if (ms < MINUTE_MS) return `${seconds}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m${CLOCK_SPACE}${seconds % SECONDS_PER_MINUTE}s`;
  return `${Math.floor(ms / HOUR_MS)}h${CLOCK_SPACE}${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
}

/** How long ago a screen's frame came: "now", "3s", "2m" on a node, "3s ago" where there is room. */
export function screenAgo(at: number, now: number, { ago = false }: { ago?: boolean } = {}): string {
  const ms = Math.max(0, now - at);
  if (ms < SCREEN_NOW_MS) return "now";
  const span = ms < MINUTE_MS ? `${Math.round(ms / SECOND_MS)}s` : `${Math.round(ms / MINUTE_MS)}m`;
  return ago ? `${span} ago` : span;
}

// ── words several surfaces say ────────────────────────────────────────────────────────────

/** A Loop's hours as the person picked them: whole hours, else minutes. */
const loopSpan = (hours: number): string =>
  Number.isInteger(hours) ? plural(hours, "hour") : plural(Math.round(hours * 60), "minute");

/** A Loop that ended with something still to fix: its card in the chat and in Builds. */
export const STILL_TO_FIX_WORDS = {
  title: "Almost there",
  done: "Done",
  left: "Still to fix",
  keepBuilding: "Keep building",
  /** Why the Loop stopped, in one line under the title. */
  why: {
    time: (hours: number | null) =>
      hours === null
        ? "Its time ran out before this was fixed."
        : `Your ${loopSpan(hours)} ran out before this was fixed.`,
    /** Its time ran out before the game had a final look, so nothing is listed. */
    timeUnlooked: (hours: number | null) =>
      hours === null
        ? "Its time ran out before a final look at your game."
        : `Your ${loopSpan(hours)} ran out before a final look at your game.`,
    stuck: "It kept getting this wrong, so it stopped to save your credits.",
    person: "You stopped it before this was fixed.",
    ended: "It stopped before this was fixed.",
  },
  /** The message Keep building sends for the person: what is left, else to go on where it stopped. */
  ask: (notDone: readonly string[]) =>
    notDone.length
      ? ["Keep building: fix what’s left.", ...notDone.map((item) => `- ${item}`)].join("\n")
      : "Keep building where you left off.",
  /** Keep building in a game whose Loop can't run here: nothing was sent. */
  noLoop: "Loop can’t run in this game yet, so Keep building can’t start it.",
} as const;

/**
 * The plan's two replies. The steering card and the composer both offer them, and a waiting plan
 * starts on exactly `go`, so each is spelled once.
 */
export const PLAN_WORDS = {
  /** the reply that starts a plan waiting for it */
  go: "go",
  /** the composer's prefill for asking for a change */
  changePrefill: "Change the plan: ",
} as const;

/** Who asks, when a plugin's question names no plugin. */
export const A_PLUGIN = "A plugin";

/** The steps card's own words; its rows are the plugin's. */
export const STEPS_WORDS = {
  /** Puts the card away for this game until the agent shows it again. */
  hide: "Hide",
  hideLabel: "Hide this card until the agent shows it again",
  done: "(done)",
  copy: "Copy",
  copied: "Copied",
  /** A step's button whose plugin is no longer installed. */
  pluginGone: "This step's plugin isn't installed any more.",
} as const;

/** The turn-it-on card a session shows for a Genex plugin (`chat/PluginSuggestionCard.tsx`). */
export const PLUGIN_SUGGESTION_WORDS = {
  turnOn: (name: string) => `Turn on ${name}`,
  install: "Install…",
  isOn: (name: string) => `${name} is on`,
  /** The quiet button on a plugin that is on: its page in Plugins, where it turns off again. */
  manage: "Plugins",
  manageLabel: (name: string) => `Open ${name} in Plugins`,
  close: "Put this suggestion away",
  folders: (paths: string) => `Turning it on lets its programs write in: ${paths}`,
  /** A plugin loaded from a folder on this Mac: its code isn't sandboxed, and its tools ask first. */
  localAccess:
    "Loaded from a folder on this Mac. It runs with your access, and each of its tools asks you before an agent runs it; its own steps at Genex's moments don't ask.",
} as const;

/** Each game engine as the chat names it. */
export const GAME_ENGINE_WORDS = { web: "the web", unreal: "Unreal", godot: "Godot" } as const satisfies Record<
  GameEngine,
  string
>;

/**
 * What the sidebar shows beside a project that isn't a game, by the core fact it holds; a fact
 * missing here is a game's (or one no word names) and shows nothing.
 */
export const PROJECT_KIND_WORDS = {
  [CoreFact.UnrealPlugin]: "Unreal plugin",
  [CoreFact.BlenderAssets]: "Blender assets",
} as const satisfies Partial<Record<CoreFact, string>>;

// ── the chat transcript ───────────────────────────────────────────────────────────────────

/** The fixed lines, labels and prefills `chat-entries.ts` writes into the transcript. */
export const TRANSCRIPT_WORDS = {
  /** A game's engine link (`engine_linked`): one line with Undo, then what Undo did. */
  engineLinked: (game: string | undefined, engine: string, project: string) =>
    `${game ?? "This game"} now builds in ${engine} · ${project}`,
  /** A link whose plugin also set the project up for Genex: the same one line, the set-up first. */
  engineSetUpAndLinked: (game: string | undefined, engine: string, project: string) =>
    `Set up ${project} for Genex · ${game ?? "This game"} now builds in ${engine}`,
  /** What Undo did: where the game builds now, and the project whose set-up it also took back. */
  engineUndone: (
    game: string | undefined,
    restored: string | undefined,
    setUp: { undone?: string; kept?: string } = {},
  ) => {
    const now = restored
      ? `Undone. ${game ?? "This game"} builds in ${restored} again`
      : `Undone. ${game ?? "This game"} is a web game again`;
    if (setUp.undone) return `${now}, and ${setUp.undone} is no longer set up for Genex.`;
    if (setUp.kept) return `${now}. ${setUp.kept} stays set up for Genex: another game uses it.`;
    return `${now}.`;
  },
  engineUndo: "Undo",
  engineUndoTitle: "Take this back: the game builds where it did before",
  /** An agent went ahead of the person in an app a plugin's lock guards (`agent_went_ahead`): said once. */
  wentAhead: (app: string) => `An agent used ${app} while you were playing.`,
  wentAheadSettings: (app: string) => `${app} settings`,
  wentAheadSettingsTitle: (app: string) => `Choose whether agents may use ${app} while you play`,
  rewound: (files: number) => `The chat went back, and ${files} game ${files === 1 ? "file" : "files"} with it.`,
  rewindUndo: "Bring back newer version",
  rewindUndoTitle: "Put the game files back as they were before this rewind; the chat stays rewound",
  rewindUndone: "The game is back as it was before the rewind. The chat stays rewound.",
  planCancelled: "Plan cancelled.",
  studioRestarted: "Studio restarted",
  workspaceRestored: "Workspace restored",
  toolResult: "Tool result",
  notAllowed: "was not allowed to do that",
  notAllowedDetail: "The worker tried something outside the rules of its workspace.",
  checkpoint: "the preview shows the current build",
  signInAgain: (provider: string) => `${provider} needs you to sign in again. Your project is still here.`,
  rebuiltItself: "rebuilt itself",
  plugin: "Plugin",
  sayGo: "Say go",
  changeIt: "Change it",
  reviewInHarness: "Review in Harness",
  seeInHarness: "See in Harness",
  /** the tags of a reviewer's and a builder's narration rows */
  checkTag: "Check",
  workerTag: "Worker",
  /** A job's line (`job_started`): Stop while it runs. */
  jobStop: "Stop",
  jobStopTitle: "Stop this background work",
  /** A missing macOS permission (`app_look_access`): the button opens System Settings, not Genex's own Settings. */
  openPrivacySettings: "Open Privacy settings",
} as const;

// ── background work ───────────────────────────────────────────────────────────────────────

/** Minutes in an hour. */
export const MINUTES_PER_HOUR = HOUR_MS / MINUTE_MS;

/** A span of whole minutes: "9 min", "1 h", "1 h 5 min". */
export function spanWords(minutes: number): string {
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min`;
  const rest = minutes % MINUTES_PER_HOUR;
  return `${Math.floor(minutes / MINUTES_PER_HOUR)} h${rest ? ` ${rest} min` : ""}`;
}

/** A job's whole minutes: "4 min", "1 h 5 min", or `short` under a minute. */
function jobMinutes(minutes: number, short: string): string {
  const whole = Math.max(0, Math.floor(minutes));
  return whole < 1 ? short : spanWords(whole);
}

/** How a stopped job was stopped, by who stopped it; the person's and the agent's Stop read alike. */
const STOPPED_WORDS = {
  [JobStopper.Agent]: "stopped",
  [JobStopper.Person]: "stopped",
  [JobStopper.Quit]: "stopped when Genex closed",
  [JobStopper.ScopeEnded]: "stopped when its work ended",
} as const satisfies Record<JobStopper, string>;

/**
 * Where a job is, after its title: "4 min" while it runs, "finished · 4 min", "failed · 4 min",
 * "stopped", "stopped at its time limit", "stopped when Genex closed", "stopped when its work ended";
 * "ended" for a state this version does not know.
 */
export function jobStatusWords(
  state: BackgroundJobState | undefined,
  stoppedBy: JobStopper | undefined,
  minutes: number,
): string {
  if (state === BackgroundJobState.Running) return jobMinutes(minutes, "just started");
  if (state === BackgroundJobState.Succeeded) return `finished · ${jobMinutes(minutes, "under a minute")}`;
  if (state === BackgroundJobState.Failed) return `failed · ${jobMinutes(minutes, "under a minute")}`;
  if (state === BackgroundJobState.TimedOut) return "stopped at its time limit";
  if (state === BackgroundJobState.Interrupted) return STOPPED_WORDS[JobStopper.Quit];
  if (state === BackgroundJobState.Stopped)
    return stoppedBy ? STOPPED_WORDS[stoppedBy] : STOPPED_WORDS[JobStopper.Agent];
  return "ended";
}

/** A job's line: "In the background: Unreal build · Scene builder · finished · 4 min"; no status while it runs. */
export function inBackground(title: string, status: string, worker?: string): string {
  return [`In the background: ${title}`, worker, status].filter(Boolean).join(" · ");
}

/** A running job's line with the minutes it has run: "In the background: Unreal build · 4 min". */
export function jobRunningLine(line: string, minutes: number): string {
  return `${line} · ${jobStatusWords(BackgroundJobState.Running, undefined, minutes)}`;
}

/** Background work by how much of it runs and how much ended: "1 running · 2 finished", a zero left out. */
export function backgroundCount(running: number, finished: number): string {
  const parts = [running ? `${running} running` : "", finished ? `${finished} finished` : ""];
  return parts.filter(Boolean).join(" · ");
}

// ── the lead, its workers and the finish check on the Builds graph ────────────────────────

/** A worker's status on its node and its card: what it is doing, or how it ended. Never how it works. */
export const WORKER_WORDS = {
  working: "Working",
  workingIn: (engine: string) => `Working in ${engine}`,
  added: "Added to your game",
  done: "Done",
  didntFinish: "Didn't finish",
  /** the host refused its session: it never ran */
  notStarted: "Not started",
  /** it finished, changed nothing and delivered nothing */
  nothingMade: "Nothing made",
  stopped: "Stopped",
  notUsed: "Not used",
  /** the quotes on a worker's card */
  asked: "The lead asked",
  leadSaid: "The lead",
} as const;

/**
 * Why a worker stopped short, by the code its end record carries (`WorkerStopCode`), as its card
 * and its chat line say it. The record's own reason is the harness's text for the lead: never shown.
 */
export const WORKER_STOP_WORDS = {
  [WorkerStopCode.HostRefused]: "Your Settings allow no more workers at once",
  [WorkerStopCode.TurnEnded]: "The chat turn ended first",
  [WorkerStopCode.RunEnded]: "The Loop ended first",
  [WorkerStopCode.StoppedByLead]: "The lead stopped it",
  [WorkerStopCode.Error]: "It ran into an error",
  [WorkerStopCode.SandboxUnavailable]: "Claude Code can't run workers on this computer yet",
} as const satisfies Record<WorkerStopCode, string>;

/** Text as a sentence: its first letter capitalized, and a full stop when it has no end of its own. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
}

/** The chat's working line while the agent's work waits for the person to finish in an app a plugin guards. */
export const PERSON_FIRST_WORDS = {
  waiting: (label: string) => `Waiting for you to finish in ${label}`,
} as const;

/**
 * A worker's one line in the chat (`chat/worker-lines.ts`): its task while it works, then what it
 * said (its own summary, else its task) and how it ended. Never an id or how it stands in the game.
 */
export const WORKER_LINE_WORDS = {
  working: (title: string) => `${title}…`,
  workingIn: (title: string, engine: string) => `${title} in ${engine}…`,
  done: (said: string) => asSentence(said),
  added: (said: string) => `${asSentence(said)} Added to your game.`,
  notUsed: (said: string, note: string | null) =>
    note ? `${asSentence(said)} Not used: ${note}` : `${asSentence(said)} Not used.`,
  didntFinish: (title: string, because: WorkerStopCode | null) =>
    because ? `${title}: didn't finish. ${asSentence(WORKER_STOP_WORDS[because])}` : `${title}: didn't finish.`,
  stopped: (title: string) => `${title}: stopped.`,
} as const;

/**
 * The Building card's checklist (`chat/build-checklist.ts`): each part's status on its row, the
 * lead's last step, and the card's one line, counted from the parts.
 */
export const BUILD_CHECKLIST_WORDS = {
  added: "Added",
  working: "Working",
  workingFor: (minutes: number) => `Working · ~${minutes} min`,
  workingRound: (round: number) => `Working · round ${round}`,
  waiting: "Waiting to start",
  notAdded: "Not added",
  notStarted: "Not started",
  next: "Next",
  /** The lead's own last step, after the parts. */
  together: "Put it together and check",
  caption: (added: number, total: number, working: number) =>
    working ? `${added} of ${total} parts added · ${working} working` : `${added} of ${total} parts added`,
  finishing: (working: number) => (working ? `Finishing up · ${working} working` : "Finishing up"),
  open: "Open in Builds",
  /** The card's toggle, as a screen reader names it. */
  toggle: "Building: show or hide its parts",
  /** The list's own name, for a screen reader. */
  list: "Parts of the build",
} as const;

/** The status line's rest while a Loop's workers work: "3 workers on it". */
export const workersOnIt = (count: number): string => `${plural(count, "worker")} on it`;

/** The lead's node and card: its name, and what it is doing by its face (`run-tree.ts` `LeadFace`). */
export const LEAD_WORDS = {
  name: "The lead",
  face: {
    working: "Working on the next step",
    waiting: "Waiting for a worker",
    paused: "Paused",
    done: "Done",
    stopped: "Stopped",
  } satisfies Record<LeadFace, string>,
  /** the card's sentence by face */
  about: {
    working:
      "No part is working right now. The lead is deciding what comes next, or changing the game itself; a new part shows up here when it starts one.",
    waiting: "The lead is waiting for its workers. Each one is a row on the graph, named by what it was asked to do.",
    paused: "The lead is paused with the Loop. Resume it from the chat.",
    done: "The lead is done.",
    stopped: "The lead stopped before it said it was done.",
  } satisfies Record<LeadFace, string>,
  /** the card's sentence for the lead at work in a tree, where each worker it starts is a row */
  aboutWorkingInTree: "The lead is working on the next step itself; each worker it starts is a row here.",
} as const;

/** The background tile's first line, over the job's name: "In the background". */
export const JOBS_EYEBROW = "In the background";

/** The background card: one row per job, read-only (Stop stays on the job's chat line). */
export const JOBS_WORDS = {
  title: "In the background",
  about: "Long work the lead or a worker started, like a build. It runs on while the agents go on working.",
  by: (who: string) => `Started by ${who}`,
  byLead: "Started by the lead",
} as const;

/** The finish check's node and card in Builds, named for the person as the Loop's final look at their game. */
export const FINISH_CHECK_WORDS = {
  name: "Final look",
  state: {
    not_yet: "Not finished yet",
    checking: "Looking",
    done: "Done",
    stopped: "Not finished",
  } satisfies Record<FinishCheckState, string>,
  placeholder: "Runs at the end",
  about: "Before the Loop calls it done, a second AI looks at your game.",
  /** The node's line and the card while the second AI looks. */
  checking: "Looking at your game",
  checkingCard: "Looking at your game.",
  /** The node's line after a no: how many things are left. */
  leftWord: (left: number) => `${plural(left, "thing")} left`,
  doneWord: "All done",
  doneCard: "All done.",
  unanswered: "Couldn't look this time",
  unansweredCard: "Couldn't look this time.",
  /** After a no, while the Loop works on. */
  keepsWorking: "The Loop keeps working on it.",
  /** After a no, once the Loop has ended some other way. */
  endedAfterNo: "The Loop ended before another look.",
} as const;

/** A build in the stage's history, by what it was and the day it started; never a number or a count. */
/** The Builds bar's tabs, one for each of the chat's builds. */
export const BUILD_TABS_WORDS = {
  /** The track's name for a screen reader. */
  tabs: "Builds",
  /** The picker's name for a screen reader: the open build, and how many there are to pick from. */
  picker: (name: string, count: number) => `${name}, one of ${count} builds`,
} as const;

export const BUILD_HISTORY_WORDS = {
  thisTurn: "This chat turn",
  thisLoop: "This Loop",
  turnFrom: (day: string) => `Chat turn from ${day}`,
  loopFrom: (day: string) => `Loop from ${day}`,
  today: "today",
  yesterday: "yesterday",
} as const;

/** A chat turn's status line and result node: its workers at work, then whether their work is in your game. */
export const TURN_WORDS = {
  working: "Working",
  nothingYet: "Nothing yet",
  live: "Live in your game",
  done: "Done",
  fromTurn: "from this chat turn",
} as const;

/** The macOS Privacy & Security panes app_look needs, by the names System Settings shows. */
const PRIVACY_PANE_WORDS = {
  [AppLookAccessKind.Screen]: "Screen Recording",
  [AppLookAccessKind.Accessibility]: "Accessibility",
} as const satisfies Record<AppLookAccessKind, string>;

/** What the person must allow before Genex sees app windows, naming every missing pane. */
export function appAccessMissing(missing: readonly AppLookAccessKind[]): string {
  const panes = missing.map((pane) => PRIVACY_PANE_WORDS[pane]).join(" and ");
  return `Genex can't see app windows yet: allow ${panes} for Genex in System Settings.`;
}

/** The button for one pane when more than one is missing: "Open Accessibility settings". */
export function openPaneSettings(pane: AppLookAccessKind): string {
  return `Open ${PRIVACY_PANE_WORDS[pane]} settings`;
}

/** The title of a pane's button: it opens macOS System Settings, not Genex's own Settings → Privacy. */
export function privacySettingsTitle(pane: AppLookAccessKind): string {
  return `Opens System Settings → Privacy & Security → ${PRIVACY_PANE_WORDS[pane]}`;
}

/** The snapshot line under a restored workspace. */
export function snapshotWords(snapshotId: string): string {
  return `Snapshot: ${snapshotId}`;
}

/** A plugin call still out, by the plugin's name. */
export function usingPluginWords(pluginName: string | undefined): string {
  return `Using ${pluginName ?? "plugin"}`;
}

/**
 * What an app update did to the harness. Four outcomes, not three: an upgrade that only takes
 * pages away must say so rather than count zero refreshed files.
 */
export function seedUpgradeWords(seed: CustomPayload<typeof CustomEvent.SeedUpgraded>): string {
  const count = (seed.added?.length ?? 0) + (seed.updated?.length ?? 0);
  const retired = seed.retired?.length ?? 0;
  const kept = seed.kept?.length ?? 0;
  const did: string[] = [];
  if (count > 0) did.push(`refreshed ${plural(count, "harness file")}`);
  if (retired > 0) did.push(`took away ${plural(retired, "page")} it no longer ships`);
  const done = did.length > 0 ? did.join(" and ") : "left every harness file as it was";
  const keptNote = kept > 0 ? ` (${plural(kept, "self-edited file")} kept)` : "";
  // A kept file whose code the update moved: its edits to that code no longer reach every caller.
  const moved = (seed.moved ?? [])
    .map(
      (move) =>
        ` · the kept ${move.from} still has its own ${move.names.join(", ")}, but ${move.callers.join(", ")} now use ${move.to}`,
    )
    .join("");
  return `app update ${done}${keptNote}${moved}`;
}

/** The chat's row for a finished compaction: how many messages its summary replaced. */
export function compactedWords(messages: number | null | undefined): string {
  if (typeof messages !== "number") return "Compacted the conversation";
  return `Compacted ${plural(messages, "message")}`;
}

/** The studio rewrote one of its own files while idle. */
export function improvementWords(improvement: CustomPayload<typeof CustomEvent.ImprovementApplied>): string {
  return `the studio got better at ${improvement.reason ?? improvement.file ?? "its own craft"} (rewrote ${improvement.file ?? "a file"} while idle)`;
}

/** What a learning pass taught the harness, as a count already in words ("2 things"). */
export function harnessLearnedWords(things: string): string {
  return `Harness learned ${things} from this build.`;
}

/** What the lead offered to Live: its Reload plays it, since Live never changes under the user. */
export function showWords(target: string | undefined): string {
  if (target === "live") return "the lead offered your game folder on Live's Reload";
  if (target === "integration") return "the lead offered the merged build on Live's Reload";
  return `the lead offered one worker's work on Live's Reload${target ? ` (${target})` : ""}`;
}

type RoundPayload = CustomPayload<typeof CustomEvent.FacetIteration>;

/** Why a round ended the way it did: the lead's stop, or the verdict's own label. */
function roundWhyWords(round: RoundPayload): string {
  if (wasStopped(round.verdictSource ?? null)) return stoppedRoundWords(round.reason);
  return verdictLabel(
    round.winner ?? null,
    Boolean(round.satisfied),
    round.verdictSource ?? null,
    round.verdict ?? null,
  );
}

/** "stopped by the lead — fixing the starting point": who stopped the round, in their own words. */
function stoppedRoundWords(reason: string | undefined): string {
  if (!reason) return "stopped — reason unavailable";
  const said = stoppedWords(reason);
  return /^stopped\b/i.test(said) ? said : `stopped — ${said}`;
}

/** The checks a judged round moved: counts, newly passing and broken again. */
function roundScoreWords(board: RoundPayload["scoreboard"]): string {
  if (!board || typeof board.total !== "number") return "";
  // "Newly passing" counts the plan's checks; a judge's own question turning green is a note.
  const newlyPassing = board.plannedFlips ?? board.flips ?? [];
  const newly = newlyPassing.length ? ` · ${newlyPassing.length} newly passing` : "";
  const broke = board.regressions?.length ? ` · ${board.regressions.length} broke again` : "";
  return ` · ${checkCounts(board)}${newly}${broke}`;
}

function stepNoteWords(move: RoundPayload["move"]): string {
  if (!move?.what) return "";
  if (move.delivered) return " · the step landed";
  return move.delivered === false ? " · the step was NOT delivered" : "";
}

/** A worker's judged round as one chat line; `nextGap` is the judge's biggest gap in plain words, or null. */
export function partRoundLine(round: RoundPayload, nextGap: string | null): string {
  const gap = nextGap === null ? "" : ` · next gap: ${nextGap}`;
  return `${partRoundWords(round)}: ${roundWhyWords(round)}${roundScoreWords(round.scoreboard)}${stepNoteWords(round.move)}${gap}`;
}

/** A judge's round of an older single-loop run as one chat line. */
export function judgeRoundLine(round: CustomPayload<typeof CustomEvent.RunIteration>, nextGap: string | null): string {
  const label = verdictLabel(round.winner ?? null, false, null, round.verdict ?? null);
  return `round ${round.iteration ?? "?"}: ${label} · next gap: ${nextGap ?? "unknown"}`;
}

// ── the model picker ──────────────────────────────────────────────────────────────────────

/** The context panel's Compact now (`ui/ComposerLimits.tsx`). */
export const COMPACT_WORDS = {
  caption: "Summarize the chat to free up context.",
  /** After the context reading: Auto is the only policy. */
  automatic: "Compacts automatically",
  /** The context panel's button, beside the reading; its tooltip is `caption`. */
  action: "Compact",
  running: "Compacting…",
  /** `/compact` while a turn or a build runs: it waits for it, so it is offered but not taken. */
  waits: "After the current work finishes",
  commands: "Commands",
} as const;

/** The model picker's section headers, row tags and reasons (`model-choices.ts`). */
export const MODEL_PICKER_WORDS = {
  unavailable: "This model is unavailable. Check the connection or choose another model.",
  localModels: "Local models",
  chatGptModels: "ChatGPT models",
  claudeModels: "Claude models",
  local: "local",
  localStale: "local · stale",
  noTools: "no tools",
  cannotCallTools: "This model cannot call tools, so it cannot build",
  cannotSeeImages: "This model cannot see images, so it cannot review screenshots",
  subscription: "subscription",
  signIn: "sign in",
  free: "Free",
} as const;

/** A subscription's accounts, in Model Providers and the composer's usage panel (`subscription-accounts.ts`). */
export const PROVIDER_ACCOUNT_WORDS = {
  terminal: "Terminal login",
  studio: "Studio account",
  numbered: (n: number) => `Account ${n}`,
  add: "Add account",
  tabs: (provider: string) => `${provider} accounts`,
  signOut: (account: string) => `Sign out of ${account}`,
  signOutLine: "Studio forgets this account",
  switchTo: (account: string) => `Use ${account}`,
  waiting: "Waiting for your browser…",
  openPage: "Open page",
  haveCode: "Have a code?",
  showTerminal: "Show terminal",
  verifying: "Checking the sign-in…",
  inTerminal: "Finish signing in in Studio's terminal.",
  modelProviders: "Model providers",
} as const;

/** Settings → Model Providers: the metered rows, OpenCode and OpenRouter (`panels/MeteredProviders.tsx`). */
export const METERED_PROVIDER_WORDS = {
  connected: "Connected",
  notConnected: "Not connected",
  notInstalled: "Not installed",
  installing: "Installing…",
  updating: "Updating…",
  checking: "Checking…",
  signingIn: "Signing in…",
  saving: "Saving…",
  couldNotCheck: "Couldn't check",
  checkAgain: "Check again",
  tryAgain: "Try again",
  account: "Account",
  checkConnection: "Check connection",
  checkConnectionLine: "Also refreshes the model list",
  openCode: {
    name: "OpenCode",
    guide: "https://opencode.ai/docs/",
    install: "Install OpenCode",
    installLine: "Install it to run models from any provider you sign in to.",
    installingLine: "Installing OpenCode. This can take a minute.",
    signIn: "Sign in",
    signInLine: "Sign in to a provider in OpenCode to run its models.",
    freeOnly: "Free models only",
    freeOnlyLine: "No provider signed in. OpenCode's free models run without an account.",
    signingIn: "Choose a provider below and finish signing in. OpenCode keeps the sign-in.",
    cancelSignIn: "Cancel",
    openSignInPage: "Open sign-in page",
    addProvider: "Sign in to another provider…",
    addProviderLine: "OpenCode keeps each sign-in",
    update: "Update OpenCode",
    connectedLine: "Billed by each provider you use",
    unreachable: "OpenCode didn't answer. Check the installation, then try again.",
  },
  openRouter: {
    name: "OpenRouter",
    keysUrl: "https://openrouter.ai/settings/keys",
    keyLabel: "OpenRouter API key",
    keyPlaceholder: "sk-or-…",
    save: "Save key",
    getKey: "Get a key",
    notConnectedLine: "Paste an API key. Requests are billed to your OpenRouter credits.",
    connectedLine: "Billed to your OpenRouter credits",
    refused: "OpenRouter didn't accept that key. Check it and paste it again.",
    replace: "Replace key…",
    replaceLine: "The new key is checked before it's saved",
    remove: "Remove key",
    cancel: "Cancel",
  },
} as const;

/** Settings → Model Providers: the person's own model server (`panels/LocalServerRow.tsx`). */
export const LOCAL_SERVER_WORDS = {
  name: "Local server",
  notConnectedLine: "Use a model you run in LM Studio, llama.cpp, TabbyAPI, vLLM or KoboldCpp.",
  addressLabel: "Server address",
  addressPlaceholder: "http://127.0.0.1:5000/v1",
  keyLabel: "API key",
  keyPlaceholder: "API key (optional)",
  connect: "Connect",
  connecting: "Connecting…",
  saveKey: "Save key",
  cancel: "Cancel",
  found: "Running on this computer",
  use: "Use",
  foundModels: (count: number) => `${count} ${count === 1 ? "model" : "models"}`,
  foundNeedsKey: "asks for a key",
  connected: "Connected",
  notRunning: "Not running",
  needsKey: "Needs a key",
  noModels: "No models",
  /** "TabbyAPI at 127.0.0.1:5000", or the address alone for a server Genex can't name. */
  serverAt: (name: string | null, host: string) => (name ? `${name} at ${host}` : host),
  notRunningLine: (host: string) => `Nothing answers at ${host}. Start the server, then check again.`,
  needsKeyLine: (server: string) => `${server} asks for an API key.`,
  noModelsLine: (name: string) => `Load a model in ${name}, then check again.`,
  theServer: "the server",
  menu: "Server",
  menuName: "Local server options",
  change: "Change address…",
  changeLine: "Connect another server or port",
  disconnect: "Disconnect",
  models: "Models on this server",
  context: (size: string) => `${size} context`,
  seesImages: "sees images",
  cannotCallTools: "can't call tools, so it can't build",
  /** Where TabbyAPI keeps the key it asks for: it writes one on its first start. */
  tabbyKeyHint: "TabbyAPI writes its key to api_tokens.yml in its folder on first start.",
  otherServer: "Running another server?",
  connectIt: "Connect it in Model Providers",
  onboardingLine: "Already running LM Studio, llama.cpp or TabbyAPI?",
  connectServer: "Connect your server",
  problem: {
    [LocalServerProblem.Empty]: "Enter the server's address, like 127.0.0.1:5000.",
    [LocalServerProblem.Malformed]: "That isn't a server address. Enter one like http://127.0.0.1:5000/v1.",
    [LocalServerProblem.Scheme]: "Use an address that starts with http:// or https://.",
    [LocalServerProblem.Credentials]: "Leave the user name and password out of the address. Put a key under API key.",
    [LocalServerProblem.NotLocal]:
      "Genex connects to servers on this computer or your local network. For a hosted API, use OpenRouter or OpenCode.",
    [LocalServerProblem.NotFound]:
      "Couldn't find that computer on your network. Check the name, or use its IP address.",
    [LocalServerProblem.NotAnswering]: "Nothing answers at that address. Start the server and check the port.",
    [LocalServerProblem.NotOpenAi]:
      "Something answers there, but not as a model server. Check the port, and that the address ends in /v1.",
    [LocalServerProblem.NeedsKey]: "This server asks for an API key. Paste it under API key.",
    [LocalServerProblem.KeyRefused]: "The server didn't accept that key. Check it and paste it again.",
    [LocalServerProblem.BadKey]: "That doesn't look like a key. Paste the whole key, with no spaces.",
    [LocalServerProblem.OwnOllama]: "That's the Ollama on this computer. Its models are already under Local models.",
    [LocalServerProblem.StoreLocked]:
      "This computer's secure storage is locked or unavailable, so the key can't be saved.",
  } satisfies Record<LocalServerProblem, string>,
} as const;

/** Settings → Model Providers: which models the picker lists (`panels/PickerModels.tsx`). */
export const PICKER_MODELS_WORDS = {
  title: "Show in the model picker",
  group: (provider: string) => `${provider} models in the model picker`,
  reset: "Reset",
  older: "Older models",
  olderShown: (shown: number, total: number) => (shown ? `${shown} of ${total} shown` : String(total)),
  defaultModel: "Default",
  alwaysShown: "The default model is always in the picker",
  search: "Search models",
  searchLabel: (provider: string) => `Search ${provider} models`,
  noMatch: (query: string) => `No models match “${query.trim()}”`,
} as const;

// ── notifications ─────────────────────────────────────────────────────────────────────────

/** The notification feed's rows and sources (`notifications.ts`). */
export const NOTICE_WORDS = {
  planReady: "A plan is ready for your review.",
  planFailed: "The plan could not be prepared.",
  buildPlanReady: "The build plan is ready. Say go, or change it before it starts.",
  signedOut: "Signed out. Sign in again to keep building.",
  buildFailed: "Build failed.",
  buildStopped: "Build stopped. Everything built so far is kept.",
  buildLive: "Build finished. Changes are live.",
  /** A Loop that worked in its project's own folder: its work is there, which Live may only show as stills. */
  buildKept: "Build finished. Changes are kept in your project.",
  buildNothingNew: "Build finished without a new version.",
  newGame: "New game",
  harness: "Harness",
} as const;

/** A plugin's permission question as a row: its own prompt when it wrote one. */
export function permissionWords(plugin: string, prompt: string | undefined): string {
  return prompt ? `${plugin}: ${prompt}` : `${plugin} asks for permission.`;
}

// ── Harness activity ──────────────────────────────────────────────────────────────────────

/** The suggestions card in Activity and its exact-edit view (`ui/ProposalsTable.tsx`). */
export const SUGGESTION_WORDS = {
  title: (changes: string) => `Harness suggests ${changes} to how it builds`,
  subtitle: "Nothing changes until you apply.",
  include: (title: string) => `Include: ${title}`,
  fallbackSummary: "Suggested after reviewing your recent builds.",
  whatChanges: "What changes",
  seeExactEdit: "See the exact edit",
  selected: (included: number, total: number) => `${included} of ${total} selected · you can undo later`,
  discard: "Discard",
  apply: (changes: string) => `Apply ${changes}`,
} as const;

/** Activity's header and its Self-improvement switch (`panels/ReviewPanel.tsx`). */
export const ACTIVITY_WORDS = {
  title: "Activity",
  learning: "Self-improvement",
  learningHint: "When off, Harness stops learning from your builds. What it already learned stays until you undo it.",
} as const;

/** The Harness chat's header button and the dialog it opens (`chat/HarnessGuide.tsx`). */
export const HARNESS_GUIDE_WORDS = {
  open: "How it works",
  title: "How Harness works",
  lead: "Harness is the set of instructions the agents follow when they build your games. It learns from every build and suggests better ways to work. You decide what changes.",
  steps: [
    { title: "You build.", body: "Every game chat and Loop run is recorded under Recent runs." },
    {
      title: "Harness looks back.",
      body: "After a run it finds what went wrong or took extra work, and drafts an edit to its own instructions.",
    },
    {
      title: "The edit is tested.",
      body: "Independent reviewers compare the current and edited instructions on your past requests. Only edits they prefer go on.",
    },
    { title: "You decide.", body: "Suggestions wait until you apply them. Every applied change can be undone." },
  ],
  notes: [
    "Reviewers compare instructions; they don’t rebuild your games. An applied change isn’t proof of better results.",
    "Turn Self-improvement off to stop learning. What Harness already learned stays until you undo it.",
  ],
  settings: "Harness settings",
  done: "Done",
} as const;

// ── app updates ───────────────────────────────────────────────────────────────────────────

/** The sidebar's Relaunch to update or Download, while a new version of the app waits (`state/update.ts`). */
export const UPDATE_WORDS = {
  restart: "Relaunch to update",
  restarting: "Relaunching…",
  /** The button's tooltip: the version a relaunch installs. */
  hint: (version: string | null) => (version ? `Updates to Genex ${version}` : "Updates to the new version of Genex"),
  /** Linux: a newer release to download and install over this one. */
  download: (version: string | null) => (version ? `Download Genex ${version}` : "Download the new Genex"),
  downloadHint: "Opens the release page",
} as const;

/** The sidebar's plugin updates line and its list, while installed plugins have newer versions waiting (`state/plugins.ts`). */
/** Genex's updated terms waiting for the person, in the sidebar and under a Genex call in the chat. */
export const GENEX_TERMS_WORDS = {
  line: "Genex terms updated",
  /** Opens genex.games' terms page in the browser. */
  review: "Review",
  reviewLabel: "Review Genex terms on genex.games",
} as const;

/** The sidebar's line while the open studio's agents would not start (`AgentsStartLine.tsx`). */
export const AGENTS_START_WORDS = {
  line: "Agents didn’t start",
  /** The line while Try again runs. */
  starting: "Starting agents",
  tryAgain: "Try again",
  /** The line's own name, which opens why. */
  detailsLabel: "Why the agents didn’t start",
  report: "Send a report",
  sending: "Sending…",
  /** The bare ✓'s label, once the report went. */
  sent: "Report sent",
  reportFailed: "The report didn’t send. Try again in a moment.",
} as const;

export const PLUGIN_UPDATE_WORDS = {
  /** The line's name for what waits: it opens the list. */
  count: (count: number) => (count === 1 ? "1 plugin update" : `${count} plugin updates`),
  /** Install what is ticked: every update, or only some of them. */
  update: (chosen: number, total: number) => {
    if (chosen < total) return `Update ${chosen}`;
    return total === 1 ? "Update" : "Update all";
  },
  updating: "Updating plugins…",
  heading: "Plugin updates",
  /** Beside the heading while some updates are unticked. */
  chosen: (chosen: number, total: number) => `${chosen} of ${total}`,
  chooseAll: "Choose every update",
  openPlugins: "Open Plugins",
  /** A row's arrow: that plugin's own page. */
  openPlugin: (name: string) => `Open ${name}`,
  /** A row's versions, for a screen reader: "from 0.3.0 to 0.4.2". */
  versions: (from: string, to: string) => `from ${from} to ${to}`,
} as const;

/** Send feedback, from the bug button at the top of the sidebar (`panels/FeedbackDialog.tsx`). */
export const FEEDBACK_WORDS = {
  title: "Send feedback",
  field: "Feedback",
  placeholder: "What happened, and what did you expect?",
  appLogs: "Attach app logs",
  appLogsDetail: "Versions, provider status and the app's recent log, with keys and emails removed.",
  /** The chat switch, shown only while a chat is open: its game's title, or Harness. */
  chat: "Attach this chat",
  chatDetail: (chat: string) => `Recent activity in ${chat}, with keys and emails removed.`,
  send: "Send",
  sending: "Sending…",
  sent: "Feedback sent. Thank you.",
  failed: "Unable to send feedback. Try again in a moment.",
} as const;

/** Settings → About: the running version and Check for Updates (`panels/AboutSection.tsx`). */
export const ABOUT_WORDS = {
  tab: "About",
  product: "Genex",
  version: (version: string) => `Genex ${version}`,
  check: "Check for Updates",
  checking: "Checking…",
  current: "You're on the latest version.",
  downloading: "A new version is downloading. Genex offers the relaunch when it's ready.",
  ready: (version: string | null) => `Genex ${version ?? "update"} is ready to install.`,
  available: (version: string | null) => `Genex ${version ?? "update"} is available.`,
  off: "This build doesn't check for updates.",
  system: "Genex updates with your system: Software Updater, apt or dnf.",
  failed: "Couldn't check for updates. Check your connection and try again.",
  restart: "Relaunch to update",
  download: "Download",
  tagline: "The desktop app to build & publish games with AI",
  versionLine: (version: string | null) => (version ? `Version ${version}` : "Development build"),
  updates: "Updates",
  website: "Website",
  source: "Source code",
  licenses: "Licenses",
  copy: "Copy version info",
  copied: "Copied",
  /** What Copy version info puts on the clipboard, and the line beside it. */
  info: (version: string | null, platform: string, arch: string) =>
    `Genex ${version ?? "development build"} · ${PLATFORM_NAMES[platform] ?? platform} · ${arch}`,
} as const;

/** Platforms by the names people know them by. */
const PLATFORM_NAMES: Partial<Record<string, string>> = {
  [StudioPlatform.Mac]: "macOS",
  [StudioPlatform.Windows]: "Windows",
  [StudioPlatform.Linux]: "Linux",
};

// ── toasts ────────────────────────────────────────────────────────────────────────────────

/** The fixed toasts of the stage and the Builds tab. */
export const TOAST_WORDS = {
  buildLive: "This build is your game now",
  shownBuildBroken: "That build turned out not to run — Reload puts your game folder back on the stage.",
  packagesInstalled: "Packages installed — building your game again.",
  packagesFailed: "The packages could not be installed — the details are on the stage.",
} as const;

/** How many packages the setup-scripts window names before it counts the rest. */
const SCRIPTS_NAMED = 4;

/** "This game, sharp and esbuild": who brought the setup scripts a remix's install skipped. */
function scriptOwners(own: boolean, packages: readonly string[]): string {
  const names = [...(own ? ["This game"] : []), ...packages.slice(0, SCRIPTS_NAMED)];
  const rest = packages.length - Math.min(packages.length, SCRIPTS_NAMED);
  if (rest > 0) names.push(`${rest} more`);
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A remix's setup scripts its script-free install skipped: the stage's offer and the window that runs them. */
export const SETUP_SCRIPTS_WORDS = {
  trouble: "It may need the setup scripts its packages came with, which didn’t run.",
  button: "Run setup scripts",
  buttonTitle: "Run the setup scripts this game’s packages came with",
  running: "Running…",
  title: "Run this game’s setup scripts?",
  body: (own: boolean, packages: readonly string[]) =>
    `${scriptOwners(own, packages)} came with setup scripts written by their authors. Genex skipped them when it made your copy, and the game may need them to build. Run them only if you trust this game.`,
  notNow: "Not now",
  notNowDetail: "The game stays as it is. You can run them later from here.",
  run: "Run setup scripts",
  runDetail: "They run in Genex’s sandbox and can’t change your other games.",
} as const;

// ── the Builds tab's progress line ────────────────────────────────────────────────────────

/** The fixed titles and sentences of the Builds tab's progress line (`build-progress.ts`). */
export const PROGRESS_WORDS = {
  optimizationFinished: "Optimization finished",
  optimization: "Optimization",
  optimizing: "The assembled game is being measured and checked for safe improvements.",
  buildingStart: "Building the starting point",
  startBeforeParts: "The starting point is built and checked before the lead delegates the parts.",
  startReady: "The starting point is ready",
  gettingStarted: "Getting started",
  leadLooking: "The lead is looking at your game and deciding what this build needs.",
  betweenBuilds: "Between builds",
  nothingKept: "Nothing kept yet",
  planningParts: "Planning the parts",
  planOpens: "The plan opens here; each part appears as it is named.",
  preparingBuilds: "Preparing the next builds",
  startRejected: "The starting point was rejected; the parts carry on from an empty game.",
  startEmpty: "The starting point runs but is empty — no scenery or gameplay yet.",
  startPassed: "The starting point passed its checks. Each part still needs its own verdict.",
} as const;

/** "2 parts building". */
export function partsBuildingWords(parts: number): string {
  return `${plural(parts, "part")} building`;
}

/** What a lead's run has kept while its builders work, and how many parts are done. */
export function keptSoFarWords(kept: number, finished: number): string {
  const sofar = kept ? `${plural(kept, "round")} kept so far` : PROGRESS_WORDS.nothingKept;
  return `${sofar}${finished ? ` · ${finished} finished` : ""}.`;
}

/** A lead's run between builders. */
export function partsFinishedWords(parts: number): string {
  return `${plural(parts, "part")} finished · the lead is deciding what comes next.`;
}

/** A programmed run's parts waiting on the starting point. */
export function partsWaitingWords(parts: number): string {
  return `Every part starts from it · ${plural(parts, "part")} waiting.`;
}

// ── tools ─────────────────────────────────────────────────────────────────────────────────

export interface ToolWords {
  icon: ToolIcon;
  label: string;
  /** A running call's own words, when its icon's (`TOOL_ACTIVITY_WORDS`) would say less. */
  active?: string;
}

/** The studio's own tools, in the user's words. The chip beside the row carries the argument. */
const STUDIO_TOOLS: Record<string, ToolWords> = {
  write_file: { icon: "write", label: "wrote a file" },
  write_own_file: { icon: "write", label: "edited itself" },
  write_skill: { icon: "write", label: "wrote itself a skill" },
  install_tool: { icon: "write", label: "gave itself a new tool" },
  run_command: { icon: "run", label: "ran a command" },
  restart_studio: { icon: "run", label: "restarted itself" },
  delegate_to_contractor: { icon: "run", label: "handed the work to a worker" },
  read_file: { icon: "read", label: "read a file" },
  read_own_file: { icon: "read", label: "read itself" },
  read_skill: { icon: "read", label: "read its own skill" },
  list_files: { icon: "read", label: "listed the files" },
  list_own_files: { icon: "read", label: "listed its own files" },
  stat_own_file: { icon: "read", label: "checked one of its own files" },
  self_history: { icon: "read", label: "read its own history" },
  list_games: { icon: "read", label: "listed your games" },
  screenshot: { icon: "see", label: "took a screenshot" },
  load_preview: { icon: "see", label: "loaded the game" },
  reload_preview: { icon: "see", label: "reloaded the game" },
  console_log: { icon: "see", label: "read the game's console" },
  gpu_errors: { icon: "see", label: "checked for graphics errors" },
  press_keys: { icon: "game", label: "pressed keys" },
  click: { icon: "game", label: "clicked" },
  look: { icon: "game", label: "looked around" },
  check_game: { icon: "game", label: "checked the game" },
  game_state: { icon: "game", label: "read the game's state" },
  play_deterministic: { icon: "game", label: "played the game" },
  new_game: { icon: "game", label: "started a new game" },
  export_game: { icon: "game", label: "exported the game" },
  remember: { icon: "think", label: "remembered something" },
  forget: { icon: "think", label: "forgot something" },
  snapshot_now: { icon: "think", label: "saved a snapshot" },
  start_unattended_run: { icon: "run", label: "started the build" },
  start_autopilot: { icon: "run", label: "requested an iterative build" },
  run_status: { icon: "run", label: "checked on the build" },
  steer_run: { icon: "run", label: "passed on your guidance" },
  finish_run: { icon: "run", label: "asked the workers to wrap up" },
  resume_run: { icon: "run", label: "resumed the saved build" },
  reopen_run: { icon: "run", label: "reopened the build" },
  continue_build: { icon: "run", label: "continued the build" },
  show_build: { icon: "see", label: "showed you a build" },
  land_build: { icon: "write", label: "put the build in your game" },
  ask_user: { icon: "think", label: "asked you a question" },
  set_game_cover: { icon: "write", label: "painted the game's cover" },
  checkpoint: { icon: "see", label: "marked a moment worth seeing" },
  capture: { icon: "see", label: "captured the game", active: "Capturing the game" },
  // The lead's run tools. `wait` stays neutral: a playtester waits too.
  plan: { icon: "think", label: "set out the plan", active: "Writing the plan" },
  goal_update: {
    icon: "think",
    label: "noted a blocker or a new approach",
    active: "Noting a blocker or a new approach",
  },
  worker_start: { icon: "run", label: "started a worker", active: "Starting a worker" },
  worker_status: { icon: "read", label: "checked on a worker", active: "Checking on a worker" },
  worker_steer: { icon: "run", label: "redirected a worker" },
  worker_stop: { icon: "run", label: "stopped a worker" },
  worker_wait: { icon: "think", label: "waited on the workers", active: "Waiting on the workers" },
  worker_mark: { icon: "write", label: "marked a worker's work" },
  // Background work and the look-only app tool, shared by the chat, leads and workers.
  [JobTool.Start]: { icon: "run", label: "started background work", active: "Starting background work" },
  [JobTool.Status]: { icon: "read", label: "checked on background work", active: "Checking on background work" },
  [JobTool.Tail]: { icon: "read", label: "read background work's output" },
  [JobTool.Stop]: { icon: "run", label: "stopped background work" },
  [APP_LOOK_TOOL_NAME]: { icon: "see", label: "looked at an app window", active: "Looking at an app window" },
  [JUDGE_PLAY_TOOL_NAME]: { icon: "game", label: "had a judge play the game", active: "A judge is playing the game" },
  wait: { icon: "think", label: "waited", active: "Waiting" },
  judge: { icon: "see", label: "reviewed a build", active: "Reviewing a build" },
  playtest: { icon: "game", label: "had a build playtested", active: "Playtesting a build" },
  integrate: { icon: "write", label: "merged a worker's work", active: "Merging a worker's work" },
  show: { icon: "see", label: "showed you a build" },
  note: { icon: "think", label: "noted a decision" },
  wrap_up: { icon: "run", label: "began finishing the build", active: "Finishing the build" },
  finish: { icon: "run", label: "wrapped up the build", active: "Wrapping up the build" },
};

/** A builder's own tools come from its SDK, in its own vocabulary — Bash, Read, Edit, MCP. */
const SDK_TOOLS: Array<[RegExp, ToolWords]> = [
  [/^mcp__studio__computer$/i, { icon: "see", label: "looked at the game" }],
  [/^(bash|bashoutput|killshell|killbash)$/i, { icon: "run", label: "ran a command" }],
  [/^(read|notebookread)$/i, { icon: "read", label: "read the code" }],
  [/^(edit|multiedit|write|notebookedit)$/i, { icon: "write", label: "edited the code" }],
  [/^(grep|glob|ls|search)$/i, { icon: "read", label: "searched the code" }],
  [/^(webfetch|websearch)$/i, { icon: "read", label: "looked something up", active: "Looking something up" }],
  [/^todowrite$/i, { icon: "think", label: "planned its next steps" }],
  [/^(task|agent)/i, { icon: "run", label: "asked a helper" }],
];

/**
 * One name → one row label. Studio tools and builder tools land in the same list in the chat,
 * so they are phrased the same way: past tense, lower case, no underscores.
 */
export function toolWords(name: string): ToolWords {
  const raw = (name ?? "").trim();
  const studio = STUDIO_TOOLS[raw];
  if (studio) return studio;
  for (const [pattern, words] of SDK_TOOLS) if (pattern.test(raw)) return words;
  const bare = raw.replace(/^mcp__[^_]+__/i, "");
  const known = STUDIO_TOOLS[bare];
  if (known) return known;
  // Plugins and MCP connectors share namespaced names. The namespace alone does not
  // establish which kind of source ran; the host record supplies its display name.
  const plugin = /^([a-z][a-z0-9-]*)__(.+)$/i.exec(bare);
  if (plugin) return { icon: "run", label: `used a tool: ${(plugin[2] ?? "").replace(/[_-]+/g, " ").trim()}` };
  const pretty = bare
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return { icon: "run", label: pretty ? `used ${pretty}` : "used a tool" };
}

/** The header on a collapsed block of tool rows — one line for a whole minute of work. */
export function toolGroupHeader(steps: number): string {
  return plural(steps, "tool call");
}

// ── plugin consent ─────────────────────────────────────────────────────────────────────────

/** The chat card a plugin's question becomes: who asks, to do what, with which arguments. */
export function consentAskWords(ask: {
  pluginName?: string | null;
  tool?: string | null;
  args?: Record<string, unknown> | null;
  prompt?: string | null;
}): string {
  const who = (ask.pluginName ?? "").trim() || A_PLUGIN;
  const tool = consentToolWords(ask.tool);
  const digest = Object.entries(ask.args ?? {})
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
  const args = digest ? ` (${clip(digest, CONSENT_ARGS_MAX)})` : "";
  const prompt = (ask.prompt ?? "").trim();
  return `${who} asks to run ${tool}${args}${prompt ? ` — ${prompt}` : ""}`;
}

/** A connector tool's name as words (`unreal-editor__call_tool` → `call tool`). */
export const consentToolWords = (tool: string | null | undefined): string =>
  (tool ?? "").split("__").pop()?.replace(/[-_]+/g, " ").trim() || "a tool";

/** The consent card's choices. Always allow is offered on a connector's card only. */
export const CONSENT_CHOICE_WORDS = {
  once: { label: "Allow once", description: "Ask again next time." },
  always: (source: string) => ({
    label: "Always allow",
    description: `Don't ask again for this action in ${source}.`,
  }),
  decline: { label: "Don't allow", description: "The agent carries on without it." },
} as const;

/**
 * The studio's card that turns computer control on, asked when a plugin's Do it for me finds it
 * off: it is one setting, so it says it is for every chat.
 */
export const COMPUTER_SETTING_CARD_WORDS = {
  title: COMPUTER_SETTING_QUESTION,
  turnOn: { label: "Turn on", description: "You can turn it off in Settings → Permissions." },
  notNow: { label: "Not now", description: "Computer control stays off, and nothing is clicked." },
} as const;

/** A waiting consent question's title when the plugin wrote no prompt of its own. */
export const consentNeededWords = (source: string | undefined): string => `${source || A_PLUGIN} needs your permission`;

/** A settled consent question as one line, as Claude's own are: how it ended, then whose it was. */
export const consentLineWords = (outcome: string, source: string | undefined): string =>
  `${outcome} · ${source || A_PLUGIN}`;

/** How a consent question ended, once it is no longer waiting on the user. */
export function consentOutcomeWords(outcome: {
  state?: string | null;
  by?: string | null;
  always?: boolean | null;
}): string {
  if (outcome.state === "approved") return outcome.always ? "Always allowed" : "Allowed";
  if (outcome.by === "timeout") return "Nobody answered";
  if (outcome.by === "restart") return "Withdrawn when the studio restarted";
  if (outcome.by === "stop" || outcome.by === "turn") return "Withdrawn when the turn stopped";
  return "Declined";
}

// ── tool permission ────────────────────────────────────────────────────────────────────────

const PERMISSION_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PERMISSION_READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);
/** Claude Code's prefix for a tool an MCP server offers (`mcp__server__tool`). */
const MCP_TOOL = "mcp";
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** An MCP tool by its own name (`mcp__server__make_sprite` is "make sprite"); others as named. */
function permissionToolName(tool: string): string {
  const parts = tool.split("__");
  if (parts[0] !== MCP_TOOL || parts.length <= 2) return tool;
  return parts.slice(2).join(" ").replace(/[_-]+/g, " ").trim();
}

/** What a file tool acts on: the path it names. */
export function permissionPath(event: Partial<ToolPermissionEvent>): string | undefined {
  const input = event.input ?? {};
  const named = nonEmpty(event.subject) ?? nonEmpty(input.file_path) ?? nonEmpty(input.notebook_path);
  if (named) return named;
  return nonEmpty(input.path) ?? (PERMISSION_READ_TOOLS.has(event.tool ?? "") ? nonEmpty(input.pattern) : undefined);
}

/** A rule's path, as Claude Code writes it (`//Users/me/refs/**`), as a person reads it. */
const rulePath = (content: string): string => content.replace(/\/\*\*?$/, "").replace(/^\/\//, "/") || "/";

/** The host a web fetch opens, or the address itself when it is a bare host. */
function webHost(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
}

/** The placeholder of a permission card's own-words row: what the person tells the one who asked to do instead. */
export function permissionInsteadWords(event: Partial<ToolPermissionEvent>): string {
  return event.worker ? "Tell the worker what to do instead…" : "Tell Claude what to do instead…";
}

/** Who asks: a worker of the chat's lead by its title, else Claude. */
function permissionAsker(event: Partial<ToolPermissionEvent>): string {
  if (!event.worker) return "Claude";
  return nonEmpty(event.worker.title) ?? "A worker";
}

/** What a tool that is neither a command nor a plan is about to do. */
function toolAskWords(event: Partial<ToolPermissionEvent>, tool: string): string {
  const who = permissionAsker(event);
  if (PERMISSION_EDIT_TOOLS.has(tool)) {
    const path = permissionPath(event);
    const name = path ? pathLeaf(path) : undefined;
    return name ? `${who} wants to edit ${name}` : `${who} wants to edit a file`;
  }
  if (PERMISSION_READ_TOOLS.has(tool)) {
    const path = permissionPath(event);
    return path ? `${who} wants to read ${path}` : `${who} wants to read files`;
  }
  if (tool === "WebFetch") {
    const address = nonEmpty(event.subject) ?? nonEmpty(event.input?.url);
    return address ? `${who} wants to open ${webHost(address)}` : `${who} wants to open a web page`;
  }
  if (tool.startsWith(`${MCP_TOOL}__`)) return `${who} wants to use ${permissionToolName(tool)}`;
  return `${who} wants to use ${nonEmpty(event.displayName) ?? (permissionToolName(tool) || "a tool")}`;
}

/**
 * A job's card: who wants to run what in the background, by the job's plain title. A lead's card
 * keeps its own words; a worker's and the chat's own name who asks. Never the command: it sits
 * folded under the card's Details.
 */
function jobAskWords(event: Partial<ToolPermissionEvent>): string {
  const own = event.worker ? undefined : nonEmpty(event.title);
  if (own) return own;
  const title = nonEmpty(event.input?.title);
  return `${permissionAsker(event)} wants to run ${title ?? "something"} in the background`;
}

/** A command card's question: the command itself is on the card in full. */
export function permissionCommandWords(event: Partial<ToolPermissionEvent>): string {
  return `${permissionAsker(event)} wants to run a command`;
}

/**
 * The card's question: Claude Code's own sentence when it wrote one, else what the tool is about
 * to do. A worker's card says what that worker wants (Claude Code's sentence names Claude). A plan
 * waiting for approval is always "Approve this plan?".
 */
export function permissionTitleWords(event: Partial<ToolPermissionEvent>): string {
  if (isPlanRequest(event)) return "Approve this plan?";
  if (event.tool === JOB_PERMISSION_TOOL) return jobAskWords(event);
  const title = event.worker ? undefined : nonEmpty(event.title);
  if (title) return title;
  const tool = event.tool ?? "";
  if (tool === "Bash") return permissionCommandWords(event);
  return toolAskWords(event, tool);
}

/** A saved rule's tool and what it names: `Bash(npm test:*)` is Bash and `npm test:*`. */
function parsedRule(rule: string): { tool: string; content: string } {
  const parsed = /^([^(]+)\(([\s\S]*)\)$/.exec(rule.trim());
  return { tool: parsed?.[1]?.trim() ?? rule.trim(), content: parsed?.[2]?.trim() ?? "" };
}

/** `npm test:*` and `npm test *` both allow every command that starts with the prefix. */
const commandPrefix = (content: string): string | undefined => /^(.+?)(?::\*| \*)$/.exec(content)?.[1]?.trim();

/** What one rule allows, and where. */
function ruleGrantWords(rule: string, scope: RuleScope): string {
  const where = scope === RuleScope.Chat ? "in this chat" : "in this game";
  const { tool, content } = parsedRule(rule);
  if (tool === "Bash" && content) {
    const prefix = commandPrefix(content);
    return prefix ? `Always allow ${prefix} commands ${where}` : `Always allow this command ${where}`;
  }
  if (tool === "Read" && content) return `Always allow reading ${rulePath(content)} ${where}`;
  if (PERMISSION_EDIT_TOOLS.has(tool) && content) return `Always allow editing ${rulePath(content)} ${where}`;
  if (tool === "WebFetch" && content.startsWith("domain:")) return `Always allow ${content.slice(7)} ${where}`;
  return `Always allow ${permissionToolName(tool)} ${where}`;
}

/** Settings → Permissions: a saved rule as the action it allows ("Run npm install"); the rule itself when unknown. */
export function permissionRuleWords(rule: string): string {
  const { tool, content } = parsedRule(rule);
  if (!content) return rule;
  if (tool === "Bash") return `Run ${commandPrefix(content) ?? content}`;
  if (PERMISSION_READ_TOOLS.has(tool)) return `Read files in ${homePath(rulePath(content))}`;
  if (PERMISSION_EDIT_TOOLS.has(tool)) return `Edit files in ${homePath(rulePath(content))}`;
  if (tool === "WebFetch" && content.startsWith("domain:")) return `Open pages on ${content.slice(7)}`;
  return rule;
}

function grantWords(grant: PermissionGrant): string {
  if (grant.kind === GrantKind.Mode) {
    if (grant.mode === PermissionMode.AcceptEdits) return "Allow all edits in this chat";
    return `Use ${PERMISSION_MODE_WORDS[grant.mode]?.label ?? grant.mode} in this chat`;
  }
  if (grant.kind === GrantKind.Directory) return `Always allow ${grant.path} in this chat`;
  return ruleGrantWords(grant.rule, grant.scope);
}

/** The "always" choice: what it would grant, and for how long. */
export function alwaysWords(grants: readonly PermissionGrant[]): string {
  if (!grants.length) return "Always allow";
  // Every grant is named: the choice keeps all of them, so none may hide behind a count.
  return grants
    .map((grant, index) => {
      const words = grantWords(grant);
      return index ? words.charAt(0).toLowerCase() + words.slice(1) : words;
    })
    .join(", and ");
}

/**
 * What the Bypass confirmation says it reaches, on `platform` (`renderer/platform.ts`): this Mac,
 * or this computer where the studio runs on another system; macOS's words until main has said.
 */
export function bypassPermissionsWords(platform: string): string {
  const machine = platform && platform !== StudioPlatform.Mac ? "this computer" : "this Mac";
  return `Claude will run commands and change files anywhere on ${machine} without asking. Rewind restores only the game folder.`;
}

/** How a request the work ended around reads. */
const PERMISSION_WITHDRAWN: Partial<Record<string, string>> = {
  [ToolPermissionBy.Stop]: "Withdrawn when the work stopped",
  [ToolPermissionBy.Turn]: "Withdrawn when the turn ended",
  [ToolPermissionBy.Restart]: "Withdrawn by a restart",
  [ToolPermissionBy.Timeout]: "Withdrawn: nobody answered",
};

/** How a permission request ended, once it no longer waits on the person. */
export function permissionOutcomeWords(event: Partial<ToolPermissionEvent>): string {
  if (event.state === ToolPermissionState.Allowed) {
    if (isPlanRequest(event) && event.mode)
      return `Plan approved · ${PERMISSION_MODE_WORDS[event.mode]?.label ?? event.mode}`;
    if (event.by === ToolPermissionBy.Mode) return "Allowed in Bypass";
    return event.granted === PermissionGranted.Always ? "Always allowed" : "Allowed";
  }
  const withdrawn = PERMISSION_WITHDRAWN[event.by ?? ""];
  if (withdrawn) return withdrawn;
  const message = nonEmpty(event.message);
  return message ? `Denied · ${message}` : "Denied";
}

/** What a request was about, in a few words: a command's first line, a file's path, a page's host, a tool's name. */
function permissionSubjectWords(event: Partial<ToolPermissionEvent>): string {
  if (isPlanRequest(event)) return "the plan";
  const tool = event.tool ?? "";
  if (tool === "Bash") {
    const command = nonEmpty(event.subject) ?? nonEmpty(event.input?.command);
    return command?.split("\n")[0]?.trim() || "a command";
  }
  if (PERMISSION_EDIT_TOOLS.has(tool) || PERMISSION_READ_TOOLS.has(tool)) return permissionPath(event) ?? "a file";
  if (tool === "WebFetch") {
    const address = nonEmpty(event.subject) ?? nonEmpty(event.input?.url);
    return address ? webHost(address) : "a web page";
  }
  return nonEmpty(event.displayName) ?? (permissionToolName(tool) || "a tool");
}

/**
 * An answered request in one line, what came of it and then what it was about ("Allowed · npm
 * install three"); a plan approval says the mode it continues in. The rest opens below it.
 */
export function permissionLineWords(event: Partial<ToolPermissionEvent>): string {
  const approvedPlan = isPlanRequest(event) && event.state === ToolPermissionState.Allowed && event.mode;
  if (approvedPlan) return permissionOutcomeWords(event);
  const denied = event.state !== ToolPermissionState.Allowed && !PERMISSION_WITHDRAWN[event.by ?? ""];
  const outcome = denied ? "Denied" : permissionOutcomeWords(event);
  return `${outcome} · ${permissionSubjectWords(event)}`;
}

/**
 * A running call's label by its icon. Present tense is reserved for calls with an observed start
 * and no recorded end. The chat's busy line recognises these exact words (`chat/current-work.ts`).
 */
export const TOOL_ACTIVITY_WORDS: Readonly<Record<ToolIcon, string>> = {
  read: "Reading",
  write: "Editing",
  run: "Running a tool",
  see: "Inspecting the game",
  game: "Working on the game",
  think: "Thinking",
};

/** A running call's label when its row carries none of its own. */
export const USING_A_TOOL = "Using a tool";

/** A running call's label by its icon (`TOOL_ACTIVITY_WORDS`). */
export function toolActivityWords(icon: ToolIcon): string {
  return TOOL_ACTIVITY_WORDS[icon];
}

// ── The chat panel ─────────────────────────────────────────────────────────────────────────

/** Freeing space: Settings → Storage, the chat header's button and their confirmation. */
export const STORAGE_WORDS = {
  tab: "Storage",
  title: "Free up space",
  keeps: "Your games, save points, paused builds and each game’s latest build stay.",
  measuring: "Measuring…",
  freeing: "Freeing…",
  nothing: "Nothing to free up",
  none: "None",
  keep: "Keep",
  freedNothing: "There was nothing to free.",
} as const;

/** Each kind of space freeing deletes: its name and what it is. */
export const STORAGE_KIND_WORDS = {
  [StorageKind.Copies]: { label: "Build copies", about: "Folders Genex made to run and show builds." },
  [StorageKind.Pictures]: { label: "Build pictures", about: "Screenshots and recordings of finished builds." },
  [StorageKind.History]: { label: "Rewind copies", about: "Versions of your games saved for Rewind and builds." },
} as const satisfies Record<StorageKind, { label: string; about: string }>;

/** A size in running text, kept on one line ("1.2 GB" never breaks before its unit). */
function unbrokenSize(bytes: number): string {
  return sizeWords(bytes).replace(" ", "\u00a0");
}

/** The button that frees `space`: how much it frees, or that there is nothing to. */
export function freeUpWords(space: StorageSpace): string {
  const bytes = freeableBytes(space);
  return bytes > 0 ? `Free up ${sizeWords(bytes)}` : STORAGE_WORDS.nothing;
}

/** The chat header's button: how much freeing this game frees. */
export function freeGameWords(space: StorageSpace): string {
  return `Free ${sizeWords(freeableBytes(space))}`;
}

/** The confirmation's title. */
export function freeConfirmTitle(space: StorageSpace): string {
  return `Free up ${unbrokenSize(freeableBytes(space))}?`;
}

/** What freeing deletes and what stays: the tooltip and the confirmation's body, for one game or all. */
export function freeSpaceWords(space: StorageSpace, game?: string): string {
  const of = game ? ` of ${game}` : "";
  const holds = `Older builds${of} and Rewind copies take ${unbrokenSize(freeableBytes(space))}.`;
  const stays = game ? "The game, its save points, paused builds and latest build stay." : STORAGE_WORDS.keeps;
  return `${holds} ${stays} Older messages can still rewind the chat, but not its files.`;
}

/** The notice after freeing space: how much, and which working games it left alone. */
export function freedWords(freed: StorageFreed, titleOf: (game: string) => string = (game) => game): string {
  const done = freed.freedBytes > 0 ? `Freed ${sizeWords(freed.freedBytes)}.` : STORAGE_WORDS.freedNothing;
  const [only, ...more] = freed.skipped;
  if (only === undefined) return done;
  if (more.length === 0) return `${done} Left ${titleOf(only)} alone while it works.`;
  return `${done} Left ${plural(freed.skipped.length, "game")} alone while they work.`;
}

/** How many included files an export notice names before it says "and N more". */
const EXPORT_LIST_LIMIT = 12;

/** The notice after a game's public files were exported. */
export function exportedWords(result: { files: number; included: string[]; excluded: string[] }): string {
  const named = result.included.slice(0, EXPORT_LIST_LIMIT).join(", ");
  const rest = result.included.length - EXPORT_LIST_LIMIT;
  const more = rest > 0 ? ` and ${rest} more` : "";
  return `Exported ${result.files} public files. Included: ${named}${more}. Excluded from selected roots: ${result.excluded.length}.`;
}

/** The chat's own lines outside its markup: busy labels, prefills and refusals. */
export const CHAT_WORDS = {
  stopping: "Stopping",
  /** A message on its way, until its row arrives. */
  sending: "Sending",
  /** A follow-up on its way, or waiting below the work until that work reads it. */
  sendingMessage: "Sending…",
  waitingForAnswer: "Waiting for your answer",
  describeChanges: "Describe the changes you’d like to make",
  /** A build's generic busy label reads as its next step instead. */
  planningNextStep: "Planning the next step",
  keepGoing: "Keep going from where we left off.",
  consentSettled: "That request is no longer waiting for an answer.",
  planSettled: "This plan is no longer waiting for approval.",
  /** Below the one waiting card on show: how many more wait behind it. */
  moreWaiting: (count: number) => `${count} more waiting`,
} as const;

/** "1 picture", "2 pictures", or with `files` "1 file", "2 files". */
const counted = (count: number, files: boolean): string =>
  `${count} ${files ? "file" : "picture"}${count === 1 ? "" : "s"}`;

/**
 * The prompt bar's line while files are dragged over the chat, and the note a drop leaves. `files`
 * says whether what is counted includes files that are not pictures.
 */
export const COMPOSER_DROP_WORDS = {
  dropToAdd: (count: number, files: boolean) => `Drop to add ${counted(count, files)}`,
  full: (max: number, files: boolean) => `${max} ${files ? "files" : "pictures"} at most`,
  someStayOut: (room: number, out: number, files: boolean) => `Room for ${counted(room, files)}, ${out} will stay out`,
  overLimit: (count: number, max: number, files: boolean) => `${counted(count, files)} left out, ${max} at most`,
  couldNotAdd: (name: string) => `${name} couldn’t be added`,
  couldNotAddMany: (count: number) => `${count} files couldn’t be added`,
  filesLeftOut: (count: number) => `${count} files didn’t go in`,
  chooseFiles: "Choose files",
  dismiss: "Dismiss",
  /** A file on the board: its chip's remove button. */
  remove: (name: string) => `Remove ${name}`,
} as const;

// ── the system file manager ───────────────────────────────────────────────────────────────

/** What a button that shows a file in the system's file manager says, and its failure. */
export interface FileManagerWords {
  /** Show a folder or a game file. */
  show: string;
  /** Show an asset from its preview. */
  reveal: string;
  revealFailed: string;
}

const FINDER_WORDS: FileManagerWords = {
  show: "Show in Finder",
  reveal: "Reveal in Finder",
  revealFailed: "Could not reveal this file in Finder.",
};

/** Windows names File Explorer; Linux has no one file manager, so the folder is named instead. */
const FILE_MANAGER_WORDS: Readonly<Record<string, FileManagerWords>> = {
  [StudioPlatform.Mac]: FINDER_WORDS,
  [StudioPlatform.Windows]: {
    show: "Show in Explorer",
    reveal: "Show in Explorer",
    revealFailed: "Could not show this file in Explorer.",
  },
  [StudioPlatform.Linux]: {
    show: "Show in folder",
    reveal: "Show in folder",
    revealFailed: "Could not show this file in its folder.",
  },
};

/** The file manager's words on `platform` (`renderer/platform.ts`); macOS's until main has said. */
export function fileManagerWords(platform: string): FileManagerWords {
  return FILE_MANAGER_WORDS[platform] ?? FINDER_WORDS;
}

// ── delivered assets ──────────────────────────────────────────────────────────────────────

/** What the chat's asset cards, the Assets tab and the asset viewer say. */
export const ASSET_WORDS = {
  openInAssets: "Open in Assets",
  /** How to move around a model in the viewer, and around a flat texture. */
  modelHint: "Drag to turn · Scroll to zoom · Double-click to reset",
  textureHint: "Scroll to zoom · Double-click to reset",
  zoomIn: "See the picture at full size",
  zoomOut: "Fit the picture",
  loading: "Loading preview…",
  animations: "Animations",
  speed: "Speed",
  playFailed: "This sound could not be played",
} as const;

/** Save, Share, select several and search on the Assets tab and in its viewer (`panels/assets/`). */
export const ASSET_LIBRARY_WORDS = {
  /** The tags on a card. */
  saved: "Saved",
  shared: "Shared",
  save: "Save",
  saveTip: "Save to your library",
  unsaveTip: "Remove from Saved",
  share: "Share",
  shareTip: "Share with the community",
  sharing: "Sharing…",
  /** The menu of an asset on Play: its page, and taking it off. */
  sharedMenu: "Shared on Play",
  openOnPlay: "Open on Play",
  stopSharing: "Stop sharing",
  /** A share's step line under its card, and how it ended. */
  steps: { send: "Send", check: "Check", live: "Live" },
  stepsLabel: "Sharing",
  checking: "Checking",
  onPlay: "On Play",
  missed: {
    [ShareMiss.Refused]: "Couldn't share",
    [ShareMiss.Checking]: "Checking",
    [ShareMiss.NotShareable]: "Only Genex assets share",
    [ShareMiss.KindNotShareable]: "Music can't be shared",
    [ShareMiss.TooMany]: "Too many at once",
    [ShareMiss.Failed]: "Couldn't share",
  } satisfies Record<ShareMiss, string>,
  tryAgain: "Try again",
  sendReport: "Send a report",
  sendReportLabel: "Send this refusal and the app's logs to the Genex team",
  reportSent: "Report sent",
  /** What Send a report posts: the asset, its game and genex.games' own words. */
  reportText: (name: string, project: string, detail: string) =>
    `genex.games refused to share "${name}" (${project}).${detail ? `\n\n${detail}` : ""}`,
  /** The share window. */
  shareOne: (name: string) => `Share ${name}`,
  shareMany: (count: number) => `Share ${count} assets`,
  shareButton: (count: number) => (count === 1 ? "Share" : `Share ${count} assets`),
  nameLabel: "Name",
  nameOf: (name: string) => `Name for ${name}`,
  everyoneOne: "Everyone on Genex can find and use it.",
  everyoneMany: "Everyone on Genex can find and use them.",
  cancel: "Cancel",
  /** Select several. */
  selected: (count: number) => `${count} selected`,
  select: (name: string) => `Select ${name}`,
  deselect: (name: string) => `Deselect ${name}`,
  clear: "Clear",
  clearSelection: "Clear the selection",
  /** Search on the canvas. */
  search: "Search assets",
  searchLabel: "Search this game, your library and the community",
  clearSearch: "Clear the search",
  thisGame: "This game",
  myLibrary: "My library",
  community: "Community",
  noMatches: "no matches",
  add: "Add",
  addLabel: (title: string) => `Add ${title} to this game`,
  added: (game: string) => `Added to ${game}`,
} as const;

/** The Builds graph's assets tile and card: jobs still open when the run ended. */
export const ASSET_JOB_WORDS = {
  notFinished: (count: number) => `${count} not finished`,
  notFinishedGroup: "Not finished",
} as const;

/** What an asset card says while its asset is being made (`asset-making.ts`). */
export const MAKING_WORDS = {
  /** What a job makes (`MakingKind`), and an asset of a kind the plugin did not say. */
  kind: {
    [MakingKind.Character]: "Character",
    [MakingKind.Creature]: "Creature",
    [MakingKind.Model]: "3D model",
    [MakingKind.RiggedModel]: "Rigged model",
    [MakingKind.Animation]: "Animation",
    [MakingKind.Image]: "Image",
    [MakingKind.Texture]: "Texture",
    [MakingKind.Video]: "Video",
    [MakingKind.SoundEffect]: "Sound effect",
    [MakingKind.Music]: "Music",
    [MakingKind.Voice]: "Voice",
    asset: "Asset",
  } satisfies Record<MakingKind | "asset", string>,
  queued: "Queued",
  failed: "Didn’t finish",
  stopped: "Stopped",
  unsure: "Not confirmed",
  notFetched: "Not downloaded",
  notInGame: "Not in your game",
  /** A clock that ran past the hours it spells out. */
  overHours: (hours: number) => `${hours}+ h`,
  approve: "Approve",
  approving: "Approving…",
  /** The Approve button's full name: which candidate, or the remesh. */
  approveLabel: (candidate: number | null) =>
    candidate === null ? "Approve the remesh" : `Approve candidate ${candidate}`,
  /** A candidate's tab, and its picture. */
  candidate: (n: number) => `Candidate ${n}`,
  candidates: "Candidates",
  /** The chat's cards of the assets a piece of work is still making. */
  inChat: "Assets being made",
  spoken: {
    making: (kind: string, tool: string) => `${kind} being made with ${tool}`,
    queued: (kind: string, tool: string) => `${kind} queued for ${tool}`,
    review: (kind: string, tool: string) => `${kind} from ${tool} waits for your choice`,
    ended: (kind: string, tool: string, title: string) => `${kind} from ${tool}: ${title}`,
    withPrompt: (said: string, prompt: string) => `${said}. ${prompt}`,
  },
} as const;

/** "1 animation", "3 animations". */
export function animationCountWords(count: number): string {
  return count === 1 ? "1 animation" : `${count} animations`;
}

/** A model's animation files, named for the model: "Knight animations". */
export function modelAnimationsWords(model: string): string {
  return `${model} animations`;
}

// ── files the chat names ──────────────────────────────────────────────────────────────────

/** A file link's words: what a click does, by how it opens (`shared/chat-files.ts`), and why it failed. */
export interface ChatFileWords {
  open: Readonly<Record<ChatFileOpen, string>>;
  /** Under the path of a file only the run's build has. */
  build: string;
  /** No app claimed the file, so the file manager shows it. */
  noApp: (label: string) => string;
}

const MAC_FILE_WORDS: ChatFileWords = {
  open: {
    [ChatFileOpen.Beside]: "Opens beside the chat",
    [ChatFileOpen.App]: "Opens in its default app",
    [ChatFileOpen.Folder]: "Opens in Finder",
    [ChatFileOpen.Finder]: "Shows in Finder",
  },
  build: "In the build · not in your game folder yet",
  noApp: (label) => `No app on this Mac opens ${label}, so it’s shown in Finder.`,
};

/** The same words where the file manager is File Explorer, or has no one name (Linux). */
const CHAT_FILE_WORDS: Readonly<Record<string, ChatFileWords>> = {
  [StudioPlatform.Mac]: MAC_FILE_WORDS,
  [StudioPlatform.Windows]: {
    ...MAC_FILE_WORDS,
    open: {
      ...MAC_FILE_WORDS.open,
      [ChatFileOpen.Folder]: "Opens in Explorer",
      [ChatFileOpen.Finder]: "Shows in Explorer",
    },
    noApp: (label) => `No app on this computer opens ${label}, so it’s shown in Explorer.`,
  },
  [StudioPlatform.Linux]: {
    ...MAC_FILE_WORDS,
    open: {
      ...MAC_FILE_WORDS.open,
      [ChatFileOpen.Folder]: "Opens the folder",
      [ChatFileOpen.Finder]: "Shows in its folder",
    },
    noApp: (label) => `No app on this computer opens ${label}, so its folder is shown.`,
  },
};

/** A file link's words on `platform` (`renderer/platform.ts`); macOS's until main has said. */
export function chatFileWords(platform: string): ChatFileWords {
  return CHAT_FILE_WORDS[platform] ?? MAC_FILE_WORDS;
}

// ── the sandbox setup screen ──────────────────────────────────────────────────────────────

/** "Set up the protected workspace": what the window says when the process sandbox cannot start. */
export const SANDBOX_SETUP_WORDS = {
  title: "Set up the protected workspace",
  intro: "Studio’s agents only run inside a protected workspace that keeps them away from your files and accounts.",
  /** Why it cannot start, by `SandboxProblemCode`. */
  why: {
    "missing-tools": "This computer is missing the programs it needs:",
    "unsupported-platform":
      "This system can’t run the protected workspace. Studio needs macOS, Windows, or Linux (not WSL 1).",
    "not-provisioned": "Windows needs a one-time setup of the protected workspace, approved by an administrator.",
    "git-missing":
      "Agents run their commands in Git Bash, which comes with Git for Windows. Install it from git-scm.com, then retry.",
    "isolation-blocked": "This system is blocking the isolation the protected workspace uses to keep agents apart.",
  } satisfies Record<SandboxProblemCode, string>,
  installThenRetry: "Install them in a terminal, then retry:",
  /** Isolation blocked by AppArmor: the profile only applies to a Studio started after it. */
  allowThenReopen: "Allow it for Studio in a terminal, then quit and reopen Studio:",
  /** Who the allow command is for. */
  allowFor: "Ubuntu 24.04 and later (AppArmor)",
  /** Who each install command is for, by `PackageManager`. */
  system: { apt: "Ubuntu, Debian", dnf: "Fedora" } satisfies Record<PackageManager, string>,
  copy: "Copy",
  copied: "Copied",
  copyCommand: (system: string) => `Copy the ${system} command`,
  retry: "Retry",
  retrying: "Checking…",
  /** Windows' first start, which sets the workspace up by itself behind one approval prompt. */
  windows: {
    settingUp: {
      title: "Setting up Genex",
      line: "Windows will ask you to allow this once. If it asks for a password, an administrator of this PC can enter theirs. Agents work in their own protected space, away from your files.",
      step: "Waiting for your OK",
    },
    needsOk: {
      title: "Genex needs your OK to set up",
      line: "Agents only run in a protected space that Windows has to allow once. If you aren’t an administrator of this PC, ask one to enter their password when Windows asks, then press Set up.",
      setUp: "Set up",
    },
    failed: {
      title: "Setup didn’t finish",
      line: "Windows wouldn’t start Genex’s protected space.",
      tryAgain: "Try again",
      report: "Send a report",
      sending: "Sending…",
      /** The bare ✓'s label, once the report went. */
      sent: "Report sent",
      reportFailed: "The report didn’t send. Try again in a moment.",
    },
    /** Windows' Secondary Logon service is disabled: agents start through it. */
    logonService: {
      line: "Secondary Logon is turned off on this PC. Set up turns it back on, since agents start through it.",
      fix: "Turn on Secondary Logon in Windows Services (Startup type: Manual), then try again.",
    },
  },
  /** A Windows window opened before the core: what the start is doing, by `StartStep`. */
  starting: {
    title: "Starting Genex",
    line: "Getting your games and the protected workspace ready.",
    step: {
      agents: "Preparing your agents",
      games: "Reading your games",
      workspace: "Starting the protected workspace",
      studio: "Opening the studio",
    } satisfies Record<StartStep, string>,
  },
  /** The studio's harness would not start: its error, Try again, a report and Quit. */
  startFailed: {
    title: "Genex couldn’t start",
    line: "The part of Genex that runs your agents didn’t start.",
    tryAgain: "Try again",
    quit: "Quit",
  },
  stillFailing: "Studio still couldn’t start:",
  details: "Details",
} as const;

// ── the Plugins tab ───────────────────────────────────────────────────────────────────────

/** The Plugins tab's lists, its Add menu and the Install from GitHub window. */
export const PLUGINS_WORDS = {
  intro: "Tools and connections for all your games.",
  back: "Back to workspace",
  add: {
    github: "Install from GitHub…",
    server: "Add MCP server…",
    create: "Create a plugin",
    local: "Load local plugin…",
  },
  /** A plugin's row in the composer's Add menu: its name opens its page, Settings shows under the pointer. */
  menuRow: {
    settings: "Settings",
    settingsLabel: (name: string) => `${name} settings`,
    /** The name's own label: it opens the same page as Settings. */
    openLabel: (name: string) => `Open ${name} settings`,
  },
  /** The catalog's plugins Genex makes, that you don't have. */
  ours: {
    title: "Plugins",
  },
  /** The catalog's plugins anyone else made, reviewed before they are listed. */
  community: {
    title: "Community plugins",
    by: "by",
    /** The publisher's GitHub name, a link to their profile. */
    profile: (login: string) => `Open ${login} on GitHub`,
  },
  /** A catalog plugin's page before it is installed: how to start, what it can do, where it comes from. */
  listing: {
    install: "Install",
    installLabel: (name: string) => `Install ${name}`,
    open: (name: string) => `Open ${name}`,
    steps: "How to start",
    installStep: "Install it. Genex shows what it can reach and asks you first.",
    connectStep: (name: string) => `Open ${name}'s page and connect your account or key.`,
    readyStep: "It turns on when installed: agents in all your games can use it from your next message.",
    installedStep: "Installed.",
    connectAccount: "Connect its account with the button above.",
    /** A tile's and a page's mark while the plugin waits on its person. */
    needsSetup: "Needs setup",
    developer: "Developer",
    source: "Source",
    guide: "Guide",
    category: "Category",
  },
  /** Community plugins while the catalog has none you don't have yet. */
  marketplace: {
    title: "Community plugins",
    soon: "Coming soon",
    text: "Anyone can make one. The first ones are on the way.",
  },
  /** The MCP servers section before anyone has added one. */
  servers: {
    emptyTitle: "Connect any MCP server",
    emptyText: "A command on this Mac, or a URL with browser sign-in. Agents in every game can use its tools.",
  },
  own: {
    title: "Make a community plugin",
    text: "Anyone can: one folder with a manifest, tools and panels, the same way Local Blender and Genex are made.",
    guide: "Read the guide",
  },
  /** A plugin row's account, by what it needs next. */
  account: {
    connect: "Connect",
    /** Genex's row: its account is the app's, signed in as everywhere else. */
    signIn: "Sign in",
    signInLabel: "Sign in to Genex in your browser",
    connectHint: "Uses your saved sign-in, or opens your browser",
    reconnect: "Reconnect",
    finishing: "Finish in your browser",
    cancel: "Cancel",
    credits: (count: string) => `${count} credits`,
    unlimited: "Unlimited credits",
  },
  /** A plugin's page: its skills in one line, its connections, and what it is and can do. */
  page: {
    skillsLine: (name: string) => `Instructions agents read when they use ${name}.`,
    showAll: "Show all",
    showFewer: "Show fewer",
    connections: "Connections",
    /** A connection with tools the person always allowed, and the button that takes it back. */
    alwaysAllowed: (tools: string) => `Runs without asking: ${tools}.`,
    askEveryTime: "Ask every time",
    ready: "Ready",
    off: "Off",
    connecting: "Connecting…",
    failed: "Couldn’t start",
    needsAccount: "Connect the account first",
    set: (label: string) => `Set ${label.charAt(0).toLocaleLowerCase()}${label.slice(1)}`,
    save: "Save",
    information: "Information",
    developer: "Developer",
    version: "Version",
    bundled: (version: string) => `${version} · bundled with Studio`,
    from: (version: string, source: string) => `${version} · ${source}`,
    can: "Can",
    nothing: "Nothing beyond its own tools",
    /** The folders outside your games its programs write to, each with why. */
    folders: "Folders",
    folder: (path: string, why: string) => `${path} — ${why}`,
    scan: "Code scan",
    trusted: "This plugin runs trusted code on your Mac.",
    /** A plugin loaded from a folder, in place of `trusted`. */
    localAccess:
      "Loaded from a folder on this Mac. It runs with your access: its code isn't sandboxed. Each of its tools asks you before an agent runs it; its own steps at Genex's moments don't ask.",
  },
  /** What a plugin may do, in words, by `PluginCapability`; joined in this order on its page. */
  can: {
    credentials: (publisher: string) => `use your ${publisher} account`,
    "native-runtime": (runtimes: string) => `run ${runtimes}`,
    observe: "see the running game",
    network: "reach the internet",
    "external-auth": "open sign-in in your browser",
    jobs: "run background jobs",
    "project.read": "read files in your games",
    "project.write": "write files in your games",
    readWrite: "read and write files in your games",
    settings: "keep its own settings",
    export: "export games",
  },
  /** Local Blender's setup card and what it does. */
  blender: {
    card: "Blender",
    ready: (version: string) => `Blender ${version} is ready`,
    checkAgain: "Check again",
    missingTitle: "Blender isn’t installed",
    missingText: (version: string, size: string) =>
      `Download Blender ${version} (about ${size}) for Studio. A Blender you installed yourself stays as it is.`,
    oldTitle: (version: string) => `Blender ${version} is too old`,
    oldText: (version: string, size: string) =>
      `Download Blender ${version} (about ${size}) for Studio. The Blender you have stays as it is.`,
    failedTitle: "Blender couldn’t start",
    download: "Download Blender",
    downloading: (version: string) => `Downloading Blender ${version}`,
    installing: (version: string) => `Installing Blender ${version}`,
    progress: (done: string, total: string) => `${done} of ${total}`,
    cancel: "Cancel",
    checking: "Checking Blender…",
    doesTitle: "What it does",
    doesIntro: "Agents use it when a game needs a model and you haven’t asked for Genex.",
    model: { title: "Model from a script", text: "A GLB for the game plus reference renders to check it." },
    change: { title: "Change a model", text: "Reshape or clean up a GLB already in your game. The original stays." },
  },
  github: {
    title: "Install from GitHub",
    intro: "Paste the link to a plugin’s GitHub page. Studio finds the plugin and its latest release.",
    field: "GitHub link",
    placeholder: "github.com/owner/plugin",
    continue: "Continue",
    looking: "Looking…",
    cancel: "Cancel",
    install: "Install…",
    installing: "Installing…",
    by: (owner: string) => `by ${owner}`,
    version: "Version",
    change: "Change",
    changeLabel: "Choose another version",
    versionsLoading: "Loading versions…",
    versionsFailed: "Couldn’t load other versions.",
    latestRelease: (date: string) => (date ? `latest release, ${date}` : "latest release"),
    newestOn: (branch: string) => `Newest code on ${branch}`,
    commit: (short: string) => `Commit ${short}`,
    next: "Next, Studio checks the code and shows what the plugin can do. Nothing is installed until you agree.",
    noRelease:
      "This plugin has no releases, so Studio takes the newest code. It stays as installed until you update it.",
    choose: (count: number) => `This repository has ${count} plugins. Choose one.`,
    guide: "How to make a plugin",
    /** Why a link found no plugin, and what to try, by `GithubLookupProblem`. */
    problem: {
      "not-a-link": ["That isn’t a link to a GitHub repository.", "Paste a link like github.com/owner/plugin."],
      "not-found": ["Couldn’t find that on GitHub.", "Check the link. Private repositories can’t be installed."],
      "no-plugin": [
        "There’s no plugin here: this repository has no plugin.json.",
        "If the plugin is in a folder, open that folder on GitHub and paste its link.",
      ],
      "invalid-plugin": ["This plugin’s plugin.json can’t be used.", ""],
      "rate-limited": ["GitHub is limiting requests from this network.", "Try again in a few minutes."],
    } satisfies Record<GithubLookupProblem, readonly [string, string]>,
  },
} as const;

// ── Plan mode in the composer ─────────────────────────────────────────────────────────────

/** Add's Plan mode: its row and the bulb that shows it, in Codex's words. */
export const PLAN_MODE_WORDS = {
  label: "Plan mode",
  turnOn: "Turn plan mode on",
  turnOff: "Turn plan mode off",
  duringBuild: "Not while a build owns the chat",
} as const;

// ── the Skills tab ────────────────────────────────────────────────────────────────────────

/** The Skills tab's section titles, the lines under them, and what a plugin's switch applies to. */
export const SKILLS_WORDS = {
  studioTitle: "Studio skills",
  studioIntro: "Used by local chat, the run planner and the director.",
  gameTitle: "This game",
  gameIntro: "In this game’s folder. Workers load them from there.",
  gameEmpty: "This game has no skills of its own.",
  providerTitle: (label: string) => `${label} · Global skills`,
  /** Whether a provider's global skills reach Studio's builders, by `ProviderBuilderUse`. */
  builders: {
    "not-loaded": "Installed on this Mac. Studio’s workers don’t load them.",
    "studio-profile": "From Studio’s own Codex profile, which workers use.",
    "borrowed-login": "From your own Codex setup. Workers use your Codex login, so they load these too.",
    "no-login": "Codex isn’t signed in, so no worker loads these yet.",
  } satisfies Record<ProviderBuilderUse, string>,
  pluginsTitle: "Plugin skills",
  onDemand: "Read by agents on demand",
  /** What the last update or reload did to a plugin's skills, by name. */
  changed: { added: "Added", changed: "Changed", removed: "Removed" },
  lastChange: "Last update",
  loadingFile: "Reading the skill…",
  /** The hint beside a plugin's switch in the Add menu: turning it off turns it off everywhere. */
  allGames: "All games",
} as const;

// ── commands a reply offers ───────────────────────────────────────────────────────────────

/** A command block's icon actions and how its run is going, by `CommandState`. */
export const COMMAND_WORDS = {
  run: "Run in terminal",
  runAgain: "Run again",
  stop: "Stop",
  copy: "Copy command",
  copied: "Copied",
  openTerminal: "Open in terminal",
  showAll: "Show all output",
  showLess: "Show less output",
  state: {
    running: "Running…",
    stopping: "Stopping…",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
    broken: "Couldn’t run",
  } satisfies Record<CommandState, string>,
  exitCode: (code: number) => `exit ${code}`,
} as const;

/**
 * What the chat tells the agent, as the user, when a command they ran from its reply ends: the
 * command, how it ended, and the last lines it printed. Plain text, because it is a user message.
 */
export function commandResultWords(command: string, session: { exitCode?: number; output?: string[] }): string {
  const code = session.exitCode ?? 1;
  const ended = code === 0 ? `It finished (exit code 0).` : `It failed (exit code ${code}).`;
  const output = session.output ?? [];
  const tail = output.length ? `The last lines it printed:\n${output.join("\n")}` : "It printed nothing.";
  return `I ran this in the terminal:\n${command}\n\n${ended} ${tail}`;
}

/** What the chat tells the agent, unseen, when the person turned on the plugin it suggested. */
export const pluginTurnedOnWords = (name: string): string =>
  `I turned on the ${name} plugin from your card. Go on with what I asked.`;

// ── Genex plugin ───────────────────────────────────────────────────────────────────────────

/** The Genex promo after the welcome, the Genex plugin page and its generations. */
export const GENEX_WORDS = {
  promo: {
    label: "Genex plugin",
    eyebrow: "Featured Genex plugin",
    title: "Generate game assets in chat",
    models: { title: "3D models and characters", text: "Rigged, animated and ready for your game." },
    media: { title: "Sound, music and art", text: "Effects, soundtracks, voices and textures." },
    publish: { title: "Publish with a playable link", text: "Anyone can play it in their browser." },
    learnMore: "Learn more",
    learnMoreLabel: "Learn more about the Genex plugin",
    linkCopied: "Link copied",
    connect: "Connect Genex plugin",
    waiting: "Finish in your browser",
    cancel: "Cancel",
    failed: "Sign-in didn’t finish.",
    retry: "Try again",
    connectedTitle: "Genex is connected",
    connectedText: "Ask for a model, a sound or a texture in any game chat.",
    done: "Done",
    dismiss: "Close",
  },
  account: {
    /** The Connect band, for assistive tech: the account, or the plugin while it is off. */
    label: "Genex account",
    offLabel: "Connect Genex",
    /** The Connect band's offer, with the plugin off or its account not yet connected. */
    offerTitle: "The best game dev tools, in one click",
    offerText: "Extend your agent with up-to-date tools for 3D, textures, sound and video. Always optional.",
    retryTitle: "Reconnect your Genex account",
    retryText: "Your saved sign-in couldn’t be opened on this Mac. Sign in again in your browser.",
    /** Connect turns the plugin on and signs in to Genex: the saved sign-in, or the browser. */
    connect: "Connect",
    retry: "Reconnect",
    signingInTitle: "Finish signing in in your browser",
    /** The code beside it in the Publish dialog. */
    browserShows: "Your browser should show",
    reopen: "Open sign-in again",
    /** Connect, busy: before the browser opens, then while it is open. */
    connecting: "Connecting…",
    waitingBrowser: "Waiting for browser…",
    cancel: "Cancel",
    termsTitle: "Accept the updated Genex terms",
    termsText: "Review them in your browser to keep generating.",
    terms: "Review terms",
    loading: "Loading your Genex account…",
    checking: "Checking your Genex account…",
    attentionTitle: "Couldn’t check your Genex account",
    tryAgain: "Try again",
    connected: "Connected",
    disconnect: "Disconnect",
    unlimited: "Unlimited",
    outOfCredits: "Games still build with procedural assets and Local Blender.",
    paused: (kinds: string) => `Paused on Genex right now: ${kinds}.`,
  },
  /** Genex as the Plugins page shows it: the router, its line, and the tools it routes. */
  router: {
    name: "Genex plugin",
    description: "Game dev tools router",
    /** Genex's row line, on and off: what the switch takes away (the agent's tools) and what it never does. */
    rowOn: {
      lead: "Tools for your agent: 3D, textures, animation, music, multiplayer.",
      tail: "Uses your Genex account.",
    },
    rowOff: { lead: "Off. Your agent can't use Genex tools.", tail: "Your profile, friends and Publish stay." },
    /** The line under the plugin page's title while an account is connected. */
    connectedAs: (name: string) => `Game dev tools router · connected as ${name}`,
    toolsTitle: "Tools it routes",
    toolsIntro:
      "Ask in any game chat. Genex picks the tool, runs it on your balance and saves the file in your game. No accounts or keys of your own.",
    /** Each routed tool's name and what it does, by `GenexTool`. */
    tools: {
      tripo: { name: "Tripo", short: "Tripo", line: "3D · rig · animate" },
      meshy: { name: "Meshy", short: "Meshy", line: "3D · characters" },
      uthana: { name: "Uthana", short: "Uthana", line: "Rigging · animation" },
      "gpt-image": { name: "GPT Image 2.5", short: "GPT Image", line: "Images · sprites" },
      "nano-banana": { name: "Nano Banana 2", short: "Nano Banana", line: "Textures" },
      minimax: { name: "MiniMax H3 Max Turbo", short: "MiniMax", line: "Video" },
      blender: { name: "Blender", short: "Blender", line: "Scenes · blockouts" },
      elevenlabs: { name: "ElevenLabs", short: "ElevenLabs", line: "SFX · music · voice" },
      publishing: { name: "Genex", short: "Genex", line: "Publishing" },
    },
  },
  /** The Genex plugin page's tabs. */
  tabs: { label: "Genex plugin", tools: "Tools", credits: "Credits" },
  /** The Credits tab: the balance, what credits pay for (live prices), that building is free, and recent spends. */
  creditsTab: {
    label: "Genex plugin, Credits",
    unit: (count: number) => (count === 1 ? "credit" : "credits"),
    unlimited: "Unlimited credits",
    /** The balance genex.games couldn't give: a dash, and why. */
    noBalance: "—",
    balanceUnread: "balance couldn’t be read",
    /** What an invite earns, beside Invite a friend. */
    bonus: (credits: number) => `+${credits}`,
    plan: (allowance: string, when: string) => `Pro · ${allowance} more on ${when}`,
    inviteFriend: "Invite a friend",
    getCredits: "Get credits",
    payFor: "What credits pay for",
    /** Beside the tools' marks, over the prices. */
    toolsLine:
      "The best game dev tools, always up to date. No MCPs or API keys to install: they’re connected in one click.",
    from: "from",
    pricesUnavailable: "Prices couldn’t be read from genex.games right now.",
    recent: "Recent spending",
    recentLine: "Your latest generations and refunds",
    /** What a credit is worth, beside Recent spending's line; it wraps as one piece. */
    perCredit: "1\u00a0credit\u00a0≈\u00a01¢",
    noRecent: "Nothing spent yet",
    refunded: (count: number) => `+${count}`,
    refundedNote: "refunded",
    failedKind: (kind: string) => `${kind}, failed`,
    spent: (count: number) => `−${Math.abs(count)}`,
    loading: "Reading your credits…",
    failed: "Couldn’t read your credits.",
    signedOut: "Sign in to Genex to see your credits.",
    /** Each kind of generation and the tool Genex routes it to. */
    kinds: {
      [CreditKind.Model]: { name: "3D model", tool: "Tripo" },
      [CreditKind.Character]: { name: "Rigged character", tool: "Meshy" },
      [CreditKind.ModelAnimation]: { name: "Animation clip", tool: "Tripo · Uthana" },
      [CreditKind.Image]: { name: "Image or sprite", tool: "GPT Image" },
      [CreditKind.Texture]: { name: "Texture set", tool: "Nano Banana" },
      [CreditKind.Video]: { name: "Video, 5 s", tool: "MiniMax" },
      [CreditKind.Music]: { name: "Music track", tool: "ElevenLabs" },
      [CreditKind.Sound]: { name: "Sound effect", tool: "ElevenLabs" },
      [CreditKind.Voice]: { name: "Voice line", tool: "ElevenLabs" },
      [CreditKind.ModelRig]: { name: "Rig a model", tool: "Tripo" },
      [CreditKind.CoverRegenerate]: { name: "New cover", tool: "Genex" },
    } satisfies Record<CreditKind, { name: string; tool: string }>,
    otherKind: "Generation",
  },
  /**
   * The stage strip's Multiplayer, left of Publish: one press asks the game's chat to make it
   * multiplayer with Genex; without the plugin it opens the setup dialog, in Publish's words.
   */
  multiplayer: {
    button: "Make multiplayer",
    buttonLabel: "Make this game multiplayer",
    hint: "Make this game multiplayer with Genex",
    /** What the press sends to the game's chat. */
    prompt: "Make this game multiplayer using Genex",
    title: "Make it multiplayer",
    intro: "Friends join your game from anywhere. Genex runs the rooms, the voices and the sign-in.",
    rooms: "Online rooms",
    voice: "Voice chat",
    economy: "In-game economy",
    /** Setup's line while the plugin is off, around its name: the agent builds multiplayer with its tools. */
    through: "Your agent builds multiplayer with the",
  },
  /** The Publish dialog on the game's stage, drawn by Studio. */
  publish: {
    title: "Publish your game",
    /** The line under Publish. */
    intro: "Anyone with the link can play it.",
    /** The stage strip's own Publish, when Genex adds none: the words of Genex's button. */
    button: "Publish",
    buttonLabel: "Publish game",
    /** The name on the banner: what the game is listed under, and what players see. */
    name: "Name players will see",
    rename: "Rename the game",
    /** The banner's chip: where the game is. */
    chipNone: "Not published",
    chipLive: (when: string) => (when === "now" ? "Live · just now" : `Live · ${when} ago`),
    chipLiveUndated: "Live",
    chipFailed: "Didn't publish",
    publish: "Publish",
    /** The main press before the game is public: what Publish does, in a word more. */
    publishToWeb: "Publish to the web",
    publishing: "Publishing…",
    updatePublic: "Publish update",
    tryAgain: "Try again",
    publishAgain: "Publish again",
    openGame: "Open",
    openGameLabel: "Open the game on Genex",
    copyLink: "Copy",
    copyLinkLabel: "Copy the game's link",
    copied: "Copied",
    /** The public link's label in the dialog, beside the globe. */
    publicLink: "Public:",
    /** The tested draft, while players do not have it yet: its label, its Copy, and the line under it. */
    testLink: "Test link:",
    copyTestLinkLabel: "Copy the test link",
    testBefore: "Friends can play it before you publish.",
    testChanges: "Try your changes before you update.",
    /** Added for a multiplayer game: a second identity is all testing alone needs. */
    testSecondPlayer: "Open it in a private window to join as another player.",
    /** Under the busy button: closing the dialog does not stop it. */
    keepsGoing: "You can close this. It keeps going.",
    /** Under the busy button, once the test runs longer than usual. */
    slow: "Taking longer than usual.",
    /** After the name on the banner, the one moment an attempt the dialog watched goes live. */
    isLive: "is live!",
    /** The press that lists a game renamed right after it went live under its new name. */
    saveName: "Save name",
    replay: "Play the celebration again",
    /** The banner's cover controls: ask for another, say what it should show, flip through the recent ones. */
    anotherCover: "Another cover",
    anotherCoverLabel: "Make another cover",
    coverWantLabel: "What the new cover should show",
    coverWantPlaceholder: "What should it show? Or leave it empty",
    coverMake: "Make",
    coverKeep: "Keep this cover",
    coverPrevious: "Previous cover",
    coverNext: "Next cover",
    coverOf: (at: number, of: number) => `Cover ${at} of ${of}`,
    /** While Studio or the agent is making a cover: the banner's busy pill. */
    coverTaking: "Taking a cover",
    coverMaking: "New cover",
    coverMakingSoon: "The new one shows here when it’s ready.",
    /** What Another cover sends in the game's chat, with what the person typed. */
    coverAnotherPrompt: (want: string) =>
      want
        ? `Make another Genex cover for this game: ${want}`
        : "Make another Genex cover for this game: a different moment.",
    /** The banner's switch between the cover and its clip, and the clip's own Another. */
    coverShow: "Show",
    coverPicture: "Picture",
    coverClip: "Clip",
    anotherClip: "Another clip",
    anotherClipLabel: "Make another clip",
    coverAnotherClipPrompt: (want: string) =>
      want
        ? `Make another Genex clip for this game: ${want}`
        : "Make another Genex clip for this game: a different moment.",
    /** The chat's card for the cover a builder kept: its caption, its picture's name, and Publish, which opens this dialog. */
    coverCard: "Genex cover",
    coverCardAlt: "This game's Genex cover",
    coverCardPublishLabel: "Publish this game",
    coverCardAnother: "Another",
    /** The card's mark that the cover comes with a clip, and its length. */
    coverCardClip: (ms: number) => `0:${String(Math.round(ms / 1000)).padStart(2, "0")}`,
    /** A failed attempt's one line under the banner. */
    failedText: "Nothing changed. Try again in a moment.",
    failedKept: "The last version is still live.",
    sendReport: "Send report",
    sendReportLabel: "Send this problem and the app's logs to the Genex team",
    reportSent: "Report sent",
    reportFailed: "Couldn't send. Try again",
    /** What Send report posts: the game and the raw reason. */
    reportText: (title: string, project: string, details: string) =>
      `Publishing "${title}" (${project}) didn't work.\n\n${details}`,
    reviewTerms: "Review Genex terms",
    termsNote: "Review the updated Genex terms in your browser before publishing.",
    /** With no account: why to sign in, under the account card. */
    signInText: "Your games go on your Genex profile. Sign in to publish.",
    /** Multiplayer's setup line ends, around the plugin's name; its button says what is missing. */
    throughEnd: ". Turn it on to continue.",
    installEnd: ". Install it to continue.",
    plugin: "Genex plugin",
    pluginPage: "Open the Genex plugin page",
    turnOn: "Turn on Genex plugin",
    turningOn: "Turning on…",
    install: "Install Genex plugin",
    installing: "Installing…",
    stillWorking: "Still working — Studio hasn’t answered yet.",
    progress: "Publish progress",
    /** The busy button once the test runs longer than usual, or the outcome is not known yet. */
    stillTesting: "Still testing",
    /** What the running step is doing, by `GenexPublishPhase`: the busy button's words. */
    phase: {
      checking: "Preparing",
      exporting: "Preparing",
      "creating-project": "Preparing",
      uploading: "Uploading",
      promoting: "Going live",
      listing: "Going live",
      done: "Finished",
      "verifying-deployment": "Testing",
      ready: "Ready to play",
      failed: "Didn't publish",
      unresolved: "Still testing",
    } satisfies Record<GenexPublishPhase, string>,
    /** The steps under the progress bar, by `GenexPublishStep`. */
    step: {
      prepare: "Prepare",
      upload: "Upload",
      test: "Test",
      live: "Go live",
    },
  },
  /** The usage panel's Genex block: the balance every game shares, and this game's spend under it. */
  usage: {
    title: "Genex credits",
    thisGame: "Used in this game",
    unlimited: "Unlimited",
  },
  /** The open game's generations that wait for the person's review. */
  review: {
    title: "Waiting for your review",
    button: (candidate: number | null) => (candidate === null ? "Review remesh" : `Review candidate ${candidate}`),
    /** A candidate's picture above its Review button. */
    picture: (candidate: number) => `Candidate ${candidate}`,
  },
  /** A generation's state, by `JobState`. */
  state: {
    working: "Generating",
    review: "Waiting for you",
    ready: "Ready",
    "in-game": "In your game",
    failed: "Failed",
    stopped: "Stopped",
    unsure: "Not confirmed",
  } satisfies Record<JobState, string>,
  credits: (count: number) => plural(count, "credit"),
  refunded: "Refunded",
} as const;

/** Settings → Licenses: the shipped license texts (`panels/LicensesDialog.tsx`). */
export const LICENSE_WORDS = {
  link: "MIT License",
  title: "Licenses",
  intro:
    "Genex is open source under the MIT License. It also includes software from other projects, each under its own license.",
  loading: "Loading…",
  missing: "This build of Genex doesn’t include its license files.",
} as const;

/** Settings → Privacy: Share build metrics (`panels/PrivacySection.tsx`). PRIVACY.md says the same things. */
export const PRIVACY_WORDS = {
  tab: "Privacy",
  loading: "Loading…",
  share: "Share build metrics",
  shareWhat:
    "After each finished build, send anonymous numbers: times, token counts, the model and whether it worked. Never your prompts, code, files or game names.",
  paused: "Sharing is paused on the Genex side. Nothing is sent until it resumes.",
  notSent: "This is a developer or test launch of Genex: nothing is sent from it.",
  queued: (count: number) => `${plural(count, "row")} waiting to be sent.`,
  removed: "This build of Genex has build metrics sharing removed.",
  preview: "See what would be sent",
  hidePreview: "Hide what would be sent",
  previewWhat: "The exact row a finished build becomes, anonymous id included.",
  previewEmpty: "Nothing yet. Finish a build and its row appears here.",
  delete: "Delete what I shared",
  deleteWhat: "Removes every row sent from this computer. Later rows use a new anonymous id.",
  deleteAsk: "Delete every row shared from this computer?",
  deleteConfirm: "Delete",
  deleteCancel: "Cancel",
  deleting: "Deleting…",
  deleted: (count: number) => `Deleted ${plural(count, "row")}.`,
  deletePaused: "Genex couldn’t take the deletion right now. Nothing was deleted; try again later.",
  deleteFailed: "Couldn’t reach Genex. Nothing was deleted; try again later.",
  deletePartial: (count: number) =>
    `Deleted ${plural(count, "row")}, but Genex couldn’t finish. Try again later to remove the rest.`,
  deleteNotSent: "Nothing was ever sent from this launch.",
  /** The quiet line of links under the rows; each opens in the browser. */
  links: {
    policy: "Privacy Policy",
    terms: "Terms of Service",
  },
} as const;

/** What a finished Delete what I shared says; a stop after earlier ids' rows were removed says how many. */
export function privacyDeleteWords(result: RunSharingDeleteResult): string {
  const stopped =
    result.outcome === RunSharingDeleteOutcome.Failed || result.outcome === RunSharingDeleteOutcome.Paused;
  if (stopped && result.deleted > 0) return PRIVACY_WORDS.deletePartial(result.deleted);
  const words: Record<RunSharingDeleteOutcome, string> = {
    [RunSharingDeleteOutcome.Deleted]: PRIVACY_WORDS.deleted(result.deleted),
    [RunSharingDeleteOutcome.Paused]: PRIVACY_WORDS.deletePaused,
    [RunSharingDeleteOutcome.Failed]: PRIVACY_WORDS.deleteFailed,
    [RunSharingDeleteOutcome.NotSent]: PRIVACY_WORDS.deleteNotSent,
  };
  return words[result.outcome];
}

/** Play: the genex.games catalog inside the app, its sidebar and its Genex card. */
export const PLAY_WORDS = {
  /** The Genex account at the sidebar's foot, profiles and the Friends page. */
  people: {
    friends: "Friends",
    friendsLabel: (waiting: number) => (waiting > 0 ? `Friends, ${waiting} waiting` : "Friends"),
    plateLabel: (name: string) => `${name}, Genex account`,
    pro: "Pro",
    proTag: "PRO",
    menuLabel: "Genex account",
    profile: "Profile",
    credits: "Credits",
    creditsUnlimited: "Unlimited",
    /** The credits beside the plate's name: "1,700 credits, open Credits". */
    creditsLabel: (amount: string) => `${amount} credits, open Credits`,
    accountSettings: "Account settings",
    signOut: "Sign out",
    /** The plate while signed out, signing in, offline, and once genex.games ended the sign-in. */
    signIn: "Sign in to Genex",
    signInLabel: "Sign in to Genex in your browser",
    finishInBrowser: "Finish in browser",
    finishInBrowserLabel: "Finish signing in to Genex in your browser",
    cancelSignIn: "Cancel signing in",
    signInAgain: "Sign in again",
    signInAgainLabel: (name: string | null) => (name ? `${name}: sign in to Genex again` : "Sign in to Genex again"),
    signInFailed: "Couldn’t start signing in. Check your connection and try again.",
    cancelFailed: "Couldn’t stop signing in. Try again in a moment.",
    offlineFriends: "Offline: friends’ games and credits update when you’re back online",
    /** Sign out's question, asked in Studio before the app and the Genex plugin sign out together. */
    signOutTitle: "Sign out of Genex?",
    signOutText: "Your profile, friends and Publish wait until you sign in again, and the Genex plugin’s tools stop.",
    signOutFailed: "Couldn’t sign out. Try again in a moment.",
    back: "Back",
    joined: (when: string) => `Joined ${when}`,
    /** What a friend card says when they are not playing: how many games they made. */
    games: (count: number) => {
      if (count === 0) return "No games yet";
      return count === 1 ? "1 game" : `${count} games`;
    },
    /** A profile's chips: the number bold, then its noun. */
    chipGames: (count: number) => (count === 1 ? "game" : "games"),
    chipPlayers: (count: number) => (count === 1 ? "player" : "players"),
    chipPlays: (count: number) => (count === 1 ? "play" : "plays"),
    since: (when: string) => `since ${when}`,
    editProfile: "Edit profile",
    myGames: "My games",
    gamesBy: (name: string) => `Games by ${name}`,
    noGames: "No published games yet.",
    noGamesOwn: "Games you publish show up here.",
    profileFailed: "Couldn’t load this profile.",
    friendsOf: (name: string) => `${name}’s friends`,
    previous: "Previous",
    next: "Next",
    previousOf: (what: string) => `Previous ${what.toLowerCase()}`,
    nextOf: (what: string) => `Next ${what.toLowerCase()}`,
    openProfile: (name: string) => `Open ${name}’s profile`,
    playingLabel: (name: string, game: string) => `${name}, playing ${game}`,
    /** A person's tile read aloud: their name, then its line. */
    tileLabel: (name: string, line: string) => `${name}, ${line}`,
    nameLabel: "Name",
    nameHint: "Same name everywhere on Genex.",
    nameRule: "2 to 20 characters.",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    pictureFailed: "Couldn’t use that picture. Try a PNG or JPEG.",
    renameFailed: "Couldn’t change your name.",
    add: "Add friend",
    sent: "Request sent",
    cancelRequest: (name: string) => `Cancel your request to ${name}`,
    accept: "Accept",
    acceptRequest: "Accept request",
    decline: (name: string) => `Decline ${name}`,
    isFriend: "Friends",
    remove: "Remove friend",
    more: (name: string) => `More for ${name}`,
    actionFailed: "Genex didn’t take that. Try again in a moment.",
    findLabel: "Find people by name",
    find: "Find people by name",
    searching: "Searching…",
    nobody: (query: string) => `Nobody named “${query}”.`,
    searchUnavailable: "Finding people by name isn’t on Genex yet. Send your link instead.",
    searchFailed: "Couldn’t search. Check your connection and try again.",
    found: "People",
    requests: "Requests",
    wantsToBeFriends: "Wants to be friends",
    playingNow: "Playing now",
    allFriends: "Friends",
    sentRequests: "Sent",
    join: "Join",
    joinLabel: (name: string, game: string) => `Join ${name} in ${game}`,
    invite: "Invite a friend",
    inviteFriends: "Invite friends",
    /** What an invite does, and what it earns while genex.games says (never a number typed here). */
    inviteText: (bonus: number | null) =>
      bonus === null
        ? "They get the Genex download page with a card from you."
        : `They get the Genex download page with a card from you. You get ${bonus} credits when they make their first game.`,
    inviteBonus: (credits: number) => `+${credits}`,
    inviteBonusLabel: (credits: number) => `${credits} credits for you when a friend starts creating`,
    inviteLinkLabel: "Your invite link",
    copy: "Copy",
    copied: "Copied",
    /** Post on X and the Mac's share menu, under an invite link or a profile link. */
    postOnX: "Post on X",
    shareMenu: "Share…",
    shareMenuLabel: "Share the link with Messages, Mail, AirDrop and more",
    /** What a post on X says with the link. */
    inviteXText: "Join me on Genex",
    profileXText: "My games on Genex",
    /** Share, beside the pencil on the account's own profile. */
    shareProfile: "Share profile",
    shareProfileTitle: "Share your profile",
    shareProfileLink: "Your profile link",
    /** The link preview's picture, read aloud. */
    sharePreviewLabel: "How your profile link looks when shared",
    showPlaying: "Show friends what I’m playing",
    showPlayingOff: "Off: friends see your name only.",
    empty: "No friends yet — send your link and play together.",
    or: "or",
    friendsFailed: "Couldn’t load your friends.",
    signedOut: "Sign in to Genex to see your friends.",
    /** Under Friends while offline, where Playing now was. */
    playingOffline: "Who’s playing shows again when you’re back online.",
  },
  /** The account's own numbers: the profile's strip and the stats page. Only the account sees them. */
  stats: {
    lastDays: (days: number) => `Last ${days} days`,
    sectionLabel: "My stats",
    plays: (count: number) => (count === 1 ? "play" : "plays"),
    players: (count: number) => (count === 1 ? "player" : "players"),
    playingNow: "playing now",
    more: "More",
    startFirst: "Your stats start with your first game",
    createGame: "Create a game",
    copyLink: (title: string) => `Copy the ${title} link`,
    linkCopied: "Link copied",
    newChange: "New",
    noChange: "—",
    up: (percent: number) => `+${percent}%`,
    down: (percent: number) => `−${Math.abs(percent)}%`,
    upLabel: (percent: number) => `up ${percent}%`,
    downLabel: (percent: number) => `down ${Math.abs(percent)}%`,
    newLabel: "new: nothing before to compare",
    title: "Stats",
    onlyYou: "only you see these",
    periodLabel: "Period",
    period: (days: number) => `${days} days`,
    playsTile: "Plays",
    playersTile: "Players",
    playingNowTile: "Playing now",
    gamesTile: "Games",
    vsPrevious: (days: number) => `vs previous ${days} days`,
    liveIn: (game: string, others: number) => (others > 0 ? `in ${game} and ${others} more` : `in ${game}`),
    nobodyNow: "nobody right now",
    thisMonth: "this month",
    addedThisMonth: (count: number) => `+${count}`,
    chartTitle: "Plays per day",
    chartLabel: (days: number) => `Plays per day over the last ${days} days`,
    tooltip: (count: string) => `${count} plays`,
    tableLabel: "My games",
    gameColumn: "Game",
    playsColumn: "Plays",
    playersColumn: "Players",
    dayByDayColumn: "Day by day",
    changeColumn: "Change",
    /** The strip's label while genex.games has no daily stats: the plays in total. */
    inTotal: "In total",
    unavailable: "Daily stats arrive with the next genex.games update. Until then, your games’ plays in total.",
    failed: "Couldn’t load your stats.",
    signedOut: "Sign in to Genex to see your game stats.",
    backToProfile: "Profile",
  },
  /** Play's Top creators row, at the top of Games. */
  creators: {
    title: "Top creators",
    /** Beside the title: the rolling 30 days the ranking covers. */
    period: "this month",
    line: (games: number, hours: string) => `${games === 1 ? "1 game" : `${games} games`} · ${hours} h`,
  },
  modes: { label: "Mode", play: "Play", create: "Create" },
  recent: "Recent",
  page: "Play",
  shelvesLabel: "Shelves",
  shelves: {
    [PlayShelf.Games]: "Games",
    [PlayShelf.Tools]: "Tools",
    [PlayShelf.Assets]: "Assets",
  } satisfies Record<PlayShelf, string>,
  /** What a shelf holds, as its messages name it. */
  nouns: {
    [PlayShelf.Games]: "games",
    [PlayShelf.Tools]: "tools",
    [PlayShelf.Assets]: "assets",
  } satisfies Record<PlayShelf, string>,
  categoriesLabel: "Categories",
  categories: {
    [PlayCategory.Featured]: "Featured",
    [PlayCategory.Arcade]: "Arcade",
    [PlayCategory.Shooter]: "Shooter",
    [PlayCategory.Racing]: "Racing",
    [PlayCategory.Sports]: "Sports",
    [PlayCategory.Survival]: "Survival",
    [PlayCategory.Exploration]: "Exploration",
    [PlayCategory.Multiplayer]: "Multiplayer",
    [PlayCategory.Fighting]: "Fighting",
    [PlayCategory.Tools]: "All",
    [PlayCategory.Physics]: "Physics",
    [PlayCategory.Terrain]: "Terrain",
    [PlayCategory.Lighting]: "Lighting",
    [PlayCategory.Vfx]: "VFX",
    [PlayCategory.Assets]: "All",
  } satisfies Record<PlayCategory, string>,
  search: (noun: string) => `Search ${noun}`,
  searchLabel: "Search Play",
  play: (title: string) => `Play ${title}`,
  by: (author: string) => `By ${author}`,
  plays: (count: string) => `${count} plays`,
  online: (count: number) => `${count} playing now`,
  /** The top row's one control over the cover clips: its name, and its tooltip while paused. */
  clips: { pause: "Pause previews", play: "Play previews" },
  remix: "Remix",
  remixing: "Remixing…",
  remixLabel: (title: string) => `Remix ${title}`,
  remixFailed: "Couldn’t make a copy of that game.",
  /** Create while a remix is made (`RemixLayer`): the step bar's names, the line under the loader. */
  making: {
    steps: {
      [RemixStep.Copy]: "Files",
      [RemixStep.Models]: "Models",
      [RemixStep.Packages]: "Packages",
      [RemixStep.Build]: "Build",
    } satisfies Record<RemixStep, string>,
    line: {
      [RemixStep.Copy]: "Copying files",
      [RemixStep.Models]: "Downloading models",
      [RemixStep.Packages]: "Installing packages",
      [RemixStep.Build]: "Building the game",
    } satisfies Record<RemixStep, string>,
    measured: (line: string, bytes: string) => `${line} · ${bytes}`,
    megabytes: (done: number) => `${done} MB`,
    megabytesOf: (done: number, total: number) => `${done} of ${total} MB`,
    progress: "Remix progress",
    row: "Making your remix",
    chat: (title: string) => `Remixing ${title}`,
    /** A remix finished while the person was elsewhere: its game is in the sidebar. */
    ready: (title: string) => `${title} is ready`,
  },
  loading: (noun: string) => `Loading ${noun}…`,
  loadingMore: "Loading more…",
  failed: (noun: string) => `Couldn’t load ${noun}. Check your connection and try again.`,
  retry: "Try again",
  empty: (noun: string) => `No ${noun} here yet.`,
  noMatches: (query: string, noun: string) => `No ${noun} match “${query}”.`,
  moreFailed: (noun: string) => `Couldn’t load more ${noun}.`,
  /** No network: what the dashboard, its search and the viewer say, each coming back by itself. */
  offline: {
    chip: "Offline",
    title: "You’re offline",
    shelf: (things: string) => `${things} load as soon as you’re back online.`,
    search: "Search works again as soon as you’re back online.",
    profile: "This profile loads as soon as you’re back online.",
    more: (noun: string) => `More ${noun} load when you’re back online.`,
    game: (title: string) => `${title} opens as soon as you’re back online.`,
  },
  viewer: {
    loading: (title: string) => `Loading ${title}…`,
    failedTitle: (title: string) => `Couldn’t load ${title}`,
    failedText: "Check your connection, then try again.",
    retry: "Try again",
    back: "Back to Play",
  },
  /** The viewer's header across the window's top. */
  bar: {
    label: (title: string) => `${title}: game controls`,
    back: "Back to Play",
    like: "Like",
    likes: (count: string) => `Like, ${count} likes`,
    share: "Share",
    invite: "Invite a friend",
    remix: "Remix",
    exit: "Exit",
    playing: (count: number) => `${count} playing`,
    plays: (count: string) => `${count} plays`,
    notes: {
      [PlayNote.Copied]: "Link copied",
      [PlayNote.InviteCopied]: "Invite link copied",
      [PlayNote.SignIn]: "Sign in to Genex to like games",
      [PlayNote.LikeFailed]: "Couldn’t save your like",
      [PlayNote.MicBlocked]: "Allow the mic in Settings",
      [PlayNote.MicMissing]: "No microphone",
      [PlayNote.MicFailed]: "Mic didn’t start",
    } satisfies Record<PlayNote, string>,
    micOn: "Mute microphone",
    micOff: "Turn on microphone",
    /** Worn by the mic while the game is in voice chat and nobody hears the person yet. */
    micWaiting: "Turn on mic",
    micDevices: "Choose microphone",
    guest: "Save your progress with a Genex account",
    install: "Sign in",
    dismissGuest: "Close",
    /** The Comments button's name while it shows no count (the icon alone). */
    comments: "Comments",
    commentsCount: (count: string) => `Comments, ${count}`,
  },
  /** The viewer's Comments, over the dimmed game. */
  comments: {
    title: (count: number): string => {
      if (count === 0) return "Comments";
      return count === 1 ? "1 Comment" : `${count} Comments`;
    },
    close: "Close",
    none: (title: string) => `No comments on ${title} yet`,
    failed: "Couldn’t load the comments",
    retry: "Try again",
    signIn: (title: string) => `Sign in to comment on ${title}`,
    signInAction: "Sign in",
    field: "Add a comment",
    post: "Post",
    postFailed: "Couldn’t post your comment",
    delete: "Delete",
    deleteLabel: "Delete your comment",
    deleteFailed: "Couldn’t delete your comment",
    /** How long ago a comment was written, its units spelled out. */
    ago: (minutes: number): string => {
      if (minutes < 1) return "just now";
      const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"} ago`;
      if (minutes < 60) return unit(minutes, "minute");
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return unit(hours, "hour");
      const days = Math.floor(hours / 24);
      if (days < 30) return unit(days, "day");
      if (days < 365) return unit(Math.floor(days / 30), "month");
      return unit(Math.floor(days / 365), "year");
    },
  },
  /** A game's coin purchase, over the dimmed game. Amounts arrive written (`1,240 coin`). */
  purchase: {
    close: "Close",
    price: "Price",
    balance: "Your balance",
    /** Read between the balance and what it comes to, in place of the arrow. */
    afterPaying: "after paying",
    coin: (amount: string) => `${amount} coin`,
    quantity: (count: string) => `× ${count}`,
    cancel: "Cancel",
    pay: (amount: string) => `Pay ${amount}`,
    /** Pay with no price read: never pressable. */
    payBare: "Pay",
    paying: "Paying…",
    paid: "Paid",
    receipt: (game: string) => `${game} has your receipt.`,
    back: "Back to game",
    moreNeeded: (amount: string) => `${amount} more needed`,
    getCoin: "Get coin",
    getCoinNote: "Opens genex.games. Pay comes back once the coin lands.",
    /** genex.games already ended the purchase for want of coin: it cannot come back here. */
    overNote: "Try again in the game once the coin lands.",
    review: "Review",
    coinArrived: "Your coin arrived. Review the purchase, then pay.",
    signedOutTitle: "Sign in to buy things in games",
    signedOutBody: "Coin lives in your Genex account. Sign in once, then pay here.",
    signIn: "Sign in to Genex",
    signInNote: "Opens your browser. You’ll come back here to pay.",
    signedInTitle: "You’re signed in",
    signedInBody: "Review the purchase, then pay.",
    pendingTitle: "Still checking the payment",
    pendingBody: (game: string) =>
      `Genex hasn’t confirmed it yet. ${game} finishes the purchase once it does. You won’t be charged twice.`,
    /** How a purchase that ended unpaid (or refunded) reads: only a refusal may say it was refused. */
    failed: {
      [PurchaseProblem.Expired]: {
        title: "This purchase timed out",
        body: "Try again in the game. No coin was reserved or charged.",
      },
      [PurchaseProblem.Canceled]: {
        title: "This purchase was canceled",
        body: "Try again in the game. No coin was charged.",
      },
      [PurchaseProblem.Refused]: {
        title: "This purchase didn’t go through",
        body: "Try again in the game. No coin was charged.",
      },
      /** Paid, then given back: the coin was charged, so never "No coin was charged". */
      [PurchaseProblem.Refunded]: {
        title: "This purchase was refunded",
        body: "Try again in the game. The coin went back to your balance.",
      },
    } satisfies Record<PurchaseProblem, { title: string; body: string }>,
  },
  promo: {
    label: "Genex account",
    eyebrow: "Genex account",
    title: "Put your game on Play",
    publish: "Publish in one click",
    multiplayer: "Make it multiplayer",
    tools: "Every game dev tool",
    learn: "Learn",
    learnLabel: "Learn about Genex",
    linkCopied: "Link copied",
    signIn: "Sign in",
    signInLabel: "Sign in to Genex in your browser",
    dismiss: "Close",
  },
} as const;

/** A Play card's ⋯ menu and its dialogs: genex.games' card menu, in the app (`play/card-menu/`). */
export const PLAY_CARD_MENU_WORDS = {
  trigger: "Game options",
  adminLabel: "Admin",
  item: {
    [PlayCardAction.CopyLink]: "Copy link",
    [PlayCardAction.Remixing]: "Turn off remixing",
    [PlayCardAction.Cover]: "Change cover",
    [PlayCardAction.Mobile]: "Mobile support",
    [PlayCardAction.Tags]: "Edit tags",
    [PlayCardAction.Unpublish]: "Unpublish",
    [PlayCardAction.Delete]: "Delete game",
  } satisfies Record<PlayCardAction, string>,
  allowRemixing: "Allow remixing",
  mobileState: {
    [PlayMobileSupport.DesktopOnly]: "Desktop only",
    [PlayMobileSupport.Supported]: "Works on phones",
  } satisfies Record<PlayMobileSupport, string>,
  mobileAutoFlagged: "Auto · desktop only",
  linkCopied: "Link copied",
  copyFailed: "Couldn’t copy the link.",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  tryAgain: "Try again",
  mobile: {
    title: (title: string) => `Mobile support for ${title}`,
    sub: "What phone players get. Your choice wins over the automatic check.",
    label: "Mobile support",
    auto: "Auto",
    autoHint: "Genex decides from crash reports",
    hint: {
      [PlayMobileSupport.DesktopOnly]: "Phone players see a Desktop tag first",
      [PlayMobileSupport.Supported]: "Never marked desktop only",
    } satisfies Record<PlayMobileSupport, string>,
    autoFlagged: "Auto would choose Desktop only: crash reports flagged it.",
    autoClear: "Auto would let phones play: no crash reports flagged it.",
    done: "Mobile support saved",
    failed: "Couldn’t save mobile support.",
  },
  tags: {
    title: (title: string) => `Tags for ${title}`,
    shelfLabel: "Shelf",
    tagsLabel: "Tags",
    shelf: {
      [PlayShelf.Games]: "Games",
      [PlayShelf.Tools]: "Tools",
      [PlayShelf.Assets]: "Assets",
    } satisfies Record<PlayShelf, string>,
    noTags: "This shelf has no tags.",
    shows: (shelf: string, tags: readonly string[]) =>
      tags.length > 0 ? `Shows on Play under ${shelf} · ${tags.join(", ")}.` : `Shows on Play under ${shelf}.`,
    limit: (max: number) => `Up to ${max} tags.`,
    save: "Save tags",
    done: "Tags saved",
    failed: "Couldn’t save the tags.",
  },
  unpublish: {
    title: (title: string) => `Unpublish ${title}?`,
    body: "It leaves Play and genex.games and goes back to drafts. The direct link still works, and plays and likes stay if it’s published again.",
    confirm: "Unpublish",
    working: "Unpublishing…",
    done: (title: string) => `${title} is unpublished`,
    failed: "Couldn’t unpublish the game.",
  },
  remove: {
    title: (title: string) => `Delete ${title}?`,
    body: "Removes the game, its page and its source for good. This can’t be undone.",
    confirm: "Delete game",
    working: "Deleting…",
    done: (title: string) => `${title} is deleted`,
    failed: "Couldn’t delete the game.",
  },
  remixing: {
    on: (title: string) => `Anyone can remix ${title} now`,
    off: (title: string) => `Only you can remix ${title} now`,
    ownRepo: "Its source is your own repository: run genex make-remixable in the game’s folder to allow remixing.",
    failed: "Couldn’t change remixing.",
  },
  cover: {
    title: (title: string) => `Cover for ${title}`,
    sub: "Pick a picture. It’s cropped to 16:9, like every cover.",
    choose: "Choose a picture",
    another: "Choose another",
    current: "Current cover",
    picked: "New cover",
    save: "Use this cover",
    done: "Cover changed",
    unreadable: "That file isn’t a picture the app can read.",
    tooLarge: "Pick a picture under 40 MB.",
    refusal: {
      [PlayCoverRefusal.Outranked]: "Genex kept the current cover: it outranks an uploaded one.",
      [PlayCoverRefusal.TooDark]: "That picture is too dark for a cover. Try a brighter one.",
      [PlayCoverRefusal.Flat]: "That picture is nearly one colour. Try one with more in it.",
      [PlayCoverRefusal.Invalid]: "Genex couldn’t read that picture. Try another.",
    } satisfies Record<PlayCoverRefusal, string>,
    failed: "Couldn’t change the cover.",
  },
} as const;

/** Who took a check, for the sources that played the build. */
export const PLAYED_SOURCE_WORDS: Record<InteractionSource, string> = {
  [InteractionSource.IndependentPlaytester]: "Independent playtester",
  [InteractionSource.HandsOnJudge]: "Judge who played it",
  [InteractionSource.RouteReplay]: "Replayed route",
};

/** What an interaction result rests on: the studio's own check of the game's state, or the player's word. */
export const OBJECTIVE_WORDS: Record<InteractionObjective, string> = {
  [InteractionObjective.StudioVerified]: "verified by the studio",
  [InteractionObjective.ModelSaid]: "the player's word",
};

/** A chat's judge line (`JudgeLine.tsx`): what leads the question inside it. */
export const CHAT_JUDGE_WORDS = {
  asked: "Asked:",
  /** The line when nothing was played (no window free, a goal state it could not take): the reason is inside. */
  notPlayed: "The judge didn't play",
  /** Which of the engine's judges played, by the name its plugin gives it. */
  playedAs: (judge: string) => `Played as the ${judge} judge`,
} as const;

/** The checks under a build's Technical details: each check's state, its group, and a replayed route's words. */
export const CHECK_WORDS = {
  status: {
    passed: "Passed",
    failed: "Failed",
    unknown: "Not measured",
    incomplete: "Incomplete",
  } satisfies Record<RunEvidence["status"], string>,
  thisBuild: "This build",
  earlierBuilds: "Earlier builds",
  reviewer: "Reviewer",
  recorded: "Recorded check",
  routeTitle: "Replayed the judge's route",
  routeHeld: "The judge's moves were replayed on this build, and the goal held.",
  showAll: "Show all",
  showLess: "Show less",
} as const;

/** A plugin's toolbar buttons while Studio bundles a newer version of it: pressing one opens Plugins at it. */
export const PLUGIN_TOOLBAR_WORDS = {
  update: {
    badge: "Update",
    title: (plugin: string, version: string) =>
      `The ${plugin} plugin ${version} is ready. Press to update it in Plugins.`,
  },
} as const;

/**
 * A game linked to an engine whose Loop needs its project inside the game folder, named by the
 * engine's label: Rewind's note when the project lives elsewhere, and why Mode has no Loop yet.
 */
export const ENGINE_GAME_WORDS = {
  /** Rewind's line when the project lives outside the game folder, so its checkpoints never hold it. */
  rewindNote: (engine: string, project: string) =>
    `Rewind doesn’t undo changes made in ${engine}: ${project} is outside the game folder.`,
  /** Mode's caption for a game whose project lies outside its folder: where it is, and the two ways to a Loop. */
  loopUnavailable: (engine: string, project: string | null, place: string) =>
    project
      ? `Loops need the ${engine} project inside this game’s folder, so Rewind can undo each step; ${project} is in ${place}. Make a new one from the ${engine} button, or move ${project} into this game’s folder and choose it there. Until then, it does what you ask, then stops.`
      : `Loops need this game’s ${engine} project inside its folder, so Rewind can undo each step. A new ${engine} project made from the ${engine} button goes there. Until then, it does what you ask, then stops.`,
} as const;

/** A game linked to an Unreal project: the Live tab's card, Rewind's note and why Mode has no Loop yet. */
export const UNREAL_WORDS = {
  /** The Live tab's line under the project's name, in place of the web page. */
  stageStatus: "Plays in the Unreal editor.",
  open: "Open in Unreal",
  opening: "Opening…",
  /** The Live card for each step of the game's own project (`stage-status`). */
  stage: {
    getUnreal: "Unreal Engine 5.8 isn’t on this computer yet.",
    getUnrealButton: "Get Unreal Engine",
    setUpAndOpen: "Set up and open",
    setUp: "Genex sets it up for agents first; you confirm what changes.",
    /** Set up only, while Unreal has another project open: Genex keeps one Unreal at a time. */
    setUpButton: "Set up",
    setUpBeside: (project: string) => `Genex sets ${project} up for agents now; you confirm what changes.`,
    /** What to do once what holds Unreal lets go: another project closes, or a Loop ends. */
    openWhenFree: "Open it once Unreal is free.",
    openAfterLoop: "Open it after the Loop ends.",
    openProjectWhenFree: (project: string) => `Open ${project} once Unreal is free.`,
    /** Unreal has a project open that it can't name. */
    anotherOpen: "Unreal has another project open.",
    portTaken: (project: string) =>
      `Another app is using the port Genex gave ${project}. Set it up again to move it to a free one.`,
    starting: "Opening in Unreal…",
    startingHint: "The first start can take several minutes.",
    ready: "Ready in Unreal",
    otherOpen: (other: string) => `Unreal has ${other} open.`,
    switchTo: (project: string) => `Switch to ${project}`,
    notAnswering: (project: string) => `${project} isn’t answering in Unreal.`,
    portBlocked: (project: string) => `Unreal couldn’t use the port Genex gave ${project}.`,
    crashed: (project: string) => `Unreal crashed. Close its crash report window, then open ${project} again.`,
    restart: "Restart Unreal",
    quitFirst: (project: string) =>
      `${project} is open in Unreal. Quit Unreal to set it up; Unreal asks you to save first.`,
    quit: "Quit Unreal",
    severalEditors: "Two Unreal editors are open. Quit the one you want from its own window.",
    /** While a Loop is using Unreal, nothing here quits it: which Loop, and what to do once it ends. */
    busyRun: (game: string) => `A Loop in ${game} is using Unreal.`,
    busyHere: "This game’s Loop is using Unreal.",
    setUpAfter: (project: string) => `Set up ${project} after it ends.`,
    openAfter: (project: string) => `Open ${project} after it ends.`,
    leaveOpen: "Genex leaves it open until the Loop ends.",
    choose: (project: string) => `${project} isn’t where it was. Choose it again in the Unreal panel.`,
    /** A folder holding an Unreal project Genex has no link to yet. */
    chooseFirst: "Choose this game’s Unreal project in the Unreal panel.",
    panel: "Open the Unreal panel",
  },
  /** The plugin page's name and line for the Unreal plugin's editor connection. */
  connection: { title: "Editor", text: "Your open Unreal Editor, where agents build Unreal games." },
  /** The latest play shot's alt text. */
  playShot: (project: string) => `${project} in play`,
  /** Rewind's line when the project lives outside the game folder, so its checkpoints never hold it. */
  rewindNote: (project: string) => ENGINE_GAME_WORDS.rewindNote(GAME_ENGINE_WORDS.unreal, project),
  /** Mode's caption for an Unreal game whose project lies outside its folder: where it is, and the two ways to a Loop. */
  loopUnavailable: (project: string | null, place: string) =>
    ENGINE_GAME_WORDS.loopUnavailable(GAME_ENGINE_WORDS.unreal, project, place),
} as const;

/** The Unity plugin's words in Studio's own UI. */
export const UNITY_WORDS = {
  /** The plugin page's name and line for the Unity plugin's editor connection. */
  connection: { title: "Editor", text: "Your open Unity editor, where agents build Unity games." },
} as const;

// ── Genex account settings and avatars ─────────────────────────────────────────────────────

/** Settings → Genex account: the avatar (generated or a photo) and the name, used everywhere on Genex. */
export const ACCOUNT_WORDS = {
  tab: "Genex account",
  avatar: "Avatar",
  avatarLabel: "Avatar",
  generated: "Generated",
  photo: "Photo",
  uploadPhoto: "Upload a photo",
  replacePhoto: "Upload another photo",
  uploading: "Uploading…",
  everywhere: "Changes show in the app and on genex.games right away.",
  styleFailed: "Couldn’t change your avatar.",
  regenerate: "Regenerate",
  regenerateFailed: "Couldn’t regenerate your avatar.",
  name: "Name",
  credits: "Credits",
  creditsCount: (count: string) => `${count} credits`,
  creditsUnlimited: "Unlimited credits",
  buyCredits: "Buy credits",
  buyCreditsLabel: "Buy credits on genex.games",
  /** Under the balance: what credits pay for, the plugin's name a link to its page. */
  creditsNote: { before: "For ", plugin: "Genex plugin", after: " tools: 3D, animation, textures, music. Optional." },
  creditsPluginLabel: "Open the Genex plugin page",
  signOut: "Sign out",
  /** Signed out: the one title, the line and the button, nothing under it. */
  signInTitle: "Sign in to Genex",
  signInText: "Make a profile, publish your games, play with friends.",
  signIn: "Sign in in browser",
  signInLabel: "Sign in to Genex in your browser",
  /** While the sign-in waits in the browser. */
  waiting: "Waiting for browser…",
  browserShows: "Your browser should show",
  cancel: "Cancel",
  offline: "Changes wait until you’re back online.",
  /** A Pro's nameplate: the moving art behind their name in the sidebar. */
  nameplate: "Nameplate",
  newPlate: "New one",
  nameplateNote: "Lights up behind your name in the sidebar when you hover it.",
} as const;

/**
 * The nickname field, in the welcome and in Settings → Genex account: the words genex.games uses
 * for the same field, so both read alike. A reserved handle reads as Taken, the account's own as Free.
 */
export const NICKNAME_WORDS = {
  label: "Your nickname and profile link",
  states: {
    [HandleState.Free]: "Free",
    [HandleState.Taken]: "Taken",
    [HandleState.TooShort]: "Too short",
    [HandleState.TooLong]: "Too long",
    [HandleState.LatinOnly]: "Latin only",
    [HandleState.DashEdge]: "No dash at the ends",
  } satisfies Record<Exclude<HandleState, typeof HandleState.Yours | typeof HandleState.Reserved>, string>,
  profileLink: "Your profile link.",
  try: "Try",
  tryLabel: (handle: string) => `Use ${handle}`,
  length: `${HANDLE_LENGTH.min} to ${HANDLE_LENGTH.max} characters.`,
  letters: "Letters a–z, digits and dashes.",
  checkFailed: "Couldn’t check this nickname. Check your connection.",
  tooManyChanges: "You’ve changed your nickname too often lately. Try again later.",
  saveFailed: "Couldn’t save your nickname. Try again in a moment.",
  /** Settings → Genex account's row. */
  row: "Nickname",
  none: "None yet",
  edit: "Edit",
  editLabel: "Edit your nickname",
} as const;

/** The avatar every Genex account gets, as people meet it: its parts' names and the first-sign-in dialog. */
export const AVATAR_WORDS = {
  welcomeTitle: "Meet your Genex avatar",
  welcomeText: "Nobody else has this one.",
  mixLabel: "Your mix",
  continue: "Continue",
  welcomeNote: "You can change it in Settings",
  /** Under Continue when the welcome asks for the nickname too. */
  welcomeNoteBoth: "You can change both in Settings",
  /** After a refused Regenerate in the welcome, beside the reason. */
  tryAgain: "Try again",
  bodies: {
    [AvatarBody.Vapor]: "Vaporwave sun",
    [AvatarBody.Crt]: "CRT dither",
    [AvatarBody.Matrix]: "Matrix rain",
    [AvatarBody.Holo]: "Hologram",
    [AvatarBody.Circuit]: "Circuit",
    [AvatarBody.Toon]: "Anime cel",
    [AvatarBody.Glitch]: "Glitch",
    [AvatarBody.Chrome]: "Y2K chrome",
    [AvatarBody.Halftone]: "Manga halftone",
    [AvatarBody.Foil]: "Holo foil",
    [AvatarBody.Neon]: "Neon rings",
    [AvatarBody.Galaxy]: "Galaxy",
  } satisfies Record<AvatarBody, string>,
  eyes: {
    [AvatarEyes.Blocks]: "Blocks",
    [AvatarEyes.Blades]: "Blades",
    [AvatarEyes.Shards]: "PS1 shards",
    [AvatarEyes.Grille]: "Grille",
    [AvatarEyes.Optic]: "Optic",
    [AvatarEyes.Mono]: "Mono eye",
    [AvatarEyes.Demon]: "Demon",
  } satisfies Record<AvatarEyes, string>,
  states: {
    [BlockState.Steady]: "steady",
    [BlockState.Wide]: "wide",
    [BlockState.Cold]: "cold",
    [BlockState.Slit]: "slit",
    [BlockState.Menace]: "menace",
    [BlockState.Fury]: "fury",
    [BlockState.Tired]: "tired",
    [BlockState.Squint]: "squint",
    [BlockState.Scan]: "scan",
  } satisfies Record<BlockState, string>,
  gear: {
    [AvatarGear.None]: null,
    [AvatarGear.Horns]: "Horns",
    [AvatarGear.Blades]: "Blades",
    [AvatarGear.Spikes]: "Spikes",
    [AvatarGear.Mast]: "Mast",
    [AvatarGear.Jack]: "Jack",
    [AvatarGear.Headset]: "Headset",
    [AvatarGear.Sigil]: "Sigil",
    [AvatarGear.Scar]: "Scar",
  } satisfies Record<AvatarGear, string | null>,
} as const;

/** Play's Assets shelf as square tiles (`play/PlayAssets.tsx`). */
export const PLAY_ASSET_WORDS = {
  kindsLabel: "Kinds of asset",
  kinds: {
    [KindChoice.All]: "All",
    [KindChoice.Model]: "3D",
    [KindChoice.Image]: "Images",
    [KindChoice.Sound]: "Sounds",
    [KindChoice.Video]: "Videos",
  } satisfies Record<KindChoice, string>,
  /** What a kind's grid holds, as its messages name it. */
  nouns: {
    [KindChoice.All]: "assets",
    [KindChoice.Model]: "3D assets",
    [KindChoice.Image]: "images",
    [KindChoice.Sound]: "sounds",
    [KindChoice.Video]: "videos",
  } satisfies Record<KindChoice, string>,
  scopesLabel: "Whose assets",
  scopes: { [AssetScope.Everyone]: "Everyone", [AssetScope.Mine]: "Mine" } satisfies Record<AssetScope, string>,
  open: (title: string) => `Open ${title}`,
  play: (title: string) => `Play ${title}`,
  pause: (title: string) => `Pause ${title}`,
  playFailed: "Couldn’t play this sound.",
  use: "Use",
  addLabel: (title: string) => `Use ${title} in one of your games`,
  adding: "Adding…",
  addTo: "Add to",
  added: (game: string) => `Added to ${game}`,
  addFailed: (game: string) => `Couldn’t add it to ${game}. Try again in a moment.`,
  signedOut: "Sign in to Genex to see your assets",
  signIn: "Sign in",
  mineEmpty: "Assets you make with Genex show up here.",
} as const;

/** Publish's one line that shares the game's assets on Play when it goes live (`PublishShare.tsx`). */
export const PUBLISH_SHARE_WORDS = {
  offer: (count: number) => `Share its ${plural(count, "asset")} on Play`,
  switchLabel: (count: number) => `Share its ${plural(count, "asset")} on Play when it goes live`,
  sharing: (count: number) => `Sharing ${plural(count, "asset")} on Play…`,
  shared: (count: number) => `${plural(count, "asset")} on Play`,
  checking: (count: number) => `${plural(count, "asset")} on Play once checked`,
  missed: (count: number) => `${count} couldn’t be shared`,
  tryAgain: "Try again",
  tryAgainLabel: "Share the assets that couldn’t be shared again",
  notShared: (count: number) => `${plural(count, "asset")} not on Play yet`,
  shareNow: "Share now",
  shareNowLabel: (count: number) => `Share its ${plural(count, "asset")} on Play now`,
} as const;

/** The @ picker in the prompt bar (`ui/MentionPanel.tsx`). */
export const MENTION_WORDS = {
  listLabel: "Tag a game, tool or asset",
  game: "Game",
  tool: "Tool",
  asset: "Asset",
  yours: "Yours",
  inMessage: "Already in your message",
  yourGames: "Your games",
  assets: "Assets",
  tools: "Tools",
  genexGames: "Games on Genex",
  plugins: "Plugins",
  plugin: "Plugin",
  on: "On",
  imagesHint: "Reference or mood board",
  reading: "Loading Genex games and assets…",
  noMatches: "No matches",
  atCap: "That's as many as one message can carry. Remove one to tag something else.",
  resultsLabel: "Tagged in this message",
  ready: "Ready",
  added: "Added",
  read: "Your game · the agent can read it",
  pluginRead: "Plugin · the agent will use it",
  copied: "Downloaded for the agent to read",
  addedTo: (path: string) => `Added to the game as ${path}`,
  missed: {
    [MentionMiss.NotDownloaded]: "Couldn't download it. Check your connection.",
    [MentionMiss.NotTakeable]: "Its author no longer shares it.",
    [MentionMiss.Gone]: "It's no longer there.",
    [MentionMiss.NotWebGame]: "Assets are for web games.",
  } satisfies Record<MentionMiss, string>,
  tryAgain: "Try again",
  removeTag: "Remove tag",
  trying: "Trying…",
  search: "Search games, assets and tools",
  yourAssets: "Your assets",
  clear: "Clear",
  clearLabel: "Clear the search",
  whatLabel: "What to show",
  all: "All",
  games: "Games",
  whoseLabel: "Whose",
  everyone: "Everyone",
  mine: "Mine",
  /** An asset card's chip when genex.games says what kind of asset it is. */
  assetKind: {
    [LibraryKind.Model]: "3D",
    [LibraryKind.Image]: "Image",
    [LibraryKind.Sound]: "Sound",
    [LibraryKind.Video]: "Video",
  } satisfies Record<LibraryKind, string>,
  saved: "Saved",
  shared: "Shared",
} as const;
