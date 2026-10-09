/**
 * The art director's one absolute question about one build: would you ship this as the user's
 * demo today? Every other judge compares — a round against the build before it, the integration
 * against the start — so a run could win round after round and never be asked whether it was
 * good. This one sees the whole game: every frame the evidence pass took of a camera the game
 * registered, the player's eyes and each demo's end, then the motion strip and the reference, and
 * answers ship or not with each defect typed to the plan part that owns it (`part`, kept only when
 * it is one of the parts it was given — membership, never words) and how much it matters. It also
 * names what already works and must stay (`doNotRegress`), which every builder and its taste
 * judge are then held to.
 *
 * It asks through the same judge plumbing as every other judge (judge.ts `askJudgeFor`: retries,
 * the fallback engine, the evaluation pin, the judge's record), with the workspace's own rubric
 * (`judge/ship-review.md`) or the built-in one. An answer nobody can read is no verdict — never a
 * "no". A new module: judge.ts is read by namespace, so a kept older judge.ts never stops it linking.
 */
import * as judgeParts from "./judge.ts";
import { hudFactLines } from "./judge-facts.ts";
// By namespace for what judge-facts.ts gained later: a kept older copy never stops this file linking.
import * as judgeFacts from "./judge-facts.ts";
import { hudBudgetFor } from "./hud-budget.ts";
import { JudgeParse } from "./judge-provenance.ts";
import { workingGoal } from "./goal-prompts.ts";
import { scopeLines } from "./scope-prompts.ts";
import { visionJudgeLines } from "./vision-prompts.ts";
import { clip, CLIP_REASON } from "./text.ts";
import { doNotRegressOf } from "./do-not-regress.ts";
import {
  BUILD_OUTPUT,
  framesLine,
  partsLine,
  SHIP_ASK,
  SHIP_REPLY,
  SHIP_REVIEW_FALLBACK,
} from "./ship-review-prompts.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { MessageImage } from "../types/host-api.d.ts";

/** The most frames one review is shown: the build's own first, then motion, then the reference. */
export const SHIP_REVIEW_IMAGES = 14;
/** The size the art director looks at: a real screen, not the 960×600 every worker's window has. */
export const SHIP_VIEW = { width: 1600, height: 900 } as const;
/** The most defects one review keeps, worst first. */
const MAX_SHIP_DEFECTS = 16;
/** How much of a camera's name a defect keeps. */
const CAMERA_CHARS = 60;
/** How much of the build's state and its warnings the question carries. */
const STATE_CHARS = 2_000;
const WARNING_CHARS = 1_200;
/** How many console errors the question carries. */
const ERROR_LINES = 6;
/** The frame of the page as the user sees it: the art director judges the game's own frames. */
const USER_VIEW = "user:view";

/** How much a defect stands in the way of shipping. Persisted in verdicts and the journal: never rename a value. */
export const DefectSeverity = { Blocker: "blocker", Visible: "visible", Nit: "nit" } as const;
export type DefectSeverity = (typeof DefectSeverity)[keyof typeof DefectSeverity];

/** One plan part as the review is told it: the only ids a defect's `part` may name. */
export interface ShipPart {
  id: string;
  title: string;
  seam: string;
  owns: string[];
}

/** One thing the art director would not ship with. */
export interface ShipDefect {
  what: string;
  camera: string | null;
  /** A plan part's id, or null when no part owns it (or the judge named one that is not the plan's). */
  part: string | null;
  severity: DefectSeverity;
}

/** The art director's answer: ship or not (null when nobody could read it), and why. */
export interface ShipReview {
  ship: boolean | null;
  defects: ShipDefect[];
  /**
   * What already works in the whole game and must stay, as short names ("night lighting"): every
   * loop worker's brief and its taste judge carry the latest list, and a build that loses an item
   * has regressed.
   */
  doNotRegress: string[];
  reason: string;
  parse: JudgeParse;
  /** How the verdict was made (judge.ts), when a judge answered. */
  judged?: AnyRecord;
  judgeCall?: AnyRecord;
}

/** What one review is asked about: the build's evidence, the plan's parts, and the size it was captured at. */
export interface ShipAsk {
  run: Run;
  evidence: AnyRecord;
  parts: readonly ShipPart[];
  max?: number;
  view?: { width: number; height: number } | null;
}

/** The judge plumbing's ask and answer, as judge.ts `askJudgeFor` takes and gives them. */
type AskJudgeFor = (
  ctx: HarnessCtx,
  ask: { run: Run; systemPrompt: string; userContent: string; images?: MessageImage[] },
) => Promise<{ raw: AnyRecord; judged: AnyRecord }>;

