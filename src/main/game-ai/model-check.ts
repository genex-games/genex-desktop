/**
 * The model check (owner decisions D10 and D12): optional, the creator's own, and free to Genex.
 * After a playtest with AI, it replays the saved moments of the creator's playtests
 * (`moments.ts`) on the models they can run themselves — this Mac's models, their own key, their
 * OpenCode account and, when they allowed it (D2), their plan — and never on Genex credits.
 *
 * The set is dynamic (D12): the standard panel's picks the creator can run (two cheap cloud
 * models, one strong one, a small and a large model on this Mac), then every other model they have
 * connected, each once, at most `AI_CHECK_MAX_MODELS`. Each moment runs as the game's own call,
 * with the game's one repair; a judge on the creator's own model (the playtest's, else the panel's
 * strong or large pick) then compares the answers that fit the game's shape with the playtest's.
 * A row says how the model fits, what it costs here, and its median reply time.
 *
 * Publish never waits for it. The result, the creator's recommended model and what a model costs
 * players on credits live in `userData/game-ai/checks/<sha-256 of the game's name>.json`; a stop
 * aborts the call in flight and leaves the last result as it was. The harness runs it on this
 * Mac's models only (`localOnly`), under its own run budget.
 */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  AI_CHECK_PANEL,
  type AiCheckResult,
  type AiCheckRow,
  AiCheckFit,
  AiCheckState,
  AiCostLevel,
  AiPanelSlot,
  type AiAudienceView,
  type AiPublishFacts,
  bestFits,
  checkSet,
  costLevelOf,
  fitOf,
  sameModel,
} from "../../shared/game-ai-check.ts";
import {
  AiAuthority,
  type AiCallRequest,
  AiDoor,
  AiFunding,
  AiGameKind,
  type AiGameKey,
  type AiModelRef,
  AiOp,
  AiTier,
  type AiUsage,
  fundingOf,
  GAME_AI_WIRE_VERSION,
  isPlainRecord,
  readMember,
} from "../../shared/game-ai.ts";
import { parseOutput } from "../../shared/game-ai-schema.ts";
import { readAiModelRef } from "../../shared/game-ai-views.ts";
import { AsyncLock, atomicWriteJson, ensureDir, readRegularFile } from "../../substrate/fsx.ts";
import { CompletePurpose } from "../../substrate/engines/types.ts";
import { JUDGE_NOTE_MAX_CHARS, JUDGE_SYSTEM, type JudgeItem, judgePrompt, judgeSchema } from "./model-check-prompts.ts";
import type { AiMoment, GameAiMoments } from "./moments.ts";
import type { GameAiClock, GameAiDoorImpl, GameAiModelCheck, GameAiQueue } from "./types.ts";

/** The most saved moments one check replays: the newest. */
export const CHECK_MAX_MOMENTS = 24;
/** The site the judge's call names, apart from every game's. */
export const CHECK_SITE = "model-check.judge";
/** How long a moment waits for a slot (a build holds this Mac's models first) before it is skipped. */
export const CHECK_QUEUE_MAX_WAIT_MS = 10 * MINUTE_MS;
/** How long to wait for a slot when the queue names no time. */
const QUEUE_RETRY_MS = 2 * SECOND_MS;
/** The judge's output budget: a verdict per moment and a short note. */
const JUDGE_OUTPUT_TOKENS = 1_024;
/** The folder results live in, inside play-time AI's own folder. */
const CHECKS_DIR = "checks";
const CHECKS_MAX_FILE_BYTES = 1024 * 1024;
const FILE_VERSION = 1;
/** The longest note and label a saved row keeps. */
const NOTE_MAX_CHARS = JUDGE_NOTE_MAX_CHARS;
const LABEL_MAX_CHARS = 200;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The doors a check may run, in the order it lists them: the creator's own; never a platform's. */
const CHECK_DOORS: readonly AiDoor[] = [AiDoor.Local, AiDoor.OpenCode, AiDoor.Byok, AiDoor.Plan];
/** Doors that bill per call: a model that billed nothing there is a free one. */
const BILLED_DOORS: readonly AiDoor[] = [AiDoor.OpenCode, AiDoor.Byok];

/**
 * The standard panel's cloud picks, by model id, most wanted first (D12): the cheap slot takes two
 * of its row, the strong slot one. A pick is made only from what the creator can run.
 */
