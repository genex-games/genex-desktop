// Which authority region a session enters through (PROTOCOL.md §17.1 *Regions*; TypeScript authority/regions.ts):
// the regions read from the sign-in answer (colyseus.authorityRegions, else one per flat url), the url each probe
// sample of a region goes to, the order regions are tried in from each url's best sample, and where each attempt of
// a join refused 503 goes. Pure; Tests~/GenexSmoke/RegionsCheck.cs holds authority-regions.json exactly, as every
// SDK does, so every SDK picks the same region from the same probe results.
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

    public static class GenexAuthorityRegions
    {
        /// <summary>Probe samples per region (relay-select.ts RELAY_SELECT_DEFAULTS.SAMPLES).</summary>
        public const int ProbeSamples = 3;
        /// <summary>A sample still unanswered after this is a failed sample; also the whole selection's ceiling, ms.</summary>
        public const int ProbeTimeoutMs = 4000;
        /// <summary>Once any region has answered, how much longer the others get before the choice is made, ms.</summary>
        public const int ProbeGraceMs = 1000;
        /// <summary>Refusals (503) in a row on one region before the next attempt goes to the next-best region.</summary>
        public const int RefusalsPerRegion = 2;

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
        public static List<GenexRegionPick> Rank(IList<GenexAuthorityRegion> regions, IList<double?[]> best)
        {
            var heard = new List<(double Ms, int Index, GenexRegionPick Pick)>();
            var silent = new List<GenexRegionPick>();
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
                else silent.Add(new GenexRegionPick(r.Region, url));
            }
            heard.Sort((a, b) => a.Ms != b.Ms ? a.Ms.CompareTo(b.Ms) : a.Index.CompareTo(b.Index));
            return heard.Select(h => h.Pick).Concat(silent).ToList();
        }

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
        public static async Task<List<GenexRegionPick>> Select(IList<GenexAuthorityRegion> regions, Probe probe = null)
        {
            if (regions.Count <= 1) return Rank(regions, null);
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
            lock (gate) return Rank(regions, best.Select(row => (double?[])row.Clone()).ToList());
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
