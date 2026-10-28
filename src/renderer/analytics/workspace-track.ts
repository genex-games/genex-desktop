/**
 * The workspace's events as one call each, for the places that send the same event from more than
 * one spot (a setting, a game's menu, a launch's first message) or from another part of the app.
 * Each builds its properties with `workspace-properties.ts` and sends them with `track`.
 */
import type { GameProject } from "../../shared/game-project.ts";
import type { HandoverStep, HeldState } from "../chat/use-launch-handover.ts";
import { browserStorage } from "../storage.ts";
import { track } from "./client.ts";
import { WorkspaceEvent } from "./events/workspace.ts";
import { gameRef } from "./game-ref.ts";
import { elapsedMs } from "./properties.ts";
import { gameCreatedProperties, gameManagedProperties } from "./workspace-properties.ts";
import { settingsVisit } from "./workspace-trackers.ts";
import {
  ActionOutcome,
  type FirstMessageAction,
  type FirstMessageOutcome,
  type GameAction,
  type GameCreatedFrom,
  type ManageVia,
  type SettingKey,
} from "./workspace-vocabulary.ts";

/** A setting changed in Settings (or failed to); it counts toward the Settings visit too. */
export function trackSettingChanged(key: SettingKey, value: string | number | boolean, failed = false): void {
  settingsVisit.changed(failed);
  track(WorkspaceEvent.SettingChanged, { key, value, outcome: failed ? ActionOutcome.Failed : ActionOutcome.Ok });
}

/** Something done to a game: renamed, pinned, given a cover, removed or shown in Finder; a failure says its code. */
export function trackGameManaged(
  action: GameAction,
  via: ManageVia,
  outcome: ActionOutcome,
  game: Pick<GameProject, "name" | "createdAt"> | null,
  failure?: unknown,
): void {
  const ref = gameRef(game?.name, browserStorage());
  const properties = gameManagedProperties({ action, via, outcome, game, at: Date.now(), ref, failure });
  track(WorkspaceEvent.GameManaged, properties);
}

/** A game was made: from home, an opened folder or a Play remix. */
export function trackGameCreated(input: {
  from: GameCreatedFrom;
  name: string;
  startedAt?: number;
  customLocation: boolean;
  provisional: boolean;
  games: number;
}): void {
  const ref = gameRef(input.name, browserStorage());
  track(WorkspaceEvent.GameCreated, gameCreatedProperties({ ...input, at: Date.now(), ref }));
}

/** When a launch's message left home, and when its chat started holding it, as `Date.now()` times. */
export interface HeldTimes {
  launchedAt?: number;
  heldAt?: number;
}

/** A launch's held first message ended: sent, not sent, failed, or back in the composer. */
export function trackFirstMessageSettled(
  outcome: FirstMessageOutcome,
  held: { state: HeldState; step: HandoverStep },
  times: HeldTimes = {},
): void {
  const now = Date.now();
  track(WorkspaceEvent.FirstMessageSettled, {
    outcome,
    held_state: held.state,
    step: held.step,
    ...(times.launchedAt === undefined ? {} : { ms_from_launch: elapsedMs(times.launchedAt, now) }),
    ...(times.heldAt === undefined ? {} : { held_ms: elapsedMs(times.heldAt, now) }),
  });
}

/** Try again or Sign in pressed on a held first message. */
export function trackFirstMessageAction(action: FirstMessageAction, heldState: HeldState): void {
  track(WorkspaceEvent.FirstMessageAction, { action, held_state: heldState });
}
