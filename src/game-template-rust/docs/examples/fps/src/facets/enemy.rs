//! One rigged enemy: a character capsule the hitscan hits, an animator graph with idle, walk, fire,
//! hit and death, and a little sense: it walks towards the player it can see, stops to shoot when
//! in range, flinches when hit and falls when its health runs out. Its shot lands on the fire
//! clip's `shot` event, so damage follows the animation, not a timer. Spawn more by keeping a
//! `Vec` of these.
//!
//! Rename `CLIPS` to the clip names your GLB has (`asset.clip_names()` lists them). A rig that
//! comes in lying down or 100 times too big has an armature root turn the import did not apply:
//! fix it in the GLB (re-export it through Local Blender with transforms applied), not here.

use genex::animation::{EventId, FloatParam, Motion, TriggerParam};
use genex::math::{self, Quat, Vec3, vec3};
use genex::physics::{QueryFilter, Ray};
use genex::prelude::*;
use genex::CharacterParams;

use super::World;

/// The enemy's GLB under `assets/`, and its clips: idle, walk, fire, hit, death.
const ENEMY_GLB: &str = "characters/enemy.glb";
const CLIPS: [&str; 5] = ["Idle", "Walk", "Fire", "Hit", "Death"];
const SPAWN: Vec3 = vec3(0.0, 0.0, 8.0);
const HEALTH: u32 = 3;
/// It notices the player within this distance, walks at this speed and shoots from this close.
const NOTICE: f32 = 18.0;
const PACE: f32 = 1.4;
const SHOOT_RANGE: f32 = 9.0;
/// Ticks between its shots, and the damage of one that lands.
const SHOOT_EVERY: u32 = 100;
const DAMAGE: f32 = 12.0;
/// Where its eyes are above its feet: what it sees from.
const EYES: f32 = 1.6;
/// Its draw id: one key that stays with this enemy, so TAA follows it.
const ENEMY_ID: u64 = 0x454e_454d;

/// The graph's parameters and its fire clip's `shot` event.
#[derive(Clone, Copy)]
struct Rig {
    speed: FloatParam,
    fire: TriggerParam,
    hit: TriggerParam,
    die: TriggerParam,
    shot: EventId,
}

/// The enemy's state.
#[derive(Default)]
pub struct Enemy {
    body: Option<Character>,
    animator: Option<Animator>,
    rig: Option<Rig>,
    /// Where it stands and which way it faces (radians about +y, 0 along +z).
    feet: Vec3,
    facing: f32,
    pub health: u32,
    cooldown: u32,
    pub dead: bool,
}

