//! `StreamState` saves (STR-12): the anchors, the kept cells and the active cells as one value a
//! game writes into its save, and the checks a restore makes before it changes anything.
//!
//! Restore is a canonical rebuild (owner call S5): nothing of a cell's content is saved. The facade
//! makes the saved active set the base of the next commit, which leaves the cells the snapshot does
//! not hold (descending) and enters the ones it does (ascending) through the commit hooks, so
//! streamed colliders and nav islands are rebuilt by their builders in canonical order. Two
//! restores of one snapshot replay equal to each other on every destination. Physics state the
//! hooks do not rebuild (Rapier's arena generations, contact caches, sleep state) is not saved, so
//! a scene with dynamic bodies is not promised equal to the run that never restored.
//!
//! The form, version 1 (every cell `[x, z]`, cells ascending, anchors by name):
//! `{"version": 1, "cellSizeBits": <f32 bits>, "anchors": [[name, x, z], ...], "kept": [[x, z], ...],
//! "active": [[x, z], ...]}`.

use std::collections::{BTreeMap, BTreeSet};

use genex_core::cell::CellId;
use genex_core::json::Value;

use crate::error::{StreamError, StreamErrorCode};
use crate::grid::{Grid, STREAM_ANCHORS_MAX, SimRadii};

/// The snapshot form this crate writes and restores.
pub const STREAM_SNAPSHOT_VERSION: u64 = 1;
/// The most cells `sim.stream.keep` holds in the sim set at once.
pub const STREAM_KEPT_MAX: usize = 64;
/// The longest anchor name, in characters (the facade's `set_anchor` holds the same cap).
pub const STREAM_ANCHOR_NAME_MAX_CHARS: usize = 64;

/// What a streaming save holds: the anchors by name, the kept cells and the active cells.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamSnapshot {
    /// The anchors' cells, by name.
    pub anchors: BTreeMap<String, CellId>,
    /// The cells the game keeps in the sim set wherever the anchors are.
    pub kept: BTreeSet<CellId>,
    /// The cells the next commit starts from.
    pub active: BTreeSet<CellId>,
}

/// Whether `name` is an anchor name `set_anchor` takes: not blank, at most
/// [`STREAM_ANCHOR_NAME_MAX_CHARS`] characters and no control character.
pub fn anchor_name_valid(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= STREAM_ANCHOR_NAME_MAX_CHARS && !name.chars().any(char::is_control)
}

/// The most active cells a registration's sim set can hold: every anchor's square out to
/// `radius + hysteresis`, plus the kept cells.
pub fn active_max(radii: SimRadii, max_anchors: usize) -> usize {
    let side = 2 * (radii.radius as usize + radii.hysteresis as usize) + 1;
    max_anchors.min(STREAM_ANCHORS_MAX) * side * side + STREAM_KEPT_MAX
}

fn invalid(detail: impl Into<String>) -> StreamError {
    StreamError::new(StreamErrorCode::SnapshotInvalid, detail)
}

fn cell_value(cell: CellId) -> Value {
    Value::Array(vec![Value::from(cell.x), Value::from(cell.z)])
}

/// A whole number that fits an `i32` cell coordinate.
fn coordinate(value: &Value) -> Option<i32> {
    let Value::Number(number) = value else { return None };
    let whole = number.fract() == 0.0 && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(number);
    // A whole number inside the i32 range converts exactly.
    whole.then_some(*number as i32)
}

fn cell_from(items: &[Value], grid: &Grid, what: &str) -> Result<CellId, StreamError> {
    let [x, z] = items else { return Err(invalid(format!("{what}: a cell is [x, z]"))) };
    let (Some(x), Some(z)) = (coordinate(x), coordinate(z)) else {
        return Err(invalid(format!("{what}: a cell coordinate is not a whole number")));
    };
    let cell = CellId::new(x, z);
    if !grid.contains(cell) {
        return Err(invalid(format!("{what}: cell ({x}, {z}) is outside the world")));
    }
    Ok(cell)
}

/// A list of cells, ascending and without repeats, at most `max` long.
fn cells_from(value: Option<&Value>, grid: &Grid, what: &str, max: usize) -> Result<BTreeSet<CellId>, StreamError> {
    let Some(Value::Array(items)) = value else { return Err(invalid(format!("{what}: missing or not a list"))) };
    if items.len() > max {
        return Err(invalid(format!("{what}: {} cells (max {max})", items.len())));
    }
    let mut cells = BTreeSet::new();
    for item in items {
        let Value::Array(pair) = item else { return Err(invalid(format!("{what}: a cell is [x, z]"))) };
        let cell = cell_from(pair, grid, what)?;
        if cells.last().is_some_and(|last| *last >= cell) {
            return Err(invalid(format!("{what}: cells out of order or repeated at ({}, {})", cell.x, cell.z)));
        }
        cells.insert(cell);
    }
    Ok(cells)
}

