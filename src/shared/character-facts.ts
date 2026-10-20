/**
 * Character facts (game systems C-23): what a rigged GLB holds, as `assets.inventory` reports it
 * on `ProjectAsset.import.character`, so an agent reads the clip and joint names before it writes
 * animation graph code instead of guessing them. The importer reads them from the GLB it wrote
 * (`substrate/asset-import/character-facts.ts`, in its sandbox); the host checks the receipt's copy
 * against these caps and vocabularies (`parseCharacterFacts`) before an agent sees it.
 * Types, vocabularies and the check only. Browser-safe.
 */

/** How a clip moves its character. Wire values in `assets.inventory`: never rename one. */
export const ClipMotion = {
  /** The root stays where it is (within a tenth of the hips' height): the game moves the character. */
  InPlace: "in-place",
  /** The root travels: the clip carries the character's motion (read it as root motion). */
  RootMotion: "root-motion",
} as const;
export type ClipMotion = (typeof ClipMotion)[keyof typeof ClipMotion];

/** The bones a humanoid rig must have (the alias table's `bones`, genex-anim's `HUMANOID_BONES`). */
export const HUMANOID_REQUIRED_BONES = 22;
/** The most clips one character's facts list; `clipCount` says how many the file has. */
export const CHARACTER_CLIPS_MAX = 256;
/** The longest clip name the facts carry: a longer one is left out, since a cut name names nothing. */
export const CHARACTER_CLIP_NAME_MAX_CHARS = 256;
/** The most joints a skeleton has (genex-anim's `MAX_JOINTS`). */
export const CHARACTER_JOINTS_MAX = 256;
/** The longest clip the facts accept, in seconds: a day of animation is not a clip. */
const CLIP_SECONDS_MAX = 24 * 60 * 60;
/** The most drawn levels a skinned mesh has: its own triangles and the LOD chain (`LOD_MAX_LEVELS`). */
export const CHARACTER_LEVELS_MAX = 1 + 4;
/** The longest rig family id the facts carry (the alias table's `id`, `ue-mannequin`). */
const RIG_ID_MAX_CHARS = 64;
/** A rig family id: lowercase words joined by `-`. */
const RIG_ID = /^[a-z][a-z0-9-]*$/;

/** One clip of a rigged GLB: its name as the runtime knows it, its length and how it moves. */
export interface CharacterClip {
  /** The glTF animation's name (empty when the file gives none): what `AnimGraph` code names. */
  name: string;
  /** The clip's length: its last key time, rounded to the millisecond. */
  seconds: number;
  motion: ClipMotion;
}

/** How much of the humanoid profile a rig maps, under the rig family that maps the most. */
export interface HumanoidCoverage {
  /** The alias table's family id the joint names matched (`mixamorig`, `ue-mannequin`, …). */
  rig: string;
  /** Required bones the rig has. */
  mapped: number;
  /** Required bones in all: {@link HUMANOID_REQUIRED_BONES}. */
  required: number;
  /** The required bones it lacks, in profile order (Godot `SkeletonProfileHumanoid` names). */
  missing: string[];
}

/** A rigged GLB's facts: its skeleton, clips, humanoid coverage and skinned levels. */
export interface CharacterFacts {
  /** Joints in the skeleton of the first skinned mesh node, the nodes between two joints included. */
  joints: number;
  /** The clips in file order, at most {@link CHARACTER_CLIPS_MAX}. */
  clips: CharacterClip[];
  /** The clips the file has, listed or not. */
  clipCount: number;
  humanoid: HumanoidCoverage;
  /** The levels the skinned mesh draws at: 1, plus its import-time LODs (which keep its skin). */
  skinnedLevels: number;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const MOTIONS: readonly unknown[] = Object.values(ClipMotion);

function parseClip(value: unknown): CharacterClip | null {
  if (!isRecord(value)) return null;
  const { name, seconds, motion } = value;
  const named = typeof name === "string" && name.length <= CHARACTER_CLIP_NAME_MAX_CHARS;
  const timed = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= CLIP_SECONDS_MAX;
  if (!named || !timed || !MOTIONS.includes(motion)) return null;
  return { name, seconds, motion: motion as ClipMotion };
}

function parseHumanoid(value: unknown, bones: readonly string[]): HumanoidCoverage | null {
  if (!isRecord(value)) return null;
  const { rig, mapped, required, missing } = value;
  const rigValid = typeof rig === "string" && rig.length <= RIG_ID_MAX_CHARS && RIG_ID.test(rig);
  if (!rigValid || required !== HUMANOID_REQUIRED_BONES || !isCount(mapped, HUMANOID_REQUIRED_BONES)) return null;
  if (!Array.isArray(missing) || missing.length !== HUMANOID_REQUIRED_BONES - mapped) return null;
  const known = missing.every((bone) => typeof bone === "string" && bones.includes(bone));
  if (!known || new Set(missing).size !== missing.length) return null;
  return { rig, mapped, required, missing: missing as string[] };
}

/**
 * A receipt's character facts, checked: every count inside its cap, every clip's motion and every
 * missing bone from its vocabulary (`bones`, the alias table's), the clip list no longer than the
 * file's count; null for anything else, so a hostile receipt never reaches an agent.
 */
export function parseCharacterFacts(value: unknown, bones: readonly string[]): CharacterFacts | null {
  if (!isRecord(value)) return null;
  const { joints, clips, clipCount, humanoid, skinnedLevels } = value;
  const counts =
    isCount(joints, CHARACTER_JOINTS_MAX) &&
    joints > 0 &&
    isCount(clipCount, Number.MAX_SAFE_INTEGER) &&
    isCount(skinnedLevels, CHARACTER_LEVELS_MAX);
  if (!counts || !Array.isArray(clips) || clips.length > Math.min(clipCount, CHARACTER_CLIPS_MAX)) return null;
  const parsedClips = clips.map(parseClip);
  const coverage = parseHumanoid(humanoid, bones);
  if (!coverage || parsedClips.some((clip) => clip === null)) return null;
  return { joints, clips: parsedClips as CharacterClip[], clipCount, humanoid: coverage, skinnedLevels };
}
