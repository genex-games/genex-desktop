// A seat's fast channel inside the authority session (PROTOCOL.md §17.12 *Client*, TypeScript fast-session.ts): the
// reliable side of `fast@1` (the `__fast` binding, `__fast:off`), the inputs the session sends going by datagram while
// the channel is live, and each applied snapshot written into the decoded state exactly as a schema patch would write
// it, so the reconciler, Predict and every state listener read one state and never learn which transport delivered it.
//
// While the channel is live:
//  - the input handle still numbers, records and replays every input (its seq is the input's client sequence less
//    the socket's `seqBase`), but its WebSocket frame is not sent: the server drops a fast seat's WebSocket inputs,
//    and an unsent frame keeps the TCP stream free of them;
//  - your inputs' ack is your own seat record's `inAck` (the server's WebSocket ack counts its WebSocket buffer,
//    which the channel does not use);
//  - motion fields (FastRecords.cs) and the state's `tick` (and `keyframe` in a predicting room, which patches only on
//    keyframes) come from snapshots only: a schema patch that would write one of them for a record the channel holds
//    is put back before any listener runs, so a WebSocket patch held behind a lost TCP segment never moves an entity
//    back in time; the WebSocket's latest value of each held field is kept.
// At a deadline, an unusable binding or the server's `__fast:off`, the seat falls back:
// `__fast:off { last }`, every held field takes the WebSocket's latest value (one patch), then inputs by the
// WebSocket numbered on from the last one sent. The C# SDK's input encoder writes each frame as a delta against the
// last frame it ENCODED, and its lag-compensation stamp as a delta against the last one it stamped, sent or not: the
// muted frames moved both past what the server last decoded, so at the fallback the encoder starts over with a full
// frame and the stamp baseline goes back to the last frame the server got (the TypeScript encoder re-emits assigned
// fields; this one does not). A fallback is not the end (§17.12 *Return to the channel*): from a host that offers it the
// seat asks for a fresh binding with backoff and jitter, proves the path while the WebSocket carries everything, and at
// the third snapshot swaps at one instant (`__fast:on { last }`). The session polls, so the keepalive and the retries run
// on its frames.
//
// The Colyseus C# SDK has no seam for any of this: the connection's Transmit and Dispatch delegates, the decoder's
// TriggerChanges, the room's Serializer and OnStateChange and the input handle's encoder and stamp baseline are
// reached by reflection or by wrapping a public delegate, checked once by Missing() (a build without them never
// claims fast@1), and kept for IL2CPP by Runtime/link.xml. No UnityEngine.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using Colyseus;
using Colyseus.Schema;
using Genex.Multiplayer.Authority.Wire;

namespace Genex.Multiplayer.Authority
{
    /// <summary>What the session reads of a seat's fast channel (<see cref="GenexAuthoritySession.Fast"/>).</summary>
    public sealed class GenexFastStatus
    {
        /// <summary>Snapshots are flowing and inputs go by datagram.</summary>
        public bool Live { get; internal set; }
        /// <summary>Snapshots applied on this session.</summary>
        public int Snapshots { get; internal set; }
        /// <summary>Why this socket fell back to the WebSocket (a <see cref="GenexFastFallbackReason"/>), else null.</summary>
        public string Fallback { get; internal set; }
        /// <summary>WebSocket input frames kept off the socket while the channel was live.</summary>
        public int MutedFrames { get; internal set; }
        /// <summary>Inputs queued for the datagram path.</summary>
        public int DatagramInputs { get; internal set; }
        /// <summary>The transport (a <see cref="GenexFastTransportName"/>): UDP once a snapshot came over it on this socket, the WebSocket before that and after a fallback.</summary>
        public string Transport { get; internal set; } = GenexFastTransportName.WebSocket;
        /// <summary>The newest transport line: names the transport and why (§17.12 *The transport line*); null until it is known.</summary>
        public string Line { get; internal set; }
        /// <summary>Times this session fell back.</summary>
        public int Fallbacks { get; internal set; }
        /// <summary>Times this session came back to the channel after a fallback.</summary>
        public int Returns { get; internal set; }
    }

    /// <summary>One seat's fast channel across the session's sockets.</summary>
    internal sealed class GenexFastSeat
    {
        /// <summary>True on a WebGL player: its channel goes by WebTransport (<see cref="GenexFastWebSocket"/>).</summary>
        internal static readonly bool InBrowser =
#if UNITY_WEBGL && !UNITY_EDITOR
            true;
#else
            false;
#endif

