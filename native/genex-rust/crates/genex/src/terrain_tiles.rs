//! Multi-tile terrain for streamed worlds (game systems STR-23): [`TerrainTiles`], one tile per
//! stream cell, procedural or authored, with its ground height and its static colliders.
//!
//! - **Tiles.** A tile has [`TERRAIN_TILE_SAMPLES`] samples a side and covers one cell. Sample `i`
//!   of cell `c` sits at `(c * (samples - 1) + i) * cell / (samples - 1)` metres, the import's own
//!   rule (`world-cells.ts`), so two neighbours compute their shared border samples from the same
//!   integer and hold the same bits. Every tile is quantized to 16 bits over one height range (the
//!   authored `terrain.json`'s `min`/`max`, or [`TerrainTiles::with_height_range`]), so a border
//!   sample is the same height in both tiles, drawn or collided.
//! - **Authored tiles** come from the import's output: `terrain/terrain.json` (format
//!   `genex-terrain-tiles` v1: cell size, samples, range and each tile's FNV-1a 64) and one
//!   `terrain/<x>_<z>.r16` per tile (little-endian `u16`, rows by world z). Everything is checked
//!   before a tile is made: a file over [`TERRAIN_TILE_BYTES_MAX`] is refused before it is read
//!   whole, a sample count that does not match, a range that is not finite and ordered, a digest
//!   that does not match. A refusal is `terrain-heights-invalid` and makes nothing.
//! - **Ground.** [`TerrainTiles::ground`] (`sim.stream.ground`) is a tile's [`Terrain::height`],
//!   bit for bit. Procedural ground answers anywhere in the world; authored ground only inside a
//!   sim-active cell (`None` elsewhere), so the simulation never reads a tile it would not hold.
//! - **Colliders** (physics). Each sim-active tile gets one Rapier `HeightField` collider through
//!   the streamed-collider slot (STR-10): [`TerrainTiles::colliders_content`] is the cell builder
//!   that adds it, and the commit slot inserts colliders ascending by cell and removes them
//!   descending, so every run holds the same handles.
//!
//! Ideas from parry's `HeightField` (Apache-2.0; adopted through rapier3d) and the A.7 CDLOD
//! tiling (STR-22).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use genex_core::cell::CellId;
use genex_core::digest::{fnv1a64, hex64};
use genex_render::terrain::Heightfield;
use genex_stream::grid::Grid;

use crate::math::Vec2;
use crate::terrain::{Terrain, TerrainError, TerrainErrorCode, TerrainLayer};

/// The samples a tile side may have (tile side = cell size): 64, 128, 256 or 512 quads.
pub const TERRAIN_TILE_SAMPLES: [u32; 4] = [65, 129, 257, 513];
/// The largest `.r16` tile file: 513 x 513 samples.
pub const TERRAIN_TILE_BYTES_MAX: u64 = 513 * 513 * 2;
/// The largest `terrain.json`.
pub const TERRAIN_INDEX_BYTES_MAX: u64 = 1 << 20;
/// The most tiles one `terrain.json` lists (a 64 x 64-cell world).
pub const TERRAIN_TILES_MAX: usize = 4096;
/// The height range procedural tiles are quantized over until [`TerrainTiles::with_height_range`]
/// (1.6 cm steps).
pub const TERRAIN_HEIGHT_RANGE_DEFAULT: (f32, f32) = (-512.0, 512.0);
/// `terrain.json`'s `format`.
pub const TERRAIN_TILES_FORMAT: &str = "genex-terrain-tiles";
/// `terrain.json`'s `version`.
pub const TERRAIN_TILES_VERSION: u64 = 1;
/// Procedural tiles kept made for `ground` (each at most 513 x 513 samples).
const PROCEDURAL_TILES_KEPT: usize = 16;
/// The largest r16 sample.
const R16_MAX: f32 = 65_535.0;

/// A procedural height: world (x, z) in, metres out; pure (it runs on the stream workers).
type HeightFn = dyn Fn(f32, f32) -> f32 + Send + Sync;

/// Where the tiles come from.
enum TileSource {
    /// `height` sampled per tile, quantized over the tiles' range.
    Procedural(Arc<HeightFn>),
    /// The import's tiles, made once, by cell, for the cell size they were written for.
    Authored { cell_size: f32, tiles: Arc<BTreeMap<CellId, Heightfield>> },
}

