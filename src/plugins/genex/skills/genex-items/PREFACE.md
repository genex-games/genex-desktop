# Genex items in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's items card, unchanged.
Where it disagrees with this preface, this preface wins.

- **Nex is Genex's currency.** Players buy Nex with real money and spend it in the Genex store.
  The card below still calls it coin.
- **A price in Nex is a store item, listed by default.** When the person prices something in Nex
  (a class, a skin, a weapon, a power-up), or asks to sell something for real money without naming
  a currency, each priced thing is a store item. Draw its picture first (the last bullets say
  how), then list it with `shop add` and without asking, so its card shows in the chat: before the
  SDK, the purchase flow or multiplayer, and before or after the game is published. Every item has
  its picture: `shop add` without `image` is refused. Then build it in and wire `buy()` and
  `getEntitlements()`. Store items never wait on a launch or a build: add, change (`shop set`) or
  remove one whenever the person asks, in the chat or in any build. In a Loop, the run's GENEX
  STORE line names the items the launch sold; list each unless `shop list` shows it already.
  Store items never wait on a multiplayer part. A free thing needs no item. Take each price from the store's grid:
  `genex__cli {"command":"shop list"}` prints it once the game is on Genex, and the default grid is
  100, 300, 800, 1,200, 5,000, 20,000 and 50,000 Nex (0 is Free). Use the grid price nearest the
  one the person named and say which.
- **Coins, gold or gems are the game's own.** A price in coins or any other name is a currency the
  game keeps itself, earned by playing: build it with no store item. Only when the person also says
  that currency is for real money, ask once whether they mean Nex, and write the answer in NOTES.md.
- Studio runs the Genex CLI for you; never run `npx genex`. `genex shop add "<name>" … --json` is
  `genex__cli {"command":"shop add","args":"<name>","options":{…}}` with the flags by name:
  `price` (0 is Free), `type`, `description`, `tag` (a list), `shared` (true or false), and
  `image`, `model` and `package`, each a path inside this game, such as
  `".genex/scratch/frost-axe.png"`. Studio copies those files in itself and adds `--json`. It asks
  the person nothing, because a draft spends nothing and sells nothing until the game is
  published. `genex shop set <id>` takes the same options plus `rename`: on a local draft (`local_…`)
  through `genex__cli`, asking nobody, and on an item in the store through `genex__cli-paid`,
  which the person approves.
- Never ask the person whether an item is shared with other games, resellable, consumable or
  which picture it gets before listing it: draw the picture yourself and list it with what you know (`shared` only when they
  said so). When the draft comes back, Studio draws its card in the chat after your reply, with
  "Other games can use it", which is theirs, and shows it on the game's Shop tab. Studio puts every
  item on sale itself when the game is published; `genex shop publish` and `unpublish` are not
  available. Say it is listed, goes on sale with the next publish, and that they can ask for changes.
- In a game that is not on Genex yet, `shop add` keeps the item as a local draft in
  `.genex/items/` (its id starts `local_`; `genex__cli` `shop set|remove <local id>` change it). Leave those
  files to the CLI: Studio carries them. After the game's publish Studio uploads the drafts
  itself and puts them on sale.
  `genex shop sync` is Studio's, not yours.
- `genex items search "<words>"` is `genex__cli {"command":"items search","args":"<words>"}` (and
  `"options":{"tag":["fire"]}`), `genex items list` is `genex__cli {"command":"items list"}`, and
  `genex items add <id>` and `genex items remove <id>` are `genex__cli-paid` with the id in `args`:
  the person approves them, because they change what this game sells. After `items add`, Studio
  writes `genex-items/<id>/` into this game; read it from there.
- Render the picture with the game's own code (the item alone, on a transparent background) and
  save the PNG under `.genex/scratch/`, which Studio never publishes.
- Studio's `@genex-ai/embed-sdk` may not export `ItemState` or report `already_owned` yet: compare
  `item.state === "draft"`, and read `getEntitlements()` again after any `buy()`, whatever it said.
- Studio's preview runs in local test mode with no store: check the cards and the delivery code
  there, then try buying on the published draft (`genex__publish {"operation":"draft"}`). An added
  item reaches this game's store with its next publish (`genex__publish {"operation":"gallery"}`).
