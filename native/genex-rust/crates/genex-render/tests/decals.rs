//! Clustered decals (renderer pass 2 A.10, `genex_render::decals`). CPU rows hold the presets'
//! caps, the binning, the cap's fade and the forward shader's bindings; real-GPU rows (`#[ignore]`d,
//! every name contains `metal`) draw decals through the renderer and read the HDR scene back:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test decals -- --ignored metal --test-threads=1
//!
//! `GENEX_RENDER_EVIDENCE_DIR` set: the rows write their frames there as `.ppm`; `GENEX_PERF_OUT`
//! set: the cost row appends its JSON row there.

use genex_render::Gpu;
use genex_render::cluster::ClusterKind;
use genex_render::decals::{DESKTOP_DECALS, Decal, MOBILE_DECALS, held_decals, rows_base};
use genex_render::device_class::{DeviceClass, FormFactor};
use genex_render::lights::{Lighting, PointLight, binned_frame};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Quality, QualityPreset};
use genex_render::texture::{TextureData, TextureKind};
use glam::{Mat4, Quat, Vec3};
use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};

fn class(wire: &str) -> DeviceClass {
    DeviceClass::from_wire(wire).expect("class")
}

// --- CPU rows ---

#[test]
fn the_presets_give_decals_their_class_caps() {
    // Plan A.10: on for every class, at most 64 on desktop and 16 on phones; none on the legacy
    // `off` quality (its lights are not binned).
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        for device in DeviceClass::ALL {
            let cap = if device.form == FormFactor::Mobile { MOBILE_DECALS } else { DESKTOP_DECALS };
            assert_eq!(preset_quality(preset, device).lights.decals, cap, "{preset:?} on {}", device.wire());
        }
    }
    assert_eq!((DESKTOP_DECALS, MOBILE_DECALS), (64, 16));
    assert_eq!(Quality::off().lights.decals, 0);
}

/// A decal over a `side`-wide box at `centre`, projecting along -y.
fn ground_decal(centre: [f32; 3], side: f32) -> Decal {
    Decal::new(Mat4::from_scale_rotation_translation(Vec3::new(side, 0.5, side), Quat::IDENTITY, Vec3::from(centre)).to_cols_array())
}

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 1.6, 4.0], [0.0, 1.2, -2.0])
}

#[test]
fn the_lights_bin_decals_after_the_lights_and_write_their_rows_in_binned_order() {
    // LG-16: decals are the second kind of the one binned index space; their rows are in the
    // order the bins sort them (by view depth), so the walk's index minus the kind's first is a row.
    let mut lighting = Lighting::default();
    for x in [-1.0_f32, 1.0] {
        lighting.points.push(PointLight { position: [x, 1.0, 0.0], range: 4.0, color: [255; 3], intensity: 1.0 });
    }
    lighting.decals = [-3.0_f32, -1.0, -2.0].iter().map(|z| ground_decal([0.0, 0.0, *z], 1.0)).collect();
    let quality = preset_quality(QualityPreset::High, class("desktop-high")).lights;
    let binned = binned_frame(&lighting, &quality, &camera(), (320, 180));
    assert_eq!(binned.bins.params.ranges, [2, 5, 5, 0], "two lights, then three decals, no probe");
    assert_eq!(binned.bins.first_index(ClusterKind::Decal), 2);
    assert_eq!(binned.decals.len(), 3);
    // The nearest decal (z = -1) first: its box's row maps its centre to the box's origin.
    for (row, decal_row) in binned.bins.decals.iter().zip(&binned.decals) {
        let centre = Vec3::new(0.0, 0.0, lighting.decals[*row as usize].model[14]);
        let local: Vec<f32> = decal_row.world_to_box.iter().map(|r| glam::Vec4::from(*r).dot(centre.extend(1.0))).collect();
        assert!(local.iter().all(|value| value.abs() < 1e-5), "row {row}: {local:?}");
    }
    let order: Vec<u32> = binned.bins.decals.clone();
    assert_eq!(order, [1, 2, 0], "sorted by view depth");
    // AAA review WP-15 flipped 4 * 4 -> 4 * 16: every shadow slot's matrix (spots, then point faces).
    assert_eq!(rows_base(2), 2 * 2 + 4 * 16, "after the lights' rows and every shadow slot's matrix");
}

