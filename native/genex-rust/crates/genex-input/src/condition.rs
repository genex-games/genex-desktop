//! Conditions: when an actuated action fires. Every window is counted in ticks, never seconds,
//! so a replay of the same tick input fires on the same ticks on every destination.
//!
//! Semantics ported from bevy_enhanced_input's input conditions (Hold, Tap, Pulse, Toggle,
//! Cooldown, BlockBy), restated in ticks: <https://github.com/simgine/bevy_enhanced_input>,
//! tag v0.27.0, commit d7be47fd91184c1bb1ff1f5a40d073d36a18547e, `src/condition/*.rs`,
//! MIT (dual MIT OR Apache-2.0, MIT side taken). No code was copied; the state machines are
//! rewritten around this crate's hold counter.

use crate::id::ActionId;

/// When an action fires. With no condition an action fires while it is down; several conditions
/// must all fire, and `BlockBy` vetoes.
///
/// "Hold tick" below is the number of ticks since the action went down: 0 on the tick it went
/// down, 1 on the next.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Condition {
    /// Fires on every tick the action is down (the default).
    Down,
    /// Fires on the tick the action went down.
    Press,
    /// Fires on the tick the action came up.
    Release,
    /// Fires from hold tick `ticks` on while it stays down; with `one_shot`, only on that tick.
    Hold {
        /// The hold tick it first fires on.
        ticks: u16,
        /// Fire once per press instead of on every tick after.
        one_shot: bool,
    },
    /// Fires on the release of a press that was down for at most `max_ticks` ticks (stretched
    /// by the player's slow-press setting).
    Tap {
        /// The longest press that still counts as a tap, in ticks.
        max_ticks: u16,
    },
    /// Fires on hold tick 0, then on hold tick `first`, then every `every` ticks after.
    Pulse {
        /// The hold tick of the first repeat.
        first: u16,
        /// Ticks between repeats after the first (0: no more repeats).
        every: u16,
    },
    /// Each press flips it on or off; fires while on.
    Toggle,
    /// Fires while down, then not again until `ticks` ticks have passed.
    Cooldown {
        /// Ticks between two firings.
        ticks: u16,
    },
    /// Never fires on a tick the named action fires.
    BlockBy(ActionId),
}

/// What one condition remembers between ticks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ConditionMemory {
    /// Toggle: on. Hold one-shot: already fired this press.
    pub(crate) latch: bool,
    /// Cooldown: ticks still to wait.
    pub(crate) wait: u16,
}

/// One tick of an action, as conditions see it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Edge {
    /// Down on this tick.
    pub(crate) down: bool,
    /// Down on the previous tick.
    pub(crate) was_down: bool,
    /// Hold tick while down.
    pub(crate) held: u32,
    /// For a release tick: how many ticks the press lasted.
    pub(crate) press_ticks: u32,
    /// The player's slow-press stretch, in percent (100 = none).
    pub(crate) slow_percent: u16,
}

impl Condition {
    /// Whether this condition fires on this tick (BlockBy answers true; the veto is applied once
    /// every action's own conditions are known).
    pub(crate) fn step(self, edge: Edge, memory: &mut ConditionMemory) -> bool {
        let rising = edge.down && !edge.was_down;
        match self {
            Condition::Down => edge.down,
            Condition::BlockBy(_) => true,
            Condition::Press => rising,
            Condition::Release => !edge.down && edge.was_down,
            Condition::Hold { ticks, one_shot } => hold(edge, u32::from(ticks), one_shot, memory),
            Condition::Tap { max_ticks } => {
                let window = u32::from(max_ticks) * u32::from(edge.slow_percent) / 100;
                !edge.down && edge.was_down && edge.press_ticks <= window
            }
            Condition::Pulse { first, every } => edge.down && pulse(edge.held, u32::from(first), u32::from(every)),
            Condition::Toggle => {
                if rising {
                    memory.latch = !memory.latch;
                }
                memory.latch
            }
            Condition::Cooldown { ticks } => {
                memory.wait = memory.wait.saturating_sub(1);
                let fire = edge.down && memory.wait == 0;
                if fire {
                    memory.wait = ticks;
                }
                fire
            }
        }
    }

    /// The action this condition defers to, for `BlockBy`.
    pub fn blocker(self) -> Option<ActionId> {
        match self {
            Condition::BlockBy(action) => Some(action),
            _ => None,
        }
    }
}

fn hold(edge: Edge, ticks: u32, one_shot: bool, memory: &mut ConditionMemory) -> bool {
    if !edge.down {
        memory.latch = false;
        return false;
    }
    if edge.held < ticks {
        return false;
    }
    if !one_shot {
        return true;
    }
    let first = !memory.latch;
    memory.latch = true;
    first
}

fn pulse(held: u32, first: u32, every: u32) -> bool {
    if held == 0 || held == first {
        return true;
    }
    every > 0 && held > first && (held - first).is_multiple_of(every)
}
