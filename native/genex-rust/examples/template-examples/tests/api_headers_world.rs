//! The `use` lines and signature lists that open the world's reference pages (`docs/api/audio.md`,
//! `physics.md`, `navigation.md`, `streaming.md`, `terrain.md`, `water.md`, `instance-groups.md`
//! and the Rust half of `meshlets.md`), written out as code: each line here is one a page teaches,
//! so a facade change that moves a type or a call breaks this build before it misleads a game.

use genex::audio::{SoundRefusal, ZoneId};
use genex::gpu::PassSetup;
use genex::nav::{AgentId, NavAgent, NavArea, NavBody, NavConfig, NavDebug, NavError, NavFilter, NavInput, NavLink, NavLinkKind, NavMesh, NavObstacle, NavStatus};
use genex::nav::{NavLinkReached, NavMeshSource, NavPath, NavPoint, NavTile};
use genex::pack::{CellPacks, PackReadError};
use genex::physics::{Ball, Collider, ColliderBuilder, ColliderHandle, ContactPair, Pose, QueryFilter, Ray, RevoluteJointBuilder, RigidBody, RigidBodyBuilder, RigidBodyHandle, RopeJointBuilder};
use genex::prelude::*;
use genex::render::{ClassOverride, DeviceClass, FormFactor, Meshlets, PerformanceTier, RenderConfig, RenderFeature, Water};
use genex::{AssetTable, CellBuild, CellId, EnteredCell, GroupHandles, StreamError, StreamErrorCode, StreamTicket, Streaming, TerrainTiles};
use genex::{CellColliders, StreamColliders, StreamCommit};
use genex::{Far, InstanceGroup, InstanceGroupError};
use genex::{Grass, Scatter, Terrain, TerrainError, TerrainLayer, TerrainTexel};
use genex::digest;

/// A thing a cell builder adds and the update reads back.
#[derive(Clone, Copy, Debug)]
struct Rock;

/// audio.md: the handles, every `ctx.audio` call, the options and the setup.
fn audio(game: &mut Game<()>, gfx: &Gfx, ctx: &Ctx, at: Vec3) -> (Voice, ZoneId) {
    let step: Sound = gfx.sound("sfx/step.wav");
    let theme: Music = gfx.music("music/theme.ogg");
    let _: (Option<SoundRefusal>, bool, f32) = (step.refusal(), step.is_missing(), step.seconds());
    let _: Voice = ctx.audio.play(&step);
    let _: Voice = ctx.audio.play_at(&step, at);
    let hum: Voice = ctx.audio.play_with(&step, PlayOpts::default().looped().on(Bus::Ambience).volume_db(-6.0).max_instances(8));
    let _: Voice = ctx.audio.play_with(&step, PlayOpts::ui());
    let _ = [Bus::Music, Bus::Sfx, Bus::Ui, Bus::Voice, Bus::Ambience];
    ctx.audio.stop(hum, 0.5);
    ctx.audio.stop_bus(Bus::Sfx, 0.5);
    ctx.audio.set_position(hum, at);
    ctx.audio.teleport(hum, at);
    ctx.audio.set_volume(hum, -3.0, 0.2);
    ctx.audio.set_pitch(hum, 1.2, 0.2);
    let _: (bool, Option<f32>) = (ctx.audio.playing(hum), ctx.audio.position_s(hum));
    ctx.audio.bus_volume(Bus::Music, -6.0, 1.0);
    ctx.audio.master_volume(0.0, 1.0);
    ctx.audio.music(&theme, MusicOpts::default());
    ctx.audio.stop_music(2.0);
    ctx.audio.listener(Some(Listener { position: at, forward: Vec3::NEG_Z, up: Vec3::Y }));
    ctx.audio.listener(None);
    let cave = ReverbZone { name: "cave", shape: ZoneShape::Box { min: Vec3::ZERO, max: Vec3::ONE }, preset: ReverbPreset::CAVE, send_db: -6.0, uniformity: 0.5 };
    let _ = ZoneShape::Sphere { center: Vec3::ZERO, radius: 4.0 };
    let zone: ZoneId = ctx.audio.add_zone(cave);
    ctx.audio.remove_zone(zone);
    let duck = Duck { trigger: Bus::Voice, target: Bus::Music, depth_db: -9.0, attack_s: 0.1, release_s: 0.5 };
    game.audio(AudioSetup { ducks: vec![duck], zones: vec![cave], occlusion: true, ..AudioSetup::default() });
    let _: Spatial = AudioSetup::default().spatial;
    (hum, zone)
}

