/**
 * Genex's review of a game's apps and its takedown, read into one {@link GenexReviewRecord}: from
 * `genex review --json` on a CLI that has it (1.39.0 and later), else from the API's own answer for
 * the game's apps (`GET /api/games/:id/native-builds`, which the pinned CLI's `native list --json`
 * cuts down to `builds` alone) beside the owner read of the game. Every value is the API's: nothing
 * Studio does not know is kept, no English is matched, and the caps every client shares hold. An
 * older API reads as today: a held app is checked, a turned-down one has its reason as its one thing,
 * and a takedown known only by `takedownAt` is still one.
 */
import cliPackage from "@genex-ai/cli-demo/package.json" with { type: "json" };
import {
  GenexAppReview,
  GenexDecider,
  GenexHumanReview,
  type GenexHumanReviewView,
  GenexPersonWhy,
  type GenexReviewApp,
  type GenexReviewRecord,
  GenexReviewReadProblem,
  GenexReviewRefusal,
  type GenexReviewRequestAnswer,
  GenexReviewStage,
  type GenexReviewStatus,
  type GenexReviewTold,
  type GenexReviewThing,
  type GenexSentReviewDetail,
  type GenexTakedown,
  gameReviewOf,
  isOpenReview,
  OLD_APPEAL_NOTE_MIN,
  REVIEW_NOTE_CHARS,
  REVIEW_TEXT_CHARS,
  REVIEW_THINGS_MAX,
  REVIEW_WHERE_CHARS,
  reviewFingerprint,
} from "../../shared/genex-review.ts";
import { GenexBuildReview, type GenexNativeSent } from "../../shared/genex.ts";
import { isAtLeast } from "./cli-version.ts";

/** The first Genex CLI with `genex review`: an older pin reads the API's answer itself. */
export const REVIEW_CLI = [1, 39, 0] as const;
/** The most apps one game's answer is read for: a Mac app, a Windows and a Linux one, each twice over. */
const APPS_MAX = 6;
/** The most characters of a rule's name kept. */
const RULE_CHARS = 80;

/** Whether CLI `version` has `genex review`. */
export const takesReviewCommand = (version: string): boolean => isAtLeast(version, REVIEW_CLI);

/** Whether the CLI Studio ships, the version this build pins, has `genex review`. */
export const pinnedCliReviews = (): boolean => takesReviewCommand(cliPackage.version);

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row => typeof value === "object" && value !== null;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const words = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};
const stamp = (value: unknown): string | undefined =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;

/** A value of `vocabulary`, or undefined. */
function oneOf<T extends string>(vocabulary: Readonly<Record<string, T>>, value: unknown): T | undefined {
  return (Object.values(vocabulary) as unknown[]).includes(value) ? (value as T) : undefined;
}

/** One thing to fix as Studio keeps it, or null for one with no text. */
function thingOf(raw: unknown): GenexReviewThing | null {
  if (!isRecord(raw)) return null;
  const text = words(raw.text, REVIEW_TEXT_CHARS);
  if (!text) return null;
  const where = words(raw.where, REVIEW_WHERE_CHARS);
  const rule = words(raw.rule, RULE_CHARS);
  return { text, ...(where ? { where } : {}), ...(rule ? { rule } : {}) };
}

/** The things to fix, each with text, at most {@link REVIEW_THINGS_MAX}. */
const thingsOf = (raw: unknown): GenexReviewThing[] =>
  rows(raw)
    .map(thingOf)
    .filter((thing): thing is GenexReviewThing => thing !== null)
    .slice(0, REVIEW_THINGS_MAX);

/** A request for a person as the API answers it; none, and no request allowed, for anything else. */
function humanReviewOf(raw: unknown): GenexHumanReviewView {
  const review = isRecord(raw) ? raw : {};
  const state = oneOf(GenexHumanReview, review.state) ?? GenexHumanReview.None;
  const requestedAt = stamp(review.requestedAt);
  const expectedBy = stamp(review.expectedBy);
  const decidedAt = stamp(review.decidedAt);
  const reply = words(review.reply, REVIEW_NOTE_CHARS);
  return {
    state,
    canRequest: review.canRequest === true,
    ...(requestedAt ? { requestedAt } : {}),
    ...(expectedBy ? { expectedBy } : {}),
    ...(review.resend === true ? { resend: true } : {}),
    ...(decidedAt ? { decidedAt } : {}),
    ...(reply ? { reply } : {}),
  };
}