/// Streamed terrain tiles (see the module docs). A cheap handle: clones share the tiles.
#[derive(Clone)]
pub struct TerrainTiles {
    inner: Arc<TilesInner>,
}

struct TilesInner {
    samples: u32,
    range: (f32, f32),
    colliders: bool,
    layers: Option<Vec<TerrainLayer>>,
    source: TileSource,
    /// Procedural tiles made lately, by cell and cell size (`ground` reads them often).
    made: Mutex<Vec<(CellId, u32, Heightfield)>>,
}

impl PartialEq for TerrainTiles {
    /// The same tiles (one handle and its clones).
    fn eq(&self, other: &TerrainTiles) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl std::fmt::Debug for TerrainTiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match &self.inner.source {
            TileSource::Procedural(_) => "procedural".to_owned(),
            TileSource::Authored { tiles, .. } => format!("{} authored", tiles.len()),
        };
        f.debug_struct("TerrainTiles").field("samples", &self.inner.samples).field("tiles", &kind).field("colliders", &self.inner.colliders).finish()
    }
}

fn refused(detail: String) -> TerrainError {
    TerrainError { code: TerrainErrorCode::HeightsInvalid, detail }
}

fn check_samples(samples: u32) -> Result<(), TerrainError> {
    if TERRAIN_TILE_SAMPLES.contains(&samples) {
        return Ok(());
    }
    Err(refused(format!("tiles of {samples} samples, one of {TERRAIN_TILE_SAMPLES:?}")))
}

fn check_range(range: (f32, f32)) -> Result<(), TerrainError> {
    let usable = range.0.is_finite() && range.1.is_finite() && range.0 <= range.1;
    if usable {
        return Ok(());
    }
    Err(refused(format!("height range {range:?} must be finite and ordered")))
}

/// World metres of sample `i` of cell coordinate `cell` (the import's rule; shared borders match).
fn sample_metres(cell: i32, i: u32, samples: u32, cell_size: f32) -> f32 {
    let quads = (samples - 1) as f32;
    ((cell as f32) * quads + i as f32) * cell_size / quads
}

/// The tile of `cell` from heights `height(column, row)`, over `range`.
fn tile_field(cell: CellId, samples: u32, cell_size: f32, range: (f32, f32), height: impl Fn(u32, u32) -> f32) -> Result<Heightfield, TerrainError> {
    let heights: Vec<f32> = (0..samples).flat_map(|row| (0..samples).map(move |column| (column, row))).map(|(column, row)| height(column, row)).collect();
    let origin = [sample_metres(cell.x, 0, samples, cell_size), sample_metres(cell.z, 0, samples, cell_size)];
    let spacing = cell_size / (samples - 1) as f32;
    Heightfield::with_range((samples, samples), origin, spacing, &heights, range).map_err(|error| refused(format!("tile ({}, {}): {error}", cell.x, cell.z)))
}

impl TerrainTiles {
    /// Tiles of `samples` a side ([`TERRAIN_TILE_SAMPLES`]) sampled from `height(x, z)`, which must
    /// be pure: it runs on the stream workers. Heights are clamped into the range
    /// ([`TERRAIN_HEIGHT_RANGE_DEFAULT`] until [`TerrainTiles::with_height_range`]). Refused
    /// `terrain-heights-invalid` for another sample count.
    pub fn procedural<F>(samples: u32, height: F) -> Result<TerrainTiles, TerrainError>
    where
        F: Fn(f32, f32) -> f32 + Send + Sync + 'static,
    {
        check_samples(samples)?;
        Ok(TerrainTiles::of(samples, TERRAIN_HEIGHT_RANGE_DEFAULT, TileSource::Procedural(Arc::new(height))))
    }

