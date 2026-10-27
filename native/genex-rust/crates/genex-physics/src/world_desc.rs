//! The world description (CONTRACT.md §4): what a caller passes, its JSON form, and the resolved
//! description with every default filled that `physicsHash` covers (§10.2).

use serde_json::{Map, Value};

use crate::canon::Canon;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::limits::Limits;
use crate::num::{finite_vec, integer, non_negative, positive};
use crate::types::{UpAxis, Vec3};

/// The contract version this core implements.
pub const CONTRACT_VERSION: &str = "1.0";
/// The largest `dt`, seconds.
pub const DT_MAX: f32 = 0.1;
/// The most inner steps per `step()`.
pub const SUBSTEPS_MAX: u32 = 8;
/// The most solver iterations.
pub const SOLVER_ITERATIONS_MAX: u32 = 16;
/// The default solver iterations.
pub const SOLVER_ITERATIONS_DEFAULT: u32 = 4;

/// Overrides of the default limits (§11); `None` keeps a default.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LimitsDesc {
    /// `bodies`.
    pub bodies: Option<f64>,
    /// `collidersPerBody`.
    pub colliders_per_body: Option<f64>,
    /// `hullVertices`.
    pub hull_vertices: Option<f64>,
    /// `triangles`.
    pub triangles: Option<f64>,
    /// `joints`.
    pub joints: Option<f64>,
    /// `ccdBodies`.
    pub ccd_bodies: Option<f64>,
    /// `queriesPerStep`.
    pub queries_per_step: Option<f64>,
    /// `eventsPerStep`.
    pub events_per_step: Option<f64>,
    /// `heightfieldSamples`.
    pub heightfield_samples: Option<f64>,
    /// `staticPieces`.
    pub static_pieces: Option<f64>,
    /// `memoryBytes`.
    pub memory_bytes: Option<f64>,
    /// `worldExtent`.
    pub world_extent: Option<f64>,
    /// `maxSpeed`.
    pub max_speed: Option<f64>,
    /// `maxAngularSpeed`.
    pub max_angular_speed: Option<f64>,
}

impl LimitsDesc {
    /// The field a contract name names, for the JSON form.
    fn slot(&mut self, name: &str) -> Option<&mut Option<f64>> {
        let slot = match name {
            "bodies" => &mut self.bodies,
            "collidersPerBody" => &mut self.colliders_per_body,
            "hullVertices" => &mut self.hull_vertices,
            "triangles" => &mut self.triangles,
            "joints" => &mut self.joints,
            "ccdBodies" => &mut self.ccd_bodies,
            "queriesPerStep" => &mut self.queries_per_step,
            "eventsPerStep" => &mut self.events_per_step,
            "heightfieldSamples" => &mut self.heightfield_samples,
            "staticPieces" => &mut self.static_pieces,
            "memoryBytes" => &mut self.memory_bytes,
            "worldExtent" => &mut self.world_extent,
            "maxSpeed" => &mut self.max_speed,
            "maxAngularSpeed" => &mut self.max_angular_speed,
            _ => return None,
        };
        Some(slot)
    }
}

/// Solver settings (§4).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SolverDesc {
    /// Solver iterations, an integer 1..16; default 4.
    pub iterations: Option<f64>,
}

/// A world description as a caller gives it (§4). Numbers are rounded to f32 on entry (§4.1).
#[derive(Clone, Debug, PartialEq)]
pub struct WorldDesc {
    /// Must be `"1.0"`, else `ContractMismatch`.
    pub contract: String,
    /// Seconds per `step()`, > 0 and <= 0.1.
    pub dt: f64,
    /// Inner steps per `step()`, an integer 1..8.
    pub substeps: f64,
    /// Gravity in the caller frame, caller units per s².
    pub gravity: Vec3,
    /// The caller's up axis (§5).
    pub up_axis: UpAxis,
    /// Caller length units per metre, > 0.
    pub length_unit: f64,
    /// Limit overrides (§11).
    pub limits: LimitsDesc,
    /// Solver settings.
    pub solver: SolverDesc,
}

impl WorldDesc {
    /// A contract-1.0 description with default limits and solver.
    pub fn new(dt: f64, substeps: f64, gravity: Vec3, up_axis: UpAxis, length_unit: f64) -> Self {
        Self {
            contract: CONTRACT_VERSION.to_string(),
            dt,
            substeps,
            gravity,
            up_axis,
            length_unit,
            limits: LimitsDesc::default(),
            solver: SolverDesc::default(),
        }
    }

