//! Obstacles: avoidance discs, carving volumes and the sliced dirty-tile queue (NAV-10).
//!
//! An [`NavObstacle::Avoid`] disc never touches the mesh: agents steer around it (NAV-12 feeds it
//! to avoidance). A carving obstacle ([`NavObstacle::CarveCylinder`], [`NavObstacle::CarveBox`])
//! cuts its footprint out of every resident tile whose build region (the tile plus its border)
//! it touches. Those tiles queue for a rebuild, and [`Carving::advance`] works the queue in
//! **stage units**: one unit is one Recast stage of one tile, seven per tile ([`Stage`]:
//! rasterize, filter, compact, regions, contours, polygons, detail). A rebuild always takes
//! exactly [`NAV_REBUILD_STAGES`] units, whatever it skips, so the ticks from an obstacle change
//! to a settled mesh are `ceil(tiles × 7 ÷ units per tick)` on every destination: budgets are
//! counted in work, never in time. The queue runs in FIFO order by (queued tick, cell). A
//! finished tile comes back from [`Carving::advance`] and the caller swaps it in, so until then
//! agents walk the old tile and the mesh never has a hole.
//!
//! The footprint is marked with Recast's null area on the tile's compact heightfield *before*
//! erosion, so the walker radius erodes the mesh back from the obstacle as it does from a wall.
//! A cylinder is the 12-gon around its circle; a box is the convex hull of its eight corners in
//! x/z between their lowest and highest y. The marked heights start one walker climb below the
//! obstacle's base, so an obstacle standing on the ground cuts that ground.
//!
//! Compact heightfields are cached only for tiles under a carving obstacle (phones: memory): a
//! moved or removed obstacle rebuilds those tiles from the cache, skipping rasterization; every
//! other tile re-rasterizes from the retained input. A tile rebuilt with no obstacle left drops
//! its cache entry and is byte-equal to its first bake (the same stages in the same order as
//! [`crate::bake::bake_tile`], with nothing marked).
//!
//! Ported logic, altered (licences in `THIRD-PARTY-NOTICES.md`, list in `N/PORTS.md`):
//! - DetourTileCache (recastnavigation, Zlib): the obstacle shapes (`dtObstacleCylinder`,
//!   `dtObstacleBox`), obstacle requests marking the tiles they touch, and a rebuild queue worked
//!   a bounded amount per update (`dtTileCache::update`); here the bound is stage units rather
//!   than whole tiles, and obstacles are marked on the compact heightfield instead of a layer;
//! - DotRecast `Detour.Dynamic` (Zlib): keep each dynamic tile's checkpoint (here the compact
//!   heightfield) and rebuild only the tiles an obstacle touched from it;
//! - rerecast's `mark_convex_poly_area` (MIT OR Apache-2.0), called with the null area.

use std::collections::VecDeque;
use std::sync::Arc;

use genex_core::cell::CellId;
use genex_core::map::{Map, Set};
use glam::{Mat4, Vec2, Vec3, Vec3Swizzles};

use crate::bake::{
    BakeConfig, DETAIL_SAMPLE_CELLS_MIN, convex_volume, height_floor, height_range, recast_refusal, tile_mesh, trimesh, window_digest,
};
use crate::error::NavError;
use crate::ids::NavObstacleId;
use crate::input::{NavInput, tile_region};
use crate::recast::{
    Aabb3d, AreaType, BuildContoursFlags, CompactHeightfield, ContourSet, ConvexVolume, DetailNavmesh, Heightfield, PolygonNavmesh,
    RecastError, Spans,
};
use crate::tile::{NAV_TILE_POLYGON_VERTICES_MAX, NavTile, TileMesh};

/// Obstacles one nav may hold (avoid and carve together).
pub const NAV_OBSTACLES_MAX: usize = 256;
/// Stage units one tile rebuild takes: rasterize, filter, compact, regions, contours, polygons,
/// detail.
pub const NAV_REBUILD_STAGES: u32 = 7;
/// Stage units one update works by default: one tile rebuild per tick.
pub const NAV_BAKE_UNITS_PER_TICK_DEFAULT: u32 = NAV_REBUILD_STAGES;
/// The widest an obstacle may reach from its centre along any axis, in metres.
pub const NAV_OBSTACLE_EXTENT_MAX: f32 = 256.0;
/// Sides of the polygon a carving cylinder becomes.
const CYLINDER_SIDES: usize = 12;

