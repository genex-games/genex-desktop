// See GenexFastClient.h (packages/multiplayer/src/authority/fast-client.ts and fast-udp.ts's udpEndpoint).
#include "GenexCore/GenexFastClient.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace genex::fast {

namespace client_detail {

constexpr double kUint32Max = 4294967295.0;
constexpr int kPortMax = 65535;
constexpr std::string_view kUdpScheme = "udp://";

bool IsUint(double v, double max) { return std::isfinite(v) && std::floor(v) == v && v >= 0 && v <= max; }

std::string RecordName(RecordKind kind, const std::string& id) {
  return std::to_string(static_cast<int>(kind)) + ":" + id;
}

bool IsHostNameChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~';
}

bool IsIpv6Char(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == ':' || c == '.'; }

/** Digits only, 1..65535 (leading zeros taken, as WHATWG does). */
std::optional<int> PortOf(std::string_view text) {
  if (text.empty()) return std::nullopt;
  long value = 0;
  for (char c : text) {
    if (c < '0' || c > '9') return std::nullopt;
    value = value * 10 + (c - '0');
    if (value > kPortMax) return std::nullopt;
  }
  if (value < 1) return std::nullopt;
  return static_cast<int>(value);
}

bool SchemeIsUdp(std::string_view url) {
  if (url.size() < kUdpScheme.size()) return false;
  for (std::size_t i = 0; i < kUdpScheme.size(); i += 1) {
    const char c = url[i];
    const char lower = c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
    if (lower != kUdpScheme[i]) return false;
  }
  return true;
}

}  // namespace client_detail

namespace cd = client_detail;

std::optional<BindMessage> FastBindOf(const Json& message) {
  if (!message.IsObject()) return std::nullopt;
  const Json* sid = message.Find("sid");
  const Json* key = message.Find("key");
  const Json* url = message.Find("url");
  const bool sidOk = sid != nullptr && sid->IsNumber() && cd::IsUint(sid->AsNumber(), cd::kUint32Max);
  const bool keyOk = key != nullptr && key->IsString() && IsKey(key->AsString());
  const bool urlOk = url != nullptr && url->IsString() && !url->AsString().empty();
  if (!sidOk || !keyOk || !urlOk) return std::nullopt;
  BindMessage bind;
  bind.sid = sid->AsNumber();
  bind.key = key->AsString();
  bind.url = url->AsString();
  const Json* rev = message.Find("rev");
  bind.rev = rev != nullptr && rev->IsNumber() ? static_cast<int>(rev->AsNumber()) : 0;
  const Json* probe = message.Find("probe");
  bind.probe = probe != nullptr && probe->AsBool();
  return bind;
}

std::optional<UdpTarget> UdpEndpoint(std::string_view url) {
  if (!cd::SchemeIsUdp(url)) return std::nullopt;
  const std::string_view rest = url.substr(cd::kUdpScheme.size());
  const std::size_t end = rest.find_first_of("/?#");
  const std::string_view authority = rest.substr(0, end);
  const std::string_view tail = end == std::string_view::npos ? std::string_view() : rest.substr(end);
  // No path but a bare `/`, and no query or fragment at all.
  if (!tail.empty() && tail != "/") return std::nullopt;
  std::string_view host;
  std::string_view port;
  if (!authority.empty() && authority.front() == '[') {
    const std::size_t close = authority.find(']');
    if (close == std::string_view::npos || close + 1 >= authority.size() || authority[close + 1] != ':') return std::nullopt;
    host = authority.substr(1, close - 1);
    port = authority.substr(close + 2);
    const bool ipv6 = host.find(':') != std::string_view::npos && std::all_of(host.begin(), host.end(), cd::IsIpv6Char);
    if (!ipv6) return std::nullopt;
  } else {
    const std::size_t colon = authority.rfind(':');
    if (colon == std::string_view::npos) return std::nullopt;
    host = authority.substr(0, colon);
    port = authority.substr(colon + 1);
    // Credentials (`@`), an unbracketed IPv6 host (another `:`) and any other byte are refused here.
    if (host.empty() || !std::all_of(host.begin(), host.end(), cd::IsHostNameChar)) return std::nullopt;
  }
  const std::optional<int> number = cd::PortOf(port);
  if (host.empty() || !number) return std::nullopt;
  return UdpTarget{std::string(host), *number};
}

