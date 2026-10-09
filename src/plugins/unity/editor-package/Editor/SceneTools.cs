using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Genex.Unity
{
    internal static class SceneTools
    {
        internal static string Handle(Scene scene)
        {
#if UNITY_6000_5_OR_NEWER
            return scene.handle.GetRawData().ToString();
#else
            return scene.handle.ToString();
#endif
        }
        internal static JObject Description(Scene scene) => new JObject {
            ["handle"] = Handle(scene), ["name"] = scene.name, ["path"] = scene.path,
            ["loaded"] = scene.isLoaded, ["dirty"] = scene.isDirty, ["active"] = scene == SceneManager.GetActiveScene()
        };

        internal static Scene Resolve(JObject p)
        {
            if (p["scene"] == null) return SceneManager.GetActiveScene();
            if (p["scene"].Type == JTokenType.Integer)
            {
                var handle = p["scene"].ToString();
                for (var i = 0; i < SceneManager.sceneCount; i++)
                    if (Handle(SceneManager.GetSceneAt(i)) == handle) return SceneManager.GetSceneAt(i);
            }
            else
            {
                var path = Args.Text(p, "scene");
                for (var i = 0; i < SceneManager.sceneCount; i++)
                    if (SceneManager.GetSceneAt(i).path == path || Handle(SceneManager.GetSceneAt(i)) == path) return SceneManager.GetSceneAt(i);
            }
            throw new BridgeException("not_found", "Loaded scene was not found");
        }
        public static JToken List(JObject p)
        {
            var list = new JArray();
            for (var i = 0; i < SceneManager.sceneCount; i++) list.Add(Description(SceneManager.GetSceneAt(i)));
            return new JObject { ["scenes"] = list };
        }
        static void CheckReplace(JObject p)
        {
            if (Args.Flag(p, "additive", true)) return;
            Args.Confirm(p);
            for (var i = 0; i < SceneManager.sceneCount; i++)
                if (SceneManager.GetSceneAt(i).isDirty) throw new BridgeException("unsaved_scene", "Save dirty scenes before replacing them");
        }
        public static JToken Create(JObject p)
        {
            Operations.EditOnly();
            CheckReplace(p);
            var setup = Args.Flag(p, "defaultObjects") ? NewSceneSetup.DefaultGameObjects : NewSceneSetup.EmptyScene;
            var scene = EditorSceneManager.NewScene(setup, Args.Flag(p, "additive", true) ? NewSceneMode.Additive : NewSceneMode.Single);
            if (Args.Flag(p, "active", true)) SceneManager.SetActiveScene(scene);
            return Description(scene);
        }
        public static JToken Open(JObject p)
        {
            Operations.EditOnly();
            CheckReplace(p);
            var relative = Args.Text(p, "path");
            if (!relative.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) || !File.Exists(ProjectFiles.Resolve(relative)))
                throw new BridgeException("invalid_path", "Expected an existing Assets scene");
            var scene = EditorSceneManager.OpenScene(relative, Args.Flag(p, "additive", true) ? OpenSceneMode.Additive : OpenSceneMode.Single);
            if (Args.Flag(p, "active", true)) SceneManager.SetActiveScene(scene);
            return Description(scene);
        }
        public static JToken Save(JObject p)
        {
            Operations.EditOnly();
            var scene = Resolve(p);
            var relative = Args.Text(p, "path", scene.path);
            if (!relative.EndsWith(".unity", StringComparison.OrdinalIgnoreCase)) throw new BridgeException("invalid_path", "Scene path must end in .unity");
            var absolute = ProjectFiles.Resolve(relative);
            if (File.Exists(absolute) && relative != scene.path) Args.Confirm(p);
            Directory.CreateDirectory(Path.GetDirectoryName(absolute));
            if (!EditorSceneManager.SaveScene(scene, relative)) throw new BridgeException("editor_error", "Unity could not save the scene");
            return Description(scene);
        }
        public static JToken Close(JObject p)
        {
            Operations.EditOnly();
            Args.Confirm(p);
            var scene = Resolve(p);
            if (scene.isDirty) throw new BridgeException("unsaved_scene", "Save the scene before closing it");
            if (SceneManager.sceneCount == 1) throw new BridgeException("invalid_state", "Keep at least one scene loaded");
            if (!EditorSceneManager.CloseScene(scene, true)) throw new BridgeException("editor_error", "Unity could not close the scene");
            return new JObject { ["closed"] = true };
        }
        public static JToken Hierarchy(JObject p)
        {
            var items = new List<JToken>();
            var roots = p["scene"] == null ? AllRoots() : Resolve(p).GetRootGameObjects();
            var depth = Args.Number(p, "depth", 20, 0, 100);
            foreach (var root in roots) Visit(root.transform, null, 0, depth, items);
            return Args.Page(items, p);
        }
        static GameObject[] AllRoots()
        {
            var roots = new List<GameObject>();
            for (var i = 0; i < SceneManager.sceneCount; i++) roots.AddRange(SceneManager.GetSceneAt(i).GetRootGameObjects());
            return roots.ToArray();
        }
        static void Visit(Transform transform, string parent, int depth, int maximum, List<JToken> output)
        {
            if (output.Count >= 100000) throw new BridgeException("limit_exceeded", "Hierarchy exceeds 100000 objects");
            var id = Args.Id(transform.gameObject);
            output.Add(new JObject { ["id"] = id, ["parent"] = parent, ["name"] = transform.name,
                ["active"] = transform.gameObject.activeSelf, ["scene"] = Handle(transform.gameObject.scene),
                ["depth"] = depth, ["childCount"] = transform.childCount });
            if (depth >= maximum) return;
            foreach (Transform child in transform) Visit(child, id, depth + 1, maximum, output);
        }
    }
}
