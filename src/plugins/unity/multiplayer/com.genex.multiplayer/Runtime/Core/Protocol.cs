// Genex relay protocol 3: the constants a C# client needs, ported from
// packages/multiplayer/src/protocol.ts. packages/multiplayer/PROTOCOL.md is normative; when this
// file and that document disagree, the document (and protocol.ts) win.
//
// Engine-agnostic: no UnityEngine here.
namespace Genex.Multiplayer
{
    /// <summary>Protocol constants (PROTOCOL.md §2, §3, §5, §8, §10, §11, §16).</summary>
    public static class GenexProtocol
    {
        /// <summary>Sent as the <c>protocol</c> join option on every join, create, joinById and queue join.</summary>
        public const int Version = 3;

        public static class RoomType
        {
            public const string Play = "play";
            public const string Queue = "queue";
            public const string Match = "match";
        }

        public static class JoinOption
        {
            public const string GameId = "gameId";
            public const string EmbedToken = "embedToken";
            public const string Name = "name";
            public const string Protocol = "protocol";
        }

        /// <summary>Matchmaking refusal codes (MatchMakeException.Code).</summary>
        public static class JoinError
        {
            public const int BadOption = 400;
            public const int AuthRequired = 401;
            public const int Forbidden = 403;
            /// <summary>Unsupported protocol: do not retry, tell the player the game needs an update.</summary>
            public const int ProtocolUnsupported = 426;
        }

        public static class ClientMessage
        {
            public const string State = "state";
            public const string StateSnap = "__state:snap";
            public const string Shared = "shared";
            public const string Claim = "claim";
            public const string Release = "release";
            public const string Destroy = "destroy";
            public const string Object = "obj";
            public const string ObjectSnap = "__object:snap";
            public const string Input = "__input";
            public const string RoomOpen = "__room:open";
            public const string Chat = "__chat";
            public const string ChatHistoryRequest = "__chat:history:request";
            public const string MatchEliminated = "match:eliminated";
            public const string MatchScore = "match:score";
            public const string MatchFinish = "match:finish";
            public const string Pose = "__pose";
            public const string PoseSnap = "__pose:snap";
        }

        public static class ServerMessage
        {
            public const string ObjectResult = "__object:result";
            public const string Input = "__input";
            public const string RoomOpen = "__room:open";
            public const string Chat = "__chat";
            public const string ChatHistory = "__chat:history";
            public const string VoiceIce = "__voice:ice";
            public const string VoiceSignal = "__voice:signal";
            public const string VoiceRejected = "__voice:rejected";
            public const string RateDrop = "rate:drop";
            public const string ServerRestart = "server:restart";
            public const string MatchStart = "match:start";
            public const string MatchEnded = "match:ended";
            public const string MatchRequeue = "match:requeue";
            public const string Queue = "queue";
            public const string Seat = "seat";
        }

        /// <summary>The key a sender stamps into its own player data: its send clock in ms (§6.1).</summary>
        public const string SendTimeKey = "__t";
        public const string ReservedSharedPrefix = "__";

        private static readonly string[] ReservedPrefixes = { "__", "match:", "server:", "rate:" };
        private static readonly string[] ReservedTypes = { "state", "shared", "claim", "release", "destroy", "obj", "queue", "seat" };

        /// <summary>Whether <paramref name="type"/> belongs to the relay rather than the game (§5.4).</summary>
        public static bool IsReservedEventType(string type)
        {
            foreach (var t in ReservedTypes) if (type == t) return true;
            foreach (var p in ReservedPrefixes) if (type.StartsWith(p, System.StringComparison.Ordinal)) return true;
            return false;
        }

        /// <summary>WebSocket close codes (§11).</summary>
        public static class CloseCode
        {
            public const int GoingAway = 1001;
            public const int NoStatus = 1005;
            public const int Abnormal = 1006;
            public const int MayTryReconnect = 4010;
            public const int Normal = 1000;
            public const int Consented = 4000;
            public const int ServerShutdown = 4001;
            public const int WithError = 4002;
            public const int FailedToReconnect = 4003;
            public const int Revoked = 4401;
            public const int Superseded = 4409;

            /// <summary>True for every code the SDK will not reconnect from.</summary>
            public static bool IsTerminal(int code) =>
                code != GoingAway && code != NoStatus && code != Abnormal && code != MayTryReconnect;
        }

