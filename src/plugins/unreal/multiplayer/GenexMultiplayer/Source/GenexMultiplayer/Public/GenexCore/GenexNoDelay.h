// Native-core v0.18.10 workaround: its WebSocket transport never sets TCP_NODELAY, so Nagle's
// algorithm (with the peer's delayed ACK) holds a small state message back until the previous one
// is acknowledged, bunching a steady 15-20 Hz stream into bursts (measured against the bench's
// feel gates: a Nagle'd sender produced teleports at every receiver). Port of
// sdks/rust/genex-multiplayer/src/native/nodelay.rs.
//
// The core does not expose its socket, so after each join and reconnect this scans the process's
// descriptors for the core's WebSocket sockets and sets TCP_NODELAY on them. A socket is the
// core's when its peer port is the relay's port and it carries the keepalive the core configures
// on every socket it opens (ws_socket_configure: SO_KEEPALIVE on, keepalive idle 10 s). No address
// is resolved (rotating DNS, IPv4-mapped and NAT64 peers would slip past an address match). A stray
// match (another session's relay socket, the core's HTTPS socket on the same port) only gets
// TCP_NODELAY, which is harmless.
//
// On Windows a SOCKET is a kernel handle, so the scan walks handle values, and the core's keepalive
// (SIO_KEEPALIVE_VALS) cannot be read back, so every TCP socket to the relay's port is taken. A Winsock
// call on a handle with blocking I/O pending waits for that I/O while holding a lock every later socket
// call needs. So Winsock only sees handles opened the way the socket driver opens its own and known not
// to be synchronous (socket() always makes overlapped handles). Asking a handle its mode can itself wait,
// but holds no lock of Winsock's, so that runs on a helper left behind when it stalls. The join waits at
// most 250 ms; the scan finishes behind it.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cstddef>
#include <cstdint>
#include <optional>

namespace genex {

/** Set TCP_NODELAY on the core's sockets to `relayPort`. Returns how many sockets were set, or
 *  nullopt where the workaround does not exist or could not start. */
GENEX_CORE_API std::optional<std::size_t> ApplyNoDelay(std::uint16_t relayPort);

}  // namespace genex
