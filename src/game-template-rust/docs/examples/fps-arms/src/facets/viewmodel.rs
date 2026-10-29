//! The view model from the first-person arms kit: `kits/fps-arms.glb` (copy
//! `docs/examples/fps-arms/fps-arms.glb` there, or make it with `fps_arms.py`), gloved arms on an
//! AK-pattern rifle whose magazine, charging handle and trigger are bones. The kit is in the
//! camera's frame (the eye at its origin, looking along -z), so it is drawn at the camera.
//!
//! - An animator graph plays its clips from the rifle's state in the world: idle, walk and sprint
//!   from the speed, the sights on `aiming`, Reload and Inspect on the ticks they began, and Fire
//!   and DryFire as an additive layer over whatever the base plays, so a shot down the sights
//!   still cycles the carrier.
//! - Sway against the turn, the kick and the pull-back from a wall come from simulation state and
//!   move the whole kit; down the sights they shrink, so the sight line settles on the centre.
//! - Drawn under the `hands` tag and one `frame.id`, so TAA moves it with the camera, and as the
//!   view model (`frame.view_model`), so screen-space AO leaves it alone and a fill from over the
//!   camera's shoulder keeps it from going black with the sun in front. The flash and the tracer
//!   start at the kit's `muzzle` socket, wherever the clip has the rifle.

use genex::animation::{BoolParam, FloatParam, JointId, Motion, TriggerParam};
use genex::math::{self, Mat3, Quat, Vec3, vec3};
use genex::prelude::*;
use genex::{CharacterAsset, Input};

use super::World;

pub const KIT: &str = "kits/fps-arms.glb";
/// One draw id for the whole view model, so TAA follows it with the camera instead of smearing it.
const VIEW_MODEL_ID: u64 = 0x4b49_5441;
/// How far the turn swings the kit (m per radian), its most, and how quickly it catches up.
const SWAY: f32 = 0.3;
const SWAY_MAX: f32 = 0.035;
const SWAY_FOLLOW: f32 = 0.18;
/// What is left of the sway and the kick down the sights.
const AIMED_SWAY: f32 = 0.15;
const AIMED_KICK: f32 = 0.35;
/// The kick at full recoil: back along the view (m) and up about the eye (radians).
const KICK_BACK: f32 = 0.025;
const KICK_UP: f32 = 0.03;
/// The flash lasts this many ticks after a round, the tracer this many.
const FLASH_TICKS: u64 = 2;
const TRACER_TICKS: u64 = 3;
/// The speed (m/s) past which the arms walk.
const WALKING: f32 = 0.5;

/// The kit's animator and the graph's parameters, and the sway's lagging offset.
#[derive(Default)]
pub struct ViewModel {
    kit: Option<Kit>,
    sway: Vec2,
}

struct Kit {
    animator: Animator,
    speed: FloatParam,
    sprint: BoolParam,
    aim: BoolParam,
    reload: TriggerParam,
    inspect: TriggerParam,
    fire: TriggerParam,
    dry: TriggerParam,
    muzzle: JointId,
    /// The rear notch and the front post, and the magazine with its seated place on the rifle.
    sights: [JointId; 2],
    magazine: JointId,
    seated: Vec3,
}

/// Register the kit's animator, its update and its draw.
pub fn wire(game: &mut Game<World>) {
    game.facet_state::<ViewModel>();
    game.on_reset(|sim, _seed, _rng, gfx| {
        // A refusal (no kit in `assets/`) leaves the view model out; the probe says so.
        sim.facets.get_mut::<ViewModel>().kit = gfx.character(KIT).ok().and_then(|asset| kit(&asset));
    });
    game.on_update(|sim, ctx| {
        let world = &sim.world;
        let view = sim.facets.get_mut::<ViewModel>();
        let wish = (vec2(-world.turned.x, world.turned.y) * SWAY).clamp_length_max(SWAY_MAX);
        view.sway += (wish - view.sway) * SWAY_FOLLOW;
        if let Some(kit) = view.kit.as_mut() {
            drive(kit, world);
            kit.animator.update(ctx.dt);
        }
    });
    game.on_draw(|sim, frame, camera| {
        let view = sim.facets.get::<ViewModel>();
        if let Some(kit) = &view.kit {
            draw(kit, &sim.world, view.sway, frame, camera);
        }
    });
    game.probe("viewmodel", |sim| {
        let view = sim.facets.get::<ViewModel>();
        let Some(kit) = &view.kit else { return json!({ "kit": false }) };
        let (sights, magazine) = (sights_in_view(sim), magazine_out(kit));
        // How far each sight is off the view's centre line (degrees): both near 0 when aimed.
        let off_axis = sights.map(|sight| math::atan2(vec2(sight.x, sight.y).length(), sight.z).to_degrees());
        json!({ "kit": true, "anim": kit.animator.probe(), "sightsOffAxisDeg": off_axis, "magazineOutM": magazine })
    });
    // The checks' demos: aim and read the notch's place on the screen; start a reload and read
    // how far the magazine is from its seat when the clip holds it clear of the well.
    game.demo("ads", |d| {
        d.inject(Input::key_down(Key::Mouse2));
        d.advance_ms(1000);
        let [notch, _] = sights_in_view(d.sim());
        json!({ "sightNdc": { "x": notch.x / notch.z, "y": notch.y / notch.z }, "crosshairVisible": d.sim().world.aim < 0.5 })
    });
    game.demo("reload", |d| {
        d.inject(Input::key_down(Key::Mouse1));
        d.advance_ms(300);
        d.inject(Input::key_up(Key::Mouse1));
        d.inject(Input::key_down(Key::KeyR));
        d.advance_ms(750);
        let out = d.sim().facets.get::<ViewModel>().kit.as_ref().map_or(0.0, magazine_out);
        json!({ "magazineOutM": out, "rounds": d.sim().world.rounds })
    });
}

