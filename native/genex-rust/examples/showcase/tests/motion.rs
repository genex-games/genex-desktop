//! Renderer pass 2, P2-0.1: the motion rows the pass-1 shimmer gate could not see (SH-15, T-12).
//! The pass-1 row creeps the camera a fiftieth of a pixel a frame over bench-outdoor and averages
//! eleven frame pairs, so a shadow that blinks for one frame, or blinks only while the camera
//! really moves, passes it. These rows move the camera at real speeds and measure:
//!
//! - **one-frame pops**: pixels whose luma jumps by more than [`POP_LEVELS`] for exactly one frame
//!   and comes back: frame k's value is found nowhere within the path's motion radius of the pixel
//!   in frame k-1 nor in frame k+1, while those two agree; a camera's own motion carries values to
//!   a neighbour within the radius, so it is no pop (a plain per-pixel test counts every textured
//!   grass blade a 2 px pan moves);
//! - **shadow-attributed pops**: the same camera path drawn with the sun's shadows (and contact
//!   shadows) on and off at the same exposure, frame by frame; what the shadows add is theirs.
//!   Owner decision D12 (2026-10-16): a pixel is a shadow pop only if it pops in the shadows-on run
//!   and does not pop at the same frame in the shadows-off run, where popping there is SH-15's
//!   plain test (more than [`POP_LEVELS`] for exactly one frame at the pixel): a sub-pixel canopy
//!   speck, content entering at the frame's edge or a mote that blinks in both runs is foliage and
//!   TAA quality, even where only the shadowed run's darker surroundings carry it past the
//!   envelope;
//! - **the maximum over frames**, never only the mean;
//! - on bench-outdoor: the creeping row's **lake box** (the flicker map's pixels over the water),
//!   and pans of 1, 4 and 16 px a frame with a **sharpness ratio** (Laplacian energy during the
//!   pan over the still camera's).
//!
//! The Lakeside rows draw the way the Studio's Live draws (genex's presenter, the game's look,
//! custom passes and the HUD hidden), one simulation tick per frame, the render scale held at 1.
//! Every row writes a JSON record and a PNG of where it popped (magenta) into `GENEX_MOTION_OUT`
//! (default `pass2/motion-rows` in the evidence folder).
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase \
//!     --release --offline --locked --test motion -- --ignored metal --nocapture --test-threads 1
mod support;

use std::path::PathBuf;

use genex::math::{Vec3, vec3};
use genex::present::Presenter;
use genex::render::{PresetChoice, RenderChange, RenderFeature};
use genex::{FIXED_STEP_MS, View};
use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, classify};
use genex_render::presets::{preset_quality, scene_format};
use genex_render::settings::{ExposureMode, Look, Quality, QualityPreset, Tonemapper};
use genex_render::{CullPath, Gpu, RenderOptions};
use showcase_game::bench::SceneId;
use showcase_game::world::{CameraMode, FreeCam, SHOTS};
use support::{SHOT_TICK, gpu, lakeside_at, write_png};

/// A pixel pops when its luma (0..255) differs from both neighbouring frames by more than this,
/// the same way, while those two frames agree within it (SH-15: "more than 16 levels for exactly
/// one frame").
const POP_LEVELS: f64 = 16.0;
/// The luma change above which a pixel counts as flickering between two frames (the pass-1 row's).
const FLICKER_LEVELS: f64 = 3.0;
/// The most pixels the shadows may add to one frame's pops on a mobile class, as a share of the
/// frame (owner decision D9, 2026-10-15): one hundredth of a percent (92 pixels at 1280x720); a
/// single blinking 10 x 10 shadow block exceeds it. Desktop classes allow none
/// ([`shadow_pop_share_max`]).
const MOBILE_SHADOW_POP_SHARE_MAX: f64 = 0.0001;

/// D9: zero one-frame shadow pops on every desktop class; a mobile class may add
/// [`MOBILE_SHADOW_POP_SHARE_MAX`] of the frame. Applied exactly as the gates apply it, never loosened.
fn shadow_pop_share_max(class: DeviceClass) -> f64 {
    if class.form == FormFactor::Mobile { MOBILE_SHADOW_POP_SHARE_MAX } else { 0.0 }
}
/// The most pixels the shadows may make flicker into a frame, mean over the path, as a share of the
/// frame: the creeping bound P2-0.2 sets for shadow-attributed flicker (the still row's 0.15%).
const SHADOW_FLICKER_SHARE_MAX: f64 = 0.0015;
/// The most pixels the shadows may change in a single frame beyond what the motion explains, as a
/// share of the frame: a shadow that switches on or off at once (a spot slot changing hands, a
/// cascade or LOD step) over more than a quarter of a percent of the picture (2,300 pixels at
/// 1280x720) reads as a pop although it never comes back.
const SHADOW_STEP_SHARE_MAX: f64 = 0.0025;

/// Lakeside frames drawn before a row measures (TAA, AO and exposure settle on the first pose).
const WARM_FRAMES: u32 = 30;
/// Lakeside frames each path measures (SH-15).
const PATH_FRAMES: u32 = 120;
/// The free camera's vertical field of view (`World::camera`'s), degrees.
const FREE_FOVY_DEGREES: f32 = 50.0;
/// The pan's speed at the screen's centre, pixels a frame (SH-15).
const PAN_PX_PER_FRAME: f32 = 2.0;
/// The orbit's speed, degrees a frame (SH-15).
const ORBIT_DEGREES_PER_FRAME: f32 = 0.25;
/// The dolly's speed, metres a frame (a run): 12 m over the measured frames, so trees in the woods
/// behind the cabin cross the LOD distances (`TREE_LOD_DISTANCES`, 24 and 58 m).
const DOLLY_METRES_PER_FRAME: f32 = 0.1;
/// How far the mobile-high path trucks across the cabin's front axis, metres either side, how far
/// out in front of the cabin it walks, and its eye height over the ground.
const CABIN_TRUCK_METRES: f32 = 4.0;
const CABIN_FRONT_METRES: f32 = 12.0;
const CABIN_EYE_HEIGHT: f32 = 2.2;
/// How far each path moves the picture in a frame at most (the near ground's motion), pixels: the
/// pop test's envelope radius. Measured from the paths' geometry at 1280x720: the pan turns 2 px
/// everywhere; the orbit's near ground (11 m below the wide shot's eye) moves about 7.5 px; the
/// dolly's (3 m ahead) about 10; the truck's about 15.
const PAN_RADIUS: usize = 3;
const ORBIT_RADIUS: usize = 9;
const DOLLY_RADIUS: usize = 11;
const TRUCK_RADIUS: usize = 16;
/// The free camera's eye height over the ground on the paths that walk, metres.
const EYE_HEIGHT: f32 = 1.7;

/// bench-outdoor's lake box (x, y, width, height at 1280x720): the water and the tree shadows on it
/// (research-temporal.md T-01: 183 flickering pixels still, 4,706 creeping at high).
const LAKE_BOX: [u32; 4] = [540, 380, 740, 300];
/// The lake box's creeping or panning flicker may reach this multiple of the still camera's (P2-0.2).
const LAKE_BOX_CREEP_RATIO_MAX: f64 = 1.2;
/// How far the drifting lake moves a frame, world units: far below a pixel (P2-0.2).
const LAKE_DRIFT_M: f32 = 1e-4;
/// A pixel is away from the geometry's edges when its luma varies by less than this many levels
/// within this radius (P2-0.2's drifting-lake row).
const FLAT_LEVELS: f64 = 12.0;
const FLAT_RADIUS: usize = 2;
/// The pans the lake box is held on, pixels a frame at [`BENCH_DEPTH`] (P2-0.2).
const LAKE_PAN_PX: [f32; 2] = [1.0, 4.0];
/// The creeping camera's mean flicker share at high and ultra (G0, P2-0.8: medium's, MSAA).
const CREEPING_SHARE_MAX: f64 = 0.0016;
/// Frames the bench-outdoor rows draw, and the last ones they compare (each with the next).
const BENCH_FRAMES: u32 = 48;
const BENCH_COMPARED: u32 = 12;
/// The creep (the pass-1 row's) and the pans (T-12 (a)), pixels a frame at [`BENCH_DEPTH`] metres.
const CREEP_PX: f32 = 0.02;
const PAN_PX: [f32; 3] = [1.0, 4.0, 16.0];
const BENCH_DEPTH: f32 = 20.0;
/// The pan whose sharpness ratio is held (P2-0.8), and the least ratio.
const SHARP_PAN_PX: f32 = 4.0;
const SHARPNESS_RATIO_MIN: f64 = 0.85;

