# Models at play time (optional advice)

Genex's experience with games that call a language model while somebody plays. None of this is
required: the platform facts (the player pays and approves, text or JSON only, no author key, the
calls and their options, the codes) are in `genex__skill {"name":"genex-tool-llm"}` and `genex__skill {"name":"genex-llm-in-games"}`,
and the game's design is its own. Use what fits, ignore what does not.

## Designing the feature

What goes in the call, what comes back, what the game remembers and what the player sees while it
thinks decide whether the feature is good, and they set its cost. One idea runs through all of it:
the game owns the truth, and the model supplies words and choices. State lives in the game's code;
the model reads a view of it and answers inside a shape the game defined.

### The instruction and the turn

- A call splits well in two: `system` holds who the character is, the world's rules and how to
  answer, and stays byte-identical all session; the turn (`messages`, with `prompt` as the newest)
  holds what just happened.
- A `system` that works is short (under about 300 words): identity in one line, voice as two or
  three traits plus a sample line or two, what the character knows and does not know, the hard
  rules, what each output field means, and a stated answer length. An unstated length is the
  commonest cause of `provider_token_limit`.
- The turn travels well as compact JSON with short stable keys, built from a filtered view of the
  state, never the save file:

```ts
const turn = JSON.stringify({
  KNOWS: visibleFacts(state, "mara"),
  SCENE: { time: state.clock, guests: state.inn.guests.map((g) => g.name) },
  PLAYER_SAYS: playerLine.slice(0, 280),
});
```

- A secret the character should not reveal is best not sent at all: a model can be talked into
  repeating anything in its context.

### The answer's shape

- With the spoken line as the first string property, `generateStream()` shows it to the player as
  it is written (`onPartialField`).
- Everything the game acts on reads best as an `enum` or a bounded number, and every string with a
  `maxLength`: that bounds the bill and the speech bubble.
- For a character that acts (an opponent, a companion, a faction leader), the game can compute the
  moves that are legal right now and offer exactly those ids as the `enum`. The model chooses; the
  rules engine executes. It cannot invent a unit or spend gold it does not have, because neither
  is an id on the list. A long list (more than about thirty) shortens well to the candidates the
  game's own heuristics rank, plus one safe default.
- When an answer is unusable, the authored fallback (the default move, a written line) costs
  nothing. Each retry is billed, so one repair attempt is usually the most a feature needs.

### Memory

| Tier | Where it lives | Who writes it |
| --- | --- | --- |
| Facts | game state (reputation 12, knows the key is missing) | game code only |
| Recent turns | the last 4 to 8 turns, verbatim, in `messages` | appended by the game |
| Summary | one short string per character | the model, as an output field |

- Asking for the summary in the same call (a `memory` string with a `maxLength`, described as
  replacing the previous note) makes memory cost no extra request. The previous note goes in with
  the turn and the new one is saved with the game's state.
- Facts never come from the summary: if the summary says the player paid, the ledger in game state
  still decides.
- A bench run on the longest realistic turn, with a full memory, gives a ceiling that still fits
  an hour into a session.

### Several characters

- One call that returns the scene (an array of beats, each a `speaker` enum, a short `line` and an
  `act` enum) is cheaper, faster and more coherent than one call per character. The game plays
  the beats in order with its own timing, so one answer becomes ten seconds of a team talking.
- The game owning turn order (who is in the scene, when it ends) keeps it bounded, as does a cap
  on how many exchanges follow one player action.
- Plan, then act: one call writes a short plan as an array of enum actions, the game executes it
  with no further calls, and only a surprise asks for a new plan.
- Characters that keep secrets from each other (a negotiation, a traitor) need a call each, with
  its own `KNOWS` and the others' public lines only. Those can run at the same time, up to the
  budget's `maxConcurrent`; a call past that is refused as `grant_concurrency` and can be sent
  again when one returns.

### Rules a character "writes"

A character who writes flight software or house rules can return a list in a small rule language
the game interprets, with every part an enum or a bounded number:

```json
{ "when": { "sensor": "fuel", "op": "below", "value": 20 }, "do": "abort_launch" }
```

The game validates the rules against the schema, shows them as if they were code and runs them
through its own interpreter, so nothing the model wrote reaches `eval`, a shader, a URL or the
scene graph.

### Deciding before writing

`judge()` answers typed questions about what the player wrote (an intent `choice`, an off-topic
`noul`, a `score` over game state) faster and cheaper than a written answer. Routing on it in game
code lets a threat go to the guard scene with no further call and keeps `generateStream()` for a
real question.

### While it thinks

- A streamed line starts in about a second; a whole answer can take five to ten.
- A game that keeps moving (the character polishes a glass, the clock runs) and gives each call a
  patience limit, past which an authored line plays, never looks frozen.
