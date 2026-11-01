# Genex textures in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's texture card,
with the passages of advice Studio does not ship taken out. Where it disagrees with this preface,
this preface wins.

- Run every command through `genex__asset`, never `npx genex`. `npx genex texture "<surface>"
  --terrain` is `genex__asset {"operation":"texture","prompt":"<surface>","options":
  {"terrain":true}}`.
- Studio submits every create without waiting and delivers every map into the game: never pass
  `out-dir`, `no-wait` or `no-download`. Pick a set up with operation `wait` and its
  generationId.
- Operation `status` names the lanes that are live.
