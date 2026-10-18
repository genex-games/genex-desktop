//! The draw hook: the terrain (a Level-2 material blending four PBR layers), the woods (branching
//! trees, three levels of detail by distance), the rocks, the cabin, the dock and its boat, the
//! lanterns, the fireflies and the animals, through the facade's models (the renderer's PBR,
//! shadows, AO and GPU culling). Surfaces are physically based: photo-scanned CC0 textures where
//! the asset cache holds them (`assets/fetched/`), each with an untextured colour that stands in
//! where it does not. The lanterns and the cabin's windows are real lights: emissive glass and
//! panes (which the look's bloom spreads), a flickering point light in each lantern and a spot
//! light shining out of each window onto the porch and the yard; the fireflies are emissive too.
//! The lake is the renderer's water (renderer pass 2 B.3, `frame.water`). Every animation derives
//! from the world's tick, never a clock.

use genex::math::{self, FRAC_PI_2, Quat, Vec3, vec3};
use genex::prelude::*;
use genex::render::{ReflectionProbe, SpotLight, Water};
use genex::{Assets, InstanceGroup, Model, Scatter, Subsurface, Terrain};

use crate::layout::{
    CABIN, CABIN_FLOOR, CABIN_YAW, DOCK_DECK, DOCK_LENGTH, Dock, LAKE_CENTER, LAKE_RADII, Rock, Tree, TreeKind, TreeLod, WATER_LEVEL, height, layout, mix,
    smoothstep,
};
use crate::world::{TreeMeshes, World};

/// The colour the world target clears to: what shows behind the scene where the device's quality
/// draws no sky (the legacy LDR scene).
pub const HORIZON: Color = Color::rgb(222, 168, 128);
/// The low sun (towards [`crate::layout::SUN_DIR`]): its colour and intensity (relative units; the
/// facade's default sun is white at 2.5). White: under the physical sky this is the light outside
/// the atmosphere, which reddens it on its way to the ground as it reddens the sky.
const SUN_COLOR: Color = Color::rgb(255, 255, 255);
const SUN_INTENSITY: f32 = 3.6;
/// The dusk sky's fill light on what the sun does not reach, where the device's quality turns
/// image-based lighting off (with it on, the environment replaces it).
const AMBIENT_COLOR: Color = Color::rgb(196, 184, 222);
const AMBIENT_INTENSITY: f32 = 0.16;

/// Foliage colours (sRGB): pine needles, summer leaves and the turning ones.
const PINES: [Color; 3] = [Color::rgb(34, 58, 30), Color::rgb(40, 66, 32), Color::rgb(48, 72, 34)];
const LEAVES: [Color; 3] = [Color::rgb(70, 98, 34), Color::rgb(86, 110, 38), Color::rgb(104, 118, 40)];
const GOLDEN: [Color; 3] = [Color::rgb(190, 128, 40), Color::rgb(176, 92, 34), Color::rgb(204, 156, 54)];
/// Leaves are thin and only faintly waxy: a soft sheen, never a glint. A far leaf is smaller than a
/// pixel, where nothing filters its highlight but TAA; at 0.62 the low sun's glints blew out to
/// white sparkles on every preset without TAA (pass-1 gate findings 04 and 08).
const LEAF_ROUGHNESS: f32 = 0.85;

/// The scatter's terrain layers (`layout::TERRAIN_LAYERS` order): the soil and the sand.
const SOIL_LAYER: u8 = 2;
const SAND_LAYER: u8 = 3;
/// Pebbles a square metre of beach and stones a square metre of path, and the most of each.
const PEBBLE_DENSITY: f32 = 0.5;
const PEBBLES_MAX: usize = 360;
const STONE_DENSITY: f32 = 0.12;
const STONES_MAX: usize = 150;

/// The room's waxed floor: the planks' roughness times this, so the hearth and the doorway's
/// sunlight sheen on it through the room's reflection probe.
const FLOOR_ROUGHNESS: f32 = 0.62;

/// The untextured stand-ins of the fetched textures (sRGB), and how rough each surface is.
const BARK: Color = Color::rgb(84, 64, 48);
const PINE_BARK: Color = Color::rgb(92, 64, 46);
const ROCK: Color = Color::rgb(118, 116, 106);
const PLANK: Color = Color::rgb(112, 84, 58);
const LOG: Color = Color::rgb(140, 100, 66);
const SLATE: Color = Color::rgb(78, 76, 76);
const STONE: Color = Color::rgb(124, 116, 106);
/// Painted and worn surfaces of the cabin: the window trim, the door and the ridge.
const TRIM: Color = Color::rgb(206, 194, 170);
const DOOR_TINT: Color = Color::rgb(150, 110, 80);
const IRON: Color = Color::rgb(36, 34, 32);
const GLASS: Color = Color::rgb(255, 222, 150);
/// How bright a lantern's glass glows (scene units, like a light's intensity: well past white, so the
/// look's bloom haloes it).
const GLASS_GLOW: f32 = 3.2;
/// A lantern's flame as a point light: its colour, intensity and reach.
const LANTERN_LIGHT: Color = Color::rgb(255, 170, 92);
const LANTERN_INTENSITY: f32 = 2.6;
const LANTERN_RANGE: f32 = 4.5;
/// The lamplight behind the cabin's windows: the panes' glow and the spot shining out of each.
const WINDOW_LAMP: Color = Color::rgb(255, 196, 132);
const WINDOW_GLOW: f32 = 1.5;
const WINDOW_MULLION: Color = Color::rgb(24, 16, 10);
const WINDOW_LIGHT_INTENSITY: f32 = 3.0;
const WINDOW_LIGHT_RANGE: f32 = 7.0;
/// The window spots' cone (half-angles in degrees) and how far they tilt down towards the porch.
const WINDOW_CONE_DEGREES: (f32, f32) = (25.0, 50.0);
const WINDOW_LIGHT_DIP: f32 = 0.45;
/// A firefly's glow (scene units) at the peak of its blink, its colour and its size.
const FIREFLY_GLOW: f32 = 14.0;
const FIREFLY: Color = Color::rgb(196, 255, 92);
const FIREFLY_RADIUS: f32 = 0.022;
/// The least radius (pixels, at the world's reference height) a firefly's body is drawn with: a
/// far one grows to it and dims by the area it gained, so its light is kept (renderer pass 2, B.7:
/// a body smaller than a pixel was a bright point the jitter hit in some frames only, and each hit
/// popped for one frame on the Lakeside's orbits and dollies).
const FIREFLY_LEAST_RADIUS_PX: f32 = 1.0;
const HULL_TINT: Color = Color::rgb(108, 60, 40);
const JACKET: Color = Color::rgb(64, 94, 146);
const TROUSERS: Color = Color::rgb(72, 68, 62);
const SKIN: Color = Color::rgb(226, 182, 142);
const STRAW: Color = Color::rgb(204, 172, 108);
/// The fisher's line: clear nylon, lit by the scene (a pale thread in the sun, dark at night).
const LINE: Color = Color::rgb(168, 170, 162);
/// The line's radius, m, and the least radius (pixels, at the world's reference height) it is drawn
/// with, as the fireflies' bodies: a thread finer than a pixel breaks into dashes under the jitter
/// and while the camera moves (D22: half a reference pixel, a quarter's line was dashed in 1440p
/// pans at scale 1); a pixel wide at the reference height, a render pixel or more at 1440p and 4K
/// from scale 0.67, it is whole in every frame and TAA resolves it into a smooth line.
const LINE_RADIUS: f32 = 0.0008;
const LINE_LEAST_RADIUS_PX: f32 = 0.5;
/// The most a segment may grow to keep that least radius: farther away the eye sees no line (it
/// would be a rope a pixel wide), so the segment is not drawn. Twice the quarter-pixel line's 12,
/// so the line reaches as far over the lake as it did.
const LINE_GROW_MAX: f32 = 24.0;
/// How far the line sags under the straight run from the rod's tip to the bobber at its middle, m,
/// and the segments it hangs in.
const LINE_SAG: f32 = 0.1;
const LINE_SEGMENTS: u32 = 8;
const BOBBER: Color = Color::rgb(220, 46, 40);
const DEER: Color = Color::rgb(126, 86, 56);
/// The deer's neck swing about x: down to the grass, and up to look around (radians).
const DEER_GRAZING: f32 = 1.05;
const DEER_LOOKING: f32 = -0.75;
const DUCK_BODY: [Color; 2] = [Color::rgb(150, 132, 112), Color::rgb(132, 96, 62)];
const DUCK_HEAD: [Color; 2] = [Color::rgb(38, 98, 62), Color::rgb(124, 90, 60)];
const BEAK: Color = Color::rgb(232, 172, 42);