#[test]
fn a_flat_decal_bins_the_tiles_of_its_box_not_of_its_sphere() {
    // A poster's box is flat: its sphere's tiles are about twice its own, and every pixel of a
    // tile walks it. Its tiles are its box corners' screen rectangle (within the sphere's), and
    // every point of the box lands in one of them.
    let mut lighting = Lighting::default();
    let poster = Mat4::from_scale_rotation_translation(Vec3::new(1.2, 0.2, 0.8), Quat::from_rotation_x(std::f32::consts::FRAC_PI_2), Vec3::new(0.4, 1.4, -2.0));
    lighting.decals.push(Decal::new(poster.to_cols_array()));
    let quality = preset_quality(QualityPreset::High, class("desktop-high")).lights;
    let render = (1920, 1080);
    let binned = binned_frame(&lighting, &quality, &camera(), render);
    let sphere = genex_render::cluster::LightBinFrame::prepare_clusterables(
        &[],
        &genex_render::cluster::ClusterInput { decals: &[lighting.decals[0].sphere()], probes: &[] },
        &camera(),
        render,
        &quality,
    );
    let rect = |row: [u32; 4]| [row[0] & 0xffff, row[0] >> 16, row[1] & 0xffff, row[1] >> 16];
    let tight = rect(binned.bins.bounds[0]);
    let loose = rect(sphere.bounds[0]);
    let area = |r: [u32; 4]| (r[2] - r[0] + 1) * (r[3] - r[1] + 1);
    assert!(tight[0] >= loose[0] && tight[1] >= loose[1] && tight[2] <= loose[2] && tight[3] <= loose[3], "{tight:?} within {loose:?}");
    assert!(area(tight) * 3 <= area(loose) * 2, "the box's tiles {tight:?} against the sphere's {loose:?}");
    assert_eq!(binned.bins.bounds[0][2], sphere.bounds[0][2], "the z-bins stay the sphere's");
    let tile = binned.bins.grid.tile_px as f32;
    for i in 0..=8 {
        for j in 0..=8 {
            for k in 0..=2 {
                let local = Vec3::new(i as f32 / 8.0 - 0.5, k as f32 / 2.0 - 0.5, j as f32 / 8.0 - 0.5);
                let (x, y) = project(&camera(), render, poster.transform_point3(local));
                let (tx, ty) = ((x / tile) as u32, (y / tile) as u32);
                assert!(tight[0] <= tx && tx <= tight[2] && tight[1] <= ty && ty <= tight[3], "box point {local} at tile ({tx}, {ty}) outside {tight:?}");
            }
        }
    }
}

#[test]
fn a_frame_without_decals_bins_exactly_as_before() {
    let mut lighting = Lighting::default();
    lighting.points.push(PointLight { position: [0.0, 1.0, 0.0], range: 4.0, color: [255; 3], intensity: 1.0 });
    let quality = preset_quality(QualityPreset::High, class("desktop-high")).lights;
    let binned = binned_frame(&lighting, &quality, &camera(), (320, 180));
    assert!(binned.decals.is_empty());
    assert_eq!(binned.bins.params.ranges, [1, 1, 1, 0]);
}

#[test]
fn the_cap_fades_decals_out_instead_of_popping() {
    // 80 decals along a street, a 64 cap: walking the camera along it, every decal's opacity
    // changes by a small step between two positions 5 cm apart, never from whole to none.
    let decals: Vec<Decal> = (0..80).map(|i| ground_decal([0.0, 0.0, -(i as f32) * 0.75], 0.5)).collect();
    let opacity_at = |z: f32| {
        let mut opacity = vec![0.0_f32; decals.len()];
        let kept = held_decals(&decals, 64, [0.0, 1.6, z]);
        assert!(kept.len() <= 64);
        for (decal, scale) in kept {
            let row = decals.iter().position(|d| d.model == decal.model).expect("a declared decal");
            opacity[row] = scale;
        }
        opacity
    };
    let mut last = opacity_at(4.0);
    let mut largest = 0.0_f32;
    for step in 1..400 {
        let next = opacity_at(4.0 - step as f32 * 0.05);
        for (a, b) in last.iter().zip(&next) {
            largest = largest.max((a - b).abs());
        }
        last = next;
    }
    assert!(largest < 0.35, "the largest opacity step between neighbouring camera positions: {largest}");
    assert!(held_decals(&decals, 0, [0.0; 3]).is_empty(), "a cap of 0 draws none");
}

fn parse(name: &str, source: &str) -> naga::Module {
    naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)))
}

fn validated(name: &str, module: &naga::Module) -> ModuleInfo {
    Validator::new(ValidationFlags::all(), Capabilities::CUBE_ARRAY_TEXTURES)
        .validate(module)
        .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"))
}

/// Storage buffers and sampled textures the fragment entry `entry` reads.
fn fragment_counts(module: &naga::Module, info: &ModuleInfo, entry: &str) -> (u32, u32) {
    let index = module.entry_points.iter().position(|point| point.name == entry).expect("entry point");
    let used = |handle: naga::Handle<naga::GlobalVariable>| !info.get_entry_point(index)[handle].is_empty();
    let mut counts = (0, 0);
    for (_, global) in module.global_variables.iter().filter(|(handle, global)| global.binding.is_some() && used(*handle)) {
        if matches!(global.space, naga::AddressSpace::Storage { .. }) {
            counts.0 += 1;
        }
        if matches!(module.types[global.ty].inner, naga::TypeInner::Image { .. }) {
            counts.1 += 1;
        }
    }
    counts
}

#[test]
fn the_forward_pass_and_the_v2_prelude_read_decals_without_a_binding_of_their_own() {
    // Plan section 2: decals take no sampled texture (their maps are layers of the material
    // arrays) and their rows ride in `light_ext`, so the forward stage keeps 6 storage buffers of 8
    // (A.7's terrain pipeline keeps its 8th) and the v2 map is unchanged.
    let forward = parse("forward", genex_render::shaders::FORWARD);
    let info = validated("forward", &forward);
    assert_eq!(fragment_counts(&forward, &info, "fs_main").0, 6, "storage buffers of the forward fragment stage");
    let constants: naga::back::PipelineConstants = [("GX_DECALS".to_owned(), 0.0)].into_iter().collect();
    naga::back::pipeline_constants::process_overrides(&forward, &info, None, &constants).expect("the forward pass declares GX_DECALS");
    let sample = parse("v2 sample", genex_render::shaders::MATERIAL_V2_SAMPLE);
    let sample_info = validated("v2 sample", &sample);
    naga::back::pipeline_constants::process_overrides(&sample, &sample_info, None, &constants).expect("the v2 prelude declares GX_DECALS");
}

