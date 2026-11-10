// Port of sdks/rust/genex-multiplayer/src/native/nodelay.rs (see GenexNoDelay.h).
#include "GenexCore/GenexNoDelay.h"

#if defined(__unix__) || defined(__APPLE__)
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/types.h>

#include <algorithm>
#include <cstring>

namespace genex::nodelay_detail {

/** The keepalive idle time the core sets on its sockets (ws_socket_configure). */
constexpr int kCoreKeepIdleS = 10;
/** Descriptors are allocated lowest-first, so the scan stops at the soft limit, capped. */
constexpr rlim_t kMaxScan = 16384;

#if defined(__APPLE__)
constexpr int kKeepIdleOption = TCP_KEEPALIVE;  // Apple's name for TCP_KEEPIDLE
#else
constexpr int kKeepIdleOption = TCP_KEEPIDLE;
#endif

bool NoDelayIntOption(int fd, int level, int name, int* value) {
  int v = 0;
  socklen_t len = sizeof v;
  if (getsockopt(fd, level, name, &v, &len) != 0) return false;
  *value = v;
  return true;
}

}  // namespace genex::nodelay_detail

namespace genex {

std::optional<std::size_t> ApplyNoDelay(std::uint16_t relayPort) {
  namespace nd = nodelay_detail;
  rlimit limit{};
  int bound = 4096;
  if (getrlimit(RLIMIT_NOFILE, &limit) == 0) {
    const rlim_t cur = limit.rlim_cur;
    bound = static_cast<int>((std::min)((std::max)(cur, static_cast<rlim_t>(256)), nd::kMaxScan));
  }
  std::size_t set = 0;
  for (int fd = 0; fd < bound; ++fd) {
    sockaddr_storage addr{};
    socklen_t len = sizeof addr;
    // A closed descriptor or a non-socket just fails (EBADF / ENOTSOCK / ENOTCONN).
    if (getpeername(fd, reinterpret_cast<sockaddr*>(&addr), &len) != 0) continue;
    std::uint16_t peerPort = 0;
    if (addr.ss_family == AF_INET) {
      sockaddr_in in4{};
      std::memcpy(&in4, &addr, sizeof in4);
      peerPort = ntohs(in4.sin_port);
    } else if (addr.ss_family == AF_INET6) {
      sockaddr_in6 in6{};
      std::memcpy(&in6, &addr, sizeof in6);
      peerPort = ntohs(in6.sin6_port);
    } else {
      continue;
    }
    if (peerPort != relayPort) continue;
    int keepAlive = 0;
    int keepIdle = 0;
    if (!nd::NoDelayIntOption(fd, SOL_SOCKET, SO_KEEPALIVE, &keepAlive) || keepAlive == 0) continue;
    if (!nd::NoDelayIntOption(fd, IPPROTO_TCP, nd::kKeepIdleOption, &keepIdle) || keepIdle != nd::kCoreKeepIdleS) {
      continue;
    }
    const int one = 1;
    if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one) == 0) ++set;
  }
  return set;
}

}  // namespace genex

#elif defined(_WIN32)

#if defined(GENEX_WITH_UE)
#include "Windows/AllowWindowsPlatformTypes.h"
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <windows.h>
#pragma comment(lib, "Ws2_32.lib")

#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <vector>