/// The cabin's width (x).
pub const CABIN_WIDTH: f32 = 6.4;
/// The cabin's depth (z).
pub const CABIN_DEPTH: f32 = 5.2;
/// The log walls' height.
pub const WALL_HEIGHT: f32 = 2.72;
/// A wall log's radius.
pub const LOG_RADIUS: f32 = 0.17;
/// The ridge's height above the walls.
pub const RIDGE_RISE: f32 = 1.7;
/// How far the roof overhangs the walls.
pub const EAVE: f32 = 0.75;
/// The chimney stack's height, and how far its foot sits below the cabin's floor.
pub const CHIMNEY_HEIGHT: f32 = 4.8 + RIDGE_RISE * 0.6;
const CHIMNEY_FOOT: f32 = -0.51;

/// A wall log along the front and back (`props.rs` writes every part mesh).
pub const LOG_LONG: &str = "part-log-long.glb";
/// A front wall log beside the doorway: from a corner to the door's jamb.
pub const LOG_JAMB: &str = "part-log-jamb.glb";
/// The cabin room's plank floor.
pub const FLOOR: &str = "part-floor.glb";
/// The doorway's half width: the door's own and a finger of play.
pub const DOOR_HALF_WIDTH: f32 = 0.55;
/// The doorway's height: the door's own.
pub const DOOR_HEIGHT: f32 = 2.0;
/// A wall log along the sides (squeezed for the gables).
pub const LOG_SHORT: &str = "part-log-short.glb";
/// A log of the woodpile.
pub const LOG_FIREWOOD: &str = "part-log-firewood.glb";
/// A post: unit cylinder, its grain mapped for about three metres.
pub const POST: &str = "part-post.glb";
/// One of the dock's two beams.
pub const BEAM: &str = "part-beam.glb";
/// The porch's deck.
pub const PORCH: &str = "part-porch.glb";
/// The porch's step.
pub const STEP: &str = "part-step.glb";
/// The porch bench's seat.
pub const BENCH: &str = "part-bench.glb";
/// The cabin's door.
pub const DOOR: &str = "part-door.glb";
/// One roof panel.
pub const ROOF: &str = "part-roof.glb";
/// The stone footing.
pub const FOOTING: &str = "part-footing.glb";
/// The stone chimney.
pub const CHIMNEY: &str = "part-chimney.glb";
/// The rowboat's hull.
pub const HULL: &str = "part-hull.glb";
/// The lake's surface in the rowboat's own frame at rest (the hull's y): an empty boat drawing
/// 12 cm, so the water stays under its bottom boards (`props::HULL_FLOOR`) as it bobs and rolls
/// by [`BOAT_BOB`] and [`BOAT_ROLL`].
pub const BOAT_WATERLINE: f32 = -0.18;
/// How far the rowboat bobs up and down, in metres.
pub const BOAT_BOB: f32 = 0.03;
/// How far the rowboat rolls either way, in radians.
pub const BOAT_ROLL: f32 = 0.03;
/// A deer's body and its neck and head (which swing between grazing and looking up).
pub const DEER_BODY: &str = "part-deer-body.glb";
/// A deer's neck and head, from the base of the neck along +z.
pub const DEER_HEAD: &str = "part-deer-head.glb";
/// The fisher's jacket (torso and arms) and trousers, in his frame.
pub const FISHER_JACKET: &str = "part-fisher-jacket.glb";
/// The fisher's trousers.
pub const FISHER_TROUSERS: &str = "part-fisher-trousers.glb";
/// The dock's planks: three cut from different boards of the texture.
pub const PLANKS: [&str; 3] = ["part-plank-0.glb", "part-plank-1.glb", "part-plank-2.glb"];

/// The roof's run from the ridge to the eave and its drop (a panel's length down the slope is
/// their hypotenuse).
pub fn roof_run_drop() -> (f32, f32) {
    (CABIN_DEPTH * 0.5 + EAVE, RIDGE_RISE + 0.12)
}

/// The part models.
#[derive(Clone, Debug, Default)]
pub struct Parts {
    log_long: Model,
    log_jamb: Model,
    /// The room's plank floor ([`FLOOR`]).
    pub(crate) floor: Model,
    log_short: Model,
    firewood: Model,
    post: Model,
    beam: Model,
    porch: Model,
    step: Model,
    bench: Model,
    door: Model,
    /// One roof panel ([`ROOF`]): the room's ceiling boards are drawn with it too.
    pub(crate) roof: Model,
    footing: Model,
    chimney: Model,
    planks: Vec<Model>,
    hull: Model,
    deer_body: Model,
    deer_head: Model,
    jacket: Model,
    trousers: Model,
}

