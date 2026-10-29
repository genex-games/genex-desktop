# npc-dialogue — a character the player talks to

**Mechanic:** the player says anything to Mira, the village smith; the model reads what they meant
(a word from a fixed list, about a topic she really knows), then answers in character and may hand
over one item she really carries. Trust rises and falls with how the player treats her. Both calls
are fast-tier, so a small model on this Mac plays it.

## Files

- `ai/character.js` — who Mira is, what she knows (by id) and what she carries.
- `ai/schema.js` — `Intent` (intent and topic from fixed lists) and `Reply` (a line, a mood, one item
  or none).
- `ai/prompts.js` — the character sheet and the prompts; what the player says, and the conversation
  that holds it, travel only in `untrusted`.
- `ai/applier.js` — unknown words become safe defaults; an item changes hands only on a fair trade,
  only if she has it and only while she trusts the player; trust moves a step at a time.
- `src/npc.js` — `createNpc({ ai, seed })`: `say(text)` (from the chat box's Enter), `update()`,
  `busy()`, `disclosure()`, `state()`.
- `src/demo.js` — the AI demo `talk-to-smith`: four things a player says.
- `ai/tapes/talk-to-smith.jsonl` — its saved playtest.

## Call sites

| site | op | tier | when |
|---|---|---|---|
| `npc.intent` | ask | fast | once per thing the player says |
| `npc.reply` | ask | fast | once per thing the player says |

## Wiring it into the game

```js
import { createAi } from "genex-ai";
import { createNpc, NPC_SITES } from "./npc.js";
import { talkToSmith } from "./demo.js";

const ai = createAi({ sites: NPC_SITES, requires: "optional" });
const npc = createNpc({ ai, seed });
chatInput.addEventListener("keydown", (event) => event.key === "Enter" && npc.say(chatInput.value));
// update(): npc.update();   HUD: hud.text(npc.disclosure().text, …) and npc.state().npc.line
// config.demos: { "talk-to-smith": () => talkToSmith(npc, step) }
```

Several characters: one `createNpc` each, with their own `character.js`. Text other players would
see (a shared village) needs `authority: "shared"`: it is moderated before anyone sees it.

## Making it yours

Write the character's sheet, facts and items, then `ai_schema_check`, play with AI off,
`ai_record demo=talk-to-smith` and `ai_replay demo=talk-to-smith`. The tape here was written by hand
for the demo as it ships; record your own once you change a prompt.
