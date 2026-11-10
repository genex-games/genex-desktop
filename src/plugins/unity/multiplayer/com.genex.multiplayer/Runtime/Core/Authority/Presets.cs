// Movement presets (PROTOCOL.md §17.7) and the number rules of the input sanitizer (§17.3), ported from
// packages/multiplayer/src/authority/{presets,numeric}.ts. The authority server moves an entity with the
// same step, so the reconciler's prediction matches it by construction.
//
// Determinism rules, as the TypeScript reference keeps them: double arithmetic in the order written
// there (C# evaluates left to right and, since .NET Core 3 / every IL2CPP target, without x87 excess
// precision), Math.Sqrt (correctly rounded) and never a hypot, and a float32 rounding (Fround, a
// (float) cast: IEEE round to nearest, ties to even, exactly Math.fround) on every value a step stores.
// Held bit for bit to packages/netcode-bench/conformance/authority/presets/topdown.json by
// Tests~/GenexSmoke `presets`. The `firstperson` step is in Firstperson.cs and the `vehicle` step in Vehicle.cs (with
// the portable sine and cosine here, PSinCos); PredictionFor names any of them.
// Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;
using Genex.Multiplayer.Authority.Wire;

namespace Genex.Multiplayer.Authority
{
    /// <summary>The body a <c>topdown</c> step reads and writes.</summary>
    public struct TopdownBody
    {
        public double X;
        public double Y;
        /// <summary>Aim, radians.</summary>
        public double Yaw;
    }

    /// <summary><c>topdown</c> parameters.</summary>
    public struct TopdownParams
    {
        /// <summary>Movement speed, world units per second.</summary>
        public double Speed;
        /// <summary>Half the arena's side: x and y stay within [-Arena, Arena].</summary>
        public double Arena;
    }

    /// <summary>
    /// The own-entity fields a prediction step may read and write: the pose and velocity always, firstperson's
    /// <c>pitch</c>, <c>duck</c>, <c>mstate</c> and <c>cap</c>, and vehicle's <c>spin</c> and <c>fuel</c>, when the
    /// prediction lists them in its fields.
    /// </summary>
    public sealed class GenexPredictedBody
    {
        public double X, Y, Z, VX, VY, VZ, Yaw;
        public double Pitch, Duck, Mstate;
        /// <summary>A vehicle's yaw rate (rad/s, positive toward +yaw) and boost fuel ([0, 1]).</summary>
        public double Spin, Fuel;
        /// <summary>Read only: the speed multiplier the module writes (default 1).</summary>
        public double Cap = 1;
    }

    /// <summary>
    /// A game's own prediction step: advance <c>body</c> by one fixed step of <c>dt</c> seconds under
    /// <c>input</c> (already sanitized like the server's). It must be the step the room module runs.
    /// </summary>
    public delegate void GenexPredictionStep(GenexPredictedBody body, GenexInput input, double dt);

    /// <summary>How the own entity is predicted: a step, mirroring <see cref="Fields"/>.</summary>
    public sealed class GenexPrediction
    {
        /// <summary>What a custom prediction mirrors when it names no fields, in schema order.</summary>
        public static readonly string[] AllFields = { "x", "y", "z", "vx", "vy", "vz", "yaw" };
        /// <summary>Every field a prediction may mirror (firstperson's and vehicle's included), in schema order.</summary>
        public static readonly string[] Mirrorable = { "x", "y", "z", "vx", "vy", "vz", "yaw", "pitch", "duck", "mstate", "cap", "spin", "fuel" };

        public GenexPredictionStep Step;
        /// <summary>The entity fields the step writes (schema names). Null: all of <see cref="AllFields"/>.</summary>
        public string[] Fields;
    }

    public static class GenexPresets
    {
        /// <summary>The <c>topdown</c> preset's name. Preset names are append-only.</summary>
        public const string Topdown = "topdown";
        /// <summary>The <c>firstperson</c> preset's name (Firstperson.cs).</summary>
        public const string Firstperson = GenexFirstperson.Name;
        /// <summary>The fields a firstperson prediction mirrors: what its step writes, and <c>cap</c>, which it only reads
        /// (mirrored so a replay steps with the server's value).</summary>
        public static readonly string[] FirstpersonFields = { "x", "y", "z", "vx", "vy", "vz", "yaw", "pitch", "duck", "mstate", "cap" };
        /// <summary>The <c>vehicle</c> preset's name (Vehicle.cs).</summary>
        public const string Vehicle = GenexVehicle.Name;
        /// <summary>The fields a vehicle prediction mirrors: what its step writes (the heading, yaw rate and fuel are body
        /// state), and <c>cap</c>, which it only reads.</summary>
        public static readonly string[] VehicleFields = { "x", "y", "z", "vx", "vy", "vz", "yaw", "mstate", "cap", "spin", "fuel" };

