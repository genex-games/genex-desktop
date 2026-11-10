// `config.contacts` (PROTOCOL.md §17.11 *Contact policy*): what a room module declares about how two seats
// in contact are handled, as data (the seats' contact shape, the genre preset whose table fills every setting
// the module leaves out, per-pair overrides by tag), and the resolved policy every SDK runs
// (GenexContactPolicy.h). A port of packages/multiplayer/src/authority/contact-config.ts, held to the
// `config` rows of packages/netcode-bench/conformance/authority/contact-policy.json by
// core/tools/contact_policy_check.cpp: every resolved field, and a refusal by the path of its first bad value.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"

#include <optional>
#include <string>
#include <vector>

namespace genex::contact {

/** Per-pair overrides a module may declare at most, and a tag's length at most. */
constexpr std::size_t kContactPairsMax = 32;
constexpr std::size_t kContactTagMax = 64;
/** Pile passes a module may ask for at most. */
constexpr int kContactPassesMax = 64;
/** Every length and speed a module may give at most (units, units/s). */
constexpr double kContactValueMax = 100000;

/** How a client draws other seats by default (PROTOCOL.md §17.11 *Drawing other seats*). */
enum class ContactDrawing { Predicted, Separate, Timeline };
/** How a side contact's push is split: `Shared` half each, `Mover` by each seat's own closing speed. */
enum class ContactPush { Shared, Mover };
/** What happens when one seat comes to rest on another's top. */
enum class TopPolicy { Stand, Slide, Bounce, Ghost };
/** A seat's contact shape: a box turned with the heading and laid on its support up, or an upright hull. */
enum class ContactShapeKind { Box, Hull };

/** A seat's contact shape, room units: a box's length along the heading, width across and top above the
 *  base; a hull's half side (`radius`) and `height`. */
struct ContactShape {
  ContactShapeKind kind = ContactShapeKind::Hull;
  double length = 0;
  double width = 0;
  double top = 0;
  double radius = 0;
  double height = 0;
};

/** A slide: the parting brought up to `speed` (units/s) by at most `step` a tick (none: in one tick),
 *  `share` of it on the upper seat. */
struct SlideRule {
  double speed = 0;
  std::optional<double> step;
  double share = 1;
};

/** A resolved top rule. A `Slide` carries its settings in `slide`; a `Bounce` its stomp settings and the
 *  `slide` it falls back to under `stompMin` closing speed; a `Stand` (PROTOCOL.md §17.11 step 6) is carried by
 *  the lower seat when `ride`, a landing stands only within `center` times the lower's half width (none:
 *  anywhere it touches) and slides off by `slide` elsewhere. */
struct TopRule {
  TopPolicy policy = TopPolicy::Stand;
  SlideRule slide;
  bool ride = true;
  std::optional<double> center;
  double stompMin = 0;
  double bounceSpeed = 0;
  double jumpBoost = 0;
};

/** How a prop on a seat's top is treated: `Slide` off (its hull frictionless, nudged by `propSlide`), or
 *  `Carry` (friction holds it while level; it slides past its friction angle). */
enum class HeadFriction { Slide, Carry };

/** A prop's slide off a head: its parting brought up to `speed` (u/s) by at most `step` a tick. */
struct PropSlide {
  double speed = 300;
  double step = 150;
};

/** A per-pair override: two seats, one carrying tag `a` and the other `b`, use `top`. */
struct PairRule {
  std::string a;
  std::string b;
  TopRule top;
};

/** The hull the static world is grown by (the movement preset's radius and height) and its skin. */
struct ContactHull {
  double radius = 0;
  double height = 0;
  double skin = 0;
};

/** The resolved policy: every setting filled (from the module, else its preset's table). */
struct ContactPolicy {
  std::string preset;
  ContactShape shape;
  ContactHull hull;
  double groundTrace = 0;
  double supportCos = 0.7;
  double entrySpeed = 1;
  double entryWindow = 1.0 / 60;
  double restitution = 0;
  int passes = 16;
  double slop = 0.1;
  double roofSkin = 0.01;
  /** Each velocity axis a contact writes is clamped to ±this; none: not clamped. */
  std::optional<double> maxVelocity;
  bool stopSpin = false;
  TopRule top;
  /** The slide a top contact becomes when the lower seat's support cannot be stood on. */
  SlideRule offWall;
  std::vector<PairRule> pairs;
  ContactDrawing drawing = ContactDrawing::Separate;
  ContactPush push = ContactPush::Shared;
  /** How a dynamic module body resting on a seat's top is treated (§17.11 *Contact policy*, props). */
  HeadFriction headFriction = HeadFriction::Slide;
  /** The nudge that slides a prop off a head under `headFriction: Slide`. */
  PropSlide propSlide;
};

/** The movement preset the seats step with, as the contact policy reads it: its name (`firstperson` or
 *  `vehicle` run a world) and its numeric parameters (absent ones read as 0). */
struct ContactPresetParams {
  std::string name;
  const Json* params = nullptr;
};

/** The wire spelling of a drawing, a push and a top policy. */
GENEX_CORE_API const char* ContactDrawingName(ContactDrawing d);
GENEX_CORE_API const char* ContactPushName(ContactPush p);
GENEX_CORE_API const char* TopPolicyName(TopPolicy p);
GENEX_CORE_API const char* HeadFrictionName(HeadFriction h);

/**
 * `config.contacts` resolved against the room's movement preset (§17.11 *Contact policy*): every setting
 * the module gave, else the genre preset's. Returns the policy, or nullopt with `refusedPath` set to the path
 * of the first bad value (from `path`, default `$.config.contacts`) for a value that is not an object, an
 * unknown key, a preset or policy that does not exist, a number out of range, a shape without its
 * dimensions, more than kContactPairsMax pair rules, or a room whose movement preset steps through no world.
 */
GENEX_CORE_API std::optional<ContactPolicy> ResolveContactConfig(const Json& given, const ContactPresetParams* preset,
                                                                 std::string* refusedPath,
                                                                 const std::string& path = "$.config.contacts");

/**
 * The resolved policy a room's state carries (§17.11 *Contact policy*: the host resolves the module's declaration
 * and publishes it as the `contacts` of the state's `preset` text, every field filled, as ResolveContactConfig
 * returns it). Read field by field; nullopt when `given` is not one: not an object, a preset outside the table,
 * a shape of neither kind, or any field missing or of the wrong type (contact-session.ts isPolicy, plus every
 * field it then reads).
 */
GENEX_CORE_API std::optional<ContactPolicy> ParseContactPolicy(const Json& given);

}  // namespace genex::contact
