--!strict
-- The place's scripts, which Genex keeps in step with `.luau` files in the game folder. A script is
-- named as Studio holds it: the instance names from its service down, its class and, for a Script,
-- its run context. Genex maps that to a file name; this module never names a file.
--
-- It lists and reads scripts, writes one (inside a ChangeHistoryService recording, through
-- ScriptEditorService so an open editor gets the change too), removes one only while its source
-- is still what Genex last saw, and tells Genex when a script changes in Studio. A script Studio's
-- Script Sync keeps in a file of its own is listed as synced and never written.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")
local ScriptEditorService = game:GetService("ScriptEditorService")

local constants = require(script.Parent.constants)
local protocol = require(script.Parent.protocol)

local ErrorCode = constants.ErrorCode
local Message = constants.Message

-- How often changed scripts are looked at and sent.
local FLUSH_SECONDS = 0.5
-- The deepest script path and the longest instance name the link carries.
local MAX_DEPTH = 64
local MAX_NAME_CHARS = 1000
local CLASSES = table.freeze({ Script = true, LocalScript = true, ModuleScript = true })

local SERVICES: { [string]: boolean } = {}
for _, name in constants.SCRIPT_SERVICES do
	SERVICES[name] = true
end

export type Ref = { path: { string }, class: string, runContext: string? }
type Known = { key: string, ref: Ref, hash: string }

local scripts = {}

local known: { [Instance]: Known } = {}
local pending: { [Instance]: boolean } = {}
local quiet = 0
local watching: { RBXScriptConnection } = {}
local running = false
local send: ((kind: string, body: { [string]: any }) -> ())? = nil

local function isSource(instance: Instance): boolean
	return CLASSES[instance.ClassName] == true
end

local function plainName(name: string): boolean
	return #name > 0 and #name <= MAX_NAME_CHARS and protocol.isText(name) and not string.find(name, "\0", 1, true)
end

-- The service `instance` sits in when it is one the helper watches, else nil.
local function serviceOf(instance: Instance): Instance?
	local current: Instance? = instance
	while current and current.Parent ~= game do
		current = current.Parent
	end
	if not current or not SERVICES[current.ClassName] or game:FindService(current.ClassName) ~= current then
		return nil
	end
	return current
end

-- How Genex names `instance`, or nil when it isn't a script in a watched service.
local function refOf(instance: Instance): Ref?
	if not isSource(instance) then
		return nil
	end
	local service = serviceOf(instance)
	if not service then
		return nil
	end
	local names = {}
	local current: Instance = instance
	while current ~= service do
		if not plainName(current.Name) then
			return nil
		end
		table.insert(names, 1, current.Name)
		current = current.Parent :: Instance
	end
	table.insert(names, 1, service.ClassName)
	if #names > MAX_DEPTH then
		return nil
	end
	local ref: Ref = { path = protocol.array(names), class = instance.ClassName }
	if instance.ClassName == "Script" then
		ref.runContext = (instance :: Script).RunContext.Name
	end
	return ref
end

local function keyOf(ref: Ref): string
	return ref.class .. "\0" .. (ref.runContext or "") .. "\0" .. table.concat(ref.path, "\0")
end

-- The script's source as the editor shows it, or nil when it isn't text the link carries.
local function sourceOf(instance: Instance): string?
	local ok, text = pcall(ScriptEditorService.GetEditorSource, ScriptEditorService, instance)
	if not ok then
		text = (instance :: any).Source
	end
	if type(text) ~= "string" or #text > constants.MAX_SCRIPT_SOURCE_BYTES or not protocol.isText(text) then
		return nil
	end
	return text
end

-- Whether Studio's Script Sync keeps `instance` in a file of its own.
local function isSynced(instance: Instance): boolean
	local ok, status = pcall(function()
		return game:GetService("InstanceFileSyncService"):GetStatus(instance)
	end)
	return ok
		and (status == Enum.InstanceFileSyncStatus.SyncedAsRoot or status == Enum.InstanceFileSyncStatus.SyncedAsDescendant)
end

local function withRef(ref: Ref, fields: { [string]: any }): { [string]: any }
	fields.path = ref.path
	fields.class = ref.class
	fields.runContext = ref.runContext
	return fields
end

-- Every script in the watched services.
local function allScripts(): { Instance }
	local found = {}
	for name in SERVICES do
		local service = game:FindService(name)
		if service then
			for _, instance in service:GetDescendants() do
				if isSource(instance) then
					table.insert(found, instance)
				end
			end
		end
	end
	return found
end

