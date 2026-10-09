/** Engines and local models: what is available, re-checking sign-ins, and downloading or deleting a model. */
import { modelProgress } from "../model-progress.ts";
import { SUBSCRIPTION_ENGINES, type StudioCore } from "../studio-core.ts";
import { type ModelPullProgress, UiEvent } from "../../shared/ui-events.ts";
import type { ProviderUsageReport } from "../../shared/provider-usage.ts";
import { isBonsaiModelId } from "../../substrate/bonsai/manifest.ts";
import { BonsaiEngine } from "../../substrate/engines/bonsai.ts";
import { detectHardware, fitFor } from "../../substrate/hardware.ts";
import { lookupOllamaModel } from "../../substrate/ollama-registry.ts";
import { hardwareReport } from "../core/hardware-report.ts";
import type { SubscriptionEngine } from "../login-controllers.ts";
import type { IpcHandle } from "./registrar.ts";
import { errorMessage } from "../../shared/errors.ts";
import { EngineId } from "../../shared/providers.ts";
import { type EngineStatus, EngineStatusCode } from "../../shared/engine-descriptor.ts";

/** The engines whose model list Settings may ask to refresh. */
const REFRESHABLE: ReadonlySet<string> = new Set([
  EngineId.ClaudeCode,
  EngineId.Codex,
  EngineId.OpenCode,
  EngineId.OpenRouter,
]);
/** The engines with no subscription sign-in: a recheck reads their models (and status) again. */
const RECHECKED_BY_MODELS: readonly string[] = [EngineId.OpenCode, EngineId.OpenRouter];

/** An engine whose API key is pasted in Settings (OpenRouter). */
interface ApiKeyEngine {
  saveKey(value: unknown): Promise<EngineStatus>;
  clearKey(): Promise<EngineStatus>;
}

const isApiKeyEngine = (engine: unknown): engine is ApiKeyEngine =>
  typeof (engine as Partial<ApiKeyEngine> | null)?.saveKey === "function" &&
  typeof (engine as Partial<ApiKeyEngine> | null)?.clearKey === "function";

/** Why a local model request from the renderer is refused. */
const MESSAGE = {
  unknownProvider: "Unknown coding provider",
  noKeyEngine: "OpenRouter is unavailable",
  bonsaiUnavailable: "Bonsai runtime is unavailable",
  noModel: "Name the model to delete",
  cannotRemove: "This model cannot be deleted here",
} as const;

export interface ModelsIpcDeps {
  core: Pick<StudioCore, "engines">;
  subscription(id: string): SubscriptionEngine | null;
  pushUiEvent(event: UiEvent): void;
}

