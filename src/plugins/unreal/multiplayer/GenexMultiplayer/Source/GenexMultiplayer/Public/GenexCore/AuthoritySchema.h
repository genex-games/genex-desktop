// GENERATED from packages/multiplayer/src/authority/schema.ts by packages/multiplayer/scripts/gen-engine-schema.ts.
// Do not edit: change schema.ts, then run `node --conditions=@genex-ai/source packages/multiplayer/scripts/gen-engine-schema.ts`.
//
// The authority room state and input (PROTOCOL.md §17.3) for the official Colyseus C core's decoder and
// reconciler, in its schema-codegen shape (@colyseus/schema codegen/languages/c.ts) adapted to C++17 under
// GenexCore's rules (sdks/unreal/core/DESIGN.md). FIELD ORDER IS WIRE ORDER and fields are only ever
// appended.
//  - Each class is a plain standard-layout struct whose first member is the C core's colyseus_schema_t
//    header, so offsetof() is valid and a colyseus_schema_t* is the struct's address.
//  - Type names are the TypeScript class names (the vtable name is the handshake's type name), and
//    every member is named exactly as on the wire (moveX, owner, clockOrigin, …): the reconciler and
//    the field-access API find fields by these strings.
//  - float32 is a C float (what the decoder stores); number, float64 and quantized are double; boolean is bool;
//    a quantized field points at its resolved descriptor (min, max, range, span, bits, wrap);
//    a string is the decoder's malloc'ed char*, freed by _destroy; a map is a colyseus_map_schema_t*
//    that the DECODER owns and frees (never _destroy, as in schema-codegen).
//  - _create is calloc (every field zero/false/null, as schema-codegen): the first full state carries
//    the TypeScript defaults, AuthorityPlayer.connected = true included.
//  - Functions and tables are `inline` (one definition across translation units and a unity build, no
//    unused-function warning), never `static`; _create already has the vtable's signature, so no
//    function-pointer cast is needed.
#pragma once

#include "GenexCore/GenexColyseus.h"

#include <cstddef>
#include <cstdlib>
#include <type_traits>

namespace genex::authority_wire {

/** The client's input-pacing tunables (from packages/multiplayer/src/authority/input-repeat.ts). */
namespace tuning {
/** How much faster the input clock runs while it owes lead. */
inline constexpr double kThrottleDilation = 0.03;
/** A starve with at most this many inputs buffered asks for a step of lead. */
inline constexpr double kThrottleLowInputs = 1.0;
/** The share of the throttle's lead other seats are drawn on. */
inline constexpr double kThrottleSeatLead = 0.5;
}  // namespace tuning

struct AuthorityInput {
  colyseus_schema_t __base;
  float moveX;
  float moveY;
  float moveZ;
  float yaw;
  float pitch;
  double buttons;
  double tick;
};
static_assert(std::is_standard_layout<AuthorityInput>::value, "offsetof needs a standard-layout struct");

inline const colyseus_field_t AuthorityInput_fields[] = {
    {0, "moveX", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityInput, moveX), nullptr, nullptr, nullptr},
    {1, "moveY", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityInput, moveY), nullptr, nullptr, nullptr},
    {2, "moveZ", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityInput, moveZ), nullptr, nullptr, nullptr},
    {3, "yaw", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityInput, yaw), nullptr, nullptr, nullptr},
    {4, "pitch", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityInput, pitch), nullptr, nullptr, nullptr},
    {5, "buttons", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityInput, buttons), nullptr, nullptr, nullptr},
    {6, "tick", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityInput, tick), nullptr, nullptr, nullptr}
};

inline colyseus_schema_t* AuthorityInput_create() {
  return static_cast<colyseus_schema_t*>(std::calloc(1, sizeof(AuthorityInput)));
}

inline void AuthorityInput_destroy(colyseus_schema_t* schema) {
  AuthorityInput* instance = reinterpret_cast<AuthorityInput*>(schema);
  std::free(instance);
}

