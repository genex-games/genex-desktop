//! The opt-in prompt atlas (G6 input IN-16, release R-26): a game that opts in ships one PNG of
//! prompt icons and this index beside it, and a prompt draws its binding's icon instead of the
//! text cap. The icons are a subset of Kenney's Input Prompts (CC0 1.0, <https://kenney.nl>):
//! key caps, mouse buttons, face buttons by shape and letter, shoulders, triggers, sticks and the
//! d-pad, 64 px each. Shapes and letters only: no platform logo, product or brand name is packed.
//!
//! The atlas is display only, like every glyph: which cell a prompt draws never feeds back into
//! evaluation, the bindings digest or a checksum. A binding without a cell (a chord, a key pair,
//! a touch control) keeps its text glyph, and a game that does not opt in draws text glyphs only.
//!
//! The index is JSON: `{"format": "genex-glyph-atlas/1", "cell": 64, "size": [w, h],
//! "cells": {"key:KeyW": [x, y], "pad:south@playstation": [x, y], ...}}`. A cell is named by its
//! binding's wire spelling ([`Binding::wire`]); a pad button's face depends on the pad family, so
//! its name carries the family after `@`.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::binding::{Binding, PadFamily, wire_enum};
use crate::id::ActionId;
use crate::map::ActionMap;
use crate::state::Device;

/// The spelling of an atlas index's format.
pub const ATLAS_INDEX_FORMAT: &str = "genex-glyph-atlas/1";
/// The side of one cell, in pixels.
pub const ATLAS_CELL_PX: u32 = 64;
/// The most cells an atlas holds (about 250 are packed).
pub const ATLAS_CELLS_MAX: usize = 512;
/// The longest side of the atlas image, in pixels.
pub const ATLAS_SIDE_MAX: u32 = 2048;
/// The largest index file, in bytes.
pub const ATLAS_INDEX_BYTES_MAX: usize = 64 * 1024;
/// The longest cell name, in bytes.
pub const ATLAS_NAME_MAX: usize = 48;

wire_enum!(
    /// Why an atlas index was refused.
    AtlasProblem {
        /// The index is over its size cap or not JSON.
        NotJson = "not-json",
        /// The format or the cell size is not this version's.
        Format = "format",
        /// The image size is not a whole number of cells within the side cap.
        Size = "size",
        /// The cells are missing, too many, or two names share a cell.
        Cells = "cells",
        /// A cell name is empty, too long or holds a character outside printable ASCII.
        CellName = "cell-name",
        /// A cell is not on the cell grid or leaves the image.
        CellRect = "cell-rect",
    }
);

/// A loaded atlas index: where each binding's icon sits in the atlas image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlyphAtlas {
    size: [u32; 2],
    cells: BTreeMap<String, [u32; 2]>,
}

impl GlyphAtlas {
    /// The index in `bytes`, checked whole: the format, a grid-aligned image within the caps, and
    /// cells with printable names on distinct grid cells inside the image.
    pub fn from_index(bytes: &[u8]) -> Result<GlyphAtlas, AtlasProblem> {
        if bytes.len() > ATLAS_INDEX_BYTES_MAX {
            return Err(AtlasProblem::NotJson);
        }
        let index: Value = serde_json::from_slice(bytes).map_err(|_| AtlasProblem::NotJson)?;
        let format_ok = index["format"].as_str() == Some(ATLAS_INDEX_FORMAT) && index["cell"].as_u64() == Some(u64::from(ATLAS_CELL_PX));
        if !format_ok {
            return Err(AtlasProblem::Format);
        }
        let size = pair(&index["size"]).ok_or(AtlasProblem::Size)?;
        let size_ok = size.iter().all(|side| *side > 0 && *side <= ATLAS_SIDE_MAX && side % ATLAS_CELL_PX == 0);
        if !size_ok {
            return Err(AtlasProblem::Size);
        }
        let rows = index["cells"].as_object().ok_or(AtlasProblem::Cells)?;
        if rows.is_empty() || rows.len() > ATLAS_CELLS_MAX {
            return Err(AtlasProblem::Cells);
        }
        let mut cells = BTreeMap::new();
        for (name, at) in rows {
            let at = cell_at(name, at, size)?;
            if cells.values().any(|taken| *taken == at) {
                return Err(AtlasProblem::Cells);
            }
            cells.insert(name.clone(), at);
        }
        Ok(GlyphAtlas { size, cells })
    }

