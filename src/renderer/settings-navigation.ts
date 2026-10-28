/** A section of the Settings dialog a request can open. */
export const SettingsSection = {
  /** The Genex account (`panels/AccountSection.tsx`): its avatar, name and credits, or the way to sign in. */
  Account: "account",
  Games: "games",
  /** What freeing space deletes, and one button that frees it (`panels/StorageSection.tsx`). */
  Storage: "storage",
  Providers: "providers",
  Local: "local",
  Appearance: "appearance",
  Harness: "harness",
  /** Claude Code's "always allow" rules saved in game chats. */
  Permissions: "permissions",
  /** Share build metrics: off by default (`panels/PrivacySection.tsx`). */
  Privacy: "privacy",
  /** The running version and Check for Updates (`panels/AboutSection.tsx`). */
  About: "about",
} as const;
export type SettingsSection = (typeof SettingsSection)[keyof typeof SettingsSection];

const SECTIONS: ReadonlySet<unknown> = new Set<SettingsSection>(Object.values(SettingsSection));

/** Whether a value names a Settings section. */
export const isSettingsSection = (value: unknown): value is SettingsSection => SECTIONS.has(value);

/** What opened Settings, for usage analytics: a wire value, never renamed. */
export const SettingsOpenedFrom = {
  Sidebar: "sidebar",
  /** Connect AI model, under a Send that had no model. */
  ModelNudge: "model_nudge",
  ModelMenu: "model_menu",
  /** The composer's own "Connect a model" line. */
  ConnectCard: "connect_card",
  ComposerLimits: "composer_limits",
  HarnessGuide: "harness_guide",
  PlanCard: "plan_card",
  Notification: "notification",
  /** The welcome's local-server link. */
  WelcomeServer: "welcome_server",
  ProfilePlate: "profile_plate",
  PlayProfile: "play_profile",
  /** An empty stage's Choose a coding model. */
  StageSetup: "stage_setup",
  /** Home's background, making one with no model. */
  Backdrop: "backdrop",
  Other: "other",
} as const;
export type SettingsOpenedFrom = (typeof SettingsOpenedFrom)[keyof typeof SettingsOpenedFrom];

const OPENED_FROM: ReadonlySet<unknown> = new Set<SettingsOpenedFrom>(Object.values(SettingsOpenedFrom));

/** Whether a value names what opened Settings. */
export const isSettingsOpenedFrom = (value: unknown): value is SettingsOpenedFrom => OPENED_FROM.has(value);

export type SettingsRequest = {
  section?: SettingsSection;
  returnFocus?: HTMLElement | null;
  from?: SettingsOpenedFrom;
};
export const OPEN_SETTINGS_EVENT = "studio:open-settings";

/** All contextual setup links lead to the same application settings dialog; `from` says which one did. */
export function openSettings(
  section: SettingsSection = SettingsSection.Providers,
  returnFocus?: HTMLElement | null,
  from: SettingsOpenedFrom = SettingsOpenedFrom.Other,
): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section, returnFocus, from } }));
}
