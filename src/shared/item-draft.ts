/**
 * A listing draft (marketplace P11, plan 8.3): an item the game's chat agent made with
 * `genex shop add --json`, or changed with `genex shop set --json`, through Studio's own
 * `genex__cli` (`shop add`) or `genex__cli-paid` (`shop set`). Studio main recognises it in the real tool result (`main/core/item-draft.ts`),
 * never in anything the agent wrote, and records it in the chat as `item_drafted`, a record only
 * the host writes. The chat draws it as the Listing draft card, whose buttons call genex.games from
 * main (`itemSetShared`, `itemPutOnSale`): the agent never presses them (D40).
 *
 * An item made before its game is on Genex is a local draft (`state: "local"`): the CLI keeps it in
 * the game's `.genex/items/` until the game is published. Its card offers "Sell when published",
 * the person's approval, which Studio keeps in its own app data (`main/core/item-approvals.ts`) and
 * honours after the publish only for the very content approved (its `contentHash`). Browser-safe.
 */
import { withoutBidiControls } from "./play-purchase.ts";
import {
  isItemId,
  isItemState,
  isItemType,
  ITEM_DESCRIPTION_MAX,
  ITEM_NAME_MAX,
  ITEM_TAG_LENGTH_MAX,
  ITEM_TAGS_MAX,
  type ItemState,
  type ItemType,
  type StoreRefusal,
} from "./store-items.ts";

/** What the CLI's `--json` draft calls itself (contract "CLI `--json` draft"). Wire value: never rename it. */
export const ITEM_DRAFT_KIND = "genex.item_draft";
/** The draft document's version Studio reads. */
export const ITEM_DRAFT_VERSION = 1;

/**
 * The `state` the CLI's `--json` draft gives an item made before its game is on Genex: it waits in
 * the game's `.genex/items/` (contract "Local item drafts"). Wire value: never rename it.
 */
export const LOCAL_DRAFT_STATE = "local";

/** A local draft's id: `local_` and 12 lowercase letters or digits (the CLI's base32 or hex). */
const LOCAL_ID = /^local_[a-z0-9]{12}$/;
/** A local draft's content hash: the CLI's sha256, in lowercase hex. */
const CONTENT_HASH = /^[0-9a-f]{64}$/;
/** Line breaks, tabs and every other control character. */
const CONTROLS = /[\u0000-\u001f\u007f]/g;
const CONTROLS_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** Whether a value is a local draft's id as the CLI makes one: all a host-run command may name. */
export const isLocalItemId = (value: unknown): value is string => typeof value === "string" && LOCAL_ID.test(value);
/** Whether a value is a content hash as the CLI prints one. */
export const isContentHash = (value: unknown): value is string => typeof value === "string" && CONTENT_HASH.test(value);

/** The most coin an item may cost: what Studio confirms at most on its own sheet. */
const PRICE_MAX = 100_000;
/** The longest local game name a record may carry. */
const PROJECT_MAX = 200;

/** A listing draft as the chat's card shows it. */
export interface ListingDraft {
  /** The local game whose chat made it. */
  project: string;
  /** Its SKU id at genex.games: what Put on sale and the toggle act on. */
  itemId: string;
  name: string;
  description: string | null;
  type: ItemType;
  /** 0 is Free. */
  priceCoins: number;
  priceDisplayUsdCents: number;
  /** Its picture on a host the app loads images from, or null while it has none. */
  iconUrl: string | null;
  state: ItemState;
  /** "Other games can use it". */
  shareable: boolean;
}

/**
 * A store item made before its game is on Genex, as the CLI's `--json` draft printed it and the
 * chat's card shows it: it has no SKU yet, only its local id and the hash of what it holds.
 */
export interface LocalListingDraft {
  /** The local game whose chat made it. */
  project: string;
  state: typeof LOCAL_DRAFT_STATE;
  localId: string;
  name: string;
  description: string | null;
  type: ItemType;
  /** 0 is Free. */
  priceCoins: number;
  tags: string[];
  /** "Other games can use it". */
  shareable: boolean;
  /** The CLI's hash of its fields and files: what the person's "Sell when published" approves. */
  contentHash: string;
}

/** What an `item_drafted` record carries: an item on genex.games, or a local draft. */
export type ListingRecord = ListingDraft | LocalListingDraft;

/** Whether a card's item is a local draft. */
export const isLocalDraft = (draft: ListingRecord): draft is LocalListingDraft => draft.state === LOCAL_DRAFT_STATE;

/** The key one item's cards share in a chat: its SKU, or its local id (never the same text). */
export const listingKey = (draft: ListingRecord): string =>
  isLocalDraft(draft) ? `local:${draft.localId}` : `item:${draft.itemId}`;

/** The person's "Sell when published" on one local draft: the content approved, and when. */
export interface ItemApproval {
  contentHash: string;
  at: number;
}