        public static class Limits
        {
            public const int MaxNameChars = 64;
            public const int MaxStateBytes = 16 * 1024;
            public const int MaxSharedKeyChars = 256;
            public const int MaxSharedValueBytes = 64 * 1024;
            public const int MaxObjectIdChars = 128;
            public const int MaxObjectStateBytes = 64 * 1024;
            public const int MaxRequestIdChars = 96;
            public const int MaxEventBytes = 16 * 1024;
            public const int MaxEventTypeChars = 128;
            public const int MaxChatChars = 500;
            public const int MaxAnimChars = 64;
            public const double MaxPoseAbs = 1e9;
        }

        /// <summary>§8: the settings applied to the Colyseus SDK's <c>room.Reconnection</c>.</summary>
        public static class Reconnection
        {
            public const bool Enabled = true;
            public const int MinUptime = 0;
            public const int Delay = 125;
            public const int MinDelay = 100;
            public const int MaxDelay = 4000;
            public const int MaxRetries = 9;
            public const int MaxEnqueuedMessages = 0;
            public const double FirstStateTimeoutMs = 2000;
        }

        /// <summary>§10 defaults that reproduce the TypeScript SDK's feel.</summary>
        public static class Interpolation
        {
            public const double Ratio = 1.5;
            public const double JitterSafety = 1.25;
            public const double MinMs = 90;
            public const double MaxMs = 300;
            public const double DefaultMs = 100;
            public const double Ease = 0.1;
            public const int ClockWindow = 80;
            public const double ClockWindowMs = 5000;
            public const int ClockWindowMax = 4096;
            public const int IntervalWindow = 30;
            public const double MinGapMs = 5;
            public const double MaxGapMs = 2000;
            public const double HistoryMs = 1500;
            public const double MaxExtrapMs = 250;
            public const double RotExtrapMs = 150;
            public const double SmoothTauPosMs = 30;
            public const double SmoothTauRotMs = 70;
            public const double PoisonGuardMs = 2000;
            public const double RebaseAfterGapMs = 1000;
            public const double MaxHostTickDtMs = 250;
        }

        /// <summary>§16 heartbeat cadence.</summary>
        public static class ClockSync
        {
            public const double HeartbeatHz = 10;
            public const double MinHeartbeatHz = 5;
            public const double MaxHeartbeatHz = 20;
            public const double HeartbeatDither = 0.15;
            public const int WarmupAcks = 30;
        }

        /// <summary>Default control-request timeout (§7.2: never past 60 s).</summary>
        public const double DefaultControlTimeoutMs = 5000;

        /// <summary>The typed pose keys (§6.6), in schema order.</summary>
        public static readonly string[] PoseKeys = { "x", "y", "z", "yaw", "vx", "vy", "vz", "anim" };

        /// <summary>
        /// §17: server-authoritative rooms (protocol 4). A separate window: relay rooms refuse 4 and
        /// authority rooms refuse 3, so neither client lands in the other kind of room.
        /// </summary>
        public static class Authority
        {
            /// <summary>Sent as the <c>protocol</c> join option of an authority join.</summary>
            public const int ProtocolVersion = 4;
            public const int MinProtocolVersion = 4;
            /// <summary>The room an authority client joins (served by the authority cluster, never a relay).</summary>
            public const string RoomType = "authority";

            /// <summary>Authority join options beyond §3's (§17.10 *Joining*).</summary>
            public static class JoinOption
            {
                /// <summary>The capabilities this client implements: at most <see cref="Caps.MaxCaps"/> strings of at most <see cref="Caps.MaxCapChars"/> characters.</summary>
                public const string Caps = "caps";
                /// <summary>The SDK and version, <c>unity/0.8.0</c>: telemetry, never refused.</summary>
                public const string Sdk = "sdk";
                /// <summary>The pool this join asks for (§17.2 *Choosing a room*); absent = the game's one pool.</summary>
                public const string MatchKey = "matchKey";
                /// <summary><c>true</c> on a <c>create</c> makes a private room, reached only by its code.</summary>
                public const string Private = "private";
                /// <summary>The room this seat lost (§17.13 *Drain and rejoin*): its successor is found by it.</summary>
                public const string SuccessorOf = "successorOf";
                /// <summary><c>true</c>: the lost room was private, so its successor stays closed to the game's pool.</summary>
                public const string SuccessorClosed = "successorClosed";
            }

            /// <summary>What this package sends as <see cref="JoinOption.Sdk"/>.</summary>
            public const string SdkLabel = "unity/0.8.0";

