/**
 * A Loop's finish check: when the lead claims the goal is reached, a reviewer that did none of the
 * work decides. Genex captures the game (its observers and its web preview), reads the proof the
 * lead names and the run's job results, and asks a reviewer (the Reviewers role, a read-only
 * session in a home of its own that reads the lead's folder and may look at app windows) for yes or
 * no with reasons. A yes ends the Loop; a no goes back to the lead; `MAX_FINISH_REJECTIONS` no's in a
 * row stop the Loop. A check that gets no answer neither counts nor breaks the row.
 *
 * The verdict is Genex's: the harness gathers, fits the brief and picks the seat, then asks the host
 * (`finish.review`), which records the round, runs the reviewer in the seat it gives reviewers, reads
 * its yes or no and holds it. The harness settles the round (`finish.settle`) and acts on the host's
 * answer: it may turn a held answer into no answer (a yes that lapsed, a turn that ended), never into
 * a yes, and the host counts the no's in a row and says when they stop the Loop. The harness writes
 * no `finish_check` record itself: Genex refuses one.
 *
 * Everything happens inside the lead's one `finish` call (`LEAD_CALL_MS`): a claim with too little
 * of that call (or of the lead's turn) left for a review is no claim, and nothing is recorded. The
 * observers get what the call can spare beside a full review; the reviewer what is left. A claim on a
 * run already closing opens no round, and neither does one no engine here can review: nothing is
 * asked, nothing recorded. A check whose run closes under it settles nothing (Genex drops the round),
 * and one whose turn ends while the run goes on is settled as no answer. A reviewer whose check is
 * abandoned is stopped. A yes that no longer speaks for the claim (the build moved while the reviewer
 * read) is settled as no answer. The caller keeps the tally in its run's journal (saved as a round
 * starts); the count of no's is the host's, from its own records.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessCtx, Run } from "../types/harness.d.ts";
import type { DelegateImage, EngineDescriptor, FinishRoundAnswer, HookImage } from "../types/host-api.d.ts";
import type { Evidence } from "./evidence.ts";
import { type CaptureLine, FINISH_ANSWER, reviewerBrief } from "./finish-check-prompts.ts";
import {
  FINISH_REASON_CHARS,
  FinishCheckStep,
  LEAD_CALL_MS,
  MAX_FINISH_REASONS,
  MAX_FINISH_REJECTIONS,
  ObserverSource,
  PROOF_OBSERVER,
} from "./finish-contract.ts";
import { jobLines, judgeLines, type Proof, pictureType, proofNamesOf, readProof } from "./finish-proof.ts";
import { factsOfGame } from "./folder-facts.ts";
import { HostMethod } from "./host-methods.ts";
import { isPlainRecord } from "./json.ts";
import { EngineId, modelOn, RoleKey, roleEffort, roleEngine, supportsSessions } from "./model-roles.ts";
import {
  type Attached,
  type Capture,
  type ObservedGame,
  observeGame,
  pickedImages,
  REVIEW_PICTURE_MAX_BYTES,
  recordCaptures,
} from "./observers.ts";
import { scopeLines } from "./scope-prompts.ts";
import { CLIP_REASON, clipMarked } from "./text.ts";
import { MINUTE_MS, SECOND_MS } from "./time.ts";

/** All the observers at a finish, together, at least (more when the call can spare it beside a full review). */
export const FINISH_OBSERVE_MS = 45 * SECOND_MS;
/** The reviewer's session at most. */
export const FINISH_REVIEW_MS = 3 * MINUTE_MS;
/** Less than this left for the reviewer, and the claim gets no check. */
export const FINISH_REVIEW_MIN_MS = MINUTE_MS;
/** The answer's trip back to the lead, kept free at the end of its call. */
export const CALL_MARGIN_MS = 30 * SECOND_MS;
/** The reviewer's turns at most. */
export const REVIEW_MAX_TURNS = 30;
/** The pictures a reviewer is handed at most: stills first, then play frames. */
export const REVIEW_IMAGES_MAX = 12;
/** How long the lead's claim reads in the brief and the record. */
export const CLAIM_CHARS = 2_000;
/** How long before its turn's end a lead's claim must come for a full review: the observers, the reviewer and the answer's trip. */
export const CLAIM_BEFORE_END_MS = FINISH_OBSERVE_MS + FINISH_REVIEW_MS + CALL_MARGIN_MS;
/** `CLAIM_BEFORE_END_MS` in whole minutes, as a lead is told it. */
export const CLAIM_BEFORE_END_MINUTES = Math.ceil(CLAIM_BEFORE_END_MS / MINUTE_MS);