// --- GPU rows ---

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// The HDR scene with desktop `high`'s binned lights, decals and textures, fixed exposure, every
/// screen effect off (so a frame's pixels depend on its surfaces alone).
fn decal_quality() -> Quality {
    let high = preset_quality(QualityPreset::High, class("desktop-high"));
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.lights = high.lights;
    quality.textures = high.textures;
    quality
}

fn renderer(gpu: &Gpu, (width, height): (u32, u32), quality: &Quality) -> genex_render::Renderer {
    let mut renderer = genex_render::Renderer::with_options(gpu, width, height, genex_render::RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(genex_render::settings::SceneFormat::Rgba16Float);
    renderer.set_device_class(class("desktop-high"));
    renderer.set_quality(quality);
    renderer
}

/// The wall the poster rows look at: a grey wall facing +z at z = -2, a floor, the sun from the
/// camera's side.
fn wall_scene(camera: CameraDesc) -> Scene {
    let mut scene = Scene::new(camera, [0, 0, 0, 255]);
    scene.lighting.sun_dir = [0.2, 0.6, 1.0];
    scene.lighting.sun_intensity = 3.0;
    scene.lighting.ambient_intensity = 0.3;
    scene.lighting.shadows = false;
    scene.draw(MeshId::CUBE, scaled([0.0, 2.0, -2.05], [8.0, 4.0, 0.1]), Material::color([150, 150, 150, 255]).with_pbr(0.0, 0.8));
    scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([120, 120, 120, 255]).with_pbr(0.0, 0.9));
    scene
}

/// A poster's box on the wall: `size` wide and high, centred at `centre` on the wall's face,
/// projecting into the wall (its local +y the wall's normal, +z), 0.4 deep.
fn poster_model(centre: [f32; 2], size: f32) -> [f32; 16] {
    Mat4::from_scale_rotation_translation(Vec3::new(size, 0.4, size), Quat::from_rotation_x(std::f32::consts::FRAC_PI_2), Vec3::new(centre[0], centre[1], -2.0)).to_cols_array()
}

fn red_poster(centre: [f32; 2], size: f32) -> Decal {
    Decal { color: [0.9, 0.05, 0.05], ..Decal::new(poster_model(centre, size)) }
}

fn radiance(gpu: &Gpu, renderer: &mut genex_render::Renderer, scene: &Scene, frames: u32) -> Vec<[f32; 4]> {
    for _ in 0..frames {
        renderer.render(gpu, scene, genex_render::CullPath::Gpu).expect("frame");
    }
    renderer.read_scene(gpu).expect("the HDR scene reads back")
}

fn write_evidence(name: &str, (width, height): (u32, u32), texels: &[[f32; 4]]) {
    let Ok(folder) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let encode = |value: f32| {
        let mapped = value.max(0.0) * 4.0 / (1.0 + value.max(0.0) * 4.0);
        (libm::powf(mapped, 1.0 / 2.2) * 255.0).round() as u8
    };
    let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
    bytes.extend(texels.iter().flat_map(|texel| [texel[0], texel[1], texel[2]].map(encode)));
    std::fs::create_dir_all(&folder).expect("evidence folder");
    std::fs::write(std::path::Path::new(&folder).join(format!("{name}.ppm")), bytes).expect("evidence written");
}

/// The pixel `world` lands on for `camera` drawing a `size` frame (rows top first).
fn project(camera: &CameraDesc, (width, height): (u32, u32), world: Vec3) -> (f32, f32) {
    let clip = camera.view_proj(width as f32 / height as f32) * world.extend(1.0);
    let ndc = clip.truncate() / clip.w;
    ((ndc.x * 0.5 + 0.5) * width as f32, (0.5 - ndc.y * 0.5) * height as f32)
}

fn red_share(texel: [f32; 4]) -> f32 {
    texel[0] / (texel[0] + texel[1] + texel[2]).max(1e-6)
}

/// The pixels whose red share marks them as the red poster's.
fn red_mask(texels: &[[f32; 4]]) -> Vec<bool> {
    texels.iter().map(|texel| red_share(*texel) > 0.6).collect()
}

const SIZE: (u32, u32) = (320, 180);

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_decal_colours_the_wall_inside_its_box_and_nothing_outside_it() {
    // Plan A.10: a poster on a wall. Inside its box the wall is red; every pixel the box does not
    // reach is the frame without the decal, bit for bit.
    let Some(gpu) = gpu() else { return };
    let quality = decal_quality();
    let poster = red_poster([0.0, 1.5], 1.0);
    let bare = radiance(&gpu, &mut renderer(&gpu, SIZE, &quality), &wall_scene(camera()), 2);
    let mut scene = wall_scene(camera());
    scene.lighting.decals.push(poster);
    let decorated = radiance(&gpu, &mut renderer(&gpu, SIZE, &quality), &scene, 2);
    write_evidence("decal-poster-bare", SIZE, &bare);
    write_evidence("decal-poster", SIZE, &decorated);
    let (cx, cy) = project(&camera(), SIZE, Vec3::new(0.0, 1.5, -2.0));
    let centre = decorated[(cy as u32 * SIZE.0 + cx as u32) as usize];
    assert!(red_share(centre) > 0.75, "the poster's centre is red: {centre:?}");
    // The box's corners on screen, grown by two pixels: outside them nothing changed.
    let corners: Vec<(f32, f32)> = [(-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)]
        .iter()
        .flat_map(|(x, y)| [-1.8_f32, -2.2].map(|z| project(&camera(), SIZE, Vec3::new(*x, 1.5 + *y, z))))
        .collect();
    let (x0, x1) = (corners.iter().map(|c| c.0).fold(f32::MAX, f32::min) - 2.0, corners.iter().map(|c| c.0).fold(f32::MIN, f32::max) + 2.0);
    let (y0, y1) = (corners.iter().map(|c| c.1).fold(f32::MAX, f32::min) - 2.0, corners.iter().map(|c| c.1).fold(f32::MIN, f32::max) + 2.0);
    let mut changed_outside = 0;
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let inside = (x0..=x1).contains(&(x as f32)) && (y0..=y1).contains(&(y as f32));
            let i = (y * SIZE.0 + x) as usize;
            if !inside && bare[i] != decorated[i] {
                changed_outside += 1;
            }
        }
    }
    assert_eq!(changed_outside, 0, "pixels changed outside the decal's box");
}

