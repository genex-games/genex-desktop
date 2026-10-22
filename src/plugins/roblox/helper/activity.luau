--!strict
-- Whether the person is working in Studio now, so Genex's agents wait for them. The helper notes
-- selections, undo and redo, the person's own recordings and typing in a script, and tells Genex
-- at most once every few seconds; after a quiet spell it says the person stopped. Its own
-- recordings, named "Genex: …", never count. Asked, it says what it last counted and which (a
-- recording's name, a script's or a selected instance's full name), so Genex can log why it waited.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local Selection = game:GetService("Selection")

local constants = require(script.Parent.constants)
local protocol = require(script.Parent.protocol)

local Message = constants.Message
local Signal = constants.Signal

-- The least time between two "editing" notes, and the quiet after which the person stopped.
local NOTE_SECONDS = 2
local QUIET_SECONDS = 10
local GENEX_RECORDING = "^Genex: "
-- The longest detail said with a signal, in characters.
local DETAIL_CHARS = 150

local activity = {}

local watching: { RBXScriptConnection } = {}
local running = false
local lastNote = -math.huge
local lastSeen = -math.huge
local editing = false
local lastSignal: string? = nil
local lastDetail = ""
local send: ((kind: string, body: { [string]: any }) -> ())? = nil

local function seen(signal: string, detail: string)
	lastSignal = signal
	lastDetail = protocol.plain(detail, DETAIL_CHARS)
	lastSeen = os.clock()
	if not send then
		return
	end
	if not editing or lastSeen - lastNote >= NOTE_SECONDS then
		editing = true
		lastNote = lastSeen
		send(Message.Activity, { editing = true })
	end
end

-- An instance's full name, or "" when it can't be read.
local function fullName(instance: Instance?): string
	if not instance then
		return ""
	end
	local ok, name = pcall(instance.GetFullName, instance)
	return if ok then name else ""
end

local function selected()
	local ok, list = pcall(Selection.Get, Selection)
	seen(Signal.Selection, if ok and list[1] then fullName(list[1]) else "")
end

local function typed(document: any)
	local ok, edited = pcall(document.GetScript, document)
	seen(Signal.Typing, if ok then fullName(edited) else "")
end

local function connect(signal: RBXScriptSignal, handler: (...any) -> ())
	local ok, connection = pcall(function()
		return signal:Connect(handler)
	end)
	if ok then
		table.insert(watching, connection)
	end
end

-- Starts noting the person's work and telling Genex through `sender`.
function activity.watch(sender: (kind: string, body: { [string]: any }) -> ())
	send = sender
	running = true
	connect(Selection.SelectionChanged, selected)
	connect(ChangeHistoryService.OnUndo, function(waypoint: string)
		seen(Signal.Undo, waypoint or "")
	end)
	connect(ChangeHistoryService.OnRedo, function(waypoint: string)
		seen(Signal.Redo, waypoint or "")
	end)
	connect(ChangeHistoryService.OnRecordingFinished, function(name: string)
		if not string.match(name or "", GENEX_RECORDING) then
			seen(Signal.Recording, name or "")
		end
	end)
	connect(ScriptEditorService.TextDocumentDidChange, typed)
	task.spawn(function()
		while running do
			task.wait(1)
			if editing and os.clock() - lastSeen >= QUIET_SECONDS then
				editing = false
				if send then
					send(Message.Activity, { editing = false })
				end
			end
		end
	end)
end

-- activity (asked): whether the person is working in Studio now.
function activity.now(_request: any): { [string]: any }
	return { editing = editing }
end

-- activity.why (asked): what the helper last counted as the person's work, and which.
function activity.why(_request: any): { [string]: any }
	return { signal = if lastSignal then lastSignal else protocol.NULL, detail = lastDetail }
end

function activity.stop()
	running = false
	for _, connection in watching do
		connection:Disconnect()
	end
	table.clear(watching)
end

return activity
