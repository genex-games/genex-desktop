/**
 * The development lane: the creator's own game's playtests on the creator's Genex credits,
 * dispatched and billed by genex.games (`/api/runtime/development/projects/:id/generations`), so its
 * answers are verified. Main calls it with the creator's token; the game never sees the token, the
 * model id or a price. A call names the most credits it may spend, from the model's catalog price at
 * genex.games' rate, and waits for the generation to finish (Stop cancels it there too). What it
 * cost is what genex.games charged. Only the creator's own game reaches it: the project comes from
 * the library's link to its published self, never from the page.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { MINUTE_MS } from "../../../shared/duration.ts";
import {
  AiDoor,
  AiErrorCode,
  type AiCallRequest,
  type AiGameKey,
  type AiModelRef,
  creditsOfMicros,
  isPlainRecord,
  MICROS_PER_CREDIT,
} from "../../../shared/game-ai.ts";
import type { DoorReadiness } from "../../../shared/game-ai-route.ts";
import type { GalleryRequest } from "../../play/gallery.ts";
import { gameSingleText, promptTokensOf } from "../game-ai-prompts.ts";
import { AiRefusal } from "../refusal.ts";
import type { AiDoorAnswer, AiDoorRequest, GameAiDoorImpl } from "../types.ts";
import { GAME_CALL_TIMEOUT_MS } from "./engine.ts";

/** The engine a platform model names. */
export const GENEX_ENGINE = "genex";
/** genex.games bills a call at its provider cost times this (`runtime_play`). */
const STAND_RATE = 1.15;
/** How often a running generation is asked about. */
const POLL_MS = 500;
/** How long the model list is kept. */
const MODELS_TTL_MS = MINUTE_MS;
/** The longest model id the lane takes (genex.games `modelId` max). */
const MODEL_ID_MAX = 150;
/** An idempotency key's longest form (genex.games: 8–100 characters). */
const IDEMPOTENCY_MAX = 100;
/** The repair's key suffix: the same ticket's second attempt is a new generation. */
const REPAIR_SUFFIX = "-repair";

/** The routes of the development lane. */
export const DevRoute = {
  Models: "/api/runtime/models",
  generations: (project: string) => `/api/runtime/development/projects/${encodeURIComponent(project)}/generations`,
  generation: (project: string, id: string) =>
    `/api/runtime/development/projects/${encodeURIComponent(project)}/generations/${encodeURIComponent(id)}`,
  cancel: (project: string, id: string) =>
    `/api/runtime/development/projects/${encodeURIComponent(project)}/generations/${encodeURIComponent(id)}/cancel`,
} as const;

/** A generation's states genex.games names. Wire values. */
const GenerationStatus = {
  Succeeded: "succeeded",
  Failed: "failed",
  Canceled: "canceled",
  Expired: "expired",
  Unknown: "unknown",
} as const;

/** What a finished generation answers a game with, when it gave no answer. */
const FAILED_CODE: Readonly<Record<string, AiErrorCode>> = {
  [GenerationStatus.Failed]: AiErrorCode.Provider,
  [GenerationStatus.Canceled]: AiErrorCode.Canceled,
  [GenerationStatus.Expired]: AiErrorCode.Timeout,
  [GenerationStatus.Unknown]: AiErrorCode.Provider,
};

/** One model the lane serves, with its catalog price per million tokens. */
interface DevModel {
  id: string;
  input: number;
  output: number;
  contextLength: number;
}

/** What the development lane runs on. */
export interface GenexDevDoorOptions {
  request: GalleryRequest;
  /** The creator's Genex token, or undefined while signed out. */
  token(): Promise<string | undefined>;
  /** The genex.games project of the creator's own game, from the library; null for any other game. */
  projectOf(game: AiGameKey): Promise<string | null>;
  now?: () => number;
  /** The pause between polls (tests hold it short). */
  pollMs?: number;
}

