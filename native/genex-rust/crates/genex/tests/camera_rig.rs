//! `genex::camera::FirstPersonRig` (review WP-3, LOC-1..6): a deterministic comfort probe on a
//! sprint run. The gen3 bodycam shipped a 7.5 Hz cusped bob of 8.9 cm with ±5.8° of roll because
//! the template's examples taught a fixed stride and `|cos(2·phase)|` and nothing measured motion
//! over time. These rows measure the rig the way a comfort check reads a run: per-tick camera poses,
//! bob peak to peak, roll, the bob's dominant frequency and its energy above 6 Hz.

use genex::camera::{Comfort, FirstPersonRig, RigStep};
use genex::prelude::*;

const DT: f32 = 1.0 / 60.0;
const EYE_HEIGHT: f32 = 1.6;
const SPRINT: f32 = 5.5;
const WALK: f32 = 3.0;
/// The review's proposed acceptance: sprint bob ≤3 cm, bob roll ≤1.5°, all roll ≤2°, the bob's
/// dominant frequency below 3 Hz, near-zero energy above 6 Hz, a sprint field of view kick ≤5°.
const BOB_CAP_M: f32 = 0.03;
const ROLL_CAP_DEG: f32 = 1.5;
const ROLL_TOTAL_CAP_DEG: f32 = 2.0;
const DOMINANT_CAP_HZ: f32 = 3.0;
const HIGH_HZ: f32 = 6.0;
const HIGH_ENERGY_CAP: f32 = 0.01;
const FOV_KICK_CAP_DEG: f32 = 5.0;
const BASE_FOVY: f32 = 72.0;

/// One tick of the camera, measured against the body's own eye.
#[derive(Clone, Copy, Debug)]
struct Sample {
    /// The eye's height over the body's eye, metres.
    lift: f32,
    /// The view's roll, degrees.
    roll: f32,
    /// The view's pitch, degrees.
    pitch: f32,
    fovy: f32,
}

/// The camera's offsets from an eye at `eye` looking along -z.
fn sample(camera: &Camera, eye: Vec3) -> Sample {
    let forward = (camera.target - camera.position).normalize();
    let right = forward.cross(Vec3::Y).normalize();
    let level_up = right.cross(forward);
    let roll = genex::math::atan2(camera.up.dot(right), camera.up.dot(level_up)).to_degrees();
    Sample { lift: camera.position.y - eye.y, roll, pitch: genex::math::asin(forward.y).to_degrees(), fovy: camera.fovy }
}

/// A body run along -z: `speed(t)` m/s on the ground, turning `turn(t)` radians a tick; the rig
/// advanced and its camera sampled every tick under `comfort`.
fn run(seconds: f32, speed: impl Fn(f32) -> f32, turn: impl Fn(f32) -> f32, comfort: &Comfort) -> Vec<Sample> {
    let mut rig = FirstPersonRig::new().with_speeds(WALK, SPRINT);
    let mut z = 0.0;
    let ticks = (seconds / DT) as usize;
    (0..ticks)
        .map(|tick| {
            let t = tick as f32 * DT;
            let velocity = vec3(0.0, 0.0, -speed(t));
            z += velocity.z * DT;
            rig.update(DT, RigStep { velocity, turn: turn(t), grounded: true, walked: speed(t) * DT, ..RigStep::default() });
            let eye = vec3(0.0, EYE_HEIGHT, z);
            sample(&rig.camera_with(eye, Vec3::NEG_Z, BASE_FOVY, comfort), eye)
        })
        .collect()
}

fn peak_to_peak(values: impl Iterator<Item = f32>) -> f32 {
    let (low, high) = values.fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), value| (low.min(value), high.max(value)));
    high - low
}

