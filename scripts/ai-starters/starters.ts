/**
 * The AI starters as the lanes play them: each starter's folder, its demo (create the game around an
 * `ai` object, then play it), its call sites and its schemas, read from the starter's own modules so
 * nothing here can drift from what ships.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tapeFile } from "../../src/shared/game-ai-tape.ts";
import { createWorld, WORLD_SITES } from "../../src/harness-seed/library/ai-starters/world-sim/src/world.js";
import { DEMOS as WORLD_DEMOS } from "../../src/harness-seed/library/ai-starters/world-sim/src/demo.js";
import * as worldSchemas from "../../src/harness-seed/library/ai-starters/world-sim/ai/schema.js";
import { createPond, POND_SITES } from "../../src/harness-seed/library/ai-starters/creature-gen/src/pond.js";
import { DEMOS as POND_DEMOS } from "../../src/harness-seed/library/ai-starters/creature-gen/src/demo.js";
import * as pondSchemas from "../../src/harness-seed/library/ai-starters/creature-gen/ai/schema.js";
import { ARENA_SITES, createArena } from "../../src/harness-seed/library/ai-starters/agent-arena/src/arena.js";
import { DEMOS as ARENA_DEMOS } from "../../src/harness-seed/library/ai-starters/agent-arena/src/demo.js";
import * as arenaSchemas from "../../src/harness-seed/library/ai-starters/agent-arena/ai/schema.js";
import { createNpc, NPC_SITES } from "../../src/harness-seed/library/ai-starters/npc-dialogue/src/npc.js";
import { DEMOS as NPC_DEMOS } from "../../src/harness-seed/library/ai-starters/npc-dialogue/src/demo.js";
import * as npcSchemas from "../../src/harness-seed/library/ai-starters/npc-dialogue/ai/schema.js";
import type { StarterDemo, StarterGame } from "./lanes.ts";

/** Where the starters ship in the seed. */
export const STARTERS_DIR = path.resolve(
  fileURLToPath(new URL("../../src/harness-seed/library/ai-starters", import.meta.url)),
);

/** One starter: its name (its folder), its demo, its call sites and the schemas its calls carry. */
export interface StarterSpec {
  name: string;
  demo: string;
  sites: readonly string[];
  schemas: readonly unknown[];
  play: StarterDemo;
}

/** The JSON schemas a starter's schema module exports. */
const schemasOf = (module: Record<string, unknown>): unknown[] =>
  Object.values(module).filter((value) => typeof value === "object" && value !== null && !Array.isArray(value));

/** A starter's demo as the lanes play it. */
function demoOf(
  create: (deps: { ai: never; seed: number }) => unknown,
  demos: Record<string, (game: never, step: () => Promise<void>) => Promise<unknown[]>>,
  name: string,
): StarterDemo {
  const play = demos[name];
  if (!play) throw new Error(`the starter has no demo "${name}"`);
  return {
    create: (deps) => create(deps as never) as StarterGame,
    play: (game, step) => play(game as never, step),
  };
}

/** Every starter that ships. */
export const STARTERS: readonly StarterSpec[] = [
  {
    name: "world-sim",
    demo: "turn-three",
    sites: WORLD_SITES,
    schemas: schemasOf(worldSchemas),
    play: demoOf(createWorld, WORLD_DEMOS, "turn-three"),
  },
  {
    name: "creature-gen",
    demo: "three-creatures",
    sites: POND_SITES,
    schemas: schemasOf(pondSchemas),
    play: demoOf(createPond, POND_DEMOS, "three-creatures"),
  },
  {
    name: "agent-arena",
    demo: "two-bots",
    sites: ARENA_SITES,
    schemas: schemasOf(arenaSchemas),
    play: demoOf(createArena, ARENA_DEMOS, "two-bots"),
  },
  {
    name: "npc-dialogue",
    demo: "talk-to-smith",
    sites: NPC_SITES,
    schemas: schemasOf(npcSchemas),
    play: demoOf(createNpc, NPC_DEMOS, "talk-to-smith"),
  },
];

/** A starter's tape, as a path on disk. */
export const starterTape = (starter: StarterSpec): string =>
  path.join(STARTERS_DIR, starter.name, ...tapeFile(starter.demo).split("/"));
