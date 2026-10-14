//! Where a game keeps its saves on each destination, which asset paths it may open, and which
//! files it reported loading, ported from the C++ template's `paths.h`. The environment is
//! injected, so every rule here is a pure computation: nothing is created or read. A Genex run
//! saves in the run's own `state/` (`GENEX_STATE_DIR`), an exported Mac app in
//! ~/Library/Application Support/<bundle id>/, Windows in %APPDATA%\<name>\, Linux in
//! $XDG_DATA_HOME/<name>/ (or ~/.local/share/<name>/), the browser in its save mount, iOS in the
//! app container's Library/Application Support/ and Android in the activity's internal data path.

/// Where the game is running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Destination {
    /// Run by the studio, which passed its descriptor.
    GenexRun,
    /// A browser.
    Web,
    /// An exported macOS app.
    Mac,
    /// An exported Windows app.
    Windows,
    /// An exported Linux app.
    Linux,
    /// An iOS app: its container is its own, so the root needs no name.
    Ios,
    /// An Android app: the activity's internal data path, which is its own.
    Android,
}

/// Why there is no save root.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SaveRefusal {
    /// A Genex run without a trustworthy `GENEX_STATE_DIR`.
    #[error("no usable GENEX_STATE_DIR")]
    NoStateDir,
    /// No trustworthy home folder.
    #[error("no usable home folder")]
    NoHome,
    /// No trustworthy %APPDATA%.
    #[error("no usable APPDATA")]
    NoAppData,
    /// A save name some destination would read differently.
    #[error("the save name is not safe on every destination")]
    BadName,
    /// Not a reverse-DNS bundle id.
    #[error("the bundle id is not reverse-DNS")]
    BadBundleId,
    /// An Android app without a trustworthy internal data path.
    #[error("no usable internal data path")]
    NoDataDir,
}

/// The name the game saves under (Windows, Linux) and its bundle id (Mac).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GameIdentity<'a> {
    /// The save folder's name.
    pub name: &'a str,
    /// The app's reverse-DNS bundle id.
    pub bundle_id: &'a str,
}

/// The variable a Genex run names its `state/` folder in.
pub const STATE_DIR_ENV: &str = "GENEX_STATE_DIR";
/// Set only when the studio runs the game; it names the protocol's file descriptor.
pub const STUDIO_FD_ENV: &str = "GENEX_STUDIO_FD";
/// The X server a Linux session names (Xorg, or XWayland beside a Wayland compositor).
pub const X11_DISPLAY_ENV: &str = "DISPLAY";
/// The folder of a Genex run's state that captures go in.
pub const CAPTURES_DIR: &str = "captures";
/// A capture file's extension: raw BGRA, top row first, width * height * 4 bytes.
pub const CAPTURE_EXTENSION: &str = ".bgra";
/// The key the Android shell answers its activity's internal data path under, in the environment
/// it hands [`save_root`] (`ndk`'s `internal_data_path`; never a process variable).
pub const ANDROID_DATA_KEY: &str = "genex.android.internalDataPath";
/// Where the web shell mounts its saves.
pub const WEB_SAVE_ROOT: &str = "/save/";
/// The longest save name accepted.
pub const MAX_NAME_LENGTH: usize = 64;
/// The longest bundle id accepted.
pub const MAX_BUNDLE_ID_LENGTH: usize = 155;

/// Windows device names a file or folder may not take, whatever its extension.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
    "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// How raylib named a file it read or wrote: `FILEIO: [path] …`.
const FILEIO_PREFIX: &str = "FILEIO: [";

/// Letters, digits, space, `_`, `-` and `.`: what a save name or an asset path segment may hold.
fn is_name_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b' ' | b'_' | b'-' | b'.')
}

fn is_label_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-'
}

/// Whether any `separator`-delimited segment of `path` is `..`.
fn climbs(path: &str, separator: char) -> bool {
    path.split(separator).any(|segment| segment == "..")
}

fn has_nul(text: &str) -> bool {
    text.contains('\0')
}

/// An absolute POSIX path that does not climb and has no backslash or NUL.
fn is_posix_root(path: &str) -> bool {
    path.starts_with('/') && !climbs(path, '/') && !has_nul(path) && !path.contains('\\')
}

/// `C:\…` or `\\server\share…`, never a device path (`\\?\`, `\\.\`), without `..` or NUL.
fn is_windows_root(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
    let share = bytes.len() >= 3 && bytes.starts_with(b"\\\\") && !matches!(bytes[2], b'?' | b'.');
    (drive || share) && !climbs(path, '\\') && !climbs(path, '/') && !has_nul(path)
}

/// Whether `path` is absolute in this platform's own form.
fn is_native_root(path: &str) -> bool {
    if cfg!(windows) { is_windows_root(path) } else { is_posix_root(path) }
}

/// This platform's own separator.
const NATIVE_SEPARATOR: char = if cfg!(windows) { '\\' } else { '/' };

