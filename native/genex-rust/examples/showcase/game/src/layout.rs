//! The lakeside's fixed layout: the terrain's height and surface, the lake, the path, and where
//! every tree, rock, grass blade, lantern and firefly stands. Everything here is a pure function of
//! [`LAYOUT_SEED`], so every seed, every destination and every re-render after a renderer change
//! sees the same scene (the before/after captures compare shot for shot).

use std::sync::OnceLock;

use genex::Pcg32;
use genex::math::{self, Vec2, Vec3, vec2, vec3};

/// The seed the whole layout is drawn from (never the game's seed: the scenery never changes).
pub const LAYOUT_SEED: u64 = 0x1a4e_51de;
/// The lake's surface height.
pub const WATER_LEVEL: f32 = 0.0;
/// The lake's centre (x, z) and its radii before the shoreline wobble.
pub const LAKE_CENTER: Vec2 = vec2(6.0, 2.0);
/// The lake's radii along x and z.
pub const LAKE_RADII: Vec2 = vec2(21.0, 15.0);
/// The terrain covers x and z in `-TERRAIN_HALF..TERRAIN_HALF`.
pub const TERRAIN_HALF: f32 = 96.0;
/// The cabin's centre (x, z), its floor height and the way its front faces (radians about +y,
/// 0 = +z).
pub const CABIN: Vec2 = vec2(-9.0, -21.0);
/// The cabin floor's height.
pub const CABIN_FLOOR: f32 = 1.7;
/// The cabin's yaw: its front (door, porch) looks across the lake.
pub const CABIN_YAW: f32 = 0.42;
/// The direction towards the sun the draw hook lights the scene with (`frame.sun`): 7 degrees up,
/// a golden hour under the physical sky (the light reaching the ground is reddened by the
/// atmosphere the way the sky is), and where the passes' glow and water glint stream from
/// (`GLOW_DIR` in common.wgsl). The grass's shadows under the trees are placed along it.
pub const SUN_DIR: Vec3 = vec3(0.794, 0.122, 0.596);
/// The path's half width.
pub const PATH_HALF_WIDTH: f32 = 1.05;
/// The dock deck's height above the water.
pub const DOCK_DECK: f32 = 0.55;
/// The dock's length out over the water.
pub const DOCK_LENGTH: f32 = 12.0;
/// Grass blade candidates the layout scattered before A.8 (their randoms are still drawn).
const OLD_BLADE_CANDIDATES: u32 = 480_000;
/// Tree candidates the forest mask filters.
const TREE_CANDIDATES: u32 = 2_600;
/// Fireflies and drifting pollen motes.
const FIREFLIES: u32 = 150;
const MOTES: u32 = 240;

/// The path from the meadow in front of the camera to the cabin's porch, then on to the dock.
pub const PATH: [Vec2; 9] = [
    vec2(-58.0, 14.0),
    vec2(-46.0, 10.0),
    vec2(-36.0, 7.5),
    vec2(-27.0, 2.0),
    vec2(-21.0, -5.0),
    vec2(-15.5, -10.5),
    vec2(-9.0, -13.5),
    vec2(-5.5, -13.0),
    vec2(-2.8, -11.2),
];

/// Clearings (x, z, radius) kept free of trees and boulders: around the named shots' viewpoints,
/// and the wide shot's view down to the lake.
pub const CLEARINGS: [(f32, f32, f32); 8] = [
    (-30.0, 12.0, 16.0),
    (-22.0, 8.0, 9.0),
    (-14.0, 5.0, 8.0),
    (-15.0, -5.5, 6.0),
    (-25.0, -37.0, 5.0),
    (-16.5, -33.0, 6.0),
    (-30.0, -2.0, 7.0),
    (-21.0, -2.0, 6.0),
];

