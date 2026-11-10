// Unity's level as a world scene (packages/multiplayer/WORLD-SCENE.md): what `genex world fit` reads. This half knows no
// UnityEngine: GenexWorldSceneWalk.cs reads the open scene into rows, this turns rows into the file or refuses them by name,
// and GenexSmoke holds it to packages/netcode-bench/conformance/authority/world-scene/unity-export.json on any machine, no
// Unity licence needed.
//
// Unity is y up and left-handed in metres; a room is z up and right-handed in its own units. A Unity point (x, y, z) is the
// room's (x, z, y) times the units a metre, the swap README.md's Axes section gives for everything else a game sends.
//
// Numbers are written from whole counts of a thousandth of a unit, through integer arithmetic only, so no runtime's float
// printer is involved (Mono's and .NET's differ) and a last-bit difference in a parent's matrix never reaches the file.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Genex.Multiplayer.WorldExport
{
    /// <summary>Why a level was not written. Each row names its actor, so a creator can find it.</summary>
    public static class WorldRefusalCode
    {
        public const string NotFinite = "not_finite";
        public const string ZeroScale = "zero_scale";
        public const string HugeScale = "huge_scale";
        public const string NonReadableMesh = "non_readable_mesh";
        public const string EmptyScene = "empty_scene";
        public const string NoSpawn = "no_spawn";
        public const string BadUnits = "bad_units";
    }

    /// <summary>What the file was written despite. A warning never stops an export.</summary>
    public static class WorldWarningCode
    {
        public const string MayMove = "may_move";
        public const string EmptyMesh = "empty_mesh";
        public const string NoSize = "no_size";
        public const string MovingNotWritten = "moving_not_written";
        public const string UnitsTooSmall = "units_too_small";
        public const string HullTooBig = "hull_too_big";
        public const string NotRead = "not_read";
    }

    /// <summary>A collider's shape, as the walk read it.</summary>
    public static class WorldColliderKind
    {
        public const string Box = "box";
        public const string Sphere = "sphere";
        public const string Capsule = "capsule";
        public const string Mesh = "mesh";
        public const string Terrain = "terrain";
    }

    /// <summary>A point or a vector in Unity's space.</summary>
    public readonly struct WorldV3
    {
        public readonly double X, Y, Z;
        public WorldV3(double x, double y, double z) { X = x; Y = y; Z = z; }
        public static WorldV3 operator +(WorldV3 a, WorldV3 b) => new WorldV3(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static WorldV3 operator *(WorldV3 a, double k) => new WorldV3(a.X * k, a.Y * k, a.Z * k);
        public bool IsFinite => double.IsFinite(X) && double.IsFinite(Y) && double.IsFinite(Z);
    }

    /// <summary>A rotation in Unity's space, as its transform holds it.</summary>
    public readonly struct WorldQ
    {
        public readonly double X, Y, Z, W;
        public WorldQ(double x, double y, double z, double w) { X = x; Y = y; Z = z; W = w; }
        public static readonly WorldQ Identity = new WorldQ(0, 0, 0, 1);
        public bool IsFinite => double.IsFinite(X) && double.IsFinite(Y) && double.IsFinite(Z) && double.IsFinite(W);
        public double Length => Math.Sqrt(X * X + Y * Y + Z * Z + W * W);

        /// <summary>v + 2w(q × v) + 2q × (q × v), which a left-handed space's rotation obeys as a right-handed one's does.</summary>
        public WorldV3 Rotate(WorldV3 v)
        {
            var cx = Y * v.Z - Z * v.Y;
            var cy = Z * v.X - X * v.Z;
            var cz = X * v.Y - Y * v.X;
            return new WorldV3(
                v.X + 2 * (W * cx + Y * cz - Z * cy),
                v.Y + 2 * (W * cy + Z * cx - X * cz),
                v.Z + 2 * (W * cz + X * cy - Y * cx));
        }
    }

    /// <summary>One collider, read from the open scene and not yet judged. Everything is in Unity's space and metres.</summary>
    public sealed class WorldCollider
    {
        /// <summary>The name a refusal gives: the game object's path in the hierarchy.</summary>
        public string Actor = "";
        /// <summary>Which game object: two colliders with the same object are one actor, two objects with one name are not.</summary>
        public long Object;
        public string Kind = WorldColliderKind.Box;
        public bool Enabled = true;
        public bool Active = true;
        public bool Trigger;
        /// <summary>What makes it move (a Rigidbody, an Animator, the creator's mark). Null when nothing does.</summary>
        public string MovingBecause;
        /// <summary>Why it might move though nothing says it does: baked as static, with a warning.</summary>
        public string MayMoveBecause;
        public bool Prop;
        public string[] Tags = Array.Empty<string>();
        /// <summary>Stops a hull: the layer collides with the character's.</summary>
        public bool Move = true;
        /// <summary>Stops a bullet: the layer is in the shot mask.</summary>
        public bool Shot = true;

        // The object's pose, as PhysX reads it: its world position and rotation, and its lossy scale.
        public WorldV3 Position;
        public WorldQ Rotation = WorldQ.Identity;
        public WorldV3 Scale = new WorldV3(1, 1, 1);

        // Box, sphere, capsule.
        public WorldV3 Center;
        public WorldV3 Size;
        public double Radius;
        public double Height;
        /// <summary>A capsule's axis: 0 x, 1 y, 2 z.</summary>
        public int Direction = 1;

        // Mesh: local vertices and the object's whole local-to-world matrix, sixteen values row by row.
        public string MeshName = "";
        public bool Convex;
        public bool Readable = true;
        public double[] Matrix;
        public float[] Vertices = Array.Empty<float>();
        public int[] Indices = Array.Empty<int>();

        // Terrain: heights in metres above Position, row by row, Unity z the rows and x the columns. Unity turns and scales
        // no terrain, so only its position counts. HoleCells has (Cols - 1) x (Rows - 1) cells, true for a hole.
        public int Cols;
        public int Rows;
        public double CellX;
        public double CellZ;
        public float[] Heights = Array.Empty<float>();
        public bool[] HoleCells;
    }

    /// <summary>Where a hull's reach starts: an object's position, the feet.</summary>
    public sealed class WorldSpawnPoint
    {
        public string Name;
        public string[] Tags = Array.Empty<string>();
        public WorldV3 At;
    }

    /// <summary>What the exporter is told. Everything has a default that works for a `firstperson` room in Source units.</summary>
    public sealed class WorldExportOptions
    {
        /// <summary>Room units a metre. 39.37 is what `firstperson` is built for (PROTOCOL.md §17.7).</summary>
        public double UnitsPerMeter = 39.37;
        /// <summary>The scene's `source`, in order.</summary>
        public List<KeyValuePair<string, string>> Source = new List<KeyValuePair<string, string>>();
        /// <summary>radius, height, crouchHeight, step, jump, leap in room units. Null leaves it out: the Source defaults, scaled.</summary>
        public double[] Hull;
    }

    public sealed class WorldRefusal
    {
        public readonly string Code, Actor, Message;
        public WorldRefusal(string code, string actor, string message) { Code = code; Actor = actor; Message = message; }
        public override string ToString() => Actor.Length == 0 ? Code + ": " + Message : Code + " " + Actor + ": " + Message;
    }

    public sealed class WorldWarning
    {
        public readonly string Code, Actor, Message;
        public WorldWarning(string code, string actor, string message) { Code = code; Actor = actor; Message = message; }
    }

    /// <summary>A level the exporter would not write, with every reason at once so a creator fixes them together.</summary>
    public sealed class WorldExportRefused : Exception
    {
        public readonly IReadOnlyList<WorldRefusal> Refusals;
        public WorldExportRefused(IReadOnlyList<WorldRefusal> refusals)
            : base("world scene refused: " + string.Join("; ", refusals.Select(r => r.ToString()))) { Refusals = refusals; }
    }

    /// <summary>What the export read, honestly: what went in, what was left out and why, and what moves.</summary>
    public sealed class WorldExportReport
    {
        public int Actors;
        public int Surfaces;
        public int StaticSurfaces;
        public readonly List<string> Disabled = new List<string>();
        public readonly List<string> Triggers = new List<string>();
        public readonly List<string> NoChannel = new List<string>();
        public readonly List<KeyValuePair<string, string>> Moving = new List<KeyValuePair<string, string>>();
        public readonly List<WorldWarning> Warnings = new List<WorldWarning>();
    }

    public sealed class WorldExportResult
    {
        /// <summary>The scene file's whole text, UTF-8.</summary>
        public string Text;
        public WorldExportReport Report;
    }

    /// <summary>Rows in, a world scene or a named refusal out. It writes no file: the caller does, only on success.</summary>
    public static class GenexWorldSceneExport
    {
        /// <summary>Past 2^24 a float32 no longer holds whole units, far under the format's limit and already no level.</summary>
        public const double MaxUnits = 16777216;
        /// <summary>The scene format's own limit on a name.</summary>
        public const int MaxNameChars = 256;
        /// <summary>The scene format's limit on a hull's points: a convex mesh past it is written as triangles instead.</summary>
        public const int MaxHullPoints = 4096;
        /// <summary>Past this many numbers an array is written as base64 binary.</summary>
        public const int MaxTextArray = 64;
        /// <summary>Below this a slow walk never steps up: firstperson's `stepped > flat + 0.001` compares squared world units.</summary>
        public const double MinUnitsPerMeter = 10;
        /// <summary>Whole counts of this are what a coordinate is written in: a thousandth of a unit.</summary>
        private const long UnitDigits = 1000;
        /// <summary>A box axis's digits: at 10,000 units of half extent, a thousandth of a unit of error.</summary>
        private const long AxisDigits = 10000000;
        /// <summary>A rotated box this close to the axes is on them, so it stays exact in the fit.</summary>
        private const double OnAxisTolerance = 1e-6;
        /// <summary>A scale this near zero is no size along that axis, not a very small object.</summary>
        private const double MinScale = 1e-9;
        /// <summary>A quaternion shorter than this holds no rotation.</summary>
        private const double MinQuaternionLength = 1e-6;
        private const string Format = "genex-world-scene";
        private const int Version = 1;

        private sealed class ActorOut
        {
            public string Name;
            public readonly List<string> Tags = new List<string>();
            public readonly List<string> Surfaces = new List<string>();
        }

        /// <summary>Turns the rows into the scene's text. Throws <see cref="WorldExportRefused"/> with every reason.</summary>
        public static WorldExportResult Export(IReadOnlyList<WorldCollider> colliders, IReadOnlyList<WorldSpawnPoint> spawns, WorldExportOptions options)
        {
            var refusals = new List<WorldRefusal>();
            var u = options.UnitsPerMeter;
            if (!double.IsFinite(u) || u <= 0)
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.BadUnits, "", "units a metre must be a number above zero, got " + u.ToString(CultureInfo.InvariantCulture)));
                throw new WorldExportRefused(refusals);
            }
            var report = new WorldExportReport();
            if (u < MinUnitsPerMeter)
            {
                report.Warnings.Add(new WorldWarning(WorldWarningCode.UnitsTooSmall, "",
                    "at " + u.ToString(CultureInfo.InvariantCulture) + " units a metre a firstperson room cannot step up at a slow walk: its step compares squared units. Use 39.37 and divide when drawing"));
            }
            var actors = new List<ActorOut>();
            var byObject = new Dictionary<string, ActorOut>();
            var names = new Dictionary<string, int>();
            foreach (var c in colliders) AddCollider(c, u, actors, byObject, names, report, refusals);
            var spawnTexts = new List<string>();
            foreach (var s in spawns)
            {
                var name = s.Name ?? "";
                if (!s.At.IsFinite) { refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, name, "the spawn's position is not a finite number")); continue; }
                var error = CheckUnits(Mapped(s.At, u));
                if (error != null) { refusals.Add(new WorldRefusal(WorldRefusalCode.HugeScale, name, "the spawn " + error)); continue; }
                spawnTexts.Add(SpawnText(s, u));
            }
            if (refusals.Count == 0 && report.StaticSurfaces == 0) refusals.Add(new WorldRefusal(WorldRefusalCode.EmptyScene, "", EmptyMessage(report)));
            if (spawns.Count == 0)
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.NoSpawn, "",
                    "a fit starts from where a player starts: add a GenexWorldSpawn to a game object, or tag one Respawn"));
            }
            if (refusals.Count > 0) throw new WorldExportRefused(refusals);
            report.Actors = actors.Count;
            report.Surfaces = actors.Sum(a => a.Surfaces.Count);
            return new WorldExportResult { Text = SceneText(actors, spawnTexts, options), Report = report };
        }

        private static string EmptyMessage(WorldExportReport report) =>
            "no static collider a hull can stand on: " + report.Disabled.Count + " disabled, " + report.Triggers.Count + " triggers, "
            + report.Moving.Count + " moving, " + report.NoChannel.Count + " on layers that stop nothing"
            + (report.Moving.Count > 0 ? " (moving: " + string.Join(", ", report.Moving.Take(5).Select(m => m.Key)) + ")" : "");

        private static void AddCollider(WorldCollider c, double u, List<ActorOut> actors, Dictionary<string, ActorOut> byObject, Dictionary<string, int> names, WorldExportReport report, List<WorldRefusal> refusals)
        {
            if (!c.Enabled || !c.Active) { report.Disabled.Add(c.Actor); return; }
            if (c.Trigger) { report.Triggers.Add(c.Actor); return; }
            if (!c.Move && !c.Shot) { report.NoChannel.Add(c.Actor); return; }
            var moving = c.MovingBecause != null;
            var mine = new List<WorldRefusal>();
            var surface = SurfaceText(c, u, report, mine);
            if (moving && mine.Count > 0)
            {
                // Never part of the world, so nothing about its shape can stop the level. It stays named.
                report.Warnings.Add(new WorldWarning(WorldWarningCode.MovingNotWritten, c.Actor, "moves, and its shape could not be read: " + mine[0].Message));
                surface = null;
                mine.Clear();
            }
            refusals.AddRange(mine);
            if (mine.Count > 0 || (surface == null && !moving)) return;
            var actor = ActorOf(c, actors, byObject, names);
            if (moving)
            {
                if (!actor.Tags.Contains("movable")) { actor.Tags.Add("movable"); report.Moving.Add(new KeyValuePair<string, string>(actor.Name, c.MovingBecause)); }
            }
            else if (c.MayMoveBecause != null)
            {
                report.Warnings.Add(new WorldWarning(WorldWarningCode.MayMove, c.Actor,
                    "is baked as static, but " + c.MayMoveBecause + " could move it: add GenexWorldActor and tick Movable if it does"));
            }
            if (surface == null) return;
            actor.Surfaces.Add(surface);
            if (!moving && c.Move) report.StaticSurfaces++;
        }

        private static ActorOut ActorOf(WorldCollider c, List<ActorOut> actors, Dictionary<string, ActorOut> byObject, Dictionary<string, int> names)
        {
            var key = c.Object != 0 ? "#" + c.Object.ToString(CultureInfo.InvariantCulture) : c.Actor;
            if (byObject.TryGetValue(key, out var actor)) return actor;
            actor = new ActorOut { Name = UniqueName(c.Actor, names) };
            foreach (var tag in c.Tags) if (tag.Length > 0 && !actor.Tags.Contains(tag)) actor.Tags.Add(tag);
            if (c.Prop && !actor.Tags.Contains("prop")) actor.Tags.Add("prop");
            byObject[key] = actor;
            actors.Add(actor);
            return actor;
        }

        private static string UniqueName(string name, Dictionary<string, int> names)
        {
            names.TryGetValue(name, out var seen);
            names[name] = seen + 1;
            var unique = seen == 0 ? name : name + "#" + (seen + 1).ToString(CultureInfo.InvariantCulture);
            return Named(unique);
        }

        /// <summary>A path past the format's limit keeps its tail, the part a creator recognises.</summary>
        private static string Named(string name) =>
            name.Length <= MaxNameChars ? (name.Length == 0 ? "(unnamed)" : name) : "..." + name.Substring(name.Length - (MaxNameChars - 3));

        private static string SurfaceText(WorldCollider c, double u, WorldExportReport report, List<WorldRefusal> refusals)
        {
            switch (c.Kind)
            {
                case WorldColliderKind.Box: return BoxText(c, u, refusals);
                case WorldColliderKind.Sphere: return SphereText(c, u, report, refusals);
                case WorldColliderKind.Capsule: return CapsuleText(c, u, report, refusals);
                case WorldColliderKind.Mesh: return MeshText(c, u, report, refusals);
                case WorldColliderKind.Terrain: return TerrainText(c, u, refusals);
                default: throw new ArgumentException("unknown collider kind " + c.Kind);
            }
        }

        // ---------------- the pose every primitive shares ----------------

        /// <summary>Refuses what no shape can be read from; true when the pose is usable.</summary>
        private static bool PoseIsUsable(WorldCollider c, List<WorldRefusal> refusals)
        {
            if (!c.Position.IsFinite || !c.Rotation.IsFinite || !c.Scale.IsFinite)
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, c.Actor, "its transform holds a value that is not a finite number"));
                return false;
            }
            if (c.Rotation.Length < MinQuaternionLength)
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, c.Actor, "its rotation is the zero quaternion"));
                return false;
            }
            if (Math.Abs(c.Scale.X) < MinScale || Math.Abs(c.Scale.Y) < MinScale || Math.Abs(c.Scale.Z) < MinScale)
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.ZeroScale, c.Actor,
                    "has no size along an axis: its scale is (" + Show(c.Scale) + "), itself or from a parent"));
                return false;
            }
            return true;
        }

        private static WorldQ Unit(WorldQ q)
        {
            var k = 1 / q.Length;
            return new WorldQ(q.X * k, q.Y * k, q.Z * k, q.W * k);
        }

        /// <summary>Scale, then turn, then move: where Unity's physics puts a primitive's centre.</summary>
        private static WorldV3 CenterOf(WorldCollider c) =>
            c.Position + Unit(c.Rotation).Rotate(new WorldV3(c.Center.X * c.Scale.X, c.Center.Y * c.Scale.Y, c.Center.Z * c.Scale.Z));

        /// <summary>A Unity point or vector in the room's axes and units.</summary>
        private static WorldV3 Mapped(WorldV3 v, double u) => new WorldV3(v.X * u, v.Z * u, v.Y * u);

        private static string CheckUnits(WorldV3 v) =>
            Math.Abs(v.X) > MaxUnits || Math.Abs(v.Y) > MaxUnits || Math.Abs(v.Z) > MaxUnits
                ? "reaches (" + Show(v) + ") units, past " + MaxUnits.ToString("F0", CultureInfo.InvariantCulture) + " where a float32 no longer holds whole units"
                : null;

        private static bool Fits(WorldCollider c, WorldV3 v, List<WorldRefusal> refusals)
        {
            var error = CheckUnits(v);
            if (error == null) return true;
            refusals.Add(new WorldRefusal(WorldRefusalCode.HugeScale, c.Actor, error));
            return false;
        }

        private static string Show(WorldV3 v) =>
            v.X.ToString("G6", CultureInfo.InvariantCulture) + ", " + v.Y.ToString("G6", CultureInfo.InvariantCulture) + ", " + v.Z.ToString("G6", CultureInfo.InvariantCulture);

        // ---------------- box ----------------

        private static string BoxText(WorldCollider c, double u, List<WorldRefusal> refusals)
        {
            if (!PoseIsUsable(c, refusals)) return null;
            if (!c.Center.IsFinite || !c.Size.IsFinite)
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, c.Actor, "its BoxCollider's center or size is not a finite number"));
                return null;
            }
            var center = Mapped(CenterOf(c), u);
            // Local extents in rows x, z, y: the same swap on both sides of the rotation keeps a right-handed set of axes.
            // Mirrored or not, Unity's physics takes a box's size and scale as lengths; only its centre mirrors.
            var half = new WorldV3(Math.Abs(c.Size.X * c.Scale.X) / 2 * u, Math.Abs(c.Size.Z * c.Scale.Z) / 2 * u, Math.Abs(c.Size.Y * c.Scale.Y) / 2 * u);
            if (!Fits(c, center, refusals) || !Fits(c, half, refusals)) return null;
            var q = Unit(c.Rotation);
            var ax = Mapped(q.Rotate(new WorldV3(1, 0, 0)), 1);
            var az = Mapped(q.Rotate(new WorldV3(0, 0, 1)), 1);
            var ay = Mapped(q.Rotate(new WorldV3(0, 1, 0)), 1);
            var sb = new StringBuilder("{\"kind\":\"box\",\"center\":").Append(Vec(center));
            if (OnAxes(ax, az, ay))
            {
                sb.Append(",\"half\":").Append(Vec(OnAxisHalf(ax, az, ay, half)));
            }
            else
            {
                sb.Append(",\"axes\":[").Append(Axis(ax)).Append(',').Append(Axis(az)).Append(',').Append(Axis(ay)).Append("],\"half\":").Append(Vec(half));
            }
            return Common(sb, c).Append('}').ToString();
        }

        private static bool OnAxes(WorldV3 a, WorldV3 b, WorldV3 c) => IsAxis(a) && IsAxis(b) && IsAxis(c);

        private static bool IsAxis(WorldV3 v) => Math.Max(Math.Abs(v.X), Math.Max(Math.Abs(v.Y), Math.Abs(v.Z))) >= 1 - OnAxisTolerance;

        /// <summary>A box turned onto the axes: each local extent goes to the world axis its axis lies along.</summary>
        private static WorldV3 OnAxisHalf(WorldV3 a, WorldV3 b, WorldV3 c, WorldV3 half)
        {
            var world = new double[3];
            world[Dominant(a)] = half.X;
            world[Dominant(b)] = half.Y;
            world[Dominant(c)] = half.Z;
            return new WorldV3(world[0], world[1], world[2]);
        }

        private static int Dominant(WorldV3 v)
        {
            var x = Math.Abs(v.X);
            var y = Math.Abs(v.Y);
            var z = Math.Abs(v.Z);
            if (x >= y && x >= z) return 0;
            return y >= z ? 1 : 2;
        }

        // ---------------- sphere and capsule ----------------

        private static string SphereText(WorldCollider c, double u, WorldExportReport report, List<WorldRefusal> refusals)
        {
            if (!PoseIsUsable(c, refusals) || !RoundIsUsable(c, refusals)) return null;
            return RoundText(c, Mapped(CenterOf(c), u), Math.Abs(c.Radius) * Math.Max(Math.Abs(c.Scale.X), Math.Max(Math.Abs(c.Scale.Y), Math.Abs(c.Scale.Z))) * u, report, refusals);
        }

        private static bool RoundIsUsable(WorldCollider c, List<WorldRefusal> refusals)
        {
            if (!c.Center.IsFinite || !double.IsFinite(c.Radius) || !double.IsFinite(c.Height))
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, c.Actor, "its collider's center, radius or height is not a finite number"));
                return false;
            }
            return true;
        }

        private static string RoundText(WorldCollider c, WorldV3 center, double radius, WorldExportReport report, List<WorldRefusal> refusals)
        {
            if (!Fits(c, center, refusals) || !Fits(c, new WorldV3(radius, 0, 0), refusals)) return null;
            if (FixedCount(radius, UnitDigits) == 0)
            {
                report.Warnings.Add(new WorldWarning(WorldWarningCode.NoSize, c.Actor, "its collider has no size, so it stops nothing"));
                return null;
            }
            var sb = new StringBuilder("{\"kind\":\"sphere\",\"center\":").Append(Vec(center)).Append(",\"radius\":").Append(Num(radius));
            return Common(sb, c).Append('}').ToString();
        }

        private static string CapsuleText(WorldCollider c, double u, WorldExportReport report, List<WorldRefusal> refusals)
        {
            if (!PoseIsUsable(c, refusals) || !RoundIsUsable(c, refusals)) return null;
            var sx = Math.Abs(c.Scale.X);
            var sy = Math.Abs(c.Scale.Y);
            var sz = Math.Abs(c.Scale.Z);
            var axisScale = c.Direction == 0 ? sx : c.Direction == 2 ? sz : sy;
            var sideScale = c.Direction == 0 ? Math.Max(sy, sz) : c.Direction == 2 ? Math.Max(sx, sy) : Math.Max(sx, sz);
            var radius = Math.Abs(c.Radius) * sideScale * u;
            var centerWorld = CenterOf(c);
            var segment = Math.Max(Math.Abs(c.Height) * axisScale * u / 2 - radius, 0);
            if (FixedCount(segment, UnitDigits) == 0) return RoundText(c, Mapped(centerWorld, u), radius, report, refusals);
            var local = c.Direction == 0 ? new WorldV3(1, 0, 0) : c.Direction == 2 ? new WorldV3(0, 0, 1) : new WorldV3(0, 1, 0);
            var axis = Mapped(Unit(c.Rotation).Rotate(local), 1);
            var mid = Mapped(centerWorld, u);
            var a = mid + axis * -segment;
            var b = mid + axis * segment;
            if (!Fits(c, a, refusals) || !Fits(c, b, refusals) || !Fits(c, new WorldV3(radius, 0, 0), refusals)) return null;
            var sb = new StringBuilder("{\"kind\":\"capsule\",\"a\":").Append(Vec(a)).Append(",\"b\":").Append(Vec(b)).Append(",\"radius\":").Append(Num(radius));
            return Common(sb, c).Append('}').ToString();
        }

        // ---------------- mesh ----------------

        private static string MeshText(WorldCollider c, double u, WorldExportReport report, List<WorldRefusal> refusals)
        {
            if (!c.Readable)
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.NonReadableMesh, c.Actor,
                    "the mesh " + (c.MeshName.Length > 0 ? c.MeshName + " " : "") + "cannot be read: turn on Read/Write in its import settings, or give this object simple colliders"));
                return null;
            }
            if (!PoseIsUsable(c, refusals)) return null;
            if (c.Matrix == null || c.Matrix.Length != 16 || c.Matrix.Any(v => !double.IsFinite(v)))
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, c.Actor, "its transform's matrix holds a value that is not a finite number"));
                return null;
            }
            var determinant = Determinant3(c.Matrix);
            if (Math.Abs(determinant) < MinScale * MinScale * MinScale)
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.ZeroScale, c.Actor, "its transform flattens it to no volume"));
                return null;
            }
            if (c.Vertices.Length == 0 || c.Indices.Length == 0)
            {
                report.Warnings.Add(new WorldWarning(WorldWarningCode.EmptyMesh, c.Actor, "its MeshCollider has no triangles, so it stops nothing"));
                return null;
            }
            var points = new double[c.Vertices.Length];
            for (var i = 0; i + 2 < c.Vertices.Length; i += 3)
            {
                if (!float.IsFinite(c.Vertices[i]) || !float.IsFinite(c.Vertices[i + 1]) || !float.IsFinite(c.Vertices[i + 2]))
                {
                    refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, c.Actor, "the mesh's vertex " + (i / 3).ToString(CultureInfo.InvariantCulture) + " is not a finite number"));
                    return null;
                }
                var p = Mapped(Transformed(c.Matrix, c.Vertices[i], c.Vertices[i + 1], c.Vertices[i + 2]), u);
                if (!Fits(c, p, refusals)) return null;
                points[i] = p.X;
                points[i + 1] = p.Y;
                points[i + 2] = p.Z;
            }
            var count = points.Length / 3;
            if (c.Convex && count > MaxHullPoints)
            {
                report.Warnings.Add(new WorldWarning(WorldWarningCode.HullTooBig, c.Actor,
                    "its convex mesh has " + count.ToString(CultureInfo.InvariantCulture) + " points, past " + MaxHullPoints.ToString(CultureInfo.InvariantCulture) + ": written as its triangles"));
            }
            if (c.Convex && count <= MaxHullPoints)
            {
                var sb = new StringBuilder("{\"kind\":\"hull\",\"points\":[");
                for (var i = 0; i < count; i++) (i == 0 ? sb : sb.Append(',')).Append(Vec(new WorldV3(points[3 * i], points[3 * i + 1], points[3 * i + 2])));
                return Common(sb.Append(']'), c).Append('}').ToString();
            }
            var mesh = new StringBuilder("{\"kind\":\"mesh\",\"vertices\":").Append(Floats(points)).Append(",\"indices\":").Append(Indices(determinant < 0 ? Turned(c.Indices) : c.Indices));
            return Common(mesh, c).Append('}').ToString();
        }

        /// <summary>A mirror turns every triangle inside out. PhysX turns them back, so a mirrored mesh's triangles go in the file wound as any other
        /// mesh's: one winding sense throughout, for whatever reads faces later.</summary>
        private static int[] Turned(int[] indices)
        {
            var turned = (int[])indices.Clone();
            for (var i = 0; i + 2 < turned.Length; i += 3)
            {
                turned[i + 1] = indices[i + 2];
                turned[i + 2] = indices[i + 1];
            }
            return turned;
        }

        private static WorldV3 Transformed(double[] m, double x, double y, double z) => new WorldV3(
            m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11]);

        private static double Determinant3(double[] m) =>
            m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);

        // ---------------- terrain ----------------

        private static string TerrainText(WorldCollider c, double u, List<WorldRefusal> refusals)
        {
            if (!c.Position.IsFinite || !double.IsFinite(c.CellX) || !double.IsFinite(c.CellZ))
            {
                refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, c.Actor, "its position or terrain size is not a finite number"));
                return null;
            }
            var origin = Mapped(c.Position, u);
            var cell = new WorldV3(c.CellX * u, c.CellZ * u, 0);
            var far = new WorldV3(origin.X + cell.X * (c.Cols - 1), origin.Y + cell.Y * (c.Rows - 1), origin.Z);
            if (!Fits(c, origin, refusals) || !Fits(c, far, refusals)) return null;
            var heights = new double[c.Heights.Length];
            for (var i = 0; i < heights.Length; i++)
            {
                if (!float.IsFinite(c.Heights[i]))
                {
                    refusals.Add(new WorldRefusal(WorldRefusalCode.NotFinite, c.Actor, "a terrain height is not a finite number"));
                    return null;
                }
                heights[i] = (c.Position.Y + c.Heights[i]) * u;
                if (!Fits(c, new WorldV3(0, 0, heights[i]), refusals)) return null;
            }
            Punch(c, heights);
            var sb = new StringBuilder("{\"kind\":\"heightfield\",\"origin\":[").Append(Num(origin.X)).Append(',').Append(Num(origin.Y))
                .Append("],\"cell\":[").Append(Num(cell.X)).Append(',').Append(Num(cell.Y))
                .Append("],\"cols\":").Append(c.Cols.ToString(CultureInfo.InvariantCulture))
                .Append(",\"rows\":").Append(c.Rows.ToString(CultureInfo.InvariantCulture))
                .Append(",\"heights\":").Append(Floats(heights));
            return Common(sb, c).Append('}').ToString();
        }

        /// <summary>The format's holes are at vertices and Unity's in cells: every corner of a holed cell is a hole, so a hole
        /// may grow by a cell but never closes.</summary>
        private static void Punch(WorldCollider c, double[] heights)
        {
            if (c.HoleCells == null) return;
            var cellCols = c.Cols - 1;
            for (var row = 0; row < c.Rows - 1; row++)
            {
                for (var col = 0; col < cellCols; col++)
                {
                    if (!c.HoleCells[row * cellCols + col]) continue;
                    heights[row * c.Cols + col] = double.NaN;
                    heights[row * c.Cols + col + 1] = double.NaN;
                    heights[(row + 1) * c.Cols + col] = double.NaN;
                    heights[(row + 1) * c.Cols + col + 1] = double.NaN;
                }
            }
        }

        // ---------------- text ----------------

        private static StringBuilder Common(StringBuilder sb, WorldCollider c)
        {
            if (c.Move && c.Shot) return sb;
            return sb.Append(",\"channels\":[\"").Append(c.Move ? "move" : "shot").Append("\"]");
        }

        private static string SpawnText(WorldSpawnPoint s, double u)
        {
            var sb = new StringBuilder("{\"at\":").Append(Vec(Mapped(s.At, u)));
            if (!string.IsNullOrEmpty(s.Name)) sb.Append(",\"name\":").Append(Quoted(Named(s.Name)));
            if (s.Tags.Length > 0) sb.Append(",\"tags\":").Append(Strings(s.Tags));
            return sb.Append('}').ToString();
        }

        private static string SceneText(List<ActorOut> actors, List<string> spawns, WorldExportOptions options)
        {
            var sb = new StringBuilder("{\n\"format\":\"").Append(Format).Append("\",\n\"version\":").Append(Version.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\n\"unitsPerMeter\":").Append(Num(options.UnitsPerMeter));
            // An unsaved scene has no name, and the format refuses an empty value.
            var source = options.Source.Where(p => !string.IsNullOrEmpty(p.Value)).ToList();
            if (source.Count > 0)
            {
                sb.Append(",\n\"source\":{").Append(string.Join(",", source.Select(p => Quoted(p.Key) + ":" + Quoted(p.Value)))).Append('}');
            }
            if (options.Hull != null)
            {
                var h = options.Hull;
                sb.Append(",\n\"hull\":{\"radius\":").Append(Num(h[0])).Append(",\"height\":").Append(Num(h[1])).Append(",\"crouchHeight\":").Append(Num(h[2]))
                    .Append(",\"step\":").Append(Num(h[3])).Append(",\"jump\":").Append(Num(h[4])).Append(",\"leap\":").Append(Num(h[5])).Append('}');
            }
            sb.Append(",\n\"actors\":[");
            for (var i = 0; i < actors.Count; i++)
            {
                var a = actors[i];
                sb.Append(i == 0 ? "\n" : ",\n").Append("{\"name\":").Append(Quoted(a.Name));
                if (a.Tags.Count > 0) sb.Append(",\"tags\":").Append(Strings(a.Tags));
                sb.Append(",\"surfaces\":[").Append(string.Join(",", a.Surfaces)).Append("]}");
            }
            sb.Append("\n],\n\"spawns\":[");
            sb.Append(string.Join(",", spawns)).Append("]\n}\n");
            return sb.ToString();
        }

        private static string Strings(IEnumerable<string> list) => "[" + string.Join(",", list.Select(Quoted)) + "]";

        private static string Quoted(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (var ch in s)
            {
                if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
                else if (ch < ' ') sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(ch);
            }
            return sb.Append('"').ToString();
        }

        private static long FixedCount(double v, long digits) => (long)Math.Round(v * digits, MidpointRounding.AwayFromZero);

        /// <summary>A value as whole counts of 1/<paramref name="digits"/>, written by integer arithmetic.</summary>
        private static string Fixed(double v, long digits)
        {
            var count = FixedCount(v, digits);
            if (count == 0) return "0";
            var abs = Math.Abs(count);
            var whole = (abs / digits).ToString(CultureInfo.InvariantCulture);
            var part = abs % digits;
            var sign = count < 0 ? "-" : "";
            if (part == 0) return sign + whole;
            var width = digits.ToString(CultureInfo.InvariantCulture).Length - 1;
            return sign + whole + "." + part.ToString(CultureInfo.InvariantCulture).PadLeft(width, '0').TrimEnd('0');
        }

        private static string Num(double v) => Fixed(v, UnitDigits);

        private static string Vec(WorldV3 v) => "[" + Num(v.X) + "," + Num(v.Y) + "," + Num(v.Z) + "]";

        private static string Axis(WorldV3 v) => "[" + Fixed(v.X, AxisDigits) + "," + Fixed(v.Y, AxisDigits) + "," + Fixed(v.Z, AxisDigits) + "]";

        /// <summary>Numbers as text, or a binary float32 array past <see cref="MaxTextArray"/>. NaN is a hole: null in text.</summary>
        private static string Floats(double[] values)
        {
            if (values.Length <= MaxTextArray) return "[" + string.Join(",", values.Select(v => double.IsNaN(v) ? "null" : Num(v))) + "]";
            var bytes = new byte[values.Length * 4];
            for (var i = 0; i < values.Length; i++)
            {
                var f = double.IsNaN(values[i]) ? float.NaN : (float)(FixedCount(values[i], UnitDigits) / (double)UnitDigits);
                Little(BitConverter.GetBytes(f), bytes, i);
            }
            return "{\"f32le\":\"" + Convert.ToBase64String(bytes) + "\"}";
        }

        private static string Indices(int[] values)
        {
            if (values.Length <= MaxTextArray) return "[" + string.Join(",", values.Select(v => v.ToString(CultureInfo.InvariantCulture))) + "]";
            var bytes = new byte[values.Length * 4];
            for (var i = 0; i < values.Length; i++) Little(BitConverter.GetBytes((uint)values[i]), bytes, i);
            return "{\"u32le\":\"" + Convert.ToBase64String(bytes) + "\"}";
        }

        private static void Little(byte[] word, byte[] into, int index)
        {
            if (!BitConverter.IsLittleEndian) Array.Reverse(word);
            Buffer.BlockCopy(word, 0, into, index * 4, 4);
        }
    }
}
