using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Genex.Unity
{
    internal static class ProjectTools
    {
        public static JToken Types(JObject p)
        {
            var query = Args.Text(p, "query", "", 256);
            var list = TypeCache.GetTypesDerivedFrom<Component>().Where(t => !t.IsAbstract && !t.ContainsGenericParameters &&
                t.FullName != null && t.FullName.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(t => t.FullName).Select(t => (JToken)new JObject { ["name"] = t.FullName, ["assembly"] = t.Assembly.GetName().Name }).ToArray();
            return Args.Page(list, p);
        }
        public static JToken InspectType(JObject p)
        {
            var name = Args.Text(p, "type", max: 512);
            var matches = new List<Type>();
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var type = assembly.GetType(name, false);
                if (type != null) matches.Add(type);
            }
            if (matches.Count != 1) throw new BridgeException("invalid_argument", "Use a unique fully qualified loaded type name");
            var selected = matches[0];
            var fields = selected.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .Where(field => field.IsPublic || field.IsDefined(typeof(SerializeField), true)).Take(200)
                .Select(field => new JObject { ["name"] = field.Name, ["type"] = field.FieldType.FullName,
                    ["public"] = field.IsPublic, ["readonly"] = field.IsInitOnly });
            var properties = selected.GetProperties(BindingFlags.Instance | BindingFlags.Public).Take(200)
                .Select(property => new JObject { ["name"] = property.Name, ["type"] = property.PropertyType.FullName,
                    ["canRead"] = property.CanRead, ["canWrite"] = property.CanWrite });
            return new JObject { ["name"] = selected.FullName, ["assembly"] = selected.Assembly.GetName().Name,
                ["baseType"] = selected.BaseType?.FullName, ["component"] = typeof(Component).IsAssignableFrom(selected),
                ["fields"] = new JArray(fields), ["properties"] = new JArray(properties),
                ["methods"] = new JArray(selected.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
                    .Where(method => !method.IsSpecialName).Take(200).Select(method => method.ToString())) };
        }
        public static JToken Verify(JObject p)
        {
            var missing = new JArray();
            var count = 0;
            for (var index = 0; index < SceneManager.sceneCount; index++)
            {
                var scene = SceneManager.GetSceneAt(index);
                foreach (var root in scene.GetRootGameObjects())
                foreach (var transform in root.GetComponentsInChildren<Transform>(true))
                {
                    count++;
                    var scripts = GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(transform.gameObject);
                    if (scripts > 0 && missing.Count < 500) missing.Add(new JObject { ["id"] = Args.Id(transform.gameObject),
                        ["name"] = transform.name, ["scene"] = scene.path, ["missingScripts"] = scripts });
                }
            }
            return new JObject { ["projectId"] = ProjectFiles.ProjectId, ["isCompiling"] = EditorApplication.isCompiling,
                ["isUpdating"] = EditorApplication.isUpdating, ["scriptCompilationFailed"] = EditorUtility.scriptCompilationFailed,
                ["objectsChecked"] = count, ["missingScripts"] = missing, ["scope"] = "loaded scenes and current Editor compilation state",
                ["healthy"] = !EditorApplication.isCompiling && !EditorApplication.isUpdating && !EditorUtility.scriptCompilationFailed && missing.Count == 0 };
        }
        public static JToken BuildScenes(JObject p)
        {
            if (p["scenes"] != null)
            {
                Operations.EditOnly(); Args.Confirm(p);
                if (!(p["scenes"] is JArray list) || list.Count > 200) throw new BridgeException("invalid_argument", "Expected at most 200 build scene records");
                var scenes = new List<EditorBuildSettingsScene>();
                foreach (var item in list)
                {
                    if (!(item is JObject scene)) throw new BridgeException("invalid_argument", "Each build scene needs path and enabled");
                    var path = Args.Text(scene, "path");
                    if (!path.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) || !File.Exists(ProjectFiles.Resolve(path)))
                        throw new BridgeException("invalid_path", "Build scene must be a saved Assets scene");
                    scenes.Add(new EditorBuildSettingsScene(path, Args.Flag(scene, "enabled", true)));
                }
                if (scenes.Select(scene => scene.path).Distinct().Count() != scenes.Count)
                    throw new BridgeException("invalid_argument", "Build scene paths must be unique");
                EditorBuildSettings.scenes = scenes.ToArray();
            }
            return new JObject { ["scenes"] = new JArray(EditorBuildSettings.scenes.Select(scene => new JObject {
                ["path"] = scene.path, ["enabled"] = scene.enabled, ["guid"] = scene.guid.ToString() })),
                ["activeTarget"] = EditorUserBuildSettings.activeBuildTarget.ToString(),
                ["supportedTargets"] = new JArray(Enum.GetValues(typeof(BuildTarget)).Cast<BuildTarget>().Where(target =>
                    target != BuildTarget.NoTarget && BuildPipeline.IsBuildTargetSupported(BuildPipeline.GetBuildTargetGroup(target), target)).Select(target => target.ToString())) };
        }
    }
}
