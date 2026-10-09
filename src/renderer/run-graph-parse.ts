/**
 * The defensive readers behind `run-graph.ts`: every payload field the Builds graph reads comes
 * through here, so a record the harness wrote in another shape (or an older run's) reads as
 * absent rather than breaking the page.
 */
import { customRecord } from "../shared/custom-events.ts";
import type { EventEnvelope } from "../shared/event-log.ts";
import type {
  AdviceInfo,
  CheckResult,
  DiffInfo,
  FixInfo,
  FlagInfo,
  Liveness,
  MergeInfo,
  MoveInfo,
  Principle,
  Scoreboard,
  Shot,
  VerdictRecord,
} from "./run-graph.ts";

/** A payload, or any object inside one. */
export type Payload = Record<string, unknown>;

/** A string field, or the fallback. */
export const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
/** A non-empty string field, or null. */
export const strOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
/** A finite number field, or null. */
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** A boolean field, or null. */
export const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
/** A list field as strings, dropping empty slots; [] for anything else. */
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => v != null).map(String) : [];
/** Whether a value is an object and not an array. */
const isObjectValue = (value: unknown): value is object =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** An object field, or null (an array is not one). */
export const record = (value: unknown): Payload | null => (isObjectValue(value) ? (value as Payload) : null);
/** A list field's object rows, dropping anything else. */
export const records = (value: unknown): Payload[] =>
  Array.isArray(value) ? value.map((raw) => record(raw)).filter((row): row is Payload => row !== null) : [];

/** A plugin result is JSON text when the plugin returned an object; anything else is simply absent. */
export const parseJson = (value: unknown): Payload | null => {
  if (typeof value !== "string" || !value.startsWith("{")) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
};

/** A custom event with a name; a nameless one says nothing about the run. */
export function customOf(event: EventEnvelope): { event_type: string; payload: Payload } | null {
  const custom = customRecord(event.data);
  return custom?.event_type ? custom : null;
}

/**
 * Pull one field out of the host's arguments digest (`operation=create prompt=a red barn`).
 *
 * The digest is a chat line, not JSON: values keep their spaces, so a field ends where the next
 * `key=` begins. Anything that does not parse is simply absent — the whole digest is still shown
 * beside the card, so a miss here costs a label, never a fact.
 */
export function digestField(digest: string, key: string): string | null {
  if (typeof digest !== "string" || !digest) return null;
  const match = new RegExp(`(?:^|\\s)${key}=(.*?)(?=\\s[A-Za-z][A-Za-z0-9_-]*=|$)`).exec(digest);
  const value = match?.[1]?.trim() ?? "";
  return value || null;
}

/** One check row; `pass` is null when the row says it was not measured and `unmeasured` counts. */
function parseCheck(raw: unknown, readUnmeasured: boolean): CheckResult {
  const row = record(raw) ?? {};
  const unmeasured = readUnmeasured && row.unmeasured === true;
  return {
    id: str(row.id, "check"),
    kind: str(row.kind, ""),
    weight: str(row.weight, "normal"),
    pass: unmeasured ? null : bool(row.pass),
    reason: str(row.reason, ""),
  };
}

/** A round's scoreboard; null when it has no total. */
export function parseScoreboard(value: unknown): Scoreboard | null {
  const board = record(value);
  if (!board) return null;
  const total = num(board.total);
  if (total === null) return null;
  const results = Array.isArray(board.results) ? board.results.map((raw) => parseCheck(raw, true)) : [];
  return {
    total,
    passing: num(board.passing) ?? 0,
    unmeasured: num(board.unmeasured) ?? 0,
    plannedTotal: num(board.plannedTotal),
    plannedPassing: num(board.plannedPassing),
    plannedUnmeasured: num(board.plannedUnmeasured),
    grownTotal: num(board.grownTotal),
    identityTotal: num(board.identityTotal),
    identityPassing: num(board.identityPassing),
    flips: strings(board.flips),
    plannedFlips: Array.isArray(board.plannedFlips) ? strings(board.plannedFlips) : null,
    regressions: strings(board.regressions),
    results,
  };
}

function parseChecks(value: unknown): CheckResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => parseCheck(raw, false));
}

/** A verdict record off an event payload. Null when the payload has no sentence — an older run. */
export function parseVerdict(value: unknown): VerdictRecord | null {
  const row = record(value);
  const because = row ? str(row.because, "") : "";
  if (!row || !because) return null;
  const build = record(row.build) ?? {};
  const against = record(row.against) ?? {};
  const decision = record(row.decision) ?? {};
  return {
    pass: str(row.pass, "judge"),
    at: strOrNull(row.at),
    build: { head: strOrNull(build.head), worker: strOrNull(build.worker), round: num(build.round) },
    against: { head: strOrNull(against.head), what: strOrNull(against.what) },
    observed: parseObserved(record(row.observed) ?? {}),
    measured: parseMeasured(record(row.measured) ?? {}),
    seen: parseSeen(record(row.seen) ?? {}),
    decision: { kept: bool(decision.kept), rule: str(decision.rule, "unseen") },
    because,
  };
}

