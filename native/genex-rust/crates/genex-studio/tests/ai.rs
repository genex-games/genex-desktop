//! Play-time AI over the studio's connection (docs/play-protocol.md, "Play-time AI"): a game that
//! uses AI declares `capabilities.ai` in `ready`; only when the studio said it takes AI lines
//! (`GENEX_STUDIO_AI=1`) are the game's `ai` lines written and its `ai.reply` / `ai.delta` ops
//! served, and each line goes out before the reply of the request whose ticks printed it, so the
//! studio has heard it before it sends the next step. A studio that did not opt in never sees a
//! line (today's host reads an unknown event as a violation) and gets `unknown-op` for the ops.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use genex_core::json::{self, Value};
use genex_core::session::StepResult;
use genex_studio::{
    AI_ENV, CaptureFault, Injection, Op, Pixels, ReadyInfo, SocketChannel, Studio, StudioGame, Transport, VerbRefusal,
};

/// How long a row waits for the reader thread before it fails.
const ROW_WAIT: Duration = Duration::from_secs(5);

/// A game that prints one `ai` line per step and records the AI ops it took.
#[derive(Default)]
struct Asker {
    uses_ai: bool,
    lines: Vec<String>,
    printed: u32,
    taken: Vec<(String, String)>,
    steps: u32,
}

