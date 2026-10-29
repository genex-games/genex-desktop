/**
 * Playing a demo for the harness on an agent's preview window (`main/core/ai-demo-player.ts`): a
 * window is leased and always given back, the build is served with the lane named on the page, the
 * world is seeded, the demo is run to its end (awaited when it is async), and what the page holds is
 * read back small — a digest per checkpoint, `genex-ai`'s status and the calls its tape missed —
 * with the console errors of that play. The page itself is a stand-in run in a VM context: the probe
 * is the very text the window evaluates.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { previewDemoPlayer, type DemoPlayerDeps } from "../../src/main/core/ai-demo-player.ts";
import type { AiDemoRun } from "../../src/main/game-ai/harness-host.ts";
import { AiLane } from "../../src/shared/game-ai-lane.ts";
import { canonicalJson } from "../../src/shared/game-ai-schema.ts";
import type { PreviewConsoleEntry } from "../../src/shared/preview-contract.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";

const RUN: AiDemoRun = {
  project: "Crowns",
  root: null,
  demo: "turn-three",
  seed: 3,
  lane: { lane: AiLane.Tape, tape: "turn-three" },
};

/** A page with `__studio` and `__genexAi` as a game built on the template has them. */
function page(options: { demo?: (step: () => void) => unknown; noDemo?: boolean; throws?: boolean } = {}) {
  const seeds: number[] = [];
  let frame = 0;
  const world = { turn: 0, log: [] as string[] };
  const studio = {
    seed: (value: number) => {
      seeds.push(value);
      world.turn = 0;
      world.log = [];
      return value;
    },
    state: () => ({ turn: world.turn, frame }),
    demo: (name: string) => {
      if (options.noDemo || name !== RUN.demo) return { ok: false, available: [] };
      if (options.throws) throw new Error("demo crashed");
      const step = () => {
        frame += 1;
        world.turn += 1;
      };
      const result = options.demo ? options.demo(step) : undefined;
      return { ok: true, demo: name, result: result === undefined ? null : result };
    },
  };
  const genexAi = {
    status: () => ({ lane: "tape", misses: 1, fallbacks: 1, pending: 0, refused: { ai_unrecorded: 1 } }),
    missed: () => [{ key: "k".repeat(64), n: 0, request: { prompt: "Turn 0" } }],
  };
  const scope = { __studio: studio, __genexAi: genexAi };
  return { scope, seeds };
}

/** A leased window whose page is `scope`, evaluating exactly what the player sends it. */
function deps(scope: Record<string, unknown>, consoleErrors: PreviewConsoleEntry[] = []) {
  const events: string[] = [];
  const port = {
    evaluate: async (expression: string) => {
      const context = vm.createContext({
        ...scope,
        crypto: globalThis.crypto,
        TextEncoder,
        Promise,
        JSON,
        Array,
        Object,
      });
      Reflect.set(context, "globalThis", context);
      return JSON.parse(JSON.stringify(await vm.runInContext(expression, context)));
    },
    consoleEntries: (since: number) => consoleErrors.filter((entry) => entry.at >= since),
    status: () => ({ ready: true }),
  } as unknown as PreviewPort;
  const playerDeps: DemoPlayerDeps = {
    lease: async () => {
      events.push("lease");
      return {
        handle: "facet-1",
        port,
        release: async () => void events.push("release"),
      };
    },
    load: async (handle, run) => void events.push(`load ${handle} ${run.project} ${run.lane.lane}:${run.lane.tape}`),
    ready: async () => {
      events.push("ready");
      return true;
    },
    now: () => 1_000,
  };
  return { playerDeps, events };
}

const sha = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

describe("playing a demo for the harness", () => {
  it("leases a window, serves the build on the lane, seeds, runs the demo to its end and gives the window back", async () => {
    const { scope, seeds } = page({
      demo: (step) => {
        const points = [];
        for (let turn = 0; turn < 3; turn += 1) {
          step();
          points.push({ turn: turn + 1 });
        }
        return Promise.resolve(points);
      },
    });
    const { playerDeps, events } = deps(scope);
    const played = await previewDemoPlayer(playerDeps).play(RUN);
    assert.equal(played.ended, true);
    assert.deepEqual(seeds, [3]);
    assert.deepEqual(played.digests, [{ turn: 1 }, { turn: 2 }, { turn: 3 }].map(sha));
    assert.deepEqual((played.status as { misses: number }).misses, 1);
    assert.equal((played.missed as unknown[]).length, 1);
    assert.equal(played.consoleErrors, 0);
    assert.deepEqual(events, ["lease", "load facet-1 Crowns tape:turn-three", "ready", "release"]);
  });

  it("digests the final state when the demo returns no checkpoints", async () => {
    const { scope } = page({ demo: (step) => step() });
    const played = await previewDemoPlayer(deps(scope).playerDeps).play(RUN);
    assert.equal(played.ended, true);
    assert.deepEqual(played.digests, [sha({ turn: 1, frame: 1 })]);
  });

  it("says a demo that does not exist or throws did not end, and still gives the window back", async () => {
    for (const options of [{ noDemo: true }, { throws: true }]) {
      const { scope } = page(options);
      const { playerDeps, events } = deps(scope);
      const played = await previewDemoPlayer(playerDeps).play(RUN);
      assert.equal(played.ended, false, JSON.stringify(options));
      assert.equal(events.at(-1), "release");
    }
  });

  it("gives the window back when the build would not load, and says the play did not end", async () => {
    const { scope } = page({ demo: () => [] });
    const { playerDeps, events } = deps(scope);
    playerDeps.load = async () => {
      throw new Error("build broken");
    };
    await assert.rejects(previewDemoPlayer(playerDeps).play(RUN));
    assert.deepEqual(events, ["lease", "release"]);
  });

  it("counts the console errors the page logged during the play", async () => {
    const { scope } = page({ demo: () => [] });
    const errors: PreviewConsoleEntry[] = [
      { at: 1_000, level: "error", message: "boom" },
      { at: 1_001, level: "warning", message: "meh" },
      { at: 1_002, level: "error", message: "again" },
    ];
    const played = await previewDemoPlayer(deps(scope, errors).playerDeps).play(RUN);
    assert.equal(played.consoleErrors, 2);
  });

  it("reads a page with no genex-ai as no status and no misses", async () => {
    const { scope } = page({ demo: () => [] });
    const played = await previewDemoPlayer(deps({ __studio: scope.__studio }).playerDeps).play(RUN);
    assert.equal(played.ended, true);
    assert.equal(played.status, null);
    assert.deepEqual(played.missed, []);
  });
});