- Asking at the end of the player's turn, or while they read the previous line, has the answer
  ready when it is wanted.
- `cacheSystem: true` makes a long stable `system` cheap to re-use when the same budget calls it
  many times within a few minutes; a short instruction or a rare call gains nothing from it.
- A thinking model spends answer room before the first word: `reasoningEffort: "low"` (where the
  model's `controls` list it) suits dialogue.

### Models and the size of a session

- The cheapest featured model, tried on ten real turns (a rude one, an off-topic one and a long
  one among them), is the usual starting point; most dialogue and move selection need no more.
- A session costs calls per minute × the bench's average credits per call × minutes played. The
  common call (a short streamed reply on a small model) and the expensive one (a whole turn
  planned from a large world state) can differ a hundredfold.
- When that arithmetic lands near the top of what a player can approve, a cheaper loop (batching,
  caching, a shorter state, decisions moved to the judge) helps more than a bigger budget.

### What the player typed

- Player text travels well in its own capped field (`PLAYER_SAYS`), which the `system` describes
  as speech and never an instruction.
- The model's answer grants nothing by itself: wins, rewards, prices and unlocks come from game
  code over game state, or from a `judge()` question over that state.
- After `content_blocked` the authored line plays; the same text rearranged is refused again.

### A spoken conversation

Where the stand serves voice, a player can talk and characters can answer aloud (the calls are in
`genex-llm-in-games`, `references/voice.md`). What tends to make it feel like talking to someone:

- Push to talk beats an open microphone: a held button or key, a visible "listening" state and a
  level meter. The player knows when they are heard, and nothing is recorded by accident.
- What was heard appears on screen before the game acts on it. A misheard word the player can see
  is a small thing; one they cannot see reads as a broken game.
- The reply is spoken as it is written: the speaker fed from the stream starts about a second in.
  One to three sentences a turn sounds like a person and costs a fraction of a monologue; the
  length belongs in the `system`.
- Every spoken line is also on screen. Sound can be off, late or refused.
- The player can interrupt: starting to talk, or skipping, stops the speaker at once.
- Each character keeps one voice for the whole game, picked from the catalog by its description. A
  cast of several reads best when the voices differ in gender and manner, not only in name.
- One tier for the whole cast is the plain choice. The dearest tier on the one character the game
  is about, and a cheaper one for everyone else, spends where it is heard.
- Speech is nearly all of a voice budget; listening costs a small fraction of it. Shorter lines
  are the lever, not fewer questions.
- A line the game repeats (a greeting, a catchphrase) can be spoken once and its audio kept for
  the session.
- Typed input stays beside the microphone, for a refused microphone, a noisy room or a player who
  would rather type.

## When the feature cannot be a model call

- When the person does not want a play-time model, or the lane is off on the stand, an authored
  version often serves as well: a written dialogue tree, a table of lines, a rule-based director.
  Most good games are built that way.
- When somebody asks for something the lane cannot return (a 3D model typed into existence, paid by
  the player), JSON parameters, then render, is the shape that works: the model returns a
  structured description and the game builds it from assets and code it already ships (a creature
  assembled from generated parts, a room laid out from prefab ids, a palette, a stat block, a line
  delivered from pre-generated voice clips).
- Saying plainly in the handoff that the lane was off, or that the feature runs on its authored
  fallback, keeps the person's picture of the game accurate.

## Keeping the feature playable

- A feature built behind a graceful `unavailable` state (the NPC uses its authored lines, the quest
  falls back to the written one) never promises the player something that 404s.
- In the Genex app (`getShell() === "app"`) the lane has no approval surface; leaving the feature's
  entry point out and playing the authored fallback reads better than an error.
- Guests hold no wallet: showing the feature as sign-in-to-use, rather than hiding it, tells them
  what signing in gives them.
- Offering the featured models, and the full catalog only when someone asks, keeps the picker short.

## When a standing budget ends

| code | what tends to work |
| --- | --- |
| `grant_limit_reached` | authored behaviour returns; a button offers to re-request |
| `grant_stopped` | accept it with no error, label the written lines and keep playing |
| `grant_expired` | as stopped; re-request on the next deliberate click |
| `waiting_for_plan` | wait out the stated time |
| `grant_insufficient_funds` | pause the thinking NPCs, say so once, stay playable |

## Keeping the burn low

- Batching several NPCs into one call that returns all their decisions, caching a decision until the
  situation that caused it changes, and picking the cheapest model that passes the game's own check
  all lower what a player spends.
- A call fired on a timer the player cannot see is spend they did not ask for.
- When the game hits `grant_concurrency` or `grant_rate_limited`, batching and caching usually fix
  it better than raising the limits.