/** A sent build's review detail as `native.json` keeps it, or undefined for one Studio does not know. */
export function reviewDetailOf(raw: unknown): GenexSentReviewDetail | undefined {
  if (!isRecord(raw)) return undefined;
  const stage = oneOf(GenexReviewStage, raw.stage);
  if (!stage) return undefined;
  const decidedBy = oneOf(GenexDecider, raw.decidedBy);
  const decidedAt = stamp(raw.decidedAt);
  return { stage, ...(decidedBy ? { decidedBy } : {}), ...(decidedAt ? { decidedAt } : {}) };
}

/** What every app row carries: where it is for, its version and build, or null when it lacks one. */
function rowFacts(row: Row) {
  const platform = words(row.platform, RULE_CHARS);
  const arch = words(row.arch, RULE_CHARS);
  const version = words(row.version, RULE_CHARS);
  if (!platform || !arch || !version) return null;
  const sha256 = words(row.sha256, 64);
  return { platform, arch, version, ...(sha256 ? { sha256 } : {}) };
}

/** A held app's state by its stage: an API with none says nothing more than that it is held. */
const heldState = (detail: Row): GenexAppReview =>
  detail.stage === GenexReviewStage.Person ? GenexAppReview.WithPerson : GenexAppReview.Checking;

/** The rest of a review's detail: who decides next and why. */
function nextOf(detail: Row): Pick<GenexReviewApp, "nextReviewBy" | "nextReviewWhy"> {
  const nextReviewBy = oneOf(GenexDecider, detail.nextReviewBy);
  const nextReviewWhy = nextReviewBy === GenexDecider.Person ? oneOf(GenexPersonWhy, detail.nextReviewWhy) : undefined;
  return { ...(nextReviewBy ? { nextReviewBy } : {}), ...(nextReviewWhy ? { nextReviewWhy } : {}) };
}

/** A submission row (held or turned down) as an app's review, or null for one Studio does not know. */
function submissionApp(row: Row): GenexReviewApp | null {
  const facts = rowFacts(row);
  const review = row.review;
  const heldOrDown = review === GenexBuildReview.Pending || review === GenexBuildReview.Rejected;
  if (!facts || !heldOrDown) return null;
  const known = isRecord(row.reviewDetail) && reviewDetailOf(row.reviewDetail) !== undefined;
  const detail: Row = known && isRecord(row.reviewDetail) ? row.reviewDetail : {};
  const sentAt = stamp(row.publishedAt);
  const decidedAt = stamp(detail.decidedAt);
  const decidedBy = oneOf(GenexDecider, detail.decidedBy);
  const common = {
    ...facts,
    ...(sentAt ? { sentAt } : {}),
    humanReview: humanReviewOf(detail.humanReview),
    ...nextOf(detail),
  };
  if (review === GenexBuildReview.Pending) return { ...common, state: heldState(detail), things: [] };
  const reason = words(row.reviewReason, REVIEW_TEXT_CHARS);
  const listed = thingsOf(detail.things);
  const things = listed.length > 0 ? listed : [{ text: reason ?? "" }].filter((thing) => thing.text);
  const reply = decidedBy === GenexDecider.Person ? words(detail.reply, REVIEW_NOTE_CHARS) : undefined;
  return {
    ...common,
    state: GenexAppReview.NotApproved,
    ...(decidedAt ? { decidedAt } : {}),
    ...(decidedBy ? { decidedBy } : {}),
    ...(reply ? { reply } : {}),
    things,
  };
}

/** A live build row as an app's review: an admin's (no `review`) is live as well as an approved one. */
function liveApp(row: Row): GenexReviewApp | null {
  const facts = rowFacts(row);
  const live = row.review === undefined || row.review === GenexBuildReview.Approved;
  if (!facts || !live) return null;
  const detail = reviewDetailOf(row.reviewDetail);
  const sentAt = stamp(row.publishedAt);
  const decidedAt = detail?.decidedAt ?? sentAt;
  return {
    ...facts,
    state: GenexAppReview.Live,
    ...(sentAt ? { sentAt } : {}),
    ...(decidedAt ? { decidedAt } : {}),
    ...(detail?.decidedBy ? { decidedBy: detail.decidedBy } : {}),
    things: [],
    humanReview: { state: GenexHumanReview.None, canRequest: false },
  };
}

const pairOf = (app: Pick<GenexReviewApp, "platform" | "arch">) => `${app.platform}/${app.arch}`;
const sentTime = (app: GenexReviewApp | undefined) => Date.parse(app?.sentAt ?? "") || 0;