impl StudioGame for Asker {
    fn seed(&mut self, _seed: u32) {}
    fn start(&mut self) -> bool {
        true
    }
    fn pause(&mut self) -> bool {
        false
    }
    fn step(&mut self, _ms: f64) -> StepResult {
        self.steps += 1;
        if self.uses_ai {
            self.printed += 1;
            self.lines.push(format!(r#"{{"event":"ai","rid":"rsai-{:08}","op":"hello","body":null}}"#, self.printed));
        }
        StepResult { ticks: 1, frame: u64::from(self.steps), simulated_ms: 16.0 }
    }
    fn state(&mut self, _camera: &str) -> Value {
        Value::object()
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
    fn take_ai_op(&mut self, op: &str, arg: &Value) -> Option<bool> {
        let Some(Value::String(_)) = arg.get("rid") else { return None };
        let rid = arg["rid"].as_str();
        self.taken.push((op.to_owned(), rid.to_owned()));
        Some(rid.starts_with("rsai-"))
    }
    fn take_ai_lines(&mut self) -> Vec<String> {
        std::mem::take(&mut self.lines)
    }
}

fn linked() -> (Arc<Transport>, BufReader<UnixStream>, UnixStream) {
    let (game, host) = UnixStream::pair().expect("socket pair");
    let channel = SocketChannel::new(game).expect("socket channel");
    let link = Arc::new(Transport::new(Arc::new(channel), "n0nce".to_owned()));
    (link, BufReader::new(host.try_clone().expect("clone")), host)
}

fn info(ai: bool) -> ReadyInfo {
    ReadyInfo {
        build: "spike".into(),
        backend_api: "metal".into(),
        device: None,
        size: [2, 2],
        seed: 1,
        receipt: None,
        ai,
    }
}

fn read_line(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).expect("a line");
    json::parse(line.trim_end().as_bytes()).expect("JSON")
}

fn serve(studio: &mut Studio, link: &Transport, game: &mut Asker, answers: usize) {
    let until = Instant::now() + ROW_WAIT;
    let mut answered = 0;
    while answered < answers {
        assert!(Instant::now() < until, "the reader delivered {answered} of {answers} lines");
        link.wait(Duration::from_millis(50));
        answered += studio.serve(link, game).answered;
    }
}

/// The studio of a run whose environment says (or does not say) that it takes AI lines.
fn studio(takes_ai: bool) -> Studio {
    let env = move |name: &str| (takes_ai && name == AI_ENV).then(|| "1".to_owned());
    Studio::for_run(&env)
}

#[test]
fn ready_declares_ai_only_for_a_game_that_uses_it() {
    for uses_ai in [false, true] {
        let (link, mut reader, _host) = linked();
        let mut studio = studio(true);
        assert!(studio.announce_ready(&link, &info(uses_ai)));
        let ready = read_line(&mut reader);
        assert_eq!(ready["event"], Value::from("ready"));
        assert_eq!(ready.get("capabilities").is_some(), uses_ai, "uses_ai {uses_ai}");
        assert_eq!(ready["capabilities"]["ai"].as_bool(), uses_ai, "uses_ai {uses_ai}");
        assert_eq!(studio.takes_ai(), uses_ai);
    }
}

#[test]
fn a_studio_that_took_the_games_ai_hears_each_line_before_the_reply_that_followed_it() {
    let (link, mut reader, mut writer) = linked();
    let mut studio = studio(true);
    let mut game = Asker { uses_ai: true, ..Asker::default() };
    studio.announce_ready(&link, &info(true));
    read_line(&mut reader);
    writer
        .write_all(b"{\"id\":1,\"op\":\"step\",\"arg\":{\"ms\":16}}\n{\"id\":2,\"op\":\"step\",\"arg\":{\"ms\":16}}\n")
        .expect("write");
    serve(&mut studio, &link, &mut game, 2);
    let order: Vec<String> = (0..4)
        .map(|_| {
            let line = read_line(&mut reader);
            if line["event"].as_str() == "ai" {
                line["rid"].as_str().to_owned()
            } else {
                format!("reply {}", line["id"].as_f64())
            }
        })
        .collect();
    assert_eq!(order, ["rsai-00000001", "reply 1", "rsai-00000002", "reply 2"]);
}

#[test]
fn the_ai_ops_reach_the_game_and_a_hostile_argument_is_refused_with_no_side_effect() {
    let (link, mut reader, mut writer) = linked();
    let mut studio = studio(true);
    let mut game = Asker { uses_ai: true, ..Asker::default() };
    studio.announce_ready(&link, &info(true));
    read_line(&mut reader);
    let rows: [(&str, Option<bool>); 6] = [
        (r#"{"id":1,"op":"ai.reply","arg":{"rid":"rsai-00000001","reply":{"v":1,"on":true}}}"#, Some(true)),
        (r#"{"id":2,"op":"ai.delta","arg":{"rid":"other-0001","text":"x"}}"#, Some(false)),
        (r#"{"id":3,"op":"ai.reply","arg":{"reply":{}}}"#, None),
        (r#"{"id":4,"op":"ai.reply","arg":"rsai-00000001"}"#, None),
        (r#"{"id":5,"op":"ai.reply"}"#, None),
        (r#"{"id":6,"op":"ai.delta","arg":{"rid":7}}"#, None),
    ];
    for (request, taken) in rows {
        writer.write_all(format!("{request}\n").as_bytes()).expect("write");
        serve(&mut studio, &link, &mut game, 1);
        let reply = read_line(&mut reader);
        match taken {
            Some(taken) => {
                assert!(reply["ok"].as_bool(), "{request}");
                assert_eq!(reply["result"]["taken"].as_bool(), taken, "{request}");
            }
            None => assert_eq!(reply["error"].as_str(), VerbRefusal::BAD_ARGUMENT, "{request}"),
        }
    }
    assert_eq!(
        game.taken,
        [("ai.reply".to_owned(), "rsai-00000001".to_owned()), ("ai.delta".to_owned(), "other-0001".to_owned())]
    );
    assert_eq!(game.steps, 0);
}

#[test]
fn a_studio_that_did_not_take_ai_never_sees_a_line_and_is_not_served_the_ops() {
    for (takes_ai, uses_ai) in [(false, true), (true, false), (false, false)] {
        let (link, mut reader, mut writer) = linked();
        let mut studio = studio(takes_ai);
        let mut game = Asker { uses_ai, ..Asker::default() };
        studio.announce_ready(&link, &info(uses_ai));
        read_line(&mut reader);
        assert!(!studio.takes_ai());
        writer
            .write_all(b"{\"id\":1,\"op\":\"step\",\"arg\":{\"ms\":16}}\n{\"id\":2,\"op\":\"ai.reply\",\"arg\":{\"rid\":\"rsai-00000001\",\"reply\":{}}}\n")
            .expect("write");
        serve(&mut studio, &link, &mut game, 2);
        assert_eq!(read_line(&mut reader)["id"].as_f64(), 1.0, "the step's reply comes first: no line before it");
        let refused = read_line(&mut reader);
        assert_eq!(refused["error"].as_str(), "unknown-op");
        let available = refused["available"].items().iter().map(|op| op.as_str().to_owned()).collect::<Vec<_>>();
        assert!(!available.iter().any(|op| Op::AI.contains(&op.as_str())), "the AI ops are not listed: {available:?}");
        assert!(game.taken.is_empty());
        studio.flush_ai(&link, &mut game);
        writer.write_all(b"{\"id\":3,\"op\":\"pause\"}\n").expect("write");
        serve(&mut studio, &link, &mut game, 1);
        assert_eq!(read_line(&mut reader)["id"].as_f64(), 3.0, "a flush with AI not taken writes nothing");
    }
}
