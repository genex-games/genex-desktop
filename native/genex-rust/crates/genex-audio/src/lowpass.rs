//! Each voice's low-pass filter (occlusion and distance muffling): kira's `Filter` effect in
//! low-pass mode, so a voice sounds, bit for bit, as it did through kira's filter.
//!
//! Ported from kira 0.12.5 `src/effect/filter.rs`, `src/effect/filter/builder.rs` and
//! `src/effect/filter/handle.rs` (MIT OR Apache-2.0, used under Apache 2.0; Copyright Andrew
//! Minnich and kira contributors; kira's filter follows baseplug's `svf_simper.rs`). Changed: low
//! pass only, kira's default resonance (0) and mix (wet) as constants, a cutoff command as the
//! only command, and the coefficients (a `tan` each) computed once per block while the cutoff holds
//! still instead of once per frame (GE fix r2: AU-10's desktop mixer row spent about a third of a
//! tick in that `tan`). A cutoff that holds still interpolates to the same bits at every frame of
//! the block, so the output is unchanged.

use std::f64::consts::PI;

use kira::command::{CommandReader, CommandWriter, ValueChangeCommand, command_writer_and_reader};
use kira::effect::{Effect, EffectBuilder};
use kira::info::Info;
use kira::{Frame, Parameter, Tween, Value};

/// kira's filter's `k` at its default resonance (0): `2 - 1.9 * resonance`.
const K: f64 = 2.0 - (1.9 * 0.0);
/// kira's filter's default mix (fully wet).
const MIX: f32 = 1.0;
/// kira's filter's default cutoff, Hz (the parameter's starting value).
const DEFAULT_CUTOFF_HZ: f64 = 1000.0;
/// The cutoff over the sample rate is clamped to this range, as kira's filter clamps it.
const CUTOFF_RATIO_RANGE: (f64, f64) = (0.0001, 0.5);

/// Builds a voice's low-pass filter at `cutoff_hz`.
pub(crate) struct LowPassBuilder {
    cutoff_hz: f64,
}

impl LowPassBuilder {
    /// A low-pass filter starting at `cutoff_hz`.
    pub(crate) fn new(cutoff_hz: f64) -> LowPassBuilder {
        LowPassBuilder { cutoff_hz }
    }
}

impl EffectBuilder for LowPassBuilder {
    type Handle = LowPassHandle;

    fn build(self) -> (Box<dyn Effect>, LowPassHandle) {
        let (writer, reader) = command_writer_and_reader();
        let filter = LowPass {
            set_cutoff: reader,
            cutoff: Parameter::new(Value::Fixed(self.cutoff_hz), DEFAULT_CUTOFF_HZ),
            ic1eq: Frame::ZERO,
            ic2eq: Frame::ZERO,
        };
        (Box::new(filter), LowPassHandle { set_cutoff: writer })
    }
}

/// Controls a voice's low-pass filter from the mixer.
#[derive(Debug)]
pub(crate) struct LowPassHandle {
    set_cutoff: CommandWriter<ValueChangeCommand<f64>>,
}

impl LowPassHandle {
    /// Move the cutoff to `hz` over `tween`.
    pub(crate) fn set_cutoff(&mut self, hz: f64, tween: Tween) {
        self.set_cutoff.write(ValueChangeCommand { target: Value::Fixed(hz), tween });
    }
}

struct LowPass {
    set_cutoff: CommandReader<ValueChangeCommand<f64>>,
    cutoff: Parameter,
    ic1eq: Frame,
    ic2eq: Frame,
}

/// kira's filter's per-frame coefficients `(a1, a2, a3)` for `cutoff` Hz at frame step `dt`.
fn coefficients(cutoff: f64, dt: f64) -> (f64, f64, f64) {
    let sample_rate = 1.0 / dt;
    let g = (PI * (cutoff / sample_rate).clamp(CUTOFF_RATIO_RANGE.0, CUTOFF_RATIO_RANGE.1)).tan();
    let a1 = 1.0 / (1.0 + (g * (g + K)));
    let a2 = g * a1;
    let a3 = g * a2;
    (a1, a2, a3)
}

