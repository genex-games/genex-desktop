//! The soldier kit: `kits/soldier.glb` (copy `docs/examples/soldier/soldier.glb` there, or make it
//! with `soldier.py`), a rigged soldier in combat gear with a rifle on its `weapon` bone, animated
//! from a remote player's replicated state alone (`SoldierNet`: position, velocity, yaw, pitch,
//! crouch, counters of shots, reloads and hits, the hit's direction, health). Nothing here needs
//! the remote's input or its own clock, so the same state shows the same soldier on every machine.
//!
//! - The base layer picks a gait from the velocity in the soldier's own frame: idle, walk, run, a
//!   strafe either way, backing off (the walk played backwards), crouched idle or walk, and death,
//!   each walking clip sped to the ground speed.
//! - The upper body (`upper_chest` and below it) holds the rifle low while running and aims it
//!   otherwise; two additive layers tilt the aim up or down with the pitch. Fire and reload play on
//!   the shot and reload counters, hits on the hit counter (front, back, left or right, from where
//!   the round came), all additive but the reload.
//! - After each update the feet are planted on the ground; the draw is one `frame.character` under
//!   the `soldier` tag and one `frame.id`, and a shot flashes at the `muzzle` socket.

use genex::animation::{BoolParam, FloatParam, JointId, LayerId, Mask, Motion, TriggerParam, height_ground};
use genex::math::{self, Quat, Vec3, vec3};
use genex::prelude::*;
use genex::CharacterAsset;

use super::World;
use super::game::SoldierNet;

pub const KIT: &str = "kits/soldier.glb";
const SOLDIER_ID: u64 = 0x534f_4c44;
/// The ground speeds (m/s) the clips walk at, so each plays at the soldier's real speed.
const WALK_SPEED: f32 = 1.3;
const RUN_SPEED: f32 = 3.6;
const STRAFE_SPEED: f32 = 1.2;
const CROUCH_SPEED: f32 = 0.9;
/// Below this ground speed (m/s) the soldier stands; above `RUNNING` it runs.
const MOVING: f32 = 0.3;
const RUNNING: f32 = 2.6;
/// The pitch (radians) the AimUp and AimDown clips hold.
const AIM_PITCH: f32 = std::f32::consts::FRAC_PI_6;
/// A shot's flash lasts this many ticks.
const FLASH_TICKS: u64 = 2;

/// The gaits, as the `gait` parameter's values.
const IDLE: f32 = 0.0;
const WALK: f32 = 1.0;
const RUN: f32 = 2.0;
const BACK: f32 = 3.0;
const LEFT: f32 = 4.0;
const RIGHT: f32 = 5.0;
const CROUCH_IDLE: f32 = 6.0;
const CROUCH_WALK: f32 = 7.0;
const DEAD: f32 = 8.0;

/// The kit's animator and what it last saw of the replicated counters.
#[derive(Default)]
pub struct Soldier {
    kit: Option<Kit>,
    seen: SoldierNet,
    flashed_at: Option<u64>,
}

struct Kit {
    animator: Animator,
    gait: FloatParam,
    pace: FloatParam,
    aiming: BoolParam,
    fire: TriggerParam,
    reload: TriggerParam,
    hits: [TriggerParam; 4],
    /// The layers whose weight follows the state: the upper body, the aim's two tilts, the shots.
    upper: LayerId,
    aim_up: LayerId,
    aim_down: LayerId,
    shots: LayerId,
    muzzle: JointId,
    /// The rear sight: with the muzzle, the line the rifle points along.
    sight: JointId,
}

