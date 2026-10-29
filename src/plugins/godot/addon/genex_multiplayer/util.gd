extends RefCounted
## Payload hygiene shared by both backends (PROTOCOL.md §1).

const P = preload("res://addons/genex_multiplayer/protocol.gd")
const MAX_DEPTH := 32


## A JSON-shaped copy of `v` the relay accepts: integers outside int32 become floats (the relay
## drops any msgpack int64), non-finite floats become 0, Godot vectors/quaternions/colours become
## number arrays ([x,y,z,w] for a Quaternion, which remote smoothing slerps), keys become strings,
## and anything else that has no JSON form becomes null.
static func sanitize(v, depth := 0):
	if depth > MAX_DEPTH:
		return null
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_STRING:
			return v
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(v)
		TYPE_INT:
			return v if (v >= P.INT32_MIN and v <= P.INT32_MAX) else float(v)
		TYPE_FLOAT:
			return v if is_finite(v) else 0.0
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [_f(v.x), _f(v.y)]
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return [_f(v.x), _f(v.y), _f(v.z)]
		TYPE_VECTOR4, TYPE_VECTOR4I:
			return [_f(v.x), _f(v.y), _f(v.z), _f(v.w)]
		TYPE_QUATERNION:
			return [_f(v.x), _f(v.y), _f(v.z), _f(v.w)]
		TYPE_COLOR:
			return [_f(v.r), _f(v.g), _f(v.b), _f(v.a)]
		TYPE_DICTIONARY:
			var out := {}
			for k in v:
				out[str(k)] = sanitize(v[k], depth + 1)
			return out
		TYPE_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_INT32_ARRAY, \
		TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_STRING_ARRAY:
			var arr := []
			for e in v:
				arr.append(sanitize(e, depth + 1))
			return arr
	return null


static func _f(x) -> float:
	var f := float(x)
	return f if is_finite(f) else 0.0


## Incoming msgpack hygiene. The relay's encoder writes an unset optional key as msgpack's
## `undefined` extension (ext 0), which the Colyseus Godot binding decodes as a
## PackedByteArray([0]) (measured). Payloads never carry binary (§1), so every PackedByteArray
## is an extension: drop it from dictionaries (an absent key) and read it as null elsewhere.
static func strip_undefined(v):
	match typeof(v):
		TYPE_PACKED_BYTE_ARRAY:
			return null
		TYPE_DICTIONARY:
			var out := {}
			for k in v:
				if typeof(v[k]) != TYPE_PACKED_BYTE_ARRAY:
					out[k] = strip_undefined(v[k])
			return out
		TYPE_ARRAY:
			var arr := []
			for e in v:
				arr.append(strip_undefined(e))
			return arr
	return v


## Parse JSON text that should hold an object; anything else reads as {}.
static func parse_object(text: String) -> Dictionary:
	if text == "":
		return {}
	var json := JSON.new()
	if json.parse(text) != OK:
		return {}
	return json.data if json.data is Dictionary else {}
