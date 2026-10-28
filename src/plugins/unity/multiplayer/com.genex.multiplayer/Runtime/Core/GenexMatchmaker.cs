// Matchmaking (PROTOCOL.md §9.2): search in the `queue` room, consume the `seat` reservation into a
// `match` room, and search again on `match:requeue`, a failed consume, or a dropped queue socket.
// Retries are scheduled on deadlines checked in TickTimers() (Tick() runs it too) — no thread-pool timers,
// so it also runs on WebGL. A transient failure (network, 5xx, a relay mid-deploy) is retried forever with
// capped, jittered backoff; only 426, or a 400/401/403 that repeats with a fresh token, stops the search.
// Engine-agnostic: no UnityEngine here.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Colyseus;
using Genex.Multiplayer.Wire;
using P = Genex.Multiplayer.GenexProtocol;

namespace Genex.Multiplayer
{
    public sealed class GenexMatchmaker
    {
        private const double SearchBackoffBaseMs = 1000;
        private const double SearchBackoffMaxMs = 8000;
        private static readonly double[] QueueResearchDelaysMs = { 500, 1000, 2000, 4000, 8000 };
        private readonly Random rng = new Random();

        private readonly GenexConnectOptions options;
        private Client client;
        private Room<NoState> queueRoom;
        private bool cancelled;
        private bool searching;
        private bool seating;
        private int epoch;
        private int searchAttempt;
        private int authRefusals;
        private int queueDrops;
        private double retryAt = double.NaN;

        /// <summary>"searching", "matched", "cancelled", "failed" or "disconnected".</summary>
        public string Status { get; private set; } = "searching";
        /// <summary>The match session once seated, else null.</summary>
        public GenexSession Session { get; private set; }
        public int QueuePosition { get; private set; }
        public int QueueSize { get; private set; }

        public event Action<int, int> QueueChanged;
        public event Action<GenexSession> Matched;
        /// <summary>
        /// A refusal the matchmaker will not retry: 426 (the game needs an update), a 400/401/403 that repeats
        /// with a fresh token, or a bad configuration. Network errors and 5xx are retried, never reported here.
        /// </summary>
        public event Action<Exception> Failed;
        /// <summary>
        /// The match (or queue) seat ended with a close that must not be retried automatically: 4401 revoked,
        /// 4409 superseded, 4002 protocol error, or 1000 normal close (§11).
        /// </summary>
        public event Action<int> Disconnected;
        /// <summary>A join attempt failed transiently and will be retried in the given ms (attempt, delayMs, error).</summary>
        public event Action<int, double, Exception> SearchRetrying;

        private GenexMatchmaker(GenexConnectOptions options) { this.options = options; }

        /// <summary>Start searching. Call <see cref="Tick"/> every frame (it also ticks the match session).</summary>
        public static GenexMatchmaker Start(GenexConnectOptions options)
        {
            var mm = new GenexMatchmaker(options);
            _ = mm.Search();
            return mm;
        }

        /// <summary>Per frame: ticks the match session (views and timers) and runs due retries.</summary>
        public void Tick()
        {
            Session?.Tick();
            RunRetry();
        }

        /// <summary>The time-driven part only (see <see cref="GenexSession.TickTimers"/>): call it from a wall-clock timer.</summary>
        public void TickTimers()
        {
            Session?.TickTimers();
            RunRetry();
        }

        private void RunRetry()
        {
            if (!double.IsNaN(retryAt) && GenexSession.Now() >= retryAt)
            {
                retryAt = double.NaN;
                _ = Search();
            }
        }

        /// <summary>Stop searching and leave whatever room this matchmaker holds.</summary>
        public void Cancel()
        {
            cancelled = true;
            epoch++;
            Status = "cancelled";
            retryAt = double.NaN;
            Forget(Session?.Leave());
            Session = null;
            LeaveQueue();
        }

