// The fast channel over raw UDP (PROTOCOL.md §17.12 *Client*): the `__fast` url rule and a polled UdpClient. The
// url is server-supplied, so the parser is a network boundary: only `udp://host:port` (an IPv6 host in brackets, a
// port in 1..65535, no credentials, path, query or fragment) is taken, as the TypeScript `udpEndpoint`
// (packages/multiplayer/src/authority/fast-udp.ts) takes it. The socket is connected to that endpoint, so the
// kernel delivers only its datagrams: an off-path sender cannot inject a snapshot from another address. WebGL has no
// sockets: there the seat goes by WebTransport (FastWeb.cs). No UnityEngine.
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A <c>udp://</c> url's host (an IPv6 host unbracketed) and port.</summary>
    public sealed class GenexUdpEndpoint
    {
        public string Host;
        public int Port;
    }

    /// <summary>The <c>__fast</c> url rule for raw UDP.</summary>
    public static class GenexFastUdp
    {
        /// <summary>A measuring tool's view of the socket, the counterpart of the Rust SDK's <c>set_wire_tap</c>: per datagram, on
        /// the pumping thread, true for a send the socket took, else a receive. Off unless a tool sets it. The bytes hold the
        /// seat's binding key: a tap must not keep or print them whole.</summary>
        public static Action<bool, byte[]> WireTap;

        private const string Scheme = "udp://";
        private const int PortMax = 65535;
        /// <summary>Characters a host may not hold (WHATWG's forbidden host code points, and <c>%</c>: a percent-encoded
        /// host names nothing a UDP socket can reach).</summary>
        private const string ForbiddenHost = " #%/:<>?@[\\]^|\t\n\r";

        /// <summary>The host and port of a <c>udp://host:port</c> url, else null: anything more than a host and a port in
        /// 1..65535 is refused (credentials, a path past a bare <c>/</c>, a query or a fragment; an empty <c>?</c> or
        /// <c>#</c> carries nothing, as in the TypeScript).</summary>
        public static GenexUdpEndpoint Endpoint(string url)
        {
            if (url == null || url.Length <= Scheme.Length || !url.StartsWith(Scheme, StringComparison.OrdinalIgnoreCase)) return null;
            var rest = url.Substring(Scheme.Length);
            var end = rest.IndexOfAny(new[] { '/', '?', '#' });
            var authority = end < 0 ? rest : rest.Substring(0, end);
            var tail = end < 0 ? "" : rest.Substring(end);
            if (!BareTail(tail)) return null;
            var at = authority.LastIndexOf('@');
            if (at >= 0)
            {
                var userinfo = authority.Substring(0, at);
                if (userinfo != "" && userinfo != ":") return null;
                authority = authority.Substring(at + 1);
            }
            return HostAndPort(authority);
        }

        /// <summary>What may follow the authority: nothing, a bare <c>/</c>, then an empty query, then an empty fragment.</summary>
        private static bool BareTail(string tail)
        {
            var i = 0;
            if (i < tail.Length && tail[i] == '/') i++;
            if (i < tail.Length && tail[i] == '?') i++;
            if (i < tail.Length && tail[i] == '#') i++;
            return i == tail.Length;
        }

        private static GenexUdpEndpoint HostAndPort(string authority)
        {
            string host;
            string portText;
            if (authority.StartsWith("[", StringComparison.Ordinal))
            {
                var close = authority.IndexOf(']');
                if (close < 0 || close + 1 >= authority.Length || authority[close + 1] != ':') return null;
                var inner = authority.Substring(1, close - 1);
                if (!IPAddress.TryParse(inner, out var v6) || v6.AddressFamily != AddressFamily.InterNetworkV6 || inner.IndexOf('%') >= 0) return null;
                host = v6.ToString();
                portText = authority.Substring(close + 2);
            }
            else
            {
                var colon = authority.IndexOf(':');
                if (colon < 0) return null;
                host = authority.Substring(0, colon);
                portText = authority.Substring(colon + 1);
                if (host.Length == 0) return null;
                foreach (var c in host)
                    if (c < 0x21 || c > 0x7e || ForbiddenHost.IndexOf(c) >= 0) return null;
            }
            var port = PortOf(portText);
            return port < 1 ? null : new GenexUdpEndpoint { Host = host, Port = port };
        }

        /// <summary>A port of decimal digits only (leading zeros allowed) in 1..65535, else 0.</summary>
        private static int PortOf(string text)
        {
            if (text.Length == 0) return 0;
            long port = 0;
            foreach (var c in text)
            {
                if (c < '0' || c > '9') return 0;
                port = port * 10 + (c - '0');
                if (port > PortMax) return 0;
            }
            return (int)port;
        }

        /// <summary>A <see cref="GenexFastSocketOpener"/> for <c>udp://</c> urls; null for any other url (and on WebGL).</summary>
        public static IGenexFastSocket Open(string url) => GenexUdpFastSocket.Open(url);
    }

    /// <summary>A UdpClient connected to one fast endpoint, read by polling on the caller's thread.</summary>
    public sealed class GenexUdpFastSocket : IGenexFastSocket
    {
        /// <summary>Datagrams kept while a host name resolves: the newest, each a whole window of inputs.</summary>
        private const int ConnectQueueMax = 32;

        private readonly GenexUdpEndpoint to;
        private Task<IPAddress[]> lookup;
        private UdpClient udp;
        private bool closed;
        private readonly List<byte[]> waiting = new List<byte[]>();

        private GenexUdpFastSocket(GenexUdpEndpoint to)
        {
            this.to = to;
        }

        /// <summary>A socket to the endpoint <paramref name="url"/> names, else null (a url the rule refuses, WebGL, or a
        /// socket the platform will not open).</summary>
        public static GenexUdpFastSocket Open(string url)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return null;
#else
            var to = GenexFastUdp.Endpoint(url);
            if (to == null) return null;
            var socket = new GenexUdpFastSocket(to);
            if (IPAddress.TryParse(to.Host, out var literal))
            {
                if (!socket.Connect(literal)) return null;
            }
            else
            {
                try
                {
                    socket.lookup = Dns.GetHostAddressesAsync(to.Host);
                }
                catch (Exception)
                {
                    return null;
                }
            }
            return socket;
#endif
        }

        /// <summary>The local port the socket sends from (0 before it is connected).</summary>
        public int LocalPort => udp?.Client?.LocalEndPoint is IPEndPoint ep ? ep.Port : 0;

        private bool Connect(IPAddress address)
        {
            try
            {
                udp = new UdpClient(address.AddressFamily);
                udp.Connect(new IPEndPoint(address, to.Port));
                return true;
            }
            catch (Exception)
            {
                udp?.Dispose();
                udp = null;
                return false;
            }
        }

        /// <summary>Connects once the name lookup is done, and sends what waited for it. False while it is pending or failed.</summary>
        private bool Ready()
        {
            if (udp != null) return true;
            if (lookup == null || !lookup.IsCompleted) return false;
            var task = lookup;
            lookup = null;
            if (task.Status != TaskStatus.RanToCompletion || task.Result == null || task.Result.Length == 0) return false;
            var address = Array.Find(task.Result, a => a.AddressFamily == AddressFamily.InterNetwork) ?? task.Result[0];
            if (!Connect(address)) return false;
            foreach (var bytes in waiting) SendNow(bytes);
            waiting.Clear();
            return true;
        }

        private void SendNow(byte[] bytes)
        {
            try
            {
                udp.Send(bytes, bytes.Length);
                GenexFastUdp.WireTap?.Invoke(true, bytes);
            }
            catch (Exception)
            {
                // An unreachable endpoint answers ICMP errors as socket errors: never fatal, the client's deadline falls
                // back to the WebSocket.
            }
        }

        public void Send(byte[] bytes)
        {
            if (closed) return;
            if (Ready())
            {
                SendNow(bytes);
                return;
            }
            if (lookup == null) return;
            waiting.Add(bytes);
            if (waiting.Count > ConnectQueueMax) waiting.RemoveAt(0);
        }

        public byte[] Receive()
        {
            if (closed || !Ready()) return null;
            try
            {
                if (udp.Available <= 0) return null;
                var from = new IPEndPoint(IPAddress.Any, 0);
                var received = udp.Receive(ref from);
                GenexFastUdp.WireTap?.Invoke(false, received);
                return received;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public void Close()
        {
            if (closed) return;
            closed = true;
            waiting.Clear();
            udp?.Dispose();
            udp = null;
        }
    }
}
