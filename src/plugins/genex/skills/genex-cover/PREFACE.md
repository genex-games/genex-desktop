# Genex cover in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's cover card, unchanged.
Where it disagrees with this preface, this preface wins. Everything before the card's "Capture and
send — lane mechanics" holds here (when, the honest frame, the moment, composition, light and
judging), with §4's steps 1, 6 and 7 as this preface says for a demo. That section (its cover
entry, both of its lanes and its table of answers) does not apply in Studio: this preface replaces
it.

## The cover shot is the demo named `genex-cover`

- The card's named cover shot is, in Studio, a demo in `config.demos` named exactly `genex-cover`
  (the card's "if your host gives games named cameras or scripted demos"). Keep its staging in a
  module of its own, for example `src/cover-shot.js`. It is game code: it ships with the game,
  merges like any change and does nothing unless something runs that demo. No URL flag, no
  `window.__cover`, no dev-only import.
- A demo runs synchronously, and Studio photographs as soon as it returns: a promise it returns is
  never awaited. So `genex-cover` does the card's §4 in one call, setting everything absolutely so
  a second run lands the same frame: a place the game has already loaded by the time it reports
  ready (preload what the shot needs at boot: the demo cannot wait for step 1's detail); its time
  of day and weather; the cast posed with the game's own clips; the game's own effect fired and
  brought to its peak by stepping the game's own update with a fixed step, settling frames
  included (step 7's renders happen inside the demo); the physics settled; every overlay hidden
  (the HUD, which is `__studio.hud.clear()` in a game built on Studio's template, the crosshair,
  the cursor, prompts, debug helpers); the quality governor held; then the camera placed and its
  projection updated.
- End `genex-cover` with `window.__studio.pause()`. Studio's `demo()` pauses only a loop it steps
  (a game that passes `update`); this also stops Studio's clock for a game that runs its own loop,
  so nothing moves between the demo and the photograph and a second shot lands the same bytes.
- Studio opens the shot's window at 1920×1080 before the game loads, so the game's own resize
  already gives the camera a 16:9 aspect and the drawing buffer that size (step 6). Leave the
  aspect, `setSize` and the pixel ratio to it: the critic runs this demo in a window that is not
  16:9, and a forced `aspect = 16 / 9` would stretch that photo and those of the demos and drives
  that follow it on the same page. Only a game that fixes its own buffer size sets 1920×1080 and
  the matching aspect inside the demo.
- Studio's critic runs every demo and photographs its end frame, this one too, so the shot must not
  touch sign-in, saves, scores or progress (as the card says).
- Candidates: write two to four staging functions in the cover module, point `genex-cover` at one,
  shoot it, compare, and leave `genex-cover` on the winner, then shoot it once more: the kept shot
  is always the last one taken, and that is what `genex__cover-set` sends. Publish shoots whatever
  `genex-cover` stages at that moment.
- The demo is a standing choice: Publish shoots and sends what it stages without asking. Keep
  `genex-cover` only while its frame passes §5. When none does, or Genex refused it as too dark and
  the game is dark by design, delete the demo: with none, Publish sends nothing and the owner can
  set a cover on the game's page.
- A game whose code its owner keeps untouched (a folder they brought and asked only to publish;
  never a game Studio built) gets no `genex-cover` demo: Publish then sends no cover and Genex keeps
  its own. A game Studio built gets its demo before its first publish.

## Check it: `genex__cover`

- `genex__cover {"operation":"shoot"}` runs `genex-cover` in a hidden window of its own at
  1920×1080, keeps that frame as the game's shot, replacing the last one, and answers with its
  preview image and its numbers: `shot.stats.lumaMean`, `shot.stats.lumaStdDev` and
  `shot.stats.nearBlackFraction` are the card's mean, spread and near-black share, measured the
  gate's way on a small downscale of the whole frame, `shot.advice` names what they suggest
  (`too_dark`, `flat`, `dim`, `small`, `not_16_9`), and `sends` says when the shot goes out. You
  never meter in the page and never pass an image through JavaScript. Judge the preview as §5 says
  before any send.
- A `problem` instead means no new shot was taken and the last one is kept: `view_unknown` (no demo
  by that name; `available` lists the game's demos), `view_failed` (the demo threw; `reason` says
  how), `load_failed`, `timeout` (stage faster), `too_large`, `capture_failed` or `unavailable`.
- `genex__cover {"operation":"status"}` reports the kept shot, the last send (`last.kind`) and, once
  the game is hosted and the account connected, Genex's current cover and who chose it
  (`hosted.coverSource`). That is the card's "check who holds it first": `owner` means stop.

## Send it: Publish, or `genex__cover-set`

- Publish (`genex__publish {"operation":"gallery"}`), and a draft until the game is first public,
  shoots `genex-cover` again after exporting and, once the upload is recorded, sends that frame when
  its bytes differ from the last frame Genex answered for. A draft of a game that is already public
  sends nothing. `genex__publish-status` reports the outcome as `cover`, and a problem among its
  `warnings`.
- `genex__cover-set` sends the kept shot now, outside a publish; the user approves each call. With
  no hosted Genex project yet it sends nothing (`not_hosted`): the shot goes with the first publish.
- Studio takes and sends the frame itself: no `?cover=` URL, no `window.__cover`, no
  `npx genex cover`, nothing saved in `.genex/scratch`, and no browser of your own.

## The answers (`kind`)

| `kind` | What to do |
| --- | --- |
| `applied` | Done until the look changes. Record the shot where the project keeps its design notes. |
| `outranked`, `kept_owner` | The owner chose this cover on genex.games. Final: never resend, never ask them to clear it. |
| `unchanged` | Genex already answered for this exact frame (`settled` says how); nothing was sent. |
| `rejected` | `reason` `too_dark`: one brighter honest moment of the same game, or, dark by design, delete the `genex-cover` demo and stop: the owner can set one on the game's page. `flat`: the canvas had not drawn, a fade or loading screen was up, or sky or fog fills the frame: reframe. Any other reason: fix the file, not the game. |
| `invalid` | Refused before sending: fix the shot, not the game. |
| `failed` | Not sent (sign-in, the hourly limit, the network or no answer in time). Nothing is wrong with the frame; the next publish tries again. |
| `none` | There was no `genex-cover` shot: Genex keeps its own cover. |
| `not_hosted` | No hosted project yet: the first publish sends it. |
| `busy` | A publish of this game is running: check `genex__cover {"operation":"status"}` once it is done. |
