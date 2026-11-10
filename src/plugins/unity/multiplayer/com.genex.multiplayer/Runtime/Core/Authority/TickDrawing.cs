// Other entities drawn on the tick timeline (PROTOCOL.md §17.11 *Drawing other seats*), a port of
// packages/multiplayer/src/authority/tick-drawing.ts. In a predicting room every patch is one keyframe, so each sample is
// timed by its keyframe's tick, not by the patch's server stamp: the stamp is the room clock at the fixed step's call that
// ran the tick (late by up to a tick, and shared by every tick a late call caught up), which at 60 keyframes a second made
// a remote car's drawn speed jump from segment to segment. An entity a keyframe left unchanged sends nothing; it held its
// fields since the keyframe before, so a sample after such a gap first repeats the last one at the keyframe before it. A
// new life (an epoch change, a respawn or a kickoff's teleport) is never interpolated into: between the old life's last
// sample and the new one's first the old pose holds.
// Pure: GenexAuthoritySession feeds it keyframe samples and asks for poses at its render time (GenexSmoke `tick-drawing`
// holds it to the TypeScript's test cases). Engine-agnostic.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A drawn pose: position, the heading (unwrapped: each sample folded onto the last along the short arc), and a
    /// firstperson body's aim pitch and duck.</summary>
    public struct GenexTickPose
    {
        public double X, Y, Z, Yaw, Pitch, Duck;
    }

    /// <summary>Each entity's keyframe samples, by key, and its pose at a render time.</summary>
    public sealed class GenexTickDrawing<TKey>
    {
        /// <summary>Samples kept per entity: a little over a second at 60 keyframes a second.</summary>
        public const int Ring = 80;

        private struct Sample
        {
            public double T, Life;
            public GenexTickPose Pose;
        }

        private readonly Dictionary<TKey, List<Sample>> rings;

        public GenexTickDrawing(IEqualityComparer<TKey> comparer = null)
        {
            rings = new Dictionary<TKey, List<Sample>>(comparer ?? EqualityComparer<TKey>.Default);
        }

        private static double Fold(double prev, double next) => prev + Math.Atan2(Math.Sin(next - prev), Math.Cos(next - prev));

        private static GenexTickPose Lerp(GenexTickPose a, GenexTickPose b, double u) => new GenexTickPose
        {
            X = a.X + (b.X - a.X) * u,
            Y = a.Y + (b.Y - a.Y) * u,
            Z = a.Z + (b.Z - a.Z) * u,
            Yaw = a.Yaw + (b.Yaw - a.Yaw) * u,
            Pitch = a.Pitch + (b.Pitch - a.Pitch) * u,
            Duck = a.Duck + (b.Duck - a.Duck) * u,
        };

        /// <summary>
        /// Entity <paramref name="key"/>'s fields at the keyframe of instant <paramref name="t"/> (ms on the room clock), in its
        /// life <paramref name="life"/> (its epoch). <paramref name="period"/> is the time between keyframes: a sample more than
        /// one and a half periods after the last of the same life first repeats the last one a period before <paramref name="t"/>
        /// (the entity held still meanwhile). A sample not after the last replaces nothing; neither does one whose instant is
        /// not a finite number (the TypeScript would append it out of order) or a null key.
        /// </summary>
        public void Push(TKey key, double t, GenexTickPose pose, double period, double life = 0)
        {
            if (key == null || double.IsNaN(t) || double.IsInfinity(t)) return;
            if (!rings.TryGetValue(key, out var ring))
            {
                ring = new List<Sample>();
                rings[key] = ring;
            }
            var has = ring.Count > 0;
            var last = has ? ring[ring.Count - 1] : default;
            if (has && t <= last.T) return;
            var sameLife = has && last.Life == life;
            if (sameLife)
            {
                pose.Yaw = Fold(last.Pose.Yaw, pose.Yaw);
                if (t - last.T > period * 1.5) ring.Add(new Sample { T = t - period, Life = life, Pose = last.Pose });
            }
            ring.Add(new Sample { T = t, Life = life, Pose = pose });
            if (ring.Count > Ring) ring.RemoveRange(0, ring.Count - Ring);
        }

        /// <summary>Entity <paramref name="key"/> at render time <paramref name="target"/>, between the two samples around it;
        /// held at the oldest or newest outside them; false before its first sample.</summary>
        public bool At(TKey key, double target, out GenexTickPose pose) => At(key, target, out pose, out _);

        /// <summary>As <see cref="At(TKey, double, out GenexTickPose)"/>, with the life (epoch) the drawn pose belongs to: across
        /// a change of life, the old one's until the new one's first sample.</summary>
        public bool At(TKey key, double target, out GenexTickPose pose, out double life)
        {
            pose = default;
            life = 0;
            if (key == null || !rings.TryGetValue(key, out var ring) || ring.Count == 0) return false;
            var first = ring[0];
            var last = ring[ring.Count - 1];
            if (target <= first.T)
            {
                pose = first.Pose;
                life = first.Life;
                return true;
            }
            if (target >= last.T)
            {
                pose = last.Pose;
                life = last.Life;
                return true;
            }
            var k = ring.Count - 2;
            while (k > 0 && ring[k].T > target) k--;
            var a = ring[k];
            var b = ring[k + 1];
            life = a.Life;
            // Never across lives: the old one holds until the new one's first sample.
            if (a.Life != b.Life)
            {
                pose = a.Pose;
                return true;
            }
            pose = Lerp(a.Pose, b.Pose, (target - a.T) / (b.T - a.T));
            return true;
        }

        /// <summary>Forgets an entity's samples.</summary>
        public void Forget(TKey key)
        {
            if (key != null) rings.Remove(key);
        }

        /// <summary>How many samples entity <paramref name="key"/> holds (0: none).</summary>
        public int Count(TKey key) => key != null && rings.TryGetValue(key, out var ring) ? ring.Count : 0;
    }
}
