/**
 * The AI starters (`src/harness-seed/library/ai-starters/`) played in Node, with no network: an `ai`
 * object shaped like genex-ai's (`ask`, `drain`, `status`, `disclosure`, `requestBudget`) answered
 * from a lane — the starter's tape, no answer at all, the worst answers its schemas allow, or an
 * author's answers that are written down as the tape (`record.ts`). It keys every call the way the
 * host does (`callKey` over op, site, system, prompt, untrusted, memory, schema and tier, counted by
 * occurrence) and releases an answer on the drain its latency names, so a demo replays the same
 * frames however long the machine takes.
 *
 * Keys are SHA-256 through WebCrypto, which is asynchronous: they are worked out in call order, and
 * the driver (`playDemo`) yields to them after every frame, so each is known by the next drain.
 */
import { setImmediate as yieldToKeys } from "node:timers/promises";
import { AiErrorCode, AiOp, AiProvenance, AiSource, AiTier, readMember } from "../../src/shared/game-ai.ts";
import { canonicalJson, edgeAnswer, edgeOfSeed, validateValue } from "../../src/shared/game-ai-schema.ts";
import { callKey, type TapeLine, type TapeRead, TAPE_WIRE_VERSION, tapeSlot } from "../../src/shared/game-ai-tape.ts";

/** What answers a lane's calls. Mirrors `AiReplayAnswers`, plus the author whose answers become a tape. */
export const StarterLane = { Tape: "tape", None: "none", Edge: "edge", Author: "author" } as const;
export type StarterLane = (typeof StarterLane)[keyof typeof StarterLane];

/** A call as a starter makes it (`ai.ask`). */
export interface StarterRequest {
  site: string;
  system?: string | null;
  prompt: string;
  untrusted?: Record<string, string>;
  schema: unknown;
  tier: string;
  maxOutputTokens?: number;
  authority?: string;
  fallback?: unknown;
}

/** A result as `ai.drain()` hands it to the game. */
export interface StarterResult {
  ticket: string;
  site: string;
  ok: boolean;
  value: unknown;
  code: string | null;
  provenance: string;
}

/** An author's answer to one call: the value, and how many frames it took. */
export interface AuthoredAnswer {
  value: unknown;
  latencyFrames: number;
}

/** What a lane plays from. */
export interface LaneOptions {
  lane: StarterLane;
  seed: number;
  tape?: TapeRead;
  author?: (request: StarterRequest) => AuthoredAnswer;
}

/** What a lane saw: the calls, the misses, the fallbacks, the grant asks and the lines an author wrote. */
export interface LaneRecord {
  calls: number;
  misses: number;
  fallbacks: number;
  invalid: number;
  budgetAsks: number;
  lines: TapeLine[];
}

/** A call on its way: its ticket and site, and the answer once its key is known. */
interface Pending {
  ticket: string;
  site: string;
  askedAt: number;
  ready: { result: StarterResult; latencyFrames: number } | null;
}

/** The latency of a refusal or a canned answer, in frames. */
const CANNED_LATENCY_FRAMES = 1;
/** The text of the disclosure chip. */
const DISCLOSURE = { text: "AI-generated", anchor: "top-right" } as const;

/** A call's fallback, as genex-ai reads it: a value, or a function of the failure. */
function fallbackOf(request: StarterRequest, code: string): unknown {
  return typeof request.fallback === "function" ? request.fallback({ code }) : request.fallback;
}

/** The key a call's answer is filed under. */
const keyOf = (request: StarterRequest): Promise<string> =>
  callKey({
    op: AiOp.Ask,
    site: request.site,
    system: request.system ?? null,
    prompt: request.prompt,
    untrusted: request.untrusted ?? {},
    memory: null,
    schema: request.schema,
    tier: readMember(AiTier, request.tier) ?? AiTier.Fast,
  });

