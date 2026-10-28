/**
 * Reports of what a game's AI wrote (owner decision D9): one AI-native replay bundle, built here
 * from this session's calls and the game's own capture, redacted, and sent to genex.games, which
 * puts it in the moderation queue and in the creator's Studio as a "Player report" their agent can
 * replay with `ai.replay` and fix.
 *
 * The session is what the service hands its trace sink (`observe`): every settled call of a game,
 * text included, kept in memory only and only for the most recent games. A bundle carries those
 * calls (an unchanged system prompt named by its hash), the tape a deterministic replay answers
 * from (each fitting answer at its key's occurrence), the game's capture (seed, build commit,
 * inputs, state digests, `state().ai`, console errors, one frame) and the model check's row for the
 * model the game used. It never carries an account; keys, emails and phone numbers are redacted
 * everywhere, the keys of free JSON included. An automatic bundle (a reply still invalid after its
 * repair) carries no player text and goes once per call, a few per game an hour.
 *
 * The capture comes from the game's page or process and is read as hostile: a part outside its
 * bounds is left out, never the Report. A bundle always fits the body cap and the contract's reader.
 */
import { createHash, randomUUID } from "node:crypto";
import { HOUR_MS } from "../../shared/duration.ts";
import type { AiCheckRow } from "../../shared/game-ai-check.ts";
import {
  type AiGameKey,
  type AiModelRef,
  AI_SITE_RE,
  isBoundedJson,
  isPlainRecord,
  type JsonBounds,
  readMember,
} from "../../shared/game-ai.ts";
import {
  AI_REPORT_BOUNDS,
  AI_REPORT_CONSOLE_MAX_CHARS,
  AI_REPORT_FRAME_MAX_CHARS,
  AI_REPORT_MAX_BODY_CHARS,
  AI_REPORT_MAX_CALLS,
  AI_REPORT_MAX_CONSOLE,
  AI_REPORT_MAX_DIGESTS,
  AI_REPORT_MAX_INPUTS,
  AI_REPORT_NOTE_MAX_CHARS,
  AI_REPORT_WIRE_VERSION,
  type AiReportBundle,
  type AiReportCall,
  type AiReportDigest,
  AiReportFailure,
  type AiReportFrame,
  AiReportImage,
  AiReportKind,
  type AiReportOutcome,
  AiReportReason,
  type AiReportRequest,
  AiValidation,
  readAiReportBundle,
  redactReportBundle,
  redactReportText,
  withoutPlayerText,
} from "../../shared/game-ai-report.ts";
import { isAnswerJson } from "../../shared/game-ai-schema.ts";
import {
  AI_TAPE_MAX_MODEL_CHARS,
  callKey,
  callKeyInput,
  MAX_REPLAY_LATENCY_FRAMES,
  TAPE_WIRE_VERSION,
  type TapeLine,
} from "../../shared/game-ai-tape.ts";
import { t } from "../../shared/i18n.ts";
import { REDACTED } from "../../shared/redact.ts";
import type { AiCallTrace, GameAiCaller, GameAiClock, GameAiReports, GenexAiPlatform } from "./types.ts";

/** How many games' sessions are kept; the least recently played is let go first. */
export const REPORT_MAX_GAMES = 8;
/**
 * The most text one game's session keeps, in characters (prompts, player fields, replies): the
 * oldest calls go first. With {@link REPORT_MAX_GAMES} it bounds what Reports hold in memory.
 */
