--!strict
-- Who else is in this place. In a Team Create place each collaborator is a Player in the Edit data
-- model's Players service; the person at this Studio is left out. Genex hears the names whenever
-- someone joins or leaves, and when it asks. In a place nobody shares, no one is there and the list
-- is empty.

local Players = game:GetService("Players")

local constants = require(script.Parent.constants)
local protocol = require(script.Parent.protocol)

local Message = constants.Message

local MAX_OTHERS = 50
local MAX_NAME_CHARS = 200

local team = {}

local watching: { RBXScriptConnection } = {}

local function myUserId(): number?
	local ok, id = pcall(function()
		return game:GetService("StudioService"):GetUserId()
	end)
	return if ok then id else nil
end

-- team (asked): the other people in the place, by display name.
function team.others(_request: any?): { [string]: any }
	local me = myUserId()
	local names = protocol.array({})
	for _, player in Players:GetPlayers() do
		if player.UserId ~= me and #names < MAX_OTHERS then
			table.insert(names, protocol.plain(player.DisplayName, MAX_NAME_CHARS))
		end
	end
	return { others = names }
end

-- Starts telling Genex through `sender` whenever someone joins or leaves the place.
function team.watch(sender: (kind: string, body: { [string]: any }) -> ())
	local function changed()
		-- PlayerRemoving fires while the player is still listed.
		task.defer(function()
			sender(Message.Team, team.others())
		end)
	end
	table.insert(watching, Players.PlayerAdded:Connect(changed))
	table.insert(watching, Players.PlayerRemoving:Connect(changed))
end

function team.stop()
	for _, connection in watching do
		connection:Disconnect()
	end
	table.clear(watching)
end

return team
