/**
 * The columns of the Revenue report's two tables: what was bought, and the sources that bring
 * players who pay. Each is read from a row of `revenue-view.ts`; a number a row does not have (an
 * item with no one price, a total's share) is the kit's dash or an empty cell.
 */
import { ColumnKind, type DataColumn, formatNexPerPlayer } from "./kit/index.ts";
import type { ItemRow, SourceRow } from "./revenue-view.ts";
import { REVENUE_WORDS } from "./revenue-words.ts";

/** What was bought: the item (a creator's own words), its price, its sales and its share of all Nex. */
export const ITEM_COLUMNS: readonly DataColumn<ItemRow>[] = [
  {
    id: "item",
    label: REVENUE_WORDS.items.item,
    kind: ColumnKind.Text,
    value: (row) => row.name,
    mask: true,
    width: "minmax(120px, 1.4fr)",
  },
  {
    id: "price",
    label: REVENUE_WORDS.items.price,
    kind: ColumnKind.Nex,
    value: (row) => row.price,
    width: "minmax(52px, 0.6fr)",
  },
  {
    id: "sold",
    label: REVENUE_WORDS.items.sold,
    kind: ColumnKind.Number,
    value: (row) => row.sold,
    width: "minmax(52px, 0.6fr)",
  },
  {
    id: "buyers",
    label: REVENUE_WORDS.items.buyers,
    kind: ColumnKind.Number,
    value: (row) => row.buyers,
    width: "minmax(60px, 0.7fr)",
  },
  {
    id: "nex",
    label: REVENUE_WORDS.items.nex,
    kind: ColumnKind.Nex,
    value: (row) => row.nex,
    width: "minmax(64px, 0.8fr)",
  },
  {
    id: "share",
    label: REVENUE_WORDS.items.share,
    kind: ColumnKind.Rate,
    value: (row) => row.share,
    quiet: true,
    // Room for "Share of Nex" on one line.
    width: "minmax(96px, 0.8fr)",
  },
];

/** The channels that first brought players: how many, how many paid, and what they spent. */
export const SOURCE_COLUMNS: readonly DataColumn<SourceRow>[] = [
  {
    id: "source",
    label: REVENUE_WORDS.sources.source,
    kind: ColumnKind.Text,
    value: (row) => row.name,
    width: "minmax(160px, 1.6fr)",
  },
  {
    id: "players",
    label: REVENUE_WORDS.sources.players,
    kind: ColumnKind.Number,
    value: (row) => row.players,
    quiet: true,
  },
  { id: "payers", label: REVENUE_WORDS.sources.paying, kind: ColumnKind.Number, value: (row) => row.payers },
  { id: "paying", label: REVENUE_WORDS.sources.share, kind: ColumnKind.Rate, value: (row) => row.paying, quiet: true },
  { id: "nex", label: REVENUE_WORDS.sources.nex, kind: ColumnKind.Nex, value: (row) => row.nex },
  {
    id: "nexEach",
    label: REVENUE_WORDS.sources.nexEach,
    kind: ColumnKind.Nex,
    value: (row) => row.nexEach,
    format: formatNexPerPlayer,
  },
];