export const REPORT_SESSION_MAX_CHARS = 8 * 1024 * 1024;
/** The most automatic bundles one game sends in an hour. */
export const AUTOMATIC_REPORTS_PER_HOUR = 3;
/** The engine a capture that names none ran on: Play and Create Live serve web pages. */
export const REPORT_DEFAULT_ENGINE = "web";
/** What a site or a player field's name reads as when it was shaped like a secret. */
const REDACTED_NAME = "redacted";
/** The longest title, model id, commit, template version and digest a bundle keeps. */
const TITLE_MAX_CHARS = 200;
const SHORT_MAX_CHARS = 150;
/** The frames a replay waits per second of a call's live latency. */
const FRAMES_PER_SECOND = 60;
/** The bounds of the game's `state().ai`, its recorded inputs, and one call's value. */
const AI_STATE_BOUNDS: JsonBounds = { nodes: 20_000, depth: 24, chars: 512 * 1024 };
const INPUTS_BOUNDS: JsonBounds = { nodes: 100_000, depth: 16, chars: 4 * 1024 * 1024 };
const VALUE_BOUNDS: JsonBounds = { nodes: 40_000, depth: 34, chars: 1024 * 1024 };
/** The share of the reader's node bound a bundle may use: the rest is headroom for its frame. */
const NODE_BUDGET = Math.floor(AI_REPORT_BOUNDS.nodes * 0.95);
/** Room kept under the body cap for what a measurement leaves out (separators, a moved prompt). */
const BODY_HEADROOM_CHARS = 64 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA_HEX = "hex";

/** A send that never reached genex.games. */
const OFFLINE: AiReportOutcome = { ok: false, failure: AiReportFailure.Offline };

/** What the game's page or process holds for a Report; every field is read as hostile. */
export interface ReportCapture {
  seed: number | null;
  /** The build commit the game ran. */
  commit: string | null;
  engine: string;
  templateVersion: string | null;
  /** The recorded inputs, oldest first, as the game's input log wrote them. */
  inputs: unknown[];
  digests: AiReportDigest[];
  /** The game's `state().ai`. */
  aiState: unknown;
  consoleErrors: string[];
  /** One frame from Studio's own capture of the game's view. */
  frame: AiReportFrame | null;
}

/** What Reports need. */
export interface GameAiReportsDeps {
  clock: GameAiClock;
  /** The game's capture now, or null when its page or process is gone. */
  capture(game: AiGameKey): Promise<Partial<ReportCapture> | null>;
  /** The model check's row for the model the game used, when it was checked on this Mac. */
  checkRow(game: AiGameKey, model: AiModelRef | null): Promise<AiCheckRow | null>;
  send: GenexAiPlatform["sendReport"];
  /** A fresh bundle id (8 to 100 of `A–Z a–z 0–9 _ -`). */
  newId?(): string;
}

/** Reports, and the trace sink that keeps their sessions. */
export interface GameAiReportService extends GameAiReports {
  /** Keep one settled call in its game's session. */
  observe(caller: GameAiCaller, trace: AiCallTrace): void;
}

/** One game's session. */
interface Session {
  title: string;
  traces: AiCallTrace[];
  /** The text its traces hold, in characters. */
  chars: number;
  /** Tickets an automatic bundle already went for, and when each went. */
  automatic: Map<string, number>;
}