/// A tree's species.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeKind {
    /// A pine: whorls of drooping branches up a tapering trunk.
    Pine,
    /// A broadleaf tree: limbs and branches under a leafy crown.
    Round,
    /// A broadleaf already turning gold.
    Golden,
}

/// How finely a tree is drawn: one of its levels of detail, which the renderer chooses by the
/// tree's size on screen ([`tree_level_metres`]). Every level keeps the crown's shape (the tree
/// meshes share their skeleton and leaf clusters).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeLod {
    /// Every twig and leaf.
    Near,
    /// The branches without twigs, fewer and larger leaves.
    Middle,
    /// The trunk and limbs, a few large leaves per cluster.
    Far,
}

/// Where the levels change at the showcase's own view ([`TREE_VIEW_ROWS`] and
/// [`TREE_VIEW_FOVY_DEGREES`], the one-pixel threshold), in metres from the camera to the tree's
/// base, for a tree of scale 1: where the hand-picked levels switched before the renderer chose
/// them (a bigger tree switches later, a sharper view or a stricter preset later, a coarser
/// preset sooner).
pub const TREE_LOD_DISTANCES: [f32; 2] = [24.0, 58.0];
/// The radius of the tree meshes' bounding spheres at scale 1, about (4.1 to 5.3 m measured): the
/// renderer measures a level's distance to the nearest point of the sphere, the base distances
/// [`TREE_LOD_DISTANCES`] less this.
pub const TREE_BOUNDS_RADIUS: f32 = 4.5;
/// The height of the tree meshes' bounding spheres' centres over the base at scale 1, about.
pub const TREE_BOUNDS_HEIGHT: f32 = 3.5;
/// The rows of the view [`TREE_LOD_DISTANCES`] hold at: the showcase's world height, which the
/// Studio's captures draw at.
pub const TREE_VIEW_ROWS: f32 = crate::showcase::WORLD_SIZE[1] as f32;
/// The vertical field of view, degrees, [`TREE_LOD_DISTANCES`] hold at: the free camera's.
pub const TREE_VIEW_FOVY_DEGREES: f32 = 50.0;
/// The rows of the view `Model::with_levels` distances are given at (with
/// [`genex::LOD_NOMINAL_FOV_DEGREES`]).
const NOMINAL_ROWS: f32 = 1080.0;

/// The authored levels' switch distances (`Model::with_levels`, at the nominal view):
/// [`TREE_LOD_DISTANCES`] measured to the bounding sphere and carried from the showcase's view to
/// the nominal one (by the ratio of their pixels per metre at distance 1), so a tree at the
/// showcase's view switches where its base distance did. At its 720 rows and 50 degrees a metre
/// covers 0.83 of the nominal view's pixels: given at the nominal view unconverted, every tree
/// switched 17% sooner and the forest shot's middle broadleaf drew its coarser level.
pub fn tree_level_metres() -> [f32; 2] {
    let pixels_per_metre = |rows: f32, fovy_degrees: f32| rows * 0.5 / math::tan((fovy_degrees * 0.5).to_radians());
    let ratio = pixels_per_metre(TREE_VIEW_ROWS, TREE_VIEW_FOVY_DEGREES) / pixels_per_metre(NOMINAL_ROWS, genex::LOD_NOMINAL_FOV_DEGREES);
    TREE_LOD_DISTANCES.map(|distance| (distance - TREE_BOUNDS_RADIUS) / ratio)
}

impl TreeLod {
    /// Every level, nearest first.
    pub const ALL: [TreeLod; 3] = [TreeLod::Near, TreeLod::Middle, TreeLod::Far];

    /// Its index in [`TreeLod::ALL`].
    pub const fn index(self) -> usize {
        self as usize
    }
}

/// A tree mesh's asset name: a pine's or a broadleaf's, `variant`, at `lod`, its foliage or its wood.
pub fn tree_asset(pine: bool, variant: u32, lod: TreeLod, foliage: bool) -> String {
    let species = if pine { "pine" } else { "broadleaf" };
    let part = if foliage { "foliage" } else { "wood" };
    format!("tree-{species}-{variant}-lod{}-{part}.glb", lod.index())
}

