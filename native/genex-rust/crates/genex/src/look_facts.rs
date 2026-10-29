//! Look facts (AAA review WP-2): `state().__render.look`, what the frame last drawn showed of each
//! draw tag, so the harness can hold a round to the look bar with numbers instead of a guess:
//! how much of the screen is a flat-coloured box, how many texels and screen pixels a metre of a
//! surface gets, how dense its mesh is, and whether it carries normal, ORM and alpha-card maps.
//! The contract is `src/shared/render-look.ts`; `tests/fixtures/render-look-v1.json` holds both
//! sides to one shape.
//!
//! The facts come from a coarse CPU coverage raster ([`GRID_LONG_SIDE`] cells along the frame's
//! long side), never the GPU, so they are the same on every device and need no read-back: each
//! world mesh the frame hands the renderer is rasterised with a depth test, as its own triangles
//! when it has at most [`PROXY_TRIANGLES_MAX`] ([`MeshStats::proxy`]) and as its bounding box
//! otherwise, and each cell keeps the nearest draw's facts. A share is therefore a share of the
//! screen after occlusion. Custom (Level-2) draws, skinned characters, terrain, water, grass and
//! particles are not rasterised; past [`RASTER_TRIANGLES_MAX`] triangles a frame the rest is
//! counted, not drawn. Display only: outside the checksum, never compared.

use std::collections::BTreeMap;
use std::sync::Arc;

use genex_core::json::Value as CoreValue;
use genex_render::mesh::MeshData;
use genex_render::pbr::UvMapping;
use genex_render::scene::{Material, MeshId};
use glam::{Mat4, Vec3, Vec4};

use crate::camera::{Camera, Projection};

/// The version `__render.look` carries (`RENDER_LOOK_VERSION` in `src/shared/render-look.ts`).
pub const LOOK_FACTS_VERSION: u32 = 1;
/// Cells along the frame's long side.
pub const GRID_LONG_SIDE: u32 = 160;
/// A mesh with at most this many triangles is rasterised as itself; a larger one as its box.
pub const PROXY_TRIANGLES_MAX: usize = 2048;
/// Triangles one frame rasterises at most; draws past it are counted, not drawn.
pub const RASTER_TRIANGLES_MAX: usize = 400_000;
/// The most tags `__render.look` lists (the rest count only in the totals).
pub const TAGS_MAX: usize = 256;
/// The most model paths one tag lists (`models`).
pub const MODELS_PER_TAG_MAX: usize = 64;
/// The near plane the raster clips at, in world units (the presenter's).
const NEAR: f32 = 0.1;
/// Decimals the shares and densities are written with (display figures, stable to read).
const SHARE_SCALE: f64 = 10_000.0;
const DENSITY_SCALE: f64 = 10.0;
const EV_SCALE: f64 = 10_000.0;

/// What a mesh's geometry says about its look, measured once when it loads.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshStats {
    /// Model-space bounds: the least corner.
    pub min: [f32; 3],
    /// The greatest corner.
    pub max: [f32; 3],
    /// Triangles.
    pub triangles: u32,
    /// Model-space surface area, in square units.
    pub area: f32,
    /// Its UV area (texture tiles covered, summed over triangles).
    pub uv_area: f32,
    /// Its triangles as `[x, y, z, u, v]` corners, three a triangle, when it has at most
    /// [`PROXY_TRIANGLES_MAX`]; `None` rasterises its box.
    pub proxy: Option<Arc<[[f32; 5]]>>,
}

impl MeshStats {
    /// The stats of `mesh`.
    pub fn of(mesh: &MeshData) -> MeshStats {
        let corner = |index: u32| mesh.vertices.get(index as usize).map(|v| [v.position[0], v.position[1], v.position[2], v.uv[0], v.uv[1]]);
        let corners: Vec<[f32; 5]> = mesh.indices.as_chunks::<3>().0.iter().filter_map(|tri| Some([corner(tri[0])?, corner(tri[1])?, corner(tri[2])?])).flatten().collect();
        let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
        for v in &mesh.vertices {
            for axis in 0..3 {
                min[axis] = min[axis].min(v.position[axis]);
                max[axis] = max[axis].max(v.position[axis]);
            }
        }
        if mesh.vertices.is_empty() {
            (min, max) = ([0.0; 3], [0.0; 3]);
        }
        let (area, uv_area) = corners.as_chunks::<3>().0.iter().fold((0.0, 0.0), |(area, uv), tri| (area + world_area(tri), uv + uv_triangle_area(tri)));
        let triangles = u32::try_from(corners.len() / 3).unwrap_or(u32::MAX);
        let proxy = (corners.len() / 3 <= PROXY_TRIANGLES_MAX).then(|| Arc::from(corners));
        MeshStats { min, max, triangles, area, uv_area, proxy }
    }

    /// UV tiles per model-space metre, averaged over its surface (0 without UVs).
    fn uv_per_metre(&self) -> f32 {
        if self.area <= 0.0 { 0.0 } else { (self.uv_area / self.area).sqrt() }
    }
}

/// Area of a triangle of `[x, y, z, ..]` corners.
fn world_area(tri: &[[f32; 5]]) -> f32 {
    let p = |i: usize| Vec3::new(tri[i][0], tri[i][1], tri[i][2]);
    (p(1) - p(0)).cross(p(2) - p(0)).length() * 0.5
}

