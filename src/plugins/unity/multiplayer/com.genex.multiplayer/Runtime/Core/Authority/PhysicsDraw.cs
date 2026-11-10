// Drawing the server's physics bodies (PROTOCOL.md §17.10 *State* and *Drawing*). In release 1 no client steps
// physics: every body is drawn from the server's latest state, at the server's present (never RenderDelayMs
// behind), extrapolated on the room clock by its velocities, and a newer state that disagrees with what was drawn
// is eased in over BODY_CORRECTION_TAU_MS instead of jumped to. GenexAuthoritySession owns one GenexBodyDrawer per
// body entity (an entity with a descriptor in RoomState.bodies).
//
// The rules, from §17.10:
//  - A state that arrived in a patch whose tick was t is the body at tick t + 1. At render time it is extrapolated
//    by Δ = clamp((serverTick(now) − (t + 1)) / tickHz, −1 / tickHz, 0.25) s (back a tick at most: the patch after
//    a step lands up to a tick before its state's instant), 0 while asleep: p + (lv · lengthUnit) · Δ, and
//    q' = normalize(r ⊗ q), r the rotation by |av| · Δ about av / |av| (world axes).
//  - When a newer state arrives, the offset is what was drawn at that instant (the older state's extrapolation plus
//    its decaying offset) less the newer state's extrapolation at that instant: dp = p_old − p_new and
//    dq = q_old ⊗ q_new⁻¹. Drawn: p + dp · k and slerp(identity, dq, k) ⊗ q, k = e^(−age / 100 ms).
//  - An epoch change, |dp| over one metre (lengthUnit units) or a body that just got its descriptor snaps (no offset).
// Where the text is silent this port reads it as the vectors' reference does (Tests~/GenexSmoke/
// physics-draw.reference.mjs): a zero quaternion is the identity, slerp takes the short arc, and "over" is strict.
// Held to physics-draw.json by GenexSmoke `physics-draw` within its tolerance (1e-4); no float32 rounding is
// asked for, so plain double arithmetic. Engine-agnostic: no UnityEngine.
using System;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A unit quaternion, (X, Y, Z) the vector part and W the scalar.</summary>
    public struct GenexQuat
    {
        public double X, Y, Z, W;

        public GenexQuat(double x, double y, double z, double w)
        {
            X = x;
            Y = y;
            Z = z;
            W = w;
        }

        public static GenexQuat Identity => new GenexQuat(0, 0, 0, 1);

        /// <summary>The Hamilton product a ⊗ b (b applied first).</summary>
        public static GenexQuat Mul(GenexQuat a, GenexQuat b) => new GenexQuat(
            a.W * b.X + a.X * b.W + a.Y * b.Z - a.Z * b.Y,
            a.W * b.Y - a.X * b.Z + a.Y * b.W + a.Z * b.X,
            a.W * b.Z + a.X * b.Y - a.Y * b.X + a.Z * b.W,
            a.W * b.W - a.X * b.X - a.Y * b.Y - a.Z * b.Z);

        /// <summary>The inverse of a unit quaternion.</summary>
        public GenexQuat Conjugate() => new GenexQuat(-X, -Y, -Z, W);

        /// <summary>This quaternion at unit length; one of length 0 (a body field never received) is the identity.</summary>
        public GenexQuat Normalized()
        {
            var n = Math.Sqrt(X * X + Y * Y + Z * Z + W * W);
            return n > 0 && !double.IsNaN(n) && !double.IsInfinity(n) ? new GenexQuat(X / n, Y / n, Z / n, W / n) : Identity;
        }

        /// <summary>The rotation by |w| · dt about the world axis w / |w| (identity when w is 0).</summary>
        public static GenexQuat FromAngularVelocity(double wx, double wy, double wz, double dt)
        {
            var rate = Math.Sqrt(wx * wx + wy * wy + wz * wz);
            if (rate == 0 || dt == 0) return Identity;
            var half = rate * dt / 2;
            var s = Math.Sin(half) / rate;
            return new GenexQuat(wx * s, wy * s, wz * s, Math.Cos(half));
        }

        /// <summary>slerp(identity, d, k), along the short arc (d with W &lt; 0 is negated first: the same rotation).</summary>
        public static GenexQuat SlerpFromIdentity(GenexQuat d, double k)
        {
            if (d.W < 0) d = new GenexQuat(-d.X, -d.Y, -d.Z, -d.W);
            var half = Math.Acos(Math.Min(1, d.W));
            var s = Math.Sin(half);
            if (s < 1e-12) return new GenexQuat(d.X * k, d.Y * k, d.Z * k, 1).Normalized();
            var t = Math.Sin(k * half) / s;
            return new GenexQuat(d.X * t, d.Y * t, d.Z * t, Math.Cos(k * half));
        }
    }

    /// <summary>A body's decoded state as one patch carried it (§17.10 *State*).</summary>
    public struct GenexBodyState
    {
        /// <summary>The patch's <c>tick</c>: the state is the body at tick <c>Tick + 1</c>.</summary>
        public double Tick;
        /// <summary>Position, room units (the core's float32).</summary>
        public double X, Y, Z;
        /// <summary>Orientation, normalized after decoding.</summary>
        public GenexQuat Q;
        /// <summary>Linear velocity in metres per second (multiply by the room's <c>lengthUnit</c> for units/s).</summary>
        public double Lvx, Lvy, Lvz;
        /// <summary>Angular velocity, rad/s, world axes.</summary>
        public double Avx, Avy, Avz;
        public bool Sleep;
        /// <summary>The entity's <c>epoch</c> (a change snaps).</summary>
        public double Epoch;
    }

    /// <summary>A drawn pose: position in room units and a unit orientation.</summary>
    public struct GenexBodyPose
    {
        public double X, Y, Z;
        public GenexQuat Q;
    }

    public static class GenexPhysicsDraw
    {
        /// <summary>Integer steps across a quantized field's range (2^16 − 2), §17.10 *State*.</summary>
        public const double QuantizedSpan = 65534;
        public const double OrientationMin = -1, OrientationMax = 1;
        public const double VelocityMin = -64, VelocityMax = 64;
        /// <summary>BODY_EXTRAPOLATE_MAX_MS: a body is extrapolated at most this far past its latest state.</summary>
        public const double ExtrapolateMaxMs = 250;

        /// <summary>BODY_EXTRAPOLATE_BACK_TICKS: a state that arrives before its own tick is moved back at most this many
        /// ticks (it lands up to one early: tick t is stepped at its instant and its state is the body at t + 1).</summary>
        public const double ExtrapolateBackTicks = 1;
        /// <summary>BODY_CORRECTION_TAU_MS: a correction's offset decays as e^(−age / τ).</summary>
        public const double CorrectionTauMs = 100;
        /// <summary>BODY_SNAP_METRES: a correction over this many metres (times lengthUnit) snaps instead.</summary>
        public const double SnapMetres = 1;

        /// <summary>The value a quantized field's uint16 <paramref name="q"/> decodes to: min + (q / 65534) · (max − min).</summary>
        public static double Dequantize(double q, double min, double max) => min + (q / QuantizedSpan) * (max - min);

        /// <summary>The state's pose at the (fractional) room tick <paramref name="serverTick"/>.</summary>
        public static GenexBodyPose Extrapolate(GenexBodyState s, double serverTick, double tickHz, double lengthUnit)
        {
            var d = (serverTick - (s.Tick + 1)) / tickHz;
            if (double.IsNaN(d) || s.Sleep || !(tickHz > 0)) d = 0;
            else if (d < -ExtrapolateBackTicks / tickHz) d = -ExtrapolateBackTicks / tickHz;
            if (d > ExtrapolateMaxMs / 1000) d = ExtrapolateMaxMs / 1000;
            var r = GenexQuat.FromAngularVelocity(s.Avx, s.Avy, s.Avz, d);
            return new GenexBodyPose
            {
                X = s.X + s.Lvx * lengthUnit * d,
                Y = s.Y + s.Lvy * lengthUnit * d,
                Z = s.Z + s.Lvz * lengthUnit * d,
                Q = GenexQuat.Mul(r, s.Q).Normalized(),
            };
        }
    }

    /// <summary>
    /// One body as a client draws it: its latest state and the correction offset still decaying from the one
    /// before. Times are on one clock in ms (the session uses the room clock); <c>serverTick</c> is §17.9's.
    /// </summary>
    public sealed class GenexBodyDrawer
    {
        private double arrived;
        private double dx, dy, dz;
        private GenexQuat dq = GenexQuat.Identity;
        private object descriptor;

        /// <summary>The latest state; meaningless until <see cref="HasState"/>.</summary>
        public GenexBodyState State { get; private set; }
        public bool HasState { get; private set; }
        /// <summary>States drawn without an offset so far: the first, an epoch change, a correction over one metre, a new descriptor.</summary>
        public int Snaps { get; private set; }
        /// <summary>Eased corrections so far.</summary>
        public int Corrections { get; private set; }
        /// <summary>The position offset the last correction measured, room units (0 after a snap).</summary>
        public double LastCorrection { get; private set; }

        /// <summary>
        /// A newer state arrived at <paramref name="at"/> (room tick <paramref name="serverTick"/> then).
        /// <paramref name="descriptorIdentity"/> is the body's descriptor (a new one is a body spawned again: snap).
        /// </summary>
        public void Receive(GenexBodyState next, object descriptorIdentity, double at, double serverTick, double tickHz, double lengthUnit)
        {
            var snap = !HasState || State.Epoch != next.Epoch || !ReferenceEquals(descriptor, descriptorIdentity);
            double ox = 0, oy = 0, oz = 0;
            var oq = GenexQuat.Identity;
            if (!snap)
            {
                var old = Draw(at, serverTick, tickHz, lengthUnit);
                var now = GenexPhysicsDraw.Extrapolate(next, serverTick, tickHz, lengthUnit);
                ox = old.X - now.X;
                oy = old.Y - now.Y;
                oz = old.Z - now.Z;
                var size = Math.Sqrt(ox * ox + oy * oy + oz * oz);
                if (size > GenexPhysicsDraw.SnapMetres * lengthUnit)
                {
                    snap = true;
                    ox = oy = oz = 0;
                }
                else
                {
                    oq = GenexQuat.Mul(old.Q, now.Q.Conjugate());
                    Corrections++;
                    LastCorrection = size;
                }
            }
            if (snap)
            {
                Snaps++;
                LastCorrection = 0;
            }
            State = next;
            HasState = true;
            descriptor = descriptorIdentity;
            arrived = at;
            dx = ox;
            dy = oy;
            dz = oz;
            dq = oq;
        }

        /// <summary>What to draw at <paramref name="at"/>: the latest state's extrapolation plus the decaying offset.</summary>
        public GenexBodyPose Draw(double at, double serverTick, double tickHz, double lengthUnit)
        {
            var e = GenexPhysicsDraw.Extrapolate(State, serverTick, tickHz, lengthUnit);
            var k = Decay(at);
            return new GenexBodyPose
            {
                X = e.X + dx * k,
                Y = e.Y + dy * k,
                Z = e.Z + dz * k,
                Q = GenexQuat.Mul(GenexQuat.SlerpFromIdentity(dq, k), e.Q),
            };
        }

        /// <summary>The size of the position offset still drawn at <paramref name="at"/>, room units.</summary>
        public double Offset(double at) => Math.Sqrt(dx * dx + dy * dy + dz * dz) * Decay(at);

        private double Decay(double at)
        {
            var age = at - arrived;
            return Math.Exp(-(age > 0 ? age : 0) / GenexPhysicsDraw.CorrectionTauMs);
        }
    }
}