/// Something in the way of agents: avoided only, or carved out of the mesh.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NavObstacle {
    /// Agents steer around it and the mesh never rebuilds: a rolling barrel.
    Avoid {
        /// Its centre.
        position: Vec3,
        /// Its radius, in metres.
        radius: f32,
    },
    /// Cut from the mesh; the tiles under it rebuild over the next ticks: a pillar.
    CarveCylinder {
        /// The centre of its bottom face.
        base: Vec3,
        /// Its radius, in metres.
        radius: f32,
        /// Its height above `base`, in metres.
        height: f32,
    },
    /// A unit cube (-0.5..0.5 on each axis) placed by `transform`, cut from the mesh: a crate.
    CarveBox {
        /// Where the unit cube goes (scale, rotation, translation).
        transform: Mat4,
    },
}

impl NavObstacle {
    /// Whether it cuts the mesh (rather than being avoided only).
    pub const fn carves(&self) -> bool {
        !matches!(self, NavObstacle::Avoid { .. })
    }

    /// Refused `nav-input-invalid`: a position, radius, height or placement that is not finite,
    /// a radius or height that is not positive, or a shape reaching more than
    /// [`NAV_OBSTACLE_EXTENT_MAX`] metres from its centre.
    pub fn check(&self) -> Result<(), NavError> {
        let (finite, sizes_positive) = match *self {
            NavObstacle::Avoid { position, radius } => (position.is_finite() && radius.is_finite(), radius > 0.0),
            NavObstacle::CarveCylinder { base, radius, height } => {
                (base.is_finite() && radius.is_finite() && height.is_finite(), radius > 0.0 && height > 0.0)
            }
            NavObstacle::CarveBox { transform } => (transform.is_finite(), transform.determinant() != 0.0),
        };
        if !(finite && sizes_positive) {
            return Err(NavError::input_invalid(format!("an obstacle that is not finite or has no size: {self:?}")));
        }
        if self.extent() > NAV_OBSTACLE_EXTENT_MAX {
            return Err(NavError::input_invalid(format!("an obstacle reaching {} m from its centre (max {NAV_OBSTACLE_EXTENT_MAX})", self.extent())));
        }
        Ok(())
    }

    /// The farthest the shape reaches from its centre along any axis.
    fn extent(&self) -> f32 {
        match *self {
            NavObstacle::Avoid { radius, .. } => radius,
            NavObstacle::CarveCylinder { radius, height, .. } => radius.max(height),
            NavObstacle::CarveBox { transform } => {
                let centre = transform.transform_point3(Vec3::ZERO);
                box_corners(transform).iter().map(|c| (*c - centre).abs().max_element()).fold(0.0, f32::max)
            }
        }
    }

    /// The volume a carving obstacle marks, `None` for an avoid disc: a convex x/z outline and
    /// the heights between which it cuts, `climb` metres below its base included.
    fn footprint(&self, climb: f32) -> Option<ConvexVolume> {
        match *self {
            NavObstacle::Avoid { .. } => None,
            NavObstacle::CarveCylinder { base, radius, height } => {
                // The circumscribed 12-gon holds the whole disc. glam's `from_angle` runs libm, so
                // the corners have the same bits on every destination.
                let step = std::f32::consts::TAU / CYLINDER_SIDES as f32;
                let outer = radius / Vec2::from_angle(step / 2.0).x;
                let vertices = (0..CYLINDER_SIDES).map(|k| base.xz() + Vec2::from_angle(step * k as f32) * outer).collect();
                Some(ConvexVolume { vertices, min_y: base.y - climb, max_y: base.y + height, area: AreaType::NOT_WALKABLE })
            }
            NavObstacle::CarveBox { transform } => {
                let corners = box_corners(transform);
                let (low, high) = corners.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(l, h), c| (l.min(c.y), h.max(c.y)));
                let vertices = convex_hull(corners.map(|c| c.xz()));
                Some(ConvexVolume { vertices, min_y: low - climb, max_y: high, area: AreaType::NOT_WALKABLE })
            }
        }
    }
}

/// The eight corners of the unit cube placed by `transform`.
fn box_corners(transform: Mat4) -> [Vec3; 8] {
    std::array::from_fn(|k| {
        let half = |bit: usize| if k & bit == 0 { -0.5 } else { 0.5 };
        transform.transform_point3(Vec3::new(half(1), half(2), half(4)))
    })
}

