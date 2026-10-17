--!strict
-- The Genex helper for Roblox Studio. Genex added this plugin to Studio's Plugins folder when you
-- pressed Set up, and Undo Set up in Genex takes it away again. It is readable on purpose: every
-- module says what it does at its top.
--
-- It works only in the Edit data model. Studio also loads plugins into each play session's server
-- and clients; those copies return here at once and never connect.
--
-- In Edit it connects to Genex on this computer (`link`), proves which Studio it is in through a
-- marker in CoreGui, and answers Genex: the place's scripts (`scripts`), save points (`place`),
-- multiplayer tests (`play`), whether you're working in Studio (`activity`), who else is in a
-- Team Create place (`team`), the Device Simulator and interface layout (`device`) and models
-- (`model`). It never publishes, uploads or signs in.

local RunService = game:GetService("RunService")
if not RunService:IsEdit() then
	return
end

local constants = require(script.constants)
local link = require(script.link)
local scripts = require(script.scripts)
local place = require(script.place)
local play = require(script.play)
local activity = require(script.activity)
local team = require(script.team)
local device = require(script.device)
local model = require(script.model)

local Message = constants.Message

link.start({
	[Message.ScriptsList] = scripts.list,
	[Message.ScriptsRead] = scripts.read,
	[Message.ScriptsWrite] = scripts.write,
	[Message.ScriptsRemove] = scripts.remove,
	[Message.PlaceExport] = place.export,
	[Message.PlaceLoad] = function(request)
		return place.load(request, scripts.quietly)
	end,
	[Message.PlayMultiplayer] = play.multiplayer,
	[Message.PlayPause] = play.pause,
	[Message.PlayEnd] = play.stop,
	[Message.DeviceSet] = device.set,
	[Message.GuiLayout] = device.layout,
	[Message.ModelImport] = model.import,
	[Message.Activity] = activity.now,
	[Message.Team] = team.others,
})

scripts.watch(link.broadcast)
place.watch()
activity.watch(link.broadcast)
team.watch(link.broadcast)

plugin.Unloading:Connect(function()
	link.stop()
	scripts.stop()
	place.stop()
	activity.stop()
	team.stop()
end)

print(`Genex helper {constants.HELPER_VERSION} loaded`)