/// The rear notch and the front post in the camera's frame (x right, y up, z ahead), or zeros
/// without the kit.
fn sights_in_view(sim: &Sim<World>) -> [Vec3; 2] {
    let view = sim.facets.get::<ViewModel>();
    let Some(kit) = &view.kit else { return [Vec3::ZERO; 2] };
    let camera = sim.world.camera();
    let at = kit_transform(&sim.world, view.sway, &camera).matrix();
    let to_view = view_turn(&camera).inverse();
    kit.sights.map(|joint| {
        let local = to_view * (kit.animator.socket(joint, at).transform_point3(Vec3::ZERO) - camera.position);
        vec3(local.x, local.y, -local.z)
    })
}

/// How far the magazine is from its seat in the rifle (m): 0 seated, about 0.15 held clear.
fn magazine_out(kit: &Kit) -> f32 {
    kit.animator.pose().get(usize::from(kit.magazine.raw())).map_or(0.0, |trs| trs.translation.distance(kit.seated))
}

/// The kit's graph: a base layer of poses and an additive layer of shots over it.
fn kit(asset: &CharacterAsset) -> Option<Kit> {
    let clip = |name: &str| asset.clip(name);
    let (idle, walk, sprint, ads_in, ads, ads_out) = (clip("Idle")?, clip("Walk")?, clip("Sprint")?, clip("AdsIn")?, clip("Ads")?, clip("AdsOut")?);
    let (fire, dry_fire, reload, inspect) = (clip("Fire")?, clip("DryFire")?, clip("Reload")?, clip("Inspect")?);
    let mut g = asset.graph();
    let speed = g.float("speed", 0.0);
    let sprinting = g.bool("sprint", false);
    let aiming = g.bool("aim", false);
    let reloading = g.trigger("reload");
    let inspecting = g.trigger("inspect");
    let shot = g.trigger("fire");
    let dry = g.trigger("dry");
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(idle));
    let walk = g.state(base, "walk", Motion::clip(walk));
    let sprint = g.state(base, "sprint", Motion::clip(sprint));
    let ads_in = g.state(base, "ads-in", Motion::clip(ads_in).once());
    let ads = g.state(base, "ads", Motion::clip(ads));
    let ads_out = g.state(base, "ads-out", Motion::clip(ads_out).once());
    let reload = g.state(base, "reload", Motion::clip(reload).once());
    let inspect = g.state(base, "inspect", Motion::clip(inspect).once());
    g.transition(idle, walk).when(speed.above(WALKING)).inertialize(0.2);
    g.transition(walk, idle).when(speed.below(WALKING)).inertialize(0.25);
    for from in [idle, walk] {
        g.transition(from, sprint).when(sprinting.is(true)).inertialize(0.2);
        g.transition(from, inspect).when(inspecting.fired()).inertialize(0.15);
    }
    g.transition(sprint, idle).when(sprinting.is(false)).inertialize(0.25);
    for from in [idle, walk, sprint, inspect] {
        g.transition(from, ads_in).when(aiming.is(true)).crossfade(0.05);
    }
    g.transition(ads_in, ads).at_end().crossfade(0.0);
    g.transition(ads_in, ads_out).when(aiming.is(false)).crossfade(0.05);
    g.transition(ads, ads_out).when(aiming.is(false)).crossfade(0.0);
    g.transition(ads_out, idle).at_end().crossfade(0.05);
    g.transition_from_any(reload).when(reloading.fired()).priority(1).inertialize(0.15);
    for from in [reload, inspect] {
        g.transition(from, idle).at_end().inertialize(0.2);
    }
    // The shots add to the base pose: Fire's first frame is the hip pose it adds against. Two
    // fire states take turns, so each round restarts the clip.
    let shots = g.layer("shots");
    g.layer_additive(shots, fire);
    let none = g.state(shots, "none", Motion::Empty);
    let fire_a = g.state(shots, "fire-a", Motion::clip(fire).once());
    let fire_b = g.state(shots, "fire-b", Motion::clip(fire).once());
    let click = g.state(shots, "dry", Motion::clip(dry_fire).once());
    g.transition(none, fire_a).when(shot.fired()).crossfade(0.0);
    g.transition(fire_a, fire_b).when(shot.fired()).crossfade(0.0);
    g.transition(fire_b, fire_a).when(shot.fired()).crossfade(0.0);
    g.transition(none, click).when(dry.fired()).crossfade(0.0);
    for from in [fire_a, fire_b, click] {
        g.transition(from, none).at_end().crossfade(0.03);
    }
    let animator = asset.animator(&g.build().ok()?).ok()?;
    let skeleton = asset.skeleton();
    let joint = |name: &str| skeleton.find(name);
    let (muzzle, magazine, sights) = (joint("muzzle")?, joint("magazine")?, [joint("sight")?, joint("sight_front")?]);
    let seated = skeleton.rest_pose().get(usize::from(magazine.raw()))?.translation;
    Some(Kit { animator, speed, sprint: sprinting, aim: aiming, reload: reloading, inspect: inspecting, fire: shot, dry, muzzle, sights, magazine, seated })
}

