// The one line a seat says about its transport (PROTOCOL.md §17.12 *The transport line*), so nobody is on the
// WebSocket without knowing: once a socket's transport is known, and again if it falls back. The words are the
// same in every port, held to `transportLine` in the shared vectors. A port of the TypeScript `fast-line.ts`.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <optional>
#include <set>
#include <string>

namespace genex::fast {

/** How long after a socket's first state a seat waits for its binding before it says the room offered none. */
constexpr double kOfferWaitMs = 1000;

/** The line for a seat on UDP to `url`. */
GENEX_CORE_API std::string UdpLine(const std::string& url);
/** The line for a seat on the WebSocket because of `reason` (`off`, `no_udp`, `not_offered` or a fallback's name). */
GENEX_CORE_API std::string WebSocketLine(const std::string& reason);

/** What a seat knows of its channel at one instant. */
struct FastLineObservation {
  /** The game left the channel on. */
  bool asked = true;
  /** This runtime has a UDP socket to open. */
  bool udp = true;
  /** Milliseconds since this socket's first state; none before it. */
  std::optional<double> joinedMs;
  /** The binding's url; none before one came. */
  std::optional<std::string> url;
  /** Snapshots applied on this socket. */
  int snapshots = 0;
  /** Why this socket fell back; none if it has not. */
  std::optional<std::string> fallback;
};

/** Says each line once per socket. */
class GENEX_CORE_API FastLineAnnouncer {
 public:
  /** The line this instant owes, or none. */
  std::optional<std::string> Observe(const FastLineObservation& o);
  /** A new socket: everything may be said again. */
  void Reset() { said_.clear(); }

 private:
  std::optional<std::string> Once(std::string line);
  std::set<std::string> said_;
};

}  // namespace genex::fast
