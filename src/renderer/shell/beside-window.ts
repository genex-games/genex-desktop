/**
 * The small chat window: the studio window made narrow and kept over another program (a game
 * engine's editor), with only the chat in it. Main sizes the window (`main/beside-window.ts`); the
 * layout store's `beside` hides the stage and shows the way back in the chat's header.
 */
import type { StudioApi } from "../../shared/studio-api.ts";
import { besideChanged, type LayoutStore } from "../state/layout.ts";

/** Make the window the small chat (`on`) or the full window again; the store follows what main did. */
export async function setBesideWindow(
  api: Pick<StudioApi, "setWindowBeside">,
  layout: LayoutStore,
  on: boolean,
): Promise<void> {
  const beside = await api.setWindowBeside(on).catch(() => false);
  layout.setState((state) => besideChanged(state, beside), true);
}
