//! The world description (§4), f32 rounding on entry (§4.1), limits and their ceiling (§11), the
//! JSON form, physicsHash (§10.2) and buildId (§2).

use genex_physics::{
    Limits, LimitsDesc, PhysicsError, ResolvedWorldDesc, UpAxis, World, WorldDesc, build_id, build_id_without_target,
    target_name,
};
use serde_json::{Value, json};

fn base() -> WorldDesc {
    WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0)
}

fn code(desc: &WorldDesc) -> Option<PhysicsError> {
    World::create(desc).err().map(|failure| failure.code)
}

fn with(edit: impl Fn(&mut WorldDesc)) -> WorldDesc {
    let mut desc = base();
    edit(&mut desc);
    desc
}

fn json_world() -> Value {
    json!({ "contract": "1.0", "dt": 1.0 / 30.0, "substeps": 2, "gravity": [0, 0, -800], "upAxis": "z", "lengthUnit": 39.37 })
}

#[test]
fn every_default_is_filled() {
    let resolved = ResolvedWorldDesc::resolve(&base()).expect("valid");
    assert_eq!(resolved.solver_iterations, 4);
    let limits = resolved.limits;
    let expected = [512, 8, 64, 65_536, 64, 16, 64, 64, 1_048_576, 4_608, 64 * 1024 * 1024];
    let actual = [
        limits.bodies,
        limits.colliders_per_body,
        limits.hull_vertices,
        limits.triangles,
        limits.joints,
        limits.ccd_bodies,
        limits.queries_per_step,
        limits.events_per_step,
        limits.heightfield_samples,
        limits.static_pieces,
        limits.memory_bytes,
    ];
    assert_eq!(actual, expected);
    assert_eq!((limits.world_extent, limits.max_speed, limits.max_angular_speed), (100_000.0, 1_000.0, 1_000.0));
}

#[test]
fn length_defaults_scale_with_the_length_unit() {
    let resolved = ResolvedWorldDesc::resolve(&with(|d| d.length_unit = 39.37)).expect("valid");
    assert_eq!(resolved.limits.world_extent, 100_000.0f32 * 39.37f32);
    assert_eq!(resolved.limits.max_speed, 1_000.0f32 * 39.37f32);
    assert_eq!(resolved.limits.max_angular_speed, 1_000.0);
}

#[test]
fn numbers_are_rounded_to_f32_on_entry() {
    let resolved = ResolvedWorldDesc::resolve(&with(|d| d.dt = 1.0 / 30.0)).expect("valid");
    assert_eq!(resolved.dt.to_bits(), ((1.0f64 / 30.0) as f32).to_bits());
    assert_eq!(resolved.dt, 0.033_333_335_f32);
    // 0.100000003 rounds to the f32 of 0.1, so it is not above the bound; 1.00000001 is substeps 1.
    assert!(World::create(&with(|d| d.dt = 0.100_000_003)).is_ok());
    assert!(World::create(&with(|d| d.substeps = 1.000_000_01)).is_ok());
    // 1e-50 rounds to 0, which is not above 0.
    assert_eq!(code(&with(|d| d.dt = 1e-50)), Some(PhysicsError::OutOfRange));
}

