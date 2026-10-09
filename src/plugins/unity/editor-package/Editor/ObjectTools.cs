using System;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Genex.Unity
{
    internal static class ObjectTools
    {
        internal static JObject Description(GameObject go) => new JObject {
            ["id"] = Args.Id(go), ["name"] = go.name, ["active"] = go.activeSelf,
            ["layer"] = go.layer, ["tag"] = go.tag, ["scene"] = SceneTools.Handle(go.scene),
            ["parent"] = Args.Id(go.transform.parent ? go.transform.parent.gameObject : null),
            ["position"] = Args.Vec(go.transform.position), ["rotation"] = Args.Vec(go.transform.eulerAngles),
            ["scale"] = Args.Vec(go.transform.localScale),
            ["components"] = new JArray(go.GetComponents<Component>().Select(c => c ? new JObject {
                ["id"] = Args.Id(c), ["type"] = c.GetType().FullName } : new JObject { ["missing"] = true }))
        };
        internal static GameObject Editable(JObject p)
        {
            Operations.EditOnly();
            var go = Args.GameObject(p);
            if (!go.scene.IsValid() || !go.scene.isLoaded || EditorUtility.IsPersistent(go))
                throw new BridgeException("invalid_state", "Only loaded scene objects can be edited through object tools");
            return go;
        }
        public static JToken Inspect(JObject p) => Description(Args.GameObject(p));
        public static JToken Create(JObject p)
        {
            Operations.EditOnly();
            var name = Args.Text(p, "name", "GameObject", 256);
            var primitive = Args.Text(p, "primitive", "", 32);
            if (primitive.Length > 0 && !Enum.TryParse<PrimitiveType>(primitive, false, out _))
                throw new BridgeException("invalid_argument", "Unknown primitive type");
            var parent = p["parent"] == null ? null : Args.GameObject(p, "parent");
            var scene = parent ? parent.scene : SceneTools.Resolve(p);
            Operations.BeginUndo("create " + name);
            var go = primitive.Length == 0 ? new GameObject(name) : GameObject.CreatePrimitive((PrimitiveType)Enum.Parse(typeof(PrimitiveType), primitive));
            Undo.RegisterCreatedObjectUndo(go, "Genex: create object");
            go.name = name;
            SceneManager.MoveGameObjectToScene(go, scene);
            if (parent) Undo.SetTransformParent(go.transform, parent.transform, "Genex: parent object");
            Apply(go, p);
            EditorSceneManager.MarkSceneDirty(go.scene);
            return Description(go);
        }
        public static JToken Update(JObject p)
        {
            var go = Editable(p);
            Operations.BeginUndo("update " + go.name);
            Apply(go, p);
            EditorSceneManager.MarkSceneDirty(go.scene);
            return Description(go);
        }
        static void Apply(GameObject go, JObject p)
        {
            // Validate values before changing either object or transform.
            var position = p["position"] == null ? (Vector3?)null : Args.Vector(p["position"]);
            var rotation = p["rotation"] == null ? (Vector3?)null : Args.Vector(p["rotation"]);
            var scale = p["scale"] == null ? (Vector3?)null : Args.Vector(p["scale"]);
            var parent = p["parent"] == null || p["parent"].Type == JTokenType.Null ? null : Args.GameObject(p, "parent");
            if (parent && (parent == go || parent.transform.IsChildOf(go.transform)))
                throw new BridgeException("invalid_argument", "An object cannot become its own ancestor");
            Undo.RecordObjects(new UnityEngine.Object[] { go, go.transform }, "Genex: update object");
            if (p["name"] != null) go.name = Args.Text(p, "name", max: 256);
            if (p["active"] != null) go.SetActive(Args.Flag(p, "active"));
            if (p["layer"] != null) go.layer = Args.Number(p, "layer", 0, 0, 31);
            if (p["tag"] != null) go.tag = Args.Text(p, "tag", max: 128);
            if (p.Property("parent") != null)
            {
                if (parent && parent.scene != go.scene) throw new BridgeException("invalid_argument", "Parent must be in the same scene");
                Undo.SetTransformParent(go.transform, parent ? parent.transform : null, "Genex: parent object");
            }
            if (position.HasValue) go.transform.position = position.Value;
            if (rotation.HasValue) go.transform.eulerAngles = rotation.Value;
            if (scale.HasValue) go.transform.localScale = scale.Value;
            PrefabUtility.RecordPrefabInstancePropertyModifications(go);
            PrefabUtility.RecordPrefabInstancePropertyModifications(go.transform);
        }
        public static JToken Delete(JObject p)
        {
            Args.Confirm(p);
            var go = Editable(p);
            var scene = go.scene;
            Operations.BeginUndo("delete " + go.name);
            Undo.DestroyObjectImmediate(go);
            EditorSceneManager.MarkSceneDirty(scene);
            return new JObject { ["deleted"] = true };
        }
    }
}
