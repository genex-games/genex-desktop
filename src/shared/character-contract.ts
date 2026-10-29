/**
 * The character import contract (Track A): what a rigged GLB from `genex__asset` must be for the
 * Rust stack to play it with no hand fixes. The importer reads a file's facts and rest pose
 * (`substrate/asset-import/character-facts.ts`); {@link characterVerdict} turns them into pass or
 * the typed reasons it fails, and into the move roles the rig's own clips already cover, so the
 * rest can be filled from a retargeted library. A failing character never reaches the game.
 * Browser-safe: types, vocabularies and pure rules.
 */
import type { CharacterFacts } from "./character-facts.ts";

/** The moves a playable character needs, by what they do. Wire values. */
export const CharacterRole = {
  Idle: "idle",
  Walk: "walk",
  Run: "run",
  Crouch: "crouch",
  Aim: "aim",
  Fire: "fire",
  Reload: "reload",
  Hit: "hit",
  Death: "death",
} as const;
export type CharacterRole = (typeof CharacterRole)[keyof typeof CharacterRole];

/**
 * The words a clip's name carries for each role, most specific role first: a clip is the first role
 * with a word in its name, so `Crouch_Walk` is crouch and `Idle_Aim` is aim, not walk or idle.
 */
const ROLE_WORDS: ReadonlyArray<readonly [CharacterRole, readonly string[]]> = [
  [CharacterRole.Death, ["death", "die", "dying", "dead"]],
  [CharacterRole.Reload, ["reload", "reloading"]],
  [CharacterRole.Fire, ["fire", "firing", "shoot", "shot"]],
  [CharacterRole.Hit, ["hit", "hurt", "damage", "flinch", "react"]],
  [CharacterRole.Crouch, ["crouch", "crouching", "duck"]],
  [CharacterRole.Aim, ["aim", "aiming"]],
  [CharacterRole.Run, ["run", "running", "sprint", "jog"]],
  [CharacterRole.Walk, ["walk", "walking"]],
  [CharacterRole.Idle, ["idle", "stand", "breathing"]],
];

/** The lowercase words of a clip name: split at anything that is not a letter, and at a camel hump. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** The role a clip's name says, or null for a name that says none (a dance, an empty name). */
export function clipRole(name: string): CharacterRole | null {
  const words = new Set(wordsOf(name));
  const found = ROLE_WORDS.find(([, spellings]) => spellings.some((word) => words.has(word)));
  return found ? found[0] : null;
}

/** Why a character cannot be played as it is. Wire values. */
export const CharacterFailure = {
  /** No skinned mesh and skeleton to read. */
  NotRigged: "not-rigged",
  /** Core bones of the humanoid map are missing (detail: their names). */
  NotHumanoid: "not-humanoid",
  /** The rest pose is neither an A- nor a T-pose (detail: the arm angle in degrees). */
  RestPose: "rest-pose",
  /** The skeleton is not a person's size off the ground (detail: the hips' height in metres). */
  Scale: "scale",
} as const;
export type CharacterFailure = (typeof CharacterFailure)[keyof typeof CharacterFailure];

/** The bones a retarget cannot do without: the trunk, head and both arm and leg chains. */
export const CORE_BONES: readonly string[] = [
  "Hips",
  "Spine",
  "Head",
  "LeftUpperArm",
  "LeftLowerArm",
  "LeftHand",
  "RightUpperArm",
  "RightLowerArm",
  "RightHand",
  "LeftUpperLeg",
  "LeftLowerLeg",
  "LeftFoot",
  "RightUpperLeg",
  "RightLowerLeg",
  "RightFoot",
];

/** An arm this far from hanging (degrees) or less is an arms-down pose a retarget cannot skin well. */
export const REST_ARM_MIN_DEG = 25;
/** An arm past this (degrees from hanging) is raised overhead. */
export const REST_ARM_MAX_DEG = 110;
/** The lowest and highest hips' height above the feet (metres) a playable body has: a doll to a giant. */
export const HIPS_HEIGHT_MIN_M = 0.2;
export const HIPS_HEIGHT_MAX_M = 2.5;

/** The rest pose as the importer measures it from the file's node transforms. */
export interface RestPose {
  /** The mean angle of both arms from hanging straight down: 90 is a T-pose, about 45 an A-pose. */
  armDropDeg: number;
  /** The hips' height above the skeleton's lowest joint, in metres. */
  hipsHeightM: number;
}

/** One reason a character fails, with the fact that decided it. */
export interface CharacterProblem {
  code: CharacterFailure;
  detail: string;
}

/** A character's verdict: pass or fail with every reason, and which roles its own clips cover. */
export interface CharacterVerdict {
  ok: boolean;
  failures: CharacterProblem[];
  /** The clip that plays each role, the first in file order. */
  roles: Partial<Record<CharacterRole, string>>;
  /** The roles no clip covers, in {@link CharacterRole} order: what a library retarget must fill. */
  missingRoles: CharacterRole[];
}

const round = (value: number): number => Math.round(value * 100) / 100;

function problemsOf(facts: CharacterFacts, rest: RestPose | null): CharacterProblem[] {
  const problems: CharacterProblem[] = [];
  const lacking = CORE_BONES.filter((bone) => facts.humanoid.missing.includes(bone));
  if (lacking.length) problems.push({ code: CharacterFailure.NotHumanoid, detail: lacking.join(", ") });
  if (!rest) return problems;
  const { armDropDeg, hipsHeightM } = rest;
  if (armDropDeg < REST_ARM_MIN_DEG || armDropDeg > REST_ARM_MAX_DEG)
    problems.push({ code: CharacterFailure.RestPose, detail: `${round(armDropDeg)} degrees` });
  if (hipsHeightM < HIPS_HEIGHT_MIN_M || hipsHeightM > HIPS_HEIGHT_MAX_M)
    problems.push({ code: CharacterFailure.Scale, detail: `${round(hipsHeightM)} m` });
  return problems;
}

/** The verdict on a file's `facts` (null when it holds no skinned rig) and measured `rest` pose. */
export function characterVerdict(facts: CharacterFacts | null, rest: RestPose | null): CharacterVerdict {
  if (!facts) {
    const missingRoles = Object.values(CharacterRole);
    return {
      ok: false,
      failures: [{ code: CharacterFailure.NotRigged, detail: "no skinned mesh" }],
      roles: {},
      missingRoles,
    };
  }
  const roles: Partial<Record<CharacterRole, string>> = {};
  for (const clip of facts.clips) {
    const role = clipRole(clip.name);
    if (role && roles[role] === undefined) roles[role] = clip.name;
  }
  const failures = problemsOf(facts, rest);
  const missingRoles = Object.values(CharacterRole).filter((role) => roles[role] === undefined);
  return { ok: failures.length === 0, failures, roles, missingRoles };
}
