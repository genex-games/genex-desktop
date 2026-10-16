//! The studio connection over a real socket pair (what Node's fourth stdio slot is): requests are
//! framed off the reader thread and answered in order by `serve`, a line past the cap is answered
//! `line-too-long` and reading goes on, the studio's end of file ends the game, `ready` carries the
//! nonce, and the environment opens nothing it should not (hostile nonces, descriptors and pipe
//! names). Unix only: Windows' pipe is compile-checked for the gnullvm target.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use genex_core::json::{self, Value};
use genex_core::protocol::MAX_LINE_BYTES;
use genex_core::session::StepResult;
use genex_studio::{
    CaptureFault, Injection, MAX_NONCE_BYTES, Pixels, ReadyInfo, Served, SocketChannel, Studio, StudioGame,
    Transport, from_environment, studio_pipe_name,
};

/// How long a row waits for the reader thread before it fails.
const ROW_WAIT: Duration = Duration::from_secs(5);

/// A game whose state is the seed it was given and the ticks it ran.
#[derive(Default)]
struct Counter {
    seed: u32,
    frame: u64,
}

impl StudioGame for Counter {
    fn seed(&mut self, seed: u32) {
        self.seed = seed;
        self.frame = 0;
    }
    fn start(&mut self) -> bool {
        true
    }
    fn pause(&mut self) -> bool {
        false
    }
    fn step(&mut self, _ms: f64) -> StepResult {
        self.frame += 1;
        StepResult { ticks: 1, frame: self.frame, simulated_ms: 0.0 }
    }
    fn state(&mut self, _camera: &str) -> Value {
        let mut state = Value::object();
        state.set("seed", Value::from(self.seed));
        state.set("frame", Value::from(self.frame));
        state
    }
    fn inject(&mut self, _injection: &Injection) -> Vec<String> {
        Vec::new()
    }
    fn view(&mut self, name: Option<&str>) -> bool {
        name.is_none()
    }
    fn render(&mut self) {}
    fn world_size(&self) -> [u32; 2] {
        [2, 2]
    }
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        Err(CaptureFault::Readback)
    }
}

/// The game's transport on one end of a socket pair, and the host's end.
fn linked(nonce: &str) -> (Arc<Transport>, UnixStream) {
    let (game, host) = UnixStream::pair().expect("socket pair");
    let channel = SocketChannel::new(game).expect("socket channel");
    (Arc::new(Transport::new(Arc::new(channel), nonce.to_owned())), host)
}

/// Serve until `answers` replies went out (or the studio's end arrived), failing the row after `ROW_WAIT`.
fn serve_until(studio: &mut Studio, link: &Transport, game: &mut Counter, answers: usize) -> bool {
    let until = Instant::now() + ROW_WAIT;
    let mut answered = 0;
    while answered < answers {
        assert!(Instant::now() < until, "the reader delivered {answered} of {answers} lines");
        link.wait(Duration::from_millis(50));
        let served = studio.serve(link, game);
        answered += served.answered;
        if served.ended {
            return true;
        }
    }
    false
}

fn read_line(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).expect("a line from the game");
    json::parse(line.trim_end().as_bytes()).expect("JSON")
}

#[test]
fn ready_then_requests_are_answered_in_order() {
    let (link, host) = linked("n0nce");
    let mut reader = BufReader::new(host.try_clone().expect("clone"));
    let mut writer = host;
    let mut studio = Studio::native("");
    let mut game = Counter::default();
    let info = ReadyInfo { build: "spike".into(), backend_api: "unknown".into(), device: None, size: [2, 2], seed: 1, receipt: None };
    assert!(studio.announce_ready(&link, &info));
    let ready = read_line(&mut reader);
    assert_eq!(
        ready.dump(),
        br#"{"event":"ready","nonce":"n0nce","protocol":1,"contractVersion":1,"build":"spike","backend":{"api":"unknown","device":null},"size":{"width":2,"height":2},"seed":1}"#
            .to_vec()
    );
    writer.write_all(b"{\"id\":1,\"op\":\"seed\",\"arg\":{\"seed\":4}}\n{\"id\":2,\"op\":\"step\"}\r\n\n{\"id\":3,\"op\":\"state\"}\n").expect("write");
    assert!(!serve_until(&mut studio, &link, &mut game, 3));
    let ids: Vec<Value> = (0..3).map(|_| read_line(&mut reader)["id"].clone()).collect();
    assert_eq!(ids, [Value::from(1), Value::from(2), Value::from(3)]);
    assert_eq!((game.seed, game.frame), (4, 1));
}

