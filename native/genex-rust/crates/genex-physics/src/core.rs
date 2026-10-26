//! The backend-neutral world: caller keys, limits, the z-up mapping on the way out, escaped bodies,
//! change tracking, memory accounting and hashes, over any [`Backend`]. Every ordered collection is
//! keyed by caller key (`BTreeMap`), so nothing depends on a backend's internal order.

use std::collections::BTreeMap;

use crate::axes::{quat_out, vec_in, vec_out};
use crate::backend::{Backend, RawBodyState, StepParams};
use crate::body::{BodyDesc, validate_body};
use crate::build_id::build_id_without_target;
use crate::canon::Canon;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::hash::{Fnv1a64, fnv1a64, hex16};
use crate::key::check_key;
use crate::memory::{WORLD_BASE_BYTES, body_bytes, contact_bytes};
use crate::num::{out_quat, out_vec};
use crate::state::{BodyFilter, BodyState, StepResult};
use crate::types::{BodyType, Pose, UpAxis};
use crate::world_desc::ResolvedWorldDesc;

/// A body's replicated fields in the caller frame, as the f32s the core holds (§9.2).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct NetState {
    pub p: [f32; 3],
    pub q: [f32; 4],
    pub v: [f32; 3],
    pub w: [f32; 3],
    pub sleeping: bool,
}

impl NetState {
    /// The fields' bits, for "changed" (§9.1): a change is a change of f32 bits.
    fn bits(&self) -> ([u32; 13], bool) {
        let mut bits = [0u32; 13];
        let values = self.p.iter().chain(&self.q).chain(&self.v).chain(&self.w);
        for (slot, value) in bits.iter_mut().zip(values) {
            *slot = value.to_bits();
        }
        (bits, self.sleeping)
    }
}

/// What the neutral layer keeps per body.
struct Entry<H> {
    handle: H,
    kind: Option<String>,
    body_type: BodyType,
    escaped: bool,
    ccd: bool,
    triangles: usize,
    memory: u64,
    last: NetState,
    /// When the body last changed: `2·tick` for a step that ended at `tick`, `2·tick + 1` for a
    /// command applied while the world was at `tick`, so "changed after tick T" is `mark > 2·T`.
    changed_mark: u64,
}

/// The neutral world over a backend `B`.
pub(crate) struct Core<B: Backend> {
    desc: ResolvedWorldDesc,
    backend: B,
    bodies: BTreeMap<String, Entry<B::Body>>,
    tick: u64,
    triangles: usize,
    ccd_bodies: usize,
    body_memory: u64,
}

impl<B: Backend> Core<B> {
    /// An empty world of a resolved description.
    pub(crate) fn new(desc: ResolvedWorldDesc) -> Self {
        let params = StepParams {
            gravity: vec_in(desc.up_axis, desc.gravity),
            inner_dt: desc.inner_dt(),
            length_unit: desc.length_unit,
            solver_iterations: desc.solver_iterations,
        };
        Self {
            desc,
            backend: B::create(&params),
            bodies: BTreeMap::new(),
            tick: 0,
            triangles: 0,
            ccd_bodies: 0,
            body_memory: 0,
        }
    }

    /// The resolved description.
    pub(crate) fn desc(&self) -> &ResolvedWorldDesc {
        &self.desc
    }

    /// The tick counter.
    pub(crate) fn tick(&self) -> u64 {
        self.tick
    }

    /// The world's modelled memory (§11.1).
    pub(crate) fn memory_bytes(&self) -> u64 {
        WORLD_BASE_BYTES + self.body_memory + contact_bytes(self.backend.contact_pairs())
    }

    fn command_mark(&self) -> u64 {
        2 * self.tick + 1
    }

