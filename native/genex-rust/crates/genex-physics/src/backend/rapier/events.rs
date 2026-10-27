//! Rapier's collision events as raw events (§8.1). Rapier reports a pair when either collider has
//! `COLLISION_EVENTS`, which the backend sets for colliders with `events: true` and for sensors.
//! The order Rapier reports them in is its own; the core sorts them by key.

use std::sync::{Mutex, PoisonError};

use rapier3d::dynamics::{RigidBodySet, SoftBodySet, SoftBodyTearEvent};
use rapier3d::geometry::{Collider, ColliderHandle, ColliderSet, CollisionEvent, ContactPair};
use rapier3d::math::Real;
use rapier3d::pipeline::EventHandler;

use super::super::{ColliderId, RawEvent, RawEventKind};

/// A pair of colliders as Rapier names it.
pub(crate) type PairHandle = (ColliderHandle, ColliderHandle);

/// The bits of a collider's `user_data` that hold its index in its body.
const INDEX_BITS: u32 = 32;

/// The `user_data` a collider carries: its body's tag above its index.
pub(crate) fn user_data(tag: u64, index: u32) -> u128 {
    (u128::from(tag) << INDEX_BITS) | u128::from(index)
}

/// The core's name for a collider, from its `user_data`.
pub(crate) fn collider_id(collider: &Collider) -> ColliderId {
    let data = collider.user_data;
    ColliderId { tag: (data >> INDEX_BITS) as u64, index: (data & u128::from(u32::MAX)) as u32 }
}

/// Collects one inner step's events. Rapier wants a `Sync` handler, hence the mutex; nothing runs
/// in parallel (the `parallel` feature is off).
#[derive(Default)]
pub(crate) struct Collector {
    events: Mutex<Vec<RawEvent<PairHandle>>>,
}

impl Collector {
    /// The events collected, in Rapier's order.
    pub(crate) fn take(self) -> Vec<RawEvent<PairHandle>> {
        self.events.into_inner().unwrap_or_else(PoisonError::into_inner)
    }

    fn push(&self, event: RawEvent<PairHandle>) {
        self.events.lock().unwrap_or_else(PoisonError::into_inner).push(event);
    }
}

/// The world points of a pair's deepest active contact, and its normal from the first collider to
/// the second; the point is the midpoint of the two surfaces' contact points.
fn deepest(pair: &ContactPair, bodies: &RigidBodySet) -> Option<([f32; 3], [f32; 3])> {
    let mut best: Option<(Real, [f32; 3], [f32; 3])> = None;
    for manifold in pair.solver_manifolds() {
        for contact in manifold.data.solver_contacts.iter() {
            if best.is_some_and(|(dist, _, _)| dist <= contact.dist) {
                continue;
            }
            let (p1, p2) = manifold.data.solver_contact_world_points(contact, bodies);
            let point = ((p1 + p2) * 0.5).to_array();
            best = Some((contact.dist, point, manifold.data.normal.to_array()));
        }
    }
    best.map(|(_, point, normal)| (point, normal))
}

fn raw_kind(event: CollisionEvent, pair: Option<&ContactPair>, bodies: &RigidBodySet) -> RawEventKind {
    match (event.sensor(), event.started()) {
        (true, true) => RawEventKind::TriggerEnter,
        (true, false) => RawEventKind::TriggerExit,
        (false, false) => RawEventKind::ContactEnd,
        (false, true) => {
            let (point, normal) = pair.and_then(|pair| deepest(pair, bodies)).unwrap_or(NO_CONTACT);
            RawEventKind::ContactBegin { point, normal }
        }
    }
}

/// A begin without a solver contact to read (Rapier starts a pair only once it has one).
const NO_CONTACT: ([f32; 3], [f32; 3]) = ([0.0; 3], [0.0; 3]);

impl EventHandler for Collector {
    /// Records a started or stopped pair. A pair Rapier stops because a collider was removed is
    /// dropped: removals are the caller's own (§9.1), and the removed body has no key any more.
    fn handle_collision_event(
        &self,
        bodies: &RigidBodySet,
        colliders: &ColliderSet,
        event: CollisionEvent,
        contact_pair: Option<&ContactPair>,
    ) {
        if event.removed() {
            return;
        }
        let (h1, h2) = (event.collider1(), event.collider2());
        let (Some(c1), Some(c2)) = (colliders.get(h1), colliders.get(h2)) else { return };
        let kind = raw_kind(event, contact_pair, bodies);
        self.push(RawEvent {
            kind,
            first: collider_id(c1),
            second: collider_id(c2),
            sensors: [c1.is_sensor(), c2.is_sensor()],
            pair: (h1, h2),
        });
    }

    fn handle_contact_force_event(
        &self,
        _dt: Real,
        _bodies: &RigidBodySet,
        _colliders: &ColliderSet,
        _contact_pair: &ContactPair,
        _total_force_magnitude: Real,
    ) {
    }

    fn handle_soft_body_tear_event(&self, _soft_bodies: &SoftBodySet, _event: &SoftBodyTearEvent) {}
}
