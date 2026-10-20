//! The crash record's vocabularies, each spelled on the wire exactly as the host's
//! `src/shared/crash-record.ts` spells it: what crashed, who wrote the record, the GPU error's
//! class, a WebAssembly trap, the build flavour and what a record over its caps gave up. The host
//! never reads a record's message to decide anything; it reads these.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};

/// A closed wire vocabulary: the enum, `ALL`, `wire()`, `from_wire()` and serde as the wire text.
macro_rules! wire_vocabulary {
    (
        $(#[$meta:meta])*
        $name:ident { $( $(#[$variant_meta:meta])* $variant:ident = $wire:literal, )+ }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $( $(#[$variant_meta])* $variant, )+
        }

        impl $name {
            /// Every value, in declaration order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The value's wire spelling.
            pub const fn wire(self) -> &'static str {
                match self {
                    $($name::$variant => $wire,)+
                }
            }

            /// The value spelled `text`, or None.
            pub fn from_wire(text: &str) -> Option<$name> {
                $name::ALL.iter().copied().find(|value| value.wire() == text)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.wire())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<$name, D::Error> {
                let text = String::deserialize(deserializer)?;
                $name::from_wire(&text).ok_or_else(|| de::Error::custom(concat!("not a ", stringify!($name))))
            }
        }
    };
}

wire_vocabulary! {
    /// What crashed. Wire values: never rename one.
    CrashKind {
        /// A Rust panic (fatal, or handled when it was caught).
        Panic = "panic",
        /// An uncaptured wgpu error on a live device.
        GpuValidation = "gpu-validation",
        /// The GPU device was lost (not fatal: recovery runs).
        DeviceLost = "device-lost",
        /// A WebAssembly trap with no Rust panic (made by the web shell).
        WasmTrap = "wasm-trap",
        /// SIGSEGV, SIGBUS or EXC_BAD_ACCESS (made by the platform's reader).
        NativeFault = "native-fault",
        /// A low-memory kill (made by the platform's reader).
        OutOfMemory = "out-of-memory",
        /// The host killed a run that stopped answering (made by the host).
        Hang = "hang",
        /// An abnormal exit with no record (made by the host: code and signal).
        ProcessExit = "process-exit",
    }
}

impl CrashKind {
    /// The kinds a game's own process writes; the host treats a game record of any other kind
    /// as a violation (`GAME_CRASH_KINDS`).
    pub const GAME_KINDS: &'static [CrashKind] = &[CrashKind::Panic, CrashKind::GpuValidation, CrashKind::DeviceLost];
}

wire_vocabulary! {
    /// Who wrote the record. Wire values: never rename one.
    CrashSource {
        /// The game's own panic hook.
        Game = "game",
        /// The web shell.
        Shell = "shell",
        /// A phone's platform reader.
        Platform = "platform",
        /// The host.
        Host = "host",
    }
}

wire_vocabulary! {
    /// The class of an uncaptured wgpu error. Wire values: never rename one.
    GpuErrorClass {
        /// A validation error.
        Validation = "validation",
        /// The device ran out of memory.
        OutOfMemory = "out-of-memory",
        /// An internal error.
        Internal = "internal",
    }
}

wire_vocabulary! {
    /// What a WebAssembly trap was. Wire values: never rename one.
    WasmTrap {
        /// `unreachable` (a Rust abort lands here too).
        Unreachable = "unreachable",
        /// An out-of-bounds memory access.
        Memory = "memory",
        /// A stack overflow.
        Stack = "stack",
        /// Anything else.
        Other = "other",
    }
}

wire_vocabulary! {
    /// The build a crash came from. Wire values: never rename one.
    CrashFlavour {
        /// A Studio (Live) build.
        Dev = "dev",
        /// An export.
        Export = "export",
    }
}

wire_vocabulary! {
    /// What a record over its caps gave up, in the order the caps give it up. Wire values: never
    /// rename one.
    CrashTrimmed {
        /// The profile summary.
        Profile = "profile",
        /// The replay track (the replay's `complete` turns false).
        ReplayTrack = "replay.track",
        /// Stack frames, from the bottom.
        Frames = "frames",
        /// The message (or the GPU error's description), cut at a character boundary.
        Message = "message",
        /// The source path, cut.
        LocationFile = "location.file",
    }
}
