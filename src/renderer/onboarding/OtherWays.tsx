/**
 * The connect screen's quiet row under the subscriptions: "or use" Local models, OpenRouter or
 * OpenCode. Each button is its icon and name, or its progress, or a check once it is ready; the
 * line under the row says what the button pointed at (or focused) offers.
 */
import { useId, useState, type JSX } from "react";
import { Icon } from "../ui/icons.tsx";
import { LoaderGrid } from "../ui/LoadingState.tsx";
import { OPENCODE_MARK, OPENROUTER_MARK, type ProviderMark } from "../ui/provider-marks.ts";
import { Check } from "./parts.tsx";
import { OTHER_WAYS, OtherWay, WAYS_WORDS, WayState, type WayView } from "./ways.ts";

/** A provider's mark at icon size, in the button's own ink. */
function MarkGlyph({ mark }: { mark: ProviderMark }): JSX.Element {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" className="shrink-0">
      <path d={mark.path} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** What leads a way's words: its icon, progress while something runs, or a check once ready. */
function WayIcon({ way, state }: { way: OtherWay; state: WayState }): JSX.Element {
  if (state === WayState.On) return <Check />;
  if (state === WayState.Busy) return <LoaderGrid />;
  if (way === OtherWay.OpenRouter) return <MarkGlyph mark={OPENROUTER_MARK} />;
  if (way === OtherWay.OpenCode) return <MarkGlyph mark={OPENCODE_MARK} />;
  return <Icon name="chip" />;
}

/** The row: "or use", the three ways, and the line about the one pointed at. */
export function OtherWays({
  views,
  onOpen,
}: {
  views: Record<OtherWay, WayView>;
  onOpen: (way: OtherWay) => void;
}): JSX.Element {
  const [pointed, setPointed] = useState<OtherWay | null>(null);
  const hintId = useId();
  const leave = (way: OtherWay) => setPointed((current) => (current === way ? null : current));
  return (
    <div className="onboarding-ways">
      <p className="onboarding-ways-lead">{WAYS_WORDS.lead}</p>
      <div className="onboarding-ways-row">
        {OTHER_WAYS.map((way) => {
          const view = views[way];
          return (
            <button
              key={way}
              type="button"
              className="onboarding-way"
              data-way={way}
              data-state={view.state}
              aria-describedby={pointed === way ? hintId : undefined}
              onPointerEnter={() => setPointed(way)}
              onPointerLeave={() => leave(way)}
              onFocus={() => setPointed(way)}
              onBlur={() => leave(way)}
              onClick={() => onOpen(way)}
            >
              <WayIcon way={way} state={view.state} />
              {view.label}
            </button>
          );
        })}
      </div>
      <p id={hintId} className="onboarding-ways-hint">
        {pointed ? views[pointed].hint : ""}
      </p>
    </div>
  );
}
