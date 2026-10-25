/**
 * The items-store fixture (marketplace plan 10.3; screens 07–09): Create › Items over the fixture
 * store (`fixture-store.ts`, signed in with `STUDIO_FIXTURE_GENEX_ACCOUNT=1`). The fixture game is
 * the account's Snowball on Genex, as its Genex publish record says, so Browse's Add to and Selling's
 * New item reach its chat. That chat holds the ask, the agent's reply and the Listing draft card for
 * Frost Axe, the account's draft in the fixture store, recorded as Studio records a real
 * `genex shop add --json` result. A second game, Claude of Duty, is not on Genex yet: its chat holds
 * the local draft Ice Shield (`.genex/items/` in its folder, recorded as Studio records a local
 * `shop add`), whose card offers "Sell when published". Once its publish record names the account's
 * Claude of Duty, the fixture's own sync (`fixtureLocalRuns`) uploads it to the fixture store as
 * the CLI's `shop sync` would. Data only: nothing reaches genex.games or runs the CLI.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import { type ListingDraft, LOCAL_DRAFT_STATE, type LocalListingDraft } from "../../shared/item-draft.ts";
import { isItemId, ItemState, ItemType, storeRefusalOf } from "../../shared/store-items.ts";
import type { LocalDraftChange } from "../core/genex-cli.ts";
import type { SyncedItem } from "../core/item-draft.ts";
import { LOCAL_ITEMS_DIR, localDraftFingerprint, removeSyncedDrafts } from "../core/local-item-files.ts";
import { type GalleryRequest, isRecord, PlayRoute } from "../play/gallery.ts";
import type { StudioCore } from "../studio-core.ts";
import { fixturePlayRequest } from "./fixture-play.ts";
import { FixtureStoreItem } from "./fixture-store.ts";

/** The account's game on Genex the fixture game stands for. */
export const FIXTURE_ITEMS_GAME = "snowball";

/** What the person asked, and what the agent answered (screen 09). */
const ASK =
  "Add a Frost Axe to the store for 1,200 coin. Ice-blue head, freezes an enemy for a second on hit. Other games can use it too.";
const REPLY = "Done. The axe is in your store and freezes on hit. Try it in the preview, then put it on sale.";

/** The Frost Axe as the fixture store holds it: the account's draft, shared, with no picture Studio loads. */
const frostAxe = (project: string): ListingDraft => ({
  project,
  itemId: FixtureStoreItem.FrostAxe,
  name: "Frost Axe",
  description: "Ice-blue head. Freezes an enemy for a second on hit.",
  type: ItemType.Durable,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  iconUrl: null,
  state: ItemState.Draft,
  shareable: true,
});

/** A game's Genex project id in the fixture catalog. */
export async function fixtureGameId(slug: string): Promise<string> {
  const answer = await fixturePlayRequest(PlayRoute.world(slug), { method: "GET" });
  const game = isRecord(answer.body) ? answer.body.item : null;
  if (!isRecord(game) || typeof game.id !== "string") throw new Error(`the fixture catalog has no ${slug}`);
  return game.id;
}

/** The local game whose chat holds a local draft: the account's Claude of Duty, before it is on Genex. */
export const FIXTURE_LOCAL_GAME = "fixture-duty";
/** The Genex game it becomes once published. */
export const FIXTURE_LOCAL_SLUG = "claude-of-duty";
/** Its local draft's id, as the CLI makes one. */
const ICE_SHIELD_ID = "local_1ce5d1e1d0aa";

/** What the person asked in that game, and what the agent answered. */
const LOCAL_ASK = "Make an Ice Shield for the store, 300 coin. It blocks one hit.";
const LOCAL_REPLY = "Done. Ice Shield waits as a draft until the game is published. Say if it should go on sale then.";

/** The CLI's hash of a draft's fields and picture, as the contract computes it. */
function contentHashOf(draft: Omit<LocalListingDraft, "contentHash" | "project" | "state">, picture: Buffer): string {
  const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const { description, name, priceCoins, shareable, tags, type } = draft;
  const canonical = JSON.stringify({ description, name, priceCoins, shareable, tags, type });
  return sha(`${canonical}\nimage:${sha(picture)}`);
}

