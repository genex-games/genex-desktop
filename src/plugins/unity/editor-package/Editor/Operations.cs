using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Genex.Unity
{
    /// <summary>The fixed Editor API. It never evaluates client-supplied C# or shell commands.</summary>
    public static class Operations
    {
        static readonly List<JToken> Console = new List<JToken>();
        static long sequence;
        static readonly Dictionary<string, Func<JObject, JToken>> Handlers = new Dictionary<string, Func<JObject, JToken>> {
            ["editor.status"] = Status, ["editor.console"] = ReadConsole,
            ["editor.play"] = p => { EditorApplication.isPlaying = true; return Status(p); },
            ["editor.stop"] = p => { EditorApplication.isPlaying = false; return Status(p); },
            ["editor.pause"] = p => { EditorApplication.isPaused = Args.Flag(p, "paused", true); return Status(p); },
            ["editor.step"] = p => { if (!EditorApplication.isPlaying || !EditorApplication.isPaused) throw new BridgeException("invalid_state", "Step requires paused Play mode"); EditorApplication.Step(); return Status(p); },
            ["editor.undo"] = p => { Args.Confirm(p); Undo.PerformUndo(); return Status(p); },
            ["editor.redo"] = p => { Args.Confirm(p); Undo.PerformRedo(); return Status(p); },
            ["scene.list"] = SceneTools.List, ["scene.create"] = SceneTools.Create,
            ["scene.open"] = SceneTools.Open, ["scene.save"] = SceneTools.Save, ["scene.close"] = SceneTools.Close,
            ["hierarchy.list"] = SceneTools.Hierarchy,
            ["object.inspect"] = ObjectTools.Inspect, ["object.create"] = ObjectTools.Create,
            ["object.update"] = ObjectTools.Update, ["object.delete"] = ObjectTools.Delete,
            ["component.list"] = ComponentTools.List, ["component.add"] = ComponentTools.Add,
            ["component.remove"] = ComponentTools.Remove, ["component.get"] = ComponentTools.Get, ["component.set"] = ComponentTools.Set,
            ["component.types"] = ProjectTools.Types, ["type.inspect"] = ProjectTools.InspectType,
            ["project.verify"] = ProjectTools.Verify, ["scene.build-scenes"] = ProjectTools.BuildScenes,
            ["asset.search"] = AssetTools.Search, ["asset.inspect"] = AssetTools.Inspect,
            ["asset.import"] = AssetTools.Import, ["asset.move"] = AssetTools.Move, ["asset.delete"] = AssetTools.Delete,
            ["prefab.create"] = AssetTools.PrefabCreate, ["prefab.instantiate"] = AssetTools.PrefabInstantiate,
            ["prefab.apply"] = AssetTools.PrefabApply,
            ["material.create"] = AssetTools.MaterialCreate, ["material.update"] = AssetTools.MaterialUpdate,
            ["script.read"] = AssetTools.ScriptRead, ["script.write"] = AssetTools.ScriptWrite, ["script.delete"] = AssetTools.ScriptDelete,
            ["asset.read-text"] = AssetTools.ScriptRead, ["asset.write-text"] = AssetTools.ScriptWrite,
            ["capture.camera"] = CaptureTools.Camera, ["capture.scene"] = CaptureTools.Scene,
            ["batch"] = Batch,
            ["job.start"] = EditorJobs.Start, ["job.status"] = EditorJobs.Status, ["job.cancel"] = EditorJobs.Cancel,
            ["package.list"] = EditorJobs.PackageList, ["package.add"] = EditorJobs.PackageAdd, ["package.remove"] = EditorJobs.PackageRemove
        };

        static Operations() { Application.logMessageReceived += RecordLog; }

        public static JToken Dispatch(string method, JObject parameters)
        {
            if (!Handlers.TryGetValue(method, out var handler)) throw new BridgeException("unknown_method", "Unknown Editor method: " + method);
            return handler(parameters ?? new JObject());
        }

        static void RecordLog(string message, string stack, LogType type)
        {
            Console.Add(new JObject { ["sequence"] = ++sequence, ["type"] = type.ToString().ToLowerInvariant(),
                ["message"] = message.Length > 8000 ? message.Substring(0, 8000) : message,
                ["stack"] = stack.Length > 8000 ? stack.Substring(0, 8000) : stack });
            if (Console.Count > 500) Console.RemoveAt(0);
        }

        static JToken Status(JObject p)
        {
            return new JObject { ["projectRoot"] = ProjectFiles.Root, ["projectId"] = ProjectFiles.ProjectId,
                ["unityVersion"] = Application.unityVersion, ["isCompiling"] = EditorApplication.isCompiling,
                ["isUpdating"] = EditorApplication.isUpdating, ["isPlaying"] = EditorApplication.isPlaying,
                ["isPaused"] = EditorApplication.isPaused, ["isChangingPlayMode"] = EditorApplication.isPlayingOrWillChangePlaymode != EditorApplication.isPlaying,
                ["isBuilding"] = BuildPipeline.isBuildingPlayer, ["activeBuildTarget"] = EditorUserBuildSettings.activeBuildTarget.ToString(),
                ["activeScene"] = SceneTools.Description(SceneManager.GetActiveScene()), ["methods"] = new JArray(Handlers.Keys.OrderBy(k => k)) };
        }

        static JToken ReadConsole(JObject p)
        {
            var since = Args.Number(p, "since", 0, 0, int.MaxValue);
            var type = Args.Text(p, "type", "all", 32);
            var entries = Console.Where(t => t.Value<long>("sequence") > since && (type == "all" || t.Value<string>("type") == type)).ToArray();
            var limit = Args.Number(p, "limit", 100, 1, 500);
            if (Args.Flag(p, "tail"))
                return new JObject { ["entries"] = new JArray(entries.Skip(Math.Max(0, entries.Length - limit))),
                    ["nextSequence"] = sequence, ["oldestSequence"] = Console.Count == 0 ? sequence : Console[0]["sequence"] };
            return new JObject { ["entries"] = new JArray(entries.Take(limit)),
                ["nextSequence"] = entries.Length > limit ? entries[limit - 1]["sequence"] : sequence,
                ["oldestSequence"] = Console.Count == 0 ? sequence : Console[0]["sequence"] };
        }

        static JToken Batch(JObject p)
        {
            var commands = p["commands"] as JArray;
            if (commands == null || commands.Count == 0 || commands.Count > 25)
                throw new BridgeException("invalid_argument", "Batch requires 1 to 25 commands");
            var results = new JArray();
            foreach (var item in commands)
            {
                if (!(item is JObject command)) throw new BridgeException("invalid_argument", "Every command must be an object");
                var method = Args.Text(command, "method", max: 128);
                if (method == "batch" || method.StartsWith("job.", StringComparison.Ordinal) || method.StartsWith("package.", StringComparison.Ordinal))
                    throw new BridgeException("invalid_argument", "Nested batches and jobs are not batch operations");
                try { results.Add(new JObject { ["ok"] = true, ["result"] = Dispatch(method, (JObject)command["params"] ?? new JObject()) }); }
                catch (Exception error)
                {
                    results.Add(new JObject { ["ok"] = false, ["error"] = new JObject { ["code"] = (error as BridgeException)?.Code ?? "editor_error", ["message"] = error.Message } });
                    if (Args.Flag(p, "failFast", true)) break;
                }
            }
            return new JObject { ["results"] = results, ["transactional"] = false };
        }

        internal static void EditOnly()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new BridgeException("invalid_state", "Stop Play mode before editing project or scene content");
        }

        internal static void BeginUndo(string label)
        {
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("Genex: " + label);
        }
    }
}
