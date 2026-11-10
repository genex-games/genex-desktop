// The universal contact policy (PROTOCOL.md §17.11 *Contact policy*): how two seats in contact are handled,
// the same way for every genre, as a pure function of the seats, the static world and the kinematic supports at
// the tick. A port of packages/multiplayer/src/authority/contact-policy.ts, held to
// packages/netcode-bench/conformance/authority/contact-policy.json (and, through the car-ball room module's
// rules, to carball-rules.json) by core/tools/contact_policy_check.cpp.
//
// One pair (`ContactPair`):
//  1. each seat's support up (the surface under it; world up in the air) and its body (a box laid on that up,
//     or an upright hull);
//  2. the separating-axis test: the footprints' edge normals plus the axis across the plane when the two seats
//     are level or on one surface, the 15 axes of two boxes laid on their own ups when the ups differ; the
//     contact axis is the one the pair entered through last;
//  3. a `top` contact when that axis is within `supportCos` of the lower seat's support up, else `side`;
//  4. side: pushed apart, each seat taking what the static world lets it take (its yield share);
//  5. top: the upper seat set on the lower's top (cast, the lower yielding what the upper cannot take);
//  6. top policy: stand (rest when the stand test passes, else slide by the stand's slide), slide (off along the
//     first free way, else the lower yields, else pinned), bounce (a stomp) or ghost (no contact).
// The pass (`ContactPass`) runs every pair in id order, then the piles' further passes on pairs still deeper
// than `slop`, pushing every seat back out of the world after each pass that touched. Pure float64 in the
// TypeScript's order and unfused; §17.7's portable sine and cosine is the only trigonometry.
//
// Not ported (server only): the release-1 room's pair cooldown and first-pass sweep options.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexContactConfig.h"
#include "GenexCore/GenexContactWorld.h"
#include "GenexCore/GenexSeatContacts.h"

#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace genex::contact {

/** A seat as the policy sees it: its entity's fields, its tags (pair rules match them) and whether its jump is
 *  held (a stomp's boost). `flags` bit k adds the tag `flag:k`. */
struct PolicyBody : ContactBody {
  std::vector<std::string> tags;
  double jump = 0;
};

/** Whether a contact is between two sides or one seat over another's top. */
enum class ContactKind { Side, Top };
/** How a top contact's slide went: along the upper seat's free way, the lower seat's, or neither. */
enum class SlideWay { None, Free, LowerYields, Pinned };
/** What the module hears from the pass (a stomp's damage stays a server event, never predicted). */
enum class ContactEvent { Stomp };

/** What the policy runs against: the world grown by the seats' hull (none: open air), and optionally the
 *  module's own support up (car-ball's `carUp`, a pure function of the base) and a listener for its events. */
struct ContactEnv {
  const ContactWorld* world = nullptr;
  std::function<V3(double x, double y, double z)> supportUp;
  /** Hears a pair's event: a stomp names the upper seat first. */
  std::function<void(PolicyBody& upper, PolicyBody& lower, ContactEvent event)> onContact;
  /** The id of a seat that never moves (a drawing's own entity): the other seat of its pair takes the whole
   *  push, its own way (along a wall, never into it). */
  std::optional<std::string> fixed;
};

/** One pair's contact: its kind, axis (unit, from `a` to `b`) and depth along it. */
struct PairContact {
  ContactKind kind = ContactKind::Side;
  V3 n{0, 0, 1};
  double depth = 0;
  /** Whether `b` is the upper seat (top contacts; for side contacts the higher across the plane). */
  bool upperIsB = true;
};

/** What one pair step did: its contact, the impulse along the axis (a slide's change), and a top contact's
 *  slide: how it went and the way taken (unit, the direction the sliding seat moves). */
struct PairOutcome : PairContact {
  double j = 0;
  SlideWay way = SlideWay::None;
  std::optional<V3> w;
};

/** The tags of a seat: its own, and `flag:k` for each bit k set in its `flags`. */
GENEX_CORE_API std::vector<std::string> TagsOf(const PolicyBody& b);
/** The first pair rule matching the two seats' tags (either way round), else the policy's top. */
GENEX_CORE_API const TopRule& TopRuleOf(const ContactPolicy& policy, const PolicyBody& a, const PolicyBody& b);

/** How far seat `upper`'s centre is off seat `lower`'s, as a share of the lower's half extent: the larger of the
 *  two in the lower's heading frame (Chebyshev for a hull's square footprint). */
GENEX_CORE_API double HeadOffset(const PolicyBody& upper, const PolicyBody& lower, const ContactPolicy& policy);

/** The least closing speed on a head that is a landing (u/s): above one tick of gravity at any tick rate from 10 Hz
 *  (800 u/s² x 0.1 s), so a released seat falling back onto the top is not one, and below a fall from 6 u. */
