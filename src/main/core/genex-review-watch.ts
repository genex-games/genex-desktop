/**
 * The host's watch over Genex's review of each game on Genex: its apps (held while Genex's automatic
 * check reads them, usually a few minutes, or while a person reviews them) and a moderator's takedown
 * of the whole game. The Genex plugin cannot push anything, so main drives the cadence and the plugin
 * answers (`review-status`). Genex does not check public games again in the background; the sweep
 * only asks what Genex already decided, which catches a takedown or a decision that came while
 * Studio was away.
 *
 * - A sweep 20 s after start, then every 15 min, reads every game on Genex; a focus of the window
 *   sweeps too when the last sweep is over 5 min old.
 * - An app being checked is read again at 30 s, 30 s, 1 min, 1 min and 2 min, then every 2 min until
 *   45 min after it was sent, then every 10 min; one with a person every 10 min; a takedown on the
 *   sweep only. A game with nothing open waits for the sweep.
 * - One read at a time. A failed read doubles that game's wait, up to 15 min; the plugin says offline
 *   after two in a row. Signed out, nothing is read until a sweep finds the sign-in back.
 * - Each change is told once: one `genex_review` record in the game's own chat, then what was told is
 *   kept by the plugin (`review.json`), so a restart never tells it again, and a decision that came
 *   while Studio was closed is told once at the next start. The window hears of each change
 *   (`UiEvent.GenexReviewChanged`), a first read's too.
 *
 * Electron-free: the clock, timers, the games, the plugin call, the log and the window come in as deps.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  appKey,
  GenexAppReview,
  GenexHumanReview,
  type GenexReviewApp,
  GenexReviewChange,
  type GenexReviewPayload,
  GenexReviewReadProblem,
  type GenexReviewRecord,
  type GenexReviewStatus,
  type GenexReviewTold,
  type GenexTakedown,
  type GenexToldApp,
  reviewFingerprint,
  reviewKeys,
  TAKEDOWN_KEY,
  toldAppOf,
  toldTakedownRequest,
} from "../../shared/genex-review.ts";

/** The first sweep after the watch starts: once the boot has settled. */
export const REVIEW_FIRST_SWEEP_MS = 20 * SECOND_MS;
/** Every game on Genex is read this often. */
export const REVIEW_SWEEP_MS = 15 * MINUTE_MS;
/** A focus of the window sweeps when the last sweep is older than this. */
export const REVIEW_FOCUS_SWEEP_MS = 5 * MINUTE_MS;
/** The reads of an app being checked, one after another from the first. */
export const REVIEW_POLL_MS = [30 * SECOND_MS, 30 * SECOND_MS, MINUTE_MS, MINUTE_MS, 2 * MINUTE_MS] as const;
/** After those, an app being checked is read this often… */
const REVIEW_STEADY_MS = 2 * MINUTE_MS;
/** …until this long after it was sent, then every {@link REVIEW_LATE_MS}. */
const REVIEW_STEADY_UNTIL_MS = 45 * MINUTE_MS;
const REVIEW_LATE_MS = 10 * MINUTE_MS;
/** An app with a person is read this often. */
const REVIEW_PERSON_MS = 10 * MINUTE_MS;
/** A failing game is never read less often than this. */
const REVIEW_BACKOFF_MAX_MS = 15 * MINUTE_MS;
/** A game whose publish runs is asked again this soon. */
const REVIEW_BUSY_MS = 30 * SECOND_MS;
/** How many games are read at once: one, so one CLI or API read runs at a time. */
export const REVIEW_READS_AT_ONCE = 1;

/** What the watch runs on. */
export interface ReviewWatchDeps {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** The games on Genex: each whose publish record has a link there. */
  games(): Promise<string[]>;
  /** The Genex plugin's `review-status` for one game. */
  status(project: string, options: { refresh?: boolean; told?: GenexReviewTold }): Promise<GenexReviewStatus>;
  /** Append the records to the game's own chat. */
  append(project: string, records: GenexReviewPayload[]): Promise<void>;
  /** Tell the window a game's review changed (`UiEvent.GenexReviewChanged`). */
  emit(project: string): void;
  /** The game's name and link for the records, when known. */
  game?(project: string): Promise<{ title?: string; slug?: string }>;
}

/** A running watch. */
export interface ReviewWatch {
  stop(): void;
  /** The window came to the front: sweep when the last sweep is old. */
  focus(): void;
  /** Read `project` again now: an apps publish ended, a request went, Publish opened. */
  refresh(project: string): void;
}

