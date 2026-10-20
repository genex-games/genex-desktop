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
import { MINUTE_MS, SECOND_MS } from "../../../shared/duration.ts";
import {
  AiDoor,
  AiErrorCode,
  type AiCallRequest,
  type AiGameKey,
  type AiModelRef,
  type AiUsage,
  creditsOfMicros,
  GENEX_GUARD_CODES,
  isPlainRecord,
  MICROS_PER_CREDIT,
} from "../../../shared/game-ai.ts";
import type { DoorReadiness } from "../../../shared/game-ai-route.ts";
import type { GalleryAnswer, GalleryRequest } from "../../play/gallery.ts";
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

/** One model the lane serves, with its name and its catalog price per million tokens. */
interface DevModel {
  id: string;
  label: string | null;
  input: number;
  output: number;
  contextLength: number;
}

/** The longest model name the lane keeps. */
const LABEL_MAX = 120;

/** The development lane's door, and what the menu and the model check read of its catalog. */
export interface GenexDevDoor extends GameAiDoorImpl {
  /** A model's name as genex.games' catalog gives it; null before the catalog is read, or for a model it does not serve. */
  labelOf(model: string): string | null;
  /**
   * What `usage` on a model costs a player on Genex credits, in USD micros: its catalog price at
   * genex.games' rate, in whole credits; null for a model the catalog does not price.
   */
  priceMicros(model: string, usage: AiUsage): number | null;
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
  /** How long one request to genex.games may take before the lane reads as down ({@link DEV_CONNECT_DEADLINE_MS}). */
  connectMs?: number;
}

/**
 * How long one request to the lane (a create, a poll) may take before the door reads as down (§8:
 * network down is `door_unavailable` within 3 s). The generation itself runs on genex.games and is
 * polled, so a request is always a short one.
 */
export const DEV_CONNECT_DEADLINE_MS = 3 * SECOND_MS;

const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One catalog row as untrusted input, or null: an id, a full price, a generation model, featured when the catalog features. */
function readDevModel(row: unknown, featured: boolean): DevModel | null {
  if (!isPlainRecord(row) || typeof row.id !== "string" || !row.id || row.id.length > MODEL_ID_MAX) return null;
  if (!isPrice(row.inputUsdPerMillion) || !isPrice(row.outputUsdPerMillion)) return null;
  if (row.kind !== undefined && row.kind !== "openrouter") return null;
  if (featured && row.featured !== true) return null;
  const contextLength = typeof row.contextLength === "number" && row.contextLength > 0 ? row.contextLength : 0;
  const label = typeof row.label === "string" && row.label.trim() ? row.label.trim().slice(0, LABEL_MAX) : null;
  return { id: row.id, label, input: row.inputUsdPerMillion, output: row.outputUsdPerMillion, contextLength };
}

/** The catalog's models as untrusted input: a row without a full price is never offered. */
export function readDevModels(body: unknown): DevModel[] {
  const rows = isPlainRecord(body) && Array.isArray(body.models) ? body.models : [];
  const featured = isPlainRecord(body) && typeof body.featuredCount === "number" && body.featuredCount > 0;
  return rows.flatMap((row) => readDevModel(row, featured) ?? []);
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
  // Shared text genex.games would not return (D6) and a game it paused (D11): one table with the platform lane.
  const guarded = GENEX_GUARD_CODES[error];
  if (guarded) return new AiRefusal(guarded);
  if (status === 402 || error === "insufficient_balance") return new AiRefusal(AiErrorCode.OutOfCredits);
  if (status === 401 || status === 403) return new AiRefusal(AiErrorCode.DoorUnavailable);
  if (status === 429) return new AiRefusal(AiErrorCode.RateLimited, MINUTE_MS);
  if (status === 400 && error === "prompt_too_large") return new AiRefusal(AiErrorCode.TooLarge);
  return new AiRefusal(status >= 500 ? AiErrorCode.DoorUnavailable : AiErrorCode.Provider);
}