    /// The import's authored tiles: `index` is `terrain/terrain.json`, and `read(x, z)` answers
    /// the bytes of `terrain/<x>_<z>.r16` (None: not there) after `size(x, z)` said how many there
    /// are (None: not there), so an oversized file is refused before it is read. Every tile is
    /// checked and made now. Refused `terrain-heights-invalid` (module docs); nothing is made.
    pub fn authored(index: &[u8], size: impl Fn(CellId) -> Option<u64>, read: impl Fn(CellId) -> Option<Vec<u8>>) -> Result<TerrainTiles, TerrainError> {
        let index = TileIndex::parse(index)?;
        let mut tiles = BTreeMap::new();
        for (cell, digest) in &index.tiles {
            let named = format!("tile ({}, {})", cell.x, cell.z);
            let expected = u64::from(index.samples) * u64::from(index.samples) * 2;
            match size(*cell) {
                None => return Err(refused(format!("{named} is missing"))),
                Some(bytes) if bytes > TERRAIN_TILE_BYTES_MAX => return Err(refused(format!("{named} is {bytes} bytes, over {TERRAIN_TILE_BYTES_MAX}"))),
                Some(bytes) if bytes != expected => return Err(refused(format!("{named} is {bytes} bytes, {expected} for {} samples", index.samples))),
                Some(_) => {}
            }
            let bytes = read(*cell).ok_or_else(|| refused(format!("{named} is missing")))?;
            if bytes.len() as u64 != expected {
                return Err(refused(format!("{named} is {} bytes, {expected} for {} samples", bytes.len(), index.samples)));
            }
            if hex64(fnv1a64(&bytes)) != *digest {
                return Err(refused(format!("{named}'s bytes do not match its digest {digest}")));
            }
            tiles.insert(*cell, decode_tile(*cell, &bytes, &index)?);
        }
        let source = TileSource::Authored { cell_size: index.cell_size, tiles: Arc::new(tiles) };
        Ok(TerrainTiles::of(index.samples, (index.min, index.max), source))
    }

    fn of(samples: u32, range: (f32, f32), source: TileSource) -> TerrainTiles {
        let inner = TilesInner { samples, range, colliders: true, layers: None, source, made: Mutex::new(Vec::new()) };
        TerrainTiles { inner: Arc::new(inner) }
    }

    fn changed(&self, change: impl FnOnce(&mut TilesInner)) -> TerrainTiles {
        let source = match &self.inner.source {
            TileSource::Procedural(height) => TileSource::Procedural(Arc::clone(height)),
            TileSource::Authored { cell_size, tiles } => TileSource::Authored { cell_size: *cell_size, tiles: Arc::clone(tiles) },
        };
        let old = &self.inner;
        let mut inner = TilesInner { samples: old.samples, range: old.range, colliders: old.colliders, layers: old.layers.clone(), source, made: Mutex::new(Vec::new()) };
        change(&mut inner);
        TerrainTiles { inner: Arc::new(inner) }
    }

    /// Procedural tiles quantized over `min..=max` metres (heights outside are clamped). Refused
    /// `terrain-heights-invalid` for a range that is not finite and ordered, and for authored
    /// tiles (their range is the import's).
    pub fn with_height_range(&self, min: f32, max: f32) -> Result<TerrainTiles, TerrainError> {
        check_range((min, max))?;
        if !self.is_procedural() {
            return Err(refused("authored tiles keep the import's height range".to_owned()));
        }
        Ok(self.changed(|inner| inner.range = (min, max)))
    }

    /// Every tile drawn with `layers` (refused as [`Terrain::with_layers`] refuses).
    pub fn with_layers(&self, layers: Vec<TerrainLayer>) -> Result<TerrainTiles, TerrainError> {
        Terrain::from_heights([2, 2], Vec2::ZERO, 1.0, &[0.0; 4])?.with_layers(layers.clone())?;
        Ok(self.changed(|inner| inner.layers = Some(layers)))
    }

    /// Whether each sim-active tile gets a collider (on by default; physics builds only).
    pub fn with_colliders(&self, on: bool) -> TerrainTiles {
        self.changed(|inner| inner.colliders = on)
    }

    /// Samples a tile side.
    pub fn samples(&self) -> u32 {
        self.inner.samples
    }

    /// The range every tile is quantized over (lowest, highest).
    pub fn height_range(&self) -> (f32, f32) {
        self.inner.range
    }

    /// Whether tiles are sampled from a function (else authored).
    pub fn is_procedural(&self) -> bool {
        matches!(self.inner.source, TileSource::Procedural(_))
    }

    /// Whether sim-active tiles get colliders.
    pub fn colliders(&self) -> bool {
        self.inner.colliders
    }

    /// The cell size authored tiles were written for (None for procedural tiles, which fit any).
    pub fn cell_size(&self) -> Option<f32> {
        match &self.inner.source {
            TileSource::Procedural(_) => None,
            TileSource::Authored { cell_size, .. } => Some(*cell_size),
        }
    }

