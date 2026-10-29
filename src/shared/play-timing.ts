/**
 * Where a person's Play spends its time, from the click to the first frame (lane PW): one record
 * per Play, its stages in the order they were reached, each with how long after the click it ended
 * and how long it took itself. Main keeps the last few (`PlayTimings`) and writes each record to the
 * Studio log as it ends, so a slow Play says which stage held it.
 */
import type { BuildTarget } from "./game-project.ts";

/** One stage of a Play. Wire values: the Studio log and the diagnostics record name them. */
export const PlayStage = {
  /** The click reached main. */
  Request: "request",
  /** The build copy Play serves was made, or one of the same commit was found. */
  Copy: "copy",
  /** The person's hidden window (or native lease) was taken. */
  Window: "window",
  /** The build waited for its turn: a build slot, the shared target, or a build of the same folder already under way. */
  BuildQueue: "build-queue",
  /** The build folder's target was seeded (a copy's or the store's prewarm clone). */
  BuildSeed: "build-seed",
  /** One step of the build ran (its name is the mark's detail). */
  BuildStep: "build-step",
  /** An admitted build of the same content was served, so nothing was built. */
  BuildReused: "build-reused",
  /** The build answered. */
  Built: "built",
  /** The build booted in the person's hidden window before Live was given it. */
  Candidate: "candidate",
  /** Live was given the page (or the native run started). */
  Served: "served",
  /** The page reached a boot stage of its own (its name is the mark's detail: wasm, assets, pipelines, frame). */
  PageStage: "page-stage",
  /** The first frame: the web page's loading screen left, or the embedded run answered ready. */
  FirstFrame: "first-frame",
  /** The Play ended without a frame (the mark's detail says why). */
  Failed: "failed",
} as const;
export type PlayStage = (typeof PlayStage)[keyof typeof PlayStage];

/** One stage reached: when (ms after the click), how long it took itself, and what it was about. */
export interface PlayMark {
  stage: PlayStage;
  /** Milliseconds from the click to the end of this stage. */
  at: number;
  /** How long the stage itself took. */
  ms: number;
  detail: string | null;
}

/** One Play's record. */
export interface PlayTiming {
  id: string;
  project: string;
  /** The view it played in: the browser build, or the host's desktop build in Live's Native view. */
  target: BuildTarget;
  /** The build Play asked for, by commit; null for the game folder. */
  commit: string | null;
  /** Wall-clock start (epoch ms). */
  startedAt: number;
  marks: PlayMark[];
  /** Milliseconds from the click to its end; null while it runs. */
  totalMs: number | null;
}

/** What a build lane tells a Play about its own wait and steps: a stage, its own length, and what it was. */
export type PlayTimingSink = (stage: PlayStage, ms: number, detail?: string) => void;

/** A Play record as one Studio log line: `project target commit: stage +at (ms) · …`. */
export function playTimingLine(timing: PlayTiming): string {
  const head = `${timing.project} ${timing.target}${timing.commit ? ` ${timing.commit.slice(0, 12)}` : ""}`;
  const marks = timing.marks.map((mark) => {
    const name = mark.detail ? `${mark.stage}:${mark.detail}` : mark.stage;
    return `${name} +${mark.at}ms (${mark.ms}ms)`;
  });
  const total = timing.totalMs === null ? "running" : `${timing.totalMs}ms`;
  return `${head} ${total}: ${marks.join(" · ")}`;
}
