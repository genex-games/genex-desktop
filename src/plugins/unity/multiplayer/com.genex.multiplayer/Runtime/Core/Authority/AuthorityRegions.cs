// Which authority region a session enters through (PROTOCOL.md §17.1 *Regions*; TypeScript authority/regions.ts):
// the regions read from the sign-in answer (colyseus.authorityRegions, else one per flat url), the url each probe
// sample of a region goes to, the order regions are tried in from each url's best sample, and where each attempt of
// a join refused 503 goes, which regions a pool join asks for a room with players before it opens one (§17.1
// *Finding players*), and which regions a player alone in a room keeps asking (§17.1 *Regrouping*). Pure;
// Tests~/GenexSmoke/RegionsCheck.cs holds authority-regions.json exactly, as every SDK does, so every SDK picks the
// same region from the same probe results.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Colyseus;

namespace Genex.Multiplayer.Authority
{
    /// <summary>One region of the authority cluster: its name and the servers a join may enter it through.</summary>
    public sealed class GenexAuthorityRegion
    {
        public string Region;
        public string[] Urls;

        public GenexAuthorityRegion(string region, string[] urls)
        {
            Region = region;
            Urls = urls;
        }
    }

    /// <summary>A region as a join enters it: through one of its urls.</summary>
    public readonly struct GenexRegionPick
    {
        public readonly string Region;
        public readonly string Url;

        public GenexRegionPick(string region, string url)
        {
            Region = region;
            Url = url;
        }
    }

    /// <summary>Where a join stands in its capacity walk: the region it is on, its refusals there in a row, the schedule steps it has waited.</summary>
    public readonly struct GenexCapacityState
    {
        public readonly int Region;
        public readonly int Refused;
        public readonly int Step;

        public GenexCapacityState(int region, int refused, int step)
        {
            Region = region;
            Refused = refused;
            Step = step;
        }
    }

    /// <summary>What a refused join does next: the schedule on this region (a full region, a process shutting down), the next region at once (a dead path), or the end.</summary>
    public enum GenexRefusalKind { Capacity, NextRegion, Final }

    /// <summary>One attempt of a join: the region (an index into the ranked list) and the wait before it, ms.</summary>
    public readonly struct GenexCapacityAttempt
    {
        public readonly int Region;
        public readonly double WaitMs;

        public GenexCapacityAttempt(int region, double waitMs)
        {
            Region = region;
            WaitMs = waitMs;
        }
    }

    /// <summary>How a pool join picks its region (§17.1 *Finding players*), in the TypeScript's RegionRule.</summary>
    public enum GenexRegionRule
    {
        /// <summary>A room with players in any region in reach, nearest first; else a new room in the nearest region.</summary>
        Players,
        /// <summary>The nearest region alone, whoever is elsewhere.</summary>
        Nearest,
    }

    /// <summary>What a refused ask for an existing room does next (§17.1 *Finding players*).</summary>
    public enum GenexSearchRefusal
    {
        /// <summary>No room here (Colyseus's 521, no room matches the criteria), a dead path, a full or draining region: the next region is asked.</summary>
        Next,
        /// <summary>The server's answer about this player or game, which every region would repeat.</summary>
        Final,
    }

    /// <summary>Where a pool join goes: the regions asked for an existing room, then where one is opened.</summary>
    public readonly struct GenexAuthoritySearchPlan
    {
        public readonly List<GenexRegionPick> Search;
        public readonly List<GenexRegionPick> Create;

        public GenexAuthoritySearchPlan(List<GenexRegionPick> search, List<GenexRegionPick> create)
        {
            Search = search;
            Create = create;
        }
    }

    /// <summary>One region as a player's settings show it (<see cref="GenexAuthority.MeasureRegions"/>): its name and its round trip in ms.</summary>
    public sealed class GenexRegionPing
    {
        public readonly string Region;
        /// <summary>The best answered sample of the region's urls, ms; null when none answered (or the cluster has one region, which is not probed).</summary>
        public readonly double? PingMs;

        public GenexRegionPing(string region, double? pingMs)
        {
            Region = region;
            PingMs = pingMs;
        }
    }