/// One tree.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tree {
    /// Where its trunk meets the ground.
    pub base: Vec3,
    /// Its species.
    pub kind: TreeKind,
    /// Its size (1 is a typical tree, about 7 m).
    pub scale: f32,
    /// Its turn about +y.
    pub yaw: f32,
    /// Which mesh variant it uses (0..3).
    pub variant: u32,
    /// Its colour variation, 0..1.
    pub tint: f32,
}

/// One rock.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rock {
    /// Its centre, sunk a little into the ground.
    pub center: Vec3,
    /// Its size per axis.
    pub size: Vec3,
    /// Its turn about +y.
    pub yaw: f32,
    /// Which mesh variant it uses (0..3).
    pub variant: u32,
    /// Its colour variation, 0..1.
    pub tint: f32,
}

/// The dock: where it leaves the shore and the way it points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dock {
    /// Its landward end (x, z).
    pub start: Vec2,
    /// The unit direction it runs out over the lake (x, z).
    pub dir: Vec2,
}

impl Dock {
    /// A point `along` metres out and `across` metres to its right, at deck height.
    pub fn at(&self, along: f32, across: f32) -> Vec3 {
        let right = vec2(-self.dir.y, self.dir.x);
        let p = self.start + self.dir * along + right * across;
        vec3(p.x, WATER_LEVEL + DOCK_DECK, p.y)
    }

    /// Its yaw about +y (0 = +z), for the planks and posts.
    pub fn yaw(&self) -> f32 {
        math::atan2(self.dir.x, self.dir.y)
    }
}

/// Everything placed in the scene.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    /// The trees.
    pub trees: Vec<Tree>,
    /// The rocks.
    pub rocks: Vec<Rock>,
    /// The lanterns' light positions.
    pub lanterns: Vec<Vec3>,
    /// The fireflies' home points.
    pub fireflies: Vec<Vec3>,
    /// The pollen motes' home points.
    pub motes: Vec<Vec3>,
    /// The dock.
    pub dock: Dock,
}

/// The layout, built once per process (it never changes).
pub fn layout() -> &'static Layout {
    static LAYOUT: OnceLock<Layout> = OnceLock::new();
    LAYOUT.get_or_init(Layout::build)
}

/// `t` eased between `edge0` and `edge1` (either order), clamped to 0..1.
pub fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// `a` to `b` by `t`.
pub fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// A hash of a lattice point and a salt to 0..1 (integer only: the same bits everywhere).
pub fn hash2(ix: i32, iz: i32, salt: u32) -> f32 {
    let mut h = (ix as u32).wrapping_mul(0x8da6_b343) ^ (iz as u32).wrapping_mul(0xd816_3841) ^ salt.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^= h >> 15;
    (h & 0x00ff_ffff) as f32 / 16_777_215.0
}

/// Smooth value noise in 0..1.
pub fn value_noise(p: Vec2, salt: u32) -> f32 {
    let cell = p.floor();
    let f = p - cell;
    let u = f * f * (Vec2::splat(3.0) - 2.0 * f);
    let (ix, iz) = (cell.x as i32, cell.y as i32);
    let a = hash2(ix, iz, salt);
    let b = hash2(ix + 1, iz, salt);
    let c = hash2(ix, iz + 1, salt);
    let d = hash2(ix + 1, iz + 1, salt);
    mix(mix(a, b, u.x), mix(c, d, u.x), u.y)
}

/// Fractal value noise in 0..1.
pub fn fbm(p: Vec2, octaves: u32, salt: u32) -> f32 {
    let (mut sum, mut amplitude, mut norm, mut q) = (0.0, 0.5, 0.0, p);
    for octave in 0..octaves {
        sum += amplitude * value_noise(q, salt.wrapping_add(octave * 101));
        norm += amplitude;
        amplitude *= 0.5;
        q = q * 2.03 + vec2(17.1, 9.7);
    }
    sum / norm
}