        /// <summary>The longest step a preset simulates (seconds); a longer dt is cut to it.</summary>
        public const double MaxDtSeconds = 0.25;
        /// <summary>Largest magnitude an authority number may carry; past it an angle is unusable.</summary>
        public const double MaxAbs = 1e9;
        /// <summary>A bitmask (<c>buttons</c>, <c>flags</c>) is an integer in [0, 2^24).</summary>
        public const double MaskLimit = 16777216;

        public static readonly TopdownParams TopdownDefaults = new TopdownParams { Speed = 6, Arena = 20 };

        private const double TwoPi = 2 * Math.PI;
        /// <summary>π as float32: just above π, so a wrapped angle just below π rounds up to it.</summary>
        private static readonly double F32Pi = Fround(Math.PI);

        private struct Range
        {
            public double Min, Max;
            public bool Positive;
        }

        private static readonly Dictionary<string, Range> TopdownRange = new Dictionary<string, Range>
        {
            ["speed"] = new Range { Min = 0, Max = 1000, Positive = false },
            ["arena"] = new Range { Min = 0, Max = 1e6, Positive = true },
        };

        /// <summary><paramref name="v"/> rounded to float32 and read back (Math.fround).</summary>
        public static double Fround(double v) => (float)v;

        /// <summary>-0 reads as 0, so an unchanged value never re-sends.</summary>
        public static double UnsignedZero(double v) => v == 0 ? 0 : v;

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        /// <summary>A move axis: non-finite → 0, clamped to [-1, 1], float32.</summary>
        public static double Axis(double v)
        {
            if (!IsFinite(v)) return 0;
            return UnsignedZero(Fround(Clamp(v, -1, 1)));
        }

        /// <summary>
        /// An angle in radians wrapped to [-π, π), float32; null when it is not finite or past <see cref="MaxAbs"/>.
        /// A result that rounds to float32(π) is written as -float32(π), so one heading has one wire value.
        /// </summary>
        public static double? WrappedAngle(double v)
        {
            if (!IsFinite(v) || Math.Abs(v) > MaxAbs) return null;
            var wrapped = Fround(v - TwoPi * Math.Floor((v + Math.PI) / TwoPi));
            return wrapped == F32Pi ? -F32Pi : UnsignedZero(wrapped);
        }

        /// <summary>A bitmask: an integer in [0, 2^24), else 0.</summary>
        public static double Mask(double v) => IsFinite(v) && v == Math.Floor(v) && v >= 0 && v < MaskLimit ? UnsignedZero(v) : 0;

        /// <summary>A step length in seconds: non-finite or ≤ 0 → 0, capped at <paramref name="max"/>.</summary>
        public static double StepSeconds(double v, double max)
        {
            if (!IsFinite(v) || v <= 0) return 0;
            return v > max ? max : v;
        }

        /// <summary><paramref name="v"/> clamped to [lo, hi] (numeric.ts <c>clamp</c>; never throws on lo > hi).</summary>
        public static double Clamp(double v, double lo, double hi) => v < lo ? lo : v > hi ? hi : v;

        // ---- portable sine and cosine (§17.7) ----
        //
        // Cody–Waite reduction by π/2 with fdlibm's three-part split of π/2 (e_rem_pio2.c), then fdlibm's sine and
        // cosine kernels (k_sin.c; k_cos.c in FreeBSD msun's form) in Horner form with the tail argument dropped: plain
        // double + - *, Math.Floor and one exact division by 4, evaluated in the order written (C# is left to right; no
        // fused multiply-add, see the README for IL2CPP), so the result is the same bits in every engine. Math.Sin and
        // Math.Cos are not (they differ in the last bit between .NET, Mono, V8 and C libraries). Each constant is built
        // from its bits (§17.7's table): Unity's Mono double.Parse is not correctly rounded, and the bits leave nothing
        // to a parser. Held bit for bit to conformance/authority/presets/sincos.json by Tests~/GenexSmoke `presets`.

        private static double Bits(long bits) => BitConverter.Int64BitsToDouble(bits);