impl Parts {
    /// Every part's handle.
    pub fn load(assets: &Assets) -> Parts {
        Parts {
            log_long: assets.model(LOG_LONG),
            log_jamb: assets.model(LOG_JAMB),
            floor: assets.model(FLOOR),
            log_short: assets.model(LOG_SHORT),
            firewood: assets.model(LOG_FIREWOOD),
            post: assets.model(POST),
            beam: assets.model(BEAM),
            porch: assets.model(PORCH),
            step: assets.model(STEP),
            bench: assets.model(BENCH),
            door: assets.model(DOOR),
            roof: assets.model(ROOF),
            footing: assets.model(FOOTING),
            chimney: assets.model(CHIMNEY),
            planks: PLANKS.iter().map(|name| assets.model(name)).collect(),
            hull: assets.model(HULL),
            deer_body: assets.model(DEER_BODY),
            deer_head: assets.model(DEER_HEAD),
            jacket: assets.model(FISHER_JACKET),
            trousers: assets.model(FISHER_TROUSERS),
        }
    }
}

/// A textured PBR surface from the fetched maps `fetched/<name>-{albedo,normal,orm}.jpg`, drawing
/// `untextured` in their place where they are missing.
fn scanned(name: &str, untextured: Color, roughness: f32, normal_scale: f32) -> Material {
    Material::color(Color::WHITE)
        .with_untextured_color(untextured)
        .with_roughness(roughness)
        .with_base_texture(&format!("fetched/{name}-albedo.jpg"))
        .with_normal_texture(&format!("fetched/{name}-normal.jpg"), normal_scale)
        .with_metal_rough_texture(&format!("fetched/{name}-orm.jpg"))
}

/// Every surface the draw hook uses, made once per seed.
#[derive(Clone, Debug, Default)]
pub struct Surfaces {
    bark: Material,
    pine_bark: Material,
    rock: Material,
    pub(crate) planks: Material,
    /// The room's floor: the planks, worn smooth and waxed.
    pub(crate) floor: Material,
    logs: Material,
    roof: Material,
    pub(crate) stone: Material,
    door: Material,
    trim: Material,
    pub(crate) iron: Material,
    leaves: Vec<Material>,
    golden: Vec<Material>,
    needles: Vec<Material>,
    mullion: Material,
    hull: Material,
    coat: Material,
    jacket: Material,
    trousers: Material,
    skin: Material,
    straw: Material,
}

impl Surfaces {
    /// The surfaces.
    pub fn new() -> Surfaces {
        let foliage = |colors: &[Color; 3]| colors.iter().map(|c| Material::color(*c).with_roughness(LEAF_ROUGHNESS)).collect::<Vec<_>>();
        // Broad leaves let the sun through (renderer pass 2 B.1): a crown with the sun behind it
        // glows. Needles are thick and waxy, so the pines stay opaque.
        let thin = |colors: &[Color; 3]| foliage(colors).into_iter().map(|m| m.with_subsurface(Subsurface::LEAF)).collect();
        Surfaces {
            bark: scanned("bark", BARK, 1.0, 1.0),
            pine_bark: scanned("pine-bark", PINE_BARK, 1.0, 1.0),
            rock: scanned("rock", ROCK, 1.0, 1.2),
            planks: scanned("planks", PLANK, 1.0, 1.0),
            floor: scanned("planks", PLANK, FLOOR_ROUGHNESS, 1.0),
            logs: scanned("logs", LOG, 1.0, 1.0),
            roof: scanned("roof", SLATE, 1.0, 1.0),
            stone: scanned("stone", STONE, 1.0, 1.2),
            door: scanned("planks", DOOR_TINT, 1.0, 1.0),
            trim: Material::color(TRIM).with_roughness(0.7),
            iron: Material::color(IRON).with_metallic(0.85).with_roughness(0.45),
            leaves: thin(&LEAVES),
            golden: thin(&GOLDEN),
            needles: foliage(&PINES),
            mullion: Material::color(WINDOW_MULLION).with_roughness(0.8),
            hull: scanned("planks", HULL_TINT, 1.0, 1.0),
            coat: Material::color(DEER).with_roughness(0.85),
            jacket: Material::color(JACKET).with_roughness(0.8),
            trousers: Material::color(TROUSERS).with_roughness(0.9),
            skin: Material::color(SKIN).with_roughness(0.6),
            straw: Material::color(STRAW).with_roughness(0.85),
        }
    }
}

/// A local frame (a cabin, a dock, an animal): parts are placed in it and drawn in the world.
#[derive(Clone, Copy)]
pub(crate) struct Local {
    pub(crate) origin: Vec3,
    pub(crate) rotation: Quat,
}

impl Local {
    fn new(origin: Vec3, yaw: f32) -> Local {
        Local { origin, rotation: Quat::from_rotation_y(yaw) }
    }

    /// `p` in this frame, in the world.
    pub(crate) fn point(&self, p: Vec3) -> Vec3 {
        self.origin + self.rotation * p
    }

    /// A part at `at` in this frame, turned by `rotation`, scaled by `scale`.
    fn part(&self, at: Vec3, rotation: Quat, scale: Vec3) -> Transform {
        Transform { translation: self.point(at), rotation: self.rotation * rotation, scale }
    }

    /// A box of `size` centred at `at`.
    fn cube(&self, frame: &mut Frame, at: Vec3, size: Vec3, color: Color) {
        frame.cube(self.part(at, Quat::IDENTITY, size), color);
    }

    /// A box of `size` centred at `at`, of `material`.
    pub(crate) fn cube_with(&self, frame: &mut Frame, at: Vec3, size: Vec3, material: &Material) {
        frame.cube_with(self.part(at, Quat::IDENTITY, size), material);
    }

    /// `model` at `at`, turned by `rotation`, scaled by `scale`, of `material`.
    pub(crate) fn model(&self, frame: &mut Frame, model: &Model, at: Vec3, rotation: Quat, scale: Vec3, material: &Material) {
        frame.model_with(model, self.part(at, rotation, scale), material);
    }

    /// A cylinder of `radius` from `from` to `to`.
    fn rod(&self, frame: &mut Frame, cylinder: &Model, from: Vec3, to: Vec3, radius: f32, color: Color) {
        let along = to - from;
        let length = along.length();
        let turn = Quat::from_rotation_arc(Vec3::Y, along / length.max(1e-4));
        frame.model_tinted(cylinder, self.part(from, turn, vec3(radius * 2.0, length, radius * 2.0)), color);
    }

