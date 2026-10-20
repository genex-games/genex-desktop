# creature-gen — creatures designed from the player's words

**Mechanic:** the player describes a creature; the model turns the description into a handful of
bounded body parameters, once; a deterministic sim then runs every creature each frame with no model
at all. The player watches what their words became and describes the next one.

## Files

- `ai/schema.js` — `CreatureDesign` (body, legs, size, speed, diet, palette, temper — all ranged or
  from fixed lists) and `FieldNote`.
- `ai/prompts.js` — the designer's bible and the prompts; the description travels only in `untrusted`.
- `ai/applier.js` — clamps every parameter and lets the physics decide: no legs means a crawl, a big
  body is slow; `plainCreature` is the fallback.
- `src/pond.js` — `createPond({ ai, seed })`: `describe(text)` (from a click or key handler),
  `update()`, `busy()`, `disclosure()`, `state()`. The seed only moves where creatures wander.
- `src/demo.js` — the AI demo `three-creatures`.
- `ai/tapes/three-creatures.jsonl` — its saved playtest.

## Call sites

| site | op | tier | when |
|---|---|---|---|
| `creature.design` | ask | fast | once per description |
| `creature.note` | ask | fast | once per creature, for its field-guide card |

## Wiring it into the game

```js
import { createAi } from "genex-ai";
import { createPond, POND_SITES } from "./pond.js";
import { threeCreatures } from "./demo.js";

const ai = createAi({ sites: POND_SITES, requires: "optional" });
const pond = createPond({ ai, seed });
createButton.addEventListener("click", () => pond.describe(descriptionInput.value));
// update(): pond.update();   HUD: hud.text(pond.disclosure().text, …)
// config.demos: { "three-creatures": () => threeCreatures(pond, step) }
```

Draw each creature from its parameters (a body shape, its legs, its palette) — the model never
writes a mesh or code.

## Making it yours

Add body plans or diets to the lists, give the sim more to do with them, then `ai_schema_check`,
play with AI off, `ai_record demo=three-creatures` and `ai_replay demo=three-creatures`. The tape
here was written by hand for the demo as it ships; record your own once you change a prompt.
