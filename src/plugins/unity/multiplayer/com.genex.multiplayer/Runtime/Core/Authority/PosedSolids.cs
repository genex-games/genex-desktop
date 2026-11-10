// Posed solids (PROTOCOL.md §17.7 *Posed solids*): a port of packages/multiplayer/src/authority/presets.ts' posed section. A solid
// posed for one tick beside the static world (a lift at its pose, a head slab): an axis-aligned box, a box turned about z (an obox),
// or an upright disc. The firstperson and vehicle steps visit them after the static solids, in order, never through the tree.
// An obox grown by the square hull is a convex prism swept by wedge's plane method; a disc is two boxes and four upright
// cylinders, swept piece by piece. `GenexHullOps` is the hull the lift slots ask for the support, inside and push-out tests
// (§17.11 *Lifts*). Same float64 operations in the same order as the reference; no FMA, JS min/max. Engine-agnostic.
using System;

namespace Genex.Multiplayer.Authority
{
    /// <summary>The kind of a posed solid.</summary>
    public enum GenexPosedKind : byte { Box = 0, OBox = 1, Disc = 2 }

    /// <summary>A solid posed for one tick: a box <c>[Min, Max]</c>, a box of half extents <c>Half</c> about <c>C</c> turned by the
    /// angle whose sine and cosine are given, or a disc of <c>Radius</c> about <c>C</c> with half height <c>HalfZ</c>.</summary>
    public sealed class GenexPosedSolid
    {
        public GenexPosedKind Kind;
        public GenexV3 Min, Max, C, Half;
        public double Sin, Cos, Radius, HalfZ;

        public static GenexPosedSolid Box(GenexV3 min, GenexV3 max) => new GenexPosedSolid { Kind = GenexPosedKind.Box, Min = min, Max = max };

        public static GenexPosedSolid OBox(GenexV3 c, GenexV3 half, double sin, double cos) => new GenexPosedSolid { Kind = GenexPosedKind.OBox, C = c, Half = half, Sin = sin, Cos = cos };

        public static GenexPosedSolid Disc(GenexV3 c, double radius, double half) => new GenexPosedSolid { Kind = GenexPosedKind.Disc, C = c, Radius = radius, HalfZ = half };
    }

    /// <summary>A tick's posed solids compiled for the step: one flat table per field, in the order given. <c>Min*</c> and
    /// <c>Max*</c> are each solid's bounds (an obox's or a disc's box around it).</summary>
    public sealed class GenexPosedWorld
    {
        /// <summary>Posed solids a tick may hold at most (32 lifts and a head slab for each of 64 seats).</summary>
        public const int Max = 96;

        public static readonly GenexPosedWorld Empty = new GenexPosedWorld(new GenexPosedSolid[0]);

        public readonly int Count;
        public readonly GenexPosedKind[] Kind;
        public readonly double[] MinX, MinY, MinZ, MaxX, MaxY, MaxZ, CX, CY, HX, HY, Sin, Cos, Radius;

