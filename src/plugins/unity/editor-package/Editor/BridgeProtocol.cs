using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace Genex.Unity
{
    /// <summary>A client-visible, coded failure without internal stack traces.</summary>
    public sealed class BridgeException : Exception
    {
        public string Code { get; }
        public BridgeException(string code, string message) : base(message) { Code = code; }
    }

    internal static class Args
    {
        public static string Text(JObject p, string key, string fallback = null, int max = 4096)
        {
            var token = p[key];
            if (token == null || token.Type == JTokenType.Null)
            {
                if (fallback != null) return fallback;
                throw new BridgeException("invalid_argument", key + " is required");
            }
            if (token.Type != JTokenType.String || token.Value<string>().Length > max)
                throw new BridgeException("invalid_argument", key + " must be bounded text");
            return token.Value<string>();
        }
        public static int Number(JObject p, string key, int fallback, int min, int max)
        {
            var token = p[key];
            if (token == null) return fallback;
            if (token.Type != JTokenType.Integer) throw new BridgeException("invalid_argument", key + " must be an integer");
            var value = token.Value<long>();
            if (value < min || value > max) throw new BridgeException("invalid_argument", key + " is out of range");
            return (int)value;
        }
        public static bool Flag(JObject p, string key, bool fallback = false)
        {
            if (p[key] == null) return fallback;
            if (p[key].Type != JTokenType.Boolean) throw new BridgeException("invalid_argument", key + " must be boolean");
            return p[key].Value<bool>();
        }
        public static void Confirm(JObject p)
        {
            if (!Flag(p, "confirmed")) throw new BridgeException("confirmation_required", "This operation needs explicit approval");
        }
        public static Vector3 Vector(JToken value)
        {
            var array = value as JArray;
            if (array == null || array.Count != 3) throw new BridgeException("invalid_argument", "Expected a vector of three numbers");
            var values = array.Select(Finite).ToArray();
            return new Vector3(values[0], values[1], values[2]);
        }
        public static float Finite(JToken token)
        {
            if (token == null || (token.Type != JTokenType.Float && token.Type != JTokenType.Integer))
                throw new BridgeException("invalid_argument", "Expected a finite number");
            var value = token.Value<float>();
            if (float.IsNaN(value) || float.IsInfinity(value)) throw new BridgeException("invalid_argument", "Expected a finite number");
            return value;
        }
        public static string Id(Object obj)
        {
            if (!obj) return null;
            var stable = GlobalObjectId.GetGlobalObjectIdSlow(obj).ToString();
            // Unsaved scenes have no persistent scene GUID. Session IDs never masquerade as stable IDs.
            if (!stable.Contains("-00000000000000000000000000000000-")) return stable;
#if UNITY_6000_5_OR_NEWER
            return "session:" + EntityId.ToULong(obj.GetEntityId());
#else
            return "session:" + obj.GetInstanceID();
#endif
        }
        public static Object Object(JObject p, string key = "id")
        {
            var id = Text(p, key, max: 256);
            Object obj;
#if UNITY_6000_5_OR_NEWER
            if (id.StartsWith("session:", StringComparison.Ordinal) && ulong.TryParse(id.Substring(8), out var number))
                obj = EditorUtility.EntityIdToObject(EntityId.FromULong(number));
#else
            if (id.StartsWith("session:", StringComparison.Ordinal) && int.TryParse(id.Substring(8), out var number))
                obj = EditorUtility.InstanceIDToObject(number);
#endif
            else if (GlobalObjectId.TryParse(id, out var global)) obj = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(global);
            else throw new BridgeException("invalid_argument", "Object ID is malformed");
            if (!obj) throw new BridgeException("not_found", "The object no longer exists; read hierarchy again");
            return obj;
        }
        public static GameObject GameObject(JObject p, string key = "id")
        {
            var obj = Object(p, key);
            if (obj is GameObject go) return go;
            if (obj is Component component) return component.gameObject;
            throw new BridgeException("invalid_argument", "Expected a GameObject ID");
        }
        public static Type ComponentType(string name)
        {
            var candidates = TypeCache.GetTypesDerivedFrom<Component>().Where(t => t.FullName == name || t.Name == name).ToArray();
            if (candidates.Length != 1 || candidates[0].IsAbstract || candidates[0].ContainsGenericParameters)
                throw new BridgeException("invalid_argument", "Component type must uniquely identify a concrete Component");
            return candidates[0];
        }
        public static JArray Vec(Vector3 value) => new JArray(value.x, value.y, value.z);
        public static JObject Page(IReadOnlyList<JToken> items, JObject p)
        {
            var offset = Number(p, "offset", 0, 0, 1000000);
            var limit = Number(p, "limit", 100, 1, 500);
            return new JObject { ["items"] = new JArray(items.Skip(offset).Take(limit)), ["total"] = items.Count,
                ["nextOffset"] = offset + limit < items.Count ? (JToken)(offset + limit) : null };
        }
    }
}
