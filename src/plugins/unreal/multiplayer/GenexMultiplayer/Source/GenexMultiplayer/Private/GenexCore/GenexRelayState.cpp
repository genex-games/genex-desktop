// Port of sdks/rust/genex-multiplayer/src/native/state.rs.
#include "GenexCore/GenexRelayState.h"

#include "GenexCore/GenexColyseus.h"

#include <cmath>

namespace genex::relay_state_detail {

std::string StateCString(const char* p) { return p == nullptr ? std::string() : std::string(p); }

/** A field of a dynamic schema instance, or nullptr when absent. */
const colyseus_dynamic_value_t* StateGet(void* obj, const char* name) {
  if (obj == nullptr) return nullptr;
  return colyseus_dynamic_schema_get_by_name(static_cast<colyseus_dynamic_schema_t*>(obj), name);
}

std::string StateStr(void* obj, const char* name) {
  const colyseus_dynamic_value_t* v = StateGet(obj, name);
  if (v == nullptr || v->type != COLYSEUS_FIELD_STRING) return std::string();
  return StateCString(v->data.str);
}

double StateNum(void* obj, const char* name, double fallback) {
  const colyseus_dynamic_value_t* v = StateGet(obj, name);
  if (v == nullptr) return fallback;
  double n = 0.0;
  switch (v->type) {
    case COLYSEUS_FIELD_NUMBER:
    case COLYSEUS_FIELD_FLOAT64:
      n = v->data.num;
      break;
    case COLYSEUS_FIELD_FLOAT32:
      n = static_cast<double>(v->data.f32);
      break;
    case COLYSEUS_FIELD_INT8:
      n = static_cast<double>(v->data.i8);
      break;
    case COLYSEUS_FIELD_UINT8:
      n = static_cast<double>(v->data.u8);
      break;
    case COLYSEUS_FIELD_INT16:
      n = static_cast<double>(v->data.i16);
      break;
    case COLYSEUS_FIELD_UINT16:
      n = static_cast<double>(v->data.u16);
      break;
    case COLYSEUS_FIELD_INT32:
      n = static_cast<double>(v->data.i32);
      break;
    case COLYSEUS_FIELD_UINT32:
      n = static_cast<double>(v->data.u32);
      break;
    case COLYSEUS_FIELD_INT64:
      n = static_cast<double>(v->data.i64);
      break;
    case COLYSEUS_FIELD_UINT64:
      n = static_cast<double>(v->data.u64);
      break;
    default:
      return fallback;
  }
  return std::isfinite(n) ? n : fallback;
}

bool StateBool(void* obj, const char* name, bool fallback) {
  const colyseus_dynamic_value_t* v = StateGet(obj, name);
  if (v == nullptr || v->type != COLYSEUS_FIELD_BOOLEAN) return fallback;
  return v->data.boolean;
}

colyseus_map_schema_t* StateMap(void* obj, const char* name) {
  const colyseus_dynamic_value_t* v = StateGet(obj, name);
  if (v == nullptr || v->type != COLYSEUS_FIELD_MAP) return nullptr;
  return v->data.map;
}

/** Visit every (key, value pointer) of a map. Values are typed by the child: a Schema child is a
 *  dynamic schema instance, `map<string>` a `char*`. */
template <typename Fn>
void StateForEach(colyseus_map_schema_t* map, Fn fn) {
  if (map == nullptr) return;
  colyseus_map_schema_foreach(
      map,
      [](const char* key, void* value, void* userdata) { (*static_cast<Fn*>(userdata))(StateCString(key), value); },
      &fn);
}

}  // namespace genex::relay_state_detail

namespace genex {

bool RelayPlayerRaw::operator==(const RelayPlayerRaw& other) const {
  return name == other.name && data == other.data && epoch == other.epoch && connected == other.connected &&
         avatarUrl == other.avatarUrl && uid == other.uid && team == other.team && pose == other.pose &&
         anim == other.anim && poseT == other.poseT && posed == other.posed;
}

bool RelayObjectRaw::operator==(const RelayObjectRaw& other) const {
  return owner == other.owner && seq == other.seq && epoch == other.epoch && t == other.t && d == other.d;
}

bool ReadRelayState(colyseus_room* room, RelayStateSnapshot* out) {
  namespace sd = relay_state_detail;
  if (room == nullptr || out == nullptr) return false;
  void* root = colyseus_room_get_state(room);
  if (root == nullptr) return false;
  RelayStateSnapshot snap;
  snap.host = sd::StateStr(root, "host");
  snap.matchText = sd::StateStr(root, "match");
  snap.clockOrigin = sd::StateNum(root, "clockOrigin", 0.0);
  sd::StateForEach(sd::StateMap(root, "players"), [&snap](std::string id, void* p) {
    if (p == nullptr) return;
    RelayPlayerRaw raw;
    raw.name = sd::StateStr(p, "name");
    raw.data = sd::StateStr(p, "data");
    raw.epoch = sd::StateNum(p, "epoch", 0.0);
    raw.connected = sd::StateBool(p, "connected", true);
    raw.avatarUrl = sd::StateStr(p, "avatarUrl");
    raw.uid = sd::StateStr(p, "uid");
    raw.team = sd::StateNum(p, "team", -1.0);
    raw.pose = {sd::StateNum(p, "x", 0.0),  sd::StateNum(p, "y", 0.0),  sd::StateNum(p, "z", 0.0),
                sd::StateNum(p, "yaw", 0.0), sd::StateNum(p, "vx", 0.0), sd::StateNum(p, "vy", 0.0),
                sd::StateNum(p, "vz", 0.0)};
    raw.anim = sd::StateStr(p, "anim");
    raw.poseT = sd::StateNum(p, "poseT", 0.0);
    raw.posed = sd::StateBool(p, "posed", false);
    snap.players.emplace_back(std::move(id), std::move(raw));
  });
  sd::StateForEach(sd::StateMap(root, "shared"), [&snap](std::string key, void* v) {
    snap.shared.emplace_back(std::move(key), sd::StateCString(static_cast<const char*>(v)));
  });
  sd::StateForEach(sd::StateMap(root, "objects"), [&snap](std::string id, void* o) {
    if (o == nullptr) return;
    RelayObjectRaw raw;
    raw.owner = sd::StateStr(o, "owner");
    raw.seq = sd::StateNum(o, "seq", 0.0);
    raw.epoch = sd::StateNum(o, "epoch", 0.0);
    raw.t = sd::StateNum(o, "t", 0.0);
    raw.d = sd::StateStr(o, "d");
    snap.objects.emplace_back(std::move(id), std::move(raw));
  });
  *out = std::move(snap);
  return true;
}

}  // namespace genex