        private async Task Search()
        {
            if (cancelled || searching) return;
            searching = true;
            var myEpoch = ++epoch;
            try
            {
                Session = null;
                Status = "searching";
                LeaveQueue();
                Room<NoState> q;
                try
                {
                    client ??= await GenexMultiplayer.SelectClient(options); // one relay for the life of the search (§3.1)
                    var joinOptions = await GenexMultiplayer.BuildJoinOptions(options); // a fresh token per join (§3.2)
                    q = await client.JoinOrCreate(P.RoomType.Queue, joinOptions);
                }
                catch (Exception e)
                {
                    if (cancelled) return;
                    var code = e is MatchMakeException mme ? mme.Code : e is HttpException he ? he.StatusCode : 0;
                    var refusedProtocol = code == P.JoinError.ProtocolUnsupported;
                    var refusedAuth = code == P.JoinError.BadOption || code == P.JoinError.AuthRequired || code == P.JoinError.Forbidden;
                    // A 400/401/403 gets exactly one more try: that attempt reads a fresh token (§3.2).
                    if (refusedAuth) authRefusals++;
                    if (refusedProtocol || (refusedAuth && authRefusals > 1) || e is ArgumentException)
                    {
                        Status = "failed";
                        Failed?.Invoke(code != 0 ? new GenexJoinException(code, refusedProtocol ? "relay refused protocol " + P.Version : e.Message, e) : e);
                        return;
                    }
                    // Transient (network, 5xx, a relay restarting): keep searching, capped exponential backoff ±20%.
                    var backoff = Math.Min(SearchBackoffMaxMs, SearchBackoffBaseMs * Math.Pow(2, Math.Min(searchAttempt, 10)));
                    backoff *= 0.8 + 0.4 * rng.NextDouble();
                    searchAttempt++;
                    retryAt = GenexSession.Now() + backoff;
                    SearchRetrying?.Invoke(searchAttempt, backoff, e);
                    return;
                }
                searchAttempt = 0;
                authRefusals = 0;
                if (cancelled || myEpoch != epoch) { Forget(q.Leave(true)); return; }
                q.Reconnection.Enabled = false; // the queue holds no seat: search again instead (§8)
                queueRoom = q;
                q.OnMessage<object>(P.ServerMessage.Queue, m =>
                {
                    var d = GenexJson.NormalizeMap(m);
                    QueuePosition = (int)GenexJson.Num(d, "position");
                    QueueSize = (int)GenexJson.Num(d, "size");
                    QueueChanged?.Invoke(QueuePosition, QueueSize);
                });
                q.OnMessage<object>(P.ServerMessage.Seat, m =>
                {
                    if (cancelled || myEpoch != epoch || queueRoom != q || seating) return;
                    seating = true;
                    queueRoom = null;
                    Forget(q.Leave(true));
                    _ = ConsumeSeat(GenexJson.NormalizeMap(m), myEpoch);
                });
                q.OnLeave += code =>
                {
                    if (cancelled || queueRoom != q) return;
                    queueRoom = null;
                    if (IsTerminal(code)) { Stop(code); return; }
                    // §9.2 step 3: a dropped queue (restart, network, 4000 convergence) searches again, backing off.
                    retryAt = GenexSession.Now() + QueueResearchDelaysMs[Math.Min(queueDrops++, QueueResearchDelaysMs.Length - 1)];
                };
            }
            finally { searching = false; }
        }

        private async Task ConsumeSeat(Dictionary<string, object> msg, int myEpoch)
        {
            try
            {
                var r = GenexJson.Map(msg, "reservation");
                if (r == null) throw new InvalidOperationException("seat without reservation");
                var reservation = new SeatReservation
                {
                    name = GenexJson.Str(r, "name"), sessionId = GenexJson.Str(r, "sessionId"), roomId = GenexJson.Str(r, "roomId"),
                    publicAddress = GenexJson.Str(r, "publicAddress"), processId = GenexJson.Str(r, "processId"),
                    reconnectionToken = GenexJson.Str(r, "reconnectionToken"), devMode = GenexJson.Bool(r, "devMode"),
                    protocol = GenexJson.Str(r, "protocol"),
                };
                var room = await client.ConsumeSeatReservation<RoomState>(reservation);
                if (cancelled || myEpoch != epoch) { Forget(room.Leave(true)); return; }
                var s = await GenexMultiplayer.Attach(room, options);
                Session = s;
                Status = "matched";
                queueDrops = 0;
                s.MatchRequeue += reason => { if (Session == s) _ = Requeue(); };
                s.Disconnected += code =>
                {
                    if (cancelled || Session != s) return;
                    if (IsTerminal(code)) { Stop(code); return; }
                    _ = Requeue(); // 4000 (requeue grace, server drain), 4001, 4003: search again
                };
                Matched?.Invoke(s);
            }
            catch (Exception)
            {
                if (!cancelled && myEpoch == epoch) { seating = false; _ = Search(); } // e.g. token rotated: fresh search
            }
            finally
            {
                if (myEpoch == epoch) seating = false;
            }
        }

        private async Task Requeue()
        {
            if (cancelled) return;
            epoch++;
            seating = false;
            var s = Session;
            Session = null;
            if (s != null) await s.Leave(); // deliberate leave, within the 5 s requeue grace (§9.2)
            await Search();
        }

        // §11: never search again automatically after these.
        private static bool IsTerminal(int code) =>
            code == P.CloseCode.Revoked || code == P.CloseCode.Superseded || code == P.CloseCode.WithError || code == P.CloseCode.Normal;

        private void Stop(int code)
        {
            epoch++;
            Session = null;
            seating = false;
            retryAt = double.NaN;
            LeaveQueue();
            Status = "disconnected";
            Disconnected?.Invoke(code);
        }

        private void LeaveQueue()
        {
            var q = queueRoom;
            queueRoom = null;
            if (q != null) Forget(q.Leave(true));
        }

        private static void Forget(Task t)
        {
            if (t == null || t.IsCompleted) { _ = t?.Exception; return; }
            t.ContinueWith(x => { _ = x.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        }
    }
}
