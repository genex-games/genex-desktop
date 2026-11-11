/**
 * How a send on its way reads on the publish card: how much went, how fast, how long is left
 * (`GenexSendProgress`, from the Genex CLI's progress lines), as one line (`sendProgressView`) or
 * with the time left apart for the row's loader (`sendStatus`). Pure: the card calls it on each tick.
 */
import { sizeWords } from "../../../../shared/byte-size.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../../../shared/duration.ts";
import { GenexSendStage, type GenexSendProgress } from "../../../../shared/genex.ts";
import { t } from "../../../../shared/i18n.ts";

/** A speed read longer ago than this says nothing of now: the send may have stopped moving. */
const SPEED_FRESH_MS = 15 * SECOND_MS;
/** Time left is said to the quarter hour past an hour: nobody plans by the minute that far out. */
const QUARTER_MINUTES = 15;

const WORDS = {
  stage: {
    [GenexSendStage.Zip]: t("Packing"),
    [GenexSendStage.Hash]: t("Checking the archive"),
    [GenexSendStage.Upload]: null,
    [GenexSendStage.SourceLfs]: t("Sending the project for Remix"),
    [GenexSendStage.SourceGit]: t("Sending the project for Remix"),
  } satisfies Record<GenexSendStage, string | null>,
  sent: (done: string, total: string) => t("{done} of {total}", { done, total }),
  atSpeed: (done: string, total: string, speed: string) => t("{done} of {total} · {speed}/s", { done, total, speed }),
  underAMinute: (done: string, total: string, speed: string) =>
    t("{done} of {total} · {speed}/s · under a minute left", { done, total, speed }),
  minutesLeft: (done: string, total: string, speed: string, minutes: number) =>
    t("{done} of {total} · {speed}/s · about {minutes} min left", { done, total, speed, minutes }),
  hoursLeft: (done: string, total: string, speed: string, hours: number) =>
    t("{done} of {total} · {speed}/s · about {hours} h left", { done, total, speed, hours }),
  hoursMinutesLeft: (done: string, total: string, speed: string, hours: number, minutes: number) =>
    t("{done} of {total} · {speed}/s · about {hours} h {minutes} min left", { done, total, speed, hours, minutes }),
} as const;

/** What a working row shows of its send. */
export interface SendProgressView {
  /** What is going on when it is not the upload itself; null for the upload. */
  label: string | null;
  /** How much went, and how fast and how long is left when that is known; null when there is nothing to count. */
  amounts: string | null;
  /** How full the bar is, 0 to 1; null when the size is not known. */
  fraction: number | null;
}

/** The amounts line with the time left, by how far out the end is. */
function withTimeLeft(done: string, total: string, speed: string, leftMs: number): string {
  if (leftMs < MINUTE_MS) return WORDS.underAMinute(done, total, speed);
  if (leftMs < HOUR_MS) return WORDS.minutesLeft(done, total, speed, Math.round(leftMs / MINUTE_MS));
  const quarters = Math.round(leftMs / (QUARTER_MINUTES * MINUTE_MS));
  const hours = Math.floor(quarters / 4);
  const minutes = (quarters % 4) * QUARTER_MINUTES;
  return minutes === 0
    ? WORDS.hoursLeft(done, total, speed, hours)
    : WORDS.hoursMinutesLeft(done, total, speed, hours, minutes);
}

/** The speed of a send whose size is known, when it was read lately enough to say anything of now; else 0. */
function freshSpeed(progress: GenexSendProgress, now: number): number {
  const speed = progress.bytesPerSecond ?? 0;
  return speed > 0 && now - progress.at <= SPEED_FRESH_MS ? speed : 0;
}

/** How long a send whose size is known has left at its speed; null when the speed is not known, or all of it went. */
function leftMsOf(progress: GenexSendProgress, now: number): number | null {
  const speed = freshSpeed(progress, now);
  const left = Math.max(0, progress.totalBytes - progress.doneBytes);
  return speed > 0 && left > 0 ? (left / speed) * SECOND_MS : null;
}

/** How much went of a send whose size is known, and how fast: the line without the time left. */
function soFar(progress: GenexSendProgress, now: number): string {
  const done = sizeWords(Math.min(progress.doneBytes, progress.totalBytes));
  const total = sizeWords(progress.totalBytes);
  const speed = freshSpeed(progress, now);
  return speed > 0 ? WORDS.atSpeed(done, total, sizeWords(speed)) : WORDS.sent(done, total);
}

/** How much went of a send whose size is known. */
function amountsOf(progress: GenexSendProgress, now: number): string {
  const leftMs = leftMsOf(progress, now);
  if (leftMs === null) return soFar(progress, now);
  const done = sizeWords(Math.min(progress.doneBytes, progress.totalBytes));
  return withTimeLeft(done, sizeWords(progress.totalBytes), sizeWords(freshSpeed(progress, now)), leftMs);
}

/** What a row shows of the send `progress` describes, as of `now`; null without one. */
export function sendProgressView(progress: GenexSendProgress | undefined, now: number): SendProgressView | null {
  if (!progress) return null;
  const label = WORDS.stage[progress.stage];
  if (progress.totalBytes <= 0) {
    return { label, amounts: progress.doneBytes > 0 ? sizeWords(progress.doneBytes) : null, fraction: null };
  }
  const fraction = Math.min(1, progress.doneBytes / progress.totalBytes);
  return { label, amounts: amountsOf(progress, now), fraction };
}

/** A send as a row of the Publish card reads it: its status line, its bar, and the time left for the row's loader. */
export interface SendStatus {
  /** What is going on and how much went ("Packing", "1.3 of 3.2 GB · 16 MB/s"); null when there is nothing to say. */
  words: string | null;
  /** How full the bar is, 0 to 1; null when the size is not known. */
  fraction: number | null;
  /** How long is left at the send's speed; null when that is not known. */
  leftMs: number | null;
}

/** What a working row shows of the send `progress` describes, as of `now`; null without one. */
export function sendStatus(progress: GenexSendProgress | undefined, now: number): SendStatus | null {
  if (!progress) return null;
  const label = WORDS.stage[progress.stage];
  if (progress.totalBytes <= 0) {
    const went = progress.doneBytes > 0 ? sizeWords(progress.doneBytes) : null;
    return { words: [label, went].filter(Boolean).join(" · ") || null, fraction: null, leftMs: null };
  }
  const fraction = Math.min(1, progress.doneBytes / progress.totalBytes);
  const words = [label, soFar(progress, now)].filter(Boolean).join(" · ");
  return { words, fraction, leftMs: leftMsOf(progress, now) };
}
