# Genex player identity in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's embed-auth card,
unchanged. Where it disagrees with this preface, this preface wins.

## Where each part can be tested

- Studio's preview opens a game that uses `@genex-ai/embed-sdk` in local test mode
  (`?genex_local_test=1`) for you. Rendering, controls, HUD and feel can be checked there.
  Sign-in, saves, leaderboards and multiplayer cannot: that is expected, not a bug to chase.
- The owner can try sign-in and multiplayer on the published Genex draft: build the game, add the
  package with `genex__package {"package":"@genex-ai/embed-sdk"}`, publish a draft with
  `genex__publish {"operation":"draft"}`, wait with `genex__publish-status`, then hand the draft
  link to the user. Label your evidence as the card asks.
- Server saves never persist on the draft: loads and saves resolve `{ staging: true }` there by
  design, as the card says. They persist only once the game is published to the gallery, which
  happens only when the user wants it public. Keep the card's localStorage fallback.
- Studio installs the version it pins. Never run `npm i` for this package yourself.
- A game made from Studio's template has no `package.json`: there
  `genex__package {"package":"@genex-ai/embed-sdk"}` maps Studio's copy in the import map, as
  three.js is, and loads Studio's connect module after it. Never copy the SDK into the game by
  hand. Read "In a game made from Studio's template" below.
- Studio connects every web game it publishes that brings no SDK of its own, so genex.games can
  sign its players in. A game needs the SDK only to use identity, saves or leaderboards itself.

## In a game made from Studio's template

Studio connects a template game to Genex itself: its connect module calls `initEmbed()` before the
game's own code runs, in local test mode in Studio's preview and with the game's project once it is
published. Skip the card's Bootstrap step and `genex.config.ts`: never call `initEmbed()` and never
write a slug. Import everything else from `"@genex-ai/embed-sdk"` as the card shows
(`waitForPlayer`, `loadPlayerState`, `savePlayerState`, `submitScore`, `getLeaderboard`), with the
renderer first and the awaits where a name or a save is needed. Keep the import-map entry and the
connect module's `<script>` that `genex__package` added.

## Config without `genex init`

In a game with its own `package.json`, Studio never runs `genex init`, so the game starts without `src/genex.config.ts` or `.env`, and
"re-run `genex init`" is not available. After the first draft, `genex__publish-status` reports the
game's `slug`. Write the config yourself, then publish a new draft (a template game:
`src/genex.config.js`, the same object without `as const`, imported as `./genex.config.js`):

```ts
// src/genex.config.ts
export const GENEX = {
  slug: "<the slug genex__publish-status reported>",
  apiUrl: "https://api.genex.games",
  dashboardOrigins: ["https://genex.games"],
} as const;
```

## Commands

`genex preview` is `genex__publish {"operation":"draft"}`, and the update nudge the card mentions
does not apply: Studio pins its Genex packages. Other commands map onto Studio tools as the
`genex` skill describes (`genex__skill {"name":"genex"}`).
