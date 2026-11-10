// The one line a seat says about its transport (PROTOCOL.md §17.12 *The transport line*), so nobody is on the WebSocket
// without knowing: once a socket's transport is known, and again if it falls back. The words are the same in every port,
// held to `transportLine` in the shared vectors. A port of the TypeScript `fast-line.ts`.
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>Which transport a seat's motion and inputs are on (<see cref="GenexFastStatus.Transport"/>).</summary>
    public static class GenexFastTransportName
    {
        public const string Udp = "udp";
        public const string WebSocket = "websocket";
    }

    /// <summary>Says each transport line once per socket.</summary>
    internal sealed class GenexFastLineAnnouncer
    {
        /// <summary>How long after a socket's first state a seat waits for its binding before it says the room offered none.</summary>
        public const double OfferWaitMs = 1000;

        private readonly HashSet<string> said = new HashSet<string>();

        public static string UdpLine(string url) => "genex transport: udp fast@1 " + url;

        public static string WebSocketLine(string reason) => "genex transport: websocket, " + reason + ": " + Why(reason);

        private static string Why(string reason)
        {
            switch (reason)
            {
                case "off": return "the game turned the fast channel off";
                case "no_udp": return "this platform has no UDP";
                case "not_offered": return "the room does not offer the fast channel";
                case "unreachable": return "fell back, the binding could not be used or its socket failed";
                case "handshake": return "fell back, no UDP snapshot within 1 s of the first datagram (UDP blocked?)";
                case "stall": return "fell back, no UDP snapshot for 2 s";
                case "server": return "fell back, the room closed the channel";
                default: return "unknown";
            }
        }

        private string Once(string line) => said.Add(line) ? line : null;

        /// <summary>The line this instant owes, or null.</summary>
        /// <param name="asked">The game left the channel on.</param>
        /// <param name="udp">This runtime has a UDP socket to open.</param>
        /// <param name="joinedMs">Milliseconds since this socket's first state; null before it.</param>
        /// <param name="url">The binding's url; null before one came.</param>
        /// <param name="snapshots">Snapshots applied on this socket.</param>
        /// <param name="fallback">Why this socket fell back; null if it has not.</param>
        public string Observe(bool asked, bool udp, double? joinedMs, string url, int snapshots, string fallback)
        {
            if (joinedMs == null) return null;
            if (!asked) return Once(WebSocketLine("off"));
            if (!udp) return Once(WebSocketLine("no_udp"));
            if (fallback != null) return Once(WebSocketLine(fallback));
            if (url != null) return snapshots > 0 ? Once(UdpLine(url)) : null;
            return joinedMs >= OfferWaitMs ? Once(WebSocketLine("not_offered")) : null;
        }

        /// <summary>A new socket: everything may be said again.</summary>
        public void Reset() => said.Clear();
    }
}