    /// A post of `radius` from `from` to `to`, of `material`.
    fn post(&self, frame: &mut Frame, post: &Model, from: Vec3, to: Vec3, radius: f32, material: &Material) {
        let along = to - from;
        let length = along.length();
        let turn = Quat::from_rotation_arc(Vec3::Y, along / length.max(1e-4));
        frame.model_with(post, self.part(from, turn, vec3(radius * 2.0, length, radius * 2.0)), material);
    }

    /// An ellipsoid with half-extents `radii` centred at `at`.
    fn blob(&self, frame: &mut Frame, sphere: &Model, at: Vec3, rotation: Quat, radii: Vec3, color: Color) {
        frame.model_tinted(sphere, self.part(at, rotation, radii), color);
    }
}

/// The draw ids of the things that move on their own (`frame.id`): under TAA a moving draw's
/// pixels find where they were last frame by its id, so the animals, the boat and the fisher are
/// named; the swaying trees keep their order and fall back to it.
const DUCK_IDS: [&str; 3] = ["duck-0", "duck-1", "duck-2"];
/// The two deer's ids.
const DEER_IDS: [&str; 2] = ["deer-0", "deer-1"];

/// Draw the lakeside as `camera` sees it (the trees' levels of detail follow it).
pub fn draw(world: &World, frame: &mut Frame, camera: &Camera) {
    let t = world.seconds();
    // A new shot (a key or a tap switched the camera): TAA and auto exposure start over instead of
    // smearing the last shot into this one.
    if world.cut_at == Some(world.tick) {
        frame.camera_cut();
    }
    frame.clear(HORIZON);
    frame.sun(world.time.sun_dir(), SUN_COLOR, SUN_INTENSITY).ambient(AMBIENT_COLOR, world.time.ambient(AMBIENT_INTENSITY));
    frame.environment(world.time.environment(world.backdrop.environment()));
    terrain(world, frame);
    lake(frame);
    trees(world, frame, camera.position, t);
    rocks(world, frame);
    cabin(world, frame, t);
    dock(world, frame, camera, t);
    lanterns(world, frame, t);
    fireflies(frame, camera, t);
    animals(world, frame, t);
}

fn terrain(world: &World, frame: &mut Frame) {
    frame.tag("terrain");
    if let Some(ground) = &world.models.terrain {
        frame.terrain(ground);
    }
}

/// How far past the lake's radii the water's rectangle reaches (the shoreline wobbles outwards;
/// the ground above the water level hides the rest).
const LAKE_MARGIN: f32 = 1.35;
/// The lake's water: a humic forest lake, its tannins taking blue first and red next (pure water's
/// own red loss), so the sandy bed shows olive-amber through the shallows and the deep water is a
/// dark tea-brown under the reflections, never a tropical turquoise (per metre, linear).
const LAKE_ABSORPTION: [f32; 3] = [0.6, 0.45, 1.1];
/// The light the lake's body scatters back: a dark olive-brown albedo (linear).
const LAKE_SCATTER: [f32; 3] = [0.012, 0.014, 0.006];
/// A thin lap of foam along the shore, metres of water under the surface.
const LAKE_FOAM_M: f32 = 0.025;
/// A calm evening lake: small ripples and a near-mirror reflection.
const LAKE_RIPPLE: f32 = 0.035;
const LAKE_ROUGHNESS: f32 = 0.07;

/// The lake: the renderer's water (renderer pass 2 B.3) over the lake's bounds at the water level.
/// The terrain above the level hides it, so its shoreline is where the ground meets the water, and
/// the shore foam follows the shallows there.
pub fn lake_water() -> Water {
    let half = LAKE_RADII * LAKE_MARGIN;
    Water::lake(vec3(LAKE_CENTER.x, WATER_LEVEL, LAKE_CENTER.y), half)
        .with_absorption(LAKE_ABSORPTION)
        .with_scatter(LAKE_SCATTER)
        .with_foam(LAKE_FOAM_M)
        .with_ripple(LAKE_RIPPLE, LAKE_ROUGHNESS)
}

/// The reflection probe over the lake: a box over the water and its shores, captured from above
/// open water, so the water (and the dock, the boat and the beach in it) reflects the woods
/// around the lake where the screen's reflection misses, not the open sky.
const LAKE_PROBE_HEIGHT: f32 = 1.5;
/// Where the probe captures from, against the lake's centre (x, z), m: out in the open water,
/// about 15 m from the dock's end. From the lake's middle it stood under 5 m from the fisher, so
/// the box projection magnified his rod across the near water as a dark squiggle at dusk and a
/// lantern-lit orange one at night (look fix WATER).
const LAKE_PROBE_OFFSET: [f32; 2] = [9.0, 5.0];
/// How far the probe's box reaches below and above the water level, and its fade past its faces, m.
const LAKE_PROBE_DEPTH: f32 = 4.0;
const LAKE_PROBE_TOP: f32 = 10.0;
const LAKE_PROBE_BLEND: f32 = 4.0;

/// The lake's reflection probe ([`LAKE_PROBE_HEIGHT`]).
pub fn lake_probe() -> ReflectionProbe {
    let half = LAKE_RADII * LAKE_MARGIN;
    let min = vec3(LAKE_CENTER.x - half.x, WATER_LEVEL - LAKE_PROBE_DEPTH, LAKE_CENTER.y - half.y);
    let max = vec3(LAKE_CENTER.x + half.x, WATER_LEVEL + LAKE_PROBE_TOP, LAKE_CENTER.y + half.y);
    let capture = vec3(LAKE_CENTER.x + LAKE_PROBE_OFFSET[0], WATER_LEVEL + LAKE_PROBE_HEIGHT, LAKE_CENTER.y + LAKE_PROBE_OFFSET[1]);
    ReflectionProbe::new(min, max).with_capture(capture).with_blend(LAKE_PROBE_BLEND)
}

fn lake(frame: &mut Frame) {
    frame.tag("lake");
    frame.water(&lake_water());
    frame.reflection_probe(&lake_probe());
}

fn pick_in<T>(items: &[T], tint: f32) -> &T {
    &items[((tint * items.len() as f32) as usize).min(items.len() - 1)]
}

fn trees(world: &World, frame: &mut Frame, eye: Vec3, t: f32) {
    frame.tag("trees");
    for (i, tree) in layout().trees.iter().enumerate() {
        let sway = 0.018 * math::sin(t * 1.1 + i as f32 * 0.73) + 0.008 * math::sin(t * 2.3 + i as f32 * 1.9);
        let lean = Quat::from_rotation_x(sway) * Quat::from_rotation_z(sway * 0.6);
        let lod = TreeLod::at(tree.base.distance(eye), tree.scale);
        tree_model(frame, world, tree, lean, lod);
    }
}

