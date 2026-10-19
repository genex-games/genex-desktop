//! World streaming on the facade: the registration a game makes once (`game.streaming`), the cell
//! builders (`game.cell_content`) and the display-only runtime key `__stream`.
//!
//! The sim set (`sim.stream`), the tick and the view set are stubs until STR-9 and STR-16 fill
//! them. `__stream` is never in the checksum (it hashes the seed, the tick and the game's probes),
//! so a game probe named `stream` keeps working.

use genex_core::cell::CellId;
use genex_core::digest::{fnv1a64, hex64};
use genex_core::json::Value as CoreValue;

pub use genex_stream::{StreamErrorCode, StreamTicket};

/// The smallest cell side, in metres.
pub const STREAM_CELL_SIZE_MIN: f32 = 8.0;
/// The largest cell side, in metres.
pub const STREAM_CELL_SIZE_MAX: f32 = 1024.0;
/// The `state()` key streaming adds while it is registered (display only).
pub(crate) const RUNTIME_KEY: &str = "__stream";

/// How a game streams its world: a grid of square cells. Register it once with `game.streaming`.
#[derive(Clone, Debug, PartialEq)]
pub struct Streaming {
    cell_size: f32,
}

impl Streaming {
    /// A grid of `cell_size`-metre cells anchored at world (0, 0), within
    /// [`STREAM_CELL_SIZE_MIN`]..=[`STREAM_CELL_SIZE_MAX`] (`install` refuses others
    /// `streaming-invalid`).
    pub fn grid(cell_size: f32) -> Streaming {
        Streaming { cell_size }
    }

    /// The cell side, in metres.
    pub fn cell_size(&self) -> f32 {
        self.cell_size
    }

    /// Whether `install` takes it: a cell size inside the caps (NaN never is).
    pub(crate) fn valid(&self) -> bool {
        (STREAM_CELL_SIZE_MIN..=STREAM_CELL_SIZE_MAX).contains(&self.cell_size)
    }
}

/// What a cell builder reads about the cell it builds.
#[derive(Clone, Debug, PartialEq)]
pub struct CellInputs {
    cell: CellId,
}

impl CellInputs {
    /// The cell being built.
    pub fn cell(&self) -> CellId {
        self.cell
    }
}

/// What a cell builder makes of a cell: things of the game's own type `T`.
#[derive(Clone, Debug, PartialEq)]
pub struct CellBuild<T> {
    things: Vec<T>,
}

impl<T> Default for CellBuild<T> {
    fn default() -> Self {
        CellBuild { things: Vec::new() }
    }
}

impl<T> CellBuild<T> {
    /// Add a thing the cell holds.
    pub fn thing(mut self, thing: T) -> CellBuild<T> {
        self.things.push(thing);
        self
    }

    /// The things, in the order they were added.
    pub fn things(&self) -> &[T] {
        &self.things
    }
}

/// One `game.cell_content` registration, its builder type-erased until STR-9 runs it.
pub(crate) struct CellContent {
    #[expect(dead_code, reason = "STR-9 runs the builders in the commit slot")]
    builder: Box<dyn std::any::Any + Send + Sync>,
}

impl CellContent {
    pub(crate) fn new<T: 'static, F>(builder: F) -> CellContent
    where
        F: Fn(CellId, &CellInputs) -> CellBuild<T> + Send + Sync + 'static,
    {
        CellContent { builder: Box::new(builder) }
    }
}

/// `state().__stream`: `{active, cells}`, the active cell count and the FNV-1a 64 of the active
/// cells. Nothing is active until STR-9 lands.
pub(crate) fn runtime_value() -> CoreValue {
    let mut value = CoreValue::object();
    value.set("active", CoreValue::from(0_u32));
    value.set("cells", CoreValue::from(hex64(fnv1a64(&[])).as_str()));
    value
}
