/**
 * Live's status line above the game (`live-fresh.ts`): one line, shown only while a view is not
 * the newest version, saying what is being made or what waits, with Update once there is
 * something to bring in. Above the game, never over it: the web game view paints over the window,
 * and the Native canvas says the same in the same place.
 */
import type { JSX } from "react";
import { Button } from "../../ui/Button.tsx";
import { type LiveFresh, LiveFreshState } from "./live-fresh.ts";

/** The line for `fresh`, or nothing while the view is current. `onUpdate` is the strip's Reload. */
export function LiveFreshLine({
  fresh,
  onUpdate,
}: {
  fresh: LiveFresh | null;
  onUpdate: () => void;
}): JSX.Element | null {
  if (!fresh) return null;
  const building = fresh.state === LiveFreshState.Building;
  return (
    <div
      data-stage-live-fresh={fresh.state}
      className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-1.5"
    >
      <span role="status" className="min-w-0 flex-1 text-body-sm text-pretty">
        <span className={building ? "chat-status-shimmer" : "font-medium text-ink"}>{fresh.title}</span>
        {fresh.note ? <span className="text-ink-3">{` ${fresh.note}`}</span> : null}
      </span>
      {fresh.action ? (
        <Button data-stage-live-update="" variant="accent-tint" onClick={onUpdate}>
          {fresh.action}
        </Button>
      ) : null}
    </div>
  );
}