        private const BindingFlags Hidden = BindingFlags.Instance | BindingFlags.NonPublic;
        private static readonly FieldInfo EncoderField = typeof(InputHandle).GetField("encoder", Hidden);
        private static readonly FieldInfo StampField = typeof(InputHandle).GetField("lastStamp", Hidden);
        private static readonly FieldInfo SerializerField = typeof(Room<AuthorityRoomState>).GetField("Serializer", Hidden);
        private static readonly FieldInfo StateChangeField = typeof(Room<AuthorityRoomState>).GetField("OnStateChange", Hidden);

        /// <summary>The members this class reaches by reflection that this build lacks ("" when none): a build without them
        /// never claims fast@1.</summary>
        public static string Missing()
        {
            if (EncoderField == null || !typeof(InputEncoder).IsAssignableFrom(EncoderField.FieldType)) return "Colyseus.InputHandle.encoder";
            if (StampField == null || StampField.FieldType != typeof(double)) return "Colyseus.InputHandle.lastStamp";
            if (SerializerField == null) return "Colyseus.Room`1.Serializer";
            if (StateChangeField == null) return "Colyseus.Room`1.OnStateChange";
            return "";
        }

        private sealed class Link
        {
            public GenexFastClient Client;
            /// <summary>The socket's seqBase: wire seq = SeqBase + handle seq.</summary>
            public uint SeqBase;
            /// <summary>Inputs the handle had sent by WebSocket on this socket before the binding.</summary>
            public int WsBefore;
            /// <summary>The handle's stamp baseline when its frames went quiet (the last one the server decoded).</summary>
            public double Stamp;
        }

        private sealed class Fallen
        {
            /// <summary>The handle's SentCount when it fell back.</summary>
            public int At;
            /// <summary>Inputs sent by WebSocket on this socket before the fallback (the server's offCount).</summary>
            public int WsBefore;
            /// <summary>The ack when it fell back.</summary>
            public int Ack;
        }

        private readonly Room<AuthorityRoomState> room;
        private readonly InputHandle handle;
        private readonly GenexFastSocketOpener open;
        private readonly Func<double> now;
        private readonly Func<double> tickHz;
        private readonly Func<bool> stateCurrent;
        private readonly GenexMotionGuard guard;
        private Link link;
        private Fallen fallback;
        /// <summary>A fresh binding being proven while the WebSocket carries everything, and its snapshots so far.</summary>
        private GenexFastClient probe;
        private int probeApplied;
        /// <summary>This socket's host offers fresh bindings (its binding said <c>rev</c> 2).</summary>
        private bool hostReturns;
        /// <summary>Retries since the channel last held.</summary>
        private int attempt;
        /// <summary>When the next <c>__fast:again</c> goes.</summary>
        private double? retryAt;
        private double? liveSince;
        private readonly Random jitter = new Random();
        /// <summary>The backoff's attempt after the server's <c>__fast:off</c>: the first retry 4 to 8 s on.</summary>
        private const int RetryAfterServerOff = 3;
        /// <summary>The channel's ack, handle-counted.</summary>
        private int fastAck;
        /// <summary>The channel's acks by snapshot tick, for <see cref="SettleAck"/>.</summary>
        private readonly GenexSettleAckTrail settle = new GenexSettleAckTrail();
        /// <summary>Inputs sent on this socket before a binding arrived (the server drops them; the first datagram carries
        /// them again), handle-counted.</summary>
        private List<GenexFastInput> early = new List<GenexFastInput>();
        private object pendingBind;
        private bool hasPendingBind;
        private Connection muted;
        private readonly AuthorityInput replay = new AuthorityInput();

        public readonly GenexFastStatus Status = new GenexFastStatus();
        private readonly GenexFastLineAnnouncer announcer = new GenexFastLineAnnouncer();
        private readonly bool asked;
        private readonly Action<string> log;
        /// <summary>This socket's first state, the binding's url and the session's snapshots before this socket.</summary>
        private double? joinedAt;
        private string boundUrl;
        private int snapshotsBefore;
        private int returnsSaid;

