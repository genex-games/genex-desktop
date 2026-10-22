//! Android's account of the last run (game systems CRASH-4). At the next launch the shell asks
//! `ActivityManager.getHistoricalProcessExitReasons` for its own last exit
//! ([`crate::jni_bridge::last_exit`]) and turns the ones the panic hook could not see into one
//! `genex-crash/1` record ([`crash_record`]):
//!
//! - `REASON_LOW_MEMORY`: an `out-of-memory` record;
//! - `REASON_CRASH_NATIVE`: a `native-fault` record, with the crashed thread's frames as
//!   `{image, offset}` pairs (`rel_pc` into the library named by its build id) read from the
//!   tombstone `getTraceInputStream` hands over from API 31 ([`tombstone_record`]); before 31,
//!   or without a trace, the record carries the description alone.
//!
//! Every other reason (a Rust panic, which the hook recorded, an exit, a kill) gives none. The
//! tombstone is AOSP's `tombstone.proto`, decoded from its field numbers (Apache-2.0; no copy of
//! the schema is kept) as hostile input: at most [`TOMBSTONE_MAX_BYTES`], at most
//! [`THREADS_MAX`] threads read, frames past genex-crash's caps dropped.

use genex_platform_ios::mobile::crash::{CrashFrame, CrashKind, CrashRecord, CrashSource, RecordContext, image_index};
use genex_platform_ios::mobile::records::Records;

/// `ApplicationExitInfo.REASON_LOW_MEMORY`.
pub const REASON_LOW_MEMORY: i32 = 3;
/// `ApplicationExitInfo.REASON_CRASH_NATIVE`.
pub const REASON_CRASH_NATIVE: i32 = 5;
/// The largest tombstone read (they are tens of KiB; memory dumps make them larger).
pub const TOMBSTONE_MAX_BYTES: usize = 4 * 1024 * 1024;
/// The most threads read from a tombstone.
pub const THREADS_MAX: usize = 1024;
/// The most frames read from the crashed thread (genex-crash keeps fewer).
const STACK_FRAMES_MAX: usize = 256;

/// `tombstone.proto` field numbers (AOSP `system/core/debuggerd/proto/tombstone.proto`).
mod field {
    /// `Tombstone.tid`: the crashed thread.
    pub const TOMBSTONE_TID: u32 = 6;
    /// `Tombstone.signal_info`.
    pub const TOMBSTONE_SIGNAL: u32 = 10;
    /// `Tombstone.abort_message`.
    pub const TOMBSTONE_ABORT: u32 = 14;
    /// `Tombstone.threads` (a `map<uint32, Thread>`: entries of key 1, value 2).
    pub const TOMBSTONE_THREADS: u32 = 16;
    /// A map entry's key and value.
    pub const ENTRY_KEY: u32 = 1;
    pub const ENTRY_VALUE: u32 = 2;
    /// `Signal.number`, `Signal.code`.
    pub const SIGNAL_NUMBER: u32 = 1;
    pub const SIGNAL_CODE: u32 = 3;
    /// `Thread.id`, `Thread.current_backtrace`.
    pub const THREAD_ID: u32 = 1;
    pub const THREAD_BACKTRACE: u32 = 4;
    /// `BacktraceFrame.rel_pc`, `.file_name`, `.build_id`.
    pub const FRAME_REL_PC: u32 = 1;
    pub const FRAME_FILE_NAME: u32 = 6;
    pub const FRAME_BUILD_ID: u32 = 8;
}

/// One protobuf field: its number and its value (a varint, or a length-delimited span).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Wire<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed,
}

/// The fields of one message, in order; `None` for a malformed message.
fn fields(mut bytes: &[u8]) -> Option<Vec<(u32, Wire<'_>)>> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        let tag = varint(&mut bytes)?;
        let number = u32::try_from(tag >> 3).ok()?;
        let value = match tag & 7 {
            0 => Wire::Varint(varint(&mut bytes)?),
            1 => skip(&mut bytes, 8)?,
            2 => {
                let length = usize::try_from(varint(&mut bytes)?).ok()?;
                let (span, rest) = bytes.split_at_checked(length)?;
                bytes = rest;
                Wire::Bytes(span)
            }
            5 => skip(&mut bytes, 4)?,
            _ => return None,
        };
        out.push((number, value));
    }
    Some(out)
}

fn skip(bytes: &mut &[u8], count: usize) -> Option<Wire<'static>> {
    *bytes = bytes.get(count..)?;
    Some(Wire::Fixed)
}

