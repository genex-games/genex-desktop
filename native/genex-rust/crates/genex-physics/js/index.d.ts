// @genex-ai/physics: the TypeScript binding of the Genex Physics Layer 1 contract (CONTRACT.md, 1.0).
// Hand-written to match the contract; the WASM glue under it is generated. Section numbers (§) are the
// contract's. Every failure is a value (§1.5, §14): no method throws on any input.

/** A caller key: 1-64 bytes of [A-Za-z0-9_.:-], not `__proto__`/`constructor`/`prototype` (§3). */
export type Key = string;
/** A vector in the caller frame (§5). */
export type Vec3 = [number, number, number];
/** A unit quaternion `[x, y, z, w]` in the caller frame. */
export type Quat = [number, number, number, number];
/** A position and rotation in the caller frame. */
export interface Pose {
  p: Vec3;
  q: Quat;
}

/** The error vocabulary (§14). Callers branch on these codes, never on `detail`. */
export declare const PhysicsError: {
  readonly InvalidKey: "invalid-key";
  readonly DuplicateKey: "duplicate-key";
  readonly UnknownKey: "unknown-key";
  readonly NonFinite: "non-finite";
  readonly OutOfRange: "out-of-range";
  readonly BadShape: "bad-shape";
  readonly DynamicMesh: "dynamic-mesh";
  readonly WrongBodyType: "wrong-body-type";
  readonly BadCommand: "bad-command";
  readonly LimitBodies: "limit-bodies";
  readonly LimitColliders: "limit-colliders";
  readonly LimitHullVertices: "limit-hull-vertices";
  readonly LimitTriangles: "limit-triangles";
  readonly LimitJoints: "limit-joints";
  readonly LimitCcd: "limit-ccd";
  readonly LimitQueries: "limit-queries";
  readonly LimitStatic: "limit-static";
  readonly LimitMemory: "limit-memory";
  readonly BadSnapshot: "bad-snapshot";
  readonly BuildMismatch: "build-mismatch";
  readonly ContractMismatch: "contract-mismatch";
  readonly Internal: "internal";
};
/** One error code. */
export type PhysicsError = (typeof PhysicsError)[keyof typeof PhysicsError];

/** A failed call: nothing changed (§1.5). `index` names the failing command of an atomic batch. */
export interface Failure {
  ok: false;
  code: PhysicsError;
  index?: number;
  detail: string;
}
/** A call's result: `{ ok: true, ...value }` or a `Failure`. */
export type Result<T extends object = Record<never, never>> = ({ ok: true } & T) | Failure;

/** The limits of one world (§11). A caller may lower any, and raise each up to 4x its default. */
export interface Limits {
  bodies: number;
  collidersPerBody: number;
  hullVertices: number;
  triangles: number;
  joints: number;
  ccdBodies: number;
  queriesPerStep: number;
  eventsPerStep: number;
  heightfieldSamples: number;
  staticPieces: number;
  memoryBytes: number;
  worldExtent: number;
  maxSpeed: number;
  maxAngularSpeed: number;
}

/** A world's fixed description (§4). */
export interface WorldDesc {
  contract: "1.0";
  dt: number;
  substeps: number;
  gravity: Vec3;
  upAxis: "y" | "z";
  lengthUnit: number;
  limits?: Partial<Limits>;
  solver?: { iterations?: number };
}

/** Collision groups: 16-bit masks (§6.2). */
export interface Groups {
  member: number;
  collides: number;
}

/** A collider shape (§6.2). */
export type Shape =
  | { kind: "box"; half: Vec3 }
  | { kind: "sphere"; radius: number }
  | { kind: "capsule"; halfHeight: number; radius: number; axis: "x" | "y" | "z" }
  | { kind: "hull"; points: Vec3[] }
  | { kind: "trimesh"; vertices: Vec3[]; indices: [number, number, number][] }
  | { kind: "heightfield"; rows: number; cols: number; heights: number[]; size: Vec3 };

/** One collider of a body (§6.2). */
export interface ColliderDesc {
  key: Key;
  shape: Shape;
  offset?: Pose;
  density?: number;
  mass?: number;
  friction?: number;
  restitution?: number;
  groups?: Groups;
  sensor?: boolean;
  events?: boolean;
}

/** The body types (§6.1). */
export type BodyType = "dynamic" | "fixed" | "kinematic";

