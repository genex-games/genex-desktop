# Genex items in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's items card, unchanged.
Where it disagrees with this preface, this preface wins.

- **Store items are the default for anything players pay for.** When the person gives a price in
  coins, or the game has something players buy or unlock (a class, a skin, a weapon, a power-up),
  those are Genex coins and each priced thing is a store item, unless the person says the coins
  are earned by playing. Never invent a currency of the game's own for it, and never leave the
  store out of a plan or a build. Without asking, build the thing into the game, then list it with
  `shop add` so its card shows in the chat, before or after the game is published. A free thing
  needs no item. Take each price from the store's grid: `genex__cli {"command":"shop list"}`
  prints it once the game is on Genex, and the default grid is 100, 300, 800, 1,200, 5,000, 20,000
  and 50,000 coin (0 is Free). Use the grid price nearest the one the person named and say which.
- Studio runs the Genex CLI for you; never run `npx genex`. `genex shop add "<name>" … --json` is
  `genex__cli-paid {"command":"shop add","args":"<name>","options":{…}}` with the flags by name:
  `price` (0 is Free), `type`, `description`, `tag` (a list), `shared` (true or false), and
  `image`, `model` and `package`, each a path inside this game, such as
  `".genex/scratch/frost-axe.png"`. Studio copies those files in itself and adds `--json`; the
  person approves each call. `genex shop set <id>` takes the same options plus `rename`.
- When the draft comes back, Studio draws its card in the chat after your reply, with **Put on
  sale** and "Other games can use it". `genex shop publish` and `unpublish` are not available:
  only the person puts an item on sale, from that card or Create › Items. Say it is ready and that
  they can ask for changes.
- In a game that is not on Genex yet, `shop add` keeps the item as a local draft in
  `.genex/items/` (its id starts `local_`; `shop set|remove <local id>` change it). Leave those
  files to the CLI: Studio carries them. Its card offers **Sell when published**; after the game's
  publish Studio uploads the drafts itself and puts on sale only what the person approved, unchanged.
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
