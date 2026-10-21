//! The facade driver answers DRIVER.md requests with the same frames as the crate's own driver
//! (multiplayer MP-6b). Both drivers run as the bench runs them: a subprocess fed one JSON line
//! per command on stdin, answering one JSON line per reply or event on stdout.
//!
//! - `offline.jsonl` needs no relay: the ready line, the idle snapshot, the skew and clock seam,
//!   every write before a connect, unknown and malformed commands, a connect without an endpoint,
//!   a deliberate leave and quit. It always runs.
//! - `bench.json` is two clients in one room of a localhost netcode-bench relay (owner machine):
//!   it runs only with `GENEX_NET_BENCH=1` and `GENEX_NET_BENCH_ENDPOINT=ws://127.0.0.1:<port>`,
//!   and otherwise prints NOT MEASURED.
//!
//! The crate's driver is built first, then the rows run one file at a time:
//!
//!   node scripts/toolchains/rust-env.ts -- cargo build -p genex-multiplayer --example driver --offline
//!   node scripts/toolchains/rust-env.ts -- cargo test -p net-driver --offline --test parity
//!
//! `GENEX_NET_CRATE_DRIVER` names another build of the crate's driver.

#![allow(clippy::disallowed_types, reason = "a driver subprocess is waited on with a wall-clock deadline")]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// DRIVER.md's reply deadline for every command but `connect`.
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);
/// DRIVER.md's `connect` deadline.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a bench `await` polls before it fails.
const AWAIT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a bench `await` polls.
const AWAIT_EVERY: Duration = Duration::from_millis(50);
/// After `quit`: DRIVER.md's 5 s for the reply, then 3 s for the exit.
const EXIT_TIMEOUT: Duration = Duration::from_secs(8);
/// The ready line's fields that name the driver itself, not its answers.
const IDENTITY_KEYS: [&str; 3] = ["driver", "sdk", "sdkVersion"];
/// What the facade does not show a game, so its driver answers `null` (net-driver's lib docs):
/// a player's `uid` and `team`, an object's `seq` and a control result's `sequence`. The bench
/// row masks them in both drivers' answers and compares everything else.
const FACADE_GAPS: [&str; 4] = ["uid", "team", "seq", "sequence"];

/// The crate's own driver: `GENEX_NET_CRATE_DRIVER`, else the example cargo built beside this test.
fn crate_driver() -> PathBuf {
    if let Some(path) = std::env::var_os("GENEX_NET_CRATE_DRIVER") {
        return PathBuf::from(path);
    }
    let test = std::env::current_exe().expect("the test binary's path");
    let profile = test.parent().and_then(|deps| deps.parent()).expect("target/<profile>/deps");
    let driver = profile.join("examples").join("driver");
    assert!(
        driver.is_file(),
        "the crate's driver is not built at {}: run `cargo build -p genex-multiplayer --example driver` first",
        driver.display()
    );
    driver
}

/// The facade driver this package builds.
fn facade_driver() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_net-driver"))
}

/// One running driver: its stdin and every stdout line, parsed, as it arrives.
struct Driver {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Value>,
    /// Every frame received so far, in arrival order.
    frames: Vec<Value>,
}