/// The power at each DFT bin of `signal` (mean removed, Hann-windowed so a frequency between
/// bins does not leak into far ones), with each bin's frequency.
fn spectrum(signal: &[f32]) -> Vec<(f32, f32)> {
    let n = signal.len();
    let mean = signal.iter().sum::<f32>() / n as f32;
    let hann = |index: usize| 0.5 - 0.5 * (std::f64::consts::TAU * index as f64 / (n - 1) as f64).cos();
    (1..n / 2)
        .map(|bin| {
            let (mut re, mut im) = (0.0f64, 0.0f64);
            for (index, value) in signal.iter().enumerate() {
                let angle = std::f64::consts::TAU * bin as f64 * index as f64 / n as f64;
                let sample = f64::from(value - mean) * hann(index);
                re += sample * angle.cos();
                im -= sample * angle.sin();
            }
            (bin as f32 / (n as f32 * DT), (re * re + im * im) as f32)
        })
        .collect()
}

/// The comfort numbers of a stretch of samples: bob peak to peak, the bob's dominant frequency
/// and the share of its energy above [`HIGH_HZ`].
struct Comforted {
    bob: f32,
    dominant: f32,
    high_share: f32,
}

fn comfort_numbers(lifts: &[f32]) -> Comforted {
    let power = spectrum(lifts);
    let total: f32 = power.iter().map(|(_, power)| power).sum();
    let high: f32 = power.iter().filter(|(hertz, _)| *hertz > HIGH_HZ).map(|(_, power)| power).sum();
    let dominant = power.iter().copied().fold((0.0, 0.0), |best, bin| if bin.1 > best.1 { bin } else { best }).0;
    Comforted { bob: peak_to_peak(lifts.iter().copied()), dominant, high_share: if total > 0.0 { high / total } else { 0.0 } }
}

/// A steady sprint after a one-second ramp from standstill, with a gentle mouse sweep.
fn sprint_run(comfort: &Comfort) -> Vec<Sample> {
    run(8.0, |t| SPRINT * (t / 1.0).min(1.0), |t| 0.003 * genex::math::sin(t * 1.3), comfort)
}

#[test]
fn a_sprint_run_holds_every_comfort_cap() {
    let samples = sprint_run(&Comfort::FULL);
    // The steady part: four seconds after the ramp and the bob's own ease-in.
    let steady = &samples[(2.0 / DT) as usize..(6.0 / DT) as usize];
    let lifts: Vec<f32> = steady.iter().map(|sample| sample.lift).collect();
    let numbers = comfort_numbers(&lifts);
    assert!(numbers.bob <= BOB_CAP_M, "sprint bob {:.4} m peak to peak", numbers.bob);
    assert!(numbers.bob > 0.01, "a sprint still bobs: {:.4} m", numbers.bob);
    assert!(numbers.dominant < DOMINANT_CAP_HZ, "the bob's dominant frequency is {:.2} Hz", numbers.dominant);
    assert!(numbers.high_share < HIGH_ENERGY_CAP, "{:.3} of the bob's energy is above {HIGH_HZ} Hz", numbers.high_share);
    let roll = steady.iter().map(|sample| sample.roll.abs()).fold(0.0, f32::max);
    assert!(roll <= ROLL_CAP_DEG, "sprint roll {roll:.2}°");
    let rolls: Vec<f32> = steady.iter().map(|sample| sample.roll).collect();
    assert!(comfort_numbers(&rolls).high_share < HIGH_ENERGY_CAP, "roll has no high-frequency energy");
    let pitches: Vec<f32> = steady.iter().map(|sample| sample.pitch).collect();
    assert!(comfort_numbers(&pitches).high_share < HIGH_ENERGY_CAP, "pitch has no high-frequency energy");
    let kick = steady.iter().map(|sample| sample.fovy - BASE_FOVY).fold(0.0, f32::max);
    assert!(kick > 0.0 && kick <= FOV_KICK_CAP_DEG, "sprint field of view kick {kick:.2}°");
}

