// The one value model the Genex layer hands to game code, and the JSON text codec behind
// PlayerState.data / ObjectState.d / RoomState.shared (PROTOCOL.md §1 "JSON text").
//
// Values are plain .NET objects:
//   null, bool, double (EVERY number), string, List<object>, Dictionary<string, object>.
// Every number becomes a double on the way in and goes out as msgpack float64 (§1 forbids int64;
// a C# float would go out as float32 and lose precision). Non-finite numbers become 0 so the
// sender's own view never diverges from what peers see.
//
// Engine-agnostic: no UnityEngine (JsonUtility cannot do dictionaries) and no System.Text.Json
// (absent from Unity's .NET profile).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Genex.Multiplayer
{
    public static class GenexJson
    {
        // ---------------- normalize (decoded msgpack / arbitrary .NET values → the value model) ----------------

        /// <summary>
        /// Convert any decoded or game-supplied value into the value model. Numbers become finite doubles,
        /// maps become Dictionary&lt;string, object&gt;, sequences become List&lt;object&gt;. A msgpack
        /// extension value (msgpackr's <c>undefined</c> is ext type 0) reads as ABSENT: dropped from maps,
        /// null in arrays (§1).
        /// </summary>
        public static object Normalize(object v) => Normalize(v, 0);

        private static object Normalize(object v, int depth)
        {
            if (depth > 64) return null;
            switch (v)
            {
                case null: return null;
                case string s: return s;
                case bool b: return b;
                case double d: return Finite(d);
                case float f: return Finite(f);
                case int i: return (double)i;
                case long l: return (double)l;
                case uint ui: return (double)ui;
                case ulong ul: return (double)ul;
                case short sh: return (double)sh;
                case ushort us: return (double)us;
                case byte by: return (double)by;
                case sbyte sb: return (double)sb;
                case decimal m: return (double)m;
                case IDictionary dict:
                {
                    var o = new Dictionary<string, object>(dict.Count);
                    foreach (DictionaryEntry e in dict)
                    {
                        if (e.Key == null || IsAbsent(e.Value)) continue;
                        o[Convert.ToString(e.Key, CultureInfo.InvariantCulture)] = Normalize(e.Value, depth + 1);
                    }
                    return o;
                }
                case byte[] _: return null; // binary is not part of the JSON-shaped protocol
                case IEnumerable seq:
                {
                    var list = new List<object>();
                    foreach (var item in seq) list.Add(IsAbsent(item) ? null : Normalize(item, depth + 1));
                    return list;
                }
                default:
                    if (IsAbsent(v)) return null;
                    return v.ToString();
            }
        }

        // msgpack extension values (GameDevWare surfaces them as MessagePackExtensionType). msgpackr writes
        // `undefined` as ext type 0; no Genex payload uses any other extension, so every one reads as absent.
        private static bool IsAbsent(object v) =>
            v != null && v.GetType().Name == "MessagePackExtensionType";

        private static double Finite(double d) => double.IsNaN(d) || double.IsInfinity(d) ? 0 : d;

        /// <summary>A normalized copy of a map (a fresh dictionary the caller may keep).</summary>
        public static Dictionary<string, object> NormalizeMap(object v) =>
            Normalize(v) as Dictionary<string, object> ?? new Dictionary<string, object>();

        // ---------------- typed reads ----------------

        public static double Num(IDictionary<string, object> o, string key, double fallback = 0) =>
            o != null && o.TryGetValue(key, out var v) && v is double d ? d : fallback;

        public static string Str(IDictionary<string, object> o, string key, string fallback = null) =>
            o != null && o.TryGetValue(key, out var v) && v is string s ? s : fallback;

        public static bool Bool(IDictionary<string, object> o, string key, bool fallback = false) =>
            o != null && o.TryGetValue(key, out var v) && v is bool b ? b : fallback;

        public static Dictionary<string, object> Map(IDictionary<string, object> o, string key) =>
            o != null && o.TryGetValue(key, out var v) ? v as Dictionary<string, object> : null;

        public static List<object> List(IDictionary<string, object> o, string key) =>
            o != null && o.TryGetValue(key, out var v) ? v as List<object> : null;

        // ---------------- JSON text ----------------

        /// <summary>Serialize a value-model tree (anything <see cref="Normalize(object)"/> accepts) as JSON text.</summary>
        public static string Serialize(object v)
        {
            var sb = new StringBuilder(64);
            Write(sb, Normalize(v));
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, object v)
        {
            switch (v)
            {
                case null: sb.Append("null"); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case double d: sb.Append(NumberText(d)); return;
                case string s: WriteString(sb, s); return;
                case Dictionary<string, object> o:
                {
                    sb.Append('{');
                    var first = true;
                    foreach (var kv in o)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, kv.Key);
                        sb.Append(':');
                        Write(sb, kv.Value);
                    }
                    sb.Append('}');
                    return;
                }
                case List<object> list:
                {
                    sb.Append('[');
                    for (var i = 0; i < list.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        Write(sb, list[i]);
                    }
                    sb.Append(']');
                    return;
                }
                default: WriteString(sb, v.ToString()); return;
            }
        }

        /// <summary>
        /// A finite double as JSON text that reads back to the same double. "R" is the shortest such text on .NET Core, but
        /// Unity's BCL (Mono) writes 15 digits for some values that need 17 (it wrote 6.02337499297543E-238 for
        /// 0x0eaf60ca4fa159a1), so the text is read back with the package's own correctly rounded reader and, when it
        /// misses, written with 17 significant digits. Zero is "0" whatever its sign, as JSON.stringify writes it.
        /// </summary>
        internal static string NumberText(double d)
        {
            if (d == 0) return "0";
            var text = d.ToString("R", CultureInfo.InvariantCulture);
            if (ReadsBack(text, d)) return text;
            return d.ToString("G17", CultureInfo.InvariantCulture);
        }

        private static bool ReadsBack(string text, double d)
        {
            try { return BitConverter.DoubleToInt64Bits(DecimalNumber.Parse(text, 0, text.Length)) == BitConverter.DoubleToInt64Bits(d); }
            catch (FormatException) { return false; }
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c == '\u2028' || c == '\u2029')
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>Parse JSON text into the value model. Returns false (and null) on malformed input.</summary>
        public static bool TryParse(string text, out object value)
        {
            value = null;
            if (text == null) return false;
            try
            {
                var p = new Parser(text);
                p.SkipWs();
                value = p.ReadValue(0);
                p.SkipWs();
                return p.AtEnd;
            }
            catch (FormatException)
            {
                value = null;
                return false;
            }
        }

        /// <summary>Parse JSON text that should hold an object; anything else yields null.</summary>
        public static Dictionary<string, object> ParseObject(string text) =>
            TryParse(text, out var v) ? v as Dictionary<string, object> : null;

        private sealed class Parser
        {
            private readonly string s;
            private int i;
            public Parser(string text) { s = text; }
            public bool AtEnd => i >= s.Length;

            public void SkipWs()
            {
                while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
            }

            private char Peek() => i < s.Length ? s[i] : throw new FormatException("unexpected end");

            public object ReadValue(int depth)
            {
                if (depth > 64) throw new FormatException("too deep");
                SkipWs();
                var c = Peek();
                switch (c)
                {
                    case '{': return ReadObject(depth);
                    case '[': return ReadArray(depth);
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default: return ReadNumber();
                }
            }

            private void Expect(string word)
            {
                if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw new FormatException("bad literal");
                i += word.Length;
            }

            private Dictionary<string, object> ReadObject(int depth)
            {
                var o = new Dictionary<string, object>();
                i++; // {
                SkipWs();
                if (Peek() == '}') { i++; return o; }
                while (true)
                {
                    SkipWs();
                    if (Peek() != '"') throw new FormatException("key");
                    var k = ReadString();
                    SkipWs();
                    if (Peek() != ':') throw new FormatException(":");
                    i++;
                    o[k] = ReadValue(depth + 1);
                    SkipWs();
                    var c = Peek();
                    i++;
                    if (c == ',') continue;
                    if (c == '}') return o;
                    throw new FormatException("object");
                }
            }

            private List<object> ReadArray(int depth)
            {
                var list = new List<object>();
                i++; // [
                SkipWs();
                if (Peek() == ']') { i++; return list; }
                while (true)
                {
                    list.Add(ReadValue(depth + 1));
                    SkipWs();
                    var c = Peek();
                    i++;
                    if (c == ',') continue;
                    if (c == ']') return list;
                    throw new FormatException("array");
                }
            }

            private string ReadString()
            {
                i++; // opening quote
                var sb = new StringBuilder();
                while (true)
                {
                    var c = Peek();
                    i++;
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    var e = Peek();
                    i++;
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (i + 4 > s.Length) throw new FormatException("\\u");
                            sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            i += 4;
                            break;
                        default: throw new FormatException("escape");
                    }
                }
            }

            private double ReadNumber()
            {
                var start = i;
                while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
                if (i == start) throw new FormatException("value");
                return Finite(DecimalNumber.Parse(s, start, i));
            }
        }

        /// <summary>
        /// Decimal text to the nearest double, ties to even: what JSON.parse gives, on every runtime. Unity's BCL
        /// <c>double.Parse</c> (Mono and IL2CPP) is not correctly rounded: it read the float32 "-0.3616481423377991" one
        /// ulp off (no longer a float32), so a firstperson world a JS exporter wrote was refused. Short inputs (at most
        /// 2^53 in the digits, a power of ten up to 1e22) take one IEEE multiply or divide, which is exact; the rest start
        /// from an estimate and step to the neighbour while the text's exact value is past the midpoint, compared
        /// exactly in integers (<see cref="Nat"/>). Accepts an optional sign, digits with an optional fraction and an
        /// optional exponent; anything else is malformed. A result past the range is ±infinity, below it ±0.
        /// </summary>
        internal static class DecimalNumber
        {
            private static readonly double[] ExactPow10 =
            {
                1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
            };

            public static double Parse(string s, int start, int end)
            {
                var at = start;
                var negative = false;
                if (at < end && (s[at] == '-' || s[at] == '+')) negative = s[at++] == '-';
                // Significant digits (leading zeros dropped) and the decimal exponent of the last one.
                var digits = new StringBuilder();
                var exponent = 0L;
                var seenDigit = false;
                for (; at < end && s[at] >= '0' && s[at] <= '9'; at++)
                {
                    seenDigit = true;
                    if (digits.Length > 0 || s[at] != '0') digits.Append(s[at]);
                }
                if (at < end && s[at] == '.')
                {
                    at++;
                    for (; at < end && s[at] >= '0' && s[at] <= '9'; at++)
                    {
                        seenDigit = true;
                        exponent--;
                        if (digits.Length > 0 || s[at] != '0') digits.Append(s[at]);
                    }
                }
                if (!seenDigit) throw new FormatException("number");
                if (at < end && (s[at] == 'e' || s[at] == 'E'))
                {
                    at++;
                    var expNegative = false;
                    if (at < end && (s[at] == '-' || s[at] == '+')) expNegative = s[at++] == '-';
                    if (at >= end) throw new FormatException("number");
                    var e = 0L;
                    for (; at < end && s[at] >= '0' && s[at] <= '9'; at++) e = Math.Min(e * 10 + (s[at] - '0'), 1L << 40);
                    exponent += expNegative ? -e : e;
                }
                if (at != end) throw new FormatException("number");
                // Trailing zeros of the digits move into the exponent.
                var length = digits.Length;
                while (length > 0 && digits[length - 1] == '0') { length--; exponent++; }
                var zero = negative ? -0.0 : 0.0;
                if (length == 0) return zero;
                var magnitude = Magnitude(digits.ToString(0, length), exponent);
                return negative ? -magnitude : magnitude;
            }

            private static double Magnitude(string digits, long exponent)
            {
                // The value is digits · 10^exponent, with digits.Length significant digits.
                var order = exponent + digits.Length; // value < 10^order, ≥ 10^(order-1)
                if (order > 310) return double.PositiveInfinity;
                if (order < -330) return 0;
                var e = (int)exponent;
                if (digits.Length <= 15 && e >= -22 && e <= 22)
                {
                    var d = (double)ulong.Parse(digits, NumberStyles.None, CultureInfo.InvariantCulture);
                    return e >= 0 ? d * ExactPow10[e] : d / ExactPow10[-e];
                }
                // An estimate within a few ulps: the leading 19 digits, scaled.
                var lead = Math.Min(digits.Length, 19);
                var estimate = (double)ulong.Parse(digits.Substring(0, lead), NumberStyles.None, CultureInfo.InvariantCulture);
                var scale = e + (digits.Length - lead);
                if (scale < -290) estimate = estimate * Pow10(scale + 290) * 1e-290;
                else if (scale > 290) estimate = estimate * Pow10(scale - 290) * 1e290;
                else estimate *= Pow10(scale);
                if (double.IsInfinity(estimate)) estimate = double.MaxValue;
                return Nearest(Nat.FromDigits(digits), e, estimate);
            }

            private static double Pow10(int n) => n >= 0 && n <= 22 ? ExactPow10[n] : n < 0 && n >= -22 ? 1 / ExactPow10[-n] : Math.Pow(10, n);

            /// <summary>The double nearest digits · 10^exponent, ties to even, stepping from a finite non-negative estimate.</summary>
            private static double Nearest(Nat digits, int exponent, double c)
            {
                for (var guard = 0; guard < 4096; guard++)
                {
                    var raw = BitConverter.DoubleToInt64Bits(c);
                    var biased = (int)((raw >> 52) & 0x7ff);
                    var m = (ulong)raw & 0xfffffffffffffUL;
                    int k;
                    if (biased == 0) k = -1074;
                    else
                    {
                        m |= 1UL << 52;
                        k = biased - 1075;
                    }
                    var odd = (m & 1) == 1;
                    // Up: the midpoint to the next double is (2m + 1) · 2^(k-1) in every binade (and to 2^1024 past the top).
                    var up = Compare(digits, exponent, Nat.FromULong(2 * m + 1), k - 1);
                    if (up > 0 || (up == 0 && odd))
                    {
                        if (raw == 0x7fefffffffffffffL) return double.PositiveInfinity;
                        c = BitConverter.Int64BitsToDouble(raw + 1);
                        continue;
                    }
                    if (raw == 0) return c;
                    // Down: at the bottom of a binade (not the lowest normal one) the double below is half an ulp closer.
                    var bottom = m == 1UL << 52 && biased > 1;
                    var down = bottom
                        ? Compare(digits, exponent, Nat.FromULong(4 * m - 1), k - 2)
                        : Compare(digits, exponent, Nat.FromULong(2 * m - 1), k - 1);
                    if (down < 0 || (down == 0 && odd))
                    {
                        c = BitConverter.Int64BitsToDouble(raw - 1);
                        continue;
                    }
                    return c;
                }
                return c;
            }

            /// <summary>Sign of digits · 10^exponent − mid · 2^shift, exactly.</summary>
            private static int Compare(Nat digits, int exponent, Nat mid, int shift)
            {
                var left = digits.Copy();
                var right = mid;
                if (exponent >= 0) left.MulPow10(exponent);
                else right.MulPow10(-exponent);
                if (shift >= 0) right.ShiftLeft(shift);
                else left.ShiftLeft(-shift);
                return Nat.Compare(left, right);
            }
        }

        /// <summary>A non-negative integer of any size (little-endian 32-bit limbs), only what <see cref="DecimalNumber"/> needs.</summary>
        internal sealed class Nat
        {
            private uint[] limbs;
            private int count;

            private Nat(int capacity) { limbs = new uint[Math.Max(capacity, 4)]; }

            public static Nat FromULong(ulong v)
            {
                var n = new Nat(4);
                n.limbs[0] = (uint)v;
                n.limbs[1] = (uint)(v >> 32);
                n.count = 2;
                n.Trim();
                return n;
            }

            public static Nat FromDigits(string digits)
            {
                var n = new Nat(digits.Length / 9 + 2);
                for (var at = 0; at < digits.Length;)
                {
                    var take = Math.Min(9, digits.Length - at);
                    uint chunk = 0, factor = 1;
                    for (var j = 0; j < take; j++)
                    {
                        chunk = chunk * 10 + (uint)(digits[at + j] - '0');
                        factor *= 10;
                    }
                    n.MulAdd(factor, chunk);
                    at += take;
                }
                return n;
            }

            public Nat Copy()
            {
                var n = new Nat(count + 1);
                Array.Copy(limbs, n.limbs, count);
                n.count = count;
                return n;
            }

            private void Ensure(int size)
            {
                if (limbs.Length >= size) return;
                var grown = new uint[Math.Max(size, limbs.Length * 2)];
                Array.Copy(limbs, grown, count);
                limbs = grown;
            }

            private void Trim()
            {
                while (count > 0 && limbs[count - 1] == 0) count--;
            }

            /// <summary>this = this · factor + add.</summary>
            private void MulAdd(uint factor, uint add)
            {
                ulong carry = add;
                for (var j = 0; j < count; j++)
                {
                    var p = (ulong)limbs[j] * factor + carry;
                    limbs[j] = (uint)p;
                    carry = p >> 32;
                }
                if (carry != 0)
                {
                    Ensure(count + 1);
                    limbs[count++] = (uint)carry;
                }
            }

            public void MulPow10(int n)
            {
                for (; n >= 9; n -= 9) MulAdd(1000000000, 0);
                uint rest = 1;
                for (; n > 0; n--) rest *= 10;
                if (rest != 1) MulAdd(rest, 0);
            }

            public void ShiftLeft(int bits)
            {
                if (count == 0 || bits == 0) return;
                var words = bits >> 5;
                var r = bits & 31;
                Ensure(count + words + 1);
                limbs[count + words] = 0;
                if (r == 0)
                {
                    for (var j = count - 1; j >= 0; j--) limbs[j + words] = limbs[j];
                }
                else
                {
                    for (var j = count - 1; j >= 0; j--)
                    {
                        limbs[j + words + 1] |= limbs[j] >> (32 - r);
                        limbs[j + words] = limbs[j] << r;
                    }
                }
                for (var j = 0; j < words; j++) limbs[j] = 0;
                count += words + 1;
                Trim();
            }

            public static int Compare(Nat a, Nat b)
            {
                if (a.count != b.count) return a.count < b.count ? -1 : 1;
                for (var j = a.count - 1; j >= 0; j--)
                    if (a.limbs[j] != b.limbs[j]) return a.limbs[j] < b.limbs[j] ? -1 : 1;
                return 0;
            }
        }
    }
}
