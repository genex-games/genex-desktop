//! The studio's connection, ported from the C++ template's `transport.h`: one duplex channel (fd 3
//! on POSIX, the run's named pipe on Windows), a reader thread that frames requests into a bounded
//! queue, and a writer that sends whole lines under a lock and goes quiet once the studio is gone.

use std::collections::VecDeque;
use std::io::{self, Read};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use genex_core::json::{self, Value};
use genex_crash::{CrashRecord, CrashSink, FnSink, Installed};
#[cfg(unix)]
use genex_core::paths::STUDIO_FD_ENV;
use genex_core::protocol::{self, Event, LineReader, NextLine};

use crate::verbs::FatalReason;

/// The only value `GENEX_STUDIO_FD` takes.
pub const STUDIO_FD: &str = "3";
/// The variable carrying the nonce `ready` echoes.
pub const NONCE_ENV: &str = "GENEX_STUDIO_NONCE";
/// The longest nonce taken: the host refuses a longer `ready` field anyway.
pub const MAX_NONCE_BYTES: usize = 256;
/// Lines the reader holds before it waits for the main thread to answer some.
pub const MAX_QUEUED_LINES: usize = 256;
/// Windows: the variable naming the protocol pipe; the game launcher sets it.
pub const PIPE_ENV: &str = "GENEX_STUDIO_PIPE";
/// Windows: every run's pipe is this prefix and the run id, as the launcher names it.
pub const PIPE_PREFIX: &str = r"\\.\pipe\genex-game-";
/// A run id's shortest length: 12 to 32 lowercase hexadecimal digits, as Genex names run folders.
pub const MIN_RUN_ID_CHARS: usize = 12;
/// A run id's longest length.
pub const MAX_RUN_ID_CHARS: usize = 32;
/// How long a write waits for room in the studio's buffer before it gives up on the studio.
pub const WRITE_STALL: Duration = Duration::from_secs(10);
/// How long dropping a transport waits for its reader to wake; past it the reader is left to end
/// with the process (a channel whose blocked read cannot be interrupted).
const READER_JOIN_WAIT: Duration = Duration::from_millis(250);
/// The descriptor the studio passes (`STUDIO_FD` as a number).
#[cfg(unix)]
const STUDIO_DESCRIPTOR: std::os::fd::RawFd = 3;

/// A duplex byte channel to the studio: a socket on POSIX, a named pipe on Windows.
pub trait Channel: Send + Sync {
    /// Up to `into.len()` bytes: the count, 0 at the end; an error also ends the reader.
    fn read(&self, into: &mut [u8]) -> io::Result<usize>;
    /// Write all of `bytes`; false once the studio is gone, never a signal. Called under the
    /// transport's write lock.
    fn write_all(&self, bytes: &[u8]) -> bool;
    /// Make a blocked or later `read` return the end, from any thread.
    fn interrupt(&self);
}

/// The descriptor the studio passes, as a connected Unix socket (Node's fourth stdio slot is one).
#[cfg(unix)]
#[derive(Debug)]
pub struct SocketChannel {
    stream: std::os::unix::net::UnixStream,
}

#[cfg(unix)]
impl SocketChannel {
    /// A blocking channel over `stream` whose writes give up after [`WRITE_STALL`].
    pub fn new(stream: std::os::unix::net::UnixStream) -> io::Result<SocketChannel> {
        stream.set_nonblocking(false)?;
        stream.set_write_timeout(Some(WRITE_STALL))?;
        Ok(SocketChannel { stream })
    }
}

#[cfg(unix)]
impl Channel for SocketChannel {
    fn read(&self, into: &mut [u8]) -> io::Result<usize> {
        (&self.stream).read(into)
    }

    fn write_all(&self, bytes: &[u8]) -> bool {
        // A Rust binary ignores SIGPIPE, so a studio that left is an EPIPE here, never a signal.
        io::Write::write_all(&mut &self.stream, bytes).is_ok()
    }

    fn interrupt(&self) {
        // Shutting the read side wakes a blocked read with the end; it fails only on a socket that
        // is already gone, which has nothing left to wake.
        let _ = self.stream.shutdown(std::net::Shutdown::Read);
    }
}