/** One frame as an image block for the judge. */
const imageOf = (base64: string, label: string): MessageImage => ({ mimeType: "image/jpeg", data: base64, label });

/** The build's own shots with pixels, the user's view aside. */
function ownShots(evidence: AnyRecord): AnyRecord[] {
  const shots: AnyRecord[] = Array.isArray(evidence.shots) ? evidence.shots : [];
  return shots.filter((shot) => typeof shot?.base64 === "string" && shot.base64 && shot.camera !== USER_VIEW);
}

/** The build's own frames: every one with pixels except the user's view. */
function ownFrames(evidence: AnyRecord): MessageImage[] {
  return ownShots(evidence).map((shot) => imageOf(shot.base64, String(shot.camera ?? "shot")));
}

/**
 * The cameras a defect may name: those of the build's own frames the review was shown. A camera
 * the judge invented, a motion frame or a reference is none a worker's evidence pass can take again.
 */
export function shownCameras(evidence: AnyRecord): Set<string> {
  return new Set(
    ownShots(evidence)
      .map((shot) => shot.camera)
      .filter((camera): camera is string => typeof camera === "string" && camera.length > 0),
  );
}

/** The motion strip cut to its first, middle and last frames. */
function motionFrames(evidence: AnyRecord): MessageImage[] {
  const frames: AnyRecord[] = (Array.isArray(evidence.motion) ? evidence.motion : []).filter(
    (frame: AnyRecord | null) => typeof frame?.base64 === "string" && frame.base64,
  );
  const picked =
    frames.length > 2 ? [0, Math.floor(frames.length / 2), frames.length - 1].map((i) => frames[i]) : frames;
  return picked.flatMap((frame, index) => (frame ? [imageOf(frame.base64, `MOTION ${index + 1}`)] : []));
}

/** The reference stills, in the order the run gave them. */
function referenceFrames(run: Run): MessageImage[] {
  return (run.reference?.frames ?? [])
    .filter((frame) => frame?.data)
    .map((frame, index) => ({
      mimeType: frame.mimeType || "image/jpeg",
      data: frame.data,
      label: `REFERENCE / ${frame.label || index + 1}`,
    }));
}

/**
 * The frames one review is shown, at most `max`: every frame of the build's own (registered
 * cameras, eyes, demo ends) first, then the first, middle and last of its motion, then the
 * reference stills with the room left.
 */
export function shipImages(run: Run, evidence: AnyRecord, max = SHIP_REVIEW_IMAGES): MessageImage[] {
  const own = ownFrames(evidence).slice(0, max);
  const motion = motionFrames(evidence).slice(0, Math.max(0, max - own.length));
  const room = Math.max(0, max - own.length - motion.length);
  return [...own, ...motion, ...referenceFrames(run).slice(0, room)];
}

/** The build's own readings, labeled as its output; the HUD read against the kind's budget. */
function evidenceLines(evidence: AnyRecord, hudBudget: number | null): string[] {
  const lines: string[] = [];
  if (evidence.warnings?.length)
    lines.push(`evidence warnings: ${clip(evidence.warnings.join("; "), WARNING_CHARS)} — ${BUILD_OUTPUT}`);
  if (evidence.state)
    lines.push(
      `state after ~30 s of scripted play: ${clip(JSON.stringify(evidence.state), STATE_CHARS)} — ${BUILD_OUTPUT}`,
    );
  if (evidence.play && evidence.play.reached === false)
    lines.push(`the scripted drive did not reach play (it stayed in "${evidence.play.phase ?? "unknown"}")`);
  lines.push(...hudFactLines(evidence.state?.hud, hudBudget));
  // The drive's facts: the corner frame and the throttle-only bot's race (a ship look races it).
  if (typeof judgeFacts.drivenFactLines === "function") lines.push(...judgeFacts.drivenFactLines(evidence));
  if (evidence.consoleErrors?.length)
    lines.push(`console errors: ${evidence.consoleErrors.slice(0, ERROR_LINES).join(" | ")} — ${BUILD_OUTPUT}`);
  return lines;
}