        /// <summary>§17.7's constants, from the bits its table states.</summary>
        private static readonly double InvPio2 = Bits(0x3FE45F306DC9C883);
        private static readonly double Pio2_1 = Bits(0x3FF921FB54400000);
        private static readonly double Pio2_2 = Bits(0x3DD0B4611A600000);
        private static readonly double Pio2_2t = Bits(0x3BA3198A2E037073);
        private static readonly double S1 = Bits(unchecked((long)0xBFC5555555555549));
        private static readonly double S2 = Bits(0x3F8111111110F8A6);
        private static readonly double S3 = Bits(unchecked((long)0xBF2A01A019C161D5));
        private static readonly double S4 = Bits(0x3EC71DE357B1FE7D);
        private static readonly double S5 = Bits(unchecked((long)0xBE5AE5E68A2B9CEB));
        private static readonly double S6 = Bits(0x3DE5D93A5ACFD57C);
        private static readonly double C1 = Bits(0x3FA555555555554C);
        private static readonly double C2 = Bits(unchecked((long)0xBF56C16C16C15177));
        private static readonly double C3 = Bits(0x3EFA01A019CB1590);
        private static readonly double C4 = Bits(unchecked((long)0xBE927E4F809C52AD));
        private static readonly double C5 = Bits(0x3E21EE9EBDB4B1C4);
        private static readonly double C6 = Bits(unchecked((long)0xBDA8FAE9BE8838D4));

        /// <summary>§17.7's constants by name (<c>invpio2</c>, <c>pio2_1</c> … <c>C6</c>), for the checks that pin their bits.</summary>
        public static readonly IReadOnlyDictionary<string, double> SincosConstants = new Dictionary<string, double>
        {
            ["invpio2"] = InvPio2, ["pio2_1"] = Pio2_1, ["pio2_2"] = Pio2_2, ["pio2_2t"] = Pio2_2t,
            ["S1"] = S1, ["S2"] = S2, ["S3"] = S3, ["S4"] = S4, ["S5"] = S5, ["S6"] = S6,
            ["C1"] = C1, ["C2"] = C2, ["C3"] = C3, ["C4"] = C4, ["C5"] = C5, ["C6"] = C6,
        };

        /// <summary>
        /// The portable sine and cosine of <paramref name="a"/> in one reduction (§17.7's steps 1–7): the same bits in
        /// every engine. A non-finite angle, or one past ±1e9, is read as 0 (sine 0, cosine 1).
        /// </summary>
        public static void PSinCos(double a, out double sin, out double cos)
        {
            // 1. An angle that cannot be used is read as 0.
            if (!IsFinite(a) || Math.Abs(a) > MaxAbs)
            {
                sin = 0;
                cos = 1;
                return;
            }
            // 2–4. The quadrant and the reduced argument.
            var scaled = a * InvPio2;
            var n = Math.Floor(scaled + 0.5);
            var quarter = Math.Floor(n / 4);
            var q = n - 4 * quarter;
            var r1 = a - n * Pio2_1;
            var r2 = r1 - n * Pio2_2;
            var r = r2 - n * Pio2_2t;
            // 5. The kernels, Horner form, written one operation at a time in §17.7's order.
            var z = r * r;
            var ps = S5 + z * S6;
            ps = S4 + z * ps;
            ps = S3 + z * ps;
            ps = S2 + z * ps;
            ps = S1 + z * ps;
            var zr = z * r;
            var ks = r + zr * ps;
            var pc = C5 + z * C6;
            pc = C4 + z * pc;
            pc = C3 + z * pc;
            pc = C2 + z * pc;
            pc = C1 + z * pc;
            var hz = 0.5 * z;
            var w = 1 - hz;
            var tail = 1 - w - hz;
            var kc = w + (tail + z * (z * pc));
            // 6–7. By quadrant, -0 as 0.
            if (q == 0)
            {
                sin = UnsignedZero(ks);
                cos = UnsignedZero(kc);
            }
            else if (q == 1)
            {
                sin = UnsignedZero(kc);
                cos = UnsignedZero(-ks);
            }
            else if (q == 2)
            {
                sin = UnsignedZero(-ks);
                cos = UnsignedZero(-kc);
            }
            else
            {
                sin = UnsignedZero(-kc);
                cos = UnsignedZero(ks);
            }
        }

        /// <summary>The portable sine of a float64 angle (§17.7): the same bits in every engine.</summary>
        public static double PSin(double a)
        {
            PSinCos(a, out var s, out _);
            return s;
        }

        /// <summary>The portable cosine of a float64 angle (§17.7): the same bits in every engine.</summary>
        public static double PCos(double a)
        {
            PSinCos(a, out _, out var c);
            return c;
        }

