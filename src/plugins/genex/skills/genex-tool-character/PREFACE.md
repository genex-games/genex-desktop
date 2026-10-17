# Genex characters and creatures in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's character card,
unchanged. Where it disagrees with this preface, this preface wins.

- Run every command through `genex__asset`, never `npx genex`. `npx genex creature "<desc>"
  --polycount 20000 --height 2.4` is `genex__asset {"operation":"creature","prompt":"<desc>",
  "options":{"polycount":20000,"height":2.4}}`. A repeated `--animation` is one list:
  `"animation":["Left Slash","Hit Reaction"]`, at most 16 clips.
- One shot (`creature`, or `character` with `direct-text` or an `image`) needs nobody's pick, so
  it suits work nobody watches. The guided flow (`character`, then `character.preview` and
  `character.finalize`) stops until the user picks in Studio; Studio adds the approval flags
  itself, so never pass `user-approved` or `approve-remesh`.
- `character import <file>` is `character.import` with the game file as `prompt`. `character
  animate <id> "<verb>"` is `character.animate` with `id` and the verb as `prompt`;
  `--locomotion` is `"locomotion":true` and `--action <clip>` is `"action":"<clip>"`.
  `creature.animate` takes a verb, `locomotion`, `video`, `duration` and `lean`; a creature's
  catalog clips go on at generation, with `animation`.
- `animations search "<intent>"` is `animations.search` with the intent as `prompt` (no limit or
  category in Studio). `character motions <id>` is `character.motions`.
- Every create returns at once: pick it up with operation `wait` and its generationId, never by
  running the create again. Never pass `out-dir`, `no-wait`, `no-download` or `json`.
- These lanes are Meshy; Studio has no provider option. A prop, vehicle or building is the model
  card's lane (Tripo), or Local Blender's.
