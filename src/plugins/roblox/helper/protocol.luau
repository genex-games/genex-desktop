--!strict
--!native
-- The wire format between this helper and Genex: one JSON object per WebSocket text message,
-- base64 for bytes, and the FNV-1a hash (32 bits, eight hex digits) both sides compute the same
-- way. JSON is written here rather than by HttpService:JSONEncode, which writes an empty table as
-- an array and drops a nil field; a list is marked with `protocol.array` and a null is
-- `protocol.NULL`.

local HttpService = game:GetService("HttpService")

local protocol = {}

local arrayMark = table.freeze({})
local ARRAY_META = table.freeze({ __genexArray = arrayMark })

-- A value that is written as JSON null.
protocol.NULL = table.freeze({ __genexNull = true })

-- Marks a table as a JSON list, so an empty one is written `[]` and not `{}`.
function protocol.array<T>(items: { T }): { T }
	return setmetatable(items, ARRAY_META) :: any
end

-- Raised by a handler to answer with an error code the backend reads; any other error is a failure.
export type Failure = { code: string, message: string }

function protocol.fail(code: string, message: string): never
	error({ code = code, message = message } :: Failure, 0)
end

local ESCAPES = {
	['"'] = '\\"',
	["\\"] = "\\\\",
	["\b"] = "\\b",
	["\f"] = "\\f",
	["\n"] = "\\n",
	["\r"] = "\\r",
	["\t"] = "\\t",
}

local function escapeCharacter(character: string): string
	return ESCAPES[character] or string.format("\\u%04x", string.byte(character))
end

local function encodeString(text: string): string
	return '"' .. (string.gsub(text, '[%c"\\]', escapeCharacter)) .. '"'
end

local function encodeNumber(value: number): string
	if value ~= value or value == math.huge or value == -math.huge then
		error("a number that JSON can't hold", 0)
	end
	if value == math.floor(value) and math.abs(value) < 2 ^ 53 then
		return string.format("%d", value)
	end
	return string.format("%.17g", value)
end

local encode: (value: any) -> string

local function encodeTable(value: { [any]: any }): string
	if value == protocol.NULL then
		return "null"
	end
	local isArray = getmetatable(value) == ARRAY_META or (next(value) ~= nil and value[1] ~= nil)
	local parts = {}
	if isArray then
		for index = 1, #value do
			parts[index] = encode(value[index])
		end
		return "[" .. table.concat(parts, ",") .. "]"
	end
	local keys = {}
	for key in value do
		if type(key) ~= "string" then
			error("an object key that isn't text", 0)
		end
		table.insert(keys, key)
	end
	table.sort(keys)
	for index, key in keys do
		parts[index] = encodeString(key) .. ":" .. encode(value[key])
	end
	return "{" .. table.concat(parts, ",") .. "}"
end

encode = function(value: any): string
	local kind = type(value)
	if value == nil then
		return "null"
	elseif kind == "boolean" then
		return if value then "true" else "false"
	elseif kind == "number" then
		return encodeNumber(value)
	elseif kind == "string" then
		return encodeString(value)
	elseif kind == "table" then
		return encodeTable(value)
	end
	error("a value JSON can't hold: " .. kind, 0)
end

-- `value` as JSON text; object keys sorted, so the same value is always the same text.
protocol.encode = encode

-- The value a JSON text holds, or nil when it isn't JSON.
function protocol.decode(text: string): any
	local ok, value = pcall(HttpService.JSONDecode, HttpService, text)
	return if ok then value else nil
end

-- Whether `text` is valid UTF-8, which every message must be.
function protocol.isText(text: string): boolean
	return utf8.len(text) ~= nil
end

local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local ENCODE = buffer.fromstring(ALPHABET)
local PAD = string.byte("=")
local DECODE = buffer.create(256)
buffer.fill(DECODE, 0, 255)
for index = 0, 63 do
	buffer.writeu8(DECODE, buffer.readu8(ENCODE, index), index)
end

