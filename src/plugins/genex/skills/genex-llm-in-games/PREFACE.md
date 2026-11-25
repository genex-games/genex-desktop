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
- `npx genex llm budget`, for a native game (Unreal) only: `genex__cli {"command":"llm budget","args":"status"}`
  reads what the game declares; `genex__cli-paid {"command":"llm budget","args":"set"}` sends the
  game's declaration and `"args":"clear"` withdraws it. `set` and `clear` spend nothing; the person
  approves them because they change what the published game's page offers its players. The
  declaration is read from the game's folder (Studio hands the CLI a copy): `"modelBudget"` in
  `genex.json` at the game's root, or `"genex": { "modelBudget": … }` in its `package.json`. When
  the tool answers that this version of Genex cannot declare a budget yet, say so to the person and
  go on: nothing needs declaring for the game to answer in the Unreal editor (see An Unreal game).
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
  the preview, billed to the game's project on Genex from their own credits. Only they can switch
  it; your windows always get practice answers. A game that is not on Genex yet is added to their
  account by that press, as a private draft with none of its files sent: never publish a draft so
  that real models can answer.
- In Live, the person can press Use my plan instead: an AI plan of their own that Genex is signed
  in to on this computer (Claude Code, Codex) then answers the game's calls there, with no Genex
  credits spent. Only they can switch it. Its answers are slower, the models are that plan's own,
  and voices and the judge stay practice.
- On genex.games the published draft calls the real model for its owner, signed in (anyone else gets
  `player_wallet_required` on a test build).
- The final message for a game that calls a model says in one line that Live answers with practice
  answers until the person presses Use my plan (their own AI plan, no credits) or Use real AI there
  (which spends their credits up to the cap they choose), and that a draft on genex.games uses the
  real model; give the draft's link when there is one.

## An Unreal game

- The calls come with Genex's Unreal plugin: `unreal__multiplayer` adds it to the project, and the
  game calls `UGenexModelsSubsystem` (a game-instance subsystem; Blueprint category Genex|Models).
  Each call takes its options as JSON text and answers a request id; its end arrives on
  `OnSettled(Request, Call, ResultJson)`, or on `OnRejected` for a read or `Init` that failed.
- The order, in every Unreal game: `Init`, then `RequestSpendGrant` with
  `{"models":["<id>"],"perCallMaxCredits":<n>,"disclosure":{"periodLabel":"session","estimatedCallsPerPeriod":<n>,"estimatedCreditsPerPeriod":<n>}}`,
  then, once it settles `status` `active`, `Generate` with that result's `grantId`
  (`{"grantId":"…","modelId":"<id>","prompt":"…","outputFormat":"text","maxCredits":<n>}`). Always
  ask with `RequestSpendGrant`: it is the one call that works both while the game is made and once
  it is published. Never write `GetActiveSpendGrant` alone, and never leave out `disclosure`: a
  request without it is refused `invalid_request`. `GenerateStream` hands its text over whole.
- While the game is being made, a play in the Unreal editor answers. Genex runs its practice
  helper for the game and the plugin sends that play's calls to it: `RequestSpendGrant` is approved
  at once and every call answers, free and made up, marked `[practice]`, exactly as in a web
  game's preview. This holds for your own play-testing (the computer tool plays in the editor's
  play session) and for the person's Play button in Unreal. It needs no page on genex.games, no
  declared budget, no publish and no credits. Check the feature this way, and only this way.
- The person chooses what answers there, in the bar above the game's Unreal card in Live: practice
  answers, **Use my plan** (their own Claude Code or Codex plan, no credits) or **Use real AI**
  (their credits, up to a cap they choose). Only they can switch it, and a change applies from the
  next Play in Unreal. Under their plan, the plan's own model answers whatever `modelId` the game
  names.
- Two conditions for the helper, both yours to keep: the game is the one open in Genex (the helper
  follows the game the window shows), and the game's own code or a Blueprint names
  `GenexModelsSubsystem` (Genex looks every few seconds, so a first call you have just written and
  compiled is found before your next play). If a play in the editor still ends
  `budget_not_approved`, the helper was not there: say so, and do not work around it.
- The packaged app is the published game. Started by Genex's Play, by a player or by you, it asks
  genex.games, where a budget exists only after the game is published with a declared budget
  (`llm budget set`, above) and a player approved it on the game's page in the Genex app before
  Play. `budget_not_approved` there is the correct answer for a game nobody approved a budget for,
  and a one-time call is `native_unsupported`: the game plays its written lines with its label.
  Never test the AI through the packaged app while the game is being made, and never report that
  answer as a broken feature.
- The final message for an Unreal game that calls a model says in one line that a Play in the
  Unreal editor answers with practice answers until the person presses Use my plan or Use real AI
  above the game in Live, and that the published game needs its budget declared and each player's
  approval on its Genex page.

## Never a provider's key