/// The evidence folder of these rows.
fn out_dir() -> PathBuf {
    let dir = std::env::var_os("GENEX_MOTION_OUT").map_or_else(|| support::evidence_dir("pass2/motion-rows"), PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the motion rows folder");
    dir
}

/// Rec. 709 luma (0..255) of every pixel.
fn lumas(capture: &Capture) -> Vec<f32> {
    capture.bgra().chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// A frame's luma with its local envelope: the least and greatest luma within `radius` pixels
/// of each pixel (a square box), so a pixel's value can be looked for wherever the camera's motion
/// moved it by the next frame.
struct Envelope {
    luma: Vec<f32>,
    least: Vec<f32>,
    most: Vec<f32>,
}

/// The box minimum (`pick` = `f32::min`) or maximum of `values` (`width` per row) over `radius`,
/// separably.
fn box_filter(values: &[f32], width: usize, radius: usize, pick: fn(f32, f32) -> f32) -> Vec<f32> {
    let height = values.len() / width;
    let mut rows = vec![0.0; values.len()];
    for y in 0..height {
        for x in 0..width {
            let (x0, x1) = (x.saturating_sub(radius), (x + radius).min(width - 1));
            rows[y * width + x] = values[y * width + x0..=y * width + x1].iter().copied().reduce(pick).unwrap_or(0.0);
        }
    }
    let mut out = vec![0.0; values.len()];
    for y in 0..height {
        let (y0, y1) = (y.saturating_sub(radius), (y + radius).min(height - 1));
        for x in 0..width {
            out[y * width + x] = (y0..=y1).map(|row| rows[row * width + x]).reduce(pick).unwrap_or(0.0);
        }
    }
    out
}

impl Envelope {
    fn of(capture: &Capture, radius: usize) -> Envelope {
        let luma = lumas(capture);
        let width = capture.width() as usize;
        Envelope { least: box_filter(&luma, width, radius, f32::min), most: box_filter(&luma, width, radius, f32::max), luma }
    }

    /// Whether `value` lies within `levels` of the luma near pixel `i`.
    fn holds(&self, i: usize, value: f32, levels: f64) -> bool {
        f64::from(self.least[i] - value) <= levels && f64::from(value - self.most[i]) <= levels
    }
}

/// Whether frame `now` pops at pixel `i`: its luma is found nowhere near the pixel in the frame
/// before nor in the frame after, while those two frames agree there (it came back). A moving
/// camera carries a pixel's value to a neighbour within the envelope's radius, so motion is no pop.
fn pops_at(before: &Envelope, now: &Envelope, after: &Envelope, i: usize) -> bool {
    let value = now.luma[i];
    let came_back = after.holds(i, before.luma[i], POP_LEVELS) || before.holds(i, after.luma[i], POP_LEVELS);
    !before.holds(i, value, POP_LEVELS) && !after.holds(i, value, POP_LEVELS) && came_back
}

/// Whether pixel `i`'s own luma in frame `now` jumps by more than [`POP_LEVELS`] from the frames
/// before and after, the same way, while those two agree within it: SH-15's plain one-frame pop.
fn excursion_at(before: &Envelope, now: &Envelope, after: &Envelope, i: usize) -> bool {
    let (b, n, a) = (f64::from(before.luma[i]), f64::from(now.luma[i]), f64::from(after.luma[i]));
    let same_way = (n - b).signum() == (n - a).signum();
    (n - b).abs() > POP_LEVELS && (n - a).abs() > POP_LEVELS && same_way && (b - a).abs() <= POP_LEVELS
}

/// What pops in a shadows-off run at each frame, for attributing a shadows-on run's pops (owner
/// decision D12): its envelope pops and its plain one-frame excursions.
fn off_pops(off: &Run) -> Vec<Vec<u32>> {
    off.pops.iter().zip(&off.excursions).map(|(pops, excursions)| pops.iter().chain(excursions).copied().collect()).collect()
}

/// What a run of frames did, frame by frame.
struct Run {
    /// How far (pixels) a frame's motion may carry a value to the next: the envelope's radius.
    radius: usize,
    /// The pixels that popped in each measured frame (the first and last have no pair on one side).
    pops: Vec<Vec<u32>>,
    /// The pixels whose own luma jumped by more than [`POP_LEVELS`] for exactly one frame and came
    /// back, in each measured frame (SH-15's plain test, without the motion envelope): what pops
    /// in a shadows-off run when a shadows-on run's pop is attributed (owner decision D12).
    excursions: Vec<Vec<u32>>,
    /// The pixels that flickered into each frame from the last: a luma more than
    /// [`FLICKER_LEVELS`] from every value within the radius in the frame before (on a still
    /// camera, the pass-1 row's per-pixel flicker; on a moving one, what the motion does not explain).
    flickers: Vec<Vec<u32>>,
    /// Every pixel that popped in any frame (the evidence map).
    popped: Vec<bool>,
    /// The last frame.
    last: Option<Capture>,
    /// The last two frames' envelopes.
    window: Vec<Envelope>,
    /// Every frame, when the run keeps them (the evidence of its worst frame).
    frames: Option<Vec<Capture>>,
    /// The pixels of the last frame whose own motion (the renderer's motion target) carried them
    /// farther than the radius since the frame before, when the run reads it.
    fast: Option<Vec<bool>>,
}

impl Run {
    /// A run whose frames move values by at most `radius` pixels a frame.
    fn new(radius: usize) -> Run {
        Run { radius, pops: Vec::new(), excursions: Vec::new(), flickers: Vec::new(), popped: Vec::new(), last: None, window: Vec::new(), frames: None, fast: None }
    }

    /// [`Run::new`], keeping every frame.
    fn keeping(radius: usize) -> Run {
        Run { frames: Some(Vec::new()), ..Run::new(radius) }
    }

    /// Take the next frame.
    fn push(&mut self, capture: Capture) {
        self.push_moving(capture, None);
    }

    /// Take the next frame and `fast`, its pixels that moved farther than the radius since the
    /// frame before (the renderer's motion; None: not read). The envelope cannot judge such a
    /// pixel (its value left the box), so it neither flickers nor pops: a near post the dolly
    /// sweeps past at 30 pixels a frame popped all over in both runs of a pair, and the runs'
    /// differing light made the two pop sets differ pixel by pixel.
    fn push_moving(&mut self, capture: Capture, fast: Option<Vec<bool>>) {
        let next = Envelope::of(&capture, self.radius);
        if self.popped.is_empty() {
            self.popped = vec![false; next.luma.len()];
        }
        let judged = |fast: &Option<Vec<bool>>, i: usize| fast.as_ref().is_none_or(|fast| !fast[i]);
        if let Some(previous) = self.window.last() {
            let flickered = (0..next.luma.len())
                .filter(|i| judged(&fast, *i) && !previous.holds(*i, next.luma[*i], FLICKER_LEVELS))
                .map(|i| i as u32)
                .collect();
            self.flickers.push(flickered);
        }
        if let [before, now] = self.window.as_slice() {
            let popped: Vec<u32> = (0..next.luma.len())
                .filter(|i| judged(&fast, *i) && judged(&self.fast, *i) && pops_at(before, now, &next, *i))
                .map(|i| i as u32)
                .collect();
            for i in &popped {
                self.popped[*i as usize] = true;
            }
            self.pops.push(popped);
            self.excursions.push((0..next.luma.len()).filter(|i| excursion_at(before, now, &next, *i)).map(|i| i as u32).collect());
        }
        self.window.push(next);
        if self.window.len() > 2 {
            self.window.remove(0);
        }
        if let Some(frames) = &mut self.frames {
            frames.push(capture.clone());
        }
        self.last = Some(capture);
        self.fast = fast;
    }

    fn pixels(&self) -> f64 {
        self.popped.len().max(1) as f64
    }

    /// Each frame's flicker share.
    fn flicker(&self) -> Vec<f64> {
        self.flickers.iter().map(|frame| frame.len() as f64 / self.pixels()).collect()
    }

    fn mean_flicker(&self) -> f64 {
        mean(&self.flicker())
    }

    fn max_flicker(&self) -> f64 {
        self.flicker().into_iter().fold(0.0, f64::max)
    }

    fn total_pops(&self) -> usize {
        self.pops.iter().map(Vec::len).sum()
    }

    /// The last frame with every pixel that popped painted magenta.
    fn pop_map(&self) -> Capture {
        let last = self.last.as_ref().expect("a frame");
        let mut bgra = last.bgra().to_vec();
        for (i, popped) in self.popped.iter().enumerate() {
            if *popped {
                bgra[i * 4..i * 4 + 4].copy_from_slice(&[255, 0, 255, 255]);
            }
        }
        Capture::new(last.width(), last.height(), bgra).expect("a capture of the same size")
    }
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

/// The pixels `on` flags in frame `frame` and `off` does not, as (x, y) at `width`, at most
/// [`WORST_PIXELS_LISTED`]: where a row's worst frame popped (the record's evidence aid).
fn attributed_pixels(on: &[Vec<u32>], off: &[Vec<u32>], frame: usize, width: usize) -> Vec<(usize, usize)> {
    let (Some(on), Some(off)) = (on.get(frame), off.get(frame)) else { return Vec::new() };
    on.iter().filter(|i| !off.contains(i)).take(WORST_PIXELS_LISTED).map(|i| (*i as usize % width, *i as usize / width)).collect()
}

/// The most pixels a row's record lists for its worst frame.
const WORST_PIXELS_LISTED: usize = 48;

/// What `on` adds over `off` in each frame: the pixels flagged in `on` and not at the same pixel of
/// the same frame in `off` (the runs follow one camera path over one simulation, so a pixel the
/// geometry, the texture or the animation flags is flagged in both).
fn attributed(on: &[Vec<u32>], off: &[Vec<u32>], pixels: usize) -> Vec<usize> {
    let mut flagged = vec![false; pixels];
    on.iter()
        .zip(off)
        .map(|(on, off)| {
            for i in off {
                flagged[*i as usize] = true;
            }
            let added = on.iter().filter(|i| !flagged[**i as usize]).count();
            for i in off {
                flagged[*i as usize] = false;
            }
            added
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Lakeside paths

/// A camera path: the free camera's eye and target at measured frame `k` (negative while warming).
type Path = fn(f32) -> (Vec3, Vec3);

/// A point `height` over the ground (or the water) at (x, z).
fn over_ground(x: f32, z: f32, height: f32) -> Vec3 {
    vec3(x, showcase_game::layout::height(x, z).max(showcase_game::layout::WATER_LEVEL) + height, z)
}

/// The yaw one pixel at the screen's centre turns, radians.
fn pixel_angle() -> f32 {
    let [_, height] = showcase_game::showcase::WORLD_SIZE;
    2.0 * genex::math::tan(FREE_FOVY_DEGREES.to_radians() * 0.5) / height as f32
}

/// `v` turned `angle` radians about +y.
fn turned(v: Vec3, angle: f32) -> Vec3 {
    let (s, c) = genex::math::sin_cos(angle);
    vec3(v.x * c - v.z * s, v.y, v.x * s + v.z * c)
}

/// The wide shot's camera turning about its eye at [`PAN_PX_PER_FRAME`] (the lake, its shore
/// trees and their shadows sweep across the screen).
fn pan(k: f32) -> (Vec3, Vec3) {
    let shot = SHOTS[0];
    let (eye, target) = (shot.eye(), shot.target());
    (eye, eye + turned(target - eye, k * PAN_PX_PER_FRAME * pixel_angle()))
}

/// The wide shot's camera orbiting its target at [`ORBIT_DEGREES_PER_FRAME`].
fn orbit(k: f32) -> (Vec3, Vec3) {
    let shot = SHOTS[0];
    let (eye, target) = (shot.eye(), shot.target());
    (target + turned(eye - target, (k * ORBIT_DEGREES_PER_FRAME).to_radians()), target)
}

/// The cabin shot's camera walking towards the cabin at [`DOLLY_METRES_PER_FRAME`], from 12 m
/// behind the shot's eye to it: the woods behind the cabin cross the tree LOD distances.
fn dolly(k: f32) -> (Vec3, Vec3) {
    let shot = SHOTS[2];
    let (eye, target) = (shot.eye(), shot.target());
    let along = (target - eye).normalize();
    let back = (PATH_FRAMES as f32 - k.max(0.0)) * DOLLY_METRES_PER_FRAME;
    let at = eye - along * back;
    let at = over_ground(at.x, at.z, EYE_HEIGHT);
    (at, at + along * 10.0)
}

/// A camera trucking sideways in front of the cabin, [`CABIN_FRONT_METRES`] out along its front
/// axis and [`CABIN_TRUCK_METRES`] either side of it, looking straight at the cabin: on a phone
/// class (one shadowed spot slot) the nearer front window's spot holds the slot, and the slot
/// changes hands as the camera crosses the axis halfway (SH-07, LG-01).
fn cabin_truck(k: f32) -> (Vec3, Vec3) {
    use showcase_game::layout::{CABIN, CABIN_FLOOR, CABIN_YAW};
    let turn = genex::math::Quat::from_rotation_y(CABIN_YAW);
    let origin = vec3(CABIN.x, CABIN_FLOOR, CABIN.y);
    let across = -CABIN_TRUCK_METRES + 2.0 * CABIN_TRUCK_METRES * (k.max(0.0) / PATH_FRAMES as f32);
    let at = origin + turn * vec3(across, 0.0, CABIN_FRONT_METRES);
    (over_ground(at.x, at.z, CABIN_EYE_HEIGHT), origin + turn * vec3(across, 1.2, 0.0))
}

/// How a Lakeside run is drawn: the preset, the class it emulates and the features switched off.
struct Drawn {
    preset: QualityPreset,
    class: DeviceClass,
    off: Vec<RenderFeature>,
}

/// The features both runs of a shadow row switch off, so the pair differs by the shadows alone.
/// G0 (2026-10-15): bloom is screen-space, so the sun's disc entering the pan's frame (and the
/// dolly's lamp leaving it) brightened its glare over four frames in both runs; the glare lifts a
/// shadowed pixel past the flicker threshold sooner than a sunlit one (the tone curve), and that
/// difference was counted as the shadows changing 1.2-1.3% of the picture at once. The glare's
/// own onset is held by [`metal_lakeside_the_sun_s_glare_enters_the_pan_without_a_step`].
/// Owner decision D12 (2026-10-16): the pair is drawn at the same exposure, so auto exposure is off
/// in both (the shadows otherwise change what it meters, and every pixel's luma with it).
const SHADOW_ROW_ISOLATED: &[RenderFeature] = &[RenderFeature::Bloom, RenderFeature::Exposure];

/// The features a run without the sun's shadows switches off.
const SUN_SHADOWS: &[RenderFeature] = &[RenderFeature::Shadows, RenderFeature::ContactShadows];
/// The features a run without spot shadows switches off.
const SPOT_SHADOWS: &[RenderFeature] = &[RenderFeature::SpotShadows];

/// The Lakeside drawn Live along `path` as `drawn` says: [`WARM_FRAMES`] on the first pose, then
/// [`PATH_FRAMES`] measured. None without a presenter (no adapter).
fn lakeside_run(path: Path, radius: usize, drawn: &Drawn, keep: bool) -> Option<Run> {
    lakeside_run_at(path, radius, drawn, keep, None, &mut |_| {})
}

/// [`lakeside_run`] in a window of `window` pixels (Live draws at the window's pixels up to the
/// class's reference resolution; None: the world size), handing every measured frame to `sink`.
fn lakeside_run_at(path: Path, radius: usize, drawn: &Drawn, keep: bool, window: Option<(u32, u32)>, sink: &mut dyn FnMut(&Capture)) -> Option<Run> {
    let mut presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).ok()?;
    if let Some(window) = window {
        presenter.set_window_size(window);
    }
    let mut runtime = lakeside_at(SHOT_TICK);
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    let pose = |runtime: &mut genex::Runtime<showcase_game::world::World>, k: f32| {
        let (eye, target) = path(k);
        let world = &mut runtime.sim_mut().world;
        world.mode = CameraMode::Free;
        world.hud_hidden = true;
        world.free = FreeCam::looking(eye, target);
    };
    pose(&mut runtime, 0.0);
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let change = RenderChange {
        preset: Some(Some(PresetChoice::Preset(drawn.preset))),
        device_class: Some(Some(drawn.class)),
        features: drawn.off.iter().map(|feature| (*feature, false)).collect(),
        render_scale_lock: Some(Some(1.0)),
        ..RenderChange::default()
    };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.resilient.renderer_mut().renderer_mut().set_depth_readback(true);
    let mut run = if keep { Run::keeping(radius) } else { Run::new(radius) };
    for k in 0..WARM_FRAMES + PATH_FRAMES {
        runtime.step(FIXED_STEP_MS);
        pose(&mut runtime, k as f32 - WARM_FRAMES as f32);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        if k >= WARM_FRAMES {
            let capture = presenter.resilient.capture().expect("the Live picture");
            sink(&capture);
            let fast = fast_pixels(&presenter, (capture.width(), capture.height()), radius);
            run.push_moving(capture, fast);
        }
    }
    assert!(presenter.take_pass_refusals().is_empty(), "every pass draws");
    Some(run)
}

/// The pixels of the last Live frame whose motion (the renderer's motion target, NDC) carried them
/// farther than `radius` pixels on either axis; None when the frame wrote no motion (no TAA) or at
/// another size than the picture.
fn fast_pixels(presenter: &Presenter, (width, height): (u32, u32), radius: usize) -> Option<Vec<bool>> {
    let resilient = &presenter.resilient;
    let motion = resilient.renderer().renderer().read_motion(resilient.gpu()).ok()?;
    if motion.len() != (width * height) as usize {
        return None;
    }
    let limit = radius as f32;
    let (half_w, half_h) = (width as f32 * 0.5, height as f32 * 0.5);
    Some(motion.iter().map(|m| (m[0] * half_w).abs() > limit || (m[1] * half_h).abs() > limit).collect())
}

/// One Lakeside row: `path` drawn as `drawn` with and without `shadows`; the record and, when the
/// shadows add pops, the problem.
fn lakeside_row(name: &str, (path, radius): (Path, usize), preset: QualityPreset, class: DeviceClass, shadows: &'static [RenderFeature]) -> Option<(String, Option<String>)> {
    let on = lakeside_run(path, radius, &Drawn { preset, class, off: SHADOW_ROW_ISOLATED.to_vec() }, true)?;
    let off = lakeside_run(path, radius, &Drawn { preset, class, off: [shadows, SHADOW_ROW_ISOLATED].concat() }, false)?;
    let label = format!("{name}-{}-{}", preset.wire(), class.wire());
    Some(judge_row(&label, radius, &on, &off, class))
}

/// The record of a shadow row's pair of runs (`on` with the shadows, `off` without) and, when the
/// shadows add pops or flicker past the bounds, the problem; its maps written under `label`.
fn judge_row(label: &str, radius: usize, on: &Run, off: &Run, class: DeviceClass) -> (String, Option<String>) {
    write_png(&out_dir().join(format!("pops-{label}.png")), &on.pop_map());
    write_png(&out_dir().join(format!("pops-{label}-shadows-off.png")), &off.pop_map());
    let pixels = on.popped.len();
    // D12 flipped: an on-run pop at a pixel that also pops at the same frame of the off run by
    // SH-15's plain test (not only by the envelope) is not the shadows'.
    let off_popped = off_pops(off);
    let pops = attributed(&on.pops, &off_popped, pixels);
    let worst = pops.iter().copied().max().unwrap_or(0);
    let worst_frame = pops.iter().position(|count| *count == worst).unwrap_or(0);
    let total: usize = pops.iter().sum();
    let width = on.last.as_ref().map_or(1, |last| last.width() as usize);
    let worst_pixels: Vec<String> = attributed_pixels(&on.pops, &off_popped, worst_frame, width).iter().map(|(x, y)| format!("[{x}, {y}]")).collect();
    let flicker: Vec<f64> = attributed(&on.flickers, &off.flickers, pixels).iter().map(|count| *count as f64 / on.pixels()).collect();
    let (flicker_mean, flicker_max) = (mean(&flicker), flicker.iter().copied().fold(0.0, f64::max));
    let step_frame = flicker.iter().position(|share| *share == flicker_max).unwrap_or(0);
    write_step(label, on, off, step_frame);
    let record = format!(
        "{{\"row\": \"{label}\", \"frames\": {PATH_FRAMES}, \"radiusPx\": {radius}, \"popsOn\": {}, \"popsOff\": {}, \"shadowPops\": {total}, \"worstShadowPops\": {worst}, \"worstFrame\": {worst_frame}, \"worstPixels\": [{}], \"shadowFlickerMean\": {flicker_mean:.5}, \"shadowFlickerMax\": {flicker_max:.5}, \"stepFrame\": {step_frame}, \"flickerOnMean\": {:.5}, \"flickerOffMean\": {:.5}}}",
        on.total_pops(),
        off.total_pops(),
        worst_pixels.join(", "),
        on.mean_flicker(),
        off.mean_flicker()
    );
    eprintln!("{record}");
    let mut problems = Vec::new();
    if worst as f64 / on.pixels() > shadow_pop_share_max(class) {
        problems.push(format!("the shadows pop {worst} pixels for one frame at frame {worst_frame} ({total} over the path)"));
    }
    if flicker_mean > SHADOW_FLICKER_SHARE_MAX {
        problems.push(format!("the shadows flicker on {:.3}% of pixels a frame (worst frame {:.3}%)", flicker_mean * 100.0, flicker_max * 100.0));
    }
    if flicker_max > SHADOW_STEP_SHARE_MAX {
        problems.push(format!("the shadows change {:.3}% of the picture at once at frame {step_frame}", flicker_max * 100.0));
    }
    let problem = (!problems.is_empty()).then(|| format!("{label}: {}", problems.join("; ")));
    (record, problem)
}

/// Write the frames around the shadows' worst single-frame change (`step` is the change from frame
/// `step` to the next): the frame before, and the frame after with the pixels the shadows changed
/// painted magenta.
fn write_step(label: &str, on: &Run, off: &Run, step: usize) {
    let Some(frames) = &on.frames else { return };
    let (Some(before), Some(after)) = (frames.get(step), frames.get(step + 1)) else { return };
    let changed = attributed(&on.flickers[step..=step], &off.flickers[step..=step], on.popped.len());
    let mut flagged = vec![false; on.popped.len()];
    for i in &off.flickers[step] {
        flagged[*i as usize] = true;
    }
    let mut bgra = after.bgra().to_vec();
    for i in on.flickers[step].iter().filter(|i| !flagged[**i as usize]) {
        let at = *i as usize * 4;
        bgra[at..at + 4].copy_from_slice(&[255, 0, 255, 255]);
    }
    debug_assert_eq!(changed[0], on.flickers[step].iter().filter(|i| !flagged[**i as usize]).count());
    write_png(&out_dir().join(format!("step-{label}-before.png")), before);
    write_png(&out_dir().join(format!("step-{label}.png")), &Capture::new(after.width(), after.height(), bgra).expect("a capture of the same size"));
}

/// The reference class captures draw on (desktop-high).
fn desktop_high() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// Write `records` as `<name>.json` and fail with `problems`.
fn finish(name: &str, records: &[String], problems: &[String]) {
    std::fs::write(out_dir().join(format!("{name}.json")), format!("{{\"rows\": [\n{}\n]}}\n", records.join(",\n"))).expect("record");
    assert!(problems.is_empty(), "{problems:#?}");
}

/// SH-15: the Lakeside at high and ultra panned at 2 px a frame, orbited at 0.25 degrees a frame
/// and dollied through the tree LOD distances, 120 frames each: the sun's shadows add no
/// one-frame pops.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_lakeside_shadows_add_no_one_frame_pops_on_a_pan_an_orbit_or_a_dolly() {
    if gpu().is_none() {
        return;
    }
    let mut records = Vec::new();
    let mut problems = Vec::new();
    let paths: [(&str, Path, usize); 3] = [("pan", pan, PAN_RADIUS), ("orbit", orbit, ORBIT_RADIUS), ("dolly", dolly, DOLLY_RADIUS)];
    for (name, path, radius) in paths {
        for preset in [QualityPreset::High, QualityPreset::Ultra] {
            let Some((record, problem)) = lakeside_row(name, (path, radius), preset, desktop_high(), SUN_SHADOWS) else { return };
            records.push(record);
            problems.extend(problem);
        }
    }
    finish("lakeside-paths", &records, &problems);
}

/// The most pixels the bloom may change in a single frame beyond what the motion explains, as a
/// share of the frame: the shadows' step bound ([`SHADOW_STEP_SHARE_MAX`]).
const GLARE_STEP_SHARE_MAX: f64 = SHADOW_STEP_SHARE_MAX;

/// G0 (2026-10-15): on the Lakeside pan the sun's disc enters the frame's top-right corner over
/// four frames, and its glare (screen-space bloom, which sees nothing beyond the screen) grew over
/// a quarter of the picture in those frames: 2% of the pixels changed in one frame beyond the
/// motion, with or without shadows. The glare adds no such step: the bloom-attributed flicker of
/// any frame stays within [`GLARE_STEP_SHARE_MAX`].
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_lakeside_the_sun_s_glare_enters_the_pan_without_a_step() {
    if gpu().is_none() {
        return;
    }
    let mut records = Vec::new();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let Some(on) = lakeside_run(pan, PAN_RADIUS, &Drawn { preset, class: desktop_high(), off: Vec::new() }, false) else { return };
        let Some(off) = lakeside_run(pan, PAN_RADIUS, &Drawn { preset, class: desktop_high(), off: vec![RenderFeature::Bloom] }, false) else { return };
        let steps: Vec<f64> = attributed(&on.flickers, &off.flickers, on.popped.len()).iter().map(|count| *count as f64 / on.pixels()).collect();
        let worst = steps.iter().copied().fold(0.0, f64::max);
        let frame = steps.iter().position(|share| *share == worst).unwrap_or(0);
        let label = format!("glare-pan-{}", preset.wire());
        records.push(format!("{{\"row\": \"{label}\", \"frames\": {PATH_FRAMES}, \"glareStepMax\": {worst:.5}, \"stepFrame\": {frame}}}"));
        if worst > GLARE_STEP_SHARE_MAX {
            problems.push(format!("{label}: the glare changes {:.3}% of the picture at once at frame {frame}", worst * 100.0));
        }
    }
    finish("lakeside-glare", &records, &problems);
}

/// The Live window the plan's motion sequences draw at (section 7: 1440p, high and ultra).
const SEQUENCE_WINDOW: (u32, u32) = (2560, 1440);
/// The sequences' frame rate and x264 quality (constant rate factor: near-lossless, for the eye).
const SEQUENCE_FPS: u32 = 60;
const SEQUENCE_CRF: &str = "14";

/// An mp4 being written by ffmpeg from BGRA frames on its stdin (None without an ffmpeg on PATH).
struct Mp4 {
    child: std::process::Child,
    path: PathBuf,
}

impl Mp4 {
    fn start(path: &std::path::Path, (width, height): (u32, u32)) -> Option<Mp4> {
        let size = format!("{width}x{height}");
        let fps = SEQUENCE_FPS.to_string();
        let args = ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", &size, "-r", &fps, "-i", "-", "-c:v", "libx264", "-crf", SEQUENCE_CRF, "-pix_fmt", "yuv420p"];
        let child = std::process::Command::new("ffmpeg").args(args).arg(path).stdin(std::process::Stdio::piped()).spawn();
        match child {
            Ok(child) => Some(Mp4 { child, path: path.to_path_buf() }),
            Err(error) => {
                eprintln!("no mp4 for {}: ffmpeg did not start ({error})", path.display());
                None
            }
        }
    }

    fn push(&mut self, capture: &Capture) {
        use std::io::Write;
        if let Some(stdin) = self.child.stdin.as_mut() {
            stdin.write_all(capture.bgra()).expect("ffmpeg takes the frame");
        }
    }

    fn finish(mut self) {
        drop(self.child.stdin.take());
        let status = self.child.wait().expect("ffmpeg ends");
        assert!(status.success(), "ffmpeg wrote no {}", self.path.display());
    }
}

/// Section 7's motion evidence (G0 visual, 2026-10-15: no mp4 existed for the owner's "no
/// blinking" re-watch, and the rows ran at 1280x720 only): the Lakeside pan, orbit and dolly drawn
/// Live in a 1440p window at high and ultra, 120 frames each, written as
/// `sequences/<path>-<preset>-1440p.mp4` (ffmpeg on PATH) with each run's one-frame pop map and its
/// flicker and pop counts (`sequences/lakeside-sequences.json`). An evidence row: the gated
/// metrics are the 720p rows above.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_lakeside_motion_paths_at_1440p_are_written_for_the_owner() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir().join("sequences");
    std::fs::create_dir_all(&dir).expect("the sequences folder");
    let scale = (SEQUENCE_WINDOW.1 / showcase_game::showcase::WORLD_SIZE[1]) as usize;
    let paths: [(&str, Path, usize); 3] = [("pan", pan, PAN_RADIUS), ("orbit", orbit, ORBIT_RADIUS), ("dolly", dolly, DOLLY_RADIUS)];
    let mut records = Vec::new();
    for (name, path, radius) in paths {
        for preset in [QualityPreset::High, QualityPreset::Ultra] {
            let label = format!("{name}-{}-1440p", preset.wire());
            let mut mp4 = Mp4::start(&dir.join(format!("{label}.mp4")), SEQUENCE_WINDOW);
            let mut size = None;
            let mut sink = |capture: &Capture| {
                size = Some((capture.width(), capture.height()));
                if let Some(mp4) = mp4.as_mut() {
                    mp4.push(capture);
                }
            };
            let drawn = Drawn { preset, class: desktop_high(), off: Vec::new() };
            let Some(run) = lakeside_run_at(path, radius * scale, &drawn, false, Some(SEQUENCE_WINDOW), &mut sink) else { return };
            if let Some(mp4) = mp4 {
                mp4.finish();
            }
            assert_eq!(size, Some(SEQUENCE_WINDOW), "{label}: Live draws at the window's pixels");
            write_png(&dir.join(format!("pops-{label}.png")), &run.pop_map());
            records.push(format!("{{\"row\": \"{label}\", \"frames\": {PATH_FRAMES}, \"radiusPx\": {}, \"pops\": {}, \"meanFlicker\": {:.5}, \"maxFlicker\": {:.5}}}", radius * scale, run.total_pops(), run.mean_flicker(), run.max_flicker()));
        }
    }
    finish("sequences/lakeside-sequences", &records, &[]);
}

/// SH-15 / SH-07: on mobile-high (one shadowed spot slot) the camera trucks across the cabin's axis,
/// so the two front windows' spots trade the slot: the spot shadows add no one-frame pops.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_lakeside_spot_shadows_add_no_one_frame_pops_across_the_cabin_on_mobile_high() {
    if gpu().is_none() {
        return;
    }
    let mobile_high = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);
    let Some((record, problem)) = lakeside_row("cabin-truck", (cabin_truck, TRUCK_RADIUS), QualityPreset::High, mobile_high, SPOT_SHADOWS) else { return };
    finish("lakeside-cabin-truck", &[record], &problem.into_iter().collect::<Vec<_>>());
}

