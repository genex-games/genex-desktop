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
    }
}
