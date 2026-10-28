/** Engines and local models: what is available, re-checking sign-ins, and downloading or deleting a model. */
import { modelProgress } from "../model-progress.ts";
import { SUBSCRIPTION_ENGINES, type StudioCore } from "../studio-core.ts";
import { type ModelPullProgress, UiEvent } from "../../shared/ui-events.ts";
import type { ProviderUsageService } from "../core/provider-usage.ts";
import { isBonsaiModelId } from "../../substrate/bonsai/manifest.ts";
import { BonsaiEngine } from "../../substrate/engines/bonsai.ts";
import { LocalServerEngine } from "../../substrate/engines/local-server.ts";
import { detectHardware, fitFor } from "../../substrate/hardware.ts";
import { lookupOllamaModel } from "../../substrate/ollama-registry.ts";
import { hardwareReport } from "../core/hardware-report.ts";
import type { SubscriptionEngine } from "../login-controllers.ts";
import type { OpenRouterLogin } from "../openrouter-login.ts";
import type { IpcHandle } from "./registrar.ts";
import { CodedError, errorCodeIn, errorMessage } from "../../shared/errors.ts";
import { ModelInstallProblem, ModelPullProblem, ModelPullStatus } from "../../shared/model-install.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { EngineError } from "../../substrate/engines/types.ts";
import { t } from "../../shared/i18n.ts";
import { EngineId } from "../../shared/providers.ts";
import { type EngineStatus, EngineStatusCode } from "../../shared/engine-descriptor.ts";

/** The engines whose model list Settings may ask to refresh. */
const REFRESHABLE: ReadonlySet<string> = new Set([
  EngineId.ClaudeCode,
  EngineId.Codex,
  EngineId.OpenCode,
  EngineId.Grok,
  EngineId.Cursor,
  EngineId.OpenRouter,
  EngineId.LocalServer,
]);
/** The engines with no subscription sign-in: a recheck reads their models (and status) again. */
const RECHECKED_BY_MODELS: readonly string[] = [
  EngineId.OpenCode,
  EngineId.Grok,
  EngineId.Cursor,
  EngineId.OpenRouter,
  EngineId.LocalServer,
];

/** An engine whose API key is pasted in Settings (OpenRouter). */
interface ApiKeyEngine {
  saveKey(value: unknown): Promise<EngineStatus>;
  clearKey(): Promise<EngineStatus>;
}

const isApiKeyEngine = (engine: unknown): engine is ApiKeyEngine =>
  typeof (engine as Partial<ApiKeyEngine> | null)?.saveKey === "function" &&
  typeof (engine as Partial<ApiKeyEngine> | null)?.clearKey === "function";

/**
 * Why a local model request from the renderer is refused. The functions are words the person reads
 * in Settings; `unknownProvider` and `noModel` answer only a malformed call from our own renderer.
 */
/** Why an Ollama pull failed: the server gone or unable, a refusal it answered, or a stream cut short. */
function pullProblem(err: unknown): ModelPullProblem {
  if (!(err instanceof EngineError)) return ModelPullProblem.Interrupted;
  return err.kind === EngineFailureKind.Unavailable ? ModelPullProblem.Unavailable : ModelPullProblem.Refused;
}

const MESSAGE = {
  unknownProvider: "Unknown coding provider",
  noKeyEngine: () => t("OpenRouter is unavailable"),
  noLocalServer: () => t("Local servers are unavailable"),
  bonsaiUnavailable: () => t("Bonsai runtime is unavailable"),
  noModel: "Name the model to delete",
  cannotRemove: () => t("This model cannot be deleted here"),
} as const;

export interface ModelsIpcDeps {
  core: Pick<StudioCore, "engines">;
  subscription(id: string): SubscriptionEngine | null;
  pushUiEvent(event: UiEvent): void;
  /** OpenRouter's browser sign-in, which hands the key it gets to the engine. */
  openRouterLogin: OpenRouterLogin;
  /** The person's key changed (a new one kept, or the old one forgotten): play-time AI stops every grant that named it. */
  payerChanged?(engine: string): void;
  /** The subscriptions' plan limits, kept live (`core/provider-usage.ts`). */
  usage: Pick<ProviderUsageService, "snapshot" | "refresh">;
}

