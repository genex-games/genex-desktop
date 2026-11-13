// Which authority region a session enters through (PROTOCOL.md §17.1 *Regions*): the regions read from
// the sign-in answer (`colyseus.authorityRegions`, else one per flat url), the url each probe sample of a
// region goes to and the address its HTTP ping is sent to (PingUrl), the order regions are tried in from each
// url's best sample, and where each attempt of a join refused 503 goes. Port of packages/multiplayer/src/authority/regions.ts; held to
// packages/netcode-bench/conformance/authority/authority-regions.json by genex_authority_regions_check, as
// every SDK is, so every SDK picks the same region from the same probe results.
// Each region is its own matchmaking pool (the server filters rooms by the region a join entered through), so
// the order is where a player meets others, not only how far the server is. A pool join therefore looks for
// players first (§17.1 *Finding players*, PlanSearch): it asks the regions in reach for a room that already
// exists, nearest first, and opens one in the nearest region only when none has. Silence is not distance: a browser
// opens its sockets to one address one at a time, so a far region's sample is often still out when the probe ends. A
// silent region is therefore still asked, after the answered ones; only a region measured past the limit is out of
// reach. Each ask is given kAskMs, and the probe gives every region its first sample before any gets a second
// (ProbeOrder). Two players who start at the same
// moment in two regions still each open one, so a player alone in a room keeps asking the regions listed before its
// own (§17.1 *Regrouping*, PlanRegroup), and of two lone players exactly one moves.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <array>
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
/** How far a join looks for players by default, as a probe's round trip in ms (§17.1 *Finding players*): far
 *  enough that a player in one region reaches the others. */
inline constexpr double kMaxPingMs = 350.0;
/** How long one ask for an existing room may take before the next region is asked, ms (§17.1 *Finding players*,
 *  *Regrouping*): a region that never answers costs a join this once, never the whole join. */
inline constexpr double kAskMs = 3000.0;
/** The waits before each ask of a player who is alone in a room, ms (§17.1 *Regrouping*); the last repeats. */
inline constexpr std::array<double, 5> kRegroupWaitsMs = {2000.0, 4000.0, 9000.0, 15000.0, 30000.0};

/** How a pool join picks its region (§17.1 *Finding players*). */
enum class RegionRule {
  /** A room with players in any region in reach, nearest first; else a new room in the nearest region. */
  Players,
  /** The nearest region alone, whoever is elsewhere. */
  Nearest,
};

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

/** What a game or its player chose about regions (§17.1 *Finding players*). */
struct SearchOptions {
  RegionRule rule = RegionRule::Players;
  /** The farthest region asked for players, as a probe's round trip in ms; anything but a finite number >= 0 is
   *  kMaxPingMs. */
  double maxPingMs = kMaxPingMs;
  /** The one region to play in, by name (a player's own choice): no other is joined or created in. Empty, or a name
   *  the cluster does not have, is no choice. */
  std::string region;
  /** The home region (§17.1 *Regions*): the region nearest the player by geography, which the sign-in answer names
   *  (`colyseus.authorityHome`). It is asked and created in first, whatever the probe measured. Empty, or a name the
   *  cluster does not have, is no home. */
  std::string home;
};

/** Where a pool join goes: the regions asked for an existing room, then where one is opened. */
struct SearchPlan {
  std::vector<Pick> search;
  std::vector<Pick> create;
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

/** The url of every probe sample of every region (ProbePlan), in the order the samples are launched: every region's
 *  first sample before any region's second, since a client that opens its sockets to one address one at a time would
 *  otherwise leave the last region's first sample behind every other sample. */
GENEX_CORE_API std::vector<std::string> ProbeOrder(const std::vector<Region>& regions, int samples);

/** The address a sample's HTTP ping goes to (§17.1 *Regions*): the server's root, on the scheme HTTP has for the
 *  socket's (`wss` is `https`, `ws` is `http`), with the same host and port. nullopt for anything but a ws or wss url
 *  with a host: no HTTP ping. The session does not send one yet: its sample is the core's socket ping, which §17.1
 *  keeps for a client with no HTTP stack to ping with (the core's HTTP client blocks and opens a connection for every
 *  request). */
GENEX_CORE_API std::optional<std::string> PingUrl(const std::string& url);

/** The order regions are tried in, from each url's best sample (`best[region][url]`; nullopt, a negative or a
 *  non-finite number is no answer): answered regions nearest first (ties in list order), entered through their best
 *  url (the first on a tie), then the silent regions in list order through their first url. */
GENEX_CORE_API std::vector<Pick> Rank(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best);

/** Where a pool join goes (§17.1 *Finding players*), from each url's best sample (as Rank reads it): the answered
 *  regions no farther than the limit are asked for an existing room, nearest first, then the silent ones in list
 *  order (silence is not distance), and the room is opened in the ranked order. Fewer than two regions to ask is no
 *  search (the join-or-create finds its own region's room), as is the rule Nearest. A pinned region is the only one
 *  joined and the only one created in, through its best url. The home region (§17.1 *Regions*) is asked and created
 *  in first, whatever its sample, and the others follow in the order they have without it; a pin wins over it. */
GENEX_CORE_API SearchPlan PlanSearch(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best,
                                     const SearchOptions& options);

/** Where a player who is alone in a room keeps asking for one that has players (§17.1 *Regrouping*), from each url's
 *  best sample (as Rank reads it) and the region its seat is in. Every client reads the regions in one order, so of
 *  two players each alone in their own region exactly one moves: only the regions listed before `joined` are asked:
 *  the answered ones no farther than the limit, nearest first, then the silent ones in list order. The rule Nearest,
 *  a pinned region and a region the list does not have ask no one. */
GENEX_CORE_API std::vector<Pick> PlanRegroup(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best,
                                             const SearchOptions& options, const std::string& joined);

/** The region `url` enters, by its name in `regions`; empty when none lists it. */
GENEX_CORE_API std::string RegionOf(const std::vector<Region>& regions, const std::string& url);

/** One region as a player's settings show it: its name and its round trip in ms (nullopt: no answer). */
struct RegionPing {
  std::string region;
  std::optional<double> pingMs;
};

/** Every region with its latency, in list order, from each url's best sample (as Rank reads it): a region picker's
 *  rows (measureAuthorityRegions). A region's latency is its best answered url. */
GENEX_CORE_API std::vector<RegionPing> Pings(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best);

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

/** What a refused ask for an existing room does next (§17.1 *Finding players*). */
enum class SearchRefusal {
  /** No room here (Colyseus's 521, no room matches the criteria), a dead path, a full or draining region: the next
   *  region is asked. */
  Next,
  /** The server's answer about this player or game, which every region would repeat. */
  Final,
};

/** What an ask refused with `code` does next; 0 or below is a network that failed. */
GENEX_CORE_API SearchRefusal KindOfSearchRefusal(int code);

GENEX_CORE_API std::optional<std::pair<Attempt, CapacityState>> NextAttempt(const CapacityState& state, std::size_t regionCount,
                                                                             const std::vector<double>& delays);

/** Every attempt of a join that every server refuses 503: a prefix of it is the walk of a join that is seated. */
GENEX_CORE_API std::vector<Attempt> Walk(std::size_t regionCount, const std::vector<double>& delays);

}  // namespace genex::regions