/** How often a reviewer at work is looked in on: one whose check was abandoned is stopped. */
const REVIEW_WATCH_MS = 2 * SECOND_MS;
/** How many of the person's messages the brief quotes (the newest), and how long each reads. */
const SAID_MAX = 8;
const SAID_CHARS = 1_000;
/** How many of the finish hooks' notes the brief quotes. */
const HOOK_NOTES_MAX = 8;
/** What a reviewer's context spends on one picture, on its reply, and how many characters of its brief make a token. */
const IMAGE_TOKENS = 2_048;
const REPLY_TOKENS = 4_096;
const CHARS_PER_TOKEN = 4;

/** What the records and the lead read of a check: why one got no answer, and the captures' labels. */
const MESSAGE = {
  alreadyChecking: "a reviewer is already checking your claim",
  noEngine: "no engine here can run a reviewer",
  tooSmall: "the reviewer's model can't hold the brief",
  ended: "the Loop ended before the reviewer answered",
  turnEnded: "the lead's turn ended before the reviewer answered",
  noTimeLeft: "the lead's call had no time left for the reviewer",
  stopped: "the Loop was stopped",
  refused: (why: string) => `Genex did not start the reviewer: ${why}`,
  unread: (why: string) => `whether the reviewer's answer still stands could not be read: ${why}`,
  noTime:
    "There was no time left in this call for a reviewer to check your claim, so it is not counted. Call finish again, with nothing else in the same turn.",
  noTimeInTurn:
    "Your turn ends too soon for a reviewer to check your claim, so it is not counted. Call finish early in your next turn, with nothing else in the same turn.",
  proofLabel: "The lead's proof",
  hookLabel: "The game's plugins at the finish",
  proofArtifacts: (round: number) => `finish/proof/r${round}`,
} as const;

/**
 * What a Loop's report says of a claim that did not end in a yes. Its reason stays one fixed phrase
 * (readers tell runs apart by it); what the reviewer found not done goes in the report's `notDone`.
 */
export const FINISH_REPORT = {
  /** The reviewer's no's stopped the Loop. */
  notAccepted: "the reviewer did not accept the finish",
  /** What isn't done, for the report's summary, after the lead's own. */
  summaryNotDone: (reasons: readonly string[]) => `Not done, by the reviewer: ${reasons.join(" ")}`,
  noReviewer: "no engine here can hold a reviewer to check the finish",
  /** The lead claimed in its last turn with no time left for a review. */
  tooLate: "the time ran out before a reviewer could check the lead's claim",
  /** The build the close landed is not the one the reviewer said yes to. */
  movedAfterYes: "the build moved after the reviewer's yes, so the build that landed is not the one it checked",
} as const;

/** What isn't done by the reviewer's last no, one line each, for a report's `notDone`; empty when no no stands. */
export function notDoneOf(tally: FinishTally | null | undefined): string[] {
  return [...(tally?.reasons ?? [])];
}

/** Where a Loop's finish checks stand: kept in the run's journal by the caller. */
export interface FinishTally {
  round: number;
  rejections: number;
  checking: boolean;
  /** The reasons of the reviewer's last no, for the next round's brief and the run's report. */
  reasons: string[];
  /** A claim reached a reviewer since the run last opened (not kept in the journal). */
  asked?: boolean;
}

