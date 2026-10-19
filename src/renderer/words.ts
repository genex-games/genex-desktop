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

import type { GameEngine } from "../shared/game-engine.ts";
import { WorkerStopCode } from "../shared/workers.ts";
import {
  APPARMOR_PATTERN_CHARACTERS,
  type AppArmorBlockCode,
  type PackageManager,
  type SandboxProblemCode,
  StudioPlatform,
} from "../shared/boot.ts";
import { BuildProblemCode } from "../shared/build-problem.ts";
import { type ARTIFACT_SIGNINGS, ExportRefusal, ExportSigning } from "../shared/game-export-contract.ts";
import { ChatFileOpen } from "../shared/chat-files.ts";
import { AssetImportRefusal, AssetImportStatus, AssetRefusal } from "../shared/game-assets.ts";
import {
  BuildTarget,
  type CompiledStack,
  type CreatableStack,
  GameStack,
  isCompiledStack,
} from "../shared/game-project.ts";
import { DestinationBadge, TargetRefusal } from "../shared/game-targets.ts";
import { BootStage, GameBoxProblem, NativeRefusal, NativeRunState } from "../shared/native-contract.ts";
import {
  PrewarmState,
  ToolchainId,
  ToolchainInstallPhase,
  ToolchainProblem,
  ToolchainPruneRefusal,
  ToolchainUnhosted,
  UserSideState,
  XcodeStatus,
} from "../shared/toolchain.ts";
import { sizeWords } from "../shared/byte-size.ts";
import { freeableBytes, StorageKind, type StorageFreed, type StorageSpace } from "../shared/storage-space.ts";
import { SkippedBy, type SkippedFile } from "../shared/chat-rewind.ts";
import { LiveBehindReason } from "../shared/live-behind.ts";
import { type SeedRetakeAnswer, SeedRetakeRefusal } from "../shared/seed-retake.ts";
import {
  CrateAuditSource,
  CrateAuditStatus,
  type CrateBlock,
  type CrateBlockRefusal,
  CrateCheckEngine,
  type CrateCheckReport,
  CrateNotice,
  CrateRefusal,
  CrateRequestState,
  type CrateRequestView,
} from "../shared/crate-requests.ts";
import { AutoResumeCause, type CustomEvent, type CustomPayload } from "../shared/custom-events.ts";
import { EngineFailureKind } from "../shared/engine-requests.ts";
import { LocalServerProblem } from "../shared/local-server.ts";
import type { GithubLookupProblem } from "../shared/plugins.ts";
import type { GenexPublishPhase } from "../shared/genex.ts";
import { MakingKind } from "../shared/asset-making.ts";
import { RoundOutcome, roundOutcome, stoppedSource } from "../shared/run-state.ts";
import type { OutcomeView } from "../shared/run-summary.ts";
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
import { MAX_FINISH_REJECTIONS } from "../shared/finish-check.ts";
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
  [/^lead in place finishing$/i, () => ({ line: "A reviewer is checking the lead's finish", short: "Checking" })],
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

function keyWord(key: string): string {
  const lower = key.toLowerCase();
  if (Object.hasOwn(KEY_WORD, lower)) return KEY_WORD[lower] ?? key;
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Keys as a player reads them: "space" is Space, "ArrowRight" is →, "shift+w" is Shift+W. */
export function keysWords(keys: readonly string[]): string {
  return keys
    .flatMap((combo) => (combo === "+" ? [combo] : combo.split("+").filter(Boolean)))
    .map(keyWord)
    .join("+");
}

/** A deed and, for a press, its keys. */
function screenWords(act: ScreenAct | undefined, words: Record<ScreenDeed, string>, unknown: string): string {
  if (!act || !Object.hasOwn(words, act.deed)) return unknown;
  const keys = act.deed === ScreenDeed.Press && act.keys?.length ? ` ${keysWords(act.keys)}` : "";
  return `${words[act.deed]}${keys}`;
}

/** What an agent is doing at its screen, as its node says it: "Pressing Space", "Looking around". */
export const screenDoing = (act: ScreenAct | undefined): string => screenWords(act, SCREEN_DOING, SCREEN_PLAYING.doing);

/** The same, done, as a step of its trail says it: "Pressed →", "Opened". */
export const screenDone = (act: ScreenAct | undefined): string => screenWords(act, SCREEN_DONE, SCREEN_PLAYING.done);

/** A frame this recent is happening now. */
const SCREEN_NOW_MS = 2 * SECOND_MS;

/** A minute, in the seconds a running clock shows. */
const SECONDS_PER_MINUTE = MINUTE_MS / SECOND_MS;

/** "42s", "3m 5s", "2h 10m": a running clock, as short as the time allows, and nothing under a second. */
export function clockWords(ms: number): string {
  const seconds = Math.floor(ms / SECOND_MS);
  if (ms < SECOND_MS) return "";
  if (ms < MINUTE_MS) return `${seconds}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m ${seconds % SECONDS_PER_MINUTE}s`;
  return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
}

/** How long ago a screen's frame came: "now", "3s", "2m" on a node, "3s ago" where there is room. */
export function screenAgo(at: number, now: number, { ago = false }: { ago?: boolean } = {}): string {
  const ms = Math.max(0, now - at);
  if (ms < SCREEN_NOW_MS) return "now";
  const span = ms < MINUTE_MS ? `${Math.round(ms / SECOND_MS)}s` : `${Math.round(ms / MINUTE_MS)}m`;
  return ago ? `${span} ago` : span;
}

// ── words several surfaces say ────────────────────────────────────────────────────────────

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
export const STEPS_WORDS = { notNow: "Not now", done: "(done)", copy: "Copy", copied: "Copied" } as const;

/** The turn-it-on card a session shows for a Genex plugin (`chat/PluginSuggestionCard.tsx`). */
export const PLUGIN_SUGGESTION_WORDS = {
  turnOn: "Turn on",
  install: "Install…",
  on: "On",
  close: "Put this suggestion away",
  folders: (paths: string) => `Turning it on lets its programs write in: ${paths}`,
  /** A plugin loaded from a folder on this Mac: its code isn't sandboxed, and its tools ask first. */
  localAccess:
    "Loaded from a folder on this Mac. It runs with your access, and each of its tools asks you before an agent runs it; its own steps at Genex's moments don't ask.",
} as const;

/** Each game engine as the chat names it. */
export const GAME_ENGINE_WORDS = { web: "the web", unreal: "Unreal" } as const satisfies Record<GameEngine, string>;

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
  engineUndone: (game: string | undefined, restored: string | undefined) =>
    restored
      ? `Undone. ${game ?? "This game"} builds in ${restored} again.`
      : `Undone. ${game ?? "This game"} is a web game again.`,
  engineUndo: "Undo",
  engineUndoTitle: "Take this back: the game builds where it did before",
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
  workingFor: (minutes: number) => `Working · about ${minutes} min`,
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

/** Small counts spelled out, for sentences that read better with a word than a digit. */
const SPELLED_COUNTS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] as const;
/** A small count as a word ("two"), a larger or odd one as its digits. */
const spelledCount = (count: number): string => SPELLED_COUNTS[count] ?? String(count);

/** The finish check's node, card and chat lines; every count of no's comes from the shared cap. */
export const FINISH_CHECK_WORDS = {
  name: "Finish check",
  state: {
    not_yet: "Not yet",
    checking: "Checking",
    done: "Done",
    stopped: "Stopped",
  } satisfies Record<FinishCheckState, string>,
  placeholder: "Runs at the end",
  about: "When the lead says the Loop is done, a reviewer that did none of the work checks the proof first.",
  /** The node's line while the reviewer looks. */
  checking: "Checking the proof",
  /** The node's line after a no: how many reasons, and which no in a row it was (the card numbers each claim instead). */
  roundWord: (reasons: number, rejections: number) =>
    `${plural(reasons, "reason")} · round ${rejections} of ${MAX_FINISH_REJECTIONS}`,
  doneWord: "Reviewer said yes",
  stoppedWord: `${MAX_FINISH_REJECTIONS} no's in a row`,
  unanswered: "The reviewer couldn't answer",
  /** The card's section headings, as the design names them. */
  heading: {
    reviewer: "The reviewer",
    whyNotYet: "Why not yet",
    whyYes: "Why yes",
    notDone: "What isn't done",
  },
  /** A heading with the lead's claim it answers, when the card lists more than one (the node's "round" counts no's in a row). */
  roundHeading: (heading: string, claim: number) => `${heading} · claim ${claim}`,
  reviewerIs: "A second agent that did none of the work.",
  yourRequest: "Your request",
  claimLabel: "The lead said",
  saidYes: "The reviewer said yes.",
  /** After a no, while the Loop goes on: how many more no's in a row stop it (fewer than the cap stand). */
  moreNos: (rejections: number) => {
    const left = MAX_FINISH_REJECTIONS - rejections;
    const nos = left === 1 ? "no" : "no's";
    return `${capitalise(spelledCount(left))} more ${nos} in a row and the Loop stops with a report.`;
  },
  /** After a no, once the Loop has ended some other way. */
  endedAfterNo: "The Loop ended before another check.",
  reportInChat: "The report is in the chat.",
  /** One chat line per round, rewritten by its verdict. */
  chat: {
    checking: "A reviewer is checking whether the goal is reached.",
    accepted: "The reviewer agreed the goal is reached.",
    rejected: (rejections: number, reason: string) =>
      reason
        ? `The reviewer sent the work back (${rejections} of ${MAX_FINISH_REJECTIONS}): ${reason}`
        : `The reviewer sent the work back (${rejections} of ${MAX_FINISH_REJECTIONS}).`,
    stopped: (notDone: string) =>
      `The reviewer said no ${spelledCount(MAX_FINISH_REJECTIONS)} times in a row, so the Loop stopped.${notDone ? ` Not done: ${notDone}` : ""}`,
    unanswered: (why: string) => (why ? `The reviewer couldn't answer: ${why}` : "The reviewer couldn't answer."),
  },
} as const;

