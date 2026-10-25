/**
 * The window's first screen: index.html's #app-loader, the Genex G with a light passing over it,
 * there before the app's bundle runs. It stays until the first real screen is drawn under it (the
 * studio with its games and the open chat, the welcome, the sandbox setup, or a failure with its
 * Retry), then fades once and leaves the page. Nothing brings it back: later waits are each
 * area's own (`ui/Pending.tsx`).
 */
import { useEffect } from "react";
import { t } from "../shared/i18n.ts";
import { SessionStatus } from "./state/session.ts";

/** The loader's element in index.html. */
export const APP_LOADER_ID = "app-loader";

/** theme.css's fade, and a margin: reduced motion has no transition to end. */
const FADE_MS = 200;
const REMOVE_AFTER_MS = FADE_MS + 100;

/** What the studio's first screen waits on. */
export interface FirstScreen {
  status: SessionStatus;
  /** The welcome covers the studio, so the open chat does not matter. */
  welcoming: boolean;
  /** A chat is open and its first page has not arrived (or failed) yet. */
  chatPending: boolean;
}

/** Whether the studio's first screen is drawn: its bootstrap answered, and the open chat is read. */
export function firstScreenReady(screen: FirstScreen): boolean {
  if (screen.status === SessionStatus.Failed) return true;
  if (screen.status !== SessionStatus.Ready) return false;
  return screen.welcoming || !screen.chatPending;
}

/** Name the loader in the window's language: index.html can only say it in English. */
export function labelAppLoader(page: Pick<Document, "getElementById"> = document): void {
  page.getElementById(APP_LOADER_ID)?.setAttribute("aria-label", t("Opening Genex"));
}

/** Fade the loader out and remove it; a second call, or a page without it, does nothing. */
export function dismissAppLoader(
  page: Pick<Document, "getElementById"> = document,
  later: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
): void {
  const loader = page.getElementById(APP_LOADER_ID);
  if (!loader || loader.dataset.leaving !== undefined) return;
  loader.dataset.leaving = "";
  const remove = (): void => loader.remove();
  loader.addEventListener("transitionend", remove, { once: true });
  later(remove, REMOVE_AFTER_MS);
}

/** Dismiss the loader once `ready` is true; it runs after the paint, so the screen is already under it. */
export function useAppLoaderDismissal(ready: boolean): void {
  useEffect(() => {
    if (ready) dismissAppLoader();
  }, [ready]);
}
