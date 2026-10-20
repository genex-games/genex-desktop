//! The far field (game systems LOD-18): copies under a far rule thin past its start, stateless and
//! deterministic. A copy's hash (its sphere's centre on a 1 cm grid) against a keep threshold
//! falling with distance decides how much of it is drawn, through its fade batch's dither, and
//! survivors grow about their origin to hold the cover ([`far_field`]; `gx_far_field` in
//! `shaders/cull.wgsl` is its twin). These rows hold the plan's red rows: no one-frame pops while
//! a camera moves past the start, drawn cover within 10% of the unthinned, the kept set stable
//! under any row order, and the grow's motion (which the motion vectors do not carry) under a
//! tenth of a pixel a frame.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and their names contain `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test far_field -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the thinned forest's frames (raw BGRA, top row first, the
//! size in the name).

use std::path::PathBuf;

use genex_render::lod_rows::{DrawLod, FAR_FADE_BAND, FAR_GROW_MAX, FAR_RULES_MAX, FarField, GpuFarRule, far_field, far_hash, far_rule_usable};
use genex_render::mesh::{LOD_FADE_TAG, LodChain, LodLevel, MeshData};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, ModelPart, Scene, scaled, translation};
use genex_render::{CullPath, Gpu, Renderer};

/// Copies in the forest rows.
const FOREST: usize = 50_000;
/// The forest's side, metres (the camera starts at its centre).
const FOREST_SIDE: f32 = 2_000.0;
/// A tree's bounding radius, metres.
const TREE_RADIUS: f32 = 5.0;
/// The rule the rows thin by: from 100 m to a quarter at 600 m, then out over 200 m.
const RULE: GpuFarRule = GpuFarRule { start: 100.0, end: 600.0, keep: 0.25, fade_out: 200.0 };
/// Frames of the pan.
const PAN_FRAMES: usize = 600;
/// The camera's travel a frame: 30 m/s at 60 Hz (a vehicle), the fast end of a pan.
const PAN_STEP: f32 = 0.5;
/// A copy's share may change by at most this in one frame; a pop is a larger jump.
const POP_SHARE_STEP: f32 = 1.0 / 16.0;
/// Its grow likewise.
const POP_GROW_STEP: f32 = 1.0 / 64.0;
/// Drawn cover in a distance ring may differ from the unthinned by this share (plan LOD-18).
const COVER_TOLERANCE: f32 = 0.10;
/// The grow's motion a frame, in output pixels, that the motion vectors may miss (plan LOD-18).
const GROW_MOTION_PX_MAX: f32 = 0.1;
/// The GPU cull's thinned fades and grows may differ from the CPU twin's by this (relative):
/// about 80 ULP at 1, a share no dither can show (1/1024 is one step of the band's).
const GPU_FAR_VALUE_TOLERANCE: f32 = 1.0e-5;
/// Output pixels a world unit at distance 1 for a 45-degree camera over 1080 rows.
const PIXELS_PER_UNIT_1080P: f32 = 540.0 / 0.414_213_57;

/// A xorshift stream in [0, 1).
struct Stream(u32);

impl Stream {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / 16_777_216.0
    }
}

/// The forest's copies: sphere origins scattered over the square around the origin.
fn forest(count: usize) -> Vec<[f32; 4]> {
    let mut stream = Stream(0x9e37_79b9);
    (0..count).map(|_| [(stream.next() - 0.5) * FOREST_SIDE, 0.0, (stream.next() - 0.5) * FOREST_SIDE, TREE_RADIUS]).collect()
}

