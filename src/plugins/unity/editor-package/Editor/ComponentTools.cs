using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Genex.Unity
{
    internal static class ComponentTools
    {
        public static JToken List(JObject p)
        {
            return new JObject { ["components"] = new JArray(Args.GameObject(p).GetComponents<Component>().Select(c =>
                c ? new JObject { ["id"] = Args.Id(c), ["type"] = c.GetType().FullName } : new JObject { ["missing"] = true })) };
        }
        public static JToken Add(JObject p)
        {
            var go = ObjectTools.Editable(p);
            var type = Args.ComponentType(Args.Text(p, "type", max: 256));
            Operations.BeginUndo("add component");
            var component = Undo.AddComponent(go, type);
            if (!component) throw new BridgeException("editor_error", "Unity could not add this component");
            EditorSceneManager.MarkSceneDirty(go.scene);
            return new JObject { ["id"] = Args.Id(component), ["type"] = type.FullName };
        }
        static Component Resolve(JObject p)
        {
            if (!(Args.Object(p) is Component component)) throw new BridgeException("invalid_argument", "Expected a component ID");
            return component;
        }
        public static JToken Remove(JObject p)
        {
            Args.Confirm(p);
            var component = Resolve(p);
            ObjectTools.Editable(new JObject { ["id"] = Args.Id(component.gameObject) });
            if (component is Transform) throw new BridgeException("invalid_argument", "A GameObject needs its Transform");
            Operations.BeginUndo("remove component");
            var scene = component.gameObject.scene;
            Undo.DestroyObjectImmediate(component);
            EditorSceneManager.MarkSceneDirty(scene);
            return new JObject { ["removed"] = true };
        }
        public static JToken Get(JObject p)
        {
            var component = Resolve(p);
            var serialized = new SerializedObject(component);
            serialized.Update();
            var items = new List<JToken>();
            var iterator = serialized.GetIterator();
            var includeChildren = true;
            while (iterator.NextVisible(includeChildren) && items.Count < 2000)
            {
                items.Add(new JObject { ["path"] = iterator.propertyPath, ["type"] = iterator.propertyType.ToString(),
                    ["editable"] = iterator.editable && !Protected(iterator.propertyPath), ["value"] = Read(iterator) });
                includeChildren = iterator.propertyType == SerializedPropertyType.Generic && !iterator.isArray;
            }
            var result = Args.Page(items, p);
            result["id"] = Args.Id(component);
            result["type"] = component.GetType().FullName;
            return result;
        }
        static bool Protected(string path) => path == "m_Script" || path == "m_GameObject" || path.StartsWith("m_Prefab", StringComparison.Ordinal);
        static JToken Read(SerializedProperty property)
        {
            if (property.isArray && property.propertyType != SerializedPropertyType.String)
                return new JObject { ["size"] = property.arraySize };
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer: return property.longValue;
                case SerializedPropertyType.Boolean: return property.boolValue;
                case SerializedPropertyType.Float: return property.doubleValue;
                case SerializedPropertyType.String: return property.stringValue;
                case SerializedPropertyType.Enum: return new JObject { ["index"] = property.enumValueIndex, ["names"] = new JArray(property.enumNames) };
                case SerializedPropertyType.ObjectReference: return Args.Id(property.objectReferenceValue);
                case SerializedPropertyType.Vector2: return new JArray(property.vector2Value.x, property.vector2Value.y);
                case SerializedPropertyType.Vector3: return Args.Vec(property.vector3Value);
                case SerializedPropertyType.Vector4: var v = property.vector4Value; return new JArray(v.x, v.y, v.z, v.w);
                case SerializedPropertyType.Color: var c = property.colorValue; return new JArray(c.r, c.g, c.b, c.a);
                case SerializedPropertyType.Quaternion: var q = property.quaternionValue; return new JArray(q.x, q.y, q.z, q.w);
                case SerializedPropertyType.Rect: var r = property.rectValue; return new JArray(r.x, r.y, r.width, r.height);
                case SerializedPropertyType.Bounds: return new JObject { ["center"] = Args.Vec(property.boundsValue.center), ["size"] = Args.Vec(property.boundsValue.size) };
                default: return null;
            }
        }
        public static JToken Set(JObject p)
        {
            var component = Resolve(p);
            ObjectTools.Editable(new JObject { ["id"] = Args.Id(component.gameObject) });
            var name = Args.Text(p, "property", max: 512);
            var serialized = new SerializedObject(component);
            serialized.Update();
            var property = serialized.FindProperty(name);
            if (property == null || !property.editable || Protected(name)) throw new BridgeException("invalid_argument", "Property is missing or protected");
            Operations.BeginUndo("set component property");
            Undo.RecordObject(component, "Genex: set component property");
            Write(property, p["value"]);
            serialized.ApplyModifiedProperties();
            PrefabUtility.RecordPrefabInstancePropertyModifications(component);
            EditorSceneManager.MarkSceneDirty(component.gameObject.scene);
            return new JObject { ["id"] = Args.Id(component), ["property"] = name, ["value"] = Read(property) };
        }
        static float[] Array(JToken token, int count)
        {
            if (!(token is JArray values) || values.Count != count) throw new BridgeException("invalid_argument", "Unexpected vector dimensions");
            return values.Select(Args.Finite).ToArray();
        }
        static void Write(SerializedProperty property, JToken value)
        {
            if (property.isArray && property.propertyType != SerializedPropertyType.String)
            {
                if (value == null || value.Type != JTokenType.Integer || value.Value<int>() < 0 || value.Value<int>() > 1000)
                    throw new BridgeException("invalid_argument", "Array value is its new size (0 to 1000); set entries separately");
                property.arraySize = value.Value<int>();
                return;
            }
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer:
                    if (value?.Type != JTokenType.Integer) throw new BridgeException("invalid_argument", "Expected integer");
                    property.longValue = value.Value<long>(); break;
                case SerializedPropertyType.Boolean:
                    if (value?.Type != JTokenType.Boolean) throw new BridgeException("invalid_argument", "Expected boolean");
                    property.boolValue = value.Value<bool>(); break;
                case SerializedPropertyType.Float: property.floatValue = Args.Finite(value); break;
                case SerializedPropertyType.String:
                    if (value?.Type != JTokenType.String || value.Value<string>().Length > 16000) throw new BridgeException("invalid_argument", "Expected bounded string");
                    property.stringValue = value.Value<string>(); break;
                case SerializedPropertyType.Enum:
                    if (value?.Type != JTokenType.Integer || value.Value<int>() < 0 || value.Value<int>() >= property.enumNames.Length)
                        throw new BridgeException("invalid_argument", "Expected a valid enum index");
                    property.enumValueIndex = value.Value<int>(); break;
                case SerializedPropertyType.ObjectReference:
                    property.objectReferenceValue = value == null || value.Type == JTokenType.Null ? null : Args.Object(new JObject { ["id"] = value }); break;
                case SerializedPropertyType.Vector2: var v2 = Array(value, 2); property.vector2Value = new Vector2(v2[0], v2[1]); break;
                case SerializedPropertyType.Vector3: property.vector3Value = Args.Vector(value); break;
                case SerializedPropertyType.Vector4: var v4 = Array(value, 4); property.vector4Value = new Vector4(v4[0], v4[1], v4[2], v4[3]); break;
                case SerializedPropertyType.Color: var c = Array(value, 4); property.colorValue = new Color(c[0], c[1], c[2], c[3]); break;
                case SerializedPropertyType.Quaternion: var q = Array(value, 4); property.quaternionValue = new Quaternion(q[0], q[1], q[2], q[3]); break;
                case SerializedPropertyType.Rect: var r = Array(value, 4); property.rectValue = new Rect(r[0], r[1], r[2], r[3]); break;
                case SerializedPropertyType.Bounds:
                    if (!(value is JObject bounds)) throw new BridgeException("invalid_argument", "Expected bounds center/size");
                    property.boundsValue = new Bounds(Args.Vector(bounds["center"]), Args.Vector(bounds["size"])); break;
                default: throw new BridgeException("unsupported_property", "This serialized property type cannot be written by the bridge");
            }
        }
    }
}