const CLOUD_PICKS = {
  [AiPanelSlot.CheapCloud]: [/claude[-.]?haiku/i, /gpt-[\w.]*mini/i, /gemini-[\w.-]*flash/i],
  [AiPanelSlot.StrongCloud]: [/claude[-.]?sonnet/i, /gpt-5(?![\w.]*-(?:mini|nano))/i, /gemini-[\w.-]*pro/i],
} as const;
/** A local model's size in billions of parameters, from its id (`qwen3:8b`, `llama3.2:3b`). */
const LOCAL_SIZE_RE = /(\d+(?:\.\d+)?)\s*b(?![a-z])/i;

const MESSAGE = {
  NotChecked: "not a model the check ran",
  NoAnswer: (missing: number, of: number) => `No usable answer in ${missing} of ${of} moments.`,
  OffShape: (off: number, of: number) => `Answered outside the game's shape in ${off} of ${of} moments.`,
  Judged: (fitted: number, of: number) => `Played as well as your playtest in ${fitted} of ${of} moments.`,
} as const;

/** What the check needs. */
export interface ModelCheckDeps {
  clock: GameAiClock;
  /** Play-time AI's own folder (`userData/game-ai`). */
  dir: string;
  doors: ReadonlyMap<AiDoor, GameAiDoorImpl>;
  moments: Pick<GameAiMoments, "list">;
  queue: GameAiQueue;
  /** D2: the creator allowed their plan to answer their own playtests. */
  allowPlan(): Promise<boolean>;
  /** A model's name as the person's model menu shows it. */
  label(model: AiModelRef): string;
  /** What `usage` on `model` costs a player on Genex credits, in USD micros; null when unknown. */
  playerCostMicros(model: AiModelRef, usage: AiUsage): number | null;
  /** The creator's share of credits players spend on AI in the game, in basis points; null until set (D4). */
  creatorShareBps(project: string): Promise<number | null>;
  /** Who the creator declared sees the game's AI text on genex.games; null when unpublished or unread. */
  audience(project: string): Promise<AiAudienceView | null>;
  /** Wait `ms` (a slot the queue holds); rejects when `signal` aborts. */
  wait?(ms: number, signal: AbortSignal): Promise<void>;
}

/** The check, plus what the harness and Reports read of it. */
export interface ModelCheckService extends GameAiModelCheck {
  /** The running check's result once it ends, or the current state. */
  settled(project: string): Promise<AiCheckResult>;
  /** A Report's row: the check's row for `model` in a game of the creator's library. */
  rowFor(game: AiGameKey, model: AiModelRef | null): Promise<AiCheckRow | null>;
}

/** What one moment came to on one model. */
interface MomentResult {
  answered: boolean;
  /** It fit the game's shape, after the one repair if it needed it. */
  shaped: boolean;
  value: unknown;
  costMicros: number;
  latencyMs: number;
  usage: AiUsage | null;
}

/** A saved check. */
interface Saved {
  rows: AiCheckRow[];
  recommended: AiModelRef | null;
  checkedAt: string | null;
  failed: boolean;
  /** Per checked model: a moment's median cost for players on credits, in USD micros. */
  players: Array<{ model: AiModelRef; micros: number | null }>;
}

const EMPTY: Saved = { rows: [], recommended: null, checkedAt: null, failed: false, players: [] };

/** A game's results file, by a hash of its name: a name never becomes a path. */
export const checksFile = (dir: string, project: string): string =>
  path.join(dir, CHECKS_DIR, `${createHash("sha256").update(project).digest("hex")}.json`);

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 ? upper : Math.round(((sorted[middle - 1] ?? upper) + upper) / 2);
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const addUsage = (a: AiUsage | null, b: AiUsage | null): AiUsage | null => {
  if (!a || !b) return a ?? b;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
};

// ── the saved result, as hostile input ─────────────────────────────────────────────────────

const ROW_KEYS = ["model", "label", "funding", "moments", "fitted", "fit", "cost", "medianLatencyMs", "note"] as const;