/// Register the kit.
pub fn wire(game: &mut Game<World>) {
    game.facet_state::<Soldier>();
    game.on_reset(|sim, _seed, _rng, gfx| {
        // A refusal (no kit in `assets/`) leaves the soldier out; the probe says so.
        sim.facets.get_mut::<Soldier>().kit = gfx.character(KIT).ok().and_then(|asset| kit(&asset));
    });
    game.on_update(|sim, ctx| {
        let net = sim.world.soldier;
        let tick = sim.world.tick;
        let soldier = sim.facets.get_mut::<Soldier>();
        if net.shots != soldier.seen.shots {
            soldier.flashed_at = Some(tick);
        }
        if let Some(kit) = soldier.kit.as_mut() {
            drive(kit, &net, &soldier.seen);
            kit.animator.update(ctx.dt);
            kit.animator.plant_feet(placed(&net), height_ground(|_, _| Some(0.0)));
        }
        soldier.seen = net;
    });
    game.on_draw(|sim, frame, _camera| {
        let soldier = sim.facets.get::<Soldier>();
        let Some(kit) = &soldier.kit else { return };
        let net = &sim.world.soldier;
        let at = placed(net);
        frame.tag("soldier").id(SOLDIER_ID).character(&kit.animator, at).end_id();
        if soldier.flashed_at.is_some_and(|tick| sim.world.tick - tick < FLASH_TICKS) {
            let muzzle = kit.animator.socket(kit.muzzle, at.matrix()).transform_point3(Vec3::ZERO);
            frame.tag("muzzle-flash").sphere_with(muzzle, 0.035, &Material::emissive(Color::rgb(255, 190, 110), 30.0));
            frame.point_light(muzzle, 3.0, Color::rgb(255, 180, 100), 0.4);
        }
    });
    // The check's demo: a soldier held at a pitch of +0.5, then -0.5; how much higher its muzzle is.
    game.demo("soldier-aim", |d| {
        let muzzle_at = |d: &mut genex::DemoDriver<'_, World>, pitch: f32| {
            d.sim_mut().world.paused = true;
            d.sim_mut().world.soldier = SoldierNet { pitch, vel: Vec3::ZERO, hp: super::game::HEALTH, ..d.sim().world.soldier };
            d.advance_ms(700);
            muzzle(d.sim()).y
        };
        let (up, down) = (muzzle_at(d, 0.5), muzzle_at(d, -0.5));
        json!({ "muzzleRiseM": up - down })
    });
    game.probe("soldier", |sim| {
        let soldier = sim.facets.get::<Soldier>();
        let Some(kit) = &soldier.kit else { return json!({ "kit": false }) };
        let at = placed(&sim.world.soldier).matrix();
        let [muzzle, sight] = [kit.muzzle, kit.sight].map(|joint| kit.animator.socket(joint, at).transform_point3(Vec3::ZERO));
        json!({ "kit": true, "anim": kit.animator.probe(), "muzzle": [muzzle.x, muzzle.y, muzzle.z], "sight": [sight.x, sight.y, sight.z], "digest": kit.animator.digest() })
    });
}

/// The muzzle socket in the world, or the soldier's position without the kit.
fn muzzle(sim: &Sim<World>) -> Vec3 {
    let net = &sim.world.soldier;
    sim.facets.get::<Soldier>().kit.as_ref().map_or(net.pos, |kit| kit.animator.socket(kit.muzzle, placed(net).matrix()).transform_point3(Vec3::ZERO))
}

/// Where the soldier is drawn: at its position, turned to its yaw (the kit faces +z).
pub fn placed(net: &SoldierNet) -> Transform {
    Transform::from_translation(net.pos).with_rotation(Quat::from_rotation_y(std::f32::consts::FRAC_PI_2 - net.yaw))
}