        /// <param name="open">The socket opener; null: the seat never asks for fast@1 and only reads the handle.</param>
        /// <param name="stateCurrent">False from a drop until the reconnect's first state is decoded (its seqBase is then known).</param>
        /// <param name="asked">The game left the channel on (a seat with no opener and this true has no UDP here).</param>
        /// <param name="log">Where the transport line goes.</param>
        public GenexFastSeat(Room<AuthorityRoomState> room, InputHandle handle, GenexFastSocketOpener open, Func<double> now, Func<double> tickHz,
            Func<bool> stateCurrent, bool asked, Action<string> log)
        {
            this.asked = asked;
            this.log = log;
            this.room = room;
            this.handle = handle;
            this.open = open;
            this.now = now;
            this.tickHz = tickHz;
            this.stateCurrent = stateCurrent;
            if (open == null) return;
            guard = new GenexMotionGuard(room, () => link?.Client, StateChangeField, SerializerField);
            room.OnMessage<object>(GenexFastMessage.Bind, Bind);
            room.OnMessage<object>(GenexFastMessage.Off, _ => FallBack(GenexFastFallbackReason.Server));
        }

        /// <summary>Your inputs' ack, counted as the input handle counts: the channel's while live, the WebSocket's counted on
        /// from the fallback after.</summary>
        public int Ack()
        {
            if (link != null) return Math.Min(handle.SentCount, fastAck);
            if (fallback == null) return handle.LastProcessed;
            var ws = handle.LastProcessed - fallback.WsBefore;
            return ws > 0 ? Math.Max(fallback.Ack, fallback.At + ws) : fallback.Ack;
        }

        /// <summary>Your inputs' ack as the WebSocket's entity list knows it (a projectile's settling reads it): <see cref="Ack"/>
        /// off the channel; while live, the newest snapshot's at or before the WebSocket's latest tick (GenexSettleAckTrail).</summary>
        public int SettleAck()
        {
            if (link == null) return Ack();
            return Math.Min(Ack(), settle.Through(guard.WebSocketTick()));
        }

        private uint SeqBase()
        {
            var players = room.State?.players;
            return players != null && players.TryGetValue(room.SessionId, out var me) && me != null && GenexFastTransport.WireU32(me.seqBase, out var b) ? b : 0;
        }

        /// <summary>An input the handle just sent as seq <paramref name="seq"/> (its tick@1 field and payload), and
        /// <paramref name="render"/>, the render time it was sent at (<see cref="GenexFastTransport.RenderStamp"/>).</summary>
        public void Sent(int seq, ushort tick, GenexInput input, uint render)
        {
            if (open == null || fallback != null) return;
            if (link != null)
            {
                link.Client.Queue(new GenexFastInput(link.SeqBase + (uint)seq, tick, input, render));
                Status.DatagramInputs++;
                return;
            }
            early.Add(new GenexFastInput((uint)seq, tick, GenexFastTransport.CopyInput(input), render));
            var cap = GenexFastTransport.SeqAheadMax(tickHz());
            if (early.Count > cap) early = early.Skip(early.Count - cap).ToList();
        }

        /// <summary>After a frame's sends: one datagram for them.</summary>
        public void Flush() => link?.Client.Flush(now());

        /// <summary>At a frame's start: the datagrams that arrived (each applied snapshot written into the state), a binding
        /// that waited for the state, then a fallback when a deadline passed.</summary>
        public void Poll()
        {
            PollChannel();
            Announce();
        }

        /// <summary>Says the transport line this instant owes.</summary>
        private void Announce()
        {
            var players = room.State?.players;
            if (joinedAt == null && stateCurrent() && players != null && players.TryGetValue(room.SessionId, out var me) && me != null) joinedAt = now();
            var snapshots = Status.Snapshots - snapshotsBefore;
            Status.Transport = Status.Live && snapshots > 0 ? GenexFastTransportName.Udp : GenexFastTransportName.WebSocket;
            // A return may say every line again: this socket is back on UDP, and may fall back again.
            if (Status.Returns != returnsSaid)
            {
                returnsSaid = Status.Returns;
                announcer.Reset();
            }
            var line = announcer.Observe(asked, open != null, joinedAt == null ? (double?)null : now() - joinedAt.Value, boundUrl, snapshots, Status.Fallback);
            if (line == null) return;
            Status.Line = line;
            log(line);
        }

        private void PollChannel()
        {
            if (open == null) return;
            if (hasPendingBind && stateCurrent()) Bind(pendingBind);
            PollProbe();
            var l = link;
            if (l != null)
            {
                l.Client.Framed(now());
                foreach (var s in l.Client.Poll(now()))
                {
                    if (link != l) break;
                    Applied(l, s);
                }
                var reason = link?.Client.Due(now());
                if (reason != null) FallBack(reason);
                link?.Client.Keepalive(now());
            }
            if (retryAt.HasValue && probe == null && fallback != null && now() >= retryAt.Value)
            {
                _ = Send(GenexFastMessage.Again, new Dictionary<string, object>());
                ScheduleRetry();
            }
        }

