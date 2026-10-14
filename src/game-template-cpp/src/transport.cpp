// The native studio connection declared in transport.h. raylib-free.
#include "transport.h"

// The browser build has no studio descriptor and no threads: everything here is native-only.
#if !defined(__EMSCRIPTEN__) && !defined(PLATFORM_WEB)

#include <algorithm>
#include <chrono>
#include <utility>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <cerrno>
#include <csignal>
#endif

namespace studio::transport {

namespace {

#if !defined(_WIN32)

/** How long a write waits for room in the studio's buffer before it gives up on the studio. */
constexpr int WRITE_STALL_MS = 10000;
/** The descriptor the studio passes (STUDIO_FD as a number). */
constexpr int STUDIO_DESCRIPTOR = 3;

/** One duplex descriptor (Node's fourth stdio slot is a socket) plus a self-pipe that wakes a blocked read. */
class DescriptorChannel : public Channel {
 public:
  DescriptorChannel(int fd, int wakeRead, int wakeWrite) : fd_(fd), wakeRead_(wakeRead), wakeWrite_(wakeWrite) {}
  ~DescriptorChannel() override {
    ::close(fd_);
    ::close(wakeRead_);
    ::close(wakeWrite_);
  }
  DescriptorChannel(const DescriptorChannel&) = delete;
  DescriptorChannel& operator=(const DescriptorChannel&) = delete;

  long read(char* into, std::size_t capacity) override {
    for (;;) {
      pollfd fds[2] = {{fd_, POLLIN, 0}, {wakeRead_, POLLIN, 0}};
      if (::poll(fds, 2, -1) < 0) {
        if (errno == EINTR) continue;
        return -1;
      }
      if (fds[1].revents != 0) return -1;  // interrupted: the transport is closing
      ssize_t got = ::read(fd_, into, capacity);
      if (got >= 0) return static_cast<long>(got);
      if (errno != EINTR && errno != EAGAIN) return -1;
    }
  }

  bool write(std::string_view bytes) override {
    while (!bytes.empty()) {
      ssize_t wrote = ::write(fd_, bytes.data(), bytes.size());
      if (wrote > 0) {
        bytes.remove_prefix(static_cast<std::size_t>(wrote));
      } else if (wrote < 0 && errno == EAGAIN) {
        pollfd room{fd_, POLLOUT, 0};
        if (::poll(&room, 1, WRITE_STALL_MS) <= 0) return false;
      } else if (!(wrote < 0 && errno == EINTR)) {
        return false;  // EPIPE and the like: the studio is gone
      }
    }
    return true;
  }

  void interrupt() override {
    char byte = 1;
    // A full pipe already wakes the reader; nothing else can go wrong worth reporting here.
    (void)!::write(wakeWrite_, &byte, 1);
  }

 private:
  int fd_;
  int wakeRead_;
  int wakeWrite_;
};

bool closeOnExec(int fd) { return ::fcntl(fd, F_SETFD, FD_CLOEXEC) == 0; }

#else

/** How long a pipe write waits for the launcher to take the bytes before it gives up on the studio. */
constexpr DWORD PIPE_WRITE_STALL_MS = 10000;
/** The most bytes one pipe read or write asks for (well inside a DWORD). */
constexpr std::size_t PIPE_CHUNK_BYTES = 1 << 20;

/** The pipe's end, or a failure: the launcher closing its side is the studio's end of the connection. */
long pipeEnded(DWORD error) { return error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED ? 0 : -1; }

/**
 * The named pipe the launcher made for this run, opened overlapped: the reader thread waits on a
 * read while the main thread writes (a synchronous handle would make them wait for each other), and
 * a wake event ends a blocked read.
 */
class PipeChannel : public Channel {
 public:
  PipeChannel(HANDLE pipe, HANDLE readDone, HANDLE writeDone, HANDLE wake)
      : pipe_(pipe), readDone_(readDone), writeDone_(writeDone), wake_(wake) {}
  ~PipeChannel() override {
    ::CloseHandle(pipe_);
    ::CloseHandle(readDone_);
    ::CloseHandle(writeDone_);
    ::CloseHandle(wake_);
  }
  PipeChannel(const PipeChannel&) = delete;
  PipeChannel& operator=(const PipeChannel&) = delete;

