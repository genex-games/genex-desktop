// Port of sdks/rust/genex-multiplayer/src/interp.rs.
#include "GenexCore/GenexInterp.h"

#include "GenexCore/GenexProtocol.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace genex::interp_detail {

namespace ip = ::genex::protocol::interpolation;

double SenderClock::Push(double sample, double arrival) {
  ++n;
  const std::uint64_t k = n;
  samples.emplace_back(arrival, k);
  while (!mins.empty() && mins.back().first >= sample) mins.pop_back();
  mins.emplace_back(sample, k);
  // Evict only what is BOTH older than kClockWindowMs and beyond the last kClockWindow samples.
  while (samples.size() > ip::kClockWindowMax ||
         (samples.size() > ip::kClockWindow && !samples.empty() && samples.front().first < arrival - ip::kClockWindowMs)) {
    samples.pop_front();
  }
  const std::uint64_t firstKept = samples.empty() ? k : samples.front().second;
  while (!mins.empty() && mins.front().second < firstKept) mins.pop_front();
  return Offset();
}

double SenderClock::Offset() const { return mins.empty() ? 0.0 : mins.front().first; }

Stream::Stream() : delay(ip::kDefaultMs) {}

void Stream::ResetClock() {
  sender.reset();
  buf.clear();
  lastStamp.reset();
  gaps.clear();
  jitter.clear();
  delay = ip::kDefaultMs;
  bridge = false;
}

std::vector<double> InterpSorted(const std::deque<double>& xs) {
  std::vector<double> v(xs.begin(), xs.end());
  std::sort(v.begin(), v.end());
  return v;
}

double InterpMedian(const std::deque<double>& xs) {
  const std::vector<double> s = InterpSorted(xs);
  return s.empty() ? 66.0 : s[s.size() / 2];
}

/** Nearest-rank quantile (0..1). */
double InterpQuantile(const std::deque<double>& xs, double q) {
  const std::vector<double> s = InterpSorted(xs);
  if (s.empty()) return 0.0;
  const double rank = std::round(q * static_cast<double>(s.size() - 1));
  const std::size_t i = (std::min)(static_cast<std::size_t>(rank), s.size() - 1);
  return s[i];
}

bool InterpFinite(const Json* v, double* out) {
  if (v == nullptr || !v->IsNumber() || !std::isfinite(v->AsNumber())) return false;
  *out = v->AsNumber();
  return true;
}

bool InterpQuat(const Json* v, std::array<double, 4>* out) {
  if (v == nullptr || !v->IsArray() || v->Size() != 4) return false;
  for (std::size_t i = 0; i < 4; ++i) {
    if (!InterpFinite(&v->At(i), &(*out)[i])) return false;
  }
  return true;
}

Json InterpQuatValue(const std::array<double, 4>& q) {
  Json a = Json::MakeArray();
  for (const double c : q) a.Push(c);
  return a;
}

/** Blend a -> b: finite numbers lerp by tNum, quaternions slerp by tQuat, every other value keeps
 *  the OLDER snapshot while interpolating (tNum < 1) and the newer once extrapolating. */
Json InterpBlend(const Json& a, const Json& b, double tNum, double tQuat) {
  const bool interpolating = tNum < 1.0;
  Json out = Json::MakeObject();
  for (const JsonMember& member : b.Members()) {
    const Json* av = a.Find(member.key);
    double x = 0.0;
    double y = 0.0;
    std::array<double, 4> qa{};
    std::array<double, 4> qb{};
    if (InterpFinite(av, &x) && InterpFinite(&member.value, &y)) {
      out.Set(member.key, x + (y - x) * tNum);
    } else if (InterpQuat(av, &qa) && InterpQuat(&member.value, &qb)) {
      out.Set(member.key, InterpQuatValue(Slerp(qa, qb, tQuat)));
    } else if (av != nullptr && interpolating) {
      out.Set(member.key, *av);
    } else {
      out.Set(member.key, member.value);
    }
  }
  return out;
}

