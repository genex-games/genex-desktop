//! Contract v2 through the verbs (M2.4): `ready` with protocol 2 and the capability receipt,
//! `state()` with `lifecycle` and `safeArea`, and the embedded run's ring ops (`surface`,
//! `release`) with `frames.h`'s semantics: a build that cannot embed answers both `unknown-op` and
//! never lists them (the host reads that as `game-predates-embedding`); hostile arguments are
//! refused `bad-argument` and make no ring; generations only grow (`stale-generation`); no frames
//! service is `no-frames-service`; a release of another generation changes nothing; with a ring,
//! Live's ring-pixel positions become fractions of the letterboxed frame (touches: world pixels).

use genex_core::json::{self, Value};
use genex_core::session::StepResult;
use genex_studio::wire::{Backend, Lifecycle, NativeEnhanced, Receipt, SafeArea, SurfaceArgs};
use genex_studio::{CaptureFault, Injection, Op, Pixels, ReadyInfo, RingFault, Studio, StudioGame, VerbRefusal};

/// A game double that may embed: it records the rings it was asked for and the slots released.
#[derive(Default)]
struct Embedder {
    embeddable: bool,
    /// What `make_ring` answers.
    fault: Option<RingFault>,
    rings: Vec<SurfaceArgs>,
    released: Vec<(u32, u32)>,
    injected: Vec<Injection>,
}

impl StudioGame for Embedder {
    fn seed(&mut self, _seed: u32) {}
    fn start(&mut self) -> bool {
        true
    }
    fn pause(&mut self) -> bool {
        false
    }
    fn step(&mut self, _ms: f64) -> StepResult {
        StepResult::default()
    }
    fn state(&mut self, camera: &str) -> Value {
        let mut state = Value::object();
        state.set("camera", Value::from(camera));
        state
    }
    fn inject(&mut self, injection: &Injection) -> Vec<String> {
        self.injected.push(injection.clone());
        Vec::new()
    }
    fn view(&mut self, name: Option<&str>) -> bool {
        name.is_none()
    }
    fn render(&mut self) {}
    fn world_size(&self) -> [u32; 2] {
        [960, 540]
    }
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        Err(CaptureFault::Readback)
    }
    fn embeddable(&self) -> bool {
        self.embeddable
    }
    fn make_ring(&mut self, ring: &SurfaceArgs) -> Result<(), RingFault> {
        if let Some(fault) = self.fault {
            return Err(fault);
        }
        self.rings.push(*ring);
        Ok(())
    }
    fn release_slot(&mut self, generation: u32, slot: u32) {
        self.released.push((generation, slot));
    }
    fn lifecycle(&self) -> Lifecycle {
        Lifecycle::Resumed
    }
    fn safe_area(&self) -> SafeArea {
        SafeArea { top: 4, left: 0, bottom: 2, right: 0 }
    }
}

fn studio() -> Studio {
    let mut studio = Studio::native("");
    studio.mark_ready();
    studio
}

fn reply(studio: &mut Studio, game: &mut Embedder, line: &str) -> Value {
    json::parse(&studio.handle(game, line.as_bytes())).expect("a reply is JSON")
}

fn embedder() -> Embedder {
    Embedder { embeddable: true, ..Embedder::default() }
}

