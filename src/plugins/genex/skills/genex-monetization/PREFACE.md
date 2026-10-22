# Genex payments in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's monetization card,
unchanged. Where it disagrees with this preface, this preface wins.

- Sell with the card's dynamic payment requests (`requestPayment`, `getPayment`, `getPayments`).
  They need no CLI call, no `genex shop add` and no item catalog.
- Studio's `@genex-ai/embed-sdk` already exports them. Add the package with
  `genex__package {"package":"@genex-ai/embed-sdk"}` if the game does not have it yet; never run
  the card's `npm install @genex-ai/embed-sdk@latest`. In a game made from Studio's template,
  import them from `"@genex-ai/embed-sdk"` and never call `initEmbed()`: Studio's connect module
  does, as the `genex-threejs-embed-auth` skill describes.
- Studio's preview runs in local test mode, which has no wallet: a payment there never opens the
  platform sheet. Check the buttons, layout and delivery code with the game's own test fixtures.
  A real payment needs a build published on Genex (`genex__publish`), a signed-in player and that
  player's confirmation: tell the user where to try it rather than claiming it works.
- Only a game that already sells catalog items keeps the card's "Existing catalog items" commands:
  `npx genex shop list` is `genex__cli {"command":"shop list"}`, and
  `npx genex shop add|set|remove|test` is `genex__cli-paid` with the item name or sku in `args` and
  the flags by name in `options`. The user approves each paid call, because it changes what the
  game sells.
- Other commands map onto Studio tools as the `genex` skill describes
  (`genex__skill {"name":"genex"}`).
