/**
 * Send feedback, from the bug button at the top of the sidebar: one anonymous POST to genex.games,
 * where the team reads reports in the admin panel. The person's words, the screen they were on and
 * the app and OS versions always go. Two switches add more, each on its own: the Settings → Copy
 * diagnostics report, and the open chat's newest events scrubbed like the studio log (no
 * credential, email address or home folder). No account, email or game file is sent.
 */
import { SECOND_MS } from "../shared/duration.ts";
import type { EventEnvelope } from "../shared/event-log.ts";
import {
  FEEDBACK_TEXT_MAX_CHARS,
  type FeedbackDraft,
  type FeedbackScreen,
  isFeedbackScreen,
} from "../shared/feedback.ts";
import { redactDeep } from "../shared/redact.ts";
import { scrubForLog } from "./logs.ts";

/** Where reports go: genex.games's API, beside the desktop's build-metrics route. */
export const FEEDBACK_URL = "https://api.genex.games/api/desktop/feedback";
/** One send, including genex.games's answer. */
export const FEEDBACK_TIMEOUT_MS = 20 * SECOND_MS;
/** How many of the open chat's newest events a report carries. */
export const FEEDBACK_CHAT_EVENTS = 200;
/** The most characters of chat events a report carries; the oldest events go first. */
export const FEEDBACK_CHAT_MAX_CHARS = 256 * 1024;
/**
 * The most characters of any one string in a chat event (a tool's output, a file, an image's data
 * URL). It also bounds the scrubber, whose email pattern slows with the length of an unbroken word.
 */
export const FEEDBACK_STRING_MAX_CHARS = 2_000;
/** The most characters of the diagnostics report genex.games takes; past it, the middle goes. */
export const FEEDBACK_DIAGNOSTICS_MAX_CHARS = 128 * 1024;
/** How much of the report's start (versions, paths, providers) a clipped report keeps. */
const DIAGNOSTICS_HEAD_CHARS = 16 * 1024;

/** Why a report was not sent, and how a clipped string ends. */
const MESSAGE = {
  invalid: "Feedback needs its text, a known screen, a yes or no for app logs and a chat id or null.",
  tooLong: `Feedback can be at most ${FEEDBACK_TEXT_MAX_CHARS} characters.`,
  refused: (status: number) => `genex.games did not take the feedback (HTTP ${status}).`,
  clipped: (rest: number) => `… [${rest} more characters]`,
  cut: (count: number) => `\n… [${count} characters cut] …\n`,
} as const;

/** What genex.games receives at `POST /api/desktop/feedback`, as JSON. */
export interface FeedbackReport {
  text: string;
  screen: FeedbackScreen;
  app: { version: string; packaged: boolean };
  os: { platform: string; release: string; arch: string };
  /** Present only when the person switched on app logs, the chat, or both. */
  logs?: {
    /** The Settings → Copy diagnostics report, already redacted; present with app logs on. */
    diagnostics?: string;
    /** The chat's newest events, one JSON object per line, oldest first; present with the chat on. */
    chat?: string;
  };
}

/** What a report is made from, and how it is posted. */
export interface FeedbackSources {
  app: FeedbackReport["app"];
  os: FeedbackReport["os"];
  /** The home folder the chat's events are scrubbed of. */
  home: string;
  diagnostics(): Promise<string>;
  /** The chat's newest `count` events, oldest first; refuses an id that is not a chat. */
  chatEvents(threadId: string, count: number): Promise<EventEnvelope[]>;
  fetch: typeof fetch;
}

/** The dialog's payload, checked at the boundary: types are not checked at runtime. */
function parseDraft(payload: unknown): FeedbackDraft {
  const draft = (payload ?? {}) as Partial<Record<keyof FeedbackDraft, unknown>>;
  const { text, screen, appLogs, chatId } = draft;
  const chat = chatId === null || (typeof chatId === "string" && chatId.length > 0);
  const shaped = typeof text === "string" && isFeedbackScreen(screen) && typeof appLogs === "boolean" && chat;
  if (!shaped || typeof payload !== "object") throw new Error(MESSAGE.invalid);
  const words = text.trim();
  if (!words) throw new Error(MESSAGE.invalid);
  if (words.length > FEEDBACK_TEXT_MAX_CHARS) throw new Error(MESSAGE.tooLong);
  return { text: words, screen, appLogs, chatId: chatId as string | null };
}

/**
 * One string of an event, scrubbed and clipped to {@link FEEDBACK_STRING_MAX_CHARS}. The scrub
 * reads twice that much, so a credential the clip cuts through is still recognised whole.
 */
function clippedString(text: string, home: string): string {
  const scrubbed = scrubForLog(text.slice(0, 2 * FEEDBACK_STRING_MAX_CHARS), home);
  if (text.length <= FEEDBACK_STRING_MAX_CHARS) return scrubbed;
  return scrubbed.slice(0, FEEDBACK_STRING_MAX_CHARS) + MESSAGE.clipped(text.length - FEEDBACK_STRING_MAX_CHARS);
}

/** The chat's events as lines, the oldest dropped until they fit {@link FEEDBACK_CHAT_MAX_CHARS}. */
function chatLines(events: EventEnvelope[], home: string): string {
  const lines = events.map((event) => JSON.stringify(redactDeep(event, (text) => clippedString(text, home))));
  let size = lines.reduce((total, line) => total + line.length + 1, 0);
  let first = 0;
  while (first < lines.length && size > FEEDBACK_CHAT_MAX_CHARS) {
    size -= (lines[first]?.length ?? 0) + 1;
    first += 1;
  }
  return lines.slice(first).join("\n");
}

/**
 * The diagnostics report within {@link FEEDBACK_DIAGNOSTICS_MAX_CHARS}: its start (versions, paths,
 * providers) and its newest log lines stay, and the middle goes.
 */
function clippedDiagnostics(text: string): string {
  if (text.length <= FEEDBACK_DIAGNOSTICS_MAX_CHARS) return text;
  const room = FEEDBACK_DIAGNOSTICS_MAX_CHARS - DIAGNOSTICS_HEAD_CHARS;
  const marker = MESSAGE.cut(text.length - FEEDBACK_DIAGNOSTICS_MAX_CHARS);
  return text.slice(0, DIAGNOSTICS_HEAD_CHARS) + marker + text.slice(text.length - (room - marker.length));
}

/** What the switches attach; nothing is read for a switch that is off. */
async function attachedLogs(draft: FeedbackDraft, sources: FeedbackSources): Promise<FeedbackReport["logs"]> {
  const diagnostics = draft.appLogs ? clippedDiagnostics(await sources.diagnostics()) : undefined;
  const events = draft.chatId ? await sources.chatEvents(draft.chatId, FEEDBACK_CHAT_EVENTS) : undefined;
  return {
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(events ? { chat: chatLines(events, sources.home) } : {}),
  };
}

/** Check the dialog's payload, build the report and post it; throws when genex.games refuses it. */
export async function sendFeedback(payload: unknown, sources: FeedbackSources): Promise<void> {
  const draft = parseDraft(payload);
  const report: FeedbackReport = {
    text: draft.text,
    screen: draft.screen,
    app: sources.app,
    os: sources.os,
    ...(draft.appLogs || draft.chatId ? { logs: await attachedLogs(draft, sources) } : {}),
  };
  const res = await sources.fetch(FEEDBACK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(MESSAGE.refused(res.status));
}
