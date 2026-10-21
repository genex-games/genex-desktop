//! iOS MetricKit crash diagnostics (game systems CRASH-4). From iOS 15 an app subscribed to
//! `MXMetricManager` is handed an `MXDiagnosticPayload` at its next launch after a crash; each
//! `MXCrashDiagnostic` in it, as its `jsonRepresentation`, becomes one `genex-crash/1` record
//! ([`crash_records`]): `native-fault`, or `out-of-memory` for a resource kill (`EXC_RESOURCE`, the
//! memory limit: CPU and wake-up resource reports are separate diagnostics, never crashes), with
//! its frames as `{image, offset}` pairs into the binaries it names by UUID (unsymbolicated: the
//! host symbolicates with the build's debug files). The shell writes them under `genex-self-test`
//! ([`crate::mobile::records::Records::write_platform_crash`]).
//!
//! The payload is read as hostile input: at most [`METRIC_KIT_PAYLOAD_MAX_BYTES`], frames past
//! genex-crash's caps dropped, every number checked.
//!
//! At launch the shell [`subscribe`]s: the payloads MetricKit already delivered
//! (`pastDiagnosticPayloads`) and each one it delivers later (`didReceiveDiagnosticPayloads:`) go
//! through [`record_payload`], which records a payload once ([`METRIC_KIT_SEEN_FILE`] keeps the
//! digests of those recorded).

use std::sync::Mutex;

use genex::Value;
use genex_crash::{CrashFrame, CrashKind, CrashRecord, CrashSource, RecordContext};

use crate::mobile::records::Records;

/// The marker under `genex-self-test` listing the payloads already recorded, one digest a line.
pub const METRIC_KIT_SEEN_FILE: &str = "metric-kit-seen.txt";
/// The most digests the marker keeps (the newest).
const SEEN_KEPT: usize = 64;
/// One payload is recorded at a time (MetricKit delivers on its own queue while launch reads).
static RECORDING: Mutex<()> = Mutex::new(());

/// A payload's digest (FNV-1a, 64 bits, as 16 hex digits): what the seen marker names it by.
fn digest(payload: &[u8]) -> String {
    let hash = payload.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3));
    format!("{hash:016x}")
}

/// Record one `MXDiagnosticPayload` (its JSON) under `records`, unless it was recorded before:
/// each crash diagnostic becomes one `crash-<n>.json`. Answers how many records were written.
/// Best effort: a payload with no crash is only marked seen, and a refused folder or marker is
/// logged and leaves the payload to be tried again at the next launch.
pub fn record_payload(records: &Records, payload: &[u8]) -> usize {
    let _one = RECORDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let id = digest(payload);
    let seen = records.read_marker(METRIC_KIT_SEEN_FILE).unwrap_or_default();
    if seen.lines().any(|line| line == id) {
        return 0;
    }
    let crashes = match crash_records(payload) {
        Ok(crashes) => crashes,
        Err(MetricKitError::NoCrash) => Vec::new(),
        Err(error) => {
            log::warn!("MetricKit payload not read: {error:?}");
            return 0;
        }
    };
    let mut written = 0;
    for record in &crashes {
        match records.write_platform_crash(record) {
            Ok(_) => written += 1,
            Err(error) => {
                log::warn!("MetricKit crash not recorded: {error:?}");
                return written;
            }
        }
    }
    let mut lines: Vec<&str> = seen.lines().filter(|line| !line.is_empty()).collect();
    lines.push(&id);
    let kept = lines[lines.len().saturating_sub(SEEN_KEPT)..].join("\n");
    if let Err(error) = records.write_marker(METRIC_KIT_SEEN_FILE, &kept) {
        log::warn!("MetricKit marker not written: {error:?}");
    }
    written
}

/// Record MetricKit's crash diagnostics into `records` from now on: the payloads already delivered
/// now, each later one as it comes (iOS; nothing elsewhere). Once per process.
#[cfg(target_os = "ios")]
pub fn subscribe(records: Records) {
    ios::subscribe(records);
}

/// Record MetricKit's crash diagnostics into `records` from now on (iOS; nothing elsewhere).
#[cfg(not(target_os = "ios"))]
pub fn subscribe(records: Records) {
    let _ = records;
}