/** One game's place in the watch. */
interface Watched {
  /** When it is read next; Infinity waits for the sweep. */
  due: number;
  /** Reads of its open review since it opened. */
  polls: number;
  /** Its wait after the last failed read, doubled by each failure in a row. */
  backoff: number | null;
  /** Its problem as last told to the window. */
  problem: GenexReviewReadProblem | undefined;
}

/** The game's name and link, as the records carry them. */
type GameNames = { project: string; title?: string; slug?: string };

/** The app being checked that was sent last: the open cadence counts from it. */
const sentAtOf = (record: GenexReviewRecord): number =>
  Math.max(
    0,
    ...record.apps
      .filter((app) => app.state === GenexAppReview.Checking)
      .map((app) => Date.parse(app.sentAt ?? "") || 0),
  );

/** The wait before a game's next read once one came back: its open cadence, or the sweep. */
export function nextReadIn(record: GenexReviewRecord | null, polls: number, now: number): number {
  if (!record || record.takedown) return Number.POSITIVE_INFINITY;
  if (record.apps.some((app) => app.state === GenexAppReview.Checking)) {
    const step = REVIEW_POLL_MS[polls];
    if (step !== undefined) return step;
    return now - sentAtOf(record) < REVIEW_STEADY_UNTIL_MS ? REVIEW_STEADY_MS : REVIEW_LATE_MS;
  }
  const withPerson = record.apps.some(
    (app) => app.state === GenexAppReview.WithPerson || app.humanReview.state === GenexHumanReview.Requested,
  );
  return withPerson ? REVIEW_PERSON_MS : Number.POSITIVE_INFINITY;
}

/** The change an app's new state is: what the person is told of it. */
const APP_CHANGE: Record<GenexAppReview, GenexReviewChange> = {
  [GenexAppReview.Checking]: GenexReviewChange.Sent,
  [GenexAppReview.Live]: GenexReviewChange.Live,
  [GenexAppReview.NotApproved]: GenexReviewChange.NotApproved,
  [GenexAppReview.WithPerson]: GenexReviewChange.WithPerson,
};

/** What a first read tells: what needs the person, never what was already so before Studio watched. */
const TOLD_UNSEEN: ReadonlySet<GenexReviewChange> = new Set([
  GenexReviewChange.NotApproved,
  GenexReviewChange.WithPerson,
  GenexReviewChange.TakenDown,
]);

/** Whether `app` is the same build with the same decision as was told: only its request may have moved. */
const sameDecision = (app: GenexReviewApp, was: GenexToldApp | undefined): was is GenexToldApp =>
  was !== undefined &&
  was.state === app.state &&
  was.version === app.version &&
  was.sha256 === (app.sha256 ?? "") &&
  was.decidedAt === (app.decidedAt ?? "");

/**
 * The change an app's new state is, from what was told of it: a request for a person made elsewhere
 * (genex.games, the CLI) about the same turned-down build is a request, never a new turn-down; any
 * other move of only the request is no news. Null when there is nothing to tell.
 */
function appChange(app: GenexReviewApp, was: GenexToldApp | undefined): GenexReviewChange | null {
  if (!sameDecision(app, was)) return APP_CHANGE[app.state];
  const asked = app.humanReview.state === GenexHumanReview.Requested && was.humanReview !== GenexHumanReview.Requested;
  return asked ? GenexReviewChange.Requested : null;
}

/** Whether a build that went live took an earlier one's place: players had one while it was held, or a live one went before. */
function liveUpdate(app: GenexReviewApp, was: GenexToldApp | undefined): boolean {
  if (app.players) return true;
  if (app.state !== GenexAppReview.Live || !was) return false;
  if (was.players !== "") return true;
  return was.state === GenexAppReview.Live && (was.version !== app.version || was.sha256 !== (app.sha256 ?? ""));
}

/** Whether the creator had asked a person about the app: asked now, answered, or asked before it went live. */
const askedAbout = (app: GenexReviewApp, was: GenexToldApp | undefined): boolean =>
  app.humanReview.state === GenexHumanReview.Requested ||
  app.humanReview.state === GenexHumanReview.Answered ||
  (app.state === GenexAppReview.Live && was?.humanReview === GenexHumanReview.Requested);