/// P2-0.4 (RC-06): on mobile-high the far cascade was drawn every second frame and held whole on
/// the others, so the Lakeside's moving casters (the animals, the boat, the fireflies) cast it at
/// 30 Hz and doubled against the near cascade at the seam. A held cascade now keeps only what stood
/// still (within half a texel), so with them in its view the far cascade is drawn on every frame:
/// the frame's render passes stay the same instead of alternating. (A still or gently swaying far
/// cascade keeps the cadence: `shadow_cascades.rs`'s CPU rows.)
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_lakeside_on_a_phone_moving_casters_redraw_the_far_cascade_on_every_frame() {
    if gpu().is_none() {
        return;
    }
    let Some(mut presenter) = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).ok() else { return };
    let mut runtime = lakeside_at(SHOT_TICK);
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    let shot = SHOTS[0];
    let pose = |runtime: &mut genex::Runtime<showcase_game::world::World>| {
        let world = &mut runtime.sim_mut().world;
        world.mode = CameraMode::Free;
        world.hud_hidden = true;
        world.free = FreeCam::looking(shot.eye(), shot.target());
    };
    pose(&mut runtime);
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let change = RenderChange {
        preset: Some(Some(PresetChoice::Preset(QualityPreset::High))),
        device_class: Some(Some(DeviceClass::new(FormFactor::Mobile, PerformanceTier::High))),
        render_scale_lock: Some(Some(1.0)),
        ..RenderChange::default()
    };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    let mut passes = Vec::new();
    for k in 0..WARM_FRAMES + 12 {
        runtime.step(FIXED_STEP_MS);
        pose(&mut runtime);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        if k >= WARM_FRAMES {
            passes.push(presenter.resilient.renderer().renderer().last_stats().render_passes);
        }
    }
    std::fs::write(out_dir().join("lakeside-phone-cadence.json"), format!("{{\"renderPasses\": {passes:?}}}\n")).expect("record");
    assert!(passes.windows(2).all(|pair| pair[0] == pair[1]), "the far cascade is drawn on every frame, never held at half rate: {passes:?}");
}

