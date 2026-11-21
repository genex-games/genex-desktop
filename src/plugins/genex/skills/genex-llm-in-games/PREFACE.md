# Genex models at play time in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's card on calling a
model from a running game, with the passages of advice Studio does not ship taken out. Where it
disagrees with this preface, this preface wins.

## Commands, as Studio tools

- `npx genex llm models`, `llm status` and `llm cancel <id>`: `genex__cli`, for example
  `genex__cli {"command":"llm models","options":{"all":true}}` or
  `genex__cli {"command":"llm cancel","args":"<id>"}`.
- `npx genex llm bench "<prompt>" --schema ./answer.schema.json --samples 3 --max-credits <n>`:
  `genex__cli-paid`, with the prompt in `args` and the flags in `options`:
  `{"command":"llm bench","args":"<prompt>","options":{"schema":"answer.schema.json","samples":3,"max-credits":5}}`.
  The user approves each bench because it spends their own Genex credits (1 credit is 1 cent),
  never Nex: `max-credits` is the most one attempt may spend, and the card shows it. Studio adds
  the approval flag itself, so never pass `user-approved`. `max-coins`, the flag's old name, is read
  as `max-credits`.
- `schema` names the game's answer-shape file: one `.json` file inside this game, by its path
  relative to the game's folder, of at most 16 KB. The CLI runs in a folder of Studio's own, not
  the game, so Studio checks the file and hands the CLI a copy. No other flag reads a game file.
- The bench's answer is JSON. `recommendedMaxCredits` is the card's `Declare maxCredits`,
  `recommendedPerCallMaxCredits` its `Grant perCallMaxCredits`, `averageCreditsPerCall` its
  `Per-call estimate` and `recommendedPerCallEstimateCredits` its `Grant perCallEstimateCredits`.
- `llm price` is not available: it reprints a file the CLI leaves in the folder it ran in, and
  Studio removes that folder after every command. Write the bench's numbers into the game when you
  read them, and bench again only when the prompt, the schema or the model changed.
- Project commands (`llm bench`, `llm status`, `llm cancel`) need the game's hosted project:
  publish a draft with `genex__publish {"operation":"draft"}` first. `init --convert` does not
  apply in Studio.

## The model calls ship on

- A game that calls a model ships with the calls enabled. No switch, flag or setting leaves them
  off by default; the written lines are what the game plays when a call cannot answer.
- The bench is not a gate. Until a bench has run for a prompt, the ceilings are provisional:
  a call starts at `maxCredits` 4, and on a budget `perCallMaxCredits` 16 and `perCallEstimateCredits` 1
  (so a period's credits are its calls × 1). Each sits in a named constant whose comment says it is
  provisional, until `llm bench` measures it. This replaces the card's rule that only a benched
  figure is declared. When a bench runs, its figures replace the provisional ones.
- A ceiling also bounds how long an answer may be, so a provisional one needs short answers: the
  prompt states the answer's length, every string in the schema has a `maxLength`, and the call
  passes `maxOutputTokens`. Each ceiling is one named constant, so one edit raises it.
- A call that ends `provider_token_limit` was cut off because its ceiling is too low for that model:
  the game plays the written line with its label, and the next call of that prompt declares twice
  the `maxCredits`, up to the budget's `perCallMaxCredits` (16), for the rest of the session. That is
  why the provisional budget allows 16 a call while a call starts at 4. A bench settles the figures.
- Ask for the bench once. When its `genex__cli-paid` card is not approved, declined or left
  unanswered, ask no more and keep the feature on with the provisional ceilings; the final message
  says the ceilings are provisional and that a bench would replace them.

## Where the model answers

- Studio's preview runs a game that calls a model beside Genex's practice helper: every call there
  (`requestSpendGrant`, `generate`, `generateStream`, `judge`, `getGenerationModels`) answers at
  once, free and made up, with `source: 'practice'`, and a budget is approved by the helper. Your own
  preview windows get these answers too, so you can watch the feature work. A practice answer is a
  real answer for wiring: the game shows it, streams it and applies it exactly as a model's, and
  never treats `source: 'practice'` as a refusal or a reason to play the written lines. Do not judge
  the writing of a practice answer: it proves the wiring, not the model.
- In Live, the person can press Use real AI and approve a credit cap: real models then answer in
  the preview, billed to the game's published draft from their own credits. Only they can switch it;
  your windows always get practice answers. Real models need the game's draft, from
  `genex__publish {"operation":"draft"}`, which the person approves.
- On genex.games the published draft calls the real model for its owner, signed in (anyone else gets
  `player_wallet_required` on a test build).
- The final message for a game that calls a model says in one line that Live answers with practice
  answers until the person presses Use real AI there (which needs a published draft and spends their
  credits up to the cap they choose), and that the draft on genex.games uses the real model; give
  the draft's link when there is one.

## When the written lines play, the game says so

Whenever the game plays its written lines instead of a model (the Genex app's `native_unsupported`,
a guest, a declined or ended budget, a refusal, `local_test_unsupported` where no helper answers),
it shows a small visible label saying so and why, for example "Written lines: no AI budget". Never
an error, and never a silent swap that reads as a broken AI. A practice answer is not a fallback and
gets no such label.

## A game that listens

- A game that hears the player (speech recognition, `getUserMedia({ audio })`, voice chat)
  declares the microphone for its Genex page in its `package.json`:
  `"genex": { "capabilities": ["microphone"] }`. An undeclared build is refused the microphone on
  its Genex page without the player being asked. A draft or gallery publish prints what the build is
  given (`On its Genex page this build is given: microphone.`); the rules are in
  `genex__skill {"name":"genex-threejs-embed-auth","file":"skills/genex-threejs-embed-auth/references/shells.md"}`.
- Studio's Live preview grants the microphone to a game that declares it, once the person allows it
  in Live's bar (`getUserMedia({ audio: true })` then works; video never does). Your own preview
  windows never get it, and the Genex app never grants it. Browser speech recognition
  (`SpeechRecognition`, `webkitSpeechRecognition`) exists in Chrome, Edge and Safari, not Firefox; in
  Studio's preview the object exists but does not recognise speech (it needs Google's speech service,
  which Studio's browser does not have), so build listening on the microphone's audio, or on
  recognition with a fallback. A game that listens always also takes typed input, shown whenever
  recognition or the microphone is missing or refused.

## Not in Studio yet

These parts of Genex CLI 1.44.0 are left out of the card below because Studio cannot run them yet:

- `llm bench` takes no `system` or `messages` option here. Put the system text and a typical
  history into the bench prompt itself, so the measured size is the real call's.
- Practice mode (`llm practice`), creator-paid budgets (`llm sponsor`, `sponsored: true`) and
  `llm usage` are commands Studio does not run. `features.sponsor` may read true on a stand; a game
  made here still asks the player for the budget.
- Model calls from a multiplayer server room (`shareWithRooms`, `lendSpendGrantToRoom`,
  `ctx.models`) are not built here. `features.roomCalls` may read true on a stand; a game made here
  calls the model from the player's page.
- Unity, Godot, Rust and Unreal games have no model-call binding in Studio.

`system`, `messages`, the controls and `features` work: Studio ships the SDK that has them.

## Reading the reference

Read the pricing reference with
`genex__skill {"name":"genex-llm-in-games","file":"skills/genex-llm-in-games/references/pricing.md"}`.

Genex's optional advice on designing the feature (the system instruction and turns, state as
data, legal moves, memory, several characters in one call, rules a character writes, hostile
player text) is `play-time-models` in the `genex-recommendations` plugin.

Other commands map onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).
