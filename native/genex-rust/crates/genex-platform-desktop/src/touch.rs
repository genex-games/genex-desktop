//! Mouse-to-touch emulation (plan "The game API agents write", Input row): on desktop, Mouse1
//! drives one touch so touch controls and play scripts that reach them work with a mouse. The
//! touch has one id for its whole life, starts where Mouse1 went down, moves at most once a frame
//! (the last cursor position) and ends where it went up, or where the cursor was when focus left.
//!
//! The facade's desktop shell gives the merger Mouse1, and the facade emulates touch 0 from its
//! edges at the pointer (`genex::input`'s `touches_of`, unless a finger 0 is down), the same road a
//! Studio play script's click takes; these steps stay the shell's own record of that touch, and
//! [`TouchPhase`] the shell's own type.

use crate::letterbox::Letterbox;

/// The id of the touch Mouse1 emulates; a desktop never has a second one.
pub const MOUSE_TOUCH_ID: u32 = 0;
/// The most touch steps one frame carries: more is a flood of clicks, not a person.
pub const MAX_TOUCH_STEPS: usize = 16;

/// Where one finger is in its touch; the spellings are the wire's (`TouchPhase` in
/// `src/shared/preview-contract.ts`, `genex_studio::wire::TouchPhase`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TouchPhase {
    /// The finger went down.
    Start,
    /// The finger moved.
    Move,
    /// The finger lifted.
    End,
}

impl TouchPhase {
    /// Every phase, in wire order.
    pub const ALL: [TouchPhase; 3] = [TouchPhase::Start, TouchPhase::Move, TouchPhase::End];

    /// The phase's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            TouchPhase::Start => "start",
            TouchPhase::Move => "move",
            TouchPhase::End => "end",
        }
    }
}

/// One step of a touch, sampled for a frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SampledTouch {
    /// Ties a start to its moves and end.
    pub id: u32,
    /// Start, move or end.
    pub phase: TouchPhase,
    /// Where, as a fraction of the world frame (clamped into it, as the pointer is).
    pub at: [f32; 2],
}

/// A step waiting for the frame's letterbox: the cursor's window position, or none when the
/// cursor never moved (the step then sits where the pointer is).
#[derive(Clone, Copy, Debug, PartialEq)]
struct PendingStep {
    phase: TouchPhase,
    cursor: Option<[f32; 2]>,
}

/// The emulated touch between frames.
#[derive(Clone, Debug, Default)]
pub(crate) struct MouseTouch {
    down: bool,
    steps: Vec<PendingStep>,
    moved_to: Option<[f32; 2]>,
}

impl MouseTouch {
    fn push(&mut self, phase: TouchPhase, cursor: Option<[f32; 2]>) {
        if self.steps.len() < MAX_TOUCH_STEPS {
            self.steps.push(PendingStep { phase, cursor });
        }
    }

    /// Mouse1 went down at `cursor`; a repeated press is no new touch.
    pub fn press(&mut self, cursor: Option<[f32; 2]>) {
        if self.down {
            return;
        }
        self.down = true;
        self.moved_to = None;
        self.push(TouchPhase::Start, cursor);
    }

    /// Mouse1 went up (or focus left) at `cursor`; nothing ends twice.
    pub fn release(&mut self, cursor: Option<[f32; 2]>) {
        if !self.down {
            return;
        }
        self.down = false;
        // The end carries the last position, so a pending move would only repeat it.
        self.moved_to = None;
        self.push(TouchPhase::End, cursor);
    }

    /// The cursor moved to `cursor`; it counts only while the touch is down.
    pub fn cursor_moved(&mut self, cursor: [f32; 2]) {
        if self.down {
            self.moved_to = Some(cursor);
        }
    }

    /// The frame's steps through `letterbox`; `pointer` stands in for a cursor that never moved.
    pub fn take(&mut self, letterbox: Letterbox, pointer: [f32; 2]) -> Vec<SampledTouch> {
        if let Some(cursor) = self.moved_to.take() {
            self.push(TouchPhase::Move, Some(cursor));
        }
        let at = |cursor: Option<[f32; 2]>| cursor.map_or(pointer, |c| letterbox.fraction(c));
        let steps = std::mem::take(&mut self.steps);
        steps.into_iter().map(|step| SampledTouch { id: MOUSE_TOUCH_ID, phase: step.phase, at: at(step.cursor) }).collect()
    }
}
