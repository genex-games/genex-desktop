--!strict
-- The helper's connections to Genex. Genex listens on this computer only, on the first free port
-- of a short range; the helper tries each port and stays connected to at most two Genex apps (two
-- open profiles), because Studio allows a plugin only four stream connections in all.
--
-- On each connection the helper says hello (its version and the open place), Genex answers with a
-- session id, and the helper puts every connection's session in one non-archivable StringValue in
-- CoreGui, where Genex reads it through Studio's own MCP server to learn which Studio this is.
-- Requests are answered one by one, each in its own thread; a request the helper doesn't know, or
-- one this Studio has no API for, is answered `unsupported` and never raises an error in Studio.

local CoreGui = game:GetService("CoreGui")
local HttpService = game:GetService("HttpService")

local constants = require(script.Parent.constants)
local protocol = require(script.Parent.protocol)

local Message = constants.Message
local ErrorCode = constants.ErrorCode

-- At most this many Genex apps at once.
local MAX_BACKENDS = 2
-- How long a connection may take to open.
local CONNECT_SECONDS = 5
-- The wait between rounds of looking for Genex: short after a change, longer while none answers.
local RETRY_FIRST_SECONDS = 2
local RETRY_MAX_SECONDS = 30
local WAIT_STEP_SECONDS = 0.25
-- The longest error message sent back.
local MAX_ERROR_CHARS = 1000
-- The most base64 text one connection holds for transfers not yet asked for.
local MAX_TRANSFER_CHARS = 512 * 1024 * 1024
-- A session id Genex gives: letters, digits and dashes.
local SESSION_PATTERN = "^[%w%-]+$"
local MAX_SESSION_CHARS = 100

type PartChunks = { count: number, chunks: { [number]: string } }
type Transfer = { [string]: PartChunks }

export type Connection = {
	port: number,
	client: any,
	nextId: number,
	session: string?,
	open: boolean,
	transfers: { [number]: Transfer },
	transferChars: number,
	events: { RBXScriptConnection },
}

-- One request from Genex, as its handler gets it.
export type Request = {
	id: number,
	body: { [string]: any },
	connection: Connection,
	-- Sends `data` as the part `name` of this request's transfer.
	sendPart: (name: string, data: buffer) -> (),
	-- The parts Genex sent ahead of this request, each whole; raises when one arrived short.
	takeParts: () -> { [string]: buffer },
}

export type Handler = (request: Request) -> { [string]: any }

local link = {}

local connections: { [number]: Connection } = {}
local handlers: { [string]: Handler } = {}
local running = false
local wake = false

local function openCount(): number
	local count = 0
	for _, connection in connections do
		if connection.open then
			count += 1
		end
	end
	return count
end

-- Sends one message on a connection with its next id.
local function send(connection: Connection, message: { [string]: any })
	connection.nextId += 1
	message.v = constants.PROTOCOL
	message.id = connection.nextId
	local text = protocol.encode(message)
	if #text > constants.MAX_FRAME_BYTES then
		protocol.fail(ErrorCode.Failed, "The answer is larger than the link to Genex carries.")
	end
	connection.client:Send(text)
end

-- Puts the sessions of every open connection in the CoreGui marker, or removes it when none is left.
local function updateMarker()
	local sessions = {}
	for _, connection in connections do
		if connection.open and connection.session then
			table.insert(sessions, connection.session)
		end
	end
	table.sort(sessions)
	local marker = CoreGui:FindFirstChild(constants.SESSION_MARKER)
	if #sessions == 0 then
		if marker then
			marker:Destroy()
		end
		return
	end
	if not marker or not marker:IsA("StringValue") then
		if marker then
			marker:Destroy()
		end
		local value = Instance.new("StringValue")
		value.Name = constants.SESSION_MARKER
		value.Archivable = false
		value.Parent = CoreGui
		marker = value
	end
	(marker :: StringValue).Value = table.concat(sessions, ",")
end

