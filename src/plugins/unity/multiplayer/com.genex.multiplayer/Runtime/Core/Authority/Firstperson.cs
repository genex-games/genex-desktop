// The `firstperson` movement preset (PROTOCOL.md §17.7), ported from packages/multiplayer/src/authority/presets.ts:
// Source-engine character movement through a static world of boxes and ramps, z up. The authority server moves a
// body with the same step, so the reconciler's prediction matches it by construction, bit for bit.
//
// Determinism rules, as the TypeScript reference keeps them: double arithmetic in the order §17.7 writes it (C#
// evaluates left to right, and every expression here is written as a chain of single operations in that order),
// only + - * / and Math.Sqrt (correctly rounded), no fused multiply-add (the .NET and Mono JITs never contract one;
// an IL2CPP build is compiled with -ffp-contract=off, see the README), and a float32 rounding (Fround, a (float)
// cast) only where §17.7 says so. Held bit for bit to packages/netcode-bench/conformance/authority/presets/
// firstperson.json by Tests~/GenexSmoke `presets` (with and without the broadphase, and inside Unity by
// Tests~/AuthorityProbe), and the broadphase to brute force by `firstperson-diff`.
//
// The broadphase is a static packed bounding-volume tree over the solids' boxes (the TypeScript reference's): it
// only FILTERS. Each helper asks it for the solids whose box, grown by the hull, could meet the helper's own query
// box, gets them back in ascending index, and runs the exact test on each, so a result never depends on it.
// Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>
    /// <c>firstperson</c> parameters (§17.7's table). Real-valued ones are used as float32 by the step; the integer
    /// ones (the button masks, <see cref="Substeps"/> and <see cref="World"/>) exactly.
    /// </summary>
    public struct GenexFirstpersonParams
    {
        /// <summary>Run speed, units/s, before the body's <c>cap</c>.</summary>
        public double MaxSpeed;
        /// <summary>Speed multiplier while walk is held.</summary>
        public double WalkSpeed;
        /// <summary>Speed multiplier while ducking (wins over walk).</summary>
        public double CrouchSpeed;
        public double Accelerate;
        public double AirAccelerate;
        /// <summary>Air wish speed is clamped to this before the projection (what makes air-strafing work).</summary>
        public double AirMaxWishSpeed;
        public double Friction;
        /// <summary>Below this speed friction acts as if at this speed.</summary>
        public double StopSpeed;
        /// <summary>Units/s² along -z.</summary>
        public double Gravity;
        /// <summary>The <c>vz</c> a jump sets.</summary>
        public double JumpImpulse;
        /// <summary>Each velocity axis is clamped to ±this.</summary>
        public double MaxVelocity;
        /// <summary>Half the side of the hull's square footprint.</summary>
        public double Radius;
        public double StandHeight;
        public double CrouchHeight;
        /// <summary>Seconds to duck fully, and to stand back up.</summary>
        public double DuckTime;
        /// <summary>1: a duck can deepen in the air, lifting the feet (a crouch-jump). 0: only on the ground.</summary>
        public int AirDuck;
        /// <summary>Highest ledge walked up without a jump.</summary>
        public double StepHeight;
        /// <summary>Least z of a ramp top's unit normal that can be stood on.</summary>
        public double Standable;
        /// <summary>How far below the feet ground is found.</summary>
        public double GroundTrace;
        /// <summary>How far above the feet ground is found (a hull sunk that far is lifted out).</summary>
        public double GroundSnap;
        /// <summary>Clearance kept from a surface (Source's DIST_EPSILON).</summary>
        public double Skin;
        /// <summary>Largest |pitch|, radians.</summary>
        public double PitchLimit;
        /// <summary>Button masks: any shared bit counts as held; 0 disables.</summary>
        public int JumpBit, DuckBit, WalkBit;
        /// <summary>Sub-steps per step, [1, 8].</summary>
        public int Substeps;
        /// <summary>1: a jump works at <c>cap</c> 0. 0: a press at <c>cap</c> 0 is no jump (a freeze time).</summary>
        public int CapZeroJump;
        /// <summary>Button mask of a run the room owns: while not 0 and not held, speed is <see cref="JogSpeed"/>. 0: every move runs.</summary>
        public int RunBit;
        /// <summary>Speed multiplier without <see cref="RunBit"/> (duck and walk win).</summary>
        public double JogSpeed;
        /// <summary>The collision world's hash (<see cref="GenexFirstpersonWorld.Hash"/>), written by the sandbox.</summary>
        public uint World;
    }

    /// <summary>
    /// The fields a <c>firstperson</c> step reads and writes (it reads <see cref="Cap"/> and never writes it). A NaN
    /// field is "missing", read as the step says: 0 (1 for <see cref="Cap"/>).
    /// </summary>
    public struct GenexFirstpersonBody
    {
        public double X, Y, Z, VX, VY, VZ;
        /// <summary>Aim, radians: stored only.</summary>
        public double Yaw, Pitch;
        /// <summary>0 standing, 1 fully ducked.</summary>
        public double Duck;
        /// <summary><see cref="GenexFirstperson.OnGround"/>, <see cref="GenexFirstperson.Ducking"/> and <see cref="GenexFirstperson.JumpHeld"/> bits.</summary>
        public double Mstate;
        /// <summary>The speed multiplier the module writes (a weapon's or a wound's), [0, 4].</summary>
        public double Cap;
    }

    /// <summary>Why a world was refused: the path of the first bad value (PROTOCOL.md §17.7 <i>World</i>).</summary>
    public sealed class GenexWorldException : ArgumentException
    {
        public string Path { get; }

        public GenexWorldException(string path, string message) : base("firstperson world: " + path + " " + message)
        {
            Path = path;
        }
    }

    /// <summary>
    /// A validated <c>firstperson</c> collision world (§17.7): boxes <c>[minX, minY, minZ, maxX, maxY, maxZ]</c>
    /// and ramps <c>[minX, minY, minZ, maxX, maxY, maxZ, axis, lo, hi]</c>, x/y the ground plane and +z up, every
    /// value a float32. Immutable; build one with <see cref="Create"/>, <see cref="FromJson"/> or
    /// <see cref="FromValue"/> and hand it to <see cref="GenexAuthoritySession.SetWorld"/>.
    /// </summary>
    public sealed class GenexFirstpersonWorld
    {
        public const int MaxBoxes = 32768;
        public const int MaxRamps = 4096;
        /// <summary>Every world value's magnitude.</summary>
        public const double MaxAbs = 1e9;

        /// <summary>The empty world (a body in it falls until z reaches -1e9). Its hash is <see cref="GenexFirstperson.EmptyWorldHash"/>.</summary>
        public static readonly GenexFirstpersonWorld Empty = Create(null, null);

        private readonly double[][] boxes;
        private readonly double[][] ramps;

        /// <summary>32-bit FNV-1a over its counts and values (§17.7): what the room's <c>params.world</c> must equal.</summary>
        public uint Hash { get; }
        /// <summary>Whether the step filters with a bounding-volume tree (results are bit-identical either way).</summary>
        public bool Broadphase { get; }
        public int BoxCount => boxes.Length;
        public int RampCount => ramps.Length;
        /// <summary>A copy of box <paramref name="i"/>: six values.</summary>
        public double[] Box(int i) => (double[])boxes[i].Clone();
        /// <summary>A copy of ramp <paramref name="i"/>: nine values.</summary>
        public double[] Ramp(int i) => (double[])ramps[i].Clone();

        internal readonly Compiled Tables;

        private GenexFirstpersonWorld(double[][] boxes, double[][] ramps, bool broadphase)
        {
            this.boxes = boxes;
            this.ramps = ramps;
            Broadphase = broadphase;
            Hash = HashOf(boxes, ramps);
            Tables = new Compiled(boxes, ramps, broadphase);
        }

        /// <summary>This world with or without the broadphase: the same solids and hash.</summary>
        public GenexFirstpersonWorld WithBroadphase(bool broadphase) =>
            broadphase == Broadphase ? this : new GenexFirstpersonWorld(boxes, ramps, broadphase);

        /// <summary>
        /// Validate and freeze a world. Refused (<see cref="GenexWorldException"/>) unless it has at most 32768 boxes and
        /// 4096 ramps, each exactly six (box) or nine (ramp) numbers, every one a float32 (<c>(float)v == v</c>) of
        /// magnitude at most 1e9, min &lt; max on every axis, and each ramp <c>axis</c> 0 or 1 with <c>minZ ≤ lo</c>,
        /// <c>minZ ≤ hi</c> and <c>maxZ = max(lo, hi)</c>. A null list is none. -0 is read as 0.
        /// </summary>
        public static GenexFirstpersonWorld Create(IEnumerable<double[]> boxes, IEnumerable<double[]> ramps, bool broadphase = true)
        {
            var b = new List<double[]>();
            var r = new List<double[]>();
            if (boxes != null)
                foreach (var box in boxes)
                {
                    if (b.Count >= MaxBoxes) throw new GenexWorldException("boxes", "holds more than " + MaxBoxes);
                    b.Add(Solid(box, 6, "boxes[" + b.Count + "]"));
                }
            if (ramps != null)
                foreach (var ramp in ramps)
                {
                    if (r.Count >= MaxRamps) throw new GenexWorldException("ramps", "holds more than " + MaxRamps);
                    var path = "ramps[" + r.Count + "]";
                    var v = Solid(ramp, 9, path);
                    CheckRamp(v, path);
                    r.Add(v);
                }
            return new GenexFirstpersonWorld(b.ToArray(), r.ToArray(), broadphase);
        }

        /// <summary>A world as JSON text, <c>{"boxes": [[…], …], "ramps": [[…], …]}</c> (a room module's <c>world</c>).</summary>
        public static GenexFirstpersonWorld FromJson(string json, bool broadphase = true)
        {
            if (!GenexJson.TryParse(json, out var value)) throw new GenexWorldException("$", "is not JSON");
            return FromValue(value, broadphase);
        }

        /// <summary>
        /// A world in the package's value model (GenexJson: Dictionary, List, double): an object whose <c>boxes</c> and
        /// <c>ramps</c> are arrays of number arrays. A missing <c>boxes</c> or <c>ramps</c> is none and other keys are
        /// ignored. Anything but an object (null too, as JSON <c>null</c> is refused by the reference) is refused at
        /// <c>$</c>; <see cref="Empty"/> is the empty world. The first bad value is found in the reference's order: the
        /// box list, then each box's values before the next box, then the ramp list and each ramp.
        /// </summary>
        public static GenexFirstpersonWorld FromValue(object spec, bool broadphase = true)
        {
            if (!(spec is IDictionary<string, object> map)) throw new GenexWorldException("$", "is not an object");
            return Create(SolidList(map, "boxes", MaxBoxes, 6), SolidList(map, "ramps", MaxRamps, 9), broadphase);
        }

        // Lazy, so Create checks each solid's values as it reads it and the list's own shape only when it reaches the list.
        private static IEnumerable<double[]> SolidList(IDictionary<string, object> map, string key, int max, int length)
        {
            if (!map.TryGetValue(key, out var raw)) yield break;
            if (!(raw is IList<object> list)) throw new GenexWorldException(key, "is not an array");
            if (list.Count > max) throw new GenexWorldException(key, "holds more than " + max);
            for (var i = 0; i < list.Count; i++)
            {
                var path = key + "[" + i + "]";
                if (!(list[i] is IList<object> values) || values.Count != length)
                    throw new GenexWorldException(path, "is not an array of " + length + " numbers");
                var v = new double[length];
                for (var k = 0; k < length; k++)
                {
                    if (!(values[k] is double d)) throw new GenexWorldException(path + "[" + k + "]", "is not a finite number");
                    v[k] = Value(d, path + "[" + k + "]");
                }
                yield return v;
            }
        }

        private static double[] Solid(double[] raw, int length, string path)
        {
            if (raw == null || raw.Length != length) throw new GenexWorldException(path, "is not an array of " + length + " numbers");
            var v = new double[length];
            for (var i = 0; i < length; i++) v[i] = Value(raw[i], path + "[" + i + "]");
            if (!(v[0] < v[3] && v[1] < v[4] && v[2] < v[5])) throw new GenexWorldException(path, "needs min < max on every axis");
            return v;
        }

        private static double Value(double v, string path)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) throw new GenexWorldException(path, "is not a finite number");
            if ((double)(float)v != v) throw new GenexWorldException(path, "is not a float32");
            if (Math.Abs(v) > MaxAbs) throw new GenexWorldException(path, "is past ±1e9");
            return v == 0 ? 0 : v;
        }

        private static void CheckRamp(double[] v, string path)
        {
            if (v[6] != 0 && v[6] != 1) throw new GenexWorldException(path + "[6]", "is not an axis (0 or 1)");
            double minZ = v[2], maxZ = v[5], lo = v[7], hi = v[8];
            if (!(minZ <= lo && minZ <= hi)) throw new GenexWorldException(path, "needs minZ ≤ lo and minZ ≤ hi");
            if (maxZ != Math.Max(lo, hi)) throw new GenexWorldException(path, "needs maxZ = max(lo, hi)");
        }

        /// <summary>
        /// 32-bit FNV-1a: the box count and the ramp count as little-endian u32, then every box's six values and every
        /// ramp's nine as little-endian binary32 (§17.7), over validated values.
        /// </summary>
        private static uint HashOf(double[][] boxes, double[][] ramps)
        {
            uint hash = 2166136261;
            void Byte(uint b)
            {
                hash ^= b;
                hash = unchecked(hash * 16777619);
            }
            void U32(uint v)
            {
                Byte(v & 0xff);
                Byte((v >> 8) & 0xff);
                Byte((v >> 16) & 0xff);
                Byte(v >> 24);
            }
            U32((uint)boxes.Length);
            U32((uint)ramps.Length);
            foreach (var solids in new[] { boxes, ramps })
                foreach (var solid in solids)
                    foreach (var value in solid)
                        U32(Bits((float)value));
            return hash;
        }

        private static uint Bits(float f) => unchecked((uint)BitConverter.ToInt32(BitConverter.GetBytes(f), 0));

        /// <summary>The step's view of a world: one flat table per field, solids indexed boxes first, and the tree.</summary>
        internal sealed class Compiled
        {
            public readonly int BoxCount, Count;
            public readonly double[] MinX, MinY, MinZ, MaxX, MaxY, MaxZ;
            // Ramps only (indexed by solid index; 0 for a box).
            public readonly byte[] Axis;
            public readonly double[] Lo, Hi, M0, Span, Slope, TopZ;
            public readonly Tree Tree;

            public Compiled(double[][] boxes, double[][] ramps, bool broadphase)
            {
                BoxCount = boxes.Length;
                Count = boxes.Length + ramps.Length;
                MinX = new double[Count]; MinY = new double[Count]; MinZ = new double[Count];
                MaxX = new double[Count]; MaxY = new double[Count]; MaxZ = new double[Count];
                Axis = new byte[Count];
                Lo = new double[Count]; Hi = new double[Count]; M0 = new double[Count];
                Span = new double[Count]; Slope = new double[Count]; TopZ = new double[Count];
                for (var i = 0; i < Count; i++)
                {
                    var s = i < BoxCount ? boxes[i] : ramps[i - BoxCount];
                    MinX[i] = s[0]; MinY[i] = s[1]; MinZ[i] = s[2];
                    MaxX[i] = s[3]; MaxY[i] = s[4]; MaxZ[i] = s[5];
                    if (i < BoxCount) continue;
                    var axis = s[6];
                    var m0 = axis == 0 ? s[0] : s[1];
                    var m1 = axis == 0 ? s[3] : s[4];
                    var span = m1 - m0;
                    var rise = s[8] - s[7];
                    var slope = rise / span;
                    Axis[i] = (byte)axis; Lo[i] = s[7]; Hi[i] = s[8]; M0[i] = m0; Span[i] = span; Slope[i] = slope;
                    var square = slope * slope;
                    var sum = 1 + square;
                    TopZ[i] = 1 / Math.Sqrt(sum);
                }
                Tree = broadphase && Count > 0 ? new Tree(this) : null;
            }
        }

        /// <summary>Children per tree node.</summary>
        internal const int TreeFanout = 8;
        /// <summary>What a tree key multiplies its Morton code by (presets.ts <c>TREE_KEY_RADIX</c>). A world that fitted the old 13 index bits keeps its tree.</summary>
        internal const long TreeKeyRadix = 8388608;

        /// <summary>
        /// The order a broadphase's tree keeps <paramref name="bounds"/> in, leaves first (each six numbers: a box, or a
        /// ramp's box): what every port's tree is held to, at any size (firstperson-large.json).
        /// </summary>
        public static int[] TreeOrder(IReadOnlyList<double[]> bounds)
        {
            var tables = new double[6][];
            for (var k = 0; k < 6; k++)
            {
                tables[k] = new double[bounds.Count];
                for (var i = 0; i < bounds.Count; i++) tables[k][i] = bounds[i][k];
            }
            return Tree.LeafOrder(bounds.Count, tables[0], tables[1], tables[2], tables[3], tables[4], tables[5]);
        }

        /// <summary>
        /// A static packed bounding-volume tree over the solids' boxes, in x, y and z, ordered by the Morton code of each
        /// box's centre (presets.ts <c>buildTree</c>): <see cref="Boxes"/> holds six bounds per entry, the solids first
        /// (in tree order), then each level's nodes up to the root, last. An entry's <see cref="Ref"/> is its solid's
        /// index for a solid, else the position of its first child; a node has at most <see cref="TreeFanout"/>
        /// children, which run to the end of their level at the latest. Memory is linear in the solid count.
        /// </summary>
        internal sealed class Tree
        {
            public readonly double[] Boxes;
            public readonly int[] Ref;
            public readonly int[] LevelEnd;
            public readonly int Root;

            public Tree(Compiled t)
            {
                var n = t.Count;
                var order = LeafOrder(n, t.MinX, t.MinY, t.MinZ, t.MaxX, t.MaxY, t.MaxZ);
                var sizes = new List<int> { n };
                while (sizes[sizes.Count - 1] > 1) sizes.Add((sizes[sizes.Count - 1] + TreeFanout - 1) / TreeFanout);
                var total = 0;
                foreach (var s in sizes) total += s;
                Boxes = new double[total * 6];
                Ref = new int[total];
                LevelEnd = new int[sizes.Count];
                for (var k = 0; k < n; k++)
                {
                    var i = order[k];
                    var o = k * 6;
                    Boxes[o] = t.MinX[i]; Boxes[o + 1] = t.MinY[i]; Boxes[o + 2] = t.MinZ[i];
                    Boxes[o + 3] = t.MaxX[i]; Boxes[o + 4] = t.MaxY[i]; Boxes[o + 5] = t.MaxZ[i];
                    Ref[k] = i;
                }
                LevelEnd[0] = n;
                var from = 0;
                var at = n;
                for (var level = 1; level < sizes.Count; level++)
                {
                    var end = LevelEnd[level - 1];
                    for (var child = from; child < end; child += TreeFanout)
                    {
                        var last = Math.Min(child + TreeFanout, end);
                        double a = double.PositiveInfinity, b = double.PositiveInfinity, c = double.PositiveInfinity;
                        double d = double.NegativeInfinity, e = double.NegativeInfinity, g = double.NegativeInfinity;
                        for (var k = child; k < last; k++)
                        {
                            var ko = k * 6;
                            a = Math.Min(a, Boxes[ko]); b = Math.Min(b, Boxes[ko + 1]); c = Math.Min(c, Boxes[ko + 2]);
                            d = Math.Max(d, Boxes[ko + 3]); e = Math.Max(e, Boxes[ko + 4]); g = Math.Max(g, Boxes[ko + 5]);
                        }
                        var o = at * 6;
                        Boxes[o] = a; Boxes[o + 1] = b; Boxes[o + 2] = c; Boxes[o + 3] = d; Boxes[o + 4] = e; Boxes[o + 5] = g;
                        Ref[at] = child;
                        at++;
                    }
                    from = end;
                    LevelEnd[level] = at;
                }
                Root = total - 1;
            }

            /// <summary>
            /// The tree's leaves: every solid's index, by the Morton code of its box's centre over the world's extent,
            /// ties by index (presets.ts <c>leafOrder</c>).
            /// </summary>
            internal static int[] LeafOrder(int n, double[] minX, double[] minY, double[] minZ, double[] maxX, double[] maxY, double[] maxZ)
            {
                double x0 = double.PositiveInfinity, y0 = double.PositiveInfinity, z0 = double.PositiveInfinity;
                double x1 = double.NegativeInfinity, y1 = double.NegativeInfinity, z1 = double.NegativeInfinity;
                for (var i = 0; i < n; i++)
                {
                    x0 = Math.Min(x0, minX[i]); y0 = Math.Min(y0, minY[i]); z0 = Math.Min(z0, minZ[i]);
                    x1 = Math.Max(x1, maxX[i]); y1 = Math.Max(y1, maxY[i]); z1 = Math.Max(z1, maxZ[i]);
                }
                // A key per solid: its centre's Morton code (10 bits an axis) above its index, so a plain sort
                // orders them and keeps the index.
                var keys = new long[n];
                for (var i = 0; i < n; i++)
                {
                    long cx = Cell((minX[i] + maxX[i]) / 2, x0, x1);
                    long cy = Cell((minY[i] + maxY[i]) / 2, y0, y1);
                    long cz = Cell((minZ[i] + maxZ[i]) / 2, z0, z1);
                    keys[i] = (Spread3(cx) | (Spread3(cy) << 1) | (Spread3(cz) << 2)) * TreeKeyRadix + i;
                }
                Array.Sort(keys);
                var order = new int[n];
                for (var k = 0; k < n; k++) order[k] = (int)(keys[k] % TreeKeyRadix);
                return order;
            }

            private static long Cell(double v, double lo, double hi) =>
                hi > lo ? (long)Math.Min(1023, Math.Floor((v - lo) / (hi - lo) * 1024)) : 0;

            /// <summary><paramref name="v"/>'s low 10 bits spread to every third bit (the Morton code's one axis).</summary>
            private static long Spread3(long v)
            {
                var x = v & 0x3ff;
                x = (x | (x << 16)) & 0x030000ff;
                x = (x | (x << 8)) & 0x0300f00f;
                x = (x | (x << 4)) & 0x030c30c3;
                x = (x | (x << 2)) & 0x09249249;
                return x;
            }
        }
    }

    /// <summary>The <c>firstperson</c> preset (PROTOCOL.md §17.7): its parameters and its step.</summary>
    public static partial class GenexFirstperson
    {
        /// <summary>The preset's name (append-only).</summary>
        public const string Name = "firstperson";
        /// <summary>32-bit FNV-1a of the empty world: two zero counts (§17.7).</summary>
        public const uint EmptyWorldHash = 2615243109;
        /// <summary><c>mstate</c> bits a step keeps.</summary>
        public const int OnGround = 1, Ducking = 2, JumpHeld = 4;
        private const int MstateBits = OnGround | Ducking | JumpHeld;
        private const double MaxAbs = 1e9;

        /// <summary>cs2's defaults, in Source units (about an inch).</summary>
        public static readonly GenexFirstpersonParams Defaults = new GenexFirstpersonParams
        {
            MaxSpeed = 250, WalkSpeed = 0.52, CrouchSpeed = 0.34, Accelerate = 5.5, AirAccelerate = 12, AirMaxWishSpeed = 30,
            Friction = 5.2, StopSpeed = 80, Gravity = 800, JumpImpulse = 301.993, MaxVelocity = 3500, Radius = 16,
            StandHeight = 72, CrouchHeight = 54, DuckTime = 0.4, AirDuck = 1, StepHeight = 18, Standable = 0.7, GroundTrace = 2.5,
            GroundSnap = 1, Skin = 0.03, PitchLimit = 1.5533430576324463, JumpBit = 1, DuckBit = 2, WalkBit = 4, Substeps = 2, CapZeroJump = 1, RunBit = 0, JogSpeed = 1,
            World = EmptyWorldHash,
        };

        private struct Range
        {
            public double Min, Max;
            public bool Positive, Integer;
        }

        private static Range In(double min, double max) => new Range { Min = min, Max = max };
        private static Range AboveZero(double max) => new Range { Min = 0, Max = max, Positive = true };
        private static Range Integer(double min, double max) => new Range { Min = min, Max = max, Integer = true };

        /// <summary>Each parameter's accepted range, in §17.7's table order.</summary>
        private static readonly KeyValuePair<string, Range>[] Ranges =
        {
            new KeyValuePair<string, Range>("maxSpeed", In(0, 10000)),
            new KeyValuePair<string, Range>("walkSpeed", In(0, 1)),
            new KeyValuePair<string, Range>("crouchSpeed", In(0, 1)),
            new KeyValuePair<string, Range>("accelerate", In(0, 1000)),
            new KeyValuePair<string, Range>("airAccelerate", In(0, 1000)),
            new KeyValuePair<string, Range>("airMaxWishSpeed", In(0, 10000)),
            new KeyValuePair<string, Range>("friction", In(0, 1000)),
            new KeyValuePair<string, Range>("stopSpeed", In(0, 10000)),
            new KeyValuePair<string, Range>("gravity", In(0, 100000)),
            new KeyValuePair<string, Range>("jumpImpulse", In(0, 100000)),
            new KeyValuePair<string, Range>("maxVelocity", In(0, 100000)),
            new KeyValuePair<string, Range>("radius", AboveZero(10000)),
            new KeyValuePair<string, Range>("standHeight", AboveZero(10000)),
            new KeyValuePair<string, Range>("crouchHeight", AboveZero(10000)),
            new KeyValuePair<string, Range>("duckTime", AboveZero(100)),
            new KeyValuePair<string, Range>("airDuck", Integer(0, 1)),
            new KeyValuePair<string, Range>("stepHeight", In(0, 10000)),
            new KeyValuePair<string, Range>("standable", In(0, 1)),
            new KeyValuePair<string, Range>("groundTrace", In(0, 10000)),
            new KeyValuePair<string, Range>("groundSnap", In(0, 10000)),
            new KeyValuePair<string, Range>("skin", In(0, 100)),
            new KeyValuePair<string, Range>("pitchLimit", In(0, 1.5707963705062866)),
            new KeyValuePair<string, Range>("jumpBit", Integer(0, 16777215)),
            new KeyValuePair<string, Range>("duckBit", Integer(0, 16777215)),
            new KeyValuePair<string, Range>("walkBit", Integer(0, 16777215)),
            new KeyValuePair<string, Range>("substeps", Integer(1, 8)),
            new KeyValuePair<string, Range>("capZeroJump", Integer(0, 1)),
            new KeyValuePair<string, Range>("runBit", Integer(0, 16777215)),
            new KeyValuePair<string, Range>("jogSpeed", In(0, 1)),
            new KeyValuePair<string, Range>("world", Integer(0, 4294967295)),
        };

        private static bool Accepts(Range range, object value)
        {
            if (!(value is double v) || double.IsNaN(v) || double.IsInfinity(v) || v < range.Min || v > range.Max) return false;
            if (range.Integer && v != Math.Floor(v)) return false;
            // A range that excludes 0 excludes it as the step uses the value: as float32 (1e-46 is 0 there).
            return !range.Positive || (v > 0 && (float)v > 0);
        }

        private static bool TryRange(string key, out Range range)
        {
            foreach (var kv in Ranges)
                if (kv.Key == key)
                {
                    range = kv.Value;
                    return true;
                }
            range = default;
            return false;
        }

        /// <summary>
        /// Whether <paramref name="parameters"/> is acceptable: null, or a JSON object (GenexJson model) whose every key
        /// is one of the table's parameters with a finite number in its range (an integer where the table says so).
        /// </summary>
        public static bool ParamsValid(object parameters)
        {
            if (parameters == null) return true;
            if (!(parameters is IDictionary<string, object> map)) return false;
            foreach (var kv in map)
                if (!TryRange(kv.Key, out var range) || !Accepts(range, kv.Value)) return false;
            return true;
        }

        /// <summary>Parameters from a room's <c>preset.params</c> (GenexJson model): defaults for anything unset or invalid.</summary>
        public static GenexFirstpersonParams ResolveParams(object parameters)
        {
            var p = Defaults;
            if (!(parameters is IDictionary<string, object> map)) return p;
            foreach (var kv in Ranges)
            {
                if (!map.TryGetValue(kv.Key, out var value) || !Accepts(kv.Value, value)) continue;
                var v = (double)value;
                switch (kv.Key)
                {
                    case "maxSpeed": p.MaxSpeed = v; break;
                    case "walkSpeed": p.WalkSpeed = v; break;
                    case "crouchSpeed": p.CrouchSpeed = v; break;
                    case "accelerate": p.Accelerate = v; break;
                    case "airAccelerate": p.AirAccelerate = v; break;
                    case "airMaxWishSpeed": p.AirMaxWishSpeed = v; break;
                    case "friction": p.Friction = v; break;
                    case "stopSpeed": p.StopSpeed = v; break;
                    case "gravity": p.Gravity = v; break;
                    case "jumpImpulse": p.JumpImpulse = v; break;
                    case "maxVelocity": p.MaxVelocity = v; break;
                    case "radius": p.Radius = v; break;
                    case "standHeight": p.StandHeight = v; break;
                    case "crouchHeight": p.CrouchHeight = v; break;
                    case "duckTime": p.DuckTime = v; break;
                    case "airDuck": p.AirDuck = (int)v; break;
                    case "stepHeight": p.StepHeight = v; break;
                    case "standable": p.Standable = v; break;
                    case "groundTrace": p.GroundTrace = v; break;
                    case "groundSnap": p.GroundSnap = v; break;
                    case "skin": p.Skin = v; break;
                    case "pitchLimit": p.PitchLimit = v; break;
                    case "jumpBit": p.JumpBit = (int)v; break;
                    case "duckBit": p.DuckBit = (int)v; break;
                    case "walkBit": p.WalkBit = (int)v; break;
                    case "substeps": p.Substeps = (int)v; break;
                    case "capZeroJump": p.CapZeroJump = (int)v; break;
                    case "runBit": p.RunBit = (int)v; break;
                    case "jogSpeed": p.JogSpeed = v; break;
                    // An exact u32: never rounded through a float32 (it may reach 2^32 - 1).
                    case "world": p.World = (uint)v; break;
                }
            }
            return p;
        }

        /// <summary>
        /// The wish direction in world axes (what <c>moveX</c>/<c>moveY</c> carry) from camera-relative keys under the
        /// view's yaw: <paramref name="forward"/> along the view (+1 forward), <paramref name="right"/> across it (+1 to
        /// the right), <paramref name="yaw"/> in radians counter-clockwise from +x seen from above (+z). The step uses
        /// no trigonometry: the client turns its keys itself, as here.
        /// </summary>
        public static void WishDirection(double forward, double right, double yaw, out double moveX, out double moveY)
        {
            var c = Math.Cos(yaw);
            var s = Math.Sin(yaw);
            moveX = forward * c + right * s;
            moveY = forward * s - right * c;
        }

        // ---------------- the step ----------------

        /// <summary>
        /// What the collision procedures (§17.7: <c>support</c> … <c>stayOnGround</c>) read and write: the world, the
        /// hull's dimensions as float32, its place and velocity, and scratch. <c>firstperson</c> (<see cref="Mover"/>) and
        /// <c>vehicle</c> (Vehicle.cs) step one each; a hull's height is hull(duck) = standHeight + (crouchHeight -
        /// standHeight) · duck (a vehicle hull sets both heights to its <c>height</c> and keeps Duck 0, so that is exactly
        /// <c>height</c>). Reused per thread.
        /// </summary>
        internal class Hull
        {
            public GenexFirstpersonWorld.Compiled W;
            /// <summary>§17.7's unit (<see cref="UnitOf"/>).</summary>
            public double Unit;
            public double R, StandHeight, CrouchHeight, StepHeight, Standable, GroundTrace, GroundSnap, Skin;
            public double X, Y, Z, VX, VY, VZ, Duck;
            public bool OnGround;
            /// <summary>The sub-step's length.</summary>
            public double H;
            // slab / wedge / sweep results
            public double TMin, TMax, NX, NY, NZ;
            public int Ax;
            public double Sg;
            public bool Hit;
            /// <summary>How far inside the solid the hit's point started (§17.7 Starting inside): 0 for a hit on the way in.</summary>
            public double Depth;
            /// <summary>The candidates of the last query, in ascending index; NCand of them (-1: every solid).</summary>
            public int[] Cand = new int[0];
            public int NCand;
            /// <summary>The tick's posed solids (§17.7 <i>Posed solids</i>), indexed after the static ones (<c>W.Count + j</c>).</summary>
            public GenexPosedWorld P = GenexPosedWorld.Empty;
            /// <summary>The posed solids the last query met (their <c>j</c>), <see cref="NPosed"/> of them, in order.</summary>
            public readonly int[] PC = new int[GenexPosedWorld.Max];
            public int NPosed;
            /// <summary>A posed plane's normal and offset (<c>PLANE</c>).</summary>
            public readonly double[] Plane = new double[4];
            public readonly int[] Stack = new int[GenexFirstpersonWorld.TreeFanout * 16];

            /// <summary>Bind the hull to <paramref name="w"/> and clear the sweep scratch.</summary>
            internal void Reset(GenexFirstpersonWorld.Compiled w)
            {
                if (Cand.Length < w.Count) Cand = new int[w.Count];
                W = w;
                H = 0;
                TMin = 0;
                TMax = 0;
                Ax = -1;
                Sg = 0;
                NX = 0;
                NY = 0;
                NZ = 0;
                Hit = false;
                Depth = 0;
                NCand = -1;
                P = GenexPosedWorld.Empty;
                NPosed = 0;
            }
        }

        /// <summary>One firstperson step's working state: the hull, the params as float32 and the movement state.</summary>
        private sealed class Mover : Hull
        {
            public double MaxSpeed, WalkSpeed, CrouchSpeed, Accel, AirAccel, AirMaxWishSpeed, Friction, StopSpeed;
            public double Gravity, JumpImpulse, MaxVelocity, DuckTime, Cap;
            public bool AirDuck;
            public double JogSpeed;
            public bool Jogging;
            public bool Ducking, JumpHeld, Pressed;
            public double DirX, DirY, Amount, Base, WishSpeed;
        }

        [ThreadStatic] private static Mover scratch;

        internal static double F(double v) => (float)v;
        internal static double Unsigned(double v) => v == 0 ? 0 : v;
        internal static double Clamp(double v, double lo, double hi) => v < lo ? lo : v > hi ? hi : v;
        internal static double Min(double a, double b) => a < b ? a : b;
        internal static double Max(double a, double b) => a > b ? a : b;
        internal static bool Finite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        /// <summary>A body field as the step reads it: missing (NaN) or non-finite → <paramref name="fallback"/>, clamped, float32.</summary>
        internal static double BodyValue(double v, double fallback, double lo, double hi) => Unsigned(F(Clamp(Finite(v) ? v : fallback, lo, hi)));

        /// <summary>An angle as the step reads the previous one: missing or non-finite → 0, float32 (never wrapped).</summary>
        internal static double BodyAngle(double v) => Unsigned(F(Finite(v) ? v : 0));

        /// <summary>A query margin: wider than any rounding of the exact tests, so the tree never drops a solid one of them could have reported.</summary>
        private static double QueryMargin(double a, double b, double c, double d, double e, double g) =>
            0.001 + 1e-7 * (Math.Abs(a) + Math.Abs(b) + Math.Abs(c) + Math.Abs(d) + Math.Abs(e) + Math.Abs(g));

        /// <summary>
        /// The solids whose box, grown by the hull's radius on x and y (and the margin on all three), meets
        /// [qx0, qx1] × [qy0, qy1] × [qz0, qz1], in ascending index (every solid, without a tree).
        /// </summary>
        internal static void Query(Hull m, double qx0, double qy0, double qz0, double qx1, double qy1, double qz1)
        {
            QueryPosed(m, qx0, qy0, qz0, qx1, qy1, qz1);
            var tree = m.W.Tree;
            if (tree == null)
            {
                m.NCand = -1;
                return;
            }
            var margin = QueryMargin(qx0, qy0, qz0, qx1, qy1, qz1);
            var pad = m.R + margin;
            // Written so a NaN bound meets every box, never none.
            double x0 = qx0 - pad, x1 = qx1 + pad, y0 = qy0 - pad, y1 = qy1 + pad, z0 = qz0 - margin, z1 = qz1 + margin;
            var boxes = tree.Boxes;
            var refs = tree.Ref;
            var levelEnd = tree.LevelEnd;
            var count = levelEnd[0];
            var cand = m.Cand;
            var stack = m.Stack;
            var n = 0;
            var top = 0;
            stack[top++] = tree.Root;
            while (top > 0)
            {
                var node = stack[--top];
                var o = node * 6;
                if (boxes[o + 3] < x0 || boxes[o] > x1 || boxes[o + 4] < y0 || boxes[o + 1] > y1 || boxes[o + 5] < z0 || boxes[o + 2] > z1) continue;
                if (node < count)
                {
                    cand[n++] = refs[node];
                    continue;
                }
                // A node's children run from its first to TreeFanout on, or to the end of their level.
                var first = refs[node];
                var end = first + GenexFirstpersonWorld.TreeFanout;
                for (var l = 0; l < levelEnd.Length; l++)
                {
                    if (first < levelEnd[l])
                    {
                        if (levelEnd[l] < end) end = levelEnd[l];
                        break;
                    }
                }
                for (var k = first; k < end; k++) stack[top++] = k;
            }
            // Visited in ascending index, as brute force visits them (no allocation: a sort of an int range).
            if (n > 1) Array.Sort(cand, 0, n);
            m.NCand = n;
        }

        internal static int Visits(Hull m) => (m.NCand < 0 ? m.W.Count : m.NCand) + m.NPosed;

        internal static int SolidAt(Hull m, int k)
        {
            var count = m.NCand < 0 ? m.W.Count : m.NCand;
            if (k >= count) return m.W.Count + m.PC[k - count];
            return m.NCand < 0 ? k : m.Cand[k];
        }

        /// <summary>A solid's top under the footprint: a box's or posed solid's flat top, a ramp's support.</summary>
        internal static double TopOf(Hull m, int i, double px, double py)
        {
            var w = m.W;
            if (i < w.BoxCount) return w.MaxZ[i];
            if (i < w.Count) return Support(m, i, px, py);
            return m.P.MaxZ[i - w.Count];
        }

        /// <summary>A solid's bottom.</summary>
        internal static double MinZOf(Hull m, int i) => i < m.W.Count ? m.W.MinZ[i] : m.P.MinZ[i - m.W.Count];

        /// <summary>hull(level) = standHeight + (crouchHeight - standHeight) · level.</summary>
        internal static double HullAt(Hull m, double level)
        {
            var range = m.CrouchHeight - m.StandHeight;
            var part = range * level;
            return m.StandHeight + part;
        }

        /// <summary>support(ramp, px, py): the ramp top's highest z under the footprint.</summary>
        internal static double Support(Hull m, int i, double px, double py)
        {
            var w = m.W;
            var slope = w.Slope[i];
            var u = w.Axis[i] == 0 ? px : py;
            var u2 = slope > 0 ? u + m.R : slope < 0 ? u - m.R : u;
            var along = Clamp(u2 - w.M0[i], 0, w.Span[i]);
            var rise = slope * along;
            return w.Lo[i] + rise;
        }

        /// <summary>overlaps(px, py, solid): the footprint strictly overlaps the solid's on x and y.</summary>
        internal static bool Overlaps(Hull m, int i, double px, double py)
        {
            var w = m.W;
            var r = m.R;
            if (i >= w.Count) return PosedOverlaps(m, i - w.Count, px, py);
            return px + r > w.MinX[i] && px - r < w.MaxX[i] && py + r > w.MinY[i] && py - r < w.MaxY[i];
        }

        /// <summary>fits(px, py, pz, height): no solid overlaps the hull standing at (px, py, pz).</summary>
        internal static bool Fits(Hull m, double px, double py, double pz, double height)
        {
            var w = m.W;
            Query(m, px, py, pz, px, py, pz + height);
            var n = Visits(m);
            for (var k = 0; k < n; k++)
            {
                var i = SolidAt(m, k);
                if (!Overlaps(m, i, px, py) || !(pz + height > MinZOf(m, i))) continue;
                var top = TopOf(m, i, px, py);
                if (pz < top - 0.0001) return false;
            }
            return true;
        }

        /// <summary>
        /// traceDown(px, py, pz, down, up): the highest standable top in [pz - down, pz + up] under the footprint, or
        /// NaN for none (also when a ramp too steep to stand on has a higher top there).
        /// </summary>
        internal static double TraceDown(Hull m, double px, double py, double pz, double down, double up)
        {
            var w = m.W;
            Query(m, px, py, pz - down, px, py, pz + up);
            var n = Visits(m);
            var best = double.NaN;
            var steep = double.NaN;
            var ceiling = pz + up;
            var floor = pz - down;
            for (var k = 0; k < n; k++)
            {
                var i = SolidAt(m, k);
                if (!Overlaps(m, i, px, py)) continue;
                var top = TopOf(m, i, px, py);
                if (!(top <= ceiling && top >= floor)) continue;
                if (i < w.BoxCount || i >= w.Count || w.TopZ[i] >= m.Standable)
                {
                    if (double.IsNaN(best) || top > best) best = top;
                }
                else if (double.IsNaN(steep) || top > steep) steep = top;
            }
            return steep > best ? double.NaN : best;
        }

        /// <summary>checkGround().</summary>
        internal static void CheckGround(Hull m)
        {
            if (m.VZ > 0.1 * m.Unit)
            {
                m.OnGround = false;
                return;
            }
            var g = TraceDown(m, m.X, m.Y, m.Z, m.GroundTrace, m.GroundSnap);
            if (!double.IsNaN(g))
            {
                m.Z = g;
                m.OnGround = true;
            }
            else m.OnGround = false;
        }

        /// <summary>One axis of slab; false = no hit.</summary>
        internal static bool SlabAxis(Hull m, double p, double d, double lo, double hi, int a)
        {
            if (Math.Abs(d) < 0.000000001) return p > lo && p < hi;
            var t1 = (lo - p) / d;
            var t2 = (hi - p) / d;
            var sign = -1.0;
            if (t1 > t2)
            {
                var swap = t1;
                t1 = t2;
                t2 = swap;
                sign = 1;
            }
            if (t1 >= m.TMin)
            {
                m.TMin = t1;
                m.Ax = a;
                m.Sg = sign;
            }
            if (t2 < m.TMax) m.TMax = t2;
            return !(m.TMin > m.TMax);
        }

        /// <summary>
        /// Ramp i's plane `plane` grown by the hull, in wedge's order (x hi, x lo, y hi, y lo, the bottom, the top, the
        /// cap): its normal (not of unit length) and its offset e.
        /// </summary>
        internal static void RampPlane(Hull m, int i, int plane, double height, out double nx, out double ny, out double nz, out double e)
        {
            var w = m.W;
            var r = m.R;
            nx = 0;
            ny = 0;
            nz = 0;
            switch (plane)
            {
                case 0: nx = 1; e = w.MaxX[i] + r; break;
                case 1: nx = -1; e = -w.MinX[i] + r; break;
                case 2: ny = 1; e = w.MaxY[i] + r; break;
                case 3: ny = -1; e = -w.MinY[i] + r; break;
                case 4: nz = -1; e = -w.MinZ[i] + height; break;
                case 5:
                {
                    var slope = w.Slope[i];
                    if (w.Axis[i] == 0) nx = -slope;
                    else ny = -slope;
                    nz = 1;
                    var lift = slope * w.M0[i];
                    var grow = r * Math.Abs(slope);
                    var at = w.Lo[i] - lift;
                    e = at + grow;
                    break;
                }
                default: nz = 1; e = w.MaxZ[i]; break; // the cap
            }
        }

        /// <summary>
        /// inside(px, py, pz, i, height) (§17.7 Starting inside): the point is more than skin inside every face of solid i
        /// grown by the hull (a ramp's seven planes, each depth -dist / |n|, as Wedge computes it).
        /// </summary>
        internal static bool Inside(Hull m, double px, double py, double pz, int i, double height)
        {
            var w = m.W;
            var r = m.R;
            var skin = m.Skin;
            if (i >= w.Count) return PosedInside(m, px, py, pz, i - w.Count, height);
            if (i < w.BoxCount)
            {
                var lx = px - (w.MinX[i] - r);
                var hx = w.MaxX[i] + r - px;
                var ly = py - (w.MinY[i] - r);
                var hy = w.MaxY[i] + r - py;
                var lz = pz - (w.MinZ[i] - height);
                var hz = w.MaxZ[i] - pz;
                return lx > skin && hx > skin && ly > skin && hy > skin && lz > skin && hz > skin;
            }
            for (var plane = 0; plane < 7; plane++)
            {
                RampPlane(m, i, plane, height, out var nx, out var ny, out var nz, out var e);
                var ox = nx * px;
                var oy = ny * py;
                var oz = nz * pz;
                var dist = ox + oy + oz - e;
                var nn = Dot(nx, ny, nz, nx, ny, nz);
                var inv = 1 / Math.Sqrt(nn);
                var depth = -dist * inv;
                if (!(depth > skin)) return false;
            }
            return true;
        }

        /// <summary>
        /// covered(q, p, self) (§17.7 Starting inside): a solid but self has q (the point pushed out through a face of self
        /// that points up) inside it and not p, so that face is no way out. Only a solid whose box grown by the hull holds q can
        /// answer, so the tree bounds it: a boolean of a set, the same with every witness kept. Its stack is the query's: a query's
        /// walk is over by the time its candidates are read.
        /// </summary>
        internal static bool Covered(Hull m, double qx, double qy, double qz, double px, double py, double pz, int self, double height)
        {
            var count = m.W.Count;
            var tree = m.W.Tree;
            if (tree == null)
            {
                for (var j = 0; j < count; j++)
                {
                    if (j != self && Inside(m, qx, qy, qz, j, height) && !Inside(m, px, py, pz, j, height)) return true;
                }
            }
            else
            {
                var margin = QueryMargin(qx, qy, qz, qx, qy, qz + height);
                var pad = m.R + margin;
                // Written so a NaN bound meets every box, never none.
                double x0 = qx - pad, x1 = qx + pad, y0 = qy - pad, y1 = qy + pad, z0 = qz - margin, z1 = qz + height + margin;
                var boxes = tree.Boxes;
                var refs = tree.Ref;
                var levelEnd = tree.LevelEnd;
                var leaves = levelEnd[0];
                var stack = m.Stack;
                var top = 0;
                stack[top++] = tree.Root;
                while (top > 0)
                {
                    var node = stack[--top];
                    var o = node * 6;
                    if (boxes[o + 3] < x0 || boxes[o] > x1 || boxes[o + 4] < y0 || boxes[o + 1] > y1 || boxes[o + 5] < z0 || boxes[o + 2] > z1) continue;
                    if (node < leaves)
                    {
                        var j = refs[node];
                        if (j != self && Inside(m, qx, qy, qz, j, height) && !Inside(m, px, py, pz, j, height)) return true;
                        continue;
                    }
                    // A node's children run from its first to TreeFanout on, or to the end of their level.
                    var first = refs[node];
                    var end = first + GenexFirstpersonWorld.TreeFanout;
                    for (var l = 0; l < levelEnd.Length; l++)
                    {
                        if (first < levelEnd[l])
                        {
                            if (levelEnd[l] < end) end = levelEnd[l];
                            break;
                        }
                    }
                    for (var k = first; k < end; k++) stack[top++] = k;
                }
            }
            for (var q = count; q < count + m.P.Count; q++)
            {
                if (q != self && Inside(m, qx, qy, qz, q, height) && !Inside(m, px, py, pz, q, height)) return true;
            }
            return false;
        }

        /// <summary>A ramp's face that points up: Covered of the point pushed out along its unit normal u by depth.</summary>
        static bool LidCovered(Hull m, double px, double py, double pz, double ux, double uy, double uz, double depth, int i, double height)
        {
            var sx = ux * depth;
            var sy = uy * depth;
            var sz = uz * depth;
            return Covered(m, px + sx, py + sy, pz + sz, px, py, pz, i, height);
        }

        /// <summary>
        /// slab's Starting inside: a point more than skin inside box i grown by the hull, on all six faces, is a hit at 0
        /// on the least deep of the five faces it is pushed out through (x, then y, then the top; the low face before the
        /// high one; a tie keeps the earlier; never the bottom, nor a covered top), Depth that face's.
        /// </summary>
        internal static bool SlabInside(Hull m, double px, double py, double pz, int i, double height)
        {
            var w = m.W;
            return SlabInside(m, px, py, pz, w.MinX[i], w.MinY[i], w.MinZ[i], w.MaxX[i], w.MaxY[i], w.MaxZ[i], i, height);
        }

        /// <summary>SlabInside over a box given by its bounds (<paramref name="self"/>: its index among all solids, for Covered).</summary>
        internal static bool SlabInside(Hull m, double px, double py, double pz, double minX, double minY, double minZ, double maxX, double maxY, double maxZ, int self, double height)
        {
            var r = m.R;
            var skin = m.Skin;
            var lx = px - (minX - r);
            var hx = maxX + r - px;
            var ly = py - (minY - r);
            var hy = maxY + r - py;
            var lz = pz - (minZ - height);
            var hz = maxZ - pz;
            if (!(lx > skin && hx > skin && ly > skin && hy > skin && lz > skin && hz > skin)) return false;
            double depth = lx, nx = -1, ny = 0, nz = 0;
            if (hx < depth) { depth = hx; nx = 1; ny = 0; nz = 0; }
            if (ly < depth) { depth = ly; nx = 0; ny = -1; nz = 0; }
            if (hy < depth) { depth = hy; nx = 0; ny = 1; nz = 0; }
            if (hz < depth && !Covered(m, px, py, pz + hz, px, py, pz, self, height)) { depth = hz; nx = 0; ny = 0; nz = 1; }
            m.TMin = 0;
            m.NX = nx;
            m.NY = ny;
            m.NZ = nz;
            m.Depth = depth;
            return true;
        }

        /// <summary>slab(...): a point against box i grown by the hull; on a hit, TMin, the normal and Depth.</summary>
        internal static bool Slab(Hull m, double px, double py, double pz, double dx, double dy, double dz, int i, double height)
        {
            var w = m.W;
            return Slab(m, px, py, pz, dx, dy, dz, w.MinX[i], w.MinY[i], w.MinZ[i], w.MaxX[i], w.MaxY[i], w.MaxZ[i], i, height);
        }

        /// <summary>Slab over a box given by its bounds (<paramref name="self"/>: its index among all solids).</summary>
        internal static bool Slab(Hull m, double px, double py, double pz, double dx, double dy, double dz, double minX, double minY, double minZ, double maxX, double maxY, double maxZ, int self, double height)
        {
            var r = m.R;
            m.Depth = 0;
            if (SlabInside(m, px, py, pz, minX, minY, minZ, maxX, maxY, maxZ, self, height)) return true;
            m.TMin = 0;
            m.TMax = 1;
            m.Ax = -1;
            m.Sg = 0;
            if (!SlabAxis(m, px, dx, minX - r, maxX + r, 0)) return false;
            if (!SlabAxis(m, py, dy, minY - r, maxY + r, 1)) return false;
            if (!SlabAxis(m, pz, dz, minZ - height, maxZ, 2)) return false;
            if (m.TMin >= 1 || m.Ax < 0) return false;
            m.NX = m.Ax == 0 ? m.Sg : 0;
            m.NY = m.Ax == 1 ? m.Sg : 0;
            m.NZ = m.Ax == 2 ? m.Sg : 0;
            return true;
        }

        /// <summary>
        /// wedge(...): a point against ramp i grown by the hull, plane by plane; on a hit, TMin (its enter), the normal and
        /// Depth. A point more than skin inside every plane (Starting inside) is a hit at 0 on the least deep plane but the
        /// bottom and a covered top or cap (a tie keeps the earlier plane); no plane test stops such a point early, so the depths are gathered along
        /// the way.
        /// </summary>
        internal static bool Wedge(Hull m, double px, double py, double pz, double dx, double dy, double dz, int i, double height)
        {
            var enter = 0.0;
            var leave = 1.0;
            var taken = false;
            var inside = true;
            var least = double.PositiveInfinity;
            double lx = 0, ly = 0, lz = 0;
            m.Depth = 0;
            for (var plane = 0; plane < 7; plane++)
            {
                RampPlane(m, i, plane, height, out var nx, out var ny, out var nz, out var e);
                var ox = nx * px;
                var oy = ny * py;
                var oz = nz * pz;
                var dist = ox + oy + oz - e;
                var mx = nx * dx;
                var my = ny * dy;
                var mz = nz * dz;
                var motion = mx + my + mz;
                var nn = Dot(nx, ny, nz, nx, ny, nz);
                var inv = 1 / Math.Sqrt(nn);
                var depth = -dist * inv;
                if (!(depth > m.Skin)) inside = false;
                // The top and the cap point up: the way out only when no other solid covers them.
                else if (plane != 4 && depth < least && !(inside && plane >= 5 && LidCovered(m, px, py, pz, nx * inv, ny * inv, nz * inv, depth, i, height)))
                {
                    least = depth;
                    lx = nx * inv;
                    ly = ny * inv;
                    lz = nz * inv;
                }
                if (Math.Abs(motion) < 0.000000001)
                {
                    if (dist > 0) return false;
                    continue;
                }
                // Touching: a plane the point starts on or at most skin behind is entered at once.
                var t = motion < 0 && dist <= 0 && dist > -m.Skin ? 0 : -dist / motion;
                if (motion < 0)
                {
                    if (t >= enter)
                    {
                        enter = t;
                        m.NX = nx * inv;
                        m.NY = ny * inv;
                        m.NZ = nz * inv;
                        taken = true;
                    }
                }
                else leave = Min(leave, t);
                if (enter > leave) return false;
            }
            if (inside)
            {
                m.TMin = 0;
                m.NX = lx;
                m.NY = ly;
                m.NZ = lz;
                m.Depth = least;
                return true;
            }
            if (!taken || !(enter < 1) || !(leave >= 0)) return false;
            m.TMin = enter;
            return true;
        }

        /// <summary>
        /// sweep(px, py, pz, dx, dy, dz): the first solid the hull meets along the move, chosen on each hit's raw t (a
        /// tie to the lower index); TMin is then the winner's fraction max(0, t - 0.0001), with Hit and its normal, or 1.
        /// </summary>
        internal static void Sweep(Hull m, double px, double py, double pz, double dx, double dy, double dz)
        {
            var w = m.W;
            var height = HullAt(m, m.Duck);
            var ex = px + dx;
            var ey = py + dy;
            var ez = pz + dz;
            Query(m, px < ex ? px : ex, py < ey ? py : ey, pz < ez ? pz : ez, px < ex ? ex : px, py < ey ? ey : py, (pz < ez ? ez : pz) + height);
            var n = Visits(m);
            var found = false;
            var bestT = 0.0;
            var bestI = 0;
            double bnx = 0, bny = 0, bnz = 0, bd = 0;
            for (var k = 0; k < n; k++)
            {
                var i = SolidAt(m, k);
                var hit = i < w.BoxCount ? Slab(m, px, py, pz, dx, dy, dz, i, height) : i < w.Count ? Wedge(m, px, py, pz, dx, dy, dz, i, height) : PosedSweep(m, px, py, pz, dx, dy, dz, i, height);
                if (hit && (!found || m.TMin < bestT || (m.TMin == bestT && i < bestI)))
                {
                    found = true;
                    bestT = m.TMin;
                    bestI = i;
                    bnx = m.NX;
                    bny = m.NY;
                    bnz = m.NZ;
                    bd = m.Depth;
                }
            }
            m.Hit = found;
            if (found)
            {
                m.TMin = Max(0, bestT - 0.0001);
                m.NX = bnx;
                m.NY = bny;
                m.NZ = bnz;
                m.Depth = bd;
            }
            else
            {
                m.TMin = 1;
                m.Depth = 0;
            }
        }

        internal static double Dot(double ax, double ay, double az, double bx, double by, double bz)
        {
            var x = ax * bx;
            var y = ay * by;
            var z = az * bz;
            return x + y + z;
        }

        /// <summary>
        /// slideMove(T): move along the velocity, clipping it against what the hull hits, up to four times. With
        /// <paramref name="car"/>, <c>vehicle</c>'s ground slide (§17.7): a face the car can drive on lifts the velocity
        /// onto it (its horizontal part kept), and a face too steep to drive on is a wall (its normal made level).
        /// </summary>
        internal static void SlideMove(Hull m, double T, bool car = false)
        {
            var remaining = T;
            var hasPrev = false;
            double qx = 0, qy = 0, qz = 0;
            for (var bump = 0; bump < 4 && remaining > 0.000001; bump++)
            {
                if (Dot(m.VX, m.VY, m.VZ, m.VX, m.VY, m.VZ) < 0.00000001) return;
                Sweep(m, m.X, m.Y, m.Z, m.VX * remaining, m.VY * remaining, m.VZ * remaining);
                var t = m.TMin;
                if (t > 0)
                {
                    var used = t * remaining;
                    m.X = m.X + m.VX * used;
                    m.Y = m.Y + m.VY * used;
                    m.Z = m.Z + m.VZ * used;
                    remaining = remaining - used;
                }
                if (!m.Hit) return;
                if (m.Depth > 0)
                {
                    // Started inside the solid: out through its face first (the face as hit, before the ground slide
                    // levels it), then the skin as for any hit.
                    m.X = m.X + m.NX * m.Depth;
                    m.Y = m.Y + m.NY * m.Depth;
                    m.Z = m.Z + m.NZ * m.Depth;
                }
                double nx = m.NX, ny = m.NY, nz = m.NZ;
                var lift = false;
                if (car && nz > 0)
                {
                    if (nz >= m.Standable) lift = true;
                    else
                    {
                        // Too steep to drive on: a wall, its normal made level.
                        var level = nx * nx + ny * ny;
                        var k = 1 / Math.Sqrt(level);
                        nx = nx * k;
                        ny = ny * k;
                        nz = 0;
                    }
                }
                m.X = m.X + nx * m.Skin;
                m.Y = m.Y + ny * m.Skin;
                m.Z = m.Z + nz * m.Skin;
                var into = Dot(m.VX, m.VY, m.VZ, nx, ny, nz);
                if (into < 0)
                {
                    if (lift)
                    {
                        // Lifted onto a drivable face, vx and vy unchanged: the climb costs no horizontal speed.
                        var rise = into / nz;
                        m.VZ = m.VZ - rise;
                    }
                    else
                    {
                        var push = -into;
                        m.VX = m.VX + nx * push;
                        m.VY = m.VY + ny * push;
                        m.VZ = m.VZ + nz * push;
                    }
                }
                if (hasPrev)
                {
                    // The crease: q × n.
                    var cx = qy * nz - qz * ny;
                    var cy = qz * nx - qx * nz;
                    var cz = qx * ny - qy * nx;
                    var L = Dot(cx, cy, cz, cx, cy, cz);
                    if (L > 0.000001)
                    {
                        var inv = 1 / Math.Sqrt(L);
                        cx = cx * inv;
                        cy = cy * inv;
                        cz = cz * inv;
                        var along = Dot(m.VX, m.VY, m.VZ, cx, cy, cz);
                        m.VX = cx * along;
                        m.VY = cy * along;
                        m.VZ = cz * along;
                    }
                }
                hasPrev = true;
                qx = nx;
                qy = ny;
                qz = nz;
                if (Dot(m.VX, m.VY, m.VZ, m.VX, m.VY, m.VZ) < 0.00000001) return;
            }
        }

        /// <summary>§17.7's unit: the hull against its preset's default radius when that is under a half (a game in other units),
        /// else 1 (a room in the defaults' units with its own hull).</summary>
        internal static double UnitOf(double radius, double defaultRadius)
        {
            var unit = radius / defaultRadius;
            return unit < 0.5 ? unit : 1.0;
        }

        /// <summary>groundMove(): the plain slide, or the same slide from a ledge's height when that goes further (each slide
        /// <c>vehicle</c>'s ground slide with <paramref name="car"/>).</summary>
        internal static void GroundMove(Hull m, bool car = false)
        {
            double x0 = m.X, y0 = m.Y, z0 = m.Z;
            double vx0 = m.VX, vy0 = m.VY, vz0 = m.VZ;
            SlideMove(m, m.H, car);
            double x1 = m.X, y1 = m.Y, z1 = m.Z;
            double vx1 = m.VX, vy1 = m.VY, vz1 = m.VZ;
            var ax = x1 - x0;
            var ay = y1 - y0;
            var flat = ax * ax + ay * ay;
            m.X = x0; m.Y = y0; m.Z = z0;
            m.VX = vx0; m.VY = vy0; m.VZ = vz0;
            var lift = m.StepHeight + m.Skin;
            Sweep(m, x0, y0, z0, 0, 0, lift);
            var t = m.TMin;
            var zl = z0 + lift * t;
            if (t > 0 && Fits(m, x0, y0, zl, HullAt(m, m.Duck)))
            {
                m.Z = zl;
                SlideMove(m, m.H, car);
                var g = TraceDown(m, m.X, m.Y, m.Z, m.StepHeight * 2, 0.001);
                if (!double.IsNaN(g)) m.Z = g;
                var bx = m.X - x0;
                var by = m.Y - y0;
                var stepped = bx * bx + by * by;
                if (!double.IsNaN(g) && stepped > flat + 0.001 * m.Unit * m.Unit)
                {
                    m.VZ = 0;
                    return;
                }
            }
            m.X = x1; m.Y = y1; m.Z = z1;
            m.VX = vx1; m.VY = vy1; m.VZ = vz1;
        }

        /// <summary>stayOnGround(): Source's StayOnGround, down to stepHeight below the feet.</summary>
        internal static void StayOnGround(Hull m)
        {
            var g = TraceDown(m, m.X, m.Y, m.Z, m.StepHeight, m.GroundSnap);
            if (!double.IsNaN(g))
            {
                m.Z = g;
                m.VZ = 0;
            }
        }

        /// <summary>friction().</summary>
        private static void ApplyFriction(Mover m)
        {
            var speed = Math.Sqrt(m.VX * m.VX + m.VY * m.VY);
            if (speed < 0.1 * m.Unit)
            {
                m.VX = 0;
                m.VY = 0;
                return;
            }
            var control = speed < m.StopSpeed ? m.StopSpeed : speed;
            var drop = control * m.Friction * m.H;
            var keep = Max(0, speed - drop) / speed;
            m.VX = m.VX * keep;
            m.VY = m.VY * keep;
        }

        /// <summary>accelerate().</summary>
        private static void GroundAccelerate(Mover m)
        {
            var add = m.WishSpeed - (m.VX * m.DirX + m.VY * m.DirY);
            if (add <= 0) return;
            // maxSpeed, not base: cap never weakens the push.
            var a = m.Accel * m.H * Max(m.WishSpeed, m.MaxSpeed);
            if (a > add) a = add;
            m.VX = m.VX + a * m.DirX;
            m.VY = m.VY + a * m.DirY;
        }

        /// <summary>airAccelerate().</summary>
        private static void AirAccelerate(Mover m)
        {
            var add = Min(m.WishSpeed, m.AirMaxWishSpeed) - (m.VX * m.DirX + m.VY * m.DirY);
            if (add <= 0) return;
            var a = m.AirAccel * m.WishSpeed * m.H;
            if (a > add) a = add;
            m.VX = m.VX + a * m.DirX;
            m.VY = m.VY + a * m.DirY;
        }

        /// <summary>A sub-step's stored value: clamped to ±1e9, float32, -0 as 0.</summary>
        internal static double Stored(double v) => Unsigned(F(Clamp(v, -MaxAbs, MaxAbs)));

        /// <summary>One sub-step (§17.7's nine). m.Pressed is the input's jump edge, spent by a jump.</summary>
        private static void SubStep(Mover m, bool duckDown, bool walk)
        {
            // 1. duck()
            var rate = m.H / m.DuckTime;
            if (duckDown && !m.OnGround && !m.AirDuck)
            {
                // The hold stays as it is: no duck starts or deepens in the air.
            }
            else if (duckDown)
            {
                var next = Min(1, m.Duck + rate);
                // In the air the hull shrinks from below: its top stays put.
                if (!m.OnGround) m.Z = m.Z + (HullAt(m, m.Duck) - HullAt(m, next));
                m.Duck = next;
                m.Ducking = true;
            }
            else if (m.Duck > 0)
            {
                var next = Max(0, m.Duck - rate);
                var zn = m.OnGround ? m.Z : m.Z - (HullAt(m, next) - HullAt(m, m.Duck));
                if (Fits(m, m.X, m.Y, zn, HullAt(m, next)))
                {
                    m.Duck = next;
                    m.Z = zn;
                    if (m.Duck == 0) m.Ducking = false;
                }
            }
            // 2.
            var was = m.OnGround;
            CheckGround(m);
            if (m.OnGround && !was) m.VZ = 0;
            // 3.
            m.Base = m.MaxSpeed * m.Cap;
            var target = m.Ducking ? m.Base * m.CrouchSpeed : walk ? m.Base * m.WalkSpeed : m.Jogging ? m.Base * m.JogSpeed : m.Base;
            m.WishSpeed = m.Amount * target;
            // 4.
            if (m.OnGround)
            {
                if (m.Pressed)
                {
                    m.VZ = m.JumpImpulse;
                    m.OnGround = false;
                    m.Pressed = false;
                    AirAccelerate(m);
                }
                else
                {
                    ApplyFriction(m);
                    GroundAccelerate(m);
                    m.VZ = 0;
                }
            }
            else AirAccelerate(m);
            // 5.
            var falling = !m.OnGround;
            if (falling) m.VZ = m.VZ - m.Gravity * m.H * 0.5;
            // 6.
            m.VX = Clamp(m.VX, -m.MaxVelocity, m.MaxVelocity);
            m.VY = Clamp(m.VY, -m.MaxVelocity, m.MaxVelocity);
            m.VZ = Clamp(m.VZ, -m.MaxVelocity, m.MaxVelocity);
            // 7.
            if (m.OnGround)
            {
                GroundMove(m);
                StayOnGround(m);
            }
            else SlideMove(m, m.H);
            // 8.
            CheckGround(m);
            if (falling && !m.OnGround) m.VZ = m.VZ - m.Gravity * m.H * 0.5;
            else if (m.OnGround) m.VZ = 0;
            // 9.
            m.X = Stored(m.X);
            m.Y = Stored(m.Y);
            m.Z = Stored(m.Z);
            m.VX = Stored(m.VX);
            m.VY = Stored(m.VY);
            m.VZ = Stored(m.VZ);
            m.Duck = Unsigned(F(m.Duck));
        }

        /// <summary>
        /// One fixed <c>firstperson</c> step (§17.7) through <paramref name="world"/> (null: the empty world). Pure:
        /// returns the next body; the body's <c>Cap</c> is read and returned unchanged. <paramref name="world"/> must be
        /// the world whose hash is <c>p.World</c> for the result to be the server's; the step does not compare them.
        /// A NaN input field is "unusable", like an absent one in the TypeScript reference: an axis 0, an angle the
        /// previous one, buttons 0. The input is used exactly as handed (the session hands it the §17.3-sanitized one).
        /// </summary>
        public static GenexFirstpersonBody Step(
            GenexFirstpersonBody body, double moveX, double moveY, double yaw, double pitch, double buttons, double dt,
            GenexFirstpersonParams p, GenexFirstpersonWorld world = null, GenexPosedWorld posed = null)
        {
            var w = (world ?? GenexFirstpersonWorld.Empty).Tables;
            var m = scratch ?? (scratch = new Mover());
            if (m.Cand.Length < w.Count) m.Cand = new int[w.Count];
            m.W = w;
            m.P = posed ?? GenexPosedWorld.Empty;
            m.NPosed = 0;
            m.MaxSpeed = F(p.MaxSpeed);
            m.WalkSpeed = F(p.WalkSpeed);
            m.CrouchSpeed = F(p.CrouchSpeed);
            m.Accel = F(p.Accelerate);
            m.AirAccel = F(p.AirAccelerate);
            m.AirMaxWishSpeed = F(p.AirMaxWishSpeed);
            m.Friction = F(p.Friction);
            m.StopSpeed = F(p.StopSpeed);
            m.Gravity = F(p.Gravity);
            m.JumpImpulse = F(p.JumpImpulse);
            m.MaxVelocity = F(p.MaxVelocity);
            m.R = F(p.Radius);
            m.Unit = UnitOf(m.R, 16.0);
            m.StandHeight = F(p.StandHeight);
            m.CrouchHeight = F(p.CrouchHeight);
            m.DuckTime = F(p.DuckTime);
            m.AirDuck = p.AirDuck != 0;
            m.JogSpeed = F(p.JogSpeed);
            m.StepHeight = F(p.StepHeight);
            m.Standable = F(p.Standable);
            m.GroundTrace = F(p.GroundTrace);
            m.GroundSnap = F(p.GroundSnap);
            m.Skin = F(p.Skin);
            m.X = BodyValue(body.X, 0, -MaxAbs, MaxAbs);
            m.Y = BodyValue(body.Y, 0, -MaxAbs, MaxAbs);
            m.Z = BodyValue(body.Z, 0, -MaxAbs, MaxAbs);
            m.VX = BodyValue(body.VX, 0, -MaxAbs, MaxAbs);
            m.VY = BodyValue(body.VY, 0, -MaxAbs, MaxAbs);
            m.VZ = BodyValue(body.VZ, 0, -MaxAbs, MaxAbs);
            m.Duck = BodyValue(body.Duck, 0, 0, 1);
            m.Cap = BodyValue(body.Cap, 1, 0, 4);
            var mstate = (int)GenexPresets.Mask(body.Mstate) & MstateBits;
            m.OnGround = (mstate & OnGround) != 0;
            m.Ducking = (mstate & Ducking) != 0;
            m.JumpHeld = (mstate & JumpHeld) != 0;
            m.Pressed = false;
            m.H = 0;
            m.DirX = 0;
            m.DirY = 0;
            m.Amount = 0;
            m.Base = 0;
            m.WishSpeed = 0;
            m.TMin = 0;
            m.TMax = 0;
            m.Ax = -1;
            m.Sg = 0;
            m.NX = 0;
            m.NY = 0;
            m.NZ = 0;
            m.Hit = false;
            m.NCand = -1;
            // 1. The wish direction, in world axes.
            var mx = GenexPresets.Axis(moveX);
            var my = GenexPresets.Axis(moveY);
            var len = Math.Sqrt(mx * mx + my * my);
            if (len > 0.0001)
            {
                m.DirX = mx / len;
                m.DirY = my / len;
                m.Amount = Min(len, 1);
            }
            // 2.
            var held = (int)GenexPresets.Mask(buttons);
            var jump = (held & p.JumpBit) != 0;
            var duckDown = (held & p.DuckBit) != 0;
            var walk = (held & p.WalkBit) != 0;
            m.Jogging = p.RunBit != 0 && (held & p.RunBit) == 0;
            // 3.
            var step = GenexPresets.StepSeconds(dt, GenexPresets.MaxDtSeconds);
            var substeps = p.Substeps < 1 ? 1 : p.Substeps;
            m.H = step / substeps;
            // 4.
            var nextYaw = GenexPresets.WrappedAngle(yaw) ?? BodyAngle(body.Yaw);
            var pitchLimit = F(p.PitchLimit);
            var nextPitch = Unsigned(Clamp(GenexPresets.WrappedAngle(pitch) ?? BodyAngle(body.Pitch), -pitchLimit, pitchLimit));
            // 5. The jump edge, once per input, then the sub-steps.
            if (step > 0)
            {
                m.Pressed = jump && !m.JumpHeld && (p.CapZeroJump != 0 || m.Cap != 0);
                m.JumpHeld = jump;
                for (var i = 0; i < substeps; i++) SubStep(m, duckDown, walk);
            }
            // 6.
            var result = new GenexFirstpersonBody
            {
                X = m.X, Y = m.Y, Z = m.Z, VX = m.VX, VY = m.VY, VZ = m.VZ,
                Yaw = nextYaw, Pitch = nextPitch, Duck = m.Duck,
                Mstate = (m.OnGround ? OnGround : 0) + (m.Ducking ? Ducking : 0) + (m.JumpHeld ? JumpHeld : 0),
                Cap = m.Cap,
            };
            m.W = null;
            m.P = GenexPosedWorld.Empty;
            return result;
        }

        /// <summary>One fixed step under a (sanitized) input.</summary>
        public static GenexFirstpersonBody Step(GenexFirstpersonBody body, GenexInput input, double dt, GenexFirstpersonParams p, GenexFirstpersonWorld world = null, GenexPosedWorld posed = null) =>
            Step(body, input.MoveX, input.MoveY, input.Yaw, input.Pitch, input.Buttons, dt, p, world, posed);
    }
}
