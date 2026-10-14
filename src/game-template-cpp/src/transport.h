// The native studio connection: when the studio starts the game it passes one duplex descriptor
// (GENEX_STUDIO_FD, always 3) and a nonce (GENEX_STUDIO_NONCE). A reader thread frames requests
// off it with protocol::LineReader (1 MiB lines; a longer one is answered with line-too-long and
// reading goes on) into a queue; the main thread answers the queue once per frame with serve(), so
// every op runs where raylib may be called; a writer sends whole lines under a lock and goes quiet
// once the studio is gone. Without both variables nothing here opens: web and exported builds
// never see it. The descriptor is POSIX. On Windows the game launcher relays the studio's fd 3 to
// a named pipe of the run's own (GENEX_STUDIO_PIPE, `\\.\pipe\genex-game-<run id>`), which the same
// Channel, framing and caps carry. raylib-free.
#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "paths.h"
#include "protocol.h"

namespace studio::transport {

/** The only value GENEX_STUDIO_FD takes (paths.h names the variable). */
inline constexpr std::string_view STUDIO_FD = "3";
/** The variable carrying the nonce `ready` echoes. */
inline constexpr std::string_view NONCE_ENV = "GENEX_STUDIO_NONCE";
/** The longest nonce taken: the host refuses a longer `ready` field anyway. */
inline constexpr std::size_t MAX_NONCE_BYTES = 256;
/** Lines the reader holds before it waits for the main thread to answer some. */
inline constexpr std::size_t MAX_QUEUED_LINES = 256;
/** Windows: the variable naming the protocol pipe; the game launcher sets it. */
inline constexpr std::string_view PIPE_ENV = "GENEX_STUDIO_PIPE";
/** Windows: every run's pipe is this prefix and the run id, as the launcher names it. */
inline constexpr std::string_view PIPE_PREFIX = "\\\\.\\pipe\\genex-game-";
/** A run id's length: 12 to 32 lowercase hexadecimal digits, as Genex names run folders. */
inline constexpr std::size_t MIN_RUN_ID_CHARS = 12;
inline constexpr std::size_t MAX_RUN_ID_CHARS = 32;

/** A duplex byte channel to the studio: a descriptor on POSIX, a named pipe on Windows. */
class Channel : public protocol::ByteSource {
 public:
  /** Write all of `bytes`; false once the studio is gone, never a signal. Called under the writer's lock. */
  virtual bool write(std::string_view bytes) = 0;
  /** Make a blocked or later read() return the end, from any thread. */
  virtual void interrupt() = 0;
};

/** A channel over descriptor `fd`, which it then owns; null where descriptors are not the transport (web, Windows). */
std::unique_ptr<Channel> descriptorChannel(int fd);

/** The pipe GENEX_STUDIO_PIPE names when it is a run's own (PIPE_PREFIX and a run id); empty otherwise. */
std::string studioPipeName(const paths::Env& env);

/** A channel over the named pipe `name`, opened as its client; null where pipes are not the transport (POSIX) or it does not open. */
std::unique_ptr<Channel> pipeChannel(const std::string& name);

/** One thing the reader took off the channel: a line, a line too long to keep, or the end. */
struct Incoming {
  protocol::LineStatus status = protocol::LineStatus::End;
  std::string text;
};

/** The connection: the reader thread, the queue and the writer. */
class Transport {
 public:
  /** Start reading `channel`; `nonce` is what `ready` echoes. */
  Transport(std::unique_ptr<Channel> channel, std::string nonce);
  /** Interrupt the reader and join it. */
  ~Transport();
  Transport(const Transport&) = delete;
  Transport& operator=(const Transport&) = delete;

  const std::string& nonce() const { return nonce_; }
  /** Everything queued since the last call, in arrival order; the end comes last, once. */
  std::vector<Incoming> take();
  /** Wait up to `ms` milliseconds for something to take; true when there is. */
  bool wait(double ms);
  /** Send one line (the newline is added); false once the studio is gone. */
  bool send(std::string_view line);

 private:
  void readLoop();

  std::unique_ptr<Channel> channel_;
  std::string nonce_;
  std::mutex queueMutex_;
  std::condition_variable queued_;
  std::condition_variable drained_;
  std::deque<Incoming> queue_;
  bool stopping_ = false;
  std::mutex writeMutex_;
  bool gone_ = false;
  std::thread reader_;
};

/**
 * The transport `env` asks for, with a nonce: on POSIX GENEX_STUDIO_FD exactly "3" and descriptor 3
 * open; on Windows a run's own GENEX_STUDIO_PIPE that opens. Null otherwise.
 */
std::unique_ptr<Transport> fromEnvironment(const paths::Env& env);

/** What one serve() pass did. */
struct Served {
  int answered = 0;
  /** The studio closed the connection: the game should close its window and exit 0. */
  bool ended = false;
};

/** Answer everything queued with `calls`, in order; a line past the cap gets line-too-long. */
Served serve(Transport& link, const protocol::Dispatcher& calls);

}  // namespace studio::transport