/// An absolute path in a common separator form, with `.` and `..` resolved without reading the
/// filesystem; "" when `value` is not absolute or climbs out of its root.
fn absolute_claim_path(value: &str) -> String {
    if value.is_empty() || has_nul(value) {
        return String::new();
    }
    let windows = is_windows_root(value);
    let path = if windows { value.replace('\\', "/") } else { value.to_owned() };
    if !windows && (!path.starts_with('/') || path.contains('\\')) {
        return String::new();
    }
    let first = match (windows, path.starts_with('/')) {
        (false, _) => 1,
        (true, true) => 2,
        (true, false) => 3,
    };
    let mut root = path[..first].to_owned();
    let mut parts: Vec<&str> = Vec::new();
    for part in path[first..].split('/') {
        match part {
            ".." => {
                if parts.pop().is_none() {
                    return String::new();
                }
            }
            "" | "." => {}
            part => parts.push(part),
        }
    }
    for part in parts {
        if !root.ends_with('/') {
            root.push('/');
        }
        root.push_str(part);
    }
    root
}

/// `base` with its trailing separators removed and `parts` appended, each followed by `separator`.
fn join(base: &str, parts: &[&str], separator: char) -> String {
    let mut base = base;
    while base.len() > 1 && (base.ends_with('/') || base.ends_with('\\')) {
        base = &base[..base.len() - 1];
    }
    let mut out = base.to_owned();
    out.push(separator);
    for part in parts {
        out.push_str(part);
        out.push(separator);
    }
    out
}

fn is_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("");
    // Win32 matches a device name with trailing spaces too (`con .png`).
    let stem = stem.trim_end_matches(' ').to_ascii_uppercase();
    RESERVED_NAMES.contains(&stem.as_str())
}

/// A folder name every destination accepts.
fn is_safe_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_LENGTH {
        return false;
    }
    let allowed = name.bytes().all(is_name_char);
    let edges = !name.starts_with(['.', ' ']) && !name.ends_with(['.', ' ']);
    allowed && edges && !is_reserved_name(name)
}

/// Reverse-DNS: two or more non-empty labels of letters, digits and `-`.
fn is_bundle_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_BUNDLE_ID_LENGTH || !id.contains('.') {
        return false;
    }
    id.split('.').all(|label| !label.is_empty() && label.bytes().all(is_label_char))
}

fn lookup(env: &dyn Fn(&str) -> Option<String>, name: &str) -> String {
    env(name).unwrap_or_default()
}

/// One asset or save path segment that every destination reads the same way.
fn is_safe_segment(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }
    let plain = segment.bytes().all(is_name_char);
    let stripped = segment.ends_with(['.', ' ']);
    plain && !stripped && !is_reserved_name(segment)
}

fn linux_root(env: &dyn Fn(&str) -> Option<String>, name: &str) -> Result<String, SaveRefusal> {
    let xdg = lookup(env, "XDG_DATA_HOME");
    if is_posix_root(&xdg) {
        return Ok(join(&xdg, &[name], '/'));
    }
    let home = lookup(env, "HOME");
    if is_posix_root(&home) {
        return Ok(join(&home, &[".local", "share", name], '/'));
    }
    Err(SaveRefusal::NoHome)
}

/// The save root of `game` on `where_`, ending in its separator. A variable that is empty,
/// relative, climbs with `..` or carries a NUL is not trusted: `XDG_DATA_HOME` then falls back to
/// `HOME`, everything else refuses. `GENEX_STATE_DIR` must be absolute in this platform's own form
/// (`C:\…` is relative on a Mac).
pub fn save_root(
    where_: Destination,
    env: &dyn Fn(&str) -> Option<String>,
    game: GameIdentity<'_>,
) -> Result<String, SaveRefusal> {
    match where_ {
        Destination::GenexRun => {
            let state = lookup(env, STATE_DIR_ENV);
            if !is_native_root(&state) {
                return Err(SaveRefusal::NoStateDir);
            }
            Ok(join(&state, &[], NATIVE_SEPARATOR))
        }
        Destination::Web => Ok(WEB_SAVE_ROOT.to_owned()),
        Destination::Mac => {
            if !is_bundle_id(game.bundle_id) {
                return Err(SaveRefusal::BadBundleId);
            }
            let home = lookup(env, "HOME");
            if !is_posix_root(&home) {
                return Err(SaveRefusal::NoHome);
            }
            Ok(join(&home, &["Library", "Application Support", game.bundle_id], '/'))
        }
        Destination::Windows => {
            if !is_safe_name(game.name) {
                return Err(SaveRefusal::BadName);
            }
            let app_data = lookup(env, "APPDATA");
            if !is_windows_root(&app_data) {
                return Err(SaveRefusal::NoAppData);
            }
            Ok(join(&app_data, &[game.name], '\\'))
        }
        Destination::Linux => {
            if !is_safe_name(game.name) {
                return Err(SaveRefusal::BadName);
            }
            linux_root(env, game.name)
        }
        Destination::Ios => {
            let home = lookup(env, "HOME");
            if !is_posix_root(&home) {
                return Err(SaveRefusal::NoHome);
            }
            Ok(join(&home, &["Library", "Application Support"], '/'))
        }
        Destination::Android => {
            let data = lookup(env, ANDROID_DATA_KEY);
            if !is_posix_root(&data) {
                return Err(SaveRefusal::NoDataDir);
            }
            Ok(join(&data, &[], '/'))
        }
    }
}

