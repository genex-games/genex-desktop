// `config.contacts` resolution (GenexCore/GenexContactConfig.h): a port of contact-config.ts, in its order, so a
// declaration with several bad values is refused by the same path.
#include "GenexCore/GenexContactConfig.h"

#include <cmath>
#include <cstring>
#include <limits>
#include <set>
#include <string>
#include <utility>

namespace genex::contact {
namespace {

/** A refusal in flight: the path of the first bad value. */
struct Refusal {
  std::string path;
};

using Opt = std::optional<Refusal>;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

SlideRule Slide(double speed, std::optional<double> step, double share) {
  SlideRule s;
  s.speed = speed;
  s.step = step;
  s.share = share;
  return s;
}

TopRule SlideTop(const SlideRule& s) {
  TopRule t;
  t.policy = TopPolicy::Slide;
  t.slide = s;
  return t;
}

/** A stand: carried by the lower seat when `ride`, a landing within `center` of its half width (none: anywhere). */
TopRule StandTop(bool ride, std::optional<double> center, const SlideRule& slide) {
  TopRule t;
  t.policy = TopPolicy::Stand;
  t.ride = ride;
  t.center = center;
  t.slide = slide;
  return t;
}

/** A shooter's character slide: 300 u/s clears a 32 u hull in about 110 ms. */
const SlideRule kCharacterSlide = Slide(300, 150, 1);
/** A vehicle's roof slide: car-ball's ROOF_SLIDE 950 by ROOF_SLIDE_STEP 480, all on the upper car. */
const SlideRule kVehicleSlide = Slide(950, 480, 1);
/** car-ball's tilted pairs: 600 u/s at once, half each. */
const SlideRule kArenaOffWall = Slide(600, std::nullopt, 0.5);
/** The share of a head's half width a shooter's landing stands within (0.25, owner 2026-11-02: a landing with
 *  over 3/8 of the foot off the head slides). */
constexpr double kShooterCenter = 0.25;
/** A prop's slide off a head (the character slide's numbers). */
const PropSlide kPropSlide{300, 150};

TopRule StompTop() {
  TopRule t;
  t.policy = TopPolicy::Bounce;
  t.stompMin = 150;
  t.bounceSpeed = 450;
  t.jumpBoost = 150;
  t.slide = kCharacterSlide;
  return t;
}

/** One preset's table: the top rule by seat shape, the side restitution and the passes. */
struct PresetTable {
  const char* name;
  TopRule character;
  TopRule vehicle;
  double restitution;
  int passes;
  SlideRule vehicleOffWall;
  bool stopSpin;
  ContactDrawing drawing;
  ContactPush push;
  HeadFriction headFriction;
};

const std::vector<PresetTable>& Presets() {
  static const std::vector<PresetTable> table = {
      {"shooter", StandTop(false, kShooterCenter, kCharacterSlide), SlideTop(kVehicleSlide), 0, 16, kVehicleSlide, false,
       ContactDrawing::Separate, ContactPush::Mover, HeadFriction::Slide},
      {"platformer", StandTop(true, std::nullopt, kCharacterSlide), SlideTop(kVehicleSlide), 0, 16, kVehicleSlide, false,
       ContactDrawing::Separate, ContactPush::Mover, HeadFriction::Slide},
      {"vehicle-arena", SlideTop(kCharacterSlide), SlideTop(kVehicleSlide), 0.6, 32, kArenaOffWall, true,
       ContactDrawing::Predicted, ContactPush::Shared, HeadFriction::Carry},
      {"physics-sandbox", StandTop(true, std::nullopt, kCharacterSlide), StandTop(true, std::nullopt, kVehicleSlide), 0.2, 16,
       kVehicleSlide, false, ContactDrawing::Separate, ContactPush::Shared, HeadFriction::Carry},
      {"party", StandTop(true, std::nullopt, kCharacterSlide), SlideTop(kVehicleSlide), 0.3, 16, kVehicleSlide, false,
       ContactDrawing::Separate, ContactPush::Shared, HeadFriction::Slide},
  };
  return table;
}

const PresetTable* PresetNamed(const std::string& name) {
  for (const PresetTable& p : Presets()) {
    if (name == p.name) return &p;
  }
  return nullptr;
}

using Keys = std::set<std::string>;

const Keys& RootKeys() {
  static const Keys k = {"preset", "shape", "top", "offWall", "restitution", "passes", "slop", "supportCos", "entrySpeed",
                         "entryWindow", "roofSkin", "maxVelocity", "stopSpin", "pairs", "drawing", "push", "headFriction", "propSlide"};
  return k;
}
const Keys& SlideKeys() {
  static const Keys k = {"speed", "step", "share"};
  return k;
}
const Keys& TopKeysOf(TopPolicy p) {
  static const Keys stand = {"policy", "ride", "center", "slide"};
  static const Keys ghost = {"policy"};
  static const Keys slide = {"policy", "speed", "step", "share"};
  static const Keys bounce = {"policy", "stompMin", "bounceSpeed", "jumpBoost"};
  if (p == TopPolicy::Slide) return slide;
  if (p == TopPolicy::Bounce) return bounce;
  return p == TopPolicy::Stand ? stand : ghost;
}

/** Refuses the first key of `o` outside `keys`. */
Opt OnlyKeys(const Json& o, const Keys& keys, const std::string& path) {
  for (const JsonMember& m : o.Members()) {
    if (keys.count(m.key) == 0) return Refusal{path + "." + m.key};
  }
  return std::nullopt;
}

/** A number in [lo, hi] (`open`: above lo), or the default when absent. */
Opt Num(const Json& o, const char* key, const std::string& path, double fallback, double lo, double hi, bool open, double* out) {
  const Json* v = o.Find(key);
  if (v == nullptr) {
    *out = fallback;
    return std::nullopt;
  }
  const double n = v->IsNumber() ? v->AsNumber() : kNaN;
  const bool low = open ? n > lo : n >= lo;
  if (!v->IsNumber() || !std::isfinite(n) || !low || n > hi) return Refusal{path + "." + key};
  *out = n;
  return std::nullopt;
}

/** A preset parameter, or `fallback` when absent or not a number. */
double Param(const ContactPresetParams& p, const char* key, bool* present = nullptr) {
  const Json* v = p.params == nullptr ? nullptr : p.params->Find(key);
  const bool ok = v != nullptr && v->IsNumber();
  if (present != nullptr) *present = ok;
  return ok ? v->AsNumber() : 0.0;
}

/** A slide's settings over `base`. */
Opt SlideOf(const Json& v, const std::string& path, const SlideRule& base, const Keys& keys, SlideRule* out) {
  if (!v.IsObject()) return Refusal{path};
  if (Opt r = OnlyKeys(v, keys, path)) return r;
  double speed = 0;
  if (Opt r = Num(v, "speed", path, base.speed, 0, kContactValueMax, false, &speed)) return r;
  const Json* stepJson = v.Find("step");
  std::optional<double> step;
  if (stepJson != nullptr && stepJson->IsNull()) {
    step = std::nullopt;
  } else {
    double s = 0;
    if (Opt r = Num(v, "step", path, base.step.has_value() ? *base.step : kContactValueMax, 0, kContactValueMax, true, &s)) return r;
    step = stepJson == nullptr ? base.step : std::optional<double>(s);
  }
  double share = 0;
  if (Opt r = Num(v, "share", path, base.share, 0, 1, false, &share)) return r;
  out->speed = speed;
  out->step = step;
  out->share = share;
  return std::nullopt;
}

/** The default slide a bounce falls back to and an explicit slide starts from, by shape. */
SlideRule BaseSlide(const TopRule& top, bool vehicle) {
  if (top.policy == TopPolicy::Slide) return top.slide;
  if (top.policy == TopPolicy::Bounce || top.policy == TopPolicy::Stand) return top.slide;
  return vehicle ? kVehicleSlide : kCharacterSlide;
}

bool TopPolicyFromName(const std::string& name, TopPolicy* out) {
  static const std::pair<const char*, TopPolicy> names[] = {
      {"stand", TopPolicy::Stand}, {"slide", TopPolicy::Slide}, {"bounce", TopPolicy::Bounce}, {"ghost", TopPolicy::Ghost}};
  for (const auto& n : names) {
    if (name == n.first) {
      *out = n.second;
      return true;
    }
  }
  return false;
}

/** A stand as the module gives it: each cell it leaves out from the preset's stand (`base`), else ride, anywhere,
 *  and the shape's slide. `center` is in (0, 1] or null. */
Opt StandOf(const Json& v, const std::string& path, const TopRule& base, bool vehicle, TopRule* out) {
  const TopRule from = base.policy == TopPolicy::Stand ? base : StandTop(true, std::nullopt, BaseSlide(base, vehicle));
  const Json* rideJson = v.Find("ride");
  if (rideJson != nullptr && !rideJson->IsBool()) return Refusal{path + ".ride"};
  const bool ride = rideJson != nullptr ? rideJson->AsBool() : from.ride;
  std::optional<double> center = from.center;
  if (const Json* c = v.Find("center")) {
    if (c->IsNull()) {
      center = std::nullopt;
    } else {
      double n = 0;
      if (Opt r = Num(v, "center", path, 1, 0, 1, true, &n)) return r;
      center = n;
    }
  }
  SlideRule slide = from.slide;
  if (const Json* s = v.Find("slide")) {
    if (Opt r = SlideOf(*s, path + ".slide", from.slide, SlideKeys(), &slide)) return r;
  }
  *out = StandTop(ride, center, slide);
  return std::nullopt;
}

/** A top rule as the module gives it, over the preset's `base` for this shape. */
Opt TopOf(const Json* v, const std::string& path, const TopRule& base, bool vehicle, TopRule* out) {
  if (v == nullptr || !v->IsObject()) return Refusal{path};
  const Json* policyJson = v->Find("policy");
  TopPolicy p = TopPolicy::Stand;
  if (policyJson == nullptr || !policyJson->IsString() || !TopPolicyFromName(policyJson->AsString(), &p)) {
    return Refusal{path + ".policy"};
  }
  if (Opt r = OnlyKeys(*v, TopKeysOf(p), path)) return r;
  TopRule t;
  t.policy = p;
  if (p == TopPolicy::Stand) return StandOf(*v, path, base, vehicle, out);
  if (p == TopPolicy::Ghost) {
    *out = t;
    return std::nullopt;
  }
  if (p == TopPolicy::Slide) {
    if (Opt r = SlideOf(*v, path, BaseSlide(base, vehicle), TopKeysOf(p), &t.slide)) return r;
    *out = t;
    return std::nullopt;
  }
  const TopRule stomp = base.policy == TopPolicy::Bounce ? base : StompTop();
  if (Opt r = Num(*v, "stompMin", path, stomp.stompMin, 0, kContactValueMax, false, &t.stompMin)) return r;
  if (Opt r = Num(*v, "bounceSpeed", path, stomp.bounceSpeed, 0, kContactValueMax, false, &t.bounceSpeed)) return r;
  if (Opt r = Num(*v, "jumpBoost", path, stomp.jumpBoost, 0, kContactValueMax, false, &t.jumpBoost)) return r;
  t.slide = BaseSlide(base, vehicle);
  *out = t;
  return std::nullopt;
}

/** The seats' contact shape: the module's, else the movement preset's hull (a box over a vehicle's). */
Opt ShapeOf(const Json* v, const std::string& path, const ContactPresetParams& preset, ContactShape* out) {
  ContactShape s;
  if (v == nullptr) {
    if (preset.name == "vehicle") {
      s.kind = ContactShapeKind::Box;
      s.length = 2 * Param(preset, "radius");
      s.width = 2 * Param(preset, "radius");
      s.top = Param(preset, "height");
    } else {
      s.kind = ContactShapeKind::Hull;
      s.radius = Param(preset, "radius");
      bool hasStand = false;
      const double stand = Param(preset, "standHeight", &hasStand);
      s.height = hasStand ? stand : Param(preset, "height");
    }
    *out = s;
    return std::nullopt;
  }
  if (!v->IsObject()) return Refusal{path};
  const Json* kind = v->Find("kind");
  const bool isBox = kind != nullptr && kind->IsString() && kind->AsString() == "box";
  const bool isHull = kind != nullptr && kind->IsString() && kind->AsString() == "hull";
  if (isBox) {
    static const Keys keys = {"kind", "length", "width", "top"};
    if (Opt r = OnlyKeys(*v, keys, path)) return r;
    s.kind = ContactShapeKind::Box;
    if (Opt r = Num(*v, "length", path, kNaN, 0, kContactValueMax, true, &s.length)) return r;
    if (Opt r = Num(*v, "width", path, kNaN, 0, kContactValueMax, true, &s.width)) return r;
    if (Opt r = Num(*v, "top", path, kNaN, 0, kContactValueMax, true, &s.top)) return r;
    if (std::isnan(s.length)) return Refusal{path + ".length"};
    if (std::isnan(s.width)) return Refusal{path + ".width"};
    if (std::isnan(s.top)) return Refusal{path + ".top"};
  } else if (isHull) {
    static const Keys keys = {"kind", "radius", "height"};
    if (Opt r = OnlyKeys(*v, keys, path)) return r;
    s.kind = ContactShapeKind::Hull;
    if (Opt r = Num(*v, "radius", path, kNaN, 0, kContactValueMax, true, &s.radius)) return r;
    if (Opt r = Num(*v, "height", path, kNaN, 0, kContactValueMax, true, &s.height)) return r;
    if (std::isnan(s.radius)) return Refusal{path + ".radius"};
    if (std::isnan(s.height)) return Refusal{path + ".height"};
  } else {
    return Refusal{path + ".kind"};
  }
  *out = s;
  return std::nullopt;
}

/** The per-pair overrides. */
Opt PairsOf(const Json* v, const std::string& path, const TopRule& base, bool vehicle, std::vector<PairRule>* out) {
  if (v == nullptr) return std::nullopt;
  if (!v->IsArray() || v->Size() > kContactPairsMax) return Refusal{path};
  for (std::size_t i = 0; i < v->Size(); ++i) {
    const std::string at = path + "[" + std::to_string(i) + "]";
    const Json& r = v->At(i);
    if (!r.IsObject()) return Refusal{at};
    static const Keys keys = {"a", "b", "top"};
    if (Opt e = OnlyKeys(r, keys, at)) return e;
    PairRule rule;
    for (const char* k : {"a", "b"}) {
      const Json* tag = r.Find(k);
      if (tag == nullptr || !tag->IsString() || tag->AsString().empty() || tag->AsString().size() > kContactTagMax) {
        return Refusal{at + "." + k};
      }
      (std::strcmp(k, "a") == 0 ? rule.a : rule.b) = tag->AsString();
    }
    if (Opt e = TopOf(r.Find("top"), at + ".top", base, vehicle, &rule.top)) return e;
    out->push_back(std::move(rule));
  }
  return std::nullopt;
}

}  // namespace

const char* ContactDrawingName(ContactDrawing d) {
  if (d == ContactDrawing::Predicted) return "predicted";
  if (d == ContactDrawing::Timeline) return "timeline";
  return "separate";
}

const char* ContactPushName(ContactPush p) { return p == ContactPush::Mover ? "mover" : "shared"; }

const char* HeadFrictionName(HeadFriction h) { return h == HeadFriction::Carry ? "carry" : "slide"; }

const char* TopPolicyName(TopPolicy p) {
  if (p == TopPolicy::Slide) return "slide";
  if (p == TopPolicy::Bounce) return "bounce";
  if (p == TopPolicy::Ghost) return "ghost";
  return "stand";
}

namespace {

/** The rest of the declaration after its preset, shape and top: the numbers, the pairs and the enums. */
Opt ResolveRest(const Json& given, const std::string& path, const PresetTable& table, bool vehicle, const TopRule& base,
                ContactPolicy* policy) {
  double v = 0;
  if (Opt r = Num(given, "supportCos", path, 0.7, 0, 1, false, &policy->supportCos)) return r;
  if (Opt r = Num(given, "entrySpeed", path, 1, 0, kContactValueMax, true, &policy->entrySpeed)) return r;
  if (Opt r = Num(given, "entryWindow", path, 1.0 / 60, 0, 1, true, &policy->entryWindow)) return r;
  if (Opt r = Num(given, "restitution", path, table.restitution, 0, 1, false, &policy->restitution)) return r;
  if (Opt r = Num(given, "passes", path, table.passes, 1, kContactPassesMax, false, &v)) return r;
  if (v != std::floor(v)) return Refusal{path + ".passes"};
  policy->passes = static_cast<int>(v);
  if (Opt r = Num(given, "slop", path, 0.1, 0, kContactValueMax, false, &policy->slop)) return r;
  if (Opt r = Num(given, "roofSkin", path, 0.01, 0, kContactValueMax, false, &policy->roofSkin)) return r;
  const Json* stop = given.Find("stopSpin");
  policy->stopSpin = stop != nullptr ? stop->AsBool() : table.stopSpin;
  const SlideRule offBase = vehicle ? table.vehicleOffWall : BaseSlide(base, false);
  const Json* off = given.Find("offWall");
  policy->offWall = offBase;
  if (off != nullptr) {
    if (Opt r = SlideOf(*off, path + ".offWall", offBase, SlideKeys(), &policy->offWall)) return r;
  }
  if (Opt r = PairsOf(given.Find("pairs"), path + ".pairs", base, vehicle, &policy->pairs)) return r;
  policy->drawing = table.drawing;
  if (const Json* d = given.Find("drawing")) {
    const std::string s = d->IsString() ? d->AsString() : std::string();
    if (s == "predicted") policy->drawing = ContactDrawing::Predicted;
    else if (s == "separate") policy->drawing = ContactDrawing::Separate;
    else if (s == "timeline") policy->drawing = ContactDrawing::Timeline;
    else return Refusal{path + ".drawing"};
  }
  policy->push = table.push;
  if (const Json* p = given.Find("push")) {
    const std::string s = p->IsString() ? p->AsString() : std::string();
    if (s == "shared") policy->push = ContactPush::Shared;
    else if (s == "mover") policy->push = ContactPush::Mover;
    else return Refusal{path + ".push"};
  }
  policy->headFriction = table.headFriction;
  if (const Json* h = given.Find("headFriction")) {
    const std::string s = h->IsString() ? h->AsString() : std::string();
    if (s == "slide") policy->headFriction = HeadFriction::Slide;
    else if (s == "carry") policy->headFriction = HeadFriction::Carry;
    else return Refusal{path + ".headFriction"};
  }
  policy->propSlide = kPropSlide;
  if (const Json* ps = given.Find("propSlide")) {
    const std::string at = path + ".propSlide";
    if (!ps->IsObject()) return Refusal{at};
    static const Keys keys = {"speed", "step"};
    if (Opt r = OnlyKeys(*ps, keys, at)) return r;
    if (Opt r = Num(*ps, "speed", at, kPropSlide.speed, 0, kContactValueMax, false, &policy->propSlide.speed)) return r;
    if (Opt r = Num(*ps, "step", at, kPropSlide.step, 0, kContactValueMax, true, &policy->propSlide.step)) return r;
  }
  return std::nullopt;
}

}  // namespace

std::optional<ContactPolicy> ResolveContactConfig(const Json& given, const ContactPresetParams* preset,
                                                 std::string* refusedPath, const std::string& path) {
  const auto refuse = [refusedPath](const Refusal& r) -> std::optional<ContactPolicy> {
    if (refusedPath != nullptr) *refusedPath = r.path;
    return std::nullopt;
  };
  if (!given.IsObject()) return refuse(Refusal{path});
  if (Opt r = OnlyKeys(given, RootKeys(), path)) return refuse(*r);
  if (preset == nullptr || (preset->name != "firstperson" && preset->name != "vehicle")) return refuse(Refusal{path});
  const Json* name = given.Find("preset");
  const PresetTable* table = name != nullptr && name->IsString() ? PresetNamed(name->AsString()) : nullptr;
  if (table == nullptr) return refuse(Refusal{path + ".preset"});
  ContactPolicy policy;
  policy.preset = table->name;
  if (Opt r = ShapeOf(given.Find("shape"), path + ".shape", *preset, &policy.shape)) return refuse(*r);
  const bool vehicle = policy.shape.kind == ContactShapeKind::Box;
  const TopRule base = vehicle ? table->vehicle : table->character;
  policy.top = base;
  if (const Json* top = given.Find("top")) {
    if (Opt r = TopOf(top, path + ".top", base, vehicle, &policy.top)) return refuse(*r);
  }
  double maxVelocity = 0;
  const Json* mv = given.Find("maxVelocity");
  bool hasPresetMax = false;
  const double presetMax = Param(*preset, "maxVelocity", &hasPresetMax);
  if (mv != nullptr && mv->IsNull()) {
    policy.maxVelocity = std::nullopt;
  } else {
    if (Opt r = Num(given, "maxVelocity", path, hasPresetMax ? presetMax : kContactValueMax, 0, kContactValueMax, true, &maxVelocity)) {
      return refuse(*r);
    }
    policy.maxVelocity = maxVelocity;
  }
  const Json* stop = given.Find("stopSpin");
  if (stop != nullptr && !stop->IsBool()) return refuse(Refusal{path + ".stopSpin"});
  bool hasStand = false;
  const double stand = Param(*preset, "standHeight", &hasStand);
  policy.hull.radius = Param(*preset, "radius");
  policy.hull.height = hasStand ? stand : Param(*preset, "height");
  policy.hull.skin = Param(*preset, "skin");
  policy.groundTrace = Param(*preset, "groundTrace");
  if (Opt r = ResolveRest(given, path, *table, vehicle, base, &policy)) return refuse(*r);
  return policy;
}

namespace {

/** `o[key]` when it is a number. */
std::optional<double> NumberAt(const Json& o, const char* key) {
  const Json* v = o.Find(key);
  if (v == nullptr || !v->IsNumber()) return std::nullopt;
  return v->AsNumber();
}

/** A resolved slide `{speed, step, share}` (`step` a number or null). */
std::optional<SlideRule> SlideAt(const Json* o) {
  if (o == nullptr || !o->IsObject()) return std::nullopt;
  const std::optional<double> speed = NumberAt(*o, "speed");
  const std::optional<double> share = NumberAt(*o, "share");
  const Json* step = o->Find("step");
  if (!speed || !share || step == nullptr || !(step->IsNull() || step->IsNumber())) return std::nullopt;
  SlideRule out;
  out.speed = *speed;
  out.share = *share;
  if (step->IsNumber()) out.step = step->AsNumber();
  return out;
}

/** A resolved top rule: `stand` or `ghost` alone, `slide` with its slide's fields, `bounce` with its stomp
 *  settings and the `slide` it falls back to. */
std::optional<TopRule> TopAt(const Json* o) {
  if (o == nullptr || !o->IsObject()) return std::nullopt;
  const Json* policy = o->Find("policy");
  if (policy == nullptr || !policy->IsString()) return std::nullopt;
  const std::string& name = policy->AsString();
  TopRule out;
  if (name == "ghost") {
    out.policy = TopPolicy::Ghost;
    return out;
  }
  if (name == "stand") {
    // A host that predates the stand's cells publishes `{ policy: 'stand' }`: it rode, anywhere.
    out = StandTop(true, std::nullopt, kCharacterSlide);
    if (const Json* ride = o->Find("ride")) {
      if (!ride->IsBool()) return std::nullopt;
      out.ride = ride->AsBool();
    }
    if (const Json* center = o->Find("center")) {
      if (center->IsNumber()) out.center = center->AsNumber();
      else if (!center->IsNull()) return std::nullopt;
    }
    if (const Json* slide = o->Find("slide")) {
      const std::optional<SlideRule> parsed = SlideAt(slide);
      if (!parsed) return std::nullopt;
      out.slide = *parsed;
    }
    return out;
  }
  if (name == "slide") {
    const std::optional<SlideRule> slide = SlideAt(o);
    if (!slide) return std::nullopt;
    out.policy = TopPolicy::Slide;
    out.slide = *slide;
    return out;
  }
  if (name != "bounce") return std::nullopt;
  const std::optional<double> stompMin = NumberAt(*o, "stompMin");
  const std::optional<double> bounceSpeed = NumberAt(*o, "bounceSpeed");
  const std::optional<double> jumpBoost = NumberAt(*o, "jumpBoost");
  const std::optional<SlideRule> slide = SlideAt(o->Find("slide"));
  if (!stompMin || !bounceSpeed || !jumpBoost || !slide) return std::nullopt;
  out.policy = TopPolicy::Bounce;
  out.stompMin = *stompMin;
  out.bounceSpeed = *bounceSpeed;
  out.jumpBoost = *jumpBoost;
  out.slide = *slide;
  return out;
}

/** A resolved shape: a box's length, width and top, or a hull's radius and height. */
std::optional<ContactShape> ShapeAt(const Json* o) {
  if (o == nullptr || !o->IsObject()) return std::nullopt;
  const Json* kind = o->Find("kind");
  if (kind == nullptr || !kind->IsString()) return std::nullopt;
  ContactShape out;
  if (kind->AsString() == "box") {
    const std::optional<double> length = NumberAt(*o, "length");
    const std::optional<double> width = NumberAt(*o, "width");
    const std::optional<double> top = NumberAt(*o, "top");
    if (!length || !width || !top) return std::nullopt;
    out.kind = ContactShapeKind::Box;
    out.length = *length;
    out.width = *width;
    out.top = *top;
    return out;
  }
  if (kind->AsString() != "hull") return std::nullopt;
  const std::optional<double> radius = NumberAt(*o, "radius");
  const std::optional<double> height = NumberAt(*o, "height");
  if (!radius || !height) return std::nullopt;
  out.kind = ContactShapeKind::Hull;
  out.radius = *radius;
  out.height = *height;
  return out;
}

/** The resolved per-pair overrides `[{a, b, top}]`. */
std::optional<std::vector<PairRule>> PairsAt(const Json* o) {
  if (o == nullptr || !o->IsArray()) return std::nullopt;
  std::vector<PairRule> out;
  for (const Json& row : o->Items()) {
    const Json* a = row.IsObject() ? row.Find("a") : nullptr;
    const Json* b = row.IsObject() ? row.Find("b") : nullptr;
    const std::optional<TopRule> top = row.IsObject() ? TopAt(row.Find("top")) : std::nullopt;
    if (a == nullptr || b == nullptr || !a->IsString() || !b->IsString() || !top) return std::nullopt;
    out.push_back(PairRule{a->AsString(), b->AsString(), *top});
  }
  return out;
}

/** The policy's plain numbers, in the resolved policy's order. */
bool NumbersAt(const Json& o, ContactPolicy& p) {
  const std::pair<const char*, double*> fields[] = {{"groundTrace", &p.groundTrace}, {"supportCos", &p.supportCos},
                                                   {"entrySpeed", &p.entrySpeed},   {"entryWindow", &p.entryWindow},
                                                   {"restitution", &p.restitution}, {"slop", &p.slop},
                                                   {"roofSkin", &p.roofSkin}};
  for (const auto& f : fields) {
    const std::optional<double> v = NumberAt(o, f.first);
    if (!v) return false;
    *f.second = *v;
  }
  const std::optional<double> passes = NumberAt(o, "passes");
  if (!passes || *passes != std::floor(*passes)) return false;
  p.passes = static_cast<int>(*passes);
  const Json* mv = o.Find("maxVelocity");
  if (mv == nullptr || !(mv->IsNull() || mv->IsNumber())) return false;
  if (mv->IsNumber()) p.maxVelocity = mv->AsNumber();
  return true;
}

/** The hull the world is grown by. */
std::optional<ContactHull> HullAt(const Json* o) {
  if (o == nullptr || !o->IsObject()) return std::nullopt;
  const std::optional<double> radius = NumberAt(*o, "radius");
  const std::optional<double> height = NumberAt(*o, "height");
  const std::optional<double> skin = NumberAt(*o, "skin");
  if (!radius || !height || !skin) return std::nullopt;
  return ContactHull{*radius, *height, *skin};
}

/** A drawing or a push by its wire spelling. */
std::optional<ContactDrawing> DrawingAt(const Json* o) {
  if (o == nullptr || !o->IsString()) return std::nullopt;
  for (const ContactDrawing d : {ContactDrawing::Predicted, ContactDrawing::Separate, ContactDrawing::Timeline}) {
    if (o->AsString() == ContactDrawingName(d)) return d;
  }
  return std::nullopt;
}

std::optional<ContactPush> PushAt(const Json* o) {
  if (o == nullptr || !o->IsString()) return std::nullopt;
  for (const ContactPush p : {ContactPush::Shared, ContactPush::Mover}) {
    if (o->AsString() == ContactPushName(p)) return p;
  }
  return std::nullopt;
}

}  // namespace

std::optional<ContactPolicy> ParseContactPolicy(const Json& given) {
  if (!given.IsObject()) return std::nullopt;
  const Json* preset = given.Find("preset");
  if (preset == nullptr || !preset->IsString() || PresetNamed(preset->AsString()) == nullptr) return std::nullopt;
  const std::optional<ContactShape> shape = ShapeAt(given.Find("shape"));
  const std::optional<ContactHull> hull = HullAt(given.Find("hull"));
  const std::optional<TopRule> top = TopAt(given.Find("top"));
  const std::optional<SlideRule> offWall = SlideAt(given.Find("offWall"));
  const std::optional<std::vector<PairRule>> pairs = PairsAt(given.Find("pairs"));
  const std::optional<ContactDrawing> drawing = DrawingAt(given.Find("drawing"));
  const std::optional<ContactPush> push = PushAt(given.Find("push"));
  const Json* stopSpin = given.Find("stopSpin");
  const bool parts = shape && hull && top && offWall && pairs && drawing && push;
  if (!parts || stopSpin == nullptr || !stopSpin->IsBool()) return std::nullopt;
  ContactPolicy out;
  if (!NumbersAt(given, out)) return std::nullopt;
  out.preset = preset->AsString();
  out.shape = *shape;
  out.hull = *hull;
  out.top = *top;
  out.offWall = *offWall;
  out.pairs = *pairs;
  out.drawing = *drawing;
  out.push = *push;
  out.stopSpin = stopSpin->AsBool();
  out.headFriction = PresetNamed(out.preset)->headFriction;
  if (const Json* h = given.Find("headFriction")) {
    if (!h->IsString() || (h->AsString() != "slide" && h->AsString() != "carry")) return std::nullopt;
    out.headFriction = h->AsString() == "carry" ? HeadFriction::Carry : HeadFriction::Slide;
  }
  if (const Json* ps = given.Find("propSlide")) {
    const std::optional<double> speed = ps->IsObject() ? NumberAt(*ps, "speed") : std::nullopt;
    const std::optional<double> step = ps->IsObject() ? NumberAt(*ps, "step") : std::nullopt;
    if (!speed || !step) return std::nullopt;
    out.propSlide = PropSlide{*speed, *step};
  }
  return out;
}

}  // namespace genex::contact