        /// <summary>The fresh binding's frame: what arrived proves the path, or a deadline sends it back.</summary>
        private void PollProbe()
        {
            var p = probe;
            if (p == null) return;
            p.Framed(now());
            foreach (var s in p.Poll(now()))
            {
                if (probe == p)
                {
                    probeApplied++;
                    if (probeApplied >= GenexFast.ReturnProof) SwapToProbe(s);
                }
                else if (link != null) Applied(link, s);
            }
            if (probe != p) return;
            var reason = p.Due(now());
            if (reason != null)
            {
                AbandonProbe(reason);
                return;
            }
            p.Keepalive(now());
        }

        private void ScheduleRetry()
        {
            if (!hostReturns || open == null) return;
            retryAt = now() + GenexFast.RetryDelayMs(attempt, jitter.NextDouble());
            attempt++;
        }

        /// <summary>Off the proof: its binding goes back to the server, and the next retry waits its turn.</summary>
        /// <summary>The seat is off the channel for <paramref name="reason"/>: the first word of a stretch off it is one
        /// fallback, as its transport line says, whether or not the seat had been on the channel.</summary>
        private void OffChannel(string reason)
        {
            if (Status.Fallback == null) Status.Fallbacks++;
            Status.Fallback = reason;
        }

        private void AbandonProbe(string reason)
        {
            probe.Close();
            probe = null;
            OffChannel(reason);
            _ = Send(GenexFastMessage.Off, new Dictionary<string, object> { ["last"] = (double)(SeqBase() + (uint)handle.SentCount) });
            ScheduleRetry();
        }

        /// <summary>The path is proven: at this instant inputs and motion move to the fresh binding. The WebSocket has every
        /// frame through <c>last</c> and the next goes by datagram; the snapshot is written whole, as a first one is.</summary>
        private void SwapToProbe(GenexFastSnapshot s)
        {
            var client = probe;
            probe = null;
            var base_ = SeqBase();
            // What the server's WebSocket buffer holds: the handle's frames were muted while it was live before.
            var wsBefore = fallback.WsBefore + (handle.SentCount - fallback.At);
            fastAck = Ack();
            // Off the channel the ack and the WebSocket's list agree.
            settle.Reset(fastAck);
            link = new Link { Client = client, SeqBase = base_, WsBefore = wsBefore, Stamp = (double)StampField.GetValue(handle) };
            fallback = null;
            retryAt = null;
            liveSince = now();
            Status.Live = true;
            Status.Fallback = null;
            if (Status.Fallbacks > 0) Status.Returns++;
            _ = Send(GenexFastMessage.On, new Dictionary<string, object> { ["last"] = (double)(base_ + (uint)handle.SentCount) });
            Mute();
            guard.Install();
            s.Changed = client.Records();
            Applied(link, s);
        }

        /// <summary>A fresh binding to prove: the WebSocket carries everything until it is proven.</summary>
        private void StartProbe(GenexFastBind bind)
        {
            // The ask that brought this was answered: the climb is for what fails.
            attempt = Math.Max(0, attempt - 1);
            hostReturns = true;
            probe?.Close();
            probe = null;
            probeApplied = 0;
            // A seat new to the channel was on the WebSocket all along: no input of its was dropped.
            if (fallback == null) fallback = new Fallen { At = 0, WsBefore = 0, Ack = 0 };
            early.Clear();
            var client = bind == null ? null : GenexFastClient.Open(bind, tickHz(), open);
            if (client == null)
            {
                OffChannel(GenexFastFallbackReason.Unreachable);
                ScheduleRetry();
                return;
            }
            probe = client;
            retryAt = null;
            client.Keepalive(now());
        }

        /// <summary>A state was decoded: a binding that waited for it is taken now.</summary>
        public void StateArrived()
        {
            if (hasPendingBind && stateCurrent()) Bind(pendingBind);
        }

        /// <summary>Input <paramref name="seq"/> (handle-counted) while the channel still holds it, as a wire input the caller
        /// reads at once (the instance is reused), else null.</summary>
        public AuthorityInput InputAt(int seq)
        {
            var held = link?.Client.InputAt(link.SeqBase + (uint)seq);
            if (held == null) return null;
            replay.moveX = held.Input.MoveX;
            replay.moveY = held.Input.MoveY;
            replay.moveZ = held.Input.MoveZ;
            replay.yaw = held.Input.Yaw;
            replay.pitch = held.Input.Pitch;
            replay.buttons = held.Input.Buttons;
            replay.tick = held.Tick;
            return replay;
        }

