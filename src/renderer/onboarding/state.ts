/**
 * First launch, as pure decisions: whether to welcome, and what each subscription's one-line
 * button says for the engine and sign-in state it is in. The screens render these; they never
 * work the answer out again.
 */
import type { ClaudeLoginState } from "../../shared/claude-login.ts";
import type { CodexLoginState } from "../../shared/codex-login.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { t } from "../../shared/i18n.ts";
import { ModelCatalogState } from "../../shared/model-catalog.ts";
import { EngineId, type SubscriptionId } from "../../shared/providers.ts";
import type { EngineDescriptor } from "../types.ts";
import { MarkState } from "./art.ts";
import { STORAGE_KEYS } from "../storage.ts";

/** Set once the welcome is finished or skipped on this profile. */
export const WELCOMED_KEY = STORAGE_KEYS.welcomed;
/** The demo prompt names the game the Judges' screen plays. */
export const DEMO_IDEA = t("A tiny space shooter in a field of asteroids");

/** Welcome only a first launch: the session allows it, the library is empty and this profile was never welcomed. */
export function shouldWelcome(allowed: boolean | undefined, games: number, storage: Pick<Storage, "getItem">): boolean {
  return allowed === true && games === 0 && storage.getItem(WELCOMED_KEY) !== "1";
}

/** A subscription first launch offers to connect: Claude Code or Codex. */
export type Subscription = SubscriptionId;
/** The subscriptions, in the order their buttons stand. */
export const SUBSCRIPTIONS: readonly Subscription[] = [EngineId.ClaudeCode, EngineId.Codex];

type Words = Record<
  "connect" | "install" | "installing" | "update" | "updating" | "recheck" | "on" | "notStarting",
  string
>;

const WORDS: Record<Subscription, Words> = {
  [EngineId.ClaudeCode]: {
    connect: t("Connect Claude Code"),
    install: t("Set up Claude Code"),
    installing: t("Setting up Claude Code…"),
    update: t("Update Claude Code"),
    updating: t("Updating Claude Code…"),
    recheck: t("Check Claude Code again"),
    on: t("Claude Code connected"),
    notStarting: t("Claude Code is signed in, but Genex couldn't start it."),
  },
  [EngineId.Codex]: {
    connect: t("Connect ChatGPT"),
    install: t("Set up Codex"),
    installing: t("Setting up Codex…"),
    update: t("Update Codex"),
    updating: t("Updating Codex…"),
    recheck: t("Check Codex again"),
    on: t("ChatGPT connected"),
    notStarting: t("Codex is signed in, but Genex couldn't start it."),
  },
};

/** Which of `ConnectView`'s four shapes a subscription's button takes. */
export const ConnectViewKind = {
  Action: "action",
  Busy: "busy",
  Code: "code",
  On: "on",
} as const;
export type ConnectViewKind = (typeof ConnectViewKind)[keyof typeof ConnectViewKind];

/** What an action button does when it is pressed. */
export const ConnectAction = {
  Connect: "connect",
  Install: "install",
  Update: "update",
  Recheck: "recheck",
  Terminal: "terminal",
} as const;
export type ConnectAction = (typeof ConnectAction)[keyof typeof ConnectAction];

/** One subscription's button: an action, a status while something happens, the code box, or connected. */
export type ConnectView =
  | { kind: typeof ConnectViewKind.Action; action: ConnectAction; label: string }
  | { kind: typeof ConnectViewKind.Busy; label: string; cancel: boolean; offersCode?: true }
  | { kind: typeof ConnectViewKind.Code }
  | { kind: typeof ConnectViewKind.On; label: string };

export interface ConnectInput {
  engine: Pick<EngineDescriptor, "status" | "account" | "catalog"> | undefined;
  claude?: ClaudeLoginState["phase"];
  codexActive?: boolean;
  codex?: CodexLoginState["phase"];
  /** A recheck the user started, or the one on returning to the window. */
  checking?: boolean;
  /** The app is installing or updating the CLI for the person. */
  installing?: boolean;
  /** The person asked for the code box: the sign-in page showed a code instead of finishing. */
  pastingCode?: boolean;
}

/**
 * The step a Claude Code sign-in in progress shows, or undefined when none is under way. Claude
 * Code offers a code box beside its browser sign-in, which nearly always finishes on its own, so
 * the box waits until the person asks for it.
 */