function readRow(raw: unknown): AiCheckRow | null {
  if (!isPlainRecord(raw) || !ROW_KEYS.every((key) => Object.hasOwn(raw, key))) return null;
  const model = readAiModelRef(raw.model);
  const funding = readMember(AiFunding, raw.funding);
  const fit = readMember(AiCheckFit, raw.fit);
  const cost = readMember(AiCostLevel, raw.cost);
  const { label, moments, fitted, medianLatencyMs, note } = raw;
  if (!model || !funding || !fit || !cost || typeof label !== "string" || label.length > LABEL_MAX_CHARS) return null;
  if (!isCount(moments) || !isCount(fitted) || fitted > moments) return null;
  if (medianLatencyMs !== null && !isCount(medianLatencyMs)) return null;
  if (note !== null && (typeof note !== "string" || note.length > NOTE_MAX_CHARS)) return null;
  return { model, label, funding, moments, fitted, fit, cost, medianLatencyMs, note };
}

function readPlayers(raw: unknown): Saved["players"] | null {
  if (!Array.isArray(raw)) return null;
  const players = raw.map((item) => {
    const model = isPlainRecord(item) ? readAiModelRef(item.model) : null;
    const micros = isPlainRecord(item) ? item.micros : undefined;
    return model && (micros === null || isCount(micros)) ? { model, micros } : null;
  });
  return players.every((player) => player !== null) ? players.filter((player) => player !== null) : null;
}

/** A saved check, or nothing when any part of it is not one. */
function readSaved(raw: unknown): Saved {
  if (!isPlainRecord(raw) || raw.v !== FILE_VERSION || !Array.isArray(raw.rows)) return EMPTY;
  const rows = raw.rows.map(readRow);
  const recommended = raw.recommended === null ? null : readAiModelRef(raw.recommended);
  const { checkedAt, failed } = raw;
  const players = readPlayers(raw.players);
  if (rows.some((row) => row === null) || (raw.recommended !== null && !recommended) || !players) return EMPTY;
  if (checkedAt !== null && (typeof checkedAt !== "string" || !ISO_RE.test(checkedAt))) return EMPTY;
  if (typeof failed !== "boolean") return EMPTY;
  return { rows: rows.filter((row) => row !== null), recommended, checkedAt, failed, players };
}

// ── the set ────────────────────────────────────────────────────────────────────────────────

/** A local model's size in billions, or null when its id names none. */
function localSize(model: AiModelRef): number | null {
  const size = LOCAL_SIZE_RE.exec(model.model)?.[1];
  return size === undefined ? null : Number(size);
}

/** The cloud slot's next pick from `models`, not already taken. */
function cloudPick(slot: keyof typeof CLOUD_PICKS, models: readonly AiModelRef[], taken: readonly AiModelRef[]) {
  for (const pattern of CLOUD_PICKS[slot]) {
    const pick = models.find(
      (model) => model.door !== AiDoor.Local && pattern.test(model.model) && !taken.some((t) => sameModel(t, model)),
    );
    if (pick) return pick;
  }
  return null;
}

/** The panel's picks from what the creator can run, slot by slot, with the slot each filled. */
function panelPicks(models: readonly AiModelRef[]): Array<{ slot: AiPanelSlot; model: AiModelRef }> {
  const local = models
    .filter((model) => model.door === AiDoor.Local && localSize(model) !== null)
    .sort((a, b) => (localSize(a) ?? 0) - (localSize(b) ?? 0));
  const picks: Array<{ slot: AiPanelSlot; model: AiModelRef }> = [];
  for (const slot of AI_CHECK_PANEL) {
    const taken = picks.map((pick) => pick.model);
    let model: AiModelRef | null | undefined = null;
    if (slot === AiPanelSlot.CheapCloud || slot === AiPanelSlot.StrongCloud) model = cloudPick(slot, models, taken);
    if (slot === AiPanelSlot.LocalSmall) model = local[0];
    if (slot === AiPanelSlot.LocalLarge && local.length > 1) model = local.at(-1);
    if (model && !taken.some((known) => sameModel(known, model))) picks.push({ slot, model });
  }
  return picks;
}

/** The models of the doors the check may use now. */
async function runnable(deps: ModelCheckDeps, localOnly: boolean): Promise<AiModelRef[]> {
  const allowPlan = await deps.allowPlan().catch(() => false);
  const doors = CHECK_DOORS.filter((door) => (localOnly ? door === AiDoor.Local : door !== AiDoor.Plan || allowPlan));
  const models: AiModelRef[] = [];
  for (const door of doors) {
    const impl = deps.doors.get(door);
    const ready = impl ? await impl.readiness().catch(() => null) : null;
    if (!impl || !ready?.ready) continue;
    const offered = await impl.models().catch(() => []);
    models.push(...offered.filter((model) => model.door === door));
  }
  return models;
}

