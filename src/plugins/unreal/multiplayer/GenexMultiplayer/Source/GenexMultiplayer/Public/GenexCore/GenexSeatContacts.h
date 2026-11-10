// Seat contacts (PROTOCOL.md §17.11 *Seat contacts*, *Seat rules*): a room module's rule between two
// seats' own entities (a car-to-car bump), run in your own entity's prediction. A port of
// packages/multiplayer/src/authority/seat-contacts.ts (SeatContacts, seatRuleTick), held to
// packages/netcode-bench/conformance/authority/seat-contacts.json by core/tools/seat_contacts_check.cpp
// (every field after every event exact: tolerance 0).
//
// The module runs the rule on every pair of seats after each tick's preset steps; the client runs the
// same function after each of your predicted inputs, against every other seat's entity in the latest
// state moved on by its velocity to that input's tick. Pure and transport-free: the session feeds it.
//
// Differences from the TypeScript, by shape only: `spin` is a plain double (0 when the entity has
// none) where the TypeScript's is optional, so a rule that reads an absent spin reads 0 here (NaN
// there); a rule cannot throw (no exceptions), so every pass completes.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace genex {

/** A seat's entity as a seat contact rule sees and changes it (room units, per second). */
struct ContactBody {
  std::string id;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  double yaw = 0.0;
  double spin = 0.0;
  /** The entity's `flags` (a declared contact policy's pair rules read them as `flag:k` tags; 0 elsewhere). */
  double flags = 0.0;
};

/**
 * A seat contact rule: what the room module does to two seats' entities after every tick's preset
 * steps (a car-to-car bump), as a pure function of the two, `a` the lower id. It changes their fields
 * in place. The module must run this very function on the same pairs.
 */
using ContactRule = std::function<void(ContactBody& a, ContactBody& b)>;

/**
 * One client's seat contacts. A pass is the inputs stepped from one state: Apply for input `seq` under
 * the state that consumed your inputs through `ack` starts a new pass when `ack` changed or `seq` is
 * not after the last input stepped (a replay), taking the other seats from `others()` (copied).
 */
class GENEX_CORE_API SeatContacts {
 public:
  SeatContacts(ContactRule rule, std::function<std::vector<ContactBody>()> others);

  /**
   * After your input `seq` was stepped into `own`: the rule against every other seat, moved on by its
   * velocity to that input's tick (`seq − ack` ticks after the state, `tickHz` a second), in id order
   * (bytes: the TypeScript's UTF-16 order below U+E000), `a` the lower id. A seat the rule changed
   * moves on from there. Your fields it changed are written back as float32 (the entity's wire type):
   * a field is changed when it is not equal to what it was (a NaN always is; +0 over −0 never).
   * Without a rule, nothing.
   */
  void Apply(double seq, double ack, ContactBody& own, double tickHz);

 private:
  struct Other {
    ContactBody body;
    /** The input offset (seq − ack) the body moves on from. */
    double from = 0.0;
  };

  ContactRule rule_;
  std::function<std::vector<ContactBody>()> others_;
  bool hasPass_ = false;
  double passAck_ = 0.0;
  double passLast_ = 0.0;
  /** The pass's other seats, by id. */
  std::vector<Other> pass_;
};

/** Two other seats drawn pushed apart (SeparateSeats' memory of a pair that touches, kept with its SeatSide):
 *  the horizontal side the higher id's seat is pushed to from the lower's (`nx`, `ny`, a unit vector), chosen
 *  once when the two first touch and kept until they part, and how much further apart along it the two were
 *  drawn last frame than their own poses are (`push`, units). TypeScript PairPush. */
struct PairPush {
  double nx = 0.0;
  double ny = 0.0;
  double push = 0.0;
};

/** Where a seat was drawn against your entity last frame (SeparateAround's memory, one a seat): its
 *  offset from your drawn entity, whether it was drawn off its own pose (`held`: moved out of yours or
 *  going round it), its own pose's offset (`bx`, `by`) and the frame's time (ms); for a pair of other
 *  seats pushed apart, their side (`hasPair`, `pair`). TypeScript SeatSide. */
struct SeatSide {
  double dx = 0.0;
  double dy = 0.0;
  double dz = 0.0;
  bool held = false;
  double bx = 0.0;
  double by = 0.0;
  double at = 0.0;
  bool hasPair = false;
  PairPush pair;
};

