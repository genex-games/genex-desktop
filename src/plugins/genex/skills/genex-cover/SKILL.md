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

<!-- upstream @genex-ai/cli-demo/templates/skills/genex-cover/SKILL.md v1.36.2 sha256 9552bc1910747fd3b2c7a09921e4cbabe6d33824b4765ce9715682582f82ac0b -->
---
name: genex-cover
description: Make this game's cover — the one real frame its gallery card, game page and every shared link show. Choose or stage its best moment from its own world, models, light and effects (the hero, the action at its peak, the best-lit angle; no HUD, no text, 16:9), shoot several candidates, judge them at card size and send the best. Load once the game looks like itself, before its first publish, and again when its look changes.
---

# Genex · Cover

The cover is the game's poster: the picture on its gallery card, at the top of
its page and on every link anyone shares — often all a stranger sees before
deciding to play. It is **one real render of this game**: its own world,
models, light and effects, drawn by its own renderer. You built that world, so
you are best placed to find the frame a player would screenshot and send to a
friend. The craft is yours; the boundaries are not. The `$genex-*` skills
linked below go deeper; where one is not installed, this page stands alone.

## When

- **Make it** once the game looks like itself: the core loop plays, the hero
  and the world wear their real assets (no stand-in boxes), the light and grade
  are settled. Usually at a milestone's smoke check; always before the first
  publish.
- **Refresh it** when the look changes — a new hero, art direction, lighting,
  level or effect that is now the game's best moment — or when the cover shows
  something the game no longer has.
- **Not** every turn, not after fixes, tuning, audio or copy.
- **Check who holds it first** (the lane section says how). Chosen by the
  owner: stop, that choice stands. Captured while the owner played: replace it
  only with a clearly better frame. None, a stand-in picked automatically, or
  your own earlier pick: make it better.

Your pick outranks every automatic cover and nothing automatic ever replaces
it, so a frame from the placeholder era would stick. Wait until the game is
worth it, and refresh it yourself when the game outgrows it.

## The honest frame — staging is photography

Stage freely; staging only chooses among what the game already has:

- the camera's place, height, lens and angle anywhere in the world, views play
  never uses included — lower, closer, a longer lens — while still saying what
  the player does: a game played from above is shot from above, just lower and
  closer, and where the projection IS the look (isometric, side-on, a board),
  keep it and move within it;
- a place, time of day and weather the game really has;
- the cast in the game's own animations, frozen on their strongest frame;
  enemies the game really puts there, in numbers play really reaches;
- the game's own effects at their peak, physics settled, its top quality
  setting;
- everything on top of the world removed: HUD, menus, prompts, popups, cursor,
  reticle, aim cue, nameplates, touch controls, the sign-in gate, loading
  screens, debug helpers.

Never:

- **text of any kind** — title, logo, caption, watermark, border. Every surface
  already prints the title beside the cover or over its bottom edge, and a title
  in the picture goes stale on a rename. Big lettering in the world reads as a
  title too: frame it out.
- **a picture that is not a render of this game** — generated or painted art,
  the menu's own generated key art, concept sheets, stock, another game.
- **anything the game does not have** — a model, effect, sky or place made for
  the poster; an extra light on the hero; exposure, grading, bloom or depth of
  field the game does not run.
- **changing the place** — hiding, moving or deleting its walls, props or
  foliage, or thinning the fog, darkness or weather it has there. Move the
  camera, never the set: only the cast and effects are posed, and only overlays
  are removed.
- **brightening or relighting a game that is dark by design.** Choose its
  best-lit honest moment — the lantern, the muzzle flash, the dawn it really
  has; if even a tight frame on that moment is refused as too dark, stop and
  leave the cover to the owner.
- **editing the pixels after capture** — no retouch, composite, crop or
  upscale; re-shoot instead. Re-encoding a heavy PNG as JPEG is not editing.

