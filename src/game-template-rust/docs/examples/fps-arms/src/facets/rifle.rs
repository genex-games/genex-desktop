//! The rifle's rules: a 30-round magazine, automatic fire at 600 rounds a minute, a dry trigger
//! on an empty magazine, a reload and an inspect, hitscan against the Rapier colliders, and a
//! kick that climbs the aim and settles. It writes what happened into the world (`rounds`,
//! `recoil`, `fired_at`, `dry_at`, `reload_at`, `inspect_at`, `impact`); `viewmodel.rs` plays the
//! kit's clips from those, so the rules never wait on an animation and still match the clips:
//! a reload takes the Reload clip's 2.6 s and the magazine counts as in when the clip seats it.

use genex::math::vec3;
use genex::physics::{QueryFilter, Ray};
use genex::prelude::*;

use super::World;
use super::game::{FIRE, INSPECT, RELOAD};

pub const MAGAZINE: u32 = 30;
/// Ticks between rounds (600 a minute at 60 ticks a second: the Fire clip's 0.1 s).
const COOLDOWN: u64 = 6;
/// The Reload clip's length and the moment it seats the new magazine, and the Inspect clip's.
const RELOAD_TICKS: u64 = 156;
const SEATED_TICKS: u64 = 111;
const INSPECT_TICKS: u64 = 192;
/// How far a round reaches (m), its spread (radians, wider from the hip), the aim's climb per
/// round and how much of the climb the hands pull back each tick.
const RANGE: f32 = 150.0;
const SPREAD_HIP: f32 = 0.012;
const SPREAD_AIMED: f32 = 0.002;
const CLIMB: f32 = 0.006;
const RECOVER: f32 = 0.1;
/// How fast the kick settles (kept per tick).
const RECOIL_KEEP: f32 = 0.8;

/// The rifle's own counters.
#[derive(Default)]
pub struct Rifle {
    pub fired: u32,
    pub hits: u32,
    /// The aim's climb still to recover (radians).
    climb: f32,
}

/// Register the rifle.
pub fn wire(game: &mut Game<World>) {
    game.facet_state::<Rifle>();
    game.on_reset(|sim, _seed, _rng, _gfx| sim.world.rounds = MAGAZINE);
    game.on_update(update);
    game.probe("rifle", |sim| {
        let rifle = sim.facets.get::<Rifle>();
        let world = &sim.world;
        json!({ "rounds": world.rounds, "fired": rifle.fired, "hits": rifle.hits, "reloading": world.reload_at.is_some(), "inspecting": world.inspect_at.is_some() })
    });
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let rifle = sim.facets.get_mut::<Rifle>();
    let world = &mut sim.world;
    world.recoil *= RECOIL_KEEP;
    let settle = rifle.climb * RECOVER;
    world.pitch -= settle;
    rifle.climb -= settle;
    if let Some(started) = world.reload_at {
        let since = world.tick - started;
        if since == SEATED_TICKS {
            world.rounds = MAGAZINE;
        }
        if since >= RELOAD_TICKS {
            world.reload_at = None;
        }
        return;
    }
    if world.inspect_at.is_some_and(|started| world.tick - started >= INSPECT_TICKS) {
        world.inspect_at = None;
    }
    if ctx.actions.pressed(RELOAD) && world.rounds < MAGAZINE && !world.sprinting {
        world.reload_at = Some(world.tick);
        world.inspect_at = None;
        return;
    }
    if ctx.actions.pressed(INSPECT) && world.inspect_at.is_none() && !world.aiming {
        world.inspect_at = Some(world.tick);
    }
    if !ctx.actions.down(FIRE) || world.sprinting {
        return;
    }
    let ready = world.fired_at.is_none_or(|last| world.tick - last >= COOLDOWN);
    if world.rounds == 0 {
        if ctx.actions.pressed(FIRE) {
            world.dry_at = Some(world.tick);
        }
    } else if ready {
        fire(world, &sim.physics, rifle, ctx);
    }
}

/// One round: a ray from the eye along the aim, a little spread from `ctx.rng`.
fn fire(world: &mut World, physics: &PhysicsWorld, rifle: &mut Rifle, ctx: &Ctx<'_>) {
    world.rounds -= 1;
    world.recoil = 1.0;
    world.fired_at = Some(world.tick);
    world.inspect_at = None;
    rifle.fired += 1;
    let spread = SPREAD_HIP + (SPREAD_AIMED - SPREAD_HIP) * world.aim;
    let jitter = vec3(ctx.rng.range_f32(-1.0, 1.0), ctx.rng.range_f32(-1.0, 1.0), ctx.rng.range_f32(-1.0, 1.0)) * spread;
    let aim = (world.forward() + jitter).normalize();
    world.pitch += CLIMB;
    rifle.climb += CLIMB;
    let player = world.player.as_ref().and_then(Character::body);
    let filter = player.map_or(QueryFilter::default(), |body| QueryFilter::default().exclude_rigid_body(body));
    let ray = Ray::new(world.eye(), aim);
    let hit = physics.cast_ray(&ray, RANGE, true, filter);
    rifle.hits += u32::from(hit.is_some());
    world.impact = Some(ray.point_at(hit.map_or(RANGE, |(_, toi)| toi)));
}
