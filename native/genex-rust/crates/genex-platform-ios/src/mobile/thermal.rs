//! Thermal pacing hooks. A phone that heats up throttles its GPU on its own; drawing fewer frames
//! before it does keeps play smooth instead of stuttering. The platform's thermal state
//! (`NSProcessInfo.thermalState` on iOS, `PowerManager.getCurrentThermalStatus` on Android) is
//! read at most every [`THERMAL_POLL_MS`] ([`ThermalWatch`]); at `serious` or above the shell
//! draws at most every [`THROTTLED_FRAME_MS`] (30 Hz, the mobile budget's floor) and otherwise at
//! the display's rate ([`Pacer`]). A skipped redraw is skipped whole, so the simulation catches up
//! by the elapsed time on the next drawn frame and never runs slower than the wall clock.
//!
//! Time is injected (milliseconds from the shell's own clock), so the pacing is tested without
//! waiting.

use genex::{Value, json};

/// How often the platform's thermal state is read, in milliseconds.
pub const THERMAL_POLL_MS: f64 = 1000.0;
/// The shortest interval between drawn frames while throttled: 30 Hz.
pub const THROTTLED_FRAME_MS: f64 = 1000.0 / 30.0;
/// Slack for a vsync that lands a little early (displays tick at 59.94 Hz, timers jitter).
const VSYNC_SLACK_MS: f64 = 2.0;

/// The platform's thermal state, iOS's four levels (Android's seven fold onto them).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum Thermal {
    /// Cool.
    #[default]
    Nominal,
    /// Warm: no action needed yet.
    Fair,
    /// Hot: the system is throttling or about to.
    Serious,
    /// Very hot: everything that can wait should.
    Critical,
}

impl Thermal {
    /// The wire spelling (the lifecycle log).
    pub const fn wire(self) -> &'static str {
        match self {
            Thermal::Nominal => "nominal",
            Thermal::Fair => "fair",
            Thermal::Serious => "serious",
            Thermal::Critical => "critical",
        }
    }

    /// The shortest interval between drawn frames in this state (0: every display refresh).
    pub const fn frame_interval_ms(self) -> f64 {
        match self {
            Thermal::Nominal | Thermal::Fair => 0.0,
            Thermal::Serious | Thermal::Critical => THROTTLED_FRAME_MS,
        }
    }
}

/// The platform's thermal state, read at most every [`THERMAL_POLL_MS`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ThermalWatch {
    state: Thermal,
    last_poll_ms: Option<f64>,
}

impl ThermalWatch {
    /// The state last read.
    pub fn state(&self) -> Thermal {
        self.state
    }

    /// At `now_ms`, read the platform's state with `read` when a poll is due; answers the new
    /// state when it changed (a platform that cannot say answers `None` and keeps the last one).
    pub fn poll(&mut self, now_ms: f64, read: impl FnOnce() -> Option<Thermal>) -> Option<Thermal> {
        let due = self.last_poll_ms.is_none_or(|last| now_ms - last >= THERMAL_POLL_MS);
        if !due {
            return None;
        }
        self.last_poll_ms = Some(now_ms);
        let now = read()?;
        if now == self.state {
            return None;
        }
        self.state = now;
        Some(now)
    }

    /// The lifecycle log's `thermal` event.
    pub fn event(&self) -> Value {
        json!({ "event": "thermal", "state": self.state.wire(), "frameIntervalMs": self.state.frame_interval_ms() })
    }
}

/// Which redraws are drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pacer {
    last_drawn_ms: Option<f64>,
}

impl Pacer {
    /// Whether the redraw at `now_ms` is drawn in `state` (and, if so, it counts as drawn).
    pub fn should_draw(&mut self, now_ms: f64, state: Thermal) -> bool {
        let interval = state.frame_interval_ms();
        let early = self.last_drawn_ms.is_some_and(|last| now_ms - last < interval - VSYNC_SLACK_MS);
        if early {
            return false;
        }
        self.last_drawn_ms = Some(now_ms);
        true
    }

    /// Forget the last drawn frame (after a resume, the next redraw is always drawn).
    pub fn reset(&mut self) {
        self.last_drawn_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drawn frames over one second of `hz` redraws in `state`.
    fn drawn_in_a_second(hz: f64, state: Thermal) -> u32 {
        let mut pacer = Pacer::default();
        (0..hz as u32).map(|frame| f64::from(frame) * 1000.0 / hz).filter(|now| pacer.should_draw(*now, state)).count() as u32
    }

    #[test]
    fn a_cool_phone_draws_every_refresh_and_a_hot_one_at_30_hz() {
        assert_eq!(drawn_in_a_second(60.0, Thermal::Nominal), 60);
        assert_eq!(drawn_in_a_second(120.0, Thermal::Fair), 120);
        assert_eq!(drawn_in_a_second(60.0, Thermal::Serious), 30);
        assert_eq!(drawn_in_a_second(120.0, Thermal::Critical), 30);
        assert_eq!(drawn_in_a_second(59.94, Thermal::Serious), 30, "a slightly slow display still reaches 30 Hz");
    }

    #[test]
    fn after_a_reset_the_next_redraw_is_drawn() {
        let mut pacer = Pacer::default();
        assert!(pacer.should_draw(0.0, Thermal::Serious));
        assert!(!pacer.should_draw(10.0, Thermal::Serious));
        pacer.reset();
        assert!(pacer.should_draw(11.0, Thermal::Serious));
    }

    #[test]
    fn the_platform_is_read_at_most_once_a_second_and_only_changes_are_reported() {
        let mut watch = ThermalWatch::default();
        let mut reads = 0;
        let mut read = |state| {
            reads += 1;
            Some(state)
        };
        assert_eq!(watch.poll(0.0, || read(Thermal::Nominal)), None, "nominal is the starting state");
        assert_eq!(watch.poll(500.0, || read(Thermal::Serious)), None, "not due yet");
        assert_eq!(watch.poll(1000.0, || read(Thermal::Serious)), Some(Thermal::Serious));
        assert_eq!(watch.poll(2000.0, || read(Thermal::Serious)), None);
        assert_eq!(watch.poll(3000.0, || None), None, "a platform that cannot say keeps the last state");
        assert_eq!(watch.state(), Thermal::Serious);
        assert_eq!(reads, 3);
        assert_eq!(watch.event(), json!({ "event": "thermal", "state": "serious", "frameIntervalMs": THROTTLED_FRAME_MS }));
    }
}