/// The lake's normalised radius at (x, z): below 1 is water, 1 is the shoreline.
pub fn lake_radius(x: f32, z: f32) -> f32 {
    let q = (vec2(x, z) - LAKE_CENTER) / LAKE_RADII;
    let a = math::atan2(q.y, q.x);
    let wobble = 1.0 + 0.10 * math::sin(3.0 * a + 0.6) + 0.06 * math::sin(5.0 * a + 2.2) + 0.035 * math::sin(9.0 * a + 1.0);
    q.length() / wobble
}

/// Points per path segment after smoothing.
const PATH_SUBDIVISIONS: usize = 8;
/// Beyond this distance from the path's bounds, [`path_distance`] answers a lower bound only.
const PATH_FAR: f32 = 8.0;

/// The path smoothed through [`PATH`] (Catmull-Rom), as a fine polyline, and its bounds.
pub fn path_points() -> &'static (Vec<Vec2>, Vec2, Vec2) {
    static POINTS: OnceLock<(Vec<Vec2>, Vec2, Vec2)> = OnceLock::new();
    POINTS.get_or_init(|| {
        let at = |i: isize| PATH[i.clamp(0, PATH.len() as isize - 1) as usize];
        let mut points = Vec::new();
        for i in 0..PATH.len() as isize - 1 {
            let (p0, p1, p2, p3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
            for k in 0..PATH_SUBDIVISIONS {
                let t = k as f32 / PATH_SUBDIVISIONS as f32;
                let (t2, t3) = (t * t, t * t * t);
                let p = 0.5 * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 + (3.0 * p1 - p0 - 3.0 * p2 + p3) * t3);
                points.push(p);
            }
        }
        points.push(PATH[PATH.len() - 1]);
        let min = points.iter().fold(Vec2::splat(f32::MAX), |m, p| m.min(*p));
        let max = points.iter().fold(Vec2::splat(f32::MIN), |m, p| m.max(*p));
        (points, min, max)
    })
}

/// The distance from (x, z) to the path (a lower bound, at least [`PATH_FAR`], far from it).
pub fn path_distance(x: f32, z: f32) -> f32 {
    let (points, min, max) = path_points();
    let p = vec2(x, z);
    let outside = (*min - p).max(p - *max).max(Vec2::ZERO).length();
    if outside > PATH_FAR {
        return outside;
    }
    points
        .windows(2)
        .map(|pair| {
            let (a, b) = (pair[0], pair[1]);
            let ab = b - a;
            let t = ((p - a).dot(ab) / ab.length_squared().max(1e-6)).clamp(0.0, 1.0);
            (p - (a + ab * t)).length()
        })
        .fold(f32::MAX, f32::min)
}

/// The path's half width at (x, z): it wanders a little.
pub fn path_half_width(x: f32, z: f32) -> f32 {
    PATH_HALF_WIDTH * (0.85 + 0.3 * value_noise(vec2(x, z) * 0.5, 5))
}

/// The cabin yard's radius in direction `angle` (radians about +y from +x).
pub fn yard_radius(angle: f32) -> f32 {
    5.4 + 0.5 * math::sin(3.0 * angle + 0.7) + 0.35 * math::sin(5.0 * angle + 2.0)
}

/// Distance from (x, z) to the cabin's centre.
pub fn cabin_distance(x: f32, z: f32) -> f32 {
    (vec2(x, z) - CABIN).length()
}