    public static class GenexAuthorityRegions
    {
        /// <summary>How far a join looks for players by default, as a probe's round trip in ms (§17.1 *Finding players*):
        /// far enough that a player in one region reaches the others.</summary>
        public const double MaxPingMs = 350;
        /// <summary>Probe samples per region (relay-select.ts RELAY_SELECT_DEFAULTS.SAMPLES).</summary>
        public const int ProbeSamples = 3;
        /// <summary>A sample still unanswered after this is a failed sample; also the whole selection's ceiling, ms.</summary>
        public const int ProbeTimeoutMs = 4000;
        /// <summary>Once any region has answered, how much longer the others get before the choice is made, ms.</summary>
        public const int ProbeGraceMs = 1000;
        /// <summary>Refusals (503) in a row on one region before the next attempt goes to the next-best region.</summary>
        public const int RefusalsPerRegion = 2;
        /// <summary>The waits before each ask of a player who is alone in a room (§17.1 *Regrouping*), ms; the last repeats.</summary>
        public static readonly double[] RegroupWaitsMs = { 2000, 4000, 9000, 15000, 30000 };

        private static string[] UrlList(object v)
        {
            var list = new List<string>();
            if (v is List<object> items) foreach (var u in items) if (u is string s && s.Length > 0) list.Add(s);
            return list.ToArray();
        }

        /// <summary>The regions a client uses, read leniently from <c>colyseus.authorityRegions</c> (parsed JSON: an entry with
        /// no name or no url is dropped, a repeated name keeps its first entry); none usable, every flat url is a region of
        /// its own, named by its url.</summary>
        public static List<GenexAuthorityRegion> Normalize(object regions, object urls)
        {
            var output = new List<GenexAuthorityRegion>();
            if (regions is List<object> entries)
            {
                foreach (var entry in entries)
                {
                    if (!(entry is Dictionary<string, object> map)) continue;
                    if (!(map.TryGetValue("region", out var n) && n is string name && name.Length > 0)) continue;
                    if (output.Any(r => r.Region == name)) continue;
                    var list = UrlList(map.TryGetValue("urls", out var u) ? u : null);
                    if (list.Length == 0) continue;
                    output.Add(new GenexAuthorityRegion(name, list));
                }
            }
            if (output.Count > 0) return output;
            return UrlList(urls).Select(u => new GenexAuthorityRegion(u, new[] { u })).ToList();
        }

        /// <summary><see cref="Normalize(object, object)"/> over typed lists (the options a game passes).</summary>
        public static List<GenexAuthorityRegion> Normalize(GenexAuthorityRegion[] regions, string[] urls)
        {
            var entries = new List<object>();
            foreach (var r in regions ?? Array.Empty<GenexAuthorityRegion>())
            {
                if (r == null) continue;
                entries.Add(new Dictionary<string, object> { ["region"] = r.Region, ["urls"] = (r.Urls ?? Array.Empty<string>()).Cast<object>().ToList() });
            }
            return Normalize(entries, (urls ?? Array.Empty<string>()).Cast<object>().ToList());
        }

        /// <summary>The url each probe sample of a region goes to: sample n to url n modulo the url count.</summary>
        public static string[] ProbePlan(string[] urls, int samples)
        {
            if (urls == null || urls.Length == 0) return Array.Empty<string>();
            var plan = new string[samples];
            for (var n = 0; n < samples; n++) plan[n] = urls[n % urls.Length];
            return plan;
        }

        /// <summary>The order regions are tried in, from each url's best sample (<c>best[region][url]</c>; null, a negative or
        /// a non-finite number is no answer): answered regions nearest first (ties in list order), entered through their best
        /// url (the first on a tie), then the silent regions in list order through their first url.</summary>
        public static List<GenexRegionPick> Rank(IList<GenexAuthorityRegion> regions, IList<double?[]> best) =>
            RankWithLatency(regions, best).Select(x => x.Pick).ToList();

