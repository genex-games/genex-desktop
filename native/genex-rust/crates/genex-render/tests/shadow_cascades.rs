//! RQ3.1: cascades 1-4 with stable fitting. CPU rows hold the fitter (texel snapping under
//! sub-texel camera steps, a texel size that a turning camera keeps bit for bit, monotone splits
//! ending at the shadow distance, receiver-tight light depth, pancaking's open near plane), the
//! far-cascade cadence across frames (a camera cut redraws held cascades) and the maps' bytes
//! against the budget ledger. The GPU rows are `#[ignore]`d and their names contain `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test shadow_cascades -- --ignored metal
//!
//! (the cost row's p95 gates need `--release`). They render through the real renderer and shader: a caster nearer the sun than the cascade's
//! near plane still shadows (pancaking in `vs_shadow`), the 1- and 4-cascade goldens, Depth16
//! against Depth32, the cadence's skipped passes and the 1080p cost against the RQ3 budget.

use genex_render::budget::{BudgetInput, BudgetKind, ledger};
use genex_render::capture::Capture;
use genex_render::cull::in_frustum;
use genex_render::layout::{MAX_CASCADES, SHADOW_CASCADES};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, PlanOptions, Scene, scaled, translation};
use genex_render::settings::{Quality, SceneFormat, ShadowFilter, ShadowFormat, ShadowSettings, SkyParams};
use genex_render::shadow::{CASTER_REACH, CascadeHistory, Cascades, DEPTH_BIAS, SHADOW_MAP_PX, ShadowMapDesc, cascades, fit, keeps_legacy_fit, split_depths};
use genex_render::{CullPath, Gpu, Renderer};
use glam::{Mat4, Vec3, Vec4};

const ASPECT: f32 = 16.0 / 9.0;
const SUN: [f32; 3] = [0.5, 1.0, 0.35];
const DISTANCE: f32 = 40.0;
/// A projected origin is a whole texel within this (f32 rounding of a product of matrices).
const WHOLE_TEXEL: f32 = 1e-2;

fn settings(count: u8, map_px: u32) -> ShadowSettings {
    let mut quality = Quality::off().shadows;
    quality.cascades = count;
    quality.map_size = map_px;
    ShadowSettings::from_quality(&quality, DISTANCE, SkyParams::default().sun_angular_radius)
}

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.0, -4.0])
}

/// Where the world origin lands in cascade `c`'s map, in texels from the map's centre.
fn origin_texels(set: &Cascades, c: usize) -> [f32; 2] {
    let half = set.map_px as f32 * 0.5;
    [set.view_proj[c][12] * half, set.view_proj[c][13] * half]
}

fn assert_whole(value: f32, what: &str) {
    assert!((value - value.round()).abs() < WHOLE_TEXEL, "{what}: {value} is not a whole texel");
}

/// Every fit under test: the legacy two, and 1 to 4 tight cascades at two map sizes.
fn fits(camera: &CameraDesc, bounds: &[[f32; 4]]) -> Vec<(String, Cascades)> {
    let mut sets = vec![("legacy".to_owned(), cascades(camera, ASPECT, SUN, DISTANCE))];
    for count in 1..=MAX_CASCADES as u8 {
        for map_px in [1536, 2048] {
            sets.push((format!("{count}x{map_px}"), fit(camera, ASPECT, SUN, &settings(count, map_px), bounds.iter().copied())));
        }
    }
    sets
}

#[test]
fn sub_texel_camera_steps_move_each_cascades_map_only_in_whole_texels() {
    let start = camera();
    let base = fits(&start, &[]);
    let finest = base.iter().map(|(_, set)| set.texel_world[0]).fold(f32::INFINITY, f32::min);
    let mut moved = vec![false; base.len()];
    for step in 1..=48 {
        // A step of 0.37 of the finest texel, sideways and forward: most frames move by less
        // than a texel in every cascade.
        let shift = Vec3::new(0.37, 0.05, -0.21) * finest * step as f32;
        let mut camera = start;
        camera.eye = (Vec3::from(start.eye) + shift).to_array();
        camera.target = (Vec3::from(start.target) + shift).to_array();
        for (i, ((name, set), (_, first))) in fits(&camera, &[]).iter().zip(&base).enumerate() {
            for c in 0..set.count() {
                let [x, y] = origin_texels(set, c);
                let [x0, y0] = origin_texels(first, c);
                assert_whole(x - x0, &format!("{name} cascade {c} step {step} x"));
                assert_whole(y - y0, &format!("{name} cascade {c} step {step} y"));
                assert_eq!(set.texel_world[c], first.texel_world[c], "{name} cascade {c}: a moving camera keeps the texel");
                moved[i] |= (x - x0).abs() > 0.5 || (y - y0).abs() > 0.5;
            }
        }
    }
    assert!(moved.iter().all(|m| *m), "every fit's maps followed the camera by whole texels: {moved:?}");
}