/// The terrain's height at (x, z).
pub fn height(x: f32, z: f32) -> f32 {
    let p = vec2(x, z);
    let r = lake_radius(x, z);
    let rolling = fbm(p * 0.028, 4, 1);
    let detail = fbm(p * 0.11, 3, 2) - 0.5;
    let land = if r < 1.0 {
        -2.6 * (1.0 - r * r) + 0.15 * detail
    } else {
        let t = r - 1.0;
        let shore = (t * 2.6).min(0.9);
        shore + smoothstep(0.08, 1.3, t) * (rolling * 3.6 + detail * 0.7)
    };
    let far_hills = smoothstep(40.0, 92.0, x) * (8.0 + 12.0 * fbm(vec2(z * 0.03, 4.0), 3, 3));
    let side_hills = smoothstep(32.0, 84.0, z.abs()) * (5.0 + 7.0 * fbm(vec2(x * 0.035, z * 0.01 + 9.0), 3, 4));
    let back_hills = smoothstep(-58.0, -94.0, x) * 7.0;
    let mut h = land + far_hills + side_hills + back_hills;
    // The cabin stands on a levelled yard; the path is worn a little into the meadow.
    h = mix(h, CABIN_FLOOR - 0.25, 1.0 - smoothstep(6.0, 10.0, cabin_distance(x, z)));
    h - 0.14 * (1.0 - smoothstep(0.6, 2.2, path_distance(x, z)))
}

/// How much of each terrain layer covers (x, z): soil (the path and the yard), sand (the beach and
/// the lake bed), rock (steep slopes) and the meadow's dryness (0 lush to 1 golden); grass is what
/// the other layers leave. Each 0..1, soft-edged, from the layout's own functions.
pub fn splat_weights(x: f32, z: f32) -> [f32; 4] {
    let p = vec2(x, z);
    let edge = 0.25 * (value_noise(p * 1.7, 21) - 0.5);
    let path = 1.0 - smoothstep(-0.25, 0.3, path_distance(x, z) - path_half_width(x, z) + edge);
    let d = p - CABIN;
    let yard = 1.0 - smoothstep(-0.6, 0.4, d.length() - yard_radius(math::atan2(d.y, d.x)) + edge * 2.0);
    let soil = path.max(yard);
    let h = height(x, z);
    let shore = (1.0 - smoothstep(0.02, 0.22, h - WATER_LEVEL + edge * 0.4)) * (1.0 - smoothstep(1.15, 1.3, lake_radius(x, z)));
    let grassy_bank = smoothstep(0.62, 0.74, value_noise(p * 0.12, 9)) * smoothstep(-0.25, 0.0, h - WATER_LEVEL);
    let sand = (shore * (1.0 - grassy_bank)).max(1.0 - smoothstep(-0.35, -0.1, h - WATER_LEVEL));
    let steep = smoothstep(0.93, 0.84, normal(x, z).y) * smoothstep(2.0, 3.5, h);
    let patch = fbm(p * 0.045, 3, 7) + 0.18 * (value_noise(p * 0.35, 8) - 0.5);
    let dry = smoothstep(0.38, 0.66, patch);
    [soil, sand * (1.0 - soil), steep * (1.0 - soil), dry]
}

/// Metres between the terrain's height samples (renderer pass 2 A.7: the built-in terrain's
/// height field, a finer grid than the 0.75 m mesh it replaced).
pub const TERRAIN_SPACING: f32 = 0.5;
/// Height samples a side: `-TERRAIN_HALF..=TERRAIN_HALF` every [`TERRAIN_SPACING`].
pub const TERRAIN_SAMPLES: u32 = 385;

/// The terrain's layers in control-map order (`world::terrain` makes them): lush grass, dry grass,
/// soil, sand, rock and the lake bed (the sand under the water, darkened with depth).
pub const TERRAIN_LAYERS: usize = 6;

