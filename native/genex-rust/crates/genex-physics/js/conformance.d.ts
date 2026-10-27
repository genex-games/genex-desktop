// Types of `conformance.js`, the §16 conformance-vector runner (not packed).
import type * as Physics from "./index.d.ts";

/** The vector format's contract (§16). */
export declare const VECTOR_CONTRACT: "1.0";

/** One entry of a vector's `steps` (§16). */
export interface VectorStep {
  snapshotRestore?: boolean;
  apply?: Physics.Command[];
  query?: Physics.Query[];
  repeat?: number;
  expect?: Record<string, unknown>;
}

/** A conformance vector as `vectors/*.json` holds it (§16). */
export interface Vector {
  contract: string;
  build: string;
  name: string;
  world: Physics.WorldDesc;
  static: Physics.StaticWorld;
  /** Absent means "each" (§16). */
  mode?: "each" | "atomic";
  steps: VectorStep[];
}

/** What running one vector found. */
export interface VectorOutcome {
  /** Every pinned value that differs, or why the vector was refused; empty when it passes. */
  problems: string[];
  /** How many pinned values were compared. */
  checks: number;
  /** The world's last stateHash ("" when no world ran). */
  stateHash: string;
  /** The first step with a mismatch: its full `bodies()` dump, and the first body differing from the reference dump, if one was given. */
  firstMismatch?: { step: number; bodies: Physics.BodyState[]; differingBody?: string };
}

/** How to run a vector. */
export interface RunOptions {
  /** Reference `bodies()` dumps by step index (the native runner's `GENEX_PHYSICS_WRITE_BODIES` file). */
  reference?: Record<number, Physics.BodyState[]>;
}

/** The key of the first body, in key order, that differs between two dumps (numbers as f32); undefined when they match. */
export declare function firstDifferingBody(
  ours: Physics.BodyState[],
  reference: Physics.BodyState[],
): string | undefined;

/** The build a vector must be pinned on: a buildId without its `+<target>` (§2, §16). */
export declare function buildWithoutTarget(buildId: string): string;

/** Runs one vector on the package's exports; never throws on a vector. */
export declare function runVector(physics: typeof Physics, vector: Vector, options?: RunOptions): VectorOutcome;