#[test]
fn starting_a_sprint_grows_the_bob_over_frames_never_in_one() {
    let samples = run(3.0, |t| if t < 1.0 { WALK } else { SPRINT }, |_| 0.0, &Comfort::FULL);
    let jumps = samples.windows(2).map(|pair| (pair[1].lift - pair[0].lift).abs()).fold(0.0, f32::max);
    let rolls = samples.windows(2).map(|pair| (pair[1].roll - pair[0].roll).abs()).fold(0.0, f32::max);
    let kicks = samples.windows(2).map(|pair| (pair[1].fovy - pair[0].fovy).abs()).fold(0.0, f32::max);
    // A smooth 2.8 Hz bob of 2.8 cm moves the eye about 4 mm a tick at most; a switch in one frame
    // would move it by the whole amplitude, the roll by its 1.2° and the field of view by its 4°.
    assert!(jumps < 0.006, "the eye moves at most {jumps:.4} m a tick");
    assert!(rolls < 0.25, "the roll moves at most {rolls:.3}° a tick");
    assert!(kicks < 0.5, "the field of view moves at most {kicks:.3}° a tick");
}

#[test]
fn every_roll_together_stays_within_two_degrees() {
    // A hard mouse flick (6 rad/s) while sprinting: the lean adds to the walk's roll.
    let samples = run(6.0, |_| SPRINT, |t| if (2.0..3.0).contains(&t) { 0.1 } else { -0.1 }, &Comfort::FULL);
    let roll = samples.iter().map(|sample| sample.roll.abs()).fold(0.0, f32::max);
    assert!(roll <= ROLL_TOTAL_CAP_DEG + 1e-3, "roll {roll:.2}°");
    assert!(roll > ROLL_CAP_DEG * 0.5, "the turn does lean the view: {roll:.2}°");
}

#[test]
fn reduced_motion_leaves_at_most_a_tenth_and_the_toggles_remove_their_part() {
    let full = sprint_run(&Comfort::FULL);
    let reduced = sprint_run(&Comfort { reduced_motion: true, ..Comfort::FULL });
    let steady = |samples: &[Sample]| samples[(2.0 / DT) as usize..].to_vec();
    let bob = |samples: &[Sample]| peak_to_peak(steady(samples).iter().map(|sample| sample.lift));
    let roll = |samples: &[Sample]| steady(samples).iter().map(|sample| sample.roll.abs()).fold(0.0, f32::max);
    assert!(bob(&reduced) <= bob(&full) * 0.1 + 1e-6, "bob {} against {}", bob(&reduced), bob(&full));
    assert!(roll(&reduced) <= roll(&full) * 0.1 + 1e-4, "roll {} against {}", roll(&reduced), roll(&full));
    let still = sprint_run(&Comfort { head_bob: 0.0, screen_shake: 0.0, ..Comfort::FULL });
    assert!(bob(&still) < 1e-5, "no head bob and no shake: the eye rides the body ({})", bob(&still));
    assert!(roll(&still) < 1e-3, "and does not roll ({})", roll(&still));
    let fov = still.iter().map(|sample| sample.fovy).fold(0.0, f32::max);
    assert_eq!(fov, BASE_FOVY, "no head bob: no sprint kick either");
}

#[test]
fn recoil_kicks_the_view_and_screen_shake_scales_it() {
    let pitch_after = |comfort: &Comfort| {
        let mut rig = FirstPersonRig::new();
        rig.recoil(1.0);
        (0..4)
            .map(|_| {
                rig.update(DT, RigStep { grounded: true, ..RigStep::default() });
                sample(&rig.camera_with(Vec3::Y, Vec3::NEG_Z, BASE_FOVY, comfort), Vec3::Y).pitch
            })
            .fold(f32::NEG_INFINITY, f32::max)
    };
    let full = pitch_after(&Comfort::FULL);
    assert!((0.7..=1.6).contains(&full), "a 1° recoil kicks about 1°: {full:.2}");
    let none = pitch_after(&Comfort { screen_shake: 0.0, ..Comfort::FULL });
    assert!(none.abs() < 1e-4, "no screen shake: no kick ({none})");
}

