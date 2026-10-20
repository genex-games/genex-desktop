//! The §8 reconnect contract against a local relay, through an in-process TCP proxy that can cut
//! every connection (an abnormal 1006 close, like a network drop):
//! the SDK reconnects in place, the seat and session id survive, a control request made while
//! offline is resent with its original requestId and answered, and the peer sees the player again.
//! Three outages: a plain cut; a link that ends every handshake with an EOF (the native-core stall
//! the crate takes over from); and a link that refuses connections and heals during the core's
//! 1.75 s attempt over a 300 ms round trip, which the core must finish on its own.
//!
//! ```sh
//! GENEX_RELAY_URL=ws://127.0.0.1:2711 cargo run --example reconnect
//! ```
use genex_multiplayer::{ConnectOptions, Event, Session};
use serde_json::json;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const OPEN: u8 = 0;
/// Accept, then close at once: the client sees an EOF in the middle of its handshake.
const EOF: u8 = 1;
/// No listener at all: every connect is refused on the spot.
const REFUSE: u8 = 2;

/// A dumb TCP forwarder with an optional one-way delay (the test's own scaffolding; the SDK
/// itself never spawns a thread).
struct Proxy {
    port: u16,
    live: Arc<Mutex<Vec<TcpStream>>>,
    mode: Arc<AtomicU8>,
}

impl Proxy {
    fn start(upstream: String, one_way_delay: Duration) -> Proxy {
        let first = TcpListener::bind("127.0.0.1:0").expect("bind proxy");
        let port = first.local_addr().unwrap().port();
        let live: Arc<Mutex<Vec<TcpStream>>> = Arc::default();
        let reg = live.clone();
        let mode = Arc::new(AtomicU8::new(OPEN));
        let m = mode.clone();
        std::thread::spawn(move || {
            let mut listener = Some(first);
            loop {
                let now_mode = m.load(Ordering::SeqCst);
                if now_mode == REFUSE {
                    listener = None;
                } else if listener.is_none() {
                    listener = TcpListener::bind(("127.0.0.1", port)).ok();
                }
                let Some(l) = &listener else {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                };
                l.set_nonblocking(true).unwrap();
                let client = match l.accept() {
                    Ok((c, _)) => c,
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(_) => continue,
                };
                client.set_nonblocking(false).unwrap();
                if now_mode == EOF {
                    let _ = client.shutdown(Shutdown::Both);
                    continue;
                }
                let Ok(server) = TcpStream::connect(&upstream) else {
                    continue;
                };
                let _ = client.set_nodelay(true);
                let _ = server.set_nodelay(true);
                let mut reg = reg.lock().unwrap();
                reg.push(client.try_clone().unwrap());
                reg.push(server.try_clone().unwrap());
                for (mut from, mut to) in [
                    (client.try_clone().unwrap(), server.try_clone().unwrap()),
                    (server, client),
                ] {
                    // reader -> (timestamped chunks) -> writer, so every byte and the EOF arrive
                    // `one_way_delay` late without slowing the stream down.
                    let (tx, rx) = mpsc::channel::<(Instant, Vec<u8>)>();
                    std::thread::spawn(move || {
                        let mut buf = [0u8; 16 * 1024];
                        loop {
                            let n = from.read(&mut buf).unwrap_or(0);
                            if tx.send((Instant::now() + one_way_delay, buf[..n].to_vec())).is_err() || n == 0 {
                                break;
                            }
                        }
                    });
                    std::thread::spawn(move || {
                        for (due, chunk) in rx {
                            let wait = due.saturating_duration_since(Instant::now());
                            if !wait.is_zero() {
                                std::thread::sleep(wait);
                            }
                            if chunk.is_empty() || to.write_all(&chunk).is_err() {
                                break;
                            }
                        }
                        let _ = to.shutdown(Shutdown::Both);
                    });
                }
            }
        });
        Proxy { port, live, mode }
    }

    fn set_mode(&self, mode: u8) {
        self.mode.store(mode, Ordering::SeqCst);
    }

