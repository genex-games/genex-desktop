/**
 * First launch's other ways to build, as pure decisions: the row under the subscriptions (local
 * models, OpenRouter, OpenCode), what each of its buttons says, and the step OpenRouter's and
 * OpenCode's screens are at. The screens render these; they never work them out again.
 */
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { t } from "../../shared/i18n.ts";
import { EngineId } from "../../shared/providers.ts";
import { defaultModelKey } from "../model-choices.ts";
import { modelKey } from "../model-key.ts";
import { OpenCodeRowState } from "../panels/opencode-row.ts";
import type { EngineDescriptor } from "../types.ts";
import { ChipState, MarkState } from "./art.ts";

/** The row's three ways, in the order its buttons stand. */
export const OtherWay = {
  Local: "local",
  OpenRouter: "openrouter",
  OpenCode: "opencode",
} as const;
export type OtherWay = (typeof OtherWay)[keyof typeof OtherWay];
export const OTHER_WAYS: readonly OtherWay[] = [OtherWay.Local, OtherWay.OpenRouter, OtherWay.OpenCode];

/** How a way's button looks: its offer, something under way, or ready to build with. */
export const WayState = { Idle: "idle", Busy: "busy", On: "on" } as const;
export type WayState = (typeof WayState)[keyof typeof WayState];

/** One way's button: its look, its words, and the line under the row while it is pointed at. */
export interface WayView {
  state: WayState;
  label: string;
  hint: string;
}

/** The row's and the two screens' words. */
export const WAYS_WORDS = {
  lead: t("or use"),
  local: {
    name: t("Local models"),
    hint: t("Free and private. Runs on this Mac."),
    downloading: (model: string, percent: number) => t("Downloading {model} · {percent}%", { model, percent }),
    ready: (model: string) => t("{model} ready", { model }),
  },
  openRouter: {
    name: "OpenRouter",
    hint: t("One key for hundreds of models. Pay as you go."),
    signingIn: t("OpenRouter · finish in your browser"),
    on: t("OpenRouter connected"),
    onHint: t("Billed to your OpenRouter credits."),
    title: t("Connect OpenRouter"),
    lede: t("One account for hundreds of models. You pay OpenRouter for what you use."),
    connect: t("Connect OpenRouter"),
    connectNote: t("Opens OpenRouter in your browser. Approve Genex there and you're back here."),
    pasteInstead: t("Paste a key instead"),
    browser: t("Finish in your browser"),
    browserNote: t("Approve Genex on OpenRouter. This screen moves on by itself."),
    openAgain: t("Open the page again"),
    cancel: t("Cancel sign-in"),
    keyLabel: t("OpenRouter API key"),
    keyPlaceholder: "sk-or-…",
    save: t("Connect"),
    checking: t("Checking the key…"),
    getKey: t("Get a key"),
    keyNote: t("The key is checked with OpenRouter, then kept on this Mac."),
    browserInstead: t("Connect in the browser instead"),
    refused: t("OpenRouter didn't accept that key. Check it and paste it again."),
    connectedNote: t("Billed to your OpenRouter credits. Pick any of its models in the model menu."),
  },
  openCode: {
    name: "OpenCode",
    hint: t("Free models to start, or any provider you sign in to."),
    installing: t("Setting up OpenCode…"),
    ready: t("OpenCode ready"),
    readyHint: t("Free models. Sign in to a provider for stronger ones."),
    on: t("OpenCode connected"),
    onHint: t("Billed by each provider you use."),
    title: t("Connect OpenCode"),
    lede: t("Start free with OpenCode's own models, or sign in to a provider you already use."),
    signInTitle: t("Sign in to a provider"),
    signInLede: t("OpenCode asks a few questions below. Choose with ↑ ↓ and press Return."),
    setUp: t("Set up OpenCode"),
    setUpNote: t("Installs OpenCode on this Mac. This can take a minute."),
    checkAgain: t("Already installed? Check again"),
    checking: t("Checking…"),
    readyStatus: t("OpenCode ready · free models"),
    readyNote: t("Free models are smaller and slower. Sign in to a provider for stronger ones."),
    signIn: t("Sign in to a provider"),
    signedOutNote: t("Sign in to a provider in OpenCode to run its models."),
    terminal: t("OpenCode sign-in"),
    cancelSignIn: t("Cancel"),
    openSignInPage: t("Open sign-in page"),
    signingInNote: t("Free models keep working while you sign in. OpenCode keeps the sign-in."),
    connectedNote: t("Billed by each provider you use. Free models stay in the model menu too."),
    another: t("Sign in to another provider"),
    unreachable: t("OpenCode didn't answer. Check the installation, then try again."),
    tryAgain: t("Try again"),
    buildWith: t("build with"),
    freeModels: t("Free model to build with"),
    defaultName: t("OpenCode default"),
    defaultDetail: t("Follows OpenCode"),
  },
} as const;

