// Remote-entity interpolation on the SENDER's clock — PROTOCOL.md §10 and §10.1, a port of the
// TypeScript SDK's engine (packages/multiplayer/src/index.ts pushSnap/sampleSmoothed, src/pose.ts).
//
// A stream is one remote player (key = session id) or one object (key = "obj:" + id). A sample is
// (s, state) where s is the sender's own clock stamp (__t, an object's t, or a pose's poseT). The
// clock offset belongs to the SENDER, so all of one machine's streams share it.
//
// ALLOCATION: Sample runs for every stream on every frame, so it allocates nothing at steady state.
// The sampled value goes into a per-stream typed scratch (no boxing), and the eased result is written
// IN PLACE into the stream's one output dictionary (Smoothed), which is what the views hand to the
// game. A number is boxed only when its value changed; quaternions live in lists the stream owns.
// Allocation happens per arriving sample (the buffer entry) and per handoff (the bridge copy), not
// per frame.
//
// Engine-agnostic: no UnityEngine here.
using System;
using System.Collections.Generic;
using I = Genex.Multiplayer.GenexProtocol.Interpolation;

namespace Genex.Multiplayer
{
    internal sealed class Interpolator
    {
        private sealed class Snap
        {
            public double T;
            public Dictionary<string, object> State;
        }

        private sealed class SenderClock
        {
            public readonly List<KeyValuePair<double, long>> Samples = new List<KeyValuePair<double, long>>(); // (arrival, n)
            public readonly List<KeyValuePair<double, long>> Mins = new List<KeyValuePair<double, long>>();    // (value, n), increasing
            public long N;
            public double Offset;
        }

        private const byte KindNum = 1, KindQuat = 2, KindOther = 3;

        /// <summary>One sampled field before easing: a number, a quaternion, or any other value (held as is).</summary>
        private struct Val
        {
            public byte Kind;
            public double N, X, Y, Z, W;
            public object O;
        }

        private sealed class Stream
        {
            public readonly List<Snap> Buf = new List<Snap>();
            public string Sender;
            public double? LastStamp;
            public readonly List<double> Gaps = new List<double>();
            public readonly List<double> Jitter = new List<double>();
            public double? Delay;
            /// <summary>The render output, rewritten in place every Sample. What GenexPlayer/GenexObject.State hold.</summary>
            public readonly Dictionary<string, object> Smoothed = new Dictionary<string, object>();
            public bool HasSmoothed;
            public double SmoothedAt;
            public Dictionary<string, object> Bridge;
            public bool Posed;
            public readonly Dictionary<string, Val> Scratch = new Dictionary<string, Val>();
            /// <summary>Quaternion lists inside Smoothed, owned by this stream (so writing them in place aliases nothing).</summary>
            public readonly Dictionary<string, List<object>> Quats = new Dictionary<string, List<object>>();
        }

        private readonly Dictionary<string, SenderClock> senders = new Dictionary<string, SenderClock>();
        private readonly Dictionary<string, Stream> streams = new Dictionary<string, Stream>();
        private readonly List<string> staleKeys = new List<string>();
        private readonly List<double> sortBuf = new List<double>();

        private Stream Get(string key)
        {
            if (!streams.TryGetValue(key, out var st)) streams[key] = st = new Stream();
            return st;
        }

