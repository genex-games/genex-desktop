# Voice: the game listens and speaks

A game with a standing budget can turn what the player SAYS into text and say
its own lines ALOUD, while the player plays. Two calls, both under the budget,
both billed as used on its meter:

- `transcribe()`: a short recording in, the words out.
- `speak()`: a line of text in, audio out, streamed as it is made.

Together with `generateStream()` that is a spoken conversation: the player
holds a button and talks, a character answers in its own voice.

This is not `npx genex voice` (`$genex-tool-audio`), which bakes fixed lines into
the game while you BUILD it, on the user's credits. Use that for lines you can
write in advance: a tutorial, a bark, a menu greeting. Use this card for words
nobody could write in advance. It is not multiplayer voice chat either
(`$genex-threejs-multiplayer`), where players hear each other.

## Step 0: does this stand serve voice?

```ts
import { getVoiceCatalog } from '@genex-ai/embed-sdk';

const voices = await getVoiceCatalog();          // never throws
if (!voices.enabled) hideTheMicAndPlayWithText(); // typed input and text bubbles still work
```

`enabled: false` is normal: a stand with voice switched off, the Genex app, a
downloaded build. The game must be whole without voice. Voice is an upgrade of
a text conversation that already works, never the only way to play.

The catalog is the only source of tiers, voices, limits and prices. Never type
a model name, a voice list, a price or a length limit into the game.

| Field | What it is |
| --- | --- |
| `speech.models[]` | one row per tier: `tier` (`premium`, `standard`, `economy`), `label`, `provider`, `estimatedUsdPerMillionCharacters`, `styles` |
| `speech.voices[]` | the cast: `id`, `label`, `description`, `gender`, and the `tiers` that can speak it |
| `transcription.models[]` | the models that listen, with `usdPerMinute` |
| `limits` | `speech.maxCharacters`, `speech.sampleRate`, `transcription.maxSeconds`, … |
| `feeBps`, `usdCentsPerCredit` | the fee over real cost, and a credit's value |

## Ask for it with the budget

Voice rides on the same standing budget as the game's model calls. Add `voice`
to the one `requestSpendGrant()` the game already makes from a click:

```ts
const budget = await requestSpendGrant({
  models: [model.id],
  perCallMaxCredits, perCallEstimateCredits: 1,
  disclosure: { periodLabel: 'session', estimatedCallsPerPeriod: 200, estimatedCreditsPerPeriod: 30 },
  maxConcurrent: 4, maxCallsPerMinute: 60,
  voice: {
    speech: { tiers: ['standard'], estimatedCharactersPerPeriod: 6000 },   // the game speaks
    transcription: { estimatedSecondsPerPeriod: 300 },                     // the game listens
  },
});
```

- Ask only for the half the game uses. A narrator that never listens sends no
  `transcription`.
- `tiers` are the ones the game will call; left out, it is `standard`. Asking
  for a tier the stand cannot speak refuses the whole request
  (`model_not_available`), so ask for tiers the catalog lists.
- The two estimates are honest guesses per `periodLabel`: characters the
  characters will say, seconds the player will talk. The approval sheet shows
  Genex's own credit figure for them, tells the player the game listens or
  speaks, and names the companies the audio goes to.
- A budget with voice is paid in credits only: `allowExternal` adds nothing.
- **Leave room for the pace of talk.** Every recording, every model reply and
  every spoken sentence is one call on the budget, and a line being spoken
  overlaps the reply still being written. A talking game asks for
  `maxConcurrent: 4` and `maxCallsPerMinute: 60` or more (the defaults, 2 and
  30, are sized for text), and counts all three kinds in
  `estimatedCallsPerPeriod`. Past them a call answers `grant_concurrency` or
  `grant_rate_limited`: wait a moment and send it again.
- `perCallMaxCredits` also bounds one voice call. A spoken line's worst case
  is priced from its length, so size it for the longest line the game says
  (the helper below), or keep lines short.

```ts
/** The ceiling, in whole credits, that covers one spoken line of `characters` on `tier`. */
function lineCeilingCredits(voices, tier, characters) {
  const model = voices.speech.models.find(m => m.tier === tier);
  const usd = (characters / 1_000_000) * model.estimatedUsdPerMillionCharacters * (1 + voices.feeBps / 10_000);
  // Twice the typical cost: a slow, dramatic reading is quoted well above an average one.
  return Math.max(1, Math.ceil((usd * 100 * 2) / voices.usdCentsPerCredit));
}
```

