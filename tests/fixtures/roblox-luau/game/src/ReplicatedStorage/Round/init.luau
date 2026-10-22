--!strict
local Timer = require(script.Timer)

local Round = {}

function Round.start(): number
	return Timer.seconds()
end

return Round
