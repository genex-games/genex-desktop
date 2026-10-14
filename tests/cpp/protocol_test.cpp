// Rows for src/protocol.*: NDJSON framing with the 1 MiB line cap, and the request envelope's
// refusals. Run with no argument for every row, or with a row name for one.
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "json.h"
#include "protocol.h"

namespace {

using studio::protocol::ByteSource;
using studio::protocol::Dispatcher;
using studio::protocol::LineReader;
using studio::protocol::LineStatus;
using studio::protocol::MAX_LINE_BYTES;

/** A byte source that hands out its chunks one read at a time, however large the caller's buffer. */
class Chunks : public ByteSource {
 public:
  explicit Chunks(std::vector<std::string> chunks) : chunks_(std::move(chunks)) {}
  long read(char* into, std::size_t capacity) override {
    while (next_ < chunks_.size() && offset_ == chunks_[next_].size()) {
      ++next_;
      offset_ = 0;
    }
    if (next_ == chunks_.size()) return 0;
    const std::string& chunk = chunks_[next_];
    std::size_t count = std::min(capacity, chunk.size() - offset_);
    std::memcpy(into, chunk.data() + offset_, count);
    offset_ += count;
    return static_cast<long>(count);
  }

 private:
  std::vector<std::string> chunks_;
  std::size_t next_ = 0;
  std::size_t offset_ = 0;
};

/** Every line a reader yields until the end, with the too-long ones marked. */
std::vector<std::string> drain(LineReader& reader) {
  std::vector<std::string> lines;
  for (;;) {
    studio::protocol::NextLine next = reader.next();
    if (next.status == LineStatus::End) return lines;
    lines.push_back(next.status == LineStatus::TooLong ? "<too-long>" : next.text);
  }
}

Dispatcher dispatcher() {
  Dispatcher calls;
  calls.on("state", [](const json::Value&) { return studio::protocol::answer(json::Value::object()); });
  calls.on("seed", [](const json::Value& arg) {
    json::Value result = json::Value::object();
    result.set("seed", arg["seed"].asNumber());
    return studio::protocol::answer(result);
  });
  calls.on("demo", [](const json::Value&) { return studio::protocol::refuse("no-such-demo"); });
  return calls;
}

json::Value reply(std::string_view line) {
  json::Parsed parsed = json::parse(dispatcher().handle(line));
  assert(parsed.ok());
  return parsed.value;
}

void framing() {
  Chunks source({"{\"id\":1}\n{\"id\"", ":2}\r\n\n", "{\"id\":3}", "\n", "tail-without-newline"});
  LineReader reader(source);
  std::vector<std::string> lines = drain(reader);
  std::vector<std::string> expected = {"{\"id\":1}", "{\"id\":2}", "{\"id\":3}", "tail-without-newline"};
  assert(lines == expected);
  assert(reader.next().status == LineStatus::End);
}

void cap() {
  std::string exact(MAX_LINE_BYTES, 'a');
  std::string over(MAX_LINE_BYTES + 1, 'b');
  Chunks source({exact + "\n", over.substr(0, 1000), over.substr(1000) + "\n{\"id\":9}\n"});
  LineReader reader(source);
  std::vector<std::string> lines = drain(reader);
  assert(lines.size() == 3);
  assert(lines[0] == exact);
  assert(lines[1] == "<too-long>");
  assert(lines[2] == "{\"id\":9}");
  json::Value refused = json::parse(dispatcher().lineTooLong()).value;
  assert(refused["ok"].is(json::Kind::Bool) && !refused["ok"].asBool());
  assert(refused["error"].asString() == studio::protocol::Refusal::LineTooLong);
}

void nonObject() {
  for (const char* line : {"[1,2]", "\"state\"", "3", "null", "true"}) {
    json::Value refused = reply(line);
    assert(!refused["ok"].asBool());
    assert(refused["error"].asString() == studio::protocol::Refusal::NotAnObject);
    assert(refused["id"].isNull());
  }
  assert(reply("{not json")["error"].asString() == studio::protocol::Refusal::BadJson);
}

void missingId() {
  for (const char* line : {R"({"op":"state"})", R"({"id":null,"op":"state"})", R"({"id":true,"op":"state"})",
                           R"({"id":{},"op":"state"})"}) {
    json::Value refused = reply(line);
    assert(!refused["ok"].asBool());
    assert(refused["error"].asString() == studio::protocol::Refusal::MissingId);
    assert(refused["op"].asString() == "state");
  }
}

void unknownOp() {
  for (const char* line : {R"({"id":4,"op":"launch"})", R"({"id":4})", R"({"id":4,"op":7})"}) {
    json::Value refused = reply(line);
    assert(!refused["ok"].asBool());
    assert(refused["id"].asNumber() == 4);
    assert(refused["error"].asString() == studio::protocol::Refusal::UnknownOp);
    const json::Value::Array& available = refused["available"].items();
    assert(available.size() == 3);
    assert(available[0].asString() == "demo");
    assert(available[1].asString() == "seed");
    assert(available[2].asString() == "state");
  }
}

void depth() {
  std::string arg(31, '[');
  arg += std::string(31, ']');
  json::Value accepted = reply(R"({"id":5,"op":"state","arg":)" + arg + "}");
  assert(accepted["ok"].asBool());
  std::string deep(32, '[');
  deep += std::string(32, ']');
  json::Value refused = reply(R"({"id":5,"op":"state","arg":)" + deep + "}");
  assert(!refused["ok"].asBool());
  assert(refused["error"].asString() == studio::protocol::Refusal::TooDeep);
}

void replies() {
  json::Value seeded = reply(R"({"id":"a1","op":"seed","arg":{"seed":12}})");
  assert(seeded["id"].asString() == "a1");
  assert(seeded["ok"].asBool());
  assert(seeded["op"].asString() == "seed");
  assert(seeded["result"]["seed"].asNumber() == 12);
  json::Value refused = reply(R"({"id":2,"op":"demo","arg":{"name":"x"}})");
  assert(!refused["ok"].asBool());
  assert(refused["op"].asString() == "demo");
  assert(refused["error"].asString() == "no-such-demo");
  assert(refused.find("available") == nullptr);
  json::Value fields = json::Value::object();
  fields.set("focused", true);
  json::Value event = json::parse(studio::protocol::event("focus", fields)).value;
  assert(event["event"].asString() == "focus");
  assert(event["focused"].asBool());
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"framing", framing},       {"cap", cap},     {"non-object", nonObject}, {"missing-id", missingId},
    {"unknown-op", unknownOp}, {"depth", depth}, {"replies", replies},
};

}  // namespace

int main(int argc, char** argv) {
  int ran = 0;
  for (const Row& row : ROWS) {
    if (argc > 1 && std::strcmp(argv[1], row.name) != 0) continue;
    row.run();
    std::printf("ok %s\n", row.name);
    ++ran;
  }
  if (ran > 0) return 0;
  std::fprintf(stderr, "no row named %s\n", argc > 1 ? argv[1] : "(none)");
  return 2;
}
