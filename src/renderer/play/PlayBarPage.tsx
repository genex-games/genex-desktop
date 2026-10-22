/**
 * The bar's layer above the game (`play-bar.html`, a transparent view main lays above the game's own):
 * the viewer's bar, and its Comments over the dimmed game. It hears the viewer's news as the studio's
 * page does, asks main for the bar's controls, and tells main whether Comments is open (main then
 * lays the layer over the whole window and gives it the keyboard, and gives the game the keyboard back
 * once Comments closes). Esc here gives the
 * keyboard back to the game; before the game plays it leaves, as the cover's does. A game's coin
 * purchase draws its sheet here too, over the whole window: main lays the layer out for it and keeps the
 * keyboard on it, Comments closes for it, and Esc is the sheet's own.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlayControl } from "../../shared/play.ts";
import type { PlayBarApi } from "../../shared/play-bar.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { BarEscape, type BarView, barEscape, barNews, holdKey, holdToTell, NOTHING_TOLD } from "./bar-model.ts";
import { PlayComments } from "./PlayComments.tsx";
import { PlayPurchase } from "./PlayPurchase.tsx";
import { PlayViewerBar, type SendControl } from "./PlayViewerBar.tsx";

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
 * Whether Comments is open, told to main whenever it changes; Comments opens once main has laid the
 * layer over the window, and closes when a purchase sheet opens over it.
 */
function useComments(api: BarApi, openId: number | null, sheetOpen: boolean) {
  const [comments, setComments] = useState(false);
  const told = useRef(NOTHING_TOLD);
  useEffect(() => {
    const tell = holdToTell(told.current, { comments });
    if (!tell) return;
    told.current = tell.key;
    api.playBar(tell.payload).catch(() => undefined);
  }, [api, comments]);
  // Another game, or none: Comments belongs to the game it was opened over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the opening is what resets it.
  useEffect(() => {
    setComments(false);
    told.current = NOTHING_TOLD;
  }, [openId]);
  // A purchase sheet takes the layer: main keeps it over the window and the keyboard on the sheet.
  useEffect(() => {
    if (sheetOpen) setComments(false);
  }, [sheetOpen]);
  const openComments = useCallback(() => {
    // The layer covers the window first, so the modal never draws cut off at the bar's edge.
    api
      .playBar({ comments: true })
      .then(() => {
        told.current = holdKey({ comments: true });
        setComments(true);
      })
      .catch(() => undefined);
  }, [api]);
  return { comments, openComments, closeComments: () => setComments(false) };
}

/** Esc in the layer while the bar has the keyboard: back to the game, or out of a game still loading. */
function useEscape(api: BarApi, view: BarView | null, covered: { commentsOpen: boolean; sheetOpen: boolean }): void {
  const phase = useRef(view?.phase);
  phase.current = view?.phase;
  const open = useRef(covered);
  open.current = covered;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // A held Esc that moved the keyboard here keeps repeating: only a fresh press acts.
      const action = barEscape(phase.current, { repeat: event.repeat, ...open.current });
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
  const sheet = view?.bar?.purchase ?? null;
  const { comments, openComments, closeComments } = useComments(api, view?.openId ?? null, sheet !== null);
  useEscape(api, view, { commentsOpen: comments, sheetOpen: sheet !== null });
  // The viewer may have closed under the press: nothing is left for it to do.
  const send: SendControl = useCallback(
    (control, at) => void api.playControl(control, at).catch(() => undefined),
    [api],
  );
  if (!view) return null;
  // Comments never stays open under a purchase sheet: two modals would fight over the keyboard.
  const commentsShown = comments && !sheet;
  return (
    <div className="play-bar-layer" data-comments={comments ? true : undefined} data-sheet={sheet ? true : undefined}>
      <PlayViewerBar view={view} send={send} onComments={openComments} />
      {commentsShown && view.bar && (
        <PlayComments key={view.openId} api={api} bar={view.bar} send={send} onClose={closeComments} />
      )}
      {sheet && <PlayPurchase key={view.openId} api={api} sheet={sheet} />}
    </div>
  );
}