/** What a bundle is built as. */
interface BundleHead {
  kind: AiReportKind;
  reason: AiReportReason | null;
  note: string | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const count = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const countOrNull = (value: unknown): number | null => (isCount(value) ? value : null);
/** Text of at most `max` characters, or null. */
const shortOrNull = (value: unknown, max = SHORT_MAX_CHARS): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const sha256 = (text: string): string => createHash("sha256").update(text).digest(SHA_HEX);

// ── the capture, as hostile input ──────────────────────────────────────────────────────────

/** The newest `max` of a list. */
const newest = <T>(items: readonly T[], max: number): T[] => items.slice(Math.max(0, items.length - max));

function readDigests(raw: unknown): AiReportDigest[] {
  if (!Array.isArray(raw)) return [];
  const digests = raw.flatMap((item) => {
    const row = isPlainRecord(item) ? item : null;
    const digest = shortOrNull(row?.digest);
    return row && isCount(row.frame) && digest ? [{ frame: row.frame, digest }] : [];
  });
  return newest(digests, AI_REPORT_MAX_DIGESTS);
}

function readFrame(raw: unknown): AiReportFrame | null {
  const frame = isPlainRecord(raw) ? raw : null;
  const mime = readMember(AiReportImage, frame?.mime);
  const data = frame?.data;
  if (!mime || typeof data !== "string" || data.length > AI_REPORT_FRAME_MAX_CHARS || !BASE64_RE.test(data))
    return null;
  return { mime, data };
}

function readConsole(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const lines = raw.filter((line): line is string => typeof line === "string");
  return newest(lines, AI_REPORT_MAX_CONSOLE).map((line) => line.slice(0, AI_REPORT_CONSOLE_MAX_CHARS));
}

function readInputs(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const inputs = newest(raw, AI_REPORT_MAX_INPUTS);
  return isBoundedJson(inputs, INPUTS_BOUNDS) ? inputs : [];
}

/** The capture's parts, each in bounds or left out. */
function readCapture(raw: Partial<ReportCapture> | null): ReportCapture {
  const seed = raw?.seed;
  const engine = shortOrNull(raw?.engine) ?? REPORT_DEFAULT_ENGINE;
  return {
    seed: typeof seed === "number" && Number.isSafeInteger(seed) ? seed : null,
    commit: shortOrNull(raw?.commit),
    engine,
    templateVersion: shortOrNull(raw?.templateVersion),
    inputs: readInputs(raw?.inputs),
    digests: readDigests(raw?.digests),
    aiState: isBoundedJson(raw?.aiState ?? null, AI_STATE_BOUNDS) ? (raw?.aiState ?? null) : null,
    consoleErrors: readConsole(raw?.consoleErrors),
    frame: readFrame(raw?.frame),
  };
}

/** The text a trace holds, in characters: what a session counts against its cap. */
function traceChars(trace: AiCallTrace): number {
  const { request } = trace;
  const fields = Object.values(request.untrusted).reduce((sum, value) => sum + value.length, 0);
  const texts = [request.system, request.prompt, request.memory, trace.rawOutput];
  const value = JSON.stringify(trace.value ?? null)?.length ?? 0;
  return texts.reduce((sum: number, text) => sum + (text?.length ?? 0), fields + value);
}

// ── calls and the tape ─────────────────────────────────────────────────────────────────────

/** The model id a call is reported under: the one the provider says ran, else the grant's. */
const modelOf = (trace: AiCallTrace): string | null =>
  shortOrNull(trace.servedModel ?? trace.model?.model ?? null, AI_TAPE_MAX_MODEL_CHARS);

/** One trace as a report call, its system prompt whole (named by hash once the bundle is fitted). */
function callOf(trace: AiCallTrace): AiReportCall {
  const { request } = trace;
  return {
    site: request.site,
    op: request.op,
    system: request.system,
    systemSha256: null,
    prompt: request.prompt,
    untrusted: { ...request.untrusted },
    schema: request.schema,
    rawOutput: trace.rawOutput,
    value: isBoundedJson(trace.value ?? null, VALUE_BOUNDS) ? (trace.value ?? null) : null,
    validation: trace.validation,
    code: trace.code,
    model: modelOf(trace),
    door: trace.door,
    provenance: trace.provenance,
    usage: trace.usage
      ? { inputTokens: count(trace.usage.inputTokens), outputTokens: count(trace.usage.outputTokens) }
      : null,
    costMicros: count(trace.costMicros),
    latencyMs: count(trace.latencyMs),
    frame: countOrNull(trace.frame),
    tick: countOrNull(trace.tick),
  };
}

const fits = (trace: AiCallTrace): boolean =>
  trace.validation === AiValidation.Valid || trace.validation === AiValidation.Repaired;

/** Frames a replay waits for an answer that took `latencyMs` live. */
const latencyFrames = (latencyMs: number): number =>
  Math.min(MAX_REPLAY_LATENCY_FRAMES, Math.max(1, Math.round((count(latencyMs) * FRAMES_PER_SECOND) / 1000)));

/** The session's tape: each fitting answer at its key's occurrence among all the session's calls. */
async function tapeOf(traces: readonly AiCallTrace[]): Promise<TapeLine[]> {
  const seen = new Map<string, number>();
  const lines: TapeLine[] = [];
  for (const trace of traces) {
    const key = await callKey(callKeyInput(trace.request));
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (!fits(trace) || !isAnswerJson(trace.value)) continue;
    lines.push({
      v: TAPE_WIRE_VERSION,
      key,
      n,
      site: trace.request.site,
      op: trace.request.op,
      value: trace.value,
      source: trace.door,
      model: modelOf(trace),
      latencyFrames: latencyFrames(trace.latencyMs),
      usage: trace.usage
        ? { inputTokens: count(trace.usage.inputTokens), outputTokens: count(trace.usage.outputTokens) }
        : null,
    });
  }
  return lines;
}

// ── redaction that keeps the bundle readable ───────────────────────────────────────────────

/** Whether redaction would change a name. */
const redacts = (name: string): boolean => redactReportText(name) !== name;

/** Free JSON with every key a redaction would change renamed `[redacted]` (the first such key kept). */
function redactKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactKeys);
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = redacts(key) ? REDACTED : key;
    if (!Object.hasOwn(out, name)) out[name] = redactKeys(item);
  }
  return out;
}

