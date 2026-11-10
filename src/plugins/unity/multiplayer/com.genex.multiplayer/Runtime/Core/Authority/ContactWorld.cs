// The static world as the contact policy sees it (PROTOCOL.md §17.11 *Contact policy*), a port of
// packages/multiplayer/src/authority/contact-world.ts: §17.7's boxes and ramps grown by a seat's hull into convex solids of
// planes, a cast along a straight line through them (a body's room before a wall, and whether a way is free), the surface
// under a point (a seat's support up) and §17.7's *Starting inside* push-out. Plain float64 in the TypeScript's order (no
// fused multiply-add, Math.Sqrt only), no trigonometry. ContactPolicy.cs runs on it;
// packages/netcode-bench/conformance/authority/contact-policy.json holds it (GenexSmoke `contact-policy`).
// Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A 3-vector, room units.</summary>
    public readonly struct GenexV3
    {
        public readonly double X, Y, Z;

        public GenexV3(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public static readonly GenexV3 Up = new GenexV3(0, 0, 1);
        public static readonly GenexV3 Down = new GenexV3(0, 0, -1);

        public static GenexV3 operator -(GenexV3 p) => new GenexV3(-p.X, -p.Y, -p.Z);

        public static double Dot(GenexV3 p, GenexV3 q) => p.X * q.X + p.Y * q.Y + p.Z * q.Z;

        public static GenexV3 Cross(GenexV3 p, GenexV3 q) => new GenexV3(p.Y * q.Z - p.Z * q.Y, p.Z * q.X - p.X * q.Z, p.X * q.Y - p.Y * q.X);
    }

    /// <summary>One face of a grown solid: a point p is inside it when <c>n · p &lt; e</c> (n of unit length).</summary>
    public readonly struct GenexPlane
    {
        public readonly double Nx, Ny, Nz, E;

        public GenexPlane(double nx, double ny, double nz, double e)
        {
            Nx = nx;
            Ny = ny;
            Nz = nz;
            E = e;
        }
    }

    /// <summary>A grown solid: its planes (a box's six, a ramp's seven, the bottom last) and its bounds.</summary>
    public sealed class GenexContactSolid
    {
        public readonly GenexPlane[] Planes;
        public readonly GenexV3 Min, Max;

        public GenexContactSolid(GenexPlane[] planes, GenexV3 min, GenexV3 max)
        {
            Planes = planes;
            Min = min;
            Max = max;
        }
    }

    /// <summary>The faces a cast passes through: the surface a seat rides (its preset follows it), never a wall. The default
    /// (<see cref="None"/>) passes none. A face is ridden when its z is at least <c>cos</c> and it is within <c>cos</c> of the
    /// seat's support up (PROTOCOL.md §17.11 step 4).</summary>
    public readonly struct GenexFaceFilter
    {
        private readonly bool active;
        private readonly GenexV3 up;
        private readonly double cos;

        private GenexFaceFilter(GenexV3 up, double cos)
        {
            active = true;
            this.up = up;
            this.cos = cos;
        }

        /// <summary>No face is ridden: every face stops a cast.</summary>
        public static GenexFaceFilter None => default;

        /// <summary>The faces a body whose support up is <paramref name="up"/> rides.</summary>
        public static GenexFaceFilter Rides(GenexV3 up, double cos) => new GenexFaceFilter(up, cos);

        public bool Passes(in GenexPlane face) => active && face.Nz >= cos && face.Nx * up.X + face.Ny * up.Y + face.Nz * up.Z >= cos;
    }

    /// <summary>Where a line first enters a solid: the distance along it and the face it crosses (<see cref="HasFace"/>).</summary>
    public readonly struct GenexCastHit
    {
        public readonly double T;
        public readonly GenexPlane Face;
        public readonly bool HasFace;

        public GenexCastHit(double t, GenexPlane face, bool hasFace)
        {
            T = t;
            Face = face;
            HasFace = hasFace;
        }
    }

    /// <summary>A world compiled for one hull: every solid grown by it, and the clearance kept from a surface.</summary>
    public sealed class GenexContactWorld
    {
        /// <summary>Solids one push-out may move a body out of in turn (a corner is two walls and the floor).</summary>
        public const int UnstickSolids = 4;

        public readonly GenexContactSolid[] Solids;

        /// <summary>A point is inside a solid only when it is more than this inside every plane (the preset's skin).</summary>
        public readonly double Skin;

        /// <summary>The solids by where they stand (null: a query visits every solid).</summary>
        private readonly SolidGrid grid;

        /// <summary>Whether this world visits its solids through a grid (a world of few solids does not).</summary>
        public bool HasGrid => grid != null;

        public GenexContactWorld(GenexContactSolid[] solids, double skin)
        {
            Solids = solids;
            Skin = skin;
            grid = GridOf(solids);
        }

        private GenexContactWorld(GenexContactSolid[] solids, double skin, SolidGrid grid)
        {
            Solids = solids;
            Skin = skin;
            this.grid = grid;
        }

        /// <summary>The same solids visited whole, for a check that a query answers the same through the grid.</summary>
        public GenexContactWorld WithoutGrid() => new GenexContactWorld(Solids, Skin, null);

        /// <summary>How far outside its bounds a cast still tests a solid (SegmentNear's margin).</summary>
        private const double CastMargin = 1;
        /// <summary>A world of fewer solids is visited whole: a grid saves nothing there.</summary>
        private const int GridMinSolids = 32;
        /// <summary>The grid's cells a side at most, and its smallest cell (room units).</summary>
        private const double GridSide = 32;
        private const double GridCellMin = 64;
        /// <summary>A solid on more cells than this is visited by every query instead.</summary>
        private const int GridWide = 64;
        /// <summary>A query whose box spans more cells than this visits every solid.</summary>
        private const int GridQueryCells = 16;

        /// <summary>A world's solids on an x/y grid, so a cast or a point query visits the solids whose footprint it can reach rather
        /// than every one: cell (i, j) covers [X0 + i·Size, X0 + (i + 1)·Size) on x (the edge cells reach on to the world's ends), and
        /// holds every solid whose bounds grown by the cast's margin meet it, ascending; a solid on too many cells is on Wide alone,
        /// which every query visits. Only where a query visits solids changes, never what it answers (§17.7 lets a port skip what
        /// cannot).</summary>
        private sealed class SolidGrid
        {
            public double X0, Y0, Size;
            public int Nx, Ny;
            /// <summary>Cell (i, j) is c = i + j·Nx: its solids are CellSolids from CellStart[c] up to CellStart[c + 1].</summary>
            public int[] CellStart, CellSolids;
            /// <summary>The solids too wide for the cells (a floor, a map-long wall), ascending.</summary>
            public int[] Wide;
        }

        private static bool Finite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        /// <summary>Whether a solid's bounds are finite on x and y (a grid can place it).</summary>
        private static bool Placeable(GenexContactSolid s) => Finite(s.Min.X) && Finite(s.Max.X) && Finite(s.Min.Y) && Finite(s.Max.Y);

        /// <summary>The cell of coordinate v on an axis from origin with n cells (clamped: monotone in v).</summary>
        private static int CellOf(double v, double origin, double size, int n)
        {
            var c = Math.Floor((v - origin) / size);
            if (c < 0) return 0;
            return c > n - 1 ? n - 1 : (int)c;
        }

        /// <summary>The cells a solid is on; false when it is on Wide.</summary>
        private static bool CellsOf(GenexContactSolid s, SolidGrid g, out int i0, out int i1, out int j0, out int j1)
        {
            i0 = i1 = j0 = j1 = 0;
            if (!Placeable(s)) return false;
            i0 = CellOf(s.Min.X - CastMargin, g.X0, g.Size, g.Nx);
            i1 = CellOf(s.Max.X + CastMargin, g.X0, g.Size, g.Nx);
            j0 = CellOf(s.Min.Y - CastMargin, g.Y0, g.Size, g.Ny);
            j1 = CellOf(s.Max.Y + CastMargin, g.Y0, g.Size, g.Ny);
            return (i1 - i0 + 1) * (j1 - j0 + 1) <= GridWide;
        }

        /// <summary>The grid of a world's solids, or null for a world too small to need one, or too wide to measure.</summary>
        private static SolidGrid GridOf(GenexContactSolid[] solids)
        {
            var placed = 0;
            double x0 = double.PositiveInfinity, y0 = double.PositiveInfinity, x1 = double.NegativeInfinity, y1 = double.NegativeInfinity;
            foreach (var s in solids)
            {
                if (!Placeable(s)) continue;
                placed++;
                x0 = Math.Min(x0, s.Min.X - CastMargin);
                y0 = Math.Min(y0, s.Min.Y - CastMargin);
                x1 = Math.Max(x1, s.Max.X + CastMargin);
                y1 = Math.Max(y1, s.Max.Y + CastMargin);
            }
            if (placed < GridMinSolids) return null;
            var size = Math.Max(GridCellMin, Math.Max((x1 - x0) / GridSide, (y1 - y0) / GridSide));
            if (!Finite(size)) return null;
            var g = new SolidGrid { X0 = x0, Y0 = y0, Size = size };
            g.Nx = (int)Math.Min(GridSide, Math.Floor((x1 - x0) / size) + 1);
            g.Ny = (int)Math.Min(GridSide, Math.Floor((y1 - y0) / size) + 1);
            var start = new int[g.Nx * g.Ny + 1];
            var wide = new List<int>();
            for (var k = 0; k < solids.Length; k++)
            {
                if (!CellsOf(solids[k], g, out var i0, out var i1, out var j0, out var j1))
                {
                    wide.Add(k);
                    continue;
                }
                for (var j = j0; j <= j1; j++)
                {
                    for (var i = i0; i <= i1; i++) start[i + j * g.Nx + 1]++;
                }
            }
            for (var c = 0; c < g.Nx * g.Ny; c++) start[c + 1] += start[c];
            var cells = new int[start[g.Nx * g.Ny]];
            var written = (int[])start.Clone();
            for (var k = 0; k < solids.Length; k++)
            {
                if (!CellsOf(solids[k], g, out var i0, out var i1, out var j0, out var j1)) continue;
                for (var j = j0; j <= j1; j++)
                {
                    for (var i = i0; i <= i1; i++) cells[written[i + j * g.Nx]++] = k;
                }
            }
            g.CellStart = start;
            g.CellSolids = cells;
            g.Wide = wide.ToArray();
            return g;
        }

        /// <summary>a and b from <paramref name="from"/> up to <paramref name="to"/>, two ascending index lists, as one, ascending, each index once.</summary>
        private static int[] MergeAscending(int[] a, int[] b, int from, int to)
        {
            if (to == from) return a;
            var o = new int[a.Length + (to - from)];
            int n = 0, i = 0, k = from;
            while (i < a.Length || k < to)
            {
                var fromA = k >= to || (i < a.Length && a[i] <= b[k]);
                var next = fromA ? a[i++] : b[k++];
                if (n == 0 || o[n - 1] != next) o[n++] = next;
            }
            if (n == o.Length) return o;
            var cut = new int[n];
            Array.Copy(o, cut, n);
            return cut;
        }

        /// <summary>The solids (indices, ascending) whose cells meet the x/y box [lx, hx] × [ly, hy], or null when every solid must be
        /// visited: no grid, a box not finite (NaN meets every solid), or one too large.</summary>
        private int[] SolidsNear(double lx, double hx, double ly, double hy)
        {
            var g = grid;
            if (g == null || !(Finite(lx) && Finite(hx) && Finite(ly) && Finite(hy))) return null;
            var i0 = CellOf(lx, g.X0, g.Size, g.Nx);
            var i1 = CellOf(hx, g.X0, g.Size, g.Nx);
            var j0 = CellOf(ly, g.Y0, g.Size, g.Ny);
            var j1 = CellOf(hy, g.Y0, g.Size, g.Ny);
            if ((i1 - i0 + 1) * (j1 - j0 + 1) > GridQueryCells) return null;
            var near = g.Wide;
            for (var j = j0; j <= j1; j++)
            {
                for (var i = i0; i <= i1; i++)
                {
                    var c = i + j * g.Nx;
                    near = MergeAscending(near, g.CellSolids, g.CellStart[c], g.CellStart[c + 1]);
                }
            }
            return near;
        }

        /// <summary>Whether (x, y, z) is inside any solid of this world.</summary>
        public bool InsideWorld(double x, double y, double z)
        {
            var near = SolidsNear(x, x, y, y);
            var n = near == null ? Solids.Length : near.Length;
            for (var m = 0; m < n; m++)
            {
                if (InsidePlanes(Solids[near == null ? m : near[m]].Planes, Skin, x, y, z)) return true;
            }
            return false;
        }

        /// <summary>A box grown by the hull (half side r on x and y, height h under the base): §17.7's slab.</summary>
        private static GenexPlane[] GrownBox(double[] b, double r, double h) => new[]
        {
            new GenexPlane(-1, 0, 0, -(b[0] - r)),
            new GenexPlane(1, 0, 0, b[3] + r),
            new GenexPlane(0, -1, 0, -(b[1] - r)),
            new GenexPlane(0, 1, 0, b[4] + r),
            new GenexPlane(0, 0, 1, b[5]),
            new GenexPlane(0, 0, -1, -(b[2] - h)),
        };

        /// <summary>A ramp grown by the hull: §17.7's wedge, its top plane moved out by r along the slope.</summary>
        private static GenexPlane[] GrownRamp(double[] ramp, double r, double h)
        {
            var axis = ramp[6];
            var m0 = axis == 0 ? ramp[0] : ramp[1];
            var slope = (ramp[8] - ramp[7]) / ((axis == 0 ? ramp[3] : ramp[4]) - m0);
            var k = 1 / Math.Sqrt(slope * slope + 1);
            var e = (ramp[7] - slope * m0 + r * Math.Abs(slope)) * k;
            var top = axis == 0 ? new GenexPlane(-slope * k, 0, k, e) : new GenexPlane(0, -slope * k, k, e);
            return new[]
            {
                new GenexPlane(1, 0, 0, ramp[3] + r), new GenexPlane(-1, 0, 0, -ramp[0] + r), new GenexPlane(0, 1, 0, ramp[4] + r),
                new GenexPlane(0, -1, 0, -ramp[1] + r), top, new GenexPlane(0, 0, 1, ramp[5]), new GenexPlane(0, 0, -1, -ramp[2] + h),
            };
        }

        private static GenexContactSolid SolidOf(GenexPlane[] planes, double[] src, double r, double h) =>
            new GenexContactSolid(planes, new GenexV3(src[0] - r, src[1] - r, src[2] - h), new GenexV3(src[3] + r, src[4] + r, src[5]));

        /// <summary>
        /// The world (<paramref name="boxes"/> <c>[x0 y0 z0 x1 y1 z1]</c> then <paramref name="ramps"/>
        /// <c>[x0 y0 z0 x1 y1 z1 axis lo hi]</c>) grown by a hull of half side <paramref name="r"/> and height
        /// <paramref name="h"/>: boxes first, then ramps, each solid's bottom face last. A point closer than
        /// <paramref name="skin"/> to a face is outside.
        /// </summary>
        public static GenexContactWorld Compile(IEnumerable<double[]> boxes, IEnumerable<double[]> ramps, double r, double h, double skin)
        {
            var solids = new List<GenexContactSolid>();
            if (boxes != null) foreach (var b in boxes) solids.Add(SolidOf(GrownBox(b, r, h), b, r, h));
            if (ramps != null) foreach (var b in ramps) solids.Add(SolidOf(GrownRamp(b, r, h), b, r, h));
            return new GenexContactWorld(solids.ToArray(), skin);
        }

        /// <summary>Whether (x, y, z) is more than <paramref name="skin"/> inside every plane of <paramref name="planes"/>.</summary>
        private static bool InsidePlanes(GenexPlane[] planes, double skin, double x, double y, double z)
        {
            foreach (var p in planes)
            {
                if (!(p.E - (p.Nx * x + p.Ny * y + p.Nz * z) > skin)) return false;
            }
            return true;
        }

        /// <summary>Whether the segment p + t·d, t in [0, len], can meet the solid's bounds.</summary>
        private static bool SegmentNear(GenexContactSolid s, in GenexV3 p, in GenexV3 d, double len)
        {
            for (var i = 0; i < 3; i++)
            {
                var pi = i == 0 ? p.X : i == 1 ? p.Y : p.Z;
                var di = i == 0 ? d.X : i == 1 ? d.Y : d.Z;
                var mn = i == 0 ? s.Min.X : i == 1 ? s.Min.Y : s.Min.Z;
                var mx = i == 0 ? s.Max.X : i == 1 ? s.Max.Y : s.Max.Z;
                var a = pi;
                var b = a + di * len;
                var lo = a < b ? a : b;
                var hi = a < b ? b : a;
                if (hi < mn - 1 || lo > mx + 1) return false;
            }
            return true;
        }

        /// <summary>A segment that starts within skin of solid s (inside its clearance, not inside it) is stopped at once when it
        /// goes deeper through a face it is that close to, else never.</summary>
        private static bool BandHit(GenexContactSolid s, double skin, in GenexV3 p, in GenexV3 d, in GenexFaceFilter rides, out GenexCastHit hit)
        {
            foreach (var plane in s.Planes)
            {
                var margin = plane.E - (plane.Nx * p.X + plane.Ny * p.Y + plane.Nz * p.Z);
                if (margin <= skin && plane.Nx * d.X + plane.Ny * d.Y + plane.Nz * d.Z < 0 && !rides.Passes(plane))
                {
                    hit = new GenexCastHit(0, plane, true);
                    return true;
                }
            }
            hit = default;
            return false;
        }

        /// <summary>Where p + t·d (t in [0, len]) comes within skin of solid s (the clearance a body keeps from a surface), or
        /// false when it never does. A solid p is more than skin inside is skipped: the push-out, not the cast, takes a body out of it.</summary>
        private static bool EnterSolid(GenexContactSolid s, double skin, in GenexV3 p, in GenexV3 d, double len, in GenexFaceFilter rides, out GenexCastHit hit)
        {
            hit = default;
            if (InsidePlanes(s.Planes, skin, p.X, p.Y, p.Z)) return false;
            if (InsidePlanes(s.Planes, -skin, p.X, p.Y, p.Z)) return BandHit(s, skin, p, d, rides, out hit);
            double lo = 0;
            var hi = len;
            // The entry face is the entering plane met last, even at or behind the start: a point left exactly the skin off a
            // face rounds either side of it, and going deeper it is stopped there at once.
            var last = double.NegativeInfinity;
            var face = default(GenexPlane);
            var haveFace = false;
            foreach (var plane in s.Planes)
            {
                var s0 = plane.E + skin - (plane.Nx * p.X + plane.Ny * p.Y + plane.Nz * p.Z);
                var sd = plane.Nx * d.X + plane.Ny * d.Y + plane.Nz * d.Z;
                if (sd == 0)
                {
                    if (!(s0 > 0)) return false;
                    continue;
                }
                var t = s0 / sd;
                if (sd > 0 && t < hi) hi = t;
                if (sd < 0 && t > last)
                {
                    last = t;
                    face = plane;
                    haveFace = true;
                }
            }
            if (last > lo) lo = last;
            if (!haveFace || !(lo < hi) || rides.Passes(face)) return false;
            hit = new GenexCastHit(lo, face, true);
            return true;
        }

        /// <summary>
        /// The first solid the segment from <paramref name="p"/> along unit <paramref name="d"/> meets within
        /// <paramref name="len"/>: the distance to where it comes within skin of it, and that face; <c>T = len</c> with no face when
        /// it is clear. Solids are visited in order; a tie keeps the earlier. A solid p is already inside is skipped, and so is one
        /// the segment would enter through a face <paramref name="rides"/> passes.
        /// </summary>
        public GenexCastHit Cast(in GenexV3 p, in GenexV3 d, double len, in GenexFaceFilter rides)
        {
            var best = new GenexCastHit(len, default, false);
            if (!(len > 0)) return new GenexCastHit(0, default, false);
            // The grid's solids by the segment's box at its whole length (SegmentNear's, a superset of every shorter one's), in
            // order: the very solids the full visit would test.
            double ex = p.X + d.X * len, ey = p.Y + d.Y * len;
            var finite = Finite(p.X) && Finite(p.Y) && Finite(ex) && Finite(ey);
            var near = finite ? SolidsNear(Math.Min(p.X, ex), Math.Max(p.X, ex), Math.Min(p.Y, ey), Math.Max(p.Y, ey)) : null;
            var count = near == null ? Solids.Length : near.Length;
            for (var m = 0; m < count; m++)
            {
                var s = Solids[near == null ? m : near[m]];
                if (!SegmentNear(s, p, d, best.T)) continue;
                if (EnterSolid(s, Skin, p, d, best.T, rides, out var hit) && hit.T < best.T) best = hit;
            }
            return best;
        }

        /// <summary>How far a body's base at <paramref name="p"/> can move along unit <paramref name="d"/> before a grown solid,
        /// clamped to [0, len]; faces <paramref name="rides"/> passes do not stop it. A null world is no stop.</summary>
        public static double RoomAlong(GenexContactWorld world, in GenexV3 p, in GenexV3 d, double len, in GenexFaceFilter rides)
        {
            if (world == null) return len;
            var t = world.Cast(p, d, len, rides).T;
            return t < 0 ? 0 : t;
        }

        /// <summary>The support up of a body whose base is at (x, y, z) (step 1): the normal of the first face a cast straight down
        /// meets within <paramref name="trace"/>, else world up (in the air). A cast starting inside a solid ignores that solid.</summary>
        public static GenexV3 SurfaceUp(GenexContactWorld world, double x, double y, double z, double trace)
        {
            if (world == null) return GenexV3.Up;
            var hit = world.Cast(new GenexV3(x, y, z), GenexV3.Down, trace, GenexFaceFilter.None);
            if (!hit.HasFace || !(hit.Face.Nz > 0)) return GenexV3.Up;
            return new GenexV3(hit.Face.Nx, hit.Face.Ny, hit.Face.Nz);
        }

        /// <summary>A face that points up, of solid <paramref name="self"/>, is no way out when another solid covers it (§17.7
        /// *Starting inside*: a wall's top under the ceiling, a pocket's side wall under its roof).</summary>
        private bool Covered(int self, double x, double y, double z, double qx, double qy, double qz)
        {
            var near = SolidsNear(qx, qx, qy, qy);
            var n = near == null ? Solids.Length : near.Length;
            for (var m = 0; m < n; m++)
            {
                var j = near == null ? m : near[m];
                if (j == self) continue;
                var planes = Solids[j].Planes;
                if (InsidePlanes(planes, Skin, qx, qy, qz) && !InsidePlanes(planes, Skin, x, y, z)) return true;
            }
            return false;
        }

        /// <summary>The least deep face of solid <paramref name="i"/> but the bottom (and but an up face another solid covers): a
        /// tie keeps the earlier. Depth is the face's fourth value.</summary>
        private GenexPlane? LeastFace(int i, double x, double y, double z)
        {
            var planes = Solids[i].Planes;
            GenexPlane? least = null;
            for (var k = 0; k < planes.Length - 1; k++)
            {
                var p = planes[k];
                var depth = p.E - (p.Nx * x + p.Ny * y + p.Nz * z);
                if (least.HasValue && !(depth < least.Value.E)) continue;
                if (p.Nz > 0 && Covered(i, x, y, z, x + p.Nx * depth, y + p.Ny * depth, z + p.Nz * depth)) continue;
                least = new GenexPlane(p.Nx, p.Ny, p.Nz, depth);
            }
            return least;
        }

        /// <summary>The face a body at (x, y, z) is pushed out of the first solid it is inside through (§17.7 *Starting inside*),
        /// as [nx, ny, nz, depth] (<see cref="GenexPlane.E"/> the depth); null when it is clear.</summary>
        public GenexPlane? InsideFace(double x, double y, double z)
        {
            var near = SolidsNear(x, x, y, y);
            var n = near == null ? Solids.Length : near.Length;
            for (var m = 0; m < n; m++)
            {
                var i = near == null ? m : near[m];
                if (InsidePlanes(Solids[i].Planes, Skin, x, y, z)) return LeastFace(i, x, y, z);
            }
            return null;
        }

        /// <summary>A body's base the contacts left inside the world, pushed back out with the skin's clearance (x y z changed in
        /// place), up to <see cref="UnstickSolids"/> solids in turn; returns the deepest push (0: it was clear).
        /// <paramref name="onFace"/> hears each face it is pushed out through, with the depth in <see cref="GenexPlane.E"/>.</summary>
        public double Unstick(GenexContactBody body, Action<GenexPlane> onFace = null)
        {
            double x = body.X, y = body.Y, z = body.Z;
            double deepest = 0;
            for (var n = 0; n < UnstickSolids; n++)
            {
                var found = InsideFace(x, y, z);
                if (!found.HasValue) break;
                var face = found.Value;
                onFace?.Invoke(face);
                var depth = face.E;
                deepest = depth > deepest ? depth : deepest;
                x += face.Nx * (depth + Skin);
                y += face.Ny * (depth + Skin);
                z += face.Nz * (depth + Skin);
            }
            if (deepest > 0)
            {
                body.X = x;
                body.Y = y;
                body.Z = z;
            }
            return deepest;
        }
    }
}
