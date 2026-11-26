# Genex models at play time in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's card on calling a
model from a running game, with the passages of advice Studio does not ship taken out. Where it
disagrees with this preface, this preface wins.

## Commands, as Studio tools

- `npx genex llm models`, `llm status` and `llm cancel <id>`: `genex__cli`, for example
  `genex__cli {"command":"llm models","options":{"all":true}}` or
  `genex__cli {"command":"llm cancel","args":"<id>"}`.
- `npx genex llm usage`: `genex__cli {"command":"llm usage","options":{"days":1}}` (`days` 1 to 90,
  7 when left out). The published game's model calls as its owner sees them: how many, what
  players were charged, and the code of each call that failed (`failuresByCode`). It lists only
  calls Genex admitted. A call refused before that (low credits, a ceiling or a model outside the
  approved budget, an ended sign-in) is not in it, so no calls after a play that failed means the
  call was refused, not that it never arrived.
- `npx genex llm calls`: `genex__cli {"command":"llm calls","options":{"failed":true,"limit":10}}`
  (`failed` true for the calls that did not answer, `limit` 1 to 100, 20 when left out). The same
  game's recent calls one by one: when, which model, how it ended and with which code, its ceiling
  and what was charged, the token cap it ran with and the one it asked for, the tokens it used
  (thinking counted apart), whether it was cut off, and the budget's per-call ceiling. A failed
  call carries a `hint` saying what to change, and `refusedBeforeStart` lists the codes of calls
  refused before they started, which leave no row here, each with what to change. Run it first
  when the person reports a failed play of the published game; for a cut-off answer it says
  which limit cut it. Where Studio answers that it cannot list calls yet (an older Genex), use
  `llm usage`.
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
- Project commands (`llm bench`, `llm status`, `llm cancel`, `llm usage`, `llm calls`) need the game's hosted project:
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
- The provisional 4 is right only for an inexpensive model. A ceiling must cover what the model's
  input alone may cost, or the call is refused `provider_budget_insufficient` before it runs. The
  rule, from the model's row in `llm models` (`inputUsdPerMillion`, `outputUsdPerMillion`) and the
  catalog's `feeBps`:
  `maxCredits` ≥ ((prompt bytes + schema bytes + 2048) × `inputUsdPerMillion` + `maxOutputTokens` × `outputUsdPerMillion`) × (1 + `feeBps` / 10000) / 10000, rounded up.
  A model at 0.75 in and 3.75 out fits 1; one at 10 in and 50 out needs 8 for a 1.5 KB prompt and
  512 tokens, so 4 is refused. Work the number out for the model the game names, set the call's
  `maxCredits` to it and `perCallMaxCredits` to at least twice that, and write the sum in the
  constant's comment. On `provider_budget_insufficient` raise both `maxCredits` and the declared
  `perCallMaxCredits` (`llm budget set` again for a native game); never retry it unchanged. The
  practice helper prices nothing, so only this sum, or a bench, shows the refusal before players do.
- A ceiling also bounds how long an answer may be, so a provisional one needs short answers: the
  prompt states the answer's length, every string in the schema has a `maxLength`, and the call
  passes `maxOutputTokens`. Each ceiling is one named constant, so one edit raises it.
