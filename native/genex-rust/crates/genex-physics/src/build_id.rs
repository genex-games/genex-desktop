//! The build's identity (CONTRACT.md §2):
//! `genex-physics/<core semver>+contract-<major.minor>+<backend>-<backend version>+<features>+<target>`.

use crate::backend::{ActiveBackend, Backend};
use crate::world_desc::CONTRACT_VERSION;

/// The core's semver (§2): the version `@genex-ai/physics` and `@genex-ai/physics-native` are released
/// at (`js/package.json`, `js/native-package.json`; a test holds both to it). It is the core's own,
/// not the genex workspace's: the crate ships in the genex Rust release at the workspace version,
/// which moves with the engine. Any change that moves a pinned result bumps it (`vectors/README.md`).
pub const CORE_VERSION: &str = "1.0.0";

/// The `+<target>` suffix: `wasm32` for WebAssembly, else `<arch>-<os>` (e.g. `aarch64-macos`).
pub fn target_name() -> String {
    if cfg!(target_arch = "wasm32") {
        return "wasm32".to_string();
    }
    format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
}

/// The buildId without its `+<target>` suffix: what determinism is promised between (§2, §10.2).
pub fn build_id_without_target() -> String {
    format!(
        "genex-physics/{CORE_VERSION}+contract-{CONTRACT_VERSION}+{}-{}+{}",
        ActiveBackend::NAME,
        ActiveBackend::VERSION,
        ActiveBackend::FEATURES
    )
}

/// The full buildId (§2), e.g. `genex-physics/1.0.0+contract-1.0+rapier-0.36.0+det+aarch64-macos`.
pub fn build_id() -> String {
    format!("{}+{}", build_id_without_target(), target_name())
}
