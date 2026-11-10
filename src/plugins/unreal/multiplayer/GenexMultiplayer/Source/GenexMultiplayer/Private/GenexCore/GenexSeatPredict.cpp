// A port of packages/multiplayer/src/authority/seat-predict.ts. See GenexSeatPredict.h.
#include "GenexCore/GenexSeatPredict.h"

#include <algorithm>
#include <cmath>

GENEX_FP_STRICT_BEGIN

namespace genex {

namespace {

constexpr double kPi = 3.141592653589793;
constexpr double kTwoPi = 2 * kPi;

/** seat-predict.ts `num`: a finite number, else `fallback`. */
double Num(const std::map<std::string, double>& b, const char* field, double fallback = 0.0) {
  const auto it = b.find(field);
  return it != b.end() && std::isfinite(it->second) ? it->second : fallback;
}

/** An angle in [-pi, pi). */
double Wrap(double v) { return v - kTwoPi * std::floor((v + kPi) / kTwoPi); }

SeatPose PoseOf(const std::map<std::string, double>& b) {
  return SeatPose{Num(b, "x"), Num(b, "y"), Num(b, "z"), Num(b, "yaw"), Num(b, "vx"), Num(b, "vy"), Num(b, "vz")};
}

ContactBody ContactOf(const std::string& id, const std::map<std::string, double>& b) {
  ContactBody c;
  c.id = id;
  c.x = Num(b, "x");
  c.y = Num(b, "y");
  c.z = Num(b, "z");
  c.vx = Num(b, "vx");
  c.vy = Num(b, "vy");
  c.vz = Num(b, "vz");
  c.yaw = Num(b, "yaw");
  c.spin = Num(b, "spin");
  // A declared policy's pair rules read the seat's `flags` (seat-predict.ts contactOf: only when the body has them).
  c.flags = Num(b, "flags");
  return c;
}

bool SameContact(const ContactBody& a, const ContactBody& b) {
  return a.x == b.x && a.y == b.y && a.z == b.z && a.vx == b.vx && a.vy == b.vy && a.vz == b.vz && a.yaw == b.yaw && a.spin == b.spin;
}

/** A field the pass changed written back as float32 (seat-predict.ts: `v !== own[field]`, a NaN always is). */
void WriteBack(double v, double& out) {
  if (!(v == out)) out = static_cast<double>(static_cast<float>(v));
}

void ToBody(const ContactBody& c, std::map<std::string, double>& b) {
  b["x"] = c.x;
  b["y"] = c.y;
  b["z"] = c.z;
  b["vx"] = c.vx;
  b["vy"] = c.vy;
  b["vz"] = c.vz;
  b["yaw"] = c.yaw;
  b["spin"] = c.spin;
}

std::int64_t Key(double seq) { return static_cast<std::int64_t>(seq); }

/** One offset component and its rate after `dt` ms of a critically damped return to 0 at `1 / tau`. */
std::pair<double, double> Settle(double o, double v, double dt, double tau) {
  const double w = 1 / tau;
  const double e = std::exp(-w * dt);
  const double k = v + w * o;
  return {(o + k * dt) * e, (v - w * k * dt) * e};
}

/** Passes before the current one that are stepped on with it. */
constexpr std::size_t kRecentPasses = 3;
/** MotionAt measures a track's slope this many inputs either side of the drawn one. */
constexpr double kRateSpan = 0.5;

/** seat-predict.ts `beyond`: a past pass's seat `f` inputs after its last tick `last`, on along the steps its last
 *  three ticks took (a step d, changing by c a tick), or by its velocity with fewer ticks. */
std::optional<SeatPose> Beyond(const SeatPass& pass, const std::string& id, double last, double f) {
  const SeatPose* p2 = pass.PoseAt(Key(last), id);
  if (p2 == nullptr) return std::nullopt;
  const SeatPose* p1 = pass.PoseAt(Key(last - 1), id);
  const SeatPose* p0 = pass.PoseAt(Key(last - 2), id);
  if (p1 == nullptr) {
    const double k = f / pass.tickHz;
    SeatPose out = *p2;
    out.x = p2->x + p2->vx * k;
    out.y = p2->y + p2->vy * k;
    out.z = p2->z + p2->vz * k;
    return out;
  }
  // At tick n past the last: the step n times and its change n(n + 1)/2 times; between two such ticks linear.
  const double n = std::floor(f);
  const auto ramp = [](double k) { return (k * (k + 1)) / 2; };
  const auto at = [&](double x2, double d, double c) {
    const double u = x2 + d * n + c * ramp(n);
    const double v = x2 + d * (n + 1) + c * ramp(n + 1);
    return u + (v - u) * (f - n);
  };
  const auto change = [](double x2, double x1, const double* x0) { return x0 == nullptr ? 0.0 : x2 - 2 * x1 + *x0; };
  const double turn = Wrap(p2->yaw - p1->yaw);
  const double turning = p0 == nullptr ? 0.0 : turn - Wrap(p1->yaw - p0->yaw);
  SeatPose out = *p2;
  out.x = at(p2->x, p2->x - p1->x, change(p2->x, p1->x, p0 ? &p0->x : nullptr));
  out.y = at(p2->y, p2->y - p1->y, change(p2->y, p1->y, p0 ? &p0->y : nullptr));
  out.z = at(p2->z, p2->z - p1->z, change(p2->z, p1->z, p0 ? &p0->z : nullptr));
  out.yaw = Wrap(at(p2->yaw, turn, turning));
  return out;
}

}  // namespace

const SeatPose* SeatPass::PoseAt(std::int64_t seq, const std::string& seat) const {
  const auto it = poses.find(seq);
  if (it == poses.end()) return nullptr;
  for (const auto& p : it->second) {
    if (p.first == seat) return &p.second;
  }
  return nullptr;
}

SeatWorld::SeatWorld(SeatWorldOptions options) : options_(std::move(options)) {}

void SeatWorld::Apply(double seq, double ack, double stateTick, ContactBody& own, double tickHz) {
  const std::shared_ptr<SeatPass> previous = current_;
  const bool fresh = previous == nullptr || previous->ack != ack || previous->stateTick != stateTick || seq <= previous->last;
  const std::shared_ptr<SeatPass> now = fresh ? Start(ack, stateTick, tickHz) : previous;
  const double j = seq - ack;
  // Ticks of inputs this pass did not see stepped (an own prediction that matched the server is not stepped
  // again): your entity as the previous pass was given it there (before that tick's contacts, which this pass
  // runs again), when it has it; the pass's changes to it are not kept.
  for (double i = now->ticks + 1; i < j; i += 1) {
    ContactBody* given = nullptr;
    ContactBody copy;
    if (previous != nullptr) {
      const auto it = previous->ownIn.find(Key(ack + i));
      if (it != previous->ownIn.end()) {
        copy = it->second;
        given = &copy;
      }
    }
    Tick(*now, i, given, false);
    NoteMissed(*now, Key(ack + i));
  }
  if (j > now->ticks) {
    Tick(*now, j, &own, true);
    const auto t = now->touching.find(Key(seq));
    applied_[Key(seq)] = t == now->touching.end() ? std::set<std::string>() : t->second;
  }
  now->last = seq;
  for (const std::shared_ptr<SeatPass>& old : recent_) Extend(*old, *now, seq);
}

void SeatWorld::NoteMissed(const SeatPass& pass, std::int64_t seq) {
  const auto live = applied_.find(seq);
  const auto now = pass.touching.find(seq);
  if (live == applied_.end() || now == pass.touching.end()) return;
  for (const std::string& id : now->second) {
    if (live->second.count(id) == 0) missed_.insert(id);
  }
}

std::vector<std::string> SeatWorld::TakeMissed() {
  std::vector<std::string> out(missed_.begin(), missed_.end());
  missed_.clear();
  return out;
}

void SeatWorld::Extend(SeatPass& old, const SeatPass& now, double seq) {
  const double j = seq - old.ack;
  for (double i = old.ticks + 1; i <= j; i += 1) {
    const auto it = now.ownIn.find(Key(old.ack + i));
    ContactBody copy;
    ContactBody* given = nullptr;
    if (it != now.ownIn.end()) {
      copy = it->second;
      given = &copy;
    }
    Tick(old, i, given, false);
  }
  old.last = (std::max)(old.last, seq);
}

std::optional<SeatPose> SeatWorld::PoseAt(const std::string& id, double seq, const SeatPass* pass) const {
  const SeatPass* p = pass != nullptr ? pass : current_.get();
  if (p == nullptr) return std::nullopt;
  const double s = (std::max)(seq, p->ack);
  const double last = p->ack + p->ticks;
  const double s0 = (std::min)(std::floor(s), last);
  const SeatPose* a = p->PoseAt(Key(s0), id);
  if (a == nullptr) return std::nullopt;
  const SeatPose* b = s0 < last ? p->PoseAt(Key(s0 + 1), id) : nullptr;
  const double f = s - s0;
  if (b == nullptr) {
    // Past the last tick stepped: the current pass on by its velocity, at most a tick (the next input steps it); a
    // pass before it on along its last ticks' steps and their change, as far as asked.
    if (p != current_.get()) {
      const std::optional<SeatPose> on = Beyond(*p, id, s0, f);
      return on ? on : std::optional<SeatPose>(*a);
    }
    const double k = (std::min)(f, 1.0) / p->tickHz;
    SeatPose out = *a;
    out.x = a->x + a->vx * k;
    out.y = a->y + a->vy * k;
    out.z = a->z + a->vz * k;
    return out;
  }
  SeatPose out;
  out.x = a->x + (b->x - a->x) * f;
  out.y = a->y + (b->y - a->y) * f;
  out.z = a->z + (b->z - a->z) * f;
  out.yaw = a->yaw + Wrap(b->yaw - a->yaw) * f;
  out.vx = a->vx + (b->vx - a->vx) * f;
  out.vy = a->vy + (b->vy - a->vy) * f;
  out.vz = a->vz + (b->vz - a->vz) * f;
  return out;
}

std::optional<SeatMotion> SeatWorld::MotionAt(const std::string& id, double seq, const SeatPass* pass) const {
  const SeatPass* p = pass != nullptr ? pass : current_.get();
  const std::optional<SeatPose> pose = PoseAt(id, seq, p);
  const std::optional<SeatPose> a = PoseAt(id, seq - kRateSpan, p);
  const std::optional<SeatPose> b = PoseAt(id, seq + kRateSpan, p);
  if (!pose || !a || !b || p == nullptr) return std::nullopt;
  const double k = p->tickHz / 1000 / (2 * kRateSpan);
  SeatMotion out;
  out.pose = *pose;
  out.rate = SeatRate{(b->x - a->x) * k, (b->y - a->y) * k, (b->z - a->z) * k, Wrap(b->yaw - a->yaw) * k};
  return out;
}

std::optional<SeatChange> SeatWorld::ChangeAt(const std::string& id, double seq, const SeatPass* from) const {
  if (current_ == nullptr || current_.get() == from) return std::nullopt;
  // Past `from`'s last stepped input (the seat clock draws up to 1.5 inputs ahead) the current pass moves a seat on by
  // its velocity and `from` along its last steps: compared there, the drawing's own advance read as a correction.
  const double common = from == nullptr ? seq : (std::min)(seq, from->ack + from->ticks);
  const std::optional<SeatMotion> before = MotionAt(id, common, from);
  const std::optional<SeatMotion> after = MotionAt(id, common);
  if (!before || !after) return std::nullopt;
  return SeatChange{*before, *after};
}

bool SeatWorld::TouchingAt(const std::string& id, double seq) const {
  if (current_ == nullptr) return false;
  // Math.round: half up.
  const double s = std::floor((std::max)(seq, current_->ack) + 0.5);
  const auto it = current_->touching.find(Key(s));
  return it != current_->touching.end() && it->second.count(id) != 0;
}

std::optional<SeatRate> SeatWorld::StateRate(const std::string& id) const {
  if (current_ == nullptr) return std::nullopt;
  const auto it = current_->poses.find(Key(current_->ack));
  if (it == current_->poses.end()) return std::nullopt;
  for (const auto& [seat, pose] : it->second) {
    if (seat == id) return SeatRate{pose.vx / 1000, pose.vy / 1000, pose.vz / 1000, 0};
  }
  return std::nullopt;
}

namespace {

/** Your entity in `pass` at input `seq` (seat-predict.ts ownAt): between the two stepped inputs around it (positions
 *  linear, the heading along the short arc), held at the first and last; None before your entity is known. */
std::optional<ContactBody> OwnAt(const SeatPass& pass, double seq) {
  const double last = pass.ack + pass.ticks;
  const double s = (std::min)((std::max)(seq, pass.ack + 1), last);
  const double s0 = std::floor(s);
  const auto a = pass.own.find(static_cast<std::int64_t>(s0));
  if (a == pass.own.end()) return std::nullopt;
  const auto b = pass.own.find(static_cast<std::int64_t>(s0) + 1);
  const double f = s - s0;
  if (b == pass.own.end() || f == 0) return a->second;
  ContactBody out = a->second;
  out.x = a->second.x + (b->second.x - a->second.x) * f;
  out.y = a->second.y + (b->second.y - a->second.y) * f;
  out.z = a->second.z + (b->second.z - a->second.z) * f;
  out.yaw = a->second.yaw + Wrap(b->second.yaw - a->second.yaw) * f;
  return out;
}

}  // namespace

std::optional<double> SeatWorld::TouchAheadMs(const std::string& id, double seq) const {
  if (current_ == nullptr) return std::nullopt;
  const SeatPass& pass = *current_;
  const double s0 = std::floor((std::max)(seq, pass.ack));
  const auto touched = [&](double n) {
    const auto it = pass.touching.find(Key(n));
    return it != pass.touching.end() && it->second.count(id) != 0;
  };
  if (touched(s0) || touched(s0 + 1)) return 0.0;
  const HeldSeat* seat = nullptr;
  for (const HeldSeat& s : pass.seats) {
    if (s.id == id) seat = &s;
  }
  const std::optional<SeatPose> pose = PoseAt(id, seq, &pass);
  const std::optional<ContactBody> mine = OwnAt(pass, seq);
  if (seat == nullptr || !pose || !mine) return std::nullopt;
  ContactBody body = ContactOf(id, seat->body);
  body.x = pose->x;
  body.y = pose->y;
  body.z = pose->z;
  body.yaw = pose->yaw;
  body.vx = pose->vx;
  body.vy = pose->vy;
  body.vz = pose->vz;
  const double rx = (pose->vx - mine->vx) / 1000;
  const double ry = (pose->vy - mine->vy) / 1000;
  const double rz = (pose->vz - mine->vz) / 1000;
  for (int k = 0; k <= kSeatTouchSamples; ++k) {
    const double t = (static_cast<double>(k) / kSeatTouchSamples) * kSeatClockTauMs;
    ContactBody moved = body;
    moved.x = body.x + rx * t;
    moved.y = body.y + ry * t;
    moved.z = body.z + rz * t;
    if (Touches(*mine, moved)) return t;
  }
  return std::nullopt;
}

double SeatTouchShare(std::optional<double> known, bool touching, double dtMs) {
  if (!known || !std::isfinite(*known)) return touching ? 1.0 : 0.0;
  const double step = (std::max)(0.0, dtMs) / kSeatClockTauMs;
  return touching ? (std::min)(1.0, *known + step) : (std::max)(0.0, *known - step);
}

std::shared_ptr<SeatPass> SeatWorld::Start(double ack, double stateTick, double tickHz) {
  auto pass = std::make_shared<SeatPass>();
  pass->ack = ack;
  pass->stateTick = stateTick;
  pass->tickHz = tickHz;
  pass->last = ack;
  pass->ticks = 0;
  if (options_.others) pass->seats = options_.others();
  std::stable_sort(pass->seats.begin(), pass->seats.end(), [](const HeldSeat& a, const HeldSeat& b) { return a.id < b.id; });
  auto& first = pass->poses[Key(ack)];
  for (const HeldSeat& s : pass->seats) first.emplace_back(s.id, PoseOf(s.body));
  serial_ += 1;
  pass->id = serial_;
  if (current_ != nullptr) {
    recent_.insert(recent_.begin(), current_);
    if (recent_.size() > kRecentPasses) recent_.resize(kRecentPasses);
  }
  for (auto it = applied_.begin(); it != applied_.end() && static_cast<double>(it->first) <= ack;) it = applied_.erase(it);
  current_ = pass;
  return pass;
}

void SeatWorld::Tick(SeatPass& pass, double i, ContactBody* own, bool write) {
  const double maxAhead = options_.maxAheadMs ? options_.maxAheadMs() : 0.0;
  const double ahead = std::ceil((maxAhead * pass.tickHz) / 1000);
  if (i <= ahead) {
    for (HeldSeat& seat : pass.seats) Move(pass, seat, i);
  }
  std::vector<ContactBody> bodies;
  bodies.reserve(pass.seats.size() + 1);
  for (const HeldSeat& s : pass.seats) bodies.push_back(ContactOf(s.id, s.body));
  const std::int64_t seq = Key(pass.ack + i);
  std::optional<ContactBody> mine;
  if (own != nullptr) {
    mine = *own;
    pass.ownIn[seq] = *own;
  }
  std::set<std::string> touching;
  if (mine) {
    for (const ContactBody& b : bodies) {
      if (Touches(*mine, b)) touching.insert(b.id);
    }
  }
  // The pass on every seat with yours, ids ascending (the seats are sorted already).
  std::vector<ContactBody> all = bodies;
  if (mine) {
    all.push_back(*mine);
    std::stable_sort(all.begin(), all.end(), [](const ContactBody& a, const ContactBody& b) { return a.id < b.id; });
  }
  ContactPass(all);
  for (const ContactBody& b : all) {
    if (mine && b.id == mine->id) {
      mine = b;
      continue;
    }
    for (HeldSeat& s : pass.seats) {
      if (s.id == b.id) {
        ToBody(b, s.body);
        break;
      }
    }
  }
  if (own != nullptr && mine && write) {
    WriteBack(mine->x, own->x);
    WriteBack(mine->y, own->y);
    WriteBack(mine->z, own->z);
    WriteBack(mine->vx, own->vx);
    WriteBack(mine->vy, own->vy);
    WriteBack(mine->vz, own->vz);
    WriteBack(mine->yaw, own->yaw);
    WriteBack(mine->spin, own->spin);
  }
  auto& poses = pass.poses[seq];
  poses.clear();
  for (const HeldSeat& s : pass.seats) poses.emplace_back(s.id, PoseOf(s.body));
  pass.touching[seq] = std::move(touching);
  if (mine) pass.own[seq] = write && own != nullptr ? *own : *mine;
  pass.ticks = i;
}

void SeatWorld::Move(SeatPass& pass, HeldSeat& seat, double i) {
  const double dt = 1 / pass.tickHz;
  const SeatRemote remote = options_.remote ? options_.remote() : SeatRemote();
  const SeatStep step = remote.predict == physics::RemotePredict::Extrapolate || !options_.step ? SeatStep() : options_.step();
  if (!step || !seat.input) {
    std::map<std::string, double>& b = seat.body;
    b["x"] = Num(b, "x") + Num(b, "vx") * dt;
    b["y"] = Num(b, "y") + Num(b, "vy") * dt;
    b["z"] = Num(b, "z") + Num(b, "vz") * dt;
    return;
  }
  if (options_.seatRule) options_.seatRule(seat.body, pass.stateTick + i);
  physics::RemoteInput input = *seat.input;
  if (remote.predict == physics::RemotePredict::InputDecay) {
    const double w = physics::RemoteInputWeight(i, pass.tickHz, remote.decayMs);
    input.moveX = seat.input->moveX * w;
    input.moveY = seat.input->moveY * w;
    input.moveZ = seat.input->moveZ * w;
  }
  step(seat.body, input, dt);
}

void SeatWorld::ContactPass(std::vector<ContactBody>& all) const {
  if (options_.pass) {
    options_.pass(all);
    return;
  }
  if (!options_.rule) return;
  for (std::size_t a = 0; a < all.size(); ++a) {
    for (std::size_t b = a + 1; b < all.size(); ++b) options_.rule(all[a], all[b]);
  }
}

bool SeatWorld::Touches(const ContactBody& mine, const ContactBody& b) const {
  if (!options_.rule) return false;
  ContactBody x = mine;
  ContactBody y = b;
  if (x.id < y.id) {
    options_.rule(x, y);
  } else {
    options_.rule(y, x);
  }
  return !SameContact(x, mine) || !SameContact(y, b);
}

namespace {

double Along(double x, double y, double z, double hx, double hy, double hz) { return x * hx + y * hy + z * hz; }

/** seat-predict.ts `foundStopping`: a new pass has the seat slower along the way it was drawn moving than the pass
 *  it was drawn from, at the same input, by more than kSeatMovingUnitsPerMs (u: that pass's rate less this one's). */
bool FoundStopping(const SeatOffset& known, double ux, double uy, double uz) {
  return Along(ux, uy, uz, known.hx, known.hy, known.hz) > kSeatMovingUnitsPerMs;
}

/** seat-predict.ts `keepCourse`: this frame's return never pulls a drawn seat back against the way it was drawn
 *  moving while its track still goes that way; it stops instead (and any rate back it would leave it with). Held
 *  kSeatHoldMs still: as is; turned back: as is, unless a pass found it stopping late and it is drawn ahead of its
 *  track while the server's car still moves that way faster than kSeatMovingUnitsPerMs (then it stands kSeatHoldMs
 *  first). */
SeatOffset KeepCourse(const SeatOffset& known, const SeatOffset& settled, const SeatMotion& track, const SeatRate& ahead,
                      const std::optional<SeatRate>& server) {
  const double hx = known.hx, hy = known.hy, hz = known.hz;
  const double onTrack = Along(track.rate.vx, track.rate.vy, track.rate.vz, hx, hy, hz);
  const SeatPose& p = track.pose;
  const double trackMove = Along(p.x - known.ax, p.y - known.ay, p.z - known.az, hx, hy, hz);
  const double drawnMove = trackMove + Along(settled.dx - known.dx, settled.dy - known.dy, settled.dz - known.dz, hx, hy, hz);
  const bool turnedBack = Along(ahead.vx, ahead.vy, ahead.vz, hx, hy, hz) < 0;
  const bool serverRolls = server.has_value() && Along(server->vx, server->vy, server->vz, hx, hy, hz) > kSeatMovingUnitsPerMs;
  const bool drawnAhead = Along(known.dx, known.dy, known.dz, hx, hy, hz) > 0;
  // Its prediction turning back is the drawing's lead on a stop found late, not the server's car: it stands first.
  const bool standsFirst = settled.stopFound && serverRolls && drawnAhead;
  const bool heldLongEnough = known.stillMs >= kSeatHoldMs;
  if (heldLongEnough || (turnedBack && !standsFirst)) return settled;
  const double drawnRate = onTrack + Along(settled.vx, settled.vy, settled.vz, hx, hy, hz);
  if (drawnMove >= 0 && drawnRate >= 0) return settled;
  const double back = (std::max)(0.0, -drawnMove);
  const double rest = -drawnRate;
  SeatOffset out = settled;
  out.dx = settled.dx + back * hx;
  out.dy = settled.dy + back * hy;
  out.dz = settled.dz + back * hz;
  out.vx = settled.vx + rest * hx;
  out.vy = settled.vy + rest * hy;
  out.vz = settled.vz + rest * hz;
  return out;
}

/** seat-predict.ts `moving`: the way the drawn seat moves now, kept while faster than kSeatMovingUnitsPerMs. */
SeatOffset Moving(SeatOffset o, const SeatRate& rate, double dt) {
  const double vx = rate.vx + o.vx;
  const double vy = rate.vy + o.vy;
  const double vz = rate.vz + o.vz;
  const double speed = std::hypot(vx, vy, vz);
  if (speed > kSeatMovingUnitsPerMs) {
    o.hx = vx / speed;
    o.hy = vy / speed;
    o.hz = vz / speed;
    o.stillMs = 0;
    return o;
  }
  o.stillMs = o.stillMs + dt;
  return o;
}

}  // namespace

SeatOffset SeatOffsetNext(const SeatOffset* known, const std::shared_ptr<const SeatPass>& pass, double epoch,
                          const std::optional<SeatChange>& change, const SeatMotion& now, double dtMs, bool touching, double snapUnits,
                          const std::optional<SeatRate>& server) {
  SeatOffset fresh;
  fresh.pass = pass;
  fresh.epoch = epoch;
  fresh.ax = now.pose.x;
  fresh.ay = now.pose.y;
  fresh.az = now.pose.z;
  if (known == nullptr || known->epoch != epoch) return fresh;
  const double tau = SeatTauMs(touching);
  const double dt = (std::max)(0.0, dtMs);
  const auto [dx, vx] = Settle(known->dx, known->vx, dt, tau);
  const auto [dy, vy] = Settle(known->dy, known->vy, dt, tau);
  const auto [dz, vz] = Settle(known->dz, known->vz, dt, tau);
  const auto [dyaw, vyaw] = Settle(known->dyaw, known->vyaw, dt, tau);
  const bool moved = known->pass != pass && change.has_value();
  // How far, and how much faster, the pass it was drawn from had the seat than this one.
  const SeatMotion& p = moved ? change->before : now;
  const SeatMotion& q = moved ? change->after : now;
  const double sx = p.pose.x - q.pose.x, sy = p.pose.y - q.pose.y, sz = p.pose.z - q.pose.z, syaw = Wrap(p.pose.yaw - q.pose.yaw);
  const double ux = p.rate.vx - q.rate.vx, uy = p.rate.vy - q.rate.vy, uz = p.rate.vz - q.rate.vz, uyaw = p.rate.vyaw - q.rate.vyaw;
  // The track it is drawn on this frame, before its offset: this pass's, moved by that difference.
  SeatMotion track = now;
  track.pose.x = now.pose.x + sx;
  track.pose.y = now.pose.y + sy;
  track.pose.z = now.pose.z + sz;
  track.rate = SeatRate{now.rate.vx + ux, now.rate.vy + uy, now.rate.vz + uz, now.rate.vyaw + uyaw};
  SeatOffset decayed = *known;
  decayed.pass = pass;
  decayed.dx = dx;
  decayed.dy = dy;
  decayed.dz = dz;
  decayed.dyaw = dyaw;
  decayed.vx = vx;
  decayed.vy = vy;
  decayed.vz = vz;
  decayed.vyaw = vyaw;
  decayed.stopFound = moved ? FoundStopping(*known, ux, uy, uz) || (known->stopFound && known->stillMs > 0) : known->stopFound;
  const SeatOffset settled = KeepCourse(*known, decayed, track, now.rate, server);
  SeatOffset out = settled;
  out.dx = settled.dx + sx;
  out.dy = settled.dy + sy;
  out.dz = settled.dz + sz;
  out.dyaw = Wrap(settled.dyaw + syaw);
  if (std::hypot(out.dx, out.dy, out.dz) > snapUnits) return fresh;
  out.vx = settled.vx + ux;
  out.vy = settled.vy + uy;
  out.vz = settled.vz + uz;
  out.vyaw = settled.vyaw + uyaw;
  out.ax = now.pose.x;
  out.ay = now.pose.y;
  out.az = now.pose.z;
  return Moving(out, now.rate, dt);
}

SeatClock SeatClockNext(const SeatClock* known, double raw, double at, double tickHz) {
  if (known == nullptr || !std::isfinite(known->seq)) return SeatClock{raw, at};
  const double dt = (std::max)(0.0, at - known->at);
  const double ahead = known->seq + (dt * tickHz) / 1000;
  const double off = raw - ahead;
  if (std::fabs(off) > kSeatClockSnapInputs) return SeatClock{raw, at};
  const double pulled = ahead + off * (1 - std::exp(-dt / kSeatClockTauMs));
  return SeatClock{(std::max)(known->seq, pulled), at};
}

}  // namespace genex

GENEX_FP_STRICT_END