/** No check yet. */
export function newTally(): FinishTally {
  return { round: 0, rejections: 0, checking: false, reasons: [] };
}

/** A whole number of zero or more. */
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * A tally as the run's journal kept it, so a resumed Loop goes on counting; anything unreadable is a
 * new tally. A check under way when the journal was saved is not under way now.
 */
export function tallyOf(saved: unknown): FinishTally {
  if (!isPlainRecord(saved)) return newTally();
  const { round, rejections, reasons } = saved;
  const texts = Array.isArray(reasons) && reasons.every((reason) => typeof reason === "string");
  if (!isCount(round) || !isCount(rejections) || !texts) return newTally();
  return { round, rejections, checking: false, reasons: [...reasons] };
}

/** Everything a check reads besides the claim: the run, the game, the lead's folder, its tally and its call's clock. */
export interface FinishScope {
  ctx: HarnessCtx;
  run: Run;
  threadId: string;
  game: ObservedGame;
  /** The folder the lead works in and the reviewer reads (the game's, or the lead's copy). */
  leadFolder: string;
  tally: FinishTally;
  now: () => number;
  /** When the lead's `finish` call started (`now()` time). */
  callStarted: number;
  /** What a yes still needs of the call after the check: the close's own time. */
  closeMs: number;
  /** When the lead's own turn ends (`now()` time), if before its call does: the review ends before it. */
  endsBy?: number;
  /** The person's own messages to the Loop, word for word, oldest first. */
  said: readonly string[];
  /** The other messages to the Loop (relayed by the chat's agent, in its words), oldest first. */
  relayed?: readonly string[];
  /** The caller's own preview pass (a lease-aware one), if any. */
  previewPass?: (path: string) => Promise<Evidence | null>;
  /** A wait on `now`'s clock that a test may drive (the observers' deadline, the reviewer's watch); a real timer without. */
  sleep?: (ms: number) => Promise<void>;
  /** Whether the run has ended (or is closing): no round opens then, and one under way records nothing more. */
  ended?: () => boolean;
  /** Whether the claim's own turn is over while the run goes on: its round is recorded with no answer. */
  abandoned?: () => boolean;
  /** Why a yes no longer speaks for the claim (the build moved while the reviewer read), or null: such a yes counts as no answer. */
  lapsed?: () => Promise<string | null>;
  /** Save the tally where the caller keeps it, as a round starts. */
  keep?: () => Promise<unknown>;
}

/**
 * The lead's claim: its summary, what it says is not done yet (read first and whole, apart from the
 * summary's clip), the files it names as proof, and its `finish` hooks' notes and pictures.
 */
export interface FinishClaim {
  summary: string;
  remaining?: readonly string[];
  proof: readonly unknown[];
  hookNotes: readonly string[];
  hookImages: readonly HookImage[];
}

/** A reviewer's yes. */
type Accepted = { step: typeof FinishCheckStep.Accepted; reasons: string[] };
/** A reviewer's no: the no's in a row now, and whether this one stops the Loop. */
type Rejected = { step: typeof FinishCheckStep.Rejected; reasons: string[]; rejections: number; stop: boolean };
/**
 * A check that got no answer, and why; `seatless` when no engine here can hold a reviewer at all,
 * `lapsed` for a yes that no longer speaks for the claim.
 */
type Unanswered = { step: typeof FinishCheckStep.Unanswered; why: string; seatless?: true; lapsed?: true };
/** No time for a check (nothing recorded); `turnEnds` when the lead's turn, not its call, left none. */
export type NoTime = { noTime: true; turnEnds?: true };
/** What a check came to; `noTime` when the claim had no time for one. */
export type FinishOutcome = Accepted | Rejected | Unanswered | NoTime;

/**
 * Where the reviewer runs: the engine, the model it asks for and its effort; whether it may look at
 * app windows (`app_look`, only on an engine that carries a seat), whether its model sees pictures,
 * and its context window in tokens (null when the engine doesn't say).
 */
