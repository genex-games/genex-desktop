//! The builder a game's `main` fills: title, sizes and hooks. Facets add their own hooks through
//! `<slug>::wire(&mut game)` from the entry file's `// FACET WIRING` block.

use crate::camera::Camera;
use crate::ctx::Ctx;
use crate::frame::{Color, Frame};
use crate::gfx::Gfx;
use crate::rng::Pcg32;
use crate::runtime::DemoDriver;
use crate::sim::{FacetRegistration, Sim};
use serde_json::Value;

pub(crate) type ResetHook<W> = Box<dyn Fn(&mut Sim<W>, u32, &mut Pcg32, &Gfx)>;
pub(crate) type UpdateHook<W> = Box<dyn Fn(&mut Sim<W>, &Ctx<'_>)>;
pub(crate) type UiHook<W> = Box<dyn Fn(&mut Sim<W>, &mut egui::Ui, &Ctx<'_>)>;
pub(crate) type DrawHook<W> = Box<dyn Fn(&Sim<W>, &mut Frame, &Camera)>;
pub(crate) type CameraHook<W> = Box<dyn Fn(&Sim<W>) -> Camera>;
pub(crate) type ValueHook<W> = Box<dyn Fn(&Sim<W>) -> Value>;
pub(crate) type DemoHook<W> = Box<dyn Fn(&mut DemoDriver<'_, W>) -> Value>;

/// A single-valued registration (`camera`, `player`) and whether it may replace an earlier one.
pub(crate) struct Single<F> {
    pub hook: F,
    pub overrides: bool,
}

/// A named registration (named cameras, eyes, demos).
pub(crate) struct Named<F> {
    pub name: String,
    pub hook: F,
}

/// A probe: a named leaf of `state()`; volatile ones stay out of the checksum.
pub(crate) struct Probe<W> {
    pub name: String,
    pub volatile: bool,
    pub hook: ValueHook<W>,
}

/// Everything a game hands the runtime. Build it with [`Game::new`], register hooks, and pass it
/// to [`crate::install`].
pub struct Game<W> {
    pub(crate) initial: W,
    pub(crate) title: String,
    pub(crate) world_size: [u32; 2],
    pub(crate) background: Color,
    pub(crate) save_name: Option<String>,
    pub(crate) resets: Vec<ResetHook<W>>,
    pub(crate) updates: Vec<UpdateHook<W>>,
    pub(crate) uis: Vec<UiHook<W>>,
    pub(crate) draws: Vec<DrawHook<W>>,
    pub(crate) cameras: Vec<Single<CameraHook<W>>>,
    pub(crate) players: Vec<Single<ValueHook<W>>>,
    pub(crate) named_cameras: Vec<Named<CameraHook<W>>>,
    pub(crate) eyes: Vec<Named<CameraHook<W>>>,
    pub(crate) probes: Vec<Probe<W>>,
    pub(crate) demos: Vec<Named<DemoHook<W>>>,
    pub(crate) facets: Vec<FacetRegistration>,
    /// `game.streaming` registrations (install refuses a second one).
    pub(crate) streaming: Vec<crate::stream::Streaming>,
    /// `game.cell_content` builders, in registration order.
    pub(crate) cell_contents: Vec<crate::stream::CellContent>,
    /// `game.stream_commit` hooks, in registration order.
    pub(crate) stream_commits: Vec<Box<dyn crate::stream_tick::StreamCommit<W>>>,
    /// `game.navigation`: the nav every seed rebuilds `sim.nav` for.
    pub(crate) navigation: Option<crate::nav::NavConfig>,
    /// Custom GPU passes (`game.gpu_pass`, extension ladder level 3, M2.19).
    pub(crate) gpu_passes: Vec<crate::gpu::GpuPassEntry<W>>,
    /// The game's render look and quality (`game.render_settings`, the `[render]` layer).
    pub(crate) render: crate::render::RenderConfig,
    /// Where its Level-2 `[[wgsl]]` sources come from (`game.wgsl`, extension ladder level 2).
    pub(crate) wgsl: crate::extend::WgslSetup,
    /// The G6 areas' registrations (input, audio, saves, UI, settings, net), each written by its
    /// area's `impl Game` block (UIS-0).
    pub(crate) g6: crate::g6::G6Setup,
    /// `game.save_section` and `game.save_world`, in registration order (UIS-9).
    pub(crate) save_sections: crate::saves::Sections<W>,
    /// `game.nav_bake` registrations, in registration order (NAV-14).
    pub(crate) nav_bakes: crate::nav_bake::NavBakes,
}

/// The handle `game.camera(..)` returns; `.camera_override()` lets this camera replace an
/// earlier one instead of failing `install`.
pub struct CameraRegistration<'a, W> {
    game: &'a mut Game<W>,
}

impl<W> CameraRegistration<'_, W> {
    /// This camera intentionally replaces the one registered before it.
    pub fn camera_override(self) {
        if let Some(last) = self.game.cameras.last_mut() {
            last.overrides = true;
        }
    }
}

/// The handle `game.player(..)` returns; `.player_override()` lets this hook replace an earlier
/// one instead of failing `install`.
pub struct PlayerRegistration<'a, W> {
    game: &'a mut Game<W>,
}

