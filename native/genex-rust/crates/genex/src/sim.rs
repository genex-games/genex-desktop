//! The simulation every hook reads or writes: the game's world, the physics world and each
//! facet's private state. `seed` rebuilds all three from their defaults.

use crate::Physics;
use crate::map::Map;
use std::any::{Any, TypeId, type_name};

/// The simulation state. Mutating hooks get `&mut Sim<W>`, read hooks `&Sim<W>`.
pub struct Sim<W> {
    /// The game's own world, rebuilt from `W::default()` on every seed.
    pub world: W,
    /// The physics world (Genex Physics, `docs/api/physics.md`), empty after every seed; the
    /// runtime steps it once per tick.
    pub physics: Physics,
    /// Per-facet private state, so facets do not edit the entry file's world type.
    pub facets: FacetState,
    /// The navigation world, rebuilt on every seed: empty unless `game.navigation` registered one
    /// (the runtime owns it, as it owns physics).
    pub nav: crate::nav::Nav,
    /// The streamed world's sim set: anchors, active cells and what this tick's commit moved
    /// (empty without `game.streaming`; the runtime commits it at the start of every tick).
    pub stream: crate::stream_tick::StreamState,
    /// The net frame this tick consumed and the writes it queues (multiplayer MP-4a), owned by the
    /// runtime like `nav`: reads answer from the frame cut before the update hooks, writes leave
    /// after the tick and their effects arrive in a later frame. Never saved or checksummed.
    pub net: crate::net::Net,
}

impl<W> Sim<W> {
    /// The world and the physics world, borrowed mutably together.
    pub fn split(&mut self) -> (&mut W, &mut Physics) {
        (&mut self.world, &mut self.physics)
    }
}

type Constructor = fn() -> Box<dyn Any>;

fn construct<T: Default + 'static>() -> Box<dyn Any> {
    Box::new(T::default())
}

/// Facet state slots, keyed by type, each rebuilt from `T::default()` on seed.
#[derive(Default)]
pub struct FacetState {
    slots: Map<TypeId, (&'static str, Box<dyn Any>)>,
}

impl FacetState {
    pub(crate) fn fresh(registrations: &[FacetRegistration]) -> FacetState {
        let slots = registrations.iter().map(|r| (r.type_id, (r.type_name, (r.construct)()))).collect();
        FacetState { slots }
    }

    /// The state a facet registered with `game.facet_state::<T>()`.
    ///
    /// # Panics
    /// When `T` was never registered: call `game.facet_state::<T>()` in the facet's `wire`.
    pub fn get<T: 'static>(&self) -> &T {
        self.try_get().unwrap_or_else(|| unregistered::<T>())
    }

    /// The state a facet registered, mutably.
    ///
    /// # Panics
    /// When `T` was never registered.
    pub fn get_mut<T: 'static>(&mut self) -> &mut T {
        self.slots
            .get_mut(&TypeId::of::<T>())
            .and_then(|(_, slot)| slot.downcast_mut())
            .unwrap_or_else(|| unregistered::<T>())
    }

    /// The state for `T`, or `None` when it was never registered.
    pub fn try_get<T: 'static>(&self) -> Option<&T> {
        self.slots.get(&TypeId::of::<T>()).and_then(|(_, slot)| slot.downcast_ref())
    }

    /// The registered state type names, in registration order.
    pub fn names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.slots.values().map(|(name, _)| *name)
    }
}

fn unregistered<T>() -> ! {
    panic!("facet state {} is not registered: call game.facet_state::<{0}>() in the facet's wire()", type_name::<T>())
}

/// One `game.facet_state::<T>()` call.
#[derive(Clone, Copy)]
pub(crate) struct FacetRegistration {
    pub type_id: TypeId,
    pub type_name: &'static str,
    construct: Constructor,
}

impl FacetRegistration {
    pub fn of<T: Default + 'static>() -> FacetRegistration {
        FacetRegistration { type_id: TypeId::of::<T>(), type_name: type_name::<T>(), construct: construct::<T> }
    }
}

/// Renderer pass 2 (owner decision D11): a game whose genex.toml turns physics off is built
/// without Rapier; its simulation carries the empty stand-in and ticks as before.
#[cfg(all(test, not(feature = "physics")))]
mod without_physics {
    use crate::prelude::*;

    #[test]
    fn a_game_without_physics_carries_the_empty_world_and_still_ticks() {
        #[derive(Default)]
        struct World {
            ticks: u32,
        }
        let mut game = Game::new(World::default());
        game.on_update(|sim, _| sim.world.ticks += 1);
        let mut runtime = crate::Runtime::new(game).expect("installs");
        runtime.start();
        let ticks = runtime.advance_live(1000.0 / 60.0 * 3.0);
        assert!(ticks >= 2, "the game ticked: {ticks}");
        assert_eq!(runtime.sim().world.ticks, ticks);
        assert_eq!(runtime.sim().physics, crate::Physics, "the empty stand-in, never a physics world");
    }
}
