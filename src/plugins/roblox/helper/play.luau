--!strict
-- Play tests the helper starts from the Edit data model. Studio lets only a plugin start a
-- multiplayer test (StudioTestService:ExecuteMultiplayerTestAsync, one server and up to eight
-- clients, one session at a time); Genex reaches the server and each client through Studio's own
-- MCP server, not through the helper, whose copies inside a play session stay silent.
--
-- Pausing and ending a test act inside the play session's own data models, which the Edit helper
-- can't reach, so those requests answer `unsupported` and Genex uses Studio's MCP server instead.

local constants = require(script.Parent.constants)
local protocol = require(script.Parent.protocol)

local ErrorCode = constants.ErrorCode

-- What the test's scripts read from StudioTestService:GetTestArgs; Studio requires a value.
local TEST_ARGS = "genex"
-- How long the helper watches a test start for an immediate refusal before it answers.
local START_CHECK_SECONDS = 2
local CHECK_STEP_SECONDS = 0.1

local play = {}

local running = false

-- play.multiplayer: starts a test with `players` clients and answers once it is under way.
function play.multiplayer(request: any): { [string]: any }
	local players = request.body.players
	local whole = type(players) == "number" and players % 1 == 0
	if not whole or players < 1 or players > constants.MAX_PLAYERS then
		protocol.fail(ErrorCode.Refused, `A test has 1 to {constants.MAX_PLAYERS} players.`)
	end
	local found, service = pcall(game.GetService, game, "StudioTestService")
	if not found or not service then
		protocol.fail(ErrorCode.Unsupported, "This Studio can't start a multiplayer test from a plugin.")
	end
	if running then
		protocol.fail(ErrorCode.Busy, "A multiplayer test is already running.")
	end
	running = true
	local finished = false
	local failure: string? = nil
	task.spawn(function()
		local ok, problem = pcall(function()
			(service :: any):ExecuteMultiplayerTestAsync(players, TEST_ARGS)
		end)
		if not ok then
			failure = tostring(problem)
		end
		finished = true
		running = false
	end)
	local deadline = os.clock() + START_CHECK_SECONDS
	while not finished and os.clock() < deadline do
		task.wait(CHECK_STEP_SECONDS)
	end
	if failure then
		protocol.fail(ErrorCode.Failed, `Studio didn't start the test: {failure}`)
	end
	return { players = players }
end

-- play.pause: a play session's clock is held in its own data model, out of the Edit helper's reach.
function play.pause(_request: any): { [string]: any }
	protocol.fail(ErrorCode.Unsupported, "The Genex helper can't pause a test from Edit; Studio's MCP server can.")
	return {}
end

-- play.end: a test ends from inside its own server, out of the Edit helper's reach.
function play.stop(_request: any): { [string]: any }
	protocol.fail(ErrorCode.Unsupported, "The Genex helper can't end a test from Edit; Studio's MCP server can.")
	return {}
end

return play
