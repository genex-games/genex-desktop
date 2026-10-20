//! Modifiers: how an action's raw value is shaped before it is read. All float math is libm, so
//! every destination computes the same bits.
//!
//! Ported math:
//! - The radial dead zone is Godot's `Input::get_vector` (zero inside the dead zone, normalized
//!   past length 1, otherwise the length inverse-lerped from the dead zone to 1):
//!   <https://github.com/godotengine/godot>, tag 4.5-stable, commit
//!   876b290332ec6f2e6d173d08162a02aa7e6ca46d, `core/input/input.cpp`, MIT. Here the outer edge
//!   is `upper` instead of a fixed 1.
//! - The axial dead zone (per-axis linear remap between dead zone and live zone) and the button
//!   hysteresis defaults 0.75 press / 0.65 release are bevy_input's `AxisSettings` and
//!   `ButtonSettings`: <https://github.com/bevyengine/bevy>, tag v0.17.2, commit
//!   566358363126dd69f6e457e47f306c68f8041d2a, `crates/bevy_input/src/gamepad.rs`, MIT (dual MIT
//!   OR Apache-2.0, MIT side taken).
//! - Negate, swizzle, scale and the exponential curve follow bevy_enhanced_input's modifiers
//!   (tag v0.27.0, commit d7be47fd91184c1bb1ff1f5a40d073d36a18547e, `src/modifier/*.rs`, MIT side).

/// How a dead zone measures a 2D value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DeadZoneKind {
    /// On the vector's length, keeping its direction (sticks).
    Radial,
    /// On each axis on its own (triggers, single axes).
    Axial,
}

/// A step that shapes an action's value. Modifiers run in the order they were added.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Modifier {
    /// Zero up to `lower`, full from `upper`, linear between.
    DeadZone {
        /// Radial or per axis.
        kind: DeadZoneKind,
        /// The dead zone's edge, in [0, upper).
        lower: f32,
        /// Where the value reaches 1, in (lower, 1].
        upper: f32,
    },
    /// A button's press and release thresholds: down from `press`, up again at `release`.
    Hysteresis {
        /// The value that presses, in (release, 1].
        press: f32,
        /// The value at or below which it releases, in [0, press).
        release: f32,
    },
    /// Flip the sign of x, y or both.
    Negate {
        /// Flip x.
        x: bool,
        /// Flip y.
        y: bool,
    },
    /// Swap x and y.
    Swizzle,
    /// Multiply each axis.
    Scale {
        /// The x factor.
        x: f32,
        /// The y factor.
        y: f32,
    },
    /// Raise each axis's magnitude to `exponent`, keeping its sign (finer aim near the centre).
    Curve {
        /// A positive exponent; 1 is linear.
        exponent: f32,
    },
}

/// The radial dead zone sticks get when their action names none, as a fraction of full travel.
pub const STICK_DEAD_ZONE: f32 = 0.15;
/// The default value at which an analog source presses a button action.
pub const BUTTON_PRESS: f32 = 0.75;
/// The default value at or below which a pressed button action releases.
pub const BUTTON_RELEASE: f32 = 0.65;

impl Modifier {
    /// Whether the parameters can work (finite, in range).
    pub fn is_valid(&self) -> bool {
        match *self {
            Modifier::DeadZone { lower, upper, .. } => {
                lower.is_finite() && upper.is_finite() && lower >= 0.0 && lower < upper && upper <= 1.0
            }
            Modifier::Hysteresis { press, release } => thresholds_ok(press, release),
            Modifier::Negate { .. } | Modifier::Swizzle => true,
            Modifier::Scale { x, y } => x.is_finite() && y.is_finite(),
            Modifier::Curve { exponent } => exponent.is_finite() && exponent > 0.0,
        }
    }

    /// Shape `value` (hysteresis shapes actuation, not the value, and passes it through).
    pub fn apply(&self, value: [f32; 2]) -> [f32; 2] {
        let [x, y] = value;
        match *self {
            Modifier::DeadZone { kind: DeadZoneKind::Radial, lower, upper } => radial(value, lower, upper),
            Modifier::DeadZone { kind: DeadZoneKind::Axial, lower, upper } => {
                [axial(x, lower, upper), axial(y, lower, upper)]
            }
            Modifier::Hysteresis { .. } => value,
            Modifier::Negate { x: nx, y: ny } => [if nx { -x } else { x }, if ny { -y } else { y }],
            Modifier::Swizzle => [y, x],
            Modifier::Scale { x: sx, y: sy } => [x * sx, y * sy],
            Modifier::Curve { exponent } => [curve(x, exponent), curve(y, exponent)],
        }
    }
}

/// Whether a press and release threshold pair works: `0 <= release < press <= 1`.
pub fn thresholds_ok(press: f32, release: f32) -> bool {
    press.is_finite() && release.is_finite() && release >= 0.0 && release < press && press <= 1.0
}

/// Godot's radial dead zone, with `upper` as the outer edge.
pub fn radial(value: [f32; 2], lower: f32, upper: f32) -> [f32; 2] {
    let [x, y] = value;
    let length = libm::sqrtf(x * x + y * y);
    if length <= lower {
        return [0.0, 0.0];
    }
    if length >= upper {
        return [x / length, y / length];
    }
    let scaled = (length - lower) / (upper - lower);
    [x * (scaled / length), y * (scaled / length)]
}

/// bevy_input's per-axis remap: zero inside `lower`, ±1 past `upper`, linear between.
pub fn axial(value: f32, lower: f32, upper: f32) -> f32 {
    let magnitude = libm::fabsf(value);
    if magnitude <= lower {
        return 0.0;
    }
    let sign = if value < 0.0 { -1.0 } else { 1.0 };
    if magnitude >= upper {
        return sign;
    }
    sign * (magnitude - lower) / (upper - lower)
}

fn curve(value: f32, exponent: f32) -> f32 {
    let shaped = libm::powf(libm::fabsf(value), exponent);
    if value < 0.0 { -shaped } else { shaped }
}
