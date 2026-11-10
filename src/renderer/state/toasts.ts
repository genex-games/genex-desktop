/**
 * The toast stack. A toast leaves on its own after four seconds, or when dismissed; one with a press
 * (a game's review while another game is open: [Open]) stays {@link REVIEW_TOAST_MS}.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { SECOND_MS } from "../../shared/duration.ts";
import type { StudioErrorCode } from "../../shared/error-codes.ts";
import { errorCode } from "../../shared/errors.ts";
import { failedChannel, type StudioInvokeChannel } from "../../shared/ipc-channels.ts";
import { LiveLoadFailure } from "../../shared/preview-contract.ts";
import { problemWords } from "../words.ts";

export const TOAST_MS = 4 * SECOND_MS;
/** How long a toast about a game's review stays: long enough to reach its [Open]. */
export const REVIEW_TOAST_MS = 8 * SECOND_MS;

/** How a toast reads: done, went wrong, or just so you know. */
export const ToastTone = {
  Ok: "ok",
  Error: "err",
  Info: "info",
} as const;
export type ToastTone = (typeof ToastTone)[keyof typeof ToastTone];

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  /** The failure's typed code, when an error toast came from one (`errorCode`). */
  code?: StudioErrorCode;
  /** The app call that failed, when an error toast came from one (`failedChannel`). */
  channel?: StudioInvokeChannel;
  /** A press the toast offers; pressing it runs it and dismisses the toast. */
  action?: ToastAction;
}

/** A toast's one press: its words and what it does. */
export interface ToastAction {
  label: string;
  run(): void;
}

/** App's toast channel, as panels receive it; an error toast may say its failure's code and the call that failed. */
export type Notify = (
  text: string,
  tone?: ToastTone,
  code?: StudioErrorCode | null,
  channel?: StudioInvokeChannel | null,
) => void;

/**
 * A `.catch` handler that says what went wrong in the user's words, with the failure's code and call.
 * A Live load another navigation took the place of (`LiveLoadFailure.Aborted`) says nothing: the
 * load that replaced it reports itself.
 */
export const notifyProblem =
  (notify: Notify) =>
  (error: unknown): void => {
    const code = errorCode(error);
    if (code === LiveLoadFailure.Aborted) return;
    notify(problemWords(error), ToastTone.Error, code, failedChannel(error));
  };

export interface ToastsState {
  items: ToastItem[];
  lastId: number;
}

export function toastAdded(
  state: ToastsState,
  text: string,
  tone: ToastTone,
  code: StudioErrorCode | null = null,
  channel: StudioInvokeChannel | null = null,
): ToastsState {
  const id = state.lastId + 1;
  const item = { id, text, tone, ...(code ? { code } : {}), ...(channel ? { channel } : {}) };
  return { items: [...state.items, item], lastId: id };
}

/** A toast with a press, in the info tone. */
export function toastWithAction(state: ToastsState, text: string, action: ToastAction): ToastsState {
  const id = state.lastId + 1;
  return { items: [...state.items, { id, text, tone: ToastTone.Info, action }], lastId: id };
}

export function toastDismissed(state: ToastsState, id: number): ToastsState {
  const items = state.items.filter((toast) => toast.id !== id);
  return items.length === state.items.length ? state : { ...state, items };
}

export interface ToastsStore extends StoreApi<ToastsState> {
  notify: Notify;
  /** A toast with a press, which stays `ms` (a review's: {@link REVIEW_TOAST_MS}). */
  offer(text: string, action: ToastAction, ms?: number): void;
  dismiss(id: number): void;
}

export function createToastsStore(
  setTimer: (run: () => void, ms: number) => unknown = (run, ms) => globalThis.setTimeout(run, ms),
): ToastsStore {
  const store = createStore<ToastsState>()(() => ({ items: [], lastId: 0 }));
  const dismiss = (id: number): void => store.setState((state) => toastDismissed(state, id), true);
  return Object.assign(store, {
    notify(
      text: string,
      tone: ToastTone = ToastTone.Info,
      code: StudioErrorCode | null = null,
      channel: StudioInvokeChannel | null = null,
    ): void {
      store.setState((state) => toastAdded(state, text, tone, code, channel), true);
      const id = store.getState().lastId;
      setTimer(() => dismiss(id), TOAST_MS);
    },
    offer(text: string, action: ToastAction, ms = REVIEW_TOAST_MS): void {
      store.setState((state) => toastWithAction(state, text, action), true);
      const id = store.getState().lastId;
      setTimer(() => dismiss(id), ms);
    },
    dismiss,
  });
}
