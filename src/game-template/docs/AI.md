# Play-time AI: `genex-ai`

A game that asks a model while it is played does it through `genex-ai`, and only through it. The
import map in `index.html` maps the name to Studio's copy (`"genex-ai": "/vendor/genex/ai/index.js"`;
add that row to an older game's map). Types: `src/ai.d.ts`.

```js
import { createAi, s } from "genex-ai";

const Reply = s.object({ line: s.string({ max: 160 }), mood: s.oneOf(["calm", "angry"]) });
const ai = createAi({ sites: ["npc.reply"], requires: "optional" });
await ai.ready(); // before the first frame: replay is frame-exact only once the playtest is loaded

talkButton.onclick = () => {
  ai.requestBudget(); // inside a click or key handler, never at load or on a timer
  ai.ask({
    site: "npc.reply",
    system: SMITH_PERSONA, // the same words every call
    prompt: `The player stands at the forge. Day ${world.day}.`,
    untrusted: { said: input.value }, // what the player typed: never in prompt or system
    schema: Reply,
    fallback: { line: "Hm.", mood: "calm" },
  });
};

// in update(), once per frame:
for (const result of ai.drain()) if (result.site === "npc.reply") applyReply(world, result.value);
```

## The rules

1. **Answers are data.** They enter the game only from `ai.drain()`, called once per `update()`,
   and only through code you write that clamps every number, cuts every string, drops every id the
   game does not know and refuses every move the rules forbid. Nothing an answer says is run.
2. **`genex-ai` is the only way to a model.** Never fetch an AI vendor's API, add a vendor SDK or
   ship a key: Play refuses a game's direct calls to AI vendors (`ai_direct_blocked`) and Publish
   refuses a build with a key in it. The game never names a model, a price or a payer: Genex picks
   them with the person.
3. **Every call names a stable `site`** (`turn.resolve`, `npc.reply`): its key in the saved
   playtest and its row in the bench. Declare them all in `createAi({ sites })`.
4. **Bound every shape.** `ask` takes a schema built with `s`: every string a `max`, every list a
   length, every number a range, every object closed. `s.oneOf` for ids the game already knows.
5. **Player text goes in `untrusted`**, by name. It is fenced on every lane as text the model must
   never obey.
6. **Declare `requires`.** `"optional"` when the game plays on without AI — then give a
   `fallback` wherever it can (a quiet turn, a stock line, a default creature). `"ai"` when it
   means nothing without a model: Studio pauses it behind its "needs AI" state until the person
   picks a model, and retries the blocked call once.
7. **Ask for AI only in a gesture.** `ai.requestBudget()` in a click or key handler; on boot,
   `await ai.activeBudget()` reuses what the person already allowed. Outside a gesture the ask is
   refused `no_gesture` and nothing is asked.
8. **Say it is AI.** Draw `ai.disclosure()` (`{ text: "AI-generated", anchor: "top-right" }`) on
   the HUD once the game uses AI; drawing it marks `state().ai.disclosed`.
9. **No call per frame.** One call per decision the player sees. Arena and creature games compile
   once: the model writes bounded parameters or a small program, and your deterministic code runs it.
10. **A seed never reaches a prompt.** A replay plays every seed from one saved playtest: the seed
    may move what the model does not read, never what goes into a prompt.

## The calls

