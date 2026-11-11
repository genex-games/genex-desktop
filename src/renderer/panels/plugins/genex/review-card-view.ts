/**
 * The review card's view: what Genex says of a game's apps or its takedown, and what the newest Fix
 * with agent press became, as one card's title, lines, things to fix, presses and footer. The same
 * view draws in the Publish dialog and in the chat (mockups B1, C2, C3, C4, D2). Pure: the card only
 * draws it, tests read it.
 *
 * Every line is true of what Genex does: the check takes minutes (the card shows the time that has
 * passed), Genex never checks public games again in the background, a person decides only when the
 * check could not or the creator asked, and a takedown comes back only when a person puts it back.
 */
import {
  GenexAppReview,
  GenexDecider,
  GenexFixKind,
  GenexHumanReview,
  GenexPersonWhy,
  type GenexReviewApp,
  GenexReviewChange,
  type GenexReviewFixPayload,
  type GenexReviewPayload,
  GenexReviewReadProblem,
  type GenexReviewRecord,
  type GenexReviewStatus,
  type GenexReviewThing,
  type GenexTakedown,
  GenexGameReview,
  thingsOf,
  worstApps,
} from "../../../../shared/genex-review.ts";
import { fixStillCurrent, type GenexFixState, sentByFix } from "../../../../shared/genex-review-log.ts";
import { intlLocale, t } from "../../../../shared/i18n.ts";
import { REVIEW_WORDS } from "../../../words.ts";

const WORDS = REVIEW_WORDS;

/** Which card it is: the `data-genex-review` value smoke checks and rigs read. Display only. */
export const ReviewCardKind = {
  NotApproved: "not-approved",
  Update: "update",
  Still: "still",
  PersonKept: "person-kept",
  PersonDecided: "person-decided",
  Repeated: "repeated",
  Requested: "requested",
  Resending: "resending",
  ResendOwed: "resend-owed",
  WithPerson: "with-person",
  Checking: "checking",
  CheckingFixes: "checking-fixes",
  Live: "live",
  LiveUpdate: "live-update",
  Restored: "restored",
  TakenDown: "taken-down",
  TakenDownClosed: "taken-down-closed",
  TakedownRequested: "takedown-requested",
  TakedownUpheld: "takedown-upheld",
  FixSent: "fix-sent",
  AutoCancelled: "auto-cancelled",
  FixStopped: "fix-stopped",
  NotBuilt: "not-built",
  FixedWeb: "fixed-web",
  Offline: "offline",
  SignedOut: "signed-out",
} as const;
export type ReviewCardKind = (typeof ReviewCardKind)[keyof typeof ReviewCardKind];

/** A press the card offers. Display only. */
export const ReviewPress = {
  Fix: "fix",
  Request: "request",
  Publish: "publish",
  FixAgain: "fix-again",
  BuildAgain: "build-again",
  SignIn: "sign-in",
} as const;
export type ReviewPress = (typeof ReviewPress)[keyof typeof ReviewPress];

/** The press words, by press. */
const PRESS_WORDS: Record<ReviewPress, string> = {
  [ReviewPress.Fix]: WORDS.press.fix,
  [ReviewPress.Request]: WORDS.press.request,
  [ReviewPress.Publish]: WORDS.press.publish,
  [ReviewPress.FixAgain]: WORDS.press.fixAgain,
  [ReviewPress.BuildAgain]: WORDS.press.buildAgain,
  [ReviewPress.SignIn]: WORDS.press.signIn,
};

/** The one link under a sent fix that takes its automatic step back. */
export const ReviewLink = { DontPublish: "dont-publish", DontAsk: "dont-ask" } as const;
export type ReviewLink = (typeof ReviewLink)[keyof typeof ReviewLink];

/** Where the card draws: the Publish dialog (its own step bar shows a check), or the chat. */
export const ReviewPlace = { Dialog: "dialog", Chat: "chat" } as const;
export type ReviewPlace = (typeof ReviewPlace)[keyof typeof ReviewPlace];

