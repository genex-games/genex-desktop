/**
 * The chat column's right edge: drag it, or focus it and press ←/→. The width follows the pointer
 * while it moves and is kept when it lets go (`state/layout.ts`).
 */
import type { JSX } from "react";
import { useRef } from "react";
import { t } from "../../shared/i18n.ts";
import { useLayout } from "../state/hooks.ts";
import {
  CHAT_MAX,
  CHAT_MIN,
  chatWidthCommitted,
  chatWidthDragged,
  chatWidthOf,
  chatWidthStepped,
} from "../state/layout.ts";
import { studio } from "../state/studio.ts";

export function ChatResizeHandle(): JSX.Element {
  const width = useLayout(chatWidthOf);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const layout = studio().layout;
  const commit = (): void => {
    drag.current = null;
    layout.setState((state) => chatWidthCommitted(state), true);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={t("Chat width")}
      aria-valuemin={CHAT_MIN}
      aria-valuemax={CHAT_MAX}
      aria-valuenow={width}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        layout.setState((state) => chatWidthStepped(state, event.key === "ArrowRight" ? 1 : -1), true);
      }}
      aria-orientation="vertical"
      title={t("Drag to resize chat")}
      className="absolute top-0 right-0 z-20 h-full w-1.5 cursor-col-resize hover:bg-line-strong"
      onPointerDown={(event) => {
        event.preventDefault();
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startW: width };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        layout.setState((state) => chatWidthDragged(state, start.startW + event.clientX - start.startX), true);
      }}
      onLostPointerCapture={commit}
      onPointerUp={commit}
    />
  );
}
