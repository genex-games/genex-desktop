/**
 * The lanes that never reach a model: off (no answers at all), tape (a saved playtest, and a call
 * it does not cover fails `ai_unrecorded`), mock (the saved playtest where it covers the call,
 * else a value made up from the schema) and edge (the worst value the call's schema admits). A tape is game content an agent can write, so the page
 * reads it as hostile input (`readTape`), takes a line only for the call slot, op and site it
 * names, and only when its value fits the call's schema. Nothing here is verified.
 */
import { AiDoor, AiErrorCode, type AiGrantRequest, AiProvenance, AiSource } from "../../../shared/game-ai.ts";
import type { AiGrantAnswer } from "../../../shared/game-ai-bridge.ts";
import { AiLane } from "../../../shared/game-ai-lane.ts";
import { edgeAnswer, edgeOfSeed, edgeText, validateValue } from "../../../shared/game-ai-schema.ts";
import {
  AI_TAPE_MAX_BYTES,
  type TapeLine,
  type TapeRead,
  readTape,
  tapeFile,
  tapeSlot,
} from "../../../shared/game-ai-tape.ts";
import {
  answeredReply,
  type Lane,
  type LaneCall,
  type LaneOpened,
  type LaneReply,
  noGrant,
  REFUSAL_FRAMES,
  refusedReply,
  replayGrant,
} from "./lane.ts";
import { mockAnswer, slotRandom } from "./mock.ts";

/** The frames a made-up answer takes: about a tenth of a second at sixty frames. */
export const MOCK_LATENCY_FRAMES = 6;

/** Fetch, as the page has it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The off lane: every call fails `ai_off` on the next drain, and there is never a grant. */
export function offLane(): Lane {
  return {
    lane: AiLane.Off,
    needsGrant: false,
    open: async () => ({ on: false, grant: noGrant(AiErrorCode.Off), tape: null }),
    call: ({ call }) => refusedReply(call.wire.ticket, AiErrorCode.Off),
    cancel: () => {},
    activeGrant: async () => noGrant(AiErrorCode.Off),
    requestGrant: async () => noGrant(AiErrorCode.Off),
    stopGrant: async () => false,
    reseed: () => {},
  };
}

/** An empty tape: every call misses. */
const EMPTY_TAPE: TapeRead = { lines: [], bySlot: new Map(), rejected: 0, truncated: false };

/** A demo's saved playtest from the game's own folder; a tape that is missing or unreadable is empty. */
export async function loadTape(fetchTape: FetchLike, demo: string | null): Promise<TapeRead> {
  if (demo === null) return EMPTY_TAPE;
  try {
    const response = await fetchTape(`/${tapeFile(demo)}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return EMPTY_TAPE;
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > AI_TAPE_MAX_BYTES) return { ...EMPTY_TAPE, truncated: true };
    return readTape(await response.text());
  } catch {
    return EMPTY_TAPE;
  }
}

/** Whether a tape line answers this call: its slot, op and site, and a value the call's schema admits. */
function lineAnswers(line: TapeLine | undefined, request: LaneCall): line is TapeLine {
  const { wire } = request.call;
  return line !== undefined && line.op === wire.op && line.site === wire.site && validateValue(wire.schema, line.value);
}

/** What a replay lane needs: which lane it is, the demo whose tape answers, and how to fetch it. */
export interface ReplayLaneOptions {
  lane: typeof AiLane.Tape | typeof AiLane.Mock;
  demo: string | null;
  fetch: FetchLike;
  seed: number;
}

/** The tape lane, or the mock lane (the tape where it covers the call, else made-up values). */
export function replayLane(options: ReplayLaneOptions): Lane {
  const mock = options.lane === AiLane.Mock;
  const door = mock ? AiDoor.Fixture : AiDoor.Tape;
  let seed = options.seed;
  let stopped = false;
  let tape: TapeRead | null = null;
  const loading = loadTape(options.fetch, options.demo).then((read) => {
    tape = read;
    return read;
  });

  function answer(request: LaneCall, read: TapeRead): LaneReply {
    const ticket = request.call.wire.ticket;
    const line = read.bySlot.get(tapeSlot(request.key, request.n));
    if (lineAnswers(line, request)) {
      return answeredReply(
        ticket,
        line.value,
        { source: line.source, provenance: AiProvenance.Replay },
        line.latencyFrames,
      );
    }
    if (!mock) return refusedReply(ticket, AiErrorCode.Unrecorded, REFUSAL_FRAMES, true);
    const value = mockAnswer(request.call.wire.schema, slotRandom(seed, request.key, request.n));
    const reply = answeredReply(
      ticket,
      value,
      { source: AiSource.Fixture, provenance: AiProvenance.Fixture },
      MOCK_LATENCY_FRAMES,
    );
    return { ...reply, missed: true };
  }

  const grant = (): AiGrantAnswer => (stopped ? noGrant(null) : { view: replayGrant(door), code: null });
  return {
    lane: options.lane,
    needsGrant: false,
    async open(): Promise<LaneOpened> {
      await loading;
      return { on: true, grant: grant(), tape: options.demo };
    },
    call: (request) => (tape ? answer(request, tape) : loading.then((read) => answer(request, read))),
    cancel: () => {},
    activeGrant: async () => grant(),
    async requestGrant(_request: AiGrantRequest) {
      stopped = false;
      return grant();
    },
    async stopGrant() {
      stopped = true;
      return true;
    },
    reseed(next) {
      seed = next;
    },
  };
}

/**
 * The edge lane: every call answered with the worst value its schema admits on the seed's side
 * (`edgeOfSeed`: odd seeds the largest numbers, longest strings and fullest lists, even seeds the
 * smallest), on a fixed frame, so a seed replays the same frames. It never misses and never reaches
 * a model: a harness replay with `answers: "edge"` shows whether the game clamps what a model says.
 */
export function edgeLane(): Lane {
  let seed = 1;
  let stopped = false;
  const grant = (): AiGrantAnswer => (stopped ? noGrant(null) : { view: replayGrant(AiDoor.Fixture), code: null });
  return {
    lane: AiLane.Edge,
    needsGrant: false,
    open: async () => ({ on: true, grant: grant(), tape: null }),
    call: ({ call }) => {
      const edge = edgeOfSeed(seed);
      const { schema, ticket } = call.wire;
      const value = schema === null ? edgeText(edge) : edgeAnswer(schema, edge);
      if (value === undefined) return refusedReply(ticket, AiErrorCode.InvalidSchema);
      const origin = { source: AiSource.Fixture, provenance: AiProvenance.Fixture };
      return answeredReply(ticket, value, origin, MOCK_LATENCY_FRAMES);
    },
    cancel: () => {},
    activeGrant: async () => grant(),
    async requestGrant() {
      stopped = false;
      return grant();
    },
    async stopGrant() {
      stopped = true;
      return true;
    },
    reseed(next) {
      seed = next;
    },
  };
}