/** §10 step 4: sample a JSON stream's buffer at render time r. */
std::optional<Json> InterpSampleBuffer(const SampleBuffer& buf, double r) {
  const std::size_t n = buf.size();
  if (n == 0) return std::nullopt;
  if (n == 1) return buf[0].second;
  std::size_t j = 0;
  while (j < n && buf[j].first <= r) ++j;
  if (j == 0) return buf[0].second;
  if (j >= n) {
    const double at = buf[n - 2].first;
    const double bt = buf[n - 1].first;
    const double span = bt - at;
    if (span <= 0.0) return buf[n - 1].second;
    const double tPos = ((std::min)(r, bt + ip::kMaxExtrapMs) - at) / span;
    const double tRot = ((std::min)(r, bt + ip::kRotExtrapMs) - at) / span;
    return InterpBlend(buf[n - 2].second, buf[n - 1].second, tPos, tRot);
  }
  const double at = buf[j - 1].first;
  const double bt = buf[j].first;
  const double span = bt - at;
  const double t = span > 0.0 ? (r - at) / span : 1.0;
  return InterpBlend(buf[j - 1].second, buf[j].second, t, t);
}

/** §10 step 5: ease prev toward target; numbers by aNum, quaternions by aQuat. */
Json InterpEaseState(const Json& prev, const Json& target, double aNum, double aQuat) {
  Json out = Json::MakeObject();
  for (const JsonMember& member : target.Members()) {
    const Json* pv = prev.Find(member.key);
    double p = 0.0;
    double t = 0.0;
    std::array<double, 4> qp{};
    std::array<double, 4> qt{};
    if (InterpFinite(pv, &p) && InterpFinite(&member.value, &t)) {
      out.Set(member.key, p + (t - p) * aNum);
    } else if (InterpQuat(pv, &qp) && InterpQuat(&member.value, &qt)) {
      out.Set(member.key, InterpQuatValue(Slerp(qp, qt, aQuat)));
    } else {
      out.Set(member.key, member.value);
    }
  }
  return out;
}

}  // namespace genex::interp_detail

namespace genex {

namespace ip = ::genex::protocol::interpolation;

std::array<double, 4> Slerp(const std::array<double, 4>& a, const std::array<double, 4>& b, double t) {
  const double ax = a[0];
  const double ay = a[1];
  const double az = a[2];
  const double aw = a[3];
  double bx = b[0];
  double by = b[1];
  double bz = b[2];
  double bw = b[3];
  double dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0.0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    std::array<double, 4> q = {ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t};
    double l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (l == 0.0) l = 1.0;
    for (double& c : q) c /= l;
    return q;
  }
  const double theta0 = std::acos(dot);
  const double sin0 = std::sin(theta0);
  const double s0 = std::sin(theta0 - theta0 * t) / sin0;
  const double s1 = std::sin(theta0 * t) / sin0;
  return {ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1};
}

void Interpolator::SetPosed(const std::string& stream, bool posed) {
  interp_detail::Stream& s = streams_[stream];
  if (s.posed != posed) {
    s.ResetClock();
    s.smoothed.reset();
    s.posed = posed;
  }
}

void Interpolator::Push(const std::string& stream, const std::string& sender, double s, Json state, double arrival) {
  if (!std::isfinite(s) || s == 0.0) return;
  const double sample = arrival - s;
  const double offset = senders_[sender].Push(sample, arrival);
  interp_detail::Stream& st = streams_[stream];
  st.jitter.push_back(sample);
  if (st.jitter.size() > ip::kClockWindow) st.jitter.pop_front();
  st.sender = sender;

  if (st.lastStamp) {
    const double gap = s - *st.lastStamp;
    if (gap > ip::kMinGapMs && gap < ip::kMaxGapMs) {
      st.gaps.push_back(gap);
      if (st.gaps.size() > ip::kIntervalWindow) st.gaps.pop_front();
      const double jitter = st.jitter.size() >= ip::kJitterMinSamples
                                ? (std::max)(interp_detail::InterpQuantile(st.jitter, 0.9) - offset, 0.0)
                                : 0.0;
      const double raw = (std::max)(ip::kRatio * interp_detail::InterpMedian(st.gaps), ip::kJitterSafety * jitter);
      const double target = (std::min)((std::max)(raw, ip::kMinMs), ip::kMaxMs);
      st.delay += (target - st.delay) * ip::kEase;
    }
  }
  st.lastStamp = s;

  if (st.bridge && st.buf.empty() && st.smoothed) {
    st.buf.emplace_back(s - (std::max)(st.delay, 1.0), *st.smoothed);
  }
  st.bridge = false;
  st.buf.emplace_back(s, std::move(state));
  const double cutoff = s - ip::kHistoryMs;
  while (st.buf.size() > 2 && st.buf.front().first < cutoff) st.buf.pop_front();
  // A head stamped on a foreign clock sits far in the future of the tail: drop it.
  while (st.buf.size() > 1 && st.buf.front().first > st.buf.back().first + ip::kPoisonGuardMs) st.buf.pop_front();
}