/// How far the open-ground row's camera creeps sideways a frame, metres: about a tenth of a pixel
/// on the ground 10 m ahead (renderer pass 2, P2-0.3).
const MEADOW_CREEP_M: f32 = 0.002;
/// The open-ground row's envelope radius, pixels (the creep moves nothing by a whole pixel).
const MEADOW_RADIUS: usize = 1;

/// The sunlit open ground north of the forest shot's clearing (x -30..-21, z -34..-32: the terrain
/// and the canopies leave it in the 7 degree sun; most of the bowl lies in the far ridge's shadow at
/// this hour), looked at from 7 m south of it, creeping sideways at [`MEADOW_CREEP_M`].
fn open_ground_creep(k: f32) -> (Vec3, Vec3) {
    let along = k.max(0.0) * MEADOW_CREEP_M;
    (over_ground(-26.0 + along, -40.0, 2.5), over_ground(-25.0 + along, -33.0, 0.0))
}

/// The clearing below the wide shot, looked at from its western edge, creeping sideways at
/// [`MEADOW_CREEP_M`]: grass the far ridge shadows whole under the 7 degree sun (a march of the
/// terrain towards the sun from 72 of its points finds the ridge every time).
fn ridge_meadow_creep(k: f32) -> (Vec3, Vec3) {
    let along = k.max(0.0) * MEADOW_CREEP_M;
    (over_ground(-33.0, 15.0 + along, 1.7), over_ground(-23.0, 9.0 + along, 0.0))
}

