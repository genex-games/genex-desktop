//! The native presenter's device and model files: a studio run and the desktop shell open the
//! shared [`Presenter`] headless on the host GPU, with the game's declared native-enhanced
//! features, and read models from the table a game compiled in, then `assets/` beside the
//! executable (`../Resources/assets/` inside a Mac app bundle, as the C++ runtime's `platform.cpp`
//! finds them). A dev-flavour build (feature `studio`) with no `assets/` beside it, such as a plain
//! `cargo run` from `target/debug`, reads `$CARGO_MANIFEST_DIR/assets` instead; an export never
//! does. Models are loaded once per path; a path outside the asset-path rule, or one with a link
//! at any of its names below the asset folder, is never read. The sim's reads
//! (`gfx.assets().bytes`) go through the same [`AssetFiles`], attached before the first reset.

#[cfg(feature = "studio")]
use std::ffi::OsString;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::gfx::{ASSET_READ_MAX_BYTES, AssetError, AssetErrorCode, AssetGroup, AssetGroups, AssetSource, AssetTable};
use crate::present::{ModelSource, Presenter, declared_features};
use genex_core::paths::is_safe_asset_path;
use genex_render::{Gpu, RenderError};

/// Where a Mac app bundle keeps its executable, and its assets relative to it.
const BUNDLE_EXECUTABLE_DIR: &str = "Contents/MacOS";
const BUNDLE_ASSETS: &str = "../Resources/assets";
const ASSETS_DIR: &str = "assets";
/// What cargo sets to the game crate's folder for `cargo run` and `cargo test` (dev fallback).
#[cfg(feature = "studio")]
const MANIFEST_DIR_ENV: &str = "CARGO_MANIFEST_DIR";

/// A native destination's assets, for the sim's reads and the presenter's: the compiled table
/// first, then files under the asset folder. A file is read only under the asset-path rule, never
/// through a link at its name or at a folder on the way to it (so it stays inside the folder), as a
/// regular file of at most [`ASSET_READ_MAX_BYTES`].
#[doc(hidden)]
pub struct AssetFiles {
    table: AssetTable,
    /// The asset folder; None for the table only. It is looked at again at each read, so a folder
    /// made after the game started (the studio's first import) is read as before.
    root: Option<PathBuf>,
    groups: AssetGroups,
}

/// A refusal of `code` about `path`.
fn refused(code: AssetErrorCode, path: &str, detail: impl std::fmt::Display) -> AssetError {
    AssetError::new(code, format!("{path}: {detail}"))
}

impl AssetFiles {
    /// The table, then the folder at `root` (None: the table only).
    pub fn new(table: AssetTable, root: Option<PathBuf>) -> AssetFiles {
        AssetFiles { table, root, groups: AssetGroups::default() }
    }

    /// The table, then this process's asset folder ([`asset_root`]).
    pub fn for_process(table: AssetTable) -> AssetFiles {
        AssetFiles::new(table, asset_root())
    }

    /// These files with the groups the build recorded for them.
    pub fn with_groups(mut self, groups: AssetGroups) -> AssetFiles {
        self.groups = groups;
        self
    }