/**
 * Each app of the API's answer: its newest submission while that is newer than its live build (the
 * build players keep beside it), else the live build.
 */
function appsOfNative(answer: unknown): GenexReviewApp[] {
  const native = isRecord(answer) ? answer : {};
  const live = byPair(rows(native.builds).map(liveApp));
  const held = byPair(rows(native.submissions).map(submissionApp));
  const apps: GenexReviewApp[] = [];
  for (const pair of new Set([...live.keys(), ...held.keys()])) {
    const app = appOfPair(live.get(pair), held.get(pair));
    if (app) apps.push(app);
  }
  return apps.slice(0, APPS_MAX);
}

/** Each pair's newest app of `apps`. */
function byPair(apps: ReadonlyArray<GenexReviewApp | null>): Map<string, GenexReviewApp> {
  const newest = new Map<string, GenexReviewApp>();
  for (const app of apps) if (app && sentTime(app) >= sentTime(newest.get(pairOf(app)))) newest.set(pairOf(app), app);
  return newest;
}

/** One pair's review: its submission while that is newer than its live build (kept as what players have), else the build. */
function appOfPair(players: GenexReviewApp | undefined, sent: GenexReviewApp | undefined): GenexReviewApp | undefined {
  if (!sent || sentTime(sent) < sentTime(players)) return players;
  return players ? { ...sent, players: { version: players.version, since: players.sentAt ?? "" } } : sent;
}

/** A takedown the owner read names (`takedown`), or one an older API gives only as `takedownAt`. */
export function takedownOf(project: unknown): GenexTakedown | null {
  if (!isRecord(project)) return null;
  if ("takedown" in project) return newTakedown(project.takedown);
  const at = stamp(project.takedownAt);
  if (!at) return null;
  const detail = words(project.moderationDetail, REVIEW_TEXT_CHARS);
  return {
    at,
    things: detail ? [{ text: detail }] : [],
    appealable: true,
    humanReview: { state: GenexHumanReview.None, canRequest: true },
    noteMin: OLD_APPEAL_NOTE_MIN,
  };
}

/** The owner read's own `takedown`: null, or one taken down at a known time. */
function newTakedown(raw: unknown): GenexTakedown | null {
  if (!isRecord(raw)) return null;
  const at = stamp(raw.at);
  if (!at) return null;
  const appealable = raw.appealable === true;
  const rule = appealable ? words(raw.rule, RULE_CHARS) : undefined;
  const humanReview = humanReviewOf(raw.humanReview);
  const noteMin = raw.noteMin === OLD_APPEAL_NOTE_MIN ? { noteMin: OLD_APPEAL_NOTE_MIN } : {};
  return {
    at,
    ...(rule ? { rule } : {}),
    things: appealable ? thingsOf(raw.things) : [],
    appealable,
    humanReview: appealable ? humanReview : { ...humanReview, canRequest: false },
    ...noteMin,
  };
}

/** One app of `genex review --json`, or null for one whose state Studio does not know. */
function reviewedApp(raw: Row): GenexReviewApp | null {
  const facts = rowFacts(raw);
  const state = oneOf(GenexAppReview, raw.state);
  if (!facts || !state) return null;
  const sentAt = stamp(raw.sentAt);
  const decidedAt = stamp(raw.decidedAt);
  const decidedBy = oneOf(GenexDecider, raw.decidedBy);
  const reply = decidedBy === GenexDecider.Person ? words(raw.reply, REVIEW_NOTE_CHARS) : undefined;
  const players = isRecord(raw.players) ? raw.players : null;
  const keeps = players ? { version: words(players.version, RULE_CHARS), since: stamp(players.since) } : null;
  return {
    ...facts,
    state,
    ...(sentAt ? { sentAt } : {}),
    ...(decidedAt ? { decidedAt } : {}),
    ...(decidedBy ? { decidedBy } : {}),
    things: state === GenexAppReview.NotApproved ? thingsOf(raw.things) : [],
    ...(reply ? { reply } : {}),
    humanReview: humanReviewOf(raw.humanReview),
    ...nextOf(raw),
    ...(keeps?.version ? { players: { version: keeps.version, since: keeps.since ?? "" } } : {}),
  };
}

/** Where a game's review is read from: the CLI's `genex review --json`, or the API's answer and the owner read. */
export type ReviewSource = { review: unknown } | { native: unknown; project: unknown };