impl Driver {
    fn spawn(path: &PathBuf) -> Driver {
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap_or_else(|error| panic!("spawn {}: {error}", path.display()));
        let stdout = child.stdout.take().expect("piped stdout");
        let stdin = child.stdin.take();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let frame = serde_json::from_str::<Value>(&line).unwrap_or_else(|_| json!({ "notJson": line }));
                if tx.send(frame).is_err() {
                    break;
                }
            }
        });
        let mut driver = Driver { child, stdin, lines, frames: Vec::new() };
        driver.wait_for(REPLY_TIMEOUT, |frame| frame["type"] == "ready");
        driver
    }

    /// Wait until a frame matching `done` arrives; answers it.
    fn wait_for(&mut self, timeout: Duration, done: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(frame) => {
                    self.frames.push(frame.clone());
                    if done(&frame) {
                        return frame;
                    }
                }
                Err(RecvTimeoutError::Timeout) => panic!("no matching frame within {timeout:?}; frames so far: {:#?}", self.frames),
                Err(RecvTimeoutError::Disconnected) => panic!("the driver closed stdout; frames so far: {:#?}", self.frames),
            }
        }
    }

    /// Send one raw line; when it carries an integer `cmdId`, wait for that reply and answer it.
    fn send_line(&mut self, line: &str) -> Option<Value> {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{line}").expect("write a command");
        stdin.flush().expect("flush a command");
        let parsed = serde_json::from_str::<Value>(line).ok()?;
        let cmd_id = parsed.get("cmdId").and_then(Value::as_i64)?;
        let timeout = if parsed["cmd"] == "connect" { CONNECT_TIMEOUT } else { REPLY_TIMEOUT };
        Some(self.wait_for(timeout, |frame| frame["type"] == "reply" && frame["cmdId"].as_i64() == Some(cmd_id)))
    }

    /// Send a command object.
    fn send(&mut self, command: &Value) -> Value {
        self.send_line(&command.to_string()).expect("a command with a cmdId gets a reply")
    }

    /// After `quit`: the driver exits on its own.
    fn wait_exit(&mut self) {
        let deadline = Instant::now() + EXIT_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = self.child.try_wait() {
                assert!(status.success(), "the driver exited with {status}");
                while let Ok(frame) = self.lines.recv_timeout(Duration::from_millis(100)) {
                    self.frames.push(frame);
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        panic!("the driver did not exit within {EXIT_TIMEOUT:?} of quit");
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Run every line of `fixture` through the driver at `path`; answers every frame it printed.
fn run_offline(path: &PathBuf, fixture: &str) -> Vec<Value> {
    let mut driver = Driver::spawn(path);
    for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
        driver.send_line(line);
    }
    driver.wait_exit();
    std::mem::take(&mut driver.frames)
}

/// A frame with what legitimately differs between two drivers taken out: the ready line's
/// identity, and the clock's instants (only their difference, the skew, is an answer).
fn normalized(frame: &Value) -> Value {
    let mut frame = frame.clone();
    if frame["type"] == "ready" {
        for key in IDENTITY_KEYS {
            frame[key] = json!("<driver>");
        }
    }
    let clock = frame["result"]["now"].as_f64().zip(frame["result"]["real"].as_f64());
    if let Some((now, real)) = clock {
        frame["result"] = json!({ "skew": (now - real).round() });
    }
    frame
}

/// The rows' text, for a failure message both drivers' frames sit side by side in.
fn lines(frames: &[Value]) -> String {
    frames.iter().map(|frame| format!("  {frame}\n")).collect()
}

#[test]
fn offline_requests_answer_the_same_frames_as_the_crate_driver() {
    let fixture = include_str!("fixtures/offline.jsonl");
    let expected: Vec<Value> = run_offline(&crate_driver(), fixture).iter().map(normalized).collect();
    let actual: Vec<Value> = run_offline(&facade_driver(), fixture).iter().map(normalized).collect();
    assert!(expected.len() > 20, "the crate driver answered the fixture: {}", lines(&expected));
    assert_eq!(actual, expected, "facade frames:\n{}crate frames:\n{}", lines(&actual), lines(&expected));
}

// ---- the bench row (owner machine) --------------------------------------------------------------

/// A bench fixture: steps for clients named by role, run once with two crate drivers and once
/// with two facade drivers, each pair in its own room.
fn bench_steps() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/bench.json")).expect("bench.json parses");
    fixture["steps"].as_array().expect("steps").clone()
}

/// What one pair of drivers answered: per role, every reply in step order and every event.
#[derive(Debug, Default, PartialEq)]
struct Answers {
    replies: BTreeMap<String, Vec<Value>>,
    events: BTreeMap<String, Vec<Value>>,
}

/// Replace every role's sid by `$<role>` and every value that names a request or an instant.
fn masked(value: &Value, sids: &BTreeMap<String, String>) -> Value {
    match value {
        Value::String(text) => sids.iter().find(|(_, sid)| *sid == text).map_or_else(|| value.clone(), |(role, _)| json!(format!("${role}"))),
        Value::Array(items) => Value::Array(items.iter().map(|item| masked(item, sids)).collect()),
        Value::Object(members) => {
            let mut out = serde_json::Map::new();
            for (key, member) in members {
                let shown = match key.as_str() {
                    "requestId" => json!("<request>"),
                    gap if FACADE_GAPS.contains(&gap) => json!("<facade-gap>"),
                    "retryAfterMs" => json!("<ms>"),
                    "at" | "id" if member.is_number() => json!("<n>"),
                    _ => masked(member, sids),
                };
                let key = sids.iter().find(|(_, sid)| *sid == key).map_or_else(|| key.clone(), |(role, _)| format!("${role}"));
                out.insert(key, shown);
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// `{"players.$B.connected": true}`: does `snapshot` hold every dotted predicate (plain equality)?
fn holds(snapshot: &Value, expect: &Value, sids: &BTreeMap<String, String>) -> bool {
    let Some(expect) = expect.as_object() else { return true };
    expect.iter().all(|(path, want)| {
        let mut at = snapshot.clone();
        for segment in path.split('.') {
            let segment = segment.strip_prefix('$').and_then(|role| sids.get(role)).map_or(segment, String::as_str);
            at = match (&at, segment) {
                (_, "playerCount") => json!(snapshot["players"].as_array().map_or(0, Vec::len)),
                (Value::Object(_), key) if key == "players" || key == "objects" => keyed(&at[key], if key == "players" { "sid" } else { "id" }),
                (value, key) => value.get(key).cloned().unwrap_or(Value::Null),
            };
        }
        let want = match want.as_str().and_then(|text| text.strip_prefix('$')).and_then(|role| sids.get(role)) {
            Some(sid) => json!(sid),
            None => want.clone(),
        };
        at == want
    })
}

/// A snapshot list keyed by `key` (DRIVER.md: `players.<sid>`, `objects.<id>`).
fn keyed(list: &Value, key: &str) -> Value {
    let members = list.as_array().into_iter().flatten().filter_map(|item| Some((item.get(key)?.as_str()?.to_owned(), item.clone())));
    Value::Object(members.collect())
}

/// Run the bench fixture with two drivers at `path`, in room `game`.
fn run_bench(path: &PathBuf, endpoint: &str, game: &str) -> Answers {
    let mut drivers: BTreeMap<String, Driver> = BTreeMap::new();
    let mut sids: BTreeMap<String, String> = BTreeMap::new();
    let mut answers = Answers::default();
    let mut cmd_id = 0;
    for step in bench_steps() {
        if let Some(ms) = step.get("sleep").and_then(Value::as_u64) {
            std::thread::sleep(Duration::from_millis(ms));
            continue;
        }
        let role = step["client"].as_str().or_else(|| step["await"].as_str()).expect("a step names its client").to_owned();
        let driver = drivers.entry(role.clone()).or_insert_with(|| Driver::spawn(path));
        cmd_id += 1;
        let mut command = json!({ "cmdId": cmd_id, "cmd": step.get("cmd").and_then(Value::as_str).unwrap_or("snapshot") });
        for (key, value) in step.get("args").and_then(Value::as_object).into_iter().flatten() {
            let value = value.as_str().and_then(|text| text.strip_prefix('$')).and_then(|role| sids.get(role)).map_or_else(|| value.clone(), |sid| json!(sid));
            command[key] = value;
        }
        if command["cmd"] == "connect" {
            command["endpoint"] = json!(endpoint);
            command["gameId"] = json!(game);
            command["name"] = json!(step["name"].as_str().unwrap_or(role.as_str()));
        }
        let reply = if step.get("await").is_some() {
            let deadline = Instant::now() + AWAIT_TIMEOUT;
            loop {
                let reply = driver.send(&command);
                if holds(&reply["result"], &step["snapshot"], &sids) {
                    break reply;
                }
                assert!(Instant::now() < deadline, "{role} never saw {} in {reply}", step["snapshot"]);
                std::thread::sleep(AWAIT_EVERY);
                cmd_id += 1;
                command["cmdId"] = json!(cmd_id);
            }
        } else {
            driver.send(&command)
        };
        if let Some(sid) = reply["result"]["sid"].as_str() {
            sids.insert(role.clone(), sid.to_owned());
        }
        let mut reply = reply;
        reply["cmdId"] = json!("<cmd>");
        answers.replies.entry(role).or_default().push(reply);
    }
    for (role, driver) in &mut drivers {
        driver.send(&json!({ "cmdId": 0, "cmd": "quit" }));
        driver.wait_exit();
        let events = driver.frames.iter().filter(|frame| frame["type"] == "event").cloned();
        answers.events.insert(role.clone(), events.collect());
    }
    for list in answers.replies.values_mut().chain(answers.events.values_mut()) {
        for frame in list.iter_mut() {
            *frame = masked(frame, &sids);
        }
    }
    answers
}

#[test]
fn bench_relay_two_clients_answer_the_same_frames_as_the_crate_driver() {
    if std::env::var("GENEX_NET_BENCH").as_deref() != Ok("1") {
        eprintln!("NOT MEASURED: the bench row needs GENEX_NET_BENCH=1 and a localhost netcode-bench relay");
        return;
    }
    let endpoint = std::env::var("GENEX_NET_BENCH_ENDPOINT").expect("GENEX_NET_BENCH_ENDPOINT=ws://127.0.0.1:<port>");
    let game = std::env::var("GENEX_NET_BENCH_GAME").unwrap_or_else(|_| "bench".to_owned());
    // One pair after the other in the same room: the crate pair has left before the facade pair joins.
    let expected = run_bench(&crate_driver(), &endpoint, &game);
    let actual = run_bench(&facade_driver(), &endpoint, &game);
    assert_eq!(actual, expected);
}