fn anchor_from(item: &Value, grid: &Grid) -> Result<(String, CellId), StreamError> {
    let Value::Array(entry) = item else { return Err(invalid("anchors: an anchor is [name, x, z]")) };
    let [Value::String(name), rest @ ..] = entry.as_slice() else { return Err(invalid("anchors: an anchor is [name, x, z]")) };
    let name = std::str::from_utf8(name).ok().filter(|name| anchor_name_valid(name)).ok_or_else(|| invalid("anchors: a name set_anchor refuses"))?;
    Ok((name.to_owned(), cell_from(rest, grid, "anchors")?))
}

fn anchors_from(value: Option<&Value>, grid: &Grid, max_anchors: usize) -> Result<BTreeMap<String, CellId>, StreamError> {
    let Some(Value::Array(items)) = value else { return Err(invalid("anchors: missing or not a list")) };
    if items.len() > max_anchors {
        return Err(invalid(format!("anchors: {} (max {max_anchors})", items.len())));
    }
    let mut anchors = BTreeMap::new();
    for item in items {
        let (name, cell) = anchor_from(item, grid)?;
        if anchors.contains_key(&name) {
            return Err(invalid(format!("anchors: {name:?} twice")));
        }
        anchors.insert(name, cell);
    }
    Ok(anchors)
}

impl StreamSnapshot {
    /// The snapshot as a value for a save, on `grid`.
    pub fn to_value(&self, grid: &Grid) -> Value {
        let anchor = |(name, cell): (&String, &CellId)| Value::Array(vec![Value::from(name.as_str()), Value::from(cell.x), Value::from(cell.z)]);
        let mut out = Value::object();
        out.set("version", Value::from(STREAM_SNAPSHOT_VERSION));
        out.set("cellSizeBits", Value::from(grid.cell_size().to_bits()));
        out.set("anchors", Value::Array(self.anchors.iter().map(anchor).collect()));
        out.set("kept", Value::Array(self.kept.iter().copied().map(cell_value).collect()));
        out.set("active", Value::Array(self.active.iter().copied().map(cell_value).collect()));
        out
    }

    /// Read a snapshot for a registration on `grid` with `radii` and at most `max_anchors`
    /// anchors. Refuses `stream-snapshot-invalid`: another version or cell size, a field missing or
    /// of the wrong kind, a cell outside the world or out of order, an anchor name `set_anchor`
    /// refuses, or more anchors, kept cells ([`STREAM_KEPT_MAX`]) or active cells
    /// ([`active_max`]) than the registration holds.
    pub fn from_value(value: &Value, grid: &Grid, radii: SimRadii, max_anchors: usize) -> Result<StreamSnapshot, StreamError> {
        let Value::Object(_) = value else { return Err(invalid("not an object")) };
        let version = value.get("version");
        if version != Some(&Value::from(STREAM_SNAPSHOT_VERSION)) {
            return Err(invalid(format!("version {version:?} (this build restores {STREAM_SNAPSHOT_VERSION})")));
        }
        if value.get("cellSizeBits") != Some(&Value::from(grid.cell_size().to_bits())) {
            return Err(invalid(format!("another cell size than this registration's {} m", grid.cell_size())));
        }
        let anchors = anchors_from(value.get("anchors"), grid, max_anchors)?;
        let kept = cells_from(value.get("kept"), grid, "kept", STREAM_KEPT_MAX)?;
        let active = cells_from(value.get("active"), grid, "active", active_max(radii, max_anchors))?;
        Ok(StreamSnapshot { anchors, kept, active })
    }
}

#[cfg(test)]
mod tests {
    //! The form's hostile table: every refusal is `stream-snapshot-invalid` and nothing panics.

    use super::*;

    fn grid() -> Grid {
        Grid::new(32.0).expect("a grid")
    }

    fn radii() -> SimRadii {
        SimRadii { radius: 1, hysteresis: 1, prefetch: 1 }
    }

    fn sample() -> StreamSnapshot {
        StreamSnapshot {
            anchors: BTreeMap::from([("player".to_owned(), CellId::new(3, -2)), ("cart".to_owned(), CellId::new(0, 0))]),
            kept: BTreeSet::from([CellId::new(-7, 4)]),
            active: (2..=4).flat_map(|x| (-3..=-1).map(move |z| CellId::new(x, z))).collect(),
        }
    }

    fn read(text: &str) -> Result<StreamSnapshot, StreamError> {
        let value = genex_core::json::parse(text.as_bytes()).expect("JSON");
        StreamSnapshot::from_value(&value, &grid(), radii(), 2)
    }