/// A floor of `cells` x `cells` quads (8 m square, facing up): the same surface as the cube's top
/// face, tessellated `cells` times finer.
fn tessellated_floor(cells: u32) -> genex_render::mesh::MeshData {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for j in 0..=cells {
        for i in 0..=cells {
            let (u, v) = (i as f32 / cells as f32, j as f32 / cells as f32);
            vertices.push(genex_render::mesh::Vertex { position: [u - 0.5, 0.0, v - 0.5], normal: [0.0, 1.0, 0.0], uv: [u, v], tangent: [1.0, 0.0, 0.0, 1.0] });
        }
    }
    let row = cells + 1;
    for j in 0..cells {
        for i in 0..cells {
            let a = j * row + i;
            indices.extend([a, a + row, a + 1, a + 1, a + row, a + row + 1]);
        }
    }
    genex_render::mesh::MeshData { vertices, indices }
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_decal_follows_its_surface_whatever_the_mesh_that_draws_it() {
    // Plan A.10's "no LOD swim": a decal is a function of the surface's world position, so the
    // same floor drawn as one quad or as a 64 x 64 grid (a coarse and a fine level of detail)
    // shows the same decal, pixel for pixel within the rasterizer's rounding.
    let Some(gpu) = gpu() else { return };
    let quality = decal_quality();
    let camera = CameraDesc::look_at([0.0, 2.5, 3.0], [0.0, 0.0, -1.0]);
    let mut masks = Vec::new();
    for cells in [1_u32, 64] {
        let mut renderer = renderer(&gpu, SIZE, &quality);
        let floor = renderer.add_mesh(&gpu, tessellated_floor(cells)).expect("floor");
        let mut scene = Scene::new(camera, [0, 0, 0, 255]);
        scene.lighting.sun_dir = [0.2, 1.0, 0.4];
        scene.lighting.shadows = false;
        scene.draw(floor, scaled([0.0, 0.0, 0.0], [8.0, 1.0, 8.0]), Material::color([140, 140, 140, 255]).with_pbr(0.0, 0.9));
        let mut decal = ground_decal([0.3, 0.0, -0.7], 1.3);
        decal.color = [0.9, 0.05, 0.05];
        decal.model = (Mat4::from_cols_array(&decal.model) * Mat4::from_rotation_y(0.6)).to_cols_array();
        scene.lighting.decals.push(decal);
        let texels = radiance(&gpu, &mut renderer, &scene, 2);
        write_evidence(&format!("decal-floor-{cells}"), SIZE, &texels);
        masks.push(red_mask(&texels));
    }
    let covered = masks[0].iter().filter(|red| **red).count();
    let differing = masks[0].iter().zip(&masks[1]).filter(|(a, b)| a != b).count();
    eprintln!("decal pixels {covered}, differing between the coarse and the fine floor {differing}");
    assert!(covered > 2000, "the decal is drawn: {covered} pixels");
    assert!(differing * 200 <= covered, "the decal moved with the mesh: {differing} of {covered} pixels differ");
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_decal_stays_on_its_wall_as_the_camera_moves() {
    // No swim and no z-fight: as the camera pans and dollies, the poster's red pixels stay
    // centred on the projection of its box's centre (within half a pixel), with no frame that
    // loses part of the poster to the wall.
    let Some(gpu) = gpu() else { return };
    let quality = decal_quality();
    let mut renderer = renderer(&gpu, SIZE, &quality);
    let mut worst = 0.0_f32;
    let mut areas = Vec::new();
    for step in 0..12 {
        let t = step as f32 / 11.0;
        let camera = CameraDesc::look_at([-1.0 + 2.0 * t, 1.6, 4.0 - t], [0.0, 1.4, -2.0]);
        let mut scene = wall_scene(camera);
        scene.lighting.decals.push(red_poster([0.0, 1.5], 1.0));
        let texels = radiance(&gpu, &mut renderer, &scene, 1);
        let mask = red_mask(&texels);
        let (mut sx, mut sy, mut n) = (0.0_f64, 0.0_f64, 0.0_f64);
        for (i, red) in mask.iter().enumerate() {
            if *red {
                sx += (i as u32 % SIZE.0) as f64 + 0.5;
                sy += (i as u32 / SIZE.0) as f64 + 0.5;
                n += 1.0;
            }
        }
        // The square's centroid on screen: the mean of its four projected corners' polygon is
        // not the projected centre under perspective, so compare with the projected corners'
        // area-weighted centroid computed the same way over a fine grid of the square.
        let mut expected = (0.0_f64, 0.0_f64);
        let samples = 64;
        let mut weight = 0.0;
        for j in 0..samples {
            for i in 0..samples {
                let p = Vec3::new(-0.5 + (i as f32 + 0.5) / samples as f32, 1.0 + (j as f32 + 0.5) / samples as f32, -2.0);
                let (x, y) = project(&camera, SIZE, p);
                // Each sample weighs its projected area (the perspective divide squared).
                let w = 1.0 / f64::from((camera.view_proj(SIZE.0 as f32 / SIZE.1 as f32) * p.extend(1.0)).w).powi(2);
                expected.0 += f64::from(x) * w;
                expected.1 += f64::from(y) * w;
                weight += w;
            }
        }
        let offset = (((sx / n) - expected.0 / weight).powi(2) + ((sy / n) - expected.1 / weight).powi(2)).sqrt() as f32;
        worst = worst.max(offset);
        areas.push(n);
    }
    eprintln!("worst centroid offset {worst:.3} px, poster areas {areas:?}");
    assert!(worst < 0.5, "the poster drifted {worst} px from its box");
    assert!(areas.iter().all(|area| *area > 1000.0), "every frame shows the poster: {areas:?}");
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_puddle_decal_changes_roughness_and_leaves_the_colour() {
    // A puddle: no colour change (albedo mix 0), roughness 0.05 and metallic 0. The rough floor
    // turns glossy where it lies: its reflection of the bright sky differs from the bare floor,
    // and the floor's colour outside stays bit for bit.
    let Some(gpu) = gpu() else { return };
    let quality = decal_quality();
    let camera = CameraDesc::look_at([0.0, 1.2, 3.0], [0.0, 0.0, -2.0]);
    let floor_scene = |puddle: bool| {
        let mut scene = Scene::new(camera, [0, 0, 0, 255]);
        scene.lighting.sun_dir = [0.0, 0.35, -1.0];
        scene.lighting.sun_intensity = 4.0;
        scene.lighting.shadows = false;
        scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([90, 90, 95, 255]).with_pbr(0.0, 0.9));
        if puddle {
            let mut decal = ground_decal([0.0, 0.0, -1.0], 1.5);
            decal.albedo_mix = 0.0;
            decal.roughness = Some(0.05);
            decal.metallic = Some(0.0);
            scene.lighting.decals.push(decal);
        }
        scene
    };
    let bare = radiance(&gpu, &mut renderer(&gpu, SIZE, &quality), &floor_scene(false), 2);
    let wet = radiance(&gpu, &mut renderer(&gpu, SIZE, &quality), &floor_scene(true), 2);
    write_evidence("decal-puddle", SIZE, &wet);
    let (cx, cy) = project(&camera, SIZE, Vec3::new(0.0, 0.0, -1.0));
    let i = (cy as u32 * SIZE.0 + cx as u32) as usize;
    let luminance = |t: [f32; 4]| 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
    eprintln!("puddle centre {:?} against bare {:?}", wet[i], bare[i]);
    assert!(luminance(wet[i]) > 1.5 * luminance(bare[i]), "the puddle mirrors the low sun: {:?} against {:?}", wet[i], bare[i]);
    let (corner_x, corner_y) = project(&camera, SIZE, Vec3::new(3.0, 0.0, 1.0));
    let outside = (corner_y as u32 * SIZE.0 + corner_x as u32) as usize;
    assert_eq!(wet[outside], bare[outside], "the floor outside the puddle is unchanged");
}

/// A 256 x 256 tangent-space normal map of ridges along u (32 across), OpenGL convention.
fn ridges_texture() -> TextureData {
    let side = 256_u32;
    let mut rgba = Vec::with_capacity((side * side * 4) as usize);
    for _y in 0..side {
        for x in 0..side {
            let slope = libm::sinf(x as f32 / side as f32 * std::f32::consts::TAU * 32.0) * 0.6;
            let n = Vec3::new(slope, 0.0, 1.0).normalize();
            rgba.extend([n.x, n.y, n.z].map(|c| ((c * 0.5 + 0.5) * 255.0).round() as u8));
            rgba.push(255);
        }
    }
    TextureData::rgba8(side, side, rgba).expect("ridges")
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_flattening_decal_smooths_the_surface_s_own_bumps() {
    // A puddle's film is flat over a ridged road: with `flatten` 1 the floor's normal map no longer
    // ripples the puddle's light (its pixels' spread falls), without it the ridges show through.
    let Some(gpu) = gpu() else { return };
    let quality = decal_quality();
    let camera = CameraDesc::look_at([0.0, 1.2, 3.0], [0.0, 0.0, -2.0]);
    let spread = |flatten: f32| {
        let mut renderer = renderer(&gpu, SIZE, &quality);
        let ridges = renderer.add_texture(&gpu, &ridges_texture(), TextureKind::Normal).expect("ridges");
        let mut scene = Scene::new(camera, [0, 0, 0, 255]);
        scene.lighting.sun_dir = [0.6, 0.5, -0.4];
        scene.lighting.sun_intensity = 4.0;
        scene.lighting.shadows = false;
        scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([90, 90, 95, 255]).with_pbr(0.0, 0.6).with_normal_map(ridges, 1.0));
        let mut decal = ground_decal([0.0, 0.0, -1.0], 1.5);
        decal.albedo_mix = 0.0;
        decal.flatten = flatten;
        scene.lighting.decals.push(decal);
        let texels = radiance(&gpu, &mut renderer, &scene, 2);
        write_evidence(&format!("decal-flatten-{flatten}"), SIZE, &texels);
        // The mean step of the puddle's luminance between neighbouring pixels (across and down),
        // over its mean: the ridges' ripple, not the light's slow fall across the puddle.
        let (cx, cy) = project(&camera, SIZE, Vec3::new(0.0, 0.0, -1.0));
        let at = |dx: i32, dy: i32| {
            let t = texels[((cy as i32 + dy) as u32 * SIZE.0 + (cx as i32 + dx) as u32) as usize];
            0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]
        };
        let (mut steps, mut sum) = (0.0_f32, 0.0_f32);
        for dy in -10..10 {
            for dx in -30..30 {
                steps += (at(dx + 1, dy) - at(dx, dy)).abs() + (at(dx, dy + 1) - at(dx, dy)).abs();
                sum += at(dx, dy);
            }
        }
        steps / sum.max(1e-6)
    };
    let (bumpy, flat) = (spread(0.0), spread(1.0));
    eprintln!("the puddle's ripple (mean neighbour step over the mean): ridged {bumpy:.4}, flattened {flat:.4}");
    assert!(flat * 5.0 < bumpy, "the flattened puddle hides the ridges: {flat} against {bumpy}");
}

/// A `side` x `side` sRGB texture: a red disc of radius side / 3 on clear, its edge antialiased.
fn disc_texture(side: u32) -> TextureData {
    let mut rgba = Vec::with_capacity((side * side * 4) as usize);
    let r = side as f32 / 3.0;
    for y in 0..side {
        for x in 0..side {
            let d = libm::hypotf(x as f32 + 0.5 - side as f32 / 2.0, y as f32 + 0.5 - side as f32 / 2.0);
            let alpha = (r - d + 0.5).clamp(0.0, 1.0);
            rgba.extend([230, 30, 30, (alpha * 255.0).round() as u8]);
        }
    }
    TextureData::rgba8(side, side, rgba).expect("disc")
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_textured_decal_takes_its_shape_from_its_base_colour_alpha_in_its_own_size_class() {
    // The decal's texture is a layer of the material arrays: a 512 source lands in the 512 class
    // (texture quality on) behind a 256-class texture, and the decal samples its own layer: a red
    // disc whose clear corners leave the wall as it was.
    let Some(gpu) = gpu() else { return };
    let quality = decal_quality();
    let bare = radiance(&gpu, &mut renderer(&gpu, SIZE, &quality), &wall_scene(camera()), 2);
    let mut renderer = renderer(&gpu, SIZE, &quality);
    let _other = renderer.add_texture(&gpu, &TextureData::rgba8(256, 256, vec![40; 256 * 256 * 4]).expect("filler"), TextureKind::Color).expect("filler");
    let disc = renderer.add_texture(&gpu, &disc_texture(512), TextureKind::Color).expect("disc");
    assert_eq!(disc.class(), genex_render::settings::TextureClass::S512, "the disc lands in the 512 class");
    let mut scene = wall_scene(camera());
    scene.lighting.decals.push(Decal::new(poster_model([0.0, 1.5], 1.2)).with_albedo(disc));
    let texels = radiance(&gpu, &mut renderer, &scene, 2);
    write_evidence("decal-disc", SIZE, &texels);
    let at = |x: f32, y: f32| {
        let (px, py) = project(&camera(), SIZE, Vec3::new(x, y, -2.0));
        (py as u32 * SIZE.0 + px as u32) as usize
    };
    assert!(red_share(texels[at(0.0, 1.5)]) > 0.75, "the disc's centre: {:?}", texels[at(0.0, 1.5)]);
    let corner = at(-0.52, 2.02);
    assert_eq!(texels[corner], bare[corner], "the clear corner leaves the wall");
}

/// A v2 material shading its tint through the renderer's own lighting (`gx_shade_pbr`).
const SHADED_V2: &str = "
@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, in.tint.rgb, 0.0, 0.8);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_v2_material_takes_decals_through_the_shared_chunk() {
    // Plan A.10: the Level-2 v2 prelude sees decals through the shared lighting chunk
    // (`gx_shade_pbr` applies `gx_decals` before any light): a red poster on a wall drawn with a v2
    // material is red. A decal whose map lives in a size class a v2 material does not bind (the
    // 512 disc) reaches the built-in wall beside it, not the v2 wall.
    let Some(gpu) = gpu() else { return };
    let quality = decal_quality();
    let mut renderer = genex_render::FrameRenderer::new(&gpu, SIZE.0, SIZE.1, genex_render::RenderOptions { msaa: false }).expect("renderer");
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(genex_render::settings::SceneFormat::Rgba16Float);
    part1.set_device_class(class("desktop-high"));
    part1.set_quality(&quality);
    let disc = part1.add_texture(&gpu, &disc_texture(512), TextureKind::Color).expect("disc");
    let shaded = renderer.add_material_api(&gpu, genex_render::abi::ABI_V2, SHADED_V2, &[], &[]).expect("a v2 material");
    let mut frame = genex_render::immediate::ImmediateFrame::new(camera(), [0, 0, 0, 255]);
    {
        let lighting = frame.lighting_mut();
        lighting.sun_dir = [0.2, 0.6, 1.0];
        lighting.sun_intensity = 3.0;
        lighting.ambient_intensity = 0.3;
        lighting.shadows = false;
        lighting.decals.push(red_poster([-1.2, 1.5], 0.8));
        lighting.decals.push(red_poster([1.2, 1.5], 0.8));
        lighting.decals.push(Decal::new(poster_model([1.2, 3.0], 0.8)).with_albedo(disc));
        lighting.decals.push(Decal::new(poster_model([-1.2, 3.0], 0.8)).with_albedo(disc));
    }
    // The left half of the wall is the v2 material, the right half built in.
    frame.custom(MeshId::CUBE, scaled([-2.0, 2.0, -2.05], [4.0, 4.0, 0.1]), shaded, [150, 150, 150, 255]);
    frame.mesh(MeshId::CUBE, scaled([2.0, 2.0, -2.05], [4.0, 4.0, 0.1]), Material::color([150, 150, 150, 255]).with_pbr(0.0, 0.8));
    for _ in 0..2 {
        renderer.render(&gpu, &frame, genex_render::CullPath::Gpu, None).expect("frame");
    }
    let capture = renderer.capture(&gpu).expect("capture");
    let red_at = |x: f32, y: f32| {
        let (px, py) = project(&camera(), SIZE, Vec3::new(x, y, -2.0));
        let i = ((py as u32 * SIZE.0 + px as u32) * 4) as usize;
        let [b, g, r] = [capture.bgra()[i], capture.bgra()[i + 1], capture.bgra()[i + 2]];
        f32::from(r) / (f32::from(r) + f32::from(g) + f32::from(b)).max(1.0)
    };
    if let Ok(folder) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let mut bytes = format!("P6\n{} {}\n255\n", SIZE.0, SIZE.1).into_bytes();
        bytes.extend(capture.bgra().chunks(4).flat_map(|texel| [texel[2], texel[1], texel[0]]));
        std::fs::create_dir_all(&folder).expect("evidence folder");
        std::fs::write(std::path::Path::new(&folder).join("decal-v2.ppm"), bytes).expect("evidence written");
    }
    let (v2, built_in) = (red_at(-1.2, 1.5), red_at(1.2, 1.5));
    eprintln!("red share: v2 wall {v2:.3}, built-in wall {built_in:.3}; discs: v2 {:.3}, built-in {:.3}", red_at(-1.2, 3.0), red_at(1.2, 3.0));
    assert!(v2 > 0.6 && built_in > 0.6, "both walls take the poster: v2 {v2}, built-in {built_in}");
    assert!(red_at(1.2, 3.0) > 0.6, "the 512 disc reaches the built-in wall");
    assert!(red_at(-1.2, 3.0) < 0.4, "the v2 wall binds class 0 only: no disc");
}