/** An `ai` object for a starter, answered from `options.lane`; `record` is what it saw. */
export function starterAi(options: LaneOptions) {
  const record: LaneRecord = { calls: 0, misses: 0, fallbacks: 0, invalid: 0, budgetAsks: 0, lines: [] };
  const pending: Pending[] = [];
  const occurrences = new Map<string, number>();
  let drains = 0;
  let tickets = 0;
  let keys: Promise<unknown> = Promise.resolve();

  const ok = (entry: Pending, value: unknown, provenance: string): StarterResult => ({
    ticket: entry.ticket,
    site: entry.site,
    ok: true,
    value,
    code: null,
    provenance,
  });
  const failed = (entry: Pending, request: StarterRequest, code: string): StarterResult => {
    const value = fallbackOf(request, code);
    if (value !== undefined) record.fallbacks += 1;
    return { ticket: entry.ticket, site: entry.site, ok: false, value, code, provenance: AiProvenance.Replay };
  };

  /** The answer a call gets on this lane, once its key is known. */
  function answer(entry: Pending, request: StarterRequest, key: string, n: number) {
    if (options.lane === StarterLane.None) return { result: failed(entry, request, AiErrorCode.Off), latencyFrames: 1 };
    if (options.lane === StarterLane.Edge) {
      const value = edgeAnswer(request.schema, edgeOfSeed(options.seed));
      return { result: ok(entry, value, AiProvenance.Replay), latencyFrames: CANNED_LATENCY_FRAMES };
    }
    if (options.lane === StarterLane.Author) return authored(entry, request, key, n);
    const line = options.tape?.bySlot.get(tapeSlot(key, n));
    if (!line || !validateValue(request.schema, line.value)) {
      record.misses += 1;
      return { result: failed(entry, request, AiErrorCode.Unrecorded), latencyFrames: CANNED_LATENCY_FRAMES };
    }
    return { result: ok(entry, line.value, AiProvenance.Replay), latencyFrames: line.latencyFrames };
  }

  /** The author's answer to a call, or null when it has none (it ran out, or threw). */
  function authoredAnswer(request: StarterRequest): AuthoredAnswer | null {
    try {
      return options.author?.(request) ?? null;
    } catch {
      return null;
    }
  }

  /** An author's answer, written down as a tape line. */
  function authored(entry: Pending, request: StarterRequest, key: string, n: number) {
    const given = authoredAnswer(request);
    if (!given || !validateValue(request.schema, given.value)) {
      record.invalid += 1;
      return { result: failed(entry, request, AiErrorCode.InvalidOutput), latencyFrames: CANNED_LATENCY_FRAMES };
    }
    record.lines.push({
      v: TAPE_WIRE_VERSION,
      key,
      n,
      site: request.site,
      op: AiOp.Ask,
      value: given.value,
      source: AiSource.Fixture,
      model: null,
      latencyFrames: given.latencyFrames,
      usage: null,
    });
    return { result: ok(entry, given.value, AiProvenance.Fixture), latencyFrames: given.latencyFrames };
  }

  const ai = {
    ask(request: StarterRequest): string {
      record.calls += 1;
      tickets += 1;
      const entry: Pending = { ticket: `t${tickets}`, site: request.site, askedAt: drains, ready: null };
      pending.push(entry);
      keys = keys.then(async () => {
        const key = await keyOf(request);
        const n = occurrences.get(key) ?? 0;
        occurrences.set(key, n + 1);
        entry.ready = answer(entry, request, key, n);
      });
      return entry.ticket;
    },
    drain(): StarterResult[] {
      drains += 1;
      const due = pending.filter((entry) => entry.ready && entry.askedAt + entry.ready.latencyFrames <= drains);
      for (const entry of due) pending.splice(pending.indexOf(entry), 1);
      return due.map((entry) => entry.ready?.result).filter((result): result is StarterResult => Boolean(result));
    },
    status: () => ({ pending: pending.length }),
    disclosure: () => DISCLOSURE,
    async requestBudget(): Promise<null> {
      record.budgetAsks += 1;
      return null;
    },
    async activeBudget(): Promise<null> {
      return null;
    },
  };
  /** Wait until every call asked so far has its key, as a frame's end does in a page. */
  const settled = () => keys;
  return { ai, record, settled };
}

/** A starter's demo as the lanes play it: it creates its game around `ai` and plays with `step`. */
export interface StarterDemo {
  create(deps: { ai: ReturnType<typeof starterAi>["ai"]; seed: number }): StarterGame;
  play(game: StarterGame, step: () => Promise<void>): Promise<unknown[]>;
}

/** What the lanes read of a starter's game. */
export interface StarterGame {
  update(): void;
  state(): Record<string, unknown>;
}

/** What one play of a demo ended with: a digest per checkpoint, the end state and what the lane saw. */
export interface DemoPlay {
  digests: string[];
  end: Record<string, unknown>;
  stuck: number;
  record: LaneRecord;
}

/** A state's digest: its canonical JSON, which two identical plays share byte for byte. */
const digestOf = (state: unknown): string => canonicalJson(state);

/** Play a starter's demo on a lane: every frame updates the game, then lets the keys catch up. */
export async function playDemo(demo: StarterDemo, options: LaneOptions): Promise<DemoPlay> {
  const lane = starterAi(options);
  const game = demo.create({ ai: lane.ai, seed: options.seed });
  const step = async () => {
    await lane.settled();
    game.update();
    await yieldToKeys();
  };
  const checkpoints = await demo.play(game, step);
  return {
    digests: checkpoints.map(digestOf),
    end: game.state(),
    stuck: lane.ai.status().pending,
    record: lane.record,
  };
}
