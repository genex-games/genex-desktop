//! The snapshot's envelope (CONTRACT.md §9.4) and the neutral parts of its payload.
//!
//! A snapshot is a header, then a postcard payload:
//!
//! | bytes | field |
//! |---|---|
//! | 4 | the magic `GXPH` |
//! | 2 + 2 | the contract major and minor, u16 little-endian |
//! | 2 + n | the `buildId`, its UTF-8 length as u16 little-endian, then its bytes |
//! | 8 | the tick, u64 little-endian |
//! | 8 | FNV-1a 64 of the payload, u64 little-endian |
//! | 8 | the payload's length, u64 little-endian |
//! | n | the payload: the resolved description, the static world, the core's records and the backend's own state |
//!
//! Postcard writes every f32 as its four bytes and every integer the same on every target, so a
//! snapshot restores on any target of the same build (§9.4) and steps on bit for bit (§9.3).

use serde::{Deserialize, Serialize};

use crate::build_id::build_id_without_target;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::hash::fnv1a64;
use crate::types::UpAxis;
use crate::world_desc::{LimitsDesc, ResolvedWorldDesc, SolverDesc, WorldDesc};

/// The four bytes every snapshot starts with.
pub const SNAPSHOT_MAGIC: [u8; 4] = *b"GXPH";
/// The contract version a snapshot names: major and minor.
pub const SNAPSHOT_CONTRACT: (u16, u16) = (1, 0);
/// The longest buildId a header may carry.
const BUILD_ID_MAX: usize = 256;

/// A snapshot's header, read.
pub(crate) struct Header<'a> {
    pub tick: u64,
    pub payload: &'a [u8],
}

/// Writes the header in front of `payload`.
pub(crate) fn seal(build_id: &str, tick: u64, payload: &[u8]) -> Vec<u8> {
    let id = build_id.as_bytes();
    let mut out = Vec::with_capacity(36 + id.len() + payload.len());
    out.extend_from_slice(&SNAPSHOT_MAGIC);
    out.extend_from_slice(&SNAPSHOT_CONTRACT.0.to_le_bytes());
    out.extend_from_slice(&SNAPSHOT_CONTRACT.1.to_le_bytes());
    out.extend_from_slice(&(id.len() as u16).to_le_bytes());
    out.extend_from_slice(id);
    out.extend_from_slice(&tick.to_le_bytes());
    out.extend_from_slice(&fnv1a64(payload).to_le_bytes());
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// A cursor over the header's bytes; running out is `BadSnapshot` (a truncated input).
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], PhysicsFailure> {
        if self.bytes.len() < n {
            return fail(PhysicsError::BadSnapshot, "the snapshot is truncated");
        }
        let (head, rest) = self.bytes.split_at(n);
        self.bytes = rest;
        Ok(head)
    }

    fn u16(&mut self) -> Result<u16, PhysicsFailure> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u64(&mut self) -> Result<u64, PhysicsFailure> {
        let mut out = [0u8; 8];
        out.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(out))
    }
}

/// Reads and checks the header: `BadSnapshot` for a wrong magic, a truncated input, trailing bytes
/// or a bad checksum; `BuildMismatch` for another contract version or buildId (target ignored).
pub(crate) fn open(bytes: &[u8]) -> Result<Header<'_>, PhysicsFailure> {
    let mut reader = Reader { bytes };
    if reader.take(4)? != SNAPSHOT_MAGIC {
        return fail(PhysicsError::BadSnapshot, "the snapshot does not start with GXPH");
    }
    let contract = (reader.u16()?, reader.u16()?);
    let id_len = usize::from(reader.u16()?);
    if id_len > BUILD_ID_MAX {
        return fail(PhysicsError::BadSnapshot, "the snapshot's buildId is too long");
    }
    let id = reader.take(id_len)?;
    let tick = reader.u64()?;
    let checksum = reader.u64()?;
    let length = reader.u64()?;
    check_build(contract, id)?;
    if length != reader.bytes.len() as u64 {
        return fail(PhysicsError::BadSnapshot, "the snapshot's length does not match its payload");
    }
    let payload = reader.bytes;
    if fnv1a64(payload) != checksum {
        return fail(PhysicsError::BadSnapshot, "the snapshot's checksum does not match");
    }
    Ok(Header { tick, payload })
}

/// `BuildMismatch` unless the snapshot names this contract and this build, any target (§9.4).
fn check_build(contract: (u16, u16), id: &[u8]) -> Result<(), PhysicsFailure> {
    let ours = build_id_without_target();
    let theirs = std::str::from_utf8(id).ok().and_then(|id| id.rsplit_once('+')).map(|(build, _)| build);
    if contract != SNAPSHOT_CONTRACT || theirs != Some(ours.as_str()) {
        return fail(PhysicsError::BuildMismatch, "the snapshot is from another build");
    }
    Ok(())
}