/// What the terrain is made of at (x, z) as one control texel: the two layers that cover most of
/// it (the second's share of the pair as the blend) and how wet it is beside the water.
pub fn terrain_texel(x: f32, z: f32) -> genex::TerrainTexel {
    let [soil, sand, rock, dry] = splat_weights(x, z);
    let h = height(x, z);
    let grass = (1.0 - soil - sand - rock).max(0.0);
    let bed = 1.0 - smoothstep(WATER_LEVEL - 1.4, WATER_LEVEL - 0.1, h);
    let weights = [grass * (1.0 - dry), grass * dry, soil, sand * (1.0 - bed), rock, sand * bed];
    let mut order: [usize; TERRAIN_LAYERS] = [0, 1, 2, 3, 4, 5];
    // The heaviest two, ties to the earlier layer (a fixed order: the same texel on every target).
    order.sort_by(|a, b| weights[*b].total_cmp(&weights[*a]).then(a.cmp(b)));
    let (first, second) = (order[0], order[1]);
    let pair = weights[first] + weights[second];
    let amount = if pair > 0.0 { weights[second] / pair } else { 0.0 };
    let wet = 1.0 - smoothstep(WATER_LEVEL + 0.02, WATER_LEVEL + 0.35, h);
    genex::TerrainTexel::blend(first as u8, second as u8, amount).with_wetness(wet)
}

/// The terrain's heights and control map over `-TERRAIN_HALF..=TERRAIN_HALF`, computed once per
/// process (the layout never changes).
pub fn terrain_ground() -> &'static (Vec<f32>, Vec<genex::TerrainTexel>) {
    static GROUND: OnceLock<(Vec<f32>, Vec<genex::TerrainTexel>)> = OnceLock::new();
    GROUND.get_or_init(|| {
        let n = TERRAIN_SAMPLES;
        let at = |k: u32| -TERRAIN_HALF + k as f32 * TERRAIN_SPACING;
        let mut heights = Vec::with_capacity((n * n) as usize);
        let mut control = Vec::with_capacity((n * n) as usize);
        for j in 0..n {
            for i in 0..n {
                heights.push(height(at(i), at(j)));
                control.push(terrain_texel(at(i), at(j)));
            }
        }
        (heights, control)
    })
}

/// The terrain's unit normal at (x, z).
pub fn normal(x: f32, z: f32) -> Vec3 {
    let e = 0.35;
    vec3(height(x - e, z) - height(x + e, z), 2.0 * e, height(x, z - e) - height(x, z + e)).normalize()
}

/// Whether (x, z) is kept clear of trees, rocks and props: the lake and its beach, the path, the
/// cabin's yard and the dock's landing.
fn kept_clear(x: f32, z: f32, margin: f32) -> bool {
    let in_clearing = CLEARINGS.iter().any(|&(cx, cz, r)| (vec2(x, z) - vec2(cx, cz)).length() < r + margin);
    in_clearing
        || lake_radius(x, z) < 1.18 + margin * 0.05
        || path_distance(x, z) < 2.4 + margin
        || cabin_distance(x, z) < 8.5 + margin
        || x.abs() > TERRAIN_HALF - 4.0
        || z.abs() > TERRAIN_HALF - 4.0
}

impl Layout {
    /// Build the layout from [`LAYOUT_SEED`].
    pub fn build() -> Layout {
        let mut rng = Pcg32::seeded(LAYOUT_SEED);
        let dock = dock();
        let trees = trees(&mut rng);
        let rocks = rocks(&mut rng);
        skip_old_blades(&mut rng);
        let lanterns = lanterns(&dock);
        let fireflies = fireflies(&mut rng, &trees);
        let motes = motes(&mut rng);
        Layout { trees, rocks, lanterns, fireflies, motes, dock }
    }
}

/// The dock leaves the shore where the path ends and points across the lake.
fn dock() -> Dock {
    let start = PATH[PATH.len() - 1];
    let dir = (LAKE_CENTER + vec2(-4.0, -2.0) - start).normalize();
    Dock { start, dir }
}

