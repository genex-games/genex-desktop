/**
 * Play-time AI for the builder agent (`GameAiHarnessHost`, behind `harness-rpc/ai.ts`): a build's
 * saved playtests; a replay of a demo under seeds on its tape, with AI off, or with the worst
 * answers its shapes allow; a recording made on this Mac's models; a bench of one call site; and
 * the model check on local models only.
 *
 * Nothing here reaches the network or the person's plan, key or credits. A model call is taken from
 * the run budget the host made for the one harness call (`budgetedDoor`): this Mac's door only, one
 * call at a time, nothing past the cap; a reply's one repair is a call of its own, and the queue
 * still puts a running build first.
 *
 * A recording plays the demo on its tape lane: the first call the tape has no answer for is
 * answered on this Mac's model, added to the tape, and the demo is played again from the top, until
 * it misses nothing or the budget is spent. Each answer so lands where the same seed and steps
 * replay it, whatever the game's own step does between frames. What the page reports (its digests,
 * its AI status, the calls it missed) is hostile input: counts are read as counts, and a missed
 * call's key is computed again here from its request.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import {
  AiDoor,
  AiErrorCode,
  type AiCallRequest,
  type AiGameKey,
  type AiModelRef,
  type AiUsage,
  createGameKey,
  isAiErrorCode,
  isPlainRecord,
  readAiCallRequest,
} from "../../shared/game-ai.ts";
import type { AiBenchResult, AiCheckResult } from "../../shared/game-ai-check.ts";
import { AiCheckState } from "../../shared/game-ai-check.ts";
import { AiLane, type AiLaneHint } from "../../shared/game-ai-lane.ts";
import { checkSchema, parseOutput } from "../../shared/game-ai-schema.ts";
import {
  AiReplayAnswers,
  type AiRecordResult,
  type AiReplayResult,
  AI_TAPE_MAX_LINES,
  callKey,
  callKeyInput,
  isTapeName,
  TAPE_WIRE_VERSION,
  tapeFile,
  type TapeLine,
  tapeSlot,
} from "../../shared/game-ai-tape.ts";
import type { AiTapeSummary } from "../../shared/game-ai-views.ts";
import { CompletePurpose } from "../../substrate/engines/types.ts";
import { MESSAGE as PROMPTS } from "./game-ai-prompts.ts";
import type { ModelCheckService } from "./model-check.ts";
import type { GameAiMoments } from "./moments.ts";
import { AiRefusal } from "./refusal.ts";
import type {
  AiDoorAnswer,
  AiReplayRun,
  AiRunBudget,
  GameAiClock,
  GameAiDoorImpl,
  GameAiHarnessHost,
  GameAiModelCheck,
  GameAiQueue,
  GameAiTapes,
} from "./types.ts";

/** The frames a recorded answer takes on replay: the drain after the call. */
const RECORDED_LATENCY_FRAMES = 1;
/** The one repair a reply that does not fit the game's shape gets. */
const REPAIR_ATTEMPTS = 1;
/** How long a harness call's model call may wait for its slot behind a build. */
const SLOT_WAIT_MS = 10 * MINUTE_MS;
/** The longest digest a page may report for one checkpoint. */
const DIGEST_MAX_CHARS = 128;
/** The most checkpoints one play reports. */
const MAX_CHECKPOINTS = 256;
/** The most console errors counted for one play. */
const MAX_COUNT = 1_000_000;

const MESSAGE = {
  badDemo: (demo: string) => `not a demo's name: ${JSON.stringify(demo.slice(0, 80))}`,
  noTape: (demo: string) => `"${demo}" has no saved playtest yet: record it with ai_record`,
} as const;

/** One play of a demo, as the host asks the preview for it. */
export interface AiDemoRun {
  project: string;
  /** The build to play: the game's own folder (null) or a run's checked copy. */
  root: string | null;
  demo: string;
  seed: number;
  /** The lane `genex-ai` plays on, named on the page's shim tag. */
  lane: AiLaneHint;
}

/** What one play reported. Everything but `ended` and the counts came from the page: hostile. */
export interface AiDemoResult {
  /** The demo ran to its end: the page loaded, the demo exists and it did not throw. */
  ended: boolean;
  /** A digest of each checkpoint the demo returned (or of the final state). */
  digests: unknown;
  /** `genex-ai`'s status after the demo (`__genexAi.status()`). */
  status: unknown;
  /** The calls the tape had no answer for (`__genexAi.missed()`). */
  missed: unknown;
  /** Console errors the page logged during the play. */
  consoleErrors: number;
}

/** Where a demo is played: an agent's preview window (`core/ai-demo-player.ts`). */
export interface AiDemoPlayer {
  play(run: AiDemoRun): Promise<AiDemoResult>;
}