namespace genex::nodelay_detail {

/** Kernel handles are multiples of 4. */
constexpr std::uintptr_t kHandleStep = 4;
/** Handles are allocated lowest-first: this covers 65,536 open handles in the process. */
constexpr std::uintptr_t kMaxHandle = 0x40000;
/** OBJECT_INFORMATION_CLASS::ObjectBasicInformation, which never waits on the object. */
constexpr ULONG kObjectBasicInformation = 0;
/** PUBLIC_OBJECT_BASIC_INFORMATION is this many 32-bit words; its second is the handle's granted access. */
constexpr std::size_t kBasicInformationWords = 14;
constexpr std::size_t kGrantedAccessWord = 1;
/** GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE | WRITE_DAC as a file: what the socket driver grants. Most pipes (0x120189,
 *  0x120196, 0x12019f) and files lack WRITE_DAC, but a duplex pipe a parent hands a child can have it. */
constexpr ULONG kSocketAccess = 0x16019f;
/** FILE_INFORMATION_CLASS::FileModeInformation. */
constexpr ULONG kFileModeInformation = 16;
constexpr ULONG kFileSynchronousIoAlert = 0x10;
constexpr ULONG kFileSynchronousIoNonAlert = 0x20;
/** No handle answering for this long means the mode question is waiting on its I/O. */
constexpr DWORD kStallMs = 50;
/** How many such handles one scan steps past before giving up on the rest of the range. */
constexpr int kMaxStalls = 8;
/** A whole scan takes about 12 ms; past this a join goes on, and the scan finishes behind it. */
constexpr DWORD kScanLimitMs = 250;
/** These threads do next to nothing, and one may sit blocked for as long as a handle stays quiet. */
constexpr SIZE_T kHelperStackBytes = 64 * 1024;

using NtQueryObjectFn = LONG(WINAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
struct IoStatusBlock {
  ULONG_PTR status;
  ULONG_PTR information;
};
using NtQueryInformationFileFn = LONG(WINAPI*)(HANDLE, IoStatusBlock*, PVOID, ULONG, ULONG);

struct Ntdll {
  NtQueryObjectFn queryObject = nullptr;
  NtQueryInformationFileFn queryFile = nullptr;
};

/** Handles a helper is blocked on now: the next join's scan does not walk into them again. */
std::mutex& HeldLock() {
  static std::mutex lock;
  return lock;
}
std::vector<std::uintptr_t>& Held() {
  static std::vector<std::uintptr_t> held;
  return held;
}

/** What one scan shares with its helpers, any of which may outlive it. */
struct Scan {
  std::uint16_t port = 0;
  Ntdll nt;
  std::atomic<std::size_t> set{0};
};

/** One helper's walk over the range, left behind when it stalls. */
struct Walk {
  std::shared_ptr<Scan> scan;
  std::uintptr_t from = kHandleStep;
  std::vector<std::uintptr_t> skip;
  std::atomic<std::uintptr_t> at{kHandleStep};
  std::atomic<bool> leftBehind{false};
};

/** Whether this handle was opened as the socket driver opens its own. Never waits. */
bool HasSocketAccess(const Ntdll& nt, std::uintptr_t handle) {
  ULONG basic[kBasicInformationWords] = {};
  // A closed handle just fails.
  if (nt.queryObject(reinterpret_cast<HANDLE>(handle), kObjectBasicInformation, basic, sizeof basic, nullptr) < 0) return false;
  return (basic[kGrantedAccessWord] & kSocketAccess) == kSocketAccess;
}

/** Whether this handle is overlapped, as every socket() is. May wait on a synchronous handle's I/O, holding no lock of
 *  Winsock's. */
bool IsOverlapped(const Ntdll& nt, std::uintptr_t handle) {
  IoStatusBlock io{};
  ULONG mode = 0;
  if (nt.queryFile(reinterpret_cast<HANDLE>(handle), &io, &mode, sizeof mode, kFileModeInformation) < 0) return false;
  return (mode & (kFileSynchronousIoAlert | kFileSynchronousIoNonAlert)) == 0;
}

bool IsToPort(SOCKET socket, std::uint16_t port) {
  sockaddr_storage addr{};
  int len = sizeof addr;
  // A non-socket just fails (WSAENOTSOCK).
  if (getpeername(socket, reinterpret_cast<sockaddr*>(&addr), &len) != 0) return false;
  if (addr.ss_family != AF_INET && addr.ss_family != AF_INET6) return false;
  // sin_port and sin6_port sit at the same offset.
  return ntohs(reinterpret_cast<const sockaddr_in*>(&addr)->sin_port) == port;
}

DWORD WINAPI WalkHandles(LPVOID parameter) {
  const std::shared_ptr<Walk> walk(*static_cast<std::shared_ptr<Walk>*>(parameter));
  delete static_cast<std::shared_ptr<Walk>*>(parameter);
  const Scan& scan = *walk->scan;
  for (std::uintptr_t handle = walk->from; handle <= kMaxHandle; handle += kHandleStep) {
    walk->at.store(handle);
    if (std::find(walk->skip.begin(), walk->skip.end(), handle) != walk->skip.end()) continue;
    if (!HasSocketAccess(scan.nt, handle)) continue;
    const bool overlapped = IsOverlapped(scan.nt, handle);
    if (walk->leftBehind.load()) {
      std::lock_guard<std::mutex> guard(HeldLock());
      std::vector<std::uintptr_t>& held = Held();
      held.erase(std::remove(held.begin(), held.end(), handle), held.end());
      return 0;
    }
    if (!overlapped) continue;
    const SOCKET socket = static_cast<SOCKET>(handle);
    if (!IsToPort(socket, scan.port)) continue;
    const BOOL one = TRUE;
    // On a socket that is not TCP the call fails and nothing is counted.
    if (setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof one) == 0) ++walk->scan->set;
  }
  return 0;
}

HANDLE StartThread(LPTHREAD_START_ROUTINE routine, void* parameter) {
  return CreateThread(nullptr, kHelperStackBytes, routine, parameter, STACK_SIZE_PARAM_IS_A_RESERVATION, nullptr);
}

/** Walks the handle range, stepping past any handle the mode question stalls on. */
DWORD WINAPI CoordinateScan(LPVOID parameter) {
  const std::shared_ptr<Scan> scan(*static_cast<std::shared_ptr<Scan>*>(parameter));
  delete static_cast<std::shared_ptr<Scan>*>(parameter);
  std::uintptr_t from = kHandleStep;
  for (int stalls = 0; stalls <= kMaxStalls; ++stalls) {
    const std::shared_ptr<Walk> walk = std::make_shared<Walk>();
    walk->scan = scan;
    walk->from = from;
    walk->at.store(from);
    {
      std::lock_guard<std::mutex> guard(HeldLock());
      walk->skip = Held();
    }
    auto* handed = new std::shared_ptr<Walk>(walk);
    const HANDLE helper = StartThread(WalkHandles, handed);
    if (helper == nullptr) {
      delete handed;
      return 0;
    }
    std::uintptr_t seen = kMaxHandle + kHandleStep;
    bool stepped = false;
    while (!stepped) {
      if (WaitForSingleObject(helper, kStallMs) != WAIT_TIMEOUT) {
        CloseHandle(helper);
        return 0;
      }
      const std::uintptr_t at = walk->at.load();
      if (at != seen) {
        seen = at;
        continue;
      }
      {
        std::lock_guard<std::mutex> guard(HeldLock());
        Held().push_back(at);
      }
      walk->leftBehind.store(true);
      from = at + kHandleStep;
      stepped = true;
    }
    CloseHandle(helper);
  }
  return 0;
}

}  // namespace genex::nodelay_detail

