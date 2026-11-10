// See GenexAuthorityRegions.h (PROTOCOL.md §17.1 *Regions*).
#include "GenexCore/GenexAuthorityRegions.h"

#include "GenexCore/GenexJson.h"

#include <algorithm>
#include <cmath>

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

std::vector<Pick> Rank(const std::vector<Region>& regions, const std::vector<std::vector<std::optional<double>>>& best) {
  struct Heard {
    double ms;
    std::size_t index;
    Pick pick;
  };
  std::vector<Heard> heard;
  std::vector<Pick> silent;
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
      silent.push_back(Pick{r.name, url});
    }
  }
  std::stable_sort(heard.begin(), heard.end(), [](const Heard& a, const Heard& b) { return a.ms < b.ms; });
  std::vector<Pick> out;
  for (Heard& h : heard) out.push_back(std::move(h.pick));
  for (Pick& p : silent) out.push_back(std::move(p));
  return out;
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