        /// <summary>Whether entity <c>id</c>'s motion in the state is the newest snapshot's: always off the channel; while it is
        /// live, only when that snapshot carries the entity's record (§17.12 <i>Client</i>).</summary>
        internal bool MotionKnown(string id) => link == null || link.Client.MotionOf(GenexMotionRecordKind.Entity, id) != null;

        private void Applied(Link l, GenexFastSnapshot s)
        {
            Status.Snapshots++;
            var mine = l.Client.MotionOf(GenexMotionRecordKind.Seat, room.SessionId);
            var own = mine == null ? 0 : mine.Get(GenexFastRecords.SeatAckField);
            var acked = (int)Math.Max(0, Math.Min(handle.SentCount, own - l.SeqBase));
            var rtt = -1.0;
            if (acked > fastAck)
            {
                var at = l.Client.SentAt(l.SeqBase + (uint)acked);
                if (at.HasValue) rtt = now() - at.Value;
                fastAck = acked;
            }
            settle.Snapshot(s.Tick, fastAck);
            // The room clock the server sent it at, as a WebSocket patch's TIMED prefix gives it: the tick's nominal
            // instant would read up to a step early, by however late the server ran that step.
            room.Clock.Sample(s.Sent, rtt);
            guard.Write(s);
        }

        private void Bind(object message)
        {
            var asProbe = GenexJson.Normalize(message) is Dictionary<string, object> m && m.TryGetValue("probe", out var p) && p is bool asked && asked;
            if (open == null || link != null || (fallback != null && !asProbe)) return;
            if (!stateCurrent())
            {
                pendingBind = message;
                hasPendingBind = true;
                return;
            }
            pendingBind = null;
            hasPendingBind = false;
            var bind = GenexFastBind.Of(message);
            boundUrl = bind?.Url;
            if (asProbe)
            {
                StartProbe(bind);
                return;
            }
            hostReturns = bind != null && bind.Rev >= GenexFast.BindRev;
            var client = bind == null ? null : GenexFastClient.Open(bind, tickHz(), open);
            if (client == null)
            {
                FallBack(GenexFastFallbackReason.Unreachable);
                return;
            }
            link = new Link { Client = client, SeqBase = SeqBase(), WsBefore = handle.SentCount, Stamp = (double)StampField.GetValue(handle) };
            // The server dropped every WebSocket input this socket sent before the binding, unstepped: the first datagram
            // carries them all again.
            fastAck = 0;
            settle.Reset(0);
            Status.Live = true;
            liveSince = now();
            Mute();
            guard.Install();
            foreach (var s in early)
            {
                client.Queue(new GenexFastInput(link.SeqBase + s.Seq, s.Tick, s.Input, s.Render));
                Status.DatagramInputs++;
            }
            early.Clear();
            client.Flush(now());
            client.Keepalive(now());
        }

        private void FallBack(string reason)
        {
            if (fallback != null || open == null) return;
            if (liveSince.HasValue && now() - liveSince.Value >= GenexFast.ReturnStableMs) attempt = 0;
            // The server sent it away: it has its reasons, so no quick return.
            if (reason == GenexFastFallbackReason.Server) attempt = Math.Max(attempt, RetryAfterServerOff);
            liveSince = null;
            Status.Fallbacks++;
            var l = link;
            var base_ = l?.SeqBase ?? SeqBase();
            fallback = new Fallen { At = handle.SentCount, WsBefore = l?.WsBefore ?? handle.SentCount, Ack = Ack() };
            l?.Client.Close();
            link = null;
            early.Clear();
            Status.Live = false;
            Status.Fallback = reason;
            // The frames the channel kept off the socket moved the encoder's and the stamp's baselines past the server's.
            if (l != null) Rebase(l.Stamp);
            _ = Send(GenexFastMessage.Off, new Dictionary<string, object> { ["last"] = (double)(base_ + (uint)handle.SentCount) });
            // From here every field comes by WebSocket, which sends a field only when it changes.
            guard?.Release();
            ScheduleRetry();
        }

        private void Rebase(double stamp)
        {
            (EncoderField.GetValue(handle) as InputEncoder)?.Reset();
            StampField.SetValue(handle, stamp);
        }

        private async Task Send(string type, object payload)
        {
            try
            {
                await room.Send(type, payload);
            }
            catch (Exception)
            {
                // A socket that is going down: the drop's reconnect binds afresh.
            }
        }

