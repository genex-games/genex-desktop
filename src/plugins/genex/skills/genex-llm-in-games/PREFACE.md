# Genex models at play time in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's card on calling a
model from a running game, unchanged. Where it disagrees with this preface, this preface wins.

## In a Studio game: `genex-ai`

- Write a game's model calls with `genex-ai` (`docs/AI.md` in the game): `createAi`, `ai.ask`,
  `ai.say`, `ai.judge`, `ai.act`, answers through `ai.drain()`. Never call the SDK's `generate`,
  `generateStream`, `judge` or `requestSpendGrant` yourself: on genex.games `genex-ai` makes those
  calls (and inside Genex Desktop's Play the SDK asks the app to approve, with no popup); everywhere
  else it answers from the person's own models or a saved playtest.
- On boot, `await ai.activeBudget()`: it reuses the player's running grant (`getActiveSpendGrant()`),
  so a reload never asks again. `ai.requestBudget()` belongs in a click or key handler only.
- The bench's `--max-coins` figure is in Genex credits: pass it as the call's `maxCredits`, or as
  `createAi({ platform: { maxCredits } })` for every call.

## Commands, as Studio tools

- `npx genex llm models`, `llm status` and `llm cancel <id>`: `genex__cli`, for example
  `genex__cli {"command":"llm models","options":{"all":true}}` or
  `genex__cli {"command":"llm cancel","args":"<id>"}`.
- `npx genex llm bench "<prompt>" --samples 3 --max-coins <n>`: `genex__cli-paid`, with the
  prompt in `args` and whole-number flags in `options`:
  `{"command":"llm bench","args":"<prompt>","options":{"samples":3,"max-coins":5}}`. The user
  approves each bench because it spends their coin; Studio adds the approval flag itself, so never
  pass `user-approved`.
- The CLI runs in a folder of Studio's own, not the game, so a flag that names a game file (such as
  `--schema ./answer.schema.json`) cannot be read. `llm price` is not available.
- Project commands (`llm bench`, `llm status`, `llm cancel`) need the game's hosted project:
  publish a draft with `genex__publish {"operation":"draft"}` first. `init --convert` does not
  apply in Studio.

## Reading the reference

Read the pricing reference with
`genex__skill {"name":"genex-llm-in-games","file":"skills/genex-llm-in-games/references/pricing.md"}`.

Other commands map onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).
