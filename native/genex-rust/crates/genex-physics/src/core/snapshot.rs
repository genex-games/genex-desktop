//! `snapshot()` and `restore()` (§9.4): the whole world as bytes, and a new world from them.
//!
//! The payload is the resolved description, the static world as given, every record the neutral
//! layer keeps (bodies, joints, tags, ledger, tick, query quota) and the backend's own bytes,
//! solver caches included, so a restored world steps on bit for bit (§9.3). A restore checks the
//! envelope, then every neutral record against the others and the limits, then `LimitMemory`, and
//! only then reads the backend's bytes; any failure leaves the caller's world as it was.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize, Serializer};

use super::{Core, Entry, JointEntry, PairName, step_params};
use crate::backend::Backend;
use crate::build_id::build_id;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::key::{check_key, check_kind, check_object_key};
use crate::ledger::Ledger;
use crate::memory::{WORLD_BASE_BYTES, contact_bytes};
use crate::snapshot::{DescImage, bad, open, seal, within};
use crate::static_world::{StaticWorld, validate_static};
use crate::types::UpAxis;
use crate::world_desc::ResolvedWorldDesc;

/// Bytes written as one length-prefixed run.
struct Bytes<'a>(&'a [u8]);

impl Serialize for Bytes<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(self.0)
    }
}

/// The static world as the payload holds it: §17.7's arrays as given.
type StaticImage = (Vec<Vec<f64>>, Vec<Vec<f64>>);

/// What `snapshot` writes, borrowed from the core.
#[derive(Serialize)]
struct ImageRef<'a, H: Serialize, J: Serialize> {
    desc: DescImage,
    static_world: Option<StaticImage>,
    bodies: &'a BTreeMap<String, Entry<H>>,
    joints: &'a BTreeMap<String, JointEntry<J>>,
    names: &'a BTreeMap<u64, String>,
    static_tags: &'a BTreeMap<String, u64>,
    next_tag: u64,
    queries_this_step: u32,
    contact_pairs: u64,
    tick: u64,
    ledger: &'a Ledger,
    backend: Bytes<'a>,
}

/// What `restore` reads: the same fields, owned, the backend's bytes borrowed from the input.
#[derive(Deserialize)]
struct Image<'a, H, J> {
    desc: DescImage,
    static_world: Option<StaticImage>,
    bodies: BTreeMap<String, Entry<H>>,
    joints: BTreeMap<String, JointEntry<J>>,
    names: BTreeMap<u64, String>,
    static_tags: BTreeMap<String, u64>,
    next_tag: u64,
    queries_this_step: u32,
    contact_pairs: u64,
    tick: u64,
    ledger: Ledger,
    #[serde(borrow)]
    backend: &'a [u8],
}

fn internal(detail: &str) -> PhysicsFailure {
    PhysicsFailure::new(PhysicsError::Internal, detail)
}

impl<B: Backend> Core<B> {
    /// The whole world as bytes (§9.4); fails only with `internal`.
    pub(crate) fn snapshot(&self) -> Result<Vec<u8>, PhysicsFailure> {
        let backend = self.backend.save().ok_or_else(|| internal("the backend could not write its state"))?;
        let static_world = self.static_world.as_ref().map(|world| (world.boxes.clone(), world.ramps.clone()));
        let image = ImageRef {
            desc: DescImage::of(&self.desc),
            static_world,
            bodies: &self.bodies,
            joints: &self.joints,
            names: &self.names,
            static_tags: &self.static_tags,
            next_tag: self.next_tag,
            queries_this_step: self.queries_this_step,
            contact_pairs: self.contact_pairs as u64,
            tick: self.tick,
            ledger: &self.ledger,
            backend: Bytes(&backend),
        };
        let mut payload = postcard::to_allocvec(&image).map_err(|_| internal("the snapshot could not be written"))?;
        if !self.carried.is_empty() {
            let carried: Vec<&PairName> = self.carried.iter().collect();
            let extension = postcard::to_allocvec(&carried).map_err(|_| internal("the snapshot could not be written"))?;
            payload.extend_from_slice(&extension);
        }
        Ok(seal(&build_id(), self.tick, &payload))
    }

