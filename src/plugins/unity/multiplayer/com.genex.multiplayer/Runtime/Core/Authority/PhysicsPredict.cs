// Predicting a physics room's bodies (PROTOCOL.md §17.11): the client world, keyframe adoption, replay, and the drawing of
// predicted bodies. A port of packages/multiplayer/src/authority/physics-predict.ts (PhysicsPredictor, the reference
// implementation) that behaves identically: the same bodies chosen (whole proximity islands of bodies in view with a
// descriptor, nearest your own entity first, up to the adaptive set 128 → 64 → 32), the same skip-on-match (bodies,
// descriptors, joints, seats, every compared wire row bit-equal, the ack where the prediction put it; module kinematic
// bodies never compared), the same rebuild and replay (at most ceil(leadMs · tickHz / 1000) + K − 1 inputs), the server's
// own tick order (preset and kinematic poses, step, the speed clamp, canonicalize({ quantize }) on t ≡ 0 mod K), and the
// same drawing (present state moved on by its velocities for at most one tick, a replay's correction decaying with τ by
// its size, 300 ms up to 0.25 m to 100 ms from 1 m, snapped over 2 m for a player or vehicle body and 6 m for any other; eased critically damped, keeping the last correction's rate).
// Fallbacks: mismatch (physicsHash or a refused rebuild), self_test, diverged (the canary: over 2% of pure bodies
// mismatched over the last 500 compared, judged from 200), cpu (over budget at the smallest set), and off.
//
// The core is IGenexPhysicsCore: the native library over its C ABI (PhysicsNative.cs) in a player or the editor, the
// same core the TypeScript SDK runs as WebAssembly, so every port running the same steps gets the same stateHash after
// every tick. Held to packages/netcode-bench/conformance/authority/physics-predict.json by GenexSmoke `physics-predict`
// (Tests~/GenexSmoke/PhysicsPredictCheck.cs). Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A module body in the client's view at the keyframe.</summary>
    public sealed class GenexKeyframeBody
    {
        public string Key;
        /// <summary>The canonical descriptor with its shapes inlined (C§20.5), or null: drawn, never predicted.</summary>
        public Dictionary<string, object> Desc;
        /// <summary>The wire row (15 numbers, importWire's form).</summary>
        public double[] Row;
        /// <summary>Its entity's epoch, when known (a body the module respawned is never a sample of the canary).</summary>
        public double? Epoch;
    }

    /// <summary>A body the client knows but that is out of its view: where it last was (for islands only).</summary>
    public struct GenexKeyframeOutside
    {
        public string Key;
        public double X, Y, Z, Radius;
    }

    /// <summary>A seat's own entity (its preset body's pose, §17.10 *Preset bodies*).</summary>
    public sealed class GenexKeyframeSeat
    {
        /// <summary>The entity id: the preset body's key.</summary>
        public string Key;
        /// <summary>The entity's float32 position, and velocity in room units per second.</summary>
        public double X, Y, Z, Vx, Vy, Vz;
        public double Epoch;
        /// <summary>This client's own entity.</summary>
        public bool Own;
        /// <summary>The seat's last applied input (inputDecay rooms; null: extrapolated).</summary>
        public GenexRemoteInput? Input;
        /// <summary>The entity's fields a remote step reads (its x, y, z at least); null: x, y, z.</summary>
        public Dictionary<string, double> Body;
    }

    /// <summary>A joint (§17.11 *State*): its descriptor and the motor last set, parsed.</summary>
    public sealed class GenexKeyframeJoint
    {
        public string Key;
        public Dictionary<string, object> Desc;
        public Dictionary<string, object> Motor;
    }

    /// <summary>One keyframe: the room state after tick <c>Tick</c>, and how many of this client's inputs the server had consumed by then.</summary>
    public sealed class GenexPredictKeyframe
    {
        public long Tick;
        public long Ack;
        public List<GenexKeyframeBody> Bodies = new List<GenexKeyframeBody>();
        public List<GenexKeyframeOutside> Outside = new List<GenexKeyframeOutside>();
        public List<GenexKeyframeJoint> Joints = new List<GenexKeyframeJoint>();
        public List<GenexKeyframeSeat> Seats = new List<GenexKeyframeSeat>();
    }

    /// <summary>inputDecay: one fixed step of a remote seat's entity under <paramref name="input"/>, mutating <paramref name="body"/> (its x, y, z read after).</summary>
    public delegate void GenexRemoteStep(Dictionary<string, double> body, GenexRemoteInput input, double dt);

    /// <summary>A seat's entity at one predicted tick, as a body rule reads it: position (room units) and velocity (room units per second).</summary>
    public struct GenexRuleSeat
    {
        public string Key;
        public double X, Y, Z, Vx, Vy, Vz;
        /// <summary>The heading, radians, where the seat's body carries one (the contact pass reads it); 0 otherwise.</summary>
        public double Yaw;
    }

    /// <summary>A simulated dynamic body as the last step left it, as a body rule reads it (room units, per second).</summary>
    public struct GenexRuleBody
    {
        public double Px, Py, Pz, Vx, Vy, Vz;
    }

    /// <summary>A velocity a body rule sets (room units per second), as the module's <c>setVelocity</c> would.</summary>
    public struct GenexRuleVelocity
    {
        public string Key;
        public double Vx, Vy, Vz;
    }

    /// <summary>
    /// What a body rule reads at a predicted tick: every seat's entity at that tick (key order) and a simulated dynamic body's
    /// state after the previous tick's step. Valid only during the rule's call (the predictor reuses it).
    /// </summary>
    public sealed class GenexRuleTick
    {
        /// <summary>The room tick being stepped.</summary>
        public long Tick { get; internal set; }
        /// <summary>Every seat's entity at this tick, in key order.</summary>
        public IReadOnlyList<GenexRuleSeat> Seats => SeatList;
        internal readonly List<GenexRuleSeat> SeatList = new List<GenexRuleSeat>();
        internal Func<string, GenexRuleBody?> BodyOf;

        /// <summary>A simulated dynamic body's state as the last step left it; false for any other key.</summary>
        public bool Body(string key, out GenexRuleBody body)
        {
            var got = key == null ? null : BodyOf?.Invoke(key);
            body = got ?? default;
            return got.HasValue;
        }
    }

    /// <summary>
    /// A body rule (§17.11 *Body rules*): what the room module does each tick to its dynamic bodies' velocities from the seats'
    /// entities and the bodies' states (a scripted hit on a ball), as a pure function. The module runs this very function
    /// in its <c>step</c> and sends what it returns as <c>setVelocity</c> commands; the client world runs it before every
    /// predicted step. It adds the velocities to set to <paramref name="velocities"/>, in order.
    /// </summary>
    public delegate void GenexPredictBodyRule(GenexRuleTick tick, List<GenexRuleVelocity> velocities);

    /// <summary>
    /// A kinematic rule (§17.11 *Kinematic rules*, TypeScript <c>PredictKinematicRule</c>): where the room module poses one of its
    /// kinematic bodies (a door, a platform, a moving floor) at tick <paramref name="tick"/>, as a pure function of the body's key
    /// and the tick (its keyframed schedule), or null for a body it does not pose. The module issues
    /// <c>setNextKinematicPose(key, rule(key, t + 1))</c> in its step of tick t; the client world does the same before every
    /// predicted step and draws the body as a predicted one, also outside the simulated set. Position in the physics world's
    /// units, as a keyframe row's.
    /// </summary>
    public delegate GenexBodyPose? GenexPredictKinematicRule(string key, long tick);

    /// <summary>Why bodies are (not) predicted (§17.11 *Fallback levels*).</summary>
    public static class GenexPredictStatus
    {
        public const string On = "on";
        public const string Off = "off";
        public const string Loading = "loading";
        public const string Unavailable = "unavailable";
        public const string Mismatch = "mismatch";
        public const string SelfTest = "self_test";
        public const string Diverged = "diverged";
        public const string Cpu = "cpu";
    }

    /// <summary>What one keyframe's adoption did.</summary>
    public struct GenexAdoptReport
    {
        public const string Match = "match", Replay = "replay", None = "none";
        public string Kind;
        public int Replayed;
        public double Ms;
        public int Pure, Mismatched;
    }

    public sealed class GenexPredictorOptions
    {
        public GenexPhysDesc Desc;
        /// <summary>The static world's boxes and ramps (§17.7); none is the empty world.</summary>
        public IList<double[]> StaticBoxes, StaticRamps;
        public string PhysicsHash;
        public double TickHz;
        /// <summary>A replay's budget, ms (default the desktop one).</summary>
        public double BudgetMs = GenexPhysicsPredictor.ResimBudgetDesktopMs;
        /// <summary>The clock replays are timed on, ms (default a stopwatch).</summary>
        public Func<double> Clock;
        /// <summary>How a remote seat steps under its decayed input (physDesc.remotePredict inputDecay).</summary>
        public GenexRemoteStep RemoteStep;
        /// <summary>The lead cap, ms (default physDesc.leadMs).</summary>
        public double? LeadMs;
        /// <summary>The room module's body rule (§17.11 *Body rules*); null: module commands arrive as corrections.</summary>
        public GenexPredictBodyRule BodyRule;
        /// <summary>The room module's seat rule (§17.11 *Seat rules*), run on each other seat's body before each of its
        /// <c>inputDecay</c> steps (the j-th at the keyframe's tick plus j); null: a release arrives as a correction.</summary>
        public GenexSeatRule SeatRule;
        /// <summary>The room module's kinematic rule (§17.11 *Kinematic rules*); null: every module kinematic body holds the
        /// keyframe's pose and is drawn from the server's states.</summary>
        public GenexPredictKinematicRule KinematicRule;
        /// <summary>Another seat's entity after the tick of your input <c>seq</c>, as the session's seat prediction has it
        /// (§17.11 <i>Drawing other seats</i> <c>predicted</c>: stepped under its held input with the room's contact pass); when
        /// it answers, it poses that seat's preset body, else the seat is moved as <c>remotePredict</c> says.</summary>
        public Func<string, long, GenexRuleSeat?> SeatPose;
        /// <summary>The room's seat contact pass (§17.11 <i>Contact policy</i>, the declared one or the module's), run on each predicted
        /// tick's seats in id order before they pose their preset bodies, on ticks where the session's seat prediction
        /// (<see cref="SeatPose"/>) posed none of them (that prediction runs the pass itself); null: none.</summary>
        public GenexSeatPass ContactPass;
        /// <summary>The room's declared lifts (§17.11 <i>Lifts</i> step 9), else null: each a kinematic body <c>lift.&lt;id&gt;</c> of the
        /// client world posed at P(t + 1) in each predicted tick t, and the built-in conveyor rule after the module's body rule.</summary>
        public GenexLiftsPolicy Lifts;
        /// <summary>The called lifts' starts as the latest state has them.</summary>
        public IDictionary<string, double> LiftStarts;
        /// <summary>The room's declared <c>propSlide</c> under <c>headFriction: slide</c> (§17.11 <i>Contact policy</i>), else null: the
        /// built-in prop rule after the conveyor rule.</summary>
        public GenexPropSlide HeadSlide;
        /// <summary>How many of the latest per-tick stateHashes are kept (a conformance run keeps all).</summary>
        public int HashesKept = GenexPhysicsPredictor.HashesKeptDefault;
    }

    /// <summary>
    /// One room's predictor. <see cref="Adopt"/> each keyframe, <see cref="Advance"/> once per input you send (with your
    /// predicted pose after it), and <see cref="Draw"/> a body at render time; <see cref="StateHash"/> reads the client world.
    /// </summary>
    public sealed class GenexPhysicsPredictor
    {
        public const double ResimBudgetDesktopMs = 4, ResimBudgetMobileMs = 5;
        /// <summary>A ruled body outside the simulated set follows the world's timeline at a rate within this share of the room
        /// clock's (§17.11 *Kinematic rules*): a 3-tick shift is absorbed in 30 ticks.</summary>
        public const double RuledSlew = 0.1;
        /// <summary>Past this many ticks off the world's timeline the ruled clock snaps to it.</summary>
        public const double RuledSnapTicks = 30;
        public static readonly int[] SetSizes = { 128, 64, 32 };
        public const int CanaryWindow = 500;
        public const double CanaryMaxMismatch = 0.02;
        public const int CanaryMinSamples = 200;
        public const int HashesKeptDefault = 600;
        /// <summary>The rolling window of replay costs (wall clock around the rebuild and replay only): the latest this many,
        /// judged once it holds <see cref="BudgetMinSamples"/>.</summary>
        public const int BudgetWindow = 60, BudgetMinSamples = 20;
        /// <summary>Over budget: the window's median over the budget, or its p90 over this many budgets.</summary>
        public const double BudgetP90Factor = 2;
        /// <summary>Calm: the window's p90 (or a probe) at or under this share of the budget.</summary>
        public const double BudgetCalmShare = 0.5;
        /// <summary>In <c>cpu</c>, one keyframe in this many ms is adopted by a full replay (a probe, never drawn).</summary>
        public const double CpuProbeMs = 500;
        /// <summary>Calm probes in a row that turn prediction on again.</summary>
        public const int CpuCalmProbes = 4;

        /// <summary>The set size to shrink to from <paramref name="current"/> when the last choice took <paramref name="chosen"/>
        /// bodies: the next size under <paramref name="chosen"/>, or null when none is left.</summary>
        public static int? NextPredictSetSize(int current, int chosen)
        {
            for (var i = current + 1; i < SetSizes.Length; i++) if (SetSizes[i] < chosen) return i;
            return null;
        }

        /// <summary>How many times the replay budget turned prediction off (<c>cpu</c>), and on again.</summary>
        public int Fallbacks { get; private set; }
        public int Recoveries { get; private set; }

        private static readonly double[] IdentityQ = { 0, 0, 0, 1 };
        private static readonly double[] PresetRowTail = { 32767, 32767, 32767, 65534, 32767, 32767, 32767, 32767, 32767, 32767, 0, 0 };

        public string Status = GenexPredictStatus.Loading;
        private readonly GenexPhysDesc desc;
        private readonly double tickHz, innerDt, lengthUnit;
        private readonly long leadMax;
        private readonly double budgetMs;
        private readonly Func<double> clock;
        private readonly GenexRemoteStep remoteStep;
        private readonly Func<string, long, GenexRuleSeat?> seatPose;
        private readonly GenexSeatPass contactPass;
        /// <summary>Whether the seat <see cref="SeatAt"/> last gave came from the session's seat prediction.</summary>
        private bool posedBySeats;
        private readonly int hashesKept;
        private IGenexPhysicsWorld world;
        private bool hasBase;
        private long baseTick, baseAck;
        private long seq;
        private readonly OrderedMap<string, Simulated> simulated = new OrderedMap<string, Simulated>();
        private readonly OrderedMap<string, GenexKeyframeSeat> seats = new OrderedMap<string, GenexKeyframeSeat>();
        private readonly OrderedMap<string, double[]> kinematic = new OrderedMap<string, double[]>();
        private readonly OrderedMap<string, JointText> joints = new OrderedMap<string, JointText>();
        private readonly OrderedMap<long, Dictionary<string, double[]>> ring = new OrderedMap<long, Dictionary<string, double[]>>();
        private readonly HashSet<string> pure = new HashSet<string>();
        private readonly OrderedMap<string, Drawn> drawn = new OrderedMap<string, Drawn>();
        private readonly Dictionary<string, object> kinds = new Dictionary<string, object>();
        private Func<long, double[]> ownPose = _ => null;
        private Func<long, double[]> ownVelocity = _ => null;
        private readonly GenexPredictBodyRule bodyRule;
        private readonly GenexSeatRule seatRule;
        private readonly GenexPredictKinematicRule kinematicRule;
        private readonly GenexLiftsPolicy lifts;
        private readonly IDictionary<string, double> liftStarts;
        private readonly GenexPropSlide headSlide;
        /// <summary>Whether the client world holds the lifts' bodies (spawned at the first rebuild).</summary>
        private bool liftsSpawned;
        private readonly GenexRuleTick ruleTick = new GenexRuleTick();
        private readonly List<GenexRuleVelocity> ruleVelocities = new List<GenexRuleVelocity>();
        /// <summary><c>inputDecay</c>: each remote seat's body as last stepped, <c>J</c> ticks from the keyframe seat <c>From</c>.</summary>
        private readonly Dictionary<string, RemoteBody> remoteBodies = new Dictionary<string, RemoteBody>();
        private int setSize;
        /// <summary>The latest replay costs, ms (the budget's rolling window), and a buffer to sort them in.</summary>
        private readonly List<double> costs = new List<double>();
        private double[] sortedCosts = new double[BudgetWindow];
        /// <summary>In <c>cpu</c>: when the last probe ran (the clock Adopt is given), and calm probes in a row.</summary>
        private double probedAt = double.NegativeInfinity;
        private int calmProbes;
        /// <summary>How many bodies the last choice could take (every whole island in view).</summary>
        private int chosenCount;
        private double steppedAt;
        private readonly List<bool> canary = new List<bool>();
        private readonly Dictionary<string, double> epochs = new Dictionary<string, double>();
        /// <summary>The bodies this keyframe respawned (their epoch moved since the keyframe that last carried them).</summary>
        private readonly HashSet<string> respawned = new HashSet<string>();
        /// <summary>The ruled clock (§17.11 *Kinematic rules*): the fractional tick ruled bodies outside the simulated set are
        /// drawn at, and the room-clock instant it was read; the world's timeline, slewed so a replay that moves it never
        /// jumps or reverses them.</summary>
        private bool hasRuledClock;
        private double ruledClockAt, ruledClockTick;
        private readonly HashSet<string> chosenKeys = new HashSet<string>();
        // Choose's working sets, reused keyframe after keyframe (its islands' member lists from a pool).
        private readonly List<GenexIslandBody> chooseIslandBodies = new List<GenexIslandBody>();
        private readonly Dictionary<string, GenexKeyframeBody> chooseInView = new Dictionary<string, GenexKeyframeBody>();
        private readonly List<KeyValuePair<string, string>> chooseLinks = new List<KeyValuePair<string, string>>();
        private readonly OrderedMap<string, List<string>> chooseMembers = new OrderedMap<string, List<string>>();
        private readonly Stack<List<string>> chooseListPool = new Stack<List<string>>();
        private readonly List<KeyValuePair<string, List<string>>> chooseComplete = new List<KeyValuePair<string, List<string>>>();
        private readonly Dictionary<string, double> chooseNearOf = new Dictionary<string, double>();
        private readonly List<GenexKeyframeBody> chooseChosen = new List<GenexKeyframeBody>();
        private Comparison<KeyValuePair<string, List<string>>> byNearestIsland;
        private readonly List<string> escapedScratch = new List<string>();
        private readonly List<string> exportKeys = new List<string>();
        private readonly List<float> exportData = new List<float>();
        // Buffers a predicted tick reuses (a replay steps dozens of ticks; none of these allocates once warm).
        private readonly double[] clampLinear = new double[3], clampAngular = new double[3];
        private readonly Dictionary<string, GenexKeyframeBody> rebuildChosen = new Dictionary<string, GenexKeyframeBody>();
        private readonly List<string> rebuildKeys = new List<string>();
        private readonly List<double> rebuildRows = new List<double>();
        private readonly GenexWireBodyState stateScratch = new GenexWireBodyState();
        private readonly double[] rowFlat = new double[GenexPhysicsKeyframe.WireRowStride];
        private readonly Stack<double[]> rowPool = new Stack<double[]>();
        private readonly Stack<Dictionary<string, double[]>> ringPool = new Stack<Dictionary<string, double[]>>();
        private readonly Dictionary<string, string> seatRowKeys = new Dictionary<string, string>();
        private readonly List<string> rowKeys = new List<string>();
        private readonly List<float> rowData = new List<float>();
        private readonly Dictionary<string, int> listed = new Dictionary<string, int>();
        // The replay's hot path reuses these instead of allocating (on Mono's collector every byte is GC work inside the
        // budget's window): a copy of a map's keys while it changes, the seats a keyframe wants, the seats in key order,
        // and the drawn poses before a replay with the arrays they were written into.
        private readonly List<string> keyScratch = new List<string>();
        private readonly OrderedMap<string, GenexKeyframeSeat> seatsWanted = new OrderedMap<string, GenexKeyframeSeat>();
        private readonly List<GenexKeyframeSeat> seatsOf = new List<GenexKeyframeSeat>();
        private readonly Dictionary<string, double[][]> drawnBefore = new Dictionary<string, double[][]>();
        private readonly Stack<double[][]> drawnBeforePool = new Stack<double[][]>();
        private readonly double[] quatScratch = new double[4];

        /// <summary>The client stateHash after each predicted tick, newest last (the conformance check reads it).</summary>
        public readonly List<KeyValuePair<long, string>> Hashes = new List<KeyValuePair<long, string>>();

        private sealed class RemoteBody
        {
            public GenexKeyframeSeat From;
            public long J;
            public readonly Dictionary<string, double> Body = new Dictionary<string, double>();
        }

        private sealed class Simulated
        {
            public string Type, Desc;
        }

        private sealed class JointText
        {
            public string Desc, Motor;
        }

        private sealed class Drawn
        {
            public double[] P, Q, Lv, Av, Dp, Dq;
            /// <summary>The position correction's rate when it started, room units per ms (§17.11 *Drawing*).</summary>
            public double[] Dv;
            public bool Sleep;
            public double Since, Tau, Snap;

        }

        public GenexPhysicsPredictor(IGenexPhysicsCore core, GenexPredictorOptions options)
        {
            desc = options.Desc;
            tickHz = options.TickHz;
            innerDt = GenexPhysicsKeyframe.InnerDtOf(desc.World);
            lengthUnit = (float)desc.LengthUnit;
            // The lead cap's ticks past the latest keyframe's ack, plus the K − 1 ticks until the next keyframe.
            var leadMs = options.LeadMs ?? desc.LeadMs;
            leadMax = (long)Math.Ceiling(leadMs * options.TickHz / 1000) + desc.KeyframeTicks - 1;
            remoteStep = desc.RemotePredict == GenexRemotePredict.InputDecay || desc.RemotePredict == GenexRemotePredict.Hold ? options.RemoteStep : null;
            seatPose = options.SeatPose;
            contactPass = options.ContactPass;
            budgetMs = options.BudgetMs;
            if (options.Clock != null) clock = options.Clock;
            else
            {
                var watch = Stopwatch.StartNew();
                clock = () => watch.Elapsed.TotalMilliseconds;
            }
            hashesKept = options.HashesKept;
            bodyRule = options.BodyRule;
            seatRule = options.SeatRule;
            kinematicRule = options.KinematicRule;
            lifts = options.Lifts != null && options.Lifts.Platforms.Length > 0 ? options.Lifts : null;
            liftStarts = options.LiftStarts;
            headSlide = options.HeadSlide;
            ruleTick.BodyOf = RuleBodyOf;
            var created = core.CreateWorld(desc.World, out _);
            if (created == null)
            {
                Status = GenexPredictStatus.Mismatch;
                return;
            }
            var boxes = options.StaticBoxes;
            var ramps = options.StaticRamps;
            var empty = (boxes == null || boxes.Count == 0) && (ramps == null || ramps.Count == 0);
            if (!empty && !created.AddStaticWorld(boxes ?? new double[0][], ramps ?? new double[0][]).Ok)
            {
                created.Free();
                Status = GenexPredictStatus.Mismatch;
                return;
            }
            if (created.PhysicsHash() != options.PhysicsHash)
            {
                created.Free();
                Status = GenexPredictStatus.Mismatch;
                return;
            }
            world = created;
        }

        /// <summary>Whether bodies are predicted now (else the session draws them §17.10's way).</summary>
        public bool Predicting => Status == GenexPredictStatus.On || Status == GenexPredictStatus.Loading;

        /// <summary>Whether the predictor stopped for good (its world freed): every status but on, loading and cpu.</summary>
        public bool Stopped => world == null;

        /// <summary>Whether <paramref name="key"/> is a body this predictor draws.</summary>
        public bool Draws(string key) => Status == GenexPredictStatus.On && (drawn.ContainsKey(key) || RuledElsewhere(key));

        /// <summary>Whether the room's kinematic rule poses module kinematic body <paramref name="key"/> (at the world's tick).</summary>
        private bool Ruled(string key)
        {
            if (kinematicRule == null) return false;
            var tick = hasBase ? baseTick + (seq - baseAck) : 0;
            return kinematicRule(key, tick).HasValue;
        }

        /// <summary>A body the room's kinematic rule poses that the world does not simulate (out of view, or its island not
        /// chosen): drawn by the rule on the world's timeline all the same (§17.11 *Kinematic rules*), so it never jumps between
        /// the client's timeline and the server's present.</summary>
        private bool RuledElsewhere(string key) => hasBase && !drawn.ContainsKey(key) && Ruled(key);

        /// <summary>A ruled body outside the world as drawn at <paramref name="now"/>: the rule's pose at the ruled clock's tick.</summary>
        private bool RuledDrawn(string key, double now, out GenexBodyPose pose)
        {
            pose = default;
            if (kinematicRule == null || !RuledTick(now, out var tick)) return false;
            var t = Math.Floor(tick);
            return Between(kinematicRule, key, (long)t, tick - t, out pose);
        }

        /// <summary>
        /// The ruled clock at <paramref name="now"/> (physics-predict.ts ruledTick): it runs with the room clock and slews toward
        /// the world's timeline (the last stepped tick plus one, toward the next by the time since that step, at most one tick)
        /// by at most <see cref="RuledSlew"/> of the time passed, so a replay that moves the timeline (the server ran a tick
        /// without your input, or took two in one) is absorbed without a jump or a reversal; past <see cref="RuledSnapTicks"/> it
        /// snaps. False before the first keyframe.
        /// </summary>
        private bool RuledTick(double now, out double tick)
        {
            tick = 0;
            if (!hasBase) return false;
            var k = Math.Min(Math.Max(((now - steppedAt) / 1000) * tickHz, 0), 1);
            var target = baseTick + (seq - baseAck) + 1 + k;
            if (!hasRuledClock || now < ruledClockAt || Math.Abs(target - ruledClockTick) > RuledSnapTicks)
            {
                hasRuledClock = true;
                ruledClockAt = now;
                ruledClockTick = target;
                tick = target;
                return true;
            }
            var passed = ((now - ruledClockAt) / 1000) * tickHz;
            var free = ruledClockTick + passed;
            var slew = RuledSlew * passed;
            tick = free + Math.Min(Math.Max(target - free, -slew), slew);
            ruledClockAt = now;
            ruledClockTick = tick;
            return true;
        }

        /// <summary>The pose <paramref name="k"/> of the way from <c>rule(key, t)</c> to <c>rule(key, t + 1)</c>, oriented as
        /// the first; false when the rule does not pose <paramref name="key"/>.</summary>
        private static bool Between(GenexPredictKinematicRule rule, string key, long t, double k, out GenexBodyPose pose)
        {
            pose = default;
            var a = rule(key, t);
            var b = rule(key, t + 1);
            if (!a.HasValue || !b.HasValue) return false;
            var pa = a.Value;
            var pb = b.Value;
            var q = QuatNormalize(new[] { pa.Q.X, pa.Q.Y, pa.Q.Z, pa.Q.W });
            pose = new GenexBodyPose
            {
                X = pa.X + (pb.X - pa.X) * k, Y = pa.Y + (pb.Y - pa.Y) * k, Z = pa.Z + (pb.Z - pa.Z) * k, Q = new GenexQuat(q[0], q[1], q[2], q[3]),
            };
            return true;
        }

        /// <summary>
        /// §17.11 *Kinematic rules* (physics-predict.ts ruledPoseAt): where <paramref name="rule"/> poses <paramref name="key"/> at
        /// room-clock instant <paramref name="at"/> on the server's own timeline (its pose for tick T stands at
        /// <c>tickOrigin + T / tickHz</c>), between the two ticks around it; false when the rule does not pose the key. What a
        /// client draws for a ruled body whenever the predictor does not draw it (no core, cpu, any fallback level), in place of
        /// §17.10's extrapolation.
        /// </summary>
        public static bool RuledPoseAt(GenexPredictKinematicRule rule, string key, double at, double tickHz, double tickOrigin, out GenexBodyPose pose)
        {
            pose = default;
            if (rule == null) return false;
            var f = ((at - tickOrigin) * tickHz) / 1000;
            var tick = Math.Floor(f);
            return Between(rule, key, (long)tick, f - tick, out pose);
        }

        /// <summary>The client world's stateHash (C§10.1), "" without a world.</summary>
        public string StateHash() => world?.StateHash() ?? "";

        /// <summary>Stops predicting for good (a fallback, or the session ended).</summary>
        public void Stop(string status)
        {
            Status = status;
            world?.Free();
            world = null;
            drawn.Clear();
        }

        /// <summary>Adopts a keyframe. <paramref name="sent"/> is your last input's sequence; <paramref name="ownPoseOf"/> your predicted position after each.</summary>
        public GenexAdoptReport Adopt(GenexPredictKeyframe kf, long sent, Func<long, double[]> ownPoseOf, double now) => Adopt(kf, sent, ownPoseOf, now, null);

        /// <summary>As <see cref="Adopt(GenexPredictKeyframe, long, Func{long, double[]}, double)"/>, with your predicted velocity after
        /// each input (room units per second; a body rule reads it; null or a null answer: your entity's keyframe velocity).</summary>
        public GenexAdoptReport Adopt(GenexPredictKeyframe kf, long sent, Func<long, double[]> ownPoseOf, double now, Func<long, double[]> ownVelocityOf)
        {
            var none = new GenexAdoptReport { Kind = GenexAdoptReport.None };
            var w = world;
            if (w == null) return none;
            var probing = Status == GenexPredictStatus.Cpu;
            // In `cpu` only a probe adopts: one keyframe every CpuProbeMs, by a full replay.
            if (probing && now - probedAt < CpuProbeMs) return none;
            if (!probing && !Predicting) return none;
            // A keyframe body with no row, or without its position, cannot be placed (the TypeScript reads
            // NaN there and the core refuses the import): mismatch, never an exception out of the session.
            if (kf == null || kf.Bodies == null || kf.Bodies.Exists(b => b == null || b.Row == null || b.Row.Length < 3))
            {
                Stop(GenexPredictStatus.Mismatch);
                return none;
            }
            ownPose = ownPoseOf ?? (_ => null);
            ownVelocity = ownVelocityOf ?? (_ => null);
            var chosen = Choose(kf);
            // Bodies the module respawned since the keyframe that last carried them (their epoch moved): a deliberate
            // discontinuity (§17.3), no canary sample and never eased from the old life.
            respawned.Clear();
            foreach (var b in chosen)
            {
                if (b.Epoch.HasValue && epochs.TryGetValue(b.Key, out var known) && known != b.Epoch.Value) respawned.Add(b.Key);
            }
            foreach (var b in chosen) if (b.Epoch.HasValue) epochs[b.Key] = b.Epoch.Value;
            var report = probing ? new GenexAdoptReport { Kind = GenexAdoptReport.Replay } : Compare(kf, chosen);
            // The canary may have just turned prediction off.
            if (world == null)
            {
                report.Kind = GenexAdoptReport.None;
                return report;
            }
            if (report.Kind == GenexAdoptReport.Match)
            {
                hasBase = true;
                baseTick = kf.Tick;
                baseAck = kf.Ack;
                // The seats move on from this keyframe (their bodies stay: same epochs), and module kinematic bodies take
                // its poses (the latest server state).
                foreach (var seat in SeatsOf(kf)) seats.Set(seat.Key, seat);
                foreach (var b in chosen) if (kinematic.ContainsKey(b.Key)) kinematic.Set(b.Key, (double[])b.Row.Clone());
                Prune(kf.Tick);
                Status = GenexPredictStatus.On;
                return report;
            }
            // A probe starts every drawn body afresh: what was drawn in `cpu` was §17.10's drawing.
            if (probing) drawn.Clear();
            var before = SnapshotDrawn(now);
            var started = clock();
            if (!Rebuild(w, kf, chosen))
            {
                Stop(GenexPredictStatus.Mismatch);
                return none;
            }
            hasBase = true;
            baseTick = kf.Tick;
            baseAck = kf.Ack;
            seq = kf.Ack;
            ClearRing();
            ReadAll(w);
            var target = Math.Min(sent, kf.Ack + leadMax);
            var replayed = 0;
            for (var s = kf.Ack + 1; s <= target; s++, replayed++)
            {
                StepOnce(w);
                // A step the core refused stopped prediction (diverged) and freed the world: the replay ends there.
                if (world == null) break;
            }
            var ms = clock() - started;
            report.Kind = GenexAdoptReport.Replay;
            report.Replayed = replayed;
            report.Ms = ms;
            if (world == null) return report;
            steppedAt = now;
            Ease(before, now);
            if (probing) JudgeProbe(ms, now);
            else
            {
                Status = GenexPredictStatus.On;
                JudgeBudget(ms);
            }
            return report;
        }

        /// <summary>One predicted tick for input <paramref name="input"/>, sent at <paramref name="now"/>: nothing past the lead cap or before the first keyframe.</summary>
        public void Advance(long input, double now)
        {
            var w = world;
            if (w == null || !hasBase || Status != GenexPredictStatus.On) return;
            if (input != seq + 1 || input - baseAck > leadMax) return;
            StepOnce(w);
            steppedAt = now;
        }

        /// <summary>
        /// Where a predicted body is drawn at <paramref name="now"/>: its present pose moved on by its velocities for the time
        /// since the world last stepped (at most one tick, none while it sleeps), plus the decaying correction. False when
        /// this predictor does not draw it.
        /// </summary>
        public bool Draw(string key, double now, out GenexBodyPose pose)
        {
            pose = default;
            if (Status != GenexPredictStatus.On) return false;
            if (!drawn.TryGetValue(key, out var d)) return RuledElsewhere(key) && RuledDrawn(key, now, out pose);
            var dt = d.Sleep ? 0 : Math.Min(Math.Max((now - steppedAt) / 1000, 0), 1 / tickHz);
            var u = lengthUnit;
            var px = d.P[0] + d.Lv[0] * u * dt;
            var py = d.P[1] + d.Lv[1] * u * dt;
            var pz = d.P[2] + d.Lv[2] * u * dt;
            var q = Turned(d.Q, d.Av, dt);
            var age = Math.Max(now - d.Since, 0);
            var r = QuatMul(SlerpFromIdentity(d.Dq, Math.Exp(-age / d.Tau)), q);
            var ox = GenexPhysicsKeyframe.CorrectionAt(d.Dp[0], d.Dv[0], age, d.Tau, out _);
            var oy = GenexPhysicsKeyframe.CorrectionAt(d.Dp[1], d.Dv[1], age, d.Tau, out _);
            var oz = GenexPhysicsKeyframe.CorrectionAt(d.Dp[2], d.Dv[2], age, d.Tau, out _);
            pose = new GenexBodyPose { X = px + ox, Y = py + oy, Z = pz + oz, Q = new GenexQuat(r[0], r[1], r[2], r[3]) };
            return true;
        }

        // ---- adoption ----

        /// <summary>The bodies this client simulates: whole proximity islands of bodies in view with a descriptor, none of
        /// whose members is out of view, nearest your own entity first, up to the set size.</summary>
        /// <remarks>The list is this predictor's own, refilled by the next call (Adopt reads it before choosing again).</remarks>
        private List<GenexKeyframeBody> Choose(GenexPredictKeyframe kf)
        {
            var margin = GenexPhysicsKeyframe.IslandMarginMetres * lengthUnit;
            var islandBodies = chooseIslandBodies;
            islandBodies.Clear();
            var inView = chooseInView;
            inView.Clear();
            foreach (var b in kf.Bodies)
            {
                inView[b.Key] = b;
                islandBodies.Add(new GenexIslandBody { Key = b.Key, X = b.Row[0], Y = b.Row[1], Z = b.Row[2], Radius = b.Desc == null ? 0 : GenexPhysicsKeyframe.BodyRadiusOf(b.Desc) });
            }
            foreach (var o in kf.Outside) islandBodies.Add(new GenexIslandBody { Key = o.Key, X = o.X, Y = o.Y, Z = o.Z, Radius = o.Radius });
            var links = chooseLinks;
            links.Clear();
            foreach (var j in kf.Joints)
            {
                if (j.Desc != null && j.Desc.TryGetValue("a", out var a) && a is string sa && j.Desc.TryGetValue("b", out var bb) && bb is string sb)
                    links.Add(new KeyValuePair<string, string>(sa, sb));
            }
            var islands = GenexPhysicsKeyframe.ProximityIslands(islandBodies, links, margin);
            var members = chooseMembers;
            foreach (var entry in members) chooseListPool.Push(entry.Value);
            members.Clear();
            foreach (var b in islandBodies)
            {
                var island = islands[b.Key];
                if (members.TryGetValue(island, out var list)) list.Add(b.Key);
                else
                {
                    var fresh = chooseListPool.Count > 0 ? chooseListPool.Pop() : new List<string>();
                    fresh.Clear();
                    fresh.Add(b.Key);
                    members.Set(island, fresh);
                }
            }
            GenexKeyframeSeat own = null;
            foreach (var s in kf.Seats)
            {
                if (!s.Own) continue;
                own = s;
                break;
            }
            var complete = chooseComplete;
            complete.Clear();
            var nearOf = chooseNearOf;
            nearOf.Clear();
            foreach (var entry in members)
            {
                var whole = true;
                foreach (var k in entry.Value)
                {
                    if (inView.TryGetValue(k, out var b) && b.Desc != null) continue;
                    whole = false;
                    break;
                }
                if (!whole) continue;
                var nearest = double.PositiveInfinity;
                foreach (var k in entry.Value) nearest = Math.Min(nearest, DistanceToOwn(inView[k], own));
                nearOf[entry.Key] = nearest;
                complete.Add(entry);
            }
            GenexStableSort.Sort(complete, byNearestIsland ??= (x, y) =>
            {
                var diff = chooseNearOf[x.Key] - chooseNearOf[y.Key];
                if (diff != 0 && !double.IsNaN(diff)) return diff < 0 ? -1 : 1;
                return Math.Sign(string.CompareOrdinal(x.Key, y.Key));
            });
            chosenCount = 0;
            foreach (var entry in complete) chosenCount += entry.Value.Count;
            var cap = SetSizes[setSize];
            var chosen = chooseChosen;
            chosen.Clear();
            pure.Clear();
            foreach (var entry in complete)
            {
                var keys = entry.Value;
                if (chosen.Count + keys.Count > cap) continue;
                foreach (var k in keys) chosen.Add(inView[k]);
                // A seat is near an island where this keyframe has it or where the world last had it (the previous keyframe):
                // the world moved that seat by extrapolation from there, so a seat the module respawned or that left between
                // keyframes still made the bodies it left impure (Mechanism Hall's cycle start).
                var seatNear = false;
                foreach (var s in kf.Seats) seatNear = seatNear || NearAny(inView, keys, s, margin);
                foreach (var held in seats) seatNear = seatNear || NearAny(inView, keys, held.Value, margin);
                var hasKinematic = false;
                foreach (var k in keys) if (TypeOf(inView[k].Desc) == "kinematic") hasKinematic = true;
                if (!seatNear && !hasKinematic) foreach (var k in keys) pure.Add(k);
            }
            GenexStableSort.Sort(chosen, ByBodyKey);
            chosenKeys.Clear();
            foreach (var b in chosen) chosenKeys.Add(b.Key);
            return chosen;
        }

        /// <summary>Whether seat <paramref name="s"/> is near any of an island's <paramref name="keys"/>.</summary>
        private bool NearAny(Dictionary<string, GenexKeyframeBody> inView, List<string> keys, GenexKeyframeSeat s, double margin)
        {
            foreach (var k in keys)
            {
                if (Near(inView[k], s, margin)) return true;
            }
            return false;
        }

        private static readonly Comparison<GenexKeyframeBody> ByBodyKey = (x, y) => Math.Sign(string.CompareOrdinal(x.Key, y.Key));

        /// <summary>A keyframe body's distance from your seat (0 without one).</summary>
        private static double DistanceToOwn(GenexKeyframeBody b, GenexKeyframeSeat own) =>
            own == null ? 0 : Hypot(b.Row[0] - own.X, b.Row[1] - own.Y, b.Row[2] - own.Z);

        /// <summary>Skip-on-match: the keyframe is exactly what the world predicted for its tick.</summary>
        private GenexAdoptReport Compare(GenexPredictKeyframe kf, List<GenexKeyframeBody> chosen)
        {
            var replay = new GenexAdoptReport { Kind = GenexAdoptReport.Replay };
            if (!hasBase || !ring.TryGetValue(kf.Tick, out var predicted)) return replay;
            int pureCount = 0, mismatched = 0;
            var all = true;
            foreach (var b in chosen)
            {
                // Module kinematic bodies are posed from the keyframe, never predicted: not compared.
                if (TypeOf(b.Desc) == "kinematic") continue;
                var equal = predicted.TryGetValue(b.Key, out var mine) && SameRow(mine, b.Row);
                // A body the world did not predict for this keyframe (it just entered the set: the view, an island now whole)
                // has nothing to compare: no canary sample, though the keyframe is no match.
                if (pure.Contains(b.Key) && !respawned.Contains(b.Key) && mine != null)
                {
                    pureCount++;
                    if (!equal) mismatched++;
                }
                if (!equal) all = false;
            }
            NoteCanary(pureCount, mismatched);
            var sameSet = chosen.Count == simulated.Count;
            if (sameSet)
            {
                foreach (var b in chosen)
                {
                    if (simulated.TryGetValue(b.Key, out var sim) && sim.Desc == DescKey(b.Desc)) continue;
                    sameSet = false;
                    break;
                }
            }
            var ackOnTime = kf.Ack == baseAck + (kf.Tick - baseTick) && seq >= kf.Ack;
            replay.Pure = pureCount;
            replay.Mismatched = mismatched;
            var match = all && sameSet && ackOnTime && SameJoints(kf) && SameSeats(kf, predicted);
            if (match) replay.Kind = GenexAdoptReport.Match;
            return replay;
        }

        private bool SameJoints(GenexPredictKeyframe kf)
        {
            var wanted = JointsOf(kf);
            if (wanted.Count != joints.Count) return false;
            foreach (var entry in wanted.Entries())
            {
                if (!joints.TryGetValue(entry.Key, out var mine) || mine.Desc != entry.Value.Desc || mine.Motor != entry.Value.Motor) return false;
            }
            return true;
        }

        /// <summary>Every seat's preset body is where the world had it at the keyframe tick.</summary>
        private bool SameSeats(GenexPredictKeyframe kf, Dictionary<string, double[]> predicted)
        {
            var wanted = SeatsOf(kf);
            if (wanted.Count != seats.Count) return false;
            foreach (var s in wanted)
            {
                if (!predicted.TryGetValue("seat:" + s.Key, out var mine)) return false;
                if (!seats.TryGetValue(s.Key, out var known) || known.Epoch != s.Epoch) return false;
                var p = PresetPosition(s.X, s.Y, s.Z);
                if (!(mine[0] == p[0] && mine[1] == p[1] && mine[2] == p[2])) return false;
            }
            return true;
        }

        private void NoteCanary(int pureCount, int mismatched)
        {
            for (var i = 0; i < pureCount; i++) canary.Add(i < mismatched);
            if (canary.Count > CanaryWindow) canary.RemoveRange(0, canary.Count - CanaryWindow);
            if (canary.Count < CanaryMinSamples) return;
            var bad = 0;
            foreach (var c in canary) if (c) bad++;
            if ((double)bad / canary.Count > CanaryMaxMismatch) Stop(GenexPredictStatus.Diverged);
        }

        /// <summary>The <paramref name="q"/> quantile of the window (the nearest rank below), 0 for none.</summary>
        private double CostQuantile(double q)
        {
            var n = costs.Count;
            if (n == 0) return 0;
            if (sortedCosts.Length < n) sortedCosts = new double[n];
            costs.CopyTo(sortedCosts, 0);
            Array.Sort(sortedCosts, 0, n);
            return sortedCosts[Math.Min(n - 1, (int)Math.Floor(q * n))];
        }

        /// <summary>§17.11 *Budgets*: the replay's cost joins the rolling window; once it holds enough, a window over budget
        /// shrinks the set to the next size that chooses fewer bodies, or falls back to <c>cpu</c>, and a full calm window
        /// grows a shrunken set back one size.</summary>
        private void JudgeBudget(double ms)
        {
            costs.Add(ms);
            if (costs.Count > BudgetWindow) costs.RemoveRange(0, costs.Count - BudgetWindow);
            if (costs.Count < BudgetMinSamples) return;
            var median = CostQuantile(0.5);
            var p90 = CostQuantile(0.9);
            if (median > budgetMs || p90 > BudgetP90Factor * budgetMs)
            {
                costs.Clear();
                var next = NextPredictSetSize(setSize, chosenCount);
                if (next.HasValue) setSize = next.Value;
                else FallBack();
                return;
            }
            var calm = costs.Count >= BudgetWindow && p90 <= BudgetCalmShare * budgetMs;
            if (calm && setSize > 0)
            {
                setSize--;
                costs.Clear();
            }
        }

        /// <summary><c>cpu</c>: bodies are drawn §17.10's way; the world stays for the probes.</summary>
        private void FallBack()
        {
            Status = GenexPredictStatus.Cpu;
            Fallbacks++;
            drawn.Clear();
            probedAt = double.NegativeInfinity;
            calmProbes = 0;
        }

        /// <summary>A probe's cost: CpuCalmProbes calm ones in a row turn prediction on again.</summary>
        private void JudgeProbe(double ms, double now)
        {
            probedAt = now;
            calmProbes = ms <= BudgetCalmShare * budgetMs ? calmProbes + 1 : 0;
            if (calmProbes < CpuCalmProbes)
            {
                // Not drawn: the probe's world is kept for the next one, its drawing dropped.
                drawn.Clear();
                return;
            }
            Status = GenexPredictStatus.On;
            Recoveries++;
            costs.Clear();
            calmProbes = 0;
        }

        private sealed class WantedJoint
        {
            public string Desc, Motor;
            public GenexKeyframeJoint Parsed;
        }

        private OrderedMap<string, WantedJoint> JointsOf(GenexPredictKeyframe kf)
        {
            var output = new OrderedMap<string, WantedJoint>();
            foreach (var j in kf.Joints)
            {
                if (j.Desc == null) continue;
                var a = j.Desc.TryGetValue("a", out var av) ? av as string : null;
                if (a == null || (!simulated.ContainsKey(a) && !chosenKeys.Contains(a))) continue;
                // `b` null is the world; a missing or non-string `b` names no body this world has.
                if (!j.Desc.TryGetValue("b", out var bv)) continue;
                if (bv != null && (!(bv is string b) || (!simulated.ContainsKey(b) && !chosenKeys.Contains(b)))) continue;
                output.Set(j.Key, new WantedJoint { Desc = GenexJson.Serialize(j.Desc), Motor = j.Motor == null ? "" : GenexJson.Serialize(j.Motor), Parsed = j });
            }
            return output;
        }

        /// <summary>The seats whose preset bodies the room has: inside the world (§17.10 *Preset bodies*), in key order.</summary>
        /// <remarks>The list is this predictor's own, refilled by the next call: read it before calling again.</remarks>
        private List<GenexKeyframeSeat> SeatsOf(GenexPredictKeyframe kf)
        {
            var output = seatsOf;
            output.Clear();
            if (desc.PresetBody == null) return output;
            var extent = desc.WorldExtent;
            foreach (var s in kf.Seats)
            {
                PresetCoords(s.X, s.Y, s.Z, out var px, out var py, out var pz);
                if (Math.Abs(px) <= extent && Math.Abs(py) <= extent && Math.Abs(pz) <= extent) output.Add(s);
            }
            GenexStableSort.Sort(output, BySeatEntryKey);
            return output;
        }

        private static readonly Comparison<GenexKeyframeSeat> BySeatEntryKey = (x, y) => Math.Sign(string.CompareOrdinal(x.Key, y.Key));

        /// <summary>A preset body's centre for an entity at float32 (x, y, z): half its height up, as float32.</summary>
        private double[] PresetPosition(double x, double y, double z)
        {
            PresetCoords(x, y, z, out var px, out var py, out var pz);
            return new[] { px, py, pz };
        }

        private void PresetCoords(double x, double y, double z, out double px, out double py, out double pz)
        {
            var half = desc.PresetBody?.Half[2] ?? 0;
            px = (float)x;
            py = (float)y;
            pz = (float)((double)(float)z + half);
        }

        /// <summary>The world brought to the keyframe: bodies, joints and seats spawned or removed to match, every state
        /// imported, then canonicalized. False when the core refused what the server accepted.</summary>
        private bool Rebuild(IGenexPhysicsWorld w, GenexPredictKeyframe kf, List<GenexKeyframeBody> chosen)
        {
            var wantedJoints = JointsOf(kf);
            joints.KeysInto(keyScratch);
            foreach (var key in keyScratch)
            {
                if (wantedJoints.TryGetValue(key, out var want) && want.Desc == joints.Get(key).Desc) continue;
                w.RemoveJoint(key);
                joints.Remove(key);
            }
            var chosenByKey = rebuildChosen;
            chosenByKey.Clear();
            foreach (var b in chosen) chosenByKey[b.Key] = b;
            simulated.KeysInto(keyScratch);
            foreach (var key in keyScratch)
            {
                if (chosenByKey.TryGetValue(key, out var want) && DescKey(want.Desc) == simulated.Get(key).Desc) continue;
                w.Remove(key);
                simulated.Remove(key);
                kinematic.Remove(key);
                drawn.Remove(key);
            }
            foreach (var b in chosen)
            {
                if (simulated.ContainsKey(b.Key) || b.Desc == null) continue;
                if (!w.Spawn(b.Desc).Ok) return false;
                kinds[b.Key] = b.Desc.TryGetValue("kind", out var kind) ? kind : null;
                simulated.Set(b.Key, new Simulated { Type = TypeText(b.Desc), Desc = DescKey(b.Desc) });
            }
            kinematic.Clear();
            foreach (var b in chosen)
            {
                if (TypeOf(b.Desc) != "kinematic") continue;
                kinematic.Set(b.Key, (double[])b.Row.Clone());
                // One the kinematic rule poses is drawn by the predictor, its correction kept like any body's.
                if (!Ruled(b.Key)) drawn.Remove(b.Key);
            }
            if (!RebuildSeats(w, kf)) return false;
            foreach (var entry in wantedJoints)
            {
                var key = entry.Key;
                var j = entry.Value;
                if (!joints.ContainsKey(key) && !w.AddJoint(j.Parsed.Desc).Ok) return false;
                var knownMotor = joints.TryGetValue(key, out var known) ? known.Motor : null;
                if (j.Parsed.Motor != null && knownMotor != j.Motor && !w.SetMotor(key, j.Parsed.Motor).Ok) return false;
                joints.Set(key, new JointText { Desc = j.Desc, Motor = j.Motor });
            }
            var keys = rebuildKeys;
            var rows = rebuildRows;
            keys.Clear();
            rows.Clear();
            foreach (var b in chosen)
            {
                keys.Add(b.Key);
                for (var i = 0; i < GenexPhysicsKeyframe.WireRowStride; i++) rows.Add(i < b.Row.Length ? b.Row[i] : double.NaN);
            }
            foreach (var entry in seats)
            {
                var s = entry.Value;
                keys.Add(s.Key);
                PresetCoords(s.X, s.Y, s.Z, out var px, out var py, out var pz);
                rows.Add(px);
                rows.Add(py);
                rows.Add(pz);
                rows.AddRange(PresetRowTail);
            }
            if (!RebuildLifts(w, kf.Tick, keys, rows)) return false;
            if (keys.Count > 0 && !w.ImportWire(keys, rows).Ok) return false;
            return w.Canonicalize(true).Ok;
        }

        private static readonly double[] StillRowTail = { 32767, 32767, 32767, 32767, 32767, 32767, 0, 0 };

        /// <summary>The room's lift bodies brought to the keyframe (§17.11 <i>Lifts</i> step 9): spawned once, each with its wire row at
        /// P(tick + 1), still; false when the core refused one.</summary>
        private bool RebuildLifts(IGenexPhysicsWorld w, long tick, List<string> keys, List<double> rows)
        {
            if (lifts == null) return true;
            if (!liftsSpawned)
            {
                foreach (var lift in lifts.Platforms) if (!w.Spawn(GenexLifts.LiftBodySpawn(lift, tick + 1, liftStarts)).Ok) return false;
                liftsSpawned = true;
            }
            foreach (var lift in lifts.Platforms)
            {
                GenexLifts.LiftBodyPose(lift, tick + 1, liftStarts, out var p, out var q);
                keys.Add(GenexLifts.LiftBodyKey(lift.Id));
                rows.AddRange(p);
                foreach (var v in q) rows.Add(Math.Floor(((v + 1) / 2) * 65534 + 0.5));
                rows.AddRange(StillRowTail);
            }
            return true;
        }

        private bool RebuildSeats(IGenexPhysicsWorld w, GenexPredictKeyframe kf)
        {
            var wanted = seatsWanted;
            wanted.Clear();
            foreach (var s in SeatsOf(kf)) wanted.Set(s.Key, s);
            seats.KeysInto(keyScratch);
            foreach (var key in keyScratch)
            {
                if (wanted.TryGetValue(key, out var want) && want.Epoch == seats.Get(key).Epoch) continue;
                w.Remove(key);
                seats.Remove(key);
            }
            var shape = desc.PresetBody;
            foreach (var entry in wanted)
            {
                var s = entry.Value;
                if (!seats.ContainsKey(entry.Key) && shape != null)
                {
                    var collider = new Dictionary<string, object>
                    {
                        ["key"] = "hull",
                        ["shape"] = new Dictionary<string, object> { ["kind"] = "box", ["half"] = (double[])shape.Half.Clone() },
                        ["events"] = shape.Events,
                    };
                    var body = new Dictionary<string, object>
                    {
                        ["key"] = entry.Key,
                        ["type"] = "kinematic",
                        ["pose"] = new Dictionary<string, object> { ["p"] = PresetPosition(s.X, s.Y, s.Z), ["q"] = (double[])IdentityQ.Clone() },
                        ["colliders"] = new List<object> { collider },
                    };
                    if (!w.Spawn(body).Ok) return false;
                }
                seats.Set(entry.Key, s);
            }
            return true;
        }

        // ---- one predicted tick: the server's order (§17.11 *The tick*) ----

        private void StepOnce(IGenexPhysicsWorld w)
        {
            var next = seq + 1;
            var tick = baseTick + (next - baseAck);
            // The tick's commands cross with its step in one call when the core takes a tick frame.
            var frame = w as IGenexPhysicsTickFrame;
            var ruleSeats = ruleTick.SeatList;
            ruleSeats.Clear();
            var seatsPosed = false;
            foreach (var entry in seats)
            {
                ruleSeats.Add(SeatAt(entry.Value, next, tick - baseTick));
                seatsPosed |= posedBySeats;
            }
            // §17.11 *Contact policy*: the room's contact pass on this tick's seats, unless the seat prediction posed them.
            if (!seatsPosed) PassSeats(ruleSeats);
            foreach (var at in ruleSeats)
            {
                PresetCoords(at.X, at.Y, at.Z, out var px, out var py, out var pz);
                if (frame != null) frame.QueueKinematicPose(at.Key, px, py, pz, 0, 0, 0, 1);
                else w.SetNextKinematicPose(at.Key, new[] { px, py, pz }, (double[])IdentityQ.Clone());
            }
            // A module kinematic body holds the keyframe's pose, unless the room's kinematic rule poses it: then the rule's pose
            // at the end of this tick's step, as the module sends it (§17.11 *Kinematic rules*).
            foreach (var entry in kinematic)
            {
                var posed = kinematicRule?.Invoke(entry.Key, tick + 1);
                double[] p, q;
                if (posed.HasValue)
                {
                    var r = posed.Value;
                    p = new[] { r.X, r.Y, r.Z };
                    q = new[] { r.Q.X, r.Q.Y, r.Q.Z, r.Q.W };
                }
                else KeyframePose(entry.Value, out p, out q);
                if (frame != null) frame.QueueKinematicPose(entry.Key, p[0], p[1], p[2], q[0], q[1], q[2], q[3]);
                else w.SetNextKinematicPose(entry.Key, p, q);
            }
            // The room's lifts at the end of this tick's step, as the host poses them (§17.11 <i>Lifts</i> step 9).
            if (lifts != null && liftsSpawned)
            {
                foreach (var lift in lifts.Platforms)
                {
                    GenexLifts.LiftBodyPose(lift, tick + 1, liftStarts, out var p, out var q);
                    var key = GenexLifts.LiftBodyKey(lift.Id);
                    if (frame != null) frame.QueueKinematicPose(key, p[0], p[1], p[2], q[0], q[1], q[2], q[3]);
                    else w.SetNextKinematicPose(key, p, q);
                }
            }
            ApplyBodyRule(w, frame, tick);
            var since = w.Tick;
            var stepped = frame != null ? frame.StepFrame(escapedScratch) : w.Step(escapedScratch);
            if (!stepped.Ok)
            {
                Stop(GenexPredictStatus.Diverged);
                return;
            }
            foreach (var key in escapedScratch)
            {
                w.Remove(key);
                simulated.Remove(key);
                drawn.Remove(key);
            }
            var clamped = Clamp(w, since);
            var keyframeTick = tick % desc.KeyframeTicks == 0;
            if (keyframeTick)
            {
                w.Canonicalize(true);
                if (ring.TryGetValue(tick, out var stale)) Recycle(stale);
                ring.Set(tick, RowsNow(w));
            }
            seq = next;
            // Nothing changed the world since the clamp's export when it set no velocity and nothing was canonicalized: the
            // drawing reads that same export (the same call would answer the same).
            if (clamped || keyframeTick) w.ExportChanged(since, exportKeys, exportData);
            ReadDrawn();
            Hashes.Add(new KeyValuePair<long, string>(tick, w.StateHash()));
            if (Hashes.Count > hashesKept) Hashes.RemoveRange(0, Hashes.Count - hashesKept);
        }

        /// <summary>A seat's entity j ticks after the keyframe, with its velocity: yours from your prediction (your velocity
        /// from the ring, else the keyframe's); a remote one by its last input repeated and decayed (inputDecay), else
        /// extrapolated by its velocity.</summary>
        private GenexRuleSeat SeatAt(GenexKeyframeSeat s, long input, long j)
        {
            posedBySeats = false;
            var own = s.Own ? ownPose(input) : null;
            if (own != null)
            {
                var v = ownVelocity(input);
                return v != null
                    ? new GenexRuleSeat { Key = s.Key, X = own[0], Y = own[1], Z = own[2], Vx = v[0], Vy = v[1], Vz = v[2] }
                    : new GenexRuleSeat { Key = s.Key, X = own[0], Y = own[1], Z = own[2], Vx = s.Vx, Vy = s.Vy, Vz = s.Vz };
            }
            if (!s.Own && seatPose?.Invoke(s.Key, input) is GenexRuleSeat predicted)
            {
                predicted.Key = s.Key;
                posedBySeats = true;
                return predicted;
            }
            if (s.Own || remoteStep == null || !s.Input.HasValue)
            {
                var ahead = j / tickHz;
                return new GenexRuleSeat { Key = s.Key, X = s.X + s.Vx * ahead, Y = s.Y + s.Vy * ahead, Z = s.Z + s.Vz * ahead, Vx = s.Vx, Vy = s.Vy, Vz = s.Vz };
            }
            // The seat's body stepped tick by tick from its keyframe entity: a replay asks for j = 1, 2, … in order, so the
            // last stepped body is continued, not stepped again from the keyframe (the same steps).
            remoteBodies.TryGetValue(s.Key, out var memo);
            var resume = memo != null && ReferenceEquals(memo.From, s) && memo.J <= j;
            if (memo == null)
            {
                memo = new RemoteBody();
                remoteBodies[s.Key] = memo;
            }
            var body = memo.Body;
            if (!resume)
            {
                body.Clear();
                if (s.Body != null) foreach (var kv in s.Body) body[kv.Key] = kv.Value;
                body["x"] = s.X;
                body["y"] = s.Y;
                body["z"] = s.Z;
            }
            var dt = 1 / tickHz;
            // §17.11 *Seat rules*: the j-th step is applied on the keyframe's tick + j, the rule first.
            var from = hasBase ? baseTick : 0;
            for (var i = (resume ? memo.J : 0) + 1; i <= j; i++)
            {
                seatRule?.Invoke(body, from + i);
                // `hold`: the last input as it was, every tick; `inputDecay`: its axes decayed.
                var held = desc.RemotePredict == GenexRemotePredict.Hold;
                remoteStep(body, held ? s.Input.Value : GenexPhysicsKeyframe.DecayedInput(s.Input.Value, i, tickHz, desc.RemoteDecayMs), dt);
            }
            memo.From = s;
            memo.J = j;
            return new GenexRuleSeat
            {
                Key = s.Key, X = Field(body, "x", double.NaN), Y = Field(body, "y", double.NaN), Z = Field(body, "z", double.NaN),
                Vx = Field(body, "vx", s.Vx), Vy = Field(body, "vy", s.Vy), Vz = Field(body, "vz", s.Vz), Yaw = Field(body, "yaw", 0),
            };
        }

        /// <summary>The room's contact pass on this tick's seats (copies, ids ascending), their poses and velocities taken from what
        /// it left (§17.11 *Contact policy*: the replay runs the server's pass).</summary>
        private void PassSeats(List<GenexRuleSeat> list)
        {
            if (contactPass == null || list.Count < 2) return;
            var bodies = new List<GenexContactBody>(list.Count);
            foreach (var seat in list) bodies.Add(new GenexContactBody(seat.Key) { X = seat.X, Y = seat.Y, Z = seat.Z, Vx = seat.Vx, Vy = seat.Vy, Vz = seat.Vz, Yaw = seat.Yaw });
            bodies.Sort((a, b) => string.CompareOrdinal(a.Id, b.Id));
            contactPass(bodies);
            for (var i = 0; i < list.Count; i++)
            {
                var seat = list[i];
                foreach (var b in bodies)
                {
                    if (b.Id != seat.Key) continue;
                    seat.X = b.X;
                    seat.Y = b.Y;
                    seat.Z = b.Z;
                    seat.Vx = b.Vx;
                    seat.Vy = b.Vy;
                    seat.Vz = b.Vz;
                    break;
                }
                list[i] = seat;
            }
        }

        private static double Field(Dictionary<string, double> body, string name, double fallback) => body.TryGetValue(name, out var v) ? v : fallback;

        /// <summary>A body rule's view of a simulated dynamic body: its state as the last step left it.</summary>
        private GenexRuleBody? RuleBodyOf(string key)
        {
            var w = world;
            if (w == null || !simulated.TryGetValue(key, out var sim) || sim.Type != "dynamic") return null;
            var st = ExportState(w, key);
            if (st == null) return null;
            return new GenexRuleBody { Px = st.P[0], Py = st.P[1], Pz = st.P[2], Vx = st.V[0], Vy = st.V[1], Vz = st.V[2] };
        }

        /// <summary>§17.11 *Body rules*: the room's rule on this tick's seats (key order) and the bodies as the last step left
        /// them, its velocities set on the simulated dynamic bodies it names, in its order, before the step.</summary>
        private void ApplyBodyRule(IGenexPhysicsWorld w, IGenexPhysicsTickFrame frame, long tick)
        {
            var seatList = ruleTick.SeatList;
            seatList.Sort(BySeatKey);
            // The built-in rules read the bodies as the last step left them (the host's view: its last export).
            var props = BuiltInProps(w);
            ApplyModuleRule(w, frame, tick);
            if (props != null) ApplyBuiltInRules(w, frame, tick, seatList, props);
        }

        /// <summary>The simulated dynamic bodies (key order) as the built-in body rules read them, when one runs: the conveyor rule (a lift
        /// with a surface) or the prop rule (<c>headFriction: slide</c>) over a preset body; else null.</summary>
        private List<GenexRuleProp> BuiltInProps(IGenexPhysicsWorld w)
        {
            if (desc.PresetBody == null) return null;
            var belts = false;
            if (lifts != null && liftsSpawned) foreach (var l in lifts.Platforms) belts |= l.HasSurface;
            if (!belts && headSlide == null) return null;
            var keys = new List<string>();
            foreach (var entry in simulated) if (entry.Value.Type == "dynamic") keys.Add(entry.Key);
            keys.Sort(string.CompareOrdinal);
            var output = new List<GenexRuleProp>(keys.Count);
            foreach (var key in keys)
            {
                var st = ExportState(w, key);
                if (st == null) continue;
                output.Add(new GenexRuleProp { Key = key, Px = st.P[0], Py = st.P[1], Pz = st.P[2], Vx = st.V[0], Vy = st.V[1], Vz = st.V[2] });
            }
            return output;
        }

        /// <summary>The built-in body rules after the module's (§17.11 <i>Lifts</i> step 9): the conveyor rule, then the prop rule, their
        /// velocities set (linear only) in their order.</summary>
        private void ApplyBuiltInRules(IGenexPhysicsWorld w, IGenexPhysicsTickFrame frame, long tick, List<GenexRuleSeat> seatList, List<GenexRuleProp> props)
        {
            var half = desc.PresetBody.Half;
            var sets = new List<GenexRuleVelocity>();
            if (lifts != null && liftsSpawned) sets.AddRange(GenexLifts.ConveyorNudges(lifts, tick, liftStarts, tickHz, props, 2 * half[2]));
            if (headSlide != null) sets.AddRange(GenexLifts.PropSlideNudges(seatList, half, props, headSlide));
            foreach (var set in sets)
            {
                if (frame != null) frame.QueueVelocity(set.Key, set.Vx, set.Vy, set.Vz);
                else w.SetVelocity(set.Key, new[] { set.Vx, set.Vy, set.Vz }, null);
            }
        }

        /// <summary>The room module's body rule on this tick's seats (key order), its velocities set on the simulated dynamic bodies it
        /// names, in its order.</summary>
        private void ApplyModuleRule(IGenexPhysicsWorld w, IGenexPhysicsTickFrame frame, long tick)
        {
            var rule = bodyRule;
            if (rule == null) return;
            ruleTick.Tick = tick;
            ruleVelocities.Clear();
            rule(ruleTick, ruleVelocities);
            foreach (var set in ruleVelocities)
            {
                if (set.Key == null || !simulated.TryGetValue(set.Key, out var sim) || sim.Type != "dynamic") continue;
                if (frame != null) frame.QueueVelocity(set.Key, set.Vx, set.Vy, set.Vz);
                else w.SetVelocity(set.Key, new[] { set.Vx, set.Vy, set.Vz }, null);
            }
        }

        private static readonly Comparison<GenexRuleSeat> BySeatKey = (a, b) => string.CompareOrdinal(a.Key, b.Key);

        /// <summary>The speed clamp, on the simulated dynamic bodies, in key order (the export's).</summary>
        /// <summary>The speed clamp; whether it set a velocity.</summary>
        private bool Clamp(IGenexPhysicsWorld w, long since)
        {
            w.ExportChanged(since, exportKeys, exportData);
            var stride = GenexPhysicsKeyframe.WireRowStride;
            var v = clampLinear;
            var a = clampAngular;
            var set = false;
            for (var i = 0; i < exportKeys.Count; i++)
            {
                var key = exportKeys[i];
                if (!simulated.TryGetValue(key, out var sim) || sim.Type != "dynamic") continue;
                var o = i * stride;
                v[0] = exportData[o + 7];
                v[1] = exportData[o + 8];
                v[2] = exportData[o + 9];
                a[0] = exportData[o + 10];
                a[1] = exportData[o + 11];
                a[2] = exportData[o + 12];
                if (!GenexPhysicsKeyframe.ClampedVelocity(v, a, lengthUnit, desc.MaxLinear, desc.MaxAngular, out var lin, out var ang)) continue;
                w.SetVelocity(key, lin, ang);
                set = true;
            }
            return set;
        }

        /// <summary>The wire rows of every simulated body and seat after a keyframe tick's canonicalize (seats under
        /// <c>seat:&lt;key&gt;</c>), each read on its own: an export lists no body asleep since before the tick.</summary>
        private Dictionary<string, double[]> RowsNow(IGenexPhysicsWorld w)
        {
            var rows = ringPool.Count > 0 ? ringPool.Pop() : new Dictionary<string, double[]>();
            // On the native core, one export of every body changed since the world's first tick (every awake one too) gives
            // most states in one call: the same float32s exportBodyState writes as JSON. A body it does not list (asleep and
            // unchanged since) is read on its own.
            listed.Clear();
            if (w is IGenexPhysicsTickFrame)
            {
                w.ExportChanged(0, rowKeys, rowData);
                for (var i = 0; i < rowKeys.Count; i++) listed[rowKeys[i]] = i;
            }
            foreach (var entry in simulated)
            {
                var row = RowNow(w, entry.Key);
                if (row != null) rows[entry.Key] = row;
            }
            foreach (var entry in seats)
            {
                var row = RowNow(w, entry.Key);
                if (row != null) rows[SeatRowKey(entry.Key)] = row;
            }
            return rows;
        }

        /// <summary>A body's wire row now: from the export when it listed the body, else its own state; null for no body.</summary>
        private double[] RowNow(IGenexPhysicsWorld w, string key)
        {
            if (listed.TryGetValue(key, out var i))
            {
                var stride = GenexPhysicsKeyframe.WireRowStride;
                for (var k = 0; k < stride; k++) rowFlat[k] = rowData[i * stride + k];
                var exported = rowPool.Count > 0 ? rowPool.Pop() : new double[stride];
                GenexPhysicsKeyframe.WireRowOfExport(rowFlat, 0, lengthUnit, innerDt, exported, 0);
                return exported;
            }
            var st = ExportState(w, key);
            return st == null ? null : RowOf(st);
        }

        /// <summary>A body's state, read into a buffer this predictor reuses when the world can (valid until the next read).</summary>
        private GenexWireBodyState ExportState(IGenexPhysicsWorld w, string key)
        {
            if (w is IGenexPhysicsTickFrame frame) return frame.ExportBodyStateInto(key, stateScratch) ? stateScratch : null;
            return w.ExportBodyState(key);
        }

        /// <summary>A wire row (from the pool of rows the ring gave back).</summary>
        private double[] RowOf(GenexWireBodyState st)
        {
            var row = rowPool.Count > 0 ? rowPool.Pop() : new double[GenexPhysicsKeyframe.WireRowStride];
            GenexPhysicsKeyframe.WireRowOfState(st, lengthUnit, innerDt, rowFlat, row);
            return row;
        }

        /// <summary>"seat:" + key, kept per key.</summary>
        private string SeatRowKey(string key)
        {
            if (seatRowKeys.TryGetValue(key, out var text)) return text;
            if (seatRowKeys.Count > 1024) seatRowKeys.Clear();
            text = "seat:" + key;
            seatRowKeys[key] = text;
            return text;
        }

        /// <summary>A ring entry's rows back to the pools.</summary>
        private void Recycle(Dictionary<string, double[]> rows)
        {
            foreach (var row in rows.Values) rowPool.Push(row);
            rows.Clear();
            ringPool.Push(rows);
        }

        /// <summary>Every ring entry back to the pools.</summary>
        private void ClearRing()
        {
            foreach (var entry in ring) Recycle(entry.Value);
            ring.Clear();
        }

        /// <summary>Keeps only the ring's keyframes after <paramref name="tick"/>.</summary>
        private void Prune(long tick)
        {
            foreach (var t in ring.KeyList())
            {
                if (t > tick) continue;
                Recycle(ring.Get(t));
                ring.Remove(t);
            }
        }

        // ---- drawing ----

        /// <summary>The simulated bodies' present states, from the bodies changed after <paramref name="since"/>.</summary>
        private void ReadDrawn()
        {
            var stride = GenexPhysicsKeyframe.WireRowStride;
            var u = lengthUnit;
            for (var i = 0; i < exportKeys.Count; i++)
            {
                var key = exportKeys[i];
                // A module kinematic body is drawn from the server's states (§17.10), not by the predictor, unless the room's
                // kinematic rule poses it.
                if (!simulated.ContainsKey(key) || (kinematic.ContainsKey(key) && !Ruled(key))) continue;
                var o = i * stride;
                // The present state is written over the known one in place (its correction kept); a new body starts with none.
                if (!drawn.TryGetValue(key, out var d))
                {
                    d = new Drawn
                    {
                        P = new double[3], Q = new double[4], Lv = new double[3], Av = new double[3], Dp = Zero3(), Dv = Zero3(), Dq = (double[])IdentityQ.Clone(),
                        Since = 0, Tau = GenexPhysicsKeyframe.CorrectionTauMs(0), Snap = SnapOf(key),
                    };
                    drawn.Set(key, d);
                }
                d.P[0] = exportData[o];
                d.P[1] = exportData[o + 1];
                d.P[2] = exportData[o + 2];
                QuatNormalizeInto(exportData[o + 3], exportData[o + 4], exportData[o + 5], exportData[o + 6], d.Q);
                d.Lv[0] = exportData[o + 7] / u;
                d.Lv[1] = exportData[o + 8] / u;
                d.Lv[2] = exportData[o + 9] / u;
                d.Av[0] = exportData[o + 10];
                d.Av[1] = exportData[o + 11];
                d.Av[2] = exportData[o + 12];
                d.Sleep = exportData[o + 13] == 1;
            }
        }

        /// <summary>Every simulated body's present state, each read on its own (after a rebuild).</summary>
        private void ReadAll(IGenexPhysicsWorld w)
        {
            var u = lengthUnit;
            simulated.KeysInto(keyScratch);
            foreach (var key in keyScratch)
            {
                var st = kinematic.ContainsKey(key) && !Ruled(key) ? null : ExportState(w, key);
                if (st == null) continue;
                if (!drawn.TryGetValue(key, out var d))
                {
                    d = new Drawn
                    {
                        P = new double[3], Q = new double[4], Lv = new double[3], Av = new double[3], Dp = Zero3(), Dv = Zero3(), Dq = (double[])IdentityQ.Clone(),
                        Since = 0, Tau = GenexPhysicsKeyframe.CorrectionTauMs(0), Snap = SnapOf(key),
                    };
                    drawn.Set(key, d);
                }
                d.P[0] = st.P[0];
                d.P[1] = st.P[1];
                d.P[2] = st.P[2];
                QuatNormalizeInto(st.Q[0], st.Q[1], st.Q[2], st.Q[3], d.Q);
                d.Lv[0] = st.V[0] / u;
                d.Lv[1] = st.V[1] / u;
                d.Lv[2] = st.V[2] / u;
                d.Av[0] = st.W[0];
                d.Av[1] = st.W[1];
                d.Av[2] = st.W[2];
                d.Sleep = st.Sleeping;
            }
        }

        /// <summary>Each predicted body's present pose with its correction at <paramref name="now"/> (no extrapolation):
        /// where a replay's correction starts from.</summary>
        /// <remarks>The map and its arrays are this predictor's own, rewritten by the next call.</remarks>
        private Dictionary<string, double[][]> SnapshotDrawn(double now)
        {
            var output = drawnBefore;
            foreach (var pose in output.Values) drawnBeforePool.Push(pose);
            output.Clear();
            foreach (var entry in drawn)
            {
                var d = entry.Value;
                var age = Math.Max(now - d.Since, 0);
                // [0] the drawn position, [1] the orientation, [2] the correction's rate (units per ms).
                var pose = drawnBeforePool.Count > 0 ? drawnBeforePool.Pop() : new[] { new double[3], new double[4], new double[3] };
                pose[0][0] = d.P[0] + GenexPhysicsKeyframe.CorrectionAt(d.Dp[0], d.Dv[0], age, d.Tau, out pose[2][0]);
                pose[0][1] = d.P[1] + GenexPhysicsKeyframe.CorrectionAt(d.Dp[1], d.Dv[1], age, d.Tau, out pose[2][1]);
                pose[0][2] = d.P[2] + GenexPhysicsKeyframe.CorrectionAt(d.Dp[2], d.Dv[2], age, d.Tau, out pose[2][2]);
                SlerpFromIdentityInto(d.Dq, Math.Exp(-age / d.Tau), quatScratch);
                QuatMulInto(quatScratch, d.Q, pose[1]);
                output[entry.Key] = pose;
            }
            return output;
        }

        /// <summary>A body's snap distance, room units, by its physics kind (§17.11 *Drawing*).</summary>
        private double SnapOf(string key) => GenexPhysicsKeyframe.SnapMetresOf(kinds.TryGetValue(key, out var kind) ? kind : null) * lengthUnit;

        /// <summary>After a replay: each body that moved starts a correction from where it was drawn: dp = old − new,
        /// dq = old ⊗ new⁻¹ the short way, its τ by its size in metres, snapped past its snap distance; a body this keyframe
        /// respawned (a new life) snaps.</summary>
        /// <remarks>Written into each drawing in place (its own correction arrays; nothing else holds them).</remarks>
        private void Ease(Dictionary<string, double[][]> before, double now)
        {
            foreach (var entry in drawn)
            {
                var d = entry.Value;
                if (!before.TryGetValue(entry.Key, out var old) || respawned.Contains(entry.Key))
                {
                    Snapped(d, now);
                    continue;
                }
                double dpx = old[0][0] - d.P[0], dpy = old[0][1] - d.P[1], dpz = old[0][2] - d.P[2];
                var size = Hypot(dpx, dpy, dpz);
                if (size > d.Snap)
                {
                    Snapped(d, now);
                    continue;
                }
                var raw = quatScratch;
                raw[0] = -d.Q[0];
                raw[1] = -d.Q[1];
                raw[2] = -d.Q[2];
                raw[3] = d.Q[3];
                QuatMulInto(old[1], raw, d.Dq);
                if (d.Dq[3] < 0)
                {
                    d.Dq[0] = -d.Dq[0];
                    d.Dq[1] = -d.Dq[1];
                    d.Dq[2] = -d.Dq[2];
                    d.Dq[3] = -d.Dq[3];
                }
                d.Dp[0] = dpx;
                d.Dp[1] = dpy;
                d.Dp[2] = dpz;
                d.Dv[0] = old[2][0];
                d.Dv[1] = old[2][1];
                d.Dv[2] = old[2][2];
                d.Since = now;
                d.Tau = GenexPhysicsKeyframe.CorrectionTauMs(size / lengthUnit);
            }
        }

        /// <summary>A drawing with no correction from <paramref name="now"/> (a new body, or a move past its snap distance).</summary>
        private static void Snapped(Drawn d, double now)
        {
            d.Dp[0] = 0;
            d.Dp[1] = 0;
            d.Dp[2] = 0;
            d.Dv[0] = 0;
            d.Dv[1] = 0;
            d.Dv[2] = 0;
            d.Dq[0] = 0;
            d.Dq[1] = 0;
            d.Dq[2] = 0;
            d.Dq[3] = 1;
            d.Since = now;
            d.Tau = GenexPhysicsKeyframe.CorrectionTauMs(0);
        }

        // ---- helpers ----

        private static double[] Zero3() => new double[3];

        private static bool SameRow(double[] a, double[] b)
        {
            if (a == null || b == null || a.Length < GenexPhysicsKeyframe.WireRowStride || b.Length < GenexPhysicsKeyframe.WireRowStride) return false;
            for (var i = 0; i < GenexPhysicsKeyframe.WireRowStride; i++)
            {
                // Object.is: NaN equals NaN, +0 and −0 differ.
                if (BitConverter.DoubleToInt64Bits(a[i]) == BitConverter.DoubleToInt64Bits(b[i])) continue;
                if (double.IsNaN(a[i]) && double.IsNaN(b[i])) continue;
                return false;
            }
            return true;
        }

        /// <summary>A descriptor's identity: its text (written once per descriptor object: the session hands the same object
        /// over every keyframe while the room's text for it is the same; a descriptor is never changed once handed over).</summary>
        private static string DescKey(Dictionary<string, object> d) => d == null ? "" : DescTexts.GetValue(d, DescText);

        private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Dictionary<string, object>, string> DescTexts =
            new System.Runtime.CompilerServices.ConditionalWeakTable<Dictionary<string, object>, string>();
        private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Dictionary<string, object>, string>.CreateValueCallback DescText =
            d => GenexJson.Serialize(d);

        private static string TypeOf(Dictionary<string, object> d) => d != null && d.TryGetValue("type", out var t) ? t as string : null;

        /// <summary>String(desc.type), as the reference keeps it.</summary>
        private static string TypeText(Dictionary<string, object> d)
        {
            if (!d.TryGetValue("type", out var t)) return "undefined";
            if (t == null) return "null";
            return t is string s ? s : GenexJson.Serialize(t);
        }

        private static double Hypot(double x, double y, double z) => Math.Sqrt(x * x + y * y + z * z);

        /// <summary>Whether a seat's preset body is within an island's reach of a body (a seat touching an island makes it impure).</summary>
        private bool Near(GenexKeyframeBody b, GenexKeyframeSeat s, double margin)
        {
            var half = desc.PresetBody?.Half ?? new double[3];
            var reach = Hypot(half[0], half[1], half[2]) + (b.Desc == null ? 0 : GenexPhysicsKeyframe.BodyRadiusOf(b.Desc)) + margin;
            return Hypot(b.Row[0] - s.X, b.Row[1] - s.Y, b.Row[2] - (s.Z + half[2])) <= reach;
        }

        /// <summary><see cref="QuatMul"/> written into <paramref name="into"/> (which may be neither input).</summary>
        private static void QuatMulInto(double[] a, double[] b, double[] into)
        {
            double x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
            double y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
            double z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
            double w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
            into[0] = x;
            into[1] = y;
            into[2] = z;
            into[3] = w;
        }

        /// <summary><see cref="SlerpFromIdentity"/> written into <paramref name="into"/>.</summary>
        private static void SlerpFromIdentityInto(double[] dq, double k, double[] into)
        {
            var s = Math.Sqrt(dq[0] * dq[0] + dq[1] * dq[1] + dq[2] * dq[2]);
            if (s == 0)
            {
                into[0] = 0;
                into[1] = 0;
                into[2] = 0;
                into[3] = 1;
                return;
            }
            var theta = 2 * Math.Atan2(s, dq[3]);
            var h = Math.Sin(k * theta / 2);
            into[0] = dq[0] / s * h;
            into[1] = dq[1] / s * h;
            into[2] = dq[2] / s * h;
            into[3] = Math.Cos(k * theta / 2);
        }

        internal static double[] QuatMul(double[] a, double[] b) => new[]
        {
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        };

        /// <summary><see cref="QuatNormalize"/> of (x, y, z, w) written into <paramref name="into"/>.</summary>
        private static void QuatNormalizeInto(double x, double y, double z, double w, double[] into)
        {
            var len = Math.Sqrt(x * x + y * y + z * z + w * w);
            if (len == 0)
            {
                into[0] = 0;
                into[1] = 0;
                into[2] = 0;
                into[3] = 1;
                return;
            }
            into[0] = x / len;
            into[1] = y / len;
            into[2] = z / len;
            into[3] = w / len;
        }

        internal static double[] QuatNormalize(double[] q)
        {
            var len = Math.Sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
            if (len == 0) return (double[])IdentityQ.Clone();
            return new[] { q[0] / len, q[1] / len, q[2] / len, q[3] / len };
        }

        /// <summary>slerp(identity, dq, k) for a dq with w ≥ 0: the rotation by k·θ about dq's axis, θ = 2·atan2(|v|, w).</summary>
        internal static double[] SlerpFromIdentity(double[] dq, double k)
        {
            var s = Math.Sqrt(dq[0] * dq[0] + dq[1] * dq[1] + dq[2] * dq[2]);
            if (s == 0) return (double[])IdentityQ.Clone();
            var theta = 2 * Math.Atan2(s, dq[3]);
            var h = Math.Sin(k * theta / 2);
            return new[] { dq[0] / s * h, dq[1] / s * h, dq[2] / s * h, Math.Cos(k * theta / 2) };
        }

        /// <summary><paramref name="q"/> turned by angular velocity <paramref name="av"/> (world axes) over <paramref name="dt"/> seconds.</summary>
        private static double[] Turned(double[] q, double[] av, double dt)
        {
            var rate = Hypot(av[0], av[1], av[2]);
            if (rate == 0 || dt == 0) return q;
            var half = rate * dt / 2;
            var s = Math.Sin(half) / rate;
            return QuatNormalize(QuatMul(new[] { av[0] * s, av[1] * s, av[2] * s, Math.Cos(half) }, q));
        }

        /// <summary>A module kinematic body's pose as its keyframe row holds it. It is never extrapolated (§17.11 *The client world*).</summary>
        private static void KeyframePose(double[] row, out double[] p, out double[] q)
        {
            double Unit(double v) => -1 + (v / 65534) * 2;
            q = QuatNormalize(new[] { Unit(row[3]), Unit(row[4]), Unit(row[5]), Unit(row[6]) });
            p = new[] { row[0], row[1], row[2] };
        }

        // ---- level 2: the self-test scene at core load (§17.11 *Fallback levels*) ----

        private const int SelfTestTicks = 12;

        private static Dictionary<string, object> SelfTestWorld() => new Dictionary<string, object>
        {
            ["contract"] = "1.0", ["dt"] = 1.0 / 60, ["substeps"] = 1.0, ["gravity"] = new double[] { 0, 0, -9.81 }, ["upAxis"] = "z", ["lengthUnit"] = 1.0,
        };

        private static List<Dictionary<string, object>> SelfTestBodies()
        {
            Dictionary<string, object> Box(string key, double[] p, double half) => new Dictionary<string, object>
            {
                ["key"] = key, ["type"] = "dynamic", ["pose"] = new Dictionary<string, object> { ["p"] = p, ["q"] = new double[] { 0, 0, 0, 1 } },
                ["linvel"] = new double[] { 1, 0, 0 },
                ["colliders"] = new List<object> { new Dictionary<string, object> { ["key"] = "c", ["shape"] = new Dictionary<string, object> { ["kind"] = "box", ["half"] = new[] { half, half, half } } } },
            };
            return new List<Dictionary<string, object>>
            {
                Box("a", new double[] { 0, 0, 0.5 }, 0.5),
                Box("b", new double[] { 0, 0, 1.6 }, 0.5),
                new Dictionary<string, object>
                {
                    ["key"] = "c", ["type"] = "dynamic", ["pose"] = new Dictionary<string, object> { ["p"] = new double[] { 2, 0, 1 }, ["q"] = new double[] { 0, 0, 0, 1 } },
                    ["angvel"] = new double[] { 0, 3, 0 },
                    ["colliders"] = new List<object> { new Dictionary<string, object> { ["key"] = "c", ["shape"] = new Dictionary<string, object> { ["kind"] = "sphere", ["radius"] = 0.4 } } },
                },
            };
        }

        /// <summary>
        /// Whether the core keeps the promise prediction rests on, on this device: a world stepped, then canonicalized with
        /// quantize, and a second world built from the same descriptors that imports its wire rows and canonicalizes, step on
        /// with equal stateHashes. False also when the core refuses any of it.
        /// </summary>
        public static bool SelfTest(IGenexPhysicsCore core)
        {
            var server = core.CreateWorld(SelfTestWorld(), out _);
            var client = core.CreateWorld(SelfTestWorld(), out _);
            try
            {
                if (server == null || client == null) return false;
                var floor = new List<double[]> { new double[] { -20, -20, -1, 20, 20, 0 } };
                var none = new List<double[]>();
                if (!server.AddStaticWorld(floor, none).Ok || !client.AddStaticWorld(floor, none).Ok) return false;
                foreach (var body in SelfTestBodies()) if (!server.Spawn(body).Ok || !client.Spawn(body).Ok) return false;
                // Both step as many ticks (the tick counter is in the stateHash, C§10.1); the client is still at its spawn
                // state, so only the import can bring it to the server's.
                for (var i = 0; i < SelfTestTicks; i++) server.Step(null);
                client.Canonicalize(false);
                for (var i = 0; i < SelfTestTicks; i++) client.Step(null);
                if (!server.Canonicalize(true).Ok) return false;
                var keys = new List<string>();
                var data = new List<float>();
                server.ExportChanged(server.Tick, keys, data);
                var stride = GenexPhysicsKeyframe.WireRowStride;
                var flat = new double[data.Count];
                for (var i = 0; i < flat.Length; i++) flat[i] = data[i];
                var rows = new double[keys.Count * stride];
                var innerDt = GenexPhysicsKeyframe.InnerDtOf(SelfTestWorld());
                for (var i = 0; i < keys.Count; i++) GenexPhysicsKeyframe.WireRowOfExport(flat, i * stride, 1, innerDt, rows, i * stride);
                if (keys.Count != 3 || !client.ImportWire(keys, rows).Ok || !client.Canonicalize(true).Ok) return false;
                for (var i = 0; i < SelfTestTicks; i++)
                {
                    server.Step(null);
                    client.Step(null);
                    if (server.StateHash() != client.StateHash()) return false;
                }
                return true;
            }
            finally
            {
                server?.Free();
                client?.Free();
            }
        }
    }

    /// <summary>A map that iterates in insertion order, as a JavaScript Map does (a set of an existing key keeps its place).</summary>
    internal sealed class OrderedMap<TKey, TValue>
    {
        private readonly Dictionary<TKey, LinkedListNode<KeyValuePair<TKey, TValue>>> index = new Dictionary<TKey, LinkedListNode<KeyValuePair<TKey, TValue>>>();
        private readonly LinkedList<KeyValuePair<TKey, TValue>> order = new LinkedList<KeyValuePair<TKey, TValue>>();

        public int Count => index.Count;
        public bool ContainsKey(TKey key) => index.ContainsKey(key);

        /// <summary>The entries in order, without a copy (and without an allocation): the map must not change while they are walked.</summary>
        public LinkedList<KeyValuePair<TKey, TValue>>.Enumerator GetEnumerator() => order.GetEnumerator();

        public bool TryGetValue(TKey key, out TValue value)
        {
            if (index.TryGetValue(key, out var node))
            {
                value = node.Value.Value;
                return true;
            }
            value = default;
            return false;
        }

        public TValue Get(TKey key) => index[key].Value.Value;

        public void Set(TKey key, TValue value)
        {
            if (index.TryGetValue(key, out var node)) node.Value = new KeyValuePair<TKey, TValue>(key, value);
            else index[key] = order.AddLast(new KeyValuePair<TKey, TValue>(key, value));
        }

        public bool Remove(TKey key)
        {
            if (!index.TryGetValue(key, out var node)) return false;
            order.Remove(node);
            index.Remove(key);
            return true;
        }

        public void Clear()
        {
            index.Clear();
            order.Clear();
        }

        /// <summary>The keys now, in order, into <paramref name="into"/> (cleared first): a copy the map may change under,
        /// without allocating one.</summary>
        public void KeysInto(List<TKey> into)
        {
            into.Clear();
            foreach (var kv in order) into.Add(kv.Key);
        }

        /// <summary>The keys now, in order (a copy: the map may change while they are walked).</summary>
        public List<TKey> KeyList()
        {
            var keys = new List<TKey>(order.Count);
            foreach (var kv in order) keys.Add(kv.Key);
            return keys;
        }

        /// <summary>The values now, in order (a copy).</summary>
        public List<TValue> Values()
        {
            var values = new List<TValue>(order.Count);
            foreach (var kv in order) values.Add(kv.Value);
            return values;
        }

        /// <summary>The entries now, in order (a copy).</summary>
        public List<KeyValuePair<TKey, TValue>> Entries() => new List<KeyValuePair<TKey, TValue>>(order);
    }
}