    fn text(snapshot: &StreamSnapshot) -> String {
        String::from_utf8(snapshot.to_value(&grid()).dump()).expect("UTF-8")
    }

    #[test]
    fn a_snapshot_reads_back_through_its_text() {
        assert_eq!(read(&text(&sample())), Ok(sample()));
        assert_eq!(read(&text(&StreamSnapshot::default())), Ok(StreamSnapshot::default()));
    }

    #[test]
    fn a_hostile_table_refuses_snapshot_invalid() {
        let bits = 32.0_f32.to_bits();
        let good = text(&sample());
        let cells = |count: usize| (0..count as i32).map(|x| format!("[{x},0]")).collect::<Vec<_>>().join(",");
        let base = |anchors: &str, kept: &str, active: &str| {
            format!(r#"{{"version":1,"cellSizeBits":{bits},"anchors":{anchors},"kept":{kept},"active":{active}}}"#)
        };
        let rows: Vec<(&str, String)> = vec![
            ("not an object", "[]".to_owned()),
            ("another version", good.replace(r#""version":1"#, r#""version":2"#)),
            ("no version", good.replace(r#""version":1,"#, "")),
            ("another cell size", good.replace(&bits.to_string(), &16.0_f32.to_bits().to_string())),
            ("truncated: no active", base(r#"[["player",3,-2]]"#, "[]", "null")),
            ("truncated: half a cell", base(r#"[["player",3,-2]]"#, "[]", "[[1]]")),
            ("truncated: an anchor without z", base(r#"[["player",3]]"#, "[]", "[]")),
            ("a fractional coordinate", base("[]", "[[0.5,0]]", "[]")),
            ("a coordinate past i32", base("[]", "[[3000000000,0]]", "[]")),
            ("outside the world", base("[]", "[]", "[[1000,0]]")),
            ("out of order", base("[]", "[]", "[[1,0],[0,0]]")),
            ("repeated", base("[]", "[]", "[[0,0],[0,0]]")),
            ("a blank anchor name", base(r#"[[" ",0,0]]"#, "[]", "[]")),
            ("an anchor twice", base(r#"[["a",0,0],["a",1,0]]"#, "[]", "[]")),
            ("too many anchors", base(r#"[["a",0,0],["b",0,0],["c",0,0]]"#, "[]", "[]")),
            ("oversized: too many kept cells", base("[]", &format!("[{}]", cells(STREAM_KEPT_MAX + 1)), "[]")),
            ("oversized: too many active cells", base("[]", "[]", &format!("[{}]", cells(active_max(radii(), 2) + 1)))),
        ];
        for (what, text) in rows {
            let refused = read(&text).expect_err(what);
            assert_eq!(refused.code, StreamErrorCode::SnapshotInvalid, "{what}: {refused}");
        }
    }

    #[test]
    fn a_snapshot_at_every_cap_stays_far_under_the_16_mib_save_cap() {
        let radii = SimRadii { radius: crate::grid::STREAM_SIM_RADIUS_MAX, hysteresis: crate::grid::STREAM_RING_MAX, prefetch: 0 };
        let grid = Grid::new(crate::grid::STREAM_CELL_SIZE_MIN).expect("a grid");
        let name = |n: usize| format!("{n}{}", "a".repeat(STREAM_ANCHOR_NAME_MAX_CHARS - 1));
        let anchors = (0..STREAM_ANCHORS_MAX).map(|n| (name(n), CellId::new(-1000 + n as i32, -1000))).collect();
        let kept = (0..STREAM_KEPT_MAX as i32).map(|x| CellId::new(-1000 + x, 999)).collect();
        let max = active_max(radii, STREAM_ANCHORS_MAX);
        let active: BTreeSet<CellId> = (0..max as i32).map(|n| CellId::new(-1000 + n % 2000, -1000 + n / 2000)).collect();
        let snapshot = StreamSnapshot { anchors, kept, active };
        let bytes = snapshot.to_value(&grid).dump();
        println!("a snapshot at every cap: {} bytes, {max} active cells", bytes.len());
        assert!(bytes.len() < 256 * 1024, "{} bytes at {max} active cells", bytes.len());
        let value = genex_core::json::parse(&bytes).expect("JSON");
        assert_eq!(StreamSnapshot::from_value(&value, &grid, radii, STREAM_ANCHORS_MAX), Ok(snapshot));
    }

    #[test]
    fn active_max_counts_every_anchor_square_and_the_kept_cells() {
        assert_eq!(active_max(radii(), 1), 25 + STREAM_KEPT_MAX);
        assert_eq!(active_max(radii(), 99), STREAM_ANCHORS_MAX * 25 + STREAM_KEPT_MAX, "never more anchors than the cap");
    }
}