#[test]
fn bad_world_fields_are_refused_with_their_code() {
    let rows: Vec<(&str, WorldDesc, PhysicsError)> = vec![
        ("contract 1.1", with(|d| d.contract = "1.1".into()), PhysicsError::ContractMismatch),
        ("contract empty", with(|d| d.contract = String::new()), PhysicsError::ContractMismatch),
        ("dt 0", with(|d| d.dt = 0.0), PhysicsError::OutOfRange),
        ("dt negative", with(|d| d.dt = -0.01), PhysicsError::OutOfRange),
        ("dt above 0.1", with(|d| d.dt = 0.100_001), PhysicsError::OutOfRange),
        ("dt NaN", with(|d| d.dt = f64::NAN), PhysicsError::NonFinite),
        ("dt 1e39", with(|d| d.dt = 1e39), PhysicsError::NonFinite),
        ("dt infinite", with(|d| d.dt = f64::INFINITY), PhysicsError::NonFinite),
        ("substeps 0", with(|d| d.substeps = 0.0), PhysicsError::OutOfRange),
        ("substeps 9", with(|d| d.substeps = 9.0), PhysicsError::OutOfRange),
        ("substeps 1.5", with(|d| d.substeps = 1.5), PhysicsError::OutOfRange),
        ("substeps NaN", with(|d| d.substeps = f64::NAN), PhysicsError::NonFinite),
        ("gravity NaN", with(|d| d.gravity = [0.0, f64::NAN, 0.0]), PhysicsError::NonFinite),
        ("gravity 1e39", with(|d| d.gravity = [1e39, 0.0, 0.0]), PhysicsError::NonFinite),
        ("lengthUnit 0", with(|d| d.length_unit = 0.0), PhysicsError::OutOfRange),
        ("lengthUnit -0", with(|d| d.length_unit = -0.0), PhysicsError::OutOfRange),
        ("lengthUnit negative", with(|d| d.length_unit = -1.0), PhysicsError::OutOfRange),
        ("lengthUnit 1e39", with(|d| d.length_unit = 1e39), PhysicsError::NonFinite),
        ("lengthUnit overflows limits", with(|d| d.length_unit = 1e35), PhysicsError::OutOfRange),
        ("iterations 0", with(|d| d.solver.iterations = Some(0.0)), PhysicsError::OutOfRange),
        ("iterations 17", with(|d| d.solver.iterations = Some(17.0)), PhysicsError::OutOfRange),
        ("iterations 2.5", with(|d| d.solver.iterations = Some(2.5)), PhysicsError::OutOfRange),
    ];
    for (name, desc, expected) in rows {
        assert_eq!(code(&desc), Some(expected), "{name}");
    }
}

#[test]
fn the_edges_of_every_range_are_accepted() {
    let rows: Vec<WorldDesc> = vec![
        with(|d| d.dt = 0.1),
        with(|d| d.substeps = 8.0),
        with(|d| d.solver.iterations = Some(1.0)),
        with(|d| d.solver.iterations = Some(16.0)),
        with(|d| d.up_axis = UpAxis::Z),
        with(|d| d.length_unit = 1e-6),
    ];
    for desc in rows {
        assert!(World::create(&desc).is_ok(), "{desc:?}");
    }
}

fn limited(edit: impl Fn(&mut LimitsDesc)) -> WorldDesc {
    with(|d| edit(&mut d.limits))
}

#[test]
fn limits_may_be_lowered_and_raised_up_to_four_times_their_default() {
    let ceiling = Limits::ceiling(1.0);
    assert_eq!(ceiling.bodies, 2_048);
    assert_eq!(ceiling.memory_bytes, 256 * 1024 * 1024);
    assert_eq!(ceiling.world_extent, 400_000.0);
    let accepted = [
        limited(|l| l.bodies = Some(2_048.0)),
        limited(|l| l.bodies = Some(0.0)),
        limited(|l| l.bodies = Some(-0.0)),
        limited(|l| l.memory_bytes = Some(268_435_456.0)),
        limited(|l| l.world_extent = Some(400_000.0)),
        limited(|l| l.max_speed = Some(0.0)),
        limited(|l| l.max_angular_speed = Some(4_000.0)),
        limited(|l| l.heightfield_samples = Some(4.0)),
    ];
    for desc in accepted {
        assert!(World::create(&desc).is_ok(), "{:?}", desc.limits);
    }
    let refused = [
        (limited(|l| l.bodies = Some(2_049.0)), PhysicsError::OutOfRange),
        (limited(|l| l.bodies = Some(-1.0)), PhysicsError::OutOfRange),
        (limited(|l| l.bodies = Some(1.5)), PhysicsError::OutOfRange),
        (limited(|l| l.joints = Some(f64::NAN)), PhysicsError::NonFinite),
        (limited(|l| l.memory_bytes = Some(268_435_488.0)), PhysicsError::OutOfRange),
        (limited(|l| l.world_extent = Some(400_100.0)), PhysicsError::OutOfRange),
        (limited(|l| l.world_extent = Some(0.0)), PhysicsError::OutOfRange),
        (limited(|l| l.max_speed = Some(-1.0)), PhysicsError::OutOfRange),
        (limited(|l| l.max_angular_speed = Some(4_001.0)), PhysicsError::OutOfRange),
    ];
    for (desc, expected) in refused {
        assert_eq!(code(&desc), Some(expected), "{:?}", desc.limits);
    }
}

