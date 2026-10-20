//! The GPU-visible memory a native platform reports for an adapter (owner decision 2026-10-12
//! (2)): on a native desktop genex-render's memory budget grows with it
//! (`genex_render::presets::class_budget_bytes`). wgpu does not expose it, so the adapter probe asks the
//! backend through wgpu's hal:
//! - Metal: the device's `recommendedMaxWorkingSetSize` (Apple GPUs share the system's memory;
//!   Metal recommends about two thirds to three quarters of it);
//! - DX12: a discrete adapter's dedicated video memory (`DXGI_ADAPTER_DESC1`);
//! - Vulkan: a discrete adapter's largest device-local heap.
//!
//! An integrated GPU off Apple reports no dedicated memory worth reading (its device-local heap is
//! the system's), the web has `deviceMemory`, and an adapter that answers nothing is unknown: each
//! is None, and the class budget stands.
//!
//! Its own crate because the queries are FFI: genex-render stays safe Rust, so an ejected fork of it
//! builds under the lane's `-F unsafe_code`, and an eject leaves this crate the store's. For the
//! same reason it also opens the Vulkan pipeline cache from saved bytes ([`open_pipeline_cache`],
//! renderer pass 2, RC-09): wgpu marks that call `unsafe` for the bytes' provenance.
//!
//! It also reads the process's memory facts (game systems STR-7, [`MemoryFacts`]), which size the
//! streamed content pool (`genex_render::presets::stream_pool_bytes`): the machine's physical
//! memory, iOS's `os_proc_available_memory` (what the process may still take before jetsam ends
//! it), and Android's memory class and trim level, which only the JNI bridge can read
//! (`genex-platform-android`'s `jni_bridge::memory_state`), so the Android shell fills them in.

#![cfg_attr(
    not(target_arch = "wasm32"),
    allow(unsafe_code, reason = "wgpu's hal adapters and the backends' memory queries are FFI; each block says why it holds")
)]

mod process;

pub use process::{ProcessMemory, process_memory};

/// One MiB.
const MIB: u64 = 1024 * 1024;

/// `ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE`: the device is starting to run low; a running
/// app is not asked to shed anything yet.
pub const TRIM_MEMORY_RUNNING_MODERATE: i32 = 5;
/// `ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW`: the device is running low while the app runs;
/// from this level up the content pool is cut.
pub const TRIM_MEMORY_RUNNING_LOW: i32 = 10;
/// `ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL`: background processes are being killed.
pub const TRIM_MEMORY_RUNNING_CRITICAL: i32 = 15;

/// Vulkan's `VK_MEMORY_HEAP_DEVICE_LOCAL_BIT`.
#[cfg(any(windows, target_os = "linux", target_os = "android"))]
const VK_MEMORY_HEAP_DEVICE_LOCAL_BIT: u32 = 0x1;

/// The GPU-visible memory of `adapter` in bytes, or None when the platform does not say.
pub fn gpu_visible_memory(adapter: &wgpu::Adapter) -> Option<u64> {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = adapter;
        None
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let info = adapter.get_info();
        let bytes = match info.backend {
            wgpu::Backend::Metal => metal_working_set(adapter),
            wgpu::Backend::Dx12 if info.device_type == wgpu::DeviceType::DiscreteGpu => dx12_dedicated(adapter),
            wgpu::Backend::Vulkan if info.device_type == wgpu::DeviceType::DiscreteGpu => vulkan_device_local(adapter),
            _ => None,
        };
        bytes.filter(|bytes| *bytes > 0)
    }
}