/** The model a game's playtest ran on most (the latest of a tie). */
function playtestModel(moments: readonly AiMoment[]): AiModelRef | null {
  const counts: Array<{ model: AiModelRef; n: number }> = [];
  for (const moment of moments) {
    const model = moment.model;
    if (!model) continue;
    const known = counts.find((row) => sameModel(row.model, model));
    if (known) known.n += 1;
    else counts.push({ model, n: 1 });
  }
  const latest = [...moments].reverse().find((moment) => moment.model)?.model ?? null;
  const top = Math.max(0, ...counts.map((row) => row.n));
  const tied = counts.filter((row) => row.n === top).map((row) => row.model);
  if (latest && tied.some((model) => sameModel(model, latest))) return latest;
  return tied[0] ?? null;
}

// ── one model's row ────────────────────────────────────────────────────────────────────────

/** What the judge said of a model's answers that fit the game's shape. */
interface Verdict {
  fitting: boolean[];
  note: string;
}

/** A row's note for a struggling model: what went wrong most, in the creator's words. */
function noteOf(results: readonly MomentResult[], fitted: number, verdict: Verdict | null): string {
  const missing = results.filter((result) => !result.answered).length;
  const off = results.filter((result) => result.answered && !result.shaped).length;
  if (missing > 0 && missing >= off) return MESSAGE.NoAnswer(missing, results.length);
  if (off > 0) return MESSAGE.OffShape(off, results.length);
  const said = verdict?.note.trim() ?? "";
  return (said || MESSAGE.Judged(fitted, results.length)).slice(0, NOTE_MAX_CHARS);
}

/** How many moments fit: the shaped ones, less those the judge said play worse. */
function fittedOf(results: readonly MomentResult[], verdict: Verdict | null): number {
  const shaped = results.filter((result) => result.shaped);
  if (!verdict) return shaped.length;
  return verdict.fitting.filter(Boolean).length;
}

/** One model's row and what it costs players, from its moments and the judge's verdict. */
function rowOf(
  deps: ModelCheckDeps,
  model: AiModelRef,
  results: readonly MomentResult[],
  verdict: Verdict | null,
): { row: AiCheckRow; micros: number | null } {
  const answered = results.filter((result) => result.answered);
  const costs = answered.map((result) => result.costMicros);
  const billedNothing = answered.length > 0 && costs.every((cost) => cost === 0);
  const free = model.door === AiDoor.Local || (BILLED_DOORS.includes(model.door) && billedNothing);
  const funding = fundingOf(model.door, free);
  const fitted = fittedOf(results, verdict);
  const fit = fitOf(fitted, results.length);
  const players = answered.flatMap((result) =>
    result.usage ? [deps.playerCostMicros(model, result.usage)].filter((micros) => micros !== null) : [],
  );
  const row: AiCheckRow = {
    model,
    label: deps.label(model).slice(0, LABEL_MAX_CHARS),
    funding,
    moments: results.length,
    fitted,
    fit,
    cost: costLevelOf(funding, median(costs) ?? 0),
    medianLatencyMs: median(answered.map((result) => result.latencyMs)),
    note: fit === AiCheckFit.Struggles ? noteOf(results, fitted, verdict) : null,
  };
  return { row, micros: median(players) };
}

// ── running ────────────────────────────────────────────────────────────────────────────────

/** What one check runs: the newest moments, the dynamic set and the judge's model. */
interface CheckPlan {
  moments: AiMoment[];
  set: AiModelRef[];
  judge: AiModelRef | null;
}

/** A running check. */
interface Running {
  controller: AbortController;
  progress: { done: number; total: number };
  done: Promise<void>;
}

/** The judge's call over a model's shaped answers. */
function judgeRequest(items: readonly JudgeItem[]): AiCallRequest {
  return {
    v: GAME_AI_WIRE_VERSION,
    op: AiOp.Judge,
    site: CHECK_SITE,
    ticket: `check-${randomUUID()}`,
    grantId: `check-${randomUUID()}`,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(items),
    untrusted: {},
    memory: null,
    schema: judgeSchema(items.length),
    tier: AiTier.Smart,
    authority: AiAuthority.Local,
    maxOutputTokens: JUDGE_OUTPUT_TOKENS,
    stream: false,
  };
}