/// Andrew's monotone chain over `points`, counter-clockwise, collinear points dropped. Sorting
/// with `total_cmp` keeps the order the same on every destination.
fn convex_hull(points: [Vec2; 8]) -> Vec<Vec2> {
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    sorted.dedup();
    let turn = |o: Vec2, a: Vec2, b: Vec2| (a - o).perp_dot(b - o);
    let mut hull: Vec<Vec2> = Vec::with_capacity(sorted.len() * 2);
    for pass in [false, true] {
        let start = hull.len();
        let ordered: Box<dyn Iterator<Item = &Vec2>> = if pass { Box::new(sorted.iter().rev()) } else { Box::new(sorted.iter()) };
        for &point in ordered {
            while hull.len() >= start + 2 && turn(hull[hull.len() - 2], hull[hull.len() - 1], point) <= 0.0 {
                hull.pop();
            }
            hull.push(point);
        }
        hull.pop();
    }
    hull
}

/// One Recast stage of a tile rebuild, in the order they run. Each is one stage unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    /// Gather the tile's input window and rasterize it (skipped from the cache).
    Rasterize,
    /// Recast's three span filters (skipped from the cache).
    Filter,
    /// The compact heightfield (taken from the cache when there is one).
    Compact,
    /// Carving marks, erosion, area volumes, the distance field and watershed regions.
    Regions,
    /// Contours.
    Contours,
    /// The polygon mesh.
    Polygons,
    /// The detail mesh and the finished tile.
    Detail,
}

impl Stage {
    /// Every stage, in the order a rebuild runs them.
    pub const ALL: [Stage; NAV_REBUILD_STAGES as usize] =
        [Stage::Rasterize, Stage::Filter, Stage::Compact, Stage::Regions, Stage::Contours, Stage::Polygons, Stage::Detail];
}

/// What a rebuild carries from one stage to the next.
#[derive(Clone, Debug)]
enum Progress {
    /// Not started: the obstacles are read when it starts.
    Waiting,
    Rasterized(Box<Heightfield>),
    Filtered(Box<Heightfield>),
    Compacted(Box<CompactHeightfield>),
    Regions(Box<CompactHeightfield>),
    Contoured(Box<(CompactHeightfield, ContourSet)>),
    Polygons(Box<(CompactHeightfield, PolygonNavmesh)>),
    /// Done early (no ground, or a refusal); the remaining units do nothing.
    Done(Result<NavTile, NavError>),
}

impl Progress {
    /// The stage that moves this progress on; the stages before it are no-ops.
    fn next_stage(&self) -> Option<Stage> {
        match self {
            Progress::Waiting => Some(Stage::Rasterize),
            Progress::Rasterized(_) => Some(Stage::Filter),
            Progress::Filtered(_) => Some(Stage::Compact),
            Progress::Compacted(_) => Some(Stage::Regions),
            Progress::Regions(_) => Some(Stage::Contours),
            Progress::Contoured(_) => Some(Stage::Polygons),
            Progress::Polygons(_) => Some(Stage::Detail),
            Progress::Done(_) => None,
        }
    }
}

/// What a started rebuild read when it began.
#[derive(Clone, Debug, Default)]
struct Work {
    input_digest: u64,
    carve: Vec<ConvexVolume>,
    volumes: Vec<ConvexVolume>,
}

/// One queued tile rebuild.
#[derive(Clone, Debug)]
struct Rebuild {
    cell: CellId,
    /// Units already worked, 0..=7.
    units: u32,
    work: Work,
    progress: Progress,
}

/// A cached compact heightfield: the tile's state after [`Stage::Compact`], before any mark.
#[derive(Clone, Debug)]
struct Cached {
    input_digest: u64,
    compact: CompactHeightfield,
}

/// A rebuild [`Carving::advance`] finished: the tile to swap in for `cell`, or why it could not
/// be built (the old tile stays).
#[derive(Clone, Debug, PartialEq)]
pub struct Rebuilt {
    /// The tile's cell.
    pub cell: CellId,
    /// The new tile, or the refusal.
    pub tile: Result<NavTile, NavError>,
}

