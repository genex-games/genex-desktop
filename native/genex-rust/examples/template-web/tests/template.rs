//! The Rust template's starter scene (`src/game-template-rust/src/game.rs`) as a new game gets it:
//! its `genex.toml` `[render]` tables applied as the build lane compiles them in, a gear button
//! that opens the graphics settings panel, and (on the host GPU) a capture per quality preset and
//! per phone class on the HDR scene with the physical sky.
//!
//! The GPU row is `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-web \
//!     --release --offline --locked --test template -- --ignored metal --nocapture
//!
//! It writes `template-<preset|class>.png` and `template-digests.json` to `GENEX_TEMPLATE_OUT`
//! (default `.studio-dev/evidence/rust-renderer/captures/template`).

#[path = "../../../../../src/game-template-rust/src/game.rs"]
mod game;

use std::path::PathBuf;

use genex::render::{DegradeReason, DeviceClass, ExposureMode, PresetChoice, QualityPreset, RenderChange, RenderConfig, Tonemap};
use genex::{FIXED_STEP_MS, Game, Input, Runtime, View};

use game::{SETTINGS_BUTTON, World};

/// The template's manifest, whose `[render]` tables the build lane compiles into every destination.
const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/genex.toml");
/// The template's world size (`src/main.rs`).
const WORLD_SIZE: [u32; 2] = [960, 540];
/// The settings panel's switches header (genex-hud's settings panel), shown only while it is open.
const PANEL_FEATURES: &str = "Features";
/// Ticks a collapsing panel section takes to open (egui animates it over a sixth of a second).
const OPEN_TICKS: f64 = 12.0;
/// The tick the captures are taken at.
const SHOT_TICK: f64 = 60.0;
/// A pixel on the polished brass block's left face, seen at a grazing angle (RX review: GTAO's bent
/// normal took all its ambient light at high and ultra, (5,1,0) against medium's (80,60,40)).
const BLOCK_GRAZING_FACE: [u32; 2] = [436, 300];
/// The most the grazing face's luma (0..255) may differ from medium's at another preset or class.
const BLOCK_FACE_LUMA_TOLERANCE: f32 = 16.0;
/// The column the horizon is read along, and the rows it is searched in (the sky meets the floor there).
const HORIZON_COLUMN: u32 = 480;
const HORIZON_ROWS: std::ops::Range<u32> = 40..220;
/// How far either side of a row the horizon check looks for its brighter neighbours.
const HORIZON_WINDOW: u32 = 8;
/// The deepest a band at the horizon may sit below both its neighbours (RX review: a 5 px dark band
/// where the floor ended short of the horizon, about 45 levels below the sky and the floor).
const HORIZON_BAND_DEPTH_MAX: f32 = 12.0;

/// A patch of the floor inside the turning block's sun shadow at the capture tick (lit by the sky
/// alone), and the least share of its mean blue its mean red keeps (gate finding 03: [2, 21, 39],
/// a near-black navy, where the HDR scene holds a blue-grey sky-lit floor, about [44, 53, 65]
/// through no curve: AgX's punchy look at +0.5 EV crushed it).
const FLOOR_SHADOW: (std::ops::Range<u32>, std::ops::Range<u32>) = (530..550, 370..390);
const FLOOR_SHADOW_RED_SHARE_MIN: f32 = 0.25;

/// The mean (r, g, b) of `region` of a BGRA capture `width` wide.
fn mean_rgb(bgra: &[u8], width: u32, region: &(std::ops::Range<u32>, std::ops::Range<u32>)) -> [f32; 3] {
    let (xs, ys) = region.clone();
    let count = (xs.len() * ys.len()) as f32;
    let mut sum = [0.0; 3];
    for y in ys {
        for x in xs.clone() {
            let i = ((y * width + x) * 4) as usize;
            sum = [sum[0] + f32::from(bgra[i + 2]), sum[1] + f32::from(bgra[i + 1]), sum[2] + f32::from(bgra[i])];
        }
    }
    sum.map(|channel| channel / count)
}

/// The template's game as `src/main.rs` builds it, with the `[render]` tables a lane build reads.
fn template_game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Template").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the template's [render] tables are admitted"));
    game
}

fn started() -> Runtime<World> {
    let mut runtime = Runtime::new(template_game()).expect("the template's registrations are valid");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS);
    runtime
}

/// Where the HUD widget labelled `label` is, as a fraction of the world, if the last tick drew it.
fn widget_at(runtime: &Runtime<World>, label: &str) -> Option<[f32; 2]> {
    runtime.hud_widgets().into_iter().find(|widget| widget.label == label).map(|widget| widget.center_fraction(WORLD_SIZE))
}

