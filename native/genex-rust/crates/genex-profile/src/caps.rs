//! The profiler's caps: how many frames, bytes, names and rows it keeps, by device class. Every
//! cap is a constant here, so a phone and a browser tab hold the same shape as a desktop, only
//! less of it, and nothing the profiler keeps grows with the length of a run.

/// The most distinct game scope names one run records; a later name is dropped and counted.
pub const PROFILE_GAME_SCOPES_MAX: usize = 256;
/// The most distinct counters one run reports; a later name is dropped and counted.
pub const PROFILE_COUNTERS_MAX: usize = 64;
/// The most rows of the summary's top scopes.
pub const PROFILE_TOP_SCOPES: usize = 8;
/// The most bytes the summary takes as JSON (`state().volatile.profile`).
pub const PROFILE_SUMMARY_MAX_BYTES: usize = 4 * 1024;
/// The frames the summary's percentiles cover: genex-render's `TIMING_WINDOW_FRAMES`, restated
/// because this crate sits below the renderer.
pub const SUMMARY_WINDOW_FRAMES: usize = 120;
/// Puffin's own byte count of the kept frames, desktop: past it the oldest recent frames go first.
pub const PROFILE_MEMORY_MAX_BYTES: usize = 8 * 1024 * 1024;
/// The same byte cap in a browser tab and on a phone.
pub const PROFILE_MEMORY_MAX_BYTES_SMALL: usize = 2 * 1024 * 1024;
/// The most thread reports one lane queues between two frames; a report past it, or one that
/// finds its queue busy, is dropped and counted (`dropped.frames`), never waited for.
pub const REPORT_QUEUE_MAX: usize = 1024;
/// The most scope ids the name table holds. Puffin numbers every scope site in the process
/// (wgpu's and egui's too), so a genex site numbered past this is not recorded and is counted.
pub const SCOPE_IDS_MAX: usize = 4096;

/// Which cap set a run takes. Wire values: never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CapsClass {
    /// Mac, Windows and Linux.
    Desktop,
    /// A browser tab (wasm32).
    Web,
    /// iOS and Android.
    Phone,
}

impl CapsClass {
    /// Every class, in declaration order.
    pub const ALL: &'static [CapsClass] = &[CapsClass::Desktop, CapsClass::Web, CapsClass::Phone];

    /// The class's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            CapsClass::Desktop => "desktop",
            CapsClass::Web => "web",
            CapsClass::Phone => "phone",
        }
    }

    /// The class spelled `text`, or None.
    pub fn from_wire(text: &str) -> Option<CapsClass> {
        CapsClass::ALL.iter().copied().find(|class| class.wire() == text)
    }
}

/// What one run keeps: recent and slowest frames, puffin's bytes for them, and kept hitches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfileCaps {
    /// The newest frames kept whole.
    pub recent_frames: usize,
    /// The slowest frames kept whole besides them (puffin's slow set: the capture on a hitch).
    pub slow_frames: usize,
    /// Puffin's byte count of every kept frame together.
    pub memory_max_bytes: usize,
    /// The most hitch records kept (the newest).
    pub hitch_records: usize,
}

impl ProfileCaps {
    /// The caps of `class`: desktop 600 recent, 64 slow, 8 MiB, 16 hitches; web and phone 240,
    /// 16, 2 MiB, and 16 or 8 hitches.
    pub const fn for_class(class: CapsClass) -> ProfileCaps {
        match class {
            CapsClass::Desktop => ProfileCaps {
                recent_frames: 600,
                slow_frames: 64,
                memory_max_bytes: PROFILE_MEMORY_MAX_BYTES,
                hitch_records: 16,
            },
            CapsClass::Web => ProfileCaps {
                recent_frames: 240,
                slow_frames: 16,
                memory_max_bytes: PROFILE_MEMORY_MAX_BYTES_SMALL,
                hitch_records: 16,
            },
            CapsClass::Phone => ProfileCaps {
                recent_frames: 240,
                slow_frames: 16,
                memory_max_bytes: PROFILE_MEMORY_MAX_BYTES_SMALL,
                hitch_records: 8,
            },
        }
    }

    /// The most frames kept at once: recent plus slow.
    pub const fn frames_max(self) -> usize {
        self.recent_frames + self.slow_frames
    }
}