#[cfg(target_os = "ios")]
mod ios {
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, ClassBuilder, NSObject, Sel};
    use objc2::{ClassType, msg_send, sel};

    use super::record_payload;
    use crate::mobile::records::Records;

    // MXMetricManager and MXDiagnosticPayload live in MetricKit (iOS 13+; crash diagnostics 14+,
    // delivered at the next launch from 15): linking the framework loads the classes.
    #[link(name = "MetricKit", kind = "framework")]
    unsafe extern "C" {}

    /// Where the payloads are recorded: set once, by the first `subscribe`.
    static RECORDS: OnceLock<Records> = OnceLock::new();

    /// The bytes of an `NSData` (empty for nil).
    fn data_bytes(data: *mut AnyObject) -> Vec<u8> {
        // SAFETY: a non-null NSData from MetricKit, alive while its payload is.
        let Some(data) = (unsafe { data.as_ref() }) else { return Vec::new() };
        // SAFETY: -[NSData length] answers an NSUInteger; -bytes a pointer to that many bytes
        // (null when empty), alive while the data is.
        let (length, bytes): (usize, *const u8) = unsafe { (msg_send![data, length], msg_send![data, bytes]) };
        if bytes.is_null() || length == 0 {
            return Vec::new();
        }
        // SAFETY: as above, `length` readable bytes from `bytes`.
        unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec()
    }

    /// Record each `MXDiagnosticPayload` of the `NSArray` `list` (nil records nothing).
    fn record_list(records: &Records, list: *mut AnyObject) {
        // SAFETY: an NSArray from MetricKit, alive for this call.
        let Some(list) = (unsafe { list.as_ref() }) else { return };
        // SAFETY: -[NSArray count] answers an NSUInteger.
        let count: usize = unsafe { msg_send![list, count] };
        for index in 0..count {
            // SAFETY: -objectAtIndex: below the count answers an element owned by the array.
            let payload: *mut AnyObject = unsafe { msg_send![list, objectAtIndex: index] };
            // SAFETY: as above, owned by the array for this call.
            let Some(payload) = (unsafe { payload.as_ref() }) else { continue };
            // SAFETY: -[MXDiagnosticPayload JSONRepresentation] answers an autoreleased NSData.
            let json: *mut AnyObject = unsafe { msg_send![payload, JSONRepresentation] };
            record_payload(records, &data_bytes(json));
        }
    }

    /// `-didReceiveDiagnosticPayloads:`: MetricKit's delivery, recorded.
    unsafe extern "C-unwind" fn received(_this: &AnyObject, _cmd: Sel, payloads: *mut AnyObject) {
        if let Some(records) = RECORDS.get() {
            record_list(records, payloads);
        }
    }

    /// Record the payloads already delivered, then add a subscriber for the later ones.
    pub fn subscribe(records: Records) {
        if RECORDS.set(records).is_err() {
            return;
        }
        let Some(records) = RECORDS.get() else { return };
        let Some(manager_class) = AnyClass::get(c"MXMetricManager") else { return };
        // SAFETY: +[MXMetricManager sharedManager] answers the process's manager (never nil).
        let manager: *mut AnyObject = unsafe { msg_send![manager_class, sharedManager] };
        // SAFETY: the shared manager lives for the whole process.
        let Some(manager) = (unsafe { manager.as_ref() }) else { return };
        // SAFETY: -respondsToSelector: takes a selector and answers a BOOL.
        let past: bool = unsafe { msg_send![manager, respondsToSelector: sel!(pastDiagnosticPayloads)] };
        if past {
            // SAFETY: -pastDiagnosticPayloads (iOS 14+) answers an NSArray of MXDiagnosticPayload.
            let list: *mut AnyObject = unsafe { msg_send![manager, pastDiagnosticPayloads] };
            record_list(records, list);
        }
        let Some(mut builder) = ClassBuilder::new(c"GenexMetricKitSubscriber", NSObject::class()) else { return };
        if let Some(protocol) = AnyProtocol::get(c"MXMetricManagerSubscriber") {
            builder.add_protocol(protocol);
        }
        // SAFETY: `received` matches `-didReceiveDiagnosticPayloads:` (an object receiver, a
        // selector, one NSArray).
        unsafe {
            builder.add_method(sel!(didReceiveDiagnosticPayloads:), received as unsafe extern "C-unwind" fn(_, _, _));
        }
        let class = builder.register();
        // SAFETY: +new on an NSObject subclass answers a retained instance, kept for the whole
        // process (the manager does not own its subscribers).
        let subscriber: *mut AnyObject = unsafe { msg_send![class, new] };
        // SAFETY: the instance implements the protocol's one method the manager calls.
        let Some(subscriber) = (unsafe { subscriber.as_ref() }) else { return };
        // SAFETY: -addSubscriber: takes an id<MXMetricManagerSubscriber>.
        let () = unsafe { msg_send![manager, addSubscriber: subscriber] };
    }
}

/// The largest payload read (MetricKit's crash payloads are a few KiB to a few hundred).
pub const METRIC_KIT_PAYLOAD_MAX_BYTES: usize = 1024 * 1024;
/// Mach's `EXC_RESOURCE`: a resource limit; in a crash diagnostic the memory limit.
pub const EXC_RESOURCE: i64 = 11;
/// The most frames read from one call stack (genex-crash keeps fewer).
const STACK_FRAMES_MAX: usize = 256;