  long read(char* into, std::size_t capacity) override {
    OVERLAPPED overlapped{};
    overlapped.hEvent = readDone_;
    DWORD want = static_cast<DWORD>(std::min(capacity, PIPE_CHUNK_BYTES));
    if (!::ReadFile(pipe_, into, want, nullptr, &overlapped) && ::GetLastError() != ERROR_IO_PENDING) {
      return pipeEnded(::GetLastError());
    }
    HANDLE waits[2] = {readDone_, wake_};
    DWORD got = 0;
    if (::WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) {
      // Interrupted: the transport is closing. The read must be over before its buffer goes away.
      ::CancelIoEx(pipe_, &overlapped);
      ::GetOverlappedResult(pipe_, &overlapped, &got, TRUE);
      return -1;
    }
    if (!::GetOverlappedResult(pipe_, &overlapped, &got, FALSE)) return pipeEnded(::GetLastError());
    return static_cast<long>(got);
  }

  bool write(std::string_view bytes) override {
    while (!bytes.empty()) {
      OVERLAPPED overlapped{};
      overlapped.hEvent = writeDone_;
      DWORD chunk = static_cast<DWORD>(std::min(bytes.size(), PIPE_CHUNK_BYTES));
      if (!::WriteFile(pipe_, bytes.data(), chunk, nullptr, &overlapped) && ::GetLastError() != ERROR_IO_PENDING) {
        return false;  // ERROR_NO_DATA and the like: the studio is gone
      }
      DWORD wrote = 0;
      if (::WaitForSingleObject(writeDone_, PIPE_WRITE_STALL_MS) != WAIT_OBJECT_0) {
        ::CancelIoEx(pipe_, &overlapped);
        ::GetOverlappedResult(pipe_, &overlapped, &wrote, TRUE);
        return false;
      }
      if (!::GetOverlappedResult(pipe_, &overlapped, &wrote, FALSE) || wrote == 0) return false;
      bytes.remove_prefix(wrote);
    }
    return true;
  }

  void interrupt() override { ::SetEvent(wake_); }

 private:
  HANDLE pipe_;
  HANDLE readDone_;
  HANDLE writeDone_;
  HANDLE wake_;
};

#endif

std::string lookup(const paths::Env& env, std::string_view name) {
  return env ? env(name).value_or(std::string()) : std::string();
}

/** A nonce the studio could have passed: present and no longer than MAX_NONCE_BYTES. */
bool validNonce(std::string_view nonce) { return !nonce.empty() && nonce.size() <= MAX_NONCE_BYTES; }

bool lowerHex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }

/** A run id as Genex names run folders: 12 to 32 lowercase hexadecimal digits. */
bool validRunId(std::string_view id) {
  bool sized = id.size() >= MIN_RUN_ID_CHARS && id.size() <= MAX_RUN_ID_CHARS;
  return sized && std::all_of(id.begin(), id.end(), lowerHex);
}

}  // namespace

std::string studioPipeName(const paths::Env& env) {
  std::string pipe = lookup(env, PIPE_ENV);
  std::string_view name(pipe);
  bool prefixed = name.size() > PIPE_PREFIX.size() && name.substr(0, PIPE_PREFIX.size()) == PIPE_PREFIX;
  if (!prefixed || !validRunId(name.substr(PIPE_PREFIX.size()))) return {};
  return pipe;
}

std::unique_ptr<Channel> pipeChannel(const std::string& name) {
#if defined(_WIN32)
  // The name is ASCII (studioPipeName checked it), so widening each byte is its UTF-16.
  std::wstring wide(name.begin(), name.end());
  // Anonymous to the launcher's end: the pipe's server may not act as the game.
  DWORD flags = FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS;
  HANDLE pipe = ::CreateFileW(wide.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, flags, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) return nullptr;
  HANDLE events[3] = {};
  for (HANDLE& event : events) event = ::CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (std::any_of(std::begin(events), std::end(events), [](HANDLE event) { return event == nullptr; })) {
    for (HANDLE event : events) {
      if (event) ::CloseHandle(event);
    }
    ::CloseHandle(pipe);
    return nullptr;
  }
  return std::make_unique<PipeChannel>(pipe, events[0], events[1], events[2]);
#else
  (void)name;
  return nullptr;  // POSIX games talk over descriptor 3
#endif
}