local function markSession(request: Request): { [string]: any }
	local session = request.body.session
	local valid = type(session) == "string" and #session <= MAX_SESSION_CHARS and string.match(session, SESSION_PATTERN)
	if not valid then
		protocol.fail(ErrorCode.Refused, "That isn't a session id Genex gives.")
	end
	request.connection.session = session
	updateMarker()
	return {}
end

-- Keeps one chunk Genex sends ahead of a request; a chunk of the wrong shape is dropped.
local function keepChunk(connection: Connection, body: any)
	if type(body) ~= "table" then
		return
	end
	local transfer, part, index, count, data = body.transfer, body.part, body.index, body.count, body.data
	local shaped = type(transfer) == "number"
		and type(part) == "string"
		and #part <= 1024
		and type(count) == "number"
		and count >= 1
		and count <= constants.MAX_CHUNKS
		and type(index) == "number"
		and index >= 0
		and index < count
		and type(data) == "string"
		and #data <= constants.MAX_CHUNK_CHARS
	if not shaped or connection.transferChars + #data > MAX_TRANSFER_CHARS then
		return
	end
	local parts = connection.transfers[transfer] or {}
	connection.transfers[transfer] = parts
	local entry = parts[part] or { count = count, chunks = {} }
	parts[part] = entry
	if entry.count == count and entry.chunks[index] == nil then
		entry.chunks[index] = data
		connection.transferChars += #data
	end
end

local function joinBuffers(pieces: { buffer }): buffer
	local size = 0
	for _, piece in pieces do
		size += buffer.len(piece)
	end
	local whole = buffer.create(size)
	local at = 0
	for _, piece in pieces do
		buffer.copy(whole, at, piece)
		at += buffer.len(piece)
	end
	return whole
end

-- The parts of a transfer, each joined and decoded, and the transfer forgotten.
local function takeParts(connection: Connection, id: number): { [string]: buffer }
	local transfer = connection.transfers[id] or {}
	connection.transfers[id] = nil
	local parts = {}
	for name, entry in transfer do
		local pieces = {}
		for index = 0, entry.count - 1 do
			local data = entry.chunks[index]
			connection.transferChars -= if data then #data else 0
			local bytes = data and protocol.fromBase64(data)
			if not bytes then
				protocol.fail(ErrorCode.Failed, `The part {name} arrived incomplete.`)
			end
			table.insert(pieces, bytes :: buffer)
		end
		parts[name] = joinBuffers(pieces)
	end
	return parts
end

local function sendPart(connection: Connection, id: number, name: string, data: buffer)
	local size = buffer.len(data)
	local count = math.max(1, math.ceil(size / constants.CHUNK_BYTES))
	for index = 0, count - 1 do
		local from = index * constants.CHUNK_BYTES
		local text = protocol.toBase64(data, from, math.min(constants.CHUNK_BYTES, size - from))
		send(connection, {
			type = Message.DataChunk,
			body = { transfer = id, part = name, index = index, count = count, data = text },
		})
	end
end

local function unknownRequest(_request: Request): { [string]: any }
	protocol.fail(ErrorCode.Unsupported, "This Genex helper doesn't know that request; updating Genex brings a newer one.")
	return {}
end

-- The answer to a request: its result, or the error the handler raised as a code and a plain line.
local function answer(connection: Connection, id: number, ok: boolean, result: any)
	if not connection.open then
		return
	end
	if ok then
		local sent = pcall(send, connection, { type = Message.Answer, re = id, ok = true, result = result })
		if sent then
			return
		end
		result = { code = ErrorCode.Failed, message = "The answer couldn't be sent to Genex." }
	end
	local failure = if type(result) == "table" and type(result.code) == "string"
		then result
		else { code = ErrorCode.Failed, message = tostring(result) }
	pcall(send, connection, {
		type = Message.Answer,
		re = id,
		ok = false,
		error = { code = failure.code, message = protocol.plain(tostring(failure.message), MAX_ERROR_CHARS) },
	})
end

