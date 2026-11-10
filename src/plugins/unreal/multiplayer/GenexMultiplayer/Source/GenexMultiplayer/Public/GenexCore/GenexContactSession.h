// A room's declared contact policy as a client runs it (PROTOCOL.md §17.11 *Contact policy*): the resolved
// policy the host publishes as the `contacts` of the state's `preset` text, turned into the seat contact rule and
// the pass the session's prediction, replay and drawing guard run, through this client's world. A port of
// packages/multiplayer/src/authority/contact-session.ts (the policy's parse is held to contact-policy.json's
// config rows by core/tools/contact_policy_check.cpp; the session's use of it by the `declaredContacts`
// conformance check, packages/netcode-bench/src/authority/declared-contacts-checks.ts).
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexContactConfig.h"
#include "GenexCore/GenexContactPolicy.h"
#include "GenexCore/GenexContactWorld.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexCore/GenexSeatContacts.h"
#include "GenexCore/GenexSeatPredict.h"

#include <map>
#include <memory>
#include <string>
#include <string_view>

namespace genex {

/** A declared policy as the session runs it: the pair rule, the whole pass, and the pair rule a drawing runs
 *  against your entity. */
class GENEX_CORE_API DeclaredContacts {
 public:
  DeclaredContacts(contact::ContactPolicy policy, const FirstpersonWorld& world);

  const contact::ContactPolicy& Policy() const { return policy_; }
  /** The policy's pair rule over two seats (contact-policy.ts contactRuleOf). */
  void Rule(ContactBody& a, ContactBody& b) const;
  /** The policy's pass over every seat, ids ascending (contactPassOf). */
  void Pass(std::vector<ContactBody>& seats) const;
  /** The pair rule a drawing runs against your entity `you` (its id): yours fixed, the other seat taking the whole
   *  push its way allows (§17.11 *Drawing other seats*). */
  void DrawRule(const std::string& you, ContactBody& a, ContactBody& b) const;

 private:
  contact::ContactPolicy policy_;
  std::shared_ptr<const contact::ContactWorld> world_;
};

/** The policy the room's preset text declares (`{ name, params, contacts }`), run through `world` (the static world
 *  this client steps the preset through); null when the text declares none, or not a resolved policy. */
GENEX_CORE_API std::shared_ptr<const DeclaredContacts> DeclaredContactsOf(std::string_view presetText, const FirstpersonWorld& world);

}  // namespace genex
