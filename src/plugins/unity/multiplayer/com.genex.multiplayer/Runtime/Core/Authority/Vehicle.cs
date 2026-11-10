// The `vehicle` movement preset (PROTOCOL.md §17.7), ported from packages/multiplayer/src/authority/presets.ts: an
// arcade car on Rocket League's ground and air handling, kept level: throttle, braking and coasting, boost from a
// fuel tank, grip that turns the velocity with the heading (less of it while drift is held), a yaw rate that grows
// with speed and mirrors in reverse, a jump and air steering. The heading is body state, so the step turns it with
// the portable sine and cosine (GenexPresets.PSinCos), never Math.Sin/Math.Cos. It moves the same axis-aligned hull
// through the same world as firstperson, with that preset's collision procedures exactly as they are
// (Firstperson.cs: the hull's height is `height`, and it does not turn with the heading), except that the slides
// inside its ground move are the car's ground slide (SlideMove with `car`).
//
// Determinism rules as Firstperson.cs: double arithmetic in the order §17.7 writes it, only + - * /, Math.Sqrt,
// Math.Floor and the portable sine and cosine, no fused multiply-add, and a float32 rounding only where §17.7 says
// so. Held bit for bit to packages/netcode-bench/conformance/authority/presets/vehicle.json by Tests~/GenexSmoke
// `presets` (with and without the broadphase, and inside Unity by Tests~/AuthorityProbe). Engine-agnostic: no
// UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>
    /// <c>vehicle</c> parameters (§17.7's table). Real-valued ones are used as float32 by the step; the integer ones
    /// (the button masks, <see cref="Substeps"/> and <see cref="World"/>) exactly.
    /// </summary>
    public struct GenexVehicleParams
    {
        /// <summary>Top speed on the throttle, units/s, before the body's <c>cap</c>.</summary>
        public double MaxSpeed;
        /// <summary>Throttle acceleration, units/s².</summary>
        public double Accel;
        /// <summary>Deceleration while the throttle opposes the motion.</summary>
        public double Brake;
        /// <summary>Deceleration with no throttle, and down to the throttle's speed when above it without boost.</summary>
        public double Coast;
        /// <summary>Boost's acceleration along the heading, on top of the throttle's.</summary>
        public double BoostAccel;
        /// <summary>Top speed under boost, before <c>cap</c>.</summary>
        public double BoostMaxSpeed;
        /// <summary>Fuel burned per second of boost (a full tank is 1).</summary>
        public double BoostBurn;
        /// <summary>Deceleration of the sideways speed on the ground, units/s².</summary>
        public double Grip;
        /// <summary>The same, while drift is held.</summary>
        public double DriftGrip;
        /// <summary>Yaw rate at full steer on the ground, rad/s, at or above <see cref="TurnSpeed"/>.</summary>
        public double TurnRate;
        /// <summary>The forward speed at which the full turn rate is reached; below it, the rate scales with speed.</summary>
        public double TurnSpeed;
        /// <summary>How fast the yaw rate follows the steering on the ground, rad/s².</summary>
        public double SpinAccel;
        /// <summary>Yaw rate at full steer in the air, rad/s.</summary>
        public double AirTurnRate;
        /// <summary>How fast the yaw rate follows the steering in the air, rad/s².</summary>
        public double AirSpinAccel;
        /// <summary>Units/s² along -z.</summary>
        public double Gravity;
        /// <summary>The <c>vz</c> a jump sets.</summary>
        public double JumpImpulse;
        /// <summary>Each velocity axis is clamped to ±this.</summary>
        public double MaxVelocity;
        /// <summary>Half the side of the hull's square footprint.</summary>
        public double Radius;
        /// <summary>Hull height.</summary>
        public double Height;
        /// <summary>Highest ledge driven up without a jump, and the deepest drop a sub-step follows down.</summary>
        public double StepHeight;
        /// <summary>Least z of a ramp top's unit normal that can be driven on.</summary>
        public double Standable;
        /// <summary>How far below the hull's base ground is found.</summary>
        public double GroundTrace;
        /// <summary>How far above the hull's base ground is found.</summary>
        public double GroundSnap;
        /// <summary>Clearance kept from a surface.</summary>
        public double Skin;
        /// <summary>Button masks: any shared bit counts as held; 0 disables.</summary>
        public int JumpBit, BoostBit, DriftBit;
        /// <summary>Sub-steps per step, [1, 8].</summary>
        public int Substeps;
        /// <summary>1: a jump works at <c>cap</c> 0. 0: a press at <c>cap</c> 0 is no jump (a kickoff's hold).</summary>
        public int CapZeroJump;
        /// <summary>The collision world's hash (<see cref="GenexFirstpersonWorld.Hash"/>), written by the sandbox.</summary>
        public uint World;
    }

    /// <summary>
    /// The fields a <c>vehicle</c> step reads and writes (it reads <see cref="Cap"/> and never writes it, and never
    /// touches pitch or duck). A NaN field is "missing", read as the step says: 0 (1 for <see cref="Cap"/>).
    /// </summary>
    public struct GenexVehicleBody
    {
        public double X, Y, Z, VX, VY, VZ;
        /// <summary>Heading, radians, +yaw counterclockwise seen from above (z up): body state, not input.</summary>
        public double Yaw;
        /// <summary>Yaw rate, rad/s, positive toward +yaw, [-1000, 1000].</summary>
        public double Spin;
        /// <summary>The boost tank, [0, 1]. The module writes it to refuel; the step only burns it.</summary>
        public double Fuel;
        /// <summary><see cref="GenexVehicle.OnGround"/> and <see cref="GenexVehicle.JumpHeld"/> bits.</summary>
        public double Mstate;
        /// <summary>Multiplier of both top speeds the module writes, [0, 4].</summary>
        public double Cap;
    }

    /// <summary>The <c>vehicle</c> preset (PROTOCOL.md §17.7): its parameters and its step.</summary>
    public static class GenexVehicle
    {
        /// <summary>The preset's name (append-only).</summary>
        public const string Name = "vehicle";
        /// <summary><c>mstate</c> bits a step keeps (the ducking bit is read as 0).</summary>
        public const int OnGround = 1, JumpHeld = 4;
        private const int MstateBits = OnGround | JumpHeld;
        private const double MaxAbs = 1e9;
        private const double MaxSpin = 1000;

        /// <summary>§17.7's defaults: a small arcade car in units of about a centimetre (Rocket League's scale).</summary>
        public static readonly GenexVehicleParams Defaults = new GenexVehicleParams
        {
            MaxSpeed = 1410, Accel = 1000, Brake = 3500, Coast = 525, BoostAccel = 1000, BoostMaxSpeed = 2300,
            BoostBurn = 0.3333333432674408, Grip = 6000, DriftGrip = 1500, TurnRate = 2.2, TurnSpeed = 400, SpinAccel = 30,
            AirTurnRate = 5.5, AirSpinAccel = 9, Gravity = 650, JumpImpulse = 450, MaxVelocity = 6000, Radius = 50, Height = 36,
            StepHeight = 8, Standable = 0.7, GroundTrace = 4, GroundSnap = 2, Skin = 0.03, JumpBit = 1, BoostBit = 2, DriftBit = 4,
            Substeps = 2, CapZeroJump = 1, World = GenexFirstperson.EmptyWorldHash,
        };

        private struct Range
        {
            public double Min, Max;
            public bool Positive, Integer;
        }

        private static Range In(double min, double max) => new Range { Min = min, Max = max };
        private static Range AboveZero(double max) => new Range { Min = 0, Max = max, Positive = true };
        private static Range Integer(double min, double max) => new Range { Min = min, Max = max, Integer = true };

        /// <summary>Each parameter's accepted range, in §17.7's table order.</summary>
        private static readonly KeyValuePair<string, Range>[] Ranges =
        {
            new KeyValuePair<string, Range>("maxSpeed", In(0, 100000)),
            new KeyValuePair<string, Range>("accel", In(0, 100000)),
            new KeyValuePair<string, Range>("brake", In(0, 100000)),
            new KeyValuePair<string, Range>("coast", In(0, 100000)),
            new KeyValuePair<string, Range>("boostAccel", In(0, 100000)),
            new KeyValuePair<string, Range>("boostMaxSpeed", In(0, 100000)),
            new KeyValuePair<string, Range>("boostBurn", In(0, 1000)),
            new KeyValuePair<string, Range>("grip", In(0, 100000)),
            new KeyValuePair<string, Range>("driftGrip", In(0, 100000)),
            new KeyValuePair<string, Range>("turnRate", In(0, 100)),
            new KeyValuePair<string, Range>("turnSpeed", AboveZero(100000)),
            new KeyValuePair<string, Range>("spinAccel", In(0, 10000)),
            new KeyValuePair<string, Range>("airTurnRate", In(0, 100)),
            new KeyValuePair<string, Range>("airSpinAccel", In(0, 10000)),
            new KeyValuePair<string, Range>("gravity", In(0, 100000)),
            new KeyValuePair<string, Range>("jumpImpulse", In(0, 100000)),
            new KeyValuePair<string, Range>("maxVelocity", In(0, 100000)),
            new KeyValuePair<string, Range>("radius", AboveZero(10000)),
            new KeyValuePair<string, Range>("height", AboveZero(10000)),
            new KeyValuePair<string, Range>("stepHeight", In(0, 10000)),
            new KeyValuePair<string, Range>("standable", In(0, 1)),
            new KeyValuePair<string, Range>("groundTrace", In(0, 10000)),
            new KeyValuePair<string, Range>("groundSnap", In(0, 10000)),
            new KeyValuePair<string, Range>("skin", In(0, 100)),
            new KeyValuePair<string, Range>("jumpBit", Integer(0, 16777215)),
            new KeyValuePair<string, Range>("boostBit", Integer(0, 16777215)),
            new KeyValuePair<string, Range>("driftBit", Integer(0, 16777215)),
            new KeyValuePair<string, Range>("substeps", Integer(1, 8)),
            new KeyValuePair<string, Range>("capZeroJump", Integer(0, 1)),
            new KeyValuePair<string, Range>("world", Integer(0, 4294967295)),
        };

        private static bool Accepts(Range range, object value)
        {
            if (!(value is double v) || double.IsNaN(v) || double.IsInfinity(v) || v < range.Min || v > range.Max) return false;
            if (range.Integer && v != Math.Floor(v)) return false;
            // A range that excludes 0 excludes it as the step uses the value: as float32 (1e-46 is 0 there).
            return !range.Positive || (v > 0 && (float)v > 0);
        }

        private static bool TryRange(string key, out Range range)
        {
            foreach (var kv in Ranges)
                if (kv.Key == key)
                {
                    range = kv.Value;
                    return true;
                }
            range = default;
            return false;
        }

        /// <summary>
        /// Whether <paramref name="parameters"/> is acceptable: null, or a JSON object (GenexJson model) whose every key
        /// is one of the table's parameters with a finite number in its range (an integer where the table says so).
        /// </summary>
        public static bool ParamsValid(object parameters)
        {
            if (parameters == null) return true;
            if (!(parameters is IDictionary<string, object> map)) return false;
            foreach (var kv in map)
                if (!TryRange(kv.Key, out var range) || !Accepts(range, kv.Value)) return false;
            return true;
        }

        /// <summary>Parameters from a room's <c>preset.params</c> (GenexJson model): defaults for anything unset or invalid.</summary>
        public static GenexVehicleParams ResolveParams(object parameters)
        {
            var p = Defaults;
            if (!(parameters is IDictionary<string, object> map)) return p;
            foreach (var kv in Ranges)
            {
                if (!map.TryGetValue(kv.Key, out var value) || !Accepts(kv.Value, value)) continue;
                var v = (double)value;
                switch (kv.Key)
                {
                    case "maxSpeed": p.MaxSpeed = v; break;
                    case "accel": p.Accel = v; break;
                    case "brake": p.Brake = v; break;
                    case "coast": p.Coast = v; break;
                    case "boostAccel": p.BoostAccel = v; break;
                    case "boostMaxSpeed": p.BoostMaxSpeed = v; break;
                    case "boostBurn": p.BoostBurn = v; break;
                    case "grip": p.Grip = v; break;
                    case "driftGrip": p.DriftGrip = v; break;
                    case "turnRate": p.TurnRate = v; break;
                    case "turnSpeed": p.TurnSpeed = v; break;
                    case "spinAccel": p.SpinAccel = v; break;
                    case "airTurnRate": p.AirTurnRate = v; break;
                    case "airSpinAccel": p.AirSpinAccel = v; break;
                    case "gravity": p.Gravity = v; break;
                    case "jumpImpulse": p.JumpImpulse = v; break;
                    case "maxVelocity": p.MaxVelocity = v; break;
                    case "radius": p.Radius = v; break;
                    case "height": p.Height = v; break;
                    case "stepHeight": p.StepHeight = v; break;
                    case "standable": p.Standable = v; break;
                    case "groundTrace": p.GroundTrace = v; break;
                    case "groundSnap": p.GroundSnap = v; break;
                    case "skin": p.Skin = v; break;
                    case "jumpBit": p.JumpBit = (int)v; break;
                    case "boostBit": p.BoostBit = (int)v; break;
                    case "driftBit": p.DriftBit = (int)v; break;
                    case "substeps": p.Substeps = (int)v; break;
                    case "capZeroJump": p.CapZeroJump = (int)v; break;
                    // An exact u32: never rounded through a float32 (it may reach 2^32 - 1).
                    case "world": p.World = (uint)v; break;
                }
            }
            return p;
        }

        // ---------------- the step ----------------

        /// <summary>One vehicle step's working state: the hull, the params as float32, the car and the sub-step's terms.</summary>
        private sealed class Car : GenexFirstperson.Hull
        {
            public double MaxSpeed, Accel, Brake, Coast, BoostAccel, BoostMaxSpeed, BoostBurn, Grip, DriftGrip;
            public double TurnRate, TurnSpeed, SpinAccel, AirTurnRate, AirSpinAccel, Gravity, JumpImpulse, MaxVelocity, Cap;
            public double Steer, Throttle;
            public bool Boost, Drift;
            public double Yaw, Spin, Fuel;
            public bool JumpHeld, Pressed, Boosting;
            /// <summary>Sub-step step 2: the heading's cosine and sine, the speed along it and across it (+90°).</summary>
            public double C, S, F, L;
        }

        [ThreadStatic] private static Car scratch;

        private static double F32(double v) => (float)v;
        private static double Min(double a, double b) => a < b ? a : b;
        private static double Max(double a, double b) => a > b ? a : b;

        /// <summary>toward(v, target, d), d ≥ 0: v moved by at most d toward target, never past it.</summary>
        private static double Toward(double v, double target, double d)
        {
            if (v < target) return Min(target, v + d);
            if (v > target) return Max(target, v - d);
            return v;
        }

        /// <summary>wrap(v): topdown's step 5 for a usable value (-float32(π) for float32(π), -0 as 0).</summary>
        private static double Wrap(double v) => GenexPresets.WrappedAngle(v) ?? 0;

        /// <summary>drive(): throttle, brake, coast and boost along the heading, grip across it, the yaw rate.</summary>
        private static void Drive(Car m)
        {
            // 1.
            var top = m.MaxSpeed * m.Cap;
            var t = m.Boosting ? 1 : m.Throttle;
            var target = t * top;
            // 2. The forward speed.
            var f = m.F;
            if (t == 0) f = Toward(f, 0, m.Coast * m.H);
            else if ((t > 0 && f < 0) || (t < 0 && f > 0)) f = Toward(f, 0, m.Brake * m.H);
            else if (Math.Abs(f) < Math.Abs(target)) f = Toward(f, target, m.Accel * m.H);
            else if (!m.Boosting) f = Toward(f, target, m.Coast * m.H);
            // 3.
            if (m.Boosting)
            {
                var boostTop = m.BoostMaxSpeed * m.Cap;
                if (f < boostTop) f = Min(boostTop, f + m.BoostAccel * m.H);
            }
            // 4.
            var grip = m.Drift ? m.DriftGrip : m.Grip;
            var l = Toward(m.L, 0, grip * m.H);
            // 5. Reverse steering is mirrored.
            var share = Min(1, Math.Abs(f) / m.TurnSpeed);
            var want = m.Steer * m.TurnRate * share;
            if (f < 0) want = -want;
            m.Spin = Toward(m.Spin, want, m.SpinAccel * m.H);
            // 6. The velocity rebuilt on the axes it was measured on.
            var fc = f * m.C;
            var ls = l * m.S;
            m.VX = fc - ls;
            var fs = f * m.S;
            var lc = l * m.C;
            m.VY = fs + lc;
            m.VZ = 0;
            m.F = f;
            m.L = l;
        }

        /// <summary>air(): steering by the air rules, and boost along the level heading.</summary>
        private static void Air(Car m)
        {
            m.Spin = Toward(m.Spin, m.Steer * m.AirTurnRate, m.AirSpinAccel * m.H);
            if (!m.Boosting) return;
            var boostTop = m.BoostMaxSpeed * m.Cap;
            if (!(m.F < boostTop)) return;
            var a = Min(m.BoostAccel * m.H, boostTop - m.F);
            m.VX = m.VX + a * m.C;
            m.VY = m.VY + a * m.S;
        }

        /// <summary>One sub-step (§17.7's eleven).</summary>
        private static void SubStep(Car m)
        {
            // 1.
            var was = m.OnGround;
            GenexFirstperson.CheckGround(m);
            if (m.OnGround && !was) m.VZ = 0;
            // 2.
            GenexPresets.PSinCos(m.Yaw, out m.S, out m.C);
            var vxc = m.VX * m.C;
            var vys = m.VY * m.S;
            m.F = vxc + vys;
            var vyc = m.VY * m.C;
            var vxs = m.VX * m.S;
            m.L = vyc - vxs;
            // 3. The sub-step that empties the tank still boosts.
            m.Boosting = m.Boost && m.Fuel > 0;
            if (m.Boosting) m.Fuel = Max(0, m.Fuel - m.BoostBurn * m.H);
            // 4.
            if (m.OnGround && m.Pressed)
            {
                m.VZ = m.JumpImpulse;
                m.OnGround = false;
                m.Pressed = false;
            }
            // 5. The sub-step that jumps steers by the air rules.
            if (m.OnGround) Drive(m);
            else Air(m);
            // 6.
            var falling = !m.OnGround;
            if (falling) m.VZ = m.VZ - m.Gravity * m.H * 0.5;
            // 7.
            m.VX = GenexFirstperson.Clamp(m.VX, -m.MaxVelocity, m.MaxVelocity);
            m.VY = GenexFirstperson.Clamp(m.VY, -m.MaxVelocity, m.MaxVelocity);
            m.VZ = GenexFirstperson.Clamp(m.VZ, -m.MaxVelocity, m.MaxVelocity);
            // 8. Always usable here: |yaw| ≤ float32(π) and |spin · h| ≤ 1000 · 0.25.
            m.Yaw = Wrap(m.Yaw + m.Spin * m.H);
            // 9. On the ground each slide is the car's ground slide; a wall clips the velocity along it, nothing bounces.
            if (m.OnGround)
            {
                GenexFirstperson.GroundMove(m, true);
                GenexFirstperson.StayOnGround(m);
            }
            else GenexFirstperson.SlideMove(m, m.H);
            // 10.
            GenexFirstperson.CheckGround(m);
            if (falling && !m.OnGround) m.VZ = m.VZ - m.Gravity * m.H * 0.5;
            else if (m.OnGround) m.VZ = 0;
            // 11.
            m.X = GenexFirstperson.Stored(m.X);
            m.Y = GenexFirstperson.Stored(m.Y);
            m.Z = GenexFirstperson.Stored(m.Z);
            m.VX = GenexFirstperson.Stored(m.VX);
            m.VY = GenexFirstperson.Stored(m.VY);
            m.VZ = GenexFirstperson.Stored(m.VZ);
            m.Spin = GenexFirstperson.Unsigned(F32(m.Spin));
            m.Fuel = GenexFirstperson.Unsigned(F32(m.Fuel));
        }

        /// <summary>
        /// One fixed <c>vehicle</c> step (§17.7) through <paramref name="world"/> (null: the empty world). Pure: returns
        /// the next body (x y z vx vy vz yaw spin fuel mstate); the body's <c>Cap</c> is read and returned unchanged.
        /// <paramref name="world"/> must be the world whose hash is <c>p.World</c> for the result to be the server's; the
        /// step does not compare them. A NaN input field is "unusable": an axis 0, buttons 0. <c>moveY</c> is the
        /// throttle (below 0 reverses) and <c>moveX</c> the steer: +1 turns right, toward -yaw.
        /// </summary>
        public static GenexVehicleBody Step(
            GenexVehicleBody body, double moveX, double moveY, double buttons, double dt, GenexVehicleParams p, GenexFirstpersonWorld world = null, GenexPosedWorld posed = null)
        {
            var w = (world ?? GenexFirstpersonWorld.Empty).Tables;
            var m = scratch ?? (scratch = new Car());
            m.Reset(w);
            m.P = posed ?? GenexPosedWorld.Empty;
            var height = F32(p.Height);
            m.R = F32(p.Radius);
            m.Unit = GenexFirstperson.UnitOf(m.R, 50.0);
            m.StandHeight = height;
            m.CrouchHeight = height;
            m.StepHeight = F32(p.StepHeight);
            m.Standable = F32(p.Standable);
            m.GroundTrace = F32(p.GroundTrace);
            m.GroundSnap = F32(p.GroundSnap);
            m.Skin = F32(p.Skin);
            m.MaxSpeed = F32(p.MaxSpeed);
            m.Accel = F32(p.Accel);
            m.Brake = F32(p.Brake);
            m.Coast = F32(p.Coast);
            m.BoostAccel = F32(p.BoostAccel);
            m.BoostMaxSpeed = F32(p.BoostMaxSpeed);
            m.BoostBurn = F32(p.BoostBurn);
            m.Grip = F32(p.Grip);
            m.DriftGrip = F32(p.DriftGrip);
            m.TurnRate = F32(p.TurnRate);
            m.TurnSpeed = F32(p.TurnSpeed);
            m.SpinAccel = F32(p.SpinAccel);
            m.AirTurnRate = F32(p.AirTurnRate);
            m.AirSpinAccel = F32(p.AirSpinAccel);
            m.Gravity = F32(p.Gravity);
            m.JumpImpulse = F32(p.JumpImpulse);
            m.MaxVelocity = F32(p.MaxVelocity);
            m.X = GenexFirstperson.BodyValue(body.X, 0, -MaxAbs, MaxAbs);
            m.Y = GenexFirstperson.BodyValue(body.Y, 0, -MaxAbs, MaxAbs);
            m.Z = GenexFirstperson.BodyValue(body.Z, 0, -MaxAbs, MaxAbs);
            m.VX = GenexFirstperson.BodyValue(body.VX, 0, -MaxAbs, MaxAbs);
            m.VY = GenexFirstperson.BodyValue(body.VY, 0, -MaxAbs, MaxAbs);
            m.VZ = GenexFirstperson.BodyValue(body.VZ, 0, -MaxAbs, MaxAbs);
            // 4. The yaw as read (float32, a non-finite one 0), wrapped; past ±1e9, 0.
            var readYaw = GenexFirstperson.BodyAngle(body.Yaw);
            m.Yaw = Math.Abs(readYaw) <= MaxAbs ? Wrap(readYaw) : 0;
            m.Spin = GenexFirstperson.BodyValue(body.Spin, 0, -MaxSpin, MaxSpin);
            m.Fuel = GenexFirstperson.BodyValue(body.Fuel, 0, 0, 1);
            m.Cap = GenexFirstperson.BodyValue(body.Cap, 1, 0, 4);
            m.Duck = 0;
            var mstate = (int)GenexPresets.Mask(body.Mstate) & MstateBits;
            m.OnGround = (mstate & OnGround) != 0;
            m.JumpHeld = (mstate & JumpHeld) != 0;
            m.Pressed = false;
            m.Boosting = false;
            m.C = 1;
            m.S = 0;
            m.F = 0;
            m.L = 0;
            // 1. Steer is -moveX (positive turns toward +yaw), negated after the sanitizing; neither axis is normalized
            // against the other.
            m.Steer = GenexFirstperson.Unsigned(-GenexPresets.Axis(moveX));
            m.Throttle = GenexPresets.Axis(moveY);
            // 2.
            var held = (int)GenexPresets.Mask(buttons);
            var jump = (held & p.JumpBit) != 0;
            m.Boost = (held & p.BoostBit) != 0;
            m.Drift = (held & p.DriftBit) != 0;
            // 3.
            var step = GenexPresets.StepSeconds(dt, GenexPresets.MaxDtSeconds);
            var substeps = p.Substeps < 1 ? 1 : p.Substeps;
            m.H = step / substeps;
            // 5. The jump edge, once per input, then the sub-steps.
            if (step > 0)
            {
                m.Pressed = jump && !m.JumpHeld && (p.CapZeroJump != 0 || m.Cap != 0);
                m.JumpHeld = jump;
                for (var i = 0; i < substeps; i++) SubStep(m);
            }
            // 6.
            var result = new GenexVehicleBody
            {
                X = m.X, Y = m.Y, Z = m.Z, VX = m.VX, VY = m.VY, VZ = m.VZ, Yaw = m.Yaw, Spin = m.Spin, Fuel = m.Fuel,
                Mstate = (m.OnGround ? OnGround : 0) + (m.JumpHeld ? JumpHeld : 0),
                Cap = m.Cap,
            };
            m.W = null;
            m.P = GenexPosedWorld.Empty;
            return result;
        }

        /// <summary>One fixed step under a (sanitized) input: moveX the steer, moveY the throttle, buttons.</summary>
        public static GenexVehicleBody Step(GenexVehicleBody body, GenexInput input, double dt, GenexVehicleParams p, GenexFirstpersonWorld world = null, GenexPosedWorld posed = null) =>
            Step(body, input.MoveX, input.MoveY, input.Buttons, dt, p, world, posed);
    }
}