#[test]
fn turning_the_camera_a_full_circle_keeps_every_cascades_texel_size_bit_equal() {
    let eye = Vec3::new(2.0, 3.0, 8.0);
    let look = |degrees: f32, pitch: f32| {
        let yaw = degrees.to_radians();
        let target = eye + Vec3::new(libm::sinf(yaw), pitch, -libm::cosf(yaw)) * 10.0;
        CameraDesc::look_at(eye.to_array(), target.to_array())
    };
    for count in 1..=MAX_CASCADES as u8 {
        for map_px in [512, 1536, 2048] {
            let settings = settings(count, map_px);
            let first = fit(&look(0.0, -0.3), ASPECT, SUN, &settings, std::iter::empty());
            for step in 0..72 {
                for pitch in [-0.3, 0.0, 0.45] {
                    let set = fit(&look(step as f32 * 5.0, pitch), ASPECT, SUN, &settings, std::iter::empty());
                    for c in 0..usize::from(count) {
                        assert_eq!(
                            set.texel_world[c].to_bits(),
                            first.texel_world[c].to_bits(),
                            "{count} x {map_px}: cascade {c} at {}° pitch {pitch}",
                            step * 5
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn one_to_four_splits_are_monotone_and_end_at_the_shadow_distance() {
    let camera = camera();
    for count in 1..=MAX_CASCADES {
        for lambda in [0.0, 0.25, 0.5, 0.9, 1.0] {
            let splits = split_depths(camera.near, DISTANCE, count, lambda);
            let mut previous = camera.near;
            for (c, end) in splits.iter().enumerate().take(count) {
                assert!(*end > previous, "{count} at λ {lambda}: cascade {c} ends at {end} after {previous}");
                previous = *end;
            }
            assert_eq!(splits[count - 1], DISTANCE, "{count} at λ {lambda}: the last cascade ends at the distance");
            assert!(splits[count..].iter().all(|end| *end == 0.0), "{count}: no cascade past the count");
            let mut asked = settings(count as u8, 2048).with_split_lambda(lambda);
            asked.distance = DISTANCE;
            let set = fit(&camera, ASPECT, SUN, &asked, std::iter::empty());
            assert_eq!(set.count(), count);
            assert_eq!(set.splits, splits, "the fit cuts where the split says");
        }
    }
    let mut short = camera;
    short.far = 25.0;
    let set = fit(&short, ASPECT, SUN, &settings(4, 2048), std::iter::empty());
    assert_eq!(set.splits[3], 25.0, "a camera nearer than the distance ends the shadows at its far plane");
    // The legacy fit is today's practical split of two.
    let legacy = cascades(&camera, ASPECT, SUN, DISTANCE);
    assert_eq!(legacy.splits, split_depths(camera.near, DISTANCE, SHADOW_CASCADES, 0.5));
    assert_eq!(legacy.count(), SHADOW_CASCADES);
}

#[test]
fn only_the_legacy_layout_keeps_the_legacy_fit() {
    let camera = camera();
    let legacy = ShadowSettings::legacy(DISTANCE);
    assert!(keeps_legacy_fit(&legacy));
    // Named flip (horde 10k): the default fit holds each cascade's cull view to its receivers, so
    // the legacy fit's bits are compared with that cull off; the maps are the legacy fit's either way.
    assert_eq!(fit(&camera, ASPECT, SUN, &legacy.with_receiver_cull(false), std::iter::empty()), cascades(&camera, ASPECT, SUN, DISTANCE));
    let held = fit(&camera, ASPECT, SUN, &legacy, std::iter::empty());
    assert_eq!(Cascades { planes: cascades(&camera, ASPECT, SUN, DISTANCE).planes, ..held }, cascades(&camera, ASPECT, SUN, DISTANCE));
    for changed in [settings(4, SHADOW_MAP_PX), settings(2, 2048), settings(2, SHADOW_MAP_PX).with_split_lambda(0.8), {
        let mut sixteen = legacy;
        sixteen.format = ShadowFormat::Depth16;
        sixteen
    }] {
        assert!(!keeps_legacy_fit(&changed), "{changed:?}");
    }
}

/// Small spheres over a 20 x 40 ground (y 0) and a few boxes on it: what a level's opaque rows
/// look like to the fitter.
fn ground_bounds() -> Vec<[f32; 4]> {
    let mut bounds = Vec::new();
    for x in -10..=10 {
        for z in -40..=4 {
            bounds.push([x as f32, -0.1, z as f32, 0.75]);
        }
    }
    bounds.extend([[-1.0, 0.5, 1.0, 0.9], [1.4, 0.4, 0.0, 0.6], [0.0, 1.5, -20.0, 2.0]]);
    bounds
}

/// [`settings`] drawn into `depth16unorm` maps (low and the phones): the receiver-tight fit.
fn depth16(count: u8, map_px: u32) -> ShadowSettings {
    let mut settings = settings(count, map_px);
    settings.format = ShadowFormat::Depth16;
    settings
}

/// Renderer pass 2, P2-0.3 (SH-06) flipped this row to `depth16unorm` maps (named in the PR): only
/// they hug their receivers for precision; a `depth32float` cascade spans its slice sphere
/// ([`a_depth32_cascades_light_depth_spans_its_sphere_whatever_the_receivers`]).
#[test]
fn the_light_depth_hugs_the_receivers_inside_each_cascade() {
    let camera = camera();
    let bounds = ground_bounds();
    for count in 1..=MAX_CASCADES as u8 {
        let settings = depth16(count, 2048);
        let open = fit(&camera, ASPECT, SUN, &settings, std::iter::empty());
        let tight = fit(&camera, ASPECT, SUN, &settings, bounds.iter().copied());
        let legacy = cascades(&camera, ASPECT, SUN, DISTANCE);
        for c in 0..usize::from(count) {
            assert!(tight.depth_range[c] > 0.0);
            assert!(tight.depth_range[c] < open.depth_range[c], "{count}: cascade {c} tighter around its receivers ({} vs {})", tight.depth_range[c], open.depth_range[c]);
            assert!(open.depth_range[c] < open.texel_world[c] * 2048.0 + 2.0, "{count}: cascade {c} without receivers spans its sphere");
            assert!(tight.depth_range[c] < legacy.depth_range[0] - CASTER_REACH * 0.5, "{count}: cascade {c} drops the legacy caster reach");
            assert_eq!(tight.texel_world[c], open.texel_world[c], "the depth fit never changes the texel");
            // Every receiver point inside the cascade's slice lands inside the depth range.
            let view_proj = Mat4::from_cols_array(&tight.view_proj[c]);
            for corner in tight.slice_corners[c] {
                let ground = Vec3::new(corner[0], 0.0, corner[2]);
                let inside = bounds.iter().any(|b| Vec3::new(b[0], b[1], b[2]).distance(ground) <= b[3]);
                if !inside {
                    continue;
                }
                let z = (view_proj * ground.extend(1.0)).z;
                assert!((0.0..=1.0).contains(&z), "{count}: cascade {c} keeps the ground at {ground:?} in depth ({z})");
            }
        }
    }
}

#[test]
fn a_caster_nearer_the_sun_than_the_near_plane_stays_in_the_cascade_cull_view() {
    let camera = camera();
    let sun = Vec3::from(SUN).normalize();
    for (name, set) in fits(&camera, &ground_bounds()) {
        for c in 0..set.count() {
            let slice = set.slice_corners[c].iter().map(|p| Vec3::from(*p)).sum::<Vec3>() / 8.0;
            let caster = slice + sun * (CASTER_REACH * 3.0);
            let bounds = caster.extend(1.0).to_array();
            assert!(in_frustum(&set.planes[c], bounds), "{name} cascade {c}: the caster is culled");
            let z = (Mat4::from_cols_array(&set.view_proj[c]) * caster.extend(1.0)).z;
            assert!(z < 0.0, "{name} cascade {c}: the caster is beyond the near plane ({z}), so it is pancaked");
            // Beside the cascade, the same caster is culled: only the near plane opens.
            let aside = Mat4::from_cols_array(&set.view_proj[c]).inverse() * Vec4::new(3.0, 0.0, -0.5, 1.0);
            assert!(!in_frustum(&set.planes[c], [aside.x, aside.y, aside.z, 0.1]), "{name} cascade {c}: the sides still cull");
        }
    }
}

/// Horde 10k: a cascade's cull view keeps only the casters that can shadow a receiver reading it
/// (one in the camera's frustum up to the cascade's end, the filter's reach about it). With the sun
/// behind the camera, a caster on the view axis well past a cascade's end is downstream of every
/// such receiver: the held cull view drops it where the fit's whole light frustum still holds it,
/// and keeps every caster up to the cascade's end; the maps are the fit's either way.
#[test]
fn a_cascade_culls_the_casters_downstream_of_every_receiver_reading_it() {
    let camera = CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 2.5, -20.0]);
    let forward = (Vec3::new(0.0, 2.5, -20.0) - Vec3::new(0.0, 3.0, 8.0)).normalize();
    let behind_sun = [0.0, 0.3, 1.0];
    let mut held_less = 0;
    let mut layouts = vec![("legacy".to_owned(), ShadowSettings::legacy(DISTANCE))];
    for count in 1..=MAX_CASCADES as u8 {
        layouts.push((format!("{count}x2048"), settings(count, 2048)));
    }
    for (name, settings) in layouts {
        assert!(settings.receiver_cull, "{name}: on by default");
        let set = fit(&camera, ASPECT, behind_sun, &settings, ground_bounds().into_iter());
        let open = fit(&camera, ASPECT, behind_sun, &settings.with_receiver_cull(false), ground_bounds().into_iter());
        let on_axis = |t: f32| (Vec3::new(0.0, 3.0, 8.0) + forward * t).extend(0.05).to_array();
        let mut dropped = 0;
        for c in 0..set.count() {
            assert_eq!(set.view_proj[c], open.view_proj[c], "{name} cascade {c}: the map itself is the fit's");
            for step in 1..=20 {
                let t = set.splits[c] * step as f32 / 20.0;
                assert!(in_frustum(&set.planes[c], on_axis(t)), "{name} cascade {c}: a caster {t} m ahead, inside the receivers' reach, stays");
            }
            let far = (1..=400).map(|step| set.splits[c] + step as f32 * 0.5).find(|t| !in_frustum(&set.planes[c], on_axis(*t)));
            dropped += usize::from(far.is_some_and(|t| in_frustum(&open.planes[c], on_axis(t))));
        }
        eprintln!("{name}: {dropped} cascades drop a downstream caster their whole light frustum holds");
        held_less += usize::from(dropped > 0);
    }
    // A coarse map's lookups reach far along the light (the legacy 1024 px fit keeps its whole frustum).
    assert!(held_less >= 3, "{held_less} layouts hold a cascade's cull view tighter than its light frustum");
}

/// Every tight fit under test (1 to 4 cascades, both depth formats, two map sizes) around `bounds`.
fn tight_fits(camera: &CameraDesc, bounds: &[[f32; 4]]) -> Vec<(String, ShadowSettings, Cascades)> {
    let mut sets = Vec::new();
    for count in 1..=MAX_CASCADES as u8 {
        for map_px in [1536, 2048] {
            for (format, settings) in [("depth32", settings(count, map_px)), ("depth16", depth16(count, map_px))] {
                sets.push((format!("{count}x{map_px} {format}"), settings, fit(camera, ASPECT, SUN, &settings, bounds.iter().copied())));
            }
        }
    }
    sets
}

/// Renderer pass 2, P2-0.3 (S1, SH-06): each cascade's comparison bias is one world-space bias
/// over its own light depth, `DEPTH_BIAS` of its map's width: the shared NDC bias was a share of
/// whatever depth the receivers spanned, so its world size followed the bounds touching the cascade.
/// The legacy fit keeps the shared `DEPTH_BIAS` bit for bit.
#[test]
fn each_cascades_comparison_bias_is_one_world_bias_over_its_depth_range() {
    let camera = camera();
    for (name, _, set) in tight_fits(&camera, &ground_bounds()) {
        for c in 0..set.count() {
            let width = set.texel_world[c] * set.map_px as f32;
            let world = set.comparison_bias()[c] * set.depth_range[c];
            let want = DEPTH_BIAS * width;
            assert!((world - want).abs() <= 1e-4 * want, "{name} cascade {c}: the comparison bias is {world} m, want {want} m");
            assert_eq!(set.depth_bias_world()[c], world, "{name} cascade {c}: the world bias is the comparison bias over the range");
        }
    }
    let legacy = cascades(&camera, ASPECT, SUN, DISTANCE);
    assert_eq!(legacy.comparison_bias(), [DEPTH_BIAS; MAX_CASCADES], "the legacy fit compares with the shared bias");
}

/// Renderer pass 2, P2-0.3 (SH-06, review S1's failure case): a tall caster whose bounds start to
/// touch a receiver-tight cascade changes its light depth, and the world bias holds: the crate's
/// contact gap no longer jumps by four as the camera moves 10 cm.
#[test]
fn a_tall_caster_touching_a_tight_cascade_keeps_its_world_bias() {
    let camera = camera();
    let ground = ground_bounds();
    let mut with_tree = ground.clone();
    with_tree.push([4.0, 10.0, -2.0, 10.5]);
    for count in 1..=MAX_CASCADES as u8 {
        let settings = depth16(count, 2048);
        let before = fit(&camera, ASPECT, SUN, &settings, ground.iter().copied());
        let after = fit(&camera, ASPECT, SUN, &settings, with_tree.iter().copied());
        assert_ne!(before.depth_range[0], after.depth_range[0], "{count}: the tree reaches cascade 0's light depth");
        for c in 0..usize::from(count) {
            let (was, now) = (before.depth_bias_world()[c], after.depth_bias_world()[c]);
            assert!((was - now).abs() <= 1e-4 * was, "{count}: cascade {c}'s world bias moved from {was} m to {now} m");
        }
    }
}

/// Renderer pass 2, P2-0.3 (SH-06): a `depth32float` cascade's light depth spans its slice sphere
/// whatever the receivers, so its depth, its comparison bias and PCSS's reach no longer follow the
/// bounds that touch the cascade (a tree entering it moved them in one frame). `depth32float` needs
/// no receiver-tight fit for precision.
#[test]
fn a_depth32_cascades_light_depth_spans_its_sphere_whatever_the_receivers() {
    let camera = camera();
    let mut with_tree = ground_bounds();
    with_tree.push([4.0, 10.0, -2.0, 10.5]);
    for count in 1..=MAX_CASCADES as u8 {
        for map_px in [1536, 2048] {
            let settings = settings(count, map_px);
            let open = fit(&camera, ASPECT, SUN, &settings, std::iter::empty());
            for bounds in [ground_bounds(), with_tree.clone()] {
                let tight = fit(&camera, ASPECT, SUN, &settings, bounds.into_iter());
                assert_eq!(open.depth_range, tight.depth_range, "{count} x {map_px}: the light depth ignores the receivers");
                assert_eq!(open.view_proj, tight.view_proj, "{count} x {map_px}: so does the whole matrix");
            }
            for c in 0..usize::from(count) {
                let view_proj = Mat4::from_cols_array(&open.view_proj[c]);
                for corner in open.slice_corners[c] {
                    let z = (view_proj * Vec3::from(corner).extend(1.0)).z;
                    assert!((0.0..=1.0).contains(&z), "{count} x {map_px}: cascade {c} holds its slice ({z})");
                }
            }
        }
    }
}

/// Renderer pass 2, P2-0.3 (SH-05): each tight cascade's map holds its slice sphere with the
/// filter's reach to spare on every side: the kernel (PCSS's 16 texels), the normal offset and a
/// texel for the snap. The one texel of margin let PCSS and the offsets read the clamped edge
/// texels at the far corners of each slice.
#[test]
fn each_cascades_map_holds_its_slice_with_the_filters_reach_to_spare() {
    let camera = camera();
    for (filter, texels) in [
        (ShadowFilter::Hardware2x2, 3.5),
        (ShadowFilter::Pcf3x3, 4.5),
        (ShadowFilter::Pcf5x5, 5.5),
        (ShadowFilter::PcssLite, 19.5),
        (ShadowFilter::Pcss, 19.5),
    ] {
        for count in 1..=MAX_CASCADES as u8 {
            for map_px in [512, 2048, 4096] {
                let mut settings = settings(count, map_px);
                settings.filter = filter;
                let set = fit(&camera, ASPECT, SUN, &settings, std::iter::empty());
                let inside = 1.0 - 2.0 * texels / map_px as f32 + 1e-4;
                for c in 0..usize::from(count) {
                    let view_proj = Mat4::from_cols_array(&set.view_proj[c]);
                    for corner in set.slice_corners[c] {
                        let at = view_proj * Vec3::from(corner).extend(1.0);
                        assert!(
                            at.x.abs() <= inside && at.y.abs() <= inside,
                            "{filter:?} {count} x {map_px}: cascade {c}'s slice corner reaches {:.5} of the map, past {texels} texels from its edge",
                            at.x.abs().max(at.y.abs())
                        );
                    }
                }
            }
        }
    }
}

/// Renderer pass 2, P2-0.3: the frame carries each cascade's comparison bias, and the shared
/// `shadow_params.x` that the v1 prefix, the Level-2 v2 prelude and custom passes read is the
/// first cascade's on `depth32float` maps (whose light depths span one multiple of their map widths,
/// so it is every cascade's world bias); `DEPTH_BIAS` otherwise, as before. A held cascade keeps
/// the bias its map was drawn with.
#[test]
fn the_frame_carries_each_cascades_bias_and_the_shared_one() {
    for (settings, shared_is_first) in [(settings(4, 2048), true), (depth16(2, 1536), false), (ShadowSettings::legacy(DISTANCE), false)] {
        let plan = cadence_plan(0, settings);
        let set = plan.cascades.as_ref().expect("cascades");
        assert_eq!(plan.frame.cascade_bias, set.comparison_bias(), "{settings:?}");
        let shared = if shared_is_first { set.comparison_bias()[0] } else { DEPTH_BIAS };
        assert_eq!(plan.frame.shadow_params[0], shared, "{settings:?}");
    }
    let mut shadows = depth16(2, SHADOW_MAP_PX);
    shadows.far_cadence = 2;
    let mut history = CascadeHistory::default();
    let mut first = cadence_plan(0, shadows);
    history.advance(&mut first, 0, false);
    let drawn = first.frame.cascade_bias[1];
    let mut held = cadence_plan(1, shadows);
    assert!(!history.advance(&mut held, 1, false).draws(1), "the far cascade is held");
    assert_eq!(held.frame.cascade_bias[1], drawn, "a held cascade compares with its map's bias");
    assert_eq!(held.cascades.as_ref().expect("cascades").comparison_bias()[1], drawn);
}

#[test]
fn the_blend_band_starts_its_share_of_each_cascade_before_its_end() {
    let camera = camera();
    let set = fit(&camera, ASPECT, SUN, &settings(4, 2048), std::iter::empty());
    assert_eq!(set.blend_starts(camera.near, 0.0)[..4], set.splits[..4], "no band: a hard switch at each end");
    let starts = set.blend_starts(camera.near, 0.2);
    let mut begin = camera.near;
    for (c, (start, end)) in starts.iter().zip(set.splits).enumerate() {
        assert_eq!(*start, end - 0.2 * (end - begin), "cascade {c}");
        assert!(begin < *start && *start < end, "cascade {c} blends inside its range");
        begin = end;
    }
    let two = fit(&camera, ASPECT, SUN, &settings(2, 2048), std::iter::empty());
    assert_eq!(two.blend_starts(camera.near, 0.2)[2..], [0.0, 0.0], "no band past the drawn cascades");
}

fn cadence_scene(x: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([x, 3.0, 8.0], [x, 0.0, -4.0]), [0, 0, 0, 255]);
    scene.lighting.sun_dir = SUN;
    scene.lighting.shadow_distance = DISTANCE;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.6, -10.0], [16.0, 0.2, 30.0]), Material::color([200; 4]));
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), Material::color([200; 4]));
    scene
}

