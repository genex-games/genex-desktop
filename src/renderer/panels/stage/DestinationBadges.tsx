/**
 * A C++ · raylib game's destinations on the stage strip: one compact badge each, inside one
 * focusable group whose tooltip says where each stands on this computer (`destinations.ts`
 * decides; a cross-build is labelled honestly as built here and never run here). A build
 * running or failed says so beside its label; the standing words are in the tooltip, and a screen
 * reader hears them in place.
 */
import type { JSX } from "react";
import type { BuildPhase } from "../../../shared/build-problem.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx";
import type { DestinationBadgeView } from "./destinations.ts";

/** One badge: its label, its phase out loud, and the rest for a screen reader. */
function Badge({ badge }: { badge: DestinationBadgeView }): JSX.Element {
  return (
    <span
      data-stage-destination={badge.target}
      data-destination-state={badge.state}
      className="rounded-control bg-inset px-1.5 py-0.5 text-micro text-ink-3"
    >
      <span className="text-ink-2">{badge.label}</span>
      {badge.loud ? (
        <span className="text-ink-2"> · {badge.text}</span>
      ) : (
        <span className="sr-only">: {badge.text}</span>
      )}
      <span className="sr-only">{badge.why ? `. ${badge.why} ` : ". "}</span>
    </span>
  );
}

/** The destinations, in the game's own order; the group is the tooltip's trigger, so focus opens it too. */
export function DestinationBadges({
  badges,
  phase,
}: {
  badges: readonly DestinationBadgeView[];
  /** `data-stage-build-phase`: building while any build runs, failed when Live's own build did. */
  phase: BuildPhase | null;
}): JSX.Element | null {
  if (badges.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-stage-destinations=""
          data-stage-build-phase={phase ?? ""}
          className="no-drag inline-flex h-8 shrink-0 cursor-default items-center gap-1 rounded-lg px-1"
        >
          {badges.map((badge) => (
            <Badge key={badge.target} badge={badge} />
          ))}
        </button>
      </TooltipTrigger>
      {/* Beside, not below: a tooltip under the strip would sit behind the native game view. */}
      <TooltipContent side="right" sideOffset={6} className="max-w-80">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-left">
          {badges.map((badge) => (
            <li key={badge.target}>
              {badge.label} · {badge.text}
              {badge.why ? <span className="block opacity-75">{badge.why}</span> : null}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