const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The catalog's models as untrusted input: a row without a full price is never offered. */
export function readDevModels(body: unknown): DevModel[] {
  const rows = isPlainRecord(body) && Array.isArray(body.models) ? body.models : [];
  const featured = isPlainRecord(body) && typeof body.featuredCount === "number" && body.featuredCount > 0;
  return rows.flatMap((row) => {
    if (!isPlainRecord(row) || typeof row.id !== "string" || !row.id || row.id.length > MODEL_ID_MAX) return [];
    if (!isPrice(row.inputUsdPerMillion) || !isPrice(row.outputUsdPerMillion)) return [];
    if (row.kind !== undefined && row.kind !== "openrouter") return [];
    if (featured && row.featured !== true) return [];
    const contextLength = typeof row.contextLength === "number" && row.contextLength > 0 ? row.contextLength : 0;
    return [{ id: row.id, input: row.inputUsdPerMillion, output: row.outputUsdPerMillion, contextLength }];
  });
}

/** A generation as the lane answers it, read as untrusted input. */
interface DevGeneration {
  id: string;
  status: string;
  output: unknown;
  chargedCredits: number;
  error: string | null;
}

function readGeneration(body: unknown): DevGeneration | null {
  if (!isPlainRecord(body) || typeof body.id !== "string" || typeof body.status !== "string") return null;
  const charged = body.chargedCredits;
  return {
    id: body.id,
    status: body.status,
    output: body.output,
    chargedCredits: typeof charged === "number" && Number.isSafeInteger(charged) && charged >= 0 ? charged : 0,
    error: typeof body.error === "string" ? body.error : null,
  };
}

/** What an HTTP refusal from the lane answers a game with. */
function refusalOf(status: number, body: unknown): AiRefusal {
  const error = isPlainRecord(body) && typeof body.error === "string" ? body.error : "";
  if (status === 402 || error === "insufficient_balance") return new AiRefusal(AiErrorCode.OutOfCredits);
  if (status === 401 || status === 403) return new AiRefusal(AiErrorCode.DoorUnavailable);
  if (status === 429) return new AiRefusal(AiErrorCode.RateLimited, MINUTE_MS);
  if (status === 400 && error === "prompt_too_large") return new AiRefusal(AiErrorCode.TooLarge);
  return new AiRefusal(status >= 500 ? AiErrorCode.DoorUnavailable : AiErrorCode.Provider);
}

/** The text a finished generation gave: a string as it is, a JSON value as JSON. */
const outputText = (output: unknown): string => (typeof output === "string" ? output : JSON.stringify(output ?? ""));

/** The development lane's door. */
export function createGenexDevDoor(options: GenexDevDoorOptions): GameAiDoorImpl {
  return new GenexDevDoor(options);
}

class GenexDevDoor implements GameAiDoorImpl {
  readonly door = AiDoor.GenexDev;
  readonly #options: GenexDevDoorOptions;
  #models: { at: number; rows: DevModel[] } | null = null;

  constructor(options: GenexDevDoorOptions) {
    this.#options = options;
  }

