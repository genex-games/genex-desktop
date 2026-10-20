//! The Rust driver for the netcode bench (`packages/netcode-bench/DRIVER.md`, contract 1): this
//! crate's native `Session` behind the stdio line-JSON contract, so the protocol-3 conformance
//! fixtures and the feel gates can run it alone and in mixed rooms with the TypeScript SDK.
//!
//! ```sh
//! GENEX_CONFORMANCE_DRIVERS=rust \
//! GENEX_DRIVER_RUST="cargo run -q --example driver --manifest-path sdks/rust/Cargo.toml" \
//!   node --conditions=@genex-ai/source --import ./src/env/stdout-guard.ts --test --test-force-exit test/conformance.test.ts
//! ```
//! stdout carries ONLY contract lines; diagnostics go to stderr. The stdin reader thread is test
//! scaffolding; the SDK itself is driven from this one loop, polled every ~2 ms.
use genex_multiplayer::{stamp, ConnectOptions, ControlResult, Event, Session};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::sync::mpsc::{self, TryRecvError};
use std::time::Duration;

fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn reply(cmd_id: &Value, result: Result<Value, String>) {
    match result {
        Ok(r) => emit(json!({ "type": "reply", "cmdId": cmd_id, "ok": true, "result": r })),
        Err(e) => emit(json!({ "type": "reply", "cmdId": cmd_id, "ok": false, "error": e })),
    }
}

fn event(name: &str, payload: Value) {
    emit(json!({ "type": "event", "name": name, "payload": payload }));
}

fn control_json(r: &ControlResult) -> Value {
    let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
    if r.owner.is_none() {
        v["owner"] = Value::Null;
    }
    v
}

#[derive(Default)]
struct Driver {
    session: Option<Session>,
    status: &'static str,
    skew: f64,
    /// The skew the process clock carries now (set at connect).
    applied_skew: f64,
    listening: HashSet<String>,
    connect_cmd: Option<Value>,
    controls: HashMap<String, Value>,
    attempts: u64,
    left: bool,
}

impl Driver {
    fn live(&mut self) -> Result<&mut Session, String> {
        match self.session.as_mut() {
            Some(s) if !s.is_closed() => Ok(s),
            _ => Err("not connected".into()),
        }
    }

