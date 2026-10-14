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
//! `docs/GENEX_API.md` is the full contract.

mod camera;
mod ctx;
mod extend;
mod frame;
mod game;
mod gfx;
pub mod gpu;
mod input;
pub mod manifest;
mod map;
pub mod math;
/// How a game is drawn on each device: look, quality presets, device classes, the settings panel.
pub mod render;
mod rng;
mod runtime;
mod sim;
#[cfg(all(feature = "studio", not(target_arch = "wasm32")))]
mod studio;
/// The one presenter every shell draws with (native and web): host glue, not game API.
#[doc(hidden)]
pub mod present;
/// The native presenter's headless device and model files.
#[cfg(not(target_arch = "wasm32"))]
mod present_files;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod desktop;

pub use camera::{Camera, Projection};
pub use ctx::{Ctx, CtxRng, Key, Keys, Pads, Touch, TouchPhase, Touches};
pub use extend::{CustomMaterial, ExtensionRefusal, ExtensionRefusalCode, PostPass};
pub use frame::{
    Ambient, Color, CustomDraw, CustomMesh, DEFAULT_SPOT_INNER_DEGREES, DEFAULT_SPOT_OUTER_DEGREES, Draw, Frame, Lights, Material, PointLight, PostDraw,
    Shape, SpotLight, Sun, Transform,
};
pub use game::{CameraRegistration, Game, PlayerRegistration};
pub use gfx::{AssetTable, Assets, Gfx, Model};
pub use input::Input;
pub use map::{DeterministicState, Map, Set};
pub use rng::Pcg32;
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
pub use rapier3d;
pub use serde_json::{Value, json};

/// The physics world every [`Sim`] carries: Rapier 3D with `enhanced-determinism`, stepped by the
/// runtime once per tick after the update hooks.
pub type PhysicsWorld = rapier3d::prelude::PhysicsWorld;

/// Rapier's prelude (bodies, colliders, joints, queries) for game code.
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
/// names, an empty name, a facet state type registered twice, or a world size outside 64..=4096.
/// Then it hands the game to the platform shell and returns when a native window closes.
pub fn install<W: Default + 'static>(game: Game<W>) {
    install_with_assets(game, &[]);
}

/// [`install`] for a game that compiles its assets into the binary: `assets` is searched first,
/// then `assets/` beside the executable (in the dev flavour, with none there, the crate's own
/// `assets/` that `cargo run` names).
pub fn install_with_assets<W: Default + 'static>(game: Game<W>, assets: AssetTable) {
    let runtime = Runtime::new(game).unwrap_or_else(|error| panic!("genex::install: {error}"));
    runtime::run(runtime, assets);
}
