/**
 * The store's IPC (marketplace plan 10.2): every Store and Create › Items call the renderer makes is
 * one named channel, registered through the real typed `handle()`, classified fixture-safe (a
 * fixture launch answers it from `dev/fixture-store.ts`, so no socket opens), and checked at the
 * boundary: a malformed payload is refused before the store client or the sheet hears of it. The
 * preload sends each call in the shape main reads, and the sheet main pushes reaches `onStoreSheet`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChannelClass, classifyChannel } from "../../src/main/dev/native-policy.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerStoreIpc, type StoreIpcDeps } from "../../src/main/ipc/store.ts";
import { type BridgeIpc, createStudioBridge } from "../../src/preload/studio-bridge.ts";
import { STUDIO_INVOKE_CHANNELS, STUDIO_PUSH_CHANNELS } from "../../src/shared/ipc-channels.ts";
import { PurchaseAnswer, PurchaseStep } from "../../src/shared/play-purchase.ts";
import { ItemReportReason, StoreBuyOutcome, StoreRefusal, type StoreSheet } from "../../src/shared/store-items.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
const STUDIO: IpcSender = { sender: "studio", senderFrame: "studio-main-frame" };

const LOCAL_ID = "local_ab12cd34ef56";
const HASH = "3f9a".repeat(16);
const LOCAL_VIEW = { project: "space-race", approvals: {}, drafts: {}, removed: [], outcomes: {} };

/** Every store channel of the map. */
const STORE_CHANNELS = Object.keys(STUDIO_INVOKE_CHANNELS).filter(
  (channel) => channel.startsWith("studio:store.") || channel.startsWith("studio:items."),
);

/** The store's registrar over recorders, in a fixture profile: `calls` holds what reached the client or the sheet. */
function rig() {
  const listeners = new Map<string, Listener>();
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    <T>(name: string, answer: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push([name, ...args]);
      return answer;
    };
  const REFUSED = { refused: StoreRefusal.Unknown };
  const deps: StoreIpcDeps = {
    store: {
      items: record("items", { items: [], myItemsCount: null }),
      myItems: record("myItems", []),
      itemGames: record("itemGames", { total: 0, games: [] }),
      claim: record("claim", REFUSED),
      shelf: record("shelf", []),
      report: record("report", true as const),
      browse: record("browse", REFUSED),
      browseDetail: record("browseDetail", REFUSED),
      addToGame: record("addToGame", REFUSED),
      removeFromGame: record("removeFromGame", REFUSED),
      selling: record("selling", REFUSED),
      putOnSale: record("putOnSale", REFUSED),
      takeOffSale: record("takeOffSale", REFUSED),
      setShared: record("setShared", REFUSED),
    },
    sheet: {
      buy: record("buy", { outcome: StoreBuyOutcome.Paid }),
      answer: (value) => void calls.push(["answer", value]),
    },
    coin: {
      spendable: record("coins", 1240),
      getCoin: () => void calls.push(["getCoin"]),
    },
    local: {
      view: record("localView", LOCAL_VIEW),
      approve: record("localApprove", LOCAL_VIEW),
      withdraw: record("localWithdraw", LOCAL_VIEW),
      share: record("localShare", { failed: true as const }),
      settle: record("localSettle", LOCAL_VIEW),
    },
  };
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: true, isStudioUi: (event) => event === STUDIO },
  );
  registerStoreIpc(handle, deps);
  const invoke = async (channel: string, payload: unknown): Promise<IpcResult> => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener(STUDIO, payload);
  };
  return { invoke, calls, listeners };
}

