/**
 * Settings → Play-time AI (`main/game-ai/budgets.ts` `createGameAiSettings`): a fresh profile's
 * defaults (a 500-credit daily alert, half of each plan kept for building, the Create route off,
 * the plan not allowed), a hostile settings file read field by field, auto top-up written only to
 * genex.games, and a genex.games that cannot be reached read as signed out.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGameAiSettings, type SettingsPlatform } from "../../src/main/game-ai/budgets.ts";
import { AiPickPolicy, type AiAutoTopUp } from "../../src/shared/game-ai-views.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A genex.games stand-in that records what auto top-up was set to. */
function platform(options: { balance?: number | null; down?: boolean } = {}) {
  const set: AiAutoTopUp[] = [];
  const fail = () => Promise.reject(new Error("offline"));
  const stub: SettingsPlatform & { set: AiAutoTopUp[] } = {
    set,
    balanceCredits: () => (options.down ? fail() : Promise.resolve(options.balance ?? null)),
    autoTopUp: () => (options.down ? fail() : Promise.resolve(set.at(-1) ?? null)),
    setAutoTopUp: async (next) => {
      set.push(next);
      return next;
    },
    pausedGames: () => (options.down ? fail() : Promise.resolve([])),
  };
  return stub;
}

async function settingsAt(file?: string, stub = platform()) {
  const at = file ?? path.join(await tmpDir("game-ai-settings-"), "settings.json");
  const settings = createGameAiSettings({ file: at, platform: stub });
  await settings.load();
  return { settings, file: at, stub };
}

describe("Settings → Play-time AI", () => {
  it("starts a fresh profile at the v3 defaults", async () => {
    const { settings } = await settingsAt();
    const view = await settings.view();
    assert.equal(view.pick, AiPickPolicy.Best);
    assert.equal(view.dailyAlertCredits, 500);
    assert.equal(view.keepForBuildingPercent, 50);
    assert.equal(view.openRouterMonthlyMicros, null);
    assert.equal(view.createRouteEnabled, false, "D1: off by default");
    assert.equal(view.allowPlan, false, "D2: the legal hold");
    assert.equal(view.shareFitCounts, false);
    assert.equal(view.signedIn, false);
    assert.deepEqual(await settings.limits(), { dailyAlertMicros: 5_000_000, openRouterMonthlyMicros: null });
  });

  it("saves a change, keeps it across a restart, and gives the grants its limits in micros", async () => {
    const { settings, file } = await settingsAt();
    await settings.save({ dailyAlertCredits: 120, openRouterMonthlyMicros: 2_000_000, keepForBuildingPercent: 70 });
    const again = await settingsAt(file);
    assert.equal(again.settings.local().keepForBuildingPercent, 70);
    assert.deepEqual(await again.settings.limits(), {
      dailyAlertMicros: 1_200_000,
      openRouterMonthlyMicros: 2_000_000,
    });
    await again.settings.save({ dailyAlertCredits: null });
    assert.equal((await again.settings.limits()).dailyAlertMicros, null, "no alert");
  });

  it("writes auto top-up only to genex.games, never to this Mac", async () => {
    const { settings, file, stub } = await settingsAt(undefined, platform({ balance: 340 }));
    const view = await settings.save({ autoTopUp: { on: true, underCredits: 100, addCredits: 1_000 } });
    assert.deepEqual(stub.set, [{ on: true, underCredits: 100, addCredits: 1_000 }]);
    assert.deepEqual(view.autoTopUp, { on: true, underCredits: 100, addCredits: 1_000 });
    assert.equal(view.signedIn, true);
    assert.equal(view.balanceCredits, 340);
    assert.ok(!(await readFile(file, "utf8")).includes("autoTopUp"));
  });

  it("opens Settings signed out when genex.games cannot be reached", async () => {
    const { settings } = await settingsAt(undefined, platform({ down: true }));
    const view = await settings.view();
    assert.equal(view.signedIn, false);
    assert.equal(view.balanceCredits, null);
    assert.equal(view.autoTopUp, null);
  });

  it("reads a hostile settings file field by field: a bad value keeps its default", async () => {
    const file = path.join(await tmpDir("game-ai-settings-hostile-"), "settings.json");
    const rows: Array<[string, string]> = [
      ['{"keepForBuildingPercent":-5,"allowPlan":"yes","pick":"free-only"}', "bad values"],
      ['{"dailyAlertCredits":1e12,"openRouterMonthlyMicros":1.5,"createRouteEnabled":1}', "out of range"],
      ['{"__proto__":{"allowPlan":true},"constructor":{"x":1}}', "prototype keys"],
      ["[1,2,3]", "not an object"],
      ["{ not json", "not JSON"],
    ];
    for (const [text, label] of rows) {
      await writeFile(file, text);
      const { settings } = await settingsAt(file);
      const local = settings.local();
      assert.equal(local.allowPlan, false, label);
      assert.equal(local.keepForBuildingPercent, 50, label);
      assert.equal(local.dailyAlertCredits, 500, label);
      assert.equal(local.openRouterMonthlyMicros, null, label);
      assert.equal(local.createRouteEnabled, false, label);
      assert.equal(Object.getPrototypeOf({}), Object.prototype, label);
    }
    await writeFile(file, '{"keepForBuildingPercent":-5,"pick":"free-only"}');
    assert.equal((await settingsAt(file)).settings.local().pick, AiPickPolicy.FreeOnly, "a good field is kept");
  });
});
