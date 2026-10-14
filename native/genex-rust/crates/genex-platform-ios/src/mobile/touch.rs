//! Touch with ids: every finger reaches `ctx.touches` with an id of its own, stable from down to up
//! or cancel. The platform's ids are opaque (a pointer hash on iOS, a pointer id on Android), so
//! each finger gets the lowest game id free while it is down, 0 first, as many as genex-core keeps
//! ([`MAX_FINGERS`]). Positions are world pixels through the [`Presentation`]: a finger that goes
//! down on a bar or outside the safe area is no touch, and one dragged onto a bar holds the
//! world's edge.
//!
//! The first finger down also drives the facade's pointer and Mouse1, so pointer-driven games play
//! on a phone. It is touch 0 whenever it went down alone, which is the id the facade's Mouse1
//! emulation would use: the facade sees the real finger 0 and adds no second one.

use crate::mobile::present::Presentation;
use genex::{Input, Key};

/// The fingers tracked at once: genex-core's `MAX_TOUCHES`; a finger past it is ignored.
pub const MAX_FINGERS: usize = 10;

/// What a finger did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchEvent {
    /// It went down.
    Started,
    /// It moved.
    Moved,
    /// It went up.
    Ended,
    /// The system took it (an incoming call, a gesture).
    Cancelled,
}

/// One finger that is down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ActiveTouch {
    /// The platform's id, stable while the finger is down.
    pub platform_id: u64,
    /// The game's id (`ctx.touches`).
    pub id: u32,
    /// Window position in physical pixels.
    pub position: (f32, f32),
    /// Whether the game saw it go down (false: it went down on a bar).
    pub delivered: bool,
}

/// The fingers that are down, in the order they went down.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TouchTracker {
    active: Vec<ActiveTouch>,
    seen: u64,
}

impl TouchTracker {
    /// The fingers down now.
    pub fn active(&self) -> &[ActiveTouch] {
        &self.active
    }

    /// How many fingers went down since launch.
    pub fn seen(&self) -> u64 {
        self.seen
    }

    /// Apply one platform event at a window `position`; answers the facade input it means, if any.
    pub fn handle(&mut self, platform_id: u64, event: TouchEvent, position: (f32, f32), presentation: &Presentation) -> Option<Input> {
        let primary = self.active.first().map(|touch| touch.platform_id);
        let is_primary = primary.is_none_or(|first| first == platform_id);
        match event {
            TouchEvent::Started => self.start(platform_id, position, presentation, is_primary),
            TouchEvent::Moved => self.moved(platform_id, position, presentation, is_primary),
            TouchEvent::Ended | TouchEvent::Cancelled => self.lift(platform_id, position, presentation, is_primary),
        }
    }

    /// The lowest game id no finger down holds.
    fn free_id(&self) -> u32 {
        (0..).find(|id| self.active.iter().all(|touch| touch.id != *id)).unwrap_or(0)
    }

    fn start(&mut self, platform_id: u64, position: (f32, f32), presentation: &Presentation, primary: bool) -> Option<Input> {
        // A start for a finger already down (a lost end): it starts again under its own id.
        self.active.retain(|touch| touch.platform_id != platform_id);
        if self.active.len() >= MAX_FINGERS {
            return None;
        }
        let world = presentation.to_world(position);
        let id = self.free_id();
        self.active.push(ActiveTouch { platform_id, id, position, delivered: world.is_some() });
        self.seen += 1;
        let (x, y) = world?;
        let touch = Input::touch_start(id, x, y);
        Some(if primary { touch.and(pointer(presentation, (x, y))).and(Input::key_down(Key::Mouse1)) } else { touch })
    }

    fn moved(&mut self, platform_id: u64, position: (f32, f32), presentation: &Presentation, primary: bool) -> Option<Input> {
        let touch = self.active.iter_mut().find(|touch| touch.platform_id == platform_id)?;
        touch.position = position;
        if !touch.delivered {
            return None;
        }
        let (x, y) = presentation.to_world_clamped(position);
        let moved = Input::touch_move(touch.id, x, y);
        Some(if primary { moved.and(pointer(presentation, (x, y))) } else { moved })
    }

    fn lift(&mut self, platform_id: u64, position: (f32, f32), presentation: &Presentation, primary: bool) -> Option<Input> {
        let at = self.active.iter().position(|touch| touch.platform_id == platform_id)?;
        let touch = self.active.remove(at);
        if !touch.delivered {
            return None;
        }
        let (x, y) = presentation.to_world_clamped(position);
        let ended = Input::touch_end(touch.id, x, y);
        Some(if primary { ended.and(Input::key_up(Key::Mouse1)) } else { ended })
    }
}

