//! When a phone shell configures its surface (lane FQ; the desktop shell's UP-0 fix, dd8a593b).
//!
//! wgpu's `Surface::configure` waits for the queue to go idle and refuses, as an uncaptured
//! validation error ("Failed to wait for GPU to come idle before reconfiguring the Surface"), when
//! another thread submits during that wait. The boot's (or a settings change's) warm-up renders and
//! submits on its own thread, and a phone configures on a new surface, a resize and a rotation, any
//! of which can land while it runs. [`ConfigureGate`] holds a configuration wanted while a warm-up
//! may submit and hands the last one back at the first frame after it; the swapchain keeps its old
//! configuration (or none: nothing is presented) meanwhile. The shell configures its first surface
//! before it starts the boot's warm-up, so the loading screen has a swapchain to present on.

/// A surface configuration the shell wants, applied now or once no warm-up thread may submit.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ConfigureGate<C> {
    held: Option<C>,
}

impl<C> ConfigureGate<C> {
    /// A gate holding nothing.
    pub fn new() -> ConfigureGate<C> {
        ConfigureGate { held: None }
    }

    /// The shell wants `config` (a new surface, a resize, a rotation): the configuration to apply
    /// now, or none while a warm-up thread may submit (`warming`), when it is held in place of an
    /// older one.
    pub fn want(&mut self, config: C, warming: bool) -> Option<C> {
        if warming {
            self.held = Some(config);
            return None;
        }
        self.held = None;
        Some(config)
    }

    /// At a frame: the configuration held, once no warm-up thread may submit.
    pub fn due(&mut self, warming: bool) -> Option<C> {
        if warming {
            return None;
        }
        self.held.take()
    }

    /// The configuration held, if any.
    pub fn held(&self) -> Option<&C> {
        self.held.as_ref()
    }

    /// The surface went away: nothing is held for it.
    pub fn forget(&mut self) {
        self.held = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell's surface as the gate drives it: the configurations it was given, in order.
    #[derive(Default)]
    struct Shell {
        gate: ConfigureGate<(u32, u32)>,
        warming: bool,
        configured: Vec<(u32, u32)>,
    }

    impl Shell {
        /// A new surface, a resize or a rotation of the window to `size`.
        fn wants(&mut self, size: (u32, u32)) {
            if let Some(config) = self.gate.want(size, self.warming) {
                self.configured.push(config);
            }
        }

        /// A display frame.
        fn frame(&mut self) {
            if let Some(config) = self.gate.due(self.warming) {
                self.configured.push(config);
            }
        }
    }

    /// Lane FQ (the iOS twin of the fullscreen crash UP fixed on the desktop): a phone rotated, or
    /// handed a new surface, while the boot's warm-up thread renders configured at once, under that
    /// thread's submits. The first surface is configured before the warm-up starts; a rotation
    /// during it is held and applied once, at the last size, at the first frame after it.
    #[test]
    fn a_surface_wanted_while_a_warm_up_may_submit_is_configured_after_it_at_the_last_size() {
        let mut shell = Shell::default();
        shell.wants((1179, 2556));
        assert_eq!(shell.configured, vec![(1179, 2556)], "the first surface, before the warm-up starts");
        shell.warming = true;
        shell.wants((2556, 1179));
        shell.frame();
        shell.wants((1179, 2556));
        shell.frame();
        assert_eq!(shell.configured, vec![(1179, 2556)], "no configure while the warm-up may submit");
        assert_eq!(shell.gate.held(), Some(&(1179, 2556)), "the last rotation waits");
        shell.warming = false;
        shell.frame();
        shell.frame();
        assert_eq!(shell.configured, vec![(1179, 2556), (1179, 2556)], "applied once after the warm-up, at the last size");
        shell.wants((2556, 1179));
        assert_eq!(shell.configured.last(), Some(&(2556, 1179)), "with no warm-up running a rotation configures at once");
    }

    /// A surface lost or dropped while its configuration waits (the app suspended during the
    /// warm-up) leaves nothing to configure; the next surface is wanted afresh.
    #[test]
    fn a_dropped_surface_forgets_the_configuration_it_waited_for() {
        let mut shell = Shell { warming: true, ..Shell::default() };
        shell.wants((1179, 2556));
        shell.gate.forget();
        shell.warming = false;
        shell.frame();
        assert!(shell.configured.is_empty(), "nothing configured for a surface that went away");
    }
}
