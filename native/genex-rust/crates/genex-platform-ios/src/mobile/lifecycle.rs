//! The mobile lifecycle rule, apart from winit so it can be tested: a surface may exist only
//! between `resumed` and `suspended`. A surface offered before the first `resumed` (or after a
//! `suspended`) is refused with a typed code instead of being created, and `suspended` always
//! drops the live surface (iOS backgrounding, Android's native window going away).

use std::fmt;

/// Where the app is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Launched, never resumed: no surface yet.
    Launched,
    /// In the foreground: a surface may be created.
    Resumed,
    /// In the background: no surface.
    Suspended,
}

impl Phase {
    /// The phase's wire spelling (the lifecycle log).
    pub const fn wire(self) -> &'static str {
        match self {
            Phase::Launched => "launched",
            Phase::Resumed => "resumed",
            Phase::Suspended => "suspended",
        }
    }
}

/// Why a lifecycle step was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleCode {
    /// A surface was offered while the app is not resumed.
    SurfaceBeforeResumed,
}

impl LifecycleCode {
    /// The typed code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            LifecycleCode::SurfaceBeforeResumed => "surface-before-resumed",
        }
    }
}

/// A refused lifecycle step: its code and the phase it was refused in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LifecycleError {
    /// The typed code.
    pub code: LifecycleCode,
    /// The phase at the time.
    pub phase: Phase,
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: the app is {}", self.code.wire(), self.phase.wire())
    }
}

impl std::error::Error for LifecycleError {}

/// The lifecycle state machine between winit and the renderer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lifecycle {
    phase: Phase,
    surface_live: bool,
    resumes: u32,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Lifecycle { phase: Phase::Launched, surface_live: false, resumes: 0 }
    }
}

impl Lifecycle {
    /// The current phase.
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Whether a surface is live.
    pub fn surface_live(&self) -> bool {
        self.surface_live
    }

    /// How many times the app was resumed.
    pub fn resumes(&self) -> u32 {
        self.resumes
    }

    /// The app came to the foreground.
    pub fn resumed(&mut self) {
        self.phase = Phase::Resumed;
        self.resumes += 1;
    }

    /// The app went to the background; answers whether a live surface must now be dropped.
    pub fn suspended(&mut self) -> bool {
        self.phase = Phase::Suspended;
        std::mem::take(&mut self.surface_live)
    }

    /// A surface is about to be created: allowed only while resumed.
    pub fn surface_created(&mut self) -> Result<(), LifecycleError> {
        if self.phase != Phase::Resumed {
            return Err(LifecycleError { code: LifecycleCode::SurfaceBeforeResumed, phase: self.phase });
        }
        self.surface_live = true;
        Ok(())
    }

    /// The surface was lost (or destroyed) while resumed.
    pub fn surface_lost(&mut self) {
        self.surface_live = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_surface_before_the_first_resumed_is_refused() {
        let mut life = Lifecycle::default();
        let refused = life.surface_created().expect_err("refused before resumed");
        assert_eq!(refused.code, LifecycleCode::SurfaceBeforeResumed);
        assert_eq!(refused.phase, Phase::Launched);
        assert_eq!(refused.to_string(), "surface-before-resumed: the app is launched");
        assert!(!life.surface_live());
    }

    #[test]
    fn a_surface_after_suspended_is_refused_until_the_next_resumed() {
        let mut life = Lifecycle::default();
        life.resumed();
        life.surface_created().expect("resumed");
        assert!(life.suspended(), "suspended drops the live surface");
        assert!(!life.surface_live());
        assert_eq!(life.surface_created().expect_err("suspended").phase, Phase::Suspended);
        life.resumed();
        life.surface_created().expect("resumed again");
        assert_eq!(life.resumes(), 2);
    }

    #[test]
    fn suspended_without_a_surface_drops_nothing() {
        let mut life = Lifecycle::default();
        life.resumed();
        assert!(!life.suspended());
        life.resumed();
        life.surface_created().expect("resumed");
        life.surface_lost();
        assert!(!life.suspended(), "a lost surface is already gone");
    }
}