/// UV area of a triangle of `[.., u, v]` corners.
fn uv_triangle_area(tri: &[[f32; 5]]) -> f32 {
    let (a, b, c) = ((tri[0][3], tri[0][4]), (tri[1][3], tri[1][4]), (tri[2][3], tri[2][4]));
    ((b.0 - a.0) * (c.1 - a.1) - (c.0 - a.0) * (b.1 - a.1)).abs() * 0.5
}

/// One mesh draw's facts, as a cell it wins reports them.
#[derive(Clone, Copy, Debug)]
struct DrawFacts {
    tag: Option<usize>,
    flat: bool,
    normal: bool,
    orm: bool,
    card: bool,
    /// Base-colour texels per UV tile and the UV repeats (`Mesh` mapping), or texels per metre
    /// (`World` mapping); `None` untextured.
    texels: Option<Texels>,
    /// Triangles per square metre of its drawn surface.
    triangle_density: f32,
}

#[derive(Clone, Copy, Debug)]
enum Texels {
    /// Texels per UV tile (the texture's side times the material's repeats).
    PerTile(f32),
    /// Texels per world metre (world-projected maps).
    PerMetre(f32),
}

/// What a material says about the look.
fn draw_facts(material: &Material, tag: Option<usize>, triangle_density: f32) -> DrawFacts {
    let side = material.base_texture.map(|texture| texture.class().side() as f32);
    let texels = side.map(|side| match material.uv {
        UvMapping::Mesh { scale } => Texels::PerTile(side * (scale[0] * scale[1]).abs().sqrt()),
        UvMapping::World { tiles_per_metre } => Texels::PerMetre(side * (tiles_per_metre[0] * tiles_per_metre[1]).abs().sqrt()),
    });
    DrawFacts {
        tag,
        flat: material.base_texture.is_none() && material.emissive_texture.is_none() && !material.checker,
        normal: material.normal_texture.is_some(),
        orm: material.metal_rough_texture.is_some() || material.occlusion_texture.is_some(),
        card: material.alpha_cutoff.is_some() || material.double_sided,
        texels,
        triangle_density,
    }
}

/// One cell of the raster: the nearest draw so far, its depth and the UV density there.
#[derive(Clone, Copy, Debug)]
struct Cell {
    draw: u32,
    /// NDC depth (0 at the near plane): the depth test's key.
    depth: f32,
    /// View distance, in world units.
    distance: f32,
    /// UV tiles per world metre of the triangle that won the cell.
    uv_per_metre: f32,
}

const EMPTY: u32 = u32::MAX;

/// The frame's coverage raster: fed every world mesh, it answers [`LookFacts`].
pub struct LookRaster {
    width: u32,
    height: u32,
    view_proj: Mat4,
    eye: Vec3,
    /// Screen pixels per world metre at distance 1 (perspective) or at any distance (orthographic).
    pixels_per_metre: f32,
    orthographic: bool,
    cells: Vec<Cell>,
    draws: Vec<DrawFacts>,
    tags: Vec<(String, u32)>,
    tag: Option<usize>,
    rasterised: usize,
}

/// A triangle's corners in clip space, its UV density and the draw it belongs to.
struct ClipTriangle {
    corners: [Vec4; 3],
    uv_per_metre: f32,
    draw: u32,
}

impl LookRaster {
    /// A raster for a frame drawn from `camera` at `output` pixels.
    pub fn new(camera: &Camera, output: (u32, u32)) -> LookRaster {
        let (out_w, out_h) = (output.0.max(1) as f32, output.1.max(1) as f32);
        let aspect = out_w / out_h;
        let (width, height) = if aspect >= 1.0 { (GRID_LONG_SIDE, ((GRID_LONG_SIDE as f32 / aspect).round() as u32).max(1)) } else { (((GRID_LONG_SIDE as f32 * aspect).round() as u32).max(1), GRID_LONG_SIDE) };
        let view = glam::camera::rh::view::look_at_mat4(camera.position, camera.target, camera.up);
        let orthographic = camera.projection == Projection::Orthographic;
        let (proj, pixels_per_metre) = if orthographic {
            let half_h = camera.fovy.max(1e-3) * 0.5;
            (glam::camera::rh::proj::directx::orthographic(-half_h * aspect, half_h * aspect, -half_h, half_h, NEAR, 1000.0), out_h / (2.0 * half_h))
        } else {
            let tan = libm::tanf(camera.fovy.clamp(1.0, 179.0).to_radians() * 0.5);
            (perspective(tan, aspect), out_h / (2.0 * tan))
        };
        let empty = Cell { draw: EMPTY, depth: f32::MAX, distance: 0.0, uv_per_metre: 0.0 };
        LookRaster {
            width,
            height,
            view_proj: proj * view,
            eye: camera.position,
            pixels_per_metre,
            orthographic,
            cells: vec![empty; (width * height) as usize],
            draws: Vec::new(),
            tags: Vec::new(),
            tag: None,
            rasterised: 0,
        }
    }

    /// The following meshes count under `name` (`frame.tag`); an empty name is untagged.
    pub fn tag(&mut self, name: &str) {
        if name.is_empty() {
            self.tag = None;
            return;
        }
        self.tag = match self.tags.iter().position(|(known, _)| known == name) {
            Some(index) => Some(index),
            None if self.tags.len() < TAGS_MAX => {
                self.tags.push((name.to_owned(), 0));
                Some(self.tags.len() - 1)
            }
            None => None,
        };
    }

