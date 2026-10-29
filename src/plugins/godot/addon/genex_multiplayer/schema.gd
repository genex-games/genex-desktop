extends RefCounted
## Room state schema for the official Colyseus GDExtension decoder: a port of
## packages/multiplayer/src/schema.ts (PROTOCOL.md §4). Field order is wire order;
## fields are only ever appended. Only used by the native backend.

const C = preload("res://addons/colyseus/colyseus.gd")
const S = C.Schema
const F = C.Schema.Field


class PlayerState extends C.Schema:
	static func definition() -> Array:
		return [
			F.new("name", S.STRING),
			F.new("data", S.STRING),
			F.new("epoch", S.NUMBER),
			F.new("connected", S.BOOLEAN),
			F.new("avatarUrl", S.STRING),
			F.new("uid", S.STRING),
			F.new("team", S.NUMBER),
			# §6.6 optional typed pose
			F.new("x", S.FLOAT32),
			F.new("y", S.FLOAT32),
			F.new("z", S.FLOAT32),
			F.new("yaw", S.FLOAT32),
			F.new("vx", S.FLOAT32),
			F.new("vy", S.FLOAT32),
			F.new("vz", S.FLOAT32),
			F.new("anim", S.STRING),
			F.new("poseT", S.FLOAT64),
			F.new("posed", S.BOOLEAN),
		]


class ObjectState extends C.Schema:
	static func definition() -> Array:
		return [
			F.new("owner", S.STRING),
			F.new("seq", S.NUMBER),
			F.new("epoch", S.NUMBER),
			F.new("t", S.FLOAT64),
			F.new("d", S.STRING),
		]


class RoomState extends C.Schema:
	static func definition() -> Array:
		return [
			F.new("players", S.MAP, PlayerState),
			F.new("shared", S.MAP, S.STRING),
			F.new("objects", S.MAP, ObjectState),
			F.new("host", S.STRING),
			F.new("match", S.STRING),
			F.new("voice", S.MAP, S.BOOLEAN),
			F.new("clockOrigin", S.FLOAT64),
		]
