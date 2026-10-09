using System;
using System.IO;
using Genex.Unity;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Genex.Unity.Tests
{
    public sealed class BridgeTests
    {
        [TestCase("../outside.cs")]
        [TestCase("Assets/../../outside.cs")]
        [TestCase("Assets/.secret.cs")]
        [TestCase("Assets/folder/../outside.cs")]
        [TestCase("C:/outside.cs")]
        [TestCase("Assets/file.cs:stream")]
        [TestCase("Assets/CON.cs")]
        public void ProjectPathsRejectEscapes(string input)
        {
            Assert.Throws<BridgeException>(() => ProjectFiles.ResolveAt(Path.GetTempPath(), input));
        }

        [Test]
        public void ScriptOverwriteNeedsCurrentHash()
        {
            var root = Path.Combine(Path.GetTempPath(), "GenexBridgeTests-" + Guid.NewGuid().ToString("N"));
            var relative = "Assets/fixture.txt";
            var path = ProjectFiles.ResolveAt(root, relative);
            try
            {
                ProjectFiles.WriteAt(root, relative, "before", null);
                Assert.Throws<BridgeException>(() => ProjectFiles.WriteAt(root, relative, "after", null));
                Assert.Throws<BridgeException>(() => ProjectFiles.WriteAt(root, relative, "after", new string('0', 64)));
                Assert.AreEqual("before", File.ReadAllText(path));
                ProjectFiles.WriteAt(root, relative, "after", ProjectFiles.Hash(path));
                Assert.AreEqual("after", File.ReadAllText(path));
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        }

        [Test]
        public void TestJobsReserveBeforeDeferredStartAndOnlyTheirOwnerCanRelease()
        {
            var gate = new TestJobReservation();
            gate.Reserve("queued-first");
            var error = Assert.Throws<BridgeException>(() => gate.Reserve("queued-second"));
            Assert.AreEqual("busy", error.Code);
            Assert.AreEqual("queued-first", gate.Owner);
            Assert.IsFalse(gate.Release("unrelated-job"));
            Assert.Throws<BridgeException>(() => gate.AssertAvailable());
            Assert.IsTrue(gate.Release("queued-first"));
            gate.Reserve("after-cancellation");
            Assert.AreEqual("after-cancellation", gate.Owner);
            Assert.IsTrue(gate.Release("after-cancellation"));
            gate.ObservedRunActive = true;
            Assert.Throws<BridgeException>(() => gate.Reserve("foreign-run-active"));
            Assert.IsNull(gate.Owner);
        }

        [Test]
        public void ObjectToolsRoundTripAndUndo()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
            var name = "GenexBridgeTest-" + Guid.NewGuid().ToString("N");
            try
            {
                var made = (JObject)Operations.Dispatch("object.create", new JObject {
                    ["name"] = name, ["primitive"] = "Cube", ["scene"] = SceneHandleString(scene),
                    ["position"] = new JArray(1, 2, 3)
                });
                var id = made.Value<string>("id");
                var obj = (JObject)Operations.Dispatch("object.inspect", new JObject { ["id"] = id });
                Assert.AreEqual(name, obj.Value<string>("name"));
                CollectionAssert.AreEqual(new [] { 1f, 2f, 3f }, obj["position"].ToObject<float[]>());
                Operations.Dispatch("object.update", new JObject { ["id"] = id, ["name"] = name + "-changed" });
                Undo.FlushUndoRecordObjects();
                Undo.PerformUndo();
                Assert.AreEqual(name, ((JObject)Operations.Dispatch("object.inspect", new JObject { ["id"] = id })).Value<string>("name"));
                Assert.Throws<BridgeException>(() => Operations.Dispatch("object.delete", new JObject { ["id"] = id }));
                Assert.IsNotNull(GameObject.Find(name));
                Operations.Dispatch("object.delete", new JObject { ["id"] = id, ["confirmed"] = true });
                Assert.IsNull(GameObject.Find(name));
            }
            finally { EditorSceneManager.CloseScene(scene, true); }
        }

        [Test]
        public void DispatchRejectsUnknownOperation()
        {
            Assert.Throws<BridgeException>(() => Operations.Dispatch("execute.csharp", new JObject()));
        }
        static string SceneHandleString(UnityEngine.SceneManagement.Scene scene)
        {
#if UNITY_6000_5_OR_NEWER
            return scene.handle.GetRawData().ToString();
#else
            return scene.handle.ToString();
#endif
        }
    }
}