fn cadence_plan(frame: u64, shadows: ShadowSettings) -> FramePlan {
    let options = PlanOptions { shadows: Some(shadows), depth_reversed: false, sun: None };
    FramePlan::build_with(&cadence_scene(frame as f32 * 0.7), &MeshLibrary::new(), ASPECT, &options).expect("plan")
}

#[test]
fn with_cadence_two_the_far_cascade_redraws_on_even_frames_and_on_every_settle() {
    let mut shadows = settings(2, SHADOW_MAP_PX);
    shadows.far_cadence = 2;
    let mut history = CascadeHistory::default();
    let mut drawn_far = cadence_plan(0, shadows).frame.cascade_matrices[1];
    for frame in 0..9u64 {
        let mut plan = cadence_plan(frame, shadows);
        let fresh = plan.frame.cascade_matrices[1];
        let draws = history.advance(&mut plan, frame, false);
        assert!(draws.draws(0), "the nearest cascade draws every frame ({frame})");
        assert_eq!(draws.draws(1), frame % 2 == 0, "the far cascade draws on even frames only ({frame})");
        if draws.draws(1) {
            assert_eq!(plan.frame.cascade_matrices[1], fresh, "a redrawn cascade takes the fresh fit ({frame})");
            drawn_far = fresh;
            continue;
        }
        assert_ne!(fresh, drawn_far, "the camera moved ({frame})");
        assert_eq!(plan.frame.cascade_matrices[1], drawn_far, "a held cascade keeps the matrix its map was drawn with ({frame})");
        assert_eq!(plan.frame.cascade_view_proj[1], drawn_far, "and so does the v1 prefix ({frame})");
        assert_eq!(plan.cascades.as_ref().expect("cascades").view_proj[1], drawn_far);
    }
    // A settled capture on an odd frame draws every cascade with the fresh fit.
    let mut plan = cadence_plan(9, shadows);
    let fresh = plan.frame.cascade_matrices[1];
    let draws = history.advance(&mut plan, 9, true);
    assert_eq!(draws.drawn(), 2, "a settle redraws every cascade");
    assert_eq!(plan.frame.cascade_matrices[1], fresh);
    // A new layout or a frame without shadows starts over: every cascade draws.
    let mut four = settings(4, 2048);
    four.far_cadence = 2;
    assert_eq!(history.advance(&mut cadence_plan(11, four), 11, false).drawn(), cadence_plan(11, four).cascades_drawn());
    let mut plain = cadence_plan(13, four);
    plain.cascades = None;
    assert_eq!(history.advance(&mut plain, 13, false).drawn(), 0);
    assert_eq!(history.advance(&mut cadence_plan(15, four), 15, false).drawn(), cadence_plan(15, four).cascades_drawn());
}

