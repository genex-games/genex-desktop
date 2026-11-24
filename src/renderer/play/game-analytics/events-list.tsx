/**
 * The list of events: a search box that filters by name as it is typed, the game's own events and
 * then the ones Genex counts, each row with its count, its players and its events per player.
 * Pressing a row asks for that event. A game that sends none of its own says how to start.
 */
import type { JSX, ReactNode } from "react";
import { Icon } from "../../ui/icons.tsx";
import type { EventListRow, EventsList } from "./events-view.ts";
import { EVENTS_WORDS as WORDS } from "./events-words.ts";
import { ColumnKind, type DataColumn, DataTable, EmptyNote, ReportSection } from "./kit/index.ts";

/** The decimals of events per player. */
const PER_PLAYER_DIGITS = 1;
/** A name's track, then each number's: narrow enough for the list's column. */
const NAME_TRACK = "minmax(112px, 1.8fr)";
const NUMBER_TRACK = "minmax(68px, 0.8fr)";

/** The columns of one group of events; its names are the game's own words when `own`. */
function columnsOf(own: boolean): DataColumn<EventListRow>[] {
  return [
    {
      id: "name",
      label: WORDS.list.event,
      kind: ColumnKind.Text,
      value: (row) => row.name,
      mono: true,
      mask: own,
      width: NAME_TRACK,
    },
    { id: "count", label: WORDS.list.count, kind: ColumnKind.Number, value: (row) => row.count, width: NUMBER_TRACK },
    {
      id: "players",
      label: WORDS.list.players,
      kind: ColumnKind.Number,
      value: (row) => row.players,
      width: NUMBER_TRACK,
    },
    {
      id: "per-player",
      label: WORDS.list.perPlayer,
      kind: ColumnKind.Number,
      digits: PER_PLAYER_DIGITS,
      value: (row) => row.perPlayer,
      width: NUMBER_TRACK,
    },
  ];
}

/** A group of events: its name over its table. */
function Group({ id, title, children }: { id: string; title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="game-analytics-events-group" data-game-analytics-events-group={id}>
      <h3 className="game-analytics-events-subtitle">{title}</h3>
      {children}
    </div>
  );
}

/** What the list says when the game sends no event of its own, and the button that opens the SDK tab. */
function NoOwnEvents({ sdkReady, onOpenSdk }: { sdkReady: boolean; onOpenSdk: () => void }): JSX.Element {
  return (
    <div className="game-analytics-events-start" data-game-analytics-events-start={sdkReady ? "ready" : "old-sdk"}>
      <EmptyNote>{sdkReady ? WORDS.list.noOwn : WORDS.list.oldSdk}</EmptyNote>
      <button type="button" className="game-analytics-events-link" data-game-analytics-open="sdk" onClick={onOpenSdk}>
        {sdkReady ? WORDS.list.noOwnOpen : WORDS.list.oldSdkOpen}
      </button>
    </div>
  );
}

/** What `EventsListSection` is given. */
export interface EventsListProps {
  list: EventsList;
  /** The search box's text. */
  query: string;
  /** The event whose row is marked. */
  selected: string | null;
  onQuery: (query: string) => void;
  onPick: (name: string) => void;
  onOpenSdk: () => void;
}

/** The list of events with its search. */
export function EventsListSection({ list, query, selected, onQuery, onPick, onOpenSdk }: EventsListProps): JSX.Element {
  const pick = (row: EventListRow): void => onPick(row.name);
  return (
    <ReportSection id="events" title={WORDS.list.title} hint={WORDS.list.hint}>
      <label className="game-analytics-events-search">
        <Icon name="search" size={14} />
        <input
          type="text"
          value={query}
          placeholder={WORDS.list.search}
          aria-label={WORDS.list.search}
          autoComplete="off"
          spellCheck={false}
          data-game-analytics-events-search
          data-analytics-mask
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      {list.noMatch ? (
        <EmptyNote>{WORDS.list.noMatch}</EmptyNote>
      ) : (
        <>
          {list.noOwn && <NoOwnEvents sdkReady={list.sdkReady} onOpenSdk={onOpenSdk} />}
          {list.custom.length > 0 && (
            <Group id="mine" title={WORDS.list.mine}>
              <DataTable
                id="events-mine"
                label={WORDS.list.mine}
                columns={columnsOf(true)}
                rows={list.custom}
                rowId={(row) => row.name}
                onSelect={pick}
                selectedId={selected}
              />
            </Group>
          )}
          {list.automatic.length > 0 && (
            <Group id="automatic" title={WORDS.list.automatic}>
              <DataTable
                id="events-automatic"
                label={WORDS.list.automatic}
                columns={columnsOf(false)}
                rows={list.automatic}
                rowId={(row) => row.name}
                onSelect={pick}
                selectedId={selected}
              />
            </Group>
          )}
        </>
      )}
    </ReportSection>
  );
}
