# Genex models in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's model card,
unchanged. Where it disagrees with this preface, this preface wins.

- Run every command through `genex__asset`, never `npx genex`. `npx genex model "<prompt>"
  --auto-size --low-poly` is `genex__asset {"operation":"model","prompt":"<prompt>","options":
  {"auto-size":true,"low-poly":true}}`. A flag's value is the option's value
  (`"face-limit":20000`); `image` names an image file inside this game.
- `model import <file>` is operation `model.import` with the game file as `prompt`. `model
  segment`, `model rig` and `model animate` are `model.segment`, `model.rig` and `model.animate`,
  with the generation id as `id`.
- Studio submits every create without waiting and delivers the files into the game: never pass
  `out-dir`, `no-wait`, `no-download` or `json`. Pick a result up with operation `wait` and its
  generationId; operation `status` lists your jobs in place of `wait --all`.
- This lane is Tripo, and Studio has no provider option. A rigged character or creature is the
  character card's lane (Meshy).
- Pass `auto-size` whenever the model's real size matters: without it the model is not to scale.
  Its meshes are dense (150000 faces by default): use `low-poly` or `face-limit` for props seen in
  numbers.
