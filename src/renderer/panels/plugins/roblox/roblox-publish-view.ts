/**
 * Studio's Publish for a Roblox game, as data: whether the strip shows it, and what its card shows
 * for the game's place and its latest publish (`publish-status` of the Roblox plugin). The press
 * hands the publish to the game's agent; the card follows it to Roblox.
 */
import { CoreFact, type FactRef } from "../../../../shared/project-facts.ts";
import { MINUTE_MS, SECOND_MS } from "../../../../shared/duration.ts";
import { ROBLOX_PLUGIN_ID } from "../../../../shared/observers.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import {
  type RobloxPublishAttempt,
  RobloxPublishKind,
  RobloxPublishPhase,
  type RobloxPublishState,
  robloxGameUrl,
} from "../../../../shared/roblox-publish.ts";
import { type StepSegment, StepState } from "../../../ui/step-bar.ts";
import { ROBLOX_PUBLISH_WORDS as WORDS } from "../../../words.ts";

/** How long the card shows how the latest publish ended, before it offers the next one. */
export const RESULT_SHOWN_MS = 15 * MINUTE_MS;
/** How often the card reads the status while a publish is under way, and otherwise. */
export const PUBLISHING_POLL_MS = 2 * SECOND_MS;
export const IDLE_POLL_MS = 10 * SECOND_MS;

/** What the card shows. Never leaves the renderer. */
export const RobloxCardStage = {
  Loading: "loading",
  /** The game builds in no Roblox place yet. */
  NoPlace: "no-place",
  /** Genex can't click in Studio here: the person publishes in Studio. */
  ByHand: "by-hand",
  Ready: "ready",
  Publishing: "publishing",
  Published: "published",
  Stopped: "stopped",
} as const;
export type RobloxCardStage = (typeof RobloxCardStage)[keyof typeof RobloxCardStage];

/** The card's content now. */
export interface RobloxCardView {
  stage: RobloxCardStage;
  /** A first publish (a new game on Roblox), else an update. */
  first: boolean;
  /** The name a first publish suggests. */
  name: string;
  /** The game's page on Roblox, once it is there. */
  url?: string;
  /** The agent's words on how it ended. */
  detail?: string;
  /** The publish's steps, while it runs or once it ended. */
  steps: StepSegment[];
}

/** Whether the strip shows Publish for a Roblox game: one holding a Roblox place, with the Roblox plugin on. */
export function robloxPublishShown(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
): boolean {
  if (!project || !facts.some((fact) => fact.id === CoreFact.RobloxProject)) return false;
  return plugins.some((plugin) => plugin.manifest.id === ROBLOX_PLUGIN_ID && plugin.enabled && !plugin.removed);
}

/** Each phase's steps: handed to the agent, clicked in Studio, on Roblox. */
const STEP_STATES: Record<RobloxPublishPhase, readonly StepState[]> = {
  [RobloxPublishPhase.Publishing]: [StepState.Done, StepState.Current, StepState.Next],
  [RobloxPublishPhase.Published]: [StepState.Done, StepState.Done, StepState.Done],
  [RobloxPublishPhase.Stopped]: [StepState.Done, StepState.Next, StepState.Next],
};

/** The steps as the bar shows them for `phase`. */
function stepsAt(phase: RobloxPublishPhase): StepSegment[] {
  const labels = [WORDS.stepAgent, WORDS.stepStudio, WORDS.stepRoblox];
  return labels.map((label, index) => ({
    key: String(index),
    label,
    state: STEP_STATES[phase][index] ?? StepState.Next,
  }));
}

/** Whether the latest publish is one the card shows: under way, or ended within {@link RESULT_SHOWN_MS}. */
const shownAttempt = (state: RobloxPublishState, now: number) => {
  const attempt = state.attempt;
  if (!attempt) return undefined;
  if (attempt.phase === RobloxPublishPhase.Publishing || now - attempt.at <= RESULT_SHOWN_MS) return attempt;
  return undefined;
};

/** The stage each ended or running publish shows. */
const PHASE_STAGE: Record<RobloxPublishPhase, RobloxCardStage> = {
  [RobloxPublishPhase.Publishing]: RobloxCardStage.Publishing,
  [RobloxPublishPhase.Published]: RobloxCardStage.Published,
  [RobloxPublishPhase.Stopped]: RobloxCardStage.Stopped,
};

/** The card for the game's latest publish, under way or just ended. */
function attemptView(base: RobloxCardView, attempt: RobloxPublishAttempt): RobloxCardView {
  return {
    ...base,
    stage: PHASE_STAGE[attempt.phase],
    first: attempt.kind === RobloxPublishKind.First,
    name: attempt.name ?? base.name,
    steps: stepsAt(attempt.phase),
    ...(attempt.detail ? { detail: attempt.detail } : {}),
  };
}

/** What the card shows for the game's state at `now`; Loading until the first answer. */
export function robloxCardView(state: RobloxPublishState | null, now: number): RobloxCardView {
  const url = robloxGameUrl(state?.placeId);
  const base: RobloxCardView = {
    stage: RobloxCardStage.Loading,
    first: !state?.published,
    name: state?.name ?? "",
    steps: [],
    ...(url ? { url } : {}),
  };
  if (!state) return base;
  if (!state.linked) return { ...base, stage: RobloxCardStage.NoPlace };
  const attempt = shownAttempt(state, now);
  if (attempt) return attemptView(base, attempt);
  return { ...base, stage: state.canClick ? RobloxCardStage.Ready : RobloxCardStage.ByHand };
}

/** How soon the card reads the status again. */
export const pollAfterMs = (view: RobloxCardView): number =>
  view.stage === RobloxCardStage.Publishing ? PUBLISHING_POLL_MS : IDLE_POLL_MS;
