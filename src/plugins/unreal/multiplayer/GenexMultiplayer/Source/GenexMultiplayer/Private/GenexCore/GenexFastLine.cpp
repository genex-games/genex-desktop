#include "GenexCore/GenexFastLine.h"

#include <utility>

namespace genex::fast {
namespace {

const char* Why(const std::string& reason) {
  if (reason == "off") return "the game turned the fast channel off";
  if (reason == "no_udp") return "this platform has no UDP";
  if (reason == "not_offered") return "the room does not offer the fast channel";
  if (reason == "unreachable") return "fell back, the binding could not be used or its socket failed";
  if (reason == "handshake") return "fell back, no UDP snapshot within 1 s of the first datagram (UDP blocked?)";
  if (reason == "stall") return "fell back, no UDP snapshot for 2 s";
  if (reason == "server") return "fell back, the room closed the channel";
  return "unknown";
}

}  // namespace

std::string UdpLine(const std::string& url) { return "genex transport: udp fast@1 " + url; }

std::string WebSocketLine(const std::string& reason) { return "genex transport: websocket, " + reason + ": " + Why(reason); }

std::optional<std::string> FastLineAnnouncer::Once(std::string line) {
  if (!said_.insert(line).second) return std::nullopt;
  return line;
}

std::optional<std::string> FastLineAnnouncer::Observe(const FastLineObservation& o) {
  if (!o.joinedMs) return std::nullopt;
  if (!o.asked) return Once(WebSocketLine("off"));
  if (!o.udp) return Once(WebSocketLine("no_udp"));
  if (o.fallback) return Once(WebSocketLine(*o.fallback));
  if (o.url) return o.snapshots > 0 ? Once(UdpLine(*o.url)) : std::nullopt;
  return *o.joinedMs >= kOfferWaitMs ? Once(WebSocketLine("not_offered")) : std::nullopt;
}

}  // namespace genex::fast