  async readiness(): Promise<DoorReadiness> {
    const rows = (await this.#token()) ? await this.#rows() : [];
    const room = Math.max(0, ...rows.map((row) => row.contextLength));
    return { door: AiDoor.GenexDev, ready: rows.length > 0, json: true, loading: false, maxInputTokens: room };
  }

  async models(): Promise<AiModelRef[]> {
    if (!(await this.#token())) return [];
    return (await this.#rows()).map((row) => ({ door: AiDoor.GenexDev, engine: GENEX_ENGINE, model: row.id }));
  }

  worstCaseMicros(request: AiCallRequest, model: AiModelRef): number {
    const row = this.#models?.rows.find((entry) => entry.id === model.model);
    if (!row || model.door !== AiDoor.GenexDev) return Number.POSITIVE_INFINITY;
    const provider = promptTokensOf(request) * row.input + request.maxOutputTokens * row.output;
    // A whole credit at least, and whole credits: genex.games holds and charges whole credits.
    return Math.max(1, creditsOfMicros(Math.ceil(provider * STAND_RATE))) * MICROS_PER_CREDIT;
  }

  async run(call: AiDoorRequest, signal: AbortSignal): Promise<AiDoorAnswer> {
    const token = await this.#token();
    const project = await this.#options.projectOf(call.game);
    if (!token || !project) throw new AiRefusal(AiErrorCode.DoorUnavailable);
    const worst = this.worstCaseMicros(call.request, call.model);
    if (!Number.isFinite(worst)) throw new AiRefusal(AiErrorCode.DoorUnavailable);
    const created = await this.#options.request(DevRoute.generations(project), {
      method: "POST",
      token,
      body: { maxCredits: worst / MICROS_PER_CREDIT, request: this.#generationRequest(call) },
    });
    const first = readGeneration(created.body);
    if (created.status < 200 || created.status >= 300 || !first) throw refusalOf(created.status, created.body);
    const done = await this.#until(project, token, first, signal);
    if (done.status !== GenerationStatus.Succeeded) {
      throw new AiRefusal(FAILED_CODE[done.status] ?? AiErrorCode.Provider);
    }
    const text = outputText(done.output);
    return { text, model: call.model.model, usage: null, costMicros: done.chargedCredits * MICROS_PER_CREDIT };
  }

  /** The lane's request body for one attempt: the framed prompt as one text, the schema, the output budget. */
  #generationRequest(call: AiDoorRequest): Record<string, unknown> {
    const { request } = call;
    const suffix = call.repair ? REPAIR_SUFFIX : "";
    return {
      idempotencyKey: `${request.ticket.slice(0, IDEMPOTENCY_MAX - suffix.length)}${suffix}`,
      modelId: call.model.model,
      prompt: gameSingleText(call),
      outputFormat: request.schema === null ? "text" : "json",
      ...(request.schema === null ? {} : { schema: request.schema }),
      maxOutputTokens: request.maxOutputTokens,
    };
  }

  /** Poll a generation until it finishes, the call times out, or the signal aborts (it is canceled there too). */
  async #until(project: string, token: string, first: DevGeneration, signal: AbortSignal): Promise<DevGeneration> {
    const now = this.#options.now ?? Date.now;
    const deadline = now() + GAME_CALL_TIMEOUT_MS;
    let current = first;
    while (!(current.status in FAILED_CODE) && current.status !== GenerationStatus.Succeeded) {
      if (signal.aborted || now() > deadline) {
        await this.#cancel(project, token, current.id);
        throw new AiRefusal(signal.aborted ? AiErrorCode.Canceled : AiErrorCode.Timeout);
      }
      await sleep(this.#options.pollMs ?? POLL_MS, undefined, { signal }).catch(() => undefined);
      if (signal.aborted) continue;
      const answer = await this.#options.request(DevRoute.generation(project, current.id), { method: "GET", token });
      const next = readGeneration(answer.body);
      if (answer.status < 200 || answer.status >= 300 || !next) throw refusalOf(answer.status, answer.body);
      current = next;
    }
    return current;
  }

  async #cancel(project: string, token: string, id: string): Promise<void> {
    await this.#options.request(DevRoute.cancel(project, id), { method: "POST", token }).catch(() => undefined);
  }

  async #token(): Promise<string | undefined> {
    return this.#options.token().catch(() => undefined);
  }

  async #rows(): Promise<DevModel[]> {
    const now = (this.#options.now ?? Date.now)();
    if (this.#models && now - this.#models.at < MODELS_TTL_MS) return this.#models.rows;
    const answer = await this.#options.request(DevRoute.Models, { method: "GET" }).catch(() => null);
    const rows = answer && answer.status === 200 ? readDevModels(answer.body) : [];
    this.#models = { at: now, rows };
    return rows;
  }
}
