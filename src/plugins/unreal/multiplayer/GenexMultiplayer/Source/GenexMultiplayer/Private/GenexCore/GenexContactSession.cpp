// A room's declared contact policy as a client runs it (GenexContactSession.h; contact-session.ts).
#include "GenexCore/GenexContactSession.h"

#include "GenexCore/GenexJson.h"

#include <utility>

namespace genex {

namespace {

contact::PolicyBody PolicyOf(const ContactBody& c) {
  contact::PolicyBody p;
  static_cast<ContactBody&>(p) = c;
  return p;
}

/** A seat the policy changed, written back (the TypeScript policy changes the very bodies it is handed). */
void Write(const contact::PolicyBody& p, ContactBody& c) { c = static_cast<const ContactBody&>(p); }

}  // namespace

DeclaredContacts::DeclaredContacts(contact::ContactPolicy policy, const FirstpersonWorld& world)
    : policy_(std::move(policy)),
      world_(std::make_shared<const contact::ContactWorld>(
          contact::CompileContactWorld(world.Boxes(), world.Ramps(), policy_.hull.radius, policy_.hull.height, policy_.hull.skin))) {}

void DeclaredContacts::Rule(ContactBody& a, ContactBody& b) const {
  contact::ContactEnv env;
  env.world = world_.get();
  contact::PolicyBody pa = PolicyOf(a);
  contact::PolicyBody pb = PolicyOf(b);
  contact::ContactPair(pa, pb, policy_, env);
  Write(pa, a);
  Write(pb, b);
}

void DeclaredContacts::Pass(std::vector<ContactBody>& seats) const {
  contact::ContactEnv env;
  env.world = world_.get();
  std::vector<contact::PolicyBody> bodies;
  bodies.reserve(seats.size());
  for (const ContactBody& s : seats) bodies.push_back(PolicyOf(s));
  contact::ContactPass(bodies, policy_, env);
  for (std::size_t i = 0; i < seats.size(); ++i) Write(bodies[i], seats[i]);
}

void DeclaredContacts::DrawRule(const std::string& you, ContactBody& a, ContactBody& b) const {
  contact::ContactEnv env;
  env.world = world_.get();
  env.fixed = you;
  contact::PolicyBody pa = PolicyOf(a);
  contact::PolicyBody pb = PolicyOf(b);
  contact::ContactPair(pa, pb, policy_, env);
  Write(pa, a);
  Write(pb, b);
}

std::shared_ptr<const DeclaredContacts> DeclaredContactsOf(std::string_view presetText, const FirstpersonWorld& world) {
  if (presetText.empty()) return nullptr;
  const std::optional<Json> spec = Json::Parse(presetText);
  if (!spec || !spec->IsObject()) return nullptr;
  const Json* contacts = spec->Find("contacts");
  if (contacts == nullptr) return nullptr;
  std::optional<contact::ContactPolicy> policy = contact::ParseContactPolicy(*contacts);
  if (!policy) return nullptr;
  return std::make_shared<const DeclaredContacts>(std::move(*policy), world);
}

}  // namespace genex
