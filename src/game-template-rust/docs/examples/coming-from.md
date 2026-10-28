# Coming from another engine

You know Bevy, Unity, Unreal, three.js and Godot; this engine is none of them. Its habits look
close enough that a guess compiles half the time and is refused or wrong the other half. Find the
call you would have written below, write the genex one instead, and read the page it names before
writing more than a line of it. Every name here is the facade's own.

`use genex::prelude::*;` brings the hooks' types, `Model`, `Material`, `Color`, `Transform`,
`Camera`, `MeshData`, the glam math, `Key`, the action map, the audio types, `Animator`,
`Character` and `CharacterMotion`. The rest name their module: `genex::{Particles,
InstanceGroup, Streaming, CharacterParams}` at the crate root, `genex::render::{Environment,
RenderConfig, Grading, Fog}`, `genex::actions::{Device, Modifier}`, `genex::nav::{NavConfig,
NavAgent, NavMesh, NavInput}`, `genex::net::{NetConfig, NetEvent}`, `genex::saves::SaveConfig`,
and Rapier's own names through `genex::physics::{RigidBodyBuilder, ColliderBuilder, QueryFilter,
Ray}`.

## The five biggest differences

1. **The simulation is deterministic.** A seed and the input replay bit for bit on every device.
   Time is `ctx.dt` (always 1/60 s) and `ctx.tick`; randomness is `ctx.rng` in `on_update` and the
   `rng: &mut Pcg32` a reset gets. `std::time`, `Instant`, `rand::thread_rng`, `HashMap`, threads
   and `f32::sin` are refused by the build: use `genex::Map`/`genex::Set` and `genex::math`.
2. **Hooks, not entities and components.** There is no scene graph, no `spawn`, no component, no
   query. The game is one `World` struct you own (`sim.world`), changed by closures registered on
   `Game`: `on_reset`, `on_update`, `on_ui`, then the read-only `on_draw`, `camera` and `probe`.
   A thing in the game is a field or a `Vec` entry of `World`; a plugin is a facet
   (`src/facets/<slug>.rs` with `pub fn wire(game: &mut Game<super::World>)`).
3. **`on_draw` is read-only and immediate.** It gets `&Sim`, no `ctx`, and redraws everything every
   frame (`frame.model(..)`, `frame.cube(..)`, lights included). It cannot move, spawn or count
   anything: what changes on screen comes from state `on_update` wrote, such as a tick it kept.
4. **Assets load in `on_reset`, through `gfx`.** `gfx.assets().model("props/crate.glb")`,
   `gfx.sound(..)`, `gfx.character(..)`, `gfx.assets().bytes(..)`: only a reset has `gfx`. Keep
   the handles (`Model`, `Sound`, `Animator`) in `World` and draw or play them later. A bad path is
   a missing handle (a magenta checker, a silent sound), never a panic.
5. **The studio owns the build.** There is no `Cargo.toml`, `build.rs` or `.cargo/`; `genex.toml`
   is the only build input. A system (`[physics]`, `[audio]`, `[nav]`, `[streaming]`,
   `[animation]`, `[net]`) is switched on there; an extra crate comes only from the reviewed list
   or the `request_crate` tool. `src/main.rs` ends with `genex::install(game);`.

```rust
use genex::prelude::*;

#[derive(Default)]
pub struct World { crate_model: Model, crates: Vec<Vec3>, tick: u64 }

