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
  mode: "each" | "atomic";
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
}

/** The build a vector must be pinned on: a buildId without its `+<target>` (§2, §16). */
export declare function buildWithoutTarget(buildId: string): string;

/** Runs one vector on the package's exports; never throws on a vector. */
export declare function runVector(physics: typeof Physics, vector: Vector): VectorOutcome;
