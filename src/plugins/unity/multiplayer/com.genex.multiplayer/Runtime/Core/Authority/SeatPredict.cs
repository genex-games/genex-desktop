// Predicted seats (PROTOCOL.md §17.11 *Drawing other seats* `predicted`, *Seat contacts*): the Rocket League model, where the
// client predicts every seat on its own clock. A port of packages/multiplayer/src/authority/seat-predict.ts (SeatWorld,
// seatOffset), held to packages/netcode-bench/conformance/carball/carball-seat-predict.json by GenexSmoke
// `carball-seat-predict` (`passes` bit for bit, `draws` within the file's tolerance).
//
// Each other seat's entity is stepped from the latest state by the room's movement preset under its last applied input
// (held, `remotePredict: 'hold'`; or decayed, `inputDecay`; or moved by its velocity, `extrapolate`), and after each tick's
// steps the room module's seat contact pass runs on every seat, yours included, in the server's order. Your own entity's
// prediction takes its contacts from this world, the client world's preset bodies their poses, and the session draws other
// seats from it at the input your entity is drawn at, with a critically damped offset for each correction
// (GenexSeatOffset.Next). Pure: GenexAuthoritySession feeds it. Engine-agnostic.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>
    /// A seat contact pass: what the room module does to every seat's entity after each tick's preset steps (car-ball's pairs,
    /// pile passes and world passes), as a pure function of them all, ids ascending, changing their fields in place. The
    /// module must run this very function. Without one, a session runs the pair rule once on every pair, ids ascending.
    /// </summary>
    public delegate void GenexSeatPass(IList<GenexContactBody> seats);

    /// <summary>Another seat's entity in the latest state: its preset fields, its life, and its last applied input (null where
    /// the room writes none: moved by its velocity).</summary>
    public sealed class GenexHeldSeat
    {
        public string Id = "";
        public double Epoch;
        public Dictionary<string, double> Body = new Dictionary<string, double>();
        public GenexRemoteInput? Input;
    }

    /// <summary>A predicted seat after one tick: position, heading (radians) and velocity (room units, per second).</summary>
    public struct GenexSeatPose
    {
        public double X, Y, Z, Yaw, Vx, Vy, Vz;
    }

    /// <summary>How fast a predicted seat's pose moves at an input: room units and radians per ms.</summary>
    public struct GenexSeatRate
    {
        public double Vx, Vy, Vz, Vyaw;
    }

    /// <summary>A predicted seat at an input: its pose there and how fast its predicted track moves there.</summary>
    public struct GenexSeatMotion
    {
        public GenexSeatPose Pose;
        public GenexSeatRate Rate;
    }

    /// <summary>A seat in the pass it was drawn from (<c>Before</c>) and in the pass after it (<c>After</c>), at one input both
    /// passes stepped: what a new pass changed.</summary>
    public struct GenexSeatChange
    {
        public GenexSeatMotion Before, After;
    }

    /// <summary>The input other seats are drawn at (fractional) and the frame's time (ms).</summary>
    public struct GenexSeatClock
    {
        public double Seq, At;

        /// <summary>Clock constants (PredictSmoothing SEAT_CLOCK_TAU_MS, SEAT_CLOCK_SNAP_INPUTS).</summary>
        public const double TauMs = 100, SnapInputs = 1.5;

        /// <summary>
        /// The input other seats are drawn at this frame (seat-predict.ts <c>seatClock</c>): last frame's moved on by the time
        /// since at the room's tick rate, then pulled toward the input your entity is drawn at (<paramref name="raw"/>) by a share
        /// 1 − e^(−dt / TauMs), never back; more than SnapInputs off (a reset, a stall), it is <paramref name="raw"/>.
        /// </summary>
        public static GenexSeatClock Next(GenexSeatClock? known, double raw, double at, double tickHz)
        {
            if (known == null || double.IsNaN(known.Value.Seq) || double.IsInfinity(known.Value.Seq)) return new GenexSeatClock { Seq = raw, At = at };
            var k = known.Value;
            var dt = Math.Max(0, at - k.At);
            var ahead = k.Seq + (dt * tickHz) / 1000;
            var off = raw - ahead;
            if (Math.Abs(off) > SnapInputs) return new GenexSeatClock { Seq = raw, At = at };
            var pulled = ahead + off * (1 - Math.Exp(-dt / TauMs));
            return new GenexSeatClock { Seq = Math.Max(k.Seq, pulled), At = at };
        }
    }

    /// <summary>A seat touching yours drawn at your entity's exact input (seat-predict.ts, §17.11 *Touching*).</summary>
    public static class GenexSeatTouch
    {
        /// <summary>
        /// A seat's share of the way from the seat clock's input to your entity's exact one this frame (seat-predict.ts
        /// <c>seatTouchShare</c>): last frame's moved toward 1 while the seat touches yours and toward 0 when it does not, by
        /// dt / TauMs, within [0, 1]; a seat without a share yet (<paramref name="known"/> null) takes its target.
        /// </summary>
        public static double Share(double? known, bool touching, double dtMs)
        {
            if (!known.HasValue || double.IsNaN(known.Value) || double.IsInfinity(known.Value)) return touching ? 1 : 0;
            var step = Math.Max(0, dtMs) / GenexSeatClock.TauMs;
            return touching ? Math.Min(1, known.Value + step) : Math.Max(0, known.Value - step);
        }
    }

    /// <summary>One pass: the seats stepped from one state, tick by tick, as your inputs ack + 1, ack + 2, … were.</summary>
    public sealed class GenexSeatPassState
    {
        public long Id;
        public long Ack;
        public long StateTick;
        public double TickHz;
        /// <summary>The last of your inputs applied, and the ticks the seats were stepped.</summary>
        public long Last;
        public long Ticks;
        /// <summary>The seats, ids ascending.</summary>
        public readonly List<GenexHeldSeat> Seats = new List<GenexHeldSeat>();
        /// <summary>Each seat's pose after the tick your input <c>seq</c> was applied on (seq <c>Ack</c>: the state's).</summary>
        public readonly Dictionary<long, Dictionary<string, GenexSeatPose>> Poses = new Dictionary<long, Dictionary<string, GenexSeatPose>>();
        /// <summary>The seats touching your entity in the tick of input <c>seq</c> (before the contact pass).</summary>
        public readonly Dictionary<long, HashSet<string>> Touching = new Dictionary<long, HashSet<string>>();
        /// <summary>Your entity as that tick's pass was given it (after your step, before any contact).</summary>
        public readonly Dictionary<long, GenexContactBody> OwnIn = new Dictionary<long, GenexContactBody>();
        /// <summary>Your entity after the contact pass of the tick of input <c>seq</c>.</summary>
        public readonly Dictionary<long, GenexContactBody> Own = new Dictionary<long, GenexContactBody>();
    }

    /// <summary>What a <see cref="GenexSeatWorld"/> runs: the module's rules and the session's view of the latest state.</summary>
    public sealed class GenexSeatWorldOptions
    {
        /// <summary>The room module's seat contact rule, on two seats (<c>a</c> the lower id).</summary>
        public GenexContactRule Rule;
        /// <summary>The room module's whole contact pass; null: the rule once on every pair.</summary>
        public GenexSeatPass Pass;
        /// <summary>Every other seat in the latest state.</summary>
        public Func<IList<GenexHeldSeat>> Others;
        /// <summary>The room preset's step, or null when this client has none (seats are then extrapolated).</summary>
        public Func<GenexRemoteStep> Step;
        /// <summary>The room module's seat rule, run on each other seat before each of its steps.</summary>
        public GenexSeatRule SeatRule;
        /// <summary>How other seats move between states: <c>remotePredict</c> and <c>remoteDecayMs</c>.</summary>
        public Func<(string Predict, double DecayMs)> Remote;
        /// <summary>How far past a state other seats are predicted at most, ms (the lead cap and StallPredictMs).</summary>
        public Func<double> MaxAheadMs;
    }

    /// <summary>
    /// The other seats predicted from the latest state, as your own entity's prediction steps your inputs (seat-predict.ts
    /// <c>SeatWorld</c>). <see cref="Apply"/> after your input <c>seq</c> was stepped into your entity: a new pass starts when the
    /// state's ack or tick changed, or <c>seq</c> is not after the last input applied (a replay), and the other seats are
    /// stepped to that input's tick, then the contact pass runs on all of them and yours.
    /// </summary>
    public sealed class GenexSeatWorld
    {
        /// <summary>Other seats keep being predicted through a stall (no new state) this long past the lead cap, ms, then hold.</summary>
        public const double StallPredictMs = 500;

        private readonly GenexSeatWorldOptions options;
        private long serial;
        /// <summary>Passes before the current one that are stepped on with it, newest first, and how many are kept.</summary>
        private readonly List<GenexSeatPassState> recent = new List<GenexSeatPassState>();
        /// <summary>The seats touching your entity in the tick each of your inputs was stepped live in, by input.</summary>
        private readonly Dictionary<long, HashSet<string>> applied = new Dictionary<long, HashSet<string>>();
        /// <summary>The seats a pass found touching your entity in an input it was already stepped through that the input's
        /// live step did not have touching it (<see cref="TakeMissed"/>).</summary>
        private readonly SortedSet<string> missed = new SortedSet<string>(StringComparer.Ordinal);
        private const int RecentPasses = 3;
        /// <summary>MotionAt measures a track's slope this many inputs either side of the drawn one.</summary>
        private const double RateSpan = 0.5;

        /// <summary>The current pass (null before the first).</summary>
        public GenexSeatPassState Current { get; private set; }

        public GenexSeatWorld(GenexSeatWorldOptions options) => this.options = options ?? throw new ArgumentNullException(nameof(options));

        /// <summary>
        /// After your input <paramref name="seq"/> was stepped into <paramref name="own"/> (the state of tick
        /// <paramref name="stateTick"/> having consumed your inputs through <paramref name="ack"/>): the other seats stepped to that
        /// input's tick and the contact pass run on every seat. Your fields the pass changed are written back as float32.
        /// </summary>
        public void Apply(long seq, long ack, long stateTick, GenexContactBody own, double tickHz)
        {
            var previous = Current;
            var fresh = previous == null || previous.Ack != ack || previous.StateTick != stateTick || seq <= previous.Last;
            var now = fresh ? Start(ack, stateTick, tickHz) : previous;
            var j = seq - ack;
            // Ticks of inputs this pass did not see stepped (an own prediction that matched the server is not stepped again):
            // your entity as the previous pass was given it there, when it has it; the pass's changes to it are not kept.
            for (var i = now.Ticks + 1; i < j; i++)
            {
                GenexContactBody given = null;
                if (previous != null && previous.OwnIn.TryGetValue(ack + i, out var known))
                {
                    given = new GenexContactBody("");
                    given.CopyFrom(known);
                }
                Tick(now, i, given, false);
                NoteMissed(now, ack + i);
            }
            if (j > now.Ticks)
            {
                Tick(now, j, own, true);
                applied[seq] = now.Touching.TryGetValue(seq, out var touching) ? new HashSet<string>(touching) : new HashSet<string>();
            }
            now.Last = seq;
            foreach (var old in recent) Extend(old, now, seq);
        }

        /// <summary>
        /// The seats a pass found touching your entity that your prediction was not stepped with since the last call, ids
        /// ascending, and forgets them (seat-predict.ts <c>takeMissed</c>, §17.11 *Seat contacts*): a state that put your inputs
        /// in flight on later ticks re-runs inputs your entity was already stepped through, keeping none of its changes to
        /// yours; the session re-predicts your inputs from the state.
        /// </summary>
        public List<string> TakeMissed()
        {
            var list = new List<string>(missed);
            missed.Clear();
            return list;
        }

        /// <summary>Pass <paramref name="pass"/>'s re-run of your input <paramref name="seq"/>: each seat touching yours there
        /// that the input's live step did not have touching it is missed (a live step with no record is not judged).</summary>
        private void NoteMissed(GenexSeatPassState pass, long seq)
        {
            if (!applied.TryGetValue(seq, out var live) || !pass.Touching.TryGetValue(seq, out var now)) return;
            foreach (var id in now)
            {
                if (!live.Contains(id)) missed.Add(id);
            }
        }

        /// <summary>Pass <paramref name="old"/> stepped on to your input <paramref name="seq"/> with your entity as
        /// <paramref name="now"/> was given it at each tick.</summary>
        private void Extend(GenexSeatPassState old, GenexSeatPassState now, long seq)
        {
            var j = seq - old.Ack;
            for (var i = old.Ticks + 1; i <= j; i++)
            {
                GenexContactBody given = null;
                if (now.OwnIn.TryGetValue(old.Ack + i, out var known))
                {
                    given = new GenexContactBody("");
                    given.CopyFrom(known);
                }
                Tick(old, i, given, false);
            }
            old.Last = Math.Max(old.Last, seq);
        }

        /// <summary>seat-predict.ts <c>beyond</c>: a past pass's seat <paramref name="f"/> inputs after its last tick, on along
        /// the steps its last three ticks took, or by its velocity with fewer ticks.</summary>
        private static GenexSeatPose? Beyond(GenexSeatPassState pass, string id, long last, double f)
        {
            if (!TryPose(pass, last, id, out var p2)) return null;
            var has1 = TryPose(pass, last - 1, id, out var p1);
            var has0 = TryPose(pass, last - 2, id, out var p0);
            if (!has1)
            {
                var k = f / pass.TickHz;
                var o = p2;
                o.X = p2.X + p2.Vx * k;
                o.Y = p2.Y + p2.Vy * k;
                o.Z = p2.Z + p2.Vz * k;
                return o;
            }
            // At tick n past the last: the step n times and its change n(n + 1)/2 times; between two such ticks linear.
            var n = Math.Floor(f);
            double Ramp(double k) => (k * (k + 1)) / 2;
            double At(double x2, double d, double c)
            {
                var u = x2 + d * n + c * Ramp(n);
                var v = x2 + d * (n + 1) + c * Ramp(n + 1);
                return u + (v - u) * (f - n);
            }
            double Change(double x2, double x1, double x0) => has0 ? x2 - 2 * x1 + x0 : 0;
            var turn = GenexSeatOffset.Wrap(p2.Yaw - p1.Yaw);
            var turning = has0 ? turn - GenexSeatOffset.Wrap(p1.Yaw - p0.Yaw) : 0;
            var output = p2;
            output.X = At(p2.X, p2.X - p1.X, Change(p2.X, p1.X, p0.X));
            output.Y = At(p2.Y, p2.Y - p1.Y, Change(p2.Y, p1.Y, p0.Y));
            output.Z = At(p2.Z, p2.Z - p1.Z, Change(p2.Z, p1.Z, p0.Z));
            output.Yaw = GenexSeatOffset.Wrap(At(p2.Yaw, turn, turning));
            return output;
        }

        private static bool TryPose(GenexSeatPassState pass, long seq, string id, out GenexSeatPose pose)
        {
            pose = default;
            return pass.Poses.TryGetValue(seq, out var at) && at.TryGetValue(id, out pose);
        }

        /// <summary>Seat <paramref name="id"/> at your input <paramref name="seq"/> in <paramref name="pass"/> (default the current
        /// one): its pose and the slope of its predicted track over the half inputs either side, per ms.</summary>
        public GenexSeatMotion? MotionAt(string id, double seq, GenexSeatPassState pass = null)
        {
            var p = pass ?? Current;
            var pose = PoseAt(id, seq, p);
            var a = PoseAt(id, seq - RateSpan, p);
            var b = PoseAt(id, seq + RateSpan, p);
            if (pose == null || a == null || b == null || p == null) return null;
            var k = p.TickHz / 1000 / (2 * RateSpan);
            var av = a.Value;
            var bv = b.Value;
            return new GenexSeatMotion
            {
                Pose = pose.Value,
                Rate = new GenexSeatRate { Vx = (bv.X - av.X) * k, Vy = (bv.Y - av.Y) * k, Vz = (bv.Z - av.Z) * k, Vyaw = GenexSeatOffset.Wrap(bv.Yaw - av.Yaw) * k },
            };
        }

        /// <summary>What the current pass changed for seat <paramref name="id"/> from pass <paramref name="from"/> (the one it was
        /// last drawn from): the seat in both at your input <paramref name="seq"/>, or at <paramref name="from"/>'s last stepped
        /// input when <paramref name="seq"/> is past it (the seat clock draws up to 1.5 inputs ahead: there the current pass moves a
        /// seat on by its velocity and <paramref name="from"/> along its last steps, and the drawing's own advance read as a
        /// correction). Null when <paramref name="from"/> is current.</summary>
        public GenexSeatChange? ChangeAt(string id, double seq, GenexSeatPassState from)
        {
            if (Current == null || ReferenceEquals(Current, from)) return null;
            var common = from == null ? seq : Math.Min(seq, from.Ack + from.Ticks);
            var before = MotionAt(id, common, from);
            var after = MotionAt(id, common);
            if (before == null || after == null) return null;
            return new GenexSeatChange { Before = before.Value, After = after.Value };
        }

        /// <summary>Where seat <paramref name="id"/> is at your input <paramref name="seq"/> (fractional), in <paramref name="pass"/>
        /// (default the current one): between the two ticks around it, moved on by its velocity past the last one stepped (at most a
        /// tick). Null for a seat the pass does not have.</summary>
        public GenexSeatPose? PoseAt(string id, double seq, GenexSeatPassState pass = null)
        {
            var p = pass ?? Current;
            if (p == null) return null;
            var s = Math.Max(seq, p.Ack);
            var last = p.Ack + p.Ticks;
            var s0 = Math.Min(Math.Floor(s), last);
            if (!p.Poses.TryGetValue((long)s0, out var atS0) || !atS0.TryGetValue(id, out var a)) return null;
            GenexSeatPose? b = null;
            if (s0 < last && p.Poses.TryGetValue((long)s0 + 1, out var atS1) && atS1.TryGetValue(id, out var bb)) b = bb;
            var f = s - s0;
            if (b == null)
            {
                // Past the last tick stepped: the current pass on by its velocity, at most a tick (the next input steps
                // it); a pass before it on along its last ticks' steps and their change, as far as asked.
                if (!ReferenceEquals(p, Current)) return Beyond(p, id, (long)s0, f) ?? a;
                var k = Math.Min(f, 1) / p.TickHz;
                var o = a;
                o.X = a.X + a.Vx * k;
                o.Y = a.Y + a.Vy * k;
                o.Z = a.Z + a.Vz * k;
                return o;
            }
            var n = b.Value;
            return new GenexSeatPose
            {
                X = a.X + (n.X - a.X) * f, Y = a.Y + (n.Y - a.Y) * f, Z = a.Z + (n.Z - a.Z) * f,
                Yaw = a.Yaw + GenexSeatOffset.Wrap(n.Yaw - a.Yaw) * f,
                Vx = a.Vx + (n.Vx - a.Vx) * f, Vy = a.Vy + (n.Vy - a.Vy) * f, Vz = a.Vz + (n.Vz - a.Vz) * f,
            };
        }

        /// <summary>How fast seat <paramref name="id"/> moves in the latest state (the server's car, the pass's first pose), room
        /// units per ms (seat-predict.ts <c>stateRate</c>); null for a seat the current pass does not have.</summary>
        public GenexSeatRate? StateRate(string id)
        {
            var pass = Current;
            if (pass == null || !pass.Poses.TryGetValue(pass.Ack, out var poses) || !poses.TryGetValue(id, out var pose)) return null;
            return new GenexSeatRate { Vx = pose.Vx / 1000, Vy = pose.Vy / 1000, Vz = pose.Vz / 1000, Vyaw = 0 };
        }

        /// <summary>Whether seat <paramref name="id"/> touches your entity in the tick of your input nearest <paramref name="seq"/>.</summary>
        public bool TouchingAt(string id, double seq)
        {
            var pass = Current;
            if (pass == null) return false;
            // Math.round: half up.
            var s = (long)Math.Floor(Math.Max(seq, pass.Ack) + 0.5);
            return pass.Touching.TryGetValue(s, out var set) && set.Contains(id);
        }

        /// <summary>TouchAheadMs tries the seat this many steps along <see cref="GenexSeatClock.TauMs"/> of the two's relative motion.</summary>
        public const int TouchSamples = 8;

        /// <summary>
        /// How soon seat <paramref name="id"/> touches your entity from your input <paramref name="seq"/>, ms (seat-predict.ts
        /// <c>touchAheadMs</c>, §17.11 *Touching*): 0 when the pass's own contact test had the two touching in the tick of an input
        /// from <paramref name="seq"/> to the one after it; else the first of <see cref="TouchSamples"/> steps along
        /// <see cref="GenexSeatClock.TauMs"/> at which the room's contact rule touches your entity there with the seat moved on from
        /// it at the two's relative velocity; null when it does not (not touching).
        /// </summary>
        public double? TouchAheadMs(string id, double seq)
        {
            var pass = Current;
            if (pass == null) return null;
            var s0 = (long)Math.Floor(Math.Max(seq, pass.Ack));
            bool Touched(long n) => pass.Touching.TryGetValue(n, out var set) && set.Contains(id);
            if (Touched(s0) || Touched(s0 + 1)) return 0;
            GenexHeldSeat seat = null;
            foreach (var s in pass.Seats) if (s.Id == id) seat = s;
            var pose = PoseAt(id, seq, pass);
            var mine = OwnAt(pass, seq);
            if (seat == null || pose == null || mine == null) return null;
            var p = pose.Value;
            var body = ContactOf(id, seat.Body);
            body.X = p.X;
            body.Y = p.Y;
            body.Z = p.Z;
            body.Yaw = p.Yaw;
            body.Vx = p.Vx;
            body.Vy = p.Vy;
            body.Vz = p.Vz;
            double rx = (p.Vx - mine.Vx) / 1000, ry = (p.Vy - mine.Vy) / 1000, rz = (p.Vz - mine.Vz) / 1000;
            for (var k = 0; k <= TouchSamples; k++)
            {
                var t = ((double)k / TouchSamples) * GenexSeatClock.TauMs;
                var moved = new GenexContactBody("");
                moved.CopyFrom(body);
                moved.X = body.X + rx * t;
                moved.Y = body.Y + ry * t;
                moved.Z = body.Z + rz * t;
                if (Touches(mine, moved)) return t;
            }
            return null;
        }

        /// <summary>Your entity in <paramref name="pass"/> at input <paramref name="seq"/> (seat-predict.ts <c>ownAt</c>): between the
        /// two stepped inputs around it (positions linear, the heading along the short arc), held at the first and last; null
        /// before your entity is known.</summary>
        private static GenexContactBody OwnAt(GenexSeatPassState pass, double seq)
        {
            double last = pass.Ack + pass.Ticks;
            var s = Math.Min(Math.Max(seq, pass.Ack + 1), last);
            var s0 = Math.Floor(s);
            if (!pass.Own.TryGetValue((long)s0, out var a)) return null;
            var f = s - s0;
            if (!pass.Own.TryGetValue((long)s0 + 1, out var b) || f == 0) return a;
            var out_ = new GenexContactBody("");
            out_.CopyFrom(a);
            out_.X = a.X + (b.X - a.X) * f;
            out_.Y = a.Y + (b.Y - a.Y) * f;
            out_.Z = a.Z + (b.Z - a.Z) * f;
            out_.Yaw = a.Yaw + GenexSeatOffset.Wrap(b.Yaw - a.Yaw) * f;
            return out_;
        }

        private GenexSeatPassState Start(long ack, long stateTick, double tickHz)
        {
            var pass = new GenexSeatPassState { Ack = ack, StateTick = stateTick, TickHz = tickHz, Last = ack, Ticks = 0 };
            var others = options.Others?.Invoke();
            if (others != null)
            {
                foreach (var s in others)
                {
                    pass.Seats.Add(new GenexHeldSeat { Id = s.Id, Epoch = s.Epoch, Body = new Dictionary<string, double>(s.Body), Input = s.Input });
                }
            }
            StableSortById(pass.Seats, s => s.Id);
            var first = new Dictionary<string, GenexSeatPose>();
            foreach (var s in pass.Seats) first[s.Id] = PoseOf(s.Body);
            pass.Poses[ack] = first;
            serial += 1;
            pass.Id = serial;
            if (Current != null)
            {
                recent.Insert(0, Current);
                if (recent.Count > RecentPasses) recent.RemoveRange(RecentPasses, recent.Count - RecentPasses);
            }
            var stale = new List<long>();
            foreach (var k in applied.Keys)
            {
                if (k <= ack) stale.Add(k);
            }
            foreach (var k in stale) applied.Remove(k);
            Current = pass;
            return pass;
        }

        private void Tick(GenexSeatPassState pass, long i, GenexContactBody own, bool write)
        {
            var ahead = Math.Ceiling(((options.MaxAheadMs?.Invoke() ?? 0) * pass.TickHz) / 1000);
            if (i <= ahead) foreach (var seat in pass.Seats) Move(pass, seat, i);
            var bodies = new List<GenexContactBody>(pass.Seats.Count + 1);
            foreach (var s in pass.Seats) bodies.Add(ContactOf(s.Id, s.Body));
            var seq = pass.Ack + i;
            GenexContactBody mine = null;
            if (own != null)
            {
                mine = new GenexContactBody("");
                mine.CopyFrom(own);
                var given = new GenexContactBody("");
                given.CopyFrom(own);
                pass.OwnIn[seq] = given;
            }
            var touching = new HashSet<string>();
            if (mine != null) foreach (var b in bodies) if (Touches(mine, b)) touching.Add(b.Id);
            var all = new List<GenexContactBody>(bodies);
            if (mine != null)
            {
                all.Add(mine);
                StableSortById(all, b => b.Id);
            }
            ContactPass(all);
            for (var k = 0; k < pass.Seats.Count; k++) ToBody(bodies[k], pass.Seats[k].Body);
            if (own != null && mine != null && write)
            {
                own.X = WriteBack(mine.X, own.X);
                own.Y = WriteBack(mine.Y, own.Y);
                own.Z = WriteBack(mine.Z, own.Z);
                own.Vx = WriteBack(mine.Vx, own.Vx);
                own.Vy = WriteBack(mine.Vy, own.Vy);
                own.Vz = WriteBack(mine.Vz, own.Vz);
                own.Yaw = WriteBack(mine.Yaw, own.Yaw);
                own.Spin = WriteBack(mine.Spin, own.Spin);
            }
            var poses = new Dictionary<string, GenexSeatPose>();
            foreach (var s in pass.Seats) poses[s.Id] = PoseOf(s.Body);
            pass.Poses[seq] = poses;
            pass.Touching[seq] = touching;
            if (mine != null)
            {
                var after = new GenexContactBody("");
                after.CopyFrom(write && own != null ? own : mine);
                pass.Own[seq] = after;
            }
            pass.Ticks = i;
        }

        private void Move(GenexSeatPassState pass, GenexHeldSeat seat, long i)
        {
            var dt = 1 / pass.TickHz;
            var remote = options.Remote?.Invoke() ?? (GenexRemotePredict.Hold, GenexPhysicsKeyframe.DefaultRemoteDecayMs);
            var step = remote.Predict == GenexRemotePredict.Extrapolate ? null : options.Step?.Invoke();
            if (step == null || !seat.Input.HasValue)
            {
                var b = seat.Body;
                b["x"] = Num(b, "x") + Num(b, "vx") * dt;
                b["y"] = Num(b, "y") + Num(b, "vy") * dt;
                b["z"] = Num(b, "z") + Num(b, "vz") * dt;
                return;
            }
            options.SeatRule?.Invoke(seat.Body, pass.StateTick + i);
            var input = remote.Predict == GenexRemotePredict.InputDecay
                ? GenexPhysicsKeyframe.DecayedInput(seat.Input.Value, i, pass.TickHz, remote.DecayMs)
                : seat.Input.Value;
            step(seat.Body, input, dt);
        }

        private void ContactPass(List<GenexContactBody> all)
        {
            if (options.Pass != null)
            {
                options.Pass(all);
                return;
            }
            if (options.Rule == null) return;
            for (var a = 0; a < all.Count; a++) for (var b = a + 1; b < all.Count; b++) options.Rule(all[a], all[b]);
        }

        /// <summary>Whether the rule changes your entity or seat <paramref name="b"/> (copies of the two): they touch.</summary>
        private bool Touches(GenexContactBody mine, GenexContactBody b)
        {
            if (options.Rule == null) return false;
            var x = new GenexContactBody("");
            x.CopyFrom(mine);
            var y = new GenexContactBody("");
            y.CopyFrom(b);
            if (string.CompareOrdinal(x.Id, y.Id) < 0) options.Rule(x, y);
            else options.Rule(y, x);
            return !SameContact(x, mine) || !SameContact(y, b);
        }

        private static bool SameContact(GenexContactBody a, GenexContactBody b) =>
            a.X == b.X && a.Y == b.Y && a.Z == b.Z && a.Vx == b.Vx && a.Vy == b.Vy && a.Vz == b.Vz && a.Yaw == b.Yaw && a.Spin == b.Spin;

        /// <summary>A field the pass changed written back as float32 (seat-predict.ts: <c>v !== own[field]</c>; a NaN always is).</summary>
        private static double WriteBack(double v, double was) => v == was ? was : (double)(float)v;

        /// <summary>seat-predict.ts <c>num</c>: a finite number, else 0.</summary>
        private static double Num(Dictionary<string, double> b, string field) =>
            b.TryGetValue(field, out var v) && !double.IsNaN(v) && !double.IsInfinity(v) ? v : 0;

        private static GenexSeatPose PoseOf(Dictionary<string, double> b) => new GenexSeatPose
        {
            X = Num(b, "x"), Y = Num(b, "y"), Z = Num(b, "z"), Yaw = Num(b, "yaw"), Vx = Num(b, "vx"), Vy = Num(b, "vy"), Vz = Num(b, "vz"),
        };

        // A declared policy's pair rules read the seat's `flags` (seat-predict.ts contactOf: only when the body has them).
        private static GenexContactBody ContactOf(string id, Dictionary<string, double> b) => new GenexContactBody(id)
        {
            X = Num(b, "x"), Y = Num(b, "y"), Z = Num(b, "z"), Vx = Num(b, "vx"), Vy = Num(b, "vy"), Vz = Num(b, "vz"), Yaw = Num(b, "yaw"), Spin = Num(b, "spin"),
            Flags = Num(b, "flags"),
        };

        private static void ToBody(GenexContactBody c, Dictionary<string, double> b)
        {
            b["x"] = c.X;
            b["y"] = c.Y;
            b["z"] = c.Z;
            b["vx"] = c.Vx;
            b["vy"] = c.Vy;
            b["vz"] = c.Vz;
            b["yaw"] = c.Yaw;
            b["spin"] = c.Spin;
        }

        /// <summary>A stable sort by ordinal id (Array.prototype.sort is stable; List.Sort is not).</summary>
        private static void StableSortById<T>(List<T> list, Func<T, string> id)
        {
            for (var i = 1; i < list.Count; i++)
            {
                var item = list[i];
                var k = i - 1;
                while (k >= 0 && string.CompareOrdinal(id(list[k]), id(item)) > 0)
                {
                    list[k + 1] = list[k];
                    k--;
                }
                list[k + 1] = item;
            }
        }
    }

    /// <summary>The ease of your drawn car after a missed contact re-predicted your inputs (seat-predict.ts <c>shoveEase</c>): the shift
    /// from the new prediction to where the car was drawn eases out at <see cref="GenexSeatOffset.SeatTauMs"/>.</summary>
    public static class GenexShoveEase
    {
        /// <summary>The ease is done once what is left of it is under this, world units (<c>SHOVE_EASE_DONE</c>).</summary>
        public const double Done = 0.01;

        /// <summary>What is left <paramref name="elapsedMs"/> after the re-prediction of the shift (<paramref name="dx"/>, <paramref name="dy"/>,
        /// <paramref name="dz"/>): the offset to add to the predicted pose, and whether the largest axis is under <see cref="Done"/> (the ease
        /// is dropped and nothing is added).</summary>
        public static (double Dx, double Dy, double Dz, bool IsDone) Left(double dx, double dy, double dz, double elapsedMs)
        {
            var k = Math.Exp(-elapsedMs / GenexSeatOffset.SeatTauMs);
            var done = Math.Max(Math.Abs(dx), Math.Max(Math.Abs(dy), Math.Abs(dz))) * k < Done;
            return (dx * k, dy * k, dz * k, done);
        }
    }

    /// <summary>A drawn seat's correction: the offset (room units, radians) from its predicted pose to where it is drawn and how
    /// fast that offset is moving (per ms), the pass it was measured in and the seat's life (seat-predict.ts <c>SeatOffset</c>).</summary>
    public sealed class GenexSeatOffset
    {
        /// <summary>τ of another seat's drawn correction, ms, and while it touches your entity in the prediction (a bump lands where
        /// it is drawn); past SeatSnapMetres (times the room's units per metre) or at a new life it snaps
        /// (physics-keyframe.ts PredictSmoothing SEAT_TAU_MS, SEAT_CONTACT_TAU_MS, SEAT_SNAP_METRES).</summary>
        public const double SeatTauMs = 70;
        public const double SeatContactTauMs = 100;
        public const double SeatSnapMetres = 6;
        /// <summary>A seat drawn moving faster than SeatMovingUnitsPerMs is never pulled back against that motion while its
        /// prediction goes on that way; drawn slower for SeatHoldMs it returns from rest.</summary>
        public const double SeatHoldMs = 120;
        public const double SeatMovingUnitsPerMs = 0.2;

        public GenexSeatPassState Pass;
        public double Epoch;
        public double Dx, Dy, Dz, Dyaw, Vx, Vy, Vz, Vyaw;
        /// <summary>The predicted position it was drawn from (in that pass), the way the drawn seat was last seen moving (a unit
        /// vector, 0 before it moved) and how long it has been drawn slower than SeatMovingUnitsPerMs since.</summary>
        public double Ax, Ay, Az, Hx, Hy, Hz, StillMs;
        /// <summary>A new pass found it stopping late: slower along that way, at the same input, than the pass it was drawn from
        /// by more than SeatMovingUnitsPerMs; kept while it is drawn stopped, decided again by each pass that arrives while it is
        /// drawn moving.</summary>
        public bool StopFound;

        private GenexSeatOffset Copy() => (GenexSeatOffset)MemberwiseClone();

        /// <summary>An angle in [-π, π).</summary>
        public static double Wrap(double v) => v - 2 * Math.PI * Math.Floor((v + Math.PI) / (2 * Math.PI));

        /// <summary>τ of a seat's correction (ms).</summary>
        public static double TauMs(bool touching) => touching ? SeatContactTauMs : SeatTauMs;

        private static (double O, double V) Settle(double o, double v, double dt, double tau)
        {
            var w = 1 / tau;
            var e = Math.Exp(-w * dt);
            var k = v + w * o;
            return ((o + k * dt) * e, (v - w * k * dt) * e);
        }

        /// <summary>
        /// A seat's correction this frame (seat-predict.ts <c>seatOffset</c>): last frame's offset <paramref name="known"/> brought
        /// <paramref name="dtMs"/> closer to 0 by a critically damped return at the seat's τ, plus what a new pass changed
        /// (<paramref name="change"/>, <see cref="GenexSeatWorld.ChangeAt"/>): the offset takes the change of where it is and its
        /// rate the change of how fast it moves; the return never pulls it back against its drawn motion (KeepCourse), nor while
        /// the server's car (<paramref name="server"/>, its velocity in the latest state, <see cref="GenexSeatWorld.StateRate"/>)
        /// still moves that way.
        /// <paramref name="now"/> is the seat in this pass at the drawn input. A new life, no <paramref name="known"/>, or an
        /// offset over <paramref name="snapUnits"/> starts at 0.
        /// </summary>
        public static GenexSeatOffset Next(GenexSeatOffset known, GenexSeatPassState pass, double epoch, GenexSeatChange? change, GenexSeatMotion now, double dtMs, bool touching, double snapUnits, GenexSeatRate? server = null)
        {
            var fresh = new GenexSeatOffset { Pass = pass, Epoch = epoch, Ax = now.Pose.X, Ay = now.Pose.Y, Az = now.Pose.Z };
            if (known == null || known.Epoch != epoch) return fresh;
            var tau = TauMs(touching);
            var dt = Math.Max(0, dtMs);
            var (dx, vx) = Settle(known.Dx, known.Vx, dt, tau);
            var (dy, vy) = Settle(known.Dy, known.Vy, dt, tau);
            var (dz, vz) = Settle(known.Dz, known.Vz, dt, tau);
            var (dyaw, vyaw) = Settle(known.Dyaw, known.Vyaw, dt, tau);
            var moved = !ReferenceEquals(known.Pass, pass) && change.HasValue;
            // How far, and how much faster, the pass it was drawn from had the seat than this one.
            var p = moved ? change.Value.Before : now;
            var q = moved ? change.Value.After : now;
            double sx = p.Pose.X - q.Pose.X, sy = p.Pose.Y - q.Pose.Y, sz = p.Pose.Z - q.Pose.Z, syaw = Wrap(p.Pose.Yaw - q.Pose.Yaw);
            double ux = p.Rate.Vx - q.Rate.Vx, uy = p.Rate.Vy - q.Rate.Vy, uz = p.Rate.Vz - q.Rate.Vz, uyaw = p.Rate.Vyaw - q.Rate.Vyaw;
            // The track it is drawn on this frame, before its offset: this pass's, moved by that difference.
            var track = now;
            track.Pose.X = now.Pose.X + sx;
            track.Pose.Y = now.Pose.Y + sy;
            track.Pose.Z = now.Pose.Z + sz;
            track.Rate = new GenexSeatRate { Vx = now.Rate.Vx + ux, Vy = now.Rate.Vy + uy, Vz = now.Rate.Vz + uz, Vyaw = now.Rate.Vyaw + uyaw };
            var decayed = known.Copy();
            decayed.Pass = pass;
            decayed.Dx = dx;
            decayed.Dy = dy;
            decayed.Dz = dz;
            decayed.Dyaw = dyaw;
            decayed.Vx = vx;
            decayed.Vy = vy;
            decayed.Vz = vz;
            decayed.Vyaw = vyaw;
            decayed.StopFound = moved ? FoundStopping(known, ux, uy, uz) || (known.StopFound && known.StillMs > 0) : known.StopFound;
            var settled = KeepCourse(known, decayed, track, now.Rate, server);
            var output = settled.Copy();
            output.Dx = settled.Dx + sx;
            output.Dy = settled.Dy + sy;
            output.Dz = settled.Dz + sz;
            output.Dyaw = Wrap(settled.Dyaw + syaw);
            if (GenexSeatSeparation.Hypot(output.Dx, output.Dy, output.Dz) > snapUnits) return fresh;
            output.Vx = settled.Vx + ux;
            output.Vy = settled.Vy + uy;
            output.Vz = settled.Vz + uz;
            output.Vyaw = settled.Vyaw + uyaw;
            output.Ax = now.Pose.X;
            output.Ay = now.Pose.Y;
            output.Az = now.Pose.Z;
            return Moving(output, now.Rate, dt);
        }

        private static double Along(double x, double y, double z, GenexSeatOffset h) => x * h.Hx + y * h.Hy + z * h.Hz;

        /// <summary>seat-predict.ts <c>foundStopping</c>: a new pass has the seat slower along the way it was drawn moving than the
        /// pass it was drawn from, at the same input, by more than SeatMovingUnitsPerMs (u: that pass's rate less this one's).</summary>
        private static bool FoundStopping(GenexSeatOffset known, double ux, double uy, double uz) => Along(ux, uy, uz, known) > SeatMovingUnitsPerMs;

        /// <summary>seat-predict.ts <c>keepCourse</c>: this frame's return never pulls a drawn seat back against the way it was
        /// drawn moving while its track still goes that way; it stops instead (and any rate back it would leave it with). Held
        /// SeatHoldMs still: as is; turned back: as is, unless a pass found it stopping late and it is drawn ahead of its track
        /// while the server's car still moves that way faster than SeatMovingUnitsPerMs (then it stands SeatHoldMs first).</summary>
        private static GenexSeatOffset KeepCourse(GenexSeatOffset known, GenexSeatOffset settled, GenexSeatMotion track, GenexSeatRate ahead, GenexSeatRate? server)
        {
            var onTrack = Along(track.Rate.Vx, track.Rate.Vy, track.Rate.Vz, known);
            var tp = track.Pose;
            var trackMove = Along(tp.X - known.Ax, tp.Y - known.Ay, tp.Z - known.Az, known);
            var drawnMove = trackMove + Along(settled.Dx - known.Dx, settled.Dy - known.Dy, settled.Dz - known.Dz, known);
            var turnedBack = Along(ahead.Vx, ahead.Vy, ahead.Vz, known) < 0;
            var serverRolls = server.HasValue && Along(server.Value.Vx, server.Value.Vy, server.Value.Vz, known) > SeatMovingUnitsPerMs;
            var drawnAhead = Along(known.Dx, known.Dy, known.Dz, known) > 0;
            // Its prediction turning back is the drawing's lead on a stop found late, not the server's car: it stands first.
            var standsFirst = settled.StopFound && serverRolls && drawnAhead;
            var heldLongEnough = known.StillMs >= SeatHoldMs;
            if (heldLongEnough || (turnedBack && !standsFirst)) return settled;
            var drawnRate = onTrack + Along(settled.Vx, settled.Vy, settled.Vz, known);
            if (drawnMove >= 0 && drawnRate >= 0) return settled;
            var back = Math.Max(0, -drawnMove);
            var rest = -drawnRate;
            var o = settled.Copy();
            o.Dx = settled.Dx + back * known.Hx;
            o.Dy = settled.Dy + back * known.Hy;
            o.Dz = settled.Dz + back * known.Hz;
            o.Vx = settled.Vx + rest * known.Hx;
            o.Vy = settled.Vy + rest * known.Hy;
            o.Vz = settled.Vz + rest * known.Hz;
            return o;
        }

        /// <summary>seat-predict.ts <c>moving</c>: the way the drawn seat moves now, kept while faster than SeatMovingUnitsPerMs.</summary>
        private static GenexSeatOffset Moving(GenexSeatOffset o, GenexSeatRate rate, double dt)
        {
            var vx = rate.Vx + o.Vx;
            var vy = rate.Vy + o.Vy;
            var vz = rate.Vz + o.Vz;
            var speed = GenexSeatSeparation.Hypot(vx, vy, vz);
            if (speed > SeatMovingUnitsPerMs)
            {
                o.Hx = vx / speed;
                o.Hy = vy / speed;
                o.Hz = vz / speed;
                o.StillMs = 0;
                return o;
            }
            o.StillMs = o.StillMs + dt;
            return o;
        }
    }
}