/** The game's review from either source; null when the CLI's answer is not a review at all. */
export function reviewRecordOf(source: ReviewSource): GenexReviewRecord | null {
  if ("review" in source) {
    const answer = source.review;
    if (!isRecord(answer)) return null;
    const apps = rows(answer.apps)
      .map(reviewedApp)
      .filter((app): app is GenexReviewApp => app !== null)
      .slice(0, APPS_MAX);
    const takedown = isRecord(answer.takedown) ? newTakedown(answer.takedown) : null;
    return { state: gameReviewOf(apps, takedown), apps, takedown };
  }
  const apps = appsOfNative(source.native);
  const takedown = takedownOf(source.project);
  return { state: gameReviewOf(apps, takedown), apps, takedown };
}

/** The file beside a game's publish record that keeps its review: `publish/<game>/review.json`. */
export const REVIEW_FILE = "review.json";

/** Where a kept review was read from: the CLI's `genex review`, or the API's answer for the apps. */
export const ReviewReadSource = { Review: "review", List: "list" } as const;
export type ReviewReadSource = (typeof ReviewReadSource)[keyof typeof ReviewReadSource];

/** Failed reads in a row after which a game's review shows as offline. */
const OFFLINE_AFTER = 2;

/** `review.json`: the last record read, when and from where, how the reads since went, and what the host told. */
export interface ReviewSaved {
  checkedAt: string | null;
  source: ReviewReadSource | null;
  record: GenexReviewRecord | null;
  fingerprint: string | null;
  told: GenexReviewTold | null;
  /** Failed reads in a row since the last that came back. */
  failures: number;
  /** The last read was refused for its sign-in. */
  signedOut: boolean;
}

/** What the host last told, as a `review-status` call names it, or null for anything that is not one. */
export function toldOf(raw: unknown): GenexReviewTold | null {
  if (!isRecord(raw) || typeof raw.fingerprint !== "string" || !isRecord(raw.keys)) return null;
  const keys: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.keys)) if (typeof value === "string") keys[key] = value;
  return { fingerprint: raw.fingerprint, keys };
}

/** A kept record read again: each app and the takedown through the same checks as Genex's answer. */
function keptRecord(raw: unknown): GenexReviewRecord | null {
  if (!isRecord(raw)) return null;
  return reviewRecordOf({ review: raw });
}

/** `review.json` as read: anything that is not a kept review is none. */
export function readReviewSaved(raw: unknown): ReviewSaved {
  const saved = isRecord(raw) ? raw : {};
  const record = keptRecord(saved.record);
  return {
    checkedAt: stamp(saved.checkedAt) ?? null,
    source: oneOf(ReviewReadSource, saved.source) ?? null,
    record,
    fingerprint: record ? reviewFingerprint(record) : null,
    told: toldOf(saved.told),
    failures: typeof saved.failures === "number" && saved.failures > 0 ? Math.floor(saved.failures) : 0,
    signedOut: saved.signedOut === true,
  };
}

/** A read that came back: the new record, its fingerprint, and the failures and sign-out cleared. */
export const readCameBack = (
  saved: ReviewSaved,
  record: GenexReviewRecord,
  source: ReviewReadSource,
  at: string,
): ReviewSaved => ({
  ...saved,
  checkedAt: at,
  source,
  record,
  fingerprint: reviewFingerprint(record),
  failures: 0,
  signedOut: false,
});

/** A read that failed: the last record kept, one more failure, and whether the sign-in was refused. */
export const readFailed = (saved: ReviewSaved, signedOut: boolean): ReviewSaved => ({
  ...saved,
  failures: saved.failures + 1,
  signedOut,
});

/** What `review-status` answers from what is kept. */
export function reviewStatusOf(saved: ReviewSaved, connected: boolean, publishing: boolean): GenexReviewStatus {
  const problem = reviewProblem(saved, connected);
  return {
    record: saved.record,
    checkedAt: saved.checkedAt,
    connected,
    ...(problem ? { problem } : {}),
    failures: saved.failures,
    open: isOpenReview(saved.record),
    fingerprint: saved.fingerprint,
    told: saved.told,
    publishing,
  };
}

/**
 * A `review-status` answer as it crossed from the plugin: each field through the same checks as
 * `review.json`, or null for anything that is not one.
 */