/// Renderer pass 2, P2-0.3 (SH-02, SH-05, SH-06, S4): the far ridge's shadow over the meadow holds
/// while the camera creeps, at high and ultra. On the pass-1 head part of the meadow drew lit where
/// the ridge shadows it, and the shadow there switched in one frame: 11.6 % of the picture at high
/// and 12.0 % at ultra at frame 112 (mean shadow flicker 0.147 % and 0.139 %).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_lakeside_the_ridges_shadow_over_the_meadow_holds_while_the_camera_creeps() {
    if gpu().is_none() {
        return;
    }
    let mut records = Vec::new();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let Some((record, problem)) = lakeside_row("ridge-meadow-creep", (ridge_meadow_creep, MEADOW_RADIUS), preset, desktop_high(), SUN_SHADOWS) else { return };
        records.push(record);
        problems.extend(problem);
    }
    finish("lakeside-ridge-meadow-creep", &records, &problems);
}

/// Renderer pass 2, P2-0.3 (SH-11): open ground under the Lakeside's 7 degree sun holds still while
/// the camera creeps, at high and ultra. Its light depth climbs 8.1 per unit across the map, past
/// the receiver plane's old slope clamp of 4, so PCSS's sun-side taps could find the ground itself.
/// Under the Lakeside's 0.6 degree sun the search reaches too few texels for that to show: the row
/// was green on the pass-1 head too (0.046 % and 0.055 %; the 2 degree probe row in
/// genex-render's shadow_filter.rs is SH-11's red), and it holds the open ground still under every
/// later change (P2-0.3 measured shadow-texel-keyed filter noise there at 0.82 %).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_lakeside_open_ground_holds_still_under_the_low_sun_while_the_camera_creeps() {
    if gpu().is_none() {
        return;
    }
    let mut records = Vec::new();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let Some((record, problem)) = lakeside_row("open-ground-creep", (open_ground_creep, MEADOW_RADIUS), preset, desktop_high(), SUN_SHADOWS) else { return };
        records.push(record);
        problems.extend(problem);
    }
    finish("lakeside-open-ground-creep", &records, &problems);
}

// ---------------------------------------------------------------------------------------------
// Harbour Street (renderer pass 2, B.7: the shadow rows on the second scene, the street at dusk
// under its low sun with the sun's screen mask on desktop high and ultra)

/// A Harbour Street camera path: the free camera's eye and target at measured frame `k`.
type HarbourPath = fn(f32) -> (Vec3, Vec3);