/** What became of a local draft once its game was published (`main/core/local-items.ts`). Wire values. */
export const LocalOutcomeKind = {
  /** Approved, uploaded and put on sale. */
  OnSale: "on-sale",
  /** Uploaded as a draft on genex.games, with no approval: Put on sale is the person's. */
  Draft: "draft",
  /** Uploaded as a draft, but changed since the person approved it: it stays a draft. */
  Changed: "changed",
  /** genex.games refused the upload (it stays local) or Put on sale (it stays a draft). */
  Refused: "refused",
} as const;
export type LocalOutcomeKind = (typeof LocalOutcomeKind)[keyof typeof LocalOutcomeKind];

/** What became of a local draft: its SKU once uploaded, and genex.games' refusal when it refused. */
export interface LocalOutcome {
  kind: LocalOutcomeKind;
  /** Its SKU on genex.games; null while it is still local (a refused upload). */
  skuId: string | null;
  /**
   * The content the sync sent (its hash), which an edit outside Studio makes differ from the draft its
   * card shows; null when the record does not say. A card offers nothing on content it never showed.
   */
  contentHash: string | null;
  refusal: StoreRefusal | null;
  /** The field a refused upload names (`price`, `name`), when it names one. */
  field: string | null;
  at: number;
}

/**
 * One game's local drafts as Studio holds them: the person's approvals, each draft as the CLI last
 * printed it (newer than a chat card after the person's own change), the drafts the agent removed,
 * and what became of each after the publish.
 */
export interface LocalItemsView {
  project: string;
  approvals: Record<string, ItemApproval>;
  drafts: Record<string, LocalListingDraft>;
  removed: string[];
  outcomes: Record<string, LocalOutcome>;
}

/** What the person's "Other games can use it" on a local draft answers: the draft after it, or a failure. */
export type LocalShareResult = { draft: LocalListingDraft } | { failed: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const wholeIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** One line of text with no control or bidi character, at most `max` long once trimmed; else null. */
function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = withoutBidiControls(value).replace(CONTROLS, "").trim();
  return clean && clean.length <= max ? clean : null;
}

/** A description with its lines kept: null for none, undefined when it is not one an item may have. */
function cleanProse(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const clean = withoutBidiControls(value).replace(CONTROLS_BUT_NEWLINE, "").trim();
  if (clean.length > ITEM_DESCRIPTION_MAX) return undefined;
  return clean || null;
}

/** An item's tags: at most ten, each one line of at most 32 characters; null when they are not. */
function tagsOf(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ITEM_TAGS_MAX) return null;
  const tags = value.map((tag) => cleanLine(tag, ITEM_TAG_LENGTH_MAX));
  return tags.every((tag): tag is string => tag !== null) ? tags : null;
}

/**
 * The local draft a document carries for the game `project` (the CLI's `--json` line, or an
 * `item_drafted` record): null unless it says `state: "local"` and every field reads.
 */
export function localDraftOf(value: unknown, project: string): LocalListingDraft | null {
  if (!isRecord(value) || value.state !== LOCAL_DRAFT_STATE) return null;
  const { localId, type, priceCoins, shareable, contentHash } = value;
  const name = cleanLine(value.name, ITEM_NAME_MAX);
  const description = cleanProse(value.description);
  const tags = tagsOf(value.tags);
  const known = isLocalItemId(localId) && isContentHash(contentHash) && isItemType(type);
  const settled = wholeIn(priceCoins, 0, PRICE_MAX) && typeof shareable === "boolean";
  if (!name || description === undefined || !tags || !known || !settled) return null;
  return {
    project,
    state: LOCAL_DRAFT_STATE,
    localId,
    name,
    description,
    type,
    priceCoins,
    tags,
    shareable,
    contentHash,
  };
}

/** Whether a document names itself a listing draft Studio reads: the CLI's kind and version, nothing else. */
export const isItemDraftDocument = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.kind === ITEM_DRAFT_KIND && value.version === ITEM_DRAFT_VERSION;

/** Text of at most `max` characters, or null. */
const textOf = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : null;

/** An https picture address, or null: the window's own policy decides which hosts it loads. */
function pictureOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The draft an `item_drafted` record carries, or null when anything the card needs is missing or is
 * not what it says. The host writes these records only, but old logs keep old shapes: every field
 * is read again here.
 */
export function listingDraftOf(payload: unknown): ListingRecord | null {
  if (!isRecord(payload)) return null;
  const project = textOf(payload.project, PROJECT_MAX);
  if (payload.state === LOCAL_DRAFT_STATE) return project ? localDraftOf(payload, project) : null;
  const { itemId, type, state, shareable, priceCoins, priceDisplayUsdCents } = payload;
  const name = textOf(payload.name, ITEM_NAME_MAX);
  const description = payload.description === null ? null : textOf(payload.description, ITEM_DESCRIPTION_MAX);
  const described = payload.description === null || description !== null;
  const priced = wholeIn(priceCoins, 0, PRICE_MAX) && wholeIn(priceDisplayUsdCents, 0, Number.MAX_SAFE_INTEGER);
  const known = isItemId(itemId) && isItemType(type) && isItemState(state) && typeof shareable === "boolean";
  if (!project || !name || !described || !priced || !known) return null;
  return {
    project,
    itemId,
    name,
    description,
    type,
    priceCoins,
    priceDisplayUsdCents,
    iconUrl: pictureOf(payload.iconUrl),
    state,
    shareable,
  };
}