    /// The path of `path` under the folder, reached through no link below it, a regular file, and
    /// its size; or why not. Nothing is opened. The streamed reads (`stream_source.rs`) check their
    /// paths here too.
    pub(crate) fn file(&self, path: &str) -> Result<(PathBuf, u64), AssetError> {
        if !is_safe_asset_path(path) {
            return Err(refused(AssetErrorCode::UnsafePath, path, "not a plain path under assets/"));
        }
        let Some(folder) = self.root.as_ref() else {
            return Err(refused(AssetErrorCode::Missing, path, "no asset folder"));
        };
        // The folder itself may be reached through links (a temporary folder's `/var`, a Mac
        // bundle's `MacOS/..`). Below it each name is looked at without following it and a link is
        // refused, so a path that never climbs (the asset-path rule) stays inside the folder. No
        // real path is taken: inside a Mac game's sandbox the folders above its bundle cannot be
        // read, so `realpath` fails there and Native Live drew no bundled asset (GE live-app r2).
        let root = std::fs::metadata(folder).map_err(|error| refused(AssetErrorCode::Missing, path, error))?;
        if !root.is_dir() {
            return Err(refused(AssetErrorCode::Missing, path, "the asset folder is not a folder"));
        }
        let mut named = folder.clone();
        let mut last = root;
        for segment in path.split('/') {
            named.push(segment);
            last = std::fs::symlink_metadata(&named).map_err(|error| refused(AssetErrorCode::Missing, path, error))?;
            if last.file_type().is_symlink() {
                return Err(refused(AssetErrorCode::UnsafePath, path, "a link"));
            }
        }
        if !last.is_file() {
            return Err(refused(AssetErrorCode::Missing, path, "not a file"));
        }
        if last.len() > ASSET_READ_MAX_BYTES {
            return Err(refused(AssetErrorCode::TooLarge, path, format!("{} bytes", last.len())));
        }
        Ok((named, last.len()))
    }
}

impl AssetSource for AssetFiles {
    fn read(&self, path: &str) -> Result<Arc<[u8]>, AssetError> {
        if let Some(bytes) = self.table.static_bytes(path) {
            return Ok(Arc::from(bytes));
        }
        let (real, _) = self.file(path)?;
        let bytes = std::fs::read(&real).map_err(|error| refused(AssetErrorCode::Missing, path, error))?;
        if bytes.len() as u64 > ASSET_READ_MAX_BYTES {
            return Err(refused(AssetErrorCode::TooLarge, path, format!("{} bytes", bytes.len())));
        }
        Ok(Arc::from(bytes))
    }

    fn size(&self, path: &str) -> Result<u64, AssetError> {
        if let Some(bytes) = self.table.static_bytes(path) {
            return Ok(bytes.len() as u64);
        }
        self.file(path).map(|(_, size)| size)
    }

    fn group(&self, path: &str) -> AssetGroup {
        self.groups.of(path)
    }
}

impl ModelSource for AssetFiles {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        AssetSource::read(self, path).ok().map(|bytes| bytes.to_vec())
    }

    /// The compiled table's bytes only: a file under the asset folder may change, so its decoded
    /// upload is kept.
    fn static_bytes(&self, path: &str) -> Option<&'static [u8]> {
        self.table.static_bytes(path)
    }
}

/// A native refusal goes to stderr, prefixed as the runtime's other lines are.
fn log_to_stderr(line: &str) {
    eprintln!("genex: {line}");
}

/// `assets/` beside the executable, or the bundle's Resources/assets for a Mac app.
fn beside_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bundled = dir.ends_with(BUNDLE_EXECUTABLE_DIR);
    Some(dir.join(if bundled { BUNDLE_ASSETS } else { ASSETS_DIR }))
}

/// The game crate's folder as cargo gives it to `cargo run` and `cargo test`, in the dev flavour
/// only: an export never reads a folder outside its own.
#[cfg(feature = "studio")]
fn dev_manifest_dir() -> Option<OsString> {
    std::env::var_os(MANIFEST_DIR_ENV)
}

#[cfg(not(feature = "studio"))]
fn dev_manifest_dir() -> Option<std::ffi::OsString> {
    None
}

/// Where models are read from disk: `beside` (the executable's `assets/`) when it is a folder;
/// else `<dev manifest>/assets` when the manifest folder is absolute and has one; else `beside`.
fn resolve_asset_root(
    beside: Option<PathBuf>,
    dev_manifest: Option<&OsStr>,
    is_dir: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if beside.as_deref().is_some_and(&is_dir) {
        return beside;
    }
    let manifest = dev_manifest.map(Path::new).filter(|dir| dir.is_absolute());
    let fallback = manifest.map(|dir| dir.join(ASSETS_DIR)).filter(|dir| is_dir(dir));
    fallback.or(beside)
}

