/**
 * Two bots whose strategies players write in plain words: the model compiles each strategy ONCE into
 * a small rule program, and a deterministic engine fights the match tick by tick with no model at
 * all. Engine-free: the game draws `state()`.
 *
 *   const ai = createAi({ sites: ARENA_SITES, requires: "optional" });
 *   const arena = createArena({ ai, seed });
 *   readyButton.onclick = () => arena.program("west", input.value); // a gesture
 *   // in update(): arena.update(); in the HUD: hud.text(arena.disclosure().text)
 */
import { BotProgram } from "../ai/schema.js";
import { compilePrompt, compilerBible } from "../ai/prompts.js";
import { applyProgram, steadyProgram } from "../ai/applier.js";

export const ARENA_SITES = ["bot.compile"];
export const CORNERS = ["west", "east"];
const MATCH_TICKS = 400;
const ARENA_LENGTH = 30;
const NEAR = 3;
const HURT = 40;
const MAX_STRATEGY_CHARS = 280;

/** A seeded random source (mulberry32). */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether a rule's condition holds for `bot` facing `foe`. */
function holds(when, bot, foe) {
  const gap = Math.abs(bot.x - foe.x);
  const tests = {
    "enemy-near": gap <= NEAR,
    "enemy-far": gap > NEAR,
    hurt: bot.hp < HURT,
    healthy: bot.hp >= HURT,
    always: true,
  };
  return tests[when] === true;
}

/** One move of one bot this tick. */
function move(bot, foe, rule) {
  const toward = Math.sign(foe.x - bot.x) || 1;
  const moves = {
    advance: () => {
      bot.x += toward * 0.5 * rule.power;
    },
    retreat: () => {
      bot.x -= toward * 0.5 * rule.power;
    },
    strike: () => {
      if (Math.abs(bot.x - foe.x) <= NEAR && !foe.guarding) foe.hp = Math.max(0, foe.hp - 3 * rule.power);
    },
    guard: () => {
      bot.guarding = true;
    },
    circle: () => {
      bot.x += toward * 0.2;
    },
  };
  moves[rule.act]?.();
  bot.x = Math.min(ARENA_LENGTH, Math.max(0, bot.x));
}

/** One tick of the match: each bot runs the first rule that holds. */
function tick(bots) {
  for (const bot of bots) bot.guarding = false;
  const [west, east] = bots;
  for (const [bot, foe] of [
    [west, east],
    [east, west],
  ]) {
    const rule = bot.program.rules.find((candidate) => holds(candidate.when, bot, foe));
    if (rule) move(bot, foe, rule);
  }
}

/** The arena, its bots programmed by the model through `ai` (genex-ai's createAi). */
export function createArena({ ai, seed = 1 }) {
  const random = seeded(seed);
  const bots = new Map();
  const compiling = new Set();
  /** Which corner each compile call is for, by its ticket. */
  const tickets = new Map();
  let ticks = 0;
  let asked = false;
  let disclosed = false;

  /** A program (or its fallback) made legal and put in its corner. */
  function onCompiled(result, corner) {
    compiling.delete(corner);
    const program = applyProgram(result.value ?? steadyProgram(corner), corner);
    const start = corner === "west" ? 2 + random() : ARENA_LENGTH - 2 - random();
    bots.set(corner, { corner, program, x: start, hp: 100, guarding: false });
  }

  const ready = () => CORNERS.every((corner) => bots.has(corner));
  const over = () => ticks >= MATCH_TICKS || [...bots.values()].some((bot) => bot.hp <= 0);

  return {
    /** From a corner's ready button (a gesture): that bot's strategy, in the player's words. */
    async program(corner, strategy) {
      if (!CORNERS.includes(corner) || compiling.has(corner) || bots.has(corner)) return false;
      compiling.add(corner);
      if (!asked) {
        asked = true;
        await ai.requestBudget();
      }
      const ticket = ai.ask({
        site: "bot.compile",
        system: compilerBible(),
        prompt: compilePrompt(corner),
        untrusted: { strategy: String(strategy ?? "").slice(0, MAX_STRATEGY_CHARS) },
        schema: BotProgram,
        tier: "fast",
        maxOutputTokens: 300,
        fallback: () => steadyProgram(corner),
      });
      tickets.set(ticket, corner);
      return true;
    },
    /** Once per frame: programs land, then — both bots ready — the engine fights one tick. */
    update() {
      for (const result of ai.drain()) {
        const corner = tickets.get(result.ticket);
        tickets.delete(result.ticket);
        if (result.site === "bot.compile" && corner) onCompiled(result, corner);
      }
      if (!ready() || over()) return;
      tick([bots.get("west"), bots.get("east")]);
      ticks += 1;
    },
    busy: () => compiling.size > 0 || ai.status().pending > 0 || (ready() && !over()),
    disclosure() {
      disclosed = true;
      return ai.disclosure();
    },
    state: () => {
      const all = [...bots.values()];
      const standing = all.filter((bot) => bot.hp > 0);
      const winner = over() && standing.length === 1 ? standing[0].corner : null;
      return {
        tick: ticks,
        bots: all.map(({ corner, program, x, hp }) => ({
          corner,
          name: program.name,
          rules: program.rules.length,
          x: Math.round(x * 100) / 100,
          hp,
        })),
        winner,
        ai: { pending: ai.status().pending, disclosed },
      };
    },
  };
}