/** A drawn position (SeparateDrawn, SeparateAround). */
struct SeatDrawn {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

/**
 * Another seat's drawn pose `seat` moved out of your drawn entity `you` (§17.11 *Drawing other seats*,
 * seat-contacts.ts separateDrawn: draw-only, never your entity, never the state): the rule run on copies
 * of the two at rest, and the seat moved by its own change less yours, so the whole push is the seat's;
 * repeated (up to 8 pushes) while a rule whose bodies turn with where they are (car-ball's, laid on the
 * band or a wall) leaves it inside, then on along the way the pushes took it to where it stops touching.
 */
GENEX_CORE_API SeatDrawn SeparateDrawn(const ContactRule& rule, const ContactBody& you, const ContactBody& seat);

/**
 * `seat` moved out of `you` without ever being drawn across it (§17.11 *Drawing other seats*, `separate`,
 * seat-contacts.ts separateAround), given where it was drawn last frame (`prev`, null for a seat not drawn
 * against yours a frame ago) at `now` (ms): when the straight move from last frame's drawn seat to this
 * frame's separated one goes through your entity, a seat drawn off its own pose goes round yours instead,
 * and one drawn on its own pose is pushed out on the side it came from. A seat resting on your roof (or
 * yours on its) is first lifted off it by up to SeatLiftMax, and one drawn off its own way is settled out
 * of yours by the rule's own push. `blocked` (SeparateSeats: the move would sweep the seat through another seat drawn
 * last frame) takes the way round yours the same as a move through yours does. Writes this frame's memory to `side`. The drawing turns with std::atan2/cos/sin (a drawing, not a rule), so it matches the TypeScript
 * within packages/netcode-bench/conformance/carball/carball-separate.json's tolerance
 * (core/tools/carball_separate_check.cpp).
 */
GENEX_CORE_API SeatDrawn SeparateAround(const ContactRule& rule, const ContactBody& you, const ContactBody& seat,
                                        const SeatSide* prev, double now, SeatSide* side, bool blocked = false);

/** A seat drawn resting on your roof (or yours on its) is lifted off it by up to this much (units) rather than
 *  pushed out across the ground (seat-contacts.ts SEAT_LIFT_MAX). */
constexpr double SeatLiftMax = 4;
/** Two other seats pushed apart ease back toward their own poses at most this fast (units a second of the pair's
 *  push; seat-contacts.ts SEAT_PAIR_EASE). */
constexpr double SeatPairEase = 720;

/** The memory key of two other seats' pair in SeparateSeats (seat-contacts.ts seatPairKey): the lower id, a NUL,
 *  the higher. */
GENEX_CORE_API std::string SeatPairKey(const std::string& a, const std::string& b);

/** What SeparateSeats drew: each seat's drawn position by id, and this frame's memory (each seat's SeatSide by its
 *  id, each pair's by SeatPairKey). */
struct SeparatedSeats {
  std::map<std::string, SeatDrawn> drawn;
  std::map<std::string, SeatSide> sides;
};

/**
 * Every other seat's drawn pose `seats` moved out of your drawn entity `you`, never across it, and out of each
 * other, never across each other (§17.11 *Drawing other seats*, seat-contacts.ts separateSeats; draw-only), given
 * last frame's memory `prev` at `now` (ms): each seat moved out of yours (SeparateAround); each pair kept on its
 * sides of each other from last frame (unless pushed apart on a side last frame); then a pile of up to 12 passes
 * until no two touch: each seat drawn into yours moved back out of it (unless that crosses yours from where the
 * first step drew it), every two seats that touch pushed apart: two whose own poses are inside each other, or that
 * were pushed on a side last frame, on that side by the least push that parts them, eased back at most
 * SeatPairEase; two whose own poses are apart by the rule, half each; the last pass ends with the step out of
 * yours. Held to
 * carball-separate.json `piles` (core/tools/carball_separate_check.cpp).
 */
GENEX_CORE_API SeparatedSeats SeparateSeats(const ContactRule& rule, const ContactBody& you, const std::vector<ContactBody>& seats,
                                            const std::map<std::string, SeatSide>& prev, double now);

/** The tick your input `seq` is applied on, predicted from a state of tick `stateTick` that consumed
 *  your inputs through `ack`: a predicting room feeds one input a tick (§17.11 *Input pacing*). */
inline double SeatRuleTick(double stateTick, double ack, double seq) { return stateTick + (seq - ack); }

}  // namespace genex
