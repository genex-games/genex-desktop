//! Instance occlusion (horde 10k): Hi-Z occlusion of the instance path's copies in the camera and
//! in the sun's cascades ([`genex_render::occlusion`]).
//!
//! - Copies hidden behind a wall leave the camera's lists (their batch draws none), the copies
//!   beside it stay, and the picture is the one without occlusion, bit for bit.
//! - Copies the wall hides from a low sun leave the cascade once its history knows them; when the
//!   wall moves away the cascade's second phase draws them that same frame, and once that frame's
//!   counts come back (its Hi-Z hid almost nothing) the cascade sits out; every frame's picture is
//!   the one without occlusion.
//! - A scene under the row threshold occludes nothing.
//!
//! The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test instance_occlusion -- --ignored metal

use genex_render::capture::Capture;
use genex_render::device_class::DeviceClass;
use genex_render::layout::DrawIndexedArgs;
use genex_render::mesh::MeshData;
use genex_render::occlusion::{INSTANCE_OCCLUSION_MIN_ROWS, InstanceOcclusion};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Quality, QualityPreset, SceneFormat};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

const WIDTH: u32 = 160;
const HEIGHT: u32 = 96;
/// Copies behind the wall: past the row threshold with the rest of the scene.
const HIDDEN: u32 = INSTANCE_OCCLUSION_MIN_ROWS + 64;
/// Copies beside the wall, in view of the camera and the sun.
const SHOWN: u32 = 6;

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => Some(gpu),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// A sphere of `rings` × `segments`: each test mesh has its own index count, so its batch's
/// arguments are found by it.
fn sphere(rings: u32, segments: u32) -> MeshData {
    let mut mesh = MeshData::sphere();
    let rows = segments + 1;
    let mut vertices = Vec::new();
    for ring in 0..=rings {
        let theta = std::f32::consts::PI * ring as f32 / rings as f32;
        for segment in 0..=segments {
            let phi = std::f32::consts::TAU * segment as f32 / segments as f32;
            let n = [libm::sinf(theta) * libm::cosf(phi), libm::cosf(theta), -libm::sinf(theta) * libm::sinf(phi)];
            let mut vertex = mesh.vertices[0];
            vertex.position = n;
            vertex.normal = n;
            vertex.uv = [segment as f32 / segments as f32, ring as f32 / rings as f32];
            vertices.push(vertex);
        }
    }
    let mut indices = Vec::new();
    for ring in 0..rings {
        for segment in 0..segments {
            let (a, b) = (ring * rows + segment, (ring + 1) * rows + segment);
            indices.extend_from_slice(&[a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    mesh.vertices = vertices;
    mesh.indices = indices;
    mesh
}

struct Meshes {
    hidden: MeshId,
    hidden_indices: u32,
    shown: MeshId,
    shown_indices: u32,
}

fn meshes(renderer: &mut Renderer, gpu: &Gpu) -> Meshes {
    let (hidden, shown) = (sphere(6, 8), sphere(5, 7));
    let (hidden_indices, shown_indices) = (hidden.indices.len() as u32, shown.indices.len() as u32);
    let ids = renderer.add_meshes(gpu, vec![hidden, shown]).expect("meshes");
    Meshes { hidden: ids[0], hidden_indices, shown: ids[1], shown_indices }
}

/// The plain HDR path with the prepass (TAA's), and the high preset's sun shadows when `shadows`.
fn quality(shadows: bool) -> Quality {
    let class = DeviceClass::from_wire("desktop-ultra").expect("a class");
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    if shadows {
        quality.shadows = preset_quality(QualityPreset::High, class).shadows;
        quality.shadows.screen_mask = false;
    }
    quality
}

fn renderer(gpu: &Gpu, quality: &Quality, setting: InstanceOcclusion) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(quality);
    // Something must ask for the prepass for the camera to have a depth to build the Hi-Z from.
    renderer.set_prepass_demand(genex_render::prepass::ExtensionDemand { custom_inputs: genex_render::abi::RenderInputs::DEPTH, ..Default::default() });
    renderer.set_static_shadow_cache(false);
    renderer.set_instance_occlusion(setting);
    renderer
}

/// A ground, a wall at `wall_x` (0: in front of the field), a field of `HIDDEN` small spheres
/// behind it and `SHOWN` spheres beside it, under a low sun behind the camera, so the wall hides
/// the field from the camera and from the sun alike.
fn walled(meshes: &Meshes, wall_x: f32, shadows: bool) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.2, 7.0], [0.0, 1.0, 0.0]), [40, 50, 70, 255]);
    scene.lighting.shadows = shadows;
    scene.lighting.sun_dir = [0.05, 0.25, 1.0];
    scene.lighting.shadow_distance = 30.0;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -2.0], [30.0, 0.2, 30.0]), Material::color([120, 140, 100, 255]));
    scene.draw(MeshId::CUBE, scaled([wall_x, 1.6, 2.0], [5.0, 3.6, 0.3]), Material::color([180, 70, 60, 255]));
    let side = (HIDDEN as f32).sqrt().ceil() as u32;
    for i in 0..HIDDEN {
        let (x, z) = ((i % side) as f32 / side as f32 * 3.0 - 1.5, -((i / side) as f32) / side as f32 * 3.0);
        scene.draw(meshes.hidden, scaled([x, 0.6 + (i % 3) as f32 * 0.3, z], [0.12; 3]), Material::color([200, 200, 220, 255]));
    }
    for i in 0..SHOWN {
        scene.draw(meshes.shown, scaled([3.2 + (i % 2) as f32 * 0.5, 0.5 + (i / 2) as f32 * 0.4, 2.5], [0.2; 3]), Material::color([90, 160, 220, 255]));
    }
    scene
}

