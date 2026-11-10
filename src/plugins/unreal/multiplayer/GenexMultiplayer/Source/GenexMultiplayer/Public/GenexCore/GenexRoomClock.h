// The clock the Colyseus C core's room clocks read on Windows. The core's own there is GetTickCount64 (v0.18.10
// utils/time.c): it moves every 15.6 ms and no faster for any timer a program asks for, so everything drawn at the
// server's present (bodies, projectiles, the other seats) stepped by that much. The core has a hook for this,
// colyseus_room_clock_now_provider. Other systems keep the core's own millisecond clock, so all of this is Windows only.
#pragma once

#include "GenexCore/GenexConfig.h"

#if defined(_WIN32)

namespace genex {

/** What the core's room clocks read: Clock::NowMs moved above 0, as the core's own reading always is (it tests times
 *  against 0); the virtual clock's own reading when that is on. */
GENEX_CORE_API double FineRoomClockMs();

/** Points the core's room clocks in `library` at FineRoomClockMs, before any room exists (Pump::EnsurePolled does).
 *  The hook is found by name: it is a variable, and colyseus.lib lists it as code. Under /DELAYLOAD a `dllimport`
 *  declaration, and with or without it the header's plain `extern`, link, then fault on the write (0xC0000005, read under
 *  cl.exe). False, with the core's own clock left in place, when `library` is not loaded or has no such export. */
GENEX_CORE_API bool UseFineRoomClock(const wchar_t* library = L"colyseus.dll");

}  // namespace genex

#endif  // _WIN32
