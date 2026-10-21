//! What the shell leaves on the device for the person to pull: the game's self-test record, the
//! typed `gpu-unsupported` record when the adapter is below WebGPU core, and an NDJSON lifecycle
//! log, all under `<root>/genex-self-test/`. The root is the platform's own: the app's Documents
//! on iOS (`UIFileSharingEnabled` shows it in Finder, `xcrun devicectl device copy from` pulls
//! it), its `internal_data_path` on Android (the debuggable APK's `run-as` reads it). The person
//! copies the records into `.studio-dev/evidence/`; the shell never sends them anywhere.

use genex::{Value, json};
use genex_render::RenderError;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// The folder under the records root.
pub const RECORDS_DIR: &str = "genex-self-test";
/// The typed refusal record's `format` field.
pub const GPU_UNSUPPORTED_FORMAT: &str = "genex-gpu-unsupported/1";
/// The typed refusal record's file name.
pub const GPU_UNSUPPORTED_FILE: &str = "gpu-unsupported.json";
/// The lifecycle log's file name.
pub const LIFECYCLE_FILE: &str = "lifecycle.ndjson";
/// A crash record's file name: `crash-<n>.json`, `n` rising (game systems CRASH-4).
pub const CRASH_FILE_PREFIX: &str = "crash-";
/// A crash record's file suffix.
pub const CRASH_FILE_SUFFIX: &str = ".json";
/// The crash records' `format` line (genex-crash's record, the host's `parseCrashRecord`).
pub use genex_crash::CRASH_FORMAT;

/// Where the shell writes its records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Records {
    dir: PathBuf,
    platform: &'static str,
}

impl Records {
    /// Records under `<root>/genex-self-test/`, named for `platform` (`ios`, `android`: the suffix
    /// in `pond-600-seed1-cast.ios.json` and the refusal record's `platform`).
    pub fn new(root: &Path, platform: &'static str) -> Records {
        Records { dir: root.join(RECORDS_DIR), platform }
    }

    /// The platform the records are named for.
    pub fn platform(&self) -> &'static str {
        self.platform
    }

    /// The records folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The self-test record's path for a game, tick count, seed and demo.
    pub fn self_test_path(&self, game: &str, ticks: u32, seed: u32, demo: &str) -> PathBuf {
        self.dir.join(format!("{game}-{ticks}-seed{seed}-{demo}.{}.json", self.platform))
    }

    /// Write `text` to `path` through a temporary file, so a pulled record is never half written.
    fn write_atomic(&self, path: &Path, text: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let partial = path.with_extension("partial");
        std::fs::write(&partial, text)?;
        std::fs::rename(&partial, path)
    }

    /// Write a finished self-test record; answers its path.
    pub fn write_self_test(&self, game: &str, ticks: u32, seed: u32, demo: &str, record: &str) -> std::io::Result<PathBuf> {
        let path = self.self_test_path(game, ticks, seed, demo);
        self.write_atomic(&path, record)?;
        Ok(path)
    }

    /// Write the typed `gpu-unsupported` record for a refused adapter; answers its path.
    pub fn write_gpu_unsupported(&self, game: &str, error: &RenderError) -> std::io::Result<PathBuf> {
        let path = self.dir.join(GPU_UNSUPPORTED_FILE);
        let mut text = serde_json::to_string_pretty(&gpu_unsupported_record(game, self.platform, error)).unwrap_or_default();
        text.push('\n');
        self.write_atomic(&path, &text)?;
        Ok(path)
    }

    /// Append one lifecycle event to the log (best effort: a full disk never stops the game).
    pub fn log_lifecycle(&self, event: &Value) {
        let appended = std::fs::create_dir_all(&self.dir).and_then(|()| {
            let mut file = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join(LIFECYCLE_FILE))?;
            writeln!(file, "{event}")
        });
        if let Err(error) = appended {
            log::warn!("lifecycle log not written: {error}");
        }
    }
}

/// The typed refusal the shell records instead of crashing when the GPU is below WebGPU core.
pub fn gpu_unsupported_record(game: &str, platform: &str, error: &RenderError) -> Value {
    let reason = match error {
        RenderError::GpuUnsupported { reason, .. } => format!("{reason:?}"),
        RenderError::Refused { .. } => String::new(),
    };
    json!({
        "format": GPU_UNSUPPORTED_FORMAT,
        "code": error.code().wire(),
        "game": game,
        "platform": platform,
        "reason": reason,
        "detail": error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_render::UnsupportedReason;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genex-mobile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_gpu_unsupported_record_is_typed_and_written_whole() {
        let root = scratch("gpu");
        let records = Records::new(&root, "ios");
        let error = RenderError::GpuUnsupported { reason: UnsupportedReason::NotWebGpuCompliant, detail: "Apple2 (Metal)".into() };
        let path = records.write_gpu_unsupported("pond", &error).expect("written");
        assert_eq!(path, root.join("genex-self-test/gpu-unsupported.json"));
        let record: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(record["code"], json!("gpu-unsupported"));
        assert_eq!(record["format"], json!(GPU_UNSUPPORTED_FORMAT));
        assert_eq!(record["reason"], json!("NotWebGpuCompliant"));
        assert_eq!(record["platform"], json!("ios"));
        assert!(!path.with_extension("partial").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_adapter_below_core_becomes_the_typed_record_not_a_panic() {
        // The Simulator's Metal adapter advertises only the Apple2 family: not WebGPU-compliant.
        let facts = genex_render::floor::AdapterFacts {
            name: "Apple iOS simulator GPU".into(),
            backend: wgpu::Backend::Metal,
            limits: wgpu::Limits::defaults(),
            downlevel: wgpu::DownlevelCapabilities { flags: wgpu::DownlevelFlags::empty(), ..Default::default() },
            features: wgpu::Features::empty(),
        };
        let error = genex_render::floor::check_floor(&facts).expect_err("below core");
        let record = gpu_unsupported_record("pond", "ios", &error);
        assert_eq!(record["code"], json!("gpu-unsupported"));
        assert_eq!(record["reason"], json!("NotWebGpuCompliant"));
        assert_eq!(record["detail"], json!(error.to_string()));
    }

    #[test]
    fn an_android_vulkan_adapter_below_core_is_recorded_for_android() {
        // An emulator or old device whose Vulkan driver is not WebGPU-compliant.
        let facts = genex_render::floor::AdapterFacts {
            name: "emulator Vulkan".into(),
            backend: wgpu::Backend::Vulkan,
            limits: wgpu::Limits::defaults(),
            downlevel: wgpu::DownlevelCapabilities { flags: wgpu::DownlevelFlags::empty(), ..Default::default() },
            features: wgpu::Features::empty(),
        };
        let error = genex_render::floor::check_floor(&facts).expect_err("below core");
        let root = scratch("android-gpu");
        let path = Records::new(&root, "android").write_gpu_unsupported("pond", &error).expect("written");
        let record: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(record["platform"], json!("android"));
        assert_eq!(record["code"], json!("gpu-unsupported"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_lifecycle_log_appends_one_line_per_event() {
        let root = scratch("life");
        let records = Records::new(&root, "android");
        records.log_lifecycle(&json!({ "event": "resumed" }));
        records.log_lifecycle(&json!({ "event": "suspended" }));
        let text = std::fs::read_to_string(root.join("genex-self-test/lifecycle.ndjson")).expect("log");
        assert_eq!(text, "{\"event\":\"resumed\"}\n{\"event\":\"suspended\"}\n");
        let _ = std::fs::remove_dir_all(root);
    }
}
