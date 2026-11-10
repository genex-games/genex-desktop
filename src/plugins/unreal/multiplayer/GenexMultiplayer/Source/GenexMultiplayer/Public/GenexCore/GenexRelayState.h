// Copy the decoded relay room state out of the C core's reflection-built dynamic schema
// (PROTOCOL.md §4). Port of sdks/rust/genex-multiplayer/src/native/state.rs.
//
// No codegen and no per-field callbacks: on every state change the whole root is walked and copied
// into plain values, which the session then diffs against its previous copy. At <= 64 players,
// <= 128 objects and <= 256 shared keys this is cheap, it never holds a C pointer past the
// callback, and the diff gives the §8 step-3 prune after a reconnect for free.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <array>
#include <string>
#include <utility>
#include <vector>

// The C core's room (colyseus/room.h); only GenexRelayState.cpp and GenexRelaySession.cpp see its body.
struct colyseus_room;

namespace genex {

struct RelayPlayerRaw {
  std::string name;
  /** `PlayerState.data`: the sender's stamped JSON text. */
  std::string data;
  double epoch = 0.0;
  bool connected = false;
  std::string avatarUrl;
  std::string uid;
  double team = 0.0;
  /** {x, y, z, yaw, vx, vy, vz} (§6.6). */
  std::array<double, 7> pose{};
  std::string anim;
  double poseT = 0.0;
  bool posed = false;

  bool operator==(const RelayPlayerRaw& other) const;
  bool operator!=(const RelayPlayerRaw& other) const { return !(*this == other); }
};

struct RelayObjectRaw {
  std::string owner;
  double seq = 0.0;
  double epoch = 0.0;
  double t = 0.0;
  /** `ObjectState.d`: JSON text. */
  std::string d;

  bool operator==(const RelayObjectRaw& other) const;
  bool operator!=(const RelayObjectRaw& other) const { return !(*this == other); }
};

struct RelayStateSnapshot {
  std::vector<std::pair<std::string, RelayPlayerRaw>> players;
  /** key -> the value's JSON text. */
  std::vector<std::pair<std::string, std::string>> shared;
  std::vector<std::pair<std::string, RelayObjectRaw>> objects;
  std::string host;
  std::string matchText;
  double clockOrigin = 0.0;
};

/** Copy the room's whole state into `out`. False (and `out` untouched) before the first state.
 *  `room` must be live, read on the pumping thread (a state-change callback is fine). */
GENEX_CORE_API bool ReadRelayState(colyseus_room* room, RelayStateSnapshot* out);

}  // namespace genex
