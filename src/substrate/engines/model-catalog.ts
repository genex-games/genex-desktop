import { SECOND_MS } from "../../shared/duration.ts";
import {
  ModelCatalogState,
  ModelCatalogSource,
  ModelCatalogProblemCode,
  type ModelCatalogStatus,
} from "../../shared/model-catalog.ts";
import type { EngineModel } from "./types.ts";

const FRESH_MS = 60 * SECOND_MS;
export const CATALOG_DEADLINE_MS = 10 * SECOND_MS;
/** A discovery error with a safe, user-facing explanation. */
export class CatalogError extends Error {
  readonly code: ModelCatalogProblemCode;
  constructor(code: ModelCatalogProblemCode, message: string) {
    super(message);
    this.code = code;
  }
}
/** One complete discovery result; partial pages must never be published. */
export interface CatalogResult {
  models: EngineModel[];
  source: ModelCatalogSource;
}
/** Coalesced, identity-scoped catalog snapshots with injectable time. */
export class ModelCatalog {
  #identity = "";
  #epoch = 0;
  #attemptedAt = -Infinity;
  #pending: Promise<void> | undefined;
  /** The newest read started; a forced refresh starts one while an older read still runs. */
  #reading = 0;
  #models: EngineModel[] = [];
  #status: ModelCatalogStatus = { state: ModelCatalogState.Loading, revision: 0, refreshing: false };
  readonly #changed: () => void;
  readonly #now: () => number;
  constructor(changed: () => void = () => {}, now = Date.now) {
    this.#changed = changed;
    this.#now = now;
  }
  snapshot(): ModelCatalogStatus {
    return { ...this.#status };
  }
  models(): EngineModel[] {
    return this.#models;
  }
  epoch(): number {
    return this.#epoch;
  }
  invalidate(): void {
    this.#epoch++;
    this.#pending = undefined;
    this.#attemptedAt = -Infinity;
    this.#status = {
      ...this.#status,
      state: this.#models.length ? ModelCatalogState.Stale : ModelCatalogState.Loading,
      refreshing: false,
    };
  }
  publish(result: CatalogResult, epoch = this.#epoch, notify = true): void {
    if (epoch !== this.#epoch) return;
    const changed = JSON.stringify(this.#models) !== JSON.stringify(result.models);
    this.#models = result.models;
    this.#status = {
      state: result.source === ModelCatalogSource.Cache ? ModelCatalogState.Stale : ModelCatalogState.Ready,
      revision: this.#status.revision + 1,
      refreshing: false,
      source: result.source,
      refreshedAt: this.#now(),
    };
    if (changed && notify) this.#changed();
  }
  refresh(identity: string, read: () => Promise<CatalogResult>, force = false): Promise<void> {
    if (identity !== this.#identity) {
      this.invalidate();
      this.#identity = identity;
      this.#models = [];
      this.#status = { state: ModelCatalogState.Loading, revision: this.#status.revision + 1, refreshing: false };
    }
    if (this.#pending && !force) return this.#pending;
    if (!force && this.#now() - this.#attemptedAt < FRESH_MS) return Promise.resolve();
    const epoch = this.#epoch;
    // A forced read follows a change (a sign-in): a read still running may have started before it,
    // so only the newest read's answer lands.
    const reading = ++this.#reading;
    this.#attemptedAt = this.#now();
    this.#status = { ...this.#status, refreshing: true };
    this.#pending = this.#read(read, epoch, reading).finally(() => {
      if (!this.#current(epoch, reading)) return;
      this.#pending = undefined;
      this.#changed();
    });
    this.#changed();
    return this.#pending;
  }
  /** Whether a read still speaks for the catalog: same account, and no newer read started since. */
  #current(epoch: number, reading: number): boolean {
    return epoch === this.#epoch && reading === this.#reading;
  }
  async #read(read: () => Promise<CatalogResult>, epoch: number, reading: number): Promise<void> {
    try {
      const result = await read();
      if (reading === this.#reading) this.publish(result, epoch, false);
    } catch (error) {
      if (!this.#current(epoch, reading)) return;
      const problem =
        error instanceof CatalogError
          ? error
          : new CatalogError(ModelCatalogProblemCode.Provider, "Could not refresh models. Try again.");
      this.#status = {
        ...this.#status,
        state: this.#models.length ? ModelCatalogState.Stale : ModelCatalogState.Unavailable,
        refreshing: false,
        problem: { code: problem.code, message: problem.message },
      };
    }
  }
}