function claudeSignInView(phase: ConnectInput["claude"], pastingCode: boolean): ConnectView | undefined {
  switch (phase) {
    case "starting":
      return { kind: ConnectViewKind.Busy, label: t("Opening sign-in…"), cancel: true };
    case "browser":
      return { kind: ConnectViewKind.Busy, label: t("Finish in your browser"), cancel: true };
    case "code":
      if (pastingCode) return { kind: ConnectViewKind.Code };
      return { kind: ConnectViewKind.Busy, label: t("Finish in your browser"), cancel: true, offersCode: true };
    case "verifying":
      return { kind: ConnectViewKind.Busy, label: t("Checking…"), cancel: false };
    case "terminal":
      return { kind: ConnectViewKind.Action, action: ConnectAction.Terminal, label: t("Finish in the terminal") };
    default:
      return undefined;
  }
}

/** The subscription's one-line button for its engine and sign-in state. */
export function connectView(id: Subscription, input: ConnectInput): ConnectView {
  const words = WORDS[id];
  if (input.engine?.status.code === EngineStatusCode.Ready) return readyView(words, input);
  const signingIn = id === EngineId.ClaudeCode ? claudeSignInView(input.claude, input.pastingCode === true) : undefined;
  if (signingIn) return signingIn;
  // Codex signs in in the browser; while it checks the sign-in there is nothing left to cancel.
  if (id === EngineId.Codex && input.codexActive) {
    const verifying = input.codex === "verifying";
    return {
      kind: ConnectViewKind.Busy,
      label: verifying ? t("Checking…") : t("Finish in your browser"),
      cancel: !verifying,
    };
  }
  return cliView(words, input);
}

/**
 * Whether a signed-in CLI failed to start for Genex: its model list is read by starting it, so a
 * list that never loaded means no build could run either, whatever the sign-in says.
 */
function failsToStart(engine: ConnectInput["engine"]): boolean {
  return engine?.catalog?.state === ModelCatalogState.Unavailable;
}

/** A signed-in CLI's button: connected, unless Genex could not start it, then a check again. */
function readyView(words: Words, input: ConnectInput): ConnectView {
  if (!failsToStart(input.engine)) return { kind: ConnectViewKind.On, label: words.on };
  if (input.checking || input.engine?.catalog?.refreshing)
    return { kind: ConnectViewKind.Busy, label: t("Checking…"), cancel: false };
  return { kind: ConnectViewKind.Action, action: ConnectAction.Recheck, label: words.recheck };
}

/** The line under a signed-in CLI Genex could not start, or null; none while a check runs. */
export function startTrouble(id: Subscription, engine: ConnectInput["engine"]): string | null {
  const ready = engine?.status.code === EngineStatusCode.Ready;
  const settled = ready && failsToStart(engine) && !engine?.catalog?.refreshing;
  return settled ? WORDS[id].notStarting : null;
}

/** The button when no sign-in is under way: an install or check running, else what the CLI needs. */
function cliView(words: Words, input: ConnectInput): ConnectView {
  const status = input.engine?.status.code;
  const cli = input.engine?.account?.cli?.state;
  if (input.installing) {
    const label = cli === CodingCliState.Incompatible ? words.updating : words.installing;
    return { kind: ConnectViewKind.Busy, label, cancel: false };
  }
  if (input.checking) return { kind: ConnectViewKind.Busy, label: t("Checking…"), cancel: false };
  if (cli === CodingCliState.Incompatible)
    return { kind: ConnectViewKind.Action, action: ConnectAction.Update, label: words.update };
  const cliMissing = cli !== undefined && cli !== CodingCliState.Ready;
  if (status === EngineStatusCode.NotInstalled || cliMissing)
    return { kind: ConnectViewKind.Action, action: ConnectAction.Install, label: words.install };
  if (status === EngineStatusCode.Error || status === EngineStatusCode.NotRunning)
    return { kind: ConnectViewKind.Action, action: ConnectAction.Recheck, label: words.recheck };
  return { kind: ConnectViewKind.Action, action: ConnectAction.Connect, label: words.connect };
}

/** Does this button install or update the CLI (in place, with the vendor's own installer)? */
export const installsCli = (view: ConnectView): boolean =>
  view.kind === ConnectViewKind.Action &&
  (view.action === ConnectAction.Install || view.action === ConnectAction.Update);

/** How the subscription's mark looks for its button. */
export function markState(view: ConnectView): MarkState {
  if (view.kind === ConnectViewKind.On) return MarkState.On;
  if (view.kind === ConnectViewKind.Busy || view.kind === ConnectViewKind.Code) return MarkState.Busy;
  return installsCli(view) ? MarkState.Missing : MarkState.Idle;
}

/** Ollama names an untagged pull `:latest`; installed models are compared the same way. */
export const canonicalModel = (id: string): string => (id.includes(":") ? id : `${id}:latest`);
