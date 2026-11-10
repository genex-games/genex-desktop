// Choosing an authority room (PROTOCOL.md §17.2 *Choosing a room*; TypeScript `authority/room-key.ts`): the shapes of a
// match key and a room code, what each way into a room sends, where a join by code goes after a refusal, and which
// world a key picks. Pure; tools/authority_room_key_check.cpp holds room-key.json exactly, as every SDK does.
#pragma once

#include <cstddef>
#include <map>
#include <optional>
#include <string>

#include "GenexCore/GenexProtocol.h"

namespace genex::room_key {

/** A match key's longest length (AuthorityRoomLimits). */
inline constexpr std::size_t kMaxMatchKeyChars = 32;
/** A room code's longest length. */
inline constexpr std::size_t kMaxCodeChars = 32;
/** The most named worlds one module's `worlds` map may hold. */
inline constexpr std::size_t kMaxWorlds = 16;
/** Colyseus's MATCHMAKE_INVALID_ROOM_ID: no room with this id here, or it is full or closing. */
inline constexpr int kRoomNotFound = 522;

namespace detail {
inline bool IsLowerOrDigit(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); }
}  // namespace detail

/** Whether `key` is a match key: 1 to 32 characters of a-z 0-9 . _ : -, a letter or digit first. */
inline bool ValidMatchKey(const std::string& key) {
  if (key.empty() || key.size() > kMaxMatchKeyChars) return false;
  for (std::size_t i = 0; i < key.size(); ++i) {
    const char c = key[i];
    if (detail::IsLowerOrDigit(c)) continue;
    if (i == 0 || (c != '.' && c != '_' && c != ':' && c != '-')) return false;
  }
  return true;
}

/** Whether `code` is a room code: 1 to 32 characters of A-Z a-z 0-9 _ -. A code goes into a url. */
inline bool ValidRoomCode(const std::string& code) {
  if (code.empty() || code.size() > kMaxCodeChars) return false;
  for (const char c : code) {
    if (!detail::IsLowerOrDigit(c) && !(c >= 'A' && c <= 'Z') && c != '_' && c != '-') return false;
  }
  return true;
}

/** The ways into an authority room, by the Colyseus call that makes them. */
enum class JoinMethod { JoinOrCreate, Create, JoinById };
/** Why a client refuses a target before anything reaches the network. */
enum class TargetRefusal { None, BadMatchKey, BadCode, Conflict };

/** Which room a client asks for: a pool (`matchKey`), a new private room, or a room by its code. */
struct RoomTarget {
  std::string matchKey;
  bool createPrivate = false;
  std::optional<std::string> code;
};

/** The Colyseus call a target makes, and the options it adds to the join's own. */
struct JoinPlan {
  TargetRefusal refused = TargetRefusal::None;
  JoinMethod method = JoinMethod::JoinOrCreate;
  std::string roomId;
  /** Sent as `matchKey` when not empty. */
  std::string matchKey;
  /** Sent as `private: true`. */
  bool privateRoom = false;
};

/** What `target` sends. Nothing asked sends nothing new. A code names one room, whose key is its own. */
inline JoinPlan PlanAuthorityJoin(const RoomTarget& target) {
  JoinPlan plan;
  if (target.code) {
    if (target.createPrivate || !target.matchKey.empty()) {
      plan.refused = TargetRefusal::Conflict;
    } else if (!ValidRoomCode(*target.code)) {
      plan.refused = TargetRefusal::BadCode;
    } else {
      plan.method = JoinMethod::JoinById;
      plan.roomId = *target.code;
    }
    return plan;
  }
  if (!target.matchKey.empty() && !ValidMatchKey(target.matchKey)) {
    plan.refused = TargetRefusal::BadMatchKey;
    return plan;
  }
  plan.matchKey = target.matchKey;
  if (target.createPrivate) {
    plan.method = JoinMethod::Create;
    plan.privateRoom = true;
  }
  return plan;
}

/** The region a join by code tries after refusal `error` on region `region` of `regions`, or nullopt when the
 *  refusal is final: only another region can hold a room this one refused as elsewhere. */
inline std::optional<std::size_t> NextCodeRegion(int error, std::size_t region, std::size_t regions) {
  const bool elsewhere = error == protocol::join_error::kWrongRegion || error == kRoomNotFound;
  if (!elsewhere || region + 1 >= regions) return std::nullopt;
  return region + 1;
}

/** The world a room with match key `key` runs, as the sandbox picks it: the `worlds` entry the key names, else
 *  `world`. Call it with the module's own map and hand the result to SetWorld, so the hash is the room's. */
template <typename World>
const World& SelectMatchWorld(const std::map<std::string, World>& worlds, const World& world, const std::string& key) {
  const auto found = worlds.find(key);
  return found == worlds.end() ? world : found->second;
}

}  // namespace genex::room_key
