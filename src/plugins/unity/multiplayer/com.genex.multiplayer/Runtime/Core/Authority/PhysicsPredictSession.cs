// The session's half of physics prediction (PROTOCOL.md §17.11), a port of
// packages/multiplayer/src/authority/physics-predict-session.ts: it turns the room state into the predictor's keyframes,
// loads the core only once a predicting room sends keyframes (self-test first), keeps the ring of your predicted positions
// by input sequence, and answers which bodies the predictor draws. GenexAuthoritySession owns one; PhysicsPredict.cs does
// the physics. Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using Genex.Multiplayer.Authority.Wire;

namespace Genex.Multiplayer.Authority
{
    /// <summary>What <see cref="GenexAuthoritySession.PhysicsPrediction"/> reports.</summary>
    public sealed class GenexPhysicsPredictionStatus
    {
        /// <summary>A <see cref="GenexPredictStatus"/>: on, off, loading, unavailable, mismatch, self_test, diverged or cpu.</summary>
        public string Status { get; internal set; } = GenexPredictStatus.Off;
        /// <summary>Keyframes adopted by skip-on-match and by replay.</summary>
        public int Matched { get; internal set; }
        public int Replayed { get; internal set; }
        /// <summary>The slowest replay, ms.</summary>
        public double PeakResimMs { get; internal set; }
        /// <summary>How many times the replay budget turned prediction off (<c>cpu</c>), and on again (§17.11 *Budgets*).</summary>
        public int Fallbacks { get; internal set; }
        public int Recoveries { get; internal set; }
        /// <summary>Why the core is unavailable, when it is ("" otherwise).</summary>
        public string Detail { get; internal set; } = "";

        internal GenexPhysicsPredictionStatus Copy() => (GenexPhysicsPredictionStatus)MemberwiseClone();
    }

    /// <summary>Your own entity after one input: position (room units) and velocity (room units per second).</summary>
    internal sealed class GenexOwnState
    {
        public readonly double[] P, V;

        public GenexOwnState(double x, double y, double z, double vx, double vy, double vz)
        {
            P = new[] { x, y, z };
            V = new[] { vx, vy, vz };
        }

        public GenexOwnState(double[] p, double[] v)
        {
            P = p;
            V = v;
        }
    }

    internal sealed class GenexPhysicsPredictSession
    {
        /// <summary>Your predicted positions kept, by input sequence (the latest this many).</summary>
        private const int OwnKept = 256;

        internal readonly GenexPhysicsPredictionStatus Status = new GenexPhysicsPredictionStatus();
        private readonly Func<IGenexPhysicsCore> loadCore;
        private readonly Func<AuthorityRoomState> state;
        private readonly Func<GenexFirstpersonWorld> staticWorld;
        private readonly Func<double> tickHz;
        private readonly Func<long> sent, acked;
        private readonly Func<string> ownId;
        private readonly double budgetMs;
        private readonly Func<GenexRemoteStep> remoteStep;
        private readonly Func<IList<KeyValuePair<long, GenexOwnState>>> ownPath;
        private readonly GenexPredictBodyRule bodyRule;
        private readonly GenexSeatRule seatRule;
        private readonly GenexPredictKinematicRule kinematicRule;
        private readonly Func<string, long, GenexRuleSeat?> seatPose;
        private readonly Func<long, double[]> poseOf, velocityOf;
        /// <summary>Whether entity <c>id</c>'s motion in the state is the keyframe's (null: always). On the fast channel
        /// (§17.12) motion comes by snapshot and the entity list by WebSocket, so an entity can be listed while the newest
        /// snapshot no longer carries its record (it left your view and the removal is on its way) or does not carry it yet
        /// (it came back by WebSocket first): its motion is then another keyframe's, and its body is out of view.</summary>
        private readonly Func<string, bool> motionKnown;
        private GenexPhysicsPredictor predictor;
        private bool loaded;
        private double lastKeyframe;
        private long stepped;
        /// <summary>The newest keyframe held for the next frame, with what it is adopted with, or null.</summary>
        private PendingKeyframe pending;
        /// <summary>Adoption time since the last frame began, ms.</summary>
        private double spentMs;
        /// <summary>Adoption time between two frames past which a keyframe waits for the next frame, the newest of the rest
        /// adopted then (§17.11 *A burst of keyframes*): one 60 Hz frame, ms (TypeScript ADOPT_FRAME_BUDGET_MS).</summary>
        internal const double AdoptFrameBudgetMs = 1000.0 / 60;