/// The obstacles of one nav and the queue of tile rebuilds their carving needs.
#[derive(Clone, Debug)]
pub struct Carving {
    /// The input resident tiles were baked from; without one nothing can be carved.
    input: Option<Arc<NavInput>>,
    config: BakeConfig,
    floor: f32,
    obstacles: Map<NavObstacleId, NavObstacle>,
    next_id: u64,
    resident: Set<CellId>,
    queue: VecDeque<Rebuild>,
    cache: Map<CellId, Cached>,
    cache_hits: u64,
}

impl Carving {
    /// Carving over the tiles of `input` baked with `config` (the input and config of the
    /// resident tiles). Refused `nav-config-invalid` as [`BakeConfig::check`] refuses.
    pub fn new(input: Arc<NavInput>, config: BakeConfig) -> Result<Carving, NavError> {
        let mut carving = Carving::without_input(config)?;
        carving.set_input(Some(input));
        Ok(carving)
    }

    /// Obstacles over tiles with no bake input (tiles read from bytes alone): avoid discs only,
    /// until [`Carving::set_input`] gives it one. Refused as [`Carving::new`].
    pub fn without_input(config: BakeConfig) -> Result<Carving, NavError> {
        config.check()?;
        Ok(Carving {
            input: None,
            config,
            floor: 0.0,
            obstacles: Map::default(),
            next_id: 1,
            resident: Set::default(),
            queue: VecDeque::new(),
            cache: Map::default(),
            cache_hits: 0,
        })
    }

    /// The config the tiles are rebuilt with.
    pub fn config(&self) -> &BakeConfig {
        &self.config
    }

    /// The input the tiles are rebuilt from, when there is one.
    pub fn input(&self) -> Option<&Arc<NavInput>> {
        self.input.as_ref()
    }

    /// The input the resident tiles now come from (a new mesh was added). The cache goes, and
    /// every resident tile under a carving obstacle queues, so the carving follows the new input.
    /// Without an input, carving obstacles stay listed but carve nothing until one comes.
    pub fn set_input(&mut self, input: Option<Arc<NavInput>>) {
        self.floor = input.as_deref().and_then(height_floor).unwrap_or(0.0);
        self.input = input;
        self.cache.clear();
        self.queue.clear();
        let carved: Vec<CellId> = self.resident.iter().copied().filter(|&cell| self.carvers_over(cell).next().is_some()).collect();
        self.queue_cells(carved);
    }

    /// A tile is now resident at `cell`: a carving obstacle already over it queues its rebuild.
    pub fn tile_added(&mut self, cell: CellId) {
        if self.resident.insert(cell) && self.carvers_over(cell).next().is_some() {
            self.queue_cells(vec![cell]);
        }
    }

    /// The tile at `cell` left: its queued rebuilds and cache entry go.
    pub fn tile_removed(&mut self, cell: CellId) {
        self.resident.shift_remove(&cell);
        self.queue.retain(|rebuild| rebuild.cell != cell);
        self.cache.shift_remove(&cell);
    }

    /// Add an obstacle; a carving one queues every resident tile it touches. Refused as
    /// [`NavObstacle::check`] refuses, and `nav-too-large` past [`NAV_OBSTACLES_MAX`]; nothing
    /// changes on a refusal.
    pub fn add(&mut self, obstacle: NavObstacle) -> Result<NavObstacleId, NavError> {
        self.check(&obstacle)?;
        if self.obstacles.len() >= NAV_OBSTACLES_MAX {
            return Err(NavError::too_large(format!("more than {NAV_OBSTACLES_MAX} obstacles")));
        }
        let id = NavObstacleId(self.next_id);
        self.next_id += 1;
        self.obstacles.insert(id, obstacle);
        let touched = self.touched_cells(&obstacle);
        self.queue_cells(touched);
        Ok(id)
    }

    /// Move or reshape an obstacle: the tiles under its old and new shapes queue. `Ok(false)` for
    /// an unknown id; refused as [`NavObstacle::check`] refuses, with nothing changed.
    pub fn set(&mut self, id: NavObstacleId, obstacle: NavObstacle) -> Result<bool, NavError> {
        self.check(&obstacle)?;
        let Some(old) = self.obstacles.get(&id).copied() else {
            return Ok(false);
        };
        self.obstacles.insert(id, obstacle);
        let mut touched = self.touched_cells(&old);
        touched.extend(self.touched_cells(&obstacle));
        self.queue_cells(touched);
        Ok(true)
    }

