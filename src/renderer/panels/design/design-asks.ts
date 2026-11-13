/**
 * What the app keeps of the design board outside its tab: whether the board holds something the
 * person has not seen (the tab's mark), which artboard the tab was asked to bring into view (and
 * where on it the agent points), and which artboards the agent said it is making. Small on purpose:
 * the stage and the shell load it with the app, the canvas (`design-model.ts`, `DesignStage.tsx`)
 * only when Design opens.
 */
import type { DesignSpot } from "../../../shared/design-board.ts";

/** Whether a board holds something the person has not seen: it has artboards, and changed since they last looked. */
export function boardIsNew(board: { pages: number; stamp: string }, seen: string | null): boolean {
  return board.pages > 0 && board.stamp !== seen;
}

/** What the agent said of the artboard it asked for: the spot it points at, and its few words. */
export interface PagePoint {
  spot?: DesignSpot;
  note?: string;
}

/** A page the tab was asked to bring into view (a link in the chat, the agent's `show_design`), for one game. */
interface PageAsked extends PagePoint {
  project: string;
  file: string;
}

/** The window event that says a page was asked for while the tab is open. */
export const DESIGN_FOCUS_EVENT = "studio:design-focus";

let asked: PageAsked | null = null;

/** Ask the Design tab to bring a page into view: kept for a tab that opens later, announced to one that is open. */
export function askForPage(project: string, file: string, point: PagePoint = {}): void {
  asked = { project, file, ...point };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DESIGN_FOCUS_EVENT));
}

/**
 * The page asked for on this game's board, with what the agent said of it, taken once it is one of
 * the board's `files`; null until then, or when none was.
 */
export function takeAskedPage(project: string, files: readonly string[]): ({ file: string } & PagePoint) | null {
  if (asked?.project !== project || !files.includes(asked.file)) return null;
  const { project: _project, ...taken } = asked;
  asked = null;
  return taken;
}

/** The artboards a game's agent said it is about to make, and when it said so. */
export interface MakingSaid {
  files: string[];
  at: number;
}

/** The window event that says an agent named what it is making. */
export const DESIGN_MAKING_EVENT = "studio:design-making";

const making = new Map<string, MakingSaid>();

/** Keep what a game's agent said it is making; its newest list is the one that counts. */
export function noteMaking(project: string, files: string[], at: number): void {
  making.set(project, { files, at });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DESIGN_MAKING_EVENT));
}

/** What a game's agent last said it is making; null when it said nothing. */
export const makingOn = (project: string): MakingSaid | null => making.get(project) ?? null;
