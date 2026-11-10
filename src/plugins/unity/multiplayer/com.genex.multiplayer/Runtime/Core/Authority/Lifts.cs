// Lifts (PROTOCOL.md §17.11 *Lifts*), a port of packages/multiplayer/src/authority/lifts.ts and heads.ts: where each declared
// platform is at a tick, and how it carries a seat that rides it, as pure functions of the tick. The host, the guest prelude and every
// SDK compute the same bits, so a client predicts a rider on a kinematic lift exactly at any ping.
//
// Pose at tick t: the path's phase `m` in whole ticks (a called lift: the ticks since its call, for one cycle); within a leg of `n`
// ticks at its tick `i`, each axis a + ((b - a)·i)/n (linear) or a + (b - a)·e with s = i/n, e = s·s·(3 - 2s) (smooth), in float64,
// then float32; a wait holds its point. A spin's yaw is dir·((2π·m)/period), float32. A rider is carried by the move to the next tick:
// turned by the constant δ = dir·2π/period about the centre (§17.7's portable sine and cosine, the only trigonometry), moved by the
// centre's move, and by a conveyor's surface velocity over the tick. Head slabs (heads.ts) are a lower seat's top as ground.
// Same float64 operations in the same order as the TypeScript; no FMA. Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A lift's pose at a tick: its centre and yaw (float32).</summary>
    public readonly struct GenexLiftPose
    {
        public readonly GenexV3 C;
        public readonly double Yaw;

        public GenexLiftPose(GenexV3 c, double yaw)
        {
            C = c;
            Yaw = yaw;
        }
    }

    /// <summary>A carried rider: its pose at the next tick and its point's velocity over the tick (u/s).</summary>
    /// <summary>A dynamic body as the built-in body rules read it after the last step: its key, centre and velocity.</summary>
    public struct GenexRuleProp
    {
        public string Key;
        public double Px, Py, Pz, Vx, Vy, Vz;
    }

    public readonly struct GenexCarried
    {
        public readonly double X, Y, Z, Yaw;
        public readonly GenexV3 V;

        public GenexCarried(double x, double y, double z, double yaw, GenexV3 v)
        {
            X = x;
            Y = y;
            Z = z;
            Yaw = yaw;
            V = v;
        }
    }

    /// <summary>A seat as the slots read and write it (float32 writes).</summary>
    public sealed class GenexLiftSeat
    {
        public string Id;
        public double X, Y, Z, VX, VY, VZ, Yaw, Duck;
        /// <summary>A vehicle seat's yaw rate (read by the contact pass only).</summary>
        public double Spin;
        /// <summary>Its contact tags and flags (the pair rules match them), for the head slabs.</summary>
        public string[] Tags;
        public double Flags;

        public GenexLiftSeat Copy() => (GenexLiftSeat)MemberwiseClone();

        /// <summary>The seat as the contact policy reads it.</summary>
        public GenexContactBody ToBody() => new GenexContactBody(Id) { X = X, Y = Y, Z = Z, Vx = VX, Vy = VY, Vz = VZ, Yaw = Yaw, Spin = Spin, Flags = Flags, Tags = Tags };

        public GenexHullBody Hull() => new GenexHullBody { X = X, Y = Y, Z = Z, VZ = VZ, Duck = Duck };
    }

    /// <summary>A room's contact policy, for the slots' head slabs and the carry by a lower seat (§17.11 step 6 <c>stand</c> with <c>ride</c>).</summary>
    public sealed class GenexHeadsContext
    {
        public GenexContactPolicy Policy;
        public GenexContactEnv Env;
    }

    /// <summary>What the carry slot did: each seat's lift at the tick's start (-1 none) and its carry's velocity, the seat each rides,
    /// and the seats a lift crushed against the world.</summary>
    public sealed class GenexCarryReport
    {
        public int[] Bases;
        /// <summary>The seat each rides at the tick's start (its pair rule <c>stand</c> with <c>ride</c>), else null.</summary>
        public string[] On;
        public GenexV3?[] V;
        public List<KeyValuePair<string, string>> Crushed = new List<KeyValuePair<string, string>>();
        /// <summary>Each seat's x y z after the carry slot: <see cref="GenexLifts.RideSlot"/> reads a ridden seat's walk from it.</summary>
        public GenexV3[] From;
    }

    /// <summary>A tick's lifts as posed solids at its start and its end, computed once a tick and handed to both slots and the steps.</summary>
    public sealed class GenexTickSolids
    {
        public List<GenexPosedSolid> Now, Next;
    }

    /// <summary>One seat's head slabs: the posed solids and, by the same index, the id of the seat each is the top of.</summary>
    public sealed class GenexHeadSlabs
    {
        public readonly List<GenexPosedSolid> Solids = new List<GenexPosedSolid>();
        public readonly List<string> Lowers = new List<string>();
    }

    public static class GenexLifts
    {
        private static readonly double TwoPi = 2 * Math.PI;

        /// <summary>Riders carried through a chain of seats at most (a seat on a seat on a seat on a lift).</summary>
        public const int RideChainMax = 4;

        private static double F(double v) => (float)v;

        /// <summary><c>x mod n</c> in [0, n).</summary>
        private static double Wrap(double x, double n) => ((x % n) + n) % n;

        /// <summary>One leg's point at its tick <c>i</c> of <c>n</c>.</summary>
        private static GenexV3 Along(GenexV3 a, GenexV3 b, double i, double n, bool smooth)
        {
            if (!smooth) return new GenexV3(F(a.X + ((b.X - a.X) * i) / n), F(a.Y + ((b.Y - a.Y) * i) / n), F(a.Z + ((b.Z - a.Z) * i) / n));
            var s = i / n;
            var e = s * s * (3 - 2 * s);
            return new GenexV3(F(a.X + (b.X - a.X) * e), F(a.Y + (b.Y - a.Y) * e), F(a.Z + (b.Z - a.Z) * e));
        }

        /// <summary>The leg <paramref name="k"/> of the path's running order (0..count-1): from, to, its ticks and the wait at <c>to</c>.</summary>
        private static void LegAt(GenexLiftPath p, int k, out GenexV3 a, out GenexV3 b, out int legTicks, out int waitTicks)
        {
            var n = p.Legs.Length;
            if (p.Loop)
            {
                a = p.Points[k];
                b = p.Points[(k + 1) % n];
                legTicks = p.Legs[k];
                waitTicks = p.Waits[(k + 1) % n];
                return;
            }
            if (k < n)
            {
                a = p.Points[k];
                b = p.Points[k + 1];
                legTicks = p.Legs[k];
                waitTicks = p.Waits[k + 1];
                return;
            }
            var back = n - 1 - (k - n);
            a = p.Points[back + 1];
            b = p.Points[back];
            legTicks = p.Legs[back];
            waitTicks = p.Waits[back];
        }

        /// <summary>The path's centre at phase <paramref name="m"/> in [0, period).</summary>
        private static GenexV3 PathAt(GenexLiftPath p, double m)
        {
            var t = m;
            var count = p.Loop ? p.Legs.Length : 2 * p.Legs.Length;
            for (var k = 0; k < count; k++)
            {
                LegAt(p, k, out var a, out var b, out var legTicks, out var waitTicks);
                if (t < legTicks) return Along(a, b, t, legTicks, p.Smooth);
                t -= legTicks;
                if (t < waitTicks) return b;
                t -= waitTicks;
            }
            return p.Points[0];
        }

        /// <summary>The phase of a lift's path at <paramref name="tick"/>: a called lift's ticks since its call for one cycle (0 before it,
        /// after it and while uncalled), else the tick plus its phase, in the period.</summary>
        private static double PhaseOf(GenexLift lift, GenexLiftPath p, double tick, double? start)
        {
            if (!lift.Called) return Wrap(tick + p.Phase, p.Period);
            if (start == null || tick < start.Value || tick - start.Value >= p.Period) return 0;
            return tick - start.Value;
        }

        /// <summary>Lift <paramref name="lift"/>'s pose at <paramref name="tick"/>; <paramref name="start"/> is a called lift's call tick (null: not called).</summary>
        public static GenexLiftPose Pose(GenexLift lift, double tick, double? start = null)
        {
            var c = lift.Path == null ? lift.At : PathAt(lift.Path, PhaseOf(lift, lift.Path, tick, start));
            var spin = lift.Spin;
            if (spin == null) return new GenexLiftPose(c, 0);
            return new GenexLiftPose(c, F(spin.Dir * ((TwoPi * Wrap(tick + spin.Phase, spin.Period)) / spin.Period)));
        }

        private static double? StartOf(IDictionary<string, double> starts, GenexLift lift) => starts != null && starts.TryGetValue(lift.Id, out var s) ? s : (double?)null;

        /// <summary>Every lift's pose at <paramref name="tick"/>, in declared order; <paramref name="starts"/> holds called lifts' call ticks by id.</summary>
        public static GenexLiftPose[] Poses(GenexLiftsPolicy policy, double tick, IDictionary<string, double> starts = null)
        {
            var output = new GenexLiftPose[policy.Platforms.Length];
            for (var i = 0; i < output.Length; i++) output[i] = Pose(policy.Platforms[i], tick, StartOf(starts, policy.Platforms[i]));
            return output;
        }

        /// <summary>A lift's turn per tick (0 for none).</summary>
        public static double SpinStep(GenexLift lift) => lift.Spin == null ? 0 : (lift.Spin.Dir * TwoPi) / lift.Spin.Period;

        // ---- the input's tick (§17.11 *The input's tick*, cap tick@1; TypeScript input-tick.ts) ----

        /// <summary>The field's range (the predicted tick modulo this) and the slack, in seconds of ticks.</summary>
        public const double InputTickMod = 65536;
        public const double InputTickSlackS = 0.5;

        private static bool SafeInteger(double v) => !double.IsNaN(v) && !double.IsInfinity(v) && Math.Floor(v) == v && Math.Abs(v) <= 9007199254740991.0;

        /// <summary>The field a client writes for an input it predicts at server tick <paramref name="tick"/> (0 for a tick that is not a safe integer).</summary>
        public static double InputTickField(double tick)
        {
            if (!SafeInteger(tick)) return 0;
            var m = ((tick % InputTickMod) + InputTickMod) % InputTickMod;
            return m == 0 ? 0 : m;
        }

        /// <summary>How many ticks later than its client meant an input carrying <paramref name="field"/> is applied at <paramref name="applied"/>; 0 for a
        /// hostile field (none, not an integer in [0, 65536)), an applied tick that is not a safe integer, or a lag past the slack.</summary>
        public static double InputTickLag(double? field, double applied, double tickHz)
        {
            if (field == null) return 0;
            var f = field.Value;
            if (double.IsNaN(f) || double.IsInfinity(f) || Math.Floor(f) != f || f < 0 || f >= InputTickMod || !SafeInteger(applied)) return 0;
            var hz = !double.IsNaN(tickHz) && !double.IsInfinity(tickHz) && tickHz > 0 ? tickHz : 0;
            var slack = Math.Max(1, Math.Floor(InputTickSlackS * hz + 0.5));
            var half = InputTickMod / 2;
            var back = ((((applied - f) % InputTickMod) + InputTickMod + half) % InputTickMod) - half;
            return Math.Abs(back) > slack || back == 0 ? 0 : back;
        }

        /// <summary>A firstperson view on <paramref name="lift"/> applied <paramref name="lag"/> ticks late: <paramref name="yaw"/> carried by the lift's turn, float32.</summary>
        public static double ViewOnLift(GenexLift lift, double yaw, double lag) => lag == 0 || lift.Spin == null ? yaw : F(yaw + SpinStep(lift) * lag);

        /// <summary>
        /// The carry of a rider on <paramref name="lift"/> from <paramref name="tick"/> to <c>tick + 1</c> (§17.11 <i>Lifts</i>, the carry
        /// slot): turned by the lift's spin about its centre, moved with the centre, then by a conveyor's surface velocity in the lift's
        /// frame at <c>tick + 1</c> over one tick; its yaw turned with the spin. <c>V</c> is the point's move over the tick.
        /// </summary>
        public static GenexCarried CarryOnLift(GenexLift lift, double riderX, double riderY, double riderZ, double riderYaw, double tick, double tickHz, double? start = null)
        {
            var p0 = Pose(lift, tick, start);
            var p1 = Pose(lift, tick + 1, start);
            var delta = SpinStep(lift);
            double x, y;
            if (delta == 0)
            {
                x = riderX + (p1.C.X - p0.C.X);
                y = riderY + (p1.C.Y - p0.C.Y);
            }
            else
            {
                GenexPresets.PSinCos(delta, out var s, out var c);
                var dx = riderX - p0.C.X;
                var dy = riderY - p0.C.Y;
                x = p1.C.X + (c * dx - s * dy);
                y = p1.C.Y + (s * dx + c * dy);
            }
            var z = riderZ + (p1.C.Z - p0.C.Z);
            if (lift.HasSurface)
            {
                var sx = lift.SurfaceX;
                var sy = lift.SurfaceY;
                if (p1.Yaw == 0)
                {
                    x += sx / tickHz;
                    y += sy / tickHz;
                }
                else
                {
                    GenexPresets.PSinCos(p1.Yaw, out var s, out var c);
                    x += (c * sx - s * sy) / tickHz;
                    y += (s * sx + c * sy) / tickHz;
                }
            }
            return new GenexCarried(x, y, z, riderYaw + delta, new GenexV3((x - riderX) * tickHz, (y - riderY) * tickHz, (z - riderZ) * tickHz));
        }

        /// <summary>Every lift as a posed solid (§17.7 <i>Posed solids</i>) at the poses given, in declared order: a box that never spins
        /// is axis-aligned, one that spins an <c>obox</c>, a disc a disc.</summary>
        public static List<GenexPosedSolid> PosedSolids(GenexLiftsPolicy policy, GenexLiftPose[] poses)
        {
            var output = new List<GenexPosedSolid>(policy.Platforms.Length);
            for (var i = 0; i < policy.Platforms.Length; i++)
            {
                var lift = policy.Platforms[i];
                var c = poses[i].C;
                var shape = lift.Shape;
                if (shape.Kind == GenexLiftShapeKind.Disc)
                {
                    output.Add(GenexPosedSolid.Disc(c, shape.Radius, shape.HalfZ));
                    continue;
                }
                var h = shape.Half;
                if (lift.Spin == null)
                {
                    output.Add(GenexPosedSolid.Box(new GenexV3(c.X - h.X, c.Y - h.Y, c.Z - h.Z), new GenexV3(c.X + h.X, c.Y + h.Y, c.Z + h.Z)));
                    continue;
                }
                GenexPresets.PSinCos(poses[i].Yaw, out var sin, out var cos);
                output.Add(GenexPosedSolid.OBox(c, h, sin, cos));
            }
            return output;
        }

        /// <summary>The lifts posed at <paramref name="tick"/> and <c>tick + 1</c>.</summary>
        public static GenexTickSolids TickSolids(GenexLiftsPolicy policy, double tick, IDictionary<string, double> starts = null) =>
            new GenexTickSolids { Now = PosedSolids(policy, Poses(policy, tick, starts)), Next = PosedSolids(policy, Poses(policy, tick + 1, starts)) };

        // ---- head slabs (heads.ts) ----

        /// <summary>The top of a seat with this policy's shape, over its base.</summary>
        private static double TopOf(GenexContactPolicy policy) => policy.Shape.Kind == GenexContactShapeKind.Hull ? policy.Shape.Height : policy.Shape.Top;

        /// <summary>Whether a policy has any <c>stand</c> rule (its top or a pair's): a room without one has no head slabs.</summary>
        public static bool HasStand(GenexContactPolicy policy)
        {
            if (policy.Top.Policy == GenexTopPolicy.Stand) return true;
            foreach (var r in policy.Pairs)
            {
                if (r.Top.Policy == GenexTopPolicy.Stand) return true;
            }
            return false;
        }

        /// <summary>Seat <paramref name="lower"/>'s top as a slab at its place plus its velocity over <paramref name="dt"/>: <c>groundTrace</c>
        /// thick under the top, a hull's square footprint, a box turned with its heading.</summary>
        public static GenexPosedSolid HeadSlab(GenexContactBody lower, GenexContactPolicy policy, double dt)
        {
            var x = lower.X + lower.Vx * dt;
            var y = lower.Y + lower.Vy * dt;
            var z = lower.Z + lower.Vz * dt;
            var shape = policy.Shape;
            var trace = policy.GroundTrace;
            if (shape.Kind == GenexContactShapeKind.Hull)
            {
                var r = shape.Radius;
                return GenexPosedSolid.Box(new GenexV3(x - r, y - r, z + shape.Height - trace), new GenexV3(x + r, y + r, z + shape.Height));
            }
            GenexPresets.PSinCos(lower.Yaw, out var sin, out var cos);
            return GenexPosedSolid.OBox(new GenexV3(x, y, z + shape.Top - trace / 2), new GenexV3(shape.Length / 2, shape.Width / 2, trace / 2), sin, cos);
        }

        /// <summary>The farthest off a head (a share of its half extent) a seat may get its slab: the two footprints still overlap.</summary>
        private const double SlabReach = 2;

        /// <summary>Whether seat <paramref name="upper"/> gets seat <paramref name="lower"/>'s slab: a <c>stand</c> pair, the upper over the
        /// lower's top, the lower standable, and the upper passing the stand test.</summary>
        private static bool SlabFor(GenexContactBody upper, GenexContactBody lower, GenexContactPolicy policy, GenexContactEnv env)
        {
            var rule = GenexContactPolicyRules.TopRuleOf(policy, upper, lower);
            if (rule.Policy != GenexTopPolicy.Stand) return false;
            var top = TopOf(policy);
            if (upper.Z < lower.Z + top - policy.GroundTrace || upper.Z > lower.Z + 2 * top) return false;
            if (!(GenexContactPolicyRules.HeadOffset(upper, lower, policy) < SlabReach)) return false;
            if (GenexContactPolicyRules.SupportZ(lower, policy, env) < policy.SupportCos) return false;
            return GenexContactPolicyRules.HeadStands(upper, lower, rule, policy);
        }

        /// <summary>Every seat's head slabs (ids ascending in <paramref name="seats"/>, read as they are): for seat i, the slab of each other
        /// seat it may stand on, in order, at its place plus its velocity over <paramref name="dt"/> (0 at the tick's start for the carry
        /// slot's support; the tick's dt for the input steps).</summary>
        public static GenexHeadSlabs[] HeadSlabsOf(IList<GenexContactBody> seats, GenexContactPolicy policy, GenexContactEnv env, double dt)
        {
            var output = new GenexHeadSlabs[seats.Count];
            for (var i = 0; i < output.Length; i++)
            {
                var slabs = new GenexHeadSlabs();
                var upper = seats[i];
                foreach (var lower in seats)
                {
                    if (ReferenceEquals(lower, upper) || !SlabFor(upper, lower, policy, env)) continue;
                    slabs.Solids.Add(HeadSlab(lower, policy, dt));
                    slabs.Lowers.Add(lower.Id);
                }
                output[i] = slabs;
            }
            return output;
        }

        /// <summary>The seats as the contact policy reads them.</summary>
        public static List<GenexContactBody> BodiesOf(IList<GenexLiftSeat> seats)
        {
            var output = new List<GenexContactBody>(seats.Count);
            foreach (var s in seats) output.Add(s.ToBody());
            return output;
        }

        // ---- the slots (before a tick's inputs, and after its contact pass) ----

        /// <summary>Writes a carry's or push-out's place into <paramref name="seat"/> as float32.</summary>
        private static void Place(GenexLiftSeat seat, double x, double y, double z)
        {
            seat.X = F(x);
            seat.Y = F(y);
            seat.Z = F(z);
        }

        /// <summary>Each seat's support at the tick's start among the lifts (<paramref name="now"/>) and, with heads, its head slabs: the
        /// lift's index (else -1) and the seat it rides (a <c>stand</c> pair with <c>ride</c>; else null).</summary>
        private static void SupportsOf(GenexLiftsPolicy policy, IList<GenexLiftSeat> seats, List<GenexPosedSolid> now, GenexHullOps ops, GenexHeadsContext heads, out int[] bases, out string[] on)
        {
            bases = new int[seats.Count];
            on = new string[seats.Count];
            var slabs = heads == null ? null : HeadSlabsOf(BodiesOf(seats), heads.Policy, heads.Env, 0);
            var lifts = policy.Platforms.Length;
            for (var i = 0; i < seats.Count; i++)
            {
                var seat = seats[i];
                var own = slabs == null ? null : slabs[i];
                List<GenexPosedSolid> solids = now;
                if (own != null && own.Solids.Count > 0)
                {
                    solids = new List<GenexPosedSolid>(now);
                    solids.AddRange(own.Solids);
                }
                var k = ops.Support(seat.Hull(), solids);
                GenexLiftSeat lower = null;
                if (k >= lifts && own != null)
                {
                    var id = own.Lowers[k - lifts];
                    foreach (var s in seats)
                    {
                        if (s.Id == id)
                        {
                            lower = s;
                            break;
                        }
                    }
                }
                var rule = heads != null && lower != null ? GenexContactPolicyRules.TopRuleOf(heads.Policy, seat.ToBody(), lower.ToBody()) : null;
                bases[i] = k < lifts ? k : -1;
                on[i] = lower != null && rule != null && rule.Policy == GenexTopPolicy.Stand && rule.Ride ? lower.Id : null;
            }
        }

        /// <summary>Seat i's move over the tick before the steps: its lift's carry, or the ridden seat's (its walk follows in <see cref="RideSlot"/>).</summary>
        private static GenexV3 MoveOf(int i, int depth, IList<GenexLiftSeat> before, GenexCarried?[] lifted, string[] on, Dictionary<string, int> index)
        {
            var own = lifted[i];
            if (own != null)
            {
                var c = own.Value;
                return new GenexV3(c.X - before[i].X, c.Y - before[i].Y, c.Z - before[i].Z);
            }
            if (on[i] == null || !index.TryGetValue(on[i], out var j) || depth >= RideChainMax) return new GenexV3(0, 0, 0);
            return MoveOf(j, depth + 1, before, lifted, on, index);
        }

        /// <summary>Each seat's carry over the tick from the seats as they were (<paramref name="before"/>).</summary>
        private static GenexCarried?[] CarriesOf(GenexLiftsPolicy policy, IList<GenexLiftSeat> before, int[] bases, string[] on, double tick, double tickHz, IDictionary<string, double> starts)
        {
            var lifted = new GenexCarried?[before.Count];
            for (var i = 0; i < lifted.Length; i++)
            {
                if (bases[i] < 0) continue;
                var lift = policy.Platforms[bases[i]];
                var s = before[i];
                lifted[i] = CarryOnLift(lift, s.X, s.Y, s.Z, s.Yaw, tick, tickHz, StartOf(starts, lift));
            }
            var index = new Dictionary<string, int>();
            for (var i = 0; i < before.Count; i++) index[before[i].Id] = i;
            var output = new GenexCarried?[before.Count];
            for (var i = 0; i < output.Length; i++)
            {
                if (lifted[i] != null)
                {
                    output[i] = lifted[i];
                    continue;
                }
                if (on[i] == null) continue;
                var m = MoveOf(i, 0, before, lifted, on, index);
                var seat = before[i];
                output[i] = new GenexCarried(seat.X + m.X, seat.Y + m.Y, seat.Z + m.Z, seat.Yaw, new GenexV3(m.X * tickHz, m.Y * tickHz, m.Z * tickHz));
            }
            return output;
        }

        /// <summary>
        /// The carry slot of tick <paramref name="tick"/>, before its inputs (§17.11 <i>Lifts</i>), on <paramref name="seats"/> in their
        /// order (ids ascending), each changed in place, every support and carry read from the seats as they were:
        /// 1. its support: the lift it stands on among the lifts posed at <c>tick</c>, or, with <paramref name="heads"/>, the seat whose head
        ///    slab it stands on (ridden when their pair rule is <c>stand</c> with <c>ride</c>);
        /// 2. on lift L: carried by L to <c>tick + 1</c> (a vehicle's yaw, <paramref name="turnYaw"/>, turned with it); riding seat S: by S's
        ///    carry (a chain base first; S's walk follows in <see cref="RideSlot"/>, after the steps);
        /// 3. every other lift it is inside at <c>tick + 1</c>, in order: moved by that lift's move at its point, then pushed out; still
        ///    inside a solid: crushed by that lift.
        /// Writes x y z (yaw) as float32; the report's <c>From</c> is each seat's place as the slot left it.
        /// </summary>
        public static GenexCarryReport CarrySlot(GenexLiftsPolicy policy, IList<GenexLiftSeat> seats, double tick, double tickHz, IDictionary<string, double> starts, GenexHullOps ops, bool turnYaw, GenexTickSolids posed = null, GenexHeadsContext heads = null)
        {
            posed = posed ?? TickSolids(policy, tick, starts);
            var next = posed.Next;
            var before = new List<GenexLiftSeat>(seats.Count);
            foreach (var s in seats) before.Add(s.Copy());
            SupportsOf(policy, before, posed.Now, ops, heads, out var bases, out var on);
            var carries = CarriesOf(policy, before, bases, on, tick, tickHz, starts);
            var nextWorld = new GenexPosedWorld(next);
            var report = new GenexCarryReport { Bases = bases, On = on, V = new GenexV3?[seats.Count] };
            for (var i = 0; i < seats.Count; i++)
            {
                var seat = seats[i];
                var b = bases[i];
                var c = carries[i];
                if (c != null)
                {
                    Place(seat, c.Value.X, c.Value.Y, c.Value.Z);
                    if (turnYaw && b >= 0) seat.Yaw = F(c.Value.Yaw);
                    report.V[i] = c.Value.V;
                }
                for (var k = 0; k < policy.Platforms.Length; k++)
                {
                    var lift = policy.Platforms[k];
                    if (k == b || !ops.Inside(seat.Hull(), nextWorld, k)) continue;
                    var moved = CarryOnLift(lift, seat.X, seat.Y, seat.Z, seat.Yaw, tick, tickHz, StartOf(starts, lift));
                    var body = seat.Hull();
                    body.X = moved.X;
                    body.Y = moved.Y;
                    body.Z = moved.Z;
                    var outPos = ops.PushOut(body, nextWorld, out var stillInside);
                    Place(seat, outPos.X, outPos.Y, outPos.Z);
                    if (stillInside) report.Crushed.Add(new KeyValuePair<string, string>(seat.Id, lift.Id));
                }
            }
            report.From = new GenexV3[seats.Count];
            for (var i = 0; i < seats.Count; i++) report.From[i] = new GenexV3(seats[i].X, seats[i].Y, seats[i].Z);
            return report;
        }

        /// <summary>Seat i's ride over the steps: the walks of the seats under it, base first, at most <see cref="RideChainMax"/>.</summary>
        private static double[] RideOf(int i, int depth, string[] on, Dictionary<string, int> index, double[][] walked)
        {
            if (on[i] == null || !index.TryGetValue(on[i], out var j) || depth >= RideChainMax) return new double[] { 0, 0 };
            var m = RideOf(j, depth + 1, on, index, walked);
            return new[] { walked[j][0] + m[0], walked[j][1] + m[1] };
        }

        /// <summary>
        /// The ride slot of a tick, after its inputs' steps and before its contact pass (§17.11 <i>Lifts</i>): a seat riding seat S
        /// (<c>report.On</c>) is moved in x y by S's walk this tick (S's place now less its place after the carry slot, <c>report.From</c>:
        /// every step S's inputs took, none on a held starve) and by S's own ride, base first, <see cref="RideChainMax"/> deep, so it keeps
        /// its place on S's head. Its carry's velocity gains that move. <paramref name="seats"/> are the carry slot's, in its order, changed
        /// in place (x y as float32); returns the report with the riders' velocities.
        /// </summary>
        public static GenexCarryReport RideSlot(IList<GenexLiftSeat> seats, GenexCarryReport report, double tickHz)
        {
            var any = false;
            foreach (var id in report.On) any |= id != null;
            if (!any) return report;
            var index = new Dictionary<string, int>();
            for (var i = 0; i < seats.Count; i++) index[seats[i].Id] = i;
            var walked = new double[seats.Count][];
            for (var i = 0; i < seats.Count; i++) walked[i] = new[] { seats[i].X - report.From[i].X, seats[i].Y - report.From[i].Y };
            var moves = new double[seats.Count][];
            for (var i = 0; i < seats.Count; i++) moves[i] = RideOf(i, 0, report.On, index, walked);
            var v = (GenexV3?[])report.V.Clone();
            for (var i = 0; i < seats.Count; i++)
            {
                if (report.On[i] == null) continue;
                var m = moves[i];
                if (v[i] != null) v[i] = new GenexV3(v[i].Value.X + m[0] * tickHz, v[i].Value.Y + m[1] * tickHz, v[i].Value.Z);
                seats[i].X = F(seats[i].X + m[0]);
                seats[i].Y = F(seats[i].Y + m[1]);
            }
            return new GenexCarryReport { Bases = report.Bases, On = report.On, V = v, Crushed = report.Crushed, From = report.From };
        }

        /// <summary>Whether seat i still rides seat <paramref name="id"/> after the tick: it stands on that seat's head slab.</summary>
        private static bool StillRides(IList<GenexLiftSeat> seats, int i, string id, List<GenexPosedSolid> next, GenexHullOps ops, GenexHeadsContext heads)
        {
            var own = HeadSlabsOf(BodiesOf(seats), heads.Policy, heads.Env, 0)[i];
            if (own.Solids.Count == 0) return false;
            var all = new List<GenexPosedSolid>(next);
            all.AddRange(own.Solids);
            var k = ops.Support(seats[i].Hull(), all);
            return k >= next.Count && own.Lowers[k - next.Count] == id;
        }

        /// <summary>
        /// The impart slot of tick <paramref name="tick"/>, after its contact pass: a seat that stood on lift L at the tick's start and no
        /// longer stands on it among the lifts posed at <c>tick + 1</c> keeps L's velocity at its point when L imparts (<c>impart: all</c>);
        /// a seat that rode seat S and no longer stands on S's head keeps its carry's velocity. Writes vx vy vz as float32.
        /// </summary>
        public static void ImpartSlot(GenexLiftsPolicy policy, IList<GenexLiftSeat> seats, GenexCarryReport report, double tick, IDictionary<string, double> starts, GenexHullOps ops, List<GenexPosedSolid> next = null, GenexHeadsContext heads = null)
        {
            next = next ?? TickSolids(policy, tick, starts).Next;
            var after = new List<GenexLiftSeat>(seats.Count);
            foreach (var s in seats) after.Add(s.Copy());
            for (var i = 0; i < seats.Count; i++)
            {
                var seat = seats[i];
                var b = report.Bases[i];
                var v = report.V[i];
                var rode = report.On[i];
                if (v == null) continue;
                if (rode != null && heads != null)
                {
                    if (StillRides(after, i, rode, next, ops, heads)) continue;
                }
                else if (b < 0 || !policy.Platforms[b].ImpartAll || ops.Support(seat.Hull(), next) == b) continue;
                seat.VX = F(seat.VX + v.Value.X);
                seat.VY = F(seat.VY + v.Value.Y);
                seat.VZ = F(seat.VZ + v.Value.Z);
            }
        }

        // ---- lifts as physics bodies (§17.11 *Lifts* step 9: a physics room's lifts are kinematic bodies) ----

        /// <summary>A lift's body key in a physics room: <c>lift.&lt;id&gt;</c>.</summary>
        public static string LiftBodyKey(string id) => "lift." + id;

        /// <summary>A disc's body is a prism of this many sides around its radius.</summary>
        private const int DiscSides = 16;

        /// <summary>A lift's body pose at <paramref name="tick"/>: its centre and its yaw as a quaternion about z (portable sine, float32).</summary>
        public static void LiftBodyPose(GenexLift lift, double tick, IDictionary<string, double> starts, out double[] p, out double[] q)
        {
            var pose = Pose(lift, tick, StartOf(starts, lift));
            GenexPresets.PSinCos(pose.Yaw / 2, out var s, out var c);
            p = new[] { pose.C.X, pose.C.Y, pose.C.Z };
            q = new[] { 0, 0, F(s), F(c) };
        }

        /// <summary>A lift's kinematic body as a physics room spawns it at <paramref name="tick"/>: one collider <c>lift</c>, its box (a disc a
        /// 16-sided prism, its corners from the portable sine), frictionless on a conveyor.</summary>
        public static Dictionary<string, object> LiftBodySpawn(GenexLift lift, double tick, IDictionary<string, double> starts)
        {
            Dictionary<string, object> shape;
            if (lift.Shape.Kind == GenexLiftShapeKind.Box) shape = new Dictionary<string, object> { ["kind"] = "box", ["half"] = new[] { lift.Shape.Half.X, lift.Shape.Half.Y, lift.Shape.Half.Z } };
            else
            {
                var points = new List<object>();
                for (var i = 0; i < DiscSides; i++)
                {
                    GenexPresets.PSinCos((2 * Math.PI * i) / DiscSides, out var s, out var c);
                    var x = F(lift.Shape.Radius * c);
                    var y = F(lift.Shape.Radius * s);
                    points.Add(new[] { x, y, -lift.Shape.HalfZ });
                    points.Add(new[] { x, y, lift.Shape.HalfZ });
                }
                shape = new Dictionary<string, object> { ["kind"] = "hull", ["points"] = points };
            }
            var collider = new Dictionary<string, object> { ["key"] = "lift", ["shape"] = shape };
            if (lift.HasSurface) collider["friction"] = 0.0;
            LiftBodyPose(lift, tick, starts, out var p, out var q);
            return new Dictionary<string, object>
            {
                ["key"] = LiftBodyKey(lift.Id),
                ["type"] = "kinematic",
                ["pose"] = new Dictionary<string, object> { ["p"] = p, ["q"] = q },
                ["colliders"] = new List<object> { collider },
            };
        }

        /// <summary>How fast a conveyor brings a body on it to its surface velocity, per second.</summary>
        public const double ConveyorRate = 20;

        /// <summary>Whether <c>(x, y)</c> is inside lift <paramref name="lift"/>'s footprint at <paramref name="pose"/> (in its own frame).</summary>
        private static bool OverFootprint(GenexLift lift, GenexLiftPose pose, double x, double y)
        {
            var dx = x - pose.C.X;
            var dy = y - pose.C.Y;
            double s = 0, c = 1;
            if (pose.Yaw != 0) GenexPresets.PSinCos(pose.Yaw, out s, out c);
            var lx = c * dx + s * dy;
            var ly = c * dy - s * dx;
            if (lift.Shape.Kind == GenexLiftShapeKind.Disc) return lx * lx + ly * ly <= lift.Shape.Radius * lift.Shape.Radius;
            return Math.Abs(lx) <= lift.Shape.Half.X && Math.Abs(ly) <= lift.Shape.Half.Y;
        }

        /// <summary>
        /// The conveyor rule of tick <paramref name="tick"/> (before its physics step): each dynamic body (in the order given: key order) whose
        /// centre is over a conveyor's top at <c>tick</c> (inside its footprint in its own frame, above its top by more than 0 and at most
        /// <paramref name="reach"/>; the first such conveyor in declared order) has its horizontal velocity brought toward the carry velocity
        /// of its point from <c>tick</c> to <c>tick + 1</c> by the share <c>min(1, ConveyorRate / tickHz)</c> of the difference; its vertical
        /// speed kept.
        /// </summary>
        public static List<GenexRuleVelocity> ConveyorNudges(GenexLiftsPolicy policy, double tick, IDictionary<string, double> starts, double tickHz, IList<GenexRuleProp> bodies, double reach)
        {
            var belts = new List<GenexLift>();
            var poses = new List<GenexLiftPose>();
            foreach (var l in policy.Platforms)
            {
                if (!l.HasSurface) continue;
                belts.Add(l);
                poses.Add(Pose(l, tick, StartOf(starts, l)));
            }
            var k = Math.Min(1, ConveyorRate / tickHz);
            var output = new List<GenexRuleVelocity>();
            foreach (var body in bodies)
            {
                GenexLift lift = null;
                for (var i = 0; i < belts.Count && lift == null; i++)
                {
                    var top = poses[i].C.Z + (belts[i].Shape.Kind == GenexLiftShapeKind.Disc ? belts[i].Shape.HalfZ : belts[i].Shape.Half.Z);
                    var rise = body.Pz - top;
                    if (rise > 0 && rise <= reach && OverFootprint(belts[i], poses[i], body.Px, body.Py)) lift = belts[i];
                }
                if (lift == null) continue;
                var carried = CarryOnLift(lift, body.Px, body.Py, body.Pz, 0, tick, tickHz, StartOf(starts, lift));
                var dx = carried.V.X - body.Vx;
                var dy = carried.V.Y - body.Vy;
                if (dx == 0 && dy == 0) continue;
                output.Add(new GenexRuleVelocity { Key = body.Key, Vx = body.Vx + dx * k, Vy = body.Vy + dy * k, Vz = body.Vz });
            }
            return output;
        }

        /// <summary>
        /// The prop rule under <c>headFriction: slide</c> (after the module's body rule, before the physics step): each dynamic body (key
        /// order) whose centre is over a seat's top (within its preset body's footprint <paramref name="half"/>, above its top by at most the
        /// seat's height; the first such seat) has its parting from that seat, along the way from the seat's centre to its own (+x when
        /// centred), brought up to <c>slide.Speed</c> by at most <c>slide.Step</c>; vertical speed kept.
        /// </summary>
        public static List<GenexRuleVelocity> PropSlideNudges(IList<GenexRuleSeat> seats, double[] half, IList<GenexRuleProp> bodies, GenexPropSlide slide)
        {
            var output = new List<GenexRuleVelocity>();
            foreach (var body in bodies)
            {
                GenexRuleSeat? under = null;
                foreach (var s in seats)
                {
                    if (Math.Abs(body.Px - s.X) <= half[0] && Math.Abs(body.Py - s.Y) <= half[1] && body.Pz > s.Z + 2 * half[2] && body.Pz <= s.Z + 4 * half[2])
                    {
                        under = s;
                        break;
                    }
                }
                if (under == null) continue;
                var seat = under.Value;
                var dx = body.Px - seat.X;
                var dy = body.Py - seat.Y;
                var d = GenexContactPolicyRules.Hypot(dx, dy, 0);
                var ux = d > 0 ? dx / d : 1;
                var uy = d > 0 ? dy / d : 0;
                var parting = (body.Vx - seat.Vx) * ux + (body.Vy - seat.Vy) * uy;
                if (!(parting < slide.Speed)) continue;
                var add = Math.Min(slide.Step, slide.Speed - parting);
                output.Add(new GenexRuleVelocity { Key = body.Key, Vx = body.Vx + ux * add, Vy = body.Vy + uy * add, Vz = body.Vz });
            }
            return output;
        }
    }
}
