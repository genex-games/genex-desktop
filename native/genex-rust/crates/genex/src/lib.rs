//! The genex game facade: the only API a generated game's Rust code is written against.
//!
//! A game builds a [`Game`] over its own world type `W`, registers hooks and hands it to
//! [`install`]. Mutating hooks (`on_reset`, `on_update`, `on_ui`, demos) receive `&mut Sim<W>`;
//! read hooks (`on_draw`, `camera`, `named_camera`, `eye`, `probe`, `player`) receive `&Sim<W>`
//! and are `Fn`, so captures, observer cameras and Live frames can never move the checksum.
//!
//! ```
//! use genex::prelude::*;
//!
//! #[derive(Default)]
//! struct World { score: u32 }
//!
//! let mut game = Game::new(World::default()).title("Doc").world_size(320, 180);
//! game.on_update(|sim, ctx| if ctx.keys.pressed(Key::Space) { sim.world.score += 1; });
//! game.probe("score", |sim| json!(sim.world.score));
//! // A game's `main` ends with `genex::install(game);`.
//! ```
//!
//! The runtime behind the facade ([`Runtime`]) runs on genex-core (clock, rng, input merger,
//! `state()` and its checksum, saves). Started by the studio, [`install`] serves genex-studio's
//! verbs over it in the dev flavour (cargo feature `studio`), rendering headless on the host GPU
//! with genex-render and, on a Mac, sending Live's frames through genex-frames; an export never
//! links genex-studio. Run by a person on a desktop, `install` hands the game to the winit shell
//! (genex-platform-desktop: a window, or headless with `--headless` / `GENEX_HEADLESS=1`). A web
//! build names genex-platform-web `genex`, whose `install` hands the game to the page; the
//! phones' shells are their own crates.
//! `docs/GENEX_API.md` and its topic pages in `docs/api/` are the full contract.

// G6 facade contracts (UIS-0): module stubs each area's facade work package fills.
mod actions;
mod actions_journal;
mod actions_touch;
mod audio;
mod crash;
mod g6;
mod net;
mod profile;
mod saves;
mod settings;
mod ui;
mod animation;
mod camera;
#[cfg(feature = "physics")]
mod character;
mod ctx;
mod decal;
mod extend;
mod frame;
mod game;
mod group;
mod gfx;
pub mod gpu;
mod input;
#[doc(hidden)]
pub mod loading;
pub mod manifest;
mod map;
pub mod math;
/// Navigation: genex-nav's surface, the nav `sim.nav` holds and `game.navigation` registers.
pub mod nav;
mod nav_bake;
mod node_anim;
/// How a game is drawn on each device: look, quality presets, device classes, the settings panel.
pub mod render;
mod rng;
mod runtime;
#[cfg(feature = "physics")]
mod ragdoll;
mod sim;
mod particles;
mod stream;
mod stream_groups;
mod stream_source;
mod stream_tick;
mod terrain;
mod terrain_tiles;
mod water;
#[cfg(all(feature = "studio", not(target_arch = "wasm32")))]
mod studio;
/// The one presenter every shell draws with (native and web): host glue, not game API.
#[doc(hidden)]
pub mod present;
/// The presenter's streamed view set (display state only).
mod present_stream;
/// The native presenter's headless device and model files.
#[cfg(not(target_arch = "wasm32"))]
mod present_files;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod desktop;

