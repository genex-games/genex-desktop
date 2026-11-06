/**
 * Genex's review of a game's Mac, Windows and Linux apps, and a moderator's takedown of the whole game,
 * as Studio reads them: the plugin's `review-status` answer, the host's `genex_review` records, the
 * Publish dialog's card and the chat's. Web games keep today's publishing and check: nothing here
 * reviews a web game. Browser-safe: the renderer, main and the Genex plugin share it.
 *
 * Genex reviews an app anyone but an admin sends: it is held while an automatic check reads it
 * (usually a few minutes), and a person decides when the check could not or the creator asked.
 * Genex does not check public games again in the background; a takedown comes back only when a
 * person puts it back.
 */

/** The most things to fix a creator is shown, in every client. */
export const REVIEW_THINGS_MAX = 10;
/** How many things a card shows before "Show {n} more". */
export const REVIEW_THINGS_SHOWN = 3;
/** The most characters of one thing's text kept. */
export const REVIEW_TEXT_CHARS = 200;
/** The most characters of where a thing is kept. */
export const REVIEW_WHERE_CHARS = 120;
/** The most characters of a person's reply or the creator's note kept. */
export const REVIEW_NOTE_CHARS = 500;
/** Past this many characters, Request human review shows a counter. */
export const REVIEW_NOTE_COUNTER_AT = 400;
/** What an old API asks of a takedown's note before it opens a request: at least this many characters. */
export const OLD_APPEAL_NOTE_MIN = 20;

/** Where one app stands with Genex. Wire values: persisted in `review.json`; never rename one. */
export const GenexAppReview = {
  Live: "live",
  Checking: "checking",
  WithPerson: "with_person",
  NotApproved: "not_approved",
} as const;
export type GenexAppReview = (typeof GenexAppReview)[keyof typeof GenexAppReview];

/**
 * Where a game stands with Genex, worst first: its headline is its worst app's state, or its
 * takedown. `sending` is Studio's own (its apps job runs). Wire values: never rename one.
 */
export const GenexGameReview = {
  TakenDown: "taken_down",
  NotApproved: "not_approved",
  WithPerson: "with_person",
  Checking: "checking",
  Sending: "sending",
  Live: "live",
  NotPublished: "not_published",
} as const;
export type GenexGameReview = (typeof GenexGameReview)[keyof typeof GenexGameReview];

/** The game states in the order the headline takes them: the first one any app is in wins. */
const GAME_ORDER: readonly GenexGameReview[] = Object.values(GenexGameReview);

/** Who decided an app: Genex's automatic check, or a person at Genex. Wire values: never rename one. */
export const GenexDecider = { Check: "check", Person: "person" } as const;
export type GenexDecider = (typeof GenexDecider)[keyof typeof GenexDecider];

/**
 * Where Genex holds a sent app, as the API's `reviewDetail.stage` says: the automatic check reads it,
 * a person reviews it, or it is decided. Wire values: never rename one.
 */
export const GenexReviewStage = { Checking: "checking", Person: "person", Decided: "decided" } as const;
export type GenexReviewStage = (typeof GenexReviewStage)[keyof typeof GenexReviewStage];

/** What Studio keeps of a sent app's review detail beside it in `native.json`. */
export interface GenexSentReviewDetail {
  stage: GenexReviewStage;
  decidedBy?: GenexDecider;
  decidedAt?: string;
}

/** Why a person reviews an app's next build. Wire values: never rename one. */
export const GenexPersonWhy = { Requested: "requested", Repeated: "repeated" } as const;
export type GenexPersonWhy = (typeof GenexPersonWhy)[keyof typeof GenexPersonWhy];

/**
 * Where a creator's request for a person stands. An app's request is answered when a person
 * decided after it; a takedown's is denied when a person kept it down (a granted one lifts it).
 * Wire values: never rename one.
 */
export const GenexHumanReview = {
  None: "none",
  Requested: "requested",
  Answered: "answered",
  Denied: "denied",
} as const;
export type GenexHumanReview = (typeof GenexHumanReview)[keyof typeof GenexHumanReview];