fn tree_model(frame: &mut Frame, world: &World, tree: &Tree, lean: Quat, lod: TreeLod) {
    let models = &world.models;
    let surfaces = &models.surfaces;
    let transform = Transform { translation: tree.base, rotation: lean * Quat::from_rotation_y(tree.yaw), scale: Vec3::splat(tree.scale) };
    let (meshes, bark, foliage): (&TreeMeshes, &Material, &Material) = match tree.kind {
        TreeKind::Pine => (&models.pine[tree.variant as usize % models.pine.len()][lod.index()], &surfaces.pine_bark, pick_in(&surfaces.needles, tree.tint)),
        TreeKind::Round => (&models.broadleaf[tree.variant as usize % models.broadleaf.len()][lod.index()], &surfaces.bark, pick_in(&surfaces.leaves, tree.tint)),
        TreeKind::Golden => (&models.broadleaf[tree.variant as usize % models.broadleaf.len()][lod.index()], &surfaces.bark, pick_in(&surfaces.golden, tree.tint)),
    };
    frame.model_with(&meshes.wood, transform, bark);
    frame.model_with(&meshes.foliage, transform, foliage);
}

fn rocks(world: &World, frame: &mut Frame) {
    frame.tag("rocks");
    for rock in &layout().rocks {
        let Rock { center, size, yaw, variant, tint: _ } = *rock;
        let transform = Transform { translation: center, rotation: Quat::from_rotation_y(yaw), scale: size };
        frame.model_with(&world.models.rock[variant as usize % world.models.rock.len()], transform, &world.models.surfaces.rock);
    }
    frame.tag("stones");
    for group in &world.models.stones {
        frame.group(group);
    }
}

/// The scattered stones (renderer pass 2 A.8 scatter, Lakeside v2): pebbles on the beach (the
/// sand layer above the lake bed) and stones along the path and the yard (the soil layer), on
/// flat-enough ground, leaning with it, squashed and sunk a little. Each kind is split over the
/// rock variants by its order, one retained instance group each (D4: uploaded once).
pub(crate) fn stone_groups(ground: &Terrain, rock: &[Model], surfaces: &Surfaces) -> Vec<InstanceGroup> {
    use crate::layout::TERRAIN_HALF;
    let corner = math::vec2(TERRAIN_HALF, TERRAIN_HALF);
    let kinds = [
        (Scatter::new(PEBBLE_DENSITY, &[SAND_LAYER]).with_scale(0.07, 0.16).on_flat_ground(0.8).following_ground(0.8).with_seed(11).with_cap(PEBBLES_MAX), 0.5),
        (Scatter::new(STONE_DENSITY, &[SOIL_LAYER]).with_scale(0.09, 0.22).on_flat_ground(0.85).following_ground(0.7).with_seed(23).with_cap(STONES_MAX), 0.6),
    ];
    let mut groups = Vec::new();
    for (rule, squash) in kinds {
        let placed = ground.scatter(&rule, -corner, corner);
        for (variant, model) in rock.iter().enumerate() {
            let transforms: Vec<Transform> = placed
                .iter()
                .skip(variant)
                .step_by(rock.len())
                .map(|t| {
                    let scale = t.scale * vec3(1.0, squash, 1.0);
                    Transform { translation: t.translation - Vec3::Y * scale.y * 0.25, rotation: t.rotation, scale }
                })
                .collect();
            if let Ok(group) = InstanceGroup::models_with(model, transforms, &surfaces.rock) {
                groups.push(group);
            }
        }
    }
    groups
}

/// The cabin's frame: on its yard, its front (+z) facing across the lake.
pub(crate) fn cabin_frame() -> Local {
    Local::new(vec3(CABIN.x, CABIN_FLOOR, CABIN.y), CABIN_YAW)
}

/// A turn that lays a part made along +x along +z instead.
fn along_z() -> Quat {
    Quat::from_rotation_y(-FRAC_PI_2)
}

fn cabin(world: &World, frame: &mut Frame, t: f32) {
    frame.tag("cabin");
    let c = cabin_frame();
    let (parts, surfaces) = (&world.models.parts, &world.models.surfaces);
    let (hw, hd) = (CABIN_WIDTH * 0.5, CABIN_DEPTH * 0.5);
    // Stone footing and the porch.
    c.model(frame, &parts.footing, vec3(0.0, -0.35, 0.0), Quat::IDENTITY, Vec3::ONE, &surfaces.stone);
    c.model(frame, &parts.porch, vec3(0.0, -0.08, hd + 1.0), Quat::IDENTITY, Vec3::ONE, &surfaces.planks);
    c.model(frame, &parts.step, vec3(0.0, -0.3, hd + 2.25), Quat::IDENTITY, Vec3::ONE, &surfaces.planks);
    log_walls(frame, &c, parts, &surfaces.logs);
    roof(frame, &c, parts, surfaces);
    // The door, open: hinged at the doorway's left jamb (from outside) and swung into the room
    // against it, so the low sun reaches the floor; then the lit windows and the chimney.
    let door = vec3(-DOOR_HALF_WIDTH + 0.06, DOOR_HEIGHT * 0.5, hd - LOG_RADIUS - 0.525);
    c.model(frame, &parts.door, door, Quat::from_rotation_y(FRAC_PI_2), Vec3::ONE, &surfaces.door);
    for x in [-2.0, 2.0] {
        c.cube_with(frame, vec3(x, 1.45, hd + 0.17), vec3(1.15, 1.1, 0.05), &surfaces.trim);
        window(frame, &c, vec3(x, 1.45, hd + 0.2), 1.0, &surfaces.mullion);
    }
    c.cube_with(frame, vec3(-1.6, 0.86, -hd - 0.17), vec3(1.0, 0.9, 0.05), &surfaces.trim);
    window(frame, &c, vec3(-1.6, 0.86, -hd - 0.2), -1.0, &surfaces.mullion);
    c.model(frame, &parts.chimney, vec3(-hw + 0.9, CHIMNEY_FOOT + CHIMNEY_HEIGHT * 0.5, -0.9), Quat::IDENTITY, Vec3::ONE, &surfaces.stone);
    // Porch posts, bench and a woodpile by the side wall.
    for x in [-hw - 0.15, hw + 0.15] {
        c.post(frame, &parts.post, vec3(x, 0.0, hd + EAVE - 0.05), vec3(x, WALL_HEIGHT - 0.05, hd + EAVE - 0.05), 0.09, &surfaces.logs);
    }
    c.model(frame, &parts.bench, vec3(-2.3, 0.42, hd + 0.5), Quat::IDENTITY, Vec3::ONE, &surfaces.planks);
    for (x, y) in [(0.0, 0.0), (0.3, 0.0), (0.6, 0.0), (0.15, 0.26), (0.45, 0.26), (0.3, 0.52)] {
        c.model(frame, &parts.firewood, vec3(hw + 0.45 + x, 0.13 + y, -1.6), along_z(), Vec3::ONE, &surfaces.logs);
    }
    crate::interior::room(world, frame, t);
}

