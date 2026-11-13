/**
 * A design page's closed frames, for the wall and for a page's card in the chat. A page that
 * changed is loaded in a second frame behind the one on show, which stays up until the new one has
 * loaded (`heldFrames`): a page being written is swapped whole, never through an empty sheet. What
 * a frame tells its owner is read only from the owner's own frames, and only as a signal.
 */
import { type CSSProperties, type JSX, type RefObject, useEffect, useRef } from "react";
import { type DesignFrameSignal, readDesignSignal } from "../../../shared/design-board.ts";

/** What a frame's messages come from: a closed frame has no origin of its own. */
const CLOSED_FRAME_ORIGIN = "null";

/** An owner's frames by the address each loaded. */
export type FrameMap = RefObject<Map<string, HTMLIFrameElement>>;

/** How a frame that is loading behind the one on show sits: over it, unseen, and out of the pointer's way. */
const BEHIND = "pointer-events-none absolute top-0 left-0 opacity-0";

/**
 * A page's frames: the address on show, and the changed one (`next`) loading behind it, which
 * `onLoaded` reports once its page and pictures are in. `styleOf` sizes each by its own address; a
 * frame that is `still` never takes the pointer or the keyboard (a preview). The frames' parent is
 * positioned, and as large as the frame on show.
 */
export function PageFrames({
  shown,
  next,
  title,
  frames,
  onLoaded,
  styleOf,
  className = "",
  still = false,
}: {
  shown: string;
  next: string | null;
  title: string;
  frames: FrameMap;
  onLoaded: (url: string) => void;
  styleOf: (url: string) => CSSProperties;
  className?: string;
  still?: boolean;
}): JSX.Element {
  const urls = next ? [shown, next] : [shown];
  return (
    <>
      {urls.map((url) => {
        const behind = url !== shown;
        return (
          <iframe
            key={url}
            ref={(element) => {
              if (!element) return;
              frames.current.set(url, element);
              return () => {
                frames.current.delete(url);
              };
            }}
            src={url}
            title={title}
            sandbox="allow-scripts"
            {...(behind || still ? { tabIndex: -1 } : {})}
            {...(behind ? { "aria-hidden": true, onLoad: () => onLoaded(url) } : {})}
            className={`block border-0 bg-white ${className} ${behind ? BEHIND : ""} ${still ? "pointer-events-none" : ""}`}
            style={styleOf(url)}
          />
        );
      })}
    </>
  );
}

/**
 * What an owner's frames tell it: a message is read only when it comes from one of `frames`, and
 * only as a signal (`readDesignSignal`); `onSignal` gets the address its frame loaded.
 */
export function useFrameSignals(
  frames: FrameMap,
  onSignal: (url: string, frame: HTMLIFrameElement, signal: DesignFrameSignal) => void,
): void {
  const latest = useRef(onSignal);
  latest.current = onSignal;
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== CLOSED_FRAME_ORIGIN) return;
      for (const [url, frame] of frames.current) {
        if (frame.contentWindow !== event.source) continue;
        const signal = readDesignSignal(event.data);
        if (signal) latest.current(url, frame, signal);
        return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frames]);
}