export function registerModelsIpc(
  handle: IpcHandle,
  { core, subscription, pushUiEvent, openRouterLogin, usage, payerChanged = () => {} }: ModelsIpcDeps,
): void {
  handle("studio:engines", async () => core.engines.describe());
  handle("studio:models.refresh", async (payload) => {
    const provider = payload?.provider;
    if (typeof provider !== "string" || !REFRESHABLE.has(provider) || !core.engines.has(provider))
      throw new Error(MESSAGE.unknownProvider);
    await core.engines.get(provider).refreshModels?.(true);
    return true;
  });
  registerApiKeyIpc(handle, { core, pushUiEvent, openRouterLogin, payerChanged });
  registerLocalServerIpc(handle, { core, pushUiEvent });
  // The plan limits as they stand, at once; a fresh read starts, and each subscription's answer
  // arrives as a `provider.usage` push.
  handle("studio:provider-usage", async () => {
    void usage.refresh().catch(() => {});
    return usage.snapshot();
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
    if (!engine?.removeModel) throw new Error(MESSAGE.cannotRemove());
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
      if (!(engine instanceof BonsaiEngine)) throw new Error(MESSAGE.bonsaiUnavailable());
      const unsubscribe = engine.runtime.onInstall((job) => pushUiEvent({ type: UiEvent.ModelInstall, payload: job }));
      try {
        await engine.runtime.install(payload.model, progressUpdates.update);
        progressUpdates.flush();
        pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.Bonsai } });
        return true;
      } catch (err) {
        progressUpdates.flush();
        const problem = errorCodeIn(ModelInstallProblem, err) ?? ModelInstallProblem.Other;
        pushUiEvent({
          type: UiEvent.ModelPull,
          payload: {
            model: payload.model,
            progress: { status: ModelPullStatus.Error, error: errorMessage(err), problem },
          },
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
    } catch (err) {
      throw new CodedError(pullProblem(err), errorMessage(err));
    } finally {
      progressUpdates.flush();
    }
    return true;
  });
}

/**
 * The OpenRouter key, pasted or got by the browser sign-in: checked with OpenRouter, kept in the OS
 * secret store, never sent back.
 */
function registerApiKeyIpc(
  handle: IpcHandle,
  {
    core,
    pushUiEvent,
    openRouterLogin,
    payerChanged,
  }: Pick<ModelsIpcDeps, "core" | "pushUiEvent" | "openRouterLogin"> & { payerChanged(engine: string): void },
): void {
  const keyEngine = (): ApiKeyEngine => {
    const engine = core.engines.has(EngineId.OpenRouter) ? core.engines.get(EngineId.OpenRouter) : null;
    if (!isApiKeyEngine(engine)) throw new Error(MESSAGE.noKeyEngine());
    return engine;
  };
  // A key that is kept (the engine answers ready with it) or forgotten is a new payer; a refused one changes nothing.
  const saveKey = async (key: unknown): Promise<EngineStatus> => {
    const status = await keyEngine().saveKey(key);
    if (status.code === EngineStatusCode.Ready) payerChanged(EngineId.OpenRouter);
    return status;
  };
  handle("studio:openrouter.key.save", async (payload) => {
    const status = await saveKey(payload?.key);
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.OpenRouter } });
    return status;
  });
  handle("studio:openrouter.key.clear", async () => {
    const status = await keyEngine().clearKey();
    payerChanged(EngineId.OpenRouter);
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.OpenRouter } });
    return status;
  });
  handle("studio:openrouter.signin", async () => {
    const result = await openRouterLogin.start(saveKey);
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.OpenRouter } });
    return result;
  });
  handle("studio:openrouter.signin.reopen", async () => openRouterLogin.reopen());
  handle("studio:openrouter.signin.cancel", async () => openRouterLogin.cancel());
}

/**
 * The person's own model server: connect it (its address checked as local, its key kept in the OS
 * secret store, neither saved unless the server answers), forget it, or find one on this computer.
 */
function registerLocalServerIpc(
  handle: IpcHandle,
  { core, pushUiEvent }: Pick<ModelsIpcDeps, "core" | "pushUiEvent">,
): void {
  const localServer = (): LocalServerEngine => {
    const engine = core.engines.has(EngineId.LocalServer) ? core.engines.get(EngineId.LocalServer) : null;
    if (!(engine instanceof LocalServerEngine)) throw new Error(MESSAGE.noLocalServer());
    return engine;
  };
  const changed = (): void => pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.LocalServer } });
  handle("studio:local-server.connect", async (payload) => {
    const result = await localServer().connect({ url: payload?.url, key: payload?.key });
    if (result.ok) changed();
    return result;
  });
  handle("studio:local-server.forget", async () => {
    const status = await localServer().forget();
    changed();
    return status;
  });
  handle("studio:local-server.find", async () => localServer().find());
}
