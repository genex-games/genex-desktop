// Native play identity (CLI_INTEGRATION.md §6b): how a Unity build that is NOT running in a browser
// gets the same `embed:play` token the browser embed SDK holds. Three doors, one refresh:
//   1. launched by Genex:   GENEX_EMBED_TICKET  → POST /api/embed/session { ticket }
//   2. guest:                                     POST /api/embed/guest-session { slug }
//   3. device-code sign-in:  POST /api/embed/device { slug } → player approves → POST /api/embed/device/token
//   refresh (every door):    POST /api/embed/session/refresh  (Authorization: Bearer <embedToken>)
// No Origin header is sent: every credential travels in the body or as a bearer.
//
// HTTP goes through ColyseusContext.HttpClient (UnityWebRequest inside Unity, HttpClient elsewhere).
// WebGL builds use the page's embed SDK instead (GenexWebGL). Never log a token or a ticket.
// Engine-agnostic: no UnityEngine here.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading.Tasks;
using Colyseus;

namespace Genex.Multiplayer
{
    public sealed class GenexNativeIdentity
    {
        public sealed class DeviceCode
        {
            public string Code;            // the secret; never show it
            public string UserCode;        // show this
            public string VerificationUri;
            public string VerificationUriComplete;
            public double IntervalSeconds = 3;
            public double ExpiresInSeconds = 600;
        }

        /// <summary>
        /// Genex's API as the launcher names it (§6b): its local gateway when Genex's Play started this game in
        /// its sandbox. When set it replaces the API base the game passed in.
        /// </summary>
        public const string ApiEnv = "GENEX_API_URL";

        /// <summary>Refresh this long before the token's expiry (tokens live ~15 min and rotate ~every 10).</summary>
        private const double RefreshLeadMs = 5 * 60 * 1000;

        private readonly string apiBase;
        private readonly string slug;
        private string token;
        private double expiresAtMs = double.NaN;
        private double mintedAtMs;

        /// <summary>The last session payload (user, project, colyseus.{url, urls}) without the token.</summary>
        public Dictionary<string, object> Session { get; private set; }
        public bool HasToken => !string.IsNullOrEmpty(token);
        /// <summary>The relay URLs the API returned with the token (pass them as GenexConnectOptions.Urls).</summary>
        public string[] RelayUrls { get; private set; } = Array.Empty<string>();

        /// <summary>The API base every call goes to: GENEX_API_URL when the launcher set it, else the one passed in.</summary>
        public string ApiBase => apiBase;

        public GenexNativeIdentity(string apiBaseUrl, string gameSlug)
        {
            apiBase = ResolveApiBase(apiBaseUrl, LauncherApiUrl()).TrimEnd('/');
            slug = gameSlug;
        }

        /// <summary>The launcher's API base when set and non-empty, else the game's. The env var always wins.</summary>
        public static string ResolveApiBase(string gameApiBase, string launcherApiUrl) =>
            string.IsNullOrWhiteSpace(launcherApiUrl) ? gameApiBase : launcherApiUrl.Trim();

        private static string LauncherApiUrl()
        {
            try { return Environment.GetEnvironmentVariable(ApiEnv); }
            catch (Exception) { return null; }
        }

        /// <summary>
        /// Read GENEX_EMBED_TICKET once and remove it from this process's environment (it is single-use and
        /// lives 60 s: call this first thing at startup). Null when the game was not launched by Genex.
        /// </summary>
        public static string TakeLaunchTicket()
        {
            try
            {
                var t = Environment.GetEnvironmentVariable("GENEX_EMBED_TICKET");
                if (string.IsNullOrEmpty(t)) return null;
                Environment.SetEnvironmentVariable("GENEX_EMBED_TICKET", null);
                return t;
            }
            catch (Exception) { return null; }
        }

        /// <summary>Door 1: redeem a launcher ticket. A 401 means expired or used: fall back to a guest or device sign-in.</summary>
        public Task RedeemTicket(string ticket) =>
            Mint("/api/embed/session", new Dictionary<string, object> { ["ticket"] = ticket }, null);

        /// <summary>Door 2: a guest token for a PUBLISHED game (404 for drafts). Guests refresh for at most 12 h.</summary>
        public Task SignInAsGuest() =>
            Mint("/api/embed/guest-session", new Dictionary<string, object> { ["slug"] = slug }, null);