/// Metal's recommended working set for `adapter`'s device.
#[cfg(all(not(target_arch = "wasm32"), target_vendor = "apple"))]
fn metal_working_set(adapter: &wgpu::Adapter) -> Option<u64> {
    // SAFETY: the hal adapter is only read here, while `adapter` keeps it alive; the guard is
    // dropped before this returns.
    let hal = unsafe { adapter.as_hal::<wgpu::hal::api::Metal>() }?;
    let device = hal.raw_device();
    // SAFETY: `recommendedMaxWorkingSetSize` is a read-only `uint64_t` property of every
    // MTLDevice on macOS 10.12 and iOS 16 (the floors this build supports).
    let bytes: u64 = unsafe { objc2::msg_send![device, recommendedMaxWorkingSetSize] };
    Some(bytes)
}

/// No Metal off Apple.
#[cfg(all(not(target_arch = "wasm32"), not(target_vendor = "apple")))]
fn metal_working_set(_adapter: &wgpu::Adapter) -> Option<u64> {
    None
}

/// The dedicated video memory DXGI reports for `adapter`.
#[cfg(target_os = "windows")]
fn dx12_dedicated(adapter: &wgpu::Adapter) -> Option<u64> {
    // SAFETY: the hal adapter is only read here, while `adapter` keeps it alive.
    let hal = unsafe { adapter.as_hal::<wgpu::hal::api::Dx12>() }?;
    // SAFETY: GetDesc1 fills a plain descriptor on a live adapter and has no other effect.
    let desc = unsafe { hal.raw_adapter().GetDesc1() }.ok()?;
    u64::try_from(desc.DedicatedVideoMemory).ok()
}

/// No DX12 off Windows.
#[cfg(all(not(target_arch = "wasm32"), not(target_os = "windows")))]
fn dx12_dedicated(_adapter: &wgpu::Adapter) -> Option<u64> {
    None
}

/// The largest device-local heap of `adapter`'s physical device (wgpu's native Vulkan platforms).
#[cfg(any(windows, target_os = "linux", target_os = "android"))]
fn vulkan_device_local(adapter: &wgpu::Adapter) -> Option<u64> {
    // SAFETY: the hal adapter is only read here, while `adapter` keeps it and its instance alive.
    let hal = unsafe { adapter.as_hal::<wgpu::hal::api::Vulkan>() }?;
    let instance = hal.shared_instance().raw_instance();
    // SAFETY: the physical device belongs to this instance; the query only reads its properties.
    let properties = unsafe { instance.get_physical_device_memory_properties(hal.raw_physical_device()) };
    properties
        .memory_heaps_as_slice()
        .iter()
        .filter(|heap| heap.flags.as_raw() & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT != 0)
        .map(|heap| heap.size)
        .max()
}

/// No native Vulkan backend here (Apple builds draw with Metal).
#[cfg(all(not(target_arch = "wasm32"), not(any(windows, target_os = "linux", target_os = "android"))))]
fn vulkan_device_local(_adapter: &wgpu::Adapter) -> Option<u64> {
    None
}

/// A pipeline cache on `device` (opened with `Features::PIPELINE_CACHE`), started from `data` when
/// wgpu accepts it and empty otherwise (`fallback`: a stale, foreign or truncated file never fails
/// the open); None when the device has no pipeline cache (Metal, D3D12 and the web keep their own).
pub fn open_pipeline_cache(device: &wgpu::Device, data: Option<&[u8]>) -> Option<wgpu::PipelineCache> {
    if !device.features().contains(wgpu::Features::PIPELINE_CACHE) {
        return None;
    }
    let descriptor = wgpu::PipelineCacheDescriptor { label: Some("genex pipeline cache"), data, fallback: true };
    // SAFETY: wgpu requires `data` to come from `PipelineCache::get_data` of an adapter with the
    // same `util::pipeline_cache_key`. genex-render's only caller passes the bytes it saved under
    // that key for this game, and wgpu checks the header it wrote (magic, ABI, backend, adapter
    // key, validation key and size) before the driver sees any of it, falling back to an empty
    // cache when they do not match.
    #[allow(unsafe_code, reason = "wgpu marks pipeline-cache creation unsafe for the bytes' provenance; the block says why it holds")]
    let cache = unsafe { device.create_pipeline_cache(&descriptor) };
    Some(cache)
}

