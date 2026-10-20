/**
 * Play-time AI's channels: the AI pill's menu, picks and cards, Settings → Play-time AI and its
 * Games list, saved playtests, Reports, the model check, Publish's facts and Get credits. Every
 * payload is read here with the shared readers before the host sees it; the host resolves a
 * project through the library by realpath, and asserts the native step before a card's yes spends
 * plan or money (`GameAiNativeStep`).
 */
import { readAiGameKey } from "../../shared/game-ai.ts";
import {
  readAiConsentAnswer,
  readAiCreditProduct,
  readAiModelRef,
  readAiPause,
  readAiReportRequest,
  readGameAiSettingsPatch,
} from "../../shared/game-ai-views.ts";
import type { GameAiIpcHost } from "../game-ai/types.ts";
import type { IpcHandle } from "./registrar.ts";

const MESSAGE = {
  badGame: "not a game play-time AI knows",
  badModel: "not a model",
  badAnswer: "not an answer to a card",
  badSwitch: "not on or off",
  badSettings: "not a change Settings makes",
  badProject: "not a game in the library",
  badReport: "not a report",
  badProduct: "not something Get credits sells",
  badPause: "not a pause a game waits in",
} as const;

/** The longest library name a channel takes. */
const PROJECT_MAX_CHARS = 255;
/** A library name: one folder name, never a path, a dot segment or a control character. */
const PROJECT_RE = /^[^\p{Cc}/\\]+$/u;

/** Whether a name is one folder's name, as the library keeps them. */
const isLibraryName = (name: string): boolean =>
  name.length <= PROJECT_MAX_CHARS && PROJECT_RE.test(name) && name !== "." && name !== ".." && name.trim() === name;

/** A library game's name from the renderer, or a refusal. */
function projectOf(raw: unknown): string {
  if (typeof raw !== "string" || !isLibraryName(raw)) throw new Error(MESSAGE.badProject);
  return raw;
}

/** A game key from the renderer, or a refusal. */
function gameOf(raw: unknown) {
  const game = readAiGameKey(raw);
  if (!game) throw new Error(MESSAGE.badGame);
  return game;
}

/** A model from the renderer, or a refusal. */
function modelOf(raw: unknown) {
  const model = readAiModelRef(raw);
  if (!model) throw new Error(MESSAGE.badModel);
  return model;
}

/** Register play-time AI's channels over its host. */
export function registerGameAiIpc(handle: IpcHandle, host: GameAiIpcHost): void {
  handle("studio:game-ai.menu", async (payload) => host.menu(gameOf(payload?.game)));
  handle("studio:game-ai.pick", async (payload) => host.pick(gameOf(payload?.game), modelOf(payload?.model)));
  handle("studio:game-ai.answer", async (payload) => {
    const answer = readAiConsentAnswer(payload);
    if (!answer) throw new Error(MESSAGE.badAnswer);
    return host.answer(answer);
  });
  handle("studio:game-ai.enable", async (payload) => {
    if (typeof payload?.enabled !== "boolean") throw new Error(MESSAGE.badSwitch);
    return host.enable(gameOf(payload.game), payload.enabled);
  });
  handle("studio:game-ai.activity", async () => host.activity());
  handle("studio:game-ai.settings", async () => host.settings());
  handle("studio:game-ai.settings.save", async (payload) => {
    const patch = readGameAiSettingsPatch(payload?.patch);
    if (!patch) throw new Error(MESSAGE.badSettings);
    return host.saveSettings(patch);
  });
  handle("studio:game-ai.tapes", async (payload) => host.tapes(projectOf(payload?.project)));
  handle("studio:game-ai.report.preview", async (payload) => host.reportPreview(gameOf(payload?.game)));
  handle("studio:game-ai.report", async (payload) => {
    const request = readAiReportRequest(payload);
    if (!request) throw new Error(MESSAGE.badReport);
    return host.report(request);
  });
  registerCheckIpc(handle, host);
  handle("studio:game-ai.credits", async () => host.credits());
  handle("studio:game-ai.checkout", async (payload) => {
    const product = readAiCreditProduct(payload?.product);
    if (!product) throw new Error(MESSAGE.badProduct);
    return host.checkout(product);
  });
  handle("studio:game-ai.resume", async (payload) => {
    const pause = readAiPause(payload?.pause);
    if (!pause) throw new Error(MESSAGE.badPause);
    return host.resume(gameOf(payload?.game), pause);
  });
}

/** The model check's channels and Publish's facts. */
function registerCheckIpc(handle: IpcHandle, host: GameAiIpcHost): void {
  handle("studio:game-ai.check", async (payload) => host.check(projectOf(payload?.project)));
  handle("studio:game-ai.check.state", async (payload) => host.checkState(projectOf(payload?.project)));
  handle("studio:game-ai.check.stop", async (payload) => host.checkStop(projectOf(payload?.project)));
  handle("studio:game-ai.recommend", async (payload) => {
    const model = payload?.model === null ? null : modelOf(payload?.model);
    return host.recommend(projectOf(payload?.project), model);
  });
  handle("studio:game-ai.publish-facts", async (payload) => host.publishFacts(projectOf(payload?.project)));
}