DatagramSocket::~DatagramSocket() = default;

const char* FallbackReasonName(FallbackReason reason) {
  switch (reason) {
    case FallbackReason::Unreachable: return "unreachable";
    case FallbackReason::Handshake: return "handshake";
    case FallbackReason::Stall: return "stall";
    case FallbackReason::Server: return "server";
  }
  return "unreachable";
}

std::vector<FastInput> HeldInputs(const std::vector<FastInput>& sent, double inputAck, double tickHz) {
  if (sent.empty()) return {};
  const double newest = sent.back().seq;
  const double keepFrom = (std::min)(inputAck, newest - InputRedundancyTicks(tickHz) + 1);
  const double capped = (std::max)(keepFrom, newest - SeqAheadMax(tickHz) + 1);
  std::vector<FastInput> held;
  for (const FastInput& s : sent) {
    if (s.seq >= capped) held.push_back(s);
  }
  return held;
}

std::unique_ptr<FastClient> FastClient::Open(FastClientOptions o) {
  if (!o.open) return nullptr;
  std::unique_ptr<DatagramSocket> socket = o.open(o.bind.url);
  if (socket == nullptr) return nullptr;
  std::unique_ptr<FastClient> client(new FastClient(std::move(o)));
  client->socket_ = std::move(socket);
  return client;
}

FastClient::FastClient(FastClientOptions o) : options_(std::move(o)) {}

FastClient::~FastClient() { Close(); }

void FastClient::Queue(const FastInput& input) {
  if (closed_) return;
  sent_.push_back(input);
  fresh_ += 1;
}

void FastClient::Flush() {
  if (closed_ || fresh_ == 0) return;
  const double now = options_.now();
  const std::size_t total = sent_.size();
  const std::size_t freshCount = (std::min)(static_cast<std::size_t>(fresh_), total);
  for (std::size_t i = total - freshCount; i < total; i += 1) sentTimes_[sent_[i].seq] = now;
  if (total > 0) sentTimes_.erase(sentTimes_.begin(), sentTimes_.lower_bound(sent_.back().seq - SeqAheadMax(options_.tickHz) + 1));
  // More new inputs than one window holds (a frame after a hitch, or the inputs sent before the binding):
  // one datagram a window's worth, oldest first, so none rides only as a fill.
  const auto window = static_cast<std::size_t>(InputRedundancyTicks(options_.tickHz));
  std::size_t from = total - freshCount;
  fresh_ = 0;
  while (from < total) {
    const std::size_t to = (std::min)(from + window, total);
    UplinkOptions u;
    u.sid = options_.bind.sid;
    u.key = options_.bind.key;
    u.ackSnap = rx_.newest;
    u.inputAck = InputAck();
    u.fresh = static_cast<double>(to - from);
    u.tickHz = options_.tickHz;
    const Result<Bytes> bytes = EncodeUplink(UplinkFor(sent_.data(), to, u));
    from = to;
    if (!bytes.Ok()) continue;
    if (!firstSentAt_) firstSentAt_ = now;
    lastUplinkAt_ = now;
    socket_->Send(bytes.value->data(), bytes.value->size());
  }
}

void FastClient::SendEmpty() {
  if (closed_ || options_.bind.rev < kBindRev) return;
  Uplink u;
  u.sid = options_.bind.sid;
  u.key = options_.bind.key;
  u.ackSnap = rx_.newest;
  u.fresh = 0;
  const Result<Bytes> bytes = EncodeUplink(u);
  if (!bytes.Ok()) return;
  const double now = options_.now();
  if (!firstSentAt_) firstSentAt_ = now;
  lastUplinkAt_ = now;
  socket_->Send(bytes.value->data(), bytes.value->size());
}

void FastClient::Keepalive() {
  const double every = lastAppliedAt_ ? kKeepaliveMs : kKeepaliveBindMs;
  if (!lastUplinkAt_ || options_.now() - *lastUplinkAt_ >= every) SendEmpty();
}

