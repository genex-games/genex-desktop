//! genex-input's action goldens (IN-1): the red-first rows of the action core, driven through
//! genex-core's own input merger so a row presses keys and pads exactly as a run does.

mod actions;
mod modifiers;

use genex_core::input::{Injection, InputMerger, PAD_AXES, PAD_BUTTONS, PadState, TickInput};
use genex_input::map::ActionMap;
use genex_input::state::{ActionState, Devices, evaluate, evaluate_with};

/// A map, its action state and the merger that feeds it, stepped one tick at a time.
pub struct Rig {
    /// The map under test.
    pub map: ActionMap,
    /// Its action state.
    pub state: ActionState,
    /// genex-core's merger, which turns injections into tick input.
    pub merger: InputMerger,
    /// The pad family the device tracker would report.
    pub devices_family: genex_input::binding::PadFamily,
    /// Pad 0 as injected.
    pub pad: PadState,
}

impl Rig {
    /// A rig over a validated map.
    pub fn new(map: ActionMap) -> Rig {
        map.validate().expect("the test map validates");
        let state = ActionState::new(&map);
        Rig {
            map,
            state,
            merger: InputMerger::default(),
            devices_family: genex_input::binding::PadFamily::Generic,
            pad: PadState { connected: true, ..PadState::default() },
        }
    }

    /// Inject, take the next tick and evaluate it.
    pub fn step(&mut self, injection: Injection) -> TickInput {
        self.merger.inject(&injection);
        let tick = self.merger.next_tick();
        let devices = Devices { family: self.devices_family, touch: &[] };
        evaluate_with(&self.map, &mut self.state, &tick, &devices);
        tick
    }

    /// A tick with nothing new.
    pub fn idle(&mut self) -> TickInput {
        self.step(Injection::default())
    }

    /// Hold keys down.
    pub fn down(&mut self, keys: &[&str]) -> TickInput {
        self.step(Injection { down: names(keys), ..Injection::default() })
    }

    /// Release keys.
    pub fn up(&mut self, keys: &[&str]) -> TickInput {
        self.step(Injection { up: names(keys), ..Injection::default() })
    }

    /// Tap keys (down and up before the next tick).
    pub fn tap(&mut self, keys: &[&str]) -> TickInput {
        self.step(Injection { tap: names(keys), ..Injection::default() })
    }

    /// Set pad 0's button `index` to `value` and step.
    pub fn button(&mut self, index: usize, value: f32) -> TickInput {
        assert!(index < PAD_BUTTONS);
        self.pad.buttons[index] = value;
        self.step(Injection { pads: vec![(0, self.pad)], ..Injection::default() })
    }

    /// Set pad 0's axes and step.
    pub fn axes(&mut self, axes: [f32; PAD_AXES]) -> TickInput {
        self.pad.axes = axes;
        self.step(Injection { pads: vec![(0, self.pad)], ..Injection::default() })
    }
}

/// Owned key names.
pub fn names(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|key| (*key).to_owned()).collect()
}

/// Evaluate one tick input on a state with the default devices (used by the purity row).
pub fn eval(map: &ActionMap, state: &mut ActionState, tick: &TickInput) {
    evaluate(map, state, tick);
}