        /// <summary>Keeps the handle's WebSocket input frames off the socket while the channel is live: the handle still
        /// numbers and records each one. Its connection's Transmit is wrapped once per connection object.</summary>
        private void Mute()
        {
            var connection = room.Connection;
            if (connection == null || ReferenceEquals(connection, muted)) return;
            muted = connection;
            var transmit = connection.Transmit;
            connection.Transmit = data =>
            {
                var input = data != null && data.Length > 0 && (data[0] & Protocol.CODE_MASK) == Protocol.ROOM_INPUT_RELIABLE;
                if (input && link != null && ReferenceEquals(room.Connection, connection))
                {
                    Status.MutedFrames++;
                    return Task.CompletedTask;
                }
                return transmit(data);
            };
        }

        /// <summary>The socket dropped: the channel closes; the reconnect gets a new binding (the SDK resets the handle).</summary>
        public void Dropped()
        {
            probe?.Close();
            probe = null;
            probeApplied = 0;
            retryAt = null;
            attempt = 0;
            liveSince = null;
            hostReturns = false;
            link?.Client.Close();
            link = null;
            guard?.Forget();
            fallback = null;
            fastAck = 0;
            early.Clear();
            pendingBind = null;
            hasPendingBind = false;
            Status.Live = false;
            Status.Fallback = null;
            Status.Transport = GenexFastTransportName.WebSocket;
            announcer.Reset();
            joinedAt = null;
            boundUrl = null;
            snapshotsBefore = Status.Snapshots;
        }

        public void Dispose()
        {
            probe?.Close();
            probe = null;
            link?.Client.Close();
            link = null;
            Status.Live = false;
            guard?.Dispose();
        }
    }

    /// <summary>Writes snapshots into the decoded state as a patch would, and holds the channel's fields against the
    /// WebSocket's while it is live (TypeScript fast-session.ts <c>motionGuard</c>).</summary>
    internal sealed class GenexMotionGuard
    {
        /// <summary>A field the channel holds: the value it wrote, and the WebSocket's latest value for the field.</summary>
        private sealed class HeldField
        {
            public object Fast;
            public object Ws;
        }

        private sealed class ByReference : IEqualityComparer<Schema>
        {
            public bool Equals(Schema a, Schema b) => ReferenceEquals(a, b);
            public int GetHashCode(Schema s) => RuntimeHelpers.GetHashCode(s);
        }

        private static readonly string[] RootTick = { "tick" };
        private static readonly string[] RootTickAndKeyframe = { "tick", "keyframe" };

        private readonly Room<AuthorityRoomState> room;
        private readonly Func<GenexFastClient> live;
        private readonly FieldInfo stateChangeField;
        private readonly FieldInfo serializerField;
        /// <summary>Each entity and player instance's record kind and id, as the latest state has them.</summary>
        private readonly Dictionary<Schema, KeyValuePair<int, string>> owners = new Dictionary<Schema, KeyValuePair<int, string>>(new ByReference());
        /// <summary>Every field the channel holds, by the instance it is on (the root's tick and keyframe too).</summary>
        private readonly Dictionary<Schema, Dictionary<string, HeldField>> held = new Dictionary<Schema, Dictionary<string, HeldField>>(new ByReference());
        private Decoder<AuthorityRoomState> decoder;
        private TriggerChangesDelegate inner;
        private TriggerChangesDelegate guarded;
        private Connection dispatching;
        private Action<ConnectionEvent> dispatch;
        private Action<ConnectionEvent> wrapped;
        /// <summary>True inside a WebSocket decode while the held fields show the WebSocket's values.</summary>
        private bool exposed;

        public GenexMotionGuard(Room<AuthorityRoomState> room, Func<GenexFastClient> live, FieldInfo stateChangeField, FieldInfo serializerField)
        {
            this.room = room;
            this.live = live;
            this.stateChangeField = stateChangeField;
            this.serializerField = serializerField;
        }

