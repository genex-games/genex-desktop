// The editor's side of the world exporter: a window from the Genex menu and a batch entry. Both walk the open scenes, ask
// WorldSceneExport.cs for the text and write the file only when nothing was refused, so a refused level leaves no new file.
//
//   Unity -batchmode -nographics -quit -projectPath . -logFile - \
//     -executeMethod Genex.Multiplayer.WorldExport.GenexWorldExporter.RunBatch -genexScene Assets/Scenes/Level.unity -genexOut level.scene.json
//
// Then: `genex world fit level.scene.json level.world.json` (sdks/unity/README.md, "From a level to a world").
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Genex.Multiplayer.WorldExport
{
    /// <summary>What an export is asked for: units, layers and the room's hull.</summary>
    public sealed class WorldExportRequest
    {
        public string OutputPath;
        public WorldExportOptions Options = new WorldExportOptions();
        public WorldWalkOptions Walk = new WorldWalkOptions();
    }

    /// <summary>The window's and the batch's shared path, and the batch entry.</summary>
    public static class GenexWorldExporter
    {
        /// <summary>The line a batch run prints when it wrote a file: one JSON object, the report.</summary>
        public const string OkLine = "GENEX_WORLD_EXPORT";
        /// <summary>The line it prints per refusal, then it exits 2 and writes nothing.</summary>
        public const string RefusedLine = "GENEX_WORLD_EXPORT_REFUSED";
        private const int ExitOk = 0;
        private const int ExitRefused = 2;
        private const int ExitUsage = 3;
        private const string ToolName = "com.genex.multiplayer";

        /// <summary>The command a creator runs next.</summary>
        public static string NextStep(string outputPath)
        {
            var world = outputPath.EndsWith(".scene.json", StringComparison.Ordinal) ? outputPath.Substring(0, outputPath.Length - ".scene.json".Length) + ".world.json" : outputPath + ".world.json";
            return "genex world fit " + outputPath + " " + world;
        }

        /// <summary>The loaded scenes, in hierarchy-window order.</summary>
        public static List<Scene> LoadedScenes()
        {
            var scenes = new List<Scene>();
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (scene.isLoaded) scenes.Add(scene);
            }
            return scenes;
        }

        /// <summary>Walks the scenes and writes the file. Throws <see cref="WorldExportRefused"/>, having written nothing.</summary>
        public static WorldExportResult Export(IReadOnlyList<Scene> scenes, WorldExportRequest request)
        {
            var walk = GenexWorldSceneWalk.Read(scenes, request.Walk);
            if (request.Options.Source.Count == 0) request.Options.Source = SourceOf(scenes);
            var result = GenexWorldSceneExport.Export(walk.Colliders, walk.Spawns, request.Options);
            result.Report.Warnings.AddRange(walk.Warnings);
            WriteAtomically(request.OutputPath, result.Text);
            return result;
        }

        private static List<KeyValuePair<string, string>> SourceOf(IReadOnlyList<Scene> scenes) => new List<KeyValuePair<string, string>>
        {
            new KeyValuePair<string, string>("engine", "unity"),
            new KeyValuePair<string, string>("level", string.Join("+", scenes.Select(s => s.name))),
            new KeyValuePair<string, string>("tool", ToolName),
            new KeyValuePair<string, string>("unity", Application.unityVersion),
        };

        private static void WriteAtomically(string path, string text)
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(path));
            Directory.CreateDirectory(directory);
            var temporary = path + ".writing";
            File.WriteAllText(temporary, text, new UTF8Encoding(false));
            if (File.Exists(path)) File.Delete(path);
            File.Move(temporary, path);
        }

        /// <summary>One line of JSON: the counts, what was left out, what moves and every warning. A person's summary is the same data.</summary>
        public static string ReportLine(WorldExportResult result, string outputPath)
        {
            var r = result.Report;
            var report = new Dictionary<string, object>
            {
                ["file"] = outputPath,
                ["next"] = NextStep(outputPath),
                ["actors"] = (double)r.Actors,
                ["surfaces"] = (double)r.Surfaces,
                ["staticSurfaces"] = (double)r.StaticSurfaces,
                ["disabled"] = r.Disabled.Cast<object>().ToList(),
                ["triggers"] = r.Triggers.Cast<object>().ToList(),
                ["noChannel"] = r.NoChannel.Cast<object>().ToList(),
                ["moving"] = r.Moving.Select(m => (object)(m.Key + ": " + m.Value)).ToList(),
                ["warnings"] = r.Warnings.Select(w => (object)(w.Code + " " + w.Actor + ": " + w.Message)).ToList(),
            };
            return GenexJson.Serialize(report);
        }

        // ---------------- batch ----------------

        /// <summary>-executeMethod entry. Exit 0 wrote the file, 2 refused and wrote nothing, 3 was asked wrongly.</summary>
        public static void RunBatch()
        {
            var args = Environment.GetCommandLineArgs();
            try
            {
                var request = RequestFromArgs(args);
                var sceneArg = Arg(args, "-genexScene");
                if (sceneArg != null) EditorSceneManager.OpenScene(sceneArg, OpenSceneMode.Single);
                var result = Export(LoadedScenes(), request);
                Debug.Log(OkLine + " " + ReportLine(result, request.OutputPath));
                Debug.Log("Next: " + NextStep(request.OutputPath));
                EditorApplication.Exit(ExitOk);
            }
            catch (WorldExportRefused refused)
            {
                foreach (var r in refused.Refusals) Debug.LogError(RefusedLine + " " + r);
                EditorApplication.Exit(ExitRefused);
            }
            catch (ArgumentException usage)
            {
                Debug.LogError(RefusedLine + " usage: " + usage.Message);
                EditorApplication.Exit(ExitUsage);
            }
        }

        private static string Arg(string[] args, string name)
        {
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        /// <summary>The batch's flags. Everything but -genexOut has a default.</summary>
        public static WorldExportRequest RequestFromArgs(string[] args)
        {
            var output = Arg(args, "-genexOut") ?? throw new ArgumentException("-genexOut <file> is required");
            var request = new WorldExportRequest { OutputPath = output };
            var units = Arg(args, "-genexUnitsPerMeter");
            if (units != null) request.Options.UnitsPerMeter = double.Parse(units, CultureInfo.InvariantCulture);
            var hull = Arg(args, "-genexHull");
            if (hull != null) request.Options.Hull = ParseHull(hull);
            var character = Arg(args, "-genexCharacterLayer");
            if (character != null) request.Walk.CharacterLayer = LayerNamed(character);
            var shot = Arg(args, "-genexShotLayers");
            if (shot != null) request.Walk.ShotMask = shot.Split(',').Aggregate(0, (mask, name) => mask | (1 << LayerNamed(name)));
            var channels = Arg(args, "-genexLayerChannels");
            if (channels != null) ParseLayerChannels(channels, request.Walk);
            return request;
        }

        private static double[] ParseHull(string text)
        {
            var values = text.Split(',').Select(v => double.Parse(v, CultureInfo.InvariantCulture)).ToArray();
            if (values.Length != 6) throw new ArgumentException("-genexHull is radius,height,crouchHeight,step,jump,leap");
            return values;
        }

        private static int LayerNamed(string name)
        {
            var layer = LayerMask.NameToLayer(name);
            if (layer < 0) throw new ArgumentException("no layer is called " + name);
            return layer;
        }

        /// <summary>`Clip:move,BulletStop:shot,Ghost:none,Wall:both`.</summary>
        private static void ParseLayerChannels(string text, WorldWalkOptions walk)
        {
            foreach (var entry in text.Split(','))
            {
                var parts = entry.Split(':');
                if (parts.Length != 2) throw new ArgumentException("-genexLayerChannels takes Layer:move|shot|both|none, comma separated");
                var channels = parts[1] == "move" ? (true, false) : parts[1] == "shot" ? (false, true) : parts[1] == "both" ? (true, true) : parts[1] == "none" ? (false, false)
                    : throw new ArgumentException(parts[1] + " is not move, shot, both or none");
                walk.LayerChannels[LayerNamed(parts[0])] = channels;
            }
        }
    }

    /// <summary>Genex > Export World Scene: the same export with its settings on show.</summary>
    public sealed class GenexWorldExportWindow : EditorWindow
    {
        private const string MenuPath = "Genex/Export World Scene...";
        private const string PrefPrefix = "Genex.WorldExport.";
        private double units = 39.37;
        private int characterLayer;
        private int shotMask = Physics.DefaultRaycastLayers;
        private string message = "";

        [MenuItem(MenuPath)]
        private static void Open() => GetWindow<GenexWorldExportWindow>(true, "Export World Scene", true);

        private void OnEnable()
        {
            units = double.Parse(EditorPrefs.GetString(PrefPrefix + "units", "39.37"), CultureInfo.InvariantCulture);
            characterLayer = EditorPrefs.GetInt(PrefPrefix + "character", 0);
            shotMask = EditorPrefs.GetInt(PrefPrefix + "shot", Physics.DefaultRaycastLayers);
        }

        private void OnGUI()
        {
            units = EditorGUILayout.DoubleField(new GUIContent("Units a metre", "39.37 is what a firstperson room is built for."), units);
            characterLayer = EditorGUILayout.LayerField(new GUIContent("Character layer", "The layer collision matrix against this layer decides what stops a hull."), characterLayer);
            shotMask = EditorGUILayout.MaskField(new GUIContent("Layers bullets hit"), shotMask, Enumerable.Range(0, 32).Select(LayerMask.LayerToName).ToArray());
            if (GUILayout.Button("Export")) ExportNow();
            if (message.Length > 0) EditorGUILayout.HelpBox(message, MessageType.Info);
        }

        private void ExportNow()
        {
            var scenes = GenexWorldExporter.LoadedScenes();
            var path = EditorUtility.SaveFilePanel("World scene", "", scenes.Count > 0 ? scenes[0].name + ".scene.json" : "level.scene.json", "json");
            if (string.IsNullOrEmpty(path)) return;
            EditorPrefs.SetString(PrefPrefix + "units", units.ToString(CultureInfo.InvariantCulture));
            EditorPrefs.SetInt(PrefPrefix + "character", characterLayer);
            EditorPrefs.SetInt(PrefPrefix + "shot", shotMask);
            var request = new WorldExportRequest { OutputPath = path };
            request.Options.UnitsPerMeter = units;
            request.Walk.CharacterLayer = characterLayer;
            request.Walk.ShotMask = shotMask;
            try
            {
                var result = GenexWorldExporter.Export(scenes, request);
                var r = result.Report;
                foreach (var w in r.Warnings) Debug.LogWarning(w.Code + " " + w.Actor + ": " + w.Message);
                Debug.Log(GenexWorldExporter.OkLine + " " + GenexWorldExporter.ReportLine(result, path));
                message = r.Actors + " actors, " + r.StaticSurfaces + " static surfaces. Left out: " + r.Disabled.Count + " disabled, " + r.Triggers.Count + " triggers. Moving, not baked: "
                    + (r.Moving.Count == 0 ? "none" : string.Join(", ", r.Moving.Select(m => m.Key))) + ". " + r.Warnings.Count + " warnings in the Console.\nNext: " + GenexWorldExporter.NextStep(path);
            }
            catch (WorldExportRefused refused)
            {
                foreach (var r in refused.Refusals) Debug.LogError(GenexWorldExporter.RefusedLine + " " + r);
                message = "Nothing was written.\n" + string.Join("\n", refused.Refusals.Select(r => r.ToString()));
            }
        }
    }
}