/** The card as drawn. */
export interface ReviewCardView {
  kind: ReviewCardKind;
  /** A turned-down or taken-down card asks for the person; a quiet one only says how it stands. */
  tone: "attention" | "quiet" | "done";
  title: string | null;
  /** Lines above the things. */
  lines: string[];
  /** A person's own words, quoted. */
  quote: string | null;
  things: GenexReviewThing[];
  /** Lines below the things. */
  after: string[];
  presses: Array<{ press: ReviewPress; label: string; primary: boolean }>;
  footer: string | null;
  /** The check's clock counts from here (a checked card). */
  since: string | null;
  link: { link: ReviewLink; label: string } | null;
  /** A one-line card: the dot and its words (offline, signed out, a fix's end). */
  oneLine: boolean;
  /** The live card's link and cover (the chat). */
  live: boolean;
  /** The app's platform a Build again builds. */
  platform: string | null;
}

/** What the card is drawn from. */
export interface ReviewCardInput {
  status: GenexReviewStatus | null;
  fix: GenexFixState | null;
  /** The newest `genex_review` record of the game, for a chat's live card (restored, approved after a request). */
  latest?: Partial<GenexReviewPayload> | null;
  title: string;
  /** The game's apps are being sent now. */
  sending?: boolean;
  /**
   * The game publishes as a web game: after a fix of its takedown, publishing it and asking a person
   * stay the person's (Studio does neither by itself).
   */
  web?: boolean;
  place: ReviewPlace;
}

/** The `app` placeholder for these apps: their one platform, or `apps`. */
export function appNoun(apps: readonly Pick<GenexReviewApp, "platform">[]): string {
  const platforms = new Set(apps.map((app) => app.platform));
  const [only] = [...platforms];
  return platforms.size === 1 && only ? only : "apps";
}

/** A date as the card says it: "Oct 25". */
export const shortDate = (iso: string): string =>
  Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" })
    : "";