- A call that ends `provider_token_limit` was cut off, by one of two limits, and the result says
  which. When the result's `maxCredits` is lower than the `maxCredits` the call declared, the
  length cut it, not the ceiling, and raising `maxCredits` changes nothing. Most current models
  think before they write (Gemini 3.8 Flash, GPT-6 Astra and Claude Fable 5.1 always do), the
  thinking is counted against the call's `maxOutputTokens`, and a game can turn it down only
  where `llm models` lists `reasoningEffort` for that model; where it lists none, there is no
  setting to pass. So a cap sized for the answer alone (the stand's default is 512) can end with
  no answer at all. Give such a call room: `maxOutputTokens` 2000 to 4000 for a
  short line on Gemini 3.8 Flash, with the answer's own length still stated in the prompt and the
  schema's `maxLength`, and work the ceiling rule above again with that number so the call's
  `maxCredits` and the declared `perCallMaxCredits` fund it. When the two are equal, the
  ceiling cut it: the next call of that prompt declares twice the `maxCredits`, up to the budget's
  `perCallMaxCredits` (16), for the rest of the session. A call's `maxCredits` can never be above
  the approved budget's `perCallMaxCredits`. Either way the game plays the written line with its
  label, and after two cut-offs in a row for the same prompt it stops calling for the session
  rather than retry. That is why the provisional budget allows 16 a call while a call starts at 4. A bench
  settles the figures.
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
  request without it is refused `invalid_request`.
- A character's line is asked with `GenerateStream` (the same options) and shown as it is written:
  `OnDelta(Request, Text, SoFar)` fires for each piece, then `OnSettled`. Put the words on screen
  from the first `OnDelta`; a player must never look at a silent character until the whole answer
  exists. For a JSON answer `SoFar` is the JSON text so far: read the spoken field out of it as
  it grows. With practice answers and with **Use my plan** the text still arrives in pieces.
- A character speaks with `Speak`: `{"grantId":"…","text":"<the line>","voice":"<a voice id>","tier":"standard","style":"<how he says it>"}`.
  Voice ids: `narrator`, `heroine`, `gruff`, `elder`, `robot`, `imp` (every tier) and `sprite`,
  `sage`, `matron`, `herald`, `whisper`, `muse` (tiers `standard` and `economy`); `style` works
  on those two tiers.
  `OnSpeechStarted(Request, Sound)` hands over a `USoundWave` as soon as the first sound exists:
  set it on an audio component at the speaker and play it; it keeps playing as the rest arrives.
  `OnSettled` ("speak") then says how long the line is (`durationMs`). The budget must name
  speech: add `"voice":{"speech":{"tiers":["standard"],"estimatedCharactersPerPeriod":<n>}}` to
  the `RequestSpendGrant` options and declare speech in the game's AI budget before it is
  published, or every line is refused `voice_not_enabled`.
- The player speaks with `Transcribe(Wav, OptionsJson)`: record the microphone yourself while a
  talk key is held (Unreal's `Audio::FAudioCapture`, module `AudioCaptureCore`), make one 16-bit
  mono WAV at 16 kHz, and pass its bytes with `{"grantId":"…","language":"en"}`. `OnSettled`
  ("transcribe") carries `text`, empty when nobody spoke: use it as the player's line. Add
  `"transcription":{"estimatedSecondsPerPeriod":<n>}` beside `speech` in the budget's `voice`.
- A call that wants fields back sends a schema, and the whole options text is one JSON object:
  `{"grantId":"…","modelId":"<id>","prompt":"…","outputFormat":"json","maxOutputTokens":2000,"maxCredits":<n>,"schema":{"type":"object","additionalProperties":false,"required":["line","mood"],"properties":{"line":{"type":"string","maxLength":240},"mood":{"type":"string","enum":["warm","wary","angry"]}}}}`.
  Its answer is the result's `output`, an object. Write the schema exactly this way, because the
  plugin sends it as written and a schema Genex cannot serve is refused `invalid_schema` before
  the call runs (a published game's first call failed this way): `schema` is an object inside the
  options, never JSON text (a quoted string); it goes with `outputFormat` `json`; every object, at
  any depth, has `properties` and `additionalProperties: false`; and it uses only the dialect's
  keywords: `type`, `description`, `title`, `properties`, `required`, `additionalProperties`,
  `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, five
  levels deep at most, with no `$ref`, `anyOf`, `pattern`, `format` or `default`. Build the
  options with Unreal's JSON writer or one raw string literal, never by pasting a schema string
  into another string.
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
- The packaged app that Genex's Play starts from the game's own folder is answered by the same
  helper on a Mac and on Linux, once the game holds the plugin Genex ships now and was packaged
  again with it (`unreal__package-game`): Genex hands that app the helper's key and it can reach
  nothing else. An app packaged with an older plugin gets no answer there (it is given no way to
  genex.games either), so package again before reading that as a fault. So the person can press Play in Genex and
  hear the game's AI answer with no Unreal editor open. On Windows the packaged app cannot reach
  the helper: check the AI in the editor's play there.
- The same app, once published and installed by a player, or started outside Genex, asks
  genex.games, where a budget exists only after the game is published with a declared budget
  (`llm budget set`, above) and that player approved it on the game's page in the Genex app before
  Play. `budget_not_approved` there is the correct answer for a game nobody approved a budget for,
  and a one-time call is `native_unsupported`: the game plays its written lines with its label.
  Never start the packaged app yourself from a shell to test its AI, and never report that answer
  as a broken feature.
- The published game's budget is the declared one, never what the game's own `RequestSpendGrant`
  options say: the plugin does not send them there. So every `Generate` names a `modelId` that is
  in the declaration's `models` and a `maxCredits` no higher than its `perCallMaxCredits`, and you
  change the declaration (`llm budget set`) whenever you change either in the code. A practice play
  cannot show a mismatch: the helper approves what the game asks for.
- A call that fails settles `status` `failed` with the reason's code in `error`, and, when Genex
  says so beside the code, which rule broke in `reason` and where in `at` (for `invalid_schema`,
  such as `ref_not_supported` at `schema.properties.mood`). The game shows
  `GenerationErrorMessage(<error>)`, a sentence for that code, and keeps the code readable: small
  after the sentence or on a debug key, with `reason` and `at` beside it when the result has
  them. The plugin also writes the code itself, with the HTTP status and those two,
  as one line starting `genex models:` in Unreal's log, and in a packaged Shipping game, which
  keeps no Unreal log, in `Genex.log` in the game's log folder. So nobody rebuilds a game to learn
  a code: when the person reports a failed play of the published game, read the code before
  changing anything. Run `llm calls` with `failed` true (above), ask what the screen said, and ask for that file.
  What the codes mean: `invalid_schema` the schema breaks a rule above (`reason` and `at` say which and where);
  `grant_insufficient_funds` the player's credits do not
  cover the call (they top up, the budget resumes); `grant_price_unreasonable` the call's
  `maxCredits` is above the declared `perCallMaxCredits`; `model_not_available` the `modelId` is
  not in the declared `models`, or Genex does not serve it; `provider_budget_insufficient` the
  `maxCredits` is below what this model's input may cost (the ceiling rule above: raise it and the
  declared `perCallMaxCredits`); `provider_token_limit` the answer was
  cut off (raise `maxOutputTokens` when the result's `maxCredits` is below the call's, else
  `maxCredits`: the rule above);
  `session_revoked` the sign-in that approved the budget ended, so they approve again;
  `budget_not_approved` nobody approved a budget. Say which one it was, and never guess between them.
- The final message for an Unreal game that calls a model says in one line that a Play in the
  Unreal editor answers with practice answers until the person presses Use my plan or Use real AI
  above the game in Live (Genex's own Play of the packaged app is answered the same way on a Mac
  and on Linux), and that the published game needs its budget declared and each player's approval
  on its Genex page.

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

These parts of Genex CLI 1.46.5 are left out of the card below because Studio cannot run them yet:

- `llm bench` takes no `system` or `messages` option here. Put the system text and a typical
  history into the bench prompt itself, so the measured size is the real call's.
- Practice mode (`llm practice`) and creator-paid budgets (`llm sponsor`, `sponsored: true`) are
  commands Studio does not run. `features.sponsor` may read true on a stand; a game made here
  still asks the player for the budget.
- Model calls from a multiplayer server room (`shareWithRooms`, `lendSpendGrantToRoom`,
  `ctx.models`) are not built here. `features.roomCalls` may read true on a stand; a game made here
  calls the model from the player's page.
- Unity, Godot and Rust games have no model-call binding in Studio.
- Voice and the judge in an Unreal game: `UGenexModelsSubsystem` has no voice calls, and under Use
  my plan the judge stays practice.

`system`, `messages`, the controls and `features` work: Studio ships the SDK that has them.

## Reading the reference

Read the pricing reference with
`genex__skill {"name":"genex-llm-in-games","file":"skills/genex-llm-in-games/references/pricing.md"}`.

Genex's optional advice on designing the feature (the system instruction and turns, state as
data, legal moves, memory, several characters in one call, rules a character writes, hostile
player text) is `play-time-models` in the `genex-recommendations` plugin.

Other commands map onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).
