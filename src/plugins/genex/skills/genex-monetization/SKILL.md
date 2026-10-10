# Genex shops in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's monetization card,
unchanged. Where it disagrees with this preface, this preface wins.

- `npx genex shop list`: `genex__cli {"command":"shop list"}`.
- `npx genex shop add|set|remove|test`: `genex__cli-paid`, with the item name or sku in `args` and
  the flags by name in `options`, for example
  `genex__cli-paid {"command":"shop add","args":"Iron Key","options":{"price":100,"type":"durable"}}`.
  The user approves each call, because it changes what the game sells.
- Shop commands need the game's hosted project: publish a draft with
  `genex__publish {"operation":"draft"}` first.
- `npx genex image` for item art is `genex__asset` with operation `image`; use the image URL it
  reports as the item's `icon`.
- Other commands map onto Studio tools as the `genex` skill describes
  (`genex__skill {"name":"genex"}`).

<!-- upstream @genex-ai/cli-demo/templates/skills/genex-monetization/SKILL.md v1.36.2 sha256 e48b5404bbc451f324e61d3b027f6176fd55412cb297f1066416969afc64a0e0 -->
---
name: genex-monetization
description: Build an in-game shop that sells for platform coin — item catalog, purchase flow, delivery, and the per-game soft-currency economy a purchase attaches to. Use when the player asks to sell things, add a shop, monetize, or make the game earn. Carries the hard rules: no paid randomness, no gambling in coin, no donation mechanics, and a real-money price beside every coin price.
---

# Genex Monetization

Games on Genex can sell things for **coin**, the platform currency. The player
buys coin with real money once; spending it inside a game is a ledger movement
the game never touches. You design what is for sale; the platform owns the
wallet, the confirmation, and the money.

Load this when the game should sell something. Ask first if it should — a game
with no loop worth monetizing is better without a shop (see §1).

## The hard rules, and the test that generalizes them

Before you build ANY purchasable thing, run this test:

> **Does the player pay?** (with coin, or with anything bought with coin —
> directly or indirectly, including a per-game token or key that coin bought.)
> **Is the outcome uncertain when they pay?**
> **Is there a prize** — an item, currency, or advantage they wanted?
>
> **All three yes = paid randomness. Build the deterministic version instead.**

That triad is the test used by every app store to identify gambling, and it
catches mechanics that do not exist yet — which a list of banned names cannot.

Four things are never built, whatever the request:

1. **No paid randomness.** No loot boxes, gacha, mystery boxes, crates, packs,
   prize wheels, raffles, "spin for a bonus", "chance to double your coins".
   Directly or indirectly.
2. **No gambling in coin.** No wagering, staking, betting, coinflips, casino or
   slot mechanics denominated in coin or in anything coin buys.
3. **No donation or begging mechanics.** No "donate to me" prompts, tip jars, or
   player-to-player coin transfers. Coin buys goods; it never just moves.
4. **No pressure.** No countdown timers, "ends in", "limited time", "only N
   left", or stock counters anywhere in the shop.

**Randomness the player EARNS by playing is gameplay, not commerce, and is
completely fine**: an enemy dropping a random item, a chest you found in the
level, a procedural layout, a critical-hit roll, a shuffled deck. The line is
what triggered the roll — play, or payment. Build those freely.

Genex refuses paid randomness outright rather than allowing it with disclosed
odds. That is stricter than any app store, and it is why no Genex game needs an
odds table, an age gate, or a per-country check.

### When a request crosses a line

Answer in exactly three parts, then build:

1. **Name it.** "A loot crate is paid randomness — the player pays before
   knowing what they get."
2. **Why.** One sentence. "Genex doesn't sell chance; it's a purchase the player
   can't price, and it's what regulators fine studios over."
3. **Offer the alternative,** concretely enough to start on, and build that.

Never build the banned version "as an option", never build a partial one, and
never ask the user to confirm they want it. If they insist, restate the rule
once and build the compliant version. There is no escalation path.

**What to build instead:**