/// The plan of the cadence scene with its camera at `x`, turned `yaw` degrees about the up axis.
fn cut_plan(x: f32, yaw: f32, shadows: ShadowSettings) -> FramePlan {
    let mut scene = cadence_scene(x);
    let eye = Vec3::from(scene.camera.eye);
    let turn = glam::Quat::from_rotation_y(yaw.to_radians());
    scene.camera.target = (eye + turn * (Vec3::from(scene.camera.target) - eye)).to_array();
    let options = PlanOptions { shadows: Some(shadows), depth_reversed: false, sun: None };
    FramePlan::build_with(&scene, &MeshLibrary::new(), ASPECT, &options).expect("plan")
}

/// Whether every corner of cascade `c`'s slice in `plan` lands inside the map its matrix addresses.
fn slice_on_map(plan: &FramePlan, c: usize) -> bool {
    let set = plan.cascades.as_ref().expect("cascades");
    let view_proj = Mat4::from_cols_array(&plan.frame.cascade_matrices[c]);
    set.slice_corners[c].iter().all(|corner| {
        let at = view_proj * Vec3::from(*corner).extend(1.0);
        at.x.abs() <= 1.0 && at.y.abs() <= 1.0
    })
}

#[test]
fn a_camera_cut_redraws_a_held_cascade_whose_map_no_longer_covers_its_slice() {
    let mut shadows = settings(4, 1024);
    shadows.far_cadence = 2;
    let mut history = CascadeHistory::default();
    let mut first = cut_plan(0.0, 0.0, shadows);
    assert_eq!(history.advance(&mut first, 0, false).drawn(), 4, "the first frame draws every cascade");
    // Frame 1 is off cadence for cascades 1 and 3, but the camera jumped 200 units and turned
    // round: last frame's maps lie nowhere near the new slices.
    for (x, yaw) in [(200.0, 180.0), (-150.0, 90.0)] {
        let mut cut = cut_plan(x, yaw, shadows);
        let fresh = cut.frame.cascade_matrices;
        let draws = history.advance(&mut cut, 1, false);
        for (c, matrix) in fresh.iter().enumerate() {
            assert!(draws.draws(c), "cut to {x} turned {yaw}°: cascade {c} redraws instead of keeping a map off its slice");
            assert_eq!(&cut.frame.cascade_matrices[c], matrix, "cut to {x}: cascade {c} takes the fresh fit");
            assert!(slice_on_map(&cut, c), "cut to {x}: cascade {c}'s slice lies on its map");
        }
    }
    // A small step keeps the cadence: the held maps still cover their slices.
    let mut step = cut_plan(-149.8, 90.0, shadows);
    let draws = history.advance(&mut step, 3, false);
    assert_eq!((draws.draws(0), draws.draws(1), draws.draws(2), draws.draws(3)), (true, false, true, false), "frame 3 holds cascades 1 and 3");
    for c in 0..4 {
        assert!(slice_on_map(&step, c), "a held cascade {c} still covers its slice");
    }
}

/// The cadence scene under a sun straight overhead, its camera `up` units above the start.
fn overhead_plan(up: f32, shadows: ShadowSettings) -> FramePlan {
    let mut scene = cadence_scene(0.0);
    scene.lighting.sun_dir = [0.0, 1.0, 0.0];
    scene.camera.eye[1] += up;
    scene.camera.target[1] += up;
    // Receivers along the way down, so every height has its own receiver-tight light depth.
    for k in 1..8 {
        scene.draw(MeshId::CUBE, scaled([0.0, -40.0 * k as f32, -10.0], [16.0, 0.2, 30.0]), Material::color([200; 4]));
    }
    let options = PlanOptions { shadows: Some(shadows), depth_reversed: false, sun: None };
    FramePlan::build_with(&scene, &MeshLibrary::new(), ASPECT, &options).expect("plan")
}

#[test]
fn a_jump_along_the_light_redraws_a_held_cascade_whose_map_no_longer_holds_its_receivers_depth() {
    // RQ3 review: the coverage check tested light-space x and y only, so a vertical teleport under
    // a high sun kept far cascades whose light depth lay above the new receivers.
    let mut shadows = settings(4, 1024);
    shadows.far_cadence = 2;
    let mut history = CascadeHistory::default();
    assert_eq!(history.advance(&mut overhead_plan(0.0, shadows), 0, false).drawn(), 4);
    let mut dropped = overhead_plan(-200.0, shadows);
    let draws = history.advance(&mut dropped, 1, false);
    for c in 0..4 {
        assert!(draws.draws(c), "a 200-unit drop along the light: cascade {c} redraws");
    }
    // A small step keeps the cadence.
    let mut step = overhead_plan(-200.3, shadows);
    let draws = history.advance(&mut step, 3, false);
    assert_eq!((draws.draws(1), draws.draws(3)), (false, false), "frame 3 holds cascades 1 and 3 after a small step");
}

#[test]
fn live_frames_never_hold_a_settled_captures_maps_and_a_reset_redraws_every_cascade() {
    // RQ3 review: a settled capture redrew the shared maps for its own camera and the history kept
    // its fit, so the next Live frame held the capture's far cascades.
    let mut shadows = settings(4, 1024);
    shadows.far_cadence = 2;
    let mut history = CascadeHistory::default();
    history.advance(&mut cut_plan(0.0, 0.0, shadows), 0, false);
    history.advance(&mut cut_plan(0.0, 0.0, shadows), 1, false);
    // A capture of another shot, settled: every cascade redraws for it.
    let mut capture = cut_plan(3.0, 20.0, shadows);
    assert_eq!(history.advance(&mut capture, 2, true).drawn(), 4);
    let mut live = cut_plan(0.0, 0.0, shadows);
    let fresh = live.frame.cascade_matrices;
    assert_eq!(history.advance(&mut live, 3, false).drawn(), 4, "the first Live frame after a capture redraws every cascade");
    assert_eq!(live.frame.cascade_matrices, fresh, "with Live's own fit");
    assert_eq!(history.advance(&mut cut_plan(0.0, 0.0, shadows), 5, false).drawn(), 2, "then the cadence holds again");
    history.reset();
    assert_eq!(history.advance(&mut cut_plan(0.0, 0.0, shadows), 7, false).drawn(), 4, "a history reset redraws every cascade");
}

#[test]
fn each_presets_distance_blend_band_and_end_fade_reach_the_frame_and_a_scenes_own_distance_wins() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    // RQ3 review: no preset set a blend band (every split was a hard switch), shadows ended on a
    // hard line, and every preset reached the scene's 40 units.
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    let rows = [(QualityPreset::Low, 0.0, 0.15, 50.0), (QualityPreset::Medium, 0.1, 0.1, 50.0), (QualityPreset::High, 0.1, 0.1, 80.0), (QualityPreset::Ultra, 0.1, 0.1, 80.0)];
    for (preset, band, fade, distance) in rows {
        let quality = preset_quality(preset, desktop);
        let mut scene = cadence_scene(0.0);
        scene.lighting.shadow_distance = 0.0;
        let shadows = ShadowSettings::from_quality(&quality.shadows, scene.lighting.shadow_distance, SkyParams::default().sun_angular_radius);
        let options = PlanOptions { shadows: Some(shadows), depth_reversed: false, sun: None };
        let plan = FramePlan::build_with(&scene, &MeshLibrary::new(), ASPECT, &options).expect("plan");
        let last = plan.cascades_drawn() - 1;
        assert_eq!((plan.frame.shadow_soft[1], plan.frame.shadow_soft[2]), (band, fade), "{preset:?}: blend band and end fade");
        assert_eq!(plan.frame.cascade_ends[last], distance, "{preset:?}: the last cascade ends at the preset's distance");
        // A scene that sets its own distance keeps it.
        scene.lighting.shadow_distance = 25.0;
        let own = ShadowSettings::from_quality(&quality.shadows, scene.lighting.shadow_distance, SkyParams::default().sun_angular_radius);
        assert_eq!(own.distance, 25.0, "{preset:?}");
    }
    assert_eq!(genex_render::scene::Lighting::default().shadow_distance, 0.0, "a scene takes the quality's distance by default");
    assert_eq!(ShadowSettings::legacy(0.0).distance, 40.0, "the legacy renderer's 40 units");
}