    /// One mesh drawn at `model` with `material`; `stats` is its geometry (`None`: unknown, only
    /// counted).
    pub fn mesh(&mut self, stats: Option<&MeshStats>, model: &[f32; 16], material: &Material) {
        if let Some(tag) = self.tag {
            self.tags[tag].1 = self.tags[tag].1.saturating_add(1);
        }
        let Some(stats) = stats else { return };
        let model = Mat4::from_cols_array(model);
        let area_scale = area_scale(&model);
        let drawn_area = stats.area * area_scale;
        let density = if drawn_area > 0.0 { stats.triangles as f32 / drawn_area } else { 0.0 };
        let draw = u32::try_from(self.draws.len()).unwrap_or(EMPTY - 1);
        self.draws.push(draw_facts(material, self.tag, density));
        if !self.on_screen(&model, stats) {
            return;
        }
        match &stats.proxy {
            Some(corners) if self.rasterised + corners.len() / 3 <= RASTER_TRIANGLES_MAX => self.proxy(&model, corners, draw),
            _ if self.rasterised + BOX_TRIANGLES.len() <= RASTER_TRIANGLES_MAX => self.bounding_box(&model, stats, area_scale, draw),
            _ => {}
        }
    }

    /// Whether any of `stats`'s box can be on screen (no corner past one frustum side).
    fn on_screen(&self, model: &Mat4, stats: &MeshStats) -> bool {
        let clip: Vec<Vec4> = box_corners(stats).iter().map(|corner| self.view_proj * (*model * corner.extend(1.0))).collect();
        let outside = |test: &dyn Fn(&Vec4) -> bool| clip.iter().all(test);
        let gone = outside(&|c| c.x > c.w) || outside(&|c| c.x < -c.w) || outside(&|c| c.y > c.w) || outside(&|c| c.y < -c.w) || outside(&|c| c.z < 0.0);
        !gone
    }

    fn proxy(&mut self, model: &Mat4, corners: &[[f32; 5]], draw: u32) {
        for tri in corners.as_chunks::<3>().0 {
            let world: Vec<Vec3> = tri.iter().map(|c| model.transform_point3(Vec3::new(c[0], c[1], c[2]))).collect();
            let area = (world[1] - world[0]).cross(world[2] - world[0]).length() * 0.5;
            let uv_per_metre = if area > 0.0 { (uv_triangle_area(tri) / area).sqrt() } else { 0.0 };
            let corners = [0, 1, 2].map(|i| self.view_proj * world[i].extend(1.0));
            self.triangle(&ClipTriangle { corners, uv_per_metre, draw });
        }
    }

    fn bounding_box(&mut self, model: &Mat4, stats: &MeshStats, area_scale: f32, draw: u32) {
        let corners = box_corners(stats);
        let uv_per_metre = stats.uv_per_metre() / area_scale.sqrt().max(1e-6);
        for [a, b, c] in BOX_TRIANGLES {
            let clip = [a, b, c].map(|i| self.view_proj * (*model * corners[i].extend(1.0)));
            self.triangle(&ClipTriangle { corners: clip, uv_per_metre, draw });
        }
    }

    /// Rasterise one clip-space triangle, clipped at the near plane.
    fn triangle(&mut self, tri: &ClipTriangle) {
        self.rasterised += 1;
        for piece in clip_near(&tri.corners) {
            self.raster(&piece, tri);
        }
    }

    fn raster(&mut self, corners: &[Vec4; 3], tri: &ClipTriangle) {
        let (w, h) = (self.width as f32, self.height as f32);
        let screen = corners.map(|c| {
            let inv = 1.0 / c.w;
            Vec3::new((c.x * inv * 0.5 + 0.5) * w, (0.5 - c.y * inv * 0.5) * h, c.z * inv)
        });
        let inv_w = corners.map(|c| 1.0 / c.w);
        let signed = edge(screen[0], screen[1], screen[2]);
        if signed.abs() < 1e-12 {
            return;
        }
        let min_x = screen.iter().map(|p| p.x).fold(f32::MAX, f32::min).floor().max(0.0) as u32;
        let max_x = (screen.iter().map(|p| p.x).fold(f32::MIN, f32::max).ceil().min(w) as u32).min(self.width);
        let min_y = screen.iter().map(|p| p.y).fold(f32::MAX, f32::min).floor().max(0.0) as u32;
        let max_y = (screen.iter().map(|p| p.y).fold(f32::MIN, f32::max).ceil().min(h) as u32).min(self.height);
        for y in min_y..max_y {
            for x in min_x..max_x {
                let p = Vec3::new(x as f32 + 0.5, y as f32 + 0.5, 0.0);
                let b = [edge(screen[1], screen[2], p) / signed, edge(screen[2], screen[0], p) / signed, edge(screen[0], screen[1], p) / signed];
                if b.iter().any(|weight| *weight < 0.0) {
                    continue;
                }
                let depth = b[0] * screen[0].z + b[1] * screen[1].z + b[2] * screen[2].z;
                let cell = &mut self.cells[(y * self.width + x) as usize];
                if depth >= 0.0 && depth < cell.depth {
                    let inv = b[0] * inv_w[0] + b[1] * inv_w[1] + b[2] * inv_w[2];
                    *cell = Cell { draw: tri.draw, depth, distance: if inv > 0.0 { 1.0 / inv } else { 0.0 }, uv_per_metre: tri.uv_per_metre };
                }
            }
        }
    }

