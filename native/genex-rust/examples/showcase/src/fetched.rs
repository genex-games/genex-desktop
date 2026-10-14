//! The processing step of the lakeside's fetched CC0 assets (`scripts/showcase-assets.ts` downloads
//! and verifies them; `showcase-assets fetched <raw> <out> <manifest>` runs this): the four terrain
//! layers packed into the two atlases the terrain material samples, and every other map and the
//! sky map copied under the names the scene asks for. Everything lands in `<out>/fetched/`.
//!
//! The terrain material is a Level-2 v2 source, whose game textures are sRGB RGBA8: the albedo
//! atlas holds colour (RGB) and the layer's height (A, never sRGB-decoded); the detail atlas holds
//! data, each RGB byte stored sRGB-encoded so the GPU's decode hands the shader the value itself
//! (the normal's x and y, the roughness), and the ambient occlusion in A.

use std::path::{Path, PathBuf};

use genex::Value;
use image::imageops::FilterType;
use image::{GrayImage, RgbaImage};

/// One terrain layer's tile side in the atlases.
pub const TILE: u32 = 1024;
/// The atlases' side: two tiles across and down.
pub const ATLAS: u32 = TILE * 2;
/// The terrain layers in atlas order (tile 0 top left, 1 top right, 2 bottom left, 3 bottom right),
/// by their manifest `output` names.
pub const TERRAIN_LAYERS: [&str; 4] = ["terrain-grass", "terrain-soil", "terrain-sand", "terrain-rock"];
/// The albedo atlas the terrain material binds (`assets/fetched/...`): colour and height.
pub const ALBEDO_ATLAS: &str = "terrain-albedo.png";
/// The detail atlas: normal x and y, roughness (sRGB-stored data) and ambient occlusion.
pub const DETAIL_ATLAS: &str = "terrain-detail.png";

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

/// Pack the four terrain layers of `assets` (cached under `raw`) into the two atlases.
pub fn terrain_atlases(raw: &Path, assets: &[Value]) -> Result<(RgbaImage, RgbaImage), Failure> {
    let mut albedo = RgbaImage::new(ATLAS, ATLAS);
    let mut detail = RgbaImage::new(ATLAS, ATLAS);
    for (index, output) in TERRAIN_LAYERS.iter().enumerate() {
        let asset = assets.iter().find(|asset| asset["output"] == *output).ok_or_else(|| fail(format!("no {output} asset")))?;
        let diffuse = tile_rgba(&map_path(raw, asset, "diff")?)?;
        let normal = tile_rgba(&map_path(raw, asset, "nor_gl")?)?;
        let arm = tile_rgba(&map_path(raw, asset, "arm")?)?;
        let height = tile_gray(&map_path(raw, asset, "disp")?)?;
        let (ox, oy) = ((index as u32 % 2) * TILE, (index as u32 / 2) * TILE);
        for (x, y, texel) in diffuse.enumerate_pixels() {
            let [r, g, b, _] = texel.0;
            albedo.put_pixel(ox + x, oy + y, image::Rgba([r, g, b, height.get_pixel(x, y).0[0]]));
            let [nx, ny, _, _] = normal.get_pixel(x, y).0;
            let [ao, rough, _, _] = arm.get_pixel(x, y).0;
            let data = |byte: u8| srgb_byte(f32::from(byte) / 255.0);
            detail.put_pixel(ox + x, oy + y, image::Rgba([data(nx), data(ny), data(rough), ao]));
        }
    }
    Ok((albedo, detail))
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
    let (albedo, detail) = terrain_atlases(raw, assets)?;
    for (name, atlas) in [(ALBEDO_ATLAS, albedo), (DETAIL_ATLAS, detail)] {
        atlas.save(fetched.join(name)).map_err(|error| fail(format!("{name}: {error}")))?;
    }
    let copied = copy_maps(raw, assets, &fetched)?;
    println!("fetched: 2 terrain atlases ({ATLAS} x {ATLAS}) and {copied} maps in {}", fetched.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_data_byte_stored_srgb_encoded_decodes_back_to_itself() {
        for byte in [0u8, 1, 10, 64, 128, 200, 255] {
            let linear = f32::from(byte) / 255.0;
            let decoded = genex_render::texture::srgb_to_linear(srgb_byte(linear));
            assert!((decoded - linear).abs() <= 1.5 / 255.0, "{byte}: {decoded}");
        }
    }
}