    /// A new world from `bytes` (§9.4): `BadSnapshot`, `BuildMismatch` or `LimitMemory` on failure.
    pub(crate) fn restore(bytes: &[u8]) -> Result<Self, PhysicsFailure> {
        let header = open(bytes)?;
        let (image, rest) = postcard::take_from_bytes::<Image<'_, B::Body, B::Joint>>(header.payload)
            .map_err(|_| bad("the snapshot's payload does not read back"))?;
        if image.tick != header.tick {
            return fail(PhysicsError::BadSnapshot, "the snapshot's payload does not match its header");
        }
        let carried = read_carried(rest, &image)?;
        let desc = image.desc.resolve()?;
        let static_canon = check_records(&image, &desc)?;
        if image.ledger.model_bytes() > u64::from(desc.limits.memory_bytes) {
            return fail(PhysicsError::LimitMemory, "the snapshot's world does not fit its limits.memoryBytes");
        }
        let backend = B::load(image.backend, &step_params(&desc)).ok_or_else(|| bad("the backend's state does not read back"))?;
        check_backend(&backend, &image)?;
        Ok(Self {
            desc,
            backend,
            ledger: image.ledger,
            bodies: image.bodies,
            joints: image.joints,
            static_canon,
            static_world: image.static_world.map(|(boxes, ramps)| StaticWorld { boxes, ramps }),
            names: image.names,
            static_tags: image.static_tags,
            next_tag: image.next_tag,
            queries_this_step: image.queries_this_step,
            contact_pairs: image.contact_pairs as usize,
            tick: image.tick,
            carried,
        })
    }
}

/// The 1.1 draft's extension (§20.4): the carried pairs, written after the 1.0 payload only when
/// there are any, so a world never canonicalized writes 1.0's bytes exactly. Every side must
/// name a body (or static piece) of the image and one of its colliders, and the list must be in
/// order and non-empty, as `snapshot` writes it.
fn read_carried<H, J>(bytes: &[u8], image: &Image<'_, H, J>) -> Result<BTreeSet<PairName>, PhysicsFailure> {
    if bytes.is_empty() {
        return Ok(BTreeSet::new());
    }
    let (pairs, rest) = postcard::take_from_bytes::<Vec<PairName>>(bytes).map_err(|_| bad("the snapshot's extension does not read back"))?;
    let ordered = pairs.windows(2).all(|two| two[0] < two[1]);
    let named = |(body, collider): &(String, String)| match image.bodies.get(body) {
        Some(entry) => entry.colliders.contains(collider),
        None => image.static_tags.contains_key(body) && body == collider,
    };
    let sides_ok = pairs.iter().all(|pair| pair.sides[0] < pair.sides[1] && pair.sides.iter().all(named));
    if !rest.is_empty() || pairs.is_empty() || !ordered || !sides_ok {
        return fail(PhysicsError::BadSnapshot, "the snapshot's carried pairs are malformed");
    }
    Ok(pairs.into_iter().collect())
}

/// Checks every neutral record against the others and the limits; returns the static world's
/// canonical form. Anything a world could never hold is `BadSnapshot`.
fn check_records<H, J>(image: &Image<'_, H, J>, desc: &ResolvedWorldDesc) -> Result<Option<crate::canon::Canon>, PhysicsFailure> {
    let limits = &desc.limits;
    within(image.bodies.len(), limits.bodies, "bodies")?;
    within(image.joints.len(), limits.joints, "joints")?;
    within(image.queries_this_step as usize, limits.queries_per_step, "queries")?;
    check_bodies(image, limits.colliders_per_body)?;
    check_joints(image)?;
    check_ledger(&image.ledger, image, desc)?;
    let canon = check_static(image, desc)?;
    check_names(image)?;
    Ok(canon)
}

fn check_bodies<H, J>(image: &Image<'_, H, J>, colliders_max: u32) -> Result<(), PhysicsFailure> {
    for (key, entry) in &image.bodies {
        check_object_key(key).map_err(|_| bad("a body key is malformed"))?;
        let kind_ok = entry.kind.as_deref().is_none_or(|kind| !kind.is_empty() && check_kind(kind).is_ok());
        let count = entry.colliders.len();
        let unique: BTreeSet<&String> = entry.colliders.iter().collect();
        let keys_ok = entry.colliders.iter().all(|c| check_object_key(c).is_ok()) && unique.len() == count;
        let shape_ok = count >= 1 && count <= colliders_max as usize && entry.groups.len() == count;
        if !(kind_ok && keys_ok && shape_ok) {
            return fail(PhysicsError::BadSnapshot, "a body's colliders or kind are malformed");
        }
        let facts = image.ledger.bodies.get(key).ok_or_else(|| bad("a body is missing from the ledger"))?;
        if facts.body_type != entry.body_type || image.names.get(&entry.tag) != Some(key) {
            return fail(PhysicsError::BadSnapshot, "a body's records disagree");
        }
    }
    Ok(())
}

fn check_joints<H, J>(image: &Image<'_, H, J>) -> Result<(), PhysicsFailure> {
    for (key, joint) in &image.joints {
        check_object_key(key).map_err(|_| bad("a joint key is malformed"))?;
        let ends_ok = image.bodies.contains_key(&joint.a) && joint.b.as_ref().is_none_or(|b| image.bodies.contains_key(b));
        let facts = image.ledger.joints.get(key).ok_or_else(|| bad("a joint is missing from the ledger"))?;
        let facts_ok = facts.a == joint.a && facts.b == joint.b && facts.joint_type == joint.spec.joint_type;
        if !(ends_ok && facts_ok) {
            return fail(PhysicsError::BadSnapshot, "a joint's records disagree");
        }
    }
    Ok(())
}

