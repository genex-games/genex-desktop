// Unity-only glue: the browser identity provider for WebGL builds. It asks the page's
// @genex-ai/embed-sdk (exposed as window.genexEmbed, see README) for a FRESH embed token and the relay
// URLs, through Runtime/WebGL/GenexEmbed.jslib. NOT compiled by Tests~/GenexSmoke (needs Unity + a
// WebGL build), so it is unverified outside Unity.
#if UNITY_5_3_OR_NEWER
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace Genex.Multiplayer.Unity
{
    public static class GenexWebGL
    {
        /// <summary>What the page's embed SDK reported: a token to join with, and the relay URLs.</summary>
        public sealed class EmbedAuth
        {
            public string EmbedToken;
            public string[] RelayUrls = Array.Empty<string>();
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        private delegate void AuthCallback(int requestId, string json);

        [DllImport("__Internal")] private static extern void GenexEmbed_RequestAuth(int requestId, AuthCallback callback);

        private static int nextRequest;
        private static readonly Dictionary<int, TaskCompletionSource<EmbedAuth>> requests = new Dictionary<int, TaskCompletionSource<EmbedAuth>>();

        [AOT.MonoPInvokeCallback(typeof(AuthCallback))]
        private static void OnAuth(int requestId, string json)
        {
            if (!requests.TryGetValue(requestId, out var tcs)) return;
            requests.Remove(requestId);
            var o = GenexJson.ParseObject(json);
            var error = GenexJson.Str(o, "error");
            if (error != null) { tcs.TrySetException(new InvalidOperationException("genex embed: " + error)); return; }
            var urls = new List<string>();
            var list = GenexJson.List(o, "urls");
            if (list != null) foreach (var u in list) if (u is string s) urls.Add(s);
            tcs.TrySetResult(new EmbedAuth { EmbedToken = GenexJson.Str(o, "embedToken"), RelayUrls = urls.ToArray() });
        }
#endif

        /// <summary>True in a WebGL player build, where the page's embed SDK is the identity source.</summary>
        public static bool Available =>
#if UNITY_WEBGL && !UNITY_EDITOR
            true;
#else
            false;
#endif

        /// <summary>
        /// Wait for the page's identity to settle (waitForPlayer — guests included), then read a fresh token
        /// and the relay URLs. Never cache the result across joins: call it per join (GetEmbedToken does).
        /// </summary>
        public static Task<EmbedAuth> RequestAuth()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            var id = ++nextRequest;
            var tcs = new TaskCompletionSource<EmbedAuth>();
            requests[id] = tcs;
            GenexEmbed_RequestAuth(id, OnAuth);
            return tcs.Task;
#else
            return Task.FromException<EmbedAuth>(new PlatformNotSupportedException(
                "GenexWebGL works only in a WebGL player build; use GenexNativeIdentity elsewhere"));
#endif
        }

        /// <summary>An identity provider for <see cref="GenexConnectOptions.GetEmbedToken"/>.</summary>
        public static async Task<string> EmbedToken() => (await RequestAuth()).EmbedToken;
    }
}
#endif