pub fn wire(game: &mut Game<World>) {
    game.on_reset(|sim, _seed, rng, gfx| {                      // Start / _ready / BeginPlay
        sim.world.crate_model = gfx.assets().model("props/crate.glb");
        sim.world.crates = (0..5).map(|i| vec3(i as f32 * 2.0, 0.0, rng.range(-3.0, 3.0))).collect();
    });
    game.on_update(|sim, ctx| {                                 // Update / _process / Tick
        sim.world.tick = ctx.tick;
        if ctx.keys.pressed(Key::Space) { sim.world.crates.push(vec3(0.0, 0.0, ctx.rng.range(-3.0, 3.0))); }
    });
    game.on_draw(|sim, frame, _camera| {                        // the renderer reads the world
        frame.tag("crates");
        for at in &sim.world.crates { frame.model(&sim.world.crate_model, Transform::from_translation(*at)); }
    });
    game.camera(|_sim| Camera::look_at(vec3(0.0, 6.0, 12.0), Vec3::ZERO));
    game.probe("crates", |sim| json!(sim.world.crates.len()));  // what Debug.Log would have shown
}
```

## Guesses that do not compile

| Guessed | Real |
|-|-|
| `frame.sphere_with(Transform, &mat)` | `frame.sphere_with(center, radius, &mat)`: a `Vec3` and an `f32`, never a `Transform` (`docs/api/drawing.md`) |
| `genex::render::Particles` | `genex::Particles` at the crate root (`docs/api/particles.md`) |
| `Material::with_double_sided` | No such flag: give a thin surface thickness (`frame.cube_with`) or both windings in a `MeshData` (`docs/api/drawing.md`) |
| egui `ui.ctx().screen_rect()` | `ui.ctx().content_rect()` (egui 0.36); `ui.max_rect()` is the hook's own area (`docs/api/ui.md`) |
| `CharacterParams { jump, .. }` | `CharacterParams { jump_speed, ..CharacterParams::default() }` (`docs/api/characters.md`) |
| `Device::Keyboard`, `Device::Pad` | `Device::KeyboardMouse`, `Device::Pad(_)`, `Device::Touch` from `genex::actions` (`docs/api/input.md`) |
| `Key::W`, `Key::Shift` | `Key::KeyW`, `Key::ShiftLeft`: DOM code names (`docs/api/ctx.md`) |
| `Color::rgb(0.2, 0.5, 1.0)`, `Color::srgb(..)` | `Color::rgb(51, 128, 255)`: 8-bit sRGB; `Color::rgba(r, g, b, a)` (`docs/api/drawing.md`) |
| `Transform::from_rotation(q)`, `transform.rotate_y(..)` | `Transform::IDENTITY.with_rotation(Quat::from_rotation_y(a))`; also `from_xyz`, `from_translation`, `.with_scale(..)` |
| `ctx.time`, `ctx.delta`, `time.delta_secs()` | `ctx.dt` and `ctx.tick` (`docs/api/ctx.md`) |
| `ctx.input`, `ctx.mouse` | `ctx.keys`, `ctx.pointer`, `ctx.look`, `ctx.wheel`, `ctx.touches`, `ctx.actions` |
| `gfx.load_model(..)`, `ctx.assets` | `gfx.assets().model(..)` in `on_reset` only (`docs/api/assets.md`) |
| `Camera { fov, .. }` | `Camera { fovy, .. }` in degrees, or `Camera::look_at(position, target)` |

`ctx.rng.f32()` and `ctx.rng.range(lo, hi)` are real (aliases of `unit` and `range_f32`), as on
the reset's `Pcg32`.

## Bevy

| Bevy | genex | Page |
|-|-|-|
| `App::new().add_plugins(..)`, a `Plugin` | `Game::new(World::default())` in `main`; a plugin is a facet's `wire(game)` | `docs/GENEX_API.md` |
| `commands.spawn((Mesh3d(..), MeshMaterial3d(..), Transform))` | Push a value into a `Vec` in `World`; draw it each frame with `frame.model(&model, transform)` or `frame.cube_with(transform, &material)` | `docs/api/drawing.md` |
| `Startup` systems | `game.on_reset(\|sim, seed, rng, gfx\| ..)`, run on every seed from `World::default()` | `docs/GENEX_API.md` |
| `Update` / `FixedUpdate` systems | `game.on_update(\|sim, ctx\| ..)`: a fixed 60 Hz tick, the only update | `docs/GENEX_API.md` |
| `Query<&mut T>`, `Resource`, `Res<T>` | Fields of `World`; a facet's private state is `game.facet_state::<T>()` and `sim.facets.get_mut::<T>()` | `docs/GENEX_API.md` |
| `States`, `Events` | An enum field in `World`; a `Vec` the next tick drains | `docs/GENEX_API.md` |
| `ButtonInput<KeyCode>::pressed(KeyCode::KeyW)` | `ctx.keys.down(Key::KeyW)`; `pressed` and `released` are the edges | `docs/api/ctx.md` |
| `leafwing` / `bevy_enhanced_input` actions | `game.input(ActionMap::new().context(Context::new(PLAY, 0).button(JUMP, &[Key::Space.into()])))`, then `ctx.actions.fired(JUMP)` | `docs/api/input.md` |
| `Res<Time>::delta_secs()`, `elapsed_secs()` | `ctx.dt`; `ctx.tick as f32 * ctx.dt` | `docs/api/ctx.md` |
| `rand::thread_rng().gen_range(a..b)` | `ctx.rng.range(a, b)`, `ctx.rng.range_i32(lo, hi)` (inclusive), `ctx.rng.below(n)`, `ctx.rng.chance(p)` | `docs/api/ctx.md` |
| A scene or `DynamicScene` spawned as a prefab | A Rust function that builds a struct; its `Model` loaded once in `on_reset`; many static copies are one `InstanceGroup::models(&model, transforms)` drawn with `frame.group(&group)` | `docs/api/instance-groups.md` |
| `AssetServer::load("x.glb#Scene0")` | `gfx.assets().model("x.glb")` in `on_reset` | `docs/api/assets.md` |
| `bevy_rapier3d` `RigidBody`, `Collider`, `ExternalImpulse` | `sim.physics` is Rapier itself: `physics.insert(RigidBodyBuilder::dynamic().translation(at), ColliderBuilder::cuboid(hx, hy, hz))`, `body.apply_impulse(v, true)`; never step it | `docs/api/physics.md` |
| `KinematicCharacterController` | `Character::spawn(&mut sim.physics, feet, CharacterParams::default())`, `character.drive(physics, CharacterMotion::Velocity { wish, jump }, ctx.dt)` | `docs/api/characters.md` |
| `AnimationPlayer`, `AnimationGraph` | `[animation]` on; `gfx.character(path)`, `Animator::simple(&hero)`, `.play(clip)`, `.crossfade(clip, s)`, `animator.update(ctx.dt)`; `frame.character(&animator, transform)` | `docs/api/animation.md` |
| `oxidized_navigation` / `vleue_navigator` | `[nav]` on; `game.navigation(NavConfig::walker(0.4, 1.8))`, `sim.nav.add_agent(NavAgent::new(at))`, `sim.nav.move_to(agent, target)` | `docs/api/navigation.md` |
| `AudioPlayer`, `SpatialAudioSink` | `[audio]` on; `gfx.sound(path)` in `on_reset`, `ctx.audio.play(&sound)` or `ctx.audio.play_at(&sound, position)` | `docs/api/audio.md` |
| `bevy_ui` nodes, `bevy_egui` `EguiContexts` | `game.on_ui(\|sim, ui, ctx\| ..)` hands you the `egui::Ui` directly; no other UI path | `docs/api/ui.md` |
| `StandardMaterial { base_color, perceptual_roughness, .. }` | `Material::color(Color::rgb(..)).with_roughness(0.4).with_metallic(0.0)`, `.with_base_texture(path)` | `docs/api/lighting.md` |
| `DirectionalLight`, `PointLight`, `AmbientLight` | `frame.sun(direction, color, intensity)`, `frame.point_light(position, range, color, intensity)`, `frame.ambient(color, intensity)`, every frame in `on_draw` | `docs/api/lighting.md` |
| `Bloom`, `Tonemapping`, `DistanceFog` components | `genex.toml` `[render.look]` (`bloom_intensity`, `tonemapper`, `fog_density`); a grade is `game.render_settings(RenderConfig::from_build().grading(..))` | `docs/api/rendering.md` |
| `Camera3d` + `Transform::looking_at` | `game.camera(\|sim\| Camera::look_at(eye, target))`, a read hook | `docs/GENEX_API.md` |
| `bevy_replicon` / `lightyear` | `[net]` on; `game.net(NetConfig::new())`, `sim.net` | `docs/api/net.md` |
| `bevy_pkv`, serde to a file | `game.saves(SaveConfig::schema(1))` and `game.save_world()`; `ctx.slots().save("quick", "Quick save")` | `docs/api/saves.md` |

## Unity

| Unity | genex | Page |
|-|-|-|
| `GameObject.CreatePrimitive`, a `MeshRenderer` | `frame.cube(transform, color)`, `frame.sphere(center, radius, color)`, `frame.model(&model, transform)` in `on_draw` | `docs/api/drawing.md` |
| `Awake` / `Start` | `game.on_reset(\|sim, seed, rng, gfx\| ..)` | `docs/GENEX_API.md` |
| `Update`, `FixedUpdate`, `LateUpdate` | One `game.on_update(\|sim, ctx\| ..)` at 60 Hz; the runtime steps physics after it | `docs/GENEX_API.md` |
| `Input.GetKey(KeyCode.W)`, `GetKeyDown` | `ctx.keys.down(Key::KeyW)`, `ctx.keys.pressed(Key::KeyW)` | `docs/api/ctx.md` |
| `Input.GetAxis("Horizontal")`, Input System actions | `.axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left)])`, then `ctx.actions.axis2(MOVE)` | `docs/api/input.md` |
| `Input.GetMouseButtonDown(0)`, `Input.touches` | `ctx.touches.began()`, `ctx.touches.tapped()`, `ctx.touches.all()`: the mouse's first button is touch 0 | `docs/api/ctx.md` |
| `Time.deltaTime`, `Time.time` | `ctx.dt`; a tick count kept in `World` from `ctx.tick` | `docs/api/ctx.md` |
| `Random.Range(a, b)`, `Random.value` | `ctx.rng.range(a, b)` (`f32`), `ctx.rng.range_i32(lo, hi)` (inclusive), `ctx.rng.f32()` | `docs/api/ctx.md` |
| `Instantiate(prefab)`, `Destroy(go)` | Push a struct into a `Vec` in `World`; `Vec::retain` to remove it (and `physics.remove_body(handle)` for its body) | `docs/api/drawing.md` |
| `GetComponent<T>()`, `FindObjectOfType` | Fields of `World`, or `sim.facets.get::<T>()` | `docs/GENEX_API.md` |
| `Rigidbody.AddForce(f, ForceMode.Impulse)` | `physics.bodies.get_mut(handle)` then `body.apply_impulse(v, true)` | `docs/api/physics.md` |
| `Physics.Raycast` | `physics.cast_ray(&ray, max_toi, true, QueryFilter::default())` | `docs/api/physics.md` |
| `OnCollisionEnter`, `OnTriggerEnter` | No callbacks: poll `physics.contact_pair(a, b)` and `pair.has_any_active_contact()` in `on_update` | `docs/api/physics.md` |
| `CharacterController.Move`, jump height | `character.drive(physics, CharacterMotion::Velocity { wish, jump }, ctx.dt)`; `CharacterParams { jump_speed, .. }` | `docs/api/characters.md` |
| `Animator.SetFloat`, `SetTrigger`, `CrossFade` | `animator.set_float(speed, v)`, `animator.fire(attack)` on a `hero.graph()` animator; `.crossfade(clip, s)`, `.play_once(clip)` on `Animator::simple` | `docs/api/animation.md` |
| `NavMeshAgent.SetDestination` | `sim.nav.move_to(agent, target)`; after `sim.nav.update(ctx.dt)` move the body by `sim.nav.desired_velocity(agent)` and report `sim.nav.set_position(agent, at, velocity)` | `docs/api/navigation.md` |
| `AudioSource.Play`, `PlayClipAtPoint` | `ctx.audio.play(&sound)`, `ctx.audio.play_at(&sound, position)`; loop with `PlayOpts::default().looped()` | `docs/api/audio.md` |
| Canvas, `Text`, `Button`, `OnGUI` | `game.on_ui(\|sim, ui, ctx\| { ui.label(..); if ui.button("Start").clicked() { .. } })`; menus `genex::ui::Menu` | `docs/api/ui.md` |
| `Material.SetColor`, `_EmissionColor` | `Material { base_color, .. }`, `Material::emissive(color, strength)` with a light beside it | `docs/api/lighting.md` |
| `Light` (Directional, Point, Spot), skybox | `frame.sun`, `frame.point_light`, `frame.spot_light`; `frame.environment(Environment::sky())` (`genex::render::Environment`) | `docs/api/lighting.md` |
| Post-processing Volume | `[render.look]` in `genex.toml`; `RenderConfig::from_build().grading(Grading::NEUTRAL.with_vibrance(1.1))` | `docs/api/grading.md` |
| `SceneManager.LoadScene` | A level enum in `World`, its data read in `on_reset` (`gfx.assets().bytes("levels/one.json")`), rebuilt in `on_update`; load during play with `[[asset_group]]` and `sim.stream.require(..)` | `docs/api/streaming.md` |
| `StartCoroutine`, `Invoke`, `WaitForSeconds` | A tick counter in `World` counted down in `on_update` | `docs/GENEX_API.md` |
| Netcode `[ServerRpc]`, `NetworkVariable` | `sim.net.send(kind, payload)` read back as `NetEvent::Message`; `sim.net.set_me(state)` read on `sim.net.remotes()` | `docs/api/net.md` |
| `PlayerPrefs`, `JsonUtility` to a file | `ctx.save(file, bytes)` / `ctx.load(file)`, or save slots | `docs/api/saves.md` |
| `ParticleSystem` | `Particles::steam(origin)` kept in `World`, `frame.particles(&emitter)` | `docs/api/particles.md` |
| `Debug.Log`, the Inspector | `game.probe("name", \|sim\| json!(..))` and `frame.tag("name")` | `docs/GENEX_API.md` |

## Unreal

| Unreal | genex | Page |
|-|-|-|
| `SpawnActor<AMyActor>`, a Blueprint class | A struct pushed into a `Vec` in `World`, drawn in `on_draw` | `docs/api/drawing.md` |
| `UStaticMeshComponent` | `gfx.assets().model(path)` in `on_reset`, `frame.model(&model, transform)` | `docs/api/drawing.md` |
| `BeginPlay` | `game.on_reset(\|sim, seed, rng, gfx\| ..)` | `docs/GENEX_API.md` |
| `Tick(float DeltaTime)` | `game.on_update(\|sim, ctx\| ..)` with `ctx.dt` (always 1/60) | `docs/GENEX_API.md` |
| Enhanced Input `UInputAction`, mapping contexts | `ActionMap`, `Context::new(id, priority)`, `Binding`, `Condition`, `Modifier`; `ctx.actions` | `docs/api/input.md` |
| `GetWorld()->GetTimeSeconds()` | `ctx.tick`; never a clock | `docs/api/ctx.md` |
| `FMath::RandRange`, `FRandomStream` | `ctx.rng.range(a, b)`, `ctx.rng.range_i32(lo, hi)`; the reset's `rng: &mut Pcg32` | `docs/api/ctx.md` |
| `AddImpulse`, `LineTraceSingleByChannel` | `body.apply_impulse(v, true)`; `physics.cast_ray(&ray, max_toi, true, QueryFilter::default())` | `docs/api/physics.md` |
| `OnComponentHit` | `physics.contact_pair(a, b)` polled in `on_update` | `docs/api/physics.md` |
| `ACharacter`, `JumpZVelocity`, `Jump()` | `Character::spawn(..)`, `CharacterParams { jump_speed, .. }`, `CharacterMotion::Velocity { wish, jump: true }` | `docs/api/characters.md` |
| Animation Blueprint, `Montage_Play` | `hero.graph()` with `g.float(..)`, `g.trigger(..)`, `g.state(..)`; `.play_once(clip)` | `docs/api/animation.md` |
| `AAIController::MoveToLocation` | `sim.nav.move_to(agent, target)` | `docs/api/navigation.md` |
| `UGameplayStatics::PlaySoundAtLocation` | `ctx.audio.play_at(&sound, position)` | `docs/api/audio.md` |
| UMG widgets | egui in `game.on_ui`; the kit's `Menu`, `Dialog`, `Bar` in `genex::ui`; the settings menu `genex::settings::menu(ui)` | `docs/api/ui.md` |
| Material Instance, `SetScalarParameterValue` | A `Material` value built per draw; custom WGSL is `gfx.material(path, &uniforms)` and `gfx.set_material_uniforms(..)` | `docs/api/custom-materials.md` |
| Directional, Point, Spot Light, Sky Atmosphere | `frame.sun`, `frame.point_light`, `frame.spot_light`, `frame.environment(Environment::sky())` | `docs/api/lighting.md` |
| Post Process Volume | `[render.look]`; `RenderConfig::from_build()`; a WGSL pass with `gfx.post_pass(path)` and `frame.post_pass(&pass)` | `docs/api/rendering.md` |
| `OpenLevel`, level streaming | Level data in `World`; `[[asset_group]]` with `sim.stream.require(..)`; an open world is `game.streaming(Streaming::grid(64.0))` | `docs/api/streaming.md` |
| `SetTimer` | A tick counter in `World` | `docs/GENEX_API.md` |
| `UPROPERTY(Replicated)`, `UFUNCTION(Server)` | `sim.net.set_me(..)`, `sim.net.set_object(id, state)` after `sim.net.claim(id)`; `sim.net.send_to_host(payload)` | `docs/api/net.md` |
| `USaveGame`, `SaveGameToSlot` | `game.saves(SaveConfig::schema(1))`, `ctx.slots().save(slot, label)`, `.load(slot)` | `docs/api/saves.md` |
| Niagara | `genex::Particles`, drawn with `frame.particles(&emitter)` | `docs/api/particles.md` |
| `UE_LOG`, stat commands | `game.probe(..)`; `genex::profile_scope!` | `docs/api/profiling.md` |

## three.js

| three.js | genex | Page |
|-|-|-|
| `scene.add(new THREE.Mesh(geometry, material))` | Nothing to add: `on_draw` draws what `World` holds, every frame | `docs/api/drawing.md` |
| `BoxGeometry`, `SphereGeometry`, `BufferGeometry` | `frame.cube(transform, color)`, `frame.sphere(center, radius, color)`; a built mesh is `MeshData::new()` and `gfx.mesh(&data)` | `docs/api/drawing.md` |
| `renderer.setAnimationLoop(fn)`, `requestAnimationFrame` | `game.on_update` for logic, `game.on_draw` for the picture; the runtime drives both | `docs/GENEX_API.md` |
| `clock.getDelta()`, `performance.now()` | `ctx.dt`, `ctx.tick` | `docs/api/ctx.md` |
| `Math.random()` | `ctx.rng.f32()`; `ctx.rng.range(a, b)` | `docs/api/ctx.md` |
| `addEventListener("keydown")`, pointer events | `ctx.keys.pressed(Key::KeyW)`, `ctx.touches.all()`, `ctx.pointer`, `ctx.look` | `docs/api/ctx.md` |
| `GLTFLoader().load(url, cb)` | `gfx.assets().model("x.glb")` in `on_reset`, synchronous | `docs/api/assets.md` |
| `AnimationMixer`, `clipAction(clip).play()` | `Animator::simple(&hero)`, `.play(clip)`, `.crossfade(clip, s)` | `docs/api/animation.md` |
| `mesh.clone()` per copy, `InstancedMesh` | Draw one `Model` many times, or `InstanceGroup::models(&model, transforms)` | `docs/api/instance-groups.md` |
| cannon-es, `@dimforge/rapier3d` | `sim.physics` (Rapier 3D, stepped for you) | `docs/api/physics.md` |
| `Raycaster` | `physics.cast_ray(..)` | `docs/api/physics.md` |
| `PositionalAudio` | `ctx.audio.play_at(&sound, position)` | `docs/api/audio.md` |
| An HTML overlay, `CSS2DRenderer` | egui in `game.on_ui`; there is no DOM | `docs/api/ui.md` |
| `MeshStandardMaterial({ color, roughness, side: DoubleSide })` | `Material::color(..).with_roughness(..)`; no double side | `docs/api/lighting.md` |
| `DirectionalLight`, `AmbientLight`, `scene.background` | `frame.sun`, `frame.ambient`, `frame.clear(color)` or `frame.environment(Environment::sky())` | `docs/api/lighting.md` |
| `EffectComposer`, `UnrealBloomPass` | `[render.look]` `bloom_intensity`; a WGSL post pass for the rest | `docs/api/custom-materials.md` |
| `PerspectiveCamera`, `OrbitControls` | `game.camera(\|sim\| Camera::look_at(..))` from angles kept in `World` and turned by `ctx.look` | `docs/examples/fps.md` |
| `Points`, sprite particles | `genex::Particles` | `docs/api/particles.md` |
| `localStorage` | `ctx.save(file, bytes)` / `ctx.load(file)` | `docs/api/ctx.md` |
| WebSocket multiplayer | `game.net(..)` and `sim.net`; never a socket of your own | `docs/api/net.md` |

## Godot

| Godot | genex | Page |
|-|-|-|
| `MeshInstance3D`, `add_child` | Push into `World`; draw in `on_draw` | `docs/api/drawing.md` |
| `_ready()` | `game.on_reset(\|sim, seed, rng, gfx\| ..)` | `docs/GENEX_API.md` |
| `_process(delta)`, `_physics_process(delta)` | One `game.on_update(\|sim, ctx\| ..)`; `ctx.dt` | `docs/GENEX_API.md` |
| `Input.is_action_pressed("jump")`, the Input Map | `ctx.actions.down(JUMP)` from `game.input(ActionMap::new()..)` | `docs/api/input.md` |
| `Input.is_key_pressed(KEY_W)` | `ctx.keys.down(Key::KeyW)` | `docs/api/ctx.md` |
| `randf()`, `randf_range(a, b)`, `RandomNumberGenerator` | `ctx.rng.f32()`, `ctx.rng.range(a, b)`, `ctx.rng.range_i32(lo, hi)` | `docs/api/ctx.md` |
| `preload("x.tscn").instantiate()`, `queue_free()` | A struct pushed into a `Vec` in `World`; `retain` to remove | `docs/api/drawing.md` |
| Autoload singletons, signals | Fields of `World`; a `Vec` of events drained by the next tick | `docs/GENEX_API.md` |
| `RigidBody3D.apply_impulse`, `RayCast3D` | `body.apply_impulse(v, true)`, `physics.cast_ray(..)` | `docs/api/physics.md` |
| `body_entered` | `physics.contact_pair(a, b)` polled in `on_update` | `docs/api/physics.md` |
| `CharacterBody3D.move_and_slide()`, `is_on_floor()` | `character.drive(..)` answers `CharacterStep { grounded, .. }`; `character.grounded()` | `docs/api/characters.md` |
| `AnimationPlayer.play`, `AnimationTree` | `Animator::simple` `.play(clip)`; `hero.graph()` for a state machine | `docs/api/animation.md` |
| `NavigationAgent3D.target_position` | `sim.nav.move_to(agent, target)`, `sim.nav.next_corner(agent)` | `docs/api/navigation.md` |
| `AudioStreamPlayer3D` | `ctx.audio.play_at(&sound, position)` | `docs/api/audio.md` |
| `Control`, `Label`, `Button` | egui in `game.on_ui` | `docs/api/ui.md` |
| `StandardMaterial3D` | `Material` (`with_roughness`, `with_metallic`, `with_base_texture`, `Material::emissive`) | `docs/api/lighting.md` |
| `DirectionalLight3D`, `OmniLight3D`, `SpotLight3D` | `frame.sun`, `frame.point_light`, `frame.spot_light` | `docs/api/lighting.md` |
| `WorldEnvironment` (glow, fog, tonemap) | `[render.look]`, `frame.environment(..)`, `RenderConfig::from_build().fog(Fog::default())` | `docs/api/rendering.md` |
| `get_tree().change_scene_to_file(..)` | A level enum in `World`, rebuilt from data read in `on_reset` | `docs/api/assets.md` |
| `Timer`, `await create_timer(1.0).timeout` | A tick counter in `World` (60 ticks a second) | `docs/GENEX_API.md` |
| `@rpc`, `MultiplayerSynchronizer` | `sim.net.send(kind, payload)`; `sim.net.set_me(state)` and `sim.net.remotes()` | `docs/api/net.md` |
| `FileAccess`, `ConfigFile`, `ResourceSaver` | `ctx.save(file, bytes)`; save slots with `game.save_world()` | `docs/api/saves.md` |
| `GPUParticles3D` | `genex::Particles` | `docs/api/particles.md` |
| `print()` | `game.probe(..)` | `docs/GENEX_API.md` |
