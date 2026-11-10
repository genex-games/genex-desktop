#include "GenexCore/GenexPump.h"

#include "GenexCore/GenexColyseus.h"
#if defined(_WIN32)
#include "GenexCore/GenexLog.h"
#include "GenexCore/GenexRoomClock.h"
#endif

#include <algorithm>
#include <limits>
#include <vector>

namespace genex::pump_detail {

struct PumpState {
  // Removed entries are nulled while a frame iterates, and compacted after it.
  std::vector<IPumped*> objects;
  bool polledSet = false;
  bool hasFrame = false;
  std::uint64_t lastFrame = 0;
  bool inFrame = false;
  double frameNow = 0.0;
};

PumpState& State() {
  static PumpState state;
  return state;
}

}  // namespace genex::pump_detail

namespace genex {

IPumped::~IPumped() = default;

void Pump::EnsurePolled() {
  pump_detail::PumpState& state = pump_detail::State();
  if (state.polledSet) return;
  state.polledSet = true;
  colyseus_set_polled(true);
#if defined(_WIN32)
  // The call above has loaded the library. A build without the hook still plays, on the core's 15.6 ms clock.
  if (!UseFineRoomClock()) Log(LogLevel::Warning, "the Colyseus core offers no room clock hook: drawing steps by 15.6 ms");
#endif
}

void Pump::Register(IPumped* object) {
  if (object == nullptr) return;
  EnsurePolled();
  std::vector<IPumped*>& objects = pump_detail::State().objects;
  if (std::find(objects.begin(), objects.end(), object) != objects.end()) return;
  objects.push_back(object);
}

void Pump::Unregister(IPumped* object) {
  if (object == nullptr) return;
  pump_detail::PumpState& state = pump_detail::State();
  const auto it = std::find(state.objects.begin(), state.objects.end(), object);
  if (it == state.objects.end()) return;
  if (state.inFrame) {
    *it = nullptr;
  } else {
    state.objects.erase(it);
  }
}

void Pump::Frame(double nowMs, std::uint64_t frameId) {
  pump_detail::PumpState& state = pump_detail::State();
  if (state.inFrame) return;
  EnsurePolled();
  if (state.hasFrame && state.lastFrame == frameId) return;
  state.hasFrame = true;
  state.lastFrame = frameId;

  state.inFrame = true;
  state.frameNow = nowMs;
  const std::size_t before = state.objects.size();
  for (std::size_t i = 0; i < before; ++i) {
    IPumped* object = state.objects[i];
    if (object != nullptr) object->BeforePoll();
  }
  colyseus_poll();
  // Objects registered during this loop sit past `count` and wait for the next frame.
  const std::size_t count = state.objects.size();
  for (std::size_t i = 0; i < count; ++i) {
    IPumped* object = state.objects[i];
    if (object != nullptr) object->Update(nowMs);
  }
  state.inFrame = false;
  state.objects.erase(std::remove(state.objects.begin(), state.objects.end(), nullptr), state.objects.end());
}

double Pump::FrameNowMs() {
  const pump_detail::PumpState& state = pump_detail::State();
  return state.inFrame ? state.frameNow : std::numeric_limits<double>::quiet_NaN();
}

std::uint64_t Pump::Count() {
  const std::vector<IPumped*>& objects = pump_detail::State().objects;
  return static_cast<std::uint64_t>(
      std::count_if(objects.begin(), objects.end(), [](const IPumped* o) { return o != nullptr; }));
}

}  // namespace genex
