# Player data: one server owns a profile at a time

A player's saved data (coins, inventory, progress) is read and written only by the server, and only
by the one server the player is in. Two servers writing the same profile at once (a fast rejoin, a
teleport between places) is how items get duplicated or lost. So each profile carries a session
lock, every write is an `UpdateAsync`, and the server saves on leave and on shutdown.

If the game already uses ProfileStore or ProfileService, keep using it the way it is used and don't
add a second layer. Otherwise follow this pattern in one server module (`src/ServerScriptService/
PlayerData.luau` or ServerStorage), which every other script asks for data.

## Rules

- **Only through `UpdateAsync`.** Never `SetAsync` on a profile: it overwrites blind. The update
  function gets the stored value, returns the new one, and must not yield; returning `nil` cancels
  the write.
- **The session lock.** The profile holds `lock = { jobId = game.JobId, at = os.time() }`. On join
  the server claims it in an `UpdateAsync`: free, its own, or older than `LOCK_STALE_SECONDS`
  (about five autosave periods). Locked by another live server: wait and retry a few times, then
  kick the player with a plain message ("Your data is still saving, please rejoin"). Never load a
  profile you could not lock.
- **Autosave** every `AUTOSAVE_SECONDS` (60 is common) refreshes the lock time, and only for
  profiles that changed. Check `DataStoreService:GetRequestBudgetForRequestType` before a burst.
- **On leave** (`Players.PlayerRemoving`): save and release the lock in the same `UpdateAsync`,
  then forget the profile.
- **On shutdown** (`game:BindToClose`): save and release every loaded profile in parallel
  (`task.spawn` each) and wait for all of them. The whole callback has about 30 seconds.
- **Retries.** A failed call (`pcall` returned false) retries with a growing wait (1, 2, 4 seconds),
  a few times; then the player's data stays loaded and the next autosave tries again. Never retry
  inside the update function.
- **Never lose a newer profile.** Store a `version` number for the data's shape and migrate older
  shapes forward when loading. Fill missing keys from a defaults table. A profile whose `version`
  is newer than the code knows (an older server still running) is not loaded: kick with a message.
- **Keys** are `"Player_" .. player.UserId`. Never a name: names change.
- **Size.** One key holds at most about 4 MB; keep profiles small (ids and counts, not copies of
  instances) and cap lists that grow.
- **Server only.** Clients never write data. They ask through a remote (see the `remotes` skill) and
  the server changes the profile and tells them the result.
- **Mark, don't save, on change.** A change marks the profile dirty; saving happens on autosave,
  leave and shutdown. Never save on every coin.

```luau
--!strict
local DataStoreService = game:GetService("DataStoreService")

local LOCK_STALE_SECONDS = 300
local store = DataStoreService:GetDataStore("PlayerData")

type Profile = { version: number, coins: number, items: { string }, lock: { jobId: string, at: number }? }

local function claim(key: string, defaults: () -> Profile): (boolean, Profile?)
	local claimed: Profile? = nil
	local ok, err = pcall(function()
		store:UpdateAsync(key, function(stored: Profile?)
			claimed = nil -- Roblox may run this more than once: only the last run counts
			local profile = stored or defaults()
			local lock = profile.lock
			local free = lock == nil or lock.jobId == game.JobId or os.time() - lock.at > LOCK_STALE_SECONDS
			if not free then
				return nil -- another server holds it: write nothing
			end
			profile.lock = { jobId = game.JobId, at = os.time() }
			claimed = profile
			return profile
		end)
	end)
	if not ok then
		warn("PlayerData claim failed", err)
	end
	return ok, claimed
end
```

## In Studio

- DataStores in Studio need a published place and **Enable Studio Access to API Services**
  (Game Settings › Security). That switch is the person's: ask them, don't turn it on.
- With access on, a play-test in Studio reads and writes the **live** DataStore that real players
  use. Test under a separate store name (`PlayerData_Test`, chosen when `RunService:IsStudio()`), and
  never write a migration, a wipe or a bulk change to the live store without the person's OK.
- Without access, the module falls back to an in-memory store so play-tests still run; say so in
  the output once.

## Other stores

- Leaderboards use an `OrderedDataStore` written on save, never read on every frame.
- Cross-server, short-lived state (matchmaking queues, server lists) uses `MemoryStoreService`, not
  DataStores.
- Purchases are recorded with the profile: see the `purchases` skill.