    /// The facts of everything fed so far; `None` when the frame drew no world mesh.
    pub fn facts(&self) -> Option<LookFacts> {
        if self.draws.is_empty() {
            return None;
        }
        let total = self.cells.len() as f64;
        let mut tags: Vec<TagTally> = self.tags.iter().map(|(name, draws)| TagTally::new(name, *draws)).collect();
        let (mut covered, mut flat) = (0u32, 0u32);
        for cell in self.cells.iter().filter(|cell| cell.draw != EMPTY) {
            let facts = &self.draws[cell.draw as usize];
            covered += 1;
            flat += u32::from(facts.flat);
            if let Some(tag) = facts.tag {
                tags[tag].add(facts, cell, self.pixels_at(cell));
            }
        }
        Some(LookFacts {
            grid: [self.width, self.height],
            coverage: f64::from(covered) / total,
            flat_coverage: f64::from(flat) / total,
            tags: tags.into_iter().map(|tally| tally.facts(total)).collect(),
            drawn: None,
        })
    }

    /// Screen pixels per world metre at `cell`.
    fn pixels_at(&self, cell: &Cell) -> f32 {
        if self.orthographic {
            return self.pixels_per_metre;
        }
        if cell.distance > 0.0 { self.pixels_per_metre / cell.distance } else { 0.0 }
    }

    /// The camera's position (tests: what the raster looks from).
    pub fn eye(&self) -> Vec3 {
        self.eye
    }
}

/// A right-handed infinite perspective whose clip z is the view distance less [`NEAR`] (so `z >= 0`
/// is in front of the near plane and the NDC depth grows with distance from 0 there); `tan` is the
/// half field of view's tangent, libm's so every target agrees.
fn perspective(tan: f32, aspect: f32) -> Mat4 {
    let f = 1.0 / tan.max(1e-6);
    Mat4::from_cols(Vec4::new(f / aspect, 0.0, 0.0, 0.0), Vec4::new(0.0, f, 0.0, 0.0), Vec4::new(0.0, 0.0, -1.0, -1.0), Vec4::new(0.0, 0.0, -NEAR, 0.0))
}

/// How much a model matrix scales a surface's area, averaged over the three axis planes.
fn area_scale(model: &Mat4) -> f32 {
    let (x, y, z) = (model.x_axis.truncate().length(), model.y_axis.truncate().length(), model.z_axis.truncate().length());
    (x * y + y * z + z * x) / 3.0
}

fn edge(a: Vec3, b: Vec3, p: Vec3) -> f32 {
    (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
}

/// The eight corners of `stats`'s box, bit `i` of the index choosing max on axis `i`.
fn box_corners(stats: &MeshStats) -> [Vec3; 8] {
    std::array::from_fn(|i| {
        let pick = |axis: usize| if i >> axis & 1 == 1 { stats.max[axis] } else { stats.min[axis] };
        Vec3::new(pick(0), pick(1), pick(2))
    })
}

/// A box's twelve triangles over [`box_corners`].
const BOX_TRIANGLES: [[usize; 3]; 12] =
    [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]];

/// `corners` clipped at the near plane (`z >= 0`): none, one or two triangles.
fn clip_near(corners: &[Vec4; 3]) -> Vec<[Vec4; 3]> {
    let inside: Vec<bool> = corners.iter().map(|c| c.z >= 0.0 && c.w > 0.0).collect();
    if inside.iter().all(|&kept| kept) {
        return vec![*corners];
    }
    let mut polygon = Vec::with_capacity(4);
    for i in 0..3 {
        let (a, b) = (corners[i], corners[(i + 1) % 3]);
        if inside[i] {
            polygon.push(a);
        }
        if inside[i] != inside[(i + 1) % 3] {
            let t = a.z / (a.z - b.z);
            polygon.push(a + (b - a) * t);
        }
    }
    let usable = |c: &Vec4| c.w > 1e-6;
    match polygon.as_slice() {
        [a, b, c] if [a, b, c].into_iter().all(usable) => vec![[*a, *b, *c]],
        [a, b, c, d] if [a, b, c, d].into_iter().all(usable) => vec![[*a, *b, *c], [*a, *c, *d]],
        _ => Vec::new(),
    }
}

/// One tag's cells as the raster counts them.
struct TagTally {
    name: String,
    draws: u32,
    cells: u32,
    flat: u32,
    normal: u32,
    orm: u32,
    card: u32,
    texels: Vec<f32>,
    pixels: Vec<f32>,
    triangle_density: f64,
}

impl TagTally {
    fn new(name: &str, draws: u32) -> TagTally {
        TagTally { name: name.to_owned(), draws, cells: 0, flat: 0, normal: 0, orm: 0, card: 0, texels: Vec::new(), pixels: Vec::new(), triangle_density: 0.0 }
    }

    fn add(&mut self, facts: &DrawFacts, cell: &Cell, pixels: f32) {
        self.cells += 1;
        self.flat += u32::from(facts.flat);
        self.normal += u32::from(facts.normal);
        self.orm += u32::from(facts.orm);
        self.card += u32::from(facts.card);
        match facts.texels {
            Some(Texels::PerTile(per_tile)) => self.texels.push(per_tile * cell.uv_per_metre),
            Some(Texels::PerMetre(per_metre)) => self.texels.push(per_metre),
            None => {}
        }
        self.pixels.push(pixels);
        self.triangle_density += f64::from(facts.triangle_density);
    }

