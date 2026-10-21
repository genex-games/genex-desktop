//! Game systems CRASH-4, host-side rows: phone crash records under `genex-self-test`. A decoded
//! MetricKit payload becomes one typed `genex-crash/1` record with `{image, offset}` frames, which
//! genex-crash's reader (the host parser's twin) accepts; records are `crash-<n>.json`, capped, and
//! a symlinked records folder or root refuses with nothing written. The device rows (a forced panic
//! and a forced native fault on both phones, pulled and parsed) are the owner's.

use std::path::{Path, PathBuf};

use genex_crash::{CRASH_FILES_KEPT, CrashFrame, CrashKind, CrashRecord, CrashSource};
use genex_platform_ios::metric_kit::{METRIC_KIT_PAYLOAD_MAX_BYTES, METRIC_KIT_SEEN_FILE, MetricKitError, crash_records, record_payload};
use genex_platform_ios::mobile::crash::CrashRecordsError;
use genex_platform_ios::mobile::records::{CRASH_FORMAT, Records};

/// An `MXDiagnosticPayload` as `jsonRepresentation` writes it: one crash diagnostic (EXC_BAD_ACCESS,
/// SIGSEGV) whose attributed thread crashed two frames deep in the game, called from UIKit.
const METRIC_KIT_PAYLOAD: &str = r#"{
  "timeStampBegin": "2026-10-21 10:00:00",
  "timeStampEnd": "2026-10-21 10:00:00",
  "crashDiagnostics": [{
    "version": "1.0.0",
    "callStackTree": {
      "callStackPerThread": true,
      "callStacks": [
        {"threadAttributed": false, "callStackRootFrames": [
          {"binaryUUID": "11111111-2222-3333-4444-555555555555", "offsetIntoBinaryTextSegment": 4096, "binaryName": "libsystem_kernel.dylib", "address": 7000000000, "sampleCount": 1}
        ]},
        {"threadAttributed": true, "callStackRootFrames": [
          {"binaryUUID": "9C3A9E4B-2F7D-3A41-8B0E-6D2C1F0A7E55", "offsetIntoBinaryTextSegment": 123456, "binaryName": "pond", "address": 4295091200, "sampleCount": 1,
           "subFrames": [
             {"binaryUUID": "9C3A9E4B-2F7D-3A41-8B0E-6D2C1F0A7E55", "offsetIntoBinaryTextSegment": 120000, "binaryName": "pond", "address": 4295087744, "sampleCount": 1,
              "subFrames": [
                {"binaryUUID": "A0B1C2D3-E4F5-4A5B-8C7D-9E0F1A2B3C4D", "offsetIntoBinaryTextSegment": 777, "binaryName": "UIKitCore", "address": 7100000000, "sampleCount": 1}
              ]}
           ]}
        ]}
      ]
    },
    "diagnosticMetaData": {
      "appBuildVersion": "42", "appVersion": "1.0", "regionFormat": "US", "osVersion": "iPhone OS 18.0 (22A3354)",
      "deviceType": "iPhone16,1", "platformArchitecture": "arm64e", "bundleIdentifier": "games.genex.pond",
      "exceptionType": 1, "exceptionCode": 0, "signal": 11, "terminationReason": "Namespace SIGNAL, Code 11"
    }
  }]
}"#;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-crash-records-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch");
    dir
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

#[test]
fn a_metric_kit_crash_payload_becomes_one_native_fault_record_with_image_offset_frames() {
    let records = crash_records(METRIC_KIT_PAYLOAD.as_bytes()).expect("decoded");
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!((record.kind, record.source, record.fatal), (CrashKind::NativeFault, CrashSource::Platform, true));
    assert_eq!(record.message, "signal 11, exception type 1 code 0: Namespace SIGNAL, Code 11");
    assert_eq!(
        record.frames,
        [CrashFrame::Image { image: 0, offset: 123_456 }, CrashFrame::Image { image: 0, offset: 120_000 }, CrashFrame::Image { image: 1, offset: 777 }],
        "the attributed thread, crashed frame first"
    );
    let images: Vec<(&str, &str)> = record.images.iter().map(|image| (image.name.as_str(), image.id.as_str())).collect();
    assert_eq!(images, [("pond", "9C3A9E4B-2F7D-3A41-8B0E-6D2C1F0A7E55"), ("UIKitCore", "A0B1C2D3-E4F5-4A5B-8C7D-9E0F1A2B3C4D")]);
    assert_eq!(record.context.build.as_deref(), Some("42"));
    let json = record.to_json();
    let parsed = CrashRecord::from_json(&json).expect("the host parser's twin accepts it");
    assert_eq!((parsed.frames.clone(), parsed.images.len()), (record.frames.clone(), 2));
    let value: serde_json::Value = serde_json::from_slice(&json).expect("json");
    assert_eq!(value["format"], serde_json::json!(CRASH_FORMAT));
}