/// The identity a game saves under: its own `save_name` when it set one, else the build's; the
/// running app's bundle id when it has one (the host writes every Mac app's Info.plist), else the
/// build's.
pub fn identity_of<'a>(save_name: &'a str, running_bundle_id: &'a str, build: GameIdentity<'a>) -> GameIdentity<'a> {
    GameIdentity {
        name: if save_name.is_empty() { build.name } else { save_name },
        bundle_id: if running_bundle_id.is_empty() { build.bundle_id } else { running_bundle_id },
    }
}

/// This process's destination: a Genex run when the studio passed its descriptor, else the
/// build's platform.
pub fn destination_of(env: &dyn Fn(&str) -> Option<String>) -> Destination {
    if !lookup(env, STUDIO_FD_ENV).is_empty() {
        return Destination::GenexRun;
    }
    if cfg!(target_family = "wasm") {
        Destination::Web
    } else if cfg!(windows) {
        Destination::Windows
    } else if cfg!(target_os = "ios") {
        Destination::Ios
    } else if cfg!(target_os = "android") {
        Destination::Android
    } else if cfg!(target_vendor = "apple") {
        Destination::Mac
    } else {
        Destination::Linux
    }
}

/// The process environment. Non-UTF-8 values read as absent, so they are never trusted.
pub fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Whether a Linux window build opens its window on X11: whenever `DISPLAY` names an X server.
pub fn prefers_x11(env: &dyn Fn(&str) -> Option<String>) -> bool {
    !lookup(env, X11_DISPLAY_ENV).is_empty()
}

/// Whether `rel` may name a file under assets/ (or the save folder): `/`-separated segments of
/// letters, digits, space, `_`, `-` and `.`, none empty, `.` or `..`. Absolute paths, backslashes
/// and drive letters are refused, and so is what Windows would read differently: a segment ending
/// in a dot or a space (Win32 strips them, so `.. ` is `..`) and a device name (`con.png`).
pub fn is_safe_asset_path(rel: &str) -> bool {
    !rel.is_empty() && !has_nul(rel) && rel.split('/').all(is_safe_segment)
}

/// A loaded file under the platform's assets root labelled `/assets/<rel>` for replay. Both paths
/// must be absolute and the relative name must be safe; everything else keeps its original label.
/// This is a lexical evidence label only: it never opens a file or grants access to one.
pub fn asset_claim(file: &str, asset_root: &str) -> String {
    let mut root = absolute_claim_path(asset_root);
    let absolute = absolute_claim_path(file);
    if root.is_empty() || absolute.is_empty() {
        return file.to_owned();
    }
    if !root.ends_with('/') {
        root.push('/');
    }
    let Some(relative) = absolute.strip_prefix(&root) else { return file.to_owned() };
    if is_safe_asset_path(relative) { format!("/assets/{relative}") } else { file.to_owned() }
}

/// `<state_root>captures/`: the folder captures go in, for a save root ending in its separator;
/// "" unless `state_root` is absolute in this platform's own form and does not climb (as
/// `GENEX_STATE_DIR` must be), so an empty or relative root never lands at `/captures/` or in the
/// working folder.
pub fn capture_folder(state_root: &str) -> String {
    if !is_native_root(state_root) {
        return String::new();
    }
    join(state_root, &[CAPTURES_DIR], NATIVE_SEPARATOR)
}

/// `<state_root>captures/<seq>.bgra`: where the host reads capture `seq`; "" where
/// [`capture_folder`] is.
pub fn capture_path(state_root: &str, seq: u32) -> String {
    let folder = capture_folder(state_root);
    if folder.is_empty() {
        return String::new();
    }
    format!("{folder}{seq}{CAPTURE_EXTENSION}")
}

/// The file a raylib-style log line says was loaded: an informational `FILEIO: [path] …` line,
/// unless the path is under `save_root` (the game's own saves are not assets). "" for anything
/// else, failures included.
pub fn claimed_file<'a>(informational: bool, line: &'a str, save_root: &str) -> &'a str {
    if !informational {
        return "";
    }
    let Some(rest) = line.strip_prefix(FILEIO_PREFIX) else { return "" };
    let Some(end) = rest.find(']') else { return "" };
    let file = &rest[..end];
    let saved = !save_root.is_empty() && file.starts_with(save_root);
    if saved { "" } else { file }
}
