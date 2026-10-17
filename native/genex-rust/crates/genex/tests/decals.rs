//! Facade decals (renderer pass 2 A.10): what a draw hook declares with `frame.decal` reaches the
//! renderer's scene through the one conversion native and web share (`genex::present::to_scene`),
//! with its maps as the asset cache loaded them, and is not a draw.

use genex::glam::{Mat4, Vec3};
use genex::present::{AssetCache, ModelSource, Uploads, to_scene};
use genex::render::Decal;
use genex::{Camera, Color, Frame};
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::scene::{MeshId, Scene};
use genex_render::texture::{TextureData, TextureId, TextureKind};

fn scene_of(frame: &Frame, cache: &AssetCache) -> Scene {
    to_scene(frame, &Camera::DEFAULT, cache)
}

/// Asset bytes by path.
struct Files(Vec<(&'static str, Vec<u8>)>);

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.0.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
    }
}

/// A renderer stand-in answering texture ids in order, per kind.
#[derive(Default)]
struct Counting {
    textures: Vec<TextureKind>,
}

impl Uploads for Counting {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        Ok(MeshId::from_raw(2))
    }

    fn add_meshes(&mut self, meshes: Vec<MeshData>) -> Result<Vec<MeshId>, RenderError> {
        Ok((0..meshes.len() as u32).map(|n| MeshId::from_raw(2 + n)).collect())
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        let layer = self.textures.iter().filter(|known| **known == kind).count() as u32;
        self.textures.push(kind);
        Ok(TextureId::new(kind, layer))
    }
}

/// A 2x2 opaque white PNG (stored deflate).
const WHITE_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00,
    0x00, 0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d, 0x24, 0x00, 0x00, 0x00, 0x1d, 0x49, 0x44, 0x41, 0x54, 0x78,
    0x01, 0x01, 0x12, 0x00, 0xed, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0x8f, 0x82, 0x0f, 0xf1, 0x6d, 0x9e, 0x54, 0xf2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
    0x60, 0x82,
];

#[test]
fn decals_reach_the_scene_in_call_order_with_their_loaded_maps_and_are_not_draws() {
    let files = Files(vec![("decals/poster.png", WHITE_PNG.to_vec()), ("decals/ripples.png", WHITE_PNG.to_vec())]);
    let poster = Decal::on_wall(Vec3::new(0.0, 1.5, -2.0), Vec3::Z, 1.2, 1.6).with_base_texture("decals/poster.png").with_color(Color::rgba(255, 200, 200, 128));
    let puddle = Decal::on_ground(Vec3::new(1.0, 0.0, 0.5), 2.0, 1.0).with_normal_texture("decals/ripples.png", 0.4).with_albedo_mix(0.0).with_roughness(0.05);
    let mut frame = Frame::default();
    frame.decal(&poster).decal(&puddle);
    assert_eq!(frame.draw_calls(), 0, "a decal is not a draw");
    let mut uploads = Counting::default();
    let mut cache = AssetCache::default();
    cache.load(&frame, &files, &mut uploads, &mut |line| panic!("every map loads: {line}")).expect("no device loss");
    assert_eq!(uploads.textures, [TextureKind::Color, TextureKind::Normal], "the decals' maps load as their kinds");
    let decals = scene_of(&frame, &cache).lighting.decals;
    assert_eq!(decals.len(), 2);
    assert_eq!(decals[0].albedo, Some(TextureId::new(TextureKind::Color, 0)));
    assert!((decals[0].opacity - 128.0 / 255.0).abs() < 1e-6, "the colour's alpha is the opacity");
    let up = Mat4::from_cols_array(&decals[0].model).y_axis.truncate();
    assert!((up.normalize() - Vec3::Z).length() < 1e-5, "a wall decal looks out of the wall: {up}");
    assert_eq!(decals[1].normal, Some(TextureId::new(TextureKind::Normal, 0)));
    assert_eq!((decals[1].albedo_mix, decals[1].roughness), (0.0, Some(0.05)));
}

#[test]
fn a_decal_whose_base_texture_has_not_loaded_is_not_drawn() {
    // Its base colour's alpha is its shape: without it the box would be filled whole.
    let mut frame = Frame::default();
    frame.decal(&Decal::on_ground(Vec3::ZERO, 1.0, 1.0).with_base_texture("decals/missing.png"));
    frame.decal(&Decal::on_ground(Vec3::X, 1.0, 1.0).with_color(Color::rgb(40, 40, 40)));
    let mut cache = AssetCache::default();
    cache.load(&frame, &Files(Vec::new()), &mut Counting::default(), &mut |_| {}).expect("no device loss");
    let decals = scene_of(&frame, &cache).lighting.decals;
    assert_eq!(decals.len(), 1, "the untextured decal stays, the unloaded one waits");
    assert_eq!(decals[0].model[12], 1.0);
}

#[test]
fn a_wall_decal_is_upright_and_turns_about_its_face() {
    // Its image's right is the wall's right as seen from the front, its image's up the world's up
    // (the box's local -z), and `rotated` turns it in the wall's plane.
    let decal = Decal::on_wall(Vec3::ZERO, Vec3::X, 2.0, 1.0);
    let model = Mat4::from_cols_array(&decal.transform.to_cols_array());
    let (right, up) = (model.x_axis.truncate().normalize(), -model.z_axis.truncate().normalize());
    assert!((up - Vec3::Y).length() < 1e-5, "{up}");
    assert!((right - Vec3::NEG_Z).length() < 1e-5, "seen from +x, right is -z: {right}");
    let turned = Mat4::from_cols_array(&decal.rotated(std::f32::consts::FRAC_PI_2).transform.to_cols_array());
    assert!((turned.y_axis.truncate().normalize() - Vec3::X).length() < 1e-5, "still facing out of the wall");
    assert_eq!(Frame::default().decals().len(), 0, "none by default");
}
