# Genex models at play time in AI Game Studio: the first step

You are building inside AI Game Studio. Below the upstream marker is Genex's card on the play-time
model lane, unchanged. Where it disagrees with this preface, this preface wins.

- In a Studio game, write the calls with `genex-ai` (`docs/AI.md` in the game), never the SDK's
  generation functions; `ai.activeBudget()` reuses the player's running grant
  (`getActiveSpendGrant()`) before `ai.requestBudget()` asks, inside a click or key handler.
- `npx genex llm models`: `genex__cli {"command":"llm models"}`. `npx genex doctor`:
  `genex__cli {"command":"doctor"}`, or `genex__asset` with operation `status`.
- `npx genex init --convert` does not apply in Studio. A game becomes a hosted Genex game when you
  publish its first draft with `genex__publish {"operation":"draft"}` (the user approves it).
- Then read the full procedure with `genex__skill {"name":"genex-llm-in-games"}`.
- Other commands map onto Studio tools as the `genex` skill describes
  (`genex__skill {"name":"genex"}`).