impl Effect for LowPass {
    fn on_start_processing(&mut self) {
        self.cutoff.read_command(&mut self.set_cutoff);
    }

    fn process(&mut self, input: &mut [Frame], dt: f64, info: &Info) {
        self.cutoff.update(dt * input.len() as f64, info);
        // A cutoff that holds still this block (not NaN: NaN never equals itself) interpolates to
        // its own value at every frame, so its coefficients are the first frame's.
        let still = self.cutoff.previous_value() == self.cutoff.value();
        let mut held: Option<(f64, f64, f64)> = None;
        let num_frames = input.len();
        for (i, frame) in input.iter_mut().enumerate() {
            let time_in_chunk = (i + 1) as f64 / num_frames as f64;
            let (a1, a2, a3) = match held {
                Some(kept) => kept,
                None => {
                    let made = coefficients(self.cutoff.interpolated_value(time_in_chunk), dt);
                    if still {
                        held = Some(made);
                    }
                    made
                }
            };
            let v3 = *frame - self.ic2eq;
            let v1 = (self.ic1eq * (a1 as f32)) + (v3 * (a2 as f32));
            let v2 = self.ic2eq + (self.ic1eq * (a2 as f32)) + (v3 * (a3 as f32));
            self.ic1eq = (v1 * 2.0) - self.ic1eq;
            self.ic2eq = (v2 * 2.0) - self.ic2eq;
            *frame = v2 * MIX.sqrt() + *frame * (1.0 - MIX).sqrt();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kira::effect::filter::{FilterBuilder, FilterMode};
    use kira::info::MockInfoBuilder;

    /// Frames a block holds (one 60 Hz tick at 48 kHz) and the frame step.
    const BLOCK: usize = 800;
    const DT: f64 = 1.0 / 48_000.0;

    /// A fixed noise: the same frames every run.
    fn noise(seed: &mut u32) -> Frame {
        let mut next = || {
            *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (*seed >> 8) as f32 / (1u32 << 23) as f32 - 1.0
        };
        Frame { left: next(), right: next() }
    }

    /// GE fix r2: the port renders kira's low-pass filter bit for bit, with the cutoff still, jumped,
    /// tweened, hostile and back, block after block.
    #[test]
    fn the_low_pass_renders_kira_s_filter_bit_for_bit() {
        let start = 20_000.0;
        let (mut kira_effect, mut kira_handle) = FilterBuilder::new().mode(FilterMode::LowPass).cutoff(start).build();
        let (mut ported, mut handle) = LowPassBuilder::new(start).build();
        let info = MockInfoBuilder::new().build();
        let steps: [(usize, f64, f64); 6] = [(3, 1200.0, 0.0), (5, 300.0, 0.1), (9, f64::NAN, 0.0), (11, 25_000.0, 0.0), (13, 2.0, 0.05), (20, 8000.0, 0.0)];
        let mut seed = 7;
        for block in 0..30 {
            if let Some(&(_, hz, seconds)) = steps.iter().find(|(at, _, _)| *at == block) {
                let tween = Tween { duration: std::time::Duration::from_secs_f64(seconds), ..Tween::default() };
                kira_handle.set_cutoff(hz, tween);
                handle.set_cutoff(hz, tween);
            }
            let input: Vec<Frame> = (0..BLOCK).map(|_| noise(&mut seed)).collect();
            let (mut theirs, mut ours) = (input.clone(), input);
            kira_effect.on_start_processing();
            ported.on_start_processing();
            kira_effect.process(&mut theirs, DT, &info);
            ported.process(&mut ours, DT, &info);
            let bits = |frames: &[Frame]| frames.iter().flat_map(|f| [f.left.to_bits(), f.right.to_bits()]).collect::<Vec<u32>>();
            assert_eq!(bits(&ours), bits(&theirs), "block {block}");
        }
    }
}