/// physics.md: bodies, colliders, reads, forces, queries, contacts and joints on `sim.physics`.
fn physics(physics: &mut PhysicsWorld, at: Vec3, aim: Vec3, me: RigidBodyHandle) -> Option<RigidBodyHandle> {
    let (body, collider): (RigidBodyHandle, ColliderHandle) = physics.insert(
        RigidBodyBuilder::dynamic().translation(at).linvel(Vec3::X).linear_damping(0.05).ccd_enabled(true),
        ColliderBuilder::cuboid(0.5, 0.5, 0.5).mass(20.0).friction(0.7).restitution(0.05),
    );
    physics.insert(RigidBodyBuilder::fixed(), ColliderBuilder::ball(1.0).density(300.0));
    physics.insert(RigidBodyBuilder::fixed(), ColliderBuilder::cylinder(0.6, 0.4));
    let anchor: RigidBodyHandle = physics.insert_body(RigidBodyBuilder::kinematic_position_based());
    let _: Option<&RigidBody> = physics.bodies.get(body);
    let _: Option<&Collider> = physics.colliders.get(collider);
    let moving: &mut RigidBody = physics.bodies.get_mut(body)?;
    let _: (Vec3, Quat, Vec3, Vec3) = (moving.translation(), *moving.rotation(), moving.linvel(), moving.angvel());
    moving.apply_impulse(Vec3::Y, true);
    moving.apply_impulse_at_point(Vec3::Y, at, true);
    moving.set_next_kinematic_translation(at);
    moving.set_position(Pose::from_parts(at, Quat::IDENTITY), true);
    moving.set_linvel(Vec3::ZERO, true);
    moving.set_angvel(Vec3::ZERO, true);
    let _: (bool, bool) = (moving.is_sleeping(), moving.is_dynamic());
    let ray = Ray::new(at, aim);
    let hit: Option<(ColliderHandle, f32)> = physics.cast_ray(&ray, 100.0, true, QueryFilter::default().exclude_rigid_body(me));
    let _: Option<Vec3> = hit.map(|(_, toi)| ray.point_at(toi));
    let near: Vec<Option<RigidBodyHandle>> = physics.intersect_shape(Pose::from_translation(at), &Ball::new(4.0), QueryFilter::only_dynamic()).map(|(_, c)| c.parent()).collect();
    let awake: usize = physics.active_bodies().count();
    let touching: Option<bool> = physics.contact_pair(collider, collider).map(ContactPair::has_any_active_contact);
    physics.insert_impulse_joint(anchor, body, RopeJointBuilder::new(8.0));
    physics.insert_impulse_joint(anchor, body, RevoluteJointBuilder::new(Vec3::Y).local_anchor2(Vec3::X).limits([-1.57, 1.57]));
    let _: (u32, u32) = body.into_raw_parts();
    let _ = (near, awake, touching);
    let _: Option<RigidBody> = physics.remove_body(anchor);
    Some(body)
}