inline const colyseus_schema_vtable_t AuthorityInput_vtable = {
  "AuthorityInput",
  sizeof(AuthorityInput),
  &AuthorityInput_create,
  &AuthorityInput_destroy,
  AuthorityInput_fields,
  7
};

struct AuthorityEntity {
  colyseus_schema_t __base;
  char* kind;
  char* owner;
  float x;
  float y;
  float z;
  float vx;
  float vy;
  float vz;
  float yaw;
  double hp;
  double flags;
  double epoch;
  char* data;
  double t0;
  float g;
  char* src;
  float pitch;
  float duck;
  double mstate;
  float cap;
  float spin;
  float fuel;
  double qx;
  double qy;
  double qz;
  double qw;
  double lvx;
  double lvy;
  double lvz;
  double avx;
  double avy;
  double avz;
  bool sleep;
  double rest;
};
static_assert(std::is_standard_layout<AuthorityEntity>::value, "offsetof needs a standard-layout struct");

inline const colyseus_quantized_descriptor_t AuthorityEntity_qx_quantized = {-1, 1, 2, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_qy_quantized = {-1, 1, 2, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_qz_quantized = {-1, 1, 2, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_qw_quantized = {-1, 1, 2, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_lvx_quantized = {-64, 64, 128, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_lvy_quantized = {-64, 64, 128, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_lvz_quantized = {-64, 64, 128, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_avx_quantized = {-64, 64, 128, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_avy_quantized = {-64, 64, 128, 65534, 16, false};
inline const colyseus_quantized_descriptor_t AuthorityEntity_avz_quantized = {-64, 64, 128, 65534, 16, false};

inline const colyseus_field_t AuthorityEntity_fields[] = {
    {0, "kind", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityEntity, kind), nullptr, nullptr, nullptr},
    {1, "owner", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityEntity, owner), nullptr, nullptr, nullptr},
    {2, "x", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, x), nullptr, nullptr, nullptr},
    {3, "y", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, y), nullptr, nullptr, nullptr},
    {4, "z", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, z), nullptr, nullptr, nullptr},
    {5, "vx", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, vx), nullptr, nullptr, nullptr},
    {6, "vy", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, vy), nullptr, nullptr, nullptr},
    {7, "vz", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, vz), nullptr, nullptr, nullptr},
    {8, "yaw", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, yaw), nullptr, nullptr, nullptr},
    {9, "hp", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityEntity, hp), nullptr, nullptr, nullptr},
    {10, "flags", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityEntity, flags), nullptr, nullptr, nullptr},
    {11, "epoch", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityEntity, epoch), nullptr, nullptr, nullptr},
    {12, "data", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityEntity, data), nullptr, nullptr, nullptr},
    {13, "t0", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityEntity, t0), nullptr, nullptr, nullptr},
    {14, "g", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, g), nullptr, nullptr, nullptr},
    {15, "src", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityEntity, src), nullptr, nullptr, nullptr},
    {16, "pitch", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, pitch), nullptr, nullptr, nullptr},
    {17, "duck", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, duck), nullptr, nullptr, nullptr},
    {18, "mstate", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityEntity, mstate), nullptr, nullptr, nullptr},
    {19, "cap", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, cap), nullptr, nullptr, nullptr},
    {20, "spin", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, spin), nullptr, nullptr, nullptr},
    {21, "fuel", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityEntity, fuel), nullptr, nullptr, nullptr},
    {22, "qx", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, qx), nullptr, nullptr, &AuthorityEntity_qx_quantized},
    {23, "qy", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, qy), nullptr, nullptr, &AuthorityEntity_qy_quantized},
    {24, "qz", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, qz), nullptr, nullptr, &AuthorityEntity_qz_quantized},
    {25, "qw", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, qw), nullptr, nullptr, &AuthorityEntity_qw_quantized},
    {26, "lvx", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, lvx), nullptr, nullptr, &AuthorityEntity_lvx_quantized},
    {27, "lvy", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, lvy), nullptr, nullptr, &AuthorityEntity_lvy_quantized},
    {28, "lvz", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, lvz), nullptr, nullptr, &AuthorityEntity_lvz_quantized},
    {29, "avx", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, avx), nullptr, nullptr, &AuthorityEntity_avx_quantized},
    {30, "avy", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, avy), nullptr, nullptr, &AuthorityEntity_avy_quantized},
    {31, "avz", COLYSEUS_FIELD_QUANTIZED, "quantized", offsetof(AuthorityEntity, avz), nullptr, nullptr, &AuthorityEntity_avz_quantized},
    {32, "sleep", COLYSEUS_FIELD_BOOLEAN, "boolean", offsetof(AuthorityEntity, sleep), nullptr, nullptr, nullptr},
    {33, "rest", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityEntity, rest), nullptr, nullptr, nullptr}
};

