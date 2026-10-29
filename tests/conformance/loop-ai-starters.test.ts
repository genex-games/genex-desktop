/**
 * The AI starters the builder picks from (`library/ai-starters/`), each played in Node with no
 * network on the lanes a replay uses: its recorded tape answers every call its demo makes and replays
 * the same frames on every run of a seed; with AI off and with the worst answers its schemas allow,
 * the demo still ends with nothing waiting and the world inside its rules; its schemas are of the
 * dialect; its tape is what its demo and answers make; and nothing in it calls a vendor.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { checkSchema } from "../../src/shared/game-ai-schema.ts";
import { AiSource } from "../../src/shared/game-ai.ts";
import { readTape } from "../../src/shared/game-ai-tape.ts";
import { scanForDirectCalls } from "../../src/harness-seed/loop/ai-checks.ts";
import { playDemo, StarterLane } from "../../scripts/ai-starters/lanes.ts";
import { STARTERS, STARTERS_DIR, starterTape, type StarterSpec } from "../../scripts/ai-starters/starters.ts";
import { RECORD_SEED, starterTapeText } from "../../scripts/ai-starters/record.ts";
import { NATIONS } from "../../src/harness-seed/library/ai-starters/world-sim/ai/nations.js";
import { ITEMS } from "../../src/harness-seed/library/ai-starters/npc-dialogue/ai/character.js";

const SEEDS = [1, 2, 3];
const EDGE_SEEDS = [1, 2];

/** The rules each starter's world must stay inside, whatever the model said. */
const INVARIANTS: Record<string, (end: Record<string, unknown>) => void> = {
  "world-sim": (end) => {
    const nations = end.nations as Array<{ troops: number; stance: number; stability: number }>;
    const fronts = Object.values(end.fronts as Record<string, number>);
    const total = nations.reduce((sum, nation) => sum + nation.troops, 0) + fronts.reduce((sum, n) => sum + n, 0);
    assert.equal(
      total,
      NATIONS.reduce((sum, nation) => sum + nation.troops, 0),
      "troops are conserved",
    );
    for (const nation of nations) {
      assert.ok(nation.troops >= 0 && Math.abs(nation.stance) <= 5, JSON.stringify(nation));
      assert.ok(nation.stability >= 0 && nation.stability <= 5, JSON.stringify(nation));
    }
    assert.ok(String(end.headline).length <= 160 && String(end.dispatch).length <= 200);
  },
  "creature-gen": (end) => {
    for (const creature of end.creatures as Array<Record<string, number | string>>) {
      assert.ok(Number(creature.legs) >= 0 && Number(creature.legs) <= 8, JSON.stringify(creature));
      assert.ok(Number(creature.size) >= 0.3 && Number(creature.size) <= 3, JSON.stringify(creature));
      assert.ok(Number(creature.speed) <= 6 / Math.max(1, Number(creature.size)), JSON.stringify(creature));
      assert.ok(Math.hypot(Number(creature.x), Number(creature.y)) <= 20 + 1e-9, "inside the pond");
      assert.ok(String(creature.name).length <= 24);
    }
  },
  "agent-arena": (end) => {
    for (const bot of end.bots as Array<{ hp: number; x: number; rules: number }>) {
      assert.ok(bot.hp <= 100 && bot.x >= 0 && bot.x <= 30 && bot.rules >= 1 && bot.rules <= 7, JSON.stringify(bot));
    }
  },
  "npc-dialogue": (end) => {
    const npc = end.npc as { trust: number; carried: string[]; given: string[]; line: string };
    assert.ok(npc.trust >= 0 && npc.trust <= 5);
    assert.deepEqual([...npc.carried, ...npc.given].sort(), [...ITEMS].sort(), "items are only ever handed over");
    assert.ok(npc.line.length <= 200);
  },
};

/** A starter's shipped tape, read as the host reads it. */
async function tapeOf(starter: StarterSpec) {
  return readTape(await readFile(starterTape(starter), "utf8"));
}