/// The kit's graph: a base layer of gaits, the upper body's rifle, the aim's two tilts, the shots
/// and the hits.
fn kit(asset: &CharacterAsset) -> Option<Kit> {
    let clip = |name: &str| asset.clip(name);
    let skeleton = asset.skeleton();
    let (upper_chest, muzzle, sight) = (skeleton.find("upper_chest")?, skeleton.find("muzzle")?, skeleton.find("sight")?);
    let mut g = asset.graph();
    let gait = g.float("gait", IDLE);
    let pace = g.float("pace", 1.0);
    let aiming = g.bool("aiming", true);
    let base = g.layer("base");
    let gaits = [
        ("idle", IDLE, Motion::clip(clip("Idle")?)),
        ("walk", WALK, Motion::clip(clip("Walk")?).speed_by(pace)),
        ("run", RUN, Motion::clip(clip("Run")?).speed_by(pace)),
        ("back", BACK, Motion::clip(clip("Walk")?).speed(-1.0).speed_by(pace)),
        ("strafe-left", LEFT, Motion::clip(clip("StrafeLeft")?).speed_by(pace)),
        ("strafe-right", RIGHT, Motion::clip(clip("StrafeRight")?).speed_by(pace)),
        ("crouch", CROUCH_IDLE, Motion::clip(clip("CrouchIdle")?)),
        ("crouch-walk", CROUCH_WALK, Motion::clip(clip("CrouchWalk")?).speed_by(pace)),
        ("death", DEAD, Motion::clip(clip("Death")?).once()),
    ];
    for (name, value, motion) in gaits {
        let state = g.state(base, name, motion);
        let here = gait.above(value - 0.5).and(gait.below(value + 0.5));
        g.transition_from_any(state).when(here).inertialize(if value == DEAD { 0.1 } else { 0.25 });
    }
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Joints(vec![upper_chest]));
    let aim = g.state(upper, "aim", Motion::clip(clip("RifleAim")?));
    let low = g.state(upper, "low", Motion::clip(clip("RifleLow")?));
    let reloading = g.state(upper, "reload", Motion::clip(clip("RifleReload")?).once());
    g.transition(aim, low).when(aiming.is(false)).inertialize(0.25);
    g.transition(low, aim).when(aiming.is(true)).inertialize(0.2);
    let reload = g.trigger("reload");
    g.transition_from_any(reloading).when(reload.fired()).inertialize(0.2);
    g.transition(reloading, aim).at_end().inertialize(0.2);
    let (aim_up, aim_down) = (tilt(&mut g, "aim-up", clip("RifleAimUp")?, clip("RifleAim")?, upper_chest), tilt(&mut g, "aim-down", clip("RifleAimDown")?, clip("RifleAim")?, upper_chest));
    let (shots, fire) = shots(&mut g, clip("RifleFire")?, upper_chest);
    let hits_layer = g.layer("hits");
    let front = clip("HitFront")?;
    g.layer_additive(hits_layer, front);
    let none = g.state(hits_layer, "none", Motion::Empty);
    let mut hits = Vec::new();
    for (name, hit) in [("hit-front", front), ("hit-back", clip("HitBack")?), ("hit-left", clip("HitLeft")?), ("hit-right", clip("HitRight")?)] {
        let trigger = g.trigger(name);
        let state = g.state(hits_layer, name, Motion::clip(hit).once());
        g.transition_from_any(state).when(trigger.fired()).crossfade(0.0);
        g.transition(state, none).at_end().crossfade(0.05);
        hits.push(trigger);
    }
    let animator = asset.animator(&g.build().ok()?).ok()?;
    Some(Kit { animator, gait, pace, aiming, fire, reload, hits: hits.try_into().ok()?, upper, aim_up, aim_down, shots, muzzle, sight })
}

/// An additive layer over the upper body holding `clip`'s difference from `reference`.
fn tilt(g: &mut genex::animation::AnimGraphBuilder<'_>, name: &str, clip: genex::animation::ClipId, reference: genex::animation::ClipId, upper_chest: JointId) -> LayerId {
    let layer = g.layer(name);
    g.layer_mask(layer, Mask::Joints(vec![upper_chest]));
    g.layer_additive(layer, reference);
    g.layer_weight(layer, 0.0);
    g.state(layer, name, Motion::clip(clip));
    layer
}