/** A site, or `redacted` when it was shaped like a secret. */
const siteName = (site: string): string => (redacts(site) ? REDACTED_NAME : site);

/** Player fields with each name shaped like a secret renamed `redacted`, `redacted_2`, … */
function redactFieldNames(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let renamed = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!redacts(key)) {
      out[key] = value;
      continue;
    }
    renamed += 1;
    const name = renamed === 1 ? REDACTED_NAME : `${REDACTED_NAME}_${renamed}`;
    if (AI_SITE_RE.test(name) && !Object.hasOwn(fields, name)) out[name] = value;
  }
  return out;
}

/** The free JSON and the names of a bundle made safe for redaction to keep it readable. */
function prepare(bundle: AiReportBundle): AiReportBundle {
  return {
    ...bundle,
    calls: bundle.calls.map((call) => ({
      ...call,
      site: siteName(call.site),
      untrusted: redactFieldNames(call.untrusted),
      schema: redactKeys(call.schema),
      value: redactKeys(call.value),
    })),
    replay: {
      ...bundle.replay,
      inputs: bundle.replay.inputs.map(redactKeys),
      tape: bundle.replay.tape.map((line) => ({ ...line, site: siteName(line.site), value: redactKeys(line.value) })),
    },
    aiState: redactKeys(bundle.aiState),
  };
}

/** A text cut to its cap after redaction (a redaction can make it longer). */
const capped = (text: string | null, max: number): string | null => (text === null ? null : text.slice(0, max));

/** What redaction can push past a cap, brought back under it. */
function reshape(bundle: AiReportBundle): AiReportBundle {
  return {
    ...bundle,
    game: { ...bundle.game, title: bundle.game.title.slice(0, TITLE_MAX_CHARS) },
    note: capped(bundle.note, AI_REPORT_NOTE_MAX_CHARS),
    calls: bundle.calls.map((call) => ({ ...call, model: shortOrNull(call.model) })),
    replay: {
      ...bundle.replay,
      commit: shortOrNull(bundle.replay.commit),
      templateVersion: shortOrNull(bundle.replay.templateVersion),
      engine: shortOrNull(bundle.replay.engine) ?? REPORT_DEFAULT_ENGINE,
      tape: bundle.replay.tape.map((line) => ({ ...line, model: shortOrNull(line.model, AI_TAPE_MAX_MODEL_CHARS) })),
    },
    digests: bundle.digests.map((row) => ({ ...row, digest: row.digest.slice(0, SHORT_MAX_CHARS) })),
    consoleErrors: bundle.consoleErrors.map((line) => line.slice(0, AI_REPORT_CONSOLE_MAX_CHARS)),
  };
}

