/**
 * What a chat and a run are told about a Loop on a project that isn't a web game (an open Loop):
 * the chat's own session leads it in the game folder, workers work in copies, and a reviewer who did
 * none of the work checks its finish. No builders and no judges: those are a web game's Loop. A
 * module new to the seed, so the shipped launch words and run dispatch take these from here.
 */
import { MAX_RUN_HOURS } from "./config.ts";

/** How long an open Loop runs, as the chat reads it: until a reviewer accepts its finish, or its hours. */
function openBudgetWords(hours: number | null | undefined): string {
  if (typeof hours === "number" && hours > 0) return `up to ${hours} h`;
  return `until a reviewer accepts the finish, ${MAX_RUN_HOURS} h at most`;
}

/** What a build is on a project that isn't a web game, as a Loop chat is told. */
export function openBuildWords(hours: number | null | undefined): string {
  return `the Loop: the lead builds the whole project itself in this folder, with workers in copies of it, and a reviewer who did none of the work checks its finish (${openBudgetWords(hours)})`;
}

/** A hurry changes how long an open Loop runs, never whether a new project is one. */
export const OPEN_QUICK_IS_A_BUILD = "also when they want it fast: a quick build is still a build";

/** The stills a commission carries, as an open Loop's chat is told: its lead reads them. */
export function openStillsWords(frames: number): string {
  return `The user attached ${frames} still(s); the build's lead receives them automatically.`;
}

/**
 * When a Loop on a project that isn't a web game ends, as the chat promises it at launch: a reviewer's
 * yes on the lead's finish within its safety stop (∞), or its hours. No connection to add: it works
 * in place, and a reviewer checks it.
 */
export const OPEN_LAUNCH_WORDS = {
  untilFinish: (ceiling: string) =>
    `It finishes when a reviewer accepts the lead's finish, with a safety stop by about ${ceiling} — keep the app open and the Mac awake. `,
  /** What the launch tool answers for an ∞ Loop on such a project. */
  building: `Building until a reviewer accepts the finish, ${MAX_RUN_HOURS} h at most`,
} as const;

/** Why a run on a project that isn't a web game did not start, as its close and the chat say it. */
export const OPEN_LOOP_REFUSAL = {
  /** `found`: what Genex found that makes the project's Loop work in place (`openLoopBecause`). */
  needsSession: (engine: string, found?: string) =>
    `A Loop on this project${found ? ` (Genex finds ${found})` : ""} needs an engine that works as an agent in the project's folder (Claude Code, Codex or OpenCode); ${engine} doesn't, so nothing was built.`,
  webOnly: "This kind of run works on web games only; a Loop on this project is led by the chat's own session.",
  openLoopNeedsUpdate:
    "This harness's edited Loop files predate Loops on any project; update them, then start the Loop again.",
  /** A paused web Loop, resumed on a folder that reads as no web game now; `found`: what Genex finds there. */
  webElsewhere: (found: string) =>
    `This Loop was paused as a web game's Loop, and the folder doesn't read as a web game now (Genex finds ${found}), so it can't go on now. It stays paused: once the folder reads as a web game again (move those files out of it, say), Resume picks it up.`,
  /** A finished web game's Loop whose folder doesn't read as a web game now: its build can't go on there. */
  webBuildElsewhere:
    "this build was a web game's Loop, and the folder doesn't read as a web game now, so it can't go on: send the Loop again to start a new one on the project as it is.",
  /** A finished web Loop's folder Genex can't read now, or holds files of a kind it doesn't know. */
  folderUnknown:
    "this build can't go on now: Genex can't tell what its folder holds (it can't read it, or it holds files of a kind Genex doesn't know). Say in the chat what the project is, or turn on a Genex plugin for it.",
  /** The list of projects could not be read, so nothing tells which Loop the project needs. */
  gamesUnreadable:
    "Genex couldn't read the list of projects, so it can't tell which kind of Loop this project needs; nothing was built or changed. Try again in a moment.",
  /** A paused Loop's journal could not be read, so nothing tells how it goes on. */
  journalUnreadable:
    "Genex couldn't read this Loop's journal, so it can't tell how the Loop goes on; nothing was built. It stays paused: Resume tries again.",
  /** A finished Loop that worked in the game folder itself is never reopened. */
  notReopenable:
    "this Loop worked in the game folder itself, so there is no build to go on from: send the Loop again to start the next one.",
} as const;
