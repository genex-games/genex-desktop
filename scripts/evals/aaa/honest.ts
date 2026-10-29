/**
 * Honest grading (plan 2, track D): the checks that stop a broken game from passing on small,
 * incomplete captures. A fixed full-resolution capture set (a close-up per animation clip, the suite's
 * interior and exterior views, a top-down map), the measured pose, place and look-feature floors, the
 * vision judges' pass/fail items, and a guard that the graded run's dev store was built from the
 * current integration head. Nothing here names a game: clips, zones and features come from the run.
 */
import { CheckResult } from "../vocabulary.ts";
import type { AaaCapture, AaaClipPose, AaaClipRef, AaaEvidence } from "./evidence.ts";
import { FactSource as Source } from "./evidence.ts";
import { AaaFloor, AaaGrade, CLEAN_MIN_SIZE, type FloorCheck, Tally } from "./rubric.ts";

/** The role of the top-down map capture in every bundle. */
export const MAP_ROLE = "map-topdown";
/** A character close-up's role prefix; the rest is `<character>/<clip>`. */
export const CLOSEUP_ROLE_PREFIX = "closeup:";
/** A close-up fills at least this share of the frame height (proposed). */
export const CLOSEUP_MIN_SUBJECT_FRACTION = 0.5;
/** Pose caps per clip against the rest pose (proposed). */
export const POSE_CAPS = { limbLengthDrift: 0.05, torsoLengthRatioMin: 0.85, selfIntersection: 0.02 } as const;
/** How many hex digits of a head two heads must share to be the same head. */
const MIN_HEAD_DIGITS = 7;

/** The role a clip's close-up carries. */
export const closeupRole = (clip: AaaClipRef) => `${CLOSEUP_ROLE_PREFIX}${clip.character}/${clip.clip}`;
/** Whether a role belongs to the fixed capture set rather than to a suite view. */
export const isFixedRole = (role: string) => role === MAP_ROLE || role.startsWith(CLOSEUP_ROLE_PREFIX);

/** One vision judge item's verdict: pass when every family passes every capture. */
export interface ItemVerdict {
  pass: boolean;
  /** Whether a judging family is the family that built the game. */
  sameFamily: boolean;
  detail: string[];
}

/** The vision judges' items for a run; null is unmeasured. */
export interface VisionSummary {
  anatomy: ItemVerdict | null;
  place: ItemVerdict | null;
}

/** What a grading run knows beyond the bundle. */
export interface GradeContext {
  /** The current integration head the run's dev store must come from; null when not given. */
  expectedHead: string | null;
  vision: VisionSummary | null;
}

const sizeText = (c: AaaCapture) => `${c.width}×${c.height}`;
const bigEnough = (c: AaaCapture) => c.width >= CLEAN_MIN_SIZE.width && c.height >= CLEAN_MIN_SIZE.height;
const withRole = (evidence: AaaEvidence, role: string) => evidence.captures.filter((c) => c.role === role);

/** A fixed-set capture: found, large enough and clean (a flag still null is a gap). */
function fixedCapture(tally: Tally, evidence: AaaEvidence, role: string, minSubject: number | null): void {
  const found = withRole(evidence, role);
  if (!found.length) {
    tally.fails.push(`${role}: no capture`);
    return;
  }
  const sized = found.filter(bigEnough);
  const good = sized.find((c) => c.clean === true);
  if (!good) {
    const note = sized.length ? "clean flag unknown" : `largest ${sizeText(found[0] as AaaCapture)}`;
    if (sized.some((c) => c.clean !== false)) tally.gap(`${role}: ${note}`);
    else tally.fails.push(`${role}: no clean capture of at least 1600×900 (${note})`);
    return;
  }
  if (minSubject === null) {
    tally.fact(true, good.source, `${role}: ${good.camera} ${sizeText(good)}`);
    return;
  }
  if (good.subjectFraction === null) {
    tally.gap(`${role}: subject size unknown`);
    return;
  }
  const ok = good.subjectFraction >= minSubject;
  tally.fact(ok, good.source, `${role}: subject fills ${(good.subjectFraction * 100).toFixed(0)}% of the frame`);
}

/** The fixed capture set: the map and one close-up per clip, all clean and at least 1600×900. */
export function captureSet(evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  fixedCapture(tally, evidence, MAP_ROLE, null);
  const characters = evidence.characters;
  if (characters === null) tally.gap("no list of animation clips");
  else if (characters.source === Source.Reconstructed && !characters.clips.length)
    tally.gap("no animated characters (reconstructed: cannot certify)");
  for (const clip of characters?.clips ?? [])
    fixedCapture(tally, evidence, closeupRole(clip), CLOSEUP_MIN_SUBJECT_FRACTION);
  return tally.check(AaaFloor.CaptureSet, AaaGrade.Aa);
}

const clipName = (clip: AaaClipRef) => `${clip.character}/${clip.clip}`;

