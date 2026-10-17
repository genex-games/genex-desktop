//! The pond's window path, headless (FIX-WINDOW): `genex::desktop_shot` runs the desktop shell's
//! own frames (the loop a window gets, with no window) and letterboxes the world into an
//! offscreen window the way the shell presents onto a real one. The pond in a window must show
//! the pond (ground, water, the GLB rim, floaters, the rod), never the lone magenta checker a
//! screenshot once showed; the control row with an empty asset table shows exactly that checker
//! and names the models it could not load in `state().__render.missingModels`.
//!
//! GPU rows: they skip when the host has no WebGPU-core adapter, and `GENEX_REQUIRE_METAL=1` turns
//! that skip into a failure. With `GENEX_WINDOW_EVIDENCE_DIR` set to an absolute folder each row
//! also writes its window as a PNG there.

use genex::render::{QualityPreset, RenderConfig};
use genex::{DesktopShot, DesktopShotError, Value, desktop_shot};
use std::path::PathBuf;

/// A window that is not the world's 16:9, so the shot has letterbox bars (960×540 → 1280×720,
/// 40-pixel bars above and below).
const WINDOW: [u32; 2] = [1280, 800];
const BAR_ROWS: usize = 40;
/// Frames the shell runs before the shot: enough for the floaters to drop onto the water.
const FRAMES: u64 = 8;
/// The share of the window's pixels a material must cover to count as present.
const MIN_SHARE: f64 = 0.005;
/// The checker is one unit cube at the origin seen from 14 units away: about 0.15% of the window.
const MIN_CHECKER_SHARE: f64 = 0.0005;
const REQUIRE_METAL_ENV: &str = "GENEX_REQUIRE_METAL";
const EVIDENCE_ENV: &str = "GENEX_WINDOW_EVIDENCE_DIR";
/// The tags the pond draws every frame (the bobber only while a line is out).
const POND_TAGS: [&str; 5] = ["ground", "water", "pond", "floaters", "rod"];
/// The checker is drawn on the unit cube: 12 triangles.
const CUBE_TRIANGLES: u64 = 12;
/// The stack the shot's frames run on: a desktop shell runs them on the game's main thread (8 MiB
/// on macOS). A test thread's default 2 MiB is too small for an unoptimized (debug) build of the
/// renderer, whose moves are not elided, so `cargo test --workspace` overflowed it.
const SHELL_STACK_BYTES: usize = 8 * 1024 * 1024;

/// The shot, or None when the host has no GPU (unless one is required).
fn shot(assets: genex::AssetTable) -> Option<DesktopShot> {
    shot_at(assets, None)
}

/// The shot with the game's render settings forcing `preset` when one is given.
fn shot_at(assets: genex::AssetTable, preset: Option<QualityPreset>) -> Option<DesktopShot> {
    on_shell_stack(move || shot_on_this_thread(assets, preset))
}

/// `run` on a thread with the shell's stack ([`SHELL_STACK_BYTES`]); its panic is this thread's.
fn on_shell_stack<T: Send + 'static>(run: impl FnOnce() -> T + Send + 'static) -> T {
    let thread = std::thread::Builder::new().name("shell-stack".to_owned()).stack_size(SHELL_STACK_BYTES).spawn(run);
    thread.expect("the shot's thread starts").join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// [`shot_at`] on the calling thread.
fn shot_on_this_thread(assets: genex::AssetTable, preset: Option<QualityPreset>) -> Option<DesktopShot> {
    let mut game = pond_game::game();
    if let Some(preset) = preset {
        game.render_settings(RenderConfig::new().preset(preset));
    }
    match desktop_shot(game, assets, FRAMES, WINDOW) {
        Ok(shot) => Some(shot),
        Err(DesktopShotError::Gpu(error)) if std::env::var(REQUIRE_METAL_ENV).is_ok_and(|v| v == "1") => {
            panic!("{REQUIRE_METAL_ENV}=1 but no GPU: {error}")
        }
        Err(DesktopShotError::Gpu(error)) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
        Err(error) => panic!("the shot failed: {error}"),
    }
}

/// BGRA pixels of the shot as [r, g, b].
fn pixels(shot: &DesktopShot) -> impl Iterator<Item = [u8; 3]> + '_ {
    shot.bgra.as_chunks::<4>().0.iter().map(|px| [px[2], px[1], px[0]])
}

fn is_magenta([r, g, b]: [u8; 3]) -> bool {
    r > 100 && b > 100 && u16::from(g) * 2 < u16::from(r) && u16::from(g) * 2 < u16::from(b)
}

fn is_grass([r, g, b]: [u8; 3]) -> bool {
    g > 40 && g > r.saturating_add(15) && g > b.saturating_add(15)
}

fn is_water([r, g, b]: [u8; 3]) -> bool {
    b > 60 && b > r.saturating_add(30) && b > g
}

fn share(shot: &DesktopShot, test: fn([u8; 3]) -> bool) -> f64 {
    let total = shot.bgra.len() / 4;
    pixels(shot).filter(|px| test(*px)).count() as f64 / total as f64
}

fn tag_triangles(state: &Value, tag: &str) -> u64 {
    state["__render"]["tags"][tag]["triangles"].as_u64().unwrap_or(0)
}

/// Whether every pixel of the bars above and below the world is black.
fn bars_are_black(shot: &DesktopShot) -> bool {
    let bars = BAR_ROWS * shot.window[0] as usize * 4;
    let (top, rest) = shot.bgra.split_at(bars);
    let bottom = &rest[rest.len() - bars..];
    [top, bottom].iter().all(|bar| bar.as_chunks::<4>().0.iter().all(|px| px[..3] == [0, 0, 0]))
}

