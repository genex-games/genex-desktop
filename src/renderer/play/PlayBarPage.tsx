/**
 * The bar's layer over the game (`play-bar.html`, a transparent view main lays above the game's own):
 * the viewer's bar, and its Comments over the dimmed game. It hears the viewer's news as the studio's
 * page does, asks main for the bar's controls, and tells main what holds the bar up: the pointer or
 * the keyboard on it, or Comments open (main then lays the layer over the whole window and gives it
 * the keyboard, and gives the game the keyboard back once Comments closes). Esc here gives the
 * keyboard back to the game; before the game plays it leaves, as the cover's does.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayControl } from "../../shared/play.ts";
import { type PlayBarApi, PlayBarOverlay } from "../../shared/play-bar.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { BarEscape, type BarView, barEscape, barNews, holdKey, holdToTell, NOTHING_TOLD } from "./bar-model.ts";
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

/** What holds the bar up, told to main whenever it changes; Comments opens once main has laid the layer over the window. */
function useHold(api: BarApi, openId: number | null) {
  const [pointer, setPointer] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [comments, setComments] = useState(false);
  const told = useRef(NOTHING_TOLD);
  const held = pointer || keyboard;
  useEffect(() => {
    const tell = holdToTell(told.current, { held, overlay: comments ? PlayBarOverlay.Comments : null });
    if (!tell) return;
    told.current = tell.key;
    api.playBar(tell.payload).catch(() => undefined);
  }, [api, held, comments]);
  // Another game, or none: Comments belongs to the game it was opened over, and main holds nothing
  // for the new one until the pointer or the keyboard comes back to the bar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the opening is what resets it.
  useEffect(() => {
    setComments(false);
    setPointer(false);
    setKeyboard(false);
    told.current = NOTHING_TOLD;
  }, [openId]);
  const holds: BarHolds = useMemo(() => ({ pointer: setPointer, keyboard: setKeyboard }), []);
  const openComments = useCallback(() => {
    // The layer covers the window first, so the modal never draws cut off at the bar's edge.
    const hold = { held: true, overlay: PlayBarOverlay.Comments };
    api
      .playBar(hold)
      .then(() => {
        told.current = holdKey(hold);
        setComments(true);
      })
      .catch(() => undefined);
  }, [api]);
  return { holds, comments, openComments, closeComments: () => setComments(false) };
}

/** Esc in the layer while the bar has the keyboard: back to the game, or out of a game still loading. */
function useEscape(api: BarApi, view: BarView | null, commentsOpen: boolean): void {
  const phase = useRef(view?.phase);
  phase.current = view?.phase;
  const open = useRef(commentsOpen);
  open.current = commentsOpen;
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
  const { holds, comments, openComments, closeComments } = useHold(api, view?.openId ?? null);
  useEscape(api, view, comments);
  // The viewer may have closed under the press: nothing is left for it to do.
  const send: SendControl = useCallback(
    (control, at) => void api.playControl(control, at).catch(() => undefined),
    [api],
  );
  if (!view) return null;
  return (
    <div className="play-bar-layer" data-comments={comments ? true : undefined}>
      <PlayViewerBar view={view} send={send} holds={holds} onComments={openComments} />
      {comments && view.bar && (
        <PlayComments key={view.openId} api={api} bar={view.bar} send={send} onClose={closeComments} />
      )}
    </div>
  );
}
