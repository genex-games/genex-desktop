// NDJSON framing and the request envelope declared in protocol.h. raylib-free.
#include "protocol.h"

#include <utility>

namespace studio::protocol {

namespace {

/** How many bytes one read asks for; the buffer grows by this much, never by a whole line. */
constexpr std::size_t READ_CHUNK_BYTES = 64 * 1024;

/** `{id, ok:false, op, error, available?}` as a line. */
std::string refusalLine(const json::Value& id, const json::Value& op, std::string_view error,
                        const std::vector<std::string>* available) {
  json::Value reply = json::Value::object();
  reply.set("id", id);
  reply.set("ok", false);
  reply.set("op", op);
  reply.set("error", error);
  if (available) {
    json::Value ops = json::Value::array();
    for (const std::string& name : *available) ops.push(name);
    reply.set("available", std::move(ops));
  }
  return reply.dump();
}

/** The reply line for a handler's answer. */
std::string answerLine(const json::Value& id, std::string_view op, const Answer& answer) {
  if (!answer.ok) return refusalLine(id, json::Value(op), answer.error, nullptr);
  json::Value reply = json::Value::object();
  reply.set("id", id);
  reply.set("ok", true);
  reply.set("op", op);
  reply.set("result", answer.result);
  return reply.dump();
}

bool isRequestId(const json::Value* id) { return id && (id->is(json::Kind::Number) || id->is(json::Kind::String)); }

}  // namespace

LineReader::LineReader(ByteSource& source, std::size_t cap) : source_(source), cap_(cap) {}

bool LineReader::fill() {
  std::size_t kept = pending_.size();
  pending_.resize(kept + READ_CHUNK_BYTES);
  long count = source_.read(pending_.data() + kept, READ_CHUNK_BYTES);
  pending_.resize(kept + (count > 0 ? static_cast<std::size_t>(count) : 0));
  return count > 0;
}

NextLine LineReader::next() {
  for (;;) {
    std::size_t newline = pending_.find('\n');
    if (newline != std::string::npos) {
      bool tail = dropping_;
      std::string line = pending_.substr(0, newline);
      pending_.erase(0, newline + 1);
      dropping_ = false;
      if (tail) continue;  // the rest of a line already reported as too long
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.size() > cap_) return {LineStatus::TooLong, {}};
      if (line.empty()) continue;
      return {LineStatus::Line, std::move(line)};
    }
    if (dropping_) {
      pending_.clear();
    } else if (pending_.size() > cap_ + 1) {  // + 1: a line of exactly the cap may still end in CR
      pending_.clear();
      dropping_ = true;
      return {LineStatus::TooLong, {}};
    }
    if (ended_) {
      // What is left is a last line with no newline; once it is taken, the buffer stays empty.
      std::string line = std::move(pending_);
      pending_.clear();
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) return {LineStatus::End, {}};
      if (line.size() > cap_) return {LineStatus::TooLong, {}};
      return {LineStatus::Line, std::move(line)};
    }
    if (!fill()) ended_ = true;
  }
}

Answer answer(json::Value result) { return Answer{true, std::move(result), {}}; }

Answer refuse(std::string_view error) { return Answer{false, json::Value(), std::string(error)}; }

void Dispatcher::on(std::string op, Handler handler) { handlers_[std::move(op)] = std::move(handler); }

std::vector<std::string> Dispatcher::ops() const {
  std::vector<std::string> names;
  for (const auto& entry : handlers_) names.push_back(entry.first);
  return names;
}

bool Dispatcher::has(std::string_view op) const { return handlers_.find(op) != handlers_.end(); }

std::string Dispatcher::handle(std::string_view line) const {
  json::Parsed parsed = json::parse(line, MAX_DEPTH);
  if (!parsed.ok()) {
    std::string_view why = parsed.error == json::ParseError::TooDeep ? Refusal::TooDeep : Refusal::BadJson;
    return refusalLine(json::Value(), json::Value(), why, nullptr);
  }
  const json::Value& request = parsed.value;
  if (!request.is(json::Kind::Object)) return refusalLine(json::Value(), json::Value(), Refusal::NotAnObject, nullptr);
  const json::Value& op = request["op"];
  const json::Value* id = request.find("id");
  json::Value named = op.is(json::Kind::String) ? op : json::Value();
  if (!isRequestId(id)) return refusalLine(json::Value(), named, Refusal::MissingId, nullptr);
  auto handler = op.is(json::Kind::String) ? handlers_.find(op.asString()) : handlers_.end();
  if (handler == handlers_.end()) {
    std::vector<std::string> available = ops();
    return refusalLine(*id, named, Refusal::UnknownOp, &available);
  }
  return answerLine(*id, op.asString(), handler->second(request["arg"]));
}

std::string Dispatcher::lineTooLong() const {
  return refusalLine(json::Value(), json::Value(), Refusal::LineTooLong, nullptr);
}

std::string Dispatcher::call(std::string_view op, const json::Value& arg) const {
  auto handler = handlers_.find(op);
  if (handler == handlers_.end()) {
    std::vector<std::string> available = ops();
    return refusalLine(json::Value(), json::Value(op), Refusal::UnknownOp, &available);
  }
  return answerLine(json::Value(), op, handler->second(arg));
}

std::string event(std::string_view name, const json::Value& fields) {
  json::Value line = json::Value::object();
  line.set("event", name);
  for (const json::Value::Member& member : fields.members()) {
    if (member.key != "event") line.set(member.key, member.value);
  }
  return line.dump();
}

}  // namespace studio::protocol
