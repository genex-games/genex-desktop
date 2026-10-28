/**
 * The words the welcome's and the providers' analytics speak in (plan §1.3): where a press came
 * from, what it did, how a sign-in or a download went, and which face a provider row showed. Each
 * value is a fixed wire spelling the app writes itself; none ever carries what a person typed.
 */
import { EngineId } from "../../shared/providers.ts";
import type { LocalServerRowState } from "../panels/local-server-row.ts";
import type { OpenCodeRowState } from "../panels/opencode-row.ts";

/** Where a provider was pressed: the welcome, Settings, or the chat's sign-in card. */
export const ProviderSurface = {
  Onboarding: "onboarding",
  Settings: "settings",
  ChatCard: "chat_card",
} as const;
export type ProviderSurface = (typeof ProviderSurface)[keyof typeof ProviderSurface];

/** What a provider button does. The welcome's own actions keep their spelling (`ConnectAction`). */
export const ProviderAction = {
  Connect: "connect",
  Install: "install",
  Update: "update",
  Recheck: "recheck",
  Terminal: "terminal",
  SignIn: "sign_in",
  CheckConnection: "check_connection",
  TryAgain: "try_again",
  CatalogRetry: "catalog_retry",
  InstallGuide: "install_guide",
} as const;
export type ProviderAction = (typeof ProviderAction)[keyof typeof ProviderAction];

/** How a sign-in runs: Claude Code's piped CLI, a browser page, a device code, or a CLI's own terminal. */
export const SignInMethod = {
  Piped: "piped",
  Browser: "browser",
  Device: "device",
  TerminalTui: "terminal_tui",
} as const;
export type SignInMethod = (typeof SignInMethod)[keyof typeof SignInMethod];

/** A help beside a sign-in that a person reached for. */
export const SignInHelper = {
  CodeBoxOpened: "code_box_opened",
  CodeSubmitted: "code_submitted",
  DeviceCodeRequested: "device_code_requested",
  PageReopened: "page_reopened",
  TerminalShown: "terminal_shown",
  Retried: "retried",
  PanelDismissed: "panel_dismissed",
  KeyBoxOpened: "key_box_opened",
  GetKeyClicked: "get_key_clicked",
  BrowserInstead: "browser_instead",
} as const;
export type SignInHelper = (typeof SignInHelper)[keyof typeof SignInHelper];