inline colyseus_schema_t* AuthorityEntity_create() {
  return static_cast<colyseus_schema_t*>(std::calloc(1, sizeof(AuthorityEntity)));
}

inline void AuthorityEntity_destroy(colyseus_schema_t* schema) {
  AuthorityEntity* instance = reinterpret_cast<AuthorityEntity*>(schema);
  if (instance->kind) std::free(instance->kind);
  if (instance->owner) std::free(instance->owner);
  if (instance->data) std::free(instance->data);
  if (instance->src) std::free(instance->src);
  std::free(instance);
}

inline const colyseus_schema_vtable_t AuthorityEntity_vtable = {
  "AuthorityEntity",
  sizeof(AuthorityEntity),
  &AuthorityEntity_create,
  &AuthorityEntity_destroy,
  AuthorityEntity_fields,
  34
};

struct AuthorityPlayer {
  colyseus_schema_t __base;
  char* name;
  char* uid;
  char* team;
  bool connected;
  char* avatarUrl;
  double seqBase;
  float inMoveX;
  float inMoveY;
  float inMoveZ;
  float inYaw;
  float inPitch;
  double inButtons;
  double inRep;
  double inStarve;
  double inBuf;
};
static_assert(std::is_standard_layout<AuthorityPlayer>::value, "offsetof needs a standard-layout struct");

inline const colyseus_field_t AuthorityPlayer_fields[] = {
    {0, "name", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityPlayer, name), nullptr, nullptr, nullptr},
    {1, "uid", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityPlayer, uid), nullptr, nullptr, nullptr},
    {2, "team", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityPlayer, team), nullptr, nullptr, nullptr},
    {3, "connected", COLYSEUS_FIELD_BOOLEAN, "boolean", offsetof(AuthorityPlayer, connected), nullptr, nullptr, nullptr},
    {4, "avatarUrl", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityPlayer, avatarUrl), nullptr, nullptr, nullptr},
    {5, "seqBase", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityPlayer, seqBase), nullptr, nullptr, nullptr},
    {6, "inMoveX", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityPlayer, inMoveX), nullptr, nullptr, nullptr},
    {7, "inMoveY", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityPlayer, inMoveY), nullptr, nullptr, nullptr},
    {8, "inMoveZ", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityPlayer, inMoveZ), nullptr, nullptr, nullptr},
    {9, "inYaw", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityPlayer, inYaw), nullptr, nullptr, nullptr},
    {10, "inPitch", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityPlayer, inPitch), nullptr, nullptr, nullptr},
    {11, "inButtons", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityPlayer, inButtons), nullptr, nullptr, nullptr},
    {12, "inRep", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityPlayer, inRep), nullptr, nullptr, nullptr},
    {13, "inStarve", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityPlayer, inStarve), nullptr, nullptr, nullptr},
    {14, "inBuf", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityPlayer, inBuf), nullptr, nullptr, nullptr}
};

inline colyseus_schema_t* AuthorityPlayer_create() {
  return static_cast<colyseus_schema_t*>(std::calloc(1, sizeof(AuthorityPlayer)));
}

inline void AuthorityPlayer_destroy(colyseus_schema_t* schema) {
  AuthorityPlayer* instance = reinterpret_cast<AuthorityPlayer*>(schema);
  if (instance->name) std::free(instance->name);
  if (instance->uid) std::free(instance->uid);
  if (instance->team) std::free(instance->team);
  if (instance->avatarUrl) std::free(instance->avatarUrl);
  std::free(instance);
}