export interface ReviewerSeat {
  engine: string;
  model: string | undefined;
  effort: string | undefined;
  looks: boolean;
  sees: boolean;
  contextWindow: number | null;
}

const unanswered = (why: string): Unanswered => ({ step: FinishCheckStep.Unanswered, why });

/**
 * Where the reviewer runs: on the Reviewers role's engine and model when that engine holds sessions,
 * else on the run's own engine with the model picked for it (`modelOn`), else nowhere. A copy of the
 * playtester's seat rule (`playtester.ts` `playSeat`, a shipped module that exports none) narrowed to
 * session engines: a reviewer reads files, which only a session can.
 */
export async function reviewerSeat(ctx: HarnessCtx, run: Run): Promise<ReviewerSeat | null> {
  const described = await ctx.call(HostMethod.EngineDescribe, {}).catch(() => []);
  const engines: EngineDescriptor[] = Array.isArray(described) ? described : [];
  const find = (id: string) => engines.find((engine) => engine?.id === id);
  const effort = roleEffort(run, RoleKey.Judge);
  const judge = roleEngine(run, RoleKey.Judge);
  if (supportsSessions(find(judge))) return seatOn(find(judge), run.judgeModel ?? modelOn(run, judge), effort);
  const own = run.engine ?? EngineId.Ollama;
  return supportsSessions(find(own)) ? seatOn(find(own), modelOn(run, own), effort) : null;
}

/** A seat on a described engine: its model's sight and window when the engine lists the model. */
function seatOn(engine: EngineDescriptor | undefined, model: string | undefined, effort: string | undefined) {
  const models = Array.isArray(engine?.models) ? engine.models : [];
  const wanted = model ?? engine?.defaultModel ?? undefined;
  const row = models.find((one) => one?.id === wanted || one?.resolvedModel === wanted);
  const window = typeof row?.contextWindow === "number" && row.contextWindow > 0 ? row.contextWindow : null;
  return {
    engine: String(engine?.id),
    model,
    effort,
    looks: engine?.kind === ENGINE_KIND_DELEGATED,
    sees: row?.supportsVision !== false,
    contextWindow: window,
  };
}

/** The engine kind that carries a seat (and so `app_look`): Claude Code and Codex. */
const ENGINE_KIND_DELEGATED = "delegated";

/** When the lead's call must be done with the check, after the margin and the close. */
const callEnds = (scope: FinishScope): number => scope.callStarted + LEAD_CALL_MS - CALL_MARGIN_MS - scope.closeMs;
/** When the lead's turn ends, less the margin (never, without one). */
const turnEnds = (scope: FinishScope): number => (scope.endsBy ?? Number.POSITIVE_INFINITY) - CALL_MARGIN_MS;

/** What the lead's call (or its turn, when that ends first) has left after the margin and the close, by the scope's clock. */
const callLeft = (scope: FinishScope): number => Math.min(callEnds(scope), turnEnds(scope)) - scope.now();

/** No time for a review after the observers: why, or null when there is time. */
function noTimeFor(scope: FinishScope): NoTime | null {
  if (callLeft(scope) - FINISH_OBSERVE_MS >= FINISH_REVIEW_MIN_MS) return null;
  return turnEnds(scope) < callEnds(scope) ? { noTime: true, turnEnds: true } : { noTime: true };
}

/**
 * How long the observers may look: what the call can spare beside a full review, never less than
 * `FINISH_OBSERVE_MS`, and always leaving the shortest review.
 */
const observeMs = (scope: FinishScope): number => {
  const left = callLeft(scope);
  return Math.min(Math.max(FINISH_OBSERVE_MS, left - FINISH_REVIEW_MS), left - FINISH_REVIEW_MIN_MS);
};

/** What the reviewer is handed and told of: the captures (the lead's proof among them, by index), the proof and the job results. */
interface Gathered {
  captures: Capture[];
  proofAt: Set<number>;
  proof: Proof;
  jobs: string[];
  /** The blind judges' latest answer to each question of the run. */
  judges: string[];
}

