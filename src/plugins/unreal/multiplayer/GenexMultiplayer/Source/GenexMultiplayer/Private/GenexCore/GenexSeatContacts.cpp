// Seat contacts (PROTOCOL.md §17.11 *Seat contacts*): see GenexSeatContacts.h. Follows
// packages/multiplayer/src/authority/seat-contacts.ts in its order of operations, unfused.
#include "GenexCore/GenexSeatContacts.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <map>
#include <utility>

GENEX_FP_STRICT_BEGIN

namespace genex::seat_contacts_detail {

/** Doubles past this round to ±Infinity as float32 (FLT_MAX plus half its ulp: a tie, to even). */
constexpr double kFroundInfinity = 3.4028235677973366e38;

/** Math.fround: a static_cast<float> where it is defined (NaN kept), ±Infinity past float32's range. */
double Fround(double v) {
  if (std::isnan(v)) return v;
  if (v >= kFroundInfinity) return HUGE_VAL;
  if (v <= -kFroundInfinity) return -HUGE_VAL;
  return static_cast<double>(static_cast<float>(v));
}

/** Two numbers as JSON.stringify writes them are the same text: equal (+0 and −0 alike), or both not
 *  finite (JSON writes NaN and ±Infinity as null). */
bool SameText(double a, double b) { return a == b || (!std::isfinite(a) && !std::isfinite(b)); }

/** Whether the rule left `b` as `a` was, as the TypeScript's JSON text comparison judges it. */
bool SameBody(const ContactBody& a, const ContactBody& b) {
  return a.id == b.id && SameText(a.x, b.x) && SameText(a.y, b.y) && SameText(a.z, b.z) && SameText(a.vx, b.vx) &&
         SameText(a.vy, b.vy) && SameText(a.vz, b.vz) && SameText(a.yaw, b.yaw) && SameText(a.spin, b.spin);
}

/** `own[field] = fround(mine[field])` when `mine[field] !== own[field]` (a NaN always is written). */
void WriteBack(double mine, double& own) {
  if (mine != own) own = Fround(mine);
}

}  // namespace genex::seat_contacts_detail

namespace genex {

namespace scd = ::genex::seat_contacts_detail;

SeatContacts::SeatContacts(ContactRule rule, std::function<std::vector<ContactBody>()> others)
    : rule_(std::move(rule)), others_(std::move(others)) {}

void SeatContacts::Apply(double seq, double ack, ContactBody& own, double tickHz) {
  if (!rule_) return;
  const bool fresh = !hasPass_ || passAck_ != ack || seq <= passLast_;
  if (fresh) {
    hasPass_ = true;
    passAck_ = ack;
    passLast_ = ack;
    pass_.clear();
    if (others_) {
      for (const ContactBody& body : others_()) pass_.push_back(Other{body, 0.0});
    }
    std::stable_sort(pass_.begin(), pass_.end(), [](const Other& a, const Other& b) { return a.body.id < b.body.id; });
  }
  const double j = seq - ack;
  ContactBody mine = own;
  for (Other& o : pass_) {
    const double k = (j - o.from) / tickHz;
    const ContactBody& b = o.body;
    ContactBody other = b;
    other.x = b.x + b.vx * k;
    other.y = b.y + b.vy * k;
    other.z = b.z + b.vz * k;
    const ContactBody before = other;
    if (mine.id < other.id) {
      rule_(mine, other);
    } else {
      rule_(other, mine);
    }
    if (!scd::SameBody(other, before)) {
      o.body = std::move(other);
      o.from = j;
    }
  }
  scd::WriteBack(mine.x, own.x);
  scd::WriteBack(mine.y, own.y);
  scd::WriteBack(mine.z, own.z);
  scd::WriteBack(mine.vx, own.vx);
  scd::WriteBack(mine.vy, own.vy);
  scd::WriteBack(mine.vz, own.vz);
  scd::WriteBack(mine.yaw, own.yaw);
  scd::WriteBack(mine.spin, own.spin);
  passLast_ = seq;
}

}  // namespace genex

