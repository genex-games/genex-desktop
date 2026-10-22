--!strict
-- The cheater judge's probe, run by Genex through Studio's execute_luau in a running play test
-- (`probes.ts`). The file is a function of its arguments; each call is one step:
--   list  (a player's client): every RemoteEvent, UnreliableRemoteEvent and RemoteFunction that
--         client can reach, and a few words the game itself shows (item and button names) to send
--         as a first argument, as a real cheater would.
--   fire  (the same client): one remote, sent hostile values: none at all, wrong types, negative,
--         huge and fractional numbers, NaN and infinities, a huge string, tables, broken vectors,
--         instances the player doesn't own, then a burst of the same request.
--   state (the server): what the check watches: each player's leaderstats and attributes, and
--         ServerStorage's attributes, where a game may keep a hash of the state it guards.
-- It changes nothing itself: the only effects are whatever the game's own server does with what
-- the remotes are sent. Genex never runs it when the play can reach the live game's saved data.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ReplicatedFirst = game:GetService("ReplicatedFirst")
local ServerStorage = game:GetService("ServerStorage")

local MAX_REMOTES = 64
local MAX_WORDS = 8
local MAX_WORD_CHARS = 40
local SPAM_COUNT = 60
local HUGE_STRING_CHARS = 50000
local SETTLE_SECONDS = 0.75
local MAX_VALUE_CHARS = 200

local REMOTE_CLASSES = { "RemoteEvent", "UnreliableRemoteEvent", "RemoteFunction" }

local NAN = 0 / 0

-- Numbers a server should refuse in an amount, a price or an index.
local NUMBERS = { -1, -100, 0, NAN, math.huge, -math.huge, 0.5, 1e9, -1e9 }

local function isRemote(instance: Instance): boolean
	for _, class in REMOTE_CLASSES do
		if instance.ClassName == class then
			return true
		end
	end
	return false
end

-- An instance's names from the data model down, so a later call can find it again.
local function pathOf(instance: Instance): { string }
	local names = {}
	local at: Instance? = instance
	while at and at ~= game do
		table.insert(names, 1, at.Name)
		at = at.Parent
	end
	return names
end

local function find(names: { string }): Instance?
	local at: Instance? = game
	for _, name in names do
		at = at and at:FindFirstChild(name)
	end
	return at
end

-- Where a client reaches remotes: what replicates to it, and its own player.
local function roots(): { Instance }
	local list: { Instance } = { ReplicatedStorage, ReplicatedFirst, workspace }
	local me = Players.LocalPlayer
	if me then
		table.insert(list, me)
	end
	return list
end

local function remotes(): { { string } }
	local found, seen = {}, {}
	for _, root in roots() do
		for _, instance in root:GetDescendants() do
			if #found >= MAX_REMOTES then
				return found
			end
			local key = instance:GetFullName()
			if isRemote(instance) and not seen[key] then
				seen[key] = true
				table.insert(found, pathOf(instance))
			end
		end
	end
	return found
end

local function addWord(words: { string }, seen: { [string]: boolean }, word: unknown)
	if type(word) ~= "string" or #word == 0 or #word > MAX_WORD_CHARS or seen[word] or #words >= MAX_WORDS then
		return
	end
	seen[word] = true
	table.insert(words, word)
end

-- Words the game itself shows a player: the names of what sits in ReplicatedStorage's folders
-- (items, tools, pets) and the text of the player's buttons.
local function words(): { string }
	local found, seen = {}, {}
	for _, folder in ReplicatedStorage:GetChildren() do
		if folder:IsA("Folder") or folder:IsA("Configuration") then
			for _, child in folder:GetChildren() do
				if not isRemote(child) then
					addWord(found, seen, child.Name)
				end
			end
		end
	end
	local me = Players.LocalPlayer
	local gui = me and me:FindFirstChildOfClass("PlayerGui")
	if gui then
		for _, instance in gui:GetDescendants() do
			if instance:IsA("TextButton") then
				addWord(found, seen, instance.Text)
			end
		end
	end
	return found
end

-- Instances that aren't the player's to send: another player, another player's character, a part of
-- the world, a whole service.
local function strangers(): { Instance }
	local list: { Instance } = { workspace, ReplicatedStorage }
	local me = Players.LocalPlayer
	for _, player in Players:GetPlayers() do
		if player ~= me then
			table.insert(list, player)
			if player.Character then
				table.insert(list, player.Character)
			end
		end
	end
	local part = workspace:FindFirstChildWhichIsA("BasePart", true)
	if part and not (me and me.Character and part:IsDescendantOf(me.Character)) then
		table.insert(list, part)
	end
	return list
end

local function hostileValues(): { any }
	local values: { any } = {
		true,
		"",
		string.rep("A", HUGE_STRING_CHARS),
		{},
		{ -1, -1, -1 },
		{ price = -1, amount = -1, cost = -1, count = -1 },
		Vector3.new(NAN, NAN, NAN),
		Vector3.new(math.huge, math.huge, math.huge),
		CFrame.new(1e9, 1e9, 1e9),
	}
	for _, number in NUMBERS do
		table.insert(values, number)
	end
	for _, instance in strangers() do
		table.insert(values, instance)
	end
	return values
end

-- Sends one request without ever waiting on the server: a function's answer is left to arrive.
local function send(remote: Instance, ...: any)
	local packed = table.pack(...)
	if remote:IsA("RemoteFunction") then
		task.spawn(function()
			pcall(function()
				(remote :: RemoteFunction):InvokeServer(table.unpack(packed, 1, packed.n))
			end)
		end)
	else
		pcall(function()
			(remote :: any):FireServer(table.unpack(packed, 1, packed.n))
		end)
	end
end

local function fire(names: { string }, given: { string }): { [string]: any }
	local remote = find(names)
	if not remote or not isRemote(remote) then
		return { fired = 0, missing = true }
	end
	local count = 0
	local function go(...: any)
		send(remote, ...)
		count += 1
	end
	go()
	for _, value in hostileValues() do
		go(value)
	end
	for _, word in given do
		for _, number in NUMBERS do
			go(word, number)
			go(word, number, number)
		end
		go(word, string.rep("A", MAX_WORD_CHARS))
	end
	local first = given[1]
	for _ = 1, SPAM_COUNT do
		if first then
			go(first, -1)
		else
			go(-1)
		end
	end
	task.wait(SETTLE_SECONDS)
	return { fired = count }
end

-- A value as text JSON can hold: NaN and the infinities by name, long text cut.
local function plain(value: any): any
	local kind = typeof(value)
	if kind == "number" then
		if value ~= value then
			return "NaN"
		elseif value == math.huge then
			return "inf"
		elseif value == -math.huge then
			return "-inf"
		end
		return value
	elseif kind == "boolean" then
		return value
	end
	return string.sub(tostring(value), 1, MAX_VALUE_CHARS)
end

local function attributes(instance: Instance): { [string]: any }
	local out = {}
	for name, value in instance:GetAttributes() do
		out[name] = plain(value)
	end
	return out
end

local function leaderstats(player: Player): { [string]: any }
	local out = {}
	local stats = player:FindFirstChild("leaderstats")
	if stats then
		for _, child in stats:GetChildren() do
			if child:IsA("ValueBase") then
				out[child.Name] = plain((child :: any).Value)
			end
		end
	end
	return out
end

local function state(): { [string]: any }
	local players = {}
	for _, player in Players:GetPlayers() do
		players[tostring(player.UserId)] = {
			name = player.Name,
			leaderstats = leaderstats(player),
			attributes = attributes(player),
		}
	end
	return { players = players, server = attributes(ServerStorage) }
end

return function(args: { [string]: any }): string
	local out
	if args.op == "list" then
		out = { remotes = remotes(), words = words() }
	elseif args.op == "fire" then
		out = fire(args.remote, args.words or {})
	elseif args.op == "state" then
		out = state()
	else
		error("cheat-remotes: unknown step " .. tostring(args.op), 0)
	end
	return HttpService:JSONEncode(out)
end
