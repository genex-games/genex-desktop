/**
 * Engine registry + fallback policy
 * ("a run survives a rate-limit by falling back to local").
 *
 * The registry is substrate; *when* to fall back is harness policy, so this exposes the decision
 * rather than making it: {@link EngineRegistry.fallbackFor} answers "if this engine just failed
 * this way, what could take over?", and the harness decides whether to pause or switch.
 */
import type { Engine, EngineError, EngineModel } from "./types.ts";
import { EngineKind, EngineStatusCode, type EngineDescriptor } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { isMetered, providerInfo } from "../../shared/providers.ts";
import { SECOND_MS } from "../../shared/duration.ts";

/** What the UI reads about an engine is a contract; it lives in `shared/engine-descriptor.ts`. */
export type { EngineDescriptor } from "../../shared/engine-descriptor.ts";

const MESSAGE = {
  UnknownEngine: (id: string) => `unknown engine: ${id}`,
} as const;

/** How long a fallback choice waits on one engine's status before counting it not ready. */
const STATUS_PROBE_MS = 5 * SECOND_MS;

/** What a failed call needs from the engine that takes it over. */
export interface FallbackNeeds {
  /** The call carries tools: only an engine whose complete() runs them may take it. */
  tools?: boolean;
}

export class EngineRegistry {
  readonly #engines = new Map<string, Engine>();
  readonly #statusProbeMs: number;
  #preferredOrder: string[] = [];
  #active = new Map<string, number>();
  #updating = new Set<string>();

  constructor({ statusProbeMs = STATUS_PROBE_MS }: { statusProbeMs?: number } = {}) {
    this.#statusProbeMs = statusProbeMs;
  }

  /** Is this engine ready, asked with a deadline: a status that hangs or throws is not ready. */
  async #readyWithin(engine: Engine): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.#statusProbeMs);
    });
    try {
      const status = await Promise.race([engine.status().catch(() => null), late]);
      return status?.code === EngineStatusCode.Ready;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The engines in preference order that pass `keep`, each asked whether it is ready, side by side.
   * A metered engine is never among them: a choice the app makes on its own never spends credits.
   */
  async #readyInOrder(keep: (engine: Engine) => boolean): Promise<Engine[]> {
    const engines = this.#preferredOrder
      .map((id) => this.#engines.get(id))
      .filter((engine): engine is Engine => Boolean(engine) && !isMetered(engine?.id) && keep(engine as Engine));
    const ready = await Promise.all(engines.map((engine) => this.#readyWithin(engine)));
    return engines.filter((_, index) => ready[index]);
  }

  register(engine: Engine): void {
    for (const key of ["complete", "delegate", "readUsage", "refreshModels"] as const) this.#guard(engine, key);
    this.#engines.set(engine.id, engine);
    if (!this.#preferredOrder.includes(engine.id)) this.#preferredOrder.push(engine.id);
  }

  #guard<K extends "complete" | "delegate" | "readUsage" | "refreshModels">(engine: Engine, key: K): void {
    const original = engine[key];
    if (!original) return;
    // Each method retains its own argument/result contract while sharing the update lease.
    engine[key] = (async (...args: unknown[]) => {
      if (this.#updating.has(engine.id)) throw new Error("Wait for the CLI update to finish.");
      this.#active.set(engine.id, (this.#active.get(engine.id) ?? 0) + 1);
      try {
        return await Reflect.apply(original, engine, args);
      } finally {
        this.#active.set(engine.id, (this.#active.get(engine.id) ?? 1) - 1);
      }
    }) as Engine[K];
  }

  /** Updates cannot overlap a provider operation or admit new work while running. */
  async maintain<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.#updating.has(id) || this.#active.get(id))
      throw new Error("Wait for active provider work to finish before updating.");
    this.#updating.add(id);
    try {
      return await operation();
    } finally {
      this.#updating.delete(id);
    }
  }

  get(id: string): Engine {
    const engine = this.#engines.get(id);
    if (!engine) throw new Error(MESSAGE.UnknownEngine(id));
    return engine;
  }

  has(id: string): boolean {
    return this.#engines.has(id);
  }

  ids(): string[] {
    return [...this.#engines.keys()];
  }

  all(): Engine[] {
    return [...this.#engines.values()];
  }

  /** Full picture for the UI: what exists, whether it is usable, and what it can run. */
  async describe(): Promise<EngineDescriptor[]> {
    return Promise.all(
      [...this.#engines.values()].map(async (engine): Promise<EngineDescriptor> => {
        const status = await engine.status().catch((err: Error) => ({
          code: EngineStatusCode.Error,
          detail: err.message,
        }));
        const models = await engine.models().catch(() => []);
        return {
          id: engine.id,
          label: engine.label,
          kind: engine.kind,
          supportsSessions: engine.supportsSessions ?? typeof engine.delegate === "function",
          compactsNatively: engine.compactsNatively === true,
          status,
          usage: engine.usageSnapshot?.() ?? null,
          catalog: engine.catalogSnapshot?.(),
          ...(engine.account ? { account: await engine.account().catch(() => null) } : {}),
          provider: providerInfo(engine.id) ?? null,
          models: models.map(describedModel),
          defaultModel: (await engine.defaultModel?.()) ?? null,
        };
      }),
    );
  }

  /**
   * Candidate replacements for a failed engine, best first. `needs` names what the failed call
   * asked of its engine; a candidate that cannot do it is never offered.
   *
   * Rate limits are the case that matters in v1: subscriptions throttle server-side and there is
   * no bill to cap, so the right answer is to keep building on the local engine rather than to
   * stop the run.
   */
  async fallbackFor(failed: string, error: Pick<EngineError, "kind">, needs: FallbackNeeds = {}): Promise<string[]> {
    if (error.kind === EngineFailureKind.ContextOverflow || error.kind === EngineFailureKind.Auth) return [];
    // A local engine is the only fallback that cannot itself be rate limited, and the only one
    // whose complete() runs a tool loop: a delegated engine's refuses tools.
    const directOnly = error.kind === EngineFailureKind.RateLimit || needs.tools === true;
    const ready = await this.#readyInOrder(
      (engine) => engine.id !== failed && (!directOnly || engine.kind === EngineKind.Direct),
    );
    return ready.map((engine) => engine.id);
  }

  /** Preference order for automatic choices; the user's explicit pick always wins. */
  setPreferredOrder(ids: string[]): void {
    this.#preferredOrder = [...ids, ...this.#preferredOrder.filter((id) => !ids.includes(id))];
  }

  async firstReady(kind?: EngineKind): Promise<Engine | null> {
    const ready = await this.#readyInOrder((engine) => kind === undefined || engine.kind === kind);
    return ready[0] ?? null;
  }
}

/** A model as the UI sees it: its identity, capabilities and what the picker needs to list it. */
function describedModel(m: EngineModel): EngineDescriptor["models"][number] {
  return {
    id: m.id,
    label: m.label,
    resolvedModel: m.resolvedModel,
    ...(m.providerDefault ? { providerDefault: true } : {}),
    contextWindow: m.contextWindow,
    supportsFast: m.supportsFast,
    supportsTools: m.supportsTools,
    supportsVision: m.supportsVision,
    ...(m.stale ? { stale: true } : {}),
    ...(m.aliasOf ? { aliasOf: m.aliasOf } : {}),
    ...(m.note ? { note: m.note } : {}),
    ...(m.efforts !== undefined ? { efforts: m.efforts } : {}),
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
  };
}