/** How a sign-in ended. */
export const SignInOutcome = {
  Connected: "connected",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type SignInOutcome = (typeof SignInOutcome)[keyof typeof SignInOutcome];

/** What a person did to the welcome's film and its composer. */
export const FilmAction = {
  StepJump: "step_jump",
  IdeaStarted: "idea_started",
  IdeaSent: "idea_sent",
  /** Send pressed on the demo's own prompt, nothing of theirs written. */
  DemoSent: "demo_sent",
  IdeaAbandoned: "idea_abandoned",
} as const;
export type FilmAction = (typeof FilmAction)[keyof typeof FilmAction];

/** How the welcome was left. */
export const WelcomeExit = {
  Skip: "skip",
  Start: "start",
  Terminal: "terminal",
  ServerSettings: "server_settings",
} as const;
export type WelcomeExit = (typeof WelcomeExit)[keyof typeof WelcomeExit];

/** The free model the welcome hands the first game: none offered, OpenCode's default, or another. */
export const FreeModelChoice = {
  None: "none",
  Default: "default",
  Picked: "picked",
} as const;
export type FreeModelChoice = (typeof FreeModelChoice)[keyof typeof FreeModelChoice];

/** A subscription's or OpenRouter's row face in Settings (the CLI rows and the local server have their own). */
export const SubscriptionRowFace = {
  NotInstalled: "not_installed",
  UpdateNeeded: "update_needed",
  NeedsNode: "needs_node",
  Installing: "installing",
  Updating: "updating",
  SigningIn: "signing_in",
  Connected: "connected",
  NotConnected: "not_connected",
  CouldntCheck: "couldnt_check",
} as const;
export type SubscriptionRowFace = (typeof SubscriptionRowFace)[keyof typeof SubscriptionRowFace];

/** Any provider row's face: a subscription's, a CLI's that signs in in its terminal, or the local server's. */
export type ProviderRowFace = SubscriptionRowFace | OpenCodeRowState | LocalServerRowState;

/** Where a local model download was started from. */
export const DownloadSource = {
  BestFit: "best_fit",
  Pick: "pick",
  More: "more",
  OllamaLookup: "ollama_lookup",
} as const;
export type DownloadSource = (typeof DownloadSource)[keyof typeof DownloadSource];

/** How a local model download ended. */
export const DownloadOutcome = {
  Ready: "ready",
  Failed: "failed",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
} as const;
export type DownloadOutcome = (typeof DownloadOutcome)[keyof typeof DownloadOutcome];

/** How a local server's address reached Connect: typed, a found server's Use, or a key for the saved one. */
export const LocalServerVia = {
  Typed: "typed",
  Found: "found",
  SavedKey: "saved_key",
} as const;
export type LocalServerVia = (typeof LocalServerVia)[keyof typeof LocalServerVia];

/** How the Genex promo card went away. */
export const PromoCloseVia = {
  Close: "close",
  Escape: "escape",
  Done: "done",
  /** A Genex account connected elsewhere while the card was up. */
  SettledElsewhere: "settled_elsewhere",
} as const;
export type PromoCloseVia = (typeof PromoCloseVia)[keyof typeof PromoCloseVia];

/** A change to a provider's account. */
export const AccountAction = {
  Switched: "switched",
  Added: "added",
  SignedOut: "signed_out",
  KeyRemoved: "key_removed",
} as const;
export type AccountAction = (typeof AccountAction)[keyof typeof AccountAction];

/** A download's size, in steps that say enough. */
export const SizeBucket = {
  Small: "<1GB",
  Medium: "1-5GB",
  Large: "5-20GB",
  Huge: "20GB+",
} as const;
export type SizeBucket = (typeof SizeBucket)[keyof typeof SizeBucket];

const SIZE_LIMITS: ReadonlyArray<[number, SizeBucket]> = [
  [1, SizeBucket.Small],
  [5, SizeBucket.Medium],
  [20, SizeBucket.Large],
];

/** The bucket a size in GB falls in. */
export function sizeBucket(gb: number): SizeBucket {
  return SIZE_LIMITS.find(([limit]) => gb < limit)?.[1] ?? SizeBucket.Huge;
}

/** This Mac's memory, in the steps Macs ship with. */
export const RamBucket = {
  UpTo8: "8",
  UpTo16: "16",
  UpTo24: "24",
  UpTo32: "32",
  UpTo64: "64",
  UpTo96: "96",
  UpTo128: "128",
  More: "192+",
} as const;
export type RamBucket = (typeof RamBucket)[keyof typeof RamBucket];

const RAM_LIMITS: ReadonlyArray<[number, RamBucket]> = [
  [8, RamBucket.UpTo8],
  [16, RamBucket.UpTo16],
  [24, RamBucket.UpTo24],
  [32, RamBucket.UpTo32],
  [64, RamBucket.UpTo64],
  [96, RamBucket.UpTo96],
  [128, RamBucket.UpTo128],
];

/** The bucket a memory size in GB falls in. */
export function ramBucket(gb: number): RamBucket {
  return RAM_LIMITS.find(([limit]) => gb <= limit)?.[1] ?? RamBucket.More;
}

/** What an engine the app does not list is called. */
export const OTHER_ENGINE = "other";
/** An engine as analytics names it: one of the app's own ids, or `other` for anything else. */
export type EngineRef = EngineId | typeof OTHER_ENGINE;

/** The app's id for an engine, never a name from elsewhere. */
export function engineRef(id: string | null | undefined): EngineRef {
  return Object.values(EngineId).find((engine) => engine === id) ?? OTHER_ENGINE;
}
