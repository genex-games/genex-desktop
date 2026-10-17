# Purchases: grant once, record first

Developer products (things bought again and again: coins, a revive) are paid for with the player's
Robux and granted by the game. Roblox calls the game's `ProcessReceipt` for each purchase and calls
it **again** until the game says the purchase was granted: after an error, a crash, a shutdown, or
when the player rejoins another server. So the grant must be idempotent: a receipt seen twice is
granted once.

## ProcessReceipt

- Set `MarketplaceService.ProcessReceipt` once, in one server script. Only the last assignment
  counts, so two scripts setting it break one of them.
- The receipt's `PurchaseId` is the key. Before granting, look it up in the player's profile (the
  session-locked profile of the `player-data` skill): already there means it was granted, so return
  `Enum.ProductPurchaseDecision.PurchaseGranted` without granting again.
- Grant and record the `PurchaseId` in the **same** profile change, then save that change with
  `UpdateAsync`. Return `PurchaseGranted` only after the save succeeded.
- Return `Enum.ProductPurchaseDecision.NotProcessedYet` when the player is not in this server, their
  profile is not loaded yet, the product id is unknown, or anything failed. Roblox will ask again;
  that is the safe answer.
- Never yield long in the callback, and never `error` out of it: wrap the work in `pcall`.
- Keep the recorded ids bounded: the most recent 100 or so is plenty, because Roblox retries a
  receipt only until it is granted.
- A game without session-locked profiles records purchases in their own DataStore keyed by
  `PurchaseId`, claimed in an `UpdateAsync` before granting (return `nil` from the update when the
  id is already there), and grants only after that claim succeeded.

```luau
--!strict
local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")
local PlayerData = require(ServerStorage.PlayerData)
local Products = require(ServerStorage.Products) -- [productId] = function(profile) ... end

MarketplaceService.ProcessReceipt = function(receipt)
	local player = Players:GetPlayerByUserId(receipt.PlayerId)
	local grant = Products[receipt.ProductId]
	if player == nil or grant == nil then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	local ok, saved = pcall(PlayerData.changeAndSave, player, function(profile)
		if table.find(profile.purchases, receipt.PurchaseId) then
			return -- granted before: nothing to change
		end
		grant(profile)
		table.insert(profile.purchases, receipt.PurchaseId)
		if #profile.purchases > 100 then
			table.remove(profile.purchases, 1)
		end
	end)
	if ok and saved then
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end
	return Enum.ProductPurchaseDecision.NotProcessedYet
end
```

## What is not proof of a purchase

- `PromptProductPurchaseFinished` and `PromptPurchaseFinished` only say the window closed. Use them
  for UI, never to grant anything.
- A client saying it bought something is a request like any other (see the `remotes` skill).
- Game passes (bought once): check with `MarketplaceService:UserOwnsGamePassAsync` on the server, in
  `pcall`, when the player joins and again after `PromptGamePassPurchaseFinished` says `true`; cache
  the answer for the session.

## The person's store, not yours

- Products and passes are created, named and priced by the person on the Creator Dashboard. Use the
  ids they give you; never invent ids or prices, and show prices from `GetProductInfo` (display only).
- Purchases in Studio play-tests are free and charge nobody, so play the full flow there.
- Paid random rewards (crates, gacha) must show their odds before the purchase, and some countries
  restrict them. Ask the person before adding one.
- Never describe an item as giving more than it gives, and never hide a purchase in a button that
  looks like something else.