        /// <summary>Feed one stamped sample that arrived at local time <paramref name="arrival"/>.</summary>
        public void Push(string key, string sender, double s, Dictionary<string, object> state, bool posed, double arrival)
        {
            var sample = arrival - s;
            if (!senders.TryGetValue(sender, out var sc)) senders[sender] = sc = new SenderClock();
            var n = ++sc.N;
            sc.Samples.Add(new KeyValuePair<double, long>(arrival, n));
            while (sc.Mins.Count > 0 && sc.Mins[sc.Mins.Count - 1].Key >= sample) sc.Mins.RemoveAt(sc.Mins.Count - 1);
            sc.Mins.Add(new KeyValuePair<double, long>(sample, n));
            // Evict only what is BOTH older than ClockWindowMs and beyond the last ClockWindow samples.
            var drop = 0;
            while (sc.Samples.Count - drop > I.ClockWindowMax ||
                   (sc.Samples.Count - drop > I.ClockWindow && sc.Samples[drop].Key < arrival - I.ClockWindowMs))
                drop++;
            if (drop > 0) sc.Samples.RemoveRange(0, drop);
            var firstKept = sc.Samples[0].Value;
            var dropMins = 0;
            while (sc.Mins[dropMins].Value < firstKept) dropMins++;
            if (dropMins > 0) sc.Mins.RemoveRange(0, dropMins);
            sc.Offset = sc.Mins[0].Key;

            var st = Get(key);
            st.Posed = posed;
            st.Jitter.Add(sample);
            if (st.Jitter.Count > I.ClockWindow) st.Jitter.RemoveAt(0);
            st.Sender = sender;

            var prev = st.LastStamp;
            st.LastStamp = s;
            if (prev.HasValue)
            {
                var gap = s - prev.Value;
                if (gap > I.MinGapMs && gap < I.MaxGapMs)
                {
                    st.Gaps.Add(gap);
                    if (st.Gaps.Count > I.IntervalWindow) st.Gaps.RemoveAt(0);
                    var jitter = st.Jitter.Count >= 8 ? Math.Max(0, Quantile(st.Jitter, 0.9) - sc.Offset) : 0;
                    var target = Math.Min(I.MaxMs, Math.Max(I.MinMs, Math.Max(I.Ratio * Median(st.Gaps), I.JitterSafety * jitter)));
                    var cur = st.Delay ?? I.DefaultMs;
                    st.Delay = cur + (target - cur) * I.Ease;
                }
            }

            // Soft-handoff bridge: the new owner's first sample after an ownership change.
            if (st.Bridge != null && st.Buf.Count == 0)
            {
                var delay = st.Delay ?? I.DefaultMs;
                st.Buf.Add(new Snap { T = s - Math.Max(1, delay), State = st.Bridge });
            }
            st.Bridge = null;
            st.Buf.Add(new Snap { T = s, State = state });
            var cutoff = s - I.HistoryMs;
            while (st.Buf.Count > 2 && st.Buf[0].T < cutoff) st.Buf.RemoveAt(0);
            // A head stamped far in the future of the newest is a foreign-clock poison: evict it.
            while (st.Buf.Count > 1 && st.Buf[0].T > st.Buf[st.Buf.Count - 1].T + I.PoisonGuardMs) st.Buf.RemoveAt(0);
        }

        private double? RenderTime(Stream st, double localNow)
        {
            if (st.Sender == null || !senders.TryGetValue(st.Sender, out var sc)) return null;
            return localNow - sc.Offset - (st.Delay ?? I.DefaultMs);
        }

        /// <summary>The stream's render time r = now − senderOffset − delay, or null before its first sample.</summary>
        public double? RenderTime(string key, double localNow) =>
            streams.TryGetValue(key, out var st) ? RenderTime(st, localNow) : null;

        public double DelayOf(string key) =>
            streams.TryGetValue(key, out var st) && st.Delay.HasValue ? st.Delay.Value : I.DefaultMs;

        /// <summary>
        /// Sample and output-ease a stream at <paramref name="localNow"/>. Null when it has nothing to show.
        /// The returned dictionary is the stream's own output, rewritten in place by the next call.
        /// </summary>
        public Dictionary<string, object> Sample(string key, double localNow)
        {
            if (!streams.TryGetValue(key, out var st)) return null;
            var r = RenderTime(st, localNow) ?? localNow - I.DefaultMs;
            var sampled = st.Posed ? SamplePose(st.Buf, r, st.Scratch) : SampleBuffer(st.Buf, r, st.Scratch);
            if (!sampled) return st.HasSmoothed ? st.Smoothed : null; // warm window after a soft handoff: hold the eased pose
            if (st.HasSmoothed)
            {
                var dt = Math.Min(I.MaxHostTickDtMs, Math.Max(0, localNow - st.SmoothedAt));
                Apply(st, true, 1 - Math.Exp(-dt / I.SmoothTauPosMs), 1 - Math.Exp(-dt / I.SmoothTauRotMs));
            }
            else Apply(st, false, 1, 1);
            st.HasSmoothed = true;
            st.SmoothedAt = localNow;
            return st.Smoothed;
        }