#[test]
fn a_resource_kill_is_out_of_memory_and_hostile_payloads_give_no_record() {
    let oom = METRIC_KIT_PAYLOAD.replace(r#""exceptionType": 1"#, r#""exceptionType": 11"#);
    assert_eq!(crash_records(oom.as_bytes()).expect("decoded")[0].kind, CrashKind::OutOfMemory);
    let single = serde_json::from_str::<serde_json::Value>(METRIC_KIT_PAYLOAD).expect("json")["crashDiagnostics"][0].to_string();
    assert_eq!(crash_records(single.as_bytes()).expect("a lone diagnostic").len(), 1);
    assert_eq!(crash_records(b"[1,2]"), Err(MetricKitError::NotJson));
    assert_eq!(crash_records(b"not json"), Err(MetricKitError::NotJson));
    assert_eq!(crash_records(br#"{"crashDiagnostics":[{"diagnosticMetaData":{}}]}"#), Err(MetricKitError::NoCrash));
    assert_eq!(crash_records(&vec![b' '; METRIC_KIT_PAYLOAD_MAX_BYTES + 1]), Err(MetricKitError::TooLarge));
    // Frames with no UUID or offset are skipped, a deep chain is read, and nothing panics; past
    // serde_json's nesting limit a payload is refused, never followed.
    let mut deep = String::from(r#"{"binaryUUID":"AB","offsetIntoBinaryTextSegment":1}"#);
    for _ in 0..50 {
        deep = format!(r#"{{"binaryUUID":"AB","offsetIntoBinaryTextSegment":1,"subFrames":[{deep}]}}"#);
    }
    let payload = format!(r#"{{"callStackTree":{{"callStacks":[{{"callStackRootFrames":[{{"binaryName":"x"}},{deep}]}}]}}}}"#);
    let record = &crash_records(payload.as_bytes()).expect("decoded")[0];
    assert_eq!(record.frames.len(), 51);
    assert!(CrashRecord::from_json(&record.to_json()).is_ok());
    let deeper = (0..100).fold(String::from("{}"), |inner, _| format!(r#"{{"subFrames":[{inner}]}}"#));
    let payload = format!(r#"{{"callStackTree":{{"callStacks":[{{"callStackRootFrames":[{deeper}]}}]}}}}"#);
    assert_eq!(crash_records(payload.as_bytes()), Err(MetricKitError::NotJson));
}

#[test]
fn crash_records_are_numbered_capped_and_written_whole() {
    let root = scratch("numbered");
    let records = Records::new(&root, "ios");
    let record = &crash_records(METRIC_KIT_PAYLOAD.as_bytes()).expect("decoded")[0];
    let first = records.write_platform_crash(record).expect("written");
    assert_eq!(first, root.join("genex-self-test/crash-0.json"));
    assert_eq!(CrashRecord::from_json(&std::fs::read(&first).expect("read")).expect("parses").kind, CrashKind::NativeFault);
    for _ in 0..CRASH_FILES_KEPT + 3 {
        records.write_platform_crash(record).expect("written");
    }
    let kept = records.crash_records();
    assert_eq!(kept.len(), CRASH_FILES_KEPT, "the oldest go");
    assert_eq!(kept.last().expect("newest").file_name().expect("name"), format!("crash-{}.json", CRASH_FILES_KEPT + 3).as_str());
    assert!(!kept.iter().any(|path| path.ends_with("crash-0.json")));
    assert_eq!(records.write_crash(&vec![b'x'; genex_crash::CRASH_RECORD_MAX_BYTES + 1]), Err(CrashRecordsError::TooLarge));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn a_symlinked_records_folder_or_root_refuses_and_nothing_is_written() {
    let outside = scratch("outside");
    let record = &crash_records(METRIC_KIT_PAYLOAD.as_bytes()).expect("decoded")[0];
    // genex-self-test a symlink out of the root.
    let root = scratch("linked-dir");
    std::os::unix::fs::symlink(&outside, root.join("genex-self-test")).expect("symlink");
    let records = Records::new(&root, "ios");
    assert_eq!(records.write_platform_crash(record), Err(CrashRecordsError::Unsafe));
    // The root itself a symlink.
    let parent = scratch("linked-root");
    std::os::unix::fs::symlink(&outside, parent.join("root")).expect("symlink");
    let records = Records::new(&parent.join("root"), "android");
    assert_eq!(records.write_platform_crash(record), Err(CrashRecordsError::Unsafe));
    // genex-self-test a file, not a folder.
    let plain = scratch("file-dir");
    std::fs::write(plain.join("genex-self-test"), b"not a folder").expect("file");
    assert_eq!(Records::new(&plain, "ios").write_platform_crash(record), Err(CrashRecordsError::Unsafe));
    assert!(files_in(&outside).is_empty(), "nothing written through a symlink: {:?}", files_in(&outside));
    // A planted symlink named like the next record is skipped, never followed.
    let planted = scratch("planted");
    std::fs::create_dir_all(planted.join("genex-self-test")).expect("dir");
    std::os::unix::fs::symlink(outside.join("target.json"), planted.join("genex-self-test/crash-0.json")).expect("symlink");
    let path = Records::new(&planted, "ios").write_platform_crash(record).expect("written past the planted name");
    assert_eq!(path, planted.join("genex-self-test/crash-1.json"));
    assert!(files_in(&outside).is_empty(), "the planted link was not followed");
    for dir in [outside, root, parent, plain, planted] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(unix)]
#[test]
fn a_payload_delivered_twice_is_recorded_once_and_the_seen_marker_never_follows_a_symlink() {
    let root = scratch("seen");
    let records = Records::new(&root, "ios");
    // The past list at launch and the subscriber can hand over the same payload.
    assert_eq!(record_payload(&records, METRIC_KIT_PAYLOAD.as_bytes()), 1);
    assert_eq!(record_payload(&records, METRIC_KIT_PAYLOAD.as_bytes()), 0, "already recorded");
    let oom = METRIC_KIT_PAYLOAD.replace(r#""exceptionType": 1"#, r#""exceptionType": 11"#);
    assert_eq!(record_payload(&records, oom.as_bytes()), 1, "another payload");
    assert_eq!(record_payload(&records, br#"{"cpuExceptionDiagnostics":[]}"#), 0, "no crash in it");
    assert_eq!(record_payload(&records, b"not json"), 0);
    assert_eq!(records.crash_records().len(), 2);
    let seen = std::fs::read_to_string(root.join("genex-self-test").join(METRIC_KIT_SEEN_FILE)).expect("marker");
    assert_eq!(seen.lines().count(), 3, "the two crashes and the payload without one");
    // A seen marker planted as a symlink: the payload is recorded, nothing written through it.
    let outside = scratch("seen-outside");
    std::fs::write(outside.join("victim.txt"), b"keep").expect("victim");
    let planted = scratch("seen-planted");
    std::fs::create_dir_all(planted.join("genex-self-test")).expect("dir");
    std::os::unix::fs::symlink(outside.join("victim.txt"), planted.join("genex-self-test").join(METRIC_KIT_SEEN_FILE)).expect("symlink");
    let records = Records::new(&planted, "ios");
    assert_eq!(record_payload(&records, METRIC_KIT_PAYLOAD.as_bytes()), 1);
    assert_eq!(std::fs::read(outside.join("victim.txt")).expect("victim"), b"keep");
    assert_eq!(records.write_marker(METRIC_KIT_SEEN_FILE, "x"), Err(CrashRecordsError::Unsafe));
    for dir in [root, outside, planted] {
        let _ = std::fs::remove_dir_all(dir);
    }
}