        /// <summary><see cref="Rank"/> with each region's best answered sample (null: nothing answered) and its place in the list kept.</summary>
        private static List<(double? Ms, int Index, GenexRegionPick Pick)> RankWithLatency(IList<GenexAuthorityRegion> regions, IList<double?[]> best)
        {
            var heard = new List<(double Ms, int Index, GenexRegionPick Pick)>();
            var silent = new List<(int Index, GenexRegionPick Pick)>();
            for (var i = 0; i < regions.Count; i++)
            {
                var r = regions[i];
                if (r.Urls.Length == 0) continue;
                double? ms = null;
                var url = r.Urls[0];
                var row = best != null && i < best.Count ? best[i] : null;
                for (var j = 0; j < r.Urls.Length; j++)
                {
                    var v = row != null && j < row.Length ? row[j] : null;
                    if (!(v is double d) || double.IsNaN(d) || double.IsInfinity(d) || d < 0) continue;
                    if (ms.HasValue && d >= ms.Value) continue;
                    ms = d;
                    url = r.Urls[j];
                }
                if (ms.HasValue) heard.Add((ms.Value, i, new GenexRegionPick(r.Region, url)));
                else silent.Add((i, new GenexRegionPick(r.Region, url)));
            }
            heard.Sort((a, b) => a.Ms != b.Ms ? a.Ms.CompareTo(b.Ms) : a.Index.CompareTo(b.Index));
            return heard.Select(h => ((double?)h.Ms, h.Index, h.Pick)).Concat(silent.Select(p => ((double?)null, p.Index, p.Pick))).ToList();
        }

        /// <summary>Where a pool join goes (§17.1 *Finding players*), from each url's best sample: the answered regions no
        /// farther than the limit are asked for an existing room, nearest first, and the room is opened in the ranked order.
        /// Fewer than two regions in reach is no search (the join-or-create finds its own region's room), as is the rule
        /// <see cref="GenexRegionRule.Nearest"/>. A pinned region (one the list has) is the only one joined and created in.
        /// <paramref name="maxPingMs"/> that is null, not finite or below 0 is <see cref="MaxPingMs"/>.</summary>
        public static GenexAuthoritySearchPlan PlanSearch(IList<GenexAuthorityRegion> regions, IList<double?[]> best, GenexRegionRule rule = GenexRegionRule.Players, double? maxPingMs = null, string region = null)
        {
            var ranked = RankWithLatency(regions, best);
            var create = ranked.Select(x => x.Pick).ToList();
            if (region != null)
            {
                foreach (var x in ranked)
                    if (x.Pick.Region == region) return new GenexAuthoritySearchPlan(new List<GenexRegionPick>(), new List<GenexRegionPick> { x.Pick });
            }
            if (rule == GenexRegionRule.Nearest) return new GenexAuthoritySearchPlan(new List<GenexRegionPick>(), create);
            var limit = ReachLimit(maxPingMs);
            var reach = ranked.Where(x => x.Ms.HasValue && x.Ms.Value <= limit).Select(x => x.Pick).ToList();
            return new GenexAuthoritySearchPlan(reach.Count >= 2 ? reach : new List<GenexRegionPick>(), create);
        }

        /// <summary>The farthest region asked for players, ms: <paramref name="maxPingMs"/> unless it is null, not finite or below 0.</summary>
        private static double ReachLimit(double? maxPingMs) =>
            maxPingMs.HasValue && !double.IsNaN(maxPingMs.Value) && !double.IsInfinity(maxPingMs.Value) && maxPingMs.Value >= 0 ? maxPingMs.Value : MaxPingMs;

        /// <summary>Where a player who is alone in a room keeps asking for one that has players (§17.1 *Regrouping*), from each
        /// url's best sample and the region <paramref name="joined"/> its seat is in. Every client reads the regions in one
        /// order, so of two players each alone in their own region exactly one moves: only the regions listed BEFORE
        /// <paramref name="joined"/> are asked, nearest first, among the answered ones no farther than the limit. The rule
        /// <see cref="GenexRegionRule.Nearest"/>, a pinned region (one the list has) and a region the list does not have ask no one.</summary>
        public static List<GenexRegionPick> PlanRegroup(IList<GenexAuthorityRegion> regions, IList<double?[]> best, GenexRegionRule rule, double? maxPingMs, string region, string joined)
        {
            var none = new List<GenexRegionPick>();
            if (rule == GenexRegionRule.Nearest) return none;
            if (region != null && regions.Any(r => r.Region == region)) return none;
            var at = -1;
            for (var i = 0; i < regions.Count && at < 0; i++)
                if (regions[i].Region == joined) at = i;
            if (at < 0) return none;
            var limit = ReachLimit(maxPingMs);
            return RankWithLatency(regions, best).Where(x => x.Index < at && x.Ms.HasValue && x.Ms.Value <= limit).Select(x => x.Pick).ToList();
        }