fn frame(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, index: u64) -> Capture {
    renderer.set_frame_index(index);
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

/// Copies the batch of `index_count` draws in `view`'s last arguments.
fn drawn(renderer: &Renderer, gpu: &Gpu, view: u32, index_count: u32) -> u32 {
    let args: Vec<DrawIndexedArgs> = renderer.read_view_args(gpu, view).expect("arguments");
    args.iter().filter(|args| args.index_count == index_count).map(|args| args.instance_count).sum()
}

fn differing(a: &Capture, b: &Capture) -> usize {
    a.bgra().chunks(4).zip(b.bgra().chunks(4)).filter(|(p, q)| p != q).count()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_copies_behind_a_wall_leave_the_camera_and_the_picture_holds() {
    let Some(gpu) = gpu() else { return };
    let quality = quality(false);
    let mut plain = renderer(&gpu, &quality, InstanceOcclusion::Off);
    let plain_meshes = meshes(&mut plain, &gpu);
    let expected = frame(&gpu, &mut plain, &walled(&plain_meshes, 0.0, false), 0);
    assert_eq!(drawn(&plain, &gpu, 0, plain_meshes.hidden_indices), HIDDEN, "without occlusion the camera draws the whole field");
    let shown = drawn(&plain, &gpu, 0, plain_meshes.shown_indices);
    assert!(shown > 0, "some copies beside the wall are in view");
    let mut occluded = renderer(&gpu, &quality, InstanceOcclusion::Auto);
    let meshes = meshes(&mut occluded, &gpu);
    let got = frame(&gpu, &mut occluded, &walled(&meshes, 0.0, false), 0);
    assert_eq!(occluded.last_stats().occluded_views & 1, 1, "the camera occluded its copies");
    assert_eq!(drawn(&occluded, &gpu, 0, meshes.hidden_indices), 0, "the field behind the wall leaves the camera's lists");
    assert_eq!(drawn(&occluded, &gpu, 0, meshes.shown_indices), shown, "the copies beside the wall stay");
    assert_eq!(differing(&expected, &got), 0, "the picture is the one without occlusion");
    // The wall moves aside: the field is back in the same frame.
    let open = frame(&gpu, &mut occluded, &walled(&meshes, 9.0, false), 1);
    assert_eq!(drawn(&occluded, &gpu, 0, meshes.hidden_indices), HIDDEN, "nothing hides the field once the wall is gone");
    let plain_open = frame(&gpu, &mut plain, &walled(&plain_meshes, 9.0, false), 1);
    assert_eq!(differing(&plain_open, &open), 0);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_casters_hidden_from_the_sun_leave_the_cascade_and_the_map_holds() {
    let Some(gpu) = gpu() else { return };
    let quality = quality(true);
    let mut plain = renderer(&gpu, &quality, InstanceOcclusion::Off);
    let plain_meshes = meshes(&mut plain, &gpu);
    let mut occluded = renderer(&gpu, &quality, InstanceOcclusion::Auto);
    let meshes = meshes(&mut occluded, &gpu);
    // Frame 0 has no history: the first phase draws every caster, and the history learns the field is hidden.
    let walls = [0.0, 0.0, 0.0, 9.0, 9.0];
    let mut cascade = 0;
    for (index, wall) in walls.iter().enumerate() {
        let expected = frame(&gpu, &mut plain, &walled(&plain_meshes, *wall, true), index as u64);
        if index == 0 {
            // The cascade whose light frustum holds the field (its view; 0 is the camera).
            cascade = (1..=3).find(|view| drawn(&plain, &gpu, *view, plain_meshes.hidden_indices) == HIDDEN).expect("a cascade casts the field");
        }
        let got = frame(&gpu, &mut occluded, &walled(&meshes, *wall, true), index as u64);
        assert_eq!(differing(&expected, &got), 0, "frame {index}: the picture is the one without occlusion");
        let occludes = occluded.last_stats().occluded_views & (1 << cascade) != 0;
        let second = drawn(&occluded, &gpu, cascade, meshes.hidden_indices);
        match index {
            0 => assert_eq!((occludes, second), (true, 0), "no history: the first phase drew the field, the second has nothing left"),
            1 | 2 => assert_eq!((occludes, second), (true, 0), "the wall hides the field from the sun: neither phase draws it"),
            3 => assert!(occludes && second > 0, "the wall moved away: the second phase draws the field the same frame ({second})"),
            // Frame 3's counts came back: its Hi-Z hid almost nothing, so the cascade sits out.
            _ => assert!(!occludes, "an open field does not pay: the cascade draws every caster at once"),
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_small_scene_occludes_nothing() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &quality(true), InstanceOcclusion::Auto);
    let meshes = meshes(&mut renderer, &gpu);
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.2, 7.0], [0.0, 1.0, 0.0]), [40, 50, 70, 255]);
    scene.lighting.shadows = true;
    for i in 0..(INSTANCE_OCCLUSION_MIN_ROWS / 2) {
        scene.draw(meshes.hidden, scaled([(i % 32) as f32 * 0.2 - 3.0, 0.5, -((i / 32) as f32) * 0.2], [0.05; 3]), Material::color([200, 200, 220, 255]));
    }
    frame(&gpu, &mut renderer, &scene, 0);
    assert_eq!(renderer.last_stats().occluded_views, 0);
}