#[test]
fn the_maps_hold_one_layer_per_cascade_at_the_settings_size_and_format_and_match_the_ledger() {
    assert_eq!(ShadowMapDesc::LEGACY.bytes(), 2 * 1024 * 1024 * 4, "today's two 1024 px depth32 layers");
    for count in 1..=MAX_CASCADES as u8 {
        for (map_px, format) in [(1024, ShadowFormat::Depth16), (2048, ShadowFormat::Depth32), (1536, ShadowFormat::Depth16)] {
            let mut quality = Quality::off();
            quality.shadows.cascades = count;
            quality.shadows.map_size = map_px;
            quality.shadows.format = format;
            let mut settings = settings(count, map_px);
            settings.format = format;
            let desc = ShadowMapDesc::for_settings(&settings);
            assert_eq!((desc.layers, desc.side, desc.format), (u32::from(count), map_px, settings.texture_format()));
            let input = BudgetInput::new((1920, 1080), 1.0, SceneFormat::Rgba16Float, false);
            let row = ledger(&quality, &input).entries().iter().find(|e| e.kind == BudgetKind::Shadows && e.label == "cascades").map(|e| e.bytes);
            assert_eq!(row, Some(desc.bytes()), "{count} x {map_px} {format:?}: the ledger counts the maps' bytes");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// GPU

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;

/// The harness runs rows on parallel threads: every GPU row shares this lock and the cost row
/// takes it alone, so its timed frames never share the GPU with another row's work.
static GPU_TURN: std::sync::RwLock<()> = std::sync::RwLock::new(());

fn gpu_shared() -> std::sync::RwLockReadGuard<'static, ()> {
    GPU_TURN.read().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn gpu_alone() -> std::sync::RwLockWriteGuard<'static, ()> {
    GPU_TURN.write().unwrap_or_else(std::sync::PoisonError::into_inner)
}

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

fn luma(capture: &Capture) -> f64 {
    let sum: u64 = capture.bgra().chunks(4).map(|p| u64::from(p[0]) + u64::from(p[1]) + u64::from(p[2])).sum();
    sum as f64 / (capture.bgra().len() / 4) as f64
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), capture.bgra()).expect("evidence");
    }
}

/// The part 1 shadow scene's ground under a slab `up` world units towards the sun from the
/// ground's middle, far out of view.
fn pancake_scene(up: Option<f32>) -> Scene {
    let mut scene = Scene::new(camera(), [120, 160, 210, 255]);
    scene.lighting.sun_dir = SUN;
    scene.lighting.shadow_distance = DISTANCE;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.6, -10.0], [16.0, 0.2, 30.0]), Material::color([210, 210, 200, 255]));
    if let Some(up) = up {
        let at = Vec3::new(0.0, -0.5, -3.0) + Vec3::from(SUN).normalize() * up;
        scene.draw(MeshId::CUBE, scaled(at.to_array(), [3.0, 0.2, 3.0]), Material::color([40, 40, 40, 255]));
    }
    scene
}

fn render(scene: &Scene, path: CullPath, gpu: &Gpu) -> Capture {
    let mut renderer = Renderer::new(gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.render(gpu, scene, path).expect("frame");
    renderer.capture(gpu).expect("capture")
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_caster_beyond_the_cascade_near_plane_still_shadows_by_pancaking() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let open = render(&pancake_scene(None), CullPath::Gpu, &gpu);
    // Twice the legacy reach above the ground: beyond either cascade's near plane.
    let far_up = pancake_scene(Some(CASTER_REACH * 2.0));
    let plan = FramePlan::build(&far_up, &MeshLibrary::new(), WIDTH as f32 / HEIGHT as f32).expect("plan");
    let slab = Vec3::new(0.0, -0.5, -3.0) + Vec3::from(SUN).normalize() * CASTER_REACH * 2.0;
    for c in 0..plan.cascades_drawn() {
        let z = (Mat4::from_cols_array(&plan.cascades.as_ref().expect("cascades").view_proj[c]) * slab.extend(1.0)).z;
        assert!(z < 0.0, "the slab is nearer the sun than cascade {c}'s near plane ({z})");
    }
    for path in [CullPath::Gpu, CullPath::Cpu] {
        let shaded = render(&far_up, path, &gpu);
        write_evidence(&format!("pancake-{path:?}.bgra"), &shaded);
        assert!(luma(&shaded) < luma(&open) - 1.0, "{path:?}: the slab shadows the ground: {} vs {}", luma(&shaded), luma(&open));
    }
    write_evidence("pancake-open.bgra", &open);
}

/// Horde 10k: a crowd of posts on open ground around and behind the camera under a low sun ahead
/// of it, a thin fog and boxes in the far cascades. The cascades held to their receivers draw
/// fewer casters and the same picture, on every desktop preset's shadows (PCSS through the screen
/// mask on high and ultra, inline otherwise).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_cascades_held_to_their_receivers_draw_the_same_picture() {
    use genex_render::device_class::DeviceClass;
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let class = DeviceClass::from_wire("desktop-ultra").expect("a class");
    let mut camera = CameraDesc::look_at([0.0, 3.2, 0.0], [0.0, 1.0, -24.0]);
    camera.far = 300.0;
    let mut scene = Scene::new(camera, [150, 120, 90, 255]);
    scene.lighting.sun_dir = Vec3::new(0.1, 0.08, -1.0).normalize().to_array();
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -20.0], [200.0, 0.2, 200.0]), Material::color([150, 140, 120, 255]));
    for i in 0..2_500 {
        let (x, z) = ((i % 50) as f32 * 1.2 - 30.0, 40.0 - (i / 50) as f32 * 1.6);
        scene.draw(MeshId::CUBE, scaled([x, 0.7, z], [0.4, 1.4, 0.4]), Material::color([90, 70, 60, 255]));
    }
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, class);
        let frame = |held: bool| {
            let mut renderer = Renderer::with_options(&gpu, 320, 180, genex_render::RenderOptions { msaa: false }).expect("renderer");
            renderer.set_scene_format(SceneFormat::Rgba16Float);
            renderer.set_quality(&quality);
            renderer.set_shadow_receiver_cull(held);
            let mut drawn = 0;
            let mut last = None;
            for index in 0..3 {
                renderer.set_frame_index(index);
                renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
                drawn = (1..renderer.last_stats().views).map(|view| renderer.read_view_args(&gpu, view).expect("args").iter().map(|a| a.instance_count).sum::<u32>()).sum::<u32>();
                last = Some(renderer.capture(&gpu).expect("capture"));
            }
            (last.expect("a frame"), drawn)
        };
        let ((whole, whole_casters), (held, held_casters)) = (frame(false), frame(true));
        write_evidence(&format!("receiver-cull-{preset:?}.bgra"), &held);
        assert!(held_casters < whole_casters, "{preset:?}: the held cull views draw fewer casters ({held_casters} of {whole_casters})");
        let differing = whole.bgra().chunks(4).zip(held.bgra().chunks(4)).filter(|(a, b)| a != b).count();
        assert_eq!(differing, 0, "{preset:?}: the picture is the one with the whole light frustums");
    }
}

/// A 44 x 4 m canopy plate 3 m up, reaching 40 m towards a low sun over the camera's near field
/// (the RQ3 review's scene): on every tight fit it crosses the near cascade's near plane.
fn canopy_scene() -> Scene {
    let mut camera = CameraDesc::look_at([-6.0, 1.7, 2.0], [-2.0, 0.0, -10.0]);
    camera.fovy_degrees = 60.0;
    let mut scene = Scene::new(camera, [120, 160, 210, 255]);
    scene.lighting.sun_dir = Vec3::new(0.80, 0.42, 0.10).normalize().to_array();
    scene.lighting.shadow_distance = DISTANCE;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -40.0], [120.0, 0.2, 120.0]), Material::color([200, 200, 190, 255]));
    scene.draw(MeshId::CUBE, scaled([18.0, 3.0, -6.0], [44.0, 0.1, 4.0]), Material::color([90, 80, 70, 255]));
    scene
}

