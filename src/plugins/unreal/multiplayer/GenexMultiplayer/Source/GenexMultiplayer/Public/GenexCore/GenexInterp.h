// The §10 interpolation contract: remote streams rendered slightly in the past, interpolated on
// the SENDER's clock. Port of sdks/rust/genex-multiplayer/src/interp.rs (itself a port of the
// TypeScript SDK's pushSnap / sampleSmoothed); when the two disagree, the Rust file is the
// reference and this one is the bug.
//
// A *stream* is one remote player (keyed by session id) or one object (`obj:<id>`); a *sample* is
// (s, state) with s the sender's own clock stamp. Clock offsets belong to the sender, so all of
// one machine's streams share one estimate and two machines' clocks never mix.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexPose.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <optional>
#include <string>
#include <utility>

namespace genex::interp_detail {

struct SenderClock {
  /** (arrival, sample number) of every kept sample, oldest first. */
  std::deque<std::pair<double, std::uint64_t>> samples;
  /** Monotonic deque of (arrival - send, sample number): front is the window minimum. */
  std::deque<std::pair<double, std::uint64_t>> mins;
  std::uint64_t n = 0;

  double Push(double sample, double arrival);
  double Offset() const;
};

struct Stream {
  std::optional<std::string> sender;
  SampleBuffer buf;
  std::optional<double> lastStamp;
  std::deque<double> gaps;
  std::deque<double> jitter;
  double delay;
  std::optional<Json> smoothed;
  double smoothedAt = 0.0;
  /** Set by a soft handoff: seed the next sample's predecessor with the on-screen pose. */
  bool bridge = false;
  bool posed = false;

  Stream();
  /** Drop the clock-domain state: buffer, gaps, jitter, delay, sender. */
  void ResetClock();
};

}  // namespace genex::interp_detail

namespace genex {

/** The interpolation engine for every remote stream of one session. */
class GENEX_CORE_API Interpolator {
 public:
  /** Mark a stream as a posed player (§10.1) or a JSON stream (§10). Switching drops its history. */
  void SetPosed(const std::string& stream, bool posed);

  /** Feed one sample (s, state) stamped on `sender`'s clock, arriving at local time `arrival`.
   *  Unstamped (`s == 0`) and non-finite stamps are ignored (§7.3, §10). `state` is an object. */
  void Push(const std::string& stream, const std::string& sender, double s, Json state, double arrival);

  /** The render time of a stream, or nullopt before it has a stamped sample. */
  std::optional<double> RenderTime(const std::string& stream, double now) const;

  /** Sample a stream at local time `now`: interpolate on the sender's clock, then output-ease.
   *  nullopt until the stream has a sample (or a held pose after a soft handoff). */
  std::optional<Json> Sample(const std::string& stream, double now);

  /** The newest raw sample of a stream (what game logic reads, §10 step 7); nullptr when none. */
  const Json* Latest(const std::string& stream) const;

  /** The stream's current render delay (ms). */
  std::optional<double> Delay(const std::string& stream) const;

  /** The sender's current clock offset estimate (min of arrival - send), if any. */
  std::optional<double> SenderOffset(const std::string& sender) const;

  /** Samples buffered for a stream (0 when unknown). */
  std::size_t BufferSize(const std::string& stream) const;

  /** An `epoch` change: drop all of the stream's history; the next sample places it (§10 step 6). */
  void ResetEpoch(const std::string& stream);

  /** An ownership change (`seq` changed): the soft handoff of §10 step 6. Keeps the eased pose and
   *  seeds it as a bridge sample before the new owner's first sample. */
  void SoftHandoff(const std::string& stream);

  /** Hold `state` as the stream's on-screen pose (e.g. our own last publish of an object we just
   *  lost), so a following soft handoff glides from it. */
  void Hold(const std::string& stream, Json state, double now);

  /** True teardown: a player left or an object was destroyed. */
  void RemoveStream(const std::string& stream);

  /** A sender's seat is gone: drop its clock estimate. */
  void RemoveSender(const std::string& sender);

  /** One deliberate rebase after a long outage (§8 step 2): every stream and every sender clock. */
  void RebaseAll();

 private:
  std::map<std::string, interp_detail::SenderClock> senders_;
  std::map<std::string, interp_detail::Stream> streams_;
};

/** Quaternion (x, y, z, w) slerp along the shortest arc; t > 1 extrapolates along the same arc. */
GENEX_CORE_API std::array<double, 4> Slerp(const std::array<double, 4>& a, const std::array<double, 4>& b, double t);

}  // namespace genex
