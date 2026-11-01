# Player experience on Genex (optional advice)

Genex's experience with how a web game meets its players on the platform. None of this is
required: the API facts are in `genex__skill {"name":"genex-threejs-embed-auth"}` and its
`references/shells.md`, and the game's own design wins. Use what fits, ignore what does not.

## Boot

- Identity takes seconds on a hosted page. Creating the renderer and drawing a first frame before
  awaiting `waitForPlayer()`, and awaiting it where the name or the avatar is first used, keeps the
  screen from staying black meanwhile.

## Preview builds and saves

- Saves resolve `{ staging: true }` on a preview. A local copy of progress (`localStorage`) keeps a
  preview playable; it works best as a cache for this device and this shell, never as the save.
- When the game mentions it, "Preview build — progress isn't saved to your account" tells the owner
  what is happening; "offline" or "unavailable" suggests an outage that is not there.

## Capabilities a player can refuse

- The microphone, the camera and location can be refused in every shell. A way to play without
  each (picking a place instead of sharing a location, typing instead of talking) keeps the game
  open to everyone.

## Pointer lock, fullscreen and Genex sheets

- A headless browser cannot take pointer lock, so for an aim game a headless check can confirm the
  "click to aim" cue and its wiring, not the lock.
- Before a Genex sheet (a purchase, a link, a model-call approval) the page leaves fullscreen and
  the SDK releases pointer lock. Treating the sheet like a pause, with a Resume button that takes
  fullscreen and the lock back on the player's click, keeps the flow smooth.