const CANOPY_SIZE: (u32, u32) = (640, 360);

/// The pixels `quality` shadows in the canopy scene: darker than 0.8 of the same pixel with its
/// shadows switched off.
fn shadowed_pixels(gpu: &Gpu, quality: &Quality, name: &str) -> usize {
    let frame = |quality: &Quality| {
        let mut renderer = Renderer::new(gpu, CANOPY_SIZE.0, CANOPY_SIZE.1).expect("renderer");
        renderer.set_quality(quality);
        renderer.render(gpu, &canopy_scene(), CullPath::Gpu).expect("frame");
        renderer.capture(gpu).expect("capture")
    };
    let mut open = *quality;
    open.shadows.enabled = false;
    let (shaded, lit) = (frame(quality), frame(&open));
    write_evidence(&format!("canopy-{name}.bgra"), &shaded);
    let sum = |p: &[u8]| u32::from(p[0]) + u32::from(p[1]) + u32::from(p[2]);
    shaded.bgra().chunks(4).zip(lit.bgra().chunks(4)).filter(|(s, l)| (sum(s) as f32) < 0.8 * sum(l) as f32).count()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_caster_crossing_the_near_plane_shadows_as_much_on_every_tight_fit_as_on_the_legacy_one() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let legacy = shadowed_pixels(&gpu, &Quality::off(), "legacy");
    assert!(legacy > 10_000, "the canopy shadows the ground on the legacy fit ({legacy} pixels)");
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, desktop);
        let tight = shadowed_pixels(&gpu, &quality, preset.wire());
        // The review measured 8-13 % of the strip lost to pancaked vertices before the fix.
        assert!(tight as f32 >= 0.97 * legacy as f32, "{preset:?}: {tight} shadowed pixels against the legacy fit's {legacy}");
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows through the renderer's settings path
//
// They render the settings' cascades through the renderer (scene.rs fits with `shadow::fit`,
// renderer.rs sizes the maps per `ShadowMapDesc`, draws `depth16unorm` casters and applies
// `CascadeHistory`), so they run in the `--ignored metal` lane:
//
//   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//     --offline --locked --test shadow_cascades -- --ignored metal
//
// Goldens live in `tests/fixtures/render-goldens/shadows/<name>.bgra` (raw BGRA, top row first,
// 256x144); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead. `GENEX_PERF_OUT` receives the
// cost row as JSON.

const GOLDEN_WIDTH: u32 = 256;
const GOLDEN_HEIGHT: u32 = 144;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges): 0.5 %.
const GOLDEN_OUTLIER_PIXELS: usize = 184;
/// Pixels a `depth16unorm` frame may differ from the `depth32float` one by more than the tolerance.
const DEPTH16_OUTLIER_PIXELS: usize = 184;
/// The 4 x 2048 cascades' share of the RQ3 1.5 ms shadow budget at 1080p (the filter, RQ3.2, takes the rest).
const CASCADE_BUDGET_MS: f32 = 1.0;
/// The RQ3 shadow budget at 1080p: 4 x 2048 cascades drawn and filtered with PCSS.
const SHADOW_BUDGET_MS: f32 = 1.5;
/// GPU-timed frames per profile and round, after the warm-up frames, and the timed rounds.
const PERF_FRAMES: usize = 40;
const PERF_WARMUP: usize = 8;
const PERF_ROUNDS: usize = 4;

fn goldens_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/shadows")
}

/// Compare `capture` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture) {
    write_evidence(&format!("{name}.bgra"), capture);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    let (outliers, worst) = differing(&golden, capture.bgra());
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

/// Pixels of `a` and `b` differing by more than the channel tolerance, and the worst difference.
fn differing(a: &[u8], b: &[u8]) -> (usize, u8) {
    assert_eq!(a.len(), b.len(), "frame sizes");
    let mut outliers = 0;
    let mut worst = 0u8;
    for (x, y) in a.chunks(4).zip(b.chunks(4)) {
        let diff = x.iter().zip(y).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        if diff > GOLDEN_CHANNEL_TOLERANCE {
            outliers += 1;
        }
    }
    (outliers, worst)
}

/// A 60 m street of boxes, posts and balls under a low sun: casters in every cascade.
fn street_scene(camera: CameraDesc) -> Scene {
    let mut scene = Scene::new(camera, [120, 160, 210, 255]);
    scene.lighting.sun_dir = [0.6, 0.55, 0.3];
    scene.lighting.shadow_distance = 60.0;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.6, -25.0], [24.0, 0.2, 70.0]), Material::color([210, 210, 200, 255]));
    for i in 0..12 {
        let z = 2.0 - i as f32 * 5.0;
        let side = if i % 2 == 0 { -2.5 } else { 2.5 };
        scene.draw(MeshId::CUBE, scaled([side, 0.5, z], [1.0, 2.0, 1.0]), Material::color([200, 70, 60, 255]));
        scene.draw(MeshId::CUBE, scaled([-side * 1.6, 1.5, z - 2.0], [0.2, 4.0, 0.2]), Material::color([60, 60, 70, 255]));
        scene.draw(MeshId::SPHERE, scaled([0.0, 0.1, z - 1.0], [0.7; 3]), Material::color([60, 170, 90, 255]));
    }
    scene
}

fn street() -> Scene {
    street_scene(CameraDesc::look_at([0.0, 2.5, 8.0], [0.0, 0.5, -6.0]))
}

fn shadow_quality(count: u8, map_px: u32, format: ShadowFormat, far_cadence: u8) -> Quality {
    let mut quality = Quality::off();
    quality.shadows.cascades = count;
    quality.shadows.map_size = map_px;
    quality.shadows.format = format;
    quality.shadows.far_cadence = far_cadence;
    quality
}

fn render_quality(gpu: &Gpu, quality: &Quality, path: CullPath, size: (u32, u32)) -> (Capture, Renderer) {
    let mut renderer = Renderer::new(gpu, size.0, size.1).expect("renderer");
    renderer.set_quality(quality);
    renderer.render(gpu, &street(), path).expect("frame");
    (renderer.capture(gpu).expect("capture"), renderer)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_one_and_four_cascades_through_both_cull_paths() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let size = (GOLDEN_WIDTH, GOLDEN_HEIGHT);
    for (name, count) in [("cascades-1", 1u8), ("cascades-4", 4)] {
        let quality = shadow_quality(count, 2048, ShadowFormat::Depth32, 1);
        let (indirect, renderer) = render_quality(&gpu, &quality, CullPath::Gpu, size);
        let (direct, _) = render_quality(&gpu, &quality, CullPath::Cpu, size);
        assert!(indirect.bgra() == direct.bgra(), "{name}: the GPU-culled frame differs from the CPU-culled one");
        let stats = renderer.last_stats();
        assert_eq!(stats.views, 1 + u32::from(count), "{name}: the camera and one view per cascade");
        for view in 1..=u32::from(count) {
            let drawn: u32 = renderer.read_view_args(&gpu, view).expect("cascade args").iter().map(|a| a.instance_count).sum();
            assert!(drawn > 0, "{name}: cascade {} drew its casters through the cull", view - 1);
        }
        check_golden(name, &indirect);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_depth16_cascades_shadow_like_depth32_ones() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let size = (GOLDEN_WIDTH, GOLDEN_HEIGHT);
    let (wide, _) = render_quality(&gpu, &shadow_quality(4, 2048, ShadowFormat::Depth32, 1), CullPath::Gpu, size);
    let (narrow, _) = render_quality(&gpu, &shadow_quality(4, 2048, ShadowFormat::Depth16, 1), CullPath::Gpu, size);
    write_evidence("cascades-4-depth16.bgra", &narrow);
    let (outliers, worst) = differing(wide.bgra(), narrow.bgra());
    assert!(outliers <= DEPTH16_OUTLIER_PIXELS, "depth16 differs from depth32 in {outliers} pixels (worst {worst})");
    let (lit, _) = render_quality(&gpu, &{
        let mut off = Quality::off();
        off.shadows.enabled = false;
        off
    }, CullPath::Gpu, size);
    assert!(luma(&narrow) < luma(&lit) - 1.0, "depth16 cascades shadow the street");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_cadence_two_skips_the_far_cascade_passes_on_odd_frames_but_not_on_a_settle() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, GOLDEN_WIDTH, GOLDEN_HEIGHT).expect("renderer");
    renderer.set_quality(&shadow_quality(4, 1024, ShadowFormat::Depth16, 2));
    let mut passes = Vec::new();
    for frame in 0..6u64 {
        renderer.set_frame_index(frame);
        let x = frame as f32 * 0.4;
        renderer.render(&gpu, &street_scene(CameraDesc::look_at([x, 2.5, 8.0], [x, 0.5, -6.0])), CullPath::Gpu).expect("frame");
        passes.push(renderer.last_stats().render_passes);
    }
    // Frame 0 draws every cascade; then cascade 0 every frame, far cascade c on frames where the
    // index is c - 1 modulo 2: odd frames draw cascades 0 and 2, even ones 0, 1 and 3.
    let world = passes[0] - 4;
    assert_eq!(passes[1..], [world + 2, world + 3, world + 2, world + 3, world + 2], "{passes:?}");
    renderer.set_environment_settle(true);
    renderer.set_frame_index(7);
    renderer.render(&gpu, &street(), CullPath::Gpu).expect("settled frame");
    assert_eq!(renderer.last_stats().render_passes, world + 4, "a settled re-render draws every cascade");
}