impl<W> PlayerRegistration<'_, W> {
    /// This player hook intentionally replaces the one registered before it.
    pub fn player_override(self) {
        if let Some(last) = self.game.players.last_mut() {
            last.overrides = true;
        }
    }
}

impl<W: Default + 'static> Game<W> {
    /// A game over `world` (the world before the first seed; every seed rebuilds `W::default()`).
    pub fn new(world: W) -> Game<W> {
        Game {
            initial: world,
            title: "Genex game".to_owned(),
            world_size: [960, 540],
            background: Color::BACKGROUND,
            save_name: None,
            resets: Vec::new(),
            updates: Vec::new(),
            uis: Vec::new(),
            draws: Vec::new(),
            cameras: Vec::new(),
            players: Vec::new(),
            named_cameras: Vec::new(),
            eyes: Vec::new(),
            probes: Vec::new(),
            demos: Vec::new(),
            facets: Vec::new(),
            streaming: Vec::new(),
            cell_contents: Vec::new(),
            stream_commits: Vec::new(),
            navigation: None,
            gpu_passes: Vec::new(),
            render: crate::render::RenderConfig::from_build(),
            wgsl: crate::extend::WgslSetup::default(),
            g6: crate::g6::G6Setup::default(),
            save_sections: crate::saves::Sections::default(),
            nav_bakes: crate::nav_bake::NavBakes::default(),
        }
    }

    /// The name a destination keeps this game's saves under: its `save_name`, else its title
    /// (the web shell's IndexedDB database is `genex-saves:<this>`).
    pub fn saves_name(&self) -> &str {
        self.save_name.as_deref().unwrap_or(&self.title)
    }

    /// The window and export title.
    pub fn title(mut self, title: &str) -> Game<W> {
        title.clone_into(&mut self.title);
        self
    }

    /// The fixed world target size in pixels; the window letterboxes it.
    pub fn world_size(mut self, width: u32, height: u32) -> Game<W> {
        self.world_size = [width, height];
        self
    }

    /// The colour the world target clears to.
    pub fn background(mut self, color: Color) -> Game<W> {
        self.background = color;
        self
    }

    /// The folder saves go under (letters, digits, space, `_`, `-`, `.`); by default the name the
    /// studio's build gives the game.
    pub fn save_name(mut self, name: &str) -> Game<W> {
        self.save_name = Some(name.to_owned());
        self
    }

    /// Rebuild state after a seed: runs in registration order on a fresh `Sim`, with `rng`
    /// seeded from `seed`.
    pub fn on_reset<F>(&mut self, hook: F) -> &mut Self
    where
        F: Fn(&mut Sim<W>, u32, &mut Pcg32, &Gfx) + 'static,
    {
        self.resets.push(Box::new(hook));
        self
    }

    /// One fixed tick, in registration order; physics steps once after every update hook.
    pub fn on_update<F>(&mut self, hook: F) -> &mut Self
    where
        F: Fn(&mut Sim<W>, &Ctx<'_>) + 'static,
    {
        self.updates.push(Box::new(hook));
        self
    }

    /// egui widgets, run inside the tick from the merged input and the simulated clock.
    pub fn on_ui<F>(&mut self, hook: F) -> &mut Self
    where
        F: Fn(&mut Sim<W>, &mut egui::Ui, &Ctx<'_>) + 'static,
    {
        self.uis.push(Box::new(hook));
        self
    }

    /// Draw the world (read-only) from `camera`.
    pub fn on_draw<F>(&mut self, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>, &mut Frame, &Camera) + 'static,
    {
        self.draws.push(Box::new(hook));
        self
    }

    /// The game's own view. Single-valued: a second one needs `.camera_override()`.
    pub fn camera<F>(&mut self, hook: F) -> CameraRegistration<'_, W>
    where
        F: Fn(&Sim<W>) -> Camera + 'static,
    {
        self.cameras.push(Single { hook: Box::new(hook), overrides: false });
        CameraRegistration { game: self }
    }

    /// A named observer camera: it moves the view, never the simulation.
    pub fn named_camera<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>) -> Camera + 'static,
    {
        self.named_cameras.push(Named { name: name.to_owned(), hook: Box::new(hook) });
        self
    }

    /// A player-eye camera ("eye:spawn"): where the player would look from.
    pub fn eye<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>) -> Camera + 'static,
    {
        self.eyes.push(Named { name: name.to_owned(), hook: Box::new(hook) });
        self
    }

    /// Where the player is (`{x, y, z, yaw?}`), or `null`. Single-valued: a second one needs
    /// `.player_override()`.
    pub fn player<F>(&mut self, hook: F) -> PlayerRegistration<'_, W>
    where
        F: Fn(&Sim<W>) -> Value + 'static,
    {
        self.players.push(Single { hook: Box::new(hook), overrides: false });
        PlayerRegistration { game: self }
    }

    /// A probe leaf `state().<name>` that checks read; part of the checksum.
    pub fn probe<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>) -> Value + 'static,
    {
        self.probes.push(Probe { name: name.to_owned(), volatile: false, hook: Box::new(hook) });
        self
    }

    /// A probe reported under `state().volatile.<name>` and left out of the checksum.
    pub fn probe_volatile<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>) -> Value + 'static,
    {
        self.probes.push(Probe { name: name.to_owned(), volatile: true, hook: Box::new(hook) });
        self
    }

    /// A scripted drive a generic walk cannot reach. It may inject input, advance time and
    /// request captures through its driver; the runtime pauses after it.
    pub fn demo<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&mut DemoDriver<'_, W>) -> Value + 'static,
    {
        self.demos.push(Named { name: name.to_owned(), hook: Box::new(hook) });
        self
    }

    /// Register a facet's private state type; `sim.facets.get::<T>()` reads it and every seed
    /// rebuilds it from `T::default()`.
    pub fn facet_state<T: Default + 'static>(&mut self) -> &mut Self {
        self.facets.push(FacetRegistration::of::<T>());
        self
    }

    /// Stream the world in cells (registered once; `install` refuses a second registration
    /// `duplicate-streaming`, and a cell size, radius or anchor count outside its caps or a sim set
    /// past `STREAM_SIM_BYTES_MAX` `streaming-invalid`). Every tick starts with the commit slot,
    /// which moves `sim.stream` to its anchors; while it is registered `state()` carries the
    /// display-only key `__stream`.
    pub fn streaming(&mut self, streaming: crate::stream::Streaming) -> &mut Self {
        self.streaming.push(streaming);
        self
    }

    /// Build a streamed cell's content: `builder` runs for every cell entering the sim set, on a
    /// worker (inline on the web), so it must be pure: the same cell and inputs give the same
    /// build everywhere. What each builder records is merged in cell order. Facets may each
    /// register one, run in registration order.
    pub fn cell_content<T: Send + Sync + 'static, F>(&mut self, builder: F) -> &mut Self
    where
        F: Fn(crate::CellId, &crate::stream::CellInputs) -> crate::stream::CellBuild<T> + Send + Sync + 'static,
    {
        self.cell_contents.push(crate::stream::CellContent::new(builder));
        self
    }

    /// A hook the commit slot calls for every cell that leaves (descending, hooks in reverse
    /// registration order) or enters (ascending, in registration order) the sim set.
    pub fn stream_commit(&mut self, hook: impl crate::stream_tick::StreamCommit<W> + 'static) -> &mut Self {
        self.stream_commits.push(Box::new(hook));
        self
    }

    /// Stream the static colliders cell builders add (`CellBuild::part(CellColliders)`): they enter
    /// `sim.physics` with their cell and leave with it, in canonical order.
    #[cfg(feature = "physics")]
    pub fn stream_colliders(&mut self) -> &mut Self {
        self.facet_state::<genex_stream::physics::StreamColliders>();
        self.stream_commit(crate::stream::ColliderCommit)
    }

    /// Give the world a navigation mesh walkers of `config` use: every seed rebuilds `sim.nav`
    /// for it (the runtime owns the nav, as it owns physics).
    pub fn navigation(&mut self, config: crate::nav::NavConfig) -> &mut Self {
        self.navigation = Some(config);
        self
    }
}
