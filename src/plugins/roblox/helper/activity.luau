--!strict
-- Whether the person is working in Studio now, so Genex's agents wait for them. The helper notes
-- selections, undo and redo, the person's own recordings and typing in a script, and tells Genex
-- at most once every few seconds; after a quiet spell it says the person stopped. Its own
-- recordings, named "Genex: …", never count.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local Selection = game:GetService("Selection")

local constants = require(script.Parent.constants)

local Message = constants.Message

-- The least time between two "editing" notes, and the quiet after which the person stopped.
local NOTE_SECONDS = 2
local QUIET_SECONDS = 10
local GENEX_RECORDING = "^Genex: "

local activity = {}

local watching: { RBXScriptConnection } = {}
local running = false
local lastNote = -math.huge
local lastSeen = -math.huge
local editing = false
local send: ((kind: string, body: { [string]: any }) -> ())? = nil

local function seen()
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
	connect(Selection.SelectionChanged, seen)
	connect(ChangeHistoryService.OnUndo, seen)
	connect(ChangeHistoryService.OnRedo, seen)
	connect(ChangeHistoryService.OnRecordingFinished, function(name: string)
		if not string.match(name or "", GENEX_RECORDING) then
			seen()
		end
	end)
	connect(ScriptEditorService.TextDocumentDidChange, seen)
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

function activity.stop()
	running = false
	for _, connection in watching do
		connection:Disconnect()
	end
	table.clear(watching)
end

return activity
