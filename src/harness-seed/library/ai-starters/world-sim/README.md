# world-sim — a world that answers the player's orders

**Mechanic:** each turn the player gives an order in their own words; the model decides how six
nations react, and the referee (`ai/applier.js`) applies only what the rules allow. The player reads
the headline and the court's dispatch and gives the next order — the model proposes, the engine
disposes.

## Files

- `ai/schema.js` — `TurnDelta` (up to 8 reactions, every number ranged), `Dispatch`, `MinorDrift`.
- `ai/prompts.js` — the world's bible (`system`, the same every call) and each turn's prompt. The
  player's order travels only in `untrusted`.
- `ai/applier.js` — clamps stances and troop moves, drops unknown ids and wars between nations with
  no border, conserves troops, cleans every line; `quietTurn` is the fallback.
- `ai/nations.js` — the six nations and their borders.
- `src/world.js` — `createWorld({ ai, seed })`: `submitOrder(text)` (call it from a click or key
  handler), `update()` (once per frame), `busy()`, `disclosure()`, `state()`.
- `src/demo.js` — the AI demo `turn-three`: three orders, each played until its turn settles.
- `ai/tapes/turn-three.jsonl` — its saved playtest.

## Call sites

| site | op | tier | when |
|---|---|---|---|
| `turn.resolve` | ask | smart | once per order |
| `turn.dispatch` | ask | fast | after each turn |
| `minor.drift` | ask | fast | every third turn |

About three calls a turn; none per frame.

## Wiring it into the game

```js
import { createAi } from "genex-ai";
import { createWorld, WORLD_SITES } from "./world.js";
import { turnThree } from "./demo.js";

const ai = createAi({ sites: WORLD_SITES, requires: "optional" });
const world = createWorld({ ai, seed });
ordersButton.addEventListener("click", () => world.submitOrder(orderInput.value));
// update(): world.update();   HUD: hud.text(world.disclosure().text, …)
// state(): ({ world: world.state(), ai: world.state().ai })
// config.demos: { "turn-three": () => turnThree(world, step) }
```

`requires: "optional"` because the world turns quietly without AI. Make it `"ai"` only if the game
means nothing without the model.

## Making it yours

Rename the nations, change the bible and the actions, then `ai_schema_check` the schemas, play with
AI off (`ai_replay demo=turn-three answers=none`), record again (`ai_record demo=turn-three`) and
replay (`ai_replay demo=turn-three`). The tape here was written by hand for the demo as it ships
(`source: "fixture"`); once you change a prompt it no longer matches — record your own.
