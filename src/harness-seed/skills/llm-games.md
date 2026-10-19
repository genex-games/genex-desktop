---
name: Games with play-time AI
description: How to build a game that calls a model while it is played — genex-ai only, answers as data through a clamping applier, a fallback or the needs-AI state, a recorded playtest per AI demo, and the checks that hold it.
facts: web-game
---

# Play-time AI: a model as a game element

Use this when the game itself calls a model while a person plays it: a world that answers the
player's orders, a creature designed from the player's words, bots whose strategy a player writes in
plain language, a character who talks back. Say so in the plan with `ai`: `ai` when the game cannot
run without a model, `optional` when it plays on without one. That word, and nothing a sentence says,
is what puts the AI checks on the board and this method in every builder's `.studio/AI.md`.

## The laws

1. **The model proposes, the game disposes.** An answer is data. It enters the game only through
   `ai.drain()`, once per `update()`, and only through an applier you write: clamp every number,
   cut every string, drop every id the game does not know, refuse every move the rules forbid. No
   answer is ever evaluated as code.
2. **`genex-ai` is the only way to a model.** Never fetch an AI vendor's API, never ship a key,
   never add a vendor SDK. Genex picks the model and the payer on its own trusted surfaces; the game
   only declares what it needs.
3. **Every call names a stable `site`** (`turn.resolve`, `npc.reply`): it is the call's key in the
   saved playtest and its row in the bench. `ask`, `judge` and `act` carry a **bounded schema**
   (every string has `max`, every list a length, every number a range). Text the player typed goes
   **only in `untrusted`**, never into `prompt` or `system`. Pick a `tier`: `fast` for small calls,
   `smart` for the one call a turn turns on.
4. **Declare `requires`** in `createAi({ sites, requires })`: `"optional"` and give a fallback
   wherever the game can go on without the answer (a quiet turn, a stock line, a default creature);
   `"ai"` when it cannot, and Studio pauses it behind the trusted "needs AI" state until the person
   picks a model. A failure always reaches the game as a result with `ok: false` — read it.
5. **Ask for AI only in a gesture.** `ai.requestBudget()` belongs in a click or key handler, never
   at load or on a timer. On boot, `await ai.activeBudget()` reuses what the person already allowed.
6. **Say it is AI.** Draw `ai.disclosure()` on the HUD once the game uses AI, and copy
   `ai.status()` into `state().ai` with `disclosed: true` once the chip is drawn.
7. **No call per frame.** One call per decision the player sees. An arena or a creature is
   compiled at creation — the model writes bounded parameters or a small program, and a
   deterministic engine runs them.
8. **Leaderboards and shared text need `authority: "shared"`.** Only Genex credits answer those,
   so every player gets the same model; any other answer is the player's own and never decides a
   score other players see.
9. **Keep a demo's AI calls independent of the seed.** A replay plays every seed from one saved
   playtest: the seed may move what the model does not read (where a creature wanders, which tile
   sparkles), never what goes into a prompt.

## The procedure, in order

1. **Write the mechanic sentence:** what the model decides, and what the player does with it within
   ten seconds. If nobody acts on the answer, it is decoration — cut it.
2. **Pick a starter** (they are in `.studio/ai-starters/` beside this file; in the harness
   workspace, `library/ai-starters/`). Each is a pure core with its schemas, prompts, applier,
   demo and recorded playtest, wired to the game through one `ai` object:
   - `world-sim` — nations react to the player's orders each turn; a narrator line; slow drift.
   - `creature-gen` — a creature designed from the player's words into bounded body parameters a
     deterministic sim runs.
   - `agent-arena` — a strategy in plain words compiled once into a small rule program; the match
     is a deterministic engine, no model per tick.
   - `npc-dialogue` — a character reads the player's intent, answers in a line, and may hand over
     one item it really has.
3. **Check every schema** with `ai_schema_check` before it goes in the game.
4. **Write the applier** first, and its unit check: feed it the largest and smallest values the
   schema allows and confirm the game stays legal.
5. **Decide `requires`**, write the fallbacks where they make sense, then play with AI off:
   `ai_replay demo=<name> answers=none`. Every demo must end — no crash, no console error, no call
   left waiting.
6. **Add the AI demo** to `config.demos`: a short scripted play that reaches every AI site once.
7. **Record it**: `ai_record demo=<name>`. This Mac's models answer, for free, under a call cap the
   studio sets; the playtest lands in `ai/tapes/<name>.jsonl`. Record again after changing a prompt,
   a schema or a site — never edit a tape by hand.
8. **Replay it** under three seeds: `ai_replay demo=<name>` (seeds 1,2,3), then
   `answers=edge` for the worst answers the schemas allow. Same frames on every seed, no miss.
9. **Bench each site**: `ai_bench site=<site>` — how often a local model fits the shape, and how
   long it takes. The paid bench and the model check on the creator's own plan or key run from
   Create; Genex never pays for them.

## The checks on the board

The entry owner's board carries these; the first two decide whether the work is done.

- `ai-handles-no-answer` — with AI off every demo ends cleanly (fallback, or the needs-AI state).
- `ai-no-direct-model-calls` — no vendor host, no vendor key anywhere in the build.
- `ai-replay-deterministic` — the same frames on every seed from the tape.
- `ai-tape-covers-demos` — the tape answers every call the demos make.
- `ai-output-clamped` — the largest and smallest answers the schemas allow break nothing.
- `ai-disclosure-shown` — `state().ai.disclosed` is true once the chip is drawn.
- `ai-budget-in-gesture` — no AI asked for outside a click or key handler.

## What a failed call means

A result with `ok: false` carries a `code`. The game never shows the code; it plays its fallback or
lets Studio's "needs AI" state speak.

- `ai_unrecorded` — replaying, and the tape has no answer: record the demo again.
- `ai_off` — the person turned AI off, or this is an agent's preview: play on, or wait.
- `consent_required`, `consent_pending`, `consent_declined` — Genex is asking the person, or they
  said no: never ask again on your own; the person turns it on from the AI pill.
- `no_gesture` — asked outside a click or key: move the ask into the handler.
- `waiting_for_plan`, `local_model_loading`, `door_unavailable`, `ai_paused`,
  `insufficient_credits`, `monthly_limit` — the person's model is resting, loading, gone or out of
  allowance: fallback, or the needs-AI state; never retry in a loop.
- `invalid_output` — the model's answer did not fit after one repair (it is never charged):
  fallback.
- `needs_verified` — a shared or leaderboard call on a model that is not Genex credits.
- `moderated` — text other players would see was refused: show nothing in its place.
