# Genex shells: what a game can do where, and what to call instead

One build of a Genex game runs in four places, and the browser gives a page
different powers in each. A call that works in one is refused, dropped or wrong
in another, usually with no error at all. This page is the one place that says
which. **Find the row before you write a browser or device API**: `navigator.*`,
`window.open`, a download link, a dialog, anything that reads the URL.

| `getShell()` | Where the game is | What that is |
| --- | --- | --- |
| `"page"` | its page on Genex (and the owner's draft workspace) | a sandboxed frame inside a Genex page. **Most players are here**: it is the link you hand out. Any frame reads as `"page"`, whoever frames it: inside a page that is not Genex's, `openExternal()` and `saveFile()` answer `unsupported` and the "On its Genex page" column does not describe it. |
| `"app"` | the Genex mobile app | one web view that shows the game and never leaves it. A game opened as the whole page of any React Native web view reads as `"app"`. |
| `"standalone"` | its own link: the game's address, a preview address, a creator's own domain | an ordinary browser tab |
| `"local"` | a dev server in local test mode | an ordinary browser tab on `localhost` |

**Local test mode behaves like the game's own link, never like its Genex
page.** Nothing you run locally is inside the frame, so a call that passes your
own test can still be dead for players. `npx genex preview` reads the game's
source and warns about the calls it recognises; this page covers the rest.

The SDK calls below are `@genex-ai/embed-sdk` **0.32.0+**
(`npm i @genex-ai/embed-sdk@latest` if an import is missing). Three rules hold
for all of them:

- **Call them from a click or tap handler, before any `await`.** A browser lets
  a page share, copy, open a tab or go fullscreen only while a click is being
  handled, and one click buys one action.
- **They resolve; they never throw.** `share()` resolves `{ status, url }`, the
  others `{ ok: true }` or `{ ok: false, error }`, and `haptic()` returns
  nothing. The `error` words are listed under "What a call answers".
- **`supports(name)` says whether to draw the button at all**: `"share"`,
  `"copy"`, `"awake"`, `"haptic"`, `"open"`, `"save"`, `"fullscreen"`. On the
  Genex page ask after `waitForPlayer()`. It is a hint; the call's own answer
  is the truth.

A game that cannot carry the SDK still lives by the three shell columns: they
say what the raw browser API does there. Where the last column is an SDK call
and there is no raw way, the fallback is always the same one: show the text,
the link or the code on screen.

## Works for every game — use the browser API

| The game wants | On its Genex page | In the Genex app | On its own link | Do this |
| --- | --- | --- | --- | --- |
| Pointer lock: mouse look, a hidden cursor | yes, from a click inside the game; Escape always releases it | a touch screen: nothing to lock | yes | `canvas.requestPointerLock()` in the click handler, or the bundled `FollowCamera`, which owns the lock. Pause when the lock is lost (`pointerlockchange`): Escape ends it, and so does the SDK before it asks Genex for a link, a file, a purchase or a model-call approval, because the player needs the cursor for that sheet. |
| A gamepad | yes | not checked: keep the touch controls | yes | `navigator.getGamepads()` each frame. A pad shows up after its first button press. |
| Tilt and motion: `deviceorientation`, `devicemotion` | passed to every game, but the browser has the last word: an iPhone asks the player, and only from a tap inside the game, and a browser may send a frame no sensor events at all | no Genex gate; the same rules | the same rules | Ask from the Start tap, treat a refusal or silence as "no sensor", keep the on-screen controls: the tilt recipe in `$genex-threejs-touch-controls`. |
| WebXR | passed to every game; not tried on a headset | do not rely on it | the browser's own | `navigator.xr`. A refused session is an ordinary answer. |
| A `<form>`: chat box, name entry, Enter to send | yes, `submit` fires | yes | yes | Handle `submit` and call `preventDefault()`. A form that is allowed to navigate replaces the game. |
| One orientation | the page does not refuse `screen.orientation.lock()`; whether a lock takes is the browser's and the device's | the app lets the device rotate freely while a game is open | the same as the page | Never depend on a lock. Design for one orientation and show the rotate overlay (`$genex-threejs-touch-controls`). |
| Sound | the page lets a game start sound without a tap of its own once the visitor has clicked anywhere on Genex; not every browser honours that | media may play inline, without a second tap | no click has happened yet when the game opens | Start audio on the first tap or key inside the game, in every shell. Muted inline video (`muted`, `playsInline`) may start by itself. |
| The keyboard | keys reach the game only while its frame has focus. The page gives it focus when the game starts and when a Genex sheet closes, unless the visitor is using something else on the page; a click in the game always does | no hardware keyboard to count on | yes | Start on a click or tap as well as a key: listen for `pointerdown` and `keydown`, and write "Click or press any key". Key labels for the player's layout (`navigator.keyboard.getLayoutMap()`) are passed too, where the browser has them. |
| The player picking a file: `<input type="file">` | yes | do not rely on it: Android refuses the picker | yes | The player chooses; the game reads what it is handed. |
| Device storage: `localStorage`, IndexedDB | works, in a store of its own: not the one the same game has on its own link | another store again, gone when the app is removed | one store per address: the live game, a preview and a creator's domain each have their own | Settings only (volume, quality, key binds). Progress goes through `savePlayerState()`; a local copy is a cache for this device and this shell, never the save. |

## Needs a declaration — microphone, camera, location

| The game wants | On its Genex page | In the Genex app | On its own link | Do this |
| --- | --- | --- | --- | --- |
| The microphone: voice chat, `getUserMedia({ audio })`, speech recognition | only a build that declared `microphone`. An undeclared build is refused at once and the player is never asked | refused for every game, declared or not | the browser's own permission prompt | Declare it (below). Voice chat is `room.voice.join()` in `$genex-threejs-multiplayer`. Hide the button when `getShell() === "app"`. |
| The camera: `getUserMedia({ video })` | only a build that declared `camera` | refused for every game | the browser's own permission prompt | Declare it. The game must play without it. |
| The player's location: `navigator.geolocation` | only a build that declared `geolocation` | refused for every game | the browser's own permission prompt | Declare it. Offer a way to play without it, such as picking a place. |

**The declaration is made when the build ships, never at run time.**
`npx genex preview` and `npx genex publish` read the game's own source and
declare what they find: `.voice.join()` called with nothing or with an options
object written at the call, `SpeechRecognition` or `getUserMedia` with `audio`
for the microphone (the voice pack from `npx genex controller voice` declares
it by itself); `facingMode` or `getUserMedia` with `video` for the camera;
`navigator.geolocation` for location. A call the scan cannot see
(`voice.join(opts)` with the options in a variable, `getUserMedia(constraints)`)
is declared by hand, in the game's `package.json`:

```jsonc
"genex": {
  "capabilities": ["microphone", "camera", "geolocation"]   // only the ones the game uses
}
```

The names are exactly those three. A misspelt name or a value that is not a
list declares nothing, and the command says so. Both commands print the result
before they upload (`On its Genex page this build is given: microphone.`), so
a missing declaration shows before a player meets it. The declaration belongs
to the build: preview or publish again after changing it.

A declaration lets the Genex page pass the request on to the browser. What the
player is asked, and when, is the browser's business, and the answer can be no
in every shell: the player refuses, the app always does, and Genex can withdraw
a capability from one game. **So every one of these needs a path that works
without it.**

## Goes through an SDK call

The raw API is in the shell columns; the call that is right in all of them is
in the last one.

| The game wants | On its Genex page | In the Genex app | On its own link | Call this |
| --- | --- | --- | --- | --- |
| To share itself, or an invite | `navigator.share` is passed to every game, but `location.href` there is the frame's bare address, never the page to send people to | a share sheet only where the app's web view has one | `navigator.share` after a tap, where the browser has a sheet | `share({ text, params })`. It builds the link itself, never from the current query or fragment: the game's page on Genex where Genex serves the live build or frames the game, otherwise the address the game is on (a preview address, a creator's own domain, a dev server), plus your `params`. It opens the sheet where there is one, copies the link where there is not (`copied`), and hands the link back as `unavailable` when neither works: show it. |
| To copy text: a room code, a seed | `navigator.clipboard.writeText` is passed to every game, after a tap. Reading the clipboard is not | depends on the app's web view | yes, after a tap | `copyText(text)`: the clipboard, then the older selection copy. To take text IN, let the player paste into an `<input>`; the `paste` event needs no permission. |
| The screen to stay on: tilt play, a cutscene | `navigator.wakeLock` is passed to every game; the browser drops the lock whenever the tab is hidden | the screen already stays on while a game is open | yes, with the same drop | `keepAwake(true)`, later `keepAwake(false)`. It takes the lock again when the player returns, and resolves `{ ok: true }` in the app. |
| A vibration | `navigator.vibrate` where the browser has it: Android browsers, after the first tap. An iPhone has none | nothing | the same as the page | `haptic(kind)`: `"selection"`, `"light"`, `"medium"`, `"heavy"`, `"success"`, `"warning"`, `"error"`. Never the only signal that something happened. |
| To open a link: Discord, a creator's site, credits | `window.open()` returns `null` and a `target="_blank"` click does nothing. A plain link to another site loads that site inside the frame, replacing the game | blocked; the app shows "An external link was blocked." | a new tab, from a click | `openExternal(url)`: an absolute `https://` address of at most 2048 characters. On the Genex page Genex shows the player where the link goes and opens it on their yes; `dismissed` is their no. In the app it answers `unsupported`: show the address as text. |
| To save a file: a screenshot, a replay, an export | a download started inside the game is dropped, with no error | not available | a download link works | `saveFile(blob, name)`: PNG, JPEG, WebP, WebM, MP4, JSON or plain text, up to 50 MB. `name` is a file name of 1 to 128 characters, never a path (no `/` or `\`); the saved extension follows the Blob's type. On the Genex page Genex asks the player first. In the app it answers `unsupported`. |
| Fullscreen | the game's own `requestFullscreen()` covers the frame only, without the page's controls, and does nothing on an iPhone, whose browser has no fullscreen for a page element | nothing to toggle: the game already has the whole screen | the browser's fullscreen | `setFullscreen(true)` / `setFullscreen(false)`. On the Genex page it asks for the PAGE's fullscreen, the one the page's own button gives. Entering needs the player's click, tap or key press inside the game, and a click on the page around the game in the five seconds before does not count; leaving does not. Nothing stays fullscreen while the page shows the player a sheet (a link, a file, a purchase): asked in the same tick as one, fullscreen is left again and answers `busy`. In the app it answers `unsupported`. |
| Its own URL parameters, and where the visitor came from | the page passes its own link on: `location.search` holds Genex's keys and then your pairs, `location.hash` is your fragment. `document.referrer` is Genex | the link the app was opened with; no referrer | your query survives the sign-in round trip. Until `initEmbed()` runs, `location.hash` holds Genex's sign-in fragment, and yours is put back with no `hashchange`. `document.referrer` is Genex | `getEntry()` → `{ search, params, hash, referrer }`: the same answer in every shell, before and after `initEmbed()`. Details under "The link a game was opened with". |
| A last save as the game closes | `pagehide` fires when the tab closes or reloads. A "Leave site?" prompt is never shown | the app tells the game before it closes it | `pagehide` fires | `onShellClosing(cb)`. The last chance to save, not the only one: save as the game goes, and never rely on `beforeunload`. |
| To sell an item | Genex draws the confirmation above the game and leaves fullscreen first; the SDK lets go of the pointer lock before it asks | no purchase surface yet: `buy()` resolves `failed` | a Genex popup, so `buy()` must start in the click | `buy()`, in `$genex-monetization`. Hide the buy buttons when `getShell() === "app"`. |
| A model call during play | Genex draws the approval above the game | no approval surface yet: the call resolves `failed` with `native_unsupported` | a Genex popup, so the call must start in the click | `generate()` and its family, in `$genex-llm-in-games`. Hide the entry point when `getShell() === "app"`. |

## Never

Nothing here has a call that makes it work. Each row names what to build
instead.

| Do not use | On its Genex page | In the Genex app | On its own link | Instead |
| --- | --- | --- | --- | --- |
| `alert()`, `confirm()`, `prompt()`, `print()` | nothing is shown: `alert()` returns at once, `confirm()` answers `false`, `prompt()` answers `null`, with no error | a blocking system dialog | a blocking system dialog | Draw the dialog in the game's own interface (`$genex-threejs-game-ui`). |
| Navigating away: `top.location`, `target="_top"`, a link or form that leaves the game | the page around the game cannot be navigated; a link inside the frame replaces the game | the app refuses to leave the game's address | the player has simply left the game | Keep every screen inside the game. Links out are `openExternal()`. |
| Reading the clipboard | not passed to any game | do not rely on it | a browser permission prompt | An `<input>` and the `paste` event. |
| Keyboard Lock: `navigator.keyboard.lock()` | not available: browsers give it to the top-level page only, so Escape leaves fullscreen and frees the cursor | no keyboard to lock | Chromium browsers, in fullscreen | Pause when pointer lock is lost. The lock is an extra for the game's own link (`$genex-threejs-game-ui`). |
| Notifications, web push | not available to a frame | not available | would prompt under the game's own address | Nothing. Do not ask. |
| A service worker, an installable web app | it registers, and one that caches then keeps serving its copy: an older build after an update, a game that has since been taken down | do not rely on it | the same as the page | Never register one. Genex serves the game and updates it. |
| `SharedArrayBuffer`, threaded WebAssembly | not available | not available | not available | Single-threaded builds. |
| MIDI, Bluetooth, USB, serial, HID, screen capture, browser payments, passkeys, sign-in popups for other services | not passed to any game | not available | behind the browser's own prompts | Do not build on them. Sign-in and money are Genex's: `waitForPlayer()` and `buy()`. |
| `history.pushState()` for in-game screens | its entries join the tab's history, so Back walks the game's screens before it leaves the page | Back belongs to the app | Back walks the game's screens first | Keep screens in memory, or use `replaceState`. |
| `document.title`, a favicon | never shown: the tab is the Genex page's | never shown | shown | Nothing to do. |

Also not for games: reaching `localhost` or devices on the player's network,
and the browser's built-in AI models. And a hidden game gets no frames: pause
on `visibilitychange`, never assume `requestAnimationFrame` keeps running.

## What a call answers

`{ ok: false, error }` from `copyText()`, `keepAwake()`, `openExternal()`,
`saveFile()` and `setFullscreen()`:

| `error` | It means | What to do |
| --- | --- | --- |
| `unsupported` | this shell or this browser cannot do it | hide the button, or show the link or the data another way |
| `needs_gesture` | the browser wants a click or a tap behind the call. On the Genex page `setFullscreen(true)` also answers it when no click, tap or key press of the player's INSIDE the game stands behind it, which includes the five seconds after they clicked or typed on the page around the game | call it straight from the handler, before any `await`, and keep the button up: the player's next click in the game works |
| `dismissed` | the player said no | nothing; it is not an error |
| `busy` | another request is still waiting for the player's answer, or a `setFullscreen(true)` the browser has not answered yet | ignore the extra click |
| `rate_limited` | the game asked too often | never call these on a timer |
| `invalid_request` | the arguments are outside the bounds in the call's row | fix the call |
| `too_large` | the file is over the size limit | save something smaller |
| `timeout` | Genex did not answer in time | treat it like `unsupported` for this click |

`unsupported` and `timeout` are ordinary answers, not bugs. Genex is updated
separately from a game, so a Genex page that does not take these requests yet
answers `unsupported` to `openExternal()` and `saveFile()` without asking
anyone, and `setFullscreen()` fullscreens the frame's own document there.

## The link a game was opened with

A link to a game can carry the game's own parameters: an invite
(`?lobby=abc`), a seed, a route (`#level-3`). Read them with `getEntry()`,
never from `location` or `document.referrer`:

```ts
import { getEntry } from "@genex-ai/embed-sdk";

const entry = getEntry();                 // safe before initEmbed()
const lobby = entry.params.get("lobby");  // ?lobby=abc  -> "abc"
const route = entry.hash;                 // #level-3    -> "#level-3"
const from = entry.referrer;              // "https://example.com", or null
```

- **The query** reaches every published game, in every shell, with no
  republish: it is in `location.search`, beside Genex's own keys. `getEntry()`
  returns just your pairs, in order and byte for byte (`?film` stays `?film`,
  `%20` stays `%20`). Up to 1024 characters, not counting the `?`; a longer
  query is dropped whole, never cut.
- **The fragment and the referrer** need the build shipped on
  `@genex-ai/embed-sdk` 0.32.0+. On the game's own link Genex hands them back
  from the sign-in round trip only to a build that recorded that: it reads
  the range in the game's own `package.json` as `npx genex preview` /
  `npx genex publish` stored it for the build. `^0.32.0` counts; `^0.31.0`
  does not, even when 0.32 is what got installed; `workspace:*` and `latest`
  do not. The fragment carries up to 4096 characters. The referrer is the
  ORIGIN of the site the visitor came from, never a path, and `null` when
  there is none or when they came from Genex itself. It is kept for the tab,
  so a reload answers the same; where the browser keeps no storage for the
  game, a reload no longer names that site. Any link can claim any origin:
  use it for attribution, never to grant a reward.
- **Reserved names.** `embed` and every key starting `genex_` belong to Genex,
  in the query and in the fragment; a fragment that contains `genex_` is not
  carried at all. On a link to the game's Genex page and in the Genex app
  `ref`, `s`, `from`, `remix` and `slug` are Genex's too, and on the Genex
  page so is the fragment `#credits`. Pick other names. `share({ params })`
  leaves the reserved ones out and warns once in the console.
- **In the app** a query or a fragment holding a raw `@`, or a character that
  is not plain URL text, is dropped, and the two together are capped at 1024
  characters. Keep invite values to letters, digits, `-` and `_`.
- **A value a shell did not pass is `""` or `null`, never an error.** Keep the
  second way in: an invite link next to a code the player can type.
- **A value from a link is text anyone can write.** Check its shape before you
  use it.

## The frame, exactly

What the Genex page gives the frame a game runs in, by its attribute names:

- Sandbox: `allow-scripts` `allow-same-origin` `allow-pointer-lock` `allow-orientation-lock` `allow-forms`
- Every game, for its own address only: `fullscreen` `gamepad` `xr-spatial-tracking` `accelerometer` `gyroscope` `magnetometer` `web-share` `clipboard-write` `screen-wake-lock` `keyboard-map` `autoplay`
- Only a build that declared it: `microphone` `camera` `geolocation`
- No game: `clipboard-read` `display-capture` `midi` `payment` `publickey-credentials-get` `usb` `hid` `serial` `bluetooth` `allow-popups` `allow-top-navigation` `allow-modals` `allow-downloads`
