//! `step()` (§8): kinematic interpolation over the sub-steps (§7.2), the inner steps and their
//! events (§8.1), escaped bodies (§8.2), change marks (§9.1), memory after the step (§11.1) and a
//! fresh query quota (§13).

use super::events::StepEvents;
use super::{Core, net_state};
use crate::axes::{quat_in, quat_out, vec_in, vec_out};
use crate::backend::{Backend, RawBodyState};
use crate::kinematic::{RawPose, pose_at, velocity_between};
use crate::memory::contact_bytes;
use crate::state::StepResult;
use crate::types::BodyType;

/// One kinematic body moving toward its target this step, in the caller frame.
struct Move<H> {
    handle: H,
    start: RawPose,
    target: RawPose,
}

impl<B: Backend> Core<B> {
    /// Advances `dt` in `substeps` inner steps (§8), then handles escaped bodies (§8.2).
    pub(crate) fn step(&mut self) -> StepResult {
        let starts: Vec<RawBodyState> = self.bodies.values().map(|e| self.backend.state(e.handle)).collect();
        let moves = self.take_moves();
        let substeps = self.desc.substeps;
        let mut non_finite = Vec::new();
        let mut events = StepEvents::new();
        for k in 1..=substeps {
            self.drive_moves(&moves, k);
            let inner = self.backend.step();
            events.add(self, k, &inner.events);
            events.add_impulses(&self.backend);
            non_finite.extend(inner.non_finite);
            self.place_moves(&moves, k);
        }
        self.tick += 1;
        self.queries_this_step = 0;
        let escaped = self.freeze_escaped(&starts, &non_finite);
        self.track_changes();
        self.contact_pairs = self.backend.contact_pairs();
        self.ledger.contact_bytes = contact_bytes(self.contact_pairs);
        let memory_exceeded = self.ledger.model_bytes() > u64::from(self.desc.limits.memory_bytes);
        let (events, overflowed) = events.finish(self.desc.limits.events_per_step as usize);
        StepResult { tick: self.tick, events, overflowed, escaped, memory_exceeded }
    }

    /// Takes every kinematic target set for this step; a kinematic body without one is stopped,
    /// so it keeps its pose with velocity zero (§7.2).
    fn take_moves(&mut self) -> Vec<Move<B::Body>> {
        let up = self.desc.up_axis;
        let mut moves = Vec::new();
        for entry in self.bodies.values_mut() {
            let target = entry.target.take();
            if entry.body_type != BodyType::Kinematic || entry.escaped {
                continue;
            }
            let Some(target) = target else {
                self.backend.drive(entry.handle, [0.0; 3], [0.0; 3]);
                continue;
            };
            let raw = self.backend.state(entry.handle);
            let start = (vec_out(up, raw.translation), quat_out(up, raw.rotation));
            moves.push(Move { handle: entry.handle, start, target });
        }
        moves
    }

    /// Before sub-step `k`: the velocity that covers its motion.
    fn drive_moves(&mut self, moves: &[Move<B::Body>], k: u32) {
        let (up, n, h) = (self.desc.up_axis, self.desc.substeps, self.desc.inner_dt());
        for m in moves {
            let from = pose_at(m.start, m.target, k - 1, n);
            let to = pose_at(m.start, m.target, k, n);
            let (linvel, angvel) = velocity_between(from, to, h);
            self.backend.drive(m.handle, vec_in(up, linvel), vec_in(up, angvel));
        }
    }

    /// After sub-step `k`: the interpolated pose, exactly.
    fn place_moves(&mut self, moves: &[Move<B::Body>], k: u32) {
        let (up, n) = (self.desc.up_axis, self.desc.substeps);
        for m in moves {
            let (p, q) = pose_at(m.start, m.target, k, n);
            self.backend.place(m.handle, vec_in(up, p), quat_in(up, q));
        }
    }

    /// Freezes every body that left `worldExtent` or went non-finite on this step (in its state or
    /// as the backend found it, `non_finite`), a non-finite one back at its pose from the step's
    /// start; returns their keys in key order.
    fn freeze_escaped(&mut self, starts: &[RawBodyState], non_finite: &[B::Body]) -> Vec<String> {
        let extent = self.desc.limits.world_extent;
        let mut escaped = Vec::new();
        for ((key, entry), start) in self.bodies.iter_mut().zip(starts) {
            if entry.escaped {
                continue;
            }
            let now = self.backend.state(entry.handle);
            let finite = is_finite(&now) && !non_finite.contains(&entry.handle);
            let pose = if finite { now } else { *start };
            let outside = pose.translation.iter().any(|c| c.abs() > extent);
            if finite && !outside {
                continue;
            }
            self.backend.freeze(entry.handle, pose.translation, pose.rotation);
            entry.escaped = true;
            entry.target = None;
            escaped.push(key.clone());
        }
        escaped
    }

    /// Records, per body, whether this step changed the bits of its replicated fields.
    fn track_changes(&mut self) {
        let mark = 2 * self.tick;
        let up = self.desc.up_axis;
        for entry in self.bodies.values_mut() {
            let now = net_state(&self.backend, up, entry.handle, entry.body_type, entry.escaped);
            if now.bits() != entry.last.bits() {
                entry.changed_mark = mark;
            }
            entry.last = now;
        }
    }
}

fn is_finite(state: &RawBodyState) -> bool {
    let values = state.translation.iter().chain(&state.rotation).chain(&state.linvel).chain(&state.angvel);
    values.into_iter().all(|v| v.is_finite())
}