function poseFacts(tally: Tally, pose: AaaClipPose): void {
  const name = clipName(pose);
  const { limbLengthDrift: drift, torsoLengthRatio: torso, selfIntersection: inside } = pose;
  if (drift === null) tally.gap(`${name}: limb length unmeasured`);
  else tally.fact(drift <= POSE_CAPS.limbLengthDrift, pose.source, `${name}: limbs drift ${(drift * 100).toFixed(1)}%`);
  if (torso === null) tally.gap(`${name}: torso unmeasured`);
  else
    tally.fact(
      torso >= POSE_CAPS.torsoLengthRatioMin,
      pose.source,
      `${name}: torso keeps ${(torso * 100).toFixed(0)}%`,
    );
  if (inside === null) tally.gap(`${name}: self-intersection unmeasured`);
  else
    tally.fact(
      inside <= POSE_CAPS.selfIntersection,
      pose.source,
      `${name}: ${(inside * 100).toFixed(1)}% inside itself`,
    );
  if (pose.feetGrounded === null) tally.gap(`${name}: feet unmeasured`);
  else tally.fact(pose.feetGrounded, pose.source, `${name}: feet grounded ${pose.feetGrounded}`);
}

/** Per clip: bones keep their length, the torso does not collapse, the body stays out of itself. */
export function anatomyPose(evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  if (evidence.characters === null) tally.gap("no list of animation clips");
  else if (!evidence.characters.clips.length) tally.passes.push("no animated characters");
  for (const clip of evidence.characters?.clips ?? []) {
    const pose = evidence.poses?.find((p) => p.character === clip.character && p.clip === clip.clip);
    if (pose) poseFacts(tally, pose);
    else tally.gap(`${clipName(clip)}: no pose validation`);
  }
  return tally.check(AaaFloor.AnatomyPose, AaaGrade.Aa);
}

/** The built level against its plan: every zone reachable, the planned zones and exits there, no stray dead ends. */
export function placeCoherence(evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  const place = evidence.place;
  if (place === null) {
    tally.gap("no reachability facts");
    return tally.check(AaaFloor.PlaceCoherence, AaaGrade.Aa);
  }
  const { source } = place;
  tally.fact(place.reachableZones >= place.zones, source, `${place.reachableZones} of ${place.zones} zones reachable`);
  tally.fact(place.unplannedDeadEnds === 0, source, `${place.unplannedDeadEnds} unplanned dead ends`);
  if (place.plannedZones === null) tally.gap("no level plan to compare the zones with");
  else
    tally.fact(
      place.zones >= place.plannedZones,
      source,
      `${place.zones} zones built of ${place.plannedZones} planned`,
    );
  if (place.plannedExits === null) tally.gap("no planned exits to compare with");
  else tally.fact(place.exits >= place.plannedExits, source, `${place.exits} exits of ${place.plannedExits} planned`);
  return tally.check(AaaFloor.PlaceCoherence, AaaGrade.Aa);
}

/** No feature the quality preset owns is off in the graded build. */
export function lookFeatures(evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  const look = evidence.lookFeatures;
  if (look === null) tally.gap("no look facts to compare with the preset");
  else if (!look.expected.length) tally.gap(`preset ${look.preset} lists no features`);
  else {
    const off = look.expected.filter((feature) => !look.active.includes(feature));
    tally.fact(
      !off.length,
      look.source,
      off.length
        ? `off in ${look.preset}: ${off.join(", ")}`
        : `${look.preset}: all ${look.expected.length} features on`,
    );
  }
  return tally.check(AaaFloor.LookFeatures, AaaGrade.Aa);
}

/** Two heads are the same when one is a prefix of the other and both are at least seven digits. */
export function sameHead(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return Math.min(x.length, y.length) >= MIN_HEAD_DIGITS && (x.startsWith(y) || y.startsWith(x));
}

/** The graded run's dev store was built from the current integration head. */
export function storeFresh(evidence: AaaEvidence, expectedHead: string | null): FloorCheck {
  const tally = new Tally();
  const store = evidence.store;
  if (expectedHead === null) tally.gap("no current integration head given (--head)");
  else if (store === null) tally.gap("the run's dev store head is unknown");
  else {
    const ok = sameHead(store.head, expectedHead);
    tally.fact(
      ok,
      store.source,
      `dev store built from ${store.head.slice(0, 8)}; integration head ${expectedHead.slice(0, 8)}`,
    );
  }
  return tally.check(AaaFloor.StoreFresh, AaaGrade.Aa);
}

function itemCheck(floor: AaaFloor, item: ItemVerdict | null, vacuous: boolean, off: string): FloorCheck {
  const tier = AaaGrade.AaPlus;
  if (item === null && vacuous) return { floor, tier, result: CheckResult.Pass, detail: ["nothing to judge"] };
  if (item === null) return { floor, tier, result: CheckResult.Unknown, detail: [off] };
  const tag = item.sameFamily ? " (same family as the builder)" : "";
  return {
    floor,
    tier,
    result: item.pass ? CheckResult.Pass : CheckResult.Fail,
    detail: [`judged ${item.pass ? "pass" : "fail"}${tag}`, ...item.detail],
  };
}

/** The honest-grading checks for one run. */
export function honestChecks(evidence: AaaEvidence, context: GradeContext): FloorCheck[] {
  const noCharacters =
    evidence.characters !== null &&
    evidence.characters.source !== Source.Reconstructed &&
    !evidence.characters.clips.length;
  return [
    captureSet(evidence),
    anatomyPose(evidence),
    placeCoherence(evidence),
    lookFeatures(evidence),
    storeFresh(evidence, context.expectedHead),
    itemCheck(AaaFloor.AnatomyJudge, context.vision?.anatomy ?? null, noCharacters, "no anatomy judge verdict"),
    itemCheck(AaaFloor.PlaceJudge, context.vision?.place ?? null, false, "no place judge verdict"),
  ];
}