    fn facts(mut self, total: f64) -> TagFacts {
        let seen = self.cells > 0;
        let share = |count: u32| if seen { f64::from(count) / f64::from(self.cells) } else { 0.0 };
        TagFacts {
            name: std::mem::take(&mut self.name),
            coverage: f64::from(self.cells) / total,
            flat_coverage: f64::from(self.flat) / total,
            texels_per_metre: median(&mut self.texels),
            pixels_per_metre: median(&mut self.pixels),
            triangles_per_square_metre: seen.then(|| self.triangle_density / f64::from(self.cells)),
            normal_map_share: share(self.normal),
            orm_share: share(self.orm),
            alpha_card_share: share(self.card),
            draws: self.draws,
            models: Vec::new(),
            primitive_only: true,
        }
    }
}

fn median(values: &mut [f32]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    Some(f64::from(values[values.len() / 2]))
}

/// One tag's facts (`__render.look.tags[tag]`; `LookTagFacts` in the contract).
#[derive(Clone, Debug, PartialEq)]
pub struct TagFacts {
    /// The tag (`frame.tag(name)`).
    pub name: String,
    /// Share of the screen where it is the nearest surface.
    pub coverage: f64,
    /// Share of the screen where it is nearest with a flat material.
    pub flat_coverage: f64,
    /// Median base-colour texels per world metre over its visible cells (None: untextured).
    pub texels_per_metre: Option<f64>,
    /// Median screen pixels per world metre at its visible cells (None: unseen).
    pub pixels_per_metre: Option<f64>,
    /// Coverage-weighted mean triangles per square metre of drawn surface (None: unseen).
    pub triangles_per_square_metre: Option<f64>,
    /// Share of its visible cells with a normal map.
    pub normal_map_share: f64,
    /// Share of its visible cells with an ORM or metal-rough map.
    pub orm_share: f64,
    /// Share of its visible cells with an alpha-cut or double-sided card material.
    pub alpha_card_share: f64,
    /// Meshes it handed the renderer, seen or not.
    pub draws: u32,
    /// The model paths drawn under the tag (as the game named them to `gfx.assets().model`), in
    /// first-draw order, at most [`MODELS_PER_TAG_MAX`]: the harness follows them to their lock rows.
    pub models: Vec<String>,
    /// Every draw under the tag is an engine primitive (a cube, a sphere, a group of them): no
    /// imported or built model.
    pub primitive_only: bool,
}

impl LookFacts {
    /// Note that tag `tag` drew model `path` (`None`: a primitive); a tag the raster never saw is
    /// left out.
    pub fn note_shape(&mut self, tag: &str, path: Option<Option<&str>>) {
        let Some(facts) = self.tags.iter_mut().find(|facts| facts.name == tag) else { return };
        let Some(model) = path else { return };
        facts.primitive_only = false;
        let fresh = model.is_some_and(|path| !facts.models.iter().any(|known| known == path));
        if let Some(path) = model.filter(|_| fresh && facts.models.len() < MODELS_PER_TAG_MAX) {
            facts.models.push(path.to_owned());
        }
    }
}

/// The frame's look facts (`__render.look`; `RenderLookFacts` in the contract).
#[derive(Clone, Debug, PartialEq)]
pub struct LookFacts {
    /// The raster's cells across and down.
    pub grid: [u32; 2],
    /// Share of the screen any world draw covers.
    pub coverage: f64,
    /// Share of the screen covered by flat materials, tagged or not.
    pub flat_coverage: f64,
    /// Per tag, in first-draw order.
    pub tags: Vec<TagFacts>,
    /// The preset and look features the frame drew (`preset`, `features`); None from a raster
    /// alone, before the presenter adds them.
    pub drawn: Option<DrawnLook>,
}

