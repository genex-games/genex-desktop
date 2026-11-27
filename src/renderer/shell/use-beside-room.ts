/**
 * Whether the window is the small chat kept over another program. Play, Plugins, Create › Items and
 * Settings need the whole window, so opening one of them brings the full window back.
 */
import { useEffect } from "react";
import { useLayout } from "../state/hooks.ts";
import type { Studio } from "../state/studio.ts";
import { setBesideWindow } from "./beside-window.ts";

/** The small chat window is on; `needsFullWindow` (a room or Settings is up) ends it. */
export function useBesideRoom(app: Studio, needsFullWindow: boolean): boolean {
  const beside = useLayout((s) => s.beside);
  useEffect(() => {
    if (beside && needsFullWindow) void setBesideWindow(window.studio, app.layout, false);
  }, [app, beside, needsFullWindow]);
  return beside;
}