    fn command(&mut self, line: &str) {
        let Ok(Value::Object(mut msg)) = serde_json::from_str::<Value>(line) else {
            eprintln!("[rust-driver] ignoring non-JSON command line: {line}");
            return;
        };
        let cmd_id = msg.remove("cmdId").unwrap_or(Value::Null);
        let Some(cmd) = msg.remove("cmd").and_then(|c| c.as_str().map(str::to_string)) else {
            return reply(&cmd_id, Err("missing cmd".into()));
        };
        let str_arg = |k: &str| msg.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let result: Result<Option<Value>, String> = match cmd.as_str() {
            "connect" => self.connect(&msg, cmd_id.clone()).map(|_| None),
            "skew" => {
                self.skew = msg.get("ms").and_then(Value::as_f64).unwrap_or(0.0);
                Ok(Some(json!({ "ms": self.skew })))
            }
            "clock" => {
                // The stamping clock and the same clock without the injected skew, one instant.
                let now = stamp::local_now_ms();
                let real = now - self.applied_skew;
                let skew = if self.session.is_some() {
                    self.applied_skew
                } else {
                    self.skew
                };
                Ok(Some(json!({ "now": real + skew, "real": real })))
            }
            "setState" => {
                let data = msg.get("data").cloned().unwrap_or(Value::Null);
                let snap = msg.get("snap").and_then(Value::as_bool).unwrap_or(false);
                self.live()
                    .and_then(|s| if snap { s.snap_me(data) } else { s.set_me(data) }.map_err(|e| e.to_string()))
                    .map(|_| Some(Value::Null))
            }
            "setShared" => {
                let value = msg.get("value").cloned().unwrap_or(Value::Null);
                let key = str_arg("key");
                self.live()
                    .and_then(|s| s.set_shared(&key, &value).map_err(|e| e.to_string()))
                    .map(|_| Some(Value::Null))
            }
            "claim" | "release" | "destroy" => {
                let id = str_arg("id");
                let host = msg.get("authority").and_then(Value::as_str) == Some("host");
                let r = self.live().and_then(|s| {
                    match cmd.as_str() {
                        "claim" if host => s.claim_as_host(&id),
                        "claim" => s.claim(&id),
                        "release" => s.release(&id),
                        _ => s.destroy(&id),
                    }
                    .map_err(|e| e.to_string())
                });
                match r {
                    Ok(request_id) => {
                        self.controls.insert(request_id, cmd_id.clone());
                        Ok(None)
                    }
                    Err(e) => Err(e),
                }
            }
            "setObject" => {
                let id = str_arg("id");
                let d = msg.get("d").cloned().unwrap_or(Value::Null);
                let snap = msg.get("snap").and_then(Value::as_bool).unwrap_or(false);
                // A non-owner's publish is dropped client-side: still `ok` (DRIVER.md).
                self.live().map(|s| {
                    let r = if snap {
                        s.snap_object(&id, d)
                    } else {
                        s.set_object(&id, d)
                    };
                    if let Err(e) = r {
                        eprintln!("[rust-driver] setObject {id}: {e}");
                    }
                    Some(Value::Null)
                })
            }
            "listen" => {
                let kind = str_arg("type");
                if let Some(s) = self.session.as_mut() {
                    s.listen(&kind);
                }
                self.listening.insert(kind);
                Ok(Some(Value::Null))
            }
            "send" => {
                let kind = str_arg("type");
                let data = msg.get("data").cloned().unwrap_or(Value::Null);
                // A reserved type is refused locally; the contract still wants `ok`.
                self.live().map(|s| {
                    if let Err(e) = s.send(&kind, &data) {
                        eprintln!("[rust-driver] send {kind}: {e}");
                    }
                    Some(Value::Null)
                })
            }
            "chat" => {
                let text = str_arg("text");
                self.live()
                    .and_then(|s| s.chat_send(&text).map_err(|e| e.to_string()))
                    .map(|_| Some(Value::Null))
            }
            "snapshot" => Ok(Some(self.snapshot())),
            "sampleSmoothed" => Ok(Some(json!({ "state": self.sample(&msg) }))),
            "leave" => {
                self.leave();
                Ok(Some(Value::Null))
            }
            other => Err(format!("unknown command: {other}")),
        };
        match result {
            Ok(Some(v)) => reply(&cmd_id, Ok(v)),
            Ok(None) => {} // answered later (connect, control results)
            Err(e) => reply(&cmd_id, Err(e)),
        }
    }

    fn connect(&mut self, args: &Map<String, Value>, cmd_id: Value) -> Result<(), String> {
        if self.session.is_some() {
            return Err("already connected".into());
        }
        let endpoint = args
            .get("endpoint")
            .and_then(Value::as_str)
            .ok_or("connect: endpoint")?;
        let game_id = args.get("gameId").and_then(Value::as_str).ok_or("connect: gameId")?;
        let mut opts = ConnectOptions::new(endpoint, game_id);
        opts.name = args.get("name").and_then(Value::as_str).map(str::to_string);
        if let Some(Value::Object(extra)) = args.get("options") {
            opts.options = extra.clone();
        }
        let token = args
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // The skew seam is process-wide; one driver process is one client.
        stamp::set_clock_skew_for_tests(self.skew);
        self.applied_skew = self.skew;
        let mut session = Session::connect(opts, move || Ok(token.clone()));
        for kind in &self.listening {
            session.listen(kind);
        }
        self.session = Some(session);
        self.connect_cmd = Some(cmd_id);
        Ok(())
    }

    fn leave(&mut self) {
        self.left = true;
        if let Some(s) = self.session.as_mut() {
            s.leave();
        }
        self.status = "closed";
    }