    /// Remove an obstacle: the tiles it carved queue. False for an unknown id.
    pub fn remove(&mut self, id: NavObstacleId) -> bool {
        let Some(old) = self.obstacles.shift_remove(&id) else {
            return false;
        };
        let touched = self.touched_cells(&old);
        self.queue_cells(touched);
        true
    }

    /// Exactly `obstacles`, under their own ids and in the order given, with ids handed out next
    /// from `next_id` (a restored save): the tiles under the old and new shapes queue. Refused as
    /// [`Carving::add`] refuses a shape, past [`NAV_OBSTACLES_MAX`], or `nav-input-invalid` for an
    /// id repeated or not below `next_id`, with nothing changed.
    pub(crate) fn restore(&mut self, obstacles: &[(NavObstacleId, NavObstacle)], next_id: u64) -> Result<(), NavError> {
        if obstacles.len() > NAV_OBSTACLES_MAX {
            return Err(NavError::too_large(format!("more than {NAV_OBSTACLES_MAX} obstacles")));
        }
        let mut ids = Set::default();
        for (id, obstacle) in obstacles {
            self.check(obstacle)?;
            if id.0 >= next_id || !ids.insert(*id) {
                return Err(NavError::input_invalid(format!("obstacle id {} repeats or is not below {next_id}", id.0)));
            }
        }
        let mut touched: Vec<CellId> = self.obstacles.values().flat_map(|old| self.touched_cells(old)).collect();
        touched.extend(obstacles.iter().flat_map(|(_, obstacle)| self.touched_cells(obstacle)));
        self.obstacles = obstacles.iter().copied().collect();
        self.next_id = next_id;
        self.queue_cells(touched);
        Ok(())
    }

    /// The id the next added obstacle gets.
    pub(crate) fn next_id(&self) -> u64 {
        self.next_id
    }

    /// [`NavObstacle::check`], and `nav-input-invalid` for a carving obstacle with no input to
    /// rebuild tiles from.
    fn check(&self, obstacle: &NavObstacle) -> Result<(), NavError> {
        obstacle.check()?;
        if obstacle.carves() && self.input.is_none() {
            return Err(NavError::input_invalid("these tiles have no bake input to carve: add the mesh with its input"));
        }
        Ok(())
    }

    /// The obstacle `id` names, if it is live.
    pub fn get(&self, id: NavObstacleId) -> Option<&NavObstacle> {
        self.obstacles.get(&id)
    }