namespace genex {
namespace separate_detail {

/** §17.11 *Drawing other seats* (seat-contacts.ts): a seat going round your entity turns at least this
 *  fast about its centre (rad/s), and as fast as its own pose moves past yours times kRoundPerStraight. */
constexpr double kPi = 3.141592653589793;
constexpr double kSeatRoundRate = 3 * kPi;
constexpr double kRoundPerStraight = kPi / 2;
/** A straight move crosses your entity when a point on it is pushed out by more than this share of the
 *  shorter of the move and the seat's distance from your centre, or by more than kCrossDepth units (a long
 *  move: a seat let go a long way from its own pose jumps back to it, and 5% of a 250 u jump let it graze
 *  your car's corner 12 u deep). */
constexpr double kCrossShare = 0.05;
constexpr double kCrossDepth = 8;
/** Points sampled on that move. */
constexpr int kCrossSamples = 16;
/** Halvings of the search for where a seat stops touching yours along a heading, and how often it may
 *  double its reach first. */
constexpr int kClearHalvings = 30;
constexpr int kClearDoublings = 8;
constexpr double kTwoPi = 2 * kPi;

/** JavaScript's Math.min of two (NaN when either is). */
double JsMinOf(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::nan("");
  return a < b ? a : b;
}

/** How far the rule pushes the seat at offset (dx, dy, dz) from your entity, at rest, out of it. */
double PushAt(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, double dx, double dy, double dz) {
  ContactBody placed = seat;
  placed.x = you.x + dx;
  placed.y = you.y + dy;
  placed.z = you.z + dz;
  placed.vx = placed.vy = placed.vz = 0.0;
  const SeatDrawn out = SeparateDrawn(rule, you, placed);
  return std::hypot(out.x - placed.x, out.y - placed.y, out.z - placed.z);
}

/** Whether the straight move from offset `from` to (tdx, tdy, tdz) goes through your entity. */
bool Crosses(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, const SeatSide& from, double tdx,
             double tdy, double tdz) {
  const double length = std::hypot(tdx - from.dx, tdy - from.dy, tdz - from.dz);
  const double reach = (std::min)(length, std::hypot(from.dx, from.dy, from.dz));
  if (reach == 0.0) return false;
  for (int k = 1; k < kCrossSamples; ++k) {
    const double s = static_cast<double>(k) / kCrossSamples;
    const double push = PushAt(rule, you, seat, from.dx + (tdx - from.dx) * s, from.dy + (tdy - from.dy) * s, from.dz + (tdz - from.dz) * s);
    if (push > JsMinOf(kCrossShare * reach, kCrossDepth)) return true;
  }
  return false;
}

/** The nearest distance from your entity's centre along heading `angle`, at height `dz`, where the seat
 *  no longer touches it (searched from `reach`; 0 when it touches nowhere along the heading). */
double ClearAlong(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, double angle, double dz, double reach) {
  const double c = std::cos(angle);
  const double s = std::sin(angle);
  const auto touches = [&](double r) { return PushAt(rule, you, seat, r * c, r * s, dz) > 0.0; };
  if (!touches(0.0) || reach <= 0.0) return 0.0;
  double lo = 0.0;
  double hi = reach;
  for (int i = 0; i < kClearDoublings && touches(hi); ++i) {
    lo = hi;
    hi *= 2;
  }
  for (int i = 0; i < kClearHalvings; ++i) {
    const double mid = (lo + hi) / 2;
    if (touches(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/** An angle difference in [-pi, pi). */
double TurnOf(double v) { return v - kTwoPi * std::floor((v + kPi) / kTwoPi); }

/** JavaScript's Math.sign (NaN for NaN, a zero for a zero). */
double SignOf(double v) {
  if (v > 0) return 1.0;
  if (v < 0) return -1.0;
  return v;
}

/** JavaScript's Math.max of two (NaN when either is). */
double JsMax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::nan("");
  return a > b ? a : b;
}

/** JavaScript's Math.min of two (NaN when either is). */
double JsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::nan("");
  return a < b ? a : b;
}

SeatDrawn Draw(const ContactBody& you, double dx, double dy, double dz, bool held, double bx, double by, double now, SeatSide* side) {
  if (side != nullptr) *side = SeatSide{dx, dy, dz, held, bx, by, now, false, PairPush{}};
  return SeatDrawn{you.x + dx, you.y + dy, you.z + dz};
}

/** Pushes of SeparateDrawn at most, and the push left after the first under which it stops (units). */
constexpr int kSeparatePasses = 8;
constexpr double kSeparateSlop = 0.01;
/** The push the pushes may leave (units): more, and the seat goes on to where it stops touching (ClearOnward). */
constexpr double kSeparateLeft = 0.001;
/** Halvings of ClearOnward's search, how many times it may double its reach, and its least reach (units). */
constexpr int kOnwardHalvings = 30;
constexpr int kOnwardDoublings = 8;
constexpr double kClearOnwardMin = 1;
/** Halvings of the search for the least lift that takes a seat off yours (seat-contacts.ts LIFT_HALVINGS). */
constexpr int kLiftHalvings = 20;

/** seat-contacts.ts pushOf: the push the rule gives `seat` drawn at `p` off your entity, both at rest (its move less
 *  yours). */
SeatDrawn PushOf(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, const SeatDrawn& p) {
  ContactBody mine = you;
  mine.vx = mine.vy = mine.vz = 0.0;
  ContactBody other = seat;
  other.x = p.x;
  other.y = p.y;
  other.z = p.z;
  other.vx = other.vy = other.vz = 0.0;
  if (rule) {
    if (mine.id < other.id) {
      rule(mine, other);
    } else {
      rule(other, mine);
    }
  }
  return SeatDrawn{other.x - p.x - (mine.x - you.x), other.y - p.y - (mine.y - you.y), other.z - p.z - (mine.z - you.z)};
}

/** seat-contacts.ts pushedAt: how far the rule pushes `seat` drawn at `p` off your entity, both at rest. */
double PushedAt(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, const SeatDrawn& p) {
  const SeatDrawn v = PushOf(rule, you, seat, p);
  return std::hypot(v.x, v.y, v.z);
}

/** seat-contacts.ts clearOnward: the seat at `p`, left inside your entity by SeparateDrawn's pushes, moved on along
 *  the way they took it from its own pose (else along the push the rule gives it there) to the nearest distance where
 *  the rule no longer pushes it; `p` when no such distance is found. */
SeatDrawn ClearOnward(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, const SeatDrawn& p) {
  const SeatDrawn from{seat.x, seat.y, seat.z};
  const SeatDrawn moved{p.x - from.x, p.y - from.y, p.z - from.z};
  const SeatDrawn d = std::hypot(moved.x, moved.y, moved.z) > 0 ? moved : PushOf(rule, you, seat, from);
  const double len = std::hypot(d.x, d.y, d.z);
  if (len == 0) return p;
  const SeatDrawn u{d.x / len, d.y / len, d.z / len};
  const auto along = [&](double t) { return SeatDrawn{from.x + u.x * t, from.y + u.y * t, from.z + u.z * t}; };
  const auto touches = [&](double t) { return PushedAt(rule, you, seat, along(t)) > 0; };
  double lo = len;
  double hi = len + JsMax(kClearOnwardMin, len);
  for (int i = 0; i < kOnwardDoublings && touches(hi); ++i) {
    lo = hi;
    hi = len + (hi - len) * 2;
  }
  if (touches(hi)) return p;
  for (int i = 0; i < kOnwardHalvings; ++i) {
    const double mid = (lo + hi) / 2;
    if (touches(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return along(hi);
}

/** seat-contacts.ts liftOff: `seat` lifted off `you` along z (up when its base is at or above yours, else down) by the
 *  least amount up to SeatLiftMax that leaves the rule nothing to push, or `seat` itself when it does not touch you or
 *  no such lift does (it is beside you, not on you). */
ContactBody LiftOff(const ContactRule& rule, const ContactBody& you, const ContactBody& seat) {
  const double up = seat.z >= you.z ? 1.0 : -1.0;
  const auto touchesAt = [&](double k) { return PushAt(rule, you, seat, seat.x - you.x, seat.y - you.y, seat.z - you.z + up * k) > 0; };
  if (!touchesAt(0) || touchesAt(SeatLiftMax)) return seat;
  double lo = 0;
  double hi = SeatLiftMax;
  for (int i = 0; i < kLiftHalvings; ++i) {
    const double mid = (lo + hi) / 2;
    if (touchesAt(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  ContactBody out = seat;
  out.z = seat.z + up * hi;
  return out;
}

/** seat-contacts.ts settled: the seat at offset (dx, dy, dz) from your entity moved out of it by the rule's own push
 *  (SeparateDrawn) when it is still inside it there: a search or an easing along a ray at one height can end inside
 *  bodies laid on the band or a wall. A push of a float's worth (kSeparateLeft) is left as it is. */
SeatDrawn Settled(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, double dx, double dy, double dz) {
  ContactBody body = seat;
  body.x = you.x + dx;
  body.y = you.y + dy;
  body.z = you.z + dz;
  body.vx = body.vy = body.vz = 0.0;
  if (!(PushedAt(rule, you, body, SeatDrawn{body.x, body.y, body.z}) > kSeparateLeft)) return SeatDrawn{dx, dy, dz};
  const SeatDrawn out = SeparateDrawn(rule, you, body);
  return SeatDrawn{out.x - you.x, out.y - you.y, out.z - you.z};
}

/** Draw at an offset off the seat's own way (held), settled out of yours first. */
SeatDrawn DrawHeld(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, double dx, double dy, double dz, double bx,
                   double by, double now, SeatSide* side) {
  const SeatDrawn o = Settled(rule, you, seat, dx, dy, dz);
  return Draw(you, o.x, o.y, o.z, true, bx, by, now, side);
}

}  // namespace separate_detail

SeatDrawn SeparateDrawn(const ContactRule& rule, const ContactBody& you, const ContactBody& seat) {
  using namespace separate_detail;
  SeatDrawn p{seat.x, seat.y, seat.z};
  for (int pass = 0; pass < kSeparatePasses; ++pass) {
    ContactBody mine = you;
    mine.vx = mine.vy = mine.vz = 0.0;
    ContactBody other = seat;
    other.x = p.x;
    other.y = p.y;
    other.z = p.z;
    other.vx = other.vy = other.vz = 0.0;
    if (rule) {
      if (mine.id < other.id) {
        rule(mine, other);
      } else {
        rule(other, mine);
      }
    }
    const SeatDrawn next{p.x + (other.x - p.x) - (mine.x - you.x), p.y + (other.y - p.y) - (mine.y - you.y),
                         p.z + (other.z - p.z) - (mine.z - you.z)};
    if (pass > 0 && next.x == p.x && next.y == p.y && next.z == p.z) break;
    p = next;
    // A rule whose bodies keep their shape (two level cars) leaves them apart in one push; one whose bodies turn with
    // where they are (car-ball's, laid on the band or a wall) may leave a seat it pushed still a little inside yours.
    if (pass == 0 && PushedAt(rule, you, seat, p) <= kSeparateSlop) break;
  }
  // A seat pushed to and fro across where the bodies turn can be left inside yours after every push: it goes on along
  // the way the pushes took it, to where it stops touching.
  return PushedAt(rule, you, seat, p) > kSeparateLeft ? ClearOnward(rule, you, seat, p) : p;
}

SeatDrawn SeparateAround(const ContactRule& rule, const ContactBody& you, const ContactBody& drawnSeat, const SeatSide* prev, double now,
                         SeatSide* side, bool blocked) {
  using namespace separate_detail;
  const ContactBody seat = LiftOff(rule, you, drawnSeat);
  const SeatDrawn out = SeparateDrawn(rule, you, seat);
  const double tdx = out.x - you.x;
  const double tdy = out.y - you.y;
  const double tdz = out.z - you.z;
  const bool moved = out.x != seat.x || out.y != seat.y || out.z != seat.z;
  const double bx = seat.x - you.x;
  const double by = seat.y - you.y;
  if (prev == nullptr || !(blocked || Crosses(rule, you, seat, *prev, tdx, tdy, tdz))) return Draw(you, tdx, tdy, tdz, moved, bx, by, now, side);
  const SeatSide p = *prev;
  const double rPrev = std::hypot(p.dx, p.dy);
  const double rTarget = std::hypot(tdx, tdy);
  const double from = std::atan2(p.dy, p.dx);
  if (!p.held) {
    if (p.dx * tdx + p.dy * tdy >= 0) return Draw(you, tdx, tdy, tdz, moved, bx, by, now, side);
    const double back = ClearAlong(rule, you, seat, from, tdz, JsMax(rPrev, rTarget));
    return DrawHeld(rule, you, seat, back * std::cos(from), back * std::sin(from), tdz, bx, by, now, side);
  }
  const double turn = TurnOf(std::atan2(tdy, tdx) - from);
  const double passed = rPrev > 0 ? (kRoundPerStraight * std::hypot(bx - p.bx, by - p.by)) / rPrev : 0.0;
  const double rate = JsMax(passed, (kSeatRoundRate * JsMax(0.0, now - p.at)) / 1000);
  const double step = JsMin(std::fabs(turn), rate);
  const double share = turn == 0 ? 1.0 : step / std::fabs(turn);
  const double angle = from + SignOf(turn) * step;
  // Over or under yours (a seat beside yours up a wall goes round it in the wall's plane): its height moves at most
  // the arc the way round may travel this frame, never across yours in one frame.
  const double rise = tdz - p.dz;
  const double riseMax = rate * JsMax(rPrev, rTarget);
  const double dz = std::fabs(rise * share) > riseMax ? p.dz + SignOf(rise) * riseMax : p.dz + rise * share;
  const double r = JsMax(rPrev + (rTarget - rPrev) * share, ClearAlong(rule, you, seat, angle, dz, JsMax(rPrev, rTarget)));
  return DrawHeld(rule, you, seat, r * std::cos(angle), r * std::sin(angle), dz, bx, by, now, side);
}

std::string SeatPairKey(const std::string& a, const std::string& b) {
  return a < b ? a + std::string(1, '\0') + b : b + std::string(1, '\0') + a;
}

namespace separate_detail {

/** Passes of SeparateSeats' pile at most (seat-contacts.ts PILE_PASSES). */
constexpr int kPilePasses = 12;

ContactBody At(const ContactBody& seat, const SeatDrawn& p) {
  ContactBody out = seat;
  out.x = p.x;
  out.y = p.y;
  out.z = p.z;
  out.vx = out.vy = out.vz = 0.0;
  return out;
}

bool SamePoint(const SeatDrawn& p, double x, double y, double z) { return p.x == x && p.y == y && p.z == z; }
bool SamePoint(const SeatDrawn& p, const SeatDrawn& q) { return p.x == q.x && p.y == q.y && p.z == q.z; }

/** seat-contacts.ts pushApart: two seats drawn at `drawn` (`a` the lower id) pushed apart by the rule, half each. */
bool PushApart(const ContactRule& rule, const ContactBody& a, const ContactBody& b, std::map<std::string, SeatDrawn>& drawn) {
  const SeatDrawn pa = drawn[a.id];
  const SeatDrawn pb = drawn[b.id];
  const SeatDrawn out = SeparateDrawn(rule, At(a, pa), At(b, pb));
  if (SamePoint(out, pb)) return false;
  const double hx = (out.x - pb.x) / 2;
  const double hy = (out.y - pb.y) / 2;
  const double hz = (out.z - pb.z) / 2;
  drawn[a.id] = SeatDrawn{pa.x - hx, pa.y - hy, pa.z - hz};
  drawn[b.id] = SeatDrawn{pb.x + hx, pb.y + hy, pb.z + hz};
  return true;
}

/** Frames at most of easing a pair's push (seconds), and the pair search's halvings, doublings and first reach. */
constexpr double kPairEaseDtMax = 0.1;
constexpr int kPairHalvings = 24;
constexpr int kPairDoublings = 8;
constexpr double kPairReach = 64;

/** seat-contacts.ts touchAt: whether the rule pushes `b` drawn at `pb` off `a` drawn at `pa` (both at rest). */
bool TouchAt(const ContactRule& rule, const ContactBody& a, const ContactBody& b, const SeatDrawn& pa, const SeatDrawn& pb) {
  return !SamePoint(SeparateDrawn(rule, At(a, pa), At(b, pb)), pb);
}

SeatDrawn PointOf(const ContactBody& body) { return SeatDrawn{body.x, body.y, body.z}; }

/** seat-contacts.ts pushedBy: `pa` and `pb` pushed apart along `n` by `k` units, half each (`a` back, `b` on). */
std::pair<SeatDrawn, SeatDrawn> PushedBy(const SeatDrawn& pa, const SeatDrawn& pb, const PairPush& n, double k) {
  return {SeatDrawn{pa.x - (n.nx * k) / 2, pa.y - (n.ny * k) / 2, pa.z}, SeatDrawn{pb.x + (n.nx * k) / 2, pb.y + (n.ny * k) / 2, pb.z}};
}

/** seat-contacts.ts pushFrom: the least push along `n` from `floor` up that leaves the two seats apart. */
double PushFrom(const ContactRule& rule, const ContactBody& a, const ContactBody& b, const SeatDrawn& pa, const SeatDrawn& pb,
                const PairPush& n, double floor) {
  const auto touches = [&](double k) {
    const std::pair<SeatDrawn, SeatDrawn> q = PushedBy(pa, pb, n, k);
    return TouchAt(rule, a, b, q.first, q.second);
  };
  if (!touches(floor)) return floor;
  double lo = floor;
  double hi = floor + kPairReach;
  for (int i = 0; i < kPairDoublings && touches(hi); ++i) {
    lo = hi;
    hi = floor + (hi - floor) * 2;
  }
  for (int i = 0; i < kPairHalvings; ++i) {
    const double mid = (lo + hi) / 2;
    if (touches(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/** seat-contacts.ts unit: a horizontal unit vector along (x, y), or none when it has no length. */
bool UnitOf(double x, double y, PairPush& out) {
  const double len = std::hypot(x, y);
  if (!(len > 0)) return false;
  out.nx = x / len;
  out.ny = y / len;
  return true;
}

/** seat-contacts.ts sideOf: the side two seats that start to touch are pushed apart on: the axis the rule pushes the
 *  higher id's seat along, turned toward the side it was drawn on last frame (`prev`), else the side it is drawn on now;
 *  without a push, that side; else +x. */
PairPush SideOf(const ContactRule& rule, const ContactBody& a, const ContactBody& b, const SeatDrawn& pa, const SeatDrawn& pb,
                const SeatSide* prev) {
  const SeatDrawn pushed = SeparateDrawn(rule, At(a, pa), At(b, pb));
  PairPush from;
  const bool hasFrom = (prev != nullptr && UnitOf(prev->dx, prev->dy, from)) || UnitOf(pb.x - pa.x, pb.y - pa.y, from);
  PairPush axis;
  const bool hasAxis = UnitOf(pushed.x - pb.x, pushed.y - pb.y, axis);
  const double flip = hasAxis && hasFrom && axis.nx * from.nx + axis.ny * from.ny < 0 ? -1.0 : 1.0;
  if (!hasAxis) return hasFrom ? PairPush{from.nx, from.ny, 0.0} : PairPush{1.0, 0.0, 0.0};
  return PairPush{flip * axis.nx, flip * axis.ny, 0.0};
}

/** seat-contacts.ts crossedApart: two seats pushed apart on side `n` last frame whose own poses no longer touch and lie
 *  the other way round. */
bool CrossedApart(const ContactRule& rule, const ContactBody& a, const ContactBody& b, const PairPush& n) {
  return n.nx * (b.x - a.x) + n.ny * (b.y - a.y) < 0 && !TouchAt(rule, a, b, PointOf(a), PointOf(b));
}

/** seat-contacts.ts netPush: how much further apart along `n` two seats are drawn (`pa`, `pb`) than their own poses. */
double NetPush(const ContactBody& a, const ContactBody& b, const SeatDrawn& pa, const SeatDrawn& pb, const PairPush& n) {
  return n.nx * (pb.x - pa.x - (b.x - a.x)) + n.ny * (pb.y - pa.y - (b.y - a.y));
}

/** seat-contacts.ts pushPair: two seats drawn at `drawn` (`a` the lower id) kept apart: two whose own poses are inside
 *  each other, or that were pushed on a side last frame (`prev`, `dt` seconds ago), pushed apart on that side by the
 *  least push that parts them, and on a frame's first pass at least last frame's push less SeatPairEase · dt; two whose
 *  own poses are apart pushed apart by the rule (PushApart). Whether it pushed. */
bool PushPair(const ContactRule& rule, const ContactBody& a, const ContactBody& b, std::map<std::string, SeatDrawn>& drawn,
              std::map<std::string, PairPush>& state, const SeatSide* prev, double dt) {
  const std::string key = SeatPairKey(a.id, b.id);
  const SeatDrawn pa = drawn[a.id];
  const SeatDrawn pb = drawn[b.id];
  double floor = 0;
  auto known = state.find(key);
  if (known == state.end()) {
    const bool hasWas = prev != nullptr && prev->hasPair;
    const bool letGo = hasWas ? CrossedApart(rule, a, b, prev->pair) : !TouchAt(rule, a, b, PointOf(a), PointOf(b));
    if (letGo) return PushApart(rule, a, b, drawn);
    const PairPush side = hasWas ? prev->pair : SideOf(rule, a, b, pa, pb, prev);
    known = state.emplace(key, side).first;
    const double eased = hasWas ? prev->pair.push - SeatPairEase * JsMin(dt, kPairEaseDtMax) : 0.0;
    floor = JsMax(0.0, eased - NetPush(a, b, pa, pb, side));
  }
  const PairPush side = known->second;
  const double k = PushFrom(rule, a, b, pa, pb, side, floor);
  if (k <= 0) return false;
  const std::pair<SeatDrawn, SeatDrawn> q = PushedBy(pa, pb, side, k);
  drawn[a.id] = q.first;
  drawn[b.id] = q.second;
  return true;
}

/** seat-contacts.ts keepSide: a pair kept on its sides of each other from last frame. */
void KeepSide(const ContactRule& rule, const ContactBody& a, const ContactBody& b, std::map<std::string, SeatDrawn>& drawn,
              const SeatSide* prev, const std::function<double(const std::string&)>& moved) {
  if (prev == nullptr) return;
  const SeatDrawn pa = drawn[a.id];
  const SeatDrawn pb = drawn[b.id];
  const double ndx = pb.x - pa.x;
  const double ndy = pb.y - pa.y;
  const double ndz = pb.z - pa.z;
  if (prev->dx * ndx + prev->dy * ndy >= 0) return;
  const ContactBody bodyA = At(a, pa);
  const ContactBody bodyB = At(b, pb);
  if (!Crosses(rule, bodyA, bodyB, *prev, ndx, ndy, ndz)) return;
  const double heading = std::atan2(prev->dy, prev->dx);
  const double r = ClearAlong(rule, bodyA, bodyB, heading, prev->dz, std::hypot(prev->dx, prev->dy));
  const double kdx = r * std::cos(heading);
  const double kdy = r * std::sin(heading);
  const double kdz = prev->dz;
  if (moved(b.id) >= moved(a.id)) {
    drawn[b.id] = SeatDrawn{pa.x + kdx, pa.y + kdy, pa.z + kdz};
    return;
  }
  drawn[a.id] = SeatDrawn{pb.x - kdx, pb.y - kdy, pb.z - kdz};
}

/** seat-contacts.ts sweepsThrough: whether the move of `seat`'s drawing from last frame's offset `was` to `out` (both from
 *  your entity) sweeps it through another seat of `order` where that one was drawn last frame (`prev`): a seat let go on its
 *  own pose across yours was drawn leaping through a third car beside yours. */
bool SweepsThrough(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, const std::vector<ContactBody>& order,
                   const std::function<const SeatSide*(const std::string&)>& prevOf, const SeatSide& was, const SeatDrawn& out) {
  const double tdx = out.x - you.x;
  const double tdy = out.y - you.y;
  const double tdz = out.z - you.z;
  for (const ContactBody& other : order) {
    const SeatSide* at = &other == &seat || other.id == seat.id ? nullptr : prevOf(other.id);
    if (at == nullptr) continue;
    ContactBody body = other;
    body.x = you.x + at->dx;
    body.y = you.y + at->dy;
    body.z = you.z + at->dz;
    body.vx = body.vy = body.vz = 0.0;
    SeatSide from;
    from.dx = was.dx - at->dx;
    from.dy = was.dy - at->dy;
    from.dz = was.dz - at->dz;
    if (Crosses(rule, body, seat, from, tdx - at->dx, tdy - at->dy, tdz - at->dz)) return true;
  }
  return false;
}

/** seat-contacts.ts offYours: the seat drawn at `p` moved back out of your entity, unless that crosses yours from
 *  where SeparateAround drew it this frame (`first`). */
SeatDrawn OffYours(const ContactRule& rule, const ContactBody& you, const ContactBody& seat, const SeatDrawn& p, const SeatDrawn& first) {
  const ContactBody body = At(seat, p);
  const SeatDrawn out = SeparateDrawn(rule, you, body);
  if (SamePoint(out, p)) return p;
  SeatSide from;
  from.dx = first.x - you.x;
  from.dy = first.y - you.y;
  from.dz = first.z - you.z;
  return Crosses(rule, you, body, from, out.x - you.x, out.y - you.y, out.z - you.z) ? first : out;
}

}  // namespace separate_detail

SeparatedSeats SeparateSeats(const ContactRule& rule, const ContactBody& you, const std::vector<ContactBody>& seats,
                             const std::map<std::string, SeatSide>& prev, double now) {
  using namespace separate_detail;
  std::vector<ContactBody> order = seats;
  std::stable_sort(order.begin(), order.end(), [](const ContactBody& a, const ContactBody& b) { return a.id < b.id; });
  const auto prevOf = [&prev](const std::string& key) -> const SeatSide* {
    const auto it = prev.find(key);
    return it == prev.end() ? nullptr : &it->second;
  };
  SeparatedSeats out;
  std::map<std::string, SeatDrawn>& drawn = out.drawn;
  for (const ContactBody& seat : order) {
    const SeatSide* was = prevOf(seat.id);
    SeatSide side;
    const SeatDrawn first = SeparateAround(rule, you, seat, was, now, &side);
    // A held seat let go onto its own pose is drawn there at once: not through a third car.
    const bool through = was != nullptr && was->held && !side.held && SweepsThrough(rule, you, seat, order, prevOf, *was, first);
    drawn[seat.id] = through ? SeparateAround(rule, you, seat, was, now, nullptr, true) : first;
  }
  const std::map<std::string, SeatDrawn> around = drawn;
  // How far each seat is drawn from last frame's drawing, relative to yours (a new seat: infinitely).
  const std::function<double(const std::string&)> moved = [&](const std::string& id) {
    const SeatSide* side = prevOf(id);
    const SeatDrawn& p = around.at(id);
    return side == nullptr ? std::numeric_limits<double>::infinity() : std::hypot(p.x - you.x - side->dx, p.y - you.y - side->dy, p.z - you.z - side->dz);
  };
  std::vector<std::pair<std::size_t, std::size_t>> pairs;
  for (std::size_t i = 0; i < order.size(); ++i) {
    for (std::size_t k = i + 1; k < order.size(); ++k) pairs.emplace_back(i, k);
  }
  const auto pairPrev = [&](std::size_t i, std::size_t k) { return prevOf(SeatPairKey(order[i].id, order[k].id)); };
  // A pair pushed apart last frame keeps its side (PushPair); a pair that was not, or that crossed while pushed, is put
  // back on its sides.
  for (const auto& [i, k] : pairs) {
    const SeatSide* was = pairPrev(i, k);
    if (was == nullptr || !was->hasPair || CrossedApart(rule, order[i], order[k], was->pair)) KeepSide(rule, order[i], order[k], drawn, was, moved);
  }
  std::map<std::string, PairPush> pushes;
  for (int pass = 0;; ++pass) {
    for (const ContactBody& seat : order) drawn[seat.id] = OffYours(rule, you, seat, drawn[seat.id], around.at(seat.id));
    if (pass == kPilePasses) break;
    bool touched = false;
    for (const auto& [i, k] : pairs) {
      const SeatSide* was = pairPrev(i, k);
      const double dt = was == nullptr ? 0.0 : JsMax(0.0, now - was->at) / 1000;
      touched = PushPair(rule, order[i], order[k], drawn, pushes, was, dt) || touched;
    }
    if (!touched) break;
  }
  for (const ContactBody& seat : order) {
    const SeatDrawn& p = drawn[seat.id];
    out.sides[seat.id] = SeatSide{p.x - you.x, p.y - you.y, p.z - you.z, !SamePoint(p, seat.x, seat.y, seat.z), seat.x - you.x, seat.y - you.y, now, false, PairPush{}};
  }
  for (const auto& [i, k] : pairs) {
    const ContactBody& a = order[i];
    const ContactBody& b = order[k];
    const SeatDrawn& pa = drawn[a.id];
    const SeatDrawn& pb = drawn[b.id];
    const std::string key = SeatPairKey(a.id, b.id);
    SeatSide pairSide{pb.x - pa.x, pb.y - pa.y, pb.z - pa.z, false, b.x - a.x, b.y - a.y, now, false, PairPush{}};
    const auto pushed = pushes.find(key);
    const double push = pushed == pushes.end() ? 0.0 : NetPush(a, b, pa, pb, pushed->second);
    if (pushed != pushes.end() && push > 0) {
      pairSide.hasPair = true;
      pairSide.pair = PairPush{pushed->second.nx, pushed->second.ny, push};
    }
    out.sides[key] = pairSide;
  }
  return out;
}

}  // namespace genex

GENEX_FP_STRICT_END