        /// <summary>
        /// Keep a stream's eased output at a pose this client renders itself (an object it owns, §10 step 7),
        /// so a later soft handoff bridges from where the object IS on screen — not from a stale pose eased
        /// before the claim, which rubber-banded the ex-owner back to its grab point. Creates the stream if needed.
        /// </summary>
        public void Seed(string key, Dictionary<string, object> state, double localNow)
        {
            var st = Get(key);
            st.Scratch.Clear();
            Load(st.Scratch, state);
            Apply(st, false, 1, 1);
            st.HasSmoothed = true;
            st.SmoothedAt = localNow;
        }

        /// <summary>True teardown (player left, object destroyed, or an epoch reseed).</summary>
        public void Clear(string key) => streams.Remove(key);

        /// <summary>
        /// Soft handoff (§10 step 6): the next samples come from a different clock. Drop buffer, gaps,
        /// jitter and delay; keep the eased output; seed it as a bridge for the new owner's first sample.
        /// </summary>
        public void SoftReset(string key)
        {
            if (!streams.TryGetValue(key, out var st)) return;
            st.Buf.Clear();
            st.Sender = null;
            st.LastStamp = null;
            st.Gaps.Clear();
            st.Jitter.Clear();
            st.Delay = null;
            st.Bridge = st.HasSmoothed ? CopyOutput(st.Smoothed) : null; // a copy: Smoothed keeps changing in place
        }

        public void ClearSender(string sender) => senders.Remove(sender);

        /// <summary>One deliberate rebase after a long outage (§8 step 2).</summary>
        public void ClearAll()
        {
            streams.Clear();
            senders.Clear();
        }

        // ---------------- output (§10 step 5) ----------------

        // Write the scratch into the stream's output in place: eased when `ease`, verbatim otherwise.
        // Plain players and objects ease every number and slerp quaternions (§10); posed players ease only
        // the pose numbers, yaw the short way, and take everything else from the target (§10.1).
        private void Apply(Stream st, bool ease, double aPos, double aRot)
        {
            var output = st.Smoothed;
            staleKeys.Clear();
            foreach (var k in output.Keys) if (!st.Scratch.ContainsKey(k)) staleKeys.Add(k);
            foreach (var k in staleKeys) output.Remove(k);
            foreach (var kv in st.Scratch)
            {
                var key = kv.Key;
                var v = kv.Value;
                output.TryGetValue(key, out var prev);
                switch (v.Kind)
                {
                    case KindNum:
                    {
                        var value = v.N;
                        if (ease && prev is double pd)
                        {
                            if (!st.Posed) value = pd + (v.N - pd) * aPos;
                            else if (key == "yaw") value = pd + WrapAngle(v.N - pd) * aRot;
                            else if (IsPoseNumber(key)) value = pd + (v.N - pd) * aPos;
                        }
                        if (!(prev is double cur) || !cur.Equals(value)) output[key] = value; // box only on change
                        break;
                    }
                    case KindQuat:
                    {
                        double x = v.X, y = v.Y, z = v.Z, w = v.W;
                        if (ease && !st.Posed && IsQuat(prev))
                        {
                            var pq = (List<object>)prev;
                            Slerp((double)pq[0], (double)pq[1], (double)pq[2], (double)pq[3], v.X, v.Y, v.Z, v.W, aRot, out x, out y, out z, out w);
                        }
                        if (!st.Quats.TryGetValue(key, out var q))
                            st.Quats[key] = q = new List<object>(4) { 0.0, 0.0, 0.0, 0.0 };
                        SetElem(q, 0, x);
                        SetElem(q, 1, y);
                        SetElem(q, 2, z);
                        SetElem(q, 3, w);
                        if (!ReferenceEquals(prev, q)) output[key] = q;
                        break;
                    }
                    default:
                        if (!ReferenceEquals(prev, v.O)) output[key] = v.O;
                        break;
                }
            }
        }

        private static void SetElem(List<object> q, int i, double value)
        {
            if (!(q[i] is double cur) || !cur.Equals(value)) q[i] = value;
        }