    /// Every live obstacle, in the order added.
    pub fn obstacles(&self) -> impl Iterator<Item = (NavObstacleId, &NavObstacle)> + '_ {
        self.obstacles.iter().map(|(id, obstacle)| (*id, obstacle))
    }

    /// Tile rebuilds queued or under way (0: the mesh matches the obstacles).
    pub fn pending(&self) -> usize {
        self.queue.len()
    }

    /// The cells whose compact heightfield is cached (only tiles under a carving obstacle).
    pub fn cached_cells(&self) -> impl Iterator<Item = CellId> + '_ {
        self.cache.keys().copied()
    }

    /// The bytes the cached compact heightfields take.
    pub fn cached_bytes(&self) -> usize {
        self.cache.values().map(|cached| compact_bytes(&cached.compact)).sum()
    }

    /// Rebuilds that started from a cached compact heightfield, since this carving was made.
    pub fn cache_hits(&self) -> u64 {
        self.cache_hits
    }

    /// One update's work: `units` stage units off the front of the queue (a rebuild left part
    /// way carries on next update). Returns the rebuilds finished, in the order they finished,
    /// for the caller to swap in.
    pub fn advance(&mut self, units: u32) -> Vec<Rebuilt> {
        let mut finished = Vec::new();
        for _ in 0..units {
            let Some(front) = self.queue.front_mut() else {
                break;
            };
            let stage = Stage::ALL[front.units as usize];
            if front.progress.next_stage() == Some(stage) {
                let mut rebuild = self.queue.pop_front().expect("the front exists");
                self.run_stage(&mut rebuild, stage);
                self.queue.push_front(rebuild);
            }
            let front = self.queue.front_mut().expect("the front exists");
            front.units += 1;
            if front.units == NAV_REBUILD_STAGES {
                let done = self.queue.pop_front().expect("the front exists");
                let Progress::Done(tile) = done.progress else {
                    unreachable!("the detail stage always finishes a rebuild");
                };
                finished.push(Rebuilt { cell: done.cell, tile });
            }
        }
        finished
    }

    /// Queue `cells` (sorted, once each) behind everything queued; nothing without an input. A
    /// cell with a rebuild that has not started is already covered: it reads the obstacles when
    /// it starts.
    fn queue_cells(&mut self, mut cells: Vec<CellId>) {
        if self.input.is_none() {
            return;
        }
        cells.sort_unstable();
        cells.dedup();
        for cell in cells {
            let waiting = self.queue.iter().any(|r| r.cell == cell && matches!(r.progress, Progress::Waiting));
            if !waiting {
                self.queue.push_back(Rebuild { cell, units: 0, work: Work::default(), progress: Progress::Waiting });
            }
        }
    }

    /// The resident cells whose build region a carving `obstacle` touches (none for a disc).
    fn touched_cells(&self, obstacle: &NavObstacle) -> Vec<CellId> {
        let Some(volume) = obstacle.footprint(self.config.climb).filter(|_| self.input.is_some()) else {
            return Vec::new();
        };
        self.resident.iter().copied().filter(|&cell| self.region_overlaps(cell, &volume)).collect()
    }

    /// The carving footprints over `cell`'s build region, in the order the obstacles were added.
    fn carvers_over(&self, cell: CellId) -> impl Iterator<Item = ConvexVolume> + '_ {
        let climb = self.config.climb;
        self.obstacles.values().filter_map(move |o| o.footprint(climb)).filter(move |volume| self.region_overlaps(cell, volume))
    }

    fn region_overlaps(&self, cell: CellId, volume: &ConvexVolume) -> bool {
        let border = f32::from(self.config.border_cells()) * self.config.cell_size;
        let Ok((min, max)) = tile_region([cell.x, cell.z], self.config.tile, border) else {
            return false;
        };
        let low = volume.vertices.iter().fold(Vec2::INFINITY, |acc, v| acc.min(*v));
        let high = volume.vertices.iter().fold(Vec2::NEG_INFINITY, |acc, v| acc.max(*v));
        low.cmple(max).all() && high.cmpge(min).all()
    }

    /// Run `stage` of `rebuild`, a stage its progress is waiting for.
    fn run_stage(&mut self, rebuild: &mut Rebuild, stage: Stage) {
        let progress = std::mem::replace(&mut rebuild.progress, Progress::Waiting);
        rebuild.progress = match (stage, progress) {
            (Stage::Rasterize, Progress::Waiting) => self.start(rebuild),
            (Stage::Filter, Progress::Rasterized(heightfield)) => self.filter(heightfield),
            (Stage::Compact, Progress::Filtered(heightfield)) => self.compact(rebuild, *heightfield),
            (Stage::Regions, Progress::Compacted(compact)) => self.regions(&rebuild.work, compact),
            (Stage::Contours, Progress::Regions(compact)) => self.contours(*compact),
            (Stage::Polygons, Progress::Contoured(pair)) => polygons(*pair),
            (Stage::Detail, Progress::Polygons(pair)) => self.detail(rebuild.cell, rebuild.work.input_digest, *pair),
            (_, other) => other,
        };
    }

    /// [`Stage::Rasterize`]: read the obstacles and the volumes over the tile, then rasterize its
    /// window, or take its compact heightfield from the cache when it has carving and one.
    fn start(&mut self, rebuild: &mut Rebuild) -> Progress {
        let cell = rebuild.cell;
        let carve: Vec<ConvexVolume> = self.carvers_over(cell).collect();
        if carve.is_empty() {
            self.cache.shift_remove(&cell);
        }
        if let Some(cached) = self.cache.get(&cell).filter(|_| !carve.is_empty()) {
            self.cache_hits += 1;
            let volumes = self.tile_volumes(cell).unwrap_or_default();
            rebuild.work = Work { input_digest: cached.input_digest, carve, volumes };
            return Progress::Compacted(Box::new(cached.compact.clone()));
        }
        match self.rasterize(cell) {
            Ok((work, Some(heightfield))) => {
                rebuild.work = Work { carve, ..work };
                Progress::Rasterized(Box::new(heightfield))
            }
            Ok((work, None)) => Progress::Done(NavTile::new(cell, self.config.digest(), work.input_digest, TileMesh::default())),
            Err(error) => Progress::Done(Err(error)),
        }
    }

    /// The tile's window, as [`crate::bake::bake_tile`] gathers it, rasterized; `None` for a
    /// window with no triangles.
    fn rasterize(&self, cell: CellId) -> Result<(Work, Option<Heightfield>), NavError> {
        let config = &self.config;
        let (tile_cells, border_cells) = (config.tile_cells(), config.border_cells());
        let border = f32::from(border_cells) * config.cell_size;
        let (min, _) = tile_region([cell.x, cell.z], config.tile, border)?;
        let (window, volumes) = self.window(cell)?;
        let input = self.input.as_ref().ok_or_else(|| NavError::input_invalid("no bake input"))?;
        let input_digest = window_digest(&window, input, self.floor);
        let work = Work { input_digest, carve: Vec::new(), volumes };
        let Some((low, high)) = height_range(&window, self.floor) else {
            return Ok((work, None));
        };
        let side = tile_cells + 2 * border_cells;
        let span = f32::from(side) * config.cell_size;
        let mut heightfield = Heightfield {
            width: side,
            height: side,
            aabb: Aabb3d { min: Vec3::new(min.x, low, min.y), max: Vec3::new(min.x + span, high, min.y + span) },
            cell_size: config.cell_size,
            cell_height: config.cell_height,
            spans: vec![None; usize::from(side).pow(2)],
            allocated_spans: Spans::default(),
        };
        heightfield.rasterize_triangles(&trimesh(&window), walkable_climb(config)).map_err(|error| recast_refusal(RecastError::from(error)))?;
        Ok((work, Some(heightfield)))
    }

    /// The tile's input window with steep triangles cleared, and the area volumes it marks.
    fn window(&self, cell: CellId) -> Result<(crate::input::TileInput, Vec<ConvexVolume>), NavError> {
        let border = f32::from(self.config.border_cells()) * self.config.cell_size;
        let (min, max) = tile_region([cell.x, cell.z], self.config.tile, border)?;
        let input = self.input.as_ref().ok_or_else(|| NavError::input_invalid("no bake input"))?;
        let mut window = input.tile(min, max)?;
        window.clear_steep(self.config.slope_degrees)?;
        let volumes = window.volumes.iter().map(|&i| convex_volume(&input.volumes()[i])).collect();
        Ok((window, volumes))
    }

    fn tile_volumes(&self, cell: CellId) -> Result<Vec<ConvexVolume>, NavError> {
        self.window(cell).map(|(_, volumes)| volumes)
    }

    /// [`Stage::Filter`]: Recast's span filters, in `buildTileMesh`'s order.
    fn filter(&self, mut heightfield: Box<Heightfield>) -> Progress {
        let (height, climb) = (walkable_height(&self.config), walkable_climb(&self.config));
        heightfield.filter_low_hanging_walkable_obstacles(climb);
        heightfield.filter_ledge_spans(height, climb);
        heightfield.filter_walkable_low_height_spans(height);
        Progress::Filtered(heightfield)
    }

    /// [`Stage::Compact`]: the compact heightfield, cached while carving covers the tile.
    fn compact(&mut self, rebuild: &Rebuild, heightfield: Heightfield) -> Progress {
        let compact = match heightfield.into_compact(walkable_height(&self.config), walkable_climb(&self.config)) {
            Ok(compact) => compact,
            Err(error) => return Progress::Done(Err(recast_refusal(RecastError::from(error)))),
        };
        if !rebuild.work.carve.is_empty() {
            self.cache.insert(rebuild.cell, Cached { input_digest: rebuild.work.input_digest, compact: compact.clone() });
        }
        Progress::Compacted(Box::new(compact))
    }

    /// [`Stage::Regions`]: carve (the null area, before erosion), erode, mark the area volumes,
    /// then the distance field and regions.
    fn regions(&self, work: &Work, mut compact: Box<CompactHeightfield>) -> Progress {
        for volume in &work.carve {
            compact.mark_convex_poly_area(volume);
        }
        compact.erode_walkable_area(self.config.radius_cells());
        for volume in &work.volumes {
            compact.mark_convex_poly_area(volume);
        }
        compact.build_distance_field();
        let min_area = self.config.min_region_cells.saturating_mul(self.config.min_region_cells);
        let merge_area = self.config.merge_region_cells.saturating_mul(self.config.merge_region_cells);
        match compact.build_regions(self.config.border_cells(), min_area, merge_area) {
            Ok(()) => Progress::Regions(compact),
            Err(error) => Progress::Done(Err(recast_refusal(RecastError::from(error)))),
        }
    }

    /// [`Stage::Contours`].
    fn contours(&self, compact: CompactHeightfield) -> Progress {
        let max_edge_cells = (self.config.max_edge_length / self.config.cell_size).round().min(f32::from(u16::MAX)) as u16;
        let contours = compact.build_contours(self.config.max_simplification_error, max_edge_cells, BuildContoursFlags::default());
        Progress::Contoured(Box::new((compact, contours)))
    }

    /// [`Stage::Detail`]: the detail mesh, then the tile in metres.
    fn detail(&self, cell: CellId, input_digest: u64, (compact, poly): (CompactHeightfield, PolygonNavmesh)) -> Progress {
        let config = &self.config;
        let sample_distance = if config.detail_sample_cells < DETAIL_SAMPLE_CELLS_MIN { 0.0 } else { config.cell_size * config.detail_sample_cells };
        let detail = match DetailNavmesh::new(&poly, &compact, sample_distance, config.cell_height * config.detail_max_error_cells) {
            Ok(detail) => detail,
            Err(error) => return Progress::Done(Err(recast_refusal(RecastError::from(error)))),
        };
        let corner = Vec2::new(cell.x as f32 * config.tile, cell.z as f32 * config.tile);
        let mesh = tile_mesh(&poly, &detail, corner, config, config.tile_cells());
        Progress::Done(NavTile::new(cell, config.digest(), input_digest, mesh))
    }
}

