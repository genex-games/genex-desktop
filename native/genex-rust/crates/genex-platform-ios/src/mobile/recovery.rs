//! When the phone shell tries to re-create a lost GPU device (review F4): at once on the first
//! frame that finds it lost, then at most once every [`RETRY_EVERY_MS`] while the opener refuses
//! (a driver still resetting), never inside a frame that draws. While the device is lost the shell
//! neither draws nor presents (an acquired surface texture would show undefined content).

/// How long the shell waits between two recovery attempts while the device stays lost.
pub const RETRY_EVERY_MS: f64 = 1000.0;

/// What the shell does with the device on this frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LossStep {
    /// The device is fine: draw and present.
    Healthy,
    /// The device is lost: try to re-create it now.
    Recover,
    /// The device is lost and the last attempt was too recent: draw nothing, present nothing.
    Wait,
}

/// The shell's record of a lost device.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Recovery {
    last_try_ms: Option<f64>,
    tries: u32,
}

impl Recovery {
    /// This frame's step at `now_ms`, given whether the device is lost.
    pub fn step(&mut self, lost: bool, now_ms: f64) -> LossStep {
        if !lost {
            return LossStep::Healthy;
        }
        // A NaN clock retries rather than waiting forever.
        let due = self.last_try_ms.is_none_or(|last| {
            let elapsed = now_ms - last;
            elapsed.is_nan() || elapsed >= RETRY_EVERY_MS
        });
        if !due {
            return LossStep::Wait;
        }
        self.last_try_ms = Some(now_ms);
        self.tries += 1;
        LossStep::Recover
    }

    /// Attempts made since the device was lost.
    pub fn tries(&self) -> u32 {
        self.tries
    }

    /// The device is back: the next loss starts counting again.
    pub fn recovered(&mut self) {
        *self = Recovery::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lost_device_is_tried_at_once_then_once_a_second_until_it_is_back() {
        let mut recovery = Recovery::default();
        assert_eq!(recovery.step(false, 0.0), LossStep::Healthy);
        assert_eq!(recovery.step(true, 10.0), LossStep::Recover, "the first frame that finds it lost");
        assert_eq!(recovery.step(true, 26.7), LossStep::Wait);
        assert_eq!(recovery.step(true, 1009.0), LossStep::Wait);
        assert_eq!(recovery.step(true, 1010.0), LossStep::Recover, "a second later");
        assert_eq!(recovery.tries(), 2);
        recovery.recovered();
        assert_eq!(recovery.step(false, 1020.0), LossStep::Healthy);
        assert_eq!(recovery.step(true, 1030.0), LossStep::Recover, "a later loss is tried at once");
        assert_eq!(recovery.tries(), 1);
    }

    #[test]
    fn a_hostile_clock_never_stops_the_attempts() {
        let mut recovery = Recovery::default();
        assert_eq!(recovery.step(true, f64::NAN), LossStep::Recover);
        assert_eq!(recovery.step(true, f64::NAN), LossStep::Recover, "a NaN clock retries rather than waiting forever");
        assert_eq!(recovery.step(true, 0.0), LossStep::Recover);
        assert_eq!(recovery.step(true, -5000.0), LossStep::Wait, "a clock that ran backwards waits");
    }
}