/// The shots' additive layer: two fire states take turns, so each round restarts the clip.
fn shots(g: &mut genex::animation::AnimGraphBuilder<'_>, fire_clip: genex::animation::ClipId, upper_chest: JointId) -> (LayerId, TriggerParam) {
    let layer = g.layer("shots");
    g.layer_mask(layer, Mask::Joints(vec![upper_chest]));
    g.layer_additive(layer, fire_clip);
    let fire = g.trigger("fire");
    let none = g.state(layer, "none", Motion::Empty);
    let (a, b) = (g.state(layer, "fire-a", Motion::clip(fire_clip).once()), g.state(layer, "fire-b", Motion::clip(fire_clip).once()));
    for (from, to) in [(none, a), (a, b), (b, a)] {
        g.transition(from, to).when(fire.fired()).crossfade(0.0);
    }
    for from in [a, b] {
        g.transition(from, none).at_end().crossfade(0.03);
    }
    (layer, fire)
}

/// The graph's parameters and weights from the replicated state; triggers for what its counters
/// say happened since `seen`.
fn drive(kit: &mut Kit, net: &SoldierNet, seen: &SoldierNet) {
    let forward = vec3(math::cos(net.yaw), 0.0, math::sin(net.yaw));
    let right = vec3(-forward.z, 0.0, forward.x);
    let ahead = net.vel.dot(forward);
    let aside = net.vel.dot(right);
    let speed = vec2(ahead, aside).length();
    let dead = net.hp <= 0.0;
    let (gait, natural) = gait(net.crouch, dead, speed, ahead, aside);
    let animator = &mut kit.animator;
    animator.set_float(kit.gait, gait);
    animator.set_float(kit.pace, (speed / natural).clamp(0.5, 1.6));
    let aiming = gait != RUN && !dead;
    animator.set_bool(kit.aiming, aiming);
    let live = if dead { 0.0 } else { 1.0 };
    let tilt = if aiming { net.pitch / AIM_PITCH } else { 0.0 };
    animator.set_layer_weight(kit.upper, live);
    animator.set_layer_weight(kit.shots, live);
    animator.set_layer_weight(kit.aim_up, tilt.clamp(0.0, 1.0) * live);
    animator.set_layer_weight(kit.aim_down, (-tilt).clamp(0.0, 1.0) * live);
    if net.shots != seen.shots {
        animator.fire(kit.fire);
    }
    if net.reloads != seen.reloads {
        animator.fire(kit.reload);
    }
    if net.hits != seen.hits {
        animator.fire(kit.hits[side_of(net.hit_from - net.yaw)]);
    }
}

/// The gait for a ground velocity in the soldier's frame, and the speed its clip walks at.
fn gait(crouch: bool, dead: bool, speed: f32, ahead: f32, aside: f32) -> (f32, f32) {
    if dead {
        return (DEAD, 1.0);
    }
    if crouch {
        return if speed > MOVING { (CROUCH_WALK, CROUCH_SPEED) } else { (CROUCH_IDLE, 1.0) };
    }
    if speed <= MOVING {
        return (IDLE, 1.0);
    }
    if aside.abs() > ahead.abs() {
        return (if aside > 0.0 { RIGHT } else { LEFT }, STRAFE_SPEED);
    }
    if ahead < 0.0 {
        return (BACK, WALK_SPEED);
    }
    if speed > RUNNING { (RUN, RUN_SPEED) } else { (WALK, WALK_SPEED) }
}

/// Which side a hit came from, as the index of `hits` (front, back, left, right), for a direction
/// relative to the soldier's facing (radians, toward its right positive).
fn side_of(relative: f32) -> usize {
    let quarter = (math::atan2(math::sin(relative), math::cos(relative)) / std::f32::consts::FRAC_PI_2).round() as i32;
    match quarter.rem_euclid(4) {
        0 => 0,
        1 => 3,
        2 => 1,
        _ => 2,
    }
}
