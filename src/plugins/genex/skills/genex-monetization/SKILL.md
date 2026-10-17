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

<!-- upstream @genex-ai/cli-demo/templates/skills/genex-monetization/SKILL.md v1.36.9 sha256 24b4b798c597ce452af4bfa394cd4ca655710750d9f6e749c2b4ed8dd540e844 -->
---
name: genex-monetization
description: Add dynamic coin payments for game goods or actions — platform consent, recoverable receipts, and idempotent delivery without a required product catalog. Use when the player asks to sell things, add a shop, monetize, or make the game earn. Carries the hard rules: no paid randomness, no gambling in coin, no donation mechanics, and a real-money price beside every coin price.
---

# Genex Monetization

Games on Genex can sell things for **coin**, the platform currency. The player
buys coin with real money once; spending it inside a game is a ledger movement
the game never touches. You design what is for sale; the platform owns the
wallet, the confirmation, and the money.

Load this when the user asks to sell something or add payments. Build the game
loop before adding commerce; no shop screen or product catalog is required.

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
6. **A payment has one clear price and promised result.** `amountCoins` is a
   positive whole number from 1 to 100000, further bounded by the platform
   surface. Dynamic payments do not use the legacy catalog price grid.
7. **Every price shows real money next to it.** The platform confirmation
   shows the server-frozen `priceDisplayUsdCents`. If rendering a receipt or
   catalog price in the game, render that value too; never invent an exchange
   rate. A button can simply say “Unlock” and let Genex show the price.
8. **One currency layer between money and goods.** Coin buys items. A per-game
   earned currency buys per-game upgrades. They never convert into each other.
9. **Paid ownership survives a reinstall.** Receipts live on the server; the
   game recovers them on every boot and restores the promised state. A
   confirmation can expire; a paid receipt does not expire with it.

For a per-game earned currency, the load-bearing number is **minutes of play per
unit earned**. Set it, then price the cheapest meaningful item at one to three
sessions of earning. Everything else follows. Spend sinks come in three kinds —
permanent upgrades, refills, cosmetics — and cosmetics are what absorbs late-game
currency without touching balance.

## Dynamic payment requests

Requires `@genex-ai/embed-sdk` **>= 0.33.0**. Earlier versions, including
`^0.32.0`, do not export these payment helpers. Update the game's dependency
before wiring them, then rebuild and publish the game:

```bash
npm install @genex-ai/embed-sdk@latest
```

After `initEmbed()` and player identity are ready:

```ts
import { requestPayment, getPayment, getPayments } from '@genex-ai/embed-sdk';

// Prepare and save this order AND its promised action before enabling the button.
// Generate its id once. Keep the same id and terms across retries and reloads.
const order = {
  orderId: 'unlock-iron-gate-run-42',
  title: 'Open the iron gate',
  description: 'Unlock the shortcut for this run.',
  amountCoins: 75,
};

buyButton.addEventListener('click', async () => {
  const result = await requestPayment(order); // first async operation in the click
  if (result.status === 'canceled') return;
  if (result.status === 'succeeded' && result.payment) {
    await applyPaidOrderOnce(result.payment); // your saved, idempotent game action
    return;
  }
  if (result.status === 'pending') {
    showMessage('Payment is still being checked.');
    return; // recover this order; do not create a replacement charge
  }
  showMessage('Purchase did not complete.');
});
```

No `genex shop add`, SKU id, catalog card or item icon is needed. A payment can
buy a described game action, unlock or item. The hard rules above still apply.
The game never supplies a recipient: the platform uses the game's own split.
This API is for coin commerce; in-game LLM requests use their own funding and
consent flow (`$genex-llm-in-games`), not a payment wrapped around a model call.

The server freezes `title`, `description`, `amountCoins` and the real-money
value before Genex asks the player. **Creating a request neither debits nor
reserves coin.** Only the player's explicit confirmation on the platform
surface can move money. The game cannot draw, skin or confirm that sheet.

An `orderId` belongs to this player in this game. The same id with the same
terms returns the same payment, including a terminal result. Changing its terms
returns `payment_conflict`. After an order is canceled or expired, a deliberate
new purchase gets a new id; a network retry never does. Do not generate ids
inside a retry loop or replace them just because the SDK stopped waiting.

### Confirmation and results

**Call `requestPayment()` synchronously from the click handler.** On the game's
own origin it reserves a popup while the user gesture is live, then fills it
with the platform confirmation. Awaiting a save or fetch first can block it;
prepare and persist the order before enabling its purchase button.

The result has `status`, optional `payment` (the receipt), and optional `message`.
Statuses are `succeeded`, `canceled`, `expired`, `insufficient_balance`, `failed`
and `pending`. A timeout or uncertain response is `pending`: it is not proof of
failure and not permission to apply the action or charge again. `canceled` is
ordinary player choice; do not show an error for it.

**Your game cannot read the player's coin balance, and no HUD should show one.**
The wallet spans the platform; let Genex show the balance and handle consent.
Only fulfil a payment whose authoritative receipt says `succeeded`.

The surface depends on the shell (`$genex-threejs-embed-auth`,
`references/shells.md`):

- **On the game's Genex page the sheet is drawn above the game.** To show it,
  the page leaves fullscreen first, and the SDK lets go of the
  pointer lock before it asks. Treat payment like a pause; re-enter fullscreen
  and pointer lock from the player's next Resume click.