| They asked for | Build |
| --- | --- |
| Loot box, crate, mystery box, card pack | A direct-purchase shop: every item listed at a fixed price, contents visible. For the collecting feel, add a **visible catalog with a completion track** — any purchase advances a meter to a stated milestone reward. |
| Gacha, banner, pull, summon | A **deterministic unlock**: the character costs a fixed price, or unlocks at a stated number of runs. Coin may buy a stated, visible number of those points. |
| Prize wheel, spin-to-win, slot machine | A **free spin earned by finishing a run** (never bought), or a **"pick one of three"** screen where all three are visible and the player chooses. Keeps the moment, drops the wager. |
| Casino game, blackjack, poker, roulette | The same game with **chips that are granted free each session, reset on restart, cannot be bought and cannot become coin**. It becomes a card game. Sell cosmetics — table felt, card backs — for coin. |
| Coinflip, double-or-nothing, wager my coins | A **skill-based risk/reward inside the run**: a harder route with a bigger payout, staking the run's own score, which was never purchasable. |
| Betting on matches, PvP wagers | **Leaderboards with a fixed cosmetic reward for placement**, paid by the game. Nobody's balance goes down. |
| Donate button, tip jar, "pls donate" | A **gift that is a purchase**: they buy a specific item at a stated price and give it. Or a **supporter cosmetic** — a badge or aura at a normal price, where what's delivered is visible. |
| Pay to remove a wait / energy gate | **Delete the gate** and sell a permanent upgrade or a cosmetic. Pace with difficulty, not with a timer. |
| Limited-time offer, flash sale | A **permanent tiered ladder** — the value comes from volume, not from a clock. |
| Pay-to-win stat boost in a competitive game | **Cosmetics**, or a boost that only applies in single-player content. |

## Designing a shop worth buying from

Nine checks. Each one is answerable about your actual design.

1. **The shop attaches to a progression that already exists.** Name the screen
   it opens from and the meter a purchase moves. Build the loop first; a shop in
   a game with nothing to want is furniture.
2. **A boost shortens a grind the player has already felt.** State it in one
   sentence: "this skips the ore-gathering they've done four times." If you
   can't, it isn't a boost, it's a number.
3. **Nothing sold invalidates the core loop.** If a paying and a non-paying
   player both reach the end, the payer must not have skipped the part that IS
   the game.
4. **No manufactured friction.** If the annoyance wouldn't exist without the
   shop, remove the annoyance instead of selling the cure.
5. **Everything sold is reachable free.** Spending is a shortcut or a
   decoration, never the only path.
6. **Prices land on the grid.** Item prices use 50 / 100 / 200 / 500 / 1000 coin
   so every coin pack divides evenly into them and nobody is left holding change
   they cannot spend.
7. **Every price shows real money next to it.** The server sends
   `priceDisplayUsdCents` with every item — render it. `250 coins ($2.49)`.
8. **One currency layer between money and goods.** Coin buys items. A per-game
   earned currency buys per-game upgrades. They never convert into each other.
9. **Purchases never expire and survive a reinstall.** Entitlements live on the
   server; the game re-reads them on every boot.

For a per-game earned currency, the load-bearing number is **minutes of play per
unit earned**. Set it, then price the cheapest meaningful item at one to three
sessions of earning. Everything else follows. Spend sinks come in three kinds —
permanent upgrades, refills, cosmetics — and cosmetics are what absorbs late-game
currency without touching balance.

## Stocking the shop

Items live on the platform, not in the game's code. You create them with the CLI,
and the game names them by id — which is what stops a game inventing its own
items or repricing them.

```bash
npx genex shop add "Iron Key" --price 100 --type durable
#   → id: sku_a1b2c3   ← what the game passes to buy()

npx genex shop list                    # what this game sells, and the valid prices
npx genex shop set sku_a1b2c3 --price 200
npx genex shop remove sku_a1b2c3       # retires it; players who bought it keep it
```

`--type consumable` (default) is spent on use; `durable` is owned permanently.

**Prices come off a fixed grid** — `genex shop list` prints it, and an off-grid
price is refused. The grid exists so every coin pack divides evenly by the
cheapest item, which is what stops a player being left holding change too small
to spend. Pick the nearest grid price rather than working around it.

Record the ids in `DESIGN.md` next to what each item does. They are the one
thing the game's code cannot regenerate for itself.

## Item art

