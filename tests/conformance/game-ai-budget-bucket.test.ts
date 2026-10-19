/**
 * The budget ledger's host-only game bucket (`substrate/budget.ts`): play-time AI's calls are
 * counted in a bucket of their own, per game and day, never gated by a running build, never part
 * of the improvement share, and held to a per-game daily call cap that survives a restart.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { BudgetLedger } from "../../src/substrate/budget.ts";
import { WorkClass } from "../../src/shared/harness-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A ledger on a clock the test holds. */
async function ledgerAt(start: string, options: { floor?: number } = {}) {
  const file = path.join(await tmpDir("game-bucket-"), "budget-ledger.json");
  let now = new Date(start);
  const ledger = new BudgetLedger({
    file,
    now: () => now,
    improvementShare: 0.15,
    improvementFloorTokens: options.floor ?? 1_000,
  });
  return {
    ledger,
    file,
    set: (iso: string) => {
      now = new Date(iso);
    },
  };
}

describe("the budget ledger's game bucket", () => {
  it("admits a game's calls while a build runs: user work never gates it", async () => {
    const { ledger } = await ledgerAt("2026-10-20T10:00:00Z");
    ledger.beginWork(WorkClass.User);
    assert.equal(ledger.gate({ class: WorkClass.Improvement }).ok, false, "improvement still waits for the build");
    assert.deepEqual(ledger.admitGame("play:p1", 3), { ok: true });
    ledger.endWork(WorkClass.User);
  });

  it("refuses a game past its daily cap, per game, and lets the next day start afresh", async () => {
    const { ledger, set } = await ledgerAt("2026-10-20T10:00:00Z");
    for (let call = 0; call < 2; call += 1) assert.equal(ledger.admitGame("play:p1", 2).ok, true);
    const refused = ledger.admitGame("play:p1", 2);
    assert.equal(refused.ok, false);
    assert.equal(ledger.todayGame("play:p1").calls, 2, "a refused call is not counted");
    assert.equal(ledger.admitGame("play:p2", 2).ok, true, "another game has its own count");
    set("2026-10-21T00:00:01Z");
    assert.equal(ledger.admitGame("play:p1", 2).ok, true, "a new day starts afresh");
  });

  it("takes no cap as no cap, and never counts a non-finite or negative cap as one", async () => {
    const { ledger } = await ledgerAt("2026-10-20T10:00:00Z");
    for (let call = 0; call < 5; call += 1) assert.equal(ledger.admitGame("create:Moss", null).ok, true);
    for (const cap of [0, -1, Number.NaN]) {
      assert.equal(ledger.admitGame("create:Lantern", cap).ok, false, `cap ${cap} admits nothing`);
    }
  });

  it("keeps game tokens out of the improvement share", async () => {
    const { ledger } = await ledgerAt("2026-10-20T10:00:00Z", { floor: 1_000 });
    ledger.record({ tokens: 1_100, class: WorkClass.Improvement });
    assert.equal(ledger.gate({ class: WorkClass.Improvement }).ok, false);
    ledger.recordGame("play:p1", 1_000_000);
    assert.equal(
      ledger.gate({ class: WorkClass.Improvement }).ok,
      false,
      "a game's tokens never earn improvement work a larger share",
    );
    assert.deepEqual(ledger.today(), { user: 0, improvement: 1_100 });
    assert.equal(ledger.todayGame("play:p1").tokens, 1_000_000);
    assert.equal(ledger.todayGame().tokens, 1_000_000, "the day's total across games");
  });

  it("persists the bucket and reads it back after a restart", async () => {
    const { ledger, file } = await ledgerAt("2026-10-20T10:00:00Z");
    ledger.admitGame("play:p1", 2);
    ledger.admitGame("play:p1", 2);
    ledger.recordGame("play:p1", 40);
    await ledger.flush();
    const again = new BudgetLedger({ file, now: () => new Date("2026-10-20T11:00:00Z") });
    await again.load();
    assert.equal(again.admitGame("play:p1", 2).ok, false, "the cap holds across a restart");
    assert.deepEqual(again.todayGame("play:p1"), { calls: 2, tokens: 40 });
  });

  it("reads a hostile ledger file as counts only: bad keys and values are dropped", async () => {
    const { file } = await ledgerAt("2026-10-20T10:00:00Z");
    // Written as text: an object literal would read `"__proto__"` as the prototype, not a key.
    await writeFile(
      file,
      '{"days":{"2026-10-20":{"user":5,"improvement":1,"game":"lots",' +
        '"games":{"play:p1":{"calls":1e12,"tokens":0},"__proto__":{"calls":3},"play:p2":{"calls":-4},' +
        '"play:p3":{"calls":"7"},"play:p4":{"calls":2,"tokens":9},"not a game":{"calls":1}}}}}',
    );
    const ledger = new BudgetLedger({ file, now: () => new Date("2026-10-20T12:00:00Z") });
    await ledger.load();
    assert.deepEqual(ledger.today(), { user: 5, improvement: 1 });
    assert.equal(ledger.todayGame().tokens, 0, "the bad total reads as none");
    assert.equal(ledger.todayGame("play:p4").calls, 2);
    assert.equal(ledger.todayGame("play:p4").tokens, 9);
    for (const game of ["play:p2", "play:p3", "not a game"]) assert.equal(ledger.todayGame(game).calls, 0, game);
    assert.equal(ledger.admitGame("play:p1", 500).ok, false, "a huge count still counts against the cap");
    assert.equal(Object.getPrototypeOf({}), Object.prototype, "no prototype was touched");
  });
});