/// A base-128 varint, at most ten bytes.
fn varint(bytes: &mut &[u8]) -> Option<u64> {
    let mut value = 0u64;
    for (at, byte) in bytes.iter().take(10).enumerate() {
        value |= u64::from(byte & 0x7F) << (7 * at);
        if byte & 0x80 == 0 {
            *bytes = &bytes[at + 1..];
            return Some(value);
        }
    }
    None
}

fn number_of(fields: &[(u32, Wire<'_>)], number: u32) -> Option<u64> {
    fields.iter().find_map(|(n, value)| match value {
        Wire::Varint(v) if *n == number => Some(*v),
        _ => None,
    })
}

fn bytes_of<'a>(fields: &[(u32, Wire<'a>)], number: u32) -> impl Iterator<Item = &'a [u8]> {
    fields.iter().filter_map(move |(n, value)| match value {
        Wire::Bytes(span) if *n == number => Some(*span),
        _ => None,
    })
}

fn text_of(fields: &[(u32, Wire<'_>)], number: u32) -> String {
    bytes_of(fields, number).next().map(|span| String::from_utf8_lossy(span).into_owned()).unwrap_or_default()
}

/// Why a tombstone gave no record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TombstoneError {
    /// Over [`TOMBSTONE_MAX_BYTES`].
    TooLarge,
    /// Not a tombstone message.
    Malformed,
}

/// A native crash's tombstone as a `native-fault` record: the signal and abort message, and the
/// crashed thread's backtrace as image frames (each library by its file name and build id).
pub fn tombstone_record(tombstone: &[u8]) -> Result<CrashRecord, TombstoneError> {
    if tombstone.len() > TOMBSTONE_MAX_BYTES {
        return Err(TombstoneError::TooLarge);
    }
    let top = fields(tombstone).ok_or(TombstoneError::Malformed)?;
    let signal = bytes_of(&top, field::TOMBSTONE_SIGNAL).next().and_then(fields).unwrap_or_default();
    let number = |n: u32| number_of(&signal, n).map_or_else(|| "-".to_owned(), |value| (value as i32).to_string());
    let mut message = format!("signal {}, code {}", number(field::SIGNAL_NUMBER), number(field::SIGNAL_CODE));
    let abort = text_of(&top, field::TOMBSTONE_ABORT);
    if !abort.is_empty() {
        message.push_str(": ");
        message.push_str(&abort);
    }
    let mut record = CrashRecord::new(CrashKind::NativeFault, CrashSource::Platform, true, message);
    record.context = RecordContext { destination: Some("android".to_owned()), ..RecordContext::default() };
    let tid = number_of(&top, field::TOMBSTONE_TID);
    if let Some(thread) = crashed_thread(&top, tid) {
        push_backtrace(&mut record, &thread);
    }
    Ok(record)
}

/// The crashed thread's fields: the `threads` entry keyed (or id'd) `tid`, else the first.
fn crashed_thread<'a>(top: &[(u32, Wire<'a>)], tid: Option<u64>) -> Option<Vec<(u32, Wire<'a>)>> {
    let mut threads = Vec::new();
    for entry in bytes_of(top, field::TOMBSTONE_THREADS).take(THREADS_MAX) {
        let entry = fields(entry)?;
        let thread = fields(bytes_of(&entry, field::ENTRY_VALUE).next()?)?;
        let id = number_of(&entry, field::ENTRY_KEY).or_else(|| number_of(&thread, field::THREAD_ID));
        threads.push((id, thread));
    }
    let at = threads.iter().position(|(id, _)| tid.is_some() && *id == tid).unwrap_or(0);
    (at < threads.len()).then(|| threads.swap_remove(at).1)
}