-- A script reference Genex sent, checked, or a refusal.
local function checkRef(value: any): Ref
	local shaped = type(value) == "table" and type(value.path) == "table" and type(value.class) == "string"
	if not shaped or not CLASSES[value.class] or #value.path < 2 or #value.path > MAX_DEPTH then
		protocol.fail(ErrorCode.Refused, "That isn't a script Genex names.")
	end
	for _, name in value.path do
		if type(name) ~= "string" or not plainName(name) then
			protocol.fail(ErrorCode.Refused, "That isn't a script Genex names.")
		end
	end
	if not SERVICES[value.path[1]] then
		protocol.fail(ErrorCode.Refused, `Genex keeps no scripts in {value.path[1]}.`)
	end
	local context = value.runContext
	if (value.class == "Script") ~= (type(context) == "string") then
		protocol.fail(ErrorCode.Refused, "Only a Script has a run context.")
	end
	return { path = value.path, class = value.class, runContext = context }
end

local function matches(instance: Instance, ref: Ref, name: string): boolean
	if instance.Name ~= name or instance.ClassName ~= ref.class then
		return false
	end
	return ref.class ~= "Script" or (instance :: Script).RunContext.Name == ref.runContext
end

-- The script `ref` names and the folder it is in; either is nil when it isn't there.
local function resolve(ref: Ref): (Instance?, Instance?)
	local parent: Instance? = game:FindService(ref.path[1])
	for index = 2, #ref.path - 1 do
		if not parent then
			return nil, nil
		end
		parent = parent:FindFirstChild(ref.path[index])
	end
	if not parent then
		return nil, nil
	end
	local name = ref.path[#ref.path]
	for _, child in parent:GetChildren() do
		if matches(child, ref, name) then
			return child, parent
		end
	end
	return nil, parent
end

-- Makes the script `ref` names, with Folders for any missing on the way.
local function create(ref: Ref): Instance
	local parent: Instance = game:GetService(ref.path[1])
	for index = 2, #ref.path - 1 do
		local child = parent:FindFirstChild(ref.path[index])
		if not child then
			child = Instance.new("Folder")
			child.Name = ref.path[index]
			child.Parent = parent
		end
		parent = child :: Instance
	end
	local instance = Instance.new(ref.class :: any)
	if ref.runContext then
		(instance :: Script).RunContext = (Enum.RunContext :: any)[ref.runContext]
	end
	instance.Name = ref.path[#ref.path]
	instance.Parent = parent
	return instance
end

local function remember(instance: Instance, ref: Ref, hash: string)
	known[instance] = { key = keyOf(ref), ref = ref, hash = hash }
	pending[instance] = nil
end

-- Runs `change` inside one recording, so Studio's Undo takes back the helper's change in one step.
local function recorded(name: string, change: () -> ())
	local recording = ChangeHistoryService:TryBeginRecording(name)
	local ok, failure = pcall(change)
	if recording then
		local operation = if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		ChangeHistoryService:FinishRecording(recording, operation)
	end
	if not ok then
		if type(failure) == "table" then
			error(failure, 0)
		end
		protocol.fail(ErrorCode.Failed, tostring(failure))
	end
end

local function editable()
	if RunService:IsRunning() then
		protocol.fail(ErrorCode.Busy, "Studio is running the game; scripts change in Edit only.")
	end
end

-- scripts.list: every script with its hash.
function scripts.list(_request: any): { [string]: any }
	local entries = protocol.array({})
	for _, instance in allScripts() do
		local ref = refOf(instance)
		local source = ref and sourceOf(instance)
		if ref and source then
			table.insert(entries, withRef(ref, { hash = protocol.hash(source), synced = isSynced(instance) }))
		end
	end
	return { scripts = entries }
end

-- scripts.read: the sources of the scripts asked for; one that isn't there is left out.
function scripts.read(request: any): { [string]: any }
	local asked = request.body.scripts
	if type(asked) ~= "table" then
		protocol.fail(ErrorCode.Refused, "No scripts were asked for.")
	end
	local found = protocol.array({})
	for _, value in asked do
		local ref = checkRef(value)
		local instance = resolve(ref)
		local source = instance and sourceOf(instance)
		if source then
			table.insert(found, withRef(ref, { source = source }))
		end
	end
	return { scripts = found }
end

-- scripts.write: one script's source, made where missing; refused when it changed since `base`.
function scripts.write(request: any): { [string]: any }
	editable()
	local ref = checkRef(request.body.script)
	local source = request.body.source
	if type(source) ~= "string" or #source > constants.MAX_SCRIPT_SOURCE_BYTES or not protocol.isText(source) then
		protocol.fail(ErrorCode.Refused, "That source isn't text the helper writes.")
	end
	local instance = resolve(ref)
	local base = request.body.base
	if base ~= nil then
		local current = instance and sourceOf(instance)
		if not current or protocol.hash(current) ~= base then
			protocol.fail(ErrorCode.Conflict, "The script changed in Studio since Genex last saw it.")
		end
	end
	if instance and isSynced(instance) then
		protocol.fail(ErrorCode.Refused, "Studio's Script Sync keeps this script in a file of its own.")
	end
	local target = instance
	recorded("Genex: update a script", function()
		local made = target or create(ref)
		target = made
		ScriptEditorService:UpdateSourceAsync(made :: any, function()
			return source
		end)
	end)
	local hash = protocol.hash(source)
	remember(target :: Instance, ref, hash)
	return { hash = hash }
end

-- scripts.remove: one script, only while its source still has `hash`.
function scripts.remove(request: any): { [string]: any }
	editable()
	local ref = checkRef(request.body.script)
	local instance = resolve(ref)
	if not instance then
		return { removed = false }
	end
	local current = sourceOf(instance)
	if not current or protocol.hash(current) ~= request.body.hash then
		protocol.fail(ErrorCode.Conflict, "The script changed in Studio since Genex last saw it.")
	end
	if isSynced(instance) then
		protocol.fail(ErrorCode.Refused, "Studio's Script Sync keeps this script in a file of its own.")
	end
	known[instance] = nil
	pending[instance] = nil
	recorded("Genex: remove a script", function()
		instance.Parent = nil
	end)
	return { removed = true }
end

local function emit(ref: Ref, source: string?)
	if send then
		send(Message.ScriptsChanged, withRef(ref, { source = if source then source else protocol.NULL }))
	end
end

-- Sends what changed among the scripts marked since the last look.
local function flush()
	for instance in pending do
		pending[instance] = nil
		local before = known[instance]
		local ref = refOf(instance)
		local source = ref and sourceOf(instance)
		if not ref or not source then
			if before then
				known[instance] = nil
				emit(before.ref, nil)
			end
			continue
		end
		local hash = protocol.hash(source)
		local key = keyOf(ref)
		if before and before.key ~= key then
			emit(before.ref, nil)
		end
		if not before or before.key ~= key or before.hash ~= hash then
			known[instance] = { key = key, ref = ref, hash = hash }
			emit(ref, source)
		end
	end
end

-- Takes every script as it is now, sending nothing: after a load, or at the start.
local function snapshot()
	table.clear(known)
	table.clear(pending)
	for _, instance in allScripts() do
		local ref = refOf(instance)
		local source = ref and sourceOf(instance)
		if ref and source then
			remember(instance, ref, protocol.hash(source))
		end
	end
end

local function mark(instance: Instance)
	if isSource(instance) then
		pending[instance] = true
	end
end

-- A renamed or moved instance: the script itself, or every script below it.
local function markBelow(instance: Instance)
	if isSource(instance) then
		pending[instance] = true
		return
	end
	for _, descendant in instance:GetDescendants() do
		mark(descendant)
	end
end

-- Starts telling Genex about scripts changed in Studio, through `sender`.
function scripts.watch(sender: (kind: string, body: { [string]: any }) -> ())
	send = sender
	snapshot()
	running = true
	table.insert(watching, game.DescendantAdded:Connect(mark))
	table.insert(
		watching,
		game.DescendantRemoving:Connect(function(instance)
			if known[instance] then
				pending[instance] = true
			end
		end)
	)
	table.insert(
		watching,
		game.ItemChanged:Connect(function(instance, property)
			if property == "Source" or property == "RunContext" then
				mark(instance)
			elseif property == "Name" or property == "Parent" then
				markBelow(instance)
			end
		end)
	)
	table.insert(
		watching,
		ScriptEditorService.TextDocumentDidChange:Connect(function(document)
			local ok, instance = pcall(document.GetScript, document)
			if ok and instance then
				mark(instance)
			end
		end)
	)
	task.spawn(function()
		while running do
			task.wait(FLUSH_SECONDS)
			if quiet == 0 and not RunService:IsRunning() then
				flush()
			end
		end
	end)
end

-- Runs `change` (a place load) without telling Genex about the scripts it replaces, then takes the
-- scripts as they are afterwards.
function scripts.quietly(change: () -> ())
	quiet += 1
	local ok, failure = pcall(change)
	quiet -= 1
	snapshot()
	if not ok then
		error(failure, 0)
	end
end

function scripts.stop()
	running = false
	for _, connection in watching do
		connection:Disconnect()
	end
	table.clear(watching)
end

return scripts
