/**
 * A lane: where a page's answers come from. Every lane takes the same compiled call and answers it
 * with the same `AiCallAnswer`; a replay lane (off, tape, mock) also says how many frames the
 * answer took live, so the inbox releases it on exactly that drain, and a live lane (host,
 * platform) answers when it answers. Grants go through the lane too: main's on the host lane,
 * genex.games' on the platform lane, a stand-in one on a replay lane.
 */
import {
  type AiBudgetView,
  type AiCallAnswer,
  type AiErrorCode,
  type AiGrantRequest,
  AiGrantStatus,
  type AiDoor,
  type AiProvenance,
  type AiSource,
  GAME_AI_WIRE_VERSION,
  refusedAnswer,
} from "../../../shared/game-ai.ts";
import type { AiGrantAnswer } from "../../../shared/game-ai-bridge.ts";
import type { AiLane } from "../../../shared/game-ai-lane.ts";
import type { CompiledCall } from "../compile.ts";

/** How many frames a refusal on a replay lane takes: the next drain. */
export const REFUSAL_FRAMES = 1;

/** A lane's answer to one call: the answer, the frames it took live (null: live, due on the next drain), and whether a saved playtest missed it. */
export interface LaneReply {
  answer: AiCallAnswer;
  frames: number | null;
  missed: boolean;
}

/** One call as a lane runs it. */
export interface LaneCall {
  call: CompiledCall;
  /** The call's tape key (`callKey`) and which occurrence of it this is, from 0. */
  key: string;
  n: number;
  /** A `say` answer's text so far. */
  onDelta(text: string): void;
  signal: AbortSignal;
}

/** What a lane says once it is open: whether AI answers here, and the grant the game already holds. */
export interface LaneOpened {
  on: boolean;
  grant: AiGrantAnswer;
  /** The demo whose saved playtest answers; null on a lane with none. */
  tape: string | null;
}

/** One lane. */
export interface Lane {
  readonly lane: AiLane;
  /** A call needs a grant the page holds before it goes (genex.games' calls name their grant). */
  readonly needsGrant: boolean;
  /** Settle the lane: load its tape, or ask main whether AI is on here. */
  open(): Promise<LaneOpened>;
  call(call: LaneCall): LaneReply | Promise<LaneReply>;
  /** Stop a call still running; its answer is no longer wanted. */
  cancel(ticket: string): void;
  activeGrant(): Promise<AiGrantAnswer>;
  requestGrant(request: AiGrantRequest): Promise<AiGrantAnswer>;
  stopGrant(grantId: string | null): Promise<boolean>;
  /** The world was reset with a seed: a mock lane makes its values from it. */
  reseed(seed: number): void;
}

/** A refusal as a lane replies it. */
export const refusedReply = (
  ticket: string,
  code: AiErrorCode,
  frames: number | null = REFUSAL_FRAMES,
  missed = false,
): LaneReply => ({ answer: refusedAnswer(ticket, code), frames, missed });

/** An answer as a lane replies it. */
export function answeredReply(
  ticket: string,
  value: unknown,
  origin: { source: AiSource; provenance: AiProvenance },
  frames: number | null,
): LaneReply {
  const answer: AiCallAnswer = {
    v: GAME_AI_WIRE_VERSION,
    ok: true,
    ticket,
    value,
    source: origin.source,
    provenance: origin.provenance,
    latencyMs: 0,
    cached: false,
  };
  return { answer, frames, missed: false };
}

/** The id a replay lane's stand-in grant carries. */
export const REPLAY_GRANT_ID = "replay-grant";

/** A replay lane's stand-in grant: it costs nothing and names the lane's door. */
export const replayGrant = (door: AiDoor): AiBudgetView => ({
  id: REPLAY_GRANT_ID,
  status: AiGrantStatus.Active,
  door,
  spentMicros: 0,
  planUsedPercent: null,
  planResetsAt: null,
});

/** No grant, and why. */
export const noGrant = (code: AiErrorCode | null): AiGrantAnswer => ({ view: null, code });