/** A body to spawn (§6.1). */
export interface BodyDesc {
  key: Key;
  type: BodyType;
  pose: Pose;
  linvel?: Vec3;
  angvel?: Vec3;
  colliders: ColliderDesc[];
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  lockRotation?: [boolean, boolean, boolean];
  ccd?: boolean;
  canSleep?: boolean;
  kind?: string;
}

/** A joint motor's targets (§6.4). */
export interface Motor {
  targetVel?: number;
  targetPos?: number;
  stiffness?: number;
  damping?: number;
  maxForce?: number;
}

/** A joint (§6.4). `b: null` attaches to the world. */
export interface JointDesc {
  key: Key;
  a: Key;
  b: Key | null;
  type: "fixed" | "hinge" | "ball" | "slider" | "rope";
  anchorA: Vec3;
  anchorB: Vec3;
  axis?: Vec3;
  limits?: [number, number];
  motor?: Motor;
  collideConnected?: boolean;
}

/** PROTOCOL §17.7's World: boxes `[minX, minY, minZ, maxX, maxY, maxZ]`, ramps add `axis, lo, hi` (§6.5). */
export interface StaticWorld {
  boxes: number[][];
  ramps: number[][];
}

/** `setPose` options (§7). */
export interface SetPoseOptions {
  resetVelocity?: boolean;
  wake?: boolean;
}

/** A command in its JSON form (§7.3): one key, the verb, to its named arguments. */
export type Command =
  | { spawn: BodyDesc }
  | { remove: { key: Key } }
  | { addJoint: JointDesc }
  | { removeJoint: { key: Key } }
  | { impulse: { key: Key; j: Vec3; at?: Vec3 } }
  | { setVelocity: { key: Key; linvel?: Vec3; angvel?: Vec3 } }
  | { setPose: { key: Key; pose: Pose } & SetPoseOptions }
  | { setNextKinematicPose: { key: Key; pose: Pose } }
  | { areaPush: { center: Vec3; radius: number; strength: number; falloff: number; groups?: Groups } }
  | { setMotor: { key: Key; motor: Motor } }
  | { wake: { key: Key } }
  | { sleep: { key: Key } };

/** One command's outcome in an `"each"` batch (§7.1). */
export type CommandResult = { ok: true } | { ok: false; code: PhysicsError };

/** A contact or trigger event (§8.1). */
export type PhysicsEvent =
  | {
      kind: "contactBegin";
      a: Key;
      b: Key;
      ca: Key;
      cb: Key;
      ka?: string;
      kb?: string;
      impulse: number;
      point: Vec3;
      normal: Vec3;
    }
  | { kind: "contactEnd"; a: Key; b: Key; ca: Key; cb: Key; ka?: string; kb?: string }
  | { kind: "triggerEnter"; sensor: Key; sc: Key; other: Key; oc: Key; ks?: string; ko?: string }
  | { kind: "triggerExit"; sensor: Key; sc: Key; other: Key; oc: Key; ks?: string; ko?: string };

/** What one `step()` produced (§8). */
export interface StepResult {
  tick: number;
  events: PhysicsEvent[];
  overflowed: boolean;
  escaped: Key[];
  memoryExceeded: boolean;
}

/** A body's state in the caller frame (§9.1). */
export interface BodyState {
  key: Key;
  kind?: string;
  type: BodyType;
  pose: Pose;
  linvel: Vec3;
  angvel: Vec3;
  sleeping: boolean;
}

/** The replicated fields of a body (§9.2). */
export interface NetBodyState {
  p: Vec3;
  q: Quat;
  v: Vec3;
  w: Vec3;
  sleeping: boolean;
}

/** Which bodies `bodies()` lists (§9.1). */
export interface BodyFilter {
  kinds?: string[];
  awakeOnly?: boolean;
  changedSinceTick?: number;
}

/** The flat per-tick read (§9.1): 14 numbers per body in `keys` order (p3 q4 v3 w3 sleeping1). */
export interface ChangedExport {
  keys: Key[];
  data: Float32Array;
}

/** A query filter (§13). */
export interface QueryFilter {
  groups?: Groups;
  excludeBodies?: Key[];
  includeSensors?: boolean;
}

/** A ray or shape-cast hit (§13). */
export interface Hit {
  body: Key;
  collider: Key;
  dist: number;
  point: Vec3;
  normal: Vec3;
}

