// Which authority region a session enters through (PROTOCOL.md §17.1 *Regions*): the regions read from
// the sign-in answer (`colyseus.authorityRegions`, else one per flat url), the url each probe sample of a
// region goes to, the order regions are tried in from each url's best sample, and where each attempt of a
// join refused 503 goes. Port of packages/multiplayer/src/authority/regions.ts; held to
// packages/netcode-bench/conformance/authority/authority-regions.json by genex_authority_regions_check, as
// every SDK is, so every SDK picks the same region from the same probe results.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cstddef>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace genex {
class Json;
}

namespace genex::regions {

/** Probe samples per region (relay-select.ts RELAY_SELECT_DEFAULTS.SAMPLES). */
inline constexpr int kProbeSamples = 3;
/** A sample still unanswered after this is a failed sample; also the whole selection's ceiling, ms. */
inline constexpr int kProbeTimeoutMs = 4000;
/** Once any region has answered, how much longer the others get before the choice is made, ms. */
inline constexpr double kProbeGraceMs = 1000.0;
/** Refusals (503) in a row on one region before the next attempt goes to the next-best region. */
inline constexpr int kRefusalsPerRegion = 2;

/** One region of the authority cluster: its name and the servers a join may enter it through. */
struct Region {
  std::string name;
  std::vector<std::string> urls;
  bool operator==(const Region& o) const { return name == o.name && urls == o.urls; }
};

/** A region as a join enters it: through one of its urls. */
struct Pick {
  std::string region;
  std::string url;
};

/** Where a join stands in its capacity walk: its region, its refusals there in a row, the schedule steps waited. */
struct CapacityState {
  std::size_t region = 0;
  int refused = 0;
  std::size_t step = 0;
};

/** One attempt of a join: the region (an index into the ranked list) and the wait before it, ms. */
struct Attempt {
  std::size_t region = 0;
  double waitMs = 0.0;
};

/** The regions a client uses, read leniently from `colyseus.authorityRegions` (an entry with no name or no url is
 *  dropped, a repeated name keeps its first entry); none usable, every flat url is a region of its own. Either
 *  argument may be null. */
GENEX_CORE_API std::vector<Region> Normalize(const Json* regions, const Json* urls);
/** Normalize over typed lists (the options a game passes). */
GENEX_CORE_API std::vector<Region> Normalize(const std::vector<Region>& regions, const std::vector<std::string>& urls);

/** The url each probe sample of a region goes to: sample n to url n modulo the url count. */
GENEX_CORE_API std::vector<std::string> ProbePlan(const std::vector<std::string>& urls, int samples);

/** The order regions are tried in, from each url's best sample (`best[region][url]`; nullopt, a negative or a
 *  non-finite number is no answer): answered regions nearest first (ties in list order), entered through their best
 *  url (the first on a tie), then the silent regions in list order through their first url. */
GENEX_CORE_API std::vector<Pick> Rank(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best);

/** The attempt after a 503 in `state` over `regionCount` ranked regions and the schedule `delays`, or nullopt when
 *  the join gives up. */
/** What a refused join does next (§17.1 *Regions*): the schedule on this region (a full region, a process shutting
 *  down), the next region at once (a dead path), or the end (the server's answer). */
enum class RefusalKind { Capacity, NextRegion, Final };

/** What a join refused with `code` does next; 0 or below is a network that failed. */
inline RefusalKind KindOfRefusal(int code) {
  if (code <= 0 || code == 502 || code == 504 || (code >= 520 && code <= 526) || code == 530) return RefusalKind::NextRegion;
  return code == 503 || code == 4213 ? RefusalKind::Capacity : RefusalKind::Final;
}

GENEX_CORE_API std::optional<std::pair<Attempt, CapacityState>> NextAttempt(const CapacityState& state, std::size_t regionCount,
                                                                             const std::vector<double>& delays);

/** Every attempt of a join that every server refuses 503: a prefix of it is the walk of a join that is seated. */
GENEX_CORE_API std::vector<Attempt> Walk(std::size_t regionCount, const std::vector<double>& delays);

}  // namespace genex::regions
