# Genex models at play time in AI Game Studio: the first step

You are building inside AI Game Studio. Below the upstream marker is Genex's card on the play-time
model lane, with the passages of advice Studio does not ship taken out. Where it disagrees with
this preface, this preface wins.

- `npx genex llm models`: `genex__cli {"command":"llm models"}`. `npx genex doctor`:
  `genex__cli {"command":"doctor"}`, or `genex__asset` with operation `status`.
- Only a game hosted on Genex can call a model. In Studio a game becomes one when you publish its
  first draft with `genex__publish {"operation":"draft"}` (the user approves it); Genex's own
  `npx genex init --convert` does not apply here, and the card's steps below leave it out.
- Then read the full procedure with `genex__skill {"name":"genex-llm-in-games"}`. Its preface says
  how a game made here ships with the calls on (provisional ceilings until a bench runs), and that
  Studio's preview answers every call with practice answers (`source: 'practice'`, made up, free),
  which the person can switch to real models in Live. The game labels its written lines whenever
  they play instead.
- Other commands map onto Studio tools as the `genex` skill describes
  (`genex__skill {"name":"genex"}`).
