using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Genex.Unity
{
    [InitializeOnLoad]
    internal static class EditorJobs
    {
        const string SessionKey = "Genex.Bridge.Jobs";
        static readonly Dictionary<string, JObject> Jobs = new Dictionary<string, JObject>();
        static readonly ConcurrentDictionary<string, string> Snapshots = new ConcurrentDictionary<string, string>();
        static readonly TestCallbacks Callbacks = new TestCallbacks();
        static Request packageRequest;
        static string packageJob;
        static readonly TestJobReservation Tests = new TestJobReservation();
        static TestRunnerApi testRunner;

        static EditorJobs()
        {
            var saved = SessionState.GetString(SessionKey, "[]");
            try
            {
                foreach (JObject job in JArray.Parse(saved))
                {
                    var id = job.Value<string>("id");
                    if (job.Value<string>("state") == "queued" ||
                        (job.Value<string>("state") == "running" && job.Value<string>("kind") != "tests"))
                    {
                        job["state"] = "interrupted";
                        job["message"] = "Domain reload interrupted this job. Inspect state; it was not replayed.";
                    }
                    if (job.Value<string>("state") == "running" && job.Value<string>("kind") == "tests")
                    {
                        if (Tests.Owner == null) Tests.Reserve(id);
                        else { job["state"] = "interrupted"; job["message"] = "Another retained test job owns this Editor session; inspect results before retrying."; }
                    }
                    Jobs[id] = job;
                    Snapshots[id] = job.ToString(Formatting.None);
                }
            }
            catch (JsonException) { }
            TestRunnerApi.RegisterTestCallback(Callbacks);
            EditorApplication.update += PollPackages;
            AssemblyReloadEvents.beforeAssemblyReload += Save;
        }

        static void Save() => SessionState.SetString(SessionKey, new JArray(Jobs.Values).ToString(Formatting.None));
        static void Update(JObject job)
        {
            job["updatedAt"] = DateTime.UtcNow.ToString("O");
            Snapshots[job.Value<string>("id")] = job.ToString(Formatting.None);
            Save();
        }
        static JObject New(string kind)
        {
            if (Jobs.Count >= 40)
            {
                var expired = Jobs.FirstOrDefault(item => item.Value.Value<string>("state") != "running" && item.Value.Value<string>("state") != "queued");
                if (expired.Key == null) throw new BridgeException("busy", "Too many active jobs");
                Jobs.Remove(expired.Key);
                Snapshots.TryRemove(expired.Key, out _);
            }
            var id = Guid.NewGuid().ToString("N");
            var job = new JObject { ["id"] = id, ["kind"] = kind, ["state"] = "queued", ["createdAt"] = DateTime.UtcNow.ToString("O"), ["cancelSupported"] = true };
            Jobs[id] = job;
            Update(job);
            return job;
        }
        static JObject Find(JObject p)
        {
            var id = Args.Text(p, "id", max: 64);
            if (!Jobs.TryGetValue(id, out var job)) throw new BridgeException("not_found", "Job is not in this Editor session");
            return job;
        }
        internal static bool Snapshot(JObject p, out JToken result)
        {
            var id = Args.Text(p, "id", max: 64);
            result = null;
            if (!Snapshots.TryGetValue(id, out var json)) return false;
            result = JObject.Parse(json);
            return true;
        }
        internal static JArray Summaries()
        {
            return new JArray(Snapshots.Values.Select(json => {
                var job = JObject.Parse(json);
                return new JObject { ["id"] = job["id"], ["kind"] = job["kind"], ["state"] = job["state"],
                    ["cancelSupported"] = job["cancelSupported"], ["updatedAt"] = job["updatedAt"] };
            }));
        }
        public static JToken Status(JObject p) => Find(p).DeepClone();
        public static JToken Start(JObject p)
        {
            Operations.EditOnly();
            AssertNativeJobAvailable();
            var kind = Args.Text(p, "kind", max: 32);
            if (kind == "tests") return StartTests(p);
            if (kind == "build") return StartBuild(p);
            throw new BridgeException("invalid_argument", "Job kind must be tests or build");
        }
        static void AssertNativeJobAvailable()
        {
            if (Jobs.Values.Any(job => (job.Value<string>("kind") == "tests" || job.Value<string>("kind") == "build") &&
                (job.Value<string>("state") == "queued" || job.Value<string>("state") == "running")))
                throw new BridgeException("busy", "Wait for the active Unity test/build job before starting another native operation");
        }
        public static JToken Cancel(JObject p)
        {
            var job = Find(p);
            var state = job.Value<string>("state");
            if (state == "queued")
            {
                job["state"] = "cancelled";
                Update(job);
                ReleaseTests(job);
                return job.DeepClone();
            }
            if (state != "running") return job.DeepClone();
            if (job.Value<string>("kind") == "tests" && job.Value<bool>("cancelSupported"))
            {
                var accepted = TestRunnerApi.CancelTestRun(job.Value<string>("runGuid"));
                job["cancelRequested"] = accepted;
                Update(job);
                return job.DeepClone();
            }
            throw new BridgeException("not_cancellable", "Unity cannot cancel this running operation safely; it will be observed to completion");
        }
        static JToken StartTests(JObject p)
        {
            Tests.AssertAvailable();
            var mode = Args.Text(p, "mode", "EditMode", 32);
            if (mode != "EditMode" && mode != "PlayMode") throw new BridgeException("invalid_argument", "Test mode must be EditMode or PlayMode");
            var filter = new Filter { testMode = mode == "EditMode" ? TestMode.EditMode : TestMode.PlayMode,
                testNames = Strings(p["testNames"], 100), assemblyNames = Strings(p["assemblyNames"], 100) };
            var job = New("tests");
            // Reserve ownership now: Pump can accept several requests before delayCall executes.
            Tests.Reserve(job.Value<string>("id"));
            job["mode"] = mode;
            job["failures"] = new JArray();
            Update(job);
            EditorApplication.delayCall += () => {
                if (job.Value<string>("state") != "queued") return;
                try
                {
                    Operations.EditOnly();
                    if (Tests.ObservedRunActive) throw new BridgeException("busy", "Another Unity test run started before this queued run");
                    job["state"] = "running";
                    job["cancelSupported"] = mode == "EditMode";
                    Update(job);
                    testRunner = ScriptableObject.CreateInstance<TestRunnerApi>();
                    job["runGuid"] = testRunner.Execute(new ExecutionSettings(filter));
                    Update(job);
                }
                catch (Exception error) { Fail(job, error); ReleaseTests(job); }
            };
            return job.DeepClone();
        }
        static void ReleaseTests(JObject job)
        {
            if (!Tests.Release(job.Value<string>("id"))) return;
            if (testRunner) UnityEngine.Object.DestroyImmediate(testRunner);
            testRunner = null;
        }
        static string[] Strings(JToken token, int limit)
        {
            if (token == null) return null;
            if (!(token is JArray array) || array.Count > limit || array.Any(t => t.Type != JTokenType.String || t.Value<string>().Length > 512))
                throw new BridgeException("invalid_argument", "Expected a bounded array of names");
            return array.Values<string>().ToArray();
        }
        static JToken StartBuild(JObject p)
        {
            Args.Confirm(p);
            AssertSavedScenes();
            var targetName = Args.Text(p, "target", EditorUserBuildSettings.activeBuildTarget.ToString(), 64);
            if (!Enum.TryParse<BuildTarget>(targetName, false, out var target) || target == BuildTarget.NoTarget)
                throw new BridgeException("invalid_argument", "Unknown build target");
            AssertActiveTarget(target);
            var group = BuildPipeline.GetBuildTargetGroup(target);
            if (!BuildPipeline.IsBuildTargetSupported(group, target)) throw new BridgeException("missing_module", "Install this build support module in Unity Hub first");
            var scenes = Strings(p["scenes"], 200) ?? EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
            if (scenes.Length == 0) throw new BridgeException("invalid_argument", "Build needs at least one saved scene");
            foreach (var scene in scenes)
                if (!scene.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) || !File.Exists(ProjectFiles.Resolve(scene)))
                    throw new BridgeException("invalid_path", "Build scenes must be saved Assets scenes");
            var job = New("build");
            var suffix = target == BuildTarget.StandaloneWindows || target == BuildTarget.StandaloneWindows64 ? "/Game.exe" :
                target == BuildTarget.StandaloneOSX ? "/Game.app" : target == BuildTarget.WebGL ? "/WebGL" :
                target == BuildTarget.Android ? (EditorUserBuildSettings.buildAppBundle ? "/Game.aab" : "/Game.apk") : "/Game";
            var relative = "Builds/Genex/" + job.Value<string>("id") + suffix;
            var output = ProjectFiles.Resolve(relative, "Builds");
            var options = new BuildPlayerOptions { scenes = scenes, target = target, locationPathName = output,
                options = Args.Flag(p, "development") ? BuildOptions.Development : BuildOptions.None };
            job["target"] = targetName;
            job["outputPath"] = relative;
            Update(job);
            EditorApplication.delayCall += () => {
                if (job.Value<string>("state") != "queued") return;
                try
                {
                    Operations.EditOnly();
                    AssertActiveTarget(target);
                    AssertSavedScenes();
                    job["state"] = "running"; job["cancelSupported"] = false; Update(job);
                    Directory.CreateDirectory(Path.GetDirectoryName(output));
                    ProjectFiles.AssertNoLinks(output);
                    var report = BuildPipeline.BuildPlayer(options);
                    job["state"] = report.summary.result == BuildResult.Succeeded ? "completed" : report.summary.result == BuildResult.Cancelled ? "cancelled" : "failed";
                    job["result"] = new JObject { ["result"] = report.summary.result.ToString(), ["totalErrors"] = report.summary.totalErrors,
                        ["totalWarnings"] = report.summary.totalWarnings, ["totalBytes"] = report.summary.totalSize,
                        ["durationSeconds"] = report.summary.totalTime.TotalSeconds, ["outputPath"] = relative };
                    Update(job);
                }
                catch (Exception error) { Fail(job, error); }
            };
            return job.DeepClone();
        }
        static void AssertSavedScenes()
        {
            for (var index = 0; index < SceneManager.sceneCount; index++)
                if (SceneManager.GetSceneAt(index).isDirty)
                    throw new BridgeException("unsaved_scene", "Save dirty loaded scenes before building; the bridge never silently saves them");
        }
        static void AssertActiveTarget(BuildTarget target)
        {
            if (target != EditorUserBuildSettings.activeBuildTarget)
                throw new BridgeException("target_not_active", "Select this target in Unity Build Profiles and wait for compilation/import before building; platform symbols must match the active target");
        }
        static void Fail(JObject job, Exception error)
        {
            job["state"] = "failed";
            job["error"] = new JObject { ["code"] = (error as BridgeException)?.Code ?? "editor_error", ["message"] = error.Message };
            Update(job);
        }

        static JToken StartPackage(JObject p, string kind, Func<Request> start)
        {
            if (packageRequest != null) throw new BridgeException("busy", "A package request is already active");
            var job = New(kind);
            job["state"] = "running"; job["cancelSupported"] = false;
            packageJob = job.Value<string>("id");
            try { packageRequest = start(); Update(job); }
            catch (Exception error) { packageJob = null; Fail(job, error); }
            return job.DeepClone();
        }
        public static JToken PackageList(JObject p) => StartPackage(p, "package-list", () => Client.List(true, Args.Flag(p, "includeIndirect", true)));
        static string PackageName(JObject p, bool versioned)
        {
            var name = Args.Text(p, "name", max: 256);
            var pattern = versioned ? @"^[a-z0-9]+(?:[.-][a-z0-9]+)+(?:@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)?$" : @"^[a-z0-9]+(?:[.-][a-z0-9]+)+$";
            if (!Regex.IsMatch(name, pattern)) throw new BridgeException("invalid_argument", "Only registry package identifiers are supported; no file or Git URLs");
            if (name.Split('@')[0] == "com.genex.unity-bridge") throw new BridgeException("protected_package", "The bridge cannot replace or remove itself");
            return name;
        }
        public static JToken PackageAdd(JObject p)
        {
            Operations.EditOnly(); Args.Confirm(p); AssertNativeJobAvailable(); var name = PackageName(p, true);
            return StartPackage(p, "package-add", () => Client.Add(name));
        }
        public static JToken PackageRemove(JObject p)
        {
            Operations.EditOnly(); Args.Confirm(p); AssertNativeJobAvailable(); var name = PackageName(p, false);
            if (name == "com.unity.test-framework" || name == "com.unity.nuget.newtonsoft-json")
                throw new BridgeException("protected_package", "This package is required by the bridge");
            return StartPackage(p, "package-remove", () => Client.Remove(name));
        }
        static void PollPackages()
        {
            if (packageRequest == null || !packageRequest.IsCompleted) return;
            var job = Jobs[packageJob];
            if (packageRequest.Status == StatusCode.Failure) Fail(job, new BridgeException("package_error", packageRequest.Error.message));
            else
            {
                job["state"] = "completed";
                if (packageRequest is ListRequest list)
                    job["result"] = new JObject { ["packages"] = new JArray(list.Result.Select(info => new JObject {
                        ["name"] = info.name, ["version"] = info.version, ["source"] = info.source.ToString(), ["direct"] = info.isDirectDependency })) };
                else if (packageRequest is AddRequest add) job["result"] = new JObject { ["name"] = add.Result.name, ["version"] = add.Result.version };
                else job["result"] = new JObject { ["removed"] = true };
                Update(job);
            }
            packageRequest = null; packageJob = null;
        }

        sealed class TestCallbacks : IErrorCallbacks
        {
            public void RunStarted(ITestAdaptor tests) { Tests.ObservedRunActive = true; }
            public void TestStarted(ITestAdaptor test) { }
            public void TestFinished(ITestResultAdaptor result)
            {
                if (Tests.Owner == null || !Jobs.TryGetValue(Tests.Owner, out var job) || job.Value<string>("state") != "running" || result.TestStatus != TestStatus.Failed) return;
                var failures = (JArray)job["failures"];
                if (failures.Count < 50) failures.Add(new JObject { ["name"] = result.Test.FullName, ["message"] = result.Message?.Substring(0, Math.Min(result.Message.Length, 4000)) });
                Update(job);
            }
            public void RunFinished(ITestResultAdaptor result)
            {
                Tests.ObservedRunActive = false;
                if (Tests.Owner == null || !Jobs.TryGetValue(Tests.Owner, out var job) || job.Value<string>("state") != "running") return;
                job["state"] = job.Value<bool?>("cancelRequested") == true ? "cancelled" : result.FailCount > 0 ? "failed" : "completed";
                job["result"] = new JObject { ["passed"] = result.PassCount, ["failed"] = result.FailCount,
                    ["skipped"] = result.SkipCount, ["inconclusive"] = result.InconclusiveCount, ["durationSeconds"] = result.Duration };
                Update(job); ReleaseTests(job);
            }
            public void OnError(string message)
            {
                Tests.ObservedRunActive = false;
                if (Tests.Owner == null || !Jobs.TryGetValue(Tests.Owner, out var job) || job.Value<string>("state") != "running") return;
                Fail(job, new BridgeException("test_error", message?.Substring(0, Math.Min(message.Length, 4000)) ?? "Unity test run failed to start"));
                ReleaseTests(job);
            }
        }
    }
}
