/**
 * The person's answer about usage analytics, and whether this install records a replay.
 *
 * The answer is kept per profile with the consent version it was given for: when what analytics
 * collects grows, the version goes up, an earlier answer no longer counts and the question comes
 * back. A replay is recorded by one install in five, and only for its first week: the draw is made
 * once, at the first launch that offers analytics, and an install that had already been welcomed
 * before never records one.
 */
import { DAY_MS } from "../../shared/duration.ts";
import { type KeyValueStorage, readJson, STORAGE_KEYS, writeJson } from "../storage.ts";

/** The person's answer. Persisted in `studio.analytics`: never rename a value. */
export const AnalyticsChoice = {
  On: "on",
  Off: "off",
} as const;
export type AnalyticsChoice = (typeof AnalyticsChoice)[keyof typeof AnalyticsChoice];

/** What the question and Settings → Privacy describe. Raise it when analytics collects more. */
export const ANALYTICS_CONSENT_VERSION = 1;
/** The share of new installs that record a replay. */
export const REPLAY_SHARE = 0.2;
/** How long after the first launch a replay records: the start, where people get stuck. */
export const REPLAY_WINDOW_MS = 7 * DAY_MS;

/** The answer as stored: the choice and the consent version it was given for. */
export interface AnalyticsAnswer {
  choice: AnalyticsChoice;
  version: number;
}

const isChoice = (value: unknown): value is AnalyticsChoice =>
  value === AnalyticsChoice.On || value === AnalyticsChoice.Off;

/** The person's answer for the current consent version, or null while they were never asked it. */
export function readAnalyticsChoice(storage: KeyValueStorage | null): AnalyticsChoice | null {
  const stored = readJson<Partial<AnalyticsAnswer> | null>(STORAGE_KEYS.analytics, null, storage);
  if (!stored || stored.version !== ANALYTICS_CONSENT_VERSION) return null;
  return isChoice(stored.choice) ? stored.choice : null;
}

/** Keep the answer, tied to the consent version it was given for. */
export function writeAnalyticsChoice(storage: KeyValueStorage | null, choice: AnalyticsChoice): void {
  const answer: AnalyticsAnswer = { choice, version: ANALYTICS_CONSENT_VERSION };
  writeJson(STORAGE_KEYS.analytics, answer, storage);
}

/** Whether this install records a replay, and until when (epoch ms; 0 when it never does). */
export interface ReplayDraw {
  sampled: boolean;
  until: number;
}

const NO_REPLAY: ReplayDraw = { sampled: false, until: 0 };

const isDraw = (value: unknown): value is ReplayDraw => {
  const draw = value as Partial<ReplayDraw> | null;
  return typeof draw?.sampled === "boolean" && typeof draw.until === "number" && Number.isFinite(draw.until);
};

/**
 * This install's replay draw: the stored one, or a new one kept for good. Only a first launch
 * (the welcome is up) can be drawn; any later launch that finds no draw records no replay.
 */
export function replayDraw(
  storage: KeyValueStorage | null,
  launch: { firstLaunch: boolean; now: number; random: () => number },
): ReplayDraw {
  const stored = readJson<unknown>(STORAGE_KEYS.analyticsReplay, null, storage);
  if (isDraw(stored)) return stored;
  const sampled = launch.firstLaunch && launch.random() < REPLAY_SHARE;
  const draw = sampled ? { sampled, until: launch.now + REPLAY_WINDOW_MS } : NO_REPLAY;
  writeJson(STORAGE_KEYS.analyticsReplay, draw, storage);
  return draw;
}

/** Whether a replay records now: a sampled install inside its first week. */
export const replayRunning = (draw: ReplayDraw | null, now: number): boolean =>
  draw?.sampled === true && now < draw.until;