describe("The store's channels", () => {
  it("registers every store channel of the map, each fixture-safe", () => {
    const { listeners } = rig();
    assert.ok(STORE_CHANNELS.length >= 16);
    assert.deepEqual([...listeners.keys()].sort(), [...STORE_CHANNELS].sort());
    for (const channel of STORE_CHANNELS) assert.equal(classifyChannel(channel), ChannelClass.FixtureSafe, channel);
  });

  it("hands each well-formed call to the store client or the sheet with exactly its arguments", async () => {
    const { invoke, calls } = rig();
    const answer = { sheet: 2, answer: PurchaseAnswer.Pay };
    const table: Array<[string, unknown, [string, ...unknown[]]]> = [
      ["studio:store.items", { slug: "stick-steel" }, ["items", "stick-steel"]],
      ["studio:store.my-items", { slug: "stick-steel" }, ["myItems", "stick-steel"]],
      ["studio:store.item-games", { itemId: "sku1" }, ["itemGames", "sku1"]],
      ["studio:store.buy", { itemId: "sku1", slug: "stick-steel" }, ["buy", "sku1", "stick-steel"]],
      ["studio:store.answer", answer, ["answer", answer]],
      ["studio:store.claim", { itemId: "sku6", slug: "stick-steel" }, ["claim", "sku6", "stick-steel"]],
      ["studio:store.shelf", { userId: "user1" }, ["shelf", "user1"]],
      ["studio:store.coins", undefined, ["coins"]],
      ["studio:store.get-coin", undefined, ["getCoin"]],
      [
        "studio:store.report",
        { itemId: "sku1", reason: ItemReportReason.Copy, message: "Mine." },
        ["report", "sku1", ItemReportReason.Copy, "Mine."],
      ],
      [
        "studio:items.browse",
        { query: "wings", cursor: null, tags: ["fire"] },
        ["browse", { query: "wings", cursor: null, tags: ["fire"] }],
      ],
      ["studio:items.detail", { itemId: "sku5" }, ["browseDetail", "sku5"]],
      ["studio:items.add", { itemId: "sku5", projectId: "proj1" }, ["addToGame", "sku5", "proj1"]],
      ["studio:items.remove", { itemId: "sku5", projectId: "proj1" }, ["removeFromGame", "sku5", "proj1"]],
      ["studio:items.selling", undefined, ["selling"]],
      ["studio:items.put-on-sale", { itemId: "sku9" }, ["putOnSale", "sku9"]],
      ["studio:items.take-off-sale", { itemId: "sku9" }, ["takeOffSale", "sku9"]],
      ["studio:items.shared", { itemId: "sku9", shared: true }, ["setShared", "sku9", true]],
      ["studio:items.local", { project: "space-race" }, ["localView", "space-race"]],
      [
        "studio:items.local-approve",
        { project: "space-race", localId: LOCAL_ID, contentHash: HASH },
        ["localApprove", "space-race", LOCAL_ID, HASH],
      ],
      [
        "studio:items.local-withdraw",
        { project: "space-race", localId: LOCAL_ID },
        ["localWithdraw", "space-race", LOCAL_ID],
      ],
      [
        "studio:items.local-share",
        { project: "space-race", localId: LOCAL_ID, contentHash: HASH, shared: true },
        ["localShare", "space-race", LOCAL_ID, HASH, true],
      ],
      [
        "studio:items.local-settle",
        { project: "space-race", force: true },
        ["localSettle", "space-race", { force: true }],
      ],
    ];
    for (const [channel, payload, expected] of table) {
      calls.length = 0;
      const result = await invoke(channel, payload);
      assert.equal(result.ok, true, `${channel}: ${JSON.stringify(result)}`);
      assert.deepEqual(calls, [expected], channel);
    }
    assert.deepEqual(
      new Set(table.map(([channel]) => channel)),
      new Set(STORE_CHANNELS),
      "the table covers every channel",
    );
  });
});

