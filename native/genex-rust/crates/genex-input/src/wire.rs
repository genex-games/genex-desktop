//! The multiplayer action wire: one tick of a player's actions as a small JSON object for
//! genex-multiplayer's `send_to_host` (host-authoritative input, its §inputs channel). The client
//! sends `ActionState::to_wire(&map)`; the host reads it back with [`RemoteActions::from_wire`]
//! against the same map and drives that player's character from it. This crate does no
//! networking, sequencing or prediction: genex-multiplayer owns the channel and its seq/ack, and
//! the net layer never reads input itself.
//!
//! The object, with every member always present and in this order:
//!
//! - `v`: the format, 1.
//! - `t`: the client's tick count (`ActionState::ticks`), at most 2^53 - 1 so a JavaScript bridge
//!   reads it exactly.
//! - `s`: the map's shape digest ([`shape_digest`]: action ids and kinds in declaration order, 16
//!   hex digits). Player rebinding does not change it; a different game build does, and is refused.
//! - `d`, `p`, `r`, `f`: down, pressed, released and fired as 64-bit masks by action index, 16 hex
//!   digits each (hex, because a JSON number past 2^53 is not exact in JavaScript).
//! - `a`: every action's value components in declaration order (one for a button or 1D axis, two
//!   for a 2D axis) as i16: Q15 (value × 32767) for values in [-1, 1].
//! - `w`: a 128-bit mask of the components of `a` that are wide instead, in sixteenths (mouse look
//!   in pixels, the wheel, scaled axes; clamped to ±2048).
//!
//! A valid map's widest wire (the `ui` buttons plus 56 2D axes) is 1 028 bytes, measured in
//! `tests/wire.rs`, under [`WIRE_BYTES_MAX`]; MP's contract allows 16 KiB. Anything else is
//! refused `input-wire-invalid` and changes nothing.

use std::io;

use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from, hex64};
use serde_json::{Value, json};

use crate::binding::ActionKind;
use crate::error::{InputError, InputErrorCode};
use crate::id::ActionId;
use crate::map::{ACTIONS_MAX, ActionMap};
use crate::state::ActionState;

/// The wire format this crate writes and reads.
pub const WIRE_FORMAT: u64 = 1;
/// The largest wire accepted, serialized, in bytes (the widest legal wire is 1 028).
pub const WIRE_BYTES_MAX: usize = 1280;
/// The largest tick a wire carries: JavaScript's largest exact integer.
pub const WIRE_TICK_MAX: u64 = (1 << 53) - 1;
/// The most value components a map has: every action a 2D axis.
const COMPONENTS_MAX: usize = 2 * ACTIONS_MAX;
/// Q15: a unit value times this is its i16.
const UNIT_SCALE: f32 = 32767.0;
/// A wide value times this is its i16 (sixteenths).
const WIDE_SCALE: f32 = 16.0;
/// The members of a wire object, in the order they are written.
const MEMBERS: [&str; 9] = ["v", "t", "s", "d", "p", "r", "f", "w", "a"];

/// The digest of a map's shape: each action's id and kind in declaration order (FNV-1a 64). Two
/// builds of a game agree on it exactly when their action lists agree; bindings never enter it.
pub fn shape_digest(map: &ActionMap) -> u64 {
    map.actions().fold(FNV_OFFSET_BASIS, |hash, (id, kind)| {
        let hash = fnv1a64_from(id.name().as_bytes(), hash);
        let hash = fnv1a64_from(&[0], hash);
        let hash = fnv1a64_from(kind.as_str().as_bytes(), hash);
        fnv1a64_from(&[0], hash)
    })
}

/// The serialized length of `wire`, or None past [`WIRE_BYTES_MAX`]. It stops writing at the cap,
/// so a hostile value costs at most the cap to measure.
pub fn wire_len(wire: &Value) -> Option<usize> {
    let mut counter = Capped { len: 0 };
    serde_json::to_writer(&mut counter, wire).ok()?;
    Some(counter.len)
}

/// Counts bytes and fails once they pass the cap.
struct Capped {
    len: usize,
}