    /// Reads the JSON form (`{ contract, dt, substeps, gravity, upAxis, lengthUnit, limits?, solver? }`).
    ///
    /// A missing or other `contract` gives `ContractMismatch`; a missing, mistyped or unknown field
    /// gives `OutOfRange`. Values are checked by [`ResolvedWorldDesc::resolve`].
    pub fn from_json(value: &Value) -> Result<Self, PhysicsFailure> {
        let object = value.as_object();
        let contract = object.and_then(|o| o.get("contract")).and_then(Value::as_str);
        if contract != Some(CONTRACT_VERSION) {
            return fail(PhysicsError::ContractMismatch, "the world is not contract 1.0");
        }
        let object = object.ok_or_else(|| out_of_range("the world is not an object"))?;
        refuse_unknown(object, &WORLD_FIELDS)?;
        let mut desc = Self::new(
            number(object, "dt")?,
            number(object, "substeps")?,
            vec3(object, "gravity")?,
            up_axis(object)?,
            number(object, "lengthUnit")?,
        );
        if let Some(limits) = object.get("limits") {
            desc.limits = limits_from_json(limits)?;
        }
        if let Some(solver) = object.get("solver") {
            desc.solver = solver_from_json(solver)?;
        }
        Ok(desc)
    }
}

const WORLD_FIELDS: [&str; 8] = ["contract", "dt", "substeps", "gravity", "upAxis", "lengthUnit", "limits", "solver"];

fn out_of_range(detail: &str) -> PhysicsFailure {
    PhysicsFailure::new(PhysicsError::OutOfRange, detail)
}

fn refuse_unknown(object: &Map<String, Value>, known: &[&str]) -> Result<(), PhysicsFailure> {
    match object.keys().find(|key| !known.contains(&key.as_str())) {
        Some(key) => fail(PhysicsError::OutOfRange, format!("unknown field {key}")),
        None => Ok(()),
    }
}

fn number(object: &Map<String, Value>, name: &str) -> Result<f64, PhysicsFailure> {
    object.get(name).and_then(Value::as_f64).ok_or_else(|| out_of_range(&format!("{name} is not a number")))
}

fn vec3(object: &Map<String, Value>, name: &str) -> Result<Vec3, PhysicsFailure> {
    let items = object.get(name).and_then(Value::as_array).filter(|items| items.len() == 3);
    let numbers: Option<Vec<f64>> = items.map(|items| items.iter().filter_map(Value::as_f64).collect());
    match numbers.as_deref() {
        Some(&[x, y, z]) => Ok([x, y, z]),
        _ => fail(PhysicsError::OutOfRange, format!("{name} is not three numbers")),
    }
}

fn up_axis(object: &Map<String, Value>) -> Result<UpAxis, PhysicsFailure> {
    match object.get("upAxis").and_then(Value::as_str) {
        Some("y") => Ok(UpAxis::Y),
        Some("z") => Ok(UpAxis::Z),
        _ => fail(PhysicsError::OutOfRange, "upAxis is not \"y\" or \"z\""),
    }
}

fn limits_from_json(value: &Value) -> Result<LimitsDesc, PhysicsFailure> {
    let object = value.as_object().ok_or_else(|| out_of_range("limits is not an object"))?;
    let mut limits = LimitsDesc::default();
    for (name, item) in object {
        let slot = limits.slot(name).ok_or_else(|| out_of_range(&format!("unknown limit {name}")))?;
        *slot = Some(item.as_f64().ok_or_else(|| out_of_range(&format!("limit {name} is not a number")))?);
    }
    Ok(limits)
}

fn solver_from_json(value: &Value) -> Result<SolverDesc, PhysicsFailure> {
    let object = value.as_object().ok_or_else(|| out_of_range("solver is not an object"))?;
    refuse_unknown(object, &["iterations"])?;
    let iterations = match object.get("iterations") {
        Some(item) => Some(item.as_f64().ok_or_else(|| out_of_range("iterations is not a number"))?),
        None => None,
    };
    Ok(SolverDesc { iterations })
}

/// The resolved description (§4): every default filled, every number the f32 the core holds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedWorldDesc {
    /// Seconds per `step()`.
    pub dt: f32,
    /// Inner steps per `step()`.
    pub substeps: u32,
    /// Gravity in the caller frame.
    pub gravity: [f32; 3],
    /// The caller's up axis.
    pub up_axis: UpAxis,
    /// Caller length units per metre.
    pub length_unit: f32,
    /// The world's limits.
    pub limits: Limits,
    /// Solver iterations.
    pub solver_iterations: u32,
}

