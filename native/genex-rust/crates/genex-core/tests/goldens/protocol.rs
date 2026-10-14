//! `protocol.h`: NDJSON framing with the line cap, the request envelope's refusals, direct calls
//! and event lines.

use crate::support::{golden, hex, same, strings, text};
use genex_core::digest::{fnv1a64, hex64};
use genex_core::json::Value;
use genex_core::protocol::{Answer, Dispatcher, LineReader, MAX_LINE_BYTES, NextLine, event};
use std::io::Read;

/// A byte source that hands out its chunks one read at a time, however large the caller's buffer.
struct Chunks {
    chunks: Vec<Vec<u8>>,
    next: usize,
    offset: usize,
}

impl Read for Chunks {
    fn read(&mut self, into: &mut [u8]) -> std::io::Result<usize> {
        while self.next < self.chunks.len() && self.offset == self.chunks[self.next].len() {
            self.next += 1;
            self.offset = 0;
        }
        let Some(chunk) = self.chunks.get(self.next) else { return Ok(0) };
        let count = into.len().min(chunk.len() - self.offset);
        into[..count].copy_from_slice(&chunk[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

fn line_of(line: &NextLine) -> Value {
    let mut out = Value::object();
    match line {
        NextLine::TooLong => {
            out.set("status", Value::from("too-long"));
        }
        NextLine::Line(bytes) => {
            out.set("status", Value::from("line"));
            if bytes.len() <= 256 {
                out.set("hex", hex(bytes));
            } else {
                out.set("length", Value::from(bytes.len() as f64));
                out.set("digest", Value::from(hex64(fnv1a64(bytes))));
            }
        }
        NextLine::End => panic!("End is not a line"),
    }
    out
}

/// protocol_test.cpp's dispatcher, plus `echo`, which answers its argument.
fn dispatcher() -> Dispatcher {
    let mut calls = Dispatcher::default();
    calls.on("state", |_| Answer::Result(Value::object()));
    calls.on("seed", |arg| {
        let mut result = Value::object();
        result.set("seed", Value::from(arg["seed"].as_f64()));
        Answer::Result(result)
    });
    calls.on("demo", |_| Answer::Refused("no-such-demo".to_owned()));
    calls.on("echo", |arg| Answer::Result(arg.clone()));
    calls
}

#[test]
fn framing_yields_the_same_lines() {
    let cases = golden!("protocol");
    for case in cases["framing"].items() {
        let chunks = Chunks { chunks: case["chunks"].items().iter().map(text).collect(), next: 0, offset: 0 };
        let cap = case.get("cap").map_or(MAX_LINE_BYTES, |cap| cap.as_f64() as usize);
        let mut reader = LineReader::with_cap(chunks, cap);
        let mut lines = Value::array();
        loop {
            let next = reader.next_line();
            if next == NextLine::End {
                break;
            }
            lines.push(line_of(&next));
        }
        let context = format!("framing {:?}", case["name"]);
        same(&lines, &case["lines"], &context);
        same(&Value::from(reader.next_line() == NextLine::End), &case["endStays"], &context);
    }
}

#[test]
fn requests_get_the_same_reply_bytes() {
    let cases = golden!("protocol");
    let calls = dispatcher();
    for case in cases["handle"].items() {
        let reply = calls.handle(&text(&case["line"]));
        same(&hex(&reply), &case["reply"], &format!("handle {:?}", case["line"]));
    }
    same(&Value::String(calls.line_too_long()), &cases["lineTooLong"], "line too long");
    same(&strings(&calls.ops()), &cases["ops"], "ops");
    for case in cases["call"].items() {
        let reply = calls.call(case["op"].as_str(), &case["arg"]);
        same(&Value::String(reply), &case["reply"], &format!("call {case:?}"));
    }
}

#[test]
fn events_are_written_the_same() {
    let cases = golden!("protocol");
    for case in cases["events"].items() {
        let line = event(case["name"].as_str(), &case["fields"]);
        same(&Value::String(line), &case["line"], &format!("event {case:?}"));
    }
}
