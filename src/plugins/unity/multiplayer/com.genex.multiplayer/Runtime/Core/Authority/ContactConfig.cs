// `config.contacts` (PROTOCOL.md §17.11 *Contact policy*), a port of packages/multiplayer/src/authority/contact-config.ts: what
// a room module declares about how two seats in contact are handled, as data: the seats' contact shape, the genre preset whose
// table fills every setting the module leaves out, per-pair overrides by tag, how a client draws other seats and how a side
// push is split. `GenexContactConfig.Resolve` turns a declaration (parsed JSON: a map) into the resolved policy every SDK runs
// (ContactPolicy.cs), and refuses a bad one by the path of the first bad value, as §17.7's world and §17.10's physics request
// are refused. Held to contact-policy.json's `config` rows (GenexSmoke `contact-policy`). Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>What happens when one seat comes to rest on another's top.</summary>
    public enum GenexTopPolicy
    {
        /// <summary>Rest on the head: a landing stands within <c>center</c> of the lower's half width and slides off by <c>slide</c>
        /// elsewhere; a resting seat holds while its centre is over the footprint; <c>ride</c>: carried by the lower seat.</summary>
        Stand,
        /// <summary>Frictionless: the upper seat is slid off within a bounded time.</summary>
        Slide,
        /// <summary>A stomp: the upper seat bounces off, and the module hears it.</summary>
        Bounce,
        /// <summary>No collision at all.</summary>
        Ghost,
    }

    /// <summary>A seat's contact shape: a box turned with its heading and laid on its support up, or an upright square hull.</summary>
    public enum GenexContactShapeKind { Box, Hull }

    /// <summary>How a side contact's push is split: half each (<c>shared</c>) or by each seat's own closing speed (<c>mover</c>).</summary>
    public enum GenexContactPush { Shared, Mover }

    /// <summary>A seat's contact shape, room units: a box's length along the heading, width across it and top above the base; a
    /// hull's half side and height.</summary>
    public sealed class GenexContactShape
    {
        public GenexContactShapeKind Kind;
        public double Length, Width, Top, Radius, Height;
    }

    /// <summary>A slide: the parting brought up to <see cref="Speed"/> (units/s) by at most <see cref="Step"/> a tick,
    /// <see cref="Share"/> of it on the upper seat. A null step: in one tick.</summary>
    public sealed class GenexSlideRule
    {
        public double Speed;
        public double? Step;
        public double Share;

        public GenexSlideRule(double speed, double? step, double share)
        {
            Speed = speed;
            Step = step;
            Share = share;
        }
    }

    /// <summary>A resolved top rule: for <c>slide</c> its slide; for <c>bounce</c> its stomp numbers and the slide a bounce under
    /// <see cref="StompMin"/> closing speed falls back to.</summary>
    public sealed class GenexTopRule
    {
        public GenexTopPolicy Policy;
        public GenexSlideRule Slide;
        public double StompMin, BounceSpeed, JumpBoost;
        /// <summary>A <c>stand</c>'s: carried by the lower seat when set; a landing stands only within <see cref="Center"/> times the
        /// lower's half width (null: anywhere it touches), else slides by <see cref="Slide"/>.</summary>
        public bool Ride;
        public double? Center;
    }

    /// <summary>A prop's slide off a head: its parting brought up to <see cref="Speed"/> (u/s) by at most <see cref="Step"/> a tick.</summary>
    public sealed class GenexPropSlide
    {
        public double Speed, Step;

        public GenexPropSlide(double speed, double step)
        {
            Speed = speed;
            Step = step;
        }
    }

    /// <summary>A per-pair override: two seats, one carrying tag <see cref="A"/> and the other <see cref="B"/>, use <see cref="Top"/>.</summary>
    public sealed class GenexPairRule
    {
        public string A, B;
        public GenexTopRule Top;
    }

    /// <summary>The resolved policy: every setting filled (from the module, else its preset's table).</summary>
    public sealed class GenexContactPolicy
    {
        public string Preset;
        public GenexContactShape Shape;
        /// <summary>The hull the static world is grown by (the movement preset's radius and height) and its skin.</summary>
        public double HullRadius, HullHeight, HullSkin;
        /// <summary>How far under a base the support surface is found (the preset's <c>groundTrace</c>).</summary>
        public double GroundTrace;
        /// <summary>A contact whose normal is at least this close to the lower seat's support up is a top contact; a lower seat
        /// whose support up's z is under it cannot be stood on.</summary>
        public double SupportCos;
        /// <summary>The least closing speed of an axis in the entry-time test (units/s).</summary>
        public double EntrySpeed;
        /// <summary>How recently a pair must have come down across the plane for the across axis to be its contact axis (s).</summary>
        public double EntryWindow;
        public double Restitution;
        public int Passes;
        public double Slop;
        public double RoofSkin;
        /// <summary>Each velocity axis a contact writes is clamped to ±this; null: not clamped.</summary>
        public double? MaxVelocity;
        public bool StopSpin;
        public GenexTopRule Top;
        /// <summary>The slide a top contact becomes when the lower seat's support cannot be stood on.</summary>
        public GenexSlideRule OffWall;
        public List<GenexPairRule> Pairs = new List<GenexPairRule>();
        /// <summary>How a client draws other seats when the game gives no <c>seatDrawing</c>: <c>predicted</c>, <c>separate</c> or <c>timeline</c>.</summary>
        public string Drawing;
        public GenexContactPush Push;
        /// <summary>How a prop on a seat's top is treated: <c>slide</c> off or <c>carry</c> (rest while level).</summary>
        public string HeadFriction;
        public GenexPropSlide PropSlide;
    }

    /// <summary>A refused <c>config.contacts</c>: the path of the first bad value.</summary>
    public sealed class GenexContactConfigException : Exception
    {
        public string Path { get; }

        public GenexContactConfigException(string path) : base(path) => Path = path;
    }

    /// <summary>The movement preset the seats step with, as the contact policy reads it: its name and numeric params.</summary>
    public sealed class GenexContactPresetParams
    {
        public string Name;
        public IDictionary<string, double> Params = new Dictionary<string, double>();

        public GenexContactPresetParams(string name, IDictionary<string, double> values)
        {
            Name = name;
            if (values != null) Params = values;
        }

        public bool TryGet(string key, out double v) => Params.TryGetValue(key, out v);

        /// <summary>The param, else <paramref name="fallback"/> (the TypeScript's <c>p.key ?? fallback</c>).</summary>
        public double Get(string key, double fallback = 0) => Params.TryGetValue(key, out var v) ? v : fallback;
    }

    /// <summary>Resolves <c>config.contacts</c> (contact-config.ts <c>resolveContactConfig</c>).</summary>
    public static class GenexContactConfig
    {
        /// <summary>Per-pair overrides a module may declare at most, and a tag's length at most.</summary>
        public const int PairsMax = 32, TagMax = 64;
        /// <summary>Pile passes a module may ask for at most; every length and speed at most (units, units/s).</summary>
        public const int PassesMax = 64;
        public const double ValueMax = 100000;

        private static readonly GenexSlideRule CharacterSlide = new GenexSlideRule(300, 150, 1);
        private static readonly GenexSlideRule VehicleSlide = new GenexSlideRule(950, 480, 1);
        private static readonly GenexSlideRule ArenaOffWall = new GenexSlideRule(600, null, 0.5);

        private static GenexTopRule SlideTop(GenexSlideRule s) => new GenexTopRule { Policy = GenexTopPolicy.Slide, Slide = Copy(s) };

        private static GenexTopRule Stand(bool ride, double? center, GenexSlideRule s) => new GenexTopRule { Policy = GenexTopPolicy.Stand, Ride = ride, Center = center, Slide = s };
        /// <summary>The share of a head's half width a shooter's landing stands within (0.25, owner 2026-11-02).</summary>
        public const double ShooterCenter = 0.25;
        private static readonly GenexPropSlide DefaultPropSlide = new GenexPropSlide(300, 150);
        private static readonly GenexTopRule Stomp = new GenexTopRule { Policy = GenexTopPolicy.Bounce, StompMin = 150, BounceSpeed = 450, JumpBoost = 150, Slide = CharacterSlide };

        private static GenexSlideRule Copy(GenexSlideRule s) => new GenexSlideRule(s.Speed, s.Step, s.Share);

        /// <summary>One preset's table: the top rule by seat shape, the side restitution and the passes.</summary>
        private sealed class Table
        {
            public GenexTopRule Character, Vehicle;
            public double Restitution;
            public int Passes;
            public GenexSlideRule VehicleOffWall;
            public bool StopSpin;
            public string Drawing;
            public GenexContactPush Push;
            public string HeadFriction;
        }

        private static readonly Dictionary<string, Table> Presets = new Dictionary<string, Table>
        {
            ["shooter"] = new Table { Character = Stand(false, ShooterCenter, CharacterSlide), Vehicle = SlideTop(VehicleSlide), Restitution = 0, Passes = 16, VehicleOffWall = VehicleSlide, StopSpin = false, Drawing = "separate", Push = GenexContactPush.Mover, HeadFriction = "slide" },
            ["platformer"] = new Table { Character = Stand(true, null, CharacterSlide), Vehicle = SlideTop(VehicleSlide), Restitution = 0, Passes = 16, VehicleOffWall = VehicleSlide, StopSpin = false, Drawing = "separate", Push = GenexContactPush.Mover, HeadFriction = "slide" },
            ["vehicle-arena"] = new Table { Character = SlideTop(CharacterSlide), Vehicle = SlideTop(VehicleSlide), Restitution = 0.6, Passes = 32, VehicleOffWall = ArenaOffWall, StopSpin = true, Drawing = "predicted", Push = GenexContactPush.Shared, HeadFriction = "carry" },
            ["physics-sandbox"] = new Table { Character = Stand(true, null, CharacterSlide), Vehicle = Stand(true, null, VehicleSlide), Restitution = 0.2, Passes = 16, VehicleOffWall = VehicleSlide, StopSpin = false, Drawing = "separate", Push = GenexContactPush.Shared, HeadFriction = "carry" },
            ["party"] = new Table { Character = Stand(true, null, CharacterSlide), Vehicle = SlideTop(VehicleSlide), Restitution = 0.3, Passes = 16, VehicleOffWall = VehicleSlide, StopSpin = false, Drawing = "separate", Push = GenexContactPush.Shared, HeadFriction = "slide" },
        };

        /// <summary>The settings every preset shares (the preset table's SUPPORT_COS and PILE_SLOP rows).</summary>
        public const double DefaultSupportCos = 0.7, DefaultEntrySpeed = 1, DefaultEntryWindow = 1.0 / 60, DefaultSlop = 0.1, DefaultRoofSkin = 0.01;

        private static readonly string[] Keys =
        {
            "preset", "shape", "top", "offWall", "restitution", "passes", "slop", "supportCos", "entrySpeed", "entryWindow", "roofSkin", "maxVelocity",
            "stopSpin", "pairs", "drawing", "push", "headFriction", "propSlide",
        };
        private static readonly string[] SlideKeys = { "speed", "step", "share" };
        private static readonly string[] PairKeys = { "a", "b", "top" };
        private static readonly string[] BoxKeys = { "kind", "length", "width", "top" };
        private static readonly string[] HullKeys = { "kind", "radius", "height" };
        private static readonly string[] Drawings = { "predicted", "separate", "timeline" };

        private static string[] TopKeys(string policy) => policy switch
        {
            "stand" => new[] { "policy", "ride", "center", "slide" },
            "ghost" => new[] { "policy" },
            "slide" => new[] { "policy", "speed", "step", "share" },
            "bounce" => new[] { "policy", "stompMin", "bounceSpeed", "jumpBoost" },
            _ => null,
        };

        private static bool IsRecord(object v) => v is Dictionary<string, object>;

        private static bool Has(Dictionary<string, object> o, string k) => o.ContainsKey(k);

        /// <summary>Refuses the first key of o outside keys.</summary>
        private static void OnlyKeys(Dictionary<string, object> o, string[] keys, string path)
        {
            foreach (var k in o.Keys)
            {
                if (Array.IndexOf(keys, k) < 0) throw new GenexContactConfigException(path + "." + k);
            }
        }

        /// <summary>A number in [lo, hi] (<paramref name="open"/>: above lo), or the default when absent.</summary>
        private static double Num(Dictionary<string, object> o, string key, string path, double fallback, double lo, double hi, bool open = false)
        {
            if (!Has(o, key)) return fallback;
            if (!(o[key] is double v) || double.IsNaN(v) || double.IsInfinity(v) || !(open ? v > lo : v >= lo) || v > hi) throw new GenexContactConfigException(path + "." + key);
            return v;
        }

        /// <summary>A slide's settings over <paramref name="b"/>.</summary>
        private static GenexSlideRule SlideOf(object v, string path, GenexSlideRule b, string[] keys)
        {
            if (!(v is Dictionary<string, object> o)) throw new GenexContactConfigException(path);
            OnlyKeys(o, keys, path);
            var speed = Num(o, "speed", path, b.Speed, 0, ValueMax);
            // A step of null is at once; absent it is the base's; else a number above 0.
            double? step = b.Step;
            if (Has(o, "step") && o["step"] == null) step = null;
            else if (Has(o, "step")) step = Num(o, "step", path, 0, 0, ValueMax, true);
            return new GenexSlideRule(speed, step, Num(o, "share", path, b.Share, 0, 1));
        }

        /// <summary>The default slide a bounce falls back to and an explicit slide starts from, by shape.</summary>
        private static GenexSlideRule BaseSlide(GenexTopRule top, bool vehicle)
        {
            if (top.Policy == GenexTopPolicy.Slide) return Copy(top.Slide);
            if (top.Policy == GenexTopPolicy.Bounce || top.Policy == GenexTopPolicy.Stand) return top.Slide;
            return vehicle ? VehicleSlide : CharacterSlide;
        }

        private static readonly string[] PropSlideKeys = { "speed", "step" };

        /// <summary>A stand as the module gives it: each cell it leaves out from the preset's stand (<paramref name="b"/>), else ride,
        /// anywhere, and the shape's slide. <c>center</c> is in (0, 1] or null.</summary>
        private static GenexTopRule StandOf(Dictionary<string, object> o, string path, GenexTopRule b, bool vehicle)
        {
            var from = b.Policy == GenexTopPolicy.Stand ? b : Stand(true, null, BaseSlide(b, vehicle));
            if (Has(o, "ride") && !(o["ride"] is bool)) throw new GenexContactConfigException(path + ".ride");
            var ride = Has(o, "ride") ? (bool)o["ride"] : from.Ride;
            double? center;
            if (!Has(o, "center")) center = from.Center;
            else if (o["center"] == null) center = null;
            else center = Num(o, "center", path, 1, 0, 1, true);
            var slide = Has(o, "slide") ? SlideOf(o["slide"], path + ".slide", from.Slide, SlideKeys) : from.Slide;
            return Stand(ride, center, slide);
        }

        /// <summary>A top rule as the module gives it, over the preset's <paramref name="b"/> for this shape.</summary>
        private static GenexTopRule TopOf(object v, string path, GenexTopRule b, bool vehicle)
        {
            if (!(v is Dictionary<string, object> o)) throw new GenexContactConfigException(path);
            var policy = o.TryGetValue("policy", out var pv) ? pv as string : null;
            var keys = policy == null ? null : TopKeys(policy);
            if (keys == null) throw new GenexContactConfigException(path + ".policy");
            OnlyKeys(o, keys, path);
            if (policy == "stand") return StandOf(o, path, b, vehicle);
            if (policy == "ghost") return new GenexTopRule { Policy = GenexTopPolicy.Ghost };
            if (policy == "slide") return new GenexTopRule { Policy = GenexTopPolicy.Slide, Slide = SlideOf(o, path, BaseSlide(b, vehicle), keys) };
            var stomp = b.Policy == GenexTopPolicy.Bounce ? b : Stomp;
            return new GenexTopRule
            {
                Policy = GenexTopPolicy.Bounce,
                StompMin = Num(o, "stompMin", path, stomp.StompMin, 0, ValueMax),
                BounceSpeed = Num(o, "bounceSpeed", path, stomp.BounceSpeed, 0, ValueMax),
                JumpBoost = Num(o, "jumpBoost", path, stomp.JumpBoost, 0, ValueMax),
                Slide = BaseSlide(b, vehicle),
            };
        }

        /// <summary>The seats' contact shape: the module's, else the movement preset's hull (a box over a vehicle's).</summary>
        private static GenexContactShape ShapeOf(Dictionary<string, object> decl, string path, GenexContactPresetParams preset)
        {
            if (!decl.TryGetValue("shape", out var v))
            {
                if (preset.Name == "vehicle")
                {
                    return new GenexContactShape { Kind = GenexContactShapeKind.Box, Length = 2 * preset.Get("radius"), Width = 2 * preset.Get("radius"), Top = preset.Get("height") };
                }
                return new GenexContactShape { Kind = GenexContactShapeKind.Hull, Radius = preset.Get("radius"), Height = preset.TryGet("standHeight", out var sh) ? sh : preset.Get("height") };
            }
            if (!(v is Dictionary<string, object> o)) throw new GenexContactConfigException(path);
            var kind = o.TryGetValue("kind", out var kv) ? kv as string : null;
            if (kind == "box")
            {
                OnlyKeys(o, BoxKeys, path);
                var shape = new GenexContactShape { Kind = GenexContactShapeKind.Box, Length = Dim(o, "length", path), Width = Dim(o, "width", path), Top = Dim(o, "top", path) };
                return Required(shape, path, shape.Length, shape.Width, shape.Top, "length", "width", "top");
            }
            if (kind == "hull")
            {
                OnlyKeys(o, HullKeys, path);
                var shape = new GenexContactShape { Kind = GenexContactShapeKind.Hull, Radius = Dim(o, "radius", path), Height = Dim(o, "height", path) };
                return Required(shape, path, shape.Radius, shape.Height, 0, "radius", "height", null);
            }
            throw new GenexContactConfigException(path + ".kind");
        }

        /// <summary>A shape dimension in (0, ValueMax], NaN when absent (<see cref="Required"/> refuses it by its path).</summary>
        private static double Dim(Dictionary<string, object> o, string key, string path) => Num(o, key, path, double.NaN, 0, ValueMax, true);

        /// <summary>A missing shape dimension (NaN) is refused by its path, the first in order.</summary>
        private static GenexContactShape Required(GenexContactShape shape, string path, double d1, double d2, double d3, string k1, string k2, string k3)
        {
            if (double.IsNaN(d1)) throw new GenexContactConfigException(path + "." + k1);
            if (double.IsNaN(d2)) throw new GenexContactConfigException(path + "." + k2);
            if (k3 != null && double.IsNaN(d3)) throw new GenexContactConfigException(path + "." + k3);
            return shape;
        }

        /// <summary>The per-pair overrides.</summary>
        private static List<GenexPairRule> PairsOf(Dictionary<string, object> decl, string path, GenexTopRule b, bool vehicle)
        {
            var output = new List<GenexPairRule>();
            if (!decl.TryGetValue("pairs", out var v)) return output;
            if (!(v is List<object> list) || list.Count > PairsMax) throw new GenexContactConfigException(path);
            for (var i = 0; i < list.Count; i++)
            {
                var at = path + "[" + i + "]";
                if (!(list[i] is Dictionary<string, object> r)) throw new GenexContactConfigException(at);
                OnlyKeys(r, PairKeys, at);
                foreach (var k in new[] { "a", "b" })
                {
                    if (!(r.TryGetValue(k, out var tag) && tag is string s) || s.Length == 0 || s.Length > TagMax) throw new GenexContactConfigException(at + "." + k);
                }
                if (!r.TryGetValue("top", out var top)) throw new GenexContactConfigException(at + ".top");
                output.Add(new GenexPairRule { A = (string)r["a"], B = (string)r["b"], Top = TopOf(top, at + ".top", b, vehicle) });
            }
            return output;
        }

        /// <summary>
        /// <c>config.contacts</c> resolved against the room's movement preset: every setting the module gave, else the genre
        /// preset's. Throws <see cref="GenexContactConfigException"/> (the path from <paramref name="path"/>) for a value that is
        /// not an object, an unknown key, a preset or policy that does not exist, a number out of range, a shape without its
        /// dimensions, more than <see cref="PairsMax"/> pair rules, or a room whose movement preset steps through no world.
        /// </summary>
        public static GenexContactPolicy Resolve(object given, GenexContactPresetParams preset, string path = "$.config.contacts")
        {
            if (!(given is Dictionary<string, object> decl)) throw new GenexContactConfigException(path);
            OnlyKeys(decl, Keys, path);
            if (preset == null || (preset.Name != "firstperson" && preset.Name != "vehicle")) throw new GenexContactConfigException(path);
            if (!(decl.TryGetValue("preset", out var nameObj) && nameObj is string name && Presets.TryGetValue(name, out var table))) throw new GenexContactConfigException(path + ".preset");
            var shape = ShapeOf(decl, path + ".shape", preset);
            var vehicle = shape.Kind == GenexContactShapeKind.Box;
            var baseTop = vehicle ? table.Vehicle : table.Character;
            var top = decl.TryGetValue("top", out var declaredTop) ? TopOf(declaredTop, path + ".top", baseTop, vehicle) : baseTop;
            var offBase = vehicle ? table.VehicleOffWall : BaseSlide(baseTop, false);
            double? maxVelocity;
            if (Has(decl, "maxVelocity") && decl["maxVelocity"] == null) maxVelocity = null;
            else maxVelocity = Num(decl, "maxVelocity", path, preset.Get("maxVelocity", ValueMax), 0, ValueMax, true);
            if (Has(decl, "stopSpin") && !(decl["stopSpin"] is bool)) throw new GenexContactConfigException(path + ".stopSpin");
            var policy = new GenexContactPolicy
            {
                Preset = name,
                Shape = shape,
                HullRadius = preset.Get("radius"),
                HullHeight = preset.TryGet("standHeight", out var standHeight) ? standHeight : preset.Get("height"),
                HullSkin = preset.Get("skin"),
                GroundTrace = preset.Get("groundTrace"),
                SupportCos = Num(decl, "supportCos", path, DefaultSupportCos, 0, 1),
                EntrySpeed = Num(decl, "entrySpeed", path, DefaultEntrySpeed, 0, ValueMax, true),
                EntryWindow = Num(decl, "entryWindow", path, DefaultEntryWindow, 0, 1, true),
                Restitution = Num(decl, "restitution", path, table.Restitution, 0, 1),
                Passes = Passes(decl, path, table.Passes),
                Slop = Num(decl, "slop", path, DefaultSlop, 0, ValueMax),
                RoofSkin = Num(decl, "roofSkin", path, DefaultRoofSkin, 0, ValueMax),
                MaxVelocity = maxVelocity,
                StopSpin = Has(decl, "stopSpin") ? (bool)decl["stopSpin"] : table.StopSpin,
                Top = top,
            };
            policy.OffWall = decl.TryGetValue("offWall", out var declaredOff) ? SlideOf(declaredOff, path + ".offWall", offBase, SlideKeys) : offBase;
            policy.Pairs = PairsOf(decl, path + ".pairs", baseTop, vehicle);
            policy.Drawing = Choice(decl, "drawing", path, Drawings, table.Drawing);
            policy.Push = Push(decl, path, table.Push);
            policy.HeadFriction = HeadFrictionOf(decl, path, table.HeadFriction);
            policy.PropSlide = PropSlideOf(decl, path);
            return policy;
        }

        /// <summary>The declared <c>headFriction</c>, else the preset's.</summary>
        private static string HeadFrictionOf(Dictionary<string, object> o, string path, string fallback)
        {
            if (!Has(o, "headFriction")) return fallback;
            if (!(o["headFriction"] is string v) || (v != "slide" && v != "carry")) throw new GenexContactConfigException(path + ".headFriction");
            return v;
        }

        /// <summary>The declared <c>propSlide</c> over the default (speed >= 0, step above 0).</summary>
        private static GenexPropSlide PropSlideOf(Dictionary<string, object> o, string path)
        {
            if (!Has(o, "propSlide")) return DefaultPropSlide;
            var at = path + ".propSlide";
            if (!(o["propSlide"] is Dictionary<string, object> v)) throw new GenexContactConfigException(at);
            OnlyKeys(v, PropSlideKeys, at);
            return new GenexPropSlide(Num(v, "speed", at, DefaultPropSlide.Speed, 0, ValueMax), Num(v, "step", at, DefaultPropSlide.Step, 0, ValueMax, true));
        }

        /// <summary>The pile passes: an integer in [1, PassesMax].</summary>
        private static int Passes(Dictionary<string, object> o, string path, int fallback)
        {
            var n = Num(o, "passes", path, fallback, 1, PassesMax);
            if (n != Math.Floor(n)) throw new GenexContactConfigException(path + ".passes");
            return (int)n;
        }

        private static string Choice(Dictionary<string, object> o, string key, string path, string[] allowed, string fallback)
        {
            if (!Has(o, key)) return fallback;
            if (!(o[key] is string v) || Array.IndexOf(allowed, v) < 0) throw new GenexContactConfigException(path + "." + key);
            return v;
        }

        private static GenexContactPush Push(Dictionary<string, object> o, string path, GenexContactPush fallback)
        {
            if (!Has(o, "push")) return fallback;
            var v = o["push"] as string;
            if (v == "shared") return GenexContactPush.Shared;
            if (v == "mover") return GenexContactPush.Mover;
            throw new GenexContactConfigException(path + ".push");
        }

        // ---- the resolved policy as data (the conformance file's `resolved` shape) ----

        private static Dictionary<string, object> SlideJson(GenexSlideRule s) => new Dictionary<string, object>
        {
            ["speed"] = s.Speed, ["step"] = s.Step.HasValue ? (object)s.Step.Value : null, ["share"] = s.Share,
        };

        private static Dictionary<string, object> TopJson(GenexTopRule t)
        {
            switch (t.Policy)
            {
                case GenexTopPolicy.Stand:
                    return new Dictionary<string, object> { ["policy"] = "stand", ["ride"] = t.Ride, ["center"] = t.Center.HasValue ? (object)t.Center.Value : null, ["slide"] = SlideJson(t.Slide) };
                case GenexTopPolicy.Ghost: return new Dictionary<string, object> { ["policy"] = "ghost" };
                case GenexTopPolicy.Slide:
                    return new Dictionary<string, object> { ["policy"] = "slide", ["speed"] = t.Slide.Speed, ["step"] = t.Slide.Step.HasValue ? (object)t.Slide.Step.Value : null, ["share"] = t.Slide.Share };
                default:
                    return new Dictionary<string, object>
                    {
                        ["policy"] = "bounce", ["stompMin"] = t.StompMin, ["bounceSpeed"] = t.BounceSpeed, ["jumpBoost"] = t.JumpBoost, ["slide"] = SlideJson(t.Slide),
                    };
            }
        }

        /// <summary>
        /// The resolved policy a room's state carries (§17.11 *Contact policy*: the host resolves the module's declaration and
        /// publishes it as the <c>contacts</c> of the state's <c>preset</c> text, every field filled, as <see cref="ToJson"/> writes
        /// it), read field by field; null when <paramref name="given"/> is not one: not an object, a preset outside the table, a
        /// shape of neither kind, or any field missing or of the wrong type (contact-session.ts <c>isPolicy</c>, plus every field
        /// it then reads).
        /// </summary>
        public static GenexContactPolicy FromJson(object given)
        {
            if (!(given is IDictionary<string, object> o)) return null;
            if (!(o.TryGetValue("preset", out var preset) && preset is string name && Presets.ContainsKey(name))) return null;
            var shape = ShapeFrom(At(o, "shape"));
            var hull = At(o, "hull") as IDictionary<string, object>;
            var vehicle = shape != null && shape.Kind == GenexContactShapeKind.Box;
            var top = TopFrom(At(o, "top"), vehicle);
            var offWall = SlideFrom(At(o, "offWall"));
            var pairs = PairsFrom(At(o, "pairs"), vehicle);
            var drawing = At(o, "drawing") as string;
            var push = At(o, "push") as string;
            var parts = shape != null && hull != null && top != null && offWall != null && pairs != null;
            if (!parts || Array.IndexOf(Drawings, drawing) < 0 || (push != "shared" && push != "mover") || !(At(o, "stopSpin") is bool stopSpin)) return null;
            var mv = At(o, "maxVelocity");
            if (!(mv == null && o.ContainsKey("maxVelocity")) && !(mv is double)) return null;
            if (!(Number(hull, "radius", out var radius) && Number(hull, "height", out var height) && Number(hull, "skin", out var skin))) return null;
            var p = new GenexContactPolicy
            {
                Preset = name, Shape = shape, HullRadius = radius, HullHeight = height, HullSkin = skin, MaxVelocity = mv as double?, StopSpin = stopSpin,
                Top = top, OffWall = offWall, Pairs = pairs, Drawing = drawing, Push = push == "mover" ? GenexContactPush.Mover : GenexContactPush.Shared,
            };
            // Absent on an older host's policy: the preset's headFriction and the default prop slide.
            var friction = o.ContainsKey("headFriction") ? At(o, "headFriction") as string : Presets[name].HeadFriction;
            if (friction != "slide" && friction != "carry") return null;
            p.HeadFriction = friction;
            if (o.ContainsKey("propSlide"))
            {
                var prop = At(o, "propSlide") as IDictionary<string, object>;
                if (prop == null || !Number(prop, "speed", out var propSpeed) || !Number(prop, "step", out var propStep)) return null;
                p.PropSlide = new GenexPropSlide(propSpeed, propStep);
            }
            else p.PropSlide = new GenexPropSlide(DefaultPropSlide.Speed, DefaultPropSlide.Step);
            var plain = Number(o, "groundTrace", out p.GroundTrace) && Number(o, "supportCos", out p.SupportCos) && Number(o, "entrySpeed", out p.EntrySpeed)
                && Number(o, "entryWindow", out p.EntryWindow) && Number(o, "restitution", out p.Restitution) && Number(o, "slop", out p.Slop)
                && Number(o, "roofSkin", out p.RoofSkin);
            if (!plain || !Number(o, "passes", out var passes) || passes != Math.Floor(passes) || passes < int.MinValue || passes > int.MaxValue) return null;
            p.Passes = (int)passes;
            return p;
        }

        private static object At(IDictionary<string, object> o, string key) => o.TryGetValue(key, out var v) ? v : null;

        private static bool Number(IDictionary<string, object> o, string key, out double v)
        {
            v = 0;
            if (!(At(o, key) is double d)) return false;
            v = d;
            return true;
        }

        private static GenexSlideRule SlideFrom(object given)
        {
            if (!(given is IDictionary<string, object> o) || !Number(o, "speed", out var speed) || !Number(o, "share", out var share)) return null;
            if (!o.TryGetValue("step", out var step) || !(step == null || step is double)) return null;
            return new GenexSlideRule(speed, step as double?, share);
        }

        private static GenexTopRule TopFrom(object given, bool vehicle)
        {
            if (!(given is IDictionary<string, object> o) || !(At(o, "policy") is string policy)) return null;
            switch (policy)
            {
                case "stand":
                {
                    // An older host's stand omits ride, center and slide: they read as the TypeScript's defaults (ride, anywhere, the shape's slide).
                    var held = o.ContainsKey("slide") ? SlideFrom(At(o, "slide")) : (vehicle ? Copy(VehicleSlide) : Copy(CharacterSlide));
                    if (held == null) return null;
                    if (o.ContainsKey("ride") && !(At(o, "ride") is bool)) return null;
                    var ride = !o.ContainsKey("ride") || (bool)At(o, "ride");
                    var c = At(o, "center");
                    if (o.ContainsKey("center") && c != null && !(c is double)) return null;
                    return new GenexTopRule { Policy = GenexTopPolicy.Stand, Ride = ride, Center = c as double?, Slide = held };
                }
                case "ghost": return new GenexTopRule { Policy = GenexTopPolicy.Ghost };
                case "slide":
                    var slide = SlideFrom(o);
                    return slide == null ? null : new GenexTopRule { Policy = GenexTopPolicy.Slide, Slide = slide };
                case "bounce":
                    var under = SlideFrom(At(o, "slide"));
                    if (under == null || !Number(o, "stompMin", out var stompMin) || !Number(o, "bounceSpeed", out var bounceSpeed) || !Number(o, "jumpBoost", out var jumpBoost)) return null;
                    return new GenexTopRule { Policy = GenexTopPolicy.Bounce, Slide = under, StompMin = stompMin, BounceSpeed = bounceSpeed, JumpBoost = jumpBoost };
                default: return null;
            }
        }

        private static GenexContactShape ShapeFrom(object given)
        {
            if (!(given is IDictionary<string, object> o)) return null;
            switch (At(o, "kind") as string)
            {
                case "box":
                    if (!Number(o, "length", out var length) || !Number(o, "width", out var width) || !Number(o, "top", out var top)) return null;
                    return new GenexContactShape { Kind = GenexContactShapeKind.Box, Length = length, Width = width, Top = top };
                case "hull":
                    if (!Number(o, "radius", out var radius) || !Number(o, "height", out var height)) return null;
                    return new GenexContactShape { Kind = GenexContactShapeKind.Hull, Radius = radius, Height = height };
                default: return null;
            }
        }

        private static List<GenexPairRule> PairsFrom(object given, bool vehicle)
        {
            if (!(given is IList<object> rows)) return null;
            var output = new List<GenexPairRule>();
            foreach (var row in rows)
            {
                if (!(row is IDictionary<string, object> r) || !(At(r, "a") is string a) || !(At(r, "b") is string b)) return null;
                var top = TopFrom(At(r, "top"), vehicle);
                if (top == null) return null;
                output.Add(new GenexPairRule { A = a, B = b, Top = top });
            }
            return output;
        }

        /// <summary>The resolved policy as the data contact-policy.json prints (<c>resolved</c>).</summary>
        public static Dictionary<string, object> ToJson(GenexContactPolicy p)
        {
            var shape = p.Shape.Kind == GenexContactShapeKind.Box
                ? new Dictionary<string, object> { ["kind"] = "box", ["length"] = p.Shape.Length, ["width"] = p.Shape.Width, ["top"] = p.Shape.Top }
                : new Dictionary<string, object> { ["kind"] = "hull", ["radius"] = p.Shape.Radius, ["height"] = p.Shape.Height };
            var pairs = new List<object>();
            foreach (var r in p.Pairs) pairs.Add(new Dictionary<string, object> { ["a"] = r.A, ["b"] = r.B, ["top"] = TopJson(r.Top) });
            return new Dictionary<string, object>
            {
                ["preset"] = p.Preset,
                ["shape"] = shape,
                ["hull"] = new Dictionary<string, object> { ["radius"] = p.HullRadius, ["height"] = p.HullHeight, ["skin"] = p.HullSkin },
                ["groundTrace"] = p.GroundTrace,
                ["supportCos"] = p.SupportCos,
                ["entrySpeed"] = p.EntrySpeed,
                ["entryWindow"] = p.EntryWindow,
                ["restitution"] = p.Restitution,
                ["passes"] = (double)p.Passes,
                ["slop"] = p.Slop,
                ["roofSkin"] = p.RoofSkin,
                ["maxVelocity"] = p.MaxVelocity.HasValue ? (object)p.MaxVelocity.Value : null,
                ["stopSpin"] = p.StopSpin,
                ["top"] = TopJson(p.Top),
                ["offWall"] = SlideJson(p.OffWall),
                ["pairs"] = pairs,
                ["drawing"] = p.Drawing,
                ["push"] = p.Push == GenexContactPush.Mover ? "mover" : "shared",
                ["headFriction"] = p.HeadFriction,
                ["propSlide"] = new Dictionary<string, object> { ["speed"] = p.PropSlide.Speed, ["step"] = p.PropSlide.Step },
            };
        }
    }
}