inline const colyseus_schema_vtable_t AuthorityPlayer_vtable = {
  "AuthorityPlayer",
  sizeof(AuthorityPlayer),
  &AuthorityPlayer_create,
  &AuthorityPlayer_destroy,
  AuthorityPlayer_fields,
  15
};

struct AuthorityBody {
  colyseus_schema_t __base;
  char* type;
  char* kind;
  char* colliders;
  char* desc;
};
static_assert(std::is_standard_layout<AuthorityBody>::value, "offsetof needs a standard-layout struct");

inline const colyseus_field_t AuthorityBody_fields[] = {
    {0, "type", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityBody, type), nullptr, nullptr, nullptr},
    {1, "kind", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityBody, kind), nullptr, nullptr, nullptr},
    {2, "colliders", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityBody, colliders), nullptr, nullptr, nullptr},
    {3, "desc", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityBody, desc), nullptr, nullptr, nullptr}
};

inline colyseus_schema_t* AuthorityBody_create() {
  return static_cast<colyseus_schema_t*>(std::calloc(1, sizeof(AuthorityBody)));
}

inline void AuthorityBody_destroy(colyseus_schema_t* schema) {
  AuthorityBody* instance = reinterpret_cast<AuthorityBody*>(schema);
  if (instance->type) std::free(instance->type);
  if (instance->kind) std::free(instance->kind);
  if (instance->colliders) std::free(instance->colliders);
  if (instance->desc) std::free(instance->desc);
  std::free(instance);
}

inline const colyseus_schema_vtable_t AuthorityBody_vtable = {
  "AuthorityBody",
  sizeof(AuthorityBody),
  &AuthorityBody_create,
  &AuthorityBody_destroy,
  AuthorityBody_fields,
  4
};

struct AuthorityShape {
  colyseus_schema_t __base;
  char* data;
};
static_assert(std::is_standard_layout<AuthorityShape>::value, "offsetof needs a standard-layout struct");

inline const colyseus_field_t AuthorityShape_fields[] = {
    {0, "data", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityShape, data), nullptr, nullptr, nullptr}
};

inline colyseus_schema_t* AuthorityShape_create() {
  return static_cast<colyseus_schema_t*>(std::calloc(1, sizeof(AuthorityShape)));
}

inline void AuthorityShape_destroy(colyseus_schema_t* schema) {
  AuthorityShape* instance = reinterpret_cast<AuthorityShape*>(schema);
  if (instance->data) std::free(instance->data);
  std::free(instance);
}

inline const colyseus_schema_vtable_t AuthorityShape_vtable = {
  "AuthorityShape",
  sizeof(AuthorityShape),
  &AuthorityShape_create,
  &AuthorityShape_destroy,
  AuthorityShape_fields,
  1
};

struct AuthorityJoint {
  colyseus_schema_t __base;
  char* desc;
  char* motor;
};
static_assert(std::is_standard_layout<AuthorityJoint>::value, "offsetof needs a standard-layout struct");

inline const colyseus_field_t AuthorityJoint_fields[] = {
    {0, "desc", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityJoint, desc), nullptr, nullptr, nullptr},
    {1, "motor", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityJoint, motor), nullptr, nullptr, nullptr}
};

inline colyseus_schema_t* AuthorityJoint_create() {
  return static_cast<colyseus_schema_t*>(std::calloc(1, sizeof(AuthorityJoint)));
}

inline void AuthorityJoint_destroy(colyseus_schema_t* schema) {
  AuthorityJoint* instance = reinterpret_cast<AuthorityJoint*>(schema);
  if (instance->desc) std::free(instance->desc);
  if (instance->motor) std::free(instance->motor);
  std::free(instance);
}

inline const colyseus_schema_vtable_t AuthorityJoint_vtable = {
  "AuthorityJoint",
  sizeof(AuthorityJoint),
  &AuthorityJoint_create,
  &AuthorityJoint_destroy,
  AuthorityJoint_fields,
  2
};

