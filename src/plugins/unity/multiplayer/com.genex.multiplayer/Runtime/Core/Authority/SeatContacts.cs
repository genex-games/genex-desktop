// Seat contacts (PROTOCOL.md §17.11 *Seat contacts*), a port of packages/multiplayer/src/authority/seat-contacts.ts: a
// room module's rule between two seats' own entities (a car-to-car bump), run in your own entity's prediction. The module
// runs the rule on every pair of seats after each tick's preset steps; the client runs the same function after each of
// your predicted inputs, against every other seat's entity in the latest state moved on by its velocity to that input's
// tick. Pure: GenexAuthoritySession feeds it (GenexAuthorityOptions.Contacts);
// packages/netcode-bench/conformance/authority/seat-contacts.json holds it (GenexSmoke `seat-contacts`). Engine-agnostic.
// Also the seat rule (§17.11 *Seat rules*, GenexSeatRule): what the module does to a seat's own entity at a tick it
// announced in advance (a kickoff release), run before each predicted input of yours and each inputDecay step of another
// seat's.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A seat's entity as a seat contact rule sees and changes it (room units, per second).</summary>
    public sealed class GenexContactBody
    {
        /// <summary>The entity id (the rule's pairs are ordered by it).</summary>
        public string Id { get; internal set; }
        public double X, Y, Z, Vx, Vy, Vz, Yaw, Spin;

        /// <summary>What the contact policy (<see cref="GenexContactPolicy"/>) also reads: the entity's <c>flags</c> (bit k adds the
        /// tag <c>flag:k</c>, §17.11 *Contact policy*), its own <see cref="Tags"/> and whether its <c>jump</c> is held (a stomp's
        /// boost). Not part of a rule's change: <see cref="SameAs"/> leaves them out.</summary>
        public double Flags, Jump;
        public string[] Tags;

        public GenexContactBody(string id) => Id = id ?? "";

        internal void CopyFrom(GenexContactBody o)
        {
            Id = o.Id;
            X = o.X;
            Y = o.Y;
            Z = o.Z;
            Vx = o.Vx;
            Vy = o.Vy;
            Vz = o.Vz;
            Yaw = o.Yaw;
            Spin = o.Spin;
            Flags = o.Flags;
            Jump = o.Jump;
            Tags = o.Tags;
        }

        /// <summary>Whether the rule changed nothing, as the TypeScript's JSON text comparison judges it: two numbers are
        /// the same when equal (+0 and −0 alike) or both not finite (JSON writes either as null).</summary>
        internal bool SameAs(GenexContactBody o) =>
            Same(X, o.X) && Same(Y, o.Y) && Same(Z, o.Z) && Same(Vx, o.Vx) && Same(Vy, o.Vy) && Same(Vz, o.Vz) && Same(Yaw, o.Yaw) && Same(Spin, o.Spin)
            && string.Equals(Id, o.Id, StringComparison.Ordinal);

        private static bool Same(double a, double b) => a == b || (!IsFinite(a) && !IsFinite(b));

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);
    }

    /// <summary>
    /// A seat contact rule: what the room module does to two seats' entities after every tick's preset steps (a car-to-car
    /// bump), as a pure function of the two, <paramref name="a"/> the lower id. It changes their fields in place. The module
    /// must run this very function on the same pairs.
    /// </summary>
    public delegate void GenexContactRule(GenexContactBody a, GenexContactBody b);

    /// <summary>
    /// One client's seat contacts. A pass is the inputs stepped from one state: <see cref="Apply"/> for input <c>seq</c>
    /// under the state that consumed your inputs through <c>ack</c> starts a new pass when <c>ack</c> changed or <c>seq</c> is
    /// not after the last input stepped (a replay), taking the other seats from <c>others()</c>. A rule that throws throws out
    /// of <see cref="Apply"/>, your entity unchanged (as the TypeScript).
    /// </summary>
    public sealed class GenexSeatContacts
    {
        /// <summary>The fields of your own entity a seat contact rule may change.</summary>
        public static readonly string[] Fields = { "x", "y", "z", "vx", "vy", "vz", "yaw", "spin" };

        private sealed class Other
        {
            public readonly GenexContactBody Body = new GenexContactBody("");
            /// <summary>The input offset (seq − ack) the body moves on from.</summary>
            public long From;
            /// <summary>What this input's rule left it at, kept only once every seat's rule returned (a rule that throws
            /// changes no seat, as the TypeScript's map that never completes).</summary>
            public readonly GenexContactBody Next = new GenexContactBody("");
            public bool Changed;
        }

        private readonly GenexContactRule rule;
        private readonly Func<IList<GenexContactBody>> others;
        private bool hasPass;
        private long passAck, passLast;
        /// <summary>The pass's other seats, by id (pooled: the first <see cref="count"/> are this pass's).</summary>
        private readonly List<Other> pass = new List<Other>();
        private int count;
        private readonly GenexContactBody mine = new GenexContactBody("");
        private readonly GenexContactBody other = new GenexContactBody("");
        private readonly GenexContactBody before = new GenexContactBody("");

        /// <param name="rule">The room module's rule.</param>
        /// <param name="others">The other seats' entities in the latest state (read at each new pass; copied).</param>
        public GenexSeatContacts(GenexContactRule rule, Func<IList<GenexContactBody>> others)
        {
            this.rule = rule ?? throw new ArgumentNullException(nameof(rule));
            this.others = others ?? throw new ArgumentNullException(nameof(others));
        }

        private static int ById(Other a, Other b) => string.CompareOrdinal(a.Body.Id, b.Body.Id);

        private void NewPass(long ack)
        {
            hasPass = true;
            passAck = ack;
            passLast = ack;
            count = 0;
            var list = others();
            if (list != null)
            {
                foreach (var body in list)
                {
                    if (body == null) continue;
                    if (count == pass.Count) pass.Add(new Other());
                    var o = pass[count++];
                    o.Body.CopyFrom(body);
                    o.From = 0;
                }
            }
            // By id (a stable insertion sort: a handful of seats).
            for (var i = 1; i < count; i++)
            {
                var o = pass[i];
                var k = i - 1;
                while (k >= 0 && ById(pass[k], o) > 0)
                {
                    pass[k + 1] = pass[k];
                    k--;
                }
                pass[k + 1] = o;
            }
        }

        /// <summary>
        /// After your input <paramref name="seq"/> was stepped into <paramref name="own"/>: the rule against every other
        /// seat, moved on by its velocity to that input's tick (<c>seq − ack</c> ticks after the state, <paramref name="tickHz"/>
        /// a second), in id order, <c>a</c> the lower id. A seat the rule changed moves on from there. Your fields it changed
        /// are written back as float32 (the entity's wire type).
        /// </summary>
        public void Apply(long seq, long ack, GenexContactBody own, double tickHz)
        {
            if (own == null) throw new ArgumentNullException(nameof(own));
            if (!hasPass || passAck != ack || seq <= passLast) NewPass(ack);
            var j = seq - ack;
            mine.CopyFrom(own);
            for (var i = 0; i < count; i++)
            {
                var o = pass[i];
                var k = (j - o.From) / tickHz;
                var b = o.Body;
                other.CopyFrom(b);
                other.X = b.X + b.Vx * k;
                other.Y = b.Y + b.Vy * k;
                other.Z = b.Z + b.Vz * k;
                before.CopyFrom(other);
                if (string.CompareOrdinal(mine.Id, other.Id) < 0) rule(mine, other);
                else rule(other, mine);
                o.Changed = !other.SameAs(before);
                if (o.Changed) o.Next.CopyFrom(other);
            }
            for (var i = 0; i < count; i++)
            {
                var o = pass[i];
                if (!o.Changed) continue;
                o.Body.CopyFrom(o.Next);
                o.From = j;
            }
            // `v !== own[field]` (NaN is written, +0 over −0 is not), as float32.
            if (mine.X != own.X) own.X = (float)mine.X;
            if (mine.Y != own.Y) own.Y = (float)mine.Y;
            if (mine.Z != own.Z) own.Z = (float)mine.Z;
            if (mine.Vx != own.Vx) own.Vx = (float)mine.Vx;
            if (mine.Vy != own.Vy) own.Vy = (float)mine.Vy;
            if (mine.Vz != own.Vz) own.Vz = (float)mine.Vz;
            if (mine.Yaw != own.Yaw) own.Yaw = (float)mine.Yaw;
            if (mine.Spin != own.Spin) own.Spin = (float)mine.Spin;
            passLast = seq;
        }
    }


    /// <summary>Where a seat was drawn against your entity last frame (<see cref="GenexSeatSeparation.Around"/>'s memory, one a
    /// seat): its offset from your drawn entity, whether it was drawn off its own pose (<see cref="Held"/>: moved out of yours or
    /// going round it), its own pose's offset (<see cref="Bx"/>, <see cref="By"/>) and the frame's time (ms); for two other
    /// seats pushed apart (<see cref="HasPair"/>), the horizontal side the higher id's seat is pushed to from the lower's
    /// (<see cref="PairNx"/>, <see cref="PairNy"/>, kept until they part) and how much further apart along it they were drawn
    /// than their own poses (<see cref="PairPush"/>). TypeScript <c>SeatSide</c> with its <c>PairPush</c>.</summary>
    public struct GenexSeatSide
    {
        public double Dx, Dy, Dz;
        public bool Held;
        public double Bx, By, At;
        public bool HasPair;
        public double PairNx, PairNy, PairPush;
    }

    /// <summary>
    /// §17.11 <i>Drawing other seats</i>, <c>separate</c> (draw-only, a port of seat-contacts.ts <c>separateDrawn</c> and
    /// <c>separateAround</c>; held to packages/netcode-bench/conformance/carball/carball-separate.json by GenexSmoke
    /// <c>carball-separate</c>): another seat's drawn pose moved out of your drawn entity by the seat contact rule, and taken
    /// round your entity instead of across it. Your entity and the state are never changed. One instance per session: it
    /// holds the scratch bodies the rule runs on (no allocation a frame). The drawing turns with Math.Atan2/Cos/Sin, not
    /// §17.7's portable ones (a drawing, not a rule), so a port matches the TypeScript within the vectors' tolerance.
    /// </summary>
    public sealed class GenexSeatSeparation
    {
        /// <summary>A seat going round your entity turns at least this fast about its centre (rad/s), and as fast as its own
        /// pose moves past yours times RoundPerStraight (half a circle over its diameter).</summary>
        public const double SeatRoundRate = 3 * Math.PI;
        private const double RoundPerStraight = Math.PI / 2;
        /// <summary>A straight move crosses your entity when a point on it is pushed out by more than this share of the
        /// shorter of the move and the seat's distance from your centre, or by more than CrossDepth units (a long move: a seat
        /// let go a long way from its own pose jumps back to it, and 5% of a 250 u jump let it graze your car's corner 12 u
        /// deep).</summary>
        private const double CrossShare = 0.05;
        private const double CrossDepth = 8;
        /// <summary>Passes of <see cref="Seats"/>' pile at most (seat-contacts.ts PILE_PASSES).</summary>
        private const int PilePasses = 12;
        /// <summary>Points sampled on that move.</summary>
        private const int CrossSamples = 16;
        /// <summary>Halvings of the search for where a seat stops touching your entity along a heading, and how often it may
        /// double its reach first.</summary>
        private const int ClearHalvings = 30;
        private const int ClearDoublings = 8;
        private const double TwoPi = 2 * Math.PI;
        /// <summary>Pushes of <see cref="Drawn"/> at most, and the push left after the first under which it stops (units).</summary>
        private const int SeparatePasses = 8;
        private const double SeparateSlop = 0.01;
        /// <summary>The push <see cref="Drawn"/>'s pushes may leave (units): more, and the seat goes on to where it stops
        /// touching (ClearOnward).</summary>
        private const double SeparateLeft = 0.001;
        /// <summary>Halvings of ClearOnward's search, how many times it may double its reach, and its least reach (units).</summary>
        private const int OnwardHalvings = 30;
        private const int OnwardDoublings = 8;
        private const double ClearOnwardMin = 1;
        /// <summary>A seat drawn resting on your roof (or yours on its) is lifted off it by up to this much (units) rather than
        /// pushed out across the ground (seat-contacts.ts SEAT_LIFT_MAX), searched in LiftHalvings halvings.</summary>
        public const double SeatLiftMax = 4;
        private const int LiftHalvings = 20;
        /// <summary>Two other seats pushed apart ease back toward their own poses at most this fast (units a second of the
        /// pair's push; seat-contacts.ts SEAT_PAIR_EASE), over at most PairEaseDtMax seconds a frame.</summary>
        public const double SeatPairEase = 720;
        private const double PairEaseDtMax = 0.1;
        /// <summary>Halvings of the search for where two seats pushed apart along their side stop touching, and how many times
        /// it doubles its reach from PairReach (units) first.</summary>
        private const int PairHalvings = 24;
        private const int PairDoublings = 8;
        private const double PairReach = 64;

        private readonly GenexContactRule rule;
        private readonly GenexContactBody mine = new GenexContactBody("");
        private readonly GenexContactBody other = new GenexContactBody("");
        private readonly GenexContactBody placed = new GenexContactBody("");
        private readonly GenexContactBody lifted = new GenexContactBody("");
        private readonly GenexContactBody settledBody = new GenexContactBody("");

        /// <param name="rule">The room module's seat contact rule.</param>
        public GenexSeatSeparation(GenexContactRule rule) => this.rule = rule ?? throw new ArgumentNullException(nameof(rule));

        /// <summary>
        /// <paramref name="seat"/> moved out of <paramref name="you"/> (TypeScript <c>separateDrawn</c>): the rule run on copies
        /// of the two at rest, and the seat moved by its own change less yours, so the whole push is the seat's; repeated (up to
        /// SeparatePasses) while a rule whose bodies turn with where they are (car-ball's, laid on the band or a wall) leaves it
        /// inside, then on along the way the pushes took it to where it stops touching (ClearOnward).
        /// </summary>
        public (double X, double Y, double Z) Drawn(GenexContactBody you, GenexContactBody seat)
        {
            var p = (X: seat.X, Y: seat.Y, Z: seat.Z);
            for (var pass = 0; pass < SeparatePasses; pass++)
            {
                RunAt(you, seat, p);
                var next = (X: p.X + (other.X - p.X) - (mine.X - you.X), Y: p.Y + (other.Y - p.Y) - (mine.Y - you.Y), Z: p.Z + (other.Z - p.Z) - (mine.Z - you.Z));
                if (pass > 0 && SamePoint(next, p)) break;
                p = next;
                // A rule whose bodies keep their shape (two level cars) leaves them apart in one push; one whose bodies turn
                // with where they are may leave a seat it pushed still a little inside yours.
                if (pass == 0 && PushedAt(you, seat, p) <= SeparateSlop) break;
            }
            // A seat pushed to and fro across where the bodies turn can be left inside yours after every push: it goes on
            // along the way the pushes took it, to where it stops touching.
            return PushedAt(you, seat, p) > SeparateLeft ? ClearOnward(you, seat, p) : p;
        }

        /// <summary>The rule run on your entity and <paramref name="seat"/> drawn at <paramref name="p"/>, both at rest, into
        /// the scratch bodies <c>mine</c> and <c>other</c>.</summary>
        private void RunAt(GenexContactBody you, GenexContactBody seat, (double X, double Y, double Z) p)
        {
            mine.CopyFrom(you);
            mine.Vx = mine.Vy = mine.Vz = 0;
            other.CopyFrom(seat);
            other.X = p.X;
            other.Y = p.Y;
            other.Z = p.Z;
            other.Vx = other.Vy = other.Vz = 0;
            if (string.CompareOrdinal(mine.Id, other.Id) < 0) rule(mine, other);
            else rule(other, mine);
        }

        /// <summary>seat-contacts.ts <c>pushOf</c>: the push the rule gives <paramref name="seat"/> drawn at <paramref name="p"/>
        /// off your entity, both at rest (its move less yours).</summary>
        private (double X, double Y, double Z) PushOf(GenexContactBody you, GenexContactBody seat, (double X, double Y, double Z) p)
        {
            RunAt(you, seat, p);
            return (other.X - p.X - (mine.X - you.X), other.Y - p.Y - (mine.Y - you.Y), other.Z - p.Z - (mine.Z - you.Z));
        }

        /// <summary>seat-contacts.ts <c>pushedAt</c>: how far the rule pushes <paramref name="seat"/> drawn at <paramref name="p"/>
        /// off your entity, both at rest.</summary>
        private double PushedAt(GenexContactBody you, GenexContactBody seat, (double X, double Y, double Z) p)
        {
            var v = PushOf(you, seat, p);
            return Hypot(v.X, v.Y, v.Z);
        }

        /// <summary>seat-contacts.ts <c>clearOnward</c>: the seat at <paramref name="p"/>, left inside your entity by the pushes,
        /// moved on along the way they took it from its own pose (else along the push the rule gives it there) to the nearest
        /// distance where the rule no longer pushes it; <paramref name="p"/> when no such distance is found.</summary>
        private (double X, double Y, double Z) ClearOnward(GenexContactBody you, GenexContactBody seat, (double X, double Y, double Z) p)
        {
            var from = (X: seat.X, Y: seat.Y, Z: seat.Z);
            var moved = (X: p.X - from.X, Y: p.Y - from.Y, Z: p.Z - from.Z);
            var d = Hypot(moved.X, moved.Y, moved.Z) > 0 ? moved : PushOf(you, seat, from);
            var len = Hypot(d.X, d.Y, d.Z);
            if (len == 0) return p;
            var u = (X: d.X / len, Y: d.Y / len, Z: d.Z / len);
            (double X, double Y, double Z) Along(double t) => (from.X + u.X * t, from.Y + u.Y * t, from.Z + u.Z * t);
            bool Touches(double t) => PushedAt(you, seat, Along(t)) > 0;
            var lo = len;
            var hi = len + Math.Max(ClearOnwardMin, len);
            for (var i = 0; i < OnwardDoublings && Touches(hi); i++)
            {
                lo = hi;
                hi = len + (hi - len) * 2;
            }
            if (Touches(hi)) return p;
            for (var i = 0; i < OnwardHalvings; i++)
            {
                var mid = (lo + hi) / 2;
                if (Touches(mid)) lo = mid;
                else hi = mid;
            }
            return Along(hi);
        }

        /// <summary>seat-contacts.ts <c>liftOff</c>: <paramref name="seat"/> lifted off <paramref name="you"/> along z (up when its
        /// base is at or above yours, else down) by the least amount up to SeatLiftMax that leaves the rule nothing to push, or
        /// <paramref name="seat"/> itself when it does not touch you or no such lift does (it is beside you, not on you).</summary>
        private GenexContactBody LiftOff(GenexContactBody you, GenexContactBody seat)
        {
            var up = seat.Z >= you.Z ? 1.0 : -1.0;
            bool TouchesAt(double k) => PushAt(you, seat, seat.X - you.X, seat.Y - you.Y, seat.Z - you.Z + up * k) > 0;
            if (!TouchesAt(0) || TouchesAt(SeatLiftMax)) return seat;
            var lo = 0.0;
            var hi = SeatLiftMax;
            for (var i = 0; i < LiftHalvings; i++)
            {
                var mid = (lo + hi) / 2;
                if (TouchesAt(mid)) lo = mid;
                else hi = mid;
            }
            lifted.CopyFrom(seat);
            lifted.Z = seat.Z + up * hi;
            return lifted;
        }

        /// <summary>seat-contacts.ts <c>settled</c>: the seat at offset (dx, dy, dz) from your entity moved out of it by the rule's
        /// own push (<see cref="Drawn"/>) when it is still inside it there: a search or an easing along a ray at one height can
        /// end inside bodies laid on the band or a wall. A push of a float's worth (SeparateLeft) is left as it is.</summary>
        private (double X, double Y, double Z) Settled(GenexContactBody you, GenexContactBody seat, double dx, double dy, double dz)
        {
            settledBody.CopyFrom(seat);
            settledBody.X = you.X + dx;
            settledBody.Y = you.Y + dy;
            settledBody.Z = you.Z + dz;
            settledBody.Vx = settledBody.Vy = settledBody.Vz = 0;
            if (!(PushedAt(you, settledBody, (settledBody.X, settledBody.Y, settledBody.Z)) > SeparateLeft)) return (dx, dy, dz);
            var output = Drawn(you, settledBody);
            return (output.X - you.X, output.Y - you.Y, output.Z - you.Z);
        }

        /// <summary>Drawn at an offset off the seat's own way (held), settled out of yours first.</summary>
        private (double X, double Y, double Z) DrawHeld(GenexContactBody you, GenexContactBody seat, double dx, double dy, double dz, double bx, double by, double now, out GenexSeatSide side)
        {
            var o = Settled(you, seat, dx, dy, dz);
            return Draw(you, o.X, o.Y, o.Z, true, bx, by, now, out side);
        }

        /// <summary>
        /// Another seat's drawn pose <paramref name="seat"/> moved out of your drawn entity <paramref name="you"/> without ever
        /// being drawn across it (TypeScript <c>separateAround</c>), given where it was drawn last frame (<paramref name="prev"/>,
        /// null for a seat not drawn against yours a frame ago) at <paramref name="now"/> (ms). When the straight move from last
        /// frame's drawn seat to this frame's separated one goes through your entity, a seat drawn off its own pose goes round
        /// yours instead, and one drawn on its own pose is pushed out on the side it came from. Returns the drawn position and
        /// this frame's memory in <paramref name="side"/>.
        /// </summary>
        public (double X, double Y, double Z) Around(GenexContactBody you, GenexContactBody drawnSeat, GenexSeatSide? prev, double now, out GenexSeatSide side, bool blocked = false)
        {
            var seat = LiftOff(you, drawnSeat);
            var output = Drawn(you, seat);
            var tdx = output.X - you.X;
            var tdy = output.Y - you.Y;
            var tdz = output.Z - you.Z;
            var moved = output.X != seat.X || output.Y != seat.Y || output.Z != seat.Z;
            var bx = seat.X - you.X;
            var by = seat.Y - you.Y;
            if (prev == null || !(blocked || Crosses(you, seat, prev.Value, tdx, tdy, tdz))) return Draw(you, tdx, tdy, tdz, moved, bx, by, now, out side);
            var p = prev.Value;
            var rPrev = Hypot(p.Dx, p.Dy, 0);
            var rTarget = Hypot(tdx, tdy, 0);
            var from = Math.Atan2(p.Dy, p.Dx);
            if (!p.Held)
            {
                if (p.Dx * tdx + p.Dy * tdy >= 0) return Draw(you, tdx, tdy, tdz, moved, bx, by, now, out side);
                var back = ClearAlong(you, seat, from, tdz, Math.Max(rPrev, rTarget));
                return DrawHeld(you, seat, back * Math.Cos(from), back * Math.Sin(from), tdz, bx, by, now, out side);
            }
            var turn = TurnOf(Math.Atan2(tdy, tdx) - from);
            var passed = rPrev > 0 ? (RoundPerStraight * Hypot(bx - p.Bx, by - p.By, 0)) / rPrev : 0;
            var rate = Math.Max(passed, (SeatRoundRate * Math.Max(0, now - p.At)) / 1000);
            var step = Math.Min(Math.Abs(turn), rate);
            var share = turn == 0 ? 1 : step / Math.Abs(turn);
            var angle = from + SignOf(turn) * step;
            // Over or under yours (a seat beside yours up a wall goes round it in the wall's plane): its height moves at most the
            // arc the way round may travel this frame, never across yours in one frame.
            var rise = tdz - p.Dz;
            var riseMax = rate * Math.Max(rPrev, rTarget);
            var dz = Math.Abs(rise * share) > riseMax ? p.Dz + SignOf(rise) * riseMax : p.Dz + rise * share;
            var r = Math.Max(rPrev + (rTarget - rPrev) * share, ClearAlong(you, seat, angle, dz, Math.Max(rPrev, rTarget)));
            return DrawHeld(you, seat, r * Math.Cos(angle), r * Math.Sin(angle), dz, bx, by, now, out side);
        }

        private static (double X, double Y, double Z) Draw(GenexContactBody you, double dx, double dy, double dz, bool held, double bx, double by, double now, out GenexSeatSide side)
        {
            side = new GenexSeatSide { Dx = dx, Dy = dy, Dz = dz, Held = held, Bx = bx, By = by, At = now };
            return (you.X + dx, you.Y + dy, you.Z + dz);
        }

        /// <summary>How far the rule pushes the seat at offset (dx, dy, dz) from your entity, at rest, out of it (0 when the two
        /// do not touch).</summary>
        private double PushAt(GenexContactBody you, GenexContactBody seat, double dx, double dy, double dz)
        {
            placed.CopyFrom(seat);
            placed.X = you.X + dx;
            placed.Y = you.Y + dy;
            placed.Z = you.Z + dz;
            placed.Vx = placed.Vy = placed.Vz = 0;
            var output = Drawn(you, placed);
            return Hypot(output.X - placed.X, output.Y - placed.Y, output.Z - placed.Z);
        }

        private readonly GenexContactBody sweepBody = new GenexContactBody("");

        /// <summary>Whether the move of <paramref name="seat"/>'s drawing from last frame's offset <paramref name="was"/> to
        /// <paramref name="to"/> (both from your entity) sweeps it through another seat of <paramref name="order"/> where that one was
        /// drawn last frame (seat-contacts.ts <c>sweepsThrough</c>): a seat let go on its own pose across yours was drawn leaping
        /// through a third car beside yours.</summary>
        private bool SweepsThrough(GenexContactBody you, GenexContactBody seat, IList<GenexContactBody> order, Func<string, GenexSeatSide?> prev, GenexSeatSide was, (double X, double Y, double Z) to)
        {
            var tx = to.X - you.X;
            var ty = to.Y - you.Y;
            var tz = to.Z - you.Z;
            foreach (var other in order)
            {
                if (ReferenceEquals(other, seat)) continue;
                var at = prev(other.Id);
                if (at == null) continue;
                var a = at.Value;
                sweepBody.CopyFrom(other);
                sweepBody.X = you.X + a.Dx;
                sweepBody.Y = you.Y + a.Dy;
                sweepBody.Z = you.Z + a.Dz;
                sweepBody.Vx = sweepBody.Vy = sweepBody.Vz = 0;
                var from = new GenexSeatSide { Dx = was.Dx - a.Dx, Dy = was.Dy - a.Dy, Dz = was.Dz - a.Dz };
                if (Crosses(sweepBody, seat, from, tx - a.Dx, ty - a.Dy, tz - a.Dz)) return true;
            }
            return false;
        }

        /// <summary>Whether the straight move from offset <paramref name="from"/> to (tdx, tdy, tdz) goes through your entity.</summary>
        private bool Crosses(GenexContactBody you, GenexContactBody seat, GenexSeatSide from, double tdx, double tdy, double tdz)
        {
            var length = Hypot(tdx - from.Dx, tdy - from.Dy, tdz - from.Dz);
            var reach = Math.Min(length, Hypot(from.Dx, from.Dy, from.Dz));
            if (reach == 0) return false;
            for (var k = 1; k < CrossSamples; k++)
            {
                var s = (double)k / CrossSamples;
                if (PushAt(you, seat, from.Dx + (tdx - from.Dx) * s, from.Dy + (tdy - from.Dy) * s, from.Dz + (tdz - from.Dz) * s) > Math.Min(CrossShare * reach, CrossDepth)) return true;
            }
            return false;
        }

        /// <summary>The nearest distance from your entity's centre along heading <paramref name="angle"/>, at height
        /// <paramref name="dz"/>, where the seat no longer touches it (searched from <paramref name="reach"/>; 0 when it touches
        /// nowhere along the heading).</summary>
        private double ClearAlong(GenexContactBody you, GenexContactBody seat, double angle, double dz, double reach)
        {
            var c = Math.Cos(angle);
            var s = Math.Sin(angle);
            if (!(PushAt(you, seat, 0, 0, dz) > 0) || reach <= 0) return 0;
            var lo = 0.0;
            var hi = reach;
            for (var i = 0; i < ClearDoublings && PushAt(you, seat, hi * c, hi * s, dz) > 0; i++)
            {
                lo = hi;
                hi *= 2;
            }
            for (var i = 0; i < ClearHalvings; i++)
            {
                var mid = (lo + hi) / 2;
                if (PushAt(you, seat, mid * c, mid * s, dz) > 0) lo = mid;
                else hi = mid;
            }
            return hi;
        }

        /// <summary>The memory key of two other seats' pair in <see cref="Seats"/> (seat-contacts.ts <c>seatPairKey</c>): the lower
        /// id, a NUL, the higher.</summary>
        public static string PairKey(string a, string b) => string.CompareOrdinal(a, b) < 0 ? a + "\u0000" + b : b + "\u0000" + a;

        private readonly GenexContactBody pileA = new GenexContactBody("");
        private readonly GenexContactBody pileB = new GenexContactBody("");

        private static GenexContactBody At(GenexContactBody into, GenexContactBody seat, (double X, double Y, double Z) p)
        {
            into.CopyFrom(seat);
            into.X = p.X;
            into.Y = p.Y;
            into.Z = p.Z;
            into.Vx = into.Vy = into.Vz = 0;
            return into;
        }

        private static bool SamePoint((double X, double Y, double Z) p, (double X, double Y, double Z) q) => p.X == q.X && p.Y == q.Y && p.Z == q.Z;

        /// <summary>seat-contacts.ts <c>pushApart</c>: two seats (<paramref name="a"/> the lower id) pushed apart, half each.</summary>
        private bool PushApart(GenexContactBody a, GenexContactBody b, Dictionary<string, (double X, double Y, double Z)> drawn)
        {
            var pa = drawn[a.Id];
            var pb = drawn[b.Id];
            var output = Drawn(At(pileA, a, pa), At(pileB, b, pb));
            if (SamePoint(output, pb)) return false;
            var hx = (output.X - pb.X) / 2;
            var hy = (output.Y - pb.Y) / 2;
            var hz = (output.Z - pb.Z) / 2;
            drawn[a.Id] = (pa.X - hx, pa.Y - hy, pa.Z - hz);
            drawn[b.Id] = (pb.X + hx, pb.Y + hy, pb.Z + hz);
            return true;
        }

        /// <summary>seat-contacts.ts <c>touchAt</c>: whether the rule pushes <paramref name="b"/> drawn at <paramref name="pb"/> off
        /// <paramref name="a"/> drawn at <paramref name="pa"/> (both at rest).</summary>
        private bool TouchAt(GenexContactBody a, GenexContactBody b, (double X, double Y, double Z) pa, (double X, double Y, double Z) pb) =>
            !SamePoint(Drawn(At(pileA, a, pa), At(pileB, b, pb)), pb);

        private static (double X, double Y, double Z) PointOf(GenexContactBody body) => (body.X, body.Y, body.Z);

        /// <summary>seat-contacts.ts <c>pushedBy</c>: <paramref name="pa"/> and <paramref name="pb"/> pushed apart along (nx, ny)
        /// by <paramref name="k"/> units, half each (<c>a</c> back, <c>b</c> on).</summary>
        private static ((double X, double Y, double Z) A, (double X, double Y, double Z) B) PushedBy((double X, double Y, double Z) pa, (double X, double Y, double Z) pb, double nx, double ny, double k) =>
            ((pa.X - (nx * k) / 2, pa.Y - (ny * k) / 2, pa.Z), (pb.X + (nx * k) / 2, pb.Y + (ny * k) / 2, pb.Z));

        /// <summary>seat-contacts.ts <c>pushFrom</c>: the least push along (nx, ny) from <paramref name="floor"/> up that leaves
        /// the two seats apart.</summary>
        private double PushFrom(GenexContactBody a, GenexContactBody b, (double X, double Y, double Z) pa, (double X, double Y, double Z) pb, double nx, double ny, double floor)
        {
            bool Touches(double k)
            {
                var q = PushedBy(pa, pb, nx, ny, k);
                return TouchAt(a, b, q.A, q.B);
            }
            if (!Touches(floor)) return floor;
            var lo = floor;
            var hi = floor + PairReach;
            for (var i = 0; i < PairDoublings && Touches(hi); i++)
            {
                lo = hi;
                hi = floor + (hi - floor) * 2;
            }
            for (var i = 0; i < PairHalvings; i++)
            {
                var mid = (lo + hi) / 2;
                if (Touches(mid)) lo = mid;
                else hi = mid;
            }
            return hi;
        }

        /// <summary>seat-contacts.ts <c>unit</c>: a horizontal unit vector along (x, y), or false when it has no length.</summary>
        private static bool UnitOf(double x, double y, out double nx, out double ny)
        {
            var len = Hypot(x, y, 0);
            nx = 0;
            ny = 0;
            if (!(len > 0)) return false;
            nx = x / len;
            ny = y / len;
            return true;
        }

        /// <summary>seat-contacts.ts <c>sideOf</c>: the side two seats that start to touch are pushed apart on: the axis the rule
        /// pushes the higher id's seat along, turned toward the side it was drawn on last frame, else the side it is drawn on now;
        /// without a push, that side; else +x.</summary>
        private (double Nx, double Ny) SideOf(GenexContactBody a, GenexContactBody b, (double X, double Y, double Z) pa, (double X, double Y, double Z) pb, GenexSeatSide? prev)
        {
            var pushed = Drawn(At(pileA, a, pa), At(pileB, b, pb));
            double fx = 0, fy = 0;
            var hasFrom = (prev != null && UnitOf(prev.Value.Dx, prev.Value.Dy, out fx, out fy)) || UnitOf(pb.X - pa.X, pb.Y - pa.Y, out fx, out fy);
            var hasAxis = UnitOf(pushed.X - pb.X, pushed.Y - pb.Y, out var ax, out var ay);
            if (!hasAxis) return hasFrom ? (fx, fy) : (1.0, 0.0);
            var flip = hasFrom && ax * fx + ay * fy < 0 ? -1.0 : 1.0;
            return (flip * ax, flip * ay);
        }

        /// <summary>seat-contacts.ts <c>crossedApart</c>: two seats pushed apart on side (nx, ny) last frame whose own poses no
        /// longer touch and lie the other way round.</summary>
        private bool CrossedApart(GenexContactBody a, GenexContactBody b, double nx, double ny) =>
            nx * (b.X - a.X) + ny * (b.Y - a.Y) < 0 && !TouchAt(a, b, PointOf(a), PointOf(b));

        /// <summary>seat-contacts.ts <c>netPush</c>: how much further apart along (nx, ny) two seats are drawn than their own poses.</summary>
        private static double NetPush(GenexContactBody a, GenexContactBody b, (double X, double Y, double Z) pa, (double X, double Y, double Z) pb, double nx, double ny) =>
            nx * (pb.X - pa.X - (b.X - a.X)) + ny * (pb.Y - pa.Y - (b.Y - a.Y));

        /// <summary>seat-contacts.ts <c>pushPair</c>: two seats (<paramref name="a"/> the lower id) kept apart: two whose own poses
        /// are inside each other, or that were pushed on a side last frame (<paramref name="prev"/>, <paramref name="dt"/> seconds
        /// ago), pushed apart on that side by the least push that parts them, and on a frame's first pass at least last frame's
        /// push less SeatPairEase · dt; two whose own poses are apart pushed apart by the rule (PushApart). Whether it pushed.</summary>
        private bool PushPair(GenexContactBody a, GenexContactBody b, Dictionary<string, (double X, double Y, double Z)> drawn, Dictionary<string, (double Nx, double Ny)> state, GenexSeatSide? prev, double dt)
        {
            var key = PairKey(a.Id, b.Id);
            var pa = drawn[a.Id];
            var pb = drawn[b.Id];
            var floor = 0.0;
            if (!state.TryGetValue(key, out var side))
            {
                var hasWas = prev != null && prev.Value.HasPair;
                var letGo = hasWas ? CrossedApart(a, b, prev.Value.PairNx, prev.Value.PairNy) : !TouchAt(a, b, PointOf(a), PointOf(b));
                if (letGo) return PushApart(a, b, drawn);
                side = hasWas ? (prev.Value.PairNx, prev.Value.PairNy) : SideOf(a, b, pa, pb, prev);
                state[key] = side;
                var eased = hasWas ? prev.Value.PairPush - SeatPairEase * Math.Min(dt, PairEaseDtMax) : 0;
                floor = Math.Max(0, eased - NetPush(a, b, pa, pb, side.Nx, side.Ny));
            }
            var k = PushFrom(a, b, pa, pb, side.Nx, side.Ny, floor);
            if (k <= 0) return false;
            var q = PushedBy(pa, pb, side.Nx, side.Ny, k);
            drawn[a.Id] = q.A;
            drawn[b.Id] = q.B;
            return true;
        }

        /// <summary>seat-contacts.ts <c>keepSide</c>: a pair kept on its sides of each other from last frame.</summary>
        private void KeepSide(GenexContactBody a, GenexContactBody b, Dictionary<string, (double X, double Y, double Z)> drawn, GenexSeatSide? prev, Func<string, double> moved)
        {
            if (prev == null) return;
            var p = prev.Value;
            var pa = drawn[a.Id];
            var pb = drawn[b.Id];
            var ndx = pb.X - pa.X;
            var ndy = pb.Y - pa.Y;
            var ndz = pb.Z - pa.Z;
            if (p.Dx * ndx + p.Dy * ndy >= 0) return;
            var bodyA = At(new GenexContactBody(""), a, pa);
            var bodyB = At(new GenexContactBody(""), b, pb);
            if (!Crosses(bodyA, bodyB, p, ndx, ndy, ndz)) return;
            var heading = Math.Atan2(p.Dy, p.Dx);
            var r = ClearAlong(bodyA, bodyB, heading, p.Dz, Hypot(p.Dx, p.Dy, 0));
            var kdx = r * Math.Cos(heading);
            var kdy = r * Math.Sin(heading);
            if (moved(b.Id) >= moved(a.Id))
            {
                drawn[b.Id] = (pa.X + kdx, pa.Y + kdy, pa.Z + p.Dz);
                return;
            }
            drawn[a.Id] = (pb.X - kdx, pb.Y - kdy, pb.Z - p.Dz);
        }

        /// <summary>seat-contacts.ts <c>offYours</c>: the seat drawn at <paramref name="p"/> moved back out of your entity, unless
        /// that crosses yours from where <see cref="Around"/> drew it this frame (<paramref name="first"/>).</summary>
        private (double X, double Y, double Z) OffYours(GenexContactBody you, GenexContactBody seat, (double X, double Y, double Z) p, (double X, double Y, double Z) first)
        {
            var body = At(new GenexContactBody(""), seat, p);
            var output = Drawn(you, body);
            if (SamePoint(output, p)) return p;
            var from = new GenexSeatSide { Dx = first.X - you.X, Dy = first.Y - you.Y, Dz = first.Z - you.Z };
            return Crosses(you, body, from, output.X - you.X, output.Y - you.Y, output.Z - you.Z) ? first : output;
        }

        /// <summary>
        /// Every other seat's drawn pose <paramref name="seats"/> moved out of your drawn entity <paramref name="you"/>, never across
        /// it, and out of each other, never across each other (seat-contacts.ts <c>separateSeats</c>; draw-only), given last frame's
        /// memory <paramref name="prev"/> (each seat's by its id, each pair's by <see cref="PairKey"/>) at <paramref name="now"/> (ms):
        /// each seat moved out of yours (<see cref="Around"/>); each pair kept on its sides of each other from last frame; then a
        /// pile of up to PilePasses passes until no two touch: each seat drawn into yours moved back out of it (unless that crosses
        /// yours from where the first step drew it), every two seats that touch pushed apart, half each; the last pass ends with the
        /// step out of yours. Returns each seat's drawn position by id; this frame's memory goes into <paramref name="sides"/>
        /// (cleared first). Held to carball-separate.json <c>piles</c> (GenexSmoke <c>carball-separate</c>).
        /// </summary>
        public Dictionary<string, (double X, double Y, double Z)> Seats(GenexContactBody you, IList<GenexContactBody> seats, IReadOnlyDictionary<string, GenexSeatSide> prev, double now, Dictionary<string, GenexSeatSide> sides)
        {
            var order = new List<GenexContactBody>(seats);
            for (var i = 1; i < order.Count; i++)
            {
                var item = order[i];
                var k = i - 1;
                while (k >= 0 && string.CompareOrdinal(order[k].Id, item.Id) > 0)
                {
                    order[k + 1] = order[k];
                    k--;
                }
                order[k + 1] = item;
            }
            GenexSeatSide? PrevOf(string key) => prev != null && prev.TryGetValue(key, out var side) ? side : (GenexSeatSide?)null;
            var drawn = new Dictionary<string, (double X, double Y, double Z)>();
            foreach (var seat in order)
            {
                var was = PrevOf(seat.Id);
                var around1 = Around(you, seat, was, now, out var side1);
                // A held seat let go onto its own pose is drawn there at once: not through a third car.
                var through = was.HasValue && was.Value.Held && !side1.Held && SweepsThrough(you, seat, order, PrevOf, was.Value, around1);
                drawn[seat.Id] = through ? Around(you, seat, was, now, out _, true) : around1;
            }
            var around = new Dictionary<string, (double X, double Y, double Z)>(drawn);
            // How far each seat is drawn from last frame's drawing, relative to yours (a new seat: infinitely).
            double Moved(string id)
            {
                var side = PrevOf(id);
                var p = around[id];
                return side == null ? double.PositiveInfinity : Hypot(p.X - you.X - side.Value.Dx, p.Y - you.Y - side.Value.Dy, p.Z - you.Z - side.Value.Dz);
            }
            // A pair pushed apart last frame keeps its side (PushPair); a pair that was not, or that crossed while pushed, is
            // put back on its sides.
            for (var i = 0; i < order.Count; i++)
            {
                for (var k = i + 1; k < order.Count; k++)
                {
                    var was = PrevOf(PairKey(order[i].Id, order[k].Id));
                    var keep = was == null || !was.Value.HasPair || CrossedApart(order[i], order[k], was.Value.PairNx, was.Value.PairNy);
                    if (keep) KeepSide(order[i], order[k], drawn, was, Moved);
                }
            }
            var pushes = new Dictionary<string, (double Nx, double Ny)>();
            for (var pass = 0; ; pass++)
            {
                foreach (var seat in order) drawn[seat.Id] = OffYours(you, seat, drawn[seat.Id], around[seat.Id]);
                if (pass == PilePasses) break;
                var touched = false;
                for (var i = 0; i < order.Count; i++)
                {
                    for (var k = i + 1; k < order.Count; k++)
                    {
                        var was = PrevOf(PairKey(order[i].Id, order[k].Id));
                        var dt = was == null ? 0 : Math.Max(0, now - was.Value.At) / 1000;
                        touched = PushPair(order[i], order[k], drawn, pushes, was, dt) || touched;
                    }
                }
                if (!touched) break;
            }
            sides?.Clear();
            if (sides != null)
            {
                foreach (var seat in order)
                {
                    var p = drawn[seat.Id];
                    sides[seat.Id] = new GenexSeatSide
                    {
                        Dx = p.X - you.X, Dy = p.Y - you.Y, Dz = p.Z - you.Z, Held = !(p.X == seat.X && p.Y == seat.Y && p.Z == seat.Z),
                        Bx = seat.X - you.X, By = seat.Y - you.Y, At = now,
                    };
                }
                for (var i = 0; i < order.Count; i++)
                {
                    for (var k = i + 1; k < order.Count; k++)
                    {
                        var a = order[i];
                        var b = order[k];
                        var pa = drawn[a.Id];
                        var pb = drawn[b.Id];
                        var key = PairKey(a.Id, b.Id);
                        var pairSide = new GenexSeatSide { Dx = pb.X - pa.X, Dy = pb.Y - pa.Y, Dz = pb.Z - pa.Z, Held = false, Bx = b.X - a.X, By = b.Y - a.Y, At = now };
                        if (pushes.TryGetValue(key, out var side))
                        {
                            var push = NetPush(a, b, pa, pb, side.Nx, side.Ny);
                            if (push > 0)
                            {
                                pairSide.HasPair = true;
                                pairSide.PairNx = side.Nx;
                                pairSide.PairNy = side.Ny;
                                pairSide.PairPush = push;
                            }
                        }
                        sides[key] = pairSide;
                    }
                }
            }
            return drawn;
        }

        /// <summary>An angle difference in [-π, π).</summary>
        private static double TurnOf(double v) => v - TwoPi * Math.Floor((v + Math.PI) / TwoPi);

        /// <summary>JavaScript's Math.sign (NaN for NaN, a zero for a zero; Math.Sign throws on NaN).</summary>
        private static double SignOf(double v) => v > 0 ? 1 : v < 0 ? -1 : v;

        /// <summary>A length without overflow or underflow (as JavaScript's Math.hypot; NaN beside an infinity reads infinite).</summary>
        internal static double Hypot(double x, double y, double z)
        {
            var ax = Math.Abs(x);
            var ay = Math.Abs(y);
            var az = Math.Abs(z);
            if (double.IsInfinity(ax) || double.IsInfinity(ay) || double.IsInfinity(az)) return double.PositiveInfinity;
            var m = Math.Max(ax, Math.Max(ay, az));
            if (double.IsNaN(m) || double.IsNaN(ax) || double.IsNaN(ay) || double.IsNaN(az)) return double.NaN;
            if (m == 0) return 0;
            var u = ax / m;
            var v = ay / m;
            var w = az / m;
            return m * Math.Sqrt(u * u + v * v + w * w);
        }
    }

    /// <summary>
    /// A seat rule (§17.11 <i>Seat rules</i>): what the room module does to a seat's own entity at a tick it announced in
    /// advance (a kickoff that holds cars with <c>cap</c> 0 and sets <c>cap</c> 1 in its step of tick <c>go</c>), as a function
    /// of the entity's numeric fields (schema names: <c>x y z vx vy vz yaw</c> and whatever else the prediction mirrors or the
    /// seat's row carries, such as <c>cap</c>) and the tick that seat's input is applied on. It changes the fields in place,
    /// before that input's step. The client runs it on your own entity before each predicted input
    /// (<see cref="GenexAuthorityOptions.SeatRule"/>) and, in an <c>inputDecay</c> room, on each other seat's body before each
    /// of its steps (<see cref="GenexPredictorOptions.SeatRule"/>). It must be the module's very rule. A rule that throws throws
    /// out of the prediction step (as the TypeScript, which never catches a module's rule).
    /// </summary>
    public delegate void GenexSeatRule(Dictionary<string, double> seat, long tick);

    /// <summary>
    /// A seat rule that also hears the sequence of your input it runs before (§17.11 <i>Seat rules</i>; TypeScript
    /// <c>seatRule(seat, tick, seq)</c>): a rule keyed to one of your inputs finds an input fired at <c>s</c> applied on
    /// <c>tick − (seq − s)</c>. <paramref name="seq"/> is null on another seat's step (<see cref="GenexSeatRules.ForOthers"/>).
    /// </summary>
    public delegate void GenexSeatRuleSeq(Dictionary<string, double> seat, long tick, long? seq);

    /// <summary>§17.11 <i>Seat rules</i>: the tick a predicted input is applied on.</summary>
    public static class GenexSeatRules
    {
        /// <summary>The tick your input <paramref name="seq"/> is applied on, predicted from a state of tick
        /// <paramref name="stateTick"/> that consumed your inputs through <paramref name="ack"/>: a predicting room feeds one
        /// input a tick (§17.11 <i>Input pacing</i>). TypeScript <c>seatRuleTick</c>.</summary>
        public static long TickOf(long stateTick, long ack, long seq) => stateTick + (seq - ack);

        /// <summary>
        /// Runs <paramref name="rule"/> on a predicted own entity at <paramref name="tick"/>: it sees the mirrored
        /// <paramref name="fields"/> of <paramref name="body"/> by name (in <paramref name="scratch"/>, cleared first), and what
        /// it leaves in them is written back (a field it removed reads as missing: NaN, the step's fallback; a name the
        /// prediction does not mirror is dropped). True, with the value, when it changed <c>cap</c> (<c>!==</c>: a NaN cap is
        /// always a change). A rule that throws throws to the caller, <paramref name="body"/> unchanged.
        /// </summary>
        internal static bool ApplyTo(GenexSeatRule rule, Dictionary<string, double> scratch, GenexPredictedBody body, string[] fields, long tick, out double cap) =>
            ApplyTo(null, rule, 0, scratch, body, fields, tick, out cap);

        /// <summary><see cref="ApplyTo(GenexSeatRule, Dictionary{string, double}, GenexPredictedBody, string[], long, out double)"/> with a
        /// rule that hears your input's sequence <paramref name="seq"/>.</summary>
        internal static bool ApplyTo(GenexSeatRuleSeq rule, long seq, Dictionary<string, double> scratch, GenexPredictedBody body, string[] fields, long tick, out double cap) =>
            ApplyTo(rule, null, seq, scratch, body, fields, tick, out cap);

        /// <summary>The seat rule other seats' steps run (no sequence): <paramref name="withSeq"/> called with none, else
        /// <paramref name="plain"/>.</summary>
        public static GenexSeatRule ForOthers(GenexSeatRuleSeq withSeq, GenexSeatRule plain) =>
            withSeq == null ? plain : (seat, tick) => withSeq(seat, tick, null);

        private static bool ApplyTo(GenexSeatRuleSeq withSeq, GenexSeatRule plain, long seq, Dictionary<string, double> scratch, GenexPredictedBody body, string[] fields, long tick, out double cap)
        {
            cap = body.Cap;
            scratch.Clear();
            foreach (var f in fields) scratch[f] = Field(body, f);
            if (withSeq != null) withSeq(scratch, tick, seq);
            else plain(scratch, tick);
            var capSet = false;
            foreach (var f in fields)
            {
                var v = scratch.TryGetValue(f, out var got) ? got : double.NaN;
                if (f == "cap")
                {
                    capSet = !(v == body.Cap);
                    cap = v;
                }
                SetField(body, f, v);
            }
            return capSet;
        }

        /// <summary>A predicted body's field by schema name (NaN for a name it has not).</summary>
        internal static double Field(GenexPredictedBody b, string field)
        {
            switch (field)
            {
                case "x": return b.X;
                case "y": return b.Y;
                case "z": return b.Z;
                case "vx": return b.VX;
                case "vy": return b.VY;
                case "vz": return b.VZ;
                case "yaw": return b.Yaw;
                case "pitch": return b.Pitch;
                case "duck": return b.Duck;
                case "mstate": return b.Mstate;
                case "cap": return b.Cap;
                case "spin": return b.Spin;
                case "fuel": return b.Fuel;
                default: return double.NaN;
            }
        }

        private static void SetField(GenexPredictedBody b, string field, double v)
        {
            switch (field)
            {
                case "x": b.X = v; break;
                case "y": b.Y = v; break;
                case "z": b.Z = v; break;
                case "vx": b.VX = v; break;
                case "vy": b.VY = v; break;
                case "vz": b.VZ = v; break;
                case "yaw": b.Yaw = v; break;
                case "pitch": b.Pitch = v; break;
                case "duck": b.Duck = v; break;
                case "mstate": b.Mstate = v; break;
                case "cap": b.Cap = v; break;
                case "spin": b.Spin = v; break;
                case "fuel": b.Fuel = v; break;
            }
        }
    }
}
