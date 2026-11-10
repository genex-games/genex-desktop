// The client side of the fast channel (PROTOCOL.md §17.12 *Client*): one seat's datagram socket, the inputs it
// still holds for the redundant uplink, its snapshot reassembly and the deadlines after which the seat goes back to
// the WebSocket. No I/O of its own: the socket is an IGenexFastSocket (GenexUdpFastSocket in FastUdp.cs, a fake in
// the tests) the client polls on the caller's thread, and every call that needs the time takes it, so every
// decision here is replayable. The session (FastSeat.cs) owns the reliable side: the `__fast` binding,
// `__fast:off`, and writing each applied snapshot into the state. A port of the TypeScript reference
// (packages/multiplayer/src/authority/fast-client.ts), with the Rust port's polled shape. No UnityEngine.
using System;
using System.Collections.Generic;
using System.Linq;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A datagram socket to the room's fast endpoint. <see cref="Send"/> never throws (a lost datagram is the
    /// channel's normal case); <see cref="Receive"/> answers the next datagram that arrived, else null, without blocking.</summary>
    public interface IGenexFastSocket
    {
        void Send(byte[] bytes);
        byte[] Receive();
        void Close();
    }

    /// <summary>Opens a socket to a <c>__fast</c> url; null when this client cannot reach that kind of url (the seat then
    /// falls back at once).</summary>
    public delegate IGenexFastSocket GenexFastSocketOpener(string url);

    /// <summary>What a socket that opens asynchronously knows of itself (WebTransport): the seat falls back at once, with no
    /// deadline to wait out, from one that can never carry the channel.</summary>
    public interface IGenexFastSocketState
    {
        /// <summary>True once the socket can never carry the channel (a refused or failed session).</summary>
        bool Failed { get; }
        /// <summary>The longest datagram it can send now; 0 while unknown.</summary>
        int MaxDatagramBytes { get; }
    }

    /// <summary>Why a fast seat went back to the WebSocket (the wire spelling of TypeScript's <c>FastFallbackReason</c>).</summary>
    public static class GenexFastFallbackReason
    {
        /// <summary>The <c>__fast</c> binding was malformed, or this client cannot open its url.</summary>
        public const string Unreachable = "unreachable";
        /// <summary>No snapshot within <see cref="GenexFast.HandshakeMs"/> of the first datagram.</summary>
        public const string Handshake = "handshake";
        /// <summary>No snapshot for <see cref="GenexFast.StallFallbackMs"/> after the last one.</summary>
        public const string Stall = "stall";
        /// <summary>The server asked for it (<c>__fast:off</c> from the server).</summary>
        public const string Server = "server";
    }

    /// <summary>A <c>__fast</c> binding this client can use: sid a uint32, key 8 bytes of lowercase hex, url a string.</summary>
    public sealed class GenexFastBind
    {
        public uint Sid;
        public string Key;
        public string Url;
        /// <summary>Where a browser reaches the channel (<see cref="GenexFastWebTarget"/>), else null.</summary>
        public GenexFastWebTarget Web;
        /// <summary>The host's revision of the channel (0: older than <see cref="GenexFast.BindRev"/>; it gets no empty uplink).</summary>
        public int Rev;
        /// <summary>A fresh binding to prove while the WebSocket carries everything (§17.12 <i>Return to the channel</i>).</summary>
        public bool Probe;

        /// <summary>Divides a browser's target from its hashes in <see cref="OpenTarget"/>: no url the rule takes holds it.</summary>
        internal const char TargetSeparator = ' ';

        /// <summary>What a socket opener is handed: the url, or in a browser the relay's session and its hashes.</summary>
        internal string OpenTarget(bool browser)
        {
            if (!browser) return Url;
            return Web == null ? null : Web.Url + TargetSeparator + string.Join(",", Web.Hashes);
        }

        /// <summary>The binding a reliable <c>__fast</c> payload carries, else null (an unusable one is a fallback).</summary>
        public static GenexFastBind Of(object message)
        {
            if (!(GenexJson.Normalize(message) is Dictionary<string, object> m)) return null;
            var sidOk = m.TryGetValue("sid", out var sid) && sid is double s && GenexFastTransport.WireU32(s, out _);
            var key = m.TryGetValue("key", out var k) ? k as string : null;
            var url = m.TryGetValue("url", out var u) ? u as string : null;
            if (!sidOk || !GenexFastTransport.IsKey(key) || string.IsNullOrEmpty(url)) return null;
            var rev = m.TryGetValue("rev", out var r) && r is double revision ? (int)revision : 0;
            var probe = m.TryGetValue("probe", out var p) && p is bool asked && asked;
            var web = m.TryGetValue("wt", out var wt) ? GenexFastWebTarget.Of(wt) : null;
            return new GenexFastBind { Sid = (uint)(double)sid, Key = key, Url = url, Web = web, Rev = rev, Probe = probe };
        }
    }

    /// <summary>Your inputs' ack as the WebSocket's entity list knows it (fast-session.ts settleAckTrail, PROTOCOL.md §17.12
    /// <i>Client</i>), for the rule that drops a projectile prediction whose firing input is acknowledged and whose id that
    /// list lacks. A snapshot's inAck runs ahead of the list: the launch an input made comes by WebSocket, which can land
    /// after the snapshot of the same tick. So the trail keeps each applied snapshot's tick and ack, and a list as of a tick
    /// is current with the ack of the newest snapshot at or before it. Past <see cref="Length"/> entries the oldest go
    /// without raising the floor. Held to fast-transport.json's <c>settleAck</c> vectors.</summary>
    public sealed class GenexSettleAckTrail
    {
        /// <summary>Applied snapshots kept (fast-session.ts SETTLE_ACK_TRAIL): 3.2 s of patches at 20 Hz.</summary>
        public const int Length = 64;
        private readonly LinkedList<KeyValuePair<double, int>> trail = new LinkedList<KeyValuePair<double, int>>();
        private int floor;

        /// <summary>A snapshot of <c>tick</c> was applied; the channel's ack is now <c>ack</c>.</summary>
        public void Snapshot(double tick, int ack)
        {
            var last = trail.Count == 0 ? floor : trail.Last.Value.Value;
            if (ack <= last) return;
            trail.AddLast(new KeyValuePair<double, int>(tick, ack));
            while (trail.Count > Length) trail.RemoveFirst();
        }

        /// <summary>The ack a list as of <c>tick</c> (the WebSocket's latest) is current with; never less than before.</summary>
        public int Through(double tick)
        {
            while (trail.Count > 0 && trail.First.Value.Key <= tick)
            {
                floor = Math.Max(floor, trail.First.Value.Value);
                trail.RemoveFirst();
            }
            return floor;
        }

        /// <summary>A new link: nothing kept, the list current with <c>at</c>.</summary>
        public void Reset(int at)
        {
            trail.Clear();
            floor = at;
        }
    }

    /// <summary>One applied snapshot as the session uses it: its header and the motion records that differ from the
    /// previous applied snapshot's (a record that does not decode is left out: its id stays as it was).</summary>
    public sealed class GenexFastSnapshot
    {
        public uint Snap;
        public uint Tick;
        /// <summary>The last input seq the server accepted (the header's <c>inputAck</c>).</summary>
        public uint InputAck;
        /// <summary>The room clock the server wrote it at (the header's <c>sent</c>, a WebSocket patch's TIMED <c>sNow</c>).</summary>
        public uint Sent;
        public List<GenexMotionRecord> Changed = new List<GenexMotionRecord>();
    }

    /// <summary>What one received datagram did.</summary>
    public sealed class GenexFastReceipt
    {
        public GenexFastSnapshot Applied;
        public string Fault;
    }

    /// <summary>One seat's fast channel on one socket.</summary>
    public sealed class GenexFastClient
    {
        /// <summary>The most datagrams one <see cref="Poll"/> reads (a hostile flood never holds a frame).</summary>
        public const int MaxDatagramsPerPoll = 256;

        private sealed class Decoded
        {
            public byte[] Bytes;
            public GenexMotionRecord Record;
        }

        private readonly IGenexFastSocket socket;
        private readonly double tickHz;
        private GenexFastClientRx rx = GenexFastClientRx.Empty();
        private List<GenexFastInput> sent = new List<GenexFastInput>();
        private readonly Dictionary<uint, double> sentTimes = new Dictionary<uint, double>();
        private int fresh;
        private bool closed;
        private double? firstSentAt;
        private double? lastAppliedAt;
        private double? lastUplinkAt;
        private double? lastFrameAt;
        private uint lastAppliedSnap;
        private Dictionary<ushort, Decoded> decodedByKey = new Dictionary<ushort, Decoded>();
        private Dictionary<string, GenexMotionRecord> latest = new Dictionary<string, GenexMotionRecord>();

        /// <summary>A client on <paramref name="socket"/> (already open) for <paramref name="bind"/>.</summary>
        public GenexFastClient(GenexFastBind bind, double tickHz, IGenexFastSocket socket)
        {
            Bind = bind;
            this.tickHz = tickHz;
            this.socket = socket;
        }

        /// <summary>Opens a seat's fast channel on <paramref name="bind"/>; null when <paramref name="open"/> cannot reach its url.</summary>
        public static GenexFastClient Open(GenexFastBind bind, double tickHz, GenexFastSocketOpener open)
        {
            var target = bind?.OpenTarget(GenexFastSeat.InBrowser);
            var socket = target == null || open == null ? null : open(target);
            return socket == null ? null : new GenexFastClient(bind, tickHz, socket);
        }

        public GenexFastBind Bind { get; }
        /// <summary>The snapshot receive state (reassembly, held bases, newest applied).</summary>
        public GenexFastClientRx Rx => rx;
        /// <summary>The newest input seq queued (0: none).</summary>
        public uint LastQueued => sent.Count > 0 ? sent[sent.Count - 1].Seq : 0;
        /// <summary>True once closed: nothing is sent or received again.</summary>
        public bool IsClosed => closed;
        /// <summary>The server's last accepted seq, from the newest applied snapshot (0: none).</summary>
        public uint InputAck => rx.History.Count > 0 ? rx.History[rx.History.Count - 1].InputAck : 0;

        /// <summary>The inputs <see cref="GenexFastTransport.UplinkFor"/> still needs once the server accepted through
        /// <paramref name="inputAck"/>: the window's newest inputs, every input after the ack, and the one before the
        /// oldest of those (a press is a bit its previous input lacked). At most <see cref="GenexFastTransport.SeqAheadMax"/>.</summary>
        public static List<GenexFastInput> HeldInputs(IReadOnlyList<GenexFastInput> sent, uint inputAck, double tickHz)
        {
            if (sent.Count == 0) return new List<GenexFastInput>();
            long newest = sent[sent.Count - 1].Seq;
            var keepFrom = Math.Min(inputAck, newest - GenexFastTransport.InputRedundancyTicks(tickHz) + 1);
            var capped = Math.Max(keepFrom, newest - GenexFastTransport.SeqAheadMax(tickHz) + 1);
            return sent.Where(s => s.Seq >= capped).ToList();
        }

        private static string RecordName(int kind, string id) => kind + ":" + id;

        /// <summary>An input sent this frame: seqs ascend by one from the first queued.</summary>
        public void Queue(GenexFastInput input)
        {
            if (closed) return;
            sent.Add(input.Clone());
            fresh += 1;
        }

        /// <summary>One datagram carrying the inputs queued since the last flush and the redundant window (one more for each
        /// further window's worth of new inputs); nothing when none was queued.</summary>
        public void Flush(double now)
        {
            if (closed || fresh == 0) return;
            for (var i = sent.Count - fresh; i < sent.Count; i++) sentTimes[sent[i].Seq] = now;
            ForgetSendTimes((long)sent[sent.Count - 1].Seq - GenexFastTransport.SeqAheadMax(tickHz) + 1);
            // More new inputs than one window holds (a frame after a hitch, or the inputs sent before the binding): one
            // datagram a window's worth, oldest first, so none rides only as a fill.
            var window = GenexFastTransport.InputRedundancyTicks(tickHz);
            var from = sent.Count - fresh;
            fresh = 0;
            while (from < sent.Count)
            {
                var to = Math.Min(from + window, sent.Count);
                var u = GenexFastTransport.UplinkFor(sent.GetRange(0, to), new GenexUplinkOptions
                {
                    Sid = Bind.Sid, Key = Bind.Key, AckSnap = rx.Newest, InputAck = InputAck, Fresh = to - from, TickHz = tickHz,
                });
                from = to;
                var bytes = GenexFastTransport.EncodeUplink(u);
                if (!bytes.Ok) continue;
                if (!firstSentAt.HasValue) firstSentAt = now;
                lastUplinkAt = now;
                socket.Send(bytes.Value);
            }
        }

        /// <summary>The empty uplink: its <c>ackSnap</c> is its whole message.</summary>
        private void SendEmpty(double now)
        {
            if (closed || Bind.Rev < GenexFast.BindRev) return;
            var bytes = GenexFastTransport.EncodeUplink(new GenexFastUplink { Sid = Bind.Sid, Key = Bind.Key, AckSnap = rx.Newest, Fresh = 0 });
            if (!bytes.Ok) return;
            if (!firstSentAt.HasValue) firstSentAt = now;
            lastUplinkAt = now;
            socket.Send(bytes.Value);
        }

        /// <summary>An empty uplink when one is due (§17.12 <i>Keepalive</i>), from a host that takes them: the seat binds with
        /// no input, its snapshots stay acknowledged and its NAT mapping stays open.</summary>
        public void Keepalive(double now)
        {
            var every = lastAppliedAt.HasValue ? GenexFast.KeepaliveMs : GenexFast.KeepaliveBindMs;
            if (!lastUplinkAt.HasValue || now - lastUplinkAt.Value >= every) SendEmpty(now);
        }

        /// <summary>A frame begins: time since the last frame past <see cref="GenexFast.FrameGapMs"/> is taken off both
        /// deadlines' clocks, so a seat whose frames stopped does not read its own stop as a dead path.</summary>
        public void Framed(double now)
        {
            var gap = lastFrameAt.HasValue ? now - lastFrameAt.Value : 0;
            lastFrameAt = now;
            if (gap <= GenexFast.FrameGapMs) return;
            if (lastAppliedAt.HasValue) lastAppliedAt = Math.Min(now, lastAppliedAt.Value + gap);
            if (firstSentAt.HasValue) firstSentAt = Math.Min(now, firstSentAt.Value + gap);
        }

        /// <summary>Every record of the newest applied snapshot.</summary>
        public List<GenexMotionRecord> Records() => latest.Values.ToList();

        /// <summary>The input of seq <paramref name="seq"/> while it is still held, else null.</summary>
        public GenexFastInput InputAt(uint seq) => sent.FirstOrDefault(s => s.Seq == seq);

        /// <summary>When the input of seq <paramref name="seq"/> was first sent, for each of the newest
        /// <see cref="GenexFastTransport.SeqAheadMax"/> inputs: the server consumes an input well after it received it (its
        /// buffer, the next keyframe), and the round trip is timed from the send of the input a snapshot acks as consumed.</summary>
        public double? SentAt(uint seq) => sentTimes.TryGetValue(seq, out var at) ? at : (double?)null;

        /// <summary>The latest decoded record of <paramref name="id"/> of <paramref name="kind"/> (from the newest applied
        /// snapshot), else null.</summary>
        public GenexMotionRecord MotionOf(int kind, string id) => latest.TryGetValue(RecordName(kind, id), out var r) ? r : null;

        /// <summary>Whether a deadline has passed at <paramref name="now"/> (§17.12 *Fallback*): a
        /// <see cref="GenexFastFallbackReason"/>, else null.</summary>
        public string Due(double now)
        {
            if (closed) return null;
            if (socket is IGenexFastSocketState state)
            {
                if (state.Failed) return GenexFastFallbackReason.Unreachable;
                var room = state.MaxDatagramBytes;
                if (room > 0 && room < GenexFastTransport.UplinkMaxBytes(tickHz)) return GenexFastFallbackReason.Unreachable;
            }
            if (lastAppliedAt.HasValue) return now - lastAppliedAt.Value > GenexFast.StallFallbackMs ? GenexFastFallbackReason.Stall : null;
            return firstSentAt.HasValue && now - firstSentAt.Value > GenexFast.HandshakeMs ? GenexFastFallbackReason.Handshake : null;
        }

        /// <summary>Every datagram the socket holds (at most <see cref="MaxDatagramsPerPoll"/>): the snapshots they applied.</summary>
        public List<GenexFastSnapshot> Poll(double now)
        {
            var applied = new List<GenexFastSnapshot>();
            for (var i = 0; i < MaxDatagramsPerPoll && !closed; i++)
            {
                var bytes = socket.Receive();
                if (bytes == null) break;
                var r = Receive(bytes, now);
                if (r.Applied != null) applied.Add(r.Applied);
            }
            return applied;
        }

        /// <summary>One datagram from the socket. A fault, a stale or duplicate fragment or a datagram for another seat
        /// changes nothing.</summary>
        public GenexFastReceipt Receive(byte[] bytes, double now)
        {
            if (closed) return new GenexFastReceipt();
            var r = GenexFastTransport.ReceiveFragment(rx, bytes, Bind.Sid);
            rx = r.Rx;
            if (r.Fault != null || !r.Applied.HasValue) return new GenexFastReceipt { Fault = r.Fault };
            var held = rx.History[rx.History.Count - 1];
            var before = lastAppliedSnap;
            lastAppliedSnap = held.Snap;
            lastAppliedAt = now;
            sent = HeldInputs(sent, held.InputAck, tickHz);
            var changed = DecodeChanged(held.Records);
            var eager = changed.Count >= GenexFast.AckEagerRecords && (!lastUplinkAt.HasValue || now - lastUplinkAt.Value >= GenexFast.AckEagerGapMs);
            if (held.Snap - before >= GenexFast.ChallengeJump || eager) SendEmpty(now);
            return new GenexFastReceipt
            {
                Applied = new GenexFastSnapshot { Snap = held.Snap, Tick = held.Tick, InputAck = held.InputAck, Sent = held.Sent, Changed = changed },
            };
        }

        /// <summary>Drops the send times of seqs below <paramref name="from"/>.</summary>
        private void ForgetSendTimes(long from)
        {
            foreach (var seq in sentTimes.Keys.Where(s => s < from).ToList()) sentTimes.Remove(seq);
        }

        /// <summary>Decodes what changed against the previous applied snapshot; keeps the rest as decoded.</summary>
        private List<GenexMotionRecord> DecodeChanged(IReadOnlyList<GenexFastRecord> records)
        {
            var nextByKey = new Dictionary<ushort, Decoded>();
            var nextLatest = new Dictionary<string, GenexMotionRecord>();
            var changed = new List<GenexMotionRecord>();
            foreach (var r in records)
            {
                var same = decodedByKey.TryGetValue(r.Key, out var before) && (ReferenceEquals(before.Bytes, r.Bytes) || before.Bytes.SequenceEqual(r.Bytes));
                GenexMotionRecord record;
                if (same) record = before.Record;
                else
                {
                    var d = GenexFastRecords.DecodeRecord(r.Bytes);
                    record = d.Ok ? d.Value : null;
                }
                nextByKey[r.Key] = new Decoded { Bytes = r.Bytes, Record = record };
                if (record == null) continue;
                nextLatest[RecordName(record.Kind, record.Id)] = record;
                if (!same) changed.Add(record);
            }
            decodedByKey = nextByKey;
            latest = nextLatest;
            return changed;
        }

        public void Close()
        {
            if (closed) return;
            closed = true;
            socket.Close();
        }
    }
}