#[test]
fn the_json_form_reads_every_field() {
    let mut value = json_world();
    value["limits"] = json!({ "bodies": 100, "worldExtent": 1000 });
    value["solver"] = json!({ "iterations": 8 });
    let desc = WorldDesc::from_json(&value).expect("valid json");
    let resolved = ResolvedWorldDesc::resolve(&desc).expect("valid world");
    assert_eq!(resolved.up_axis, UpAxis::Z);
    assert_eq!(resolved.substeps, 2);
    assert_eq!(resolved.gravity, [0.0, 0.0, -800.0]);
    assert_eq!(resolved.length_unit, 39.37);
    assert_eq!(resolved.limits.bodies, 100);
    assert_eq!(resolved.limits.world_extent, 1000.0);
    assert_eq!(resolved.limits.joints, 64);
    assert_eq!(resolved.solver_iterations, 8);
}

/// One edit of a JSON world.
type JsonEdit = Box<dyn Fn(&mut Value)>;

#[test]
fn malformed_json_worlds_are_refused() {
    let edits: Vec<(&str, JsonEdit, PhysicsError)> = vec![
        ("no contract", Box::new(|v| drop(v.as_object_mut().map(|o| o.remove("contract")))), PhysicsError::ContractMismatch),
        ("contract number", Box::new(|v| v["contract"] = json!(1.0)), PhysicsError::ContractMismatch),
        ("contract 2.0", Box::new(|v| v["contract"] = json!("2.0")), PhysicsError::ContractMismatch),
        ("not an object", Box::new(|v| *v = json!([1, 2])), PhysicsError::ContractMismatch),
        ("no dt", Box::new(|v| drop(v.as_object_mut().map(|o| o.remove("dt")))), PhysicsError::OutOfRange),
        ("dt string", Box::new(|v| v["dt"] = json!("0.1")), PhysicsError::OutOfRange),
        ("gravity two", Box::new(|v| v["gravity"] = json!([0, 1])), PhysicsError::OutOfRange),
        ("gravity text", Box::new(|v| v["gravity"] = json!([0, "1", 2])), PhysicsError::OutOfRange),
        ("upAxis x", Box::new(|v| v["upAxis"] = json!("x")), PhysicsError::OutOfRange),
        ("upAxis Y", Box::new(|v| v["upAxis"] = json!("Y")), PhysicsError::OutOfRange),
        ("unknown field", Box::new(|v| v["gravityScale"] = json!(1)), PhysicsError::OutOfRange),
        ("unknown limit", Box::new(|v| v["limits"] = json!({ "bodys": 1 })), PhysicsError::OutOfRange),
        ("limits array", Box::new(|v| v["limits"] = json!([])), PhysicsError::OutOfRange),
        ("limit text", Box::new(|v| v["limits"] = json!({ "bodies": "1" })), PhysicsError::OutOfRange),
        ("solver unknown", Box::new(|v| v["solver"] = json!({ "steps": 1 })), PhysicsError::OutOfRange),
        ("solver null", Box::new(|v| v["solver"] = Value::Null), PhysicsError::OutOfRange),
    ];
    for (name, edit, expected) in edits {
        let mut value = json_world();
        edit(&mut value);
        let refused = WorldDesc::from_json(&value).and_then(|d| World::create(&d).map(|_| ()));
        assert_eq!(refused.err().map(|f| f.code), Some(expected), "{name}");
    }
}