function parseObserved(observed: Payload): VerdictRecord["observed"] {
  return {
    ok: bool(observed.ok),
    problems: strings(observed.problems),
    cameras: strings(observed.cameras),
    demos: strings(observed.demos),
    consoleFresh: strings(observed.consoleFresh),
    consoleInherited: strings(observed.consoleInherited),
  };
}

function parseMeasured(measured: Payload): VerdictRecord["measured"] {
  return {
    planned: parseChecks(measured.planned),
    grown: parseChecks(measured.grown),
    flips: strings(measured.flips),
    regressions: strings(measured.regressions),
    unmeasured: strings(measured.unmeasured),
  };
}

function parseSeen(seen: Payload): VerdictRecord["seen"] {
  return {
    pick: strOrNull(seen.pick),
    veto: bool(seen.veto),
    satisfied: bool(seen.satisfied),
    question: strOrNull(seen.question),
    answer: bool(seen.answer),
    alive: num(seen.alive),
    aliveMax: num(seen.aliveMax),
    judgeCalls: num(seen.judgeCalls) ?? 0,
  };
}

/** The step a builder was asked for; null without a `what`. */
export function parseMove(value: unknown): MoveInfo | null {
  const move = record(value);
  if (!move) return null;
  const what = str(move.what, "");
  if (!what) return null;
  return {
    what,
    source: strOrNull(move.source),
    milestoneId: strOrNull(move.milestoneId),
    delivered: bool(move.delivered),
    scale: strOrNull(move.scale),
  };
}

/** The fix a builder was asked for; null without a `what`. */
export function parseFix(value: unknown): FixInfo | null {
  const fix = record(value);
  if (!fix) return null;
  const what = str(fix.what, "");
  if (!what) return null;
  return {
    what,
    checkId: strOrNull(fix.checkId),
    streak: num(fix.streak),
    mandatory: bool(fix.mandatory),
    delivered: bool(fix.delivered),
  };
}

function parsePrinciples(value: unknown): Principle[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const row = record(raw) ?? {};
    return {
      key: str(row.key, "?"),
      title: strOrNull(row.title),
      score: num(row.score),
      reason: str(row.reason, ""),
      fix: str(row.fix, ""),
    };
  });
}

/** `facet_liveness` carries principles; `facet_iteration.liveness` only `scores` — read both. */
export function parseLiveness(value: unknown): Liveness | null {
  const live = record(value);
  if (!live) return null;
  const principles = parsePrinciples(live.principles);
  const scores = record(live.scores);
  return {
    critic: strOrNull(live.critic),
    total: num(live.total),
    max: num(live.max),
    biggest: strOrNull(live.biggest),
    summary: strOrNull(live.summary),
    principles: principles.length === 0 && scores ? principlesFromScores(scores) : principles,
  };
}

function principlesFromScores(scores: Payload): Principle[] {
  return Object.entries(scores).map(([key, score]) => ({ key, title: null, score: num(score), reason: "", fix: "" }));
}

/** The flags a builder raised; a flag with neither a `what` nor a check says nothing. */
export function parseFlags(value: unknown): FlagInfo[] {
  return records(value)
    .map((row) => ({ what: str(row.what, ""), checkId: strOrNull(row.checkId), target: strOrNull(row.target) }))
    .filter((flag) => flag.what || flag.checkId);
}

/** The stills of a round; a shot without a path is dropped. */
export function parseShots(value: unknown): Shot[] {
  return records(value)
    .filter((row) => typeof row.path === "string" && row.path !== "")
    .map((row) => ({ camera: str(row.camera, "shot"), path: String(row.path) }));
}

/** A critic's advice as the round shows it; null without one defect, a bold move or a gate answer. */
export function parseAdvice(payload: Payload, at: string): AdviceInfo | null {
  const defects = records(payload.defects)
    .map((row) => ({ defect: str(row.defect, ""), fix: str(row.fix, "") }))
    .filter((row) => row.defect);
  const boldMove = str(payload.boldMove, "");
  const gates = strings(payload.gates).filter(Boolean);
  if (!defects.length && !boldMove && !gates.length) return null;
  return { at: strOrNull(payload.at) ?? at, defects, boldMove, gates, shots: strings(payload.shots) };
}

/** The per-camera pixel diffs of a round. */
export function parseDiffs(value: unknown): DiffInfo[] {
  const diffs = record(value);
  if (!diffs) return [];
  return Object.entries(diffs).map(([camera, raw]) => {
    const row = record(raw) ?? {};
    return { camera, diffFraction: num(row.diffFraction), heatmapPath: strOrNull(row.heatmapPath) };
  });
}

/** Where a merge sits: the part and round it names (after restarts fold), when, and its place in the log. */
export interface MergePlace {
  facetId: string | null;
  iteration: number | null;
  at: string;
  seq: number;
}

/** One `integration_merge`. */
export function parseMerge(payload: Payload, place: MergePlace): MergeInfo {
  return {
    facetId: place.facetId ?? str(payload.facetId, "?"),
    iteration: place.iteration,
    at: place.at,
    seq: place.seq,
    head: strOrNull(payload.head) ?? strOrNull(payload.commit),
    conflict: payload.conflict === true,
    union: payload.union === true,
    stage: strOrNull(payload.stage),
  };
}