-- `count` bytes of `data` from `offset` as base64 text.
function protocol.toBase64(data: buffer, offset: number, count: number): string
	local out = buffer.create(math.ceil(count / 3) * 4)
	local whole = offset + count - count % 3
	local at = 0
	local index = offset
	while index < whole do
		local triple = bit32.bor(
			bit32.lshift(buffer.readu8(data, index), 16),
			bit32.lshift(buffer.readu8(data, index + 1), 8),
			buffer.readu8(data, index + 2)
		)
		buffer.writeu8(out, at, buffer.readu8(ENCODE, bit32.rshift(triple, 18)))
		buffer.writeu8(out, at + 1, buffer.readu8(ENCODE, bit32.band(bit32.rshift(triple, 12), 63)))
		buffer.writeu8(out, at + 2, buffer.readu8(ENCODE, bit32.band(bit32.rshift(triple, 6), 63)))
		buffer.writeu8(out, at + 3, buffer.readu8(ENCODE, bit32.band(triple, 63)))
		index += 3
		at += 4
	end
	local left = count % 3
	if left > 0 then
		local first = buffer.readu8(data, index)
		local second = if left == 2 then buffer.readu8(data, index + 1) else 0
		local pair = bit32.bor(bit32.lshift(first, 16), bit32.lshift(second, 8))
		buffer.writeu8(out, at, buffer.readu8(ENCODE, bit32.rshift(pair, 18)))
		buffer.writeu8(out, at + 1, buffer.readu8(ENCODE, bit32.band(bit32.rshift(pair, 12), 63)))
		buffer.writeu8(out, at + 2, if left == 2 then buffer.readu8(ENCODE, bit32.band(bit32.rshift(pair, 6), 63)) else PAD)
		buffer.writeu8(out, at + 3, PAD)
	end
	return buffer.tostring(out)
end

-- The bytes base64 `text` holds, or nil when it isn't base64.
function protocol.fromBase64(text: string): buffer?
	local length = #text
	if length % 4 ~= 0 then
		return nil
	end
	local source = buffer.fromstring(text)
	local padding = 0
	if length > 0 and buffer.readu8(source, length - 1) == PAD then
		padding = if buffer.readu8(source, length - 2) == PAD then 2 else 1
	end
	local out = buffer.create(length // 4 * 3 - padding)
	local at = 0
	for index = 0, length - 1, 4 do
		local quad = 0
		for offset = 0, 3 do
			local byte = buffer.readu8(source, index + offset)
			local value = buffer.readu8(DECODE, byte)
			local padded = byte == PAD and index + offset >= length - padding
			if value == 255 and not padded then
				return nil
			end
			quad = bit32.bor(bit32.lshift(quad, 6), if padded then 0 else value)
		end
		local size = math.min(3, buffer.len(out) - at)
		for offset = 0, size - 1 do
			buffer.writeu8(out, at + offset, bit32.band(bit32.rshift(quad, 16 - offset * 8), 255))
		end
		at += size
	end
	return out
end

local FNV_OFFSET = 2166136261
local TWO_TO_32 = 4294967296

-- The FNV-1a hash of `data`'s bytes (a buffer, or a string as its bytes), as eight hex digits.
function protocol.hash(data: buffer | string): string
	local bytes = if type(data) == "string" then buffer.fromstring(data) else data
	local hash = FNV_OFFSET
	for index = 0, buffer.len(bytes) - 1 do
		hash = bit32.bxor(hash, buffer.readu8(bytes, index))
		-- The FNV prime is 2^24 + 403; splitting the product keeps it exact in a double.
		hash = (bit32.lshift(hash, 24) + hash * 403) % TWO_TO_32
	end
	return string.format("%08x", hash)
end

-- A message as one plain line of at most `limit` characters, never cut inside a character.
function protocol.plain(message: string, limit: number): string
	local line = string.gsub(message, "%c", " ")
	if not protocol.isText(line) then
		return "(a message that isn't text)"
	end
	local stop = utf8.offset(line, limit + 1)
	return if stop then string.sub(line, 1, stop - 1) else line
end

return protocol