/// The interlocking log walls: front and back logs along x, side logs along z half a log higher,
/// and the gable ends' shorter logs up to the ridge.
fn log_walls(frame: &mut Frame, c: &Local, parts: &Parts, logs: &Material) {
    let (hw, hd) = (CABIN_WIDTH * 0.5, CABIN_DEPTH * 0.5);
    let courses = (WALL_HEIGHT / (LOG_RADIUS * 2.0)) as u32;
    for i in 0..courses {
        let y = LOG_RADIUS + i as f32 * LOG_RADIUS * 2.0;
        c.model(frame, &parts.log_long, vec3(-hw - 0.35, y, -hd), Quat::IDENTITY, Vec3::ONE, logs);
        // The front's logs below the door's head stop at its jambs (the doorway).
        if y + LOG_RADIUS <= DOOR_HEIGHT + 0.05 {
            for x in [-hw - 0.35, DOOR_HALF_WIDTH] {
                c.model(frame, &parts.log_jamb, vec3(x, y, hd), Quat::IDENTITY, Vec3::ONE, logs);
            }
        } else {
            c.model(frame, &parts.log_long, vec3(-hw - 0.35, y, hd), Quat::IDENTITY, Vec3::ONE, logs);
        }
        for x in [-hw + 0.1, hw - 0.1] {
            c.model(frame, &parts.log_short, vec3(x, y + LOG_RADIUS, -hd - 0.35), along_z(), Vec3::ONE, logs);
        }
    }
    for k in 0..4 {
        let rise = (k as f32 + 0.5) * LOG_RADIUS * 2.0;
        let half = (hd + EAVE * 0.2) * (1.0 - rise / RIDGE_RISE);
        let squeeze = vec3(half * 2.0 / (CABIN_DEPTH + 0.7), 1.0, 1.0);
        for x in [-hw + 0.1, hw - 0.1] {
            c.model(frame, &parts.log_short, vec3(x, WALL_HEIGHT + rise, -half), along_z(), squeeze, logs);
        }
    }
}

/// A lit window at `at` in the cabin's frame, facing `side` (1 the front, -1 the back): four glowing
/// panes behind dark mullions, and the lamplight shining out of it, dipped towards the ground
/// (shadowed out of the front windows).
fn window(frame: &mut Frame, c: &Local, at: Vec3, side: f32, mullion_material: &Material) {
    let (half_width, half_height) = (0.44, 0.42);
    let lamp = Material::emissive(WINDOW_LAMP, WINDOW_GLOW);
    c.cube_with(frame, at, vec3(half_width * 2.0, half_height * 2.0, 0.02), &lamp);
    let mullion = at + vec3(0.0, 0.0, side * 0.015);
    c.cube_with(frame, mullion, vec3(0.06, half_height * 2.0, 0.02), mullion_material);
    c.cube_with(frame, mullion, vec3(half_width * 2.0, 0.06, 0.02), mullion_material);
    let out = c.rotation * vec3(0.0, -WINDOW_LIGHT_DIP, side);
    let (inner, outer) = WINDOW_CONE_DEGREES;
    let light = SpotLight::new(c.point(at - vec3(0.0, 0.0, side * 0.3)), out, WINDOW_LIGHT_RANGE, WINDOW_LAMP, WINDOW_LIGHT_INTENSITY);
    // The front windows' lamplight casts shadows (the porch posts and the bench across the yard)
    // where the device's preset grants spot shadow maps (two on high); the back one stays
    // unshadowed.
    frame.spot_light_with(&light.with_cone_degrees(inner, outer).with_shadow(side > 0.0));
}

fn roof(frame: &mut Frame, c: &Local, parts: &Parts, surfaces: &Surfaces) {
    let (run, drop) = roof_run_drop();
    let pitch = math::atan2(drop, run);
    for side in [-1.0_f32, 1.0] {
        let tilt = Quat::from_rotation_x(side * pitch);
        let at = vec3(0.0, WALL_HEIGHT + RIDGE_RISE - drop * 0.5 + 0.12, side * run * 0.5);
        c.model(frame, &parts.roof, at, tilt, Vec3::ONE, &surfaces.roof);
    }
    c.model(frame, &parts.log_long, vec3(-CABIN_WIDTH * 0.5 - 0.7, WALL_HEIGHT + RIDGE_RISE + 0.18, 0.0), Quat::IDENTITY, vec3(1.2, 0.9, 0.9), &surfaces.logs);
}

fn dock(world: &World, frame: &mut Frame, camera: &Camera, t: f32) {
    frame.tag("dock");
    let dock = &layout().dock;
    let d = Local::new(dock.at(0.0, 0.0), dock.yaw());
    let (parts, surfaces) = (&world.models.parts, &world.models.surfaces);
    let plank_pitch = 0.33;
    let planks = (DOCK_LENGTH / plank_pitch) as u32;
    for i in 0..planks {
        let z = 0.2 + i as f32 * plank_pitch;
        let jitter = 0.03 * crate::layout::hash2(i as i32, 3, 41);
        let plank = &parts.planks[(i as usize * 7 + 3) % parts.planks.len()];
        d.model(frame, plank, vec3(jitter, 0.0, z), Quat::IDENTITY, Vec3::ONE, &surfaces.planks);
    }
    for x in [-0.75, 0.75] {
        d.model(frame, &parts.beam, vec3(x, -0.13, DOCK_LENGTH * 0.5), along_z(), Vec3::ONE, &surfaces.planks);
    }
    let mut z = 0.6;
    while z < DOCK_LENGTH {
        for x in [-1.02, 1.02] {
            d.post(frame, &parts.post, vec3(x, -2.6, z), vec3(x, 0.18, z), 0.11, &surfaces.logs);
        }
        z += 2.3;
    }
    for x in [-0.95, 0.95] {
        d.post(frame, &parts.post, vec3(x, -2.6, DOCK_LENGTH - 0.2), vec3(x, 1.0, DOCK_LENGTH - 0.2), 0.08, &surfaces.logs);
    }
    boat(world, frame, dock, t);
    fisher(world, frame, camera, dock, t);
}

