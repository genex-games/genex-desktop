# Genex multiplayer in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's multiplayer card,
unchanged. Where it disagrees with this preface, this preface wins.

## A Godot or Unity game has its own

This card is for web games written with npm and three.js. A Godot game gets Genex multiplayer from
`godot__multiplayer`, then `godot__skill {"name":"godot-multiplayer"}`; a Unity game from
`unity__multiplayer`, then `unity__skill {"name":"unity-multiplayer"}`. Stop reading here for those,
and never write a relay server of your own: Genex's relays already serve web, Godot and Unity players.

## Multiplayer runs on the Genex draft link, with two different players

- Studio's preview is single-player. It opens a game that uses `@genex-ai/embed-sdk` in local
  test mode (`?genex_local_test=1`): the relay gets no credential there, so `connect()` and
  `matchmake()` fail by design. Rendering, controls and feel can still be checked in the preview.
- The draft link is multiplayer. A draft plays in rooms of its own, apart from the live game, so
  testers on the draft link meet each other and never real players. Anyone with the link can join,
  as a guest or signed in, before the game is published to the gallery.
- Check prerequisites before building online features: the pinned SDKs and an authorized hosted
  test route. Add both SDKs in one call with
  `genex__package {"package":"@genex-ai/multiplayer"}` (it includes embed-sdk; nobody is asked).
  Then build the game; publish a draft with
  `genex__publish {"operation":"draft"}`; wait with `genex__publish-status`; then test on the draft
  link as TWO DIFFERENT players. Hand the user the link and tell them exactly how: open it in a
  normal window and an incognito window (the incognito one plays as a guest), or send it to a
  friend. Two tabs on one account are one player: the newer tab takes the seat. Until two players
  have played the draft, say plainly that multiplayer was not exercised.
- Nobody can save or buy on the draft link, the owner included. Test saves and purchases after
  publishing.
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
- A game with its own build but no `package.json` needs one first: give it one, then call
  `genex__package`. A game's shape is never a reason to refuse multiplayer: restructure what you
  must, and keep its single-player play working.

- If approval is declined or times out, or the hosted test route is unavailable, report the
  specific blocker. Preserve local play; do not retry without changed authorization or claim
  multiplayer works. Finish independent required work before optional visual polish.

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

## Reading the references

The card links its references by relative path. Read one with `genex__skill` and the file exactly
as listed:

- `skills/genex-threejs-multiplayer/references/realtime-patterns.md`
- `skills/genex-threejs-multiplayer/references/genre-recipes.md`
- `skills/genex-threejs-multiplayer/references/host-physics.md`
- `skills/genex-threejs-multiplayer/references/genex-netcode-feel-checklist.md`

For example: `genex__skill {"name":"genex-threejs-multiplayer","file":"skills/genex-threejs-multiplayer/references/genre-recipes.md"}`.

## Commands

`npx genex controller chat`, `npx genex controller voice` and `genex controller character` are not
available in Studio: build chat, voice and the character from the SDK calls the card shows.
Commands map onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).
