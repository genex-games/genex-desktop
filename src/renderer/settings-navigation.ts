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

export type SettingsRequest = { section?: SettingsSection; returnFocus?: HTMLElement | null };
export const OPEN_SETTINGS_EVENT = "studio:open-settings";

/** All contextual setup links lead to the same application settings dialog. */
export function openSettings(
  section: SettingsSection = SettingsSection.Providers,
  returnFocus?: HTMLElement | null,
): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section, returnFocus } }));
}