/// How likely a tree is at (x, z): the woods behind the cabin, the hills and a few lone trees.
fn forest_density(x: f32, z: f32) -> f32 {
    let p = vec2(x, z);
    let clumps = fbm(p * 0.03, 3, 11);
    let behind_cabin = smoothstep(-27.0, -38.0, z);
    let far = smoothstep(34.0, 50.0, x);
    let flank = smoothstep(24.0, 36.0, z);
    let back = smoothstep(-46.0, -62.0, x);
    let woods = behind_cabin.max(far).max(flank).max(back);
    // Elsewhere (the meadow, the near shore) only a few loners.
    (woods * 0.8 + clumps * 0.5 - 0.3).clamp(0.02, 1.0)
}

fn trees(rng: &mut Pcg32) -> Vec<Tree> {
    let mut trees: Vec<Tree> = Vec::new();
    for _ in 0..TREE_CANDIDATES {
        let x = rng.range_f32(-TERRAIN_HALF + 6.0, TERRAIN_HALF - 6.0);
        let z = rng.range_f32(-TERRAIN_HALF + 6.0, TERRAIN_HALF - 6.0);
        let roll = rng.unit();
        let (scale, yaw, variant, tint, kind_roll) = (rng.range_f32(0.75, 1.3), rng.range_f32(0.0, math::TAU), rng.below(3), rng.unit(), rng.unit());
        if roll > forest_density(x, z) || kept_clear(x, z, 0.0) || normal(x, z).y < 0.82 {
            continue;
        }
        let spacing = 3.2 * scale;
        if trees.iter().any(|t| (vec2(t.base.x, t.base.z) - vec2(x, z)).length() < spacing) {
            continue;
        }
        let hilly = smoothstep(4.0, 9.0, height(x, z));
        let kind = if kind_roll < 0.42 + 0.45 * hilly {
            TreeKind::Pine
        } else if kind_roll < 0.9 {
            TreeKind::Round
        } else {
            TreeKind::Golden
        };
        trees.push(Tree { base: vec3(x, height(x, z) - 0.1, z), kind, scale, yaw, variant, tint });
    }
    trees
}

fn rocks(rng: &mut Pcg32) -> Vec<Rock> {
    let mut rocks = Vec::new();
    // Along the shore: half in the water, half on the beach.
    for _ in 0..24 {
        let a = rng.range_f32(0.0, math::TAU);
        let r = rng.range_f32(0.97, 1.16);
        let wobble_free = vec2(math::cos(a), math::sin(a)) * LAKE_RADII * r;
        let mut p = LAKE_CENTER + wobble_free;
        // Walk to the real shoreline (the wobble moves it).
        for _ in 0..12 {
            let lr = lake_radius(p.x, p.y);
            p = LAKE_CENTER + (p - LAKE_CENTER) * (r / lr).clamp(0.9, 1.1);
        }
        let size = rng.range_f32(0.3, 0.8);
        let squash = vec3(size * rng.range_f32(0.9, 1.5), size * rng.range_f32(0.5, 0.8), size * rng.range_f32(0.8, 1.3));
        let (yaw, variant, tint) = (rng.range_f32(0.0, math::TAU), rng.below(3), rng.unit());
        if (p - PATH[PATH.len() - 1]).length() < 3.5 {
            continue;
        }
        rocks.push(Rock { center: vec3(p.x, height(p.x, p.y) + squash.y * 0.15, p.y), size: squash, yaw, variant, tint });
    }
    // Scattered in the meadow and the woods, a few boulders among them.
    for _ in 0..70 {
        let x = rng.range_f32(-70.0, 70.0);
        let z = rng.range_f32(-60.0, 60.0);
        let boulder = rng.chance(0.18);
        let size = if boulder { rng.range_f32(1.4, 2.6) } else { rng.range_f32(0.3, 0.9) };
        let squash = vec3(size * rng.range_f32(0.9, 1.4), size * rng.range_f32(0.55, 0.85), size * rng.range_f32(0.9, 1.3));
        let (yaw, variant, tint) = (rng.range_f32(0.0, math::TAU), rng.below(3), rng.unit());
        if kept_clear(x, z, -1.0) || lake_radius(x, z) < 1.3 {
            continue;
        }
        rocks.push(Rock { center: vec3(x, height(x, z) + squash.y * 0.1, z), size: squash, yaw, variant, tint });
    }
    rocks
}

