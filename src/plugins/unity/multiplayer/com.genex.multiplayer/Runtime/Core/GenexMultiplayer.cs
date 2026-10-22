// Entry points: connect to a play room, create/join a private match lobby. Matchmaking (queue →
// seat → match room) is GenexMatchmaker. Engine-agnostic: no UnityEngine here.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Colyseus;
using Genex.Multiplayer.Wire;
using P = Genex.Multiplayer.GenexProtocol;

namespace Genex.Multiplayer
{
    public sealed class GenexConnectOptions
    {
        /// <summary>Regional relay URLs (the embed session's <c>colyseus.urls</c>). Several → lowest latency wins (§3.1).</summary>
        public string[] Urls;
        /// <summary>Explicit relay URL (an invite's region). Overrides <see cref="Urls"/> selection.</summary>
        public string Url;
        /// <summary>The game's slug. Must equal the embed token's <c>slug</c> claim.</summary>
        public string GameId;
        /// <summary>Display-name fallback; the verified token's name wins.</summary>
        public string Name;
        /// <summary>
        /// Identity provider: returns a FRESH <c>embed:play</c> token. Called immediately before every join,
        /// create, joinById and queue join, never cached across them (§3.2). Browser (WebGL): GenexWebGL.EmbedToken.
        /// Native: GenexNativeIdentity. Never log the token.
        /// </summary>
        public Func<Task<string>> GetEmbedToken;
        /// <summary>EXPERIMENTAL typed pose (§6.6), off by default. Opt in for every client of the game at once.</summary>
        public bool Pose;

        // Test seams: the smoke test's 426 path, and the conformance driver's extra join options. Not for games.
        internal int? ProtocolOverride { get; set; }
        internal Dictionary<string, object> ExtraJoinOptions { get; set; }
    }

    public static class GenexMultiplayer
    {
        /// <summary>Join (or create) the game's play room and wait for its first full state.</summary>
        public static async Task<GenexSession> Connect(GenexConnectOptions options)
        {
            var client = await SelectClient(options);
            var room = await Join(o => client.JoinOrCreate<RoomState>(P.RoomType.Play, o), options);
            return await Attach(room, options);
        }

        /// <summary>Create an unlisted private match lobby; its <see cref="GenexSession.RoomId"/> is the invite code (§9.2).</summary>
        public static async Task<GenexSession> CreatePrivate(GenexConnectOptions options)
        {
            var client = await SelectClient(options);
            var room = await Join(o => client.Create<RoomState>(P.RoomType.Match, o), options);
            return await Attach(room, options);
        }

        /// <summary>Join a private lobby by its invite code.</summary>
        public static async Task<GenexSession> JoinPrivate(GenexConnectOptions options, string inviteCode)
        {
            var client = await SelectClient(options);
            var room = await Join(o => client.JoinById<RoomState>(inviteCode, o), options);
            return await Attach(room, options);
        }

        internal static async Task<GenexSession> Attach(Room<RoomState> room, GenexConnectOptions options)
        {
            var session = new GenexSession(room, options.Pose);
            await session.FirstState;
            return session;
        }

        /// <summary>§3.1: an explicit URL wins; one URL is used as is; several are raced by latency.</summary>
        internal static async Task<Client> SelectClient(GenexConnectOptions options)
        {
            if (!string.IsNullOrEmpty(options.Url)) return new Client(options.Url);
            var urls = options.Urls ?? Array.Empty<string>();
            if (urls.Length == 0) throw new ArgumentException("GenexConnectOptions needs Url or Urls");
            if (urls.Length == 1) return new Client(urls[0]);
            return await Client.SelectByLatency(urls);
        }

        /// <summary>Build the join options with a token read NOW (§3.2) and map refusals to GenexJoinException.</summary>
        internal static async Task<Room<T>> Join<T>(Func<Dictionary<string, object>, Task<Room<T>>> joinCall, GenexConnectOptions options)
            where T : Colyseus.Schema.Schema
        {
            var joinOptions = await BuildJoinOptions(options);
            try { return await joinCall(joinOptions); }
            catch (MatchMakeException e) { throw new GenexJoinException(e.Code, e.Message, e); }
            catch (HttpException e) { throw new GenexJoinException(ErrorCode(e), ErrorMessage(e), e); }
        }

        internal static async Task<Dictionary<string, object>> BuildJoinOptions(GenexConnectOptions options)
        {
            if (string.IsNullOrEmpty(options.GameId)) throw new ArgumentException("GenexConnectOptions.GameId is required");
            var o = options.ExtraJoinOptions != null ? new Dictionary<string, object>(options.ExtraJoinOptions) : new Dictionary<string, object>();
            o[P.JoinOption.GameId] = options.GameId; // the protocol's own options win over extras
            o[P.JoinOption.Protocol] = options.ProtocolOverride ?? P.Version;
            if (!string.IsNullOrEmpty(options.Name))
                o[P.JoinOption.Name] = options.Name.Length > P.Limits.MaxNameChars ? options.Name.Substring(0, P.Limits.MaxNameChars) : options.Name;
            if (options.GetEmbedToken != null)
            {
                var token = await options.GetEmbedToken();
                if (!string.IsNullOrEmpty(token)) o[P.JoinOption.EmbedToken] = token;
            }
            return o;
        }

        private static int ErrorCode(HttpException e)
        {
            var body = GenexJson.ParseObject(e.Message);
            var code = GenexJson.Num(body, "code", double.NaN);
            return double.IsNaN(code) ? e.StatusCode : (int)code;
        }

        private static string ErrorMessage(HttpException e) => GenexJson.Str(GenexJson.ParseObject(e.Message), "error", e.Message);
    }
}