impl ResolvedWorldDesc {
    /// Validates `desc` and fills every default; a failure names the first bad field (§4).
    pub fn resolve(desc: &WorldDesc) -> Result<Self, PhysicsFailure> {
        if desc.contract != CONTRACT_VERSION {
            return fail(PhysicsError::ContractMismatch, "the world is not contract 1.0");
        }
        let dt = positive(desc.dt, "dt")?;
        if dt > DT_MAX {
            return fail(PhysicsError::OutOfRange, "dt is above 0.1");
        }
        let substeps = integer(desc.substeps, "substeps", 1, SUBSTEPS_MAX)?;
        let gravity = finite_vec(desc.gravity, "gravity")?;
        let length_unit = positive(desc.length_unit, "lengthUnit")?;
        let limits = resolve_limits(&desc.limits, length_unit)?;
        let iterations = desc.solver.iterations.unwrap_or(f64::from(SOLVER_ITERATIONS_DEFAULT));
        let solver_iterations = integer(iterations, "solver.iterations", 1, SOLVER_ITERATIONS_MAX)?;
        Ok(Self { dt, substeps, gravity, up_axis: desc.up_axis, length_unit, limits, solver_iterations })
    }

    /// The length of one inner step, `dt / substeps` in f32.
    pub fn inner_dt(&self) -> f32 {
        self.dt / self.substeps as f32
    }

    /// The description as canonical JSON (§10.2).
    pub(crate) fn canon(&self) -> Canon {
        Canon::object([
            ("contract", Canon::Str(CONTRACT_VERSION.to_string())),
            ("dt", Canon::Num(self.dt)),
            ("substeps", Canon::Num(self.substeps as f32)),
            ("gravity", Canon::numbers(&self.gravity)),
            ("upAxis", Canon::Str(self.up_axis.name().to_string())),
            ("lengthUnit", Canon::Num(self.length_unit)),
            ("limits", self.limits.canon()),
            ("solver", Canon::object([("iterations", Canon::Num(self.solver_iterations as f32))])),
        ])
    }
}

/// The limits with every override checked against 0 and the 4x ceiling (§11).
fn resolve_limits(desc: &LimitsDesc, length_unit: f32) -> Result<Limits, PhysicsFailure> {
    let defaults = Limits::defaults(length_unit);
    let ceiling = Limits::ceiling(length_unit);
    let reals_finite = ceiling.world_extent.is_finite() && ceiling.max_speed.is_finite();
    if !reals_finite {
        return fail(PhysicsError::OutOfRange, "lengthUnit makes the default limits overflow f32");
    }
    let int = |value: Option<f64>, name: &str, default: u32, max: u32| match value {
        Some(v) => integer(v, &format!("limits.{name}"), 0, max),
        None => Ok(default),
    };
    Ok(Limits {
        bodies: int(desc.bodies, "bodies", defaults.bodies, ceiling.bodies)?,
        colliders_per_body: int(
            desc.colliders_per_body,
            "collidersPerBody",
            defaults.colliders_per_body,
            ceiling.colliders_per_body,
        )?,
        hull_vertices: int(desc.hull_vertices, "hullVertices", defaults.hull_vertices, ceiling.hull_vertices)?,
        triangles: int(desc.triangles, "triangles", defaults.triangles, ceiling.triangles)?,
        joints: int(desc.joints, "joints", defaults.joints, ceiling.joints)?,
        ccd_bodies: int(desc.ccd_bodies, "ccdBodies", defaults.ccd_bodies, ceiling.ccd_bodies)?,
        queries_per_step: int(
            desc.queries_per_step,
            "queriesPerStep",
            defaults.queries_per_step,
            ceiling.queries_per_step,
        )?,
        events_per_step: int(desc.events_per_step, "eventsPerStep", defaults.events_per_step, ceiling.events_per_step)?,
        heightfield_samples: int(
            desc.heightfield_samples,
            "heightfieldSamples",
            defaults.heightfield_samples,
            ceiling.heightfield_samples,
        )?,
        static_pieces: int(desc.static_pieces, "staticPieces", defaults.static_pieces, ceiling.static_pieces)?,
        memory_bytes: int(desc.memory_bytes, "memoryBytes", defaults.memory_bytes, ceiling.memory_bytes)?,
        world_extent: real(desc.world_extent, "worldExtent", defaults.world_extent, ceiling.world_extent, true)?,
        max_speed: real(desc.max_speed, "maxSpeed", defaults.max_speed, ceiling.max_speed, false)?,
        max_angular_speed: real(
            desc.max_angular_speed,
            "maxAngularSpeed",
            defaults.max_angular_speed,
            ceiling.max_angular_speed,
            false,
        )?,
    })
}

/// A real limit: its default, or an override in `0..=max` (above 0 when `strict`).
fn real(value: Option<f64>, name: &str, default: f32, max: f32, strict: bool) -> Result<f32, PhysicsFailure> {
    let Some(value) = value else { return Ok(default) };
    let what = format!("limits.{name}");
    let resolved = if strict { positive(value, &what)? } else { non_negative(value, &what)? };
    if resolved > max {
        return fail(PhysicsError::OutOfRange, format!("{what} is above 4x its default"));
    }
    Ok(resolved)
}
