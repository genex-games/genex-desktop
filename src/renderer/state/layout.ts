/**
 * The window's layout choices that outlive a launch: whether the sidebar is open, how wide the
 * chat is, and which view the stage shows. Persisted through zustand's `persist` middleware, but
 * into the three keys earlier builds already wrote, so nobody's layout resets on upgrade.
 *
 * A chat-width drag is not a choice until the pointer lets go: `chatDragWidth` follows the
 * pointer and is never persisted; `chatWidthCommitted` keeps it.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { isStageView, StageView } from "../stage.ts";
import { browserStorage, readNumber, readText, STORAGE_KEYS, writeText, type KeyValueStorage } from "../storage.ts";

export const CHAT_MIN = 320;
export const CHAT_MAX = 640;
export const CHAT_DEFAULT = 434;
/**
 * The default earlier builds had. Every layout change wrote the width, so a stored one equal to it
 * was left at the default rather than chosen, and follows the current one.
 */
const CHAT_DEFAULT_BEFORE = 388;
/** One arrow-key press on the resize handle. */
export const CHAT_STEP = 20;

export interface LayoutPrefs {
  sidebarOpen: boolean;
  chatWidth: number;
  stageView: StageView;
}

export interface LayoutState extends LayoutPrefs {
  /** The width under a drag in progress, or null. */
  chatDragWidth: number | null;
  /** The window is the small chat kept over another program (`main/beside-window.ts`); never persisted. */
  beside: boolean;
}

export const clampChatWidth = (width: number): number => Math.max(CHAT_MIN, Math.min(CHAT_MAX, width));

export function sidebarToggled(state: LayoutState): LayoutState {
  return { ...state, sidebarOpen: !state.sidebarOpen };
}

/** An arrow key: one step, kept at once. */
export function chatWidthStepped(state: LayoutState, direction: 1 | -1): LayoutState {
  return { ...state, chatWidth: clampChatWidth(state.chatWidth + direction * CHAT_STEP) };
}

export function chatWidthDragged(state: LayoutState, width: number): LayoutState {
  return { ...state, chatDragWidth: clampChatWidth(width) };
}

/** The pointer let go: the width it left is the width kept. */
export function chatWidthCommitted(state: LayoutState): LayoutState {
  return state.chatDragWidth === null ? state : { ...state, chatWidth: state.chatDragWidth, chatDragWidth: null };
}

/** The window became the small chat over another program, or the full window again. */
export function besideChanged(state: LayoutState, beside: boolean): LayoutState {
  return state.beside === beside ? state : { ...state, beside };
}

export function stageViewChosen(state: LayoutState, view: StageView): LayoutState {
  return { ...state, stageView: view };
}

/** The width the chat has right now, under a drag or not. */
export const chatWidthOf = (state: LayoutState): number => state.chatDragWidth ?? state.chatWidth;

/** The three keys earlier builds wrote, read and written one by one as zustand's storage. */
export function layoutStorage(storage: KeyValueStorage | null = browserStorage()): PersistStorage<LayoutPrefs> {
  return {
    getItem(): StorageValue<LayoutPrefs> {
      const view = readText(STORAGE_KEYS.previewView, storage);
      const width = readNumber(STORAGE_KEYS.chatWidth, CHAT_MIN, CHAT_MAX, storage);
      return {
        version: 0,
        state: {
          sidebarOpen: readText(STORAGE_KEYS.sidebarOpen, storage) !== "false",
          chatWidth: width === null || width === CHAT_DEFAULT_BEFORE ? CHAT_DEFAULT : width,
          stageView: isStageView(view) ? view : StageView.Live,
        },
      };
    },
    setItem(_name, value): void {
      const writes: Array<[string, string]> = [
        [STORAGE_KEYS.sidebarOpen, String(value.state.sidebarOpen)],
        [STORAGE_KEYS.chatWidth, String(value.state.chatWidth)],
      ];
      // A file opened beside the chat is never the view a launch comes back to.
      if (isStageView(value.state.stageView)) writes.push([STORAGE_KEYS.previewView, value.state.stageView]);
      // Only what changed: a drag re-sets the store on every move and must not rewrite the rest.
      for (const [key, text] of writes) if (readText(key, storage) !== text) writeText(key, text, storage);
    },
    removeItem(): void {
      /* layout is never cleared as a whole */
    },
  };
}

export type LayoutStore = StoreApi<LayoutState>;

export function createLayoutStore(storage: KeyValueStorage | null = browserStorage()): LayoutStore {
  return createStore<LayoutState>()(
    persist(
      (): LayoutState => ({
        sidebarOpen: true,
        chatWidth: CHAT_DEFAULT,
        stageView: StageView.Live,
        chatDragWidth: null,
        beside: false,
      }),
      {
        name: "studio.layout",
        storage: layoutStorage(storage),
        partialize: (state): LayoutPrefs => ({
          sidebarOpen: state.sidebarOpen,
          chatWidth: state.chatWidth,
          stageView: state.stageView,
        }),
      },
    ),
  );
}