The honesty test: a player who clicks this card can find this place, this
light and this kind of moment in the game.

The cover shot is a camera, not a cheat: players never meet it, it never
touches sign-in, saves, scores or progress, and a capture from it never proves
the game works — that evidence still comes from real play.

## 1. Choose the moment

One idea per frame — the strongest the game has, and the one the brief's mood
words promise: **its signature verb mid-action** (the jump at its apex, the
drift through the corner, the spell leaving the hand), **the hero at their most
characterful**, **the best vista**, or **the climax**. Not the spawn point, not
the default view of the player's back, not a moment with nothing happening.

| Game | Starting shot |
| --- | --- |
| Racer, vehicle | low 3/4 front at wheel height, crossing into open road, dust or sparks caught |
| Third-person action | 3/4 front or over the shoulder, mid-action, the world opening behind |
| Top-down, twin-stick, isometric | the game's own angle, lower and closer, the hero mid-fire, the shots or blast leading the eye, enemies closing |
| First-person | down the sightline at the moment of action, tool in frame, target lit |
| Platformer | the hero at the apex, the gap and the next ledge readable, the vista behind |
| Flight, space | the craft banking, rim-lit against a planet, sun or nebula |
| Strategy, builder, sim | high oblique, 30–45° down, over the busiest best-lit district |
| Puzzle, board, cards | the board at its most dramatic state (a cascade, the winning move) in the game's own projection, closer; tilt a 3D board only as far as play already views it |
| Horror, dark | close on the one lit thing (the lantern pool, the torch cone, the lit doorway) so it fills at least a third of the frame; a small light in a wide black frame is refused as too dark |
| Multiplayer | bodies the game itself draws (its bots or NPCs) in one shared action, or one player's best moment — never invented remote players, never names |

## 2. Compose

Rigs and lens mechanics, where installed: `$genex-threejs-camera-direction`.
The poster rules:

- **16:9 from the first try** — the camera's aspect and the drawing buffer both
  (the shot below). Anything else is centre-cropped to 16:9; a portrait frame
  keeps only a thin band.
- **One subject, readable small** — most people see the cover a few hundred
  pixels wide among dozens, six times smaller than a 1080p frame. The card-size
  test: the subject spans at least a third of the frame's height and its
  silhouette reads against its ground; if not, it is not the cover.
- **Thirds and lead room** — the subject on a third, eyes on the upper third,
  space ahead of the face and the travel. Keep it clear of the corners and the
  bottom edge: Genex cards set badges and a menu in the corners and darken the
  bottom ones, and one surface prints the title along the bottom.
- **Three planes** — a darker partial foreground edge, the subject, depth or sky
  behind; lines the world already has (road, wall, river, beam) lead to the
  subject.
- **Height and lens** — low makes heroes and machines powerful; high oblique
  explains a world. Three.js `fov` is vertical: about 25–40° for a hero or
  vehicle (step back to keep the framing), 55–75° for a vista or speed. Horizon
  level; tilt at most 10°, and only for speed or chaos.
- **Clean silhouette** — the subject against a ground of a different value,
  nothing growing out of its head, no edge just touching another edge or the
  frame. Characters face their target, or three-quarters to the camera — never
  staring into the lens.
- **Colour with intent** — one accent on the subject that the background lacks;
  the palette at its richest honest moment.

## 3. Light — the game's own

You choose when and where; you never add.

- **Key from the side or behind** — turn the camera until the game's sun or key
  light sits well off the lens axis, or behind the subject as a rim. Front light
  reads flat. Move the camera, not the sun.
- **Time and weather it really reaches** — with a day cycle or weather, take its
  lowest, warmest or most dramatic phase; a fixed sun stays where it is.
- **Effects are light** — engine glow, spell, neon, lava, muzzle flash: catch
  them at their peak, lighting the subject.