std::unique_ptr<Channel> descriptorChannel(int fd) {
#if defined(_WIN32)
  (void)fd;
  return nullptr;  // Windows games talk over the named pipe the launcher opens (wave 3)
#else
  if (fd < 0 || ::fcntl(fd, F_GETFD) < 0) return nullptr;
  int wake[2] = {-1, -1};
  if (::pipe(wake) != 0) return nullptr;
  closeOnExec(fd);
  closeOnExec(wake[0]);
  closeOnExec(wake[1]);
  ::fcntl(wake[1], F_SETFL, O_NONBLOCK);
#if defined(F_SETNOSIGPIPE)
  ::fcntl(fd, F_SETNOSIGPIPE, 1);
#endif
  // A write to a studio that has gone must fail with EPIPE, not kill the game: Linux has no
  // per-descriptor switch for that.
  std::signal(SIGPIPE, SIG_IGN);
  return std::make_unique<DescriptorChannel>(fd, wake[0], wake[1]);
#endif
}

Transport::Transport(std::unique_ptr<Channel> channel, std::string nonce)
    : channel_(std::move(channel)), nonce_(std::move(nonce)) {
  reader_ = std::thread([this] { readLoop(); });
}

Transport::~Transport() {
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    stopping_ = true;
  }
  drained_.notify_all();
  channel_->interrupt();
  reader_.join();
}

void Transport::readLoop() {
  protocol::LineReader reader(*channel_);
  for (;;) {
    protocol::NextLine next = reader.next();
    std::unique_lock<std::mutex> lock(queueMutex_);
    drained_.wait(lock, [this] { return stopping_ || queue_.size() < MAX_QUEUED_LINES; });
    if (stopping_) return;
    bool end = next.status == protocol::LineStatus::End;
    queue_.push_back(Incoming{next.status, std::move(next.text)});
    lock.unlock();
    queued_.notify_all();
    if (end) return;
  }
}

std::vector<Incoming> Transport::take() {
  std::vector<Incoming> taken;
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    taken.assign(std::make_move_iterator(queue_.begin()), std::make_move_iterator(queue_.end()));
    queue_.clear();
  }
  drained_.notify_all();
  return taken;
}

bool Transport::wait(double ms) {
  std::unique_lock<std::mutex> lock(queueMutex_);
  if (!(ms > 0)) return !queue_.empty();
  auto limit = std::chrono::duration<double, std::milli>(ms);
  return queued_.wait_for(lock, limit, [this] { return !queue_.empty(); });
}

bool Transport::send(std::string_view line) {
  // Built before the lock: nothing that can throw runs under it, so a fatal report sent from a
  // terminate handler never waits on a lock its own failure left held.
  std::string whole(line);
  whole += '\n';
  std::lock_guard<std::mutex> lock(writeMutex_);
  if (gone_) return false;
  gone_ = !channel_->write(whole);
  return !gone_;
}

std::unique_ptr<Transport> fromEnvironment(const paths::Env& env) {
  std::string nonce = lookup(env, NONCE_ENV);
  if (!validNonce(nonce)) return nullptr;
#if defined(_WIN32)
  std::string pipe = studioPipeName(env);
  if (pipe.empty()) return nullptr;
  std::unique_ptr<Channel> channel = pipeChannel(pipe);
#else
  if (lookup(env, paths::STUDIO_FD_ENV) != STUDIO_FD) return nullptr;
  std::unique_ptr<Channel> channel = descriptorChannel(STUDIO_DESCRIPTOR);
#endif
  if (!channel) return nullptr;
  return std::make_unique<Transport>(std::move(channel), std::move(nonce));
}

Served serve(Transport& link, const protocol::Dispatcher& calls) {
  Served served;
  for (const Incoming& item : link.take()) {
    switch (item.status) {
      case protocol::LineStatus::Line:
        link.send(calls.handle(item.text));
        ++served.answered;
        break;
      case protocol::LineStatus::TooLong:
        link.send(calls.lineTooLong());
        ++served.answered;
        break;
      case protocol::LineStatus::End:
        served.ended = true;
        break;
    }
  }
  return served;
}

}  // namespace studio::transport

#endif
