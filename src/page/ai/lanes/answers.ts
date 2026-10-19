/**
 * Main's answers as the page reads them. They cross a bridge the page shares with the game (the
 * Create route's fetch, the Play view's `window.__genexDesktop`), so every one is read field by
 * field like any other input: a malformed answer is never handed to the game, it becomes a typed
 * failure. Pure; nothing here throws.
 */
import {
  AI_ID_RE,
  type AiBudgetView,
  type AiCallAnswer,
  AiDoor,
  type AiErrorCode,
  AiGrantStatus,
  AiProvenance,
  AiSource,
  GAME_AI_WIRE_VERSION,
  isAiErrorCode,
  isPlainRecord,
  readMember,
} from "../../../shared/game-ai.ts";
import type { AiGrantAnswer } from "../../../shared/game-ai-bridge.ts";
import { isAnswerJson } from "../../../shared/game-ai-schema.ts";

/** The longest ISO time a grant view carries. */
const MAX_TIME_CHARS = 40;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A retry hint: null, or a wait in milliseconds. */
const isRetry = (value: unknown): value is number | null => value === null || isCount(value);

/** `hello`'s answer: whether AI is on here; null when it is not an answer. */
export function readHello(raw: unknown): boolean | null {
  if (!isPlainRecord(raw) || raw.v !== GAME_AI_WIRE_VERSION || typeof raw.on !== "boolean") return null;
  return raw.on;
}

/** A yes-or-no answer (`canceled`, `stopped`) under `key`; false when it is not one. */
export function readFlag(raw: unknown, key: string): boolean {
  return isPlainRecord(raw) && raw[key] === true;
}

/** A plan share: null, or a percentage. */
const isPercent = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);

const isTime = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length <= MAX_TIME_CHARS);

/** A grant as the game may see it, or null when it is not one. */
export function readBudgetView(raw: unknown): AiBudgetView | null {
  if (!isPlainRecord(raw)) return null;
  const { id, spentMicros, planUsedPercent, planResetsAt } = raw;
  const status = readMember(AiGrantStatus, raw.status);
  const door = readMember(AiDoor, raw.door);
  if (typeof id !== "string" || !AI_ID_RE.test(id) || !status || !door) return null;
  if (!isCount(spentMicros) || !isPercent(planUsedPercent) || !isTime(planResetsAt)) return null;
  return { id, status, door, spentMicros, planUsedPercent, planResetsAt };
}

/** A code that may be absent: null, a code, or undefined when it is neither. */
function readCode(raw: unknown): AiErrorCode | null | undefined {
  if (raw === null) return null;
  return isAiErrorCode(raw) ? raw : undefined;
}

/** A grant answer, or null when it is not one. */
export function readGrantAnswer(raw: unknown): AiGrantAnswer | null {
  if (!isPlainRecord(raw)) return null;
  const view = raw.view === null ? null : readBudgetView(raw.view);
  const code = readCode(raw.code);
  const badView = raw.view !== null && view === null;
  if (badView || code === undefined) return null;
  return { view, code };
}

/** A refused call's answer, read. */
function readRefused(raw: Record<string, unknown>, ticket: string): AiCallAnswer | null {
  if (!isAiErrorCode(raw.code) || !isRetry(raw.retryAfterMs)) return null;
  return { v: GAME_AI_WIRE_VERSION, ok: false, ticket, code: raw.code, retryAfterMs: raw.retryAfterMs };
}

/** An answered call's answer, read: its value plain JSON within the answer bounds. */
function readAnswered(raw: Record<string, unknown>, ticket: string): AiCallAnswer | null {
  const source = readMember(AiSource, raw.source);
  const provenance = readMember(AiProvenance, raw.provenance);
  const { value, latencyMs, cached } = raw;
  if (!source || !provenance || !isCount(latencyMs) || typeof cached !== "boolean") return null;
  if (value === undefined || !isAnswerJson(value)) return null;
  return { v: GAME_AI_WIRE_VERSION, ok: true, ticket, value, source, provenance, latencyMs, cached };
}

/** A call's answer for `ticket`, or null when it is not one (or answers another ticket). */
export function readCallAnswer(raw: unknown, ticket: string): AiCallAnswer | null {
  if (!isPlainRecord(raw) || raw.v !== GAME_AI_WIRE_VERSION || raw.ticket !== ticket) return null;
  if (raw.ok === true) return readAnswered(raw, ticket);
  return raw.ok === false ? readRefused(raw, ticket) : null;
}

/** The code of a route refusal (any status but 200), or null. */
export function readRouteRefusal(raw: unknown): AiErrorCode | null {
  if (!isPlainRecord(raw) || raw.v !== GAME_AI_WIRE_VERSION) return null;
  return isAiErrorCode(raw.code) ? raw.code : null;
}
