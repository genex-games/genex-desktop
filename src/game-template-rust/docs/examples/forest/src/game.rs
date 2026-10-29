//! A winter birch grove and a summer forest on one terrain, every plant grown by `gfx.plant`: no
//! file under `assets/`, no box or cone stand-in.
//!
//! West of x = 0 lies the grove: winter birches (white bark with lenticels, bare twig cards with
//! catkins) in three seeds, a dead birch, straw grass through the snow and a ring of winter
//! spruces on the hills, under an overcast sky. East lies the summer forest: oaks, maples, pines,
//! a willow, shrubs and grass clumps over the terrain's own meadow, spruces on the far hills,
//! under the sun. Each spec is one retained instance group placed by `terrain.scatter`; a hero
//! tree in each area is an ordinary draw. Every plant sways in the shared wind (its species'
//! `WindResponse`), crossfades between its three mesh levels and turns into its impostor far out.
//!
//! The cameras: the game camera stands in the grove; `grove-bark` looks at the hero birch's
//! trunk; `grove-wide` over the grove to the spruce hills; `summer` and `summer-wide` the same in
//! the forest. A camera west of x = 0 lights the frame as winter, east as summer.

use genex::plants::{PlantSpec, Season, Species};
use genex::prelude::*;
use genex::render::{Environment, SkyParams};
use genex::{Far, Grass, InstanceGroup, Scatter, Terrain, TerrainLayer, TerrainTexel};

/// The terrain: samples a side, spacing (m) and its south-west corner.
const SAMPLES: [u32; 2] = [321, 193];
const SPACING: f32 = 1.0;
const ORIGIN: Vec2 = Vec2::new(-160.0, -96.0);
/// The terrain layers: snow, meadow (growing grass), forest floor.
const SNOW: u8 = 0;
const MEADOW: u8 = 1;
const FLOOR: u8 = 2;
/// The hero trees: an ordinary draw each, near the area's camera.
const HERO_BIRCH: Vec2 = Vec2::new(-24.0, 3.0);
const HERO_OAK: Vec2 = Vec2::new(26.0, -5.0);

/// One stand: a spec scattered over an area of some layers at a density.
struct StandRule {
    tag: &'static str,
    spec: PlantSpec,
    layers: &'static [u8],
    min: Vec2,
    max: Vec2,
    density: f32,
    scale: (f32, f32),
    /// Where its far field starts thinning (m): ground cover thins, trees keep to the horizon.
    far: Option<(f32, f32)>,
}

const fn stand(tag: &'static str, spec: PlantSpec, layers: &'static [u8], area: [f32; 4], density: f32) -> StandRule {
    StandRule { tag, spec, layers, min: Vec2::new(area[0], area[1]), max: Vec2::new(area[2], area[3]), density, scale: (0.85, 1.15), far: None }
}