/// The preset a frame drew and each look feature, on or off (`__render.look.preset` and
/// `features`): what the harness compares between rounds so a round never removes a feature to
/// get a check through.
#[derive(Clone, Debug, PartialEq)]
pub struct DrawnLook {
    /// The preset's wire spelling (a capture's pinned one, else Live's).
    pub preset: &'static str,
    /// Every look feature's wire spelling and whether the frame drew it, in the contract's order.
    pub features: Vec<(&'static str, bool)>,
}

fn rounded(value: f64, scale: f64) -> CoreValue {
    CoreValue::from((value * scale).round() / scale)
}

fn density(value: Option<f64>) -> CoreValue {
    value.map_or(CoreValue::Null, |value| rounded(value, DENSITY_SCALE))
}

impl LookFacts {
    /// `__render.look` as `state()` writes it.
    pub fn to_value(&self) -> CoreValue {
        let mut tags = CoreValue::object();
        for tag in &self.tags {
            let mut entry = CoreValue::object();
            entry.set("coverage", rounded(tag.coverage, SHARE_SCALE));
            entry.set("flatCoverage", rounded(tag.flat_coverage, SHARE_SCALE));
            entry.set("texelsPerMetre", density(tag.texels_per_metre));
            entry.set("pixelsPerMetre", density(tag.pixels_per_metre));
            entry.set("trianglesPerSquareMetre", density(tag.triangles_per_square_metre));
            entry.set("normalMapShare", rounded(tag.normal_map_share, SHARE_SCALE));
            entry.set("ormShare", rounded(tag.orm_share, SHARE_SCALE));
            entry.set("alphaCardShare", rounded(tag.alpha_card_share, SHARE_SCALE));
            entry.set("draws", CoreValue::from(tag.draws));
            entry.set("models", CoreValue::Array(tag.models.iter().map(|path| CoreValue::from(path.as_str())).collect()));
            entry.set("primitiveOnly", CoreValue::Bool(tag.primitive_only));
            tags.set(tag.name.as_str(), entry);
        }
        let mut look = CoreValue::object();
        look.set("version", CoreValue::from(LOOK_FACTS_VERSION));
        look.set("grid", CoreValue::Array(vec![CoreValue::from(self.grid[0]), CoreValue::from(self.grid[1])]));
        look.set("coverage", rounded(self.coverage, SHARE_SCALE));
        look.set("flatCoverage", rounded(self.flat_coverage, SHARE_SCALE));
        if let Some(drawn) = &self.drawn {
            look.set("preset", CoreValue::from(drawn.preset));
            let mut features = CoreValue::object();
            for (feature, on) in &drawn.features {
                features.set(*feature, CoreValue::Bool(*on));
            }
            look.set("features", features);
        }
        look.set("tags", tags);
        look
    }
}

/// `__render.exposure` as `state()` writes it (`ExposureTelemetry` in the contract).
pub fn exposure_value(telemetry: &genex_render::post::exposure::ExposureTelemetry) -> CoreValue {
    let ev = |value: f32| rounded(f64::from(value), EV_SCALE);
    let optional = |value: Option<f32>| value.map_or(CoreValue::Null, ev);
    let mut exposure = CoreValue::object();
    exposure.set("version", CoreValue::from(LOOK_FACTS_VERSION));
    exposure.set("mode", CoreValue::from(if telemetry.auto { "auto" } else { "manual" }));
    exposure.set("meteredEv", optional(telemetry.metered_ev));
    exposure.set("targetEv", optional(telemetry.target_ev));
    exposure.set("appliedEv", ev(telemetry.applied_ev));
    exposure.set("compensation", ev(telemetry.compensation));
    exposure.set("evMin", ev(telemetry.ev_min));
    exposure.set("evMax", ev(telemetry.ev_max));
    exposure.set("histogram", CoreValue::Array(telemetry.histogram.iter().map(|share| rounded(f64::from(*share), SHARE_SCALE)).collect()));
    exposure.set("histogramEv", CoreValue::Array(vec![ev(telemetry.ev_min), ev(telemetry.ev_max)]));
    exposure.set("doorwayBoost", CoreValue::Bool(telemetry.doorway_boost));
    exposure.set("ageFrames", CoreValue::from(telemetry.age_frames as f64));
    exposure.set("warnings", CoreValue::Array(telemetry.warnings.iter().map(|warning| CoreValue::from(warning.wire())).collect()));
    exposure
}

/// How much simulated time `__render.exposureTrace` keeps, in seconds.
pub const EXPOSURE_TRACE_SECONDS: f64 = 10.0;

/// One read-back in the exposure trace.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TracePoint {
    /// Simulated seconds of the frame it describes.
    pub t: f64,
    /// The EV the frame was drawn at.
    pub applied_ev: f32,
    /// The EV metered (None before a metered frame).
    pub metered_ev: Option<f32>,
}

/// `__render.exposureTrace` (AAA review WP-5): the exposure of each Live read-back over the last
/// [`EXPOSURE_TRACE_SECONDS`] of simulated time, so a doorway demo's end state carries the
/// transition it walked through.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExposureTrace {
    points: std::collections::VecDeque<TracePoint>,
    last_reading: Option<u64>,
}

impl ExposureTrace {
    /// Note a Live frame at simulated second `t`: a new reading in `telemetry` adds a point, and
    /// points older than the window go.
    pub fn note(&mut self, t: f64, telemetry: &genex_render::post::exposure::ExposureTelemetry) {
        let Some(reading) = telemetry.reading.filter(|reading| self.last_reading != Some(*reading)) else { return };
        self.last_reading = Some(reading);
        if self.points.back().is_some_and(|last| last.t > t) {
            self.points.clear();
        }
        self.points.push_back(TracePoint { t, applied_ev: telemetry.applied_ev, metered_ev: telemetry.metered_ev });
        while self.points.front().is_some_and(|first| t - first.t > EXPOSURE_TRACE_SECONDS) {
            self.points.pop_front();
        }
    }

    /// The points, oldest first.
    pub fn points(&self) -> impl Iterator<Item = &TracePoint> {
        self.points.iter()
    }

    /// `__render.exposureTrace` as `state()` writes it; `None` while it is empty.
    pub fn to_value(&self) -> Option<CoreValue> {
        if self.points.is_empty() {
            return None;
        }
        let ev = |value: f32| rounded(f64::from(value), EV_SCALE);
        let points = self.points.iter().map(|point| {
            let mut entry = CoreValue::object();
            entry.set("t", rounded(point.t, EV_SCALE));
            entry.set("appliedEv", ev(point.applied_ev));
            entry.set("meteredEv", point.metered_ev.map_or(CoreValue::Null, ev));
            entry
        });
        Some(CoreValue::Array(points.collect()))
    }
}

/// The geometry of every mesh a frame can draw: the built-in cube and sphere and each loaded
/// model's parts, by mesh id.
#[derive(Clone, Debug, Default)]
pub struct MeshIndex {
    meshes: BTreeMap<MeshId, Arc<MeshStats>>,
}