/// Descriptor `fd`, adopted as the studio's socket; None when it is not open or not a socket, in
/// which case it is neither owned nor closed.
#[cfg(unix)]
#[allow(unsafe_code)] // Adopting an inherited descriptor has no safe constructor in std.
fn descriptor_channel(fd: std::os::fd::RawFd) -> Option<Arc<dyn Channel>> {
    use std::mem::ManuallyDrop;
    use std::os::fd::FromRawFd;
    use std::os::unix::net::UnixStream;
    // SAFETY: the studio passes `fd` (3) open for this process to own; nothing else in the process
    // opened it before the runtime connects. The stream stays in a ManuallyDrop until the
    // descriptor is known to be an open socket, so a closed or foreign descriptor is never closed.
    let stream = ManuallyDrop::new(unsafe { UnixStream::from_raw_fd(fd) });
    if stream.local_addr().is_err() {
        return None;
    }
    // Close-on-exec, as `transport.cpp` sets it: a process the game spawns (a `Command`, or one a
    // dependency starts) never inherits the studio's socket, so it can neither write to the host's
    // channel nor hold it open after the game exits.
    // SAFETY: `fd` is the open socket just checked; F_SETFD only changes its descriptor flags.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return None;
    }
    let channel = SocketChannel::new(ManuallyDrop::into_inner(stream)).ok()?;
    Some(Arc::new(channel))
}

/// A channel's bytes for the line framer.
struct ChannelReader(Arc<dyn Channel>);

impl Read for ChannelReader {
    fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
        self.0.read(into)
    }
}

/// What the reader took off the channel, waiting for the main thread.
#[derive(Default)]
struct Queue {
    items: VecDeque<NextLine>,
    stopping: bool,
    finished: bool,
}

/// The queue and its two signals, shared with the reader thread.
#[derive(Default)]
struct Shared {
    queue: Mutex<Queue>,
    /// Something was queued (or the reader finished).
    queued: Condvar,
    /// The main thread took the queue (or the transport is stopping).
    drained: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The connection: the reader thread, the queue and the writer.
pub struct Transport {
    channel: Arc<dyn Channel>,
    nonce: String,
    shared: Arc<Shared>,
    /// The write lock; true once a write failed and the studio counts as gone.
    gone: Mutex<bool>,
    reader: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Transport").field("nonce", &self.nonce).finish_non_exhaustive()
    }
}

fn read_loop(channel: Arc<dyn Channel>, shared: Arc<Shared>) {
    let mut reader = LineReader::new(ChannelReader(channel));
    loop {
        let next = reader.next_line();
        let end = next == NextLine::End;
        let mut queue = shared.lock();
        while !queue.stopping && queue.items.len() >= MAX_QUEUED_LINES {
            queue = shared.drained.wait(queue).unwrap_or_else(PoisonError::into_inner);
        }
        if queue.stopping {
            break;
        }
        queue.items.push_back(next);
        drop(queue);
        shared.queued.notify_all();
        if end {
            break;
        }
    }
    shared.lock().finished = true;
    shared.queued.notify_all();
}

impl Transport {
    /// Start reading `channel`; `nonce` is what `ready` echoes.
    pub fn new(channel: Arc<dyn Channel>, nonce: String) -> Transport {
        let shared = Arc::new(Shared::default());
        let reader = {
            let (channel, shared) = (Arc::clone(&channel), Arc::clone(&shared));
            std::thread::Builder::new()
                .name("genex-studio-reader".to_owned())
                .spawn(move || read_loop(channel, shared))
                .ok()
        };
        if reader.is_none() {
            // No reader thread: the studio is answered nothing and its end is never seen, so say
            // the end at once and let the game close as it would on EOF.
            shared.lock().items.push_back(NextLine::End);
        }
        Transport { channel, nonce, shared, gone: Mutex::new(false), reader }
    }

    /// The nonce `ready` echoes.
    pub fn nonce(&self) -> &str {
        &self.nonce
    }

    /// Everything queued since the last call, in arrival order; the end comes last, once.
    pub fn take(&self) -> Vec<NextLine> {
        let taken: Vec<NextLine> = self.shared.lock().items.drain(..).collect();
        self.shared.drained.notify_all();
        taken
    }

    /// Wait up to `timeout` for something to take; true when there is.
    pub fn wait(&self, timeout: Duration) -> bool {
        let queue = self.shared.lock();
        if timeout.is_zero() {
            return !queue.items.is_empty();
        }
        let (queue, _) = self
            .shared
            .queued
            .wait_timeout_while(queue, timeout, |q| q.items.is_empty())
            .unwrap_or_else(PoisonError::into_inner);
        !queue.items.is_empty()
    }

    /// Send one line (the newline is added); false once the studio is gone.
    pub fn send(&self, line: &[u8]) -> bool {
        // Built before the lock, so a fatal report sent from a panic hook never waits on a lock
        // its own failure left held for longer than one write.
        let mut whole = Vec::with_capacity(line.len() + 1);
        whole.extend_from_slice(line);
        whole.push(b'\n');
        let mut gone = self.gone.lock().unwrap_or_else(PoisonError::into_inner);
        if *gone {
            return false;
        }
        *gone = !self.channel.write_all(&whole);
        !*gone
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.shared.lock().stopping = true;
        self.shared.drained.notify_all();
        self.channel.interrupt();
        let queue = self.shared.lock();
        let (queue, _) = self
            .shared
            .queued
            .wait_timeout_while(queue, READER_JOIN_WAIT, |q| !q.finished)
            .unwrap_or_else(PoisonError::into_inner);
        let finished = queue.finished;
        drop(queue);
        let Some(reader) = self.reader.take() else { return };
        if finished {
            let _ = reader.join();
        }
    }
}