/// The ledger lists exactly the image's bodies and joints, and its totals are their sums.
fn check_ledger<H, J>(ledger: &Ledger, image: &Image<'_, H, J>, desc: &ResolvedWorldDesc) -> Result<(), PhysicsFailure> {
    let limits = &desc.limits;
    let same_keys = ledger.bodies.keys().eq(image.bodies.keys()) && ledger.joints.keys().eq(image.joints.keys());
    let triangles = checked_sum(ledger.bodies.values().map(|f| f.triangles as u64));
    let ccd = ledger.bodies.values().filter(|f| f.ccd).count();
    let body_bytes = checked_sum(ledger.bodies.values().map(|f| f.bytes));
    let joint_bytes = checked_sum(ledger.joints.values().map(|f| f.bytes));
    let floor = [body_bytes, joint_bytes].into_iter().try_fold(WORLD_BASE_BYTES, |sum, part| sum.checked_add(part?));
    let totals_ok = triangles == Some(ledger.triangles as u64)
        && ledger.ccd_bodies == ccd
        && floor.is_some_and(|floor| ledger.object_bytes >= floor)
        && ledger.contact_bytes == contact_bytes(image.contact_pairs as usize)
        && ledger.object_bytes.checked_add(ledger.contact_bytes).is_some();
    if !(same_keys && totals_ok) {
        return fail(PhysicsError::BadSnapshot, "the snapshot's ledger disagrees with its records");
    }
    within(ledger.triangles, limits.triangles, "triangles")?;
    within(ledger.ccd_bodies, limits.ccd_bodies, "CCD bodies")?;
    within(ledger.static_pieces, limits.static_pieces, "static pieces")
}

/// The sum of forged numbers, or `None` when it overflows.
fn checked_sum(values: impl Iterator<Item = u64>) -> Option<u64> {
    values.into_iter().try_fold(0u64, u64::checked_add)
}

/// The static world validates again, in a z-up world, and its pieces are the image's static keys.
fn check_static<H, J>(image: &Image<'_, H, J>, desc: &ResolvedWorldDesc) -> Result<Option<crate::canon::Canon>, PhysicsFailure> {
    let Some((boxes, ramps)) = &image.static_world else {
        let none = image.static_tags.is_empty() && !image.ledger.static_added && image.ledger.static_pieces == 0;
        return if none { Ok(None) } else { fail(PhysicsError::BadSnapshot, "static records without a static world") };
    };
    let world = StaticWorld { boxes: boxes.clone(), ramps: ramps.clone() };
    let valid = validate_static(&world).map_err(|_| bad("the snapshot's static world is invalid"))?;
    let keys_ok = valid.pieces.iter().map(|piece| &piece.key).eq(image.static_tags.keys());
    let names_ok = image.static_tags.iter().all(|(key, tag)| image.names.get(tag) == Some(key));
    let ledger_ok = image.ledger.static_added && image.ledger.static_pieces == valid.pieces.len();
    if !(desc.up_axis == UpAxis::Z && keys_ok && names_ok && ledger_ok) {
        return fail(PhysicsError::BadSnapshot, "the snapshot's static records disagree");
    }
    Ok(Some(valid.canon))
}

/// Every tag names exactly one body or piece, below the next tag to hand out.
fn check_names<H, J>(image: &Image<'_, H, J>) -> Result<(), PhysicsFailure> {
    let count_ok = image.names.len() == image.bodies.len() + image.static_tags.len();
    let tags_ok = image.names.keys().next_back().is_none_or(|last| *last < image.next_tag);
    let keys_ok = image.names.values().all(|key| check_key(key).is_ok());
    if !(count_ok && tags_ok && keys_ok) {
        return fail(PhysicsError::BadSnapshot, "the snapshot's tags disagree with its bodies");
    }
    Ok(())
}

/// The backend holds every body with its colliders and every joint the records name, and nothing more.
fn check_backend<B: Backend>(backend: &B, image: &Image<'_, B::Body, B::Joint>) -> Result<(), PhysicsFailure> {
    let expected = image.bodies.len() + image.static_tags.len() + B::OWN_BODIES;
    let colliders_ok =
        image.bodies.values().all(|entry| backend.collider_count(entry.handle) == Some(entry.colliders.len()));
    let handles: Vec<B::Body> = image.bodies.values().map(|entry| entry.handle).collect();
    let distinct = handles.iter().enumerate().all(|(i, h)| !handles[..i].contains(h));
    let joints_ok = image.joints.values().all(|joint| backend.has_joint(joint.handle));
    if !(backend.body_count() == expected && colliders_ok && distinct && joints_ok) {
        return fail(PhysicsError::BadSnapshot, "the backend's state disagrees with the snapshot's records");
    }
    Ok(())
}