local function onMessage(connection: Connection, text: string)
	local message = protocol.decode(text)
	if type(message) ~= "table" or message.v ~= constants.PROTOCOL or type(message.id) ~= "number" then
		return
	end
	if message.type == Message.DataChunk then
		keepChunk(connection, message.body)
		return
	end
	local id = message.id
	local handler = if message.type == Message.SessionMark then markSession else handlers[message.type] or unknownRequest
	local body = if type(message.body) == "table" then message.body else {}
	local request: Request = {
		id = id,
		body = body,
		connection = connection,
		sendPart = function(name: string, data: buffer)
			sendPart(connection, id, name, data)
		end,
		takeParts = function()
			return takeParts(connection, id)
		end,
	}
	task.spawn(function()
		local ok, result = pcall(handler, request)
		connection.transfers[id] = nil
		answer(connection, id, ok, result)
	end)
end

local function forget(connection: Connection)
	if connections[connection.port] ~= connection then
		return
	end
	connection.open = false
	connections[connection.port] = nil
	for _, event in connection.events do
		event:Disconnect()
	end
	pcall(connection.client.Close, connection.client)
	updateMarker()
	wake = true
end

local function hello(): { [string]: any }
	return {
		helper = constants.HELPER_VERSION,
		place = {
			id = string.format("%d", game.PlaceId),
			name = protocol.plain(game.Name, 200),
		},
	}
end

-- Opens a connection to the Genex app on `port`, if one listens there; answers whether it did.
local function connect(port: number): boolean
	local made, client = pcall(function()
		return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, {
			Url = `ws://127.0.0.1:{port}{constants.PATH}`,
		})
	end)
	if not made then
		return false
	end
	local connection: Connection = {
		port = port,
		client = client,
		nextId = 0,
		open = false,
		transfers = {},
		transferChars = 0,
		events = {},
	}
	local state = "waiting"
	connection.events = {
		client.Opened:Connect(function()
			if state == "waiting" then
				state = "open"
			end
		end),
		client.Error:Connect(function()
			state = "failed"
			forget(connection)
		end),
		client.Closed:Connect(function()
			state = "failed"
			forget(connection)
		end),
		client.MessageReceived:Connect(function(text: string)
			if connection.open then
				onMessage(connection, text)
			end
		end),
	}
	local deadline = os.clock() + CONNECT_SECONDS
	while state == "waiting" and os.clock() < deadline do
		task.wait(0.1)
	end
	if state ~= "open" then
		for _, event in connection.events do
			event:Disconnect()
		end
		pcall(client.Close, client)
		return false
	end
	connection.open = true
	connections[port] = connection
	local said = pcall(send, connection, { type = Message.Hello, body = hello() })
	if not said then
		forget(connection)
		return false
	end
	return true
end

local function pause(seconds: number)
	local stop = os.clock() + seconds
	while running and not wake and os.clock() < stop do
		task.wait(WAIT_STEP_SECONDS)
	end
	wake = false
end

local function keepConnected()
	local delay = RETRY_FIRST_SECONDS
	while running do
		local found = false
		for _, port in constants.PORTS do
			if not running or openCount() >= MAX_BACKENDS then
				break
			end
			if not connections[port] and connect(port) then
				found = true
			end
		end
		delay = if found then RETRY_FIRST_SECONDS else math.min(delay * 2, RETRY_MAX_SECONDS)
		pause(delay)
	end
end

-- Starts looking for Genex and answering it with `byType`'s handlers (request type to handler).
function link.start(byType: { [string]: Handler })
	handlers = byType
	running = true
	task.spawn(keepConnected)
end

-- Sends an event to every open connection.
function link.broadcast(kind: string, body: { [string]: any })
	for _, connection in connections do
		if connection.open then
			pcall(send, connection, { type = kind, body = body })
		end
	end
end

-- Closes every connection and removes the marker: the plugin is unloading.
function link.stop()
	running = false
	for _, connection in connections do
		forget(connection)
	end
	local marker = CoreGui:FindFirstChild(constants.SESSION_MARKER)
	if marker then
		marker:Destroy()
	end
end

return link
