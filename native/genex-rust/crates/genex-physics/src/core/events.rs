//! A step's events (§8.1), from the backend's raw events of each inner step: named by key, a
//! contact pair's lower body key first (its normal turned to point from a to b), a trigger's sensor
//! first, the begin's impulse summed over the rest of the step, then sorted by (sub-step, kind,
//! a, b, ca, cb) and cut at `limits.eventsPerStep`.

use std::collections::BTreeSet;

use super::{Core, PairName};
use crate::axes::vec_out;
use crate::backend::{Backend, ColliderId, RawEvent, RawEventKind};
use crate::num::{out, out_vec};
use crate::state::PhysicsEvent;
use crate::types::UpAxis;

/// The rank of each event kind in §8.1's order: Begin < End < Enter < Exit.
fn kind_rank(event: &PhysicsEvent) -> u8 {
    match event {
        PhysicsEvent::ContactBegin { .. } => 0,
        PhysicsEvent::ContactEnd { .. } => 1,
        PhysicsEvent::TriggerEnter { .. } => 2,
        PhysicsEvent::TriggerExit { .. } => 3,
    }
}

/// The four keys §8.1 orders by after the kind: (a, b, ca, cb), or (sensor, other, sc, oc).
fn order_keys(event: &PhysicsEvent) -> [&str; 4] {
    match event {
        PhysicsEvent::ContactBegin { a, b, ca, cb, .. } | PhysicsEvent::ContactEnd { a, b, ca, cb, .. } => [a, b, ca, cb],
        PhysicsEvent::TriggerEnter { sensor, sc, other, oc, .. }
        | PhysicsEvent::TriggerExit { sensor, sc, other, oc, .. } => [sensor, other, sc, oc],
    }
}

/// One collider of an event, named.
struct Side<'a> {
    body: &'a str,
    collider: &'a str,
    kind: Option<&'a str>,
}

impl Side<'_> {
    fn order(&self) -> (&str, &str) {
        (self.body, self.collider)
    }
}

/// One event of a step while the step runs.
pub(super) struct Pending<P> {
    substep: u32,
    event: PhysicsEvent,
    /// The backend's pair, for a begin's impulse; `None` for an end the core found itself.
    pair: Option<P>,
    /// A begin whose pair has not ended yet: it adds each later inner step's impulse.
    open: bool,
    /// The begin's impulse so far, summed in f32.
    impulse: f32,
}

/// The events of one step, gathered inner step by inner step.
pub(super) struct StepEvents<P> {
    pending: Vec<Pending<P>>,
}

impl<P: Copy + PartialEq> StepEvents<P> {
    pub(super) fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// Adds inner step `substep`'s events; an end closes its pair's open begin first. A begin or
    /// enter of a `carried` pair is the backend finding again a pair that was already touching
    /// (1.1 draft): it is not reported, and the pair is the backend's to end from then on.
    pub(super) fn add<B: Backend<Pair = P>>(
        &mut self,
        core: &Core<B>,
        substep: u32,
        raw: &[RawEvent<P>],
        carried: &mut BTreeSet<PairName>,
    ) {
        for event in raw {
            let Some(named) = core.name_event(event) else { continue };
            let found_again = !carried.is_empty() && core.pair_name(event).is_some_and(|name| carried.remove(&name));
            let begins = matches!(event.kind, RawEventKind::ContactBegin { .. } | RawEventKind::TriggerEnter);
            if found_again && begins {
                continue;
            }
            if matches!(event.kind, RawEventKind::ContactEnd) {
                self.close(event.pair);
            }
            let open = matches!(named, PhysicsEvent::ContactBegin { .. });
            self.pending.push(Pending { substep, event: named, pair: Some(event.pair), open, impulse: 0.0 });
        }
    }

    /// Adds an end (or exit) the core found itself, in inner step `substep`.
    pub(super) fn add_end(&mut self, substep: u32, event: PhysicsEvent) {
        self.pending.push(Pending { substep, event, pair: None, open: false, impulse: 0.0 });
    }

    fn close(&mut self, pair: P) {
        for pending in self.pending.iter_mut().filter(|p| p.open && p.pair == Some(pair)) {
            pending.open = false;
        }
    }

    /// Adds the impulse each open begin's pair applied in the inner step just run.
    pub(super) fn add_impulses<B: Backend<Pair = P>>(&mut self, backend: &B) {
        for pending in self.pending.iter_mut().filter(|p| p.open) {
            if let Some(pair) = pending.pair {
                pending.impulse += backend.pair_impulse(pair);
            }
        }
    }

    /// The step's events in §8.1's order, cut at `max`; whether any were dropped.
    pub(super) fn finish(self, max: usize) -> (Vec<PhysicsEvent>, bool) {
        let mut pending = self.pending;
        pending.sort_by(|x, y| {
            let x_key = (x.substep, kind_rank(&x.event), order_keys(&x.event));
            x_key.cmp(&(y.substep, kind_rank(&y.event), order_keys(&y.event)))
        });
        let overflowed = pending.len() > max;
        let events = pending.into_iter().take(max).map(with_impulse).collect();
        (events, overflowed)
    }
}