std::optional<double> Interpolator::RenderTime(const std::string& stream, double now) const {
  const auto it = streams_.find(stream);
  if (it == streams_.end() || !it->second.sender) return std::nullopt;
  const auto sender = senders_.find(*it->second.sender);
  if (sender == senders_.end()) return std::nullopt;
  return now - sender->second.Offset() - it->second.delay;
}

std::optional<Json> Interpolator::Sample(const std::string& stream, double now) {
  const double r = RenderTime(stream, now).value_or(now - ip::kDefaultMs);
  const auto it = streams_.find(stream);
  if (it == streams_.end()) return std::nullopt;
  interp_detail::Stream& st = it->second;
  std::optional<Json> sampled = st.posed ? SamplePose(st.buf, r) : interp_detail::InterpSampleBuffer(st.buf, r);
  if (!sampled) return st.smoothed;
  Json out;
  if (st.smoothed) {
    const double dt = (std::min)((std::max)(now - st.smoothedAt, 0.0), ip::kMaxHostTickDtMs);
    const double aPos = 1.0 - std::exp(-dt / ip::kSmoothTauPosMs);
    const double aRot = 1.0 - std::exp(-dt / ip::kSmoothTauRotMs);
    out = st.posed ? EasePose(*st.smoothed, *sampled, aPos, aRot)
                   : interp_detail::InterpEaseState(*st.smoothed, *sampled, aPos, aRot);
  } else {
    out = std::move(*sampled);
  }
  st.smoothed = out;
  st.smoothedAt = now;
  return out;
}

const Json* Interpolator::Latest(const std::string& stream) const {
  const auto it = streams_.find(stream);
  if (it == streams_.end() || it->second.buf.empty()) return nullptr;
  return &it->second.buf.back().second;
}

std::optional<double> Interpolator::Delay(const std::string& stream) const {
  const auto it = streams_.find(stream);
  if (it == streams_.end()) return std::nullopt;
  return it->second.delay;
}

std::optional<double> Interpolator::SenderOffset(const std::string& sender) const {
  const auto it = senders_.find(sender);
  if (it == senders_.end()) return std::nullopt;
  return it->second.Offset();
}

std::size_t Interpolator::BufferSize(const std::string& stream) const {
  const auto it = streams_.find(stream);
  return it == streams_.end() ? 0 : it->second.buf.size();
}

void Interpolator::ResetEpoch(const std::string& stream) {
  const auto it = streams_.find(stream);
  if (it == streams_.end()) return;
  it->second.ResetClock();
  it->second.smoothed.reset();
}

void Interpolator::SoftHandoff(const std::string& stream) {
  const auto it = streams_.find(stream);
  if (it == streams_.end()) return;
  it->second.ResetClock();
  it->second.bridge = it->second.smoothed.has_value();
}

void Interpolator::Hold(const std::string& stream, Json state, double now) {
  interp_detail::Stream& st = streams_[stream];
  st.smoothed = std::move(state);
  st.smoothedAt = now;
}

void Interpolator::RemoveStream(const std::string& stream) { streams_.erase(stream); }

void Interpolator::RemoveSender(const std::string& sender) { senders_.erase(sender); }

void Interpolator::RebaseAll() {
  streams_.clear();
  senders_.clear();
}

}  // namespace genex