fn boat(world: &World, frame: &mut Frame, dock: &Dock, t: f32) {
    let bob = BOAT_BOB * math::sin(t * 1.3);
    let roll = BOAT_ROLL * math::sin(t * 0.9 + 1.0);
    // The dock's deck stands DOCK_DECK over the water; the hull's origin goes where the water lies
    // at BOAT_WATERLINE in the hull's frame.
    let at = dock.at(DOCK_LENGTH * 0.55, 2.05) - vec3(0.0, DOCK_DECK + BOAT_WATERLINE, 0.0);
    let b = Local { origin: at + vec3(0.0, bob, 0.0), rotation: Quat::from_rotation_y(dock.yaw() + 0.12) * Quat::from_rotation_z(roll) };
    let surfaces = &world.models.surfaces;
    frame.id("boat");
    b.model(frame, &world.models.parts.hull, Vec3::ZERO, Quat::IDENTITY, Vec3::ONE, &surfaces.hull);
    b.cube_with(frame, vec3(0.0, 0.08, 0.0), vec3(1.05, 0.05, 0.3), &surfaces.planks);
    b.cube_with(frame, vec3(0.0, 0.1, 1.0), vec3(0.75, 0.05, 0.28), &surfaces.planks);
    b.cube_with(frame, vec3(0.0, 0.06, -1.15), vec3(0.95, 0.05, 0.3), &surfaces.planks);
    b.post(frame, &world.models.parts.post, vec3(-0.5, 0.25, -0.6), vec3(0.45, 0.32, 1.3), 0.03, &surfaces.logs);
    frame.end_id();
}

fn fisher(world: &World, frame: &mut Frame, camera: &Camera, dock: &Dock, t: f32) {
    let f = Local::new(dock.at(DOCK_LENGTH - 0.45, 0.25), dock.yaw());
    let (sphere, cylinder, parts, surfaces) = (&world.models.sphere, &world.models.cylinder, &world.models.parts, &world.models.surfaces);
    frame.id("fisher");
    // Sitting on the end of the dock, legs over the edge, a rod out over the lake.
    f.model(frame, &parts.jacket, Vec3::ZERO, Quat::IDENTITY, Vec3::ONE, &surfaces.jacket);
    f.model(frame, &parts.trousers, Vec3::ZERO, Quat::IDENTITY, Vec3::ONE, &surfaces.trousers);
    f.model(frame, sphere, vec3(0.0, 0.9, 0.04), Quat::IDENTITY, vec3(0.1, 0.12, 0.11), &surfaces.skin);
    for x in [-0.07, 0.07] {
        f.model(frame, sphere, vec3(x, 0.55, 0.38), Quat::IDENTITY, Vec3::splat(0.045), &surfaces.skin);
    }
    f.model(frame, cylinder, vec3(0.0, 0.97, 0.04), Quat::IDENTITY, vec3(0.5, 0.025, 0.5), &surfaces.straw);
    f.model(frame, cylinder, vec3(0.0, 0.97, 0.04), Quat::IDENTITY, vec3(0.24, 0.13, 0.24), &surfaces.straw);
    let nod = 0.06 * math::sin(t * 0.8) + 0.02 * math::sin(t * 2.9);
    let hands = vec3(0.0, 0.55, 0.38);
    let tip = hands + vec3(0.25, 1.5 + nod, 2.0);
    f.rod(frame, cylinder, hands, tip, 0.018, Color::rgb(60, 44, 32));
    let bobber = f.point(vec3(0.6, 0.0, 4.6)) * vec3(1.0, 0.0, 1.0) + vec3(0.0, WATER_LEVEL + 0.02 + 0.015 * math::sin(t * 2.0), 0.0);
    fishing_line(frame, cylinder, camera, f.point(tip), bobber);
    frame.sphere(bobber, 0.055, BOBBER);
    frame.end_id();
}

/// The fisher's line from the rod's `tip` to the `bobber`, sagging, in thin cylinders: geometry, so
/// it is in the prepass's depth (the lake's water neither draws over it nor refracts it from the
/// opaque copy, which drew a saturated zigzag across the lake as an immediate line did) and lit by
/// the scene; each segment at least [`LINE_LEAST_RADIUS_PX`] wide where `camera` sees it, and none
/// past [`LINE_GROW_MAX`].
fn fishing_line(frame: &mut Frame, cylinder: &Model, camera: &Camera, tip: Vec3, bobber: Vec3) {
    let forward = (camera.target - camera.position).normalize_or_zero();
    // Pixels a metre spans one metre in front of the camera, at the reference height.
    let focal_px = crate::showcase::WORLD_SIZE[1] as f32 * 0.5 / math::tan(camera.fovy.to_radians() * 0.5);
    let at = |s: f32| tip.lerp(bobber, s) - Vec3::Y * (LINE_SAG * 4.0 * s * (1.0 - s));
    let world = Local::new(Vec3::ZERO, 0.0);
    for i in 0..LINE_SEGMENTS {
        let (from, to) = (at(i as f32 / LINE_SEGMENTS as f32), at((i + 1) as f32 / LINE_SEGMENTS as f32));
        let depth = ((from + to) * 0.5 - camera.position).dot(forward).max(0.1);
        let grow = (LINE_LEAST_RADIUS_PX * depth / (LINE_RADIUS * focal_px)).max(1.0);
        if grow <= LINE_GROW_MAX {
            world.rod(frame, cylinder, from, to, LINE_RADIUS * grow, LINE);
        }
    }
}

/// How bright a lantern's flame is at `t`: a flicker of its own around 1 (its position phases it).
pub fn lantern_flicker(light: Vec3, t: f32) -> f32 {
    0.92 + 0.05 * math::sin(t * 9.0 + light.x) + 0.03 * math::sin(t * 23.0 + light.z)
}

