# Remotes: the server decides

Every player's device runs code the player controls. A cheater can fire any RemoteEvent or
RemoteFunction the place holds, at any rate, with any arguments, and can read every script and
value that reaches the device. So the client only asks; the server checks and decides.

Genex's cheater judge plays exactly that: it fires every remote with wrong types, out-of-range
values and floods, and fails the change if the server's state moves. It watches each player's
leaderstats and attributes and ServerStorage's attributes, so keep money, counts and other guarded
state where it can see them. Write every handler for it.

## Where remotes live

- One `Remotes` Folder in ReplicatedStorage, made in the place or by one server module at start-up.
  Clients find them with `WaitForChild`.
- Name each remote for the request, not the effect: `RequestEquip`, `RequestBuyItem`,
  `ReportReady`; never `GiveCoins` or `SetHealth`.
- One remote per kind of request. No catch-all remote that takes an action name and a table.
- High-rate cosmetic updates (a look direction, an effect) use `UnreliableRemoteEvent`; anything
  that changes state uses a `RemoteEvent`.
- Admin remotes don't exist on the client: admin actions are checked on the server by `UserId`
  (or group rank) on every call, never by a client-side flag or a player's name.

## Every handler, in this order

1. **Rate.** Drop the call when this player is over the remote's budget (below). Silently: no
   reply, no error.
2. **Types.** Check every argument with `typeof` before using it. Remotes receive any value: `nil`,
   a table where a number was expected, a NaN, an Instance from somewhere else.
3. **Ranges and choices.** Numbers finite and within range, whole numbers where counts are meant,
   strings short and from an allowlist, tables with known keys only.
4. **State.** The player is alive, in the round, owns the item, is close enough to the thing they
   touch, and the cooldown has passed, all checked against the server's own state.
5. **Act.** The server computes the outcome itself (damage, price, reward) from its own data.
   Never take an amount, a price, a position to teleport to or a hit result from the client as is.

Anything that fails a check is ignored. Never `error` in a handler for bad input: the cheater
learns from errors, and a RemoteFunction's error reaches the caller.

```luau
--!strict
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shop = require(ServerStorage.Shop)
local ShopItems = require(ServerStorage.ShopItems)
local Remotes = ReplicatedStorage.Remotes

local MAX_PER_SECOND = 5
local buckets: { [Player]: { tokens: number, at: number } } = {}

local function allow(player: Player): boolean
	local now = os.clock()
	local bucket = buckets[player] or { tokens = MAX_PER_SECOND, at = now }
	bucket.tokens = math.min(MAX_PER_SECOND, bucket.tokens + (now - bucket.at) * MAX_PER_SECOND)
	bucket.at = now
	buckets[player] = bucket
	if bucket.tokens < 1 then
		return false
	end
	bucket.tokens -= 1
	return true
end

Players.PlayerRemoving:Connect(function(player)
	buckets[player] = nil
end)

local function isCount(value: unknown, max: number): boolean
	return typeof(value) == "number" and value == value and value % 1 == 0 and value >= 1 and value <= max
end

local function isShopItem(value: unknown): boolean
	return typeof(value) == "string" and #value <= 40 and ShopItems[value] ~= nil
end

Remotes.RequestBuyItem.OnServerEvent:Connect(function(player: Player, itemId: unknown, count: unknown)
	if not allow(player) or not isShopItem(itemId) or not isCount(count, 10) then
		return
	end
	Shop.buy(player, itemId :: string, count :: number) -- price comes from ShopItems on the server
end)
```

- Numbers: `value == value` rules out NaN; also refuse `math.huge` and `-math.huge` (`math.abs(value) < math.huge`).
- Vectors and CFrames: check `typeof(value) == "Vector3"` and that each component is finite.
- Instances: `typeof(value) == "Instance"`, then `value:IsA("Model")` and
  `value:IsDescendantOf(workspace)` (or the folder it must be in). A client can send any instance
  it can see.
- Tables: check the type of every key you read, cap the length, and ignore keys you don't expect.
  Never store a client's table as is.
- Strings shown to other players go through `TextService:FilterStringAsync` on the server first.

## RemoteFunctions

- A client may invoke the server (`InvokeServer`) for a reply. The handler must return quickly and
  must not yield on anything slow; check it exactly like an event.
- The server never calls `InvokeClient`: a client can hang it forever or make it error. Send a
  `RemoteEvent` and let the client answer with another one.

## Movement and physics

- Each player's device owns its own character's physics; position checks are sanity checks
  (distance to the target, speed between two checks), with room for lag, never exact.
- A part whose motion decides the game (a ball, a platform, a projectile that deals damage) is
  owned by the server: `part:SetNetworkOwner(nil)` on an unanchored part.
- Hits from a client (a sword swing, a shot) are a request: the server checks the range, line of
  sight and cooldown before dealing damage it computes itself.

## Before you call it done

- List every remote in the place and its handler; each one checks rate, types, ranges and state.
- No value that matters (coins, health, inventory, round state) is ever written by a client script.
- Let the cheater judge play the change when it touches a remote.
