//! Two sessions against a local relay: join, publish state, see the peer (interpolated), claim an
//! object and publish it, exchange a game event and a chat line, hand the object over, leave.
//!
//! ```sh
//! GENEX_RELAY_URL=ws://127.0.0.1:2711 cargo run --example smoke
//! ```
//! The relay must accept any token (the netcode-bench `bootRelay`, see README). Exits 0 on success.
use genex_multiplayer::{ConnectOptions, ControlResult, Event, Session};
use serde_json::{json, Value};
use std::process::ExitCode;
use std::time::{Duration, Instant};

fn main() -> ExitCode {
    match run() {
        Ok(()) => {
            println!("SMOKE OK");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("SMOKE FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Poll both sessions until `done` holds, collecting each one's events.
fn pump(
    a: &mut Session,
    b: &mut Session,
    what: &str,
    timeout_ms: u64,
    mut done: impl FnMut(&Session, &Session, &[Event], &[Event]) -> bool,
) -> Result<(Vec<Event>, Vec<Event>), String> {
    let start = Instant::now();
    let (mut ea, mut eb) = (Vec::new(), Vec::new());
    while start.elapsed() < Duration::from_millis(timeout_ms) {
        ea.extend(a.poll());
        eb.extend(b.poll());
        for e in ea.iter().chain(eb.iter()) {
            if let Event::Disconnected { code, reason } = e {
                if *code != 4000 {
                    return Err(format!("{what}: disconnected {code} {reason}"));
                }
            }
            if let Event::Warning { message } = e {
                eprintln!("  warning: {message}");
            }
        }
        if done(a, b, &ea, &eb) {
            println!("ok  {what} ({} ms)", start.elapsed().as_millis());
            return Ok((ea, eb));
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    Err(format!("{what}: timed out after {timeout_ms} ms"))
}

fn result_for<'a>(events: &'a [Event], request_id: &str) -> Option<&'a ControlResult> {
    events.iter().find_map(|e| match e {
        Event::ControlResult(r) if r.request_id == request_id => Some(r),
        _ => None,
    })
}

fn x_of(v: &Value) -> Option<f64> {
    v.get("x").and_then(Value::as_f64)
}

fn run() -> Result<(), String> {
    let url = std::env::var("GENEX_RELAY_URL").unwrap_or_else(|_| "ws://127.0.0.1:2711".into());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let game = format!("rust-smoke-{nonce}");
    // The bench relay accepts any token; a real app returns a fresh embed token here (README §Identity).
    let identity = || Ok::<_, String>("local-test-token".to_string());

    let (mut a, _) = Session::connect_blocking(ConnectOptions::new(&url, &game).name("rust-a"), identity, 10_000)
        .map_err(|e| format!("a join: {e}"))?;
    println!("ok  a joined as {} on {}", a.session_id(), a.endpoint().unwrap_or("?"));
    let (mut b, _) = Session::connect_blocking(ConnectOptions::new(&url, &game).name("rust-b"), identity, 10_000)
        .map_err(|e| format!("b join: {e}"))?;
    println!("ok  b joined as {} (room {})", b.session_id(), b.room_id());
    if a.room_id() != b.room_id() {
        return Err(format!("different rooms: {} vs {}", a.room_id(), b.room_id()));
    }
    let (sa, sb) = (a.session_id().to_string(), b.session_id().to_string());

    // 0. Several relay URLs: the lowest-latency reachable one is chosen (§3.1).
    let mut multi = ConnectOptions::new(&url, format!("{game}-latency"));
    multi.endpoints = vec!["ws://127.0.0.1:9".into(), url.clone()];
    let (m, _) = Session::connect_blocking(multi, identity, 10_000).map_err(|e| format!("multi join: {e}"))?;
    if m.endpoint() != Some(url.as_str()) {
        return Err(format!("latency selection picked {:?}", m.endpoint()));
    }
    println!("ok  latency selection skipped the dead relay and joined {}", url);
    drop(m);

    // 1. Both see each other, with names and uids from the relay.
    a.set_me(json!({ "x": 0.0, "label": "a" })).map_err(|e| e.to_string())?;
    b.set_me(json!({ "x": 100.0, "label": "b" }))
        .map_err(|e| e.to_string())?;
    pump(&mut a, &mut b, "peers see each other's state", 5000, |a, b, _, _| {
        let pa = b
            .player(&sa)
            .map(|p| x_of(&p.state_raw) == Some(0.0) && p.name == "rust-a" && !p.uid.is_empty());
        let pb = a
            .player(&sb)
            .map(|p| x_of(&p.state_raw) == Some(100.0) && p.state["label"] == "b");
        pa == Some(true) && pb == Some(true)
    })?;
    if b.player(&sa).unwrap().state_raw.get("__t").is_some() {
        return Err("__t leaked into game state".into());
    }

    // 2. Host: exactly one of the two, and it is the earliest joiner.
    pump(&mut a, &mut b, "host elected", 3000, |a, b, _, _| {
        a.host_id().is_some() && a.host_id() == b.host_id()
    })?;
    println!(
        "    host = {} (a.is_host={}, b.is_host={})",
        a.host_id().unwrap_or("-"),
        a.is_host(),
        b.is_host()
    );
    if a.is_host() == b.is_host() {
        return Err("exactly one session must be host".into());
    }

    // 3. Interpolation: a moves x 0→100 over ~1 s at the 20 Hz tick; b's smoothed view lags the raw
    //    view and never runs backwards.
    let start = Instant::now();
    let mut last_smoothed = f64::MIN;
    let mut lag_seen = false;
    let mut monotonic = true;
    let mut next_tick = Duration::ZERO;
    while start.elapsed() < Duration::from_millis(1400) {
        // The game's own fixed 20 Hz network tick (§6.1); rendering polls every frame.
        if start.elapsed() >= next_tick {
            next_tick += Duration::from_millis(50);
            let t = start.elapsed().as_secs_f64().min(1.0);
            a.set_me(json!({ "x": t * 100.0, "label": "a" }))
                .map_err(|e| e.to_string())?;
        }
        a.poll();
        b.poll();
        if let Some(p) = b.player(&sa) {
            if let (Some(s), Some(r)) = (x_of(&p.state), x_of(&p.state_raw)) {
                if s < last_smoothed - 1e-6 {
                    monotonic = false;
                }
                last_smoothed = s;
                if r - s > 1.0 {
                    lag_seen = true;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    pump(
        &mut a,
        &mut b,
        "remote converges to the final position",
        2000,
        |_, b, _, _| {
            b.player(&sa)
                .and_then(|p| x_of(&p.state))
                .is_some_and(|x| (x - 100.0).abs() < 0.5)
        },
    )?;
    if !monotonic || !lag_seen {
        return Err(format!("interpolation: monotonic={monotonic} lag_seen={lag_seen}"));
    }
    println!("ok  remote motion interpolated (smoothed lags raw, never reverses)");

    // 4. Object: a claims, publishes; b sees owner + state.
    let rid = a.claim("ball").map_err(|e| e.to_string())?;
    let (ea, _) = pump(&mut a, &mut b, "claim answered", 3000, |_, _, ea, _| {
        result_for(ea, &rid).is_some()
    })?;
    let r = result_for(&ea, &rid).unwrap();
    if !r.accepted || r.owner.as_deref() != Some(sa.as_str()) || r.sequence < 1.0 {
        return Err(format!("claim result {r:?}"));
    }
    a.set_object("ball", json!({ "x": 5.0, "color": "red" }))
        .map_err(|e| e.to_string())?;
    pump(&mut a, &mut b, "peer sees the owned object", 3000, |_, b, _, _| {
        b.object("ball")
            .is_some_and(|o| o.owner.as_deref() == Some(sa.as_str()) && x_of(&o.state_raw) == Some(5.0))
    })?;
    if b.set_object("ball", json!({ "x": 9 })).is_ok() {
        return Err("a non-owner write must be refused locally".into());
    }

    // 5. Game event: b receives a's event, a does not get its own back.
    a.send("ping", &json!({ "n": 1, "big": 1u64 << 40 }))
        .map_err(|e| e.to_string())?;
    let (ea, eb) = pump(&mut a, &mut b, "game event delivered", 3000, |_, _, _, eb| {
        eb.iter()
            .any(|e| matches!(e, Event::Message { kind, .. } if kind == "ping"))
    })?;
    let got = eb.iter().find_map(|e| match e {
        Event::Message { kind, data } if kind == "ping" => Some(data.clone()),
        _ => None,
    });
    if got != Some(json!({ "n": 1, "big": (1u64 << 40) as f64 })) {
        return Err(format!("event payload {got:?}"));
    }
    if ea
        .iter()
        .any(|e| matches!(e, Event::Message { kind, .. } if kind == "ping"))
    {
        return Err("sender received its own game event".into());
    }
    if a.send("claim", &json!({})).is_ok() {
        return Err("a reserved type must be refused".into());
    }

    // 6. Chat: echoed to everyone, sender included.
    a.chat_send("hello from rust").map_err(|e| e.to_string())?;
    pump(&mut a, &mut b, "chat echoed to both", 3000, |a, b, _, _| {
        let has = |s: &Session| {
            s.chat_messages()
                .iter()
                .any(|m| m.text == "hello from rust" && m.name == "rust-a")
        };
        has(a) && has(b)
    })?;

    // 7. Handoff: after the 300 ms minimum hold, b claims the ball; a sees it go.
    std::thread::sleep(Duration::from_millis(350));
    let rid = b.claim("ball").map_err(|e| e.to_string())?;
    let (_, eb) = pump(&mut a, &mut b, "handoff to b", 3000, |a, _, _, eb| {
        result_for(eb, &rid).is_some()
            && a.object("ball")
                .is_some_and(|o| o.owner.as_deref() == Some(sb.as_str()))
    })?;
    let r = result_for(&eb, &rid).unwrap();
    if !r.accepted {
        return Err(format!("handoff claim {r:?}"));
    }
    b.set_object("ball", json!({ "x": 7.0 })).map_err(|e| e.to_string())?;
    pump(
        &mut a,
        &mut b,
        "new owner's state reaches the old owner",
        3000,
        |a, _, _, _| a.object("ball").is_some_and(|o| x_of(&o.state_raw) == Some(7.0)),
    )?;
    let rid = b.destroy("ball").map_err(|e| e.to_string())?;
    pump(&mut a, &mut b, "object destroyed", 3000, |a, _, _, eb| {
        result_for(eb, &rid).is_some_and(|r| r.accepted && r.operation == "remove") && a.object("ball").is_none()
    })?;

    // 8. Shared map.
    a.set_shared("round", &json!({ "n": 3 })).map_err(|e| e.to_string())?;
    pump(&mut a, &mut b, "shared value", 3000, |_, b, _, _| {
        b.shared_get("round") == Some(json!({ "n": 3 }))
    })?;

    // 9. Server clock, when the relay publishes it (RELAY_CLOCK=on).
    if a.has_server_clock() {
        pump(&mut a, &mut b, "clock rtt measured", 5000, |a, _, _, _| {
            a.rtt().is_some() && a.server_now().is_some()
        })?;
        println!(
            "    clock: server_now={:.0} ms, rtt={:.1} ms, origin={:.0}",
            a.server_now().unwrap(),
            a.rtt().unwrap(),
            a.clock_origin()
        );
        pump(
            &mut a,
            &mut b,
            "clock synced (30 acked heartbeats)",
            8000,
            |a, b, _, _| a.clock_synced() && b.clock_synced(),
        )?;
        let deadline = a.clock_origin() + a.server_now().unwrap() + 1000.0;
        let until = a.ms_until(deadline);
        println!("    ms_until(+1000 ms on the server clock) = {until:.1}");
        if (until - 1000.0).abs() > 50.0 {
            return Err(format!("ms_until drifted: {until}"));
        }
    } else {
        println!("    clock: relay does not publish its clock (heartbeats off, as §16.2 requires)");
    }

    // 9b. Typed pose (§6.6, opt-in): a posing client's pose keys reach b as a posed player.
    let mut opts = ConnectOptions::new(&url, &game).name("rust-pose");
    opts.pose = true;
    let (mut c, _) = Session::connect_blocking(opts, identity, 10_000).map_err(|e| format!("c join: {e}"))?;
    let sc = c.session_id().to_string();
    c.set_me(json!({ "x": 3.0, "y": 4.0, "yaw": 0.5, "anim": "run", "label": "c" }))
        .map_err(|e| e.to_string())?;
    pump(
        &mut c,
        &mut b,
        "posed player seen with pose merged over data",
        3000,
        |_, b, _, _| {
            b.player(&sc).is_some_and(|p| {
                p.posed
                    && x_of(&p.state_raw) == Some(3.0)
                    && p.state_raw["anim"] == "run"
                    && p.state_raw["label"] == "c"
                    && (p.state_raw["vx"].as_f64() == Some(0.0))
            })
        },
    )?;
    for i in 1..=10 {
        c.set_me(json!({ "x": 3.0 + i as f64, "y": 4.0, "yaw": 0.5, "anim": "run", "label": "c" }))
            .map_err(|e| e.to_string())?;
        for _ in 0..7 {
            c.poll();
            b.poll();
            std::thread::sleep(Duration::from_millis(8));
        }
    }
    pump(
        &mut c,
        &mut b,
        "pose velocity derived and interpolated",
        3000,
        |_, b, _, _| {
            b.player(&sc).is_some_and(|p| {
                x_of(&p.state_raw) == Some(13.0)
                    && p.state_raw["vx"].as_f64().is_some_and(|v| v > 1.0)
                    && x_of(&p.state).is_some_and(|x| (x - 13.0).abs() < 0.5)
            })
        },
    )?;
    c.leave();

    // 10. b leaves with consent; a sees it go; then a leaves.
    b.leave();
    pump(&mut a, &mut b, "peer leaves", 5000, |a, _, _, eb| {
        a.player(&sb).is_none() && eb.iter().any(|e| matches!(e, Event::Disconnected { code: 4000, .. }))
    })?;
    a.leave();
    let start = Instant::now();
    while !a.is_closed() && start.elapsed() < Duration::from_secs(3) {
        a.poll();
        std::thread::sleep(Duration::from_millis(8));
    }
    if !a.is_closed() {
        return Err("a did not close after leave()".into());
    }
    println!("ok  both left with consent");
    Ok(())
}
