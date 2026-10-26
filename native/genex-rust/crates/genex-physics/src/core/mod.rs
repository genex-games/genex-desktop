//! The backend-neutral world: caller keys, limits, the z-up mapping on the way out, escaped bodies,
//! change tracking, memory accounting and hashes, over any [`Backend`]. Every ordered collection is
//! keyed by caller key (`BTreeMap`), so nothing depends on a backend's internal order.
//!
//! Commands (§7) go through two phases: `check` judges one against a [`Ledger`] and returns an
//! [`ops::Op`] that cannot fail, and `commit` records it in the ledger and applies it. An atomic
//! batch checks every command on a copy of the ledger before committing any (`commands.rs`).

mod commands;
mod events;
mod ops;
mod queries;
mod reads;
mod step;

use std::collections::BTreeMap;

use crate::axes::{quat_out, vec_in, vec_out};
use crate::backend::{Backend, StepParams};
use crate::build_id::build_id_without_target;
use crate::canon::Canon;
use crate::hash::{Fnv1a64, fnv1a64, hex16};
use crate::joint::JointSpec;
use crate::kinematic::RawPose;
use crate::ledger::Ledger;
use crate::num::{out_quat, out_vec};
use crate::state::{BodyFilter, BodyState};
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

/// What the neutral layer keeps per body besides its ledger facts.
struct Entry<H> {
    handle: H,
    /// The body's name in the backend's events and query results (see [`Core::names`]).
    tag: u64,
    /// Its colliders' keys, in the order the backend indexes them.
    colliders: Vec<String>,
    kind: Option<String>,
    body_type: BodyType,
    escaped: bool,
    /// Each collider's (member, collides) masks, for `areaPush`'s filter.
    groups: Vec<(u16, u16)>,
    /// A kinematic body's target for the next step, in the caller frame (§7.2).
    target: Option<RawPose>,
    last: NetState,
    /// When the body last changed: `2·tick` for a step that ended at `tick`, `2·tick + 1` for a
    /// command applied while the world was at `tick`, so "changed after tick T" is `mark > 2·T`.
    changed_mark: u64,
}

/// What the neutral layer keeps per joint.
struct JointEntry<J> {
    handle: J,
    a: String,
    b: Option<String>,
    spec: JointSpec,
}

/// The neutral world over a backend `B`.
pub(crate) struct Core<B: Backend> {
    desc: ResolvedWorldDesc,
    backend: B,
    ledger: Ledger,
    bodies: BTreeMap<String, Entry<B::Body>>,
    joints: BTreeMap<String, JointEntry<B::Joint>>,
    /// The static world as given, for `physicsHash`; `None` until `addStaticWorld`.
    static_canon: Option<Canon>,
    /// Every body's and static piece's key by its tag. Tags are handed out in order and never
    /// reused, so a stale backend report can never name a later body.
    names: BTreeMap<u64, String>,
    /// Each static piece's tag by its key.
    static_tags: BTreeMap<String, u64>,
    next_tag: u64,
    /// Queries counted toward the next step's `limits.queriesPerStep` (§13).
    queries_this_step: u32,
    /// Contact pairs the backend held at the end of the last step.
    contact_pairs: usize,
    tick: u64,
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
            ledger: Ledger::new(),
            bodies: BTreeMap::new(),
            joints: BTreeMap::new(),
            static_canon: None,
            names: BTreeMap::new(),
            static_tags: BTreeMap::new(),
            next_tag: 0,
            queries_this_step: 0,
            contact_pairs: 0,
            tick: 0,
        }
    }

    /// A fresh tag for a body or static piece named `key`.
    fn new_tag(&mut self, key: &str) -> u64 {
        let tag = self.next_tag;
        self.next_tag += 1;
        self.names.insert(tag, key.to_string());
        tag
    }

    /// The body (or static piece) key, collider key and kind of a collider the backend names.
    fn collider_name(&self, id: crate::backend::ColliderId) -> Option<(&str, &str, Option<&str>)> {
        let key = self.names.get(&id.tag)?;
        let Some(entry) = self.bodies.get(key) else { return Some((key, key, None)) };
        let collider = entry.colliders.get(id.index as usize)?;
        Some((key, collider, entry.kind.as_deref()))
    }

    /// The tag of a body or static piece, by key.
    fn tag_of(&self, key: &str) -> Option<u64> {
        self.bodies.get(key).map(|entry| entry.tag).or_else(|| self.static_tags.get(key).copied())
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
        self.ledger.memory()
    }

    /// The number of joints.
    pub(crate) fn joint_count(&self) -> usize {
        self.joints.len()
    }

    fn command_mark(&self) -> u64 {
        2 * self.tick + 1
    }

    fn net_state(&self, handle: B::Body, body_type: BodyType, escaped: bool) -> NetState {
        net_state(&self.backend, self.desc.up_axis, handle, body_type, escaped)
    }

    /// Re-reads one body after a command and marks it changed if any replicated bit moved.
    fn touch(&mut self, key: &str) {
        let mark = self.command_mark();
        let up = self.desc.up_axis;
        let Some(entry) = self.bodies.get_mut(key) else { return };
        let now = net_state(&self.backend, up, entry.handle, entry.body_type, entry.escaped);
        if now.bits() != entry.last.bits() {
            entry.changed_mark = mark;
        }
        entry.last = now;
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

    /// FNV-1a 64 of the tick, every body and every joint's motor in key order (§10.1).
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
        for (key, joint) in &self.joints {
            hash.write(key.as_bytes());
            hash.write(&[0]);
            for value in joint.spec.motor.unwrap_or_default().hash_values() {
                hash.write_f32(value);
            }
        }
        hash.finish()
    }

    /// The canonical JSON `physicsHash` covers (§10.2).
    pub(crate) fn physics_json(&self) -> String {
        let empty = crate::static_world::empty_canon();
        Canon::object([
            ("build", Canon::Str(build_id_without_target())),
            ("static", self.static_canon.clone().unwrap_or(empty)),
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

/// A body's replicated fields in the caller frame. Fixed and escaped bodies report asleep and still.
fn net_state<B: Backend>(backend: &B, up: UpAxis, handle: B::Body, body_type: BodyType, escaped: bool) -> NetState {
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
