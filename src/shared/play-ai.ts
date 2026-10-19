/**
 * Play-time AI in Play: how a published game's page reaches main. The Play view's one preload
 * (`preload/play-mic.ts`, with its page-world half in `preload/play-ai-page.ts`) installs
 * `window.__genexDesktop` in the page: the embed-sdk desktop path (`confirm`, from
 * `genex-desktop-bridge.ts`) and the `genex-ai` host lane (`ai`). Both cross to main on these
 * channels as numbered envelopes; main derives the game from the sending frame on every message
 * (never from the payload), answers each envelope once, and streams a `say` answer's text as deltas.
 *
 * Browser-safe; pure.
 */
import { SECOND_MS } from "./duration.ts";
import { AiBridgeOp, isPlainRecord, hasExactKeys, readMember } from "./game-ai.ts";
import { type AiBridgeAnswers, type AiBridgeBodies, readAiBridgeBody } from "./game-ai-bridge.ts";
import {
  type GenexDesktopBridge,
  type GenexDesktopConfirmAnswer,
  type GenexDesktopConfirmRequest,
  readGenexConfirmRequest,
} from "./genex-desktop-bridge.ts";

/** The Play view preload's AI channels. Wire values: never rename one. */
export const PlayAiChannel = {
  /** Page → main: one envelope. */
  Request: "play-ai:request",
  /** Main → page: the answer to one envelope. */
  Reply: "play-ai:reply",
  /** Main → page: text of a streamed `say` answer so far. */
  Delta: "play-ai:delta",
} as const;
export type PlayAiChannel = (typeof PlayAiChannel)[keyof typeof PlayAiChannel];

/** What a Play page may ask: the AI bridge's ops, and the embed-sdk's desktop confirm. Wire values. */
export const PlayBridgeOp = { ...AiBridgeOp, GenexConfirm: "genex.confirm" } as const;
export type PlayBridgeOp = (typeof PlayBridgeOp)[keyof typeof PlayBridgeOp];

/** What a Play page sends with each op. */
export interface PlayBridgeBodies extends AiBridgeBodies {
  [PlayBridgeOp.GenexConfirm]: GenexDesktopConfirmRequest;
}

/** What main answers each op with. */
export interface PlayBridgeAnswers extends AiBridgeAnswers {
  [PlayBridgeOp.GenexConfirm]: GenexDesktopConfirmAnswer;
}

/** The most envelopes a page may send in one burst window; more are dropped unanswered. */
export const PLAY_AI_BURST = 20;
/** The burst window. */
export const PLAY_AI_WINDOW_MS = SECOND_MS;
/** The most envelopes of one page main holds unanswered; past it a call answers `grant_concurrency`. */
export const PLAY_AI_MAX_PENDING = 8;
/** An envelope's number: the page counts them up from 1. */
export const PLAY_AI_MAX_ENVELOPE_ID = 2 ** 31 - 1;

/** One envelope from a Play page, read. */
export type PlayAiEnvelope = {
  [O in PlayBridgeOp]: { id: number; op: O; body: PlayBridgeBodies[O] };
}[PlayBridgeOp];

/** Main's answer to one envelope. */
export type PlayAiReply = { [O in PlayBridgeOp]: { id: number; op: O; body: PlayBridgeAnswers[O] } }[PlayBridgeOp];

/** A streamed answer's text so far, for the envelope that asked. */
export interface PlayAiDelta {
  id: number;
  text: string;
}

const ENVELOPE_KEYS = ["id", "op", "body"] as const;

const isEnvelopeId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= PLAY_AI_MAX_ENVELOPE_ID;

/** An envelope from the untrusted page as main accepts it, or null. Pure; never throws. */
export function readPlayAiEnvelope(raw: unknown): PlayAiEnvelope | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ENVELOPE_KEYS) || !isEnvelopeId(raw.id)) return null;
  const id = raw.id;
  if (readMember(PlayBridgeOp, raw.op) === PlayBridgeOp.GenexConfirm) {
    const body = readGenexConfirmRequest(raw.body);
    return body ? { id, op: PlayBridgeOp.GenexConfirm, body } : null;
  }
  const message = readAiBridgeBody(raw.op, raw.body);
  return message ? { id, ...message } : null;
}

/** The `genex-ai` host lane on `window.__genexDesktop.ai`: one request per op, and a `say` stream. */
export interface GenexDesktopAi {
  request<O extends keyof AiBridgeBodies>(op: O, body: AiBridgeBodies[O]): Promise<AiBridgeAnswers[O]>;
  /** Text of the call with `ticket` so far; returns the unsubscribe. */
  onDelta(ticket: string, listener: (text: string) => void): () => void;
}

/** `window.__genexDesktop` in a Play page: the embed-sdk's confirm and the `genex-ai` host lane. */
export interface GenexDesktopWindow extends GenexDesktopBridge {
  readonly ai: GenexDesktopAi;
}