A game made here reaches a model through Genex, and nothing else. Never put a model provider's key
(OpenAI, Google Gemini, Anthropic, OpenRouter or any other) in the game: not in a `.env`, a config
file, the code, a Blueprint or a build setting. Never call a provider from the game, and never
suggest either to the person, whatever stands in the way. A shipped game hands whatever it holds
to every player, so a key in it is a key given away, billed to the person. When Genex cannot
answer yet (no budget, a command this version lacks, a refusal), the game plays its written lines
with its label, and you tell the person plainly what is missing and what brings it.

## When the written lines play, the game says so

Whenever the game plays its written lines instead of a model (the Genex app's `native_unsupported`,
a guest, a declined or ended budget, a refusal, `local_test_unsupported` where no helper answers),
it shows a small visible label saying so and why, for example "Written lines: no AI budget". Never
an error, and never a silent swap that reads as a broken AI. A practice answer is not a fallback and
gets no such label.

## A game that listens and speaks

- When the person wants the player to talk to the game, or its characters to speak aloud, build it
  on Genex voice. Read
  `genex__skill {"name":"genex-llm-in-games","file":"skills/genex-llm-in-games/references/voice.md"}`
  first: `getVoiceCatalog()`, `voice` on the budget request, `createVoiceRecorder()` and
  `transcribe()` for listening, `createSpeaker()` for speech.
- Never the browser's own `SpeechRecognition`, `webkitSpeechRecognition` or `speechSynthesis`. In
  Studio's preview the recognition object exists but hears nothing (it needs Google's speech
  service, which Studio's browser does not have), the Genex app has none, and where it works it
  sends the player's voice to a company the approval sheet never named.
- Voice is an upgrade of a text conversation that already works. `getVoiceCatalog()` answers
  `enabled: false` wherever voice is not served; the game then takes typed input and shows its
  lines as text, with the small visible label this preface asks for ("Voice: not available here").
  Build and check that path first.
- Studio's preview serves voice through the practice helper, free: `transcribe()` returns made-up words and `speak()` a soft placeholder babble as
  long as the line. That proves the wiring (the recording, the queue, the subtitles, an
  interruption), never how a voice sounds. In Live, once the person presses Use real AI, real voices
  answer inside the same credit cap; a real voice call there costs at least one credit.
- Until a bench has run, the provisional budget covers voice as it stands: `perCallMaxCredits` 16
  holds one spoken line of any length the catalog allows, on any tier. Keep a spoken line to one to
  three sentences, ask for the `standard` tier unless the person asks for the best voice, and
  estimate honestly: `estimatedCharactersPerPeriod` is the lines a period holds times their length,
  `estimatedSecondsPerPeriod` the seconds a player talks.
- A game that records the player always declares the microphone in its `package.json`:
  `"genex": { "capabilities": ["microphone"] }`. Studio's Live reads that line to offer the person
  the microphone, so without it `createVoiceRecorder().start()` is refused in Live however the game
  is written. A draft or gallery publish prints what the build is given
  (`On its Genex page this build is given: microphone.`); an undeclared build is refused the
  microphone on its Genex page without the player being asked. The rules are in
  `genex__skill {"name":"genex-threejs-embed-auth","file":"skills/genex-threejs-embed-auth/references/shells.md"}`.
- Studio's Live preview grants the microphone to a game that declares it, once the person allows it
  in Live's bar. Your own preview windows never get it and the Genex app never grants it, so you
  cannot record there: check the listening path through the typed input, and check speech by
  calling the speaker from a click.
- The final message for a game with voice says in one line that talking to it needs Live with the
  microphone allowed, that the preview's voice is a placeholder until Use real AI is on, and that
  the game also takes typed input.

## Not in Studio yet

These parts of Genex CLI 1.45.2 are left out of the card below because Studio cannot run them yet:

- `llm bench` takes no `system` or `messages` option here. Put the system text and a typical
  history into the bench prompt itself, so the measured size is the real call's.
- Practice mode (`llm practice`), creator-paid budgets (`llm sponsor`, `sponsored: true`) and
  `llm usage` are commands Studio does not run. `features.sponsor` may read true on a stand; a game
  made here still asks the player for the budget.
- Model calls from a multiplayer server room (`shareWithRooms`, `lendSpendGrantToRoom`,
  `ctx.models`) are not built here. `features.roomCalls` may read true on a stand; a game made here
  calls the model from the player's page.
- Unity, Godot and Rust games have no model-call binding in Studio.
- Voice and the judge in an Unreal game: `UGenexModelsSubsystem` has no voice calls, and under Use
  my plan the judge stays practice.
- The app that Genex's Play starts from an Unreal game's folder is the packaged, published game: it
  does not use the practice helper (see An Unreal game).

`system`, `messages`, the controls and `features` work: Studio ships the SDK that has them.

## Reading the reference

Read the pricing reference with
`genex__skill {"name":"genex-llm-in-games","file":"skills/genex-llm-in-games/references/pricing.md"}`.

Genex's optional advice on designing the feature (the system instruction and turns, state as
data, legal moves, memory, several characters in one call, rules a character writes, hostile
player text) is `play-time-models` in the `genex-recommendations` plugin.

Other commands map onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).
