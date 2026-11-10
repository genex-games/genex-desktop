// The fast channel (PROTOCOL.md §17.12, cap `fast@1`): a seat's inputs and motion state on an unordered,
// unreliable datagram path (raw UDP for the engines) beside the WebSocket. Each uplink datagram carries the
// seat's last inputs (the redundant window) and its presses not yet acknowledged, so a lost datagram costs
// nothing the next one does not carry; the server keeps the first copy of each seq and fills a gap no
// datagram covered with the last input held. Downlink snapshots are deltas against the snapshot the seat
// acknowledged, fragmented under one datagram, and a lost one is replaced by the next.
//
// Pure: no I/O, no clock. A port of the TypeScript reference (packages/multiplayer/src/authority/
// fast-transport.ts), held to packages/multiplayer/test/vectors/fast-transport.json by `GenexSmoke
// fast-transport` (FastTransportCheck.cs). A refusal never changes state: each function answers the state
// it was given, the very same object. Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace Genex.Multiplayer.Authority
{
    /// <summary>The fast channel's tunables (§17.12 *Tunables*), each with its reason.</summary>
    public static class GenexFast
    {
        /// <summary>The datagram format's version, the first byte of every datagram.</summary>
        public const byte Version = 1;
        /// <summary>No datagram is longer: the IPv6 minimum MTU (1280) less IP, UDP and QUIC headers.</summary>
        public const int MaxDatagramBytes = 1200;
        /// <summary>The binding key's length: 8 random bytes per socket, sent on the reliable channel at join.</summary>
        public const int KeyBytes = 8;
        /// <summary>The redundant window as time: the longest delay episode measured on `real-mac-wifi` (70–170 ms).</summary>
        public const double InputRedundancyMs = 170;
        /// <summary>The window's least inputs: two datagrams lost in a row are recovered at any tick rate.</summary>
        public const int InputRedundancyMin = 3;
        /// <summary>The window's most inputs, and the most a datagram may carry: 32 full slots and 8 actions still fit 1200 bytes.</summary>
        public const int InputRedundancyMax = 32;
        /// <summary>Presses past the window awaiting the server's ack that one datagram carries (the oldest).</summary>
        public const int MaxActions = 8;
        /// <summary>The longest gap the server fills with the last input held; a longer one is skipped.</summary>
        public const double GapFillMs = 250;
        /// <summary>A datagram whose newest seq is more than this far (as ticks) past the last accepted is dropped.</summary>
        public const double SeqAheadMs = 5000;
        /// <summary>Snapshots each side holds as bases: 533 ms at 60 Hz, over a 409 ms p99 round trip plus an episode.</summary>
        public const int SnapshotHistory = 32;
        /// <summary>The most fragments one snapshot may have (about 37 KB); a larger body is not sent on this channel.</summary>
        public const int MaxFragments = 32;
        /// <summary>Incomplete snapshots a client gathers at once; the oldest gives way.</summary>
        public const int ReassemblySlots = 4;
        /// <summary>One record's most bytes.</summary>
        public const int MaxRecordBytes = 1024;
        /// <summary>A client with no snapshot this long after its first datagram falls back to the WebSocket.</summary>
        public const double HandshakeMs = 1000;
        /// <summary>A client with no snapshot for this long falls back to the WebSocket.</summary>
        public const double StallFallbackMs = 2000;
        /// <summary>A seat with nothing to send sends an empty uplink this often while snapshots reach it (§17.12
        /// <i>Keepalive</i>): under SnapshotHistory snapshots at 120 Hz, far under any NAT timer measured.</summary>
        public const double KeepaliveMs = 250;
        /// <summary>Likewise before its first snapshot.</summary>
        public const double KeepaliveBindMs = 50;
        /// <summary>A snapshot changing this many records is acknowledged as it lands by a seat with nothing else to send.</summary>
        public const int AckEagerRecords = 32;
        /// <summary>No eager ack within this long of another uplink: a seat sending inputs every frame sends none.</summary>
        public const double AckEagerGapMs = 20;
        /// <summary>A snapshot id at least this far past the client's newest is a return-path challenge: echoed at once.</summary>
        public const uint ChallengeJump = 65536;
        /// <summary>No frame for this long: the deadlines' clocks did not run.</summary>
        public const double FrameGapMs = 250;
        /// <summary>The binding's <c>rev</c> from a host that takes empty uplinks, challenges addresses and offers fresh bindings.</summary>
        public const int BindRev = 2;
        /// <summary>Snapshots a seat applies on a fresh binding before its inputs and motion move to it.</summary>
        public const int ReturnProof = 3;
        /// <summary>A retry's delay at attempt 0, before jitter.</summary>
        public const double RetryBaseMs = 1000;
        /// <summary>Its most, before jitter.</summary>
        public const double RetryMaxMs = 60000;
        /// <summary>A seat that held the channel this long starts its next backoff from attempt 0.</summary>
        public const double ReturnStableMs = 30000;

        /// <summary>The delay before retry number <paramref name="attempt"/> (from 0), jittered by <paramref name="unit"/> in
        /// [0, 1): doubling from RetryBaseMs to RetryMaxMs, half of it random, so seats behind one failed link do not come
        /// back as one.</summary>
        public static double RetryDelayMs(int attempt, double unit)
        {
            var full = Math.Min(RetryMaxMs, RetryBaseMs * Math.Pow(2, Math.Min(attempt, 16)));
            return full / 2 + full / 2 * unit;
        }
    }

    /// <summary>The reliable messages of the fast channel (§17.12): the server's binding at join and the client's
    /// fallback. Reserved names (<c>__</c>), so no game event can be mistaken for one.</summary>
    public static class GenexFastMessage
    {
        /// <summary>Server → client: <c>{ sid, key, url }</c>, the seat's binding.</summary>
        public const string Bind = "__fast";
        /// <summary>Client → server: <c>{ last }</c>, the last seq the client sent by datagram; its inputs go by the
        /// WebSocket from now on. Server → client (<c>{}</c>): end the channel.</summary>
        public const string Off = "__fast:off";
        /// <summary>Client → server: <c>{}</c>, a seat off the channel asks for a fresh binding.</summary>
        public const string Again = "__fast:again";
        /// <summary>Client → server: <c>{ last }</c>, the last seq sent by WebSocket; its inputs go by datagram from now on.</summary>
        public const string On = "__fast:on";
    }

    /// <summary>The datagram kinds, the second byte.</summary>
    public static class GenexFastKind
    {
        public const byte Uplink = 1;
        public const byte Snapshot = 2;
    }

    /// <summary>Why a datagram or a value was refused (the wire spelling of TypeScript's <c>FastFault</c>).</summary>
    public static class GenexFastFault
    {
        public const string Oversized = "oversized";
        public const string Truncated = "truncated";
        public const string Trailing = "trailing";
        public const string Version = "version";
        public const string Kind = "kind";
        public const string Session = "session";
        public const string Key = "key";
        public const string Count = "count";
        public const string Fresh = "fresh";
        public const string Actions = "actions";
        public const string Flags = "flags";
        public const string Order = "order";
        public const string Field = "field";
        public const string Ahead = "ahead";
        public const string Fragment = "fragment";
        public const string Mismatch = "mismatch";
        public const string Duplicate = "duplicate";
        public const string Keyframe = "keyframe";
        public const string Body = "body";
        public const string Base = "base";
        public const string Stale = "stale";
    }

    /// <summary>How the server came by an accepted input.</summary>
    public static class GenexAcceptKind
    {
        /// <summary>First sent in the datagram that brought it.</summary>
        public const string Fresh = "fresh";
        /// <summary>Sent first in an earlier datagram that was lost; carried again by redundancy or as an action.</summary>
        public const string Recovered = "recovered";
        /// <summary>No datagram the server got carried it: the last input held stands in for it.</summary>
        public const string Fill = "fill";
    }

    /// <summary>A value or the fault that refused it (TypeScript <c>FastResult</c>).</summary>
    public sealed class GenexFastResult<T>
    {
        public readonly bool Ok;
        public readonly T Value;
        /// <summary>Null when <see cref="Ok"/>.</summary>
        public readonly string Fault;

        private GenexFastResult(bool ok, T value, string fault)
        {
            Ok = ok;
            Value = value;
            Fault = fault;
        }

        public static GenexFastResult<T> Of(T value) => new GenexFastResult<T>(true, value, null);
        public static GenexFastResult<T> Fail(string fault) => new GenexFastResult<T>(false, default(T), fault);
    }

    /// <summary>One input on the wire: its client sequence, its <c>tick@1</c> field, its payload and its render time.</summary>
    public sealed class GenexFastInput
    {
        public uint Seq;
        public ushort Tick;
        public GenexInput Input;
        /// <summary>The render time its sender drew the world at when it sent it (§17.5): the room clock, whole ms, as its
        /// WebSocket input frame's stamp would carry it; 0: not stamped (no synced clock).</summary>
        public uint Render;

        public GenexFastInput(uint seq, ushort tick, GenexInput input, uint render = 0)
        {
            Seq = seq;
            Tick = tick;
            Input = input;
            Render = render;
        }

        /// <summary>A copy that shares nothing with this one.</summary>
        public GenexFastInput Clone() => new GenexFastInput(Seq, Tick, GenexFastTransport.CopyInput(Input), Render);
    }

    /// <summary>An uplink datagram's content. <see cref="Window"/> is contiguous, oldest first; <see cref="Actions"/>
    /// ascend below it.</summary>
    public sealed class GenexFastUplink
    {
        public uint Sid;
        /// <summary>The binding key as 16 lowercase hex digits.</summary>
        public string Key;
        public uint AckSnap;
        public int Fresh;
        public List<GenexFastInput> Actions = new List<GenexFastInput>();
        public List<GenexFastInput> Window = new List<GenexFastInput>();
    }

    /// <summary>A seat's fast-channel binding, from the reliable <c>__fast</c> message.</summary>
    public sealed class GenexFastBinding
    {
        public uint Sid;
        /// <summary>16 lowercase hex digits.</summary>
        public string Key;

        public GenexFastBinding(uint sid, string key)
        {
            Sid = sid;
            Key = key;
        }
    }

    /// <summary>What <see cref="GenexFastTransport.UplinkFor"/> needs beside the inputs.</summary>
    public sealed class GenexUplinkOptions
    {
        public uint Sid;
        public string Key;
        /// <summary>The newest snapshot the client applied.</summary>
        public uint AckSnap;
        /// <summary>The server's last accepted input seq, from the newest applied snapshot's <c>inputAck</c>.</summary>
        public uint InputAck;
        /// <summary>How many of the newest inputs this datagram sends first.</summary>
        public int Fresh;
        public double TickHz;
    }

    /// <summary>A seat's receive state on the server: the last accepted seq, the last accepted input (null before
    /// the first) and the newest snapshot the seat acknowledged.</summary>
    public sealed class GenexFastSeatRx
    {
        public uint Last;
        public GenexInput Input;
        public uint AckSnap;

        public GenexFastSeatRx(uint last, GenexInput input, uint ackSnap)
        {
            Last = last;
            Input = input;
            AckSnap = ackSnap;
        }
    }

    /// <summary>One input the server accepted, sanitized, in seq order, with the render time lag compensation judges it at
    /// (0: unstamped; a filled input takes the one of the input after its gap).</summary>
    public sealed class GenexAcceptedInput
    {
        public uint Seq;
        public ushort Tick;
        public uint Render;
        public GenexInput Input;
        /// <summary>A <see cref="GenexAcceptKind"/> value.</summary>
        public string Kind;
    }

    /// <summary>What <see cref="GenexFastTransport.AcceptUplink"/> made of one datagram.</summary>
    public sealed class GenexAcceptResult
    {
        /// <summary>The very seat given when nothing changed.</summary>
        public GenexFastSeatRx Seat;
        public List<GenexAcceptedInput> Accepted = new List<GenexAcceptedInput>();
        /// <summary>Seqs consumed without a step: a gap longer than <see cref="GenexFastTransport.GapFillMax"/>.</summary>
        public long Skipped;
        /// <summary>Set when the whole datagram was dropped; <see cref="Seat"/> is then the very one given.</summary>
        public string Fault;
    }

    /// <summary>One motion record of a snapshot: its record key and the record codec's bytes.</summary>
    public sealed class GenexFastRecord
    {
        public ushort Key;
        public byte[] Bytes;

        public GenexFastRecord(ushort key, byte[] bytes)
        {
            Key = key;
            Bytes = bytes;
        }
    }

    /// <summary>A snapshot body: the keys removed since the base, then the records new or changed.</summary>
    public sealed class GenexSnapshotBody
    {
        public List<ushort> Removed = new List<ushort>();
        public List<GenexFastRecord> Records = new List<GenexFastRecord>();
    }

    /// <summary>The snapshot header the server writes. <c>Base</c> 0 is a keyframe.</summary>
    public sealed class GenexSnapshotHead
    {
        public uint Sid;
        public uint Snap;
        public uint Base;
        public uint Tick;
        public uint InputAck;
        /// <summary>The room clock (ms since room start, §16.1 <c>sNow</c>, truncated to a uint32) when the server
        /// wrote the snapshot: the value a WebSocket patch's TIMED prefix carries, so a fast seat's clock samples
        /// exactly what a WebSocket seat's does (the tick's nominal instant is up to a step earlier).</summary>
        public uint Sent;
    }

    /// <summary>One decoded snapshot fragment.</summary>
    public sealed class GenexFastFragment
    {
        public uint Snap;
        public uint Base;
        public uint Tick;
        public uint InputAck;
        public uint Sent;
        public bool Keyframe;
        public int Frag;
        public int Frags;
        public byte[] Chunk;
    }

    /// <summary>An applied snapshot the client holds as a base.</summary>
    public sealed class GenexHeldSnapshot
    {
        public uint Snap;
        public uint Tick;
        public uint InputAck;
        public uint Sent;
        public IReadOnlyList<GenexFastRecord> Records;
    }

    /// <summary>A snapshot being gathered: its first fragment's header and the chunks so far (null: not yet).</summary>
    public sealed class GenexPartialSnapshot
    {
        public uint Snap;
        public uint Base;
        public uint Tick;
        public uint InputAck;
        public uint Sent;
        public bool Keyframe;
        public int Frags;
        public IReadOnlyList<byte[]> Chunks;

        internal GenexPartialSnapshot With(int frag, byte[] chunk)
        {
            var chunks = Chunks.ToArray();
            chunks[frag] = chunk;
            return new GenexPartialSnapshot { Snap = Snap, Base = Base, Tick = Tick, InputAck = InputAck, Sent = Sent, Keyframe = Keyframe, Frags = Frags, Chunks = chunks };
        }
    }

    /// <summary>The client's receive state: sets being gathered (ascending), applied snapshots held as bases (oldest
    /// first, at most <see cref="GenexFast.SnapshotHistory"/>) and the newest applied id (0: none). Never changed in
    /// place: <see cref="GenexFastTransport.ReceiveFragment"/> answers a new one, or the very one given.</summary>
    public sealed class GenexFastClientRx
    {
        public readonly IReadOnlyList<GenexPartialSnapshot> Partials;
        public readonly IReadOnlyList<GenexHeldSnapshot> History;
        public readonly uint Newest;

        public GenexFastClientRx(IReadOnlyList<GenexPartialSnapshot> partials, IReadOnlyList<GenexHeldSnapshot> history, uint newest)
        {
            Partials = partials;
            History = history;
            Newest = newest;
        }

        public static GenexFastClientRx Empty() => new GenexFastClientRx(new GenexPartialSnapshot[0], new GenexHeldSnapshot[0], 0);
    }

    /// <summary>What one snapshot datagram did at the client.</summary>
    public sealed class GenexFastRxResult
    {
        public GenexFastClientRx Rx;
        /// <summary>The snapshot this fragment completed and applied, else null.</summary>
        public uint? Applied;
        public string Fault;
    }

    /// <summary>The fast channel's codecs and decisions (§17.12).</summary>
    public static class GenexFastTransport
    {
        private const int UplinkHeader = 29;
        /// <summary>A slot's <c>back</c> when it carries no render time (unstamped, or more than 254 ms behind the header's).</summary>
        private const int BackNone = 255;
        /// <summary>An action: seq uint32, tick uint16, render uint32, then the payload.</summary>
        private const int ActionHead = 10;
        private const int SnapshotHeader = 29;
        private const int Payload = 24;
        private const int SlotSame = 1;
        private const int SlotTickSame = 2;
        private const int SlotTickNext = 4;
        private const int SlotFlags = SlotSame | SlotTickSame | SlotTickNext;
        private const double Uint32Max = 4294967295.0;
        private const long TickMod = 65536;
        private const byte KeyframeFlag = 1;

        // ---- small helpers ----

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        private static int TicksOf(double ms, double tickHz) => (int)Math.Ceiling(ms * (IsFinite(tickHz) && tickHz > 0 ? tickHz : 0) / 1000);

        private static bool IsUint(double v, double max) => IsFinite(v) && v == Math.Floor(v) && v >= 0 && v <= max;

        /// <summary>The redundant window at <paramref name="tickHz"/>: <see cref="GenexFast.InputRedundancyMs"/> of inputs,
        /// within its bounds.</summary>
        public static int InputRedundancyTicks(double tickHz) =>
            Math.Min(GenexFast.InputRedundancyMax, Math.Max(GenexFast.InputRedundancyMin, TicksOf(GenexFast.InputRedundancyMs, tickHz)));

        /// <summary>The longest gap filled at <paramref name="tickHz"/> (<see cref="GenexFast.GapFillMs"/> of ticks).</summary>
        public static int GapFillMax(double tickHz) => TicksOf(GenexFast.GapFillMs, tickHz);

        /// <summary>The farthest a datagram's newest seq may be past the last accepted at <paramref name="tickHz"/>.</summary>
        public static int SeqAheadMax(double tickHz) => TicksOf(GenexFast.SeqAheadMs, tickHz);

        /// <summary>A number the wire carries as a uint32: an integer in [0, 2^32); anything else is refused (<c>field</c>).
        /// A typed port's door for values a JSON or a game hands it.</summary>
        public static bool WireU32(double v, out uint value)
        {
            value = IsUint(v, Uint32Max) ? (uint)v : 0;
            return IsUint(v, Uint32Max);
        }

        /// <summary>A number the wire carries as a uint16: an integer in [0, 65536); anything else is refused.</summary>
        public static bool WireU16(double v, out ushort value)
        {
            value = IsUint(v, 65535) ? (ushort)v : (ushort)0;
            return IsUint(v, 65535);
        }

        /// <summary>Lowercase hex of <paramref name="bytes"/>.</summary>
        public static string ToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static int HexDigit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }

        /// <summary>The bytes of hex text <paramref name="hex"/> (an even count of hex digits; anything else reads as no bytes).</summary>
        public static byte[] FromHex(string hex)
        {
            if (hex == null || hex.Length % 2 != 0) return new byte[0];
            var out_ = new byte[hex.Length / 2];
            for (var i = 0; i < out_.Length; i++)
            {
                var hi = HexDigit(hex[2 * i]);
                var lo = HexDigit(hex[2 * i + 1]);
                if (hi < 0 || lo < 0) return new byte[0];
                out_[i] = (byte)((hi << 4) | lo);
            }
            return out_;
        }

        /// <summary>Whether <paramref name="key"/> is a binding key: <see cref="GenexFast.KeyBytes"/> bytes as lowercase hex.</summary>
        public static bool IsKey(string key)
        {
            if (key == null || key.Length != 2 * GenexFast.KeyBytes) return false;
            foreach (var c in key)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        /// <summary>A copy of <paramref name="input"/> (null: null).</summary>
        public static GenexInput CopyInput(GenexInput input)
        {
            if (input == null) return null;
            var copy = new GenexInput();
            copy.CopyFrom(input);
            return copy;
        }

        /// <summary>JavaScript's ToUint32 of a number (the bits <c>&amp;</c> and <c>~</c> work on): NaN and ±∞ → 0, else the
        /// integer part modulo 2^32.</summary>
        private static uint JsUint32(double v)
        {
            if (!IsFinite(v)) return 0;
            var t = Math.Truncate(v);
            var m = t - 4294967296.0 * Math.Floor(t / 4294967296.0);
            return (uint)m;
        }

        /// <summary>An input whose buttons gain a bit over <paramref name="previous"/>'s (null: none held).</summary>
        public static bool IsPress(GenexInput previous, GenexInput input) =>
            (JsUint32(input.Buttons) & ~(previous == null ? 0u : JsUint32(previous.Buttons))) != 0;

        // ---- little-endian bytes ----

        private static void PutU16(byte[] b, int at, uint v)
        {
            b[at] = (byte)v;
            b[at + 1] = (byte)(v >> 8);
        }

        private static void PutU32(byte[] b, int at, uint v)
        {
            b[at] = (byte)v;
            b[at + 1] = (byte)(v >> 8);
            b[at + 2] = (byte)(v >> 16);
            b[at + 3] = (byte)(v >> 24);
        }

        /// <summary>A float32's bits (BitConverter.SingleToInt32Bits is not in every Unity API compatibility level).</summary>
        [StructLayout(LayoutKind.Explicit)]
        private struct F32Bits
        {
            [FieldOffset(0)] public float Float;
            [FieldOffset(0)] public uint Bits;
        }

        private static void PutF32(byte[] b, int at, double v) => PutU32(b, at, new F32Bits { Float = (float)v }.Bits);

        internal static ushort U16(byte[] b, int at) => (ushort)(b[at] | (b[at + 1] << 8));

        internal static uint U32(byte[] b, int at) => (uint)(b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24));

        internal static float F32(byte[] b, int at) => new F32Bits { Bits = U32(b, at) }.Float;

        internal static void WriteU16(byte[] b, int at, uint v) => PutU16(b, at, v);
        internal static void WriteU32(byte[] b, int at, uint v) => PutU32(b, at, v);
        internal static void WriteF32(byte[] b, int at, double v) => PutF32(b, at, v);

        private static bool F32Finite(double v)
        {
            var f = (float)v;
            return !float.IsNaN(f) && !float.IsInfinity(f);
        }

        // ---- the uplink ----

        private static bool ValidPayload(GenexInput p) =>
            p != null && F32Finite(p.MoveX) && F32Finite(p.MoveY) && F32Finite(p.MoveZ) && F32Finite(p.Yaw) && F32Finite(p.Pitch) && IsUint(p.Buttons, Uint32Max);

        private static bool ValidInput(GenexFastInput s) => s != null && s.Seq >= 1 && ValidPayload(s.Input);

        /// <summary>The seat's largest uplink at <paramref name="tickHz"/>: a full window and all its actions, each slot and
        /// action whole (§17.12 <i>WebTransport</i>: a session that cannot send it cannot carry the seat).</summary>
        public static int UplinkMaxBytes(double tickHz) => 29 + GenexFast.MaxActions * 34 + InputRedundancyTicks(tickHz) * 28;

        private static bool ValidUplink(GenexFastUplink u)
        {
            if (u == null || u.Window == null || u.Actions == null || !IsKey(u.Key)) return false;
            var window = u.Window;
            var actions = u.Actions;
            // An empty uplink (§17.12 *Keepalive*): the header alone.
            if (window.Count == 0) return u.Fresh == 0 && actions.Count == 0;
            if (window.Count > GenexFast.InputRedundancyMax || actions.Count > GenexFast.MaxActions) return false;
            if (u.Fresh < 1 || u.Fresh > window.Count) return false;
            if (!actions.All(ValidInput) || !window.All(ValidInput)) return false;
            for (var i = 1; i < window.Count; i++)
                if ((long)window[i].Seq != (long)window[i - 1].Seq + 1) return false;
            for (var i = 0; i < actions.Count; i++)
            {
                var next = i + 1 < actions.Count ? actions[i + 1].Seq : window[0].Seq;
                if (actions[i].Seq >= next) return false;
            }
            return true;
        }

        private static int WritePayload(byte[] b, int at, GenexInput p)
        {
            PutF32(b, at, p.MoveX);
            PutF32(b, at + 4, p.MoveY);
            PutF32(b, at + 8, p.MoveZ);
            PutF32(b, at + 12, p.Yaw);
            PutF32(b, at + 16, p.Pitch);
            PutU32(b, at + 20, (uint)p.Buttons);
            return at + Payload;
        }

        private static GenexInput ReadPayload(byte[] b, int at) => GenexInput.FromRaw(F32(b, at), F32(b, at + 4), F32(b, at + 8), F32(b, at + 12), F32(b, at + 16), U32(b, at + 20));

        private static bool SamePayload(GenexInput a, GenexInput b)
        {
            var x = new byte[Payload];
            var y = new byte[Payload];
            WritePayload(x, 0, a);
            WritePayload(y, 0, b);
            return x.SequenceEqual(y);
        }

        private static int SlotFlagsOf(GenexFastInput previous, GenexFastInput s)
        {
            if (previous == null) return 0;
            var flags = SamePayload(previous.Input, s.Input) ? SlotSame : 0;
            if (s.Tick == previous.Tick) flags |= SlotTickSame;
            else if (s.Tick == (previous.Tick + 1) % TickMod) flags |= SlotTickNext;
            return flags;
        }

        /// <summary>The render time a fast input carries (§17.12 <i>Render-time stamp</i>), the stamp its WebSocket input frame
        /// would carry: <c>round(serverNow) − round(renderDelay + rtt/2)</c> whole ms, the delay clamped to [0, 65535], 0 when
        /// that is not above 0 or the clock has not synced (<paramref name="serverNow"/> null).</summary>
        public static uint RenderStamp(double? serverNow, double renderDelay, double rtt)
        {
            if (serverNow == null || double.IsNaN(serverNow.Value) || double.IsInfinity(serverNow.Value)) return 0;
            // floor(x + 0.5): whole ms, the same on every port (half up, never to even).
            var now = Math.Min(Uint32Max, Math.Max(0, Math.Floor(serverNow.Value + 0.5)));
            var lead = renderDelay + (double.IsNaN(rtt) || double.IsInfinity(rtt) ? 0 : rtt) / 2;
            var delta = double.IsNaN(lead) || double.IsInfinity(lead) ? 0 : Math.Min(65535, Math.Max(0, Math.Floor(lead + 0.5)));
            return now > delta ? (uint)(now - delta) : 0;
        }

        /// <summary>Encodes uplink <paramref name="u"/> (§17.12 *Uplink datagram*); refuses (<c>field</c>) what the wire
        /// cannot carry.</summary>
        public static GenexFastResult<byte[]> EncodeUplink(GenexFastUplink u)
        {
            if (!ValidUplink(u)) return GenexFastResult<byte[]>.Fail(GenexFastFault.Field);
            var out_ = new byte[GenexFast.MaxDatagramBytes];
            out_[0] = GenexFast.Version;
            out_[1] = GenexFastKind.Uplink;
            PutU32(out_, 2, u.Sid);
            Array.Copy(FromHex(u.Key), 0, out_, 6, GenexFast.KeyBytes);
            PutU32(out_, 14, u.AckSnap);
            PutU32(out_, 18, u.Window.Count == 0 ? 0 : u.Window[u.Window.Count - 1].Seq);
            out_[22] = (byte)u.Window.Count;
            out_[23] = (byte)u.Fresh;
            out_[24] = (byte)u.Actions.Count;
            uint render = 0;
            foreach (var s in u.Window) render = Math.Max(render, s.Render);
            PutU32(out_, 25, render);
            var at = UplinkHeader;
            foreach (var a in u.Actions)
            {
                PutU32(out_, at, a.Seq);
                PutU16(out_, at + 4, a.Tick);
                PutU32(out_, at + 6, a.Render);
                at = WritePayload(out_, at + ActionHead, a.Input);
            }
            for (var i = 0; i < u.Window.Count; i++)
            {
                var s = u.Window[i];
                var flags = SlotFlagsOf(i == 0 ? null : u.Window[i - 1], s);
                out_[at] = (byte)flags;
                at += 1;
                if ((flags & (SlotTickSame | SlotTickNext)) == 0)
                {
                    PutU16(out_, at, s.Tick);
                    at += 2;
                }
                out_[at] = BackOf(render, s);
                at += 1;
                if ((flags & SlotSame) == 0) at = WritePayload(out_, at, s.Input);
            }
            var bytes = new byte[at];
            Array.Copy(out_, bytes, at);
            return GenexFastResult<byte[]>.Of(bytes);
        }

        /// <summary>The common checks of every datagram: size, version, kind, header length (null: none failed).</summary>
        private static string Frame(byte[] bytes, byte kind, int header)
        {
            if (bytes.Length > GenexFast.MaxDatagramBytes) return GenexFastFault.Oversized;
            if (bytes.Length < 2) return GenexFastFault.Truncated;
            if (bytes[0] != GenexFast.Version) return GenexFastFault.Version;
            if (bytes[1] != kind) return GenexFastFault.Kind;
            return bytes.Length < header ? GenexFastFault.Truncated : null;
        }

        /// <summary>Decodes an uplink datagram for the seat bound by <paramref name="binding"/>: checked whole, the session
        /// and key first; any fault drops it. Payloads are as sent (the server sanitizes as it accepts).</summary>
        public static GenexFastResult<GenexFastUplink> DecodeUplink(byte[] bytes, GenexFastBinding binding)
        {
            var framed = Frame(bytes, GenexFastKind.Uplink, UplinkHeader);
            if (framed != null) return GenexFastResult<GenexFastUplink>.Fail(framed);
            var sid = U32(bytes, 2);
            if (sid != binding.Sid) return GenexFastResult<GenexFastUplink>.Fail(GenexFastFault.Session);
            var keyBytes = new byte[GenexFast.KeyBytes];
            Array.Copy(bytes, 6, keyBytes, 0, GenexFast.KeyBytes);
            var key = ToHex(keyBytes);
            if (key != binding.Key) return GenexFastResult<GenexFastUplink>.Fail(GenexFastFault.Key);
            var newest = U32(bytes, 18);
            int count = bytes[22];
            int fresh = bytes[23];
            int actionCount = bytes[24];
            // An empty uplink (§17.12 *Keepalive*): every other field zero, nothing after the header. A count of 0 with
            // anything else set stays the fault it was.
            if (count == 0 && newest == 0 && fresh == 0 && actionCount == 0 && U32(bytes, 25) == 0)
            {
                if (bytes.Length != UplinkHeader) return GenexFastResult<GenexFastUplink>.Fail(GenexFastFault.Trailing);
                return GenexFastResult<GenexFastUplink>.Of(new GenexFastUplink { Sid = sid, Key = key, AckSnap = U32(bytes, 14), Fresh = 0 });
            }
            if (count < 1 || count > GenexFast.InputRedundancyMax || newest < count) return GenexFastResult<GenexFastUplink>.Fail(GenexFastFault.Count);
            if (fresh < 1 || fresh > count) return GenexFastResult<GenexFastUplink>.Fail(GenexFastFault.Fresh);
            if (actionCount > GenexFast.MaxActions) return GenexFastResult<GenexFastUplink>.Fail(GenexFastFault.Actions);
            var first = newest - (uint)count + 1;
            var u = new GenexFastUplink { Sid = sid, Key = key, AckSnap = U32(bytes, 14), Fresh = fresh };
            var fault = ReadBody(bytes, actionCount, count, first, u);
            return fault != null ? GenexFastResult<GenexFastUplink>.Fail(fault) : GenexFastResult<GenexFastUplink>.Of(u);
        }

        /// <summary>A slot's <c>back</c> against the header's render time <paramref name="render"/> (the newest of the
        /// window's).</summary>
        private static byte BackOf(uint render, GenexFastInput s) =>
            s.Render == 0 || s.Render > render || render - s.Render >= BackNone ? (byte)BackNone : (byte)(render - s.Render);

        /// <summary>The render time a slot's <c>back</c> stands for (0: unstamped).</summary>
        private static uint RenderOf(uint render, int back) => back == BackNone || render <= back ? 0 : render - (uint)back;

        private static string ReadBody(byte[] b, int actionCount, int count, uint first, GenexFastUplink u)
        {
            var render = U32(b, 25);
            var at = UplinkHeader;
            for (var i = 0; i < actionCount; i++)
            {
                if (at + ActionHead + Payload > b.Length) return GenexFastFault.Truncated;
                var seq = U32(b, at);
                if (seq < 1 || seq >= first || (i > 0 && seq <= u.Actions[i - 1].Seq)) return GenexFastFault.Order;
                u.Actions.Add(new GenexFastInput(seq, U16(b, at + 4), ReadPayload(b, at + ActionHead), U32(b, at + 6)));
                at += ActionHead + Payload;
            }
            for (var i = 0; i < count; i++)
            {
                var fault = ReadSlot(b, ref at, i == 0 ? null : u.Window[i - 1], first + (uint)i, render, out var slot);
                if (fault != null) return fault;
                u.Window.Add(slot);
            }
            return at == b.Length ? null : GenexFastFault.Trailing;
        }

        private static string ReadSlot(byte[] b, ref int at, GenexFastInput previous, uint seq, uint render, out GenexFastInput slot)
        {
            slot = null;
            if (at >= b.Length) return GenexFastFault.Truncated;
            int flags = b[at];
            var tickBits = flags & (SlotTickSame | SlotTickNext);
            var badFlags = (flags & ~SlotFlags) != 0 || tickBits == (SlotTickSame | SlotTickNext) || (previous == null && flags != 0);
            if (badFlags) return GenexFastFault.Flags;
            var next = at + 1;
            ushort tick;
            if (previous != null && tickBits == SlotTickSame) tick = previous.Tick;
            else if (previous != null && tickBits == SlotTickNext) tick = (ushort)((previous.Tick + 1) % TickMod);
            else
            {
                if (next + 2 > b.Length) return GenexFastFault.Truncated;
                tick = U16(b, next);
                next += 2;
            }
            if (next + 1 > b.Length) return GenexFastFault.Truncated;
            var slotRender = RenderOf(render, b[next]);
            next += 1;
            if (previous != null && (flags & SlotSame) != 0)
            {
                slot = new GenexFastInput(seq, tick, CopyInput(previous.Input), slotRender);
                at = next;
                return null;
            }
            if (next + Payload > b.Length) return GenexFastFault.Truncated;
            slot = new GenexFastInput(seq, tick, ReadPayload(b, next), slotRender);
            at = next + Payload;
            return null;
        }

        // ---- the client's datagram ----

        /// <summary>The client's next uplink (§17.12 *Redundancy and one-shot inputs*): <paramref name="sent"/> is every
        /// input it still holds, ascending and contiguous, back past <c>InputAck</c>; the window is the newest
        /// <see cref="InputRedundancyTicks"/>, and the oldest <see cref="GenexFast.MaxActions"/> presses before it that the
        /// server has not acked ride as actions.</summary>
        public static GenexFastUplink UplinkFor(IReadOnlyList<GenexFastInput> sent, GenexUplinkOptions o)
        {
            var take = Math.Min(sent.Count, InputRedundancyTicks(o.TickHz));
            var window = new List<GenexFastInput>(take);
            for (var i = sent.Count - take; i < sent.Count; i++) window.Add(sent[i]);
            var first = window.Count > 0 ? (long)window[0].Seq : long.MaxValue;
            var actions = new List<GenexFastInput>();
            for (var i = 0; i < sent.Count && actions.Count < GenexFast.MaxActions; i++)
            {
                var s = sent[i];
                if (s.Seq > o.InputAck && s.Seq < first && IsPress(i > 0 ? sent[i - 1].Input : null, s.Input)) actions.Add(s);
            }
            return new GenexFastUplink { Sid = o.Sid, Key = o.Key, AckSnap = o.AckSnap, Fresh = Math.Min(o.Fresh, window.Count), Actions = actions, Window = window };
        }

        // ---- the server's dedup ----

        /// <summary>The server's take of decoded uplink <paramref name="u"/> for seat <paramref name="seat"/> (§17.12
        /// *Server dedup*): every held input and slot ascending through <c>accept(seq)</c> (a seq at or below the last
        /// accepted is dropped), a gap filled with the last input held or, past <see cref="GapFillMax"/>, skipped;
        /// <c>AckSnap</c> forward only, never past <paramref name="snapSent"/>. A datagram whose newest seq is past
        /// <see cref="SeqAheadMax"/> is dropped whole. Nothing new: the very same seat.</summary>
        public static GenexAcceptResult AcceptUplink(GenexFastSeatRx seat, GenexFastUplink u, double tickHz, uint snapSent)
        {
            if (u.Window.Count == 0)
            {
                var ack = u.AckSnap > seat.AckSnap && u.AckSnap <= snapSent ? u.AckSnap : seat.AckSnap;
                return new GenexAcceptResult { Seat = ack == seat.AckSnap ? seat : new GenexFastSeatRx(seat.Last, seat.Input, ack) };
            }
            long newest = u.Window[u.Window.Count - 1].Seq;
            if (newest - seat.Last > SeqAheadMax(tickHz)) return new GenexAcceptResult { Seat = seat, Fault = GenexFastFault.Ahead };
            var firstFresh = newest - u.Fresh + 1;
            var r = new GenexAcceptResult();
            long last = seat.Last;
            var held = seat.Input;
            var fill = GapFillMax(tickHz);
            foreach (var s in u.Actions.Concat(u.Window))
            {
                if (s.Seq <= last) continue;
                var gap = s.Seq - last - 1;
                if (gap > fill) r.Skipped += gap;
                else
                {
                    for (var g = last + 1; g < s.Seq; g++)
                    {
                        var tick = (((s.Tick - (s.Seq - g)) % TickMod) + TickMod) % TickMod;
                        r.Accepted.Add(new GenexAcceptedInput { Seq = (uint)g, Tick = (ushort)tick, Render = s.Render, Input = held != null ? CopyInput(held) : new GenexInput(), Kind = GenexAcceptKind.Fill });
                    }
                }
                var input = s.Input.Sanitized();
                r.Accepted.Add(new GenexAcceptedInput { Seq = s.Seq, Tick = s.Tick, Render = s.Render, Input = input, Kind = s.Seq >= firstFresh ? GenexAcceptKind.Fresh : GenexAcceptKind.Recovered });
                last = s.Seq;
                held = input;
            }
            var ackSnap = u.AckSnap > seat.AckSnap && u.AckSnap <= snapSent ? u.AckSnap : seat.AckSnap;
            r.Seat = r.Accepted.Count == 0 && ackSnap == seat.AckSnap ? seat : new GenexFastSeatRx((uint)last, held, ackSnap);
            return r;
        }

        // ---- snapshots ----

        private static List<GenexFastRecord> ByKey(IEnumerable<GenexFastRecord> records) => records.OrderBy(r => r.Key).ToList();

        /// <summary>The body that turns <paramref name="base_"/> into <paramref name="next"/> (null base: a keyframe, every record).</summary>
        public static GenexSnapshotBody DiffSnapshot(IReadOnlyList<GenexFastRecord> base_, IReadOnlyList<GenexFastRecord> next)
        {
            if (base_ == null) return new GenexSnapshotBody { Records = ByKey(next) };
            var old = new Dictionary<ushort, byte[]>();
            foreach (var r in base_) old[r.Key] = r.Bytes;
            var keys = new HashSet<ushort>(next.Select(r => r.Key));
            var removed = base_.Where(r => !keys.Contains(r.Key)).Select(r => r.Key).OrderBy(k => k).ToList();
            var changed = next.Where(r => !old.TryGetValue(r.Key, out var before) || !before.SequenceEqual(r.Bytes));
            return new GenexSnapshotBody { Removed = removed, Records = ByKey(changed) };
        }

        /// <summary>The base the server deltas against: the seat's <paramref name="ackSnap"/> while it still holds that
        /// snapshot (<paramref name="held"/>, its last sent ids), else 0 (a keyframe).</summary>
        public static uint DeltaBase(IReadOnlyList<uint> held, uint ackSnap) => ackSnap > 0 && held.Contains(ackSnap) ? ackSnap : 0;

        private static byte[] BodyBytes(GenexSnapshotBody body)
        {
            if (body.Removed.Count > 0xffff || body.Records.Count > 0xffff) return null;
            if (body.Records.Any(r => r.Bytes == null || r.Bytes.Length > GenexFast.MaxRecordBytes)) return null;
            var size = 4 + 2 * body.Removed.Count + body.Records.Sum(r => 4 + r.Bytes.Length);
            var out_ = new byte[size];
            PutU16(out_, 0, (uint)body.Removed.Count);
            var at = 2;
            foreach (var k in body.Removed)
            {
                PutU16(out_, at, k);
                at += 2;
            }
            PutU16(out_, at, (uint)body.Records.Count);
            at += 2;
            foreach (var r in body.Records)
            {
                PutU16(out_, at, r.Key);
                PutU16(out_, at + 2, (uint)r.Bytes.Length);
                Array.Copy(r.Bytes, 0, out_, at + 4, r.Bytes.Length);
                at += 4 + r.Bytes.Length;
            }
            return out_;
        }

        /// <summary>The fragments of snapshot <paramref name="head"/> with body <paramref name="body"/> (§17.12 *Downlink
        /// snapshot*): <c>oversized</c> past <see cref="GenexFast.MaxFragments"/>, <c>field</c> for a value the wire cannot carry.</summary>
        public static GenexFastResult<List<byte[]>> EncodeSnapshot(GenexSnapshotHead head, GenexSnapshotBody body)
        {
            var bytes = BodyBytes(body);
            var validHead = head.Snap >= 1 && head.Base < head.Snap;
            var keyframeBody = head.Base != 0 || body.Removed.Count == 0;
            if (bytes == null || !validHead || !keyframeBody) return GenexFastResult<List<byte[]>>.Fail(GenexFastFault.Field);
            const int room = GenexFast.MaxDatagramBytes - SnapshotHeader;
            var frags = Math.Max(1, (bytes.Length + room - 1) / room);
            if (frags > GenexFast.MaxFragments) return GenexFastResult<List<byte[]>>.Fail(GenexFastFault.Oversized);
            var out_ = new List<byte[]>(frags);
            for (var i = 0; i < frags; i++)
            {
                var start = i * room;
                var len = Math.Max(0, Math.Min(room, bytes.Length - start));
                var d = new byte[SnapshotHeader + len];
                d[0] = GenexFast.Version;
                d[1] = GenexFastKind.Snapshot;
                PutU32(d, 2, head.Sid);
                PutU32(d, 6, head.Snap);
                PutU32(d, 10, head.Base);
                PutU32(d, 14, head.Tick);
                PutU32(d, 18, head.InputAck);
                d[22] = head.Base == 0 ? KeyframeFlag : (byte)0;
                d[23] = (byte)i;
                d[24] = (byte)frags;
                PutU32(d, 25, head.Sent);
                Array.Copy(bytes, start, d, SnapshotHeader, len);
                out_.Add(d);
            }
            return GenexFastResult<List<byte[]>>.Of(out_);
        }

        /// <summary>Decodes a snapshot fragment for seat <paramref name="sid"/>; any fault drops it.</summary>
        public static GenexFastResult<GenexFastFragment> DecodeFragment(byte[] bytes, uint sid)
        {
            var framed = Frame(bytes, GenexFastKind.Snapshot, SnapshotHeader);
            if (framed != null) return GenexFastResult<GenexFastFragment>.Fail(framed);
            if (U32(bytes, 2) != sid) return GenexFastResult<GenexFastFragment>.Fail(GenexFastFault.Session);
            var snap = U32(bytes, 6);
            var base_ = U32(bytes, 10);
            int flags = bytes[22];
            int frag = bytes[23];
            int frags = bytes[24];
            if (frags < 1 || frags > GenexFast.MaxFragments || frag >= frags) return GenexFastResult<GenexFastFragment>.Fail(GenexFastFault.Fragment);
            var keyframeAgrees = (flags & ~KeyframeFlag) == 0 && (flags == KeyframeFlag) == (base_ == 0);
            if (!keyframeAgrees || snap < 1 || base_ >= snap) return GenexFastResult<GenexFastFragment>.Fail(GenexFastFault.Keyframe);
            var chunk = new byte[bytes.Length - SnapshotHeader];
            Array.Copy(bytes, SnapshotHeader, chunk, 0, chunk.Length);
            return GenexFastResult<GenexFastFragment>.Of(new GenexFastFragment
            {
                Snap = snap, Base = base_, Tick = U32(bytes, 14), InputAck = U32(bytes, 18), Sent = U32(bytes, 25), Keyframe = flags == KeyframeFlag, Frag = frag, Frags = frags, Chunk = chunk,
            });
        }

        /// <summary>Parses a reassembled body to the byte (keys ascending and unique, lengths in bounds, nothing left).</summary>
        public static GenexFastResult<GenexSnapshotBody> ParseBody(byte[] bytes)
        {
            var fail = GenexFastResult<GenexSnapshotBody>.Fail(GenexFastFault.Body);
            if (bytes.Length < 2) return fail;
            var body = new GenexSnapshotBody();
            int removedCount = U16(bytes, 0);
            var at = 2;
            for (var i = 0; i < removedCount; i++)
            {
                if (at + 2 > bytes.Length) return fail;
                var k = U16(bytes, at);
                if (i > 0 && k <= body.Removed[i - 1]) return fail;
                body.Removed.Add(k);
                at += 2;
            }
            if (at + 2 > bytes.Length) return fail;
            int count = U16(bytes, at);
            at += 2;
            for (var i = 0; i < count; i++)
            {
                if (at + 4 > bytes.Length) return fail;
                var key = U16(bytes, at);
                int len = U16(bytes, at + 2);
                var bad = len > GenexFast.MaxRecordBytes || at + 4 + len > bytes.Length || (i > 0 && key <= body.Records[i - 1].Key);
                if (bad) return fail;
                var rec = new byte[len];
                Array.Copy(bytes, at + 4, rec, 0, len);
                body.Records.Add(new GenexFastRecord(key, rec));
                at += 4 + len;
            }
            return at == bytes.Length ? GenexFastResult<GenexSnapshotBody>.Of(body) : fail;
        }

        /// <summary><paramref name="base_"/>'s records less <c>body.Removed</c>, with <c>body.Records</c> written over them.</summary>
        public static List<GenexFastRecord> ApplyBody(IReadOnlyList<GenexFastRecord> base_, GenexSnapshotBody body)
        {
            var gone = new HashSet<ushort>(body.Removed);
            var out_ = new Dictionary<ushort, GenexFastRecord>();
            foreach (var r in base_)
                if (!gone.Contains(r.Key)) out_[r.Key] = r;
            foreach (var r in body.Records) out_[r.Key] = r;
            return ByKey(out_.Values);
        }

        private static bool SameHead(GenexPartialSnapshot p, GenexFastFragment f) =>
            p.Base == f.Base && p.Tick == f.Tick && p.InputAck == f.InputAck && p.Sent == f.Sent && p.Keyframe == f.Keyframe && p.Frags == f.Frags;

        private static GenexFastRxResult Dropped(GenexFastClientRx rx, string fault) => new GenexFastRxResult { Rx = rx, Applied = null, Fault = fault };

        /// <summary>The client's take of one snapshot datagram (§17.12 *Applying a snapshot*). A fault drops the
        /// fragment; while nothing was gathered for it, the answer is the very <paramref name="rx"/> given.</summary>
        public static GenexFastRxResult ReceiveFragment(GenexFastClientRx rx, byte[] bytes, uint sid)
        {
            var decoded = DecodeFragment(bytes, sid);
            if (!decoded.Ok) return Dropped(rx, decoded.Fault);
            var f = decoded.Value;
            if (f.Snap <= rx.Newest) return Dropped(rx, GenexFastFault.Stale);
            var existing = rx.Partials.FirstOrDefault(p => p.Snap == f.Snap);
            if (existing != null && !SameHead(existing, f)) return Dropped(rx, GenexFastFault.Mismatch);
            if (existing != null && existing.Chunks[f.Frag] != null) return Dropped(rx, GenexFastFault.Duplicate);
            var set = existing ?? new GenexPartialSnapshot
            {
                Snap = f.Snap, Base = f.Base, Tick = f.Tick, InputAck = f.InputAck, Sent = f.Sent, Keyframe = f.Keyframe, Frags = f.Frags, Chunks = new byte[f.Frags][],
            };
            var gathered = set.With(f.Frag, f.Chunk);
            var others = rx.Partials.Where(p => p.Snap != f.Snap).ToList();
            if (gathered.Chunks.Any(c => c == null))
            {
                var partials = others.Concat(new[] { gathered }).OrderBy(p => p.Snap).ToList();
                if (partials.Count > GenexFast.ReassemblySlots) partials = partials.Skip(partials.Count - GenexFast.ReassemblySlots).ToList();
                return new GenexFastRxResult { Rx = new GenexFastClientRx(partials, rx.History, rx.Newest) };
            }
            return ApplyComplete(new GenexFastClientRx(others, rx.History, rx.Newest), rx, gathered);
        }

        private static GenexFastRxResult ApplyComplete(GenexFastClientRx rest, GenexFastClientRx given, GenexPartialSnapshot set)
        {
            var dropped = rest.Partials.Count == given.Partials.Count ? given : rest;
            var total = set.Chunks.Sum(c => c.Length);
            var joined = new byte[total];
            var at = 0;
            foreach (var c in set.Chunks)
            {
                Array.Copy(c, 0, joined, at, c.Length);
                at += c.Length;
            }
            var body = ParseBody(joined);
            if (!body.Ok) return Dropped(dropped, GenexFastFault.Body);
            GenexHeldSnapshot base_ = null;
            if (!set.Keyframe)
            {
                base_ = given.History.FirstOrDefault(h => h.Snap == set.Base);
                if (base_ == null) return Dropped(dropped, GenexFastFault.Base);
            }
            if (set.Keyframe && body.Value.Removed.Count > 0) return Dropped(dropped, GenexFastFault.Body);
            var records = ApplyBody(base_ != null ? base_.Records : (IReadOnlyList<GenexFastRecord>)new GenexFastRecord[0], body.Value);
            var history = given.History.Concat(new[] { new GenexHeldSnapshot { Snap = set.Snap, Tick = set.Tick, InputAck = set.InputAck, Sent = set.Sent, Records = records } }).ToList();
            if (history.Count > GenexFast.SnapshotHistory) history = history.Skip(history.Count - GenexFast.SnapshotHistory).ToList();
            var partials = rest.Partials.Where(p => p.Snap > set.Snap).ToList();
            return new GenexFastRxResult { Rx = new GenexFastClientRx(partials, history, set.Snap), Applied = set.Snap };
        }
    }
}