/// The folder a native run reads its models from ([`resolve_asset_root`] for this process).
fn asset_root() -> Option<PathBuf> {
    resolve_asset_root(beside_executable(), dev_manifest_dir().as_deref(), Path::is_dir)
}

impl Presenter {
    /// Open the GPU headless with the game's declared features for a logical world of `size`;
    /// models come from `assets`, then this process's asset folder ([`asset_root`]).
    pub fn open(size: [u32; 2], assets: AssetTable) -> Result<Presenter, RenderError> {
        Presenter::open_with_root(size, assets, asset_root())
    }

    /// [`Presenter::open`] reading models from `assets` and `asset_root` only (None: the table only).
    pub fn open_with_root(size: [u32; 2], assets: AssetTable, asset_root: Option<PathBuf>) -> Result<Presenter, RenderError> {
        let declared = declared_features()?;
        let gpu = Gpu::headless_with(declared)?;
        let open = move || Gpu::headless_with(declared);
        let source = Box::new(AssetFiles::new(assets, asset_root));
        Presenter::with_gpu(gpu, size, declared, Box::new(open), source, log_to_stderr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Folders that exist, for [`resolve_asset_root`].
    fn folders(list: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |path| list.iter().any(|dir| path == Path::new(dir))
    }

    /// A dev build run away from its run folder (a plain `cargo run`, the binary in
    /// `target/debug`) reads its crate's `assets/`; `assets/` beside the executable always wins,
    /// and a relative, empty or asset-less manifest folder is never used.
    #[test]
    fn the_dev_asset_fallback_is_the_manifest_assets_only_when_nothing_is_beside_the_executable() {
        let beside = || Some(PathBuf::from("/run/bin/assets"));
        let os = |dir: &'static str| Some(OsStr::new(dir));
        // (the dev manifest folder, the folders that exist, the root)
        let rows: [(Option<&OsStr>, &'static [&'static str], &str); 6] = [
            (os("/src/game"), &["/run/bin/assets", "/src/game/assets"], "/run/bin/assets"),
            (os("/src/game"), &["/src/game/assets"], "/src/game/assets"),
            (os("src/game"), &["/src/game/assets", "src/game/assets"], "/run/bin/assets"),
            (os(""), &["assets"], "/run/bin/assets"),
            (os("/src/empty"), &["/src/empty"], "/run/bin/assets"),
            (None, &["/src/game/assets"], "/run/bin/assets"),
        ];
        for (dev, existing, root) in rows {
            let resolved = resolve_asset_root(beside(), dev, folders(existing));
            assert_eq!(resolved, Some(PathBuf::from(root)), "{dev:?} {existing:?}");
        }
        let no_exe = resolve_asset_root(None, os("/src/game"), folders(&["/src/game/assets"]));
        assert_eq!(no_exe, Some(PathBuf::from("/src/game/assets")));
    }

    /// An export (built without the dev flavour's `studio` feature) never reads a manifest folder.
    #[cfg(not(feature = "studio"))]
    #[test]
    fn an_export_has_no_dev_asset_fallback() {
        assert_eq!(dev_manifest_dir(), None);
    }

    /// The table answers first; a file is read only from under the root and only under the
    /// asset-path rule, so a hostile path reads nothing.
    #[test]
    fn models_come_from_the_table_then_the_root_and_never_from_outside_it() {
        let dir = std::env::temp_dir().join(format!("genex-present-files-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("assets")).expect("assets folder");
        std::fs::write(dir.join("assets/disk.glb"), b"disk").expect("asset");
        std::fs::write(dir.join("secret.glb"), b"secret").expect("outside file");
        let source = AssetFiles::new(&[("table.glb", b"table")], Some(dir.join("assets")));
        assert_eq!(source.model_bytes("table.glb").as_deref(), Some(&b"table"[..]));
        assert_eq!(source.model_bytes("disk.glb").as_deref(), Some(&b"disk"[..]));
        for hostile in ["../secret.glb", "/etc/hosts", "a/../../secret.glb", "", "missing.glb"] {
            assert_eq!(source.model_bytes(hostile), None, "{hostile:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A folder that appears after the files were opened (the studio's first import into a running
    /// game) is read, as before the real-path rule.
    #[test]
    fn an_asset_folder_made_after_opening_is_read() {
        let dir = std::env::temp_dir().join(format!("genex-present-late-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let source = AssetFiles::new(&[], Some(dir.join("assets")));
        assert_eq!(source.model_bytes("late.glb"), None);
        std::fs::create_dir_all(dir.join("assets")).expect("assets folder");
        std::fs::write(dir.join("assets/late.glb"), b"late").expect("asset");
        assert_eq!(source.model_bytes("late.glb").as_deref(), Some(&b"late"[..]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A link inside `assets/` that leads out of it (a file link or a folder link) reads nothing:
    /// the presenter's reads refuse every link below the folder, as the sim's do.
    #[cfg(unix)]
    #[test]
    fn a_link_inside_the_assets_folder_that_leaves_it_reads_nothing() {
        let dir = std::env::temp_dir().join(format!("genex-present-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).expect("assets folder");
        std::fs::create_dir_all(dir.join("outside")).expect("outside folder");
        std::fs::write(dir.join("outside/secret.glb"), b"secret").expect("outside file");
        std::os::unix::fs::symlink(dir.join("outside/secret.glb"), dir.join("assets/leak.glb")).expect("file link");
        std::os::unix::fs::symlink(dir.join("outside"), dir.join("assets/leaks")).expect("folder link");
        let source = AssetFiles::new(&[], Some(dir.join("assets")));
        for hostile in ["leak.glb", "leaks/secret.glb"] {
            assert_eq!(source.model_bytes(hostile), None, "{hostile:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The asset-folder hostile table, each refused by its code before anything is opened: a link
    /// at the name (inside or out), `..`, an absolute path, a folder link whose real path leaves
    /// the folder, and a file over the read cap (sparse, so nothing is written).
    #[cfg(unix)]
    #[test]
    fn the_hostile_asset_table_is_refused_before_any_read() {
        let dir = std::env::temp_dir().join(format!("genex-present-hostile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let assets = dir.join("assets");
        hostile_folder(&dir, &assets);
        let source = AssetFiles::new(&[], Some(assets));
        for (path, code) in HOSTILE_ROWS {
            let refusal = AssetSource::read(&source, path).err().map(|error| error.code());
            assert_eq!(refusal, Some(*code), "{path:?}");
        }
        assert_eq!(AssetSource::read(&source, "models/a.glb").map(|bytes| bytes.len()).ok(), Some(4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The hostile rows and the code each is refused with.
    #[cfg(unix)]
    const HOSTILE_ROWS: &[(&str, AssetErrorCode)] = &[
        ("alias.glb", AssetErrorCode::UnsafePath),
        ("leak.glb", AssetErrorCode::UnsafePath),
        ("leaks/secret.glb", AssetErrorCode::UnsafePath),
        ("../secret.glb", AssetErrorCode::UnsafePath),
        ("models/../../secret.glb", AssetErrorCode::UnsafePath),
        ("/etc/hosts", AssetErrorCode::UnsafePath),
        ("huge.bin", AssetErrorCode::TooLarge),
    ];

    /// `assets` with `models/a.glb`, `textures/a.png` and every hostile row's file; `dir/outside`
    /// holds the secret the links lead to.
    #[cfg(unix)]
    fn hostile_folder(dir: &Path, assets: &Path) {
        std::fs::create_dir_all(assets.join("models")).expect("models folder");
        std::fs::create_dir_all(assets.join("textures")).expect("textures folder");
        std::fs::create_dir_all(dir.join("outside")).expect("outside folder");
        std::fs::write(assets.join("models/a.glb"), b"glTF").expect("model");
        std::fs::write(assets.join("textures/a.png"), b"\x89PNG-one").expect("texture");
        std::fs::write(dir.join("outside/secret.glb"), b"secret").expect("outside file");
        std::fs::write(dir.join("secret.glb"), b"secret").expect("climbing file");
        std::os::unix::fs::symlink(assets.join("models/a.glb"), assets.join("alias.glb")).expect("link inside");
        std::os::unix::fs::symlink(dir.join("outside/secret.glb"), assets.join("leak.glb")).expect("file link");
        std::os::unix::fs::symlink(dir.join("outside"), assets.join("leaks")).expect("folder link");
        let huge = std::fs::File::create(assets.join("huge.bin")).expect("huge file");
        huge.set_len(ASSET_READ_MAX_BYTES + 1).expect("sparse length");
    }

    /// A Mac game's reads from inside the game sandbox: the bundle a Native Live run stages, run
    /// under the profile `gameSandboxProfile` writes (src/substrate/game-sandbox-profile.ts).
    #[cfg(target_os = "macos")]
    mod sandboxed {
        use super::*;
        use std::io::{BufRead, Write};
        use std::process::{Command, Stdio};

        /// Set in the child: this test binary, copied into the bundle, answers the rows from inside.
        const CHILD_ENV: &str = "GENEX_PRESENT_FILES_SANDBOX_CHILD";
        /// The child's test, by its full name in this binary.
        const CHILD_TEST: &str = "present_files::tests::sandboxed::child_reads_rows";
        const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
        /// The headless game profile's file and process rules as `gameSandboxProfile({ mode:
        /// "headless" })` writes them: reads of `/`, the system library and the bundle only, writes
        /// to the state folder only (its GPU and Mach lines are left out: the child draws nothing).
        const GAME_PROFILE: &str = r#"(version 1)
(deny default (with message (param "RUN_TAG")))
(allow process-exec (literal (param "EXE")))
(allow sysctl-read (sysctl-name "hw.ephemeral_storage") (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu") (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.perflevel0.logicalcpu") (sysctl-name "hw.perflevel1.logicalcpu") (sysctl-name "kern.bootargs") (sysctl-name "kern.iossupportversion") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.osvariant_status") (sysctl-name "security.mac.lockdown_mode_state") (sysctl-name "sysctl.proc_translated"))
(allow file-read* (literal "/") (subpath "/System/Library") (subpath (param "BUNDLE")))
(allow file-read* file-write* (subpath (param "STATE")))
(deny file-read* (subpath "/System/Library/Extensions/AppleMetalOpenGLRenderer.bundle") (subpath "/System/Library/Frameworks/OpenGL.framework"))
(deny network*)
"#;
        /// The rows the child reads twice: once as staged, once after the host swapped the PNG.
        const RESIDENT: [&str; 2] = ["models/a.glb", "textures/a.png"];

        /// One row's answer: `ok <length>` or the refusal's wire code.
        fn answer(files: &AssetFiles, path: &str) -> String {
            match AssetSource::read(files, path) {
                Ok(bytes) => format!("ok {}", bytes.len()),
                Err(error) => error.code().wire().to_owned(),
            }
        }

        /// The child: `asset_root()` from where it runs (`Game.app/Contents/MacOS`), every row, then
        /// a line from the parent, then the resident rows again.
        #[test]
        fn child_reads_rows() {
            if std::env::var_os(CHILD_ENV).is_none() {
                return;
            }
            let files = AssetFiles::for_process(&[]);
            let rows = RESIDENT.iter().copied().chain(HOSTILE_ROWS.iter().map(|(path, _)| *path));
            let first: Vec<String> = rows.map(|path| answer(&files, path)).collect();
            println!("FIRST {}", first.join("|"));
            std::io::stdout().flush().expect("flush");
            let mut swapped = String::new();
            std::io::stdin().lock().read_line(&mut swapped).expect("the parent's go-ahead");
            let again: Vec<String> = RESIDENT.iter().map(|path| answer(&files, path)).collect();
            println!("AGAIN {}", again.join("|"));
        }

        /// What follows `marker` on the first line holding it (libtest prints the test's name on the
        /// same line); "" when the child ended without it.
        fn marked(lines: impl Iterator<Item = std::io::Result<String>>, marker: &str) -> String {
            let mut found = lines.map_while(Result::ok).filter_map(|line| line.split_once(marker).map(|(_, rest)| rest.to_owned()));
            found.next().unwrap_or_default()
        }

        /// A Native Live run's folder (`<run>/bundle/Game.app/Contents/{MacOS/game,
        /// Resources/assets/}` and `<run>/state`), this test binary as its executable; the hostile
        /// files sit in `Resources/`, inside what the profile lets the game read.
        fn run_dir(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
            let run = std::fs::canonicalize(dir).expect("the run folder's real path");
            let contents = run.join("bundle/Game.app/Contents");
            std::fs::create_dir_all(contents.join("MacOS")).expect("MacOS");
            std::fs::create_dir_all(run.join("state")).expect("state");
            let assets = contents.join("Resources/assets");
            hostile_folder(&contents.join("Resources"), &assets);
            let exe = contents.join("MacOS/game");
            std::fs::copy(std::env::current_exe().expect("this test binary"), &exe).expect("the game executable");
            (run, exe, assets)
        }

        /// Native Live's game reads its bundled GLB and PNG from inside the game sandbox (GE
        /// live-app r2 red 1: the checker and an untextured PNG), refuses the hostile table there
        /// as outside it, and reads a PNG the host swapped in by rename while it runs (the native
        /// `reloadAssets` file swap, no rebuild).
        #[test]
        fn a_sandboxed_mac_game_reads_its_bundled_assets_and_a_swapped_png() {
            if std::env::var_os(CHILD_ENV).is_some() {
                return;
            }
            let dir = std::env::temp_dir().join(format!("genex-present-sandbox-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("run folder");
            let (run, exe, assets) = run_dir(&dir);
            let profile = dir.join("game.sb");
            std::fs::write(&profile, GAME_PROFILE).expect("profile");
            let define = |name: &str, value: &Path| format!("{name}={}", value.display());
            let defines = [define("EXE", &exe), define("BUNDLE", &run.join("bundle")), define("STATE", &run.join("state"))];
            let mut child = Command::new(SANDBOX_EXEC)
                .arg("-f")
                .arg(&profile)
                .args(["-D", "RUN_TAG=present-files"])
                .args(defines.iter().flat_map(|value| ["-D", value.as_str()]))
                .arg(&exe)
                .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
                .env_clear()
                .env(CHILD_ENV, "1")
                .current_dir(run.join("state"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("sandbox-exec");
            let mut lines = std::io::BufReader::new(child.stdout.take().expect("stdout")).lines();
            let first = marked(lines.by_ref(), "FIRST ");
            // The host's swap: the new bytes written beside, renamed over the old name.
            let swapped = assets.join("textures/.a.png.swap");
            std::fs::write(&swapped, b"\x89PNG-second-version").expect("new texture");
            std::fs::rename(&swapped, assets.join("textures/a.png")).expect("swap");
            writeln!(child.stdin.take().expect("stdin")).expect("go-ahead");
            // Read to the end, so the child's last lines never meet a closed pipe.
            let rest: Vec<std::io::Result<String>> = lines.collect();
            let again = marked(rest.into_iter(), "AGAIN ");
            let output = child.wait_with_output().expect("the child's end");
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let _ = std::fs::remove_dir_all(&dir);
            let refusals: Vec<&str> = HOSTILE_ROWS.iter().map(|(_, code)| code.wire()).collect();
            assert_eq!(first, format!("ok 4|ok 8|{}", refusals.join("|")), "{stderr}");
            assert_eq!(again, "ok 4|ok 19", "{stderr}");
            assert!(output.status.success(), "{stderr}");
        }
    }
}
