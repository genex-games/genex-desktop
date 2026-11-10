// Room state for Genex relay protocol 3 — a field-for-field mirror of
// packages/multiplayer/src/schema.ts (PROTOCOL.md §4). FIELD ORDER IS WIRE ORDER: the index in each
// [Type] attribute must match the TypeScript field order, and a field is only ever appended.
//
// Every number is a C# double: "number", "float32" and "float64" all decode into double, as the
// official schema-codegen emits.
//
// [Preserve] on every constructor and field: the SDK binds fields and constructs the classes by
// reflection, and IL2CPP's stripping drops what no code reads (measured in a WebGL build with high
// stripping: "Default constructor not found for type Genex.Multiplayer.Wire.RoomState", and the room
// never joined; RoomState.voice is read by nothing). Engine-agnostic: UnityEngine only under
// UNITY_5_3_OR_NEWER.
using Colyseus.Schema;

namespace Genex.Multiplayer.Wire
{
    public partial class PlayerState : Schema
    {
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        public PlayerState() { }

#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(0, "string")] public string name = "";
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(1, "string")] public string data = "{}";
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(2, "number")] public double epoch = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(3, "boolean")] public bool connected = true;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(4, "string")] public string avatarUrl = "";
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(5, "string")] public string uid = "";
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(6, "number")] public double team = -1;
        // Optional typed pose (§6.6), appended in protocol 3.
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(7, "float32")] public double x = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(8, "float32")] public double y = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(9, "float32")] public double z = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(10, "float32")] public double yaw = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(11, "float32")] public double vx = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(12, "float32")] public double vy = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(13, "float32")] public double vz = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(14, "string")] public string anim = "";
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(15, "float64")] public double poseT = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(16, "boolean")] public bool posed = false;
    }

    public partial class ObjectState : Schema
    {
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        public ObjectState() { }

#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(0, "string")] public string owner = "";
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(1, "number")] public double seq = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(2, "number")] public double epoch = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(3, "float64")] public double t = 0;
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(4, "string")] public string d = "";
    }

    public partial class RoomState : Schema
    {
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        public RoomState() { }

#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(0, "map", typeof(MapSchema<PlayerState>))] public MapSchema<PlayerState> players = new MapSchema<PlayerState>();
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(1, "map", typeof(MapSchema<string>), "string")] public MapSchema<string> shared = new MapSchema<string>();
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(2, "map", typeof(MapSchema<ObjectState>))] public MapSchema<ObjectState> objects = new MapSchema<ObjectState>();
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(3, "string")] public string host = "";
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(4, "string")] public string match = "";
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(5, "map", typeof(MapSchema<bool>), "boolean")] public MapSchema<bool> voice = new MapSchema<bool>();
#if UNITY_5_3_OR_NEWER
        [UnityEngine.Scripting.Preserve]
#endif
        [Type(6, "float64")] public double clockOrigin = 0;
    }
}