        public GenexPosedWorld(System.Collections.Generic.IList<GenexPosedSolid> solids)
        {
            var n = solids.Count;
            if (n > Max) throw new ArgumentException("posed solids: at most " + Max + " a tick");
            Count = n;
            Kind = new GenexPosedKind[n];
            MinX = new double[n]; MinY = new double[n]; MinZ = new double[n]; MaxX = new double[n]; MaxY = new double[n]; MaxZ = new double[n];
            CX = new double[n]; CY = new double[n]; HX = new double[n]; HY = new double[n]; Sin = new double[n]; Cos = new double[n]; Radius = new double[n];
            for (var i = 0; i < n; i++)
            {
                var s = solids[i];
                if (s.Kind == GenexPosedKind.Box)
                {
                    Kind[i] = GenexPosedKind.Box;
                    MinX[i] = s.Min.X; MinY[i] = s.Min.Y; MinZ[i] = s.Min.Z;
                    MaxX[i] = s.Max.X; MaxY[i] = s.Max.Y; MaxZ[i] = s.Max.Z;
                    continue;
                }
                CX[i] = s.C.X;
                CY[i] = s.C.Y;
                var halfZ = s.Kind == GenexPosedKind.Disc ? s.HalfZ : s.Half.Z;
                MinZ[i] = s.C.Z - halfZ;
                MaxZ[i] = s.C.Z + halfZ;
                if (s.Kind == GenexPosedKind.Disc)
                {
                    Kind[i] = GenexPosedKind.Disc;
                    Radius[i] = s.Radius;
                    MinX[i] = s.C.X - s.Radius; MaxX[i] = s.C.X + s.Radius;
                    MinY[i] = s.C.Y - s.Radius; MaxY[i] = s.C.Y + s.Radius;
                    continue;
                }
                Kind[i] = GenexPosedKind.OBox;
                HX[i] = s.Half.X;
                HY[i] = s.Half.Y;
                Sin[i] = s.Sin;
                Cos[i] = s.Cos;
                var ac = Math.Abs(s.Cos);
                var asin = Math.Abs(s.Sin);
                var ex = s.Half.X * ac + s.Half.Y * asin;
                var ey = s.Half.X * asin + s.Half.Y * ac;
                MinX[i] = s.C.X - ex; MaxX[i] = s.C.X + ex;
                MinY[i] = s.C.Y - ey; MaxY[i] = s.C.Y + ey;
            }
        }
    }

    public static partial class GenexFirstperson
    {
        /// <summary>The posed solids whose bounds, grown by the hull's radius on x and y, could meet the query's box (the tree's own
        /// test and margin), in order.</summary>
        internal static void QueryPosed(Hull m, double qx0, double qy0, double qz0, double qx1, double qy1, double qz1)
        {
            var p = m.P;
            var n = 0;
            if (p.Count > 0)
            {
                var margin = QueryMargin(qx0, qy0, qz0, qx1, qy1, qz1);
                var pad = m.R + margin;
                double x0 = qx0 - pad, x1 = qx1 + pad, y0 = qy0 - pad, y1 = qy1 + pad, z0 = qz0 - margin, z1 = qz1 + margin;
                for (var j = 0; j < p.Count; j++)
                {
                    if (p.MaxX[j] < x0 || p.MinX[j] > x1 || p.MaxY[j] < y0 || p.MinY[j] > y1 || p.MaxZ[j] < z0 || p.MinZ[j] > z1) continue;
                    m.PC[n++] = j;
                }
            }
            m.NPosed = n;
        }

        private const int OBoxPlanes = 10, OBoxBottom = 8, OBoxTop = 9;

        /// <summary>Posed obox j's plane <paramref name="plane"/> grown by the hull, in order (u+, u-, v+, v-, x+, x-, y+, y-, the
        /// bottom, the top), u the box's heading (cos, sin) and v across it: into <c>Plane</c>.</summary>
        private static void OBoxPlane(Hull m, int j, int plane, double height)
        {
            var p = m.P;
            var c = p.Cos[j];
            var s = p.Sin[j];
            var cx = p.CX[j];
            var cy = p.CY[j];
            var hx = p.HX[j];
            var hy = p.HY[j];
            var r = m.R;
            var reach = r * (Math.Abs(c) + Math.Abs(s));
            double nx = 0, ny = 0, nz = 0, e;
            switch (plane)
            {
                case 0: nx = c; ny = s; e = c * cx + s * cy + hx + reach; break;
                case 1: nx = -c; ny = -s; e = -(c * cx + s * cy) + hx + reach; break;
                case 2: nx = -s; ny = c; e = -s * cx + c * cy + hy + reach; break;
                case 3: nx = s; ny = -c; e = s * cx - c * cy + hy + reach; break;
                case 4: nx = 1; e = cx + r + hx * Math.Abs(c) + hy * Math.Abs(s); break;
                case 5: nx = -1; e = -cx + r + hx * Math.Abs(c) + hy * Math.Abs(s); break;
                case 6: ny = 1; e = cy + r + hx * Math.Abs(s) + hy * Math.Abs(c); break;
                case 7: ny = -1; e = -cy + r + hx * Math.Abs(s) + hy * Math.Abs(c); break;
                case 8: nz = -1; e = -p.MinZ[j] + height; break;
                default: nz = 1; e = p.MaxZ[j]; break;
            }
            m.Plane[0] = nx;
            m.Plane[1] = ny;
            m.Plane[2] = nz;
            m.Plane[3] = e;
        }