/// Which maps the cost rows' decals carry.
#[derive(Clone, Copy, Debug)]
enum Maps {
    None,
    Albedo,
    All,
    /// No map, turned away from every surface it covers (the walk and the box test alone).
    Faded,
    /// No map, floating in front of the wall (binned, never walked: the binning alone).
    Floating,
}

/// The GPU time `count` decals (32 on the wall, the rest on the floor, each with `maps`) add to a
/// 1080p frame of desktop high's lights and textures that sees them all (and a lamp), against the
/// same frame without them: frame by frame interleaved (A, B, A, B, ..) so the host's other GPU work lands on
/// both, the median of 8 rounds' differences of median frame times. `None` without timestamps.
fn decal_cost(gpu: &Gpu, maps: Maps, count: usize) -> Option<DecalCost> {
    let quality = decal_quality();
    let (width, height) = (1920, 1080);
    let mut renderers = [renderer(gpu, (width, height), &quality), renderer(gpu, (width, height), &quality)];
    let mut ids = Vec::new();
    for renderer in &mut renderers {
        let albedo = renderer.add_texture(gpu, &disc_texture(512), TextureKind::Color).expect("albedo");
        let flat = TextureData::rgba8(512, 512, [128_u8, 128, 255, 255].repeat(512 * 512)).expect("normal");
        let normal = renderer.add_texture(gpu, &flat, TextureKind::Normal).expect("normal");
        let orm = renderer.add_texture(gpu, &TextureData::rgba8(512, 512, [255_u8, 60, 0, 255].repeat(512 * 512)).expect("orm"), TextureKind::Data).expect("orm");
        ids.push((albedo, normal, orm));
    }
    let wide = CameraDesc::look_at([0.0, 1.6, 4.0], [0.0, 1.0, -2.0]);
    let mut scenes = [wall_scene(wide), wall_scene(wide)];
    // A lamp by the wall in both frames, so both bin (graph node 4 runs in both): the difference
    // is the decals' binning and shading alone.
    for scene in &mut scenes {
        scene.lighting.points.push(PointLight { position: [0.0, 2.0, -1.5], range: 3.0, color: [255, 230, 200], intensity: 2.0 });
    }
    let (albedo, normal, orm) = ids[1];
    for i in 0..count {
        let (col, row) = ((i % 8) as f32, (i / 8) as f32);
        let decal = if i < 32 {
            Decal::new(poster_model([-3.0 + col * 0.85, 0.4 + row * 0.85], 0.8))
        } else {
            ground_decal([-3.0 + col * 0.85, 0.0, -1.6 + (row - 4.0) * 0.8], 0.8)
        };
        let decal = match maps {
            Maps::None => decal.with_surface(Some(0.3), None),
            Maps::Faded => Decal { angle_fade: [0.0, 0.0], ..decal.with_surface(Some(0.3), None) },
            Maps::Floating => {
                let mut model = decal.model;
                model[14] += 3.0;
                model[13] += 0.6;
                Decal { model, ..decal }
            }
            Maps::Albedo => decal.with_albedo(albedo),
            Maps::All => decal.with_albedo(albedo).with_normal(normal, 1.0).with_orm(orm).with_surface(Some(0.3), None),
        };
        scenes[1].lighting.decals.push(decal);
    }
    let median = |values: &mut Vec<f32>| {
        values.sort_by(f32::total_cmp);
        values[values.len() / 2]
    };
    // The lower decile of a round's frame times: the host's other GPU work only ever adds time.
    let decile = |values: &mut Vec<f32>| {
        values.sort_by(f32::total_cmp);
        values[values.len() / 10]
    };
    let mut deltas = Vec::new();
    let mut low_deltas = Vec::new();
    for round in 0..9 {
        let mut times = [Vec::new(), Vec::new()];
        // Submitted back to back, as a game's frames are (a GPU left idle between frames clocks
        // down, and the cost of a pass doubles with it); the last frames wait, so the earlier
        // frames' times land.
        for frame in 0..80_u64 {
            for k in 0..2 {
                times[k].extend(renderers[k].arm_frame_timer(&gpu.queue)?);
                renderers[k].set_frame_index(frame);
                renderers[k].render(gpu, &scenes[k], genex_render::CullPath::Gpu).expect("frame");
                renderers[k].finish_frame_timer();
                let poll = if frame >= 72 { wgpu::PollType::wait_indefinitely() } else { wgpu::PollType::Poll };
                let _ = gpu.device.poll(poll);
            }
        }
        let [mut bare, mut decorated] = times.map(|mut landed| {
            landed.drain(..8.min(landed.len()));
            landed
        });
        if round > 0 {
            let (bare_ms, decorated_ms) = (median(&mut bare), median(&mut decorated));
            let (bare_low, decorated_low) = (decile(&mut bare), decile(&mut decorated));
            eprintln!("round {round}: bare {bare_ms:.3} ms (p10 {bare_low:.3}), with decals {decorated_ms:.3} ms (p10 {decorated_low:.3})");
            deltas.push(decorated_ms - bare_ms);
            low_deltas.push(decorated_low - bare_low);
        }
    }
    if std::env::var("GENEX_RENDER_EVIDENCE_DIR").is_ok() {
        let texels = renderers[1].read_scene(gpu).expect("the HDR scene reads back");
        write_evidence(&format!("decals-{count}-{maps:?}-1080p"), (width, height), &texels);
    }
    Some(DecalCost { median: median(&mut deltas.clone()), low: median(&mut low_deltas.clone()), deltas, low_deltas })
}

