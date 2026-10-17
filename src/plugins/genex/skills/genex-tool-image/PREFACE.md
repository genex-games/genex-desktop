# Genex images in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's image card,
unchanged. Where it disagrees with this preface, this preface wins.

- Run every command through `genex__asset`, never `npx genex`. `npx genex image "<subject>"
  --transparent` is `genex__asset {"operation":"image","prompt":"<subject>","options":
  {"transparent":true}}`. `edit` and `inpaint` name image files inside this game; `clean` and
  `upscale` take a Genex asset URL.
- `open` and `glass` are not available in Studio, and neither are `out-dir`, `no-wait` or
  `no-download`: Studio submits every create without waiting and delivers the file into the
  game. Pick it up with operation `wait` and its generationId.
- An image is for something flat: a decal, a sign, a poster, UI art or an icon. Never stand one in
  for something the game shows in 3D, such as a crowd, a building or scenery.