    /// Inserts a body (§6.1); a refusal changes nothing.
    pub(crate) fn spawn(&mut self, desc: &BodyDesc) -> Result<(), PhysicsFailure> {
        let limits = self.desc.limits;
        let valid = validate_body(desc, self.desc.up_axis, &limits)?;
        if self.bodies.contains_key(&valid.key) {
            return fail(PhysicsError::DuplicateKey, "a body already has that key");
        }
        if self.bodies.len() >= limits.bodies as usize {
            return fail(PhysicsError::LimitBodies, "limits.bodies reached");
        }
        if valid.collider_keys.len() > limits.colliders_per_body as usize {
            return fail(PhysicsError::LimitColliders, "more colliders than limits.collidersPerBody");
        }
        if valid.facts.hull_points_max > limits.hull_vertices as usize {
            return fail(PhysicsError::LimitHullVertices, "a hull has more points than limits.hullVertices");
        }
        if self.triangles + valid.facts.triangles > limits.triangles as usize {
            return fail(PhysicsError::LimitTriangles, "limits.triangles reached");
        }
        if valid.spec.ccd && self.ccd_bodies >= limits.ccd_bodies as usize {
            return fail(PhysicsError::LimitCcd, "limits.ccdBodies reached");
        }
        let key_bytes = valid.key.len() + valid.collider_keys.iter().map(String::len).sum::<usize>();
        let memory = body_bytes(valid.collider_keys.len(), key_bytes, &valid.facts);
        if self.memory_bytes() + memory > u64::from(limits.memory_bytes) {
            return fail(PhysicsError::LimitMemory, "the body would take the world past limits.memoryBytes");
        }
        let handle = self
            .backend
            .insert(&valid.spec)
            .map_err(|_| PhysicsFailure::new(PhysicsError::BadShape, "the backend could not build a shape"))?;
        let body_type = valid.spec.body_type;
        let last = self.net_state(handle, body_type, false);
        self.triangles += valid.facts.triangles;
        self.ccd_bodies += usize::from(valid.spec.ccd);
        self.body_memory += memory;
        let entry = Entry {
            handle,
            kind: valid.kind,
            body_type,
            escaped: false,
            ccd: valid.spec.ccd,
            triangles: valid.facts.triangles,
            memory,
            last,
            changed_mark: self.command_mark(),
        };
        self.bodies.insert(valid.key, entry);
        Ok(())
    }

    /// Removes a body and its colliders (§7).
    pub(crate) fn remove(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        check_key(key)?;
        let Some(entry) = self.bodies.remove(key) else {
            return fail(PhysicsError::UnknownKey, "no body has that key");
        };
        self.backend.remove(entry.handle);
        self.triangles -= entry.triangles;
        self.ccd_bodies -= usize::from(entry.ccd);
        self.body_memory -= entry.memory;
        Ok(())
    }

    /// Advances `dt` in `substeps` inner steps (§8), then handles escaped bodies (§8.2).
    pub(crate) fn step(&mut self) -> StepResult {
        let starts: Vec<RawBodyState> = self.bodies.values().map(|e| self.backend.state(e.handle)).collect();
        for _ in 0..self.desc.substeps {
            self.backend.step();
        }
        self.tick += 1;
        let escaped = self.freeze_escaped(&starts);
        self.track_changes();
        let memory_exceeded = self.memory_bytes() > u64::from(self.desc.limits.memory_bytes);
        StepResult { tick: self.tick, events: Vec::new(), overflowed: false, escaped, memory_exceeded }
    }