/// [`Stage::Polygons`].
fn polygons((compact, contours): (CompactHeightfield, ContourSet)) -> Progress {
    match contours.into_polygon_mesh(NAV_TILE_POLYGON_VERTICES_MAX as u16) {
        Ok(poly) => Progress::Polygons(Box::new((compact, poly))),
        Err(error) => Progress::Done(Err(recast_refusal(RecastError::from(error)))),
    }
}

/// Recast's `walkableHeight`: the walker's height in cells, rounded up.
fn walkable_height(config: &BakeConfig) -> u16 {
    (config.height / config.cell_height).ceil() as u16
}

/// Recast's `walkableClimb`: the walker's climb in cells, rounded down.
fn walkable_climb(config: &BakeConfig) -> u16 {
    (config.climb / config.cell_height).floor() as u16
}

/// The bytes a compact heightfield's tables take.
fn compact_bytes(compact: &CompactHeightfield) -> usize {
    use std::mem::size_of_val;
    size_of_val(compact.cells.as_slice()) + size_of_val(compact.spans.as_slice()) + size_of_val(compact.dist.as_slice()) + size_of_val(compact.areas.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rotated_box_hull_holds_its_corners_counter_clockwise() {
        let transform = Mat4::from_scale_rotation_translation(Vec3::new(2.0, 1.0, 1.0), glam::Quat::from_rotation_y(0.4), Vec3::new(3.0, 0.5, 1.0));
        let volume = NavObstacle::CarveBox { transform }.footprint(0.4).expect("a box carves");
        assert!((4..=8).contains(&volume.vertices.len()), "{:?}", volume.vertices);
        let n = volume.vertices.len();
        for k in 0..n {
            let (a, b, c) = (volume.vertices[k], volume.vertices[(k + 1) % n], volume.vertices[(k + 2) % n]);
            assert!((b - a).perp_dot(c - b) > 0.0, "convex, counter-clockwise");
        }
        assert!((volume.min_y - (0.0 - 0.4)).abs() < 1e-5 && (volume.max_y - 1.0).abs() < 1e-5);
    }

    #[test]
    fn a_cylinder_becomes_a_12_gon_around_its_circle() {
        let volume = NavObstacle::CarveCylinder { base: Vec3::new(1.0, 2.0, 3.0), radius: 0.5, height: 1.0 }.footprint(0.0).expect("carves");
        assert_eq!(volume.vertices.len(), CYLINDER_SIDES);
        for (k, v) in volume.vertices.iter().enumerate() {
            let edge_mid = (*v + volume.vertices[(k + 1) % CYLINDER_SIDES]) / 2.0;
            assert!((edge_mid - Vec2::new(1.0, 3.0)).length() >= 0.5 - 1e-5, "every edge stays outside the circle");
        }
        assert!(NavObstacle::Avoid { position: Vec3::ZERO, radius: 1.0 }.footprint(0.4).is_none());
    }
}