for (const starter of STARTERS) {
  describe(`the ${starter.name} starter`, () => {
    it("ships a guide, schemas of the dialect and a tape whose every line the reader takes", async () => {
      const readme = await readFile(path.join(STARTERS_DIR, starter.name, "README.md"), "utf8");
      assert.ok(
        readme.includes(starter.demo) && starter.sites.every((site) => readme.includes(site)),
        "the guide names them",
      );
      assert.ok(starter.schemas.length > 0);
      for (const schema of starter.schemas) assert.equal(checkSchema(schema), null, JSON.stringify(schema));
      const tape = await tapeOf(starter);
      assert.equal(tape.rejected, 0);
      assert.equal(tape.truncated, false);
      assert.ok(tape.lines.length > 0);
      assert.ok(tape.lines.every((line) => starter.sites.includes(line.site) && line.source === AiSource.Fixture));
      assert.deepEqual(
        new Set(tape.lines.map((line) => line.site)),
        new Set(starter.sites),
        "the demo reaches every site",
      );
    });

    it("ships the tape its demo and answers make (recorded again after any change)", async () => {
      const made = await starterTapeText(starter);
      assert.ok("text" in made, JSON.stringify(made));
      assert.equal(made.text, await readFile(starterTape(starter), "utf8"));
    });

    it("replays from its tape with no miss, and each seed replays the same frames on every run", async () => {
      const tape = await tapeOf(starter);
      for (const seed of SEEDS) {
        const first = await playDemo(starter.play, { lane: StarterLane.Tape, seed, tape });
        const again = await playDemo(starter.play, { lane: StarterLane.Tape, seed, tape });
        assert.equal(first.record.misses, 0, `seed ${seed}`);
        assert.equal(first.record.fallbacks, 0, `seed ${seed}`);
        assert.equal(first.stuck, 0, `seed ${seed}`);
        assert.deepEqual(again.digests, first.digests, `seed ${seed}`);
        assert.equal(first.record.budgetAsks, 1, "AI is asked for once, from the first gesture");
        INVARIANTS[starter.name]?.(first.end);
      }
      const recorded = await playDemo(starter.play, { lane: StarterLane.Tape, seed: RECORD_SEED, tape });
      assert.ok(
        recorded.end.ai && (recorded.end.ai as { disclosed: boolean }).disclosed,
        "the demo draws the disclosure",
      );
    });

    it("ends with AI off, every call falling back and nothing left waiting", async () => {
      const played = await playDemo(starter.play, { lane: StarterLane.None, seed: RECORD_SEED });
      assert.equal(played.stuck, 0);
      assert.ok(played.record.calls > 0 && played.record.fallbacks === played.record.calls);
      INVARIANTS[starter.name]?.(played.end);
    });

    it("keeps its world inside the rules on the worst answers its schemas allow", async () => {
      for (const seed of EDGE_SEEDS) {
        const played = await playDemo(starter.play, { lane: StarterLane.Edge, seed });
        assert.equal(played.stuck, 0, `seed ${seed}`);
        INVARIANTS[starter.name]?.(played.end);
      }
    });

    it("calls no AI vendor and holds no key", async () => {
      const scan = await scanForDirectCalls(path.join(STARTERS_DIR, starter.name));
      assert.deepEqual(scan.hits, []);
      assert.ok(scan.scanned > 0);
    });
  });
}

describe("a tape played by the lanes", () => {
  const [starter] = STARTERS;
  it("treats a line whose answer does not fit the call's schema as a miss, never as an answer", async () => {
    assert.ok(starter);
    const text = await readFile(starterTape(starter), "utf8");
    const broken = text
      .split("\n")
      .filter(Boolean)
      .map((row, index) => {
        if (index !== 0) return row;
        const line = JSON.parse(row);
        return JSON.stringify({ ...line, value: { reactions: "all of them", headline: 7 } });
      })
      .join("\n");
    const played = await playDemo(starter.play, { lane: StarterLane.Tape, seed: 1, tape: readTape(`${broken}\n`) });
    assert.ok(played.record.misses >= 1);
    assert.equal(played.stuck, 0);
    INVARIANTS[starter.name]?.(played.end);
  });
});