/** The time a check has taken: "6s", "1m 05s", "1h 12m". */
export function elapsedWords(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) || 0;
  if (seconds < 60) return t("{seconds}s", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("{minutes}m {seconds}s", { minutes, seconds: String(seconds % 60).padStart(2, "0") });
  return t("{hours}h {minutes}m", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") });
}

const press = (which: ReviewPress, primary = false) => ({ press: which, label: PRESS_WORDS[which], primary });

/** A card with nothing filled in yet. */
const blank = (kind: ReviewCardKind, tone: ReviewCardView["tone"] = "attention"): ReviewCardView => ({
  kind,
  tone,
  title: null,
  lines: [],
  quote: null,
  things: [],
  after: [],
  presses: [],
  footer: null,
  since: null,
  link: null,
  oneLine: false,
  live: false,
  platform: null,
});

/** The states whose card needs the person: offline and signed out still say them. */
const NEEDS_PERSON: ReadonlySet<string> = new Set([
  GenexGameReview.TakenDown,
  GenexGameReview.NotApproved,
  GenexGameReview.WithPerson,
  GenexGameReview.Checking,
]);

/** A fix press whose step after it is still to come: the card says it was sent, and how to take the step back. */
const pendingFix = (fix: GenexFixState | null): fix is GenexFixState => fix !== null && fix.outcome === undefined;

/** The card for `input`; null when there is nothing to show where it draws. */
export function reviewCardView(input: ReviewCardInput): ReviewCardView | null {
  const { status } = input;
  const record = status?.record ?? null;
  const problem = problemCard(status, record);
  if (problem) return problem;
  const ended = fixEndCard(input.fix, record);
  if (ended) return ended;
  if (!record) return null;
  const card = record.takedown ? takedownCard(record.takedown, input.web === true) : appsCard(record, input);
  if (!card) return null;
  return withFix(card, input.fix, record, input.web === true);
}

/** Offline or signed out, while the game has something that needs the person. */
function problemCard(status: GenexReviewStatus | null, record: GenexReviewRecord | null): ReviewCardView | null {
  if (!status?.problem || !record || !NEEDS_PERSON.has(record.state)) return null;
  if (status.problem === GenexReviewReadProblem.SignedOut)
    return {
      ...blank(ReviewCardKind.SignedOut, "quiet"),
      lines: [WORDS.line.signedOut],
      presses: [press(ReviewPress.SignIn)],
      oneLine: true,
    };
  return { ...blank(ReviewCardKind.Offline, "quiet"), lines: [WORDS.line.offline(record.state)], oneLine: true };
}

/**
 * How the newest fix ended when it ended short: the agent stopped, nothing was built, a web game was
 * fixed. Only while Genex still says what the fix was about: a later publish or decision moves on.
 */
function fixEndCard(fix: GenexFixState | null, record: GenexReviewRecord | null): ReviewCardView | null {
  if (!fix || !fixStillCurrent(fix, record)) return null;
  if (fix.outcome === GenexReviewChange.FixStopped)
    return {
      ...blank(ReviewCardKind.FixStopped),
      lines: [WORDS.line.fixStopped],
      presses: [press(ReviewPress.FixAgain)],
      oneLine: true,
    };
  if (fix.outcome === GenexReviewChange.NotBuilt) {
    const apps = record ? worstApps(record) : [];
    return {
      ...blank(ReviewCardKind.NotBuilt),
      lines: [WORDS.line.notBuilt(appNoun(apps))],
      presses: [press(ReviewPress.BuildAgain)],
      oneLine: true,
      platform: apps[0]?.platform ?? null,
    };
  }
  if (fix.outcome === GenexReviewChange.FixedWeb && record?.takedown)
    return {
      ...blank(ReviewCardKind.FixedWeb),
      lines: [WORDS.line.fixedWeb],
      presses: [press(ReviewPress.Publish, true), press(ReviewPress.Request)],
    };
  return null;
}

/** Whether Studio asks a person to put a fixed takedown back by itself: a game with apps, while a request may go. */
const studioAsks = (takedown: GenexTakedown | null, web: boolean): boolean =>
  !web && takedown?.humanReview.canRequest === true && !takedown.noteMin;

/** The footer of a takedown to fix: who asks a person once it is fixed, or nothing while no request may go. */
function takedownFooter(takedown: GenexTakedown, web: boolean, asks: string): string | null {
  if (!takedown.humanReview.canRequest) return null;
  return studioAsks(takedown, web) ? asks : WORDS.footer.takedownYourself;
}

/** A taken-down game's card: closed, asked about, kept down, or to fix. */
function takedownCard(takedown: GenexTakedown, web: boolean): ReviewCardView {
  const n = takedown.things.length;
  if (!takedown.appealable)
    return {
      ...blank(ReviewCardKind.TakenDownClosed),
      title: WORDS.title.takenDownPlain,
      lines: [WORDS.line.teamReviewing],
    };
  const human = takedown.humanReview;
  const things = takedown.things;
  if (human.state === GenexHumanReview.Requested)
    return {
      ...blank(ReviewCardKind.TakedownRequested),
      title: WORDS.title.takenDown(n),
      things,
      after: [WORDS.line.requested],
      presses: [press(ReviewPress.Fix, true)],
    };
  if (human.state === GenexHumanReview.Denied)
    return {
      ...blank(ReviewCardKind.TakedownUpheld),
      title: WORDS.title.takenDown(n),
      lines: [WORDS.line.upheld],
      quote: human.reply ?? null,
      things,
      presses: [press(ReviewPress.Fix, true)],
      footer: takedownFooter(takedown, web, WORDS.footer.upheld),
    };
  return {
    ...blank(ReviewCardKind.TakenDown),
    title: WORDS.title.takenDown(n),
    lines: [WORDS.line.hidden],
    things,
    presses: [press(ReviewPress.Fix, true), ...(human.canRequest ? [press(ReviewPress.Request)] : [])],
    footer: takedownFooter(takedown, web, WORDS.footer.takedown),
  };
}

/** The apps' card by their worst state. */
function appsCard(record: GenexReviewRecord, input: ReviewCardInput): ReviewCardView | null {
  const apps = worstApps(record);
  const noun = appNoun(apps);
  if (record.state === GenexGameReview.NotApproved) return notApprovedCard(apps, input);
  if (record.state === GenexGameReview.WithPerson)
    return {
      ...blank(ReviewCardKind.WithPerson, "quiet"),
      title: WORDS.title.withPerson,
      lines: [WORDS.line.withPerson],
    };
  if (record.state === GenexGameReview.Checking) {
    if (input.place === ReviewPlace.Dialog) return null;
    const fixes = apps.some((app) => sentByFix(input.fix, app));
    const since = apps.map((app) => app.sentAt).find(Boolean) ?? null;
    return {
      ...blank(fixes ? ReviewCardKind.CheckingFixes : ReviewCardKind.Checking, "quiet"),
      title: fixes ? WORDS.title.checkingFixes : WORDS.title.checking(noun),
      lines: [WORDS.line.usuallyMinutes],
      since,
    };
  }
  if (record.state === GenexGameReview.Live && input.place === ReviewPlace.Chat) return liveCard(apps, input);
  return null;
}

/**
 * The chat's live card: live after a fix (an update or a first), public again, or approved after a
 * request. It says the game's name and that it is live, or public again, and nothing under that: no
 * version number, no line. Its history line keeps the rest ({@link settledCardView}).
 */
function liveCard(apps: readonly GenexReviewApp[], input: ReviewCardInput): ReviewCardView {
  const latest = input.latest;
  if (latest?.change === GenexReviewChange.Restored)
    return { ...blank(ReviewCardKind.Restored, "done"), title: WORDS.title.publicAgain(input.title), live: true };
  const app = apps[0];
  const asked = app?.humanReview.state === GenexHumanReview.Answered || latest?.requested === true;
  const update = latest?.update === true && app !== undefined && !asked;
  return {
    ...blank(update ? ReviewCardKind.LiveUpdate : ReviewCardKind.Live, "done"),
    title: WORDS.title.live(input.title),
    live: true,
  };
}

/** A turned-down app's card: by a person, after three turn-downs, after a request, after a re-check, an update, or a first. */
function notApprovedCard(apps: readonly GenexReviewApp[], input: ReviewCardInput): ReviewCardView {
  const things = thingsOf(apps);
  const n = things.length;
  const app = apps[0];
  const human = app?.humanReview;
  const noun = appNoun(apps);
  const base = { things, platform: app?.platform ?? null };
  if (app?.nextReviewWhy === GenexPersonWhy.Repeated)
    return {
      ...blank(ReviewCardKind.Repeated),
      ...base,
      title: WORDS.title.notApproved(n),
      after: [WORDS.line.repeated],
      presses: [press(ReviewPress.Fix, true)],
    };
  if (app?.decidedBy === GenexDecider.Person) {
    const asked = human?.state === GenexHumanReview.Answered;
    return {
      ...blank(asked ? ReviewCardKind.PersonKept : ReviewCardKind.PersonDecided),
      ...base,
      title: WORDS.title.notApproved(n),
      lines: [asked ? WORDS.line.agreedWithCheck : WORDS.line.personReviewed],
      quote: app.reply ?? null,
      presses: [press(ReviewPress.Fix, true)],
      footer: WORDS.footer.person,
    };
  }
  const opening = openingOf(apps, input.fix);
  if (human?.state === GenexHumanReview.Requested)
    return requestedCard(opening, base, noun, human.resend === true, input);
  const canRequest = apps.some((one) => one.humanReview.canRequest);
  return {
    ...opening,
    ...base,
    presses: [press(ReviewPress.Fix, true), ...(canRequest ? [press(ReviewPress.Request)] : [])],
  };
}

/** A turned-down card's title, first line and footer: after a re-check, an update players keep the old of, or a first. */
function openingOf(apps: readonly GenexReviewApp[], fix: GenexFixState | null): ReviewCardView {
  const things = thingsOf(apps);
  const n = things.length;
  const app = apps[0];
  if (app && sentByFix(fix, app))
    return { ...blank(ReviewCardKind.Still), title: WORDS.title.still(n), footer: WORDS.footer.first };
  if (app?.players)
    return {
      ...blank(ReviewCardKind.Update),
      title: WORDS.title.update(n),
      lines: [WORDS.line.playersKeep(shortDate(app.players.since))],
      footer: WORDS.footer.update,
    };
  return { ...blank(ReviewCardKind.NotApproved), title: WORDS.title.cantPublish(n), footer: WORDS.footer.first };
}

/** A turned-down app a person was asked about: owed a resend (going now, or still to send), or asked. */
function requestedCard(
  opening: ReviewCardView,
  base: Pick<ReviewCardView, "things" | "platform">,
  noun: string,
  resend: boolean,
  input: ReviewCardInput,
): ReviewCardView {
  if (resend && input.sending)
    return {
      ...opening,
      ...base,
      kind: ReviewCardKind.Resending,
      after: [WORDS.line.resending(noun)],
      presses: [],
      footer: null,
    };
  if (resend)
    return {
      ...opening,
      ...base,
      kind: ReviewCardKind.ResendOwed,
      after: [WORDS.line.resendOwed(noun)],
      presses: input.place === ReviewPlace.Chat ? [press(ReviewPress.Publish, true)] : [],
      footer: null,
    };
  return {
    ...opening,
    ...base,
    kind: ReviewCardKind.Requested,
    after: [WORDS.line.requested],
    presses: [press(ReviewPress.Fix, true)],
    footer: null,
  };
}

/**
 * A card a fix press is on its way for: it stays, and says the agent has it, with the link that
 * takes Studio's step after it back, or, once taken back, that publishing is the person's.
 */
function withFix(
  card: ReviewCardView,
  fix: GenexFixState | null,
  record: GenexReviewRecord,
  web: boolean,
): ReviewCardView {
  if (!pendingFix(fix) || card.tone !== "attention") return card;
  const decided = record.takedown?.at ?? worstApps(record)[0]?.decidedAt;
  if (Date.parse(decided ?? "") > Date.parse(fix.at)) return card;
  if (fix.kind === GenexFixKind.App) return appFixCard(card, fix);
  return takedownFixCard(card, fix, record.takedown, web);
}

const DONT_PUBLISH = { link: ReviewLink.DontPublish, label: WORDS.press.dontPublish };

/** An app's fix on its way: Studio publishes it once the agent is done, until the person takes that back. */
function appFixCard(card: ReviewCardView, fix: GenexFixState): ReviewCardView {
  if (!fix.autoPublish)
    return {
      ...card,
      kind: ReviewCardKind.AutoCancelled,
      after: [WORDS.line.autoCancelled],
      presses: [press(ReviewPress.Publish, true)],
      footer: null,
    };
  return {
    ...card,
    kind: ReviewCardKind.FixSent,
    after: [WORDS.line.sentApp],
    presses: [],
    footer: null,
    link: DONT_PUBLISH,
  };
}

/**
 * A takedown's fix on its way. A game with apps is sent again once the agent is done, and a person is
 * asked to put it back while a request may go; a web game's publish and request stay the person's,
 * as do both once the person took Studio's step back: then Request human review stays on the card,
 * until the person asked.
 */
function takedownFixCard(
  card: ReviewCardView,
  fix: GenexFixState,
  takedown: GenexTakedown | null,
  web: boolean,
): ReviewCardView {
  const yourself = { ...card, after: [WORDS.line.sentPublishThenAsk], footer: null, link: null };
  if (fix.kind === GenexFixKind.Web) return { ...yourself, kind: ReviewCardKind.FixSent, presses: [] };
  // Asked already, once the step was the person's: the card says the request is open.
  if (!fix.autoPublish && takedown?.humanReview.state === GenexHumanReview.Requested) return card;
  if (!fix.autoPublish) {
    const request = takedown?.humanReview.canRequest ? [press(ReviewPress.Request)] : [];
    return { ...yourself, kind: ReviewCardKind.AutoCancelled, presses: [press(ReviewPress.Publish, true), ...request] };
  }
  const asks = studioAsks(takedown, web);
  return {
    ...card,
    kind: ReviewCardKind.FixSent,
    after: [asks ? WORDS.line.sentTakedown : WORDS.line.sentPublishes],
    presses: [],
    footer: null,
    link: asks ? { link: ReviewLink.DontAsk, label: WORDS.press.dontAsk } : DONT_PUBLISH,
  };
}

/** The history line's words for a settled record (C2, C4, D2): null for one that draws no line. */
export function historyLabel(record: Partial<GenexReviewPayload>): string | null {
  switch (record.change) {
    case GenexReviewChange.Sent:
      return WORDS.history.sent;
    case GenexReviewChange.Live:
      return record.update ? WORDS.history.live : WORDS.history.published;
    case GenexReviewChange.NotApproved:
      return WORDS.history.notApproved;
    case GenexReviewChange.Requested:
      return WORDS.history.requested;
    case GenexReviewChange.WithPerson:
      return record.requested ? WORDS.history.requested : WORDS.history.sent;
    case GenexReviewChange.TakenDown:
    case GenexReviewChange.Upheld:
      return WORDS.history.takenDown;
    case GenexReviewChange.Restored:
      return WORDS.history.publicAgain;
    default:
      return null;
  }
}

/** The history line of a fix press: "3 fixes sent". */
export const fixHistoryLabel = (count: number): string => WORDS.history.fixes(count);

/** What a settled card said when it was the newest, read only: its title, its lines, a person's words, its things. */
export interface SettledCardView {
  title: string;
  lines: string[];
  quote: string | null;
  things: GenexReviewThing[];
}

/** What a settled fix press said, by what it sent the agent: a web game's takedown leaves the rest to the person. */
const SETTLED_FIX_LINE: Readonly<Record<string, string>> = {
  [GenexFixKind.App]: WORDS.line.sentApp,
  [GenexFixKind.Takedown]: WORDS.line.sentTakedown,
  [GenexFixKind.Web]: WORDS.line.sentPublishThenAsk,
};

/** The things a record kept that have words, at most ten, each once: an old log's shape is never trusted. */
const keptThings = (record: Partial<GenexReviewPayload>): GenexReviewThing[] => {
  const listed: unknown[] = Array.isArray(record.things) ? record.things : [];
  const worded = listed.filter(
    (thing): thing is GenexReviewThing =>
      typeof thing === "object" && thing !== null && typeof (thing as { text?: unknown }).text === "string",
  );
  return thingsOf([{ things: worded }]);
};

/** A settled record's card, as it read then; null for a record that draws no line. */
function settledReview(record: Partial<GenexReviewPayload>, title: string): SettledCardView | null {
  const things = keptThings(record);
  const n = typeof record.count === "number" ? record.count : things.length;
  const quote = typeof record.reply === "string" && record.reply ? record.reply : null;
  const card = (head: string, lines: string[] = [], keep = things): SettledCardView => ({
    title: head,
    lines,
    quote,
    things: keep,
  });
  const app = appNoun(record.app ? [record.app] : []);
  switch (record.change) {
    case GenexReviewChange.Sent:
      return card(
        record.recheck ? WORDS.title.checkingFixes : WORDS.title.checking(app),
        [WORDS.line.usuallyMinutes],
        [],
      );
    case GenexReviewChange.Live:
      return record.update && record.app
        ? card(WORDS.title.versionLive(record.app.version), [WORDS.line.platformPlayers(app)], [])
        : card(WORDS.title.live(title), [WORDS.line.anyone], []);
    case GenexReviewChange.NotApproved:
      return card(WORDS.title.notApproved(n), quote ? [WORDS.line.personReviewed] : []);
    case GenexReviewChange.WithPerson:
      return card(WORDS.title.withPerson, [WORDS.line.withPerson], []);
    case GenexReviewChange.Requested:
      return card(WORDS.history.requested, [WORDS.line.requested]);
    case GenexReviewChange.TakenDown:
      return card(WORDS.title.takenDown(n), [WORDS.line.hidden]);
    case GenexReviewChange.Upheld:
      return card(WORDS.title.takenDown(n), [WORDS.line.upheld]);
    case GenexReviewChange.Restored:
      return card(WORDS.title.publicAgain(title), [record.requested ? WORDS.line.teamAgreed : WORDS.line.anyone], []);
    default:
      return null;
  }
}

/**
 * An older record or fix press as its history line opens it (C2, C4, D2): what it said then, read only,
 * with no press. Null for one that draws no line.
 */
export function settledCardView(
  entry: { review: Partial<GenexReviewPayload> | null; fix: Partial<GenexReviewFixPayload> | null },
  title: string,
): SettledCardView | null {
  if (entry.fix) {
    const sent = SETTLED_FIX_LINE[entry.fix.kind ?? GenexFixKind.App] ?? WORDS.line.sentApp;
    return { title: fixHistoryLabel(entry.fix.count ?? 0), lines: [sent], quote: null, things: [] };
  }
  return entry.review ? settledReview(entry.review, title) : null;
}

/** The Check step's clock source: the app being checked sent last, while one is. */
export function checkingSince(record: GenexReviewRecord | null): string | null {
  if (!record || record.takedown) return null;
  const checking = record.apps.filter(
    (app) => app.state === GenexAppReview.Checking || app.state === GenexAppReview.WithPerson,
  );
  const times = checking.map((app) => app.sentAt).filter((at): at is string => typeof at === "string");
  return times.sort().at(-1) ?? null;
}
