//! `clock.h`: `stepTicks`, `FrameClock` and `FpsMeter`.

use crate::support::{bits, golden, real, same};
use genex_core::clock::{FIXED_STEP_MS, FpsMeter, FrameClock, step_ticks};
use genex_core::json::Value;

#[test]
fn step_ticks_round_and_clamp_as_the_cpp_does() {
    let cases = golden!("clock");
    for case in cases["stepTicks"].items() {
        let ticks = step_ticks(real(&case["ms"]), real(&case["stepMs"]));
        same(&Value::from(ticks), &case["ticks"], &format!("stepTicks {case:?}"));
    }
}

#[test]
fn frame_clocks_carry_the_same_remainder() {
    let cases = golden!("clock");
    assert!(cases["frameClocks"].items().len() > 6, "the generated clocks are in the golden");
    for case in cases["frameClocks"].items() {
        let mut clock = FrameClock::new(real(&case["stepMs"]));
        let reset_at = case["resetAt"].as_f64();
        let mut ticks = Value::array();
        let mut carry = Value::array();
        for (i, frame) in case["frames"].items().iter().enumerate() {
            if i as f64 == reset_at {
                clock.reset();
            }
            ticks.push(Value::from(clock.advance(real(frame))));
            carry.push(bits(clock.carry()));
        }
        same(&ticks, &case["ticks"], &format!("frame clock ticks {:?}", case["frames"]));
        same(&carry, &case["carry"], &format!("frame clock carry {:?}", case["frames"]));
    }
}

#[test]
fn fps_meters_average_the_same_window() {
    let cases = golden!("clock");
    for case in cases["fpsMeters"].items() {
        let mut meter = FpsMeter::default();
        let reset_at = case["resetAt"].as_f64();
        let mut fps = Value::array();
        for (i, now) in case["times"].items().iter().enumerate() {
            if i as f64 == reset_at {
                meter.reset();
            }
            meter.frame(real(now));
            fps.push(bits(meter.fps()));
        }
        same(&fps, &case["fps"], &format!("fps meter {:?}", case["times"]));
    }
}

#[test]
fn the_fixed_step_is_one_sixtieth_of_a_second() {
    assert_eq!(FIXED_STEP_MS.to_bits(), (1000.0_f64 / 60.0).to_bits());
}