fn lanterns(world: &World, frame: &mut Frame, t: f32) {
    frame.tag("lanterns");
    let (parts, surfaces) = (&world.models.parts, &world.models.surfaces);
    let count = layout().lanterns.len();
    for (i, light) in layout().lanterns.iter().enumerate() {
        let flicker = lantern_flicker(*light, t);
        frame.point_light(*light, LANTERN_RANGE, LANTERN_LIGHT, LANTERN_INTENSITY * flicker);
        let hanging = i + 3 == count;
        let on_dock = i + 2 >= count;
        if !hanging && !on_dock {
            let ground = height(light.x, light.z);
            let post = Transform { translation: vec3(light.x, ground - 0.2, light.z), rotation: Quat::IDENTITY, scale: vec3(0.11, light.y - ground - 0.05, 0.11) };
            frame.model_with(&parts.post, post, &surfaces.logs);
        }
        let l = Local::new(*light, 0.3);
        l.cube_with(frame, vec3(0.0, 0.0, 0.0), vec3(0.17, 0.24, 0.17), &Material::emissive(GLASS, GLASS_GLOW * flicker));
        l.cube_with(frame, vec3(0.0, 0.16, 0.0), vec3(0.26, 0.07, 0.26), &surfaces.iron);
        l.cube_with(frame, vec3(0.0, -0.14, 0.0), vec3(0.22, 0.05, 0.22), &surfaces.iron);
        for (x, z) in [(-0.1, -0.1), (0.1, -0.1), (-0.1, 0.1), (0.1, 0.1)] {
            l.cube_with(frame, vec3(x, 0.0, z), vec3(0.025, 0.26, 0.025), &surfaces.iron);
        }
        if hanging {
            frame.line(*light + vec3(0.0, 0.2, 0.0), *light + vec3(0.0, 0.6, 0.0), IRON);
        }
    }
}

/// Where firefly `index` (homed at `home`) is at `t`, and how lit it is (0..1): a wandering loop
/// around its home and a blink of its own rhythm.
pub fn firefly(index: usize, home: Vec3, t: f32) -> (Vec3, f32) {
    let k = index as f32;
    let wander = vec3(math::sin(t * 0.31 + k * 1.7) * 1.4, math::sin(t * 0.47 + k * 0.9) * 0.35, math::cos(t * 0.27 + k * 2.3) * 1.4);
    let blink = (math::sin(t * (0.9 + 0.05 * (k % 7.0)) + k * 2.4) * 0.5 + 0.5).clamp(0.0, 1.0);
    (home + wander, blink * blink * blink)
}

/// The fireflies: tiny emissive bodies the look's bloom haloes, each as bright as its blink. Each
/// draws under its own id: a firefly that blinks out is skipped, so by draw order alone the ones
/// after it would take another's last position as their own and TAA would follow the wrong motion
/// (G0: a dark-cored trail behind the forest shot's fireflies in Live).
fn fireflies(frame: &mut Frame, camera: &Camera, t: f32) {
    frame.tag("fireflies");
    let forward = (camera.target - camera.position).normalize_or_zero();
    // Pixels a metre spans one metre in front of the camera, at the reference height.
    let focal_px = crate::showcase::WORLD_SIZE[1] as f32 * 0.5 / math::tan(camera.fovy.to_radians() * 0.5);
    for (i, home) in layout().fireflies.iter().enumerate() {
        let (at, lit) = firefly(i, *home, t);
        if lit < 0.02 {
            continue;
        }
        let depth = (at - camera.position).dot(forward).max(FIREFLY_RADIUS);
        let grow = (FIREFLY_LEAST_RADIUS_PX * depth / (FIREFLY_RADIUS * focal_px)).max(1.0);
        frame.id(&format!("firefly-{i}"));
        frame.sphere_with(at, FIREFLY_RADIUS * grow, &Material::emissive(FIREFLY, FIREFLY_GLOW * lit / (grow * grow)));
    }
    frame.end_id();
}

/// Where duck `i` swims at `t`: slow loops on the lake. Answers its position and heading.
pub fn duck(i: usize, t: f32) -> (Vec3, f32) {
    let loops = [(vec3(9.0, 0.0, -3.0), 3.4, 0.11, 0.0), (vec3(10.5, 0.0, -2.0), 2.6, 0.13, 1.4), (vec3(2.0, 0.0, 6.5), 4.2, -0.09, 3.0)];
    let (center, radius, speed, phase) = loops[i % loops.len()];
    let a = phase + speed * t;
    let p = center + vec3(math::cos(a), 0.0, math::sin(a)) * radius;
    let heading = math::atan2(-math::sin(a) * speed.signum(), math::cos(a) * speed.signum());
    (vec3(p.x, WATER_LEVEL + 0.03 * math::sin(t * 2.1 + i as f32), p.z), heading)
}

fn animals(world: &World, frame: &mut Frame, t: f32) {
    frame.tag("animals");
    let sphere = &world.models.sphere;
    for (i, id) in DUCK_IDS.into_iter().enumerate() {
        frame.id(id);
        let (at, heading) = duck(i, t);
        let d = Local::new(at, heading);
        let kind = usize::from(i == 2);
        d.blob(frame, sphere, vec3(0.0, 0.08, 0.0), Quat::IDENTITY, vec3(0.15, 0.1, 0.25), DUCK_BODY[kind]);
        d.blob(frame, sphere, vec3(0.0, 0.25, 0.17), Quat::IDENTITY, Vec3::splat(0.075), DUCK_HEAD[kind]);
        d.cube(frame, vec3(0.0, 0.23, 0.27), vec3(0.05, 0.025, 0.09), BEAK);
        d.cube(frame, vec3(0.0, 0.13, -0.26), vec3(0.08, 0.04, 0.1), DUCK_BODY[kind]);
    }
    let (parts, coat) = (&world.models.parts, &world.models.surfaces.coat);
    frame.id(DEER_IDS[0]);
    deer(frame, parts, coat, (vec3(-17.5, 0.0, -33.5), -1.45, 1.0), t, 0.0);
    frame.id(DEER_IDS[1]);
    deer(frame, parts, coat, (vec3(-18.6, 0.0, -31.0), -2.4, 0.72), t, 3.1);
    frame.end_id();
}

/// A grazing deer placed at (`at`, ground found here; facing `yaw`; of `size`), in its `coat`;
/// `phase` offsets its rhythm.
fn deer(frame: &mut Frame, parts: &Parts, coat: &Material, (at, yaw, size): (Vec3, f32, f32), t: f32, phase: f32) {
    let ground = vec3(at.x, height(at.x, at.z), at.z);
    let d = Local::new(ground, yaw);
    // Head down most of the time, up for a look around every nine seconds; a nibble while down.
    let cycle = (t + phase) % 9.0;
    let up = smoothstep(6.0, 6.8, cycle) * (1.0 - smoothstep(8.2, 8.9, cycle));
    let nibble = 0.05 * math::sin((t + phase) * 7.0) * (1.0 - up);
    let swing = Quat::from_rotation_x(mix(DEER_GRAZING, DEER_LOOKING, up) + nibble);
    d.model(frame, &parts.deer_body, Vec3::ZERO, Quat::IDENTITY, Vec3::splat(size), coat);
    d.model(frame, &parts.deer_head, vec3(0.0, 1.22, 0.52) * size, swing, Vec3::splat(size), coat);
}