/** The local models button: the offer, the Best fit model downloading, or ready. */
export function localWay(chip: ChipState, model: string, percent: number): WayView {
  const words = WAYS_WORDS.local;
  if (chip === ChipState.Ready) return { state: WayState.On, label: words.ready(model), hint: words.hint };
  if (chip === ChipState.Downloading)
    return { state: WayState.Busy, label: words.downloading(model, percent), hint: words.hint };
  return { state: WayState.Idle, label: words.name, hint: words.hint };
}

/** The OpenRouter button: the offer, a browser sign-in waiting, or connected. */
export function openRouterWay(status: EngineStatusCode | undefined, signingIn: boolean): WayView {
  const words = WAYS_WORDS.openRouter;
  if (status === EngineStatusCode.Ready) return { state: WayState.On, label: words.on, hint: words.onHint };
  if (signingIn) return { state: WayState.Busy, label: words.signingIn, hint: words.browserNote };
  return { state: WayState.Idle, label: words.name, hint: words.hint };
}

/** The OpenCode button: the offer, setting up, ready on its free models, or a provider signed in. */
export function openCodeWay(row: OpenCodeRowState): WayView {
  const words = WAYS_WORDS.openCode;
  if (row === OpenCodeRowState.Installing) return { state: WayState.Busy, label: words.installing, hint: words.hint };
  if (row === OpenCodeRowState.FreeOnly) return { state: WayState.On, label: words.ready, hint: words.readyHint };
  if (row === OpenCodeRowState.Connected) return { state: WayState.On, label: words.on, hint: words.onHint };
  return { state: WayState.Idle, label: words.name, hint: words.hint };
}

/** Where OpenRouter's screen is: the offer, waiting on the browser, the key box, checking a key, or connected. */
export const RouterStep = {
  Offer: "offer",
  Browser: "browser",
  Key: "key",
  Checking: "checking",
  On: "on",
} as const;
export type RouterStep = (typeof RouterStep)[keyof typeof RouterStep];

/** What the OpenRouter screen is doing on its own, beside the engine's status. */
export interface RouterLocal {
  signingIn: boolean;
  pasting: boolean;
  saving: boolean;
}

/** The OpenRouter screen's step. A connected engine wins over anything left under way. */
export function routerStep(status: EngineStatusCode | undefined, local: RouterLocal): RouterStep {
  if (status === EngineStatusCode.Ready) return RouterStep.On;
  if (local.saving) return RouterStep.Checking;
  if (local.signingIn) return RouterStep.Browser;
  if (local.pasting) return RouterStep.Key;
  return RouterStep.Offer;
}

/** How OpenRouter's mark looks at each step. */
export function routerMark(step: RouterStep): MarkState {
  if (step === RouterStep.On) return MarkState.On;
  if (step === RouterStep.Browser || step === RouterStep.Checking) return MarkState.Busy;
  return MarkState.Idle;
}

/** How OpenCode's mark looks: missing until installed, lit once its models run (free ones count). */
export function openCodeMark(row: OpenCodeRowState, checking: boolean): MarkState {
  if (row === OpenCodeRowState.FreeOnly || row === OpenCodeRowState.Connected) return MarkState.On;
  const working = row === OpenCodeRowState.Installing || row === OpenCodeRowState.SigningIn;
  if (checking || working) return MarkState.Busy;
  if (row === OpenCodeRowState.NotInstalled) return MarkState.Missing;
  return MarkState.Idle;
}

/** One row of the OpenCode screen's free models. */
export interface FreeModelOption {
  key: string;
  name: string;
  detail: string | null;
}

/**
 * The free models OpenCode's screen offers to build with: OpenCode's own default first, which
 * names no model and so follows OpenCode when it changes its default, then each free model it lists.
 */
export function freeModelOptions(
  models: readonly Pick<EngineDescriptor["models"][number], "id" | "label" | "free">[],
): FreeModelOption[] {
  const words = WAYS_WORDS.openCode;
  return [
    { key: defaultModelKey(EngineId.OpenCode), name: words.defaultName, detail: words.defaultDetail },
    ...models
      .filter((model) => model.free)
      .map((model) => ({ key: modelKey(EngineId.OpenCode, model.id), name: model.label, detail: null })),
  ];
}

/** The row the list shows picked: the person's, while OpenCode still offers it, else OpenCode's default. */
export function pickedFreeModel(options: readonly FreeModelOption[], key: string): string {
  if (options.some((option) => option.key === key)) return key;
  return defaultModelKey(EngineId.OpenCode);
}

/** Does first launch pick the first model with the person: OpenCode's free models are all they can build with? */
export const picksFreeModel = (row: OpenCodeRowState, othersOn: boolean): boolean =>
  row === OpenCodeRowState.FreeOnly && !othersOn;
