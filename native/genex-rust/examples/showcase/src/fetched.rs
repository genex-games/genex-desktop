//! The processing step of a showcase scene's fetched CC0 assets (`scripts/showcase-assets.ts`
//! downloads and verifies them; `showcase-assets fetched <raw> <out> <manifest>` runs this): the
//! lakeside's four terrain layers packed into the two files each the built-in terrain samples (a
//! scene without terrain, Harbour Street, packs none), and every other map and sky map copied under
//! the names the scene asks for. Everything lands in `<out>/fetched/`.
//!
//! A terrain layer (renderer pass 2 A.7, `genex::TerrainLayer::textured`) is a base colour texture
//! (sRGB colour in RGB, the layer's height in A, never decoded) and a data texture read linear (the
//! normal's x and y, the roughness, the ambient occlusion), each [`TILE`] texels a side.

use std::path::{Path, PathBuf};

use genex::Value;
use image::imageops::FilterType;
use image::{GrayImage, RgbaImage};

/// One terrain layer's texture side.
pub const TILE: u32 = 1024;
/// The terrain layers by their manifest `output` names.
pub const TERRAIN_LAYERS: [&str; 4] = ["terrain-grass", "terrain-soil", "terrain-sand", "terrain-rock"];

/// The base colour (and height) file of terrain layer `output` under `fetched/`.
pub fn layer_file(output: &str) -> String {
    format!("{output}-layer.png")
}

/// The data file (normal, roughness, occlusion) of terrain layer `output` under `fetched/`.
pub fn data_file(output: &str) -> String {
    format!("{output}-data.png")
}

/// A processing failure, with what failed.
#[derive(Debug)]
pub struct Failure(pub String);

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn fail(what: impl std::fmt::Display) -> Failure {
    Failure(what.to_string())
}

/// One sRGB-encoded byte of a linear value (0..1): the byte the GPU decodes back to it.
pub fn srgb_byte(linear: f32) -> u8 {
    let c = linear.clamp(0.0, 1.0);
    let encoded = if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * genex::math::pow(c, 1.0 / 2.4) - 0.055 };
    (encoded * 255.0).round() as u8
}

/// The cached file of `asset`'s `map` under `raw`.
fn map_path(raw: &Path, asset: &Value, map: &str) -> Result<PathBuf, Failure> {
    let id = asset["id"].as_str().ok_or_else(|| fail("an asset without an id"))?;
    let files = asset["files"].as_array().ok_or_else(|| fail(format!("{id}: no files")))?;
    let file = files.iter().find(|file| file["map"] == map).ok_or_else(|| fail(format!("{id}: no {map} map")))?;
    let name = file["name"].as_str().ok_or_else(|| fail(format!("{id}: a file without a name")))?;
    Ok(raw.join(id).join(name))
}

fn open(path: &Path) -> Result<image::DynamicImage, Failure> {
    image::open(path).map_err(|error| fail(format!("{}: {error}", path.display())))
}

fn tile_rgba(path: &Path) -> Result<RgbaImage, Failure> {
    Ok(image::imageops::resize(&open(path)?.to_rgba8(), TILE, TILE, FilterType::Lanczos3))
}

fn tile_gray(path: &Path) -> Result<GrayImage, Failure> {
    Ok(image::imageops::resize(&open(path)?.to_luma8(), TILE, TILE, FilterType::Lanczos3))
}

/// Pack the four terrain layers of `assets` (cached under `raw`): per layer, (output name, base
/// colour with height, data).
pub fn terrain_layers(raw: &Path, assets: &[Value]) -> Result<Vec<(&'static str, RgbaImage, RgbaImage)>, Failure> {
    let mut layers = Vec::new();
    for output in TERRAIN_LAYERS {
        let asset = assets.iter().find(|asset| asset["output"] == output).ok_or_else(|| fail(format!("no {output} asset")))?;
        let diffuse = tile_rgba(&map_path(raw, asset, "diff")?)?;
        let normal = tile_rgba(&map_path(raw, asset, "nor_gl")?)?;
        let arm = tile_rgba(&map_path(raw, asset, "arm")?)?;
        let height = tile_gray(&map_path(raw, asset, "disp")?)?;
        let mut albedo = RgbaImage::new(TILE, TILE);
        let mut data = RgbaImage::new(TILE, TILE);
        for (x, y, texel) in diffuse.enumerate_pixels() {
            let [r, g, b, _] = texel.0;
            albedo.put_pixel(x, y, image::Rgba([r, g, b, height.get_pixel(x, y).0[0]]));
            let [nx, ny, _, _] = normal.get_pixel(x, y).0;
            let [ao, rough, _, _] = arm.get_pixel(x, y).0;
            data.put_pixel(x, y, image::Rgba([nx, ny, rough, ao]));
        }
        layers.push((output, albedo, data));
    }
    Ok(layers)
}