#[test]
fn requests_sent_before_ready_wait_in_the_queue_and_are_answered_after_it_in_order() {
    // v1's transport queues from connect time and serves from the first frame after `begin`: a
    // `seed` sent while the game boots runs once it is ready, and is never refused.
    let (link, host) = linked("n0nce");
    let mut reader = BufReader::new(host.try_clone().expect("clone"));
    let mut writer = host;
    let mut studio = Studio::native("");
    let mut game = Counter { seed: 1, frame: 0 };
    writer.write_all(b"{\"id\":1,\"op\":\"seed\",\"arg\":{\"seed\":9}}\n{\"id\":2,\"op\":\"state\"}\n").expect("write");
    assert!(link.wait(ROW_WAIT), "the reader queued the early lines");
    assert_eq!(studio.serve(&link, &mut game), Served::default(), "nothing is taken before ready");
    assert_eq!(game.seed, 1, "the early seed has not run yet");
    let info = ReadyInfo { build: "spike".into(), backend_api: "unknown".into(), device: None, size: [2, 2], seed: 1, receipt: None };
    assert!(studio.announce_ready(&link, &info));
    assert_eq!(read_line(&mut reader)["event"].as_str(), "ready", "ready comes before any answer");
    assert!(!serve_until(&mut studio, &link, &mut game, 2));
    let seeded = read_line(&mut reader);
    assert_eq!((seeded["id"].clone(), seeded["ok"].clone()), (Value::from(1), Value::Bool(true)));
    let state = read_line(&mut reader);
    assert_eq!(state["id"], Value::from(2));
    assert_eq!(state["result"]["seed"], Value::from(9), "the early seed ran after ready");
}