/// Register the enemy.
pub fn wire(game: &mut Game<World>) {
    game.facet_state::<Enemy>();
    game.on_reset(|sim, _seed, _rng, gfx| {
        let enemy = sim.facets.get_mut::<Enemy>();
        enemy.feet = SPAWN;
        enemy.health = HEALTH;
        enemy.cooldown = SHOOT_EVERY;
        enemy.body = Character::spawn(&mut sim.physics, SPAWN, CharacterParams::default()).ok();
        // A missing or refused GLB leaves the capsule standing undrawn: probe it, never panic.
        let Ok(asset) = gfx.character(ENEMY_GLB) else { return };
        let Some([idle, walk, fire, hit, death]) = CLIPS.map(|name| asset.clip(name)).into_iter().collect::<Option<Vec<_>>>().and_then(|clips| <[_; 5]>::try_from(clips).ok()) else { return };
        let mut g = asset.graph();
        let speed = g.float("speed", 0.0);
        let (shoot, flinch, die) = (g.trigger("fire"), g.trigger("hit"), g.trigger("die"));
        let base = g.layer("base");
        let idling = g.state(base, "idle", Motion::clip(idle));
        let walking = g.state(base, "walk", Motion::clip(walk));
        let firing = g.state(base, "fire", Motion::clip(fire).once());
        let hurt = g.state(base, "hit", Motion::clip(hit).once());
        // The death state has no way out: played once, it holds its last frame.
        let dying = g.state(base, "death", Motion::clip(death).once());
        g.transition(idling, walking).when(speed.above(0.2)).inertialize(0.2);
        g.transition(walking, idling).when(speed.below(0.2)).inertialize(0.25);
        for from in [idling, walking] {
            g.transition(from, firing).when(shoot.fired()).crossfade(0.1);
        }
        for from in [idling, walking, firing] {
            g.transition(from, hurt).when(flinch.fired()).crossfade(0.05);
        }
        for from in [firing, hurt] {
            g.transition(from, idling).at_end().crossfade(0.2);
        }
        for from in [idling, walking, firing, hurt] {
            g.transition(from, dying).when(die.fired()).crossfade(0.1).priority(10);
        }
        let shot = g.event(fire, 0.25, "shot");
        let Ok(graph) = g.build() else { return };
        enemy.animator = asset.animator(&graph).ok();
        enemy.rig = Some(Rig { speed, fire: shoot, hit: flinch, die, shot });
    });
    game.on_update(update);
    game.on_draw(|sim, frame, _camera| {
        let enemy = sim.facets.get::<Enemy>();
        let Some(animator) = &enemy.animator else { return };
        let at = Transform::from_translation(enemy.feet).with_rotation(Quat::from_rotation_y(enemy.facing));
        frame.tag("enemy").id(ENEMY_ID).character(animator, at);
        frame.end_id();
    });
    game.probe("enemy", |sim| {
        let enemy = sim.facets.get::<Enemy>();
        json!({ "health": enemy.health, "dead": enemy.dead, "x": enemy.feet.x, "z": enemy.feet.z, "anim": enemy.animator.as_ref().map(Animator::probe) })
    });
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let enemy = sim.facets.get_mut::<Enemy>();
    let (world, physics) = (&mut sim.world, &mut sim.physics);
    let (Some(animator), Some(rig)) = (enemy.animator.as_mut(), enemy.rig) else { return };
    if enemy.dead {
        animator.update(ctx.dt);
        return;
    }
    // A hit this tick: flinch, or fall and take the capsule out so shots pass over the body.
    let struck = world.hit.is_some_and(|hit| enemy.body.as_ref().and_then(Character::collider) == Some(hit.collider));
    if struck {
        enemy.health = enemy.health.saturating_sub(1);
        if enemy.health == 0 {
            enemy.dead = true;
            animator.fire(rig.die);
            if let Some(body) = enemy.body.take() {
                body.remove(physics);
            }
            animator.update(ctx.dt);
            return;
        }
        animator.fire(rig.hit);
    }
    let Some(body) = enemy.body.as_mut() else { return };
    let eyes = body.feet() + Vec3::Y * EYES;
    let to_player = world.eye() - eyes;
    let distance = to_player.length();
    let filter = body.body().map_or(QueryFilter::default(), |own| QueryFilter::default().exclude_rigid_body(own));
    let blocked = physics.cast_ray(&Ray::new(eyes, to_player / distance.max(0.01)), distance - 0.5, true, filter).is_some();
    let sees = distance < NOTICE && !blocked && world.health > 0.0;
    let flat = vec3(to_player.x, 0.0, to_player.z).normalize_or_zero();
    let wish = if sees && distance > SHOOT_RANGE { flat * PACE } else { Vec3::ZERO };
    body.drive(physics, CharacterMotion::Velocity { wish, jump: false }, ctx.dt);
    enemy.feet = body.feet();
    if sees {
        enemy.facing = math::atan2(flat.x, flat.z);
    }
    enemy.cooldown = enemy.cooldown.saturating_sub(1);
    if sees && distance <= SHOOT_RANGE && enemy.cooldown == 0 {
        animator.fire(rig.fire);
        enemy.cooldown = SHOOT_EVERY;
    }
    animator.set_float(rig.speed, body.velocity().length());
    let step = animator.update(ctx.dt);
    if sees && step.events.iter().any(|event| event.event == rig.shot) {
        world.health -= DAMAGE;
    }
}