#[test]
fn a_stair_step_eases_in_and_a_landing_dips_within_caps() {
    let mut rig = FirstPersonRig::new();
    let mut body_y = 0.0;
    let mut eye_ys = Vec::new();
    for tick in 0..90 {
        // Walking 3 m/s; on tick 30 the controller snaps up a 0.3 m stair in one tick.
        let rise = if tick == 30 { 0.3 } else { 0.0 };
        body_y += rise;
        rig.update(DT, RigStep { velocity: vec3(0.0, 0.0, -WALK), rise, walked: WALK * DT, grounded: true, ..RigStep::default() });
        let eye = vec3(0.0, body_y + EYE_HEIGHT, 0.0);
        eye_ys.push(rig.camera_with(eye, Vec3::NEG_Z, BASE_FOVY, &Comfort { head_bob: 0.0, screen_shake: 0.0, ..Comfort::FULL }).position.y);
    }
    let jump = eye_ys.windows(2).map(|pair| pair[1] - pair[0]).fold(0.0, f32::max);
    assert!(jump < 0.07, "the eye climbs the 0.3 m stair over several ticks, at most {jump:.3} m in one");
    assert!((eye_ys[89] - (0.3 + EYE_HEIGHT)).abs() < 0.005, "and arrives: {}", eye_ys[89]);

    let mut rig = FirstPersonRig::new();
    rig.update(DT, RigStep { velocity: vec3(0.0, -9.0, 0.0), grounded: false, ..RigStep::default() });
    let mut dips = Vec::new();
    for tick in 0..30 {
        rig.update(DT, RigStep { grounded: true, landed: tick == 0, ..RigStep::default() });
        dips.push(-sample(&rig.camera_with(Vec3::Y, Vec3::NEG_Z, BASE_FOVY, &Comfort::FULL), Vec3::Y).lift);
    }
    let dip = dips.iter().copied().fold(0.0, f32::max);
    assert!((0.01..=0.06).contains(&dip), "a 9 m/s landing dips {dip:.3} m");
}

#[test]
fn the_rig_is_deterministic_and_its_state_never_depends_on_the_person() {
    let script = |rig: &mut FirstPersonRig| {
        for tick in 0..240 {
            let t = tick as f32 * DT;
            rig.update(DT, RigStep { velocity: vec3(0.0, 0.0, -SPRINT * (t / 2.0).min(1.0)), turn: 0.01, grounded: true, ..RigStep::default() });
            if tick % 20 == 0 {
                rig.recoil(0.8);
                rig.impulse(0.3);
            }
        }
    };
    let (mut a, mut b) = (FirstPersonRig::new(), FirstPersonRig::new());
    script(&mut a);
    // The person's settings only scale the view: reading cameras under any comfort in between
    // changes nothing the rig keeps.
    let _ = b.camera_with(Vec3::ZERO, Vec3::NEG_Z, BASE_FOVY, &Comfort { reduced_motion: true, ..Comfort::FULL });
    script(&mut b);
    assert_eq!(a, b);
    assert_eq!(a.probe(), b.probe());
    assert_eq!(a.pose(), b.pose());
}

/// The examples' bob before this change: a fixed 0.75 m stride and `|cos(2·phase)|`, scaled by
/// speed. The probe flags it, so a game that copies such a bob fails the same check.
#[test]
fn the_old_cusped_fixed_stride_bob_fails_the_probe() {
    let mut stride = 0.0;
    let lifts: Vec<f32> = (0..(4.0 / DT) as usize)
        .map(|_| {
            stride += SPRINT * DT;
            let phase = stride / 0.75 * std::f32::consts::PI;
            genex::math::cos(phase * 2.0).abs() * 0.025 * (SPRINT / WALK).min(1.5)
        })
        .collect();
    let numbers = comfort_numbers(&lifts);
    assert!(numbers.dominant > DOMINANT_CAP_HZ, "the old bob ran at {:.1} Hz", numbers.dominant);
    assert!(numbers.high_share > HIGH_ENERGY_CAP, "with {:.2} of its energy above 6 Hz", numbers.high_share);
}
