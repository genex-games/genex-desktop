// genex::Input and the server's input sanitizer. Source of truth:
// packages/multiplayer/src/authority/wire.ts `sanitizeInput`; ported from
// sdks/unity/Runtime/Core/Authority/GenexInput.cs (Godot: authority_presets.gd `sanitize_input`).
#include "GenexCore/GenexInput.h"

#include "GenexCore/AuthoritySchema.h"
#include "GenexCore/GenexPresets.h"

#include <optional>

GENEX_FP_STRICT_BEGIN

namespace genex {

Input Input::FromRaw(double rawMoveX, double rawMoveY, double rawMoveZ, double rawYaw, double rawPitch,
                     double rawButtons) {
  Input input;
  input.moveX = rawMoveX;
  input.moveY = rawMoveY;
  input.moveZ = rawMoveZ;
  input.yaw = rawYaw;
  input.pitch = rawPitch;
  input.buttons = rawButtons;
  return input;
}

Input Input::FromWire(const authority_wire::AuthorityInput& wire) {
  Input clean;
  SanitizeInto(static_cast<double>(wire.moveX), static_cast<double>(wire.moveY), static_cast<double>(wire.moveZ),
               static_cast<double>(wire.yaw), static_cast<double>(wire.pitch), wire.buttons, clean);
  return clean;
}

Input Input::Sanitized() const {
  Input clean;
  SanitizeInto(moveX, moveY, moveZ, yaw, pitch, buttons, clean);
  return clean;
}

void Input::WriteSanitized(authority_wire::AuthorityInput& wire) const {
  const Input clean = Sanitized();
  // Every sanitized move and angle is a float32 already: the narrowing store is exact.
  wire.moveX = static_cast<float>(clean.moveX);
  wire.moveY = static_cast<float>(clean.moveY);
  wire.moveZ = static_cast<float>(clean.moveZ);
  wire.yaw = static_cast<float>(clean.yaw);
  wire.pitch = static_cast<float>(clean.pitch);
  wire.buttons = clean.buttons;
}

void SanitizeInto(double rawMoveX, double rawMoveY, double rawMoveZ, double rawYaw, double rawPitch, double rawButtons,
                  Input& into) {
  into.moveX = presets::Axis(rawMoveX);
  into.moveY = presets::Axis(rawMoveY);
  into.moveZ = presets::Axis(rawMoveZ);
  into.yaw = presets::WrappedAngle(rawYaw).value_or(0.0);
  into.pitch = presets::WrappedAngle(rawPitch).value_or(0.0);
  into.buttons = presets::Mask(rawButtons);
}

}  // namespace genex

GENEX_FP_STRICT_END