impl io::Write for Capped {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.len += buf.len();
        if self.len > WIRE_BYTES_MAX {
            return Err(io::Error::other("over the wire cap"));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn components(kind: ActionKind) -> usize {
    match kind {
        ActionKind::Axis2 => 2,
        ActionKind::Button | ActionKind::Axis1 => 1,
    }
}

/// A value as its i16 and whether it is wide (outside [-1, 1]). NaN sends 0.
fn quantize(value: f32) -> (i16, bool) {
    if value.is_nan() {
        return (0, false);
    }
    if (-1.0..=1.0).contains(&value) {
        return (libm::roundf(value * UNIT_SCALE) as i16, false);
    }
    let clamped = value.clamp(f32::from(i16::MIN) / WIDE_SCALE, f32::from(i16::MAX) / WIDE_SCALE);
    (libm::roundf(clamped * WIDE_SCALE) as i16, true)
}

fn dequantize(q: i16, wide: bool) -> f32 {
    let scale = if wide { WIDE_SCALE } else { UNIT_SCALE };
    f32::from(q) / scale
}

impl ActionState {
    /// This tick's actions as a wire for `send_to_host`. A map over the action cap (which never
    /// validates) encodes as null, which every receiver refuses. Encoding reads no action as the
    /// game would, so it adds nothing to `unknown_reads`.
    pub fn to_wire(&self, map: &ActionMap) -> Value {
        let actions: Vec<(ActionId, ActionKind)> = map.actions().collect();
        if actions.len() > ACTIONS_MAX {
            return Value::Null;
        }
        // Reads go through a copy: an id this state was not built for reads false or 0 there,
        // without being listed as the game's unknown read.
        let probe = self.clone();
        let mut masks = [0u64; 4];
        let mut wide = 0u128;
        let mut axes: Vec<i16> = Vec::with_capacity(COMPONENTS_MAX);
        for (at, (id, kind)) in actions.iter().enumerate() {
            let flags = [probe.down(*id), probe.pressed(*id), probe.released(*id), probe.fired(*id)];
            for (mask, set) in masks.iter_mut().zip(flags) {
                *mask |= u64::from(set) << at;
            }
            for component in &probe.axis2(*id)[..components(*kind)] {
                let (q, is_wide) = quantize(*component);
                wide |= u128::from(is_wide) << axes.len();
                axes.push(q);
            }
        }
        let [down, pressed, released, fired] = masks;
        json!({
            "v": WIRE_FORMAT,
            "t": self.ticks().min(WIRE_TICK_MAX),
            "s": hex64(shape_digest(map)),
            "d": hex64(down),
            "p": hex64(pressed),
            "r": hex64(released),
            "f": hex64(fired),
            "w": format!("{wide:032x}"),
            "a": axes,
        })
    }

    /// The host's reading of a client's wire against `map` (see [`RemoteActions::from_wire`]).
    pub fn from_wire(map: &ActionMap, wire: &Value) -> Result<RemoteActions, InputError> {
        RemoteActions::from_wire(map, wire)
    }
}

/// Another player's actions for one tick, as the host read them from that player's wire. Reads
/// take an id like `ActionState`'s; an id the map does not declare reads false or 0.
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteActions {
    ids: Vec<ActionId>,
    tick: u64,
    down: u64,
    pressed: u64,
    released: u64,
    fired: u64,
    values: Vec<[f32; 2]>,
}

impl RemoteActions {
    /// Nothing down at tick 0, for a player whose first wire has not arrived.
    pub fn new(map: &ActionMap) -> RemoteActions {
        let ids: Vec<ActionId> = map.actions().map(|(id, _)| id).collect();
        let values = vec![[0.0; 2]; ids.len()];
        RemoteActions { ids, tick: 0, down: 0, pressed: 0, released: 0, fired: 0, values }
    }

    /// Read a wire against `map`. Refused `input-wire-invalid`: over [`WIRE_BYTES_MAX`], not the
    /// exact object shape, another format, a negative, fractional or too large tick, another map's
    /// shape, bits for actions the map does not declare, pressed without down or released while
    /// down, a component count other than the map's, or a component that is not an integer in its
    /// range.
    pub fn from_wire(map: &ActionMap, wire: &Value) -> Result<RemoteActions, InputError> {
        if wire_len(wire).is_none() {
            return Err(invalid(format!("a wire over {WIRE_BYTES_MAX} bytes")));
        }
        let Value::Object(object) = wire else {
            return Err(invalid("a wire is an object"));
        };
        let exact = object.len() == MEMBERS.len() && MEMBERS.iter().all(|member| object.contains_key(*member));
        if !exact {
            return Err(invalid(format!("a wire has exactly the members {MEMBERS:?}")));
        }
        if object["v"].as_u64() != Some(WIRE_FORMAT) {
            return Err(invalid(format!("not wire format {WIRE_FORMAT}")));
        }
        let tick = object["t"].as_u64().filter(|tick| *tick <= WIRE_TICK_MAX);
        let tick = tick.ok_or_else(|| invalid(format!("the tick is not an integer in 0..={WIRE_TICK_MAX}")))?;
        let layout = Layout::of(map)?;
        if hex_u64(&object["s"]) != Some(shape_digest(map)) {
            return Err(invalid("the wire was written for another action map"));
        }
        let [down, pressed, released, fired] = ["d", "p", "r", "f"].map(|member| layout.mask(&object[member]));
        let (down, pressed, released, fired) = (down?, pressed?, released?, fired?);
        if pressed & !down != 0 || released & down != 0 {
            return Err(invalid("pressed without down, or released while down"));
        }
        let values = layout.values(&object["w"], &object["a"])?;
        Ok(RemoteActions { ids: layout.ids, tick, down, pressed, released, fired, values })
    }

    /// Read a wire from its bytes: at most [`WIRE_BYTES_MAX`], one JSON value, then
    /// [`RemoteActions::from_wire`].
    pub fn from_wire_bytes(map: &ActionMap, bytes: &[u8]) -> Result<RemoteActions, InputError> {
        if bytes.len() > WIRE_BYTES_MAX {
            return Err(invalid(format!("{} bytes, over {WIRE_BYTES_MAX}", bytes.len())));
        }
        let wire: Value =
            serde_json::from_slice(bytes).map_err(|error| invalid(format!("not one JSON value: {error}")))?;
        RemoteActions::from_wire(map, &wire)
    }

    /// Take the next wire; a refused one leaves this reading as it was.
    pub fn accept(&mut self, map: &ActionMap, wire: &Value) -> Result<(), InputError> {
        *self = RemoteActions::from_wire(map, wire)?;
        Ok(())
    }

    /// The client's tick count when it wrote the wire.
    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// Whether `action` is down.
    pub fn down(&self, action: ActionId) -> bool {
        self.bit(self.down, action)
    }

    /// Whether `action` went down on the client's tick.
    pub fn pressed(&self, action: ActionId) -> bool {
        self.bit(self.pressed, action)
    }

    /// Whether `action` came up on the client's tick.
    pub fn released(&self, action: ActionId) -> bool {
        self.bit(self.released, action)
    }

    /// Whether `action`'s conditions fired on the client's tick.
    pub fn fired(&self, action: ActionId) -> bool {
        self.bit(self.fired, action)
    }

    /// The value of a button or 1D axis (a 2D axis answers its x).
    pub fn value(&self, action: ActionId) -> f32 {
        self.axis2(action)[0]
    }

    /// The value of a 2D axis, x right and y down.
    pub fn axis2(&self, action: ActionId) -> [f32; 2] {
        self.index(action).map_or([0.0, 0.0], |at| self.values[at])
    }

    fn index(&self, action: ActionId) -> Option<usize> {
        self.ids.iter().position(|id| *id == action)
    }

    fn bit(&self, mask: u64, action: ActionId) -> bool {
        self.index(action).is_some_and(|at| (mask >> at) & 1 == 1)
    }
}

/// The map's actions as the wire lays them out.
struct Layout {
    ids: Vec<ActionId>,
    kinds: Vec<ActionKind>,
    components: usize,
}

impl Layout {
    fn of(map: &ActionMap) -> Result<Layout, InputError> {
        let (ids, kinds): (Vec<ActionId>, Vec<ActionKind>) = map.actions().unzip();
        if ids.len() > ACTIONS_MAX {
            return Err(invalid(format!("the map has {} actions, over {ACTIONS_MAX}", ids.len())));
        }
        let components = kinds.iter().map(|kind| components(*kind)).sum();
        Ok(Layout { ids, kinds, components })
    }

    /// A 16-hex-digit mask with no bit past the map's actions.
    fn mask(&self, member: &Value) -> Result<u64, InputError> {
        let mask = hex_u64(member).ok_or_else(|| invalid("a mask is 16 lower-case hex digits"))?;
        let unknown = mask.checked_shr(self.ids.len() as u32).unwrap_or(0);
        if unknown != 0 {
            return Err(invalid("a mask names actions the map does not declare"));
        }
        Ok(mask)
    }

    /// Each action's value from the wide mask and the components.
    fn values(&self, wide: &Value, axes: &Value) -> Result<Vec<[f32; 2]>, InputError> {
        let wide = hex_digits(wide, 32).and_then(|digits| u128::from_str_radix(digits, 16).ok());
        let wide = wide.ok_or_else(|| invalid("the wide mask is 32 lower-case hex digits"))?;
        if wide.checked_shr(self.components as u32).unwrap_or(0) != 0 {
            return Err(invalid("the wide mask names components the map does not have"));
        }
        let axes = axes.as_array().filter(|axes| axes.len() == self.components);
        let axes = axes.ok_or_else(|| invalid(format!("the map has {} value components", self.components)))?;
        let mut decoded = axes.iter().enumerate().map(|(at, q)| component(q, (wide >> at) & 1 == 1));
        let mut values = Vec::with_capacity(self.kinds.len());
        for kind in &self.kinds {
            let mut value = [0.0; 2];
            for slot in value.iter_mut().take(components(*kind)) {
                *slot = decoded.next().unwrap_or(Ok(0.0))?;
            }
            values.push(value);
        }
        Ok(values)
    }
}

/// One component: an integer in i16 (a unit one within ±32767, so -1 has one spelling).
fn component(q: &Value, wide: bool) -> Result<f32, InputError> {
    let low = if wide { i64::from(i16::MIN) } else { -i64::from(i16::MAX) };
    let q = q.as_i64().filter(|q| (low..=i64::from(i16::MAX)).contains(q));
    let q = q.ok_or_else(|| invalid("a value component is an integer in i16 range"))?;
    // In range by the filter above.
    Ok(dequantize(q as i16, wide))
}

/// `value` as exactly `len` lower-case hex digits.
fn hex_digits(value: &Value, len: usize) -> Option<&str> {
    let text = value.as_str()?;
    let digits = text.len() == len && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    digits.then_some(text)
}

fn hex_u64(value: &Value) -> Option<u64> {
    hex_digits(value, 16).and_then(|digits| u64::from_str_radix(digits, 16).ok())
}

fn invalid(detail: impl Into<String>) -> InputError {
    InputError::new(InputErrorCode::WireInvalid, detail)
}
