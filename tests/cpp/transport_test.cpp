// Rows for src/transport.*: the native studio connection. Each row builds its own socket pair (the
// shape the host's fourth stdio slot has: one duplex descriptor) and plays the studio's end
// itself, so nothing outside this process is touched. Run with no argument for every row, or
// with a row name for one.
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "json.h"
#include "paths.h"
#include "protocol.h"
#include "transport.h"

namespace {

using studio::transport::Served;
using studio::transport::Transport;

/** How long a row waits for a line or an answer before it fails instead of hanging. */
constexpr int WAIT_MS = 5000;
/** The descriptor the studio names: the game's end of the pair is moved here. */
constexpr int STUDIO_FD = 3;

/** A connected socket pair: the game's end and the studio's. */
struct Pair {
  int game = -1;
  int studio = -1;
};

Pair socketPair() {
  int fds[2] = {-1, -1};
  int made = socketpair(AF_UNIX, SOCK_STREAM, 0, fds);
  assert(made == 0);
  return {fds[0], fds[1]};
}

void writeAll(int fd, std::string_view text) {
  while (!text.empty()) {
    ssize_t wrote = write(fd, text.data(), text.size());
    assert(wrote > 0);
    text.remove_prefix(static_cast<std::size_t>(wrote));
  }
}

/** One line from `fd` (the newline dropped), or nothing at the end or after WAIT_MS. */
std::optional<std::string> readLine(int fd, std::string& buffer) {
  for (;;) {
    std::size_t newline = buffer.find('\n');
    if (newline != std::string::npos) {
      std::string line = buffer.substr(0, newline);
      buffer.erase(0, newline + 1);
      return line;
    }
    pollfd waiting{fd, POLLIN, 0};
    if (poll(&waiting, 1, WAIT_MS) <= 0) return std::nullopt;
    char chunk[65536];
    ssize_t got = read(fd, chunk, sizeof chunk);
    if (got <= 0) return std::nullopt;
    buffer.append(chunk, static_cast<std::size_t>(got));
  }
}

json::Value parsed(const std::optional<std::string>& line) {
  assert(line.has_value());
  json::Parsed value = json::parse(*line);
  assert(value.ok());
  return value.value;
}

/** An environment from a table. */
studio::paths::Env envOf(std::map<std::string, std::string, std::less<>> vars) {
  return [vars = std::move(vars)](std::string_view name) -> std::optional<std::string> {
    auto found = vars.find(name);
    if (found == vars.end()) return std::nullopt;
    return found->second;
  };
}

studio::protocol::Dispatcher calls() {
  studio::protocol::Dispatcher dispatcher;
  dispatcher.on("state", [](const json::Value&) {
    json::Value result = json::Value::object();
    result.set("frame", 0);
    return studio::protocol::answer(std::move(result));
  });
  return dispatcher;
}

/** Serve until `answers` requests were answered or the channel ended; fails after WAIT_MS of nothing. */
Served serveUntil(Transport& link, const studio::protocol::Dispatcher& dispatcher, int answers) {
  Served total;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(WAIT_MS);
  while (total.answered < answers && !total.ended) {
    assert(std::chrono::steady_clock::now() < deadline);
    link.wait(50);
    Served served = studio::transport::serve(link, dispatcher);
    total.answered += served.answered;
    total.ended = total.ended || served.ended;
  }
  return total;
}

std::unique_ptr<Transport> overPair(const Pair& pair) {
  std::unique_ptr<studio::transport::Channel> channel = studio::transport::descriptorChannel(pair.game);
  assert(channel);
  return std::make_unique<Transport>(std::move(channel), "nonce-1");
}

/**
 * Without both variables, or with anything but descriptor 3, there is no transport and fd 3 is
 * untouched; with both but no descriptor 3 open, there is none either and nothing takes its place.
 */
void inactive() {
  Pair pair = socketPair();
  int moved = dup2(pair.game, STUDIO_FD);
  assert(moved == STUDIO_FD);
  const std::string longNonce(studio::transport::MAX_NONCE_BYTES + 1, 'n');
  const std::vector<std::map<std::string, std::string, std::less<>>> hostile = {
      {},
      {{"GENEX_STUDIO_FD", "3"}},
      {{"GENEX_STUDIO_NONCE", "nonce-1"}},
      {{"GENEX_STUDIO_FD", "3"}, {"GENEX_STUDIO_NONCE", ""}},
      {{"GENEX_STUDIO_FD", "4"}, {"GENEX_STUDIO_NONCE", "nonce-1"}},
      {{"GENEX_STUDIO_FD", "03"}, {"GENEX_STUDIO_NONCE", "nonce-1"}},
      {{"GENEX_STUDIO_FD", " 3"}, {"GENEX_STUDIO_NONCE", "nonce-1"}},
      {{"GENEX_STUDIO_FD", "0"}, {"GENEX_STUDIO_NONCE", "nonce-1"}},
      {{"GENEX_STUDIO_FD", "-1"}, {"GENEX_STUDIO_NONCE", "nonce-1"}},
      {{"GENEX_STUDIO_FD", "3"}, {"GENEX_STUDIO_NONCE", longNonce}},
  };
  for (const auto& vars : hostile) assert(studio::transport::fromEnvironment(envOf(vars)) == nullptr);
  // Nothing was read from fd 3 and nothing was closed: what the studio writes is still there.
  writeAll(pair.studio, "untouched\n");
  std::string buffer;
  std::optional<std::string> line = readLine(STUDIO_FD, buffer);
  assert(line && *line == "untouched");
  // Both variables: the transport reads fd 3 and carries the nonce `ready` echoes.
  const studio::paths::Env valid = envOf({{"GENEX_STUDIO_FD", "3"}, {"GENEX_STUDIO_NONCE", "nonce-1"}});
  std::unique_ptr<Transport> link = studio::transport::fromEnvironment(valid);
  assert(link && link->nonce() == "nonce-1");
  link.reset();  // the channel closes fd 3
  // Both variables while descriptor 3 is closed: no transport, and no descriptor of its own (its
  // wake pipe) lands on 3, the lowest free one, in its place.
  close(STUDIO_FD);
  assert(fcntl(STUDIO_FD, F_GETFD) < 0);
  assert(studio::transport::fromEnvironment(valid) == nullptr);
  assert(fcntl(STUDIO_FD, F_GETFD) < 0);
  close(pair.studio);
  close(pair.game);
}

/** A 2 MiB line is answered with line-too-long, and the line after it still gets its answer. */
void tooLong() {
  Pair pair = socketPair();
  std::unique_ptr<Transport> link = overPair(pair);
  std::thread studioSide([&pair] {
    writeAll(pair.studio, std::string(2 * 1024 * 1024, 'a') + "\n" + R"({"id":2,"op":"state"})" + "\n");
  });
  Served served = serveUntil(*link, calls(), 2);
  studioSide.join();
  assert(served.answered == 2 && !served.ended);
  std::string buffer;
  json::Value refused = parsed(readLine(pair.studio, buffer));
  assert(!refused["ok"].asBool());
  assert(refused["error"].asString() == studio::protocol::Refusal::LineTooLong);
  json::Value answered = parsed(readLine(pair.studio, buffer));
  assert(answered["id"].asNumber() == 2 && answered["ok"].asBool());
  link.reset();
  close(pair.studio);
}

/** Requests sent in one write are answered in order, one whole line each. */
void order() {
  Pair pair = socketPair();
  std::unique_ptr<Transport> link = overPair(pair);
  std::string requests;
  for (int id = 1; id <= 50; ++id) requests += R"({"id":)" + std::to_string(id) + R"(,"op":"state"})" + "\n";
  writeAll(pair.studio, requests);
  Served served = serveUntil(*link, calls(), 50);
  assert(served.answered == 50);
  std::string buffer;
  for (int id = 1; id <= 50; ++id) assert(parsed(readLine(pair.studio, buffer))["id"].asNumber() == id);
  link.reset();
  close(pair.studio);
}

/** The studio closing its end is the end: every request before it is still answered. */
void eof() {
  Pair pair = socketPair();
  std::unique_ptr<Transport> link = overPair(pair);
  writeAll(pair.studio, std::string(R"({"id":1,"op":"state"})") + "\n");
  shutdown(pair.studio, SHUT_WR);
  Served served = serveUntil(*link, calls(), 2);
  assert(served.answered == 1 && served.ended);
  std::string buffer;
  assert(parsed(readLine(pair.studio, buffer))["id"].asNumber() == 1);
  link.reset();
  close(pair.studio);
}

/** Once the studio is gone, send() says so and the process lives on (no SIGPIPE). */
void epipe() {
  Pair pair = socketPair();
  std::unique_ptr<Transport> link = overPair(pair);
  close(pair.studio);
  bool sent = true;
  for (int i = 0; i < 64 && sent; ++i) sent = link->send(std::string(4096, 'x'));
  assert(!sent);
  assert(!link->send("{}"));
  link.reset();
}

/** Two threads sending at once never interleave inside a line. */
void wholeLines() {
  Pair pair = socketPair();
  std::unique_ptr<Transport> link = overPair(pair);
  constexpr int LINES = 200;
  std::vector<std::string> got;
  std::thread studioSide([&pair, &got] {
    std::string buffer;
    for (int i = 0; i < 2 * LINES; ++i) {
      std::optional<std::string> line = readLine(pair.studio, buffer);
      assert(line);
      got.push_back(*line);
    }
  });
  auto sender = [&link](char fill) {
    for (int i = 0; i < LINES; ++i) assert(link->send(std::string(8192, fill)));
  };
  std::thread first(sender, 'x');
  std::thread second(sender, 'y');
  first.join();
  second.join();
  studioSide.join();
  for (const std::string& line : got) {
    assert(line.size() == 8192);
    assert(line.find_first_not_of(line[0]) == std::string::npos);
  }
  link.reset();
  close(pair.studio);
}

/** wait() returns as soon as a line is queued, long before its limit. */
void wakes() {
  Pair pair = socketPair();
  std::unique_ptr<Transport> link = overPair(pair);
  std::thread studioSide([&pair] {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    writeAll(pair.studio, std::string(R"({"id":1,"op":"state"})") + "\n");
  });
  auto started = std::chrono::steady_clock::now();
  bool woke = link->wait(60 * 1000.0);
  auto waited = std::chrono::steady_clock::now() - started;
  studioSide.join();
  assert(woke);
  assert(waited < std::chrono::milliseconds(WAIT_MS));
  link.reset();
  close(pair.studio);
}

/** Destroying the transport while its reader waits on a silent studio returns at once. */
void stops() {
  Pair pair = socketPair();
  std::unique_ptr<Transport> link = overPair(pair);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  link.reset();  // the reader is blocked waiting for bytes that never come; this must not hang
  close(pair.studio);
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"inactive", inactive}, {"too-long", tooLong}, {"order", order}, {"eof", eof},
    {"epipe", epipe},       {"whole-lines", wholeLines}, {"wakes", wakes}, {"stops", stops},
};

}  // namespace

int main(int argc, char** argv) {
  int ran = 0;
  for (const Row& row : ROWS) {
    if (argc > 1 && std::strcmp(argv[1], row.name) != 0) continue;
    row.run();
    std::printf("ok %s\n", row.name);
    std::fflush(stdout);
    ++ran;
  }
  if (ran > 0) return 0;
  std::fprintf(stderr, "no row named %s\n", argc > 1 ? argv[1] : "(none)");
  return 2;
}
