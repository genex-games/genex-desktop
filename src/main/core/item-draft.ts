/**
 * A listing draft in a Genex CLI answer (marketplace plan 8.3, 10.3; contract "CLI `--json`
 * draft"). The game's agent makes a store item with `genex shop add … --json`, or changes one with
 * `genex shop set <id> … --json`, through Studio's `genex__cli` or `genex__cli-paid`; the pinned CLI prints one JSON
 * document, a CreatorSku with `kind: "genex.item_draft"` and `version: 1`. Studio draws the Listing
 * draft card from that document only: a real, successful run of one of those two commands, read as
 * hostile input like any genex.games answer (`play/store.ts`), naming the game's own hosted project.
 * Anything else, words the agent wrote included, draws no card (D40). A draft made before the game
 * is on Genex is local (`state: "local"`): its card needs no hosted project, only a whole draft.
 */
import {
  isContentHash,
  isItemDraftDocument,
  isLocalItemId,
  LOCAL_DRAFT_STATE,
  type ListingRecord,
  localDraftOf,
} from "../../shared/item-draft.ts";
import { isItemId, type StoreRefusal, storeRefusalOf } from "../../shared/store-items.ts";
import { creatorItemOf } from "../play/store.ts";
import { GenexCliCommand } from "./genex-cli-policy.ts";

/** The commands whose answer may be a draft. */
const DRAFT_COMMANDS: ReadonlySet<string> = new Set<GenexCliCommand>([
  GenexCliCommand.ShopAdd,
  GenexCliCommand.ShopSet,
]);

/** What a CLI run answered, as `GenexCliService` hands it back. */
export interface DraftAnswer {
  command: string;
  ok: boolean;
  output: unknown;
}

/**
 * The listing draft a CLI answer carries, for the game `project` whose hosted Genex project is
 * `hostedProjectId`; null for any other command, a failed run, output that is not a whole draft,
 * or a draft of another project. A local draft needs no hosted project.
 */
export function draftInCliAnswer(
  answer: DraftAnswer,
  project: string,
  hostedProjectId: string | null,
): ListingRecord | null {
  if (!answer.ok || !DRAFT_COMMANDS.has(answer.command)) return null;
  if (!isItemDraftDocument(answer.output)) return null;
  if (answer.output.state === LOCAL_DRAFT_STATE) return localDraftOf(answer.output, project);
  if (!hostedProjectId) return null;
  const item = creatorItemOf(answer.output, false);
  if (!item || item.projectId !== hostedProjectId) return null;
  return {
    project,
    itemId: item.id,
    name: item.name,
    description: item.description,
    type: item.type,
    priceCoins: item.priceCoins,
    priceDisplayUsdCents: item.priceDisplayUsdCents,
    iconUrl: item.iconUrl,
    state: item.state,
    shareable: item.shareable,
  };
}

/** What the CLI's `shop sync --json` calls itself (contract "Local item drafts"). Wire value: never rename it. */
export const ITEM_SYNC_KIND = "genex.item_sync";
/** The sync document's version Studio reads. */
export const ITEM_SYNC_VERSION = 1;
/** The most drafts one sync reports that Studio reads. */
const SYNCED_MAX = 200;
/** A field a refused upload names: a word of the CLI's flags, never text to show as is. */
const FIELD = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/** One local draft as Studio's `shop sync` left it: uploaded (its SKU) or refused (genex.games' code). */
export interface SyncedItem {
  localId: string;
  contentHash: string;
  /** Its SKU on genex.games, a draft there; null when the upload was refused and the draft stayed local. */
  skuId: string | null;
  refusal: StoreRefusal | null;
  field: string | null;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One entry of a sync's answer, or null when it does not read: a local id and hash, and a SKU or a refusal. */
function syncedItemOf(value: unknown): SyncedItem | null {
  if (!isPlainRecord(value)) return null;
  const { localId, contentHash, skuId, error, field } = value;
  if (!isLocalItemId(localId) || !isContentHash(contentHash)) return null;
  const named = typeof field === "string" && FIELD.test(field) ? field : null;
  if (typeof error === "string")
    return { localId, contentHash, skuId: null, refusal: storeRefusalOf(error), field: named };
  if (!isItemId(skuId)) return null;
  return { localId, contentHash, skuId, refusal: null, field: null };
}

/**
 * The drafts a CLI `shop sync --json` answer reports, read as hostile input: null unless it names
 * itself the sync document; entries that do not read are left out.
 */
export function itemSyncOf(output: unknown): SyncedItem[] | null {
  if (!isPlainRecord(output) || output.kind !== ITEM_SYNC_KIND || output.version !== ITEM_SYNC_VERSION) return null;
  if (!Array.isArray(output.items)) return null;
  return output.items.slice(0, SYNCED_MAX).flatMap((item) => {
    const synced = syncedItemOf(item);
    return synced ? [synced] : [];
  });
}
