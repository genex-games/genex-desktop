//! glTF and image loaders with the safe-path rule and the magenta checker.
//!
//! - [`AssetRoot`]: every file a game loads is read through it, under the C++ runtime's
//!   asset-path rule (`genex_core::paths::is_safe_asset_path`), never through a link at its name
//!   and never outside the asset folder once links are followed;
//! - [`texture`]: images through `image` 0.25 (PNG, JPEG, WebP, HDR, EXR, GIF, BMP, QOI; DDS read
//!   here, compressed or not, since `image` 0.25 no longer routes it), the
//!   64 px magenta-and-black checker a missing texture shows, and the per-destination texture
//!   table (BC, ASTC, ETC2, RGBA8) the studio's import step keeps too;
//! - [`model`]: glTF 2.0 through `gltf` 1.4.1, from a GLB or a `.gltf` whose buffers resolve under
//!   the same rule. Draco and meshopt files are the import step's (`needs-import`): the studio
//!   writes them back plain before the game sees them.

mod dds;
mod error;
pub mod model;
mod root;
pub mod texture;

pub use error::{AssetError, AssetErrorCode};
pub use root::{AssetRoot, MAX_ASSET_BYTES};
