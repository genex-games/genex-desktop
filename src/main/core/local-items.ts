/**
 * A game's local item drafts once it is on Genex (contract "Local item drafts"): after a publish
 * finishes, and when the game is opened or the window comes back (paced, one at a time per game),
 * Studio runs its own `genex shop sync --json` while the game holds drafts, then puts every uploaded
 * draft on sale (`itemPutOnSale`, as Put on sale does). Right after a publish it also puts on sale
 * the game's items still drafts on genex.games: a draft listed once the game was on Genex goes on
 * sale with the publish that carries it, never on a mere focus. genex.games' refusals (of the
 * upload, or of Put on sale) are kept with their codes for the cards. Only Studio's own sync names
 * what goes up: nothing in the game folder does. The drafts as the CLI printed them and the
 * outcomes live in Studio's app data (`item-approvals.ts`). Electron-free: everything outside comes
 * in as deps.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import {
  type LocalItemsView,
  type LocalListingDraft,
  type LocalOutcome,
  LocalOutcomeKind,
  type LocalShareResult,
} from "../../shared/item-draft.ts";
import {
  type CreatorItem,
  ItemState,
  isStoreRefused,
  type Selling,
  type StoreRefused,
  StoreRefusal,
} from "../../shared/store-items.ts";
import type { LocalDraftChange } from "./genex-cli.ts";
import {
  type ApprovalsDoc,
  approvalFor,
  approve,
  forget,
  type ItemApprovals,
  knownDraftFor,
  localItemsView,
  noteDraft,
  settled,
  withdraw,
} from "./item-approvals.ts";
import type { SyncedItem } from "./item-draft.ts";

/** How long a game waits after its last settle before a focus or an open settles it again. */
export const LOCAL_SETTLE_GAP_MS = 15 * SECOND_MS;

/** The SKUs of the game `projectId`'s items on genex.games still drafts, as Selling lists them; none for a refusal. */
export function hostedDraftIds(selling: Selling | StoreRefused, projectId: string): string[] {
  if (isStoreRefused(selling)) return [];
  const drafts = selling.items.filter((row) => row.game?.id === projectId && row.state === ItemState.Draft);
  return drafts.map((row) => row.id);
}

/** What settling needs from Studio. */
export interface LocalItemsDeps {
  approvals: ItemApprovals;
  /**
   * Whether the game is public on Genex: its publish marked its hosted project published. A publish
   * that failed part-way, or is still running, has made the project but not published it yet.
   */
  published(project: string): Promise<boolean>;
  /** Whether the game's folder holds local drafts: cheap, read before anything runs. */
  hasDrafts(project: string): Promise<boolean>;
  /** Studio's own `genex shop sync --json` for the game (uploaded drafts leave the game); null: nothing read. */
  sync(project: string): Promise<SyncedItem[] | null>;
  /** Main's own `genex shop set <localId> --shared|--no-shared`, for the person. */
  setShared(project: string, localId: string, shared: boolean): Promise<LocalDraftChange | null>;
  /** Put on sale on genex.games, as the app's account. */
  putOnSale(skuId: string): Promise<CreatorItem | StoreRefused>;
  /** The game's items on genex.games that are still drafts, by SKU; throws when genex.games can't be read. */
  hostedDrafts(project: string): Promise<string[]>;
  now(): number;
  /** The game's local drafts changed: the renderer reads them again. */
  changed(project: string): void;
}

/**
 * Whether the approval of `localId` follows a change the person made on the card showing
 * `contentHash`: they approved what the card shows, and the run changed exactly those bytes (`staged`,
 * Studio's fingerprint of what the run took from the game, equals the one noted with the draft).
 */
function approvalFollows(
  doc: ApprovalsDoc,
  project: string,
  localId: string,
  contentHash: string,
  staged: string | null,
): boolean {
  const known = knownDraftFor(doc, project, localId);
  const approved = approvalFor(doc, project, localId)?.contentHash === contentHash;
  const shown = known?.draft.contentHash === contentHash;
  const print = known?.fingerprint ?? null;
  const sameBytes = print !== null && print === staged;
  return approved && shown && sameBytes;
}

/** A game's local drafts: the person's approvals and sharing, and the settle after its publish. */
export class LocalItems {
  readonly #deps: LocalItemsDeps;
  /** When each game last settled. */
  readonly #settledAt = new Map<string, number>();
  /** The settle running per game: a second ask waits for it. */
  readonly #settling = new Map<string, Promise<LocalItemsView>>();
  constructor(deps: LocalItemsDeps) {
    this.#deps = deps;
  }