        /// <summary>Hooks the decoder's change trigger and the connection's dispatch (once each; again when either was
        /// replaced since).</summary>
        public void Install()
        {
            var d = (serializerField.GetValue(room) as SchemaSerializer<AuthorityRoomState>)?.Decoder;
            if (d != null && (d != decoder || d.TriggerChanges != guarded))
            {
                if (decoder != null && decoder.TriggerChanges == guarded) decoder.TriggerChanges = inner;
                decoder = d;
                inner = d.TriggerChanges;
                guarded = Guarded;
                d.TriggerChanges = guarded;
            }
            var connection = room.Connection;
            if (connection == null || (ReferenceEquals(connection, dispatching) && connection.Dispatch == wrapped)) return;
            if (dispatching != null && dispatching.Dispatch == wrapped) dispatching.Dispatch = dispatch;
            dispatching = connection;
            dispatch = connection.Dispatch;
            var previous = dispatch;
            wrapped = e =>
            {
                var state = e.Type == ConnectionEvent.Kind.Message && e.Data != null && e.Data.Length > 0 && IsState(e.Data[0]);
                if (state && live() != null && held.Count > 0) Expose();
                try
                {
                    previous(e);
                }
                finally
                {
                    Cover();
                }
            };
            connection.Dispatch = wrapped;
        }

        private static bool IsState(byte first)
        {
            var code = first & Protocol.CODE_MASK;
            return code == Protocol.ROOM_STATE_PATCH || code == Protocol.ROOM_STATE;
        }

        private void Learn()
        {
            owners.Clear();
            var state = room.State;
            if (state?.entities != null)
                foreach (var kv in state.entities)
                    if (kv.Value != null) owners[kv.Value] = new KeyValuePair<int, string>(GenexMotionRecordKind.Entity, kv.Key);
            if (state?.players != null)
                foreach (var kv in state.players)
                    if (kv.Value != null) owners[kv.Value] = new KeyValuePair<int, string>(GenexMotionRecordKind.Seat, kv.Key);
        }

        private GenexMotionRecord RecordOf(Schema instance)
        {
            var client = live();
            return client != null && owners.TryGetValue(instance, out var owner) ? client.MotionOf(owner.Key, owner.Value) : null;
        }

        /// <summary>Whether <paramref name="instance"/> is still in the state (an entity or seat a patch removed is not).</summary>
        private bool Current(Schema instance)
        {
            var state = room.State;
            if (ReferenceEquals(instance, state)) return true;
            if (!owners.TryGetValue(instance, out var owner) || state == null) return false;
            if (owner.Key == GenexMotionRecordKind.Entity)
                return state.entities != null && state.entities.TryGetValue(owner.Value, out var e) && ReferenceEquals(e, instance);
            return state.players != null && state.players.TryGetValue(owner.Value, out var p) && ReferenceEquals(p, instance);
        }

        /// <summary>The channel writes <paramref name="value"/> into <paramref name="instance"/>'s field; the value it covers is
        /// the WebSocket's.</summary>
        private void Hold(Schema instance, string field, object value, List<DataChange> changes)
        {
            if (!held.TryGetValue(instance, out var fields))
            {
                fields = new Dictionary<string, HeldField>();
                held[instance] = fields;
            }
            if (fields.TryGetValue(field, out var known)) known.Fast = value;
            else fields[field] = new HeldField { Fast = value, Ws = instance[field] };
            WriteField(instance, field, value, changes);
        }

        /// <summary>Shows the WebSocket's values in the held fields, for the decode to measure its changes against.</summary>
        private void Expose()
        {
            Learn();
            foreach (var instance in held.Keys.ToList())
            {
                if (!Current(instance))
                {
                    held.Remove(instance);
                    continue;
                }
                foreach (var kv in held[instance])
                    if (!Equals(kv.Value.Ws, kv.Value.Fast)) instance[kv.Key] = kv.Value.Ws;
            }
            exposed = true;
        }

        /// <summary>Puts the channel's values back in the held fields.</summary>
        private void Cover()
        {
            if (!exposed) return;
            exposed = false;
            foreach (var instance in held)
                foreach (var kv in instance.Value)
                    if (!Equals(kv.Value.Ws, kv.Value.Fast)) instance.Key[kv.Key] = kv.Value.Fast;
        }

        /// <summary>A WebSocket change to a held field: kept as the WebSocket's value, and not reported.</summary>
        private bool Heard(DataChange change)
        {
            if (change.Field == null || decoder == null) return false;
            if (!(decoder.Refs.Get(change.RefId) is Schema instance) || !held.TryGetValue(instance, out var fields)) return false;
            if (!fields.TryGetValue(change.Field, out var f)) return false;
            f.Ws = change.Value;
            return true;
        }