fn with_impulse<P>(pending: Pending<P>) -> PhysicsEvent {
    match pending.event {
        PhysicsEvent::ContactBegin { a, b, ca, cb, ka, kb, point, normal, .. } => {
            PhysicsEvent::ContactBegin { a, b, ca, cb, ka, kb, impulse: out(pending.impulse), point, normal }
        }
        other => other,
    }
}

impl<B: Backend> Core<B> {
    fn side(&self, id: ColliderId) -> Option<Side<'_>> {
        let (body, collider, kind) = self.collider_name(id)?;
        Some(Side { body, collider, kind })
    }

    /// A raw event's pair by name, or `None` when a collider has no name.
    fn pair_name<P>(&self, raw: &RawEvent<P>) -> Option<PairName> {
        let (first, second) = (self.side(raw.first)?, self.side(raw.second)?);
        Some(PairName::of((first.body, first.collider), (second.body, second.collider), raw.sensors))
    }

    /// A carried pair's end (or exit), named as the backend's own would be; `None` once a side is gone.
    pub(super) fn carried_end(&self, pair: &PairName) -> Option<PhysicsEvent> {
        let side = |(body, collider): &(String, String)| -> Option<Side<'_>> {
            let tag = self.tag_of(body)?;
            let index = match self.bodies.get(body) {
                Some(entry) => entry.colliders.iter().position(|c| c == collider)? as u32,
                None => 0,
            };
            self.side(ColliderId { tag, index })
        };
        let (first, second) = (side(&pair.sides[0])?, side(&pair.sides[1])?);
        match pair.sensors {
            [false, false] => Some(contact_end(first, second)),
            sensors => Some(trigger(false, first, second, sensors)),
        }
    }

    /// A raw event as a contract event, or `None` if a collider has no name (never for a live body)
    /// or both colliders are on one body.
    fn name_event<P>(&self, raw: &RawEvent<P>) -> Option<PhysicsEvent> {
        let (first, second) = (self.side(raw.first)?, self.side(raw.second)?);
        if first.body == second.body {
            return None;
        }
        match raw.kind {
            RawEventKind::ContactBegin { point, normal } => Some(contact_begin(self.desc.up_axis, first, second, point, normal)),
            RawEventKind::ContactEnd => Some(contact_end(first, second)),
            RawEventKind::TriggerEnter => Some(trigger(true, first, second, raw.sensors)),
            RawEventKind::TriggerExit => Some(trigger(false, first, second, raw.sensors)),
        }
    }
}

fn owned(text: Option<&str>) -> Option<String> {
    text.map(str::to_string)
}

/// The pair with its lower body key first, and whether that swapped it.
fn ordered<'a>(first: Side<'a>, second: Side<'a>) -> (Side<'a>, Side<'a>, bool) {
    match first.order() <= second.order() {
        true => (first, second, false),
        false => (second, first, true),
    }
}

fn contact_begin(up: UpAxis, first: Side<'_>, second: Side<'_>, point: [f32; 3], normal: [f32; 3]) -> PhysicsEvent {
    let (a, b, swapped) = ordered(first, second);
    let normal = match swapped {
        true => normal.map(|n| -n),
        false => normal,
    };
    PhysicsEvent::ContactBegin {
        a: a.body.to_string(),
        b: b.body.to_string(),
        ca: a.collider.to_string(),
        cb: b.collider.to_string(),
        ka: owned(a.kind),
        kb: owned(b.kind),
        impulse: 0.0,
        point: out_vec(vec_out(up, point)),
        normal: out_vec(vec_out(up, normal)),
    }
}

fn contact_end(first: Side<'_>, second: Side<'_>) -> PhysicsEvent {
    let (a, b, _) = ordered(first, second);
    PhysicsEvent::ContactEnd {
        a: a.body.to_string(),
        b: b.body.to_string(),
        ca: a.collider.to_string(),
        cb: b.collider.to_string(),
        ka: owned(a.kind),
        kb: owned(b.kind),
    }
}

/// A trigger, its sensor first; when both colliders are sensors, the lower key is the sensor.
fn trigger(enter: bool, first: Side<'_>, second: Side<'_>, sensors: [bool; 2]) -> PhysicsEvent {
    let (sensor, other) = match sensors {
        [true, true] => {
            let (low, high, _) = ordered(first, second);
            (low, high)
        }
        [false, true] => (second, first),
        _ => (first, second),
    };
    let (sensor, sc, ks) = (sensor.body.to_string(), sensor.collider.to_string(), owned(sensor.kind));
    let (other, oc, ko) = (other.body.to_string(), other.collider.to_string(), owned(other.kind));
    match enter {
        true => PhysicsEvent::TriggerEnter { sensor, sc, other, oc, ks, ko },
        false => PhysicsEvent::TriggerExit { sensor, sc, other, oc, ks, ko },
    }
}
