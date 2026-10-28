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
                case double d: sb.Append(d.ToString("R", CultureInfo.InvariantCulture)); return;
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
                if (!double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
                    throw new FormatException("number");
                return Finite(d);
            }
        }
    }
}
