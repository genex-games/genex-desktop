//! What the examples' rows share: the assets a run reads, and captures written as PNG evidence.
//!
//! The examples ship no asset files (a game fetches its CC0 scans and makes its decals and rigs),
//! so a row reads them from `GENEX_EXAMPLES_ASSETS` when it is set (a folder laid out as a game's
//! `assets/`) and otherwise draws the stand-in colours. The GPU rows write to
//! `GENEX_EXAMPLES_OUT` (default `.studio-dev/evidence/template-examples`).

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use genex::AssetTable;
use genex::present::Presenter;
use genex::render::{PresetChoice, QualityPreset, RenderChange};
use genex::{Runtime, View};

/// Every file under `dir`, named by its path below it with forward slashes, in sorted order.
fn read_tree(dir: &Path, prefix: &str, files: &mut Vec<(&'static str, &'static [u8])>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_owned();
        if path.is_dir() {
            read_tree(&path, &format!("{prefix}{name}/"), files);
        } else if let Ok(bytes) = std::fs::read(&path) {
            files.push((Box::leak(format!("{prefix}{name}").into_boxed_str()), Box::leak(bytes.into_boxed_slice())));
        }
    }
}

/// The assets folder's files, plus `extra` (files a row writes in code), as an asset table.
pub fn assets(extra: &[(&'static str, Vec<u8>)]) -> AssetTable {
    let mut files = Vec::new();
    if let Some(dir) = std::env::var_os("GENEX_EXAMPLES_ASSETS") {
        read_tree(Path::new(&dir), "", &mut files);
    }
    for (name, bytes) in extra {
        files.push((*name, Box::leak(bytes.clone().into_boxed_slice()) as &'static [u8]));
    }
    Box::leak(files.into_boxed_slice())
}

/// The captures folder.
pub fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/template-examples");
    let dir = std::env::var_os("GENEX_EXAMPLES_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// Write a BGRA capture as an opaque RGBA PNG.
pub fn write_png(path: &Path, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

/// The mean Rec. 709 luma (0..255) of a BGRA capture.
pub fn mean_luma(bgra: &[u8]) -> f32 {
    let sum: f32 = bgra.chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).sum();
    sum / (bgra.len() / 4) as f32
}

/// A presenter on the host GPU, or None (a skip) where there is no WebGPU-core adapter and
/// `GENEX_REQUIRE_METAL=1` is not set.
pub fn presenter(size: [u32; 2], assets: AssetTable) -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open(size, assets) {
        Ok(presenter) => Some(presenter),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// Draw `view` at `preset` until it settles (probes captured, volumes baked, TAA converged) and
/// write it as `<name>-<preset>.png`; answers the capture's mean luma.
pub fn shoot<W: Default + 'static>(presenter: &mut Presenter, runtime: &mut Runtime<W>, view: View<'_>, preset: QualityPreset, name: &str) -> f32 {
    // The game's settings attach to the presenter on its first drawn frame.
    if presenter.render_settings().is_none() {
        presenter.draw_view(runtime, view).expect("a view").expect("drawn");
    }
    let change = RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.set_capturing(true);
    for _ in 0..SETTLE_FRAMES {
        presenter.draw_view(runtime, view).expect("a view").expect("drawn");
    }
    let capture = presenter.resilient.capture().expect("capture");
    let path = out_dir().join(format!("{name}-{}.png", preset.wire()));
    write_png(&path, capture.bgra(), [capture.width(), capture.height()]);
    eprintln!("wrote {}", path.display());
    mean_luma(capture.bgra())
}

/// Frames drawn before a capture: the irradiance volumes bake a few cells a frame.
const SETTLE_FRAMES: usize = 120;