/// Set the graph's parameters from the world, and fire the triggers of what began this tick.
fn drive(kit: &mut Kit, world: &World) {
    let now = Some(world.tick);
    let animator = &mut kit.animator;
    animator.set_float(kit.speed, world.speed);
    animator.set_bool(kit.sprint, world.sprinting);
    animator.set_bool(kit.aim, world.aiming && world.reload_at.is_none());
    for (began, trigger) in [(world.reload_at, kit.reload), (world.inspect_at, kit.inspect), (world.fired_at, kit.fire), (world.dry_at, kit.dry)] {
        if began == now {
            animator.fire(trigger);
        }
    }
}

/// The camera's turn: its local x right, y up and z back, in the world.
fn view_turn(camera: &Camera) -> Quat {
    let back = (camera.position - camera.target).normalize_or(Vec3::Z);
    let right = camera.up.cross(back).normalize_or(Vec3::X);
    Quat::from_mat3(&Mat3::from_cols(right, back.cross(right), back))
}

/// Where the kit is drawn: at the camera, moved by the sway, the kick and the wall in front.
pub fn kit_transform(world: &World, sway: Vec2, camera: &Camera) -> Transform {
    let aimed = world.aim;
    let sway = sway * (1.0 + (AIMED_SWAY - 1.0) * aimed);
    let kick = world.recoil * (1.0 + (AIMED_KICK - 1.0) * aimed);
    let offset = vec3(sway.x, sway.y, KICK_BACK * kick + world.wall_pull);
    let view = view_turn(camera);
    Transform::from_translation(camera.position + view * offset).with_rotation(view * Quat::from_rotation_x(KICK_UP * kick))
}

fn draw(kit: &Kit, world: &World, sway: Vec2, frame: &mut Frame, camera: &Camera) {
    let at = kit_transform(world, sway, camera);
    frame.tag("hands").id(VIEW_MODEL_ID).view_model();
    frame.character(&kit.animator, at);
    frame.end_view_model().end_id();
    let muzzle = kit.animator.socket(kit.muzzle, at.matrix()).transform_point3(Vec3::ZERO);
    let since = world.fired_at.map(|tick| world.tick - tick);
    if since.is_some_and(|ticks| ticks < FLASH_TICKS) {
        frame.tag("muzzle-flash").sphere_with(muzzle, 0.03, &Material::emissive(Color::rgb(255, 190, 110), 40.0));
        frame.point_light(muzzle, 4.0, Color::rgb(255, 180, 100), 3.0);
    }
    let Some(end) = world.impact.filter(|_| since.is_some_and(|ticks| ticks < TRACER_TICKS)) else { return };
    // The tracer: a thin glowing streak from the muzzle a few metres toward where the round went.
    let along = (end - muzzle).normalize_or(Vec3::Z);
    let length = (end - muzzle).length().min(6.0);
    let middle = muzzle + along * (0.5 + length * 0.5);
    let streak = Transform::from_translation(middle).with_rotation(Quat::from_rotation_arc(Vec3::Z, along)).with_scale(vec3(0.006, 0.006, length));
    frame.tag("tracer").cube_with(streak, &Material::emissive(Color::rgb(255, 210, 150), 25.0));
}
