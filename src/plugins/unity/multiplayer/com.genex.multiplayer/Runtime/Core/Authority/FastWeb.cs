// The fast channel on a Unity WebGL player (PROTOCOL.md §17.12 *WebTransport*): the binding's `wt` rule, a network
// boundary held to the shared vectors, and the polled socket over Runtime/WebGL/GenexFastWeb.jslib. A browser has no raw
// UDP, so this is the opener a WebGL seat uses; a browser with no WebTransport never claims fast@1. No UnityEngine.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace Genex.Multiplayer.Authority
{
    /// <summary>Where a browser reaches a seat's channel: the relay's session and the hashes of the certificates it may
    /// serve. From the binding's <c>wt</c>, which is server-supplied: anything but an https url with a host and no
    /// credentials, query or fragment, and 1..4 hashes of 64 lowercase hex digits, is refused.</summary>
    public sealed class GenexFastWebTarget
    {
        private const int HashHexDigits = 64;
        private const int HashesMax = 4;
        private static readonly Regex HashPattern = new Regex("^[0-9a-f]+$", RegexOptions.CultureInvariant);

        public string Url;
        public List<string> Hashes;

        /// <summary>The target a <c>wt</c> value holds, else null.</summary>
        public static GenexFastWebTarget Of(object wt)
        {
            if (!(wt is Dictionary<string, object> m)) return null;
            var url = m.TryGetValue("url", out var u) ? u as string : null;
            if (url == null || !m.TryGetValue("hashes", out var h) || !(h is IEnumerable<object> list)) return null;
            var hashes = list.ToList();
            if (hashes.Count == 0 || hashes.Count > HashesMax) return null;
            if (!hashes.All(x => x is string s && s.Length == HashHexDigits && HashPattern.IsMatch(s))) return null;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme != Uri.UriSchemeHttps) return null;
            var bare = parsed.UserInfo.Length == 0 && parsed.Query.Length == 0 && parsed.Fragment.Length == 0 && parsed.Host.Length > 0;
            return bare ? new GenexFastWebTarget { Url = url, Hashes = hashes.Cast<string>().ToList() } : null;
        }
    }

    /// <summary>A seat's fast socket on the browser's WebTransport, read by polling on the caller's thread.</summary>
    internal sealed class GenexFastWebSocket : IGenexFastSocket, IGenexFastSocketState
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern int GenexFastWeb_Available();
        [DllImport("__Internal")] private static extern int GenexFastWeb_Open(string url, string hashes);
        [DllImport("__Internal")] private static extern void GenexFastWeb_Send(int id, byte[] bytes, int length);
        [DllImport("__Internal")] private static extern int GenexFastWeb_Receive(int id, byte[] bytes, int capacity);
        [DllImport("__Internal")] private static extern int GenexFastWeb_Failed(int id);
        [DllImport("__Internal")] private static extern int GenexFastWeb_MaxDatagram(int id);
        [DllImport("__Internal")] private static extern void GenexFastWeb_Close(int id);
#else
        private static int GenexFastWeb_Available() => 0;
        private static int GenexFastWeb_Open(string url, string hashes) => 0;
        private static void GenexFastWeb_Send(int id, byte[] bytes, int length) { }
        private static int GenexFastWeb_Receive(int id, byte[] bytes, int capacity) => -1;
        private static int GenexFastWeb_Failed(int id) => 0;
        private static int GenexFastWeb_MaxDatagram(int id) => 0;
        private static void GenexFastWeb_Close(int id) { }
#endif
        private readonly byte[] buffer = new byte[GenexFast.MaxDatagramBytes];
        private int id;

        private GenexFastWebSocket(int id)
        {
            this.id = id;
        }

        /// <summary>Whether this player can open one: a browser with WebTransport.</summary>
        public static bool Available => GenexFastWeb_Available() != 0;

        /// <summary>A socket for the opening target <see cref="GenexFastBind.OpenTarget"/> names, else null (no usable
        /// <c>wt</c>, or a browser that refuses).</summary>
        public static IGenexFastSocket Open(string target)
        {
            var parts = target?.Split(GenexFastBind.TargetSeparator);
            if (parts == null || parts.Length != 2) return null;
            var session = GenexFastWeb_Open(parts[0], parts[1]);
            return session == 0 ? null : new GenexFastWebSocket(session);
        }

        public void Send(byte[] bytes)
        {
            if (id != 0) GenexFastWeb_Send(id, bytes, bytes.Length);
        }

        public byte[] Receive()
        {
            if (id == 0) return null;
            var n = GenexFastWeb_Receive(id, buffer, buffer.Length);
            if (n < 0) return null;
            var bytes = new byte[n];
            Array.Copy(buffer, bytes, n);
            return bytes;
        }

        public bool Failed => id != 0 && GenexFastWeb_Failed(id) != 0;

        public int MaxDatagramBytes => id == 0 ? 0 : GenexFastWeb_MaxDatagram(id);

        public void Close()
        {
            if (id == 0) return;
            GenexFastWeb_Close(id);
            id = 0;
        }
    }
}
