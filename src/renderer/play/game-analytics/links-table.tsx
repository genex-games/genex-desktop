/**
 * The saved links: what each brought over the period, with Copy for its link and Remove, which
 * asks in the row before it removes anything. The removal in flight is the page's to keep
 * (`LinksPage`); this table draws it and says what a press asks.
 */
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { ColumnKind, type DataColumn, DataTable, ReportSection } from "./kit/index.ts";
import { CopyIconButton } from "./links-copy.tsx";
import { type LinkRow, linkRows, type Removal, RemovalStep } from "./links-view.ts";
import { LINKS_WORDS as WORDS } from "./links-words.ts";
import type { LinksPageProps } from "./report-props.ts";

/** The column of a row's buttons: Copy and Remove, or the two buttons that confirm a removal (German's "Behalten" and "Entfernen" are the widest). */
const ACTIONS_TRACK = "216px";
/** The one-line columns: the campaign's name takes what the rest leave. */
const CAMPAIGN_TRACK = "minmax(200px, 1.6fr)";
const VIA_TRACK = "minmax(140px, 1fr)";
const CREATED_TRACK = "72px";

/** What the table asks of the page that keeps the removal. */
export interface LinkTableActions {
  /** Remove was pressed on a row: ask before removing. */
  onAsk(id: string): void;
  /** Keep was pressed: leave the link as it is. */
  onKeep(): void;
  onRemove(id: string): void;
}

/** The two buttons a row shows while it asks whether to remove: Keep (the safe one, focused) and Remove. */
function Confirm({
  row,
  removal,
  actions,
}: {
  row: LinkRow;
  removal: Removal;
  actions: LinkTableActions;
}): JSX.Element {
  const removing = removal.step === RemovalStep.Removing;
  return (
    // Both buttons are named by the link's tags, which a usage recording must not show.
    <span className="game-analytics-links-confirm" data-analytics-mask>
      <Button
        variant="secondary"
        data-game-analytics-link-keep={row.id}
        aria-label={WORDS.keepLink(row.name)}
        disabled={removing}
        autoFocus
        onClick={actions.onKeep}
      >
        {WORDS.keep}
      </Button>
      <Button
        variant="destructive"
        data-game-analytics-link-confirm={row.id}
        aria-label={WORDS.removeLink(row.name)}
        busy={removing}
        onClick={() => actions.onRemove(row.id)}
      >
        {removing ? WORDS.removing : WORDS.remove}
      </Button>
    </span>
  );
}

/** A row's buttons: Copy for its link, and Remove, which turns into Keep and Remove while the row asks. */
function RowActions({
  row,
  removal,
  actions,
}: {
  row: LinkRow;
  removal: Removal | null;
  actions: LinkTableActions;
}): JSX.Element {
  const asking = removal !== null;
  const trash = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  // Keep puts the focus back on the button that opened the question; a removal that went through takes
  // the row with it, and the page moves the focus to a neighbour (`LinksPage`).
  useEffect(() => {
    if (wasAsking.current && !asking) trash.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  if (removal) return <Confirm row={row} removal={removal} actions={actions} />;
  return (
    // Both buttons are named by the link's tags, which a usage recording must not show.
    <span className="game-analytics-links-actions" data-analytics-mask>
      <CopyIconButton id={row.id} text={row.url} label={WORDS.copyLink(row.name)} />
      <button
        ref={trash}
        type="button"
        className="game-analytics-copy"
        data-game-analytics-link-remove={row.id}
        aria-label={WORDS.removeLink(row.name)}
        onClick={() => actions.onAsk(row.id)}
      >
        <Icon name="trash" size={14} />
      </button>
    </span>
  );
}

/** The table's columns: what a link is, what it brought, when it was made, and its buttons. */
function columnsOf(removal: Removal | null, actions: LinkTableActions): DataColumn<LinkRow>[] {
  const own = (row: LinkRow): Removal | null => (removal?.id === row.id ? removal : null);
  return [
    {
      id: "campaign",
      label: WORDS.columns.campaign,
      kind: ColumnKind.Text,
      value: (row) => row.campaign,
      detail: (row) => row.content,
      mono: true,
      mask: true,
      width: CAMPAIGN_TRACK,
    },
    {
      id: "via",
      label: WORDS.columns.via,
      kind: ColumnKind.Text,
      value: (row) => row.via,
      mono: true,
      mask: true,
      width: VIA_TRACK,
    },
    {
      id: "visitors",
      label: WORDS.columns.newVisitors,
      kind: ColumnKind.Number,
      value: (row) => row.newVisitors,
      quiet: true,
    },
    { id: "players", label: WORDS.columns.newPlayers, kind: ColumnKind.Number, value: (row) => row.newPlayers },
    {
      id: "visit-to-play",
      label: WORDS.columns.visitToPlay,
      kind: ColumnKind.Rate,
      value: (row) => row.visitToPlay,
      quiet: true,
    },
    { id: "day7", label: WORDS.columns.day7, kind: ColumnKind.Rate, value: (row) => row.day7 },
    {
      id: "created",
      label: WORDS.columns.created,
      kind: ColumnKind.Text,
      value: (row) => row.created,
      numeric: true,
      quiet: true,
      width: CREATED_TRACK,
    },
    {
      id: "actions",
      label: "",
      kind: ColumnKind.Text,
      value: () => null,
      width: ACTIONS_TRACK,
      numeric: true,
      cell: (row) => <RowActions row={row} removal={own(row)} actions={actions} />,
    },
  ];
}

/** What the saved links draw: the list and its period, the removal in flight, and what a press asks. */
export interface SavedLinksProps {
  links: LinksPageProps["links"];
  days: LinksPageProps["days"];
  removal: Removal | null;
  actions: LinkTableActions;
}

/** Saved links: a table, or what a saved link gives while there is none; under it, why the last removal failed. */
export function SavedLinks({ links, days, removal, actions }: SavedLinksProps): JSX.Element {
  return (
    <ReportSection id="saved-links" title={WORDS.savedLinks} hint={WORDS.period(days)}>
      <DataTable
        id="links"
        label={WORDS.tableLabel}
        columns={columnsOf(removal, actions)}
        rows={linkRows(links)}
        rowId={(row) => row.id}
        empty={WORDS.noLinks}
      />
      {removal?.failed && (
        <p className="game-analytics-links-failed" role="alert" data-game-analytics-link-remove-failed>
          {WORDS.removeFailed}
        </p>
      )}
    </ReportSection>
  );
}