export function registerModelsIpc(handle: IpcHandle, { core, subscription, pushUiEvent }: ModelsIpcDeps): void {
  handle("studio:engines", async () => core.engines.describe());
  handle("studio:models.refresh", async (payload) => {
    const provider = payload?.provider;
    if (typeof provider !== "string" || !REFRESHABLE.has(provider) || !core.engines.has(provider))
      throw new Error(MESSAGE.unknownProvider);
    await core.engines.get(provider).refreshModels?.(true);
    return true;
  });
  registerApiKeyIpc(handle, { core, pushUiEvent });
  // The composer's plan limits: every signed-in subscription, read without starting a turn.
  handle("studio:provider-usage", async () => {
    const reports = await Promise.all(
      SUBSCRIPTION_ENGINES.map(async (id): Promise<ProviderUsageReport | null> => {
        if (!core.engines.has(id)) return null;
        const engine = core.engines.get(id);
        if ((await engine.status().catch(() => null))?.code !== EngineStatusCode.Ready) return null;
        return { engine: id, usage: (await engine.readUsage?.().catch(() => null)) ?? null };
      }),
    );
    return reports.filter((report): report is ProviderUsageReport => report !== null);
  });
  handle("studio:hardware", async () => hardwareReport());
  handle("studio:engines.recheck", async (payload) => {
    const ids = payload?.engine ? [payload.engine] : [...SUBSCRIPTION_ENGINES, ...RECHECKED_BY_MODELS];
    for (const id of ids) {
      const engine = subscription(id);
      if (engine) await engine.recheckLogin();
      else if (RECHECKED_BY_MODELS.includes(id) && core.engines.has(id))
        await core.engines
          .get(id)
          .refreshModels?.(true)
          .catch(() => {});
    }
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} });
    return true;
  });

  handle("studio:model-install.status", async () => {
    const engine = core.engines.has(EngineId.Bonsai) ? core.engines.get(EngineId.Bonsai) : null;
    return engine instanceof BonsaiEngine ? engine.runtime.installStatus() : null;
  });
  handle("studio:cancel-model-download", async () => {
    const engine = core.engines.has(EngineId.Bonsai) ? core.engines.get(EngineId.Bonsai) : null;
    if (engine instanceof BonsaiEngine) engine.runtime.cancelInstall();
    return true;
  });
  // Add from Ollama: size one exact tag from the public registry, then judge it with the same fit rule.
  handle("studio:models.lookup", async (payload) => {
    const found = await lookupOllamaModel(String(payload?.model ?? ""));
    return found.ok ? { ...found, ...fitFor(found.sizeGb, await detectHardware()) } : found;
  });
  // Delete: Bonsai ids go to the managed runtime, every other name to Ollama, which lists what it has.
  handle("studio:models.remove", async (payload) => {
    const model = payload?.model;
    if (typeof model !== "string" || !model) throw new Error(MESSAGE.noModel);
    const id = isBonsaiModelId(model) ? EngineId.Bonsai : EngineId.Ollama;
    const engine = core.engines.has(id) ? core.engines.get(id) : null;
    if (!engine?.removeModel) throw new Error(MESSAGE.cannotRemove);
    await engine.removeModel(model);
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: id } });
    return true;
  });
  handle("studio:pull-model", async (payload) => {
    const progressUpdates = modelProgress((progress) =>
      pushUiEvent({ type: UiEvent.ModelPull, payload: { model: payload.model, progress } }),
    );
    if (isBonsaiModelId(payload.model)) {
      const engine = core.engines.get(EngineId.Bonsai);
      if (!(engine instanceof BonsaiEngine)) throw new Error(MESSAGE.bonsaiUnavailable);
      const unsubscribe = engine.runtime.onInstall((job) => pushUiEvent({ type: UiEvent.ModelInstall, payload: job }));
      try {
        await engine.runtime.install(payload.model, progressUpdates.update);
        progressUpdates.flush();
        pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.Bonsai } });
        return true;
      } catch (err) {
        progressUpdates.flush();
        pushUiEvent({
          type: UiEvent.ModelPull,
          payload: { model: payload.model, progress: { status: "error", error: errorMessage(err) } },
        });
        throw err;
      } finally {
        unsubscribe();
      }
    }
    const engine = core.engines.get(EngineId.Ollama) as unknown as {
      client: { pull: (m: string) => AsyncGenerator<ModelPullProgress> };
    };
    try {
      for await (const progress of engine.client.pull(payload.model)) progressUpdates.update(progress);
    } finally {
      progressUpdates.flush();
    }
    return true;
  });
}

/** The OpenRouter key: checked with OpenRouter, kept in the OS secret store, never sent back. */
function registerApiKeyIpc(
  handle: IpcHandle,
  { core, pushUiEvent }: Pick<ModelsIpcDeps, "core" | "pushUiEvent">,
): void {
  const keyEngine = (): ApiKeyEngine => {
    const engine = core.engines.has(EngineId.OpenRouter) ? core.engines.get(EngineId.OpenRouter) : null;
    if (!isApiKeyEngine(engine)) throw new Error(MESSAGE.noKeyEngine);
    return engine;
  };
  handle("studio:openrouter.key.save", async (payload) => {
    const status = await keyEngine().saveKey(payload?.key);
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.OpenRouter } });
    return status;
  });
  handle("studio:openrouter.key.clear", async () => {
    const status = await keyEngine().clearKey();
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.OpenRouter } });
    return status;
  });
}