        /// <summary>A keyframe held from its arrival to the next frame: the state, your inputs sent then and the instant.</summary>
        private sealed class PendingKeyframe
        {
            public GenexPredictKeyframe Keyframe;
            public long Sent;
            public double Now;
        }
        /// <summary>Your predicted position and velocity after each input, by sequence (the input-sequence ring).</summary>
        private readonly Dictionary<long, GenexOwnState> own = new Dictionary<long, GenexOwnState>();
        private GenexOwnState lastOwn;
        private readonly List<long> oldOwn = new List<long>();
        /// <summary>Each body's descriptor as last parsed, with the text and the shapes it was parsed from: a keyframe whose text
        /// and shapes are the same hands the predictor the same object (parsed once, its identity text written once).</summary>
        private readonly Dictionary<string, ParsedDesc> descs = new Dictionary<string, ParsedDesc>();

        private sealed class ParsedDesc
        {
            public string Text;
            public Dictionary<string, object> Desc;
            public readonly List<KeyValuePair<string, string>> Shapes = new List<KeyValuePair<string, string>>();
        }

        /// <summary>Where each body was when this client last had it in view (islands of bodies out of view).</summary>
        private readonly Dictionary<string, double[]> lastSeen = new Dictionary<string, double[]>();

        /// <summary>§17.11 *Contact policy*: the room's declared pass, run in the replay on ticks no seat prediction posed.</summary>
        private readonly GenexSeatPass contactPass;

        internal GenexPhysicsPredictSession(bool enabled, Func<IGenexPhysicsCore> loadCore, Func<AuthorityRoomState> state, Func<GenexFirstpersonWorld> staticWorld,
            Func<double> tickHz, Func<long> sent, Func<long> acked, Func<string> ownId, double budgetMs, Func<GenexRemoteStep> remoteStep,
            Func<IList<KeyValuePair<long, GenexOwnState>>> ownPath = null, GenexPredictBodyRule bodyRule = null, GenexSeatRule seatRule = null,
            Func<string, long, GenexRuleSeat?> seatPose = null, GenexPredictKinematicRule kinematicRule = null, GenexSeatPass contactPass = null,
            Func<string, bool> motionKnown = null)
        {
            this.seatPose = seatPose;
            this.motionKnown = motionKnown;
            this.contactPass = contactPass;
            this.kinematicRule = kinematicRule;
            Status.Status = enabled ? GenexPredictStatus.Loading : GenexPredictStatus.Off;
            this.loadCore = loadCore;
            this.state = state;
            this.staticWorld = staticWorld;
            this.tickHz = tickHz;
            this.sent = sent;
            this.acked = acked;
            this.ownId = ownId;
            this.budgetMs = budgetMs;
            this.remoteStep = remoteStep;
            this.ownPath = ownPath;
            this.bodyRule = bodyRule;
            this.seatRule = seatRule;
            poseOf = seq => own.TryGetValue(seq, out var o) ? o.P : null;
            velocityOf = seq => own.TryGetValue(seq, out var o) ? o.V : null;
        }

        private void Fail(string why, string detail = "")
        {
            Status.Status = why;
            Status.Detail = detail;
            predictor?.Stop(why);
            predictor = null;
        }

