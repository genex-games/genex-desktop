// One Genex room session (play or match room) over the official Colyseus C# SDK:
// players, shared state, objects with confirmed control, host, inputs, game events, chat, the §8
// reconnect contract, §10 interpolation and the §16 clock heartbeat.
//
// THREADING: everything here runs on the thread that owns the Colyseus room callbacks — Unity's main
// thread (the SDK posts socket events to the SynchronizationContext). Call Tick() once per frame from
// that same thread (GenexPump does). No thread-pool timers (WebGL has none): every deadline is checked
// in TickTimers(), which Tick() also runs. Call TickTimers() from a wall-clock timer as well, so the
// heartbeat and host ticks keep running when the frame loop stops (GenexPump does this on WebGL, where
// a hidden tab stops requestAnimationFrame).
//
// Engine-agnostic: no UnityEngine here.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;
using Colyseus;
using Genex.Multiplayer.Wire;
using P = Genex.Multiplayer.GenexProtocol;

namespace Genex.Multiplayer
{
    public sealed class GenexSession
    {
        // ---------------- clock ----------------

        private static readonly Stopwatch Watch = Stopwatch.StartNew();

        /// <summary>
        /// This client's send clock (ms): monotonic, arbitrary origin, never exactly 0 (§6.1). Every
        /// stamp this session sends (__t, obj t, pose t) uses it.
        /// </summary>
        public static double Now() => Watch.Elapsed.TotalMilliseconds + 1 + TestClockSkewMs;

        // Test seam (the conformance driver's `skew`, DRIVER.md): a deliberate clock-origin offset. Not for games.
        internal static double TestClockSkewMs { get; set; }

        // ---------------- state ----------------

        private readonly Room<RoomState> room;
        private readonly bool poseEnabled;
        private readonly Interpolator interp = new Interpolator();
        private readonly string requestPrefix;
        private int requestCounter;

        private sealed class PlayerMirror
        {
            public string Data;
            public double Epoch;
            public bool Posed;
            public double PoseT;
            public Dictionary<string, object> DataState = new Dictionary<string, object>();
            public Dictionary<string, object> Pose;
            public GenexPlayer View;
            public readonly Dictionary<string, object> Rendered = new Dictionary<string, object>(); // posed: data + smoothed pose
        }

        private sealed class ObjectMirror
        {
            public string Owner = ""; // confirmed by the relay
            public double Seq;
            public double Epoch;
            public double T;
            public string D = "";
            public Dictionary<string, object> Raw = new Dictionary<string, object>();
            public GenexObject View;
        }

        private sealed class PendingControl
        {
            public string Operation; // claim | release | remove
            public string Id;
            public string RequestId;
            public string WireType;
            public Dictionary<string, object> Payload;
            public bool Optimistic;
            public double Deadline;
            public TaskCompletionSource<ObjectControlResult> Tcs;
        }

        private sealed class HostTick
        {
            public double IntervalMs;
            public Action<double> Callback;
            public bool Active;
            public double NextAt;
            public double LastAt;
            public bool Disposed;
        }

        private readonly Dictionary<string, PlayerMirror> players = new Dictionary<string, PlayerMirror>();
        private readonly Dictionary<string, GenexPlayer> playerViews = new Dictionary<string, GenexPlayer>();
        private readonly Dictionary<string, ObjectMirror> objects = new Dictionary<string, ObjectMirror>();
        private readonly Dictionary<string, GenexObject> objectViews = new Dictionary<string, GenexObject>();
        private readonly Dictionary<string, string> optimisticOwner = new Dictionary<string, string>();
        // Owner from an accepted control result ("" = none) until the relay's patch shows that change:
        // the result reaches us before the patch, and "await Claim, then SetObject" must work at once.
        private readonly Dictionary<string, string> acceptedOwner = new Dictionary<string, string>();
        private readonly Dictionary<string, Dictionary<string, object>> localObjState = new Dictionary<string, Dictionary<string, object>>();
        private readonly Dictionary<string, string> sharedText = new Dictionary<string, string>();
        private readonly Dictionary<string, object> sharedValues = new Dictionary<string, object>();
        private readonly Dictionary<string, PendingControl> pending = new Dictionary<string, PendingControl>();
        private readonly List<HostTick> hostTicks = new List<HostTick>();
        private bool runningHostTicks;
        private readonly HashSet<string> warned = new HashSet<string>();
        private readonly List<ChatMessage> chat = new List<ChatMessage>();
        private readonly HashSet<double> chatIds = new HashSet<double>();
        private readonly HashSet<string> muted = new HashSet<string>();
        private readonly HashSet<string> bridgedEvents = new HashSet<string>();

        private Dictionary<string, object> localState;
        private string lastSentData;      // pose mode: the last `data` text sent (sent only on change)
        private double[] lastPosePos;     // pose mode: velocity derivation memory (t, x, y, z)
        private string hostId = "";
        private string matchText = "";
        private Dictionary<string, object> matchState;

        private bool dead;
        private bool intentionalLeave;
        private bool connected = true;
        private bool reconnecting;
        private int reconnectAttempt;
        private double reconnectStartedAt;
        private int dropGeneration;
        private bool awaitingResync;
        private int resyncGeneration;
        private double resyncDeadline;
        private int droppedWhileOffline;

        // §16 clock
        private InputHandle heartbeat;
        private double nextHeartbeatAt;
        private int lastAckSeen;
        private int ackedHeartbeats;
        private readonly Random rng = new Random();

        private readonly TaskCompletionSource<bool> firstState = new TaskCompletionSource<bool>();

        // ---------------- events ----------------

