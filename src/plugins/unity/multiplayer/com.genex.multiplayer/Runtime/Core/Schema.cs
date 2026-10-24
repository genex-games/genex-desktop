// Room state for Genex relay protocol 3 — a field-for-field mirror of
// packages/multiplayer/src/schema.ts (PROTOCOL.md §4). FIELD ORDER IS WIRE ORDER: the index in each
// [Type] attribute must match the TypeScript field order, and a field is only ever appended.
//
// Every number is a C# double: "number", "float32" and "float64" all decode into double, as the
// official schema-codegen emits. Engine-agnostic: no UnityEngine here.
using Colyseus.Schema;

namespace Genex.Multiplayer.Wire
{
    public partial class PlayerState : Schema
    {
        [Type(0, "string")] public string name = "";
        [Type(1, "string")] public string data = "{}";
        [Type(2, "number")] public double epoch = 0;
        [Type(3, "boolean")] public bool connected = true;
        [Type(4, "string")] public string avatarUrl = "";
        [Type(5, "string")] public string uid = "";
        [Type(6, "number")] public double team = -1;
        // Optional typed pose (§6.6), appended in protocol 3.
        [Type(7, "float32")] public double x = 0;
        [Type(8, "float32")] public double y = 0;
        [Type(9, "float32")] public double z = 0;
        [Type(10, "float32")] public double yaw = 0;
        [Type(11, "float32")] public double vx = 0;
        [Type(12, "float32")] public double vy = 0;
        [Type(13, "float32")] public double vz = 0;
        [Type(14, "string")] public string anim = "";
        [Type(15, "float64")] public double poseT = 0;
        [Type(16, "boolean")] public bool posed = false;
    }

    public partial class ObjectState : Schema
    {
        [Type(0, "string")] public string owner = "";
        [Type(1, "number")] public double seq = 0;
        [Type(2, "number")] public double epoch = 0;
        [Type(3, "float64")] public double t = 0;
        [Type(4, "string")] public string d = "";
    }

    public partial class RoomState : Schema
    {
        [Type(0, "map", typeof(MapSchema<PlayerState>))] public MapSchema<PlayerState> players = new MapSchema<PlayerState>();
        [Type(1, "map", typeof(MapSchema<string>), "string")] public MapSchema<string> shared = new MapSchema<string>();
        [Type(2, "map", typeof(MapSchema<ObjectState>))] public MapSchema<ObjectState> objects = new MapSchema<ObjectState>();
        [Type(3, "string")] public string host = "";
        [Type(4, "string")] public string match = "";
        [Type(5, "map", typeof(MapSchema<bool>), "boolean")] public MapSchema<bool> voice = new MapSchema<bool>();
        [Type(6, "float64")] public double clockOrigin = 0;
    }
}