/** What the harness host runs on. */
export interface GameAiHarnessDeps {
  clock: GameAiClock;
  /** The folder a call plays: the checked build root, or the library game's own folder. */
  folderOf(project: string, root: string | null): Promise<string>;
  tapes: GameAiTapes;
  player: AiDemoPlayer;
  /** This Mac's door; every model call goes through it, on the run budget. */
  local: GameAiDoorImpl;
  queue: GameAiQueue;
  moments: Pick<GameAiMoments, "list">;
  /** A model check over exactly these doors, for one harness call. */
  checkOn(doors: ReadonlyMap<AiDoor, GameAiDoorImpl>): Pick<ModelCheckService, "start" | "settled">;
  /** The creator's own model check: an agent's check never starts while it runs. */
  creatorCheck: Pick<GameAiModelCheck, "state">;
}

/**
 * A door whose calls are taken from `budget`: a slot per call, released when it answers; none past
 * the cap, none while another runs, none once the budget closed, and no door but the budget's own.
 */
export function budgetedDoor(door: GameAiDoorImpl, budget: AiRunBudget): GameAiDoorImpl {
  return {
    door: door.door,
    readiness: () => door.readiness(),
    models: () => door.models(),
    worstCaseMicros: (request, model) => door.worstCaseMicros(request, model),
    async run(call, signal, onDelta) {
      const slot = call.model.door === door.door ? budget.take(door.door) : null;
      if (!slot) throw new AiRefusal(AiErrorCode.RateLimited);
      try {
        return await door.run(call, signal, onDelta);
      } finally {
        slot.release();
      }
    },
  };
}

/** A demo's name, or a refusal before anything is read, played or written. */
function demoName(demo: string): string {
  if (!isTapeName(demo)) throw new Error(MESSAGE.badDemo(String(demo)));
  return demo;
}

/** The lane a replay plays on for the answers it asked for. */
function replayLane(answers: AiReplayAnswers, demo: string): AiLaneHint {
  if (answers === AiReplayAnswers.None) return { lane: AiLane.Off, tape: null };
  if (answers === AiReplayAnswers.Edge) return { lane: AiLane.Edge, tape: null };
  return { lane: AiLane.Tape, tape: demo };
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
const countOf = (value: unknown): number => (isCount(value) ? value : 0);

/** A play's checkpoint digests, read as hostile: short strings, at most a bounded number. */
function digestsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_CHECKPOINTS)
    .map((digest) => (typeof digest === "string" && digest.length <= DIGEST_MAX_CHARS ? digest : "unreadable"));
}

/** What a play's AI status counts, read as hostile. */
interface PlayCounts {
  misses: number;
  fallbacks: number;
  pending: number;
  refused: Partial<Record<AiErrorCode, number>>;
}

function countsOf(raw: unknown): PlayCounts {
  const status = isPlainRecord(raw) ? raw : {};
  const refused: Partial<Record<AiErrorCode, number>> = {};
  if (isPlainRecord(status.refused)) {
    for (const [code, n] of Object.entries(status.refused)) if (isAiErrorCode(code) && isCount(n)) refused[code] = n;
  }
  return {
    misses: countOf(status.misses),
    fallbacks: countOf(status.fallbacks),
    pending: countOf(status.pending),
    refused,
  };
}

/** Add one play's refusals to the sum. */
function addRefused(sum: Partial<Record<AiErrorCode, number>>, more: Partial<Record<AiErrorCode, number>>): void {
  for (const [code, n] of Object.entries(more)) {
    if (isAiErrorCode(code)) sum[code] = (sum[code] ?? 0) + (n ?? 0);
  }
}

/** The first call a play missed, its key computed here from its request; null when it missed none we can answer. */
async function firstMiss(raw: unknown): Promise<{ key: string; n: number; request: AiCallRequest } | null> {
  const first: unknown = Array.isArray(raw) ? raw[0] : undefined;
  if (!isPlainRecord(first) || !isCount(first.n)) return null;
  const request = readAiCallRequest(first.request);
  if (!request || (request.schema !== null && checkSchema(request.schema) !== null)) return null;
  return { key: await callKey(callKeyInput(request)), n: first.n, request };
}

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 0 ? Math.round((low + high) / 2) : high;
};

/** One model call's outcome: the value when the reply fit (after its repair if it needed one). */
interface Asked {
  value: unknown;
  fitted: boolean;
  answer: AiDoorAnswer | null;
  latencyMs: number;
  /** The run budget or the door refused it: nothing was answered. */
  refused: boolean;
}

/** This Mac's first model that can answer now, or null. */
async function localModel(local: GameAiDoorImpl): Promise<AiModelRef | null> {
  const ready = await local.readiness().catch(() => null);
  if (!ready?.ready || ready.loading) return null;
  const models = await local.models().catch(() => [] as AiModelRef[]);
  return models.find((model) => model.door === AiDoor.Local) ?? null;
}