/** An app's change as its record says it, with the build it is about. */
function appRecord(
  app: GenexReviewApp,
  change: GenexReviewChange,
  was: GenexToldApp | undefined,
  names: GameNames,
  at: string,
): GenexReviewPayload {
  return {
    ...names,
    change,
    app: {
      platform: app.platform,
      arch: app.arch,
      version: app.version,
      ...(app.sha256 ? { sha256: app.sha256 } : {}),
      ...(app.sentAt ? { sentAt: app.sentAt } : {}),
    },
    ...(app.things.length > 0 ? { things: app.things, count: app.things.length } : {}),
    ...(app.decidedBy ? { decidedBy: app.decidedBy } : {}),
    ...(app.reply ? { reply: app.reply } : {}),
    ...(askedAbout(app, was) ? { requested: true } : {}),
    ...(liveUpdate(app, was) ? { update: true } : {}),
    at,
  };
}

/** A takedown's change: new, asked about, or kept down after a person looked. */
function takedownRecord(takedown: GenexTakedown, before: string | undefined, names: GameNames, at: string) {
  const state = takedown.humanReview.state;
  const things = { things: takedown.things, count: takedown.things.length };
  if (before === undefined || state === GenexHumanReview.None)
    return { ...names, change: GenexReviewChange.TakenDown, ...things, at };
  if (state === GenexHumanReview.Denied) {
    const reply = takedown.humanReview.reply ? { reply: takedown.humanReview.reply } : {};
    return { ...names, change: GenexReviewChange.Upheld, ...things, ...reply, decidedBy: "person" as const, at };
  }
  return { ...names, change: GenexReviewChange.Requested, ...things, requested: true, at };
}

/**
 * The records for what changed between what was told and Genex's `record`, and what is told once
 * they are written. A first read (nothing told yet) tells only what needs the person.
 */
export function reviewChanges(
  told: GenexReviewTold | null,
  record: GenexReviewRecord,
  now: number,
  names: GameNames,
): { records: GenexReviewPayload[]; told: GenexReviewTold } {
  const keys = reviewKeys(record);
  const before = told?.keys ?? {};
  const at = new Date(now).toISOString();
  const records: GenexReviewPayload[] = [];
  for (const app of record.apps) {
    const key = appKey(app);
    if (before[key] === keys[key]) continue;
    const was = toldAppOf(before[key]);
    const change = appChange(app, was);
    if (change) records.push(appRecord(app, change, was, names, at));
  }
  const takedown = record.takedown;
  if (takedown && before[TAKEDOWN_KEY] !== keys[TAKEDOWN_KEY])
    records.push(takedownRecord(takedown, before[TAKEDOWN_KEY], names, at));
  if (!takedown && before[TAKEDOWN_KEY] !== undefined) {
    const asked = toldTakedownRequest(before[TAKEDOWN_KEY]) === GenexHumanReview.Requested;
    records.push({ ...names, change: GenexReviewChange.Restored, ...(asked ? { requested: true } : {}), at });
  }
  const shown = told ? records : records.filter((one) => TOLD_UNSEEN.has(one.change));
  return { records: shown, told: { fingerprint: reviewFingerprint(record), keys } };
}

/**
 * Tell the records of what changed since the host last told, then keep what was told. The window
 * hears of every change, even one with no record (a first read): its sidebar line reads it.
 */
async function tellChanges(deps: ReviewWatchDeps, project: string, status: GenexReviewStatus): Promise<void> {
  if (!status.record || status.told?.fingerprint === status.fingerprint) return;
  const names = { project, ...(await deps.game?.(project).catch(() => ({}))) };
  const { records, told } = reviewChanges(status.told, status.record, deps.now(), names);
  if (records.length > 0) await deps.append(project, records);
  await deps.status(project, { told });
  deps.emit(project);
}

/** How a read went, for the game's next one: signed out, its publish runs, it failed, or it came back. */
const ReadEnd = { SignedOut: "signed-out", Busy: "busy", Failed: "failed", Back: "back" } as const;
type ReadEnd = (typeof ReadEnd)[keyof typeof ReadEnd];

function readEnd(status: GenexReviewStatus | null): ReadEnd {
  if (status?.problem === GenexReviewReadProblem.SignedOut) return ReadEnd.SignedOut;
  if (status?.publishing) return ReadEnd.Busy;
  return !status || (status.failures ?? 0) > 0 ? ReadEnd.Failed : ReadEnd.Back;
}

/** When `game` is read next after a read that ended so: its cadence, a doubled wait, or the sweep. */
function planNext(game: Watched, end: ReadEnd, status: GenexReviewStatus | null, now: number): void {
  if (end === ReadEnd.SignedOut) game.due = Number.POSITIVE_INFINITY;
  else if (end === ReadEnd.Busy) game.due = now + REVIEW_BUSY_MS;
  else if (end === ReadEnd.Failed) {
    const normal = nextReadIn(status?.record ?? null, game.polls, now);
    const base = Number.isFinite(normal) ? normal : REVIEW_POLL_MS[0];
    game.backoff = Math.min(REVIEW_BACKOFF_MAX_MS, (game.backoff ?? base) * 2);
    game.due = now + game.backoff;
  } else {
    game.backoff = null;
    const wait = nextReadIn(status?.record ?? null, game.polls, now);
    game.polls = Number.isFinite(wait) ? game.polls + 1 : 0;
    game.due = now + wait;
  }
}