        /// <summary>Door 3, step 1: start a device-code sign-in. Show UserCode and VerificationUri to the player.</summary>
        public async Task<DeviceCode> StartDeviceSignIn()
        {
            var r = await Post("/api/embed/device", new Dictionary<string, object> { ["slug"] = slug }, null);
            return new DeviceCode
            {
                Code = GenexJson.Str(r, "deviceCode"),
                UserCode = GenexJson.Str(r, "userCode"),
                VerificationUri = GenexJson.Str(r, "verificationUri"),
                VerificationUriComplete = GenexJson.Str(r, "verificationUriComplete"),
                IntervalSeconds = GenexJson.Num(r, "interval", 3),
                ExpiresInSeconds = GenexJson.Num(r, "expiresIn", 600),
            };
        }

        /// <summary>
        /// Door 3, step 2: poll once. Returns "approved" (token held), "pending", "denied" (offer a guest) or
        /// "expired" (start again). Poll every <see cref="DeviceCode.IntervalSeconds"/>.
        /// </summary>
        public async Task<string> PollDeviceSignIn(DeviceCode code)
        {
            Dictionary<string, object> r;
            try { r = await Post("/api/embed/device/token", new Dictionary<string, object> { ["deviceCode"] = code.Code }, null); }
            catch (HttpException e) when (e.StatusCode == 410) { return "expired"; }
            var status = GenexJson.Str(r, "status", "pending");
            if (status == "pending") code.IntervalSeconds = GenexJson.Num(r, "interval", code.IntervalSeconds);
            if (status == "approved") Accept(r);
            return status;
        }

        /// <summary>Roll the token (every door). Throws HttpException 401 when the identity is over: start again.</summary>
        public Task Refresh()
        {
            if (!HasToken) throw new InvalidOperationException("no token to refresh");
            return Mint("/api/embed/session/refresh", new Dictionary<string, object>(), token);
        }

        /// <summary>
        /// The identity provider for GenexConnectOptions.GetEmbedToken: refreshes when the token is near its
        /// expiry, then returns it. Called right before every join (§3.2).
        /// </summary>
        public Func<Task<string>> TokenProvider => async () =>
        {
            if (!HasToken) throw new InvalidOperationException("sign in first (ticket, guest or device code)");
            var now = NowMs();
            var stale = double.IsNaN(expiresAtMs) ? now - mintedAtMs > 10 * 60 * 1000 : expiresAtMs - now < RefreshLeadMs;
            if (stale) await Refresh();
            return token;
        };

        private async Task Mint(string path, Dictionary<string, object> body, string bearer) => Accept(await Post(path, body, bearer));

        private void Accept(Dictionary<string, object> r)
        {
            var t = GenexJson.Str(r, "embedToken");
            if (string.IsNullOrEmpty(t)) throw new InvalidOperationException("identity response carried no embedToken");
            token = t;
            mintedAtMs = NowMs();
            expiresAtMs = ParseExpiry(r.TryGetValue("expiresAt", out var e) ? e : null);
            var copy = new Dictionary<string, object>(r);
            copy.Remove("embedToken");
            if (copy.ContainsKey("user") || copy.ContainsKey("project") || Session == null) Session = copy;
            var coly = GenexJson.Map(r, "colyseus");
            var urls = GenexJson.List(coly, "urls");
            if (urls != null && urls.Count > 0)
            {
                var list = new List<string>();
                foreach (var u in urls) if (u is string s) list.Add(s);
                RelayUrls = list.ToArray();
            }
            else if (GenexJson.Str(coly, "url") is string one) RelayUrls = new[] { one };
        }

        private static double ParseExpiry(object v)
        {
            switch (v)
            {
                case double d: return d < 1e12 ? d * 1000 : d; // seconds or ms
                case string s when DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var dto):
                    return dto.ToUnixTimeMilliseconds();
                default: return double.NaN;
            }
        }

        private async Task<Dictionary<string, object>> Post(string path, Dictionary<string, object> body, string bearer)
        {
            var headers = new Dictionary<string, string> { ["Accept"] = "application/json" };
            if (bearer != null) headers["Authorization"] = "Bearer " + bearer;
            var bytes = Encoding.UTF8.GetBytes(GenexJson.Serialize(body));
            var text = await ColyseusContext.HttpClient.Request("POST", apiBase + path, bytes, headers);
            return GenexJson.ParseObject(text) ?? new Dictionary<string, object>();
        }

        private static double NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