/// The JSON members read, in `MXCrashDiagnostic.jsonRepresentation`'s spelling.
mod key {
    pub const CRASH_DIAGNOSTICS: &str = "crashDiagnostics";
    pub const CALL_STACK_TREE: &str = "callStackTree";
    pub const CALL_STACKS: &str = "callStacks";
    pub const THREAD_ATTRIBUTED: &str = "threadAttributed";
    pub const ROOT_FRAMES: &str = "callStackRootFrames";
    pub const SUB_FRAMES: &str = "subFrames";
    pub const BINARY_UUID: &str = "binaryUUID";
    pub const BINARY_NAME: &str = "binaryName";
    pub const OFFSET: &str = "offsetIntoBinaryTextSegment";
    pub const META: &str = "diagnosticMetaData";
    pub const EXCEPTION_TYPE: &str = "exceptionType";
    pub const EXCEPTION_CODE: &str = "exceptionCode";
    pub const SIGNAL: &str = "signal";
    pub const TERMINATION_REASON: &str = "terminationReason";
    pub const BUILD: &str = "appBuildVersion";
}

/// Why a payload gave no record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetricKitError {
    /// Over [`METRIC_KIT_PAYLOAD_MAX_BYTES`].
    TooLarge,
    /// Not a JSON object.
    NotJson,
    /// No crash diagnostic in it.
    NoCrash,
}

/// The crash records of one payload: an `MXDiagnosticPayload` (its `crashDiagnostics`) or a single
/// `MXCrashDiagnostic`, each diagnostic with a call stack tree one record.
pub fn crash_records(payload: &[u8]) -> Result<Vec<CrashRecord>, MetricKitError> {
    if payload.len() > METRIC_KIT_PAYLOAD_MAX_BYTES {
        return Err(MetricKitError::TooLarge);
    }
    let value: Value = serde_json::from_slice(payload).map_err(|_| MetricKitError::NotJson)?;
    if !value.is_object() {
        return Err(MetricKitError::NotJson);
    }
    let diagnostics: Vec<&Value> = match value.get(key::CRASH_DIAGNOSTICS).and_then(Value::as_array) {
        Some(list) => list.iter().collect(),
        None => vec![&value],
    };
    let records: Vec<CrashRecord> = diagnostics.into_iter().filter_map(crash_record).collect();
    if records.is_empty() { Err(MetricKitError::NoCrash) } else { Ok(records) }
}

/// One `MXCrashDiagnostic`'s record, or `None` without a call stack tree.
fn crash_record(diagnostic: &Value) -> Option<CrashRecord> {
    let stacks = diagnostic.get(key::CALL_STACK_TREE)?.get(key::CALL_STACKS)?.as_array()?;
    let attributed = stacks.iter().find(|stack| stack.get(key::THREAD_ATTRIBUTED).and_then(Value::as_bool) == Some(true));
    let stack = attributed.or(stacks.first())?;
    let meta = diagnostic.get(key::META);
    let number = |name: &str| meta.and_then(|meta| meta.get(name)).and_then(Value::as_i64);
    let exception = number(key::EXCEPTION_TYPE);
    let kind = if exception == Some(EXC_RESOURCE) { CrashKind::OutOfMemory } else { CrashKind::NativeFault };
    let mut record = CrashRecord::new(kind, CrashSource::Platform, true, message(meta));
    let roots = stack.get(key::ROOT_FRAMES).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    for root in roots {
        push_chain(&mut record, root);
    }
    let build = meta.and_then(|meta| meta.get(key::BUILD)).and_then(Value::as_str).map(str::to_owned);
    record.context = RecordContext { build, destination: Some("ios".to_owned()), ..RecordContext::default() };
    Some(record)
}

/// The record's message from the typed codes (the OS's termination reason kept after them, as
/// data).
fn message(meta: Option<&Value>) -> String {
    let field = |name: &str| meta.and_then(|meta| meta.get(name));
    let number = |name: &str| field(name).and_then(Value::as_i64).map_or_else(|| "-".to_owned(), |n| n.to_string());
    let mut text = format!("signal {}, exception type {} code {}", number(key::SIGNAL), number(key::EXCEPTION_TYPE), number(key::EXCEPTION_CODE));
    if let Some(reason) = field(key::TERMINATION_REASON).and_then(Value::as_str).filter(|reason| !reason.is_empty()) {
        text.push_str(": ");
        text.push_str(reason);
    }
    text
}

/// A root frame and its first callers (`subFrames`, the crashed frame first), as image frames.
fn push_chain(record: &mut CrashRecord, root: &Value) {
    let mut frame = Some(root);
    while let Some(at) = frame.filter(|_| record.frames.len() < STACK_FRAMES_MAX) {
        let uuid = at.get(key::BINARY_UUID).and_then(Value::as_str);
        let offset = at.get(key::OFFSET).and_then(Value::as_u64);
        if let (Some(uuid), Some(offset)) = (uuid, offset) {
            let name = at.get(key::BINARY_NAME).and_then(Value::as_str).unwrap_or("");
            let image = crate::mobile::crash::image_index(&mut record.images, name, uuid);
            record.frames.push(CrashFrame::Image { image, offset });
        }
        frame = at.get(key::SUB_FRAMES).and_then(Value::as_array).and_then(|callers| callers.first());
    }
}