/// navigation.md: the config, the input and mesh, tiles, areas, obstacles, agents, links, bodies,
/// queries, the probe and saves.
fn navigation(game: &mut Game<()>, sim: &mut Sim<()>, ctx: &Ctx, frame: &mut Frame, rng: &mut Pcg32) -> Result<AgentId, NavError> {
    game.navigation(NavConfig::walker(0.4, 1.8).with_tile(16.0).with_climb(0.4).with_slope(45.0).with_cells(0.2, 0.1));
    game.nav_bake("market", |_gfx| NavInput::new());
    let floor = [Vec3::ZERO, Vec3::X, Vec3::Z];
    let input: NavInput = NavInput::new().with_triangles(&floor, &[0, 1, 2], NavArea::WALK)?.with_static_colliders(&sim.physics, NavArea::WALK)?;
    let _: Result<NavInput, NavError> = NavInput::new().with_colliders(&sim.physics, |_view| Some(NavArea::GRASS));
    let config: NavConfig = sim.nav.config().clone();
    let mesh: NavMesh = NavMesh::bake(&input, &config)?;
    let cell: CellId = config.tile_of(Vec3::ZERO);
    let tile: NavTile = NavMesh::bake_tile(&input, &config, cell)?;
    let (_, _): (Vec<u8>, NavMeshSource) = (mesh.to_bytes(), mesh.source());
    let _: NavMesh = NavMesh::from_bytes_for(&input, &config, &mesh.to_bytes())?;
    let nav = &mut sim.nav;
    nav.add_mesh(&mesh)?;
    nav.add_tile(&tile)?;
    let _: bool = nav.remove_tile(cell);
    let _: (usize, u64) = (nav.tiles().count(), nav.digest());
    nav.update(ctx.dt);
    nav.set_area_cost(NavArea::ROAD, 0.8)?;
    nav.set_area_open(NavArea::DOOR, false);
    let _ = (NavArea::WATER, NavArea::custom(8));
    let disc = nav.add_obstacle(NavObstacle::Avoid { position: Vec3::ZERO, radius: 1.0 })?;
    nav.move_obstacle(disc, NavObstacle::CarveCylinder { base: Vec3::ZERO, radius: 1.0, height: 2.0 });
    let _ = NavObstacle::CarveBox { transform: Mat4::IDENTITY };
    nav.remove_obstacle(disc);
    let _: usize = nav.pending_rebuilds();
    let agent: AgentId = nav.add_agent(NavAgent::new(Vec3::ZERO).with_speed(3.5, 5.0))?;
    let _: (bool, bool) = (nav.move_to(agent, Vec3::X), nav.stop(agent));
    let wish: Vec3 = nav.desired_velocity(agent);
    nav.set_position(agent, Vec3::ZERO, wish);
    let _: (Option<NavStatus>, Option<Vec3>) = (nav.status(agent), nav.next_corner(agent));
    let link = nav.add_link(NavLink::between(Vec3::ZERO, Vec3::Y, NavLinkKind::Ladder).both_ways())?;
    let _: Option<NavLinkReached> = nav.take_link(agent);
    nav.finish_link(agent);
    nav.set_link_open(link, false);
    nav.remove_link(link);
    let body = nav.add_body(NavBody { position: Vec3::ZERO, velocity: Vec3::ZERO, radius: 0.4 })?;
    nav.set_body(body, Vec3::X, Vec3::ZERO);
    nav.remove_body(body);
    let filter = NavFilter::new();
    let _: Option<NavPoint> = nav.closest_point(Vec3::ZERO, 2.0);
    let _: Option<NavPath> = nav.path(Vec3::ZERO, Vec3::X, &filter);
    let _ = (nav.raycast(Vec3::ZERO, Vec3::X, &filter), nav.move_along(Vec3::ZERO, Vec3::X, &filter), nav.distance_to_wall(Vec3::ZERO, 2.0));
    let _: Option<NavPoint> = nav.random_point(rng, Vec3::ZERO, 10.0, &filter);
    let _: Value = Value::from(&nav.probe());
    let snapshot = nav.snapshot();
    nav.restore(&snapshot)?;
    nav.remove_agent(agent);
    frame.nav_debug(&sim.nav, NavDebug::mesh().with_links().with_paths());
    let _ = (NavDebug::borders(), NavDebug::everything());
    Ok(agent)
}

/// A commit hook (`game.stream_commit`): its two calls.
struct Watch;

impl StreamCommit<()> for Watch {
    fn leave(&self, _sim: &mut Sim<()>, _cell: CellId) {}

    fn enter(&self, _sim: &mut Sim<()>, _cell: &EnteredCell) {}
}