/// Harbour Street's wide street shot.
fn harbour_wide() -> (Vec3, Vec3) {
    let shot = &showcase_game::harbour::SHOTS[0];
    (shot.eye, shot.target)
}

/// The yaw one pixel at the screen's centre turns in the street-wide shot, radians.
fn harbour_pixel_angle() -> f32 {
    let [_, height] = showcase_game::harbour::WORLD_SIZE;
    2.0 * genex::math::tan(showcase_game::harbour::SHOTS[0].fovy.to_radians() * 0.5) / height as f32
}

/// The street-wide shot turning about its eye at [`PAN_PX_PER_FRAME`].
fn harbour_pan(k: f32) -> (Vec3, Vec3) {
    let (eye, target) = harbour_wide();
    (eye, eye + turned(target - eye, k * PAN_PX_PER_FRAME * harbour_pixel_angle()))
}

/// The street-wide shot sliding sideways at [`CREEP_PX`] a frame at its target's distance.
fn harbour_creep(k: f32) -> (Vec3, Vec3) {
    let (eye, target) = harbour_wide();
    let side = (target - eye).cross(Vec3::Y).normalize();
    let step = side * (k * CREEP_PX * harbour_pixel_angle() * (target - eye).length());
    (eye + step, target + step)
}

/// Harbour Street drawn Live along `path` as `drawn` says ([`lakeside_run`]'s schedule).
fn harbour_run(path: HarbourPath, radius: usize, drawn: &Drawn, keep: bool) -> Option<Run> {
    use showcase_game::harbour::{CameraMode as HarbourCamera, FreeCam as HarbourFree, World as Harbour};
    let mut presenter = Presenter::open(showcase_game::harbour::WORLD_SIZE, showcase_game::harbour_assets()).ok()?;
    let mut runtime = genex::Runtime::new(showcase_game::harbour_game()).expect("installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(f64::from(SHOT_TICK) * FIXED_STEP_MS);
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    let pose = |runtime: &mut genex::Runtime<Harbour>, k: f32| {
        let (eye, target) = path(k);
        let world = &mut runtime.sim_mut().world;
        world.mode = HarbourCamera::Free;
        world.hud_hidden = true;
        world.free = HarbourFree::looking(eye, target);
    };
    pose(&mut runtime, -(WARM_FRAMES as f32));
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let change = RenderChange {
        preset: Some(Some(PresetChoice::Preset(drawn.preset))),
        device_class: Some(Some(drawn.class)),
        features: drawn.off.iter().map(|feature| (*feature, false)).collect(),
        render_scale_lock: Some(Some(1.0)),
        ..RenderChange::default()
    };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.resilient.renderer_mut().renderer_mut().set_depth_readback(true);
    let mut run = if keep { Run::keeping(radius) } else { Run::new(radius) };
    for k in 0..WARM_FRAMES + PATH_FRAMES {
        runtime.step(FIXED_STEP_MS);
        pose(&mut runtime, k as f32 - WARM_FRAMES as f32);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        if k >= WARM_FRAMES {
            let capture = presenter.resilient.capture().expect("the Live picture");
            let fast = fast_pixels(&presenter, (capture.width(), capture.height()), radius);
            run.push_moving(capture, fast);
        }
    }
    assert!(presenter.take_pass_refusals().is_empty(), "every pass draws");
    Some(run)
}

/// Renderer pass 2, B.7: Harbour Street's wide street panned at 2 px a frame and crept at a
/// fiftieth of a pixel, at high and ultra on desktop-high (the sun's screen mask on): its sun
/// shadows add no one-frame pops (D9), flicker on no more than 0.15% of pixels a frame and change
/// no more than 0.25% of the picture at once, as the Lakeside rows hold them.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_harbour_street_shadows_add_no_one_frame_pops_on_a_pan_or_a_creep() {
    if gpu().is_none() {
        return;
    }
    let mut records = Vec::new();
    let mut problems = Vec::new();
    let paths: [(&str, HarbourPath, usize); 2] = [("harbour-pan", harbour_pan, PAN_RADIUS), ("harbour-creep", harbour_creep, MEADOW_RADIUS)];
    for (name, path, radius) in paths {
        for preset in [QualityPreset::High, QualityPreset::Ultra] {
            let class = desktop_high();
            let Some(on) = harbour_run(path, radius, &Drawn { preset, class, off: SHADOW_ROW_ISOLATED.to_vec() }, true) else { return };
            let Some(off) = harbour_run(path, radius, &Drawn { preset, class, off: [SUN_SHADOWS, SHADOW_ROW_ISOLATED].concat() }, false) else { return };
            let (record, problem) = judge_row(&format!("{name}-{}-{}", preset.wire(), class.wire()), radius, &on, &off, class);
            records.push(record);
            problems.extend(problem);
        }
    }
    finish("harbour-street-paths", &records, &problems);
}

// ---------------------------------------------------------------------------------------------
// bench-outdoor

/// The lakeside's look, as `perf_matrix` draws every HDR profile with it.
fn lakeside_look() -> Look {
    let mut look = Look::default();
    look.tonemapper = Tonemapper::KhronosNeutral;
    look.exposure = ExposureMode::Auto;
    look.ev_compensation = showcase_game::showcase::LOOK_EV_COMPENSATION;
    look
}

/// bench-outdoor's last [`BENCH_COMPARED`] frames under `quality`, moving `px` pixels a frame (at
/// [`BENCH_DEPTH`]; `pixel` world units each), as a run.
fn bench_run(gpu: &Gpu, class: DeviceClass, quality: &Quality, px: f32, pixel: f32) -> Run {
    let mut run = Run::new(px.ceil() as usize + 1);
    for frame in bench_frames(gpu, class, quality, px * pixel) {
        run.push(frame);
    }
    run
}

/// One bench-outdoor pixel at [`BENCH_DEPTH`], world units.
fn bench_pixel(gpu: &Gpu) -> f32 {
    let probe = support::bench_stage_with(gpu, SceneId::Outdoor, [8, 8], RenderOptions::default()).1.scene(0);
    2.0 * BENCH_DEPTH * genex::math::tan(probe.camera.fovy_degrees.to_radians() * 0.5) / support::SIZE[1] as f32
}

/// bench-outdoor drawn Live under `quality` with the camera moving `step` world units sideways a
/// frame (the pass-1 shimmer row's frames): the last [`BENCH_COMPARED`] frames, kept whole (the lake
/// box reads every pair).
fn bench_frames(gpu: &Gpu, class: DeviceClass, quality: &Quality, step: f32) -> Vec<Capture> {
    bench_frames_drifting(gpu, class, quality, step, 0.0)
}

/// [`bench_frames`] with every transparent draw (the lake) also moved `drift` world units along x a
/// frame: a moving transparent, which TAA's reactive mask marks.
fn bench_frames_drifting(gpu: &Gpu, class: DeviceClass, quality: &Quality, step: f32, drift: f32) -> Vec<Capture> {
    bench_frames_moving(gpu, class, quality, step, drift).0
}

/// [`bench_frames_drifting`] with each kept frame's motion (the renderer's motion target: NDC
/// current minus previous, the jitter removed, top row first).
fn bench_frames_moving(gpu: &Gpu, class: DeviceClass, quality: &Quality, step: f32, drift: f32) -> (Vec<Capture>, Vec<Vec<[f32; 2]>>) {
    use genex_render::FrameRenderer;
    use genex_render::immediate::ImmediateFrame;
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut frames = FrameRenderer::new(gpu, support::SIZE[0], support::SIZE[1], options).expect("frame renderer");
    let loaded = showcase_game::bench::load(SceneId::Outdoor, &mut support::OnGpu { renderer: frames.renderer_mut(), gpu }).expect("the scene loads");
    let renderer = frames.renderer_mut();
    let rg11b10 = renderer.device_features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE);
    renderer.set_quality(quality);
    renderer.set_scene_format(scene_format(class, rg11b10));
    renderer.set_look(lakeside_look());
    renderer.set_device_class(class);
    renderer.set_depth_readback(true);
    let base = loaded.scene(0);
    let forward = Vec3::from(base.camera.target) - Vec3::from(base.camera.eye);
    let side = forward.cross(Vec3::Y).normalize();
    let mut kept = Vec::new();
    let mut motions = Vec::new();
    for k in 0..BENCH_FRAMES {
        let mut drawn = base.clone();
        let offset = side * step * k as f32;
        drawn.camera.eye = (Vec3::from(drawn.camera.eye) + offset).to_array();
        drawn.camera.target = (Vec3::from(drawn.camera.target) + offset).to_array();
        for draw in drawn.draws.iter_mut().filter(|draw| draw.material.is_transparent()) {
            draw.model[12] += drift * k as f32;
        }
        let mut frame = ImmediateFrame::from_scene(drawn);
        frame.set_tick(u64::from(k));
        frames.render(gpu, &frame, CullPath::Gpu, None).expect("a Live frame");
        if k >= BENCH_FRAMES - BENCH_COMPARED {
            kept.push(frames.capture(gpu).expect("capture"));
            motions.push(frames.renderer().read_motion(gpu).unwrap_or_default());
        }
    }
    (kept, motions)
}

