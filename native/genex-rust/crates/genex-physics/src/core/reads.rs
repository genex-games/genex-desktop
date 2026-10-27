//! State reads (§9.1, §9.2, §11): the flat export of changed bodies, one body's replicated fields,
//! importing them one at a time or in bulk (§19.1), and the world's counters.

use super::{Core, NetState, changed_after};
use crate::axes::{quat_in, vec_in};
use crate::backend::{Backend, BodyEdit};
use crate::body::{bounded_speed, position};
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::key::check_key;
use crate::num::{any_quat, out_quat, out_vec};
use crate::state::{ChangedExport, EXPORT_STRIDE, NetBodyState, Stats};
use crate::types::BodyType;

/// The flat numbers of one body: p(3), q(4), v(3), w(3), sleeping as 0 or 1 (§9.1).
fn flat(net: &NetState) -> [f32; EXPORT_STRIDE] {
    let mut out = [0.0; EXPORT_STRIDE];
    let values = net.p.iter().chain(&net.q).chain(&net.v).chain(&net.w);
    for (slot, value) in out.iter_mut().zip(values) {
        *slot = *value;
    }
    out[EXPORT_STRIDE - 1] = f32::from(u8::from(net.sleeping));
    out
}

impl<B: Backend> Core<B> {
    /// The bodies changed after `since_tick`, flat, in key order (§9.1).
    pub(crate) fn export_changed(&self, since_tick: u64) -> ChangedExport {
        let mut export = ChangedExport::default();
        let changed = self.bodies.iter().filter(|(_, entry)| changed_after(entry.changed_mark, since_tick));
        for (key, entry) in changed {
            let net = self.net_state(entry.handle, entry.body_type, entry.escaped);
            export.keys.push(key.clone());
            export.data.extend_from_slice(&flat(&net));
        }
        export
    }

    /// A body's replicated fields, or `None` (§9.2).
    pub(crate) fn export_body_state(&self, key: &str) -> Option<NetBodyState> {
        let entry = self.bodies.get(key)?;
        let net = self.net_state(entry.handle, entry.body_type, entry.escaped);
        Some(NetBodyState { p: out_vec(net.p), q: out_quat(net.q), v: out_vec(net.v), w: out_vec(net.w), sleeping: net.sleeping })
    }

    /// Sets a dynamic or kinematic body's replicated fields and sleep state (§9.2), with the
    /// bounds of a command (§4.1); an escaped body returns to the simulation, as with `setPose`.
    /// The rotation may be off unit, as a quantized one is: it is renormalised, and refused only
    /// when it has no length.
    pub(crate) fn import_body_state(&mut self, key: &str, state: &NetBodyState) -> Result<(), PhysicsFailure> {
        let edit = self.check_import(key, state)?;
        self.edit_body(key, edit);
        Ok(())
    }

    /// Imports many bodies' states in `export_changed`'s layout, all or none (§19.1): every entry is
    /// judged first, as `import_body_state` judges it, a refusal naming its index; then each is
    /// applied in order. Judging one never depends on another (an import changes no body's type
    /// and no ledger fact), so when all pass the world ends exactly as one import per key in order
    /// leaves it, a key named twice included (the later wins).
    pub(crate) fn import_states<K: AsRef<str>>(&mut self, keys: &[K], data: &[f32]) -> Result<(), PhysicsFailure> {
        if keys.len().checked_mul(EXPORT_STRIDE) != Some(data.len()) {
            return fail(PhysicsError::BadCommand, "data holds 14 numbers per key");
        }
        let mut edits = Vec::with_capacity(keys.len());
        for (index, (key, values)) in keys.iter().zip(data.as_chunks::<EXPORT_STRIDE>().0).enumerate() {
            let key = key.as_ref();
            let state = NetBodyState::from_flat(values).map_err(|failure| failure.at(index))?;
            let edit = self.check_import(key, &state).map_err(|failure| failure.at(index))?;
            edits.push((key, edit));
        }
        for (key, edit) in edits {
            self.edit_body(key, edit);
        }
        Ok(())
    }

    /// Judges one import (§9.2) and returns its edit; changes nothing.
    fn check_import(&self, key: &str, state: &NetBodyState) -> Result<BodyEdit, PhysicsFailure> {
        check_key(key)?;
        let limits = self.desc.limits;
        let p = position(state.p, "p", &limits)?;
        let q = any_quat(state.q, "q")?;
        let v = bounded_speed(state.v, "v", limits.max_speed)?;
        let w = bounded_speed(state.w, "w", limits.max_angular_speed)?;
        self.ledger.body_of_type(key, &[BodyType::Dynamic, BodyType::Kinematic])?;
        let up = self.desc.up_axis;
        Ok(BodyEdit::Import {
            translation: vec_in(up, p),
            rotation: quat_in(up, q),
            linvel: vec_in(up, v),
            angvel: vec_in(up, w),
            sleeping: state.sleeping,
        })
    }

    /// The world's counters (§11); `step_ms` is the binding's own measurement.
    pub(crate) fn stats(&self, step_ms: f64) -> Stats {
        let states = self.bodies.values().map(|e| self.net_state(e.handle, e.body_type, e.escaped));
        Stats {
            tick: self.tick,
            bodies: self.bodies.len(),
            awake: states.filter(|net| !net.sleeping).count(),
            colliders: self.bodies.values().map(|entry| entry.colliders.len()).sum(),
            joints: self.joints.len(),
            contact_pairs: self.contact_pairs,
            queries_this_step: self.queries_this_step,
            step_ms,
            memory_bytes: self.memory_bytes(),
        }
    }
}
