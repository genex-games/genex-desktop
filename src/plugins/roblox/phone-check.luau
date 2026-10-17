--!strict
-- The phone judge's probe, run by Genex through Studio's execute_luau in a running play test's
-- client (`probes.ts`). The file is a function of its arguments; each call is one step:
--   current: the device Studio's Device Simulator shows now, so Genex can put it back.
--   measure: the simulator set to one device and orientation, then what the player's screen holds:
--            its size, the safe area and Roblox's own top-bar buttons, every interface element that
--            can be pressed or holds text with its box, and the memory the place takes by kind.
--   restore: the simulator back to the device it showed before.
-- The simulator is Studio's own view setting: it keeps the last device after the play ends, which is
-- why Genex always puts it back. A ScreenGui made for the safe area is the one thing it adds to the
-- client, and it is removed before the step answers.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local GuiService = game:GetService("GuiService")
local Stats = game:GetService("Stats")

local MAX_ELEMENTS = 400
local MAX_TEXT_CHARS = 60
local MAX_PATH_CHARS = 300
local RESIZE_WAIT_SECONDS = 3
local LAYOUT_SETTLE_SECONDS = 0.5
local POLL_SECONDS = 0.1
-- Roblox's own touch controls (the move stick and the jump button) live in this ScreenGui.
local TOUCH_GUI = "TouchGui"

local function simulator(): any
	return game:GetService("StudioDeviceSimulatorService")
end

local function orientationName(value: any): string?
	if typeof(value) == "EnumItem" then
		return value.Name
	end
	return nil
end

local function setDevice(device: string, orientation: string?)
	local service = simulator()
	service:SetDeviceAsync(device)
	if orientation then
		service:SetOrientationAsync((Enum.ScreenOrientation :: any)[orientation])
	end
end

local function viewSize(): Vector2
	local camera = workspace.CurrentCamera
	return camera and camera.ViewportSize or Vector2.zero
end

-- Waits until the view's size changes from `before`, or the wait is up, then for the layout.
local function settle(before: Vector2)
	local waited = 0
	while viewSize() == before and waited < RESIZE_WAIT_SECONDS do
		task.wait(POLL_SECONDS)
		waited += POLL_SECONDS
	end
	task.wait(LAYOUT_SETTLE_SECONDS)
end

local function box(position: Vector2, size: Vector2): { number }
	return { position.X, position.Y, size.X, size.Y }
end

-- The screen's safe area, as a ScreenGui that keeps to the device's safe insets sees it.
local function safeArea(gui: Instance): { number }?
	local probe = Instance.new("ScreenGui")
	probe.Name = "GenexSafeAreaProbe"
	probe.ScreenInsets = Enum.ScreenInsets.DeviceSafeInsets
	local frame = Instance.new("Frame")
	frame.Size = UDim2.fromScale(1, 1)
	frame.BackgroundTransparency = 1
	frame.Parent = probe
	probe.Parent = gui
	task.wait()
	local area = box(frame.AbsolutePosition, frame.AbsoluteSize)
	probe:Destroy()
	return area
end

local function shown(object: GuiObject, screen: Instance): boolean
	local at: Instance? = object
	while at and at ~= screen do
		if at:IsA("GuiObject") and not at.Visible then
			return false
		end
		at = at.Parent
	end
	return true
end

local function clipped(object: GuiObject, screen: Instance): boolean
	local at = object.Parent
	while at and at ~= screen do
		if at:IsA("ScrollingFrame") or (at:IsA("GuiObject") and at.ClipsDescendants) then
			return true
		end
		at = at.Parent
	end
	return false
end

local function textOf(object: GuiObject): string?
	if object:IsA("TextLabel") or object:IsA("TextButton") or object:IsA("TextBox") then
		local text = (object :: any).Text
		if type(text) == "string" and #text > 0 then
			return string.sub(text, 1, MAX_TEXT_CHARS)
		end
	end
	return nil
end

local function pathIn(object: Instance, gui: Instance): string
	local names = {}
	local at: Instance? = object
	while at and at ~= gui do
		table.insert(names, 1, at.Name)
		at = at.Parent
	end
	return string.sub(table.concat(names, "."), 1, MAX_PATH_CHARS)
end

-- Every shown element a player can press or read, with the nearest such element it sits in.
local function elements(gui: Instance): { { [string]: any } }
	local list = {}
	local ids: { [Instance]: number } = {}
	for _, screen in gui:GetChildren() do
		if screen:IsA("ScreenGui") and screen.Enabled then
			for _, object in screen:GetDescendants() do
				if #list >= MAX_ELEMENTS then
					return list
				end
				if object:IsA("GuiObject") and shown(object, screen) then
					local pressable = object:IsA("GuiButton") or object:IsA("TextBox")
					local text = textOf(object)
					if pressable or text then
						local under: number? = nil
						local at = object.Parent
						while at and at ~= screen and not under do
							under = ids[at]
							at = at.Parent
						end
						table.insert(list, {
							id = #list + 1,
							under = under,
							path = pathIn(object, gui),
							class = object.ClassName,
							box = box(object.AbsolutePosition, object.AbsoluteSize),
							pressable = pressable,
							text = text,
							clipped = clipped(object, screen),
							touch = screen.Name == TOUCH_GUI,
						})
						ids[object] = #list
					end
				end
			end
		end
	end
	return list
end

local function memory(): { [string]: number }
	local out = {}
	for _, tag in Enum.DeveloperMemoryTag:GetEnumItems() do
		out[tag.Name] = Stats:GetMemoryUsageMbForTag(tag)
	end
	return out
end

local function measure(device: string, orientation: string): { [string]: any }
	local before = viewSize()
	setDevice(device, orientation)
	settle(before)
	local me = Players.LocalPlayer
	local gui = me and me:FindFirstChildOfClass("PlayerGui")
	local view = viewSize()
	local top = GuiService.TopbarInset
	return {
		device = tostring(simulator():GetDeviceAsync()),
		orientation = orientationName(simulator():GetOrientationAsync()),
		view = { view.X, view.Y },
		safe = gui and safeArea(gui) or nil,
		-- Roblox's own buttons hold the top bar left of where the game's free part of it begins.
		roblox = { 0, 0, top.Min.X, top.Max.Y },
		elements = gui and elements(gui) or {},
		memory = memory(),
	}
end

return function(args: { [string]: any }): string
	local out
	if args.op == "current" then
		out = {
			device = tostring(simulator():GetDeviceAsync()),
			orientation = orientationName(simulator():GetOrientationAsync()),
		}
	elseif args.op == "measure" then
		out = measure(args.device, args.orientation)
	elseif args.op == "restore" then
		setDevice(args.device, args.orientation)
		out = { device = tostring(simulator():GetDeviceAsync()) }
	else
		error("phone-check: unknown step " .. tostring(args.op), 0)
	end
	return HttpService:JSONEncode(out)
end
