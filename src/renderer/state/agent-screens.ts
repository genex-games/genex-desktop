/**
 * Agent screens (computer use): the newest frame of every window an agent is driving, fed by
 * `preview.frame` and closed by `preview.screen`, and each window's last few frames as a trail.
 * The Builds graph shows a part's worker on that part's node and the lead on the lead's; the
 * list is kept sorted by label.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentScreenFrame, AgentScreenRole } from "../../shared/agent-screen.ts";

/** How many frames a window's trail keeps, the newest included: what a selected node's card steps through. */
export const TRAIL_FRAMES = 6;

export interface AgentScreensState {
  frames: AgentScreenFrame[];
  /** Each open window's recent frames, oldest first; the last is its newest. */
  trails: Readonly<Record<string, readonly AgentScreenFrame[]>>;
}

const NO_TRAIL: readonly AgentScreenFrame[] = [];

/** The same agent at the same work: a pooled window lent to someone else starts a new trail. */
const sameAgent = (a: AgentScreenFrame, b: AgentScreenFrame): boolean =>
  a.label === b.label && a.runId === b.runId && a.facetId === b.facetId;

/** A window's trail with one more frame, at most {@link TRAIL_FRAMES} long. */
function extendTrail(trail: readonly AgentScreenFrame[], frame: AgentScreenFrame): readonly AgentScreenFrame[] {
  const last = trail.at(-1);
  if (last === frame) return trail;
  const kept = last && sameAgent(last, frame) ? trail : NO_TRAIL;
  return [...kept, frame].slice(-TRAIL_FRAMES);
}

/** A window's newest frame replaces its last one and joins its trail. */
export function frameReceived(state: AgentScreensState, frame: AgentScreenFrame): AgentScreensState {
  const trails = { ...state.trails, [frame.handle]: extendTrail(state.trails[frame.handle] ?? NO_TRAIL, frame) };
  const index = state.frames.findIndex((screen) => screen.handle === frame.handle);
  if (index >= 0 && state.frames[index]?.label === frame.label) {
    if (state.frames[index] === frame) return state;
    const frames = [...state.frames];
    frames[index] = frame;
    return { frames, trails };
  }
  const rest = state.frames.filter((screen) => screen.handle !== frame.handle);
  return { frames: [...rest, frame].sort((a, b) => a.label.localeCompare(b.label)), trails };
}

export function screenClosed(state: AgentScreensState, handle: string): AgentScreensState {
  const frames = state.frames.filter((screen) => screen.handle !== handle);
  if (frames.length === state.frames.length && !state.trails[handle]) return state;
  const { [handle]: _closed, ...trails } = state.trails;
  return { frames, trails };
}

/** What main holds after a (re)load; an empty answer leaves the live frames alone. */
export function screensLoaded(state: AgentScreensState, frames: AgentScreenFrame[]): AgentScreensState {
  if (!frames.length) return state;
  const trails: Record<string, readonly AgentScreenFrame[]> = {};
  for (const frame of frames) trails[frame.handle] = extendTrail(state.trails[frame.handle] ?? NO_TRAIL, frame);
  return { frames, trails };
}

/** The lead's own screen is the one a running build's status and its node show. */
const DIRECTOR: AgentScreenRole = "director";

/** The newest frame that matches, or undefined: a frame the store holds, so a selector's answer is stable. */
function newestFrame(
  state: AgentScreensState,
  matches: (frame: AgentScreenFrame) => boolean,
): AgentScreenFrame | undefined {
  let newest: AgentScreenFrame | undefined;
  for (const frame of state.frames) {
    const newer = !newest || frame.at > newest.at;
    if (newer && matches(frame)) newest = frame;
  }
  return newest;
}

/**
 * The newest frame of a run's lead, or undefined. A selector: it returns a frame the store holds,
 * so a component re-renders only when that frame changes, not on every other worker's frame.
 */
export function leadFrameOf(
  state: AgentScreensState,
  project: string | null,
  runId: string | null,
): AgentScreenFrame | undefined {
  return newestFrame(state, (frame) => frame.project === project && frame.runId === runId && frame.role === DIRECTOR);
}

/**
 * The newest frame of the agent working on one part of a run — its worker — or undefined. The graph joins a step to its screen on the run and the part.
 */
export function partFrameOf(
  state: AgentScreensState,
  project: string | null,
  runId: string | null,
  facetId: string,
): AgentScreenFrame | undefined {
  return newestFrame(state, (frame) => {
    const ofPart = frame.runId === runId && frame.facetId === facetId;
    return ofPart && frame.project === project && frame.role !== DIRECTOR;
  });
}

/** A window's recent frames, oldest first; the same array until a new frame arrives. */
export const trailOf = (state: AgentScreensState, handle: string | null): readonly AgentScreenFrame[] =>
  (handle ? state.trails[handle] : undefined) ?? NO_TRAIL;

export type AgentScreensStore = StoreApi<AgentScreensState>;

export function createAgentScreensStore(): AgentScreensStore {
  return createStore<AgentScreensState>()(() => ({ frames: [], trails: {} }));
}