fn lookup(env: &dyn Fn(&str) -> Option<String>, name: &str) -> String {
    env(name).unwrap_or_default()
}

/// A nonce the studio could have passed: present and no longer than [`MAX_NONCE_BYTES`].
fn valid_nonce(nonce: &str) -> bool {
    !nonce.is_empty() && nonce.len() <= MAX_NONCE_BYTES
}

/// A run id as Genex names run folders: 12 to 32 lowercase hexadecimal digits.
fn valid_run_id(id: &str) -> bool {
    let sized = (MIN_RUN_ID_CHARS..=MAX_RUN_ID_CHARS).contains(&id.len());
    sized && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The pipe `GENEX_STUDIO_PIPE` names when it is a run's own ([`PIPE_PREFIX`] and a run id); ""
/// otherwise.
pub fn studio_pipe_name(env: &dyn Fn(&str) -> Option<String>) -> String {
    let pipe = lookup(env, PIPE_ENV);
    match pipe.strip_prefix(PIPE_PREFIX) {
        Some(id) if valid_run_id(id) => pipe,
        _ => String::new(),
    }
}

/// The channel this platform's studio passes, or None.
#[cfg(unix)]
fn studio_channel(env: &dyn Fn(&str) -> Option<String>) -> Option<Arc<dyn Channel>> {
    if lookup(env, STUDIO_FD_ENV) != STUDIO_FD {
        return None;
    }
    descriptor_channel(STUDIO_DESCRIPTOR)
}

/// The channel this platform's studio passes, or None.
#[cfg(windows)]
fn studio_channel(env: &dyn Fn(&str) -> Option<String>) -> Option<Arc<dyn Channel>> {
    let pipe = studio_pipe_name(env);
    if pipe.is_empty() {
        return None;
    }
    crate::pipe::open(&pipe)
}

/// The web and other hosts have no studio channel.
#[cfg(not(any(unix, windows)))]
fn studio_channel(_env: &dyn Fn(&str) -> Option<String>) -> Option<Arc<dyn Channel>> {
    None
}

/// The transport `env` asks for, with a nonce: on POSIX `GENEX_STUDIO_FD` exactly "3" and
/// descriptor 3 an open socket; on Windows a run's own `GENEX_STUDIO_PIPE` that opens. None
/// otherwise, having opened and adopted nothing.
pub fn from_environment(env: &dyn Fn(&str) -> Option<String>) -> Option<Transport> {
    let nonce = lookup(env, NONCE_ENV);
    if !valid_nonce(&nonce) {
        return None;
    }
    let channel = studio_channel(env)?;
    Some(Transport::new(channel, nonce))
}

/// [`report_crashes`] with no sink besides the studio's.
pub fn report_panics(link: Arc<Transport>) {
    report_crashes(link, Vec::new());
}

/// Tell the studio about every panic: the crash hook (genex-crash) sends its record as a `crash`
/// event (CRASH-2) and to `sinks`, then `fatal` (reason [`FatalReason::TERMINATE`]) goes out as
/// before, then the hook installed before. The crash hook is the process's and installs once:
/// answers [`Installed::Already`] when it was, in which case `sinks` and the `crash` event are left
/// out and only `fatal` is added.
pub fn report_crashes(link: Arc<Transport>, mut sinks: Vec<Box<dyn CrashSink>>) -> Installed {
    let previous = std::panic::take_hook();
    let fatal_link = Arc::clone(&link);
    std::panic::set_hook(Box::new(move |info| {
        let mut fields = Value::object();
        fields.set("reason", Value::from(FatalReason::TERMINATE));
        fatal_link.send(&protocol::event(Event::FATAL, &fields));
        previous(info);
    }));
    sinks.push(Box::new(FnSink(move |_record: &CrashRecord, json: &[u8]| {
        send_crash(&link, json);
    })));
    genex_crash::install(sinks)
}

/// Send one crash record (its JSON, at most 64 KiB) as the `crash` event; nothing for JSON the
/// protocol cannot carry.
fn send_crash(link: &Transport, json: &[u8]) {
    let Ok(record) = json::parse(json) else { return };
    let mut fields = Value::object();
    fields.set("record", record);
    link.send(&protocol::event(Event::CRASH, &fields));
}
