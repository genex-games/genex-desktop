//! Accessibility settings the player edits, kept in the action map (so every game gets them) and
//! saved in `genex-input.json` next to the bindings: hold or toggle per button action, per-stick
//! dead zones, trigger thresholds, inverted look, swapped sticks and a slow-press stretch for
//! tap windows.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::binding::wire_enum;
use crate::blob::{Node, checked_name, invalid, object};
use crate::error::{InputError, InputErrorCode};
use crate::id::ActionId;
use crate::map::ActionMap;
use crate::modifier::{BUTTON_PRESS, BUTTON_RELEASE, STICK_DEAD_ZONE, thresholds_ok};

/// The largest stick dead zone a player can set (past it the stick barely moves anything).
pub const STICK_DEAD_ZONE_MAX: f32 = 0.9;
/// The slow-press stretch's range, in percent of the game's tap window.
pub const SLOW_PRESS_PERCENT_MIN: u16 = 100;
/// The largest slow-press stretch, in percent.
pub const SLOW_PRESS_PERCENT_MAX: u16 = 400;

wire_enum!(
    /// How a button action follows its input.
    HoldMode {
        /// Down while the input is held (the default).
        Hold = "hold",
        /// Each press latches it down or up.
        Toggle = "toggle",
    }
);

/// The player's accessibility settings.
#[derive(Clone, Debug, PartialEq)]
pub struct Access {
    /// Button actions the player switched from hold to toggle (absent means hold).
    pub hold_mode: BTreeMap<ActionId, HoldMode>,
    /// Radial dead zone per stick (left, right), in [0, 0.9].
    pub stick_dead_zone: [f32; 2],
    /// The value at which an analog input presses a button action.
    pub trigger_press: f32,
    /// The value at or below which it releases; below `trigger_press`.
    pub trigger_release: f32,
    /// Flip y per stick (left, right).
    pub invert_y: [bool; 2],
    /// Read the left stick as the right and the right as the left.
    pub swap_sticks: bool,
    /// Stretch tap windows for slow presses, in percent (100 = as the game wrote them).
    pub slow_press_percent: u16,
}

impl Default for Access {
    fn default() -> Self {
        Access {
            hold_mode: BTreeMap::new(),
            stick_dead_zone: [STICK_DEAD_ZONE; 2],
            trigger_press: BUTTON_PRESS,
            trigger_release: BUTTON_RELEASE,
            invert_y: [false; 2],
            swap_sticks: false,
            slow_press_percent: SLOW_PRESS_PERCENT_MIN,
        }
    }
}

impl Access {
    /// Whether every value is in range (the map checks that `hold_mode` names button actions).
    pub fn validate(&self) -> Result<(), InputError> {
        let invalid = |what: &str| Err(InputError::new(InputErrorCode::AccessInvalid, what.to_owned()));
        let zone_ok = |zone: f32| zone.is_finite() && (0.0..=STICK_DEAD_ZONE_MAX).contains(&zone);
        if !self.stick_dead_zone.iter().all(|zone| zone_ok(*zone)) {
            return invalid("a stick dead zone is outside 0 to 0.9");
        }
        if !thresholds_ok(self.trigger_press, self.trigger_release) {
            return invalid("trigger thresholds need 0 <= release < press <= 1");
        }
        if !(SLOW_PRESS_PERCENT_MIN..=SLOW_PRESS_PERCENT_MAX).contains(&self.slow_press_percent) {
            return invalid("slow press is outside 100 to 400 percent");
        }
        Ok(())
    }

    /// The hold mode of `action`.
    pub fn mode(&self, action: ActionId) -> HoldMode {
        self.hold_mode.get(&action).copied().unwrap_or(HoldMode::Hold)
    }
}

/// The settings as the bindings file writes them: every field, toggles only in `holdMode`.
pub(crate) fn access_json(access: &Access) -> Value {
    let mut hold = Map::new();
    for (action, mode) in access.hold_mode.iter().filter(|(_, mode)| **mode == HoldMode::Toggle) {
        hold.insert(action.name().to_owned(), Value::String(mode.as_str().to_owned()));
    }
    let pair = |values: [f32; 2]| Value::Array(values.into_iter().map(number).collect());
    let flags = |values: [bool; 2]| Value::Array(values.into_iter().map(Value::Bool).collect());
    let mut out = Map::new();
    out.insert("holdMode".to_owned(), Value::Object(hold));
    out.insert("stickDeadZone".to_owned(), pair(access.stick_dead_zone));
    out.insert("triggerPress".to_owned(), number(access.trigger_press));
    out.insert("triggerRelease".to_owned(), number(access.trigger_release));
    out.insert("invertY".to_owned(), flags(access.invert_y));
    out.insert("swapSticks".to_owned(), Value::Bool(access.swap_sticks));
    out.insert("slowPressPercent".to_owned(), Value::from(access.slow_press_percent));
    Value::Object(out)
}