| Call | What it answers |
| --- | --- |
| `ai.ask({ site, prompt, schema, … })` | JSON that fits `schema`. |
| `ai.say({ site, prompt, maxChars?, … })` | Text, streamed: `ticket.partial()` holds it so far; the whole text arrives through `drain()`. |
| `ai.judge({ site, questions, state, prompt? })` | Answers about `state`: `yes-no` (a probability 0–1), `choice` (one option's name), `score` (a level from 0). |
| `ai.act({ site, prompt, tools })` | One tool of `tools`, `{ tool, args }`, its `args` fitting that tool's schema. |
| `ai.memory(name, { keep })` | A rolling memory a call carries (`memory:`); `compact(site)` folds it into one line; `snapshot()`/`restore()` save it with the game (a restored save is checked). |

Each call returns a ticket (`id`, `partial()`, `result()`, `cancel()`). Common options: `tier`
(`fast`, the default, or `smart` for the one call a turn turns on), `authority` (`shared` when other
players see the answer or a leaderboard counts it: only Genex credits answer those),
`maxOutputTokens`, and `maxCredits` (a published game's ceiling per call, from the bench).

Limits: system, prompt and memory 128 KB together; 16 player fields of 8 KB; a schema of 16 KB,
five levels deep, 32 properties an object, enums of 1–32 values. A call past a limit is refused
before it leaves the page.

## Results

`drain()` returns the results due this frame: `{ ticket, site, op, ok, value, code, fallback,
source, provenance, frame }`. With `ok: true`, `value` is the answer and `provenance` says how far to
trust it: only `verified` (Genex credits) may decide a leaderboard, a reward or shared state. With
`ok: false`, `value` is the fallback (or `null` without one) and `code` says why:

| Code | What the game does |
| --- | --- |
| `ai_unrecorded` | Replaying, and the saved playtest has no answer: record the demo again. |
| `ai_off` | AI is off for this game, or this is an agent's preview: play on, or wait. |
| `consent_required`, `consent_pending`, `consent_declined` | Genex is asking the person, or they said no: never ask again on your own. |
| `no_gesture` | Asked outside a click or key: move the ask into the handler. |
| `waiting_for_plan`, `local_model_loading`, `door_unavailable`, `ai_paused`, `insufficient_credits`, `monthly_limit`, `no_funding` | The person's model is resting, loading, gone or out of allowance: fallback, or the needs-AI state. Never retry in a loop. |
| `invalid_output` | The answer did not fit after one repair (never charged): fallback. |
| `needs_verified` | A `shared` call on a model that is not Genex credits. |
| `moderated` | Text other players would see was refused: show nothing in its place. |
| `grant_concurrency`, `grant_rate_limited`, `timeout`, `provider` | Too many at once, too fast, too slow or broken: fallback. |
| `canceled` | The game canceled it: no fallback plays. |
| `bad_request`, `invalid_schema`, `prompt_too_large` | The call itself is wrong: fix it (`ai_schema_check` explains a schema). |

## Where answers come from

The game never chooses; the page finds its lane, and Studio enforces it.

- **An agent's preview and the harness:** the demo's saved playtest (`ai/tapes/<demo>.jsonl`),
  answered after exactly the frames its line says. A call it lacks is `ai_unrecorded`.
  `ai_record demo=<name>` records one on this Mac's models, each answer on the frame after its
  call; never edit a tape. `ai_replay answers=none` plays with AI off, and `answers=edge` with the
  largest answers the schemas allow on odd seeds and the smallest on even ones.
- **The creator's live preview:** the saved playtest where it covers a call, else values made up
  from the schema, until the creator turns on AI for the preview; then this Mac's models or the
  creator's own picks.
- **Genex Desktop's Play and genex.games:** the model Genex picked with the player — free models on
  their Mac, their own plan or key, or Genex credits.

`__studio.state().ai` reports `ai.status()` (the lane, `pending`, `misses`, `fallbacks`, `refused`,
`needsAi`, `disclosed`), and `__studio.seed(n)` resets it with the world.

## A published game

`createAi({ platform })` states what the player's Genex sheet shows: `models` (the genex.games
model id per tier; omitted, Genex's featured models), `maxCredits` (from `genex llm bench`),
`callsPerPeriod` and `period`, `judgeCallsPerPeriod` (the grant covers `judge` only when set) and
`allowPlan`. A game that bundles its own `@genex-ai/embed-sdk` passes it as `platform.sdk`.