/// The p50 and p95 of `samples` (milliseconds).
fn percentiles(mut samples: Vec<f32>) -> (f32, f32) {
    samples.sort_by(f32::total_cmp);
    let at = |q: f32| samples[((samples.len() - 1) as f32 * q).round() as usize];
    (at(0.5), at(0.95))
}

/// One round of [`PERF_FRAMES`] GPU-timed frames of the street at 1080p (frame-level timestamps),
/// after [`PERF_WARMUP`] frames; None without timestamp queries.
fn gpu_frame_times(gpu: &Gpu, renderer: &mut Renderer) -> Option<Vec<f32>> {
    let scene = street();
    let mut times = Vec::new();
    for frame in 0..(PERF_WARMUP + PERF_FRAMES) as u64 {
        let landed = renderer.arm_frame_timer(&gpu.queue)?;
        if frame >= PERF_WARMUP as u64 {
            times.extend(landed);
        }
        renderer.set_frame_index(frame);
        renderer.render(gpu, &scene, CullPath::Gpu).expect("frame");
        renderer.finish_frame_timer();
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    }
    Some(times)
}

/// The cost rows' HDR quality: the scene the presets draw (HDR, tonemap, auto exposure) with
/// `count` cascades of `map_px` in `format`, filtered by `filter`, every `cadence` frames.
fn hdr_shadow_quality(count: u8, map_px: u32, format: ShadowFormat, cadence: u8, filter: ShadowFilter) -> Quality {
    let mut quality = shadow_quality(count, map_px, format, cadence);
    (quality.hdr, quality.tonemap, quality.exposure) = (true, true, true);
    quality.shadows.filter = filter;
    quality
}

/// The median over rounds of `a`'s minus `b`'s per-round statistic (`pick`: 0 p50, 1 p95).
fn paired(rounds: &[Vec<(f32, f32)>], a: usize, b: usize, pick: fn((f32, f32)) -> f32) -> f32 {
    percentiles(rounds.iter().map(|round| pick(round[a]) - pick(round[b])).collect()).0
}

/// The shadow cost rows (RQ3 review: gated at p50 and p95, the shapes the presets draw on the
/// HDR path, and the cheaper variants held to be no slower).
const COST_PROFILES: [&str; 11] = [
    "off",
    "legacy-2x1024",
    "4x2048-depth32",
    "4x2048-depth16",
    "4x1024-depth16-cadence2",
    "4x2048-depth32-pcss",
    "hdr-off",
    "hdr-4x4096-depth32-pcss",
    "hdr-4x1024-depth16",
    "hdr-4x1024-depth16-cadence2",
    "hdr-4x2048-depth32",
];

fn cost_quality(name: &str) -> Quality {
    let mut off = Quality::off();
    off.shadows.enabled = false;
    match name {
        "off" => off,
        "legacy-2x1024" => Quality::off(),
        "4x2048-depth32" => shadow_quality(4, 2048, ShadowFormat::Depth32, 1),
        "4x2048-depth16" => shadow_quality(4, 2048, ShadowFormat::Depth16, 1),
        "4x1024-depth16-cadence2" => shadow_quality(4, 1024, ShadowFormat::Depth16, 2),
        "4x2048-depth32-pcss" => {
            let mut pcss = shadow_quality(4, 2048, ShadowFormat::Depth32, 1);
            pcss.shadows.filter = ShadowFilter::Pcss;
            pcss
        }
        "hdr-off" => {
            let mut hdr = hdr_shadow_quality(1, 1024, ShadowFormat::Depth32, 1, ShadowFilter::Pcf3x3);
            hdr.shadows.enabled = false;
            hdr
        }
        "hdr-4x4096-depth32-pcss" => hdr_shadow_quality(4, 4096, ShadowFormat::Depth32, 1, ShadowFilter::Pcss),
        "hdr-4x1024-depth16" => hdr_shadow_quality(4, 1024, ShadowFormat::Depth16, 1, ShadowFilter::Pcf3x3),
        "hdr-4x1024-depth16-cadence2" => hdr_shadow_quality(4, 1024, ShadowFormat::Depth16, 2, ShadowFilter::Pcf3x3),
        _ => hdr_shadow_quality(4, 2048, ShadowFormat::Depth32, 1, ShadowFilter::Pcf3x3),
    }
}

/// How much slower, GPU ms at the median of paired p95s, a cheaper variant may measure than the
/// variant it saves on before the row calls it slower (frame-level timestamps jitter by this
/// much on a shared machine).
const CHEAPER_TOLERANCE_MS: f32 = 0.1;
/// How far apart, GPU ms at the median of paired p95s, 16-bit and 32-bit maps of one shape measure
/// on the M4 Max (seven runs: -0.06 to +0.24 at equal p50s).
const DEPTH16_P95_SPREAD_MS: f32 = 0.4;

/// How many times the cost row measures before it calls a budget missed: another test binary on
/// the GPU only adds time to some rounds (pass-1 gate: the row failed in both full-suite runs at
/// load 12-34 and passed 7 of 7 alone), and a real regression misses on every attempt.
const COST_ATTEMPTS: usize = 3;

/// The shadow costs one measurement found, GPU ms (p50, p95) at the median of paired rounds.
struct ShadowCosts {
    cascades: (f32, f32),
    filtered: (f32, f32),
    ultra: (f32, f32),
    depth16: (f32, f32),
    cadence: (f32, f32),
    json: String,
}

/// One measurement of every cost profile on `renderers`, rounds interleaving the profiles; each
/// cost is the median over rounds of the paired difference of round statistics (p50 and p95), so
/// a burst of load lands in one round, not in the verdict. None without timestamp queries.
fn measure_shadow_costs(gpu: &Gpu, renderers: &mut [Renderer]) -> Option<ShadowCosts> {
    let mut landed: Vec<Vec<f32>> = vec![Vec::new(); COST_PROFILES.len()];
    let mut rounds: Vec<Vec<(f32, f32)>> = Vec::new();
    for round in 0..=PERF_ROUNDS {
        let mut stats = Vec::with_capacity(COST_PROFILES.len());
        for (k, renderer) in renderers.iter_mut().enumerate() {
            let times = gpu_frame_times(gpu, renderer)?;
            stats.push(percentiles(times.clone()));
            if round > 0 {
                landed[k].extend(times);
            }
        }
        if round > 0 {
            rounds.push(stats);
        }
    }
    let at = |name: &str| COST_PROFILES.iter().position(|p| *p == name).expect("profile");
    let p50 = |s: (f32, f32)| s.0;
    let p95 = |s: (f32, f32)| s.1;
    let cost = |a: &str, b: &str| (paired(&rounds, at(a), at(b), p50), paired(&rounds, at(a), at(b), p95));
    let costs = ShadowCosts {
        cascades: cost("4x2048-depth32", "off"),
        filtered: cost("4x2048-depth32-pcss", "off"),
        ultra: cost("hdr-4x4096-depth32-pcss", "hdr-off"),
        depth16: cost("4x2048-depth16", "4x2048-depth32"),
        cadence: cost("hdr-4x1024-depth16-cadence2", "hdr-4x1024-depth16"),
        json: String::new(),
    };
    let rows: Vec<String> = COST_PROFILES
        .iter()
        .zip(landed)
        .map(|(name, times)| {
            let frames = times.len();
            let (p50, p95) = percentiles(times);
            format!("{{\"profile\":\"{name}\",\"frames\":{frames},\"p50_ms\":{p50:.4},\"p95_ms\":{p95:.4}}}")
        })
        .collect();
    let pair = |(a, b): (f32, f32)| format!("{{\"p50_ms\":{a:.4},\"p95_ms\":{b:.4}}}");
    let json = format!(
        "{{\"row\":\"rq3-shadow-cost-1080p\",\"measures\":\"frame-level GPU timestamps, street scene (37 draws), 1920x1080; paired medians over {PERF_ROUNDS} interleaved rounds\",\"backend\":\"{}\",\"adapter\":\"{}\",\"cascades_4x2048_added\":{},\"budget_ms\":{CASCADE_BUDGET_MS},\"cascades_4x2048_pcss_added\":{},\"hdr_4x4096_pcss_added\":{},\"shadow_budget_ms\":{SHADOW_BUDGET_MS},\"depth16_minus_depth32\":{},\"cadence2_minus_cadence1\":{},\"rows\":[{}]}}\n",
        gpu.receipt().backend,
        gpu.receipt().adapter,
        pair(costs.cascades),
        pair(costs.filtered),
        pair(costs.ultra),
        pair(costs.depth16),
        pair(costs.cadence),
        rows.join(",")
    );
    Some(ShadowCosts { json, ..costs })
}

