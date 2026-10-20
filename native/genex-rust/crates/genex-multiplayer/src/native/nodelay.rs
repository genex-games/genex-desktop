//! Native-core v0.18.10 workaround: its WebSocket transport never sets `TCP_NODELAY`, so Nagle's
//! algorithm (with the peer's delayed ACK) holds a small state message back until the previous
//! one is acknowledged, bunching a steady 15–20 Hz stream into bursts. The TypeScript SDK's
//! sockets are no-delay; measured against the bench's feel gates, a Nagle'd sender produced
//! teleports at every receiver.
//!
//! The core does not expose its socket, so after each join this scans the process's descriptors
//! for the core's WebSocket sockets and sets `TCP_NODELAY` on them. A socket is the core's when its
//! peer port is the relay's port and it carries the keepalive the core configures on every socket
//! it opens (`ws_socket_configure`: `SO_KEEPALIVE` on, keepalive idle 10 s). No address is
//! resolved: the core resolves the host again on every connect, so a rotating DNS answer, an
//! IPv4-mapped peer or a NAT64 address would slip past an address match. A stray match (another
//! session's relay socket, the core's own HTTPS socket on the same port) only gets `TCP_NODELAY`,
//! which is harmless. Unix only; elsewhere [`apply`] returns `None`.

/// Sets `TCP_NODELAY` on the core's sockets to `relay_port`. Returns how many sockets were set,
/// or `None` where the workaround does not exist (non-Unix).
#[cfg(unix)]
pub(crate) fn apply(relay_port: u16) -> Option<usize> {
    use std::ffi::{c_int, c_void};

    #[repr(C)]
    struct Rlimit {
        cur: u64,
        max: u64,
    }
    extern "C" {
        fn getpeername(fd: c_int, addr: *mut c_void, len: *mut u32) -> c_int;
        fn getsockopt(fd: c_int, level: c_int, name: c_int, value: *mut c_void, len: *mut u32) -> c_int;
        fn setsockopt(fd: c_int, level: c_int, name: c_int, value: *const c_void, len: u32) -> c_int;
        fn getrlimit(resource: c_int, rlim: *mut Rlimit) -> c_int;
    }
    const IPPROTO_TCP: c_int = 6;
    const TCP_NODELAY: c_int = 1;
    const AF_INET: u16 = 2;
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    mod os {
        pub const AF_INET6: u16 = 30;
        pub const SOL_SOCKET: i32 = 0xffff;
        pub const SO_KEEPALIVE: i32 = 0x0008;
        /// `TCP_KEEPALIVE` on Apple (`TCP_KEEPIDLE` on FreeBSD has the same meaning).
        #[cfg(not(target_os = "freebsd"))]
        pub const TCP_KEEPIDLE: i32 = 0x10;
        #[cfg(target_os = "freebsd")]
        pub const TCP_KEEPIDLE: i32 = 256;
        pub const RLIMIT_NOFILE: i32 = 8;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd")))]
    mod os {
        pub const AF_INET6: u16 = 10;
        pub const SOL_SOCKET: i32 = 1;
        pub const SO_KEEPALIVE: i32 = 9;
        pub const TCP_KEEPIDLE: i32 = 4;
        pub const RLIMIT_NOFILE: i32 = 7;
    }
    /// The keepalive idle time the core sets on its sockets (`ws_socket_configure`).
    const CORE_KEEPIDLE_S: c_int = 10;
    /// Descriptors are allocated lowest-first, so the scan stops at the soft limit, capped.
    const MAX_SCAN: u64 = 16_384;

    // SAFETY: getrlimit writes one rlimit; on failure the default bound is used.
    let mut limit = Rlimit { cur: 4096, max: 4096 };
    let bound = if unsafe { getrlimit(os::RLIMIT_NOFILE, &mut limit) } == 0 {
        limit.cur.clamp(256, MAX_SCAN)
    } else {
        4096
    };
    let bound = bound as c_int;

    let int_opt = |fd: c_int, level: c_int, name: c_int| -> Option<c_int> {
        let mut v: c_int = 0;
        let mut len = std::mem::size_of::<c_int>() as u32;
        // SAFETY: getsockopt writes at most `len` bytes into an int; a non-socket just fails.
        (unsafe { getsockopt(fd, level, name, (&mut v as *mut c_int).cast(), &mut len) } == 0).then_some(v)
    };

    let mut set = 0;
    for fd in 0..bound {
        let mut buf = [0u8; 128];
        let mut len = buf.len() as u32;
        // SAFETY: getpeername writes at most `len` bytes into `buf`; a closed fd or a non-socket
        // just fails (EBADF / ENOTSOCK / ENOTCONN).
        if unsafe { getpeername(fd, buf.as_mut_ptr().cast(), &mut len) } != 0 {
            continue;
        }
        // BSD sockaddrs start with a length byte and a one-byte family; Linux with a u16 family.
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
        let family = u16::from(buf[1]);
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd")))]
        let family = u16::from_ne_bytes([buf[0], buf[1]]);
        if family != AF_INET && family != os::AF_INET6 {
            continue;
        }
        // sin_port / sin6_port sit at the same offset in both families.
        if u16::from_be_bytes([buf[2], buf[3]]) != relay_port {
            continue;
        }
        if int_opt(fd, os::SOL_SOCKET, os::SO_KEEPALIVE).unwrap_or(0) == 0
            || int_opt(fd, IPPROTO_TCP, os::TCP_KEEPIDLE) != Some(CORE_KEEPIDLE_S)
        {
            continue;
        }
        let one: c_int = 1;
        // SAFETY: a valid option value for a TCP socket.
        if unsafe { setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, (&one as *const c_int).cast(), 4) } == 0 {
            set += 1;
        }
    }
    Some(set)
}

#[cfg(not(unix))]
pub(crate) fn apply(_relay_port: u16) -> Option<usize> {
    None
}