/// streaming.md: the registration, the builders, the sim set, kept cells, saves, groups, terrain
/// tiles, packs and digests.
fn streaming(game: &mut Game<()>, sim: &mut Sim<()>, frame: &mut Frame, model: &Model, table: AssetTable) -> Result<StreamTicket, StreamError> {
    let tiles: TerrainTiles = TerrainTiles::procedural(129, |_x, _z| 0.0).and_then(|tiles| tiles.with_height_range(-64.0, 64.0)).expect("tiles");
    let _: Result<TerrainTiles, TerrainError> = TerrainTiles::authored(&[], |_cell| None, |_cell| None);
    game.streaming(Streaming::grid(64.0).sim_radius(1).hysteresis(1).prefetch(1).anchors(1).view_radius(256.0).terrain(tiles.clone()));
    let _: f32 = Streaming::grid(64.0).cell_size();
    let boulder = model.clone();
    game.cell_content(move |_cell, inputs| {
        let (_min, _max): (Vec2, Vec2) = inputs.bounds();
        let _: Pcg32 = inputs.rng();
        let _: Model = inputs.model("rocks/boulder.glb");
        let _: (CellId, u32) = (inputs.cell(), inputs.seed());
        CellBuild::default().thing(Rock).model(&boulder, Transform::IDENTITY)
    });
    game.cell_content(|_cell, inputs| {
        let terrain = Terrain::from_fn([3, 3], Vec2::ZERO, 1.0, |_x, _z| 0.0).expect("terrain");
        let trees: Vec<Transform> = inputs.scatter(&terrain, &Scatter::new(0.8, &[0]).with_scale(0.6, 1.4).following_ground(0.5));
        CellBuild::<()>::default().group(InstanceGroup::cubes(trees, &Material::color(Color::WHITE)).expect("a group"))
    });
    game.cell_content(|_cell, _inputs| CellBuild::<()>::default().part(CellColliders::new().with(ColliderBuilder::cuboid(1.0, 1.0, 1.0))));
    game.cell_content(tiles.colliders_content(64.0));
    game.stream_colliders();
    game.stream_commit(Watch);
    sim.stream.set_anchor("player", Vec3::ZERO)?;
    sim.stream.clear_anchor("player");
    for cell in sim.stream.entered() {
        let _: (CellId, Vec<&Rock>, Option<StreamErrorCode>) = (cell.cell(), cell.things::<Rock>().collect(), cell.refused());
    }
    let _: &[CellId] = sim.stream.left();
    let here = CellId::new(0, 0);
    let _: (usize, bool, Option<f32>) = (sim.stream.active().count(), sim.stream.is_active(here), sim.stream.ground(1.0, 1.0));
    let _: &[ColliderHandle] = sim.facets.get::<StreamColliders>().handles(here);
    sim.stream.keep(here)?;
    sim.stream.release(here);
    let _: usize = sim.stream.kept().count();
    let save: Value = sim.stream.snapshot();
    sim.stream.restore(&save)?;
    let ticket: StreamTicket = sim.stream.require("interior")?;
    if let Some(handles) = sim.stream.ready(ticket) {
        let handles: GroupHandles = handles;
        let _ = (handles.bytes("interior/room.json"), handles.model("interior/room.glb"), handles.paths().count());
    }
    let _: Option<StreamErrorCode> = sim.stream.group_refusal(ticket);
    sim.stream.release_group("interior");
    let _: usize = sim.stream.required_groups().count();
    let _: (u32, bool, Vec<CellId>) = (tiles.samples(), tiles.is_procedural(), tiles.authored_cells());
    let _: Option<Terrain> = tiles.tile(here, 64.0);
    let _ = tiles.tile_heights(here, 64.0);
    let _: TerrainTiles = tiles.with_colliders(false);
    let _: (Option<Collider>, CellColliders) = (tiles.collider(here, 64.0), tiles.cell_colliders(here, 64.0));
    let packs: Result<CellPacks, PackReadError> = CellPacks::from_table(table, "valley");
    if let Ok(packs) = packs {
        let _ = (packs.world(), packs.cell(here), packs.cells().count(), packs.digest());
    }
    let hash: u64 = digest::fnv1a64_from(b"b", digest::fnv1a64(b"a"));
    let _: String = digest::hex64(hash);
    frame.cells_debug();
    Ok(ticket)
}