        /// <summary>Posed solid j's footprint strictly overlaps the hull's at (px, py).</summary>
        internal static bool PosedOverlaps(Hull m, int j, double px, double py)
        {
            var p = m.P;
            var r = m.R;
            if (!(px + r > p.MinX[j] && px - r < p.MaxX[j] && py + r > p.MinY[j] && py - r < p.MaxY[j])) return false;
            var kind = p.Kind[j];
            if (kind == GenexPosedKind.Box) return true;
            var dx = px - p.CX[j];
            var dy = py - p.CY[j];
            if (kind == GenexPosedKind.Disc)
            {
                var ax = Math.Max(Math.Abs(dx) - r, 0);
                var ay = Math.Max(Math.Abs(dy) - r, 0);
                return ax * ax + ay * ay < p.Radius[j] * p.Radius[j];
            }
            var c = p.Cos[j];
            var s = p.Sin[j];
            var reach = r * (Math.Abs(c) + Math.Abs(s));
            return Math.Abs(c * dx + s * dy) < p.HX[j] + reach && Math.Abs(-s * dx + c * dy) < p.HY[j] + reach;
        }

        /// <summary>A disc's grown footprint: how far (px, py) is inside it (negative: outside), and the outward unit normal of its
        /// nearest side into <c>Plane[0..1]</c>.</summary>
        private static double DiscDepth(Hull m, int j, double px, double py)
        {
            var p = m.P;
            var r = m.R;
            var dx = px - p.CX[j];
            var dy = py - p.CY[j];
            var adx = Math.Abs(dx);
            var ady = Math.Abs(dy);
            var bigR = p.Radius[j];
            if (adx <= r && ady <= r)
            {
                // Inside the hull-sized square at the centre: out along the axis it is furthest along (x on a tie).
                var alongX = adx >= ady;
                m.Plane[0] = alongX ? (dx < 0 ? -1 : 1) : 0;
                m.Plane[1] = alongX ? 0 : dy < 0 ? -1 : 1;
                return bigR + r - (alongX ? adx : ady);
            }
            var qx = adx > r ? (dx < 0 ? -(adx - r) : adx - r) : 0;
            var qy = ady > r ? (dy < 0 ? -(ady - r) : ady - r) : 0;
            var len = Math.Sqrt(qx * qx + qy * qy);
            m.Plane[0] = qx / len;
            m.Plane[1] = qy / len;
            return bigR - len;
        }

        /// <summary><c>Inside</c> for posed solid j: the point is more than skin inside every face of it grown by the hull.</summary>
        internal static bool PosedInside(Hull m, double px, double py, double pz, int j, double height)
        {
            var p = m.P;
            var skin = m.Skin;
            var kind = p.Kind[j];
            if (kind == GenexPosedKind.Box)
            {
                var r = m.R;
                return px - (p.MinX[j] - r) > skin && p.MaxX[j] + r - px > skin && py - (p.MinY[j] - r) > skin && p.MaxY[j] + r - py > skin && pz - (p.MinZ[j] - height) > skin && p.MaxZ[j] - pz > skin;
            }
            if (!(pz - (p.MinZ[j] - height) > skin && p.MaxZ[j] - pz > skin)) return false;
            if (kind == GenexPosedKind.Disc) return DiscDepth(m, j, px, py) > skin;
            for (var plane = 0; plane < OBoxBottom; plane++)
            {
                OBoxPlane(m, j, plane, height);
                var nx = m.Plane[0];
                var ny = m.Plane[1];
                if (!(-(nx * px + ny * py - m.Plane[3]) * (1 / Math.Sqrt(nx * nx + ny * ny)) > skin)) return false;
            }
            return true;
        }