**Every item ships with a picture.** `--icon` is optional to the command and not
optional to the product: a SKU with no icon renders as a coloured plate with a
generic box on it, in your shop and on the platform's resale market, where it
sits next to other games' items that do have art.

**It has to be the item.** Not "a fantasy key" — *this* key, the one the player
just picked up, in this game's light and this game's palette. An icon that shows
a different object than the world does is worse than the plate, because the
plate at least does not claim anything.

So if the item exists as an asset — a generated model, a sprite, a texture —
generate the art FROM it. Point the camera at the model in the game, or use the
asset image, and feed that frame in as the reference:

```bash
# 1. capture the real item -> ./iron-key-ref.png  (crop it SQUARE, see below)
npx genex image "shop item art of the exact object in the reference image: an ornate iron key, centred, lit from above with a soft rim light, on a clean dark backdrop, no text, no watermark, no interface" \
  --edit ./iron-key-ref.png --quality high
#    -> https://assets.genex.technology/generations/<id>/image-main

# 2. attach it
npx genex shop add "Iron Key" --price 100 --type durable --icon <that url>
npx genex shop set sku_a1b2c3 --icon <that url>     # or fix one later
```

`--edit` takes a **local file** (≤ 4 MB) as well as an asset URL, so a screenshot
goes straight in. Two things about that lane:

- **It keeps the reference's shape**, so `--aspect` does nothing here — crop the
  reference square before you pass it, or you will get a wide icon in a square
  cell.
- It is a different model from the plain text lane, and a better one for this
  job, because the reference is what makes the picture the item and not a
  picture of the idea.

No asset yet? Same prompt without `--edit`, anchored on the item's name and on
**the game's own vibe words** — take them from `DESIGN.md` rather than inventing
a style, and generate the whole shop in one sitting with the same style clause
so the shelf reads as one set.

Prompt shape, and every clause earns its place: one object, centred, on a clean
simple backdrop, lit the way the game lights things, closing with *no text, no
watermark, no interface*. Say what you want, never what you don't — an image
model reads "no swords" as "swords", so a ban only works when the thing is
absent from the prompt entirely.

## The API

From `@genex-ai/embed-sdk`, already installed. `initEmbed()` must have run.

```ts
import { getShop, buy, getEntitlements, consumeEntitlement } from '@genex-ai/embed-sdk';

const items = await getShop();
// [{ id, type, name, iconUrl, priceCoins, priceDisplayUsdCents }]
```

Render `name`, `iconUrl`, `priceCoins` **and** `priceDisplayUsdCents`. Never
hardcode a price: the server charges what its own catalog says, so a hardcoded
number can silently disagree with what the player is charged.

`getShop()` works for a **guest** and inside a **preview** build, so the shop
window renders for everyone — that is the point of showing it to a signed-out
player at all. Buying is what needs an account.

**Your game cannot read the player's coin balance, and no HUD should show one.**
The wallet spans every game on the platform, so an untrusted game is not told how
much a player can spend. Show what you *can* know — what they own, from
`getEntitlements()` — and let `buy()` report `insufficient_balance` if it comes
to that.

### Buying

```ts
buyButton.addEventListener('click', async () => {   // must be a real click
  const result = await buy({ skuId: item.id });
  if (result.status === 'canceled') return;         // normal — say nothing
  if (result.status !== 'succeeded') {
    showMessage(result.message ?? 'That did not go through.');
    return;
  }
  await deliverPending();
});
```

**Call `buy()` synchronously from the click handler.** On the game's own origin
the confirmation is a popup, and browsers only allow one while a user gesture is
live — an `await` before it loses the gesture and nothing opens.

`buy()` resolves when the SERVER says what happened, not when a window closes.
Statuses: `succeeded`, `canceled`, `expired`, `insufficient_balance`, `failed`.

The player confirms on a Genex-drawn surface — your game does not render the
price sheet, cannot skin it, and cannot complete a purchase itself. That is
deliberate: it is what lets a player trust a purchase in a game they have never
played before.

### Delivering