/// The resolved description as the payload holds it (§4, §9.4).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct DescImage {
    dt: f32,
    substeps: u32,
    gravity: [f32; 3],
    up_z: bool,
    length_unit: f32,
    solver_iterations: u32,
    counts: [u32; 11],
    reals: [f32; 3],
}

impl DescImage {
    /// The image of a resolved description.
    pub(crate) fn of(desc: &ResolvedWorldDesc) -> Self {
        let l = &desc.limits;
        Self {
            dt: desc.dt,
            substeps: desc.substeps,
            gravity: desc.gravity,
            up_z: desc.up_axis == UpAxis::Z,
            length_unit: desc.length_unit,
            solver_iterations: desc.solver_iterations,
            counts: [
                l.bodies,
                l.colliders_per_body,
                l.hull_vertices,
                l.triangles,
                l.joints,
                l.ccd_bodies,
                l.queries_per_step,
                l.events_per_step,
                l.heightfield_samples,
                l.static_pieces,
                l.memory_bytes,
            ],
            reals: [l.world_extent, l.max_speed, l.max_angular_speed],
        }
    }

    /// The description, resolved again from scratch so every rule of §4 and §11 holds; a payload
    /// whose description would not resolve to itself is `BadSnapshot`.
    pub(crate) fn resolve(&self) -> Result<ResolvedWorldDesc, PhysicsFailure> {
        let count = |i: usize| Some(f64::from(self.counts[i]));
        let real = |i: usize| Some(f64::from(self.reals[i]));
        let limits = LimitsDesc {
            bodies: count(0),
            colliders_per_body: count(1),
            hull_vertices: count(2),
            triangles: count(3),
            joints: count(4),
            ccd_bodies: count(5),
            queries_per_step: count(6),
            events_per_step: count(7),
            heightfield_samples: count(8),
            static_pieces: count(9),
            memory_bytes: count(10),
            world_extent: real(0),
            max_speed: real(1),
            max_angular_speed: real(2),
        };
        let up = if self.up_z { UpAxis::Z } else { UpAxis::Y };
        let gravity = self.gravity.map(f64::from);
        let mut desc = WorldDesc::new(f64::from(self.dt), f64::from(self.substeps), gravity, up, f64::from(self.length_unit));
        desc.limits = limits;
        desc.solver = SolverDesc { iterations: Some(f64::from(self.solver_iterations)) };
        let resolved = ResolvedWorldDesc::resolve(&desc).map_err(|_| bad("the snapshot's description is invalid"))?;
        if DescImage::of(&resolved) != *self {
            return fail(PhysicsError::BadSnapshot, "the snapshot's description does not resolve to itself");
        }
        Ok(resolved)
    }
}

/// A `BadSnapshot` failure.
pub(crate) fn bad(detail: &str) -> PhysicsFailure {
    PhysicsFailure::new(PhysicsError::BadSnapshot, detail)
}

/// Checks a count against its limit; past it the payload is `BadSnapshot` (no world holds more).
pub(crate) fn within(count: usize, limit: u32, what: &str) -> Result<(), PhysicsFailure> {
    if count > limit as usize {
        return fail(PhysicsError::BadSnapshot, format!("the snapshot holds more {what} than its limits allow"));
    }
    Ok(())
}

/// A body type as one byte in the payload (its stateHash byte).
pub(crate) mod body_type_code {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    use crate::types::BodyType;

    /// Writes the byte.
    pub(crate) fn serialize<S: Serializer>(value: &BodyType, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(value.hash_byte())
    }

    /// Reads the byte; any other value is an error.
    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<BodyType, D::Error> {
        match u8::deserialize(deserializer)? {
            0 => Ok(BodyType::Dynamic),
            1 => Ok(BodyType::Fixed),
            2 => Ok(BodyType::Kinematic),
            _ => Err(D::Error::custom("unknown body type")),
        }
    }
}

/// A joint type as one byte in the payload, in §6.4's order.
pub(crate) mod joint_type_code {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    use crate::joint::JointType;

    const TYPES: [JointType; 5] =
        [JointType::Fixed, JointType::Hinge, JointType::Ball, JointType::Slider, JointType::Rope];

    /// Writes the byte.
    pub(crate) fn serialize<S: Serializer>(value: &JointType, serializer: S) -> Result<S::Ok, S::Error> {
        let index = TYPES.iter().position(|t| t == value).unwrap_or(0);
        serializer.serialize_u8(index as u8)
    }

    /// Reads the byte; any other value is an error.
    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<JointType, D::Error> {
        let index = usize::from(u8::deserialize(deserializer)?);
        TYPES.get(index).copied().ok_or_else(|| D::Error::custom("unknown joint type"))
    }
}