/** A finish hook's picture as a reviewer may be handed it: a PNG or a JPEG by its bytes, within the cap; else nothing. */
function hookPicture(image: HookImage): Capture["images"] {
  if (typeof image?.data !== "string" || !image.data) return [];
  const bytes = Buffer.from(image.data, "base64");
  const mimeType = bytes.length <= REVIEW_PICTURE_MAX_BYTES ? pictureType(bytes) : null;
  return mimeType ? [{ name: String(image.name ?? ""), mimeType, data: image.data }] : [];
}

/** The finish hooks' pictures as one capture (handed to the reviewer, never recorded: they have no files). */
function hookCapture(images: readonly HookImage[]): Capture[] {
  const pictures = images.flatMap(hookPicture);
  if (!pictures.length) return [];
  return [
    {
      observer: PROOF_OBSERVER,
      label: MESSAGE.hookLabel,
      source: ObserverSource.Proof,
      images: pictures,
      recording: [],
    },
  ];
}

/**
 * Capture the game (bounded by `FINISH_OBSERVE_MS`), read the lead's proof, the run's job results
 * and its blind judges' answers, and record the captures the harness made (the preview's, and the
 * lead's pictures).
 */
async function gather(scope: FinishScope, claim: FinishClaim): Promise<Gathered> {
  const { ctx, run, threadId } = scope;
  const clock = { now: scope.now, ...(scope.sleep ? { sleep: scope.sleep } : {}) };
  const observeScope = { run, threadId, game: scope.game, previewPass: scope.previewPass, clock };
  const observed = await observeGame(ctx, observeScope, scope.now() + observeMs(scope));
  const proof = await readProof(ctx, run, scope.leadFolder, claim.proof, MESSAGE.proofArtifacts(scope.tally.round));
  const [jobs, judges] = await Promise.all([jobLines(ctx, run), judgeLines(ctx, run, threadId)]);
  const leads: Capture[] = proof.images.length
    ? [
        {
          observer: PROOF_OBSERVER,
          label: MESSAGE.proofLabel,
          source: ObserverSource.Proof,
          images: proof.images,
          recording: [],
        },
      ]
    : [];
  await recordCaptures(ctx, threadId, run.runId, [...observed, ...leads]);
  const proofAt = new Set(leads.map((_, n) => observed.length + n));
  return { captures: [...observed, ...leads, ...hookCapture(claim.hookImages)], proofAt, proof, jobs, judges };
}

/** A capture as the brief tells of it: what was taken, and how much of it the reviewer was handed. */
const captureLine = (capture: Capture, attached: Attached | undefined): CaptureLine => ({
  label: capture.label,
  stills: capture.images.length,
  frames: capture.recording.length,
  attachedStills: attached?.stills ?? 0,
  attachedFrames: attached?.frames ?? 0,
  ...(capture.note ? { note: capture.note } : {}),
  ...(capture.problem ? { problem: capture.problem } : {}),
});

/** The reviewer's brief for this claim, telling of the pictures `attached` (per capture). */
function briefFor(
  scope: FinishScope,
  claim: FinishClaim,
  gathered: Gathered,
  told: { attached: readonly Attached[]; looks: boolean },
): string {
  const quoted = (messages: readonly string[]) =>
    messages.slice(-SAID_MAX).map((message) => clipMarked(message, SAID_CHARS));
  const hookNotes = claim.hookNotes.slice(0, HOOK_NOTES_MAX).map((note) => clipMarked(note, CLIP_REASON));
  return reviewerBrief({
    goal: String(scope.run.goal ?? ""),
    scope: scopeLines(scope.run),
    said: quoted(scope.said),
    relayed: quoted(scope.relayed ?? []),
    claim: clipMarked(claim.summary, CLAIM_CHARS),
    remaining: claim.remaining ?? [],
    proof: gathered.proof,
    hookNotes,
    jobs: gathered.jobs,
    judges: gathered.judges,
    captures: gathered.captures.map((capture, n) => captureLine(capture, told.attached[n])),
    facts: factsOfGame(scope.game),
    folder: scope.leadFolder,
    earlier: scope.tally.reasons,
    looks: told.looks,
  });
}

