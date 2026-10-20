// Genex's side of the relay: Genex Studio calls these two methods through the editor's own Pipeline
// server while the game plays in Play mode (Studio's `ai-relay.ts`), so no port or token is added.
// Pull hands Studio the lines the game queued; Push hands the game Studio's answers, as base64 of
// their JSON so nothing in them is ever code. A game calls neither.
using System;
using System.Text;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Genex.AI
{
    /// <summary>Studio's relay of a playing game's AI lines.</summary>
    public static class GenexAiRelay
    {
        /// <summary>When Studio last pulled, on the realtime clock; negative before the first pull of a play.</summary>
        internal static double LastPull = -1;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ForgetPlay() => LastPull = -1;

        /// <summary>{playing, lines, echo}: whether a game plays, and each line it queued since, as its JSON text.</summary>
        public static object Pull()
        {
            if (!Application.isPlaying)
            {
                LastPull = -1;
                return new { playing = false, lines = Array.Empty<string>() };
            }
            LastPull = Time.realtimeSinceStartupAsDouble;
            return new { playing = true, lines = GenexAi.TakeLines(), echo = GenexAi.Echo() };
        }

        /// <summary>Hands the playing game Studio's answers ([{op, args}] as base64 of JSON); false when none was taken in.</summary>
        public static bool Push(string base64)
        {
            if (!Application.isPlaying) return false;
            JArray items;
            try
            {
                items = JArray.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(base64)));
            }
            catch (Exception)
            {
                return false;
            }
            foreach (var item in items)
            {
                if (item is JObject entry && entry["args"] is JObject args)
                    GenexAi.TakeStudioOp(entry.Value<string>("op") ?? "", args);
            }
            return true;
        }
    }
}