// ── fitting the body cap ───────────────────────────────────────────────────────────────────

/** A JSON value's size: its characters as sent and its nodes as the reader counts them. */
interface Size {
  chars: number;
  nodes: number;
}

function nodesOf(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + nodesOf(item), 1);
  if (isPlainRecord(value)) return Object.values(value).reduce((sum: number, item) => sum + nodesOf(item), 1);
  return 1;
}

const sizeOf = (value: unknown): Size => ({ chars: JSON.stringify(value).length + 1, nodes: nodesOf(value) });
const tooBig = (size: Size): boolean =>
  size.chars > AI_REPORT_MAX_BODY_CHARS - BODY_HEADROOM_CHARS || size.nodes > NODE_BUDGET;

/** `size` less what `item` took. */
function without(size: Size, item: unknown): Size {
  const gone = sizeOf(item);
  return { chars: size.chars - gone.chars, nodes: size.nodes - gone.nodes };
}

/**
 * Drop the oldest call. One that carried its system prompt whole hands it to the next call named by
 * the same hash, so every hash still has its text.
 */
function dropFirstCall(calls: AiReportCall[], size: Size): Size {
  const dropped = calls.shift();
  if (!dropped) return size;
  const after = without(size, dropped);
  const heir = dropped.system === null ? -1 : calls.findIndex((call) => call.systemSha256 === dropped.systemSha256);
  const call = calls[heir];
  if (!call || dropped.system === null) return after;
  calls[heir] = { ...call, system: dropped.system };
  return { ...after, chars: after.chars + JSON.stringify(dropped.system).length - JSON.stringify(null).length };
}

/** Drop the oldest tape line. */
function dropFirstLine(tape: TapeLine[], size: Size): Size {
  const dropped = tape.shift();
  return dropped ? without(size, dropped) : size;
}

/**
 * The bundle within the body cap and the reader's node bound: the oldest calls and tape lines go
 * first, together, then the capture's bulk.
 */
function fitBody(bundle: AiReportBundle): AiReportBundle {
  let size = sizeOf(bundle);
  if (!tooBig(size)) return bundle;
  const calls = [...bundle.calls];
  const tape = [...bundle.replay.tape];
  while (tooBig(size) && (calls.length || tape.length)) size = dropFirstLine(tape, dropFirstCall(calls, size));
  const fitted = { ...bundle, calls, replay: { ...bundle.replay, tape } };
  if (!tooBig(size)) return fitted;
  return {
    ...fitted,
    aiState: null,
    frame: null,
    digests: [],
    consoleErrors: [],
    replay: { ...fitted.replay, inputs: [] },
  };
}

/** Each system prompt whole on its first call, then named by its hash alone. */
function nameSystems(calls: readonly AiReportCall[]): AiReportCall[] {
  const seen = new Set<string>();
  return calls.map((call) => {
    if (call.system === null) return { ...call, systemSha256: null };
    const hash = sha256(call.system);
    const first = !seen.has(hash);
    seen.add(hash);
    return { ...call, system: first ? call.system : null, systemSha256: hash };
  });
}

/** The bundle as the contract's reader takes it; the model check's row is let go if it is the part it refuses. */
function readable(bundle: AiReportBundle): AiReportBundle {
  if (readAiReportBundle(JSON.parse(JSON.stringify(bundle)))) return bundle;
  const withoutCheck = { ...bundle, modelCheck: null };
  if (readAiReportBundle(JSON.parse(JSON.stringify(withoutCheck)))) return withoutCheck;
  throw new Error(t("The Report's bundle does not fit its own contract"));
}

// ── the service ────────────────────────────────────────────────────────────────────────────