/**
 * How many pictures the seat can take beside the brief: none for a model that can't see them, as
 * many as its context window holds after the brief and the reply (`REVIEW_IMAGES_MAX` at most);
 * null when even the brief does not fit.
 */
function imagesFitting(seat: ReviewerSeat, brief: string): number | null {
  if (seat.contextWindow === null) return seat.sees ? REVIEW_IMAGES_MAX : 0;
  const room = seat.contextWindow - Math.ceil(brief.length / CHARS_PER_TOKEN) - REPLY_TOKENS;
  if (room < 0) return null;
  return seat.sees ? Math.min(REVIEW_IMAGES_MAX, Math.floor(room / IMAGE_TOKENS)) : 0;
}

/** The reviewer's prompt and pictures, fitted to its seat as the brief stands; null when its model can't hold it. */
function fittedReview(
  scope: FinishScope,
  claim: FinishClaim,
  gathered: Gathered,
  seat: ReviewerSeat,
): { prompt: string; images: DelegateImage[] } | null {
  const all = gathered.captures.map((capture) => ({ stills: capture.images.length, frames: capture.recording.length }));
  const fitting = imagesFitting(seat, briefFor(scope, claim, gathered, { attached: all, looks: seat.looks }));
  if (fitting === null) return null;
  const { images, attached } = pickedImages(gathered.captures, fitting, gathered.proofAt);
  return { prompt: briefFor(scope, claim, gathered, { attached, looks: seat.looks }), images };
}

/**
 * The briefs a reviewer may be handed, fullest first: as gathered; without the proof's excerpts
 * (the reviewer reads the files it names in the folder itself); and without the finish hooks' notes too.
 */
function briefCuts(claim: FinishClaim, gathered: Gathered): Array<{ claim: FinishClaim; gathered: Gathered }> {
  const { proof } = gathered;
  if (!proof.texts.length && !claim.hookNotes.length) return [{ claim, gathered }];
  const noExcerpts = { ...gathered, proof: { ...proof, texts: [], excerptsCut: proof.texts.length > 0 } };
  return [
    { claim, gathered },
    { claim, gathered: noExcerpts },
    { claim: { ...claim, hookNotes: [] }, gathered: noExcerpts },
  ];
}

/**
 * The reviewer's prompt and pictures, fitted to its seat: the fullest brief its model holds (the
 * proof's excerpts, then the hooks' notes, go first); null when even the shortest does not fit.
 */
function reviewFor(
  scope: FinishScope,
  claim: FinishClaim,
  gathered: Gathered,
  seat: ReviewerSeat,
): { prompt: string; images: DelegateImage[] } | null {
  for (const cut of briefCuts(claim, gathered)) {
    const review = fittedReview(scope, cut.claim, cut.gathered, seat);
    if (review) return review;
  }
  return null;
}

/** Whether the check no longer counts: its run is closing, or its turn is over. */
const checkOver = (scope: FinishScope): boolean => Boolean(scope.ended?.() || scope.abandoned?.());

/** A real wait of `ms`, which keeps no process alive. */
const realWait = (ms: number): Promise<void> => delay(ms, undefined, { ref: false });

/**
 * Looks in on the reviewer while it works, every `REVIEW_WATCH_MS` on the scope's clock: once its
 * check is abandoned (`checkOver`), the host stops the run's reviewer, so no session outlives the
 * check it was asked for. Answers the watch's end.
 */
function watchReviewer(scope: FinishScope): () => void {
  const { ctx, run } = scope;
  const wait = scope.sleep ?? realWait;
  let watching = true;
  void (async () => {
    while (watching) {
      await wait(REVIEW_WATCH_MS);
      if (!watching || !checkOver(scope)) continue;
      watching = false;
      await ctx.call(HostMethod.EngineAbort, { project: run.project, reviewer: run.runId }).catch(() => {});
    }
  })();
  return () => {
    watching = false;
  };
}

