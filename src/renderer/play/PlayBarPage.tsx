/**
 * The bar's layer over the game (`play-bar.html`, a transparent view main lays above the game's own):
 * the viewer's bar with the game's AI pill, and one overlay at a time over the game: Comments, or what
 * the pill opens (`PlayAiLayer.tsx`). It hears the viewer's news as the studio's page does, asks main
 * for the bar's controls, and tells main what holds the bar up: the pointer or the keyboard on it, or
 * an overlay open (main then lays the layer over the whole window and gives it the keyboard, and gives
 * the game the keyboard back once it closes). Esc here gives the keyboard back to the game; before the
 * game plays it leaves, as the cover's does.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayControl } from "../../shared/play.ts";
import { type PlayBarApi, PlayBarOverlay } from "../../shared/play-bar.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { BarEscape, type BarView, barEscape, barNews, holdKey, holdToTell, NOTHING_TOLD } from "./bar-model.ts";
import { type BarOverlays, usePlayAiLayer } from "./PlayAiLayer.tsx";
import { PlayComments } from "./PlayComments.tsx";
import { type BarHolds, PlayViewerBar, type SendControl } from "./PlayViewerBar.tsx";

/** The calls the bar's layer makes. */
export type BarApi = PlayBarApi;

/** The viewer as main last drew it, from its news. */
function useBarView(api: BarApi): BarView | null {
  const [view, setView] = useState<BarView | null>(null);
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type === UiEvent.PlayViewer) setView((shown) => barNews(shown, event.payload));
      }),
    [api],
  );
  return view;
}

/**
 * What holds the bar up, told to main whenever it changes: the pointer or the keyboard on it, or one
 * of its overlays open. An overlay opens once main has laid the layer over the window.
 */
function useHold(api: BarApi, openId: number | null) {
  const [pointer, setPointer] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [overlay, setOverlay] = useState<PlayBarOverlay | null>(null);
  const told = useRef(NOTHING_TOLD);
  const opening = useRef(openId);
  opening.current = openId;
  const held = pointer || keyboard;
  useEffect(() => {
    const tell = holdToTell(told.current, { held, overlay });
    if (!tell) return;
    told.current = tell.key;
    api.playBar(tell.payload).catch(() => undefined);
  }, [api, held, overlay]);
  // Another game, or none: an overlay belongs to the game it was opened over, and main holds nothing
  // for the new one until the pointer or the keyboard comes back to the bar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the opening is what resets it.
  useEffect(() => {
    setOverlay(null);
    setPointer(false);
    setKeyboard(false);
    told.current = NOTHING_TOLD;
  }, [openId]);
  const holds: BarHolds = useMemo(() => ({ pointer: setPointer, keyboard: setKeyboard }), []);
  const open = useCallback(
    async (next: PlayBarOverlay): Promise<void> => {
      // The layer covers the window first, so nothing opened draws cut off at the bar's edge.
      const hold = { held: true, overlay: next };
      const forGame = opening.current;
      try {
        await api.playBar(hold);
      } catch {
        return;
      }
      if (opening.current !== forGame) return;
      told.current = holdKey(hold);
      setOverlay(next);
    },
    [api],
  );
  const close = useCallback(() => setOverlay(null), []);
  return { holds, overlay, open, close };
}

/** Esc in the layer while the bar has the keyboard: back to the game, or out of a game still loading. */
function useEscape(api: BarApi, view: BarView | null, overlayOpen: boolean): void {
  const phase = useRef(view?.phase);
  phase.current = view?.phase;
  const open = useRef(overlayOpen);
  open.current = overlayOpen;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // A held Esc that moved the keyboard here keeps repeating: only a fresh press acts.
      const action = barEscape(phase.current, { repeat: event.repeat, overlayOpen: open.current });
      if (action === BarEscape.Resume) api.playControl(PlayControl.Resume).catch(() => undefined);
      if (action === BarEscape.Leave) api.playClose().catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api]);
}

/** The bar's layer for `api` (the page's `window.studio`). */
export function PlayBarPage({ api }: { api: BarApi }): JSX.Element | null {
  const view = useBarView(api);
  const { holds, overlay, open, close } = useHold(api, view?.openId ?? null);
  useEscape(api, view, overlay !== null);
  // The viewer may have closed under the press: nothing is left for it to do.
  const send: SendControl = useCallback(
    (control, at) => void api.playControl(control, at).catch(() => undefined),
    [api],
  );
  const overlays: BarOverlays = useMemo(() => ({ overlay, open, close }), [overlay, open, close]);
  const ai = usePlayAiLayer(api, view?.bar?.ai ?? null, overlays, send);
  if (!view) return null;
  return (
    <div className="play-bar-layer" data-overlay={overlay ?? undefined}>
      <PlayViewerBar
        view={view}
        send={send}
        holds={holds}
        aiPill={ai.pill}
        onComments={() => void open(PlayBarOverlay.Comments)}
      />
      {overlay === PlayBarOverlay.Comments && view.bar && (
        <PlayComments key={view.openId} api={api} bar={view.bar} send={send} onClose={close} />
      )}
      {ai.overlay}
    </div>
  );
}
