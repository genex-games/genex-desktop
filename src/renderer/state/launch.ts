/**
 * A game started from home: the first message, on its way to the game it makes. Home sends it;
 * the game is named, made and opened (`launchGame` in `studio.ts`); then the game's own chat sends
 * the message as if it had been typed there, so every route a message can take (a plan to review,
 * a Loop, pictures) stays the chat's. While a launch is out the shell shows the chat and stage it
 * is becoming. A launch that fails gives its words back to home.
 *
 * Actions are pure `(state, input) => state` and ignore a step for any launch but the current one.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ComposerExtras } from "../ui/PromptBar.tsx";

/** Where a launch stands. */
export const LaunchPhase = {
  /** The model is naming the game. */
  Naming: "naming",
  /** The game is being made and its chat opened. */
  Opening: "opening",
  /** The chat is open and waits to send the message. */
  Opened: "opened",
  /** The chat has the message. */
  Handed: "handed",
} as const;
export type LaunchPhase = (typeof LaunchPhase)[keyof typeof LaunchPhase];

/** One game being started from home. */
export interface Launch {
  id: string;
  text: string;
  extras: ComposerExtras | undefined;
  /** When the message left home (`Date.now()`): what the stage's Planner writes from. */
  at: number;
  phase: LaunchPhase;
  title: string | null;
  project: string | null;
  threadId: string | null;
  /** The games the library listed when the message left home: a game listed since is the one it makes. */
  known: readonly string[];
}

export interface LaunchState {
  launch: Launch | null;
  /** A failed launch's words, waiting for home's composer to take them back. */
  returned: { text: string } | null;
  /**
   * The last game a launch opened, and when its message left home: the stage's Planner keeps
   * writing from that moment after the launch is over, so the page never starts again.
   */
  planning: { project: string; at: number } | null;
}

export const initialLaunch = (): LaunchState => ({ launch: null, returned: null, planning: null });

/** Is this the launch a step is for? */
const current = (state: LaunchState, id: string): state is LaunchState & { launch: Launch } => state.launch?.id === id;

/** A new launch replaces whatever home was holding. */
export function launchStarted(
  state: LaunchState,
  input: { id: string; text: string; extras: ComposerExtras | undefined; at: number; known: readonly string[] },
): LaunchState {
  return {
    ...state,
    launch: { ...input, phase: LaunchPhase.Naming, title: null, project: null, threadId: null },
    returned: null,
  };
}

export function launchNamed(state: LaunchState, id: string, title: string): LaunchState {
  if (!current(state, id)) return state;
  return { ...state, launch: { ...state.launch, phase: LaunchPhase.Opening, title } };
}

/** The game is made: the sidebar lists it under its own row from now on, while its chat opens. */
export function launchMade(state: LaunchState, id: string, project: string): LaunchState {
  if (!current(state, id)) return state;
  return { ...state, launch: { ...state.launch, project } };
}

export function launchOpened(
  state: LaunchState,
  id: string,
  opened: { project: string; threadId: string },
): LaunchState {
  if (!current(state, id)) return state;
  return {
    ...state,
    launch: { ...state.launch, phase: LaunchPhase.Opened, ...opened },
    planning: { project: opened.project, at: state.launch.at },
  };
}

/** The chat took the message; it is handed over once. */
export function launchHanded(state: LaunchState, id: string): LaunchState {
  if (!current(state, id) || state.launch.phase !== LaunchPhase.Opened) return state;
  return { ...state, launch: { ...state.launch, phase: LaunchPhase.Handed } };
}

/** The message is the chat's now: the launch is over. */
export function launchFinished(state: LaunchState, id: string): LaunchState {
  return current(state, id) ? { ...state, launch: null } : state;
}

/** The game could not be made: the launch is over, and its words go back to home. */
export function launchFailed(state: LaunchState, id: string): LaunchState {
  return current(state, id) ? { ...state, launch: null, returned: { text: state.launch.text } } : state;
}

/** Home's composer took the words back. */
export function returnTaken(state: LaunchState): LaunchState {
  return state.returned ? { ...state, returned: null } : state;
}

/** How the sidebar shows a launch: one row, a placeholder until its game is listed, then the game's own. */
export interface LaunchInSidebar {
  /** The placeholder row stands in for a game not made (or not listed) yet. */
  placeholder: boolean;
  title: string | null;
  /** The listed game the launch is becoming: its row looks selected and working. */
  project: string | null;
}

/** The sidebar's one row for a launch, given the games the library lists. */
export function launchInSidebar(launch: Launch | null, games: readonly { name: string }[]): LaunchInSidebar {
  if (!launch) return { placeholder: false, title: null, project: null };
  const project = launchedGame(launch, games);
  return { placeholder: project === null, title: launch.title, project };
}

/**
 * The listed game a launch is becoming: the one it made, or, while it is being made, the one game
 * listed since the launch started. Main lists and announces a new game before it hands it back,
 * so a library refresh can list it first.
 */
function launchedGame(launch: Launch, games: readonly { name: string }[]): string | null {
  const listed = games.map((game) => game.name);
  if (launch.project) return listed.includes(launch.project) ? launch.project : null;
  if (launch.phase !== LaunchPhase.Opening) return null;
  const since = listed.filter((name) => !launch.known.includes(name));
  return since.length === 1 ? (since[0] ?? null) : null;
}

export type LaunchStore = StoreApi<LaunchState>;

export function createLaunchStore(): LaunchStore {
  return createStore<LaunchState>()(() => initialLaunch());
}
