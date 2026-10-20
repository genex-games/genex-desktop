/**
 * Play-time AI's ledger (`main/game-ai/ledger.ts`): one line per settled call in
 * `userData/game-ai/ledger.jsonl` — ids, counts and money, never prompt or answer text — and a
 * `CustomEvent.GameAiCall` record of each. Append-only and rotated, read newest first per game, a
 * month's spend per game on the injected clock, and a hostile file read line by line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createGameAiLedger, LEDGER_FILE } from "../../src/main/game-ai/ledger.ts";
import type { AiLedgerEntry } from "../../src/main/game-ai/types.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { AiDoor, AiErrorCode, AiProvenance, type AiGameKey } from "../../src/shared/game-ai.ts";
import { heldClock } from "../helpers/game-ai-fakes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CROWNS: AiGameKey = "play:proj_crowns";
const MOSS: AiGameKey = "create:Moss Garden";

function entry(patch: Partial<AiLedgerEntry> = {}): AiLedgerEntry {
  return {
    at: "2026-10-20T10:00:00.000Z",
    game: CROWNS,
    grantId: "g_abcdefghijkl",
    site: "turn.resolve",
    door: AiDoor.Byok,
    model: "anthropic/claude-haiku-4.5",
    provenance: AiProvenance.Unverified,
    code: null,
    repaired: false,
    usage: { inputTokens: 300, outputTokens: 40 },
    costMicros: 1_200,
    latencyMs: 850,
    ...patch,
  };
}

async function ledgerIn(options: { maxBytes?: number; failing?: boolean } = {}) {
  const dir = await tmpDir("game-ai-ledger-");
  const clock = heldClock();
  const events: unknown[] = [];
  const ledger = createGameAiLedger({
    dir,
    clock,
    maxBytes: options.maxBytes,
    record: async (event) => {
      if (options.failing) throw new Error("log closed");
      events.push(event);
    },
  });
  return { ledger, dir, clock, events };
}

describe("the play-time AI ledger", () => {
  it("reads calls back newest first, per game, at most the limit", async () => {
    const { ledger } = await ledgerIn();
    await ledger.append(entry({ site: "a" }));
    await ledger.append(entry({ site: "b", game: MOSS }));
    await ledger.append(entry({ site: "c" }));
    assert.deepEqual(
      (await ledger.recent(10)).map((row) => row.site),
      ["c", "b", "a"],
    );
    assert.deepEqual(
      (await ledger.recent(10, CROWNS)).map((row) => row.site),
      ["c", "a"],
    );
    assert.deepEqual(
      (await ledger.recent(1)).map((row) => row.site),
      ["c"],
    );
    assert.deepEqual(await ledger.recent(0), []);
  });

  it("writes ids, counts and money only, and records each call as an event with no text", async () => {
    const { ledger, dir, events } = await ledgerIn();
    const sneaky = { ...entry(), prompt: "the player's secret", answer: "the reply" } as AiLedgerEntry;
    await ledger.append(sneaky);
    const text = await readFile(path.join(dir, LEDGER_FILE), "utf8");
    assert.ok(!text.includes("secret") && !text.includes("the reply"), "no text reaches the file");
    assert.deepEqual(Object.keys(JSON.parse(text.trim())).sort(), Object.keys(entry()).sort());
    assert.equal(events.length, 1);
    const event = events[0] as { event_type: string; payload: Record<string, unknown> };
    assert.equal(event.event_type, CustomEvent.GameAiCall);
    assert.equal(event.payload.costMicros, 1_200);
    assert.ok(!JSON.stringify(event).includes("secret"));
  });

  it("keeps a call in the file when the event log refuses it", async () => {
    const { ledger } = await ledgerIn({ failing: true });
    await ledger.append(entry());
    assert.equal((await ledger.recent(5)).length, 1);
  });

  it("rotates past its size and keeps reading across the rotation, within twice the cap", async () => {
    const { ledger, dir } = await ledgerIn({ maxBytes: 2_000 });
    for (let call = 0; call < 40; call += 1) await ledger.append(entry({ site: `s${call}` }));
    const sizes = await Promise.all(
      [LEDGER_FILE, LEDGER_FILE.replace(".jsonl", ".1.jsonl")].map(
        async (name) => (await stat(path.join(dir, name))).size,
      ),
    );
    for (const size of sizes) assert.ok(size <= 2_000, `each file within its cap (${size})`);
    const recent = await ledger.recent(100);
    assert.equal(recent[0]?.site, "s39", "the newest is read");
    assert.ok(recent.length < 40, "the oldest rotated away");
  });

  it("sums this month's spend per game on the injected clock", async () => {
    const { ledger, clock } = await ledgerIn();
    await ledger.append(entry({ at: "2026-09-30T23:59:00.000Z", costMicros: 9_999 }));
    await ledger.append(entry({ costMicros: 1_000 }));
    await ledger.append(entry({ costMicros: 500, game: MOSS }));
    await ledger.append(entry({ costMicros: 0, code: AiErrorCode.InvalidOutput }));
    const month = await ledger.monthByGame();
    assert.equal(month.get(CROWNS), 1_000, "last month's calls are not this month's");
    assert.equal(month.get(MOSS), 500);
    clock.set("2026-11-02T00:00:00.000Z");
    assert.equal((await ledger.monthByGame()).size, 0);
  });

  it("reads a hostile ledger file line by line: a bad line is dropped, never thrown", async () => {
    const { ledger, dir } = await ledgerIn();
    await ledger.append(entry({ site: "good" }));
    const file = path.join(dir, LEDGER_FILE);
    const bad = [
      "not json",
      JSON.stringify({ ...entry(), game: "play:../x" }),
      JSON.stringify({ ...entry(), costMicros: -1 }),
      JSON.stringify({ ...entry(), door: "wallet" }),
      JSON.stringify({ ...entry(), usage: { inputTokens: "many" } }),
      JSON.stringify({ ...entry(), at: "yesterday" }),
      JSON.stringify([1, 2]),
      '{"__proto__":{"polluted":true}}',
    ];
    await appendFile(file, `${bad.join("\n")}\n`);
    await ledger.append(entry({ site: "after" }));
    assert.deepEqual(
      (await ledger.recent(50)).map((row) => row.site),
      ["after", "good"],
    );
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});
