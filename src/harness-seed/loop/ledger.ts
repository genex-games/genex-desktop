/**
 * The run ledger — what this game's runs taught, kept where the next run can read it.
 *
 * The studio already learns two things between runs: skills (skillopt.ts, the blind pairwise
 * gate) and techniques (library.ts, recipes promoted and retired by check outcomes). Neither
 * remembers a *game*. So the second run on a game repeats the first one's run: the same
 * fork point that would not run, the same judge naming the same defect, the same three checks
 * that never measured anything. The first real director run lost eight of its twenty-one
 * rounds to one inherited console error, and nothing anywhere wrote that down.
 *
 * This is that memory, and it is deliberately dumb: one append-only record per outcome, in the
 * studio's own state (`library/games/<game>.jsonl` in the harness workspace — never the user's
 * repo, whose branch is theirs), and a derived `library/games/<game>.md` the briefs carry. No
 * model call is involved in writing or reading it: the ledger always writes, whatever the
 * self-improvement switch says, because a record of what happened is not a self-change.
 *
 * There are two ways a record is made and one shape it comes out in:
 *  - **live** — the director calls `roundRecord` / `refusalRecord` / `closeRecord` as the run
 *    happens, which is the only way to capture what the worker was actually told (`briefDigest`)
 *    and how long it ran;
 *  - **replayed** — `ledgerFromEvents` reads a finished run's log back into the same records,
 *    which is how a run from before this file existed still teaches the next one.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventKind, RunEvent, RunMode } from "./run-events.ts";
import { roundRule, VerdictPass, VerdictRule, VerdictSource, verdictRecord } from "./verdict.ts";
import { Side } from "./judge.ts";
import type { AnyRecord } from "../types/harness.d.ts";
import type { Catalogue } from "./spec.ts";

/** Check counts as a caller hands them: `passing` or `passed`, and a total to subtract from. */
export interface CheckCounts {
  passed?: number;
  passing?: number;
  failed?: number;
  unmeasured?: number;
  total?: number;
}

/** One outcome in a game's ledger: a round kept, undone or stopped, a builder refused, or a run's close. */
export interface LedgerRecord {
  at: string;
  runId: string | null;
  mode: string;
  game: string | null;
  gameKind: string | null;
  part: string | null;
  title: string | null;
  round: number;
  decision: string;
  rule: string | null;
  because: string;
  gap: string;
  checks: { passed: number; failed: number; unmeasured: number };
  unmeasuredChecks: string[];
  minutes: number | null;
  briefDigest: string;
}

/** What a caller may know about an outcome; everything is optional and normalised. */
export interface LedgerFields {
  runId?: string | null;
  mode?: string;
  game?: string | null;
  gameKind?: string | null;
  part?: string | null;
  title?: string | null;
  round?: number;
  decision?: string;
  rule?: string | null;
  because?: string;
  gap?: string;
  checks?: CheckCounts | null;
  unmeasuredChecks?: ReadonlyArray<{ id?: string } | string | null | undefined>;
  minutes?: number | null;
  brief?: string;
  briefDigest?: string;
  at?: string | null;
}

/** A round's board as the ledger reads it: counts, flips, and which checks came back unmeasured. */
export interface RoundBoard {
  passing?: number;
  unmeasured?: number;
  total?: number;
  flips?: string[];
  regressions?: string[];
  unmeasuredChecks?: ReadonlyArray<{ id?: string } | string>;
  results?: ReadonlyArray<{ id?: string; pass?: boolean | null } | null | undefined>;
}

/**
 * What became of one round. The close uses kept/undone too: a run that made nothing live is
 * undone. Ledgers on disk keep these: never rename a value.
 */
export const LedgerDecision = {
  Kept: "kept",
  Undone: "undone",
  Stopped: "stopped",
  Refused: "refused",
} as const;
export type LedgerDecision = (typeof LedgerDecision)[keyof typeof LedgerDecision];