        /// <summary>
        /// Whether <paramref name="parameters"/> is acceptable for topdown: null, or a JSON object (GenexJson
        /// model) whose every key is a topdown parameter with a finite number in its range.
        /// </summary>
        public static bool TopdownParamsValid(object parameters)
        {
            if (parameters == null) return true;
            if (!(parameters is IDictionary<string, object> map)) return false;
            foreach (var kv in map)
            {
                if (!TopdownRange.TryGetValue(kv.Key, out var range)) return false;
                if (!InRange(kv.Value, range)) return false;
            }
            return true;
        }

        private static bool InRange(object value, Range range)
        {
            if (!(value is double v) || !IsFinite(v) || v < range.Min || v > range.Max) return false;
            // As the reference's presetParamsValid: a range that excludes 0 excludes a value whose float32 is 0.
            return !range.Positive || (v > 0 && (float)v > 0);
        }

        /// <summary>topdown parameters from a room's <c>preset.params</c>: defaults for anything unset or invalid.</summary>
        public static TopdownParams ResolveTopdownParams(object parameters)
        {
            var output = TopdownDefaults;
            if (!(parameters is IDictionary<string, object> map)) return output;
            if (map.TryGetValue("speed", out var speed) && InRange(speed, TopdownRange["speed"])) output.Speed = (double)speed;
            if (map.TryGetValue("arena", out var arena) && InRange(arena, TopdownRange["arena"])) output.Arena = (double)arena;
            return output;
        }

        private static double FiniteOrZero(double v) => IsFinite(v) ? v : 0;

        /// <summary>
        /// One fixed topdown step. Pure: returns the next body. A NaN input field means "unusable", like an
        /// absent one in the TypeScript reference.
        /// <list type="bullet">
        /// <item>moveX, moveY: non-finite → 0, clamped to [-1, 1], float32; a vector longer than 1 is scaled to 1;</item>
        /// <item>dt: non-finite or ≤ 0 → 0, capped at <see cref="MaxDtSeconds"/>;</item>
        /// <item>x' = fround(clamp(x + moveX * scale * speed * dt, -arena, arena)), y' likewise;</item>
        /// <item>yaw' = the input yaw wrapped to [-π, π) as float32, or the previous yaw when it is not usable.</item>
        /// </list>
        /// </summary>
        public static TopdownBody StepTopdown(TopdownBody body, double moveX, double moveY, double yaw, double dt, TopdownParams p)
        {
            var mx = Axis(moveX);
            var my = Axis(moveY);
            var step = StepSeconds(dt, MaxDtSeconds);
            var length = Math.Sqrt(mx * mx + my * my);
            var scale = length > 1 ? 1 / length : 1;
            var x = FiniteOrZero(body.X) + mx * scale * p.Speed * step;
            var y = FiniteOrZero(body.Y) + my * scale * p.Speed * step;
            return new TopdownBody
            {
                X = UnsignedZero(Fround(Clamp(x, -p.Arena, p.Arena))),
                Y = UnsignedZero(Fround(Clamp(y, -p.Arena, p.Arena))),
                Yaw = WrappedAngle(yaw) ?? UnsignedZero(Fround(FiniteOrZero(body.Yaw))),
            };
        }

        /// <summary>One fixed topdown step under a (sanitized) input.</summary>
        public static TopdownBody StepTopdown(TopdownBody body, GenexInput input, double dt, TopdownParams p) =>
            StepTopdown(body, input.MoveX, input.MoveY, input.Yaw, dt, p);

        /// <summary>
        /// The prediction a room's <c>preset</c> text (<c>{"name":…,"params":{…}}</c>) names, or null when the room
        /// runs no preset this port knows: the own entity is then drawn from the server's state, unpredicted. A
        /// <c>firstperson</c> room is predicted through the empty world only: pass the room module's world with the
        /// other overload.
        /// </summary>
        public static GenexPrediction PredictionFor(string presetText) => PredictionFor(presetText, GenexFirstpersonWorld.Empty, out _);

        /// <summary>
        /// As <see cref="PredictionFor(string)"/>, with the collision world a <c>firstperson</c> or <c>vehicle</c> room steps
        /// through: null unless <paramref name="world"/>'s hash is the room's <c>params.world</c> (§17.7).
        /// </summary>
        public static GenexPrediction PredictionFor(string presetText, GenexFirstpersonWorld world) => PredictionFor(presetText, world, out _);