/// Every stand, the grove's first.
fn stands() -> Vec<StandRule> {
    let winter = |species, seed| PlantSpec::new(species, Season::Winter).seed(seed);
    let summer = |species, seed| PlantSpec::new(species, Season::Leafy).seed(seed);
    let grove = [-64.0, -34.0, -12.0, 34.0];
    let forest = [14.0, -40.0, 72.0, 40.0];
    vec![
        stand("winter-birch", winter(Species::Birch, 1), &[SNOW], grove, 0.0035),
        stand("winter-birch", winter(Species::Birch, 2), &[SNOW], grove, 0.0035),
        stand("winter-birch", winter(Species::Birch, 3), &[SNOW], grove, 0.0035),
        stand("dead-birch", PlantSpec::new(Species::Birch, Season::Dead).seed(4), &[SNOW], grove, 0.0006),
        StandRule { far: Some((30.0, 70.0)), scale: (0.7, 1.2), ..stand("winter-shrub", winter(Species::Shrub, 1), &[SNOW], grove, 0.004) },
        StandRule { far: Some((20.0, 45.0)), scale: (0.8, 1.3), ..stand("straw", winter(Species::Grass, 1), &[SNOW], [-46.0, -22.0, -10.0, 22.0], 0.12) },
        stand("winter-spruce", winter(Species::Spruce, 1), &[SNOW], [-155.0, -92.0, -70.0, 92.0], 0.003),
        stand("winter-spruce", winter(Species::Spruce, 2), &[SNOW], [-155.0, -92.0, -70.0, 92.0], 0.003),
        stand("oak", summer(Species::Oak, 1), &[MEADOW, FLOOR], forest, 0.0012),
        stand("oak", summer(Species::Oak, 2), &[MEADOW, FLOOR], forest, 0.0012),
        stand("maple", summer(Species::Maple, 1), &[MEADOW, FLOOR], forest, 0.0012),
        stand("maple", summer(Species::Maple, 2), &[MEADOW, FLOOR], forest, 0.0012),
        stand("pine", summer(Species::Pine, 1), &[FLOOR], [44.0, -60.0, 92.0, 60.0], 0.0025),
        stand("willow", summer(Species::Willow, 1), &[MEADOW], [16.0, 18.0, 44.0, 40.0], 0.0015),
        StandRule { far: Some((30.0, 70.0)), scale: (0.7, 1.25), ..stand("shrub", summer(Species::Shrub, 1), &[FLOOR], forest, 0.006) },
        StandRule { far: Some((30.0, 70.0)), scale: (0.7, 1.25), ..stand("shrub", summer(Species::Shrub, 2), &[MEADOW, FLOOR], forest, 0.004) },
        StandRule { far: Some((18.0, 40.0)), scale: (0.7, 1.3), ..stand("grass", summer(Species::Grass, 1), &[FLOOR], [10.0, -30.0, 60.0, 30.0], 0.35) },
        stand("summer-spruce", summer(Species::Spruce, 1), &[FLOOR], [80.0, -92.0, 155.0, 92.0], 0.0035),
        stand("summer-spruce", summer(Species::Spruce, 2), &[FLOOR], [80.0, -92.0, 155.0, 92.0], 0.0035),
    ]
}

/// One drawn stand: its tag, its group and how many plants it holds.
struct Stand {
    tag: &'static str,
    group: InstanceGroup,
    plants: usize,
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    ground: Option<Terrain>,
    stands: Vec<Stand>,
    heroes: Vec<(Model, Transform)>,
}

/// The grove's camera (the game camera): a walker's eye among the birches.
pub fn grove_camera() -> Camera {
    Camera { fovy: 60.0, ..Camera::look_at(vec3(-14.0, 1.8, 12.0), vec3(-26.0, 4.5, 1.0)) }
}

/// Register every hook.
pub fn wire(game: &mut Game<World>) {
    game.on_reset(reset);
    game.on_draw(draw);
    game.camera(|_| grove_camera());
    game.named_camera("grove-bark", |sim| {
        let at = ground_at(sim, HERO_BIRCH);
        Camera { fovy: 45.0, ..Camera::look_at(at + vec3(1.3, 1.5, 1.6), at + vec3(0.0, 1.9, 0.0)) }
    });
    game.named_camera("grove-wide", |_| Camera { fovy: 55.0, ..Camera::look_at(vec3(-8.0, 9.0, 34.0), vec3(-80.0, 6.0, -6.0)) });
    game.named_camera("summer", |_| Camera { fovy: 60.0, ..Camera::look_at(vec3(14.0, 1.8, 10.0), vec3(28.0, 5.0, -3.0)) });
    game.named_camera("summer-wide", |_| Camera { fovy: 55.0, ..Camera::look_at(vec3(6.0, 10.0, 36.0), vec3(90.0, 6.0, -8.0)) });
    game.probe("forest", |sim| {
        let stands = &sim.world.stands;
        let mut by_tag = Value::Object(Default::default());
        for stand in stands {
            let count = by_tag[stand.tag].as_u64().unwrap_or(0) + stand.plants as u64;
            by_tag[stand.tag] = json!(count);
        }
        json!({
            "stands": stands.len(),
            "plants": stands.iter().map(|stand| stand.plants).sum::<usize>() + sim.world.heroes.len(),
            "byTag": by_tag,
            "heroes": sim.world.heroes.len(),
            "firstAt": stands.first().and_then(|stand| stand.group.transforms().first()).map(|at| [at.translation.x, at.translation.z]),
        })
    });
}

/// The ground's height: gentle swells, rising to hills at both ends where the far stands grow.
fn height_at(x: f32, z: f32) -> f32 {
    let swell = 1.2 * genex::math::sin(x * 0.035) * genex::math::cos(z * 0.05) + 0.6 * genex::math::sin(x * 0.09 + z * 0.07);
    let rise = ((x.abs() - 80.0) / 70.0).clamp(0.0, 1.0);
    swell + 9.0 * rise * rise * (3.0 - 2.0 * rise)
}

