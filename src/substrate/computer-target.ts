/**
 * The plug the `computer` tool drives. One interface for every kind of target — the studio's own
 * browser window, a game speaking the Genex Play Protocol, and later a window, desktop or VM —
 * so the tool, the session's rules and every AI provider stay the same while targets are added.
 *
 * Electron-free: implementations live beside what they wrap (`main/core/browser-preview-target.ts`,
 * `main/core/game-bridge-target.ts`); tests satisfy it with a plain object.
 */
import type { CaptureSurface, PreviewConsoleEntry, PreviewPixelStats } from "../shared/preview-contract.ts";
import type { InputRoute, TargetCapabilities } from "../shared/computer-target.ts";
import type { PreviewInputAction } from "./preview-input.ts";

export type { TargetCapabilities };

/** One picture of the target, in the tool's view space. */
export interface TargetShot {
  jpeg: Buffer;
  stats: PreviewPixelStats | null;
  /** What was photographed, when the target can tell; null when it cannot say. */
  surface: CaptureSurface | null;
}

/** A region of the view photographed at full size; coordinates stay those of the whole view. */
export interface TargetZoom {
  jpeg: Buffer;
  width: number;
  height: number;
  region: [number, number, number, number];
}

/** What a camera switch answered: refused names say which cameras exist. */
export interface TargetCameraAnswer {
  ok: boolean;
  reason?: string;
  available?: string[];
}

/** The target's clock, where it has one the studio can hold. */
export interface TargetClock {
  pause(): Promise<void>;
  start(): Promise<void>;
  /** Advance exactly `ms` and stop; the simulated milliseconds, or null when the target cannot step. */
  step?(ms: number): Promise<number | null>;
}

/** A named game action, held for a number of simulation ticks or pressed once. */
export interface TargetGameAction {
  action: string;
  state: "press" | "hold" | "release";
  ticks?: number;
}

/** A target the computer tool can drive. Optional members are abilities its capabilities declare. */
export interface ComputerTarget {
  readonly caps: TargetCapabilities;
  /** The pixel space of every screenshot and every coordinate the model gives. */
  viewSize(): { width: number; height: number };
  /** Where the pointer is, in view pixels; null when the target does not track one. */
  pointer(): { x: number; y: number } | null;
  screenshot(options: { quality: number; surface: CaptureSurface }): Promise<TargetShot>;
  /** The studio's input plan, carried out; how much of it landed and by which route. */
  input(actions: PreviewInputAction[]): Promise<{ applied: number; route: InputRoute }>;
  zoom?(region: [number, number, number, number], options: { surface: CaptureSurface }): Promise<TargetZoom>;
  /** The target's own state: the game's numbers, or an app's accessibility tree. */
  state?(): Promise<unknown>;
  clock?: TargetClock;
  /** Reseed the target so the same inputs replay the same run. */
  seed?(seed: number): Promise<void>;
  camera?(name: string): Promise<TargetCameraAnswer>;
  console?(sinceMs: number): PreviewConsoleEntry[];
  /** Named game actions ("jump"), where the target declares `actions`. */
  act?(actions: TargetGameAction[]): Promise<{ applied: number; route: InputRoute }>;
}

/** A target's load: the target, what went wrong, and what is worth saying about the setup. */
export interface TargetLoad<T extends ComputerTarget = ComputerTarget> {
  target: T;
  problem: string | null;
  note: string | null;
}