/** An answer as the judge quotes it. */
const quoted = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** What the judge reads of a model's moments: each one whose answer fit the game's shape. */
function judgeItems(moments: readonly AiMoment[], results: readonly MomentResult[]): JudgeItem[] {
  return results.flatMap((result, index) => {
    const moment = moments[index];
    if (!result.shaped || !moment) return [];
    return [{ prompt: moment.request.prompt, playtest: quoted(moment.value), candidate: quoted(result.value) }];
  });
}

/** The judge's answer as a verdict, or null when it is not one. */
function readVerdict(schema: unknown, text: string): Verdict | null {
  const parsed = parseOutput(schema, text);
  if (!parsed.ok || !isPlainRecord(parsed.value)) return null;
  const { verdicts, note } = parsed.value;
  if (!Array.isArray(verdicts) || typeof note !== "string") return null;
  return { fitting: verdicts.map((verdict) => verdict === true), note };
}

/** A result for a moment the model gave nothing usable for. */
const NO_ANSWER: MomentResult = {
  answered: false,
  shaped: false,
  value: null,
  costMicros: 0,
  latencyMs: 0,
  usage: null,
};

/** One door call of the check: a slot, the call, the slot given back; a stop throws out of it. */
type SlotRun = <T>(
  model: AiModelRef,
  game: AiGameKey,
  signal: AbortSignal,
  body: () => Promise<T>,
) => Promise<T | null>;

/** The check's door calls: moments with the game's one repair, and the judge. */
function doorCalls(deps: ModelCheckDeps) {
  const wait = deps.wait ?? ((ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }));

  /** A slot on the model's door, waiting while a build holds it; null when it waited too long. */
  const acquire = async (model: AiModelRef, game: AiGameKey, signal: AbortSignal): Promise<(() => void) | null> => {
    for (let waited = 0; ; ) {
      const slot = await deps.queue.acquire(model.door, game, signal);
      if (slot.ok) return slot.release;
      const ms = Math.max(1, slot.retryAfterMs ?? QUEUE_RETRY_MS);
      if (signal.aborted || waited + ms > CHECK_QUEUE_MAX_WAIT_MS) return null;
      await wait(ms, signal);
      waited += ms;
    }
  };

  const inSlot: SlotRun = async (model, game, signal, body) => {
    const release = await acquire(model, game, signal);
    signal.throwIfAborted();
    if (!release) return null;
    try {
      return await body();
    } finally {
      release();
    }
  };

  /** One moment on one model, with the game's one repair. */
  const answer = async (
    impl: GameAiDoorImpl,
    model: AiModelRef,
    moment: AiMoment,
    game: AiGameKey,
    signal: AbortSignal,
  ) => {
    const started = deps.clock.now();
    const call = { game, request: moment.request, model, purpose: CompletePurpose.Game, repair: null };
    const first = await impl.run(call, signal);
    let parsed = parseOutput(moment.request.schema, first.text);
    let costMicros = first.costMicros;
    let usage = first.usage;
    if (!parsed.ok) {
      const second = await impl.run({ ...call, repair: { previous: first.text, problem: parsed.problem } }, signal);
      parsed = parseOutput(moment.request.schema, second.text);
      costMicros += second.costMicros;
      usage = addUsage(usage, second.usage);
    }
    const latencyMs = Math.max(0, deps.clock.now() - started);
    const value = parsed.ok ? parsed.value : null;
    return { answered: true, shaped: parsed.ok, value, costMicros: Math.max(0, costMicros), latencyMs, usage };
  };

  /** One moment on one model; null when it never got a slot. A failed call is a moment with no answer. */
  const runMoment = (impl: GameAiDoorImpl, model: AiModelRef, moment: AiMoment, game: AiGameKey, signal: AbortSignal) =>
    inSlot(model, game, signal, () =>
      answer(impl, model, moment, game, signal).catch((): MomentResult => {
        signal.throwIfAborted();
        return NO_ANSWER;
      }),
    );

  /** The judge's verdict on a model's shaped answers; null with no judge, nothing to judge, or no verdict. */
  const judgeModel = async (
    judge: AiModelRef | null,
    items: readonly JudgeItem[],
    game: AiGameKey,
    signal: AbortSignal,
  ): Promise<Verdict | null> => {
    const impl = judge ? deps.doors.get(judge.door) : undefined;
    if (!judge || !impl || !items.length) return null;
    const request = judgeRequest(items);
    const call = { game, request, model: judge, purpose: CompletePurpose.Game, repair: null };
    return inSlot(judge, game, signal, () =>
      impl.run(call, signal).then(
        (reply) => readVerdict(request.schema, reply.text),
        () => {
          signal.throwIfAborted();
          return null;
        },
      ),
    );
  };

  return { runMoment, judgeModel };
}