        /// <summary>The core, self-tested, then the predictor on the room's physDesc and static world (once).</summary>
        private void Load(AuthorityRoomState s)
        {
            if (loaded) return;
            loaded = true;
            IGenexPhysicsCore core;
            try { core = loadCore?.Invoke(); }
            catch (Exception e)
            {
                Fail(GenexPredictStatus.Unavailable, e.GetType().Name + ": " + e.Message);
                return;
            }
            if (core == null)
            {
                Fail(GenexPredictStatus.Unavailable, "no physics core");
                return;
            }
            if (!GenexPhysicsPredictor.SelfTest(core))
            {
                Fail(GenexPredictStatus.SelfTest);
                return;
            }
            var desc = GenexPhysDesc.Parse(s.physDesc);
            if (desc == null)
            {
                Fail(GenexPredictStatus.Mismatch, "physDesc");
                return;
            }
            var world = staticWorld() ?? GenexFirstpersonWorld.Empty;
            var boxes = new List<double[]>();
            var ramps = new List<double[]>();
            for (var i = 0; i < world.BoxCount; i++) boxes.Add(world.Box(i));
            for (var i = 0; i < world.RampCount; i++) ramps.Add(world.Ramp(i));
            predictor = new GenexPhysicsPredictor(core, new GenexPredictorOptions
            {
                Desc = desc, StaticBoxes = boxes, StaticRamps = ramps, PhysicsHash = s.physics ?? "", TickHz = tickHz(), BudgetMs = budgetMs,
                RemoteStep = remoteStep?.Invoke(), BodyRule = bodyRule, SeatRule = seatRule, SeatPose = seatPose,
                KinematicRule = kinematicRule, ContactPass = contactPass,
            });
            if (!predictor.Predicting) Fail(predictor.Status);
        }

        private static double Num(double v) => double.IsNaN(v) || double.IsInfinity(v) ? 0 : v;

        /// <summary>A body's descriptor with its shapes inlined: the one parsed last time when its text and every shape it named
        /// are the same, else parsed again (GenexPhysicsKeyframe.InlineShapes).</summary>
        private Dictionary<string, object> DescOf(string key, string text, Func<string, string> shape)
        {
            if (descs.TryGetValue(key, out var known) && string.Equals(known.Text, text, StringComparison.Ordinal))
            {
                var same = true;
                foreach (var kv in known.Shapes)
                {
                    if (string.Equals(shape(kv.Key), kv.Value, StringComparison.Ordinal)) continue;
                    same = false;
                    break;
                }
                if (same) return known.Desc;
            }
            var parsed = new ParsedDesc { Text = text };
            parsed.Desc = GenexPhysicsKeyframe.InlineShapes(text, reference =>
            {
                var data = shape(reference);
                parsed.Shapes.Add(new KeyValuePair<string, string>(reference, data));
                return data;
            });
            descs[key] = parsed;
            return parsed.Desc;
        }