pub use camera::{Camera, Projection};
pub use ctx::{Ctx, CtxRng, Key, Keys, Pads, Touch, TouchPhase, Touches};
pub use decal::Decal;
pub use extend::{CustomMaterial, ExtensionRefusal, ExtensionRefusalCode, PostPass};
pub use frame::{
    Ambient, Color, CustomDraw, CustomMesh, DEFAULT_SPOT_INNER_DEGREES, DEFAULT_SPOT_OUTER_DEGREES, Draw, Frame, IrradianceVolume, Lights, Material, PointLight,
    PostDraw, ReflectionProbe, Shape, SpotLight, Sun, Transform,
};
pub use game::{CameraRegistration, Game, PlayerRegistration};
pub use particles::{PARTICLES_MAX, ParticleFlipbook, Particles, ParticlesError, ParticlesErrorCode};
pub use group::{GroupShape, INSTANCE_GROUP_MAX, InstanceGroup, InstanceGroupError, InstanceGroupErrorCode};
pub use terrain::{GRASS_DENSITY_MAX, GRASS_HEIGHT_MAX, Grass, Scatter, TERRAIN_LAYER_MAX, TERRAIN_SAMPLES_MAX, Terrain, TerrainError, TerrainErrorCode, TerrainLayer, TerrainTexel};
/// The look a terrain's layers share (macro variation, wetness, the height blend's depth).
pub use genex_render::terrain::TerrainLook;
/// How a material lets light through: subsurface scattering and diffuse transmission
/// ([`Material::with_subsurface`]; renderer pass 2 B.1).
pub use genex_render::subsurface::Subsurface;
pub use gfx::{
    ASSET_READ_MAX_BYTES, AssetBytes, AssetError, AssetErrorCode, AssetGroup, AssetGroups, AssetInfo, AssetSource, AssetTable, Assets, CharacterAsset, Gfx,
    Model, ModelTriangles,
};
/// Why `gfx.character` refused (`error.code.wire()`, `error.detail`) and the skeleton a
/// [`CharacterAsset`] describes, so a game names them without naming genex-anim.
pub use genex_anim::skeleton::Skeleton;
pub use genex_anim::{AnimationError, AnimationErrorCode};
/// A native destination's asset files (the compiled table, then `assets/` by real path): host glue.
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub use present_files::AssetFiles;
/// Async asset reads for the streamed view set (a range or a whole file, answered at a later poll):
/// host glue.
#[doc(hidden)]
pub use stream_source::{AsyncSource, StreamAnswer, StreamBytes, StreamRequest};
/// The native async source: the compiled table, then `assets/` by real path on the job pool.
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub use stream_source::StreamFiles;
pub use input::Input;
pub use map::{DeterministicState, Map, Set};
pub use rng::{GameRng, Pcg32};
/// A grid cell on the ground plane: the one key streaming and navigation share.
pub use genex_core::cell::CellId;
pub use stream::{
    CellBuild, CellInputs, CellPart, STREAM_ANCHORS_MAX, STREAM_CELL_COLLIDERS_MAX, STREAM_CELL_INSTANCES_MAX, STREAM_CELL_SIZE_MAX,
    STREAM_CELL_SIZE_MIN, STREAM_CELL_THINGS_MAX, STREAM_RING_MAX, STREAM_SIM_BYTES_MAX, STREAM_SIM_RADIUS_MAX, STREAM_WORLD_EXTENT_MAX,
    StreamError, StreamErrorCode, StreamTicket, Streaming,
};
pub use stream_tick::{EnteredCell, STREAM_HOLD_LIVE_SLICE_MS, STREAM_HOLD_MAX_MS, STREAM_HOLD_OVERLAY_MS, StreamCommit, StreamState};
#[cfg(feature = "physics")]
/// A cell's static colliders and the ledger of streamed colliders (STR-10).
pub use genex_stream::physics::{CellColliders, StreamColliders};
pub use runtime::{
    DEFAULT_SEED, DemoDriver, FIXED_STEP_MS, InstallError, InstallErrorCode, MAX_STEP_TICKS,
    RUNTIME_KEYS, Runtime, StepResult, UnknownName, View, step_ticks,
};
pub use sim::{FacetState, Sim};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[doc(hidden)]
pub use desktop::{DesktopShot, DesktopShotError, desktop_shot};

/// Pinned re-exports, so games never name a crate version themselves.
pub use egui;
pub use glam;
#[cfg(feature = "physics")]
pub use rapier3d;
pub use serde_json::{Value, json};

/// The physics world every [`Sim`] carries: Rapier 3D with `enhanced-determinism`, stepped by the
/// runtime once per tick after the update hooks.
#[cfg(feature = "physics")]
pub type PhysicsWorld = rapier3d::prelude::PhysicsWorld;

/// A game built without physics (`[physics] enabled = false` in its genex.toml, renderer pass 2
/// D11) carries this empty world instead, never stepped; Rapier is not in its build. Turn physics
/// back on to use `sim.physics` or `genex::physics`.
#[cfg(not(feature = "physics"))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PhysicsWorld;

/// Rapier's prelude (bodies, colliders, joints, queries) for game code.
#[cfg(feature = "physics")]
pub mod physics {
    pub use rapier3d::prelude::*;
}

/// Everything a game file needs: `use genex::prelude::*;`.
pub mod prelude {
    pub use crate::math::{Mat3, Mat4, Quat, Vec2, Vec3, Vec4, vec2, vec3, vec4};
    pub use crate::{
        Assets, Camera, Color, Ctx, CustomMaterial, CustomMesh, DemoDriver, FacetState, Frame, Game, Gfx, Input, Key, Map,
        Material, Model, Pcg32, PhysicsWorld, PostPass, Projection, Set, Sim, Touch, Transform, Value, View, egui, json,
    };
}

/// Start the runtime with this game. Required, once, at the end of the game's `main`.
///
/// It first checks the registrations and panics with a typed code ([`InstallErrorCode`]) when
/// they are inconsistent: a second `camera` or `player` without `.camera_override()` /
/// `.player_override()`, duplicate or runtime-key probe names, duplicate camera, eye or demo
/// names, an empty name, a facet state type registered twice, a world size outside 64..=4096, a
/// second `game.streaming` or a streaming cell size outside its caps.
/// Then it hands the game to the platform shell and returns when a native window closes.
pub fn install<W: Default + 'static>(game: Game<W>) {
    install_with_assets(game, &[]);
}

/// [`install`] for a game that compiles its assets into the binary: `assets` is searched first,
/// then `assets/` beside the executable (in the dev flavour, with none there, the crate's own
/// `assets/` that `cargo run` names).
///
/// The reset hooks read through the same assets (`gfx.assets().bytes`), from the first seed on.
pub fn install_with_assets<W: Default + 'static>(game: Game<W>, assets: AssetTable) {
    runtime::install(game, assets);
}