- **Exposure** — a bright subject in a darker surround, detail in its shadows,
  no clipped sky. Meter it against the gate itself, never by eye: sRGB luma
  `(0.2126R + 0.7152G + 0.0722B) / 255` over the whole 16:9 frame — its mean,
  its spread (std) and its share below 0.10 (the shot below returns all three).
  Where the game's light allows, aim well clear of the gate's lines — a frame
  that only just passes reads murky on a card: mean 0.2 or more, std 0.08 or
  more, under 70% near-black. (The playability meter in
  `$genex-threejs-exposure-color-grading` is centre-weighted, a different test.)

## 4. Build the cover shot

Hunting for a great frame while playing is luck. Build it once as a **named
cover shot** — a small function that stages one moment from the game's own
parts and holds it — and the exact frame can be re-taken after every visual
change. Build two to four, across at least two ideas — the action and the
vista. If your host gives games named cameras or scripted demos, a cover shot
is one of each.

A cover shot:

1. loads its place and waits until everything in view is at full detail;
2. sets the game's own time of day and weather;
3. poses the cast with the game's own clips, every other action on that mixer
   stopped — one left playing blends into the pose at equal weight
   (`mixer.stopAllAction(); const a = mixer.clipAction(clip).reset().setEffectiveWeight(1).play(); a.time = t; a.paused = true; mixer.update(0)`),
   each facing its target;
4. fires the game's own effect, advances it to its peak and settles the
   physics, then stops the game clock while rendering goes on;
5. hides every overlay and the cursor;
6. sets the camera, then a 16:9 drawing buffer the size of the capture —
   1920×1080 unless your lane captures a fixed smaller view — whatever the
   window is:

```ts
camera.position.set(4.2, 1.1, 6.8);
camera.lookAt(0, 1.4, 0);
camera.fov = 35;
camera.aspect = 16 / 9;
// An OrthographicCamera has neither: keep its height and widen it to 16:9 instead —
// const h = (camera.top - camera.bottom) / 2; camera.left = -h * 16 / 9; camera.right = h * 16 / 9;
camera.updateProjectionMatrix();
renderer.setPixelRatio(1);
renderer.setSize(1920, 1080, false);   // false: the page layout stays as it is
composer?.setPixelRatio(1);            // the post stack, if the game runs one
composer?.setSize(1920, 1080);
renderer.shadowMap.needsUpdate = true; // a cached shadow map still shows the old pose
```

7. renders a few frames so temporal effects settle (snap eye adaptation to its
   target rather than waiting it out), renders once more and meters that frame
   in the same task — a WebGL buffer is cleared once a frame is shown — then
   signals that the frame is held, with its numbers:

```ts
// The gate's own meter (§3). Call it right after the render, never later.
function meter(canvas: HTMLCanvasElement) {
  const small = Object.assign(document.createElement("canvas"), { width: 160, height: 90 });
  const ctx = small.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, 160, 90);
  const px = ctx.getImageData(0, 0, 160, 90).data;
  let sum = 0, sq = 0, dark = 0;
  for (let i = 0; i < px.length; i += 4) {
    const y = (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255;
    sum += y; sq += y * y; if (y < 0.1) dark++;
  }
  const n = px.length / 4, mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), dark: dark / n };
}
```

Hold the extreme of the pose, never the in-between: feet planted or clearly
airborne, particles fanned out but not yet fading, the flash just past its
white-out. No camera shake, hit-stop flash, fade, motion-blur smear or
half-loaded texture.

What ruins a staged shot:

- **Something writes it back next frame** — the camera rig, the resize handler,
  the quality governor, the character controller. Stop each while the shot is
  held.