        /// <summary>The region <paramref name="url"/> enters, by its name in <paramref name="regions"/>; null when none lists it.</summary>
        public static string RegionOf(IList<GenexAuthorityRegion> regions, string url)
        {
            if (regions == null || url == null) return null;
            foreach (var r in regions)
                if (Array.IndexOf(r.Urls, url) >= 0) return r.Region;
            return null;
        }

        /// <summary>Every region with its latency, in list order, for a region picker: the probe a join runs, with no join. One
        /// region is not probed (its ping is null). Never throws on a probe.</summary>
        public static async Task<List<GenexRegionPing>> Measure(IList<GenexAuthorityRegion> regions, Probe probe = null)
        {
            var best = await ProbeBest(regions, probe);
            var pings = new List<GenexRegionPing>();
            for (var i = 0; i < regions.Count; i++)
            {
                double? ms = null;
                var row = best != null && i < best.Count ? best[i] : null;
                if (row != null)
                    foreach (var v in row)
                        if (v.HasValue && (!ms.HasValue || v.Value < ms.Value)) ms = v;
                pings.Add(new GenexRegionPing(regions[i].Region, ms));
            }
            return pings;
        }

        /// <summary>What an ask for an existing room refused with <paramref name="code"/> does next; 0 or below is a network
        /// that failed. Colyseus answers "no rooms found with provided criteria" with 521, a dead path, so an empty region is
        /// <see cref="GenexSearchRefusal.Next"/>.</summary>
        public static GenexSearchRefusal SearchRefusalKind(int code) =>
            KindOfRefusal(code) == GenexRefusalKind.Final ? GenexSearchRefusal.Final : GenexSearchRefusal.Next;

        /// <summary>What an ask refused with <paramref name="e"/> does next: <see cref="KindOfRefusal(GenexJoinException)"/>'s
        /// reading of it.</summary>
        public static GenexSearchRefusal SearchRefusalKind(GenexJoinException e) =>
            KindOfRefusal(e) == GenexRefusalKind.Final ? GenexSearchRefusal.Final : GenexSearchRefusal.Next;

        /// <summary>What a join refused with <paramref name="e"/> does next. Only a server's answer can be final or a full
        /// region: a failure that is not one (<see cref="GenexJoinException.Answered"/>) is a path that is down, so the next
        /// region is tried, whatever status it was reported with.</summary>
        public static GenexRefusalKind KindOfRefusal(GenexJoinException e) => e.Answered ? KindOfRefusal(e.Code) : GenexRefusalKind.NextRegion;

        /// <summary>The attempt after a 503 in <paramref name="state"/> over <paramref name="regionCount"/> ranked regions and
        /// the capacity schedule <paramref name="delays"/>, or null when the join gives up.</summary>
        /// <summary>What a join refused with <paramref name="code"/> does next (§17.1 *Regions*); 0 or below is a network that failed.</summary>
        public static GenexRefusalKind KindOfRefusal(int code)
        {
            if (code <= 0 || code == 502 || code == 504 || (code >= 520 && code <= 526) || code == 530) return GenexRefusalKind.NextRegion;
            return code == 503 || code == 4213 ? GenexRefusalKind.Capacity : GenexRefusalKind.Final;
        }

        public static (GenexCapacityAttempt Attempt, GenexCapacityState State)? Next(GenexCapacityState state, int regionCount, double[] delays)
        {
            var refused = state.Refused + 1;
            if (refused >= RefusalsPerRegion && state.Region + 1 < regionCount)
            {
                var region = state.Region + 1;
                return (new GenexCapacityAttempt(region, 0), new GenexCapacityState(region, 0, state.Step));
            }
            if (delays == null || state.Step >= delays.Length) return null;
            return (new GenexCapacityAttempt(state.Region, delays[state.Step]), new GenexCapacityState(state.Region, refused, state.Step + 1));
        }

