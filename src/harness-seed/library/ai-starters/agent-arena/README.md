# agent-arena — bots whose strategy the player writes in words

**Mechanic:** each player tells their bot how to fight, in plain words; the model compiles the
strategy once into a short program in a tiny closed language; a deterministic engine fights the
match tick by tick with no model at all, so the same programs always fight the same match.

## Files

- `ai/schema.js` — `BotProgram`: 1–6 rules of `when` (a fixed condition) → `act` (a fixed move)
  with a power of 1–3.
- `ai/prompts.js` — the language, and the compile prompt; the strategy travels only in `untrusted`.
- `ai/applier.js` — unknown words become safe defaults, power is clamped, extra rules dropped, a
  catch-all added; `steadyProgram` is the fallback.
- `src/arena.js` — `createArena({ ai, seed })`: `program(corner, text)` (from each corner's ready
  button), `update()`, `busy()`, `disclosure()`, `state()`. The seed only nudges where bots start.
- `src/demo.js` — the AI demo `two-bots`: both corners programmed, then the match played out.
- `ai/tapes/two-bots.jsonl` — its saved playtest.

## Call sites

| site | op | tier | when |
|---|---|---|---|
| `bot.compile` | ask | fast | once per bot, before the match |

## Wiring it into the game

```js
import { createAi } from "genex-ai";
import { ARENA_SITES, createArena } from "./arena.js";
import { twoBots } from "./demo.js";

const ai = createAi({ sites: ARENA_SITES, requires: "optional" });
const arena = createArena({ ai, seed });
westReady.addEventListener("click", () => arena.program("west", westInput.value));
eastReady.addEventListener("click", () => arena.program("east", eastInput.value));
// update(): arena.update();   HUD: hud.text(arena.disclosure().text, …)
// config.demos: { "two-bots": () => twoBots(arena, step) }
```

For a leaderboard, compile with `authority: "shared"` so every player's bot is compiled on the same
model (Genex credits), and rank only matches whose programs came back verified.

## Making it yours

Add conditions and moves to the language (and the engine), then `ai_schema_check`, play with AI off,
`ai_record demo=two-bots` and `ai_replay demo=two-bots`. The tape here was written by hand for the
demo as it ships; record your own once you change a prompt.
