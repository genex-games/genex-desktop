// Drain and rejoin (PROTOCOL.md §17.13). GenexRejoin is the pure rule, as the TypeScript's rejoin.ts: which close sends a
// seat back into play by itself, which refusal ends the rejoin, and each attempt's wait, region and way in;
// Tests~/GenexSmoke/RejoinCheck.cs holds authority-rejoin.json exactly, as every SDK does.
// GenexAuthoritySession is what a game holds: a room that ends for a deploy, or a socket no reconnect restored, swaps a
// new seat (GenexAuthoritySeat, the room's whole client) in behind it, and the game's object, its handlers and its input
// stay what they were. Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Colyseus;
using Genex.Multiplayer.Authority.Wire;
using P = Genex.Multiplayer.GenexProtocol;

namespace Genex.Multiplayer.Authority
{
    /// <summary>The ways back: the lost room by its id (a socket drop, where it may still live), its successor, or the game's pool.</summary>
    public enum GenexRejoinWay { Room, Successor, Pool }

    /// <summary>Why a rejoin stopped, or None for one more attempt.</summary>
    public enum GenexRejoinStop { None, Final, Budget }

    /// <summary>The next attempt of a rejoin, or why there is none.</summary>
    public readonly struct GenexRejoinStep
    {
        public readonly GenexRejoinStop Stop;
        public readonly double WaitMs;
        public readonly int Region;
        public readonly GenexRejoinWay Way;

        public GenexRejoinStep(GenexRejoinStop stop, double waitMs = 0, int region = 0, GenexRejoinWay way = GenexRejoinWay.Successor)
        {
            Stop = stop;
            WaitMs = waitMs;
            Region = region;
            Way = way;
        }
    }

    /// <summary>The rule of §17.13, pure.</summary>
    public static class GenexRejoin
    {
        /// <summary>Waits before each attempt, ms; past the end the last one repeats.</summary>
        public static readonly double[] ScheduleMs = { 0, 250, 500, 1000, 2000, 4000 };
        /// <summary>Each wait adds up to this much, by chance, so a room's seats do not arrive at once.</summary>
        public const double JitterMs = 250;
        /// <summary>How long a seat keeps trying: long enough for a roll's next process to come up on a full node.</summary>
        public const double BudgetMs = 180000;
        /// <summary>How long a seat stays with its own region before it tries the next one.</summary>
        public const double RegionStayMs = 60000;
        /// <summary>How long a public seat looks for its room's successor before it joins the game's pool.</summary>
        public const double SuccessorMs = 90000;
        /// <summary><see cref="GenexAuthoritySession.Draining"/> when an older server does not say how long the room has.</summary>
        public const double UnknownCloseMs = -1;

        private const int ServerShutdown = 4001;