#[test]
fn json_numbers_past_f32_give_non_finite() {
    let mut value = json_world();
    value["dt"] = json!(1e39);
    let desc = WorldDesc::from_json(&value).expect("parses");
    assert_eq!(code(&desc), Some(PhysicsError::NonFinite));
}

#[test]
fn physics_json_is_the_canonical_resolved_world() {
    let world = World::create(&base()).expect("valid");
    let expected = concat!(
        r#"{"build":"genex-physics/1.0.0+contract-1.0+rapier-0.36.0+det","static":{"boxes":[],"ramps":[]},"#,
        r#""world":{"contract":"1.0","dt":0.016666668,"gravity":[0,-9.81,0],"lengthUnit":1,"limits":{"#,
        r#""bodies":512,"ccdBodies":16,"collidersPerBody":8,"eventsPerStep":64,"heightfieldSamples":1048576,"#,
        r#""hullVertices":64,"joints":64,"maxAngularSpeed":1000,"maxSpeed":1000,"memoryBytes":67108864,"#,
        r#""queriesPerStep":64,"staticPieces":4608,"triangles":65536,"worldExtent":100000},"#,
        r#""solver":{"iterations":4},"substeps":1,"upAxis":"y"}}"#
    );
    assert_eq!(world.physics_json(), expected);
    // FNV-1a 64 of the text above, computed independently with Node 24's BigInt.
    assert_eq!(world.physics_hash(), "9074bb4bcb5b7a7f");
}

#[test]
fn physics_hash_covers_the_f32_not_the_decimal() {
    let a = World::create(&with(|d| d.dt = 1.0 / 30.0)).expect("valid");
    let b = World::create(&with(|d| d.dt = 0.033_333_333_3)).expect("valid");
    assert_eq!(a.physics_hash(), b.physics_hash());
    let c = World::create(&with(|d| d.dt = 1.0 / 20.0)).expect("valid");
    assert_ne!(a.physics_hash(), c.physics_hash());
}

#[test]
fn physics_hash_covers_every_resolved_field() {
    let reference = World::create(&base()).expect("valid").physics_hash();
    let variants = [
        with(|d| d.substeps = 2.0),
        with(|d| d.gravity = [0.0, -9.8, 0.0]),
        with(|d| d.up_axis = UpAxis::Z),
        with(|d| d.length_unit = 2.0),
        with(|d| d.solver.iterations = Some(5.0)),
        limited(|l| l.bodies = Some(10.0)),
        limited(|l| l.max_speed = Some(10.0)),
    ];
    for desc in variants {
        assert_ne!(World::create(&desc).expect("valid").physics_hash(), reference, "{desc:?}");
    }
    // An explicit default hashes as the default it spells, and −0 as 0.
    let explicit = with(|d| d.solver.iterations = Some(4.0));
    assert_eq!(World::create(&explicit).expect("valid").physics_hash(), reference);
    let zero = World::create(&limited(|l| l.max_speed = Some(0.0))).expect("valid").physics_hash();
    let negative_zero = World::create(&limited(|l| l.max_speed = Some(-0.0))).expect("valid").physics_hash();
    assert_eq!(zero, negative_zero);
}

#[test]
fn build_id_names_core_contract_backend_features_and_target() {
    let without = build_id_without_target();
    assert_eq!(without, "genex-physics/1.0.0+contract-1.0+rapier-0.36.0+det");
    assert_eq!(build_id(), format!("{without}+{}", target_name()));
    assert!(!target_name().contains('+'));
}