describe("The store's channels, given what no Studio page would send", () => {
  it("refuses every malformed payload before the store client or the sheet hears of it", async () => {
    const { invoke, calls } = rig();
    const hostile: Array<[string, unknown]> = [
      ["studio:store.items", undefined],
      ["studio:store.items", { slug: "../admin" }],
      ["studio:store.items", { slug: 5 }],
      ["studio:store.my-items", { slug: "Stick Steel" }],
      ["studio:store.item-games", { itemId: "../x" }],
      ["studio:store.item-games", { itemId: "a/b" }],
      ["studio:store.item-games", { itemId: "x".repeat(65) }],
      ["studio:store.buy", { itemId: "sku1" }],
      ["studio:store.buy", { itemId: "sku 1", slug: "stick-steel" }],
      ["studio:store.answer", { sheet: "1", answer: PurchaseAnswer.Pay }],
      ["studio:store.answer", { sheet: 1, answer: "pay-now" }],
      ["studio:store.answer", null],
      ["studio:store.claim", { itemId: "sku6", slug: "" }],
      ["studio:store.shelf", { userId: "../me" }],
      ["studio:store.shelf", { userId: 1 }],
      ["studio:store.report", { itemId: "sku1", reason: "spam", message: null }],
      ["studio:store.report", { itemId: "sku1", reason: ItemReportReason.Copy, message: "m".repeat(501) }],
      ["studio:store.report", { itemId: "sku1", reason: ItemReportReason.Copy, message: 5 }],
      ["studio:items.browse", { query: 5, cursor: null, tags: [] }],
      ["studio:items.browse", { query: "", cursor: "../next", tags: [] }],
      ["studio:items.browse", { query: "", cursor: null, tags: "sword" }],
      ["studio:items.browse", { query: "", cursor: null, tags: [1] }],
      ["studio:items.browse", { query: "", cursor: null, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
      ["studio:items.detail", { itemId: null }],
      ["studio:items.add", { itemId: "sku5", projectId: "../proj" }],
      ["studio:items.add", { itemId: "sku 5", projectId: "proj1" }],
      ["studio:items.remove", { itemId: "sku5", projectId: "proj/1" }],
      ["studio:items.put-on-sale", { itemId: "" }],
      ["studio:items.take-off-sale", { itemId: "a/b" }],
      ["studio:items.shared", { itemId: "sku9", shared: "true" }],
      ["studio:items.shared", { itemId: "sku9" }],
      ["studio:items.local", { project: "../space-race" }],
      ["studio:items.local", { project: "Space Race" }],
      ["studio:items.local", { project: 5 }],
      ["studio:items.local", undefined],
      ["studio:items.local-approve", { project: "space-race", localId: "../local_ab12cd34ef56", contentHash: HASH }],
      ["studio:items.local-approve", { project: "space-race", localId: "sku9", contentHash: HASH }],
      ["studio:items.local-approve", { project: "space-race", localId: LOCAL_ID, contentHash: "nothex" }],
      ["studio:items.local-approve", { project: "space-race", localId: LOCAL_ID }],
      ["studio:items.local-approve", { project: "/tmp/space-race", localId: LOCAL_ID, contentHash: HASH }],
      ["studio:items.local-withdraw", { project: "space-race", localId: "local_AB12CD34EF56" }],
      ["studio:items.local-share", { project: "space-race", localId: LOCAL_ID, contentHash: HASH, shared: "yes" }],
      ["studio:items.local-share", { project: "space-race", localId: "--json", contentHash: HASH, shared: true }],
      ["studio:items.local-share", { project: "space-race", localId: LOCAL_ID, shared: true }],
      ["studio:items.local-settle", { project: "space-race", force: 1 }],
      ["studio:items.local-settle", { project: "space-race/../x", force: false }],
    ];
    for (const [channel, payload] of hostile) {
      const result = await invoke(channel, payload);
      assert.equal(result.ok, false, `${channel} took ${JSON.stringify(payload)}`);
    }
    assert.deepEqual(calls, []);
  });
});

describe("The store's preload calls", () => {
  /** A recorder standing in for `ipcRenderer`, with a way to push. */
  function rendererIpc() {
    const invokes: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, Set<(event: unknown, payload: never) => void>>();
    const ipc: BridgeIpc = {
      async invoke(channel, payload) {
        invokes.push({ channel, payload });
        return { ok: true, value: null };
      },
      on(channel, listener) {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener as (event: unknown, payload: never) => void);
        listeners.set(channel, set);
      },
      off(channel, listener) {
        listeners.get(channel)?.delete(listener as (event: unknown, payload: never) => void);
      },
    };
    const push = (channel: string, payload: unknown) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, payload as never);
    };
    return { ipc, invokes, push, count: (channel: string) => listeners.get(channel)?.size ?? 0 };
  }

  it("sends each payload in the shape main reads", async () => {
    const { ipc, invokes } = rendererIpc();
    const api = createStudioBridge(ipc);
    await api.storeItems("stick-steel");
    await api.storeBuy("sku1", "stick-steel");
    await api.storeAnswer(3, PurchaseAnswer.Pay);
    await api.storeReport("sku1", ItemReportReason.Scam, null);
    await api.storeCoins();
    await api.storeGetCoin();
    await api.itemsBrowse("wings", null);
    await api.itemsBrowse("", "c2", ["fire"]);
    await api.itemsSelling();
    await api.itemSetShared("sku9", false);
    await api.itemsLocalApprove("space-race", LOCAL_ID, HASH);
    await api.itemsLocalShare("space-race", LOCAL_ID, HASH, false);
    await api.itemsLocalSettle("space-race", true);
    assert.deepEqual(invokes, [
      { channel: "studio:store.items", payload: { slug: "stick-steel" } },
      { channel: "studio:store.buy", payload: { itemId: "sku1", slug: "stick-steel" } },
      { channel: "studio:store.answer", payload: { sheet: 3, answer: PurchaseAnswer.Pay } },
      { channel: "studio:store.report", payload: { itemId: "sku1", reason: ItemReportReason.Scam, message: null } },
      { channel: "studio:store.coins", payload: undefined },
      { channel: "studio:store.get-coin", payload: undefined },
      { channel: "studio:items.browse", payload: { query: "wings", cursor: null, tags: [] } },
      { channel: "studio:items.browse", payload: { query: "", cursor: "c2", tags: ["fire"] } },
      { channel: "studio:items.selling", payload: undefined },
      { channel: "studio:items.shared", payload: { itemId: "sku9", shared: false } },
      {
        channel: "studio:items.local-approve",
        payload: { project: "space-race", localId: LOCAL_ID, contentHash: HASH },
      },
      {
        channel: "studio:items.local-share",
        payload: { project: "space-race", localId: LOCAL_ID, contentHash: HASH, shared: false },
      },
      { channel: "studio:items.local-settle", payload: { project: "space-race", force: true } },
    ]);
  });

  it("delivers the sheet main pushes to onStoreSheet, and stops after unsubscribing", () => {
    const { ipc, push, count } = rendererIpc();
    const api = createStudioBridge(ipc);
    const heard: Array<StoreSheet | null> = [];
    const off = api.onStoreSheet((sheet) => heard.push(sheet));
    const sheet: StoreSheet = {
      sheet: 1,
      step: PurchaseStep.Ask,
      problem: null,
      recovery: null,
      armed: false,
      game: { title: "Stick & Steel", coverUrl: null },
      item: null,
      price: null,
      balance: null,
      itemId: "sku1",
      slug: "stick-steel",
    };
    const channel = Object.entries(STUDIO_PUSH_CHANNELS).find(([, method]) => method === "onStoreSheet")?.[0] ?? "";
    push(channel, sheet);
    push(channel, null);
    off();
    push(channel, sheet);
    assert.deepEqual(heard, [sheet, null]);
    assert.equal(count(channel), 0);
  });
});