/// Write the shot as a PNG under `GENEX_WINDOW_EVIDENCE_DIR` when it names an absolute folder.
fn write_evidence(shot: &DesktopShot, name: &str) {
    let Some(dir) = std::env::var_os(EVIDENCE_ENV).map(PathBuf::from) else { return };
    assert!(dir.is_absolute(), "{EVIDENCE_ENV} must be absolute: {dir:?}");
    std::fs::create_dir_all(&dir).expect("evidence folder");
    let rgba: Vec<u8> = shot.bgra.as_chunks::<4>().0.iter().flat_map(|px| [px[2], px[1], px[0], 255]).collect();
    let file = dir.join(name);
    std::fs::write(&file, png::encode(shot.window, &rgba)).expect("write the PNG");
    eprintln!("evidence: {}", file.display());
}

#[test]
fn metal_the_pond_in_a_window_shows_the_pond_and_never_the_checker() {
    let Some(shot) = shot(pond_game::ASSETS) else { return };
    write_evidence(&shot, "pond-window.png");
    assert_eq!(shot.frames, FRAMES, "the shell ran its frames");
    assert!(shot.drawn >= 1, "the frames drew");
    let state = &shot.state;
    for tag in POND_TAGS {
        assert!(tag_triangles(state, tag) > 0, "{tag} was drawn: {}", state["__render"]);
    }
    assert!(tag_triangles(state, "pond") > CUBE_TRIANGLES, "the rim is the GLB, not the checker cube: {}", state["__render"]);
    assert!(tag_triangles(state, "water") > CUBE_TRIANGLES, "the water is the GLB: {}", state["__render"]);
    assert_eq!(state["__render"].get("missingModels"), None, "no model is missing: {}", state["__render"]);
    assert_eq!(share(&shot, is_magenta), 0.0, "no magenta checker pixel");
    assert!(share(&shot, is_grass) > MIN_SHARE, "grass is on screen: {}", share(&shot, is_grass));
    assert!(share(&shot, is_water) > MIN_SHARE, "water is on screen: {}", share(&shot, is_water));
    assert!(bars_are_black(&shot), "the world is letterboxed into the window");
}

#[test]
fn metal_an_empty_asset_table_shows_the_checker_and_names_the_missing_models() {
    let Some(shot) = shot(&[]) else { return };
    write_evidence(&shot, "pond-window-empty-assets.png");
    let state = &shot.state;
    assert_eq!(state["__render"]["missingModels"], genex::json!(["water.glb", "pond.glb"]), "{}", state["__render"]);
    assert_eq!(tag_triangles(state, "pond"), CUBE_TRIANGLES, "the rim fell back to the checker cube");
    assert!(share(&shot, is_magenta) > MIN_CHECKER_SHARE, "the checker is on screen: {}", share(&shot, is_magenta));
    assert!(share(&shot, is_grass) > MIN_SHARE, "the ground still draws");
}

/// The pond at each preset (renderer follow-up's final comparison): the same window shot with the
/// game's render settings forcing `low`, `medium`, `high` and `ultra`; each shows the pond and never
/// the checker, and with `GENEX_WINDOW_EVIDENCE_DIR` is written as `pond-window-<preset>.png`.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_the_pond_at_each_preset_shows_the_pond() {
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let Some(shot) = shot_at(pond_game::ASSETS, Some(preset)) else { return };
        write_evidence(&shot, &format!("pond-window-{}.png", preset.wire()));
        assert_eq!(share(&shot, is_magenta), 0.0, "{}: no magenta checker pixel", preset.wire());
        assert!(share(&shot, is_grass) > MIN_SHARE, "{}: grass is on screen", preset.wire());
        assert!(share(&shot, is_water) > MIN_SHARE, "{}: water is on screen", preset.wire());
    }
}

/// A minimal PNG writer for the evidence (stored deflate blocks, no compression): the workspace
/// carries no PNG encoder for tests.
mod png {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    const STORED_BLOCK_MAX: usize = 65_535;
    const COLOR_TYPE_RGBA: u8 = 6;
    const BIT_DEPTH: u8 = 8;

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff_u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    fn adler32(bytes: &[u8]) -> u32 {
        let (mut a, mut b) = (1_u32, 0_u32);
        for byte in bytes {
            a = (a + u32::from(*byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        (b << 16) | a
    }

    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&u32::try_from(data.len()).expect("chunk size").to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let crc = crc32(&out[start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }

    /// RGBA rows top to bottom as a PNG file.
    pub fn encode([width, height]: [u32; 2], rgba: &[u8]) -> Vec<u8> {
        let row = width as usize * 4;
        let mut raw = Vec::with_capacity((row + 1) * height as usize);
        for line in rgba.chunks(row) {
            raw.push(0);
            raw.extend_from_slice(line);
        }
        let mut zlib = vec![0x78, 0x01];
        let blocks: Vec<&[u8]> = raw.chunks(STORED_BLOCK_MAX).collect();
        for (i, block) in blocks.iter().enumerate() {
            zlib.push(u8::from(i + 1 == blocks.len()));
            let len = u16::try_from(block.len()).expect("stored block");
            zlib.extend_from_slice(&len.to_le_bytes());
            zlib.extend_from_slice(&(!len).to_le_bytes());
            zlib.extend_from_slice(block);
        }
        zlib.extend_from_slice(&adler32(&raw).to_be_bytes());
        let mut header = Vec::new();
        header.extend_from_slice(&width.to_be_bytes());
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[BIT_DEPTH, COLOR_TYPE_RGBA, 0, 0, 0]);
        let mut out = SIGNATURE.to_vec();
        chunk(&mut out, b"IHDR", &header);
        chunk(&mut out, b"IDAT", &zlib);
        chunk(&mut out, b"IEND", &[]);
        out
    }
}