        /// <summary>An obox's plane sweep (wedge's method over <see cref="OBoxPlane"/>): on a hit, TMin, the normal and Depth.</summary>
        private static bool OBoxSweep(Hull m, double px, double py, double pz, double dx, double dy, double dz, int j, int i, double height)
        {
            var enter = 0.0;
            var leave = 1.0;
            var taken = false;
            var inside = true;
            var least = double.PositiveInfinity;
            double lx = 0, ly = 0, lz = 0;
            m.Depth = 0;
            for (var plane = 0; plane < OBoxPlanes; plane++)
            {
                // wedge's arithmetic: each plane's normal made unit (a turned face's is only near it).
                OBoxPlane(m, j, plane, height);
                var nx = m.Plane[0];
                var ny = m.Plane[1];
                var nz = m.Plane[2];
                var ox = nx * px;
                var oy = ny * py;
                var oz = nz * pz;
                var dist = ox + oy + oz - m.Plane[3];
                var mx = nx * dx;
                var my = ny * dy;
                var mz = nz * dz;
                var motion = mx + my + mz;
                var nn = Dot(nx, ny, nz, nx, ny, nz);
                var k = 1 / Math.Sqrt(nn);
                var depth = -dist * k;
                if (!(depth > m.Skin)) inside = false;
                else if (plane != OBoxBottom && depth < least && !(inside && plane == OBoxTop && LidCovered(m, px, py, pz, nx * k, ny * k, nz * k, depth, i, height)))
                {
                    least = depth;
                    lx = nx * k;
                    ly = ny * k;
                    lz = nz * k;
                }
                if (Math.Abs(motion) < 0.000000001)
                {
                    if (dist > 0) return false;
                    continue;
                }
                var t = motion < 0 && dist <= 0 && dist > -m.Skin ? 0 : -dist / motion;
                if (motion < 0)
                {
                    if (t >= enter)
                    {
                        enter = t;
                        m.NX = nx * k;
                        m.NY = ny * k;
                        m.NZ = nz * k;
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

        /// <summary>An upright cylinder of radius <paramref name="bigR"/> about (ox, oy), its z from z0 to z1: the point's entry along
        /// the move (the circle, then z, as slab takes its axes); on a hit, TMin and the normal.</summary>
        private static bool Cylinder(Hull m, double px, double py, double pz, double dx, double dy, double dz, double ox, double oy, double bigR, double z0, double z1)
        {
            m.TMin = 0;
            m.TMax = 1;
            m.Ax = -1;
            m.Sg = 0;
            var ex = px - ox;
            var ey = py - oy;
            var a = dx * dx + dy * dy;
            var c = ex * ex + ey * ey - bigR * bigR;
            if (a < 0.000000000000000001)
            {
                if (!(c < 0)) return false;
            }
            else
            {
                var b = ex * dx + ey * dy;
                var disc = b * b - a * c;
                if (disc < 0) return false;
                var sq = Math.Sqrt(disc);
                var t1 = (-b - sq) / a;
                var t2 = (-b + sq) / a;
                if (t1 >= m.TMin)
                {
                    m.TMin = t1;
                    m.Ax = 3;
                }
                if (t2 < m.TMax) m.TMax = t2;
                if (m.TMin > m.TMax) return false;
            }
            if (!SlabAxis(m, pz, dz, z0, z1, 2)) return false;
            if (m.TMin >= 1 || m.Ax < 0) return false;
            if (m.Ax == 3)
            {
                var hx = ex + dx * m.TMin;
                var hy = ey + dy * m.TMin;
                var len = Math.Sqrt(hx * hx + hy * hy);
                m.NX = hx / len;
                m.NY = hy / len;
                m.NZ = 0;
            }
            else
            {
                m.NX = 0;
                m.NY = 0;
                m.NZ = m.Sg;
            }
            return true;
        }

        /// <summary>A disc's sweep: Starting inside (its nearest side, or its top when shallower and not covered; never its bottom),
        /// else the earliest of the cross's boxes, then the corner cylinders (-x-y, +x-y, -x+y, +x+y), a tie keeping the earlier piece.</summary>
        private static bool DiscSweep(Hull m, double px, double py, double pz, double dx, double dy, double dz, int j, int i, double height)
        {
            var p = m.P;
            var r = m.R;
            var bigR = p.Radius[j];
            var cx = p.CX[j];
            var cy = p.CY[j];
            var z0 = p.MinZ[j] - height;
            var z1 = p.MaxZ[j];
            m.Depth = 0;
            var side = DiscDepth(m, j, px, py);
            var lz = pz - z0;
            var hz = z1 - pz;
            if (side > m.Skin && lz > m.Skin && hz > m.Skin)
            {
                m.TMin = 0;
                if (hz < side && !Covered(m, px, py, pz + hz, px, py, pz, i, height))
                {
                    m.NX = 0; m.NY = 0; m.NZ = 1; m.Depth = hz;
                }
                else
                {
                    m.NX = m.Plane[0]; m.NY = m.Plane[1]; m.NZ = 0; m.Depth = side;
                }
                return true;
            }
            var found = false;
            double bt = 0, bx = 0, by = 0, bz = 0;
            for (var k = 0; k < 2; k++)
            {
                var minX = k == 0 ? cx - bigR : cx;
                var maxX = k == 0 ? cx + bigR : cx;
                var minY = k == 0 ? cy : cy - bigR;
                var maxY = k == 0 ? cy : cy + bigR;
                if (Slab(m, px, py, pz, dx, dy, dz, minX, minY, p.MinZ[j], maxX, maxY, z1, i, height) && (!found || m.TMin < bt))
                {
                    found = true;
                    bt = m.TMin;
                    bx = m.NX;
                    by = m.NY;
                    bz = m.NZ;
                }
            }
            for (var k = 0; k < 4; k++)
            {
                var ox = k % 2 == 0 ? cx - r : cx + r;
                var oy = k < 2 ? cy - r : cy + r;
                if (Cylinder(m, px, py, pz, dx, dy, dz, ox, oy, bigR, z0, z1) && (!found || m.TMin < bt))
                {
                    found = true;
                    bt = m.TMin;
                    bx = m.NX;
                    by = m.NY;
                    bz = m.NZ;
                }
            }
            if (!found) return false;
            m.TMin = bt;
            m.NX = bx;
            m.NY = by;
            m.NZ = bz;
            m.Depth = 0;
            return true;
        }

        /// <summary><c>Sweep</c>'s test for posed solid i (index <c>W.Count + j</c>).</summary>
        internal static bool PosedSweep(Hull m, double px, double py, double pz, double dx, double dy, double dz, int i, double height)
        {
            var j = i - m.W.Count;
            var p = m.P;
            var kind = p.Kind[j];
            if (kind == GenexPosedKind.Box) return Slab(m, px, py, pz, dx, dy, dz, p.MinX[j], p.MinY[j], p.MinZ[j], p.MaxX[j], p.MaxY[j], p.MaxZ[j], i, height);
            if (kind == GenexPosedKind.OBox) return OBoxSweep(m, px, py, pz, dx, dy, dz, j, i, height);
            return DiscSweep(m, px, py, pz, dx, dy, dz, j, i, height);
        }
    }

    /// <summary>A seat's body as the lift slots ask the hull about it.</summary>
    public struct GenexHullBody
    {
        public double X, Y, Z, VZ, Duck;
    }

    /// <summary>What the lift slots ask of a preset's hull, against the world and a tick's posed solids (presets.ts <c>hullOps</c>).</summary>
    public sealed class GenexHullOps
    {
        private readonly bool vehicle;
        private readonly GenexFirstpersonWorld world;
        private readonly double r, standHeight, crouchHeight, stepHeight, standable, groundTrace, groundSnap, skin;
        private readonly GenexFirstperson.Hull hull = new GenexFirstperson.Hull();

        public GenexHullOps(GenexFirstpersonParams p, GenexFirstpersonWorld world)
        {
            vehicle = false;
            this.world = world ?? GenexFirstpersonWorld.Empty;
            r = (float)p.Radius;
            standHeight = (float)p.StandHeight;
            crouchHeight = (float)p.CrouchHeight;
            stepHeight = (float)p.StepHeight;
            standable = (float)p.Standable;
            groundTrace = (float)p.GroundTrace;
            groundSnap = (float)p.GroundSnap;
            skin = (float)p.Skin;
        }

        public GenexHullOps(GenexVehicleParams p, GenexFirstpersonWorld world)
        {
            vehicle = true;
            this.world = world ?? GenexFirstpersonWorld.Empty;
            r = (float)p.Radius;
            standHeight = (float)p.Height;
            crouchHeight = (float)p.Height;
            stepHeight = (float)p.StepHeight;
            standable = (float)p.Standable;
            groundTrace = (float)p.GroundTrace;
            groundSnap = (float)p.GroundSnap;
            skin = (float)p.Skin;
        }

        /// <summary>The hull at <paramref name="body"/> among <paramref name="solids"/>.</summary>
        private GenexFirstperson.Hull HullOf(GenexHullBody body, GenexPosedWorld solids)
        {
            var m = hull;
            m.Reset(world.Tables);
            m.P = solids;
            m.R = r;
            m.Unit = GenexFirstperson.UnitOf(r, vehicle ? 50.0 : 16.0);
            m.StandHeight = standHeight;
            m.CrouchHeight = crouchHeight;
            m.StepHeight = stepHeight;
            m.Standable = standable;
            m.GroundTrace = groundTrace;
            m.GroundSnap = groundSnap;
            m.Skin = skin;
            m.X = body.X;
            m.Y = body.Y;
            m.Z = body.Z;
            m.VX = 0;
            m.VY = 0;
            m.VZ = body.VZ;
            m.Duck = vehicle ? 0 : body.Duck;
            m.OnGround = false;
            return m;
        }

        /// <summary>The posed solid (its index) the hull stands on: the highest standable top under it in [z - groundTrace, z +
        /// groundSnap] when that top is a posed solid's (the first such in order), else -1; -1 too while rising (<c>vz &gt; 0.1</c>).</summary>
        public int Support(GenexHullBody body, GenexPosedWorld solids)
        {
            var m = HullOf(body, solids);
            if (m.VZ > 0.1 * m.Unit) return -1;
            var g = GenexFirstperson.TraceDown(m, m.X, m.Y, m.Z, m.GroundTrace, m.GroundSnap);
            if (double.IsNaN(g)) return -1;
            for (var j = 0; j < m.P.Count; j++)
            {
                if (m.P.MaxZ[j] == g && GenexFirstperson.PosedOverlaps(m, j, m.X, m.Y)) return j;
            }
            return -1;
        }

        /// <summary><see cref="Support(GenexHullBody, GenexPosedWorld)"/> among solids given as a list.</summary>
        public int Support(GenexHullBody body, System.Collections.Generic.IList<GenexPosedSolid> solids) => Support(body, new GenexPosedWorld(solids));

        /// <summary>Whether the hull is more than skin inside posed solid <paramref name="k"/> (§17.7 <i>Starting inside</i>).</summary>
        public bool Inside(GenexHullBody body, GenexPosedWorld solids, int k)
        {
            var m = HullOf(body, solids);
            return GenexFirstperson.Inside(m, m.X, m.Y, m.Z, world.Tables.Count + k, GenexFirstperson.HullAt(m, m.Duck));
        }

        /// <summary>§17.7 <i>Starting inside</i> as the slide move applies it, with no move: up to four times, out through the face a
        /// zero-length sweep reports, by its depth then skin. <paramref name="stillInside"/>: still inside some solid.</summary>
        public GenexV3 PushOut(GenexHullBody body, GenexPosedWorld solids, out bool stillInside)
        {
            var m = HullOf(body, solids);
            for (var k = 0; k < 4; k++)
            {
                GenexFirstperson.Sweep(m, m.X, m.Y, m.Z, 0, 0, 0);
                if (!m.Hit) break;
                m.X = m.X + m.NX * m.Depth;
                m.Y = m.Y + m.NY * m.Depth;
                m.Z = m.Z + m.NZ * m.Depth;
                m.X = m.X + m.NX * m.Skin;
                m.Y = m.Y + m.NY * m.Skin;
                m.Z = m.Z + m.NZ * m.Skin;
            }
            var height = GenexFirstperson.HullAt(m, m.Duck);
            var inside = false;
            var all = world.Tables.Count + m.P.Count;
            for (var i = 0; i < all && !inside; i++) inside = GenexFirstperson.Inside(m, m.X, m.Y, m.Z, i, height);
            stillInside = inside;
            return new GenexV3(m.X, m.Y, m.Z);
        }
    }
}
