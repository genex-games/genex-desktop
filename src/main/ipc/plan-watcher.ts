/**
 * The plan watcher's channels (Settings → Play-time AI, "While you play"): its view, the person's
 * switch, and the Genex player sign-in (`main/game-ai/player-watcher.ts`). The switch's payload is
 * read with the shared reader before the watcher hears it; the view never carries the credential.
 */
import { readAiWatcherSwitch } from "../../shared/game-ai-watcher.ts";
import type { PlanWatcher } from "../game-ai/player-watcher.ts";
import type { IpcHandle } from "./registrar.ts";

const MESSAGE = {
  badSwitch: "not on or off",
} as const;

/** What the plan watcher's channels answer from. */
export interface PlanWatcherIpcDeps {
  watcher: Pick<PlanWatcher, "view" | "setEnabled" | "signIn" | "cancelSignIn" | "signOut">;
}

/** Register the plan watcher's channels. */
export function registerPlanWatcherIpc(handle: IpcHandle, { watcher }: PlanWatcherIpcDeps): void {
  handle("studio:plan-watcher", () => watcher.view());
  handle("studio:plan-watcher.switch", async (payload) => {
    const enabled = readAiWatcherSwitch(payload);
    if (enabled === null) throw new Error(MESSAGE.badSwitch);
    return watcher.setEnabled(enabled);
  });
  handle("studio:plan-watcher.sign-in", () => watcher.signIn());
  handle("studio:plan-watcher.cancel", () => watcher.cancelSignIn());
  handle("studio:plan-watcher.sign-out", () => watcher.signOut());
}
