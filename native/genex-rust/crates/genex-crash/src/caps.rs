//! The crash record's caps, equal to the host parser's (`src/shared/crash-record.ts`): a record
//! the game writes always parses on the host, and one over a cap gives up its least needed parts
//! first and says which in `trimmed`.

/// The most bytes a record takes as JSON.
pub const CRASH_RECORD_MAX_BYTES: usize = 64 * 1024;
/// The most bytes of the panic message, a GPU error's description or a trap's text (UTF-8).
pub const CRASH_MESSAGE_MAX_BYTES: usize = 2 * 1024;
/// The most stack frames a record keeps (the top ones), and the most frames of a trap's stack.
pub const CRASH_FRAMES_MAX: usize = 128;
/// The most bytes of the replay track before base64 (InputTrack rows).
pub const CRASH_REPLAY_MAX_BYTES: usize = 24 * 1024;
/// The most bytes of the profile summary a record carries (genex-profile's summary cap).
pub const CRASH_PROFILE_MAX_BYTES: usize = 4 * 1024;
/// The most UTF-16 units of a source path (the host counts JavaScript string length).
pub const CRASH_PATH_MAX_CHARS: usize = 512;
/// The most debug images a platform record names.
pub const CRASH_IMAGES_MAX: usize = 64;
/// The most hitch frames a record lists.
pub const CRASH_HITCHES_MAX: usize = 16;
/// The deepest JSON nesting a record may have.
pub const CRASH_JSON_DEPTH_MAX: usize = 12;
/// The most UTF-16 units of short identifying text: a thread name, a backend, a build id, a version.
pub const SHORT_TEXT_MAX_CHARS: usize = 128;
/// The most UTF-16 units of an adapter name, a lost device's reason or a debug image's name.
pub const NAME_TEXT_MAX_CHARS: usize = 256;
/// The most characters of a debug image id (hex digits and dashes).
pub const IMAGE_ID_MAX_CHARS: usize = 64;
/// How many records the file sink keeps in the save root's crash folder; the oldest go first.
pub const CRASH_FILES_KEPT: usize = 16;
