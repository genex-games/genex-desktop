// Projectile flight (PROTOCOL.md §17.9), ported from packages/multiplayer/src/authority/projectile.ts: a
// closed-form ballistic path from one launch, which the server writes once and every client evaluates at
// any instant. Other players' projectiles draw at the server's present instead of a render delay behind,
// and the shooter's own from the moment it fires (GenexAuthoritySession.PredictProjectile).
//
// Determinism rules, as the TypeScript reference keeps them: double arithmetic in the order written there,
// only + - * /, each rounded on its own (no fused multiply-add: the .NET and Mono JITs never contract
// one; IL2CPP emits every operation through its own inline helper, il2cpp_codegen_add/_multiply, so
// clang's default contraction, which fuses only inside one source expression, finds nothing to fuse, and
// the README still asks an IL2CPP build for -ffp-contract=off), and a float32 rounding (Fround, a (float)
// cast) on every position and vz the flight returns, -0 written as 0. Held bit for bit to
// packages/netcode-bench/conformance/authority/presets/projectile.json by Tests~/GenexSmoke `presets`
// (and inside Unity by Tests~/AuthorityProbe). Engine-agnostic: no UnityEngine.
using System;

namespace Genex.Multiplayer.Authority
{
    /// <summary>What a launch writes: the entity's float32 pose and velocity, its gravity and its launch tick.</summary>
    public struct GenexProjectileLaunch
    {
        public double X, Y, Z, VX, VY, VZ;
        /// <summary>Downward acceleration along -z, units/s².</summary>
        public double G;
        /// <summary>The launch tick (fractional for a client's own prediction).</summary>
        public double T0;
    }

    /// <summary>A projectile at one instant.</summary>
    public struct GenexProjectileState
    {
        public double X, Y, Z, VX, VY, VZ;
    }

    /// <summary>
    /// §17.9's TTL for a predicted projectile nothing else settles (session.ts <c>ttl</c>): max(2·RTT, 600 ms), not counting a
    /// stall. While the socket is up, the time no state arrives is not a lost input (a reliable socket loses none), so the TTL
    /// waits out the current silence, and for max(2·RTT, 600 ms) after a stall ends it also waits out that stall's length (a
    /// shot fired into a one-second burst of loss would otherwise vanish, then snap back when the server's lands). Times are one
    /// monotonic clock's ms.
    /// </summary>
    public sealed class GenexProjectileTtl
    {
        /// <summary>The least TTL, ms: a prediction is dropped after max(2·RTT, this).</summary>
        public const double MinMs = 600;
        private double lastStateAt;
        private double stallMs, stallEndedAt;

        public GenexProjectileTtl(double now = 0) { lastStateAt = now; }

        /// <summary>A state patch was decoded at <paramref name="now"/>: a gap longer than the stall remembered (or after it is
        /// forgotten) is the new stall.</summary>
        public void NoteState(double now)
        {
            if (now - lastStateAt > stallMs || now - stallEndedAt > MinMs + stallMs)
            {
                stallMs = now - lastStateAt;
                stallEndedAt = now;
            }
            lastStateAt = now;
        }

        /// <summary>The TTL, ms, at <paramref name="now"/> in a room of <paramref name="rtt"/> ms; the socket down: max(2·RTT, 600 ms).</summary>
        public double Ms(double rtt, bool connected, double now)
        {
            var baseMs = Math.Max(2 * rtt, MinMs);
            if (!connected) return baseMs;
            // The silence now, or the last stall for as long as a prediction made before it could still be waiting (its age
            // counts the stall; its TTL does not).
            var recent = now - stallEndedAt < baseMs + stallMs ? stallMs : 0;
            return baseMs + Math.Max(now - lastStateAt, recent);
        }
    }

    public static class GenexProjectile
    {
        /// <summary>Largest launch tick: <c>t0</c> is an integer in [0, 2^32 - 1]; 0 = not a projectile.</summary>
        public const double MaxTick = 4294967295;
        /// <summary>Largest downward acceleration a projectile may carry, units/s².</summary>
        public const double MaxG = 1000;

        /// <summary>Whether an entity with launch tick <paramref name="t0"/> is a projectile (§17.9 <c>t0 &gt; 0</c>).</summary>
        public static bool IsProjectile(double t0) => t0 > 0;

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        /// <summary>
        /// Where a projectile launched as <paramref name="launch"/> is at tick <paramref name="T"/> (whole or
        /// fractional), in a room at <paramref name="tickHz"/>. Pure; double in the written order:
        /// <list type="number">
        /// <item>s = (T - t0) / tickHz; non-finite or negative → 0 (before its launch it sits at its origin);</item>
        /// <item>x' = fround(x + vx·s), y' = fround(y + vy·s);</item>
        /// <item>z' = fround((z + (vz·s)) - (((0.5·g)·s)·s));</item>
        /// <item>vx' = vx, vy' = vy, vz' = fround(vz - g·s);</item>
        /// <item>a -0 result is written as 0.</item>
        /// </list>
        /// </summary>
        public static GenexProjectileState At(GenexProjectileLaunch launch, double T, double tickHz)
        {
            double since = T - launch.T0;
            double elapsed = since / tickHz;
            double s = IsFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
            double dx = launch.VX * s;
            double x = launch.X + dx;
            double dy = launch.VY * s;
            double y = launch.Y + dy;
            double dz = launch.VZ * s;
            double rise = launch.Z + dz;
            double half = 0.5 * launch.G;
            double halfS = half * s;
            double drop = halfS * s;
            double z = rise - drop;
            double dv = launch.G * s;
            double vz = launch.VZ - dv;
            return new GenexProjectileState
            {
                X = GenexPresets.UnsignedZero(GenexPresets.Fround(x)),
                Y = GenexPresets.UnsignedZero(GenexPresets.Fround(y)),
                Z = GenexPresets.UnsignedZero(GenexPresets.Fround(z)),
                VX = GenexPresets.UnsignedZero(launch.VX),
                VY = GenexPresets.UnsignedZero(launch.VY),
                VZ = GenexPresets.UnsignedZero(GenexPresets.Fround(vz)),
            };
        }

        /// <summary>
        /// The room's tick at server time <paramref name="serverNowMs"/> (the room clock, ms):
        /// <c>(serverNow - tickOrigin) · tickHz / 1000</c>, fractional. <paramref name="tickOrigin"/> is
        /// <c>AuthorityRoomState.tickOrigin</c>.
        /// </summary>
        public static double ServerTick(double serverNowMs, double tickOrigin, double tickHz)
        {
            double since = serverNowMs - tickOrigin;
            double scaled = since * tickHz;
            return scaled / 1000;
        }

        /// <summary>Tick <paramref name="tick"/>'s nominal instant on the room clock, ms: <c>tickOrigin + tick · 1000 / tickHz</c>.</summary>
        public static double TickInstant(double tick, double tickOrigin, double tickHz)
        {
            double scaled = tick * 1000;
            double offset = scaled / tickHz;
            return tickOrigin + offset;
        }

        /// <summary>A launch value as the server writes it: float32, a non-finite one 0, -0 as 0.</summary>
        public static double LaunchNumber(double v) => IsFinite(v) ? GenexPresets.UnsignedZero(GenexPresets.Fround(v)) : 0;
    }
}