namespace genex {

std::optional<std::size_t> ApplyNoDelay(std::uint16_t relayPort) {
  namespace nd = nodelay_detail;
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == nullptr) return std::nullopt;
  nd::Ntdll nt;
  nt.queryObject = reinterpret_cast<nd::NtQueryObjectFn>(reinterpret_cast<void*>(GetProcAddress(ntdll, "NtQueryObject")));
  nt.queryFile = reinterpret_cast<nd::NtQueryInformationFileFn>(reinterpret_cast<void*>(GetProcAddress(ntdll, "NtQueryInformationFile")));
  if (nt.queryObject == nullptr || nt.queryFile == nullptr) return std::nullopt;
  const std::shared_ptr<nd::Scan> scan = std::make_shared<nd::Scan>();
  scan->port = relayPort;
  scan->nt = nt;
  auto* handed = new std::shared_ptr<nd::Scan>(scan);
  const HANDLE coordinator = nd::StartThread(nd::CoordinateScan, handed);
  if (coordinator == nullptr) {
    delete handed;
    return std::nullopt;
  }
  WaitForSingleObject(coordinator, nd::kScanLimitMs);
  CloseHandle(coordinator);
  return scan->set.load();
}

}  // namespace genex

#if defined(GENEX_WITH_UE)
#include "Windows/HideWindowsPlatformTypes.h"
#endif

#else

namespace genex {

std::optional<std::size_t> ApplyNoDelay(std::uint16_t relayPort) {
  (void)relayPort;
  return std::nullopt;
}

}  // namespace genex

#endif