/** One thing to fix, written to the creator: never Genex's prompt, evidence or findings for admins. */
export interface GenexReviewThing {
  text: string;
  /** Where it is: a screen ("Garage → Get coins") or a path in the build. */
  where?: string;
  /** The rule it breaks, as Genex names it ("Off-platform payment"). */
  rule?: string;
}

/** The creator's request for a person, and whether they may ask now. */
export interface GenexHumanReviewView {
  state: GenexHumanReview;
  canRequest: boolean;
  requestedAt?: string;
  /** When a person is due to answer: the request and Genex's day for it. */
  expectedBy?: string;
  /** The request waits for the app to be sent again: Genex keeps no copy of a turned-down build. */
  resend?: boolean;
  /** A person's answer to a takedown's request, when one came. */
  decidedAt?: string;
  reply?: string;
}

/** One app's review, by its platform and processor. */
export interface GenexReviewApp {
  platform: string;
  arch: string;
  state: GenexAppReview;
  version: string;
  sha256?: string;
  /** When it was sent: the Check's clock counts from it. */
  sentAt?: string;
  decidedAt?: string;
  /** Absent for an admin's own build, a build from before review, or an API that does not say. */
  decidedBy?: GenexDecider;
  /** What to fix: never empty while turned down, empty otherwise. */
  things: GenexReviewThing[];
  /** A person's own words when a person turned it down. */
  reply?: string;
  humanReview: GenexHumanReviewView;
  nextReviewBy?: GenexDecider;
  nextReviewWhy?: GenexPersonWhy;
  /** The earlier build of this app players keep while this one is held or turned down. */
  players?: { version: string; since: string };
}

/** A moderator's takedown of the whole game: hidden from players until a person puts it back. */
export interface GenexTakedown {
  at: string;
  /** The rule it breaks; absent when the reason is never told apart. */
  rule?: string;
  things: GenexReviewThing[];
  /** False for a takedown whose reason is never told apart: no request, no things. */
  appealable: boolean;
  humanReview: GenexHumanReviewView;
  /** An old API that asks for a note of at least this many characters before it opens a request. */
  noteMin?: number;
}

/** What Genex says of a game's review: its headline, each app, and its takedown. */
export interface GenexReviewRecord {
  state: GenexGameReview;
  apps: GenexReviewApp[];
  takedown: GenexTakedown | null;
}

/** What changed in a game's review, as its `genex_review` record says. Wire values: never rename one. */
export const GenexReviewChange = {
  /** An app went to Genex and is checked. */
  Sent: "sent",
  /** An app reaches players. */
  Live: "live",
  NotApproved: "not_approved",
  WithPerson: "with_person",
  /** The creator asked a person (an app, or the takedown). */
  Requested: "requested",
  TakenDown: "taken_down",
  /** A person put a taken-down game back. */
  Restored: "restored",
  /** A person kept a taken-down game down after the creator asked. */
  Upheld: "upheld",
  /** The agent's fix ended, but the app was not built again. */
  NotBuilt: "not_built",
  /** The agent's fix ended stopped or failed. */
  FixStopped: "fix_stopped",
  /** A taken-down web game is fixed: publishing it, and asking a person, stay the creator's. */
  FixedWeb: "fixed_web",
} as const;
export type GenexReviewChange = (typeof GenexReviewChange)[keyof typeof GenexReviewChange];

/** What a fix press sent the agent: an app's things, a game's takedown, or a taken-down web game's. */
export const GenexFixKind = { App: "app", Takedown: "takedown", Web: "web" } as const;
export type GenexFixKind = (typeof GenexFixKind)[keyof typeof GenexFixKind];

/** The sidebar's second line under a game's name (C1). Wire values: never rename one. */
export const GenexSidebarLine = {
  Public: "public",
  InReview: "in_review",
  HumanReview: "human_review",
  NotApproved: "not_approved",
  TakenDown: "taken_down",
  Fixing: "fixing",
  CheckingFixes: "checking_fixes",
} as const;
export type GenexSidebarLine = (typeof GenexSidebarLine)[keyof typeof GenexSidebarLine];

/** A game's sidebar line, and how many things its fix sends the agent while the line is `fixing`. */
export interface GenexSidebarEntry {
  line: GenexSidebarLine;
  things?: number;
}

