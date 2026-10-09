using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace Genex.Unity
{
    internal static class AssetTools
    {
        static string PathArg(JObject p, string key = "path", string extension = null)
        {
            var path = Args.Text(p, key);
            ProjectFiles.Resolve(path);
            if (extension != null && !path.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
                throw new BridgeException("invalid_path", "Expected a " + extension + " asset");
            return path;
        }
        static Object Load(JObject p)
        {
            var asset = AssetDatabase.LoadMainAssetAtPath(PathArg(p));
            if (!asset) throw new BridgeException("not_found", "Asset was not found");
            return asset;
        }
        public static JToken Search(JObject p)
        {
            var folder = Args.Text(p, "folder", "Assets");
            if (folder != "Assets") ProjectFiles.Resolve(folder + "/placeholder");
            var paths = AssetDatabase.FindAssets(Args.Text(p, "query", "", 256), new [] { folder })
                .Select(AssetDatabase.GUIDToAssetPath).Distinct().OrderBy(v => v).Select(path => (JToken)new JObject {
                    ["path"] = path, ["guid"] = AssetDatabase.AssetPathToGUID(path),
                    ["type"] = AssetDatabase.GetMainAssetTypeAtPath(path)?.FullName }).ToArray();
            return Args.Page(paths, p);
        }
        public static JToken Inspect(JObject p)
        {
            var path = PathArg(p);
            var asset = Load(p);
            var importer = AssetImporter.GetAtPath(path);
            return new JObject { ["path"] = path, ["id"] = Args.Id(asset), ["guid"] = AssetDatabase.AssetPathToGUID(path),
                ["type"] = asset.GetType().FullName, ["importer"] = importer ? importer.GetType().FullName : null,
                ["dependencies"] = new JArray(AssetDatabase.GetDependencies(path, false).Take(500)),
                ["bytes"] = File.Exists(ProjectFiles.Resolve(path)) ? new FileInfo(ProjectFiles.Resolve(path)).Length : 0 };
        }
        public static JToken Import(JObject p)
        {
            Operations.EditOnly();
            var path = PathArg(p);
            if (!File.Exists(ProjectFiles.Resolve(path)) && !Directory.Exists(ProjectFiles.Resolve(path)))
                throw new BridgeException("not_found", "Place the file under Assets before importing it");
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
            return new JObject { ["path"] = path, ["importRequested"] = true };
        }
        public static JToken Move(JObject p)
        {
            Operations.EditOnly();
            Args.Confirm(p);
            var source = PathArg(p);
            var destination = PathArg(p, "destination");
            if (File.Exists(ProjectFiles.Resolve(destination)) || Directory.Exists(ProjectFiles.Resolve(destination)))
                throw new BridgeException("already_exists", "Destination already exists");
            var result = AssetDatabase.MoveAsset(source, destination);
            if (result.Length > 0) throw new BridgeException("editor_error", result);
            return new JObject { ["path"] = destination, ["guid"] = AssetDatabase.AssetPathToGUID(destination) };
        }
        public static JToken Delete(JObject p)
        {
            Operations.EditOnly();
            Args.Confirm(p);
            var path = PathArg(p);
            if (!AssetDatabase.DeleteAsset(path)) throw new BridgeException("editor_error", "Asset could not be deleted");
            return new JObject { ["deleted"] = true, ["path"] = path };
        }
        static void EnsureNewAsset(string relative, JObject p)
        {
            var absolute = ProjectFiles.Resolve(relative);
            if (File.Exists(absolute)) Args.Confirm(p);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(absolute));
            ProjectFiles.AssertNoLinks(absolute);
        }
        public static JToken PrefabCreate(JObject p)
        {
            var go = ObjectTools.Editable(p);
            var path = PathArg(p, extension: ".prefab");
            EnsureNewAsset(path, p);
            var prefab = PrefabUtility.SaveAsPrefabAsset(go, path, out var success);
            if (!success || !prefab) throw new BridgeException("editor_error", "Prefab save failed");
            return new JObject { ["path"] = path, ["id"] = Args.Id(prefab), ["guid"] = AssetDatabase.AssetPathToGUID(path) };
        }
        public static JToken PrefabInstantiate(JObject p)
        {
            Operations.EditOnly();
            var path = PathArg(p, extension: ".prefab");
            var asset = Load(p) as GameObject;
            if (!asset) throw new BridgeException("invalid_argument", "Expected a prefab GameObject");
            Operations.BeginUndo("instantiate prefab");
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(asset, SceneTools.Resolve(p));
            Undo.RegisterCreatedObjectUndo(instance, "Genex: instantiate prefab");
            var update = (JObject)p.DeepClone();
            update["id"] = Args.Id(instance);
            return ObjectTools.Update(update);
        }
        public static JToken PrefabApply(JObject p)
        {
            Args.Confirm(p);
            var go = ObjectTools.Editable(p);
            var root = PrefabUtility.GetOutermostPrefabInstanceRoot(go);
            if (!root) throw new BridgeException("invalid_argument", "Object is not a prefab instance");
            var path = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(root);
            ProjectFiles.Resolve(path);
            PrefabUtility.ApplyPrefabInstance(root, InteractionMode.UserAction);
            return new JObject { ["applied"] = true, ["path"] = path };
        }
        public static JToken MaterialCreate(JObject p)
        {
            Operations.EditOnly();
            var path = PathArg(p, extension: ".mat");
            if (File.Exists(ProjectFiles.Resolve(path))) throw new BridgeException("already_exists", "Material already exists; update it separately");
            var shader = Shader.Find(Args.Text(p, "shader", "Standard", 256));
            if (!shader) throw new BridgeException("not_found", "Shader was not found; use a shader installed in this project");
            EnsureNewAsset(path, p);
            var material = new Material(shader);
            try { ApplyMaterial(material, p); AssetDatabase.CreateAsset(material, path); }
            catch { Object.DestroyImmediate(material); throw; }
            AssetDatabase.SaveAssetIfDirty(material);
            return new JObject { ["path"] = path, ["id"] = Args.Id(material), ["shader"] = shader.name };
        }
        public static JToken MaterialUpdate(JObject p)
        {
            Operations.EditOnly();
            var material = Load(p) as Material;
            if (!material) throw new BridgeException("invalid_argument", "Expected a material asset");
            Operations.BeginUndo("update material");
            Undo.RecordObject(material, "Genex: update material");
            ApplyMaterial(material, p);
            EditorUtility.SetDirty(material);
            AssetDatabase.SaveAssetIfDirty(material);
            return new JObject { ["path"] = p["path"], ["id"] = Args.Id(material), ["shader"] = material.shader.name };
        }
        static void ApplyMaterial(Material material, JObject p)
        {
            var values = p["properties"] as JObject;
            if (p["properties"] != null && values == null) throw new BridgeException("invalid_argument", "Material properties must be an object");
            if (values == null) return;
            if (values.Count > 64) throw new BridgeException("limit_exceeded", "At most 64 material properties per update");
            foreach (var property in values.Properties())
            {
                if (!material.HasProperty(property.Name)) throw new BridgeException("invalid_argument", "Shader has no property " + property.Name);
                if (property.Value is JArray array && array.Count == 4)
                    material.SetVector(property.Name, new Vector4(Args.Finite(array[0]), Args.Finite(array[1]), Args.Finite(array[2]), Args.Finite(array[3])));
                else if (property.Value.Type == JTokenType.Float || property.Value.Type == JTokenType.Integer)
                    material.SetFloat(property.Name, Args.Finite(property.Value));
                else if (property.Value.Type == JTokenType.String)
                {
                    var path = property.Value.Value<string>();
                    ProjectFiles.Resolve(path);
                    var texture = AssetDatabase.LoadAssetAtPath<Texture>(path);
                    if (!texture) throw new BridgeException("invalid_argument", "Texture asset was not found");
                    material.SetTexture(property.Name, texture);
                }
                else throw new BridgeException("invalid_argument", "Material value must be a float, RGBA/vector4, or texture asset path");
            }
        }
        static string TextPath(JObject p)
        {
            var path = PathArg(p);
            var extension = System.IO.Path.GetExtension(path).ToLowerInvariant();
            if (!new [] { ".cs", ".shader", ".compute", ".hlsl", ".cginc", ".uxml", ".uss", ".txt", ".json", ".asmdef" }.Contains(extension))
                throw new BridgeException("invalid_path", "This extension is not an editable project text asset");
            return path;
        }
        public static JToken ScriptRead(JObject p)
        {
            var path = TextPath(p);
            var absolute = ProjectFiles.Resolve(path);
            using (var file = File.Open(absolute, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (file.Length > ProjectFiles.MaximumTextBytes) throw new BridgeException("limit_exceeded", "Text exceeds 512 KiB");
                var bytes = new byte[file.Length];
                var offset = 0;
                while (offset < bytes.Length) { var read = file.Read(bytes, offset, bytes.Length - offset); if (read == 0) break; offset += read; }
                return new JObject { ["path"] = path, ["sha256"] = ProjectFiles.HashBytes(bytes), ["contents"] = new System.Text.UTF8Encoding(false, true).GetString(bytes) };
            }
        }
        public static JToken ScriptWrite(JObject p)
        {
            Operations.EditOnly();
            var path = TextPath(p);
            ProjectFiles.Write(path, Args.Text(p, "contents", max: ProjectFiles.MaximumTextBytes), p.Value<string>("expectedSha256"));
            var hash = ProjectFiles.Hash(ProjectFiles.Resolve(path));
            EditorApplication.delayCall += () => AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
            return new JObject { ["path"] = path, ["sha256"] = hash, ["compileRequested"] = path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".asmdef", StringComparison.OrdinalIgnoreCase) };
        }
        public static JToken ScriptDelete(JObject p)
        {
            Operations.EditOnly();
            Args.Confirm(p);
            var path = TextPath(p);
            if (ProjectFiles.Hash(ProjectFiles.Resolve(path)) != Args.Text(p, "expectedSha256", max: 64))
                throw new BridgeException("stale_file", "File changed; read it again before deletion");
            return Delete(p);
        }
    }
}