/// The processed name of `asset`'s `map` under `fetched/` (the terrain layers are packed instead).
fn copied_name(output: &str, map: &str) -> Option<String> {
    match map {
        "diff" => Some(format!("{output}-albedo.jpg")),
        "nor_gl" => Some(format!("{output}-normal.jpg")),
        "arm" => Some(format!("{output}-orm.jpg")),
        "hdr" => Some(format!("{output}.hdr")),
        _ => None,
    }
}

/// Copy every non-terrain map of `assets` from `raw` into `fetched` under its processed name.
fn copy_maps(raw: &Path, assets: &[Value], fetched: &Path) -> Result<usize, Failure> {
    let mut copied = 0;
    for asset in assets {
        let output = asset["output"].as_str().ok_or_else(|| fail("an asset without an output name"))?;
        if TERRAIN_LAYERS.contains(&output) {
            continue;
        }
        for file in asset["files"].as_array().into_iter().flatten() {
            let map = file["map"].as_str().unwrap_or_default();
            let Some(name) = copied_name(output, map) else { continue };
            std::fs::copy(map_path(raw, asset, map)?, fetched.join(&name)).map_err(|error| fail(format!("{name}: {error}")))?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// Process the cache `raw` into `out/fetched/` from the manifest at `manifest`.
pub fn process(raw: &Path, out: &Path, manifest: &Path) -> Result<(), Failure> {
    let text = std::fs::read_to_string(manifest).map_err(|error| fail(format!("{}: {error}", manifest.display())))?;
    let manifest: Value = text.parse().map_err(|error| fail(format!("the manifest: {error}")))?;
    let assets = manifest["assets"].as_array().ok_or_else(|| fail("the manifest lists no assets"))?;
    let fetched = out.join("fetched");
    std::fs::create_dir_all(&fetched).map_err(|error| fail(format!("{}: {error}", fetched.display())))?;
    // A scene without terrain (Harbour Street) has no layers to pack: only its maps are copied.
    let mut packed = 0;
    if has_terrain(assets) {
        for (output, albedo, data) in terrain_layers(raw, assets)? {
            for (name, image) in [(layer_file(output), albedo), (data_file(output), data)] {
                image.save(fetched.join(&name)).map_err(|error| fail(format!("{name}: {error}")))?;
            }
            packed += 1;
        }
    }
    let copied = copy_maps(raw, assets, &fetched)?;
    println!("fetched: {packed} terrain layers ({TILE} x {TILE}) and {copied} maps in {}", fetched.display());
    Ok(())
}

/// Whether `assets` names any terrain layer (then [`terrain_layers`] needs all four).
fn has_terrain(assets: &[Value]) -> bool {
    assets.iter().any(|asset| asset["output"].as_str().is_some_and(|output| TERRAIN_LAYERS.contains(&output)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty folder under the system's temporary folder for one test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genex-fetched-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch folder");
        dir
    }

    // Harbour Street's manifest (renderer pass 2, A.13) has material maps and a sky map but no
    // terrain: processing it used to stop at "no terrain-grass asset" and copy nothing.
    #[test]
    fn a_manifest_without_terrain_layers_copies_its_maps_and_packs_no_layer() {
        let dir = scratch("no-terrain");
        let (raw, out) = (dir.join("raw"), dir.join("out"));
        let maps = [("asphalt_02", "asphalt_02_diff_1k.jpg", "diff"), ("asphalt_02", "asphalt_02_arm_1k.jpg", "arm"), ("kloppenheim_01_puresky", "sky_2k.hdr", "hdr")];
        for (id, name, _) in maps {
            std::fs::create_dir_all(raw.join(id)).expect("an asset folder");
            std::fs::write(raw.join(id).join(name), name.as_bytes()).expect("a cached map");
        }
        let manifest = genex::json!({ "assets": [
            { "id": "asphalt_02", "output": "asphalt", "files": [{ "map": "diff", "name": maps[0].1 }, { "map": "arm", "name": maps[1].1 }] },
            { "id": "kloppenheim_01_puresky", "output": "dusk-sky", "files": [{ "map": "hdr", "name": maps[2].1 }] },
        ]});
        let manifest_path = dir.join("manifest.json");
        std::fs::write(&manifest_path, manifest.to_string()).expect("the manifest");
        process(&raw, &out, &manifest_path).expect("a manifest without terrain layers processes");
        let fetched = out.join("fetched");
        for (name, from) in [("asphalt-albedo.jpg", maps[0].1), ("asphalt-orm.jpg", maps[1].1), ("dusk-sky.hdr", maps[2].1)] {
            assert_eq!(std::fs::read(fetched.join(name)).expect(name), from.as_bytes(), "{name} is the cached map");
        }
        for output in TERRAIN_LAYERS {
            for name in [layer_file(output), data_file(output)] {
                assert!(!fetched.join(&name).exists(), "{name}: no terrain, no layer");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_data_byte_stored_srgb_encoded_decodes_back_to_itself() {
        for byte in [0u8, 1, 10, 64, 128, 200, 255] {
            let linear = f32::from(byte) / 255.0;
            let decoded = genex_render::texture::srgb_to_linear(srgb_byte(linear));
            assert!((decoded - linear).abs() <= 1.5 / 255.0, "{byte}: {decoded}");
        }
    }
}
