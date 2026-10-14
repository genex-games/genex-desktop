//! The shell's lifecycle rule, apart from winit so it can be tested: a surface exists only
//! between `resumed` and `suspended`, frames keep coming without one (nothing is presented), and
//! a close or the game's own exit ends the loop.

use crate::sample::FrameSample;
use crate::surface::ShellSurface;

/// Whether the loop goes on after a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameControl {
    /// Keep running.
    Continue,
    /// End the loop (a `quit`, a closed transport, a closed window).
    Exit,
}

/// One displayed frame, as the shell hands it to the game.
#[derive(Clone, Debug, PartialEq)]
pub struct ShellFrame {
    /// Real input since the last frame; empty in a headless run.
    pub sample: FrameSample,
    /// Wall time since the last frame, in milliseconds (the live clock caps it).
    pub frame_ms: f64,
    /// Whether a surface is live to present on.
    pub present: bool,
    /// Whether the run is headless.
    pub headless: bool,
}

/// What the shell drives: the runtime behind a game (the facade implements it).
pub trait ShellGame {
    /// The window title.
    fn title(&self) -> String;
    /// The fixed world frame, in pixels.
    fn world_size(&self) -> [u32; 2];
    /// A surface became live (after `resumed`).
    fn surface_created(&mut self, _surface: &ShellSurface) {}
    /// The live surface changed size or scale.
    fn surface_resized(&mut self, _size: [u32; 2], _scale: f64) {}
    /// The surface is gone (`suspended`, or replaced); drop everything that refers to it.
    fn surface_lost(&mut self) {}
    /// The window gained or lost focus.
    fn focus(&mut self, _focused: bool) {}
    /// Whether the game wants the pointer locked (look from raw mouse motion, no cursor). The
    /// windowed shell asks before each frame and reports what the window granted in
    /// [`FrameSample::pointer_lock`]; a headless run has no pointer.
    fn pointer_lock(&self) -> bool {
        false
    }
    /// A headless run waits here for the host's next request, at most `max_ms`; answer whether it
    /// waited (false: nothing to wait on, the shell sleeps instead).
    fn wait_for_host(&mut self, _max_ms: f64) -> bool {
        false
    }
    /// Run one displayed frame.
    fn frame(&mut self, frame: ShellFrame) -> FrameControl;
}

/// What happened to the window, in the shell's own terms.
#[derive(Clone, Debug)]
#[expect(clippy::large_enum_variant, reason = "one event is in flight at a time; boxing the sample would allocate every frame")]
pub enum ShellEvent {
    /// The app may show a window: here is its surface.
    Resumed(ShellSurface),
    /// The app must drop its surface.
    Suspended,
    /// The window changed size (physical pixels) or scale.
    Resized {
        /// Physical pixels.
        size: [u32; 2],
        /// Physical pixels per logical pixel.
        scale: f64,
    },
    /// Focus changed.
    Focus(bool),
    /// Time to draw a frame.
    Redraw {
        /// The input sampled for it.
        sample: FrameSample,
        /// Wall time since the last frame, in milliseconds.
        frame_ms: f64,
    },
    /// The person closed the window.
    CloseRequested,
}

/// The lifecycle state machine between winit and the game.
#[derive(Debug)]
pub struct ShellCore<G> {
    game: G,
    surface_live: bool,
}

impl<G: ShellGame> ShellCore<G> {
    /// A core with no surface yet.
    pub fn new(game: G) -> ShellCore<G> {
        ShellCore { game, surface_live: false }
    }

    /// Apply one event.
    pub fn handle(&mut self, event: ShellEvent) -> FrameControl {
        match event {
            ShellEvent::Resumed(surface) => {
                if self.surface_live {
                    self.game.surface_lost();
                }
                self.surface_live = true;
                self.game.surface_created(&surface);
            }
            ShellEvent::Suspended => {
                if self.surface_live {
                    self.surface_live = false;
                    self.game.surface_lost();
                }
            }
            ShellEvent::Resized { size, scale } if self.surface_live => self.game.surface_resized(size, scale),
            ShellEvent::Resized { .. } => {}
            ShellEvent::Focus(focused) => self.game.focus(focused),
            ShellEvent::Redraw { sample, frame_ms } => {
                let frame = ShellFrame { sample, frame_ms, present: self.surface_live, headless: false };
                return self.game.frame(frame);
            }
            ShellEvent::CloseRequested => return FrameControl::Exit,
        }
        FrameControl::Continue
    }

    /// Whether a surface is live.
    pub fn surface_live(&self) -> bool {
        self.surface_live
    }

    /// The game.
    pub fn game(&self) -> &G {
        &self.game
    }

    /// The game, mutably.
    pub fn game_mut(&mut self) -> &mut G {
        &mut self.game
    }

    /// The game back.
    pub fn into_game(self) -> G {
        self.game
    }
}