fn surface_line(id: u32, generation: u32) -> String {
    format!(r#"{{"id":{id},"op":"surface","arg":{{"w":480,"h":540,"dpr":2,"slots":3,"generation":{generation}}}}}"#)
}

fn receipt() -> Receipt {
    Receipt::new(Backend::Metal, "Apple M3", vec![NativeEnhanced::Subgroup])
}

fn info(receipt: Option<Receipt>) -> ReadyInfo {
    ReadyInfo {
        build: "genex-rust/macos/headless".to_owned(),
        backend_api: "unknown".to_owned(),
        device: Some("Apple M3".to_owned()),
        size: [960, 540],
        seed: 1,
        receipt,
    }
}

#[test]
fn a_v2_ready_states_protocol_2_and_carries_the_receipt() {
    let ready = json::parse(&Studio::ready_line("n0nce", &info(Some(receipt())))).expect("JSON");
    assert_eq!(ready["event"].as_str(), "ready");
    assert_eq!(ready["nonce"].as_str(), "n0nce");
    assert_eq!(ready["protocol"].as_f64(), 2.0);
    assert_eq!(ready["contractVersion"].as_f64(), 2.0);
    assert_eq!(ready["backend"]["api"].as_str(), "metal", "backend.api names the receipt's backend");
    assert_eq!(ready["backend"]["device"].as_str(), "Apple M3");
    assert_eq!(ready["receipt"]["tier"].as_str(), "core");
    assert_eq!(ready["receipt"]["nativeEnhanced"].items().len(), 1);
    assert_eq!(ready["size"]["width"].as_f64(), 960.0);
    assert_eq!(ready["seed"].as_f64(), 1.0);
    let v1 = json::parse(&Studio::ready_line("n0nce", &info(None))).expect("JSON");
    assert_eq!(v1["protocol"].as_f64(), 1.0, "without a receipt the game is a protocol 1 game");
    assert!(v1.get("receipt").is_none());
    assert_eq!(v1["backend"]["api"].as_str(), "unknown");
}

#[test]
fn a_v2_state_carries_lifecycle_and_safe_area_and_a_v1_state_does_not() {
    let mut game = embedder();
    let mut v2 = studio();
    v2.set_protocol(2);
    let state = reply(&mut v2, &mut game, r#"{"id":1,"op":"state"}"#);
    assert_eq!(state["result"]["lifecycle"].as_str(), "resumed");
    assert_eq!(state["result"]["safeArea"]["top"].as_f64(), 4.0);
    assert_eq!(state["result"]["contractVersion"].as_f64(), 2.0);
    let mut v1 = studio();
    let state = reply(&mut v1, &mut game, r#"{"id":1,"op":"state"}"#);
    assert!(state["result"].get("lifecycle").is_none());
    assert!(state["result"].get("safeArea").is_none());
}

#[test]
fn a_build_that_cannot_embed_answers_surface_and_release_unknown_op_and_never_lists_them() {
    let mut game = Embedder::default();
    let mut studio = studio();
    for line in [surface_line(1, 1), r#"{"id":2,"op":"release","arg":{"slot":0,"generation":1}}"#.to_owned()] {
        let answer = reply(&mut studio, &mut game, &line);
        assert_eq!(answer["error"].as_str(), "unknown-op");
        let available: Vec<&str> = answer["available"].items().iter().map(Value::as_str).collect();
        assert!(!available.contains(&Op::SURFACE) && !available.contains(&Op::RELEASE), "{available:?}");
    }
    assert!(game.rings.is_empty());
}

#[test]
fn surface_makes_a_ring_and_answers_its_shape_and_an_embeddable_build_lists_the_ops() {
    let mut game = embedder();
    let mut studio = studio();
    let answer = reply(&mut studio, &mut game, &surface_line(1, 1));
    assert_eq!(answer["ok"], Value::Bool(true));
    let result = &answer["result"];
    let shape: Vec<f64> = ["generation", "width", "height", "slots"].iter().map(|k| result[*k].as_f64()).collect();
    assert_eq!(shape, [1.0, 480.0, 540.0, 3.0]);
    assert_eq!(game.rings.len(), 1);
    let unknown = reply(&mut studio, &mut game, r#"{"id":2,"op":"nope"}"#);
    let available: Vec<&str> = unknown["available"].items().iter().map(Value::as_str).collect();
    assert!(available.contains(&Op::SURFACE) && available.contains(&Op::RELEASE), "{available:?}");
}

#[test]
fn hostile_surface_arguments_are_refused_and_make_no_ring() {
    let hostile = [
        r#"{"id":1,"op":"surface"}"#,
        r#"{"id":1,"op":"surface","arg":[480,540]}"#,
        r#"{"id":1,"op":"surface","arg":{"w":0,"h":540,"dpr":1,"slots":3,"generation":1}}"#,
        r#"{"id":1,"op":"surface","arg":{"w":4097,"h":540,"dpr":1,"slots":3,"generation":1}}"#,
        r#"{"id":1,"op":"surface","arg":{"w":480.5,"h":540,"dpr":1,"slots":3,"generation":1}}"#,
        r#"{"id":1,"op":"surface","arg":{"w":480,"h":540,"dpr":5,"slots":3,"generation":1}}"#,
        r#"{"id":1,"op":"surface","arg":{"w":480,"h":540,"dpr":1,"slots":4,"generation":1}}"#,
        r#"{"id":1,"op":"surface","arg":{"w":480,"h":540,"dpr":1,"slots":3,"generation":0}}"#,
        r#"{"id":1,"op":"surface","arg":{"w":"480","h":540,"dpr":1,"slots":3,"generation":1}}"#,
    ];
    let mut game = embedder();
    let mut studio = studio();
    for line in hostile {
        assert_eq!(reply(&mut studio, &mut game, line)["error"].as_str(), VerbRefusal::BAD_ARGUMENT, "{line}");
    }
    assert!(game.rings.is_empty());
    // A refused argument never counts as a generation asked for.
    assert_eq!(reply(&mut studio, &mut game, &surface_line(2, 1))["ok"], Value::Bool(true));
}

#[test]
fn generations_only_grow_and_a_failed_ring_is_refused_by_its_code() {
    let mut game = embedder();
    let mut studio = studio();
    assert_eq!(reply(&mut studio, &mut game, &surface_line(1, 5))["ok"], Value::Bool(true));
    for stale in [5, 4] {
        let answer = reply(&mut studio, &mut game, &surface_line(2, stale));
        assert_eq!(answer["error"].as_str(), VerbRefusal::STALE_GENERATION);
    }
    game.fault = Some(RingFault::NoService);
    assert_eq!(reply(&mut studio, &mut game, &surface_line(3, 6))["error"].as_str(), VerbRefusal::NO_FRAMES_SERVICE);
    game.fault = Some(RingFault::Failed);
    assert_eq!(reply(&mut studio, &mut game, &surface_line(4, 7))["error"].as_str(), VerbRefusal::SURFACE_FAILED);
    assert_eq!(reply(&mut studio, &mut game, &surface_line(5, 7))["error"].as_str(), VerbRefusal::STALE_GENERATION);
    assert_eq!(game.rings.len(), 1);
}

#[test]
fn release_frees_only_the_current_generations_slot_and_refuses_hostile_arguments() {
    let mut game = embedder();
    let mut studio = studio();
    let before = reply(&mut studio, &mut game, r#"{"id":1,"op":"release","arg":{"slot":0,"generation":1}}"#);
    assert_eq!(before["ok"], Value::Bool(true), "a release before any ring is answered and changes nothing");
    reply(&mut studio, &mut game, &surface_line(2, 3));
    reply(&mut studio, &mut game, r#"{"id":3,"op":"release","arg":{"slot":1,"generation":3}}"#);
    reply(&mut studio, &mut game, r#"{"id":4,"op":"release","arg":{"slot":1,"generation":2}}"#);
    for hostile in [
        r#"{"id":5,"op":"release"}"#,
        r#"{"id":5,"op":"release","arg":{"slot":3,"generation":3}}"#,
        r#"{"id":5,"op":"release","arg":{"slot":-1,"generation":3}}"#,
        r#"{"id":5,"op":"release","arg":{"slot":0,"generation":0}}"#,
    ] {
        assert_eq!(reply(&mut studio, &mut game, hostile)["error"].as_str(), VerbRefusal::BAD_ARGUMENT, "{hostile}");
    }
    assert_eq!(game.released, [(3, 1)]);
}

#[test]
fn with_a_ring_lives_ring_pixels_become_fractions_of_the_letterboxed_frame() {
    let mut game = embedder();
    let mut studio = studio();
    // A 480x540 ring holds the 960x540 world at half scale, 135 px bars above and below.
    reply(&mut studio, &mut game, &surface_line(1, 1));
    let input = r#"{"id":2,"op":"input","arg":{"pointer":{"x":240,"y":270,"px":true},"actions":[
        {"type":"click","x":0,"y":135,"px":true},
        {"type":"touch","phase":"start","id":1,"x":480,"y":0,"px":true},
        {"type":"move","x":0.25,"y":0.75}]}}"#;
    assert_eq!(reply(&mut studio, &mut game, &input.replace('\n', ""))["ok"], Value::Bool(true));
    let injection = game.injected.last().expect("an injection");
    assert_eq!(injection.ignored, 0, "ring pixels are mapped, not ignored");
    let pointer = injection.pointer.expect("a pointer");
    assert_eq!((pointer.x, pointer.y), (0.25, 0.75), "an action without px stays a fraction");
    let touch = injection.touches.first().expect("a touch");
    assert_eq!((touch.x, touch.y), (960.0, 0.0), "a touch in ring pixels lands in world pixels, held to the frame");
    // Without a ring, a px pointer is not this side's to read.
    let mut flat = self::studio();
    let mut plain = embedder();
    reply(&mut flat, &mut plain, r#"{"id":1,"op":"input","arg":{"pointer":{"x":240,"y":270,"px":true}}}"#);
    assert_eq!(plain.injected[0].ignored, 1);
}
