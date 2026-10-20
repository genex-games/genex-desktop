// Genex play-time AI for a Unity game (docs/play-protocol.md in Genex, "Play-time AI"): the game
// asks a model for text, or for JSON that fits a C# type, and Genex answers on the model the person
// chose.
//
//   var ticket = GenexAi.Ask<Verdict>("turn.resolve", prompt, new AiOptions { Fallback = Verdict.Draw });
//   void FixedUpdate() { foreach (var result in GenexAi.Drain()) Apply(result.As<Verdict>()); }
//
// A call answers its ticket at once. Its result enters the game only through Drain(), called once at
// the top of FixedUpdate: answers are data, so clamp them before they change the world. Never put
// player-typed text in a prompt: pass it in AiOptions.Untrusted. Genex relays the calls while the
// game plays in this editor (GenexAiRelay, pulled through the editor's Pipeline server); a build
// shipped outside Genex answers ai_off at once and plays its fallbacks.
using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Genex.AI
{
    /// <summary>The game's play-time AI.</summary>
    public static class GenexAi
    {
        const int Wire = 1;
        const int MaxInFlight = 4;
        const int MaxEcho = 64;
        const double RelayFreshSeconds = 3;
        const string NoGrant = "no-grant";
        const string OpReply = "ai.reply";
        const string OpDelta = "ai.delta";

        enum Kind { Call, Grant, Other }

        sealed class Pending
        {
            public Kind Kind;
            public string Ticket;
            public string Site;
            public JToken Fallback;
            public bool HasFallback;
        }

        static readonly object Gate = new object();
        static readonly Dictionary<string, Pending> Waiting = new Dictionary<string, Pending>();
        static readonly Dictionary<string, string> Partials = new Dictionary<string, string>();
        static readonly List<AiResult> Arrived = new List<AiResult>();
        static readonly List<string> Queued = new List<string>();
        static readonly List<string> Asked = new List<string>();
        static readonly List<string> Answered = new List<string>();
        static int rids;
        static int tickets;
        static bool on;
        static JObject grant;

        /// <summary>Whether the game requires AI ("ai") or works without it ("optional", the default).</summary>
        public static string Requires { get; set; } = AiRequirement.Optional;

        /// <summary>Fires on the main thread when the game's AI turns on or off, or its grant changes.</summary>
        public static event Action Changed;

        /// <summary>Whether Genex said AI runs for this game here.</summary>
        public static bool IsOn { get { lock (Gate) return on; } }

        /// <summary>The grant the game holds, as the game may see it ({id, status, door, …}), or null.</summary>
        public static JObject Grant { get { lock (Gate) return (JObject)grant?.DeepClone(); } }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ForgetPlay()
        {
            lock (Gate)
            {
                Waiting.Clear();
                Partials.Clear();
                Arrived.Clear();
                Queued.Clear();
                Asked.Clear();
                Answered.Clear();
                on = false;
                grant = null;
            }
        }

        // --- What a game calls ---

        /// <summary>JSON that fits T (see <see cref="GenexAiSchema"/>); answers the call's ticket.</summary>
        public static string Ask<T>(string site, string prompt, AiOptions options = null) =>
            Typed<T>("ask", site, prompt, options);

        /// <summary>JSON that fits a schema of Genex's closed dialect.</summary>
        public static string Ask(string site, string prompt, JObject schema, AiOptions options = null) =>
            Call("ask", site, prompt, schema, options);

        /// <summary>Free text, streamed: Partial(ticket) holds what has arrived so far.</summary>
        public static string Say(string site, string prompt, AiOptions options = null) =>
            Call("say", site, prompt, null, options);

        /// <summary>A classification of a state against fixed questions, as T.</summary>
        public static string Judge<T>(string site, string prompt, AiOptions options = null) =>
            Typed<T>("judge", site, prompt, options);

        /// <summary>One tool of a fixed set picked, as T.</summary>
        public static string Act<T>(string site, string prompt, AiOptions options = null) =>
            Typed<T>("act", site, prompt, options);

        /// <summary>Stop waiting for a call; its result still arrives once.</summary>
        public static void Cancel(string ticket) =>
            Send("cancel", new JObject { ["ticket"] = ticket }, new Pending { Kind = Kind.Other });

        /// <summary>The results that arrived since the last Drain, oldest first. Call it once per FixedUpdate.</summary>
        public static IReadOnlyList<AiResult> Drain()
        {
            lock (Gate)
            {
                if (Waiting.Count > 0 && !RelayFresh()) EndWaiting(AiCode.Off);
                var results = Arrived.ToArray();
                Arrived.Clear();
                return results;
            }
        }

        /// <summary>A streamed Say's text so far; empty before any arrives and once its result did.</summary>
        public static string Partial(string ticket)
        {
            lock (Gate) return Partials.TryGetValue(ticket, out var text) ? text : "";
        }

        /// <summary>
        /// Start AI for this game: Genex picks the model and asks the person only before their plan or
        /// their credits are used. Call it from a player's action; Changed fires with the answer.
        /// </summary>
        public static void StartAi(params string[] tiers)
        {
            var asked = new JArray();
            foreach (var tier in tiers ?? Array.Empty<string>())
                if (AiTier.Is(tier) && !asked.Contains(tier)) asked.Add(tier);
            if (asked.Count == 0) asked.Add(AiTier.Fast);
            var body = new JObject { ["v"] = Wire, ["requires"] = Requires, ["tiers"] = asked };
            Send("budget.request", body, new Pending { Kind = Kind.Grant });
        }

        /// <summary>The game turns its own AI off.</summary>
        public static void StopAi()
        {
            Send("budget.stop", JValue.CreateNull(), new Pending { Kind = Kind.Other });
            lock (Gate) grant = null;
            Changed?.Invoke();
        }

        // --- What the relay hands over (GenexAiRelay, on the editor's main thread) ---

        /// <summary>The lines queued since the last take, each as its JSON text.</summary>
        internal static string[] TakeLines()
        {
            lock (Gate)
            {
                var lines = Queued.ToArray();
                Queued.Clear();
                return lines;
            }
        }

        /// <summary>The rids this play sent and those answered, newest last.</summary>
        internal static object Echo()
        {
            lock (Gate) return new { asked = Asked.ToArray(), answered = Answered.ToArray() };
        }

        /// <summary>One of the studio's AI ops; true when it answered a line still waiting.</summary>
        internal static bool TakeStudioOp(string op, JObject args)
        {
            var notify = false;
            bool taken;
            lock (Gate)
            {
                var rid = args?.Value<string>("rid");
                if (rid == null || !Waiting.TryGetValue(rid, out var entry)) return false;
                taken = op == OpReply ? TakeReply(rid, entry, args["reply"] as JObject, ref notify) : TakeDelta(entry, args["text"]);
            }
            if (notify) Changed?.Invoke();
            return taken;
        }

        // --- Sending ---

        static string Typed<T>(string op, string site, string prompt, AiOptions options)
        {
            JObject schema;
            try
            {
                schema = GenexAiSchema.For(typeof(T));
            }
            catch (ArgumentException)
            {
                return Refused(site, options, AiCode.InvalidSchema);
            }
            return Call(op, site, prompt, schema, options);
        }

        static string Call(string op, string site, string prompt, JObject schema, AiOptions options)
        {
            var asked = options ?? new AiOptions();
            var entry = NewCall(site, asked);
            var body = new JObject
            {
                ["v"] = Wire,
                ["op"] = op,
                ["site"] = site,
                ["ticket"] = entry.Ticket,
                ["grantId"] = GrantId(),
                ["system"] = asked.System,
                ["prompt"] = prompt,
                ["untrusted"] = JObject.FromObject(asked.Untrusted ?? new Dictionary<string, string>()),
                ["memory"] = asked.Memory,
                ["schema"] = schema,
                ["tier"] = AiTier.Is(asked.Tier) ? asked.Tier : AiTier.Fast,
                ["authority"] = AiAuthority.Is(asked.Authority) ? asked.Authority : AiAuthority.Local,
                ["maxOutputTokens"] = Math.Max(1, asked.MaxOutputTokens),
                ["stream"] = op == "say",
            };
            Send("call", body, entry);
            return entry.Ticket;
        }

        static Pending NewCall(string site, AiOptions options)
        {
            lock (Gate)
            {
                tickets += 1;
                return new Pending
                {
                    Kind = Kind.Call,
                    Ticket = $"untk-{tickets:D8}",
                    Site = site,
                    HasFallback = options.Fallback != null,
                    Fallback = options.Fallback == null ? JValue.CreateNull() : JToken.FromObject(options.Fallback),
                };
            }
        }

        static string Refused(string site, AiOptions options, string code)
        {
            var entry = NewCall(site, options ?? new AiOptions());
            lock (Gate) Arrived.Add(Failure(entry, code));
            return entry.Ticket;
        }

        static string GrantId()
        {
            lock (Gate) return grant?.Value<string>("id") ?? NoGrant;
        }

        static void Send(string op, JToken body, Pending entry)
        {
            var notify = false;
            lock (Gate)
            {
                if (!RelayFresh()) Settle(entry, AiCode.Off, ref notify);
                else if (Waiting.Count >= MaxInFlight) Settle(entry, AiCode.Concurrency, ref notify);
                else
                {
                    rids += 1;
                    var rid = $"unai-{rids:D8}";
                    Waiting[rid] = entry;
                    Remember(Asked, rid);
                    var line = new JObject { ["event"] = "ai", ["rid"] = rid, ["op"] = op, ["body"] = body };
                    Queued.Add(line.ToString(Formatting.None));
                }
            }
            if (notify) Changed?.Invoke();
        }

        /// <summary>Whether Genex relays this play: in the editor, pulled within the last few seconds.</summary>
        static bool RelayFresh() =>
            Application.isEditor && GenexAiRelay.LastPull >= 0 &&
            Time.realtimeSinceStartupAsDouble - GenexAiRelay.LastPull <= RelayFreshSeconds;

        // --- Answers ---

        static bool TakeReply(string rid, Pending entry, JObject reply, ref bool notify)
        {
            Waiting.Remove(rid);
            Remember(Answered, rid);
            var answer = reply ?? new JObject();
            if (entry.Kind == Kind.Call)
            {
                Partials.Remove(entry.Ticket);
                Arrived.Add(ResultOf(entry, answer, ref notify));
            }
            else if (entry.Kind == Kind.Grant)
            {
                grant = answer["view"] as JObject;
                SetOn(grant != null, ref notify);
                notify = true;
            }
            return true;
        }

        static bool TakeDelta(Pending entry, JToken text)
        {
            if (entry.Kind != Kind.Call || text == null || text.Type != JTokenType.String) return false;
            Partials[entry.Ticket] = text.Value<string>();
            return true;
        }

        static AiResult ResultOf(Pending entry, JObject answer, ref bool notify)
        {
            if (answer.Value<bool?>("ok") == true)
            {
                SetOn(true, ref notify);
                return new AiResult
                {
                    Ticket = entry.Ticket,
                    Site = entry.Site,
                    Ok = true,
                    Value = answer["value"],
                    Source = answer.Value<string>("source") ?? "",
                    Provenance = answer.Value<string>("provenance") ?? "",
                };
            }
            var code = answer.Value<string>("code") ?? AiCode.Provider;
            if (code == AiCode.Off) SetOn(false, ref notify);
            return Failure(entry, code);
        }

        static AiResult Failure(Pending entry, string code) => new AiResult
        {
            Ticket = entry.Ticket,
            Site = entry.Site,
            Ok = false,
            Value = entry.Fallback,
            Code = code,
            UsedFallback = entry.HasFallback,
        };

        /// <summary>A line Genex never got: a call's result arrives in the next Drain, as any other.</summary>
        static void Settle(Pending entry, string code, ref bool notify)
        {
            if (entry.Kind == Kind.Call) Arrived.Add(Failure(entry, code));
            else if (code == AiCode.Off) SetOn(false, ref notify);
        }

        /// <summary>The relay stopped pulling: every line still waiting is answered `code`.</summary>
        static void EndWaiting(string code)
        {
            var notify = false;
            foreach (var pair in new List<KeyValuePair<string, Pending>>(Waiting))
            {
                Waiting.Remove(pair.Key);
                Settle(pair.Value, code, ref notify);
            }
            Partials.Clear();
        }

        static void SetOn(bool value, ref bool notify)
        {
            if (on == value) return;
            on = value;
            notify = true;
        }

        static void Remember(List<string> list, string rid)
        {
            list.Add(rid);
            if (list.Count > MaxEcho) list.RemoveAt(0);
        }
    }
}