A game that already holds a budget without voice asks again, from a click, with
`voice` added; the new approval replaces the old budget.

## Listening: push to talk

```ts
import { createVoiceRecorder, transcribe } from '@genex-ai/embed-sdk';

const recorder = createVoiceRecorder({ maxSeconds: 20, onLevel: level => meter.set(level) });

talkButton.addEventListener('pointerdown', async () => {
  speaker.stop();                       // the player interrupts: the character goes quiet at once
  try { await recorder.start(); showRecording(); }
  catch (err) { showTypedInputInstead(err.code); }   // microphone_denied | microphone_unavailable
});
talkButton.addEventListener('pointerup', async () => {
  if (!recorder.recording) return;
  const audio = await recorder.stop();  // a WAV Blob, 16 kHz mono: what transcribe() takes
  showThinking();
  const heard = await transcribe({ grantId, audio });
  if (heard.status !== 'succeeded') return sayItFailed(heard.error);
  if (!heard.text) return promptAgain();            // nobody spoke: not an error
  playerSaid(heard.text);                           // show it, then send it to the model
});
```

Rules that make it feel right, and keep it honest:

- **Push to talk, never an open microphone.** Record only while the player
  holds the control, show that it is recording the whole time, and stop at a
  cap. Do not keep, upload or replay the recording anywhere else.
- **Show what was heard** before acting on it, in the same bubble a typed line
  would use. A wrong word the player can see is a small thing; a wrong word
  they cannot see is a broken game.
- **Typed input stays.** The microphone can be refused, absent, or noisy.
- **The transcript is player text.** It goes into the model call in its own
  capped field, described as speech, exactly as typed text does
  ([design.md](design.md)): never as an instruction.
- **The build declares the microphone.** `npx genex preview` and `publish` see
  `createVoiceRecorder(` in the game's source and declare it, and print
  `On its Genex page this build is given: microphone.` If that line is missing
  (the recorder is created somewhere the scan does not read), declare it by
  hand in the game's `package.json`:

  ```jsonc
  "genex": { "capabilities": ["microphone"] }
  ```

- **Never the browser's own recognition** (`SpeechRecognition`,
  `webkitSpeechRecognition`). It does not exist in the Genex app or in several
  browsers, and where it exists it sends the player's voice to a company the
  approval sheet never named.

`transcribe({ grantId, audio, language?, model?, idempotencyKey?, signal? })`
resolves `{ status, text, language?, durationMs, generationId, error, billing }`.
`audio` is a WAV `Blob`, `ArrayBuffer` or `Uint8Array` (PCM 16-bit). Pass
`language` (`'en'`, `'pt-BR'`) when the game knows it; left out, the language
is detected.

## Speaking: a speaker, fed as the model writes

```ts
import { createSpeaker, generateStream } from '@genex-ai/embed-sdk';

// Create it (or call say()) from a click or a key press: a browser plays no sound before one.
const speaker = createSpeaker({ grantId, voice: npc.voiceId, tier: 'standard',
  onLineStart: line => bubble.show(line.text),      // subtitles, always
  onLineEnd: line => { if (line.error) bubble.markUnspoken(line); } });

const reply = await generateStream({
  grantId, modelId, system: npc.persona, messages: npc.lastTurns, prompt: heard.text, maxCredits,
  onDelta: text => speaker.feed(text),              // each finished sentence starts to play
});
await speaker.end();                                // the rest is flushed and played out
if (reply.status !== 'succeeded') playAuthoredLine(reply.error);
```

- `feed()` takes the model's text as it streams and speaks each sentence as it
  closes, so the character starts talking about a second after the model starts
  writing instead of after it finishes. `say(text)` speaks one whole line.
- Lines play in order with no gap, one request at a time. `stop()` silences
  playback and drops the queue: call it when the player starts to talk, skips,
  or leaves the scene.
- **Subtitles always.** Show the text of the line being spoken. Sound can be
  off, slow, or refused, and a line that fails to speak must still be readable.