/** Why the last read of a game's review did not come back. Wire values: never rename one. */
export const GenexReviewReadProblem = { Offline: "offline", SignedOut: "signed_out" } as const;
export type GenexReviewReadProblem = (typeof GenexReviewReadProblem)[keyof typeof GenexReviewReadProblem];

/**
 * Why a request for a person did not go: Genex's own codes (an app or takedown already asked about,
 * already with a person, decided by a person, one never reviewed again) and Studio's (a note an old
 * API finds too short, nothing that allows a request). Wire values: never rename one.
 */
export const GenexReviewRefusal = {
  AlreadyRequested: "already_requested",
  AlreadyAppealed: "already_appealed",
  WithPerson: "with_person",
  DecidedByPerson: "decided_by_person",
  NotAppealable: "not_appealable",
  NoteTooShort: "note_too_short",
  NothingToAsk: "nothing_to_ask",
} as const;
export type GenexReviewRefusal = (typeof GenexReviewRefusal)[keyof typeof GenexReviewRefusal];

/** What a request for a person did: the apps asked about (and whether each must be sent again), or the takedown. */
export interface GenexReviewRequestAnswer {
  requested: Array<{ platform: string; arch: string; resend: boolean }>;
  takedown: boolean;
  refused?: GenexReviewRefusal;
}

/** What the plugin's `review-status` answers for one game. */
export interface GenexReviewStatus {
  /** The last record read; null before the first read, or for a game Genex does not know. */
  record: GenexReviewRecord | null;
  checkedAt: string | null;
  /** Signed in to Genex. */
  connected: boolean;
  /** The last read failed (twice in a row: offline) or the sign-in is gone; the last record is kept. */
  problem?: GenexReviewReadProblem;
  /** Failed reads in a row since the last that came back: the watch waits longer after each. */
  failures?: number;
  /** Something is open: an app is checked or with a person, a request is open, or the game is taken down. */
  open: boolean;
  /** The record's fingerprint, and the one the host last told the person about. */
  fingerprint: string | null;
  told: GenexReviewTold | null;
  /** A publish of the game runs: nothing is read meanwhile. */
  publishing: boolean;
}

/** What the host last told the person of a game's review: one fingerprint for each app and the takedown. */
export interface GenexReviewTold {
  fingerprint: string;
  keys: Readonly<Record<string, string>>;
}

/** The game's headline from its apps and its takedown: the worst state any of them is in. */
export function gameReviewOf(apps: readonly Pick<GenexReviewApp, "state">[], takedown: unknown): GenexGameReview {
  if (takedown) return GenexGameReview.TakenDown;
  const states = new Set<string>(apps.map((app) => app.state));
  return GAME_ORDER.find((state) => states.has(state)) ?? GenexGameReview.NotPublished;
}

/** The key one app's review is told by. */
export const appKey = (app: Pick<GenexReviewApp, "platform" | "arch">): string => `app:${app.platform}/${app.arch}`;
/** The key a takedown is told by. */
export const TAKEDOWN_KEY = "takedown";

/** One app's state as told: a change of any part is one notice. */
const appPrint = (app: GenexReviewApp): string =>
  [
    app.state,
    app.version,
    app.sha256 ?? "",
    app.decidedAt ?? "",
    app.humanReview.state,
    app.things.length,
    app.players?.version ?? "",
  ].join("|");

/** One app as it was last told: its state, its build, its decision, its request and the build players kept. */
export interface GenexToldApp {
  state: string;
  version: string;
  sha256: string;
  decidedAt: string;
  humanReview: string;
  /** The version players kept beside it while it was held or turned down; empty when none. */
  players: string;
}

/** An app's told fingerprint read back; undefined when none was told. */
export function toldAppOf(print: string | undefined): GenexToldApp | undefined {
  if (print === undefined) return undefined;
  const [state = "", version = "", sha256 = "", decidedAt = "", humanReview = "", , players = ""] = print.split("|");
  return { state, version, sha256, decidedAt, humanReview, players };
}