    /// Cut every open connection without a WebSocket close frame (the client sees 1006).
    fn cut(&self) {
        for s in self.live.lock().unwrap().drain(..) {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => {
            println!("RECONNECT OK");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("RECONNECT FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn pump(
    sessions: &mut [&mut Session],
    what: &str,
    timeout_ms: u64,
    mut done: impl FnMut(&[&mut Session], &[Event]) -> bool,
) -> Result<Vec<Event>, String> {
    let start = Instant::now();
    let mut seen = Vec::new();
    while start.elapsed() < Duration::from_millis(timeout_ms) {
        for s in sessions.iter_mut() {
            seen.extend(s.poll());
        }
        if let Some(Event::Disconnected { code, reason }) =
            seen.iter().find(|e| matches!(e, Event::Disconnected { .. }))
        {
            return Err(format!("{what}: disconnected {code} {reason}"));
        }
        if done(sessions, &seen) {
            println!("ok  {what} ({} ms)", start.elapsed().as_millis());
            return Ok(seen);
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    Err(format!("{what}: timed out after {timeout_ms} ms; events: {seen:?}"))
}

fn run() -> Result<(), String> {
    let url = std::env::var("GENEX_RELAY_URL").unwrap_or_else(|_| "ws://127.0.0.1:2711".into());
    let upstream = url.trim_start_matches("ws://").trim_end_matches('/').to_string();
    let proxy = Proxy::start(upstream.clone(), Duration::ZERO);
    let via_proxy = format!("ws://127.0.0.1:{}", proxy.port);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let game = format!("rust-reconnect-{nonce}");
    let identity = || Ok::<_, String>("local-test-token".to_string());

    // `a` goes through the proxy; `b` (the observer) connects directly.
    let (mut a, _) = Session::connect_blocking(ConnectOptions::new(&via_proxy, &game).name("flaky"), identity, 10_000)
        .map_err(|e| format!("a join: {e}"))?;
    let (mut b, _) = Session::connect_blocking(ConnectOptions::new(&url, &game).name("observer"), identity, 10_000)
        .map_err(|e| format!("b join: {e}"))?;
    let sid = a.session_id().to_string();
    a.set_me(json!({ "x": 1.0 })).map_err(|e| e.to_string())?;
    pump(&mut [&mut a, &mut b], "observer sees the flaky player", 5000, |s, _| {
        s[1].player(&sid).is_some_and(|p| p.state_raw["x"] == 1.0)
    })?;

    // Drop the network. The SDK reports the drop and reconnects in place.
    proxy.cut();
    let events = pump(&mut [&mut a, &mut b], "drop detected", 5000, |_, ev| {
        ev.iter().any(|e| matches!(e, Event::Reconnecting { .. }))
    })?;
    let code = events.iter().find_map(|e| {
        if let Event::Reconnecting { code } = e {
            Some(*code)
        } else {
            None
        }
    });
    println!(
        "    reconnecting (close {code:?}); a.is_host={} a.is_connected={}",
        a.is_host(),
        a.is_connected()
    );
    if a.is_host() || a.is_connected() {
        return Err("host duty and connectivity must stop the moment the socket drops".into());
    }
    // A control request made while offline stays pending and is resent after the reconnect.
    let rid = a.claim("crate").map_err(|e| e.to_string())?;
    let events = pump(
        &mut [&mut a, &mut b],
        "reconnected and the offline claim answered",
        15_000,
        |s, ev| {
            ev.iter().any(|e| matches!(e, Event::Reconnected))
                && ev
                    .iter()
                    .any(|e| matches!(e, Event::ControlResult(r) if r.request_id == rid && r.accepted))
                && s[0].owns("crate")
        },
    )?;
    let order: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            Event::Reconnected => Some("reconnected"),
            Event::ControlResult(_) => Some("result"),
            _ => None,
        })
        .collect();
    println!("    order: {order:?}");
    if a.session_id() != sid {
        return Err(format!(
            "session id changed across reconnect: {sid} -> {}",
            a.session_id()
        ));
    }
    a.set_me(json!({ "x": 2.0 })).map_err(|e| e.to_string())?;
    pump(
        &mut [&mut a, &mut b],
        "observer sees post-reconnect state on the same seat",
        5000,
        |s, _| {
            s[1].player(&sid)
                .is_some_and(|p| p.state_raw["x"] == 2.0 && p.connected)
                && s[1]
                    .object("crate")
                    .is_some_and(|o| o.owner.as_deref() == Some(sid.as_str()))
        },
    )?;

    // A longer outage: the link ends every handshake with an EOF for a while, then heals. The
    // core's attempt stalls on that EOF; the crate sees it stuck and re-takes the same seat.
    proxy.set_mode(EOF);
    proxy.cut();
    pump(&mut [&mut a, &mut b], "EOF-link drop detected", 5000, |_, ev| {
        ev.iter().any(|e| matches!(e, Event::Reconnecting { .. }))
    })?;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(900) {
        a.poll();
        b.poll();
        std::thread::sleep(Duration::from_millis(8));
    }
    proxy.set_mode(OPEN);
    pump(
        &mut [&mut a, &mut b],
        "reconnected after the link healed",
        15_000,
        |s, ev| ev.iter().any(|e| matches!(e, Event::Reconnected)) && s[0].session_id() == sid && s[0].is_connected(),
    )?;

    // The link refuses connections, then heals just before the core's third attempt (1.75 s
    // after the drop) over a 300 ms round trip, so that attempt is still waiting for its upgrade
    // and JOIN_ROOM well past 2 s. The core must finish it itself: nothing may abandon or leave
    // that room, or the relay tears the seat down (§8) and the session ends with 4003.
    let slow = Proxy::start(upstream, Duration::from_millis(150));
    let via_slow = format!("ws://127.0.0.1:{}", slow.port);
    let (mut c, _) = Session::connect_blocking(ConnectOptions::new(&via_slow, &game).name("slow"), identity, 10_000)
        .map_err(|e| format!("c join: {e}"))?;
    let csid = c.session_id().to_string();
    // A state round trip through the slow link also proves the relay has c's JOIN_ROOM
    // acknowledgement (sent before that state): a cut before it would lose the seat by design (§8).
    c.set_me(json!({ "x": 3.0 })).map_err(|e| e.to_string())?;
    pump(
        &mut [&mut c, &mut b],
        "observer sees the slow player's state",
        5000,
        |s, _| s[1].player(&csid).is_some_and(|p| p.state_raw["x"] == 3.0),
    )?;
    slow.set_mode(REFUSE);
    slow.cut();
    let cut_at = Instant::now();
    let mut seen = pump(&mut [&mut c, &mut b], "slow drop detected", 5000, |_, ev| {
        ev.iter().any(|e| matches!(e, Event::Reconnecting { .. }))
    })?;
    while cut_at.elapsed() < Duration::from_millis(1650) {
        seen.extend(c.poll());
        b.poll();
        std::thread::sleep(Duration::from_millis(8));
    }
    slow.set_mode(OPEN);
    seen.extend(pump(
        &mut [&mut c, &mut b],
        "reconnected on the core's own attempt",
        10_000,
        |s, ev| ev.iter().any(|e| matches!(e, Event::Reconnected)) && s[0].session_id() == csid && s[0].is_connected(),
    )?);
    let outage = cut_at.elapsed().as_millis();
    println!("    outage {outage} ms");
    if let Some(w) = seen
        .iter()
        .find(|e| matches!(e, Event::Warning { message } if message.contains("re-taking")))
    {
        return Err(format!("the crate took over a reconnect the core was finishing: {w:?}"));
    }
    if outage > 3500 {
        return Err(format!(
            "expected the core's 1.75 s attempt to land, but the outage lasted {outage} ms"
        ));
    }
    pump(
        &mut [&mut c, &mut b],
        "observer sees the slow player back on the same seat",
        5000,
        |s, _| s[1].player(&csid).is_some_and(|p| p.connected),
    )?;

    a.leave();
    b.leave();
    c.leave();
    let start = Instant::now();
    while !(a.is_closed() && b.is_closed() && c.is_closed()) && start.elapsed() < Duration::from_secs(3) {
        a.poll();
        b.poll();
        c.poll();
        std::thread::sleep(Duration::from_millis(8));
    }
    Ok(())
}