/// terrain.md: the heights, the layers and their grass, the control map, the ground's height and
/// the scatter.
fn terrain(frame: &mut Frame, rockiness: &[f32]) -> Result<Vec<Transform>, TerrainError> {
    let ground: Terrain = Terrain::from_fn([385, 385], vec2(-96.0, -96.0), 0.5, |_x, _z| 0.0)?;
    let _: Terrain = Terrain::from_heights([2, 2], Vec2::ZERO, 1.0, &[0.0; 4])?;
    let meadow = Grass::meadow(36.0, 0.5)
        .with_height(0.2, 0.6)
        .with_width(0.01, 0.02)
        .with_colors(Color::BLACK, Color::WHITE)
        .with_dry(Color::WHITE, 0.2)
        .with_flowers(Color::RED, 0.05)
        .with_transmission(0.5);
    let grass = TerrainLayer::textured("ground/grass-layer.png", "ground/grass-data.png", 2.0).with_tint(Vec3::ONE).with_fallback(Color::WHITE).with_grass(meadow);
    let layered: Terrain = ground.with_layers(vec![grass, TerrainLayer::flat(Color::BLACK)])?;
    let texels: Vec<TerrainTexel> = rockiness.iter().map(|amount| TerrainTexel::blend(0, 1, *amount).with_wetness(0.0)).collect();
    let _ = TerrainTexel::layer(1);
    let painted: Terrain = layered.with_control(&texels)?;
    let _: f32 = painted.height(1.0, 2.0);
    frame.terrain(&painted);
    let rule = Scatter::new(0.4, &[0, 1]).with_scale(0.7, 1.3).with_seed(2).on_flat_ground(0.9).following_ground(0.5).with_cap(5000);
    Ok(painted.scatter(&rule, vec2(-60.0, -60.0), vec2(60.0, 60.0)))
}

/// water.md: the lake, its look, its draw and where the renderer draws it.
fn water(frame: &mut Frame, setup: &PassSetup<'_>) -> bool {
    let lake: Water = Water::lake(vec3(6.0, 0.0, 2.0), vec2(28.0, 20.0))
        .with_absorption([0.6, 0.45, 1.1])
        .with_scatter([0.012, 0.014, 0.006])
        .with_foam(0.025)
        .with_ripple(0.035, 0.07)
        .with_refraction(0.02);
    frame.water(&lake);
    Water::drawn_at(setup.quality())
}

/// instance-groups.md: the four makers, the draw, a range update and the far field.
fn instance_groups(frame: &mut Frame, model: &Model, transforms: Vec<Transform>) -> Result<InstanceGroup, InstanceGroupError> {
    let material = Material::color(Color::WHITE);
    let _: InstanceGroup = InstanceGroup::cubes(transforms.clone(), &material)?;
    let _: InstanceGroup = InstanceGroup::spheres(transforms.clone(), &material)?;
    let _: InstanceGroup = InstanceGroup::models_with(model, transforms.clone(), &material)?;
    let mut forest: InstanceGroup = InstanceGroup::models(model, transforms.clone())?;
    forest.update(0, &transforms)?;
    frame.group(&forest);
    forest.with_far(Far::thin(60.0, 400.0).fading_out(40.0))
}

/// meshlets.md: a class's switches and the game's narrowing setting.
fn meshlets(game: &mut Game<()>) {
    let desktop_high = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let switches = vec![(RenderFeature::Meshlets, true), (RenderFeature::Occlusion, true)];
    let narrowed = Meshlets::DEFAULT.with_enabled(true).with_occlusion(false).with_min_triangles(4096);
    game.render_settings(RenderConfig::new().class(desktop_high, ClassOverride { switches, ..ClassOverride::default() }).meshlets(narrowed));
}

/// What each page's code reaches is named where the page says it is.
#[test]
fn the_world_pages_name_real_paths_and_shapes() {
    let _ = (audio, physics, navigation, streaming, terrain, water, instance_groups, meshlets);
    let hum = PlayOpts::default().looped().on(Bus::Ambience);
    assert!(hum.looped && hum.bus == Bus::Ambience, "looped() loops and on(bus) picks the bus");
    assert!(!Far::thin(10.0, 5.0).is_valid(), "a far field ends past its start");
    let mut frame = Frame::new(Color::BLACK);
    assert!(terrain(&mut frame, &[0.0; 385 * 385]).is_ok(), "the terrain header's numbers are in range");
}
