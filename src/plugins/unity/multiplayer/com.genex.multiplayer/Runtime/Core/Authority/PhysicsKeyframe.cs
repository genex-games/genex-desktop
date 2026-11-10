// Keyframes of a predicting physics room (PROTOCOL.md §17.11): the rules the server and every predicting client share,
// ported from packages/multiplayer/src/authority/physics-keyframe.ts (the reference) line for line:
//  - physDesc: the room's world description, keyframe interval, clamp, preset body and client knobs;
//  - wire rows (C§20.2): what a body entity's fields are as importWire takes them (15 numbers);
//  - the speed clamp every predicting tick applies before a keyframe's canonicalize (§17.11 step 8a);
//  - shapes by reference, inlined from the state's `shapes`;
//  - contact islands by proximity (bounding spheres within a margin, or linked by a joint);
//  - inputDecay's weight, and a correction's τ and snap distance (§17.11 *Drawing*).
// Everything is float64 in the order the TypeScript writes it, so the numbers handed to the core are the same.
// Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>How a client moves other players' preset bodies between keyframes (§17.11 <c>remotePredict</c>).</summary>
    public static class GenexRemotePredict
    {
        public const string Extrapolate = "extrapolate";
        /// <summary>The Rocket League model: the last input held, the room preset's step under it every tick.</summary>
        public const string Hold = "hold";
        public const string InputDecay = "inputDecay";
    }

    /// <summary>A seat's preset body collider (§17.10 *Preset bodies*).</summary>
    public sealed class GenexPresetBodyShape
    {
        public double[] Half = new double[3];
        public bool Events;
    }

    /// <summary>The room's <c>physDesc</c> (§17.11 *State*).</summary>
    public sealed class GenexPhysDesc
    {
        /// <summary>The contract's world description (C§4) as the server created the world: handed to the core as it is.</summary>
        public Dictionary<string, object> World;
        public int KeyframeTicks;
        public double MaxLinear, MaxAngular;
        public GenexPresetBodyShape PresetBody;
        public string RemotePredict = GenexRemotePredict.Extrapolate;
        public double RemoteDecayMs = GenexPhysicsKeyframe.DefaultRemoteDecayMs;
        public double LeadMs = GenexPhysicsKeyframe.DefaultLeadMs;

        /// <summary>The world's <c>lengthUnit</c> (1 when it has none).</summary>
        public double LengthUnit => World != null && World.TryGetValue("lengthUnit", out var u) && u is double d ? d : 1;
        /// <summary>The world's <c>limits.worldExtent</c> (C§11's default when it has none).</summary>
        public double WorldExtent
        {
            get
            {
                var limits = GenexJson.Map(World, "limits");
                return limits != null && limits.TryGetValue("worldExtent", out var e) && e is double d ? d : 100000;
            }
        }

        /// <summary>Reads physDesc text; null when it is absent or not one (the reference's parsePhysDesc).</summary>
        public static GenexPhysDesc Parse(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            return GenexJson.TryParse(text, out var raw) ? FromValue(raw) : null;
        }

        /// <summary>A parsed physDesc value (a conformance case's); null when it is not one.</summary>
        public static GenexPhysDesc FromValue(object raw)
        {
            if (!(raw is Dictionary<string, object> o) || !(o.TryGetValue("world", out var w) && w is Dictionary<string, object> world)) return null;
            if (!(o.TryGetValue("keyframeTicks", out var k) && k is double kt && kt == Math.Floor(kt) && kt >= 1 && kt <= int.MaxValue)) return null;
            if (!(o.TryGetValue("maxLinear", out var ml) && ml is double maxLinear && Positive(maxLinear))) return null;
            if (!(o.TryGetValue("maxAngular", out var ma) && ma is double maxAngular && Positive(maxAngular))) return null;
            GenexPresetBodyShape preset = null;
            if (o.TryGetValue("presetBody", out var p) && p is Dictionary<string, object> pb && GenexJson.List(pb, "half") is List<object> half && half.Count == 3
                && half[0] is double h0 && half[1] is double h1 && half[2] is double h2)
            {
                preset = new GenexPresetBodyShape { Half = new[] { h0, h1, h2 }, Events = GenexJson.Bool(pb, "events") };
            }
            var remote = GenexJson.Str(o, "remotePredict");
            if (remote != GenexRemotePredict.Extrapolate && remote != GenexRemotePredict.InputDecay && remote != GenexRemotePredict.Hold) remote = GenexRemotePredict.Extrapolate;
            var decay = o.TryGetValue("remoteDecayMs", out var dv) && dv is double dd && In(dd, 0, GenexPhysicsKeyframe.MaxRemoteDecayMs) ? dd : GenexPhysicsKeyframe.DefaultRemoteDecayMs;
            var lead = o.TryGetValue("leadMs", out var lv) && lv is double ld && In(ld, GenexPhysicsKeyframe.MinLeadMs, GenexPhysicsKeyframe.MaxLeadMs) ? ld : GenexPhysicsKeyframe.DefaultLeadMs;
            return new GenexPhysDesc
            {
                World = world, KeyframeTicks = (int)kt, MaxLinear = maxLinear, MaxAngular = maxAngular, PresetBody = preset,
                RemotePredict = remote, RemoteDecayMs = decay, LeadMs = lead,
            };
        }

        private static bool Positive(double v) => !double.IsNaN(v) && !double.IsInfinity(v) && v > 0;
        private static bool In(double v, double min, double max) => !double.IsNaN(v) && !double.IsInfinity(v) && v >= min && v <= max;
    }

    /// <summary>A seat's last applied input, as a keyframe carries it (AuthorityPlayer's <c>in*</c> fields).</summary>
    public struct GenexRemoteInput
    {
        public double MoveX, MoveY, MoveZ, Yaw, Pitch, Buttons;
    }

    /// <summary>One body as islands see it: its key, origin and bounding radius (room units).</summary>
    public struct GenexIslandBody
    {
        public string Key;
        public double X, Y, Z, Radius;
    }

    /// <summary>A body entity's fields as a decoder holds them (§17.10 *State*, §17.11's <c>rest</c>).</summary>
    public struct GenexWireFields
    {
        public double X, Y, Z, Qx, Qy, Qz, Qw, Lvx, Lvy, Lvz, Avx, Avy, Avz;
        public bool Sleep;
        public double Rest;
    }

    public static class GenexPhysicsKeyframe
    {
        /// <summary>Numbers per body in a wire row (C§20.2).</summary>
        public const int WireRowStride = 15;
        /// <summary>The largest sleep timer a row carries, in inner steps.</summary>
        public const double WireRestMax = 65535;
        /// <summary>Integer steps across a quantized field's symmetric range (2^16 − 2).</summary>
        public const double Span = 65534;
        public const double OrientationMin = -1, OrientationMax = 1;
        public const double VelocityMin = -64, VelocityMax = 64;
        /// <summary>PhysicsPredictRange: the client knobs' defaults and bounds.</summary>
        public const double DefaultRemoteDecayMs = 50, MaxRemoteDecayMs = 1000;
        public const double DefaultLeadMs = 250, MinLeadMs = 50, MaxLeadMs = 1000;
        /// <summary>Islands join bodies whose bounding spheres come within this many metres (× lengthUnit).</summary>
        public const double IslandMarginMetres = 0.5;
        /// <summary>PredictSmoothing (§17.11 *Drawing*).</summary>
        public const double TauSmallMs = 300, TauLargeMs = 100, SmallMetres = 0.25, LargeMetres = 1, SnapPlayerMetres = 2, SnapOtherMetres = 6;
        public static readonly string[] PlayerKinds = { "player", "vehicle" };

        /// <summary>One inner step, as the core computes it: <c>dt / substeps</c> in float32 (C§20.2).</summary>
        public static double InnerDtOf(Dictionary<string, object> world)
        {
            var dt = GenexJson.Num(world, "dt", 1.0 / 60);
            var substeps = GenexJson.Num(world, "substeps", 1);
            return (float)((double)(float)dt / substeps);
        }

        /// <summary>A sleep timer (seconds) in whole inner steps: min(65535, floor(rest / innerDt + 0.5)), 0 for NaN or negative.</summary>
        public static double RestStepsOf(double rest, double innerDt)
        {
            var steps = Math.Floor(rest / innerDt + 0.5);
            if (double.IsNaN(steps) || steps < 0) return 0;
            return Math.Min(steps, WireRestMax);
        }

        /// <summary>The uint16 a quantized field sends for <paramref name="v"/>: out of range clamps, NaN is 0.</summary>
        public static double Quantize(double v, double min, double max)
        {
            if (double.IsNaN(v)) return 0;
            var clamped = v < min ? min : v > max ? max : v;
            return Math.Floor((clamped - min) / (max - min) * Span + 0.5);
        }

        /// <summary>The value a client decodes from the uint16 <paramref name="q"/>, in float64.</summary>
        public static double Dequantize(double q, double min, double max) => min + (q / Span) * (max - min);

        /// <summary>−0 sent as 0 (C§20.2).</summary>
        private static double UnsignedZero(double v) => v == 0 ? 0 : v;

        /// <summary>The wire row of a body entity's decoded fields into <paramref name="row"/> at <paramref name="o"/>.</summary>
        public static void WriteWireRow(GenexWireFields f, double[] row, int o)
        {
            row[o] = UnsignedZero(f.X);
            row[o + 1] = UnsignedZero(f.Y);
            row[o + 2] = UnsignedZero(f.Z);
            row[o + 3] = Quantize(f.Qx, OrientationMin, OrientationMax);
            row[o + 4] = Quantize(f.Qy, OrientationMin, OrientationMax);
            row[o + 5] = Quantize(f.Qz, OrientationMin, OrientationMax);
            row[o + 6] = Quantize(f.Qw, OrientationMin, OrientationMax);
            row[o + 7] = Quantize(f.Lvx, VelocityMin, VelocityMax);
            row[o + 8] = Quantize(f.Lvy, VelocityMin, VelocityMax);
            row[o + 9] = Quantize(f.Lvz, VelocityMin, VelocityMax);
            row[o + 10] = Quantize(f.Avx, VelocityMin, VelocityMax);
            row[o + 11] = Quantize(f.Avy, VelocityMin, VelocityMax);
            row[o + 12] = Quantize(f.Avz, VelocityMin, VelocityMax);
            row[o + 13] = f.Sleep ? 1 : 0;
            row[o + 14] = f.Rest;
        }

        /// <summary>A core export (15 numbers a body) as the wire row the host sends for it.</summary>
        public static void WireRowOfExport(IList<double> d, int o, double lengthUnit, double innerDt, double[] row, int at)
        {
            row[at] = UnsignedZero(d[o]);
            row[at + 1] = UnsignedZero(d[o + 1]);
            row[at + 2] = UnsignedZero(d[o + 2]);
            for (var i = 3; i < 7; i++) row[at + i] = Quantize(d[o + i], OrientationMin, OrientationMax);
            for (var i = 7; i < 10; i++) row[at + i] = Quantize(d[o + i] / lengthUnit, VelocityMin, VelocityMax);
            for (var i = 10; i < 13; i++) row[at + i] = Quantize(d[o + i], VelocityMin, VelocityMax);
            row[at + 13] = d[o + 13] == 1 ? 1 : 0;
            row[at + 14] = RestStepsOf(d[o + 14], innerDt);
        }

        /// <summary>A body state as its wire row (the same numbers <see cref="WireRowOfExport"/> gives for its export).</summary>
        public static double[] WireRowOfState(GenexWireBodyState st, double lengthUnit, double innerDt)
        {
            var row = new double[WireRowStride];
            WireRowOfState(st, lengthUnit, innerDt, new double[WireRowStride], row);
            return row;
        }

        /// <summary><see cref="WireRowOfState(GenexWireBodyState, double, double)"/> into <paramref name="row"/>, with
        /// <paramref name="flat"/> (15 numbers) as its scratch.</summary>
        public static void WireRowOfState(GenexWireBodyState st, double lengthUnit, double innerDt, double[] flat, double[] row)
        {
            Array.Copy(st.P, 0, flat, 0, 3);
            Array.Copy(st.Q, 0, flat, 3, 4);
            Array.Copy(st.V, 0, flat, 7, 3);
            Array.Copy(st.W, 0, flat, 10, 3);
            flat[13] = st.Sleeping ? 1 : 0;
            flat[14] = st.Rest;
            WireRowOfExport(flat, 0, lengthUnit, innerDt, row, 0);
        }

        // ---- the speed clamp (§17.11 step 8a) ----

        private static double[] ClampLength(double[] v, double max)
        {
            var length = Math.Sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
            if (!(length > max)) return null;
            var scale = max / length;
            return new[] { v[0] * scale, v[1] * scale, v[2] * scale };
        }

        /// <summary>
        /// The clamp of one dynamic body's velocities: false (both null) when neither is over its bound, else the setVelocity
        /// arguments that bring the longer ones to it by magnitude, the other as it is (linear at maxLinear · lengthUnit).
        /// </summary>
        public static bool ClampedVelocity(double[] linvel, double[] angvel, double lengthUnit, double maxLinear, double maxAngular, out double[] lin, out double[] ang)
        {
            var v = ClampLength(linvel, maxLinear * lengthUnit);
            var w = ClampLength(angvel, maxAngular);
            if (v == null && w == null)
            {
                // Neither over its bound (the common case, every body every tick): nothing to set, nothing allocated.
                lin = null;
                ang = null;
                return false;
            }
            lin = v ?? new[] { linvel[0], linvel[1], linvel[2] };
            ang = w ?? new[] { angvel[0], angvel[1], angvel[2] };
            return true;
        }

        // ---- shapes by reference (§17.11 *State*) ----

        /// <summary>
        /// A canonical body descriptor parsed, its shapes inlined from <paramref name="shapes"/> (reference → JSON text).
        /// Null when the text is not a descriptor or names a shape <paramref name="shapes"/> lacks.
        /// </summary>
        public static Dictionary<string, object> InlineShapes(string descText, Func<string, string> shapes)
        {
            if (!(GenexJson.TryParse(descText, out var parsed) && parsed is Dictionary<string, object> desc)) return null;
            if (!(GenexJson.List(desc, "colliders") is List<object> colliders)) return null;
            foreach (var c in colliders)
            {
                if (!(c is Dictionary<string, object> collider && collider.TryGetValue("shape", out var s) && s is Dictionary<string, object> shape)) return null;
                if (!shape.TryGetValue("ref", out var refValue)) continue;
                var text = refValue is string r ? shapes(r) : null;
                if (text == null) return null;
                if (!GenexJson.TryParse(text, out var inlined) || inlined == null) return null;
                collider["shape"] = inlined;
            }
            return desc;
        }

        // ---- contact islands by proximity ----

        private static double Length3(object v)
        {
            if (!(v is List<object> l) || l.Count != 3 || !(l[0] is double x) || !(l[1] is double y) || !(l[2] is double z)) return 0;
            return Math.Sqrt(x * x + y * y + z * z);
        }

        private static double Farthest(object points)
        {
            if (!(points is List<object> list)) return 0;
            double m = 0;
            foreach (var p in list) m = Math.Max(m, Length3(p));
            return m;
        }

        private static double ShapeRadius(Dictionary<string, object> shape)
        {
            switch (GenexJson.Str(shape, "kind"))
            {
                case "box": return Length3(shape.TryGetValue("half", out var h) ? h : null);
                case "sphere": return shape.TryGetValue("radius", out var r) && r is double rd ? rd : 0;
                case "capsule":
                    return (shape.TryGetValue("halfHeight", out var hh) && hh is double hhd ? hhd : 0) + (shape.TryGetValue("radius", out var cr) && cr is double crd ? crd : 0);
                case "hull": return Farthest(shape.TryGetValue("points", out var pts) ? pts : null);
                case "trimesh": return Farthest(shape.TryGetValue("vertices", out var vs) ? vs : null);
                case "heightfield": return Length3(shape.TryGetValue("size", out var sz) ? sz : null);
                default: return 0;
            }
        }

        /// <summary>A body's bounding radius about its origin: every collider's offset plus its shape's radius.</summary>
        public static double BodyRadiusOf(Dictionary<string, object> desc)
        {
            double radius = 0;
            if (!(GenexJson.List(desc, "colliders") is List<object> colliders)) return 0;
            foreach (var c in colliders)
            {
                if (!(c is Dictionary<string, object> collider && collider.TryGetValue("shape", out var s) && s is Dictionary<string, object> shape)) continue;
                var offset = collider.TryGetValue("offset", out var off) && off is Dictionary<string, object> om ? Length3(om.TryGetValue("p", out var op) ? op : null) : 0;
                radius = Math.Max(radius, offset + ShapeRadius(shape));
            }
            return radius;
        }

        /// <summary>
        /// Proximity islands: body key → island id (the island's first key in code-unit order). Two bodies are joined when
        /// the distance between their origins is at most the sum of their radii plus <paramref name="margin"/>, or when a
        /// joint links them.
        /// </summary>
        public static Dictionary<string, string> ProximityIslands(IList<GenexIslandBody> bodies, IList<KeyValuePair<string, string>> links, double margin)
        {
            var parent = new Dictionary<string, string>();
            string Find(string k)
            {
                var root = k;
                while (parent[root] != root) root = parent[root];
                var at = k;
                while (at != root)
                {
                    var next = parent[at];
                    parent[at] = root;
                    at = next;
                }
                return root;
            }
            void Join(string a, string b)
            {
                var ra = Find(a);
                var rb = Find(b);
                if (ra == rb) return;
                if (string.CompareOrdinal(ra, rb) < 0) parent[rb] = ra;
                else parent[ra] = rb;
            }
            foreach (var b in bodies) parent[b.Key] = b.Key;
            var sorted = new List<GenexIslandBody>(bodies);
            GenexStableSort.Sort(sorted, (a, b) =>
            {
                var dx = a.X - b.X;
                if (dx != 0 && !double.IsNaN(dx)) return dx < 0 ? -1 : 1;
                return string.CompareOrdinal(a.Key, b.Key) < 0 ? -1 : 1;
            });
            double widest = 0;
            foreach (var b in sorted) widest = Math.Max(widest, b.Radius);
            for (var i = 0; i < sorted.Count; i++)
            {
                var a = sorted[i];
                for (var j = i + 1; j < sorted.Count; j++)
                {
                    var b = sorted[j];
                    if (b.X - a.X > a.Radius + widest + margin) break;
                    var dx = b.X - a.X;
                    var dy = b.Y - a.Y;
                    var dz = b.Z - a.Z;
                    var reach = a.Radius + b.Radius + margin;
                    if (dx * dx + dy * dy + dz * dz <= reach * reach) Join(a.Key, b.Key);
                }
            }
            foreach (var link in links) if (parent.ContainsKey(link.Key) && parent.ContainsKey(link.Value)) Join(link.Key, link.Value);
            var output = new Dictionary<string, string>();
            foreach (var b in bodies) output[b.Key] = Find(b.Key);
            return output;
        }

        // ---- remote players (§17.11 *The client world*) ----

        /// <summary>inputDecay's weight on the j-th tick after the keyframe: clamp(1 − (j − 1) · (1000 / tickHz) / decayMs, 0, 1); decay 0: the first tick only.</summary>
        public static double RemoteInputWeight(double j, double tickHz, double decayMs)
        {
            if (decayMs <= 0) return j <= 1 ? 1 : 0;
            var w = 1 - (j - 1) * (1000 / tickHz) / decayMs;
            if (w <= 0) return 0;
            return w >= 1 ? 1 : w;
        }

        /// <summary>The input a remote seat steps with on the j-th tick: the axes scaled, aim and held buttons as they are.</summary>
        public static GenexRemoteInput DecayedInput(GenexRemoteInput input, double j, double tickHz, double decayMs)
        {
            var w = RemoteInputWeight(j, tickHz, decayMs);
            input.MoveX *= w;
            input.MoveY *= w;
            input.MoveZ *= w;
            return input;
        }

        // ---- drawing corrections (§17.11 *Drawing*) ----

        /// <summary>The share of a correction still drawn <paramref name="age"/> ms after it started, τ
        /// <paramref name="tauMs"/>: critically damped from rest, (1 + age/τ)·e^(−age/τ), so the frame it starts on
        /// draws the body where it was drawn.</summary>
        public static double CorrectionShare(double age, double tauMs)
        {
            var x = Math.Max(age, 0) / tauMs;
            return (1 + x) * Math.Exp(-x);
        }

        /// <summary>A replay's correction of one axis <paramref name="age"/> ms after it started from offset
        /// <paramref name="o0"/> (room units) and rate <paramref name="r0"/> (units per ms), critically damped at τ/2 (§17.11
        /// *Drawing*): the offset, and its rate in <paramref name="rate"/>. A new correction keeps the last one's rate.</summary>
        public static double CorrectionAt(double o0, double r0, double age, double tauMs, out double rate)
        {
            var t = Math.Max(age, 0);
            var h = tauMs / 2;
            var e = Math.Exp(-t / h);
            var c = r0 + o0 / h;
            rate = (r0 - c * t / h) * e;
            return (o0 + c * t) * e;
        }

        /// <summary>The τ (ms) of a correction of <paramref name="metres"/>.</summary>
        public static double CorrectionTauMs(double metres)
        {
            if (metres <= SmallMetres) return TauSmallMs;
            if (metres >= LargeMetres) return TauLargeMs;
            return TauSmallMs + (metres - SmallMetres) / (LargeMetres - SmallMetres) * (TauLargeMs - TauSmallMs);
        }

        /// <summary>The distance, metres, past which a body of physics <paramref name="kind"/> snaps instead of easing.</summary>
        public static double SnapMetresOf(object kind) => kind is string k && Array.IndexOf(PlayerKinds, k) >= 0 ? SnapPlayerMetres : SnapOtherMetres;
    }

    /// <summary>
    /// §17.11 *Drawing* (physics-keyframe.ts DrawHandoff): a body that moves between the predictor's drawing (the client world's
    /// timeline, ahead) and §17.10's (the server's present), because it entered or left the simulated set, starts a correction
    /// from where it was last drawn, eased like a replay's (τ by its size, snapped past its snap distance), so it never jumps by
    /// its velocity times the lead. A new epoch never eases. One per drawn body, kept by the session.
    /// </summary>
    public sealed class GenexDrawHandoff
    {
        private bool hasLast;
        private GenexBodyPose last;
        private bool lastPredicted;
        private double lastEpoch;
        private bool hasOffset;
        private double dpx, dpy, dpz, since, tau;
        private double[] dq = { 0, 0, 0, 1 };

        /// <summary>The pose to draw at room-clock <paramref name="now"/> (ms) for <paramref name="pose"/>, drawn by the
        /// predictor (<paramref name="predicted"/>) or not.</summary>
        public GenexBodyPose Draw(GenexBodyPose pose, bool predicted, double epoch, double now, double snapMetres, double lengthUnit)
        {
            if (!hasLast || lastEpoch != epoch) hasOffset = false;
            else if (lastPredicted != predicted) StartFrom(last, pose, now, snapMetres, lengthUnit);
            var drawn = Apply(pose, now);
            hasLast = true;
            last = drawn;
            lastPredicted = predicted;
            lastEpoch = epoch;
            return drawn;
        }

        private void StartFrom(GenexBodyPose from, GenexBodyPose to, double now, double snapMetres, double lengthUnit)
        {
            double x = from.X - to.X, y = from.Y - to.Y, z = from.Z - to.Z;
            var metres = Math.Sqrt(x * x + y * y + z * z) / lengthUnit;
            if (metres > snapMetres)
            {
                hasOffset = false;
                return;
            }
            var raw = GenexPhysicsPredictor.QuatMul(new[] { from.Q.X, from.Q.Y, from.Q.Z, from.Q.W }, new[] { -to.Q.X, -to.Q.Y, -to.Q.Z, to.Q.W });
            dq = raw[3] < 0 ? new[] { -raw[0], -raw[1], -raw[2], -raw[3] } : raw;
            dpx = x;
            dpy = y;
            dpz = z;
            since = now;
            tau = GenexPhysicsKeyframe.CorrectionTauMs(metres);
            hasOffset = true;
        }

        private GenexBodyPose Apply(GenexBodyPose pose, double now)
        {
            if (!hasOffset) return pose;
            var k = GenexPhysicsKeyframe.CorrectionShare(now - since, tau);
            var q = GenexPhysicsPredictor.QuatMul(GenexPhysicsPredictor.SlerpFromIdentity(dq, k), new[] { pose.Q.X, pose.Q.Y, pose.Q.Z, pose.Q.W });
            return new GenexBodyPose { X = pose.X + dpx * k, Y = pose.Y + dpy * k, Z = pose.Z + dpz * k, Q = new GenexQuat(q[0], q[1], q[2], q[3]) };
        }
    }

    /// <summary>A stable merge sort (List.Sort is not stable; JavaScript's Array.prototype.sort is).</summary>
    internal static class GenexStableSort
    {
        public static void Sort<T>(List<T> list, Comparison<T> compare)
        {
            var n = list.Count;
            if (n < 2) return;
            // The two arrays are this thread's, per element type, grown as needed: a sort allocates nothing in steady state.
            var items = Buffers<T>.Items;
            if (items == null || items.Length < n)
            {
                items = new T[Math.Max(n, 16)];
                Buffers<T>.Items = items;
                Buffers<T>.Tmp = new T[items.Length];
            }
            list.CopyTo(items, 0);
            MergeSort(items, Buffers<T>.Tmp, 0, n, compare);
            for (var i = 0; i < n; i++) list[i] = items[i];
            // Drop the references the buffers still hold (descriptors, keyframes) so they never outlive the list.
            Array.Clear(items, 0, n);
            Array.Clear(Buffers<T>.Tmp, 0, n);
        }

        private static class Buffers<T>
        {
            [ThreadStatic] public static T[] Items;
            [ThreadStatic] public static T[] Tmp;
        }

        private static void MergeSort<T>(T[] a, T[] tmp, int lo, int hi, Comparison<T> compare)
        {
            if (hi - lo < 2) return;
            var mid = (lo + hi) / 2;
            MergeSort(a, tmp, lo, mid, compare);
            MergeSort(a, tmp, mid, hi, compare);
            int i = lo, j = mid, k = lo;
            while (i < mid && j < hi) tmp[k++] = compare(a[j], a[i]) < 0 ? a[j++] : a[i++];
            while (i < mid) tmp[k++] = a[i++];
            while (j < hi) tmp[k++] = a[j++];
            Array.Copy(tmp, lo, a, lo, hi - lo);
        }
    }
}
