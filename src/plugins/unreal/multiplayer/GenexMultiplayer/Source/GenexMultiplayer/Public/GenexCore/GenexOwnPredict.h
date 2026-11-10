// Your own entity's prediction in a predicting room (PROTOCOL.md §17.11 *Seat rules*, *Seat contacts*,
// *The client world*): the session's pure pieces, ports of packages/multiplayer/src/authority/session.ts
// (stepOwn, ownPath) and physics-predict-session.ts (the input-sequence ring, afterSend), held by
// core/tools/own_predict_check.cpp. GenexAuthoritySession.cpp runs them; nothing here touches a room.
//
//  - StepOwnInput: one predicted input on your entity's mirror: the room module's seat rule at the tick
//    the input is applied on (SeatRuleTick), the room's preset step, then the module's seat contact rule
//    against every other seat (SeatContacts), its changes written back as float32. Every own step runs
//    it: the reconciler's (live and replayed), a fresh prediction's in-flight replay, and OwnPath.
//  - OwnPath: your position and velocity after each input in flight (ack + 1 … sent), stepped afresh
//    from the server's state of your entity: the ring is refreshed from it at every keyframe, so a
//    replay never poses your preset body where an older prediction, since corrected, had it.
//  - OwnRing: your predicted position and velocity after each input sent, by sequence: AfterSend eases
//    the positions of the inputs one frame sent from the last pose to this frame's and keeps this
//    frame's velocity; the client world's Adopt reads both (a body rule reads your velocity).
//
// Everything is float64 in the TypeScript's order (GENEX_FP_STRICT_BEGIN in the .cpp); the mirror's
// fields are float32, as the entity's wire type.
#pragma once

#include "GenexCore/GenexBodies.h"
#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexPhysicsPredictor.h"
#include "GenexCore/GenexPresets.h"
#include "GenexCore/GenexSeatContacts.h"
#include "GenexCore/GenexSeatPredict.h"

#include <functional>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace genex {

namespace authority_wire {
struct AuthorityEntity;
struct AuthorityInput;
}  // namespace authority_wire

/** Your own entity after one input: position (room units) and velocity (room units per second). */
struct OwnState {
  bodies::Vec3 p;
  bodies::Vec3 v;
};

/** The room module's rules your own prediction runs, and what they need. */
struct OwnRules {
  /** The module's seat rule (§17.11 *Seat rules*), or none. */
  physics::SeatRule seatRule;
  /** The client's seat contacts (§17.11 *Seat contacts*), or null. Not owned. */
  SeatContacts* contacts = nullptr;
  /** The client's seat prediction (SeatDrawing::Predicted): when set, your contacts come from its pass on every
   *  seat instead of `contacts`. Not owned. */
  SeatWorld* seatWorld = nullptr;
  /** Your entity's id (a contact rule's `a` is the lower id). */
  std::string ownId;
  /** Your entity's `flags` as the contacts see them: set under a declared contact policy (its pair rules read
   *  them), none for a module's own rule (session.ts applyContacts). */
  std::optional<double> ownFlags;
  /** The room's tick rate (other seats move on by their velocity `seq − ack` ticks of it). */
  double tickHz = 60.0;
};

/** A mirrored field of an entity by its schema name (0 for a name that is not one). */
GENEX_CORE_API double AuthorityEntityField(const authority_wire::AuthorityEntity& e, const std::string& field);
/** Writes a mirrored field by its schema name, as float32 where the schema's type is (fround); any
 *  other name is ignored. */
GENEX_CORE_API void SetAuthorityEntityField(authority_wire::AuthorityEntity& e, const std::string& field, double value);

/**
 * One predicted input `seq` on `body` (session.ts stepOwn): the seat rule on the fields `prediction`
 * mirrors (by name; a field it removed reads NaN, a name the prediction does not mirror is dropped) at
 * SeatRuleTick(stateTick, ack, seq), the step under `command` (sanitized as the server does), then the
 * seat contacts against the other seats at this input, the mirrored fields they changed written back
 * as float32. `stateTick` is the latest state's tick and `ack` the inputs it consumed.
 */
GENEX_CORE_API void StepOwnInput(const Prediction& prediction, authority_wire::AuthorityEntity& body,
                                 const authority_wire::AuthorityInput& command, double dt, double seq, double stateTick,
                                 double ack, const OwnRules& rules);

/** The input sent as `seq` on the current socket, or null when the handle no longer holds it. */
using SentInputAt = std::function<const authority_wire::AuthorityInput*(int seq)>;

/**
 * Your entity after each input in flight, `ack + 1` … `sent` (session.ts ownPath): the fields
 * `prediction` mirrors copied from `server` (your entity in the latest state) and stepped with
 * StepOwnInput under each input `inputAt` still holds (one it does not is skipped), in order. Empty
 * when nothing is in flight or the prediction is unknown.
 */
GENEX_CORE_API std::vector<std::pair<double, OwnState>> OwnPath(const Prediction& prediction,
                                                                const authority_wire::AuthorityEntity& server, int ack,
                                                                int sent, const SentInputAt& inputAt, double dt,
                                                                double stateTick, const OwnRules& rules);

/** Your predicted position and velocity after each input sent, by sequence (physics-predict-session.ts
 *  `own`, `lastOwn`, `stepped`). */
class GENEX_CORE_API OwnRing {
 public:
  /** Inputs older than this many before the last sent are forgotten. */
  static constexpr int kKept = 256;

  /**
   * The inputs `Stepped() + 1` … `sent` went out this frame and your entity is now predicted at `pose`
   * (none: unknown): each input's position eased from the last pose to this one (one frame may send
   * several), each with `pose`'s velocity, and `advance(seq)` once per input in order (the client
   * world steps it). Then Stepped() is `sent`.
   */
  void AfterSend(int sent, const std::optional<OwnState>& pose, const std::function<void(double seq)>& advance);
  /** A new socket counts its inputs from 1 again: everything is forgotten and Stepped() is `sent`. */
  void Restart(int sent);
  /** A keyframe was adopted with your inputs up to `sent` stepped. */
  void SetStepped(int sent) { stepped_ = sent; }
  int Stepped() const { return stepped_; }
  /** Overwrites the inputs `path` names with where it puts you (OwnPath, at a keyframe). */
  void Refresh(const std::vector<std::pair<double, OwnState>>& path);
  /** Your position (room units) and velocity (per second) after input `seq`, or none. */
  std::optional<bodies::Vec3> Pose(double seq) const;
  std::optional<bodies::Vec3> Velocity(double seq) const;

 private:
  std::map<double, OwnState> own_;
  std::optional<OwnState> last_;
  int stepped_ = 0;
};

}  // namespace genex