/** A takedown's state as told: when, where its request stands, how many things. */
const takedownPrint = (takedown: GenexTakedown): string =>
  [takedown.at, takedown.humanReview.state, takedown.things.length].join("|");

/** Where a takedown's request stood when it was told, from its told fingerprint. */
export const toldTakedownRequest = (print: string | undefined): string | undefined => print?.split("|")[1];

/** Each app's and the takedown's fingerprint, by key. */
export function reviewKeys(record: GenexReviewRecord): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const app of record.apps) keys[appKey(app)] = appPrint(app);
  if (record.takedown) keys[TAKEDOWN_KEY] = takedownPrint(record.takedown);
  return keys;
}

/** The record's fingerprint: its keys in order, so the same review always prints the same. */
export function reviewFingerprint(record: GenexReviewRecord): string {
  const keys = reviewKeys(record);
  return Object.keys(keys)
    .sort()
    .map((key) => `${key}=${keys[key]}`)
    .join(";");
}

/** Whether a game's review has something still open: the watch reads it more often then. */
export function isOpenReview(record: GenexReviewRecord | null): boolean {
  if (!record) return false;
  if (record.takedown) return true;
  return record.apps.some(
    (app) =>
      app.state === GenexAppReview.Checking ||
      app.state === GenexAppReview.WithPerson ||
      app.humanReview.state === GenexHumanReview.Requested,
  );
}

/** The sidebar's second line from a record alone (a fix in flight is the host's to add). */
export function sidebarLineOf(record: GenexReviewRecord | null): GenexSidebarLine | null {
  if (!record) return null;
  const line: Partial<Record<GenexGameReview, GenexSidebarLine>> = {
    [GenexGameReview.TakenDown]: GenexSidebarLine.TakenDown,
    [GenexGameReview.NotApproved]: GenexSidebarLine.NotApproved,
    [GenexGameReview.WithPerson]: GenexSidebarLine.HumanReview,
    [GenexGameReview.Checking]: GenexSidebarLine.InReview,
    [GenexGameReview.Live]: GenexSidebarLine.Public,
  };
  return line[record.state] ?? null;
}

/** The apps in the worst state the game is in: the ones its card speaks of. */
export function worstApps(record: GenexReviewRecord): GenexReviewApp[] {
  const state = record.state;
  return record.apps.filter((app) => app.state === state);
}

/** Things to fix of several apps as one list: each once, at most {@link REVIEW_THINGS_MAX}. */
export function thingsOf(apps: readonly Pick<GenexReviewApp, "things">[]): GenexReviewThing[] {
  const seen = new Set<string>();
  const things: GenexReviewThing[] = [];
  for (const thing of apps.flatMap((app) => app.things)) {
    if (seen.has(thing.text)) continue;
    seen.add(thing.text);
    things.push(thing);
  }
  return things.slice(0, REVIEW_THINGS_MAX);
}

/** The `genex_review` record: one change in a game's review, as the host read it. Every field optional on read. */
export interface GenexReviewPayload {
  project: string;
  slug?: string;
  title?: string;
  change: GenexReviewChange;
  /** The app it is about, and which build of it (when Genex said); none for the takedown. */
  app?: { platform: string; arch: string; version: string; sha256?: string; sentAt?: string };
  /** What to fix, as it stood then: a settled card reads it back. */
  things?: GenexReviewThing[];
  count?: number;
  decidedBy?: GenexDecider;
  /** A person's own words. */
  reply?: string;
  /** The creator had asked a person. */
  requested?: boolean;
  /** Sent again after Fix with agent. */
  recheck?: boolean;
  /** Turned down again after a re-check. */
  still?: boolean;
  /** Players keep an earlier build of the same app. */
  update?: boolean;
  /** The game was public before (a takedown put back). */
  wasPublic?: boolean;
  at: string;
}

/** The `genex_review_fix` record: Fix with agent pressed, and whether Studio publishes once the agent is done. */
export interface GenexReviewFixPayload {
  project: string;
  /** One press: a later record with the same id and `autoPublish: false` is "Don't publish it automatically". */
  fixId: string;
  count: number;
  kind: GenexFixKind;
  autoPublish: boolean;
  at: string;
}
