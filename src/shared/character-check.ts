/**
 * What the engine's character check reports about a generated humanoid: the wire contract between
 * genex-anim's `character_check` example (Rust, `native/genex-rust/crates/genex-anim/examples`) and
 * the import and validation tooling. A character with any diagnostic does not reach a game: the
 * import side fixes it, swaps clips or regenerates, guided by each diagnostic's cause.
 */

/** Why a character or one of its clips fails, as the engine spells it. */
export const CharacterCheckCode = {
  BoneMissing: "bone-missing",
  ClipNonFinite: "clip-nonfinite",
  LimbStretch: "limb-stretch",
  TorsoCollapse: "torso-collapse",
  LimbsKnotted: "limbs-knotted",
  FeetFloating: "feet-floating",
  FeetSunk: "feet-sunk",
  HandsOffWeapon: "hands-off-weapon",
  ClipRoleMissing: "clip-role-missing",
  ClipUnreadable: "clip-unreadable",
} as const;
export type CharacterCheckCode = (typeof CharacterCheckCode)[keyof typeof CharacterCheckCode];

/** Where to look first when a check fails. */
export const CharacterCheckCause = {
  BadRig: "bad-rig",
  WrongPose: "wrong-pose",
  BoneMismatch: "bone-mismatch",
} as const;
export type CharacterCheckCause = (typeof CharacterCheckCause)[keyof typeof CharacterCheckCause];

/** What a clip is for; a playable character fills all nine. */
export const ClipRole = {
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
export type ClipRole = (typeof ClipRole)[keyof typeof ClipRole];

/** One finding: the worst frame of one problem on one bone of one clip. */
export interface CharacterCheckDiagnostic {
  code: CharacterCheckCode;
  cause: CharacterCheckCause;
  /** The clip's name; empty for a finding about the rig or a role. */
  clip: string;
  /** The role the clip fills (or the role no clip fills), when it has one. */
  role: ClipRole | null;
  /** The worst frame's time, seconds. */
  time: number;
  /** The humanoid bone the problem is on, as the engine names it ("LeftLowerArm"). */
  bone: string | null;
  /** What was measured, and the limit it crossed, in the same unit (a ratio, degrees or metres). */
  value: number | null;
  limit: number;
}

/** The engine's verdict on one character. */
export interface CharacterCheckReport {
  /** The character's model file, as given. */
  file: string;
  /** The rig family the bone map used. */
  profile: string;
  /** Humanoid bone to joint name. */
  mapped: Record<string, string>;
  /** Required bones the rig lacks. */
  missingBones: string[];
  /** Role to the name of the clip that fills it; null when none does. */
  roles: Record<ClipRole, string | null>;
  diagnostics: CharacterCheckDiagnostic[];
  /** No diagnostic: the character may reach a game. */
  pass: boolean;
}

/** The example's exit codes: 0 passes, 1 fails the check, 2 could not read the model. */
export const CharacterCheckExit = { Pass: 0, Fail: 1, Unreadable: 2 } as const;