        /// <summary>
        /// The prediction, and why there is none: <c>"no_preset"</c> (no preset this port knows) or
        /// <c>"world_mismatch"</c> (a firstperson or vehicle room whose world is not <paramref name="world"/>).
        /// </summary>
        public static GenexPrediction PredictionFor(string presetText, GenexFirstpersonWorld world, out string reason)
        {
            reason = "no_preset";
            var spec = string.IsNullOrEmpty(presetText) ? null : GenexJson.ParseObject(presetText);
            if (spec == null) return null;
            var name = GenexJson.Str(spec, "name");
            spec.TryGetValue("params", out var raw);
            if (name == Topdown)
            {
                reason = "";
                var parameters = ResolveTopdownParams(raw);
                return new GenexPrediction
                {
                    Fields = new[] { "x", "y", "yaw" },
                    Step = (body, input, dt) =>
                    {
                        var next = StepTopdown(new TopdownBody { X = body.X, Y = body.Y, Yaw = body.Yaw }, input, dt, parameters);
                        body.X = next.X;
                        body.Y = next.Y;
                        body.Yaw = next.Yaw;
                    },
                };
            }
            var w = world ?? GenexFirstpersonWorld.Empty;
            if (name == Vehicle)
            {
                var car = GenexVehicle.ResolveParams(raw);
                if (w.Hash != car.World)
                {
                    reason = "world_mismatch";
                    return null;
                }
                reason = "";
                return new GenexPrediction
                {
                    Fields = VehicleFields,
                    Step = (body, input, dt) =>
                    {
                        var next = GenexVehicle.Step(new GenexVehicleBody
                        {
                            X = body.X, Y = body.Y, Z = body.Z, VX = body.VX, VY = body.VY, VZ = body.VZ,
                            Yaw = body.Yaw, Spin = body.Spin, Fuel = body.Fuel, Mstate = body.Mstate, Cap = body.Cap,
                        }, input, dt, car, w);
                        body.X = next.X;
                        body.Y = next.Y;
                        body.Z = next.Z;
                        body.VX = next.VX;
                        body.VY = next.VY;
                        body.VZ = next.VZ;
                        body.Yaw = next.Yaw;
                        body.Spin = next.Spin;
                        body.Fuel = next.Fuel;
                        body.Mstate = next.Mstate;
                    },
                };
            }
            if (name != Firstperson) return null;
            var p = GenexFirstperson.ResolveParams(raw);
            if (w.Hash != p.World)
            {
                reason = "world_mismatch";
                return null;
            }
            reason = "";
            return new GenexPrediction
            {
                Fields = FirstpersonFields,
                Step = (body, input, dt) =>
                {
                    var next = GenexFirstperson.Step(new GenexFirstpersonBody
                    {
                        X = body.X, Y = body.Y, Z = body.Z, VX = body.VX, VY = body.VY, VZ = body.VZ,
                        Yaw = body.Yaw, Pitch = body.Pitch, Duck = body.Duck, Mstate = body.Mstate, Cap = body.Cap,
                    }, input, dt, p, w);
                    body.X = next.X;
                    body.Y = next.Y;
                    body.Z = next.Z;
                    body.VX = next.VX;
                    body.VY = next.VY;
                    body.VZ = next.VZ;
                    body.Yaw = next.Yaw;
                    body.Pitch = next.Pitch;
                    body.Duck = next.Duck;
                    body.Mstate = next.Mstate;
                },
            };
        }

        /// <summary>The world a room's preset steps through (a firstperson or vehicle room's <c>params.world</c>), or null when it has none.</summary>
        public static uint? RoomWorld(string presetText)
        {
            var spec = string.IsNullOrEmpty(presetText) ? null : GenexJson.ParseObject(presetText);
            if (spec == null) return null;
            var name = GenexJson.Str(spec, "name");
            var raw = spec.TryGetValue("params", out var value) ? value : null;
            if (name == Firstperson) return GenexFirstperson.ResolveParams(raw).World;
            if (name == Vehicle) return GenexVehicle.ResolveParams(raw).World;
            return null;
        }

        /// <summary>The name of the preset a room runs (<c>""</c> for none).</summary>
        public static string PresetName(string presetText)
        {
            var spec = string.IsNullOrEmpty(presetText) ? null : GenexJson.ParseObject(presetText);
            return spec == null ? "" : GenexJson.Str(spec, "name") ?? "";
        }

        /// <summary>The pitch limit drawn pitches are held to: a firstperson room's float32 <c>pitchLimit</c>, else π.</summary>
        public static double PitchLimit(string presetText)
        {
            var spec = string.IsNullOrEmpty(presetText) ? null : GenexJson.ParseObject(presetText);
            if (spec == null || GenexJson.Str(spec, "name") != Firstperson) return Math.PI;
            return Fround(GenexFirstperson.ResolveParams(spec.TryGetValue("params", out var raw) ? raw : null).PitchLimit);
        }
    }
}
