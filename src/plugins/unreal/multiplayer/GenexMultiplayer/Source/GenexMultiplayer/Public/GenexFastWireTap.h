// A measuring tool's view of the fast channel's socket (PROTOCOL.md §17.12), the counterpart of the Rust
// SDK's fast_udp::set_wire_tap: what a game client's own socket did, to prove fast@1 ran over UDP. Off unless
// a tool sets it; a game never needs it.
#pragma once

#include "CoreMinimal.h"

/** Called on the game thread, per datagram, with its bytes: `bSent` for a send the socket took, else a
 *  receive. The bytes hold the seat's binding key: a tap must not keep or print them whole. */
using FGenexFastWireTap = void (*)(bool bSent, const uint8* Data, int32 Length);

/** Set the tap, or nullptr for none. */
GENEXMULTIPLAYER_API void GenexSetFastWireTap(FGenexFastWireTap Tap);
