//! The pistol's rules: semi-automatic fire, a magazine and a reload, hitscan against the Rapier
//! colliders (the hall's boxes and the enemy's capsule alike), recoil that kicks the aim and the
//! view, and a bullet hole decal where a shot meets a wall. What a shot hit goes in `world.hit`
//! for the enemy facet to read on the same tick (facets update in their wiring order).

use genex::math::{Vec3, vec3};
use genex::physics::{QueryFilter, Ray};
use genex::prelude::*;
use genex::render::Decal;

use super::World;
use super::game::{FIRE, Hit, RELOAD};

const MAGAZINE: u32 = 12;
/// Ticks between shots (a trigger pull each), and to reload.
const COOLDOWN: u32 = 7;
const RELOAD_TICKS: u32 = 90;
/// How far a shot reaches (m), its spread (radians), the aim's climb per shot and how much of the
/// climb the hands pull back down each tick.
const RANGE: f32 = 120.0;
const SPREAD: f32 = 0.006;
const CLIMB: f32 = 0.014;
const RECOVER: f32 = 0.12;
/// How fast the kick settles (kept per tick).
const RECOIL_KEEP: f32 = 0.82;
/// How far a shot kicks the camera up (degrees); the rig eases it back and screen shake scales it.
const KICK_DEGREES: f32 = 1.2;
/// The bullet holes kept at once, and each one's size (m).
const HOLES: usize = 24;
const HOLE: f32 = 0.09;

/// The weapon's own state.
#[derive(Default)]
pub struct Weapon {
    pub rounds: u32,
    cooldown: u32,
    reloading: u32,
    pub fired: u32,
    pub hits: u32,
    /// The aim's climb still to recover (radians).
    climb: f32,
    /// The latest holes (point, normal), oldest first.
    holes: Vec<(Vec3, Vec3)>,
}

/// Register the weapon.
pub fn wire(game: &mut Game<World>) {
    game.facet_state::<Weapon>();
    game.on_reset(|sim, _seed, _rng, _gfx| {
        sim.facets.get_mut::<Weapon>().rounds = MAGAZINE;
    });
    game.on_update(update);
    game.on_draw(|sim, frame, _camera| {
        for (point, normal) in &sim.facets.get::<Weapon>().holes {
            frame.decal(&Decal::on_wall(*point, *normal, HOLE, HOLE).with_base_texture("decals/bullet-hole.png").with_depth(0.05));
        }
    });
    game.on_ui(|sim, ui, _ctx| {
        let weapon = sim.facets.get::<Weapon>();
        let text = if weapon.reloading > 0 { "RELOADING".to_owned() } else { format!("{} / {MAGAZINE}", weapon.rounds) };
        ui.label(egui::RichText::new(text).color(egui::Color32::WHITE).size(18.0).strong());
    });
    game.probe("weapon", |sim| {
        let weapon = sim.facets.get::<Weapon>();
        json!({ "rounds": weapon.rounds, "fired": weapon.fired, "hits": weapon.hits })
    });
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    // The world, the physics and this facet's state are separate fields: borrow each on its own.
    let weapon = sim.facets.get_mut::<Weapon>();
    let world = &mut sim.world;
    world.recoil *= RECOIL_KEEP;
    let settle = weapon.climb * RECOVER;
    world.pitch -= settle;
    weapon.climb -= settle;
    weapon.cooldown = weapon.cooldown.saturating_sub(1);
    if weapon.reloading > 0 {
        weapon.reloading -= 1;
        if weapon.reloading == 0 {
            weapon.rounds = MAGAZINE;
        }
    } else if ctx.actions.pressed(RELOAD) && weapon.rounds < MAGAZINE {
        weapon.reloading = RELOAD_TICKS;
    } else if ctx.actions.pressed(FIRE) && weapon.cooldown == 0 && world.health > 0.0 {
        if weapon.rounds == 0 {
            weapon.reloading = RELOAD_TICKS;
        } else {
            fire(world, &sim.physics, weapon, ctx);
        }
    }
}

/// One shot: a ray from the chest camera along the aim, a little spread from `ctx.rng`.
fn fire(world: &mut World, physics: &PhysicsWorld, weapon: &mut Weapon, ctx: &Ctx<'_>) {
    weapon.rounds -= 1;
    weapon.cooldown = COOLDOWN;
    weapon.fired += 1;
    world.recoil = 1.0;
    world.rig.recoil(KICK_DEGREES);
    world.fired_at = Some(world.tick);
    let jitter = vec3(ctx.rng.range_f32(-1.0, 1.0), ctx.rng.range_f32(-1.0, 1.0), ctx.rng.range_f32(-1.0, 1.0)) * SPREAD;
    let aim = (world.forward() + jitter).normalize();
    world.pitch += CLIMB;
    weapon.climb += CLIMB;
    let player = world.player.as_ref().and_then(Character::body);
    let filter = player.map_or(QueryFilter::default(), |body| QueryFilter::default().exclude_rigid_body(body));
    let ray = Ray::new(world.eye(), aim);
    let Some((collider, found)) = physics.cast_ray_and_get_normal(&ray, RANGE, true, filter) else { return };
    let hit = Hit { collider, point: ray.point_at(found.time_of_impact), normal: found.normal };
    world.hit = Some(hit);
    weapon.hits += 1;
    // A hole only in what stands still: the enemy facet answers its own hits.
    let fixed = physics.colliders.get(collider).and_then(|c| c.parent()).and_then(|body| physics.bodies.get(body)).is_some_and(|body| body.is_fixed());
    if fixed {
        if weapon.holes.len() == HOLES {
            weapon.holes.remove(0);
        }
        weapon.holes.push((hit.point, hit.normal));
    }
}