/// The budgets `costs` miss, worded (empty: every budget holds). The p95 gates only on a release
/// build: a debug build's slow encoding stretches the frame-level span (p95 1.5-1.9 ms against
/// 0.7-0.8 in release for the same 4 x 2048 cascades).
fn missed_budgets(costs: &ShadowCosts) -> Vec<String> {
    let ShadowCosts { cascades, filtered, ultra, depth16, cadence, .. } = *costs;
    let mut missed = Vec::new();
    let mut check = |held: bool, what: String| {
        if !held {
            missed.push(what);
        }
    };
    check(cascades.0 <= CASCADE_BUDGET_MS, format!("4 x 2048 cascades add {cascades:?} ms (p50, p95) at 1080p over shadows off"));
    check(filtered.0 <= SHADOW_BUDGET_MS, format!("4 x 2048 cascades with PCSS add {filtered:?} ms (p50, p95)"));
    check(ultra.0 <= SHADOW_BUDGET_MS, format!("ultra's 4 x 4096 PCSS on the HDR path adds {ultra:?} ms (p50, p95)"));
    if cfg!(debug_assertions) {
        return missed;
    }
    check(cascades.1 <= CASCADE_BUDGET_MS, format!("4 x 2048 cascades add {cascades:?} ms (p50, p95) at 1080p over shadows off"));
    check(filtered.1 <= SHADOW_BUDGET_MS, format!("4 x 2048 cascades with PCSS add {filtered:?} ms (p50, p95)"));
    check(ultra.1 <= SHADOW_BUDGET_MS, format!("ultra's 4 x 4096 PCSS on the HDR path adds {ultra:?} ms (p50, p95)"));
    // 16-bit maps save memory (phones, the low tier, the web budget); on a desktop GPU they draw
    // in the same time: their paired p95 scatters within DEPTH16_P95_SPREAD_MS of 32-bit's.
    check(depth16.0 <= CHEAPER_TOLERANCE_MS, format!("16-bit maps are slower than 32-bit ones at p50 by {} ms", depth16.0));
    check(depth16.1 <= DEPTH16_P95_SPREAD_MS, format!("16-bit maps are slower than 32-bit ones at p95 by {} ms", depth16.1));
    check(cadence.1 <= CHEAPER_TOLERANCE_MS, format!("a far cadence of 2 is slower than redrawing every cascade at p95 by {} ms", cadence.1));
    missed
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_four_2048_cascades_fit_their_share_of_the_shadow_budget_at_1080p() {
    let _alone = gpu_alone();
    let Some(gpu) = gpu() else { return };
    let mut renderers: Vec<Renderer> = COST_PROFILES
        .iter()
        .map(|name| {
            let mut renderer = Renderer::new(&gpu, 1920, 1080).expect("renderer");
            renderer.set_quality(&cost_quality(name));
            if name.starts_with("hdr") {
                renderer.set_scene_format(SceneFormat::Rgba16Float);
            }
            renderer
        })
        .collect();
    let mut missed = Vec::new();
    for attempt in 1..=COST_ATTEMPTS {
        let Some(costs) = measure_shadow_costs(&gpu, &mut renderers) else {
            eprintln!("skipped: no timestamp queries");
            return;
        };
        eprint!("attempt {attempt}: {}", costs.json);
        if let Ok(out) = std::env::var("GENEX_PERF_OUT") {
            std::fs::write(out, &costs.json).expect("perf row");
        }
        missed = missed_budgets(&costs);
        if missed.is_empty() {
            return;
        }
        eprintln!("attempt {attempt} missed: {missed:?}");
    }
    panic!("every one of {COST_ATTEMPTS} measurements missed a budget; the last: {missed:#?}");
}

// ---------------------------------------------------------------------------------------------
// Renderer pass 2, P2-0.4 (RC-06): a held far cascade keeps only what stood still

/// The sun shadows of the phone class at high (two Depth16 cascades, the far one every 2nd frame).
fn phone_shadows() -> ShadowSettings {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    let quality = preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Mobile, PerformanceTier::High));
    ShadowSettings::from_quality(&quality.shadows, DISTANCE, SkyParams::default().sun_angular_radius)
}

/// How the RC-06 caster moves from frame to frame.
#[derive(Clone, Copy, Debug)]
enum Motion {
    /// It stands still.
    Still,
    /// It walks 0.3 m a frame sideways (a character).
    Walks,
    /// It sways a third of a milliradian a frame about its base (a tree in the wind: a few
    /// millimetres at its top).
    Sways,
}

/// The cadence scene with its camera still and one opaque 0.8 m cube in the far cascade (28 m out)
/// moving as `motion` says by frame `frame`, drawn as `mesh`.
fn moving_plan(frame: u64, shadows: ShadowSettings, motion: Motion, mesh: MeshId) -> FramePlan {
    let mut scene = cadence_scene(0.0);
    let (x, lean) = match motion {
        Motion::Still => (0.0, 0.0),
        Motion::Walks => (frame as f32 * 0.3, 0.0),
        Motion::Sways => (0.0, frame as f32 * 3.3e-4),
    };
    let model = Mat4::from_translation(Vec3::new(x - 1.0, 0.4, -28.0)) * Mat4::from_rotation_x(lean) * Mat4::from_scale(Vec3::splat(0.8));
    // Opaque, so it casts (the cadence scene's own rows are translucent and draw no shadow).
    scene.draw(mesh, model.to_cols_array(), Material::color([200, 200, 200, 255]));
    let options = PlanOptions { shadows: Some(shadows), depth_reversed: false, sun: None };
    FramePlan::build_with(&scene, &MeshLibrary::new(), ASPECT, &options).expect("plan")
}

/// Whether the RC-06 caster (the plan's one opaque row) is inside cascade `c`'s cull view.
fn caster_in(plan: &FramePlan, c: usize) -> bool {
    assert_eq!(plan.opaque_instances, 1, "the caster is the one opaque row");
    in_frustum(&plan.cascades.as_ref().expect("cascades").planes[c], plan.instances[0].bounds)
}

/// RC-06: on a phone class the far cascade is drawn every 2nd frame; a character walking inside it
/// was held with the rest of the map, so its shadow moved at 30 Hz and doubled against the near
/// cascade's at the seam. A held cascade now redraws on every frame something inside it moved by
/// half a texel.
#[test]
fn on_a_phone_a_far_cascade_redraws_every_frame_a_caster_inside_it_moves() {
    let shadows = phone_shadows();
    assert_eq!((shadows.cascades, shadows.far_cadence), (2, 2), "the phone class holds its far cascade");
    let mut history = CascadeHistory::default();
    for frame in 0..8u64 {
        let mut plan = moving_plan(frame, shadows, Motion::Walks, MeshId::CUBE);
        assert!(caster_in(&plan, 1) && !caster_in(&plan, 0), "frame {frame}: the caster stands in the far cascade only");
        let draws = history.advance(&mut plan, frame, false);
        assert!(draws.draws(0) && draws.draws(1), "frame {frame}: the far cascade redraws while its caster moves (no 30 Hz shadow)");
    }
}

/// RC-06's other half: a far cascade whose casters stand still, or sway by far less than a texel a
/// frame, keeps its cadence; one whose caster changes its mesh in place (a level of detail
/// switching) redraws once.
#[test]
fn a_far_cascade_keeps_its_cadence_while_nothing_inside_it_moves() {
    let shadows = phone_shadows();
    for motion in [Motion::Still, Motion::Sways] {
        let mut history = CascadeHistory::default();
        for frame in 0..8u64 {
            let mut plan = moving_plan(frame, shadows, motion, MeshId::CUBE);
            let draws = history.advance(&mut plan, frame, false);
            assert_eq!(draws.draws(1), frame % 2 == 0, "{motion:?}, frame {frame}: the far cascade keeps its cadence");
        }
    }
    let mut history = CascadeHistory::default();
    for frame in 0..8u64 {
        let mesh = if frame < 3 { MeshId::CUBE } else { MeshId::SPHERE };
        let mut plan = moving_plan(frame, shadows, Motion::Still, mesh);
        let draws = history.advance(&mut plan, frame, false);
        let swapped = frame == 3;
        assert_eq!(draws.draws(1), frame % 2 == 0 || swapped, "frame {frame}: a mesh swapped in the far cascade redraws it once");
    }
}
