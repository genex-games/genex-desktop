// Port of sdks/rust/genex-multiplayer/src/stamp.rs.
#include "GenexCore/GenexStamp.h"

#include "GenexCore/GenexProtocol.h"

#include <cmath>

namespace genex {

double StampNowMs(const SessionClock& clock) { return clock.Now() + 1.0; }

double StampRealMs(const SessionClock& clock) { return clock.Real() + 1.0; }

const char* StampErrorName(StampError error) {
  switch (error) {
    case StampError::None:
      return "none";
    case StampError::NotAnObject:
      return "player state must be a JSON object";
    case StampError::TooLarge:
      return "player state is over the 16 KiB limit once stamped";
  }
  return "unknown";
}

bool StampState(const Json& state, double t, StampedState* out, StampError* error, std::size_t* stampedBytes) {
  if (!state.IsObject()) {
    if (error != nullptr) *error = StampError::NotAnObject;
    return false;
  }
  Json map = state;
  const bool overwrote = map.Contains(protocol::kSendTimeKey);
  map.Set(protocol::kSendTimeKey, t);
  std::string text = map.Dump();
  if (text.size() > protocol::limits::kMaxStateBytes) {
    if (error != nullptr) *error = StampError::TooLarge;
    if (stampedBytes != nullptr) *stampedBytes = text.size();
    return false;
  }
  if (error != nullptr) *error = StampError::None;
  if (out != nullptr) {
    out->text = std::move(text);
    out->overwroteReservedKey = overwrote;
  }
  return true;
}

PlayerData ParsePlayerData(std::string_view text) {
  PlayerData data;
  std::optional<Json> parsed = Json::Parse(text);
  if (!parsed || !parsed->IsObject()) return data;
  const Json* t = parsed->Find(protocol::kSendTimeKey);
  if (t != nullptr && t->IsNumber() && std::isfinite(t->AsNumber())) data.sendTime = t->AsNumber();
  parsed->Erase(protocol::kSendTimeKey);
  data.state = std::move(*parsed);
  return data;
}

std::optional<Json> ParseJsonText(std::string_view text) {
  if (text.empty()) return std::nullopt;
  return Json::Parse(text);
}

}  // namespace genex