struct AuthorityRoomState {
  colyseus_schema_t __base;
  colyseus_map_schema_t* players;
  colyseus_map_schema_t* entities;
  double tick;
  double clockOrigin;
  char* preset;
  char* moduleSha;
  double tickOrigin;
  char* physics;
  float lengthUnit;
  colyseus_map_schema_t* bodies;
  char* physDesc;
  double keyframe;
  colyseus_map_schema_t* shapes;
  colyseus_map_schema_t* joints;
  char* lifts;
  char* matchKey;
};
static_assert(std::is_standard_layout<AuthorityRoomState>::value, "offsetof needs a standard-layout struct");

inline const colyseus_field_t AuthorityRoomState_fields[] = {
    {0, "players", COLYSEUS_FIELD_MAP, "map", offsetof(AuthorityRoomState, players), &AuthorityPlayer_vtable, nullptr, nullptr},
    {1, "entities", COLYSEUS_FIELD_MAP, "map", offsetof(AuthorityRoomState, entities), &AuthorityEntity_vtable, nullptr, nullptr},
    {2, "tick", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityRoomState, tick), nullptr, nullptr, nullptr},
    {3, "clockOrigin", COLYSEUS_FIELD_FLOAT64, "float64", offsetof(AuthorityRoomState, clockOrigin), nullptr, nullptr, nullptr},
    {4, "preset", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityRoomState, preset), nullptr, nullptr, nullptr},
    {5, "moduleSha", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityRoomState, moduleSha), nullptr, nullptr, nullptr},
    {6, "tickOrigin", COLYSEUS_FIELD_FLOAT64, "float64", offsetof(AuthorityRoomState, tickOrigin), nullptr, nullptr, nullptr},
    {7, "physics", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityRoomState, physics), nullptr, nullptr, nullptr},
    {8, "lengthUnit", COLYSEUS_FIELD_FLOAT32, "float32", offsetof(AuthorityRoomState, lengthUnit), nullptr, nullptr, nullptr},
    {9, "bodies", COLYSEUS_FIELD_MAP, "map", offsetof(AuthorityRoomState, bodies), &AuthorityBody_vtable, nullptr, nullptr},
    {10, "physDesc", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityRoomState, physDesc), nullptr, nullptr, nullptr},
    {11, "keyframe", COLYSEUS_FIELD_NUMBER, "number", offsetof(AuthorityRoomState, keyframe), nullptr, nullptr, nullptr},
    {12, "shapes", COLYSEUS_FIELD_MAP, "map", offsetof(AuthorityRoomState, shapes), &AuthorityShape_vtable, nullptr, nullptr},
    {13, "joints", COLYSEUS_FIELD_MAP, "map", offsetof(AuthorityRoomState, joints), &AuthorityJoint_vtable, nullptr, nullptr},
    {14, "lifts", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityRoomState, lifts), nullptr, nullptr, nullptr},
    {15, "matchKey", COLYSEUS_FIELD_STRING, "string", offsetof(AuthorityRoomState, matchKey), nullptr, nullptr, nullptr}
};

inline colyseus_schema_t* AuthorityRoomState_create() {
  return static_cast<colyseus_schema_t*>(std::calloc(1, sizeof(AuthorityRoomState)));
}

inline void AuthorityRoomState_destroy(colyseus_schema_t* schema) {
  AuthorityRoomState* instance = reinterpret_cast<AuthorityRoomState*>(schema);
  if (instance->preset) std::free(instance->preset);
  if (instance->moduleSha) std::free(instance->moduleSha);
  if (instance->physics) std::free(instance->physics);
  if (instance->physDesc) std::free(instance->physDesc);
  if (instance->lifts) std::free(instance->lifts);
  if (instance->matchKey) std::free(instance->matchKey);
  std::free(instance);
}

inline const colyseus_schema_vtable_t AuthorityRoomState_vtable = {
  "AuthorityRoomState",
  sizeof(AuthorityRoomState),
  &AuthorityRoomState_create,
  &AuthorityRoomState_destroy,
  AuthorityRoomState_fields,
  16
};

}  // namespace genex::authority_wire
