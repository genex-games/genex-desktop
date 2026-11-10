// Ports of session.ts stepOwn / ownPath and physics-predict-session.ts's ring. See GenexOwnPredict.h.
#include "GenexCore/GenexOwnPredict.h"

#include "GenexCore/AuthoritySchema.h"

#include <cstring>
#include <limits>

GENEX_FP_STRICT_BEGIN

namespace genex {

namespace aw = ::genex::authority_wire;

namespace {

/** The fields a seat contact rule may change (seat-contacts.ts CONTACT_FIELDS). */
const char* const kContactFields[] = {"x", "y", "z", "vx", "vy", "vz", "yaw", "spin"};

bool Mirrors(const Prediction& prediction, const char* field) {
  const char* const* fields = prediction.Fields();
  for (int i = 0; i < prediction.FieldCount(); ++i) {
    if (std::strcmp(fields[i], field) == 0) return true;
  }
  return false;
}

}  // namespace

double AuthorityEntityField(const aw::AuthorityEntity& e, const std::string& field) {
  if (field == "x") return static_cast<double>(e.x);
  if (field == "y") return static_cast<double>(e.y);
  if (field == "z") return static_cast<double>(e.z);
  if (field == "vx") return static_cast<double>(e.vx);
  if (field == "vy") return static_cast<double>(e.vy);
  if (field == "vz") return static_cast<double>(e.vz);
  if (field == "yaw") return static_cast<double>(e.yaw);
  if (field == "pitch") return static_cast<double>(e.pitch);
  if (field == "duck") return static_cast<double>(e.duck);
  if (field == "mstate") return e.mstate;
  if (field == "cap") return static_cast<double>(e.cap);
  if (field == "spin") return static_cast<double>(e.spin);
  if (field == "fuel") return static_cast<double>(e.fuel);
  return 0.0;
}

void SetAuthorityEntityField(aw::AuthorityEntity& e, const std::string& field, double value) {
  const float f = static_cast<float>(physics::Fround(value));
  if (field == "x") e.x = f;
  else if (field == "y") e.y = f;
  else if (field == "z") e.z = f;
  else if (field == "vx") e.vx = f;
  else if (field == "vy") e.vy = f;
  else if (field == "vz") e.vz = f;
  else if (field == "yaw") e.yaw = f;
  else if (field == "pitch") e.pitch = f;
  else if (field == "duck") e.duck = f;
  else if (field == "mstate") e.mstate = value;
  else if (field == "cap") e.cap = f;
  else if (field == "spin") e.spin = f;
  else if (field == "fuel") e.fuel = f;
}

void StepOwnInput(const Prediction& prediction, aw::AuthorityEntity& body, const aw::AuthorityInput& command, double dt,
                  double seq, double stateTick, double ack, const OwnRules& rules) {
  if (!prediction.Known()) return;
  const char* const* fields = prediction.Fields();
  const int count = prediction.FieldCount();
  // 1. The seat rule at the tick this input is applied on, on the fields the prediction mirrors.
  if (rules.seatRule) {
    std::map<std::string, double> seat;
    for (int i = 0; i < count; ++i) seat[fields[i]] = AuthorityEntityField(body, fields[i]);
    rules.seatRule(seat, SeatRuleTick(stateTick, ack, seq), seq);
    for (int i = 0; i < count; ++i) {
      const auto it = seat.find(fields[i]);
      // A field the rule removed reads as missing (NaN, the step's own fallback); another name is dropped.
      SetAuthorityEntityField(body, fields[i], it == seat.end() ? std::numeric_limits<double>::quiet_NaN() : it->second);
    }
  }
  // 2. The room's preset step, under the input sanitized as the server sanitizes it.
  prediction.Step(body, command, dt);
  // 3. The seat contacts against the other seats at this input's tick (SeatContacts writes your changed
  //    fields as float32; the mirror is float32 anyway).
  if (rules.contacts != nullptr || rules.seatWorld != nullptr) {
    ContactBody mine;
    mine.id = rules.ownId;
    mine.x = static_cast<double>(body.x);
    mine.y = static_cast<double>(body.y);
    mine.z = static_cast<double>(body.z);
    mine.vx = static_cast<double>(body.vx);
    mine.vy = static_cast<double>(body.vy);
    mine.vz = static_cast<double>(body.vz);
    mine.yaw = static_cast<double>(body.yaw);
    mine.spin = static_cast<double>(body.spin);
    if (rules.ownFlags) mine.flags = *rules.ownFlags;
    if (rules.seatWorld != nullptr) {
      // `predicted`: the other seats stepped under their held inputs and the room's pass on every seat.
      rules.seatWorld->Apply(seq, ack, stateTick, mine, rules.tickHz);
    } else {
      rules.contacts->Apply(seq, ack, mine, rules.tickHz);
    }
    const double values[] = {mine.x, mine.y, mine.z, mine.vx, mine.vy, mine.vz, mine.yaw, mine.spin};
    for (std::size_t i = 0; i < sizeof kContactFields / sizeof kContactFields[0]; ++i) {
      if (Mirrors(prediction, kContactFields[i])) SetAuthorityEntityField(body, kContactFields[i], values[i]);
    }
  }
}

std::vector<std::pair<double, OwnState>> OwnPath(const Prediction& prediction, const aw::AuthorityEntity& server, int ack,
                                                 int sent, const SentInputAt& inputAt, double dt, double stateTick,
                                                 const OwnRules& rules) {
  std::vector<std::pair<double, OwnState>> out;
  if (!prediction.Known() || !inputAt || sent <= ack) return out;
  aw::AuthorityEntity body;
  std::memset(&body, 0, sizeof body);
  const char* const* fields = prediction.Fields();
  for (int i = 0; i < prediction.FieldCount(); ++i) SetAuthorityEntityField(body, fields[i], AuthorityEntityField(server, fields[i]));
  for (int seq = ack + 1; seq <= sent; ++seq) {
    const aw::AuthorityInput* command = inputAt(seq);
    if (command == nullptr) continue;
    StepOwnInput(prediction, body, *command, dt, seq, stateTick, ack, rules);
    OwnState s;
    s.p.x = static_cast<double>(body.x);
    s.p.y = static_cast<double>(body.y);
    s.p.z = static_cast<double>(body.z);
    s.v.x = static_cast<double>(body.vx);
    s.v.y = static_cast<double>(body.vy);
    s.v.z = static_cast<double>(body.vz);
    out.emplace_back(static_cast<double>(seq), s);
  }
  return out;
}

void OwnRing::AfterSend(int sent, const std::optional<OwnState>& pose, const std::function<void(double seq)>& advance) {
  const std::optional<OwnState> from = last_ ? last_ : pose;
  const int count = sent - stepped_;
  for (int i = 1; i <= count; ++i) {
    const double k = static_cast<double>(i) / static_cast<double>(count);
    if (pose && from) {
      OwnState s;
      s.p.x = from->p.x + (pose->p.x - from->p.x) * k;
      s.p.y = from->p.y + (pose->p.y - from->p.y) * k;
      s.p.z = from->p.z + (pose->p.z - from->p.z) * k;
      s.v = pose->v;
      own_[static_cast<double>(stepped_ + i)] = s;
    }
    if (advance) advance(static_cast<double>(stepped_ + i));
  }
  stepped_ = sent;
  last_ = pose;
  while (!own_.empty() && own_.begin()->first < static_cast<double>(sent - kKept)) own_.erase(own_.begin());
}

void OwnRing::Restart(int sent) {
  own_.clear();
  last_.reset();
  stepped_ = sent;
}

void OwnRing::Refresh(const std::vector<std::pair<double, OwnState>>& path) {
  for (const auto& entry : path) own_[entry.first] = entry.second;
}

std::optional<bodies::Vec3> OwnRing::Pose(double seq) const {
  const auto it = own_.find(seq);
  if (it == own_.end()) return std::nullopt;
  return it->second.p;
}

std::optional<bodies::Vec3> OwnRing::Velocity(double seq) const {
  const auto it = own_.find(seq);
  if (it == own_.end()) return std::nullopt;
  return it->second.v;
}

}  // namespace genex

GENEX_FP_STRICT_END
