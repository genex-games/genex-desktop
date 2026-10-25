/**
 * Local item drafts after the game is published (contract "Local item drafts"; D40). The person's
 * "Sell when published" is an approval Studio keeps in its own app data, never in the game folder,
 * keyed by game and local id and holding the content hash the person saw. Once the game is on Genex,
 * Studio runs its own `shop sync` (paced, at most one per game at a time) and puts on sale only an
 * uploaded draft whose approval names the very hash the sync reports; a draft changed since its
 * approval stays a draft and says so, a refusal is kept with its code, and nothing the agent can
 * write (the game's files, a sync record in the game) approves anything.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  approve,
  emptyApprovals,
  ITEM_APPROVALS_FILE,
  ItemApprovals,
  localItemsView,
  noteDraft,
  readApprovals,
  withdraw,
} from "../../src/main/core/item-approvals.ts";
import type { SyncedItem } from "../../src/main/core/item-draft.ts";
import type { LocalDraftChange } from "../../src/main/core/genex-cli.ts";
import { LOCAL_SETTLE_GAP_MS, LocalItems, type LocalItemsDeps } from "../../src/main/core/local-items.ts";
import { type LocalListingDraft, LocalOutcomeKind } from "../../src/shared/item-draft.ts";
import {
  type CreatorItem,
  ItemState,
  ItemType,
  type StoreRefused,
  StoreRefusal,
} from "../../src/shared/store-items.ts";
import { isHostOnlyUiEvent, UiEvent } from "../../src/shared/ui-events.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "space-race";
const ICE = "local_ab12cd34ef56";
const SLED = "local_0123456789ab";
const CAPE = "local_cccccccccccc";
const AXE = "local_dddddddddddd";
const HASH = "3f9a".repeat(16);
const OTHER_HASH = "b".repeat(64);
const PRINT = "c".repeat(64);
const T0 = Date.UTC(2026, 9, 23, 12, 0);

const draft = (localId: string, fields: Partial<LocalListingDraft> = {}): LocalListingDraft => ({
  project: GAME,
  state: "local",
  localId,
  name: "Ice Shield",
  description: null,
  type: ItemType.Durable,
  priceCoins: 300,
  tags: [],
  shareable: false,
  contentHash: HASH,
  ...fields,
});

const onSale = (id: string): CreatorItem => ({
  id,
  projectId: "proj_1",
  type: ItemType.Durable,
  name: "Ice Shield",
  description: null,
  tags: [],
  iconUrl: null,
  modelUrl: null,
  priceCoins: 300,
  priceDisplayUsdCents: 300,
  state: ItemState.OnSale,
  shareable: false,
  publishedAt: T0,
  takenDownAt: null,
});

const uploaded = (localId: string, skuId: string, contentHash = HASH): SyncedItem => ({
  localId,
  contentHash,
  skuId,
  refusal: null,
  field: null,
});

/** A Studio with its app data, a game folder beside it, and recorders for every outside call. */
async function rig(options: { published?: boolean; drafts?: boolean; synced?: SyncedItem[] | null } = {}) {
  const root = await realpath(await tmpDir("local-items-"));
  const userData = path.join(root, "userData");
  const game = path.join(root, "AI Games", GAME);
  await mkdir(userData, { recursive: true });
  await mkdir(path.join(game, ".genex", "items"), { recursive: true });
  let clock = T0;
  const calls = { sync: 0, putOnSale: [] as string[], changed: [] as string[], share: [] as boolean[] };
  const sale: Record<string, CreatorItem | StoreRefused> = {};
  let synced = options.synced === undefined ? [] : options.synced;
  let unreadable = false;
  let shareAnswer: LocalDraftChange | null = null;
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;
  const deps: LocalItemsDeps = {
    approvals: new ItemApprovals(path.join(userData, ITEM_APPROVALS_FILE)),
    published: async () => options.published ?? true,
    hasDrafts: async () => {
      if (unreadable) throw new Error("EACCES");
      return options.drafts ?? true;
    },
    sync: async () => {
      calls.sync += 1;
      if (held) await held;
      return synced;
    },
    setShared: async (_project, _localId, shared) => {
      calls.share.push(shared);
      return shareAnswer;
    },
    putOnSale: async (skuId) => {
      calls.putOnSale.push(skuId);
      return sale[skuId] ?? onSale(skuId);
    },
    now: () => clock,
    changed: (project) => calls.changed.push(project),
  };
  return {
    root,
    userData,
    game,
    calls,
    sale,
    items: new LocalItems(deps),
    tick: (ms: number) => {
      clock += ms;
    },
    failDrafts: () => {
      unreadable = true;
    },
    answerSync: (answer: SyncedItem[] | null) => {
      synced = answer;
    },
    answerShare: (answer: LocalDraftChange | null) => {
      shareAnswer = answer;
    },
    holdSync: () => {
      held = new Promise((resolve) => {
        release = resolve;
      });
    },
    releaseSync: () => release?.(),
  };
}