fn push_backtrace(record: &mut CrashRecord, thread: &[(u32, Wire<'_>)]) {
    for frame in bytes_of(thread, field::THREAD_BACKTRACE).take(STACK_FRAMES_MAX) {
        let Some(frame) = fields(frame) else { continue };
        let Some(offset) = number_of(&frame, field::FRAME_REL_PC) else { continue };
        let (name, id) = (text_of(&frame, field::FRAME_FILE_NAME), text_of(&frame, field::FRAME_BUILD_ID));
        let image = image_index(&mut record.images, &name, &id);
        record.frames.push(CrashFrame::Image { image, offset });
    }
}

/// The record of an exit the hook could not see (`reason` an `ApplicationExitInfo.REASON_*`,
/// `description` the system's text, `trace` the tombstone when there is one), or `None` for an
/// exit that needs none.
pub fn crash_record(reason: i32, description: &str, trace: Option<&[u8]>) -> Option<CrashRecord> {
    let detail = |text: &str| if description.is_empty() { text.to_owned() } else { format!("{text}: {description}") };
    match reason {
        REASON_LOW_MEMORY => {
            let mut record = CrashRecord::new(CrashKind::OutOfMemory, CrashSource::Platform, true, detail("low memory"));
            record.context = RecordContext { destination: Some("android".to_owned()), ..RecordContext::default() };
            Some(record)
        }
        REASON_CRASH_NATIVE => {
            let mut record = trace.and_then(|bytes| tombstone_record(bytes).ok()).unwrap_or_else(|| {
                let mut bare = CrashRecord::new(CrashKind::NativeFault, CrashSource::Platform, true, String::new());
                bare.context = RecordContext { destination: Some("android".to_owned()), ..RecordContext::default() };
                bare
            });
            record.message = if record.message.is_empty() { detail("native crash") } else { record.message };
            Some(record)
        }
        _ => None,
    }
}

/// The file under `genex-self-test` holding the timestamp of the last exit recorded, so a launch
/// never records the same exit twice.
pub const LAST_EXIT_FILE: &str = "last-exit.txt";

/// Record the process's last exit, at launch (`ApplicationExitInfo`, API 30+): a low-memory kill
/// or a native crash not recorded yet becomes one `crash-<n>.json` under `records`. Best effort:
/// a missing API, a refused folder or an unreadable trace is logged, never fatal.
#[cfg(target_os = "android")]
pub fn record_last_exit(records: &Records) {
    let Some(exit) = crate::jni_bridge::last_exit(TOMBSTONE_MAX_BYTES) else { return };
    record_exit(records, exit.timestamp_ms, exit.reason, &exit.description, exit.trace.as_deref());
}

/// Record one exit (`reason` at `timestamp_ms`, the system's `description` and `trace`) under
/// `records` unless [`LAST_EXIT_FILE`] says it was recorded; answers whether a record was written.
/// The marker is written only after the record, never through a symlink.
pub fn record_exit(records: &Records, timestamp_ms: i64, reason: i32, description: &str, trace: Option<&[u8]>) -> bool {
    let stamp = timestamp_ms.to_string();
    if records.read_marker(LAST_EXIT_FILE).is_some_and(|seen| seen.trim() == stamp) {
        return false;
    }
    let Some(record) = crash_record(reason, description, trace) else { return false };
    if let Err(error) = records.write_platform_crash(&record) {
        log::warn!("last exit not recorded: {error:?}");
        return false;
    }
    if let Err(error) = records.write_marker(LAST_EXIT_FILE, &stamp) {
        log::warn!("last exit marker not written: {error:?}");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_varint(out: &mut Vec<u8>, mut value: u64) {
        while value >= 0x80 {
            out.push((value as u8) | 0x80);
            value >>= 7;
        }
        out.push(value as u8);
    }

    fn num(out: &mut Vec<u8>, number: u32, value: u64) {
        put_varint(out, u64::from(number) << 3);
        put_varint(out, value);
    }

    fn bytes(out: &mut Vec<u8>, number: u32, value: &[u8]) {
        put_varint(out, (u64::from(number) << 3) | 2);
        put_varint(out, value.len() as u64);
        out.extend_from_slice(value);
    }

    fn frame(rel_pc: u64, file: &str, build_id: &str) -> Vec<u8> {
        let mut out = Vec::new();
        num(&mut out, field::FRAME_REL_PC, rel_pc);
        num(&mut out, 2, rel_pc + 0x7000_0000);
        bytes(&mut out, 4, b"symbol_not_used");
        bytes(&mut out, field::FRAME_FILE_NAME, file.as_bytes());
        bytes(&mut out, field::FRAME_BUILD_ID, build_id.as_bytes());
        out
    }

    /// A SIGSEGV tombstone: the crashed thread 4242 (two frames in the game's library, one in
    /// libc) and a second thread.
    fn tombstone() -> Vec<u8> {
        let mut crashed = Vec::new();
        num(&mut crashed, field::THREAD_ID, 4242);
        bytes(&mut crashed, 2, b"GameThread");
        for (pc, file, id) in [(0x1a2b0, "/data/app/lib/arm64/libpond.so", "8f3c"), (0x1a100, "/data/app/lib/arm64/libpond.so", "8f3c"), (0x4c0, "/apex/com.android.runtime/lib64/bionic/libc.so", "a1b2")] {
            bytes(&mut crashed, field::THREAD_BACKTRACE, &frame(pc, file, id));
        }
        let mut other = Vec::new();
        num(&mut other, field::THREAD_ID, 7);
        bytes(&mut other, field::THREAD_BACKTRACE, &frame(0x10, "/system/lib64/libbinder.so", "ffff"));
        let mut signal = Vec::new();
        num(&mut signal, field::SIGNAL_NUMBER, 11);
        bytes(&mut signal, 2, b"SIGSEGV");
        num(&mut signal, field::SIGNAL_CODE, 1);
        let mut out = Vec::new();
        num(&mut out, 1, 1);
        bytes(&mut out, 2, b"google/device/build:14/fingerprint");
        num(&mut out, 5, 4242);
        num(&mut out, field::TOMBSTONE_TID, 4242);
        bytes(&mut out, field::TOMBSTONE_SIGNAL, &signal);
        for (key, thread) in [(7u64, &other), (4242, &crashed)] {
            let mut entry = Vec::new();
            num(&mut entry, field::ENTRY_KEY, key);
            bytes(&mut entry, field::ENTRY_VALUE, thread);
            bytes(&mut out, field::TOMBSTONE_THREADS, &entry);
        }
        out
    }

    #[test]
    fn a_tombstone_becomes_one_native_fault_record_with_image_offset_frames() {
        let record = tombstone_record(&tombstone()).expect("decoded");
        assert_eq!((record.kind, record.source, record.fatal), (CrashKind::NativeFault, CrashSource::Platform, true));
        assert_eq!(record.message, "signal 11, code 1");
        assert_eq!(record.frames, [CrashFrame::Image { image: 0, offset: 0x1a2b0 }, CrashFrame::Image { image: 0, offset: 0x1a100 }, CrashFrame::Image { image: 1, offset: 0x4c0 }]);
        let images: Vec<(&str, &str)> = record.images.iter().map(|image| (image.name.as_str(), image.id.as_str())).collect();
        assert_eq!(images, [("/data/app/lib/arm64/libpond.so", "8f3c"), ("/apex/com.android.runtime/lib64/bionic/libc.so", "a1b2")]);
        // What the host's parser reads: genex-crash's reader is its twin.
        let parsed = CrashRecord::from_json(&record.to_json()).expect("the record parses");
        assert_eq!(parsed.frames, record.frames);
        assert_eq!(parsed.kind, CrashKind::NativeFault);
    }

    #[test]
    fn exit_reasons_map_to_records_and_hostile_tombstones_never_panic() {
        let oom = crash_record(REASON_LOW_MEMORY, "lmkd", None).expect("a low-memory record");
        assert_eq!((oom.kind, oom.message.as_str()), (CrashKind::OutOfMemory, "low memory: lmkd"));
        let bare = crash_record(REASON_CRASH_NATIVE, "crash", None).expect("a native record without a trace");
        assert_eq!((bare.kind, bare.frames.len()), (CrashKind::NativeFault, 0));
        assert_eq!(crash_record(REASON_CRASH_NATIVE, "", Some(&tombstone())).expect("traced").frames.len(), 3);
        for other in [0, 1, 2, 4, 6, 10, 13] {
            assert!(crash_record(other, "x", None).is_none(), "reason {other} needs no record");
        }
        let whole = tombstone();
        for cut in 0..whole.len() {
            let _ = tombstone_record(&whole[..cut]);
        }
        assert_eq!(tombstone_record(&[0xFF; 11]), Err(TombstoneError::Malformed));
        assert_eq!(tombstone_record(&vec![0; TOMBSTONE_MAX_BYTES + 1]), Err(TombstoneError::TooLarge));
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("genex-exit-info-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[cfg(unix)]
    #[test]
    fn an_exit_is_recorded_once_and_its_marker_never_follows_a_symlink() {
        let root = scratch("once");
        let records = Records::new(&root, "android");
        assert!(record_exit(&records, 1_700_000_000_123, REASON_CRASH_NATIVE, "", Some(&tombstone())), "the first launch records it");
        assert!(!record_exit(&records, 1_700_000_000_123, REASON_CRASH_NATIVE, "", Some(&tombstone())), "the next launch does not");
        assert!(!record_exit(&records, 1_700_000_000_999, 10, "user requested", None), "an exit that needs no record");
        assert!(record_exit(&records, 1_700_000_001_000, REASON_LOW_MEMORY, "lmkd", None), "a later kill");
        assert_eq!(records.crash_records().len(), 2);
        // A marker planted as a symlink out of the folder is never written through: the exit is
        // recorded, the outside file untouched.
        let outside = scratch("outside");
        let planted = scratch("planted");
        let records = Records::new(&planted, "android");
        std::fs::create_dir_all(records.dir()).expect("dir");
        std::fs::write(outside.join("victim.txt"), b"keep").expect("victim");
        std::os::unix::fs::symlink(outside.join("victim.txt"), records.dir().join(LAST_EXIT_FILE)).expect("symlink");
        assert!(record_exit(&records, 5, REASON_LOW_MEMORY, "", None));
        assert_eq!(std::fs::read(outside.join("victim.txt")).expect("victim"), b"keep");
        for dir in [root, outside, planted] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
