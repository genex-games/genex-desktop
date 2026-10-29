//! The capture file contract of v1: `<state>/captures/<seq>.bgra`, raw BGRA rows top-down,
//! FNV-1a-64 digest as 16 lowercase hex digits, the newest eight kept.

use std::fs;
use std::path::PathBuf;

use genex_render::capture::{CAPTURE_FORMAT, CAPTURES_KEPT, Capture, CaptureFiles, fnv1a64, hex64};
use genex_render::caps::NATIVE_MAX_WORLD_PX;
use genex_render::{CAPTURE_MAX_BYTES, RenderCode};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-render-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch folder");
    dir
}

fn capture(width: u32, height: u32, fill: u8) -> Capture {
    Capture::new(width, height, vec![fill; (width * height * 4) as usize]).expect("a well-sized capture")
}

#[test]
fn fnv1a64_matches_the_reference_vectors_and_hex64_pads_to_sixteen_digits() {
    assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    assert_eq!(hex64(0xaf63_dc4c_8601_ec8c), "af63dc4c8601ec8c");
    assert_eq!(hex64(0x1f), "000000000000001f");
}

#[test]
fn padded_readback_rows_are_stripped_without_reordering_or_swizzling() {
    // Two rows of 2 pixels, padded to 16 bytes per row as a GPU readback would be.
    let mut padded = vec![0xEE; 32];
    padded[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    padded[16..24].copy_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);
    let capture = Capture::from_padded_rows(2, 2, 16, &padded).expect("strip");
    assert_eq!(capture.bgra(), &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert_eq!(capture.digest(), fnv1a64(capture.bgra()));
}

#[test]
fn a_capture_of_the_wrong_size_or_above_the_memory_cap_is_refused() {
    assert_eq!(Capture::new(2, 2, vec![0; 15]).expect_err("short").code(), RenderCode::CaptureFailed);
    assert_eq!(Capture::from_padded_rows(2, 2, 4, &[0; 8]).expect_err("row too small").code(), RenderCode::CaptureFailed);
    let side = NATIVE_MAX_WORLD_PX + 1;
    assert!(u64::from(side) * u64::from(side) * 4 > CAPTURE_MAX_BYTES);
    assert_eq!(Capture::from_padded_rows(side, side, side * 4, &[]).expect_err("cap").code(), RenderCode::CaptureTooLarge);
}

#[test]
fn files_are_numbered_from_one_and_only_the_newest_eight_are_kept() {
    let root = scratch("kept");
    let mut files = CaptureFiles::new(&root).expect("an absolute state root");
    for n in 1..=10u8 {
        let record = files.write(&capture(3, 2, n)).expect("written");
        assert_eq!(record.seq, u32::from(n));
        assert_eq!((record.width, record.height), (3, 2));
        assert_eq!(record.format, CAPTURE_FORMAT);
        assert_eq!(record.digest, hex64(fnv1a64(&[n; 24])));
        let written = fs::read(root.join("captures").join(format!("{n}.bgra"))).expect("the file");
        assert_eq!(written, vec![n; 24]);
    }
    let mut kept: Vec<u32> = fs::read_dir(root.join("captures"))
        .expect("captures folder")
        .map(|entry| entry.expect("entry").file_name().to_string_lossy().trim_end_matches(".bgra").parse().expect("seq"))
        .collect();
    kept.sort_unstable();
    assert_eq!(kept, (3..=10).collect::<Vec<u32>>());
    assert_eq!(CAPTURES_KEPT, 8);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_relative_or_empty_state_root_is_refused_with_no_state_dir_and_writes_nothing() {
    for root in ["", "relative/state", "./state"] {
        let error = CaptureFiles::new(root.as_ref()).expect_err("not a run's state");
        assert_eq!(error.code(), RenderCode::NoStateDir, "{root:?}");
        assert_eq!(error.code().wire(), "no-state-dir");
    }
    assert!(!PathBuf::from("relative").exists());
}

#[test]
fn a_state_root_whose_captures_entry_is_a_file_refuses_capture_failed_without_advancing_seq() {
    let root = scratch("blocked");
    fs::write(root.join("captures"), b"not a folder").expect("blocker");
    let mut files = CaptureFiles::new(&root).expect("absolute");
    let error = files.write(&capture(1, 1, 7)).expect_err("cannot write under a file");
    assert_eq!(error.code(), RenderCode::CaptureFailed);
    assert_eq!(error.code().wire(), "capture-failed");
    fs::remove_file(root.join("captures")).expect("unblock");
    assert_eq!(files.write(&capture(1, 1, 7)).expect("now written").seq, 1, "the refused capture took no seq");
    let _ = fs::remove_dir_all(&root);
}