describe("the person's approvals, as Studio keeps them", () => {
  it("records the hash approved and when, and forgets it on undo", () => {
    const approved = approve(noteDraft(emptyApprovals(), draft(ICE), PRINT), GAME, ICE, HASH, T0);
    assert.deepEqual(localItemsView(approved, GAME).approvals, { [ICE]: { contentHash: HASH, at: T0 } });
    assert.deepEqual(localItemsView(withdraw(approved, GAME, ICE), GAME).approvals, {});
  });

  it("refuses an approval for anything but a local id and a content hash", () => {
    const known = noteDraft(emptyApprovals(), draft(ICE), PRINT);
    for (const [localId, hash] of [
      ["../x", HASH],
      ["sku_frost", HASH],
      [ICE, "nothex"],
      [ICE, HASH.toUpperCase()],
    ] as const)
      assert.deepEqual(localItemsView(approve(known, GAME, localId, hash, T0), GAME).approvals, {});
  });

  it("approves only a hash Studio saw the CLI print for that draft", () => {
    assert.deepEqual(
      localItemsView(approve(emptyApprovals(), GAME, ICE, HASH, T0), GAME).approvals,
      {},
      "no draft seen",
    );
    const known = noteDraft(emptyApprovals(), draft(ICE), PRINT);
    assert.deepEqual(localItemsView(approve(known, GAME, ICE, OTHER_HASH, T0), GAME).approvals, {}, "another hash");
  });

  const hostileFiles: Array<[string, unknown]> = [
    ["not an object", [1, 2]],
    ["another version", { version: 2, games: { [GAME]: { approvals: { [ICE]: { contentHash: HASH, at: T0 } } } } }],
    ["games that are not an object", { version: 1, games: "x" }],
  ];
  for (const [name, raw] of hostileFiles)
    it(`reads a file that is ${name} as holding nothing`, () => {
      assert.deepEqual(localItemsView(readApprovals(raw), GAME).approvals, {});
    });

  it("reads an outcome whose content hash does not read as naming no content", () => {
    const outcome = (contentHash: unknown) => ({
      version: 1,
      games: {
        [GAME]: { outcomes: { [ICE]: { kind: LocalOutcomeKind.Draft, skuId: "sku_ice", contentHash, at: T0 } } },
      },
    });
    assert.equal(localItemsView(readApprovals(outcome(HASH)), GAME).outcomes[ICE]?.contentHash, HASH);
    for (const bad of [undefined, null, "nothex", HASH.toUpperCase(), 42, [HASH]])
      assert.equal(localItemsView(readApprovals(outcome(bad)), GAME).outcomes[ICE]?.contentHash, null, String(bad));
  });

  it("keeps only the entries that read from a file holding bad ones", () => {
    const raw = {
      version: 1,
      games: {
        [GAME]: {
          approvals: {
            [ICE]: { contentHash: HASH, at: T0 },
            "../escape": { contentHash: HASH, at: T0 },
            [SLED]: { contentHash: "x", at: T0 },
            [CAPE]: { contentHash: HASH, at: "yesterday" },
          },
        },
        "../other": { approvals: { [ICE]: { contentHash: HASH, at: T0 } } },
      },
    };
    const doc = readApprovals(raw);
    assert.deepEqual(localItemsView(doc, GAME).approvals, { [ICE]: { contentHash: HASH, at: T0 } });
    assert.deepEqual(localItemsView(doc, "../other").approvals, {});
  });

  it("lives in Studio's app data, and approving writes nothing to the game", async () => {
    const r = await rig();
    await r.items.noteDraft(draft(ICE), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    assert.deepEqual(await readdir(r.userData), [ITEM_APPROVALS_FILE]);
    assert.deepEqual(await readdir(path.join(r.game, ".genex", "items")), []);
    const saved = JSON.parse(await readFile(path.join(r.userData, ITEM_APPROVALS_FILE), "utf8"));
    assert.equal(saved.games[GAME].approvals[ICE].contentHash, HASH);
    assert.deepEqual(r.calls.changed, [GAME, GAME]);
  });

  it("reads a file it cannot parse as holding nothing, and a link in its place is never followed", async () => {
    const r = await rig();
    const secret = path.join(r.root, "secret.json");
    await writeFile(
      secret,
      JSON.stringify({ version: 1, games: { [GAME]: { approvals: { [ICE]: { contentHash: HASH, at: T0 } } } } }),
    );
    await symlink(secret, path.join(r.userData, ITEM_APPROVALS_FILE));
    assert.deepEqual((await r.items.view(GAME)).approvals, {});
    await r.items.noteDraft(draft(SLED), PRINT);
    assert.match(await readFile(secret, "utf8"), new RegExp(ICE), "the link's target is untouched");
  });
});

describe("settling a game's local drafts after its publish", () => {
  it("puts on sale only what the person approved with the very hash uploaded, and keeps the rest a draft", async () => {
    const r = await rig({
      synced: [
        uploaded(ICE, "sku_ice"),
        uploaded(SLED, "sku_sled", OTHER_HASH),
        uploaded(CAPE, "sku_cape"),
        { localId: AXE, contentHash: HASH, skuId: null, refusal: StoreRefusal.PriceOffGrid, field: "price" },
      ],
    });
    for (const localId of [ICE, SLED, AXE]) {
      await r.items.noteDraft(draft(localId), PRINT);
      await r.items.approve(GAME, localId, HASH);
    }
    const view = await r.items.settle(GAME, { force: false });
    assert.deepEqual(r.calls.putOnSale, ["sku_ice"]);
    assert.deepEqual(view.outcomes[ICE], {
      kind: LocalOutcomeKind.OnSale,
      skuId: "sku_ice",
      contentHash: HASH,
      refusal: null,
      field: null,
      at: T0,
    });
    assert.equal(view.outcomes[SLED]?.kind, LocalOutcomeKind.Changed, "changed since its approval: a draft");
    assert.equal(view.outcomes[SLED]?.skuId, "sku_sled");
    assert.equal(view.outcomes[CAPE]?.kind, LocalOutcomeKind.Draft, "never approved: a draft");
    assert.deepEqual(view.outcomes[AXE], {
      kind: LocalOutcomeKind.Refused,
      skuId: null,
      contentHash: HASH,
      refusal: StoreRefusal.PriceOffGrid,
      field: "price",
      at: T0,
    });
    assert.deepEqual(Object.keys(view.approvals), [AXE], "an approval is used once; a refused upload keeps its own");
    assert.equal(view.drafts[ICE]?.name, "Ice Shield", "an uploaded draft's card still shows what it was");
  });

  it("records the content Genex got, which an edit outside Studio makes differ from the card's", async () => {
    const r = await rig({ synced: [uploaded(ICE, "sku_ice", OTHER_HASH), uploaded(SLED, "sku_sled")] });
    for (const localId of [ICE, SLED]) await r.items.noteDraft(draft(localId), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    const view = await r.items.settle(GAME, { force: true });
    assert.deepEqual(r.calls.putOnSale, [], "the approved content is not what went up");
    assert.equal(view.outcomes[ICE]?.kind, LocalOutcomeKind.Changed);
    assert.equal(view.outcomes[ICE]?.contentHash, OTHER_HASH, "what Genex got, not what the card shows");
    assert.equal(view.drafts[ICE]?.contentHash, HASH);
    assert.equal(view.outcomes[SLED]?.contentHash, HASH, "an unapproved draft uploaded as the card shows it");
  });

  it("says why genex.games refused Put on sale, and the item stays a draft there", async () => {
    const r = await rig({ synced: [uploaded(ICE, "sku_ice")] });
    r.sale.sku_ice = { refused: StoreRefusal.PictureMissing };
    await r.items.noteDraft(draft(ICE), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    const view = await r.items.settle(GAME, { force: false });
    assert.deepEqual(view.outcomes[ICE], {
      kind: LocalOutcomeKind.Refused,
      skuId: "sku_ice",
      contentHash: HASH,
      refusal: StoreRefusal.PictureMissing,
      field: null,
      at: T0,
    });
  });

  it("does nothing for a game that is not published on Genex, or holds no drafts", async () => {
    for (const options of [{ published: false }, { drafts: false }]) {
      const r = await rig({ ...options, synced: [uploaded(ICE, "sku_ice")] });
      await r.items.noteDraft(draft(ICE), PRINT);
      await r.items.approve(GAME, ICE, HASH);
      await r.items.settle(GAME, { force: true });
      assert.equal(r.calls.sync, 0);
      assert.deepEqual(r.calls.putOnSale, []);
    }
  });

  it("is paced: once per gap unless the publish just finished, and one at a time", async () => {
    const r = await rig({ synced: [] });
    await r.items.settle(GAME, { force: false });
    await r.items.settle(GAME, { force: false });
    assert.equal(r.calls.sync, 1, "a focus right after waits for the gap");
    r.tick(LOCAL_SETTLE_GAP_MS);
    await r.items.settle(GAME, { force: false });
    assert.equal(r.calls.sync, 2);
    await r.items.settle(GAME, { force: true });
    assert.equal(r.calls.sync, 3, "a finished publish settles at once");
    r.holdSync();
    const first = r.items.settle(GAME, { force: true });
    const second = r.items.settle(GAME, { force: true });
    r.releaseSync();
    await Promise.all([first, second]);
    assert.equal(r.calls.sync, 4, "two at once share one sync");
  });

  it("keeps the outcome of an earlier settle when a later one uploads nothing", async () => {
    const r = await rig({ synced: [uploaded(ICE, "sku_ice")] });
    await r.items.noteDraft(draft(ICE), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    await r.items.settle(GAME, { force: true });
    r.answerSync(null);
    await r.items.settle(GAME, { force: true });
    assert.equal(r.calls.sync, 2);
    assert.equal((await r.items.view(GAME)).outcomes[ICE]?.kind, LocalOutcomeKind.OnSale);
    assert.deepEqual(r.calls.putOnSale, ["sku_ice"], "and never puts it on sale twice");
  });
});

describe("nothing the agent can write approves a local draft (D40)", () => {
  it("never reads an approval or a sync record from the game folder", async () => {
    const r = await rig({ synced: [] });
    const items = path.join(r.game, ".genex", "items");
    const forged = { version: 1, games: { [GAME]: { approvals: { [ICE]: { contentHash: HASH, at: T0 } } } } };
    await writeFile(path.join(items, ITEM_APPROVALS_FILE), JSON.stringify(forged));
    await writeFile(path.join(r.game, ITEM_APPROVALS_FILE), JSON.stringify(forged));
    const lastSync = {
      kind: "genex.item_sync",
      version: 1,
      items: [{ localId: ICE, contentHash: HASH, skuId: "sku_other" }],
    };
    await writeFile(path.join(items, "last-sync.json"), JSON.stringify(lastSync));
    const view = await r.items.settle(GAME, { force: true });
    assert.deepEqual(view.approvals, {});
    assert.deepEqual(r.calls.putOnSale, [], "only Studio's own sync names what goes on sale");
  });

  it("keeps the record of local drafts from the harness's notifications", () => {
    assert.equal(isHostOnlyUiEvent(UiEvent.ItemsLocal), true);
  });

  it("settles a game whose folder cannot be read as holding nothing", async () => {
    const r = await rig({ synced: [uploaded(ICE, "sku_ice")] });
    r.failDrafts();
    const view = await r.items.settle(GAME, { force: true });
    assert.deepEqual(view.outcomes, {});
    assert.equal(r.calls.sync, 0);
  });

  it("puts nothing on sale for an approval of content the agent changed after the person saw it", async () => {
    const r = await rig({ synced: [uploaded(ICE, "sku_ice", OTHER_HASH)] });
    await r.items.noteDraft(draft(ICE), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    await r.items.settle(GAME, { force: true });
    assert.deepEqual(r.calls.putOnSale, []);
  });
});

describe("the person's Other games can use it on a local draft", () => {
  it("keeps their approval, under the new hash, when the game holds what they approved", async () => {
    const r = await rig();
    await r.items.noteDraft(draft(ICE), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    r.answerShare({
      draft: draft(ICE, { shareable: true, contentHash: OTHER_HASH }),
      fingerprint: "e".repeat(64),
      staged: PRINT,
    });
    const answer = await r.items.share(GAME, ICE, HASH, true);
    assert.deepEqual(answer, { draft: draft(ICE, { shareable: true, contentHash: OTHER_HASH }) });
    const view = await r.items.view(GAME);
    assert.equal(view.approvals[ICE]?.contentHash, OTHER_HASH);
    assert.equal(view.drafts[ICE]?.shareable, true, "the card shows the draft after the press");
    assert.deepEqual(r.calls.share, [true]);
  });

  it("does not carry an approval over a change the agent made to the game's files, before or during the press", async () => {
    const r = await rig();
    await r.items.noteDraft(draft(ICE), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    // The agent changed the game's files after the person approved, up to the moment the run copied
    // them: the CLI changed those bytes, not the ones approved.
    r.answerShare({
      draft: draft(ICE, { shareable: true, contentHash: OTHER_HASH }),
      fingerprint: "e".repeat(64),
      staged: "f".repeat(64),
    });
    await r.items.share(GAME, ICE, HASH, true);
    const view = await r.items.view(GAME);
    assert.equal(view.approvals[ICE]?.contentHash, HASH, "it stays on what the person saw");
    assert.equal(view.drafts[ICE]?.contentHash, OTHER_HASH, "the card shows the draft after the press");
  });

  it("does not carry an approval the card no longer shows", async () => {
    const r = await rig();
    await r.items.noteDraft(draft(ICE), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    await r.items.noteDraft(draft(ICE, { contentHash: OTHER_HASH }), PRINT);
    r.answerShare({
      draft: draft(ICE, { shareable: true, contentHash: "9".repeat(64) }),
      fingerprint: PRINT,
      staged: PRINT,
    });
    await r.items.share(GAME, ICE, OTHER_HASH, true);
    assert.equal((await r.items.view(GAME)).approvals[ICE]?.contentHash, HASH);
  });

  it("answers a failure when the CLI changed nothing", async () => {
    const r = await rig();
    r.answerShare(null);
    assert.deepEqual(await r.items.share(GAME, ICE, HASH, true), { failed: true });
  });
});

describe("a local draft the agent removed", () => {
  it("loses its approval and its draft", async () => {
    const r = await rig();
    await r.items.noteDraft(draft(ICE), PRINT);
    await r.items.approve(GAME, ICE, HASH);
    await r.items.forget(GAME, [ICE]);
    const view = await r.items.view(GAME);
    assert.deepEqual(view.approvals, {});
    assert.deepEqual(view.drafts, {});
    assert.deepEqual(view.removed, [ICE]);
  });
});
