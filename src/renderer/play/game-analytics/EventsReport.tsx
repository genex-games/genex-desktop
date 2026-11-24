/**
 * Events: what the game reports about itself. A strip says whether events are arriving; on the
 * left the list of events with its search, on the right the one picked in full; under them the
 * creator's saved funnels and the form that makes one. The shell mounts it only with an answer to
 * draw (`report-props.ts` says what it is given), and everything it shows is derived in
 * `events-view.ts`. What it keeps itself is the search box's text.
 */
import type { JSX } from "react";
import { useState } from "react";
import { GameReport } from "../../../shared/game-analytics.ts";
import { EventDetail } from "./events-detail.tsx";
import { FunnelsSection, type FunnelsSectionProps } from "./events-funnels.tsx";
import { EventsListSection } from "./events-list.tsx";
import { type EventsStrip, type EventsView, Arrival, eventAsked, eventsView, splitAsked } from "./events-view.ts";
import { EVENTS_WORDS as WORDS } from "./events-words.ts";
import type { EventsReportProps } from "./report-props.ts";
import { AnalyticsTab } from "./tabs.ts";

/** The line above the list: whether events arrive, the last one, how many there are, and the way to the SDK tab. */
function Strip({ strip, onOpenSdk }: { strip: EventsStrip; onOpenSdk: () => void }): JSX.Element {
  return (
    <div className="game-analytics-events-strip" data-game-analytics-events-strip={strip.arrival}>
      <span className="game-analytics-events-status">
        <span className="game-analytics-events-dot" aria-hidden="true" data-arrival={strip.arrival} />
        {strip.status}
      </span>
      {strip.last && <span className="game-analytics-events-faint">{strip.last}</span>}
      {strip.counted && <span className="game-analytics-events-faint">{strip.counted}</span>}
      {strip.arrival !== Arrival.None && (
        <button
          type="button"
          className="game-analytics-events-link"
          data-game-analytics-open={AnalyticsTab.Sdk}
          onClick={onOpenSdk}
        >
          {WORDS.status.watch}
        </button>
      )}
    </div>
  );
}

/** What `EventsFace` is given: the view to draw, the search's text, and what its controls ask. */
export interface EventsFaceProps extends Pick<FunnelsSectionProps, "onSave" | "onRemove"> {
  view: EventsView;
  query: string;
  onQuery: (query: string) => void;
  /** A row of the list was pressed: ask for that event. */
  onPick: (name: string) => void;
  /** A property was picked to split the event by. */
  onSplit: (property: string) => void;
  onOpenSdk: () => void;
}

/** The Events tab drawn from its view alone: the search's text is the caller's to keep. */
export function EventsFace({
  view,
  query,
  onQuery,
  onPick,
  onSplit,
  onOpenSdk,
  onSave,
  onRemove,
}: EventsFaceProps): JSX.Element {
  return (
    <div className="game-analytics-report" data-game-analytics-report={GameReport.Events}>
      <Strip strip={view.strip} onOpenSdk={onOpenSdk} />
      <div className="game-analytics-events-layout">
        <div className="game-analytics-events-listing">
          <EventsListSection
            list={view.list}
            query={query}
            selected={view.selected}
            onQuery={onQuery}
            onPick={onPick}
            onOpenSdk={onOpenSdk}
          />
        </div>
        {view.detail && (
          <div className="game-analytics-events-detailing">
            <EventDetail detail={view.detail} onSplit={onSplit} />
          </div>
        )}
      </div>
      <FunnelsSection view={view.funnels} firstEvent={view.selected} onSave={onSave} onRemove={onRemove} />
    </div>
  );
}

/** The Events report's body. */
export function EventsReport(props: EventsReportProps): JSX.Element {
  const { answer, options, now, onOptions, onOpenTab } = props;
  const [query, setQuery] = useState("");
  return (
    <EventsFace
      view={eventsView(answer, options, query, now)}
      query={query}
      onQuery={setQuery}
      onPick={(name) => onOptions(eventAsked(name))}
      onSplit={(property) => onOptions(splitAsked(property))}
      onOpenSdk={() => onOpenTab(AnalyticsTab.Sdk)}
      onSave={props.onSaveFunnel}
      onRemove={props.onRemoveFunnel}
    />
  );
}
