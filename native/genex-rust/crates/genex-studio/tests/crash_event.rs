//! The crash event (CRASH-2) over a real socket pair: once `report_crashes` is installed, a panic
//! sends one `crash` event carrying the `genex-crash/1` record, then the `fatal` event it sent
//! before; installing again changes nothing. The hook is the process's, so the rows share one
//! install in this test binary. Unix only, as the transport rows.
#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixStream;
use std::sync::Arc;

use genex_core::json::{self, Value};
use genex_core::protocol::Event;
use genex_crash::{CRASH_FORMAT, Installed};
use genex_studio::{SocketChannel, Transport, report_crashes};

fn read_line(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).expect("a line from the game");
    json::parse(line.trim_end().as_bytes()).expect("JSON")
}

#[test]
fn a_panic_sends_its_crash_record_then_fatal_and_a_second_install_changes_nothing() {
    let (game, host) = UnixStream::pair().expect("socket pair");
    let channel = SocketChannel::new(game).expect("socket channel");
    let link = Arc::new(Transport::new(Arc::new(channel), "n0nce".to_owned()));
    assert_eq!(report_crashes(Arc::clone(&link), Vec::new()), Installed::Now);
    let mut reader = BufReader::new(host);

    let panicked = std::thread::Builder::new()
        .name("crash-row".into())
        .spawn(|| panic!("crash-2 transport row"))
        .expect("a thread")
        .join();
    assert!(panicked.is_err());

    let crash = read_line(&mut reader);
    assert_eq!(crash["event"].as_str(), Event::CRASH, "crash first: {}", String::from_utf8_lossy(&crash.dump()));
    let record = &crash["record"];
    assert_eq!(record["format"].as_str(), CRASH_FORMAT);
    assert_eq!(record["kind"].as_str(), "panic");
    assert_eq!(record["message"].as_str(), "crash-2 transport row");
    assert_eq!(record["thread"]["name"].as_str(), "crash-row");
    assert!(record["fatal"].as_bool());
    let fatal = read_line(&mut reader);
    assert_eq!(fatal["event"].as_str(), Event::FATAL, "then fatal, as before");
    assert_eq!(fatal["reason"].as_str(), "terminate");

    assert_eq!(report_crashes(link, Vec::new()), Installed::Already, "installed once per process");
}
