// The fast channel's datagram socket in Unreal (PROTOCOL.md §17.12): GenexCore's fast::DatagramSocket seam
// over ISocketSubsystem/FSocket UDP, the counterpart of the CMake tools' POSIX socket
// (sdks/unreal/core/tools/fast_udp_socket.h) and of fast-udp.ts's node:dgram one. The socket is connected to
// the endpoint the `__fast` url names, so only that address's datagrams are delivered, non-blocking and
// polled from the session's pump on the game thread. A url the core's rule refuses (fast::UdpEndpoint)
// creates no socket.
#pragma once

#include "GenexCore/GenexFastClient.h"

#include <memory>
#include <string>

/** A fast::SocketOpener for `udp://` urls on the platform socket subsystem; nullptr for any other url, a
 *  host that does not resolve, or a socket that cannot be created or connected. The name lookup runs once,
 *  at the binding, on the calling thread. Exported: the AuthorityProbe's projectile scenario opens its seat with it. */
GENEXMULTIPLAYER_API std::unique_ptr<genex::fast::DatagramSocket> GenexOpenUnrealUdp(const std::string& url);
