// The words and shapes of Genex play-time AI as a Unity game sees them. The string values are the
// wire's own (docs/play-protocol.md in Genex): never rename one.
using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace Genex.AI
{
    /// <summary>How capable a model a call needs.</summary>
    public static class AiTier
    {
        public const string Fast = "fast";
        public const string Smart = "smart";

        internal static bool Is(string value) => value == Fast || value == Smart;
    }

    /// <summary>Who an answer is for: this player only, or every player (a leaderboard, shared state).</summary>
    public static class AiAuthority
    {
        public const string Local = "local";
        public const string Shared = "shared";

        internal static bool Is(string value) => value == Local || value == Shared;
    }

    /// <summary>Whether the game can run without AI.</summary>
    public static class AiRequirement
    {
        public const string Ai = "ai";
        public const string Optional = "optional";
    }

    /// <summary>Why a call has no answer: the codes a failed result carries.</summary>
    public static class AiCode
    {
        public const string Off = "ai_off";
        public const string Concurrency = "grant_concurrency";
        public const string BadRequest = "bad_request";
        public const string InvalidSchema = "invalid_schema";
        public const string Provider = "provider";
    }

    /// <summary>What a call may say besides its site, prompt and shape.</summary>
    public sealed class AiOptions
    {
        /// <summary>Static, cacheable text: the world, the rules, a persona.</summary>
        public string System;

        /// <summary>Player-typed text by name; every model sees it fenced as player text, never as instructions.</summary>
        public Dictionary<string, string> Untrusted;

        /// <summary>What the game remembers for this call, as text.</summary>
        public string Memory;

        public string Tier = AiTier.Fast;
        public string Authority = AiAuthority.Local;
        public int MaxOutputTokens = 512;

        /// <summary>What a failed result carries as its value, so the game plays on; null for none.</summary>
        public object Fallback;
    }

    /// <summary>One call's result, as Drain() hands it to the game.</summary>
    public sealed class AiResult
    {
        public string Ticket;
        public string Site;
        public bool Ok;

        /// <summary>The answer; on a failure, the call's fallback (or null).</summary>
        public JToken Value;

        /// <summary>Empty on an answer; else why there is none (<see cref="AiCode"/> and the host's own codes).</summary>
        public string Code = "";

        public string Source = "";
        public string Provenance = "";

        /// <summary>The value is the call's fallback.</summary>
        public bool UsedFallback;

        /// <summary>The value as a C# value of type T; default when there is none.</summary>
        public T As<T>() => Value == null || Value.Type == JTokenType.Null ? default : Value.ToObject<T>();
    }

    /// <summary>The most items a list or array field may hold in an answer.</summary>
    [AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
    public sealed class GenexMaxItemsAttribute : Attribute
    {
        public readonly int Max;

        public GenexMaxItemsAttribute(int max) => Max = max;
    }

    /// <summary>The longest a string field may be in an answer.</summary>
    [AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
    public sealed class GenexMaxLengthAttribute : Attribute
    {
        public readonly int Max;

        public GenexMaxLengthAttribute(int max) => Max = max;
    }
}
