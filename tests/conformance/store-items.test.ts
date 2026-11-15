/**
 * What a build sells in its game's Genex store (loop/store-items.ts): the launch names each thing the
 * user prices in Nex, and every agent that reads the goal reads them as sold, never as cut. A fishing
 * game "with a fishing rod for nex" once launched with "Nex payments" in its cut list, and its
 * two-hour build never listed the rod. The store takes no item without its picture, so the build
 * lists each once it has drawn one: the launch lists nothing, and never stands as the only moment.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  DEFAULT_ITEM_PRICE,
  STORE_ITEMS_MAX,
  storeItemsOf,
  StoreItemType,
  storeLaunchWords,
  storeScopeItems,
} from "../../src/harness-seed/loop/store-items.ts";
import { launchFromIntake } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { argumentProblems } from "../../src/harness-seed/tools/index.ts";
import { startAutopilot } from "../../src/harness-seed/loop/start-autopilot.ts";

const ASK = "create fisher game with fishing rod for nex";
const ROD = {
  name: "Fishing Rod",
  price: 300,
  type: StoreItemType.Durable,
  description: "A carbon rod that casts twice as far.",
};

describe("a launch names what the user sells for Nex", () => {
  it("start_autopilot carries store_items onto its run, as a list or as JSON text", async () => {
    const ctx = { engine: "vendor" };
    for (const store_items of [[ROD], JSON.stringify([ROD])]) {
      const args = { goal: ASK, title: "Fisher", direction: "cozy lake", store_items };
      assert.deepEqual(argumentProblems(startAutopilot.parameters as never, args), [], "the launch is not refused");
      const result = (await startAutopilot.execute(args, ctx as never)) as {
        details?: { run?: Record<string, unknown> };
      };
      assert.deepEqual(result.details?.run?.storeItems, [ROD]);
    }
  });

  it("gives an item the user priced no price the store's first step, and keeps each name once", () => {
    assert.deepEqual(
      storeItemsOf([{ name: "Rod" }, { name: "rod", price: 800 }, { name: "Bait", price: "300" }, { price: 5 }, "Net"]),
      [
        { name: "Rod", price: DEFAULT_ITEM_PRICE, type: "durable" },
        { name: "Bait", price: 300, type: "durable" },
      ],
    );
    assert.deepEqual(
      storeItemsOf([
        { name: "Hat", price: -3 },
        { name: "Cap", price: 2.5 },
      ]),
      [
        { name: "Hat", price: DEFAULT_ITEM_PRICE, type: "durable" },
        { name: "Cap", price: DEFAULT_ITEM_PRICE, type: "durable" },
      ],
    );
    const many = Array.from({ length: STORE_ITEMS_MAX + 3 }, (_, i) => ({ name: `Skin ${i}`, price: 100 }));
    assert.equal(storeItemsOf(many).length, STORE_ITEMS_MAX);
    for (const nothing of [undefined, null, "", "not json", "{}", 7, {}]) assert.deepEqual(storeItemsOf(nothing), []);
  });

  it("keeps a thing bought once by default; only one named consumable is used up", () => {
    const named = [{ name: "Rogue" }, { name: "Potion", type: "consumable" }, { name: "Wings", type: "rig" }];
    assert.deepEqual(
      storeItemsOf(named).map((item) => item.type),
      ["durable", "consumable", "durable"],
    );
  });

  it("takes the store grid's price nearest the one the user named, never Free for a paid one", () => {
    const priced = (price: number) => storeItemsOf([{ name: "Thing", price }])[0]?.price;
    assert.deepEqual(
      [10, 50, 100, 250, 500, 1000, 3000, 999999, 0].map(priced),
      [100, 100, 100, 300, 800, 1200, 5000, 50000, 0],
    );
  });

  it("names nothing when the launch names no store items", async () => {
    const ctx = { engine: "vendor" };
    const result = (await startAutopilot.execute(
      { goal: "a game with an in-game shop", direction: "d" },
      ctx as never,
    )) as {
      details?: { run?: Record<string, unknown> };
    };
    assert.equal(result.details?.run?.storeItems, undefined);
  });
});

const ROD_LINE = "Fishing Rod for 300 Nex, durable: A carbon rod that casts twice as far.";

describe("the store items a run keeps", () => {
  it("keep in one line each what shop add needs to list the item", () => {
    assert.deepEqual(storeScopeItems([ROD, { name: "Golden Bait", price: 100, type: StoreItemType.Consumable }]), [
      ROD_LINE,
      "Golden Bait for 100 Nex, consumable",
    ]);
    const long = storeScopeItems([{ ...ROD, description: "a".repeat(1000) }])[0] ?? "";
    assert.ok(long.length < 300, "every agent reads a short line");
  });

  it("tell the user at the launch where each goes and that it can change at any time", () => {
    const words = storeLaunchWords([ROD, { name: "Golden Bait", price: 100, type: StoreItemType.Durable }]);
    assert.match(words, /Fishing Rod, Golden Bait.*Shop tab.*picture/);
    assert.match(words, /at any time/);
    assert.equal(storeLaunchWords([]), "");
  });
});

describe("a Loop launch with store items", () => {
  it("lists nothing itself, tells the user where each goes, and its run's goal carries them", async () => {
    const order: string[] = [];
    const said: string[] = [];
    // The run handleRunStart reserves, as the chat launched it.
    const reserved: Array<{ goal?: string }> = [];
    class Reservations extends Map<string, { run: { goal?: string } }> {
      override set(key: string, value: { run: { goal?: string } }) {
        reserved.push(value.run);
        return super.set(key, value);
      }
    }
    const host = {
      workspace: "/nowhere",
      notify: () => {},
      heartbeat: () => {},
      call: async (method: string, params: Record<string, unknown>) => {
        if (method === HostMethod.GameList) return [{ name: "fishing-rod" }];
        if (method === HostMethod.EngineDescribe) return [{ id: "codex", label: "Codex", supportsSessions: true }];
        if (method === HostMethod.GameValidate) return { contract: "loaded", problems: [] };
        if (method === HostMethod.PluginsInvoke) order.push("plugin");
        if (method === HostMethod.EventsAppend) {
          order.push("chat");
          said.push(JSON.stringify(params.batch));
        }
        return null;
      },
    };
    const ctx = { ...host, threadId: "t-1", cancelled: false, setStatus: () => {} };
    const studio = {
      host,
      cancels: new Set<string>(),
      activeRuns: new Map(),
      startingRuns: new Reservations(),
      orphanRuns: new Map(),
      scoped: () => ctx,
    };
    const spec = { goal: ASK, engine: "codex", storeItems: [ROD], reference: { name: "cozy lake", shots: [] } };
    await launchFromIntake(
      studio as never,
      ctx as never,
      { threadId: "t-1", project: "fishing-rod", text: ASK } as never,
      spec,
    );
    assert.equal(order.includes("plugin"), false, "no item is listed before its picture exists");
    assert.match(said[0] ?? "", /Fishing Rod will be on the Shop tab/);
    await setImmediate();
    // Flipped (phase 5): the run has no scope; its goal carries what it sells.
    assert.ok(reserved[0]?.goal?.includes(ROD_LINE), reserved[0]?.goal);
  });
});
