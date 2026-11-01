# Genex multiplayer in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's multiplayer API card,
with the passages of design advice Studio does not ship taken out. Where it disagrees with this
preface, this preface wins. How to shape a multiplayer game (menus, lobbies, teams, testing
routines) is the game's own call; the optional `genex-recommendations` plugin holds Genex's advice
on it when it is on.

## A Godot or Unity game has its own

This card is for web games written with npm and three.js. A Godot game gets Genex multiplayer from
`godot__multiplayer`, then `godot__skill {"name":"godot-multiplayer"}`; a Unity game from
`unity__multiplayer`, then `unity__skill {"name":"unity-multiplayer"}`. Genex's relays already
serve web, Godot and Unity players.

## Facts the card's removed passages carried

- `connect()` joins the one shared room of the game's slug at once; `matchmake()` puts the player
  in the queue and the server seats them in capped rooms by the preset in `genex.matchmaking`.
- A queued or seated player counts toward `minPlayers` until `mm.cancel()` (or `room.leave()` for
  `connect()`); `matchmake()` and `connect()` are the only calls that reach the relay.
- While `mm.matchmaking.status` is `'searching'` the player is in no room: `players`,
  `connectedPlayers` and `opponents` are empty, `queue.size` counts this player, and with
  `minPlayers === maxPlayers` the room skips `'waiting'`.
- For `open`, `status` goes `searching` → `waiting` → `playing` once and never back; `matchStart`
  and `matchEnded` never fire, and `teams`, `myTeam`, `scores` and `winnerId` stay empty.
  `connectedPlayers` / `session.activePlayers` leave out seats in their reconnect grace.
- The relay runs no game simulation and no anti-cheat: it enforces identity, ownership, seating
  and rate and size caps; a client reports its own state.

## Multiplayer runs on the Genex draft link

- Studio's preview is single-player. It opens a game that uses `@genex-ai/embed-sdk` in local
  test mode (`?genex_local_test=1`): the relay gets no credential there, so `connect()` and
  `matchmake()` fail by design. Rendering and controls still run in the preview.
- The draft link is multiplayer. A draft plays in rooms of its own, apart from the live game, so
  testers on the draft link meet each other and never real players. Anyone with the link can join,
  as a guest or signed in, before the game is published to the gallery. Two tabs on one account
  are one player: the newer tab takes the seat (close code 4409).
- `genex__package {"package":"@genex-ai/multiplayer"}` adds both SDKs in one call (it includes
  embed-sdk; nobody is asked). `genex__publish {"operation":"draft"}` puts a draft online and
  `genex__publish-status` gives its link.
- Nobody can save or buy on the draft link, the owner included: saves and purchases work once the
  game is published.
- Studio installs the version it pins, which satisfies the card's `^0.17.0`. Never run
  `npm i` for these packages yourself.
- A game made from Studio's template has no `package.json`: it loads three.js through an import
  map, and the same `genex__package` call maps Studio's copies of both SDKs into that map and loads
  Studio's connect module after it, with nothing downloaded. Studio connects the game: never call
  `initEmbed()`, skip the card's Bootstrap step, `genex.config.ts` and "Config without `genex init`"
  below, and never write a slug. Import the rest exactly as the card shows (`waitForPlayer`,
  `getColyseusAuth` and `getColyseusUrls` from `"@genex-ai/embed-sdk"`), in plain JavaScript: the
  template has no TypeScript build, so leave out the card's type annotations. Its settings go in
  `genex.json` at the game's root (`{"matchmaking": {...}}`) wherever the card says package.json's
  `genex` field. Never copy the SDK into the game by hand.
- A game with its own build but no `package.json` needs one before `genex__package`.
- When approval is declined or times out, or the hosted test route is unavailable, the answer
  names the blocker; a declined request is not repeated without the user asking again.

## Config without `genex init`

A remixed game already has a `src/genex.config.*` (and maybe a `.env`) naming the game it was
copied from. A config naming another game signs every player into that other game, so Genex
refuses to deploy it. Publish a draft; when it is refused for naming another game, read this game's
slug from `genex__publish-status`, set it in the config, and publish the draft again.

Studio never runs `genex init`, so a new game starts without `src/genex.config.ts` or `.env`. After
the first draft, `genex__publish-status` reports the game's `slug`. Write the config yourself,
then publish a new draft (a template game: `src/genex.config.js`, the same object without
`as const`, imported as `./genex.config.js`):

```ts
// src/genex.config.ts
export const GENEX = {
  slug: "<the slug genex__publish-status reported>",
  apiUrl: "https://api.genex.games",
  dashboardOrigins: ["https://genex.games"],
} as const;
```

## Reading the reference

The card links its reference by relative path. Read it with `genex__skill` and the file exactly as
listed: `skills/genex-threejs-multiplayer/references/realtime-patterns.md`, for example
`genex__skill {"name":"genex-threejs-multiplayer","file":"skills/genex-threejs-multiplayer/references/realtime-patterns.md"}`.

## Commands

`npx genex controller …` commands are not available in Studio: chat, voice and the character are
built from the SDK calls the card shows. Commands map onto Studio tools as the `genex` skill
describes (`genex__skill {"name":"genex"}`).