/// An f32 written by its shortest spelling (0.15, not 0.15000000596046448); reading it back as
/// f32 gives the same bits.
fn number(value: f32) -> Value {
    let shortest: f64 = value.to_string().parse().unwrap_or(0.0);
    Value::from(shortest)
}

/// The settings a bindings file holds; absent fields keep their defaults. Hold modes for actions
/// the map does not declare go to `stale`. Shapes are checked here (`input-bindings-invalid`),
/// ranges by the map (`input-access-invalid`).
pub(crate) fn access_from(node: &Node, map: &ActionMap, stale: &mut Vec<String>) -> Result<Access, InputError> {
    let mut access = Access::default();
    for (name, value) in object(node, "access")? {
        match name.as_str() {
            "holdMode" => access.hold_mode = hold_modes(value, map, stale)?,
            "stickDeadZone" => access.stick_dead_zone = numbers(value, name)?,
            "triggerPress" => access.trigger_press = float(value, name)?,
            "triggerRelease" => access.trigger_release = float(value, name)?,
            "invertY" => access.invert_y = flags(value, name)?,
            "swapSticks" => access.swap_sticks = flag(value, name)?,
            "slowPressPercent" => access.slow_press_percent = percent(value)?,
            other => return Err(invalid(format!("unknown setting {:?}", other.chars().take(40).collect::<String>()))),
        }
    }
    Ok(access)
}

fn hold_modes(
    node: &Node,
    map: &ActionMap,
    stale: &mut Vec<String>,
) -> Result<BTreeMap<ActionId, HoldMode>, InputError> {
    let mut modes = BTreeMap::new();
    for (name, value) in object(node, "holdMode")? {
        let Node::String(spelling) = value else { return Err(invalid("a hold mode is not a string")) };
        let mode = HoldMode::from_wire(spelling).ok_or_else(|| invalid("a hold mode is not hold or toggle"))?;
        let Some(action) = map.action_named(checked_name(name)?) else {
            stale.push(name.clone());
            continue;
        };
        if mode == HoldMode::Toggle {
            modes.insert(action, mode);
        }
    }
    Ok(modes)
}

fn float(node: &Node, name: &str) -> Result<f32, InputError> {
    match node {
        Node::Number(value) => Ok(*value as f32),
        _ => Err(invalid(format!("{name} is not a number"))),
    }
}

fn numbers(node: &Node, name: &str) -> Result<[f32; 2], InputError> {
    match node {
        Node::Array(items) if items.len() == 2 => Ok([float(&items[0], name)?, float(&items[1], name)?]),
        _ => Err(invalid(format!("{name} is not two numbers"))),
    }
}

fn flag(node: &Node, name: &str) -> Result<bool, InputError> {
    match node {
        Node::Bool(value) => Ok(*value),
        _ => Err(invalid(format!("{name} is not true or false"))),
    }
}

fn flags(node: &Node, name: &str) -> Result<[bool; 2], InputError> {
    match node {
        Node::Array(items) if items.len() == 2 => Ok([flag(&items[0], name)?, flag(&items[1], name)?]),
        _ => Err(invalid(format!("{name} is not two flags"))),
    }
}

/// A whole number of percent; the range is the map's to judge.
fn percent(node: &Node) -> Result<u16, InputError> {
    let Node::Number(value) = node else { return Err(invalid("slowPressPercent is not a number")) };
    let whole = value.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(value);
    if !whole {
        // Out of u16 entirely: still a range problem when it is a whole number.
        let code = if value.fract() == 0.0 { InputErrorCode::AccessInvalid } else { InputErrorCode::BindingsInvalid };
        return Err(InputError::new(code, "slowPressPercent is not a whole percent in range"));
    }
    Ok(*value as u16)
}
