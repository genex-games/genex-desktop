# Genex payments in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's monetization card,
unchanged. Where it disagrees with this preface, this preface wins.

- Genex's currency is Nex; the card below calls it coin. Anything with a fixed price in Nex (a
  class or level unlock, a skin, an item), or anything the person wants to sell for real money
  without naming a currency, is a Genex store item: follow the `genex-items` skill
  (`genex__skill {"name":"genex-items"}`) and list it with `shop add` and its picture by default,
  at any time, so its card shows in the chat. That is the default in Studio, whatever the card below says about catalogs. A price
  in coins, gold or gems is the game's own currency, unless the person says it is for real money:
  then ask once whether they mean Nex.
- The card's dynamic payment requests (`requestPayment`, `getPayment`, `getPayments`) are only for
  an amount decided while playing, such as a player-approved action. They need no CLI call.
- Studio's `@genex-ai/embed-sdk` already exports them. Add the package with
  `genex__package {"package":"@genex-ai/embed-sdk"}` if the game does not have it yet; never run
  `npm install` for it. In a game made from Studio's template, import them from
  `"@genex-ai/embed-sdk"` and never call `initEmbed()`: Studio's connect module does, as the
  `genex-threejs-embed-auth` skill describes.
- Studio's preview runs in local test mode, which has no wallet: a payment there never opens the
  platform sheet. Check the buttons, layout and delivery code with the game's own test fixtures.
  A real payment needs a build published on Genex (`genex__publish`), a signed-in player and that
  player's confirmation: tell the user where to try it rather than claiming it works.
- Store items (a picture, a description, a draft the person puts on sale, items other games can
  use, another creator's item) follow the `genex-items` skill, which says how Studio runs
  `genex shop add … --json` and `genex items add`.
- The card's "Existing catalog items" commands are how every store item is listed in Studio:
  `npx genex shop list` is `genex__cli {"command":"shop list"}`, `npx genex shop add` is
  `genex__cli` with the item name in `args` and the flags by name in `options` (a draft, which asks
  nobody), and `npx genex shop set|remove|test` on an item in the store is `genex__cli-paid` with the sku in
  `args` (on a local draft, `genex__cli`). The
  user approves each paid call, because it changes what the game sells. `genex shop publish` is not
  available: Studio puts the game's items on sale when it is published.
- Other commands map onto Studio tools as the `genex` skill describes
  (`genex__skill {"name":"genex"}`).
