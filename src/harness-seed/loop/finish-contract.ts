/**
 * The names a lead's claim and the captures a reviewer reads share with the app: copies of the
 * app's `shared/observers.ts` and `shared/finish-check.ts` vocabularies, held equal to them by
 * `seed-contracts.test.ts`. They live in
 * a module of their own, never in `run-events.ts`: a kept older copy of that file lacks new members.
 */
import { MINUTE_MS } from "./time.ts";

/** Where one round of a finish check stands (`finish_check.step`). Persisted: never rename a value. */
export const FinishCheckStep = {
  Checking: "checking",
  Accepted: "accepted",
  Rejected: "rejected",
  Unanswered: "unanswered",
} as const;
export type FinishCheckStep = (typeof FinishCheckStep)[keyof typeof FinishCheckStep];

/** The reviewer's no's in a row that stop a Loop; an unanswered check neither counts nor breaks the row. */
export const MAX_FINISH_REJECTIONS = 3;

/** The reasons a reviewer's answer keeps at most. */
export const MAX_FINISH_REASONS = 6;

/** How long one reason (or why a check got no answer) reads, in characters. */
export const FINISH_REASON_CHARS = 300;

/** The record of one step of a finish check: written by Genex alone, read by the harness. */
export const FINISH_CHECK_EVENT = "finish_check";

/** Where a capture's pictures came from (`observer_capture.source`). Persisted: never rename a value. */
export const ObserverSource = {
  Preview: "preview",
  Plugin: "plugin",
  Checkpoint: "checkpoint",
  Proof: "proof",
} as const;
export type ObserverSource = (typeof ObserverSource)[keyof typeof ObserverSource];

/** Genex's own web preview, as an observer's id in a capture. */
export const PREVIEW_OBSERVER = "preview";

/** The lead's proof (files it names at a finish), as an observer's id in a capture. */
export const PROOF_OBSERVER = "proof";

/** The record of one capture kept with a run: files only, never picture data. */
export const OBSERVER_CAPTURE_EVENT = "observer_capture";

/** The longest one lead tool call may take (the engine bridge's deadline): a finish does all its work inside it. */
export const LEAD_CALL_MS = 10 * MINUTE_MS;
