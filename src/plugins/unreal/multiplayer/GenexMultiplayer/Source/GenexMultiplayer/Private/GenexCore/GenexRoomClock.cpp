#include "GenexCore/GenexRoomClock.h"

#if defined(_WIN32)

#include "GenexCore/GenexClock.h"

#if defined(GENEX_WITH_UE)
#include "Windows/WindowsHWrapper.h"
#else
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace genex::room_clock_detail {

/** Above 0, as the core's own reading always is. */
constexpr double kFirstReadingMs = 1000.0;
constexpr const char* kHookExport = "colyseus_room_clock_now_provider";

/** The hook's type in the core's room_clock.h. */
using Provider = double (*)(void);

}  // namespace genex::room_clock_detail

namespace genex {

double FineRoomClockMs() {
  double virtualMs = 0.0;
  if (Clock::VirtualMsForTests(&virtualMs)) return virtualMs;
  return room_clock_detail::kFirstReadingMs + Clock::NowMs();
}

bool UseFineRoomClock(const wchar_t* library) {
  namespace rc = room_clock_detail;
  const HMODULE module = GetModuleHandleW(library);
  if (module == nullptr) return false;
  FARPROC const hook = GetProcAddress(module, rc::kHookExport);
  if (hook == nullptr) return false;
  *reinterpret_cast<rc::Provider*>(hook) = &FineRoomClockMs;
  return true;
}

}  // namespace genex

#endif  // _WIN32
