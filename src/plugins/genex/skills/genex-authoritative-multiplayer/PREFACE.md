# Genex server-authoritative multiplayer in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's server-authoritative
multiplayer card, with its CLI-only testing section taken out. Where it disagrees with this
preface, this preface wins.

## What Studio runs of it today

- Writing works: the room module, its `authority` block and the client, in any web game made here.
  A Unity game writes the same room module and block (in `genex.json`) with a C# client: follow
  section 5 of `unity__skill {"name":"unity-multiplayer"}`, not this card's client half.
- Shipping works. `genex__publish` (draft or gallery) sends the room module with the build: Studio
  ships `@genex-ai/authority-dev` itself, stages `server/` and every file the module imports beside
  the public copy (never in it), and the publish bundles and validates the module before any game
  file moves. A module that fails stops the publish with each typed reason in the job's error; fix
  the module and publish again. The job's `room` (in `genex__publish-status`) says it plainly:
  `validated` and `uploaded` with the module's `moduleSha256` once it passed and went up with this
  build, or the gate's `failures`; tell the person from it. On Genex's servers the owner needs
  Genex Pro: a free account is refused with `authority_requires_pro` after validation, and nothing
  is uploaded.
- Testing it on this computer works, with `genex__room` in place of the card's
  `npx genex-authority-dev` commands (a game's commands cannot download it):
  - `genex__room {"action":"validate"}` is the publish gate's own check: `{passed, failures}`.
    Run it after every change to the module, and fix each failure before anything else.
  - `genex__room {"action":"start","latencyMs":75}` serves the room on this computer with bots
    and loads the game's preview into it, so the person plays against the bots there. The preview
    takes a seat and your own test client needs another: with the authority block's `maxPlayers`
    the default is that less 2 bots (at most 3), and a `bots` count that leaves no seat free is
    refused by name. `genex__room {"action":"status"}` answers the room's last REPORT, its `ctx.log`
    lines and errors, and `rooms`: more than 1 (its `warning`) means players did not all fit and
    opened another room, so start with fewer bots. Read it while the room runs, as the card's testing reference describes. Stop it with
    `genex__room {"action":"stop"}`. The preview hands the game the room's address through the
    embed SDK's local test mode (`getAuthorityUrls()`): never write the address into the game.
- Before a publish, validate, then play it in a local room with bots, and say what you saw. Never
  report a server-authoritative game as online before a draft of it passed.

## Packages

- `genex__package {"package":"@genex-ai/multiplayer"}` adds both SDKs at Studio's pins (nobody is
  asked): `@genex-ai/multiplayer` with `@genex-ai/multiplayer/authority`, and `@genex-ai/embed-sdk`
  with `getAuthorityUrls`. Never run `npm i` for them yourself; the card's step 4 does not apply.
- `@genex-ai/authority-dev` ships with Studio: never install it in the game.
- A room module imports nothing at runtime from a package, and imports the game's own files only
  from folders inside the game (`src/`, `shared/`), never a file at the game's top level or in a
  hidden folder: the publish refuses those, and a link anywhere on the way.

## A game made from Studio's template

- It has no `package.json`: the `authority` block goes in `genex.json` at the game's root, beside
  any other setting: `{"authority": {"module": "server/room.js", "tickHz": 30, "maxPlayers": 8}}`.
  Keep `genex.json` valid JSON and add no package.json beside it: Genex reads a package.json first,
  so a stray one, or a `genex.json` that does not parse, would drop the block. The publish and
  `genex__room` refuse such a game by name (`export_room_manifest_shadowed`,
  `export_room_manifest_broken`) rather than ship it with no room.
- The same `genex__package` call maps `@genex-ai/multiplayer/authority` in its import map; a game
  that mapped multiplayer earlier gets it by making the call again. Never copy the SDK by hand.
- It has no TypeScript build: write the room module and every file it shares with the client in
  plain JavaScript (`server/room.js`, `src/world.js`), without the card's type annotations and
  `import type` lines, importing shared files by their `.js` path.
- Its public copy holds `index.html`, `src/` and `assets/`: keep server-only code in `server/`
  and shared code in `src/`.
- Studio connects the game: never call `initEmbed()`. The `room` for `connectAuthority` is the
  game's slug, from `src/genex.config.js` as the multiplayer card's preface describes
  (`genex__skill {"name":"genex-threejs-multiplayer"}`).

## An Unreal game

- The room module, its `authority` block in `genex.json`, `genex__room` and the publish are the
  same as above: only the client differs. Read `unreal__skill {"name":"unreal-multiplayer"}` for
  it: `unreal__multiplayer` adds Genex's Unreal plugin (shipped with Studio, never fetched by the
  game), and the client joins with its `Genex Authority Subsystem`. Ignore this card's
  `@genex-ai/multiplayer` and embed SDK steps for an Unreal game.

## Reading the references

The card links its references by relative path. Read one with `genex__skill` and the file exactly
as listed, for example
`genex__skill {"name":"genex-authoritative-multiplayer","file":"skills/genex-authoritative-multiplayer/references/module-api.md"}`.

## Commands

`npx genex preview` is `genex__publish {"operation":"draft"}` and `npx genex publish` is
`genex__publish {"operation":"gallery"}`; both carry the room module (above). Other commands map
onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).