    /// The cells authored tiles cover, ascending (none for procedural tiles: every cell).
    pub fn authored_cells(&self) -> Vec<CellId> {
        match &self.inner.source {
            TileSource::Procedural(_) => Vec::new(),
            TileSource::Authored { tiles, .. } => tiles.keys().copied().collect(),
        }
    }

    /// `cell`'s tile in a grid of `cell_size`-metre cells as its height field; None for an
    /// authored world without that tile, or a cell size the authored tiles were not written for.
    pub fn tile_heights(&self, cell: CellId, cell_size: f32) -> Option<Heightfield> {
        match &self.inner.source {
            TileSource::Authored { cell_size: authored, tiles } => (authored.to_bits() == cell_size.to_bits()).then(|| tiles.get(&cell).cloned()).flatten(),
            TileSource::Procedural(height) => self.procedural_tile(height, cell, cell_size),
        }
    }

    /// `cell`'s tile as a [`Terrain`] (its layers when set): what [`TerrainTiles::ground`] reads.
    pub fn tile(&self, cell: CellId, cell_size: f32) -> Option<Terrain> {
        let terrain = Terrain::of(self.tile_heights(cell, cell_size)?);
        match &self.inner.layers {
            Some(layers) => terrain.with_layers(layers.clone()).ok(),
            None => Some(terrain),
        }
    }

    fn procedural_tile(&self, height: &Arc<HeightFn>, cell: CellId, cell_size: f32) -> Option<Heightfield> {
        let key = cell_size.to_bits();
        let mut made = self.inner.made.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((_, _, field)) = made.iter().find(|(at, size, _)| *at == cell && *size == key) {
            return Some(field.clone());
        }
        let (samples, range) = (self.inner.samples, self.inner.range);
        let at = |column: u32, row: u32| {
            let h = height(sample_metres(cell.x, column, samples, cell_size), sample_metres(cell.z, row, samples, cell_size));
            if h.is_finite() { h.clamp(range.0, range.1) } else { range.0 }
        };
        let field = tile_field(cell, samples, cell_size, range, at).ok()?;
        if made.len() >= PROCEDURAL_TILES_KEPT {
            made.remove(0);
        }
        made.push((cell, key, field.clone()));
        Some(field)
    }

    /// The ground's height at world (`x`, `z`) in a grid of `cell_size`-metre cells: its tile's
    /// [`Terrain::height`], bit for bit. Procedural tiles answer anywhere in the world; authored
    /// ones only where `active(cell)` (the sim-active cells). None outside the world.
    pub fn ground(&self, x: f32, z: f32, cell_size: f32, active: impl Fn(CellId) -> bool) -> Option<f32> {
        let cell = Grid::new(cell_size).ok()?.cell_of(Vec2::new(x, z)).ok()?;
        if !self.is_procedural() && !active(cell) {
            return None;
        }
        Some(self.tile_heights(cell, cell_size)?.height(x, z))
    }
}

/// `terrain.json`, checked.
struct TileIndex {
    cell_size: f32,
    samples: u32,
    min: f32,
    max: f32,
    /// Each tile's cell and digest (16 hex digits), ascending by cell.
    tiles: BTreeMap<CellId, String>,
}