/** The host's answer to a review: the round it recorded and the reviewer's yes, no or no answer. */
type HostAnswer = FinishRoundAnswer;

/** What a review asks of the host: the seat, the brief and its pictures, the reviewer's time, the claim, the proof's names and the observers read. */
interface ReviewAsk {
  seat: ReviewerSeat;
  prompt: string;
  images: DelegateImage[];
  timeoutMs: number;
  claim: FinishClaim;
  observers: string[];
}

/** Ask Genex to review the claim (it seats the reviewer read-only, records the round and holds the answer); no answer when it refuses. */
async function askReview(scope: FinishScope, ask: ReviewAsk): Promise<HostAnswer | Unanswered> {
  const { ctx, run } = scope;
  if (ctx.cancelled) return unanswered(MESSAGE.stopped);
  const stopWatching = watchReviewer(scope);
  try {
    return await ctx.call(HostMethod.FinishReview, {
      project: run.project,
      runId: run.runId,
      engine: ask.seat.engine,
      ...(ask.seat.model ? { model: ask.seat.model } : {}),
      ...(ask.seat.effort ? { effort: ask.seat.effort } : {}),
      prompt: ask.prompt,
      images: ask.images,
      reads: scope.leadFolder,
      timeoutMs: ask.timeoutMs,
      maxTurns: REVIEW_MAX_TURNS,
      claim: clipMarked(ask.claim.summary, CLAIM_CHARS),
      proof: proofNamesOf(ask.claim.proof),
      observers: ask.observers,
    });
  } catch (err) {
    return unanswered(MESSAGE.refused(clipMarked((err as Error)?.message ?? err, CLIP_REASON)));
  } finally {
    stopWatching();
  }
}

/** Whether a round's answer came from Genex (a round it holds), not from a check that asked nothing. */
const fromHost = (answer: HostAnswer | Unanswered): answer is HostAnswer => "round" in answer;

/**
 * A round up to the host's held answer: no seat (no engine, or a model too small for the brief), no
 * time left after the observers, or a check over before asking: nothing asked, nothing recorded.
 */
async function runRound(scope: FinishScope, claim: FinishClaim): Promise<HostAnswer | Unanswered> {
  const seat = await reviewerSeat(scope.ctx, scope.run);
  if (!seat) return { ...unanswered(MESSAGE.noEngine), seatless: true };
  const gathered = await gather(scope, claim);
  const observers = [...new Set(gathered.captures.map((capture) => capture.observer))];
  const timeoutMs = Math.min(FINISH_REVIEW_MS, callLeft(scope));
  if (timeoutMs < FINISH_REVIEW_MIN_MS) return unanswered(MESSAGE.noTimeLeft);
  const review = reviewFor(scope, claim, gathered, seat);
  if (!review) return { ...unanswered(MESSAGE.tooSmall), seatless: true };
  if (checkOver(scope)) return unanswered(MESSAGE.ended);
  return askReview(scope, { seat, ...review, timeoutMs, claim, observers });
}

/**
 * Why the held answer no longer stands, or null when it does: the claim's turn is over (the run goes
 * on), the harness was stopped, or a yes no longer speaks for the claim (`lapsed`).
 */
async function notStanding(scope: FinishScope, held: HostAnswer): Promise<{ why: string; lapsed?: true } | null> {
  if (scope.abandoned?.()) return { why: MESSAGE.turnEnded };
  if (scope.ctx.cancelled) return { why: MESSAGE.stopped };
  if (held.step !== FinishCheckStep.Accepted || !scope.lapsed) return null;
  const why = await scope.lapsed();
  return why ? { why, lapsed: true } : null;
}