fn distance(origin: [f32; 4], eye: [f32; 3]) -> f32 {
    let d = [origin[0] - eye[0], origin[1] - eye[1], origin[2] - eye[2]];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

#[test]
fn nearer_than_the_start_every_copy_is_whole_and_past_it_the_share_falls() {
    let near = far_field(&RULE, [0.0, 0.0, -99.0, 1.0], [0.0; 3]);
    assert_eq!(near, FarField::NEAR, "before the start a copy is left alone");
    // Just past the start every copy is still whole: the threshold starts at 1 (no pop).
    for origin in forest(4_096) {
        let at = [origin[0] * 1e-3, 0.0, -100.001 - origin[2] * 1e-6, origin[3]];
        let field = far_field(&RULE, at, [0.0; 3]);
        assert!(field.thinned && field.share == 1.0 && field.grow >= 1.0 && field.grow < 1.0 + 1e-4, "{at:?}: {field:?}");
    }
    // Far past the end and its fade-out nothing is drawn.
    let gone = far_field(&RULE, [0.0, 0.0, -900.0, 1.0], [0.0; 3]);
    assert!(gone.thinned && gone.share == 0.0 && gone.grow == FAR_GROW_MAX, "{gone:?}");
    // A rule with no fade-out keeps a quarter to the horizon.
    let horizon = GpuFarRule { fade_out: 0.0, ..RULE };
    let drawn: f32 = forest(8_192).iter().map(|o| far_field(&horizon, [o[0], 0.0, -5_000.0 - o[2], 1.0], [0.0; 3]).share).sum();
    let share = drawn / 8_192.0;
    assert!((share - 0.25).abs() < 0.02, "a quarter drawn far away (the expected share): {share}");
}

#[test]
fn a_50k_forest_pan_has_zero_one_frame_pops_past_far_start() {
    let origins = forest(FOREST);
    let mut last: Vec<FarField> = origins.iter().map(|o| far_field(&RULE, *o, [0.0, 2.0, 0.0])).collect();
    let (mut pops, mut thinned_seen, mut vanished, mut max_step) = (0usize, 0usize, 0usize, 0.0f32);
    for frame in 1..=PAN_FRAMES {
        // A dolly along -z with a slow sideways drift, crossing many copies' start and end.
        let eye = [frame as f32 * PAN_STEP * 0.3, 2.0, -(frame as f32) * PAN_STEP];
        for (at, origin) in origins.iter().enumerate() {
            let now = far_field(&RULE, *origin, eye);
            let before = last[at];
            let step = (now.share - before.share).abs();
            max_step = max_step.max(step);
            let popped = step > POP_SHARE_STEP || (now.grow - before.grow).abs() > POP_GROW_STEP;
            pops += usize::from(popped);
            thinned_seen += usize::from(now.thinned && now.share < 1.0);
            vanished += usize::from(before.share > 0.0 && now.share == 0.0);
            last[at] = now;
        }
    }
    eprintln!("{FOREST} copies, {PAN_FRAMES} frames: {thinned_seen} thinned copy-frames, {vanished} faded out, largest share step {max_step}");
    assert!(thinned_seen > 1_000_000 && vanished > 100, "the pan crosses the thinning and the fade-out");
    assert_eq!(pops, 0, "one-frame pops (largest share step {max_step})");
}

#[test]
fn drawn_cover_within_10_percent_of_unthinned() {
    // Many copies over the thinning range, each ring's drawn area (share x grow^2) against its
    // copies' count (each drawn whole at its own size before thinning).
    let mut stream = Stream(0x1234_5678);
    let ring = 25.0;
    let rings = ((RULE.end - RULE.start) / ring) as usize;
    let mut drawn = vec![0.0f64; rings];
    let mut copies = vec![0usize; rings];
    for _ in 0..400_000 {
        let d = RULE.start + stream.next() * (RULE.end - RULE.start);
        let angle = stream.next() * std::f32::consts::TAU;
        let origin = [d * libm::cosf(angle), 0.0, d * libm::sinf(angle), TREE_RADIUS];
        let field = far_field(&RULE, origin, [0.0; 3]);
        let at = (((distance(origin, [0.0; 3]) - RULE.start) / ring) as usize).min(rings - 1);
        drawn[at] += f64::from(field.share * field.grow * field.grow);
        copies[at] += 1;
    }
    for (at, (area, count)) in drawn.iter().zip(&copies).enumerate() {
        let cover = (*area / *count as f64) as f32;
        eprintln!("ring {:.0}-{:.0} m: cover {cover:.4} of {count}", RULE.start + at as f32 * ring, RULE.start + (at + 1) as f32 * ring);
        assert!((cover - 1.0).abs() <= COVER_TOLERANCE, "ring {at}: drawn cover {cover}");
    }
}

#[test]
fn motion_error_from_grow_under_a_tenth_pixel_per_frame() {
    let mut worst = 0.0f32;
    for origin in forest(FOREST) {
        for frame in 0..60 {
            let eye = [0.0, 2.0, -(frame as f32) * PAN_STEP];
            let next = [0.0, 2.0, -(frame as f32 + 1.0) * PAN_STEP];
            let (a, b) = (far_field(&RULE, origin, eye), far_field(&RULE, origin, next));
            if !a.thinned || b.share == 0.0 {
                continue;
            }
            // The copy's outermost vertex moves by the grow's change times its radius.
            let moved = (b.grow - a.grow).abs() * origin[3];
            let px = moved * PIXELS_PER_UNIT_1080P / distance(origin, next);
            worst = worst.max(px);
        }
    }
    eprintln!("largest grow motion: {worst:.4} px a frame at {PAN_STEP} m a frame");
    assert!(worst < GROW_MOTION_PX_MAX, "the grow moves a vertex {worst} px in one frame");
}

#[test]
fn the_hash_is_stable_on_a_centimetre_grid() {
    let origin = [12.345, 1.5, -301.2, 2.0];
    assert_eq!(far_hash(origin).to_bits(), far_hash([12.345 + 1e-4, 1.5, -301.2 - 1e-4, 9.0]).to_bits(), "noise below a centimetre and the radius change nothing");
    let spread: std::collections::BTreeSet<u32> = forest(4_096).iter().map(|o| (far_hash(*o) * 16.0) as u32).collect();
    assert_eq!(spread.len(), 16, "the hash spreads over [0, 1)");
    assert!(forest(4_096).iter().all(|o| (0.0..1.0).contains(&far_hash(*o))));
}

#[test]
fn a_hostile_rule_or_origin_leaves_every_copy_alone() {
    // Each row: its name and a rule `far_rule_usable` refuses.
    let hostile = [
        ("NaN start", GpuFarRule { start: f32::NAN, ..RULE }),
        ("negative start", GpuFarRule { start: -1.0, ..RULE }),
        ("end at start", GpuFarRule { end: RULE.start, ..RULE }),
        ("end before start", GpuFarRule { end: 50.0, ..RULE }),
        ("infinite end", GpuFarRule { end: f32::INFINITY, ..RULE }),
        ("keep 0", GpuFarRule { keep: 0.0, ..RULE }),
        ("keep over 1", GpuFarRule { keep: 1.5, ..RULE }),
        ("keep NaN", GpuFarRule { keep: f32::NAN, ..RULE }),
        ("negative fade-out", GpuFarRule { fade_out: -5.0, ..RULE }),
        ("NaN fade-out", GpuFarRule { fade_out: f32::NAN, ..RULE }),
    ];
    for (name, rule) in hostile {
        assert!(!far_rule_usable(&rule), "{name}");
        assert_eq!(far_field(&rule, [0.0, 0.0, -400.0, 1.0], [0.0; 3]), FarField::NEAR, "{name}");
    }
    for (name, origin) in [("NaN origin", [f32::NAN, 0.0, -400.0, 1.0]), ("infinite origin", [0.0, 0.0, f32::NEG_INFINITY, 1.0])] {
        assert_eq!(far_field(&RULE, origin, [0.0; 3]), FarField::NEAR, "{name}");
    }
    // Through a plan: a scene whose draws name a hostile rule, or a rule past the frame's, plans
    // and culls exactly as the same scene without far rules.
    let mut library = MeshLibrary::new();
    let tree = library.add_part(ModelPart::whole(MeshData::sphere())).expect("part");
    let plain = row_scene(tree, &[], FAR_RULE_OF(0), (0..64).collect());
    let base = plan_of(&plain, &library);
    for (name, rules, far_rule) in [
        ("a refused rule", vec![GpuFarRule { keep: 0.0, ..RULE }], 1),
        ("an index past the rules", vec![RULE], 2),
        ("an index past the cap", vec![RULE; FAR_RULES_MAX + 1], FAR_RULES_MAX as u32 + 1),
    ] {
        let scene = row_scene(tree, &rules, FAR_RULE_OF(far_rule), (0..64).collect());
        let plan = plan_of(&scene, &library);
        let (a, b) = (base.cpu_cull(), plan.cpu_cull());
        let drawn = |plan: &FramePlan, cull: &genex_render::scene::CpuCull| survivors(plan, cull, false);
        assert_eq!(drawn(&plan, &b), drawn(&base, &a), "{name}: drawn whole as without a rule");
        assert!(survivors(&plan, &b, true).is_empty(), "{name}: nothing thinned");
    }
}

/// A draw LOD naming far rule `k` (0: none).
#[allow(non_snake_case, reason = "reads as the rule's index")]
fn FAR_RULE_OF(k: u32) -> DrawLod {
    DrawLod { far_rule: k, ..DrawLod::OWN }
}

/// `order`'s copies of the forest (the first 64 of [`forest`] pulled near), in that order.
fn row_scene(mesh: MeshId, rules: &[GpuFarRule], lod: DrawLod, order: Vec<usize>) -> Scene {
    let mut camera = CameraDesc::look_at([0.0, 2.0, 0.0], [0.0, 2.0, -1.0]);
    camera.far = 5_000.0;
    let mut scene = Scene::new(camera, [20, 24, 30, 255]);
    scene.far_rules = rules.to_vec();
    scene.set_lod(lod);
    let origins = forest(order.len().max(64));
    for at in order {
        let [x, _, z, _] = origins[at];
        // In front of the camera, 60 m to 900 m away, so every part of the rule is crossed.
        let depth = 60.0 + (z + FOREST_SIDE * 0.5) / FOREST_SIDE * 840.0;
        scene.draw(mesh, scaled([x * depth / FOREST_SIDE, 0.0, -depth], [TREE_RADIUS; 3]), Material::color([70, 120, 60, 255]));
    }
    scene
}

fn plan_of(scene: &Scene, library: &MeshLibrary) -> FramePlan {
    let mut plan = FramePlan::build(scene, library, 16.0 / 9.0).expect("plan");
    plan.set_lod_height(1080);
    plan
}

/// The camera view's survivors of whole batches (`faded` false) or fade batches, each as its
/// row's sphere centre (bit patterns) with its slot's `[fade, grow]` bits, sorted.
fn survivors(plan: &FramePlan, cull: &genex_render::scene::CpuCull, faded: bool) -> Vec<([u32; 3], [u32; 2])> {
    let mut out = Vec::new();
    for (batch, count) in plan.batches.iter().zip(&cull.counts) {
        if (batch.lod[0] & LOD_FADE_TAG != 0) != faded {
            continue;
        }
        for slot in batch.first_instance..batch.first_instance + count {
            let row = cull.visible[slot as usize] as usize;
            let bounds = plan.instances[row].bounds;
            out.push(([bounds[0].to_bits(), bounds[1].to_bits(), bounds[2].to_bits()], cull.fades[slot as usize].map(f32::to_bits)));
        }
    }
    out.sort();
    out
}

#[test]
fn keep_is_stable_under_row_reorder() {
    let mut library = MeshLibrary::new();
    let tree = library.add_part(ModelPart::whole(MeshData::sphere())).expect("part");
    let count = 2_000;
    let forward: Vec<usize> = (0..count).collect();
    let mut shuffled = forward.clone();
    let mut stream = Stream(0xdead_beef);
    for at in (1..count).rev() {
        shuffled.swap(at, (stream.next() * (at + 1) as f32) as usize % (at + 1));
    }
    let a = plan_of(&row_scene(tree, &[RULE], FAR_RULE_OF(1), forward), &library);
    let b = plan_of(&row_scene(tree, &[RULE], FAR_RULE_OF(1), shuffled), &library);
    let (ca, cb) = (a.cpu_cull(), b.cpu_cull());
    let (thinned, whole) = (survivors(&a, &ca, true), survivors(&a, &ca, false));
    eprintln!("{} whole, {} thinned of {count}", whole.len(), thinned.len());
    assert!(thinned.len() > 200 && whole.len() > 50 && thinned.len() + whole.len() < count, "the rows cross the rule: some whole, some thinned, some gone");
    assert_eq!(survivors(&b, &cb, true), thinned, "the same copies thinned, with the same fades and grows");
    assert_eq!(survivors(&b, &cb, false), whole, "the same copies whole");
    assert!(thinned.iter().all(|(_, [fade, grow])| f32::from_bits(*fade) > 0.0 && f32::from_bits(*grow) >= 1.0), "a thinned survivor draws a share, grown");
}

/// A sphere with two coarser levels (errors 0.02 and 0.08 of its radius, as tests/plan.rs's).
fn chained_sphere() -> ModelPart {
    let mesh = MeshData::sphere();
    let triangles = mesh.indices.len() / 3;
    let level = |share: usize, error: f32| LodLevel { indices: mesh.indices[..triangles / share * 3].to_vec(), error };
    let lods = LodChain { levels: vec![level(2, 0.02), level(4, 0.08)] };
    ModelPart { mesh, meshlets: None, lods: Some(lods) }
}

#[test]
fn the_far_share_scales_a_crossfades_two_fades_and_no_whole_batch_keeps_a_thinned_copy() {
    let mut library = MeshLibrary::new();
    let tree = library.add_part(chained_sphere()).expect("part");
    let mut scene = row_scene(tree, &[RULE], FAR_RULE_OF(1), (0..3_000).collect());
    scene.lod_band = 0.15;
    let plan = plan_of(&scene, &library);
    let cull = plan.cpu_cull();
    let view = plan.cull_lod().view;
    let (mut crossfading, mut thinned) = (0, 0);
    for row in 0..plan.opaque_instances as usize {
        let far = far_field(&RULE, plan.lod_rows[row].origin, [view[0], view[1], view[2]]);
        let kept: Vec<(bool, [f32; 2])> = plan
            .batches
            .iter()
            .zip(&cull.counts)
            .flat_map(|(batch, count)| (batch.first_instance..batch.first_instance + count).map(move |slot| (batch, slot)))
            .filter(|(_, slot)| cull.visible[*slot as usize] as usize == row)
            .map(|(batch, slot)| (batch.lod[0] & LOD_FADE_TAG != 0, cull.fades[slot as usize]))
            .collect();
        if !far.thinned {
            continue;
        }
        thinned += 1;
        assert!(kept.iter().all(|(faded, _)| *faded), "row {row}: no whole batch keeps a thinned copy: {kept:?}");
        if far.share == 0.0 {
            assert!(kept.is_empty(), "row {row}: thinned away");
            continue;
        }
        assert!(kept.iter().all(|(_, [_, grow])| *grow == far.grow), "row {row}: the far field's grow");
        match kept.as_slice() {
            [(_, [fade, _])] => assert_eq!(*fade, far.share, "row {row}: whole at its level, the far share"),
            [(_, [out, _]), (_, [fade_in, _])] => {
                crossfading += 1;
                assert!(*out > 0.0 && *fade_in < 0.0 && ((out - fade_in) - far.share).abs() <= 1e-6, "row {row}: {out} and {fade_in} cover the far share {}", far.share);
            }
            other => panic!("row {row}: kept by {other:?}"),
        }
    }
    eprintln!("{thinned} thinned rows, {crossfading} crossfading");
    assert!(thinned > 500 && crossfading > 10, "the rows cross the rule and a band");
}

#[test]
fn the_cull_shader_holds_the_far_fields_constants() {
    let module = naga::front::wgsl::parse_str(genex_render::shaders::CULL).expect("cull parses");
    let value = |name: &str| {
        let (_, constant) = module.constants.iter().find(|(_, c)| c.name.as_deref() == Some(name)).unwrap_or_else(|| panic!("{name} declared"));
        match module.global_expressions[constant.init] {
            naga::Expression::Literal(naga::Literal::F32(value)) => value,
            ref other => panic!("{name}: {other:?}"),
        }
    };
    assert_eq!(value("GX_FAR_FADE_BAND").to_bits(), FAR_FADE_BAND.to_bits());
    assert_eq!(value("GX_FAR_GROW_MAX").to_bits(), FAR_GROW_MAX.to_bits());
}

// ---------------------------------------------------------------------------------------------
// GPU

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => Some(gpu),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn write_evidence(name: &str, capture: &genex_render::capture::Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

/// The plan's acceptance: the GPU cull keeps what the CPU keeps for a thinned forest of plain and
/// chained trees in the sun's cascades, slot for slot, with the same fades and grows within
/// [`GPU_FAR_VALUE_TOLERANCE`]. The far field takes square roots and quotients, which WGSL
/// leaves a few ULP of freedom (Metal's differ from the CPU's by up to about 20 ULP here), so
/// only a copy whose hash sits within that of its threshold could be kept on one side alone.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_gpu_cull_keeps_the_cpus_far_field() {
    let Some(gpu) = gpu() else { return };
    let (width, height) = (640, 360);
    let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
    let meshes = renderer.add_model_parts(&gpu, vec![ModelPart::whole(MeshData::sphere()), chained_sphere()]).expect("added");
    for band in [0.0, 0.15] {
        let mut scene = row_scene(meshes[0], &[RULE, GpuFarRule { keep: 0.5, ..RULE }], FAR_RULE_OF(1), (0..3_000).collect());
        scene.lighting.shadows = true;
        scene.lod_band = band;
        scene.set_lod(DrawLod::OWN);
        scene.draw(MeshId::CUBE, scaled([0.0, -0.5, -400.0], [800.0, 1.0, 900.0]), Material::color([110, 100, 80, 255]));
        scene.set_lod(FAR_RULE_OF(2));
        let origins = forest(1_000);
        for origin in &origins {
            let depth = 80.0 + (origin[2] + FOREST_SIDE * 0.5) / FOREST_SIDE * 800.0;
            scene.draw(meshes[1], translation(origin[0] * depth / FOREST_SIDE + 3.0, 2.0, -depth), Material::color([60, 110, 50, 255]));
        }
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        let mut plan = FramePlan::build(&scene, renderer.library(), width as f32 / height as f32).expect("plan");
        plan.set_lod_height(height);
        assert!(plan.views > 1, "the cascades are culled too");
        let (mut thinned, mut worst) = (0, 0.0f32);
        for view in 0..plan.views {
            let cpu = plan.cpu_cull_view(view as usize);
            let counts: Vec<u32> = renderer.read_view_args(&gpu, view).expect("args").iter().map(|a| a.instance_count).collect();
            assert_eq!(counts, cpu.counts, "band {band}, view {view}'s survivors per batch");
            let visible = renderer.read_view_visible(&gpu, view).expect("visible");
            let fades = renderer.read_view_fades(&gpu, view).expect("fades");
            for (batch, count) in plan.batches.iter().zip(&cpu.counts) {
                let range = batch.first_instance as usize..(batch.first_instance + count) as usize;
                assert_eq!(visible[range.clone()], cpu.visible[range.clone()], "band {band}, view {view} from slot {}", batch.first_instance);
                if batch.lod[0] & LOD_FADE_TAG != 0 {
                    for (slot, (gpu_value, cpu_value)) in fades[range.clone()].iter().zip(&cpu.fades[range.clone()]).enumerate() {
                        for (g, c) in gpu_value.iter().zip(cpu_value) {
                            let close = (g - c).abs() <= GPU_FAR_VALUE_TOLERANCE * c.abs().max(1.0) && g.signum() == c.signum();
                            worst = worst.max((g - c).abs());
                            assert!(close, "band {band}, view {view}, slot {}: GPU {gpu_value:?}, CPU {cpu_value:?}", range.start + slot);
                        }
                    }
                    thinned += range.len();
                }
            }
        }
        eprintln!("band {band}: {} batches, {thinned} fade-batch survivors over {} views, kept sets equal, values within {worst:e}", plan.batches.len(), plan.views);
        assert!(thinned > 1_000, "the forest thins");
        let capture = renderer.capture(&gpu).expect("capture");
        write_evidence(&format!("far-field-forest-band-{}", (band * 100.0) as u32), &capture);
    }
}

/// A forest seen from above, unthinned and under [`RULE`] (scaled to the view): the far copies
/// thin and grow, and the drawn tree cover in the far half of the frame stays within
/// [`COVER_TOLERANCE`] of the unthinned (plus the dither's own noise at a few pixels a copy).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_thinned_forest_holds_its_cover_from_above() {
    let Some(gpu) = gpu() else { return };
    let (width, height) = (640, 360);
    let rule = GpuFarRule { start: 60.0, end: 240.0, keep: 0.25, fade_out: 0.0 };
    let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
    let tree = renderer.add_model_parts(&gpu, vec![ModelPart::whole(MeshData::sphere())]).expect("added")[0];
    let frame = |renderer: &mut Renderer, rules: &[GpuFarRule]| {
        let mut camera = CameraDesc::look_at([0.0, 40.0, 30.0], [0.0, 0.0, -120.0]);
        camera.far = 2_000.0;
        let mut scene = Scene::new(camera, [150, 180, 220, 255]);
        scene.lighting.shadows = false;
        scene.far_rules = rules.to_vec();
        scene.draw(MeshId::CUBE, scaled([0.0, -0.5, -150.0], [600.0, 1.0, 600.0]), Material::color([120, 110, 90, 255]));
        scene.set_lod(FAR_RULE_OF(1));
        let mut stream = Stream(0x0bad_cafe);
        for _ in 0..12_000 {
            let (x, z) = ((stream.next() - 0.5) * 400.0, -stream.next() * 400.0 + 20.0);
            scene.draw(tree, scaled([x, 1.0, z], [1.5; 3]), Material::color([40, 110, 40, 255]));
        }
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        renderer.capture(&gpu).expect("capture")
    };
    let whole = frame(&mut renderer, &[]);
    let thinned = frame(&mut renderer, &[rule]);
    write_evidence("far-field-above-whole", &whole);
    write_evidence("far-field-above-thinned", &thinned);
    // Tree pixels (green over the brown ground and the sky) in the far half: the rows above the
    // middle.
    let green = |capture: &genex_render::capture::Capture| {
        let rows = capture.bgra().chunks(4 * width as usize).take(height as usize / 2);
        rows.flat_map(|row| row.chunks(4)).filter(|px| px[1] > px[2].saturating_add(20) && px[1] > px[0].saturating_add(20)).count()
    };
    let (a, b) = (green(&whole), green(&thinned));
    let cover = b as f32 / a.max(1) as f32;
    eprintln!("far half tree pixels: {a} unthinned, {b} thinned ({cover:.3})");
    assert!(a > 5_000, "the forest fills the far half");
    assert!((cover - 1.0).abs() <= COVER_TOLERANCE + 0.05, "drawn cover {cover}");
}