        /// <summary>The keyframe the state holds now (bodies in view, out of view, joints, seats).</summary>
        private GenexPredictKeyframe KeyframeOf(AuthorityRoomState s)
        {
            var kf = new GenexPredictKeyframe { Tick = (long)s.keyframe, Ack = acked() };
            var entities = s.entities;
            var shapes = s.shapes;
            string Shape(string reference) => shapes != null && shapes.TryGetValue(reference, out var shape) && shape != null ? shape.data : null;
            if (s.bodies != null)
            {
                foreach (var kv in s.bodies)
                {
                    var descriptor = kv.Value;
                    var desc = descriptor == null || string.IsNullOrEmpty(descriptor.desc) ? null : DescOf(kv.Key, descriptor.desc, Shape);
                    AuthorityEntity e = null;
                    var listed = entities != null && entities.TryGetValue(kv.Key, out e) && e != null;
                    if (!listed || motionKnown?.Invoke(kv.Key) == false)
                    {
                        var seen = lastSeen.TryGetValue(kv.Key, out var at) ? at : listed ? new[] { e.x, e.y, e.z } : new double[3];
                        kf.Outside.Add(new GenexKeyframeOutside { Key = kv.Key, X = seen[0], Y = seen[1], Z = seen[2], Radius = desc == null ? 0 : GenexPhysicsKeyframe.BodyRadiusOf(desc) });
                        continue;
                    }
                    lastSeen[kv.Key] = new[] { e.x, e.y, e.z };
                    var row = new double[GenexPhysicsKeyframe.WireRowStride];
                    GenexPhysicsKeyframe.WriteWireRow(new GenexWireFields
                    {
                        X = e.x, Y = e.y, Z = e.z,
                        Qx = Num(e.qx), Qy = Num(e.qy), Qz = Num(e.qz), Qw = Num(e.qw),
                        Lvx = Num(e.lvx), Lvy = Num(e.lvy), Lvz = Num(e.lvz),
                        Avx = Num(e.avx), Avy = Num(e.avy), Avz = Num(e.avz),
                        Sleep = e.sleep, Rest = Num(e.rest),
                    }, row, 0);
                    kf.Bodies.Add(new GenexKeyframeBody { Key = kv.Key, Desc = desc, Row = row, Epoch = e.epoch });
                }
            }
            var goneSeen = new List<string>();
            foreach (var key in lastSeen.Keys) if (s.bodies == null || !s.bodies.ContainsKey(key)) goneSeen.Add(key);
            foreach (var key in goneSeen) lastSeen.Remove(key);
            goneSeen.Clear();
            foreach (var key in descs.Keys) if (s.bodies == null || !s.bodies.ContainsKey(key)) goneSeen.Add(key);
            foreach (var key in goneSeen) descs.Remove(key);
            if (s.joints != null)
            {
                foreach (var kv in s.joints)
                {
                    if (kv.Value == null) continue;
                    // A joint whose text does not parse is left out: its island is then incomplete for no one.
                    if (!(GenexJson.TryParse(kv.Value.desc, out var d) && d is Dictionary<string, object> desc)) continue;
                    Dictionary<string, object> motor = null;
                    if (!string.IsNullOrEmpty(kv.Value.motor))
                    {
                        if (!(GenexJson.TryParse(kv.Value.motor, out var m) && m is Dictionary<string, object> parsed)) continue;
                        motor = parsed;
                    }
                    kf.Joints.Add(new GenexKeyframeJoint { Key = kv.Key, Desc = desc, Motor = motor });
                }
            }
            var taken = new HashSet<string>();
            var me = ownId();
            if (entities != null)
            {
                foreach (var kv in entities)
                {
                    var e = kv.Value;
                    if (e == null || string.IsNullOrEmpty(e.owner) || taken.Contains(e.owner) || e.t0 > 0) continue;
                    if (s.bodies != null && s.bodies.ContainsKey(kv.Key)) continue;
                    if (s.players == null || !s.players.TryGetValue(e.owner, out var player) || player == null) continue;
                    taken.Add(e.owner);
                    kf.Seats.Add(new GenexKeyframeSeat
                    {
                        Key = kv.Key, X = e.x, Y = e.y, Z = e.z, Vx = e.vx, Vy = e.vy, Vz = e.vz, Epoch = e.epoch, Own = kv.Key == me,
                        Input = new GenexRemoteInput
                        {
                            MoveX = Num(player.inMoveX), MoveY = Num(player.inMoveY), MoveZ = Num(player.inMoveZ),
                            Yaw = Num(player.inYaw), Pitch = Num(player.inPitch), Buttons = Num(player.inButtons),
                        },
                        Body = new Dictionary<string, double>
                        {
                            ["x"] = e.x, ["y"] = e.y, ["z"] = e.z, ["vx"] = e.vx, ["vy"] = e.vy, ["vz"] = e.vz, ["yaw"] = e.yaw, ["pitch"] = e.pitch,
                            ["duck"] = e.duck, ["mstate"] = e.mstate, ["cap"] = e.cap, ["spin"] = e.spin, ["fuel"] = e.fuel,
                        },
                    });
                }
            }
            return kf;
        }