/** One model call on `door`, held to the call's shape with its one repair; null when neither reply fit. */
async function runWithRepair(
  door: GameAiDoorImpl,
  call: { game: AiGameKey; model: AiModelRef; request: AiCallRequest },
  signal: AbortSignal,
): Promise<{ value: unknown; fitted: boolean; answer: AiDoorAnswer | null }> {
  const { game, model, request } = call;
  let repair: { previous: string; problem: string } | null = null;
  let answer: AiDoorAnswer | null = null;
  for (let attempt = 0; attempt <= REPAIR_ATTEMPTS; attempt += 1) {
    answer = await door.run({ game, request, model, purpose: CompletePurpose.Game, repair }, signal);
    const parsed = parseOutput(request.schema, answer.text);
    if (parsed.ok) return { value: parsed.value, fitted: true, answer };
    repair = { previous: answer.text, problem: PROMPTS.repair(parsed.problem, request.schema !== null) };
  }
  return { value: null, fitted: false, answer };
}

/** Wait for this Mac's slot behind a running build, then make one model call (and its one repair). */
async function ask(
  deps: Pick<GameAiHarnessDeps, "clock" | "queue">,
  door: GameAiDoorImpl,
  call: { game: AiGameKey; model: AiModelRef; request: AiCallRequest },
): Promise<Asked> {
  const started = deps.clock.now();
  const signal = AbortSignal.timeout(SLOT_WAIT_MS);
  const slot = await deps.queue.acquire(AiDoor.Local, call.game, signal);
  if (!slot.ok) return { value: null, fitted: false, answer: null, latencyMs: 0, refused: true };
  try {
    const ran = await runWithRepair(door, call, signal);
    return { ...ran, latencyMs: Math.max(0, deps.clock.now() - started), refused: false };
  } catch {
    return { value: null, fitted: false, answer: null, latencyMs: 0, refused: true };
  } finally {
    slot.release();
  }
}

/** A tape written whole: these lines, in this order, replacing what was there. */
async function writeTape(tapes: GameAiTapes, folder: string, demo: string, lines: readonly TapeLine[]): Promise<void> {
  const recording = await tapes.record(folder, demo);
  for (const line of lines) await recording.append(line);
  await recording.close();
}

/** What a run of plays added up to. */
type PlaySums = PlayCounts & { consoleErrors: number; ended: boolean };
const noSums = (): PlaySums => ({ misses: 0, fallbacks: 0, pending: 0, refused: {}, consoleErrors: 0, ended: true });

/** Play once and sum what it reported into `sums`; the play's checkpoint digests. */
async function playOnce(player: AiDemoPlayer, run: AiDemoRun, sums: PlaySums): Promise<string[]> {
  const played = await player.play(run);
  const counts = countsOf(played.status);
  sums.misses += counts.misses;
  sums.fallbacks += counts.fallbacks;
  sums.pending += counts.pending;
  addRefused(sums.refused, counts.refused);
  sums.consoleErrors += countOf(played.consoleErrors);
  sums.ended &&= played.ended === true;
  return digestsOf(played.digests);
}

/** The lines tape-lacked calls were answered with, one play at a time, and how many could not be. */
async function recordLines(
  deps: GameAiHarnessDeps,
  play: AiDemoRun,
  folder: string,
  door: GameAiDoorImpl,
): Promise<{ lines: TapeLine[]; refused: number }> {
  const game = createGameKey(play.project);
  const model = await localModel(deps.local);
  const lines: TapeLine[] = [];
  const slots = new Set<string>();
  while (lines.length < AI_TAPE_MAX_LINES) {
    const miss = await firstMiss((await deps.player.play(play)).missed);
    // A miss the tape already answers is a page that does not replay itself: stop rather than loop.
    if (!miss || slots.has(tapeSlot(miss.key, miss.n))) break;
    const asked = model ? await ask(deps, door, { game, model, request: miss.request }) : null;
    if (!model || !asked?.fitted) return { lines, refused: 1 };
    slots.add(tapeSlot(miss.key, miss.n));
    lines.push(recordedLine(miss, asked, model));
    await writeTape(deps.tapes, folder, play.demo, lines);
  }
  return { lines, refused: 0 };
}

/** The bench of a call site that has no saved moment, or no model on this Mac to run it. */
const unbenched = (site: string): AiBenchResult => ({
  site,
  model: null,
  samples: 0,
  fitted: 0,
  medianLatencyMs: null,
  medianInputTokens: null,
  medianOutputTokens: null,
});