/// Hover at `at` for a tick, then click there and run two ticks (egui's press and release).
fn click_at(runtime: &mut Runtime<World>, at: [f32; 2]) {
    runtime.inject(Input::pointer(at[0], at[1]));
    runtime.step(FIXED_STEP_MS);
    runtime.inject(Input::click_at(at[0], at[1]));
    runtime.step(FIXED_STEP_MS * 2.0);
}

fn click(runtime: &mut Runtime<World>, label: &str) {
    let at = widget_at(runtime, label).unwrap_or_else(|| panic!("the HUD draws {label}"));
    click_at(runtime, at);
}

#[test]
fn the_template_reads_its_genex_toml_look_agx_punchy_with_auto_exposure() {
    let runtime = started();
    let look = runtime.render().borrow().look();
    assert_eq!((look.tonemapper, look.exposure), (Tonemap::AgxPunchy, ExposureMode::Auto));
    // P2-0.10 flipped 1.5 to 0.5: punchy keeps middle grey, so the template keeps only the sunlit
    // scene's half EV.
    assert_eq!(look.ev_compensation, 0.5);
}

#[test]
fn the_template_draws_the_physical_sky_a_sun_and_pbr_surfaces() {
    let mut runtime = started();
    let frame = runtime.frame(View::Game).expect("a frame");
    assert_eq!(frame.declared_environment(), Some(&genex::render::Environment::sky()));
    let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
    assert_eq!(tags, ["floor", "block"]);
}

#[test]
fn the_gear_button_opens_the_settings_panel_and_a_choice_there_leaves_the_checksum_alone() {
    let mut runtime = started();
    assert!(widget_at(&runtime, PANEL_FEATURES).is_none(), "the panel starts closed");
    click(&mut runtime, SETTINGS_BUTTON);
    assert!(widget_at(&runtime, PANEL_FEATURES).is_some(), "the gear opens the graphics panel");
    assert_eq!(runtime.state()["starter"]["settingsOpen"], genex::json!(true));

    // The same clicks with and without a switch flipped in between: one checksum.
    let mut untouched = started();
    click(&mut untouched, SETTINGS_BUTTON);
    click(&mut runtime, PANEL_FEATURES);
    runtime.step(FIXED_STEP_MS * OPEN_TICKS);
    click(&mut untouched, PANEL_FEATURES);
    untouched.step(FIXED_STEP_MS * OPEN_TICKS);
    let before = runtime.render().borrow().answer().features;
    click(&mut runtime, "Shadows");
    click_at(&mut untouched, [0.01, 0.99]);
    assert_ne!(runtime.render().borrow().answer().features, before, "the panel switched shadows");
    click(&mut runtime, SETTINGS_BUTTON);
    click(&mut untouched, SETTINGS_BUTTON);
    assert!(widget_at(&runtime, PANEL_FEATURES).is_none(), "the gear closes it again");
    assert_eq!(runtime.tick(), untouched.tick());
    assert_eq!(runtime.checksum(), untouched.checksum(), "the person's settings never reach the simulation");
}

