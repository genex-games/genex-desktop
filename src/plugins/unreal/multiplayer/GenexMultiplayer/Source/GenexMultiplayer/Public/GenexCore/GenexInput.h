// genex::Input: the input a server-authoritative room receives (PROTOCOL.md §17.3, `AuthorityInput`),
// one per fixed step, staged by the game and sent by the authority session. Ported from
// sdks/unity/Runtime/Core/Authority/GenexInput.cs; the sanitizer is the server's own,
// packages/multiplayer/src/authority/wire.ts `sanitizeInput` (number rules: numeric.ts, here in
// GenexCore/GenexPresets.h), as Godot's authority_presets.gd `sanitize_input` ports it too.
//
// Every number is a double, as everywhere in GenexCore; the server sanitizes what it receives (and
// Sanitized() is the same rule), so out-of-range values are clamped or zeroed, never trusted:
//  - moveX, moveY, moveZ: [-1, 1] (non-finite → 0), float32;
//  - yaw, pitch: radians, wrapped to [-π, π) as float32 (non-finite or past 1e9 → 0);
//  - buttons: an integer bitmask in [0, 2^24), else 0.
// Plain value type: copying and sanitizing never allocate (the reconciler's replay sanitizes every
// replayed input).
#pragma once

#include "GenexCore/GenexConfig.h"

namespace genex {

namespace authority_wire {
struct AuthorityInput;
}

struct GENEX_CORE_API Input {
  double moveX = 0.0;
  double moveY = 0.0;
  double moveZ = 0.0;
  double yaw = 0.0;
  double pitch = 0.0;
  double buttons = 0.0;

  /** An input holding these values exactly as given (nothing sanitized yet). */
  static Input FromRaw(double rawMoveX, double rawMoveY, double rawMoveZ, double rawYaw, double rawPitch,
                       double rawButtons);

  /** The wire input (the C core's float32 fields), as the server sanitizes it before its own step:
   *  what the reconciler's replay of a sent input must step with. */
  static Input FromWire(const authority_wire::AuthorityInput& wire);

  /** This input as the server sanitizes it before a module or a preset sees it (wire.ts sanitizeInput). */
  Input Sanitized() const;

  /** Stage this input, sanitized, on the wire instance the input handle sends. */
  void WriteSanitized(authority_wire::AuthorityInput& wire) const;

  /** Clear every field to 0 (no movement, no buttons). */
  void Clear() { *this = Input(); }
};

/** wire.ts sanitizeInput into `into` (no allocation). */
GENEX_CORE_API void SanitizeInto(double rawMoveX, double rawMoveY, double rawMoveZ, double rawYaw, double rawPitch,
                                 double rawButtons, Input& into);

}  // namespace genex