    fn tick(&mut self) {
        let Some(s) = self.session.as_mut() else { return };
        for e in s.poll() {
            match e {
                Event::Joined { session_id } => {
                    self.status = "connected";
                    if let Some(cmd) = self.connect_cmd.take() {
                        emit(json!({ "type": "joined", "sid": session_id }));
                        reply(&cmd, Ok(json!({ "sid": session_id })));
                    }
                }
                Event::JoinFailed { code, message } => {
                    self.status = "closed";
                    if let Some(cmd) = self.connect_cmd.take() {
                        reply(&cmd, Err(format!("join failed ({code}): {message}")));
                    }
                }
                Event::Reconnecting { code } => {
                    self.status = "reconnecting";
                    self.attempts += 1;
                    event("reconnecting", json!({ "attempt": self.attempts, "code": code }));
                }
                Event::Reconnected => {
                    self.status = "connected";
                    self.attempts = 0;
                    event("reconnected", json!({}));
                }
                Event::Disconnected { code, reason } => {
                    self.status = "closed";
                    if let Some(cmd) = self.connect_cmd.take() {
                        reply(&cmd, Err(format!("closed ({code}): {reason}")));
                    }
                    if !self.left {
                        event("disconnect", json!({ "code": code }));
                    }
                }
                Event::Message { kind, data } => {
                    if self.listening.contains(&kind) {
                        event("message", json!({ "type": kind, "data": data }));
                    }
                }
                Event::Chat(m) => event("chat", serde_json::to_value(m).unwrap_or(Value::Null)),
                Event::HostChanged { host } => event("hostChanged", json!({ "host": host })),
                Event::ControlResult(r) => {
                    let v = control_json(&r);
                    event("objectResult", v.clone());
                    if let Some(cmd) = self.controls.remove(&r.request_id) {
                        reply(&cmd, Ok(v));
                    }
                }
                Event::Warning { message } => eprintln!("[rust-driver] {message}"),
                _ => {}
            }
        }
    }

    fn snapshot(&self) -> Value {
        let Some(s) = self.session.as_ref() else {
            return json!({ "me": null, "status": self.status_or("idle"), "players": [], "shared": {}, "objects": [], "host": null, "isHost": false });
        };
        let players: Vec<Value> = s
            .players()
            .iter()
            .map(|p| json!({ "sid": p.id, "uid": p.uid, "name": p.name, "team": p.team, "connected": p.connected, "data": p.state_raw }))
            .collect();
        let objects: Vec<Value> = s
            .objects()
            .iter()
            .map(|o| {
                let d = if o.state_raw.is_null() {
                    json!({})
                } else {
                    o.state_raw.clone()
                };
                json!({ "id": o.id, "owner": o.owner, "seq": o.seq, "epoch": o.epoch, "d": d })
            })
            .collect();
        let me = (!s.session_id().is_empty()).then(|| s.session_id().to_string());
        json!({
            "me": me,
            "status": self.status_or("idle"),
            "players": players,
            "shared": s.shared(),
            "objects": objects,
            "host": s.host_id(),
            "isHost": s.is_host(),
        })
    }

    fn status_or(&self, idle: &'static str) -> &'static str {
        if self.status.is_empty() {
            idle
        } else {
            self.status
        }
    }

    fn sample(&self, args: &Map<String, Value>) -> Value {
        let Some(s) = self.session.as_ref() else {
            return Value::Null;
        };
        if let Some(id) = args.get("object").and_then(Value::as_str) {
            return s.object(id).map(|o| o.state.clone()).unwrap_or(Value::Null);
        }
        if let Some(sid) = args.get("sid").and_then(Value::as_str) {
            return s.player(sid).map(|p| p.state.clone()).unwrap_or(Value::Null);
        }
        Value::Null
    }
}

fn main() {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    emit(json!({
        "type": "ready",
        "contract": 1,
        "driver": "rust",
        "sdk": "genex-multiplayer",
        "sdkVersion": env!("CARGO_PKG_VERSION"),
        "protocol": genex_multiplayer::protocol::PROTOCOL_VERSION,
        "capabilities": ["skew"],
    }));
    let mut d = Driver::default();
    loop {
        loop {
            match rx.try_recv() {
                Ok(line) if line.trim().is_empty() => {}
                Ok(line) => {
                    let quit = serde_json::from_str::<Value>(&line)
                        .ok()
                        .is_some_and(|v| v.get("cmd").and_then(Value::as_str) == Some("quit"));
                    if quit {
                        let cmd_id = serde_json::from_str::<Value>(&line)
                            .ok()
                            .and_then(|v| v.get("cmdId").cloned());
                        reply(&cmd_id.unwrap_or(Value::Null), Ok(Value::Null));
                        return finish(d);
                    }
                    d.command(&line);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return finish(d),
            }
        }
        d.tick();
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Leave (if seated), give the leave frame a moment to go out, then exit.
fn finish(mut d: Driver) {
    d.leave();
    for _ in 0..25 {
        d.tick();
        std::thread::sleep(Duration::from_millis(2));
    }
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}