constexpr double kHeadLandingSpeed = 100;

/** How a seat over a `stand` head is held (§17.11 step 6 `stand`): it stands (and gets the head's slab); it is
 *  released (no slab, no kick: it is already leaving); or it slides off by the stand's slide. */
enum class HeadHold { Stand, Release, Slide };

/** The stand test (§17.11 step 6 `stand`, and the head slabs): how seat `upper`, over seat `lower` whose pair rule
 *  is the stand `rule`, is held. `center` none: it stands. Else a seat within `center` of the lower's half extent
 *  stands; a landing (closing on it faster than kHeadLandingSpeed) beyond it slides; a resting seat beyond it already
 *  parting at half its slide's step (the speed when the step is none) or more is released (it is leaving); else it
 *  slides once its centre is past the footprint and stands until then. */
GENEX_CORE_API HeadHold HeadHoldOf(const PolicyBody& upper, const PolicyBody& lower, const TopRule& rule, const ContactPolicy& policy);

/** Whether seat `upper` stands on seat `lower` under `rule` (a stand that holds it: it gets the slab). */
GENEX_CORE_API bool HeadStands(const PolicyBody& upper, const PolicyBody& lower, const TopRule& rule, const ContactPolicy& policy);

/** A seat's support up (the module's `supportUp`, else the surface under its base). */
GENEX_CORE_API V3 SupportUpOf(const PolicyBody& b, const ContactPolicy& policy, const ContactEnv& env);

/** The contact of seats `a` and `b` under `policy` (§17.11 steps 1-3): its kind, axis, depth and which seat is
 *  upper; none when they do not touch. */
GENEX_CORE_API std::optional<PairContact> ContactOf(const PolicyBody& a, const PolicyBody& b, const ContactPolicy& policy,
                                                    const ContactEnv& env);

/** Two seats `a` and `b` (`a` the lower id) under `policy` (§17.11 steps 1-6), changed in place: a ghost pair or
 *  two that do not touch are left as they are (none); a side contact is pushed apart; a top contact is set on
 *  the lower seat's top and runs its pair's top policy. `cooling` holds a side contact's impulse back.
 *  `others`: the rest of the pass's seats, whose tops an upper seat also rests on. */
GENEX_CORE_API std::optional<PairOutcome> ContactPair(PolicyBody& a, PolicyBody& b, const ContactPolicy& policy,
                                                      const ContactEnv& env, bool cooling = false,
                                                      const std::vector<PolicyBody*>* others = nullptr);

/** The shares of a side push of `depth` along `n` (from a to b) that `a` and `b` take (§17.11 step 4). */
GENEX_CORE_API std::pair<double, double> YieldShares(const PolicyBody& a, const PolicyBody& b, const V3& n, double depth,
                                                     const ContactWorld* world, const Rides* ridesA, const Rides* ridesB,
                                                     const V3& upA, const V3& upB, double wantA);

/** What a contact pass did. */
struct ContactReport {
  /** Passes that touched a pair. */
  int passes = 0;
  /** Each seat's deepest push out of the world, by id. */
  std::map<std::string, double> pushed;
  /** Each seat's deepest push out through a wall (a face it could not stand on: its z under `supportCos`). */
  std::map<std::string, double> walls;
  /** Top contacts that stood pinned (no free way for either seat). */
  int pinned = 0;
};

/** The contact pass (§17.11 step 7) over `seats` (ids ascending, changed in place): every pair in id order,
 *  then a pile's further passes, up to `policy.passes`, on the pairs still more than `slop` inside each other;
 *  after every pass that touched, every seat the contacts drove into the world pushed back out. */
GENEX_CORE_API ContactReport ContactPass(std::vector<PolicyBody>& seats, const ContactPolicy& policy, const ContactEnv& env);

/** A kinematic-rule body a seat may stand on: its box at the tick and how far it moves to the next. */
struct KinematicSupport {
  std::string key;
  V3 min{};
  V3 max{};
  /** Its move from this tick to the next (`kinematicRule(t + 1) − kinematicRule(t)`). */
  V3 dp{};
};

/** What one seat stands on: another seat or a kinematic body, and the base velocity it gives. */
struct Ride {
  std::string id;
  std::string on;
  V3 v{};
};

/** The `stand` ride (§17.11 step 6, run in the seat-rule slot before the tick's preset steps): each seat
 *  standing on a kinematic body or on a seat whose pair rule is `stand` is carried by its support's velocity for
 *  the tick; a seat leaving it upward (`vz > 0`) keeps that velocity. Changes x y (vx vy on leaving) in place. */
GENEX_CORE_API std::vector<Ride> RideStep(std::vector<PolicyBody>& seats, const std::vector<KinematicSupport>& supports,
                                          const ContactPolicy& policy, const ContactEnv& env, double tickHz);

}  // namespace genex::contact
