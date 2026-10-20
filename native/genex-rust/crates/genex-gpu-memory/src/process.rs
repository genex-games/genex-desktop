//! Process memory per destination (game systems PROF-3): how many bytes this process holds in
//! physical memory and how many the OS says it can still get, for the profile's memory rows.
//! - Apple: the resident size from `task_info(MACH_TASK_BASIC_INFO)`; iOS's available memory is
//!   `os_proc_available_memory` (the jetsam headroom), macOS's the free share the kernel reports
//!   (`kern.memorystatus_level`) of physical memory.
//! - Linux and Android: `VmRSS` of `/proc/self/status` (in kB, so no page size is needed: Android
//!   builds use 16 KB pages) and `MemAvailable` of `/proc/meminfo`.
//! - Windows: the working set (`K32GetProcessMemoryInfo`) and `ullAvailPhys`
//!   (`GlobalMemoryStatusEx`).
//! - The web: None for both; the facade reports the wasm heap instead.

/// This process's memory, each part None when the destination does not say.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProcessMemory {
    /// The bytes of this process in physical memory (resident size, working set).
    pub resident: Option<u64>,
    /// The bytes the OS says the process can still get (iOS: before jetsam ends it; elsewhere the
    /// machine's available physical memory).
    pub available: Option<u64>,
}

/// This process's memory now. Cheap enough for a profile sample (one syscall or two small
/// `/proc` reads), not for every frame.
pub fn process_memory() -> ProcessMemory {
    ProcessMemory { resident: resident(), available: available() }
}

/// The resident size from `task_info`.
#[cfg(all(not(target_arch = "wasm32"), target_vendor = "apple"))]
fn resident() -> Option<u64> {
    mach::resident_size()
}

/// `VmRSS` of `/proc/self/status`.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn resident() -> Option<u64> {
    crate::proc_kib_field("/proc/self/status", "VmRSS:")
}

/// The working set.
#[cfg(target_os = "windows")]
fn resident() -> Option<u64> {
    crate::windows::process_counters().and_then(|counters| u64::try_from(counters.working_set_size).ok())
}

/// No resident size here (the web, and any other target).
#[cfg(not(any(all(not(target_arch = "wasm32"), target_vendor = "apple"), target_os = "linux", target_os = "android", target_os = "windows")))]
fn resident() -> Option<u64> {
    None
}

/// iOS's jetsam headroom.
#[cfg(target_os = "ios")]
fn available() -> Option<u64> {
    crate::ios_available_memory()
}

/// The free share of physical memory macOS's memory status reports.
#[cfg(target_os = "macos")]
fn available() -> Option<u64> {
    let percent = u64::try_from(crate::apple::sysctl_i32(c"kern.memorystatus_level")?).ok().filter(|percent| *percent <= 100)?;
    let physical = crate::apple::sysctl_u64(c"hw.memsize")?;
    Some(physical / 100 * percent).filter(|bytes| *bytes > 0)
}

/// `MemAvailable` of `/proc/meminfo`.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn available() -> Option<u64> {
    crate::proc_kib_field("/proc/meminfo", "MemAvailable:")
}

/// `ullAvailPhys`.
#[cfg(target_os = "windows")]
fn available() -> Option<u64> {
    crate::windows::memory_status().map(|status| status.avail_phys).filter(|bytes| *bytes > 0)
}

/// Nothing available to read here (the web, and any other target).
#[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android", target_os = "windows")))]
fn available() -> Option<u64> {
    None
}

/// Mach's task information (libSystem).
#[cfg(all(not(target_arch = "wasm32"), target_vendor = "apple"))]
mod mach {
    /// `MACH_TASK_BASIC_INFO`, the flavor whose sizes are 64-bit on every Apple target.
    const MACH_TASK_BASIC_INFO: u32 = 20;
    /// `KERN_SUCCESS`.
    const KERN_SUCCESS: i32 = 0;

    /// `mach_task_basic_info` (`#pragma pack(4)` in `<mach/task_info.h>`).
    #[repr(C, packed(4))]
    #[derive(Clone, Copy, Default)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: [i32; 2],
        system_time: [i32; 2],
        policy: i32,
        suspend_count: i32,
    }

    /// `MACH_TASK_BASIC_INFO_COUNT`: the structure's size in `natural_t` words.
    const MACH_TASK_BASIC_INFO_COUNT: u32 = (size_of::<MachTaskBasicInfo>() / size_of::<u32>()) as u32;

    unsafe extern "C" {
        /// The task port `mach_task_self()` reads.
        static mach_task_self_: u32;
        /// `task_info(2)`.
        fn task_info(target_task: u32, flavor: u32, task_info_out: *mut i32, task_info_out_cnt: *mut u32) -> i32;
    }

    /// This task's resident size.
    pub(super) fn resident_size() -> Option<u64> {
        let mut info = MachTaskBasicInfo::default();
        let mut count = MACH_TASK_BASIC_INFO_COUNT;
        // SAFETY: `mach_task_self_` is the process's own task port, set by libSystem before main;
        // `info` is a live, writable `mach_task_basic_info` of `count` words, and the kernel writes
        // at most `count` words and updates `count`.
        let status = unsafe { task_info(mach_task_self_, MACH_TASK_BASIC_INFO, (&raw mut info).cast(), &raw mut count) };
        let resident = info.resident_size;
        (status == KERN_SUCCESS && count == MACH_TASK_BASIC_INFO_COUNT && resident > 0).then_some(resident)
    }
}
