--!strict
-- The place export and load behind Genex's save points and Rewind. Genex writes the parts it gets
-- into the game folder's `.genex/place/`, so a save point holds the place beside the scripts.
--
-- A part is one container's children serialized by SerializationService into `.rbxm` bytes. The
-- containers are the saved services and, inside them, the children no one can create (such as
-- StarterPlayer's StarterPlayerScripts), each a container of its own. A container whose children
-- serialize past the part cap is split into one part per child under `<container>.split/`. Two
-- more parts hold the services' own saved properties (`services.json`) and the terrain's voxels
-- (`terrain.rbxm`).
--
-- Exports are incremental: the helper notes which container's children changed since it last
-- serialized them and serializes only those again. A part goes to Genex only when its bytes differ
-- from what Genex says it holds. A load replaces each container's children with the parts' own,
-- inside one recording, after every part has been checked and read back.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")

local constants = require(script.Parent.constants)
local protocol = require(script.Parent.protocol)

local ErrorCode = constants.ErrorCode

local PART_ENDING = ".rbxm"
local SPLIT_FOLDER = ".split"
-- The longest name a split child's part gets, before its ending.
local MAX_SAFE_CHARS = 60
-- Windows can't hold a file with one of these names, whatever its ending.
local RESERVED = table.freeze({
	con = true,
	prn = true,
	aux = true,
	nul = true,
	com1 = true,
	com2 = true,
	com3 = true,
	com4 = true,
	lpt1 = true,
	lpt2 = true,
	lpt3 = true,
})
-- The services' own properties a save point keeps; the rest are Studio's defaults or not saved.
local SERVICE_PROPERTIES = table.freeze({
	Lighting = {
		"Ambient",
		"Brightness",
		"ClockTime",
		"ColorShift_Bottom",
		"ColorShift_Top",
		"EnvironmentDiffuseScale",
		"EnvironmentSpecularScale",
		"ExposureCompensation",
		"FogColor",
		"FogEnd",
		"FogStart",
		"GeographicLatitude",
		"GlobalShadows",
		"OutdoorAmbient",
		"ShadowSoftness",
	},
	SoundService = { "AmbientReverb", "DistanceFactor", "DopplerScale", "RolloffScale" },
	StarterPlayer = {
		"AutoJumpEnabled",
		"CameraMaxZoomDistance",
		"CameraMinZoomDistance",
		"CameraMode",
		"CharacterJumpHeight",
		"CharacterJumpPower",
		"CharacterMaxSlopeAngle",
		"CharacterUseJumpPower",
		"CharacterWalkSpeed",
		"EnableMouseLockOption",
		"HealthDisplayDistance",
		"LoadCharacterAppearance",
		"NameDisplayDistance",
	},
	Workspace = { "AirDensity", "FallenPartsDestroyHeight", "GlobalWind", "Gravity" },
})

type Container = { key: string, instance: Instance }
type Part = { name: string, hash: string, bytes: number }
type Fresh = { part: Part, data: buffer? }

local place = {}

local PLACE_SERVICES: { [string]: boolean } = {}
for _, name in constants.PLACE_SERVICES do
	PLACE_SERVICES[name] = true
end

local creatable: { [string]: boolean } = {}
-- Container key to the children changed since its last export; a key without an entry is unchanged.
local dirty: { [string]: { [Instance]: boolean } } = {}
-- Container key to the parts it had at its last export or load.
local exported: { [string]: { Part } } = {}
local quiet = 0
local watching: { RBXScriptConnection } = {}

-- Whether a plugin may make an instance of `class`; a container's children that can't be made
-- are containers of their own.
local function isCreatable(class: string): boolean
	local cached = creatable[class]
	if cached ~= nil then
		return cached
	end
	local ok, instance = pcall(Instance.new, class :: any)
	if ok then
		instance:Destroy()
	end
	creatable[class] = ok
	return ok
end

-- A name as a file name on any system: letters, digits, dash, underscore and space, never empty
-- or one Windows reserves.
local function safeName(name: string): string
	local safe = string.gsub(name, "[^%w%-_ ]", "_")
	safe = string.sub(string.gsub(safe, "^%s+", ""), 1, MAX_SAFE_CHARS)
	safe = string.gsub(safe, "%s+$", "")
	if safe == "" then
		return "_"
	end
	return if RESERVED[string.lower(safe)] then safe .. "_" else safe
end

local function isExported(child: Instance, container: Instance): boolean
	if not child.Archivable then
		return false
	end
	-- The editor's camera belongs to Studio, not to the place.
	return not (container == workspace and child:IsA("Camera"))
end

-- The children a container's part holds.
local function childrenOf(container: Instance): { Instance }
	local children = {}
	for _, child in container:GetChildren() do
		if isExported(child, container) and isCreatable(child.ClassName) then
			table.insert(children, child)
		end
	end
	return children
end

-- Every container now: the saved services and, inside them, the children no one can create.
local function containers(): { Container }
	local found: { Container } = {}
	local function visit(instance: Instance, key: string)
		table.insert(found, { key = key, instance = instance })
		local seen: { [string]: boolean } = {}
		for _, child in instance:GetChildren() do
			local childKey = key .. "/" .. safeName(child.Name)
			if isExported(child, instance) and not isCreatable(child.ClassName) and not seen[string.lower(childKey)] then
				seen[string.lower(childKey)] = true
				visit(child, childKey)
			end
		end
	end
	for _, name in constants.PLACE_SERVICES do
		local service = game:FindService(name)
		if service then
			visit(service, name)
		end
	end
	return found
end

-- The container and the top child a changed instance sits under, or nil outside the place.
local function locate(instance: Instance): (string?, Instance?)
	local chain = {}
	local current: Instance? = instance
	while current and current ~= game do
		table.insert(chain, 1, current)
		current = current.Parent
	end
	local service = chain[1]
	if current ~= game or not service or not PLACE_SERVICES[service.ClassName] then
		return nil, nil
	end
	local key = service.ClassName
	for index = 2, #chain do
		local node = chain[index]
		if isCreatable(node.ClassName) then
			return key, node
		end
		key ..= "/" .. safeName(node.Name)
	end
	return key, nil
end

local function markChanged(instance: Instance)
	if quiet > 0 or instance:IsA("Camera") then
		return
	end
	local key, child = locate(instance)
	if not key then
		return
	end
	local changed = dirty[key] or {}
	dirty[key] = changed
	if child then
		changed[child] = true
	end
end

local function serialize(instances: { Instance }, what: string): buffer
	if #instances == 0 then
		return buffer.create(0)
	end
	local ok, data = pcall(function()
		return game:GetService("SerializationService"):SerializeInstancesAsync(instances)
	end)
	if not ok then
		protocol.fail(ErrorCode.Failed, `Studio couldn't save {what}: {data}`)
	end
	return data
end

local function deserialize(data: buffer, what: string): { Instance }
	if buffer.len(data) == 0 then
		return {}
	end
	local ok, instances = pcall(function()
		return game:GetService("SerializationService"):DeserializeInstancesAsync(data)
	end)
	if not ok then
		protocol.fail(ErrorCode.Failed, `Studio couldn't read {what}: {instances}`)
	end
	return instances
end

local function fresh(name: string, data: buffer): Fresh
	return { part = { name = name, hash = protocol.hash(data), bytes = buffer.len(data) }, data = data }
end

-- What the backend says it holds: part name to hash.
type Known = { [string]: string }

-- The parts of a container split per child, serializing again only the children that changed or
-- whose part the backend doesn't hold.
local function splitParts(
	container: Container,
	previous: { Part }?,
	changed: { [Instance]: boolean }?,
	known: Known
): { Fresh }
	local before: { [string]: Part } = {}
	for _, part in previous or {} do
		before[part.name] = part
	end
	local out: { Fresh } = {}
	local taken: { [string]: boolean } = {}
	for _, child in childrenOf(container.instance) do
		local base = container.key .. SPLIT_FOLDER .. "/" .. safeName(child.Name)
		local name = base
		local count = 1
		while taken[string.lower(name)] do
			count += 1
			name = `{base}~{count}`
		end
		taken[string.lower(name)] = true
		name ..= PART_ENDING
		local kept = before[name]
		local held = kept ~= nil and known[name] == kept.hash
		if held and not (changed and changed[child]) then
			table.insert(out, { part = kept })
		else
			table.insert(out, fresh(name, serialize({ child }, name)))
		end
	end
	return out
end

local function wasSplit(previous: { Part }?): boolean
	local first = previous and previous[1]
	return first ~= nil and string.find(first.name, SPLIT_FOLDER .. "/", 1, true) ~= nil
end

-- A container's parts now: one part, or one per child when that would pass the cap. A full export
-- (`known` empty) serializes every child again.
local function containerParts(container: Container, known: Known): { Fresh }
	local previous = exported[container.key]
	local changed = dirty[container.key]
	-- Cleared before serializing: a change made while Studio serializes marks it again.
	dirty[container.key] = nil
	if wasSplit(previous) then
		return splitParts(container, previous, changed, known)
	end
	local name = container.key .. PART_ENDING
	local data = serialize(childrenOf(container.instance), name)
	if buffer.len(data) <= constants.PLACE_PART_MAX_BYTES then
		return { fresh(name, data) }
	end
	return splitParts(container, nil, nil, known)
end

local function allKnown(parts: { Part }, known: Known): boolean
	for _, part in parts do
		if known[part.name] ~= part.hash then
			return false
		end
	end
	return true
end

local function encodeValue(value: any): any
	local kind = typeof(value)
	if kind == "number" or kind == "boolean" or kind == "string" then
		return value
	elseif kind == "Color3" then
		return { type = "Color3", value = protocol.array({ value.R, value.G, value.B }) }
	elseif kind == "Vector3" then
		return { type = "Vector3", value = protocol.array({ value.X, value.Y, value.Z }) }
	elseif kind == "EnumItem" then
		return { type = "Enum", enum = tostring(value.EnumType), value = value.Name }
	end
	return nil
end

local function decodeValue(value: any): any
	if type(value) ~= "table" then
		return value
	end
	local numbers = value.value
	if value.type == "Color3" then
		return Color3.new(numbers[1], numbers[2], numbers[3])
	elseif value.type == "Vector3" then
		return Vector3.new(numbers[1], numbers[2], numbers[3])
	elseif value.type == "Enum" then
		return ((Enum :: any)[value.enum] :: any)[value.value]
	end
	return nil
end

-- The services' saved properties as JSON bytes, keys sorted so the same values give the same bytes.
local function serviceProperties(): buffer
	local services = {}
	for name, properties in SERVICE_PROPERTIES do
		local service = game:FindService(name)
		if service then
			local values = {}
			for _, property in properties do
				local ok, value = pcall(function()
					return (service :: any)[property]
				end)
				local encoded = ok and encodeValue(value)
				if encoded ~= nil then
					values[property] = encoded
				end
			end
			services[name] = values
		end
	end
	return buffer.fromstring(protocol.encode(services))
end

local function applyServiceProperties(services: any)
	if type(services) ~= "table" then
		return
	end
	for name, values in services do
		local service = SERVICE_PROPERTIES[name] and game:FindService(name)
		if service and type(values) == "table" then
			for property, value in values do
				if table.find(SERVICE_PROPERTIES[name], property) then
					pcall(function()
						(service :: any)[property] = decodeValue(value)
					end)
				end
			end
		end
	end
end

local function terrainOf(): Terrain?
	return workspace:FindFirstChildOfClass("Terrain")
end

local function terrainPart(): buffer?
	local terrain = terrainOf()
	if not terrain then
		return nil
	end
	local region = terrain:CopyRegion(terrain.MaxExtents)
	local data = serialize({ region }, constants.TERRAIN_PART)
	region:Destroy()
	return data
end

-- place.export: every part's name, hash and size; the parts Genex doesn't hold are sent first.
function place.export(request: any): { [string]: any }
	if RunService:IsRunning() then
		protocol.fail(ErrorCode.Busy, "Studio is running the game; the place is saved in Edit only.")
	end
	local started = os.clock()
	local full = request.body.full == true
	-- A full export forgets what the backend holds, so every part is serialized and sent.
	local known: Known = {}
	local listed = if not full and type(request.body.known) == "table" then request.body.known else {}
	for _, part in listed do
		if type(part) == "table" and type(part.name) == "string" and type(part.hash) == "string" then
			known[part.name] = part.hash
		end
	end
	local parts = protocol.array({})
	local sent = protocol.array({})
	local function add(item: Fresh)
		table.insert(parts, item.part)
		if item.data and known[item.part.name] ~= item.part.hash then
			request.sendPart(item.part.name, item.data)
			table.insert(sent, item.part.name)
		end
	end
	local present: { [string]: boolean } = {}
	for _, container in containers() do
		present[container.key] = true
		local previous = exported[container.key]
		local unchanged = previous ~= nil and dirty[container.key] == nil and allKnown(previous, known)
		local items: { Fresh } = {}
		if unchanged then
			for _, part in previous :: { Part } do
				table.insert(items, { part = part })
			end
		else
			items = containerParts(container, known)
		end
		local kept = {}
		for _, item in items do
			add(item)
			table.insert(kept, item.part)
		end
		exported[container.key] = kept
	end
	for key in exported do
		if not present[key] then
			exported[key] = nil
		end
	end
	add(fresh(constants.SERVICES_PART, serviceProperties()))
	local terrain = terrainPart()
	if terrain then
		add(fresh(constants.TERRAIN_PART, terrain))
	end
	return { parts = parts, sent = sent, ms = math.floor((os.clock() - started) * 1000) }
end

-- The container a part belongs to, by its name: `<key>.rbxm` or `<key>.split/<child>.rbxm`.
local function containerKeyOf(name: string): string?
	local split = string.match(name, "^(.+)%" .. SPLIT_FOLDER .. "/[^/]+%" .. PART_ENDING .. "$")
	if split then
		return split
	end
	return string.match(name, "^(.+)%" .. PART_ENDING .. "$")
end

-- Every part Genex sent, checked against what it says each is.
local function checkedParts(request: any): ({ Part }, { [string]: buffer })
	local listed = request.body.parts
	if type(listed) ~= "table" then
		protocol.fail(ErrorCode.Refused, "No place parts were sent.")
	end
	local data = request.takeParts()
	local parts: { Part } = {}
	for _, part in listed do
		local bytes = type(part) == "table" and type(part.name) == "string" and data[part.name]
		if not bytes or buffer.len(bytes) ~= part.bytes or protocol.hash(bytes) ~= part.hash then
			protocol.fail(ErrorCode.Failed, `The place part {tostring(part and part.name)} arrived damaged.`)
		end
		table.insert(parts, { name = part.name, hash = part.hash, bytes = part.bytes })
	end
	return parts, data
end

type Plan = {
	children: { [string]: { Instance } },
	services: any,
	terrain: TerrainRegion?,
	parts: { [string]: { Part } },
}

-- Reads every part back before anything changes, so a part Studio can't read changes nothing.
local function planLoad(parts: { Part }, data: { [string]: buffer }): Plan
	local plan: Plan = { children = {}, services = nil, terrain = nil, parts = {} }
	for _, part in parts do
		local bytes = data[part.name]
		if part.name == constants.SERVICES_PART then
			plan.services = protocol.decode(buffer.tostring(bytes))
		elseif part.name == constants.TERRAIN_PART then
			local region = deserialize(bytes, part.name)[1]
			plan.terrain = if region and region:IsA("TerrainRegion") then region else nil
		else
			local key = containerKeyOf(part.name)
			if not key then
				protocol.fail(ErrorCode.Refused, `{part.name} isn't a place part.`)
			end
			local into = plan.children[key :: string] or {}
			plan.children[key :: string] = into
			for _, instance in deserialize(bytes, part.name) do
				table.insert(into, instance)
			end
			local owned = plan.parts[key :: string] or {}
			plan.parts[key :: string] = owned
			table.insert(owned, part)
		end
	end
	return plan
end

local function applyLoad(plan: Plan)
	local byKey: { [string]: Instance } = {}
	for _, container in containers() do
		byKey[container.key] = container.instance
	end
	for key, instances in plan.children do
		local container = byKey[key]
		if container then
			for _, child in childrenOf(container) do
				child.Parent = nil
			end
			for _, instance in instances do
				instance.Parent = container
			end
		end
	end
	applyServiceProperties(plan.services)
	local terrain = terrainOf()
	if terrain and plan.terrain then
		terrain:Clear()
		terrain:PasteRegion(plan.terrain, terrain.MaxExtents.Min, true)
	end
end

-- place.load: replaces the place with the parts Genex sent; `quietly` keeps the script watch still.
function place.load(request: any, quietly: (change: () -> ()) -> ()): { [string]: any }
	if RunService:IsRunning() then
		protocol.fail(ErrorCode.Busy, "Studio is running the game; a save point loads in Edit only.")
	end
	local parts, data = checkedParts(request)
	local plan = planLoad(parts, data)
	quiet += 1
	local ok, failure = pcall(quietly, function()
		local recording = ChangeHistoryService:TryBeginRecording("Genex: load a save point")
		local applied, problem = pcall(applyLoad, plan)
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end
		if not applied then
			error(problem, 0)
		end
	end)
	quiet -= 1
	if not ok then
		protocol.fail(ErrorCode.Failed, `Studio couldn't load the save point: {failure}`)
	end
	table.clear(dirty)
	table.clear(exported)
	for key, owned in plan.parts do
		exported[key] = owned
	end
	return { loaded = #parts }
end

-- Starts noting which containers change, so the next export serializes only those.
function place.watch()
	local function onChange(instance: Instance)
		if not RunService:IsRunning() then
			markChanged(instance)
		end
	end
	table.insert(watching, game.DescendantAdded:Connect(onChange))
	table.insert(watching, game.DescendantRemoving:Connect(onChange))
	table.insert(
		watching,
		game.ItemChanged:Connect(function(instance)
			onChange(instance)
		end)
	)
end

function place.stop()
	for _, connection in watching do
		connection:Disconnect()
	end
	table.clear(watching)
end

return place