        private static Dictionary<string, object> CopyOutput(Dictionary<string, object> src)
        {
            var copy = new Dictionary<string, object>(src.Count);
            foreach (var kv in src) copy[kv.Key] = kv.Value is List<object> l ? new List<object>(l) : kv.Value;
            return copy;
        }

        // ---------------- sampling (§10 step 4, §10.1 step 2), into the typed scratch ----------------

        private static void Load(Dictionary<string, Val> into, Dictionary<string, object> state)
        {
            foreach (var kv in state)
            {
                var o = kv.Value;
                if (o is double d) into[kv.Key] = new Val { Kind = KindNum, N = d };
                else if (IsQuat(o))
                {
                    var l = (List<object>)o;
                    into[kv.Key] = new Val { Kind = KindQuat, X = (double)l[0], Y = (double)l[1], Z = (double)l[2], W = (double)l[3] };
                }
                else into[kv.Key] = new Val { Kind = KindOther, O = o };
            }
        }

        private static bool SampleBuffer(List<Snap> buf, double r, Dictionary<string, Val> into)
        {
            var n = buf.Count;
            if (n == 0) return false;
            into.Clear();
            if (n == 1) { Load(into, buf[0].State); return true; }
            var j = 0;
            while (j < n && buf[j].T <= r) j++;
            if (j == 0) { Load(into, buf[0].State); return true; }
            if (j >= n)
            {
                var a = buf[n - 2];
                var b = buf[n - 1];
                var span = b.T - a.T;
                if (span <= 0) { Load(into, b.State); return true; }
                var tPos = (Math.Min(r, b.T + I.MaxExtrapMs) - a.T) / span;
                var tRot = (Math.Min(r, b.T + I.RotExtrapMs) - a.T) / span;
                Blend(a.State, b.State, tPos, tRot, into);
                return true;
            }
            var lo = buf[j - 1];
            var hi = buf[j];
            var sp = hi.T - lo.T;
            var t = sp > 0 ? (r - lo.T) / sp : 1;
            Blend(lo.State, hi.State, t, t, into);
            return true;
        }

        private static void Blend(Dictionary<string, object> a, Dictionary<string, object> b, double tNum, double tQuat, Dictionary<string, Val> into)
        {
            var interpolating = tNum < 1;
            foreach (var kv in b)
            {
                var had = a.TryGetValue(kv.Key, out var av);
                var bv = kv.Value;
                if (av is double ad && bv is double bd) into[kv.Key] = new Val { Kind = KindNum, N = ad + (bd - ad) * tNum };
                else if (IsQuat(av) && IsQuat(bv))
                {
                    var qa = (List<object>)av;
                    var qb = (List<object>)bv;
                    Slerp((double)qa[0], (double)qa[1], (double)qa[2], (double)qa[3], (double)qb[0], (double)qb[1], (double)qb[2], (double)qb[3],
                        tQuat, out var x, out var y, out var z, out var w);
                    into[kv.Key] = new Val { Kind = KindQuat, X = x, Y = y, Z = z, W = w };
                }
                else
                {
                    // Discrete values keep the OLDER snapshot's value while interpolating (§10 step 4).
                    var o = interpolating && had ? av : bv;
                    if (o is double od) into[kv.Key] = new Val { Kind = KindNum, N = od };
                    else if (IsQuat(o))
                    {
                        var l = (List<object>)o;
                        into[kv.Key] = new Val { Kind = KindQuat, X = (double)l[0], Y = (double)l[1], Z = (double)l[2], W = (double)l[3] };
                    }
                    else into[kv.Key] = new Val { Kind = KindOther, O = o };
                }
            }
        }

        private static bool IsQuat(object v)
        {
            if (!(v is List<object> l) || l.Count != 4) return false;
            foreach (var e in l) if (!(e is double)) return false;
            return true;
        }

