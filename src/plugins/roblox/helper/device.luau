--!strict
-- The phone check: Studio's Device Simulator set to a device, and where each piece of the game's
-- interface lands on its screen. The simulator is changed only in Edit; the layout is read from
-- the ScreenGuis StarterGui shows in the editor.

local StarterGui = game:GetService("StarterGui")

local constants = require(script.Parent.constants)
local protocol = require(script.Parent.protocol)

local ErrorCode = constants.ErrorCode

local MAX_ELEMENTS = 5000
local MAX_PATH_CHARS = 1000
local DEFAULT_DEVICE = "default"

local device = {}

local function simulator(): any
	local ok, service = pcall(game.GetService, game, "StudioDeviceSimulatorService")
	if not ok or not service then
		protocol.fail(ErrorCode.Unsupported, "This Studio has no Device Simulator a plugin can set.")
	end
	return service
end

-- device.set: the simulated device, by its id, or "default" for none.
function device.set(request: any): { [string]: any }
	local id = request.body.device
	if type(id) ~= "string" or #id == 0 or #id > 200 then
		protocol.fail(ErrorCode.Refused, "That isn't a device id.")
	end
	local service = simulator()
	if id ~= DEFAULT_DEVICE then
		local listed = service:GetDeviceListAsync()
		if not table.find(listed, id) then
			protocol.fail(ErrorCode.Refused, `Studio has no device {protocol.plain(id, 200)}.`)
		end
	end
	service:SetDeviceAsync(id)
	return { device = protocol.plain(tostring(service:GetDeviceAsync()), 200) }
end

local function finite(value: number): boolean
	return value == value and math.abs(value) < 1e6
end

-- gui.layout: every visible-or-hidden GuiObject in StarterGui with its box on the screen.
function device.layout(_request: any): { [string]: any }
	local elements = protocol.array({})
	for _, instance in StarterGui:GetDescendants() do
		if #elements >= MAX_ELEMENTS then
			break
		end
		if instance:IsA("GuiObject") then
			local position, size = instance.AbsolutePosition, instance.AbsoluteSize
			if finite(position.X) and finite(position.Y) and finite(size.X) and finite(size.Y) then
				table.insert(elements, {
					path = protocol.plain(instance:GetFullName(), MAX_PATH_CHARS),
					x = position.X,
					y = position.Y,
					width = size.X,
					height = size.Y,
					visible = instance.Visible,
				})
			end
		end
	end
	return { elements = elements }
end

return device
