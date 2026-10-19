/**
 * One message shape for every lane a game's AI bridge reaches main on: the Play view's preload
 * (`play-ai.ts`), the Create Live route (`POST game://<project>/__genex/ai/v1/<op>`) and a native
 * player's Play Protocol `ai` line (`play-protocol.ts`). Each lane carries an op of
 * {@link AiBridgeOp} with the body {@link AiBridgeBodies} names, and main answers with the body
 * {@link AiBridgeAnswers} names. `readAiBridgeBody` is the one hostile-input reader all of them run.
 *
 * Browser-safe; pure.
 */
import {
  type AiBudgetView,
  type AiCallAnswer,
  type AiCallRequest,
  AiBridgeOp,
  type AiDoor,
  type AiErrorCode,
  type AiGrantRequest,
  type GAME_AI_WIRE_VERSION,
  hasExactKeys,
  isPlainRecord,
  readAiCallRequest,
  readAiGrantRequest,
  readAiTicket,
  readMember,
} from "./game-ai.ts";

/** What a game sends with each op. */
export interface AiBridgeBodies {
  [AiBridgeOp.Hello]: null;
  [AiBridgeOp.Doors]: null;
  [AiBridgeOp.Call]: AiCallRequest;
  [AiBridgeOp.Cancel]: { ticket: string };
  [AiBridgeOp.BudgetActive]: null;
  [AiBridgeOp.BudgetRequest]: AiGrantRequest;
  [AiBridgeOp.BudgetStop]: null;
}

/** Whether AI can run for this game here at all; sent once, at `hello`. */
export interface AiHelloAnswer {
  v: typeof GAME_AI_WIRE_VERSION;
  /** AI is allowed in this context and not turned off for the game. */
  on: boolean;
}

/** The game's AI as it may know it: on or off, and on which door (no model, no price). */
export interface AiDoorsAnswer {
  on: boolean;
  door: AiDoor | null;
}

/** A grant asked about or asked for: the view, or why there is none. */
export interface AiGrantAnswer {
  view: AiBudgetView | null;
  code: AiErrorCode | null;
}

/** What main answers each op with. */
export interface AiBridgeAnswers {
  [AiBridgeOp.Hello]: AiHelloAnswer;
  [AiBridgeOp.Doors]: AiDoorsAnswer;
  [AiBridgeOp.Call]: AiCallAnswer;
  [AiBridgeOp.Cancel]: { canceled: boolean };
  [AiBridgeOp.BudgetActive]: AiGrantAnswer;
  [AiBridgeOp.BudgetRequest]: AiGrantAnswer;
  [AiBridgeOp.BudgetStop]: { stopped: boolean };
}

/** One message from a game, its op and body read. */
export type AiBridgeMessage = { [O in AiBridgeOp]: { op: O; body: AiBridgeBodies[O] } }[AiBridgeOp];

const CANCEL_KEYS = ["ticket"] as const;

function cancelBody(raw: unknown): { ticket: string } | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, CANCEL_KEYS)) return null;
  const ticket = readAiTicket(raw.ticket);
  return ticket ? { ticket } : null;
}

/**
 * A game's op and body as main accepts them, or null. An op with no body takes exactly `null`;
 * the others go through their own readers. Pure; never throws.
 */
export function readAiBridgeBody(rawOp: unknown, raw: unknown): AiBridgeMessage | null {
  const op = readMember(AiBridgeOp, rawOp);
  switch (op) {
    case AiBridgeOp.Hello:
    case AiBridgeOp.Doors:
    case AiBridgeOp.BudgetActive:
    case AiBridgeOp.BudgetStop:
      return raw === null ? { op, body: null } : null;
    case AiBridgeOp.Call: {
      const body = readAiCallRequest(raw);
      return body ? { op, body } : null;
    }
    case AiBridgeOp.Cancel: {
      const body = cancelBody(raw);
      return body ? { op, body } : null;
    }
    case AiBridgeOp.BudgetRequest: {
      const body = readAiGrantRequest(raw);
      return body ? { op, body } : null;
    }
    default:
      return null;
  }
}

/** The Create Live route's path prefix on the game's own origin; the op follows it. */
export const AI_ROUTE_PREFIX = "/__genex/ai/v1/";

/** The op a Create Live route path names, or null for any other path. */
export function aiRouteOp(pathname: string): AiBridgeOp | null {
  if (!pathname.startsWith(AI_ROUTE_PREFIX)) return null;
  return readMember(AiBridgeOp, pathname.slice(AI_ROUTE_PREFIX.length));
}