/** The check's saved results, one file per game, written under one lock. */
function checkStore(dir: string) {
  const lock = new AsyncLock();
  const load = async (project: string): Promise<Saved> => {
    const file = checksFile(dir, project);
    if (!(await stat(file).catch(() => null))) return EMPTY;
    try {
      return readSaved(JSON.parse((await readRegularFile(file, CHECKS_MAX_FILE_BYTES)).toString("utf8")));
    } catch {
      return EMPTY;
    }
  };
  const read = (project: string) => lock.run(() => load(project));
  const update = (project: string, change: (saved: Saved) => Saved) =>
    lock.run(async () => {
      const next = change(await load(project));
      await ensureDir(path.join(dir, CHECKS_DIR));
      await atomicWriteJson(checksFile(dir, project), { v: FILE_VERSION, ...next });
      return next;
    });
  return { read, update };
}
type CheckStore = ReturnType<typeof checkStore>;

/** The newest moments a check replays. */
const newestMoments = async (deps: ModelCheckDeps, project: string): Promise<AiMoment[]> =>
  (await deps.moments.list(project)).slice(-CHECK_MAX_MOMENTS);

/** What a check runs: the moments, the set and the judge, read from the doors now. */
async function checkPlan(deps: ModelCheckDeps, project: string, localOnly: boolean): Promise<CheckPlan> {
  const moments = await newestMoments(deps, project);
  const models = await runnable(deps, localOnly);
  const picks = panelPicks(models);
  const set = checkSet(
    picks.map((pick) => pick.model),
    models,
  );
  const strong = picks.find((pick) => pick.slot === AiPanelSlot.StrongCloud)?.model ?? null;
  const large = picks.find((pick) => pick.slot === AiPanelSlot.LocalLarge)?.model ?? null;
  const inSet = (model: AiModelRef | null) => model !== null && set.some((known) => sameModel(known, model));
  const judge = [playtestModel(moments), strong, large].find(inSet) ?? null;
  return { moments, set, judge };
}

/** Run a whole check and save it; a stop throws out of it and saves nothing. */
async function runCheck(
  deps: ModelCheckDeps,
  store: CheckStore,
  project: string,
  plan: CheckPlan,
  live: Running,
): Promise<void> {
  const { signal } = live.controller;
  const game: AiGameKey = `${AiGameKind.Create}:${project}`;
  const calls = doorCalls(deps);
  if (!plan.set.length) {
    await store.update(project, (saved) => ({ ...saved, failed: true }));
    return;
  }
  const rows: AiCheckRow[] = [];
  const players: Saved["players"] = [];
  for (const model of plan.set) {
    const impl = deps.doors.get(model.door);
    const ran: Array<{ moment: AiMoment; result: MomentResult }> = [];
    for (const moment of plan.moments) {
      const result = impl ? await calls.runMoment(impl, model, moment, game, signal) : null;
      if (result) ran.push({ moment, result });
    }
    const results = ran.map((one) => one.result);
    const items = judgeItems(
      ran.map((one) => one.moment),
      results,
    );
    const verdict = await calls.judgeModel(plan.judge, items, game, signal);
    const { row, micros } = rowOf(deps, model, results, verdict);
    rows.push(row);
    players.push({ model, micros });
    live.progress.done += 1;
  }
  signal.throwIfAborted();
  const checkedAt = new Date(deps.clock.now()).toISOString();
  await store.update(project, (saved) => ({ ...saved, rows, players, checkedAt, failed: false }));
}

/** Where a check stands, from what is saved, how many moments there are and whether one runs. */
function resultOf(project: string, saved: Saved, moments: number, live: Running | undefined): AiCheckResult {
  const base = { project, moments, rows: saved.rows, recommended: saved.recommended, checkedAt: saved.checkedAt };
  if (live) return { ...base, state: AiCheckState.Checking, progress: { ...live.progress } };
  let current: AiCheckState = AiCheckState.Ready;
  if (saved.failed) current = AiCheckState.Failed;
  else if (saved.checkedAt) current = AiCheckState.Done;
  else if (moments === 0) current = AiCheckState.Empty;
  return { ...base, state: current, progress: null };
}

