/**
 * Send feedback, from the bug button at the top of the sidebar: what the dialog hands main. Main
 * posts it, anonymously, to genex.games, where the team reads it in the admin panel
 * (`main/feedback.ts`).
 */

/** Where the person was when they opened Send feedback. */
export const FeedbackScreen = {
  Home: "home",
  Chat: "chat",
  Harness: "harness",
  Plugins: "plugins",
} as const;
export type FeedbackScreen = (typeof FeedbackScreen)[keyof typeof FeedbackScreen];

/** The longest feedback a person can send, in characters. */
export const FEEDBACK_TEXT_MAX_CHARS = 5_000;

/** One report, as the dialog sends it. */
export interface FeedbackDraft {
  text: string;
  screen: FeedbackScreen;
  /** Attach the redacted diagnostics report: versions, provider status and the app's recent log. */
  appLogs: boolean;
  /** The chat whose recent events to attach, or null to attach none. */
  chatId: string | null;
}

const SCREENS: ReadonlySet<string> = new Set(Object.values(FeedbackScreen));

/** Whether `value` names one of the screens a report can come from. */
export const isFeedbackScreen = (value: unknown): value is FeedbackScreen =>
  typeof value === "string" && SCREENS.has(value);
