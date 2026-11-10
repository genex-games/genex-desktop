// The Genex Physics core in a native player or the editor (PROTOCOL.md §17.11 *The core*): the C ABI of
// genex-physics-capi (Runtime/Plugins/GenexPhysics/Include/genex_physics.h, ABI version 1) over P/Invoke, and the
// world calls the predictor makes (PhysicsPredict.cs) in the form the TypeScript package (@genex-ai/physics 1.1) gives
// them: every command crosses as its JSON (C§7.3) with every number rounded to its float32 first, exactly as the
// package's encoder writes it (−0 as "-0.0", NaN and +Infinity as "1e39", −Infinity as "-1e39"), so the core reads the
// same values the WebAssembly module reads in the TypeScript SDK and steps to the same stateHash.
//
// The library is the same core the TypeScript side vendors (genex-desktop ae524c44): macOS universal dylib, Windows x64
// DLL, Linux x64 .so, Android arm64 .so and the iOS xcframework (statically linked: "__Internal"). WebGL has no native
// library: there the core is unavailable and bodies are drawn as §17.10 says. Nothing here references UnityEngine.
//
// The boundary: every call that the header can refuse is checked (a non-zero gxph_result is a refusal, nothing changed);
// a reply buffer is always handed back (gxph_buf_free), even when reading it throws. A world handle is only ever the
// IntPtr the library gave; a freed world is never passed again (Free is idempotent here).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Genex.Multiplayer.Authority
{
    /// <summary>The C ABI's calls, as declared in genex_physics.h. Internal: <see cref="GenexPhysicsNativeCore"/> is the API.</summary>
    public static class GxphNative
    {
#if (UNITY_IOS || UNITY_TVOS) && !UNITY_EDITOR
        public const string Library = "__Internal";
#else
        public const string Library = "genex_physics_capi";
#endif
        /// <summary>The header's GXPH_ABI_VERSION this binding was written against.</summary>
        public const uint AbiVersion = 1;

        public const int Ok = 0, ErrNull = 1, ErrLength = 2, ErrAlign = 3, ErrUtf8 = 4, ErrOutInUse = 5, ErrNoWorld = 6,
            ErrNotOurs = 7, ErrPanic = 8, ErrArg = 9;

        [StructLayout(LayoutKind.Sequential)]
        public struct Bytes
        {
            public IntPtr Ptr;
            public UIntPtr Len;
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        // A WebGL player has no native library (and IL2CPP links every [DllImport] statically there): the calls are stubs
        // that answer as a missing library does, and GenexPhysicsNativeCore.Load says so before any of them runs.
        public static uint gxph_abi_version() { throw new DllNotFoundException(Library); }
        public static int gxph_build_id(ref Bytes output) { throw new DllNotFoundException(Library); }
        public static int gxph_buf_free(ref Bytes buffer) { throw new DllNotFoundException(Library); }
        public static int gxph_live_worlds(out uint output) { output = default; throw new DllNotFoundException(Library); }
        public static int gxph_world_create(byte[] desc, UIntPtr descLen, out IntPtr world, ref Bytes reply) { world = default; throw new DllNotFoundException(Library); }
        public static int gxph_world_free(IntPtr world) { throw new DllNotFoundException(Library); }
        public static int gxph_world_tick(IntPtr world, out ulong output) { output = default; throw new DllNotFoundException(Library); }
        public static int gxph_world_command(IntPtr world, byte[] command, UIntPtr commandLen, ref Bytes reply) { throw new DllNotFoundException(Library); }
        public static int gxph_world_add_static(IntPtr world, uint[] boxLengths, UIntPtr boxLengthsLen, double[] boxes, UIntPtr boxesLen, uint[] rampLengths, UIntPtr rampLengthsLen, double[] ramps, UIntPtr rampsLen, ref Bytes reply) { throw new DllNotFoundException(Library); }
        public static int gxph_world_step(IntPtr world, ref Bytes reply) { throw new DllNotFoundException(Library); }
        public static int gxph_world_export_changed_rest(IntPtr world, double since, ref Bytes keys, ref Bytes data) { throw new DllNotFoundException(Library); }
        public static int gxph_world_export_body_state_rest(IntPtr world, byte[] key, UIntPtr keyLen, ref Bytes reply) { throw new DllNotFoundException(Library); }
        public static int gxph_world_import_wire(IntPtr world, byte[] keys, UIntPtr keysLen, float[] data, UIntPtr dataLen, ref Bytes reply) { throw new DllNotFoundException(Library); }
        public static int gxph_world_canonicalize(IntPtr world, byte[] options, UIntPtr optionsLen, ref Bytes reply) { throw new DllNotFoundException(Library); }
        public static int gxph_world_state_hash(IntPtr world, ref Bytes hash) { throw new DllNotFoundException(Library); }
        public static int gxph_world_physics_hash(IntPtr world, ref Bytes hash) { throw new DllNotFoundException(Library); }
        public static int gxph_world_tick_frame(IntPtr world, byte[] request, UIntPtr requestLen, ref Bytes reply) { throw new DllNotFoundException(Library); }
#else
        private const CallingConvention Cdecl = CallingConvention.Cdecl;

        [DllImport(Library, CallingConvention = Cdecl)] public static extern uint gxph_abi_version();
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_build_id(ref Bytes output);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_buf_free(ref Bytes buffer);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_live_worlds(out uint output);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_create(byte[] desc, UIntPtr descLen, out IntPtr world, ref Bytes reply);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_free(IntPtr world);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_tick(IntPtr world, out ulong output);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_command(IntPtr world, byte[] command, UIntPtr commandLen, ref Bytes reply);
        [DllImport(Library, CallingConvention = Cdecl)]
        public static extern int gxph_world_add_static(IntPtr world, uint[] boxLengths, UIntPtr boxLengthsLen, double[] boxes, UIntPtr boxesLen,
            uint[] rampLengths, UIntPtr rampLengthsLen, double[] ramps, UIntPtr rampsLen, ref Bytes reply);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_step(IntPtr world, ref Bytes reply);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_export_changed_rest(IntPtr world, double since, ref Bytes keys, ref Bytes data);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_export_body_state_rest(IntPtr world, byte[] key, UIntPtr keyLen, ref Bytes reply);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_import_wire(IntPtr world, byte[] keys, UIntPtr keysLen, float[] data, UIntPtr dataLen, ref Bytes reply);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_canonicalize(IntPtr world, byte[] options, UIntPtr optionsLen, ref Bytes reply);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_state_hash(IntPtr world, ref Bytes hash);
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_physics_hash(IntPtr world, ref Bytes hash);
        /// <summary>One room tick in one call (the binding's tick.rs): command batches, a step and an export, binary both ways;
        /// an empty reply when the request does not decode (nothing ran).</summary>
        [DllImport(Library, CallingConvention = Cdecl)] public static extern int gxph_world_tick_frame(IntPtr world, byte[] request, UIntPtr requestLen, ref Bytes reply);
#endif

        /// <summary>A reply's bytes, the buffer handed back to the library whatever happens.</summary>
        public static byte[] Take(ref Bytes b)
        {
            try
            {
                var len = (long)b.Len.ToUInt64();
                if (b.Ptr == IntPtr.Zero || len <= 0) return Array.Empty<byte>();
                if (len > int.MaxValue) throw new InvalidOperationException("genex physics: a reply over 2 GiB");
                var bytes = new byte[len];
                Marshal.Copy(b.Ptr, bytes, 0, (int)len);
                return bytes;
            }
            finally
            {
                gxph_buf_free(ref b);
            }
        }

        public static string TakeText(ref Bytes b) => Encoding.UTF8.GetString(Take(ref b));

        public static UIntPtr Len(byte[] a) => new UIntPtr(a == null ? 0u : (uint)a.Length);
        public static UIntPtr Len(float[] a) => new UIntPtr(a == null ? 0u : (uint)a.Length);
        public static UIntPtr Len(double[] a) => new UIntPtr(a == null ? 0u : (uint)a.Length);
        public static UIntPtr Len(uint[] a) => new UIntPtr(a == null ? 0u : (uint)a.Length);
        public static byte[] Utf8(string s) => Encoding.UTF8.GetBytes(s);

        /// <summary>A reply's bytes copied into <paramref name="buffer"/> (grown as needed), the buffer handed back to the
        /// library whatever happens; the reply's length.</summary>
        public static int TakeInto(ref Bytes b, ref byte[] buffer)
        {
            try
            {
                var len = (long)b.Len.ToUInt64();
                if (b.Ptr == IntPtr.Zero || len <= 0) return 0;
                if (len > int.MaxValue) throw new InvalidOperationException("genex physics: a reply over 2 GiB");
                if (buffer.Length < len) buffer = new byte[Math.Max(len, buffer.Length * 2L)];
                Marshal.Copy(b.Ptr, buffer, 0, (int)len);
                return (int)len;
            }
            finally
            {
                gxph_buf_free(ref b);
            }
        }
    }

    /// <summary>A call's result as the core answers it (C§3): ok, or a failure's code and detail.</summary>
    public sealed class GenexPhysicsResult
    {
        public bool Ok;
        public string Code;
        public string Detail;
        /// <summary>The whole reply, parsed (null for a refusal at the boundary, and for a bare <c>{"ok":true}</c> or a tick frame's
        /// step, which are not parsed).</summary>
        public Dictionary<string, object> Reply;

        public static GenexPhysicsResult Success(Dictionary<string, object> reply = null) => new GenexPhysicsResult { Ok = true, Reply = reply };
        public static GenexPhysicsResult Failure(string code, string detail) => new GenexPhysicsResult { Ok = false, Code = code, Detail = detail };

        public override string ToString() => Ok ? "ok" : $"{Code}: {Detail}";
    }

    /// <summary>A body's replicated fields with its sleep timer (C§9.2, §20.3), as <c>exportBodyState(key, { rest: true })</c> gives them.</summary>
    public sealed class GenexWireBodyState
    {
        public double[] P = new double[3], Q = new double[4], V = new double[3], W = new double[3];
        public bool Sleeping;
        public double Rest;
    }

    /// <summary>One world of the core: the calls the predictor makes, in the TypeScript package's forms.</summary>
    public interface IGenexPhysicsWorld
    {
        /// <summary>The tick counter: 0 until the first step.</summary>
        long Tick { get; }
        GenexPhysicsResult AddStaticWorld(IList<double[]> boxes, IList<double[]> ramps);
        GenexPhysicsResult Spawn(object desc);
        GenexPhysicsResult Remove(string key);
        GenexPhysicsResult AddJoint(object desc);
        GenexPhysicsResult RemoveJoint(string key);
        GenexPhysicsResult SetMotor(string key, object motor);
        GenexPhysicsResult SetVelocity(string key, double[] linvel, double[] angvel);
        GenexPhysicsResult SetNextKinematicPose(string key, double[] p, double[] q);
        /// <summary>Wire rows (C§20.2): 15 numbers per key, each rounded to float32 as it crosses.</summary>
        GenexPhysicsResult ImportWire(IList<string> keys, IList<double> rows);
        GenexPhysicsResult Canonicalize(bool quantize);
        /// <summary>One step (C§8); the escaped bodies' keys in <paramref name="escaped"/>.</summary>
        GenexPhysicsResult Step(List<string> escaped);
        /// <summary><c>exportChanged(since, { rest: true })</c>: keys and 15 float32s per key.</summary>
        void ExportChanged(long since, List<string> keys, List<float> data);
        /// <summary><c>exportBodyState(key, { rest: true })</c>, or null.</summary>
        GenexWireBodyState ExportBodyState(string key);
        string StateHash();
        string PhysicsHash();
        void Free();
    }

    /// <summary>
    /// A world that runs one predicted tick's commands and step in one crossing (the native core's <c>gxph_world_tick_frame</c>),
    /// numbers crossing as binary float64 (each the float32 the JSON encoder would write) instead of JSON text. The predictor
    /// uses it when the world offers it; what the core is asked and answers is the same as the separate calls'.
    /// </summary>
    public interface IGenexPhysicsTickFrame
    {
        /// <summary>Queues <c>setNextKinematicPose</c> for the next <see cref="StepFrame"/>.</summary>
        void QueueKinematicPose(string key, double px, double py, double pz, double qx, double qy, double qz, double qw);
        /// <summary>Queues <c>setVelocity</c> (linear only) for the next <see cref="StepFrame"/>.</summary>
        void QueueVelocity(string key, double vx, double vy, double vz);
        /// <summary>The queued commands in order, each as its own command (their results dropped, as the predictor drops
        /// them), then one step: its result, the escaped bodies' keys in <paramref name="escaped"/>.</summary>
        GenexPhysicsResult StepFrame(List<string> escaped);
        /// <summary><c>exportBodyState(key, { rest: true })</c> into <paramref name="into"/>; false when there is no such body.</summary>
        bool ExportBodyStateInto(string key, GenexWireBodyState into);
    }

    /// <summary>The game's loaded core.</summary>
    public interface IGenexPhysicsCore
    {
        string BuildId();
        /// <summary>Makes a world from its description (C§4); null and <paramref name="refused"/> when the core refuses it.</summary>
        IGenexPhysicsWorld CreateWorld(object desc, out GenexPhysicsResult refused);
    }

    /// <summary>
    /// The JSON the core reads: the package's encoder (C§4.1). Every number is its float32 in shortest round-trip form, −0
    /// as "-0.0" (bare "-0" reads as the integer 0), NaN and +∞ as "1e39" (finite as f64, infinite as f32), −∞ as "-1e39".
    /// Values are the package's value model (null, bool, numbers, string, lists, string-keyed dictionaries) plus double[]
    /// and float[].
    /// </summary>
    public static class GenexPhysicsJson
    {
        public static string Encode(object value)
        {
            var sb = new StringBuilder(128);
            Write(sb, value, 0);
            return sb.ToString();
        }

        /// <summary>One number as the core reads it: its float32.</summary>
        public static string NumberText(double value)
        {
            var f = (float)value;
            if (float.IsNaN(f) || float.IsPositiveInfinity(f)) return "1e39";
            if (float.IsNegativeInfinity(f)) return "-1e39";
            if (f == 0) return BitConverter.DoubleToInt64Bits((double)f) < 0 ? "-0.0" : "0";
            return GenexJson.NumberText((double)f);
        }

        private const int MaxDepth = 64;

        private static void Write(StringBuilder sb, object v, int depth)
        {
            if (depth > MaxDepth) throw new FormatException("genex physics: a value nested too deep");
            switch (v)
            {
                case null: sb.Append("null"); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case double d: sb.Append(NumberText(d)); return;
                case float f: sb.Append(NumberText(f)); return;
                case int i: sb.Append(NumberText(i)); return;
                case long l: sb.Append(NumberText(l)); return;
                case string s: WriteString(sb, s); return;
                case double[] ds:
                    sb.Append('[');
                    for (var i = 0; i < ds.Length; i++)
                    {
                        if (i > 0) sb.Append(',');
                        sb.Append(NumberText(ds[i]));
                    }
                    sb.Append(']');
                    return;
                case float[] fs:
                    sb.Append('[');
                    for (var i = 0; i < fs.Length; i++)
                    {
                        if (i > 0) sb.Append(',');
                        sb.Append(NumberText(fs[i]));
                    }
                    sb.Append(']');
                    return;
                case IDictionary<string, object> o:
                {
                    sb.Append('{');
                    var first = true;
                    foreach (var kv in o)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, kv.Key);
                        sb.Append(':');
                        Write(sb, kv.Value, depth + 1);
                    }
                    sb.Append('}');
                    return;
                }
                case System.Collections.IList list:
                {
                    sb.Append('[');
                    for (var i = 0; i < list.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        Write(sb, list[i], depth + 1);
                    }
                    sb.Append(']');
                    return;
                }
                default: throw new FormatException("genex physics: a value the core cannot read: " + v.GetType().Name);
            }
        }

        private static void WriteString(StringBuilder sb, string s) => sb.Append(GenexJson.Serialize(s));
    }

    /// <summary>The core in this process: the native library, loaded on the first call. <see cref="Load"/> is the only door.</summary>
    public sealed class GenexPhysicsNativeCore : IGenexPhysicsCore
    {
        /// <summary>
        /// The pinned core's buildId up to its target (<c>+aarch64-macos</c>, <c>+x86_64-windows</c>, ...): the build
        /// physics-predict.json was matched on (Plugins/GenexPhysics/PROVENANCE.json). A library of another build is refused.
        /// </summary>
        public const string PinnedBuildPrefix = "genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+";

        private static GenexPhysicsNativeCore loaded;
        private readonly string buildId;

        private GenexPhysicsNativeCore(string buildId) => this.buildId = buildId;

        /// <summary>
        /// The native core, or null with <paramref name="why"/> when this player has none (WebGL, a platform without the
        /// plugin, a library that does not load) or its ABI version is not <paramref name="expectedAbi"/> (this binding's,
        /// by default): a library of another version is never called past <c>gxph_abi_version</c>. A library whose buildId
        /// does not start with <paramref name="pinnedBuild"/> (<see cref="PinnedBuildPrefix"/> by default) is refused too.
        /// </summary>
        public static GenexPhysicsNativeCore Load(out string why, uint expectedAbi = GxphNative.AbiVersion, string pinnedBuild = PinnedBuildPrefix)
        {
            why = null;
#if UNITY_WEBGL && !UNITY_EDITOR
            why = "no native core in a WebGL player";
            return null;
#else
            uint abi;
            try
            {
                abi = GxphNative.gxph_abi_version();
            }
            catch (Exception e) when (e is DllNotFoundException || e is EntryPointNotFoundException || e is BadImageFormatException)
            {
                why = "the native core did not load: " + e.GetType().Name;
                return null;
            }
            if (abi != expectedAbi)
            {
                why = $"the native core's ABI is version {abi}, this binding's {expectedAbi}";
                return null;
            }
            var core = expectedAbi == GxphNative.AbiVersion ? loaded : null;
            if (core == null)
            {
                var b = default(GxphNative.Bytes);
                var r = GxphNative.gxph_build_id(ref b);
                if (r != GxphNative.Ok)
                {
                    why = "gxph_build_id refused: " + r;
                    return null;
                }
                core = new GenexPhysicsNativeCore(GxphNative.TakeText(ref b));
            }
            if (pinnedBuild == null || !core.buildId.StartsWith(pinnedBuild, StringComparison.Ordinal))
            {
                why = $"the native core is build {core.buildId}, not the pinned {pinnedBuild}*";
                return null;
            }
            loaded = core;
            return loaded;
#endif
        }

        public string BuildId() => buildId;

        /// <summary>How many worlds the library holds (diagnostics and the boundary checks).</summary>
        public static uint LiveWorlds()
        {
            GxphNative.gxph_live_worlds(out var n);
            return n;
        }

        public IGenexPhysicsWorld CreateWorld(object desc, out GenexPhysicsResult refused)
        {
            refused = null;
            string text;
            try { text = GenexPhysicsJson.Encode(desc); }
            catch (FormatException e)
            {
                refused = GenexPhysicsResult.Failure("bad-command", e.Message);
                return null;
            }
            var bytes = GxphNative.Utf8(text);
            var reply = default(GxphNative.Bytes);
            var r = GxphNative.gxph_world_create(bytes, GxphNative.Len(bytes), out var handle, ref reply);
            if (r != GxphNative.Ok)
            {
                refused = GenexPhysicsResult.Failure("internal", "gxph_world_create: " + r);
                return null;
            }
            var result = NativeWorld.Parse(GxphNative.TakeText(ref reply));
            if (!result.Ok || handle == IntPtr.Zero)
            {
                if (handle != IntPtr.Zero) GxphNative.gxph_world_free(handle);
                refused = result.Ok ? GenexPhysicsResult.Failure("internal", "no world handle") : result;
                return null;
            }
            return new NativeWorld(handle);
        }

        /// <summary>
        /// A world of the native library. The predictor's calls run many times a replay, so they reuse this world's buffers:
        /// a reply is copied into one byte buffer (no array per call), a bare <c>{"ok":true}</c> is recognised without parsing,
        /// the keys an export lists are read into strings this world already holds, a body state's numbers are read straight
        /// from the reply, and a tick's commands and step cross in one binary <c>gxph_world_tick_frame</c> (no number is
        /// formatted as text: each crosses as the float64 of the float32 the JSON encoder would write, which is what the core
        /// reads from that text). Nothing here changes what the core is asked or what it answers.
        /// </summary>
        private sealed class NativeWorld : IGenexPhysicsWorld, IGenexPhysicsTickFrame
        {
            private IntPtr handle;
            private static readonly byte[] Quantize = GxphNative.Utf8("{\"quantize\":true}");
            private static readonly byte[] NoQuantize = GxphNative.Utf8("{}");
            private static readonly byte[] OkReply = GxphNative.Utf8("{\"ok\":true}");
            /// <summary>The last reply's bytes (grown as needed), and the second buffer an export's data comes in.</summary>
            private byte[] reply = new byte[1024];
            private byte[] data = new byte[4096];
            private float[] floats = new float[256];
            /// <summary>Strings this world handed out for keys, by their UTF-8 bytes (an export lists the same few keys every tick).</summary>
            private readonly List<KeyValuePair<byte[], string>> keyNames = new List<KeyValuePair<byte[], string>>();
            /// <summary>Keys' UTF-8 bytes for the tick frame.</summary>
            private readonly Dictionary<string, byte[]> keyBytes = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            private const int KeysKept = 1024;
            /// <summary>The commands queued for the next tick frame, and whether the library reads tick frames (it answers an
            /// empty reply to one it cannot read, having run nothing: from then on the JSON calls run them).</summary>
            private readonly List<Queued> queue = new List<Queued>();
            private bool framesRefused;
            private byte[] request = new byte[1024];
            private int requestLength;

            private struct Queued
            {
                public bool Velocity;
                public string Key;
                public double A, B, C, D, E, F, G;
            }

            internal NativeWorld(IntPtr handle) => this.handle = handle;

            internal static GenexPhysicsResult Parse(string text)
            {
                var reply = GenexJson.ParseObject(text);
                if (reply == null) return GenexPhysicsResult.Failure("internal", "a reply that is not a JSON object");
                if (reply.TryGetValue("ok", out var ok) && ok is bool b && b) return GenexPhysicsResult.Success(reply);
                return new GenexPhysicsResult { Ok = false, Code = GenexJson.Str(reply, "code", "internal"), Detail = GenexJson.Str(reply, "detail", ""), Reply = reply };
            }

            /// <summary>The reply in <see cref="reply"/> as a result: a bare {"ok":true} without parsing (its Reply null), else parsed.</summary>
            private GenexPhysicsResult ResultOf(int length)
            {
                if (length == OkReply.Length)
                {
                    var same = true;
                    for (var i = 0; i < length && same; i++) same = reply[i] == OkReply[i];
                    if (same) return GenexPhysicsResult.Success();
                }
                return Parse(Encoding.UTF8.GetString(reply, 0, length));
            }

            private GenexPhysicsResult Gone() => GenexPhysicsResult.Failure("internal", "this world was freed");

            private static GenexPhysicsResult Refused(string call, int r) => GenexPhysicsResult.Failure("internal", $"{call} refused at the boundary: {r}");

            public long Tick
            {
                get
                {
                    if (handle == IntPtr.Zero) return 0;
                    return GxphNative.gxph_world_tick(handle, out var t) == GxphNative.Ok ? (long)t : 0;
                }
            }

            private GenexPhysicsResult Command(object command)
            {
                if (handle == IntPtr.Zero) return Gone();
                string text;
                try { text = GenexPhysicsJson.Encode(command); }
                catch (FormatException e) { return GenexPhysicsResult.Failure("bad-command", e.Message); }
                var bytes = GxphNative.Utf8(text);
                var b = default(GxphNative.Bytes);
                var r = GxphNative.gxph_world_command(handle, bytes, GxphNative.Len(bytes), ref b);
                if (r != GxphNative.Ok) return Refused("gxph_world_command", r);
                return ResultOf(GxphNative.TakeInto(ref b, ref reply));
            }

            private static Dictionary<string, object> One(string name, object body) => new Dictionary<string, object> { [name] = body };
            private static Dictionary<string, object> Keyed(string key) => new Dictionary<string, object> { ["key"] = key };

            public GenexPhysicsResult AddStaticWorld(IList<double[]> boxes, IList<double[]> ramps)
            {
                if (handle == IntPtr.Zero) return Gone();
                if (boxes == null || ramps == null) return GenexPhysicsResult.Failure("bad-command", "a static world is { boxes, ramps }");
                Flatten(boxes, out var boxLengths, out var boxValues);
                Flatten(ramps, out var rampLengths, out var rampValues);
                if (boxLengths == null || rampLengths == null) return GenexPhysicsResult.Failure("bad-command", "a static row is a list of numbers");
                var b = default(GxphNative.Bytes);
                var r = GxphNative.gxph_world_add_static(handle, boxLengths, GxphNative.Len(boxLengths), boxValues, GxphNative.Len(boxValues),
                    rampLengths, GxphNative.Len(rampLengths), rampValues, GxphNative.Len(rampValues), ref b);
                if (r != GxphNative.Ok) return Refused("gxph_world_add_static", r);
                return ResultOf(GxphNative.TakeInto(ref b, ref reply));
            }

            private static void Flatten(IList<double[]> rows, out uint[] lengths, out double[] values)
            {
                lengths = new uint[rows.Count];
                var flat = new List<double>();
                for (var i = 0; i < rows.Count; i++)
                {
                    var row = rows[i];
                    if (row == null)
                    {
                        lengths = null;
                        values = null;
                        return;
                    }
                    lengths[i] = (uint)row.Length;
                    flat.AddRange(row);
                }
                values = flat.ToArray();
            }

            public GenexPhysicsResult Spawn(object desc) => Command(One("spawn", desc));
            public GenexPhysicsResult Remove(string key) => Command(One("remove", Keyed(key)));
            public GenexPhysicsResult AddJoint(object desc) => Command(One("addJoint", desc));
            public GenexPhysicsResult RemoveJoint(string key) => Command(One("removeJoint", Keyed(key)));

            public GenexPhysicsResult SetMotor(string key, object motor) =>
                Command(One("setMotor", new Dictionary<string, object> { ["key"] = key, ["motor"] = motor }));

            public GenexPhysicsResult SetVelocity(string key, double[] linvel, double[] angvel)
            {
                var body = Keyed(key);
                if (linvel != null) body["linvel"] = linvel;
                if (angvel != null) body["angvel"] = angvel;
                return Command(One("setVelocity", body));
            }

            public GenexPhysicsResult SetNextKinematicPose(string key, double[] p, double[] q) =>
                Command(One("setNextKinematicPose", new Dictionary<string, object>
                {
                    ["key"] = key, ["pose"] = new Dictionary<string, object> { ["p"] = p, ["q"] = q },
                }));

            public GenexPhysicsResult ImportWire(IList<string> keys, IList<double> rows)
            {
                if (handle == IntPtr.Zero) return Gone();
                // The package's own checks before anything crosses (bulkImport): keys are strings, rows exactly 15 a key.
                if (keys == null || rows == null) return GenexPhysicsResult.Failure("bad-command", "importWire takes keys and rows");
                foreach (var k in keys) if (k == null) return GenexPhysicsResult.Failure("bad-command", "a key is a string");
                if (rows.Count != keys.Count * GenexPhysicsKeyframe.WireRowStride) return GenexPhysicsResult.Failure("bad-command", "rows are 15 numbers a key");
                if (floats.Length < rows.Count) floats = new float[Math.Max(rows.Count, floats.Length * 2)];
                for (var i = 0; i < rows.Count; i++) floats[i] = (float)rows[i];
                var keyText = ImportKeyText(keys);
                var b = default(GxphNative.Bytes);
                var r = GxphNative.gxph_world_import_wire(handle, keyText, GxphNative.Len(keyText), floats, new UIntPtr((uint)rows.Count), ref b);
                if (r != GxphNative.Ok) return Refused("gxph_world_import_wire", r);
                return ResultOf(GxphNative.TakeInto(ref b, ref reply));
            }

            /// <summary>The key list's UTF-8 JSON for importWire: the last one again while the keys are the same (a replay
            /// imports the same bodies and seats keyframe after keyframe), else encoded afresh.</summary>
            private byte[] ImportKeyText(IList<string> keys)
            {
                var same = importKeys.Count == keys.Count;
                for (var i = 0; same && i < keys.Count; i++) same = string.Equals(importKeys[i], keys[i], StringComparison.Ordinal);
                if (same && importKeyText != null) return importKeyText;
                importKeys.Clear();
                foreach (var k in keys) importKeys.Add(k);
                importKeyText = GxphNative.Utf8(GenexPhysicsJson.Encode(new List<object>(keys)));
                return importKeyText;
            }

            private readonly List<string> importKeys = new List<string>();
            private byte[] importKeyText;

            public GenexPhysicsResult Canonicalize(bool quantize)
            {
                if (handle == IntPtr.Zero) return Gone();
                var options = quantize ? Quantize : NoQuantize;
                var b = default(GxphNative.Bytes);
                var r = GxphNative.gxph_world_canonicalize(handle, options, GxphNative.Len(options), ref b);
                if (r != GxphNative.Ok) return Refused("gxph_world_canonicalize", r);
                return ResultOf(GxphNative.TakeInto(ref b, ref reply));
            }

            public GenexPhysicsResult Step(List<string> escaped)
            {
                escaped?.Clear();
                if (handle == IntPtr.Zero) return Gone();
                var b = default(GxphNative.Bytes);
                var r = GxphNative.gxph_world_step(handle, ref b);
                if (r != GxphNative.Ok) return Refused("gxph_world_step", r);
                var result = Parse(Encoding.UTF8.GetString(reply, 0, GxphNative.TakeInto(ref b, ref reply)));
                if (result.Ok && escaped != null)
                {
                    var list = GenexJson.List(result.Reply, "escaped");
                    if (list != null) foreach (var k in list) if (k is string s) escaped.Add(s);
                }
                return result;
            }

            public void ExportChanged(long since, List<string> keys, List<float> data)
            {
                keys.Clear();
                data.Clear();
                if (handle == IntPtr.Zero || since < 0) return;
                var k = default(GxphNative.Bytes);
                var d = default(GxphNative.Bytes);
                var r = GxphNative.gxph_world_export_changed_rest(handle, since, ref k, ref d);
                if (r != GxphNative.Ok) return;
                var keyLength = GxphNative.TakeInto(ref k, ref reply);
                var dataLength = GxphNative.TakeInto(ref d, ref this.data);
                if (!ReadKeys(keyLength, keys))
                {
                    keys.Clear();
                    if (!(GenexJson.TryParse(Encoding.UTF8.GetString(reply, 0, keyLength), out var parsed) && parsed is List<object> list)) return;
                    foreach (var key in list) keys.Add(key as string ?? "");
                }
                var stride = GenexPhysicsKeyframe.WireRowStride;
                if (dataLength != keys.Count * stride * 4)
                {
                    keys.Clear();
                    return;
                }
                var count = dataLength / 4;
                if (floats.Length < count) floats = new float[Math.Max(count, floats.Length * 2)];
                Buffer.BlockCopy(this.data, 0, floats, 0, dataLength);
                if (data.Capacity < count) data.Capacity = count;
                for (var i = 0; i < count; i++) data.Add(floats[i]);
            }

            /// <summary>A JSON list of keys in <see cref="reply"/> read into <paramref name="keys"/> as strings this world already
            /// holds; false for any form other than plain strings without escapes (the caller then parses it whole).</summary>
            private bool ReadKeys(int length, List<string> keys)
            {
                var at = 0;
                if (length < 2 || reply[at++] != (byte)'[') return false;
                if (reply[at] == (byte)']') return at + 1 == length;
                while (true)
                {
                    if (at >= length || reply[at++] != (byte)'"') return false;
                    var start = at;
                    while (at < length && reply[at] != (byte)'"')
                    {
                        if (reply[at] == (byte)'\\') return false;
                        at++;
                    }
                    if (at >= length) return false;
                    keys.Add(KeyName(start, at - start));
                    at++;
                    if (at >= length) return false;
                    if (reply[at] == (byte)']') return at + 1 == length;
                    if (reply[at++] != (byte)',') return false;
                }
            }

            private string KeyName(int start, int count)
            {
                foreach (var kv in keyNames)
                {
                    var known = kv.Key;
                    if (known.Length != count) continue;
                    var same = true;
                    for (var i = 0; i < count && same; i++) same = known[i] == reply[start + i];
                    if (same) return kv.Value;
                }
                var bytes = new byte[count];
                Array.Copy(reply, start, bytes, 0, count);
                var name = Encoding.UTF8.GetString(bytes);
                if (keyNames.Count >= KeysKept) keyNames.Clear();
                keyNames.Add(new KeyValuePair<byte[], string>(bytes, name));
                return name;
            }

            public GenexWireBodyState ExportBodyState(string key)
            {
                var state = new GenexWireBodyState();
                return ExportBodyStateInto(key, state) ? state : null;
            }

            public bool ExportBodyStateInto(string key, GenexWireBodyState into)
            {
                if (handle == IntPtr.Zero || key == null || into == null) return false;
                var bytes = KeyBytes(key);
                var b = default(GxphNative.Bytes);
                if (GxphNative.gxph_world_export_body_state_rest(handle, bytes, GxphNative.Len(bytes), ref b) != GxphNative.Ok) return false;
                var length = GxphNative.TakeInto(ref b, ref reply);
                if (ReplyNumbers.ReadBodyState(reply, length, into)) return true;
                // Any other form: read it whole.
                var st = GenexJson.ParseObject(Encoding.UTF8.GetString(reply, 0, length));
                if (st == null) return false;
                into.Sleeping = GenexJson.Bool(st, "sleeping");
                into.Rest = GenexJson.Num(st, "rest");
                return Read(st, "p", into.P) && Read(st, "q", into.Q) && Read(st, "v", into.V) && Read(st, "w", into.W);
            }

            private static bool Read(Dictionary<string, object> o, string name, double[] into)
            {
                var list = GenexJson.List(o, name);
                if (list == null || list.Count != into.Length) return false;
                for (var i = 0; i < into.Length; i++)
                {
                    if (!(list[i] is double d)) return false;
                    into[i] = d;
                }
                return true;
            }

            private byte[] KeyBytes(string key)
            {
                if (keyBytes.TryGetValue(key, out var bytes)) return bytes;
                if (keyBytes.Count >= KeysKept) keyBytes.Clear();
                bytes = GxphNative.Utf8(key);
                keyBytes[key] = bytes;
                return bytes;
            }

            public string StateHash()
            {
                if (handle == IntPtr.Zero) return "";
                var b = default(GxphNative.Bytes);
                if (GxphNative.gxph_world_state_hash(handle, ref b) != GxphNative.Ok) return "";
                return Encoding.UTF8.GetString(reply, 0, GxphNative.TakeInto(ref b, ref reply));
            }

            public string PhysicsHash()
            {
                if (handle == IntPtr.Zero) return "";
                var b = default(GxphNative.Bytes);
                return GxphNative.gxph_world_physics_hash(handle, ref b) == GxphNative.Ok ? GxphNative.TakeText(ref b) : "";
            }

            public void Free()
            {
                if (handle == IntPtr.Zero) return;
                GxphNative.gxph_world_free(handle);
                handle = IntPtr.Zero;
            }

            // ---- the tick frame (genex-physics-binding tick.rs: little-endian; a str is a u32 byte length, then UTF-8) ----

            public void QueueKinematicPose(string key, double px, double py, double pz, double qx, double qy, double qz, double qw) =>
                queue.Add(new Queued { Key = key, A = px, B = py, C = pz, D = qx, E = qy, F = qz, G = qw });

            public void QueueVelocity(string key, double vx, double vy, double vz) =>
                queue.Add(new Queued { Velocity = true, Key = key, A = vx, B = vy, C = vz });

            public GenexPhysicsResult StepFrame(List<string> escaped)
            {
                escaped?.Clear();
                if (handle == IntPtr.Zero)
                {
                    queue.Clear();
                    return Gone();
                }
                if (!framesRefused && EncodeFrame())
                {
                    var b = default(GxphNative.Bytes);
                    var r = GxphNative.gxph_world_tick_frame(handle, request, new UIntPtr((uint)requestLength), ref b);
                    if (r != GxphNative.Ok)
                    {
                        queue.Clear();
                        return Refused("gxph_world_tick_frame", r);
                    }
                    var length = GxphNative.TakeInto(ref b, ref reply);
                    if (length > 0)
                    {
                        queue.Clear();
                        return ReadFrame(length, escaped);
                    }
                    // An empty reply: the library could not read the frame and ran nothing of it.
                    framesRefused = true;
                }
                // The JSON calls, as the frame would have made them.
                foreach (var c in queue)
                {
                    if (c.Velocity) SetVelocity(c.Key, new[] { c.A, c.B, c.C }, null);
                    else SetNextKinematicPose(c.Key, new[] { c.A, c.B, c.C }, new[] { c.D, c.E, c.F, c.G });
                }
                queue.Clear();
                return Step(escaped);
            }

            private void Ensure(int more)
            {
                if (requestLength + more <= request.Length) return;
                var grown = new byte[Math.Max(request.Length * 2, requestLength + more)];
                Buffer.BlockCopy(request, 0, grown, 0, requestLength);
                request = grown;
            }

            private void PutByte(byte v)
            {
                Ensure(1);
                request[requestLength++] = v;
            }

            private void PutU32(uint v)
            {
                Ensure(4);
                request[requestLength++] = (byte)v;
                request[requestLength++] = (byte)(v >> 8);
                request[requestLength++] = (byte)(v >> 16);
                request[requestLength++] = (byte)(v >> 24);
            }

            private void PutF64(double v)
            {
                Ensure(8);
                var bits = (ulong)BitConverter.DoubleToInt64Bits(v);
                for (var i = 0; i < 8; i++) request[requestLength++] = (byte)(bits >> (8 * i));
            }

            /// <summary>A name or a string value: its UTF-8 bytes.</summary>
            private void PutStr(byte[] utf8)
            {
                PutU32((uint)utf8.Length);
                Ensure(utf8.Length);
                Buffer.BlockCopy(utf8, 0, request, requestLength, utf8.Length);
                requestLength += utf8.Length;
            }

            private const byte TagNumber = 3, TagString = 4, TagArray = 5, TagObject = 6;
            private static readonly byte[] NamePose = GxphNative.Utf8("setNextKinematicPose"), NameVelocity = GxphNative.Utf8("setVelocity"),
                NameKey = GxphNative.Utf8("key"), NamePoseField = GxphNative.Utf8("pose"), NameP = GxphNative.Utf8("p"), NameQ = GxphNative.Utf8("q"),
                NameLinvel = GxphNative.Utf8("linvel");

            /// <summary>A number as the core reads it from the JSON encoder's text (GenexPhysicsJson.NumberText): its float32,
            /// NaN and +Infinity as 1e39, −Infinity as −1e39, −0 as −0.</summary>
            private void PutNumber(double v)
            {
                PutByte(TagNumber);
                var f = (float)v;
                if (float.IsNaN(f) || float.IsPositiveInfinity(f)) PutF64(1e39);
                else if (float.IsNegativeInfinity(f)) PutF64(-1e39);
                else PutF64(f);
            }

            /// <summary>The request for the queued commands, one step and no export; false when a key cannot cross as a value
            /// (null, or a lone UTF-16 surrogate, whose JSON text the core refuses whole): the JSON calls then run them.</summary>
            private bool EncodeFrame()
            {
                foreach (var c in queue)
                {
                    if (c.Key == null) return false;
                    var key = c.Key;
                    for (var i = 0; i < key.Length; i++) if (char.IsSurrogate(key[i])) return false;
                }
                requestLength = 0;
                PutU32(queue.Count > 0 ? 1u : 0u);
                if (queue.Count > 0)
                {
                    PutByte(0); // a value
                    PutByte(TagArray);
                    PutU32((uint)queue.Count);
                    foreach (var c in queue)
                    {
                        PutByte(TagObject);
                        PutU32(1);
                        PutStr(c.Velocity ? NameVelocity : NamePose);
                        PutByte(TagObject);
                        PutU32(2);
                        PutStr(NameKey);
                        PutByte(TagString);
                        PutStr(KeyBytes(c.Key));
                        if (c.Velocity)
                        {
                            PutStr(NameLinvel);
                            PutByte(TagArray);
                            PutU32(3);
                            PutNumber(c.A);
                            PutNumber(c.B);
                            PutNumber(c.C);
                        }
                        else
                        {
                            PutStr(NamePoseField);
                            PutByte(TagObject);
                            PutU32(2);
                            PutStr(NameP);
                            PutByte(TagArray);
                            PutU32(3);
                            PutNumber(c.A);
                            PutNumber(c.B);
                            PutNumber(c.C);
                            PutStr(NameQ);
                            PutByte(TagArray);
                            PutU32(4);
                            PutNumber(c.D);
                            PutNumber(c.E);
                            PutNumber(c.F);
                            PutNumber(c.G);
                        }
                    }
                }
                PutByte(1); // step
                PutF64(-1); // no export
                PutByte(0); // no queries
                return true;
            }

            /// <summary>The frame's reply: the batch's results (dropped), the step's result and its escaped keys.</summary>
            private GenexPhysicsResult ReadFrame(int length, List<string> escaped)
            {
                var at = 0;
                try
                {
                    var batches = U32(ref at, length);
                    for (var i = 0; i < batches; i++)
                    {
                        if (Byte(ref at, length) == 0) SkipFailure(ref at, length);
                        else
                        {
                            var results = U32(ref at, length);
                            for (var j = 0; j < results; j++) if (Byte(ref at, length) == 1) SkipStr(ref at, length);
                        }
                    }
                    switch (Byte(ref at, length))
                    {
                        case 1:
                            var code = Str(ref at, length);
                            if (Byte(ref at, length) == 1) at += 8;
                            return GenexPhysicsResult.Failure(code, Str(ref at, length));
                        case 2:
                            at += 8; // the tick
                            var events = U32(ref at, length);
                            for (var i = 0; i < events; i++) SkipEvent(ref at, length);
                            at += 1; // overflowed
                            var count = U32(ref at, length);
                            for (var i = 0; i < count; i++)
                            {
                                var n = (int)U32(ref at, length);
                                if (at + n > length) throw new IndexOutOfRangeException();
                                escaped?.Add(Encoding.UTF8.GetString(reply, at, n));
                                at += n;
                            }
                            return GenexPhysicsResult.Success();
                        default:
                            return GenexPhysicsResult.Failure("internal", "a tick frame without its step");
                    }
                }
                catch (IndexOutOfRangeException)
                {
                    return GenexPhysicsResult.Failure("internal", "a tick frame reply cut short");
                }
            }

            private byte Byte(ref int at, int length)
            {
                if (at >= length) throw new IndexOutOfRangeException();
                return reply[at++];
            }

            private uint U32(ref int at, int length)
            {
                if (at + 4 > length) throw new IndexOutOfRangeException();
                var v = (uint)(reply[at] | reply[at + 1] << 8 | reply[at + 2] << 16 | reply[at + 3] << 24);
                at += 4;
                return v;
            }

            private void SkipStr(ref int at, int length)
            {
                var n = (int)U32(ref at, length);
                if (n < 0 || at + n > length) throw new IndexOutOfRangeException();
                at += n;
            }

            private string Str(ref int at, int length)
            {
                var n = (int)U32(ref at, length);
                if (n < 0 || at + n > length) throw new IndexOutOfRangeException();
                var text = Encoding.UTF8.GetString(reply, at, n);
                at += n;
                return text;
            }

            private void SkipFailure(ref int at, int length)
            {
                SkipStr(ref at, length);
                if (Byte(ref at, length) == 1) at += 8;
                SkipStr(ref at, length);
            }

            private void SkipEvent(ref int at, int length)
            {
                var kind = Byte(ref at, length);
                for (var i = 0; i < 4; i++) SkipStr(ref at, length);
                for (var i = 0; i < 2; i++) if (Byte(ref at, length) == 1) SkipStr(ref at, length);
                if (kind == 0) at += 7 * 8; // contactBegin: impulse, point, normal
                if (at > length) throw new IndexOutOfRangeException();
            }
        }

        /// <summary>
        /// A body state reply (<c>{"p":[..],"q":[..],"v":[..],"w":[..],"sleeping":b,"rest":n}</c>) read without building its JSON
        /// tree. Every number the core returns is a float32 written as that float64 (genex-physics-binding output.rs), so a
        /// number of up to 15 significant digits is read in one exact IEEE operation, and a longer one is read close and taken
        /// as the float32 it is within a few ulps of; anything else, any other form, goes to the full reader.
        /// </summary>
        internal static class ReplyNumbers
        {
            private static readonly double[] Pow10 =
            {
                1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
            };

            public static bool ReadBodyState(byte[] b, int length, GenexWireBodyState into)
            {
                var at = 0;
                if (length < 2 || b[at++] != (byte)'{') return false;
                var seen = 0;
                while (at < length)
                {
                    if (b[at] == (byte)'}') return at + 1 == length && seen == 0x3f;
                    if (b[at] == (byte)',') at++;
                    if (at >= length || b[at] != (byte)'"') return false;
                    var start = ++at;
                    while (at < length && b[at] != (byte)'"') at++;
                    if (at + 1 >= length || b[at + 1] != (byte)':') return false;
                    var name = Name(b, start, at - start);
                    at += 2;
                    switch (name)
                    {
                        case 'p':
                            if (!Numbers(b, ref at, length, into.P)) return false;
                            seen |= 1;
                            break;
                        case 'q':
                            if (!Numbers(b, ref at, length, into.Q)) return false;
                            seen |= 2;
                            break;
                        case 'v':
                            if (!Numbers(b, ref at, length, into.V)) return false;
                            seen |= 4;
                            break;
                        case 'w':
                            if (!Numbers(b, ref at, length, into.W)) return false;
                            seen |= 8;
                            break;
                        case 's':
                            if (Matches(b, at, length, "true")) { into.Sleeping = true; at += 4; }
                            else if (Matches(b, at, length, "false")) { into.Sleeping = false; at += 5; }
                            else return false;
                            seen |= 16;
                            break;
                        case 'r':
                            if (!Number(b, ref at, length, out var rest)) return false;
                            into.Rest = rest;
                            seen |= 32;
                            break;
                        default: return false;
                    }
                }
                return false;
            }

            /// <summary>The member's letter: p, q, v, w, s (sleeping) or r (rest); '\0' for any other name.</summary>
            private static char Name(byte[] b, int start, int count)
            {
                if (count == 1) return b[start] == (byte)'p' || b[start] == (byte)'q' || b[start] == (byte)'v' || b[start] == (byte)'w' ? (char)b[start] : '\0';
                if (count == 8 && Matches(b, start, start + 8, "sleeping")) return 's';
                if (count == 4 && Matches(b, start, start + 4, "rest")) return 'r';
                return '\0';
            }

            private static bool Matches(byte[] b, int at, int length, string text)
            {
                if (at + text.Length > length) return false;
                for (var i = 0; i < text.Length; i++) if (b[at + i] != (byte)text[i]) return false;
                return true;
            }

            private static bool Numbers(byte[] b, ref int at, int length, double[] into)
            {
                if (at >= length || b[at++] != (byte)'[') return false;
                for (var i = 0; i < into.Length; i++)
                {
                    if (i > 0 && (at >= length || b[at++] != (byte)',')) return false;
                    if (!Number(b, ref at, length, out into[i])) return false;
                }
                return at < length && b[at++] == (byte)']';
            }

            /// <summary>A JSON number at <paramref name="at"/>: exact for up to 15 significant digits and a power of ten up to
            /// 1e22 (one IEEE operation, as GenexJson's reader), else the float32 a close reading is within 16 ulps of; the
            /// rest through GenexJson's exact reader.</summary>
            internal static bool Number(byte[] b, ref int at, int length, out double value)
            {
                value = 0;
                var start = at;
                var negative = false;
                if (at < length && b[at] == (byte)'-')
                {
                    negative = true;
                    at++;
                }
                ulong mantissa = 0;
                int digits = 0, exponent = 0;
                var seenDigit = false;
                var tooLong = false;
                for (; at < length && b[at] >= (byte)'0' && b[at] <= (byte)'9'; at++)
                {
                    seenDigit = true;
                    if (digits == 0 && b[at] == (byte)'0') continue;
                    if (digits < 19) mantissa = mantissa * 10 + (ulong)(b[at] - '0');
                    else
                    {
                        exponent++;
                        if (b[at] != (byte)'0') tooLong = true;
                    }
                    digits++;
                }
                if (at < length && b[at] == (byte)'.')
                {
                    at++;
                    for (; at < length && b[at] >= (byte)'0' && b[at] <= (byte)'9'; at++)
                    {
                        seenDigit = true;
                        if (digits == 0 && b[at] == (byte)'0')
                        {
                            exponent--;
                            continue;
                        }
                        if (digits < 19)
                        {
                            mantissa = mantissa * 10 + (ulong)(b[at] - '0');
                            exponent--;
                        }
                        else if (b[at] != (byte)'0') tooLong = true;
                        digits++;
                    }
                }
                if (!seenDigit) return false;
                if (at < length && (b[at] == (byte)'e' || b[at] == (byte)'E'))
                {
                    at++;
                    var expNegative = false;
                    if (at < length && (b[at] == (byte)'-' || b[at] == (byte)'+')) expNegative = b[at++] == (byte)'-';
                    var e = 0;
                    var any = false;
                    for (; at < length && b[at] >= (byte)'0' && b[at] <= (byte)'9'; at++)
                    {
                        any = true;
                        if (e < 100000) e = e * 10 + (b[at] - '0');
                    }
                    if (!any) return false;
                    exponent += expNegative ? -e : e;
                }
                if (mantissa == 0 && !tooLong)
                {
                    value = negative ? -0.0 : 0.0;
                    return true;
                }
                while (mantissa % 10 == 0)
                {
                    mantissa /= 10;
                    exponent++;
                }
                var significant = 0;
                for (var m = mantissa; m > 0; m /= 10) significant++;
                if (!tooLong && significant <= 15 && exponent >= -22 && exponent <= 22)
                {
                    var exact = exponent >= 0 ? mantissa * Pow10[exponent] : mantissa / Pow10[-exponent];
                    value = negative ? -exact : exact;
                    return true;
                }
                if (!tooLong && exponent >= -60 && exponent <= 60)
                {
                    // Within a few ulps: (double)mantissa rounds once, each power of ten (exact to 1e22) once more.
                    double close = mantissa;
                    var e = exponent;
                    while (e > 22) { close *= 1e22; e -= 22; }
                    while (e < -22) { close /= 1e22; e += 22; }
                    close = e >= 0 ? close * Pow10[e] : close / Pow10[-e];
                    var f = (double)(float)close;
                    if (!double.IsInfinity(f) && f != 0 && Math.Abs(close - f) <= Math.Abs(f) * 1.7763568394002505e-15)
                    {
                        value = negative ? -f : f;
                        return true;
                    }
                }
                var text = Encoding.ASCII.GetString(b, start, at - start);
                try { value = GenexJson.DecimalNumber.Parse(text, 0, text.Length); }
                catch (FormatException) { return false; }
                return true;
            }
        }
    }
}