    /// The atlas image's size, in pixels.
    pub fn size(&self) -> [u32; 2] {
        self.size
    }

    /// How many cells it holds.
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    /// Whether it holds no cell (never true for a loaded index).
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// The cell `name`'s texture coordinates, `[min u, min v, max u, max v]` in 0..1.
    pub fn uv(&self, name: &str) -> Option<[f32; 4]> {
        let [x, y] = *self.cells.get(name)?;
        // Sides are at most ATLAS_SIDE_MAX: exact in f32.
        let [w, h] = [self.size[0] as f32, self.size[1] as f32];
        let cell = ATLAS_CELL_PX as f32;
        let [x, y] = [x as f32, y as f32];
        Some([x / w, y / h, (x + cell) / w, (y + cell) / h])
    }

    /// The texture coordinates of `binding`'s icon on a pad of `family`, if the atlas has one.
    pub fn binding_uv(&self, binding: &Binding, family: PadFamily) -> Option<[f32; 4]> {
        cell_name(binding, family).and_then(|name| self.uv(&name))
    }

    /// The texture coordinates of the icon for `action` on `device`: the binding its prompt reads
    /// ([`crate::glyph::action_glyph`]'s choice), if the atlas has a cell for it.
    pub fn action_uv(&self, map: &ActionMap, action: ActionId, device: Device) -> Option<[f32; 4]> {
        let binding = crate::glyph::prompt_binding(map, action, device)?;
        self.binding_uv(binding, crate::glyph::family_of(device))
    }
}

/// The cell name of `binding` on a pad of `family`: its wire spelling, with the family after `@`
/// for a pad button (a face reads by family). `None` for bindings no single icon shows (a chord,
/// a key pair or square, a half axis, a touch control, mouse look and the wheel).
pub fn cell_name(binding: &Binding, family: PadFamily) -> Option<String> {
    match binding {
        Binding::Pad(_) => Some(format!("{}@{}", binding.wire(), family.as_str())),
        Binding::Key(_) | Binding::Stick(_) | Binding::Dpad => Some(binding.wire()),
        Binding::PadAxis(..)
        | Binding::Keys2 { .. }
        | Binding::Keys4 { .. }
        | Binding::Chord(_)
        | Binding::Touch(_)
        | Binding::Look
        | Binding::Wheel => None,
    }
}

/// A `[a, b]` pair of whole numbers that fit u32.
fn pair(value: &Value) -> Option<[u32; 2]> {
    let [a, b] = value.as_array()?.as_slice() else { return None };
    Some([u32::try_from(a.as_u64()?).ok()?, u32::try_from(b.as_u64()?).ok()?])
}

/// One cell row: a printable name and a grid-aligned origin with the whole cell inside the image.
fn cell_at(name: &str, at: &Value, size: [u32; 2]) -> Result<[u32; 2], AtlasProblem> {
    let name_ok = !name.is_empty() && name.len() <= ATLAS_NAME_MAX && name.bytes().all(|byte| byte.is_ascii_graphic());
    if !name_ok {
        return Err(AtlasProblem::CellName);
    }
    let at = pair(at).ok_or(AtlasProblem::CellRect)?;
    let on_grid = at.iter().all(|origin| origin % ATLAS_CELL_PX == 0);
    let inside = at.iter().zip(size).all(|(origin, side)| origin.checked_add(ATLAS_CELL_PX).is_some_and(|end| end <= side));
    if !(on_grid && inside) {
        return Err(AtlasProblem::CellRect);
    }
    Ok(at)
}