/** Ice Shield's files in the game's `.genex/items/`, as the CLI writes a local draft, and its draft. */
async function writeIceShield(game: string, project: string): Promise<LocalListingDraft> {
  const fields = {
    localId: ICE_SHIELD_ID,
    name: "Ice Shield",
    description: "Blocks one hit.",
    priceCoins: 300,
    type: ItemType.Durable,
    tags: ["shield", "ice"],
    shareable: true,
  };
  const picture = Buffer.from("fixture picture of an ice shield");
  const items = path.join(game, ...LOCAL_ITEMS_DIR);
  await mkdir(path.join(items, ICE_SHIELD_ID), { recursive: true });
  await writeFile(path.join(items, ICE_SHIELD_ID, "picture.png"), picture);
  const at = "2026-10-23T09:00:00.000Z";
  const record = { ...fields, files: { image: "picture.png" }, createdAt: at, updatedAt: at };
  await writeFile(path.join(items, `${ICE_SHIELD_ID}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { project, state: LOCAL_DRAFT_STATE, ...fields, contentHash: contentHashOf(fields, picture) };
}

/** Claude of Duty, not on Genex yet, its local draft and its chat's ask, reply and card. */
async function seedLocalDraft(core: StudioCore): Promise<void> {
  const duty = await core.games.scaffold(FIXTURE_LOCAL_GAME, { title: "Claude of Duty" });
  const threadId = await core.threadForGame(duty.name);
  const game = await realpath(duty.dir);
  const draft = await writeIceShield(game, duty.name);
  await core.localItems.noteDraft(
    draft,
    await localDraftFingerprint(path.join(game, ...LOCAL_ITEMS_DIR), draft.localId),
  );
  await core.append(
    [
      { type: EventKind.Messages, messages: [{ role: "user", content: LOCAL_ASK }] },
      { type: EventKind.Messages, messages: [{ role: "assistant", content: LOCAL_REPLY }] },
      customEventData(CustomEvent.ItemDrafted, { ...draft }),
    ],
    threadId,
  );
}

/** What the fixture's local-draft runs answer from: the launch's fixture store, as the app's account, and the core. */
export interface FixtureLocalDeps {
  request: GalleryRequest;
  token(): Promise<string | undefined>;
  core(): StudioCore;
}

/** A game's hosted project id as its Genex publish record names it, or null. */
async function hostedIdOf(core: StudioCore, project: string): Promise<string | null> {
  const file = path.join(core.pluginServices.root(GENEX_PLUGIN_ID), "publish", project, ".genex", "project.json");
  const meta: unknown = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
  return isRecord(meta) && typeof meta.id === "string" && meta.id !== "" ? meta.id : null;
}

/** One local draft uploaded to the fixture store, as the CLI's `shop sync` uploads it. */
async function uploadDraft(deps: FixtureLocalDeps, hostedId: string, draft: LocalListingDraft): Promise<SyncedItem> {
  const token = await deps.token();
  const { name, description, priceCoins, type, tags, shareable, localId, contentHash } = draft;
  const answer = await deps.request(`/api/coin/projects/${encodeURIComponent(hostedId)}/skus`, {
    method: "POST",
    body: { name, description, priceCoins, type, tags, shareable },
    ...(token ? { token } : {}),
  });
  const body = isRecord(answer.body) ? answer.body : {};
  if (answer.status === 200 && isItemId(body.id))
    return { localId, contentHash, skuId: body.id, refusal: null, field: null };
  return { localId, contentHash, skuId: null, refusal: storeRefusalOf(body.error), field: null };
}

/**
 * The fixture's `shop sync` and the person's sharing of a local draft, in place of the CLI's: a
 * draft the game holds is uploaded to the fixture store and leaves the game; sharing changes the
 * draft as Studio records it, with a new hash, and leaves the game's files as they are.
 */
export function fixtureLocalRuns(deps: FixtureLocalDeps): {
  sync(project: string): Promise<SyncedItem[] | null>;
  setShared(project: string, localId: string, shared: boolean): Promise<LocalDraftChange | null>;
} {
  const itemsOf = async (project: string) =>
    path.join(await realpath(deps.core().games.dirFor(project)), ...LOCAL_ITEMS_DIR);
  return {
    sync: async (project) => {
      const core = deps.core();
      const hostedId = await hostedIdOf(core, project);
      if (!hostedId) return null;
      const items = await itemsOf(project);
      const staged = new Map<string, string>();
      const synced: SyncedItem[] = [];
      for (const draft of Object.values((await core.localItems.view(project)).drafts)) {
        const print = await localDraftFingerprint(items, draft.localId);
        if (!print) continue;
        const one = await uploadDraft(deps, hostedId, draft);
        if (one.skuId) staged.set(draft.localId, print);
        synced.push(one);
      }
      await removeSyncedDrafts(path.dirname(path.dirname(items)), [...staged.keys()], staged);
      return synced;
    },
    setShared: async (project, localId, shared) => {
      const draft = (await deps.core().localItems.view(project)).drafts[localId];
      if (!draft) return null;
      const contentHash = createHash("sha256").update(`${draft.contentHash}:${shared}`).digest("hex");
      // The fixture leaves the game's files as they are: what the run took is what the game holds.
      const fingerprint = await localDraftFingerprint(await itemsOf(project), localId);
      return { draft: { ...draft, shareable: shared, contentHash }, fingerprint, staged: fingerprint };
    },
  };
}

/** The fixture game made Snowball on Genex, and its chat's ask, reply and Listing draft card. */
export async function seedItemsStore(core: StudioCore, project: string, threadId: string): Promise<void> {
  const record = path.join(core.pluginServices.root(GENEX_PLUGIN_ID), "publish", project, ".genex");
  await mkdir(record, { recursive: true, mode: 0o700 });
  const hosted = { id: await fixtureGameId(FIXTURE_ITEMS_GAME), slug: FIXTURE_ITEMS_GAME, status: "published" };
  await writeFile(path.join(record, "project.json"), `${JSON.stringify(hosted)}\n`);
  await core.append(
    [
      { type: EventKind.Messages, messages: [{ role: "user", content: ASK }] },
      { type: EventKind.Messages, messages: [{ role: "assistant", content: REPLY }] },
      customEventData(CustomEvent.ItemDrafted, { ...frostAxe(project) }),
    ],
    threadId,
  );
  await seedLocalDraft(core);
}