    /// Freezes every body that left `worldExtent` or went non-finite on this step, a non-finite one
    /// back at its pose from the step's start; returns their keys in key order.
    fn freeze_escaped(&mut self, starts: &[RawBodyState]) -> Vec<String> {
        let extent = self.desc.limits.world_extent;
        let mut escaped = Vec::new();
        for ((key, entry), start) in self.bodies.iter_mut().zip(starts) {
            if entry.escaped {
                continue;
            }
            let now = self.backend.state(entry.handle);
            let pose = if is_finite(&now) { now } else { *start };
            let outside = pose.translation.iter().any(|c| c.abs() > extent);
            if is_finite(&now) && !outside {
                continue;
            }
            self.backend.freeze(entry.handle, pose.translation, pose.rotation);
            entry.escaped = true;
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

    fn net_state(&self, handle: B::Body, body_type: BodyType, escaped: bool) -> NetState {
        net_state(&self.backend, self.desc.up_axis, handle, body_type, escaped)
    }

    /// One body's state, or `None` for an unknown or malformed key (§9.1).
    pub(crate) fn body(&self, key: &str) -> Option<BodyState> {
        let entry = self.bodies.get(key)?;
        Some(self.body_state(key, entry))
    }

    fn body_state(&self, key: &str, entry: &Entry<B::Body>) -> BodyState {
        let net = self.net_state(entry.handle, entry.body_type, entry.escaped);
        BodyState {
            key: key.to_string(),
            kind: entry.kind.clone(),
            body_type: entry.body_type,
            pose: Pose { p: out_vec(net.p), q: out_quat(net.q) },
            linvel: out_vec(net.v),
            angvel: out_vec(net.w),
            sleeping: net.sleeping,
        }
    }

    /// The bodies `filter` selects, in key order (§9.1).
    pub(crate) fn bodies(&self, filter: &BodyFilter) -> Vec<BodyState> {
        self.bodies
            .iter()
            .map(|(key, entry)| (entry, self.body_state(key, entry)))
            .filter(|(entry, state)| selects(filter, entry.changed_mark, state))
            .map(|(_, state)| state)
            .collect()
    }

    /// FNV-1a 64 of the tick and every body in key order (§10.1). Joints join in a later piece.
    pub(crate) fn state_hash(&self) -> u64 {
        let mut hash = Fnv1a64::new();
        hash.write(&self.tick.to_le_bytes());
        for (key, entry) in &self.bodies {
            hash.write(key.as_bytes());
            hash.write(&[0, entry.body_type.hash_byte()]);
            let net = self.net_state(entry.handle, entry.body_type, entry.escaped);
            for value in net.p.iter().chain(&net.q).chain(&net.v).chain(&net.w) {
                hash.write_f32(*value);
            }
            hash.write(&[u8::from(net.sleeping)]);
        }
        hash.finish()
    }

    /// The canonical JSON `physicsHash` covers (§10.2).
    pub(crate) fn physics_json(&self) -> String {
        let empty_static = Canon::object([("boxes", Canon::Arr(Vec::new())), ("ramps", Canon::Arr(Vec::new()))]);
        Canon::object([
            ("build", Canon::Str(build_id_without_target())),
            ("static", empty_static),
            ("world", self.desc.canon()),
        ])
        .write()
    }

    /// `physicsHash` (§10.2): 16 lowercase hex digits.
    pub(crate) fn physics_hash(&self) -> String {
        hex16(fnv1a64(self.physics_json().as_bytes()))
    }
}

/// Whether `filter` lists a body (§9.1).
fn selects(filter: &BodyFilter, changed_mark: u64, state: &BodyState) -> bool {
    let kind_ok = match (&filter.kinds, &state.kind) {
        (None, _) => true,
        (Some(kinds), Some(kind)) => kinds.contains(kind),
        (Some(_), None) => false,
    };
    let awake_ok = !(filter.awake_only && state.sleeping);
    let changed_ok = filter.changed_since_tick.is_none_or(|tick| changed_mark > 2 * tick);
    kind_ok && awake_ok && changed_ok
}

fn is_finite(state: &RawBodyState) -> bool {
    let values = state.translation.iter().chain(&state.rotation).chain(&state.linvel).chain(&state.angvel);
    values.into_iter().all(|v| v.is_finite())
}

/// A body's replicated fields in the caller frame. Fixed and escaped bodies report asleep and still.
fn net_state<B: Backend>(
    backend: &B,
    up: UpAxis,
    handle: B::Body,
    body_type: BodyType,
    escaped: bool,
) -> NetState {
    let raw = backend.state(handle);
    let still = escaped || body_type == BodyType::Fixed;
    let (v, w) = if still { ([0.0; 3], [0.0; 3]) } else { (raw.linvel, raw.angvel) };
    NetState {
        p: vec_out(up, raw.translation),
        q: quat_out(up, raw.rotation),
        v: vec_out(up, v),
        w: vec_out(up, w),
        sleeping: still || raw.sleeping,
    }
}