/** The text a finished generation gave: a string as it is, a JSON value as JSON. */
const outputText = (output: unknown): string => (typeof output === "string" ? output : JSON.stringify(output ?? ""));

/** What `input` and `output` tokens cost at genex.games' rate on `row`, in whole credits as micros. */
function standMicros(row: DevModel, input: number, output: number): number {
  const provider = input * row.input + output * row.output;
  // A whole credit at least, and whole credits: genex.games holds and charges whole credits.
  return Math.max(1, creditsOfMicros(Math.ceil(provider * STAND_RATE))) * MICROS_PER_CREDIT;
}

/** The development lane's door. */
export function createGenexDevDoor(options: GenexDevDoorOptions): GenexDevDoor {
  return new DevDoor(options);
}

class DevDoor implements GenexDevDoor {
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
    const row = this.#row(model.model);
    if (!row || model.door !== AiDoor.GenexDev) return Number.POSITIVE_INFINITY;
    return standMicros(row, promptTokensOf(request), request.maxOutputTokens);
  }

  labelOf(model: string): string | null {
    return this.#row(model)?.label ?? null;
  }

  priceMicros(model: string, usage: AiUsage): number | null {
    const row = this.#row(model);
    return row ? standMicros(row, usage.inputTokens, usage.outputTokens) : null;
  }

  /** The catalog's row for a model, as last read. */
  #row(model: string): DevModel | undefined {
    return this.#models?.rows.find((entry) => entry.id === model);
  }

  async run(call: AiDoorRequest, signal: AbortSignal): Promise<AiDoorAnswer> {
    const token = await this.#token();
    const project = await this.#options.projectOf(call.game);
    if (!token || !project) throw new AiRefusal(AiErrorCode.DoorUnavailable);
    const worst = this.worstCaseMicros(call.request, call.model);
    if (!Number.isFinite(worst)) throw new AiRefusal(AiErrorCode.DoorUnavailable);
    const created = await this.#send(DevRoute.generations(project), {
      method: "POST",
      token,
      body: { maxCredits: worst / MICROS_PER_CREDIT, request: this.#generationRequest(call) },
    });
    const first = readGeneration(created.body);
    if (created.status < 200 || created.status >= 300 || !first) throw refusalOf(created.status, created.body);
    const done = await this.#until(project, token, first, signal);
    if (done.status !== GenerationStatus.Succeeded) {
      const guarded = done.error === null ? undefined : GENEX_GUARD_CODES[done.error];
      throw new AiRefusal(guarded ?? FAILED_CODE[done.status] ?? AiErrorCode.Provider);
    }
    const text = outputText(done.output);
    return { text, model: call.model.model, usage: null, costMicros: done.chargedCredits * MICROS_PER_CREDIT };
  }

  /**
   * The lane's request body for one attempt: the framed prompt as one text, the schema, the output
   * budget, and who sees the answer — genex.games screens a shared one before it returns it (D6).
   */
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
      authority: request.authority,
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
      const answer = await this.#send(DevRoute.generation(project, current.id), { method: "GET", token });
      const next = readGeneration(answer.body);
      if (answer.status < 200 || answer.status >= 300 || !next) throw refusalOf(answer.status, answer.body);
      current = next;
    }
    return current;
  }

  /**
   * One request to the lane, held to {@link DEV_CONNECT_DEADLINE_MS}: a network that is down, a host
   * that never answers or a connection cut is the door down, never the provider's failure.
   */
  async #send(route: string, init: Parameters<GalleryRequest>[1]): Promise<GalleryAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AiRefusal(AiErrorCode.DoorUnavailable)),
        this.#options.connectMs ?? DEV_CONNECT_DEADLINE_MS,
      );
    });
    try {
      return await Promise.race([this.#options.request(route, init), late]);
    } catch {
      throw new AiRefusal(AiErrorCode.DoorUnavailable);
    } finally {
      clearTimeout(timer);
    }
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