/// What the platform says about memory for this process (game systems STR-7). Every field is
/// optional: a fact the platform does not give is None (or false), and the consumer keeps its
/// class default for it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemoryFacts {
    /// The machine's physical memory in bytes (`hw.memsize`, `MemTotal`, `ullTotalPhys`).
    pub physical_bytes: Option<u64>,
    /// What the process may still allocate before the OS ends it, in bytes (iOS
    /// `os_proc_available_memory`, iOS 13+).
    pub available_bytes: Option<u64>,
    /// Android's per-app memory class in MiB (`ActivityManager.getMemoryClass`).
    pub memory_class_mib: Option<u32>,
    /// Android's latest trim level (`ComponentCallbacks2.TRIM_MEMORY_*`, as
    /// `ActivityManager.getMyMemoryState` reports `lastTrimLevel`).
    pub trim_level: Option<i32>,
    /// Whether the OS says memory is low (Android `ActivityManager.MemoryInfo.lowMemory`, or a
    /// memory warning the shell received on either phone).
    pub low_memory: bool,
}

impl MemoryFacts {
    /// Whether the OS has asked the app to shed memory: a trim level of
    /// [`TRIM_MEMORY_RUNNING_LOW`] or worse, or a low-memory signal.
    pub fn under_pressure(&self) -> bool {
        self.low_memory || self.trim_level.is_some_and(|level| level >= TRIM_MEMORY_RUNNING_LOW)
    }

    /// The memory class in bytes, when Android gave a non-zero one.
    pub fn memory_class_bytes(&self) -> Option<u64> {
        self.memory_class_mib.filter(|mib| *mib > 0).map(|mib| u64::from(mib) * MIB)
    }

    /// These facts with Android's JNI-read ones (the shell's merge; None keeps what is there).
    pub fn with_android(mut self, memory_class_mib: Option<u32>, trim_level: Option<i32>, low_memory: Option<bool>) -> MemoryFacts {
        self.memory_class_mib = memory_class_mib.or(self.memory_class_mib);
        self.trim_level = trim_level.or(self.trim_level);
        self.low_memory = low_memory.unwrap_or(self.low_memory);
        self
    }
}

/// The memory facts this process can read natively: physical memory on every native destination
/// and iOS's available memory. Android's memory class and trim level need the JNI bridge (the
/// shell adds them with [`MemoryFacts::with_android`]); the web has none (its pool reads the
/// shell's `deviceMemory` hint).
pub fn memory_facts() -> MemoryFacts {
    MemoryFacts { physical_bytes: physical_memory(), available_bytes: ios_available_memory(), ..MemoryFacts::default() }
}

/// The machine's physical memory: `hw.memsize` on Apple.
#[cfg(all(not(target_arch = "wasm32"), target_vendor = "apple"))]
fn physical_memory() -> Option<u64> {
    apple::sysctl_u64(c"hw.memsize")
}

/// The machine's physical memory: `/proc/meminfo`'s `MemTotal` on Linux and Android.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn physical_memory() -> Option<u64> {
    proc_kib_field("/proc/meminfo", "MemTotal:")
}

/// The machine's physical memory: `GlobalMemoryStatusEx`'s `ullTotalPhys` on Windows.
#[cfg(target_os = "windows")]
fn physical_memory() -> Option<u64> {
    windows::memory_status().map(|status| status.total_phys).filter(|bytes| *bytes > 0)
}

/// No physical memory fact here (the web, and any other target).
#[cfg(not(any(all(not(target_arch = "wasm32"), target_vendor = "apple"), target_os = "linux", target_os = "android", target_os = "windows")))]
fn physical_memory() -> Option<u64> {
    None
}