/// What decals add to a frame ([`decal_cost`]): the median over rounds of the difference of the
/// rounds' median frame times, and of their lower-decile frame times (the cost with the host's
/// other GPU work taken out), with each round's differences.
struct DecalCost {
    median: f32,
    low: f32,
    deltas: Vec<f32>,
    low_deltas: Vec<f32>,
}

fn perf_row(gpu: &Gpu, name: &str, cost: &DecalCost) {
    let row = format!(
        "{{\"row\":\"{name}\",\"adapter\":\"{}\",\"addedMedianMs\":{:.4},\"addedLowDecileMs\":{:.4},\"deltasMs\":{:?},\"lowDeltasMs\":{:?}}}",
        gpu.receipt().adapter,
        cost.median,
        cost.low,
        cost.deltas,
        cost.low_deltas
    );
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
        writeln!(file, "{row}").expect("perf row");
    }
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_64_textured_decals_in_view_cost_at_most_0_3_ms_at_1080p() {
    // Plan A.10: <= 0.3 ms at 64 decals in view: base colour, normal and ORM maps of the 512
    // class, covering the whole 1080p frame (every pixel under one decal or two).
    let Some(gpu) = gpu() else { return };
    let Some(cost) = decal_cost(&gpu, Maps::All, 64) else {
        eprintln!("skipped: no timestamp queries");
        return;
    };
    perf_row(&gpu, "decals-64-all-maps-1080p", &cost);
    // Asserted on the lower decile: the Mac is shared by the lanes' GPU tests (the median is
    // recorded beside it).
    assert!(cost.low <= 0.3, "64 decals add {:.3} ms (lower decile; median {:.3} ms)", cost.low, cost.median);
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_decal_cost_breakdown_at_1080p() {
    // Informational: what the walk, the base colour and the other maps each cost.
    let Some(gpu) = gpu() else { return };
    let variants: Vec<(Maps, usize)> = match std::env::var("GENEX_DECAL_COST_VARIANTS").as_deref() {
        Ok("faded") => vec![(Maps::Faded, 64)],
        _ => vec![(Maps::Floating, 64), (Maps::Faded, 64), (Maps::None, 64), (Maps::Albedo, 64), (Maps::All, 64), (Maps::All, 16)],
    };
    for (maps, count) in variants {
        let Some(cost) = decal_cost(&gpu, maps, count) else { return };
        perf_row(&gpu, &format!("decals-{count}-{maps:?}-1080p"), &cost);
    }
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_buffer_model_counts_the_decal_rows_in_the_light_table() {
    // A.10 integration: a frame's decals ride in the `light_ext` table after every light's rows
    // and every shadowed spot's matrix slot, so the budget's model of the frame's buffers grows by
    // at least their rows (it counted the lights' rows alone before).
    let Some(gpu) = gpu() else { return };
    let quality = decal_quality();
    let renderer = renderer(&gpu, SIZE, &quality);
    let bare = wall_scene(camera());
    let mut decorated = wall_scene(camera());
    let posters = 16;
    for i in 0..posters {
        decorated.lighting.decals.push(red_poster([-3.5 + 0.45 * i as f32, 1.5], 0.4));
    }
    let model_bare = renderer.buffer_model(&bare).expect("model");
    let model_decorated = renderer.buffer_model(&decorated).expect("model");
    let rows = (posters * genex_render::decals::DECAL_ROW_VEC4S * 16) as u64;
    assert!(model_decorated >= model_bare + rows, "the model grows by the {posters} decals' rows: {model_bare} -> {model_decorated} (want at least +{rows})");
}