/** What a bench's samples came to. */
function benchOf(site: string, model: AiModelRef, results: readonly Asked[]): AiBenchResult {
  const usages = results.flatMap((result) => (result.answer?.usage ? [result.answer.usage] : []));
  return {
    site,
    model,
    samples: results.length,
    fitted: results.filter((result) => result.fitted).length,
    medianLatencyMs: median(results.map((result) => result.latencyMs)),
    medianInputTokens: median(usages.map((usage: AiUsage) => usage.inputTokens)),
    medianOutputTokens: median(usages.map((usage: AiUsage) => usage.outputTokens)),
  };
}

/** A replay of a demo: each seed played twice, what the first plays lacked, and whether both plays matched. */
async function replayDemo(
  deps: GameAiHarnessDeps,
  project: string,
  name: string,
  seeds: readonly number[],
  run: AiReplayRun,
): Promise<Omit<AiReplayResult, "rejected">> {
  const lane = replayLane(run.answers, name);
  const first = noSums();
  const again = noSums();
  const stateDigests: string[][] = [];
  let same = true;
  for (const seed of seeds) {
    const play = { project, root: run.root, demo: name, seed, lane };
    const once = await playOnce(deps.player, play, first);
    const twice = await playOnce(deps.player, play, again);
    stateDigests.push(once);
    same &&= once.length > 0 && JSON.stringify(once) === JSON.stringify(twice);
  }
  const ended = first.ended && again.ended;
  return {
    demo: name,
    deterministic: same && ended,
    stateDigests,
    misses: first.misses,
    fallbacks: first.fallbacks,
    answers: run.answers,
    stuck: first.pending,
    settled: ended && first.consoleErrors + again.consoleErrors === 0,
    refused: first.refused,
  };
}

/** The harness host over `deps`. */
export function createGameAiHarnessHost(deps: GameAiHarnessDeps): GameAiHarnessHost {
  return {
    async tapes(project, build): Promise<AiTapeSummary[]> {
      return deps.tapes.list(await deps.folderOf(project, build.root));
    },

    async replay(project, demo, seeds, run): Promise<AiReplayResult> {
      const name = demoName(demo);
      const folder = await deps.folderOf(project, run.root);
      let rejected = 0;
      if (run.answers === AiReplayAnswers.Tape) {
        const summary = (await deps.tapes.list(folder)).find((tape) => tape.name === name);
        if (!summary) throw new Error(MESSAGE.noTape(name));
        rejected = summary.rejected;
      }
      return { ...(await replayDemo(deps, project, name, seeds, run)), rejected };
    },

    async record(project, demo, seed, run): Promise<AiRecordResult> {
      const name = demoName(demo);
      const folder = await deps.folderOf(project, run.root);
      const before = await deps.tapes.read(folder, name).catch(() => null);
      // A recording starts from no answers at all: what an older tape says is never kept by mistake.
      await writeTape(deps.tapes, folder, name, []);
      const play = { project, root: run.root, demo: name, seed, lane: replayLane(AiReplayAnswers.Tape, name) };
      const { lines, refused } = await recordLines(deps, play, folder, budgetedDoor(deps.local, run.budget));
      // Nothing recorded: the game keeps the playtest it had.
      if (!lines.length && before?.length) await writeTape(deps.tapes, folder, name, before);
      return { demo: name, file: tapeFile(name), calls: lines.length, refused };
    },

    async bench(project, site, samples, run): Promise<AiBenchResult> {
      const newest = (await deps.moments.list(project)).filter((moment) => moment.request.site === site).at(-1);
      const model = newest ? await localModel(deps.local) : null;
      if (!newest || !model) return unbenched(site);
      const door = budgetedDoor(deps.local, run.budget);
      const call = { game: createGameKey(project), model, request: newest.request };
      const results: Asked[] = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const asked = await ask(deps, door, call);
        if (asked.refused) break;
        results.push(asked);
      }
      return benchOf(site, model, results);
    },

    async modelCheck(project, run): Promise<AiCheckResult> {
      // The creator's check runs on their own models: an agent's never runs beside it.
      const creator = await deps.creatorCheck.state(project);
      if (creator.state === AiCheckState.Checking) return creator;
      const check = deps.checkOn(new Map([[AiDoor.Local, budgetedDoor(deps.local, run.budget)]]));
      await check.start(project, { localOnly: run.localOnly });
      return check.settled(project);
    },
  };
}

/** The tape line a recorded answer becomes. */
function recordedLine(
  miss: { key: string; n: number; request: AiCallRequest },
  asked: Asked,
  model: AiModelRef,
): TapeLine {
  return {
    v: TAPE_WIRE_VERSION,
    key: miss.key,
    n: miss.n,
    site: miss.request.site,
    op: miss.request.op,
    value: asked.value,
    source: AiDoor.Local,
    model: asked.answer?.model ?? model.model,
    latencyFrames: RECORDED_LATENCY_FRAMES,
    usage: asked.answer?.usage ?? null,
  };
}
