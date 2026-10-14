//! Why an asset did not load: a typed code with its wire spelling, and a detail for the log.

use std::fmt;

/// Why an asset did not load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AssetErrorCode {
    /// The name breaks the asset-path rule: absolute, climbing, a backslash, a device name.
    UnsafePath,
    /// The name is a link, or resolves outside the asset folder once its links are followed.
    EscapesAssets,
    /// Nothing is there.
    Missing,
    /// A folder, a FIFO, a socket or a device.
    NotAFile,
    /// Larger than the runtime reads into memory.
    TooLarge,
    /// The bytes are not the format the name says, or are damaged.
    Malformed,
    /// A format the studio's import step converts first (OBJ, STL, PLY; Draco or meshopt glTF).
    NeedsImport,
    /// A format the runtime never loads.
    Unsupported,
}

impl AssetErrorCode {
    /// The typed code's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            AssetErrorCode::UnsafePath => "unsafe-path",
            AssetErrorCode::EscapesAssets => "escapes-assets",
            AssetErrorCode::Missing => "missing",
            AssetErrorCode::NotAFile => "not-a-file",
            AssetErrorCode::TooLarge => "too-large",
            AssetErrorCode::Malformed => "malformed",
            AssetErrorCode::NeedsImport => "needs-import",
            AssetErrorCode::Unsupported => "unsupported-format",
        }
    }
}

/// An asset that did not load.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetError {
    code: AssetErrorCode,
    detail: String,
}

impl AssetError {
    pub(crate) fn new(code: AssetErrorCode, detail: impl Into<String>) -> AssetError {
        AssetError { code, detail: detail.into() }
    }

    /// The typed code.
    pub fn code(&self) -> AssetErrorCode {
        self.code
    }
}

impl fmt::Display for AssetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for AssetError {}