#[test]
fn a_line_past_the_cap_is_answered_line_too_long_and_changes_nothing() {
    let (link, host) = linked("n");
    let mut reader = BufReader::new(host.try_clone().expect("clone"));
    let mut writer = host;
    let mut studio = Studio::native("");
    studio.mark_ready();
    let mut game = Counter { seed: 1, frame: 0 };
    let writing = std::thread::spawn(move || {
        let mut huge = br#"{"id":1,"op":"seed","arg":{"seed":9,"pad":""#.to_vec();
        huge.resize(MAX_LINE_BYTES + 16, b'x');
        huge.extend_from_slice(b"\"}}\n{\"id\":2,\"op\":\"state\"}\n");
        writer.write_all(&huge).expect("write");
        writer
    });
    assert!(!serve_until(&mut studio, &link, &mut game, 2));
    let refused = read_line(&mut reader);
    assert_eq!(refused.dump(), br#"{"id":null,"ok":false,"op":null,"error":"line-too-long"}"#.to_vec());
    let state = read_line(&mut reader);
    assert_eq!(state["result"]["seed"], Value::from(1), "the long line's seed never ran");
    drop(writing.join().expect("writer"));
}

#[test]
fn the_studios_end_of_file_ends_the_game() {
    let (link, host) = linked("n");
    let mut studio = Studio::native("");
    studio.mark_ready();
    let mut game = Counter::default();
    drop(host);
    assert!(serve_until(&mut studio, &link, &mut game, 1));
    assert!(studio.closing());
}

#[test]
fn a_send_to_a_studio_that_left_fails_and_stays_failed() {
    let (link, host) = linked("n");
    drop(host);
    assert!(!link.send(b"{\"event\":\"focus\",\"focused\":true}"));
    assert!(!link.send(b"{}"));
}

#[test]
fn dropping_the_transport_returns_without_waiting_for_the_studio() {
    let (link, _host) = linked("n");
    let started = Instant::now();
    drop(link);
    assert!(started.elapsed() < ROW_WAIT);
}

#[test]
fn the_environment_opens_no_transport_for_a_hostile_nonce_or_descriptor() {
    let long = "n".repeat(MAX_NONCE_BYTES + 1);
    let rows: [(&str, Option<&str>, Option<&str>); 6] = [
        ("no nonce", None, Some("3")),
        ("an empty nonce", Some(""), Some("3")),
        ("a nonce past the cap", Some(long.as_str()), Some("3")),
        ("no descriptor", Some("n"), None),
        ("another descriptor", Some("n"), Some("4")),
        ("a padded descriptor", Some("n"), Some(" 3")),
    ];
    for (name, nonce, fd) in rows {
        let env = |key: &str| match key {
            "GENEX_STUDIO_NONCE" => nonce.map(str::to_owned),
            "GENEX_STUDIO_FD" => fd.map(str::to_owned),
            _ => None,
        };
        assert!(from_environment(&env).is_none(), "{name}");
    }
}

#[test]
fn only_a_runs_own_pipe_name_is_taken() {
    let rows: [(&str, &str); 9] = [
        (r"\\.\pipe\genex-game-0123456789ab", r"\\.\pipe\genex-game-0123456789ab"),
        (r"\\.\pipe\genex-game-0123456789abcdef0123456789abcdef", r"\\.\pipe\genex-game-0123456789abcdef0123456789abcdef"),
        (r"\\.\pipe\genex-game-0123456789a", ""),
        (r"\\.\pipe\genex-game-0123456789abcdef0123456789abcdef0", ""),
        (r"\\.\pipe\genex-game-0123456789AB", ""),
        (r"\\.\pipe\genex-game-0123456789ag", ""),
        (r"\\.\pipe\other-0123456789ab", ""),
        (r"\\server\pipe\genex-game-0123456789ab", ""),
        ("", ""),
    ];
    for (given, taken) in rows {
        let env = |key: &str| (key == "GENEX_STUDIO_PIPE").then(|| given.to_owned());
        assert_eq!(studio_pipe_name(&env), taken, "{given}");
    }
}

/// A game that can embed: every ring it is asked for is made.
#[derive(Default)]
struct Ringed {
    counter: Counter,
}

impl StudioGame for Ringed {
    fn seed(&mut self, seed: u32) {
        self.counter.seed(seed);
    }
    fn start(&mut self) -> bool {
        true
    }
    fn pause(&mut self) -> bool {
        false
    }
    fn step(&mut self, ms: f64) -> StepResult {
        self.counter.step(ms)
    }
    fn state(&mut self, camera: &str) -> Value {
        self.counter.state(camera)
    }
    fn inject(&mut self, _injection: &Injection) -> Vec<String> {
        Vec::new()
    }
    fn view(&mut self, name: Option<&str>) -> bool {
        name.is_none()
    }
    fn render(&mut self) {}
    fn world_size(&self) -> [u32; 2] {
        [2, 2]
    }
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        Err(CaptureFault::Readback)
    }
    fn embeddable(&self) -> bool {
        true
    }
    fn make_ring(&mut self, _ring: &genex_studio::wire::SurfaceArgs) -> Result<(), genex_studio::RingFault> {
        Ok(())
    }
}

/// Serve `game` until `answers` replies went out, failing the row after `ROW_WAIT`.
fn serve_ringed(studio: &mut Studio, link: &Transport, game: &mut Ringed, answers: usize) {
    let until = Instant::now() + ROW_WAIT;
    let mut answered = 0;
    while answered < answers {
        assert!(Instant::now() < until, "the reader delivered {answered} of {answers} lines");
        link.wait(Duration::from_millis(50));
        answered += studio.serve(link, game).answered;
    }
}