/// The randoms the layout drew for its grass blades before the meadow became the renderer's
/// (renderer pass 2 A.8: the terrain's grassy layers grow it, `world::terrain`): still drawn, seven
/// a candidate, so the lanterns, fireflies and motes keep their places.
fn skip_old_blades(rng: &mut Pcg32) {
    for _ in 0..OLD_BLADE_CANDIDATES * 7 {
        rng.unit();
    }
}

fn lanterns(dock: &Dock) -> Vec<Vec3> {
    let on_path = |i: usize, t: f32, side: f32| {
        let (a, b) = (PATH[i], PATH[i + 1]);
        let dir = (b - a).normalize();
        let p = a + (b - a) * t + vec2(-dir.y, dir.x) * side;
        vec3(p.x, height(p.x, p.y) + 1.55, p.y)
    };
    let porch = CABIN + vec2(math::sin(CABIN_YAW), math::cos(CABIN_YAW)) * 4.6 + vec2(math::cos(CABIN_YAW), -math::sin(CABIN_YAW)) * 2.2;
    vec![
        on_path(2, 0.5, 1.7),
        on_path(4, 0.7, 1.7),
        on_path(5, 0.8, -1.8),
        vec3(porch.x, CABIN_FLOOR + 1.9, porch.y),
        dock.at(DOCK_LENGTH - 0.2, 0.95) + vec3(0.0, 1.05, 0.0),
        dock.at(DOCK_LENGTH - 0.2, -0.95) + vec3(0.0, 1.05, 0.0),
    ]
}

fn fireflies(rng: &mut Pcg32, trees: &[Tree]) -> Vec<Vec3> {
    let mut points = Vec::new();
    let mut tries = 0;
    while points.len() < FIREFLIES as usize && tries < 20_000 {
        tries += 1;
        let x = rng.range_f32(-48.0, 16.0);
        let z = rng.range_f32(-42.0, 24.0);
        let up = rng.range_f32(0.4, 2.6);
        // At the wood's edge and along the path: near a tree, or near the path, never over the lake.
        let near_tree = trees.iter().any(|t| (vec2(t.base.x, t.base.z) - vec2(x, z)).length() < 7.0);
        let near_path = path_distance(x, z) < 6.0;
        if lake_radius(x, z) < 1.05 || !(near_tree || near_path) {
            continue;
        }
        points.push(vec3(x, height(x, z).max(WATER_LEVEL) + up, z));
    }
    points
}

fn motes(rng: &mut Pcg32) -> Vec<Vec3> {
    (0..MOTES)
        .map(|_| {
            let x = rng.range_f32(-40.0, 14.0);
            let z = rng.range_f32(-30.0, 22.0);
            let up = rng.range_f32(0.5, 4.5);
            vec3(x, height(x, z).max(WATER_LEVEL) + up, z)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_is_the_same_every_time_it_is_built() {
        assert_eq!(Layout::build(), Layout::build());
    }

    #[test]
    fn the_lake_holds_water_and_the_cabin_stands_on_dry_ground() {
        assert!(height(LAKE_CENTER.x, LAKE_CENTER.y) < WATER_LEVEL - 1.5);
        assert!(height(CABIN.x, CABIN.y) > WATER_LEVEL + 1.0);
        // The lake's middle is the terrain's lake-bed layer (the last of `TERRAIN_LAYERS`).
        assert_eq!(usize::from(terrain_texel(LAKE_CENTER.x, LAKE_CENTER.y).control().base()), TERRAIN_LAYERS - 1);
    }
}