/** A query in its JSON form (§13). */
export type Query =
  | { ray: { origin: Vec3; dir: Vec3; maxDist: number; filter?: QueryFilter } }
  | { shapeCast: { shape: Shape; pose: Pose; dir: Vec3; maxDist: number; filter?: QueryFilter } }
  | { overlap: { shape: Shape; pose: Pose; filter?: QueryFilter } };

/** A query's answer: a hit (or none) for ray and shapeCast, body keys for overlap. */
export type QueryAnswer = { hit: Hit | null } | { keys: Key[] };

/** The world's counters (§11). `stepMs` is wall time for display only. */
export interface Stats {
  tick: number;
  bodies: number;
  awake: number;
  colliders: number;
  joints: number;
  contactPairs: number;
  queriesThisStep: number;
  stepMs: number;
  memoryBytes: number;
}

/** Loads the WASM module once; later calls resolve at once (§15). */
export declare function init(input?: { module?: WebAssembly.Module | BufferSource }): Promise<void>;

/** This build's identity (§2), e.g. `genex-physics/1.0.0+contract-1.0+rapier-0.36.0+det+wasm32`. */
export declare function buildId(): string;

/**
 * One physics world. Make it with `World.create`; release it with `free()`.
 *
 * If the WASM instance traps (§11.3), every call with a `Result` returns `internal` on every world,
 * and the reads with no error channel return their empty forms (`null`, `[]`, an empty export or
 * snapshot, zero stats, `""` hashes, tick 0); `check()` names the failure. `desc()` stays readable.
 */
export declare class World {
  private constructor();
  /** Validates `desc` and makes a world (§4); a failure creates nothing. */
  static create(desc: WorldDesc): Result<{ world: World }>;
  /** The resolved description, every default filled (§4). */
  desc(): Required<Omit<WorldDesc, "limits" | "solver">> & { limits: Limits; solver: { iterations: number } };
  /** The world's tick counter: 0 until the first step. */
  readonly tick: number;
  /** `internal` when the world failed, was freed or its instance trapped (§11.3), else `{ ok: true }`. */
  check(): Result;

  addStaticWorld(world: StaticWorld): Result;
  spawn(desc: BodyDesc): Result;
  remove(key: Key): Result;
  addJoint(desc: JointDesc): Result;
  removeJoint(key: Key): Result;
  impulse(key: Key, j: Vec3, at?: Vec3): Result;
  setVelocity(key: Key, linvel?: Vec3, angvel?: Vec3): Result;
  setPose(key: Key, pose: Pose, options?: SetPoseOptions): Result;
  setNextKinematicPose(key: Key, pose: Pose): Result;
  areaPush(center: Vec3, radius: number, strength: number, falloff: number, groups?: Groups): Result;
  setMotor(jointKey: Key, motor: Motor): Result;
  wake(key: Key): Result;
  sleep(key: Key): Result;
  /** Applies commands in order (§7.1): all or none. */
  apply(commands: Command[], mode: "atomic"): Result;
  /** Applies every command that succeeds, in order, one result per command (§7.1). */
  apply(commands: Command[], mode: "each"): CommandResult[];

  /** Advances `dt` in `substeps` inner steps (§8). Fails only with `internal` (§11.3). */
  step(): Result<StepResult>;

  body(key: Key): BodyState | null;
  bodies(filter?: BodyFilter): BodyState[];
  exportChanged(sinceTick: number): ChangedExport;
  exportBodyState(key: Key): NetBodyState | null;
  importBodyState(key: Key, state: NetBodyState): Result;

  ray(origin: Vec3, dir: Vec3, maxDist: number, filter?: QueryFilter): Result<{ hit: Hit | null }>;
  shapeCast(shape: Shape, pose: Pose, dir: Vec3, maxDist: number, filter?: QueryFilter): Result<{ hit: Hit | null }>;
  overlap(shape: Shape, pose: Pose, filter?: QueryFilter): Result<{ keys: Key[] }>;
  /** Runs one query in its JSON form (§13). */
  query(query: Query): Result<QueryAnswer>;

  /** The opaque snapshot (§9.4); empty when the world failed (§11.3). */
  snapshot(): Uint8Array;
  /** Replaces the whole world from a snapshot of the same build (§9.4). */
  restore(bytes: Uint8Array): Result;

  /** 16 lowercase hex digits (§10.1). */
  stateHash(): string;
  /** 16 lowercase hex digits (§10.2). */
  physicsHash(): string;
  stats(): Stats;
  /** Releases the world's memory. Every later call on it fails with `internal`. */
  free(): void;
}
