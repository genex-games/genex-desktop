//! `canonicalize({ quantize })` and `importWire` (contract 1.1 draft, §20).
//!
//! `canonicalize` rebuilds the backend in key order from each body's state and parameters alone
//! (`Backend::rebuild`), so a world that imports the same states into the same bodies and
//! canonicalizes steps on bit for bit with the world that exported them. With `quantize`, every
//! simulated body is first snapped onto its wire row (`wire.rs`) by the very import `importWire`
//! makes, so the rows a host sends are the state exactly. The pairs touching across the rebuild
//! are carried (`Core::carried`), so their begins are not reported again.

use super::{Core, NetState, PairName};
use crate::backend::{Backend, BodyEdit, RawPair};
use crate::body::position;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::key::check_key;
use crate::memory::contact_bytes;
use crate::num::{any_quat, exact_quat};
use crate::state::NetBodyState;
use crate::types::BodyType;
use crate::wire::{WIRE_ORIENTATION, WIRE_REST_MAX, WIRE_SPAN, WIRE_STRIDE, WIRE_VELOCITY, dequantize, quantize, rest_of, rest_steps};
use crate::axes::{quat_in, vec_in};

/// How many times quantizing a rotation is repeated to reach integers whose decoded, renormalised
/// rotation quantizes to themselves (one or two in practice).
const ROTATION_ROUNDS: usize = 8;

/// One body's wire row, decoded and checked.
struct WireRow {
    p: [f32; 3],
    q: [u32; 4],
    lv: [u32; 3],
    av: [u32; 3],
    sleeping: bool,
    rest: u32,
}

/// The rotation a client imports from wire integers `q`: decoded, rounded to f32 and renormalised
/// as every import does (§9.2); `None` when it has no length.
fn rotation_of(q: [u32; 4]) -> Option<[f32; 4]> {
    any_quat(q.map(|c| dequantize(c, WIRE_ORIENTATION)), "q").ok()
}

/// Integers for rotation `q` that decode (and renormalise) to a rotation quantizing back to
/// themselves, so the host's own quantization of the snapped state sends these very integers.
fn quantize_rotation(q: [f32; 4]) -> [u32; 4] {
    let mut ints = q.map(|c| quantize(f64::from(c), WIRE_ORIENTATION));
    for _ in 0..ROTATION_ROUNDS {
        let Some(back) = rotation_of(ints) else { break };
        let again = back.map(|c| quantize(f64::from(c), WIRE_ORIENTATION));
        if again == ints {
            break;
        }
        ints = again;
    }
    ints
}

/// A quantized field's integer: a whole number in `0..=max`; NaN and infinities are `NonFinite`.
fn wire_integer(value: f32, max: u32, what: &str) -> Result<u32, PhysicsFailure> {
    if !value.is_finite() {
        return fail(PhysicsError::NonFinite, format!("{what} is not finite"));
    }
    let whole = value.fract() == 0.0 && value >= 0.0 && value <= max as f32;
    if !whole {
        return fail(PhysicsError::OutOfRange, format!("{what} must be an integer in 0..={max}"));
    }
    Ok(value as u32)
}

fn integers<const N: usize>(values: &[f32], what: &str) -> Result<[u32; N], PhysicsFailure> {
    let mut out = [0u32; N];
    for (slot, value) in out.iter_mut().zip(values) {
        *slot = wire_integer(*value, WIRE_SPAN, what)?;
    }
    Ok(out)
}

/// Reads one row of [`WIRE_STRIDE`] numbers: `BadCommand` for a sleep flag other than 0 or 1,
/// then `NonFinite` and `OutOfRange` field by field.
fn read_row(values: &[f32]) -> Result<WireRow, PhysicsFailure> {
    let sleeping = match values[13] {
        0.0 => false,
        1.0 => true,
        _ => return fail(PhysicsError::BadCommand, "sleep is 0 or 1"),
    };
    Ok(WireRow {
        p: [values[0], values[1], values[2]],
        q: integers(&values[3..7], "q")?,
        lv: integers(&values[7..10], "lv")?,
        av: integers(&values[10..13], "av")?,
        sleeping,
        rest: wire_integer(values[14], WIRE_REST_MAX, "rest")?,
    })
}

impl<B: Backend> Core<B> {
    /// The network state a client imports from `row` (§20.2): position as sent, rotation decoded
    /// and renormalised in f32 (an import with the timer then takes it as it is), velocities decoded
    /// (linear times `lengthUnit`), the sleep timer as whole inner steps.
    fn state_of_row(&self, row: &WireRow) -> Result<NetBodyState, PhysicsFailure> {
        let length_unit = f64::from(self.desc.length_unit);
        let velocity = |q: u32| dequantize(q, WIRE_VELOCITY);
        let Some(rotation) = rotation_of(row.q) else { return fail(PhysicsError::OutOfRange, "q has no direction") };
        Ok(NetBodyState {
            p: row.p.map(f64::from),
            q: rotation.map(f64::from),
            v: row.lv.map(|q| velocity(q) * length_unit),
            w: row.av.map(velocity),
            sleeping: row.sleeping,
            rest: Some(f64::from(rest_of(row.rest, self.desc.inner_dt()))),
        })
    }