/** What players on credits pay for AI on `model`, as Publish shows it; null when it is not known. */
function playersCost(saved: Saved, model: AiModelRef | null): AiCostLevel | null {
  const row = model ? saved.rows.find((one) => sameModel(one.model, model)) : undefined;
  if (!row || !model) return null;
  if (row.funding === AiFunding.Free) return AiCostLevel.Free;
  const micros = saved.players.find((player) => sameModel(player.model, model))?.micros ?? null;
  return micros === null ? null : costLevelOf(AiFunding.Credits, micros);
}

/** What Publish shows of a game's AI, from its moments, its check and the creator's share. */
function publishFactsOf(
  project: string,
  moments: readonly AiMoment[],
  check: AiCheckResult,
  saved: Saved,
  genex: { creatorShareBps: number | null; audience: AiAudienceView | null },
): AiPublishFacts {
  const playtest = playtestModel(moments);
  const checked = saved.checkedAt !== null && saved.rows.length > 0;
  const bestWith = saved.recommended ?? bestFits(saved.rows)[0]?.model ?? playtest;
  const fitted = saved.rows.filter((row) => row.fit === AiCheckFit.Fits).length;
  return {
    project,
    playtested: moments.length > 0,
    playtestModel: playtest,
    check,
    bestWith,
    fits: checked ? { fitted, of: saved.rows.length } : null,
    cost: checked ? playersCost(saved, bestWith) : null,
    creatorShareBps: genex.creatorShareBps,
    audience: genex.audience,
  };
}

/** The model check over `deps`. */
export function createModelCheck(deps: ModelCheckDeps): ModelCheckService {
  const store = checkStore(deps.dir);
  const running = new Map<string, Running>();

  const state = async (project: string): Promise<AiCheckResult> => {
    const saved = await store.read(project);
    const moments = (await newestMoments(deps, project)).length;
    return resultOf(project, saved, moments, running.get(project));
  };

  const start = async (project: string, options: { localOnly: boolean }): Promise<AiCheckResult> => {
    if (running.has(project)) return state(project);
    const plan = await checkPlan(deps, project, options.localOnly);
    if (running.has(project) || plan.moments.length === 0) return state(project);
    const live: Running = {
      controller: new AbortController(),
      progress: { done: 0, total: plan.set.length },
      done: Promise.resolve(),
    };
    running.set(project, live);
    // The state the creator sees first is read before the run moves it on.
    const first = await state(project);
    live.done = runCheck(deps, store, project, plan, live)
      .catch(async () => {
        if (!live.controller.signal.aborted) await store.update(project, (saved) => ({ ...saved, failed: true }));
      })
      .finally(() => running.delete(project));
    return first;
  };

  const settled = async (project: string): Promise<AiCheckResult> => {
    await running.get(project)?.done;
    return state(project);
  };

  const stop = async (project: string): Promise<AiCheckResult> => {
    const live = running.get(project);
    live?.controller.abort();
    await live?.done;
    return state(project);
  };

  const recommend = async (project: string, model: AiModelRef | null): Promise<AiCheckResult> => {
    const saved = await store.read(project);
    if (model && !saved.rows.some((row) => sameModel(row.model, model))) throw new Error(MESSAGE.NotChecked);
    await store.update(project, (current) => ({ ...current, recommended: model }));
    return state(project);
  };

  const publishFacts = async (project: string): Promise<AiPublishFacts> => {
    const [moments, check, saved, creatorShareBps, audience] = await Promise.all([
      deps.moments.list(project),
      state(project),
      store.read(project),
      deps.creatorShareBps(project).catch(() => null),
      deps.audience(project).catch(() => null),
    ]);
    return publishFactsOf(project, moments, check, saved, { creatorShareBps, audience });
  };

  const rowFor = async (game: AiGameKey, model: AiModelRef | null): Promise<AiCheckRow | null> => {
    const prefix = `${AiGameKind.Create}:`;
    if (!model || !game.startsWith(prefix)) return null;
    const saved = await store.read(game.slice(prefix.length));
    return saved.rows.find((row) => sameModel(row.model, model)) ?? null;
  };

  return { start, state, stop, recommend, publishFacts, settled, rowFor };
}
