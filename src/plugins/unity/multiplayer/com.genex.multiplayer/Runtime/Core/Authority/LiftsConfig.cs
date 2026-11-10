// `config.lifts` (PROTOCOL.md §17.11 *Lifts*), a port of packages/multiplayer/src/authority/lifts-config.ts: the platforms a room
// module declares as data (moving platforms, elevators, spinners, sweepers, conveyors), each posed by an exact function of the tick
// (Lifts.cs). `GenexLiftsConfig.Resolve` turns a declaration (parsed JSON: a map) into the resolved policy the host, the guest
// prelude and every SDK run, and refuses a bad one by the path of the first bad value, as §17.7's world and `config.contacts` are
// refused. Held to lifts.json's `config` rows (GenexSmoke `lifts`). Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A lift's shape kind: a box (turned about z when it spins) or an upright disc.</summary>
    public enum GenexLiftShapeKind { Box, Disc }

    /// <summary>A lift's shape, room units, about its centre.</summary>
    public sealed class GenexLiftShape
    {
        public GenexLiftShapeKind Kind;
        /// <summary>A box's half extents (x, y, z).</summary>
        public GenexV3 Half;
        /// <summary>A disc's radius and half height.</summary>
        public double Radius, HalfZ;
    }

    /// <summary>A resolved path: its points (float32), a leg's ticks and a wait's ticks per point.</summary>
    public sealed class GenexLiftPath
    {
        public GenexV3[] Points;
        public int[] Legs;
        public int[] Waits;
        /// <summary>True: <c>loop</c> (round the points and back to the first); false: <c>pingpong</c>.</summary>
        public bool Loop;
        /// <summary>True: <c>smooth</c> (<c>s·s·(3 - 2s)</c>); false: <c>linear</c>.</summary>
        public bool Smooth;
        public int Phase;
        /// <summary>The ticks of one whole cycle.</summary>
        public double Period;
    }

    /// <summary>A resolved spin: a turn every <see cref="Period"/> ticks, <see cref="Dir"/> 1 (counter-clockwise from above) or -1.</summary>
    public sealed class GenexLiftSpin
    {
        public int Period, Dir, Phase;
    }

    /// <summary>One resolved platform.</summary>
    public sealed class GenexLift
    {
        public string Id;
        public GenexLiftShape Shape;
        /// <summary>The centre when it has no path (else the path's first point).</summary>
        public GenexV3 At;
        public GenexLiftPath Path;
        public GenexLiftSpin Spin;
        /// <summary>A conveyor's surface velocity in its own frame (u/s).</summary>
        public bool HasSurface;
        public double SurfaceX, SurfaceY;
        /// <summary>Whether a rider keeps the lift's velocity on leaving (<c>impart: all</c>).</summary>
        public bool ImpartAll;
        /// <summary>Still until the module calls it; a call runs one cycle of its path.</summary>
        public bool Called;
    }

    /// <summary>The resolved <c>config.lifts</c>.</summary>
    public sealed class GenexLiftsPolicy
    {
        public GenexLift[] Platforms = new GenexLift[0];
        /// <summary>Whether seats ride level dynamic module bodies too.</summary>
        public bool Bodies;

        /// <summary>No lifts: what the slots run over in a room whose only carry is by seats (a stand rule that rides).</summary>
        public static readonly GenexLiftsPolicy None = new GenexLiftsPolicy();
    }

    /// <summary>A platform refused for moving too fast: its id, its fastest point's move a tick, the most allowed (the hull radius) and
    /// the tick rate.</summary>
    public sealed class GenexLiftTooFast
    {
        public string Platform;
        public double Move, Allowed, TickHz;
    }

    /// <summary>A refused <c>config.lifts</c>: the path of the first bad value (and, for a platform too fast, its speed).</summary>
    public sealed class GenexLiftsConfigException : Exception
    {
        public string Path { get; }
        public GenexLiftTooFast Fast { get; }

        public GenexLiftsConfigException(string path, GenexLiftTooFast fast = null) : base(path)
        {
            Path = path;
            Fast = fast;
        }
    }

    /// <summary>Resolves <c>config.lifts</c> (lifts-config.ts <c>resolveLifts</c>).</summary>
    public static class GenexLiftsConfig
    {
        /// <summary>Platforms a module may declare at most, points a path may hold, and a lift id's length.</summary>
        public const int PlatformsMax = 32, PointsMax = 16, IdMax = 32;
        /// <summary>Every position, size and speed's magnitude at most (units, units/s).</summary>
        public const double ValueMax = 1e6;
        /// <summary>Every tick count (a leg, a wait, a phase, a spin's period) at most.</summary>
        public const double TicksMax = 16777216;
        /// <summary>A spin's fewest ticks a turn.</summary>
        public const int SpinMinPeriod = 8;
        /// <summary><c>smooth</c>'s peak speed over its mean.</summary>
        private const double SmoothPeak = 1.5;
        private static readonly double TwoPi = 2 * Math.PI;

        private static readonly string[] Keys = { "platforms", "bodies" };
        private static readonly string[] PlatformKeys = { "id", "shape", "at", "path", "spin", "surface", "impart", "called" };
        private static readonly string[] PathKeys = { "points", "legs", "waits", "mode", "ease", "phase" };
        private static readonly string[] SpinKeys = { "period", "dir", "phase" };
        private static readonly string[] BoxKeys = { "kind", "half" };
        private static readonly string[] DiscKeys = { "kind", "radius", "half" };

        private static bool Has(Dictionary<string, object> o, string k) => o.ContainsKey(k);

        private static object Get(Dictionary<string, object> o, string k) => o.TryGetValue(k, out var v) ? v : null;

        private static void OnlyKeys(Dictionary<string, object> o, string[] keys, string path)
        {
            foreach (var k in o.Keys)
            {
                if (Array.IndexOf(keys, k) < 0) throw new GenexLiftsConfigException(path + "." + k);
            }
        }

        /// <summary>A finite number of magnitude at most <see cref="ValueMax"/> (<paramref name="positive"/>: above 0), as its float32.</summary>
        private static double Value(object v, string path, bool positive = false)
        {
            if (!(v is double d) || double.IsNaN(d) || double.IsInfinity(d) || Math.Abs(d) > ValueMax) throw new GenexLiftsConfigException(path);
            double f = (float)d;
            if (f == 0) f = 0;
            if (positive && !(f > 0)) throw new GenexLiftsConfigException(path);
            return f;
        }

        /// <summary>An integer tick count in [lo, TicksMax].</summary>
        private static int Ticks(object v, string path, int lo)
        {
            if (!(v is double d) || double.IsNaN(d) || double.IsInfinity(d) || d != Math.Floor(d) || d < lo || d > TicksMax) throw new GenexLiftsConfigException(path);
            return (int)d;
        }

        private static double[] Vector(object v, string path, int n, bool positive = false)
        {
            if (!(v is List<object> list) || list.Count != n) throw new GenexLiftsConfigException(path);
            var output = new double[n];
            for (var i = 0; i < n; i++) output[i] = Value(list[i], path + "[" + i + "]", positive);
            return output;
        }

        private static GenexV3 Vec3(object v, string path, bool positive = false)
        {
            var a = Vector(v, path, 3, positive);
            return new GenexV3(a[0], a[1], a[2]);
        }

        private static GenexLiftShape ShapeOf(object v, string path)
        {
            if (!(v is Dictionary<string, object> o)) throw new GenexLiftsConfigException(path);
            var kind = Get(o, "kind") as string;
            if (kind == "box")
            {
                OnlyKeys(o, BoxKeys, path);
                return new GenexLiftShape { Kind = GenexLiftShapeKind.Box, Half = Vec3(Get(o, "half"), path + ".half", true) };
            }
            if (kind == "disc")
            {
                OnlyKeys(o, DiscKeys, path);
                var radius = Value(Get(o, "radius"), path + ".radius", true);
                var half = Value(Get(o, "half"), path + ".half", true);
                return new GenexLiftShape { Kind = GenexLiftShapeKind.Disc, Radius = radius, HalfZ = half };
            }
            throw new GenexLiftsConfigException(path + ".kind");
        }

        /// <summary>The declared choice, else the fallback; anything outside <paramref name="values"/> is refused.</summary>
        private static string EnumOf(Dictionary<string, object> o, string key, string path, string[] values, string fallback)
        {
            if (!Has(o, key)) return fallback;
            if (!(o[key] is string v) || Array.IndexOf(values, v) < 0) throw new GenexLiftsConfigException(path + "." + key);
            return v;
        }

        /// <summary>A path's cycle: pingpong runs out and back (every leg twice, the end points' waits once, the inner points' twice);
        /// loop runs round once.</summary>
        private static double PeriodOf(int[] legs, int[] waits, bool loop)
        {
            double legSum = 0, waitSum = 0;
            foreach (var l in legs) legSum += l;
            foreach (var w in waits) waitSum += w;
            if (loop) return legSum + waitSum;
            return 2 * legSum + 2 * waitSum - (waits.Length > 0 ? waits[0] : 0) - (waits.Length > 0 ? waits[waits.Length - 1] : 0);
        }

        private static GenexLiftPath PathOf(object v, string path, bool called)
        {
            if (!(v is Dictionary<string, object> o)) throw new GenexLiftsConfigException(path);
            OnlyKeys(o, PathKeys, path);
            var mode = EnumOf(o, "mode", path, new[] { "pingpong", "loop" }, "pingpong");
            var ease = EnumOf(o, "ease", path, new[] { "linear", "smooth" }, "linear");
            if (!(Get(o, "legs") is List<object> legList) || legList.Count < 1 || legList.Count > PointsMax) throw new GenexLiftsConfigException(path + ".legs");
            var legs = new int[legList.Count];
            for (var i = 0; i < legs.Length; i++) legs[i] = Ticks(legList[i], path + ".legs[" + i + "]", 1);
            var loop = mode == "loop";
            var want = loop ? legs.Length : legs.Length + 1;
            if (!(Get(o, "points") is List<object> pointList) || pointList.Count != want || want < 2) throw new GenexLiftsConfigException(path + ".points");
            var points = new GenexV3[pointList.Count];
            for (var i = 0; i < points.Length; i++) points[i] = Vec3(pointList[i], path + ".points[" + i + "]");
            var waits = new int[points.Length];
            if (Has(o, "waits"))
            {
                if (!(o["waits"] is List<object> waitList) || waitList.Count != points.Length) throw new GenexLiftsConfigException(path + ".waits");
                for (var i = 0; i < waits.Length; i++) waits[i] = Ticks(waitList[i], path + ".waits[" + i + "]", 0);
            }
            if (called && Has(o, "phase")) throw new GenexLiftsConfigException(path + ".phase");
            var phase = Has(o, "phase") ? Ticks(o["phase"], path + ".phase", 0) : 0;
            return new GenexLiftPath { Points = points, Legs = legs, Waits = waits, Loop = loop, Smooth = ease == "smooth", Phase = phase, Period = PeriodOf(legs, waits, loop) };
        }

        private static GenexLiftSpin SpinOf(object v, string path)
        {
            if (!(v is Dictionary<string, object> o)) throw new GenexLiftsConfigException(path);
            OnlyKeys(o, SpinKeys, path);
            var period = Ticks(Get(o, "period"), path + ".period", SpinMinPeriod);
            if (Has(o, "dir") && !(o["dir"] is double dd && (dd == 1 || dd == -1))) throw new GenexLiftsConfigException(path + ".dir");
            return new GenexLiftSpin { Period = period, Dir = Has(o, "dir") ? (int)(double)o["dir"] : 1, Phase = Has(o, "phase") ? Ticks(o["phase"], path + ".phase", 0) : 0 };
        }

        /// <summary>The farthest any point of the shape is from its centre on x and y (a spin's tip).</summary>
        private static double ReachOf(GenexLiftShape s) => s.Kind == GenexLiftShapeKind.Disc ? s.Radius : Math.Sqrt(s.Half.X * s.Half.X + s.Half.Y * s.Half.Y);

        /// <summary>The movement refusal: a platform any point of which moves more than the hull radius a tick could pass through a seat.</summary>
        private static void RefuseFast(GenexLift lift, string path, double radius, double tickHz)
        {
            var spinTip = lift.Spin == null ? 0 : (ReachOf(lift.Shape) * TwoPi) / lift.Spin.Period;
            var fastestAt = path + ".spin.period";
            var fastest = spinTip;
            var p = lift.Path;
            var legs = p == null ? new int[0] : p.Legs;
            for (var i = 0; i < legs.Length; i++)
            {
                var a = p.Points[i];
                var b = p.Points[(i + 1) % p.Points.Length];
                var dx = b.X - a.X;
                var dy = b.Y - a.Y;
                var dz = b.Z - a.Z;
                var mean = Math.Sqrt(dx * dx + dy * dy + dz * dz) / legs[i];
                var move = (p.Smooth ? SmoothPeak * mean : mean) + spinTip;
                if (move > fastest)
                {
                    fastest = move;
                    fastestAt = path + ".path.legs[" + i + "]";
                }
            }
            if (fastest > radius) throw new GenexLiftsConfigException(fastestAt, new GenexLiftTooFast { Platform = lift.Id, Move = fastest, Allowed = radius, TickHz = tickHz });
        }

        private static GenexLift PlatformOf(object v, string path, HashSet<string> ids, double radius, double tickHz)
        {
            if (!(v is Dictionary<string, object> o)) throw new GenexLiftsConfigException(path);
            OnlyKeys(o, PlatformKeys, path);
            var id = Get(o, "id") as string;
            if (id == null || id.Length == 0 || id.Length > IdMax || !IdOk(id)) throw new GenexLiftsConfigException(path + ".id");
            if (ids.Contains(id)) throw new GenexLiftsConfigException(path + ".id");
            ids.Add(id);
            var shape = ShapeOf(Get(o, "shape"), path + ".shape");
            if (Has(o, "called") && !(o["called"] is bool)) throw new GenexLiftsConfigException(path + ".called");
            var called = Has(o, "called") && (bool)o["called"];
            var lpath = Has(o, "path") ? PathOf(o["path"], path + ".path", called) : null;
            if (lpath == null && !Has(o, "at")) throw new GenexLiftsConfigException(path + ".at");
            var at = Has(o, "at") ? Vec3(o["at"], path + ".at") : lpath.Points[0];
            var lift = new GenexLift { Id = id, Shape = shape, At = at, Path = lpath, Called = called };
            if (Has(o, "spin")) lift.Spin = SpinOf(o["spin"], path + ".spin");
            if (Has(o, "surface"))
            {
                var s = Vector(o["surface"], path + ".surface", 2);
                lift.HasSurface = true;
                lift.SurfaceX = s[0];
                lift.SurfaceY = s[1];
            }
            lift.ImpartAll = EnumOf(o, "impart", path, new[] { "all", "none" }, "all") == "all";
            RefuseFast(lift, path, radius, tickHz);
            return lift;
        }

        /// <summary>An id of a-z, 0-9 and -.</summary>
        private static bool IdOk(string id)
        {
            foreach (var c in id)
            {
                if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
            }
            return true;
        }

        /// <summary>
        /// <c>config.lifts</c> resolved against the room's movement preset and tick rate (§17.11 <i>Lifts</i>). Throws
        /// <see cref="GenexLiftsConfigException"/> (the path from <paramref name="path"/>) for a value that is not an object, an unknown
        /// key, an empty list or more than <see cref="PlatformsMax"/> platforms, an id that is not 1-32 of <c>[a-z0-9-]</c> or repeats, a
        /// shape without its sizes, a path whose points, legs and waits do not match, a tick count that is not a whole number, a phase on
        /// a called lift, a value out of range, a platform any point of which moves more than the hull radius a tick (named, with its
        /// speed and the most allowed), or a room whose movement preset steps through no world.
        /// </summary>
        public static GenexLiftsPolicy Resolve(object given, GenexContactPresetParams preset, double tickHz, string path = "$.config.lifts")
        {
            if (!(given is Dictionary<string, object> o)) throw new GenexLiftsConfigException(path);
            OnlyKeys(o, Keys, path);
            if (preset == null || (preset.Name != "firstperson" && preset.Name != "vehicle")) throw new GenexLiftsConfigException(path);
            if (!(Get(o, "platforms") is List<object> list) || list.Count < 1 || list.Count > PlatformsMax) throw new GenexLiftsConfigException(path + ".platforms");
            if (Has(o, "bodies") && !(o["bodies"] is bool)) throw new GenexLiftsConfigException(path + ".bodies");
            var radius = preset.Get("radius");
            var ids = new HashSet<string>();
            var platforms = new GenexLift[list.Count];
            for (var i = 0; i < platforms.Length; i++) platforms[i] = PlatformOf(list[i], path + ".platforms[" + i + "]", ids, radius, tickHz);
            return new GenexLiftsPolicy { Platforms = platforms, Bodies = !(Has(o, "bodies") && !(bool)o["bodies"]) };
        }

        // ---- the resolved policy as data (the conformance file's `resolved` shape) ----

        private static List<object> V3List(GenexV3 v) => new List<object> { v.X, v.Y, v.Z };

        /// <summary>The resolved policy as the data lifts.json prints (<c>resolved</c>).</summary>
        public static Dictionary<string, object> ToJson(GenexLiftsPolicy p)
        {
            var platforms = new List<object>();
            foreach (var l in p.Platforms)
            {
                var shape = l.Shape.Kind == GenexLiftShapeKind.Box
                    ? new Dictionary<string, object> { ["kind"] = "box", ["half"] = V3List(l.Shape.Half) }
                    : new Dictionary<string, object> { ["kind"] = "disc", ["radius"] = l.Shape.Radius, ["half"] = l.Shape.HalfZ };
                object path = null;
                if (l.Path != null)
                {
                    var points = new List<object>();
                    foreach (var pt in l.Path.Points) points.Add(V3List(pt));
                    var legs = new List<object>();
                    foreach (var n in l.Path.Legs) legs.Add((double)n);
                    var waits = new List<object>();
                    foreach (var n in l.Path.Waits) waits.Add((double)n);
                    path = new Dictionary<string, object>
                    {
                        ["points"] = points, ["legs"] = legs, ["waits"] = waits, ["mode"] = l.Path.Loop ? "loop" : "pingpong", ["ease"] = l.Path.Smooth ? "smooth" : "linear",
                        ["phase"] = (double)l.Path.Phase, ["period"] = l.Path.Period,
                    };
                }
                object spin = l.Spin == null ? null : new Dictionary<string, object> { ["period"] = (double)l.Spin.Period, ["dir"] = (double)l.Spin.Dir, ["phase"] = (double)l.Spin.Phase };
                object surface = l.HasSurface ? new List<object> { l.SurfaceX, l.SurfaceY } : null;
                platforms.Add(new Dictionary<string, object>
                {
                    ["id"] = l.Id, ["shape"] = shape, ["at"] = V3List(l.At), ["path"] = path, ["spin"] = spin, ["surface"] = surface,
                    ["impart"] = l.ImpartAll ? "all" : "none", ["called"] = l.Called,
                });
            }
            return new Dictionary<string, object> { ["platforms"] = platforms, ["bodies"] = p.Bodies };
        }
    }
}