/// The captures folder: `GENEX_TEMPLATE_OUT`, or the RX.3 evidence folder.
fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/template");
    let dir = std::env::var_os("GENEX_TEMPLATE_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// How one evidence capture is drawn: a `renderSettings` preset, or a phone class with its own.
#[derive(Clone, Copy, Debug)]
enum DrawnAs {
    Preset(QualityPreset),
    Class(&'static str),
}

impl DrawnAs {
    fn change(self) -> RenderChange {
        match self {
            DrawnAs::Preset(preset) => RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() },
            DrawnAs::Class(class) => RenderChange { device_class: Some(DeviceClass::from_wire(class)), ..RenderChange::default() },
        }
    }

    fn label(self) -> String {
        match self {
            DrawnAs::Preset(preset) => String::from(preset.wire()),
            DrawnAs::Class(class) => String::from(class),
        }
    }
}

/// The Rec. 709 luma (0..255) of the BGRA pixel at `at` in a capture `width` wide.
fn luma(bgra: &[u8], width: u32, at: [u32; 2]) -> f32 {
    let i = ((at[1] * width + at[0]) * 4) as usize;
    0.0722 * f32::from(bgra[i]) + 0.7152 * f32::from(bgra[i + 1]) + 0.2126 * f32::from(bgra[i + 2])
}

/// The deepest dark band along the horizon column: for each row, how far its luma sits below the
/// brighter of the two sides' darkest-side maxima (the sky above and the floor below), and where.
fn horizon_band(bgra: &[u8], width: u32) -> (f32, u32) {
    let column: Vec<f32> = (0..HORIZON_ROWS.end + HORIZON_WINDOW).map(|y| luma(bgra, width, [HORIZON_COLUMN, y])).collect();
    let mut deepest = (0.0, 0);
    for y in HORIZON_ROWS {
        let y = y as usize;
        let w = HORIZON_WINDOW as usize;
        let above = column[y - w..y].iter().copied().fold(f32::MIN, f32::max);
        let below = column[y + 1..=y + w].iter().copied().fold(f32::MIN, f32::max);
        let depth = above.min(below) - column[y];
        if depth > deepest.0 {
            deepest = (depth, y as u32);
        }
    }
    deepest
}

/// Write a BGRA capture as an opaque RGBA PNG.
fn write_png(path: &PathBuf, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_template_captures_on_the_hdr_scene_at_every_preset_and_phone_class_with_render_status() {
    use genex::present::Presenter;
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, &[]) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let mut runtime = started();
    runtime.step(FIXED_STEP_MS * SHOT_TICK);
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let dir = out_dir();
    let drawn = [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra]
        .map(DrawnAs::Preset)
        .into_iter()
        .chain(["mobile-high", "mobile-mid", "mobile-low"].map(DrawnAs::Class));
    let mut digests = Vec::new();
    let mut faces = Vec::new();
    let mut problems = Vec::new();
    for drawn_as in drawn {
        let reset = RenderChange { preset: Some(None), device_class: Some(None), ..RenderChange::default() };
        presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&reset);
        presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&drawn_as.change());
        let mut shoot = || {
            presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
            presenter.resilient.capture().expect("capture")
        };
        let (capture, again) = (shoot(), shoot());
        let label = drawn_as.label();
        assert_eq!(capture.digest(), again.digest(), "{label}: two settled captures of one tick differ");
        let path = presenter.resilient.renderer().renderer().last_scene().expect("a frame");
        assert!(path.hdr, "{label}: the template draws on the HDR scene: {path:?}");
        write_png(&dir.join(format!("template-{label}.png")), capture.bgra(), [capture.width(), capture.height()]);
        faces.push((label.clone(), luma(capture.bgra(), capture.width(), BLOCK_GRAZING_FACE)));
        let shadow = mean_rgb(capture.bgra(), capture.width(), &FLOOR_SHADOW);
        if shadow[0] < shadow[2] * FLOOR_SHADOW_RED_SHARE_MIN {
            problems.push(format!("{label}: the block's floor shadow is {shadow:?}, a navy with no red"));
        }
        let (depth, row) = horizon_band(capture.bgra(), capture.width());
        if depth > HORIZON_BAND_DEPTH_MAX {
            problems.push(format!("{label}: a band {depth:.1} levels darker than the sky and the floor at row {row}: the floor stops short of the horizon"));
        }
        // What `state().volatile.render` lists for this run.
        let status = runtime.render().borrow().status();
        let ldr = [DegradeReason::CustomPassV1InWorld, DegradeReason::MaterialV1InHdr];
        assert!(status.degraded.iter().all(|degrade| !ldr.contains(&degrade.reason)), "{label}: {:?}", status.degraded);
        if let DrawnAs::Preset(preset) = drawn_as {
            assert_eq!(status.preset, preset, "{label}: volatile.render names the preset");
        }
        digests.push(format!("\"{label}\": \"{:016x}\"", capture.digest()));
        eprintln!("{label}: {:016x} {status:?}", capture.digest());
    }
    // The block's grazing face keeps its ambient light at every preset: medium's (no bent normals) is the reference.
    let medium = faces.iter().find(|(label, _)| label == "medium").map(|(_, luma)| *luma).expect("medium drawn");
    for (label, face) in &faces {
        if (face - medium).abs() > BLOCK_FACE_LUMA_TOLERANCE {
            problems.push(format!("{label}: the block's grazing face is {face:.1} against medium's {medium:.1}"));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
    // The gear button open: the panel over the scene, as the person sees it.
    let reset = RenderChange { preset: Some(None), device_class: Some(None), ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&reset);
    click(&mut runtime, SETTINGS_BUTTON);
    runtime.step(FIXED_STEP_MS * OPEN_TICKS);
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let open = presenter.resilient.capture().expect("capture");
    write_png(&dir.join("template-settings-open.png"), open.bgra(), [open.width(), open.height()]);
    let record = format!("{{\"tick\": {}, \"digests\": {{{}}}}}\n", SHOT_TICK + 1.0, digests.join(", "));
    std::fs::write(dir.join("template-digests.json"), record).expect("digests");
}

/// The spin angles (ticks) the self-shadow row captures the turning block at: a quarter turn
/// covers every pose of a cube, and these four put a different pair of faces towards the sun.
const SELF_SHADOW_TICKS: [f64; 4] = [8.0, 38.0, 68.0, 98.0];
/// How far inside the block's outline a pixel must lie to be measured: the outline itself differs
/// between anti-aliasing modes, so it is left out.
const BLOCK_ERODE: u32 = 3;
/// A pixel belongs to the brass block when its red channel exceeds its blue by this much (the floor
/// is near grey, the sky and the floor's shadow are blue).
const BLOCK_RED_OVER_BLUE: i32 = 50;
/// A block pixel counts as self-shadowed when its luma falls below this share of the unshadowed
/// reference's (owner report 2026-10-11: dark stripes on the turning cube's own faces).
const SELF_SHADOW_RATIO: f32 = 0.65;
/// The rows just above the block's lower outline in each column (about 6 cm of the 1 m block at
/// this camera) where it meets the floor: AO's contact darkening belongs there, so a dark pixel
/// counts as self-shadow only above them.
const CONTACT_ROWS: u32 = 8;
/// The most of the block's pixels that may count as self-shadowed (anti-aliasing noise on edges).
const SELF_SHADOW_SHARE_MAX: f32 = 0.01;
/// The least the block's mean luma may keep of the reference's.
const BLOCK_MEAN_RATIO_MIN: f32 = 0.85;
/// A floor pixel counts as in the block's shadow below this share of the reference's luma, and the
/// floor shadow must cover at least this many pixels (the block's shadow is about 15,000 at 960 x 540).
const FLOOR_SHADOW_RATIO: f32 = 0.6;
const FLOOR_SHADOW_PIXELS_MIN: usize = 4_000;

/// The block's pixels in `bgra` (`width` x `height`), eroded by [`BLOCK_ERODE`].
fn block_mask(bgra: &[u8], width: u32, height: u32) -> Vec<bool> {
    let raw: Vec<bool> = bgra.chunks(4).map(|p| i32::from(p[2]) - i32::from(p[0]) >= BLOCK_RED_OVER_BLUE).collect();
    let at = |x: i64, y: i64| x >= 0 && y >= 0 && x < i64::from(width) && y < i64::from(height) && raw[(y * i64::from(width) + x) as usize];
    let e = i64::from(BLOCK_ERODE);
    (0..height)
        .flat_map(|y| (0..width).map(move |x| (i64::from(x), i64::from(y))))
        .map(|(x, y)| (-e..=e).all(|dy| (-e..=e).all(|dx| at(x + dx, y + dy))))
        .collect()
}

/// What one capture shows against its unshadowed reference: the share of the block's pixels it
/// darkens below [`SELF_SHADOW_RATIO`], the block's mean luma ratio and the floor shadow's pixels.
fn self_shadow(capture: &[u8], reference: &[u8], width: u32, height: u32) -> (f32, f32, usize) {
    let mask = block_mask(reference, width, height);
    let outline = block_mask_raw(reference);
    // Each column's lowest block pixel: where the block meets the floor (or its shadow).
    let bottom: Vec<Option<u32>> = (0..width).map(|x| (0..height).rev().find(|&y| outline[(y * width + x) as usize])).collect();
    let (mut block, mut dark, mut sum, mut sum_reference, mut floor_shadow) = (0usize, 0usize, 0.0, 0.0, 0usize);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            let (lit, unshadowed) = (luma(capture, width, [x, y]), luma(reference, width, [x, y]));
            if mask[i] {
                block += 1;
                sum += lit;
                sum_reference += unshadowed;
                let above_contact = bottom[x as usize].is_some_and(|floor_line| y + CONTACT_ROWS < floor_line);
                dark += usize::from(above_contact && lit < SELF_SHADOW_RATIO * unshadowed);
            } else if !outline[i] && y > height / 2 && lit < FLOOR_SHADOW_RATIO * unshadowed {
                floor_shadow += 1;
            }
        }
    }
    assert!(block > 1_000, "the block covers {block} measured pixels");
    (dark as f32 / block as f32, sum / sum_reference.max(1.0), floor_shadow)
}