  /** The game's local drafts as Studio holds them. */
  async view(project: string): Promise<LocalItemsView> {
    return localItemsView(await this.#deps.approvals.read(), project);
  }

  /** The person's "Sell when published" on the draft as it holds `contentHash`. */
  approve(project: string, localId: string, contentHash: string): Promise<LocalItemsView> {
    return this.#update(project, (doc) => approve(doc, project, localId, contentHash, this.#deps.now()));
  }

  /** The person took "Sell when published" back. */
  withdraw(project: string, localId: string): Promise<LocalItemsView> {
    return this.#update(project, (doc) => withdraw(doc, project, localId));
  }

  /** The CLI printed a local draft for the game's agent, and the game holds it (`fingerprint`). */
  async noteDraft(draft: LocalListingDraft, fingerprint: string | null): Promise<void> {
    await this.#update(draft.project, (doc) => noteDraft(doc, draft, fingerprint));
  }

  /** The game's agent removed these drafts. */
  async forget(project: string, localIds: readonly string[]): Promise<void> {
    await this.#update(project, (doc) => forget(doc, project, localIds));
  }

  /**
   * The person's "Other games can use it" on a local draft, whose card shows `contentHash`. Their
   * approval follows the change (under the new hash) only when the run changed the very bytes the
   * card showed and they approved; a change the agent made to the game's files, before or during the
   * press, is never approved.
   */
  async share(project: string, localId: string, contentHash: string, shared: boolean): Promise<LocalShareResult> {
    const change = await this.#deps.setShared(project, localId, shared).catch(() => null);
    if (!change) return { failed: true };
    await this.#update(project, (current) => {
      const keeps = approvalFollows(current, project, localId, contentHash, change.staged);
      const noted = noteDraft(current, change.draft, change.fingerprint);
      return keeps ? approve(noted, project, localId, change.draft.contentHash, this.#deps.now()) : noted;
    });
    return { draft: change.draft };
  }

  /**
   * Settle the game's local drafts: at once after its publish finished (`force`), else at most once
   * per {@link LOCAL_SETTLE_GAP_MS}; never two at a time.
   */
  settle(project: string, options: { force: boolean }): Promise<LocalItemsView> {
    const running = this.#settling.get(project);
    if (running) return running;
    const last = this.#settledAt.get(project);
    const recent = last !== undefined && this.#deps.now() - last < LOCAL_SETTLE_GAP_MS;
    if (recent && !options.force) return this.view(project);
    const run = this.#settle(project, options.force).finally(() => this.#settling.delete(project));
    this.#settling.set(project, run);
    return run;
  }

  async #settle(project: string, publishedNow: boolean): Promise<LocalItemsView> {
    this.#settledAt.set(project, this.#deps.now());
    const published = await this.#deps.published(project).catch(() => false);
    if (!published) return this.view(project);
    const view = await this.#upload(project);
    if (publishedNow) await this.#hostedOnSale(project);
    return view;
  }

  /** Upload the game's local drafts, and put each upload on sale. */
  async #upload(project: string): Promise<LocalItemsView> {
    if (!(await this.#deps.hasDrafts(project).catch(() => false))) return this.view(project);
    const synced = await this.#deps.sync(project).catch(() => null);
    if (!synced || synced.length === 0) return this.view(project);
    const outcomes: Record<string, LocalOutcome> = {};
    const used: string[] = [];
    for (const item of synced) {
      if (item.skuId) used.push(item.localId);
      outcomes[item.localId] = await this.#outcomeOf(item);
    }
    return this.#update(project, (current) => settled(current, project, outcomes, used));
  }

  /** Put on sale the game's items still drafts on genex.games; one it can't put stays as it is. */
  async #hostedOnSale(project: string): Promise<void> {
    const drafts = await this.#deps.hostedDrafts(project).catch((): string[] => []);
    for (const skuId of drafts) await this.#deps.putOnSale(skuId).catch(() => null);
    if (drafts.length > 0) this.#deps.changed(project);
  }

  /** What becomes of one synced draft: on sale, unless genex.games refused its upload or the sale. */
  async #outcomeOf(item: SyncedItem): Promise<LocalOutcome> {
    const at = this.#deps.now();
    const { skuId, contentHash } = item;
    if (!skuId)
      return {
        kind: LocalOutcomeKind.Refused,
        skuId: null,
        contentHash,
        refusal: item.refusal ?? StoreRefusal.Unknown,
        field: item.field,
        at,
      };
    const uploaded = { skuId, contentHash, refusal: null, field: null, at };
    const answer = await this.#deps.putOnSale(skuId).catch((): StoreRefused => ({ refused: StoreRefusal.Unknown }));
    if (isStoreRefused(answer)) return { kind: LocalOutcomeKind.Refused, ...uploaded, refusal: answer.refused };
    return { kind: LocalOutcomeKind.OnSale, ...uploaded };
  }

  /** Change the game's record, tell the renderer, and answer the game's view. */
  async #update(project: string, change: (doc: ApprovalsDoc) => ApprovalsDoc): Promise<LocalItemsView> {
    const doc = await this.#deps.approvals.update(change);
    this.#deps.changed(project);
    return localItemsView(doc, project);
  }
}