/// The pixels of each pair of `frames` whose luma differs by more than [`FLICKER_LEVELS`] from
/// the frame before at the point the renderer's own `motions` (one per frame, as
/// [`bench_frames_moving`] reads them) say it came from (bilinear): what the motion does not
/// explain. A still camera's frames have no motion, so this is the plain per-pixel flicker; a frame
/// without motion (no TAA) is compared pixel to pixel.
fn compensated_flickers(frames: &[Capture], motions: &[Vec<[f32; 2]>]) -> Vec<Vec<u32>> {
    let lumas: Vec<Vec<f32>> = frames.iter().map(lumas).collect();
    let (width, height) = (frames[0].width() as usize, frames[0].height() as usize);
    let sample = |luma: &[f32], x: f32, y: f32| {
        let (x, y) = (x.clamp(0.0, (width - 1) as f32), y.clamp(0.0, (height - 1) as f32));
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(width - 1), (y0 + 1).min(height - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let row = |yy: usize| luma[yy * width + x0] * (1.0 - fx) + luma[yy * width + x1] * fx;
        row(y0) * (1.0 - fy) + row(y1) * fy
    };
    (1..frames.len())
        .map(|k| {
            let motion = motions.get(k).filter(|motion| motion.len() == width * height);
            (0..width * height)
                .filter(|i| {
                    let [mx, my] = motion.map_or([0.0, 0.0], |motion| motion[*i]);
                    let (x, y) = ((i % width) as f32 - mx * 0.5 * width as f32, (i / width) as f32 + my * 0.5 * height as f32);
                    f64::from((lumas[k][*i] - sample(&lumas[k - 1], x, y)).abs()) > FLICKER_LEVELS
                })
                .map(|i| i as u32)
                .collect()
        })
        .collect()
}

/// The last of `frames` with every pixel that flickered between any two consecutive frames painted
/// magenta (the pass-1 shimmer row's map).
fn flicker_map(frames: &[Capture]) -> Capture {
    let last = frames.last().expect("a frame");
    let lumas: Vec<Vec<f32>> = frames.iter().map(lumas).collect();
    let mut bgra = last.bgra().to_vec();
    for i in 0..lumas[0].len() {
        if lumas.windows(2).any(|pair| f64::from((pair[0][i] - pair[1][i]).abs()) > FLICKER_LEVELS) {
            bgra[i * 4..i * 4 + 4].copy_from_slice(&[255, 0, 255, 255]);
        }
    }
    Capture::new(last.width(), last.height(), bgra).expect("a capture of the same size")
}

/// `last` with every pixel of `flagged` (any frame's) painted magenta.
fn flagged_map(last: &Capture, flagged: &[Vec<u32>]) -> Capture {
    let mut bgra = last.bgra().to_vec();
    for i in flagged.iter().flatten() {
        let at = *i as usize * 4;
        bgra[at..at + 4].copy_from_slice(&[255, 0, 255, 255]);
    }
    Capture::new(last.width(), last.height(), bgra).expect("a capture of the same size")
}

/// `quality` without the sun's shadows ([`SUN_SHADOWS`]).
fn without_sun_shadows(quality: &Quality) -> Quality {
    let mut off = *quality;
    for feature in SUN_SHADOWS {
        off.set_feature(*feature, false);
    }
    off
}

/// How many of the pixels inside `region` (of a `width`-wide frame) any frame of `flickers` flagged.
fn flagged_in(flickers: &[Vec<u32>], width: u32, region: [u32; 4]) -> usize {
    let [x0, y0, w, h] = region;
    let mut flagged = std::collections::BTreeSet::new();
    for i in flickers.iter().flatten() {
        let (x, y) = (i % width, i / width);
        if (x0..x0 + w).contains(&x) && (y0..y0 + h).contains(&y) {
            flagged.insert(*i);
        }
    }
    flagged.len()
}

/// What the sun's shadows add to `on`'s flicker over `off`'s, frame by frame, as a share of the frame.
fn shadow_flicker(on: &Run, off: &Run) -> Vec<f64> {
    attributed(&on.flickers, &off.flickers, on.popped.len()).iter().map(|count| *count as f64 / on.pixels()).collect()
}

/// T-01 / T-12 (b): bench-outdoor creeping a fiftieth of a pixel a frame at high and ultra (the
/// pass-1 row's motion): the lake box flickers no more than 1.2x the still camera's, the sun's
/// shadows add at most 0.15% of flickering pixels a frame (P2-0.2, the row's own still bound), and
/// the creeping mean flicker share stays within medium's (MSAA) 0.16%. Pass-1 left the lake's
/// shadows blinking: 183 pixels still against 4,706 creeping at high.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_bench_outdoor_lake_box_holds_still_while_the_camera_creeps() {
    let Some(gpu) = gpu() else { return };
    let class = classify(gpu.device_facts());
    let step = CREEP_PX * bench_pixel(&gpu);
    let mut records = Vec::new();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, class);
        let (still, still_motion) = bench_frames_moving(&gpu, class, &quality, 0.0, 0.0);
        let (creeping, creeping_motion) = bench_frames_moving(&gpu, class, &quality, step, 0.0);
        // G0 (2026-10-15): the box's pixels compared at the point each one's motion came from. A
        // pixel-to-pixel comparison counted the trees' and rocks' silhouettes in the box sliding a
        // fiftieth of a pixel a frame (496 creeping against 34 still at high, with or without the
        // sun's shadows), and those are no flicker.
        let width = support::SIZE[0];
        let lake_still = flagged_in(&compensated_flickers(&still, &still_motion), width, LAKE_BOX);
        let creeping_flickers = compensated_flickers(&creeping, &creeping_motion);
        let lake_creeping = flagged_in(&creeping_flickers, width, LAKE_BOX);
        write_png(&out_dir().join(format!("lake-box-compensated-creeping-{}.png", preset.wire())), &flagged_map(creeping.last().expect("a frame"), &creeping_flickers));
        let mut run = Run::new(0);
        for frame in creeping.iter().cloned() {
            run.push(frame);
        }
        let mut off = Run::new(0);
        for frame in bench_frames(&gpu, class, &without_sun_shadows(&quality), step) {
            off.push(frame);
        }
        let shadows = shadow_flicker(&run, &off);
        let lake_shadows = flagged_in(&added_flickers(&run, &off), width, LAKE_BOX);
        write_png(&out_dir().join(format!("lake-box-creeping-shadows-{}.png", preset.wire())), &flagged_map(creeping.last().expect("a frame"), &added_flickers(&run, &off)));
        let (shadow_mean, shadow_max) = (mean(&shadows), shadows.iter().copied().fold(0.0, f64::max));
        let (mean, max) = (run.mean_flicker(), run.max_flicker());
        write_png(&out_dir().join(format!("lake-box-creeping-{}.png", preset.wire())), &run.pop_map());
        write_png(&out_dir().join(format!("lake-box-still-{}.png", preset.wire())), still.last().expect("a frame"));
        write_png(&out_dir().join(format!("lake-box-flicker-still-{}.png", preset.wire())), &flicker_map(&still));
        write_png(&out_dir().join(format!("lake-box-flicker-creeping-{}.png", preset.wire())), &flicker_map(&creeping));
        let record = format!(
            "{{\"row\": \"lake-box-{}\", \"lakeStill\": {lake_still}, \"lakeCreeping\": {lake_creeping}, \"meanFlicker\": {mean:.5}, \"maxFlicker\": {max:.5}, \"shadowFlickerMean\": {shadow_mean:.5}, \"shadowFlickerMax\": {shadow_max:.5}, \"lakeShadowCreeping\": {lake_shadows}, \"pops\": {}}}",
            preset.wire(),
            run.total_pops()
        );
        eprintln!("{record}");
        records.push(record);
        if lake_creeping as f64 > LAKE_BOX_CREEP_RATIO_MAX * lake_still.max(1) as f64 {
            problems.push(format!("{}: the lake box flickers on {lake_creeping} pixels creeping against {lake_still} still", preset.wire()));
        }
        if shadow_mean > SHADOW_FLICKER_SHARE_MAX {
            problems.push(format!("{}: the sun's shadows make {:.3}% of pixels flicker creeping (worst pair {:.3}%)", preset.wire(), shadow_mean * 100.0, shadow_max * 100.0));
        }
        if mean > CREEPING_SHARE_MAX {
            problems.push(format!("{}: {:.3}% of pixels flicker creeping (max over pairs {:.3}%)", preset.wire(), mean * 100.0, max * 100.0));
        }
    }
    finish("bench-outdoor-lake-box", &records, &problems);
}

