/**
 * Harness RPC: a game's observers inside a run (`observers.capture`). The run must be this game's
 * by the host's own records; each plugin observer that is on runs as a harness step and its
 * pictures are kept with the run (`core/observers.ts`). The run's or the chat's Stop, or the
 * harness's end, stops it, and a harness that has ended runs none (`moment-stops.ts`).
 */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { isPluginObserverKey } from "../../shared/observers.ts";
import { stoppableMoment } from "../core/moment-stops.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** Why a capture from the harness is refused. */
const MESSAGE = {
  unknownGame: "No such game",
  notThisGamesRun: "That run is not a run of this game",
  badObserver: "An observer is named <plugin>/<id>",
} as const;

export function observersRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.ObserversCapture]: async (p) => {
      // The asker's time runs from its call, before any check here takes some of it.
      const until = x.observers.deadlineIn(typeof p.withinMs === "number" ? p.withinMs : undefined);
      const boot = x.harnessBoot;
      const named = p.observer ?? undefined;
      if (named !== undefined && !isPluginObserverKey(named)) throw new Error(MESSAGE.badObserver);
      await core.games.kindOf(p.project).catch(() => {
        throw new Error(MESSAGE.unknownGame);
      });
      const chat = await x.delegation.chatOfGameRun(p.project, p.runId);
      if (!chat) throw new Error(MESSAGE.notThisGamesRun);
      // Stop of the chat the harness names, else of the chat the run reports to, ends it.
      const threadId = p.threadId ?? chat;
      const scope = { project: p.project, threadId };
      return stoppableMoment(
        x,
        scope,
        (signal) =>
          x.observers.capture({
            project: p.project,
            runId: p.runId,
            threadId,
            ...(named ? { observer: named } : {}),
            until,
            signal,
          }),
        boot,
      );
    },
  } satisfies Partial<HarnessHostHandlers>;
}