#[test]
fn a_restored_device_forgets_lives_ring_and_tells_the_studio_which_announces_a_newer_generation() {
    let (link, host) = linked("n0nce");
    let mut reader = BufReader::new(host.try_clone().expect("clone"));
    let mut writer = host;
    let mut studio = Studio::native("");
    let mut game = Ringed::default();
    let info = ReadyInfo { build: "spike".into(), backend_api: "metal".into(), device: None, size: [2, 2], seed: 1, receipt: None };
    assert!(studio.announce_ready(&link, &info));
    read_line(&mut reader);
    writer
        .write_all(b"{\"id\":1,\"op\":\"surface\",\"arg\":{\"w\":320,\"h\":180,\"dpr\":2,\"slots\":3,\"generation\":1}}\n")
        .expect("write");
    serve_ringed(&mut studio, &link, &mut game, 1);
    assert_eq!(read_line(&mut reader)["ok"], Value::Bool(true), "the first ring is made");
    assert!(studio.ring().is_some());

    assert!(studio.device_restored(&link));
    assert_eq!(read_line(&mut reader).dump(), br#"{"event":"device-restored"}"#.to_vec());
    assert!(studio.ring().is_none(), "the old ring is forgotten with the old device");

    // The old generation is never asked for again; the studio's next one is made.
    writer
        .write_all(b"{\"id\":2,\"op\":\"surface\",\"arg\":{\"w\":320,\"h\":180,\"dpr\":2,\"slots\":3,\"generation\":1}}\n{\"id\":3,\"op\":\"surface\",\"arg\":{\"w\":320,\"h\":180,\"dpr\":2,\"slots\":3,\"generation\":2}}\n")
        .expect("write");
    serve_ringed(&mut studio, &link, &mut game, 2);
    let stale = read_line(&mut reader);
    assert_eq!(stale["ok"], Value::Bool(false), "a stale generation is refused: {}", String::from_utf8_lossy(&stale.dump()));
    assert_eq!(read_line(&mut reader)["result"]["generation"], Value::from(2u32));
    assert_eq!(studio.ring().map(|ring| ring.generation), Some(2));
}

// Pass-1 gate: a boot that keeps working says so, so the studio's ready deadline runs from its last
// finished step; once ready the event is never sent (the host takes it for a violation).
#[test]
fn still_starting_goes_out_before_ready_only() {
    let (link, host) = linked("n0nce");
    let mut reader = BufReader::new(host);
    let mut studio = Studio::native("");
    assert!(studio.still_starting(&link));
    assert_eq!(read_line(&mut reader).dump(), br#"{"event":"starting"}"#.to_vec());
    let info = ReadyInfo { build: "spike".into(), backend_api: "metal".into(), device: None, size: [2, 2], seed: 1, receipt: None };
    assert!(studio.announce_ready(&link, &info));
    assert_eq!(read_line(&mut reader)["event"], Value::from("ready"));
    assert!(!studio.still_starting(&link), "nothing once ready");
}

// Renderer pass 2 (owner decision D11): a boot step names its stage and, where counted, how far it
// is, so Live shows real progress (pipelines n of m) while it waits; nothing once ready.
#[test]
fn starting_names_the_stage_and_its_count_before_ready_only() {
    use genex_core::protocol::{BootProgress, BootStage};
    let (link, host) = linked("n0nce");
    let mut reader = BufReader::new(host);
    let mut studio = Studio::native("");
    assert!(studio.starting_at(&link, BootProgress::at(BootStage::Device)));
    assert_eq!(read_line(&mut reader).dump(), br#"{"event":"starting","stage":"device"}"#.to_vec());
    assert!(studio.starting_at(&link, BootProgress::counted(BootStage::Pipelines, 12, 40)));
    assert_eq!(read_line(&mut reader).dump(), br#"{"event":"starting","stage":"pipelines","done":12,"total":40}"#.to_vec());
    let info = ReadyInfo { build: "spike".into(), backend_api: "metal".into(), device: None, size: [2, 2], seed: 1, receipt: None };
    assert!(studio.announce_ready(&link, &info));
    assert_eq!(read_line(&mut reader)["event"], Value::from("ready"));
    assert!(!studio.starting_at(&link, BootProgress::at(BootStage::Frame)), "nothing once ready");
}
