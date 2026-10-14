// Rows for src/json.*: the template's own JSON reader and writer. Run with no argument for every
// row, or with a row name for one (tests/conformance/cpp-runtime.test.ts runs them by name).
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "json.h"

namespace {

void roundTrip() {
  const char* text = R"({"id":7,"op":"state","arg":{"list":[1,true,null,"x"],"nested":{"a":-2.5}}})";
  json::Parsed parsed = json::parse(text);
  assert(parsed.ok());
  assert(parsed.value.kind() == json::Kind::Object);
  assert(parsed.value["id"].asNumber() == 7);
  assert(parsed.value["op"].asString() == "state");
  assert(parsed.value["arg"]["list"].items().size() == 4);
  assert(parsed.value["arg"]["list"].items()[1].asBool());
  assert(parsed.value["arg"]["list"].items()[2].isNull());
  assert(parsed.value["arg"]["nested"]["a"].asNumber() == -2.5);
  assert(parsed.value["missing"].isNull());
  assert(parsed.value.dump() == text);
  json::Parsed again = json::parse(parsed.value.dump());
  assert(again.ok() && again.value == parsed.value);
}

void numbers() {
  assert(json::Value(0).dump() == "0");
  assert(json::Value(-0.0).dump() == "0");
  assert(json::Value(42).dump() == "42");
  assert(json::Value(0.1).dump() == "0.1");
  assert(json::Value(1.0 / 3.0).dump() == "0.3333333333333333");
  assert(json::Value(1e21).dump() == "1e+21");
  assert(json::Value(std::nan("")).dump() == "null");
  assert(json::Value(INFINITY).dump() == "null");
  assert(json::parse("-12.5e2").value.asNumber() == -1250);
  assert(json::parse("0.1").value.asNumber() == 0.1);
  for (const char* bad : {"01", "1.", ".5", "-", "+1", "1e", "0x10", "NaN", "Infinity"}) {
    assert(!json::parse(bad).ok());
  }
}

void strings() {
  json::Parsed parsed = json::parse(R"("a\"b\\c\/d\n\té😀")");
  assert(parsed.ok());
  assert(parsed.value.asString() == "a\"b\\c/d\n\t\xc3\xa9\xf0\x9f\x98\x80");
  assert(json::Value(std::string("q\"\\\n\x01")).dump() == R"("q\"\\\n\u0001")");
  // A lone surrogate is kept as U+FFFD rather than refused: the text is untrusted, not wrong.
  assert(json::parse(R"("\ud800")").value.asString() == "\xef\xbf\xbd");
  assert(!json::parse("\"raw\ncontrol\"").ok());
  assert(!json::parse(R"("\x")").ok());
  assert(!json::parse(R"("unterminated)").ok());
}

void depthLimit() {
  std::string ok(json::MAX_DEPTH, '[');
  ok += std::string(json::MAX_DEPTH, ']');
  assert(json::parse(ok).ok());
  std::string deep(json::MAX_DEPTH + 1, '[');
  deep += std::string(json::MAX_DEPTH + 1, ']');
  json::Parsed parsed = json::parse(deep);
  assert(!parsed.ok());
  assert(parsed.error == json::ParseError::TooDeep);
  // A hostile depth far past the limit stops at the limit instead of recursing through it.
  std::string hostile(100000, '[');
  assert(json::parse(hostile).error == json::ParseError::TooDeep);
}

void syntaxErrors() {
  for (const char* bad : {"", " ", "{", "}", "[1,]", "{\"a\":}", "{\"a\" 1}", "{a:1}", "[1 2]", "tru", "nul",
                          "{\"a\":1}x", "[1],", "'x'"}) {
    json::Parsed parsed = json::parse(bad);
    assert(!parsed.ok());
    assert(parsed.error == json::ParseError::Syntax);
  }
}

void building() {
  json::Value value = json::Value::object();
  value.set("b", 1);
  value.set("a", "x");
  value.set("b", 2);
  json::Value list = json::Value::array();
  list.push(true);
  list.push(nullptr);
  value.set("list", list);
  assert(value.dump() == R"({"b":2,"a":"x","list":[true,null]})");
  // The last duplicate key wins, as JSON.parse decides it.
  assert(json::parse(R"({"k":1,"k":2})").value["k"].asNumber() == 2);
  assert(json::Value("text").asNumber(9) == 9);
  assert(json::Value(3).asString().empty());
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"round-trip", roundTrip}, {"numbers", numbers},          {"strings", strings},
    {"depth-limit", depthLimit}, {"syntax-errors", syntaxErrors}, {"building", building},
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