/** What became of one round, for code that checks one at run time. */
export const LEDGER_DECISIONS: string[] = Object.values(LedgerDecision);
/** The most records one game's ledger keeps; the close trims to it. Older runs stop teaching. */
export const MAX_RECORDS = 600;
/** How much of a brief a record keeps — enough to recognise what was asked, not enough to re-read. */
const MAX_BRIEF = 300;
/** A check unmeasured this many rounds on the same kind of game is not a check, it is a wish. */
export const RARELY_MEASURABLE_ROUNDS = 3;
/** A defect named this often by the judges is a pattern, not a run. */
const REPEAT_MIN = 2;
/** What a record keeps of its game's name, its title, its sentence and its gap. */
const MAX_GAME_SLUG = 60;
const TITLE_CHARS = 120;
const BECAUSE_CHARS = 240;
const GAP_CHARS = 200;
/** How many unmeasured checks a record names. */
const MAX_UNMEASURED_NAMED = 12;
/** A part's name as a lesson says it, and a lesson as a brief carries it. */
const PART_NAME_CHARS = 48;
const LESSON_CHARS = 260;
/** How many repeated defects and never-measured checks a lesson names. */
const DEFECTS_NAMED = 3;
const CHECKS_NAMED = 6;
/** A run's date in the lessons file: the `YYYY-MM-DD` of its ISO timestamp. */
const ISO_DATE_CHARS = 10;
/** Where `unmeasuredTally` files a record that names no kind of game: its checks count for every kind. */
const ANY_KIND = "any";