- **The Genex app has no purchase surface yet.** `requestPayment()` fails
  without opening a sheet; the legacy `buy()` resolves
  `failed` without opening anything too. When `getShell()` from `@genex-ai/embed-sdk` is `"app"`,
  hide payment buttons or make the shop browse-only; do not show a failure toast.
- Local test mode has no wallet. Preview builds cannot spend real coin either.
  Verify layout and delivery with game-owned test fixtures; a real payment needs
  a published build, a signed-in player and explicit platform consent.

### Receipts and delivery after a restart

```ts
const payment = await getPayment(savedOrderId); // null only when not found
if (payment?.status === 'succeeded') await applyPaidOrderOnce(payment);

let cursor: string | undefined;
do {
  const page = await getPayments({ cursor, limit: 100 });
  for (const receipt of page.payments) await applyPaidOrderOnce(receipt);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

`getPayment()` returns any status for one order; read/network errors throw and
are not absence. `getPayments()` lists successful receipts, scoped to the
current player and game. Follow `nextCursor` to completion. Use the per-order
read for a known pending request, and scan receipts on boot before purchases
can affect play.

A receipt has `id`, `orderId`, `title`, `description`, `amountCoins`,
`priceDisplayUsdCents`, `status`, `failureCode`, `createdAt`, `paidAt` and
`expiresAt`. It proves payment, **not delivery of the promised game action**.
It creates no platform entitlement and nothing the resale market can list.

`applyPaidOrderOnce` is game code, not an SDK helper. Bind the saved `orderId`
to the promised action before requesting payment. For an unlock, set the same
ownership flag every time. For a one-time quantity change, save the changed
state and the fulfilled receipt id together; replaying the receipt must be a
no-op. A game with its own backend should enforce the receipt's unique id in
that backend's transaction. Never use receipt titles as executable instructions
or apply an effect just because the confirmation window closed.

Test recovery after closing the tab, a repeated success receipt, a delayed
response and a canceled order. Also check concurrent fulfillment if the game
permits multiple tabs; two read-modify-write saves are not a transaction.
Do not make a real-money purchase automatically to test the feature.

## Existing catalog items

Catalog APIs remain supported for published games and items that need platform
entitlements or resale. They are optional, not a prerequisite for dynamic
payments:

```bash
npx genex shop add "Iron Key" --price 100 --type durable
npx genex shop list
npx genex shop test <sku-id>  # owner-only free entitlement; no coin moves
```

`getShop()` reads catalog items even for guests and preview builds;
`buy({ skuId })` requests their platform confirmation. These prices must follow
the grid printed by `genex shop list`. Render `name`, `iconUrl`, `priceCoins`
and `priceDisplayUsdCents`; use an image of the actual item for its icon.
`genex shop set` edits a listing and `genex shop remove` retires it without
removing a buyer's ownership.

Re-list `getEntitlements({ excludeConsumed: true })` on boot. Branch on
`skuType` (`consumable`/`durable`), never `type` (purchase/gift/test/free).
For a consumable, await `consumeEntitlement(id)` BEFORE applying its effect
and skip `alreadyConsumed: true`. This prevents repeated delivery but a crash
between consume and save can lose that effect; do not promise atomic game-state
delivery. A durable ownership unlock is never consumed: restore it from the
entitlement on every boot. Dynamic receipts do not use this consumption API.

## Checklist

- [ ] The game has a worthwhile loop before commerce
- [ ] The saved order binds one stable id, exact terms and promised action
- [ ] `requestPayment()` starts directly from a click/tap
- [ ] Genex shows the frozen coin and real-money price and receives consent
- [ ] No payment buttons in the Genex app
- [ ] Cancellation is silent; uncertain outcomes remain pending
- [ ] Recovery reads receipts before applying any paid action
- [ ] Fulfillment is idempotent, including reload and concurrent-tab cases
- [ ] No paid randomness, coin wagering, donation prompt or pressure timer
- [ ] Nothing sold is unreachable without paying

## Troubleshooting

**The confirmation window was blocked** — an `await` ran before
`requestPayment()`, or there was no click. Persist the order earlier and make
the payment request the click handler's first async operation.

**`payment_conflict`** — the same order id was reused with different terms.
Recover its original request; create a new id only for a new purchase.

**`pending` or an interrupted tab** — use `getPayment(orderId)`. Never assume
failure, issue a replacement charge, or deliver while the status is uncertain.

**Payment succeeded but nothing happened** — find the saved order's action and
recover its receipt. The platform records payment; the game owns fulfillment.

**The player got the effect twice** — delivery did not deduplicate by receipt
id or the save update raced. Fix fulfillment; do not change the order id.

**`guest_no_wallet`** — ask the player to sign in before purchase.

**`staging_no_purchase`** — previews cannot spend; verify layout there and use
a published build for an explicitly approved real purchase.

**`surface_cap`** — the amount exceeds the server's limit for this confirmation
surface. Do not split it into smaller hidden charges to bypass the limit.

**`price_off_grid`** — this applies to legacy catalog SKUs only. Dynamic
payments accept whole amounts subject to their own caps.

**Everything coin-related 404s** — coin commerce is disabled on this stand.
Build the rest and report the unavailable lane.