        /// <summary>The closes a seat comes back from: the server's trouble, never the game's or the player's.</summary>
        public static bool ComesBackAfter(int code)
        {
            switch (code)
            {
                case 1001:
                case 1005:
                case 1006:
                case 1011:
                case 1012:
                case 1013:
                case ServerShutdown:
                case 4003:
                case 4010:
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>The refusals a retry cannot change: a bad join, no entitlement, a game taken down, no module, an SDK
        /// too old. A full server, a quota, an expired token and a matchmaker shutting down all go on.</summary>
        public static bool RefusalIsFinal(int code) => code == 400 || code == 402 || code == 403 || code == 424 || code == 426;

        /// <summary>The next attempt: <paramref name="attempt"/> counts those already made, <paramref name="refusal"/> is what
        /// the last was refused with (null: none yet, or a failed network), <paramref name="closed"/> that the lost room was
        /// private, <paramref name="jitter"/> a number in [0, 1).</summary>
        public static GenexRejoinStep Next(int attempt, double elapsedMs, int? refusal, int lostCode, bool closed, int regions, double jitter)
        {
            if (refusal.HasValue && RefusalIsFinal(refusal.Value)) return new GenexRejoinStep(GenexRejoinStop.Final);
            if (elapsedMs >= BudgetMs) return new GenexRejoinStep(GenexRejoinStop.Budget);
            var waitMs = ScheduleMs[Math.Min(attempt, ScheduleMs.Length - 1)] + Math.Floor(jitter * JitterMs);
            if (attempt == 0 && lostCode != ServerShutdown) return new GenexRejoinStep(GenexRejoinStop.None, waitMs, 0, GenexRejoinWay.Room);
            var region = regions < 1 ? 0 : (int)(Math.Floor(elapsedMs / RegionStayMs) % regions);
            var way = closed || elapsedMs < SuccessorMs ? GenexRejoinWay.Successor : GenexRejoinWay.Pool;
            return new GenexRejoinStep(GenexRejoinStop.None, waitMs, region, way);
        }
    }

    /// <summary>
    /// One server-authoritative room, as the game holds it (<see cref="GenexAuthority.Connect"/>). Everything reads the
    /// current seat; when the room ends on the server's account, the seat moves by itself (§17.13) and this object,
    /// its <see cref="Input"/>, its events and its <see cref="On"/> handlers stay.
    /// </summary>
    public sealed class GenexAuthoritySession
    {
        private readonly GenexAuthorityOptions options;
        private readonly string[] targets;
        private readonly bool closed;
        private readonly Random chance = new Random();
        private readonly Dictionary<string, List<Action<object>>> handlers = new Dictionary<string, List<Action<object>>>();
        private GenexAuthoritySeat seat;
        private bool left;
        private bool rejoining;
        private GenexFirstpersonWorld world;
        private string physicsHash;

        /// <summary>The input sent on each fixed step. Mutate it any time; <see cref="Frame()"/> sends it.</summary>
        public GenexInput Input { get; }

        /// <summary>(attempt, close code): the socket dropped and the SDK reconnects in place.</summary>
        public event Action<int, int> Reconnecting;
        /// <summary>Back in the same seat.</summary>
        public event Action Reconnected;
        /// <summary>Terminal: the seat is gone (4500 halted, 4501 module fault, §11), or a rejoin ran out: the close it lost. Not raised after <see cref="Leave"/>.</summary>
        public event Action<int> Disconnected;
        /// <summary>The server is draining (<c>server:restart</c>): the room ends soon.</summary>
        public event Action ServerRestart;
        /// <summary>The server closes this room in this many ms for a deploy (§17.13), -1 when an older server does not say. Play on: the seat moves by itself.</summary>
        public event Action<double> Draining;
        /// <summary>(attempt from 1, the close that lost the room, ms until the attempt): the seat is on its way back. Say so; there is nothing to do.</summary>
        public event Action<int, int, double> Rejoining;
        /// <summary>Back in play: a new seat (<see cref="Id"/>) in a new room (<see cref="Code"/>).</summary>
        public event Action Rejoined;

        internal GenexAuthoritySession(GenexAuthoritySeat first, GenexAuthorityOptions options, GenexInput input, string[] targets, bool closed)
        {
            this.options = options;
            this.targets = targets;
            this.closed = closed;
            Input = input;
            world = null;
            Bind(first);
        }

        private void Bind(GenexAuthoritySeat next)
        {
            seat = next;
            next.Reconnecting += (attempt, code) =>
            {
                if (next == seat) Reconnecting?.Invoke(attempt, code);
            };
            next.Reconnected += () =>
            {
                if (next == seat) Reconnected?.Invoke();
            };
            next.ServerRestart += () =>
            {
                if (next == seat) ServerRestart?.Invoke();
            };
            next.Disconnected += code =>
            {
                if (next == seat && !left) Lost(code);
            };
            next.On(P.ServerMessage.ServerRestart, data =>
            {
                if (next != seat) return;
                var notice = data as Dictionary<string, object>;
                var known = notice != null && notice.TryGetValue("drainMs", out var ms) && ms is IConvertible;
                Draining?.Invoke(known ? Convert.ToDouble(notice["drainMs"]) : GenexRejoin.UnknownCloseMs);
            });
            foreach (var type in handlers.Keys) Forward(next, type);
        }

        private void Forward(GenexAuthoritySeat from, string type) =>
            from.On(type, data =>
            {
                if (from != seat || !handlers.TryGetValue(type, out var list)) return;
                foreach (var handler in list.ToArray()) handler(data);
            });

        private void Lost(int code)
        {
            if (options.Rejoin && GenexRejoin.ComesBackAfter(code))
            {
                rejoining = true;
                _ = Rejoin(code);
                return;
            }
            Disconnected?.Invoke(code);
        }

        private async Task Rejoin(int lostCode)
        {
            var startedAt = GenexTime.Now();
            var lostRoom = seat.Code;
            var matchKey = seat.MatchKey;
            var attempt = 0;
            int? refusal = null;
            while (!left)
            {
                var step = GenexRejoin.Next(attempt, GenexTime.Now() - startedAt, refusal, lostCode, closed, targets.Length, chance.NextDouble());
                if (step.Stop != GenexRejoinStop.None)
                {
                    rejoining = false;
                    Disconnected?.Invoke(lostCode);
                    return;
                }
                attempt += 1;
                Rejoining?.Invoke(attempt, lostCode, step.WaitMs);
                await GenexTime.Delay(step.WaitMs);
                if (left) return;
                try
                {
                    var next = await GenexAuthority.JoinSeat(options, targets[step.Region], step.Way, lostRoom, matchKey, closed, Input);
                    if (left)
                    {
                        await next.Leave();
                        return;
                    }
                    Adopt(next);
                    return;
                }
                catch (GenexJoinException e)
                {
                    refusal = e.Code > 0 ? e.Code : (int?)null;
                }
                catch (Exception)
                {
                    refusal = null;
                }
            }
        }

        private void Adopt(GenexAuthoritySeat next)
        {
            Bind(next);
            rejoining = false;
            if (world != null) next.SetWorld(world);
            if (physicsHash != null) next.SetPhysics(physicsHash);
            Rejoined?.Invoke();
        }

        public string Id => seat.Id;
        public string RoomId => seat.RoomId;
        /// <summary>The room's invite code (§17.2 *Choosing a room*); a rejoin brings a new one.</summary>
        public string Code => seat.Code;
        public string MatchKey => seat.MatchKey;
        public string Url => seat.Url;
        public Room<AuthorityRoomState> Room => seat.Room;
        public bool IsConnected => seat.IsConnected;
        /// <summary>Over for good: a rejoin on its way is not closed, only not connected.</summary>
        public bool IsClosed => seat.IsClosed && !rejoining;
        public double Tick => seat.Tick;
        public string Preset => seat.Preset;
        public double Rtt => seat.Rtt;
        public GenexFastStatus Fast => seat.Fast;
        public GenexAuthorityTelemetry Telemetry => seat.Telemetry;
        public bool IsReady => seat.IsReady;
        public GenexAuthorityEntity Me => seat.Me;
        public IReadOnlyDictionary<string, GenexAuthorityEntity> Entities => seat.Entities;
        public IReadOnlyDictionary<string, GenexAuthorityPlayer> Players => seat.Players;
        public GenexAuthorityEntity Entity(string id) => seat.Entity(id);
        public double ServerTick => seat.ServerTick;
        public double DrawnTick => seat.DrawnTick;
        public double SeatDrawTick => seat.SeatDrawTick;
        public double SeatDrawLead => seat.SeatDrawLead;
        public GenexFirstpersonWorld World => seat.World;
        public GenexPredictionStatus Prediction => seat.Prediction;
        public string PredictProjectile(GenexProjectilePrediction projectile) => seat.PredictProjectile(projectile);
        public double RedrawProjectiles() => seat.RedrawProjectiles();
        public bool RedrawBodies() => seat.RedrawBodies();
        public int Frame() => seat.Frame();
        public int Frame(double now) => seat.Frame(now);
        public void TickTimers() => seat.TickTimers();
        public double LengthUnit => seat.LengthUnit;
        public GenexPhysicsPredictionStatus PhysicsPrediction => seat.PhysicsPrediction;
        public GenexPhysicsStatus Physics => seat.Physics;

        /// <summary>The <c>firstperson</c> or <c>vehicle</c> collision world, for this seat and any seat after it.</summary>
        public uint SetWorld(GenexFirstpersonWorld next)
        {
            var hash = seat.SetWorld(next);
            world = next;
            return hash;
        }

        /// <summary>The physicsHash your client runs a copy of, for this seat and any seat after it.</summary>
        public string SetPhysics(string hash)
        {
            physicsHash = hash;
            return seat.SetPhysics(hash);
        }

        /// <summary>Receive the events the room module emits with <c>ctx.emit(type, data)</c> (and <c>server:restart</c>),
        /// from this seat and any seat after it. Returns an unsubscribe action.</summary>
        public Action On(string type, Action<object> handler)
        {
            if (!handlers.TryGetValue(type ?? "", out var list))
            {
                Forward(seat, type); // refuses a bad name, as the seat does
                list = new List<Action<object>>();
                handlers[type] = list;
            }
            list.Add(handler);
            return () => list.Remove(handler);
        }

        /// <summary>Leave on purpose. Never reconnects; raises no <see cref="Disconnected"/>; a rejoin on its way takes no seat.</summary>
        public Task Leave()
        {
            left = true;
            rejoining = false;
            return seat.Leave();
        }
    }
}