/// iOS's `os_proc_available_memory`: the bytes the process may still allocate before jetsam.
#[cfg(target_os = "ios")]
fn ios_available_memory() -> Option<u64> {
    // SAFETY: `os_proc_available_memory` (libSystem, iOS 13+; this build's floor is 16) takes no
    // arguments, reads the calling process's own limit and has no other effect.
    let bytes = unsafe { apple::os_proc_available_memory() };
    u64::try_from(bytes).ok().filter(|bytes| *bytes > 0)
}

/// Only iOS reports a jetsam headroom.
#[cfg(not(target_os = "ios"))]
fn ios_available_memory() -> Option<u64> {
    None
}

/// A `kB` field of a `/proc` file (`MemTotal:`, `VmRSS:`), in bytes.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn proc_kib_field(path: &str, field: &str) -> Option<u64> {
    let text = std::fs::read_to_string(path).ok()?;
    parse_kib_field(&text, field)
}

/// The value of `field` in a `/proc` text whose lines read `Field:   1234 kB`, in bytes.
#[cfg_attr(not(any(target_os = "linux", target_os = "android", test)), allow(dead_code, reason = "only Linux and Android read /proc"))]
fn parse_kib_field(text: &str, field: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with(field))?;
    let mut words = line[field.len()..].split_whitespace();
    let kib: u64 = words.next()?.parse().ok()?;
    if words.next() != Some("kB") {
        return None;
    }
    kib.checked_mul(1024)
}

/// Apple's memory queries (libSystem).
#[cfg(all(not(target_arch = "wasm32"), target_vendor = "apple"))]
mod apple {
    use std::ffi::{CStr, c_char, c_int, c_void};

    unsafe extern "C" {
        /// `sysctlbyname(3)`.
        fn sysctlbyname(name: *const c_char, oldp: *mut c_void, oldlenp: *mut usize, newp: *mut c_void, newlen: usize) -> c_int;
        /// `os_proc_available_memory` (`<os/proc.h>`, iOS 13+).
        #[cfg(target_os = "ios")]
        pub(crate) fn os_proc_available_memory() -> usize;
    }

    /// A sysctl of exactly `size_of::<T>()` bytes.
    fn sysctl<T: Copy + Default>(name: &CStr) -> Option<T> {
        let mut value = T::default();
        let mut len = size_of::<T>();
        // SAFETY: `name` is NUL-terminated; `value` is a live, writable `T` of `len` bytes and the
        // kernel writes at most `len` bytes into it; no new value is set.
        let status = unsafe { sysctlbyname(name.as_ptr(), (&raw mut value).cast(), &raw mut len, std::ptr::null_mut(), 0) };
        (status == 0 && len == size_of::<T>()).then_some(value)
    }

    /// A 64-bit unsigned sysctl (`hw.memsize`).
    pub(crate) fn sysctl_u64(name: &CStr) -> Option<u64> {
        sysctl::<u64>(name).filter(|value| *value > 0)
    }

    /// A 32-bit signed sysctl (`kern.memorystatus_level`).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code, reason = "only macOS reads the memory status level (process.rs)"))]
    pub(crate) fn sysctl_i32(name: &CStr) -> Option<i32> {
        sysctl::<i32>(name)
    }
}

/// Windows' memory queries (kernel32).
#[cfg(target_os = "windows")]
mod windows {
    use std::ffi::c_void;

    /// `MEMORYSTATUSEX`.
    #[repr(C)]
    #[derive(Default)]
    pub(crate) struct MemoryStatus {
        length: u32,
        memory_load: u32,
        pub(crate) total_phys: u64,
        pub(crate) avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }

    /// `PROCESS_MEMORY_COUNTERS`.
    #[repr(C)]
    #[derive(Default)]
    pub(crate) struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        pub(crate) working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatus) -> i32;
        fn GetCurrentProcess() -> *mut c_void;
        fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
    }

    /// `GlobalMemoryStatusEx`.
    pub(crate) fn memory_status() -> Option<MemoryStatus> {
        let mut status = MemoryStatus { length: size_of::<MemoryStatus>() as u32, ..MemoryStatus::default() };
        // SAFETY: `status` is a live MEMORYSTATUSEX whose `dwLength` names its size, as the call
        // requires; it only fills the structure.
        let ok = unsafe { GlobalMemoryStatusEx(&raw mut status) };
        (ok != 0).then_some(status)
    }

    /// `K32GetProcessMemoryInfo` of this process.
    pub(crate) fn process_counters() -> Option<ProcessMemoryCounters> {
        let mut counters = ProcessMemoryCounters { cb: size_of::<ProcessMemoryCounters>() as u32, ..ProcessMemoryCounters::default() };
        // SAFETY: `GetCurrentProcess` returns this process's pseudo handle, which needs no closing;
        // `counters` is a live PROCESS_MEMORY_COUNTERS of `cb` bytes that the call only fills.
        let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &raw mut counters, counters.cb) };
        (ok != 0).then_some(counters)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trim_level_of_running_low_or_worse_is_pressure() {
        let trimmed = |level| MemoryFacts { trim_level: Some(level), ..MemoryFacts::default() };
        assert!(!MemoryFacts::default().under_pressure(), "no fact, no pressure");
        assert!(!trimmed(TRIM_MEMORY_RUNNING_MODERATE).under_pressure());
        assert!(trimmed(TRIM_MEMORY_RUNNING_LOW).under_pressure());
        assert!(trimmed(TRIM_MEMORY_RUNNING_CRITICAL).under_pressure());
        assert!(trimmed(80).under_pressure(), "TRIM_MEMORY_COMPLETE");
        assert!(MemoryFacts { low_memory: true, ..MemoryFacts::default() }.under_pressure());
    }

    #[test]
    fn the_android_merge_keeps_what_jni_did_not_answer() {
        let native = MemoryFacts { physical_bytes: Some(8 << 30), ..MemoryFacts::default() };
        let merged = native.with_android(Some(256), None, Some(true));
        assert_eq!(merged, MemoryFacts { physical_bytes: Some(8 << 30), memory_class_mib: Some(256), trim_level: None, available_bytes: None, low_memory: true });
        assert_eq!(merged.with_android(None, Some(TRIM_MEMORY_RUNNING_LOW), None).memory_class_mib, Some(256));
        assert_eq!(MemoryFacts { memory_class_mib: Some(0), ..MemoryFacts::default() }.memory_class_bytes(), None, "zero is not a class");
    }

    #[test]
    fn proc_fields_parse_in_kib_and_refuse_other_units() {
        let text = "MemTotal:       16318412 kB\nMemFree:  1 kB\nVmRSS:\t  2048 kB\nOdd: 12 MB\nBad: x kB\n";
        assert_eq!(parse_kib_field(text, "MemTotal:"), Some(16_318_412 * 1024));
        assert_eq!(parse_kib_field(text, "VmRSS:"), Some(2048 * 1024));
        assert_eq!(parse_kib_field(text, "Odd:"), None);
        assert_eq!(parse_kib_field(text, "Bad:"), None);
        assert_eq!(parse_kib_field(text, "Missing:"), None);
        assert_eq!(parse_kib_field("Huge: 18446744073709551615 kB", "Huge:"), None, "an overflow is not a fact");
    }

    #[test]
    fn this_host_reports_its_physical_memory() {
        let facts = memory_facts();
        if cfg!(any(target_os = "macos", target_os = "linux", target_os = "windows")) {
            let bytes = facts.physical_bytes.expect("a desktop host reports its physical memory");
            assert!(bytes >= 1 << 30, "at least 1 GiB, got {bytes}");
        }
        assert_eq!(facts.available_bytes, None, "only iOS reports a jetsam headroom");
        assert!(!facts.under_pressure(), "no trim level off Android");
    }
}