        /// <summary>Every attempt of a join that every server refuses 503: a prefix of it is the walk of a join that is seated.</summary>
        public static List<GenexCapacityAttempt> Walk(int regionCount, double[] delays)
        {
            var attempts = new List<GenexCapacityAttempt> { new GenexCapacityAttempt(0, 0) };
            var state = new GenexCapacityState(0, 0, 0);
            for (var next = Next(state, regionCount, delays); next.HasValue; next = Next(state, regionCount, delays))
            {
                attempts.Add(next.Value.Attempt);
                state = next.Value.State;
            }
            return attempts;
        }

        /// <summary>One latency sample of a url, ms; throws (or never finishes) when it does not answer.</summary>
        public delegate Task<double> Probe(string url, int timeoutMs);

        /// <summary>One Colyseus ping on a fresh client (the TypeScript default).</summary>
        public static Task<double> ColyseusProbe(string url, int timeoutMs) =>
            new Client(url).GetLatency(new LatencyOptions { PingCount = 1, Timeout = timeoutMs });

        /// <summary>Probes every region (every sample at once, one url each; a failed sample is silence) and answers the order
        /// to try them in. One region is not probed. The choice is made once every sample settled, <see cref="ProbeGraceMs"/>
        /// after the first answer, or at <see cref="ProbeTimeoutMs"/>: never on a probe's failure.</summary>
        public static async Task<List<GenexRegionPick>> Select(IList<GenexAuthorityRegion> regions, Probe probe = null) =>
            Rank(regions, await ProbeBest(regions, probe));

        /// <summary><see cref="Select"/> for a pool join: the same probe, answering where to look for players and where to open
        /// a room (<see cref="PlanSearch"/>). One region is not probed.</summary>
        public static async Task<GenexAuthoritySearchPlan> SelectSearch(IList<GenexAuthorityRegion> regions, GenexRegionRule rule = GenexRegionRule.Players, double? maxPingMs = null, string region = null, Probe probe = null) =>
            PlanSearch(regions, await ProbeBest(regions, probe), rule, maxPingMs, region);

        /// <summary>Every url's best answered sample (<c>best[region][url]</c>; null: silent); null for one region or none, which is
        /// not probed.</summary>
        internal static async Task<List<double?[]>> ProbeBest(IList<GenexAuthorityRegion> regions, Probe probe)
        {
            if (regions.Count <= 1) return null;
            probe = probe ?? ColyseusProbe;
            var best = regions.Select(r => new double?[r.Urls.Length]).ToList();
            var gate = new object();
            var firstAnswer = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var samples = new List<Task>();
            for (var i = 0; i < regions.Count; i++)
            {
                var plan = ProbePlan(regions[i].Urls, ProbeSamples);
                foreach (var url in plan)
                {
                    var region = i;
                    var at = Array.IndexOf(regions[i].Urls, url);
                    samples.Add(Sample(probe, url, () => { }, ms =>
                    {
                        lock (gate)
                        {
                            var b = best[region][at];
                            best[region][at] = b.HasValue ? Math.Min(b.Value, ms) : ms;
                        }
                        firstAnswer.TrySetResult(true);
                    }));
                }
            }
            var all = Task.WhenAll(samples);
            var ceiling = GenexTime.Delay(ProbeTimeoutMs);
            var first = await Task.WhenAny(all, ceiling, firstAnswer.Task);
            if (first == firstAnswer.Task) await Task.WhenAny(all, ceiling, GenexTime.Delay(ProbeGraceMs));
            lock (gate) return best.Select(row => (double?[])row.Clone()).ToList();
        }

        private static async Task Sample(Probe probe, string url, Action failed, Action<double> answered)
        {
            try
            {
                var ms = await probe(url, ProbeTimeoutMs);
                if (!double.IsNaN(ms) && !double.IsInfinity(ms) && ms >= 0) answered(ms);
                else failed();
            }
            catch (Exception)
            {
                failed();
            }
        }
    }
}