impl MeshIndex {
    /// An index holding the built-in cube and sphere.
    pub fn with_builtins() -> MeshIndex {
        let mut index = MeshIndex::default();
        index.insert(MeshId::CUBE, Arc::new(MeshStats::of(&MeshData::cube())));
        index.insert(MeshId::SPHERE, Arc::new(MeshStats::of(&MeshData::sphere())));
        index
    }

    /// Note `mesh`'s stats.
    pub fn insert(&mut self, mesh: MeshId, stats: Arc<MeshStats>) {
        self.meshes.insert(mesh, stats);
    }

    /// `mesh`'s stats, when known.
    pub fn get(&self, mesh: MeshId) -> Option<&MeshStats> {
        self.meshes.get(&mesh).map(Arc::as_ref)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_render::settings::TextureClass;
    use genex_render::texture::{TextureId, TextureKind};

    const OUTPUT: (u32, u32) = (1920, 1080);

    fn camera() -> Camera {
        Camera { fovy: 60.0, ..Camera::look_at(Vec3::new(0.0, 1.5, 5.0), Vec3::new(0.0, 1.5, 0.0)) }
    }

    fn cube_at(center: Vec3, size: Vec3) -> [f32; 16] {
        Mat4::from_scale_rotation_translation(size, glam::Quat::IDENTITY, center).to_cols_array()
    }

    fn textured(side: TextureClass) -> Material {
        Material { base_texture: Some(TextureId::in_class(TextureKind::Color, side, 0)), ..Material::color([255; 4]) }
    }

    fn tag<'a>(facts: &'a LookFacts, name: &str) -> &'a TagFacts {
        facts.tags.iter().find(|tag| tag.name == name).expect("tag")
    }

    #[test]
    fn a_wall_filling_the_view_is_one_tag_s_whole_coverage_and_its_flat_share() {
        let index = MeshIndex::with_builtins();
        let mut raster = LookRaster::new(&camera(), OUTPUT);
        raster.tag("walls");
        raster.mesh(index.get(MeshId::CUBE), &cube_at(Vec3::new(0.0, 1.5, 0.0), Vec3::new(40.0, 40.0, 0.2)), &Material::color([200; 4]));
        let facts = raster.facts().expect("drew");
        assert_eq!(facts.grid, [160, 90]);
        assert_eq!(facts.coverage, 1.0);
        assert_eq!(facts.flat_coverage, 1.0, "a coloured box is flat");
        let walls = tag(&facts, "walls");
        assert_eq!((walls.coverage, walls.flat_coverage, walls.draws), (1.0, 1.0, 1));
        assert_eq!(walls.texels_per_metre, None, "untextured");
        // 5 m away at 60 degrees on 1080 rows: 1080 / (2 * 4.9 * tan 30) = 190.9 px/m.
        let pixels = walls.pixels_per_metre.expect("seen");
        assert!((pixels - 190.9).abs() < 2.0, "{pixels}");
    }

    #[test]
    fn a_nearer_textured_box_hides_the_flat_wall_behind_it() {
        let index = MeshIndex::with_builtins();
        let mut raster = LookRaster::new(&camera(), OUTPUT);
        raster.tag("walls");
        raster.mesh(index.get(MeshId::CUBE), &cube_at(Vec3::ZERO, Vec3::new(40.0, 40.0, 0.2)), &Material::color([200; 4]));
        raster.tag("crate");
        // A 1 m crate 3 m from the camera, drawn after the wall: the depth test, not order, decides.
        raster.mesh(index.get(MeshId::CUBE), &cube_at(Vec3::new(0.0, 1.5, 2.0), Vec3::ONE), &textured(TextureClass::S1024));
        let facts = raster.facts().expect("drew");
        let (walls, crate_) = (tag(&facts, "walls"), tag(&facts, "crate"));
        assert!(crate_.coverage > 0.05 && crate_.coverage < 0.3, "{}", crate_.coverage);
        assert_eq!(crate_.flat_coverage, 0.0);
        assert!((walls.coverage + crate_.coverage - 1.0).abs() < 1e-9, "the crate's cells are taken from the wall");
        assert!((facts.flat_coverage - walls.coverage).abs() < 1e-9);
        // A 1024 map over a 1 m face: 1024 texels a metre.
        let texels = crate_.texels_per_metre.expect("textured");
        assert!((texels - 1024.0).abs() < 1.0, "{texels}");
        assert_eq!(crate_.triangles_per_square_metre, Some(2.0), "12 triangles over 6 m2");
    }

    #[test]
    fn world_projected_maps_and_card_and_normal_maps_are_reported_per_tag() {
        let index = MeshIndex::with_builtins();
        let mut raster = LookRaster::new(&camera(), OUTPUT);
        raster.tag("floor");
        let world = Material { uv: UvMapping::World { tiles_per_metre: [0.5, 0.5] }, normal_texture: Some(TextureId::in_class(TextureKind::Normal, TextureClass::S2048, 0)), ..textured(TextureClass::S2048) };
        raster.mesh(index.get(MeshId::CUBE), &cube_at(Vec3::new(0.0, -0.1, 0.0), Vec3::new(30.0, 0.2, 30.0)), &world);
        raster.tag("birch");
        let leaf = Material { alpha_cutoff: Some(0.5), double_sided: true, ..textured(TextureClass::S512) };
        raster.mesh(index.get(MeshId::SPHERE), &cube_at(Vec3::new(1.0, 1.0, 1.0), Vec3::splat(0.5)), &leaf);
        let facts = raster.facts().expect("drew");
        let floor = tag(&facts, "floor");
        assert_eq!(floor.texels_per_metre, Some(1024.0), "a 2048 map every 2 m");
        assert_eq!((floor.normal_map_share, floor.orm_share, floor.alpha_card_share), (1.0, 0.0, 0.0));
        let birch = tag(&facts, "birch");
        assert_eq!(birch.alpha_card_share, 1.0);
        assert!(birch.coverage > 0.0);
    }

    #[test]
    fn behind_the_camera_and_unknown_meshes_count_as_draws_but_cover_nothing() {
        let index = MeshIndex::with_builtins();
        let mut raster = LookRaster::new(&camera(), OUTPUT);
        raster.tag("props");
        raster.mesh(index.get(MeshId::CUBE), &cube_at(Vec3::new(0.0, 1.5, 20.0), Vec3::ONE), &Material::color([1; 4]));
        raster.mesh(None, &cube_at(Vec3::ZERO, Vec3::ONE), &Material::color([1; 4]));
        let facts = raster.facts().expect("drew");
        let props = tag(&facts, "props");
        assert_eq!((props.draws, props.coverage, props.pixels_per_metre, props.triangles_per_square_metre), (2, 0.0, None, None));
        assert_eq!(facts.coverage, 0.0);
        assert_eq!(LookRaster::new(&camera(), OUTPUT).facts(), None, "no world draw, no facts");
    }

    #[test]
    fn a_box_reaching_behind_the_near_plane_is_clipped_not_dropped() {
        let index = MeshIndex::with_builtins();
        let mut raster = LookRaster::new(&camera(), OUTPUT);
        raster.tag("corridor");
        // A floor slab running from behind the camera to 20 m in front of it.
        raster.mesh(index.get(MeshId::CUBE), &cube_at(Vec3::new(0.0, 0.0, -5.0), Vec3::new(4.0, 0.2, 30.0)), &Material::color([9; 4]));
        // The slab's near part exists only if the triangles crossing the near plane were clipped:
        // the bottom row's middle cell is covered, and nothing above the horizon is.
        let bottom_centre = raster.cells[((raster.height - 1) * raster.width + raster.width / 2) as usize];
        assert_ne!(bottom_centre.draw, EMPTY, "the near floor under the camera is drawn");
        let corridor = tag(&raster.facts().expect("drew"), "corridor").clone();
        assert!(corridor.coverage > 0.15 && corridor.coverage < 0.5, "the lower half, narrowing: {}", corridor.coverage);
    }

    #[test]
    fn the_exposure_trace_keeps_one_point_a_reading_for_ten_seconds() {
        let reading = |frame: u64, applied_ev: f32| genex_render::post::exposure::ExposureTelemetry {
            auto: true,
            metered_ev: Some(applied_ev),
            target_ev: Some(applied_ev),
            applied_ev,
            compensation: 0.0,
            ev_min: -8.0,
            ev_max: 8.0,
            histogram: Vec::new(),
            doorway_boost: false,
            age_frames: 0,
            reading: Some(frame),
            warnings: Vec::new(),
        };
        let mut trace = ExposureTrace::default();
        assert_eq!(trace.to_value(), None);
        for frame in 0..1000u64 {
            // A read-back every seventh frame, seen on each frame until the next.
            trace.note(frame as f64 / 60.0, &reading(frame / 7 * 7, frame as f32));
        }
        let points: Vec<&TracePoint> = trace.points().collect();
        // The last reading at frame 994 keeps the ones from frame 399 on (ten seconds back is 394).
        assert_eq!(points.len(), 86, "one a reading over ten seconds");
        assert!(points.windows(2).all(|pair| pair[1].t > pair[0].t));
        trace.note(0.5, &reading(2000, 0.0));
        assert_eq!(trace.points().count(), 1, "a reset clock starts the trace over");
        let manual = genex_render::post::exposure::ExposureTelemetry { reading: None, ..reading(0, 0.0) };
        trace.note(0.6, &manual);
        assert_eq!(trace.points().count(), 1, "no reading, no point");
    }

    #[test]
    fn a_tag_lists_its_models_once_and_is_primitive_only_without_any() {
        let index = MeshIndex::with_builtins();
        let mut raster = LookRaster::new(&camera(), OUTPUT);
        for name in ["bench", "tree"] {
            raster.tag(name);
            raster.mesh(index.get(MeshId::CUBE), &cube_at(Vec3::new(0.0, 1.5, 0.0), Vec3::ONE), &Material::color([1; 4]));
        }
        let mut facts = raster.facts().expect("drew");
        facts.note_shape("bench", None);
        facts.note_shape("tree", Some(Some("models/birch.glb")));
        facts.note_shape("tree", Some(Some("models/birch.glb")));
        facts.note_shape("tree", Some(None));
        facts.note_shape("unseen", Some(Some("x.glb")));
        assert_eq!((tag(&facts, "bench").primitive_only, tag(&facts, "bench").models.len()), (true, 0));
        assert_eq!((tag(&facts, "tree").primitive_only, tag(&facts, "tree").models.clone()), (false, vec!["models/birch.glb".to_owned()]));
    }
}