impl TileIndex {
    fn parse(bytes: &[u8]) -> Result<TileIndex, TerrainError> {
        if bytes.len() as u64 > TERRAIN_INDEX_BYTES_MAX {
            return Err(refused(format!("terrain.json is {} bytes, over {TERRAIN_INDEX_BYTES_MAX}", bytes.len())));
        }
        let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| refused(format!("terrain.json: {error}")))?;
        let field = |name: &str| value.get(name).ok_or_else(|| refused(format!("terrain.json has no {name}")));
        if field("format")?.as_str() != Some(TERRAIN_TILES_FORMAT) || field("version")?.as_u64() != Some(TERRAIN_TILES_VERSION) {
            return Err(refused(format!("terrain.json is not {TERRAIN_TILES_FORMAT} v{TERRAIN_TILES_VERSION}")));
        }
        let number = |name: &str| field(name)?.as_f64().map(|v| v as f32).ok_or_else(|| refused(format!("terrain.json's {name} is not a number")));
        let samples = field("samples")?.as_u64().and_then(|v| u32::try_from(v).ok()).ok_or_else(|| refused("terrain.json's samples".to_owned()))?;
        check_samples(samples)?;
        let (cell_size, min, max) = (number("cellSize")?, number("min")?, number("max")?);
        check_range((min, max))?;
        Grid::new(cell_size).map_err(|error| refused(format!("terrain.json's cell size: {error}")))?;
        let listed = field("tiles")?.as_array().ok_or_else(|| refused("terrain.json's tiles is not a list".to_owned()))?;
        if listed.len() > TERRAIN_TILES_MAX {
            return Err(refused(format!("{} tiles, at most {TERRAIN_TILES_MAX}", listed.len())));
        }
        let mut tiles = BTreeMap::new();
        for tile in listed {
            let coordinate = |name: &str| tile.get(name).and_then(serde_json::Value::as_i64).and_then(|v| i32::try_from(v).ok());
            let digest = tile.get("fnv").and_then(serde_json::Value::as_str).filter(|d| d.len() == 16 && d.bytes().all(|b| b.is_ascii_hexdigit()));
            let (Some(x), Some(z), Some(digest)) = (coordinate("x"), coordinate("z"), digest) else {
                return Err(refused(format!("terrain.json tile {tile} needs integer x, z and a 16-digit fnv")));
            };
            if tiles.insert(CellId::new(x, z), digest.to_ascii_lowercase()).is_some() {
                return Err(refused(format!("terrain.json lists tile ({x}, {z}) twice")));
            }
        }
        Ok(TileIndex { cell_size, samples, min, max, tiles })
    }
}

/// One `.r16` tile's height field: `min + value / 65535 * (max - min)`, clamped into the range.
fn decode_tile(cell: CellId, bytes: &[u8], index: &TileIndex) -> Result<Heightfield, TerrainError> {
    let span = index.max - index.min;
    let samples = index.samples;
    let height = |column: u32, row: u32| {
        let at = ((row * samples + column) * 2) as usize;
        let value = f32::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
        (index.min + value / R16_MAX * span).clamp(index.min, index.max)
    };
    tile_field(cell, samples, index.cell_size, (index.min, index.max), height)
}

#[cfg(feature = "physics")]
mod colliders {
    use rapier3d::prelude::{Array2, Collider, ColliderBuilder, Vector};

    use super::{CellId, TerrainTiles, sample_metres};
    use crate::stream::{CellBuild, CellInputs};
    use genex_stream::physics::CellColliders;

    impl TerrainTiles {
        /// `cell`'s tile as one static Rapier `HeightField` collider in world space (its samples'
        /// quantized heights; the border samples two tiles share are the same bits); None
        /// without a tile or with colliders off.
        pub fn collider(&self, cell: CellId, cell_size: f32) -> Option<Collider> {
            if !self.colliders() {
                return None;
            }
            let field = self.tile_heights(cell, cell_size)?;
            let (columns, rows) = field.samples();
            // parry's grid is column-major over (row = z, column = x).
            let heights: Vec<f32> = (0..columns).flat_map(|x| (0..rows).map(move |z| (x, z))).map(|(x, z)| field.sample(x, z)).collect();
            let samples = self.samples();
            let min = [sample_metres(cell.x, 0, samples, cell_size), sample_metres(cell.z, 0, samples, cell_size)];
            let max = [sample_metres(cell.x, samples - 1, samples, cell_size), sample_metres(cell.z, samples - 1, samples, cell_size)];
            let scale = Vector::new(max[0] - min[0], 1.0, max[1] - min[1]);
            let centre = Vector::new((min[0] + max[0]) * 0.5, 0.0, (min[1] + max[1]) * 0.5);
            Some(ColliderBuilder::heightfield(Array2::new(rows as usize, columns as usize, heights), scale).translation(centre).build())
        }

        /// `cell`'s colliders for the streamed-collider slot: its tile's, or none.
        pub fn cell_colliders(&self, cell: CellId, cell_size: f32) -> CellColliders {
            self.collider(cell, cell_size).map_or_else(CellColliders::new, |collider| CellColliders::new().with(collider))
        }

        /// The cell builder that streams each sim-active tile's collider in a grid of
        /// `cell_size`-metre cells (`game.cell_content(tiles.colliders_content(cell))` beside
        /// `game.stream_colliders()`).
        pub fn colliders_content(&self, cell_size: f32) -> impl Fn(CellId, &CellInputs) -> CellBuild<()> + Send + Sync + 'static {
            let tiles = self.clone();
            move |cell, _| CellBuild::default().part(tiles.cell_colliders(cell, cell_size))
        }
    }
}
