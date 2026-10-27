//! The operating-system calls std has no API for, each a thin safe wrapper: the FIFOs, the thread
//! CPU clock, an immediate exit from any thread, and the process's resource limits.
#![allow(unsafe_code, reason = "libc calls with no std equivalent; each block's arguments are owned values or checked C strings")]

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// The FIFOs' mode: the sidecar's user only.
const FIFO_MODE: libc::mode_t = 0o600;
const NANOS_PER_SECOND: u64 = 1_000_000_000;

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

/// Makes a FIFO at `path`; fails if anything is there already.
pub fn mkfifo(path: &Path) -> io::Result<()> {
    let path = c_path(path)?;
    // SAFETY: `path` is a NUL-terminated string that outlives the call.
    if unsafe { libc::mkfifo(path.as_ptr(), FIFO_MODE) } == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// The CPU time this thread has used, in nanoseconds (`CLOCK_THREAD_CPUTIME_ID`); 0 if unreadable.
pub fn thread_cpu_ns() -> u64 {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `now` is a valid, writable timespec for the duration of the call.
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) } != 0 {
        return 0;
    }
    let seconds = u64::try_from(now.tv_sec).unwrap_or(0);
    let nanos = u64::try_from(now.tv_nsec).unwrap_or(0);
    seconds.saturating_mul(NANOS_PER_SECOND).saturating_add(nanos)
}

/// Ends the process at once with `code`, from any thread: no destructor, atexit handler or lock of
/// another thread is waited on (`_exit`).
pub fn exit_now(code: i32) -> ! {
    // SAFETY: `_exit` takes any int and never returns.
    unsafe { libc::_exit(code) }
}

/// Lowers resource `which` to `limit` (soft and hard); best-effort, so the result is returned for
/// the caller to ignore or report.
fn set_limit(which: libc::c_int, limit: u64) -> io::Result<()> {
    let value = libc::rlimit { rlim_cur: limit as libc::rlim_t, rlim_max: limit as libc::rlim_t };
    // `which` is a plain int on every libc this builds for except Linux glibc, whose enum the
    // constant already is; the cast is the identity there.
    #[allow(clippy::useless_conversion, reason = "the resource type differs between Linux gnu and macOS")]
    let resource = which.try_into().unwrap_or_default();
    // SAFETY: `value` is a valid rlimit for the duration of the call.
    if unsafe { libc::setrlimit(resource, &value) } == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// Caps the process's address space (`RLIMIT_AS`). Linux enforces it: an allocation past it fails
/// and the process aborts. macOS accepts or ignores it, so there it is best-effort only.
pub fn limit_address_space(bytes: u64) -> io::Result<()> {
    set_limit(libc::RLIMIT_AS as libc::c_int, bytes)
}

/// No core file when the process crashes: a crashed room leaves nothing on disk.
pub fn no_core_dumps() -> io::Result<()> {
    set_limit(libc::RLIMIT_CORE as libc::c_int, 0)
}

/// No new descriptor (file, socket, pipe) past the `open` already held: once the FIFOs are open the
/// process needs none.
pub fn limit_open_files(open: u64) -> io::Result<()> {
    set_limit(libc::RLIMIT_NOFILE as libc::c_int, open)
}

/// No new process or thread for this user from here on (`RLIMIT_NPROC` 0): the watchdog is already
/// running and the world runs on the main thread.
pub fn forbid_new_processes() -> io::Result<()> {
    set_limit(libc::RLIMIT_NPROC as libc::c_int, 0)
}

/// macOS: the world's thread asks for user-interactive QoS, so the scheduler keeps it on a
/// performance core; a process that sleeps on its FIFO between frames otherwise drifts to an
/// efficiency core, about twice as slow per step. Linux has no such classes: nothing to do.
pub fn prefer_performance_cores() {
    #[cfg(target_os = "macos")]
    // SAFETY: sets this thread's own QoS class; both arguments are plain values.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0);
    }
}

/// Linux: the process gets SIGKILL when the thread that started it (the host) ends, so no sidecar
/// outlives its server. Elsewhere the FIFO's end does it: the next read sees EOF and exits.
pub fn die_with_parent() {
    #[cfg(target_os = "linux")]
    // SAFETY: PR_SET_PDEATHSIG takes a signal number; the other arguments are unused.
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_thread_cpu_clock_counts_this_thread_s_work() {
        let before = thread_cpu_ns();
        let mut sum = 0u64;
        for i in 0..2_000_000u64 {
            sum = sum.wrapping_add(i.wrapping_mul(i));
        }
        std::hint::black_box(sum);
        assert!(thread_cpu_ns() > before, "work shows on the thread clock");
    }

    #[test]
    fn a_fifo_is_made_once_and_never_over_something_there() {
        let dir = std::env::temp_dir().join(format!("gxph-fifo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a folder");
        let fifo = dir.join("in");
        mkfifo(&fifo).expect("made");
        assert!(mkfifo(&fifo).is_err(), "never over an existing path");
        assert!(mkfifo(&dir.join("missing").join("in")).is_err());
        std::fs::remove_dir_all(&dir).expect("cleaned");
    }
}