        /// <summary>A player was seated (also fires for yourself).</summary>
        public event Action<GenexPlayer> PlayerJoined;
        /// <summary>A player's seat is gone.</summary>
        public event Action<string> PlayerLeft;
        /// <summary>A player's raw data, name, team or connectivity changed.</summary>
        public event Action<GenexPlayer> PlayerChanged;
        /// <summary>A shared key changed (key, parsed value).</summary>
        public event Action<string, object> SharedChanged;
        /// <summary>An object appeared, changed owner, or was destroyed (fires with its id).</summary>
        public event Action<string> ObjectChanged;
        /// <summary>The room host changed (new host session id, or null).</summary>
        public event Action<string> HostChanged;
        /// <summary>An input arrived for the host (from, payload). Only fires while you are the host.</summary>
        public event Action<string, object> InputReceived;
        /// <summary>A chat line you had not seen yet (live, or filled in by history).</summary>
        public event Action<ChatMessage> ChatReceived;
        /// <summary>The connection dropped and the SDK is reconnecting (attempt, close code).</summary>
        public event Action<int, int> Reconnecting;
        /// <summary>Reconnected: same session, and the state is current again.</summary>
        public event Action Reconnected;
        /// <summary>The session is over (terminal close code, §11). Not raised after Leave().</summary>
        public event Action<int> Disconnected;
        /// <summary>The relay dropped this many of your messages for rate (§5.1).</summary>
        public event Action<int> RateDropped;
        /// <summary>The relay is about to restart (§14): flush anything you persist.</summary>
        public event Action ServerRestart;
        /// <summary>The host opened or closed the room to matchmaking.</summary>
        public event Action<bool> RoomOpenChanged;
        /// <summary>Match rooms: the match state JSON changed (parsed).</summary>
        public event Action<Dictionary<string, object>> MatchChanged;
        /// <summary>Match rooms: match:start {roundId}.</summary>
        public event Action<double> MatchStarted;
        /// <summary>Match rooms: match:ended {winnerId, losers, draw, scores}.</summary>
        public event Action<Dictionary<string, object>> MatchEnded;
        /// <summary>Match rooms: you must leave and search again (§9.2). GenexMatchmaker handles it for you.</summary>
        public event Action<string> MatchRequeue;

        // ---------------- construction ----------------

        internal GenexSession(Room<RoomState> room, bool pose)
        {
            this.room = room;
            poseEnabled = pose;
            requestPrefix = Guid.NewGuid().ToString("N").Substring(0, 8);

            var r = room.Reconnection;
            r.Enabled = P.Reconnection.Enabled;
            r.MinUptime = P.Reconnection.MinUptime;
            r.Delay = P.Reconnection.Delay;
            r.MinDelay = P.Reconnection.MinDelay;
            r.MaxDelay = P.Reconnection.MaxDelay;
            r.MaxRetries = P.Reconnection.MaxRetries;
            r.MaxEnqueuedMessages = P.Reconnection.MaxEnqueuedMessages;

            room.OnStateChange += OnStateChange;
            room.OnDrop += OnDrop;
            room.OnReconnect += OnReconnect;
            room.OnLeave += OnLeave;

            room.OnMessage<object>(P.ServerMessage.ObjectResult, m => OnObjectResult(GenexJson.NormalizeMap(m)));
            room.OnMessage<object>(P.ServerMessage.Input, m => OnInput(GenexJson.NormalizeMap(m)));
            room.OnMessage<object>(P.ServerMessage.RoomOpen, m => RoomOpenChanged?.Invoke(GenexJson.Bool(GenexJson.NormalizeMap(m), "open")));
            room.OnMessage<object>(P.ServerMessage.Chat, m => OnChatLine(GenexJson.NormalizeMap(m)));
            room.OnMessage<object>(P.ServerMessage.ChatHistory, m => OnChatHistory(GenexJson.NormalizeMap(m)));
            room.OnMessage<object>(P.ServerMessage.RateDrop, m =>
            {
                var n = (int)GenexJson.Num(GenexJson.NormalizeMap(m), "dropped");
                Warn("rate", $"[genex] the relay dropped {n} message(s) for rate — publish less (idle objects ≤2 Hz).");
                RateDropped?.Invoke(n);
            });
            room.OnMessage<object>(P.ServerMessage.ServerRestart, m => ServerRestart?.Invoke());
            room.OnMessage<object>(P.ServerMessage.MatchStart, m => MatchStarted?.Invoke(GenexJson.Num(GenexJson.NormalizeMap(m), "roundId")));
            room.OnMessage<object>(P.ServerMessage.MatchEnded, m => MatchEnded?.Invoke(GenexJson.NormalizeMap(m)));
            room.OnMessage<object>(P.ServerMessage.MatchRequeue, m => MatchRequeue?.Invoke(GenexJson.Str(GenexJson.NormalizeMap(m), "reason")));
            // Voice is not offered on native engines; swallow its server messages quietly.
            room.OnMessage<object>(P.ServerMessage.VoiceIce, m => { });
            room.OnMessage<object>(P.ServerMessage.VoiceSignal, m => { });
            room.OnMessage<object>(P.ServerMessage.VoiceRejected, m => { });

            // §16: the clock is present when the join handshake carried INPUT_REFLECTION; Input() throws otherwise.
            try { heartbeat = room.Input(); }
            catch (Exception) { heartbeat = null; }
            nextHeartbeatAt = Now();

            if (room.WaitForFirstState().IsCompleted) OnStateChange(room.State, true);
            // History after the listener exists (§12): a push at join could beat it.
            SendRaw(P.ClientMessage.ChatHistoryRequest, new Dictionary<string, object>());
        }

        /// <summary>Completes when the first full state has been decoded (the relay always sends one).</summary>
        internal Task FirstState => firstState.Task;

        // ---------------- identity / room ----------------

