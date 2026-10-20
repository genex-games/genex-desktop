//! Typed GPU incidents and caught panics (CRASH-2): with the crash hook installed, an uncaptured
//! validation error on a live device gives one `gpu-validation` record and still panics as before;
//! a forced device loss gives one `device-lost` record that is not fatal; a panicking job still
//! answers `JobError::Panicked` and its record says `handled: true, fatal: false`, and so does a
//! panicking pipeline compile. The hook is the process's, installed once for this test binary; each
//! row picks its own records out by message.

use std::sync::{Arc, Mutex, OnceLock};

use genex_crash::{CrashKind, CrashRecord, FnSink, GpuErrorClass, install};
use genex_render::Gpu;
use genex_render::compile::Compiled;
use genex_render::device_loss::DeviceWatch;
use genex_render::jobs::{JobError, Pool, Priority};

/// Every record the hook delivered in this process.
fn records() -> &'static Mutex<Vec<CrashRecord>> {
    static RECORDS: OnceLock<Arc<Mutex<Vec<CrashRecord>>>> = OnceLock::new();
    RECORDS.get_or_init(|| {
        let records = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&records);
        install(vec![Box::new(FnSink(move |record: &CrashRecord, _json: &[u8]| {
            kept.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(record.clone());
        }))]);
        records
    })
}

/// The records whose message contains `needle`.
fn records_with(needle: &str) -> Vec<CrashRecord> {
    let all = records().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    all.iter().filter(|record| record.message.contains(needle)).cloned().collect()
}

/// Whether `record`'s panic was raised in the file named `file`.
fn record_at(record: &CrashRecord, file: &str) -> bool {
    record.location.as_ref().is_some_and(|location| location.file.ends_with(file))
}

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

#[test]
fn a_panicking_job_answers_panicked_and_its_record_is_handled() {
    records();
    let pool = Pool::new(2);
    let failed = pool.spawn(Priority::Sim, || -> u32 { panic!("crash-2 job row") });
    assert_eq!(failed.wait(), Err(JobError::Panicked("crash-2 job row".to_owned())), "as before");
    assert_eq!(pool.spawn(Priority::Sim, || 3_u8).into_result(), Ok(3), "the pool keeps running");
    let found = records_with("crash-2 job row");
    assert_eq!(found.len(), 1, "one record: {found:?}");
    let record = &found[0];
    assert_eq!((record.kind, record.handled, record.fatal), (CrashKind::Panic, true, false));
}

#[test]
fn a_panicking_pipeline_compile_is_one_handled_record() {
    records();
    let compiled: Compiled<u32> = Compiled::spawn(|| panic!("crash-2 compile row"));
    let reached = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| *compiled.get()));
    assert!(reached.is_err(), "reading a compile that panicked panics, as before");
    // Two panics: the compile's own on its job thread, and the read's re-raise on this thread
    // (outside any catch the game made, so not handled).
    let found: Vec<CrashRecord> = records_with("crash-2 compile row");
    let in_job: Vec<&CrashRecord> = found.iter().filter(|record| record_at(record, "device_loss_records.rs")).collect();
    assert_eq!(in_job.len(), 1, "the compile's panic, recorded once: {found:?}");
    assert_eq!((in_job[0].kind, in_job[0].handled, in_job[0].fatal), (CrashKind::Panic, true, false));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_validation_error_on_a_live_device_is_one_gpu_validation_record_and_still_panics() {
    records();
    let Some(gpu) = gpu() else { return };
    let _watch = DeviceWatch::attach(&gpu);
    // MAP_READ with STORAGE is a validation error without MAPPABLE_PRIMARY_BUFFERS.
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("crash-2 invalid buffer"),
            size: 256,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        })
    }));
    let payload = failed.expect_err("an uncaptured error on a live device panics, as before");
    let message = payload.downcast_ref::<String>().map(String::as_str).unwrap_or("");
    assert!(message.starts_with("wgpu error: "), "the same panic as before: {message}");
    let found = records_with("crash-2 invalid buffer");
    assert_eq!(found.len(), 1, "one record: {found:?}");
    let record = &found[0];
    assert_eq!((record.kind, record.fatal, record.handled), (CrashKind::GpuValidation, true, false));
    let gpu_row = record.gpu.as_ref().expect("the GPU row");
    assert_eq!(gpu_row.class, Some(GpuErrorClass::Validation));
    assert!(gpu_row.description.contains("crash-2 invalid buffer"), "{}", gpu_row.description);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_forced_loss_is_one_device_lost_record_that_is_not_fatal() {
    records();
    let Some(gpu) = gpu() else { return };
    let before = records_with("").iter().filter(|record| record.kind == CrashKind::DeviceLost).count();
    let watch = DeviceWatch::attach(&gpu);
    watch.force_loss(&gpu);
    let _ = gpu.device.poll(wgpu::PollType::Poll);
    assert!(watch.is_lost());
    let lost: Vec<CrashRecord> = records_with("").into_iter().filter(|record| record.kind == CrashKind::DeviceLost).collect();
    assert_eq!(lost.len(), before + 1, "one device-lost record: {lost:?}");
    let record = lost.last().expect("the record");
    assert_eq!((record.fatal, record.handled), (false, false));
    assert!(record.gpu.as_ref().and_then(|gpu| gpu.reason.as_deref()).is_some_and(|reason| !reason.is_empty()));
}