/** The watch's own state between its timers. */
interface WatchState {
  watched: Map<string, Watched>;
  nextSweep: number;
  lastSweep: number;
  timer: unknown;
  reading: boolean;
  stopped: boolean;
  signedOut: boolean;
}

/** The game's place in the watch, added waiting for the sweep. */
function entryOf(state: WatchState, project: string): Watched {
  const known = state.watched.get(project);
  if (known) return known;
  const fresh: Watched = { due: Number.POSITIVE_INFINITY, polls: 0, backoff: null, problem: undefined };
  state.watched.set(project, fresh);
  return fresh;
}

/**
 * Mark every game on Genex that waits for the sweep due now (one on an open cadence is read on it
 * sooner anyway), and forget games that are no longer there.
 */
async function sweep(deps: ReviewWatchDeps, state: WatchState): Promise<void> {
  state.lastSweep = deps.now();
  state.nextSweep = state.lastSweep + REVIEW_SWEEP_MS;
  state.signedOut = false;
  const games = new Set(await deps.games().catch(() => [] as string[]));
  for (const project of state.watched.keys()) if (!games.has(project)) state.watched.delete(project);
  for (const project of games) {
    const game = entryOf(state, project);
    if (!Number.isFinite(game.due)) game.due = state.lastSweep;
  }
}

/** One game read: what it says, when it is read next, what changed told, and its line's problem. */
async function readGame(deps: ReviewWatchDeps, state: WatchState, project: string, game: Watched): Promise<void> {
  const status = await deps.status(project, { refresh: true }).catch(() => null);
  const end = readEnd(status);
  planNext(game, end, status, deps.now());
  if (end === ReadEnd.SignedOut) state.signedOut = true;
  if (end === ReadEnd.Back && status) await tellChanges(deps, project, status).catch(() => {});
  if (status?.problem !== game.problem) {
    game.problem = status?.problem;
    deps.emit(project);
  }
}

/** The game read next: the one due first, while any is due. */
function dueGame(state: WatchState, now: number): [string, Watched] | undefined {
  return [...state.watched.entries()].filter(([, game]) => game.due <= now).sort((a, b) => a[1].due - b[1].due)[0];
}

/** Start watching; the first sweep comes {@link REVIEW_FIRST_SWEEP_MS} later. */
export function startReviewWatch(deps: ReviewWatchDeps): ReviewWatch {
  const state: WatchState = {
    watched: new Map(),
    nextSweep: deps.now() + REVIEW_FIRST_SWEEP_MS,
    lastSweep: Number.NEGATIVE_INFINITY,
    timer: null,
    reading: false,
    stopped: false,
    signedOut: false,
  };
  const schedule = (): void => {
    if (state.stopped || state.reading) return;
    if (state.timer !== null) deps.clearTimer(state.timer);
    const dues = state.signedOut ? [] : [...state.watched.values()].map((game) => game.due);
    const wait = Math.max(0, Math.min(state.nextSweep, ...dues) - deps.now());
    state.timer = deps.setTimer(() => {
      state.timer = null;
      void tick();
    }, wait);
  };
  const tick = async (): Promise<void> => {
    if (state.stopped) return;
    state.reading = true;
    try {
      if (deps.now() >= state.nextSweep) await sweep(deps, state);
      for (let next = dueGame(state, deps.now()); next; next = dueGame(state, deps.now())) {
        if (state.stopped || state.signedOut) break;
        await readGame(deps, state, next[0], next[1]);
      }
    } finally {
      state.reading = false;
      schedule();
    }
  };
  schedule();
  return {
    stop() {
      state.stopped = true;
      if (state.timer !== null) deps.clearTimer(state.timer);
      state.timer = null;
    },
    focus() {
      if (state.stopped || deps.now() - state.lastSweep <= REVIEW_FOCUS_SWEEP_MS) return;
      state.nextSweep = deps.now();
      schedule();
    },
    refresh(project) {
      if (state.stopped) return;
      const game = entryOf(state, project);
      game.due = deps.now();
      game.polls = 0;
      game.backoff = null;
      state.signedOut = false;
      schedule();
    },
  };
}
