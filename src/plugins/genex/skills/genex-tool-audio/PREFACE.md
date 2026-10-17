# Genex audio in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's audio card,
unchanged. Where it disagrees with this preface, this preface wins.

- Run every command through `genex__asset`, never `npx genex`. `npx genex sfx "<sound>"
  --duration 3` is `genex__asset {"operation":"sfx","prompt":"<sound>","options":
  {"duration":3}}`; `music` takes `duration`, and `voice` takes `voice` or `voice-id`.
- Give every sound effect a `duration` when its length matters: left out, the model decides. An
  ambient bed the game repeats needs `"loop":true`.
- Studio submits every create without waiting and delivers the MP3 into the game: never pass
  `out-dir`, `no-wait` or `no-download`. Pick it up with operation `wait` and its generationId.
- The audio-context troubleshooting line is about browsers; it does not apply to an Unreal game.