/** A build in the stage's history, by what it was and the day it started; never a number or a count. */
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

/** How many waiting releases the Update plugins tooltip names before it counts them instead. */
const PLUGIN_RELEASES_NAMED = 3;
const RELEASE_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** The sidebar's Update plugins, while installed plugins have newer versions waiting (`state/plugins.ts`). */
export const PLUGIN_UPDATE_WORDS = {
  update: (count: number) => (count === 1 ? "Update plugin" : `Update ${count} plugins`),
  updating: "Updating plugins…",
  /** The button's tooltip: the releases it installs ("Local Blender 1.2.0"), each after its own approval. */
  hint: (releases: readonly string[]) =>
    releases.length > PLUGIN_RELEASES_NAMED
      ? `Installs ${releases.length} plugin updates`
      : `Installs ${RELEASE_LIST.format(releases)}`,
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
  check_conformance: { icon: "game", label: "checked the game's conformance" },
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
    const name = permissionPath(event)?.split("/").filter(Boolean).pop();
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

/** A path in a person's home, as `~/…`. */
const homePath = (path: string): string => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

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
  /** A message on its way (its row not saved yet), or handed to the running turn and not read yet. */
  sendingMessage: "Sending…",
  /** A message waiting for a turn of its own; Remove withdraws it. */
  queued: "Queued",
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
    "userns-restricted":
      "Ubuntu only lets apps with an AppArmor profile create the isolated spaces agents run in. Genex needs its profile added once.",
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
  /** Windows and Linux: install it now, behind one administrator prompt. */
  setUp: "Set up",
  settingUp: "Waiting for approval…",
  /** Linux: the profile is in, and the app is starting again under it. */
  restarting: "Restarting…",
  /** Windows: what Set up will ask for. */
  setUpHint: "Windows will ask an administrator to approve the setup once.",
  /** Linux: what Set up will ask for and add, by the profile's file. */
  profileSetUpHint: (file: string) =>
    `Ubuntu will ask for your password once to add ${file}. It lets this copy of Genex, and the programs it starts, create user namespaces despite Ubuntu’s restriction. Then Genex restarts.`,
  setupCancelled: "Setup was cancelled, so nothing changed. Choose Set up again when you’re ready to approve it.",
  /** Linux: the same profile install, by hand. */
  byHand: "Add it in a terminal instead",
  byHandHint: "Run this, then quit and reopen Genex:",
  copyProfileCommand: "Copy the terminal command",
  /** Linux: how to take the profile out again. */
  removeHint: "To remove it later:",
  copyRemoveCommand: "Copy the removal command",
  /** Linux: why no profile is offered for this copy, by `AppArmorBlockCode`. */
  apparmorBlocked: {
    unnamable: `AppArmor can’t name the folder Genex is in. Move Genex to a folder whose path has none of ${APPARMOR_PATTERN_CHARACTERS.join(" ")}, then open it again.`,
    "shared-folder":
      "Genex is in a folder other people on this computer can change, so a profile must not name it. Move Genex to a folder only you can write to, such as ~/Genex, then open it again.",
    "not-attached":
      "Genex’s AppArmor profile is installed, but this window started without it. Quit and reopen Genex. If this screen comes back, AppArmor isn’t applying the profile to this copy; Details say which path it names.",
  } satisfies Record<AppArmorBlockCode, string>,
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
    importConfig: "Import MCP configuration…",
    create: "Create a plugin",
    local: "Load local plugin…",
  },
  more: {
    title: "More plugins",
  },
  /** The Marketplace while the catalog has nothing you don't have yet. */
  marketplace: {
    title: "Marketplace",
    soon: "Coming soon",
    text: "Plugins from more game dev tools are on the way.",
  },
  /** The MCP servers section before anyone has added one. */
  servers: {
    emptyTitle: "Connect any MCP server",
    emptyText: "A command on this Mac, or a URL with browser sign-in. Agents in every game can use its tools.",
  },
  own: {
    title: "Make your own plugin",
    text: "Local Blender and the Genex plugin are plugins too: one folder with a manifest, tools and panels.",
    guide: "Read the guide",
  },
  /** A plugin row's account, by what it needs next. */
  account: {
    connect: "Connect",
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

// ── Genex Tools ───────────────────────────────────────────────────────────────────────────

/** The Genex promo after the welcome, the Genex plugin page and its generations. */
export const GENEX_WORDS = {
  promo: {
    label: "Genex Tools",
    eyebrow: "Featured Genex plugin",
    title: "Generate game assets in chat",
    models: { title: "3D models and characters", text: "Rigged, animated and ready for your game." },
    media: { title: "Sound, music and art", text: "Effects, soundtracks, voices and textures." },
    publish: { title: "Publish with a playable link", text: "Anyone can play it in their browser." },
    learnMore: "Learn more",
    learnMoreLabel: "Learn more about Genex Tools",
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
    signedOutTitle: "Connect your Genex account",
    signedOutText: "Sign in once in your browser. One credit balance covers all your games.",
    retryTitle: "Reconnect your Genex account",
    retryText: "Your saved sign-in couldn’t be opened on this Mac. Sign in again in your browser.",
    connect: "Connect Genex",
    retry: "Reconnect",
    signingInTitle: "Finish signing in in your browser",
    signingInText: "Check that your browser shows this code:",
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
    credits: "Credits",
    unlimited: "Unlimited",
    shared: "One balance for all your games. Failed generations are refunded.",
    outOfCredits: "Games still build with procedural assets and Local Blender.",
    paused: (kinds: string) => `Paused on Genex right now: ${kinds}.`,
    off: "Turn on the Genex plugin to connect your account.",
  },
  /** Genex as the Plugins page shows it: the router, its line, and the tools it routes. */
  router: {
    name: "Game dev tools router",
    description: "Genex · Tripo, Meshy, Uthana, ElevenLabs, GPT Image and more on one balance",
    intro:
      "The Genex plugin connects your agents to every game dev tool. Pay on demand, with one balance for every tool.",
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
  /** The Publish dialog on the game's stage, drawn by Studio. */
  publish: {
    title: "Publish to the web",
    intro: "Get a link anyone can play in their browser.",
    published: "Your game is live. Anyone with the link can play it.",
    /** The stage strip's own Publish, when Genex adds none: the words of Genex's button. */
    button: "Publish",
    buttonLabel: "Publish game",
    /** The name field: what the game is listed under, and what Genex paints on its cover. */
    name: "Name players will see",
    /** The game's line under its name. */
    statusNone: "Not online yet",
    statusDraft: "Test version online",
    statusLive: (when: string) => (when === "now" ? "Live · updated just now" : `Live · updated ${when} ago`),
    statusLiveUndated: "Live",
    statusPublishing: "Publishing…",
    publish: "Publish",
    publishing: "Publishing…",
    updatePublic: "Publish update",
    tryAgain: "Try again",
    openGame: "Open game",
    copyLink: "Copy",
    copyLinkLabel: "Copy the game's link",
    copied: "Copied",
    /** Beside the busy Publish: closing the dialog does not stop it. */
    keepsGoing: "Keeps going if you close this.",
    /** The files Publish uploads, shown on request beside Publish. */
    files: (count: number) => (count === 1 ? "1 file" : `${count} files`),
    filesShow: "Files to upload",
    filesLoading: "Listing files…",
    filesLabel: "Files Publish uploads",
    filesLeftOut: (count: number) => `${count} left out`,
    /** While the game has no Genex cover to send: one quiet line, and the press that asks its chat for one. */
    coverNone: "No cover yet. Genex shows a real frame of your game.",
    coverAsk: "Ask for a cover",
    coverAskLabel: "Ask for a cover in this game's chat",
    /** What that press leaves in the game's composer, for the person to send. */
    coverPrompt: "Make this game's Genex cover.",
    /** The chat's card for the cover a builder kept: its caption, its picture's name, and Publish, which opens this dialog. */
    coverCard: "Genex cover",
    coverCardAlt: "This game's Genex cover",
    coverCardPublishLabel: "Publish this game",
    failedTitle: "It didn't go online this time",
    failedText: "Your game is safe and nothing changed. Check your internet connection and try again.",
    failedKept: "Your game is safe, and players still get the version they had. Try again in a moment.",
    unresolvedTitle: "Still checking whether it went online",
    unresolvedText: "Studio couldn’t tell whether the upload reached Genex. Check again before uploading again.",
    copyDetails: "Copy details for support",
    detailsCopied: "Details copied",
    checkAgain: "Check again",
    allowUpload: "I checked — allow a new upload",
    reviewTerms: "Review Genex terms",
    termsNote: "Review the updated Genex terms in your browser before publishing.",
    connectText: "Sign in to Genex once to publish. You finish in your browser.",
    /** Setup's one line, around the plugin's name; its button says what is missing. */
    through: "Publishing uses the",
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
    seconds: (count: number) => `${count}s`,
    /** What the running step is doing, by `GenexPublishPhase`. */
    phase: {
      checking: "Preparing your game",
      exporting: "Preparing your game",
      "creating-project": "Preparing your game",
      uploading: "Uploading",
      promoting: "Going live",
      listing: "Going live",
      done: "Finished",
      "verifying-deployment": "Making sure it plays",
      ready: "Ready to play",
      failed: "Didn't go online",
      unresolved: "Still checking",
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

// ── C++ · raylib: stacks, destinations, toolchains and build problems ─────────────────────

/** A game's stack, as the create dialog and the stage chip name it. A stack is never an "engine". */
export const STACK_WORDS = {
  [GameStack.ThreeJs]: "Three.js",
  [GameStack.RaylibCpp]: "C++ · raylib",
  [GameStack.RustWgpu]: "Rust · wgpu",
} as const satisfies Record<GameStack, string>;

/** Create Game's destinations, the stage's badges, Live's card for a game with no browser build, and Play on Mac. */
export const DESTINATION_WORDS = {
  question: "Where will people play?",
  label: {
    [BuildTarget.Web]: "Browser",
    [BuildTarget.Mac]: "Mac",
    [BuildTarget.Windows]: "Windows",
    [BuildTarget.Linux]: "Linux",
    [BuildTarget.Ios]: "iPhone and iPad",
    [BuildTarget.Android]: "Android",
  } satisfies Record<BuildTarget, string>,
  /** The line under the choices: the stack the destinations make. */
  stackLine: (stack: GameStack): string =>
    isCompiledStack(stack)
      ? `Made in ${STACK_WORDS[stack]}: one game, built for every place you pick.`
      : `Made in ${STACK_WORDS[stack]} for the browser.`,
  /** Create game's stack choice, offered where Rust · wgpu builds here beside Three.js. */
  stackChoice: "Made in",
  /** A stack's line in the stack choice. */
  stackOption: (stack: CreatableStack): string => STACK_WORDS[stack],
  /** Why a desktop box is refused while Three.js is the chosen stack. */
  browserOnly: "Three.js games play in the browser. Choose Rust · wgpu to build for it.",
  /** Why a box is refused for a chosen stack whose lane does not build it here yet. */
  notYetForStack: (stack: CompiledStack): string => `${STACK_WORDS[stack]} games can’t be built for it here yet`,
  /** Why a destination is refused, or only labelled, here. */
  refusal: {
    [TargetRefusal.MacBuildsNeedAMac]: "Mac games are built on a Mac",
    [TargetRefusal.NotRunnableHere]: "Built here, but it can’t run on this computer",
    [TargetRefusal.NoGameBox]: "This version of Genex can’t run it on this computer yet",
    [TargetRefusal.NotADestination]: "Not one of this game’s destinations",
    [TargetRefusal.StackIsFixed]: "A game keeps the stack it was made with. Add destinations it can already build for.",
    [TargetRefusal.NoJudgingTarget]: "There is no build the judges can play: the browser build made for them failed.",
    [TargetRefusal.KindUnsupported]: "A newer version of Genex made this game, so this one opens it read-only.",
    [TargetRefusal.StackGated]: "Rust games aren’t available in this version of Genex yet.",
    [TargetRefusal.ToolchainOffline]:
      "This game’s tools aren’t installed, and Genex can’t download them while offline.",
  } satisfies Record<TargetRefusal, string>,
  badge: {
    [DestinationBadge.Building]: "Building",
    [DestinationBadge.Built]: "Built",
    [DestinationBadge.Failed]: "Build failed",
    [DestinationBadge.NotBuilt]: "Not built yet",
    [DestinationBadge.NotRunHere]: "Built, not run here",
    [DestinationBadge.CiPassed]: "CI smoke passed",
    [DestinationBadge.VerifiedInVm]: "Verified in a VM",
  } satisfies Record<DestinationBadge, string>,
  /** Why a desktop destination's badge says it is not built. */
  notBuiltWhy: "This version of Genex doesn’t build it from here yet.",
  /** The not-run-here badge, naming the computer: a Mac says so. */
  notRunHereOn: (host: StudioPlatform): string =>
    host === StudioPlatform.Mac ? "Built, not run on this Mac" : "Built, not run here",
  /** Why a cross-built destination's badge says it was not run. */
  notRunHereWhy: "Genex built it and checked the program, but this computer can’t run it.",
  /** Live, for a game without Browser among its destinations. */
  liveStatusCard: {
    title: "This game runs in its own window",
    body: "Live shows browser builds, and this game has none. Play it in its own window instead.",
  },
  /** Live, for a game without Browser whose Mac build Live shows itself (a Rust game: no window of its own). */
  liveMacCard: {
    title: "This game plays its Mac build in Live",
    body: "It has no browser build. Choose Native to play it here.",
  },
  playOnMac: "Play on Mac",
  playOnMacUnavailable: "Play on Mac opens games made for Mac.",
  /** A running build's stage on the strip, naming the stack's compiler. */
  buildStage: {
    [GameStack.RaylibCpp]: "Genex is compiling the C++ code.",
    [GameStack.RustWgpu]: "Genex is compiling the Rust code with Cargo.",
  } satisfies Record<CompiledStack, string>,
  /** The badge of a Mac build Live shows itself (a game with no window of its own). */
  inLiveNative: "In Live · Native",
} as const;

const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const BYTES_PER_GB = BYTES_PER_MB * BYTES_PER_KB;

/** A download or disk size: "85 MB", "1.4 GB". */
function byteWords(bytes: number): string {
  if (bytes < BYTES_PER_GB) return `${Math.max(1, Math.round(bytes / BYTES_PER_MB))} MB`;
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

/** The first-run Toolchain sheet and Settings → Toolchains. */
export const TOOLCHAIN_WORDS = {
  title: "Set up C++ games",
  intro: "Set up once for every C++ destination this computer can build. These tools are shared by all your C++ games.",
  /** The sheet's title, intro and unsupported-computer line for each compiled stack: a Rust game's never says C++. */
  forStack: {
    [GameStack.RaylibCpp]: {
      title: "Set up C++ games",
      intro:
        "Set up once for every C++ destination this computer can build. These tools are shared by all your C++ games.",
      unsupportedHost: "C++ games can’t be built on this computer yet.",
    },
    [GameStack.RustWgpu]: {
      title: "Set up Rust games",
      intro:
        "Set up once for every Rust destination this computer can build. These tools are shared by all your Rust games.",
      unsupportedHost: "Rust games can’t be built on this computer yet.",
    },
  } satisfies Record<CompiledStack, { title: string; intro: string; unsupportedHost: string }>,
  clt: {
    name: "Apple Command Line Tools",
    missing: "Needed to build for Mac. macOS installs them in its own window.",
    /** A Rust game's Mac build takes Xcode's copy of the tools. */
    missingOrXcode: "Needed to build for Mac, unless Xcode is installed. macOS installs them in its own window.",
    present: (version: string | null) => (version ? `Installed (${version})` : "Installed"),
    viaXcode: "Included with Xcode",
    install: "Install Command Line Tools",
    installing: "Finish the install in Apple’s window, then come back.",
  },
  xcode: {
    name: "Xcode",
    missing: "Needed later to build for iPhone and iPad. Install it from the App Store.",
    present: (version: string | null) => (version ? `Installed (${version})` : "Installed"),
  },
  /** A Rust sheet's phone rows: the iPhone's Xcode and Rust libraries, Android's SDK parts and its licence. */
  phones: {
    /** A store part that is in. */
    installed: "Installed",
    /** A part the person installs with Android's SDK manager, against the version builds need. */
    userSide: {
      [UserSideState.Ready]: (pin: string) => `Installed (${pin})`,
      [UserSideState.OtherVersion]: (pin: string) =>
        `Another version is installed. Builds need ${pin}; Android’s SDK manager installs it.`,
      [UserSideState.Missing]: (pin: string) => `Not installed. Builds need ${pin}; Android’s SDK manager installs it.`,
    } satisfies Record<UserSideState, (pin: string) => string>,
    /** The iPhone's Xcode line, by `XcodeStatus`. */
    xcode: {
      [XcodeStatus.Absent]: "iPhone and iPad builds need Xcode 26 or later. Install it from the App Store.",
      [XcodeStatus.TooOld]: "This Xcode is too old for iPhone and iPad builds: they need Xcode 26 or later.",
      [XcodeStatus.IosSdkMissing]: "Xcode is missing the iOS 26 SDK. Open Xcode once to install it.",
      [XcodeStatus.Ready]: "Xcode is ready for iPhone and iPad builds.",
    } satisfies Record<XcodeStatus, string>,
    /** The Android SDK licence a person accepts here; Genex never accepts it for them. */
    licence: {
      title: "Android SDK License",
      intro:
        "Android’s SDK, build tools and NDK are installed under Google’s Android Software Development Kit License Agreement. Read it, then accept it here. Genex never accepts it for you.",
      url: "https://developer.android.com/studio/terms",
      read: "Read the license",
      accept: "Accept the license",
      accepted: "You accepted the Android SDK License.",
    },
    /** A phone's install button. */
    install: (phone: string) => `Install ${phone} tools`,
    /** Why a phone's install is not offered, beyond Xcode's own line. */
    sdkMissing: "No Android SDK was found. Install Android Studio or its command-line tools, then open this again.",
    licenceNeeded: "Accept the Android SDK License before installing Android’s tools.",
    notPublished: "Genex hasn’t published these tools for this computer yet.",
    /** A phone whose builds have everything they need. */
    ready: "Ready",
  },
  /** The Rust · wgpu sheet's own lines. */
  rust: {
    /** Settings → Toolchains' Rust · wgpu section. */
    settingsTitle: "Rust games",
    notInstalledHere: "Rust games are a developer preview: this version of Genex doesn’t download their tools yet.",
    keptTitle: "Harness parts from before Rust games",
    keptIntro:
      "Harness changed these parts before it knew Rust games, so a Rust build won’t run on them. Re-take the shipped copy of each; Harness’s change is kept beside it.",
  },
  component: {
    [ToolchainId.Cmake]: "CMake",
    [ToolchainId.Ninja]: "Ninja",
    [ToolchainId.Emsdk]: "Emscripten",
    [ToolchainId.Zig]: "Zig",
    [ToolchainId.LlvmMingw]: "LLVM MinGW",
    [ToolchainId.RaylibSource]: "raylib",
    [ToolchainId.AngleMac]: "ANGLE for Mac",
    [ToolchainId.AngleWindows]: "ANGLE for Windows",
    [ToolchainId.AngleLinux]: "ANGLE for Linux",
    [ToolchainId.LinuxSysroot]: "Linux headers",
    [ToolchainId.Rust]: "Rust",
    [ToolchainId.RustStdWasm]: "Rust for the browser",
    [ToolchainId.WasmBindgen]: "wasm-bindgen",
    [ToolchainId.Binaryen]: "Binaryen",
    [ToolchainId.RustVendor]: "Rust libraries",
    [ToolchainId.RustStdWindows]: "Rust for Windows",
    [ToolchainId.RustStdLinux]: "Rust for Linux",
    [ToolchainId.CargoZigbuild]: "cargo-zigbuild",
    [ToolchainId.SwiftShaderLinux]: "SwiftShader for Linux",
    [ToolchainId.AndroidSdk]: "Android SDK platform",
    [ToolchainId.AndroidBuildTools]: "Android build tools",
    [ToolchainId.AndroidNdk]: "Android NDK",
    [ToolchainId.Bundletool]: "bundletool",
    [ToolchainId.Jdk]: "Java runtime",
    [ToolchainId.RustStdIos]: "Rust for iPhone",
    [ToolchainId.RustStdIosSim]: "Rust for the iOS Simulator",
    [ToolchainId.RustStdAndroid]: "Rust for Android",
    [ToolchainId.CargoDeny]: "cargo-deny",
    [ToolchainId.CargoVet]: "cargo-vet",
    [ToolchainId.RustsecAdvisoryDb]: "RustSec advisories",
  } satisfies Record<ToolchainId, string>,
  size: byteWords,
  disk: (free: number, need: number) => `${byteWords(need)} needed, ${byteWords(free)} free`,
  install: "Install",
  cancel: "Cancel",
  retry: "Try again",
  close: "Close",
  /** A component the sheet lists that has no pinned download for this computer yet. */
  unavailable: "Not available yet",
  /** A component a Rust game lacks, which this version lists but does not download. */
  notInstalled: "Not installed",
  /** A component that comes with Genex (ANGLE): nothing to download. */
  included: "Included with Genex",
  /** Under the list, when `count` of its components have no pinned download. */
  unavailableNote: (count: number) =>
    count === 1
      ? "Genex has no pinned version of this tool for this computer yet; Install leaves it out."
      : "Genex has no pinned versions of these tools for this computer yet; Install leaves them out.",
  /** The destinations an install leaves out, each waiting for a download Genex has not published: before an install and after one. */
  notYet: (targets: readonly BuildTarget[]) => {
    const labels = targets.map((target) => DESTINATION_WORDS.label[target]);
    const last = labels.at(-1) ?? "";
    if (labels.length <= 1) return `${last} isn’t available yet`;
    return `${labels.slice(0, -1).join(", ")} and ${last} aren’t available yet`;
  },
  /** Why a pinned component has no download, by `ToolchainUnhosted`. */
  unhosted: {
    [ToolchainUnhosted.NotPublished]: "Genex hasn’t published this download yet",
  } satisfies Record<ToolchainUnhosted, string>,
  /** A destination whose tools are installed but whose first build must be prepared again, by `PrewarmState`. */
  prewarm: {
    [PrewarmState.Ready]: "Ready",
    [PrewarmState.Stale]: "Installed for an older version of Genex: set it up again before the next build.",
    [PrewarmState.Missing]: "Installed, but the first build isn’t prepared yet: set it up to finish.",
  } satisfies Record<PrewarmState, string>,
  /** Install, when every tool is there and only the preparation must be redone. */
  setUpAgain: "Set up again",
  /** The build problem's button when the tools are installed but their first build was never prepared. */
  setUp: "Set up",
  phase: {
    [ToolchainInstallPhase.Preflight]: "Checking disk space",
    [ToolchainInstallPhase.Downloading]: "Downloading",
    [ToolchainInstallPhase.Verifying]: "Checking the downloads",
    [ToolchainInstallPhase.Extracting]: "Unpacking",
    [ToolchainInstallPhase.Probing]: "Checking the tools run",
    [ToolchainInstallPhase.Prewarming]: "Preparing the first build",
    [ToolchainInstallPhase.Installed]: "Setup finished",
    [ToolchainInstallPhase.Failed]: "The install stopped",
    [ToolchainInstallPhase.Cancelled]: "Cancelled",
  } satisfies Record<ToolchainInstallPhase, string>,
  problem: {
    [ToolchainProblem.Unpinned]: "Genex has no pinned version of this tool for this computer yet.",
    [ToolchainProblem.NotHttps]: "A download address was not secure, so nothing was downloaded.",
    [ToolchainProblem.Download]: "A download failed. Check the connection and try again.",
    [ToolchainProblem.Integrity]: "A download did not match its pinned checksum and was thrown away.",
    [ToolchainProblem.Archive]: "A download held files outside its own folder, so it was not unpacked.",
    [ToolchainProblem.DiskSpace]: "There isn’t enough free disk space.",
    [ToolchainProblem.Probe]: "A tool was installed but did not run.",
    [ToolchainProblem.Prewarm]: "The tools installed, but preparing the first build failed.",
    [ToolchainProblem.CltMissing]: "Apple’s Command Line Tools are needed first.",
    [ToolchainProblem.UnsupportedHost]: "C++ games can’t be built on this computer yet.",
    [ToolchainProblem.NotHosted]: "Genex hasn’t published a download of a tool this needs yet.",
    [ToolchainProblem.NotBundled]:
      "This copy of Genex is missing a bundled C++ component. Reinstall Genex, or rebuild it with the bundled tools.",
  } satisfies Record<ToolchainProblem, string>,
  settings: {
    title: "Toolchains",
    versions: "Installed versions",
    disk: (bytes: number) => `${byteWords(bytes)} on disk`,
    prune: "Remove old versions",
    pruned: (count: number, bytes: number) =>
      count === 0 ? "No old versions to remove" : `Removed ${plural(count, "old version")}, ${byteWords(bytes)}`,
    /** Why a prune removed nothing, by `ToolchainPruneRefusal`. */
    kept: {
      [ToolchainPruneRefusal.Busy]: "Nothing removed: an install is running. Try again when it ends.",
      [ToolchainPruneRefusal.NoLock]: "Nothing removed: no install has finished yet.",
      [ToolchainPruneRefusal.UnknownGameLock]: "Nothing removed: a game may still need these versions.",
      [ToolchainPruneRefusal.Shared]: "Nothing removed: this toolchain folder is shared with another Genex.",
    } satisfies Record<ToolchainPruneRefusal, string>,
    empty: "Nothing installed yet. Make a C++ game to set up its tools.",
  },
} as const;

/** Re-taking the shipped copy of a harness part kept from before Rust games, and how each re-take went. */
export const SEED_RETAKE_WORDS = {
  retake: "Re-take shipped copy",
  retaking: "Re-taking…",
  /** Where Harness's change went once the shipped copy is back. */
  retaken: (patchFile: string) => `Shipped copy back. Harness’s change is kept in ${patchFile}`,
  /** Why a re-take did nothing, by `SeedRetakeRefusal`. */
  refusal: {
    [SeedRetakeRefusal.InvalidPath]: "That isn’t a harness part’s path, so nothing was changed.",
    [SeedRetakeRefusal.NotSeedFile]: "Genex doesn’t ship this part, so there is no copy to re-take.",
    [SeedRetakeRefusal.NotPlainFile]: "This part isn’t a plain file in the harness, so nothing was changed.",
    [SeedRetakeRefusal.NotKept]: "This part is already the shipped copy.",
    [SeedRetakeRefusal.PatchExists]: "An earlier re-take of this part is still where this one would go.",
  } satisfies Record<SeedRetakeRefusal, string>,
  /** The row's line once a re-take answered. */
  answer: (answer: SeedRetakeAnswer): string =>
    answer.ok ? SEED_RETAKE_WORDS.retaken(answer.patchFile) : SEED_RETAKE_WORDS.refusal[answer.code],
} as const;

/** A crate the checks named: `name version`. */
const crateWords = (block: { name: string; version: string }): string => `${block.name} ${block.version}`;

/** A snapshot's day (`YYYY-MM-DD`) as the person reads a date. */
const snapshotDay = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** The blocks of one kind a request's report names. */
const blocksOf = (view: CrateRequestView, refusal: CrateBlockRefusal): CrateBlock[] =>
  (view.check?.blocked ?? []).filter((block) => block.refusal === refusal);

/** A refusal that names the crate it was for (the requested one, or one it brings in); null when the report names none. */
function namedRefusal(view: CrateRequestView): string | null {
  const refusal = view.refusal;
  const isBlock =
    refusal === CrateRefusal.Advisory || refusal === CrateRefusal.Licence || refusal === CrateRefusal.Banned;
  if (!isBlock) return null;
  const [block] = blocksOf(view, refusal);
  if (!block) return null;
  const own = block.name === view.name && block.version === view.version;
  const crate = crateWords(block);
  if (refusal === CrateRefusal.Advisory) {
    const advisory = block.detail ?? "unnamed";
    return own
      ? `A known security advisory (${advisory}) affects it, so it wasn’t added even with your approval.`
      : `It brings in ${crate}, which a known security advisory (${advisory}) affects, so it wasn’t added even with your approval.`;
  }
  if (refusal === CrateRefusal.Licence) {
    const licence = block.detail ?? "no licence";
    return own
      ? `Its licence (${licence}) isn’t one Genex allows in games.`
      : `It brings in ${crate}, under ${licence}, a licence Genex doesn’t allow in games.`;
  }
  return own
    ? "It’s a graphics backend Genex doesn’t allow in games."
    : `It brings in ${crate}, a graphics backend Genex doesn’t allow in games.`;
}

/** Crates a Rust game asked for (extension ladder level 4): the person's card, its states and refusals. */
export const CRATE_REQUEST_WORDS = {
  title: "Crates games asked for",
  intro:
    "A game asked for a crate beyond Genex’s reviewed set. You decide. Genex reads the crate and checks it offline only after you approve: a known security advisory, a licence Genex doesn’t allow or a banned crate, in it or in a crate it brings in, stops it. Audits are shown for your information. Added crates are for that game only.",
  forGame: (project: string) => `for ${project}`,
  approve: "Approve",
  approving: "Checking…",
  decline: "Decline",
  allowBuildScripts: "Allow build scripts",
  allowProcMacros: "Allow proc macros",
  /** What is known of the closure once it was read; before that, when it will be. */
  facts: (view: CrateRequestView): string => {
    if (view.licence === null && view.closureSize === null)
      return "Its licence, advisories and audits are checked after you approve; nothing is added if a check stops it.";
    const parts = [view.licence ?? "No licence named"];
    if (view.closureSize !== null) parts.push(view.closureSize === 1 ? "1 crate" : `${view.closureSize} crates`);
    if (view.buildScripts) parts.push("runs a build script");
    if (view.procMacros) parts.push("has a proc macro");
    return parts.join(" · ");
  },
  /** Where a request stands, by `CrateRequestState`; a refused one says why instead. */
  state: {
    [CrateRequestState.Pending]: "Waiting for you",
    [CrateRequestState.Approved]: "Approved, checking…",
    [CrateRequestState.Vendored]: "Added for this game",
    [CrateRequestState.Refused]: "Not added",
  } satisfies Record<CrateRequestState, string>,
  /** Why a request was not added (or, for the checker's own two, why it waits again), by `CrateRefusal`. */
  refusal: {
    [CrateRefusal.Declined]: "You declined it.",
    [CrateRefusal.NotFound]: "The registry has no such crate or version.",
    [CrateRefusal.Yanked]: "Its authors withdrew this version.",
    [CrateRefusal.Advisory]:
      "A known security advisory affects it, or a crate it brings in, so it wasn’t added even with your approval.",
    [CrateRefusal.Licence]: "It, or a crate it brings in, uses a licence Genex doesn’t allow in games.",
    [CrateRefusal.Unvetted]: "No audit Genex trusts covers it yet.",
    [CrateRefusal.BuildScript]: "It runs a build script, which you didn’t allow.",
    [CrateRefusal.ProcMacro]: "It includes a proc macro, which you didn’t allow.",
    [CrateRefusal.DuplicateVersion]: "It needs a second version of a crate Genex already ships.",
    [CrateRefusal.OverlayTampered]: "Its files changed after they were checked, so Genex won’t use them.",
    [CrateRefusal.EngineCrate]: "Genex’s engine already uses it; games reach it through Genex, not directly.",
    [CrateRefusal.Banned]: "It, or a crate it brings in, is a graphics backend Genex doesn’t allow in games.",
    [CrateRefusal.PolicyTampered]:
      "Genex’s crate policy doesn’t match the one it shipped with, so nothing was checked or added. Reinstall Genex.",
    [CrateRefusal.CheckerUnavailable]:
      "Genex couldn’t install its crate checker, so nothing was checked or added. Connect to the internet and approve again.",
    [CrateRefusal.CheckFailed]:
      "Genex’s crate check didn’t finish, so nothing was added. Approve again to retry; if it keeps failing, reinstall the Rust toolchain in Settings › Toolchains or report the problem.",
  } satisfies Record<CrateRefusal, string>,
  /** The line under a decided request: a refusal names the crate it was for when the checks said. */
  outcome: (view: CrateRequestView): string => {
    if (!view.refusal) return CRATE_REQUEST_WORDS.state[view.state];
    return namedRefusal(view) ?? CRATE_REQUEST_WORDS.refusal[view.refusal];
  },
  /** The labels of what the checks found. */
  check: {
    advisories: "Advisories",
    licence: "Licence",
    banned: "Banned",
    audits: "Audits",
    details: "How it was checked",
    engine: "Checked by",
    snapshot: "Advisory list",
  },
  /** The advisory row: each one that stopped it and the crate it affects, or none known as of the snapshot's day. */
  advisories: (report: CrateCheckReport): string => {
    const found = report.blocked.filter((block) => block.refusal === CrateRefusal.Advisory);
    if (found.length > 0) return found.map((block) => `${block.detail} in ${crateWords(block)}`).join(", ");
    if (report.advisories.length > 0) return report.advisories.join(", ");
    return report.advisoryDbDate ? `None known as of ${snapshotDay(report.advisoryDbDate)}` : "None known";
  },
  /** The licence row: allowed, or each crate whose licence isn't, with that licence. */
  licence: (report: CrateCheckReport): string => {
    if (report.licenceAllowed) return "Allowed";
    const found = report.blocked.filter((block) => block.refusal === CrateRefusal.Licence);
    if (found.length === 0) return "Not allowed";
    return `Not allowed: ${found.map((block) => `${crateWords(block)} (${block.detail ?? "no licence"})`).join(", ")}`;
  },
  /** The banned row's crates; empty when none is banned. */
  banned: (report: CrateCheckReport): string =>
    report.blocked
      .filter((block) => block.refusal === CrateRefusal.Banned)
      .map(crateWords)
      .join(", "),
  /** Each trusted source's name. */
  auditSource: {
    [CrateAuditSource.BytecodeAlliance]: "Bytecode Alliance",
    [CrateAuditSource.Embark]: "Embark",
    [CrateAuditSource.Google]: "Google",
    [CrateAuditSource.Mozilla]: "Mozilla",
    [CrateAuditSource.Zcash]: "Zcash",
  } satisfies Record<CrateAuditSource, string>,
  /** The audits row: who audited it, who didn't, and whose lists aren't installed (or that none is). */
  audits: (report: CrateCheckReport): string => {
    if (report.audits.every((row) => row.status === CrateAuditStatus.Unavailable))
      return "No trusted audit lists installed yet";
    const named = (status: CrateAuditStatus) =>
      report.audits
        .filter((row) => row.status === status)
        .map((row) => CRATE_REQUEST_WORDS.auditSource[row.source])
        .join(", ");
    const groups = [
      [named(CrateAuditStatus.Audited), "Audited by"],
      [named(CrateAuditStatus.NotAudited), "Not audited by"],
      [named(CrateAuditStatus.Unavailable), "No audit list yet from"],
    ] as const;
    return groups
      .filter(([sources]) => sources !== "")
      .map(([sources, lead]) => `${lead} ${sources}`)
      .join(" · ");
  },
  /** What a vendored crate carries for the person, by `CrateNotice`. */
  notice: {
    [CrateNotice.Unaudited]: "No trusted source has audited it yet. It was added on your approval.",
    [CrateNotice.NoAuditLists]:
      "Genex has no audit lists to compare against yet, so it was added on your approval alone.",
  } satisfies Record<CrateNotice, string>,
  /** Each engine's name. */
  engineName: {
    [CrateCheckEngine.CargoDeny]: "cargo-deny",
    [CrateCheckEngine.CargoVet]: "cargo-vet",
    [CrateCheckEngine.Builtin]: "Genex’s built-in rules (test data)",
  } satisfies Record<CrateCheckEngine, string>,
  /** The engine row: what checked advisories, licences and bans, and what read the audits. */
  engine: (report: CrateCheckReport): string => {
    const one = (engine: CrateCheckEngine, version: string | null) =>
      version ? `${CRATE_REQUEST_WORDS.engineName[engine]} ${version}` : CRATE_REQUEST_WORDS.engineName[engine];
    const deny = one(report.engine, report.engineVersion);
    const vet = report.auditEngine === null ? null : one(report.auditEngine, report.auditEngineVersion);
    return vet === null || vet === deny ? deny : `${deny} · ${vet}`;
  },
  /** The snapshot row: RustSec at its commit and day. */
  snapshot: (report: CrateCheckReport): string => {
    const commit = report.advisoryDb ? `RustSec ${report.advisoryDb.slice(0, 8)}` : "RustSec";
    return report.advisoryDbDate ? `${commit}, ${snapshotDay(report.advisoryDbDate)}` : commit;
  },
} as const;

/** A C++ game's own run: Play on Mac's card, its states and why a run was refused. */
export const NATIVE_WORDS = {
  title: "Playing on Mac",
  /** Where a starting game's boot is (owner decision D11), the web shell's own words. */
  boot: {
    stage: {
      [BootStage.Wasm]: "Downloading the game",
      [BootStage.Assets]: "Loading assets",
      [BootStage.Device]: "Starting the graphics",
      [BootStage.Pipelines]: "Preparing shaders",
      [BootStage.Frame]: "Drawing the first frame",
      [BootStage.Ready]: "Ready",
    } satisfies Record<BootStage, string>,
    counted: (stage: BootStage, done: number, total: number) =>
      `${NATIVE_WORDS.boot.stage[stage]} · ${done} of ${total}`,
  },
  /** Where the run stands, by `NativeRunState`. */
  state: {
    [NativeRunState.Building]: "Building for Mac",
    [NativeRunState.Admitting]: "Checking the build",
    [NativeRunState.Starting]: "Starting",
    [NativeRunState.Ready]: "Running in its own window",
    [NativeRunState.Paused]: "Paused",
    [NativeRunState.Stopping]: "Stopping",
    [NativeRunState.Stopped]: "Stopped",
    [NativeRunState.Crashed]: "The game crashed",
    [NativeRunState.Killed]: "The game was stopped by force",
    [NativeRunState.Refused]: "Genex didn’t start this build",
  } satisfies Record<NativeRunState, string>,
  /** Why the host refused a build, a run or a reply, by `NativeRefusal`. */
  refusal: {
    [NativeRefusal.ExtraMachO]: "The build holds a program Genex didn’t expect, so it wasn’t started.",
    [NativeRefusal.Symlink]: "The build holds a link, so it wasn’t started.",
    [NativeRefusal.HardLink]: "The build holds a file linked from somewhere else, so it wasn’t started.",
    [NativeRefusal.LinksOpenGl]: "The build uses OpenGL, which Genex doesn’t run. Games draw through Metal.",
    [NativeRefusal.MissingAngleImport]:
      "The build doesn’t draw through Genex’s graphics library, so it wasn’t started.",
    [NativeRefusal.ForeignRpath]: "The build loads libraries from outside the game, so it wasn’t started.",
    [NativeRefusal.NotAnExecutable]: "The build isn’t a Mac program this computer can run.",
    [NativeRefusal.AngleDigest]: "Genex’s graphics library didn’t match its checksum, so the game wasn’t started.",
    [NativeRefusal.ExtraPe]: "The build holds a program Genex didn’t expect, so it wasn’t started.",
    [NativeRefusal.ImportsOpengl32]: "The build uses OpenGL, which Genex doesn’t run on Windows.",
    [NativeRefusal.ExtraSharedObject]: "The build holds a library Genex didn’t expect, so it wasn’t started.",
    [NativeRefusal.ImportsLibGl]: "The build uses OpenGL directly, which Genex doesn’t run on Linux.",
    [NativeRefusal.RunpathNotOrigin]: "The build loads libraries from outside the game, so it wasn’t started.",
    [NativeRefusal.GlibcTooNew]: "The build needs a newer Linux than Genex supports.",
    [NativeRefusal.BadHandshake]: "The game didn’t answer Genex the way a Genex game does, so it was stopped.",
    [NativeRefusal.ReadyTimeout]: "The game took too long to start and was stopped.",
    [NativeRefusal.ReplyTooLarge]: "The game sent Genex more than it accepts at once, so it was stopped.",
    [NativeRefusal.ReplyInvalid]: "The game answered Genex with something it couldn’t read, so it was stopped.",
    [NativeRefusal.CaptureTooLarge]: "The game’s picture was larger than Genex accepts.",
    [NativeRefusal.CaptureDigest]: "The game’s picture didn’t match what it said it drew.",
    [NativeRefusal.MemoryCap]: "The game used too much memory and was stopped.",
    [NativeRefusal.Unresponsive]: "The game stopped responding and was stopped.",
    [NativeRefusal.Unsupported]: "That isn’t something a C++ game can do here.",
    [NativeRefusal.NoGameBox]: DESTINATION_WORDS.refusal[TargetRefusal.NoGameBox],
    [NativeRefusal.NotADestination]: DESTINATION_WORDS.refusal[TargetRefusal.NotADestination],
    [NativeRefusal.NotRunnableHere]: DESTINATION_WORDS.refusal[TargetRefusal.NotRunnableHere],
    [NativeRefusal.KindUnsupported]: DESTINATION_WORDS.refusal[TargetRefusal.KindUnsupported],
    [NativeRefusal.StackGated]: DESTINATION_WORDS.refusal[TargetRefusal.StackGated],
    [NativeRefusal.ToolchainOffline]: DESTINATION_WORDS.refusal[TargetRefusal.ToolchainOffline],
    [NativeRefusal.LaneMissing]: "This version of Genex can’t build this kind of game yet.",
    [NativeRefusal.BuildFailed]: "The Mac build failed.",
    [NativeRefusal.HarnessPredatesNative]:
      "This version of the studio’s harness can’t judge C++ games. Update it, then try again.",
    [NativeRefusal.EmbedUnsupported]: "This computer can’t show the game inside Live yet.",
    [NativeRefusal.SlotUnknown]: "The game sent a picture Genex didn’t ask for, so it was stopped.",
    [NativeRefusal.SlotMismatch]: "The game sent a picture Genex didn’t ask for, so it was stopped.",
    [NativeRefusal.TooManySlots]: "The game asked for more pictures than Genex shares, so it was stopped.",
    [NativeRefusal.FrameRate]: "The game sent pictures faster than Genex shows them, so it was stopped.",
    [NativeRefusal.ElectronUntested]: "This version of Genex can’t show the game inside Live yet.",
    [NativeRefusal.FramesInvalid]: "The game sent Live a picture Genex couldn’t use, so it was stopped.",
    [NativeRefusal.FramesStalled]: "Live stopped showing the game, so it was stopped.",
    [NativeRefusal.GamePredatesEmbedding]: "This game was made before Live could show Mac builds.",
    [NativeRefusal.WrongMachine]: "The build is for a different kind of computer, so it wasn’t started.",
    [NativeRefusal.ForeignImport]: "The build needs a system library Genex doesn’t allow, so it wasn’t started.",
    [NativeRefusal.GpuUnsupported]: "This computer’s graphics can’t run the game: it needs WebGPU-class graphics.",
    [NativeRefusal.DeviceLost]: "The game lost its graphics device. It’s getting it back; try again in a moment.",
    [NativeRefusal.GpuHang]: "The game’s graphics stopped responding, so it was stopped.",
    [NativeRefusal.NativeFeatureMissing]: "The game needs a graphics feature this computer doesn’t have.",
    [NativeRefusal.NativeFeaturesWeb]: "The game needs graphics features browsers don’t offer, so it has no web build.",
    [NativeRefusal.GpuPassInvalid]:
      "One of the game’s own graphics passes didn’t pass Genex’s checks, so it wasn’t run.",
    [NativeRefusal.TouchNotTaken]: "This preview can’t take touches, so the game’s touch controls weren’t played.",
    [NativeRefusal.ConformanceRequired]:
      "This game runs its own engine, and this build hasn’t passed the conformance checks yet, so it wasn’t started.",
  } satisfies Record<NativeRefusal, string>,
  /** Why a Windows or Linux computer has no game box to start the game in, by `GameBoxProblem`. */
  box: {
    [GameBoxProblem.LauncherMissing]: "This version of Genex has no game launcher for Windows yet.",
    [GameBoxProblem.BubblewrapMissing]:
      "Genex needs bubblewrap 0.8 or newer to run games here. Install it, then try again.",
    [GameBoxProblem.UsernsRestricted]:
      "Ubuntu only lets apps with an AppArmor profile create the isolated spaces games run in, so this game wasn’t started.",
    [GameBoxProblem.X11Only]: "Genex opens game windows on Wayland only, and this session is X11.",
    [GameBoxProblem.NoWayland]: "Genex couldn’t reach a Wayland session to open the game’s window.",
    [GameBoxProblem.WaylandUnrestricted]:
      "This desktop can’t give a game its own restricted Wayland connection, so Genex won’t open its window.",
    [GameBoxProblem.NoHeadlessBuild]:
      "Genex can’t run this build without a window on this computer yet, so the browser build is checked instead.",
    [GameBoxProblem.BoxRefused]: "The sandbox Genex runs games in refused to start this one.",
    [GameBoxProblem.WaylandHelperMissing]: "This version of Genex can’t open game windows on Linux yet.",
  } satisfies Record<GameBoxProblem, string>,
  /** A desktop build's failure, naming its destination: "The Windows build failed." */
  buildFailedFor: (target: BuildTarget): string => `The ${DESTINATION_WORDS.label[target]} build failed.`,
  stop: "Stop",
  restart: "Restart",
  front: "Bring to front",
  details: "Details",
  /** The card's heading once a window that ran has ended: nothing plays any more, its state says how it ended. */
  ended: "Mac window",
  /** The ended window's heading per desktop destination, for the card on a Windows or Linux host. */
  windowTitle: {
    [BuildTarget.Mac]: "Mac window",
    [BuildTarget.Windows]: "Windows window",
    [BuildTarget.Linux]: "Linux window",
  } satisfies Partial<Record<BuildTarget, string>>,
  /** Under the state, when the game ended on its own with an error. */
  crashed: (code: number | null, signal: string | null) =>
    signal ? `It ended on ${signal}.` : `It ended with code ${code ?? "unknown"}.`,
  killed: "Genex stopped it after it didn’t quit when asked.",
  /** Under "The Mac build failed." when the lane gave no problem: the card offers Try again. */
  buildFailed: "Fix the error, then try again.",
  /** The card's way back after a build failed or a run was refused: the build strip's word. */
  tryAgain: "Try again",
  /** Live's Web | Native toggle, Pop out, click-to-capture, and why a Mac build can't be shown inside Live. */
  embed: {
    /** The toggle's accessible name: which build Live shows. */
    toggleLabel: "Build in Live",
    web: "Web",
    native: "Native",
    popOut: "Pop out",
    popOutLabel: "Play in its own window",
    clickToPlay: "Click to play",
    releaseHint: "Esc releases the keyboard",
    /** The hidden field that takes the game's keyboard while Live has it. */
    keyboard: "Game keyboard",
    /** Said once, as the toggle goes: Play on Mac is the way on (the strip shows it again). */
    unsupported: "This Mac can’t show the game inside Live. Play on Mac opens it in its own window.",
    predates: "This game was made before Live could show Mac builds. Use Pop out.",
    electronUntested:
      "This version of Genex can’t show Mac builds inside Live yet. Play on Mac opens it in its own window.",
    stalled: "Live stopped showing the game. Try again or use Pop out.",
    /** WebGL2 is not there to draw frames with. */
    cantDraw: "Live can’t draw the game on this Mac. Use Pop out.",
    /** The embed call itself failed (main did not answer). */
    failed: "Live couldn’t start the game. Try again or use Pop out.",
  },
} as const;

/** Why a C++ game's build could not even run, by `BuildProblemCode`. */
export const BUILD_PROBLEM_WORDS = {
  [BuildProblemCode.CommandFailed]: "The build failed.",
  [BuildProblemCode.InSourceBuild]:
    "This game’s folder has a CMakeCache.txt. Genex builds outside the game folder: delete that file, then try again.",
  [BuildProblemCode.ToolchainMissing]:
    "The C++ tools this game builds with aren’t installed. Install them, then try again.",
  [BuildProblemCode.ToolchainStale]:
    "The C++ tools were set up for an older version of Genex. Set them up again, then try again.",
  [BuildProblemCode.ToolchainNotHosted]: TOOLCHAIN_WORDS.problem[ToolchainProblem.NotHosted],
  [BuildProblemCode.CltMissing]: "Building for Mac needs Apple’s Command Line Tools.",
  [BuildProblemCode.UnsupportedHost]: TOOLCHAIN_WORDS.problem[ToolchainProblem.UnsupportedHost],
  [BuildProblemCode.MacBuildsNeedAMac]: DESTINATION_WORDS.refusal[TargetRefusal.MacBuildsNeedAMac],
  [BuildProblemCode.NotADestination]: "That isn’t one of this game’s destinations.",
  [BuildProblemCode.TimedOut]: "The build took too long and was stopped.",
  [BuildProblemCode.Cancelled]: "The build was stopped.",
  [BuildProblemCode.ToolchainUnprepared]: "The C++ tools are installed but not set up yet. Set them up to finish.",
  [BuildProblemCode.GateRefused]: "The build didn’t pass Genex’s safety check, so it isn’t used.",
} as const satisfies Record<BuildProblemCode, string>;

/** The signings a phone export takes, one per option of the export sheet. */
type MobileExportSigning = (typeof ARTIFACT_SIGNINGS)[keyof typeof ARTIFACT_SIGNINGS][number];

/** The chat header's export menu for a C++ game, its notice and why an export was refused, by `ExportRefusal`. */
export const EXPORT_WORDS = {
  menuLabel: "Export for",
  browser: "Browser (web folder)",
  mac: "Mac app",
  windows: "Windows (.zip)",
  linux: "Linux (.tar.gz)",
  ios: "iPhone and iPad app",
  android: "Android app",
  /** After a Mac app export (ad hoc signed): where it opens, and how another Mac lets it open. */
  exportedMac: (name: string) =>
    `Exported ${name}.app. It opens on this Mac. On another Mac, open it from System Settings > Privacy & Security.`,
  /** After a Windows export: the archive's file name, where it was built (this Mac unless told), and that it never ran on Windows. */
  exportedWindows: (file: string, machine = "this Mac") =>
    `Exported ${file}. Genex built it on ${machine} but hasn’t run it on Windows.`,
  /** After a Linux export: the archive's file name, where it was built (this Mac unless told), and that it never ran on Linux. */
  exportedLinux: (file: string, machine = "this Mac") =>
    `Exported ${file}. Genex built it on ${machine} but hasn’t run it on Linux.`,
  /** Where a desktop archive was built, on a Studio that is not a Mac. */
  builtElsewhere: "this computer",
  /** Beside a destination whose export only a software GPU has drawn (`GpuQualification.Untested`). */
  untestedOnRealGpus: "Untested on real GPUs",
  /** After such an export: what the label means. */
  untestedNotice: "It’s untested on real GPUs: only a software renderer has drawn it so far.",
  /** Beside a phone destination no real iPhone or Android phone has run yet (`GpuQualification.Untested`). */
  untestedOnRealDevices: "Untested on real devices",
  /** After a phone export so labelled: what the label means. */
  untestedDevicesNotice: "It’s untested on real devices: Genex built it but hasn’t run it on a phone.",
  /** After a browser export whose code is past its game's budget (`ExportWarningCode.WasmOverTarget`), sizes in MB. */
  wasmOverTarget: (gzipMb: string, budgetMb: string) =>
    `Its code is ${gzipMb} MB compressed, over the game’s ${budgetMb} MB budget, so it loads slower on phones and weak devices. Raise wasm_budget_mb in genex.toml if that’s fine.`,
  /** The phone export sheet: what it makes and how it is signed. */
  mobile: {
    title: (phone: string) => `Export for ${phone}`,
    intro:
      "Choose what to make. Builds signed with your own identity or keystore are yours alone: the agent never makes them.",
    choose: "What to make",
    option: {
      [ExportSigning.AdHoc]: {
        name: "Simulator app",
        detail: "Runs in the iOS Simulator on this Mac. Signed for this Mac only.",
      },
      [ExportSigning.IosDevelopment]: {
        name: "Your iPhone or iPad (.ipa)",
        detail: "Signed with your Apple Development identity and a provisioning profile that lists your device.",
      },
      [ExportSigning.IosDistribution]: {
        name: "App Store or ad hoc (.ipa)",
        detail: "Signed with your Apple Distribution identity and its provisioning profile.",
      },
      [ExportSigning.AndroidDebug]: {
        name: "Development APK",
        detail: "Signed with this profile’s own Genex debug key. Installs on a test phone.",
      },
      [ExportSigning.AndroidRelease]: {
        name: "Google Play bundle (.aab)",
        detail: "Signed with your own release keystore.",
      },
    } satisfies Record<MobileExportSigning, { name: string; detail: string }>,
    /** Beside an option signed with the person's own identity or keystore. */
    personOnly: "Only you",
    field: {
      identity: "Signing identity",
      /** The identity field's example: the certificate's name for the signing chosen. */
      identityPlaceholder: (signing: ExportSigning) =>
        signing === ExportSigning.IosDistribution
          ? "Apple Distribution: Your Name (TEAMID)"
          : "Apple Development: Your Name (TEAMID)",
      provisioningProfile: "Provisioning profile",
      keystore: "Release keystore",
      alias: "Key alias",
      password: "Keystore password",
      passwordFromEnv: "Environment variable",
      passwordFromFile: "File",
      passwordEnvPlaceholder: "GENEX_KEYSTORE_PASSWORD",
      passwordNote:
        "Genex never asks for the password itself: the signer reads it from the variable or the file when it signs.",
      choose: "Choose…",
      none: "No file chosen",
    },
    export: "Export",
    exporting: "Exporting…",
    cancel: "Cancel",
    /** After a phone export: the artifact's file name. */
    exported: (file: string) => `Exported ${file}.`,
  },
  refusal: {
    [ExportRefusal.BuildFailed]: "The game’s current build failed, so nothing was exported.",
    [ExportRefusal.LaneMissing]: "This version of Genex can’t build this kind of game yet, so nothing was exported.",
    [ExportRefusal.NotADestination]: "That isn’t one of this game’s destinations.",
    [ExportRefusal.NotAnExportFolder]: "The export folder holds files Genex didn’t put there, so nothing was exported.",
    [ExportRefusal.SecretFound]: "A file held a secret key, so nothing was exported.",
    [ExportRefusal.SigningInvalid]: "The signing details aren’t valid, so nothing was exported.",
    [ExportRefusal.SigningUnavailable]: "This version of Genex exports Mac apps signed for this Mac only.",
    [ExportRefusal.HarnessMayNotSign]: "Only you can sign an export with your own identity.",
    [ExportRefusal.AdmissionRefused]: "The Mac build didn’t pass Genex’s checks, so no app was made.",
    [ExportRefusal.MacBuildsNeedAMac]: DESTINATION_WORDS.refusal[TargetRefusal.MacBuildsNeedAMac],
    [ExportRefusal.BuildChanged]: "The build changed while it was being exported. Try again.",
    [ExportRefusal.ToolchainUnusable]:
      "The C++ tools this export needs are missing or damaged. Set them up again, then try again.",
    [ExportRefusal.SigningFailed]: "Signing didn’t finish, so nothing was exported.",
    [ExportRefusal.TargetRefused]: "Genex can’t write the export there, so nothing was exported.",
    [ExportRefusal.MissingNotice]: "A licence the export must include couldn’t be read, so nothing was exported.",
    [ExportRefusal.ArchiveRefused]: "A file couldn’t be packed safely, so nothing was exported.",
    [ExportRefusal.ConformanceRequired]:
      "This game runs its own engine, and its current build hasn’t passed the conformance checks, so nothing was exported.",
  } satisfies Record<ExportRefusal, string>,
} as const;

/** Why a delivered file cannot be used by the game's stack, by `AssetRefusal`; `ext` without its dot. */
export const ASSET_REFUSAL_WORDS = {
  [AssetRefusal.UnsupportedByRaylib]: (ext: string) =>
    `C++ games can’t load .${ext} files. Use PNG or JPEG pictures, OGG, WAV or MP3 sound, and glTF or OBJ models.`,
  [AssetRefusal.UnsupportedByRust]: (ext: string) =>
    `Rust games can’t load .${ext} files. Use PNG, JPEG, WebP or KTX2 pictures, OGG, WAV, MP3 or FLAC sound, and glTF or OBJ models.`,
} as const satisfies Record<AssetRefusal, (ext: string) => string>;

/**
 * What the Assets preview says about a Rust game's file its import step has not imported yet,
 * refused, or imported with warnings (`ProjectAsset.import`). A file that is simply ready says nothing.
 */
export const ASSET_IMPORT_WORDS = {
  [AssetImportStatus.Pending]: "Getting this ready for your game’s builds…",
  warnings: (count: number) =>
    `Ready for builds. The model check noted ${count} ${count === 1 ? "thing" : "things"} worth a look.`,
  refused: {
    [AssetImportRefusal.UnsupportedByRaylib]: "C++ games can’t load this format, so builds leave it out.",
    [AssetImportRefusal.UnsupportedByRust]: "Rust games can’t load this format, so builds leave it out.",
    [AssetImportRefusal.UnsafePath]: "This file’s name can’t be used in a game, so builds leave it out.",
    [AssetImportRefusal.EscapesGame]: "This file points outside the game folder, so builds leave it out.",
    [AssetImportRefusal.Missing]: "This file is gone, so builds leave it out.",
    [AssetImportRefusal.NotRegularFile]: "This isn’t a regular file, so builds leave it out.",
    [AssetImportRefusal.TooLarge]: "This file is too large to import, so builds leave it out.",
    [AssetImportRefusal.Malformed]: "This file is damaged or isn’t the format its name says, so builds leave it out.",
    [AssetImportRefusal.UnsupportedExtension]:
      "This model needs a glTF extension Genex games can’t read, so builds leave it out.",
    [AssetImportRefusal.ConverterMissing]: "Genex can’t convert this format yet, so builds leave it out.",
    [AssetImportRefusal.ImporterFailed]:
      "Importing this file failed, so builds leave it out. Deliver it again to retry.",
    [AssetImportRefusal.ValidationFailed]: "The model check found errors in this file, so builds leave it out.",
  } satisfies Record<AssetImportRefusal, string>,
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

/** A plugin's toolbar buttons while Studio bundles a newer version of it: pressing one opens Plugins at it. */
export const PLUGIN_TOOLBAR_WORDS = {
  update: {
    badge: "Update",
    title: (plugin: string, version: string) =>
      `The ${plugin} plugin ${version} is ready. Press to update it in Plugins.`,
  },
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
  rewindNote: (project: string) => `Rewind doesn’t undo changes made in Unreal: ${project} is outside the game folder.`,
  /** Mode's caption for an Unreal game whose project lies outside its folder: where it is, and the two ways to a Loop. */
  loopUnavailable: (project: string | null, place: string) =>
    project
      ? `Loops need the Unreal project inside this game’s folder, so Rewind can undo each step; ${project} is in ${place}. Make a new one from the Unreal button, or move ${project} into this game’s folder and choose it there. Each message runs one turn.`
      : "Loops need this game’s Unreal project inside its folder, so Rewind can undo each step. A new Unreal project made from the Unreal button goes there. Each message runs one turn.",
} as const;