        /// <summary>Your session id.</summary>
        public string Id => room.SessionId;
        public string RoomId => room.RoomId;
        /// <summary>The room type: "play" or "match".</summary>
        public string RoomName => room.Name;
        /// <summary>The underlying Colyseus room, for anything this layer does not wrap.</summary>
        public Room<RoomState> Room => room;
        public bool IsConnected => connected && !dead;
        public bool IsReconnecting => reconnecting && !dead;
        public bool IsClosed => dead;
        /// <summary>Voice is mesh WebRTC in browsers only; native engines do not offer it.</summary>
        public bool VoiceSupported => false;

        /// <summary>Everyone in the room, including you. Views are updated in place by Tick() and state patches.</summary>
        public IReadOnlyDictionary<string, GenexPlayer> Players => playerViews;
        public GenexPlayer Me => playerViews.TryGetValue(Id ?? "", out var v) ? v : null;

        /// <summary>Session id of the elected host, or null.</summary>
        public string Host => string.IsNullOrEmpty(hostId) ? null : hostId;

        /// <summary>
        /// True only while the relay names you host AND the session is connected with its post-reconnect
        /// sequence complete (§6.3 client duty). Run host simulation only while this is true.
        /// </summary>
        public bool IsHost => !dead && connected && !reconnecting && !string.IsNullOrEmpty(hostId) && hostId == Id;

        /// <summary>Match rooms: the parsed match state (§9.3), or null in a play room.</summary>
        public Dictionary<string, object> Match => matchState;

        // ---------------- player state ----------------

        /// <summary>
        /// Publish your state (replaced wholesale). Call on a fixed tick of ~10–20 Hz, never every frame.
        /// Values: the GenexJson value model (numbers go out as float64). "__t" is stamped for you.
        /// </summary>
        public void SetState(IDictionary<string, object> state) => PublishState(state, false);

        /// <summary>Publish a deliberate discontinuity (respawn, teleport): receivers drop your history.</summary>
        public void SnapState(IDictionary<string, object> state) => PublishState(state, true);

        private void PublishState(IDictionary<string, object> state, bool snap)
        {
            var clean = GenexJson.NormalizeMap(state);
            if (clean.Remove(P.SendTimeKey)) Warn("__t", "[genex] '__t' is reserved for the send clock; your value was ignored.");
            localState = clean;
            var t = Now();
            if (poseEnabled)
            {
                PublishPose(clean, t, snap);
                return;
            }
            var data = new Dictionary<string, object>(clean) { [P.SendTimeKey] = t };
            var json = GenexJson.Serialize(data);
            if (json.Length > P.Limits.MaxStateBytes) { Warn("state-size", "[genex] player state over 16 KiB was not sent."); return; }
            SendRaw(snap ? P.ClientMessage.StateSnap : P.ClientMessage.State, json);
        }

        // §6.6: pose keys → __pose, the rest → `data`, sent only when it changes.
        private void PublishPose(Dictionary<string, object> clean, double t, bool snap)
        {
            var pose = new Dictionary<string, object> { ["t"] = t };
            var data = new Dictionary<string, object>();
            foreach (var kv in clean)
            {
                if (Array.IndexOf(P.PoseKeys, kv.Key) < 0) { data[kv.Key] = kv.Value; continue; }
                if (kv.Key == "anim")
                {
                    if (kv.Value is string a && a.Length <= P.Limits.MaxAnimChars) pose["anim"] = a;
                }
                else if (kv.Value is double d && Math.Abs(d) <= P.Limits.MaxPoseAbs) pose[kv.Key] = d;
            }
            // Derive velocity the game did not supply (Δposition / Δt, units per second).
            var prev = lastPosePos;
            var dt = prev != null ? t - prev[0] : 0;
            var usable = prev != null && dt > P.Interpolation.MinGapMs && dt < P.Interpolation.MaxGapMs;
            var mem = new[] { t, double.NaN, double.NaN, double.NaN };
            string[][] axes = { new[] { "x", "vx" }, new[] { "y", "vy" }, new[] { "z", "vz" } };
            for (var i = 0; i < 3; i++)
            {
                if (!(pose.TryGetValue(axes[i][0], out var pv) && pv is double p)) continue;
                mem[i + 1] = p;
                if (pose.ContainsKey(axes[i][1])) continue;
                var before = prev != null ? prev[i + 1] : double.NaN;
                var v = usable && !double.IsNaN(before) ? (p - before) / dt * 1000 : 0;
                pose[axes[i][1]] = double.IsNaN(v) || double.IsInfinity(v) || Math.Abs(v) > P.Limits.MaxPoseAbs ? 0 : v;
            }
            lastPosePos = mem;
            SendRaw(snap ? P.ClientMessage.PoseSnap : P.ClientMessage.Pose, pose);
            var dataText = GenexJson.Serialize(data);
            if (dataText == lastSentData) return;
            lastSentData = dataText;
            data[P.SendTimeKey] = t;
            var json = GenexJson.Serialize(data);
            if (json.Length > P.Limits.MaxStateBytes) { Warn("state-size", "[genex] player state over 16 KiB was not sent."); return; }
            SendRaw(P.ClientMessage.State, json);
        }

        // ---------------- shared ----------------

        public object GetShared(string key) => sharedValues.TryGetValue(key, out var v) ? v : null;
        public IEnumerable<string> SharedKeys => sharedValues.Keys;

        /// <summary>Set a room-wide value (any JSON). By convention only the host writes agreed facts. No delete: write null.</summary>
        public void SetShared(string key, object value)
        {
            if (string.IsNullOrEmpty(key) || key.Length > P.Limits.MaxSharedKeyChars || key.StartsWith(P.ReservedSharedPrefix, StringComparison.Ordinal))
            {
                Warn("shared-key:" + key, $"[genex] shared key '{key}' refused (empty, over 256 chars, or reserved '__').");
                return;
            }
            var text = GenexJson.Serialize(value);
            if (text.Length > P.Limits.MaxSharedValueBytes) { Warn("shared-size", "[genex] shared value over 64 KiB was not sent."); return; }
            SendRaw(P.ClientMessage.Shared, new Dictionary<string, object> { ["key"] = key, ["value"] = text });
        }

