//! GA1 (renderer pass 2, Stage A wave 4): settled Studio captures drew a different picture from
//! one presenter to the next because screen derivatives over sub-pixel geometry came out
//! differently from run to run on Apple GPUs: the terrain prepass's footprint (which pyramid level
//! its far-ground normals came from) and the grass's (how much of a far flower shows). Those
//! footprints are worked out from the projection instead; these rows hold that. Alpha-tested
//! foliage's hashed threshold still takes them (`alpha_mask.wgsl`): the open source.
//!
//! The settled-capture row itself is `examples/showcase/tests/shots.rs`
//! (`metal_every_studio_capture_draws_the_hdr_look_the_same_twice`).

use genex_render::foliage::gpu::{GRASS, pixel_at_unit_depth};
use genex_render::terrain::gpu::TERRAIN;

/// The functions `block` calls, its nested blocks' included.
fn calls(block: &naga::Block, out: &mut Vec<naga::Handle<naga::Function>>) {
    for statement in block.iter() {
        match statement {
            naga::Statement::Call { function, .. } => out.push(*function),
            naga::Statement::Block(inner) => calls(inner, out),
            naga::Statement::If { accept, reject, .. } => {
                calls(accept, out);
                calls(reject, out);
            }
            naga::Statement::Loop { body, continuing, .. } => {
                calls(body, out);
                calls(continuing, out);
            }
            naga::Statement::Switch { cases, .. } => cases.iter().for_each(|case| calls(&case.body, out)),
            _ => {}
        }
    }
}

fn derives(function: &naga::Function) -> bool {
    function.expressions.iter().any(|(_, expression)| matches!(expression, naga::Expression::Derivative { .. }))
}

/// The functions entry point `entry` of `module` reaches (itself first, by name) that take a
/// screen derivative.
fn derivatives_reached(module: &naga::Module, entry: &str) -> Vec<String> {
    let point = module.entry_points.iter().find(|point| point.name == entry).unwrap_or_else(|| panic!("no entry point {entry}"));
    let mut found = Vec::new();
    if derives(&point.function) {
        found.push(entry.to_owned());
    }
    let mut pending = Vec::new();
    calls(&point.function.body, &mut pending);
    let mut seen = std::collections::BTreeSet::new();
    while let Some(handle) = pending.pop() {
        if !seen.insert(handle.index()) {
            continue;
        }
        let function = &module.functions[handle];
        if derives(function) {
            found.push(function.name.clone().unwrap_or_default());
        }
        calls(&function.body, &mut pending);
    }
    found
}

/// The terrain's depth and normal prepasses (its world pass keeps its screen derivatives: cost)
/// and every grass entry point.
#[test]
fn the_terrain_prepasses_and_the_grass_take_no_screen_derivative() {
    let rows: [(&str, &str, &[&str]); 2] =
        [("terrain", TERRAIN, &["fs_terrain_prepass", "fs_terrain_motion"]), ("grass", GRASS, &["fs_grass", "fs_grass_prepass", "fs_grass_motion"])];
    for (name, source, entries) in rows {
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {error}"));
        for entry in entries {
            let reached = derivatives_reached(&module, entry);
            assert!(reached.is_empty(), "{name} {entry}: {reached:?} take a screen derivative");
        }
    }
}

#[test]
fn a_pixel_at_unit_depth_is_two_over_the_y_scale_and_the_height_whatever_the_view() {
    let height = 720;
    let perspective = glam::camera::rh::proj::directx::perspective_infinite_reverse(50f32.to_radians(), 16.0 / 9.0, 0.1);
    let orthographic = glam::camera::rh::proj::directx::orthographic(-8.0, 8.0, -4.5, 4.5, 0.1, 100.0);
    for proj in [perspective, orthographic] {
        let expected = 2.0 / (proj.y_axis.y * height as f32);
        for (eye, target) in [(glam::Vec3::ZERO, glam::Vec3::NEG_Z), (glam::Vec3::new(3.0, 2.0, 1.0), glam::Vec3::new(-4.0, 0.5, -6.0)), (glam::Vec3::new(0.0, 9.0, 0.0), glam::Vec3::new(0.5, 0.0, 0.2))] {
            let view = glam::camera::rh::view::look_at_mat4(eye, target, glam::Vec3::Y);
            let pixel = pixel_at_unit_depth(&(proj * view).to_cols_array(), height);
            assert!((pixel - expected).abs() <= expected * 1e-5, "{pixel} != {expected} looking from {eye} at {target}");
        }
    }
}