        /// <summary>The room state changed: load the core in a predicting room, adopt a new keyframe (or hold it for the frame).</summary>
        internal void OnState(double now)
        {
            if (Status.Status == GenexPredictStatus.Off) return;
            var s = state();
            if (s == null) return;
            var keyframe = s.keyframe;
            if (keyframe == 0 || string.IsNullOrEmpty(s.physDesc)) return;
            if (predictor == null)
            {
                if (loaded) return;
                Load(s);
                if (predictor == null) return;
            }
            // Only a tick-aligned patch holds a keyframe whole (§17.11 *Keyframes*).
            if (keyframe == lastKeyframe || s.tick != keyframe) return;
            lastKeyframe = keyframe;
            // §17.11 *A burst of keyframes*: adopted as it arrives until the adoptions since the last frame have taken a
            // frame's time; past it held for the next frame, the newest of the rest replacing the older (after a stall the
            // socket hands over a second of states at once: one adoption each, your path stepped again for each, was one
            // frame of 377-467 ms on the 250 ms seam). What it is adopted with is taken now.
            var held = new PendingKeyframe { Keyframe = KeyframeOf(s), Sent = sent(), Now = now };
            if (spentMs >= AdoptFrameBudgetMs)
            {
                pending = held;
                return;
            }
            var started = Stopwatch.GetTimestamp();
            Adopt(held);
            spentMs += (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency;
        }

        /// <summary>A frame begins: adopt the keyframe held for it, if any, and open the next frame's budget (AfterSend and
        /// Draw settle too).</summary>
        internal void Settle()
        {
            var held = pending;
            pending = null;
            spentMs = 0;
            if (held != null) Adopt(held);
        }

        /// <summary>Adopts <paramref name="held"/>: your path stepped again from its state, then the predictor's adoption.</summary>
        private void Adopt(PendingKeyframe held)
        {
            if (predictor == null) return;
            // The ring held your positions as predicted when each input left; a correction since then moved them: the
            // replay poses your preset body from your inputs stepped again from this state (§17.11 *The client world*).
            var path = ownPath?.Invoke();
            if (path != null) foreach (var kv in path) own[kv.Key] = kv.Value;
            var report = predictor.Adopt(held.Keyframe, held.Sent, poseOf, held.Now, velocityOf);
            if (report.Kind == GenexAdoptReport.Match) Status.Matched++;
            if (report.Kind == GenexAdoptReport.Replay) Status.Replayed++;
            Status.PeakResimMs = Math.Max(Status.PeakResimMs, report.Ms);
            Status.Fallbacks = predictor.Fallbacks;
            Status.Recoveries = predictor.Recoveries;
            // `cpu` is not the end: the predictor probes its way back (§17.11 *Budgets*).
            if (predictor.Stopped) Fail(predictor.Status);
            else Status.Status = predictor.Status;
            stepped = held.Sent;
        }

        /// <summary>You sent inputs up to <c>sent()</c>, your entity now predicted at <paramref name="pose"/> (null: unknown): the world steps them.</summary>
        internal void AfterSend(GenexOwnState pose, double now)
        {
            Settle();
            var total = sent();
            // Positions of the inputs sent this frame: eased from the last one to `pose` (one frame may send several; your
            // prediction only shows where the last left you).
            var from = lastOwn ?? pose;
            var count = total - stepped;
            for (long i = 1; i <= count; i++)
            {
                var k = (double)i / count;
                if (pose != null && from != null)
                {
                    var p = new[] { from.P[0] + (pose.P[0] - from.P[0]) * k, from.P[1] + (pose.P[1] - from.P[1]) * k, from.P[2] + (pose.P[2] - from.P[2]) * k };
                    own[stepped + i] = new GenexOwnState(p, pose.V);
                }
                predictor?.Advance(stepped + i, now);
            }
            stepped = total;
            lastOwn = pose;
            if (own.Count > OwnKept)
            {
                oldOwn.Clear();
                foreach (var seq in own.Keys) if (seq < total - OwnKept) oldOwn.Add(seq);
                foreach (var seq in oldOwn) own.Remove(seq);
            }
        }

        /// <summary>Whether the predictor draws <paramref name="id"/> now, and where.</summary>
        internal bool Draw(string id, double now, out GenexBodyPose pose)
        {
            pose = default;
            Settle();
            return predictor != null && predictor.Draws(id) && predictor.Draw(id, now, out pose);
        }

        /// <summary>The client world's stateHash ("" without one): diagnostics.</summary>
        internal string StateHash() => predictor?.StateHash() ?? "";

        internal void Dispose()
        {
            predictor?.Stop(GenexPredictStatus.Off);
            predictor = null;
        }
    }
}