/** The question about this one build: goal, scope, bar, parts, frames and readings — and no other build. */
function shipContent(ask: ShipAsk, labels: readonly string[]): string {
  const { run, evidence, parts, view = null } = ask;
  return [
    `GOAL: ${workingGoal(run)}`,
    // The user's own scope (launch stamps it on the run): the review never asks for what is out of it.
    scopeLines({ scope: (run as AnyRecord).scope }),
    // Where the lead says the whole world is going (loop/vision.ts): growth toward it deepens the ask.
    visionJudgeLines(run),
    run.reference?.name ? `QUALITY BAR: ${run.reference.name}` : "",
    run.reference?.notes ? `BAR NOTES: ${run.reference.notes}` : "",
    partsLine(parts),
    framesLine(labels, view),
    ...evidenceLines(evidence, hudBudgetFor(run.game)),
    SHIP_ASK,
    SHIP_REPLY,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A severity as the vocabulary has it; anything else a player still sees. */
function severityOf(value: unknown): DefectSeverity {
  const known = Object.values(DefectSeverity) as string[];
  return known.includes(String(value)) ? (value as DefectSeverity) : DefectSeverity.Visible;
}

/** A defect's camera: kept only when it is one of `cameras` (membership, never its words), when they are given. */
function cameraOf(value: unknown, cameras: ReadonlySet<string> | null): string | null {
  const named = typeof value === "string" ? value.trim() : "";
  if (!named) return null;
  if (cameras) return cameras.has(named) ? named : null;
  return clip(named, CAMERA_CHARS);
}

/** One defect as the review keeps it: its part only when it is one of the plan's ids. */
function defectOf(raw: unknown, partIds: ReadonlySet<string>, cameras: ReadonlySet<string> | null): ShipDefect | null {
  const record: AnyRecord = typeof raw === "string" ? { what: raw } : ((raw ?? {}) as AnyRecord);
  const what = clip(String(record.what ?? "").trim(), CLIP_REASON);
  if (!what) return null;
  const part = typeof record.part === "string" && partIds.has(record.part) ? record.part : null;
  return { what, camera: cameraOf(record.camera, cameras), part, severity: severityOf(record.severity) };
}

/**
 * The review as a judge's JSON reads: ship a real yes or no, or no verdict at all. `cameras`, when
 * given, are the only cameras a defect may name (`shownCameras`); any other is dropped.
 */
export function readShipReview(
  raw: AnyRecord | null | undefined,
  parts: readonly ShipPart[],
  cameras: ReadonlySet<string> | null = null,
): ShipReview {
  const reason = clip(String(raw?.reason ?? ""), CLIP_REASON);
  if (!raw || raw.unusable === true || typeof raw.ship !== "boolean")
    return {
      ship: null,
      defects: [],
      doNotRegress: [],
      reason: reason || "unreadable answer",
      parse: JudgeParse.Invalid,
    };
  const ids = new Set(parts.map((part) => part.id));
  const defects = (Array.isArray(raw.defects) ? raw.defects : [])
    .map((defect: unknown) => defectOf(defect, ids, cameras))
    .filter((defect: ShipDefect | null): defect is ShipDefect => defect !== null)
    .slice(0, MAX_SHIP_DEFECTS);
  return { ship: raw.ship, defects, doNotRegress: doNotRegressOf(raw), reason, parse: JudgeParse.Valid };
}

/**
 * Ask the art director about one build. Throws what the judge plumbing throws (a stop, an outage
 * it could not outlast); an answer it could read but that names no ship is `ship: null`.
 */
export async function shipReview(ctx: HarnessCtx, ask: ShipAsk): Promise<ShipReview> {
  const askJudgeFor = (judgeParts as unknown as { askJudgeFor?: AskJudgeFor }).askJudgeFor;
  if (typeof askJudgeFor !== "function")
    return {
      ship: null,
      defects: [],
      doNotRegress: [],
      reason: "this workspace keeps an older judge.ts",
      parse: JudgeParse.Invalid,
    };
  const { run, evidence, parts, max = SHIP_REVIEW_IMAGES } = ask;
  const images = shipImages(run, evidence, max);
  const systemPrompt = await judgeParts.judgePrompt(ctx, "ship-review.md", SHIP_REVIEW_FALLBACK);
  const userContent = shipContent(
    ask,
    images.map((image) => image.label ?? ""),
  );
  const answer = await askJudgeFor(ctx, { run, systemPrompt, userContent, images });
  const review = readShipReview(answer.raw, parts, shownCameras(evidence));
  return {
    ...review,
    judged: { ...answer.judged, parse: review.parse },
    ...(answer.raw.judgeCall ? { judgeCall: answer.raw.judgeCall } : {}),
  };
}