        private static void Slerp(double ax, double ay, double az, double aw, double bx, double by, double bz, double bw, double t,
            out double x, out double y, out double z, out double w)
        {
            var dot = ax * bx + ay * by + az * bz + aw * bw;
            if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
            if (dot > 0.9995)
            {
                x = ax + (bx - ax) * t; y = ay + (by - ay) * t; z = az + (bz - az) * t; w = aw + (bw - aw) * t;
                var l = Math.Sqrt(x * x + y * y + z * z + w * w);
                if (l == 0) l = 1;
                x /= l; y /= l; z /= l; w /= l;
                return;
            }
            var theta0 = Math.Acos(dot);
            var sin0 = Math.Sin(theta0);
            var s0 = Math.Sin(theta0 - theta0 * t) / sin0;
            var s1 = Math.Sin(theta0 * t) / sin0;
            x = ax * s0 + bx * s1; y = ay * s0 + by * s1; z = az * s0 + bz * s1; w = aw * s0 + bw * s1;
        }

        // ---------------- §10.1 posed players ----------------

        private static readonly string[] PoseNumbers = { "x", "y", "z", "yaw", "vx", "vy", "vz" };
        private static readonly string[][] Axes = { new[] { "x", "vx" }, new[] { "y", "vy" }, new[] { "z", "vz" } };

        private static bool IsPoseNumber(string key) => Array.IndexOf(PoseNumbers, key) >= 0;

        /// <summary>Map an angle into (−π, π].</summary>
        public static double WrapAngle(double a)
        {
            if (double.IsNaN(a) || double.IsInfinity(a)) return 0;
            var r = a % (2 * Math.PI);
            if (r <= -Math.PI) r += 2 * Math.PI;
            else if (r > Math.PI) r -= 2 * Math.PI;
            return r;
        }

        private static double Num(Dictionary<string, object> o, string k) => o.TryGetValue(k, out var v) && v is double d ? d : 0;

        private static void SetNum(Dictionary<string, Val> into, string key, double value) =>
            into[key] = new Val { Kind = KindNum, N = value };

        private static bool SamplePose(List<Snap> buf, double r, Dictionary<string, Val> into)
        {
            var n = buf.Count;
            if (n == 0) return false;
            into.Clear();
            var j = 0;
            while (j < n && buf[j].T <= r) j++;
            if (j == 0) { Load(into, buf[0].State); return true; }
            if (j >= n)
            {
                var b = buf[n - 1];
                Load(into, b.State);
                var ahead = Math.Min(Math.Max(0, r - b.T), I.MaxExtrapMs) / 1000;
                foreach (var ax in Axes) SetNum(into, ax[0], Num(b.State, ax[0]) + Num(b.State, ax[1]) * ahead);
                if (n >= 2)
                {
                    var a = buf[n - 2];
                    var span = b.T - a.T;
                    if (span > 0)
                    {
                        var k = Math.Min(Math.Max(0, r - b.T), I.RotExtrapMs) / span;
                        var yb = Num(b.State, "yaw");
                        SetNum(into, "yaw", yb + WrapAngle(yb - Num(a.State, "yaw")) * k);
                    }
                }
                return true;
            }
            var lo = buf[j - 1];
            var hi = buf[j];
            var sp = hi.T - lo.T;
            var t = sp > 0 ? (r - lo.T) / sp : 1;
            Load(into, lo.State); // anim (and the rest) hold the OLDER sample
            foreach (var key in PoseNumbers)
            {
                var va = Num(lo.State, key);
                var vb = Num(hi.State, key);
                SetNum(into, key, key == "yaw" ? va + WrapAngle(vb - va) * t : va + (vb - va) * t);
            }
            return true;
        }

        // ---------------- stats ----------------

        private double Median(List<double> xs)
        {
            if (xs.Count == 0) return 66;
            sortBuf.Clear();
            sortBuf.AddRange(xs);
            sortBuf.Sort();
            return sortBuf[sortBuf.Count >> 1];
        }

        private double Quantile(List<double> xs, double q)
        {
            if (xs.Count == 0) return 0;
            sortBuf.Clear();
            sortBuf.AddRange(xs);
            sortBuf.Sort();
            var i = (int)Math.Min(sortBuf.Count - 1, Math.Max(0, Math.Round(q * (sortBuf.Count - 1), MidpointRounding.AwayFromZero)));
            return sortBuf[i];
        }
    }
}
