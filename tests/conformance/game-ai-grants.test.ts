/**
 * Play-time AI's grants (`main/game-ai/budgets.ts`): one live grant per game, newest replacing
 * under a mutex; the worst case reserved and persisted before a call leaves main, so a crash
 * keeps the spend; nothing charged for a reply the game could not use (D7); the person's limits
 * (a daily alert per game, the OpenRouter monthly limit) and the per-grant rates on a held clock,
 * a clock going backwards included; first-use consent per game and door, forgotten on a payer change.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGameAiGrants } from "../../src/main/game-ai/budgets.ts";
import {
  AiConsent,
  AiDoor,
  AiErrorCode,
  AiGrantStatus,
  AiRequirement,
  microsOfCredits,
  type AiGameKey,
} from "../../src/shared/game-ai.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BYOK_HAIKU, callCounter, heldClock, LOCAL_QWEN, PLAN_HAIKU } from "../helpers/game-ai-fakes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CROWNS: AiGameKey = "play:proj_crowns";
const MOSS: AiGameKey = "create:Moss Garden";

async function store(options: { alertCredits?: number | null; monthlyMicros?: number | null; file?: string } = {}) {
  const file = options.file ?? path.join(await tmpDir("game-ai-grants-"), "grants.json");
  const clock = heldClock();
  const calls = callCounter();
  let limits = {
    dailyAlertMicros: options.alertCredits === undefined ? null : microsOfCreditsOrNull(options.alertCredits),
    openRouterMonthlyMicros: options.monthlyMicros ?? null,
  };
  const grants = createGameAiGrants({
    file,
    clock,
    calls,
    limits: async () => limits,
  });
  await grants.load();
  return {
    grants,
    file,
    clock,
    calls,
    setLimits: (next: typeof limits) => {
      limits = next;
    },
  };
}

function microsOfCreditsOrNull(credits: number | null): number | null {
  return credits === null ? null : microsOfCredits(credits);
}

async function onFile(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as { grants: Array<Record<string, unknown>> };
}

describe("play-time AI grants", () => {
  it("keeps one live grant per game: a new model replaces the old one", async () => {
    const { grants } = await store();
    const first = await grants.grant(CROWNS, LOCAL_QWEN, AiConsent.Silent, AiRequirement.Optional);
    assert.equal(first.status, AiGrantStatus.Active);
    assert.equal(grants.live(CROWNS)?.id, first.id);
    const second = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Ai);
    assert.equal(grants.live(CROWNS)?.id, second.id);
    assert.equal(grants.list().find((grant) => grant.id === first.id)?.status, AiGrantStatus.Replaced);
    assert.equal(grants.live(MOSS), null, "another game holds nothing");
  });

  it("keeps one live grant when many grants race for the same game", async () => {
    const { grants } = await store();
    const models = [LOCAL_QWEN, BYOK_HAIKU, PLAN_HAIKU];
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        grants.grant(CROWNS, models[index % models.length] ?? LOCAL_QWEN, AiConsent.Menu, AiRequirement.Optional),
      ),
    );
    const live = grants.list().filter((grant) => grant.game === CROWNS && grant.status !== AiGrantStatus.Replaced);
    assert.equal(live.length, 1);
    assert.equal(grants.live(CROWNS)?.id, live[0]?.id);
  });

  it("reserves the worst case and writes it down before the call leaves main", async () => {
    const { grants, file } = await store();
    const grant = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const held = await grants.reserve(grant, 40_000);
    assert.ok(held.ok);
    const written = (await onFile(file)).grants.find((row) => row.id === grant.id);
    assert.equal(written?.spentMicros, 40_000, "the hold is on disk before dispatch");
    assert.equal(written?.todayMicros, 40_000);
    assert.equal(written?.monthMicros, 40_000);
  });

  it("keeps the worst case after a crash mid-call: a restart never refunds", async () => {
    const first = await store();
    const grant = await first.grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    assert.ok((await first.grants.reserve(grant, 25_000)).ok);
    const after = await store({ file: first.file });
    assert.equal(after.grants.live(CROWNS)?.spentMicros, 25_000);
  });

  it("settles what the call cost, charges nothing for an unusable reply, and gives back an unsent one", async () => {
    const { grants, calls } = await store();
    const grant = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const used = await grants.reserve(grant, 40_000);
    assert.ok(used.ok);
    await used.hold.settle({ usage: { inputTokens: 300, outputTokens: 50 }, costMicros: 1_234 });
    assert.equal(grants.live(CROWNS)?.spentMicros, 1_234);
    assert.equal(calls.tokens.get(CROWNS), 350, "the tokens go to the game bucket");

    const unusable = await grants.reserve(grant, 40_000);
    assert.ok(unusable.ok);
    unusable.hold.countRepair();
    await unusable.hold.settle(null);
    assert.equal(grants.live(CROWNS)?.spentMicros, 1_234, "D7: an invalid reply and its repair cost nothing");

    const unsent = await grants.reserve(grant, 40_000);
    assert.ok(unsent.ok);
    await unsent.hold.release();
    await unsent.hold.release();
    assert.equal(grants.live(CROWNS)?.spentMicros, 1_234, "released once, whatever is called twice");
    assert.equal(grants.live(CROWNS)?.todayMicros, 1_234);
  });

  it("holds a paid grant to two calls at once and thirty a minute; a repair counts toward the rate", async () => {
    const { grants, clock } = await store();
    const grant = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const a = await grants.reserve(grant, 10);
    const b = await grants.reserve(grant, 10);
    const c = await grants.reserve(grant, 10);
    assert.ok(a.ok && b.ok);
    assert.equal(c.ok, false);
    assert.equal(!c.ok && c.code, AiErrorCode.Concurrency);
    await a.hold.release();
    b.hold.countRepair();
    await b.hold.release();
    for (let call = 0; call < 27; call += 1) {
      const held = await grants.reserve(grant, 10);
      assert.ok(held.ok, `call ${call}`);
      await held.hold.release();
    }
    const limited = await grants.reserve(grant, 10);
    assert.equal(!limited.ok && limited.code, AiErrorCode.RateLimited);
    assert.ok(!limited.ok && limited.retryAfterMs !== null && limited.retryAfterMs <= MINUTE_MS);
    clock.advance(MINUTE_MS + 1);
    assert.ok((await grants.reserve(grant, 10)).ok, "the minute passed");
  });

  it("holds a game to its daily calls on a door, until the next day", async () => {
    const { grants, clock } = await store();
    const grant = await grants.grant(MOSS, PLAN_HAIKU, AiConsent.Card, AiRequirement.Optional);
    for (let call = 0; call < 50; call += 1) {
      const held = await grants.reserve(grant, 0);
      assert.ok(held.ok, `call ${call}`);
      await held.hold.release();
      clock.advance(3 * MINUTE_MS);
    }
    const refused = await grants.reserve(grant, 0);
    assert.equal(!refused.ok && refused.code, AiErrorCode.RateLimited);
    assert.ok(!refused.ok && refused.retryAfterMs !== null && refused.retryAfterMs > 0, "until midnight UTC");
  });

  it("refuses an OpenRouter call past the person's monthly limit, counting what is held", async () => {
    const { grants } = await store({ monthlyMicros: 100_000 });
    const grant = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const first = await grants.reserve(grant, 60_000);
    assert.ok(first.ok);
    const second = await grants.reserve(grant, 60_000);
    assert.equal(!second.ok && second.code, AiErrorCode.MonthlyLimit, "what is held counts");
    await first.hold.settle({ usage: null, costMicros: 20_000 });
    assert.ok((await grants.reserve(grant, 60_000)).ok, "the settled cost leaves room again");
    const other = await grants.grant(MOSS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    assert.equal((await grants.reserve(other, 60_000)).ok, false, "the limit is the key's, across every game on it");
    const local = await grants.grant(MOSS, LOCAL_QWEN, AiConsent.Silent, AiRequirement.Optional);
    assert.ok((await grants.reserve(local, 0)).ok, "a model on this Mac is never held to it");
  });

  it("pauses a game when its spend today crosses the alert, once a day after Keep playing", async () => {
    const { grants } = await store({ alertCredits: 5 });
    const grant = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const under = await grants.reserve(grant, 60_000);
    assert.ok(under.ok);
    await under.hold.settle({ usage: null, costMicros: 30_000 });
    assert.equal(grants.live(CROWNS)?.status, AiGrantStatus.Active);
    const over = await grants.reserve(grant, 60_000);
    assert.ok(over.ok);
    await over.hold.settle({ usage: null, costMicros: 30_000 });
    assert.equal(grants.live(CROWNS)?.status, AiGrantStatus.Paused, "50,000 micros is past 5 credits");
    assert.equal((await grants.reserve(grant, 1)).ok, false, "a paused game waits for the person");
    await grants.setStatus(grant.id, AiGrantStatus.Active);
    const again = await grants.reserve(grant, 60_000);
    assert.ok(again.ok);
    await again.hold.settle({ usage: null, costMicros: 30_000 });
    assert.equal(grants.live(CROWNS)?.status, AiGrantStatus.Active, "after Keep playing it plays on today");
  });

  it("never resets today's or this month's spend when the clock goes backwards", async () => {
    const { grants, clock } = await store({ monthlyMicros: 100_000 });
    const grant = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const held = await grants.reserve(grant, 0);
    assert.ok(held.ok);
    await held.hold.settle({ usage: null, costMicros: 90_000 });
    clock.set("2026-09-01T00:00:00.000Z");
    assert.equal((await grants.reserve(grant, 20_000)).ok, false, "last month's limit still holds");
    assert.equal(grants.live(CROWNS)?.todayMicros, 90_000);
    clock.set("2026-11-01T00:00:01.000Z");
    assert.ok((await grants.reserve(grant, 20_000)).ok, "a real new month starts afresh");
  });

  it("refuses a hold on a grant that is off, paused, replaced or unknown, with no side effect", async () => {
    const { grants, file } = await store();
    const grant = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    await grants.setOn(CROWNS, false);
    const before = await readFile(file, "utf8");
    const off = await grants.reserve(grant, 10);
    assert.equal(!off.ok && off.code, AiErrorCode.Off);
    const ghost = await grants.reserve({ ...grant, id: "nonexistent_grant" }, 10);
    assert.equal(!ghost.ok && ghost.code, AiErrorCode.ConsentRequired);
    for (const worst of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await grants.setOn(CROWNS, true);
      const odd = await grants.reserve(grant, worst);
      assert.equal(!odd.ok && odd.code, AiErrorCode.DoorUnavailable, `worst ${worst}`);
      await grants.setOn(CROWNS, false);
    }
    assert.equal(await readFile(file, "utf8"), before, "no refusal wrote anything");
    assert.equal((await grants.setOn(CROWNS, true))?.status, AiGrantStatus.Active, "turned on again");
  });

  it("remembers first-use consent per game and door, and forgets it when the payer changes", async () => {
    const { grants } = await store();
    await grants.grant(CROWNS, LOCAL_QWEN, AiConsent.Silent, AiRequirement.Optional);
    assert.equal(grants.consented(CROWNS, AiDoor.Local), false, "a silent start is nobody's yes");
    await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    await grants.grant(MOSS, BYOK_HAIKU, AiConsent.Menu, AiRequirement.Optional);
    assert.equal(grants.consented(CROWNS, AiDoor.Byok), true);
    assert.equal(grants.consented(CROWNS, AiDoor.Plan), false, "per door");
    const stopped = await grants.stopDoor(AiDoor.Byok);
    assert.deepEqual(stopped.sort(), [MOSS, CROWNS].sort());
    assert.equal(grants.consented(CROWNS, AiDoor.Byok), false, "a new payer is asked again");
    assert.equal(grants.live(CROWNS), null, "the grant naming the old payer is gone");
  });

  it("turns a game's AI off before it holds a grant, and a later pick turns it on", async () => {
    const { grants, file } = await store();
    assert.equal(grants.isOff(CROWNS), false);
    assert.equal(await grants.setOn(CROWNS, false), null, "no grant to answer with");
    assert.equal(grants.isOff(CROWNS), true, "off before any grant");
    assert.equal((await store({ file })).grants.isOff(CROWNS), true, "off survives a restart");
    assert.equal(grants.isOff(MOSS), false, "per game");
    await grants.grant(CROWNS, LOCAL_QWEN, AiConsent.Menu, AiRequirement.Optional);
    assert.equal(grants.isOff(CROWNS), false, "a pick in the menu turns it on");
    await grants.setOn(CROWNS, false);
    assert.equal(grants.isOff(CROWNS), true, "off on its grant");
  });

  it("shows a game its grant with no account, model or price", async () => {
    const { grants } = await store();
    const grant = await grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const view = grants.view(grant);
    assert.deepEqual(Object.keys(view).sort(), [
      "door",
      "id",
      "planResetsAt",
      "planUsedPercent",
      "spentMicros",
      "status",
    ]);
    assert.ok(!JSON.stringify(view).includes(BYOK_HAIKU.model));
  });

  it("reads a hostile grants file without throwing: bad rows are dropped, good ones kept", async () => {
    const dir = await tmpDir("game-ai-grants-hostile-");
    const file = path.join(dir, "grants.json");
    const first = await store({ file });
    const kept = await first.grants.grant(CROWNS, BYOK_HAIKU, AiConsent.Card, AiRequirement.Optional);
    const written = await onFile(file);
    const rows = [
      ...written.grants,
      { ...written.grants[0], id: "short", game: CROWNS },
      { ...written.grants[0], id: "aaaaaaaaaaaa", game: "play:../../etc" },
      { ...written.grants[0], id: "bbbbbbbbbbbb", spentMicros: -5 },
      { ...written.grants[0], id: "cccccccccccc", status: "unlimited" },
      null,
      "grant",
    ];
    await writeFile(file, JSON.stringify({ ...written, grants: rows }));
    const again = await store({ file });
    assert.deepEqual(
      again.grants.list().map((grant) => grant.id),
      [kept.id],
    );
    await writeFile(file, "{ not json");
    assert.deepEqual((await store({ file })).grants.list(), [], "an unreadable file is an empty store");
  });
});
