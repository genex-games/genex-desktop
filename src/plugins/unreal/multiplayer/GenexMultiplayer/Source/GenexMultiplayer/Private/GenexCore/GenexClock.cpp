#include "GenexCore/GenexClock.h"

#include <atomic>
#include <chrono>

namespace genex::clock_detail {

std::chrono::steady_clock::time_point Origin() {
  // Function-local static: initialized on the first call (thread-safe), so a call made during
  // another translation unit's static initialization still sees a valid origin.
  static const std::chrono::steady_clock::time_point origin = std::chrono::steady_clock::now();
  return origin;
}

/** The virtual clock (SetVirtualMsForTests): off until first set. */
std::atomic<bool>& VirtualOn() {
  static std::atomic<bool> on{false};
  return on;
}
std::atomic<double>& VirtualMs() {
  static std::atomic<double> ms{0.0};
  return ms;
}

}  // namespace genex::clock_detail

namespace genex {

double Clock::NowMs() {
  if (clock_detail::VirtualOn().load(std::memory_order_acquire)) return clock_detail::VirtualMs().load(std::memory_order_relaxed);
  const std::chrono::steady_clock::time_point origin = clock_detail::Origin();
  const std::chrono::duration<double, std::milli> elapsed = std::chrono::steady_clock::now() - origin;
  return elapsed.count();
}

double Clock::EpochMs() {
  const std::chrono::duration<double, std::milli> since =
      std::chrono::system_clock::now().time_since_epoch();
  return since.count();
}

void Clock::SetVirtualMsForTests(double ms) {
  clock_detail::VirtualMs().store(ms, std::memory_order_relaxed);
  clock_detail::VirtualOn().store(true, std::memory_order_release);
}

bool Clock::VirtualMsForTests(double* ms) {
  if (!clock_detail::VirtualOn().load(std::memory_order_acquire)) return false;
  if (ms != nullptr) *ms = clock_detail::VirtualMs().load(std::memory_order_relaxed);
  return true;
}

}  // namespace genex