- **A low quality tier.** A game that picks a quality tier at boot (Genex's
  adaptive-quality kit does: `$genex-threejs-adaptive-quality`) picks it before
  the renderer exists: a browser rendering on the CPU boots as a weak desktop —
  no antialiasing, smaller shadows, lighter post, fewer particles — and a
  runtime governor steps slow frames further down. Antialiasing is fixed when
  the context is created, so the shot boots at the full tier (the kit's
  `TIERS.desktop`, what its Quality picker's High forces) and holds the
  governor.
- **Shadows and near planes** — a shadow that follows the player still covering
  where the player was; a near plane clipping a close foreground object.
- **A defect in frame** — a limb through the body or weapon, a T-pose,
  z-fighting, a texture still on its low rung. That is a game bug: fix the game,
  never hide it from the camera (`$genex-threejs-visual-validation`).
- **A sky drawn in CSS behind a transparent canvas** — transparency is flattened
  onto black, and a canvas readback never sees the CSS. Draw the sky in the
  scene, or capture the page as shown.

**A game kept as it is.** When the code is its owner's to keep untouched — you
were asked to publish a game, not change it — build nothing: take the frame
from play, stage from the browser console at most, and add no code for a poster.

## 5. Shoot, judge, keep one

Shoot every named shot, then two or three variants of the best: a step closer
or lower, a few frames earlier. Look at each at full size for defects, then
against the card-size test (§2) and its meter (§3), and score:

1. It says what the game is — genre and verb — at a glance.
2. One clear subject that reads at card size.
3. The light sculpts it; it separates from the ground.
4. Depth: foreground, subject, background.
5. Only the world on screen — no interface, no text.
6. Everything in it is something a player of this game sees.
7. Its meter reads well clear of the gate below.
8. Clean: no clipping, popping, jagged edges or missing textures.

Keep the best. If none passes 1–6, change the moment or the camera — never the
game. Then ask: would someone scrolling a gallery of games stop here, and does
the game deliver what this promises? Judge locally and send one: the server is
a gate, not a judge, and agent cover uploads are limited per hour. Record the
winner — shot name, moment, camera position and target, `fov`, time of day,
why it won — in `DESIGN.md` when the project keeps one, so a refresh starts
from it instead of from scratch; a game kept as it is records nothing.

## What Genex takes

| | |
| --- | --- |
| Shape | Landscape 16:9, at least 320×180; shoot 1920×1080 (any 16:9 from 1280×720 up). Anything else is centre-cropped to 16:9. |
| File | PNG preferred; JPEG and WebP too, recognised by their bytes, not the name. At most 8 MB — over that, a high-quality JPEG. |
| Stored | 1280×720 WebP plus a JPEG sibling, EXIF-rotated, transparency flattened onto black. A smaller frame is scaled up and goes soft. |
| Gate | Rec.709 luma of the encoded pixels (0–1) on a 160×90 downscale of the centre 16:9. **Too dark**: mean below 0.12, or more than 85% of samples below 0.10. **Flat**: luma spread (std) below 0.04. A plainly lit scene reads about 0.4–0.6. The gate catches broken frames only; passing it says nothing about beauty. |
| Who wins | The owner > you > a frame from the owner's own play > a build-session screenshot > the game's menu art > a remix's inherited cover > old AI art — decided by the credential the frame arrives with, never by anything you send. You replace your own pick and every automatic one, never the owner's; their own upload is never gated. |
| Limits | 10 upload starts and 20 commits an hour per account, for all its agents together. |

## Capture and send — lane mechanics

Everything above holds in every lane. This section is only how a frame is
staged, captured and delivered: when the app you run in loads this skill under
its own preface, with its own capture and cover tools, that preface replaces
this section wherever they differ.

In both Genex lanes `npx genex cover` prints the current cover and who chose
it, and `npx genex preview` ends with a ➜ line while the game has no cover or
only a stand-in — your cue, at the next presentable moment rather than mid-fix.

### The cover entry

The shot runs only on the dev server, behind a URL flag a production build
cannot contain — Vite replaces `import.meta.env.DEV` with `false` there and
drops the import:

```ts
// main.ts — the first statements, ahead of every `await`, so the hook exists once the page loads
const coverShot = import.meta.env.DEV ? new URLSearchParams(location.search).get("cover") : null;
let coverWorld: ((game: Game) => void) | undefined;
if (import.meta.env.DEV && coverShot !== null) {
  const shots = import("./cover-shot.ts");
  const world = new Promise<Game>((resolve) => (coverWorld = resolve));
  let held: Promise<unknown> = world;
  const cover = (name: string) => // one staging at a time, each once the world exists
    (held = held
      .catch(() => {})
      .then(() => Promise.all([shots, world]))
      .then(([m, game]) => m.stageCover(game, name)));
  Object.assign(window, { __cover: cover });
  cover(coverShot); // the URL's own shot, for a tool that can only wait for a selector
}
const tier = coverShot !== null ? TIERS.desktop : detectTier(); // a game that picks a tier at boot
// … build the renderer from `tier` and the world as `game`; a cover boot goes straight to play, HUD hidden …
coverWorld?.(game);
// render loop:  if (coverShot === null) governor.frame(deltaMs);
```

`stageCover(game, name)` runs the steps of §4 and sets everything absolutely,
so calling it again re-lands the same frame, or another shot on the same page.
It resolves the frame's `meter()` numbers once the frame is held, and marks
`<html data-cover="ready">` (cleared while it stages) for a tool that can only
wait for a selector. **Every capture goes through `window.__cover('<name>')`**:
it re-stages the shot it names, queued behind any staging still running, so it
holds that shot even on a page where you staged another one since. A call that
does not come back with the numbers — an error, `null` — means the shot is not
held. After `npm run build`, search `dist/` for one of your shot names — it
must not be there.

### Local agent at a terminal

1. **Capture** with whatever browser tool you use for smoke checks, as long as
   it writes a screenshot to a file. Open
   `http://localhost:5173/?genex_local_test=1&cover=<name>` in a 1920×1080
   viewport at device scale 1 (a page of another shape stretches the buffer;
   scale 2 makes a PNG that can pass 8 MB), evaluate `window.__cover('<name>')`
   and wait for its numbers (a selector-only tool waits for
   `html[data-cover="ready"]`, the URL's own shot), and save the viewport
   straight to `.genex/scratch/cover-<name>.png`. Never return the image
   through a JavaScript evaluation — a 1080p frame is megabytes of base64 in
   your context. Reading the canvas instead? Render and read in the same task:
   the WebGL buffer is cleared once a frame is shown.
2. **Pick:** copy the winner to `.genex/scratch/cover.png`. Only `cover.png`,
   `.jpg`, `.jpeg` or `.webp` there is read, and the newest wins — candidates
   keep other names. To see them at card size, list them in
   `.genex/scratch/contact.html` as `<img width="320">` and screenshot that
   page.
3. **Send:** the next `npx genex preview` or `npx genex publish` uploads it
   after a successful deploy when its bytes differ from the last frame sent
   (`.genex/cover-upload.json` remembers only that last one; a failed transfer
   is tried again next time). `promote` sends nothing.
   `npx genex cover .genex/scratch/cover.png` sends it now: exit 0 for set or
   outranked, 1 otherwise; `--json` prints one object whose `kind` is
   `applied`, `outranked`, `rejected`, `invalid` or `failed`.
4. **No browser that can capture the game?** Do not set one up just for this;
   tell the owner they can set a cover on the game's page.

### Hosted Genex session

`genex_browser` takes the cover itself. One call runs the page load (skipped
when that URL is already open on unchanged source), a short wait for drawing,
`actions`, `evaluate` (one expression, at most 4096 characters, 15 s; a promise
is awaited), then the screenshot you see — and, with `cover: true`, a second,
lossless PNG of the same 1280×720 viewport, saved as `.genex/scratch/cover.png`
and sent with `npx genex cover`. Here the capture is that viewport whatever the
buffer, so stage at 1280×720 (`renderer.setSize(1280, 720, false)`, the
composer the same): a larger buffer only adds CPU time and memory to the
sandbox, inside `evaluate`'s 15 s.

1. **Judge first, as plain checks, every shot through `__cover`:**
   `{ "url": "http://localhost:5173/?genex_local_test=1&cover=hero", "evaluate": "window.__cover('hero')" }`.
   A heavy world that takes longer than `evaluate`'s 15 s to stage gets
   `"actions": [{ "type": "wait", "ms": 8000 }]` first (up to 10 s each). Read
   each image and the numbers `evaluate` returned; the tool's `frame` measures
   its JPEG of the whole page the same way (`mean`, `darkShare`, and `range`
   for spread). Nominate only a shot whose judging call returned its numbers.
   Switch shots on the same URL with `"evaluate": "window.__cover('vista')"` —
   a different URL means a fresh browser and a full reload, and an idle page
   closes after about 90 s.
2. **Nominate with the same URL, `"evaluate": "window.__cover('<winner>')"`
   and `"cover": true`** — never by repeating a call that only reads state: a
   reused page still holds the shot you staged last. The capture is the whole
   page, DOM included, and it is taken twice, so the shot must already be held
   — clock stopped, every overlay hidden — when it is taken; a found moment
   needs the HUD hidden and the clock stopped in `evaluate` too.
3. **Read `cover`:** `submitted` — `npx genex cover` exited 0 and `output` says
   set or outranked (outranked is final); `refused` — `output` says why;
   `not_submitted` — `note` says why, and nothing was sent. A frame is sent only
   when the check's `verification.rendering` is `observed` and the browser did
   not restart mid-check (a restart reloads the game, often to its title). No
   `cover` key at all means this runner cannot nominate: leave it, build
   screenshots stand in.
4. **When `evaluate` fails.** A timeout skips the capture, so nothing is sent. A
   thrown error does not: the capture goes ahead and nominates whatever is on
   screen. Look at the returned image; if it is not the held shot, fix the shot
   and nominate again — your own pick is yours to replace.
5. **Mind the two-check budget.** A check with a timeout, a failed `evaluate`
   or an unobserved render counts against the two failures allowed per
   unchanged source — shared with your smoke checks, and blind to the query
   string. Prove the shot on one plain check before nominating, and never spend
   the second failure on a cover: a found frame is a fine cover.
6. **The sandbox renders on the CPU.** If a frame does not look like the game
   players get (a WebGPU game on a different fallback), do not nominate it, and
   never change working rendering to suit the sandbox.

### The answers

Each send ends in one of these. The CLI prints the line (in the hosted tool,
inside `output`):

| Answer — the line | What to do |
| --- | --- |
| **set** — `Cover set —` | Done until the look changes. Record the shot where the project keeps its design notes. |
| **outranked** — `Cover unchanged — the owner picked…` | Final, exit 0. Stop: never resend, never ask the owner to clear theirs. |
| **too dark** — `Cover not used — … too dark…`, then brightness · contrast · near-black | One brighter honest moment of the same game. Dark by design: stop; the owner can set one on the game's page, where their upload is not gated. |
| **flat** — `… almost one flat colour…` | The canvas had not drawn, a fade or loading screen was up, or sky or fog fills the frame: wait for the render, reframe. |
| **refused** — `… was refused (unreadable / too_small / too_large)` | The server could not use the file: fix the file, not the game. |
| **invalid** — not a PNG, JPEG or WebP, over 8 MB, or under 320×180 | Refused before sending: fix the file. |
| **rate-limited** — `Too many cover uploads…` | Nothing is wrong with the frame. The line names the wait; the next preview sends it again by itself. |
| **can't send** — sign-in refused, another account, unknown game, or `doesn't take covers from the CLI yet` | `npx genex auth`, or `npx genex link <slug>`; only the owner's account sets a cover; an older stand takes none — stop and say so. |
