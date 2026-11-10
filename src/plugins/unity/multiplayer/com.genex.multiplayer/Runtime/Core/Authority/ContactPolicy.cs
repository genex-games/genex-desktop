// The universal contact policy (PROTOCOL.md §17.11 *Contact policy*), a port of packages/multiplayer/src/authority/
// contact-policy.ts: how two seats in contact are handled, the same way for every genre, as a pure function of the seats, the
// static world and the kinematic supports at the tick. The server's seat contact pass and the client's replay run this very
// code, so a prediction that holds the inputs is the server's exactly.
//
// One pair (`ContactPair`):
//  1. each seat's support up (the surface under it; world up in the air) and its body (a box laid on that up, or an upright hull);
//  2. the contact axis: level pairs and pairs on one up by the separating-axis test in the plane of the pair's up plus the axis
//     across it (the plane method); pairs on supports that differ by the 15-axis test on the two boxes as laid (the least deep
//     of all 15 is the side axis); the pair enters across the plane when it came down last;
//  3. a `top` contact when that axis is within `SupportCos` of the lower seat's support up, else `side`;
//  4. side: pushed apart along the axis, each seat taking what the static world lets it take (its yield share by cast; a
//     push more than 30 degrees into the ground a seat rides is stopped by it; a seat on a wall slides along its face);
//  5. top: the upper seat set on the lower's top (cast, the lower yielding what the upper cannot take);
//  6. top policy: stand (rest), slide (off along the first free way, else the lower yields, else pinned), bounce (a stomp) or
//     ghost (no contact).
// The pass (`ContactPass`) runs every pair in id order, then the piles' further passes on pairs still deeper than the slop,
// pushing every seat back out of the world after each pass that touched. Plain float64 in the TypeScript's order (no fused
// multiply-add; Math.Sqrt; V8's Math.hypot for the slide's unit vector), §17.7's portable sine and cosine the only trigonometry.
// Held to contact-policy.json by GenexSmoke `contact-policy`. Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>Whether a contact is between two sides or one seat over another's top.</summary>
    public enum GenexContactKind { Side, Top }

    /// <summary>How a top contact's slide went: along the upper seat's free way, the lower seat's, or neither.</summary>
    public enum GenexSlideWay { None, Free, LowerYields, Pinned }

    /// <summary>How a seat over a <c>stand</c> head is held: it stands (and gets the head's slab), is released (no slab, no kick: it is
    /// already leaving), or slides off by the stand's slide.</summary>
    public enum GenexHeadHold { Stand, Release, Slide }

    /// <summary>What the module hears from the pass (a stomp's damage stays a server event, never predicted).</summary>
    public enum GenexContactEvent { Stomp }

    /// <summary>What the policy runs against: the world grown by the seats' hull, and optionally the module's own support up
    /// (car-ball's <c>carUp</c>, a pure function of the base), a listener for its events and the id of a seat that never moves.</summary>
    public sealed class GenexContactEnv
    {
        public GenexContactWorld World;
        public Func<double, double, double, GenexV3> SupportUp;
        /// <summary>Hears a pair's event: a stomp names the upper seat first.</summary>
        public Action<GenexContactBody, GenexContactBody, GenexContactEvent> OnContact;
        /// <summary>The id of a seat that never moves (a drawing's own entity, §17.11 *Drawing other seats*): the other seat of its
        /// pair takes the whole push, its own way (along a wall, never into it).</summary>
        public string Fixed;
    }

    /// <summary>One pair's contact: its kind, axis (unit, from a to b) and depth along it.</summary>
    public class GenexPairContact
    {
        public GenexContactKind Kind;
        public GenexV3 N;
        public double Depth;
        /// <summary>Whether b is the upper seat (top contacts; for side contacts the higher across the plane).</summary>
        public bool UpperIsB;
        /// <summary>The index of the in-plane axis a side contact came from (-1: across the plane).</summary>
        internal int SideAxis = -1;
    }

    /// <summary>What one pair step did: its contact, the impulse along the axis (a slide's change), and a top contact's slide.</summary>
    public sealed class GenexPairOutcome : GenexPairContact
    {
        public double J;
        public GenexSlideWay Way;
        /// <summary>The way taken (unit, the direction the sliding seat moves); meaningful unless <see cref="Way"/> is None or Pinned.</summary>
        public GenexV3 W;
        public bool HasW;
    }

    /// <summary>What a contact pass did.</summary>
    public sealed class GenexContactReport
    {
        /// <summary>Passes that touched a pair.</summary>
        public int Passes;
        /// <summary>Each seat's deepest push out of the world, by id.</summary>
        public readonly Dictionary<string, double> Pushed = new Dictionary<string, double>();
        /// <summary>Each seat's deepest push out through a wall (a face it could not stand on), by id.</summary>
        public readonly Dictionary<string, double> Walls = new Dictionary<string, double>();
        /// <summary>Top contacts that stood pinned (no free way for either seat).</summary>
        public int Pinned;
    }

    /// <summary>A kinematic-rule body a seat may stand on: its box at the tick and how far it moves to the next.</summary>
    public sealed class GenexKinematicSupport
    {
        public string Key;
        public GenexV3 Min, Max;
        /// <summary>Its move from this tick to the next (<c>kinematicRule(t + 1) − kinematicRule(t)</c>).</summary>
        public GenexV3 Dp;
    }

    /// <summary>What one seat stands on: another seat or a kinematic body, and the base velocity it gives.</summary>
    public sealed class GenexRide
    {
        public string Id, On;
        public GenexV3 V;
    }

    /// <summary>The contact policy's pair step, pass and stand ride (contact-policy.ts).</summary>
    public static class GenexContactPolicyRules
    {
        private static readonly GenexV3 Up = GenexV3.Up;

        private static double Dot(in GenexV3 p, in GenexV3 q) => p.X * q.X + p.Y * q.Y + p.Z * q.Z;

        private static GenexV3 Cross(in GenexV3 p, in GenexV3 q) => new GenexV3(p.Y * q.Z - p.Z * q.Y, p.Z * q.X - p.X * q.Z, p.X * q.Y - p.Y * q.X);

        private static GenexV3 Neg(in GenexV3 p) => new GenexV3(-p.X, -p.Y, -p.Z);

        /// <summary>JavaScript's Math.max: NaN if either is, +0 over −0.</summary>
        private static double JsMax(double a, double b)
        {
            if (double.IsNaN(a) || double.IsNaN(b)) return double.NaN;
            if (a == 0 && b == 0) return BitConverter.DoubleToInt64Bits(a) < 0 ? b : a;
            return a > b ? a : b;
        }

        /// <summary>JavaScript's Math.min: NaN if either is, −0 under +0.</summary>
        private static double JsMin(double a, double b)
        {
            if (double.IsNaN(a) || double.IsNaN(b)) return double.NaN;
            if (a == 0 && b == 0) return BitConverter.DoubleToInt64Bits(a) < 0 ? a : b;
            return a < b ? a : b;
        }

        /// <summary>V8's Math.hypot(a, b, c): the sum of squares of the values over their largest, Kahan-summed, rooted, times
        /// the largest (V8's builtin; the TypeScript policy calls Math.hypot for a slide's unit vector).</summary>
        internal static double Hypot(double a, double b, double c)
        {
            var x = Math.Abs(a);
            var y = Math.Abs(b);
            var z = Math.Abs(c);
            double max = 0;
            var nan = double.IsNaN(a) || double.IsNaN(b) || double.IsNaN(c);
            if (!double.IsNaN(a) && x > max) max = x;
            if (!double.IsNaN(b) && y > max) max = y;
            if (!double.IsNaN(c) && z > max) max = z;
            if (double.IsPositiveInfinity(max)) return double.PositiveInfinity;
            if (nan) return double.NaN;
            if (max == 0) return 0;
            double sum = 0;
            double compensation = 0;
            for (var i = 0; i < 3; i++)
            {
                var n = (i == 0 ? x : i == 1 ? y : z) / max;
                var summand = n * n - compensation;
                var preliminary = sum + summand;
                compensation = preliminary - sum - summand;
                sum = preliminary;
            }
            return Math.Sqrt(sum) * max;
        }

        // ---- frames and geometry ----

        /// <summary>A seat's body for one pair test: its geometric up, support up, half extents, top and heading.</summary>
        private sealed class Frame
        {
            public GenexContactBody B;
            public GenexV3 Up, Support;
            public double Hl, Hw, Top, S, C;
        }

        private struct Axis
        {
            public double Depth;
            public GenexV3 N;

            public Axis(double depth, GenexV3 n)
            {
                Depth = depth;
                N = n;
            }
        }

        private sealed class OBox
        {
            public GenexV3 C;
            public GenexV3 A0, A1, A2;
            public double H0, H1, H2;

            public double Radius(in GenexV3 w) => H0 * Math.Abs(Dot(A0, w)) + H1 * Math.Abs(Dot(A1, w)) + H2 * Math.Abs(Dot(A2, w));
        }

        private enum Mode { Level, Tilted, Sat }

        /// <summary>The in-plane geometry of a pair: the least-overlap axis (from a to b), the across axis, every in-plane axis and
        /// the half extent of both bodies along any direction.</summary>
        private sealed class Geometry
        {
            public GenexV3 Plane;
            public bool Level;
            public Axis Side;
            public int SideIndex;
            public List<Axis> Axes;
            public Axis Across;
            public GenexV3 D;
            public Mode Mode;
            public Frame FA, FB;
            public GenexV3 Fa, Ra, Fb, Rb;
            public OBox BoxA, BoxB;

            public double Half(in GenexV3 w)
            {
                switch (Mode)
                {
                    case Mode.Level: return HalfLevel(FA, w.X, w.Y) + HalfLevel(FB, w.X, w.Y);
                    case Mode.Tilted:
                        return FA.Hl * Math.Abs(Dot(Fa, w)) + FA.Hw * Math.Abs(Dot(Ra, w)) + (FB.Hl * Math.Abs(Dot(Fb, w)) + FB.Hw * Math.Abs(Dot(Rb, w)));
                    default: return BoxA.Radius(w) + BoxB.Radius(w);
                }
            }
        }

        /// <summary>The support up of a seat's base (the module's, else the surface under it).</summary>
        private static GenexV3 SupportOf(GenexContactBody b, GenexContactPolicy policy, GenexContactEnv env) =>
            env.SupportUp != null ? env.SupportUp(b.X, b.Y, b.Z) : GenexContactWorld.SurfaceUp(env.World, b.X, b.Y, b.Z, policy.GroundTrace);

        /// <summary>A seat's frame: a box turned with its heading and laid on its support up; a hull upright.</summary>
        private static Frame FrameOf(GenexContactBody b, GenexContactPolicy policy, GenexContactEnv env)
        {
            var shape = policy.Shape;
            var support = SupportOf(b, policy, env);
            if (shape.Kind == GenexContactShapeKind.Hull) return new Frame { B = b, Up = Up, Support = support, Hl = shape.Radius, Hw = shape.Radius, Top = shape.Height, S = 0, C = 1 };
            GenexPresets.PSinCos(b.Yaw, out var s, out var c);
            return new Frame { B = b, Up = support, Support = support, Hl = shape.Length / 2, Hw = shape.Width / 2, Top = shape.Top, S = s, C = c };
        }

        /// <summary>The farthest a frame's footprint reaches from its centre in the plane.</summary>
        private static double DiagOf(Frame f) => Math.Sqrt(f.Hl * f.Hl + f.Hw * f.Hw);

        /// <summary>Half a level frame's box along a horizontal unit axis (nx, ny).</summary>
        private static double HalfLevel(Frame f, double nx, double ny) => f.Hl * Math.Abs(f.C * nx + f.S * ny) + f.Hw * Math.Abs(f.C * ny - f.S * nx);

        /// <summary>Two level frames (both upright): the footprints' four edge normals, least overlap first of equals, and the
        /// across axis along z; null when an axis separates them. Two centres on one spot are split along a's heading.</summary>
        private static Geometry LevelGeometry(Frame a, Frame b)
        {
            var across = b.B.Z - a.B.Z + (b.Top - a.Top) / 2;
            var reachUp = (a.Top + b.Top) / 2;
            if (Math.Abs(across) >= reachUp) return null;
            var dx = b.B.X - a.B.X;
            var dy = b.B.Y - a.B.Y;
            var reach = DiagOf(a) + DiagOf(b);
            if (Math.Abs(dx) >= reach || Math.Abs(dy) >= reach) return null;
            var axes = new List<Axis>(4);
            var bestIndex = -1;
            for (var k = 0; k < 4; k++)
            {
                double nx, ny;
                switch (k)
                {
                    case 0: nx = a.C; ny = a.S; break;
                    case 1: nx = -a.S; ny = a.C; break;
                    case 2: nx = b.C; ny = b.S; break;
                    default: nx = -b.S; ny = b.C; break;
                }
                var along = dx * nx + dy * ny;
                var depth = HalfLevel(a, nx, ny) + HalfLevel(b, nx, ny) - Math.Abs(along);
                if (depth <= 0) return null;
                var axis = along < 0 ? new Axis(depth, new GenexV3(-nx, -ny, 0)) : new Axis(depth, new GenexV3(nx, ny, 0));
                axes.Add(axis);
                if (bestIndex < 0 || depth < axes[bestIndex].Depth) bestIndex = axes.Count - 1;
            }
            var n = across < 0 ? new GenexV3(0, 0, -1) : Up;
            return new Geometry
            {
                Plane = Up, Level = true, Side = axes[bestIndex], SideIndex = bestIndex, Axes = axes, Across = new Axis(reachUp - Math.Abs(across), n),
                D = new GenexV3(dx, dy, 0), Mode = Mode.Level, FA = a, FB = b,
            };
        }

        /// <summary>A heading (horizontal unit vector) laid in the plane across n, of unit length; straight up the plane where the
        /// heading points along n.</summary>
        private static GenexV3 InPlane(double hx, double hy, in GenexV3 n)
        {
            var along = hx * n.X + hy * n.Y;
            var px = hx - along * n.X;
            var py = hy - along * n.Y;
            var pz = -along * n.Z;
            var len = Math.Sqrt(px * px + py * py + pz * pz);
            if (len < 1e-9)
            {
                px = -n.Z * n.X;
                py = -n.Z * n.Y;
                pz = 1 - n.Z * n.Z;
                len = Math.Sqrt(px * px + py * py + pz * pz);
            }
            return new GenexV3(px / len, py / len, pz / len);
        }

        /// <summary>Two frames of which one at least is tilted, on one up: the boxes in the plane across the pair's up, their
        /// centres each half its top up its own up; the least of the four in-plane edge normals and the axis across the plane.</summary>
        private static Geometry TiltedGeometry(Frame a, Frame b)
        {
            var sum = new GenexV3(a.Up.X + b.Up.X, a.Up.Y + b.Up.Y, a.Up.Z + b.Up.Z);
            var len = Math.Sqrt(Dot(sum, sum));
            if (len < 1e-9) return null;
            var n = new GenexV3(sum.X / len, sum.Y / len, sum.Z / len);
            var ha = a.Top / 2;
            var hb = b.Top / 2;
            var d = new GenexV3(b.B.X + b.Up.X * hb - a.B.X - a.Up.X * ha, b.B.Y + b.Up.Y * hb - a.B.Y - a.Up.Y * ha, b.B.Z + b.Up.Z * hb - a.B.Z - a.Up.Z * ha);
            var across = Dot(d, n);
            var reachUp = ha + hb;
            if (Math.Abs(across) >= reachUp) return null;
            var g = new Geometry { Plane = n, Level = false, D = d, Mode = Mode.Tilted, FA = a, FB = b };
            g.Fa = InPlane(a.C, a.S, n);
            g.Fb = InPlane(b.C, b.S, n);
            g.Ra = Cross(n, g.Fa);
            g.Rb = Cross(n, g.Fb);
            g.Axes = new List<Axis>(4);
            var bestIndex = -1;
            for (var i = 0; i < 4; i++)
            {
                var k = i == 0 ? g.Fa : i == 1 ? g.Ra : i == 2 ? g.Fb : g.Rb;
                var along = Dot(d, k);
                var depth = g.Half(k) - Math.Abs(along);
                if (depth <= 0) return null;
                g.Axes.Add(new Axis(depth, along < 0 ? Neg(k) : k));
                if (bestIndex < 0 || depth < g.Axes[bestIndex].Depth) bestIndex = g.Axes.Count - 1;
            }
            g.Side = g.Axes[bestIndex];
            g.SideIndex = bestIndex;
            g.Across = new Axis(reachUp - Math.Abs(across), across < 0 ? Neg(n) : n);
            return g;
        }

        /// <summary>Cross products of two box axes shorter than this are parallel axes: no separating axis of their own.</summary>
        private const double SatParallel = 1e-6;

        /// <summary>A frame's box as an oriented box in space: its centre (half its top up its own up from its base) and its three
        /// unit axes with half extents (heading laid on its up, the side, the up).</summary>
        private static OBox OrientedBox(Frame f)
        {
            var fw = InPlane(f.C, f.S, f.Up);
            var h = f.Top / 2;
            return new OBox { C = new GenexV3(f.B.X + f.Up.X * h, f.B.Y + f.Up.Y * h, f.B.Z + f.Up.Z * h), A0 = fw, A1 = Cross(f.Up, fw), A2 = f.Up, H0 = f.Hl, H1 = f.Hw, H2 = h };
        }

        private static GenexV3 AxisOf(OBox o, int i) => i == 0 ? o.A0 : i == 1 ? o.A1 : o.A2;

        /// <summary>Two frames on supports that are not parallel (§17.11 step 2): the two oriented boxes, each laid on its own up, by
        /// the separating axis test over the 15 axes (a's three, b's three, then each of a's crossed with each of b's, in that order;
        /// a near-zero cross product skipped); null when one separates them. The side axis is the least deep of all 15 (the minimum
        /// translation axis), the across axis the mean up itself.</summary>
        private static Geometry SatGeometry(Frame a, Frame b, in GenexV3 n)
        {
            var boxA = OrientedBox(a);
            var boxB = OrientedBox(b);
            var d = new GenexV3(boxB.C.X - boxA.C.X, boxB.C.Y - boxA.C.Y, boxB.C.Z - boxA.C.Z);
            var g = new Geometry { Plane = n, Level = false, D = d, Mode = Mode.Sat, FA = a, FB = b, BoxA = boxA, BoxB = boxB };
            var candidates = new List<GenexV3>(15);
            for (var i = 0; i < 3; i++) candidates.Add(AxisOf(boxA, i));
            for (var i = 0; i < 3; i++) candidates.Add(AxisOf(boxB, i));
            for (var i = 0; i < 3; i++)
            {
                for (var j = 0; j < 3; j++)
                {
                    var c = Cross(AxisOf(boxA, i), AxisOf(boxB, j));
                    var len = Math.Sqrt(Dot(c, c));
                    if (len > SatParallel) candidates.Add(new GenexV3(c.X / len, c.Y / len, c.Z / len));
                }
            }
            g.Axes = new List<Axis>(candidates.Count);
            var least = -1;
            foreach (var k in candidates)
            {
                var along = Dot(d, k);
                var depth = g.Half(k) - Math.Abs(along);
                if (depth <= 0) return null;
                g.Axes.Add(new Axis(depth, along < 0 ? Neg(k) : k));
                if (least < 0 || depth < g.Axes[least].Depth) least = g.Axes.Count - 1;
            }
            g.Side = g.Axes[least];
            g.SideIndex = least;
            var across = Dot(d, n);
            g.Across = new Axis(g.Half(n) - Math.Abs(across), across < 0 ? Neg(n) : n);
            return g;
        }

        /// <summary>The pair's geometry, or null when the two do not touch.</summary>
        private static Geometry GeometryOf(Frame a, Frame b)
        {
            var reach = DiagOf(a) + DiagOf(b);
            var reachUp = (a.Top + b.Top) / 2;
            var far = Math.Sqrt(reach * reach + reachUp * reachUp) + reachUp;
            if (Math.Abs(b.B.X - a.B.X) >= far || Math.Abs(b.B.Y - a.B.Y) >= far || Math.Abs(b.B.Z - a.B.Z) >= far) return null;
            if (a.Up.Z == 1 && b.Up.Z == 1) return LevelGeometry(a, b);
            if (a.Up.X == b.Up.X && a.Up.Y == b.Up.Y && a.Up.Z == b.Up.Z) return TiltedGeometry(a, b);
            var sum = new GenexV3(a.Up.X + b.Up.X, a.Up.Y + b.Up.Y, a.Up.Z + b.Up.Z);
            var len = Math.Sqrt(Dot(sum, sum));
            if (len < 1e-9) return null;
            return SatGeometry(a, b, new GenexV3(sum.X / len, sum.Y / len, sum.Z / len));
        }

        /// <summary>How fast b closes on a along n (from a to b): positive when closing.</summary>
        private static double ClosingAlong(GenexContactBody a, GenexContactBody b, in GenexV3 n) =>
            -((b.Vx - a.Vx) * n.X + (b.Vy - a.Vy) * n.Y + (b.Vz - a.Vz) * n.Z);

        /// <summary>How the pair entered (step 2): whether the across axis is its contact axis, and whether the pair landed across
        /// the plane (it came down within <c>EntryWindow</c> and less than halfway in, or, tilted, rests within the ground trace).</summary>
        private static bool EntersAcross(Geometry g, Frame a, Frame b, GenexContactPolicy policy)
        {
            var tUp = g.Across.Depth / JsMax(ClosingAlong(a.B, b.B, g.Across.N), policy.EntrySpeed);
            var cameDown = tUp <= policy.EntryWindow && g.Across.Depth <= (a.Top + b.Top) / 4;
            var landed = cameDown || (!g.Level && g.Across.Depth <= policy.GroundTrace);
            if (!landed) return false;
            var tSide = g.Side.Depth / JsMax(ClosingAlong(a.B, b.B, g.Side.N), policy.EntrySpeed);
            return tUp < tSide || (tUp == tSide && g.Across.Depth < g.Side.Depth);
        }

        /// <summary>A seat's tags: its own, and <c>flag:k</c> for each bit k set in its <c>flags</c>.</summary>
        public static List<string> TagsOf(GenexContactBody b)
        {
            var tags = new List<string>();
            if (b.Tags != null) tags.AddRange(b.Tags);
            for (var k = 0; k < 24; k++)
            {
                if (Math.Floor(b.Flags / (double)(1 << k)) % 2 == 1) tags.Add("flag:" + k);
            }
            return tags;
        }

        /// <summary>The first pair rule matching the two seats' tags (either way round), else the policy's top.</summary>
        public static GenexTopRule TopRuleOf(GenexContactPolicy policy, GenexContactBody a, GenexContactBody b)
        {
            if (policy.Pairs.Count == 0) return policy.Top;
            var ta = TagsOf(a);
            var tb = TagsOf(b);
            foreach (var r in policy.Pairs)
            {
                if ((ta.Contains(r.A) && tb.Contains(r.B)) || (ta.Contains(r.B) && tb.Contains(r.A))) return r.Top;
            }
            return policy.Top;
        }

        private sealed class Found
        {
            public GenexPairContact Contact;
            public Geometry G;
        }

        /// <summary>The contact of two seats and the geometry it came from; null when they do not touch.</summary>
        private static Found ContactOfFrames(Frame fa, Frame fb, GenexContactPolicy policy)
        {
            var g = GeometryOf(fa, fb);
            if (g == null) return RestingOf(fa, fb, policy);
            if (!EntersAcross(g, fa, fb, policy))
            {
                var side = new GenexPairContact { Kind = GenexContactKind.Side, N = g.Side.N, Depth = g.Side.Depth, UpperIsB = Dot(g.D, g.Plane) >= 0, SideAxis = g.SideIndex };
                return new Found { Contact = side, G = g };
            }
            var n = g.Across.N;
            // The across axis is the plane itself unless it was turned: then it points to b (upper) when it agrees with the plane.
            var upperIsB = ReferenceEqualsPlane(n, g.Plane) || Dot(n, g.Plane) > 0;
            var lower = upperIsB ? fa : fb;
            var toUpper = upperIsB ? n : Neg(n);
            // A top contact is a seat that came down onto another; two at rest across the plane (side by side up a wall, their
            // bodies deeper in its plane than across it) are pushed apart along it, half each.
            var top = Dot(toUpper, lower.Support) >= policy.SupportCos;
            return new Found { Contact = new GenexPairContact { Kind = top ? GenexContactKind.Top : GenexContactKind.Side, N = n, Depth = g.Across.Depth, UpperIsB = upperIsB }, G = g };
        }

        /// <summary>The TypeScript's <c>n === g.plane</c>: the across axis not turned (the same vector as the plane).</summary>
        private static bool ReferenceEqualsPlane(in GenexV3 n, in GenexV3 plane) => n.X == plane.X && n.Y == plane.Y && n.Z == plane.Z;

        /// <summary>A seat resting on another's top without touching it (step 2): the upper seat (the higher base) let down by the
        /// ground trace meets the lower one across the plane, the across axis shallower than the in-plane one and within
        /// <c>SupportCos</c> of the lower seat's support up, the lower seat can be stood on, and the upper seat is not leaving it
        /// (its speed away along that axis at most <c>EntrySpeed</c>). A top contact of depth at most 0 (the gap, negative).</summary>
        private static Found RestingOf(Frame fa, Frame fb, GenexContactPolicy policy)
        {
            var upperIsB = fb.B.Z >= fa.B.Z;
            var g = upperIsB ? GeometryOf(fa, Dropped(fb, policy.GroundTrace)) : GeometryOf(Dropped(fa, policy.GroundTrace), fb);
            if (g == null || !(g.Across.Depth < g.Side.Depth)) return null;
            var toUpper = upperIsB ? g.Across.N : Neg(g.Across.N);
            if (!(Dot(toUpper, g.Plane) > 0)) return null;
            var lower = upperIsB ? fa : fb;
            // Only on a lower seat that can be stood on: up a wall two seats a hair apart across its plane are side by side.
            if (lower.Support.Z < policy.SupportCos || Dot(toUpper, lower.Support) < policy.SupportCos) return null;
            var u = upperIsB ? fb.B : fa.B;
            var l = upperIsB ? fa.B : fb.B;
            if (-ClosingAlong(l, u, toUpper) > policy.EntrySpeed) return null;
            return new Found { Contact = new GenexPairContact { Kind = GenexContactKind.Top, N = g.Across.N, Depth = g.Across.Depth - policy.GroundTrace, UpperIsB = upperIsB }, G = g };
        }

        /// <summary>A frame with its seat's base let down by <paramref name="dz"/> (a copy of the seat).</summary>
        private static Frame Dropped(Frame f, double dz)
        {
            var copy = new GenexContactBody(f.B.Id);
            copy.CopyFrom(f.B);
            copy.Z = f.B.Z - dz;
            return new Frame { B = copy, Up = f.Up, Support = f.Support, Hl = f.Hl, Hw = f.Hw, Top = f.Top, S = f.S, C = f.C };
        }

        /// <summary>
        /// The contact of seats <paramref name="a"/> and <paramref name="b"/> under <paramref name="policy"/> (steps 1-3): its kind,
        /// axis (unit, from a to b), depth and which seat is upper; null when they do not touch.
        /// </summary>
        public static GenexPairContact ContactOf(GenexContactBody a, GenexContactBody b, GenexContactPolicy policy, GenexContactEnv env)
        {
            if (FarApart(a, b, policy)) return null;
            return ContactOfFrames(FrameOf(a, policy, env), FrameOf(b, policy, env), policy)?.Contact;
        }

        /// <summary>How far a seat's body reaches from its base, any way it is laid (its box's corner from the base).</summary>
        private static double ReachOf(GenexContactPolicy policy)
        {
            var shape = policy.Shape;
            if (shape.Kind == GenexContactShapeKind.Hull) return Math.Sqrt(2 * shape.Radius * shape.Radius + shape.Height * shape.Height);
            return Math.Sqrt(shape.Length * shape.Length / 4 + shape.Width * shape.Width / 4 + shape.Top * shape.Top);
        }

        /// <summary>Whether two seats' bases are too far apart for their bodies to touch, or one to rest on the other (the ground
        /// trace and a unit over): no frame is laid for them (each a cast down the world).</summary>
        private static bool FarApart(GenexContactBody a, GenexContactBody b, GenexContactPolicy policy)
        {
            var reach = 2 * ReachOf(policy) + policy.GroundTrace + 1;
            var dx = b.X - a.X;
            var dy = b.Y - a.Y;
            var dz = b.Z - a.Z;
            return dx * dx + dy * dy + dz * dz > reach * reach;
        }

        private static double Clamp(GenexContactPolicy policy, double v)
        {
            if (!policy.MaxVelocity.HasValue) return v;
            var m = policy.MaxVelocity.Value;
            return v < -m ? -m : v > m ? m : v;
        }

        private static GenexV3 BaseOf(GenexContactBody b) => new GenexV3(b.X, b.Y, b.Z);

        // ---- side contacts ----

        /// <summary>A face this close to a seat's support up (its cosine) is the ground it rides (a wall for a car on it).</summary>
        private const double GroundFace = 0.7;

        /// <summary>A push whose part along the seat's support up is under minus this (sin 30°) points into its ground; a shallower
        /// one passes the ground it rides, the push-out taking the rest.</summary>
        private const double GroundInto = 0.5;

        /// <summary>A side push slides along a wall it meets only within this of the push (cos 60°).</summary>
        private const double SideSlideCos = 0.5;

        /// <summary>How a seat takes a side push along unit d: straight up to the first wall its cast meets, then along that wall in
        /// the plane the seat rides when d has at least <c>SideSlideCos</c> of it; <c>Sep</c> how much of the push it takes.</summary>
        private struct SeatWay
        {
            public GenexV3 D;
            public double Straight;
            public bool HasSlide;
            public GenexV3 Slide;
            public double Cos, Sep;
        }

        private static GenexFaceFilter RidesOf(Frame f, GenexContactPolicy policy) => GenexFaceFilter.Rides(f.Support, policy.SupportCos);

        /// <summary>A seat's way at base p, riding the plane whose up is <paramref name="up"/>, for a push of <paramref name="depth"/>
        /// along d; faces <paramref name="rides"/> passes do not stop it.</summary>
        private static SeatWay SeatWayAt(GenexContactWorld world, in GenexV3 p, in GenexV3 d, double depth, in GenexFaceFilter rides, in GenexV3 up)
        {
            // A push into the ground the seat rides is stopped by it (the push-out would only lift the seat back).
            var hit = world.Cast(p, d, depth, Dot(d, up) < -GroundInto ? GenexFaceFilter.None : rides);
            var straight = hit.T;
            if (!hit.HasFace || !(straight < depth)) return new SeatWay { D = d, Straight = straight, Cos = 1, Sep = straight };
            var f = new GenexV3(hit.Face.Nx, hit.Face.Ny, hit.Face.Nz);
            if (!SlideOn(f, d, up, out var slide)) return new SeatWay { D = d, Straight = straight, Cos = 1, Sep = straight };
            var cos = Dot(slide, d);
            var from = new GenexV3(p.X + d.X * straight, p.Y + d.Y * straight, p.Z + d.Z * straight);
            var room = world.Cast(from, slide, (depth - straight) / cos, rides).T;
            return new SeatWay { D = d, Straight = straight, HasSlide = true, Slide = slide, Cos = cos, Sep = straight + room * cos };
        }

        /// <summary>The way along face f a push d that it stopped takes (unit), or false under <c>SideSlideCos</c> of d: along the
        /// seat's own ground (f within <c>GroundFace</c> of its up: a car on a wall pushed along it) the push laid in that face;
        /// along a wall the line where it meets the seat's plane (<c>cross(f, up)</c>, turned along d).</summary>
        private static bool SlideOn(in GenexV3 f, in GenexV3 d, in GenexV3 up, out GenexV3 slide)
        {
            slide = default;
            if (Dot(f, up) >= GroundFace)
            {
                var k = Dot(d, f);
                var vx = d.X - k * f.X;
                var vy = d.Y - k * f.Y;
                var vz = d.Z - k * f.Z;
                var len = Hypot(vx, vy, vz);
                if (!(len >= SideSlideCos)) return false;
                slide = new GenexV3(vx / len, vy / len, vz / len);
                return true;
            }
            var line = Cross(f, up);
            var ll = Hypot(line.X, line.Y, line.Z);
            var along = ll > 0 ? Dot(line, d) / ll : 0;
            if (!(Math.Abs(along) >= SideSlideCos)) return false;
            var kk = along > 0 ? 1 / ll : -1 / ll;
            slide = new GenexV3(line.X * kk, line.Y * kk, line.Z * kk);
            return true;
        }

        /// <summary>The move of a seat taking <paramref name="along"/> of a push its way (straight, then the slide for the rest).</summary>
        private static GenexV3 WayMove(in SeatWay w, double along)
        {
            var d = w.D;
            if (!w.HasSlide || !(along > w.Straight)) return new GenexV3(d.X * along, d.Y * along, d.Z * along);
            var rest = (along - w.Straight) / w.Cos;
            var u = w.Slide;
            return new GenexV3(d.X * w.Straight + u.X * rest, d.Y * w.Straight + u.Y * rest, d.Z * w.Straight + u.Z * rest);
        }

        /// <summary>The shares from two rooms (fractions of the push): b at most the rest of what a can take up to
        /// <paramref name="wantA"/> (half: equal masses), then a the rest of what b could not take.</summary>
        private static void SharesOf(double roomA, double roomB, double wantA, out double sa, out double sb)
        {
            sb = JsMin(roomB, 1 - JsMin(roomA, wantA));
            sa = JsMin(roomA, 1 - sb);
        }

        /// <summary>
        /// The shares of a side push of <paramref name="depth"/> along <paramref name="n"/> (from a to b) that a and b take (step
        /// 4): each the part of the push its way takes (straight to a wall, then along it in the plane it rides), a at most
        /// <paramref name="wantA"/> (half: equal masses), b at most the rest, then a the rest of what b could not take. Continuous
        /// in position. A face a seat rides does not stop its push: only walls and ceilings take a share away.
        /// </summary>
        public static void YieldShares(GenexContactBody a, GenexContactBody b, in GenexV3 n, double depth, GenexContactWorld world, in GenexFaceFilter ridesA, in GenexFaceFilter ridesB,
            in GenexV3 upA, in GenexV3 upB, double wantA, out double sa, out double sb)
        {
            if (world == null)
            {
                sa = wantA;
                sb = 1 - wantA;
                return;
            }
            var wa = SeatWayAt(world, BaseOf(a), Neg(n), depth, ridesA, upA);
            var wb = SeatWayAt(world, BaseOf(b), n, depth, ridesB, upB);
            SharesOf(wa.Sep / depth, wb.Sep / depth, wantA, out sa, out sb);
        }

        /// <summary>The part of a side push along n (from a to b) seat a would take before walls: half under <c>shared</c>; under
        /// <c>mover</c> its own share of the two closing speeds, half when neither closes.</summary>
        private static double WantOf(GenexContactBody a, GenexContactBody b, in GenexV3 n, GenexContactPolicy policy)
        {
            if (policy.Push != GenexContactPush.Mover) return 0.5;
            var va = a.Vx * n.X + a.Vy * n.Y;
            var vb = b.Vx * n.X + b.Vy * n.Y;
            if (n.Z != 0)
            {
                va += a.Vz * n.Z;
                vb += b.Vz * n.Z;
            }
            var wa = va > 0 ? va : 0;
            var wb = vb < 0 ? -vb : 0;
            return wa + wb > 0 ? wa / (wa + wb) : 0.5;
        }

        /// <summary>The shares of a pair's side push, a fixed seat (<c>env.Fixed</c>) taking none: the other takes what its way allows.</summary>
        private static void PairShares(Frame fa, Frame fb, in GenexV3 n, double depth, GenexContactPolicy policy, GenexContactEnv env, out double sa, out double sb)
        {
            YieldShares(fa.B, fb.B, n, depth, env.World, RidesOf(fa, policy), RidesOf(fb, policy), fa.Support, fb.Support, WantOf(fa.B, fb.B, n, policy), out sa, out sb);
            if (env.Fixed == null) return;
            if (fa.B.Id == env.Fixed)
            {
                sa = 0;
                sb = env.World == null ? 1 : SeatWayAt(env.World, BaseOf(fb.B), n, depth, RidesOf(fb, policy), fb.Support).Sep / depth;
            }
            else if (fb.B.Id == env.Fixed)
            {
                sa = env.World == null ? 1 : SeatWayAt(env.World, BaseOf(fa.B), Neg(n), depth, RidesOf(fa, policy), fa.Support).Sep / depth;
                sb = 0;
            }
        }

        /// <summary>A stable insertion sort (the TypeScript's Array.sort is stable) by a comparator returning a number.</summary>
        private static void StableSort<T>(List<T> list, Func<T, T, double> compare)
        {
            for (var i = 1; i < list.Count; i++)
            {
                var item = list[i];
                var j = i - 1;
                while (j >= 0 && compare(list[j], item) > 0)
                {
                    list[j + 1] = list[j];
                    j--;
                }
                list[j + 1] = item;
            }
        }

        /// <summary>A side push for a pair wedged along its contact axis (the two shares leave some of it): the next in-plane axis,
        /// least deep first, along which the two have room for the whole of its depth; else the contact axis with what is left split
        /// half each (the push-out after the pass takes it out of the walls).</summary>
        private static void WedgedPush(Frame fa, Frame fb, GenexPairContact c, Geometry g, GenexContactPolicy policy, GenexContactEnv env, out GenexV3 n, out double depth, out double sa, out double sb)
        {
            var others = new List<Axis>(g.Axes.Count);
            for (var i = 0; i < g.Axes.Count; i++)
            {
                if (i != c.SideAxis) others.Add(g.Axes[i]);
            }
            StableSort(others, (p, q) => p.Depth - q.Depth);
            foreach (var k in others)
            {
                PairShares(fa, fb, k.N, k.Depth, policy, env, out sa, out sb);
                if (!(sa + sb < 1))
                {
                    n = k.N;
                    depth = k.Depth;
                    return;
                }
            }
            PairShares(fa, fb, c.N, c.Depth, policy, env, out sa, out sb);
            var left = 1 - sa - sb;
            n = c.N;
            depth = c.Depth;
            if (fa.B.Id == env.Fixed) sb += left;
            else if (fb.B.Id == env.Fixed) sa += left;
            else
            {
                sa += left / 2;
                sb += left / 2;
            }
        }

        /// <summary>Seat b moved by m (z only when the move has a z part).</summary>
        private static void MoveBy(GenexContactBody b, in GenexV3 m)
        {
            b.X += m.X;
            b.Y += m.Y;
            if (m.Z != 0) b.Z += m.Z;
        }

        /// <summary>The two seats moved apart along n by their shares of depth, each its way (straight, then along the wall it meets;
        /// without a world straight along the axis).</summary>
        private static void PushApart(Frame fa, Frame fb, in GenexV3 n, double depth, double sa, double sb, GenexContactPolicy policy, GenexContactEnv env)
        {
            var world = env.World;
            var away = Neg(n);
            var wa = world == null ? new SeatWay { D = away, Straight = depth, Cos = 1, Sep = depth } : SeatWayAt(world, BaseOf(fa.B), away, depth, RidesOf(fa, policy), fa.Support);
            var wb = world == null ? new SeatWay { D = n, Straight = depth, Cos = 1, Sep = depth } : SeatWayAt(world, BaseOf(fb.B), n, depth, RidesOf(fb, policy), fb.Support);
            MoveBy(fa.B, WayMove(wa, depth * sa));
            MoveBy(fb.B, WayMove(wb, depth * sb));
        }

        /// <summary>A side contact (step 4): pushed apart by the yield shares, each seat its way, the parts of the velocities along
        /// the axis swapped keeping <c>Restitution</c> of the closing speed (none while cooling), and each seat's spin stopped when
        /// the policy says so. Returns the impulse along the axis, and the axis and depth actually pushed along.</summary>
        private static double SideContact(Frame fa, Frame fb, GenexPairContact contact, Geometry g, GenexContactPolicy policy, GenexContactEnv env, bool cooling, out GenexV3 pushN, out double pushDepth)
        {
            var a = fa.B;
            var b = fb.B;
            PairShares(fa, fb, contact.N, contact.Depth, policy, env, out var sa, out var sb);
            var n = contact.N;
            var depth = contact.Depth;
            if (sa + sb < 1) WedgedPush(fa, fb, contact, g, policy, env, out n, out depth, out sa, out sb);
            var closing = (b.Vx - a.Vx) * n.X + (b.Vy - a.Vy) * n.Y;
            if (n.Z != 0) closing += (b.Vz - a.Vz) * n.Z;
            var j = closing < 0 && !cooling ? (-(1 + policy.Restitution) * closing) / 2 : 0;
            // The impulse each takes: half each under `shared` (j), by the closing speeds under `mover`.
            var want = WantOf(a, b, n, policy);
            var ja = 2 * j * want;
            var jb = 2 * j * (1 - want);
            PushApart(fa, fb, n, depth, sa, sb, policy, env);
            a.Vx = Clamp(policy, a.Vx - ja * n.X);
            a.Vy = Clamp(policy, a.Vy - ja * n.Y);
            if (policy.StopSpin) a.Spin = 0;
            b.Vx = Clamp(policy, b.Vx + jb * n.X);
            b.Vy = Clamp(policy, b.Vy + jb * n.Y);
            if (policy.StopSpin) b.Spin = 0;
            if (n.Z != 0)
            {
                a.Vz = Clamp(policy, a.Vz - ja * n.Z);
                b.Vz = Clamp(policy, b.Vz + jb * n.Z);
            }
            pushN = n;
            pushDepth = depth;
            return j;
        }

        // ---- top contacts ----

        /// <summary>A unit in-plane way and how far the upper seat must move along it to clear the lower.</summary>
        private struct Way
        {
            public GenexV3 W;
            public double Move;
            public int K;
        }

        private static double CompareWays(Way x, Way y)
        {
            var c = x.Move - y.Move;
            return c == 0 || double.IsNaN(c) ? x.K - y.K : c;
        }

        /// <summary>The four slide candidates of a top contact (step 6 *free way*), from the lower seat toward the upper's side: (a)
        /// the in-plane least-overlap axis, (b) its opposite, (c) and (d) the two in-plane perpendiculars; each with the distance the
        /// upper seat must move along it to clear the lower, least first (ties keep the order).</summary>
        private static List<Way> WaysOf(Geometry g, bool upperIsB)
        {
            var w1 = upperIsB ? g.Side.N : Neg(g.Side.N);
            var off = upperIsB ? g.D : Neg(g.D);
            var p = Cross(g.Plane, w1);
            var ways = new List<Way>(4)
            {
                new Way { W = w1, Move = g.Half(w1) - Dot(off, w1), K = 0 },
                new Way { W = Neg(w1), Move = g.Half(Neg(w1)) - Dot(off, Neg(w1)), K = 1 },
                new Way { W = p, Move = g.Half(p) - Dot(off, p), K = 2 },
                new Way { W = Neg(p), Move = g.Half(Neg(p)) - Dot(off, Neg(p)), K = 3 },
            };
            StableSort(ways, CompareWays);
            return ways;
        }

        /// <summary>How far the upper seat must move along w to clear the lower one of a pair with geometry g.</summary>
        private static double ClearAlong(Geometry g, bool upperIsB, in GenexV3 w) => g.Half(w) - Dot(upperIsB ? g.D : Neg(g.D), w);

        /// <summary>The pairs' geometries of every other seat in <paramref name="others"/> the upper seat (frame upperF) rests on: a
        /// top contact with it above (a ghost pair aside).</summary>
        private static List<Geometry> SupportsOf(Frame upperF, GenexContactBody lower, IList<GenexContactBody> others, GenexContactPolicy policy, GenexContactEnv env)
        {
            var output = new List<Geometry>();
            foreach (var o in others)
            {
                if (ReferenceEquals(o, upperF.B) || ReferenceEquals(o, lower) || FarApart(upperF.B, o, policy) || TopRuleOf(policy, upperF.B, o).Policy == GenexTopPolicy.Ghost) continue;
                var found = ContactOfFrames(upperF, FrameOf(o, policy, env), policy);
                if (found != null && found.Contact.Kind == GenexContactKind.Top && !found.Contact.UpperIsB) output.Add(found.G);
            }
            return output;
        }

        /// <summary>The upper seat's ways (step 6 *free way*): the pair's four, each needing the move that clears every seat it rests
        /// on (<paramref name="supports"/>, the other lower seats), least first (ties keep the order).</summary>
        private static List<Way> UpperWaysOf(Geometry g, bool upperIsB, List<Geometry> supports)
        {
            if (supports.Count == 0) return WaysOf(g, upperIsB);
            var w1 = upperIsB ? g.Side.N : Neg(g.Side.N);
            var p = Cross(g.Plane, w1);
            var candidates = new[] { w1, Neg(w1), p, Neg(p) };
            var ways = new List<Way>(4);
            for (var k = 0; k < 4; k++)
            {
                var w = candidates[k];
                var move = ClearAlong(g, upperIsB, w);
                foreach (var s in supports) move = JsMax(move, ClearAlong(s, false, w));
                ways.Add(new Way { W = w, Move = move, K = k });
            }
            StableSort(ways, CompareWays);
            return ways;
        }

        /// <summary>Whether a seat can move <c>way.Move</c> along <c>way.W</c> without entering a grown solid (faces it rides pass).</summary>
        private static bool IsFree(GenexContactWorld world, Frame f, in Way way, GenexContactPolicy policy) =>
            way.Move <= 0 || GenexContactWorld.RoomAlong(world, BaseOf(f.B), way.W, way.Move, RidesOf(f, policy)) >= way.Move;

        /// <summary>Changes the body's velocity by j along w, x and y always written (clamped), z only when w leaves the ground's plane.</summary>
        private static void Kick(GenexContactBody body, in GenexV3 w, double j, GenexContactPolicy policy)
        {
            body.Vx = Clamp(policy, body.Vx + j * w.X);
            body.Vy = Clamp(policy, body.Vy + j * w.Y);
            if (w.Z != 0) body.Vz = Clamp(policy, body.Vz + j * w.Z);
        }

        /// <summary>The slide's velocity change for a parting along the way: up to <c>Speed</c>, by at most <c>Step</c>.</summary>
        private static double SlideStep(GenexSlideRule rule, double parting)
        {
            if (!(parting < rule.Speed)) return 0;
            var want = rule.Speed - parting;
            return rule.Step.HasValue ? JsMin(want, rule.Step.Value) : want;
        }

        private struct Slide
        {
            public double J;
            public GenexSlideWay Way;
            public GenexV3 W;
            public bool HasW;
        }

        private static double Parting(GenexContactBody p, GenexContactBody q, in GenexV3 w) => (p.Vx - q.Vx) * w.X + (p.Vy - q.Vy) * w.Y + (p.Vz - q.Vz) * w.Z;

        /// <summary>A top contact's slide (step 6 <c>slide</c>): frictionless, the pair parted along the upper seat's first free way
        /// up to the rule's speed by at most its step a tick, <c>Share</c> of it on the upper seat; when no way is free for it, the
        /// lower seat slides out along its own first free way (all of it on the lower); when neither is, the pair stands (pinned).</summary>
        private static Slide SlideOff(Frame upperF, Frame lowerF, Geometry g, bool upperIsB, GenexSlideRule rule, GenexContactPolicy policy, GenexContactEnv env, IList<GenexContactBody> others)
        {
            var upper = upperF.B;
            var lower = lowerF.B;
            var ways = WaysOf(g, upperIsB);
            var upperWays = UpperWaysOf(g, upperIsB, SupportsOf(upperF, lower, others, policy, env));
            foreach (var way in upperWays)
            {
                if (!IsFree(env.World, upperF, way, policy)) continue;
                var j = SlideStep(rule, Parting(upper, lower, way.W));
                Kick(upper, way.W, j * rule.Share, policy);
                if (rule.Share != 1) Kick(lower, way.W, -j * (1 - rule.Share), policy);
                return new Slide { J = j, Way = GenexSlideWay.Free, W = way.W, HasW = true };
            }
            foreach (var way in ways)
            {
                var own = new Way { W = Neg(way.W), Move = way.Move };
                if (!IsFree(env.World, lowerF, own, policy)) continue;
                var j = SlideStep(rule, Parting(lower, upper, own.W));
                Kick(lower, own.W, j, policy);
                return new Slide { J = j, Way = GenexSlideWay.LowerYields, W = own.W, HasW = true };
            }
            return new Slide { J = 0, Way = GenexSlideWay.Pinned };
        }

        /// <summary>The upper seat set on the lower's top (step 5), its base moved along the contact's normal (<paramref name="up"/>,
        /// from the lower to the upper) by depth plus the roof skin; what the world does not let it take, the lower seat takes the
        /// other way. Level: its base at the lower's base plus the lower's top.</summary>
        private static void PlaceOnTop(GenexContactBody upper, GenexContactBody lower, in GenexV3 up, double depth, Geometry g, double lowerTop, GenexContactPolicy policy, GenexContactEnv env)
        {
            var need = depth + policy.RoofSkin;
            // A resting seat (depth at most −roofSkin) is already on the top: it is never pulled down onto it.
            if (!(need > 0)) return;
            var room = upper.Id == env.Fixed ? 0 : GenexContactWorld.RoomAlong(env.World, BaseOf(upper), up, need, GenexFaceFilter.None);
            if (room >= need && g.Level)
            {
                upper.Z = lower.Z + lowerTop + policy.RoofSkin;
                return;
            }
            upper.X += up.X * room;
            upper.Y += up.Y * room;
            upper.Z += up.Z * room;
            if (room >= need) return;
            var rest = lower.Id == env.Fixed ? 0 : GenexContactWorld.RoomAlong(env.World, BaseOf(lower), Neg(up), need - room, GenexFaceFilter.None);
            lower.X -= up.X * rest;
            lower.Y -= up.Y * rest;
            lower.Z -= up.Z * rest;
        }

        /// <summary>The upper seat's velocity along <paramref name="up"/> raised to the lower's when it was closing (it stops on it).</summary>
        private static void StopOnTop(GenexContactBody upper, GenexContactBody lower, in GenexV3 up)
        {
            var vu = upper.Vx * up.X + upper.Vy * up.Y + upper.Vz * up.Z;
            var vl = lower.Vx * up.X + lower.Vy * up.Y + lower.Vz * up.Z;
            if (!(vu < vl)) return;
            if (up.X == 0 && up.Y == 0)
            {
                upper.Vz = lower.Vz;
                return;
            }
            upper.Vx += up.X * (vl - vu);
            upper.Vy += up.Y * (vl - vu);
            upper.Vz += up.Z * (vl - vu);
        }

        /// <summary>A stomp (step 6 <c>bounce</c>): the upper seat's velocity along <paramref name="up"/> set to the bounce speed.</summary>
        private static void Bounce(GenexContactBody upper, in GenexV3 up, double speed)
        {
            var vu = upper.Vx * up.X + upper.Vy * up.Y + upper.Vz * up.Z;
            upper.Vx += up.X * (speed - vu);
            upper.Vy += up.Y * (speed - vu);
            upper.Vz += up.Z * (speed - vu);
        }

        /// <summary>How far seat <paramref name="upper"/>'s centre is off seat <paramref name="lower"/>'s, as a share of the lower's half
        /// extent: the larger of the two in the lower's heading frame (Chebyshev for a hull's square footprint).</summary>
        public static double HeadOffset(GenexContactBody upper, GenexContactBody lower, GenexContactPolicy policy)
        {
            var dx = upper.X - lower.X;
            var dy = upper.Y - lower.Y;
            var shape = policy.Shape;
            if (shape.Kind == GenexContactShapeKind.Hull) return JsMax(Math.Abs(dx), Math.Abs(dy)) / shape.Radius;
            GenexPresets.PSinCos(lower.Yaw, out var s, out var c);
            return JsMax(Math.Abs(dx * c + dy * s) / (shape.Length / 2), Math.Abs(dy * c - dx * s) / (shape.Width / 2));
        }

        /// <summary>How fast the lower seat moves away from under the upper in the plane (its velocity along the way from the upper's centre to its own): a lower that carries its rider never parts them; the upper's own speed never counts.</summary>
        private static double LeavingOf(GenexContactBody upper, GenexContactBody lower, bool ride)
        {
            if (ride) return 0;
            var dx = upper.X - lower.X;
            var dy = upper.Y - lower.Y;
            var len = Math.Sqrt(dx * dx + dy * dy);
            if (!(len > 0)) return 0;
            return -(lower.Vx * dx + lower.Vy * dy) / len;
        }

        /// <summary>The least closing speed on a head that is a landing (u/s).</summary>
        public const double HeadLandingSpeed = 100;

        /// <summary>
        /// The stand test (§17.11 step 6 <c>stand</c>, and the head slabs): how seat <paramref name="upper"/>, over seat
        /// <paramref name="lower"/> whose pair rule is the stand <paramref name="rule"/>, is held. <c>Center</c> null: it stands. Else a
        /// seat within <c>Center</c> of the lower's half extent stands; a landing beyond it slides; a resting seat beyond it already
        /// parting at half its slide's step (the speed when the step is null) or more is released; else it slides once its centre is
        /// past the footprint and stands until then.
        /// </summary>
        public static GenexHeadHold HeadHold(GenexContactBody upper, GenexContactBody lower, GenexTopRule rule, GenexContactPolicy policy)
        {
            if (rule.Center == null) return GenexHeadHold.Stand;
            var u = HeadOffset(upper, lower, policy);
            if (u <= rule.Center.Value) return GenexHeadHold.Stand;
            var landing = lower.Vz - upper.Vz > HeadLandingSpeed;
            if (landing) return GenexHeadHold.Slide;
            if (LeavingOf(upper, lower, rule.Ride) >= (rule.Slide.Step ?? rule.Slide.Speed) / 2) return GenexHeadHold.Release;
            return u > 1 ? GenexHeadHold.Slide : GenexHeadHold.Stand;
        }

        /// <summary>Whether seat <paramref name="upper"/> stands on seat <paramref name="lower"/> under <paramref name="rule"/> (it gets the slab).</summary>
        public static bool HeadStands(GenexContactBody upper, GenexContactBody lower, GenexTopRule rule, GenexContactPolicy policy) =>
            rule.Policy == GenexTopPolicy.Stand && HeadHold(upper, lower, rule, policy) == GenexHeadHold.Stand;

        /// <summary>The z of a seat's support up (below <c>SupportCos</c>: it cannot be stood on).</summary>
        public static double SupportZ(GenexContactBody b, GenexContactPolicy policy, GenexContactEnv env) => SupportOf(b, policy, env).Z;

        /// <summary>A top contact (steps 5 and 6).</summary>
        private static Slide TopContact(Frame fa, Frame fb, GenexPairContact c, Geometry g, GenexTopRule rule, GenexContactPolicy policy, GenexContactEnv env, IList<GenexContactBody> others)
        {
            var upperF = c.UpperIsB ? fb : fa;
            var lowerF = c.UpperIsB ? fa : fb;
            var upper = upperF.B;
            var lower = lowerF.B;
            var up = c.UpperIsB ? c.N : Neg(c.N);
            var closing = ClosingAlong(lower, upper, up);
            // The stand test reads the pair as it came in: a landing is told by its closing speed.
            var slides = rule.Policy == GenexTopPolicy.Stand && HeadHold(upper, lower, rule, policy) == GenexHeadHold.Slide;
            PlaceOnTop(upper, lower, up, c.Depth, g, lowerF.Top, policy, env);
            StopOnTop(upper, lower, up);
            if (lowerF.Support.Z < policy.SupportCos) return SlideOff(upperF, lowerF, g, c.UpperIsB, policy.OffWall, policy, env, others);
            if (rule.Policy == GenexTopPolicy.Stand) return slides ? SlideOff(upperF, lowerF, g, c.UpperIsB, rule.Slide, policy, env, others) : default;
            if (rule.Policy == GenexTopPolicy.Slide) return SlideOff(upperF, lowerF, g, c.UpperIsB, rule.Slide, policy, env, others);
            if (rule.Policy == GenexTopPolicy.Bounce && closing >= rule.StompMin)
            {
                Bounce(upper, up, rule.BounceSpeed + (upper.Jump != 0 && !double.IsNaN(upper.Jump) ? rule.JumpBoost : 0));
                env.OnContact?.Invoke(upper, lower, GenexContactEvent.Stomp);
                return default;
            }
            return rule.Policy == GenexTopPolicy.Bounce ? SlideOff(upperF, lowerF, g, c.UpperIsB, rule.Slide, policy, env, others) : default;
        }

        private static readonly GenexContactBody[] NoSeats = new GenexContactBody[0];

        /// <summary>
        /// Two seats a and b (a the lower id) under <paramref name="policy"/> (steps 1-6), changed in place: a ghost pair or two that
        /// do not touch are left as they are (null); a side contact is pushed apart; a top contact is set on the lower seat's top and
        /// runs its pair's top policy. <paramref name="cooling"/> holds a side contact's impulse back. <paramref name="others"/>: the
        /// rest of the pass's seats, whose tops an upper seat also rests on (its free way clears them all).
        /// </summary>
        public static GenexPairOutcome ContactPair(GenexContactBody a, GenexContactBody b, GenexContactPolicy policy, GenexContactEnv env, bool cooling = false, IList<GenexContactBody> others = null)
        {
            var rule = TopRuleOf(policy, a, b);
            if (rule.Policy == GenexTopPolicy.Ghost || FarApart(a, b, policy)) return null;
            var fa = FrameOf(a, policy, env);
            var fb = FrameOf(b, policy, env);
            var found = ContactOfFrames(fa, fb, policy);
            if (found == null) return null;
            var contact = found.Contact;
            var outcome = new GenexPairOutcome { Kind = contact.Kind, N = contact.N, Depth = contact.Depth, UpperIsB = contact.UpperIsB, SideAxis = contact.SideAxis };
            if (contact.Kind == GenexContactKind.Side)
            {
                outcome.J = SideContact(fa, fb, contact, found.G, policy, env, cooling, out var n, out var depth);
                outcome.N = n;
                outcome.Depth = depth;
                return outcome;
            }
            var slide = TopContact(fa, fb, contact, found.G, rule, policy, env, others ?? NoSeats);
            outcome.J = slide.J;
            outcome.Way = slide.Way;
            outcome.W = slide.W;
            outcome.HasW = slide.HasW;
            return outcome;
        }

        // ---- the pass ----

        /// <summary>Whether a later pass runs a pair again: a side contact deeper than slop, or a stack at all (one set on another's
        /// roof and moved back into it by a third: setting it again is exact and costs one step).</summary>
        private static bool StillTouching(GenexPairContact c, GenexContactPolicy policy) =>
            c != null && (c.Depth > policy.Slop || (c.Kind == GenexContactKind.Top && c.Depth > 0));

        /// <summary>One pass over every pair (a the lower id): pass 0 every pair, later passes only those deeper than slop. Whether it touched any.</summary>
        private static bool PassOnce(IList<GenexContactBody> seats, int pass, GenexContactPolicy policy, GenexContactEnv env, GenexContactReport report)
        {
            var touched = false;
            for (var i = 0; i < seats.Count; i++)
            {
                for (var k = i + 1; k < seats.Count; k++)
                {
                    var a = seats[i];
                    var b = seats[k];
                    if (pass > 0 && !StillTouching(ContactOf(a, b, policy, env), policy)) continue;
                    var outcome = ContactPair(a, b, policy, env, false, seats);
                    if (outcome == null) continue;
                    touched = true;
                    if (outcome.Way == GenexSlideWay.Pinned) report.Pinned += 1;
                }
            }
            return touched;
        }

        /// <summary>
        /// The contact pass (step 7) over <paramref name="seats"/> (ids ascending, changed in place): every pair in id order, then a
        /// pile's further passes, up to <c>policy.Passes</c>, on the pairs still more than <c>Slop</c> inside each other; after every
        /// pass that touched, every seat the contacts drove into the world pushed back out (§17.7 *Starting inside*).
        /// </summary>
        public static GenexContactReport ContactPass(IList<GenexContactBody> seats, GenexContactPolicy policy, GenexContactEnv env)
        {
            var report = new GenexContactReport();
            for (var pass = 0; pass < policy.Passes; pass++)
            {
                if (!PassOnce(seats, pass, policy, env, report)) break;
                report.Passes += 1;
                if (env.World == null) continue;
                foreach (var seat in seats)
                {
                    var id = seat.Id;
                    var depth = env.World.Unstick(seat, face =>
                    {
                        report.Walls.TryGetValue(id, out var known);
                        if (face.Nz < policy.SupportCos && face.E > known) report.Walls[id] = face.E;
                    });
                    report.Pushed.TryGetValue(id, out var deepest);
                    if (depth > deepest) report.Pushed[id] = depth;
                }
            }
            return report;
        }

        /// <summary>The policy as a seat contact rule on two seats (<c>GenexAuthorityOptions.Contacts</c>, the drawing guard): one pair step.</summary>
        public static GenexContactRule ContactRuleOf(GenexContactPolicy policy, GenexContactEnv env) => (a, b) => ContactPair(a, b, policy, env);

        /// <summary>The policy as a whole seat contact pass (<c>GenexAuthorityOptions.ContactPass</c>).</summary>
        public static GenexSeatPass ContactPassOf(GenexContactPolicy policy, GenexContactEnv env) => seats => ContactPass(seats, policy, env);

        // ---- the stand ride ----

        /// <summary>Whether seat <paramref name="upper"/> stands on seat <paramref name="lower"/>: their pair rule is <c>stand</c>, the
        /// lower seat's support can be stood on, and the upper seat let down by the ground trace meets the lower across the plane from
        /// above, within <c>SupportCos</c> of its support up (resting there, never moving in).</summary>
        private static bool StandsOn(GenexContactBody upper, GenexContactBody lower, GenexContactPolicy policy, GenexContactEnv env)
        {
            var rule = TopRuleOf(policy, upper, lower);
            if (rule.Policy != GenexTopPolicy.Stand || !rule.Ride) return false;
            var fl = FrameOf(lower, policy, env);
            if (fl.Support.Z < policy.SupportCos) return false;
            var lowered = new GenexContactBody(upper.Id);
            lowered.CopyFrom(upper);
            lowered.Z = upper.Z - policy.GroundTrace;
            var g = GeometryOf(fl, FrameOf(lowered, policy, env));
            if (g == null || !(Dot(g.Across.N, g.Plane) > 0)) return false;
            return Dot(g.Across.N, fl.Support) >= policy.SupportCos;
        }

        /// <summary>Whether a seat's base stands on kinematic body k: inside its footprint, within <paramref name="trace"/> over its top.</summary>
        private static bool OnKinematic(GenexContactBody b, GenexKinematicSupport k, double trace)
        {
            var over = b.Z - k.Max.Z;
            return b.X >= k.Min.X && b.X <= k.Max.X && b.Y >= k.Min.Y && b.Y <= k.Max.Y && over >= -trace && over <= trace;
        }

        /// <summary>What seat b stands on, from the seats and supports as they are (none: null).</summary>
        private static GenexRide RideOf(GenexContactBody b, IList<GenexContactBody> seats, IList<GenexKinematicSupport> supports, GenexContactPolicy policy, GenexContactEnv env, double tickHz)
        {
            foreach (var k in supports)
            {
                if (OnKinematic(b, k, policy.GroundTrace)) return new GenexRide { Id = b.Id, On = k.Key, V = new GenexV3(k.Dp.X * tickHz, k.Dp.Y * tickHz, 0) };
            }
            foreach (var o in seats)
            {
                if (!ReferenceEquals(o, b) && StandsOn(b, o, policy, env)) return new GenexRide { Id = b.Id, On = o.Id, V = new GenexV3(o.Vx, o.Vy, 0) };
            }
            return null;
        }

        /// <summary>
        /// The <c>stand</c> ride (step 6, run in the seat-rule slot before the tick's preset steps): each seat standing on a kinematic
        /// body or on a seat whose pair rule is <c>stand</c> is carried by its support's velocity for the tick (1 / tickHz; a
        /// kinematic body's move to the next tick); a seat leaving it upward (<c>Vz &gt; 0</c>) keeps that velocity. Every ride is found
        /// from the seats as they were before any moved (ids ascending). Changes x y (vx vy on leaving) in place; returns the rides.
        /// </summary>
        public static List<GenexRide> RideStep(IList<GenexContactBody> seats, IList<GenexKinematicSupport> supports, GenexContactPolicy policy, GenexContactEnv env, double tickHz)
        {
            var before = new List<GenexContactBody>(seats.Count);
            foreach (var s in seats)
            {
                var copy = new GenexContactBody(s.Id);
                copy.CopyFrom(s);
                before.Add(copy);
            }
            var rides = new List<GenexRide>();
            for (var i = 0; i < seats.Count; i++)
            {
                var ride = RideOf(before[i], before, supports, policy, env, tickHz);
                if (ride == null) continue;
                var seat = seats[i];
                seat.X += ride.V.X / tickHz;
                seat.Y += ride.V.Y / tickHz;
                if (seat.Vz > 0)
                {
                    seat.Vx += ride.V.X;
                    seat.Vy += ride.V.Y;
                }
                rides.Add(ride);
            }
            return rides;
        }
    }
}