export function readReviewStatus(raw: unknown): GenexReviewStatus | null {
  if (!isRecord(raw) || !("record" in raw) || typeof raw.connected !== "boolean") return null;
  const record = keptRecord(raw.record);
  const problem = oneOf(GenexReviewReadProblem, raw.problem);
  const failures = typeof raw.failures === "number" && raw.failures > 0 ? Math.floor(raw.failures) : 0;
  return {
    record,
    checkedAt: stamp(raw.checkedAt) ?? null,
    connected: raw.connected,
    ...(problem ? { problem } : {}),
    failures,
    open: isOpenReview(record),
    fingerprint: record ? reviewFingerprint(record) : null,
    told: toldOf(raw.told),
    publishing: raw.publishing === true,
  };
}

/** A `review-request` answer as it crossed from the plugin, or null for anything that is not one. */
export function readRequestAnswer(raw: unknown): GenexReviewRequestAnswer | null {
  if (!isRecord(raw) || typeof raw.takedown !== "boolean") return null;
  const requested = rows(raw.requested).flatMap((row) => {
    const platform = words(row.platform, RULE_CHARS);
    const arch = words(row.arch, RULE_CHARS);
    return platform && arch ? [{ platform, arch, resend: row.resend === true }] : [];
  });
  const refused = oneOf(GenexReviewRefusal, raw.refused);
  return { requested, takedown: raw.takedown, ...(refused ? { refused } : {}) };
}

/** Why the review shown may be old: signed out, or the reads keep failing. */
function reviewProblem(saved: ReviewSaved, connected: boolean): GenexReviewReadProblem | undefined {
  if (!connected || saved.signedOut) return GenexReviewReadProblem.SignedOut;
  return saved.failures >= OFFLINE_AFTER ? GenexReviewReadProblem.Offline : undefined;
}

/** The apps a request for a person asks about: those that allow one, or the one pair named. */
export function requestedApps(record: GenexReviewRecord | null, platform: unknown, arch: unknown): GenexReviewApp[] {
  const named = (app: GenexReviewApp) =>
    (typeof platform !== "string" || app.platform === platform) && (typeof arch !== "string" || app.arch === arch);
  return (record?.apps ?? []).filter((app) => app.humanReview.canRequest && named(app));
}

/** Genex's refusal of a request for a person, by its code; undefined for any other failure. */
export function refusalOf(code: string | undefined): GenexReviewRefusal | undefined {
  return oneOf(GenexReviewRefusal, code);
}

/** Each app state as the sent record's review says it. */
const SENT_REVIEW: Record<GenexAppReview, GenexBuildReview> = {
  [GenexAppReview.Live]: GenexBuildReview.Approved,
  [GenexAppReview.Checking]: GenexBuildReview.Pending,
  [GenexAppReview.WithPerson]: GenexBuildReview.Pending,
  [GenexAppReview.NotApproved]: GenexBuildReview.Rejected,
};

/** When a build was sent, as a time to compare; NaN when unknown. */
const sentMs = (at: string | undefined): number => Date.parse(at ?? "");

/**
 * Whether the kept review's `known` app is the very build a publish sent (`app`): its archive when both
 * name one, else the time it was sent. A build sent after the review was read is never it: a fix sent
 * again with the same version is a new build Genex has not said anything of yet.
 */
function sameSentBuild(known: GenexReviewApp, app: GenexNativeSent): boolean {
  const pair = known.platform === app.platform && known.arch === app.arch && known.version === app.version;
  if (!pair || sentMs(app.publishedAt) > sentMs(known.sentAt)) return false;
  if (known.sha256 && app.sha256) return known.sha256 === app.sha256;
  return sentMs(known.sentAt) === sentMs(app.publishedAt);
}

/**
 * The apps a publish sent, each with Genex's later word on it from the kept review (the same build:
 * its archive, else when it was sent), so its row says where it stands now. A build Genex did not
 * review (an admin's) and one the review does not name, a newer send among them, stay as they were sent.
 */
export function sentWithReview(sent: readonly GenexNativeSent[], record: GenexReviewRecord | null): GenexNativeSent[] {
  if (!record) return [...sent];
  return sent.map((app) => {
    const known = record.apps.find((one) => sameSentBuild(one, app));
    if (!known || app.review === undefined) return app;
    const review = SENT_REVIEW[known.state];
    const reason = known.things[0]?.text;
    const { reviewReason: _earlier, ...rest } = app;
    return { ...rest, review, ...(review === GenexBuildReview.Rejected && reason ? { reviewReason: reason } : {}) };
  });
}