/// The block's pixels without erosion.
fn block_mask_raw(bgra: &[u8]) -> Vec<bool> {
    bgra.chunks(4).map(|p| i32::from(p[2]) - i32::from(p[0]) >= BLOCK_RED_OVER_BLUE).collect()
}

/// Owner report 2026-10-11: "shadow on the cube looks weird with some settings, like shadow on the
/// cube, not on the floor". The turning block at four poses and every preset, each against the
/// same preset with sun shadows, contact shadows and AO switched off (the unshadowed reference):
/// its own faces keep their light, and its shadow on the floor stays.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_turning_block_carries_no_shadow_of_its_own_at_any_preset() {
    use genex::present::Presenter;
    use genex::render::RenderFeature;
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, &[]) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let dir = out_dir().join("self-shadow");
    std::fs::create_dir_all(&dir).expect("the self-shadow folder");
    let unshadowed = [RenderFeature::Shadows, RenderFeature::ContactShadows, RenderFeature::Ao].map(|feature| (feature, false));
    let mut problems = Vec::new();
    for tick in SELF_SHADOW_TICKS {
        let mut runtime = started();
        runtime.step(FIXED_STEP_MS * tick);
        assert!(presenter.install_for(&mut runtime).is_empty());
        presenter.set_capturing(true);
        // The first frame attaches the game's render settings.
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let mut shoot = |features: Vec<(RenderFeature, bool)>| {
                let change = RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), features, reset_features: true, ..RenderChange::default() };
                presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
                presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
                presenter.resilient.capture().expect("capture")
            };
            let reference = shoot(unshadowed.to_vec());
            let capture = shoot(Vec::new());
            let (width, height) = (capture.width(), capture.height());
            let label = format!("{}-t{tick}", preset.wire());
            write_png(&dir.join(format!("block-{label}.png")), capture.bgra(), [width, height]);
            write_png(&dir.join(format!("block-{label}-unshadowed.png")), reference.bgra(), [width, height]);
            let (dark, mean, floor) = self_shadow(capture.bgra(), reference.bgra(), width, height);
            eprintln!("{label}: self-shadowed {:.1}% of the block, mean ratio {mean:.3}, floor shadow {floor} px", dark * 100.0);
            if dark > SELF_SHADOW_SHARE_MAX || mean < BLOCK_MEAN_RATIO_MIN {
                problems.push(format!("{label}: {:.1}% of the block's pixels above the contact rows below {SELF_SHADOW_RATIO} of the unshadowed reference, mean ratio {mean:.3}", dark * 100.0));
            }
            if floor < FLOOR_SHADOW_PIXELS_MIN {
                problems.push(format!("{label}: the block's floor shadow covers only {floor} px"));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Columns left out at each end of the block's base when its contact is measured: the base's own
/// corners blend into the floor through anti-aliasing.
const CONTACT_TRIM: usize = 6;
/// How far below the block's base a column is searched for the block's floor shadow, pixels.
const CONTACT_SEARCH: u32 = 60;
/// The widest lit gap between the block's base and its floor shadow, pixels: about a near-cascade
/// texel and the filter's half-width, at the corner where the shadow's side leaves the base
/// (pass-1 gate findings 01 and 01b: at desktop `low`, mobile-mid and mobile-low the shadow
/// started up to 59 px from the base, a lit wedge under the block's corner; medium, high and ultra
/// draw at most 1 px, the weakest phone's 512 px cascades 5 px at one pose).
const CONTACT_GAP_MAX: u32 = 6;
/// The most the far outline of the block's floor shadow (each column's last shadowed row) may
/// stray from `high`'s, pixels, at its worst column and on average over the columns. The outline is
/// the floor shadow of the block's straight top edges: a one-cascade 768-1024 px map over 40-50
/// units stair-stepped it by up to 64 px and cut it 13-25 px short on average (gate finding 02: a
/// notch at mobile-low, blocky at mobile-mid; the shadow shrunk at desktop `low`); medium strays
/// at most 9 px and 2.4 px on average.
const OUTLINE_STRAY_MAX: i64 = 14;
const OUTLINE_STRAY_MEAN_MAX: f64 = 6.0;

/// The block's floor shadow in one capture against its unshadowed reference: the widest lit gap
/// between the base and the shadow over the base's columns, and each column's last shadowed floor
/// row below the image's middle (the shadow's far outline).
struct FloorShadow {
    gap: u32,
    outline: std::collections::BTreeMap<u32, u32>,
}

fn floor_shadow(capture: &[u8], reference: &[u8], width: u32, height: u32) -> FloorShadow {
    let block = block_mask_raw(reference);
    let shadowed = |x: u32, y: u32| !block[(y * width + x) as usize] && luma(capture, width, [x, y]) < FLOOR_SHADOW_RATIO * luma(reference, width, [x, y]);
    let bases: Vec<(u32, u32)> = (0..width).filter_map(|x| (0..height).rev().find(|&y| block[(y * width + x) as usize]).map(|y| (x, y))).collect();
    assert!(bases.len() > 4 * CONTACT_TRIM, "the block covers {} columns", bases.len());
    let gap = bases[CONTACT_TRIM..bases.len() - CONTACT_TRIM]
        .iter()
        .map(|&(x, base)| (base + 1..(base + CONTACT_SEARCH).min(height)).take_while(|&y| !shadowed(x, y)).count() as u32)
        .max()
        .unwrap_or(0);
    let outline = (0..width).filter_map(|x| (height / 2..height).rev().find(|&y| shadowed(x, y)).map(|y| (x, y))).collect();
    FloorShadow { gap, outline }
}

/// How far `outline` strays from `reference`'s over the columns both hold: the worst column and the mean, pixels.
fn outline_stray(outline: &std::collections::BTreeMap<u32, u32>, reference: &std::collections::BTreeMap<u32, u32>) -> (i64, f64) {
    let strays: Vec<i64> = reference.iter().filter_map(|(x, y)| outline.get(x).map(|own| (i64::from(*own) - i64::from(*y)).abs())).collect();
    assert!(strays.len() * 10 >= reference.len() * 8, "the shadow covers {} of high's {} columns", strays.len(), reference.len());
    (strays.iter().copied().max().unwrap_or(0), strays.iter().sum::<i64>() as f64 / strays.len() as f64)
}

/// Pass-1 gate findings 01, 01b and 02: at desktop `low` the turning block's shadow stood off its
/// base (a lit wedge under the corner, as the bench figure's stood off its feet) and came out short,
/// and at mobile-low and mobile-mid its outline stair-stepped. At every preset and phone class and
/// four poses, against the same drawing with sun shadows, contact shadows and AO off, the floor
/// shadow touches the base and its outline follows `high`'s.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_blocks_shadow_keeps_contact_and_its_outline_at_every_preset_and_phone_class() {
    use genex::present::Presenter;
    use genex::render::RenderFeature;
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, &[]) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let dir = out_dir().join("contact");
    std::fs::create_dir_all(&dir).expect("the contact folder");
    let unshadowed = [RenderFeature::Shadows, RenderFeature::ContactShadows, RenderFeature::Ao].map(|feature| (feature, false));
    // High first: the outline every other drawing is held to.
    let drawn: Vec<DrawnAs> = [QualityPreset::High, QualityPreset::Low, QualityPreset::Medium, QualityPreset::Ultra]
        .map(DrawnAs::Preset)
        .into_iter()
        .chain(["mobile-high", "mobile-mid", "mobile-low"].map(DrawnAs::Class))
        .collect();
    let mut problems = Vec::new();
    for tick in SELF_SHADOW_TICKS {
        let mut runtime = started();
        runtime.step(FIXED_STEP_MS * tick);
        assert!(presenter.install_for(&mut runtime).is_empty());
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        let mut high = None;
        for drawn_as in &drawn {
            let mut shoot = |features: Vec<(RenderFeature, bool)>| {
                let reset = RenderChange { preset: Some(None), device_class: Some(None), ..RenderChange::default() };
                let settings = presenter.render_settings().expect("the game's settings attached");
                settings.borrow_mut().apply(&reset);
                settings.borrow_mut().apply(&RenderChange { features, reset_features: true, ..drawn_as.change() });
                presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
                presenter.resilient.capture().expect("capture")
            };
            let reference = shoot(unshadowed.to_vec());
            let capture = shoot(Vec::new());
            let (width, height) = (capture.width(), capture.height());
            let label = format!("{}-t{tick}", drawn_as.label());
            write_png(&dir.join(format!("block-{label}.png")), capture.bgra(), [width, height]);
            write_png(&dir.join(format!("block-{label}-unshadowed.png")), reference.bgra(), [width, height]);
            let shadow = floor_shadow(capture.bgra(), reference.bgra(), width, height);
            let (worst, mean) = outline_stray(&shadow.outline, &high.get_or_insert_with(|| shadow.outline.clone()).clone());
            eprintln!("{label}: contact gap {} px, outline strays {worst} px from high's at worst, {mean:.1} px on average", shadow.gap);
            if shadow.gap > CONTACT_GAP_MAX {
                problems.push(format!("{label}: the block's floor shadow starts {} px below its base", shadow.gap));
            }
            if worst > OUTLINE_STRAY_MAX || mean > OUTLINE_STRAY_MEAN_MAX {
                problems.push(format!("{label}: the shadow's outline strays {worst} px from high's at worst, {mean:.1} px on average"));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The size Studio's Live panel draws the template at on the owner's Mac (about 1.7 times the
/// world size): the live-app findings of the pass-1 fix gate were seen there.
const LIVE_SIZE: [u32; 2] = [1632, 918];
/// Live frames drawn before the one measured, one tick each: the block turns under TAA's and AO's
/// history as it does in Live.
const LIVE_FRAMES: u32 = 90;
/// The ticks the Live sequences start at.
const LIVE_START_TICKS: [f64; 2] = [8.0, 53.0];

/// The template's block in Live frames at `preset` from `start` (`features` switched as given),
/// drawn at [`LIVE_SIZE`]; the last frame's capture (BGRA) and its size.
fn live_block(presenter: &mut genex::present::Presenter, preset: QualityPreset, start: f64, features: &[(genex::render::RenderFeature, bool)]) -> (Vec<u8>, [u32; 2]) {
    let mut runtime = started();
    runtime.step(FIXED_STEP_MS * start);
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.set_capturing(false);
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let change = RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), features: features.to_vec(), reset_features: true, ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    for _ in 0..LIVE_FRAMES {
        runtime.step(FIXED_STEP_MS);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    }
    let capture = presenter.resilient.capture().expect("capture");
    (capture.bgra().to_vec(), [capture.width(), capture.height()])
}

/// The template's block in a settled capture at `preset` at tick `start` (`features` switched as
/// given), drawn at [`LIVE_SIZE`]: what Studio's capture and the owner's sheets show.
fn settled_block(presenter: &mut genex::present::Presenter, preset: QualityPreset, start: f64, features: &[(genex::render::RenderFeature, bool)]) -> (Vec<u8>, [u32; 2]) {
    let mut runtime = started();
    runtime.step(FIXED_STEP_MS * start);
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.set_capturing(true);
    // The first frame attaches the game's render settings.
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let change = RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), features: features.to_vec(), reset_features: true, ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let capture = presenter.resilient.capture().expect("capture");
    presenter.set_capturing(false);
    (capture.bgra().to_vec(), [capture.width(), capture.height()])
}

/// Rows above the block's base (each column's lowest block pixel) the base band spans at
/// [`LIVE_SIZE`]: about a fifth of the block's height, where its AO darkening lies.
const BASE_BAND_ROWS: u32 = 40;
/// Rows just above the base left out (the outline's anti-aliasing against the floor and its shadow).
const BASE_SKIP_ROWS: u32 = 2;
/// Columns left out at each side of the block's outline.
const BASE_TRIM_COLUMNS: u32 = 6;
/// The half-width of the horizontal window a band pixel's ratio is compared with, pixels.
const BASE_WINDOW: u32 = 8;
/// The rows over which a fall of the band's ratio counts as a cliff.
const BASE_CLIFF_ROWS: u32 = 4;

/// How the block's base band darkens in `capture` against `reference` (the same frame with AO and
/// contact shadows off), per pixel as the luma ratio: the mean departure of each band pixel's
/// ratio from its row neighbours' mean (blotches), and the share of columns whose ratio falls by
/// more than `cliff` over [`BASE_CLIFF_ROWS`] rows towards the base (a sharp dark rim).
fn base_band(capture: &[u8], reference: &[u8], size: [u32; 2], cliff: f32) -> (f32, f32) {
    let [width, height] = size;
    let block = block_mask_raw(reference);
    let inside = |x: u32, y: u32| block[(y * width + x) as usize];
    let columns: Vec<u32> = (0..width).filter(|&x| (0..height).any(|y| inside(x, y))).collect();
    let (left, right) = (columns[0] + BASE_TRIM_COLUMNS, columns[columns.len() - 1] - BASE_TRIM_COLUMNS);
    let ratio = |x: u32, y: u32| luma(capture, width, [x, y]) / luma(reference, width, [x, y]).max(1.0);
    let (mut departure, mut counted, mut cliffs, mut measured) = (0.0, 0usize, 0usize, 0usize);
    for x in left..=right {
        let Some(bottom) = (0..height).rev().find(|&y| inside(x, y)) else { continue };
        let rows: Vec<u32> = (bottom - BASE_BAND_ROWS..=bottom - BASE_SKIP_ROWS).filter(|&y| inside(x, y)).collect();
        if rows.len() < BASE_BAND_ROWS as usize / 2 {
            continue;
        }
        measured += 1;
        let profile: Vec<f32> = rows.iter().map(|&y| ratio(x, y)).collect();
        let steepest = profile.windows(BASE_CLIFF_ROWS as usize + 1).map(|w| w[0] - w[w.len() - 1]).fold(0.0, f32::max);
        cliffs += usize::from(steepest > cliff);
        for (&y, &here) in rows.iter().zip(&profile) {
            let neighbours: Vec<f32> = (x.saturating_sub(BASE_WINDOW)..=x + BASE_WINDOW).filter(|&n| n != x && n >= left && n <= right && inside(n, y)).map(|n| ratio(n, y)).collect();
            if neighbours.len() >= BASE_WINDOW as usize {
                departure += (here - neighbours.iter().sum::<f32>() / neighbours.len() as f32).abs();
                counted += 1;
            }
        }
    }
    (departure / counted.max(1) as f32, cliffs as f32 / measured.max(1) as f32)
}

/// The most a base-band pixel's ratio may depart from its row neighbours' mean on average (red
/// at 2ed3ed9b: medium 0.0150 and 0.0154, its drip-like blotches; with medium's 7x7 disc 0.011
/// and 0.012; high and ultra 0.005-0.008, low 0.006).
const BASE_DEPARTURE_MAX: f32 = 0.013;
/// A fall of the band's ratio by more than this over [`BASE_CLIFF_ROWS`] rows is a cliff, and at
/// most this share of the band's columns may hold one (red at 2ed3ed9b: medium 30-41%, high and
/// ultra 75-79% at the second pose, a dark rim under full light; the crease's own falloff near
/// the block's corners counts 0-10%).
const BASE_CLIFF: f32 = 0.15;
const BASE_CLIFF_SHARE_MAX: f32 = 0.15;

/// How much more a settled capture's base band may depart from its rows than Live's (and the
/// departure under which either counts as smooth): the capture is about as smooth as Live (red
/// at 8315e9a5: high 2.08x and ultra 1.59x Live at the first pose, with a cliff in 6-7% of the
/// columns, the clumps; with AO's running-average history 1.27x and 1.04x, no cliff).
const SETTLED_OVER_LIVE_MAX: f32 = 1.5;
const SMOOTH_DEPARTURE: f32 = 0.004;

/// G0 visual (2026-10-15): the settled capture at high drew dark clumps along the block's base
/// (template/contact/block-high-t8.png) that Live's 90 frames average away: a capture settles over
/// one jitter cycle (8 frames at high), and AO's history weight held the first frame's two slices
/// at 48% of the result. A settled capture's base band darkens as smoothly as Live's (within
/// [`SETTLED_OVER_LIVE_MAX`]) and within the Live row's bounds, at every preset and both poses.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_blocks_base_darkens_smoothly_in_settled_captures_at_every_preset() {
    use genex::present::Presenter;
    use genex::render::RenderFeature;
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(LIVE_SIZE, &[]) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let dir = out_dir().join("settled-block");
    std::fs::create_dir_all(&dir).expect("the settled-block folder");
    let unoccluded = [RenderFeature::ContactShadows, RenderFeature::Ao].map(|feature| (feature, false));
    let presets = [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra];
    // Live's departures first, on the same presenter before any capture (the Live row's frames).
    let mut live_departures = Vec::new();
    for start in LIVE_START_TICKS {
        for preset in presets {
            let (live, size) = live_block(&mut presenter, preset, start, &[]);
            let (live_reference, _) = live_block(&mut presenter, preset, start, &unoccluded);
            live_departures.push(base_band(&live, &live_reference, size, BASE_CLIFF).0);
        }
    }
    let mut live_departures = live_departures.into_iter();
    let mut problems = Vec::new();
    for start in LIVE_START_TICKS {
        for preset in presets {
            let live_departure = live_departures.next().expect("a Live departure per row");
            let (capture, size) = settled_block(&mut presenter, preset, start, &[]);
            let (reference, _) = settled_block(&mut presenter, preset, start, &unoccluded);
            let label = format!("{}-t{start}", preset.wire());
            write_png(&dir.join(format!("settled-{label}.png")), &capture, size);
            let (departure, cliffs) = base_band(&capture, &reference, size, BASE_CLIFF);
            eprintln!("settled {label}: the base band departs {departure:.4} from its rows (Live {live_departure:.4}), {:.1}% of its columns fall by a cliff", cliffs * 100.0);
            if departure > SMOOTH_DEPARTURE.max(live_departure * SETTLED_OVER_LIVE_MAX) {
                problems.push(format!("settled {label}: the base band departs {departure:.4} from its rows against Live's {live_departure:.4} (blotches)"));
            }
            if departure > BASE_DEPARTURE_MAX {
                problems.push(format!("settled {label}: the base band departs {departure:.4} from its rows (blotches)"));
            }
            if cliffs > BASE_CLIFF_SHARE_MAX {
                problems.push(format!("settled {label}: {:.1}% of the base band's columns fall by a cliff (a dark rim)", cliffs * 100.0));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Pass-1 fix gate, live-app findings 1 and 2: in Studio's Live panel the turning block's base
/// drew drip-like dark blotches at medium (one slice of half-resolution GTAO under a 5x5 window)
/// and, at high and ultra, a sharp dark rim with full light above it that curved up the block's
/// right edge (the bent normal's cone test on the brass's narrow lobe). Live frames at
/// [`LIVE_SIZE`], two poses, every preset, against the same frames with AO and contact shadows
/// off: the base band darkens smoothly, in its rows and towards the base.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_blocks_base_darkens_smoothly_in_live_frames_at_every_preset() {
    use genex::present::Presenter;
    use genex::render::RenderFeature;
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(LIVE_SIZE, &[]) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let dir = out_dir().join("live-block");
    std::fs::create_dir_all(&dir).expect("the live-block folder");
    let unoccluded = [RenderFeature::ContactShadows, RenderFeature::Ao].map(|feature| (feature, false));
    let mut problems = Vec::new();
    for start in LIVE_START_TICKS {
        for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let (capture, size) = live_block(&mut presenter, preset, start, &[]);
            let (reference, _) = live_block(&mut presenter, preset, start, &unoccluded);
            let label = format!("{}-t{start}", preset.wire());
            write_png(&dir.join(format!("live-{label}.png")), &capture, size);
            write_png(&dir.join(format!("live-{label}-unoccluded.png")), &reference, size);
            let (departure, cliffs) = base_band(&capture, &reference, size, BASE_CLIFF);
            eprintln!("{label}: the base band departs {departure:.4} from its rows, {:.1}% of its columns fall by a cliff", cliffs * 100.0);
            if departure > BASE_DEPARTURE_MAX {
                problems.push(format!("{label}: the base band departs {departure:.4} from its rows (blotches)"));
            }
            if cliffs > BASE_CLIFF_SHARE_MAX {
                problems.push(format!("{label}: {:.1}% of the base band's columns fall by a cliff (a dark rim)", cliffs * 100.0));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}
