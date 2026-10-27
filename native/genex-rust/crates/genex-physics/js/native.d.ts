// Types of `native.js`, the `@genex-ai/physics-native` entry: Genex Physics (contract 1.0) in a
// process of its own per world. Its worlds are `@genex-ai/physics`'s own `World` (the same
// `index.d.ts`, shipped beside this file for its types).
import type * as Physics from "./index.d.ts";

export { PhysicsError } from "./index.d.ts";

/** The largest frame either side of the protocol sends, kind byte included. */
export declare const MAX_FRAME_BYTES: number;

/** How a core is started. */
export interface NativeCoreOptions {
  /** The `genex-physics-room` binary: an absolute path. */
  binaryPath: string;
  /** Its sha256, lowercase hex: checked before anything starts. */
  sha256: string;
  /** An existing folder: each core makes its own `room-*` folder in it and removes it when it ends. */
  dir: string;
  /** Each round trip's deadline, whole milliseconds 1-600000: past it the process is killed. */
  deadlineMs: number;
  /** The start's deadline (spawn, FIFOs, `Hello`), default 5000 ms. */
  startMs?: number;
  /** The process's stderr: dropped (default) or this process's own. */
  stderr?: "ignore" | "inherit";
}

/** One room tick, in one round trip (`NativeCore.runTick`). */
export interface TickInput {
  /** Command batches, each applied as `apply(batch, "each")`, in order. */
  batches?: Physics.Command[][];
  /** Whether to `step()` after them. */
  step?: boolean;
  /** `exportChanged(exportSince)` after the step. */
  exportSince?: number;
  /** `queryMany(queries)` after the export. */
  queries?: Physics.Query[];
}

/** What a tick did: each part exactly what its own call returns. */
export interface TickOutput {
  ok: true;
  /** The tick counter after the tick. */
  tick: number;
  /** One per batch: `apply(batch, "each")`'s result. */
  results: (Physics.CommandResult[] | Physics.Failure)[];
  /** `step()`'s result, when asked. */
  step?: Physics.Result<Physics.StepResult>;
  /** `exportChanged`'s result, when asked. */
  exported?: Physics.ChangedExport;
  /** `queryMany`'s result, when asked. */
  answers?: Physics.Result<Physics.QueryAnswer>[] | Physics.Failure;
  /** The process's own CPU time for the tick (`CLOCK_THREAD_CPUTIME_ID`), in nanoseconds. */
  cpuNs: number;
  /** The world's `stats().memoryBytes` after the tick (§11.1). */
  memoryBytes: number;
}

/** One physics process: one world. */
export interface NativeCore {
  /** The process id. */
  readonly pid: number;
  /** The process's build identity (§2), e.g. `genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+aarch64-macos`. */
  buildId(): string;
  /** Makes the core's one world (§4); a second world is `internal`. */
  createWorld(desc: Physics.WorldDesc): Physics.Result<{ world: Physics.World }>;
  /** One room tick on the world in one round trip; `internal` before `createWorld` or once the process ended. */
  runTick(input: TickInput): TickOutput | Physics.Failure;
  /** Whether the process still answers. */
  alive(): boolean;
  /** Whether the process's counting allocator measures the world's memory (§11.1). */
  memoryIsMeasured(): boolean;
  /**
   * Sets this side's deadline for every later round trip: whole milliseconds 1-600000, else false and
   * nothing changes. The process keeps its start's deadline, so start with a generous one for setup
   * frames and set a tick's before ticking.
   */
  setDeadline(ms: number): boolean;
  /** This side's current round-trip deadline, ms. */
  deadlineMs(): number;
  /** The process's CPU time over every frame so far, in nanoseconds. */
  cpuNs(): number;
  /** The last frame's CPU time, in nanoseconds. */
  lastCpuNs(): number;
  /** How many round trips completed. */
  frames(): number;
  /** Ends the process (its world then answers `internal`) and removes its folder. */
  close(): void;
}

/** Starts one physics process for one world; never throws. */
export declare function createNativeCore(options: NativeCoreOptions): Physics.Result<{ core: NativeCore }>;

/** `@genex-ai/physics`'s shape over native cores: one process per `World.create`. */
export interface NativePhysics {
  buildId(): string;
  PhysicsError: typeof Physics.PhysicsError;
  World: { create(desc: Physics.WorldDesc): Physics.Result<{ world: Physics.World }> };
}

/** `@genex-ai/physics`'s shape over native cores (a probe core reads the buildId first). */
export declare function nativePhysics(options: NativeCoreOptions): Physics.Result<{ physics: NativePhysics }>;

/** This host's binary folder name (`darwin-arm64`, `linux-x64-gnu`), or `undefined`. */
export declare function platformKey(): string | undefined;

/** This package's binary for this host and the sha256 its `binaries.json` records. */
export declare function packagedBinary(): { binaryPath: string; sha256: string } | undefined;

/** How many cores of this JS thread still hold a process. */
export declare function liveCores(): number;

/** How many processes this JS thread's watchdog has killed. */
export declare function watchdogKills(): number;
