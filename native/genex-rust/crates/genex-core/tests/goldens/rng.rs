//! `rng.h`: the PCG32 stream, its bounded draws and its floats.

use crate::support::{float_bits, golden, real32, same, u64_of};
use genex_core::json::Value;
use genex_core::rng::{DEFAULT_SEQUENCE, Pcg32};

#[test]
fn pcg32_matches_the_reference_demo() {
    // pcg32-demo: pcg32_srandom_r(&rng, 42, 54), then six draws (session_test.cpp's `pcg32` row).
    let mut rng = Pcg32::new(42, 54);
    let expected = [0xa15c02b7_u32, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e];
    for value in expected {
        assert_eq!(rng.next_u32(), value);
    }
}

#[test]
fn every_stream_draws_what_the_cpp_drew() {
    let cases = golden!("rng");
    for stream in cases["streams"].items() {
        let mut rng = match stream.get("seed") {
            Some(seed) => {
                let sequence = stream.get("sequence").map_or(DEFAULT_SEQUENCE, u64_of);
                Pcg32::new(u64_of(seed), sequence)
            }
            None => Pcg32::default(),
        };
        let mut results = Value::array();
        for op in stream["ops"].items() {
            let args = op.items();
            let count = |at: usize| args[at].as_f64() as usize;
            let draws: Vec<Value> = match args[0].as_str() {
                "reseed" => {
                    rng.reseed(u64_of(&args[1]), args.get(2).map_or(DEFAULT_SEQUENCE, u64_of));
                    Vec::new()
                }
                "next" => (0..count(1)).map(|_| Value::from(rng.next_u32())).collect(),
                "below" => {
                    let bound = u64_of(&args[1]) as u32;
                    (0..count(2)).map(|_| Value::from(rng.below(bound))).collect()
                }
                "nextInt" => {
                    let (lo, hi) = (args[1].as_f64() as i32, args[2].as_f64() as i32);
                    (0..count(3)).map(|_| Value::from(rng.range_i32(lo, hi))).collect()
                }
                "unit" => (0..count(1)).map(|_| float_bits(rng.unit())).collect(),
                "nextFloat" => {
                    let (lo, hi) = (real32(&args[1]), real32(&args[2]));
                    (0..count(3)).map(|_| float_bits(rng.range_f32(lo, hi))).collect()
                }
                "chance" => {
                    let p = real32(&args[1]);
                    (0..count(2)).map(|_| Value::from(rng.chance(p))).collect()
                }
                other => panic!("unknown rng op {other}"),
            };
            results.push(Value::Array(draws));
        }
        same(&results, &stream["results"], &format!("rng stream {:?}", stream["ops"]));
    }
}