const slug = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_GAME_SLUG) || "game";
/** Text on one line, cut at a word to fit `max` with `…` when it had to be. */
const clipWords = (value: unknown, max: number): string => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/[\s,;:-]+\S*$/, "")}…` : text;
};
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
/** `…; nothing was landed (land=no)` — the close's own tail, which the record's decision already says. */
const LANDING_CLAUSE = /;\s*(?:nothing was landed|the integration branch was landed)(?:\s*\([^)]*\))?\s*$/i;
/** A part's name as a person would say it: the lead's titles run "Post and camera: filmic grade, …". */
const partName = (title: unknown): string =>
  clipWords(String(title ?? "").split(/[:—–]/)[0], PART_NAME_CHARS) || "that part";
/** A whole number of at least zero, from whatever a caller had. */
const count0 = (value: unknown): number => Math.max(0, Math.trunc(Number(value ?? 0) || 0));
/** A value as text, or null when there is none. */
const textOrNull = (value: unknown): string | null => (value ? String(value) : null);

/**
 * The counts a record keeps. Reading a stored record back through here must give the same
 * record, so a counted `failed` is accepted beside a `total` to subtract one from.
 */
function checkCounts(checks: CheckCounts | null): LedgerRecord["checks"] {
  const numbers: CheckCounts = checks ?? {};
  const passed = count0(numbers.passed ?? numbers.passing);
  const unmeasured = count0(numbers.unmeasured);
  const failed = count0(numbers.failed);
  const total = Math.max(passed + unmeasured + failed, count0(numbers.total));
  return { passed, failed: Math.max(failed, total - passed - unmeasured), unmeasured };
}

/** The ids of the checks that came back unmeasured, once each. */
function unmeasuredIds(list: LedgerFields["unmeasuredChecks"]): string[] {
  const ids = (list ?? []).map((c) => String((c as { id?: string } | null)?.id ?? c ?? "")).filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_UNMEASURED_NAMED);
}

/**
 * One outcome, normalised. Everything a caller may not have becomes null or empty rather than
 * missing, so a record replayed from a two-month-old log and one written a second ago compare.
 */
export function ledgerRecord({
  runId = null,
  mode = RunMode.Director,
  game = null,
  gameKind = null,
  part = null,
  title = null,
  round = 0,
  decision = LedgerDecision.Undone,
  rule = null,
  because = "",
  gap = "",
  checks = null,
  unmeasuredChecks = [],
  minutes = null,
  brief = "",
  briefDigest = "",
  at = null,
}: LedgerFields = {}): LedgerRecord {
  // Reading a stored record back through here must give the same record, so every field is
  // accepted in the shape it is written in as well as the shape a caller hands it: `briefDigest`
  // beside `brief`, a counted `failed` beside a `total` to subtract one from.
  return {
    at: at ?? new Date().toISOString(),
    runId: textOrNull(runId),
    mode: String(mode || RunMode.Director),
    game: textOrNull(game),
    gameKind: textOrNull(gameKind),
    part: textOrNull(part),
    title: clipWords(title ?? part ?? "", TITLE_CHARS) || null,
    round: count0(round),
    decision: LEDGER_DECISIONS.includes(decision) ? decision : LedgerDecision.Undone,
    rule: textOrNull(rule),
    because: clipWords(because, BECAUSE_CHARS),
    gap: clipWords(gap, GAP_CHARS),
    checks: checkCounts(checks),
    unmeasuredChecks: unmeasuredIds(unmeasuredChecks),
    minutes: Number.isFinite(Number(minutes)) ? Math.max(0, Math.round(Number(minutes))) : null,
    briefDigest: clipWords(brief || briefDigest, MAX_BRIEF),
  };
}

/** What a round came to: stopped before it was judged, kept, or undone. */
function roundDecision(stopped: boolean, won: boolean): LedgerDecision {
  if (stopped) return LedgerDecision.Stopped;
  return won ? LedgerDecision.Kept : LedgerDecision.Undone;
}

/**
 * A judged or stopped round. The sentence is the verdict module's, so the ledger, the round card
 * and the morning card all say the same thing about the same round and none of them carries a
 * check id into it.
 */
export function roundRecord({
  winner = null,
  satisfied = false,
  verdictSource = null,
  scoreboard = null,
  gap = "",
  ...rest
}: Omit<LedgerFields, "decision" | "rule" | "because" | "checks" | "unmeasuredChecks"> & {
  winner?: string | null;
  satisfied?: boolean;
  verdictSource?: string | null;
  scoreboard?: RoundBoard | null;
} = {}): LedgerRecord {
  const board: RoundBoard = scoreboard ?? {};
  const won = winner === Side.Challenger;
  const rule = roundRule({ source: verdictSource, won, satisfied: satisfied === true });
  return ledgerRecord({
    ...rest,
    decision: roundDecision(verdictSource === VerdictSource.Stopped, won),
    rule,
    because: verdictRecord({
      pass: VerdictPass.Round,
      rule,
      flips: board.flips ?? [],
      regressions: board.regressions ?? [],
      gap,
    }).because,
    gap,
    checks: { passed: board.passing ?? 0, unmeasured: board.unmeasured ?? 0, total: board.total ?? 0 },
    // A round from before the payload carried the ids still has its results, and an unmeasured
    // check is one that came back neither true nor false — so a run already on disk teaches
    // `rarelyMeasurable` too, instead of counting three unmeasured checks and naming none.
    unmeasuredChecks:
      board.unmeasuredChecks ??
      (board.results ?? []).filter((r) => r?.pass !== true && r?.pass !== false).map((r) => r?.id),
  });
}

/**
 * A builder the fork gate refused: no round happened at all, which is the loss the user feels.
 */
export function refusalRecord({
  because = "",
  problems = [],
  ...rest
}: Omit<LedgerFields, "round" | "decision" | "rule"> & { problems?: string[] } = {}): LedgerRecord {
  return ledgerRecord({
    ...rest,
    round: 0,
    decision: LedgerDecision.Refused,
    rule: VerdictRule.DoesNotStart,
    because: because || verdictRecord({ pass: VerdictPass.Gate, rule: VerdictRule.DoesNotStart, problems }).because,
  });
}

/**
 * The run itself, as one outcome: kept when a build was made live, undone when nothing was.
 */
export function closeRecord({
  landed = false,
  because = "",
  ...rest
}: Omit<LedgerFields, "round" | "part" | "decision" | "rule"> & { landed?: boolean } = {}): LedgerRecord {
  return ledgerRecord({
    ...rest,
    round: 0,
    part: null,
    decision: landed ? LedgerDecision.Kept : LedgerDecision.Undone,
    rule: landed ? VerdictRule.Landed : VerdictRule.NotLanded,
    because,
  });
}

// ── the file ───────────────────────────────────────────────────────────────────────────────

export function ledgerFile(workspace: string, game: unknown): string {
  return path.join(workspace, "library", "games", `${slug(game)}.jsonl`);
}

export function lessonsFile(workspace: string, game: unknown): string {
  return path.join(workspace, "library", "games", `${slug(game)}.md`);
}

/**
 * Append one record. Append-only and one JSON object per line on purpose: two workers finishing
 * a round in the same second must not lose each other's outcome, which a read-modify-write of a
 * single JSON array would do.
 */
export async function appendLedger(workspace: string, game: string, record: LedgerRecord): Promise<LedgerRecord> {
  const file = ledgerFile(workspace, game);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`);
  return record;
}

/** Every record this game has, oldest first. A line that will not parse is skipped, never fatal. */
export async function readLedger(workspace: string, game: string): Promise<LedgerRecord[]> {
  const text = await readFile(ledgerFile(workspace, game), "utf8").catch(() => "");
  const out: LedgerRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(ledgerRecord(JSON.parse(line)));
    } catch {
      /* a half-written line from a hard kill is one lost outcome, not a lost ledger */
    }
  }
  return out;
}