/** The settled round as the lead's outcome, counted into the tally as the host counted it. */
function outcomeOf(
  tally: FinishTally,
  settled: HostAnswer & { rejections: number; stopped: boolean },
  lapsed: boolean,
): Accepted | Rejected | Unanswered {
  tally.round = Math.max(tally.round, settled.round);
  tally.rejections = settled.rejections;
  const reasons = (settled.reasons ?? []).slice(0, MAX_FINISH_REASONS);
  if (settled.step === FinishCheckStep.Accepted) {
    tally.reasons = [];
    return { step: FinishCheckStep.Accepted, reasons };
  }
  if (settled.step === FinishCheckStep.Rejected) {
    tally.reasons = reasons;
    return { step: FinishCheckStep.Rejected, reasons, rejections: settled.rejections, stop: settled.stopped };
  }
  const answer = unanswered(settled.why ?? MESSAGE.ended);
  return lapsed ? { ...answer, lapsed: true } : answer;
}

/** Settle the round Genex holds, as no answer when it no longer stands; the host's count comes back with it. */
async function settleRound(scope: FinishScope, held: HostAnswer): Promise<Accepted | Rejected | Unanswered> {
  const { ctx, run, tally } = scope;
  // Settled whatever happens once Genex holds an answer: one whose standing can't be read is no answer.
  const fallen: { why: string; lapsed?: true } | null = await notStanding(scope, held).catch((err: unknown) => ({
    why: MESSAGE.unread(clipMarked((err as Error)?.message ?? err, CLIP_REASON)),
  }));
  // A run that ended under the check is closed: Genex dropped its round, and nothing more is recorded.
  if (scope.ended?.()) return unanswered(MESSAGE.ended);
  const settled = await ctx
    .call(HostMethod.FinishSettle, {
      project: run.project,
      runId: run.runId,
      round: held.round,
      ...(fallen ? { unanswered: clipMarked(fallen.why, FINISH_REASON_CHARS) } : {}),
    })
    .catch(() => null);
  if (!settled) return unanswered(MESSAGE.ended);
  return outcomeOf(tally, settled, fallen?.lapsed === true);
}

/**
 * Check the lead's claim (see the module's header): a check already under way answers that it is;
 * a claim on a run already closing, or from a turn already over, opens no round; a claim with less
 * than `FINISH_REVIEW_MIN_MS` of the call (or the turn) left for a review after the observers is
 * `noTime`, and nothing is recorded. Otherwise one round, asked of Genex and settled.
 */
export async function checkFinish(scope: FinishScope, claim: FinishClaim): Promise<FinishOutcome> {
  const { tally } = scope;
  if (tally.checking) return unanswered(MESSAGE.alreadyChecking);
  if (scope.ended?.() || scope.ctx.cancelled) return unanswered(MESSAGE.ended);
  if (scope.abandoned?.()) return unanswered(MESSAGE.turnEnded);
  const noTime = noTimeFor(scope);
  if (noTime) return noTime;
  tally.round += 1;
  tally.checking = true;
  try {
    // The round's number (its proof's folder) is kept before the round starts, so a resumed Loop never reuses it.
    await scope.keep?.().catch(() => {});
    const answer = await runRound(scope, claim);
    if (!fromHost(answer)) return answer;
    tally.asked = true;
    return await settleRound(scope, answer);
  } finally {
    tally.checking = false;
  }
}

/** What the lead is answered after a check. */
export function finishAnswer(outcome: FinishOutcome): string {
  if ("noTime" in outcome) return outcome.turnEnds ? MESSAGE.noTimeInTurn : MESSAGE.noTime;
  if (outcome.step === FinishCheckStep.Accepted) return FINISH_ANSWER.accepted(outcome.reasons);
  if (outcome.step === FinishCheckStep.Unanswered) return FINISH_ANSWER.unanswered(outcome.why);
  if (outcome.stop) return FINISH_ANSWER.stopped(MAX_FINISH_REJECTIONS, outcome.reasons);
  return FINISH_ANSWER.rejected(outcome.rejections, MAX_FINISH_REJECTIONS, outcome.reasons);
}