/// T-01 (P2-0.2): bench-outdoor panned sideways at 1 and 4 px a frame at high and ultra: inside the
/// lake box, the pixels the motion does not explain (a luma found nowhere within the pan's radius
/// in the frame before) are no more than 1.2x the still camera's under the same radius, and the
/// sun's shadows add no more of them to the box than they add still.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_bench_outdoor_lake_box_holds_still_while_the_camera_pans() {
    let Some(gpu) = gpu() else { return };
    let class = classify(gpu.device_facts());
    let pixel = bench_pixel(&gpu);
    let width = support::SIZE[0];
    let mut records = Vec::new();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, class);
        let shadowless = without_sun_shadows(&quality);
        for px in LAKE_PAN_PX {
            let radius = px.ceil() as usize + 1;
            let runs = |step: f32| {
                let mut on = Run::new(radius);
                let mut off = Run::new(radius);
                for frame in bench_frames(&gpu, class, &quality, step) {
                    on.push(frame);
                }
                for frame in bench_frames(&gpu, class, &shadowless, step) {
                    off.push(frame);
                }
                (on, off)
            };
            let (still_on, still_off) = runs(0.0);
            let (pan_on, pan_off) = runs(px * pixel);
            let lake_still = flagged_in(&still_on.flickers, width, LAKE_BOX);
            let lake_pan = flagged_in(&pan_on.flickers, width, LAKE_BOX);
            // Recorded beside the envelope's counts (the gate's definition, G0: an owner question):
            // each box pixel against the point its own motion came from, as the creeping row reads it.
            let compensated = |step: f32| {
                let (frames, motion) = bench_frames_moving(&gpu, class, &quality, step, 0.0);
                flagged_in(&compensated_flickers(&frames, &motion), width, LAKE_BOX)
            };
            let (lake_still_compensated, lake_pan_compensated) = (compensated(0.0), compensated(px * pixel));
            let added = |on: &Run, off: &Run| flagged_in(&added_flickers(on, off), width, LAKE_BOX);
            let (shadow_still, shadow_pan) = (added(&still_on, &still_off), added(&pan_on, &pan_off));
            let last = pan_on.last.as_ref().expect("a frame");
            write_png(&out_dir().join(format!("lake-box-pan-{}-{px}px.png", preset.wire())), &flagged_map(last, &pan_on.flickers));
            write_png(&out_dir().join(format!("lake-box-pan-shadows-{}-{px}px.png", preset.wire())), &flagged_map(last, &added_flickers(&pan_on, &pan_off)));
            let record = format!(
                "{{\"row\": \"lake-box-pan-{}-{px}px\", \"radiusPx\": {radius}, \"lakeStill\": {lake_still}, \"lakePan\": {lake_pan}, \"lakeShadowStill\": {shadow_still}, \"lakeShadowPan\": {shadow_pan}, \"lakeStillCompensated\": {lake_still_compensated}, \"lakePanCompensated\": {lake_pan_compensated}}}",
                preset.wire()
            );
            eprintln!("{record}");
            records.push(record);
            if lake_pan as f64 > LAKE_BOX_CREEP_RATIO_MAX * lake_still.max(1) as f64 {
                problems.push(format!("{} at {px} px a frame: the lake box flickers on {lake_pan} pixels against {lake_still} still", preset.wire()));
            }
            if shadow_pan as f64 > LAKE_BOX_CREEP_RATIO_MAX * shadow_still.max(1) as f64 {
                problems.push(format!("{} at {px} px a frame: the shadows make {shadow_pan} lake-box pixels flicker against {shadow_still} still", preset.wire()));
            }
        }
    }
    finish("bench-outdoor-lake-box-pans", &records, &problems);
}

/// The pixels of `capture` away from any edge: their luma varies by less than [`FLAT_LEVELS`] within
/// [`FLAT_RADIUS`] pixels (drawn without shadows, so a shadow's edge is no edge here).
fn flat_pixels(capture: &Capture) -> Vec<bool> {
    let envelope = Envelope::of(capture, FLAT_RADIUS);
    envelope.least.iter().zip(&envelope.most).map(|(least, most)| f64::from(most - least) < FLAT_LEVELS).collect()
}

/// T-01 step 1 (P2-0.2): bench-outdoor under a still camera at high and ultra with the lake drifting
/// a tenth of a millimetre a frame (no visible motion, but a moving transparent, so TAA's reactive
/// mask takes most of its current sample): inside the lake box, away from the geometry's edges (the
/// shore, the trees over the water: a reactive transparent's edges flicker with the jitter, FSR2's
/// trade, which T-02's locks address), no more pixels flicker than on the still lake (1.2x). The
/// transparent pipeline turned its soft shadow taps and cascade band with the frame, and that noise
/// reached the screen unaveraged.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_bench_outdoor_lake_box_holds_still_while_the_lake_moves() {
    let Some(gpu) = gpu() else { return };
    let class = classify(gpu.device_facts());
    let width = support::SIZE[0];
    let mut records = Vec::new();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, class);
        let shadowless = bench_frames(&gpu, class, &without_sun_shadows(&quality), 0.0);
        let flat = flat_pixels(shadowless.last().expect("a frame"));
        let flat_flicker = |drift: f32| {
            let mut run = Run::new(0);
            for frame in bench_frames_drifting(&gpu, class, &quality, 0.0, drift) {
                run.push(frame);
            }
            let kept: Vec<Vec<u32>> = run.flickers.iter().map(|frame| frame.iter().copied().filter(|i| flat[*i as usize]).collect()).collect();
            (flagged_in(&kept, width, LAKE_BOX), flagged_map(run.last.as_ref().expect("a frame"), &kept))
        };
        let (lake_still, _) = flat_flicker(0.0);
        let (lake_drifting, map) = flat_flicker(LAKE_DRIFT_M);
        write_png(&out_dir().join(format!("lake-box-drifting-{}.png", preset.wire())), &map);
        let record = format!("{{\"row\": \"lake-box-drifting-{}\", \"lakeFlatStill\": {lake_still}, \"lakeFlatDrifting\": {lake_drifting}}}", preset.wire());
        eprintln!("{record}");
        records.push(record);
        if lake_drifting as f64 > LAKE_BOX_CREEP_RATIO_MAX * lake_still.max(1) as f64 {
            problems.push(format!("{}: with the lake drifting {lake_drifting} flat lake-box pixels flicker against {lake_still} still", preset.wire()));
        }
    }
    finish("bench-outdoor-lake-box-drifting", &records, &problems);
}

/// The pixels `on` flagged in each frame that `off` did not flag at the same pixel of that frame.
fn added_flickers(on: &Run, off: &Run) -> Vec<Vec<u32>> {
    on.flickers
        .iter()
        .zip(&off.flickers)
        .map(|(on, off)| {
            let off: std::collections::BTreeSet<u32> = off.iter().copied().collect();
            on.iter().copied().filter(|i| !off.contains(i)).collect()
        })
        .collect()
}

/// The mean squared 4-neighbour Laplacian of `capture`'s luma: its high-frequency energy.
fn laplacian_energy(capture: &Capture) -> f64 {
    let (w, h) = (capture.width() as usize, capture.height() as usize);
    let luma = lumas(capture);
    let mut total = 0.0;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let i = y * w + x;
            let lap = 4.0 * f64::from(luma[i]) - f64::from(luma[i - 1] + luma[i + 1] + luma[i - w] + luma[i + w]);
            total += lap * lap;
        }
    }
    total / ((w - 2) * (h - 2)) as f64
}

/// T-12 (a): bench-outdoor panned sideways at 1, 4 and 16 px a frame at every preset: the flicker
/// share and one-frame pops of each pan, and its sharpness (Laplacian energy) over the still
/// camera's. At 4 px a frame every preset keeps 85% of its still sharpness (P2-0.8), and a TAA
/// preset pops no more than medium (MSAA) on the same pan.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_bench_outdoor_pans_keep_their_sharpness_and_pop_no_more_than_msaa() {
    let Some(gpu) = gpu() else { return };
    let class = classify(gpu.device_facts());
    let pixel = bench_pixel(&gpu);
    let mut records = Vec::new();
    let mut problems = Vec::new();
    // Medium's (MSAA) pops on each pan, by the pan's place in [`PAN_PX`].
    let mut medium_pops: [Option<usize>; PAN_PX.len()] = [None; PAN_PX.len()];
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, class);
        let still = bench_run(&gpu, class, &quality, 0.0, pixel);
        let still_energy = laplacian_energy(still.last.as_ref().expect("a frame"));
        for (at, px) in PAN_PX.into_iter().enumerate() {
            let run = bench_run(&gpu, class, &quality, px, pixel);
            let ratio = laplacian_energy(run.last.as_ref().expect("a frame")) / still_energy.max(f64::MIN_POSITIVE);
            let pops = run.total_pops();
            write_png(&out_dir().join(format!("pan-{}-{px}px.png", preset.wire())), &run.pop_map());
            let record = format!(
                "{{\"row\": \"pan-{}-{px}px\", \"meanFlicker\": {:.5}, \"maxFlicker\": {:.5}, \"pops\": {pops}, \"sharpnessRatio\": {ratio:.4}}}",
                preset.wire(),
                run.mean_flicker(),
                run.max_flicker()
            );
            eprintln!("{record}");
            records.push(record);
            if preset == QualityPreset::Medium {
                medium_pops[at] = Some(pops);
            }
            let taa = quality.anti_aliasing == genex_render::settings::AntiAliasing::Taa;
            if let Some(msaa) = medium_pops[at].filter(|_| taa)
                && pops > msaa
            {
                problems.push(format!("{} at {px} px a frame: {pops} one-frame pops against medium's {msaa}", preset.wire()));
            }
            if px == SHARP_PAN_PX && ratio < SHARPNESS_RATIO_MIN {
                problems.push(format!("{} at {px} px a frame keeps {:.1}% of its still sharpness", preset.wire(), ratio * 100.0));
            }
        }
    }
    finish("bench-outdoor-pans", &records, &problems);
}