/** Rewrite the ledger with its newest records only — one compaction per run, at the close. */
export async function trimLedger(workspace: string, game: string, records: LedgerRecord[]): Promise<LedgerRecord[]> {
  if (records.length <= MAX_RECORDS) return records;
  const kept = records.slice(-MAX_RECORDS);
  const file = ledgerFile(workspace, game);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${kept.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return kept;
}

// ── replay ─────────────────────────────────────────────────────────────────────────────────

const payloadsOf = (events: readonly AnyRecord[] | null | undefined, type: string): AnyRecord[] =>
  (events ?? [])
    .map((event) => event?.data ?? event)
    .filter((data: AnyRecord | null) => data?.type === EventKind.Custom && data.event_type === type)
    .map((data: AnyRecord) => data.payload ?? {});

/** What the run's worker cards say about each worker: its title and its minutes. */
interface WorkerFacts {
  titles: Map<string, string>;
  minutesById: Map<string, number>;
}

/** The titles and budgets the run's `director_worker` cards gave its workers. */
function workerFacts(events: readonly AnyRecord[] | null | undefined): WorkerFacts {
  const titles = new Map<string, string>();
  const minutesById = new Map<string, number>();
  for (const worker of payloadsOf(events, RunEvent.DirectorWorker)) {
    if (!worker.workerId) continue;
    if (worker.title) titles.set(worker.workerId, worker.title);
    if (Number.isFinite(Number(worker.minutes))) minutesById.set(worker.workerId, Number(worker.minutes));
  }
  return { titles, minutesById };
}

/** What every record replayed from one run carries. */
type ReplayCommon = { runId: string | null; mode: string; game: string | null; gameKind: string | null };

/** A judged or stopped round, from its `facet_iteration` (or `run_iteration`) card. */
function replayedRound(payload: AnyRecord, event: AnyRecord, common: ReplayCommon, facts: WorkerFacts): LedgerRecord {
  return roundRecord({
    ...common,
    part: payload.facetId ?? null,
    title: facts.titles.get(payload.facetId) ?? payload.facetTitle ?? null,
    round: payload.iteration ?? 0,
    winner: payload.winner ?? null,
    satisfied: payload.satisfied === true,
    verdictSource: payload.verdictSource ?? null,
    scoreboard: payload.scoreboard ?? null,
    gap: payload.biggest_gap ?? "",
    minutes: facts.minutesById.get(payload.facetId) ?? null,
    at: event?.created_at ?? null,
  });
}

/** The lead's fork gate, in the shape every judging pass writes (verdict.ts) — when it refused a builder. */
function replayedRefusal(
  payload: AnyRecord,
  event: AnyRecord,
  common: ReplayCommon,
  facts: WorkerFacts,
): LedgerRecord | null {
  if (payload.pass !== VerdictPass.Gate || payload.decision?.kept !== false) return null;
  return refusalRecord({
    ...common,
    part: payload.build?.worker ?? null,
    title: facts.titles.get(payload.build?.worker) ?? null,
    because: payload.because ?? "",
    at: payload.at ?? event?.created_at ?? null,
  });
}

/**
 * The run's close. A close from before `landingResult` existed has only the run's own prose;
 * its landing clause is the one part the record already carries as `decision`.
 */
function replayedClose(payload: AnyRecord, event: AnyRecord, common: ReplayCommon): LedgerRecord {
  return closeRecord({
    ...common,
    mode: payload.mode ?? common.mode,
    landed: payload.landed === true,
    because: payload.landingResult?.line ?? String(payload.stoppedBecause ?? "").replace(LANDING_CLAUSE, ""),
    at: payload.finishedAt ?? event?.created_at ?? null,
  });
}

/** The record one logged event makes, if it makes one. */
function replayedRecord(
  data: AnyRecord,
  event: AnyRecord,
  common: ReplayCommon,
  facts: WorkerFacts,
): LedgerRecord | null {
  const payload = data.payload ?? {};
  switch (data.event_type) {
    case RunEvent.FacetIteration:
    case RunEvent.RunIteration:
      return replayedRound(payload, event, common, facts);
    case RunEvent.DirectorVerdict:
      return replayedRefusal(payload, event, common, facts);
    case RunEvent.RunFinished:
      return replayedClose(payload, event, common);
    default:
      return null;
  }
}

/**
 * A finished run's log, read back as ledger records — the same records the live path writes,
 * minus what only the run knew (a worker's brief, the minutes it ran). This is how the first
 * director run, recorded before any of this existed, still teaches the next one. `events` are
 * logged events, or their `data`.
 */
export function ledgerFromEvents(
  events: readonly AnyRecord[] | null | undefined,
  {
    game = null,
    gameKind = null,
    mode = RunMode.Director,
  }: { game?: string | null; gameKind?: string | null; mode?: string } = {},
): LedgerRecord[] {
  const facts = workerFacts(events);
  const records: LedgerRecord[] = [];
  for (const event of events ?? []) {
    const data = event?.data ?? event;
    if (data?.type !== EventKind.Custom) continue;
    const payload = data.payload ?? {};
    const common = { runId: payload.runId ?? null, mode, game: game ?? payload.project ?? null, gameKind };
    const record = replayedRecord(data, event, common, facts);
    if (record) records.push(record);
  }
  return records;
}

// ── what the records add up to ─────────────────────────────────────────────────────────────

const isRound = (record: LedgerRecord): boolean => record.round > 0;

/** The sentence one undone rule earns, with what to do about it. Order is by how often it bit. */
const UNDONE_LESSON: Partial<Record<string, (n: number, of: number) => string>> = {
  [VerdictRule.Broken]: (n, of) =>
    `${n} of ${of} rounds were undone because the game did not start after the build. Look at what a builder forks from before you start it, and tell it which console errors it inherited.`,
  [VerdictRule.ChecksRegressed]: (n, of) =>
    `${n} of ${of} rounds were undone because a check that used to pass stopped passing. Name what must not move in the brief, not only what must change.`,
  [VerdictRule.Vetoed]: (n, of) =>
    `${n} of ${of} rounds were undone by the judge preferring the round before, on the blind pick or over a regression it named. Make the change one a player would notice, and name in the brief what must not get worse.`,
  [VerdictRule.NoMove]: (n, of) =>
    `${n} of ${of} rounds were undone because the structural step that was asked for did not arrive. Ask for one visible change per round and say how it will be seen.`,
  [VerdictRule.Unfixed]: (n, of) =>
    `${n} of ${of} rounds were undone because the problem named the round before was still there. Replace the mechanism behind it instead of tuning it.`,
  [VerdictRule.Unreachable]: (n, of) =>
    `${n} of ${of} rounds were undone because the judge could not be reached. Nothing was wrong with the build.`,
  [VerdictRule.NoChange]: (n, of) =>
    `${n} of ${of} rounds were undone because every camera showed exactly what the round before showed.`,
};

/** The bracket tag the judges keep opening a gap with — `[floating]`, `[haze-plane]`. */
function repeatedDefects(records: readonly LedgerRecord[]): Array<[string, number]> {
  const tally = new Map<string, number>();
  for (const record of records) {
    const match = /^\[([^\]\n]{2,40})\]/.exec(record.gap ?? "");
    if (!match) continue;
    const name = String(match[1]).trim().toLowerCase();
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  return [...tally.entries()].filter(([, n]) => n >= REPEAT_MIN).sort((a, b) => b[1] - a[1]);
}

/** Checks that came back unmeasured, by game kind — the catalogue's `rarelyMeasurable` evidence. */
export function unmeasuredTally(records: readonly LedgerRecord[]): Map<string, Map<string, number>> {
  const byKind = new Map<string, Map<string, number>>();
  for (const record of records) {
    if (!isRound(record)) continue;
    const kind = record.gameKind ?? ANY_KIND;
    const tally = byKind.get(kind) ?? new Map<string, number>();
    for (const id of record.unmeasuredChecks) tally.set(id, (tally.get(id) ?? 0) + 1);
    byKind.set(kind, tally);
  }
  return byKind;
}

/**
 * The checks this kind of game has never been able to measure. A check the harness cannot read
 * is worse than no check: it holds "satisfied" out of reach forever while reading as neither a
 * pass nor a failure, and a run could finish with `identityTotal 0` on every board.
 */
export function rarelyMeasurable(
  records: readonly LedgerRecord[],
  { kind = null, rounds = RARELY_MEASURABLE_ROUNDS }: { kind?: string | null; rounds?: number } = {},
): Array<{ id: string; rounds: number }> {
  const out = new Map<string, number>();
  for (const [k, tally] of unmeasuredTally(records)) {
    const otherKind = kind && k !== kind && k !== ANY_KIND;
    if (otherKind) continue;
    for (const [id, n] of tally) if (n >= rounds) out.set(id, Math.max(out.get(id) ?? 0, n));
  }
  return [...out.entries()].map(([id, n]) => ({ id, rounds: n })).sort((a, b) => b.rounds - a.rounds);
}

/** One catalogue entry, told how often a kind of game left it unmeasured, and flagged when that is too often. */
function flagEntry(entry: AnyRecord, kind: string, n: number): void {
  entry.unmeasuredRounds = { ...((entry.unmeasuredRounds as Record<string, number> | undefined) ?? {}), [kind]: n };
  const kinds = new Set<string>((entry.rarelyMeasurable as string[] | undefined) ?? []);
  if (n >= RARELY_MEASURABLE_ROUNDS) kinds.add(kind);
  else kinds.delete(kind);
  if (kinds.size) entry.rarelyMeasurable = [...kinds].sort();
  else delete entry.rarelyMeasurable;
}

/**
 * The catalogue, weighted by what the runs could actually read. Only entries the catalogue
 * already knows are flagged: an id nobody has recorded a definition for would reach the planner
 * as `{"id":"…"}` with no way to run it.
 */
export function flagRarelyMeasurable<C extends Partial<Pick<Catalogue, "checks">> | null>(
  catalogue: C,
  records: readonly LedgerRecord[],
): C {
  const checks = catalogue?.checks ?? {};
  for (const [kind, tally] of unmeasuredTally(records)) {
    for (const [id, n] of tally) {
      const entry = checks[id];
      if (entry) flagEntry(entry, kind, n);
    }
  }
  return catalogue;
}

/** How often each rule undid a round, commonest first. */
function undoneByRule(undone: readonly LedgerRecord[]): Array<[string | null, number]> {
  const byRule = new Map<string | null, number>();
  for (const record of undone) byRule.set(record.rule, (byRule.get(record.rule) ?? 0) + 1);
  return [...byRule.entries()].sort((a, b) => b[1] - a[1]);
}

/** Why rounds are lost here, commonest first — the one thing a run can act on before it starts. */
function undoneLessons(undone: readonly LedgerRecord[], rounds: number): string[] {
  const lessons: string[] = [];
  for (const [rule, n] of undoneByRule(undone)) {
    const line = UNDONE_LESSON[rule as string];
    if (line && n >= REPEAT_MIN) lessons.push(line(n, rounds));
  }
  return lessons;
}

/**
 * Whether the game ever became something the user could play comes before any craft note: only
 * the first five lessons reach a brief. The close's own sentence, minus the half that only
 * repeats the lesson's own opening.
 */
function unlandedLesson(closes: readonly LedgerRecord[]): string | null {
  const unlanded = closes.filter((c) => c.decision === LedgerDecision.Undone);
  const last = unlanded.at(-1);
  if (!last) return null;
  const why = /^nothing was made live\.?$/i.test(last.because.trim()) ? "" : last.because;
  const lastWhy = why
    ? ` — the last one because ${why.replace(/\.$/, "").replace(/^(Nothing was made live:|Undone:)\s*/i, "")}`
    : "";
  return `${unlanded.length} of ${count(closes.length, "run")} on this game made nothing live${lastWhy}. Leave time to integrate, look and finish.`;
}

/** The same things the judges keep naming, as a lesson. */
function defectsLesson(rounds: readonly LedgerRecord[]): string | null {
  const defects = repeatedDefects(rounds);
  if (!defects.length) return null;
  const named = defects
    .slice(0, DEFECTS_NAMED)
    .map(([name, n]) => `"${name}" (${count(n, "round")})`)
    .join(", ");
  return `The judges on this game keep naming the same things: ${named}. Expect them and build against them from the first round.`;
}

/** The checks that have never measured anything here, as a lesson. */
function neverMeasuredLesson(records: readonly LedgerRecord[]): string | null {
  const never = rarelyMeasurable(records, { rounds: REPEAT_MIN });
  if (!never.length) return null;
  const named = never
    .slice(0, CHECKS_NAMED)
    .map((c) => `${c.id} (${count(c.rounds, "round")})`)
    .join(", ");
  return `These checks have never measured anything here: ${named}. Re-point them at something the build reports, or do not write them.`;
}

/** What worked: the seam whose rounds were kept, so the next run starts where the last one paid. */
function whatWorkedLesson(rounds: readonly LedgerRecord[]): string | null {
  const byPart = new Map<string | null, { title: string | null; kept: number; total: number }>();
  for (const record of rounds) {
    const entry = byPart.get(record.part) ?? { title: record.title ?? record.part, kept: 0, total: 0 };
    entry.total += 1;
    if (record.decision === LedgerDecision.Kept) entry.kept += 1;
    if (record.title) entry.title = record.title;
    byPart.set(record.part, entry);
  }
  const best = [...byPart.values()]
    .filter((e) => e.total >= REPEAT_MIN && e.kept > e.total / 2)
    .sort((a, b) => b.kept - a.kept)[0];
  if (!best) return null;
  return `What worked: rounds on "${partName(best.title)}" were kept ${best.kept} of ${best.total} times. That seam pays here.`;
}

/**
 * The game's lessons, most useful first — patterns of undone rounds, what its judges reject,
 * checks that never measure, and what worked. Every line is one sentence a brief can carry as
 * it stands; nothing here needs a model, and nothing here is a guess about the future.
 */
export function deriveLessons(records: readonly LedgerRecord[], { limit = 12 }: { limit?: number } = {}): string[] {
  const rounds = records.filter(isRound);
  const stopped = rounds.filter((r) => r.decision === LedgerDecision.Stopped);
  const refusals = records.filter((r) => r.decision === LedgerDecision.Refused);
  const closes = records.filter((r) => !isRound(r) && r.decision !== LedgerDecision.Refused);
  const lessons = [
    ...undoneLessons(
      rounds.filter((r) => r.decision === LedgerDecision.Undone),
      rounds.length,
    ),
    refusals.length >= REPEAT_MIN
      ? `${count(refusals.length, "builder")} never started at all: the build they would have forked from did not run. Fix the fork point and look at it before handing out work.`
      : null,
    unlandedLesson(closes),
    defectsLesson(rounds),
    neverMeasuredLesson(records),
    whatWorkedLesson(rounds),
    stopped.length >= REPEAT_MIN
      ? `${count(stopped.length, "round")} were stopped mid-flight by the lead. Their work was kept, but the time was not: decide the shape of the run before starting builders.`
      : null,
  ].filter((lesson): lesson is string => lesson !== null);
  return lessons.map((l) => clipWords(l, LESSON_CHARS)).slice(0, limit);
}

/** The block both briefs carry: what this game already cost, in the fewest words that still act. */
export function lastTimeBlock(
  lessons: readonly string[] | null | undefined,
  { limit = 5 }: { limit?: number } = {},
): string {
  const top = (lessons ?? []).filter(Boolean).slice(0, limit);
  if (top.length === 0) return "";
  return [
    `LAST TIME ON THIS GAME (what earlier runs on this exact game cost — do not pay for them again):`,
    ...top.map((lesson) => `- ${lesson}`),
  ].join("\n");
}

/** Why most of this run's undone work went, in the morning card's words, by rule. */
const UNDONE_WHY: Partial<Record<string, string>> = {
  [VerdictRule.Broken]: "the game did not start after the build",
  [VerdictRule.ChecksRegressed]: "something that used to work stopped working",
  [VerdictRule.Vetoed]: "the judge preferred the round before",
  [VerdictRule.NoMove]: "the change that was asked for did not arrive",
  [VerdictRule.Unfixed]: "the problem it was told to fix was still there",
  [VerdictRule.Unreachable]: "the judge could not be reached",
  [VerdictRule.NoChange]: "nothing on screen had changed",
};

/** The part whose rounds were kept most often this run. */
function mostKeptPart(rounds: readonly LedgerRecord[]): { title: string; kept: number } | undefined {
  const byPart = new Map<string | null, { title: string; kept: number }>();
  for (const record of rounds) {
    const entry = byPart.get(record.part) ?? { title: record.title ?? "this part", kept: 0 };
    if (record.decision === LedgerDecision.Kept) entry.kept += 1;
    byPart.set(record.part, entry);
  }
  return [...byPart.values()].sort((a, b) => b.kept - a.kept)[0];
}

/**
 * Where this run's kept rounds were. The sentence agrees with its own count: one kept round was
 * kept, and "most of them" is only true of a part that holds more than half of them.
 */
function keptWhere(best: { title: string; kept: number } | undefined, kept: number): string {
  if (!best?.kept) return "";
  if (kept === 1) return `, on ${partName(best.title)}`;
  return best.kept > kept / 2 ? `, most of them on ${partName(best.title)}` : "";
}

/**
 * One plain sentence for the morning card: what this run, specifically, taught. It carries no
 * check id and no part id — the user reads it over their coffee, not in a log.
 */
export function learnedThisRun(records: readonly LedgerRecord[]): string {
  const rounds = records.filter(isRound);
  if (rounds.length === 0) return "";
  const kept = rounds.filter((r) => r.decision === LedgerDecision.Kept);
  const [rule, n = 0] = undoneByRule(rounds.filter((r) => r.decision === LedgerDecision.Undone))[0] ?? [];
  const why = rule ? UNDONE_WHY[rule] : undefined;
  const mostlyOneWay = why && n >= REPEAT_MIN && n >= kept.length;
  if (mostlyOneWay) {
    return `Most of the work that was undone went the same way: ${why}. The studio has written that down for next time.`;
  }
  if (kept.length === 0) return "";
  const one = kept.length === 1;
  const where = keptWhere(mostKeptPart(rounds), kept.length);
  return `${kept.length} of ${count(rounds.length, "round")} ${one ? "was" : "were"} kept${where}. The studio has written down what worked for next time.`;
}

/** One run as the lessons file lists it. */
type LoopRunTally = AnyRecord & { at: string; rounds: number; refused: number; close: string | null };

/** Every run in the ledger, tallied: its rounds by decision, the builders refused, and how it closed. */
function loopRunsOf(records: readonly LedgerRecord[]): Map<string, LoopRunTally> {
  const loopRuns = new Map<string, LoopRunTally>();
  for (const record of records) {
    if (!record.runId) continue;
    const loopRun = loopRuns.get(record.runId) ?? {
      at: record.at,
      rounds: 0,
      kept: 0,
      undone: 0,
      stopped: 0,
      refused: 0,
      close: null,
    };
    if (isRound(record)) {
      loopRun.rounds += 1;
      loopRun[record.decision] = (loopRun[record.decision] ?? 0) + 1;
    } else if (record.decision === LedgerDecision.Refused) loopRun.refused += 1;
    else
      loopRun.close =
        record.because || (record.decision === LedgerDecision.Kept ? "made live" : "nothing was made live");
    loopRuns.set(record.runId, loopRun);
  }
  return loopRuns;
}

/** One run as a line of the lessons file. */
function loopRunLine(loopRun: LoopRunTally): string {
  const stopped = loopRun.stopped ? `, ${loopRun.stopped} stopped` : "";
  const refused = loopRun.refused ? `, ${count(loopRun.refused, "builder")} refused before starting` : "";
  const close = loopRun.close ? ` — ${loopRun.close}` : "";
  return `- ${String(loopRun.at).slice(0, ISO_DATE_CHARS)} — ${count(loopRun.rounds, "round")}, ${loopRun.kept ?? 0} kept, ${loopRun.undone ?? 0} undone${stopped}${refused}${close}`;
}

/** The derived file a person (or a resumed run) can read: the lessons, then the runs behind them. */
export function renderGameLessons(game: string, records: readonly LedgerRecord[]): string {
  const lessons = deriveLessons(records);
  return [
    `# What the studio learned on "${game}"`,
    ``,
    `Written by the studio itself after every run on this game, from its own ledger of outcomes.`,
    `The first five lines go into the next run's brief and into every builder's BRIEF.md.`,
    ``,
    `## Lessons`,
    ``,
    ...(lessons.length ? lessons.map((l) => `- ${l}`) : ["- Nothing yet: this game has not finished a judged round."]),
    ``,
    `## The runs behind them`,
    ``,
    ...[...loopRunsOf(records).values()].map(loopRunLine),
    ``,
  ].join("\n");
}

/** Write the derived lessons file beside the ledger, and hand back what it now says. */
export async function saveGameLessons(
  workspace: string,
  game: string,
  records: readonly LedgerRecord[],
): Promise<{ file: string; lessons: string[] }> {
  const file = lessonsFile(workspace, game);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderGameLessons(game, records));
  return { file, lessons: deriveLessons(records) };
}

/** The lessons the next run's briefs carry. Derived from the ledger, never parsed back out of the markdown. */
export async function loadGameLessons(workspace: string, game: string, limit = 5): Promise<string[]> {
  const records = await readLedger(workspace, game).catch(() => []);
  return deriveLessons(records).slice(0, limit);
}