        // ---------------- objects ----------------

        public IReadOnlyDictionary<string, GenexObject> Objects => objectViews;
        public GenexObject GetObject(string id) => objectViews.TryGetValue(id, out var v) ? v : null;

        public Task<ObjectControlResult> Claim(string id, ControlOptions options = null) => Control("claim", P.ClientMessage.Claim, id, options);
        public Task<ObjectControlResult> Release(string id, ControlOptions options = null) => Control("release", P.ClientMessage.Release, id, options);
        /// <summary>Owner-only: delete the object everywhere. The result's operation is "remove".</summary>
        public Task<ObjectControlResult> Destroy(string id, ControlOptions options = null) => Control("remove", P.ClientMessage.Destroy, id, options);

        private Task<ObjectControlResult> Control(string operation, string wireType, string id, ControlOptions options)
        {
            options ??= new ControlOptions();
            var requestId = requestPrefix + ":" + (++requestCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var tcs = new TaskCompletionSource<ObjectControlResult>();
            if (dead)
            {
                tcs.SetResult(Settled(operation, id, requestId, "disconnected"));
                return tcs.Task;
            }
            var payload = new Dictionary<string, object> { ["id"] = id, ["requestId"] = requestId };
            if (operation == "claim" && options.HostAuthority) payload["authority"] = "host";
            var timeout = Math.Min(60000, Math.Max(0, options.TimeoutMs));
            var pc = new PendingControl
            {
                Operation = operation, Id = id, RequestId = requestId, WireType = wireType, Payload = payload,
                Optimistic = operation == "claim" && options.Optimistic, Deadline = Now() + timeout, Tcs = tcs,
            };
            pending[requestId] = pc;
            if (pc.Optimistic)
            {
                optimisticOwner[id] = Id;
                RefreshObjectView(id);
            }
            // Offline: not sent (and not counted as lost) — resent with the same requestId after reconnect (§7.2).
            if (connected && !reconnecting) SendRaw(wireType, payload);
            return tcs.Task;
        }

        private ObjectControlResult Settled(string operation, string id, string requestId, string reason)
        {
            objects.TryGetValue(id, out var m);
            return new ObjectControlResult
            {
                RequestId = requestId, Operation = operation, Id = id, Accepted = false,
                Owner = m != null && m.Owner != "" ? m.Owner : null, Sequence = m?.Seq ?? 0, Reason = reason,
            };
        }

        private void OnObjectResult(Dictionary<string, object> m)
        {
            var requestId = GenexJson.Str(m, "requestId");
            if (requestId == null || !pending.TryGetValue(requestId, out var pc)) return; // not ours, or already settled
            pending.Remove(requestId);
            var result = new ObjectControlResult
            {
                RequestId = requestId,
                Operation = GenexJson.Str(m, "operation", pc.Operation),
                Id = GenexJson.Str(m, "id", pc.Id),
                Accepted = GenexJson.Bool(m, "accepted"),
                Owner = GenexJson.Str(m, "owner"),
                Sequence = GenexJson.Num(m, "sequence"),
                Reason = GenexJson.Str(m, "reason", ""),
                RetryAfterMs = m.TryGetValue("retryAfterMs", out var ra) && ra is double rd ? rd : (double?)null,
            };
            if (pc.Optimistic) optimisticOwner.Remove(pc.Id);
            if (result.Accepted)
            {
                // Only while the state has not caught up: a result replayed after a reconnect (§7.2) can be
                // older than the full state we already decoded, and the state wins then.
                var stateSeq = objects.TryGetValue(pc.Id, out var om) ? om.Seq : -1;
                if (result.Sequence > stateSeq)
                    acceptedOwner[pc.Id] = result.Operation == "claim" ? (result.Owner ?? Id) : "";
            }
            if (result.Operation != "claim" || !result.Accepted || result.Owner != Id) localObjState.Remove(pc.Id);
            RefreshObjectView(pc.Id);
            pc.Tcs.TrySetResult(result);
        }

        /// <summary>Publish an object's state. Only takes effect while you own it (await Claim first).</summary>
        public void SetObject(string id, IDictionary<string, object> state) => PublishObject(id, state, false);

        /// <summary>Owner-only hard reset / teleport: receivers reseed instead of easing.</summary>
        public void SnapObject(string id, IDictionary<string, object> state) => PublishObject(id, state, true);

        private void PublishObject(string id, IDictionary<string, object> state, bool snap)
        {
            if (OwnerView(id) != Id)
            {
                Warn("obj:" + id, $"[genex] object '{id}' publish ignored: you do not own it — await Claim('{id}') and check Accepted.");
                return;
            }
            var d = GenexJson.NormalizeMap(state);
            if (GenexJson.Serialize(d).Length > P.Limits.MaxObjectStateBytes) { Warn("obj-size", "[genex] object state over 64 KiB was not sent."); return; }
            localObjState[id] = d;
            RefreshObjectView(id);
            SendRaw(snap ? P.ClientMessage.ObjectSnap : P.ClientMessage.Object,
                new Dictionary<string, object> { ["id"] = id, ["d"] = d, ["t"] = Now() });
        }

        private string OwnerView(string id)
        {
            if (optimisticOwner.TryGetValue(id, out var o)) return o;
            if (acceptedOwner.TryGetValue(id, out var a)) return a == "" ? null : a;
            return objects.TryGetValue(id, out var m) && m.Owner != "" ? m.Owner : null;
        }

        // ---------------- inputs, game events, room ----------------

        /// <summary>Send an input to the current host only (§6.4). Not queued while disconnected.</summary>
        public void SendInput(object payload) =>
            SendRaw(P.ClientMessage.Input, GenexJson.Normalize(payload) ?? new Dictionary<string, object>());

        /// <summary>Fire-and-forget event to every OTHER client (§5.4). Reserved names are refused.</summary>
        public void Send(string type, object payload = null)
        {
            if (string.IsNullOrEmpty(type) || type.Length > P.Limits.MaxEventTypeChars || P.IsReservedEventType(type))
            {
                Warn("event:" + type, $"[genex] event type '{type}' is reserved or invalid; pick another name.");
                return;
            }
            SendRaw(type, payload == null ? null : GenexJson.Normalize(payload));
        }

        /// <summary>Receive a game event other clients send with Send(type, …). Returns an unsubscribe action.</summary>
        public Action On(string type, Action<object> handler)
        {
            if (string.IsNullOrEmpty(type) || P.IsReservedEventType(type))
                throw new ArgumentException($"'{type}' is not a game event type", nameof(type));
            bridgedEvents.Add(type);
            return room.OnMessage<object>(type, m => handler(GenexJson.Normalize(m)));
        }

        /// <summary>HOST ONLY: stop (false) or resume (true) matchmaking placements into this room (§6.5).</summary>
        public void SetRoomOpen(bool open) => SendRaw(P.ClientMessage.RoomOpen, new Dictionary<string, object> { ["open"] = open });

        /// <summary>
        /// Run <paramref name="callback"/>(dtMs) at <paramref name="hz"/> only while <see cref="IsHost"/>. dt is clamped
        /// to 250 ms. Driven by TickTimers() (Tick() runs it too). Returns a disposer.
        /// </summary>
        public Action OnHostTick(double hz, Action<double> callback)
        {
            var ht = new HostTick { IntervalMs = 1000 / Math.Max(0.1, hz), Callback = callback };
            hostTicks.Add(ht);
            return () =>
            {
                ht.Disposed = true;
                if (!runningHostTicks) hostTicks.Remove(ht); // otherwise swept after the running pass
            };
        }

        // ---------------- match self-reports (match rooms) ----------------

        public void ReportScore(double delta = 1) => SendRaw(P.ClientMessage.MatchScore, new Dictionary<string, object> { ["delta"] = delta });
        public void ReportEliminated() => SendRaw(P.ClientMessage.MatchEliminated, new Dictionary<string, object>());
        public void ReportFinish() => SendRaw(P.ClientMessage.MatchFinish, new Dictionary<string, object>());

        // ---------------- chat ----------------

        /// <summary>Send a chat line. Render only what arrives via ChatReceived — your own line comes back too (§12).</summary>
        public void SendChat(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            SendRaw(P.ClientMessage.Chat, new Dictionary<string, object> { ["text"] = text });
        }

        /// <summary>Every line known to this client, oldest first.</summary>
        public IReadOnlyList<ChatMessage> ChatHistory => chat;
        public void Mute(string playerId) => muted.Add(playerId);
        public void Unmute(string playerId) => muted.Remove(playerId);

        private void OnChatLine(Dictionary<string, object> m)
        {
            var msg = new ChatMessage
            {
                Id = GenexJson.Num(m, "id", double.NaN), From = GenexJson.Str(m, "from", ""), Name = GenexJson.Str(m, "name", ""),
                Text = GenexJson.Str(m, "text", ""), At = GenexJson.Num(m, "at"),
            };
            if (double.IsNaN(msg.Id) || !chatIds.Add(msg.Id)) return;
            var i = chat.Count;
            while (i > 0 && chat[i - 1].Id > msg.Id) i--;
            chat.Insert(i, msg);
            if (!muted.Contains(msg.From)) ChatReceived?.Invoke(msg);
        }

        private void OnChatHistory(Dictionary<string, object> m)
        {
            var list = GenexJson.List(m, "messages");
            if (list == null) return;
            foreach (var item in list)
                if (item is Dictionary<string, object> line) OnChatLine(line);
        }

        // ---------------- clock (§16) ----------------

        /// <summary>True when the relay publishes its clock (the handshake carried INPUT_REFLECTION).</summary>
        public bool ClockAvailable => heartbeat != null;
        /// <summary>Server clock (ms since room creation), or null against a relay without a clock. Never for rendering.</summary>
        public double? ServerNow => heartbeat != null ? room.Clock.ServerNow() : (double?)null;
        /// <summary>Smoothed RTT in ms (an upper bound: it includes the relay's patch hold), or null.</summary>
        public double? Rtt => heartbeat != null && ackedHeartbeats > 0 ? room.Clock.SmoothedRtt() : (double?)null;
        /// <summary>True after 30 acked heartbeats: ServerNow is then within a few ms of the room clock.</summary>
        public bool ClockSynced => heartbeat != null && ackedHeartbeats >= P.ClockSync.WarmupAcks;

        /// <summary>
        /// Milliseconds until a relay epoch-ms deadline (match startsAt/endsBy): on the server clock once
        /// synced (§16.3), otherwise against this device's wall clock.
        /// </summary>
        public double TimeUntil(double epochMs)
        {
            var origin = room.State != null ? room.State.clockOrigin : 0;
            if (ClockSynced && origin != 0 && ServerNow.HasValue) return (epochMs - origin) - ServerNow.Value;
            return epochMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        private void PumpHeartbeat(double now)
        {
            if (heartbeat == null || dead || intentionalLeave) return;
            var acked = heartbeat.LastProcessed;
            if (acked > lastAckSeen) { ackedHeartbeats += acked - lastAckSeen; lastAckSeen = acked; }
            if (now < nextHeartbeatAt) return;
            var baseMs = 1000 / P.ClockSync.HeartbeatHz;
            var dither = (rng.NextDouble() * 2 - 1) * P.ClockSync.HeartbeatDither;
            var interval = Math.Min(1000 / P.ClockSync.MinHeartbeatHz, Math.Max(1000 / P.ClockSync.MaxHeartbeatHz, baseMs * (1 + dither)));
            nextHeartbeatAt = now + interval;
            if (room.Connection == null || !room.Connection.IsOpen) return; // never queue a heartbeat
            heartbeat.Send(); // body-less on no change; the relay ignores its value
        }

        // ---------------- the pumps ----------------

        /// <summary>
        /// Advance everything: the time-driven work (<see cref="TickTimers"/>) and then the interpolated
        /// views. Call once per frame on the main thread (GenexPump does this in Unity).
        /// </summary>
        public void Tick()
        {
            var now = Now();
            RunTimers(now);
            foreach (var kv in players) RefreshPlayerSmoothed(kv.Key, kv.Value, now);
            foreach (var id in objects.Keys) RefreshObjectSmoothed(id, now);
        }

        /// <summary>
        /// Only the time-driven work: heartbeats (§16.2), control timeouts, the post-reconnect deadline and
        /// host ticks (§6.3). Cheap and idempotent between deadlines. Call it from a WALL-CLOCK timer on the
        /// main thread too, so a stopped frame loop (a hidden WebGL tab) never freezes the room; GenexPump
        /// does this on WebGL. Tick() runs it as well.
        /// </summary>
        public void TickTimers() => RunTimers(Now());

        private void RunTimers(double now)
        {
            PumpHeartbeat(now);

            if (pending.Count > 0)
            {
                List<PendingControl> expired = null;
                foreach (var pc in pending.Values)
                    if (now >= pc.Deadline) (expired ??= new List<PendingControl>()).Add(pc);
                if (expired != null)
                    foreach (var pc in expired) SettleControl(pc, "timeout");
            }

            if (awaitingResync && now >= resyncDeadline) FinishReconnect(resyncGeneration);

            if (hostTicks.Count == 0 || runningHostTicks) return;
            var isHost = IsHost;
            runningHostTicks = true;
            try
            {
                var count = hostTicks.Count; // ticks added by a callback start on the next pass
                for (var i = 0; i < count; i++)
                {
                    var ht = hostTicks[i];
                    if (ht.Disposed) continue;
                    if (!isHost) { ht.Active = false; continue; }
                    if (!ht.Active) { ht.Active = true; ht.LastAt = now; ht.NextAt = now; }
                    if (now < ht.NextAt) continue;
                    var dt = Math.Min(P.Interpolation.MaxHostTickDtMs, Math.Max(0, now - ht.LastAt));
                    ht.LastAt = now;
                    ht.NextAt += ht.IntervalMs;
                    if (ht.NextAt < now) ht.NextAt = now + ht.IntervalMs; // no catch-up bursts
                    ht.Callback(dt);
                    if (!IsHost) isHost = false; // the callback may have left or been demoted: the rest go inactive
                }
            }
            finally
            {
                runningHostTicks = false;
                hostTicks.RemoveAll(IsDisposed);
            }
        }

        private static readonly Predicate<HostTick> IsDisposed = ht => ht.Disposed;

        // ---------------- leave ----------------

        /// <summary>Leave the room deliberately: no reconnect, no Disconnected event.</summary>
        public Task Leave()
        {
            if (dead || intentionalLeave) return Task.CompletedTask;
            intentionalLeave = true;
            foreach (var pc in new List<PendingControl>(pending.Values)) SettleControl(pc, "aborted");
            // A socket that is down cannot carry the leave; OnReconnect finishes it if the SDK gets back in.
            return room.Leave(true);
        }

        // ---------------- room callbacks ----------------

        private void OnDrop(int code)
        {
            if (intentionalLeave || dead) return;
            dropGeneration++;
            if (!reconnecting)
            {
                reconnecting = true;
                reconnectAttempt = 0;
                reconnectStartedAt = Now();
            }
            awaitingResync = false;
            connected = false; // IsHost is false from here: host simulation stops now
            lastAckSeen = 0;   // the relay gives the reconnected socket a fresh input buffer (§16.2)
            var r = room.Reconnection;
            if (r.IsReconnecting && r.RetryCount >= r.MaxRetries) return; // the SDK gives up next (4003)
            Reconnecting?.Invoke(++reconnectAttempt, code);
        }

        private void OnReconnect()
        {
            if (dead) return;
            if (intentionalLeave)
            {
                Forget(room.Leave(true));
                return;
            }
            var gap = reconnectStartedAt > 0 ? Now() - reconnectStartedAt : 0;
            // §8 step 2, done before the snapshot lands so its samples seed the rebased history.
            if (gap > P.Interpolation.RebaseAfterGapMs) interp.ClearAll();
            lastAckSeen = 0;
            awaitingResync = true;
            resyncGeneration = dropGeneration;
            resyncDeadline = Now() + P.Reconnection.FirstStateTimeoutMs;
        }

        // §8 post-reconnect sequence, steps 3–6 (step 1 is the first full-state decode, or the 2 s cap).
        private void FinishReconnect(int generation)
        {
            awaitingResync = false;
            if (generation != dropGeneration || dead || intentionalLeave) return; // a newer drop owns the lifecycle
            // 3. The C# SDK's resync already fired removals, and the state diff pruned our mirrors.
            if (room.State != null) Diff(room.State);
            // 4. Resend pending controls with their original requestIds; re-request chat history.
            foreach (var pc in new List<PendingControl>(pending.Values)) SendRaw(pc.WireType, pc.Payload);
            SendRaw(P.ClientMessage.ChatHistoryRequest, new Dictionary<string, object>());
            // 5.
            reconnecting = false;
            reconnectStartedAt = 0;
            connected = true;
            // 6.
            Reconnected?.Invoke();
            if (droppedWhileOffline > 0)
            {
                ColyseusContext.Logger.LogWarning($"[genex] {droppedWhileOffline} message(s) were dropped while reconnecting (never queued); state re-synced.");
                droppedWhileOffline = 0;
            }
            if (Host != null) HostChanged?.Invoke(Host); // IsHost may have flipped back on
        }

        private void OnLeave(int code)
        {
            if (dead) return;
            dead = true;
            connected = false;
            reconnecting = false;
            awaitingResync = false;
            foreach (var pc in new List<PendingControl>(pending.Values)) SettleControl(pc, "disconnected");
            firstState.TrySetException(new GenexJoinException(code, "room closed before its first state"));
            if (intentionalLeave) return;
            Disconnected?.Invoke(code);
        }

        private void SettleControl(PendingControl pc, string reason)
        {
            if (!pending.Remove(pc.RequestId)) return;
            if (pc.Optimistic) { optimisticOwner.Remove(pc.Id); RefreshObjectView(pc.Id); }
            pc.Tcs.TrySetResult(Settled(pc.Operation, pc.Id, pc.RequestId, reason));
        }

        // ---------------- state diff ----------------

        private void OnStateChange(RoomState state, bool isFirstState)
        {
            if (state == null) return;
            Diff(state);
            firstState.TrySetResult(true);
            if (isFirstState && awaitingResync) FinishReconnect(resyncGeneration);
        }

        private void Diff(RoomState state)
        {
            var now = Now();
            var me = Id;

            // ---- players ----
            List<GenexPlayer> joined = null, changed = null;
            foreach (var kv in state.players)
            {
                var sid = kv.Key;
                var p = kv.Value;
                if (p == null) continue;
                var isNew = !players.TryGetValue(sid, out var pm);
                if (isNew)
                {
                    pm = new PlayerMirror { Epoch = p.epoch, View = new GenexPlayer { Id = sid, IsMe = sid == me } };
                    players[sid] = pm;
                    playerViews[sid] = pm.View;
                }
                var v = pm.View;
                var meta = v.Name != p.name || v.Uid != p.uid || v.AvatarUrl != p.avatarUrl || v.Team != (int)p.team || v.Connected != p.connected;
                v.Name = p.name ?? "";
                v.Uid = p.uid ?? "";
                v.AvatarUrl = p.avatarUrl ?? "";
                v.Team = (int)p.team;
                v.Connected = p.connected;

                if (!isNew && p.epoch != pm.Epoch) interp.Clear(sid); // §10 step 6: drop history, place at the new state
                pm.Epoch = p.epoch;
                v.Epoch = p.epoch;
                pm.Posed = p.posed;
                v.Posed = p.posed;

                var dataChanged = pm.Data != p.data;
                if (dataChanged)
                {
                    pm.Data = p.data;
                    var parsed = GenexJson.ParseObject(p.data) ?? new Dictionary<string, object>();
                    var hasStamp = parsed.TryGetValue(P.SendTimeKey, out var st) && st is double;
                    var s = hasStamp ? (double)st : 0;
                    parsed.Remove(P.SendTimeKey);
                    pm.DataState = parsed;
                    // A sample needs a stamp and a remote sender; a posed player's data is snapped, not a sample (§10.1).
                    if (!p.posed && hasStamp && sid != me) interp.Push(sid, sid, s, parsed, false, now);
                }
                if (p.posed && p.poseT != 0 && p.poseT != pm.PoseT)
                {
                    pm.PoseT = p.poseT;
                    pm.Pose = new Dictionary<string, object>
                    {
                        ["x"] = p.x, ["y"] = p.y, ["z"] = p.z, ["yaw"] = p.yaw,
                        ["vx"] = p.vx, ["vy"] = p.vy, ["vz"] = p.vz, ["anim"] = p.anim ?? "",
                    };
                    if (sid != me) interp.Push(sid, sid, p.poseT, pm.Pose, true, now);
                }
                v.StateRaw = Present(pm.DataState, pm.Posed ? pm.Pose : null);
                RefreshPlayerSmoothed(sid, pm, now);
                if (isNew) (joined ??= new List<GenexPlayer>()).Add(v);
                else if (dataChanged || meta) (changed ??= new List<GenexPlayer>()).Add(v);
            }
            List<string> left = null;
            foreach (var sid in players.Keys)
                if (!state.players.ContainsKey(sid)) (left ??= new List<string>()).Add(sid);
            if (left != null)
                foreach (var sid in left)
                {
                    players.Remove(sid);
                    playerViews.Remove(sid);
                    interp.Clear(sid);
                    interp.ClearSender(sid);
                }

            // ---- objects (§7.3 decode rules, in order) ----
            List<string> objChanged = null;
            foreach (var kv in state.objects)
            {
                var id = kv.Key;
                var o = kv.Value;
                if (o == null) continue;
                var key = "obj:" + id;
                var isNew = !objects.TryGetValue(id, out var om);
                if (isNew)
                {
                    om = new ObjectMirror { View = new GenexObject { Id = id } };
                    objects[id] = om;
                    objectViews[id] = om.View;
                }
                var ownerChanged = isNew || o.seq != om.Seq || (o.owner ?? "") != om.Owner;
                if (!isNew && o.seq != om.Seq) interp.SoftReset(key); // 1. ownership moved: soft handoff
                if (!isNew && o.epoch != om.Epoch) interp.Clear(key); // 2. hard reset
                om.Owner = o.owner ?? "";
                om.Seq = o.seq;
                om.Epoch = o.epoch;
                if (ownerChanged) acceptedOwner.Remove(id); // the state now shows the change a result announced
                if (ownerChanged && om.Owner != me) localObjState.Remove(id);
                if (om.D != o.d)
                {
                    om.D = o.d ?? "";
                    om.Raw = GenexJson.ParseObject(om.D) ?? new Dictionary<string, object>();
                }
                if (o.t != om.T)
                {
                    om.T = o.t;
                    // 3. A nonzero t is a sample on the CURRENT owner's clock. 4. t = 0 is a resting pose: never a sample.
                    if (o.t != 0 && om.Owner != "" && om.Owner != me) interp.Push(key, om.Owner, o.t, om.Raw, false, now);
                }
                RefreshObjectView(id);
                if (ownerChanged) (objChanged ??= new List<string>()).Add(id);
            }
            List<string> gone = null;
            foreach (var id in objects.Keys)
                if (!state.objects.ContainsKey(id)) (gone ??= new List<string>()).Add(id);
            if (gone != null)
                foreach (var id in gone)
                {
                    objects.Remove(id);
                    objectViews.Remove(id);
                    localObjState.Remove(id);
                    optimisticOwner.Remove(id);
                    acceptedOwner.Remove(id);
                    interp.Clear("obj:" + id);
                    (objChanged ??= new List<string>()).Add(id);
                }

            // ---- shared ----
            List<string> sharedChanged = null;
            foreach (var kv in state.shared)
            {
                if (sharedText.TryGetValue(kv.Key, out var old) && old == kv.Value) continue;
                sharedText[kv.Key] = kv.Value;
                sharedValues[kv.Key] = GenexJson.TryParse(kv.Value, out var val) ? val : null;
                (sharedChanged ??= new List<string>()).Add(kv.Key);
            }

            // ---- host / match ----
            var newHost = state.host ?? "";
            var hostChanged = newHost != hostId;
            hostId = newHost;
            var matchChanged = (state.match ?? "") != matchText;
            if (matchChanged)
            {
                matchText = state.match ?? "";
                matchState = matchText == "" ? null : GenexJson.ParseObject(matchText);
            }

            // ---- events, after the whole patch is applied ----
            if (joined != null) foreach (var v in joined) PlayerJoined?.Invoke(v);
            if (changed != null) foreach (var v in changed) PlayerChanged?.Invoke(v);
            if (left != null) foreach (var sid in left) PlayerLeft?.Invoke(sid);
            if (objChanged != null) foreach (var id in objChanged) ObjectChanged?.Invoke(id);
            if (sharedChanged != null) foreach (var k in sharedChanged) SharedChanged?.Invoke(k, sharedValues[k]);
            if (hostChanged) HostChanged?.Invoke(Host);
            if (matchChanged) MatchChanged?.Invoke(matchState);
        }

        // A posed player's state is its parsed data with the pose keys merged over it (§6.6).
        private static Dictionary<string, object> Present(Dictionary<string, object> data, Dictionary<string, object> pose)
        {
            if (pose == null) return data;
            var o = new Dictionary<string, object>(data);
            foreach (var kv in pose) o[kv.Key] = kv.Value;
            return o;
        }

        private void RefreshPlayerSmoothed(string sid, PlayerMirror pm, double now)
        {
            var v = pm.View;
            if (sid == Id)
            {
                v.State = localState ?? v.StateRaw; // §6.1: render yourself from your last local publish
                return;
            }
            var smooth = interp.Sample(sid, now);
            if (smooth == null) v.State = v.StateRaw;
            else if (!pm.Posed) v.State = smooth;
            else
            {
                // Reused per player: no allocation per frame.
                var o = pm.Rendered;
                o.Clear();
                foreach (var kv in pm.DataState) o[kv.Key] = kv.Value;
                foreach (var kv in smooth) o[kv.Key] = kv.Value;
                v.State = o;
            }
        }

        private void RefreshObjectView(string id)
        {
            if (!objects.TryGetValue(id, out var om)) return;
            var v = om.View;
            v.Owner = OwnerView(id);
            v.Seq = om.Seq;
            v.Epoch = om.Epoch;
            v.IsMine = v.Owner != null && v.Owner == Id;
            v.StateRaw = om.Raw;
            RefreshObjectSmoothed(id, Now());
        }

        private void RefreshObjectSmoothed(string id, double now)
        {
            if (!objects.TryGetValue(id, out var om)) return;
            var v = om.View;
            if (v.IsMine)
            {
                var mine = localObjState.TryGetValue(id, out var local) ? local : om.Raw;
                v.State = mine;
                // §10 step 6 for the EX-owner: keep the stream's eased output at the pose on screen, so if this
                // client loses the object the soft handoff glides from here, not from a stale pre-claim pose.
                interp.Seed("obj:" + id, mine, now);
                return;
            }
            v.State = interp.Sample("obj:" + id, now) ?? om.Raw;
        }

        private void OnInput(Dictionary<string, object> m)
        {
            if (!IsHost) return;
            InputReceived?.Invoke(GenexJson.Str(m, "from", ""), m.TryGetValue("d", out var d) ? d : null);
        }

        // ---------------- plumbing ----------------

        private bool SendRaw(string type, object payload)
        {
            // §8: never send on a socket that is not open, and never queue.
            if (dead || room.Connection == null || !room.Connection.IsOpen)
            {
                if (!dead) droppedWhileOffline++;
                return false;
            }
            Forget(payload == null ? room.Send(type) : room.Send(type, payload));
            return true;
        }

        private static void Forget(Task t)
        {
            if (t == null || t.IsCompleted) { _ = t?.Exception; return; }
            t.ContinueWith(x => { _ = x.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        }

        private void Warn(string key, string message)
        {
            if (warned.Add(key)) ColyseusContext.Logger.LogWarning(message);
        }
    }
}