```ts
async function deliverPending() {
  for (const e of await getEntitlements({ excludeConsumed: true })) {
    // Branch on skuType (consumable | durable), NEVER on type — `type` is how
    // it was acquired (purchase/gift/test/free) and can't answer this.
    if (e.skuType === 'durable') {
      wear(e.name);            // ownership, re-applied on every boot. Do not consume.
      continue;
    }
    const { alreadyConsumed } = await consumeEntitlement(e.id);
    if (alreadyConsumed) continue;                  // someone got there first
    applyItem(e.skuId);                             // AFTER the consume
    await savePlayerState(currentSave());
  }
}
```

**Consume first, apply second, and run `deliverPending()` on every boot.**

That order is not stylistic. If the game dies between consuming and applying,
the player loses one item — a support ticket. If you apply first and die before
consuming, every boot re-delivers it forever — an exploit. Re-listing on boot is
what makes a purchase survive a crash, a refresh, or a closed tab.

**`e.skuType` is the field that decides this, not `e.type`.** `type` says how the
player got it (`purchase`/`gift`/`test`/`free`); `skuType` says what it is
(`consumable`/`durable`).

A **consumable** is spent: consume it, then apply the effect once.

A **durable** is owned forever, and you have two honest ways to handle it. If the
effect is ownership — a cosmetic, a skin, an unlock — do **not** consume it: the
row's presence in the list IS the ownership, it survives reinstalls, and there is
no local save to drift out of sync. Only consume a durable when it grants
something once and non-idempotently (a permanent +100 gold), and then record it
in the player's save, because re-applying that on every boot would be a bug.

### Testing the shop you just built

```bash
npx genex shop test <sku-id>     # a free copy, for the owner only
```

That grants the entitlement without a sale — no coin moves — so the delivery
path, the inventory and the effect all run exactly as they would after a real
purchase. Reload the game and it should be there.

You *can* also just buy your own item, but it costs you the full price and pays
you nothing: your share of a sale you funded goes to the platform, never into
your own earnings. Use the test grant instead.

## Checklist

- [ ] Items exist (`npx genex shop list`) before the shop UI is written
- [ ] Delivery was verified with `npx genex shop test`, not by trying to buy your own item
- [ ] The game has a loop and a progression before it has a shop
- [ ] Every item price is on the 50/100/200/500/1000 grid
- [ ] Every price renders `priceDisplayUsdCents` beside the coin figure
- [ ] `buy()` is called synchronously inside a click/tap handler
- [ ] `canceled` is silent; only real failures show a message
- [ ] `deliverPending()` runs on every boot, before the player can act
- [ ] `consumeEntitlement()` is awaited BEFORE the effect is applied
- [ ] `alreadyConsumed: true` skips the effect
- [ ] Durable purchases are written to the player's save
- [ ] No timer, "limited", "ends in", or stock counter anywhere
- [ ] Nothing sold is unreachable without paying
- [ ] No paid randomness, no coin wagering, no donation prompt

## Troubleshooting

**`buy()` returns `failed` with "the confirmation window was blocked"** — `buy()`
was not called inside a user gesture, or an `await` ran before it. Move it to the
first line of the click handler.

**The purchase succeeded but the player got nothing** — the game applied the
effect without consuming, or never ran `deliverPending()` on boot. The
entitlement is still there; re-list it.

**The player got the item twice** — the effect was applied before consuming, or
`alreadyConsumed` was ignored. Both are the same bug.

**`unauthorized` from `getShop()`** — no player identity yet. `initEmbed()` must
have run and `waitForPlayer()` resolved. See `$genex-threejs-embed-auth`.

**`guest_no_wallet`** — guests play but hold no wallet. Show the shop as
sign-in-to-buy rather than hiding it.

**`staging_no_purchase`** — a `genex preview` build cannot spend real coin. Test
the shop's layout on staging; test a purchase after `genex promote`.

**`getShop()` returns nothing** — the game has no items yet. `npx genex shop add
"<name>" --price <coin>` and use the id it prints.

**`price_off_grid`** — that price isn't on the platform's grid. `npx genex shop
list` prints the valid ones; pick the nearest.

**Everything coin-related 404s** — in-game purchases aren't enabled on this
environment. Nothing to fix in the game; say so and build the rest.

**Purchases do nothing in local testing** — local test mode has no wallet and no
server. `buy()` returns `failed` immediately by design. Test purchases on a
preview or published build.