    /// The wire row of a body's state (§20.1): what the host sends for it, rotation integers
    /// chosen to be stable under the import's renormalisation.
    fn row_of(&self, net: &NetState, rest: f32) -> WireRow {
        let length_unit = f64::from(self.desc.length_unit);
        let velocity = |v: f32, scale: f64| quantize(f64::from(v) / scale, WIRE_VELOCITY);
        WireRow {
            p: net.p.map(crate::num::unsigned_zero),
            q: quantize_rotation(net.q),
            lv: net.v.map(|v| velocity(v, length_unit)),
            av: net.w.map(|w| velocity(w, 1.0)),
            sleeping: net.sleeping,
            rest: rest_steps(rest, self.desc.inner_dt()),
        }
    }

    /// Judges one wire import and returns its edit; changes nothing. A fixed body takes the pose
    /// only, as a teleport that wakes nothing.
    fn check_wire(&self, key: &str, row: &WireRow) -> Result<BodyEdit, PhysicsFailure> {
        check_key(key)?;
        let state = self.state_of_row(row)?;
        if self.ledger.body_type(key)? != BodyType::Fixed {
            return self.check_import(key, &state);
        }
        let p = position(state.p, "p", &self.desc.limits)?;
        let q = exact_quat(state.q, "q")?;
        let up = self.desc.up_axis;
        Ok(BodyEdit::Teleport { translation: vec_in(up, p), rotation: quat_in(up, q), reset_velocity: false, wake: false })
    }

    /// `importWire(keys, rows)` (§20.2): all or none, a refusal naming its index.
    pub(crate) fn import_wire<K: AsRef<str>>(&mut self, keys: &[K], data: &[f32]) -> Result<(), PhysicsFailure> {
        if keys.len().checked_mul(WIRE_STRIDE) != Some(data.len()) {
            return fail(PhysicsError::BadCommand, "rows hold 15 numbers per key");
        }
        let mut edits = Vec::with_capacity(keys.len());
        for (index, (key, values)) in keys.iter().zip(data.as_chunks::<WIRE_STRIDE>().0).enumerate() {
            let key = key.as_ref();
            let edit = read_row(values).and_then(|row| self.check_wire(key, &row)).map_err(|failure| failure.at(index))?;
            edits.push((key, edit));
        }
        for (key, edit) in edits {
            self.edit_body(key, edit);
        }
        Ok(())
    }

    /// Snaps every simulated body onto its wire row by the import `importWire` makes (§20.1).
    fn quantize_bodies(&mut self) -> Result<(), PhysicsFailure> {
        let mut edits = Vec::new();
        for (key, entry) in &self.bodies {
            if entry.escaped {
                continue;
            }
            let net = self.net_state(entry.handle, entry.body_type, entry.escaped);
            let row = self.row_of(&net, self.backend.state(entry.handle).rest);
            edits.push((key.clone(), self.check_wire(key, &row)?));
        }
        for (key, edit) in edits {
            self.edit_body(&key, edit);
        }
        Ok(())
    }

    /// The pairs the backend holds as touching, by name, both sides named and on two bodies.
    fn touching_names(&self) -> Vec<PairName> {
        let name = |pair: &RawPair| {
            let (a, ca, _) = self.collider_name(pair.first)?;
            let (b, cb, _) = self.collider_name(pair.second)?;
            (a != b).then(|| PairName::of((a, ca), (b, cb), pair.sensors))
        };
        self.backend.touching().iter().filter_map(name).collect()
    }

    /// `canonicalize({ quantize })` (§20.1). Fails only with `internal`, when quantizing refuses
    /// a state the world holds (never expected) or the backend loses a body.
    pub(crate) fn canonicalize(&mut self, quantize: bool) -> Result<(), PhysicsFailure> {
        if quantize {
            self.quantize_bodies().map_err(|_| PhysicsFailure::new(PhysicsError::Internal, "a body's own state did not quantize"))?;
        }
        let touching = self.touching_names();
        self.carried.extend(touching);
        let static_tags: Vec<u64> = self.static_tags.values().copied().collect();
        let handles: Vec<B::Body> = self.bodies.values().map(|entry| entry.handle).collect();
        let handle_of = |key: &str| self.bodies.get(key).map(|entry| entry.handle);
        let mut joints = Vec::with_capacity(self.joints.len());
        for joint in self.joints.values() {
            let Some(a) = handle_of(&joint.a) else { return fail(PhysicsError::Internal, "a joint names a missing body") };
            joints.push((a, joint.b.as_deref().and_then(handle_of), &joint.spec));
        }
        let (bodies, joint_handles) = self.backend.rebuild(&static_tags, &handles, &joints);
        if bodies.len() != handles.len() || joint_handles.len() != joints.len() {
            return fail(PhysicsError::Internal, "the backend lost a body or joint rebuilding the world");
        }
        for (entry, handle) in self.bodies.values_mut().zip(bodies) {
            entry.handle = handle;
        }
        for (joint, handle) in self.joints.values_mut().zip(joint_handles) {
            joint.handle = handle;
        }
        self.contact_pairs = 0;
        self.ledger.contact_bytes = contact_bytes(0);
        let keys: Vec<String> = self.bodies.keys().cloned().collect();
        for key in keys {
            self.touch(&key);
        }
        Ok(())
    }
}
