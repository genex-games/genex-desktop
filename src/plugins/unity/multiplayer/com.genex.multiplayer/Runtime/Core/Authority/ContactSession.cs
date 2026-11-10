// A room's declared contact policy as a client runs it (PROTOCOL.md §17.11 *Contact policy*), a port of
// packages/multiplayer/src/authority/contact-session.ts: the resolved policy the host publishes as the `contacts` of the
// state's `preset` text, turned into the seat contact rule and the pass the session's prediction, replay and drawing guard
// run, through this client's world. The policy's parse is held to contact-policy.json's config rows (GenexSmoke
// `contact-policy`); the session's use of it by the `declaredContacts` conformance check. Engine-agnostic: no UnityEngine.
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A declared policy as the session runs it: the pair rule, the whole pass, and the pair rule a drawing runs
    /// against your entity.</summary>
    public sealed class GenexDeclaredContacts
    {
        public GenexContactPolicy Policy { get; }
        /// <summary>The policy's pair rule over two seats (contact-policy.ts <c>contactRuleOf</c>).</summary>
        public GenexContactRule Rule { get; }
        /// <summary>The policy's pass over every seat, ids ascending (<c>contactPassOf</c>).</summary>
        public GenexSeatPass Pass { get; }

        private readonly GenexContactWorld world;
        private readonly Dictionary<string, GenexContactRule> drawRules = new Dictionary<string, GenexContactRule>();

        private GenexDeclaredContacts(GenexContactPolicy policy, GenexFirstpersonWorld staticWorld)
        {
            Policy = policy;
            var boxes = new List<double[]>();
            var ramps = new List<double[]>();
            for (var i = 0; i < staticWorld.BoxCount; i++) boxes.Add(staticWorld.Box(i));
            for (var i = 0; i < staticWorld.RampCount; i++) ramps.Add(staticWorld.Ramp(i));
            world = GenexContactWorld.Compile(boxes, ramps, policy.HullRadius, policy.HullHeight, policy.HullSkin);
            var env = new GenexContactEnv { World = world };
            Rule = GenexContactPolicyRules.ContactRuleOf(policy, env);
            Pass = GenexContactPolicyRules.ContactPassOf(policy, env);
        }

        /// <summary>The pair rule a drawing runs against your entity <paramref name="you"/> (its id): yours fixed, the other seat
        /// taking the whole push its way allows (§17.11 *Drawing other seats*).</summary>
        public GenexContactRule DrawRule(string you)
        {
            if (drawRules.TryGetValue(you, out var known)) return known;
            var made = GenexContactPolicyRules.ContactRuleOf(Policy, new GenexContactEnv { World = world, Fixed = you });
            drawRules[you] = made;
            return made;
        }

        /// <summary>The policy the room's preset text declares (<c>{ name, params, contacts }</c>), run through
        /// <paramref name="staticWorld"/> (the static world this client steps the preset through); null when the text declares
        /// none, or not a resolved policy.</summary>
        public static GenexDeclaredContacts Of(string presetText, GenexFirstpersonWorld staticWorld)
        {
            if (string.IsNullOrEmpty(presetText) || staticWorld == null) return null;
            if (!GenexJson.TryParse(presetText, out var spec) || !(spec is IDictionary<string, object> o)) return null;
            if (!o.TryGetValue("contacts", out var contacts)) return null;
            var policy = GenexContactConfig.FromJson(contacts);
            return policy == null ? null : new GenexDeclaredContacts(policy, staticWorld);
        }
    }
}
