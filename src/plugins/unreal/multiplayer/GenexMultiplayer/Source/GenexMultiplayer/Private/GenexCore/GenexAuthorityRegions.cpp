// See GenexAuthorityRegions.h (PROTOCOL.md §17.1 *Regions*).
#include "GenexCore/GenexAuthorityRegions.h"

#include "GenexCore/GenexJson.h"

#include <algorithm>
#include <cmath>
#include <string_view>

namespace genex::regions {
namespace {

std::vector<std::string> UrlList(const Json* v) {
  std::vector<std::string> out;
  if (v == nullptr || !v->IsArray()) return out;
  for (const Json& u : v->Items()) {
    if (u.IsString() && !u.AsString().empty()) out.push_back(u.AsString());
  }
  return out;
}

bool Answered(const std::optional<double>& v) { return v.has_value() && std::isfinite(*v) && *v >= 0.0; }

/** Whether the bytes of `url` at `at` begin white space as the TypeScript's `\s` reads it (UTF-8). */
bool PingSpaceAt(const std::string& url, std::size_t at) {
  const unsigned char c = static_cast<unsigned char>(url[at]);
  if (c == ' ' || (c >= 0x09 && c <= 0x0D)) return true;
  // U+00A0, U+1680, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
  static constexpr std::string_view kSpaces[] = {"\xC2\xA0",     "\xE1\x9A\x80", "\xE2\x80\xA8", "\xE2\x80\xA9",
                                                 "\xE2\x80\xAF", "\xE2\x81\x9F", "\xE3\x80\x80", "\xEF\xBB\xBF"};
  for (const std::string_view space : kSpaces) {
    if (url.compare(at, space.size(), space) == 0) return true;
  }
  // U+2000 to U+200A.
  if (url.compare(at, 2, "\xE2\x80") != 0 || at + 2 >= url.size()) return false;
  const unsigned char last = static_cast<unsigned char>(url[at + 2]);
  return last >= 0x80 && last <= 0x8A;
}

}  // namespace

std::vector<Region> Normalize(const Json* regions, const Json* urls) {
  std::vector<Region> out;
  if (regions != nullptr && regions->IsArray()) {
    for (const Json& entry : regions->Items()) {
      if (!entry.IsObject()) continue;
      const Json* name = entry.Find("region");
      if (name == nullptr || !name->IsString() || name->AsString().empty()) continue;
      const std::string& n = name->AsString();
      if (std::any_of(out.begin(), out.end(), [&](const Region& r) { return r.name == n; })) continue;
      std::vector<std::string> list = UrlList(entry.Find("urls"));
      if (list.empty()) continue;
      out.push_back(Region{n, std::move(list)});
    }
  }
  if (!out.empty()) return out;
  for (std::string& u : UrlList(urls)) out.push_back(Region{u, {u}});
  return out;
}

std::vector<Region> Normalize(const std::vector<Region>& regions, const std::vector<std::string>& urls) {
  Json entries = Json::MakeArray();
  for (const Region& r : regions) {
    Json entry;
    entry["region"] = r.name;
    Json list = Json::MakeArray();
    for (const std::string& u : r.urls) list.Push(u);
    entry["urls"] = std::move(list);
    entries.Push(std::move(entry));
  }
  Json flat = Json::MakeArray();
  for (const std::string& u : urls) flat.Push(u);
  return Normalize(&entries, &flat);
}

std::vector<std::string> ProbePlan(const std::vector<std::string>& urls, int samples) {
  std::vector<std::string> plan;
  if (urls.empty()) return plan;
  for (int n = 0; n < samples; ++n) plan.push_back(urls[static_cast<std::size_t>(n) % urls.size()]);
  return plan;
}

std::optional<std::string> PingUrl(const std::string& url) {
  const bool secure = url.rfind("wss://", 0) == 0;
  if (!secure && url.rfind("ws://", 0) != 0) return std::nullopt;
  const std::size_t from = secure ? 6 : 5;
  std::size_t to = from;
  while (to < url.size() && url[to] != '/' && url[to] != '?' && url[to] != '#' && !PingSpaceAt(url, to)) ++to;
  if (to == from) return std::nullopt;
  return (secure ? "https://" : "http://") + url.substr(from, to - from) + "/";
}

std::vector<std::string> ProbeOrder(const std::vector<Region>& regions, int samples) {
  std::vector<std::vector<std::string>> plans;
  for (const Region& r : regions) plans.push_back(ProbePlan(r.urls, samples));
  std::vector<std::string> order;
  for (int n = 0; n < samples; ++n) {
    for (std::vector<std::string>& plan : plans) {
      if (static_cast<std::size_t>(n) < plan.size()) order.push_back(std::move(plan[static_cast<std::size_t>(n)]));
    }
  }
  return order;
}

namespace {

/** A region in the order it is tried, with its best answered sample (nullopt: nothing answered) and its place in the
 *  list. */
struct Ranked {
  std::optional<double> ms;
  Pick pick;
  std::size_t index = 0;
};

/** Rank with each region's latency kept. */
std::vector<Ranked> RankMs(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best) {
  struct Heard {
    double ms;
    std::size_t index;
    Pick pick;
  };
  std::vector<Heard> heard;
  std::vector<std::pair<std::size_t, Pick>> silent;
  for (std::size_t i = 0; i < regions.size(); ++i) {
    const Region& r = regions[i];
    if (r.urls.empty()) continue;
    std::optional<double> ms;
    std::string url = r.urls[0];
    for (std::size_t j = 0; j < r.urls.size(); ++j) {
      const std::optional<double> v = i < best.size() && j < best[i].size() ? best[i][j] : std::nullopt;
      if (!Answered(v) || (ms.has_value() && *v >= *ms)) continue;
      ms = v;
      url = r.urls[j];
    }
    if (ms.has_value()) {
      heard.push_back(Heard{*ms, i, Pick{r.name, url}});
    } else {
      silent.emplace_back(i, Pick{r.name, url});
    }
  }
  std::stable_sort(heard.begin(), heard.end(), [](const Heard& a, const Heard& b) { return a.ms < b.ms; });
  std::vector<Ranked> out;
  for (Heard& h : heard) out.push_back(Ranked{h.ms, std::move(h.pick), h.index});
  for (auto& [index, p] : silent) out.push_back(Ranked{std::nullopt, std::move(p), index});
  return out;
}

}  // namespace

std::vector<Pick> Rank(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best) {
  std::vector<Pick> out;
  for (Ranked& r : RankMs(regions, best)) out.push_back(std::move(r.pick));
  return out;
}

SearchPlan PlanSearch(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best,
                      const SearchOptions& options) {
  std::vector<Ranked> ranked = RankMs(regions, best);
  SearchPlan plan;
  // An empty name is no pin: Normalize never keeps a region without one.
  const auto pinned = std::find_if(ranked.begin(), ranked.end(),
                                   [&](const Ranked& r) { return !options.region.empty() && r.pick.region == options.region; });
  if (pinned != ranked.end()) {
    plan.create = {pinned->pick};
    return plan;
  }
  // The home region (§17.1 *Regions*) goes first, whatever its sample; the others keep the order they have without it.
  const auto home = std::find_if(ranked.begin(), ranked.end(),
                                 [&](const Ranked& r) { return !options.home.empty() && r.pick.region == options.home; });
  const bool hasHome = home != ranked.end();
  if (hasHome) std::rotate(ranked.begin(), home, home + 1);
  for (const Ranked& r : ranked) plan.create.push_back(r.pick);
  if (options.rule == RegionRule::Nearest) return plan;
  const double limit = Answered(options.maxPingMs) ? options.maxPingMs : kMaxPingMs;
  std::vector<Pick> reach;
  for (std::size_t i = 0; i < ranked.size(); ++i) {
    const Ranked& r = ranked[i];
    // Silence is not distance: a region that did not answer is asked too; only one measured past the limit is not.
    // The home is the player's own region: asked even silent or past the limit.
    const bool isHome = hasHome && i == 0;
    if (isHome || !r.ms.has_value() || *r.ms <= limit) reach.push_back(r.pick);
  }
  // Fewer than two to ask is no search: the join-or-create finds its own region's room itself.
  if (reach.size() >= 2) plan.search = std::move(reach);
  return plan;
}

std::vector<Pick> PlanRegroup(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best,
                              const SearchOptions& options, const std::string& joined) {
  if (options.rule == RegionRule::Nearest) return {};
  const auto named = [&](const std::string& name) {
    return std::find_if(regions.begin(), regions.end(), [&](const Region& r) { return r.name == name; });
  };
  // A pin the list has keeps the player there; an empty name is no pin, as in PlanSearch.
  if (!options.region.empty() && named(options.region) != regions.end()) return {};
  const auto at = named(joined);
  if (joined.empty() || at == regions.end()) return {};
  const std::size_t joinedAt = static_cast<std::size_t>(at - regions.begin());
  const double limit = Answered(options.maxPingMs) ? options.maxPingMs : kMaxPingMs;
  std::vector<Pick> out;
  for (Ranked& r : RankMs(regions, best)) {
    // Only the regions listed before this one: of two players each alone in their own region, exactly one moves.
    if (r.index < joinedAt && (!r.ms.has_value() || *r.ms <= limit)) out.push_back(std::move(r.pick));
  }
  return out;
}

std::string RegionOf(const std::vector<Region>& regions, const std::string& url) {
  for (const Region& r : regions) {
    if (std::find(r.urls.begin(), r.urls.end(), url) != r.urls.end()) return r.name;
  }
  return {};
}

std::vector<RegionPing> Pings(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best) {
  std::vector<RegionPing> out;
  for (std::size_t i = 0; i < regions.size(); ++i) {
    RegionPing ping{regions[i].name, std::nullopt};
    for (std::size_t j = 0; i < best.size() && j < best[i].size(); ++j) {
      const std::optional<double>& v = best[i][j];
      if (Answered(v) && (!ping.pingMs.has_value() || *v < *ping.pingMs)) ping.pingMs = v;
    }
    out.push_back(std::move(ping));
  }
  return out;
}

SearchRefusal KindOfSearchRefusal(int code) {
  return KindOfRefusal(code) == RefusalKind::Final ? SearchRefusal::Final : SearchRefusal::Next;
}

std::optional<std::pair<Attempt, CapacityState>> NextAttempt(const CapacityState& state, std::size_t regionCount,
                                                             const std::vector<double>& delays) {
  const int refused = state.refused + 1;
  if (refused >= kRefusalsPerRegion && state.region + 1 < regionCount) {
    const std::size_t region = state.region + 1;
    return std::make_pair(Attempt{region, 0.0}, CapacityState{region, 0, state.step});
  }
  if (state.step >= delays.size()) return std::nullopt;
  return std::make_pair(Attempt{state.region, delays[state.step]}, CapacityState{state.region, refused, state.step + 1});
}

std::vector<Attempt> Walk(std::size_t regionCount, const std::vector<double>& delays) {
  std::vector<Attempt> attempts{Attempt{0, 0.0}};
  CapacityState state;
  for (auto next = NextAttempt(state, regionCount, delays); next.has_value(); next = NextAttempt(state, regionCount, delays)) {
    attempts.push_back(next->first);
    state = next->second;
  }
  return attempts;
}

}  // namespace genex::regions