/// The facade pointer (a fraction of the world frame) at a world point.
fn pointer(presentation: &Presentation, (x, y): (f32, f32)) -> Input {
    let (width, height) = presentation.world();
    Input::pointer(x / width.max(1) as f32, y / height.max(1) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile::safe_area::SafeArea;
    use genex::{Game, Runtime, TouchPhase};

    const WINDOW: (u32, u32) = (1920, 1080);
    const WORLD: (u32, u32) = (960, 540);
    /// iOS touch ids are pointer hashes: large and arbitrary.
    const FINGER_A: u64 = 0x6000_0123_4560;
    const FINGER_B: u64 = 0x6000_0abc_def0;

    fn full() -> Presentation {
        Presentation::new(WINDOW, SafeArea::default(), WORLD)
    }

    #[test]
    fn every_finger_gets_its_own_game_id_and_only_the_first_drives_the_pointer() {
        let mut touches = TouchTracker::default();
        let down = touches.handle(FINGER_A, TouchEvent::Started, (960.0, 540.0), &full()).expect("first finger");
        let pointer = Input::pointer(0.5, 0.5).and(Input::key_down(Key::Mouse1));
        assert_eq!(down, Input::touch_start(0, 480.0, 270.0).and(pointer));
        let second = touches.handle(FINGER_B, TouchEvent::Started, (100.0, 100.0), &full());
        assert_eq!(second, Some(Input::touch_start(1, 50.0, 50.0)), "a second finger is touch 1, no pointer");
        assert_eq!(touches.handle(FINGER_B, TouchEvent::Moved, (120.0, 100.0), &full()), Some(Input::touch_move(1, 60.0, 50.0)));
        let up = touches.handle(FINGER_A, TouchEvent::Ended, (960.0, 540.0), &full());
        assert_eq!(up, Some(Input::touch_end(0, 480.0, 270.0).and(Input::key_up(Key::Mouse1))));
        assert_eq!(touches.active().iter().map(|t| t.id).collect::<Vec<_>>(), [1]);
        assert_eq!(touches.seen(), 2);
    }

    #[test]
    fn a_lifted_id_is_free_again_and_a_finger_past_the_cap_is_ignored() {
        let mut touches = TouchTracker::default();
        for finger in 0..MAX_FINGERS as u64 {
            assert!(touches.handle(100 + finger, TouchEvent::Started, (960.0, 540.0), &full()).is_some());
        }
        assert_eq!(touches.handle(999, TouchEvent::Started, (960.0, 540.0), &full()), None, "an eleventh finger");
        touches.handle(103, TouchEvent::Cancelled, (960.0, 540.0), &full());
        let again = touches.handle(555, TouchEvent::Started, (960.0, 540.0), &full());
        assert_eq!(again, Some(Input::touch_start(3, 480.0, 270.0)), "the lowest free id");
        assert_eq!(touches.handle(42, TouchEvent::Moved, (5.0, 5.0), &full()), None, "an unknown finger");
    }

    #[test]
    fn a_finger_on_the_notch_is_no_touch_and_a_drag_onto_it_holds_the_edge() {
        let iphone = Presentation::new((2556, 1179), SafeArea { top: 0, left: 177, bottom: 63, right: 177 }, WORLD);
        let mut touches = TouchTracker::default();
        assert_eq!(touches.handle(1, TouchEvent::Started, (100.0, 500.0), &iphone), None);
        assert_eq!(touches.handle(1, TouchEvent::Moved, (1278.0, 558.0), &iphone), None, "never went down for the game");
        assert_eq!(touches.handle(1, TouchEvent::Ended, (1278.0, 558.0), &iphone), None);
        let down = touches.handle(2, TouchEvent::Started, (1278.0, 558.0), &iphone).expect("inside");
        assert_eq!(down, Input::touch_start(0, 480.0, 270.0).and(Input::pointer(0.5, 0.5)).and(Input::key_down(Key::Mouse1)));
        let dragged = touches.handle(2, TouchEvent::Moved, (50.0, 558.0), &iphone);
        assert_eq!(dragged, Some(Input::touch_move(0, 0.0, 270.0).and(Input::pointer(0.0, 0.5))));
    }

    #[derive(Default)]
    struct Fingers {
        seen: Vec<(u32, &'static str)>,
    }

    fn phase_name(phase: TouchPhase) -> &'static str {
        match phase {
            TouchPhase::Began => "began",
            TouchPhase::Held => "held",
            TouchPhase::Ended => "ended",
            TouchPhase::Tapped => "tapped",
        }
    }

    #[test]
    fn every_finger_reaches_ctx_touches_once_with_its_id_and_no_emulated_double() {
        let mut game = Game::new(Fingers::default());
        game.on_update(|sim, ctx| {
            for touch in ctx.touches.all() {
                sim.world.seen.push((touch.id, phase_name(touch.phase)));
            }
        });
        game.probe("fingers", |sim| genex::json!(sim.world.seen.iter().map(|(id, phase)| format!("{id}:{phase}")).collect::<Vec<_>>()));
        let mut runtime = Runtime::new(game).expect("installs");
        runtime.seed(1);
        runtime.start();
        let mut touches = TouchTracker::default();
        let presentation = full();
        for (finger, event, at) in [
            (FINGER_A, TouchEvent::Started, (960.0, 540.0)),
            (FINGER_B, TouchEvent::Started, (100.0, 100.0)),
        ] {
            runtime.inject(touches.handle(finger, event, at, &presentation).expect("delivered"));
        }
        runtime.step(1000.0 / 60.0);
        for (finger, event) in [(FINGER_A, TouchEvent::Ended), (FINGER_B, TouchEvent::Ended)] {
            runtime.inject(touches.handle(finger, event, (960.0, 540.0), &presentation).expect("delivered"));
        }
        runtime.step(1000.0 / 60.0);
        let fingers = runtime.probes()["fingers"].clone();
        assert_eq!(fingers, genex::json!(["0:began", "1:began", "0:ended", "1:ended"]));
    }
}