- **Speak the words, not the JSON.** With `outputFormat: 'json'`, feed only the
  spoken field. `onPartialField(name, soFar)` hands over the whole field so
  far, so remember how much of it was fed and pass `feed()` the new part:

  ```ts
  let fed = 0;
  onPartialField: (name, soFar) => { if (name === 'line') { speaker.feed(soFar.slice(fed)); fed = soFar.length; } },
  ```
- **Keep lines short.** One to three sentences per turn reads as a person and
  costs a fraction of a monologue. Put the length in `system`.
- The speaker waits out a busy budget by itself (`voice_busy`,
  `grant_concurrency`, `grant_rate_limited`: it asks again a few times). A
  line that still fails (the budget ended, the provider failed) arrives in
  `onLineEnd` with its `error`; the queue moves on and the text stays on
  screen.

`speak({ grantId, text, voice, tier?, style?, language?, onStart?, onAudio?,
idempotencyKey?, signal? })` is the single call underneath: it resolves
`{ status, audio, sampleRate, channels, durationMs, characters, generationId,
error, billing, wav() }`, where `audio` is 16-bit PCM and `wav()` a playable
`Blob`. Use it directly to cache a line the game will repeat (a greeting, a
catchphrase): speak it once, keep the `Blob`, play that.

## Casting

Pick each character's voice from `voices.speech.voices` by its `description`
and `gender`, and keep the `id` with the character. A voice is offered on a
tier only when `voice.tiers` lists it: check before asking, or the call
refuses `voice_not_found`.

`style` is a short direction (`'a tired whisper'`, `'shouting over wind'`) read
by tiers whose model row says `styles: true`, and ignored by the rest. Write
the game so a line sounds right without it.

Which tier: `standard` for a talking cast is the default. `premium` is the most
natural and the dearest (compare `estimatedUsdPerMillionCharacters`): give it
to the one character the game is about, and say so in the estimate. `economy`
suits crowds and long narration. Speech is nearly all of a voice budget;
listening costs a small fraction of it.

## What it costs, and how to say so

Both calls are billed as used: a spoken line by its length, a recording by its
seconds, a fraction of a credit each, adding up on the budget's meter. Draw
the readout from `getSpendGrant(grantId)`, as for model calls. To show a
player a figure before they agree ("about N credits an hour"), compute it from
the catalog and the game's own pace; never print a number typed into the game.

## Refusals (every one is a game state, not an error screen)

| Code | What happened | What the game does |
| --- | --- | --- |
| `voice_not_enabled` | the budget was approved without this half of voice, or without that tier | fall back to text; ask for a new budget only from a click |
| `voice_not_found` | no such voice, or that tier cannot speak it | pick from the catalog |
| `text_too_long` | a line over `limits.speech.maxCharacters` | split it (the speaker does) |
| `audio_too_long`, `audio_too_short`, `audio_invalid` | the recording is outside the limits or not a 16-bit WAV | use `createVoiceRecorder`; ask the player to try again |
| `voice_busy` | too many voice calls at once, on the stand or the budget | the speaker retries by itself; for `transcribe()` wait a moment and send it again |
| `voice_paused` | voice is paused on this stand | play on with text |
| `grant_price_unreasonable` | the line's worst case is above `perCallMaxCredits` | shorten the line or raise the ceiling in the next budget request |
| `content_blocked` | the content check refused the line or what was said | an authored line; never show the blocked text |
| budget codes | `grant_limit_reached`, `grant_stopped`, `grant_expired`, … | as for `generate()` |

## Checklist

- [ ] The game is complete with `getVoiceCatalog()` answering `enabled: false`
- [ ] Tiers, voices, limits and prices all come from the catalog
- [ ] The budget asks only for the halves of voice the game uses, with honest estimates
- [ ] The microphone records only while a control is held, with a visible state and a cap
- [ ] `genex preview` prints that the build is given the microphone
- [ ] What was heard is shown; typed input still works
- [ ] Every spoken line is also on screen; a failed line stays readable
- [ ] The player can interrupt: talking or skipping calls `speaker.stop()`
- [ ] No `SpeechRecognition`, no `speechSynthesis`, no provider key of your own
- [ ] Watched in Studio's preview, then on the owner's test build