        private void Guarded(ref List<DataChange> changes)
        {
            if (live() == null)
            {
                inner?.Invoke(ref changes);
                return;
            }
            Learn();
            // An entity or seat a patch adds while the channel holds its record starts at the record.
            foreach (var change in changes)
            {
                if (!(change.Value is Schema added)) continue;
                var record = RecordOf(added);
                if (record != null) WriteRecord(added, record, null);
            }
            var reported = changes.Where(c => !Heard(c)).ToList();
            Cover();
            inner?.Invoke(ref reported);
        }

        /// <summary>The state's tick as the WebSocket last wrote it (the channel holds the state's own).</summary>
        public double WebSocketTick()
        {
            var state = room.State;
            if (state == null) return 0;
            if (held.TryGetValue(state, out var fields) && fields.TryGetValue("tick", out var f) && f.Ws != null) return Convert.ToDouble(f.Ws);
            return state.tick;
        }

        /// <summary>Writes one applied snapshot's changed records and its tick into the state, reports them to the change
        /// listeners, then raises the room's OnStateChange.</summary>
        public void Write(GenexFastSnapshot s)
        {
            Install();
            Learn();
            var state = room.State;
            if (state == null) return;
            var changes = new List<DataChange>();
            foreach (var record in s.Changed)
            {
                Schema instance = null;
                if (record.Kind == GenexMotionRecordKind.Entity && state.entities != null && state.entities.TryGetValue(record.Id, out var e)) instance = e;
                else if (record.Kind == GenexMotionRecordKind.Seat && state.players != null && state.players.TryGetValue(record.Id, out var p)) instance = p;
                if (instance != null) WriteRecord(instance, record, changes);
            }
            // A room that patches keyframe (a predicting one) has written it by now; elsewhere it stays as decoded.
            foreach (var field in state.keyframe != 0 ? RootTickAndKeyframe : RootTick) Hold(state, field, (double)s.Tick, changes);
            if (changes.Count > 0) inner?.Invoke(ref changes);
            RaiseStateChange();
        }

        /// <summary>The channel closed: every field it held takes the WebSocket's latest value, reported as a patch;
        /// in a physics room an entity's motion keeps the channel's until the server's full resend (PROTOCOL.md
        /// §17.12 <i>Downlink</i>: its WebSocket values date from when the channel went live).</summary>
        public void Release()
        {
            Learn();
            var changes = new List<DataChange>();
            var resent = !string.IsNullOrEmpty(room.State?.physics);
            foreach (var kv in held)
            {
                if (!Current(kv.Key)) continue;
                if (resent && owners.TryGetValue(kv.Key, out var owner) && owner.Key == GenexMotionRecordKind.Entity) continue;
                foreach (var f in kv.Value) WriteField(kv.Key, f.Key, f.Value.Ws, changes);
            }
            held.Clear();
            if (changes.Count == 0) return;
            inner?.Invoke(ref changes);
            RaiseStateChange();
        }

        /// <summary>The socket dropped: forget the held fields (the reconnect's full state rewrites every one).</summary>
        public void Forget() => held.Clear();

        public void Dispose()
        {
            held.Clear();
            if (decoder != null && decoder.TriggerChanges == guarded) decoder.TriggerChanges = inner;
            if (dispatching != null && dispatching.Dispatch == wrapped) dispatching.Dispatch = dispatch;
        }

        private void RaiseStateChange()
        {
            if (room.State != null) (stateChangeField.GetValue(room) as Delegate)?.DynamicInvoke(room.State, false);
        }

        /// <summary>Writes <paramref name="record"/>'s fields into <paramref name="instance"/> through the channel's hold
        /// (the seat's own ack is no schema field).</summary>
        private void WriteRecord(Schema instance, GenexMotionRecord record, List<DataChange> changes)
        {
            var fields = GenexFastRecords.FieldsOf(record.Kind);
            for (var i = 0; i < fields.Length; i++)
            {
                var name = fields[i].Name;
                if (name == GenexFastRecords.SeatAckField) continue;
                object value = fields[i].Wire == GenexFieldWire.Flag ? (object)(record.Values[i] == 1) : record.Values[i];
                Hold(instance, name, value, changes);
            }
        }

        /// <summary>Writes a field through the schema's indexer, the change reported into <paramref name="changes"/> (null:
        /// reported by the patch that added the instance).</summary>
        private static void WriteField(Schema instance, string field, object value, List<DataChange> changes)
        {
            var previous = instance[field];
            if (Equals(previous, value)) return;
            instance[field] = value;
            changes?.Add(new DataChange { RefId = instance.__refId, Op = (byte)OPERATION.REPLACE, Field = field, Value = value, PreviousValue = previous });
        }
    }
}