/** Reports over `deps`. */
export function createGameAiReports(deps: GameAiReportsDeps): GameAiReportService {
  const sessions = new Map<AiGameKey, Session>();
  const newId = deps.newId ?? (() => `rep_${randomUUID().replaceAll("-", "")}`);

  const observe = (caller: GameAiCaller, trace: AiCallTrace): void => {
    const session: Session = sessions.get(caller.game) ?? {
      title: caller.title,
      traces: [],
      chars: 0,
      automatic: new Map(),
    };
    session.title = caller.title;
    session.traces.push(trace);
    session.chars += traceChars(trace);
    while (session.traces.length > AI_REPORT_MAX_CALLS || session.chars > REPORT_SESSION_MAX_CHARS) {
      const dropped = session.traces.shift();
      if (!dropped) break;
      session.chars -= traceChars(dropped);
    }
    // The most recently played game goes last; the least recent is let go first.
    sessions.delete(caller.game);
    sessions.set(caller.game, session);
    if (sessions.size > REPORT_MAX_GAMES) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
  };

  const capture = (game: AiGameKey) => deps.capture(game).catch(() => null);
  const checkRow = (game: AiGameKey, model: AiModelRef | null) => deps.checkRow(game, model).catch(() => null);

  const build = async (game: AiGameKey, head: BundleHead, playerText: boolean): Promise<AiReportBundle> => {
    const session = sessions.get(game);
    const traces = session?.traces ?? [];
    const last = traces.at(-1);
    const [raw, tape, modelCheck] = await Promise.all([
      capture(game),
      tapeOf(traces),
      checkRow(game, last?.model ?? null),
    ]);
    const parts = readCapture(raw);
    const bundle: AiReportBundle = {
      v: AI_REPORT_WIRE_VERSION,
      id: newId(),
      ...head,
      createdAt: new Date(deps.clock.now()).toISOString(),
      game: { key: game, title: session?.title ?? "" },
      calls: traces.map(callOf),
      replay: {
        seed: parts.seed,
        commit: parts.commit,
        engine: parts.engine,
        templateVersion: parts.templateVersion,
        inputs: parts.inputs,
        tape,
      },
      digests: parts.digests,
      aiState: parts.aiState,
      consoleErrors: parts.consoleErrors,
      frame: parts.frame,
      modelCheck,
      playerText: true,
    };
    const scoped = playerText ? bundle : withoutPlayerText(bundle);
    const redacted = reshape(redactReportBundle(prepare(scoped)));
    return readable(fitBody({ ...redacted, calls: nameSystems(redacted.calls) }));
  };

  const preview = (game: AiGameKey): Promise<AiReportBundle> =>
    build(game, { kind: AiReportKind.Player, reason: AiReportReason.Other, note: null }, true);

  const send = async (request: AiReportRequest): Promise<AiReportOutcome> => {
    const head = { kind: AiReportKind.Player, reason: request.reason, note: request.note };
    const bundle = await build(request.game, head, true).catch(() => null);
    if (!bundle) return { ok: false, failure: AiReportFailure.Refused };
    return deps.send(bundle).catch(() => OFFLINE);
  };

  /** Whether an automatic bundle may go for this ticket now: an invalid reply, once, a few an hour. */
  const automaticAllowed = (session: Session, ticket: string): boolean => {
    const trace = session.traces.find((one) => one.request.ticket === ticket);
    if (trace?.validation !== AiValidation.Invalid || session.automatic.has(ticket)) return false;
    const since = deps.clock.now() - HOUR_MS;
    const recent = [...session.automatic.values()].filter((at) => at > since).length;
    return recent < AUTOMATIC_REPORTS_PER_HOUR;
  };

  const automatic = async (caller: GameAiCaller, ticket: string): Promise<void> => {
    const session = sessions.get(caller.game);
    if (!session || !automaticAllowed(session, ticket)) return;
    session.automatic.set(ticket, deps.clock.now());
    const head = { kind: AiReportKind.Automatic, reason: null, note: null };
    const bundle = await build(caller.game, head, false).catch(() => null);
    if (bundle) await deps.send(bundle).catch(() => null);
  };

  return { observe, preview, send, automatic };
}
