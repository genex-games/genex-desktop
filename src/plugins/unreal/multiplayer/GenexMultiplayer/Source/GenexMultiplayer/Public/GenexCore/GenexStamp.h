// Sender-clock stamping of player state (PROTOCOL.md §6.1) and the clock every stamp reads.
// Port of sdks/rust/genex-multiplayer/src/stamp.rs; when the two disagree, the Rust file is the
// reference and this one is the bug.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexClock.h"
#include "GenexCore/GenexJson.h"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

namespace genex {

/** The stamping clock of a session: its SessionClock (real monotonic time plus the test skew)
 *  plus 1 ms, so a stamp is never exactly 0 (an object stamp of 0 is reserved, §7.3). Every
 *  message a relay session sends, every arrival time and every timer reads this. */
GENEX_CORE_API double StampNowMs(const SessionClock& clock);
/** StampNowMs without the skew, read at the same instant as a StampNowMs call would be. */
GENEX_CORE_API double StampRealMs(const SessionClock& clock);

enum class StampError {
  None,
  /** Player state must be a JSON object. */
  NotAnObject,
  /** The stamped JSON text is over protocol::limits::kMaxStateBytes. */
  TooLarge,
};

GENEX_CORE_API const char* StampErrorName(StampError error);

/** A stamped state ready for the wire. */
struct StampedState {
  std::string text;
  /** The game's own state carried a `__t` key, which the stamp replaced (SHOULD warn, §6.1). */
  bool overwroteReservedKey = false;
};

/** Stamp `state` with the sender clock `t` (ms) under `__t` and serialize it as JSON text (§6.1).
 *  On failure returns false and sets `error` (and `stampedBytes` for TooLarge) when not null. */
GENEX_CORE_API bool StampState(const Json& state, double t, StampedState* out, StampError* error = nullptr,
                               std::size_t* stampedBytes = nullptr);

/** A stored `PlayerState.data` text, parsed. */
struct PlayerData {
  /** The game-visible state (an object, `__t` removed). */
  Json state = Json::MakeObject();
  /** The sender's stamp; empty when missing or not a finite number (not an interpolation sample). */
  std::optional<double> sendTime;
};

/** Unparseable or non-object text reads as `{}` with no stamp. */
GENEX_CORE_API PlayerData ParsePlayerData(std::string_view text);

/** Parse a JSON-text field (`ObjectState.d`, a `shared` value). Empty or invalid text: nullopt. */
GENEX_CORE_API std::optional<Json> ParseJsonText(std::string_view text);

}  // namespace genex