            /// <summary>AuthorityCaps (§17.10): what a client declares in its <c>caps</c> join option.</summary>
            public static class Caps
            {
                /// <summary>Decodes and draws §17.10's physics bodies. A physics room refuses a join without it with 426.</summary>
                public const string Physics = "physics@1";
                /// <summary>Predicts a predicting room's bodies (§17.11 *Joining*); sent with <see cref="Physics"/>, never alone.</summary>
                public const string PhysicsPredict = "physics@2";
                /// <summary>Reconciles a predicting room's repeated inputs (§17.11 *Input pacing*, InputRepeat.cs): the room repeats a
                /// starved seat's held input and writes <c>inRep</c>, <c>inStarve</c> and <c>inBuf</c> for it.</summary>
                public const string InputRepeat = "repeat@1";
                /// <summary>Writes into each input the server tick its prediction steps it at (§17.11 *The input's tick*); sent with
                /// <see cref="Fast"/>, whose every slot carries it.</summary>
                public const string InputTick = "tick@1";
                /// <summary>Moves the seat's inputs and motion records onto the fast channel (§17.12, FastSeat.cs) when the room
                /// offers it; sent only with <see cref="InputTick"/>.</summary>
                public const string Fast = "fast@1";
                /// <summary>The seat can come back to the fast channel after a fallback (§17.12 <i>Return to the channel</i>).</summary>
                public const string FastReturn = "fast-return@1";
                public const int MaxCaps = 16;
                public const int MaxCapChars = 32;
            }

            /// <summary>§17.2 refusals only an authority room answers (the §3.4 ones apply too).</summary>
            public static class JoinError
            {
                /// <summary>A join by code entered through another region than the room's: try the next region.</summary>
                public const int WrongRegion = 421;
                /// <summary>The game's owner is not entitled to authority rooms. Terminal: never retried.</summary>
                public const int NotEntitled = 402;
                /// <summary>The owner's quota, concurrency cap or credits refused a NEW room. MAY retry later.</summary>
                public const int RoomQuota = 429;
                /// <summary>No published room module on this channel, or it could not be loaded. Terminal.</summary>
                public const int ModuleUnavailable = 424;
                /// <summary>No authority server can take the room, or admission could not be checked. Retried with backoff.</summary>
                public const int Capacity = 503;
            }

            /// <summary>§17.6 terminal close codes.</summary>
            public static class CloseCode
            {
                /// <summary>The operator or the platform halted the room (kill switch, takedown, disabled game).</summary>
                public const int ModuleHalted = 4500;
                /// <summary>The game's room module broke its limits or threw; the room is gone.</summary>
                public const int ModuleFault = 4501;
            }

            /// <summary>AuthorityTiming (§17.6): the server's defaults.</summary>
            public static class Timing
            {
                public const int TickHz = 30;
                /// <summary>How far behind the server clock other entities are drawn.</summary>
                public const double RenderDelayMs = 100;
                public const double MaxRewindMs = 500;
                public const int InputBuffer = 32;
                public const double PatchIntervalMs = 50;
            }

            /// <summary>Join options the authority server owns (§17.2); sending one is refused with 400, so the layer drops them.</summary>
            public static readonly string[] ServerOwnedJoinOptions =
            {
                "clients", "preset", "winCondition", "config", "matchmade",
                "moduleSha", "tickHz", "maxPlayers", "lagComp", "seed", "units", "leaseId",
            };

            /// <summary>Events the session raises itself; a module event of the same name is not delivered.</summary>
            public static class SessionEvent
            {
                public const string Reconnecting = "reconnecting";
                public const string Reconnected = "reconnected";
                public const string Disconnect = "disconnect";
                public const string Draining = "draining";
                public const string Rejoining = "rejoining";
                public const string Rejoined = "rejoined";

                /// <summary>Whether a name is the session's own, which a module event of that name never reaches.</summary>
                public static bool IsOne(string type) =>
                    type == Reconnecting || type == Reconnected || type == Disconnect || type == Draining || type == Rejoining || type == Rejoined;
            }

            /// <summary>The environment variable a launcher (Genex Studio) names a local authority server with.</summary>
            public const string UrlEnvironmentVariable = "GENEX_AUTHORITY_URL";
            /// <summary>
            /// The fixed credential a LOOPBACK authority server is joined with when the game supplied no token
            /// (embed-sdk's local test mode sends the same placeholder; a real server refuses it).
            /// </summary>
            public const string LocalToken = "local:test";
        }
    }
}