/// The ground's layer at (x, z): snow in the west, meadow glades in a forest floor in the east,
/// blended across the line between them.
fn texel_at(x: f32, z: f32) -> TerrainTexel {
    if x < -4.0 {
        return TerrainTexel::layer(SNOW);
    }
    let glade = 0.5 + 0.5 * genex::math::sin(x * 0.11 + 1.3) * genex::math::cos(z * 0.09);
    let ground = if glade > 0.55 { MEADOW } else { FLOOR };
    if x > 4.0 {
        return TerrainTexel::layer(ground);
    }
    TerrainTexel::blend(SNOW, ground, (x + 4.0) / 8.0)
}

fn ground() -> Terrain {
    let meadow = Grass::meadow(40.0, 0.45).with_colors(Color::rgb(46, 66, 24), Color::rgb(112, 140, 52)).with_dry(Color::rgb(150, 136, 80), 0.15);
    let layers = vec![
        TerrainLayer::flat(Color::rgb(232, 236, 242)).with_roughness(0.75),
        TerrainLayer::flat(Color::rgb(70, 88, 40)).with_roughness(0.95).with_grass(meadow),
        TerrainLayer::flat(Color::rgb(66, 52, 38)).with_roughness(0.95),
    ];
    let terrain = Terrain::from_fn(SAMPLES, ORIGIN, SPACING, height_at).expect("the heights").with_layers(layers).expect("three layers");
    let texels: Vec<TerrainTexel> = (0..SAMPLES[1])
        .flat_map(|row| (0..SAMPLES[0]).map(move |column| texel_at(ORIGIN.x + column as f32 * SPACING, ORIGIN.y + row as f32 * SPACING)))
        .collect();
    terrain.with_control(&texels).expect("a control texel per sample")
}

fn ground_at(sim: &Sim<World>, at: Vec2) -> Vec3 {
    let height = sim.world.ground.as_ref().map_or(0.0, |ground| ground.height(at.x, at.y));
    vec3(at.x, height, at.y)
}

fn reset(sim: &mut Sim<World>, seed: u32, _rng: &mut Pcg32, gfx: &Gfx) {
    let terrain = ground();
    let mut drawn = Vec::new();
    for (index, rule) in stands().into_iter().enumerate() {
        let model = gfx.plant(&rule.spec);
        let scatter = Scatter::new(rule.density, rule.layers).with_scale(rule.scale.0, rule.scale.1).with_seed(seed.wrapping_add(index as u32 * 7919));
        let placed = terrain.scatter(&scatter, rule.min, rule.max);
        if placed.is_empty() {
            continue;
        }
        let plants = placed.len();
        let Ok(group) = InstanceGroup::models(&model, placed) else { continue };
        let group = match rule.far {
            Some((start, end)) => group.with_far(Far::thin(start, end)).unwrap_or(group),
            None => group,
        };
        drawn.push(Stand { tag: rule.tag, group, plants });
    }
    let hero_birch = gfx.plant(&PlantSpec::new(Species::Birch, Season::Winter).seed(9).height(17.0));
    let hero_oak = gfx.plant(&PlantSpec::new(Species::Oak, Season::Leafy).seed(9).height(16.0));
    let place = |at: Vec2| Transform::from_translation(vec3(at.x, terrain.height(at.x, at.y), at.y));
    let heroes = vec![(hero_birch, place(HERO_BIRCH)), (hero_oak, place(HERO_OAK))];
    sim.world = World { ground: Some(terrain), stands: drawn, heroes };
}

fn draw(sim: &Sim<World>, frame: &mut Frame, camera: &Camera) {
    let winter = camera.position.x < 0.0;
    if winter {
        frame.sun(vec3(-0.35, 0.5, 0.55), Color::rgb(236, 240, 255), 1.6).environment(Environment::Sky(SkyParams::overcast()));
    } else {
        frame.sun(vec3(0.45, 0.62, -0.4), Color::rgb(255, 244, 226), 3.2).environment(Environment::sky());
    }
    if let Some(ground) = &sim.world.ground {
        frame.tag("ground").terrain(ground);
    }
    for stand in &sim.world.stands {
        frame.tag(stand.tag).group(&stand.group);
    }
    frame.tag("heroes");
    for (model, at) in &sim.world.heroes {
        frame.model(model, *at);
    }
}