void FastClient::Framed() {
  const double now = options_.now();
  const double gap = lastFrameAt_ ? now - *lastFrameAt_ : 0;
  lastFrameAt_ = now;
  if (gap <= kFrameGapMs) return;
  if (lastAppliedAt_) lastAppliedAt_ = (std::min)(now, *lastAppliedAt_ + gap);
  if (firstSentAt_) firstSentAt_ = (std::min)(now, *firstSentAt_ + gap);
}

std::vector<MotionRecord> FastClient::AllRecords() const {
  std::vector<MotionRecord> out;
  out.reserve(latest_.size());
  for (const auto& entry : latest_) out.push_back(entry.second);
  return out;
}

const FastInput* FastClient::InputAt(double seq) const {
  for (const FastInput& s : sent_) {
    if (s.seq == seq) return &s;
  }
  return nullptr;
}

std::optional<double> FastClient::SentAt(double seq) const {
  const auto it = sentTimes_.find(seq);
  if (it == sentTimes_.end()) return std::nullopt;
  return it->second;
}

const MotionRecord* FastClient::MotionOf(RecordKind kind, const std::string& id) const {
  const auto it = latest_.find(cd::RecordName(kind, id));
  return it == latest_.end() ? nullptr : &it->second;
}

std::optional<FallbackReason> FastClient::Due() const {
  if (closed_) return std::nullopt;
  const double now = options_.now();
  if (lastAppliedAt_) {
    if (now - *lastAppliedAt_ > kStallFallbackMs) return FallbackReason::Stall;
    return std::nullopt;
  }
  if (firstSentAt_ && now - *firstSentAt_ > kHandshakeMs) return FallbackReason::Handshake;
  return std::nullopt;
}

std::vector<MotionRecord> FastClient::DecodeChanged(const Records& records) {
  std::map<double, Decoded> nextByKey;
  std::map<std::string, MotionRecord> nextLatest;
  std::vector<MotionRecord> changed;
  for (const KeyedRecord& r : records) {
    const auto before = decodedByKey_.find(r.key);
    const bool same = before != decodedByKey_.end() && before->second.bytes == r.bytes;
    std::optional<MotionRecord> record;
    if (same) {
      record = before->second.record;
    } else {
      Result<MotionRecord> d = DecodeRecord(r.bytes.data(), r.bytes.size());
      if (d.Ok()) record = std::move(d.value);
    }
    nextByKey[r.key] = Decoded{r.bytes, record};
    if (!record) continue;
    nextLatest[cd::RecordName(record->kind, record->id)] = *record;
    if (!same) changed.push_back(*record);
  }
  decodedByKey_ = std::move(nextByKey);
  latest_ = std::move(nextLatest);
  return changed;
}

Receipt FastClient::Receive(const std::uint8_t* data, std::size_t length) {
  Receipt receipt;
  if (closed_) return receipt;
  const ReceiveResult r = ReceiveFragment(rx_, data, length, options_.bind.sid);
  if (r.fault || !r.applied) {
    receipt.fault = r.fault;
    return receipt;
  }
  if (rx_.history.empty()) return receipt;
  const HeldSnapshot& held = rx_.history.back();
  const double now = options_.now();
  const double before = lastAppliedSnap_;
  lastAppliedSnap_ = held.snap;
  lastAppliedAt_ = now;
  sent_ = HeldInputs(sent_, held.inputAck, options_.tickHz);
  FastSnapshot applied{held.snap, held.tick, held.inputAck, held.sent, DecodeChanged(held.records)};
  if (options_.onSnapshot) options_.onSnapshot(applied);
  const bool eager = applied.changed.size() >= kAckEagerRecords && (!lastUplinkAt_ || now - *lastUplinkAt_ >= kAckEagerGapMs);
  if (applied.snap - before >= kChallengeJump || eager) SendEmpty();
  receipt.applied = std::move(applied);
  return receipt;
}

void FastClient::Poll() {
  if (closed_ || socket_ == nullptr) return;
  socket_->Poll([this](const std::uint8_t* data, std::size_t length) { Receive(data, length); });
}

void FastClient::Close() {
  if (closed_) return;
  closed_ = true;
  if (socket_ != nullptr) socket_->Close();
}

}  // namespace genex::fast
